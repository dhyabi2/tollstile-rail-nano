/**
 * A fake Nano network for the conformance suite, standing in for a public RPC and
 * the merchant's signing key. It behaves like Nano in the ways the rail depends
 * on:
 *   - a payer creates a confirmed `send` block to the merchant's account;
 *   - `block_info` answers the block or `undefined` for a forged hash;
 *   - the merchant "records" a received block once the rail verifies it valid
 *     (`settlements()` counts exactly these accepted blocks, so a tampered proof
 *     never settles);
 *   - the merchant's signer can refund a settled payment by a reverse `send`;
 *   - the payer can sign the quote nonce and the rail verifies it, binding the
 *     presented block to its presenter (proof-of-possession, Tollstile#47).
 *
 * It is deliberately small: it models the rail's contract, not the full Nano DAG.
 * A real deployment replaces `blockInfo` with rpc.nano.to, `sendFor` with the
 * operator's own Nano signing key, and the signature verifier with Nano's ED25519
 * verification over the account's public key.
 */
import { createHash } from 'node:crypto';
import type { NanoBlockInfo, NanoRpcRead, NanoSigner, NanoSignatureVerifier } from './nano-types.js';

export type NanoProvider = NanoRpcRead &
  NanoSigner &
  NanoSignatureVerifier & {
    /** The public account the payer draws from when creating a send. */
    readonly payerAccount: string;
    /** Confirmed send blocks the merchant accepted; the suite counts these. */
    settlements(): number;
    /** The merchant recorded a confirmed block it received (called by the rail on valid verify). */
    confirmIn(hash: string): void;
    /** How many reverse-send refunds the merchant has issued. */
    refundCount(): number;
    /** Have the payer send `amountRaw` to the merchant; returns the block hash. */
    pay(amountRaw: string): string;
    /** Sign `message` with the given account's fake Nano key; returns the signature (hex). */
    sign(account: string, message: string): string;
  };

let seq = 0;

function hashFor(prefix: string): string {
  const n = `0000000000000000000000000000000000000000000000000000000000000000${String(seq++).padStart(6, '0')}`;
  return `${prefix}${n.slice(-32)}`;
}

/** Deterministic ED25519 keypair per Nano account string, so signing/verify are coherent. */
function keypairOf(account: string) {
  const seed = createHash('sha256').update(`tollstile-nano-fake:${account}`).digest('hex').slice(0, 64);
  // We can't hand a raw 32-byte seed to createSign with a DER key; derive a full
  // key by using the seed to build a node:crypto Sign/Verify pair via a key object.
  // Simplest faithful approach: store the seed, and sign by replaying it. Node's
  // ed25519 needs a KeyObject; we derive one deterministically is not exposed, so
  // we emulate with HMAC-seeded signatures accepted by our own fake verifier.
  return { seed };
}

function fakeSign(account: string, message: string): string {
  const { seed } = keypairOf(account);
  return `${seed}:${createHash('sha256').update(`${account}::${message}`).digest('hex')}`;
}

export function nanoProvider(merchantAccount: string): NanoProvider {
  const payerAccount = 'nano_1fakepayer0000000000000000000000000000000000000000000000000';
  const blocks = new Map<string, NanoBlockInfo>();
  const accepted = new Set<string>();
  let refunds = 0;
  const confirmedSend = (source: string, destination: string, amountRaw: string, subtype: 'send' = 'send') => {
    const hash = hashFor('fail_');
    const block: NanoBlockInfo = { hash, confirmed: true, source, destination, amountRaw, subtype };
    blocks.set(hash, block);
    return { hash, block };
  };

  return {
    payerAccount,

    pay(amountRaw: string): string {
      const { hash } = confirmedSend(payerAccount, merchantAccount, amountRaw);
      return hash;
    },

    blockInfo(hash: string): Promise<NanoBlockInfo | undefined> {
      return Promise.resolve(blocks.get(hash));
    },

    sendFor(destination: string, amountRaw: string): Promise<string> {
      const { hash } = confirmedSend(merchantAccount, destination, amountRaw);
      refunds += 1;
      return Promise.resolve(hash);
    },

    verify(account: string, message: string, signature: string): boolean {
      return fakeSign(account, message) === signature;
    },

    sign(account: string, message: string): string {
      return fakeSign(account, message);
    },

    confirmIn(hash: string): void {
      const block = blocks.get(hash);
      if (block !== undefined && block.confirmed) accepted.add(hash);
    },

    settlements(): number {
      return accepted.size;
    },

    refundCount(): number {
      return refunds;
    },
  };
}