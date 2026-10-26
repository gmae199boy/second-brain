/**
 * A chunk config is always in use; an embedding config only when enabled
 * (AD-15). `document_chunk` is the third kind migration 0002 writes: the rules
 * for cutting a *document* into pieces, which are counted in characters and
 * know nothing about messages (AD-24).
 */
export type IndexConfigKind = 'chunk' | 'embedding' | 'document_chunk';

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
 * The document chunking rules (AD-24), the shape 0002's `document_chunk` row
 * carries. A document has no messages to overlap, so the overlap is in
 * characters like the target — the pair `index_configs_chunk_params_check`
 * spells out for this kind.
 */
export interface DocumentChunkParams {
  /** Target size of a piece in characters, never tokens. */
  targetChars: number;
  /** How many characters neighbouring pieces share. */
  overlapChars: number;
}

/**
 * An index generation of a conversation. Immutable: changing the model or the
 * dimensions means a new row and `index rebuild` (AD-15, Table Contract).
 */
export interface ConversationIndexConfig {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `model`, `dimensions` and `chunkParams`. */
  kind: 'chunk' | 'embedding';
  /** Embedding model, `null` for a chunk-only config. */
  model: string | null;
  /** Vector width, fixed when embedding is switched on (AD-15). */
  dimensions: number | null;
  chunkParams: ChunkParams;
}

/**
 * An index generation of a document's text (AD-24). Cutting is not embedding,
 * so `model` and `dimensions` are null — which is what the migration writes and
 * what `index_configs_key_idx` keys on.
 */
export interface DocumentChunkIndexConfig {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  kind: 'document_chunk';
  model: null;
  dimensions: null;
  chunkParams: DocumentChunkParams;
}

/**
 * One `index_configs` row, which kind of generation it is deciding what its
 * parameters are: the two shapes of `chunk_params` are a different pair of keys
 * each, and the check constraint refuses the one that does not go with the
 * kind, so the type is the union and not a widening of both.
 */
export type IndexConfig = ConversationIndexConfig | DocumentChunkIndexConfig;

/**
 * The `document_chunk` row migration 0002 seeds, by id.
 *
 * It is a constant and not a lookup because the id is written into the
 * migration: a reading that succeeded records which chunking generation cut its
 * pieces (`document_extractions.index_config_id`), and asking the database for
 * "the document_chunk config" would be a query whose answer is ambiguous the day
 * a second one exists. Whoever needs another generation names it, and this stays
 * the one 0002 put there.
 */
export const DOCUMENT_CHUNK_INDEX_CONFIG_ID = '019a0000-0000-7000-8000-000000000002';
