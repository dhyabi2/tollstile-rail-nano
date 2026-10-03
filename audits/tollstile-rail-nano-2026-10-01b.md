# tollstile-rail-nano — code audit, 2026-10-01

Scope: the tree at `56d5d5d` (`master`), version 0.3.2. Baseline, before any change:

```
$ npm ci                 # clean, first attempt
$ npm test               # 33 passed | 2 skipped   <- baseline
$ npm run typecheck      # clean
$ npm run lint           # clean
$ npm run build          # clean
$ npm audit --omit=dev   # found 0 vulnerabilities
```

The 09-29 run took the operator's callbacks when they misbehave and fixed the verifier. It then
recorded `signer.sendFor` as clean, on the reasoning that it "is reached only from `refund`, after
the handler has already failed". That reasoning was wrong, and this run says why: *after the
handler has already failed* is not a reason the call matters less. It is the moment the operator
asked for the payer's XNO to go back.

This run read what **core** actually does with each thing a rail can throw, rather than reasoning
from the rail alone.

## Found and fixed

**A refund signer that throws threw out of `pass.complete('failed')`, and left the charge in the one
state core never revisits.** `refund` (`nano-rail.ts:425`) called
`await signer.sendFor(data.source, data.amountRaw, { refundOf: data.hash })` bare. The signer is the
operator's own Nano node or signing service over a network, so it throws on a socket reset, a 503
from the RPC host, or a timeout.

Core's contract is explicit (`tollstile` `Rail`): *"Rails throw `TollstileError` with
`PROVIDER_UNAVAILABLE` or `PROVIDER_TIMEOUT` when an outcome is unknown; every other outcome is a
returned value."* `performRefund` enforces it — it wraps `refund` in `callProvider`, whose
`isProviderFailure` recognises only those two codes and **re-throws everything else**. Tollstile's
own reference rail models exactly this case by rejecting with `PROVIDER_TIMEOUT`
(`dist/index.js:337`).

Measured through core, same settled payment, same failed handler, only the error shape differing:

```
sendFor throws a raw Error            threw out of complete(): Error: nano node unreachable
                                      charge moves: settled -> refund_pending (pending=refund)   <- stops here
                                      error events: [Error: nano node unreachable]

sendFor throws PROVIDER_UNAVAILABLE   threw out of complete(): no
                                      charge moves: settled -> refund_pending -> unknown (pending=refund)
                                      error events: [PROVIDER_UNAVAILABLE: ...]
```

`unknown` is the whole point: it is the only state `resolveUnknown` picks up again, and it is what
makes core call `lookup` later to find out whether the reverse send actually landed. Stuck at
`refund_pending`, nothing is ever reconciled — the payer's XNO has moved, the handler has failed,
the merchant still holds the money, and the record that says it is owed was never written. The
operator gets an unhandled exception out of their own completion call instead.

**Fixed** by wrapping the send in the file's existing `providerError` helper, the same treatment
`rpc.blockInfo` has in `verify` and `lookup` and the verifier got in PR #10. Reported as
`PROVIDER_UNAVAILABLE` and deliberately **not** as `{ status: 'rejected' }`: a failed send is
genuinely unknown — the block may have been published and only the reply lost — and `rejected`
would assert the money did not move, which invites a second reverse send. The reasoning is written
at the call so the next reader does not re-derive it.

Proved both directions. Against the unfixed `nano-rail.ts`:

```
× nano rail > a refund signer that throws leaves the charge reconcilable instead of
              throwing out of complete()
  → nano node unreachable
    ❯ Object.refund src/nano-rail.ts:425:38
    ❯ callProvider node_modules/tollstile/dist/chunk-YOBXHQZK.js:357:39
    ❯ performRefund node_modules/tollstile/dist/chunk-YOBXHQZK.js:433:22
    ❯ Object.complete node_modules/tollstile/dist/chunk-YOBXHQZK.js:883:9
```

With the fix: **34 passed | 2 skipped** (33 | 2 before), and `typecheck`, `lint`, `build` and
`npm audit --omit=dev` all still clean.

The README's published rail-unit count moved 26 → 27 in the same change, because
`test/rail.test.ts` ends with a law that reads the README's own numbers and fails until they match.
The count is the only thing in the README that changed.

## Found, not fixed — needs the owner's call

