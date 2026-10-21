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
       *
       * The *first* answer the content carries, not the last. A transcript
       * collects an attachment per start — a `startup` and then the `resume`
       * that reopened it, or the `compact` that rewrote it — and the question
       * this answers is why the session began, which only its first one says
       * (follow-up review #18).
       */
      startSource: SessionStartSource | null;
      /**
       * How many lines of what this parse read were not kept, by reason: a
       * `snake_case` code the parser names itself, against a count that is a
       * non-negative integer.
       *
       * A transcript is mostly not conversation, so dropping lines is the
       * normal case and not a failure — this is the only place that says how
       * much of a file a parse walked past and why, which is what makes a
       * filter that quietly stops keeping something noticeable at all. A parser
       * reports every reason it knows, zeroes included, so the keys do not
       * change from file to file.
       *
       * One key is reserved and read by Core rather than only reported:
       * `unreadable`, the lines that were not JSON. Those are the only dropped
       * lines that *are* a problem — content the parser could not read at all —
       * and `sessions.ingest` turns a non-zero count into a
       * `TRANSCRIPT_LINES_SKIPPED` warning. Everything else is the filter doing
       * its job and goes no further than this record.
       *
       * It counts the lines of the part that was read, so a cursor read reports
       * the tail's drops and not the whole file's.
       */
      droppedLines: Readonly<Record<string, number>>;
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
 * It numbers nothing and sorts nothing: the order of `messages` is the order of
 * the file, and what a message is read back in order by is its own
 * `occurredAt` (AD-8, migration 0006). The tool-note ordinals are the
 * parser's, because they number the calls *within one message* and a message's
 * content never changes.
 *
 * A line it cannot read is not a refusal on its own. A transcript is appended
 * to while it is being read, and a half-written tail — or one broken line in
 * the middle, left by a crash — must not cost a whole session its conversation:
 * such a line is skipped and counted under `droppedLines.unreadable`, and only
 * content with no readable line in it at all comes back
 * `TRANSCRIPT_UNREADABLE` (story 23).
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
