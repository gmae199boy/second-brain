import type { ChunkLocator } from './chunk-locator.js';

/**
 * One reading of one file, in pieces (AD-24): the two rows the extraction story
 * writes, as the types the generation store and the extractors share.
 */

/**
 * How a reading ended, `null` while it is still running (migration 0004).
 * `finished_at` and this are set together, which is what
 * `document_extractions_finished_check` holds.
 */
export type DocumentExtractionStatus = 'ok' | 'failed' | 'unsupported' | 'too_large' | 'redacted';

/**
 * Where a failed reading stopped — reading the bytes, extracting the text,
 * cutting it into pieces, or indexing them — so that a retry starts from
 * knowledge rather than from the beginning. Only a `failed` reading has one,
 * and not even every one of those: the rows written before the column existed
 * have no stage, and inventing one would be a guess stored as a fact.
 */
export type DocumentExtractionFailedStage = 'read' | 'extract' | 'chunk' | 'index';

/**
 * How many pieces one `appendExtractionChunks` call may carry (AD-24의 예).
 *
 * One call is one write transaction, so this is the bound on how long any
 * caller can hold the single writer: two hundred pieces of a couple of thousand
 * characters each is the measured shape of the two-second rule, and a store that
 * enforces it is the only thing that keeps a careless caller from queueing every
 * other write behind one enormous batch (AD-7). A list longer than this is cut
 * into batches by `writeExtractionChunks`, not taken whole.
 */
export const DOCUMENT_CHUNK_BATCH_MAX = 200;

/** One reading of one file (AD-24). */
export interface DocumentExtraction {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `attempt`. */
  fileId: string;
  extractorVersion: string;
  /**
   * The per-file counter the store assigns as `max + 1` inside the insert
   * transaction, from 1. `files.current_extraction_id` may only move to a
   * higher one, so a reading that finishes late cannot overwrite a newer one.
   */
  attempt: number;
  /** What the bytes turned out to be, `null` when nothing read them yet. */
  mediaType: string | null;
  /** `null` while the reading is still running. */
  status: DocumentExtractionStatus | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** What went wrong, on a reading that failed. */
  error: string | null;
  failedStage: DocumentExtractionFailedStage | null;
  /**
   * Which chunking generation cut these pieces, the same question
   * `chunks.indexConfigId` answers for a conversation. `null` on the rows
   * written before the column existed.
   */
  indexConfigId: string | null;
}

/** One piece of one reading's text (AD-24). */
export interface DocumentChunk {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `ordinal`. */
  extractionId: string;
  ordinal: number;
  /**
   * The read-only copy of a PDF locator's page, for indexing and ordering, and
   * `null` for every other kind of piece — `chunkLocatorPage` is what fills it
   * and 0004's `check` is what holds it.
   */
  page: number | null;
  /** The piece's text, with no header of its own. */
  body: string;
  /**
   * Where the piece came from. `null` only on the rows written before migration
   * 0004 added the column: they were cut before anything recorded a position,
   * and a null says "unknown", which is what it is.
   */
  chunkLocator: ChunkLocator | null;
}
