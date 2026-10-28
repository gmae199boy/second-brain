import { expect, it } from 'vitest';
import { runSupervisor } from '../src/queue/supervisor.js';
import { drainQueue } from '../src/queue/drain.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { fakeProcessLauncher } from '../src/testing/fakes/process.js';
import { memorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
const now = new Date('2026-10-29T00:00:00Z');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function kit() {
  const store = memoryStore();
  const time = manualTime(now);
  const launcher = fakeProcessLauncher();
  const controller = new AbortController();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '700000', createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 2 }) }, ...time, launcher, idGen,
    launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) }, signal: controller.signal });
  await flush();
  return { store, time, launcher, controller, idGen, id, running };
}
it('renews 700 seconds of progress while core ingestion drains and competing claims stay empty', async () => {
  const k = await kit();
  const checks = new Set([0, 300, 590, 650, 699]);
  for (let second = 0; second <= 700; second++) {
    if (second > 0) k.time.advance(1000);
    if (second % 10 === 0) { k.launcher.processes[0]!.push('{"abi":1,"type":"progress"}'); await flush(); }
    if (checks.has(second)) {
      const input = { now: k.time.clock.now(), claimedBy: 'other', kinds: ['process_probe'] };
      expect(await k.store.claimSupervisedWork({ ...input, attemptToken: k.idGen.next() })).toMatchObject({ ok: true, item: null });
      expect(await k.store.claimWork(input)).toMatchObject({ ok: true, item: null });
    }
    if (second === 650) {
      await k.store.addWork({ id: k.idGen.next(), kind: 'session_ingest', targetKind: 'session', targetId: 'test', createdAt: now, nextAttemptAt: now });
      const report = await drainQueue({ store: k.store, spool: memorySpool(), clock: k.time.clock, idGen: k.idGen }, { budgetMs: 1000, handlers: { session_ingest: async () => ({ ok: true }) } });
      expect(report.completed).toBe(1);
    }
  }
  k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit(); await flush();
  expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: k.time.clock.now(), currentAttemptToken: null, attempts: 1 });
  expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'succeeded', finishedAt: k.time.clock.now() });
  k.controller.abort(); await k.running;
});
it.each(['missing result', 'bad line', 'nonzero exit'])('records %s as a retryable failed attempt', async failure => {
  const k = await kit();
  const child = k.launcher.processes[0]!;
  if (failure === 'bad line') child.push('bad');
  else if (failure === 'nonzero exit') child.push('{"abi":1,"type":"result"}');
  child.exit(failure === 'nonzero exit' ? 2 : 0); await flush();
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('failed');
  expect(k.store.snapshot().workItems[0]).toMatchObject({ claimedBy: null, completedAt: null, nextAttemptAt: new Date(now.getTime() + 1000) });
  expect(k.store.snapshot().failures).toEqual([]);
  k.controller.abort(); await k.running;
});
it('kills and reaps on abort without finishing the attempt', async () => {
  const k = await kit(); k.controller.abort(); await k.running;
  expect(k.launcher.processes[0]?.signals).toEqual(['SIGKILL']);
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe(null);
});
it('stale token renewal and finish leave both item and complete attempt history untouched', async () => {
  const store = memoryStore(); const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  const id = idGen.next(), a = idGen.next(), b = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  const claim = { now, claimedBy: idGen.next(), kinds: ['process_probe'] };
  await store.claimSupervisedWork({ ...claim, attemptToken: a });
  const later = new Date(now.getTime() + 600001);
  await store.claimSupervisedWork({ ...claim, now: later, attemptToken: b });
  const before = store.snapshot();
  expect(await store.renewSupervisedLease({ id, attemptToken: a, now: later, progressAt: later })).toEqual({ ok: true, outcome: 'lost' });
  expect(await store.finishSupervisedWork({ id, attemptToken: a, now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'lost' });
  expect(store.snapshot()).toEqual(before);
  expect(await store.finishSupervisedWork({ id, attemptToken: b, now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'done' });
});
