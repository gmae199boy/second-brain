import { describe, expect, it } from 'vitest';
import {
  chunkLocatorPage,
  chunkPageMatches,
  decodeChunkLocator,
  encodeChunkLocator,
  type ChunkLocator,
} from '../src/domain/chunk-locator.js';

/**
 * The one spelling of a document piece's position (AD-24). What is held here is
 * that the text is a function of the position and not of how the caller wrote
 * it down, that the `page` copy follows the kind, and that decode takes the
 * canonical spelling and nothing else — including spellings the database would
 * let through.
 */

/** The canonical text, or the failure message, as one value to compare. */
function text(input: unknown): string {
  const result = encodeChunkLocator(input);
  return result.ok ? result.text : `ok:false`;
}

const TEXT_CANONICAL = '{"type":"text","start":0,"end":12}';
const PDF_CANONICAL = '{"type":"pdf","page":4}';
const PDF_BBOX_CANONICAL = '{"type":"pdf","page":4,"bbox":[0.1,0.2,0.5,0.75]}';
const DOCX_CANONICAL = '{"type":"docx","block":3}';

describe('encodeChunkLocator', () => {
  it.each([
    { name: '키 순서가 달라도 같은 텍스트', input: { end: 12, start: 0, type: 'text' }, expected: TEXT_CANONICAL, page: null },
    { name: 'text의 정규 순서', input: { type: 'text', start: 0, end: 12 }, expected: TEXT_CANONICAL, page: null },
    { name: 'null 칸은 없는 칸(text)', input: { type: 'text', start: 0, end: 12, page: null }, expected: TEXT_CANONICAL, page: null },
    { name: 'undefined 칸은 없는 칸(text)', input: { type: 'text', start: 0, end: 12, page: undefined }, expected: TEXT_CANONICAL, page: null },
    { name: 'null 칸은 없는 칸(pdf bbox)', input: { type: 'pdf', page: 4, bbox: null }, expected: PDF_CANONICAL, page: 4 },
    { name: 'pdf bbox', input: { bbox: [0.1, 0.2, 0.5, 0.75], page: 4, type: 'pdf' }, expected: PDF_BBOX_CANONICAL, page: 4 },
    { name: 'docx', input: { type: 'docx', block: 3 }, expected: DOCX_CANONICAL, page: null },
    { name: '빈 text 범위', input: { type: 'text', start: 7, end: 7 }, expected: '{"type":"text","start":7,"end":7}', page: null },
    { name: '맞닿은 bbox', input: { type: 'pdf', page: 1, bbox: [0, 0, 0, 1] }, expected: '{"type":"pdf","page":1,"bbox":[0,0,0,1]}', page: 1 },
  ])('$name', ({ input, expected, page }) => {
    const result = encodeChunkLocator(input);
    expect(result).toEqual({
      ok: true,
      locator: JSON.parse(expected) as ChunkLocator,
      text: expected,
      page,
    });
  });

  it('같은 위치를 다른 키 순서·null 칸으로 쓴 입력은 모두 같은 텍스트가 된다', () => {
    const spellings = [
      { type: 'text', start: 0, end: 12 },
      { end: 12, start: 0, type: 'text' },
      { start: 0, type: 'text', end: 12 },
      { type: 'text', page: null, start: 0, end: 12 },
      { end: 12, page: undefined, type: 'text', start: 0 },
    ];
    expect(new Set(spellings.map(text))).toEqual(new Set([TEXT_CANONICAL]));
  });

  it.each([
    { name: 'text에 end가 없음', input: { type: 'text', start: 0 } },
    { name: 'text에 start가 없음', input: { type: 'text', end: 12 } },
    { name: 'text가 비어 있음', input: { type: 'text' } },
    { name: 'pdf에 page가 없음', input: { type: 'pdf' } },
    { name: 'pdf의 page가 null', input: { type: 'pdf', page: null } },
    { name: 'docx에 block이 없음', input: { type: 'docx' } },
  ])('필수 키가 빠지면 거부한다: $name', ({ input }) => {
    expect(encodeChunkLocator(input)).toMatchObject({ ok: false });
  });

  it.each([
    { name: 'text에 page', input: { type: 'text', start: 0, end: 12, page: 4 } },
    { name: 'text에 block', input: { type: 'text', start: 0, end: 12, block: 3 } },
    { name: 'docx에 start', input: { type: 'docx', block: 3, start: 0 } },
    { name: 'docx에 bbox', input: { type: 'docx', block: 3, bbox: [0, 0, 1, 1] } },
    { name: 'pdf에 start', input: { type: 'pdf', page: 4, start: 0 } },
    { name: '아무도 모르는 키', input: { type: 'text', start: 0, end: 12, zip: 1 } },
  ])('다른 종류의 키를 거부한다: $name', ({ input }) => {
    expect(encodeChunkLocator(input)).toMatchObject({ ok: false });
  });

  it.each([
    { name: 'time', input: { type: 'time', start: 0, end: 12 } },
    { name: 'sheet', input: { type: 'sheet', row: 1 } },
    { name: 'zip', input: { type: 'zip' } },
    { name: 'type이 없음', input: { start: 0, end: 12 } },
    { name: 'type이 null', input: { type: null, start: 0, end: 12 } },
    { name: 'type이 수', input: { type: 4 } },
    { name: '객체가 아님(배열)', input: [{ type: 'text', start: 0, end: 12 }] },
    { name: '객체가 아님(문자열)', input: '{"type":"text","start":0,"end":12}' },
    { name: '객체가 아님(null)', input: null },
    { name: '객체가 아님(없음)', input: undefined },
    { name: '객체가 아님(수)', input: 4 },
  ])('모르는 종류를 거부한다: $name', ({ input }) => {
    expect(encodeChunkLocator(input)).toMatchObject({ ok: false });
  });

  it.each([
    { name: 'pdf page가 0', input: { type: 'pdf', page: 0 } },
    { name: 'pdf page가 음수', input: { type: 'pdf', page: -1 } },
    { name: 'pdf page가 소수', input: { type: 'pdf', page: 1.5 } },
    { name: 'pdf page가 NaN', input: { type: 'pdf', page: Number.NaN } },
    { name: 'pdf page가 Infinity', input: { type: 'pdf', page: Number.POSITIVE_INFINITY } },
    { name: 'pdf page가 문자열', input: { type: 'pdf', page: '4' } },
    { name: 'docx block이 0', input: { type: 'docx', block: 0 } },
    { name: 'docx block이 소수', input: { type: 'docx', block: 2.5 } },
    { name: 'docx block이 문자열', input: { type: 'docx', block: '3' } },
    { name: 'text start가 음수', input: { type: 'text', start: -1, end: 12 } },
    { name: 'text end가 소수', input: { type: 'text', start: 0, end: 1.5 } },
    { name: 'text end가 NaN', input: { type: 'text', start: 0, end: Number.NaN } },
    { name: 'text end가 문자열', input: { type: 'text', start: 0, end: '12' } },
    { name: 'text start > end', input: { type: 'text', start: 13, end: 12 } },
    { name: 'bbox가 짧음', input: { type: 'pdf', page: 4, bbox: [0, 0, 1] } },
    { name: 'bbox가 김', input: { type: 'pdf', page: 4, bbox: [0, 0, 1, 1, 1] } },
    { name: 'bbox가 배열이 아님', input: { type: 'pdf', page: 4, bbox: { x0: 0 } } },
    { name: 'bbox가 1 밖', input: { type: 'pdf', page: 4, bbox: [0, 0, 1.5, 1] } },
    { name: 'bbox가 0 밖', input: { type: 'pdf', page: 4, bbox: [-0.1, 0, 1, 1] } },
    { name: 'bbox에 NaN', input: { type: 'pdf', page: 4, bbox: [0, 0, Number.NaN, 1] } },
    { name: 'bbox에 문자열', input: { type: 'pdf', page: 4, bbox: [0, 0, '1', 1] } },
    { name: 'bbox x0 > x1', input: { type: 'pdf', page: 4, bbox: [0.6, 0, 0.5, 1] } },
    { name: 'bbox y0 > y1', input: { type: 'pdf', page: 4, bbox: [0, 0.6, 1, 0.5] } },
    // 2^53 위의 정수는 JSON.stringify가 `1e+21`처럼 적어, strict integer 칸이 받지 않는다.
    { name: 'pdf page가 2^53 위', input: { type: 'pdf', page: 1e21 } },
    { name: 'pdf page가 2^53 바로 위', input: { type: 'pdf', page: 2 ** 53 } },
    { name: 'docx block이 2^53 위', input: { type: 'docx', block: 1e21 } },
    { name: 'text end가 2^53 위', input: { type: 'text', start: 0, end: 1e21 } },
  ])('잘못된 수를 거부한다: $name', ({ input }) => {
    expect(encodeChunkLocator(input)).toMatchObject({ ok: false });
  });

  it.each([
    { name: 'text start가 -0', input: { type: 'text', start: -0, end: 12 }, expected: TEXT_CANONICAL },
    { name: 'text가 둘 다 -0', input: { type: 'text', start: -0, end: -0 }, expected: '{"type":"text","start":0,"end":0}' },
    { name: 'bbox에 -0', input: { type: 'pdf', page: 4, bbox: [-0, 0, 1, -0] }, expected: '{"type":"pdf","page":4,"bbox":[0,0,1,0]}' },
  ])('-0은 0으로 적고 왕복한다: $name', ({ input, expected }) => {
    const result = encodeChunkLocator(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(expected);
    expect(decodeChunkLocator(result.text)).toEqual(result);
  });

  it('거부 메시지는 한국어 한 줄이다', () => {
    const result = encodeChunkLocator({ type: 'text', start: 0, end: 12, page: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('page');
    expect(result.message).not.toContain('\n');
  });
});

describe('decodeChunkLocator', () => {
  it.each([TEXT_CANONICAL, PDF_CANONICAL, PDF_BBOX_CANONICAL, DOCX_CANONICAL])(
    '정규형을 왕복한다: %s',
    (canonical) => {
      const decoded = decodeChunkLocator(canonical);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.text).toBe(canonical);
      expect(encodeChunkLocator(decoded.locator)).toEqual(decoded);
    },
  );

  it('인코드한 텍스트를 다시 디코드해도 같은 위치다', () => {
    for (const input of [
      { end: 12, start: 0, type: 'text' },
      { bbox: [0.1, 0.2, 0.5, 0.75], page: 4, type: 'pdf' },
      { type: 'pdf', page: 4, bbox: null },
      { type: 'docx', block: 3 },
    ]) {
      const encoded = encodeChunkLocator(input);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(decodeChunkLocator(encoded.text)).toEqual(encoded);
    }
  });

  it.each([
    { name: '공백이 있음', spelling: '{"type": "text", "start": 0, "end": 12}' },
    { name: '키 순서가 다름', spelling: '{"type":"text","end":12,"start":0}' },
    { name: 'type이 첫 키가 아님', spelling: '{"start":0,"end":12,"type":"text"}' },
    { name: 'null 칸이 적혀 있음', spelling: '{"type":"text","start":0,"end":12,"page":null}' },
    { name: '필수 키가 없음', spelling: '{"type":"text"}' },
    { name: 'JSON이 아님', spelling: '{"type":"text"' },
    { name: '객체가 아님', spelling: '"text"' },
    { name: '빈 문자열', spelling: '' },
  ])('비정규 철자를 거부한다: $name', ({ spelling }) => {
    expect(decodeChunkLocator(spelling)).toMatchObject({ ok: false });
  });
});

describe('page 사본', () => {
  const textLocator: ChunkLocator = { type: 'text', start: 0, end: 12 };
  const pdfLocator: ChunkLocator = { type: 'pdf', page: 4 };
  const docxLocator: ChunkLocator = { type: 'docx', block: 3 };

  it('pdf만 page를 가진다', () => {
    expect(chunkLocatorPage(pdfLocator)).toBe(4);
    expect(chunkLocatorPage(textLocator)).toBeNull();
    expect(chunkLocatorPage(docxLocator)).toBeNull();
  });

  it('undefined는 null과 다르다', () => {
    expect(chunkPageMatches(textLocator, undefined)).toBe(false);
    expect(chunkPageMatches(textLocator, null)).toBe(true);
    expect(chunkPageMatches(textLocator, 4)).toBe(false);
    expect(chunkPageMatches(pdfLocator, 4)).toBe(true);
    expect(chunkPageMatches(pdfLocator, null)).toBe(false);
    expect(chunkPageMatches(pdfLocator, undefined)).toBe(false);
    expect(chunkPageMatches(docxLocator, null)).toBe(true);
  });
});
