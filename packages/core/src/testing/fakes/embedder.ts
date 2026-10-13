import type { EmbedResult, Embedder } from '../../ports/embedder.js';
import { smallHash } from '../hash.js';

export interface MemoryEmbedderOptions {
  /** Neutral model name. Defaults to `demo-embed`. */
  model?: string;
  /** Vector width. Defaults to 8, enough to check the shape. */
  dimensions?: number;
}

/**
 * A deterministic embedder: the same text always gives the same vector, and
 * every vector is exactly `dimensions` long. No network, no randomness.
 */
export function memoryEmbedder(options: MemoryEmbedderOptions = {}): Embedder {
  const { model = 'demo-embed', dimensions = 8 } = options;

  return {
    model,
    dimensions,
    async embed(texts: readonly string[]): Promise<EmbedResult> {
      const vectors = texts.map((text) =>
        Array.from({ length: dimensions }, (_unused, axis) => component(text, axis)),
      );
      return { ok: true, vectors };
    },
  };
}

/** A value in [-1, 1), derived from the text and the axis. */
function component(text: string, axis: number): number {
  const bucket = Number.parseInt(smallHash(`${text}:${String(axis)}`), 16);
  return (bucket % 2000) / 1000 - 1;
}
