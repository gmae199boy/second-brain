/** What an embedding points at (see the ER diagram in the spine). */
export type EmbeddingTargetKind = 'chunk' | 'log_entry';

/**
 * A vector for one target under one index config. Derived, and only present
 * when the optional embedding index is on (AD-15).
 */
export interface Embedding {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `targetId` and `indexConfigId`. */
  targetKind: EmbeddingTargetKind;
  targetId: string;
  indexConfigId: string;
  /** Length always equals the config's `dimensions`. */
  vector: readonly number[];
}
