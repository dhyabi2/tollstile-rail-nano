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
  type Offer,
  type Header,
} from 'tollstile';
import type { NanoRailOptions, NanoBlockInfo } from './nano-types.js';
import {
  NANO_ASSET,
  NANO_BLOCK_HEADER,
  NANO_BLOCK_META,
  NANO_SIGNATURE_HEADER,
  NANO_SIGNATURE_META,
  NANO_QUOTE_HEADER,
  NANO_QUOTE_META,
  type NanoRpcRead,
} from './nano-types.js';

/** What the ledger keeps per authorization: the block that paid and the presenter signature. Never a secret. */
export type NanoData = {
  readonly hash: string;
  readonly source: string;
  readonly destination: string;
  readonly amountRaw: string;
  /** Quote token the payment was made against. */
  readonly quoteToken: string;
};

const ZERO = 0n;

function headerValue(context: Context, headerName: string, metaKey: string): string | null {
  if (context.request !== null) {
    const value = context.request.headers.get(headerName);
    if (value !== null && value !== '') return value;
  }
  const meta = context.mcp?.meta[metaKey];
  if (typeof meta === 'string' && meta !== '') return meta;
  return null;
}

function rawFromHeader(context: Context): string | null {
  return headerValue(context, NANO_BLOCK_HEADER, NANO_BLOCK_META);
}
function signatureFromHeader(context: Context): string | null {
  return headerValue(context, NANO_SIGNATURE_HEADER, NANO_SIGNATURE_META);
}
function quoteTokenFromHeader(context: Context): string | null {
  return headerValue(context, NANO_QUOTE_HEADER, NANO_QUOTE_META);
}

