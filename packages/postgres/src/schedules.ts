import { formatInstant, parseInstant, type Schedule, type ScheduleStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { ensureWork } from './work.js';
import { withWrite } from './write.js';

export interface ScheduleRow {
  id: string; kind: string; target_kind: string; target_id: string;
  local_time: string | null; time_zone: string | null;
  interval_seconds: number | null; next_run_at: string | null;
  last_run_at: string | null; created_at: string;
}
function instant(value: Date): string {
  const result = formatInstant(value);
  if (!result.ok) throw new TypeError(result.message);
  return result.value;
}
function at(value: string, column: string): Date {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(`${column}을 읽을 수 없습니다: ${parsed.message}`);
  return parsed.value;
}
function rowSchedule(row: ScheduleRow): Schedule {
  return { id: row.id, kind: row.kind, targetKind: row.target_kind, targetId: row.target_id,
    localTime: row.local_time, timeZone: row.time_zone, intervalSeconds: row.interval_seconds, nextRunAt: row.next_run_at === null ? null : at(row.next_run_at, 'schedules.next_run_at'),
    lastRunAt: row.last_run_at === null ? null : at(row.last_run_at, 'schedules.last_run_at'), createdAt: at(row.created_at, 'schedules.created_at') };
}
/** All firing writes share one transaction, beginning with the schedule CAS. */
export function postgresScheduleStore(connect: PgConnect): ScheduleStore {
  return {
    async addSchedule(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          const inserted = await sql`insert into brain.schedules (id, kind, target_kind, target_id, interval_seconds, next_run_at, last_run_at, created_at, local_time, time_zone)
            values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.intervalSeconds},
              ${input.nextRunAt === null ? null : instant(input.nextRunAt)},
              ${input.lastRunAt === null ? null : instant(input.lastRunAt)}, ${instant(input.createdAt)}, ${input.localTime}, ${input.timeZone})
            on conflict (kind, target_kind, target_id) where local_time is not null do nothing returning id`.execute(held);
          if (!inserted.rows.length) return null;
          return structuredClone(input);
        });
        return result.ok ? result.value === null ? { ok: false, code: 'SCHEDULE_CONFLICT', message: '같은 대상의 매일 예약이 있습니다' } : { ok: true, schedule: result.value } : result;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'schedules_daily_target_unique')
          return { ok: false, code: 'SCHEDULE_CONFLICT', message: '같은 대상의 매일 예약이 있습니다' };
        return databaseFailure(error);
      }
    },
    async listSchedules({ limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<ScheduleRow>`select * from brain.schedules order by created_at, id limit ${limit + 1}`.execute(opened.connection.db);
        return { ok: true, schedules: result.rows.slice(0, limit).map(rowSchedule), hasMore: result.rows.length > limit };
      } catch (error) { return databaseFailure(error); }
    },
    async removeSchedule({ id }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => (await sql`delete from brain.schedules where id = ${id} returning id`.execute(held)).rows.length > 0);
        return result.ok ? { ok: true, removed: result.value } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async readSchedule({ id }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<ScheduleRow>`select * from brain.schedules where id = ${id}`.execute(opened.connection.db);
        return { ok: true, schedule: result.rows[0] ? rowSchedule(result.rows[0]) : null };
      } catch (error) { return databaseFailure(error); }
    },
    async listDailySchedules({ limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<ScheduleRow>`select * from brain.schedules where local_time is not null order by id limit ${limit}`.execute(opened.connection.db);
        return { ok: true, schedules: result.rows.map(rowSchedule) };
      } catch (error) { return databaseFailure(error); }
    },
    async rezoneSchedule(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          const changed = await sql`update brain.schedules set time_zone = ${input.timeZone}, next_run_at = ${instant(input.nextRunAt)}
            where id = ${input.id} and next_run_at = ${instant(input.expectedNextRunAt)} and time_zone = ${input.expectedTimeZone} returning id`.execute(held);
          return changed.rows.length > 0;
        });
        return result.ok ? { ok: true, updated: result.value } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async listScheduleSuccesses({ scheduleId }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{ local_date: string; time_zone: string; work_id: string; recorded_at: string }>`
          select local_date::text, time_zone, work_id, recorded_at from brain.schedule_successes
          where schedule_id = ${scheduleId} order by local_date`.execute(opened.connection.db);
        return { ok: true, successes: result.rows.map(row => ({ localDate: row.local_date, timeZone: row.time_zone, workId: row.work_id, recordedAt: at(row.recorded_at, 'schedule_successes.recorded_at') })) };
      } catch (error) { return databaseFailure(error); }
    },
    async listDueSchedules({ now, limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<ScheduleRow>`select * from brain.schedules where next_run_at <= ${instant(now)}
          order by next_run_at, id limit ${limit}`.execute(opened.connection.db);
        return { ok: true, schedules: result.rows.map(rowSchedule) };
      } catch (error) { return databaseFailure(error); }
    },
    async fireSchedule(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          const expected = instant(input.expectedNextRunAt);
          const now = instant(input.now);
          const next = input.nextRunAt === null ? null : instant(input.nextRunAt);
          // Validate work even when the compare-and-set would lose.
          instant(input.work.createdAt); instant(input.work.nextAttemptAt);
          const updated = await sql`update brain.schedules set last_run_at = ${now}, next_run_at = ${next}
            where id = ${input.scheduleId} and next_run_at = ${expected}
              and time_zone is not distinct from ${input.localDates?.timeZone ?? null} returning id`.execute(held);
          if (updated.rows.length === 0) return { ok: true, fired: false } as const;
          let workInput = input.work;
          if (input.localDates) {
            const missing = await sql<{ local_date: string }>`select to_char(d, 'YYYY-MM-DD') as local_date
              from generate_series(${input.localDates.from}::date, ${input.localDates.to}::date, interval '1 day') d
              where not exists (select 1 from brain.schedule_successes s where s.schedule_id = ${input.scheduleId} and s.local_date = d::date)
              order by d`.execute(held);
            if (!missing.rows.length) return { ok: true, fired: true, created: false, covered: true } as const;
            workInput = { ...input.work, scheduledDates: { scheduleId: input.scheduleId, from: missing.rows[0]!.local_date,
              to: missing.rows[missing.rows.length - 1]!.local_date, timeZone: input.localDates.timeZone } };
          }
          const work = await ensureWork(held, workInput);
          return { ok: true, fired: true, created: work.created, covered: false } as const;
        });
        return result.ok ? result.value : result;
      } catch (error) { return databaseFailure(error); }
    },
  };
}
