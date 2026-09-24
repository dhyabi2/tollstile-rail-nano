import {
  createRail,
  TollstileError,
  type Charge,
  type LookupResult,
  type Receipt,
  type RefundResult,
  type SettleResult,
  type Verification,
  type VerifyTerms,
  type Context,
} from 'tollstile';
import type { NanoBlockInfo, NanoRailOptions, XnoRate } from './nano-types.js';
import { NANO_ASSET, NANO_BLOCK_HEADER, NANO_BLOCK_META, NANO_QUOTE_TOKEN_HEADER, NANO_QUOTE_TOKEN_META, type NanoRpcRead } from './nano-types.js';

/** What the ledger keeps per authorization: the confirmed block that paid. Never a secret. */
export type NanoData = {
  readonly hash: string;
  readonly source: string;
  readonly destination: string;
  readonly amountRaw: string;
  readonly quoteId: string | null;
};

const ZERO = 0n;

/**
 * How many low-order raw digits carry the per-quote nonce. Nano has 30 decimals, so a
 * 14-digit nonce is 10^-16 XNO — materially nothing — while giving 10^14 unique amounts
 * per merchant, so each quote's exact payment amount is bespoke and no two quotes share it.
 */
const NONCE_DIGITS = 14n;
const NONCE_MODULUS = 10n ** NONCE_DIGITS;

