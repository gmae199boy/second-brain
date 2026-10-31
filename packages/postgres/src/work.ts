import { attemptUsage } from '@second-brain/core';
import {
  formatInstant,
  dependencyFailedText,
  TABLE_CLEANUP_KIND,
  TABLE_TARGET_KIND,
  FAILURE_MESSAGE_MAX_BYTES,
  truncateUtf8,
  parseInstant,
  workKindPolicy,
  workExecutionClass,
  workHoldGroup,
  type AddWorkInput,
  type AddWorkResult,
  type ClaimWorkInput,
  type ClaimWorkResult,
  type CompleteWorkInput,
  type DueWorkQuery,
  type FailureRecord,
  type FinishWorkInput,
  type FinishWorkResult,
  type HasDueWorkResult,
  type ListFailuresQuery,
  type ListFailuresResult,
  type ListOpenWorkTargetsResult,
  type RecordFailureInput,
  type RecordFailureResult,
  type ResolveFailuresInput,
  type ResolveFailuresResult,
  type RetryWorkInput,
  type WorkItem,
  type WorkStore,
} from '@second-brain/core';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { databaseFailure, describe, type PgConnect, type PgSchema } from './connect.js';
import { withWrite } from './write.js';
import { pgText } from './text.js';

export interface WorkItemRow {
  schedule_id: string | null;
  local_date_from: string | null; local_date_to: string | null; local_time_zone: string | null;
  claimed_date_from: string | null; claimed_date_to: string | null;
  id: string;
  kind: string;
  execution_class: 'core' | 'supervised';
  current_attempt_token: string | null;
  serialization_key: string | null;
  hold_group: string | null;
  target_kind: string;
  target_id: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claimed_by: string | null;
  last_error: string | null;
  completed_at: string | null;
  outcome: WorkItem['outcome'];
  cancel_requested_at: string | null;
}

/** Shared group predicate for claims and schedule firing. */
export function groupAvailable(table: string): RawBuilder<boolean> {
  return sql<boolean>`not exists (select 1 from brain.work_hold_groups g where g.name = ${sql.ref(table + '.hold_group')})`;
}

/** A retained supervised token holds the key even after its lease expires. */
function keyAvailable(now: string): RawBuilder<boolean> {
  return sql<boolean>`(brain.work_items.serialization_key is null or not exists (
    select 1 from brain.work_items h
    where h.serialization_key = brain.work_items.serialization_key and h.id <> brain.work_items.id
      and h.completed_at is null
      and (h.current_attempt_token is not null or (h.claimed_by is not null and h.claim_expires_at > ${now}::timestamptz))
  ))`;
}

async function lockAvailableKey(held: Kysely<PgSchema>, row: WorkItemRow, now: string): Promise<boolean> {
  if (row.serialization_key === null) return true;
  await sql`savepoint work_key`.execute(held);
  await sql`select pg_advisory_xact_lock(hashtextextended(${'work-key:' + row.serialization_key}, 0))`.execute(held);
  // Separate statement is essential: a claimant that waited sees the prior commit.
  const checked = await sql<{ available: boolean }>`select ${keyAvailable(now)} as available
    from brain.work_items where id = ${row.id}`.execute(held);
  const available = checked.rows[0]!.available;
  // Discarded keys must not stay locked while the claim loop tries another key.
  if (!available) await sql`rollback to savepoint work_key`.execute(held);
  await sql`release savepoint work_key`.execute(held);
  return available;
}

/** Shared due predicate and order; only the claiming caller adds row locking. */
export function claimCandidateQuery(query: DueWorkQuery): RawBuilder<WorkItemRow> {
  const now = instant(query.now, 'work_items.next_attempt_at');
  return sql<WorkItemRow>`
    select id, kind, execution_class, current_attempt_token, serialization_key, hold_group, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at, outcome, cancel_requested_at, schedule_id, local_time_zone,
           local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text
      from brain.work_items
     where completed_at is null
       and not exists (
         select 1 from brain.work_dependencies d join brain.work_items p on p.id = d.prerequisite_id
          where d.work_item_id = brain.work_items.id
            and (p.completed_at is null or p.outcome is distinct from 'succeeded')
       )
       and ${keyAvailable(now)} and ${groupAvailable('brain.work_items')}
       and execution_class = 'core'
       and next_attempt_at <= ${now}
       and (claim_expires_at is null or claim_expires_at <= ${now})
       and kind = any(${[...query.kinds]}::text[])
  order by attempts asc, id asc
     limit 1
  `;
}

