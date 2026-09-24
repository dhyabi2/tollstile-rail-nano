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
   nonce the low ones). The nonce is a SHA-256 digest of the quote id folded into
   the low digits; the amount distinguishes quotes within those digits — single-use
   and the payer signature enforce the binding, not more digits. `verify` accepts
   only an **exact** match and reads the payable amount from the quote's own offer
   (it never re-reads the rate), so a rate that moved between quote-time and the
   paid request cannot refuse a payer who sent exactly what was challenged.
2. **Proof-of-possession.** The payer signs the quote's nonce with the same Nano
   key that sent the block. `verify` checks the signature against the block's
   source, so a watcher replaying a public block hash is not served.
3. **Rate is required, not defaulted, and locked at quote time.** `xnoPerUsd` has
   no default and is evaluated at quote time (a plain number or a function); the
   challenged amount never depends on a later rate reading. `verifier` is required
   and the rail fails closed at construction if it is missing — refusing a payment
   at verify time would be after the money moved.

The rail declares `quotes: true` and carries the signed quote (nonce + exact
amount) through its protocol; `verify` returns the quote it was made against and
the block must arrive within the quote's expiry.

## Conformance

Run against the published `tollstile` package:

```
npm install
npm test
```

Result: **15 passed** across the rail + conformance suites (7 rail unit tests + 8
conformance tests). The two fault cases that Tollstile's suite reports as skip for
a push rail (lost/failed settle response) have nothing to act on: a Nano payment
has already moved on-chain at verification, so there is no separate settle-time
capture whose response could be lost.

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
