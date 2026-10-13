import type { Embedder } from '../../ports/embedder.js';
import {
  assertEqual,
  assertFiniteNumber,
  assertInteger,
  assertNonEmptyString,
  assertTrue,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/** Neutral texts, since the repository is public (Conventions). */
const SAMPLE_TEXTS: readonly string[] = [
  'the import notes live in notes/import.md',
  'we chose the simpler retry because the job is idempotent',
  '수집은 멱등이므로 재시도는 중복을 만들지 않는다',
];

/**
 * The embedder contract is about shape: n texts in, n vectors out, every one
 * exactly `dimensions` wide, because the column width is fixed when embedding
 * is switched on (AD-15).
 */
export function embedderContract(): ContractCase<Embedder>[] {
  return [
    contractCase<Embedder>('the embedder names its model and width', async (make) => {
      await withSubject(make, async (embedder) => {
        assertNonEmptyString(embedder.model, 'an embedder must name its model');
        assertInteger(embedder.dimensions, 'an embedder must name its width');
        assertTrue(embedder.dimensions > 0, 'the width must be positive');
      });
    }),

    contractCase<Embedder>('one vector per text, each as wide as promised', async (make) => {
      await withSubject(make, async (embedder) => {
        const result = await embedder.embed(SAMPLE_TEXTS);
        if (!result.ok) {
          assertEqual(result.code, 'EMBED_FAILED', 'a failing embed must answer EMBED_FAILED');
          assertNonEmptyString(result.message, 'a failing embed must say why');
          return;
        }
        assertEqual(
          result.vectors.length,
          SAMPLE_TEXTS.length,
          'an embedder must answer with one vector per text',
        );
        for (const vector of result.vectors) {
          assertEqual(
            vector.length,
            embedder.dimensions,
            'every vector must be exactly `dimensions` long (AD-15)',
          );
          for (const value of vector) {
            assertFiniteNumber(value, 'a vector component must be a finite number');
          }
        }
      });
    }),

    contractCase<Embedder>('embedding nothing returns nothing', async (make) => {
      await withSubject(make, async (embedder) => {
        const result = await embedder.embed([]);
        if (!result.ok) return;
        assertEqual(result.vectors.length, 0, 'no texts must give no vectors');
      });
    }),

    contractCase<Embedder>('the vector width does not depend on the call', async (make) => {
      await withSubject(make, async (embedder) => {
        const first = await embedder.embed(SAMPLE_TEXTS);
        const second = await embedder.embed(SAMPLE_TEXTS);
        if (!first.ok || !second.ok) return;
        assertEqual(
          second.vectors.map((vector) => vector.length),
          first.vectors.map((vector) => vector.length),
          'the width of a vector must not depend on the call',
        );
      });
    }),
  ];
}
