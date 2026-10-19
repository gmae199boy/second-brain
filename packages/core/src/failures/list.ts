import type { Failure } from '../domain/failure.js';
import type { WorkStore } from '../ports/store.js';

/**
 * `failures.list`: what is still wrong, and what was (FR-5, NFR-2).
 *
 * `failures` is a record and not a queue (AD-21), which is the whole shape of
 * this verb: it reads, it narrows, and it changes nothing. What asks for another
 * attempt is `failures.retry`, and what closes a row is the work finally going
 * through.
 */

/** The widest and narrowest page this verb will answer with. */
export const FAILURES_LIST_LIMIT = { min: 1, max: 1000, default: 100 } as const;

export interface FailuresListInput {
  /** Only this kind of target — `session` for a collection failure (AD-12). */
  targetKind?: string;
  /**
   * Include the rows somebody has already fixed. Left out, only the unresolved
   * ones: the question this verb answers is "what is still wrong", and a brain
   * that has been running for a year has far more history than trouble.
   */
  all?: boolean;
  /** At most this many rows, between 1 and 1000. Defaults to 100. */
  limit?: number;
}

export interface FailuresListData {
  failures: readonly Failure[];
  /** How many rows came back, which is `failures.length`. */
  count: number;
  /** Whether there are more than this page holds (Conventions, AD-15). */
  hasMore: boolean;
}

export type FailuresListResult =
  | ({ ok: true } & FailuresListData)
  | { ok: false; code: 'USAGE' | 'DB_UNAVAILABLE'; message: string };

export interface FailuresListDependencies {
  store: Pick<WorkStore, 'listFailures'>;
}

/**
 * Read the failures one query names.
 *
 * `has_more` is decided by asking for one row more than the page and dropping
 * it, which is the convention of every paged read in this project: a count of
 * the whole table would be a second query whose answer could already be stale,
 * and "are there more" is all a caller needs to decide whether to narrow.
 */
export async function listFailures(
  dependencies: FailuresListDependencies,
  input: FailuresListInput = {},
): Promise<FailuresListResult> {
  const { store } = dependencies;

  const limit = input.limit ?? FAILURES_LIST_LIMIT.default;
  if (!Number.isInteger(limit) || limit < FAILURES_LIST_LIMIT.min || limit > FAILURES_LIST_LIMIT.max) {
    return {
      ok: false,
      code: 'USAGE',
      message:
        `\`limit\`은 ${String(FAILURES_LIST_LIMIT.min)}에서 ${String(FAILURES_LIST_LIMIT.max)} 사이의 정수입니다. ` +
        `${String(limit)}는 그 밖입니다.`,
    };
  }

  const read = await store.listFailures({
    ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
    includeResolved: input.all === true,
    limit: limit + 1,
  });
  if (!read.ok) return read;

  const hasMore = read.failures.length > limit;
  const failures = hasMore ? read.failures.slice(0, limit) : read.failures;
  return { ok: true, failures, count: failures.length, hasMore };
}
