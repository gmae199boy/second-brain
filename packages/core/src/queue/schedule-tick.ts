import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, ScheduleStoreFailure } from '../ports/store.js';

export const SCHEDULE_TICK_LIMIT = 100;
export type ScheduleTickResult = { ok: true; fired: number; enqueued: number } |
  (ScheduleStoreFailure & { fired: number; enqueued: number });

/** Collapse missed occurrences into one firing, timed from this tick. */
export async function tickSchedules({ store, clock, idGen }: {
  store: ScheduleStore; clock: Clock; idGen: IdGen;
}): Promise<ScheduleTickResult> {
  const now = clock.now();
  let fired = 0;
  let enqueued = 0;
  const due = await store.listDueSchedules({ now, limit: SCHEDULE_TICK_LIMIT });
  if (!due.ok) return { ...due, fired, enqueued };
  for (const schedule of due.schedules) {
    if (schedule.nextRunAt === null) continue;
    const result = await store.fireSchedule({
      scheduleId: schedule.id, expectedNextRunAt: schedule.nextRunAt,
      nextRunAt: schedule.intervalSeconds === null ? null : new Date(now.getTime() + schedule.intervalSeconds * 1000),
      work: { id: idGen.next(), kind: schedule.kind, targetKind: schedule.targetKind,
        targetId: schedule.targetId, createdAt: now, nextAttemptAt: now }, now,
    });
    if (!result.ok) return { ...result, fired, enqueued };
    if (result.fired) { fired++; if (result.created) enqueued++; }
  }
  return { ok: true, fired, enqueued };
}
