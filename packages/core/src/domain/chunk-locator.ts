/**
 * Where a piece of a document came from, and the one spelling of it (AD-24).
 *
 * `page` was never enough: a text document has a character range, a word
 * processor's document has a numbered block, and a PDF has a page *and* a
 * region on it. So the position of a piece is one JSON object, and
 * `document_chunks.chunk_locator` (migration 0004) takes exactly one spelling
 * of it -- `json(x) = x` rules out stray whitespace, and this file is what
 * fixes the key order. Nothing else in the project may build that text: two
 * spellings of one position would be two values of one fact.
 *
 * Three kinds, because three kinds have a consumer. `time` (a recording) and
 * `sheet` (a spreadsheet) are spelled out in 0004's `check` so that the column
 * need not be migrated again when they arrive, but they have no extractor yet
 * and no shape anybody has settled, so the codec refuses them: a position this
 * build cannot read is a position this build must not write.
 *
 * Counting follows the source this came from (weknora `source_locator.go`):
 * a PDF's `page` and a document's `block` start at 1, a `bbox` is
 * `[x0, y0, x1, y1]` as fractions of the page's width and height with the
 * origin at the top left, and a text range is the half-open interval
 * `[start, end)` over code points (Conventions).
 */

/** The kinds of position this build can read and write, in no order of its own. */
export const CHUNK_LOCATOR_TYPES = ['pdf', 'docx', 'text'] as const;

export type ChunkLocatorType = (typeof CHUNK_LOCATOR_TYPES)[number];

/** A page of a PDF, and optionally a region on it. */
export interface PdfChunkLocator {
  type: 'pdf';
  /** The page the piece is on, counted from 1. */
  page: number;
  /**
   * `[x0, y0, x1, y1]`, each a fraction of the page's width or height from the
   * top left corner, so `x0 <= x1` and `y0 <= y1`. Absent when the extractor
   * knows the page but not the region.
   */
  bbox?: [number, number, number, number];
}

/** A numbered block of a word processor's document, counted from 1. */
export interface DocxChunkLocator {
  type: 'docx';
  block: number;
}

/** A half-open code point range `[start, end)` of a text document. */
export interface TextChunkLocator {
  type: 'text';
  start: number;
  end: number;
}

export type ChunkLocator = PdfChunkLocator | DocxChunkLocator | TextChunkLocator;

/**
 * The position, its canonical text and the `page` copy the column carries -- or
 * why there is none. No code: this is a codec and not a command, and whoever
 * calls it reports the failure under the code of what sent it here (the
 * `spool-record.ts` convention).
 */
export type EncodeChunkLocatorResult =
  | { ok: true; locator: ChunkLocator; text: string; page: number | null }
  | { ok: false; message: string };

export type DecodeChunkLocatorResult = EncodeChunkLocatorResult;

/**
 * The keys every kind must carry. Membership only: the order the text is
 * written in comes from the literals each branch hands `encoded`.
 */
const REQUIRED_KEYS: Record<ChunkLocatorType, readonly string[]> = {
  pdf: ['page'],
  docx: ['block'],
  text: ['start', 'end'],
};

/** The keys a kind may carry and need not. Only a PDF has one. */
const OPTIONAL_KEYS: Record<ChunkLocatorType, readonly string[]> = {
  pdf: ['bbox'],
  docx: [],
  text: [],
};

function isChunkLocatorType(value: unknown): value is ChunkLocatorType {
  return typeof value === 'string' && (CHUNK_LOCATOR_TYPES as readonly string[]).includes(value);
}

/**
 * Counted from 1: a page and a block.
 *
 * `isSafeInteger` and not `isInteger`, the same bound `spool-record.ts` uses:
 * `1e21` is an integer to JavaScript but `JSON.stringify` writes it `1e+21`,
 * which the `strict` integer `page` column refuses -- a number this codec
 * cannot store is a number it must not hand back as canonical.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Counted from 0: an offset into text, under the same bound. */
function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `-0` as `0`.
 *
 * `JSON.stringify(-0)` is `"0"`, so a locator that kept the negative zero would
 * not be the locator its own canonical text decodes back to. The sign of zero
 * is not a position, and this is the only place it is dropped.
 */
function zero(value: number): number {
  return value === 0 ? 0 : value;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return '없음';
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? JSON.stringify(value) : '객체';
  return String(value);
}

/**
 * The result, built from a locator whose keys were written in canonical order.
 *
 * `JSON.stringify` keeps the insertion order of a plain object's keys, so the
 * literal each branch builds *is* the key order of the text, and there is no
 * second list of keys to keep in step with the first.
 */
function encoded(locator: ChunkLocator): EncodeChunkLocatorResult {
  return {
    ok: true,
    locator,
    text: JSON.stringify(locator),
    page: chunkLocatorPage(locator),
  };
}

