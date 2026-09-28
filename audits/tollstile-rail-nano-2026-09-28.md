# tollstile-rail-nano — code audit, 2026-09-28

Scope: the tree at `37d4ce7` (`master`), version 0.3.2. The previous three audits each recorded that
`examples/rpc-network-check.mjs` "could not be exercised: rpc.nano.to answers HTTP 403 through this
sandbox's egress proxy, which is indistinguishable from the script being wrong." **This run reached
rpc.nano.to.** The script was wrong, in two places, and it is the file an operator copies to build the
one integration point the rail cannot supply for them.

## How it was checked

```
npm ci                 # clean, first attempt
npm test               # 28 passed | 2 skipped   <- baseline
npm run typecheck      # clean
npm run lint           # clean
npm run build          # clean
npm audit --omit=dev   # found 0 vulnerabilities
node examples/rpc-network-check.mjs        # reachable today; see below
POST https://rpc.nano.to {"action":"block_info", ...}   # HTTP 200, twice, real blocks
```

## Found and fixed

**`examples/rpc-network-check.mjs` misread two fields of the live `block_info` response, and each one
alone is enough to deny a genuine payment.** The file calls itself "Mirror the rail's NanoBlockInfo read
model", and `rpc` is the one option `nanoRail` cannot provide — the README's install snippet leaves it as
`/* your Nano RPC read */`, so this example is the reference an operator writes theirs from.

Measured against `rpc.nano.to`, block `CABB659A…E819`, a real confirmed **send**:

```
typeof data.confirmed        : string "true"
data.confirmed === true      : false            <- line 40 as published
data.link_account            : undefined        <- there is no such field
data.contents.link_as_account: "nano_1banexk…hajojmq"   (the destination)
data.block_account           : "nano_3nhh9atn…weyuxh"   (the SENDER)
link_account ?? block_account = "nano_3nhh9atn…weyuxh"  <- line 42 as published
=> destination === source ?    true
```

1. **`confirmed: data.confirmed === true`** — the RPC returns the JSON **string** `"true"`, so this is
   `false` for every confirmed block on the network. The rail maps that to
   `reason: 'proof_pending'`, which core renders as *"The nano payment was not accepted. Pay again using
   this response."* — to a payer whose XNO has already moved.
2. **`destination: data.link_account ?? data.block_account`** — there is no top-level `link_account` in
   the response; a send's destination is `contents.link_as_account`. So the fallback fires every time and
   the destination silently becomes the **payer's own account**, which then fails the rail's
   `block.destination !== merchant` guard as `proof_invalid`.

The script's own output was the tell, and it blamed the network for it. As published, against a block the
RPC reports as `"confirmed":"true"`:

```
  confirmed:   false
RESULT: read path works (block_info returns real data), but rpc.nano.to reported confirmed=false for
this receive block. In production a merchant should confirm a send via the network's confirmation
height, matching what the rail's 'exact confirmed send to merchant' check requires.
```

That sentence is false in its premise and its advice: rpc.nano.to reported confirmed **true**, and the
confirmation-height workaround it recommends exists to route around a bug in the reader. After the fix,
on the same block, the same script prints `confirmed: true` and takes the success branch.

**Fixed** by correcting the two reads. The destination now has **no fallback to `block_account`**: a
destination that cannot be read must fail the rail's merchant guard, not quietly become the payer.

**Made testable, which is why the defect survived three audits.** The mapping was an inner closure in a
script that performed network I/O at import, so nothing could hold it to anything. It is now an exported
pure `toBlockInfo(data, hash)`, and `main()` runs only when the file is executed directly. `src/` is
untouched by this change.

Two laws in `test/rail.test.ts`, over the **recorded live response** for that real send block — the
mapping, and then the same shape driven through the rail to a merchant it really pays.

Held constant (export present, original field reads) so the failure is the fields and not the
refactor:

```
× the example's read model maps a real live-network send block correctly
  → confirmed: expected false to be true
× a genuine payment read through the example adapter is admitted, not denied
  → expected admission, got proof_invalid (proof_pending)
```

and with `confirmed` corrected but the destination read left as published, the second field alone:

```
× the example's read model maps a real live-network send block correctly
  → destination: expected 'nano_3nhh9atn…' to be 'nano_1banexk…'
× a genuine payment read through the example adapter is admitted, not denied
  → expected admission, got proof_invalid (proof_invalid)
```

After:

```
$ npm test
30 passed | 2 skipped (32)
$ npm run typecheck && npm run lint && npm run build
clean
```

Adding two cases moved the README's published rail-unit figure (21 → 23); the repository's own
self-counting law failed on it in the same run, as it is designed to, and the number is corrected here.

## Answered from the carried notes

Three audits carried `block.destination !== merchant` and `block.amountRaw !== expectedRaw` as
"adapter-dependent, not decidable from this repository". Live access decides it **for rpc.nano.to**,
which is the adapter the repository ships an example for:

- **Addresses come back `nano_`-prefixed, not legacy `xrb_`.** Both `block_account` and
  `contents.link_as_account` were `nano_…` on both blocks read. So an operator following this example
  against rpc.nano.to and configuring `merchantAccount` as `nano_…` is safe, and the strict string
  compare does not misfire there. The note is narrowed, not closed: it remains true for any *other*
  adapter, and nothing in the rail enforces the encoding.
- **`amount` is an unpadded decimal string** (`"352000000000000000000000000"`), the same form
  `BigInt.prototype.toString()` produces for `expectedRaw`, so the string compare is exact for this
  adapter. Also narrowed, not closed.

## Checked and clean

- No secrets in the tree or in this change: the only long literals added are a public Nano account and a
  public block hash, both readable by anyone from the chain. No key, seed, token or `.env`.
- `npm audit --omit=dev`: 0 vulnerabilities — nothing a consumer installs is advisory-affected.
- The README's conformance/rail figures match what `npm test` produces (its own law).
- The construction guards still fail closed for an unusable `verifier` and an unusable `signer`.
- `manifest.json`'s runtime-dependency-free claim holds: `tollstile` (peer) and `node:crypto` are still
  the only non-relative imports in `src/`. The example adds `node:url`, which is stdlib and not published
  (`files: ["dist", "README.md"]`).

## Found, not fixed

- **The critical advisory in `devDependencies` is unchanged.** `npm audit` still reports 5 (3 moderate,
  1 high, 1 critical) against the `vitest@^2` chain; the critical needs the Vitest UI server, which this
  repository never starts, and `npm audit --omit=dev` is 0. The only remedy npm offers is `vitest@5`, a
  major bump. Still a decision, not an oversight.
- **npm still serves an older package.** Local `package.json` is now `0.3.2`; a publish is a release
  decision and goes through the swarm's own rail with its secret scan, so nothing was published or
  bumped here. An operator installing from npm today gets the rail before this example fix.
- **`proof_pending` still reaches a payer as "Pay again using this response".** Core's `DenialCode` has
  no in-flight status, so the rail cannot say "hold this proof and retry" in a shape core will render.
  Carried from 2026-09-27; it belongs upstream. Note that the fix above removes the *common* way to hit
  it — an adapter that never reports a block as confirmed at all.

## Not verified here

- The rail has still never run end to end on a Nano test network: no wallet, no funds, and the Test
  Network endpoints in Nano's docs still do not resolve. The send/verify/refund path is exercised against
  the fake provider only; the **read** path is now verified against the live public network.
- The two README links (`nano.org`, `tollstile.com`) were not fetched.
- Nothing was published and no version was bumped.
