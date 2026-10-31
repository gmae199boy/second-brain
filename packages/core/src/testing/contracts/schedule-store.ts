import type { ScheduleStore, WorkStore } from '../../ports/store.js';
import { assertEqual, assertNotOk, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

const IDS = {
  a: '00000000-0000-7000-8000-000000000001',
  b: '00000000-0000-7000-8000-000000000002',
  future: '00000000-0000-7000-8000-000000000003',
  workA: '00000000-0000-7000-8000-000000000004',
  lost: '00000000-0000-7000-8000-000000000005',
  workB: '00000000-0000-7000-8000-000000000006',
  duplicateB: '00000000-0000-7000-8000-000000000007',
  early: '00000000-0000-7000-8000-000000000008',
  largeTie: '00000000-0000-7000-8000-000000000009',
  reservation: '00000000-0000-7000-8000-000000000010',
  valid: '00000000-0000-7000-8000-000000000011',
  work: '00000000-0000-7000-8000-000000000012',
  rejected: '00000000-0000-7000-8000-000000000013',
} as const;

/** Shared proof that schedule CAS and open-work deduplication agree across stores. */
export function scheduleStoreContract(): ContractCase<ScheduleStore & WorkStore>[] {
  const now = new Date('2026-02-03T04:05:06.000Z');
  const next = new Date(now.getTime() + 60_000);
  const daily = (over: Partial<import('../../domain/schedule.js').Schedule> = {}) => ({ holdGroup: null, id: IDS.a, kind: 'schedule_probe', targetKind: 'probe', targetId: IDS.a,
    localTime: '11:00', timeZone: 'Asia/Seoul', intervalSeconds: null, nextRunAt: now, lastRunAt: null, createdAt: now, ...over });
  const dates = { scheduleId: IDS.a, from: '2026-02-01', to: '2026-02-02', timeZone: 'Asia/Seoul' };
  const work = (over: Partial<import('../../ports/store.js').AddWorkInput> = {}) => ({ id: IDS.workA, kind: 'schedule_probe', targetKind: 'probe', targetId: IDS.a, createdAt: now, nextAttemptAt: now, scheduledDates: dates, ...over });
  return [contractCase('매일 예약의 고유 키로 정확한 설정을 조회한다', async make => {
    await withSubject(make, async store => {
      const key = { kind: 'schedule_probe', targetKind: 'probe', targetId: IDS.a };
      assertEqual(await store.findDailySchedule(key), { ok: true, schedule: null }, '예약 없음');
      const added = await store.addSchedule(daily()); assertOk(added, '예약 생성');
      assertEqual(await store.findDailySchedule(key), { ok: true, schedule: added.schedule }, '키 조회');
      assertEqual(await store.findDailySchedule({ ...key, targetId: IDS.b }), { ok: true, schedule: null }, '다른 키');
    });
  }), contractCase('validates resolved schedule groups before persisting or checking conflicts', async make => {
    await withSubject(make, async store => {
      for (const over of [{ holdGroup: '' }, { holdGroup: 'x'.repeat(201) }, { holdGroup: '😀'.repeat(201) }, { kind: 'x'.repeat(191) + '.daily' }]) {
        const result = await store.addSchedule(daily(over));
        assertEqual(result.ok, false, 'invalid resolved group rejected');
        if (!result.ok) assertEqual(result.code, 'DB_UNAVAILABLE', 'constraint failure');
      }
      const empty = await store.listSchedules({ limit: 10 }); assertOk(empty, 'empty'); assertEqual(empty.schedules, [], 'no invalid schedule persisted');
      const boundary = await store.addSchedule(daily({ holdGroup: '😀'.repeat(200) })); assertOk(boundary, '200 code points accepted');
      const before = await store.readSchedule({ id: IDS.a });
      const conflict = await store.addSchedule(daily({ id: IDS.b, holdGroup: '' }));
      assertEqual(conflict.ok, false, 'invalid conflicting schedule rejected');
      if (!conflict.ok) assertEqual(conflict.code, 'DB_UNAVAILABLE', 'check precedes conflict');
      assertEqual(await store.readSchedule({ id: IDS.a }), before, 'existing schedule unchanged');
      for (const [id, holdGroup] of [[IDS.b, ''], [IDS.future, '😀'.repeat(201)]] as const) {
        const automatic = await store.addSchedule(daily({ id, targetId: id, kind: 'testext.daily', holdGroup })); assertOk(automatic, 'automatic overrides invalid explicit');
        assertEqual(automatic.schedule.holdGroup, 'extension:testext', 'resolved automatic group accepted');
      }
    });
  }), contractCase('does not fire a held schedule and fires once after release', async make => {
    await withSubject(make, async store => {
      const added = await store.addSchedule(daily({ kind: 'testext.daily', holdGroup: 'other' })); assertOk(added, 'add');
      assertEqual(added.schedule.holdGroup, 'extension:testext', 'automatic group');
      await store.holdWorkGroup({ group: 'extension:testext', now });
      const before = await store.readSchedule({ id: IDS.a });
      const firing = { scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: next, now, work: work(), localDates: dates };
      assertEqual(await store.listDueSchedules({ now: next, limit: 10 }), { ok: true, schedules: [] }, 'due hidden');
      assertEqual(await store.fireSchedule(firing), { ok: true, fired: false }, 'held CAS');
      assertEqual(await store.readSchedule({ id: IDS.a }), before, 'schedule unchanged');
      assertEqual(await store.listWork({ includeClosed: true, limit: 10 }), { ok: true, entries: [], hasMore: false }, 'no work');
      assertEqual(await store.listScheduleSuccesses({ scheduleId: IDS.a }), { ok: true, successes: [] }, 'no success');
      await store.releaseWorkGroup({ group: 'extension:testext' });
      assertEqual(await store.fireSchedule(firing), { ok: true, fired: true, created: true, covered: false }, 'fired once');
      assertEqual(await store.fireSchedule(firing), { ok: true, fired: false }, 'CAS prevents duplicate');
      const list = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(list, 'work');
      assertEqual(list.entries[0]?.item.holdGroup, 'extension:testext', 'firing passes schedule group');
    });
  }), contractCase('stores an explicit core schedule group', async make => {
    await withSubject(make, async store => {
      const added = await store.addSchedule(daily({ holdGroup: 'extension:testext' })); assertOk(added, 'add');
      assertEqual(added.schedule.holdGroup, 'extension:testext', 'explicit core group');
    });
  }), contractCase('lists schedules in creation order with has_more', async make => {
    await withSubject(make, async store => {
      await store.addSchedule(daily({ id: IDS.b, targetId: 'second', createdAt: next }));
      await store.addSchedule(daily());
      const page = await store.listSchedules({ limit: 1 }); assertOk(page, 'list');
      assertEqual(page.schedules.map(s => s.id), [IDS.a], 'oldest first'); assertEqual(page.hasMore, true, 'more');
      const all = await store.listSchedules({ limit: 10 }); assertOk(all, 'all'); assertEqual(all.hasMore, false, 'no more');
    });
  }), contractCase('removing a schedule stops its firing and keeps its open work', async make => {
    await withSubject(make, async store => {
      await store.addSchedule(daily()); await store.addWork(work());
      assertEqual(await store.removeSchedule({ id: IDS.a }), { ok: true, removed: true }, 'removed');
      const list = await store.listSchedules({ limit: 10 }); assertOk(list, 'list'); assertEqual(list.schedules, [], 'gone');
      const open = await store.listWork({ includeClosed: false, limit: 10 }); assertOk(open, 'work');
      assertEqual(open.entries[0]?.item.scheduledDates?.scheduleId, null, 'FK null');
      assertEqual(await store.fireSchedule({ scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: next, work: work(), now }), { ok: true, fired: false }, 'no firing');
    });
  }), contractCase('remove reports a missing schedule', async make => {
    await withSubject(make, async store => { assertEqual(await store.removeSchedule({ id: IDS.a }), { ok: true, removed: false }, 'missing'); });
  }), contractCase('daily schedules round trip and one daily schedule per target', async make => {
    await withSubject(make, async store => {
      const input = daily(); assertOk(await store.addSchedule(input), 'daily add');
      const read = await store.readSchedule({ id: input.id }); assertOk(read, 'read daily'); assertEqual(read.schedule, input, 'round trip');
      const list = await store.listDailySchedules({ limit: 100 }); assertOk(list, 'daily list'); assertEqual(list.schedules, [input], 'listed');
      const duplicate = await store.addSchedule(daily({ id: IDS.b })); assertNotOk(duplicate, 'duplicate rejected');
      if (!duplicate.ok) assertEqual(duplicate.code, 'SCHEDULE_CONFLICT', 'conflict code');
      assertOk(await store.addSchedule(daily({ id: IDS.b, localTime: null, timeZone: null, intervalSeconds: 60 })), 'interval can share target');
      const absent = await store.readSchedule({ id: IDS.future }); assertOk(absent, 'absent read'); assertEqual(absent.schedule, null, 'absent is null');
    });
  }), contractCase('a daily firing skips covered dates and enqueues the missing range', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      assertOk(await store.addWork(work({ scheduledDates: { ...dates, to: dates.from } })), 'manual');
      const claimed = await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now }); assertOk(claimed, 'claim');
      assertOk(await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now }), 'complete');
      const covered = await store.fireSchedule({ scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: next, now,
        work: work({ id: IDS.workB }), localDates: { from: dates.from, to: dates.from, timeZone: dates.timeZone } });
      assertOk(covered, 'covered fire'); assertEqual(covered, { ok: true, fired: true, created: false, covered: true }, 'no work for covered date');
      const fired = await store.fireSchedule({ scheduleId: IDS.a, expectedNextRunAt: next, nextRunAt: new Date(next.getTime() + 60000), now: next,
        work: work({ id: IDS.workB }), localDates: { ...dates, to: '2026-02-04' } });
      assertOk(fired, 'missing fire'); assertEqual(fired, { ok: true, fired: true, created: true, covered: false }, 'one missing work');
      const missing = await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now: next }); assertOk(missing, 'claim missing');
      assertEqual(missing.item?.scheduledDates, { ...dates, from: '2026-02-02', to: '2026-02-04' }, 'only missing extent');
    });
  }), contractCase('merging widens the open range and keeps its zone', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      assertOk(await store.addWork(work({ scheduledDates: { ...dates, scheduleId: null } })), 'first');
      const merged = await store.addWork(work({ id: IDS.workB, scheduledDates: { ...dates, from: '2026-01-30', to: '2026-02-04', timeZone: 'UTC' } }));
      assertOk(merged, 'merged'); assertEqual(merged.created, false, 'same work'); assertEqual(merged.item.id, IDS.workA, 'same id');
      assertEqual(merged.item.scheduledDates, { ...dates, from: '2026-01-30', to: '2026-02-04' }, 'widened range retains zone and fills schedule id');
    });
  }), contractCase('success records the claimed dates on both finish paths', async make => {
    for (const supervised of [false, true]) await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const kind = supervised ? 'process_probe' : 'schedule_probe';
      assertOk(await store.addWork(work({ kind })), 'work');
      const claim = supervised ? await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker', now, attemptToken: IDS.reservation })
        : await store.claimWork({ kinds: [kind], claimedBy: 'worker', now });
      assertOk(claim, 'claim'); assertEqual(claim.item?.id, IDS.workA, 'claimed work');
      const finished = supervised ? await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now: next, outcome: 'succeeded' })
        : await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now: next });
      assertOk(finished, 'finished'); assertEqual(finished.outcome, 'done', 'winning finish');
      const successes = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(successes, 'successes');
      assertEqual(successes.successes, ['2026-02-01', '2026-02-02'].map(localDate => ({ localDate, timeZone: dates.timeZone, workId: IDS.workA, recordedAt: next })), 'claimed days recorded');
    });
  }), contractCase('a range widened after claim records the claimed part and requeues', async make => {
    for (const supervised of [false, true]) for (const earlier of [false, true]) await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const kind = supervised ? 'process_probe' : 'schedule_probe';
      const snapshotDate = earlier ? dates.to : dates.from;
      assertOk(await store.addWork(work({ kind, scheduledDates: { ...dates, from: snapshotDate, to: snapshotDate } })), 'work');
      if (supervised) assertOk(await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker', now, attemptToken: IDS.reservation }), 'claim');
      else assertOk(await store.claimWork({ kinds: [kind], claimedBy: 'worker', now }), 'claim');
      assertOk(await store.addWork(work({ kind, id: IDS.workB })), 'merge');
      if (supervised) assertOk(await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now: next, outcome: 'succeeded' }), 'finish');
      else assertOk(await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now: next }), 'finish');
      const first = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(first, 'first successes');
      assertEqual(first.successes.map(row => row.localDate), [snapshotDate], 'only snapshot recorded');
      const again = supervised ? await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker2', now: next, attemptToken: IDS.early })
        : await store.claimWork({ kinds: [kind], claimedBy: 'worker2', now: next });
      assertOk(again, 'claim again'); assertEqual(again.item?.id, IDS.workA, 'same row returned to queue');
      assertEqual(again.item?.scheduledDates, dates, 'full widened range retained'); assertEqual(again.item?.outcome, null, 'open outcome');
      if (supervised) assertOk(await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.early, now: next, outcome: 'succeeded' }), 'finish again');
      else assertOk(await store.completeWork({ id: IDS.workA, claimedBy: 'worker2', now: next }), 'finish again');
      const all = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(all, 'all successes');
      assertEqual(all.successes.map(row => row.localDate), [dates.from, dates.to], 'both days');
      assertEqual(all.successes.find(row => row.localDate === snapshotDate), first.successes[0], 'first record unchanged');
      assertEqual(await store.requestWorkCancel({ id: IDS.workA, now: next }), { ok: true, state: 'already_closed' }, 'final work is closed');
      assertEqual(await store.listOpenWorkTargets({ kind }), { ok: true, targets: [] }, 'no open work remains');
    });
  }), contractCase('dates merged into a dateless claim are recorded only on the next success', async make => {
    for (const supervised of [false, true]) await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const kind = supervised ? 'process_probe' : 'schedule_probe';
      assertOk(await store.addWork(work({ kind, scheduledDates: undefined })), 'dateless work');
      const claim = supervised ? await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker', now, attemptToken: IDS.reservation })
        : await store.claimWork({ kinds: [kind], claimedBy: 'worker', now });
      assertOk(claim, 'claim'); assertEqual(claim.item?.id, IDS.workA, 'original id');
      assertEqual(claim.item?.scheduledDates, null, 'dateless snapshot');
      const merged = await store.addWork(work({ kind, id: IDS.workB }));
      assertOk(merged, 'merge'); assertEqual(merged.created, false, 'reused work'); assertEqual(merged.item.id, IDS.workA, 'same id');
      const finish = supervised ? await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now: next, outcome: 'succeeded' })
        : await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now: next });
      assertEqual(finish, { ok: true, outcome: 'done' }, 'first success');
      assertEqual(await store.listScheduleSuccesses({ scheduleId: IDS.a }), { ok: true, successes: [] }, 'no dates in first snapshot');
      const again = supervised ? await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker2', now: next, attemptToken: IDS.early })
        : await store.claimWork({ kinds: [kind], claimedBy: 'worker2', now: next });
      assertOk(again, 'claim again'); assertEqual(again.item?.id, IDS.workA, 'same row requeued');
      assertEqual(again.item?.scheduledDates, dates, 'merged dates retained');
      assertEqual(again.item?.completedAt, null, 'still pending'); assertEqual(again.item?.outcome, null, 'no closed outcome');
      const finished = supervised ? await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.early, now: next, outcome: 'succeeded' })
        : await store.completeWork({ id: IDS.workA, claimedBy: 'worker2', now: next });
      assertEqual(finished, { ok: true, outcome: 'done' }, 'second success');
      const successes = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(successes, 'successes');
      assertEqual(successes.successes, [dates.from, dates.to].map(localDate => ({ localDate, timeZone: dates.timeZone, workId: IDS.workA, recordedAt: next })), 'second snapshot recorded');
      assertEqual(await store.requestWorkCancel({ id: IDS.workA, now: next }), { ok: true, state: 'already_closed' }, 'finally closed');
      assertEqual(await store.listOpenWorkTargets({ kind }), { ok: true, targets: [] }, 'no open work');
    });
  }), contractCase('core failure, cancellation and dependency failure record no dates', async make => {
    for (const mode of ['failed', 'cancelled', 'dependency_failed'] as const) await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      if (mode === 'dependency_failed') {
        assertOk(await store.addWorkGraph({ nodes: [
          { ...work({ id: IDS.workB, targetId: IDS.b, scheduledDates: undefined }), after: [] },
          { ...work(), after: [0] },
        ] }), 'dependent date work');
      } else assertOk(await store.addWork(work()), 'date work');
      if (mode === 'cancelled') {
        assertEqual(await store.requestWorkCancel({ id: IDS.workA, now: next }), { ok: true, state: 'cancelled' }, 'direct cancellation');
      } else {
        const rootId = mode === 'failed' ? IDS.workA : IDS.workB;
        const claim = await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now });
        assertOk(claim, 'claim'); assertEqual(claim.item?.id, rootId, 'claimed root');
        assertEqual(await store.recordFailure({ id: IDS.lost, targetKind: 'probe', targetId: claim.item!.targetId,
          stage: 'probe', fingerprint: 'probe', harness: null, sessionId: null, code: 'PROBE_FAILED', message: 'failed', occurredAt: next,
          closeWork: { id: rootId, claimedBy: 'worker', now: next } }), { ok: true, outcome: 'recorded', created: true, failureId: IDS.lost }, 'permanent failure recorded');
      }
      assertEqual(await store.requestWorkCancel({ id: IDS.workA, now: next }), { ok: true, state: 'already_closed' }, 'date work is closed');
      assertEqual(await store.listOpenWorkTargets({ kind: 'schedule_probe' }), { ok: true, targets: [] }, 'no open work');
      assertEqual(await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker2', now: next }), { ok: true, item: null }, 'closed work cannot be claimed');
      assertEqual(await store.listScheduleSuccesses({ scheduleId: IDS.a }), { ok: true, successes: [] }, 'no success dates');
    });
  }), contractCase('failed work records no success', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily'); assertOk(await store.addWork(work({ kind: 'process_probe' })), 'work');
      assertOk(await store.claimSupervisedWork({ kinds: ['process_probe'], claimedBy: 'worker', now, attemptToken: IDS.reservation }), 'claim');
      assertOk(await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now, outcome: 'failed', failure: {
        id: IDS.workB, stage: 'probe', fingerprint: 'probe', code: 'PROBE_FAILED', message: 'failed', occurredAt: now } }), 'fail');
      const successes = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(successes, 'successes'); assertEqual(successes.successes, [], 'failure records nothing');
    });
  }), contractCase('rezone is a compare-and-set', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const update = { id: IDS.a, expectedNextRunAt: now, expectedTimeZone: 'Asia/Seoul', timeZone: 'America/New_York', nextRunAt: next };
      assertEqual(await store.rezoneSchedule({ ...update, expectedNextRunAt: next }), { ok: true, updated: false }, 'wrong instant loses');
      assertEqual(await store.rezoneSchedule({ ...update, expectedTimeZone: 'UTC' }), { ok: true, updated: false }, 'wrong zone loses');
      assertEqual(await store.rezoneSchedule(update), { ok: true, updated: true }, 'matching CAS');
      assertEqual(await store.rezoneSchedule(update), { ok: true, updated: false }, 'old CAS loses');
      const read = await store.readSchedule({ id: IDS.a }); assertOk(read, 'read'); assertEqual(read.schedule?.timeZone, update.timeZone, 'new zone');
    });
  }), contractCase('a firing with a stale zone loses after a rezone at the same instant', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      assertEqual(await store.rezoneSchedule({ id: IDS.a, expectedNextRunAt: now, expectedTimeZone: dates.timeZone,
        timeZone: 'Asia/Tokyo', nextRunAt: now }), { ok: true, updated: true }, 'same instant rezone');
      const before = await store.readSchedule({ id: IDS.a }); assertOk(before, 'before');
      const firing = { scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: next, now, work: work() };
      assertEqual(await store.fireSchedule({ ...firing, localDates: dates }), { ok: true, fired: false }, 'stale zone loses');
      assertEqual(await store.readSchedule({ id: IDS.a }), before, 'lost fire leaves schedule unchanged');
      const targets = await store.listOpenWorkTargets({ kind: 'schedule_probe' }); assertOk(targets, 'targets');
      assertEqual(targets.targets, [], 'lost fire creates no work');
      assertEqual(await store.fireSchedule({ ...firing, localDates: { ...dates, timeZone: 'Asia/Tokyo' } }),
        { ok: true, fired: true, created: true, covered: false }, 'current zone wins');
    });
  }), contractCase('success closes a cancelled widened range and records only claimed dates', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const input = work({ kind: 'process_probe', scheduledDates: { ...dates, to: dates.from } });
      assertOk(await store.addWork(input), 'work');
      const claim = await store.claimSupervisedWork({ kinds: ['process_probe'], claimedBy: 'worker', now, attemptToken: IDS.reservation });
      assertOk(claim, 'claim'); assertEqual(claim.item?.id, IDS.workA, 'claimed');
      assertOk(await store.addWork(work({ kind: 'process_probe', id: IDS.workB })), 'widen');
      assertOk(await store.addWorkGraph({ nodes: [
        { ...input, after: [] },
        { ...work({ id: IDS.lost, targetId: IDS.b, scheduledDates: undefined }), after: [0] },
      ] }), 'dependent work');
      assertEqual(await store.requestWorkCancel({ id: IDS.workA, now }), { ok: true, state: 'requested' }, 'cancel requested');
      assertEqual(await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now: next, outcome: 'succeeded' }),
        { ok: true, outcome: 'done' }, 'success wins');
      const successes = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(successes, 'successes');
      assertEqual(successes.successes, [{ localDate: dates.from, timeZone: dates.timeZone, workId: IDS.workA, recordedAt: next }], 'only claimed date recorded');
      const targets = await store.listOpenWorkTargets({ kind: 'process_probe' }); assertOk(targets, 'targets');
      assertEqual(targets.targets, [], 'succeeded row is closed');
      const dependent = await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'dependent', now: next });
      assertOk(dependent, 'claim dependent'); assertEqual(dependent.item?.id, IDS.lost, 'closed outcome is succeeded');
      const again = await store.addWork(work({ kind: 'process_probe', id: IDS.workB })); assertOk(again, 'new work');
      assertEqual(again.created, true, 'later work does not merge into cancelled row');
    });
  }), contractCase('returned work dates cannot mutate stored ranges or claim snapshots', async make => {
    for (const supervised of [false, true]) await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily');
      const kind = supervised ? 'process_probe' : 'schedule_probe';
      const added = await store.addWork(work({ kind })); assertOk(added, 'added');
      added.item.scheduledDates!.from = '2026-01-01';
      const merged = await store.addWork(work({ kind, id: IDS.workB })); assertOk(merged, 'merged');
      assertEqual(merged.item.scheduledDates, dates, 'added result is independent');
      merged.item.scheduledDates!.to = '2026-03-01';
      const claim = supervised ? await store.claimSupervisedWork({ kinds: [kind], claimedBy: 'worker', now, attemptToken: IDS.reservation })
        : await store.claimWork({ kinds: [kind], claimedBy: 'worker', now });
      assertOk(claim, 'claim'); assertEqual(claim.item?.scheduledDates, dates, 'merged result is independent');
      claim.item!.scheduledDates!.to = '2026-04-01';
      const finished = supervised ? await store.finishSupervisedWork({ id: IDS.workA, attemptToken: IDS.reservation, now: next, outcome: 'succeeded' })
        : await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now: next });
      assertOk(finished, 'finished');
      const targets = await store.listOpenWorkTargets({ kind }); assertOk(targets, 'targets');
      assertEqual(targets.targets, [], 'claim result mutation does not reopen work');
      const successes = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(successes, 'successes');
      assertEqual(successes.successes.map(row => row.localDate), [dates.from, dates.to], 'original claimed dates recorded');
    });
  }), contractCase('success records keep their zone', async make => {
    await withSubject(make, async store => {
      assertOk(await store.addSchedule(daily()), 'daily'); assertOk(await store.addWork(work()), 'work');
      assertOk(await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now }), 'claim');
      assertOk(await store.completeWork({ id: IDS.workA, claimedBy: 'worker', now }), 'finish');
      const before = await store.listScheduleSuccesses({ scheduleId: IDS.a }); assertOk(before, 'before');
      assertOk(await store.rezoneSchedule({ id: IDS.a, expectedNextRunAt: now, expectedTimeZone: 'Asia/Seoul', timeZone: 'UTC', nextRunAt: next }), 'rezone');
      assertOk(await store.addWork(work({ id: IDS.workB, scheduledDates: { ...dates, timeZone: 'UTC' } })), 'manual again');
      assertOk(await store.claimWork({ kinds: ['schedule_probe'], claimedBy: 'worker', now }), 'claim again');
      assertOk(await store.completeWork({ id: IDS.workB, claimedBy: 'worker', now: next }), 'finish again');
      assertEqual(await store.listScheduleSuccesses({ scheduleId: IDS.a }), before, 'first success wins without zone reinterpretation');
    });
  }), contractCase('due ordering, one-shot completion, lost CAS and existing work', async make => {
    await withSubject(make, async store => {
      for (const [id, at, intervalSeconds] of [
        [IDS.b, now, 60], [IDS.a, now, null], [IDS.future, next, 60],
      ] as const) assertOk(await store.addSchedule({ id, kind: 'schedule_probe', targetKind: 'probe',
        targetId: id, localTime: null, timeZone: null, intervalSeconds, nextRunAt: at, lastRunAt: null, createdAt: now }), 'add schedule');
      const early = await store.listDueSchedules({ now: new Date(now.getTime() - 1), limit: 100 });
      assertOk(early, 'early read'); assertEqual(early.schedules.length, 0, 'nothing early');
      const due = await store.listDueSchedules({ now, limit: 100 });
      assertOk(due, 'due read'); assertEqual(due.schedules.map(row => row.id).join(','), [IDS.a, IDS.b].join(','), 'due order');
      const work = { id: IDS.workA, kind: 'schedule_probe', targetKind: 'probe', targetId: IDS.a, createdAt: now, nextAttemptAt: now };
      const first = await store.fireSchedule({ scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: null, now, work });
      assertOk(first, 'first firing'); assertEqual(first.fired, true, 'first fired');
      if (first.fired) assertEqual(first.created, true, 'new work');
      const lost = await store.fireSchedule({ scheduleId: IDS.a, expectedNextRunAt: now, nextRunAt: null, now: next, work: { ...work, id: IDS.lost, targetId: IDS.lost } });
      assertOk(lost, 'lost CAS'); assertEqual(lost.fired, false, 'CAS must lose');
      const targets = await store.listOpenWorkTargets({ kind: work.kind });
      assertOk(targets, 'work read'); assertEqual(targets.targets.length, 1, 'lost CAS adds nothing');
      await store.addWork({ ...work, id: IDS.workB, targetId: IDS.b });
      const repeated = await store.fireSchedule({ scheduleId: IDS.b, expectedNextRunAt: now, nextRunAt: next, now, work: { ...work, id: IDS.duplicateB, targetId: IDS.b } });
      assertOk(repeated, 'existing work firing'); assertEqual(repeated.fired, true, 'schedule advanced');
      if (repeated.fired) assertEqual(repeated.created, false, 'existing work reused');
      const after = await store.listDueSchedules({ now, limit: 100 });
      assertOk(after, 'after read'); assertEqual(after.schedules.length, 0, 'one-shot ended and recurrence moved');
      const later = await store.listDueSchedules({ now: next, limit: 1 });
      assertOk(later, 'limited read'); assertEqual(later.schedules.length, 1, 'limit respected');
      assertEqual(later.schedules[0]?.id, IDS.b, 'next instant persisted');
      assertEqual(later.schedules[0]?.lastRunAt?.getTime(), now.getTime(), 'last run persisted');
    });
  }), contractCase('due time precedes id order and equal times use binary id order', async make => {
    await withSubject(make, async store => {
      for (const [id, at] of [[IDS.early, new Date(now.getTime() - 1000)], [IDS.largeTie, now], [IDS.a, now]] as const) {
        assertOk(await store.addSchedule({ id, kind: 'schedule_probe', targetKind: 'probe',
          targetId: id, localTime: null, timeZone: null, intervalSeconds: 60, nextRunAt: at, lastRunAt: null, createdAt: now }), 'add schedule');
      }
      const first = await store.listDueSchedules({ now, limit: 1 });
      assertOk(first, 'limited due read');
      assertEqual(first.schedules.length, 1, 'limit respected');
      assertEqual(first.schedules[0]?.id, IDS.early, 'earlier instant wins over smaller id');
      const all = await store.listDueSchedules({ now, limit: 100 });
      assertOk(all, 'all due read');
      assertEqual(all.schedules.map(row => row.id).join(','), [IDS.early, IDS.a, IDS.largeTie].join(','), 'binary id tie break');
    });
  }), contractCase('preserves a distinct schedule identity, work kind and target', async make => {
    await withSubject(make, async store => {
      const input = { holdGroup: null, id: IDS.reservation, kind: 'refresh_collection', targetKind: 'collection',
        targetId: 'collection-42', localTime: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
      assertOk(await store.addSchedule(input), 'add distinct target');
      const due = await store.listDueSchedules({ now, limit: 1 });
      assertOk(due, 'read distinct target');
      assertEqual(due.schedules, [input], 'all persisted fields retain their own values');
    });
  }), contractCase('rejects out-of-range timestamps without changing schedules or work', async make => {
    await withSubject(make, async store => {
      const input = { id: IDS.valid, kind: 'schedule_probe', targetKind: 'probe', targetId: 'target',
        localTime: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
      assertOk(await store.addSchedule(input), 'add valid schedule');
      const before = await store.listDueSchedules({ now, limit: 100 });
      assertOk(before, 'read before invalid writes');
      const work = { id: IDS.work, kind: input.kind, targetKind: input.targetKind, targetId: input.targetId,
        createdAt: now, nextAttemptAt: now };
      const firing = { scheduleId: input.id, expectedNextRunAt: now, nextRunAt: next, now, work };
      for (const invalid of [new Date('-000001-01-01T00:00:00.000Z'), new Date('+010000-01-01T00:00:00.000Z')]) {
        for (const field of ['createdAt', 'nextRunAt', 'lastRunAt'] as const) {
          assertNotOk(await store.addSchedule({ ...input, id: IDS.rejected, [field]: invalid }), `reject add ${field}`);
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
      assertOk(await store.addSchedule({ ...input, id: IDS.rejected }), 'rejected inserts never reserved their id');
    });
  })];
}
