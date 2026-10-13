/**
 * The record of one masked span. Written by `messages.redact` and by the
 * store-time masking of ingest; what was removed is not kept, only its hash
 * (AD-11).
 */
export interface Redaction {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  messageId: string;
  /**
   * Half-open code point range where the removed text sat: over the body as it
   * stood just before this masking, not as it reads now (Conventions). The
   * marker took that span's place, so a later masking of the same message
   * counts over the body this one left behind.
   */
  start: number;
  end: number;
  /** Goes into the `[REDACTED:<kind>]` marker left in the body (AD-11). */
  kind: string;
  /** Hash of the removed text. The text itself is gone (AD-11). */
  contentHash: string;
  occurredAt: Date;
}
