import { errorCodeSpec } from '../codes.js';
import { failureFingerprint, failureText } from '../domain/failure.js';
import { SPOOL_CAUSES, SPOOL_RECORD_VERSION, type SpoolCause } from '../domain/spool-record.js';
import {
  MAX_WORK_ATTEMPTS,
  workKindPolicy,
  type WorkItem,
  type WorkKindPolicy,
} from '../domain/work-item.js';
import { errorLine } from '../error-text.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Spool } from '../ports/spool.js';
import type { WorkStore } from '../ports/store.js';

/**
 * The drain loop: claim one item, do it, and decide what its outcome means
 * (AD-7, AD-21).
 *
 * It is a frame and not a worker. What a kind of work *is* belongs to the unit
 * that named it, so the handlers come from outside and this decides only the
 * order, the classification and the bookkeeping. The kinds this build can do
 * are whatever `createBrain` was assembled with — `session_ingest` is Core's
 * own (`capture/session-ingest-work.ts`) — and an item of any other kind is
 * left alone rather than claimed or closed.
 *
 * Nothing in here throws. A handler that throws is caught and treated as an
 * error nobody classified, because one buggy kind of work must not take the
 * whole backlog down with it.
 */

/** A handler's own failure, in the shape the classification reads (AD-21). */
export interface WorkHandlerFailure {
  ok: false;
  /**
   * The classification code. One of the error codes where that fits, or the
   * handler's own — a connector names its own (`ports/connector.ts`), and an
   * unknown code is handled as "unclassified" rather than guessed at.
   */
  code: string;
  message: string;
  /**
   * Whether another attempt can work. The handler's own answer wins over the
   * code table's, because the handler saw the actual response: a 404 and a 503
   * can both arrive under one code from one adapter.
   */
  retryable?: boolean;
  /**
   * The absolute instant to wait until. An adapter that read a `Retry-After`
   * header turns it into an instant here — Core has no clock arithmetic on
   * durations from outside, and every instant in this project is absolute
   * (AD-13).
   */
  retryAfter?: Date;
  /**
   * Which harness this item was about, when it was about one. Information only,
   * and left out by every kind of work that is not about a conversation (Table
   * Contract, `failures.harness`).
   */
  harness?: string;
  /**
   * The Brain-side session id, when there is a row for it. Left out whenever
   * there is not — a session whose very first collection failed has no row, and
   * the token in `target_id` is what identifies it either way (AD-12).
   */
  sessionId?: string;
}

/** One attempt at one item: it worked, or it did not and said why. */
export type WorkHandlerResult = { ok: true } | WorkHandlerFailure;

/** What a unit does with one item of its own kind. */
export type WorkHandler = (item: WorkItem) => Promise<WorkHandlerResult>;

/**
 * The handlers by kind. A kind with no entry here is never claimed, so an old
 * build leaves a new build's work alone instead of closing it (Decision 4,
 * 2026-10-19).
 */
export type WorkHandlers = Readonly<Record<string, WorkHandler>>;

/**
 * The code a handler that threw is treated under. A Core constant and
 * deliberately *not* in the code table: a thrown handler is a bug in this build,
 * not a condition a caller can be told what to do about (Boundaries).
 */
export const WORK_HANDLER_THREW = 'HANDLER_THREW';

/**
 * The code for an item whose kind has no handler, which can only happen if a
 * store ignored the `kinds` filter of the claim. Also not in the code table: it
 * is a broken adapter, and treating it as unclassified means the item backs off
 * and is eventually recorded rather than claimed in a loop for ever.
 */
export const WORK_HANDLER_MISSING = 'HANDLER_MISSING';

/** What one item's outcome means for the row (AD-21, Design Notes). */
export type WorkVerdict =
  /** It worked: close the row. */
  | { decision: 'complete' }
  /** Worth another attempt, not before this instant. */
  | { decision: 'retry'; at: Date }
  /** No more attempts: record the failure and close the row. */
  | { decision: 'record' }
  /**
   * The database itself could not be written to, which is not a failure of the
   * item: hand it back, undo the attempt, and stop the run (AD-9, AD-21).
   */
  | { decision: 'release'; code: SpoolCause };

