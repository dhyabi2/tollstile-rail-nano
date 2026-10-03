# tollstile-rail-nano — code audit, 2026-10-03

Clone of `master` at `e649926`, fresh `npm ci`. Baseline, and unchanged after this run because nothing
in the code needed changing:

```
$ npm ci              # exit 0
$ npm run build       # tsc -p tsconfig.build.json, clean
$ npm run typecheck   # tsc --noEmit, clean
$ npm test            # 33 passed | 2 skipped (35), 2 files
$ npm run lint        # eslint, clean
```

Lens: can an agent get paid in XNO through this rail today, without being hurt. **No defect found.**
This run went after the two things earlier audits had not driven end to end: the amount arithmetic,
and whether a plain-HTTP payer (not an MCP one) is given everything it needs to produce a valid proof.

## Checked

**The amount path, in integer arithmetic throughout.** `parseRate` → `toRaw` → `payableFor` →
`verify`'s exact comparison. No float touches an amount: rates are parsed into
`{digits: bigint, decimals: number}` and a `number` rate is read through `String(n)` with
`expandExponent`, so `1e-7` and `0.30000000000000004` both arrive as exact decimal text. Re-derived
`toRaw` independently: `raw = micros × digits × 10^(24 − decimals)`, which is
`USD × xnoPerUsd × 10^30`, matching the documented meaning of `xnoPerUsd`. The low-digit layout holds:
`toRaw` clears the low 10 digits (`(exact / 10^10) * 10^10`) and `nonceIntOf` returns a value in
`[0, 10^10)`, so price and nonce cannot overlap for any rate precision. A price that rounds below one
nonce modulus yields `0` and `offer` returns `null` rather than a free offer.

**Whether a plain-HTTP payer can sign the right message.** `challenge` puts `nonce: quote.nonce` in
the MCP `_meta` payload but **not** in `accepts`, which is what an HTTP payer reads — so on the face of
it an HTTP payer is never told what to sign, while `verify` requires a signature over `quote.nonce`.
Read core's 402 construction to settle it (`node_modules/tollstile/dist/chunk-YOBXHQZK.js:1101-1117`):
the body core emits carries `nonce: quote.nonce` at the top level, beside `quote` and `expiresAt`.
The HTTP payer does get the nonce. **Not a defect.**

**`verify`'s refusal ordering**, against the rule that a final refusal after the payer's XNO has moved
is the worst outcome. Every refusal is either recoverable with the same block (`proof_pending` is
retryable; a missing signature or a missing/expired quote token can be re-presented with the same
unspent block, since the charge was never admitted) or is a block that genuinely did not pay this
quote. The two ways to throw — `rpc.blockInfo` and the operator's `verifier` — are both wrapped as
`PROVIDER_UNAVAILABLE`, i.e. retryable, deliberately not `proof_invalid`.

**Tamper resistance of the quote token.** `runtime.quotes.open` (same chunk, line 1204+) is defensive
on every path — length cap, split arity, base64url decode, constant-time HMAC compare over the
rotating secret set — and returns `undefined` rather than throwing, so a forged `x-nano-quote` reaches
the rail as `quote_invalid` and not as an exception.

**Construction-time fail-closed checks**: a missing/unusable `verifier`, an unusable `signer`, and the
removed `onSettled` hook all throw `CONFIG_INVALID` before any payment can exist. Each has a test.

**The 26 unit tests read for an assertion that asserts the wrong thing.** None found. The suite
covers a wrong amount, a right amount paid to somebody else, a receive presented as a send, an
unconfirmed block, a wrong signature, a throwing verifier, a rate that moves between quote and
verify, replay and `Idempotency-Key` retries counted raw, the MCP `_meta` path, the empty-header
fallback, and — `test/rail.test.ts:761` — the README's own published conformance counts against the
counts the suite actually produces.

## Observations, deliberately not changed

- **`xnoPerUsd: "0.0123"`** is the example value in the README's install snippet, in the type doc and
  in `rateError`'s message. The semantics are right (`XNO = USD × xnoPerUsd`), but `0.0123` is not a
  plausible XNO/USD rate in either direction — it implies 1 XNO ≈ $81. It is clearly a placeholder and
  the field is required with no default, so an operator must supply their own; changing a sample value
  in three places is wording, not a fix.
- **A merchant address written in a different form than the RPC returns** (`xrb_` versus `nano_`, or a
  different case) makes `block.destination !== merchant` refuse a correctly paid block,
  `proof_invalid`, after the XNO has moved. This needs operator misconfiguration to reach, and
  normalising the comparison would mean accepting addresses the operator did not literally configure —
  a behaviour change with its own risk. Recording it rather than changing it.
- **`src/nano-provider.ts` carried two hardcoded ED25519 PEM private keys** at `e68ac259`
  (2026-09-24). They are the *fake* conformance provider's "payer" and "other payer" keys for
  `nano_1fakepayer0000…`: they control no real Nano account and no XNO, and the current provider uses
  HMAC-seeded fake signatures instead, so nothing is in the tree today. The commit is **not** an
  ancestor of `master`; it survives only on the stale remote branch
  `origin/ivy/tollstile-nano-security-fix`, which this routine did not create and will not delete.
  Flagged to the owner as housekeeping, not as a credential leak.

## Could not verify

- **The README's two external links** (`https://nano.org`, `https://tollstile.com`) and the
  marketplace/RPC hosts. This session's egress proxy answers `CONNECT … 403` for every host outside
  its allow-list, so neither was reached. They are the only two URLs in the repository.
- **`examples/rpc-network-check.mjs` against the live network.** `rpc.nano.to` is not reachable from
  here. Its read model is held to a recorded response by `test/rail.test.ts:629`, which passes, but the
  recorded-versus-live question is still open and still wants one run with open egress. Unchanged since
  the 2026-09-27 note: the public Test Network (`test.nano.org`) still has not been exercised end to
  end, so the send/verify/refund path has only ever run against the fake provider.

## Open from earlier runs, still the owner's call

- **PR #11** — a refund signer that throws escapes the operator's `complete()`. Open since 2026-10-01.
  It is in `refund`, which is code that sends money, so this routine does not merge it.
