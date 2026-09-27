# tollstile-rail-nano — code audit, 2026-09-27

Scope: the tree at `78ab878` (`master`). The 09-26 audit closed the README's install snippet and left
two things it had read but not decided: a note that three of `verify`'s guards are unexercised because
the fake provider cannot produce those block shapes, and a note about `payableOf`'s unguarded `BigInt`.
This run drove the rail with a **bespoke `rpc` stub** instead of the fake — which can return any block
shape without touching the shipped testing module — and that answered both notes and found a third
thing neither had looked at: the refund signer.

## How it was checked

```
npm ci                 # clean on the second attempt; see "Not verified"
npm test               # 20 passed (2 files)   <- baseline
npm run typecheck      # clean
npm run build          # clean
npm audit --omit=dev   # found 0 vulnerabilities
npm audit              # 5 vulnerabilities (3 moderate, 1 high, 1 critical) - all devDependencies
```

## Found and fixed

**`refund` guarded only `signer === undefined`, so an unusable signer surfaced as a `TypeError` after
the money had moved.** This is the same hazard PR #1 closed for the verifier, in the one place it was
not applied. `nanoRail` checks that the *verifier* is usable and not merely present, because the
published package is JavaScript and the option types are not enforced at runtime — but `options.signer`
was only compared against `undefined`, so `null`, `{}` or a half-built object survived construction and
died inside `refund`. Measured, by driving a real payment and then failing the handler:

```
signer=null                        complete('failed') THREW TypeError: Cannot read properties of null (reading 'sendFor')
signer={}                          complete('failed') THREW TypeError: signer.sendFor is not a function
signer={sendFor:'not a function'}  complete('failed') THREW TypeError: signer.sendFor is not a function
```

All three thrown out of the operator's own `pass.complete('failed')` call — that is, **after** the
payer's block has confirmed on-chain and **after** the handler has already failed. The operator
configured refunds, wanted the money to go back, and got an unhandled exception at the exact moment it
mattered; the payer has paid for a call that failed. A configuration mistake could not surface at a
worse point in the flow.

The suite could not have caught it: every `nanoRail` call in both test files passes the fake provider,
which is a usable signer, so the shape was never constructed.

**Fixed** by refusing it at construction, in the same style and for the same stated reason as the
verifier check. Omitting `signer` stays legal and unchanged — that is the documented "no refunds"
configuration the README's *Refunds: read this first* section is about — so no working configuration
changes; a crash becomes a `CONFIG_INVALID` at boot.

Against the unchanged `src/nano-rail.ts`:

```
FAIL test/rail.test.ts > fails closed at construction for a signer that is present but unusable
AssertionError: expected [Function] to throw an error
```

After, with the law also asserting that omitting a signer still constructs and that a *usable* signer
still refunds a failed handler by reverse send:

```
$ npm test
21 passed (21)          # 13 rail unit tests + 8 conformance  (24 after the guard tests below)
$ npm run typecheck && npm run build
clean
```

Adding a case moved the README's published conformance figure again (20 → 21, 12 → 13 rail tests); the
repository's own self-counting law caught that in the same run, as it is designed to, and both numbers
are corrected here.

## Answered from the 09-26 notes

**The three unexercised guards are all correct.** Driven with a bespoke `rpc` whose `blockInfo` returns
shapes the fake cannot produce:

```
destination = someone else   -> denied proof_invalid
subtype     = receive        -> denied proof_invalid
confirmed   = false          -> denied proof_invalid (detail "proof_pending", retryable true)
```

So the guards that stop a payer redeeming an unrelated block do refuse — and they are now **tested**, in
a second pull request kept separate from the money-path guard above. How much they were protecting is
worth recording: with those two lines deleted, all three cases are **admitted**.

```
$ # with `if (!block.confirmed) ...` and `if (block.destination !== merchant || subtype !== 'send') ...` removed
× rejects a confirmed send of the right amount that paid SOMEBODY ELSE   expected 'admitted' to be 'denied'
× rejects a block that is not a send (a receive presented as a payment)  expected 'admitted' to be 'denied'
× refuses a block that has not confirmed, and says so retryably          expected 'admitted' to be 'denied'
```

That is a payer redeeming a send to a third party, an incoming receive block, or a block that has not
confirmed — each admitted with a correct signature and a correct amount. The guards were right all
along; nothing had ever held them to it. 24 passed after, typecheck and build clean, and `src/` is
untouched by that pull request.

