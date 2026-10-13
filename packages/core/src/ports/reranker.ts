/** One reranked document: where it sat in the input and what it scored. */
export interface RerankedDocument {
  /** Index into the `documents` array the caller passed. */
  index: number;
  score: number;
}

/**
 * A failed rerank is a value, so the caller can keep the vector order and warn
 * with `RERANK_FAILED` instead of losing the search (AD-15).
 */
export type RerankResult =
  | { ok: true; ranking: readonly RerankedDocument[] }
  | { ok: false; code: 'RERANK_FAILED'; message: string };

/** The optional reranking step behind a port (AD-15). */
export interface Reranker {
  readonly model: string;
  /** Best first. Every input document appears at most once. */
  rerank(query: string, documents: readonly string[]): Promise<RerankResult>;
}
