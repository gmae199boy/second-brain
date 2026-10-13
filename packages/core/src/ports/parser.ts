import type { ParsedMessage, ParsedToolNote } from '../domain/ingest-batch.js';
import type { ParserCursor } from '../domain/session.js';

/**
 * What a parse produced. Unreadable content is a value, not an exception
 * (Conventions), and the `ok: true` shape is a pure function of the content
 * and the parser version (AD-4).
 */
export type ParseResult =
  | {
      ok: true;
      parserVersion: string;
      messages: readonly ParsedMessage[];
      toolNotes: readonly ParsedToolNote[];
      /** Where this content ends, for the next incremental read (AD-4). */
      cursor: ParserCursor | null;
    }
  | {
      ok: false;
      code: 'TRANSCRIPT_UNREADABLE';
      message: string;
    };

/**
 * The one required piece of a connector (AD-4). It turns a harness transcript
 * into harness-neutral messages and tool notes, and it alone decides `seq` and
 * the tool-note ordinals, always the same way for the same input.
 */
export interface Parser {
  /** Neutral harness name; the first half of every session token (AD-8). */
  readonly harness: string;
  /** Recorded per session, so a parser change stays traceable (AD-4). */
  readonly version: string;
  parse(content: string): ParseResult;
}
