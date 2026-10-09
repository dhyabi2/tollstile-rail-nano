import { createTollstile, memoryLedger, TollstileError } from 'tollstile';
import { httpContext, mcpContext, railConformance } from 'tollstile/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nanoProvider } from '../src/nano-provider.js';
import { nanoRail, parseRate, toRaw } from '../src/nano-rail.js';
import { harness } from './harness.js';
import type { NanoBlockInfo, NanoSigner } from '../src/nano-types.js';
import {
  NANO_BLOCK_HEADER,
  NANO_BLOCK_META,
  NANO_QUOTE_HEADER,
  NANO_QUOTE_META,
  NANO_SIGNATURE_HEADER,
  NANO_SIGNATURE_META,
} from '../src/nano-types.js';

const MERCHANT = 'nano_3merchantaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const XNO_PER_USD = '0.01'; // $1 -> 1e28 raw

/** Tracks settled blocks the toll records, deduped by reference (core fires
 * charge.moved more than once for the same settled charge; a single block settles
 * a single charge, so the reference is the dedupe key — the same reason the rail
 * must never run a merchant hook from inside verify). */
let settledHashes: string[] = [];

type TollstileEvent = Parameters<NonNullable<Parameters<typeof createTollstile>[0]['onEvent']>>[0];
type Entry = Awaited<ReturnType<ReturnType<typeof setup>['enter']>>;

