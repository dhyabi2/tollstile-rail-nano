/**
 * BLAKE2b (RFC 7693), unkeyed, any digest length from 1 to 64 bytes.
 *
 * `node:crypto` only offers `blake2b512`, and BLAKE2b mixes the digest length into
 * its IV, so a 5-byte digest is not a truncation of the 64-byte one. A Nano account
 * checksum is exactly that 5-byte digest, so it is computed here, with no
 * dependency. It runs once per `nanoRail()` construction; clarity beats speed, so
 * the 64-bit words are BigInts. The test suite checks it against
 * `createHash('blake2b512')` at outlen 64.
 */

const MASK = (1n << 64n) - 1n;

const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK;
}

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = [];
  for (let i = 0; i < 16; i++) {
    let w = 0n;
    for (let b = 7; b >= 0; b--) w = (w << 8n) | BigInt(block[i * 8 + b]);
    m.push(w);
  }
  const v = [...h, ...IV];
  v[12] = v[12] ^ (t & MASK);
  v[13] = v[13] ^ (t >> 64n);
  if (last) v[14] = v[14] ^ MASK;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rotr(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rotr(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rotr(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8];
}

/** The unkeyed BLAKE2b digest of `input`, `outlen` bytes long (1..64). */
export function blake2b(input: Uint8Array, outlen: number): Uint8Array {
  if (!Number.isInteger(outlen) || outlen < 1 || outlen > 64) throw new RangeError(`blake2b outlen must be 1..64, got ${outlen}`);
  const h = [...IV];
  h[0] = h[0] ^ 0x01010000n ^ BigInt(outlen);
  let t = 0n;
  let offset = 0;
  // Every full block except the last is compressed as non-final; the last block
  // (possibly empty input, zero-padded) is the final one.
  while (input.length - offset > 128) {
    t += 128n;
    compress(h, input.subarray(offset, offset + 128), t, false);
    offset += 128;
  }
  const tail = new Uint8Array(128);
  tail.set(input.subarray(offset));
  t += BigInt(input.length - offset);
  compress(h, tail, t, true);
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}