**`payableOf`'s `BigInt(offer.details?.amountRaw as string)` is not reachable through core.** Core's own
types make `Offer.details` a required `JsonObject` (`types-DTzulQmF.d.ts:168`), and the only producer of
a `rail: 'nano'` offer is this rail's own `offer()`, which always sets `amountRaw`. The `?.` is
half-written — it turns a `TypeError` on property access into a `TypeError` inside `BigInt`, which is no
better — but nothing in core can deliver the shape, so there is no defect to show and nothing is
changed. Carried forward as a reading note, not a finding.

## Found, not fixed

**An unconfirmed block makes the payer's client read "Pay again using this response".** `verify` returns
`reason: 'proof_pending'` for a block that has not confirmed (`src/nano-rail.ts:283`), but
`proof_pending` is not one of core's `DenialCode`s (`types-DTzulQmF.d.ts:91`), and core's `Verification`
union has no pending status at all — only `absent`, `invalid` and `valid`. So core answers:

```
{"code":"proof_invalid","retryable":true,"action":"pay",
 "message":"The nano payment was not accepted. Pay again using this response.",
 "detail":"proof_pending"}
```

The rail's distinction is not lost — `retryable: true` and `detail: "proof_pending"` are both there, and
a correct client can branch on them — but the human-readable message tells a payer whose XNO has
**already left their account** to pay a second time. The rail cannot fix this from here: there is no
shape in core's contract that means "this payment is in flight, hold the same proof and retry", and
inventing a different reason would only change which wrong message is printed. It belongs upstream, and
it is worth Tollstile knowing: a push rail is exactly the case core has no vocabulary for. Nano confirms
in well under a second, so the window is small — but it is not zero, and it is the one denial a payer
can act on destructively.

**A critical advisory sits in the devDependencies, and clearing it needs a major bump.** `npm audit`
reports 5 (3 moderate, 1 high, 1 critical) against the `vitest@^2` chain: the critical is *"When Vitest
UI server is listening, arbitrary file can be read and executed"*, plus a high in `vite`
(`server.fs.deny` bypass) and moderates in `@vitest/mocker`, `esbuild` and `vite-node`. None of it ships
— `package.json` carries `files: ["dist", "README.md"]`, so a consumer installs none of these, and
`npm audit --omit=dev` is **0 vulnerabilities** — and the repository runs `vitest run`, never the UI
server the critical needs. The only remedy npm offers is `vitest@5`, a breaking change to the test
runner; making that call, and re-proving 21 tests across a major version, is not a fix this audit
should slip in beside a money-path guard. Reported so it is a decision rather than an oversight.

**npm still serves the old package — unchanged from 09-25 and 09-26.** `dist-tags.latest` is `0.3.1`,
`time.modified` is `2026-09-24T10:11:10Z`, and the local `package.json` is also `0.3.1`, so nothing can
be published without a bump. An operator running `npm install tollstile-rail-nano` today gets the rail
*before* the fail-closed verifier fix, *before* the runnable install snippet, and now also before this
signer guard. A version bump is a release decision and publishing goes through the swarm's own rail with
its secret scan; neither is this audit's to perform.

## Checked and clean

- No secrets in the tree, in `dist/`, or in the audit notes: no key, seed, token or `.env`; the only
  long hex literals are a public block hash and an account in `examples/`.
- `npm audit --omit=dev`: 0 vulnerabilities — nothing a consumer installs is advisory-affected.
- `manifest.json`'s claim that the published package is dependency-free at runtime still holds:
  `tollstile` (peer) and `node:crypto` are the only non-relative imports anywhere in `src/`.
- The fail-closed verifier check still refuses `undefined`, `null`, `{}`, a string and
  `{ verify: 'not a function' }` at construction.
- `toRaw`'s trailing-zero strip is still guarded by `dot !== -1`, so an integer-valued rate such as
  `20` is never divided by a power of ten.

## Not verified here

- **`npm ci` failed on its first run** and succeeded on a plain retry: `esbuild@0.21.5`'s postinstall
  exited 1 inside `validateBinaryVersion`, which runs the downloaded binary. Recorded because it looks
  like a broken lockfile and is not one — the same lockfile installed cleanly seconds later, so it is
  this sandbox, not the repository.
- `examples/rpc-network-check.mjs`: `rpc.nano.to` answers **403** through this sandbox's egress proxy,
  indistinguishable from here from the script being wrong. Unverified, not known bad.
- The two README links (`nano.org`, `tollstile.com`) again could not be fetched through the proxy.
  Unverified, not known bad.
- Nothing was published and no version was bumped.
