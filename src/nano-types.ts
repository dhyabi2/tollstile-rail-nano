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

/** The rail's own edge: merchant account + Nano RPC + optional refund signer. */
export type NanoRailOptions = {
  /** The public Nano address this merchant receives payments on. */
  readonly merchantAccount: string;
  /** Read the Nano ledger (rpc.nano.to in production, a fake in tests). */
  readonly rpc: NanoRpcRead;
  /** When present, a failed handler is refunded by reverse send; else refund_unsupported. */
  readonly signer?: NanoSigner;
  /** Amount conversion for `offer`: how many XNO one US dollar is worth at quote time. */
  readonly xnoPerUsd?: number;
};

/** HTTP header the paying agent uses to present its Nano block hash. */
export const NANO_BLOCK_HEADER = 'x-nano-block';
/** MCP `_meta` key carrying the same hash. */
export const NANO_BLOCK_META = 'nano/block';
/** The Nano asset the rail settles in. */
export const NANO_ASSET: { readonly code: string; readonly network: null; readonly scale: number } = Object.freeze({ code: 'XNO', network: null, scale: 30 });
