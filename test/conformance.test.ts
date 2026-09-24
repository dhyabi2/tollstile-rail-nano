import { describe, it } from 'vitest';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_TOKEN_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// A rate function, called per quote so a volatile asset is priced fresh (required, no default).
const rate = () => 0.01; // 1 XNO = $100; $1 -> 0.01 XNO -> 1e28 raw

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
    rate,
    onSettled: (hash) => provider.confirmIn(hash),
    signer: provider,
  });
  return {
    rail,
    clock: fakeClock(),
    price: '$1',
    // A fresh payment per call: the payer sends the exact quoted raw amount (price base
    // plus the per-quote nonce) and presents the quote token it is paying.
    pay: ({ offer, url }) => {
      const accepts = offer.challenge.accepts as { amountRaw: string; quoteToken: string };
      const hash = provider.pay(accepts.amountRaw);
      return Promise.resolve(
        new Request(url, {
          headers: {
            [NANO_BLOCK_HEADER]: hash,
            [NANO_QUOTE_TOKEN_HEADER]: accepts.quoteToken,
          },
        }),
      );
    },
    settlements: () => provider.settlements(),
    // Point the request at a block that was never created and keep the (valid) quote:
    // the rail must reject the forged block and the provider must have no accepted settlement.
    tamper: (request) =>
      new Request(request.url, {
        headers: {
          [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged',
          ...(request.headers.has(NANO_QUOTE_TOKEN_HEADER)
            ? { [NANO_QUOTE_TOKEN_HEADER]: request.headers.get(NANO_QUOTE_TOKEN_HEADER) as string }
            : {}),
        },
      }),
  };
}

describe('nano rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
