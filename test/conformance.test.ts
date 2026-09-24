import { describe, it } from 'vitest';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_HEADER, NANO_SIGNATURE_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01; // 1 XNO = $100; $1 -> 0.01 XNO -> 1e28 raw

/**
 * Drives the Nano rail against the fake network. Because a Nano payment has already
 * moved on-chain when it is verified, there is no separate `settle`-time capture
 * whose response could be lost; the "lost settlement response" and "failed before
 * any effect" fault cases therefore do not apply to this rail and are reported as
 * skipped for that protocol reason (CONTRIBUTING allows a skip when the reason
 * holds for the protocol).
 */
function harness(): RailHarness {
  const provider = nanoProvider(MERCHANT);
  const rail = nanoRail({
    merchantAccount: MERCHANT,
    rpc: provider,
    signer: provider,
    verifier: provider,
    // Record each block the rail admits as a settlement in the fake provider.
    onSettled: (block) => provider.confirmIn(block.hash),
    xnoPerUsd: XNO_PER_USD,
  });
  return {
    rail,
    clock: fakeClock(),
    price: '$1',
    // A fresh payment per call: the payer sends the quoted raw amount (including
    // the nonce) to the merchant and signs the quote nonce as proof-of-possession.
    // It also echoes the challenge's quote token back so verify can open it.
    pay: ({ offer, url }) => {
      const accepts = offer.challenge.accepts as { amountRaw: string };
      const nonce = (offer.challenge.mcp as { nonce?: string }).nonce ?? '';
      const quoteToken = (offer.challenge.mcp as { quote?: string }).quote ?? '';
      const hash = provider.pay(accepts.amountRaw);
      const signature = provider.sign(provider.payerAccount, nonce);
      return Promise.resolve(
        new Request(url, {
          headers: {
            [NANO_BLOCK_HEADER]: hash,
            [NANO_SIGNATURE_HEADER]: signature,
            [NANO_QUOTE_HEADER]: quoteToken,
          },
        }),
      );
    },
    settlements: () => provider.settlements(),
    // Point the request at a block that was never created: the rail must reject it
    // and the provider must have no accepted settlement.
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

describe('nano rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
