# tollstile-rail-nano — audit 2026-10-08 (b): the refund can be sent twice

The 10-08 note (merged as #16) went at the published npm artefact. This one went at the **refund
path**, and it **corrects a conclusion the 10-04 audit reached in this repository**. No code changes
here: the fix is a design decision, not a routine's to make. Recorded so no later run re-derives it or
re-accepts the wrong answer.

Baseline on `master` `4987ebb`: **36 passed / 2 skipped**, lint, build and typecheck clean. The
measurement below was taken in a throwaway copy under `/tmp`; nothing in the repository was modified.

## The 10-04 audit said this was not a defect. It is.

Under **Checked and found sound**, `audits/tollstile-rail-nano-2026-10-04.md` says:

> **`lookup` during a refund.** `refund`'s comment says core calls `lookup` "to find out whether the
> reverse send actually landed", and `lookup` only ever reads the ORIGINAL payment block — so it can
> never answer that. It does not need to: `resolveUnknown` treats BOTH `settled` and `none` with
> `charge.pending === "refund"` as "move to `refund_pending` and call `performRefund` again". Either
> answer retries the refund, which is the right outcome. Not a defect; the comment is looser than the
> code.

The reading of core is exactly right. The conclusion does not follow: **"retries the refund" is the
harm**, because the reverse send has no idempotency and nothing can tell a send that landed from one
that did not.

## Measured

`src/nano-rail.ts:470-476` — the reverse send, with no record of having been attempted:

```ts
let reference: string;
try {
  reference = await signer.sendFor(data.source, data.amountRaw, { refundOf: data.hash });
} catch (error) {
  throw providerError(`the refund send for ${data.hash}`, error);
}
return { status: 'refunded', reference };
```

`src/nano-rail.ts:479-491` — `lookup`, which reads `data.hash`: the payer's **original** send, which is
always confirmed. So it answers `'settled'`, always.

`node_modules/tollstile/dist/chunk-YOBXHQZK.js:1351-1395` — `resolveUnknown`. It has three branches,
and the one that would end the matter is **unused**:

```js
case "refunded":                      // :1365 -- moves straight to refunded, NO further send
case "settled":  if (charge.pending === "refund" || !completed) { … performRefund(…) }   // :1368
case "none":     if (charge.pending === "refund") { … performRefund(…) }                 // :1383
```

`LookupResult` is `'settled' | 'refunded' | 'none'`, and **this rail never returns `'refunded'`** —
`NanoRpcRead` is `{ blockInfo }` only (`src/nano-types.ts:38-40`), so the rail is structurally unable
to see its own reverse send. Both answers it *can* give lead to `performRefund` again.

Measured against the rail's own `nanoProvider` as the network, with a signer that publishes the block
and then loses its reply — the exact case `src/nano-rail.ts:467-468` names ("the block may have been
published and only the reply lost"):

```
after complete(failed): reverse sends made = 1 | refundCount = 1
reconcile: examined=1 resolved=0 pending=1 errors=1
after reconcile():      reverse sends made = 2 | refundCount = 2
  reverse sends for ONE payment: expected 2 to be 1
```

**Two reverse sends off one payment.** The merchant is out twice the amount, and Nano has no chargeback.

## The code's own comment already contains the contradiction

`src/nano-rail.ts:467-469` explains why a failed send is reported `PROVIDER_UNAVAILABLE` rather than
`rejected`:

> A failed send is also genuinely UNKNOWN — the block may have been published and only the reply lost —
> so it is reported as unavailable, never as `rejected`, which would assert the money did not move and
> risk a second reverse send.

`rejected` was avoided because it risks a second reverse send. `PROVIDER_UNAVAILABLE` **produces** one,
via `unknown` → `lookup` → `performRefund`. The hazard was identified correctly and the chosen branch
walks into it.

## Why no test caught it

`test/rail.test.ts:352` ("a refund signer that throws leaves the charge reconcilable instead of throwing
out of `complete()`") asserts `provider.refundCount()).toBe(0)` and **stops at `complete('failed')`** —
it never calls `reconcile()`, which is the entire point of putting the charge in `unknown`. It is the
right test for the raw-vs-`TollstileError` question it was written for, and it is the test that conceals
this one.

## Not fixed here — the decision is the owner's

Both hooks already exist and are unused: `refund` is handed an `Operation` whose `key` is the stable
`` `${charge.id}:refund` `` (`chunk-YOBXHQZK.js:425-429`), and `sendFor` already receives the stable
`{ refundOf: data.hash }`. So the idempotency can live in one of three places, and they are not
equivalent:

1. **The signer's contract.** `NanoSigner` (`src/nano-types.ts:47-50`) says "Submit a confirmed `send`
   … and return its hash" and never says it must be idempotent on `refundOf`. Documenting that
   requirement is a one-line change and puts the duty where the key is — but it is a doc change, so
   every existing operator stays exposed until they act on it, and the repo's own fake signer is not
   idempotent either.
2. **The rail refuses a second attempt.** Strictly a refusal, and merge-eligible on that reading — but
   the rail is documented as holding no state, so the record would be in-process and lost on a restart,
   which is exactly when a reconcile runs.
3. **The rail answers `'refunded'`** so core's unused branch fires. That needs the rail to be able to
   see the reverse send, which `NanoRpcRead` cannot do today.

A fourth option — keep resending — is what happens now, and the measurement above is what it costs.

**One sentence for the owner: where should the reverse send's idempotency live — the signer's contract,
the rail, or `NanoRpcRead` gaining the read that lets `lookup` answer `'refunded'`?** Until that is
decided, a merchant whose signing service is merely *slow* (core's default `providerTimeoutMs` is
10 s) can be debited twice for one payment, and the charge finishes looking resolved.

## Also found, no money at stake

- **The README's no-signer claim does not hold.** `README.md:24` says that without a `signer` "the
  charge stays **settled and reported**". It does not: `createRail` derives `capabilities.refund` from
  the *presence of the function* (`node_modules/tollstile/dist/index.js:199`), the rail always supplies
  `refund()` because the `upfront` flow needs it, so `capabilities.refund` is `true` even with no
  signer. Core's own branch for this configuration —
  `chunk-YOBXHQZK.js:1321`, `RECONCILIATION_SKIPPED`, *"was paid but its fulfillment is failed, and
  'nano' cannot refund. Refund the payer outside Tollstile."* — is therefore unreachable. The charge
  ends at `refund_pending/failed`, which is not terminal, so every later `reconcile()` re-examines it
  and re-emits `REFUND_REJECTED` without ever draining, and `complete('failed').settlement` reports
  `'none'` for a payment the merchant is in fact keeping.
- **The example read model turns "no such block" into "the network is down."**
  `examples/rpc-network-check.mjs:31-34` throws on `data.error`, and a real node answers HTTP 200
  `{"error":"Block not found"}` for a hash that names no block. `NanoRpcRead` requires `undefined` for
  that and reserves a throw for an outcome that cannot be known. Consequence at the gate: a forged hash
  gets `payment_unavailable` / 503 "could not be verified right now" forever instead of a terminal
  `proof_invalid` / 402, and the operator's monitoring reads a provider outage. Safe direction — no
  wrongful admission — and `examples/` is excluded from lint and typecheck, which is why no gate sees it.

## Could not verify

- **No live Nano network.** `test.nano.org` does not resolve; the double-refund measurement is against
  the repository's own fake provider, which is where the rail's seams are.
- `rawFromHeader` reads the MCP `_meta` hash with **no trim** (`src/nano-rail.ts:126-127`), so
  `canonicalHash(" ABC…")` ≠ `canonicalHash("ABC…")` — the same class as the hex-case defect #15 closed,
  and closable with one `.trim()`. **Not reproduced**: the fake's key does not trim either, and whether
  `rpc.nano.to` trims before `decode_hex` needs the live network. Worth one command from a box that can
  reach it.
- Concurrency was checked and is clean: five simultaneous `gate.enter` with one confirmed send give one
  authorization and one settled charge, the rest `request_in_progress`.
