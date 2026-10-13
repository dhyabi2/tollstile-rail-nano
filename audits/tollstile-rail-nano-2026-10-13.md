# tollstile-rail-nano — audit 2026-10-13

Lens: can an agent pay in XNO through this rail today without being hurt?

Starting point: `master` at `0837429`. `npm ci && npm test` → **77 passed, 2 skipped**;
`npm run lint`, `npm run typecheck`, `npm run build` clean, before and after. 78 passed
after this change.

Open pull request #21 (`fix/0.3.2-release-blockers`, 05:27Z today) already covers the empty
npm package, the `nonceIntOf` regression and the double refund on reconcile. This pass
deliberately avoided all three and spent itself on the admit/refuse decision and on the
rail's configuration edge.

## Checked

- `verify`, line by line, in order: presented hash → `canonicalHash` (so the payer does not
  choose their own `proofId`, #18-era fix) → quote opened from the token → `expectedRaw`
  taken from the quote's own offer and never from a live rate → `blockInfo` → `confirmed`
  read as `true || 'true'` (the live node sends the STRING) → destination and `subtype` →
  **exact** amount → proof-of-possession signature over the quote nonce from the block's
  source, with `ok === true` rather than truthiness and a throwing verifier reported as
  `PROVIDER_UNAVAILABLE` rather than `proof_invalid`. Each guard still holds, and each
  refusal still precedes anything irreversible.
- `lookup` reads `confirmed` the same strict way.
- `parseRate` / `expandExponent` / `toRaw`: integer arithmetic throughout, no float on any
  amount; re-derived `$1` at `0.01` XNO/USD (`1e28` raw) and the nonce-clearing division
  by hand. `offer` refuses a non-positive amount.
- `quoteFrom` / `signatureFrom` / `rawFromHeader`: all three treat a present-but-empty
  header as absent and fall through to MCP `_meta`, in the same order.
- `redact` drops the payer signature and keeps the public block facts.
- The README's conformance and unit-test counts against what the suite actually runs (the
  repository's own law, `test/rail.test.ts`); updated to 71 for the test added here.

## Found and fixed (#22)

**`merchantAccount` was never validated, and a trailing newline makes the gate ask every
payer to pay twice** — `src/nano-rail.ts`, the `nanoRail()` constructor (no check at all)
and `verify` at the `block.destination !== merchant` compare.

`verify` admits a block only when `block.destination === merchantAccount`, an exact string
compare against the account the node names. `nanoRail()` fails closed at construction for
an unusable `verifier` and for an unusable `signer` — both for the stated reason that
"refusing at verify time would be after the money moved" — but it never looked at the
merchant's own account. Measured on `master`, `merchantAccount: ${MERCHANT}\n`, with the
payer sending the exact challenged amount to this merchant:

```
challenge accepts.to = "nano_3merchant...aaaa\n"     <- the padding is published in the 402
confirmed send, correct amount -> denied
  {"code":"proof_invalid","retryable":true,"action":"pay",
   "message":"The nano payment was not accepted. Pay again using this response."}
```

A correct, confirmed, exactly-priced payment is refused, and the answer **asks for the money
again** — on an asset with no chargeback — and will do so for every payer until someone
reads the config. Nothing downstream can catch it: the address is well-formed enough to
publish in the 402, the amount is right, the signature is right, and the only mismatch is
the merchant's own setting. The README's own install snippet is the path to it:
`merchantAccount: process.env.NANO_MERCHANT_ACCOUNT!` — an env file, a JSON config or a
copied line is exactly where a trailing newline comes from.

**Fix:** one construction guard. `merchantAccount` must be `nano_`/`xrb_` plus 60 base32
characters whose first is `1` or `3`, with nothing around it, or `nanoRail()` throws
`CONFIG_INVALID` — the third option to fail closed there, for the same reason as the other
two. It only adds a refusal, at boot, and nothing in `verify`, no amount, destination,
rounding or key path changes.

The repository's `MERCHANT` fixture was itself not a Nano address (a **61**-character body;
the fake payer's is 59), so it is replaced with a real, checksum-valid one
(`nano_1h6o1hmf9s19ph6onk7buwbttjb9khikmo5pnjbr68r3thsxhunmrh4fhjuu`). That is the guard
catching a wrong address on its first use. The suite is green on it unchanged.

**Failing-then-passing:** one new test, thirteen rejected forms (the measured newline, a
leading and a trailing space, one character short, one long, upper case, `nano_2`, `nanoo_`,
an `l` for an `h` — `l`, `0`, `2` and `v` are not in Nano's base32 — plus `''`, `undefined`,
`null`, `42`), both accepted prefixes, and a control that a constructed rail still admits a
real payment. With the guard's condition alone disabled (`if (false)`), exactly that test
fails: `merchantAccount "nano_1h6o...\n" was accepted: expected [Function] to throw an
error`. With it: **78 passed, 2 skipped**, lint, typecheck and build clean.

### My guard had a trap in it, closed on this branch by another routine (`7db6e08`)

Two things, and the first is mine to own. I allowed `xrb_` in `NANO_ACCOUNT` and added a
test asserting that **both prefixes still construct** — then wrote in the pull request that
this was the guard changing nothing. It is not: `xrb_` is the legacy spelling of the same
key, but **nodes name destinations `nano_`**, and `verify` compares the strings exactly. So
an `xrb_` merchant was refused on every confirmed payment, with the same "Pay again" answer
this whole pass is about. My test checked that construction succeeded and stopped one step
short of the only question that matters. `7db6e08` rewrites `xrb_` to `nano_` once, at
construction, and publishes and compares that value. Measured here through the real rail,
`xrb_` configured against a provider naming `nano_`:

```
configured xrb_, challenge publishes: nano_1h6o1hm ...
xrb_ configured, node names nano_ -> admitted
```

Second, it **does** verify the checksum, which I had recorded below as impossible without a
dependency. It carries a 92-line unkeyed RFC 7693 BLAKE2b (`src/blake2b.ts`) for the 5-byte
digest `node:crypto` will not produce. That claim I did not take on trust: its own suite
only pins it against `createHash('blake2b512')` at outlen 64, so I generated **201 vectors
from it** — digest lengths 1 to 64, the empty input, and inputs crossing the 128-byte block
boundary — and compared every one against Python's `hashlib.blake2b(..., digest_size=n)`:
**0 mismatches**. End to end, a one-character change at body positions 6, 20, 40 and 60 is
refused at boot, and both real live-network addresses this repository already carries
(`nano_3nhh9…`, `nano_1banex…`) validate.

Branch total: **81 passed, 2 skipped**; lint, typecheck and build clean.

The lesson worth copying: a guard that refuses a bad value is only half of it. The test has
to carry the value all the way to the decision it protects — my `xrb_` case asserted
`not.toThrow()` at construction when it should have asserted a payment was *admitted*.

## Could not verify

- Still not run end to end against a Nano test network — unchanged, and the README says so.
  `examples/rpc-network-check.mjs` remains the read-path check.
- The BLAKE2b above is cross-checked against `hashlib` and `node:crypto`, not against a
  Nano node: no address was round-tripped through the live network from here.

## Note for the merger

This branch and #21 both touch the README's published test count (the repository's own law
asserts it against the suite). Whichever merges second will need that number re-counted;
nothing else overlaps.
