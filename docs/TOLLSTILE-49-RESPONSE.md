# Tollstile#49: Yosh102's six requested changes, point by point

Status on 2026-11-02. "In master" means the commit is on `master` of dhyabi2/tollstile-rail-nano. "On npm" means the published
`tollstile-rail-nano@0.3.1`. 0.4.0 is **neither tagged nor published**; a `v0.4.0` tag will follow the merge of pull request #21, and publishing is the owner's step. The existing `v0.3.2` tag (`d519b58`) predates these fixes; do not install it.

| # | Requested change | Where it stands | Evidence |
|---|---|---|---|
| 1 | Rate not locked at quote time: `verify` recomputed the amount from a fresh rate | **Done, in master, on npm (0.3.0+).** `verify` reads the nano offer the quote itself carries (`quote.offers.find(o => o.rail === 'nano')`, `details.amountRaw`) and never calls the rate. | `0e62578`; test "a rate that moves between quote and verify" in `test/rail.test.ts`; README "Proof is bound to the purchase and its payer", point 1 |
| 2 | `onSettled` inside `verify` fires again on replay | **Done, in master, on npm (0.3.0+).** The hook is gone; passing `onSettled` throws `CONFIG_INVALID` naming `onEvent` (`authorization.opened` with `created: true`, `charge.moved`). | `0e62578`; `src/nano-rail.ts` (the `onSettled` guard); tests count core's events raw under replay and `Idempotency-Key` retries |
| 3 | Fail closed at construction, not at verify | **Done, in master.** `nanoRail()` throws `CONFIG_INVALID` when the verifier is missing or unusable (`null`, `{}`), and likewise for an unusable refund signer. A `merchantAccount` that is not a Nano address is **not** yet refused at construction (open pull request #22; #24 was closed unmerged): a wrong one refuses every payment after it confirmed, so operators must check theirs. The rate check, the other after-payment throw, is gone with #1. | `0e62578`, `a32b5f0` (verifier present but unusable), `28d8d33` (signer) |
| 4 | 32-bit nonce, and a comment claiming more | **Done, in master, on npm (0.3.0+); wording corrected in 0.4.0.** SHA-256 instead of FNV, last 8 bytes reduced below 10^10 (~33 bits). The README now says the amount distinguishes quotes with high probability, not certainty; single-use of the block hash and the signature from the block's source do the rest. We did not add a per-quote derived account: that is the stronger answer you named, not in this release. | `0e62578`, `37d4ce7`; README point 1; the q_1 -> 8247539591 pin in the #21 branch |
| 5 | Run once on Nano's test network, paste the output | **NOT DONE.** Only the read path was run against the live public network (`examples/rpc-network-check.mjs`, read-only `block_info`, no funds moved). A quote, send, verify, replay, handler-failure refund and lookup pass needs a funded test-network signer, which the agents here do not hold. The README says so under "Test-network status". | `599cd4c`; README |
| 6 | `repository` field pointed at a deleted account | **Done on npm (0.3.0+).** 0.3.0 and 0.3.1 carry `git+https://github.com/dhyabi2/tollstile-rail-nano.git`; only 0.1.0 and 0.2.0 still name the deleted account. (Checked with `npm view tollstile-rail-nano@<v> repository.url` on 2026-11-02.) | `0e62578`; registry |

Smaller things from the same comment: `.ledger/` removed (`0e62578`); `manifest.json` no longer claims runtime dependencies it does not have
(its `design_note` says they are the patterns the rail was designed from); `package-lock.json` tracks the package version; `tsx` dropped; `lint` runs eslint;
`toRaw` takes a decimal string and refuses exponents and noisy floats with a named error; the MCP `_meta` path, a settle repeated with the same key,
and a rate that moves between quote and verify each have a test.

## What 0.4.0 adds beyond your list

Three release blockers found afterwards (see CHANGELOG): an empty npm package, a nonce regression against 0.3.1 quotes, and a double refund on reconcile.
The first two would have made `npm i tollstile-rail-nano@0.4.0` a rail that cannot be paid or does not install.

## Left for the owner

1. Merge pull request #21 (this branch merges `master` into it; `npm test`: 102 passed, 2 skipped).
2. `npm ci && npm run build && npm pack --dry-run` must show 17 files, then `npm publish`.
3. Only after 0.4.0 is live: one comment on tollstile/Tollstile#52 with this table. Do not comment before the release.
4. The test-network pass (#5), which needs a funded signer.
