import {
  createRail,
  TollstileError,
  type Authorization,
  type Charge,
  type LookupResult,
  type Receipt,
  type RefundResult,
  type SettleResult,
  type Verification,
  type VerifyTerms,
  type Context,
  type Quote,
} from 'tollstile';
import { createHash } from 'node:crypto';
import type { NanoRailOptions, NanoBlockInfo, NanoSignatureVerifier } from './nano-types.js';
import {
  NANO_ASSET,
  NANO_BLOCK_HEADER,
  NANO_BLOCK_META,
  NANO_QUOTE_HEADER,
  NANO_QUOTE_META,
  NANO_SIGNATURE_HEADER,
  NANO_SIGNATURE_META,
} from './nano-types.js';

/** What the ledger keeps per authorization: the *** block that paid. Never a secret. */
export type NanoData = {
  readonly hash: string;
  readonly source: string;
  readonly destination: string;
  readonly amountRaw: string;
  /** The quote this payment was made against, so a retry finds the same charge. */
  readonly quoteId: string | null;
  /** The signature the payer supplied, dropped by `redact` once the charge is final. */
  readonly signature?: string;
};

const ZERO = 0n;
/**
 * Number of low-order raw digits the per-quote nonce occupies. A $1 Nano payment
 * is ~1e28 raw (10^28), so the low 10 digits leave the high 20 for the price and
 * still bind the amount to the quote. The nonce is a SHA-256 digest folded into
 * these digits; single-use is enforced by the quote and the block hash in core,
 * and proof-of-possession by the payer's signature over the nonce.
 */
const NONCE_DIGITS = 10n;

/** The merchant's live XNO-per-USD rate, required at quote time. */
async function currentRate(rate: NanoRailOptions['xnoPerUsd']): Promise<number> {
  const value = typeof rate === 'function' ? await rate() : rate;
  if (!(typeof value === 'number') || !Number.isFinite(value) || value <= 0) {
    throw new TollstileError('CONFIG_INVALID', 'xnoPerUsd must be a positive number or a function returning one.');
  }
  return value;
}

/**
 * A < 10^NONCE_DIGITS integer bound to the quote, used to make each quote's
 * payable amount unique. SHA-256 of `quote.id` gives ~32 bytes of entropy; the
 * low NONCE_DIGITS digits are what we keep. The exact price and the 32-bit claim
 * are separated from this: the amount distinguishes quotes within the digits we
 * keep, and single-use (quote) + signature (proof-of-possession) enforce the rest.
 */
function nonceIntOf(quote: Quote): bigint {
  const digest = createHash('sha256').update(quote.id).digest();
  // Low NONCE_DIGITS bytes of the digest, as a bigint, folded below 10^NONCE_DIGITS.
  const bytes = digest.subarray(digest.length - 8); // last 8 bytes for the low digits
  let h = 0n;
  for (const b of bytes) h = (h << 8n) | BigInt(b);
  return h % (10n ** NONCE_DIGITS);
}

function rawFromHeader(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_BLOCK_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_BLOCK_META];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

function signatureFrom(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_SIGNATURE_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_SIGNATURE_META];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

/**
 * Convert a currency price (in USD micros) to XNO raw exactly, treating the rate
 * as a decimal string so nothing leaves integer arithmetic and no float breaks
 * the high-digits-price / low-digits-nonce layout.
 */
function toRaw(micros: bigint, xnoPerUsd: number): string {
  // Normalise the rate through a decimal string: strip a trailing ".0", expand a
  // small exponent like "1e-7", and drop any trailing zeros after the point so
  // the decimal count is exact.
  let s = String(xnoPerUsd).toLowerCase();
  const expMatch = /e([+-]?\d+)$/.exec(s);
  if (expMatch !== null) {
    const exp = Number(expMatch[1]);
    const mantissa = s.slice(0, expMatch.index);
    const dot = mantissa.indexOf('.');
    const digits = mantissa.replace('.', '');
    const dotPos = dot === -1 ? digits.length : dot; // digits before the point
    const nd = dotPos + exp;
    if (nd <= 0) {
      s = `0.${'0'.repeat(-nd)}${digits}`;
    } else if (nd >= digits.length) {
      s = digits + '0'.repeat(nd - digits.length);
    } else {
      s = `${digits.slice(0, nd)}.${digits.slice(nd)}`;
    }
  }
  // Now s has no exponent. Strip trailing zeros after the decimal point.
  const dot = s.indexOf('.');
  if (dot !== -1) {
    s = s.replace(/\.?0+$/, '');
  }
  const digits = s.includes('.') ? s.replace('.', '') : s;
  const decimals = s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
  const scale = 24n - BigInt(decimals);
  const amount = scale >= 0n ? micros * BigInt(digits) * 10n ** scale : (micros * BigInt(digits)) / 10n ** -scale;
  return amount.toString();
}