function setup(signer?: NanoSigner) {
  const provider = nanoProvider(MERCHANT);
  settledHashes = [];
  const seen = new Set<string>();
  const rail = nanoRail({
    merchantAccount: MERCHANT,
    rpc: provider,
    signer: signer ?? provider,
    verifier: provider,
    xnoPerUsd: XNO_PER_USD,
  });
  const ledger = memoryLedger();
  /** Every core event, in order, with NO deduplication. */
  const events: TollstileEvent[] = [];
  const toll = createTollstile({
    rails: [rail],
    ledger,
    secret: 'nano-rail-test-secret-0123456789abcdef',
    // Record settled blocks from core events, deduped by settlement reference.
    onEvent: (event) => {
      events.push(event);
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
  const enter = (p?: { hash?: string; signature?: string; quote?: string; key?: string }) => {
    const r = request(p);
    if (p?.key !== undefined) r.headers.set('idempotency-key', p.key);
    return gate.enter(httpContext(r, { resource: 'GET /report' }));
  };
  return { provider, toll, gate, enter, rail, ledger, events };
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

  it('fails closed at construction for a signer that is present but unusable', async () => {
    // The same hazard PR #1 closed for the verifier, in the one place it was not
    // applied. `refund` guarded only `signer === undefined`, so a signer that
    // arrived null or half-built -- from JSON, an env read, a DI container --
    // survived construction and died inside the refund:
    //
    //   signer=null                        TypeError: Cannot read properties of null (reading 'sendFor')
    //   signer={}                          TypeError: signer.sendFor is not a function
    //   signer={sendFor:'not a function'}  TypeError: signer.sendFor is not a function
    //
    // all three thrown out of `pass.complete('failed')` -- i.e. after the payer's
    // block has confirmed on-chain AND the handler has already failed. The
    // operator wanted the money to go back and got an unhandled TypeError
    // instead, which is the worst moment for a configuration mistake to surface.
    const base = { merchantAccount: MERCHANT, rpc: nanoProvider(MERCHANT), xnoPerUsd: XNO_PER_USD };
    const provider = nanoProvider(MERCHANT);
    for (const bad of [null, {}, 'yes', { sendFor: 'not a function' }]) {
      expect(() => nanoRail({ ...base, verifier: provider, signer: bad as never })).toThrowError(/signer/i);
    }
    // Omitting it stays legal: that is the documented "no refunds" configuration,
    // and README's "Refunds: read this first" is about exactly that shape.
    expect(() => nanoRail({ ...base, verifier: provider, signer: undefined })).not.toThrow();
    expect(() => nanoRail({ ...base, verifier: provider })).not.toThrow();
    // And a usable signer still refunds a failed handler by reverse send.
    const { provider: p2, enter } = setup();
    const paid = await payAndEnter(enter, p2);
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    expect((await paid.pass.complete('failed')).settlement).toBe('none');
    expect(p2.refundCount()).toBe(1);
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

  it('a verifier that throws on a malformed signature denies retryably, it does not throw out of the gate', async () => {
    // A real Nano ED25519 verifier decodes the signature before it can judge it,
    // and raises on anything that is not a 64-byte signature -- tweetnacl's
    // sign.detached.verify says "bad signature size". The fake provider used
    // everywhere else in this file only ever returns false, so nothing here had
    // ever handed the rail a verifier that throws. The signature is a header, so
    // the string that reaches it is whatever the caller sent.
    const provider = nanoProvider(MERCHANT);
    const rail = nanoRail({
      merchantAccount: MERCHANT,
      rpc: provider,
      verifier: {
        verify: (account: string, message: string, signature: string) => {
          if (!/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(signature)) throw new TypeError('bad signature size');
          return provider.verify(account, message, signature);
        },
      },
      xnoPerUsd: XNO_PER_USD,
    });
    const toll = createTollstile({
      rails: [rail],
      ledger: memoryLedger(),
      secret: 'nano-rail-test-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const enter = (headers: Record<string, string>) =>
      gate.enter(
        httpContext(new Request('https://example.test/report', { headers }), { resource: 'GET /report' }),
      );

    const challenge = await enter({});
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, quote } = acceptsOf(challenge.denial);
    // A REAL payment: the block is confirmed on-chain and pays the merchant the
    // exact quoted amount. Only the signature's encoding is wrong.
    const hash = provider.pay(amountRaw);

    const paid = await enter({
      [NANO_BLOCK_HEADER]: hash,
      [NANO_SIGNATURE_HEADER]: 'zz',
      [NANO_QUOTE_HEADER]: quote,
    });

    expect(paid.kind).toBe('denied');
    if (paid.kind !== 'denied') return;
    // Retryable, like the RPC's own failure: the payer's XNO has already moved and
    // cannot be charged back, so the block must stay presentable rather than be
    // refused for good because the operator's verifier could not read a string.
    const error = paid.denial.error as { code: string; retryable?: boolean };
    expect(error.retryable).toBe(true);
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

  // The three guards below are what stop a payer redeeming a block that is not the
  // payment for this quote: a send to somebody else, a receive or open block
  // presented as a payment, and a block that has not confirmed yet. Until now none
  // of them had a test, because the fake provider cannot produce those shapes --
  // `nano-provider.ts` fixes `subtype: 'send' = 'send'` and `pay()` always sends
  // payer -> merchant. So the rail was driven through a bespoke `rpc` instead,
  // which can answer with any block shape without widening the shipped fake.
  const guardCase = async (block: (payable: string, payer: string) => NanoBlockInfo) => {
    const provider = nanoProvider(MERCHANT);
    let payable = '0';
    const toll = createTollstile({
      rails: [
        nanoRail({
          merchantAccount: MERCHANT,
          verifier: provider,
          signer: provider,
          xnoPerUsd: XNO_PER_USD,
          // Answers for ANY hash, so the block shape is the only thing under test.
          rpc: { blockInfo: (_h: string) => Promise.resolve(block(payable, provider.payerAccount)) },
        }),
      ],
      ledger: memoryLedger(),
      secret: 'nano-guard-test-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const ctx = (headers: Record<string, string> = {}) =>
      httpContext(new Request('https://example.test/report', { headers }), { resource: 'GET /report' });
    const challenge = await gate.enter(ctx());
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = acceptsOf(challenge.denial);
    payable = accepts.amountRaw;
    const paid = await gate.enter(ctx({
      [NANO_BLOCK_HEADER]: 'any-hash-the-stub-answers-for',
      [NANO_SIGNATURE_HEADER]: provider.sign(provider.payerAccount, accepts.nonce),
      [NANO_QUOTE_HEADER]: accepts.quote,
    }));
    // The signature and the amount are correct in every case, so only the guard
    // under test can be the reason the rail refuses.
    return paid;
  };

  it('rejects a confirmed send of the right amount that paid SOMEBODY ELSE', async () => {
    const paid = await guardCase((payable, payer) => ({
      hash: 'h', confirmed: true, source: payer,
      destination: 'nano_3someoneelseaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amountRaw: payable, subtype: 'send',
    }));
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/proof_invalid/);
  });

  it('rejects a block that is not a send (a receive presented as a payment)', async () => {
    const paid = await guardCase((payable, payer) => ({
      hash: 'h', confirmed: true, source: payer, destination: MERCHANT,
      amountRaw: payable, subtype: 'receive',
    }));
    expect(paid.kind).toBe('denied');
    if (paid.kind === 'denied') expect(paid.denial.error.code).toMatch(/proof_invalid/);
  });

  it('refuses a block that has not confirmed, and says so retryably', async () => {
    const paid = await guardCase((payable, payer) => ({
      hash: 'h', confirmed: false, source: payer, destination: MERCHANT,
      amountRaw: payable, subtype: 'send',
    }));
    expect(paid.kind).toBe('denied');
    if (paid.kind !== 'denied') return;
    // The rail's own reason survives as `detail`, and core marks it retryable, so a
    // client CAN tell "in flight" from "this proof is wrong". Note what the
    // human-readable message says, though: core has no pending verification status
    // (Verification is absent | invalid | valid) and `proof_pending` is not one of
    // its DenialCodes, so the message reads "Pay again using this response" to a
    // payer whose XNO has already left their account. Pinned here as the behaviour
    // this rail actually has - not as the behaviour it should have.
    const error = paid.denial.error as { code: string; retryable?: boolean; detail?: string };
    expect(error.detail).toBe('proof_pending');
    expect(error.retryable).toBe(true);
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

  it('a refund signer that throws leaves the charge reconcilable instead of throwing out of complete()', async () => {
    // The merchant's signer is a Nano node or signing service over the network, so
    // `sendFor` can throw: a socket reset, a 503 from the RPC host, a timeout. The
    // call was unguarded while every other provider call in the rail was wrapped
    // (`rpc.blockInfo` in verify and lookup, the verifier in PR #10).
    //
    // Core wraps `refund` in `callProvider`, which recognises ONLY a TollstileError
    // carrying PROVIDER_UNAVAILABLE/PROVIDER_TIMEOUT and re-throws anything else.
    // So a raw Error came back out of the operator's own `pass.complete('failed')`
    // -- after the payer's XNO had moved on-chain and the handler had already
    // failed -- and the charge was left at `refund_pending`, never reaching
    // `unknown`, which is the only state core revisits with `lookup` to find out
    // whether the reverse send landed. The money the operator asked to send back
    // stays with the merchant and nothing records that it is owed.
    const { provider, enter, ledger, events } = setup({
      sendFor: () => {
        throw new Error('nano node unreachable');
      },
    });
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);

    // It must not escape the operator's completion call.
    const completion = await paid.pass.complete('failed');
    expect(completion.settlement).toBe('none');

    // It is reported as a provider failure, not as a flat refusal: the send may
    // have been published and only the reply lost, so `rejected` would assert the
    // money did not move and invite a second reverse send.
    const failures = events.filter((event) => event.type === 'error');
    expect(failures.length).toBe(1);
    const error = (failures[0] as { error: unknown }).error;
    expect(error).toBeInstanceOf(TollstileError);
    expect((error as TollstileError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as TollstileError).cause).toBeInstanceOf(Error);

    // And the charge is parked where reconciliation can find it.
    const [charge] = ledger.charges();
    expect(charge.payment).toBe('unknown');
    expect(charge.pending).toBe('refund');

    // No reverse send was recorded, because none succeeded.
    expect(provider.refundCount()).toBe(0);
  });

  it('a repeated settle with the same key has no second effect', async () => {
    // Actually repeat it: call the rail's settle a second time with the recorded
    // authorization and the same operation key, as a crashed worker would.
    const { provider, enter, rail, ledger } = setup();
    const paid = await payAndEnter(enter, provider);
    if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
    await paid.pass.complete('succeeded');
    const [charge] = ledger.charges();
    const authorization = ledger.authorizations().find((a) => a.id === charge.authorizationId)!;
    const op = { key: `${charge.id}:settle`, signal: new AbortController().signal };
    const first = await rail.settle(authorization as never, charge, op);
    const second = await rail.settle(authorization as never, charge, op);
    expect(first).toEqual(second);
    expect(second.status === 'settled' ? second.reference : null).toBe(charge.settlement?.reference);
    // No new block moved: no refund, no second transfer, one charge in the ledger.
    expect(provider.refundCount()).toBe(0);
    expect(ledger.charges().length).toBe(1);
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

  it('under replay and retry, core books the payment exactly once (counted raw, no dedupe)', async () => {
    // The review's point 2: core calls rail.verify BEFORE its single-use check, so
    // anything inside verify runs again on a replayed block hash or an
    // Idempotency-Key retry. The rail therefore has no hook there; merchants book
    // from core's onEvent. This counts those events RAW -- no Set -- across a
    // first payment, a replay of the same proof, and two retries with the same
    // Idempotency-Key, and counts how often verify accepted the block meanwhile.
    const { provider, rail } = setup();
    let verifiedValid = 0;
    const counted: typeof rail = {
      ...rail,
      async verify(context, terms, operation) {
        const result = await rail.verify(context, terms, operation);
        if (result.status === 'valid') verifiedValid += 1;
        return result;
      },
    };
    const events: TollstileEvent[] = [];
    const toll = createTollstile({
      rails: [counted],
      ledger: memoryLedger(),
      secret: 'nano-rail-replay-secret-0123456789abcdef',
      onEvent: (event) => events.push(event),
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const go = (p?: { hash: string; signature: string; quote: string }, key?: string) => {
      const r = p === undefined ? request({}) : requestWith({}, p.hash, p.signature, p.quote);
      if (key !== undefined) r.headers.set('idempotency-key', key);
      return gate.enter(httpContext(r, { resource: 'GET /report' }));
    };

    const challenge = await go();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const proof = { hash: provider.pay(amountRaw), signature: provider.sign(provider.payerAccount, nonce), quote };

    const paid = await go(proof, 'key-1');
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    await paid.pass.complete('succeeded');

    const replay = await go(proof);
    const retry1 = await go(proof, 'key-1');
    const retry2 = await go(proof, 'key-1');
    // Nothing after the first request is admitted as a new payment.
    for (const later of [replay, retry1, retry2]) expect(later.kind).not.toBe('admitted');

    // verify DID run again for every later request (this is what made an
    // in-verify hook double-book) ...
    expect(verifiedValid).toBe(4);
    // ... but core opened the authorization once and settled one charge once.
    const opened = events.filter((e) => e.type === 'authorization.opened' && e.created);
    expect(opened.length).toBe(1);
    const settledCharges = new Set(
      events.flatMap((e) => (e.type === 'charge.moved' && e.charge.payment === 'settled' ? [e.charge.id] : [])),
    );
    expect(settledCharges.size).toBe(1);
    expect(provider.refundCount()).toBe(0);
  });

  it('refuses the removed onSettled hook at construction, pointing at onEvent', () => {
    const provider = nanoProvider(MERCHANT);
    const make = () =>
      nanoRail({
        merchantAccount: MERCHANT,
        rpc: provider,
        verifier: provider,
        xnoPerUsd: XNO_PER_USD,
        onSettled: () => undefined,
      } as never);
    expect(make).toThrowError(TollstileError);
    expect(make).toThrowError(/onEvent/);
  });

  it('takes the rate as an exact decimal string', () => {
    // $1 at "0.0123" XNO/USD is exactly 0.0123 XNO = 1.23e28 raw.
    expect(toRaw(1_000_000n, parseRate('0.0123'))).toBe('12300000000000000000000000000');
    expect(toRaw(1_000_000n, parseRate('0.0123'))).toBe(toRaw(1_000_000n, parseRate('0.012300')));
    // A number is read through its decimal form: 0.0123 and "0.0123" agree.
    expect(toRaw(1_000_000n, parseRate(0.0123))).toBe(toRaw(1_000_000n, parseRate('0.0123')));
  });

  it('a rate with an exponent or float noise neither throws a SyntaxError nor breaks the price/nonce layout', () => {
    // 1e-7 stringifies with an exponent; BigInt("1e-7") would throw SyntaxError.
    expect(toRaw(1_000_000n, parseRate(1e-7))).toBe(toRaw(1_000_000n, parseRate('0.0000001')));
    expect(toRaw(1_000_000n, parseRate(2e21))).toBe(toRaw(1_000_000n, parseRate('2000000000000000000000')));
    // 0.1 + 0.2 carries 17 significant digits; the price must still leave the
    // low 10 digits clear for the nonce.
    for (const rate of [0.1 + 0.2, 1 / 3, '0.333333333333333333333333333333333', 1e-7]) {
      const raw = BigInt(toRaw(1_000_000n, parseRate(rate)));
      expect(raw > 0n).toBe(true);
      expect(raw % 10_000_000_000n).toBe(0n);
    }
    // Rates that cannot be a price are a configuration error, never a SyntaxError.
    for (const bad of ['1e-7', '-0.01', '0', '0.000', 'abc', '', ' ', '0x10', 0, -1, Number.NaN, Infinity, null, {}]) {
      expect(() => parseRate(bad), JSON.stringify(bad) ?? typeof bad).toThrowError(TollstileError);
    }
  });

  it('a noisy float rate still pays end to end: challenged amount = price with clear low digits + nonce', async () => {
    const provider = nanoProvider(MERCHANT);
    const toll = createTollstile({
      rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, verifier: provider, xnoPerUsd: 0.1 + 0.2 })],
      ledger: memoryLedger(),
      secret: 'nano-rail-float-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const challenge = await gate.enter(httpContext(request({}), { resource: 'GET /report' }));
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const offer = (challenge.denial as unknown as { offers: { offer: { amount: string } }[] }).offers[0].offer;
    expect(BigInt(offer.amount) % 10_000_000_000n).toBe(0n);
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const hash = provider.pay(amountRaw);
    const paid = await gate.enter(
      httpContext(requestWith({}, hash, provider.sign(provider.payerAccount, nonce), quote), { resource: 'GET /report' }),
    );
    expect(paid.kind).toBe('admitted');
  });

  it('pays over MCP through _meta (block, signature and quote)', async () => {
    const provider = nanoProvider(MERCHANT);
    const toll = createTollstile({
      rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, verifier: provider, xnoPerUsd: XNO_PER_USD })],
      ledger: memoryLedger(),
      secret: 'nano-rail-mcp-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'tool:report' });
    const unpaid = await gate.enter(mcpContext('report', {}));
    if (unpaid.kind !== 'denied') throw new Error('expected a payment-required answer');
    const { amountRaw, nonce, quote } = acceptsOf(unpaid.denial);
    expect(quote).not.toBe('');
    const hash = provider.pay(amountRaw);
    const signature = provider.sign(provider.payerAccount, nonce);

    // Wrong signature over MCP is refused, exactly as over HTTP.
    const forged = await gate.enter(mcpContext('report', { [NANO_BLOCK_META]: hash, [NANO_SIGNATURE_META]: 'nope', [NANO_QUOTE_META]: quote }));
    expect(forged.kind).toBe('denied');
    // No quote in _meta: refused as quote_invalid, not admitted on the block alone.
    const noQuote = await gate.enter(mcpContext('report', { [NANO_BLOCK_META]: hash, [NANO_SIGNATURE_META]: signature }));
    expect(noQuote.kind).toBe('denied');

    const paid = await gate.enter(mcpContext('report', { [NANO_BLOCK_META]: hash, [NANO_SIGNATURE_META]: signature, [NANO_QUOTE_META]: quote }));
    if (paid.kind !== 'admitted') throw new Error(`expected admission over MCP, got ${paid.denial.error.code}`);
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
    // The receipt names the block in its CANONICAL (upper-case) form -- the same
    // block, spelled the way an explorer and the network spell it, not the way this
    // caller happened to type it. The rail canonicalises the hash on the way in
    // because it is the single-use identity of the payment.
    expect(completion.receipt.headers[0]).toEqual([NANO_BLOCK_HEADER, hash.toUpperCase()]);
  });

  it('the README install snippet constructs a Tollstile that can price', () => {
    // The Install snippet is the only code a new user runs, and it ships inside
    // the npm tarball (`files: ["dist", "README.md"]`). `nanoRail` declares
    // `livemode: true`, and core refuses a live rail that has no quote secret:
    //   TollstileError CONFIG_INVALID
    //   "Live rails need `secret` to sign quotes."
    // so a snippet that omits `secret` throws on the user's very first line,
    // before any Nano code runs. Every test in this repository passes a secret,
    // which is why the suite never noticed. This law builds the instance the
    // README describes and passes `secret` only when the snippet does, so the
    // README itself decides whether the construction succeeds.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const snippet = /```ts\n([\s\S]*?createTollstile[\s\S]*?)```/.exec(readme);
    expect(snippet, 'the README no longer carries a ```ts install snippet').not.toBeNull();
    const code = snippet![1];

    const provider = nanoProvider(MERCHANT);
    const secret = /^\s*secret:/m.test(code) ? 'readme-install-snippet-secret-0123456789' : undefined;
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
      secret,
    });
    expect(typeof toll.price('$1', { resource: 'readme-install' }).enter).toBe('function');
  });

  /**
   * The live `block_info` answer for a real confirmed SEND block, captured from
   * rpc.nano.to on 2026-09-28 (hash CABB659A...E819). Two fields are the whole
   * point of the fixture: `confirmed` arrives as the STRING "true", and the
   * destination of a send is `contents.link_as_account` -- there is no top-level
   * `link_account` field in the response at all.
   */
  function liveSendResponse(): Record<string, any> {
    return {
      block_account: 'nano_3nhh9atngrher9zzackjhxhof3ijnxxp8paer9xo9z7utj69icg8h8weyuxh',
      amount: '352000000000000000000000000',
      balance: '0',
      height: '2',
      confirmed: 'true',
      contents: {
        type: 'state',
        account: 'nano_3nhh9atngrher9zzackjhxhof3ijnxxp8paer9xo9z7utj69icg8h8weyuxh',
        link: '25146764A6EE0CDB7FD965B8EDDA4EF8CC1971E07D7AB9FD42C69AFBEDCD8ACE',
        link_as_account: 'nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq',
      },
      subtype: 'send',
    };
  }

  /** `examples/rpc-network-check.mjs` is the read model an operator copies. */
  async function exampleToBlockInfo(): Promise<(data: unknown, hash: string) => NanoBlockInfo> {
    const href = new URL('../examples/rpc-network-check.mjs', import.meta.url).href;
    const mod = await import(/* @vite-ignore */ href);
    return mod.toBlockInfo as (data: unknown, hash: string) => NanoBlockInfo;
  }

  it("the example's read model maps a real live-network send block correctly", async () => {
    const toBlockInfo = await exampleToBlockInfo();
    const hash = 'CABB659AFF2EDBD86E0399ADED8A3F6265E0EF2605178C8FACE15D36E869E819';
    const block = toBlockInfo(liveSendResponse(), hash);
    // "confirmed" is a JSON string on the wire, so `=== true` is false for every
    // confirmed block the network has.
    expect(block.confirmed, 'confirmed').toBe(true);
    // The destination is contents.link_as_account -- not block_account, which is
    // the SENDER, and not a top-level link_account, which does not exist.
    expect(block.destination, 'destination').toBe('nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq');
    expect(block.source, 'source').toBe('nano_3nhh9atngrher9zzackjhxhof3ijnxxp8paer9xo9z7utj69icg8h8weyuxh');
    expect(block.subtype).toBe('send');
    expect(block.amountRaw).toBe('352000000000000000000000000');
  });

  it('a genuine payment read through the example adapter is admitted, not denied', async () => {
    // What the two field reads above cost in the flow that matters: the same
    // live response shape, for a send that really does pay this merchant the
    // challenged amount. Misread, it is refused after the payer's XNO has moved.
    const toBlockInfo = await exampleToBlockInfo();
    const provider = nanoProvider(MERCHANT);
    const response = liveSendResponse();
    response.block_account = provider.payerAccount;
    response.contents.account = provider.payerAccount;
    response.contents.link_as_account = MERCHANT;
    const rail = nanoRail({
      merchantAccount: MERCHANT,
      rpc: { blockInfo: (hash: string) => Promise.resolve(toBlockInfo(response, hash)) },
      verifier: provider,
      xnoPerUsd: XNO_PER_USD,
    });
    const toll = createTollstile({
      rails: [rail],
      ledger: memoryLedger(),
      secret: 'nano-rail-test-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const enter = (p?: { hash?: string; signature?: string; quote?: string }) =>
      gate.enter(httpContext(requestWith({}, p?.hash ?? '', p?.signature ?? '', p?.quote ?? ''), { resource: 'GET /report' }));

    const challenge = await gate.enter(httpContext(request({}), { resource: 'GET /report' }));
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = acceptsOf(challenge.denial);
    // The payer sends exactly what was challenged, to this merchant.
    response.amount = accepts.amountRaw;

    const paid = await enter({
      hash: 'CABB659AFF2EDBD86E0399ADED8A3F6265E0EF2605178C8FACE15D36E869E819',
      signature: provider.sign(provider.payerAccount, accepts.nonce),
      quote: accepts.quote,
    });
    if (paid.kind !== 'admitted') {
      throw new Error(`expected admission, got ${paid.denial.error.code} (${String(paid.denial.error.detail)})`);
    }
    expect((await paid.pass.complete('succeeded')).settlement).toBe('settled');
  });

  it('an empty quote header does not hide the quote in _meta', async () => {
    // The same MCP call arriving over Streamable HTTP has BOTH `mcp` and `request`
    // set -- core's Context says `request` is "null for MCP calls that arrive
    // without an HTTP carrier". `rawFromHeader` and `signatureFrom` are written for
    // exactly that: a header that is present but EMPTY is skipped and _meta is read
    // instead, which is what a client echoing the challenge's prefilled
    // `x-nano-block: ''` and `x-nano-signature: ''` sends. The quote read had no
    // such guard, so `''` won the `??` and the quote in _meta was never looked at.
    //
    // The cost is the worst one this rail has: the payer's send is already
    // confirmed on-chain when verify runs, and Nano has no chargeback, so the
    // answer "The quote is forged, expired... Pay with the new quote in this
    // response" asks them to pay a second time for a payment that went through.
    const provider = nanoProvider(MERCHANT);
    const toll = createTollstile({
      rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, verifier: provider, xnoPerUsd: XNO_PER_USD })],
      ledger: memoryLedger(),
      secret: 'nano-rail-hybrid-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'tool:report' });
    const unpaid = await gate.enter(mcpContext('report', {}));
    if (unpaid.kind !== 'denied') throw new Error('expected a payment-required answer');
    const { amountRaw, nonce, quote } = acceptsOf(unpaid.denial);
    const hash = provider.pay(amountRaw);
    const signature = provider.sign(provider.payerAccount, nonce);
    const meta = { [NANO_BLOCK_META]: hash, [NANO_SIGNATURE_META]: signature, [NANO_QUOTE_META]: quote };

    const overHttpCarrier = {
      ...mcpContext('report', meta),
      request: new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { [NANO_BLOCK_HEADER]: '', [NANO_SIGNATURE_HEADER]: '', [NANO_QUOTE_HEADER]: '' },
      }),
    } as unknown as Parameters<typeof gate.enter>[0];

    const paid = await gate.enter(overHttpCarrier);
    if (paid.kind !== 'admitted') {
      throw new Error(`a paid MCP call over an HTTP carrier was denied: ${paid.denial.error.code}`);
    }
    const completion = await paid.pass.complete('succeeded');
    expect(completion.settlement).toBe('settled');
  });

  it('a header that carries a real value still wins over _meta', async () => {
    // The fallback must not become a bypass: a non-empty header is still the
    // value used, so a forged quote in _meta cannot override the header the
    // client actually sent. This is the direction the change must NOT alter.
    const provider = nanoProvider(MERCHANT);
    const toll = createTollstile({
      rails: [nanoRail({ merchantAccount: MERCHANT, rpc: provider, verifier: provider, xnoPerUsd: XNO_PER_USD })],
      ledger: memoryLedger(),
      secret: 'nano-rail-hybrid-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'tool:report' });
    const unpaid = await gate.enter(mcpContext('report', {}));
    if (unpaid.kind !== 'denied') throw new Error('expected a payment-required answer');
    const { amountRaw, nonce, quote } = acceptsOf(unpaid.denial);
    const hash = provider.pay(amountRaw);
    const signature = provider.sign(provider.payerAccount, nonce);

    const forgedInMeta = {
      ...mcpContext('report', { [NANO_QUOTE_META]: 'not-a-quote' }),
      request: requestWith({}, hash, signature, quote),
    } as unknown as Parameters<typeof gate.enter>[0];
    const paid = await gate.enter(forgedInMeta);
    expect(paid.kind).toBe('admitted');

    const forgedInHeader = {
      ...mcpContext('report', { [NANO_QUOTE_META]: quote }),
      request: requestWith({}, hash, signature, 'not-a-quote'),
    } as unknown as Parameters<typeof gate.enter>[0];
    const denied = await gate.enter(forgedInHeader);
    expect(denied.kind).toBe('denied');
  });

  it('the same block presented with a different hex case cannot settle a second charge', async () => {
    // A Nano block hash is CASE-INSENSITIVE on the network. Measured against the
    // public RPC on 2026-10-04, `block_info` for
    //   E792FD1FE71FA6C111BC5545747F828348C3CE2EBE8D3173D0BE344F09FC62FE
    // and for the same 64 characters lowercased returned the SAME block, byte for
    // byte (nano's `decode_hex` reads either case). The fake provider models that.
    //
    // Core's single-use check is `alreadyUsed`, which looks up
    // `deriveId('auth', rail.name, proofId)` -- so the one thing standing between a
    // confirmed send and being spent twice is the rail's `proofId`. The rail passed
    // the header through verbatim, so the PAYER chose the identity of their own
    // payment: present `ABCD...` and then `abcd...` and core sees two unrelated
    // proofs. Quotes do not close this -- they are stateless signed tokens, valid
    // for their whole TTL and openable as often as you like.
    //
    // One payment, two served requests, and the merchant is short the second one.
    const { provider, rail } = setup();
    const events: TollstileEvent[] = [];
    const toll = createTollstile({
      rails: [rail],
      ledger: memoryLedger(),
      secret: 'nano-rail-casing-secret-0123456789abcdef',
      onEvent: (event) => events.push(event),
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const go = (p?: { hash: string; signature: string; quote: string }) =>
      gate.enter(httpContext(
        p === undefined ? request({}) : requestWith({}, p.hash, p.signature, p.quote),
        { resource: 'GET /report' },
      ));

    const challenge = await go();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const hash = provider.pay(amountRaw);
    const signature = provider.sign(provider.payerAccount, nonce);

    const paid = await go({ hash, signature, quote });
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    await paid.pass.complete('succeeded');

    // The same block, the same quote, the same signature -- only the hex case of
    // the hash differs, and it names the same block on the network.
    const recased = hash.toUpperCase() === hash ? hash.toLowerCase() : hash.toUpperCase();
    expect(recased, 'the recased hash must differ as TEXT').not.toBe(hash);
    const again = await go({ hash: recased, signature, quote });
    expect(again.kind, 'a recasing of a spent block must not be admitted').not.toBe('admitted');
    // core recognises the second presentation as the request that was already paid
    // (409, `action: stop`): "It is not charged or run again."
    if (again.kind === 'denied') expect(again.denial.error.code).toBe('already_paid');

    // One send, one authorization, one settled charge.
    const opened = events.filter((e) => e.type === 'authorization.opened' && e.created);
    expect(opened.length, 'authorizations opened').toBe(1);
    const settledCharges = new Set(
      events.flatMap((e) => (e.type === 'charge.moved' && e.charge.payment === 'settled' ? [e.charge.id] : [])),
    );
    expect(settledCharges.size, 'charges settled').toBe(1);
  });

  it('the version the README tells you to require is the version this package is', () => {
    // The four versions on npm all pre-date #15, so `npm i tollstile-rail-nano`
    // installs a rail that settles two charges off one confirmed send (measured
    // against the published 0.3.1 in a fresh project; the output is in the README).
    // Publishing is the owner's, so the README carries the advisory instead -- and
    // an advisory that names a version goes stale the moment the version moves,
    // exactly like the test-count claim below. So the suite owns the number.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };

    const claim = /Require `([0-9]+\.[0-9]+\.[0-9]+)` or later/.exec(readme);
    expect(claim, 'the README no longer tells a reader which version to require').not.toBeNull();
    expect(claim![1], 'the README requires a version this package is not').toBe(pkg.version);

    // And the advisory must not name this package's own version as a BAD one.
    const affected = /four versions on npm \(([^)]*)\)/.exec(readme);
    expect(affected, 'the README no longer lists the affected published versions').not.toBeNull();
    expect(affected![1], 'the README lists this version as affected').not.toContain(pkg.version);
  });

  it('the conformance result the README publishes is the result this suite produces', () => {
    // The README tells a Tollstile maintainer to run `npm test` and compare
    // against a printed number, so that number is a claim about this suite and
    // goes stale every time a case is added -- it has now been wrong twice, at
    // 15 and at 17. Counting the cases here means the suite that changes is the
    // suite that reports the mismatch. This test counts itself.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const countIts = (file: string): number =>
      (readFileSync(new URL(file, import.meta.url), 'utf8').match(/^\s*it\(/gm) ?? []).length;

    const rail = countIts('./rail.test.ts');
    const cases = railConformance(harness);
    const skipped = cases.filter((c) => c.skip !== undefined).length;
    const conformance = cases.length - skipped;

    const claim = /Tollstile conformance: \*\*(\d+) passed, (\d+) skipped\*\*[\s\S]*?Rail unit tests: \*\*(\d+) passed\*\*/.exec(readme);
    expect(claim, 'the README no longer states a conformance result in the expected shape').not.toBeNull();
    const [, claimedConformance, claimedSkipped, claimedRail] = claim!;

    expect(Number(claimedConformance), 'README conformance passed').toBe(conformance);
    expect(Number(claimedSkipped), 'README conformance skipped').toBe(skipped);
    expect(Number(claimedRail), 'README rail unit test count').toBe(rail);
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

describe('the rail reads its injected dependencies for what they are, not for truthiness', () => {
  // `rpc` and `verifier` are the operator's own code. The published package is
  // JavaScript, so `NanoBlockInfo.confirmed: boolean` and
  // `NanoSignatureVerifier.verify: Promise<boolean>` are not enforced at runtime
  // -- the same premise the two construction guards in `nanoRail` are written
  // under. Both gates below used a truthiness test, and a truthy non-`true`
  // answer admitted a payment that had to be refused.

  /** The rail as `setup` builds it, with one dependency wrapped.
   *
   * Both overrides are BOXED (`{ value }`), because `undefined` is one of the
   * answers under test: a bare `confirmedAs: undefined` could not be told apart
   * from "do not wrap this dependency at all".
   */
  function rig(over: {
    confirmedAs?: { value: unknown };
    verifyAnswer?: { value: unknown };
  }) {
    const provider = nanoProvider(MERCHANT);
    const confirmedAs = over.confirmedAs;
    const rpc = confirmedAs === undefined ? provider : {
      blockInfo: async (h: string) => {
        const b = await provider.blockInfo(h);
        return b === undefined ? undefined : { ...b, confirmed: confirmedAs.value } as NanoBlockInfo;
      },
    };
    const verifyAnswer = over.verifyAnswer;
    const verifier = verifyAnswer === undefined ? provider : {
      verify: () => Promise.resolve(verifyAnswer.value as boolean),
    };
    const rail = nanoRail({
      merchantAccount: MERCHANT, rpc, signer: provider, verifier, xnoPerUsd: XNO_PER_USD,
    });
    const toll = createTollstile({
      rails: [rail], ledger: memoryLedger(),
      secret: 'nano-rail-test-secret-0123456789abcdef',
    });
    const gate = toll.price('$1', { resource: 'GET /report' });
    const enter = (p?: { hash?: string; signature?: string; quote?: string }) => {
      const headers: Record<string, string> = {};
      if (p?.hash !== undefined) headers[NANO_BLOCK_HEADER] = p.hash;
      if (p?.signature !== undefined) headers[NANO_SIGNATURE_HEADER] = p.signature;
      if (p?.quote !== undefined) headers[NANO_QUOTE_HEADER] = p.quote;
      const r = new Request('https://example.test/report', { headers });
      return gate.enter(httpContext(r, { resource: 'GET /report' }));
    };
    return { provider, enter };
  }

  async function present(r: ReturnType<typeof rig>, signature?: string) {
    const challenge = await r.enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { amountRaw, nonce, quote } = acceptsOf(challenge.denial);
    const hash = r.provider.pay(amountRaw);
    return r.enter({ hash, signature: signature ?? r.provider.sign(r.provider.payerAccount, nonce), quote });
  }

  // -- the block's confirmation ------------------------------------------------
  //
  // Measured against rpc.nano.to: `block_info` for a confirmed send answers
  // `confirmed: "true"` -- a STRING. This repository documents that in
  // `examples/rpc-network-check.mjs` and normalises it there; the rail did not.
  // An operator who maps the field straight across hands this guard "false" for
  // an uncemented block, and `!"false"` is false.

  it('refuses a block the node reports unconfirmed as the string "false"', async () => {
    const entry = await present(rig({ confirmedAs: { value: 'false' } }));
    expect(entry.kind).toBe('denied');
  });

  it('does not admit a block reported unconfirmed as a string, so nothing is delivered', async () => {
    const entry = await present(rig({ confirmedAs: { value: 'false' } }));
    if (entry.kind !== 'denied') {
      throw new Error('the merchant delivered on a block the network has not cemented');
    }
    // `proof_pending` and not `proof_invalid`: the block may yet cement, so the
    // payer is told to come back, not that their payment was bad.
    expect(entry.denial.error.code).toBeDefined();
  });

  it.each([['maybe'], [1], [{}], [[]], ['TRUE'], ['1']])(
    'refuses a confirmation field that is truthy but is not a confirmation: %s',
    async (value) => {
      const entry = await present(rig({ confirmedAs: { value } }));
      expect(entry.kind).toBe('denied');
    },
  );

  // -- controls: every form that really does mean confirmed still pays --------

  it('still admits a block confirmed as the boolean true', async () => {
    const entry = await present(rig({ confirmedAs: { value: true } }));
    expect(entry.kind).toBe('admitted');
  });

  it('still admits a block confirmed as the string "true", which is what the node sends', async () => {
    const entry = await present(rig({ confirmedAs: { value: 'true' } }));
    expect(entry.kind).toBe('admitted');
  });

  it.each([[false], [undefined], [null], [0], ['']])(
    'still refuses a plainly unconfirmed block: %s',
    async (value) => {
      const entry = await present(rig({ confirmedAs: { value } }));
      expect(entry.kind).toBe('denied');
    },
  );

  // -- the signature verifier -------------------------------------------------
  //
  // `{ valid: false }` is what an HTTP-backed verifier answers if it hands its
  // JSON body back un-destructured. It is truthy, so the rail admitted a payment
  // with no valid signature -- the replay the construction guard says a verifier
  // exists to stop: any watcher of the ledger could present someone else's
  // confirmed send to the merchant.

  it.each([[{ valid: false }], [{ ok: false }], ['false'], [1], [{}], ['yes']])(
    'refuses a payment whose verifier answered something truthy that is not true: %s',
    async (answer) => {
      const entry = await present(rig({ verifyAnswer: { value: answer } }), 'a-signature-nobody-checked');
      expect(entry.kind).toBe('denied');
    },
  );

  it('still admits a payment whose verifier answered the boolean true', async () => {
    const entry = await present(rig({ verifyAnswer: { value: true } }));
    expect(entry.kind).toBe('admitted');
  });

  it.each([[false], [null], [undefined], [0]])(
    'still refuses a payment the verifier plainly rejected: %s',
    async (answer) => {
      const entry = await present(rig({ verifyAnswer: { value: answer } }), 'a-signature-nobody-checked');
      expect(entry.kind).toBe('denied');
    },
  );
});
