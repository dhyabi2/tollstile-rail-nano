# tollstile-rail-nano — audit 2026-10-01

Lens: can an agent pay a Tollstile-protected endpoint in XNO through this rail, today,
without being hurt? Eighth audit; the last seven are beside this file.

**Nothing worth changing was found. No code changed in this PR.**

## Checked

- `npm ci` clean, then all four of the repository's own gates, before and after reading
  (nothing changed, so they are the same run):
  - `npm test` — **33 passed, 2 skipped** (`conformance.test.ts` 7 passed / 2 skipped,
    `rail.test.ts` 26 passed)
  - `npm run build` — clean
  - `npm run typecheck` — clean
  - `npm run lint` — clean
- The XNO path end to end: `offer` → `challenge` → `verify` → `settle` / `refund` /
  `lookup` / `receipt` / `redact` in `src/nano-rail.ts`, the read model in
  `src/nano-types.ts`, and the example adapter in `examples/rpc-network-check.mjs`.
- **Amount handling — no float anywhere on an amount.** `parseRate` turns the rate into
  `{digits: bigint, decimals: number}`, expanding a JavaScript number's exponent through
  `String(n)` first so `BigInt()` never sees `"1e-7"`. `toRaw` is
  `micros × digits × 10^(24 − decimals)` in `BigInt`, then floored to a multiple of
  `10^10` so the nonce occupies the low digits and cannot collide with the price. The nonce
  is `SHA-256(quote.id) mod 10^10`, also `BigInt`. Amounts travel as decimal strings and
  are compared as strings built from `BigInt.toString()`.
- **Accept/refuse decisions.** `verify` returns `valid` only for a block that (1) carries a
  valid, unexpired, resource-matching quote; (2) exists; (3) is `confirmed`; (4) has
  `subtype === 'send'` to the merchant account; (5) pays the quote amount **exactly**, read
  from the quote's own nano offer and never recomputed from a live rate; and (6) carries a
  signature over `quote.nonce` from the block's own source account. I read
  `tollstile`'s `quotes.open` in `node_modules` to confirm the one claim the rail delegates
  rather than checks: it does verify the HMAC over the payload, `expiresAt`, and
  `quote.resource !== context.resource` — so the comment at `src/nano-rail.ts:356` is
  accurate and a quote bought at a cheap route cannot redeem an expensive one.
- Failure direction on the two things that can break after the payer's XNO has already
  moved: a throwing `rpc.blockInfo` and a throwing `verifier.verify` both surface as
  `PROVIDER_UNAVAILABLE` (retryable 503, block stays unspent and presentable), not as a
  final `proof_invalid`. Correct for an asset with no chargeback.
- Fail-closed construction: a missing, `null` or `verify`-less verifier, a `sendFor`-less
  signer, and the removed `onSettled` hook are all `CONFIG_INVALID` at construction, before
  any money can move.
- README claims against the code: the published conformance numbers (7 passed / 2 skipped)
  and unit count (26) match this run exactly — and `rail.test.ts` asserts both from the
  README text itself, as well as constructing the README's install snippet. The three URLs
  in the tree (`nano.org`, `tollstile.com`, `rpc.nano.to`) are the only ones; see below.
- Secret scan of the tree: none. No key, seed or signing material is held in this package —
  the operator passes `verifier` and `signer` in.

## Found

Nothing. The honest limits the README already states are still the right ones and are
stated plainly there: the ~33-bit amount nonce makes two quotes' amounts differ with high
probability, not with certainty (the binding rests on single-use block hashes plus
proof-of-possession, which is what the code does); and without a `signer` a failed handler
leaves the charge settled, which the README says before anything else.

## Could not verify

- The three URLs in `README.md` and `examples/` (`https://nano.org`,
  `https://tollstile.com`, `https://rpc.nano.to`). This session's network policy answers
  403 to CONNECT for all outbound hosts, so `examples/rpc-network-check.mjs` could not be
  run against the live network either. Its read model is still held to a recorded
  live-network response by `rail.test.ts` ("the example's read model maps a real live-network
  send block correctly"), which passes.
- The test-network end-to-end run the README calls out as not yet done. Unchanged: it needs
  a funded key, and the public Test Network endpoints in Nano's docs still have the problem
  the README records.
