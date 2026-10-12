# tollstile-rail-nano — audit 2026-10-12

Lens: can an agent pay in XNO through this rail today without being hurt?

Starting point: `master` at `46d41f3`. `npm ci && npm test` → **77 passed, 2 skipped**;
`npm run lint`, `npm run typecheck` and `npm run build` all clean, before and after.

## What I checked

- The whole `verify` path in `src/nano-rail.ts`, gate by gate: quote present and openable →
  exact payable from the quote's own offer → `block_info` → `confirmed` → destination and
  subtype → **exact** amount → proof-of-possession over the quote nonce from the block's
  source. All seven refusals are in place and each is held by a named test.
- Amount arithmetic end to end. `bigint` only: `parseRate` takes an exact decimal (expanding
  an exponent before `BigInt`), `toRaw` scales by powers of ten and floors to a multiple of
  `10^10` raw so the nonce digits can never overlap the price, and `payableFor` refuses an
  amount that is not `/^\d+$/`. No float reaches an amount anywhere on the path. An offer
  that would round to `0` returns `null` rather than a free pass.
- The rate is read in exactly one place (`offer`), and `verify` reads the amount back out of
  the quote — so a rate that moved after the quote cannot refuse a payer who sent what was
  challenged. Re-confirmed by reading every caller of `currentRate`.
- `canonicalHash` upper-cases before the hash becomes `proofId`/`idempotencyKey`, so one send
  cannot be presented twice under two casings (#15). Still correct.
- The two truthiness reads the 10-10 audit fixed (`verify` and `lookup` on `confirmed`) are
  both still exact reads, with their `it.each` tables intact.
- `nano-provider.ts:112` reads `block.confirmed` for truthiness and is still correct as is:
  it is the in-repository fake, written only by `confirmedSend` with a real boolean.

## Found and fixed — the law that guards the README's published number could not see two
thirds of the suite

`test/rail.test.ts`'s own law, *"the conformance result the README publishes is the result
this suite produces"*, exists because that number "goes stale every time a case is added --
it has now been wrong twice, at 15 and at 17" (its own comment). It counted cases with

```js
readFileSync(file).match(/^\s*it\(/gm).length
```

which counts `it(` **lines**. An `it.each([...])` block is one line and many cases. By
`0.3.2` this file holds **seven** `it.each` tables, expanding to 34 extra cases:

```
regex count (^\s*it\()          : 36
cases the runner actually runs  : 70     (36 + 6+5+6+4+6+2+5)
README publishes                : 36 passed
npm test prints                 : 70 passed
```

So the README's `Rail unit tests: **36 passed**` was wrong by 34, and the guard whose entire
purpose is to report exactly that mismatch stayed green — including across the 10-10 audit,
which added six `it.each` cases and bumped the README from 34 to 36 by hand. A Tollstile
maintainer following the README ("run `npm test` and compare") sees 70 against a published
36 and has no way to tell a healthy suite from a broken one.

**Fix:** the law now counts the runner's own collected leaf tasks
(`ctx.task.file.tasks`, walked recursively) instead of matching source lines. That is the
number `npm test` prints, by construction, so no `it(` spelling can hide from it again.
The README's claim is corrected to **70 passed**.

**Failing-then-passing:** with the repaired law and the README still saying 36 —

```
AssertionError: README rail unit test count: expected 36 to be 70
Test Files  1 failed (1)
```

The old regex law reports nothing in that same state, which is the defect. With the README
corrected: **77 passed, 2 skipped**; lint, typecheck and build clean.

No production file is touched. No refusal, amount, destination, rounding or key path moves.

## Checked and left alone — deliberately

- **`lookup` reads the original payment block, not the reverse send.** After a refund send
  throws, core reconciles `unknown` by calling `lookup`, which reports the *payment* as
  settled — the refund's own hash was never returned, so there is nothing else it could
  read. The honest answer is "the payment stands"; the residual risk (the reverse send
  landed and only the reply was lost, so a later reconciliation could refund twice) is
  inherent to a rail with no chargeback and is already named in `refund`'s comment. Any
  change here is a decision about the refund path, not a correction, so it is not mine to
  make and is listed for the owner below.
- **The presented hash is not shape-checked** before it reaches `rpc.blockInfo` — any
  non-empty string is upper-cased and passed through. I could not demonstrate harm: the
  operator's own RPC client is inside their trust boundary, an unknown hash returns
  `undefined` → `proof_invalid`, and a throw is wrapped as `PROVIDER_UNAVAILABLE`. Noted,
  not patched, because a refusal with no demonstrated failure is a feature.

## Could not verify

- No live RPC call was made from here; `rpc.nano.to` refuses this container's address (the
  `429 (api_key_required_for_heavy_usage)` recorded in sibling repositories). Every network
  premise in this audit is the one `examples/rpc-network-check.mjs` already documents in the
  tree, not a fresh measurement.
- Core (`tollstile`) itself is a dependency and was exercised only through the conformance
  suite and these unit tests.
