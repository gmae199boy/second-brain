import {
  formatInstant,
  FAILURE_MESSAGE_MAX_BYTES,
  truncateUtf8,
  parseInstant,
  workKindPolicy,
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
}

/** Shared due predicate and order; only the claiming caller adds row locking. */
export function claimCandidateQuery(query: DueWorkQuery): RawBuilder<WorkItemRow> {
  const now = instant(query.now, 'work_items.next_attempt_at');
  return sql<WorkItemRow>`
    select id, kind, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at
      from brain.work_items
     where completed_at is null
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
      insert into brain.work_items (id, kind, target_kind, target_id, created_at, attempts, next_attempt_at)
      values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId}, ${createdAt}, 0, ${nextAttemptAt})
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `일감을 넣을 수 없습니다: ${describe(error)}`,
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `할 일이 있는지 볼 수 없습니다: ${describe(error)}`,
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `일감을 청구할 수 없습니다: ${describe(error)}`,
        };
      }
      if (!written.ok) return written;
      const row = written.value;
      return { ok: true, item: row === null ? null : toWorkItem(row) };
    },

    async completeWork(input: CompleteWorkInput): Promise<FinishWorkResult> {
      return finish(connect, async (held) => {
        const now = instant(input.now, 'work_items.completed_at');
        return changesOf(
          await sql`
            update brain.work_items
               set completed_at = ${now},
                   claimed_at = null, claim_expires_at = null, claimed_by = null
             where id = ${input.id} and claimed_by = ${input.claimedBy}
          `.execute(held),
        );
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `실패를 기록할 수 없습니다: ${describe(error)}`,
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `열린 일감을 읽을 수 없습니다: ${describe(error)}`,
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `실패를 읽을 수 없습니다: ${describe(error)}`,
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
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `실패를 해결로 표시할 수 없습니다: ${describe(error)}`,
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
    select id, kind, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at
      from brain.work_items
     where kind = ${key.kind} and target_kind = ${key.targetKind}
       and target_id = ${key.targetId} and completed_at is null
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
