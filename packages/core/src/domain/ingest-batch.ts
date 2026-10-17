import type { MessageRole } from './message.js';
import type { ParserCursor, SessionStartSource } from './session.js';
import type { SessionKey } from './session-token.js';

/**
 * A message as the parser produced it: no row id, no session id and no `seq`.
 *
 * The order of the array is the order of the conversation, and that is the
 * whole of what the parser says about position: `seq` is the store's, decided
 * inside the insert transaction (AD-4, AD-8). A parser cannot own it, because
 * a compact or a fork rewrites the front of a transcript, and a number the
 * parser worked out from the file would then land on a message that already
 * has one.
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
 * Unlike `seq` it is a position *inside one message*, and a message's content
 * never changes, so the same call keeps the same number forever.
 */
export interface ParsedToolNote {
  harnessMessageId: string;
  ordinal: number;
  tool: string;
  target: string;
  ok: boolean;
}

/**
 * One masked span of a message, travelling with the message it belongs to.
 *
 * It rides on the message rather than on the batch on purpose. A re-ingest
 * mints a new id for every message, and the store skips the ones it already
 * holds; a record that travelled separately would then point at a message id
 * no row carries — a foreign key error at best, and the same masking recorded
 * twice at worst. Attached, "only the records of the messages that went in" is
 * one loop (Design Notes).
 */
export interface IngestRedaction {
  /** UUIDv7, minted by the caller, like every other id in the batch (AD-8). */
  id: string;
  /**
   * Half-open code point range over the body *before* this masking, which is
   * the body the parser read (Conventions, AD-11). Not UTF-16 units.
   */
  start: number;
  end: number;
  /** The word inside the `[REDACTED:<kind>]` the body now carries (AD-11). */
  kind: string;
  /** `sha256:<hex>` of what was removed. The text itself is gone (AD-11). */
  contentHash: string;
  /** The `SECRET_PATTERN_VERSION` that masked it (AD-11, inputs A6). */
  patternVersion: string;
  /** The batch's `ingestedAt`: when the masking happened (AD-13). */
  occurredAt: Date;
}

/**
 * A parsed message with the row id the caller minted for it. Ids belong to the
 * side that creates the row (AD-8), so the use case mints them before the
 * batch is handed over and the store never reaches for an `IdGen`.
 *
 * `body` is the *masked* body: `sessions.ingest` runs Core's pattern list over
 * what the parser read before the batch exists, so nothing downstream of here —
 * the store, a spool file, a log line — ever holds a secret (AD-11).
 */
export interface IngestMessage extends ParsedMessage {
  /** UUIDv7, minted by the caller. */
  id: string;
  /**
   * What masking took out of `body`, in the order it sits in the body. Empty
   * for a message that held nothing, which is nearly every message.
   */
  redactions: readonly IngestRedaction[];
}

/**
 * The same for a tool note (AD-8). Its `target` is masked too, and it carries
 * no records: migration 0004's `redactions` row is a span over a *body* and has
 * no column that could name a tool note (Decision 2026-10-18).
 */
export interface IngestToolNote extends ParsedToolNote {
  /** UUIDv7, minted by the caller. */
  id: string;
}

/** The tracking information that travels with a batch (AD-4). */
export interface IngestTracking {
  /** The parser that produced the batch; recorded on the session (AD-4). */
  parserVersion: string;
  /** Where the parser stopped. Stored with the batch, in one transaction (AD-7). */
  cursor: ParserCursor | null;
  /**
   * The old cursor was gone or did not match, so the parser read from the
   * start. Ingest is idempotent, so this only raises a `CURSOR_RESET`
   * warning (AD-4).
   */
  cursorReset: boolean;
  /**
   * Why the harness started the session, when the transcript said so. The store
   * writes it only when it is there: a read that saw no `SessionStart` hook
   * attachment knows nothing about the start, and `null` must not erase what an
   * earlier read did know.
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
  /** In conversation order. The store turns that order into `seq` (AD-8). */
  messages: readonly IngestMessage[];
  toolNotes: readonly IngestToolNote[];
}
