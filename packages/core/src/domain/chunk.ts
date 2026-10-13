/**
 * A derived slice of a session's messages. Chunks are always built, whether or
 * not embedding is on, and drain owns them (AD-15, Table Contract).
 */
export interface Chunk {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `indexConfigId`, `seqFrom` and `seqTo`. */
  sessionId: string;
  indexConfigId: string;
  /** Inclusive message range this chunk covers. */
  seqFrom: number;
  seqTo: number;
  /** The chunk text, with no header of its own (AD-15). */
  body: string;
}
