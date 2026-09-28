# tollstile-rail-nano — code audit, 2026-09-28 (second run)

Scope: the tree at `691fa33` (`master`), version 0.3.2 — the head the earlier run of the same day left
behind, with its example fix merged. This note is the `b` file for the same reason
`nano-mcp-2026-09-26b.md` was: a second audit run of the same repository on the same day collides on the
dated path. Nothing in the earlier note was changed.

## How it was checked

```
npm ci                 # clean, first attempt
npm test               # 30 passed | 2 skipped   <- baseline
npm run typecheck      # clean
npm run lint           # clean
npm run build          # clean
npm audit --omit=dev   # found 0 vulnerabilities
```

The earlier run of today had just reached the live network and fixed the example's read model. So this
run took the one surface the repository's own tests cannot reach on their own: the **transport shapes
core's `Context` permits but `tollstile/testing` never builds**. `httpContext()` sets `mcp: null` and
`mcpContext()` sets `request: null`, so every test in this repository — and in the conformance suite —
exercises one carrier at a time. Core's type says otherwise, in as many words: *"The HTTP request.
`null` for MCP calls that arrive **without** an HTTP carrier."* MCP over Streamable HTTP has both. The
rail reads three values that can arrive either way, and it reads them in three places.

## Found and fixed

**An empty `x-nano-quote` header hid the quote in `_meta`, and refused a payment that had already
moved on-chain.** `rawFromHeader` (`nano-rail.ts:121`) and `signatureFrom` (`:131`) both skip a header
that is *present but empty* and read `_meta` instead. The quote was read inline with `??`:

```ts
const quoteToken = context.request?.headers.get(NANO_QUOTE_HEADER)
  ?? (typeof metaQuote === 'string' && metaQuote !== '' ? metaQuote : null);
```

`??` is nullish, and `''` is not nullish — so an empty header won and `_meta` was never looked at.
`quoteToken` came out `''`, the `quoteToken ? …` guard made the quote `undefined`, and `verify`
answered `quote_invalid`.

The same paid call, the same `_meta`, measured both ways:

```
mcpContext('report', {block, signature, quote})                      -> admitted
    ... the same, arriving over an HTTP carrier whose three nano
        headers are present but empty                                -> denied  quote_invalid
        "The quote is forged, expired, or for another resource.
         Pay with the new quote in this response."
```

Empty block and signature headers did **not** break it — their two readers handle exactly this. Only the
quote's did not, which is what makes this a copy-paste divergence rather than a policy.

It is the worst failure this rail has. The payer's send is confirmed on-chain before `verify` runs and
**Nano has no chargeback**, so the message above asks an agent to pay a second time for a payment that
went through — and the empty headers are not exotic: `challenge` itself prefills
`x-nano-block: ''` and `x-nano-signature: ''`, so echoing the challenge's header list back is the
obvious client behaviour, and a client that carries its values in `_meta` while echoing that list is
the exact shape that loses money here.

**Fixed** by giving the quote the same reader as its two siblings — `quoteFrom(context)`, header first,
`_meta` second, an empty value skipped in both. One helper, one call site.

### It cannot admit anything new

The fix does not add a path; it stops an empty header masking a path that already exists. After it, the
value goes to the same `terms.openQuote(token)` the plain-MCP path has always used, so a forged or
expired token is still refused by core, and all four block guards (`confirmed`, `destination === merchant`,
`subtype === 'send'`, `amountRaw === expectedRaw`) and the proof-of-possession signature check are
untouched and cannot be routed around. The HTTP-only cases are byte-for-byte unchanged: a missing header
and an empty header both still reach `quote_invalid`.

The second new law pins the direction the change must NOT alter — **a non-empty header still wins over
`_meta`**, so the fallback cannot become a bypass: a forged quote in `_meta` beside a real one in the
header is admitted on the header's, and a forged quote in the *header* beside a real one in `_meta` is
refused.

