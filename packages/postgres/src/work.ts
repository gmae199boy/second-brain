import {
  formatInstant,
  TABLE_CLEANUP_KIND,
  TABLE_TARGET_KIND,
  FAILURE_MESSAGE_MAX_BYTES,
  truncateUtf8,
  parseInstant,
  workKindPolicy,
  workExecutionClass,
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
  id: string;
  kind: string;
  execution_class: 'core' | 'supervised';
  current_attempt_token: string | null;
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

/** Shared due predicate and order; only the claiming caller adds row locking. */
export function claimCandidateQuery(query: DueWorkQuery): RawBuilder<WorkItemRow> {
  const now = instant(query.now, 'work_items.next_attempt_at');
  return sql<WorkItemRow>`
    select id, kind, execution_class, current_attempt_token, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at, outcome, cancel_requested_at
      from brain.work_items
     where completed_at is null
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
      insert into brain.work_items (id, kind, execution_class, target_kind, target_id, created_at, attempts, next_attempt_at)
      values (${input.id}, ${input.kind}, ${workExecutionClass(input.kind)}, ${input.targetKind}, ${input.targetId}, ${createdAt}, 0, ${nextAttemptAt})
      on conflict (kind, target_kind, target_id) where completed_at is null do nothing returning *
    `.execute(held);
    const row = inserted.rows[0];
    if (row !== undefined) return { created: true, row };
    const existing = await readOpenWork(held, input);
    if (existing !== null) return { created: false, row: existing };
    // A drain completed the conflicting row between these statements. At READ
    // COMMITTED the next insert can create its replacement using a fresh snapshot.
  }
}

