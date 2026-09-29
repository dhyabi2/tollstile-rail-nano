# tollstile-rail-nano — code audit, 2026-09-29

Scope: the tree at `06f9370` (`master`), version 0.3.2. Baseline, before any change:

```
$ npm ci                 # clean, first attempt
$ npm test               # 32 passed | 2 skipped   <- baseline
$ npm run typecheck      # clean
$ npm run lint           # clean
$ npm run build          # clean
$ npm audit --omit=dev   # found 0 vulnerabilities
```

The 09-28 runs took the transport shapes the tests never build (the `_meta` / header split) and the
example's read model. This run took the other surface the repository's own tests cannot reach:
**the operator's callbacks when they misbehave**. `nano-provider.ts` is a well-behaved fake — its
`verify` returns `false` and its `blockInfo` resolves — so every test in the suite hands the rail
callbacks that answer. A published rail is configured with somebody else's code.

## Found and fixed

**A signature verifier that throws threw out of the operator's toll gate, where a throwing RPC two
lines away was already handled.** `verifySignature` (`nano-rail.ts:181`) called
`await verifier.verify(source, message, signature)` bare. `rpc.blockInfo` is wrapped in
`providerError`; the verifier was not.

The string it is handed is a header, so it is whatever the caller sent. A real Nano ED25519 verifier
must decode that string before it can judge it, and decoders raise rather than return false:
tweetnacl's `sign.detached.verify` throws `TypeError: bad signature size` for anything that is not
64 bytes, and an address decoder does the same for a malformed source.

Measured through core, same paid request, `x-nano-signature: zz`, against a block that is confirmed
on-chain and pays the merchant the exact quoted amount:

```
throwing blockInfo   -> denied, retryable=true
throwing verifier    -> TypeError: bad signature size, thrown out of gate.enter()
```

So the operator gets an exception instead of a Tollstile answer — no denial, no `proofId`, nothing
the caller can act on — at the one moment when the payer's XNO has already left their account. It
is the same class as the 09-28 quote-header defect: a payer who really paid is answered with
something that is not about their payment.

**Fixed** by wrapping the call and reporting `PROVIDER_UNAVAILABLE`, exactly as the RPC's own
failure is reported. Deliberately **not** `proof_invalid`: the rail cannot tell a signature it
cannot parse from a verifier that is broken or unreachable, the send is already confirmed, and Nano
has no chargeback — a retryable 503 leaves that block unspent and presentable again, where a final
refusal would throw away a real payment whenever the operator's verifier had a bad minute. The
reasoning is written at the function so the next reader does not have to re-derive it.

Proved both directions. Against the unfixed `nano-rail.ts`:

```
× nano rail > a verifier that throws on a malformed signature denies retryably,
              it does not throw out of the gate
  → bad signature size
```

With the fix: **33 passed | 2 skipped** (32 | 2 before), and `typecheck`, `lint`, `build` and
`npm audit --omit=dev` all still clean.

The README's published rail-unit count moved 25 → 26 in the same change. That is not a drive-by
edit: `test/rail.test.ts` ends with a law that reads the README's own numbers and compares them to
what the suite produces, and it failed until the README was corrected. The count is the only thing
in the README that changed.

## Checked and clean

- **The rest of the operator-callback surface.** `rpc.blockInfo` is wrapped in both `verify` and
  `lookup`; `signer.sendFor` is reached only from `refund`, after the handler has already failed,
  and a signer that is present but unusable is refused at construction (0.3.x). `verifier` and
  `signer` are both checked for a callable method at construction, not merely for presence.
- **`parseRate` / `toRaw`.** Re-probed with strings, exponents, noisy floats, zero, signs, trailing
  text and rates with more than 24 decimals. No `SyntaxError` escapes; a rate that reduces the
  payable amount to zero yields no nano offer rather than a free call. `DECIMAL` is anchored with
  `^…$` and JavaScript's `$` — unlike Python's — does not match before a trailing newline, so the
  newline shape that bit the sibling `nano-mcp` does not exist here.
- **The proof binding.** Exact-amount match read from the quote's own offer (never the live rate),
  single-use by block hash in core's ledger, proof-of-possession over the quote nonce against the
  block's source, and `destination`/`subtype` both checked. The README is accurate about the nonce
  being ~33 bits and not being what makes a proof safe.
- **No secrets in the tree.** No tracked `.env`, `.pem` or `.key`, no token shapes, no private-key
  blocks. The 64-hex strings are the fake provider's derived test seeds, which resolve to the fake
  accounts in `nano-provider.ts` and to nothing on any network.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities; the full tree including dev
  reports 0 as well. `peerDependencies` names `tollstile ^0.1.2` and the suite runs against it.
- **The README's published numbers** are now pinned by the repository's own law and match the suite
  exactly: conformance 7 passed / 2 skipped, rail units 26.

## Not verified

- **End to end on a Nano network.** Unchanged from 09-27: the public Test Network endpoints in
  Nano's docs (`test.nano.org`) do not resolve, and the Beta faucet is a Discord channel.
  `examples/rpc-network-check.mjs` was not run in this audit — it reaches the live mainnet, and the
  change touches no code it exercises.
- **A real ED25519 verifier.** The behaviour this fix handles was reproduced with a verifier that
  throws the way tweetnacl's does, not with tweetnacl itself — the package is not a dependency of
  this repository and adding one to prove a point would be the wrong trade. The throw is the input
  to the fix, so what matters is that the rail answers rather than what raised.