/** Wrap an RPC failure as a provider error so core serves 503 rather than guessing. */
function providerError(action: string, cause: unknown): TollstileError {
  return new TollstileError('PROVIDER_UNAVAILABLE', `Nano RPC did not answer ${action}.`, { cause });
}

async function verifySignature(
  verifier: NanoSignatureVerifier,
  source: string,
  message: string,
  signature: string | null,
): Promise<string | null> {
  if (signature === null || signature === '') return null;
  const ok = await verifier.verify(source, message, signature);
  return ok ? signature : null;
}

/** The exact payable amount for a quote: price raw + the quote's nonce. */
function payableOf(quote: Quote): string {
  const offer = quote.offers.find((o) => o.rail === 'nano');
  if (offer === undefined) return '';
  // The offer amount is the price raw this rail challenged with. The rate is
  // NEVER re-read here: the quote binds the amount, so a rate movement between
  // quote-time and verify cannot refuse a payer who sent the quoted amount.
  const base = BigInt(offer.details?.amountRaw as string);
  return (base + nonceIntOf(quote)).toString();
}

/**
 * A Nano (XNO) settlement rail for Tollstile.
 *
 * Flow `upfront`: the payer's confirmed `send` block is the payment and it has
 * already moved on-chain when `verify` runs, so `verify` returns `settled` and
 * core records the charge as settled before the handler (SPEC §9 "Paid at
 * verification"). When the handler fails, the rail refunds by reverse send if the
 * operator supplied a `signer`; otherwise the charge stays settled-and-reported
 * and the README says so first.
 *
 * Binding the proof (owner-maintainer review, Tollstile#47 and #49):
 *   1. The block amount must EXACTLY equal the quoted price raw plus a small
 *      nonce bound to the quote — so a donation, an old payment, or a payment for
 *      a different quote can never redeem this one. The amount is read from the
 *      quote's own offer, never recomputed from a live rate.
 *   2. The payer signs the quote nonce with the same Nano key that sent the
 *      block; `verify` checks the signature against the block's source, so a
 *      watcher replaying a block hash cannot be served.
 *   3. `verify` returns `settled` only for a block that is confirmed, pays
 *      exactly the quote amount to the merchant, and carries a valid
 *      proof-of-possession signature. There is no merchant-side receipt hook:
 *      a merchant that wants to append to its own ledger does so from core's
 *      `onEvent` (fires once, after the single-use check).
 */
