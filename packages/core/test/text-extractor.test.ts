import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHUNK_PARAMS } from '../src/domain/document.js';
import { utf8Bytes } from '../src/domain/sha256.js';
import { textExtractor } from '../src/files/extractors.js';
import {
  TEXT_MEDIA_TYPE,
  chunkDocumentText,
  decodeUtf8Text,
} from '../src/files/text-extractor.js';

/**
 * The text extractor on its own: what counts as text, and where the pieces are
 * cut (AD-24).
 *
 * Both halves are pure functions of their input, which is why they are tested
 * here rather than through a drain: "is this a text document" is a question
 * about bytes and "where does this piece start" is a question about code points,
 * and neither needs a queue, a store or a clock to answer.
 */

/** The bytes of a string, as a real attachment of that text would hold them. */
function bytes(text: string): Uint8Array {
  return utf8Bytes(text);
}

/** A readable name for a byte string a decoder has to refuse. */
function raw(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('decodeUtf8Text', () => {
  it('reads ASCII, Korean and a character outside the BMP', () => {
    for (const text of ['hello', '안녕하세요 한글 문서', '이모지 😀 하나', 'a\tb\nc\r\nd\fe\u001bf']) {
      expect(decodeUtf8Text(bytes(text))).toEqual({ ok: true, text });
    }
  });

  it('drops one leading BOM and keeps a second one as content', () => {
    expect(decodeUtf8Text(bytes('﻿제목'))).toEqual({ ok: true, text: '제목' });
    // Two marks are one mark and one character: the second is content, because
    // a document cannot begin twice.
    expect(decodeUtf8Text(bytes('﻿﻿제목'))).toEqual({ ok: true, text: '﻿제목' });
    // And a BOM in the middle is content wherever it is.
    expect(decodeUtf8Text(bytes('제목﻿끝'))).toEqual({ ok: true, text: '제목﻿끝' });
  });

  it('keeps an empty file as empty text', () => {
    expect(decodeUtf8Text(raw())).toEqual({ ok: true, text: '' });
  });

  it.each([
    ['NUL', raw(0x41, 0x00, 0x42)],
    ['BEL', raw(0x41, 0x07)],
    ['SO', raw(0x0e)],
    ['US', raw(0x1f)],
  ])('refuses the control character %s', (_name, input) => {
    const result = decodeUtf8Text(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('제어 문자');
  });

  it('keeps DEL, which is not a C0 control character', () => {
    // The list of refusals is C0 and only C0: U+007F is how some older plain
    // text is padded, and a document is not binary because it holds one.
    expect(decodeUtf8Text(raw(0x41, 0x7f))).toEqual({ ok: true, text: 'A\u007f' });
  });

  it.each([
    ['끊긴 세 바이트', raw(0xe2, 0x82)],
    ['끊긴 두 바이트', raw(0x41, 0xc3)],
    ['홀로 온 이어지는 바이트', raw(0x80)],
    ['두 바이트 overlong', raw(0xc0, 0xaf)],
    ['0xc1 overlong', raw(0xc1, 0xbf)],
    ['세 바이트 overlong', raw(0xe0, 0x80, 0xaf)],
    ['네 바이트 overlong', raw(0xf0, 0x80, 0x80, 0xaf)],
    ['서로게이트 U+D800', raw(0xed, 0xa0, 0x80)],
    ['서로게이트 U+DFFF', raw(0xed, 0xbf, 0xbf)],
    ['U+10FFFF 초과', raw(0xf4, 0x90, 0x80, 0x80)],
    ['시작할 수 없는 0xf5', raw(0xf5, 0x80, 0x80, 0x80)],
    ['시작할 수 없는 0xff', raw(0xff, 0xfe)],
    ['이어지지 않는 둘째 바이트', raw(0xe2, 0x41, 0xac)],
  ])('refuses %s', (_name, input) => {
    expect(decodeUtf8Text(input).ok).toBe(false);
  });

  it('refuses a PNG, which is what "a binary named .txt" comes down to', () => {
    // The first eight bytes of every PNG. The signature is deliberately not
    // special-cased anywhere: it is refused because it is not text, and the
    // name it arrived under was never consulted (Boundaries).
    const png = raw(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
    expect(decodeUtf8Text(png).ok).toBe(false);
    expect(textExtractor.detect(png)).toBe(null);
  });

  it('is the one thing the text extractor decides a format from', () => {
    expect(textExtractor.detect(bytes('# 제목\n본문'))).toBe(TEXT_MEDIA_TYPE);
    // Markdown is `text/plain` too: nothing in this build reads the difference
    // and the content cannot settle it (Design Notes).
    expect(textExtractor.detect(bytes('plain'))).toBe(TEXT_MEDIA_TYPE);
  });
});

describe('chunkDocumentText', () => {
  const small = { targetChars: 14, overlapChars: 3 };

  it('cuts nothing out of empty text', () => {
    expect(chunkDocumentText('', DOCUMENT_CHUNK_PARAMS)).toEqual([]);
    expect(chunkDocumentText('   \n  ', DOCUMENT_CHUNK_PARAMS)).toEqual([]);
  });

  it('leaves text that fits in one piece as one piece', () => {
    expect(chunkDocumentText('짧은 문서', DOCUMENT_CHUNK_PARAMS)).toEqual([
      { body: '짧은 문서', chunkLocator: { type: 'text', start: 0, end: 5 }, page: null },
    ]);
  });

  it('cuts just after the last line break of the window and overlaps from there', () => {
    const pieces = chunkDocumentText('0123456789\nabcdefghij', small);
    expect(pieces).toEqual([
      { body: '0123456789\n', chunkLocator: { type: 'text', start: 0, end: 11 }, page: null },
      { body: '89\nabcdefghij', chunkLocator: { type: 'text', start: 8, end: 21 }, page: null },
    ]);
    // The overlap is the only reason the pieces share anything: the second one
    // starts three code points before the first one ended.
    expect(pieces[1]?.chunkLocator.start).toBe((pieces[0]?.chunkLocator.end ?? 0) - 3);
  });

  it('falls back to the last whitespace, then to the window itself', () => {
    expect(chunkDocumentText('0123456789 abcdefghij', small)[0]).toEqual({
      body: '0123456789 ',
      chunkLocator: { type: 'text', start: 0, end: 11 },
      page: null,
    });
    // Nothing to break on inside the second half: the window's own end is the
    // cut, so a document with no spaces still gets pieces of the right size.
    expect(chunkDocumentText('0123456789abcdefghij', small)).toEqual([
      { body: '0123456789abcd', chunkLocator: { type: 'text', start: 0, end: 14 }, page: null },
      { body: 'bcdefghij', chunkLocator: { type: 'text', start: 11, end: 20 }, page: null },
    ]);
  });

  it('ignores a break in the window’s first half', () => {
    // The break is at 2, the window is [0, 14) and its second half starts at 7,
    // so the piece is a whole window rather than three characters.
    expect(chunkDocumentText('ab\ncdefghijklmnopqrst', small)[0]?.chunkLocator).toEqual({
      type: 'text',
      start: 0,
      end: 14,
    });
  });

  it('skips a piece with nothing but whitespace in it', () => {
    const pieces = chunkDocumentText('ab\n   \n   \ncd', { targetChars: 4, overlapChars: 0 });
    // Two windows in the middle hold only spaces and a break. They are not
    // stored, and the ordinals of what is stored are the order it came out in —
    // which is why the worker numbers the pieces and not the windows.
    expect(pieces).toEqual([
      { body: 'ab\n', chunkLocator: { type: 'text', start: 0, end: 3 }, page: null },
      { body: 'cd', chunkLocator: { type: 'text', start: 11, end: 13 }, page: null },
    ]);
  });

  it('counts code points, so a surrogate pair is never split', () => {
    const pieces = chunkDocumentText('😀'.repeat(10), { targetChars: 4, overlapChars: 1 });
    expect(pieces.map((piece) => piece.chunkLocator)).toEqual([
      { type: 'text', start: 0, end: 4 },
      { type: 'text', start: 3, end: 7 },
      { type: 'text', start: 6, end: 10 },
    ]);
    for (const piece of pieces) {
      // Four characters and eight UTF-16 units: a cut made on `string.length`
      // would have stored half of a character.
      expect(Array.from(piece.body)).toHaveLength(4);
      expect(piece.body.length).toBe(8);
      expect(piece.body).toBe('😀'.repeat(4));
    }
  });

  it('covers the whole text, in order, with every locator naming its own body', () => {
    const text = Array.from({ length: 400 }, (_unused, index) => `줄 ${String(index)} 내용입니다`).join('\n');
    const points = Array.from(text);
    const pieces = chunkDocumentText(text, DOCUMENT_CHUNK_PARAMS);
    expect(pieces.length).toBeGreaterThan(1);

    let previousEnd = 0;
    for (const piece of pieces) {
      const { start, end } = piece.chunkLocator;
      expect(points.slice(start, end).join('')).toBe(piece.body);
      expect(start).toBeLessThan(end);
      // No gap: every piece starts at or before where the last one ended, so
      // nothing of the document falls between two pieces.
      expect(start).toBeLessThanOrEqual(previousEnd);
      previousEnd = end;
      expect(Array.from(piece.body).length).toBeLessThanOrEqual(DOCUMENT_CHUNK_PARAMS.targetChars);
    }
    expect(previousEnd).toBe(points.length);
  });
});
