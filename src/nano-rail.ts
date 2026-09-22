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
} from 'tollstile';
import type { NanoRailOptions, NanoBlockInfo } from './nano-types.js';
import { NANO_ASSET, NANO_BLOCK_HEADER, NANO_BLOCK_META, type NanoRpcRead } from './nano-types.js';

/** What the ledger keeps per authorization: the confirmed block that paid. Never a secret. */
export type NanoData = {
  readonly hash: string;
  readonly source: string;
  readonly destination: string;
  readonly amountRaw: string;
};

const ZERO = 0n;

function rawFromHeader(context: Context): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(NANO_BLOCK_HEADER);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[NANO_BLOCK_META];
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

function isConfirmedSendTo(block: NanoBlockInfo | undefined, merchant: string, minimumRaw: string): 'missing' | 'unconfirmed' | 'wrong-destination' | 'short' | 'ok' {
  if (block === undefined) return 'missing';
  if (!block.confirmed) return 'unconfirmed';
  if (block.destination !== merchant || block.subtype !== 'send') return 'wrong-destination';
  if (BigInt(block.amountRaw) < BigInt(minimumRaw)) return 'short';
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
 */
export function nanoRail(options: NanoRailOptions): ReturnType<typeof createRail<'nano', NanoData>> {
  const rate = options.xnoPerUsd ?? 0.01;
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
      quotes: false,
      variableAmount: false,
      partialRefund: false,
    },

    offer: ({ price }) => {
      const amount = toRaw(price.micros, rate);
      if (BigInt(amount) <= ZERO) return Promise.resolve(null);
      return Promise.resolve({
        rail: 'nano',
        asset: NANO_ASSET,
        amount,
        basis: 'rate',
        details: { to: merchant, amountRaw: amount },
      });
    },

    challenge: (_quote, _quoteToken, offer) =>
      Promise.resolve({
        headers: [[NANO_BLOCK_HEADER, '']],
        accepts: { to: offer.details.to as string, amountRaw: offer.details.amountRaw as string, scale: 30 },
        mcp: { style: 'x-nano', to: offer.details.to as string, amountRaw: offer.details.amountRaw as string },
      }),

    async verify(context: Context, terms: VerifyTerms): Promise<Verification<NanoData>> {
      const hash = rawFromHeader(context);
      if (hash === null || hash.length === 0) return { status: 'absent' };

      // The raw amount this request must be covered by. On a fixed route it comes from
      // the price/rate; on a dynamic route use the header-carried amount if present.
      let minimumRaw = toRaw(terms.price?.micros ?? 0n, rate);
      if (terms.price === null) {
        const carried = context.mcp?.meta['nano/amount'] ?? context.request?.headers.get('x-nano-amount');
        minimumRaw = typeof carried === 'string' && carried !== '' ? carried : minimumRaw;
      }
      if (BigInt(minimumRaw) <= ZERO) return { status: 'invalid', reason: 'amount_missing' };

      let block: NanoBlockInfo | undefined;
      try {
        block = await rpc.blockInfo(hash);
      } catch (error) {
        throw providerError(`block_info ${hash}`, error);
      }

      if (block === undefined) return { status: 'invalid', reason: 'proof_invalid', proofId: hash };

      switch (isConfirmedSendTo(block, merchant, minimumRaw)) {
        case 'missing':
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'unconfirmed':
          // Not yet cemented by the network: not a receipt. The client may retry later.
          return { status: 'invalid', reason: 'proof_pending', proofId: hash };
        case 'wrong-destination':
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'short':
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'ok': {
          const data: NanoData = { hash, source: block.source, destination: block.destination, amountRaw: block.amountRaw };
          // The value moved at verification. The merchant records the received block here.
          (rpc as NanoRpcRead & { confirmIn?: (h: string) => void }).confirmIn?.(hash);
          return {
            status: 'valid',
            proofId: hash,
            payer: block.source,
            quote: null,
            limit: null,
            expiresAt: null,
            data,
            settled: { reference: hash, details: { to: merchant, amountRaw: block.amountRaw } },
            idempotencyKey: hash,
          };
        }
      }
    },

    settle(authorization: Authorization): Promise<SettleResult> {
      const data = authorization.data as NanoData;
      return Promise.resolve({
        status: 'settled',
        reference: data.hash,
        details: { to: data.destination, amountRaw: data.amountRaw },
      });
    },

    async refund(authorization: Authorization): Promise<RefundResult> {
      const signer = options.signer;
      if (signer === undefined) return { status: 'rejected', reason: 'refund_unsupported' };
      const data = authorization.data as NanoData;
      // Reverse the payment: the merchant sends the settled amount back to the payer.
      const reference = await signer.sendFor(data.source, data.amountRaw, { refundOf: data.hash });
      return { status: 'refunded', reference };
    },

    async lookup(authorization: Authorization): Promise<LookupResult> {
      const data = authorization.data as NanoData;
      const block = await readBlock(data.hash);
      if (block === undefined || !block.confirmed) return { status: 'none' };
      return { status: 'settled', reference: data.hash, details: { to: data.destination, amountRaw: data.amountRaw } };
    },

    receipt(_authorization: Authorization, charge: Charge): Receipt {
      const ref = charge.settlement?.reference;
      const headers = ref === undefined ? [] : ([[NANO_BLOCK_HEADER, ref]] as const);
      return { headers, meta: {} };
    },

    redact(data: NanoData): NanoData {
      // Only public block facts are stored; nothing to drop. Keep what lookup/refund need.
      return { hash: data.hash, source: data.source, destination: data.destination, amountRaw: data.amountRaw };
    },
  });
}
