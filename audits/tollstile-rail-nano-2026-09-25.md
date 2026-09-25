# tollstile-rail-nano — code audit, 2026-09-25

Scope: the tree at `845f342` (`master`), which now carries the fail-closed
verifier fix merged as PR #1. Re-read `src/nano-rail.ts`, `src/nano-types.ts`
and `src/nano-provider.ts`, both test files, `package.json` and `README.md`,
and compared the tree against what npm currently serves.

## How it was checked

```
npm ci            # clean
npm test          # 18 passed (2 files)   <- baseline
npm run typecheck # clean
npm run build     # clean
npm audit --omit=dev   # found 0 vulnerabilities
npm install && npm test   # from a fresh copy with no node_modules: 18 passed
```

The last line was run because the 2026-09-24 audit noted that `tollstile` is a
peer dependency with no `devDependencies` entry, and wondered whether the
README's own instruction (`npm install` then `npm test`) works for a
contributor. It does: npm installs peer dependencies automatically, and
`tollstile@0.1.2` resolves and the suite passes from a clean tree. That note can
be retired.

## Found and fixed

**The README's conformance result was stale again.** It claimed "**17 passed**
… (9 rail unit tests + 8 conformance tests)"; the suite is 18 (10 + 8), because
merging the fail-closed fix added a rail test and the README was not updated
with it. That number has now been wrong twice — at 15, and at 17 — and the
README is addressed precisely to the reader most likely to notice, since it
tells a Tollstile maintainer to run `npm test` and compare.

So this fixes the number and also stops it going stale silently. A new rail test
counts the `it(` cases in both test files and compares them against the three
numbers the README publishes. Against the old README:

```
AssertionError: README rail unit test count: expected 9 to be 11
Tests  1 failed | 18 passed (19)
```

The law counts itself, so the corrected figure is **19 passed (11 rail unit
tests + 8 conformance tests)** — the suite that changes is now the suite that
reports the mismatch.

## Urgent, and NOT fixable from this repository

**The npm package still carries the vulnerable verifier guard.** The fail-closed
fix is merged in git but has never been published, and `package.json` is still
at `0.3.1` — the version already on the registry, so it cannot be published
without a bump. What `npm install tollstile-rail-nano` serves today:

```
$ npm pack tollstile-rail-nano@latest && tar -xzOf ... package/dist/nano-rail.js
147:    if (options.verifier === undefined) {
148:        throw new TollstileError('CONFIG_INVALID', 'nanoRail requires a verifier ...');
```

against the repository's

```
if (options.verifier === undefined || options.verifier === null
    || typeof options.verifier.verify !== 'function') {
```

Registry `version` is `0.3.1`, `time.modified` 2026-09-24T10:11:10Z — before the
fix landed. So an operator installing from npm still gets a rail that accepts
`null`, `{}` or a string as its verifier, constructs successfully, and then dies
with a `TypeError` inside `verify` — after the payer's block has confirmed
on-chain. The payer has paid and receives a 500.

Neither half of the remedy is this audit's to perform: a version bump is a
release decision, and publishing goes through the swarm's own rail with its
secret scan. Both are reported to the owner.

## Checked and clean

- No secrets in the tree or in `dist/`.
- `npm audit --omit=dev`: 0 vulnerabilities.
- The fail-closed check is real and pinned: the rail refuses `undefined`,
  `null`, `{}`, a string and `{ verify: 'not a function' }` at construction, and
  still constructs for a usable verifier.
- The security properties the README claims are each exercised through core —
  exact-amount-per-quote, proof-of-possession, replay, and rate-locked-at-quote.
- `toRaw`'s rate normalisation was re-read rather than re-measured this run (the
  2026-09-24 audit exercised it over 95 rate × price cases). Both exponent
  branches and the trailing-zero strip were checked by hand against the cases
  that matter: an integer-valued rate with no decimal point is not stripped,
  which is the one that would silently divide a rate by a power of ten.
- `redact()` drops the payer signature and keeps only public block facts.

## Noted, not changed — unchanged from 2026-09-24

- `block.destination !== merchant` is a strict string compare, and a Nano
  account has two canonical encodings (`nano_` and legacy `xrb_`). Whether an
  operator's adapter can return the other form is not decidable from this
  repository, so it stays a note. `block.amountRaw !== expectedRaw` likewise
  compares numeric values as strings.
- `payableOf()` does `BigInt(offer.details?.amountRaw as string)` with no guard
  for a missing `details`; `BigInt(undefined)` throws a `TypeError` that would
  escape `verify` as a 500 rather than a rail error code. It is guarded one line
  earlier for a missing offer but not for an offer without details. Whether core
  can produce that shape is not decidable from here.
- `nano-provider.ts` mints every fake block hash with a `fail_` prefix
  (`hashFor('fail_')`), including the ones standing in for successful payments.
  Cosmetic, in a test-only module, and it reads like a leftover — but changing
  it touches no behaviour, so it is left for the owner rather than churned here.

## Not verified here

- The two README links (`nano.org`, `tollstile.com`) again could not be fetched:
  this sandbox's egress proxy denies both hosts. Unverified, not known bad.
- Nothing was published, and no version was bumped.
