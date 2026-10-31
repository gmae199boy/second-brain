import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, WorkStore, ScheduleStoreFailure } from '../ports/store.js';
import { isLocalTime, localDateOf, nextDailyOccurrence } from '../local-time.js';

export type TimeZoneFailure = { ok: false; code: 'CONFIG_INVALID' | 'SCHEMA_MISMATCH' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type ReadTimeZone = () => Promise<{ ok: true; value: string } | TimeZoneFailure>;
export interface SchedulesDependencies { store: ScheduleStore & WorkStore; clock: Clock; idGen: IdGen; readTimeZone: ReadTimeZone }
export interface AddDailyInput { kind: string; targetKind: string; targetId: string; localTime: string; holdGroup?: string | null }
export type AddDailyResult = Awaited<ReturnType<ScheduleStore['addSchedule']>> | TimeZoneFailure | { ok: false; code: 'SCHEDULE_INVALID'; message: string };
export async function addDaily(deps: SchedulesDependencies, input: AddDailyInput): Promise<AddDailyResult> {
  if ([input.kind, input.targetKind, input.targetId].some(value => value.trim() === '')) return { ok: false, code: 'SCHEDULE_INVALID', message: '예약 종류와 대상은 비어 있을 수 없습니다' };
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
    targetId: schedule.targetId, holdGroup: schedule.holdGroup, createdAt: now, nextAttemptAt: now, ...(scheduledDates ? { scheduledDates } : {}) });
  return work.ok ? { ok: true, workId: work.item.id, created: work.created } : work;
}

export const SCHEDULES_LIST_LIMIT = { min: 1, max: 200, default: 100 } as const;
export async function listSchedules({ store }: Pick<SchedulesDependencies, 'store'>, input: { limit?: number } = {}) {
  const limit = input.limit ?? SCHEDULES_LIST_LIMIT.default;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false as const, code: 'USAGE' as const, message: '목록 한도는 1~200 정수여야 합니다' };
  const read = await store.listSchedules({ limit });
  return read.ok ? { ...read, count: read.schedules.length } : read;
}
export async function removeSchedule({ store }: Pick<SchedulesDependencies, 'store'>, input: { id: string }) {
  const read = await store.removeSchedule(input);
  if (!read.ok) return read;
  return read.removed ? { ok: true as const, id: input.id } : { ok: false as const, code: 'SCHEDULE_NOT_FOUND' as const, message: '지정한 예약이 없습니다' };
}

/** 동일 키의 기존 예약이 실제 설정과 같을 때만 재사용한다. */
export async function ensureDaily(deps: Pick<SchedulesDependencies, 'store' | 'clock' | 'idGen' | 'readTimeZone'>, input: AddDailyInput): Promise<AddDailyResult> {
  const zone = await deps.readTimeZone(); if (!zone.ok) return zone;
  const read = async () => deps.store.findDailySchedule(input);
  const existing = await read(); if (!existing.ok) return existing;
  const matches = (schedule: import('../domain/schedule.js').Schedule) => schedule.localTime === input.localTime && schedule.timeZone === zone.value && schedule.intervalSeconds === null && schedule.holdGroup === (input.kind.includes('.') ? `extension:${input.kind.split('.')[0]}` : input.holdGroup ?? null);
  if (existing.schedule) return matches(existing.schedule) ? { ok: true, schedule: existing.schedule } : { ok: false, code: 'SCHEDULE_CONFLICT', message: '같은 대상에 다른 설정의 예약이 있습니다' };
  const added = await addDaily({ ...deps, readTimeZone: async () => zone }, input);
  if (!added.ok && added.code !== 'SCHEDULE_CONFLICT') return added;
  const raced = await read(); if (!raced.ok) return raced;
  return raced.schedule && matches(raced.schedule) ? { ok: true, schedule: raced.schedule } : { ok: false, code: 'SCHEDULE_CONFLICT', message: '등록된 예약 설정이 일치하지 않습니다' };
}
