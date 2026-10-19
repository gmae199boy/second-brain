import {
  formatInstant,
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
import { describe, type SqliteConnect } from './connect.js';
import type { SqliteSchema } from './driver.js';
import { withWrite } from './write.js';

/** A `work_items` row as SQLite hands it back: text instants, no booleans. */
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

/**
 * The claim query, as one function.
 *
 * It is a function and not SQL spelled out at each call because three things
 * have to agree about it: the "is anything due" read, the claim transaction,
 * and the plan the index of 0004 was shaped for. A test that copied the SQL
 * would be a second spelling, and the day somebody adds a condition the copy
 * would go on proving the old plan was fine (Boundaries). The plan test compiles
 * what this returns instead.
 *
 * The four conditions are AD-21's own: not finished, due now, not held by a live
 * claim, and of a kind this build can do. The order is `(attempts, id)`, so one
 * poisonous item cannot starve the backlog behind it, and
 * `work_items_due_idx (attempts, id, next_attempt_at) where completed_at is
 * null` answers it from the index with nothing left to sort.
 *
 * `indexed by` is there because the planner would otherwise choose
 * `work_items_open_key_idx` for the `kind` equality and sort afterwards —
 * measured, not guessed: without it the plan is `SEARCH … USING INDEX
 * work_items_open_key_idx (kind=?)` and `USE TEMP B-TREE FOR ORDER BY`. That
 * plan would mean the *first* kind's backlog is worked through before the
 * others, which is the starvation the index was shaped to prevent. Naming the
 * index also ties the query to it: drop the index and this query stops
 * compiling, rather than quietly getting slower.
 *
 * Every value is bound, the kinds included: a kind is a Core constant today,
 * but a query built by splicing names into text is one refactor away from being
 * built from data.
 */
export function claimCandidateQuery(query: DueWorkQuery): RawBuilder<WorkItemRow> {
  const now = instant(query.now, 'work_items.next_attempt_at');
  // An empty list compiles to `kind in ()`, which SQLite accepts and which
  // matches nothing — the right answer for a build with no handlers. Both
  // callers return before they get here, so that is a floor and not a path.
  const kinds = sql.join(query.kinds.map((kind) => sql`${kind}`));
  return sql<WorkItemRow>`
    select id, kind, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at
      from work_items indexed by work_items_due_idx
     where completed_at is null
       and next_attempt_at <= ${now}
       and (claim_expires_at is null or claim_expires_at <= ${now})
       and kind in (${kinds})
  order by attempts asc, id asc
     limit 1
  `;
}

/**
 * The queue capability on the local source: one backlog, claimed in a short
 * write transaction and worked on outside it (AD-7, AD-21).
 *
 * Two things in here are worth reading twice.
 *
 * The claim is one transaction. The candidate is chosen and marked inside the
 * same `BEGIN IMMEDIATE`, because two drains that read first and wrote second
 * would both take the same row — and the row is chosen by a `select` and then
 * updated by id rather than by an `update … order by limit`, which SQLite does
 * not have.
 *
 * Every finishing verb is a compare-and-set. `where id = ? and claimed_by = ?`,
 * and a changed-row count of zero is `lost`: a claim expires, so a worker that
 * was killed and came back must not overwrite the state of the worker that took
 * the row over (Design Notes).
 */
export function sqliteWorkStore(connect: SqliteConnect): WorkStore {
  return {
    async addWork(input: AddWorkInput): Promise<AddWorkResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const createdAt = instant(input.createdAt, 'work_items.created_at');
      const nextAttemptAt = instant(input.nextAttemptAt, 'work_items.next_attempt_at');

      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          // Looked up *before* the insert, in the same transaction: `created`
          // means "this call put the row there", and that cannot be read off
          // the id. A caller replaying a record proposes the id it minted the
          // first time, so `row.id === input.id` would call a second call a
          // creation — and the memory fake, which answers `false`, would then
          // disagree with this one.
          const existing = await readOpenWork(held, input);
          if (existing !== null) return { created: false, row: existing };

          // The partial unique index of 0002 is the target, so the conflict is
          // only over the rows still to be done: the same work asked for again
          // after it completed is a new row (AD-21). Nothing else can be
          // writing — `BEGIN IMMEDIATE` holds the one writer — so the clause is
          // the index's guarantee restated and not a race this relies on.
          await sql`
            insert into work_items (id, kind, target_kind, target_id, created_at,
                                    attempts, next_attempt_at)
                 values (${input.id}, ${input.kind}, ${input.targetKind}, ${input.targetId},
                         ${createdAt}, 0, ${nextAttemptAt})
            on conflict (kind, target_kind, target_id) where completed_at is null
              do nothing
          `.execute(held);
          return { created: true, row: await readOpenWork(held, input) };
        });
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
        // Not reachable: the lookup above found no open row, this transaction
        // holds the only writer, and an insert the index refused would have
        // thrown rather than come back quietly — a proposed id that belongs to
        // another row fails the primary key and lands in the `catch`. It is
        // here because the read-back is typed as nullable and a silent
        // `undefined` further on would be worse than a sentence nobody reads.
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
      // No kinds, nothing to look for, and no reason to ask the database.
      if (query.kinds.length === 0) return { ok: true, due: false };

      try {
        // A plain read on the shared handle, never a write: a drain with nothing
        // to do must not take the write lock, which is the whole reason this
        // verb exists apart from `claimWork` (AD-7). The same query builder, so
        // "is anything due" and "what would be claimed" cannot disagree.
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

      const now = instant(input.now, 'work_items.claimed_at');

      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          const found = await claimCandidateQuery(input).execute(held);
          const candidate = found.rows[0];
          if (candidate === undefined) return null;

          const expiresAt = instant(
            new Date(input.now.getTime() + workKindPolicy(candidate.kind).claimForMs),
            'work_items.claim_expires_at',
          );
          // The attempt is raised by the claim, in the same transaction that
          // takes the row: an item that kills the worker holding it still
          // counted once, so it cannot be claimed for ever (Decision 1).
          await sql`
            update work_items
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
      return finish(connect, '일감을 끝낼 수 없습니다', async (held) => {
        const now = instant(input.now, 'work_items.completed_at');
        return changesOf(
          await sql`
            update work_items
               set completed_at = ${now},
                   claimed_at = null, claim_expires_at = null, claimed_by = null
             where id = ${input.id} and claimed_by = ${input.claimedBy}
          `.execute(held),
        );
      });
    },

    async retryWork(input: RetryWorkInput): Promise<FinishWorkResult> {
      return finish(connect, '일감을 다시 시도하게 둘 수 없습니다', async (held) => {
        const nextAttemptAt = instant(input.nextAttemptAt, 'work_items.next_attempt_at');
        return changesOf(
          await sql`
            update work_items
               set next_attempt_at = ${nextAttemptAt},
                   last_error = ${input.lastError},
                   claimed_at = null, claim_expires_at = null, claimed_by = null
             where id = ${input.id} and claimed_by = ${input.claimedBy}
          `.execute(held),
        );
      });
    },

    async releaseWork(input: FinishWorkInput): Promise<FinishWorkResult> {
      return finish(connect, '일감을 돌려줄 수 없습니다', async (held) => {
        // `max(0, …)` rather than a bare subtraction: the table's own check
        // refuses a negative, and a release of a row at zero attempts would
        // turn a harmless no-op into a failed transaction.
        return changesOf(
          await sql`
            update work_items
               set attempts = max(0, attempts - 1),
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

      const occurredAt = instant(input.occurredAt, 'failures.occurred_at');
      const closing = input.closeWork;
      const closedAt =
        closing === undefined ? null : instant(closing.now, 'work_items.completed_at');

      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          if (closing !== undefined) {
            // The claim first, and nothing written when it is not ours: the
            // record and the close are one transaction, and the worker that
            // took this item over owns its outcome now (port contract).
            const closed = changesOf(
              await sql`
                update work_items
                   set completed_at = ${closedAt},
                       last_error = ${input.message},
                       claimed_at = null, claim_expires_at = null, claimed_by = null
                 where id = ${closing.id} and claimed_by = ${closing.claimedBy}
              `.execute(held),
            );
            if (closed === 0) return null;
          }

          // Looked up before the insert, like `addWork`'s: `created` means
          // "this call made the row", which the id cannot answer — a caller
          // replaying a spooled record proposes the id it minted the first time.
          const before = await readFailureId(held, input);

          // The same cause met again is this row: it keeps its id, is open
          // again, and carries this occurrence's instant and sentence, so it
          // says when the cause was last met (Decision 2, 2026-10-19 사용자,
          // Table Contract). The first instant and the count arrive with 0005.
          await sql`
            insert into failures (id, target_kind, target_id, stage, fingerprint, harness,
                                  session_id, code, message, occurred_at)
                 values (${input.id}, ${input.targetKind}, ${input.targetId}, ${input.stage},
                         ${input.fingerprint}, ${input.harness}, ${input.sessionId},
                         ${input.code}, ${input.message}, ${occurredAt})
            on conflict (target_kind, target_id, stage, fingerprint)
              do update set occurred_at = excluded.occurred_at,
                            message = excluded.message,
                            resolved_at = null
          `.execute(held);
          return before === null
            ? { created: true, failureId: await readFailureId(held, input) }
            : { created: false, failureId: before };
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
      // `null` from the transaction means the claim was not ours.
      if (recorded === null) return { ok: true, outcome: 'lost' };
      const { created, failureId } = recorded;
      if (failureId === null) {
        // Not reachable: the insert above either added the row or updated the
        // one that was already there, and this transaction holds the only
        // writer. Here because the read-back is typed as nullable.
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
        // A plain read on the shared handle: the folder scan asks this before it
        // decides whether to write anything, and a read that took the write lock
        // would defeat the point of asking (AD-7).
        const found = await sql<{ target_kind: string; target_id: string }>`
          select target_kind, target_id
            from work_items
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

      // Every clause is bound and every narrowing is optional, so one query
      // answers all four shapes the port allows. `limit` of `-1` is SQLite's own
      // "no limit", which keeps this one statement rather than two.
      const includeResolved = query.includeResolved === true ? 1 : 0;
      const targetKind = query.targetKind ?? null;
      const stage = query.stage ?? null;
      const limit = query.limit ?? -1;
      try {
        const found = await sql<FailureRow>`
          select id, target_kind, target_id, stage, fingerprint, harness, session_id,
                 code, message, occurred_at, resolved_at
            from failures
           where (${includeResolved} = 1 or resolved_at is null)
             and (${targetKind} is null or target_kind = ${targetKind})
             and (${stage} is null or stage = ${stage})
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
      const now = instant(input.now, 'failures.resolved_at');

      let written;
      try {
        written = await withWrite(opened.connection, async (held) =>
          changesOf(
            await sql`
              update failures
                 set resolved_at = ${now}
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

/** A `failures` row as SQLite hands it back: text instants (0004). */
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
  };
}

/**
 * One finishing verb, whole: open, write, and turn a changed-row count into
 * `done` or `lost`.
 *
 * The three of them differ in one `update` and in nothing else — the open, the
 * transaction, the error wrapping and the compare-and-set verdict are the same
 * three times, and a rule repeated three times is a rule that will be forgotten
 * once.
 */
async function finish(
  connect: SqliteConnect,
  what: string,
  update: (held: Kysely<SqliteSchema>) => Promise<number>,
): Promise<FinishWorkResult> {
  const opened = connect();
  if (!opened.ok) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
  }

  let written;
  try {
    written = await withWrite(opened.connection, update);
  } catch (error) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: `${what}: ${describe(error)}` };
  }
  if (!written.ok) return written;
  return { ok: true, outcome: written.value > 0 ? 'done' : 'lost' };
}

/** The id of the row one failure key names, or `null` (Table Contract). */
async function readFailureId(
  held: Kysely<SqliteSchema>,
  key: { targetKind: string; targetId: string; stage: string; fingerprint: string },
): Promise<string | null> {
  const found = await sql<{ id: string }>`
    select id from failures
     where target_kind = ${key.targetKind} and target_id = ${key.targetId}
       and stage = ${key.stage} and fingerprint = ${key.fingerprint}
  `.execute(held);
  return found.rows[0]?.id ?? null;
}

/** The open row for one piece of work, or `null` (`work_items_open_key_idx`). */
async function readOpenWork(
  held: Kysely<SqliteSchema>,
  key: { kind: string; targetKind: string; targetId: string },
): Promise<WorkItemRow | null> {
  const found = await sql<WorkItemRow>`
    select id, kind, target_kind, target_id, created_at, attempts, next_attempt_at,
           claimed_at, claim_expires_at, claimed_by, last_error, completed_at
      from work_items
     where kind = ${key.kind} and target_kind = ${key.targetKind}
       and target_id = ${key.targetId} and completed_at is null
  `.execute(held);
  return found.rows[0] ?? null;
}

/**
 * How many rows one `update` changed. Kysely reports it as a bigint on the
 * SQLite dialect, so it is widened here rather than compared in two spellings.
 */
function changesOf(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

/** An instant as the column holds it. A caller's bad instant is a bug. */
function instant(value: Date, column: string): string {
  const formatted = formatInstant(value);
  if (!formatted.ok) {
    throw new TypeError(`${column} cannot hold this instant: ${formatted.message}`);
  }
  return formatted.value;
}

/** The other direction. A row holding anything else was not written by us. */
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