/**
 * What one outcome means, given which attempt it was.
 *
 * `attempt` is the number of the attempt that just finished — the value the
 * claim wrote, which is `attempts` on the item it handed back.
 *
 * The order of the five questions is the whole of AD-21 and it is not
 * interchangeable:
 *
 *   1. "the database could not take it" comes first, because it is not a
 *      failure of the work and must not spend an attempt.
 *   2. then what the handler said about retrying, and only then what the code
 *      table says: the handler saw the response.
 *   3. `false` means permanent — recorded on the first failure, never retried.
 *   4. `true` means somebody else's hiccup — `retryAfter` if it named an
 *      instant, otherwise the kind's long wait.
 *   5. anything else is unclassified — the exponential wait, up to ten
 *      attempts, and then a record.
 *
 * It is exported because it is the part worth testing on its own: every row of
 * the matrix about retries is a question about this function and not about the
 * loop around it.
 */
export function classifyWorkFailure(
  outcome: WorkHandlerResult,
  attempt: number,
  policy: WorkKindPolicy,
  now: Date,
): WorkVerdict {
  if (outcome.ok) return { decision: 'complete' };

  if (isSpoolCause(outcome.code)) {
    return { decision: 'release', code: outcome.code };
  }

  const retryable = outcome.retryable ?? errorCodeSpec(outcome.code)?.retryable;
  if (retryable === false) return { decision: 'record' };

  // Out of attempts: both the temporary and the unclassified kinds end here,
  // which is the one place the ten of AD-21 is applied.
  if (attempt >= MAX_WORK_ATTEMPTS) return { decision: 'record' };

  if (retryable === true) {
    return {
      decision: 'retry',
      at: outcome.retryAfter ?? new Date(now.getTime() + policy.transientDelayMs),
    };
  }
  return { decision: 'retry', at: new Date(now.getTime() + policy.retryDelayMs(attempt)) };
}

export interface DrainQueueDependencies {
  store: WorkStore;
  /** Where a failure record goes when the database will not take it (AD-9). */
  spool: Spool;
  clock: Clock;
  /** Mints this run's `claimedBy`, and the id of any failure row (AD-8). */
  idGen: IdGen;
}

export interface DrainQueueInput {
  /**
   * How long this run may keep claiming new items, in milliseconds. The budget
   * decides whether to claim another one and never interrupts one in progress
   * (`DRAIN_BUDGET_MS`, AD-7).
   */
  budgetMs: number;
  /** What this run can do. A kind with no handler here is left alone. */
  handlers: WorkHandlers;
}

/** What one run did, and why it stopped (Boundaries). */
export interface DrainQueueReport {
  claimed: number;
  completed: number;
  retried: number;
  /** Items whose last attempt was recorded in `failures` and then closed. */
  failed: number;
  /** Items handed back because the database could not be written to. */
  released: number;
  /** Finishing verbs that found the claim had gone to another worker. */
  lost: number;
  /** Failure records the database refused, which went to the spool instead. */
  spooled: number;
  /**
   * `empty` — nothing was due, which is the ordinary answer. `budget` — the time
   * ran out. `unwritable` — the database could not be written to, and `code`
   * says which way (AD-9).
   */
  stopped: 'empty' | 'budget' | 'unwritable';
  /** The code that stopped it, only when `stopped` is `unwritable`. */
  code?: string;
}

/**
 * Work the queue until it is empty, the budget is gone, or the database stops
 * taking writes.
 *
 * Every run has its own `claimedBy`, minted once: it is what the compare-and-set
 * of every finishing verb is measured against, so two runs of the same process
 * cannot answer for each other's claims.
 *
 * Before each claim there is a lock-free read. A drain with nothing to do must
 * not take the write lock — the opportunistic run at the end of every command
 * would otherwise queue behind whatever is writing, for no work at all (AD-7).
 */
