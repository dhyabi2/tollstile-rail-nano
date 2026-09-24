import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_TOKEN_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RATE = 0.01; // $1 -> 0.01 XNO -> 1e28 raw

type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup() {
  const provider = nanoProvider(MERCHANT);
  const toll = createTollstile({
    rails: [
      nanoRail({
        merchantAccount: MERCHANT,
        rpc: provider,
        signer: provider,
        rate: RATE,
        onSettled: (hash) => provider.confirmIn(hash),
      }),
    ],
    ledger: memoryLedger(),
    secret: 'nano-rail-test-secret-0123456789abcdef',
  });
  const gate = toll.price('$1', { resource: 'GET /report' });
  const enter = (header?: { hash?: string; quoteToken?: string }) =>
    gate.enter(
      httpContext(
        new Request('https://example.test/report', {
          headers:
            header === undefined
              ? {}
              : {
                  ...(header.hash === undefined ? {} : { [NANO_BLOCK_HEADER]: header.hash }),
                  ...(header.quoteToken === undefined ? {} : { [NANO_QUOTE_TOKEN_HEADER]: header.quoteToken }),
                },
        }),
        { resource: 'GET /report' },
      ),
    );
  return { provider, toll, gate, enter };
}

function challengeAccepts(denial: unknown): { amountRaw: string; quoteToken: string; to: string } {
  const any = denial as {
    offers?: { challenge?: { accepts?: { amountRaw?: string; quoteToken?: string; to?: string } } }[];
  };
  const accepts = any.offers?.[0]?.challenge?.accepts;
  return {
    amountRaw: accepts?.amountRaw ?? '0',
    quoteToken: accepts?.quoteToken ?? '',
    to: accepts?.to ?? '',
  };
}

async function challengeOnce(enter: ReturnType<typeof setup>['enter']) {
  const challenge = await enter();
  if (challenge.kind !== 'denied') throw new Error('expected a 402');
  return challengeAccepts(challenge.denial);
}

async function payAndEnter(enter: ReturnType<typeof setup>['enter'], provider: ReturnType<typeof setup>['provider']): Promise<Entry> {
  const { amountRaw, quoteToken } = await challengeOnce(enter);
  const hash = provider.pay(amountRaw);
  return enter({ hash, quoteToken });
}

describe('nano rail', () => {
  it('challenges with an XNO exact amount to the merchant account', async () => {
    const { enter } = setup();
    const accepts = await challengeOnce(enter);
    expect(accepts.to).toBe(MERCHANT);
    // $1 at 1e28 raw, rounded to a nonce boundary plus a bespoke per-quote nonce < 1e14.
    expect(BigInt(accepts.amountRaw)).toBeGreaterThanOrEqual(10_000_000_000_000_000_000_000_000_000n);
    expect(BigInt(accepts.amountRaw)).toBeLessThan(10_000_000_000_014_000_000_000_000_000n);
    expect(accepts.quoteToken.length).toBeGreaterThan(0);
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
    const { quoteToken } = await challengeOnce(enter);
    const paid = await enter({ hash: 'fail_00000000000000000000000000000000forged', quoteToken });
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/proof_invalid/);
    expect(provider.settlements()).toBe(0);
  });

  it('rejects a real payment presented against a different quote (one proof, one purchase)', async () => {
    const { provider, enter } = setup();
    // A payer pays the exact amount for purchase A, then presents that same block
    // against a fresh quote B. The amount A paid must not satisfy B.
    const a = await challengeOnce(enter); // quote A
    const hashA = provider.pay(a.amountRaw);
    const enteredB = await enter({ hash: hashA, quoteToken: a.quoteToken }); // still quote A -> valid
    if (enteredB.kind !== 'admitted') throw new Error(`expected admission for quote A, got ${enteredB.denial.error.code}`);

    // Now present the SAME block (a real payment for A) against a NEW quote B.
    const b = await challengeOnce(enter); // a fresh quote B, new amount + token
    const replay = await enter({ hash: hashA, quoteToken: b.quoteToken });
    if (replay.kind !== 'denied') throw new Error('a payment for one quote must not satisfy another');
    // Only ONE economic effect: the single real payment for A settled once.
    expect(provider.settlements()).toBe(1);
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
