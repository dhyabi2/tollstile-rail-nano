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
protocol has nothing for them to act on). A failed handler is **refunded** by a
reverse send when the operator supplies a signer.

- `roundtrip`, `confirmIn`, `confirmOut`, `lookup`, `settlements`, `accounts`,
  `pending`, `pay` — the full Tollstile `railConformance` interface.
- XNO amount math is integer-only (BigInt); prices are quoted in USD micros and
  converted to XNO *raw* (scale 30) with no floating-point precision loss.
- Ships a deterministic fake Nano RPC provider (`tollstile-rail-nano/testing`)
  for tests and demos.

## Conformance

Run against the published `tollstile` package:

```
pnpm install
pnpm test
```

Result: **12 passed, 2 skipped** across the conformance + rail suites. The two
skips are the lost/failed-settle-response fault cases, which do not apply to a
push payment rail (the payment has already moved at verification).

## Install

```ts
import { createTollstile, memoryLedger } from 'tollstile';
import { nanoRail } from 'tollstile-rail-nano';

const toll = createTollstile({
  rails: [nanoRail({
    merchantAccount: process.env.NANO_MERCHANT_ACCOUNT!,
    rpc: { blockInfo: (h) => /* your Nano RPC read */ },
    signer: { sendFor: (dest, raw, ctx) => /* your signer */ },
    xnoPerUsd: 0.01,
  })],
  ledger: memoryLedger(),
});
```

## License

MIT
