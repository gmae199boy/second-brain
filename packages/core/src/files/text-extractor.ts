import type { TextChunkLocator } from '../domain/chunk-locator.js';
import type { DocumentChunkParams } from '../domain/index-config.js';

/**
 * The one extractor this build has: a plain text document, read strictly and
 * cut on character boundaries (AD-24).
 *
 * Two things in here are deliberate and easy to get wrong.
 *
 * The decode is strict and hand written. Strict, because deciding what a file
 * *is* from its bytes means a decoder that refuses is the answer: a PNG whose
 * name happens to end in `.txt` is not a text document, and a lenient decoder
 * would turn it into a page of U+FFFD and index that. Hand written, because
 * Core has no `TextDecoder` — it compiles against `es2024` with no library
 * types at all, the same reason `domain/sha256.ts` spells out UTF-8 encoding
 * (AD-1).
 *
 * The cut counts code points and not UTF-16 units, because that is what a text
 * locator's `[start, end)` is counted in (`domain/chunk-locator.ts`). A cut
 * made on `string.length` would split a surrogate pair, which is half of a
 * character stored as a piece of text.
 */

/** The media type every text document gets, Markdown included (Design Notes). */
export const TEXT_MEDIA_TYPE = 'text/plain';

export type DecodeUtf8TextResult =
  | { ok: true; text: string }
  | { ok: false; message: string };

/**
 * One piece of a text document, as the extractor hands it over: everything but
 * the `ordinal` and the id, which the worker assigns (AD-8).
 */
export interface DocumentTextPiece {
  body: string;
  chunkLocator: TextChunkLocator;
  /** A text document has no pages, and the column is compared with `===`. */
  page: null;
}

/** U+FEFF, which a text document may carry one of at the front. */
const BOM = 0xfeff;

/**
 * The C0 characters a text document may hold: TAB, LF, FF, CR and ESC.
 *
 * Everything else below U+0020 — NUL above all — is how a binary file whose
 * bytes happen to decode gives itself away. ESC is in the list because a
 * terminal capture is a text document, and FF because a printable document may
 * still be paginated.
 */
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

/** A piece with nothing in it but whitespace, which is not worth storing. */
const BLANK = /^\s*$/u;

/**
 * How many code points go into one `String.fromCodePoint` call.
 *
 * Spreading an eight-mebibyte document into one call is an argument list long
 * enough to overflow the stack, so the string is built a block at a time.
 */
const BLOCK = 4096;

/**
 * The bytes as text, or why they are not text at all.
 *
 * Strict UTF-8: a truncated sequence, a stray continuation byte, an overlong
 * encoding, a surrogate half and anything above U+10FFFF are each a refusal and
 * never a replacement character. One leading BOM is dropped — it is a mark and
 * not content, and leaving it in would put it in the first piece's body and
 * shift every offset by one.
 */
export function decodeUtf8Text(bytes: Uint8Array): DecodeUtf8TextResult {
  const points = utf8CodePoints(bytes);
  if (!points.ok) return { ok: false, message: points.message };

  const start = points.points[0] === BOM ? 1 : 0;
  let text = '';
  for (let at = start; at < points.points.length; at += BLOCK) {
    const block = points.points.slice(at, at + BLOCK);
    for (const point of block) {
      if (point < 0x20 && !ALLOWED_CONTROLS.has(point)) {
        return {
          ok: false,
          message: `텍스트가 아닌 제어 문자가 있습니다: U+${point.toString(16).toUpperCase().padStart(4, '0')}`,
        };
      }
    }
    text += String.fromCodePoint(...block);
  }
  return { ok: true, text };
}

/**
 * Cut one document's text into pieces of about `targetChars` code points,
 * overlapping by `overlapChars`.
 *
 * The boundary is looked for backwards inside the window's second half: the
 * last line break, then the last whitespace, then the window's own end. Looking
 * only in the second half is what keeps a piece from collapsing to a few
 * characters because the text happened to start with a short line, and the
 * overlap is what keeps a sentence that straddles a boundary findable from
 * either side.
 *
 * A piece with nothing but whitespace in it is dropped rather than stored, so
 * the ordinals are the order the pieces came out in and not the order of the
 * windows. The locators still name the real range of the text they came from,
 * which is what makes a piece quotable (AD-24).
 */
