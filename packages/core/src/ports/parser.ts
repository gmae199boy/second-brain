import type { ParsedMessage, ParsedToolNote } from '../domain/ingest-batch.js';
import type { ParserCursor, SessionStartSource } from '../domain/session.js';

/**
 * What a parse produced. Unreadable content is a value, not an exception
 * (Conventions), and the `ok: true` shape is a pure function of the content,
 * the cursor it was given and the parser version (AD-4).
 */
export type ParseResult =
  | {
      ok: true;
      parserVersion: string;
      messages: readonly ParsedMessage[];
      toolNotes: readonly ParsedToolNote[];
      /** Where this content ends, for the next incremental read (AD-4). */
      cursor: ParserCursor | null;
      /**
       * A cursor was given and the content did not match it, so the parse
       * started at the front instead. False for a parse that was given no
       * cursor: reading a transcript from the start is the normal first read
       * and not a reset of anything. Ingest is idempotent, so this only ever
       * raises a `CURSOR_RESET` warning (AD-4).
       */
      cursorReset: boolean;
      /**
       * Why the harness started the session, when the content said so, and
       * `null` when it did not. A parse that read only the tail of a transcript
       * still answers for the whole content, so the value never depends on the
       * cursor.
       */
      startSource: SessionStartSource | null;
    }
  | {
      ok: false;
      code: 'TRANSCRIPT_UNREADABLE';
      message: string;
    };

/**
 * The one required piece of a connector (AD-4). It turns a harness transcript
 * into harness-neutral messages and tool notes, always the same way for the
 * same input.
 *
 * It says nothing about `seq`: the order of `messages` is the order of the
 * conversation, and the number is the store's, decided inside the insert
 * transaction (AD-8). The tool-note ordinals are the parser's, because they
 * number the calls *within one message* and a message's content never changes.
 */
export interface Parser {
  /** Neutral harness name; the first half of every session token (AD-8). */
  readonly harness: string;
  /** Recorded per session, so a parser change stays traceable (AD-4). */
  readonly version: string;
  /**
   * Read the content, starting at the cursor when the content still matches it.
   *
   * The cursor is the one a previous parse of this session produced and the
   * store kept. When the content still carries that message with that
   * fingerprint, the parse starts there and the first message it reports is the
   * cursor's own — so the result is exactly the tail of what a parse of the
   * whole content would have reported, from that message on. When the message
   * is gone or the fingerprint moved — a compact, a fork, a transcript rewritten
   * underneath us — the parse starts at the front and says `cursorReset: true`.
   *
   * No cursor, or `null`, means read everything, which is what a first read of
   * a session does.
   */
  parse(content: string, cursor?: ParserCursor | null): ParseResult;
}
