# tollstile-rail-nano — code audit, 2026-09-24

Scope: the published tree at `53dfb81` (`master`), which is also what npm serves
as `tollstile-rail-nano@0.3.1`. Read `src/` in full (`nano-rail.ts`,
`nano-types.ts`, `nano-provider.ts`, `index.ts`, `testing/index.ts`), both test
files, `package.json`, `manifest.json` and `README.md`.

## How it was checked

```
npm ci            # clean, lockfile pins tollstile@0.1.2
npm test          # 17 passed (2 files)   <- baseline
npm run typecheck # clean
npm run build     # clean
npm audit --omit=dev   # found 0 vulnerabilities
```

The published artifact was also pulled from the registry and compared:
`tollstile-rail-nano-0.3.1.tgz` contains `dist/` (js, d.ts and maps for all five
modules), `package.json` and `README.md` — nothing missing, nothing extra. Its
declared peer `tollstile@^0.1.2` resolves (registry latest is `0.1.2`), and the
four symbols the README's install snippet uses — `createTollstile`,
`memoryLedger`, `createRail`, `TollstileError` — all exist in that package.

## Found and fixed

**The README's conformance result was stale.** It claimed "**15 passed** …
(7 rail unit tests + 8 conformance tests)"; the suite is 17 (9 + 8). The README
tells a Tollstile maintainer to run `npm test` and compare, which is the one
reader most likely to notice the mismatch. Corrected in this PR.

## Found, proved, and left open for the owner

**`nanoRail()` does not fail closed for a verifier that is present but
unusable** — PR "nano-rail: fail closed for a verifier that is present but
unusable". The guard was `options.verifier === undefined`, and the published
package is JavaScript, where the `NanoSignatureVerifier` type does not exist at
runtime, so `null`, `{}` and a string all construct successfully. The fault then
lands on a *paid* request, after the payer's block has confirmed on-chain, as an
unhandled `TypeError` rather than one of the rail's own error codes — the payer
has paid and gets a 500. Demonstrated against the real `tollstile@0.1.2` core.

That PR is deliberately **not** self-merged: it edits the settlement rail. The
change can only refuse more at construction and touches no acceptance logic, but
money-path code wants a human read.

## Checked and clean

- No secrets in the tree or in `dist/`.
- `toRaw()` (USD micros → XNO raw) was exercised through the public `offer()`
  against an independent reference across 19 rates × 5 prices — whole numbers,
  sub-cent rates, and both exponent forms (`1e-7`, `1.5e21`), which is where its
  string normalisation is doing real work. All 95 cases match exactly. It stays
  in integer/BigInt arithmetic throughout; no float ever touches an amount.
- The security properties the README claims are each pinned by a test that
  actually exercises them through core: exact-amount-per-quote (a 1-raw donation
  is refused), proof-of-possession (a signature from another account is refused),
  replay (a second presentation of the same block records no second settlement),
  and rate-locked-at-quote-time (a rate that moves between quote and verify does
  not refuse a payer who sent the quoted amount).
- `redact()` drops the payer signature and keeps only public block facts.
- The fake provider ships under the `./testing` subpath, not the main entry, and
  both its module docstring and the subpath's own file say it is not for
  production.
- The refund path reverses the full block amount (price + nonce), not just the
  price.

## Noted, not changed

- **`block.destination !== merchant` is a strict string compare of Nano
  addresses.** A Nano account has two canonical encodings, `nano_` and the legacy
  `xrb_`. If an operator's RPC adapter returns one form while `merchantAccount`
  is configured in the other, a genuine payment is rejected as `proof_invalid`.
  Whether that can happen depends on the adapter the operator writes, so it is
  not demonstrable from this repository alone — but it is the same trap found and
  fixed in `dhyabi2/nano-mcp` the same day, and worth an owner's decision.
- `block.amountRaw !== expectedRaw` likewise compares numeric values as strings;
  `BigInt(a) !== BigInt(b)` would be immune to an RPC that pads or formats
  differently. Again adapter-dependent, so noted rather than changed.
- `tollstile` is relied on as a peer dependency and is not in `devDependencies`.
  `npm ci` works because the lockfile pins it, but a contributor installing with
  `--legacy-peer-deps` would not get it and `npm test` would fail on the import.
- Two README links (`nano.org`, `tollstile.com`) could **not** be checked from
  this sandbox — the egress proxy denied both hosts. They are unverified here,
  not known bad.

## Not audited this run

`nano-mcp-public`, `agent-runtime`, `swarm-proof`, `outreach-tracker` — next run
takes those. `invent-stack` is private and therefore out of scope.