/** Find-or-create also used inside session creation and schedule firing. */
export async function ensureWork(held: Kysely<PgSchema>, input: AddWorkInput) {
  const createdAt = instant(input.createdAt, 'work_items.created_at');
  const nextAttemptAt = instant(input.nextAttemptAt, 'work_items.next_attempt_at');
  for (;;) {
    const inserted = await sql<WorkItemRow>`
      insert into brain.work_items (id, kind, execution_class, serialization_key, hold_group, target_kind, target_id, created_at, attempts, next_attempt_at, schedule_id, local_date_from, local_date_to, local_time_zone)
      values (${input.id}, ${input.kind}, (case when exists (select 1 from brain.extension_work_kinds where kind=${input.kind}) then 'supervised' else ${workExecutionClass(input.kind)} end), ${input.serializationKey ?? null}, ${workHoldGroup(input.kind, input.holdGroup)}, ${input.targetKind}, ${input.targetId}, ${createdAt}, 0, ${nextAttemptAt}, ${input.scheduledDates?.scheduleId ?? null}, ${input.scheduledDates?.from ?? null}, ${input.scheduledDates?.to ?? null}, ${input.scheduledDates?.timeZone ?? null})
      on conflict (kind, target_kind, target_id) where completed_at is null do nothing returning *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text
    `.execute(held);
    const row = inserted.rows[0];
    if (row !== undefined) return { created: true, row };
    const existing = await readOpenWork(held, input);
    if (existing !== null) {
      if (!input.scheduledDates) return { created: false, row: existing };
      const dates = input.scheduledDates;
      const merged = await sql<WorkItemRow>`update brain.work_items set
        local_date_from = least(local_date_from, ${dates.from}::date), local_date_to = greatest(local_date_to, ${dates.to}::date),
        local_time_zone = coalesce(local_time_zone, ${dates.timeZone}), schedule_id = coalesce(schedule_id, ${dates.scheduleId}::uuid)
        where id = ${existing.id} and completed_at is null
        returning *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text`.execute(held);
      if (merged.rows[0]) return { created: false, row: merged.rows[0] };
    }
    // A drain completed the conflicting row between these statements. At READ
    // COMMITTED the next insert can create its replacement using a fresh snapshot.
  }
}

