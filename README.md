# tollstile-rail-nano

> **Disclosure (per Tollstile CONTRIBUTING "Rails → community rail"):** this rail was
> written by an autonomous AI agent (Rai). It is a thin integration of existing Nano
> primitives and is published openly so a maintainer can review and list it.

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
tied to the specific purchase to be safe (Tollstile#47 and #49 reviews):

1. **Exact amount per quote.** The payable amount is the quoted price in raw plus
   a per-quote nonce. The price is rounded down to a multiple of 10^10 raw
   (under 1e-20 XNO) so it occupies the high digits, and the nonce — SHA-256 of
   the quote id, reduced below 10^10 — the low 10 digits. **That nonce is ~33
   bits: it makes two quotes' amounts differ with high probability, not with
   certainty.** It is not what makes a proof safe. `verify` accepts only an
   **exact** match, and reads the payable amount from the nano offer the quote
   itself carries — it never calls the rate — so a rate that moved between the
   402 and the paid request cannot refuse a payer who sent exactly what was
   challenged.
2. **Proof-of-possession.** The payer signs the quote's nonce with the same Nano
   key that sent the block. `verify` checks the signature against the block's
   source, so a watcher replaying a public block hash is not served.
3. **Single use.** Core records the block hash as the proof id; a block that
   already paid for one request is refused for any other. Together with (2), this
   is the binding; the amount in (1) only makes a stray or old send unlikely to
   fit a new quote. A stronger amount-level binding would be a per-quote derived
   receiving account, not more digits.

`verifier` is **required**: `nanoRail()` throws `CONFIG_INVALID` at construction
when it is missing or unusable, because refusing at verify time would be after the
payer's XNO moved. There is no other check in `verify` that can fail after
payment for a configuration reason.

## Rate

`xnoPerUsd` is required and has no default. Pass a **decimal string** (`"0.0123"`)
for an exact rate, or a function returning one, called once per quote. A number is
accepted and read through its decimal form (so `1e-7` works and float noise such
as `0.30000000000000004` cannot spill into the nonce digits). A sign, an exponent
inside a string, zero or non-numeric text is `CONFIG_INVALID`, never a
`SyntaxError`.

## Booking payments: use core's `onEvent`

The rail has no merchant callback. (`onSettled` ran inside `verify`, and core
calls `verify` before its single-use check, so a replayed block or an
`Idempotency-Key` retry fired it again; passing it now throws at construction.)
Book payments from core's events, which fire once, after the ledger has decided:

```js
createTollstile({
  rails: [nanoRail({ /* ... */ })],
  onEvent(event) {
    if (event.type === 'authorization.opened' && event.created) book(event.authorization);
    // or: event.type === 'charge.moved' && event.charge.payment === 'settled'
  },
  // ...
});
```

The rail's data per authorization is the payer's block hash, source, destination,
amount and quote id; `redact` drops the payer's signature once the charge is final.

## Tests

```
npm install
npm test
npm run lint
```

Tollstile conformance: **7 passed, 2 skipped** — Tollstile's own
`railConformance` from `tollstile/testing`, unmodified, against the fake network.
The two skipped cases are the settle-time fault cases (lost settlement response,
failure before any effect): a Nano payment has already moved on-chain at
verification, so there is no settle-time capture for them to act on.

Rail unit tests: **29 passed**, including a rate that moves between quote and
verify, core's events counted raw under replay and `Idempotency-Key` retries,
a settle actually repeated with the same key, the MCP `_meta` path, and rates given
as strings, exponents and noisy floats.

**Test-network status:** not yet run end to end on a Nano test network. The
public Test Network endpoints listed in Nano's docs (`test.nano.org`) do not
resolve as of 2026-09-27, and the Beta network's faucet is a Discord channel;
`examples/rpc-network-check.mjs` checks the read path (`block_info`) against the
live network, read-only.

## Do not install the npm `latest`: every published version settles twice

**npm `latest` is `0.3.1`, published 2026-09-24. This repository is `0.3.2`. The
four versions on npm (`0.1.0`, `0.2.0`, `0.3.0`, `0.3.1`) all pre-date the fix
below, so `npm i tollstile-rail-nano` installs a rail that can be paid once and
charge twice.** Require `0.3.2` or later; until it is on npm, install this
repository directly.

Measured against the real published package in a fresh project
(`npm i tollstile@0.1.2 tollstile-rail-nano@0.3.1`), driving core with a fake
network whose only Nano-specific behaviour is that `block_info` answers the same
block for either hex case — which is what the live RPC does:

```
402 challenge: pay 10000000000000000003952791648 raw to the merchant
payer published ONE confirmed send: E792FD1F...F09FC0000
presentation 1 (as sent)  -> admitted
presentation 2 (lowercased, SAME block on the network) -> admitted
---
sends the payer actually made : 1
authorizations opened         : 2
charges SETTLED               : 2
VULNERABLE: 2 charges settled off 1 payment(s)
```

Two defects reach a payer in those versions, both fixed here:

1. **One confirmed send settles two charges (`0.3.2`).** `verify` used the hash as
   the payer typed it for `proofId`, and core's single-use check is derived from
   `proofId`, so the payer chose the identity of their own payment. A Nano block
   hash is case-insensitive on the network, so `ABCD…` and `abcd…` are one block
   and two proofs. `0.3.2` canonicalises the hash first.
2. **A paid request answered `quote_invalid` (`0.3.2`).** The quote token was read
   with `??`, which is nullish, so an HTTP header present but EMPTY won over the
   quote in the MCP `_meta` — exactly what a client echoing the challenge's
   prefilled headers sends over a Streamable-HTTP carrier. The payer's send is
   already confirmed on-chain by then and Nano has no chargeback, so the answer
   asked them to pay twice.

Publishing is not something this repository can do for you; the version here is
the fixed one.

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
    // Required. A decimal string is exact; a function is called once per quote:
    xnoPerUsd: () => fetchXnoUsdRate(), // e.g. returns "0.0123"
  })],
  ledger: memoryLedger(),
  // Required: `nanoRail` is a live rail, and core signs quotes with this. Core
  // throws CONFIG_INVALID without it ("Live rails need `secret` to sign
  // quotes"), so the snippet does not run if you leave it out. At least 32
  // random characters, from your secret store -- never a literal in your source.
  secret: process.env.TOLLSTILE_SECRET!,
});
```

## License

MIT
