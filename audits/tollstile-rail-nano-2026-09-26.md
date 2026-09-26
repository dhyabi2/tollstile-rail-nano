# tollstile-rail-nano — code audit, 2026-09-26

Scope: the tree at `9fe81ea` (`master`). This run went after the parts the two
previous audits had read but never *executed*: the README's Install snippet and
`examples/rpc-network-check.mjs`. Re-read `src/nano-rail.ts`, `src/nano-types.ts`
and `src/nano-provider.ts`, both test files, `package.json` and `manifest.json`.

## How it was checked

```
npm ci                 # clean
npm test               # 19 passed (2 files)   <- baseline
npm run typecheck      # clean
npm run build          # clean
npm audit --omit=dev   # found 0 vulnerabilities
```

## Found and fixed

**The README's Install snippet does not run. It throws on the user's first
line.** `nanoRail` declares `livemode: true` (`src/nano-rail.ts:202`), and
Tollstile core refuses a live rail that has no quote secret. The snippet passes
`rails` and `ledger` and nothing else, so:

```
$ node readme-snippet.mjs          # the snippet, placeholders filled with stubs
TollstileError: Live rails need `secret` to sign quotes. Use at least 32 random
characters from your secret store.
    at secretsFor (node_modules/tollstile/dist/chunk-YOBXHQZK.js:1516:13)
    at createTollstile (node_modules/tollstile/dist/chunk-YOBXHQZK.js:1433:31)
    at readme-snippet.mjs:6:14
  code: 'CONFIG_INVALID'
```

Nothing Nano-specific is reached: it dies inside `createTollstile`, before a
quote, a challenge or an RPC call. `TollstileConfig.secret` is documented in
core's own types as "Required with live rails", and the README is the only code
a new user copies — and it ships inside the npm tarball, since `package.json`
carries `files: ["dist", "README.md"]`. The published `0.3.1` tarball's README
contains **zero** `secret:` lines, so every operator installing from npm today
reads a snippet that cannot start.

The suite could not have caught it: all four `createTollstile` calls across
`test/rail.test.ts` and `test/conformance.test.ts` pass a `secret` of their own,
so the configuration a user is shown was the one shape never constructed.

Fixed by adding `secret` to the snippet, sourced from the environment rather
than written as a literal, with a comment naming the error it prevents.

Proved rather than asserted. A new rail law reads the README's own `ts` fence,
builds the instance it describes, and passes `secret` **only when the snippet
does** — so the README decides whether the construction succeeds. Against the
unfixed README:

```
FAIL test/rail.test.ts > the README install snippet constructs a Tollstile that can price
TollstileError: Live rails need `secret` to sign quotes.
 ❯ createTollstile node_modules/tollstile/dist/chunk-YOBXHQZK.js:1433:31
 ❯ test/rail.test.ts:262:18
```

With the fix, and the corrected snippet run as a standalone script the way a
user would run it:

```
$ TOLLSTILE_SECRET=... node readme-snippet2.mjs
the corrected snippet constructs and prices: true
$ npm test
20 passed (20)          # 12 rail unit tests + 8 conformance
$ npm run typecheck && npm run build
clean
```

Adding a case moved the README's published conformance figure again (19 → 20,
11 → 12 rail tests); the existing self-counting law caught that in the same run
and both numbers are corrected here.

## Urgent, and NOT fixable from this repository — unchanged from 2026-09-25

**npm still serves a package with the vulnerable verifier guard, and now also
with the unrunnable install snippet.** Re-checked against the registry today:

```
dist-tags: {'latest': '0.3.1'}
time.modified: 2026-09-24T10:11:10.947Z
local package.json version: 0.3.1
```

`time.modified` is still before the fail-closed verifier fix landed, and the
local version is the one already on the registry, so nothing can be published
without a bump. An operator running `npm install tollstile-rail-nano` today
gets a rail that accepts `null`, `{}` or a string as its verifier and then dies
with a `TypeError` inside `verify` — after the payer's block has confirmed
on-chain, so the payer has paid and receives a 500. A version bump is a release
decision and publishing goes through the swarm's own rail with its secret scan;
neither is this audit's to perform. Reported to the owner again.

## Checked and clean

- No secrets in the tree, in `dist/`, or in the audit notes. `git grep` over the
  tracked tree turns up no key, seed, token or `.env`; the only long hex literals
  are a public block hash and an account in `examples/`.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `manifest.json`'s claim that "the published package is dependency-free at
  runtime, importing only 'tollstile' (peer) and 'node:crypto'" holds: those are
  the only two non-relative imports anywhere in `src/`.
- The four symbols the Install snippet imports — `createTollstile`,
  `memoryLedger`, `nanoRail`, and core's `Ledger` shape behind `memoryLedger()` —
  all resolve against `tollstile@0.1.2`, which is what the lockfile pins and what
  the registry still lists as latest.
- `toRaw`'s rate normalisation was re-read (the 2026-09-24 audit measured it over
  95 rate × price cases). The trailing-zero strip is guarded by `dot !== -1`, so
  an integer-valued rate such as `20` is never stripped — the case that would
  silently divide a rate by a power of ten.
- The fail-closed verifier check still refuses `undefined`, `null`, `{}`, a
  string and `{ verify: 'not a function' }` at construction.

## Noted, not changed

- **Three of `verify`'s guards have no test.** `block.destination !== merchant`
  (a send to somebody else), `block.subtype !== 'send'` (a receive or open block
  presented as payment) and `!block.confirmed` (→ `proof_pending`) are each
  correct by reading, but the fake provider cannot produce any of those shapes:
  `nano-provider.ts:67` fixes `subtype: 'send' = 'send'` and `pay()` always sends
  payer → merchant. So the first two guards — the ones that stop a payer
  redeeming an unrelated block — are unexercised. Nothing is demonstrably wrong,
  which is why nothing is changed here; widening the fake is a change to the
  test-only module and belongs in its own pull request.
- `payableOf()` does `BigInt(offer.details?.amountRaw as string)` with no guard
  for a missing `details`; `BigInt(undefined)` throws a `TypeError` that escapes
  `verify` as a 500. Guarded one line earlier for a missing offer but not for an
  offer without details. Whether core can produce that shape is not decidable
  from this repository. Carried from 2026-09-24.
- `block.destination !== merchant` and `block.amountRaw !== expectedRaw` are
  strict string compares; a Nano account has two canonical encodings (`nano_`,
  legacy `xrb_`) and an amount could be padded differently by an adapter.
  Adapter-dependent, so still a note. Carried from 2026-09-24.
- `nano-provider.ts` mints every fake block hash with a `fail_` prefix, including
  the ones standing in for successful payments, and `hashFor()` returns 37
  characters where a Nano hash is 64. Test-only and cosmetic. Carried.

## Not verified here

- `examples/rpc-network-check.mjs` could not be exercised: `rpc.nano.to` answers
  **HTTP 403** through this sandbox's egress proxy, which is indistinguishable
  from here from the script being wrong. Unverified, not known bad.
- The two README links (`nano.org`, `tollstile.com`) again could not be fetched —
  both return no response through the proxy. Unverified, not known bad.
- Nothing was published and no version was bumped.