export function postgresWorkStore(connect: PgConnect): WorkStore {
  return {
    async holdWorkGroup({ group, now }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => (await sql`insert into brain.work_hold_groups (name, held_at)
          values (${group}, ${instant(now, 'work_hold_groups.held_at')}) on conflict (name) do nothing returning name`.execute(held)).rows.length > 0);
        return result.ok ? { ok: true, held: result.value } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async releaseWorkGroup({ group }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await withWrite(opened.connection, async held => {
          const registry = await sql<{ enabled: boolean }>`select enabled from brain.extensions where 'extension:' || name = ${group} for update`.execute(held);
          if (registry.rows[0]?.enabled === false) return false;
          return (await sql`delete from brain.work_hold_groups where name = ${group} returning name`.execute(held)).rows.length > 0;
        });
        return result.ok ? { ok: true, released: result.value } : result;
      } catch (error) { return databaseFailure(error); }
    },
    async addWork(input: AddWorkInput): Promise<AddWorkResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      let written;
      try {
        written = await withWrite(opened.connection, (held) => ensureWork(held, input));
      } catch (error) {
        return {
          ...databaseFailure(error), message: `일감을 넣을 수 없습니다: ${describe(error)}`,
        };
      }
      if (!written.ok) return written;
      const { created, row } = written.value;
      if (row === null) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `${input.kind} 일감을 넣은 뒤에도 그 행을 읽을 수 없습니다`,
        };
      }
      return { ok: true, created, item: toWorkItem(row) };
    },

    async addWorkGraph({ nodes }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const written = await withWrite(opened.connection, async held => {
          const items: { created: boolean; item: WorkItem }[] = [];
          for (const node of nodes) {
            const { created, row } = await ensureWork(held, node);
            if (created) for (const index of new Set(node.after)) {
              await sql`insert into brain.work_dependencies (work_item_id, prerequisite_id)
                values (${row.id}, ${items[index]!.item.id})`.execute(held);
            }
            items.push({ created, item: toWorkItem(row) });
          }
          return items;
        });
        return written.ok ? { ok: true, items: written.value } : written;
      } catch (error) { return { ...databaseFailure(error), message: `일감 그래프를 넣을 수 없습니다: ${describe(error)}` }; }
    },

    async hasDueWork(query: DueWorkQuery): Promise<HasDueWorkResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      if (query.kinds.length === 0) return { ok: true, due: false };

      try {
        const found = await claimCandidateQuery(query).execute(opened.connection.db);
        return { ok: true, due: found.rows.length > 0 };
      } catch (error) {
        return {
          ...databaseFailure(error), message: `할 일이 있는지 볼 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async claimWork(input: ClaimWorkInput): Promise<ClaimWorkResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }
      if (input.kinds.length === 0) return { ok: true, item: null };
      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          const now = instant(input.now, 'work_items.claimed_at');
          for (;;) {
            const found = await sql<WorkItemRow>`${claimCandidateQuery(input)} for update skip locked`.execute(held);
            const candidate = found.rows[0];
            if (candidate === undefined) return null;
            if (!await lockAvailableKey(held, candidate, now)) continue;
            const expiresAt = instant(
              new Date(input.now.getTime() + workKindPolicy(candidate.kind).claimForMs),
              'work_items.claim_expires_at',
            );

            await sql`
              update brain.work_items
                 set attempts = attempts + 1,
                     claimed_at = ${now},
                     claim_expires_at = ${expiresAt},
                     claimed_by = ${input.claimedBy},
                     claimed_date_from = local_date_from, claimed_date_to = local_date_to
               where id = ${candidate.id}
            `.execute(held);
            return {
              ...candidate,
              attempts: candidate.attempts + 1,
              claimed_at: now,
              claim_expires_at: expiresAt,
              claimed_by: input.claimedBy,
            };
          }
        });
      } catch (error) {
        return {
          ...databaseFailure(error), message: `일감을 청구할 수 없습니다: ${describe(error)}`,
        };
      }
      if (!written.ok) return written;
      const row = written.value;
      return { ok: true, item: row === null ? null : toWorkItem(row) };
    },

    async requestWorkCancel(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const written = await withWrite(opened.connection, async held => {
          const found = await sql<WorkItemRow>`select *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text from brain.work_items where id = ${input.id} for update`.execute(held);
          const item = found.rows[0];
          if (!item) return 'not_found' as const;
          if (item.completed_at !== null) return 'already_closed' as const;
          const now = instant(input.now, 'work_items.cancel_requested_at');
          if (item.current_attempt_token !== null) {
            await sql`update brain.work_items set cancel_requested_at = coalesce(cancel_requested_at, ${now}::timestamptz) where id = ${input.id}`.execute(held);
            return 'requested' as const;
          }
          await sql`update brain.work_items set cancel_requested_at = ${now}, completed_at = ${now}, outcome = 'cancelled',
            claimed_at = null, claim_expires_at = null, claimed_by = null where id = ${input.id}`.execute(held);
          await closeDependents(held, input.id, 'cancelled', now);
          return 'cancelled' as const;
        });
        return written.ok ? { ok: true, state: written.value } : written;
      } catch (error) { return { ...databaseFailure(error), message: `취소를 요청할 수 없습니다: ${describe(error)}` }; }
    },
    async recordSupervisedProcess(input) {
      return finish(connect, async held => {
        if (!await lockOpenSupervisedWork(held, input)) return 0;
        await sql`update brain.work_attempts set pid = ${input.pid}, pgid = ${input.pgid},
          os_boot_at = ${input.osBootAt === null ? null : instant(input.osBootAt, 'work_attempts.os_boot_at')},
          os_started_at = ${input.osStartedAt === null ? null : instant(input.osStartedAt, 'work_attempts.os_started_at')}
          where token = ${input.attemptToken}`.execute(held);
        return 1;
      });
    },
    async listOpenSupervisedAttempts() {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = await sql<{ token: string; work_item_id: string; kind: string; attempts: number; target_kind: string; target_id: string; incarnation: string | null;
          pid: number | null; pgid: number | null; os_boot_at: string | null; os_started_at: string | null; cancel_requested: boolean; held: boolean }>`
          select a.*, w.kind, w.attempts, w.target_kind, w.target_id, w.cancel_requested_at is not null as cancel_requested, not (${groupAvailable('w')}) as held
          from brain.work_attempts a join brain.work_items w on w.current_attempt_token = a.token
          where a.outcome is null or (w.kind='channel_send' and a.outcome='unknown')`.execute(opened.connection.db);
        return { ok: true, attempts: rows.rows.map(a => ({ token: a.token, workItemId: a.work_item_id, kind: a.kind, attempts: a.attempts, targetKind: a.target_kind, targetId: a.target_id,
          incarnation: a.incarnation, pid: a.pid, pgid: a.pgid, osBootAt: a.os_boot_at === null ? null : at(a.os_boot_at, 'work_attempts.os_boot_at'),
          osStartedAt: a.os_started_at === null ? null : at(a.os_started_at, 'work_attempts.os_started_at'), held: a.held, cancelRequested: a.cancel_requested })) };
      } catch (error) { return { ...databaseFailure(error), message: `열린 시도를 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async settleSupervisedAttempt(input) {
      return finish(connect, async held => {
        const item = await lockConfirmedChannelWork(held, input);
        if (!item) return 0;
        const now = instant(input.now, 'work_attempts.finished_at');
        const outcome = input.outcome === 'unknown' ? 'unknown' : item.cancel_requested_at !== null ? 'cancelled' : input.outcome;
        await sql`update brain.work_attempts set outcome = ${outcome}, finished_at = ${now}, elapsed_ms = ${input.elapsedMs ?? null}, stderr = ${input.stderr ?? null} where token = ${input.attemptToken}`.execute(held);
        if (input.outcome === 'unknown') return 1;
        await sql`update brain.work_items set current_attempt_token = null, claimed_at = null, claim_expires_at = null, claimed_by = null,
          completed_at = case when cancel_requested_at is not null then ${now}::timestamptz else completed_at end,
          outcome = case when cancel_requested_at is not null then 'cancelled' else outcome end,
          attempts = case when cancel_requested_at is null and ${input.outcome} = 'cancelled' then greatest(0, attempts - 1) else attempts end,
          next_attempt_at = case when cancel_requested_at is null and ${input.outcome} = 'died' then ${now}::timestamptz else next_attempt_at end
          where id = ${input.id}`.execute(held);
        if (item.cancel_requested_at !== null) await closeDependents(held, input.id, 'cancelled', now);
        return 1;
      });
    },
    async claimSupervisedWork(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const written = await withWrite(opened.connection, async (held) => {
          const now = instant(input.now, 'work_items.claimed_at');
          for (;;) {
            const found = await sql<WorkItemRow>`select *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text from brain.work_items
              where execution_class = 'supervised' and completed_at is null
                and not exists (
                  select 1 from brain.work_dependencies d join brain.work_items p on p.id = d.prerequisite_id
                   where d.work_item_id = brain.work_items.id
                     and (p.completed_at is null or p.outcome is distinct from 'succeeded')
                )
                and ${keyAvailable(now)} and ${groupAvailable('brain.work_items')}
                and current_attempt_token is null and cancel_requested_at is null
                and next_attempt_at <= ${now} and (claim_expires_at is null or claim_expires_at <= ${now})
                and kind = any(${[...input.kinds]}::text[])
              order by attempts, id limit 1 for update skip locked`.execute(held);
            const candidate = found.rows[0];
            if (!candidate) return null;
            if (!await lockAvailableKey(held, candidate, now)) continue;
            await sql`insert into brain.work_attempts (token, work_item_id, started_at, incarnation)
              values (${input.attemptToken}, ${candidate.id}, ${now}, ${input.claimedBy})`.execute(held);
            const expires = instant(new Date(input.now.getTime() + workKindPolicy(candidate.kind).claimForMs), 'work_items.claim_expires_at');
            const changed = await sql<WorkItemRow>`update brain.work_items set attempts = attempts + 1,
              claimed_at = ${now}, claim_expires_at = ${expires}, claimed_by = ${input.claimedBy},
              current_attempt_token = ${input.attemptToken}, claimed_date_from = local_date_from, claimed_date_to = local_date_to where id = ${candidate.id} returning *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text`.execute(held);
            return toWorkItem(changed.rows[0]!);
          }
        });
        if (!written.ok) return written;
        return { ok: true, item: written.value, attemptToken: written.value === null ? null : input.attemptToken };
      } catch (error) { return { ...databaseFailure(error), message: `감독 일감을 청구할 수 없습니다: ${describe(error)}` }; }
    },
    async getWork(id) {
      const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<WorkItemRow & { attempt: Record<string, unknown> | null }>`select i.*, i.local_date_from::text, i.local_date_to::text, i.claimed_date_from::text, i.claimed_date_to::text, row_to_json(a) as attempt
          from brain.work_items i left join lateral (select * from brain.work_attempts a where a.work_item_id = i.id order by started_at desc, token desc limit 1) a on true where i.id = ${id}::uuid`.execute(opened.connection.db);
        const row = result.rows[0]; return { ok: true, entry: row ? { item: toWorkItem(row), latestAttempt: row.attempt === null ? null : listAttempt(row.attempt) } : null };
      } catch (error) { return databaseFailure(error); }
    },
    async listWork({ includeClosed, kind, limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<WorkItemRow & { held: boolean; attempt: Record<string, unknown> | null; current_attempt: Record<string, unknown> | null }>`select i.*, i.local_date_from::text, i.local_date_to::text, i.claimed_date_from::text, i.claimed_date_to::text, row_to_json(a) as attempt, row_to_json(c) as current_attempt, not (${groupAvailable('i')}) as held
          from brain.work_items i left join lateral (select * from brain.work_attempts a where a.work_item_id = i.id order by started_at desc, token desc limit 1) a on true
          left join brain.work_attempts c on c.work_item_id = i.id and c.token = i.current_attempt_token
          where (${includeClosed} or i.completed_at is null) and (${kind ?? null}::text is null or i.kind = ${kind ?? null})
          order by i.created_at desc, i.id desc limit ${limit + 1}`.execute(opened.connection.db);
        return { ok: true, entries: result.rows.slice(0, limit).map(row => ({ held: row.held, item: toWorkItem(row), latestAttempt: row.attempt === null ? null : listAttempt(row.attempt), currentAttempt: row.current_attempt === null ? null : listAttempt(row.current_attempt) })), hasMore: result.rows.length > limit };
      } catch (error) { return databaseFailure(error); }
    },
    async readModelWorkUsage({ kinds }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const sums = await sql<{ input: string; cached: string; output: string; elapsed: string }>`select coalesce(sum(a.input_tokens),0)::text as input,
          coalesce(sum(a.cached_input_tokens),0)::text as cached, coalesce(sum(a.output_tokens),0)::text as output, coalesce(sum(a.elapsed_ms),0)::text as elapsed
          from brain.work_attempts a join brain.work_items i on i.id = a.work_item_id where i.kind = any(${[...kinds]}::text[])`.execute(opened.connection.db);
        const rows = await sql<{ kind: string; attempt: Record<string, unknown> }>`select i.kind, row_to_json(a) as attempt
          from brain.work_attempts a join brain.work_items i on i.id = a.work_item_id where i.kind = any(${[...kinds]}::text[])
          order by a.started_at desc, a.token desc limit 1`.execute(opened.connection.db);
        const sum = sums.rows[0]!; const row = rows.rows[0]; const attempt = row ? listAttempt(row.attempt) : null;
        return { ok: true, usage: { inputTokens: Number(sum.input), cachedInputTokens: Number(sum.cached), outputTokens: Number(sum.output), elapsedMs: Number(sum.elapsed),
          latest: attempt && row ? { workItemId: attempt.workItemId, kind: row.kind, at: attempt.startedAt, elapsedMs: attempt.elapsedMs, usage: attemptUsage(attempt) } : null } };
      } catch (error) { return databaseFailure(error); }
    },
    async readWorkAttemptHealth() {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{ id: string; kind: string; current_attempt_token: string | null; token: string; outcome: string | null; at: string; error_code: string | null; error_retryable: boolean | null; last_error: string | null }>`
          select * from (
            select distinct on (i.id) i.id, i.kind, i.current_attempt_token, i.last_error,
              a.token, a.outcome, coalesce(a.finished_at, a.started_at) as at, a.error_code, a.error_retryable
            from brain.work_items i join brain.work_attempts a on a.work_item_id = i.id
            where i.completed_at is null
            order by i.id, a.started_at desc, a.token desc
          ) latest where outcome in ('stalled', 'died', 'failed') or (outcome = 'unknown' and current_attempt_token = token)
          order by at desc, id desc
        `.execute(opened.connection.db);
        const health: Extract<Awaited<ReturnType<WorkStore['readWorkAttemptHealth']>>, { ok: true }>['health'] = {
          stalled: { count: 0, latest: null }, died: { count: 0, latest: null }, unknown: { count: 0, latest: null }, failed: { count: 0, latest: null },
        };
        for (const row of result.rows) {
          const group = health[row.outcome as keyof typeof health];
          group.count++;
          group.latest ??= { workItemId: row.id, kind: row.kind, at: at(row.at, 'work_attempts.finished_at'), errorCode: row.error_code, errorRetryable: row.error_retryable, lastError: row.last_error };
        }
        return { ok: true, health };
      } catch (error) { return { ...databaseFailure(error), message: `일감 시도 상태를 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async renewSupervisedLease(input) {
      return finish(connect, async (held) => {
        const item = await lockOpenSupervisedWork(held, input);
        if (!item) return 0;
        const expires = instant(new Date(input.now.getTime() + workKindPolicy(item.kind).claimForMs), 'work_items.claim_expires_at');
        await sql`update brain.work_items set claim_expires_at = ${expires} where id = ${input.id}`.execute(held);
        await sql`update brain.work_attempts set last_progress_at = coalesce(${input.progressAt === null ? null : instant(input.progressAt, 'work_attempts.last_progress_at')}::timestamptz, last_progress_at),
          renewed_at = ${instant(input.now, 'work_attempts.renewed_at')} where token = ${input.attemptToken}`.execute(held);
        return 1;
      });
    },
    async finishSupervisedWork(input) {
      return finish(connect, async (held) => {
        const item = await lockConfirmedChannelWork(held, input);
        if (!item) return 0;
        const failure = input.outcome !== 'succeeded' && item.cancel_requested_at === null ? input.failure : undefined;
        const now = instant(input.now, 'work_attempts.finished_at');
        const next = input.nextAttemptAt === undefined ? now : instant(input.nextAttemptAt, 'work_items.next_attempt_at');
        const changed = await sql`update brain.work_items set current_attempt_token = null,
          claimed_at = null, claim_expires_at = null, claimed_by = null,
          completed_at = case when ${input.outcome} = 'succeeded' or cancel_requested_at is not null or ${failure !== undefined} then ${now}::timestamptz else null end,
          outcome = case when ${input.outcome} = 'succeeded' then 'succeeded' when cancel_requested_at is not null then 'cancelled' when ${failure !== undefined} then 'failed' else null end,
          next_attempt_at = case when ${input.outcome} <> 'succeeded' then ${next}::timestamptz else next_attempt_at end,
          last_error = case when ${input.outcome} <> 'succeeded' then ${input.lastError === undefined && failure === undefined ? null : encodedFailure(input.lastError ?? failure!.message)} else last_error end
          where id = ${input.id} and current_attempt_token = ${input.attemptToken}`.execute(held);
        if (changesOf(changed) === 0) return 0;
        if (input.outcome === 'succeeded') {
          await settleScheduledSuccess(held, input.id, now);
          if (item.kind === 'channel_send') await sql`update brain.failures set resolved_at=${now} where target_kind=${item.target_kind} and target_id=${item.target_id} and stage='channel_send' and resolved_at is null`.execute(held);
        }
        if (input.outcome !== 'succeeded' && (item.cancel_requested_at !== null || failure !== undefined))
          await closeDependents(held, input.id, item.cancel_requested_at !== null ? 'cancelled' : 'failed', now);
        if (failure !== undefined) {
          const occurredAt = instant(failure.occurredAt, 'failures.occurred_at');
          await sql`insert into brain.failures (id, target_kind, target_id, stage, fingerprint, harness, session_id, code, message, occurred_at, first_occurred_at, occurrences)
            values (${failure.id}, ${item.target_kind}, ${item.target_id}, ${failure.stage}, ${failure.fingerprint}, null, null, ${failure.code}, ${encodedFailure(failure.message)}, ${occurredAt}, ${occurredAt}, 1)
            on conflict (target_kind, target_id, stage, fingerprint) do update set occurred_at = excluded.occurred_at,
              message = excluded.message, resolved_at = null, occurrences = brain.failures.occurrences + 1`.execute(held);
        }
        await sql`update brain.work_attempts set finished_at = ${now}, outcome = ${input.outcome},
          error_code = ${input.errorCode ?? null}, error_retryable = ${input.errorRetryable ?? null},
          input_tokens = ${input.usage?.inputTokens ?? null}, cached_input_tokens = ${input.usage?.cachedInputTokens ?? null}, output_tokens = ${input.usage?.outputTokens ?? null},
          elapsed_ms = ${input.elapsedMs ?? null}, stderr = ${input.stderr ?? null}
          where token = ${input.attemptToken}`.execute(held);
        return 1;
      });
    },

    async completeWork(input: CompleteWorkInput): Promise<FinishWorkResult> {
      return finish(connect, async (held) => {
        const now = instant(input.now, 'work_items.completed_at');
        const completed = await sql<{ kind: string; target_kind: string; target_id: string }>`
          update brain.work_items
             set completed_at = ${now}, outcome = 'succeeded',
                 claimed_at = null, claim_expires_at = null, claimed_by = null
           where id = ${input.id} and claimed_by = ${input.claimedBy} and completed_at is null
           returning kind, target_kind, target_id
        `.execute(held);
        const row = completed.rows[0];
        if (row === undefined) return 0;
        await settleScheduledSuccess(held, input.id, now);
        if (row.kind === TABLE_CLEANUP_KIND && row.target_kind === TABLE_TARGET_KIND) {
          // Only the winning claim can settle failures, in the same transaction
          // as completion. A refused failure update leaves this work open.
          await sql`update brain.failures set resolved_at = ${now}
            where target_kind = ${row.target_kind} and target_id = ${row.target_id}
              and stage = ${TABLE_CLEANUP_KIND} and resolved_at is null`.execute(held);
        }
        return 1;
      });
    },

    async retryWork(input: RetryWorkInput): Promise<FinishWorkResult> {
      return finish(connect, async (held) => {
        const nextAttemptAt = instant(input.nextAttemptAt, 'work_items.next_attempt_at');
        return changesOf(
          await sql`
            update brain.work_items
               set next_attempt_at = ${nextAttemptAt},
                   last_error = ${encodedFailure(input.lastError)},
                   claimed_at = null, claim_expires_at = null, claimed_by = null
             where id = ${input.id} and claimed_by = ${input.claimedBy}
          `.execute(held),
        );
      });
    },

    async releaseWork(input: FinishWorkInput): Promise<FinishWorkResult> {
      return finish(connect, async (held) => {
        return changesOf(
          await sql`
            update brain.work_items
               set attempts = greatest(0, attempts - 1),
                   claimed_at = null, claim_expires_at = null, claimed_by = null
             where id = ${input.id} and claimed_by = ${input.claimedBy}
          `.execute(held),
        );
      });
    },

    async recordFailure(input: RecordFailureInput): Promise<RecordFailureResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const closing = input.closeWork;
      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          const occurredAt = instant(input.occurredAt, 'failures.occurred_at');
          const closedAt = closing === undefined ? null : instant(closing.now, 'work_items.completed_at');
          if (closing !== undefined) {
            const closed = changesOf(
              await sql`
                update brain.work_items
                   set completed_at = ${closedAt}, outcome = 'failed',
                       last_error = ${encodedFailure(input.message)},
                       claimed_at = null, claim_expires_at = null, claimed_by = null
                 where id = ${closing.id} and claimed_by = ${closing.claimedBy}
              `.execute(held),
            );
            if (closed === 0) return null;
            await closeDependents(held, closing.id, 'failed', closedAt!);
          }

          // The claim CAS precedes the failure upsert, so a lost worker writes nothing.
          const recorded = await sql<{ id: string; created: boolean }>`
            insert into brain.failures (id, target_kind, target_id, stage, fingerprint, harness,
                                  session_id, code, message, occurred_at,
                                  first_occurred_at, occurrences)
                 values (${input.id}, ${input.targetKind}, ${input.targetId}, ${input.stage},
                         ${input.fingerprint}, ${input.harness}, ${input.sessionId},
                         ${input.code}, ${encodedFailure(input.message)}, ${occurredAt},
                         ${occurredAt}, 1)
            on conflict (target_kind, target_id, stage, fingerprint)
              do update set occurred_at = excluded.occurred_at,
                            message = excluded.message,
                            resolved_at = null,
                            occurrences = brain.failures.occurrences + 1
            returning id, (xmax = 0) as created
          `.execute(held);
          return { created: recorded.rows[0]!.created, failureId: recorded.rows[0]!.id };
        });
      } catch (error) {
        return {
          ...databaseFailure(error), message: `실패를 기록할 수 없습니다: ${describe(error)}`,
        };
      }
      if (!written.ok) return written;
      const recorded = written.value;

      if (recorded === null) return { ok: true, outcome: 'lost' };
      const { created, failureId } = recorded;
      if (failureId === null) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: '실패를 넣은 뒤에도 그 행을 읽을 수 없습니다',
        };
      }
      return { ok: true, outcome: 'recorded', created, failureId };
    },

    async listOpenWorkTargets(query: { kind: string }): Promise<ListOpenWorkTargetsResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }
      try {
        const found = await sql<{ target_kind: string; target_id: string }>`
          select target_kind, target_id
            from brain.work_items
           where kind = ${query.kind} and completed_at is null
        `.execute(opened.connection.db);
        return {
          ok: true,
          targets: found.rows.map((row) => ({
            targetKind: row.target_kind,
            targetId: row.target_id,
          })),
        };
      } catch (error) {
        return {
          ...databaseFailure(error), message: `열린 일감을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async listFailures(query: ListFailuresQuery): Promise<ListFailuresResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const includeResolved = query.includeResolved === true ? 1 : 0;
      const targetKind = query.targetKind ?? null;
      const stage = query.stage ?? null;
      const limit = query.limit ?? null;
      try {
        const found = await sql<FailureRow>`
          select id, target_kind, target_id, stage, fingerprint, harness, session_id,
                 code, message, occurred_at, resolved_at, first_occurred_at, occurrences
            from brain.failures
           where (${includeResolved} = 1 or resolved_at is null)
             and (${targetKind}::text is null or target_kind = ${targetKind})
             and (${stage}::text is null or stage = ${stage})
        order by occurred_at desc, id desc
           limit ${limit}
        `.execute(opened.connection.db);
        return { ok: true, failures: found.rows.map(toFailure) };
      } catch (error) {
        return {
          ...databaseFailure(error), message: `실패를 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async resolveFailures(input: ResolveFailuresInput): Promise<ResolveFailuresResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      let written;
      try {
        written = await withWrite(opened.connection, async (held) =>
          changesOf(
            await sql`
              update brain.failures
                 set resolved_at = ${instant(input.now, 'failures.resolved_at')}
               where target_kind = ${input.targetKind} and target_id = ${input.targetId}
                 and stage = ${input.stage} and resolved_at is null
            `.execute(held),
          ),
        );
      } catch (error) {
        return {
          ...databaseFailure(error), message: `실패를 해결로 표시할 수 없습니다: ${describe(error)}`,
        };
      }
      if (!written.ok) return written;
      return { ok: true, resolved: written.value };
    },
  };
}

interface FailureRow {
  id: string;
  target_kind: string;
  target_id: string;
  stage: string;
  fingerprint: string;
  harness: string | null;
  session_id: string | null;
  code: string;
  message: string;
  occurred_at: string;
  resolved_at: string | null;
  first_occurred_at: string;
  occurrences: number;
}

function toFailure(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    stage: row.stage,
    fingerprint: row.fingerprint,
    harness: row.harness,
    sessionId: row.session_id,
    code: row.code,
    message: row.message,
    occurredAt: at(row.occurred_at, 'failures.occurred_at'),
    resolvedAt: row.resolved_at === null ? null : at(row.resolved_at, 'failures.resolved_at'),
    firstOccurredAt: at(row.first_occurred_at, 'failures.first_occurred_at'),
    occurrences: row.occurrences,
  };
}

/** Lock the owner first, then read attempt state in a fresh statement snapshot. */
/** 미확인 상태였던 채널 시도는 종료 확인 뒤 한 트랜잭션에서 복구·정산한다. */
async function lockConfirmedChannelWork(held: Kysely<PgSchema>, input: { id: string; attemptToken: string; now: Date; confirmedDead?: boolean }): Promise<WorkItemRow | null> {
  const current = await lockOpenSupervisedWork(held, input);
  if (current || !input.confirmedDead) return current;
  const found = await sql<WorkItemRow>`select *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text from brain.work_items
    where id=${input.id} and kind='channel_send' and current_attempt_token=${input.attemptToken} and completed_at is null for update`.execute(held);
  if (!found.rows[0]) return null;
  const resumed = await sql`update brain.work_attempts set outcome=null,finished_at=null where token=${input.attemptToken} and work_item_id=${input.id} and outcome='unknown' returning token`.execute(held);
  if (!resumed.rows.length) return null;
  await sql`update brain.channel_attempt_results set outcome='unknown',error_code='INTERRUPTED',retryable=true,finished_at=${input.now.toISOString()}
    where work_item_id=${input.id} and attempt_token=${input.attemptToken} and outcome is null`.execute(held);
  return found.rows[0];
}

async function lockOpenSupervisedWork(held: Kysely<PgSchema>, input: { id: string; attemptToken: string }): Promise<WorkItemRow | null> {
  const found = await sql<WorkItemRow>`select *, local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text from brain.work_items where id = ${input.id}
    and current_attempt_token = ${input.attemptToken} for update`.execute(held);
  const item = found.rows[0];
  if (!item) return null;
  const attempt = await sql<{ current: boolean }>`select brain.attempt_is_current(${input.id}, ${input.attemptToken}) as current`.execute(held);
  return attempt.rows[0]?.current ? item : null;
}

async function finish(
  connect: PgConnect,
  update: (held: Kysely<PgSchema>) => Promise<number>,
): Promise<FinishWorkResult> {
  const opened = connect();
  if (!opened.ok) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
  }

  let written;
  try {
    written = await withWrite(opened.connection, update);
  } catch (error) {
    return databaseFailure(error);
  }
  if (!written.ok) return written;
  return { ok: true, outcome: written.value > 0 ? 'done' : 'lost' };
}

/** Explicit propagation shares the winning close's transaction and timestamp. */
async function closeDependents(held: Kysely<PgSchema>, rootId: string,
  outcome: 'failed' | 'cancelled' | 'dependency_failed', now: string): Promise<void> {
  // An inserter can hold a descendant lock while committing another edge.
  // Refresh the snapshot after each update, traversing even closed ancestors
  // so newly committed descendants remain reachable on the next pass.
  for (;;) {
    const changed = await sql`with recursive dependents(id) as (
      select work_item_id from brain.work_dependencies where prerequisite_id = ${rootId}
      union
      select d.work_item_id from dependents parent
        join brain.work_dependencies d on d.prerequisite_id = parent.id
    ) update brain.work_items set completed_at = ${now}, outcome = 'dependency_failed',
      claimed_at = null, claim_expires_at = null, claimed_by = null,
      last_error = ${encodedFailure(dependencyFailedText(rootId, outcome))}
      where id in (select id from dependents) and completed_at is null`.execute(held);
    if (changesOf(changed) === 0) return;
  }
}

async function readOpenWork(
  held: Kysely<PgSchema>,
  key: { kind: string; targetKind: string; targetId: string },
): Promise<WorkItemRow | null> {
  const found = await sql<WorkItemRow>`
    select id, kind, execution_class, current_attempt_token, serialization_key, hold_group, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at, outcome, cancel_requested_at, schedule_id, local_time_zone,
           local_date_from::text, local_date_to::text, claimed_date_from::text, claimed_date_to::text
      from brain.work_items
     where kind = ${key.kind} and target_kind = ${key.targetKind}
       and target_id = ${key.targetId} and completed_at is null
       for update
  `.execute(held);
  return found.rows[0] ?? null;
}

function changesOf(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

function instant(value: Date, column: string): string {
  const formatted = formatInstant(value);
  if (!formatted.ok) {
    throw new TypeError(`${column} cannot hold this instant: ${formatted.message}`);
  }
  return formatted.value;
}

function at(value: string, column: string): Date {
  const parsed = parseInstant(value);
  if (!parsed.ok) {
    throw new Error(`${column}을 읽을 수 없습니다: ${parsed.message}`);
  }
  return parsed.value;
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    scheduledDates: row.local_date_from === null ? null : { scheduleId: row.schedule_id, from: row.local_date_from, to: row.local_date_to!, timeZone: row.local_time_zone! },
    kind: row.kind,
    executionClass: row.execution_class,
    currentAttemptToken: row.current_attempt_token,
    serializationKey: row.serialization_key,
    holdGroup: row.hold_group,
    outcome: row.outcome,
    cancelRequestedAt: row.cancel_requested_at === null ? null : at(row.cancel_requested_at, 'work_items.cancel_requested_at'),
    targetKind: row.target_kind,
    targetId: row.target_id,
    createdAt: at(row.created_at, 'work_items.created_at'),
    attempts: row.attempts,
    nextAttemptAt: at(row.next_attempt_at, 'work_items.next_attempt_at'),
    claimedAt: row.claimed_at === null ? null : at(row.claimed_at, 'work_items.claimed_at'),
    claimExpiresAt:
      row.claim_expires_at === null
        ? null
        : at(row.claim_expires_at, 'work_items.claim_expires_at'),
    claimedBy: row.claimed_by,
    lastError: row.last_error,
    completedAt:
      row.completed_at === null ? null : at(row.completed_at, 'work_items.completed_at'),
  };
}

/** Encoding can expand NUL beyond the already masked sentence’s byte budget. */
function encodedFailure(message: string): string {
  return truncateUtf8(pgText(message).text!, FAILURE_MESSAGE_MAX_BYTES);
}

/** Called only by a winning completion, in that completion's transaction. */
async function settleScheduledSuccess(held: Kysely<PgSchema>, id: string, now: string): Promise<void> {
  await sql`insert into brain.schedule_successes (schedule_id, local_date, time_zone, work_id, recorded_at)
    select w.schedule_id, d::date, w.local_time_zone, w.id, ${now}::timestamptz
    from brain.work_items w cross join lateral generate_series(w.claimed_date_from, w.claimed_date_to, interval '1 day') d
    where w.id = ${id} and w.schedule_id is not null
    on conflict (schedule_id, local_date) do nothing`.execute(held);
  await sql`update brain.work_items set completed_at = null, outcome = null, next_attempt_at = ${now},
    current_attempt_token = null, claimed_at = null, claim_expires_at = null, claimed_by = null
    where id = ${id} and local_date_from is not null and cancel_requested_at is null
      and (claimed_date_from is null or local_date_from < claimed_date_from or local_date_to > claimed_date_to)`.execute(held);
  await sql`update brain.work_items set claimed_date_from = null, claimed_date_to = null where id = ${id}`.execute(held);
}

function listAttempt(row: Record<string, unknown>): import('@second-brain/core').WorkAttempt {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    converted[name] = value !== null && (key.endsWith('_at')) ? at(new Date(String(value)).toISOString(), `work_attempts.${key}`) : value;
  }
  return converted as unknown as import('@second-brain/core').WorkAttempt;
}