/** A deterministic 64-bit FNV-1a hash of the quote token, mapped into the nonce space. */
function nonceFor(token: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < token.length; i += 1) {
    h ^= BigInt(token.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h % NONCE_MODULUS;
}

function blockHash(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_BLOCK_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_BLOCK_META];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

function quoteToken(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_QUOTE_TOKEN_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_QUOTE_TOKEN_META];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

/** Resolve the merchant's rate (fixed number or fresh-per-quote function). */
async function resolveRate(rate: XnoRate, micros: bigint): Promise<number> {
  const value = typeof rate === 'function' ? await rate(micros) : rate;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TollstileError('CONFIG_INVALID', `The nano rail's rate must be a positive number at quote time, got ${String(value)}.`);
  }
  return value;
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

/** The price rounded down to the nonce boundary: the smallest raw amount that leaves 14 digits free. */
function priceBase(raw: bigint): bigint {
  return (raw / NONCE_MODULUS) * NONCE_MODULUS;
}

/** Wrap an RPC failure as a provider error so core serves 503 rather than guessing. */
function providerError(action: string, cause: unknown): TollstileError {
  return new TollstileError('PROVIDER_UNAVAILABLE', `Nano RPC did not answer ${action}.`, { cause });
}

function isExactSendTo(block: NanoBlockInfo | undefined, merchant: string, exact: bigint): 'missing' | 'unconfirmed' | 'wrong-destination' | 'amount-mismatch' | 'ok' {
  if (block === undefined) return 'missing';
  if (!block.confirmed) return 'unconfirmed';
  if (block.destination !== merchant || block.subtype !== 'send') return 'wrong-destination';
  if (BigInt(block.amountRaw) !== exact) return 'amount-mismatch';
  return 'ok';
}

/**
 * A Nano (XNO) settlement rail for Tollstile.
 *
 * Flow `upfront`: the payer's confirmed `send` block is the payment and it has
 * already moved on-chain when `verify` runs, so `verify` returns `settled` and
 * core records the charge as settled before the handler (SPEC §9 "Paid at
 * verification"). When the handler fails, the rail refunds by reverse send if the
 * operator supplied a `signer`; otherwise the charge stays settled-and-reported.
 *
 * Binding: every quote asks for a bespoke exact amount — the price (rounded to a
 * nonce boundary) plus a per-quote nonce in the low-order raw digits. `verify`
 * opens the quoted token the payer presents and accepts only a confirmed send to
 * the merchant for exactly that amount, so a payment made for one purchase cannot
 * redeem another (Tollstile railConformance's missing "one proof, one purchase"
 * case), and an old or outside payment to the merchant never satisfies a quote.
 * The quote's own expiry time-binds the payment.
 */
export function nanoRail(options: NanoRailOptions): ReturnType<typeof createRail<'nano', NanoData>> {
  const merchant = options.merchantAccount;
  const rpc: NanoRpcRead = options.rpc;

  async function readBlock(hash: string): Promise<NanoBlockInfo | undefined> {
    try {
      return await rpc.blockInfo(hash);
    } catch (error) {
      throw providerError(`block_info ${hash}`, error);
    }
  }

  return createRail<'nano', NanoData>({
    name: 'nano',
    livemode: true,
    capabilities: {
      flows: ['upfront'],
      authorization: 'single',
      quotes: true,
      variableAmount: false,
      partialRefund: false,
    },

    async offer({ price }) {
      if (price === null) return Promise.resolve(null); // a push rail prices per quote, not per variable use
      const rate = await resolveRate(options.rate, price.micros);
      const base = priceBase(BigInt(toRaw(price.micros, rate)));
      if (base <= ZERO) return Promise.resolve(null);
      return Promise.resolve({
        rail: 'nano',
        asset: NANO_ASSET,
        amount: base.toString(),
        basis: 'rate',
        details: { to: merchant, amountRaw: base.toString() },
      });
    },

    async challenge(quote, quoteToken, offer) {
      const base = BigInt((offer.details.amountRaw as string) ?? '0');
      const exact = base + nonceFor(quoteToken);
      return Promise.resolve({
        headers: [
          [NANO_BLOCK_HEADER, ''],
          [NANO_QUOTE_TOKEN_HEADER, quoteToken],
        ],
        accepts: { quoteToken, to: offer.details.to as string, amountRaw: exact.toString(), scale: 30 },
        mcp: {
          style: 'x-nano',
          to: offer.details.to as string,
          amountRaw: exact.toString(),
          quoteToken,
        },
      });
    },

    async verify(context: Context, terms: VerifyTerms): Promise<Verification<NanoData>> {
      const hash = blockHash(context);
      if (hash === null || hash.length === 0) return { status: 'absent' };

      const token = quoteToken(context);
      if (token === null || token.length === 0) return { status: 'invalid', reason: 'quote_missing', proofId: hash };

      // The quote is what this payment is bound to. A forged, expired, or other-resource
      // quote must never admit a payment: openQuote returns undefined for all of those.
      const quote = await terms.openQuote(token);
      if (quote === undefined) return { status: 'invalid', reason: 'quote_invalid', proofId: hash };

      const rate = await resolveRate(options.rate, quote.price.micros);
      const base = priceBase(BigInt(toRaw(quote.price.micros, rate)));
      const exact = base + nonceFor(token);

      let block: NanoBlockInfo | undefined;
      try {
        block = await rpc.blockInfo(hash);
      } catch (error) {
        throw providerError(`block_info ${hash}`, error);
      }

      const verdict = isExactSendTo(block, merchant, exact);
      if (verdict === 'missing') return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
      if (verdict === 'unconfirmed') return { status: 'invalid', reason: 'proof_pending', proofId: hash };
      if (verdict === 'wrong-destination') return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
      if (verdict === 'amount-mismatch') {
        // A confirmed send that is not exactly this quote's amount is not this purchase's payment.
        return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
      }

      const data: NanoData = {
        hash,
        source: block!.source,
        destination: block!.destination,
        amountRaw: block!.amountRaw,
        quoteId: quote.id,
      };
      // The value moved on-chain at verification; the merchant records the received block.
      if (options.onSettled !== undefined) await options.onSettled(hash);
      return {
        status: 'valid',
        proofId: hash,
        payer: block!.source,
        quote,
        limit: null,
        expiresAt: null, // the quote's own expiry already time-binds the payment
        data,
        settled: { reference: hash, details: { to: merchant, amountRaw: block!.amountRaw } },
        idempotencyKey: hash,
      };
    },

    settle(authorization, charge) {
      const data = authorization.data as NanoData;
      return Promise.resolve({
        status: 'settled' as const,
        reference: data.hash,
        details: { to: data.destination, amountRaw: data.amountRaw },
      });
    },

    async refund(authorization, charge) {
      const signer = options.signer;
      if (signer === undefined) return { status: 'rejected' as const, reason: 'refund_unsupported' };
      const data = authorization.data as NanoData;
      // Reverse the payment: the merchant sends the settled amount back to the payer.
      const reference = await signer.sendFor(data.source, data.amountRaw, { refundOf: data.hash });
      return { status: 'refunded' as const, reference };
    },

    async lookup(authorization, charge) {
      const data = authorization.data as NanoData;
      const block = await readBlock(data.hash);
      if (block === undefined || !block.confirmed) return { status: 'none' as const };
      return { status: 'settled' as const, reference: data.hash, details: { to: data.destination, amountRaw: data.amountRaw } };
    },

    receipt(authorization, charge, context): Receipt {
      const ref = charge.settlement?.reference;
      const headers = ref === undefined ? [] : ([[NANO_BLOCK_HEADER, ref]] as const);
      return { headers, meta: {} };
    },

    redact(data: NanoData): NanoData {
      // Only public block facts are stored; nothing to drop. Keep what lookup/refund need.
      return { hash: data.hash, source: data.source, destination: data.destination, amountRaw: data.amountRaw, quoteId: data.quoteId };
    },
  });
}
