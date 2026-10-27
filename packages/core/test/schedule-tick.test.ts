import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { tickSchedules, SCHEDULE_TICK_LIMIT } from '../src/queue/schedule-tick.js';
import { SCHEDULE_PROBE_KIND } from '../src/queue/schedule-probe-work.js';
import { memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories,
  memoryTranscriptReader, sequenceIdGen } from '../src/testing/index.js';
import type { Schedule } from '../src/domain/schedule.js';

const now = new Date('2026-02-03T04:05:06.000Z');
const schedule = (over: Partial<Schedule> = {}): Schedule => ({ id: 's', kind: SCHEDULE_PROBE_KIND,
  targetKind: 'probe', targetId: 's', intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now, ...over });
function kit() {
  const store = memoryStore(); let at = now; let reads = 0;
  const clock = { now: () => { reads++; return new Date(at); } };
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  return { store, clock, idGen, set: (value: Date) => { at = value; }, reads: () => reads,
    tick: () => tickSchedules({ store, clock, idGen }) };
}
describe('schedule tick', () => {
  it('reads the clock once, waits until due, and collapses three missed periods', async () => {
    const k = kit(); await k.store.addSchedule(schedule());
    k.set(new Date(now.getTime() - 1)); expect(await k.tick()).toEqual({ ok: true, fired: 0, enqueued: 0 });
    expect(k.reads()).toBe(1);
    const late = new Date(now.getTime() + 185000); k.set(late);
    expect(await k.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    expect(k.reads()).toBe(2);
    const result = await k.store.listDueSchedules({ now: new Date(late.getTime() + 60000), limit: 100 });
    expect(result).toMatchObject({ ok: true, schedules: [{ nextRunAt: new Date(late.getTime() + 60000), lastRunAt: late }] });
    expect(k.store.snapshot().workItems).toHaveLength(1);
  });
  it('ends one-shots and advances a recurring schedule with existing work', async () => {
    const k = kit(); await k.store.addSchedule(schedule({ intervalSeconds: null }));
    expect(await k.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    k.set(new Date(now.getTime() + 500000)); expect(await k.tick()).toEqual({ ok: true, fired: 0, enqueued: 0 });
    await k.store.addSchedule(schedule({ id: 'second' }));
    expect(await k.tick()).toEqual({ ok: true, fired: 1, enqueued: 0 });
  });
  it('copies the schedule kind and target into queued work', async () => {
    const k = kit();
    const target = { kind: 'custom_refresh', targetKind: 'collection', targetId: 'collection-42' };
    await k.store.addSchedule(schedule(target));
    expect(await k.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    expect(k.store.snapshot().workItems).toHaveLength(1);
    expect(k.store.snapshot().workItems[0]).toMatchObject(target);
  });
  it('stops at the first failed firing with partial counts', async () => {
    const k = kit(); for (const id of ['a', 'b', 'c']) await k.store.addSchedule(schedule({ id, targetId: id }));
    let calls = 0; const original = k.store.fireSchedule;
    k.store.fireSchedule = async input => ++calls === 2 ? { ok: false, code: 'DB_LOCKED', message: 'locked' } : original(input);
    expect(await k.tick()).toEqual({ ok: false, code: 'DB_LOCKED', message: 'locked', fired: 1, enqueued: 1 });
    expect(calls).toBe(2);
  });
  it('limits a tick to 100 and reports read failures without firing', async () => {
    const k = kit(); for (let n = 0; n < 101; n++) await k.store.addSchedule(schedule({ id: String(n), targetId: String(n) }));
    expect(await k.tick()).toEqual({ ok: true, fired: SCHEDULE_TICK_LIMIT, enqueued: SCHEDULE_TICK_LIMIT });
    const firstIds = k.store.snapshot().workItems.map(item => item.id);
    expect(await k.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    const items = k.store.snapshot().workItems;
    expect(items).toHaveLength(101);
    expect(new Set(items.map(item => item.targetId)).size).toBe(101);
    expect(items.slice(0, 100).map(item => item.id)).toEqual(firstIds);
    expect(await k.tick()).toEqual({ ok: true, fired: 0, enqueued: 0 });
    k.store.listDueSchedules = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: 'offline' });
    expect(await k.tick()).toEqual({ ok: false, code: 'DB_UNAVAILABLE', message: 'offline', fired: 0, enqueued: 0 });
  });
  it('enqueues and completes a new occurrence after previous work completes', async () => {
    const k = kit(); await k.store.addSchedule(schedule());
    const brain = createBrain({ store: { ...k.store, ...memorySchemaStore({ version: 9 }) },
      files: memoryFileStore(), spool: memorySpool(), clock: k.clock, idGen: k.idGen, schemaVersion: 9,
      parsers: [], transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
    expect(await brain.schedules.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    expect(await brain.queue.drain({ budgetMs: 1000 })).toMatchObject({ completed: 1 });
    const next = new Date(now.getTime() + 60_000);
    k.set(next);
    expect(await brain.schedules.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    expect(await brain.queue.drain({ budgetMs: 1000 })).toMatchObject({ completed: 1 });
    const items = k.store.snapshot().workItems;
    expect(items).toHaveLength(2);
    expect(items[0]?.id).not.toBe(items[1]?.id);
    expect(items.map(item => item.completedAt)).toEqual([now, next]);
    expect(items.map(item => item.createdAt)).toEqual([now, next]);
    const following = new Date(next.getTime() + 60_000);
    expect(await k.store.listDueSchedules({ now: following, limit: 100 })).toMatchObject({
      ok: true, schedules: [{ lastRunAt: next, nextRunAt: following }],
    });
  });
  it('brain tick then drain completes the Core probe handler', async () => {
    const k = kit(); await k.store.addSchedule(schedule({ intervalSeconds: null }));
    const brain = createBrain({ store: { ...k.store, ...memorySchemaStore({ version: 9 }) },
      files: memoryFileStore(), spool: memorySpool(), clock: k.clock, idGen: k.idGen, schemaVersion: 9,
      parsers: [], transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
    expect(await brain.schedules.tick()).toEqual({ ok: true, fired: 1, enqueued: 1 });
    expect(await brain.queue.drain({ budgetMs: 1000 })).toMatchObject({ completed: 1 });
    expect(k.store.snapshot().workItems[0]?.completedAt).toEqual(now);
  });
});
