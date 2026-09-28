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
 * is ~1e28 raw, so the price keeps the high ~18 digits and the nonce the low 10.
 * The price is rounded DOWN to a multiple of 10^NONCE_DIGITS raw (at most
 * 1e-20 XNO) so the two never overlap, whatever the precision of the rate.
 */
const NONCE_DIGITS = 10n;
const NONCE_MODULUS = 10n ** NONCE_DIGITS;
/** XNO has 30 decimals; the price is in USD micros (6), so raw = micros * rate * 10^24. */
const MICROS_TO_RAW_SCALE = 24;
/** A plain non-negative decimal: digits, optionally a point and more digits. No sign, no exponent. */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

type Decimal = { readonly digits: bigint; readonly decimals: number };

/**
 * Parse the merchant's XNO-per-USD rate as an exact decimal.
 *
 * Pass a decimal STRING ("0.0123") for an exact rate. A number is accepted for
 * convenience and read through `String(n)`, expanding an exponent ("1e-7"), so it
 * never reaches `BigInt()` as text it cannot parse. Anything else, zero, a sign or
 * a non-finite number is a configuration error, never a SyntaxError from inside
 * the quote.
 */
export function parseRate(value: unknown): Decimal {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw rateError();
    text = expandExponent(String(value));
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw rateError();
  }
  const match = DECIMAL.exec(text);
  if (match === null) throw rateError();
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  const digits = BigInt(`${match[1]}${fraction}`);
  if (digits <= ZERO) throw rateError();
  return { digits, decimals: fraction.length };
}

function rateError(): TollstileError {
  return new TollstileError(
    'CONFIG_INVALID',
    'xnoPerUsd must be a positive decimal string (e.g. "0.0123"), a positive finite number, or a function returning one.',
  );
}

