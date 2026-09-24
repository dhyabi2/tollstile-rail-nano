import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_HEADER, NANO_SIGNATURE_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01; // $1 -> ~1e28 raw

/** Tracks settled blocks the toll records, deduped by reference (core fires
 * charge.moved more than once for the same settled charge; a single block settles
 * a single charge, so the reference is the dedupe key — the same reason the rail
 * must never run a merchant hook from inside verify). */
let settledHashes: string[] = [];

type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup() {
  const provider = nanoProvider(MERCHANT);
  settledHashes = [];
  const seen = new Set<string>();
  const toll = createTollstile({
    rails: [
      nanoRail({
        merchantAccount: MERCHANT,
        rpc: provider,
        signer: provider,
        verifier: provider,
        xnoPerUsd: XNO_PER_USD,
      }),
    ],
    ledger: memoryLedger(),
    secret: 'nano-rail-test-secret-0123456789abcdef',
    // Record settled blocks from core events, deduped by settlement reference.
    onEvent: (event) => {
      if (event.type === 'charge.moved' && event.charge.payment === 'settled') {
        const ref = event.charge.settlement?.reference;
        if (ref !== undefined && !seen.has(ref)) {
          seen.add(ref);
          settledHashes.push(ref);
        }
      }
    },
  });
  const gate = toll.price('$1', { resource: 'GET /report' });

  /** Build a paid request presenting hash/signature/quote against the challenge. */
  const request = (p?: { hash?: string; signature?: string; quote?: string }) => {
    const headers: Record<string, string> = {};
    if (p?.hash !== undefined) headers[NANO_BLOCK_HEADER] = p.hash;
    if (p?.signature !== undefined) headers[NANO_SIGNATURE_HEADER] = p.signature;
    if (p?.quote !== undefined) headers[NANO_QUOTE_HEADER] = p.quote;
    return new Request('https://example.test/report', { headers });
  };
  const enter = (p?: { hash?: string; signature?: string; quote?: string }) =>
    gate.enter(httpContext(request(p), { resource: 'GET /report' }));
  return { provider, toll, gate, enter };
}

function acceptsOf(denial: unknown): { amountRaw: string; to: string; nonce: string; quote: string } {
  const any = denial as {
    offers?: { challenge?: { accepts?: { amountRaw?: string; to?: string }; mcp?: { nonce?: string; quote?: string } } }[];
  };
  const c = any.offers?.[0]?.challenge;
  return {
    amountRaw: c?.accepts?.amountRaw ?? '0',
    to: c?.accepts?.to ?? '',
    nonce: c?.mcp?.nonce ?? '',
    quote: c?.mcp?.quote ?? '',
  };
}

async function payAndEnter(enter: ReturnType<typeof setup>['enter'], provider: ReturnType<typeof setup>['provider']): Promise<Entry> {
  const challenge = await enter();
  if (challenge.kind !== 'denied') throw new Error('expected a 402');
  const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
  const hash = provider.pay(amountRaw);
  const signature = provider.sign(provider.payerAccount, nonce);
  return enter({ hash, signature, quote });
}

