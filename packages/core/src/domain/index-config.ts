/** A chunk config is always in use; an embedding config only when enabled (AD-15). */
export type IndexConfigKind = 'chunk' | 'embedding';

/** The chunking rules, read from the row rather than from code (AD-15). */
export interface ChunkParams {
  /** Target size of a chunk in characters, never tokens. */
  targetChars: number;
  /** How many messages neighbouring chunks share. */
  overlapMessages: number;
  /** A single message longer than this is split. */
  splitMessagesOverChars: number;
}

/**
 * An index generation. Immutable: changing the model or the dimensions means a
 * new row and `index rebuild` (AD-15, Table Contract).
 */
export interface IndexConfig {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `model`, `dimensions` and `chunkParams`. */
  kind: IndexConfigKind;
  /** Embedding model, `null` for a chunk-only config. */
  model: string | null;
  /** Vector width, fixed when embedding is switched on (AD-15). */
  dimensions: number | null;
  chunkParams: ChunkParams;
}