/**
 * One position as the canonical text the database takes.
 *
 * The input's key order does not matter, and a key whose value is `null` or
 * `undefined` is read as a key that is not there -- which is what makes
 * `{ type: 'text', start: 0, end: 12, page: null }` the same position as the
 * same object without the `page`, while `page: 4` on a text range is a key this
 * kind has no meaning for and is refused. A key of another kind, a missing
 * required key, a number that is not the kind of number its key names, and a
 * kind this build cannot read are all refused here, because the database's
 * `check` can only see the four things it was given.
 */
export function encodeChunkLocator(input: unknown): EncodeChunkLocatorResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: `조각 위치가 객체가 아닙니다: ${describe(input)}` };
  }

  // A key with a null or undefined value is a key that is not there.
  const present = new Map<string, unknown>();
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) present.set(key, value);
  }

  const type = present.get('type');
  if (!isChunkLocatorType(type)) {
    return { ok: false, message: `모르는 조각 위치 종류입니다: ${describe(type)}` };
  }

  const allowed = new Set<string>(['type', ...REQUIRED_KEYS[type], ...OPTIONAL_KEYS[type]]);
  for (const key of present.keys()) {
    if (!allowed.has(key)) {
      return { ok: false, message: `${type} 조각 위치가 모르는 키입니다: ${key}` };
    }
  }
  for (const key of REQUIRED_KEYS[type]) {
    if (!present.has(key)) {
      return { ok: false, message: `${type} 조각 위치에 ${key}가 없습니다` };
    }
  }

  if (type === 'text') {
    const start = present.get('start');
    const end = present.get('end');
    if (!isOffset(start)) {
      return { ok: false, message: `text 조각 위치의 start가 0 이상의 정수가 아닙니다: ${describe(start)}` };
    }
    if (!isOffset(end)) {
      return { ok: false, message: `text 조각 위치의 end가 0 이상의 정수가 아닙니다: ${describe(end)}` };
    }
    if (start > end) {
      return { ok: false, message: `text 조각 위치의 start가 end보다 큽니다: ${start} > ${end}` };
    }
    return encoded({ type: 'text', start: zero(start), end: zero(end) });
  }

  if (type === 'docx') {
    const block = present.get('block');
    if (!isCount(block)) {
      return { ok: false, message: `docx 조각 위치의 block이 1 이상의 정수가 아닙니다: ${describe(block)}` };
    }
    return encoded({ type: 'docx', block });
  }

  const page = present.get('page');
  if (!isCount(page)) {
    return { ok: false, message: `pdf 조각 위치의 page가 1 이상의 정수가 아닙니다: ${describe(page)}` };
  }
  const rawBbox = present.get('bbox');
  if (rawBbox === undefined) return encoded({ type: 'pdf', page });

  if (!Array.isArray(rawBbox) || rawBbox.length !== 4) {
    return { ok: false, message: `pdf 조각 위치의 bbox가 네 수의 배열이 아닙니다: ${describe(rawBbox)}` };
  }
  const bbox: number[] = [];
  for (const value of rawBbox as readonly unknown[]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, message: `pdf 조각 위치의 bbox 값이 0과 1 사이의 수가 아닙니다: ${describe(value)}` };
    }
    bbox.push(zero(value));
  }
  const [x0, y0, x1, y1] = bbox as [number, number, number, number];
  if (x0 > x1 || y0 > y1) {
    return {
      ok: false,
      message: `pdf 조각 위치의 bbox가 왼쪽 위에서 오른쪽 아래로 가지 않습니다: ${JSON.stringify(bbox)}`,
    };
  }
  return encoded({ type: 'pdf', page, bbox: [x0, y0, x1, y1] });
}

/**
 * The canonical text back as a position.
 *
 * Only the canonical spelling is taken: a text that encodes back to something
 * else -- another key order, a `null` key, whitespace -- is refused even though
 * the database would have refused it too, and a text that is missing a required
 * key is refused even though the database takes it. 0004's `check` asks four
 * questions and this asks the rest, so a row whose locator this cannot read is
 * a row written by something that was not this codec.
 */
export function decodeChunkLocator(text: string): DecodeChunkLocatorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, message: `조각 위치가 JSON이 아닙니다: ${JSON.stringify(text)}` };
  }
  const result = encodeChunkLocator(parsed);
  if (!result.ok) return result;
  if (result.text !== text) {
    return {
      ok: false,
      message: `조각 위치가 정규형이 아닙니다: ${JSON.stringify(text)}, 정규형은 ${JSON.stringify(result.text)}`,
    };
  }
  return result;
}

/**
 * The `document_chunks.page` copy of a position: a PDF's page, and nothing for
 * every other kind. 0004 compares the column with `is` and not `=`, so the
 * absence has to be `null` and not `undefined`.
 */
export function chunkLocatorPage(locator: ChunkLocator): number | null {
  return locator.type === 'pdf' ? locator.page : null;
}

/**
 * Whether a `page` column goes with this position.
 *
 * Compared with `===`, which makes `undefined` a different answer from `null`:
 * a caller that forgot to read the column is not a caller whose row happens to
 * be right, and the mismatch is what 0004's `check` would have raised anyway.
 */
export function chunkPageMatches(locator: ChunkLocator, page: number | null | undefined): boolean {
  return chunkLocatorPage(locator) === page;
}
