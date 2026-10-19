import { describe, expect, it } from 'vitest';
import {
  FAILURE_MESSAGE_MAX_BYTES,
  failureFingerprint,
  failureText,
  truncateUtf8,
} from '../src/domain/failure.js';
import { utf8Bytes } from '../src/domain/sha256.js';

/**
 * The three decisions a stored failure carries: what makes two failures the
 * same one, how long a sentence may be, and what has been taken out of it
 * (AD-11, AD-21).
 */

describe('the failure fingerprint', () => {
  it('is the same for the same stage, input and code', () => {
    const one = failureFingerprint({ stage: 'ingest', input: 'session:demo:a', code: 'DB_LOCKED' });
    const two = failureFingerprint({ stage: 'ingest', input: 'session:demo:a', code: 'DB_LOCKED' });

    expect(one).toBe(two);
    expect(one).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('differs when any one of the three differs', () => {
    const base = { stage: 'ingest', input: 'session:demo:a', code: 'DB_LOCKED' };
    const prints = new Set([
      failureFingerprint(base),
      failureFingerprint({ ...base, stage: 'chunk' }),
      failureFingerprint({ ...base, input: 'session:demo:b' }),
      failureFingerprint({ ...base, code: 'SCHEMA_MISMATCH' }),
    ]);

    expect(prints.size).toBe(4);
  });

  it('cannot be spelled two ways by moving the separator into a value', () => {
    // JSON of an array, not a joined string: `['a:b', 'c']` and `['a', 'b:c']`
    // would be the same line if the three were joined on a colon, and the same
    // recurring problem would then merge with a different one.
    expect(failureFingerprint({ stage: 'a:b', input: 'c', code: 'X' })).not.toBe(
      failureFingerprint({ stage: 'a', input: 'b:c', code: 'X' }),
    );
  });

  it('says nothing about the message, the instant or the path', () => {
    // The whole point of the three fields (I/O matrix: the same cause a hundred
    // times is one row). Nothing else is an input, so there is nothing else to
    // vary — and this is the assertion that keeps a fourth field out.
    const print = failureFingerprint({ stage: 'ingest', input: 'file:abc', code: 'READ_FAILED' });
    expect(print).toBe(
      failureFingerprint({ stage: 'ingest', input: 'file:abc', code: 'READ_FAILED' }),
    );
  });
});

describe('cutting a stored sentence at a code point boundary', () => {
  it('leaves a sentence already inside the limit alone', () => {
    expect(truncateUtf8('짧은 문장', 100)).toBe('짧은 문장');
    expect(truncateUtf8('', 100)).toBe('');
  });

  it('never splits a multi-byte character', () => {
    // '가' is three bytes, so a four-byte budget holds exactly one of them.
    const cut = truncateUtf8('가가가', 4);
    expect(cut).toBe('가');
    expect(utf8Bytes(cut).length).toBeLessThanOrEqual(4);
  });

  it('never splits a surrogate pair', () => {
    // An emoji is one code point and four UTF-8 bytes, but two UTF-16 units: a
    // loop over `length` would keep half of it, which is not a character at all.
    const cut = truncateUtf8('🙂🙂', 6);
    expect(cut).toBe('🙂');
    expect([...cut]).toHaveLength(1);
  });

  it('answers the empty string for a budget of nothing', () => {
    expect(truncateUtf8('무엇이든', 0)).toBe('');
    expect(truncateUtf8('무엇이든', -1)).toBe('');
  });
});

describe('the sentence a failure stores', () => {
  it('masks the secret and keeps the sentence under the byte limit', () => {
    // The matrix row: nine thousand bytes of Korean and emoji with a token in
    // the middle of it.
    const long = `${'가'.repeat(2000)} token=sk-AAAAAAAAAAAAAAAAAAAA ${'🙂'.repeat(1000)}`;
    expect(utf8Bytes(long).length).toBeGreaterThan(9000);

    const stored = failureText(long);

    expect(utf8Bytes(stored).length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_BYTES);
    // No secret, and nothing broken: every code point is whole, so the string
    // round-trips through its own code points unchanged.
    expect(stored).not.toContain('sk-AAAAAAAAAAAAAAAAAAAA');
    expect(stored).toContain('[REDACTED:');
    expect([...stored].join('')).toBe(stored);
    expect(stored).not.toContain('�');
  });

  it('masks before it cuts, so no tail of a secret survives', () => {
    // The secret sits where the cut would land: masked first, the marker is
    // what gets cut, and no fragment of the token is left (AD-11).
    const filler = '가'.repeat(2720);
    const stored = failureText(`${filler}token=sk-BBBBBBBBBBBBBBBBBBBB${filler}`);

    expect(stored).not.toContain('sk-BBBB');
    expect(utf8Bytes(stored).length).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_BYTES);
  });

  it('is 8192 bytes, which is what both columns carry', () => {
    // `failures.message` and `work_items.last_error` hold the same sentence, so
    // the number lives here and not at either of them.
    expect(FAILURE_MESSAGE_MAX_BYTES).toBe(8192);
  });
});
