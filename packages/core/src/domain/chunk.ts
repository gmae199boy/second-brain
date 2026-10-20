/**
 * A derived slice of a session's messages. Chunks are always built, whether or
 * not embedding is on, and drain owns them (AD-15, Table Contract).
 */
export interface Chunk {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `indexConfigId`, `fromAt` and `toAt`. */
  sessionId: string;
  indexConfigId: string;
  /**
   * The stretch of conversation this chunk covers, as the instants of its
   * first and last message: the closed interval `[fromAt, toAt]` over
   * `messages.occurred_at` (migration 0006). A message falls inside the chunk
   * when it was uttered inside that interval, which is a question about the
   * conversation and not about the order the rows were written in. A chunk of
   * one message has the two equal.
   */
  fromAt: Date;
  toAt: Date;
  /** The chunk text, with no header of its own (AD-15). */
  body: string;
}
