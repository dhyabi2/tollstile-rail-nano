/**
 * The Nano (XNO) settlement rail for Tollstile.
 *
 * Nano is a DAG layer-1 asset with no issuer, no gas, and no on-chain escrow. A
 * payment is a signed `send` block that the payer publishes; once its block is
 * confirmed by the network it is final and the value has moved. That makes Nano a
 * *push payment* rail: the value is already settled at verification time, so
 * `verify()` returns the confirmation and core records the charge as settled
 * before the handler runs (SPEC §9 "Paid at verification").
 *
 * This file only depends on a Nano RPC (a `blockInfo` lookup) and, when a
 * merchant supplies a signing key, a way to create a reverse `send` for refunds.
 * No wallet is held here: secrets live with the operator who constructs the rail.
 */

/** One on-chain Nano block as the rail needs to read it. */
export type NanoBlockInfo = {
  /** The block's hash. */
  readonly hash: string;
  /** Whether the network has confirmed (cemented) the block. */
  readonly confirmed: boolean;
  /** The account the value left (the payer's public Nano address for a send). */
  readonly source: string;
  /** The account the value went to. */
  readonly destination: string;
  /** The amount moved, in raw (1 XNO = 10^30 raw). */
  readonly amountRaw: string;
  /** `send` for an outgoing transfer. */
  readonly subtype: 'send' | 'receive' | 'change' | 'open' | 'epoch';
};

/**
 * The read-only part of the Nano network the rail talks to. In production this is
 * backed by a public RPC such as rpc.nano.to; in tests it is a fake provider.
 * `blockInfo` MUST throw `PROVIDER_UNAVAILABLE`/`PROVIDER_TIMEOUT` (via the rail)
 * when the outcome cannot be known, never guess.
 */
export type NanoRpcRead = {
  blockInfo(hash: string): Promise<NanoBlockInfo | undefined>;
};

/**
 * An optional merchant signer, supplied by the operator so a failed handler can be
 * refunded by reverse send. The rail never fabricates or holds a key; it only calls
 * `sendFor` when a signer is configured.
 */
export type NanoSigner = {
  /** Submit a confirmed `send` from the merchant's account and return its hash. */
  sendFor(destination: string, amountRaw: string, context: { readonly refundOf: string }): Promise<string>;
};

/**
 * How many XNO one unit of the price currency (USD micros) is worth at quote time.
 * A plain number is a fixed rate; a function is evaluated for every quote, so a
 * volatile asset is priced fresh each time it is offered. Required: a merchant must
 * set it, and there is no silent default. Returns XNO per 1 of the price currency
 * (e.g. a rate of 0.01 with a USD price means $1 -> 0.01 XNO).
 */
export type XnoRate = number | ((micros: bigint) => number | Promise<number>);

/** The rail's own edge: merchant account + Nano RPC + optional refund signer. */
export type NanoRailOptions = {
  /** The public Nano address this merchant receives payments on. */
  readonly merchantAccount: string;
  /** Read the Nano ledger (rpc.nano.to in production, a fake in tests). */
  readonly rpc: NanoRpcRead;
  /**
   * XNO price of one unit of the price currency, evaluated at quote time. Required:
   * a volatile asset must not fall back to a hard-coded number (Tollstile rails refuse
   * to assume a conversion; pass a rate — ideally a function — not a default).
   */
  readonly rate: XnoRate;
  /**
   * When present, the merchant records a received block the instant the rail verifies a
   * payment for it (the settled leg of a push payment). A production deployment supplies a
   * wallet/reconciler that notes the received Nano send; the test provider counts it. This is a
   * declared merchant callback, not a test hook: a real merchant's account observation.
   */
  readonly onSettled?: (hash: string) => void | Promise<void>;
  /** When present, a failed handler is refunded by reverse send; else refund_unsupported. */
  readonly signer?: NanoSigner;
};

/** HTTP header the paying agent uses to present its Nano block hash. */
export const NANO_BLOCK_HEADER = 'x-nano-block';
/** HTTP header the paying agent uses to present the quote token it is paying. */
export const NANO_QUOTE_TOKEN_HEADER = 'x-nano-quote-token';
/** MCP `_meta` key carrying the same block hash. */
export const NANO_BLOCK_META = 'nano/block';
/** MCP `_meta` key carrying the same quote token. */
export const NANO_QUOTE_TOKEN_META = 'nano/quote-token';
/** The Nano asset the rail settles in. */
export const NANO_ASSET: { readonly code: string; readonly network: null; readonly scale: number } = Object.freeze({
  code: 'XNO',
  network: null,
  scale: 30,
});
