import type { MessageRole } from './message.js';
import type { ParserCursor } from './session.js';
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
 * A parsed message with the row id the caller minted for it. Ids belong to the
 * side that creates the row (AD-8), so the use case mints them before the
 * batch is handed over and the store never reaches for an `IdGen`.
 */
export interface IngestMessage extends ParsedMessage {
  /** UUIDv7, minted by the caller. */
  id: string;
}

/** The same for a tool note (AD-8). */
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
