/** Who uttered the message. */
export type MessageRole = 'user' | 'assistant';

/**
 * One conversation message. Written by `sessions.ingest` and immutable
 * afterwards; `messages.redact` is the only exception (AD-11).
 */
export interface Message {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /**
   * Key together with `harnessMessageId`, and that pair is the whole of the
   * message's identity: it carries no number of its own (AD-8, migration
   * 0006). The harness named the message, so a transcript whose front was
   * rewritten by a compact or a fork still cannot turn one stored message into
   * another.
   */
  sessionId: string;
  harnessMessageId: string;
  role: MessageRole;
  /** Model that produced the message. Recorded only; it changes nothing (AD-4). */
  model: string | null;
  /** As the harness gave it, store-time masking aside (AD-11). */
  body: string;
  /**
   * When the message was uttered, not when it reached the DB (AD-13). It is
   * also the conversation order: a read hands the messages back by it, so a
   * message that arrives in a later batch is read where it was uttered rather
   * than at the end. The order of two messages at the same instant is not
   * defined (AD-8, migration 0006).
   */
  occurredAt: Date;
  /**
   * The branch the line carried, exactly as it carried it, or `null` for a line
   * that carried none. Tracking information on the message and not a label: a
   * branch renamed later was still this branch when the message was written, so
   * nothing normalises it (migration 0004).
   */
  gitBranch: string | null;
  /**
   * The final report of a subagent: the one message of a delegated run worth
   * recalling as a result rather than as a step (migration 0004). Where it is
   * read from is a question about one harness's transcript, and the parser
   * settles it; here it is only a mark.
   */
  isSubagentReport: boolean;
}
