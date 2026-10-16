/** Who uttered the message. */
export type MessageRole = 'user' | 'assistant';

/**
 * One conversation message. Written by `sessions.ingest` and immutable
 * afterwards; `messages.redact` is the only exception (AD-11).
 */
export interface Message {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `harnessMessageId`, and again with `seq`. */
  sessionId: string;
  harnessMessageId: string;
  /**
   * Position in the session: 0, 1, 2, …, chosen by the store inside the insert
   * transaction, from the order of the batch (AD-4, AD-8). Once given it never
   * changes, so a transcript whose front was rewritten by a compact or a fork
   * leaves every stored message where it was.
   */
  seq: number;
  role: MessageRole;
  /** Model that produced the message. Recorded only; it changes nothing (AD-4). */
  model: string | null;
  /** As the harness gave it, store-time masking aside (AD-11). */
  body: string;
  /** When the message was uttered, not when it reached the DB (AD-13). */
  occurredAt: Date;
}
