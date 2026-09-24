import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_SIGNATURE_HEADER, NANO_QUOTE_HEADER } from '../src/nano-types.js';

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
  const enter = (headers: Record<string, string>) =>
    gate.enter(httpContext(new Request('https://example.test/report', { headers }), { resource: 'GET /report' }));
  const challenge = async () => {
    const entry = await enter({});
    if (entry.kind !== 'denied') throw new Error('expected a 402');
    const offer = entry.denial.offers.find((c) => c.offer.rail === 'nano');
    if (!offer) throw new Error('no nano offer');
    const body = (entry.denial as unknown as { body?: Record<string, unknown> }).body ?? {};
    return { offer, denial: entry.denial, nonce: String(body.nonce ?? ''), quoteToken: String(body.quote ?? '') };
  };
  const payRequest = async (opts?: { withSignature?: boolean }) => {
    const { offer, denial, nonce, quoteToken } = await challenge();
    const accepts = offer.challenge.accepts as { amountRaw: string };
    const hash = provider.pay(accepts.amountRaw);
    const headers: Record<string, string> = {
      [NANO_BLOCK_HEADER]: hash,
      [NANO_QUOTE_HEADER]: quoteToken,
    };
    if (opts?.withSignature !== false) headers[NANO_SIGNATURE_HEADER] = provider.sign(nonce);
    return { headers, hash, nonce, quoteToken };
  };
  const pay = async () => {
    const { headers } = await payRequest({ withSignature: true });
    return enter(headers);
  };
  return { provider, toll, gate, enter, challenge, payRequest, pay };
}

function acceptsOf(denial: unknown): { amountRaw: string; to: string } {
  const any = denial as { offers?: { challenge?: { accepts?: { amountRaw?: string; to?: string } } }[] };
  return { amountRaw: any.offers?.[0]?.challenge?.accepts?.amountRaw ?? '0', to: any.offers?.[0]?.challenge?.accepts?.to ?? '' };
}

describe('nano rail', () => {
  it('challenges with an exact XNO offer to the merchant account and a quote token to sign', async () => {
    const { challenge } = setup();
    const { denial, offer } = await challenge();
    const accepts = acceptsOf(denial);
    expect(accepts.to).toBe(MERCHANT);
    expect(BigInt(accepts.amountRaw)).toBe(10_000_000_000_000_000_000_000_000_000n); // $1 at 1e28 raw
    const acc = offer.challenge.accepts as { quoteToken: string; sign: string };
    expect(typeof acc.quoteToken).toBe('string');
    expect(acc.quoteToken.length).toBeGreaterThan(0);
    expect(acc.sign).toMatch(/nonce/);
  });

  it('verifies a confirmed exact send with a valid presenter signature and settles once', async () => {
    const { provider, pay } = setup();
    const paid = await pay();
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}: ${paid.denial.error.message}`);
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    expect(provider.settlements()).toBe(1);
  });

  it('rejects a proof that points at a block that does not exist', async () => {
    const { provider, enter } = setup();
    const paid = await enter({ [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged' });
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/^(proof_invalid|quote_)/);
    expect(provider.settlements()).toBe(0);
  });

  it('rejects a valid block presented without the payer signature (a copier cannot prove it is the payer)', async () => {
    const { provider, enter, payRequest } = setup();
    const { headers } = await payRequest({ withSignature: false });
    const paid = await enter(headers);
    expect(paid.kind).toBe('denied');
    expect(provider.settlements()).toBe(0);
  });

  it('a failed handler refunds by reverse send so the merchant keeps no money', async () => {
    const { provider, pay } = setup();
    const paid = await pay();
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('failed');
    expect(completion.settlement).toBe('none');
    expect(provider.refundCount()).toBe(1);
    expect(provider.settlements()).toBe(1);
  });

  it('a repeated settle with the same key has no second effect', async () => {
    const { provider, pay } = setup();
    const paid = await pay();
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    await paid.pass.complete('succeeded');
    expect(provider.settlements()).toBe(1);
  });
});
