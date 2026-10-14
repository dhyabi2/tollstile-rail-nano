# tollstile-rail-nano — audit 2026-10-14

Lens: can an agent pay in XNO through this rail today without being hurt?

Starting point: `master` at `0837429`. `npm ci && npm test` → **77 passed, 2 skipped**;
`npm run lint`, `npm run typecheck` and `npm run build` all clean, before and after.

## What I checked

- Every option `nanoRail` is constructed from, against the three guards already in the file.
  `verifier`, `signer` and the removed `onSettled` each fail closed at construction, each for
  the written reason that the published package is JavaScript and the alternative is learning
  of it after the payer's block has confirmed. `merchantAccount` had no guard at all.
- `verify` gate by gate: quote present and openable → exact payable from the quote's own offer
  → `block_info` → `confirmed` (exact read, both `true` and `"true"`) → destination and
  subtype → exact amount → proof-of-possession over the quote nonce from the block's source.
  All seven refusals in place, each held by a named test.
- Amount arithmetic end to end: `bigint` only. `parseRate` expands an exponent before
  `BigInt`, `toRaw` scales by powers of ten and floors to a multiple of `10^10` raw so the
  nonce digits cannot overlap the price, `payableFor` refuses anything not `/^\d+$/`. No float
  reaches an amount. An offer that would round to `0` returns `null`, not a free pass.
- The refund-reconciliation path, read against core's own code in
  `node_modules/tollstile/dist/chunk-YOBXHQZK.js`. `lookup` looks up the PAYMENT block, not the
  reverse send, which initially read like a defect. It is correct: `resolveUnknown` treats both
  `settled` and `none` as "retry the refund" when `charge.pending === 'refund'`
  (`performRefund` on either branch), so reporting the payment still settled cannot strand a
  refund. No change.
- `canonicalHash` upper-cases before the hash becomes `proofId`/`idempotencyKey` (#15), and the
  two `confirmed` truthiness reads #18/#19 fixed are both still exact. Still correct.
- The README's published conformance and unit-test numbers against what the runner prints.

## Found and fixed — the destination of every payment was never validated

`nanoRail` fails closed at construction for `verifier`, for `signer` and for a leftover
`onSettled`. `merchantAccount` — the account every payment this rail asks for is sent to — was
taken on trust. It reaches three places: `offer` puts it in `details.to`, `challenge` copies
that into `accepts.to` and `mcp.to`, and `verify` compares `block.destination` against it.

README's own Install snippet is `process.env.NANO_MERCHANT_ACCOUNT!`. The `!` is a TypeScript
non-null assertion: it silences the compiler and does nothing at runtime. Measured on the
unmodified tree with that variable unset, the rail was built from `undefined` without a word,
and the 402 it then served a paying agent carried:

```
challenge kind      : denied
accepts.to          : undefined
mcp.to              : undefined
accepts.amountRaw   : 10000000000000000008166705475
```

An amount and **no destination**. And the destination check inside `verify` goes vacuous in
that state — `block.destination !== merchant` compares `undefined` to `undefined`, which is
false — so against a provider echoing the same blank, the payment was **admitted**:

```
after paying        : admitted
```

Against a real RPC, which returns a real address for a real block, that same comparison is
true instead and **every** payment is refused `proof_invalid` after the payer's send has
confirmed on-chain, where Nano has no chargeback. `''`, `'not-an-address'` and `'nano_TYPO'`
all constructed silently by the same route and land in the same place.

**Fix:** one added refusal at construction — `merchantAccount` must be a string matching
`nano_`/`xrb_` then 60 characters of Nano's base32 alphabet, else `CONFIG_INVALID`. It narrows
what is accepted and nothing else: no amount, destination, rounding, address comparison or key
path is touched, and no existing refusal is removed or widened. Both live prefixes still
construct, and the README snippet is annotated with what the `!` does not do.

**Why no test could have caught it:** the suite's own merchant fixture,
`nano_3merchant` + 52 `a`s, is **61 characters** after the prefix — not a Nano address. So
"is the merchant account an address?" was never a question these tests could ask. Both
constants (`test/harness.ts:6`, `test/rail.test.ts:18`) are corrected to 60 characters, which
is the whole of the non-guard diff.

**Failing-then-passing:** with the new test in place and the guard alone deleted (the 23 added
lines in `nanoRail`, nothing else), exactly one test fails —
`nano rail > fails closed at construction for a merchantAccount that is not a Nano address`,
`AssertionError: expected [Function] to throw an error` — and the other 77 pass. With the
guard: **78 passed, 2 skipped**, `lint`, `typecheck` and `build` clean. The twelve refused
shapes include the unset env var of README's snippet, an empty string, a one-short and a
one-long address, an upper-cased one, a `2` outside the base32 alphabet, and a leading space
from a config file.

The README count law added on 10-12 earned itself here: it failed on the stale `70` the moment
a test was added, which is exactly what it was written to do. Corrected to `71`.

## Could not verify

- **The checksum, not just the shape.** The five-byte blake2b digest at the end of a Nano
  address is the only thing that catches a single mistyped character, and `node:crypto`
  exposes `blake2b512` but no 40-bit blake2b, so it is not reachable without adding an
  implementation. A well-shaped typo therefore still passes construction and is refused at
  `verify` — after the payer paid. Named in both the guard's comment and the README.
  `nano-accept-settle` does check the checksum (`valid_nano_address`, pure Python blake2b);
  porting that reasoning here is a change worth its own pull request, not a line in this one.
- **`nano_` vs `xrb_` at verify time.** `verify` compares `block.destination !== merchant` as
  exact strings. The two prefixes are two encodings of the same 32-byte public key, so an
  operator who configures `xrb_…` against a node that answers `nano_…` would have every
  correct payment refused after it confirmed. Construction now accepts both prefixes, so this
  is reachable. I did **not** fix it: the fix widens what `verify` accepts, which puts it
  outside a refusal-only change on the send path, and it wants a decision on whether the rail
  should normalise or simply require the `nano_` form. Left open deliberately — see the pull
  request.
- The fake provider's `payerAccount` is also not a well-formed address (59 characters, and it
  contains `0`, which is outside the alphabet). It is never validated by the rail — a source
  address comes from the chain, not from config — so it is left alone rather than churned.
- No live node was used. Everything above is against the in-repository fake and core's own
  published code.
