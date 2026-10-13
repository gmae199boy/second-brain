import type { RerankResult, RerankedDocument, Reranker } from '../../ports/reranker.js';

export interface MemoryRerankerOptions {
  /** Neutral model name. Defaults to `demo-rerank`. */
  model?: string;
}

/**
 * A reranker that scores by shared words. Deterministic, every input document
 * appears exactly once, and the scores come back in descending order, which is
 * all `rerankerContract` asks of a real one.
 */
export function memoryReranker(options: MemoryRerankerOptions = {}): Reranker {
  const { model = 'demo-rerank' } = options;

  return {
    model,
    async rerank(query: string, documents: readonly string[]): Promise<RerankResult> {
      const wanted = words(query);
      const ranking: RerankedDocument[] = documents
        .map((document, index) => ({ index, score: overlap(wanted, words(document)) }))
        // Ties keep the input order, so the result stays deterministic.
        .sort((left, right) => right.score - left.score || left.index - right.index);
      return { ok: true, ranking };
    },
  };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((word) => word !== ''));
}

function overlap(wanted: Set<string>, found: Set<string>): number {
  if (wanted.size === 0) return 0;
  let shared = 0;
  for (const word of wanted) {
    if (found.has(word)) shared += 1;
  }
  return shared / wanted.size;
}
