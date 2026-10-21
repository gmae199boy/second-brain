import type { MessageRole } from './message.js';
import type { ParserCursor, SessionStartSource } from './session.js';
import type { SessionKey } from './session-token.js';

/**
 * A message as the parser produced it: no row id and no session id.
 *
 * The order of the array is the order of the file, which is the whole of what
 * the parser says about position: it numbers nothing and sorts nothing
 * (AD-4). What a message is read in order *by* is its own `occurredAt`, and
 * the store neither assigns nor needs anything else — a message carries no
 * number at all (AD-8, migration 0006).
 */
export interface ParsedMessage {
  harnessMessageId: string;
  role: MessageRole;
  model: string | null;
  body: string;
  occurredAt: Date;
  /** The branch the line carried, as it carried it, or `null` (migration 0004). */
  gitBranch: string | null;
  /**
   * The working directory the line carried, or `null`. It is *not* stored on
   * the message: story 2.8 reads the first message's one to tag the session,
   * which is why the parser reports it and the `Message` has no such field.
   */
  cwd: string | null;
  /** The final report of a subagent, read from the main transcript (AD-4). */
  isSubagentReport: boolean;
}

/**
 * A tool note as the parser produced it; `ordinal` is the parser's (AD-4).
 * It is a position *inside one message*, and a message's content never
 * changes, so the same call keeps the same number forever. That is why the
 * parser may own this number while it owns none for a message: the thing it
 * counts within cannot be rewritten under it.
 */
export interface ParsedToolNote {
  harnessMessageId: string;
  ordinal: number;
  tool: string;
  target: string;
  ok: boolean;
}

/**
 * A parsed message with the row id the caller minted for it. Ids belong to the
 * side that creates the row (AD-8), so the use case mints them before the
 * batch is handed over and the store never reaches for an `IdGen`.
 *
 * `body` is the body the parser read, character for character. Nothing masks
 * it on the way in: masking happens where text leaves Brain, in Core's output
 * codecs, because a pattern that masked too much on the way in would have
 * broken a stored original nobody can get back (마스킹 B, AD-11).
 */
export interface IngestMessage extends ParsedMessage {
  /** UUIDv7, minted by the caller. */
  id: string;
}

/**
 * The same for a tool note (AD-8). Its `target` is stored as the parser cut it,
 * and the output codecs mask it on the way out (`toolNoteForOutput`, AD-11).
 */
export interface IngestToolNote extends ParsedToolNote {
  /** UUIDv7, minted by the caller. */
  id: string;
}

/** The tracking information that travels with a batch (AD-4). */
export interface IngestTracking {
  /** The parser that produced the batch; recorded on the session (AD-4). */
  parserVersion: string;
  /**
   * Where the parser stopped, or `null` for a read that found no message at
   * all. Stored with the batch, in one transaction (AD-7).
   */
  cursor: ParserCursor | null;
  /**
   * The old cursor was gone or did not match, so the parser read from the
   * start. Ingest is idempotent, so this only raises a `CURSOR_RESET`
   * warning (AD-4) — and it is what lets `cursor` replace the stored one even
   * when it points further back, because the front of the transcript is not
   * what it was (`ports/store.ts`).
   */
  cursorReset: boolean;
  /**
   * The cursor the session held when this read started, which is what the store
   * compares against before it lets a reset move the cursor backwards.
   *
   * It is the raw stored cursor — whatever `findSession` brought back, whatever
   * parser version left it, and `null` for a session that is not stored yet —
   * and never the cursor that was handed to the parser. Two reads of one
   * session can overlap, and a reset cursor from the one that started first
   * must not wind the session back over what the second already stored: the
   * store moves it only while the session still stands where this read found it
   * (Design Notes, story 21).
   */
  cursorBase: ParserCursor | null;
  /**
   * Why the harness started the session, when the transcript said so, and the
   * *first* such answer the content carried. The store writes it only when the
   * session has none yet: a read that saw no `SessionStart` hook attachment
   * knows nothing about the start, and `null` must not erase what an earlier
   * read did know — and a later attachment (a resume, a compact) is not why the
   * session began (`ports/parser.ts`).
   */
  startSource: SessionStartSource | null;
  /** Best-effort end of the session, when the harness told us (AD-6). */
  endedAt: Date | null;
  /**
   * When this batch reached the DB, read once from the `Clock` by the caller
   * (AD-13). The store records it rather than asking a clock of its own, so a
   * spooled batch keeps the instant it was first given (AD-9).
   */
  ingestedAt: Date;
}

/**
 * Core's one ingest input. It is harness neutral: the connector's parser has
 * already turned the harness format into this, and the use case has added the
 * ids and the instant (AD-4, AD-8).
 */
export interface IngestBatch {
  key: SessionKey;
  tracking: IngestTracking;
  /**
   * In the order the file carried them. The store stores them as they are and
   * reads them back by `occurredAt`, so the order of this array decides
   * nothing beyond which messages the batch is about (AD-8, migration 0006).
   */
  messages: readonly IngestMessage[];
  toolNotes: readonly IngestToolNote[];
}