### Failing, then passing

Against the unfixed `nano-rail.ts`:

```
× nano rail > an empty quote header does not hide the quote in _meta
  → a paid MCP call over an HTTP carrier was denied: quote_invalid
× nano rail > the conformance result the README publishes is the result this suite produces
  → README rail unit test count: expected 23 to be 25
2 failed | 30 passed | 2 skipped
```

The second failure is the repository's own self-counting law doing its job — adding cases moves the
figure the README publishes. It is corrected here (23 → 25), as the earlier run corrected 21 → 23.

With the fix:

```
$ npm test
32 passed | 2 skipped (34)
$ npm run typecheck && npm run lint && npm run build
clean
$ npm audit --omit=dev
found 0 vulnerabilities
```

## Checked and clean

- **No secrets.** Nothing added but a merchant test address and a fake quote secret already used by the
  neighbouring tests; no key, seed, token or `.env` anywhere in the tree.
- **`npm audit --omit=dev`: 0 vulnerabilities** — nothing a consumer installs is advisory-affected.
- **The other two readers** were re-derived rather than assumed: `rawFromHeader` and `signatureFrom` are
  correct for every combination of (header absent / empty / set) × (meta absent / empty / set), which is
  why only one of the three needed changing.
- **The rate path.** `parseRate` refuses a non-finite number, zero, a sign and a non-numeric string with
  `CONFIG_INVALID` rather than a `SyntaxError` from inside the quote; `expandExponent` handles `e+21`
  and `1.5e-7`; `toRaw` is integer-only and rounds down in the payer's favour, and an amount that
  rounds to zero makes `offer` return `null` instead of a free pass.
- **The construction guards** still fail closed for an unusable `verifier`, an unusable `signer` and a
  leftover `onSettled`.
- **`manifest.json`'s runtime-dependency-free claim holds**: `tollstile` (peer) and `node:crypto` are
  still the only non-relative imports in `src/`.
- **The three GitHub links** in `README.md`/`package.json` answer 200.

## Found, not fixed

- **The critical advisory in `devDependencies` is unchanged.** `npm audit` reports 5 (3 moderate, 1 high,
  1 critical) against the `vitest@^2` chain; the critical one needs the Vitest UI server, which this
  repository never starts, and `npm audit --omit=dev` is 0. The only remedy npm offers is `vitest@5`, a
  major bump — a decision, not an oversight.
- **npm still serves an older package.** Local `package.json` is `0.3.2`; publishing is a release
  decision and goes through the swarm's own rail with its secret scan, so nothing was published or
  bumped. **An operator installing from npm today gets the rail without this fix and without this
  morning's example fix.** This is now the second user-visible fix waiting on a publish.
- **`proof_pending` still reaches a payer as "Pay again using this response".** Core's `DenialCode` has
  no in-flight status. Carried from 2026-09-27; it belongs upstream.
- **`nano-provider.ts` mints every fake block hash with the prefix `fail_`** (`hashFor('fail_')`,
  `:68`), including the ones `pay()` returns for a *successful* payment. The fake is published
  (`exports["./testing"]`), so a consumer writing tests against it reads `fail_…` for a block that
  paid. Cosmetic, inside a fake, and renaming it would churn a file nothing is wrong with — reported
  rather than touched.

## Not verified here

- **The rail has still never run end to end on a Nano test network**: no wallet, no funds, and Nano's
  Test Network endpoints still do not resolve. The send/verify/refund path is exercised against the fake
  provider; the read path was verified against the live network by the earlier run today.
- **`https://nano.org` and `https://tollstile.com`** (the README's two external links) still could not
  be fetched: this sandbox's egress gateway answers **403 to CONNECT** for both hosts, which is a
  network policy here and says nothing about the links. Checked deliberately, because a dead link in a
  published README is worth reporting — and a false report of one is worth more than avoiding.
- Nothing was published and no version was bumped.
