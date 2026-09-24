import { createTollstile, memoryLedger, TollstileError } from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_SIGNATURE_HEADER, NANO_QUOTE_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01; // $1 -> 1e28 raw
const TS = 5 * 60 * 1000; // default Tollstile quote TTL

type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup() {
  const provider = nanoProvider(MERCHANT);
  const clock = fakeClock();
  const toll = createTollstile({
    rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, signer: provider, xnoPerUsd: XNO_PER_USD })],
    ledger: memoryLedger({ clock }),
    clock,
    secret: 'nano-rail-security-test-secret-0123456789',
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
  const payingRequest = async (opts?: { withSignature?: boolean; exactAmount?: string; nonceToSign?: string; quote?: string }) => {
    const { offer, denial, nonce, quoteToken } = await challenge();
    const accepts = offer.challenge.accepts as { amountRaw: string };
    const hash = provider.pay(opts?.exactAmount ?? accepts.amountRaw);
    const headers: Record<string, string> = {
      [NANO_BLOCK_HEADER]: hash,
      [NANO_QUOTE_HEADER]: opts?.quote ?? quoteToken,
    };
    if (opts?.withSignature !== false) headers[NANO_SIGNATURE_HEADER] = provider.sign(opts?.nonceToSign ?? nonce);
    return { headers, hash, nonce, quoteToken, accepts };
  };
  return { provider, toll, clock, gate, enter, challenge, payingRequest };
}

function isDenied(paid: Entry): boolean {
  return paid.kind === 'denied';
}

describe('nano rail security (Yosh102 review fixes)', () => {
  it('L2a: refuses a block whose amount does not EXACTLY match the quote (a donation or off-quote block cannot settle)', async () => {
    const { provider, payingRequest, enter } = setup();
    const { headers, accepts } = await payingRequest({ exactAmount: '1' }); // pay 1 raw, not the quoted 1e28 raw
    expect(BigInt(accepts.amountRaw)).not.toBe(1n);
    const paid = await enter(headers);
    expect(isDenied(paid)).toBe(true);
    expect(provider.settlements()).toBe(0);
  });

  it('L2b: refuses a payment made against an expired quote (no stale block can be redeemed later)', async () => {
    const { provider, clock, payingRequest, enter } = setup();
    const { headers } = await payingRequest();
    clock.advance(TS + 1); // the quote has now expired
    const paid = await enter(headers);
    expect(isDenied(paid)).toBe(true);
    expect(provider.settlements()).toBe(0);
  });

  it('L2c: refuses a quote that was issued for another resource (no cross-request reuse)', async () => {
    const { provider, payingRequest, enter } = setup();
    const { headers } = await payingRequest();
    const other = setup();
    const paid = await other.gate.enter(
      httpContext(new Request('https://example.test/other', { headers }), { resource: 'GET /other' }),
    );
    expect(isDenied(paid)).toBe(true);
    expect(provider.settlements()).toBe(0);
  });

  it('L3a: refuses a valid exact block presented WITHOUT a presenter signature (a copier is not the payer)', async () => {
    const { provider, payingRequest, enter } = setup();
    const { headers } = await payingRequest({ withSignature: false });
    const paid = await enter(headers);
    expect(isDenied(paid)).toBe(true);
    expect(provider.settlements()).toBe(0);
  });

  it('L3b: refuses a signature that does not validate against the source account (forged/other-key signature)', async () => {
    const { provider, payingRequest, enter } = setup();
    // Sign a DIFFERENT nonce than the one this quote requires: the copy is invalid.
    const { headers } = await payingRequest({ nonceToSign: '00000000000000000000000000000000deadbeef' });
    const paid = await enter(headers);
    expect(isDenied(paid)).toBe(true);
    expect(provider.settlements()).toBe(0);
  });

  it('L3c: accepts the payer\'s own valid signature over the fresh nonce (happy path settles)', async () => {
    const { provider, payingRequest, enter } = setup();
    const { headers } = await payingRequest(); // correct nonce, correct key
    const paid = await enter(headers);
    expect(paid.kind).toBe('admitted');
    if (paid.kind === 'admitted') await paid.pass.complete('succeeded');
    expect(provider.settlements()).toBe(1);
  });

  it('L4a: refuses to build without an explicit exchange rate (no silent 0.01 default)', () => {
    const provider = nanoProvider(MERCHANT);
    // Cast around the required-field type on purpose: the test proves the runtime
    // guard rejects a rail built without a rate even if a caller ignores the types.
    const untyped = { merchantAccount: MERCHANT, rpc: provider } as unknown as Parameters<typeof nanoRail>[0];
    expect(() => nanoRail(untyped)).toThrow(TollstileError);
    expect(() => nanoRail(untyped)).toThrow(/explicit, positive xnoPerUsd/);
  });

  it('L4b: ignores any client-carried amount; the vendor names the price via the quote', async () => {
    const { provider, payingRequest, enter } = setup();
    const { headers, accepts } = await payingRequest();
    // Inject a client-carried amount that would previously have overridden the price.
    const paid = await enter({ ...headers, 'x-nano-amount': '9999999999999999999999999999999' });
    // The quoted amount still governs: the block paid the quoted amount, not the header.
    expect(paid.kind).toBe('admitted');
    if (paid.kind === 'admitted') await paid.pass.complete('succeeded');
    expect(provider.settlements()).toBe(1);
    expect(accepts.amountRaw).not.toBe('9999999999999999999999999999999');
  });
});
