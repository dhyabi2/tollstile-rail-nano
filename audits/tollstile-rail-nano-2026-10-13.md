# tollstile-rail-nano - audit 2026-10-13

Base: `0837429` (main, "the README count law counted it() lines, not the cases that run (#20)").
`npm ci && npm test && npm run build` before any change: **77 passed, 2 skipped** (9 conformance,
70 rail unit), build clean, eslint clean.

## Checked

- The whole XNO receive path: `offer` -> `challenge` -> `verify` -> `settle` -> `receipt`, and the
  two reads core comes back to, `lookup` and `refund`.
- `parseRate` / `expandExponent` / `toRaw`: integer arithmetic throughout, the low
  `NONCE_DIGITS` raw cleared so the nonce cannot overlap the price, round-down in the payer's
  favour, no float on any amount.
- `verify`'s refusals: `quote_invalid` for a missing/forged quote and for a quote with no nano
  offer, `proof_pending` for `confirmed` that is neither `true` nor `"true"`, `proof_invalid` for
  a wrong destination, a non-`send` subtype, an inexact amount, or a signature that is not
  exactly `true`. `canonicalHash` upper-casing so the payer cannot choose their payment's
  identity.
- `payableOf` reading the amount from the quote's own offer and never from a live rate.
- The construction guards (`verifier`, `signer`, the removed `onSettled`).
- The README's claims against the code, including the published test counts.

## Found, documented (no code change)

**A refund whose reply was lost is sent a second time, so one payment can leave the merchant's
account twice.**

`src/nano-rail.ts:499-505` reports a throwing `signer.sendFor` as `PROVIDER_UNAVAILABLE`, and the
comment there is right about why: the block may have been published and only the reply lost, so
`rejected` would assert the money did not move. The consequence is that the charge reaches
`unknown` with `pending: refund`, and core's `resolveUnknown`
(`node_modules/tollstile/dist/chunk-YOBXHQZK.js:1350-1393`) calls `lookup` and then
`performRefund` for **both** answers this rail can give it, `settled` and `none`. Only `lookup`
returning `refunded` stops the retry, and `lookup` (`nano-rail.ts:508-530`) cannot return it:
`NanoRpcRead` is a `blockInfo(hash)` lookup of the *payment* block, with no way to search the
merchant's account for a reverse send that may or may not exist.

Measured against the fake network, one failed handler and a `sendFor` that publishes its send and
then throws:

    after pass.complete('failed')   sendFor calls: 1   reverse sends on chain: 1
    after toll.reconcile()          sendFor calls: 2   reverse sends on chain: 2

The payer is refunded twice off one payment, irreversibly. The existing test
`a refund signer that throws leaves the charge reconcilable...` stops at the first failure and its
own comment anticipates this case ("would ... invite a second reverse send") without covering it.

The rail cannot close this from inside, and widening `NanoRpcRead` to search an account history
would be a new capability, not a fix. What closes it is the key the rail already hands the signer:
`context.refundOf` is the payment's block hash - single-use in core's ledger, so one refund per
payment - and the arguments are **identical on both attempts**, measured and now pinned. So the
contract is documented where an operator reads it (`NanoSigner.sendFor` in `src/nano-types.ts`, and
the README's "Refunds: read this first"): `sendFor` must be idempotent per `refundOf`.

**There is no failing-then-passing evidence for this item, because there is no code change.** The
two new tests both pass on the unmodified rail; they are regression cover for the documented
contract, not a fix:

- `a refund whose reply was lost is sent again, with identical arguments` - pins the two on-chain
  reverse sends and asserts the two `sendFor` calls received the same destination, amount and
  `refundOf`. If `refundOf` ever stopped being stable across attempts, a signer written against
  the documented contract would silently double-refund again.
- `a signer that dedupes on refundOf refunds exactly once across the retry` - the control: one
  reverse send, and the charge reaches `refunded`.

Both use `RECONCILE_NOW` (`olderThanMs: -1_000`). At `olderThanMs: 0` a charge written in the same
millisecond as the call falls outside `reconcile`'s window and is never examined, which made the
test pass alone and fail in the full file; the negative window removes the race.

README's published `Rail unit tests: **70 passed**` is now 72, as its own count law requires.

## Could not verify

- Nothing against the live Nano network: the suite runs entirely on the fake provider, and the
  one real-RPC example (`examples/rpc-network-check.mjs`) was read but not run (it needs outbound
  access to a public node, and `rpc.nano.to` refuses this container's address).
- Whether any operator's `sendFor` is in fact non-idempotent today. The hazard is in the contract;
  who is exposed to it depends on deployments this repository cannot see.
