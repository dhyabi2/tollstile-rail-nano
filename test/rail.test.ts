import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01; // $1 -> 1e28 raw

type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup() {
  const provider = nanoProvider(MERCHANT);
  const toll = createTollstile({
    rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, signer: provider, xnoPerUsd: XNO_PER_USD })],
    ledger: memoryLedger(),
    secret: 'nano-rail-test-secret-0123456789abcdef',
  });
  const gate = toll.price('$1', { resource: 'GET /report' });
  const enter = (hash?: string) =>
    gate.enter(
      httpContext(
        new Request('https://example.test/report', {
          headers: hash === undefined ? {} : { [NANO_BLOCK_HEADER]: hash },
        }),
        { resource: 'GET /report' },
      ),
    );
  return { provider, toll, gate, enter };
}

function acceptsOf(denial: unknown): { amountRaw: string; to: string } {
  const any = denial as { offers?: { challenge?: { accepts?: { amountRaw?: string; to?: string } } }[] };
  return { amountRaw: any.offers?.[0]?.challenge?.accepts?.amountRaw ?? '0', to: any.offers?.[0]?.challenge?.accepts?.to ?? '' };
}

async function payAndEnter(enter: (hash?: string) => Promise<Entry>, provider: ReturnType<typeof setup>['provider']): Promise<Entry> {
  const challenge = await enter();
  if (challenge.kind !== 'denied') throw new Error('expected a 402');
  const { amountRaw } = acceptsOf(challenge.denial);
  const hash = provider.pay(amountRaw);
  return enter(hash);
}

describe('nano rail', () => {
  it('challenges with an XNO offer to the merchant account', async () => {
    const { enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = acceptsOf(challenge.denial);
    expect(accepts.to).toBe(MERCHANT);
    expect(BigInt(accepts.amountRaw)).toBe(10_000_000_000_000_000_000_000_000_000n); // $1 at 1e28 raw
  });

  it('verifies a confirmed send to the merchant and settles once', async () => {
    const { provider, enter } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    expect(provider.settlements()).toBe(1);
  });

  it('rejects a proof that points at a block that does not exist', async () => {
    const { provider, enter } = setup();
    await enter(); // challenge
    const paid = await enter('fail_00000000000000000000000000000000forged');
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/proof_invalid/);
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
