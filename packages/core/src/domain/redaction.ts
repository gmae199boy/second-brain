/**
 * The record of one masking. Written by `messages.redact` and by `files.redact`;
 * what was removed is not kept, only its hash (AD-11).
 *
 * Two kinds of record live in this one shape, and the target says which: a span
 * of text taken out of a message or a tool note, and a whole file whose stored
 * copy, extracted text and names were removed at once.
 */
export interface Redaction {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  messageId: string | null;
  toolNoteId: string | null;
  /**
   * The file this record is about, for a whole-file masking (`files.redact`),
   * and `null` for a span of text.
   *
   * Exactly one of `messageId`, `toolNoteId` and `fileId` is present — the
   * `redactions_target_check` of migration 0005 said in a type.
   */
  fileId: string | null;
  /**
   * Half-open code point range where the removed text sat: over the target as it
   * stood just before this masking, not as it reads now (Conventions). The
   * marker took that span's place, so a later masking of the same message
   * counts over the target this one left behind.
   *
   * Both are `null` for a `fileId` record and never null for the other two: a
   * file has no range, because the whole of it went (`redactions_range_check`,
   * migration 0005).
   */
  start: number | null;
  end: number | null;
  /** Goes into the `[REDACTED:<kind>]` marker left in the body (AD-11). */
  kind: string;
  /** Hash of the removed text. The text itself is gone (AD-11). */
  contentHash: string;
  occurredAt: Date;
  /**
   * Which version of Core's secret-pattern list did this masking
   * (`SECRET_PATTERN_VERSION`), or `null` for a record no pattern made — a
   * masking somebody asked for by hand, or a row written before migration 0004
   * gave the column a place to live.
   *
   * It is on the record so the list can grow: when a pattern is added, the rows
   * that an older version produced are the ones worth looking at again (AD-11).
   */
  patternVersion: string | null;
}
