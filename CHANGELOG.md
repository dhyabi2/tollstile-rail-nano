# Changelog

Versions on npm: 0.1.0, 0.2.0, 0.3.0, 0.3.1. **0.4.0 is neither tagged nor published yet**; until it is, install from `master`:
`npm i "github:dhyabi2/tollstile-rail-nano#master"` (the `prepare` script builds `dist`). A `v0.4.0` tag will follow the merge of pull request #21.

**The existing git tag `v0.3.2` (`d519b58`) does NOT contain these fixes**: it is `master` before pull request #21, with the
nonce regression and without the refund guard. Do not install it. 0.3.2 was never published to npm.

## 0.4.0 (not yet on npm)

Everything on `master` since 0.3.1, plus the three release blockers from pull request #21. A minor version, not a patch:
it adds exports (`RefundNotSentError`, `forgetRefund`), changes `nanoRail`'s return type, makes `sendFor` results stricter
and changes the testing provider's hash shape (see the README, "Upgrading to 0.4.0").

- **Money-safety (every published version is exposed to the first two):**
  - One confirmed send could settle two charges, by block-hash letter case (#15, #16).
  - The merchant's refund could be sent twice (#17) and, on reconcile, again (release blocker 3, below).
  - An unconfirmed or unsigned block could be admitted as payment (#18); `lookup` read the confirmation for truthiness (#19).
- **Release blockers fixed on the #21 branch:**
  1. An empty npm package: `dist/` is gitignored and nothing built it. `prepare` builds it; `npm pack --dry-run` from a clean tree lists 17 files.
  2. A nonce regression: the tagged `v0.3.2` reduced the whole SHA-256 of the quote id, 0.3.1 its last 8 bytes, so every payable amount changed and
     quotes issued by 0.3.1 could not be paid after an upgrade. Restored; q_1 -> 8247539591 is pinned from the published 0.3.1.
  3. A double refund on reconcile: the rail now sends at most one reverse send per payment hash within a rail instance.
     A send that threw stays `unknown` and is not re-sent; `rail.forgetRefund(hash)` releases it deliberately.
     The record is per rail instance: a fresh process still re-sends unless the signer is idempotent on `context.refundOf`.
- Testing provider: `nanoProvider` from `tollstile-rail-nano/testing` now issues 64-hex block hashes beginning `FA11ED...`
  instead of `fail_...` strings; a test matching the `fail_` prefix must match the new shape.
- Known gap, not in this release: `merchantAccount` is not validated at construction (open pull request #22); an `xrb_` address or a mistyped one refuses every payment after it confirmed.
- Tests: 90 rail cases + 9 conformance (2 skipped by design) + 5 release laws at the time of writing (102 passed, 2 skipped); the README count is checked by a law.

## 0.3.1 (npm)

- AI-author disclosure in the README (Tollstile CONTRIBUTING, community rail). `repository` points at `dhyabi2/tollstile-rail-nano`.
- Real-network read-path check (`examples/rpc-network-check.mjs`).

## 0.3.0 (npm)

Fixes the Tollstile#49 review (see `docs/TOLLSTILE-49-RESPONSE.md`): rate locked at quote time (verify reads the quote's own offer),
`onSettled` removed from `verify`, the verifier is required and checked at construction, SHA-256 nonce with the strength stated honestly,
`repository` corrected, `.ledger/` removed.

## 0.2.0 (npm)

Proof bound to the purchase and its payer (Tollstile#47 review): exact per-quote amount, proof-of-possession over the quote nonce.
Its `repository` field (and 0.1.0's) pointed at an account that does not exist; fixed from 0.3.0.

## 0.1.0 (npm)

First standalone Nano rail.
