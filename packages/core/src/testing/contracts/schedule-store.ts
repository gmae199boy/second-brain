import type { ScheduleStore, WorkStore } from '../../ports/store.js';
import { assertEqual, assertNotOk, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/** Shared proof that schedule CAS and open-work deduplication agree across stores. */
export function scheduleStoreContract(): ContractCase<ScheduleStore & WorkStore>[] {
  const now = new Date('2026-02-03T04:05:06.000Z');
  const next = new Date(now.getTime() + 60_000);
  return [contractCase('due ordering, one-shot completion, lost CAS and existing work', async make => {
    await withSubject(make, async store => {
      for (const [id, at, intervalSeconds] of [
        ['b', now, 60], ['a', now, null], ['future', next, 60],
      ] as const) assertOk(await store.addSchedule({ id, kind: 'schedule_probe', targetKind: 'probe',
        targetId: id, intervalSeconds, nextRunAt: at, lastRunAt: null, createdAt: now }), 'add schedule');
      const early = await store.listDueSchedules({ now: new Date(now.getTime() - 1), limit: 100 });
      assertOk(early, 'early read'); assertEqual(early.schedules.length, 0, 'nothing early');
      const due = await store.listDueSchedules({ now, limit: 100 });
      assertOk(due, 'due read'); assertEqual(due.schedules.map(row => row.id).join(','), 'a,b', 'due order');
      const work = { id: 'work-a', kind: 'schedule_probe', targetKind: 'probe', targetId: 'a', createdAt: now, nextAttemptAt: now };
      const first = await store.fireSchedule({ scheduleId: 'a', expectedNextRunAt: now, nextRunAt: null, now, work });
      assertOk(first, 'first firing'); assertEqual(first.fired, true, 'first fired');
      if (first.fired) assertEqual(first.created, true, 'new work');
      const lost = await store.fireSchedule({ scheduleId: 'a', expectedNextRunAt: now, nextRunAt: null, now: next, work: { ...work, id: 'lost', targetId: 'lost' } });
      assertOk(lost, 'lost CAS'); assertEqual(lost.fired, false, 'CAS must lose');
      const targets = await store.listOpenWorkTargets({ kind: work.kind });
      assertOk(targets, 'work read'); assertEqual(targets.targets.length, 1, 'lost CAS adds nothing');
      await store.addWork({ ...work, id: 'work-b', targetId: 'b' });
      const repeated = await store.fireSchedule({ scheduleId: 'b', expectedNextRunAt: now, nextRunAt: next, now, work: { ...work, id: 'duplicate-b', targetId: 'b' } });
      assertOk(repeated, 'existing work firing'); assertEqual(repeated.fired, true, 'schedule advanced');
      if (repeated.fired) assertEqual(repeated.created, false, 'existing work reused');
      const after = await store.listDueSchedules({ now, limit: 100 });
      assertOk(after, 'after read'); assertEqual(after.schedules.length, 0, 'one-shot ended and recurrence moved');
      const later = await store.listDueSchedules({ now: next, limit: 1 });
      assertOk(later, 'limited read'); assertEqual(later.schedules.length, 1, 'limit respected');
      assertEqual(later.schedules[0]?.id, 'b', 'next instant persisted');
      assertEqual(later.schedules[0]?.lastRunAt?.getTime(), now.getTime(), 'last run persisted');
    });
  }), contractCase('due time precedes id order and equal times use binary id order', async make => {
    await withSubject(make, async store => {
      for (const [id, at] of [['z', new Date(now.getTime() - 1000)], ['a', now], ['B', now]] as const) {
        assertOk(await store.addSchedule({ id, kind: 'schedule_probe', targetKind: 'probe',
          targetId: id, intervalSeconds: 60, nextRunAt: at, lastRunAt: null, createdAt: now }), 'add schedule');
      }
      const first = await store.listDueSchedules({ now, limit: 1 });
      assertOk(first, 'limited due read');
      assertEqual(first.schedules.length, 1, 'limit respected');
      assertEqual(first.schedules[0]?.id, 'z', 'earlier instant wins over smaller id');
      const all = await store.listDueSchedules({ now, limit: 100 });
      assertOk(all, 'all due read');
      assertEqual(all.schedules.map(row => row.id).join(','), 'z,B,a', 'binary id tie break');
    });
  }), contractCase('preserves a distinct schedule identity, work kind and target', async make => {
    await withSubject(make, async store => {
      const input = { id: 'reservation-17', kind: 'refresh_collection', targetKind: 'collection',
        targetId: 'collection-42', intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
      assertOk(await store.addSchedule(input), 'add distinct target');
      const due = await store.listDueSchedules({ now, limit: 1 });
      assertOk(due, 'read distinct target');
      assertEqual(due.schedules, [input], 'all persisted fields retain their own values');
    });
  }), contractCase('rejects out-of-range timestamps without changing schedules or work', async make => {
    await withSubject(make, async store => {
      const input = { id: 'valid', kind: 'schedule_probe', targetKind: 'probe', targetId: 'target',
        intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
      assertOk(await store.addSchedule(input), 'add valid schedule');
      const before = await store.listDueSchedules({ now, limit: 100 });
      assertOk(before, 'read before invalid writes');
      const work = { id: 'work', kind: input.kind, targetKind: input.targetKind, targetId: input.targetId,
        createdAt: now, nextAttemptAt: now };
      const firing = { scheduleId: input.id, expectedNextRunAt: now, nextRunAt: next, now, work };
      for (const invalid of [new Date('-000001-01-01T00:00:00.000Z'), new Date('+010000-01-01T00:00:00.000Z')]) {
        for (const field of ['createdAt', 'nextRunAt', 'lastRunAt'] as const) {
          assertNotOk(await store.addSchedule({ ...input, id: 'rejected', [field]: invalid }), `reject add ${field}`);
        }
        for (const invalidFiring of [
          { ...firing, now: invalid }, { ...firing, nextRunAt: invalid },
          { ...firing, work: { ...work, createdAt: invalid } },
          { ...firing, work: { ...work, nextAttemptAt: invalid } },
        ]) {
          assertNotOk(await store.fireSchedule(invalidFiring), 'reject firing timestamp');
          const after = await store.listDueSchedules({ now, limit: 100 });
          assertOk(after, 'read after rejection');
          assertEqual(after.schedules, before.schedules, 'schedule times stay unchanged');
          const targets = await store.listOpenWorkTargets({ kind: work.kind });
          assertOk(targets, 'read work after rejection');
          assertEqual(targets.targets, [], 'rejection leaves no work');
        }
      }
      assertOk(await store.addSchedule({ ...input, id: 'rejected' }), 'rejected inserts never reserved their id');
    });
  })];
}
