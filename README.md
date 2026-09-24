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

## Refunds: read this first

A failed handler is **refunded by a reverse send only when the operator supplies
a `signer`**. Without one, the charge stays **settled and reported** — the payer's
money has already moved on-chain and the merchant keeps it. If you need a failed
call to give the money back, configure a `signer`; if you cannot, that behavior is
a deliberate choice, not a bug — make sure it is what your terms say.

## Proof is bound to the purchase and its payer

Because Nano blocks are public and have no memo field, a payment proof must be
tied to the specific purchase to be safe (Tollstile#47 review):

1. **Exact amount per quote.** The quoted price in raw plus a small nonce bound to
   the quote (raw has 30 decimals, so the price occupies the high digits and the
   nonce the low ones). `verify` accepts only an **exact** match — a donation, an
   old payment, or a payment for a different quote cannot redeem this one.
2. **Proof-of-possession.** The payer signs the quote's nonce with the same Nano
   key that sent the block. `verify` checks the signature against the block's
   source, so a watcher replaying a public block hash is not served.
3. **Rate is required, not defaulted.** `xnoPerUsd` has no default and is evaluated
   at quote time (a plain number or a function), so a volatile asset is never
   underpriced by a stale constant.

The rail declares `quotes: true` and carries the signed quote (nonce + exact
amount) through its protocol; `verify` returns the quote it was made against and
the block must arrive within the quote's expiry.

## Conformance

Run against the published `tollstile` package:

```
npm install
npm test
```

Result: **14 passed, 2 skipped** across the conformance + rail suites. The two
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
    signer: { sendFor: (dest, raw, ctx) => /* your signer (for refunds) */ },
    verifier: { verify: (acc, msg, sig) => /* verify an ED25519 Nano signature */ },
    // Required, and evaluated at quote time if you pass a function:
    xnoPerUsd: () => fetchXnoUsdRate(),
  })],
  ledger: memoryLedger(),
});
```

## License

MIT
