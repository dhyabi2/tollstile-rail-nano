import { fakeClock, type RailHarness } from 'tollstile/testing';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_HEADER, NANO_SIGNATURE_HEADER } from '../src/nano-types.js';

export const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const XNO_PER_USD = '0.01'; // 1 XNO = $100; $1 -> 0.01 XNO -> 1e28 raw

/**
 * Drives the Nano rail through Tollstile's own `railConformance` suite against
 * the fake network.
 *
 * `settlements()` is the number of distinct Nano blocks the merchant accepted as
 * payment. The rail has no merchant hook (0.3.0 removed `onSettled`, which fired
 * again on a replay), so the harness observes the rail from the outside: a block
 * counts once `verify` has judged it `valid`. Counting by block hash is the
 * protocol's own rule, not a way of hiding a double count — one confirmed send is
 * one on-chain transfer, however many times it is presented. The rail-level
 * "does anything fire twice under replay" question is answered separately in
 * rail.test.ts, from core's events with no deduplication.
 *
 * A Nano payment has already moved on-chain when it is verified, so there is no
 * settle-time capture whose response could be lost: the "lost settlement
 * response" and "failed before any effect" fault cases are skipped by the suite,
 * for that protocol reason.
 */
export function harness(): RailHarness {
  const provider = nanoProvider(MERCHANT);
  const inner = nanoRail({
    merchantAccount: MERCHANT,
    rpc: provider,
    signer: provider,
    verifier: provider,
    xnoPerUsd: XNO_PER_USD,
  });
  const rail: typeof inner = {
    ...inner,
    async verify(context, terms, operation) {
      const result = await inner.verify(context, terms, operation);
      if (result.status === 'valid') provider.confirmIn(result.proofId);
      return result;
    },
  };
  return {
    rail,
    clock: fakeClock(),
    price: '$1',
    // A fresh payment per call: the payer sends the challenged raw amount
    // (price + nonce), signs the quote nonce, and echoes the quote token.
    pay: ({ offer, url }) => {
      const accepts = offer.challenge.accepts as { amountRaw: string };
      const mcp = offer.challenge.mcp as { nonce?: string; quote?: string };
      const hash = provider.pay(accepts.amountRaw);
      const signature = provider.sign(provider.payerAccount, mcp.nonce ?? '');
      return Promise.resolve(
        new Request(url, {
          headers: {
            [NANO_BLOCK_HEADER]: hash,
            [NANO_SIGNATURE_HEADER]: signature,
            [NANO_QUOTE_HEADER]: mcp.quote ?? '',
          },
        }),
      );
    },
    settlements: () => provider.settlements(),
    // Point the request at a block that was never created.
    tamper: (request) =>
      new Request(request.url, {
        headers: {
          [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged',
          [NANO_SIGNATURE_HEADER]: request.headers.get(NANO_SIGNATURE_HEADER) ?? '',
          [NANO_QUOTE_HEADER]: request.headers.get(NANO_QUOTE_HEADER) ?? '',
        },
      }),
  };
}