export function postgresWorkStore(connect: PgConnect): WorkStore {
  return {
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
          const found = await sql<WorkItemRow>`${claimCandidateQuery(input)} for update skip locked`.execute(held);
          const candidate = found.rows[0];
          if (candidate === undefined) return null;
          const expiresAt = instant(
            new Date(input.now.getTime() + workKindPolicy(candidate.kind).claimForMs),
            'work_items.claim_expires_at',
          );

          await sql`
            update brain.work_items
               set attempts = attempts + 1,
                   claimed_at = ${now},
                   claim_expires_at = ${expiresAt},
                   claimed_by = ${input.claimedBy}
             where id = ${candidate.id}
          `.execute(held);
          return {
            ...candidate,
            attempts: candidate.attempts + 1,
            claimed_at: now,
            claim_expires_at: expiresAt,
            claimed_by: input.claimedBy,
          };
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
          const found = await sql<WorkItemRow>`select * from brain.work_items where id = ${input.id} for update`.execute(held);
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
        const rows = await sql<{ token: string; work_item_id: string; kind: string; attempts: number; incarnation: string | null;
          pid: number | null; pgid: number | null; os_boot_at: string | null; os_started_at: string | null; cancel_requested: boolean }>`
          select a.*, w.kind, w.attempts, w.cancel_requested_at is not null as cancel_requested
          from brain.work_attempts a join brain.work_items w on w.current_attempt_token = a.token
          where a.outcome is null`.execute(opened.connection.db);
        return { ok: true, attempts: rows.rows.map(a => ({ token: a.token, workItemId: a.work_item_id, kind: a.kind, attempts: a.attempts,
          incarnation: a.incarnation, pid: a.pid, pgid: a.pgid, osBootAt: a.os_boot_at === null ? null : at(a.os_boot_at, 'work_attempts.os_boot_at'),
          osStartedAt: a.os_started_at === null ? null : at(a.os_started_at, 'work_attempts.os_started_at'), cancelRequested: a.cancel_requested })) };
      } catch (error) { return { ...databaseFailure(error), message: `열린 시도를 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async settleSupervisedAttempt(input) {
      return finish(connect, async held => {
        const item = await lockOpenSupervisedWork(held, input);
        if (!item) return 0;
        const now = instant(input.now, 'work_attempts.finished_at');
        const outcome = input.outcome === 'unknown' ? 'unknown' : item.cancel_requested_at !== null ? 'cancelled' : input.outcome;
        await sql`update brain.work_attempts set outcome = ${outcome}, finished_at = ${now} where token = ${input.attemptToken}`.execute(held);
        if (input.outcome === 'unknown') return 1;
        await sql`update brain.work_items set current_attempt_token = null, claimed_at = null, claim_expires_at = null, claimed_by = null,
          completed_at = case when cancel_requested_at is not null then ${now}::timestamptz else completed_at end,
          outcome = case when cancel_requested_at is not null then 'cancelled' else outcome end,
          attempts = case when cancel_requested_at is null and ${input.outcome} = 'cancelled' then greatest(0, attempts - 1) else attempts end,
          next_attempt_at = case when cancel_requested_at is null and ${input.outcome} = 'died' then ${now}::timestamptz else next_attempt_at end
          where id = ${input.id}`.execute(held);
        return 1;
      });
    },
    async claimSupervisedWork(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const written = await withWrite(opened.connection, async (held) => {
          const now = instant(input.now, 'work_items.claimed_at');
          const found = await sql<WorkItemRow>`select * from brain.work_items
            where execution_class = 'supervised' and completed_at is null
              and current_attempt_token is null and cancel_requested_at is null
              and next_attempt_at <= ${now} and (claim_expires_at is null or claim_expires_at <= ${now})
              and kind = any(${[...input.kinds]}::text[])
            order by attempts, id limit 1 for update skip locked`.execute(held);
          const candidate = found.rows[0];
          if (!candidate) return null;
          await sql`insert into brain.work_attempts (token, work_item_id, started_at, incarnation)
            values (${input.attemptToken}, ${candidate.id}, ${now}, ${input.claimedBy})`.execute(held);
          const expires = instant(new Date(input.now.getTime() + workKindPolicy(candidate.kind).claimForMs), 'work_items.claim_expires_at');
          const changed = await sql<WorkItemRow>`update brain.work_items set attempts = attempts + 1,
            claimed_at = ${now}, claim_expires_at = ${expires}, claimed_by = ${input.claimedBy},
            current_attempt_token = ${input.attemptToken} where id = ${candidate.id} returning *`.execute(held);
          return toWorkItem(changed.rows[0]!);
        });
        if (!written.ok) return written;
        return { ok: true, item: written.value, attemptToken: written.value === null ? null : input.attemptToken };
      } catch (error) { return { ...databaseFailure(error), message: `감독 일감을 청구할 수 없습니다: ${describe(error)}` }; }
    },
    async renewSupervisedLease(input) {
      return finish(connect, async (held) => {
        const item = await lockOpenSupervisedWork(held, input);
        if (!item) return 0;
        const expires = instant(new Date(input.now.getTime() + workKindPolicy(item.kind).claimForMs), 'work_items.claim_expires_at');
        await sql`update brain.work_items set claim_expires_at = ${expires} where id = ${input.id}`.execute(held);
        await sql`update brain.work_attempts set last_progress_at = ${instant(input.progressAt, 'work_attempts.last_progress_at')},
          renewed_at = ${instant(input.now, 'work_attempts.renewed_at')} where token = ${input.attemptToken}`.execute(held);
        return 1;
      });
    },
    async finishSupervisedWork(input) {
      return finish(connect, async (held) => {
        if (!await lockOpenSupervisedWork(held, input)) return 0;
        const now = instant(input.now, 'work_attempts.finished_at');
        const next = input.nextAttemptAt === undefined ? now : instant(input.nextAttemptAt, 'work_items.next_attempt_at');
        const changed = await sql`update brain.work_items set current_attempt_token = null,
          claimed_at = null, claim_expires_at = null, claimed_by = null,
          completed_at = case when ${input.outcome} = 'succeeded' or cancel_requested_at is not null then ${now}::timestamptz else null end,
          outcome = case when ${input.outcome} = 'succeeded' then 'succeeded' when cancel_requested_at is not null then 'cancelled' else null end,
          next_attempt_at = case when ${input.outcome} = 'failed' then ${next}::timestamptz else next_attempt_at end,
          last_error = case when ${input.outcome} = 'failed' then ${input.lastError === undefined ? null : encodedFailure(input.lastError)} else last_error end
          where id = ${input.id} and current_attempt_token = ${input.attemptToken}`.execute(held);
        if (changesOf(changed) === 0) return 0;
        await sql`update brain.work_attempts set finished_at = ${now}, outcome = ${input.outcome}
          where token = ${input.attemptToken}`.execute(held);
        return 1;
      });
    },

    async completeWork(input: CompleteWorkInput): Promise<FinishWorkResult> {
      return finish(connect, async (held) => {
        const now = instant(input.now, 'work_items.completed_at');
        const completed = await sql<{ kind: string; target_kind: string; target_id: string }>`
          update brain.work_items
             set completed_at = ${now},
                 claimed_at = null, claim_expires_at = null, claimed_by = null
           where id = ${input.id} and claimed_by = ${input.claimedBy} and completed_at is null
           returning kind, target_kind, target_id
        `.execute(held);
        const row = completed.rows[0];
        if (row === undefined) return 0;
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
                   set completed_at = ${closedAt},
                       last_error = ${encodedFailure(input.message)},
                       claimed_at = null, claim_expires_at = null, claimed_by = null
                 where id = ${closing.id} and claimed_by = ${closing.claimedBy}
              `.execute(held),
            );
            if (closed === 0) return null;
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
async function lockOpenSupervisedWork(held: Kysely<PgSchema>, input: { id: string; attemptToken: string }): Promise<WorkItemRow | null> {
  const found = await sql<WorkItemRow>`select * from brain.work_items where id = ${input.id}
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

async function readOpenWork(
  held: Kysely<PgSchema>,
  key: { kind: string; targetKind: string; targetId: string },
): Promise<WorkItemRow | null> {
  const found = await sql<WorkItemRow>`
    select id, kind, execution_class, current_attempt_token, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at, outcome, cancel_requested_at
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
    kind: row.kind,
    executionClass: row.execution_class,
    currentAttemptToken: row.current_attempt_token,
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
