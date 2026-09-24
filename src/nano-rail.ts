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
 * still bind the amount to the quote. Chosen so a real price can never collide
 * with another quote's nonce.
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

/** A small integer bound to the quote, used to make each quote's amount unique. */
function nonceIntOf(quote: Quote): bigint {
  // Derive a < 10^NONCE_DIGITS value from the quote nonce and id.
  const seed = `${quote.nonce}:${quote.id}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return BigInt(h % Number(10n ** NONCE_DIGITS));
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

function toRaw(micros: bigint, xnoPerUsd: number): string {
  // Convert a currency price (in USD micros) to XNO raw exactly, treating the rate
  // as a decimal string so nothing leaves integer arithmetic.
  // raw = micros * xnoPerUsd * 10^30 / 10^6 = micros * (xnoPerUsd * 10^24)
  // and xnoPerUsd * 10^24 = digits * 10^(24 - decimals).
  const s = String(xnoPerUsd); // e.g. "0.01"
  const dot = s.indexOf('.');
  const digits = dot === -1 ? s : s.slice(0, dot) + s.slice(dot + 1);
  const decimals = dot === -1 ? 0 : s.length - dot - 1;
  const scale = 24n - BigInt(decimals);
  const amount = scale >= 0n ? micros * BigInt(digits) * 10n ** scale : (micros * BigInt(digits)) / 10n ** -scale;
  return amount.toString();
}

/** Wrap an RPC failure as a provider error so core serves 503 rather than guessing. */
function providerError(action: string, cause: unknown): TollstileError {
  return new TollstileError('PROVIDER_UNAVAILABLE', `Nano RPC did not answer ${action}.`, { cause });
}

async function verifySignature(
  verifier: NanoSignatureVerifier | undefined,
  source: string,
  message: string,
  signature: string | null,
): Promise<string | null> {
  if (verifier === undefined) {
    // No verifier configured: fail closed on real admissions. The rail must not
    // admit a payment it cannot bind to its presenter.
    throw new TollstileError('CONFIG_INVALID', 'a NanoSignatureVerifier is required to admit real payments (proof-of-possession).');
  }
  if (signature === null || signature === '') return null;
  const ok = await verifier.verify(source, message, signature);
  return ok ? signature : null;
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
 * Binding the proof (owner-maintainer review, Tollstile#47):
 *   1. The block amount must EXACTLY equal the quoted price raw plus a small
 *      nonce bound to the quote — so a donation, an old payment, or a payment for
 *      a different quote can never redeem this one.
 *   2. The player signs the quote nonce with the same Nano key that sent the
 *      block; `verify` checks the signature against the block's source, so a
 *      watcher replaying a block hash cannot be served.
 *   3. The rate is required and evaluated at quote time — never a default.
 */
export function nanoRail(options: NanoRailOptions): ReturnType<typeof createRail<'nano', NanoData>> {
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

      // Exact amount this quote is priced at: price raw + nonce. Server-sets-price:
      // the client never states an amount.
      const rate = await currentRate(options.xnoPerUsd);
      const priceRaw = toRaw(quote.price.micros, rate);
      const expectedRaw = (BigInt(priceRaw) + nonceIntOf(quote)).toString();

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
      options.onSettled?.({ hash: block.hash, source: block.source, destination: block.destination, amountRaw: block.amountRaw });
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