export function chunkDocumentText(
  text: string,
  params: DocumentChunkParams,
): readonly DocumentTextPiece[] {
  const points = Array.from(text);
  // A target below one would be a window that cannot move, and an overlap at
  // or above the target would be a window that never reaches the end. Neither
  // is reachable from `DOCUMENT_CHUNK_PARAMS`; both are clamped rather than
  // thrown on, because the parameters are data and a reading is not the place
  // to find out that a row is wrong.
  const target = Math.max(1, Math.floor(params.targetChars));
  const overlap = Math.min(Math.max(0, Math.floor(params.overlapChars)), target - 1);
  const half = Math.floor(target / 2);

  const pieces: DocumentTextPiece[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + target, points.length);
    if (end < points.length) {
      const broken = lastBreak(points, start + half, end);
      if (broken !== null) end = broken;
    }
    const body = points.slice(start, end).join('');
    if (!BLANK.test(body)) {
      pieces.push({ body, chunkLocator: { type: 'text', start, end }, page: null });
    }
    if (end >= points.length) break;
    // `start + 1` is unreachable with the clamped overlap above, and is kept as
    // the guarantee that the loop moves whatever the parameters say.
    start = Math.max(start + 1, end - overlap);
  }
  return pieces;
}

/**
 * Where to cut, searching back from `end` and no further than `floor`: just
 * after the last line break, else just after the last whitespace, else nothing.
 *
 * "Just after" rather than "at", so the separator ends the piece it belongs to
 * and consecutive pieces cover the text without a gap.
 */
function lastBreak(
  points: readonly string[],
  floor: number,
  end: number,
): number | null {
  for (let at = end - 1; at >= floor; at -= 1) {
    if (points[at] === '\n') return at + 1;
  }
  for (let at = end - 1; at >= floor; at -= 1) {
    const point = points[at];
    if (point !== undefined && /\s/u.test(point)) return at + 1;
  }
  return null;
}

type Utf8CodePointsResult =
  | { ok: true; points: readonly number[] }
  | { ok: false; message: string };

/**
 * Every code point of a strict UTF-8 byte string, or the first thing that was
 * not one.
 *
 * The lead byte decides the length and the two bounds that cannot be read from
 * the continuation bytes alone: `0xe0` with a low second byte is an overlong
 * three-byte encoding, `0xed` with a high one is a surrogate, `0xf0` with a low
 * one is an overlong four-byte encoding, and `0xf4` with a high one is above
 * U+10FFFF. `0xc0` and `0xc1` are overlong by themselves, and `0xf5` and up
 * cannot start anything (RFC 3629 §4).
 */
function utf8CodePoints(bytes: Uint8Array): Utf8CodePointsResult {
  const points: number[] = [];
  let at = 0;
  const refuse = (why: string, index: number): { ok: false; message: string } => ({
    ok: false,
    message: `${index}번째 바이트에서 UTF-8이 아닙니다: ${why}`,
  });

  while (at < bytes.length) {
    const lead = bytes[at] ?? 0;
    if (lead < 0x80) {
      points.push(lead);
      at += 1;
      continue;
    }

    let length: number;
    let point: number;
    let lowest: number;
    let highest: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      point = lead & 0x1f;
      lowest = 0x80;
      highest = 0xbf;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      point = lead & 0x0f;
      lowest = lead === 0xe0 ? 0xa0 : 0x80;
      highest = lead === 0xed ? 0x9f : 0xbf;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      point = lead & 0x07;
      lowest = lead === 0xf0 ? 0x90 : 0x80;
      highest = lead === 0xf4 ? 0x8f : 0xbf;
    } else {
      return refuse(`시작할 수 없는 바이트 0x${lead.toString(16)}`, at);
    }

    if (at + length > bytes.length) return refuse('바이트 순서가 끊겼습니다', at);
    for (let step = 1; step < length; step += 1) {
      const next = bytes[at + step] ?? 0;
      const floor = step === 1 ? lowest : 0x80;
      const ceiling = step === 1 ? highest : 0xbf;
      if (next < floor || next > ceiling) {
        return refuse(`이어지는 바이트가 아닙니다 0x${next.toString(16)}`, at + step);
      }
      point = (point << 6) | (next & 0x3f);
    }
    points.push(point);
    at += length;
  }
  return { ok: true, points };
}
