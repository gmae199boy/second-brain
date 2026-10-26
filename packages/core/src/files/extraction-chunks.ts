import {
  DOCUMENT_CHUNK_BATCH_MAX,
} from '../domain/document.js';
import {
  chunkPageMatches,
  encodeChunkLocator,
  type ChunkLocator,
} from '../domain/chunk-locator.js';
import type {
  AppendExtractionChunksResult,
  ExtractionChunkInput,
  ExtractionStore,
} from '../ports/store.js';

/**
 * The Core half of the two-second rule (AD-7, AD-24).
 *
 * The store takes one bounded batch per write transaction, because that bound is
 * the only thing that keeps any caller from holding the single writer for as
 * long as its document happens to be. A caller with a whole document's worth of
 * pieces therefore does not get to hand them over at once — it hands them to
 * this, which cuts them into batches of `DOCUMENT_CHUNK_BATCH_MAX` and writes
 * them one transaction at a time.
 *
 * It is here and not in the store because the cut is not a storage decision:
 * every adapter would make the same one, and an adapter that made a different
 * one would be a second answer to "how long may one write take".
 */

/** One piece, checked, with the canonical text its column takes. */
export interface CheckedExtractionChunk {
  id: string;
  ordinal: number;
  body: string;
  /** The position, as the codec hands it back: keys in canonical order. */
  locator: ChunkLocator;
  /** `JSON.stringify` of that locator, the one spelling the column accepts. */
  text: string;
  /** The `page` copy, which is the locator's and agrees with the input's. */
  page: number | null;
}

export type CheckExtractionChunkBatchResult =
  | { ok: true; chunks: readonly CheckedExtractionChunk[] }
  | { ok: false; code: 'CHUNK_BATCH_TOO_LARGE' | 'CHUNK_INVALID'; message: string };

/** What the generation already holds, which a new batch may not collide with. */
export interface HeldExtractionChunks {
  /** Its pieces' ordinals: `(extraction_id, ordinal)` is the key. */
  ordinals: ReadonlySet<number>;
  /** Its pieces' ids. `document_chunks.id` is unique across every generation. */
  ids: ReadonlySet<string>;
}

/**
 * One batch of pieces as the store may write them, or the code that refuses it.
 *
 * Every adapter runs this and no adapter re-states it, so the fake and a real
 * database cannot drift on what a valid piece is. It answers for the whole
 * batch: the first invalid piece refuses all of them, which is what "the batch
 * is not written at all" means.
 *
 * A repeated ordinal and a repeated id are the same mistake twice over — inside
 * the batch, and against what the generation already holds — so all four share
 * `CHUNK_INVALID`. The id is checked here and not left to the database because
 * `document_chunks.id` is unique across every generation: a caller that reused
 * one would make a real adapter throw while a fake stored it happily, and a
 * difference like that is the thing this function exists to prevent.
 */
export function checkExtractionChunkBatch(
  chunks: readonly ExtractionChunkInput[],
  held: HeldExtractionChunks,
): CheckExtractionChunkBatchResult {
  if (chunks.length === 0 || chunks.length > DOCUMENT_CHUNK_BATCH_MAX) {
    return {
      ok: false,
      code: 'CHUNK_BATCH_TOO_LARGE',
      message: `조각 배치는 1개에서 ${String(DOCUMENT_CHUNK_BATCH_MAX)}개까지입니다: ${String(chunks.length)}개`,
    };
  }

  const checked: CheckedExtractionChunk[] = [];
  const seenOrdinals = new Set<number>();
  const seenIds = new Set<string>();
  for (const chunk of chunks) {
    const { ordinal } = chunk;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      return {
        ok: false,
        code: 'CHUNK_INVALID',
        message: `조각 ordinal이 0 이상의 정수가 아닙니다: ${String(ordinal)}`,
      };
    }
    if (seenOrdinals.has(ordinal) || held.ordinals.has(ordinal)) {
      return {
        ok: false,
        code: 'CHUNK_INVALID',
        message: `조각 ordinal이 겹칩니다: ${String(ordinal)}`,
      };
    }
    seenOrdinals.add(ordinal);
    if (seenIds.has(chunk.id) || held.ids.has(chunk.id)) {
      return {
        ok: false,
        code: 'CHUNK_INVALID',
        message: `조각 id가 겹칩니다: ${chunk.id}`,
      };
    }
    seenIds.add(chunk.id);

    const encoded = encodeChunkLocator(chunk.chunkLocator);
    if (!encoded.ok) {
      return { ok: false, code: 'CHUNK_INVALID', message: `조각 ${String(ordinal)}: ${encoded.message}` };
    }
    // `===` against the input, so a caller that left the field out is refused
    // rather than corrected: a `page` nobody copied is not a `page` that
    // happens to be right (`chunk-locator.ts`).
    if (!chunkPageMatches(encoded.locator, chunk.page)) {
      return {
        ok: false,
        code: 'CHUNK_INVALID',
        message: `조각 ${String(ordinal)}의 page가 위치와 맞지 않습니다: ${String(chunk.page)}`,
      };
    }
    checked.push({
      id: chunk.id,
      ordinal,
      body: chunk.body,
      locator: encoded.locator,
      text: encoded.text,
      page: encoded.page,
    });
  }
  return { ok: true, chunks: checked };
}

export interface WriteExtractionChunksInput {
  /** Only the one verb it calls, so a caller need not assemble a whole store. */
  store: Pick<ExtractionStore, 'appendExtractionChunks'>;
  extractionId: string;
  chunks: readonly ExtractionChunkInput[];
}

/**
 * Write a whole reading's pieces, `DOCUMENT_CHUNK_BATCH_MAX` per transaction.
 *
 * The batches go in order and the first failure is handed straight back, with
 * the batches before it already committed: a reading that stops half way is a
 * reading that gets closed as failed, and closing it removes its pieces (AD-24).
 * So there is nothing to undo here, and pretending otherwise would mean holding
 * one transaction open for the whole document.
 *
 * An empty list goes to the store as an empty batch rather than being answered
 * here, because `CHUNK_BATCH_TOO_LARGE` is the one answer to "a batch with no
 * pieces" and a helper that quietly succeeded would hide the caller that asked.
 */
export async function writeExtractionChunks({
  store,
  extractionId,
  chunks,
}: WriteExtractionChunksInput): Promise<AppendExtractionChunksResult> {
  if (chunks.length === 0) return store.appendExtractionChunks({ extractionId, chunks });

  let appended = 0;
  for (let start = 0; start < chunks.length; start += DOCUMENT_CHUNK_BATCH_MAX) {
    const batch = chunks.slice(start, start + DOCUMENT_CHUNK_BATCH_MAX);
    const written = await store.appendExtractionChunks({ extractionId, chunks: batch });
    if (!written.ok) return written;
    appended += written.appended;
  }
  return { ok: true, appended };
}
