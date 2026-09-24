import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_HEADER, NANO_SIGNATURE_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01; // $1 -> 1e28 raw

type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup() {
  const provider = nanoProvider(MERCHANT);
  const toll = createTollstile({
    rails: [
      nanoRail({
        merchantAccount: MERCHANT,
        rpc: provider,
        signer: provider,
        verifier: provider,
        // Record each block the rail admits as a settlement in the fake provider.
        onSettled: (block) => provider.confirmIn(block.hash),
        xnoPerUsd: XNO_PER_USD,
      }),
    ],
    ledger: memoryLedger(),
    secret: 'nano-rail-test-secret-0123456789abcdef',
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

  it('verifies a confirmed send to the merchant, signed by the payer, and settles once', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    expect(provider.settlements()).toBe(1);
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
    expect(provider.settlements()).toBe(0);
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
    expect(provider.settlements()).toBe(0);
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
    expect(provider.settlements()).toBe(0);
  });

  it('a failed handler refunds by reverse send so the merchant keeps no money', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('failed');
    expect(completion.settlement).toBe('none');
    expect(provider.refundCount()).toBe(1);
    // Total accepted settlements net of the refund: the failed charge is refunded.
    expect(provider.settlements()).toBe(1);
  });

  it('a repeated settle with the same key has no second effect', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    await paid.pass.complete('succeeded');
    expect(provider.settlements()).toBe(1);
  });
});