**A rate feed that fails throws a raw `Error` out of `gate.enter()`, and core has no handling for
it at all.** `offer` (`nano-rail.ts:311`) is the one place `xnoPerUsd` is read, and the README's own
install snippet recommends a network call there:

```ts
xnoPerUsd: () => fetchXnoUsdRate(),   // README:126
```

Measured: `xnoPerUsd: () => { throw new Error('rate API 502') }` comes straight back out of
`gate.enter()`. Unlike every other rail method, **`rail.offer` is not wrapped in `callProvider`**
(`chunk-YOBXHQZK.js:1068` calls it bare), so even a correctly-coded `PROVIDER_UNAVAILABLE` escapes
— I measured that too. While the merchant's rate feed is down, an agent that has not yet paid gets
a 500 out of the operator's handler instead of a 402 it can act on or a 503 it can retry. Agents
that already paid are unaffected: `verify` runs before the challenge path, and it never reads the
rate.

I did not change this, because the right answer is a design decision and not mine to take:

- returning `null` (the documented "this rail cannot serve it") produces a 402 carrying **no**
  offers, which an agent cannot pay either — core only raises `payment_unavailable` when some rail
  had an offer and failed to challenge it (`chunk-YOBXHQZK.js:1091`);
- wrapping it as `PROVIDER_UNAVAILABLE` still escapes, but at least arrives with a code an
  operator's HTTP layer can map to 503 rather than an uncategorised 500;
- caching the last good rate changes the rail's pricing semantics, which is a product decision.

A one-line wrap is available if the owner wants the second option. The cleanest fix is probably
upstream in Tollstile — `offer` should be wrapped like every sibling call — which is a PR on
someone else's repository (Tier 0 group 4), not here.

## Checked and clean

- **Every other provider call.** `rpc.blockInfo` is wrapped in `verify` and in `lookup`; the
  verifier is wrapped in `verifySignature`; `verifier` and `signer` are both checked for a callable
  method at construction, not merely for presence. With this run's fix, `offer`'s rate read is the
  only unwrapped call left on the path, and it is written up above.
- **The proof binding.** Exact-amount match read from the quote's own offer and never from the live
  rate; single-use by block hash in core's ledger; proof-of-possession over the quote nonce checked
  against the block's `source`; `destination` and `subtype` both checked. Re-read against the fact
  that `verify` is called *before* core's single-use check — which is why `onSettled` is refused at
  construction — and that is still correct.
- **Amounts are integers end to end.** `parseRate` returns `{ digits: bigint, decimals: number }`,
  `toRaw` is `bigint` throughout, `payableFor` parses with `/^\d+$/` before `BigInt`, and the
  comparison in `verify` is an exact string equality against a canonical `BigInt().toString()`. No
  float touches an amount anywhere on the path.
- **Refund amount.** `refund` sends back `data.amountRaw` — the full block amount, price raw *plus*
  the quote nonce — which is what the payer actually sent, not the pre-nonce price. Correct.
- **No secrets in the tree or history.** No tracked `.env`, `.pem` or `.key`, no token shapes, no
  private-key blocks. The 64-hex strings are the fake provider's derived test seeds, which resolve
  to the fake accounts in `nano-provider.ts` and to nothing on any network.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities; the full tree including dev
  reports 0 as well.
- **The README's published numbers** match the suite exactly: conformance 7 passed / 2 skipped,
  rail units 27.

## Not verified

- **End to end on a Nano network.** Unchanged since 09-27: the public Test Network endpoints in
  Nano's docs (`test.nano.org`) do not resolve, and the Beta faucet is a Discord channel.
  `examples/rpc-network-check.mjs` was not run in this audit — it reaches live mainnet, and the
  change touches no code it exercises.
- **A real Nano signer.** The behaviour this fix handles was reproduced with a signer that throws
  and one that rejects, not with a real node losing its connection. The throw is the input to the
  fix; what matters is that core is told in the shape it understands, which is measured above.
- **That `unknown` + `pending: 'refund'` is reconciled all the way back to a completed reverse
  send.** I verified the charge reaches the state core revisits and that `lookup` is the call it
  makes from there. Driving a full reconciliation cycle needs a signer that fails and then
  succeeds, which is operator-side behaviour this repository does not model.
