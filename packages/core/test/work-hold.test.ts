import { sampleSelfUserInput } from '../src/testing/index.js';
import { expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories,
  memoryTranscriptReader, sequenceIdGen, manualTime, sampleFailureInput } from '../src/testing/index.js';

function kit() {
  const time = manualTime(new Date('2026-10-29T00:00:00Z')); const store = memoryStore(); void store.ensureSelfUser(sampleSelfUserInput());
  const idGen = sequenceIdGen({ timestampMs: time.clock.now().getTime() });
  const brain = createBrain({ store: { ...store, ...memorySchemaStore({ version: 10 }) }, schemaVersions: { core: 10 },
    clock: time.clock, idGen, spool: memorySpool(), files: memoryFileStore(), parsers: [],
    transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
  const handled: string[] = [];
  return { store, brain, time, handled,
    add: (kind: string, targetId: string, holdGroup?: string) => store.addWork({ id: idGen.next(), kind, targetKind: 'probe', targetId,
      holdGroup, createdAt: time.clock.now(), nextAttemptAt: time.clock.now() }),
    drain: () => brain.queue.drain({ budgetMs: 1000, handlers: Object.fromEntries(['testext.job', 'core_job', 'otherext.job', 'session_ingest', 'testext.daily']
      .map(kind => [kind, async (item: { targetId: string }) => { handled.push(item.targetId); return { ok: true as const }; }])) }),
  };
}
it('holds and resumes only the named group', async () => {
  const k = kit();
  await k.add('testext.job', 'auto', 'ignored'); await k.add('core_job', 'explicit', 'extension:testext');
  await k.add('otherext.job', 'other'); await k.add('core_job', 'ungrouped');
  expect(await k.brain.queue.hold({ group: 'extension:testext' })).toEqual({ ok: true, group: 'extension:testext', held: true });
  expect(await k.brain.queue.hold({ group: 'extension:testext' })).toMatchObject({ held: false });
  await k.drain(); expect(k.handled.sort()).toEqual(['other', 'ungrouped']);
  expect(await k.brain.queue.list()).toMatchObject({ items: [expect.objectContaining({ state: 'extension_disabled' }), expect.objectContaining({ state: 'extension_disabled' })] });
  expect(k.store.snapshot().workItems.filter(i => i.completedAt === null)).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetId: 'auto', holdGroup: 'extension:testext', attempts: 0 }),
    expect.objectContaining({ targetId: 'explicit', holdGroup: 'extension:testext', attempts: 0 }),
  ]));
  expect(await k.brain.queue.release({ group: 'extension:testext' })).toEqual({ ok: true, group: 'extension:testext', released: true });
  expect(await k.brain.queue.release({ group: 'extension:testext' })).toMatchObject({ released: false });
  await k.drain(); expect(k.handled.sort()).toEqual(['auto', 'explicit', 'other', 'ungrouped']);
  expect(await k.brain.queue.list()).toMatchObject({ count: 0 });
});
it('manual run and failures retry do not bypass a hold', async () => {
  const k = kit();
  await k.store.setSetting({ userId: null, key: 'timezone', value: 'Asia/Seoul', updatedAt: k.time.clock.now() });
  const added = await k.brain.schedules.add({ kind: 'testext.daily', targetKind: 'probe', targetId: 'manual', localTime: '11:00' });
  if (!added.ok) throw new Error(added.message);
  await k.add('session_ingest', 'failed', 'extension:testext');
  await k.store.recordFailure(sampleFailureInput({ stage: 'session_ingest', targetKind: 'probe', targetId: 'failed' }));
  await k.brain.queue.hold({ group: 'extension:testext' });
  expect(await k.brain.schedules.run({ scheduleId: added.schedule.id })).toMatchObject({ ok: true, created: true });
  expect(await k.brain.schedules.run({ scheduleId: added.schedule.id })).toMatchObject({ ok: true, created: false });
  expect(await k.brain.failures.retry()).toMatchObject({ ok: true, alreadyOpen: 1, added: 0 });
  await k.drain(); expect(k.handled).toEqual([]);
  expect(await k.brain.queue.list()).toMatchObject({ count: 2, items: [expect.objectContaining({ state: 'extension_disabled' }), expect.objectContaining({ state: 'extension_disabled' })] });
  await k.brain.queue.release({ group: 'extension:testext' }); await k.drain();
  expect(k.handled.sort()).toEqual(['failed', 'manual']);
  expect(await k.brain.queue.list()).toMatchObject({ count: 0 });
});
it.each(['', '   ', 'x'.repeat(201)])('rejects an invalid group name (%s)', async group => {
  const k = kit();
  expect(await k.brain.queue.hold({ group })).toMatchObject({ ok: false, code: 'USAGE' });
  expect(await k.brain.queue.release({ group })).toMatchObject({ ok: false, code: 'USAGE' });
  expect(await k.store.releaseWorkGroup({ group })).toEqual({ ok: true, released: false });
});
it('lets user cancellation close held queued work', async () => {
  const k = kit(); const added = await k.add('testext.job', 'cancel');
  if (!added.ok) throw new Error(added.message);
  await k.brain.queue.hold({ group: 'extension:testext' });
  expect(await k.brain.queue.cancel({ id: added.item.id })).toMatchObject({ ok: true, state: 'cancelled' });
  expect(await k.brain.queue.list({ all: true })).toMatchObject({ items: [{ state: 'cancelled' }] });
  await k.brain.queue.release({ group: 'extension:testext' }); await k.drain(); expect(k.handled).toEqual([]);
});
it('확장 활성 SDK가 같은 그룹 일감을 보류하고 재개한다', async () => {
  const k = kit();
  await k.store.recordExtensionInstall({ name: 'testext', version: '1', now: k.time.clock.now() });
  await k.store.recordExtensionConnection({ name: 'testext', status: 'failed', code: 'REFUSED', message: 'CANARY_SECRET', checkedAt: k.time.clock.now() });
  expect(JSON.stringify(await k.brain.ext.list())).not.toContain('CANARY_SECRET');
  await k.add('testext.job', 'held'); await k.add('otherext.job', 'other');
  expect(await k.brain.ext.disable({ name: 'testext' })).toMatchObject({ ok: true, changed: true });
  const now = k.time.clock.now();
  const schedule = await k.store.addSchedule({ id: '00000000-0000-7000-8000-000000000101', kind: 'schedule_probe', holdGroup: 'extension:testext', targetKind: 'probe', targetId: 'held-schedule', localTime: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now });
  expect(schedule).toMatchObject({ ok: true });
  expect(await k.brain.queue.release({ group: 'extension:testext' })).toEqual({ ok: true, group: 'extension:testext', released: false });
  expect(await k.store.listDueSchedules({ now, limit: 10 })).toMatchObject({ ok: true, schedules: [] });
  expect(await k.brain.ext.publicStatus({ name: 'testext' })).toMatchObject({ ok: true, status: { enabled: false, interruptedWorkCount: 1 } });
  await k.drain(); expect(k.handled).toEqual(['other']);
  expect(await k.brain.ext.enable({ name: 'testext' })).toMatchObject({ ok: true, changed: true });
  expect(await k.store.listDueSchedules({ now, limit: 10 })).toMatchObject({ ok: true, schedules: [expect.objectContaining({ targetId: 'held-schedule' })] });
  await k.drain(); expect(k.handled.sort()).toEqual(['held', 'other']);
});
