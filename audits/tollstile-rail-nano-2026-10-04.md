# tollstile-rail-nano — audit 2026-10-04

Lens: can an agent pay a Tollstile-gated endpoint in XNO with this, today, without being hurt?

Baseline on `master` `61e8c54`: `npm ci` clean, **34 passed / 2 skipped**, `npm run lint` clean,
`npm run build` clean.

## Checked

- `src/nano-rail.ts` end to end: `offer` -> `challenge` -> `verify` -> `settle` / `refund` /
  `lookup` / `receipt` / `redact`.
- Amount handling: `parseRate`, `expandExponent`, `toRaw`, `payableFor`, `payableOf`. All integer
  (`bigint`); no float reaches an amount anywhere on the path, and the rate is read once, at quote
  time, never in `verify`.
- What `verify` trusts from the payer: the block hash, the signature, the quote token.
- The refund reconciliation contract against the installed `tollstile@0.1.2`
  (`resolveUnknown` in `dist/chunk-YOBXHQZK.js`).
- `examples/rpc-network-check.mjs`'s read model against the live public RPC.
- `README.md` claims, including the install snippet and the test-count law.

## Found and fixed — one confirmed send could settle TWO charges

`verify` read the payer's block hash out of the request and used it verbatim as `proofId`
(`src/nano-rail.ts:353-354`, `:361`, `:400`, `:407`). Core's single-use check is

```js
// tollstile/dist/chunk-YOBXHQZK.js:627
const authorization = await runtime.ledger.getAuthorization(await deriveId("auth", rail.name, proofId));
```

so the *text* of that header is the whole identity of the payment — and **a Nano block hash is
case-insensitive**. Measured against the public RPC on 2026-10-04:

```
block_info E792FD1FE71FA6C111BC5545747F828348C3CE2EBE8D3173D0BE344F09FC62FE  -> block
block_info e792fd1fe71fa6c111bc5545747f828348c3ce2ebe8d3173d0be344f09fc62fe  -> the SAME block
```

Present one confirmed send as `ABCD…`, then as `abcd…`: core derives a different authorization id,
opens a second authorization, and **settles a second charge off one payment**. The quote does not
close it — a quote is a stateless HMAC token (`quotes.open`, `:1204`), openable as often as you like
until it expires, so every replay inside the TTL is free. Nor does the amount nonce: it is the same
quote, so the same amount matches.

Fixed by canonicalising the presented hash (upper case) before it is used for anything — the RPC
lookup, `proofId`, `idempotencyKey`, `data.hash`, and the settlement reference. It is a refusal and
nothing else: a payment admitted before is still admitted, for the same amount to the same
destination; only the *second* presentation changes, from a second charge to core's `already_paid`
(409, `action: stop`, "It is not charged or run again").

**The fake network was hiding it.** `nano-provider.ts` keyed its block map by the exact string, so a
recased hash read as a forged one and refused for the wrong reason (`proof_invalid`). Its own
docstring promises it "behaves like Nano in the ways the rail depends on", and the rail depends on
exactly this, so it now keys by the canonical form too — which is what let the test see the real
defect.

Failing-then-passing, with the test and the fake kept and `src/nano-rail.ts` alone reverted to
`master`:

```
a recasing of a spent block must not be admitted: expected 'admitted' not to be 'admitted'
```

After: **35 passed / 2 skipped**, lint clean, `tsc -p tsconfig.build.json` clean.

## Checked and found sound

- **`lookup` during a refund.** `refund`'s comment says core calls `lookup` "to find out whether the
  reverse send actually landed", and `lookup` only ever reads the ORIGINAL payment block — so it can
  never answer that. It does not need to: `resolveUnknown` (`:1351`) treats BOTH `settled` and
  `none` with `charge.pending === "refund"` as "move to `refund_pending` and call `performRefund`
  again". Either answer retries the refund, which is the right outcome. Not a defect; the comment is
  looser than the code.
- **Amounts.** `toRaw` is integer throughout and rounds DOWN by less than `10^10` raw (1e-20 XNO),
  in the payer's favour, with the low digits reserved for the quote nonce. `offer` returns `null`
  rather than a zero-amount offer. `verify` compares `block.amountRaw` to the quote's own offer
  EXACTLY, never to a recomputed rate.
- **Fail-closed construction.** A missing, null or half-built `verifier` or `signer` is refused at
  construction, not at verify time after the payer's block has confirmed.
- **The example's read model** maps a live `block_info` correctly: `confirmed` arrives as the STRING
  `"true"`, and a send's destination is `contents.link_as_account` with no fallback to
  `block_account` (which is the sender).

## Could not verify

- **No end-to-end run on a real Nano network.** Unchanged from previous audits: `test.nano.org` does
  not resolve and the Beta faucet is a Discord channel, so the send/verify/refund path is exercised
  against the fake provider. The read path was checked against the live public RPC this run, which
  is also how the case-insensitivity above was measured.
- **Account-string canonicalisation is NOT addressed here.** `verify` compares
  `block.destination !== merchant` as text. A merchant configured with an `xrb_`-prefixed address
  while the node answers `nano_` would have every payment refused. No defect is claimed: every
  address in this tree is `nano_`, modern nodes answer `nano_`, and the fix would WIDEN what is
  accepted on the money path, so it is noted for a person rather than changed.
- **`origin/test/unexercised-verify-guards`** is 1 ahead / 9 behind `master` and its diff would
  delete the CI workflow, six audit notes, `eslint.config.js` and `test/harness.ts`. It is based on a
  pre-09-28 commit and is stale, not forgotten work.
