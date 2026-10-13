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
  /**
   * Submit a confirmed `send` from the merchant's account and return its hash.
   *
   * **`sendFor` MUST be idempotent per `context.refundOf`.** Core calls `refund`
   * again whenever a refund is left unresolved, and a `sendFor` that publishes a
   * new block on every call sends the payer their money TWICE off one payment --
   * irreversibly, because Nano has no chargeback.
   *
   * The rail reports a throwing `sendFor` as PROVIDER_UNAVAILABLE rather than
   * `rejected`, on purpose: the block may have been published and only the reply
   * lost, and asserting it did not move would strand money the payer is owed. The
   * cost of that choice is that the charge reaches `unknown` with `pending: refund`,
   * and core's `resolveUnknown` then calls `refund` a second time -- for BOTH
   * answers `lookup` can give it, `settled` and `none`. Only `lookup` returning
   * `refunded` would stop it, and this rail cannot return that: `NanoRpcRead` is a
   * `blockInfo(hash)` lookup of the PAYMENT block, with no way to search the
   * merchant's account for a reverse send that may or may not exist.
   *
   * Measured on 0.3.2 against the fake network, one failed handler and a `sendFor`
   * that publishes its send and then throws (a reply lost after the block was
   * accepted):
   *
   *     after pass.complete('failed')  sendFor calls: 1   reverse sends on chain: 1
   *     after toll.reconcile()         sendFor calls: 2   reverse sends on chain: 2
   *
   * So the retry is the operator's to absorb, and `refundOf` is what absorbs it.
   * It is the hash of the payment being reversed: single-use in core's ledger, one
   * refund per payment, and identical on every attempt (pinned by a test). Record
   * it with the reverse send and return the hash already recorded for it instead of
   * signing a second block.
   */
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
   * How many XNO one US dollar is worth, read once per quote and never again: the
   * challenged amount travels in the quote, so a later rate cannot change what a
   * payer owes. REQUIRED, with no default (a static constant silently undercharges
   * on a volatile asset). Prefer a decimal string ("0.0123"): it is exact. A number
   * is accepted and read through its decimal form. Or pass a function returning
   * either, called per quote.
   */
  readonly xnoPerUsd: string | number | (() => string | number | Promise<string | number>);
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