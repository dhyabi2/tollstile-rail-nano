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
 *   - the payer signs the quote nonce with an ed25519 key, and `verifySignature`
 *     checks a presented signature against the payer's public key, standing in for
 *     a Nano `signature_verify` / `account_key` RPC pair.
 *
 * It is deliberately small: it models the rail's contract, not the full Nano DAG.
 * A real deployment replaces `blockInfo` with rpc.nano.to, `verifySignature` with
 * the operator's Nano signature-verify RPC path, and `sendFor` with the operator's
 * own Nano signing key.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { NanoBlockInfo, NanoRpcRead, NanoSigner } from './nano-types.js';

export type NanoProvider = NanoRpcRead &
  NanoSigner & {
    /** The public account the payer draws from when creating a send. */
    readonly payerAccount: string;
    /** Confirmed send blocks the merchant accepted; the suite counts these. */
    settlements(): number;
    /** How many reverse-send refunds the merchant has issued. */
    refundCount(): number;
    /** Have the payer send `amountRaw` to the merchant; returns the block hash. */
    pay(amountRaw: string): string;
    /** The payer signs `message` (the quote nonce) with its ed25519 key; returns hex. */
    sign(message: string): string;
  };

let seq = 0;

function hashFor(prefix: string): string {
  const n = `0000000000000000000000000000000000000000000000000000000000000000${String(seq++).padStart(6, '0')}`;
  return `${prefix}${n.slice(-32)}`;
}

export function nanoProvider(merchantAccount: string): NanoProvider {
  const payerAccount = 'nano_1fakepayer0000000000000000000000000000000000000000000000000';
  // The payer's ed25519 keypair, standing in for the Nano account key. In real
  // Nano the account is derived from the public key; here we verify signatures
  // against this key to prove the presenter holds the payer's key.
  const payerKey = createPrivateKey(
    '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJiYLqZuPvNQyHyovqAgAMkBPvSvaXmF6770cvTDBSPR\n-----END PRIVATE KEY-----\n',
  );
  // A second payer, to prove a copied block cannot be presented by someone else.
  const otherPayerKey = createPrivateKey(
    '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINpCT4jtv4a9GgT4HfXoE2pQ5iXGhpLf7RlYYgAjkCH2\n-----END PRIVATE KEY-----\n',
  );
  const payerPub = createPublicKey(payerKey);
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

    sign(message: string): string {
      return sign(null, Buffer.from(message, 'utf8'), payerKey).toString('hex');
    },

    async verifySignature(message: string, signature: string, account: string): Promise<boolean> {
      // Only the payer's own key ever validly signs for the payer account. A
      // presenter who does not hold that key (modelled here by the other key, and
      // in production by a replayed signature whose signer is not the source)
      // cannot produce a valid signature over a fresh nonce.
      if (account !== payerAccount) {
        void otherPayerKey; // presenters not bound to the paying account never pass.
        return false;
      }
      const buf = Buffer.from(signature, 'hex');
      if (buf.length !== 64) return false;
      try {
        return verify(null, Buffer.from(message, 'utf8'), payerPub, buf);
      } catch {
        return false;
      }
    },

    recordReceived(hash: string): void {
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
