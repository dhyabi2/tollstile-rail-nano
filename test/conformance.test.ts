import { describe, it } from 'vitest';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_SIGNATURE_HEADER, NANO_QUOTE_HEADER } from '../src/nano-types.js';

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
  const rail = nanoRail({ merchantAccount: MERCHANT, rpc: provider, signer: provider, xnoPerUsd: XNO_PER_USD });
  return {
    rail,
    clock: fakeClock(),
    price: '$1',
    // A fresh payment per call: the payer sends the quoted raw amount to the merchant,
    // signs the quote nonce with its key, and presents block + signature + quote token.
    pay: ({ denial, offer, url }) => {
      const accepts = offer.challenge.accepts as { amountRaw: string };
      const body = (denial as unknown as { body?: Record<string, unknown> }).body ?? {};
      const hash = provider.pay(accepts.amountRaw);
      const signature = provider.sign(String(body.nonce ?? ''));
      return Promise.resolve(
        new Request(url, {
          headers: {
            [NANO_BLOCK_HEADER]: hash,
            [NANO_SIGNATURE_HEADER]: signature,
            [NANO_QUOTE_HEADER]: String(body.quote ?? ''),
          },
        }),
      );
    },
    settlements: () => provider.settlements(),
    // Point the request at a block that was never created (a forged proof): the rail
    // must reject it and the provider must have no accepted settlement.
    tamper: (request) =>
      new Request(request.url, {
        headers: { [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged' },
      }),
  };
}

describe('nano rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
