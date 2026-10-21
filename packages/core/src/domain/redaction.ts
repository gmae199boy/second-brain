/**
 * The record of one masked span. Written by `messages.redact` and by the
 * store-time masking of ingest; what was removed is not kept, only its hash
 * (AD-11).
 */
export interface Redaction {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  messageId: string | null;
  /** Exactly one of messageId and toolNoteId is present. */
  toolNoteId: string | null;
  /**
   * Half-open code point range where the removed text sat: over the target as it
   * stood just before this masking, not as it reads now (Conventions). The
   * marker took that span's place, so a later masking of the same message
   * counts over the target this one left behind.
   */
  start: number;
  end: number;
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
