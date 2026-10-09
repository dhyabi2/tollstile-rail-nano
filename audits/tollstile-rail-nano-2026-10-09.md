# tollstile-rail-nano — code audit, 2026-10-09

Previous audits 2026-10-08 and 2026-10-08b (`b48f936`). Read under one question: can an agent
pay in XNO through this rail today without being hurt?

HEAD audited: `origin/master` at `b48f936`. Node 20 in this container.

Baseline before any change, exactly the five things `.github/workflows/test.yml` runs:

```
$ npm ci              # 153 packages, clean
$ npm test            # 36 passed | 2 skipped (38)
$ npm run typecheck   # clean
$ npm run lint        # clean
$ npm run build       # clean
```

## Found and fixed — an unconfirmed block was admitted as payment

The rail reads two values that decide whether a payment is real, and both were read for
**truthiness** rather than for what they are.

### `src/nano-rail.ts:405` — the block's confirmation

```ts
if (!block.confirmed) return { status: 'invalid', reason: 'proof_pending', proofId: hash };
```

`NanoBlockInfo.confirmed` is declared `readonly confirmed: boolean` (`src/nano-types.ts:21`),
but the package publishes JavaScript, so that is not enforced at runtime — which is the exact
premise the two construction guards in `nanoRail` are already written under
(`src/nano-rail.ts:291-295`: *"The published package is JavaScript, so the
NanoSignatureVerifier type is not enforced at runtime"*). And `rpc` is the one option
`nanoRail` cannot supply, so this value always comes from code the operator writes.

**The live node does not send a boolean.** Measured this run against `https://rpc.nano.to`,
`block_info` for a real confirmed send
(`44DF0057D33D38C317A35CF9F034B9189BAE031DE032B385E3F453E5FD5ED279`):

```
confirmed  = 'true'   (a STRING, not the boolean true)
subtype    = 'send'
amount     = '1000000000000000000000000000000'
```

This repository already knows it: `examples/rpc-network-check.mjs:45-47` says so in as many
words — *"`confirmed` comes back as the STRING "true", not the boolean `true`"* — and
`toBlockInfo` there normalises it correctly with `data.confirmed === true || data.confirmed ===
'true'`. The rail did not. So an operator who maps the field straight across (`confirmed:
data.confirmed`, the obvious thing to write) handed this guard the string `"false"` for a block
the network has **not** cemented — and `!"false"` is `false`, so the guard never fired.

Reproduced end to end through `gate.enter`, rail unchanged, only `rpc.blockInfo` wrapped to
return the node's wire form: the payment was **admitted**, so the merchant delivers and books a
settled charge on a block that may never cement. If it never does, the payer keeps the XNO and
the merchant has delivered for nothing. This is the mirror image of the example-side defect the
2026-09-28 audit fixed: that one *refused good payments*, this one *accepts bad ones*.

### `src/nano-rail.ts:244` — the signature verifier's answer

```ts
return ok ? signature : null;
```

Construction checks `typeof options.verifier.verify === 'function'` but nothing checks what it
answers. `NanoSignatureVerifier.verify` is declared `Promise<boolean>`, and `{ valid: false }`
is what an HTTP-backed verifier answers if it hands its JSON body back un-destructured — which
is truthy. Measured: with `verify: () => ({ valid: false })` and the signature
`'a-signature-nobody-checked'`, the payment was **admitted**. That is precisely the replay the
construction guard says a verifier exists to stop (`src/nano-rail.ts:287-289`: *"without a
verifier a watcher could replay any confirmed send to the merchant"*) — any watcher of the
public ledger could present someone else's confirmed send and be let in.

### The fix, and why it only narrows

`confirmed` is now read as `confirmed !== true && confirmed !== 'true'` → refuse, which accepts
both forms the node can actually send and refuses every other shape. `verify`'s answer is read
as `ok === true`. Every input whose outcome changes moves from **admitted to refused**:

| value of `confirmed` | before | after |
| --- | --- | --- |
| `true` (boolean) | admitted | admitted — unchanged |
| `'true'` (what the node sends) | admitted | admitted — unchanged |
| `'false'` (what the node sends when uncemented) | **admitted** | **refused** |
| `'maybe'`, `1`, `{}`, `[]`, `'TRUE'`, `'1'` | **admitted** | **refused** |
| `false`, `undefined`, `null`, `0`, `''` | refused | refused — unchanged |

and for the verifier, `true` still admits, `false`/`null`/`undefined`/`0` still refuse, and
every truthy non-`true` answer moves from admitted to refused. Nothing that was correctly
admitted becomes refused, so no working configuration is lost, and no amount, destination,
rounding or key path is touched.

Nineteen cases added (five `it(` plus four `it.each` groups). **Fourteen fail with
`src/nano-rail.ts` alone reverted to `master`** and pass with the fix. The rest are controls
that must hold either way — the boolean `true` and the string `'true'` still pay, and a plainly
unconfirmed block is still refused. The test rig boxes its overrides (`{ value }`) because
`undefined` is one of the answers under test and a bare `confirmedAs: undefined` could not be
told apart from "do not wrap this dependency".

The README's own published count (`Rail unit tests: **29 passed**`) is held to the suite by
`test/rail.test.ts:892`, which counts `^\s*it\(` in this file; it is moved to **34**.

After the fix: **62 passed | 2 skipped**, typecheck, lint and build all clean.

## Checked — and one correction to a previous audit

**`#17` (`b48f936`) merged as a fix but changed no code, and the defect it names is live.**
`git show --stat b48f936` is one file, `audits/tollstile-rail-nano-2026-10-08b.md`, +145 lines,
with zero lines of `src/`, `test/` or `README.md`. The commit body says so itself ("No code
changes; one audit note, because the fix is a design decision") and the audit's section is
headed "Not fixed here — the decision is the owner's". That is defensible as a decision, but a
title that reads as a fix on a merged pull request is how a later run concludes it is done. The
double refund it describes (`src/nano-rail.ts:470-491`) is unchanged on master and is still the
owner's call — it is listed again below rather than re-litigated here.

## Found, NOT fixed — listed for the owner

- **The 402 advertises two different XNO amounts, and the headline one is unpayable.**
  `offer()` (`src/nano-rail.ts:337-345`) runs *before* the quote exists, so it can only publish
  the pre-nonce price, and core copies `offer.amount` into the 402 body verbatim. Measured on a
  `$1` route: `accepts[0].amount` is `10000000000000000000000000000` while
  `accepts[0].details.amountRaw` — the only payable figure — is
  `10000000000000000007524042419`, the quote nonce apart. `verify` demands an exact match, so a
  payer who reads the field every rail shares loses the **whole** payment, not the difference.
  **Not a one-liner:** the nonce is `SHA-256(quote.id)` and `rail.offer()` is called before
  `quotes.issue()`, so the rail structurally cannot put the payable amount in `offer.amount`
  while the nonce derives from the quote id. That is a design tension to decide, not a typo.
- **The merchant's refund can still be sent twice** — `b48f936`'s subject, unfixed. Re-measured
  against the repo's own fake network with a signer that publishes the reverse block and loses
  its reply: `sendFor` calls go 1 → 2 across a `reconcile()`, because `lookup`
  (`src/nano-rail.ts:479-491`) reads `data.hash` — the payer's original send, always confirmed —
  and so answers `'settled'` for ever. None of the three options that audit put to the owner has
  been taken.
- **A rate feed that throws comes out of `gate.enter()`** (`src/nano-rail.ts:334-337`, first
  reported 2026-10-01b). `rail.offer` is the one rail method core calls bare rather than through
  `callProvider`, and the README's own snippet recommends a network call there, so an unpaid
  agent gets a 500 out of the operator's handler instead of a 402 or a retryable 503.
- **`examples/rpc-network-check.mjs:33` turns "no such block" into "the network is down".**
  Measured: an unknown hash answers `{"error":"Block not found"}` with HTTP 200, and that
  `throw` becomes `PROVIDER_UNAVAILABLE` → 503 permanently, where `NanoRpcRead` requires
  `undefined` and the rail would give a terminal `proof_invalid`. Safe direction, no money at
  stake, and `examples/` is outside lint and typecheck, which is why no gate sees it.
- **`test/rail.test.ts:613` does not run the README snippet it claims to.** It reads the fence
  and uses it for one thing — whether to pass `secret` — then hand-writes everything else.
  Mutation proof: delete the `verifier:` line from the README fence, which makes the snippet
  throw `CONFIG_INVALID` at `nanoRail()`, and the suite still reports `1 passed | 28 skipped`.
  Related: the snippet at `README.md:155-177` does not parse (`tsc` gives three `TS1109`s — an
  arrow function whose body is only a comment), which is defensible for a sketch but not
  compatible with a law named "constructs a Tollstile that can price". Left alone because
  deciding whether that snippet should be compilable, or the law renamed, is a maintainer's
  call, and this run's one concern was the accept path.

## Checked and clean

- **The amount path is integers end to end.** `parseRate` → `{digits: bigint, decimals: number}`;
  `toRaw` is bigint throughout (`src/nano-rail.ts:168-174`); `payableFor` gates on `/^\d+$/`
  before `BigInt`; the verify comparison is string equality against a canonical
  `BigInt().toString()`. No float and no `Decimal` anywhere on an amount, so none of the
  process-global `decimal` rounding found in the sibling repositories can be present here.
  `NONCE_MODULUS = 10^10` and `toRaw` clears the low 10 digits, so price and nonce cannot carry
  into one another.
- **The proof binding takes nothing from the payer but the hash, the signature and the signed
  quote.** The amount is read from the quote's own signed offer and never from the live rate;
  the quote is HMAC-signed, expiry-checked and resource-checked; single-use is enforced by
  canonical block hash in core's ledger; proof-of-possession over `quote.nonce` is verified
  against `block.source` read from the **ledger**, not from the submission; `destination` and
  `subtype` are both checked; the amount match is exact, not a minimum.
- **An invalid proof does not burn the payer's block** — the already-used check only reads the
  ledger, so presenting an observed hash with a garbage signature cannot mark it used.
- **No committed secret, tree or history.** No tracked `.env`/`.pem`/`.key`/`.npmrc`; no private
  key block or token shape; `git log --all --diff-filter=A` adds no such file ever. The only
  64-hex literals are the fake provider's derived seed (`src/nano-provider.ts:48`, a SHA-256 of
  a fixed string, controlling nothing) and public block hashes. `dist/` is not tracked.
- **The live read model is right for a real send.** Measured on the block above: `subtype` is
  top-level and present, and `amount` is an integer raw string.

## Could not verify

- **No end to end run on a Nano network.** Unchanged from every prior audit: no funded key, so
  `verify` → `settle` → `refund` was exercised only against `src/nano-provider.ts`. Everything
  network-dependent above is a read against `rpc.nano.to`.
- **The string `"false"` from the same serializer.** I measured `confirmed` as the string
  `'true'` on a confirmed block and could not find an unconfirmed block on a public node to
  measure its false form from. The truthiness hole and its end-to-end admission are both
  measured and do not depend on it: the fix refuses every shape that is not a confirmation,
  whatever the node spells it.
- **Whether `accepts[].amount` is normatively the amount a payer pays.** Core's type doc, its
  conformance check and the 402 body's shape all read that way, but `tollstile.com/docs` and
  the upstream repository are both outside this session's reach, so the spec text was not read.
  The *discrepancy* is measured either way, and this repository's README does not mention it.
- **Node 22 and 24.** Only Node 20 was run here; CI covers the other two.