export async function drainQueue(
  dependencies: DrainQueueDependencies,
  input: DrainQueueInput,
): Promise<DrainQueueReport> {
  const { store, spool, clock, idGen } = dependencies;
  const { budgetMs, handlers } = input;

  const claimedBy = idGen.next();
  const kinds = Object.keys(handlers);
  const deadline = clock.now().getTime() + budgetMs;
  const tally = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    released: 0,
    lost: 0,
    spooled: 0,
  };

  for (;;) {
    // Checked before the claim and not after the work: an item already being
    // processed is never interrupted, and a budget that was gone before the
    // first claim means this run does nothing at all (Boundaries).
    if (clock.now().getTime() >= deadline) {
      return { ...tally, stopped: 'budget' };
    }

    const due = await store.hasDueWork({ now: clock.now(), kinds });
    if (!due.ok) return { ...tally, stopped: 'unwritable', code: due.code };
    if (!due.due) return { ...tally, stopped: 'empty' };

    const claim = await store.claimWork({ now: clock.now(), claimedBy, kinds });
    if (!claim.ok) return { ...tally, stopped: 'unwritable', code: claim.code };
    // Nothing left, or another drain took it between the read and the claim.
    // Either way this run has no item, and losing the race is not a failure.
    if (claim.item === null) return { ...tally, stopped: 'empty' };

    const item = claim.item;
    tally.claimed += 1;

    const outcome = await attempt(handlers[item.kind], item);
    const now = clock.now();
    const verdict = classifyWorkFailure(outcome, item.attempts, workKindPolicy(item.kind), now);

    switch (verdict.decision) {
      case 'complete': {
        const done = await store.completeWork({ id: item.id, claimedBy, now });
        if (!done.ok) return { ...tally, stopped: 'unwritable', code: done.code };
        count(tally, done.outcome, 'completed');
        break;
      }

      case 'retry': {
        const again = await store.retryWork({
          id: item.id,
          claimedBy,
          nextAttemptAt: verdict.at,
          lastError: sentence(outcome),
        });
        if (!again.ok) return { ...tally, stopped: 'unwritable', code: again.code };
        count(tally, again.outcome, 'retried');
        break;
      }

      case 'record': {
        const recorded = await record(
          { store, spool, idGen },
          { item, claimedBy, now, outcome: asFailure(outcome) },
        );
        if (recorded.spooled) tally.spooled += 1;
        if (recorded.stopped !== undefined) {
          return { ...tally, stopped: 'unwritable', code: recorded.stopped };
        }
        count(tally, recorded.outcome ?? 'done', 'failed');
        break;
      }

      case 'release': {
        // The attempt is given back too, which is the one case where it is:
        // nothing was tried, so nothing was attempted (AD-21). A release the
        // database also refuses leaves the attempt counted, which is the honest
        // state of a brain that cannot be written to at all.
        const back = await store.releaseWork({ id: item.id, claimedBy });
        if (back.ok) count(tally, back.outcome, 'released');
        return { ...tally, stopped: 'unwritable', code: verdict.code };
      }
    }
  }
}

/** The counters, as the loop keeps them. */
type Tally = {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  released: number;
  lost: number;
  spooled: number;
};

/** One finishing verb's outcome, in the right counter. */
function count(
  tally: Tally,
  outcome: 'done' | 'lost',
  field: 'completed' | 'retried' | 'failed' | 'released',
): void {
  if (outcome === 'lost') tally.lost += 1;
  else tally[field] += 1;
}

/**
 * One attempt at one item, with nothing able to escape.
 *
 * A handler that throws is a bug in this build, and a bug in one kind of work
 * must not stop the drain: it comes back as an error nobody classified, so the
 * item backs off and is eventually recorded like any other (Boundaries). A kind
 * with no handler can only arrive from a store that ignored the claim's `kinds`,
 * and is treated the same way for the same reason.
 */
