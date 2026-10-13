/** A failed embedding is a value: the caller falls back to keyword search (AD-15). */
export type EmbedResult =
  | { ok: true; vectors: readonly (readonly number[])[] }
  | { ok: false; code: 'EMBED_FAILED'; message: string };

/**
 * The optional embedding index behind a port. Off by default in slice 1, and
 * the width is fixed when it is switched on (AD-15).
 */
export interface Embedder {
  readonly model: string;
  /** Length of every vector this embedder returns. */
  readonly dimensions: number;
  /** One vector per text, in the same order. */
  embed(texts: readonly string[]): Promise<EmbedResult>;
}
