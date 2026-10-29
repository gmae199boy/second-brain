import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, WorkStore, ScheduleStoreFailure } from '../ports/store.js';
import { isLocalTime, localDateOf, nextDailyOccurrence } from '../local-time.js';

export type TimeZoneFailure = { ok: false; code: 'CONFIG_INVALID' | 'SCHEMA_MISMATCH' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type ReadTimeZone = () => Promise<{ ok: true; value: string } | TimeZoneFailure>;
export interface SchedulesDependencies { store: ScheduleStore & WorkStore; clock: Clock; idGen: IdGen; readTimeZone: ReadTimeZone }
export interface AddDailyInput { kind: string; targetKind: string; targetId: string; localTime: string }
export type AddDailyResult = Awaited<ReturnType<ScheduleStore['addSchedule']>> | TimeZoneFailure | { ok: false; code: 'SCHEDULE_INVALID'; message: string };
export async function addDaily(deps: SchedulesDependencies, input: AddDailyInput): Promise<AddDailyResult> {
  if (!isLocalTime(input.localTime)) return { ok: false, code: 'SCHEDULE_INVALID', message: '예약 시각은 00:00~23:59의 HH:MM이어야 합니다' };
  const zone = await deps.readTimeZone(); if (!zone.ok) return zone;
  const now = deps.clock.now();
  return deps.store.addSchedule({ ...input, id: deps.idGen.next(), intervalSeconds: null, timeZone: zone.value,
    nextRunAt: nextDailyOccurrence(now, input.localTime, zone.value), lastRunAt: null, createdAt: now });
}
export type RunScheduleResult = { ok: true; workId: string; created: boolean } | ScheduleStoreFailure | TimeZoneFailure |
  { ok: false; code: 'SCHEDULE_NOT_FOUND'; message: string };
export async function runSchedule(deps: SchedulesDependencies, { scheduleId }: { scheduleId: string }): Promise<RunScheduleResult> {
  const read = await deps.store.readSchedule({ id: scheduleId }); if (!read.ok) return read;
  const schedule = read.schedule;
  if (!schedule) return { ok: false, code: 'SCHEDULE_NOT_FOUND', message: '지정한 예약이 없습니다' };
  let scheduledDates;
  const now = deps.clock.now();
  if (schedule.localTime !== null) {
    const zone = await deps.readTimeZone(); if (!zone.ok) return zone;
    const date = localDateOf(now, zone.value);
    scheduledDates = { scheduleId, from: date, to: date, timeZone: zone.value };
  }
  const work = await deps.store.addWork({ id: deps.idGen.next(), kind: schedule.kind, targetKind: schedule.targetKind,
    targetId: schedule.targetId, createdAt: now, nextAttemptAt: now, ...(scheduledDates ? { scheduledDates } : {}) });
  return work.ok ? { ok: true, workId: work.item.id, created: work.created } : work;
}
