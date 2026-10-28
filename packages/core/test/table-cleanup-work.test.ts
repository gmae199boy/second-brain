import { expect, it, vi } from 'vitest';
import { tableCleanupHandler, tableCleanupWork } from '../src/maintenance/table-cleanup-work.js';
import type { WorkItem } from '../src/domain/work-item.js';

const now = new Date('2026-10-28T01:02:03.456Z');
const item: WorkItem = {
  ...tableCleanupWork({ id: 'cleanup', table: 'messages', at: now }),
  attempts: 1, claimedAt: now, claimExpiresAt: now, claimedBy: 'worker',
  lastError: null, completedAt: null,
};

it.each([
  { targetKind: 'file', targetId: 'messages' },
  { targetKind: 'table', targetId: 'not_a_cleanup_table' },
])('refuses cleanup of $targetKind/$targetId before calling maintenance', async target => {
  const cleanup = vi.fn(async () => ({ ok: true as const }));
  const handler = tableCleanupHandler({ maintenance: { cleanup } });
  expect(await handler({ ...item, ...target })).toMatchObject({
    ok: false, code: 'TABLE_CLEANUP_REFUSED', retryable: false,
  });
  expect(cleanup).not.toHaveBeenCalled();
});

it.each([
  ['DB_LOCKED', 'TABLE_CLEANUP_WAITING'],
  ['DB_UNAVAILABLE', 'TABLE_CLEANUP_FAILED'],
  ['TABLE_CLEANUP_FAILED', 'TABLE_CLEANUP_FAILED'],
])('classifies maintenance %s as a retryable %s attempt', async (code, expected) => {
  const handler = tableCleanupHandler({ maintenance: {
    cleanup: async () => ({ ok: false, code, message: 'maintenance failed' }),
  } });
  expect(await handler(item)).toEqual({ ok: false, code: expected, message: 'maintenance failed', retryable: true });
});

it.each(['refused', 'thrown'])('leaves failure settlement to completeWork when store resolution would be %s', async mode => {
  const store = { resolveFailures: vi.fn(async () => {
    if (mode === 'thrown') throw new Error('refused');
    return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: 'refused' };
  }) };
  const dependencies = { store, maintenance: { cleanup: async () => ({ ok: true as const }) } };
  const handler = tableCleanupHandler(dependencies);
  expect(await handler(item)).toEqual({ ok: true });
  expect(store.resolveFailures).not.toHaveBeenCalled();
});