async function attempt(
  handler: WorkHandler | undefined,
  item: WorkItem,
): Promise<WorkHandlerResult> {
  if (handler === undefined) {
    return {
      ok: false,
      code: WORK_HANDLER_MISSING,
      message: `${item.kind} 일감을 처리할 handler가 없습니다`,
    };
  }
  try {
    return await handler(item);
  } catch (error) {
    return { ok: false, code: WORK_HANDLER_THREW, message: errorLine(error) };
  }
}

/** What writing one record came to. */
interface RecordOutcome {
  /** The finishing verb's outcome, or `undefined` when nothing was written. */
  outcome?: 'done' | 'lost';
  /** The record went to the spool instead of the database. */
  spooled: boolean;
  /** The code that stops the run, or `undefined` to carry on. */
  stopped?: string;
}

/**
 * Write the failure of the last attempt and close the item, or — when the
 * database refuses the record too — put the same content in the spool and stop
 * (AD-9).
 *
 * The spool is not a second-best place to leave it: `failures` is the only
 * record this attempt leaves anywhere, so an item closed with the record lost
 * would be work that quietly stopped with nothing to show (NFR-2). The item is
 * deliberately *not* closed in that case — the record and the close are one
 * transaction, and it did not happen — so a later drain meets the item again.
 */
async function record(
  dependencies: Pick<DrainQueueDependencies, 'store' | 'spool' | 'idGen'>,
  attempted: { item: WorkItem; claimedBy: string; now: Date; outcome: WorkHandlerFailure },
): Promise<RecordOutcome> {
  const { store, spool, idGen } = dependencies;
  const { item, claimedBy, now, outcome } = attempted;

  // The stage is the kind of work, and the fingerprint's input is the target:
  // the same kind failing the same way about the same thing is one row, however
  // often it happens (I/O matrix).
  const stage = item.kind;
  const input = `${item.targetKind}:${item.targetId}`;
  const message = sentence(outcome);
  const failure = {
    targetKind: item.targetKind,
    targetId: item.targetId,
    stage,
    fingerprint: failureFingerprint({ stage, input, code: outcome.code }),
    // Information, from the handler when it had any to give: the drain knows
    // which item failed, not which conversation it was about (Table Contract).
    harness: outcome.harness ?? null,
    sessionId: outcome.sessionId ?? null,
    code: outcome.code,
    message,
    occurredAt: now,
  };

  const written = await store.recordFailure({
    id: idGen.next(),
    ...failure,
    closeWork: { id: item.id, claimedBy, now },
  });
  if (written.ok) return { outcome: written.outcome === 'lost' ? 'lost' : 'done', spooled: false };
  if (!isSpoolCause(written.code)) {
    return { spooled: false, stopped: written.code };
  }

  const appended = await spool.append([
    {
      schemaVersion: SPOOL_RECORD_VERSION,
      id: idGen.next(),
      kind: 'failure',
      occurredAt: now,
      payload: { ...failure, workItemId: item.id },
    },
  ]);
  // Either way the run stops under the code that stopped the write: the spool
  // failing as well is the reason there is nothing more to say about it, not a
  // different problem (NFR-2).
  return { spooled: appended.ok, stopped: written.code };
}

/** The handler failure of an outcome the classification sent to `record`. */
function asFailure(outcome: WorkHandlerResult): WorkHandlerFailure {
  // `complete` is the only verdict an `ok` outcome produces, so this cannot be
  // reached; the shape is narrowed here rather than asserted at the call.
  return outcome.ok
    ? { ok: false, code: WORK_HANDLER_THREW, message: '성공한 일감을 실패로 기록하려 했습니다' }
    : outcome;
}

/** One outcome's sentence as it is stored: masked, and inside the limit (AD-11). */
function sentence(outcome: WorkHandlerResult): string {
  return outcome.ok ? '' : failureText(outcome.message);
}

function isSpoolCause(code: string): code is SpoolCause {
  return SPOOL_CAUSES.includes(code as SpoolCause);
}
