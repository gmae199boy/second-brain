import { expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories,
  memoryTranscriptReader, sequenceIdGen, manualTime } from '../src/testing/index.js';

function kit(start = '2026-10-01T00:00:00Z') {
  const time = manualTime(new Date(start)); const store = memoryStore();
  const brain = createBrain({ store: { ...store, ...memorySchemaStore({ version: 9 }) }, schemaVersions: { core: 9 },
    clock: time.clock, idGen: sequenceIdGen({ timestampMs: new Date(start).getTime() }), spool: memorySpool(), files: memoryFileStore(), parsers: [],
    transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
  return { store, brain, time, set: (at: string) => time.advance(new Date(at).getTime() - time.clock.now().getTime()),
    zone: (value: string) => store.setSetting({ key: 'timezone', value, updatedAt: time.clock.now() }),
    add: (localTime = '11:00') => brain.schedules.add({ kind: 'schedule_probe', targetKind: 'probe', targetId: 'daily', localTime }),
    drain: () => brain.queue.drain({ budgetMs: 1000 }) };
}

async function probe(k: ReturnType<typeof kit>, id: string) {
  const now = k.time.clock.now(); await k.store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: id, createdAt: now, nextAttemptAt: now });
  const token = `token-${id}`;
  await k.store.claimSupervisedWork({ kinds: ['process_probe'], now, claimedBy: 'worker', attemptToken: token }); return token;
}
it('derives queued, running, unknown and closed states', async () => {
  const k = kit(); const now = k.time.clock.now();
  await k.store.addWork({ id: 'queued', kind: 'core', targetKind: 'probe', targetId: 'queued', createdAt: now, nextAttemptAt: now });
  const token = await probe(k, 'probe');
  expect(await k.brain.queue.list()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: 'queued', state: 'queued', attemptOutcome: null, elapsedMs: null }), expect.objectContaining({ id: 'probe', state: 'running' })]) });
  await k.store.settleSupervisedAttempt({ id: 'probe', attemptToken: token, now, outcome: 'unknown' });
  expect(await k.brain.queue.list({ kind: 'process_probe' })).toMatchObject({ items: [{ state: 'unknown' }] });
  await k.store.requestWorkCancel({ id: 'queued', now });
  expect(await k.brain.queue.list()).toMatchObject({ count: 1 });
  expect(await k.brain.queue.list({ all: true, kind: 'core' })).toMatchObject({ items: [{ state: 'cancelled' }] });
  expect(await k.brain.queue.list({ limit: 0 })).toMatchObject({ ok: false, code: 'USAGE' });
});
it('computes elapsed from the clock for a running attempt', async () => {
  const k = kit(); await probe(k, 'probe'); k.time.advance(4000);
  expect(await k.brain.queue.list()).toMatchObject({ items: [{ state: 'running', elapsedMs: 4000, usage: null }] });
});
it('keeps usage null apart from zero', async () => {
  const k = kit(); const token = await probe(k, 'probe');
  await k.store.finishSupervisedWork({ id: 'probe', attemptToken: token, now: k.time.clock.now(), outcome: 'succeeded', elapsedMs: 1500, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } });
  expect(await k.brain.queue.list({ all: true })).toMatchObject({ items: [{ state: 'succeeded', attempts: 1, elapsedMs: 1500, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } }] });
  expect(await k.brain.queue.list()).toMatchObject({ items: [], count: 0 });
});

it('uses the saved duration before finished duration and supports every closed outcome', async () => {
  const k = kit(); const token = await probe(k, 'probe'); k.time.advance(2500);
  await k.store.finishSupervisedWork({ id: 'probe', attemptToken: token, now: k.time.clock.now(), outcome: 'succeeded' });
  expect(await k.brain.queue.list({ all: true })).toMatchObject({ items: [{ elapsedMs: 2500, usage: null }] });
  const { workListState } = await import('../src/queue/list.js');
  const item = k.store.snapshot().workItems[0]!;
  for (const outcome of ['succeeded', 'failed', 'cancelled', 'dependency_failed'] as const) expect(workListState({ ...item, outcome }, null)).toBe(outcome);
});

it('uses the current unknown attempt for state while displaying the latest tied attempt', async () => {
  const k = kit(); const now = k.time.clock.now();
  await k.store.addWork({ id: 'probe', kind: 'process_probe', targetKind: 'probe', targetId: 'probe', createdAt: now, nextAttemptAt: now });
  await k.store.claimSupervisedWork({ now, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: 'token-z' });
  await k.store.settleSupervisedAttempt({ id: 'probe', attemptToken: 'token-z', now, outcome: 'died', elapsedMs: 1000 });
  await k.store.claimSupervisedWork({ now, kinds: ['process_probe'], claimedBy: 'worker', attemptToken: 'token-a' });
  await k.store.settleSupervisedAttempt({ id: 'probe', attemptToken: 'token-a', now, outcome: 'unknown', elapsedMs: 2000 });
  expect(await k.brain.queue.list()).toMatchObject({ items: [{ state: 'unknown', attemptOutcome: 'died', attemptStartedAt: now, elapsedMs: 1000 }] });
});
