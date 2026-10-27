import { formatInstant, parseInstant, type Schedule, type ScheduleStore } from '@second-brain/core';
import { sql } from 'kysely';
import { describe, type SqliteConnect } from './connect.js';
import { ensureWork } from './work.js';
import { withWrite } from './write.js';

export interface ScheduleRow {
  id: string; kind: string; target_kind: string; target_id: string;
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
    intervalSeconds: row.interval_seconds, nextRunAt: row.next_run_at === null ? null : at(row.next_run_at, 'schedules.next_run_at'),
    lastRunAt: row.last_run_at === null ? null : at(row.last_run_at, 'schedules.last_run_at'), createdAt: at(row.created_at, 'schedules.created_at') };
}
/** All firing writes share one immediate transaction, including the CAS read. */
export function sqliteScheduleStore(connect: SqliteConnect): ScheduleStore {
  return {
    async addSchedule(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          await sql`insert into schedules (id, kind, target_kind, target_id, interval_seconds, next_run_at, last_run_at, created_at)
            values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${input.intervalSeconds},
              ${input.nextRunAt === null ? null : instant(input.nextRunAt)},
              ${input.lastRunAt === null ? null : instant(input.lastRunAt)}, ${instant(input.createdAt)})`.execute(held);
          return structuredClone(input);
        });
        return result.ok ? { ok: true, schedule: result.value } : result;
      } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `예약을 넣을 수 없습니다: ${describe(error)}` }; }
    },
    async listDueSchedules({ now, limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<ScheduleRow>`select * from schedules where next_run_at <= ${instant(now)}
          order by next_run_at, id limit ${limit}`.execute(opened.connection.db);
        return { ok: true, schedules: result.rows.map(rowSchedule) };
      } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `예약을 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async fireSchedule(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          const expected = instant(input.expectedNextRunAt);
          const found = await sql<ScheduleRow>`select * from schedules where id = ${input.scheduleId}
            and next_run_at = ${expected}`.execute(held);
          if (found.rows.length === 0) return { ok: true, fired: false } as const;
          const work = await ensureWork(held, input.work);
          await sql`update schedules set last_run_at = ${instant(input.now)},
            next_run_at = ${input.nextRunAt === null ? null : instant(input.nextRunAt)}
            where id = ${input.scheduleId} and next_run_at = ${expected}`.execute(held);
          return { ok: true, fired: true, created: work.created } as const;
        });
        return result.ok ? result.value : result;
      } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `예약을 발화할 수 없습니다: ${describe(error)}` }; }
    },
  };
}
