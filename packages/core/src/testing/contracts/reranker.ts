import type { Reranker } from '../../ports/reranker.js';
import {
  assertEqual,
  assertFiniteNumber,
  assertInteger,
  assertNonEmptyString,
  assertTrue,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

const SAMPLE_QUERY = 'where do the import notes live';

/** Neutral documents, since the repository is public (Conventions). */
const SAMPLE_DOCUMENTS: readonly string[] = [
  'the import notes live in notes/import.md',
  'the deploy checklist lives in notes/deploy.md',
  'import notes: the open question is at the end',
];

/**
 * The reranker contract is about shape too: a permutation of the input with
 * descending scores, so a caller can trust the order, and a failure that is a
 * value so the vector order can survive it with a `RERANK_FAILED` warning
 * (AD-15).
 */
export function rerankerContract(): ContractCase<Reranker>[] {
  return [
    contractCase<Reranker>('the reranker names its model', async (make) => {
      await withSubject(make, async (reranker) => {
        assertNonEmptyString(reranker.model, 'a reranker must name its model');
      });
    }),

    contractCase<Reranker>(
      'the ranking is a subset of the input, with no repeats',
      async (make) => {
        await withSubject(make, async (reranker) => {
          const result = await reranker.rerank(SAMPLE_QUERY, SAMPLE_DOCUMENTS);
          if (!result.ok) {
            assertEqual(
              result.code,
              'RERANK_FAILED',
              'a failing rerank must answer RERANK_FAILED (AD-15)',
            );
            assertNonEmptyString(result.message, 'a failing rerank must say why');
            return;
          }
          assertTrue(
            result.ranking.length <= SAMPLE_DOCUMENTS.length,
            'a rerank cannot invent documents',
          );
          const seen = new Set<number>();
          for (const entry of result.ranking) {
            assertInteger(entry.index, 'a ranked index must be an integer');
            assertTrue(
              entry.index >= 0 && entry.index < SAMPLE_DOCUMENTS.length,
              `the ranked index ${String(entry.index)} is outside the input`,
            );
            assertTrue(!seen.has(entry.index), `document ${String(entry.index)} was ranked twice`);
            seen.add(entry.index);
            assertFiniteNumber(entry.score, 'a rank score must be a finite number');
          }
        });
      },
    ),

    contractCase<Reranker>('the scores never rise along the ranking', async (make) => {
      await withSubject(make, async (reranker) => {
        const result = await reranker.rerank(SAMPLE_QUERY, SAMPLE_DOCUMENTS);
        if (!result.ok) return;
        const scores = result.ranking.map((entry) => entry.score);
        for (const [position, score] of scores.entries()) {
          const previous = scores[position - 1];
          if (previous === undefined) continue;
          assertTrue(
            previous >= score,
            `the ranking is not sorted: ${String(previous)} came before ${String(score)}`,
          );
        }
      });
    }),

    contractCase<Reranker>('reranking nothing returns nothing', async (make) => {
      await withSubject(make, async (reranker) => {
        const result = await reranker.rerank(SAMPLE_QUERY, []);
        if (!result.ok) return;
        assertEqual(result.ranking.length, 0, 'no documents must give no ranking');
      });
    }),
  ];
}
