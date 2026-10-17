/**
 * SHA-256, with its own UTF-8 encoder and nothing else.
 *
 * Core compiles with `types: []` and `lib: ["es2024"]` (AD-1), so neither
 * `node:crypto` nor `TextEncoder` is in reach: a hash that needed either would
 * make masking a port, and masking is a pure function of its input (AD-11).
 * The implementation is FIPS 180-4 verbatim — it is checked against the NIST
 * vectors and against `node:crypto` in `test/sha256.test.ts`, so a mistake in
 * here cannot pass unnoticed.
 *
 * It is used for one thing: the hash of text that was removed by masking. The
 * removed text itself is never kept anywhere (AD-11), which is why this module
 * exists at all.
 */

/** The round constants of FIPS 180-4 §4.2.2: the cube roots of the first 64 primes. */
const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** The initial hash value of FIPS 180-4 §5.3.3: the square roots of the first 8 primes. */
const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

/** The prefix every hash this project stores carries (AD-11, Conventions). */
export const CONTENT_HASH_PREFIX = 'sha256:';

/**
 * `sha256:<lower-case hex>` of the UTF-8 bytes of `text`.
 *
 * This is the form every `content_hash` column holds, so the one place the
 * prefix is spelled is here.
 */
export function contentHash(text: string): string {
  return `${CONTENT_HASH_PREFIX}${sha256Hex(text)}`;
}

/** The bare 64 hex characters, lower case, of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return hexOf(sha256(utf8Bytes(text)));
}

/** The eight words of the digest, for a caller that wants the bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const state = Int32Array.from(INITIAL_STATE);
  // The padded message: the bytes, a single 1 bit, zeros, and the 64-bit length
  // (FIPS 180-4 §5.1.1). `bitLength` stays exact because a text long enough to
  // overflow a double's integers is far past anything this project stores.
  const bitLength = bytes.length * 8;
  // At least nine bytes of padding — the 1 bit and the eight of the length —
  // rounded up to whole 512-bit blocks.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // The length goes in the last eight bytes, big endian. The high word is the
  // bits above 2^32, which `Math.floor` of the division gives exactly.
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  const tail = padded.length - 8;
  padded[tail] = (high >>> 24) & 0xff;
  padded[tail + 1] = (high >>> 16) & 0xff;
  padded[tail + 2] = (high >>> 8) & 0xff;
  padded[tail + 3] = high & 0xff;
  padded[tail + 4] = (low >>> 24) & 0xff;
  padded[tail + 5] = (low >>> 16) & 0xff;
  padded[tail + 6] = (low >>> 8) & 0xff;
  padded[tail + 7] = low & 0xff;

  const schedule = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = block + index * 4;
      schedule[index] =
        ((padded[at] ?? 0) << 24) |
        ((padded[at + 1] ?? 0) << 16) |
        ((padded[at + 2] ?? 0) << 8) |
        (padded[at + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const fifteen = schedule[index - 15] ?? 0;
      const two = schedule[index - 2] ?? 0;
      const s0 = rotateRight(fifteen, 7) ^ rotateRight(fifteen, 18) ^ (fifteen >>> 3);
      const s1 = rotateRight(two, 17) ^ rotateRight(two, 19) ^ (two >>> 10);
      schedule[index] = ((schedule[index - 16] ?? 0) + s0 + (schedule[index - 7] ?? 0) + s1) | 0;
    }

    let a = state[0] ?? 0;
    let b = state[1] ?? 0;
    let c = state[2] ?? 0;
    let d = state[3] ?? 0;
    let e = state[4] ?? 0;
    let f = state[5] ?? 0;
    let g = state[6] ?? 0;
    let h = state[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first =
        (h + sigma1 + choose + (ROUND_CONSTANTS[index] ?? 0) + (schedule[index] ?? 0)) | 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }

    state[0] = ((state[0] ?? 0) + a) | 0;
    state[1] = ((state[1] ?? 0) + b) | 0;
    state[2] = ((state[2] ?? 0) + c) | 0;
    state[3] = ((state[3] ?? 0) + d) | 0;
    state[4] = ((state[4] ?? 0) + e) | 0;
    state[5] = ((state[5] ?? 0) + f) | 0;
    state[6] = ((state[6] ?? 0) + g) | 0;
    state[7] = ((state[7] ?? 0) + h) | 0;
  }

  const digest = new Uint8Array(32);
  for (let index = 0; index < 8; index += 1) {
    const word = state[index] ?? 0;
    digest[index * 4] = (word >>> 24) & 0xff;
    digest[index * 4 + 1] = (word >>> 16) & 0xff;
    digest[index * 4 + 2] = (word >>> 8) & 0xff;
    digest[index * 4 + 3] = word & 0xff;
  }
  return digest;
}

function rotateRight(word: number, bits: number): number {
  return (word >>> bits) | (word << (32 - bits));
}

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The UTF-8 bytes of a JavaScript string, without `TextEncoder` (AD-1).
 *
 * A lone surrogate becomes U+FFFD, which is what every well behaved encoder
 * does: a half of a pair is not a character, and encoding it as though it were
 * would produce bytes no decoder accepts — and a hash that differs from the one
 * `node:crypto` would have made for the same text.
 */
export function utf8Bytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x1_0000;
        index += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x1_0000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}
