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
 * A signature verifier the rail uses to bind the presented block to the person
 * presenting it. The payer signs the per-quote nonce with the same Nano key that
 * signed the send block (source account); the rail verifies that signature against
 * the block source. Supplied by the operator or by a Nano wallet that exposes
 * ED25519 signing; without one the rail refuses to admit (fail closed), never
 * guesses.
 */
export type NanoSignatureVerifier = {
  /**
   * True iff `signature` is a valid ED25519 signature over `message` from the
   * Nano account `account`. The message is the UTF-8 bytes of the quote nonce.
   */
  verify(account: string, message: string, signature: string): boolean | Promise<boolean>;
};

/** The rail's own edge: merchant account + Nano RPC + optional refund signer. */
export type NanoRailOptions = {
  /** The public Nano address this merchant receives payments on. */
  readonly merchantAccount: string;
  /** Read the Nano ledger (rpc.nano.to in production, a fake in tests). */
  readonly rpc: NanoRpcRead;
  /** When present, a failed handler is refunded by reverse send; else refund_unsupported. */
  readonly signer?: NanoSigner;
  /**
   * Bind the presented block to its presenter: the payer signs the per-quote nonce
   * with the Nano source key and the rail verifies it. REQUIRED (the constructor
   * fails closed if omitted): without it any confirmed send to the merchant could
   * be replayed by a watcher, and refusing at verify would be after the money moved.
   */
  readonly verifier: NanoSignatureVerifier;
  /**
   * How many XNO one US dollar is worth, evaluated at quote time. REQUIRED: a rail
   * must never assume a default rate, or a static constant silently undercharges
   * the merchant on a volatile asset. Pass a number or a function called per quote.
   */
  readonly xnoPerUsd: number | (() => number | Promise<number>);
};

/** HTTP header the paying agent uses to present its Nano block hash. */
export const NANO_BLOCK_HEADER = 'x-nano-block';
/** MCP `_meta` key carrying the same hash. */
export const NANO_BLOCK_META = 'nano/block';
/** HTTP header carrying the payer's signature over the quote nonce. */
export const NANO_SIGNATURE_HEADER = 'x-nano-signature';
/** MCP `_meta` key carrying the same signature. */
export const NANO_SIGNATURE_META = 'nano/signature';
/** HTTP header carrying the signed quote token back on the paid request. */
export const NANO_QUOTE_HEADER = 'x-nano-quote';
/** MCP `_meta` key carrying the same quote token. */
export const NANO_QUOTE_META = 'nano/quote';
/** The Nano asset the rail settles in. */
export const NANO_ASSET: { readonly code: string; readonly network: null; readonly scale: number } = Object.freeze({ code: 'XNO', network: null, scale: 30 });