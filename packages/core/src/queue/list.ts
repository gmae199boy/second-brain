import type { WorkItem, WorkAttempt } from '../domain/work-item.js';
import type { WorkStore } from '../ports/store.js';
import type { Clock } from '../ports/clock.js';
export const QUEUE_LIST_LIMIT = { min: 1, max: 200, default: 50 } as const;
export function workListState(item: WorkItem, currentAttempt: WorkAttempt | null, held = false) {
  if (item.completedAt !== null) return item.outcome;
  if (currentAttempt?.token === item.currentAttemptToken && currentAttempt?.outcome === 'unknown') return 'unknown';
  return item.claimedAt !== null ? 'running' : held ? 'extension_disabled' : 'queued';
}
export function attemptUsage(attempt: WorkAttempt | null) {
  return attempt === null || (attempt.inputTokens === null && attempt.cachedInputTokens === null && attempt.outputTokens === null) ? null : {
    inputTokens: attempt.inputTokens ?? 0, cachedInputTokens: attempt.cachedInputTokens ?? 0, outputTokens: attempt.outputTokens ?? 0,
  };
}
export async function listWork({ store, clock }: { store: Pick<WorkStore, 'listWork'>; clock: Clock }, input: { all?: boolean; kind?: string; limit?: number } = {}) {
  const limit = input.limit ?? QUEUE_LIST_LIMIT.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false as const, code: 'USAGE' as const, message: '목록 한도는 1~200 정수여야 합니다' };
  const read = await store.listWork({ includeClosed: input.all === true, ...(input.kind === undefined ? {} : { kind: input.kind }), limit });
  if (!read.ok) return read;
  const items = read.entries.map(({ item, latestAttempt: attempt, currentAttempt, held }) => ({ ...item,
    state: workListState(item, currentAttempt, held), attemptOutcome: attempt?.outcome ?? null,
    attemptStartedAt: attempt?.startedAt ?? null, lastProgressAt: attempt?.lastProgressAt ?? null,
    elapsedMs: attempt === null ? null : attempt.elapsedMs ?? ((attempt.finishedAt ?? clock.now()).getTime() - attempt.startedAt.getTime()),
    usage: attemptUsage(attempt),
  }));
  return { ok: true as const, items, count: items.length, hasMore: read.hasMore };
}
