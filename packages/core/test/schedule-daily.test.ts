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
async function added(k: ReturnType<typeof kit>, localTime = '11:00') {
  const result = await k.add(localTime); if (!result.ok) throw new Error(result.message); return result.schedule.id;
}
it('runs a Seoul 11:00 schedule once a day', async () => {
  const k = kit(); const id = await added(k);
  for (let halfHours = 0; halfHours < 144; halfHours++) {
    const now = k.time.clock.now(); const tick = await k.brain.schedules.tick();
    expect(tick).toEqual({ ok: true, fired: now.getUTCHours() === 2 && now.getUTCMinutes() === 0 ? 1 : 0,
      enqueued: now.getUTCHours() === 2 && now.getUTCMinutes() === 0 ? 1 : 0 });
    await k.drain(); k.time.advance(30 * 60_000);
  }
  expect(k.store.snapshot().workItems).toHaveLength(3);
  const successes = await k.store.listScheduleSuccesses({ scheduleId: id });
  expect(successes).toMatchObject({ ok: true, successes: [
    { localDate: '2026-10-01', timeZone: 'Asia/Seoul' }, { localDate: '2026-10-02' }, { localDate: '2026-10-03' }] });
});
it('fires at the first valid time after the New York spring gap', async () => {
  const k = kit('2026-03-08T00:00:00Z'); await k.zone('America/New_York'); await added(k, '02:30');
  k.set('2026-03-08T06:59:59Z'); expect(await k.brain.schedules.tick()).toMatchObject({ fired: 0 });
  k.set('2026-03-08T07:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ enqueued: 1 }); await k.drain();
  k.set('2026-03-08T08:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ fired: 0 });
  expect(k.store.snapshot().scheduleSuccesses.map(row => row.localDate)).toEqual(['2026-03-08']);
});
it('fires once on the New York fall overlap', async () => {
  const k = kit('2026-11-01T00:00:00Z'); await k.zone('America/New_York'); await added(k, '01:30');
  k.set('2026-11-01T05:30:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ enqueued: 1 }); await k.drain();
  k.set('2026-11-01T06:30:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ fired: 0 });
  expect(k.store.snapshot().workItems).toHaveLength(1);
});
it('wakes after three silent days and enqueues one work for the missing range', async () => {
  const k = kit(); await added(k); k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick(); await k.drain();
  k.set('2026-10-04T03:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ enqueued: 1 });
  expect(k.store.snapshot().workItems[1]?.scheduledDates).toMatchObject({ from: '2026-10-02', to: '2026-10-04' });
  await k.drain(); expect(k.store.snapshot().scheduleSuccesses).toHaveLength(4);
});
it('skips today after a successful manual run', async () => {
  const k = kit(); const id = await added(k); const before = await k.store.readSchedule({ id });
  expect(await k.brain.schedules.run({ scheduleId: id })).toMatchObject({ ok: true, created: true }); await k.drain();
  expect(await k.store.readSchedule({ id })).toEqual(before);
  k.set('2026-10-01T02:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ fired: 1, enqueued: 0 });
  k.set('2026-10-02T02:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ enqueued: 1 }); await k.drain();
  expect(k.store.snapshot().scheduleSuccesses).toHaveLength(2);
});
it('a manual run merges with the open scheduled work', async () => {
  const k = kit(); const id = await added(k); k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick();
  expect(await k.brain.schedules.run({ scheduleId: id })).toEqual({ ok: true, created: false, workId: k.store.snapshot().workItems[0]!.id });
  expect(k.store.snapshot().workItems).toHaveLength(1);
});
it('recomputes the next firing in the new timezone and keeps earlier success dates', async () => {
  const k = kit(); const id = await added(k); k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick(); await k.drain();
  const successes = await k.store.listScheduleSuccesses({ scheduleId: id }); await k.zone('America/New_York');
  expect(await k.brain.schedules.tick()).toMatchObject({ fired: 0 });
  expect(await k.store.readSchedule({ id })).toMatchObject({ schedule: { timeZone: 'America/New_York', nextRunAt: new Date('2026-10-01T15:00:00Z') } });
  k.set('2026-10-01T15:00:00Z'); expect(await k.brain.schedules.tick()).toMatchObject({ fired: 1, enqueued: 0 });
  expect(await k.store.listScheduleSuccesses({ scheduleId: id })).toEqual(successes);
  k.set('2026-10-02T15:00:00Z'); await k.brain.schedules.tick(); await k.drain();
  expect(k.store.snapshot().scheduleSuccesses.map(row => row.timeZone)).toEqual(['Asia/Seoul', 'America/New_York']);
});
it('requeues a range widened after claim', async () => {
  const k = kit(); await added(k); k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick();
  const claim = await k.store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now: k.time.clock.now() });
  if (!claim.ok || !claim.item) throw new Error('claim missing');
  k.set('2026-10-02T02:00:00Z'); await k.brain.schedules.tick();
  await k.store.completeWork({ id: claim.item.id, claimedBy: 'worker', now: k.time.clock.now() });
  expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: null, outcome: null, claimedBy: null });
  expect(k.store.snapshot().scheduleSuccesses.map(row => row.localDate)).toEqual(['2026-10-01']);
  await k.drain(); expect(k.store.snapshot().scheduleSuccesses.map(row => row.localDate)).toEqual(['2026-10-01', '2026-10-02']);
});
it('interval schedules never read the timezone', async () => {
  const k = kit();
  await k.zone('invalid/timezone');
  await k.store.addSchedule({ id: 'interval', kind: 'schedule_probe', targetKind: 'probe', targetId: 'interval',
    localTime: null, timeZone: null, intervalSeconds: 60, nextRunAt: k.time.clock.now(), lastRunAt: null, createdAt: k.time.clock.now() });
  expect(await k.brain.schedules.tick()).toMatchObject({ ok: true, enqueued: 1 });
  expect(await k.brain.schedules.run({ scheduleId: 'interval' })).toMatchObject({ ok: true, created: false });
});
it('rejects invalid input with schedule codes', async () => {
  const k = kit(); expect(await k.add('24:00')).toMatchObject({ ok: false, code: 'SCHEDULE_INVALID' });
  expect(await k.brain.schedules.run({ scheduleId: 'absent' })).toMatchObject({ ok: false, code: 'SCHEDULE_NOT_FOUND' });
  await added(k); expect(await k.add()).toMatchObject({ ok: false, code: 'SCHEDULE_CONFLICT' });
  expect(k.store.snapshot().workItems).toHaveLength(0);
});
it('returns timezone configuration failures from a daily tick', async () => {
  const k = kit(); await added(k); await k.zone('invalid/timezone');
  expect(await k.brain.schedules.tick()).toMatchObject({ ok: false, code: 'CONFIG_INVALID', fired: 0, enqueued: 0 });
});

it('catches up missing days after an outage and timezone change using the last firing anchor', async () => {
  const k = kit(); const id = await added(k);
  k.set('2026-10-01T02:00:00Z'); await k.brain.schedules.tick(); await k.drain();
  const before = await k.store.listScheduleSuccesses({ scheduleId: id });
  expect(before).toMatchObject({ ok: true, successes: [{ localDate: '2026-10-01', timeZone: 'Asia/Seoul' }] });
  k.set('2026-10-04T16:00:00Z'); await k.zone('America/New_York');
  expect(await k.brain.schedules.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
  expect(k.store.snapshot().workItems).toHaveLength(2);
  expect(k.store.snapshot().workItems[1]?.scheduledDates).toEqual({ scheduleId: id,
    from: '2026-10-02', to: '2026-10-04', timeZone: 'America/New_York' });
  await k.drain();
  const after = await k.store.listScheduleSuccesses({ scheduleId: id });
  expect(after).toMatchObject({ ok: true, successes: [
    { localDate: '2026-10-01', timeZone: 'Asia/Seoul' },
    { localDate: '2026-10-02', timeZone: 'America/New_York' },
    { localDate: '2026-10-03', timeZone: 'America/New_York' },
    { localDate: '2026-10-04', timeZone: 'America/New_York' },
  ] });
  if (before.ok && after.ok) expect(after.successes[0]).toEqual(before.successes[0]);
});

it('a manual run uses the current timezone before any tick rezones the schedule', async () => {
  const k = kit(); const id = await added(k);
  await k.zone('America/New_York'); k.set('2026-10-02T00:00:00Z');
  expect(await k.store.readSchedule({ id })).toMatchObject({ schedule: { timeZone: 'Asia/Seoul' } });
  const run = await k.brain.schedules.run({ scheduleId: id });
  expect(run).toMatchObject({ ok: true, created: true });
  const item = k.store.snapshot().workItems[0]!;
  expect(item.scheduledDates).toEqual({ scheduleId: id, from: '2026-10-01', to: '2026-10-01', timeZone: 'America/New_York' });
  await k.drain();
  expect(k.store.snapshot().workItems[0]).toMatchObject({ id: item.id, outcome: 'succeeded', completedAt: k.time.clock.now() });
  expect(await k.store.listScheduleSuccesses({ scheduleId: id })).toEqual({ ok: true, successes: [
    { localDate: '2026-10-01', timeZone: 'America/New_York', workId: item.id, recordedAt: k.time.clock.now() },
  ] });
});
