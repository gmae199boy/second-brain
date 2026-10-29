import { dailyOccurrenceDates, nextDailyOccurrence } from '../local-time.js';
import type { ReadTimeZone, TimeZoneFailure } from './schedules.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, ScheduleStoreFailure } from '../ports/store.js';

export const SCHEDULE_TICK_LIMIT = 100;
export type ScheduleTickResult = { ok: true; fired: number; enqueued: number } |
  ((ScheduleStoreFailure | TimeZoneFailure) & { fired: number; enqueued: number });

/** Collapse missed occurrences into one firing, timed from this tick. */
export async function tickSchedules({ store, clock, idGen, readTimeZone }: {
  store: ScheduleStore; clock: Clock; idGen: IdGen; readTimeZone: ReadTimeZone;
}): Promise<ScheduleTickResult> {
  const now = clock.now();
  let fired = 0;
  let enqueued = 0;
  const daily = await store.listDailySchedules({ limit: SCHEDULE_TICK_LIMIT });
  if (!daily.ok) return { ...daily, fired, enqueued };
  if (daily.schedules.length) {
    const zone = await readTimeZone();
    if (!zone.ok) return { ...zone, fired, enqueued };
    let schedules = daily.schedules;
    let limit = SCHEDULE_TICK_LIMIT;
    const visited = new Set<string>();
    for (;;) {
      for (const schedule of schedules) {
        if (visited.has(schedule.id)) continue;
        visited.add(schedule.id);
        if (schedule.timeZone === zone.value) continue;
        const rezoned = await store.rezoneSchedule({ id: schedule.id, expectedNextRunAt: schedule.nextRunAt!,
          expectedTimeZone: schedule.timeZone!, timeZone: zone.value,
          nextRunAt: nextDailyOccurrence(schedule.lastRunAt ?? schedule.createdAt, schedule.localTime!, zone.value) });
        if (!rezoned.ok) return { ...rezoned, fired, enqueued };
      }
      if (schedules.length < limit) break;
      // The store returns an id-ordered prefix; widen it before reading due work.
      limit *= 2;
      const remaining = await store.listDailySchedules({ limit });
      if (!remaining.ok) return { ...remaining, fired, enqueued };
      schedules = remaining.schedules;
    }
  }
  const due = await store.listDueSchedules({ now, limit: SCHEDULE_TICK_LIMIT });
  if (!due.ok) return { ...due, fired, enqueued };
  for (const schedule of due.schedules) {
    if (schedule.nextRunAt === null) continue;
    const dates = schedule.localTime === null ? null : dailyOccurrenceDates(schedule.nextRunAt, now, schedule.localTime, schedule.timeZone!);
    if (schedule.localTime !== null && dates === null) {
      const advanced = await store.rezoneSchedule({ id: schedule.id, expectedNextRunAt: schedule.nextRunAt,
        expectedTimeZone: schedule.timeZone!, timeZone: schedule.timeZone!,
        nextRunAt: nextDailyOccurrence(now, schedule.localTime, schedule.timeZone!) });
      if (!advanced.ok) return { ...advanced, fired, enqueued };
      continue;
    }
    const result = await store.fireSchedule({
      ...(dates ? { localDates: { ...dates, timeZone: schedule.timeZone! } } : {}),
      scheduleId: schedule.id, expectedNextRunAt: schedule.nextRunAt,
      nextRunAt: schedule.localTime !== null ? nextDailyOccurrence(now, schedule.localTime, schedule.timeZone!) : schedule.intervalSeconds === null ? null : new Date(now.getTime() + schedule.intervalSeconds * 1000),
      work: { id: idGen.next(), kind: schedule.kind, targetKind: schedule.targetKind,
        targetId: schedule.targetId, holdGroup: schedule.holdGroup, createdAt: now, nextAttemptAt: now }, now,
    });
    if (!result.ok) return { ...result, fired, enqueued };
    if (result.fired) { fired++; if (result.created) enqueued++; }
  }
  return { ok: true, fired, enqueued };
}