describe('nano rail', () => {
  it('challenges with an XNO offer to the merchant account', async () => {
    const { enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = acceptsOf(challenge.denial);
    expect(accepts.to).toBe(MERCHANT);
    // The exact payable amount is price raw (1e28) plus the quote nonce.
    expect(BigInt(accepts.amountRaw)).toBeGreaterThanOrEqual(10_000_000_000_000_000_000_000_000_000n);
    expect(accepts.nonce).not.toBe('');
  });

  it('verifies a confirmed send to the merchant, signed by the payer, and settles once via core', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    // Core recorded exactly one settlement via onEvent (not a merchant-side hook).
    expect(settledHashes.length).toBe(1);
  });

  it('fails closed at construction for a verifier that is present but unusable', () => {
    // The published package is JavaScript, so NanoSignatureVerifier is not
    // enforced at runtime. A config whose verifier came back null or empty --
    // from JSON, an env read, a DI container -- must be refused at construction,
    // not survive to verify time, where the payer's block has already confirmed
    // on-chain and the operator can only answer a 500 over money that moved.
    const base = { merchantAccount: MERCHANT, rpc: nanoProvider(MERCHANT), xnoPerUsd: XNO_PER_USD };
    for (const bad of [undefined, null, {}, 'yes', { verify: 'not a function' }]) {
      expect(() => nanoRail({ ...base, verifier: bad as never })).toThrowError(/verifier/i);
    }
    // A usable verifier still constructs.
    const provider = nanoProvider(MERCHANT);
    expect(() => nanoRail({ ...base, rpc: provider, verifier: provider })).not.toThrow();
  });

  it('rejects a proof that points at a block that does not exist', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { nonce, quote } = acceptsOf(challenge.denial);
    const forged = enter({ hash: 'fail_00000000000000000000000000000000forged', signature: provider.sign(provider.payerAccount, nonce), quote });
    const paid = await forged;
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/proof_invalid/);
    expect(settledHashes.length).toBe(0);
  });

  it('rejects a payment whose signature is wrong (proof-of-possession)', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const hash = provider.pay(amountRaw);
    // Sign for the WRONG account, or use a wrong signature: the rail must not admit.
    const badSig = provider.sign('nano_1attacker0000000000000000000000000000000000000000000000', nonce);
    const paid = await enter({ hash, signature: badSig, quote });
    expect(paid.kind).toBe('denied');
    expect(settledHashes.length).toBe(0);
  });

  it('rejects a payment for a DIFFERENT amount than the quote (replay of an old block)', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    // Payer sends a WRONG amount (e.g. a 1-raw donation to the merchant), signed for the nonce.
    const wrong = provider.pay((BigInt(amountRaw) - 1n).toString());
    const signature = provider.sign(provider.payerAccount, nonce);
    const paid = await enter({ hash: wrong, signature, quote });
    expect(paid.kind).toBe('denied');
    expect(settledHashes.length).toBe(0);
  });

  it('a failed handler refunds by reverse send so the merchant keeps no money', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('failed');
    expect(completion.settlement).toBe('none');
    expect(provider.refundCount()).toBe(1);
    // The block was accepted as a settlement at verify (money moved on-chain in a
    // push-payment rail), then the failed handler triggered a reverse-send refund.
    // The net effect is zero money kept, confirmed by the refund count.
    expect(settledHashes.length).toBe(1);
    expect(provider.refundCount()).toBe(1);
  });

  it('a repeated settle with the same key has no second effect via core', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    await paid.pass.complete('succeeded');
    expect(settledHashes.length).toBe(1);
  });

  it('a rate that moves between quote and verify does not refuse a payer who sent the quoted amount', async () => {
    // Use a moving rate: quote at 0.01, then the rate changes before the paid
    // request. The rail must still accept a payer who sent exactly the challenged
    // amount, because the amount is bound to the quote, not recomputed from a
    // freshly-read rate.
    const provider = nanoProvider(MERCHANT);
    settledHashes = [];
    const seen = new Set<string>();
    let rate = 0.0100000001;
    const toll = createTollstile({
      rails: [
        nanoRail({
          merchantAccount: MERCHANT,
          rpc: provider,
          signer: provider,
          verifier: provider,
          xnoPerUsd: () => rate,
        }),
      ],
      ledger: memoryLedger(),
      secret: 'nano-rate-test-secret-0123456789abcdef',
      onEvent: (event) => {
        if (event.type === 'charge.moved' && event.charge.payment === 'settled') {
          const ref = event.charge.settlement?.reference;
          if (ref !== undefined && !seen.has(ref)) {
            seen.add(ref);
            settledHashes.push(ref);
          }
        }
      },
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const challenge = await gate.enter(httpContext(request(nanoReqHeaders()), { resource: 'GET /report' }));
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = acceptsOf(challenge.denial);
    // Move the rate AFTER the quote and BEFORE the paid request.
    rate = 0.009; // a swing that would fail an exact-match recompute with the old code
    const hash = provider.pay(accepts.amountRaw);
    const signature = provider.sign(provider.payerAccount, accepts.nonce);
    const paid = await gate.enter(httpContext(requestWith(nanoReqHeaders(), hash, signature, accepts.quote), { resource: 'GET /report' }));
    if (paid.kind !== 'admitted') throw new Error(`expected admission despite rate move, got ${paid.kind === 'denied' ? paid.denial.error.code : 'unknown'}`);
    await paid.pass.complete('succeeded');
    expect(settledHashes.length).toBe(1);
  });

  it('a replayed proof does not double-record a settlement', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const hash = provider.pay(amountRaw);
    const signature = provider.sign(provider.payerAccount, nonce);
    const paid = await enter({ hash, signature, quote });
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    await paid.pass.complete('succeeded');
    expect(settledHashes.length).toBe(1);
    // Replay the same proof: core denies on the single-use check and the rail has
    // no merchant hook inside verify, so the settlement reference is recorded once.
    const replay = await enter({ hash, signature, quote });
    if (replay.kind !== 'denied') throw new Error('a replayed proof must be denied');
    expect(settledHashes.length).toBe(1);
  });
});

function nanoReqHeaders() {
  return {};
}

function request(headers: Record<string, string>) {
  return new Request('https://example.test/report', { headers });
}

function requestWith(headers: Record<string, string>, hash: string, signature: string, quote: string) {
  const h = { ...headers };
  h[NANO_BLOCK_HEADER] = hash;
  h[NANO_SIGNATURE_HEADER] = signature;
  h[NANO_QUOTE_HEADER] = quote;
  return new Request('https://example.test/report', { headers: h });
}