/** "1.5e-7" -> "0.00000015"; "2e+21" -> "2000000000000000000000". Text without an exponent is returned as is. */
function expandExponent(text: string): string {
  const match = /^(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (match === null) return text;
  const whole = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3]);
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${digits}${'0'.repeat(point - digits.length)}`;
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** The merchant's XNO-per-USD rate, read ONCE, at quote time. `verify` never calls this. */
async function currentRate(rate: NanoRailOptions['xnoPerUsd']): Promise<Decimal> {
  return parseRate(typeof rate === 'function' ? await rate() : rate);
}

/**
 * The per-quote nonce: the SHA-256 digest of `quote.id`, reduced below
 * 10^NONCE_DIGITS. That is ~33 bits, and it is all the amount can carry: it makes
 * two quotes' payable amounts differ with probability ~1 - 2^-33, NOT with
 * certainty. The binding does not rest on it: a block hash is single-use in core's
 * ledger, and the payer must sign this quote's nonce with the key that sent the
 * block. The amount only makes a stray or old send unlikely to fit a new quote.
 */
function nonceIntOf(quote: Quote): bigint {
  const digest = createHash('sha256').update(quote.id).digest();
  return BigInt(`0x${digest.toString('hex')}`) % NONCE_MODULUS;
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
 * The signed quote token: the header first, the MCP `_meta` key second — the same
 * order AND the same treatment of an empty value as the block and the signature
 * above. It was read inline with `??`, which is nullish: a header that is present
 * but EMPTY is not nullish, so `''` won and the quote in `_meta` was never looked
 * at. The same MCP call then paid over a plain MCP context and was refused
 * `quote_invalid` over a Streamable-HTTP carrier, where `request` and `mcp` are
 * both set (Context: `request` is "null for MCP calls that arrive without an HTTP
 * carrier") and a client echoing the challenge's prefilled empty headers sends
 * exactly that. The payer's send is already confirmed on-chain by then, and Nano
 * has no chargeback, so the answer asked them to pay twice.
 */
function quoteFrom(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_QUOTE_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_QUOTE_META];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

/**
 * Convert a price in USD micros to XNO raw in integer arithmetic, with the low
 * NONCE_DIGITS digits cleared for the nonce. Rounds down (in the payer's favour)
 * by less than 10^NONCE_DIGITS raw.
 */
export function toRaw(micros: bigint, rate: Decimal): string {
  const scale = MICROS_TO_RAW_SCALE - rate.decimals;
  const exact = scale >= 0
    ? micros * rate.digits * 10n ** BigInt(scale)
    : (micros * rate.digits) / 10n ** BigInt(-scale);
  return ((exact / NONCE_MODULUS) * NONCE_MODULUS).toString();
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

/** Price raw + this quote's nonce: the only amount that pays this quote. */
function payableFor(quote: Quote, amountRaw: unknown): string {
  if (typeof amountRaw !== 'string' || !/^\d+$/.test(amountRaw)) return '';
  return (BigInt(amountRaw) + nonceIntOf(quote)).toString();
}

/**
 * The exact payable amount, read from the nano offer the quote itself carries —
 * what the 402 challenged with. The rate is NEVER read here, so a rate that moved
 * after the quote cannot refuse a payer who sent exactly the challenged amount.
 */
function payableOf(quote: Quote): string {
  const offer = quote.offers.find((o) => o.rail === 'nano');
  return offer === undefined ? '' : payableFor(quote, offer.details?.amountRaw);
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
  //
  // Check that it is USABLE, not merely present. The published package is
  // JavaScript, so the NanoSignatureVerifier type is not enforced at runtime:
  // `=== undefined` alone let `null` and `{}` through, and the rail then died
  // with a TypeError inside verify -- after the payer's block had already
  // confirmed on-chain, which is the exact ordering this check exists to avoid.
  if (options.verifier === undefined || options.verifier === null || typeof options.verifier.verify !== 'function') {
    throw new TollstileError('CONFIG_INVALID', 'nanoRail requires a verifier (NanoSignatureVerifier) with a verify() function, to admit real payments (proof-of-possession).');
  }
  // Same reasoning for the refund signer, which had only `=== undefined` and so
  // let null and half-built objects through to `refund`. Omitting a signer is a
  // documented configuration (no refunds); supplying an UNUSABLE one is a
  // configuration mistake, and the only place it showed was inside the refund --
  // after the payer's block had confirmed on-chain and the handler had already
  // failed, as a TypeError out of the operator's own completion call. That is the
  // worst possible moment to learn of it, so it is refused at construction too.
  if (options.signer !== undefined
    && (options.signer === null || typeof options.signer.sendFor !== 'function')) {
    throw new TollstileError('CONFIG_INVALID', 'nanoRail was given a signer without a usable sendFor() function. Omit `signer` entirely for no refunds, or supply a NanoSigner, so a failed handler cannot discover this after the payment has moved on-chain.');
  }
  // `onSettled` was removed in 0.3.0: it ran inside `verify`, and core calls
  // `verify` BEFORE its single-use check, so a replayed block or an
  // Idempotency-Key retry fired it again. A JavaScript caller upgrading from
  // 0.2.x would otherwise have it silently ignored and stop booking payments.
  if ((options as { onSettled?: unknown }).onSettled !== undefined) {
    throw new TollstileError('CONFIG_INVALID', 'nanoRail no longer accepts onSettled (it fired again on a replay). Use createTollstile({ onEvent }) and book on `authorization.opened` with `created: true`, or `charge.moved`; core emits those once, after its ledger has decided.');
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
      // The ONLY place the rate is read. The amount goes into the quote's offer,
      // and verify takes it from there.
      const amount = toRaw(price.micros, await currentRate(options.xnoPerUsd));
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
      const payable = payableFor(quote, offer.details.amountRaw);
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
      const quoteToken = quoteFrom(context);
      const quote = quoteToken === null ? undefined : await terms.openQuote(quoteToken);
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
