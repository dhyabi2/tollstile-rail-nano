# tollstile-rail-nano — audit 2026-10-10

Previous audit 2026-10-09 (`8d4aaf5`, #18: an unconfirmed block admitted as payment, and an
unsigned one too). HEAD audited: `master` at `8d4aaf5`. Node 22.22.0. Read under one question: can
an agent pay — or get paid — in XNO with this today without being hurt?

Baseline on `master`, every script `package.json` declares:

```
$ npm ci && npm test        # 62 passed | 2 skipped (64)
$ npm run build             # clean
$ npm run typecheck         # clean
$ npm run lint              # clean
```

With this branch: **77 passed | 2 skipped**, and build, typecheck and lint still clean.

This run followed #18's own question to the other place the same field is read.

## Found and fixed — `lookup` still read the block confirmation for truthiness

`#18` put `verify` on an exact read of `NanoBlockInfo.confirmed` (`nano-rail.ts:431-434`:
`confirmed !== true && confirmed !== 'true'`). **`lookup` was left on
`if (block === undefined || !block.confirmed)`** (`nano-rail.ts:518` on `8d4aaf5`) — the same
`!value` test, in the same file, on the same field from the same operator-supplied `rpc`.

The measured premise is #18's and it is in this repository already: against rpc.nano.to,
`block_info` for a confirmed send answers `confirmed: "true"` — a **string** —
which `examples/rpc-network-check.mjs:54` documents and normalises
(`data.confirmed === true || data.confirmed === 'true'`). An operator who maps the field straight
across (`confirmed: data.confirmed`) therefore hands this line the string `"false"` for a block the
network has **not** cemented, and `!"false"` is `false`.

`lookup` is the read core **comes back to**: `refund`'s own comment in this file spells out the
path — a reverse send that cannot be confirmed leaves the charge `unknown`, "the only state core
revisits with `lookup` to find out whether the reverse send actually landed". Answering `settled`
there books the payment with no further check, so the uncemented-block-reported-as-paid outcome
#18 closed at the gate stayed reachable through reconciliation.

Fixed by reading `confirmed` in `lookup` exactly as `verify` reads it. This only narrows what is
reported settled — `true` and `"true"` still reconcile as settled, `undefined`/`false`/`null`/`0`/`""`
still report `none`, and a block the node has never heard of still reports `none`. No amount,
destination, rounding or key path changes, and nothing on the send path moves.

Seven tests fail on `8d4aaf5` and pass here, including the string `"false"` and six truthy
non-confirmations (`"maybe"`, `1`, `{}`, `[]`, `"TRUE"`, `"1"`), with the five plainly-unconfirmed
forms and both real confirmations kept as controls.

The README's published `Rail unit tests: **34 passed**` is updated to **36** in the same change,
because `test/rail.test.ts`'s own count law
(`the conformance result the README publishes is the result this suite produces`) counts the `it(`
cases and fails otherwise. That law caught it on the first run of this branch, which is what it is
for.

## Checked and sound

- **`nano-provider.ts:112`** reads `block.confirmed` for truthiness too, and is **correct as is**:
  it is the in-repository fake network, and `confirmedSend` is the only thing that writes a block
  there, always with the boolean `true`. It never sees an operator's RPC.
- **The proof binding, all three legs.** The amount must equal the quote's own offer amount plus
  the quote nonce exactly (`payableOf`, read from the quote, never recomputed from a live rate);
  the destination must be `merchantAccount` and the subtype `send`; and the presenter must sign the
  quote nonce with the key that sent the block, with `ok === true` the only accepted answer.
- **Integer arithmetic throughout.** `toRaw` is `bigint` only, `parseRate` parses a decimal string
  (expanding an exponent through `expandExponent` before `BigInt`), and the price is rounded **down**
  to a multiple of `10^10` raw so the nonce digits can never overlap it. No float touches an amount.
  `payableFor` refuses an amount that is not `/^\d+$/`.
- **The hash is canonicalised to upper case before it becomes `proofId`/`idempotencyKey`**, so the
  payer cannot mint a second identity for one send by changing its case (#15); the fake's ledger is
  keyed case-insensitively too, so the suite can see that.
- **Both failure directions on the refund.** A throwing `signer.sendFor` is reported
  `PROVIDER_UNAVAILABLE`, which is the only class core's `callProvider` turns into a reconcilable
  `unknown`; a raw error would strand the charge at `refund_pending` with the merchant holding the
  money.
- **Construction fails closed** on a missing/unusable `verifier`, an unusable `signer`, and the
  removed `onSettled`.
- **Branches.** 19 remote branches; every one is either merged (the ahead-by-1 squash artefact) or
  already recorded as superseded in `TIER0.md` (`dune/fix-rail-binding`,
  `ivy/tollstile-nano-security-fix`). **0 open pull requests before this one.**

## Could not verify

- No Nano test network: the README's own test-network status still holds —
  `test.nano.org` does not resolve, and the Beta faucet is a Discord channel. The confirmation
  semantics this change turns on were taken from the fixture in `test/rail.test.ts` (captured from
  rpc.nano.to, `confirmed: "true"`) and from `examples/rpc-network-check.mjs`, not re-measured: no
  Nano RPC host is reachable from this session (the agent proxy answers 403).
- `lookup` was exercised directly rather than through a charge that core had left `unknown`;
  driving core into that state needs a refund whose send fails, which the fake cannot produce
  without a second fault hook.
