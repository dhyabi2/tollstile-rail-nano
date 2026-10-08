# tollstile-rail-nano — audit 2026-10-08

Lens: can an agent pay a Tollstile-gated endpoint in XNO with this, today, without being hurt?

Baseline on `master` `d63d4f2`: `npm ci` clean, **35 passed / 2 skipped**, `npm run lint`,
`npm run build` and `npm run typecheck` clean. After this branch: **36 passed / 2 skipped**.

Eleven audits have now read this tree. Each one read the *source*. This run asked the question none
of them asked: **what does an agent actually get when it installs the package the README tells it to
import?**

## Found — every version on npm settles two charges off one confirmed send

`npm view tollstile-rail-nano` answers `latest = 0.3.1`, published **2026-09-24**. This repository is
`0.3.2`. The four versions on npm — `0.1.0`, `0.2.0`, `0.3.0`, `0.3.1` — were all published that same
day, and **nothing has been published since**, so every fix of the last fortnight is in git only. Two
of them are money defects that reach a payer:

- **#15, 2026-10-04 — one confirmed send settles TWO charges.** `verify` passed the payer's block
  hash through verbatim as `proofId`, and core's single-use check is
  `deriveId('auth', rail.name, proofId)`, so the payer chose the identity of their own payment. A Nano
  block hash is case-insensitive on the network. Fixed on `master` by `canonicalHash`.
- **The empty-header quote fallback — a paid request answered `quote_invalid`.** The quote token was
  read with `??`, which is nullish, so a header present but EMPTY beat the quote in the MCP `_meta`.
  A client echoing the challenge's own prefilled headers over a Streamable-HTTP carrier sends exactly
  that. The payer's send is confirmed on-chain by then and Nano has no chargeback.

Both were found and fixed by earlier audits of this repository, and both are still live for anyone
who installs it. **Measured against the real published package**, not argued from the diff: a fresh
project (`npm i tollstile@0.1.2 tollstile-rail-nano@0.3.1`), core driven through `gate.enter`, and a
fake network whose only Nano-specific behaviour is that `block_info` answers the same block for either
hex case — which is what the live RPC does, measured on 2026-10-04 and recorded in
`src/nano-provider.ts`:

```
402 challenge: pay 10000000000000000003952791648 raw to the merchant
payer published ONE confirmed send: E792FD1FE71FA6C111BC5545747F828348C3CE2EBE8D3173D0BE344F09FC0000
presentation 1 (as sent)  -> admitted
presentation 2 (lowercased, SAME block on the network) -> admitted
---
sends the payer actually made : 1
authorizations opened         : 2
charges SETTLED               : 2
VULNERABLE: 2 charges settled off 1 payment(s)
```

On this repository's `master` the same second presentation is `denied` / `already_paid`, which is what
`test/rail.test.ts`'s own recasing test asserts.

**Two incidental facts about the published versions, recorded because they shape the advisory and not
because they are defects to fix here.** `0.3.1` refuses a decimal *string* rate outright
(`xnoPerUsd must be a positive number or a function returning one`), so the rate had to be passed as a
number to reach the defect at all — the README shipped inside `0.3.1` matches that older behaviour, so
the published artefact is at least self-consistent on this point. And `0.3.1` reads the rate through
`String(xnoPerUsd)`, so a float rate's noise is expanded as text rather than multiplied as a float;
the amount arithmetic there is `bigint`, as it is on `master`.

## Fixed here

**Publishing is the owner's**, always — so this branch does the half a repository can do: it says so,
in the place a reader looks before installing, and it makes the suite own the version number.

- `README.md` carries the advisory above its `## Install` section, with the measured output, the
  affected versions, and the version to require.
- One test, in the idiom this repository already uses for its test-count claim: the version the README
  tells you to require must be `package.json`'s version, and the advisory must not list this package's
  own version among the affected ones. An advisory that names a version goes stale the moment the
  version moves, so the suite owns the number rather than a reader noticing.

**There is no failing-then-passing test for the defect itself, and this branch does not claim one.**
The defect is not in this tree — it is in an artefact on a registry this repository cannot write to.
The reproduction above is the evidence, and it runs against the published package, not against a
mutant of `master`. What the new test does catch is the advisory going stale, and it was mutation-
checked both ways: pointing `Require` at `0.3.1` fails it (`expected '0.3.1' to be '0.3.2'`), and
listing `0.3.2` among the affected versions fails it (`expected ... not to contain '0.3.2'`).

The README's own rail-unit-test count moved 28 → 29 in the same commit, because the test that counts
the suite counts itself.

## Checked and found sound

- The committed `dist/` is not in the tree (`files: ["dist", "README.md"]`, built at publish), so
  nothing stale is being served out of git.
- `tollstile-rail-nano` is the only **public npm** package among the Tier 0 repositories:
  `holderPay` and `proof-agent-skill` are `private: true` in `package.json`. Of the eleven Python
  distribution names under Tier 0, ten answer 404 on `pypi.org/pypi/<name>/json`
  (`nano-wallet-xno`, `nano-mcp` — which is both `nano-mcp` and `nano-mcp-public` —
  `nano-settlement-verify`, `nano-accept-settle`, `nano-invoice`, `dual-rail`,
  `agent-wallet-multirail`, `openai-agents-nano`, `gpt-researcher-x402-retriever`,
  `langchain-vend`). Their READMEs install from git, which is the current tree, so there is no
  second stale artefact of this kind. The eleventh, `vend`, resolves to a PyPI project at `0.1`
  that is **not** ours and is not what `dhyabi2/vend`'s README tells anyone to install; it was not
  investigated further and nothing here depends on it.
- `npm view tollstile` confirms the peer dependency `tollstile@0.1.2` that `node_modules` carries is
  the published latest, so the rail is not pinned behind its core.

## Could not verify

- **No end-to-end run on a real Nano network.** Unchanged from every previous audit: `test.nano.org`
  does not resolve and the Beta faucet is a Discord channel.
- **Whether any merchant is running a published version today** is not knowable from here. npm's
  download counts were not read, and a merchant may well be installing from git.
- The reproduction uses a fake network written for it rather than this repository's
  `src/nano-provider.ts`, because that file is TypeScript and the published package resolves its own
  name inside this checkout. The fake models one property only: a case-insensitive `block_info`.
