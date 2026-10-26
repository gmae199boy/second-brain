import type { ChunkLocator } from '../domain/chunk-locator.js';
import type { DocumentChunkParams } from '../domain/index-config.js';
import {
  TEXT_MEDIA_TYPE,
  chunkDocumentText,
  decodeUtf8Text,
} from './text-extractor.js';

/**
 * Which extractors this build has, and what one of them is (AD-24).
 *
 * The registry is a list and the order is the decision: the first extractor
 * whose `detect` answers is the one that reads the file. So a new format goes in
 * *before* the text extractor — an EXIF, PDF or docx reader recognises its own
 * bytes, and the text extractor is the one that answers for everything that
 * decodes, which makes it the right last resort and the wrong first guess.
 *
 * `detect` is given the bytes and nothing else, because the format of a file is
 * a fact about its content. An extension and a display name are what somebody
 * typed: `report.txt` holding a PNG is a real attachment, and believing the name
 * would mean indexing a page of replacement characters (Boundaries).
 */

/** One piece an extractor produces, before the worker gives it an id. */
export interface DocumentExtractorPiece {
  body: string;
  chunkLocator: ChunkLocator;
  page: number | null;
}

export type DocumentExtractResult =
  | { ok: true; pieces: readonly DocumentExtractorPiece[] }
  | { ok: false; message: string };

export interface DocumentExtractor {
  /** What this extractor is, for the sentence of a reading that failed. */
  name: string;
  /**
   * The media type of these bytes, or `null` for "not mine". Content only: no
   * extension, no display name, nothing a person typed (Boundaries).
   */
  detect(bytes: Uint8Array): string | null;
  /**
   * The pieces of these bytes, or why there are none.
   *
   * The media type is the one `detect` answered, passed back rather than worked
   * out again: an extractor that recognises two formats reads the bytes once.
   * It is `async` because a later extractor will have to be — a PDF reader is a
   * library call — and a port whose shape changes for the second implementation
   * is a port that was written for the first.
   */
  extract(
    bytes: Uint8Array,
    mediaType: string,
    params: DocumentChunkParams,
  ): Promise<DocumentExtractResult>;
}

/**
 * The plain text extractor: a strict UTF-8 decode and a cut on character
 * boundaries (`text-extractor.ts`).
 *
 * Markdown is `text/plain` too. Telling the two apart from the content is a
 * guess — a document with no `#` in it is not prose, and one full of them may
 * be — and nothing in this build reads the distinction, so inventing it would
 * be a stored guess with no reader (Design Notes).
 */
export const textExtractor: DocumentExtractor = {
  name: 'text',
  detect(bytes) {
    return decodeUtf8Text(bytes).ok ? TEXT_MEDIA_TYPE : null;
  },
  async extract(bytes, _mediaType, params) {
    const decoded = decodeUtf8Text(bytes);
    // Reachable only if the bytes changed between `detect` and here, which they
    // cannot: both are given the same array. It is a refusal rather than a throw
    // because an extractor saying "I could not read this" is an ordinary
    // outcome and the worker already knows what to do with it.
    if (!decoded.ok) return { ok: false, message: decoded.message };
    return { ok: true, pieces: chunkDocumentText(decoded.text, params) };
  },
};

/** The extractors this build tries, in order (see the note above). */
export const DOCUMENT_EXTRACTORS: readonly DocumentExtractor[] = [textExtractor];

/**
 * Which generation of extractors read a file, stored on every reading
 * (`document_extractions.extractor_version`, AD-24).
 *
 * It goes up whenever an extractor or a library underneath one changes what it
 * would produce from the same bytes, because that is the question the column
 * answers: whether a stored reading is one this build would have made. Raising
 * it is also the whole of how a re-reading is asked for: the drain's queueing
 * step reads the files whose current successful generation says another version
 * and puts each one back on the queue, once
 * (`files/extract-work.ts`, `listFilesWithStaleExtraction`).
 */
export const DOCUMENT_EXTRACTOR_VERSION = 'doc/1';
