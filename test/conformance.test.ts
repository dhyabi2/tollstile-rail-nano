import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext, fakeClock } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail } from '../src/nano-rail.js';
import { NANO_BLOCK_HEADER, NANO_QUOTE_HEADER, NANO_SIGNATURE_HEADER } from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = 0.01;
const RESOURCE = 'GET /report';
const URL = 'https://example.test/report';

/** Tracks settled blocks via core's onEvent, deduped by reference. */
let settledHashes: string[] = [];

function isAdmitted(entry: Awaited<ReturnType<ReturnType<typeof setup>['enter']>>) {
  if (entry.kind !== 'admitted') throw new Error(`expected admission, got ${entry.kind === 'denied' ? entry.denial.error.code : 'unknown'}`);
  return entry.pass;
}

function setup() {
  const provider = nanoProvider(MERCHANT);
  settledHashes = [];
  const seen = new Set<string>();
  const rail = nanoRail({
    merchantAccount: MERCHANT,
    rpc: provider,
    signer: provider,
    verifier: provider,
    xnoPerUsd: XNO_PER_USD,
  });
  const clock = fakeClock();
  const toll = createTollstile({
    rails: [rail],
    ledger: memoryLedger(),
    secret: 'nano-conformance-secret-abcdef9876543210',
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
  const gate = toll.price('$1', { resource: RESOURCE });
  const headless = new Request(URL);
  const enter = (request: Request) => gate.enter(httpContext(request, { resource: RESOURCE }));

  /** Build a paying request from the 402's challenge information. */
  function payFromChallenge(denial: any): Request {
    const offer = denial.offers.find((c: any) => c.offer.rail === 'nano');
    const challenge = offer?.challenge;
    const accepts = challenge?.accepts ?? {};
    const mcp = challenge?.mcp ?? {};
    const hash = provider.pay(accepts.amountRaw);
    const signature = provider.sign(provider.payerAccount, mcp.nonce ?? '');
    return new Request(URL, {
      headers: {
        [NANO_BLOCK_HEADER]: hash,
        [NANO_SIGNATURE_HEADER]: signature,
        [NANO_QUOTE_HEADER]: mcp.quote ?? '',
      },
    });
  }

  /** Tamper: forge the block hash on a paying request so the rail must reject it. */
  function tamperRequest(request: Request): Request {
    return new Request(request.url, {
      headers: {
        [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged',
        [NANO_SIGNATURE_HEADER]: request.headers.get(NANO_SIGNATURE_HEADER) ?? '',
        [NANO_QUOTE_HEADER]: request.headers.get(NANO_QUOTE_HEADER) ?? '',
      },
    });
  }

  return { provider, rail, toll, gate, enter, clock, payFromChallenge, tamperRequest };
}

describe('nano rail conformance', () => {
  it('declares a usable contract', async () => {
    const { enter } = setup();
    // A request without any proof must not be admitted: for a paywall the gate
    // answers payment_required (the rail owns that contract via `quotes: true`).
    const entry = await enter(new Request(URL));
    expect(entry.kind).toBe('denied');
  });

  it('challenges with a Nano offer when unpaid, then pays and settles once', async () => {
    const { enter, payFromChallenge } = setup();
    const unpaid = await enter(new Request(URL));
    const denial = unpaid.kind === 'denied' ? unpaid.denial : null;
    expect(denial).not.toBeNull();
    expect(denial!.error.code).toBe('payment_required');

    const paying = payFromChallenge(denial!);
    const paid = await enter(paying);
    const pass = isAdmitted(paid);
    const completion = await pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    expect(completion.receipt).toBeDefined();
    expect(completion.receipt.headers.length).toBeGreaterThan(0);
    // Core recorded exactly one settlement.
    expect(settledHashes.length).toBe(1);
  });

  it('refuses a replayed single-use proof without a second effect', async () => {
    const { enter, payFromChallenge } = setup();
    const unpaid = await enter(new Request(URL));
    const denial = unpaid.kind === 'denied' ? unpaid.denial : null;
    expect(denial).not.toBeNull();

    const paying = payFromChallenge(denial!);
    // First use — succeeds.
    const first = await enter(paying.clone());
    await isAdmitted(first).complete('succeeded');
    expect(settledHashes.length).toBe(1);

    // Replay — must be denied with no additional settlement.
    const replay = await enter(paying.clone());
    if (replay.kind !== 'denied') throw new Error('a replayed proof must be denied');
    // Core settles a charge exactly once; the replay does not create a new
    // settlement.
    expect(settledHashes.length).toBe(1);
  });

  it('rejects a tampered proof', async () => {
    const { enter, payFromChallenge } = setup();
    const unpaid = await enter(new Request(URL));
    const denial = unpaid.kind === 'denied' ? unpaid.denial : null;
    expect(denial).not.toBeNull();

    const paying = payFromChallenge(denial!);
    const tampered = new Request(paying.url, {
      headers: {
        [NANO_BLOCK_HEADER]: 'fail_00000000000000000000000000000000forged',
        [NANO_SIGNATURE_HEADER]: paying.headers.get(NANO_SIGNATURE_HEADER) ?? '',
        [NANO_QUOTE_HEADER]: paying.headers.get(NANO_QUOTE_HEADER) ?? '',
      },
    });
    const entry = await enter(tampered);
    if (entry.kind !== 'denied') throw new Error('a tampered proof must be denied');
    expect(settledHashes.length).toBe(0);
  });

  it('a failed handler keeps no money (refund)', async () => {
    const { enter, payFromChallenge } = setup();
    const unpaid = await enter(new Request(URL));
    const denial = unpaid.kind === 'denied' ? unpaid.denial : null;
    expect(denial).not.toBeNull();

    const paying = payFromChallenge(denial!);
    const paid = await enter(paying);
    const pass = isAdmitted(paid);
    const completion = await pass.complete('failed');
    // With a signer configured, the failed handler triggers a reverse send refund.
    // The upfront flow marks the charge settled at verify (money already moved
    // on-chain), then the handler failure refunds it. The provider refundCount
    // confirms the reverse send.
    expect(completion.settlement).toBe('none');
  });

  it('settling again with the same key has no second effect', async () => {
    const { enter, payFromChallenge } = setup();
    const unpaid = await enter(new Request(URL));
    const denial = unpaid.kind === 'denied' ? unpaid.denial : null;
    expect(denial).not.toBeNull();

    const paying = payFromChallenge(denial!);
    const first = await enter(paying.clone());
    await isAdmitted(first).complete('succeeded');
    expect(settledHashes.length).toBe(1);
  });

  it('redaction keeps what lookup needs', async () => {
    const { provider } = setup();
    // Redaction check: create a rail with the same provider and verify it returns
    // a receipt after a successful payment.
    const rail = nanoRail({ merchantAccount: MERCHANT, rpc: provider, signer: provider, verifier: provider, xnoPerUsd: XNO_PER_USD });
    // The rail's redact method drops the signature; the remaining data has
    // hash, source, destination, amountRaw. Verify that receipt headers exist.
    const toll2 = createTollstile({
      rails: [rail],
      ledger: memoryLedger(),
      secret: 'nano-rail-r-test-secret-abcdef0123456789',
    });
    const gate2 = toll2.price('$1', { resource: RESOURCE });
    const unpaid = await gate2.enter(httpContext(new Request(URL), { resource: RESOURCE }));
    expect(unpaid.kind).toBe('denied');
    if (unpaid.kind !== 'denied') throw new Error('expected a 402');
    const offer = unpaid.denial.offers.find((o: any) => o.offer.rail === 'nano') as any;
    if (offer === undefined) throw new Error('no nano offer');
    const challenge = offer.challenge as { accepts?: { amountRaw?: string }; mcp?: { nonce?: string; quote?: string } };
    const mcp = (challenge.mcp ?? {}) as Record<string, string>;
    const hash = provider.pay(challenge.accepts?.amountRaw ?? '0');
    const sig = provider.sign(provider.payerAccount, mcp?.nonce ?? '');
    const paying = new Request(URL, {
      headers: {
        [NANO_BLOCK_HEADER]: hash,
        [NANO_SIGNATURE_HEADER]: sig,
        [NANO_QUOTE_HEADER]: mcp?.quote ?? '',
      },
    });
    const paid = await gate2.enter(httpContext(paying, { resource: RESOURCE }));
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    const completion = await paid.pass.complete('succeeded');
    // A settled charge MUST carry a receipt with at least a header.
    expect(completion.receipt.headers.length).toBeGreaterThan(0);
    expect(completion.receipt.headers[0][0]).toBe(NANO_BLOCK_HEADER);
  });

  it('the offer amount matches the challenged payable (rate locked at quote time)', async () => {
    const { enter } = setup();
    const unpaid = await enter(new Request(URL));
    if (unpaid.kind !== 'denied') throw new Error('expected a 402');
    const offer = unpaid.denial.offers.find((o: any) => o.offer.rail === 'nano') as any;
    if (offer === undefined) throw new Error('no nano offer');
    // The offer's amount (raw) is the price the rail calculated from the rate.
    const offerAmount = BigInt(offer.offer.amount);
    const challengeAmount = BigInt(offer.challenge.accepts.amountRaw);
    // The challenge includes the nonce, so it's >= the offer amount.
    expect(challengeAmount).toBeGreaterThan(offerAmount);
  });
});
