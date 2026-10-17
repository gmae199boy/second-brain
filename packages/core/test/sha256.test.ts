import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONTENT_HASH_PREFIX, contentHash, sha256Hex, utf8Bytes } from '../src/domain/sha256.js';

/**
 * Core's own SHA-256, held to the two things that can prove it: the published
 * vectors, and `node:crypto` — which Core itself may not import (AD-1), so the
 * comparison lives here in the tests rather than in the implementation.
 */

/** The reference, for a test that may import what Core may not. */
function reference(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('sha256 against the published vectors', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      // The 448-bit message of FIPS 180-4's appendix: 56 bytes, which is the
      // length that needs a second padding block.
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      // 896 bits: two blocks of message and a third of padding.
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ])('hashes %j', (text, expected) => {
    expect(sha256Hex(text)).toBe(expected);
  });

  it('hashes a million letters the way the vector says', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('sha256 against node:crypto', () => {
  it.each([
    '',
    'a',
    'the import notes are in notes/import.md',
    // Korean, an emoji and a combining mark: three and four byte sequences, and
    // a surrogate pair, which is where an encoder of one's own goes wrong.
    '비밀번호는 바꿨어',
    '한글😀 그리고 이모지',
    'égalité',
    '\u0000\u007f\u0080߿ࠀ￿',
  ])('agrees on %j', (text) => {
    expect(sha256Hex(text)).toBe(reference(text));
  });

  it('agrees on every message length around a block boundary', () => {
    for (let length = 0; length <= 130; length += 1) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text), `length ${String(length)}`).toBe(reference(text));
    }
  });
});

describe('the stored form of a hash', () => {
  it('is the prefix and lower case hex', () => {
    const hash = contentHash('abc');
    expect(hash).toBe(`${CONTENT_HASH_PREFIX}${reference('abc')}`);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('the UTF-8 encoder Core carries instead of TextEncoder', () => {
  it.each([
    '',
    'ascii',
    '비밀번호',
    '😀',
    'a😀b한',
  ])('encodes %j as the platform does', (text) => {
    expect([...utf8Bytes(text)]).toEqual([...Buffer.from(text, 'utf8')]);
  });

  it('turns a lone surrogate into the replacement character, as every encoder does', () => {
    // A half of a pair is not a character. Encoding it as though it were would
    // produce bytes no decoder accepts, and a hash `node:crypto` disagrees with.
    expect([...utf8Bytes('\ud83d')]).toEqual([...Buffer.from('\ud83d', 'utf8')]);
    expect([...utf8Bytes('a\udc00b')]).toEqual([...Buffer.from('a\udc00b', 'utf8')]);
  });
});
