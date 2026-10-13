import type { MessageRole } from './message.js';
import type { ParserCursor } from './session.js';
import type { SessionKey } from './session-token.js';

/**
 * A message as the parser produced it: no row id and no session id yet, since
 * those belong to the store. `seq` is the parser's, and the same transcript
 * always yields the same one (AD-4).
 */
export interface ParsedMessage {
  harnessMessageId: string;
  seq: number;
  role: MessageRole;
  model: string | null;
  body: string;
  occurredAt: Date;
}

/** A tool note as the parser produced it; `ordinal` is the parser's (AD-4). */
export interface ParsedToolNote {
  harnessMessageId: string;
  ordinal: number;
  tool: string;
  target: string;
  ok: boolean;
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
}

/**
 * Core's one ingest input. It is harness neutral: the connector's parser has
 * already turned the harness format into this (AD-4).
 */
export interface IngestBatch {
  key: SessionKey;
  tracking: IngestTracking;
  messages: readonly ParsedMessage[];
  toolNotes: readonly ParsedToolNote[];
}
