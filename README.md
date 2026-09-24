# tollstile-rail-nano

A **[Nano (XNO)](https://nano.org)** settlement rail for **[Tollstile](https://tollstile.com)** —
open-source payment middleware for APIs, MCP tools and AI agents. Nano is instant
(~sub-second finality), **feeless** (no gas, no per-settlement platform fee), green
(0.00005 Wh/transfer, no mining) and truly peer-to-peer (no issuer that can freeze funds).

## Refunds first

When the operator supplies a `signer`, a failed handler is **refunded** by a reverse
Nano send, so the merchant keeps no money for a call that did not succeed. **Without a
`signer`, the rail cannot refund**: the charge stays settled-and-reported and the payer's
money is held. That is the first thing to know before you wire this rail up — if you need
failed-call refunds, configure a `signer`.

## What this rail is

An **upfront push-payment rail** that carries **quotes** (SPEC 9 paid-at-verification):
the payer publishes a Nano *send* block, signs the quote nonce with the paying account's
key, and `verify()` confirms the block on-chain and returns the settlement at verification
time. Because the value has already moved when `verify` runs, there is no separate
settle-time capture whose response could be lost — so the conformance "lost settlement
response" and "failed before any effect" fault cases are reported as **skipped** (the
protocol has nothing for them to act on).

### Security model (a Nano payment is proven, not just present)

Nano has no memo field, and a send to a public merchant account is public to anyone
watching. To prevent one payment being redeemed twice or a copied block being presented by
someone who is not its payer, the rail binds every settlement to a **quote** and a
**presenter signature**:

- **Quotes binding.** The rail declares `quotes: true`. `verify()` opens the quote token
  the proof carries (`terms.openQuote`), and accepts a block only when its amount **exactly
  equals** the quote's offer, the quote is **unexpired**, and the quote is bound to this
  request (its resource/commitment). A donation, an off-quote block, or a stale block can
  never be redeemed as this purchase.
- **Presenter binding.** `verify()` requires an ed25519 signature over the quote nonce that
  validates against the paying block's **source account**. Only the payer who holds that
  account's key can present the block, so a watcher who copies a block hash cannot be served
  first. When the configured RPC cannot verify a signature, the rail treats a presented
  block as unproven.
- **Vendor-named price.** The price and amount come only from the quote the vendor signed.
  A client-carried amount (`x-nano-amount`) is ignored — the payer never names the price.

`xnoPerUsd` is **required** at build time (no silent default): a volatile asset is never
converted at a constant the merchant did not set.

## Conformance

Run against the published `tollstile` package:

```
pnpm install
pnpm test
```

The conformance + rail + security suites pass against the current rail: **21 passed,
2 skipped**. The two skips are the lost/failed-settle-response fault cases, which do not
apply to a push payment rail (the payment has already moved at verification).

## Install

```ts
import { createTollstile, memoryLedger } from 'tollstile';
import { nanoRail } from 'tollstile-rail-nano';

const toll = createTollstile({
  rails: [nanoRail({
    merchantAccount: process.env.NANO_MERCHANT_ACCOUNT!,
    xnoPerUsd: parseFloat(process.env.XNO_PER_USD!), // REQUIRED: no default
    rpc: {
      blockInfo: (h) => /* your Nano RPC block_info read */,
      // Optional but strongly recommended for the presenter-proof:
      // verifySignature: (message, signature, account) => /* Nano signature_verify */,
      // recordReceived: (h) => /* your receipt bookkeeping */,
    },
    signer: { sendFor: (dest, raw, ctx) => /* your signer; refunds need it */ },
  })],
  ledger: memoryLedger(),
});
```

## License

MIT