/** Convert a currency price (USD micros) to XNO raw exactly, treating the rate as a decimal string. */
function toRaw(micros: bigint, xnoPerUsd: number): string {
  const s = String(xnoPerUsd);
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

/** An exact match of the block's moved amount to the quoted raw amount. A quoted block is required. */
function checkBlock(block: NanoBlockInfo | undefined, merchant: string, exactRaw: string): 'missing' | 'unconfirmed' | 'wrong-destination' | 'amount-mismatch' | 'ok' {
  if (block === undefined) return 'missing';
  if (!block.confirmed) return 'unconfirmed';
  if (block.destination !== merchant || block.subtype !== 'send') return 'wrong-destination';
  if (BigInt(block.amountRaw) !== BigInt(exactRaw)) return 'amount-mismatch';
  return 'ok';
}

/** Find this rail's offer inside a quote so the quoted amount is the binding price. */
function offerFor(quote: Quote, railName: string): Offer | undefined {
  for (const offer of quote.offers) if (offer.rail === railName) return offer;
  return undefined;
}

/**
 * A Nano (XNO) settlement rail for Tollstile.
 *
 * Flow `upfront`, quote-bound (SPEC §9 "Paid at verification"):
 *  - `offer`/`challenge` produce a per-request quote (Tollstile signs it; `quotes` is on).
 *  - The payer pays the exact quoted raw amount to the merchant and signs the quote
 *    nonce with the paying account's key.
 *  - `verify` opens the quote the proof carries, requires the block's amount to equal
 *    the quote's offer exactly, within the quote's validity, and verifies an ed25519
 *    signature over the quote nonce against the block's source account — so a copied
 *    block cannot be presented by someone other than its payer, and an off-quote or
 *    stale block can never settle.
 *  - When the handler fails, the rail refunds by reverse send if the operator supplied
 *    a `signer`; otherwise the charge stays settled-and-reported.
 */
export function nanoRail(options: NanoRailOptions): ReturnType<typeof createRail<'nano', NanoData>> {
  if (!(options && typeof options.xnoPerUsd === 'number' && Number.isFinite(options.xnoPerUsd) && options.xnoPerUsd > 0)) {
    throw new TollstileError('CONFIG_INVALID', 'The nano rail requires an explicit, positive xnoPerUsd exchange rate at build time; no default is assumed.');
  }
  const rate = options.xnoPerUsd;
  const merchant = options.merchantAccount;
  const rpc: NanoRpcRead = options.rpc;

  async function readBlock(hash: string): Promise<NanoBlockInfo | undefined> {
    try {
      return await rpc.blockInfo(hash);
    } catch (error) {
      throw providerError(`block_info ${hash}`, error);
    }
  }

  async function verifyPresenterSignature(nonce: string, signature: string | null, sourceAccount: string): Promise<boolean> {
    // A presented block must be proven to belong to its presenter: only the holder
    // of the source account's key can sign the quote nonce. Without a verifier the
    // rail cannot establish that ownership and treats the proof as invalid.
    if (rpc.verifySignature === undefined) {
      if (signature === null) return false;
      throw providerError('signature_verify (verifySignature not configured)', new Error('verifySignature method is not configured'));
    }
    if (signature === null) return false;
    try {
      return await rpc.verifySignature(nonce, signature, sourceAccount);
    } catch (error) {
      throw providerError(`signature_verify ${sourceAccount}`, error);
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

    challenge: (_quote, quoteToken, offer) =>
      Promise.resolve({
        headers: [
          [NANO_BLOCK_HEADER, ''],
          [NANO_SIGNATURE_HEADER, ''],
          [NANO_QUOTE_HEADER, quoteToken],
        ] as Header[],
        accepts: {
          to: offer.details.to as string,
          amountRaw: offer.details.amountRaw as string,
          scale: 30,
          quoteToken,
          sign: 'sign the quote nonce with the paying account\'s ed25519 key; send it in x-nano-signature',
        },
        mcp: {
          style: 'x-nano',
          to: offer.details.to as string,
          amountRaw: offer.details.amountRaw as string,
          quoteToken,
          sign: 'sign-the-quote-nonce',
        },
      }),

    async verify(context: Context, terms: VerifyTerms): Promise<Verification<NanoData>> {
      const hash = rawFromHeader(context);
      const signature = signatureFromHeader(context);
      const quoteToken = quoteTokenFromHeader(context);
      if (hash === null || hash.length === 0) return { status: 'absent' };
      if (quoteToken === null || quoteToken.length === 0) {
        return { status: 'invalid', reason: 'quote_missing', proofId: hash };
      }

      // Open the quote the proof carries. A forged, expired, or cross-resource quote
      // returns undefined: the block cannot be bound to this purchase now.
      const quote = await terms.openQuote(quoteToken);
      if (quote === undefined) return { status: 'invalid', reason: 'quote_expired_or_forged', proofId: hash };

      const offer = offerFor(quote, 'nano');
      if (offer === undefined) return { status: 'invalid', reason: 'quote_offer_missing', proofId: hash };

      const exactRaw = (offer.details as { amountRaw?: string }).amountRaw;
      if (typeof exactRaw !== 'string' || BigInt(exactRaw) <= ZERO) {
        return { status: 'invalid', reason: 'amount_missing', proofId: hash };
      }

      let block: NanoBlockInfo | undefined;
      try {
        block = await rpc.blockInfo(hash);
      } catch (error) {
        throw providerError(`block_info ${hash}`, error);
      }
      if (block === undefined) return { status: 'invalid', reason: 'proof_invalid', proofId: hash };

      switch (checkBlock(block, merchant, exactRaw)) {
        case 'missing':
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'unconfirmed':
          // Not yet cemented by the network: not a receipt. The client may retry later.
          return { status: 'invalid', reason: 'proof_pending', proofId: hash };
        case 'wrong-destination':
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'amount-mismatch':
          // A block to the merchant for a different amount is not this purchase.
          return { status: 'invalid', reason: 'proof_invalid', proofId: hash };
        case 'ok': {
          const source = block.source;
          const nonce = quote.nonce;
          const presented = await verifyPresenterSignature(nonce, signature, source);
          if (!presented) {
            return { status: 'invalid', reason: 'presenter_unproven', proofId: hash };
          }
          const data: NanoData = {
            hash,
            source,
            destination: block.destination,
            amountRaw: block.amountRaw,
            quoteToken,
          };
          // Record the merchant's acceptance of this confirmed block as a receipt.
          (rpc as NanoRpcRead & { recordReceived?: (h: string) => void }).recordReceived?.(hash);
          return {
            status: 'valid',
            proofId: hash,
            payer: source,
            quote,
            limit: null,
            expiresAt: quote.expiresAt,
            data,
            settled: { reference: hash, details: { to: merchant, amountRaw: block.amountRaw } },
            idempotencyKey: hash,
          };
        }
      }
    },

    settle(authorization: Authorization & { data: NanoData }): Promise<SettleResult> {
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
      const block = await readBlock(data.hash);
      if (block === undefined || !block.confirmed) return { status: 'none' };
      return { status: 'settled', reference: data.hash, details: { to: data.destination, amountRaw: data.amountRaw } };
    },

    receipt(_authorization: Authorization, charge: Charge): Receipt {
      const ref = charge.settlement?.reference;
      const headers: Header[] = ref === undefined ? [] : [[NANO_BLOCK_HEADER, ref]];
      return { headers, meta: {} };
    },

    redact(data: NanoData): NanoData {
      // Quote token and block facts are public; nothing secret is stored beyond the
      // source account (needed for refunds). Keep what lookup/refund need.
      return { hash: data.hash, source: data.source, destination: data.destination, amountRaw: data.amountRaw, quoteToken: data.quoteToken };
    },
  });
}
