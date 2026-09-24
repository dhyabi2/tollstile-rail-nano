/**
 * A fake Nano network for the conformance suite, standing in for a public RPC and
 * the merchant's signing key. It behaves like Nano in the ways the rail depends
 * on:
 *   - a payer creates a confirmed `send` block to the merchant's account;
 *   - `block_info` answers the block or `undefined` for a forged hash;
 *   - the merchant "records" a received block once the rail verifies it valid
 *     (`settlements()` counts exactly these accepted blocks, so a tampered proof
 *     never settles);
 *   - the merchant's signer can refund a settled payment by a reverse `send`.
 *
 * It is deliberately small: it models the rail's contract, not the full Nano DAG.
 * A real deployment replaces `blockInfo` with rpc.nano.to and `sendFor` with the
 * operator's own Nano signing key.
 */
import type { NanoBlockInfo, NanoRpcRead, NanoSigner } from './nano-types.js';

export type NanoProvider = NanoRpcRead &
  NanoSigner & {
    /** The public account the payer draws from when creating a send. */
    readonly payerAccount: string;
    /** Confirmed send blocks the merchant accepted; the suite counts these. */
    settlements(): number;
    /** The merchant recorded a confirmed block it received (wired to the rail's onSettled). */
    confirmIn(hash: string): void;
    /** How many reverse-send refunds the merchant has issued. */
    refundCount(): number;
    /** Have the payer send `amountRaw` to the merchant; returns the block hash. */
    pay(amountRaw: string): string;
  };

let seq = 0;

function hashFor(prefix: string): string {
  const n = `0000000000000000000000000000000000000000000000000000000000000000${String(seq++).padStart(6, '0')}`;
  return `${prefix}${n.slice(-32)}`;
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

    sendFor(destination: string, amountRaw: string, _context?: { readonly refundOf: string }): Promise<string> {
      const { hash } = confirmedSend(merchantAccount, destination, amountRaw);
      refunds += 1;
      return Promise.resolve(hash);
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
