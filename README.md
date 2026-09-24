# tollstile-rail-nano

A **[Nano (XNO)](https://nano.org)** settlement rail for **[Tollstile](https://tollstile.com)** —
open-source payment middleware for APIs, MCP tools and AI agents. Nano is instant
(~sub-second finality), **feeless** (no gas, no per-settlement platform fee), green
(0.00005 Wh/transfer, no mining) and truly peer-to-peer (no issuer that can freeze funds).

## What this rail is

An **upfront push-payment rail**: the payer publishes a Nano *send* block; verify()
confirms it on-chain and returns the settlement at verification time
(SPEC 9 paid-at-verification). There is no separate settle-time capture whose
response could be lost — which is why the conformance "lost settlement response"
and "failed before any effect" fault cases are reported as **skipped** (the
protocol has nothing for them to act on).

**A failed handler is refunded** by a reverse send when the operator supplies a
signer (`refund()` is required for the `upfront` flow). Without a signer,
a failed handler stays settled and the merchant must refund outside Tollstile.

**A paid proof pays for one purchase, and one purchase only.** Each quote asks for
a bespoke exact amount: the price (rounded to a nonce boundary) plus a per-quote
nonce in the low-order raw digits. Verify opens the quote token the payer presents
and accepts only a confirmed send to the merchant for exactly that amount. This
means a payment made for one quote cannot redeem a different quote, and an old
outside payment to the merchant never satisfies a fresh quote. The quote's own
expiry time-binds the payment.

- XNO amount math is integer-only (BigInt); prices are quoted in USD micros and
  converted to XNO *raw* (scale 30) with no floating-point precision loss.
- The `onSettled` callback records the merchant's received block the instant a
  payment is verified (a declared merchant callback, not a test hook).
- Ships a deterministic fake Nano RPC provider (`tollstile-rail-nano/testing`)
  for tests and demos.

## Conformance

Run against the published `tollstile` package:

```sh
npm test
```

Result: **13 passed, 2 skipped** across the conformance + rail suites (the two
skips are the lost/failed-settle-response fault cases, which do not apply to a
push payment rail; the 13th case is a regression test covering the "one proof,
one purchase" property that Tollstile's own railConformance does not yet check).

## Install

```ts
import { createTollstile, memoryLedger } from 'tollstile';
import { nanoRail } from 'tollstile-rail-nano';

const toll = createTollstile({
  rails: [nanoRail({
    merchantAccount: process.env.NANO_MERCHANT_ACCOUNT!,
    rpc: { blockInfo: (h) => /* your Nano RPC read */ },
    signer: { sendFor: (dest, raw, ctx) => /* your signer */ },
    rate: () => fetchExchangeRate('XNO-USD'),  // required, no silent default
    onSettled: (hash) => logReceived(hash),    // merchant records received block
  })],
  ledger: memoryLedger(),
});
```

## License

MIT