export function nanoRail(options: NanoRailOptions): ReturnType<typeof createRail<'nano', NanoData>> {
  // Fail closed at construction: without a verifier a watcher could replay any
  // confirmed send to the merchant, and refusing at verify would be after the
  // money moved. So the requirement is structural, not a late check.
  if (options.verifier === undefined) {
    throw new TollstileError('CONFIG_INVALID', 'nanoRail requires a verifier (NanoSignatureVerifier) to admit real payments (proof-of-possession).');
  }
  const merchant = options.merchantAccount;
  const rpc = options.rpc;
  const verifier = options.verifier;

  return createRail<'nano', NanoData>({
    name: 'nano',
    livemode: true,
    capabilities: {
      flows: ['upfront'],
      authorization: 'single',
      // The rail carries a signed quote (nonce + exact amount) through its
      // protocol and returns it from verify.
      quotes: true,
      variableAmount: false,
      partialRefund: false,
    },

    offer: async ({ price }) => {
      const rate = await currentRate(options.xnoPerUsd);
      const amount = toRaw(price.micros, rate);
      if (BigInt(amount) <= ZERO) return null;
      return {
        rail: 'nano',
        asset: NANO_ASSET,
        amount,
        basis: 'rate',
        details: { to: merchant, amountRaw: amount },
      };
    },

    challenge: (quote, quoteToken, offer) => {
      // The exact payable amount: the price raw plus the quote's nonce. Only the
      // payer holding THIS quote can produce it, and it cannot redeem any other
      // block the merchant has ever received.
      const base = BigInt(offer.details.amountRaw as string);
      const payable = (base + nonceIntOf(quote)).toString();
      return Promise.resolve({
        headers: [
          [NANO_BLOCK_HEADER, ''],
          [NANO_SIGNATURE_HEADER, ''],
          // Prefilled: the client echoes the quote token back on the paid request.
          [NANO_QUOTE_HEADER, quoteToken],
        ],
        accepts: { to: offer.details.to as string, amountRaw: payable, scale: 30 },
        mcp: {
          style: 'x-nano',
          to: offer.details.to as string,
          amountRaw: payable,
          // The payer signs this nonce with their Nano source key.
          nonce: quote.nonce,
          quote: quoteToken,
          blockHeader: NANO_BLOCK_HEADER,
          signatureHeader: NANO_SIGNATURE_HEADER,
          quoteHeader: NANO_QUOTE_HEADER,
        },
      });
    },

    async verify(context: Context, terms: VerifyTerms): Promise<Verification<NanoData>> {
      const hash = rawFromHeader(context);
      if (hash === null || hash.length === 0) return { status: 'absent' };

      // The quote this request carries — forged, expired, or wrong-resource opens to undefined.
      const metaQuote = context.mcp?.meta[NANO_QUOTE_META];
      const quoteToken = context.request?.headers.get(NANO_QUOTE_HEADER)
        ?? (typeof metaQuote === 'string' && metaQuote !== '' ? metaQuote : null);
      const quote = quoteToken ? await terms.openQuote(quoteToken) : undefined;
      if (quote === undefined) {
        // With `quotes: true` the proof must carry a valid, unexpired quote.
        return { status: 'invalid', reason: 'quote_invalid', proofId: hash };
      }

      // Exact amount this quote is priced at, read from the quote's own offer
      // (never recomputed from a live rate): price raw + nonce. Server-sets-price:
      // the client never states an amount, and a rate that moved since quote-time
      // cannot refuse a payer who sent exactly what was challenged.
      const expectedRaw = payableOf(quote);
      if (expectedRaw === '') return { status: 'invalid', reason: 'quote_invalid', proofId: hash };

      let block: NanoBlockInfo | undefined;
      try {
        block = await rpc.blockInfo(hash);
      } catch (error) {
        throw providerError(`block_info ${hash}`, error);
      }

      if (block === undefined) return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
      if (!block.confirmed) return { status: 'invalid', reason: 'proof_pending', proofId: hash };
      if (block.destination !== merchant || block.subtype !== 'send') return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
      // EXACT match, not minimum: a different quote's amount or an unrelated send
      // must not redeem this one.
      if (block.amountRaw !== expectedRaw) return { status: 'invalid', reason: 'proof_invalid', proofId: hash };

      // Bind the presenter to the payer: a valid signature over the quote nonce,
      // from the block's source account.
      const signature = await verifySignature(verifier, block.source, quote.nonce, signatureFrom(context));
      if (signature === null) return { status: 'invalid', reason: 'proof_invalid', proofId: hash };

      const data: NanoData = {
        hash,
        source: block.source,
        destination: block.destination,
        amountRaw: block.amountRaw,
        quoteId: quote.id,
        signature,
      };
      return {
        status: 'valid',
        proofId: hash,
        payer: block.source,
        quote,
        limit: null,
        expiresAt: quote.expiresAt,
        data,
        settled: { reference: hash, details: { to: merchant, amountRaw: block.amountRaw } },
        idempotencyKey: hash,
      };
    },

    settle: (authorization: Authorization & { data: NanoData }): Promise<SettleResult> => {
      const data = authorization.data;
      return Promise.resolve({
        status: 'settled',
        reference: data.hash,
        details: { to: data.destination, amountRaw: data.amountRaw },
      });
    },

    async refund(authorization: Authorization & { data: NanoData }): Promise<RefundResult> {
      const signer = options.signer;
      if (signer === undefined) return { status: 'rejected', reason: 'refund_unsupported' };
      const data = authorization.data;
      // Reverse the payment: the merchant sends the settled amount back to the payer.
      const reference = await signer.sendFor(data.source, data.amountRaw, { refundOf: data.hash });
      return { status: 'refunded', reference };
    },

    async lookup(authorization: Authorization & { data: NanoData }): Promise<LookupResult> {
      const data = authorization.data;
      const block = await readBlock();
      async function readBlock(): Promise<NanoBlockInfo | undefined> {
        try {
          return await rpc.blockInfo(data.hash);
        } catch (error) {
          throw providerError(`block_info ${data.hash}`, error);
        }
      }
      if (block === undefined || !block.confirmed) return { status: 'none' };
      return { status: 'settled', reference: data.hash, details: { to: data.destination, amountRaw: data.amountRaw } };
    },

    receipt: (_authorization: Authorization & { data: NanoData }, charge: Charge): Receipt => {
      const ref = charge.settlement?.reference;
      const headers = ref === undefined ? [] : ([[NANO_BLOCK_HEADER, ref]] as const);
      return { headers, meta: {} };
    },

    redact(data: NanoData): NanoData {
      // Drop the payer signature once a single-use charge is final; keep the public
      // block facts lookup/refund need.
      const { signature: _signature, ...rest } = data;
      return rest;
    },
  });
}
