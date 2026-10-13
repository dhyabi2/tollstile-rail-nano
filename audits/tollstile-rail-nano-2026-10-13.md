# tollstile-rail-nano - audit 2026-10-13

Base: `0837429` (master, "the README count law counted it() lines, not the cases that run (#20)").
`npm ci && npm test && npm run build && npx eslint .` before anything: **77 passed, 2 skipped**
(9 conformance, 70 rail unit), build clean, lint clean.

## Checked

- The whole XNO receive path: `offer` -> `challenge` -> `verify` -> `settle` -> `receipt`, and the
  two reads core comes back to, `lookup` and `refund`.
- `parseRate` / `expandExponent` / `toRaw`: integer arithmetic throughout, the low `NONCE_DIGITS`
  raw cleared so the nonce cannot overlap the price, round-down in the payer's favour, no float on
  any amount anywhere.
- `verify`'s refusals: `quote_invalid` for a missing or forged quote and for a quote carrying no
  nano offer; `proof_pending` for a `confirmed` that is neither `true` nor `"true"`;
  `proof_invalid` for a wrong destination, a non-`send` subtype, an inexact amount, or a signature
  answer that is not exactly `true`. `canonicalHash` upper-casing, so the payer cannot choose the
  identity of their own payment.
- `payableOf` reading the amount from the quote's own offer and never from a live rate.
- The construction guards (`verifier`, `signer`, the removed `onSettled`).
- The README's claims against the code, including its published test counts.

Nothing new to fix on that path this run.

## The one defect found was already filed, by another routine, before this run

**A refund whose reply was lost is sent a second time**, so one payment can leave the merchant's
account twice, irreversibly. Reproduced here independently before #21 was read - against the fake
network, one failed handler and a `sendFor` that publishes its send and then throws:

    after pass.complete('failed')   sendFor calls: 1   reverse sends on chain: 1
    after toll.reconcile()          sendFor calls: 2   reverse sends on chain: 2

The mechanism: `refund` (`src/nano-rail.ts:499-505`) reports a throwing `sendFor` as
`PROVIDER_UNAVAILABLE` - correctly, since the block may have been published and only the reply
lost - so the charge reaches `unknown` with `pending: refund`, and core's `resolveUnknown`
(`tollstile/dist/chunk-YOBXHQZK.js:1350-1393`) calls `performRefund` again for **both** answers
this rail's `lookup` can give it, `settled` and `none`. Only `refunded` would stop it, and `lookup`
cannot return that: `NanoRpcRead` is a `blockInfo(hash)` read of the *payment* block, with no way
to search the merchant's account for a reverse send.

**`dhyabi2/tollstile-rail-nano#21` already fixes it** ("Fix 0.3.2 release blockers: empty npm
package, nonce regression, double refund on reconcile", opened 2026-10-13 05:27Z), and more
thoroughly than the documentation-only change this run had prepared: an in-process refund record
(`in_flight` / `failed` / `sent`), a `RefundNotSentError` (branded `notBroadcast === true`) for the one case that is safe to
retry automatically, `forgetRefund(hash)` as the operator's escape hatch, and the `refundOf`
idempotency requirement stated in the README. The branch prepared here
(`fix/refund-retry-idempotency`) is superseded by it and **no pull request was opened for it**;
this note is all that is left of it, so that the finding and its measurement are on the record
twice and the branch is not mistaken for unfinished work.

One measurement from that branch is worth keeping, because #21's own comment notes that its record
"lives with this rail instance; a reconcile run from a fresh process relies on the signer honouring
`refundOf`": the arguments `sendFor` receives are **identical on both attempts** - same
destination, same `amountRaw`, same `refundOf` - so `refundOf` (the payment's block hash,
single-use in core's ledger) really is a usable idempotency key for that cross-process path.

## Could not verify

- Nothing against the live Nano network: the suite runs entirely on the fake provider, and
  `examples/rpc-network-check.mjs` was read but not run (it needs a public node, and `rpc.nano.to`
  refuses this container's address).
- Whether any deployed signer is in fact non-idempotent today. The hazard is in the contract; who
  is exposed depends on deployments this repository cannot see.

## Note on reconciliation tests, for whoever writes the next one

`reconcile` reads charges last updated strictly **before** `now - olderThanMs`, and core stamps
`updatedAt` from `runtime.clock.now()` - the clock passed to `createTollstile`, or the system clock
when none is. At `olderThanMs: 0` a charge written in the same millisecond as the call falls
outside the window and is never examined - a test built that way passes alone and fails in the
full file. Two setups do work. A `fakeClock` passed to `createTollstile({ clock: fakeClock() })`
stamps the ledger with the same fake time, so advancing it past the window (`clock.advance(60_000)`
then `reconcile({ olderThanMs: 1_000 })`) examines the charge deterministically; without the
advance, nothing is examined. On the real clock, a negative window (`olderThanMs: -1_000`) puts the
boundary just after the charge.
