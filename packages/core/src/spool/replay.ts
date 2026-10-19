import { failureFingerprint, failureText } from '../domain/failure.js';
import { parseSessionToken } from '../domain/session-token.js';
import {
  SPOOL_CAUSES,
  decodeSpoolLine,
  encodeSpoolLine,
  type SpoolCause,
  type SpoolRecord,
  type SpoolRecordKind,
} from '../domain/spool-record.js';
import { MAX_WORK_ATTEMPTS } from '../domain/work-item.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Spool } from '../ports/spool.js';
import type { WorkStore } from '../ports/store.js';

/**
 * The frame that puts spooled records back into the database (AD-9).
 *
 * It is a frame and not a worker: what one record *means* belongs to the unit
 * that wrote it, so the handlers come from outside and this decides only the
 * order and what happens when one of them says no.
 *
 * The rules it keeps, line by line:
 *
 *   * a record that went in is gone from the spool.
 *   * a database that will not take a write is not a failure of the record. The
 *     claimed file goes back whole, with every attempt count exactly as it was,
 *     and the run stops: the next record would meet the same database (AD-21).
 *   * any other refusal spends one of the record's ten attempts. Under ten, the
 *     line is written back with the raised count; at ten it is recorded in
 *     `failures` and moved aside to `spool/failed/`, where nothing will try it
 *     again and doctor counts it (2026-10-16).
 *   * a line nothing can read — broken JSON, a version or a kind this build does
 *     not know — goes straight aside. It cannot be retried, because there is no
 *     record to retry, and it must not stop the file either: one half-written
 *     line from a process that was killed would otherwise hold up every record
 *     behind it for ever (Decision 5, 2026-10-19).
 *
 * A kind this build has no handler for is the one case that still stops the
 * file. It is the same rule the queue keeps about kinds it cannot do: a record
 * a newer build wrote must survive an older build's drain, so the file goes
 * back untouched rather than being aged towards `failed/` by a build that was
 * never going to be the one to replay it.
 */

/**
 * One record put back. A handler says what happened and never throws: a replay
 * runs on a drain path, and the thing that went wrong is usually the database
 * being unavailable again, which is a value everywhere else in this codebase.
 *
 * `code` is what tells "the database would not take it" from "this record is
 * wrong": a `SpoolCause` puts the file back and stops the run, and anything
 * else — including no code at all — spends an attempt.
 */
export type SpoolReplayHandlerResult =
  | { ok: true }
  | { ok: false; code?: string; message: string };

/** What a unit does with one of its own records. */
export type SpoolReplayHandler = (record: SpoolRecord) => Promise<SpoolReplayHandlerResult>;

/**
 * The handlers by kind, as a partial map: a build that has no handler for a
 * kind must leave the file alone rather than drop it, so a missing entry is a
 * reason to stop and not a reason to delete.
 */
export type SpoolReplayHandlers = Readonly<Partial<Record<SpoolRecordKind, SpoolReplayHandler>>>;

/**
 * The code a record given up on is recorded under when its handler named none.
 *
 * A Core constant and deliberately not in the code table: "the spool could not
 * put this back ten times" is not a condition a caller can be told what to do
 * about, and the sentence beside it is what a person reads (Boundaries).
 */
export const SPOOL_REPLAY_FAILED = 'SPOOL_REPLAY_FAILED';

export interface ReplaySpoolDependencies {
  spool: Spool;
  handlers: SpoolReplayHandlers;
  /** Where a record that has run out of attempts is recorded (AD-9, AD-21). */
  store: Pick<WorkStore, 'recordFailure'>;
  clock: Clock;
  /** Mints the id of a failure row this replay has to write (AD-8). */
  idGen: IdGen;
}

export interface ReplaySpoolOptions {
  /**
   * How many files this run may take at most. Left out, it runs until the
   * spool is dry or something stops it. A caller with a time budget — the
   * periodic drain, the opportunistic one at the end of a command (AD-7) —
   * passes a number.
   */
  maxFiles?: number;
  /**
   * The instant, in milliseconds, after which no further file is claimed. The
   * drain's own deadline, so the replay, the scan and the queue loop share one
   * budget instead of three.
   */
  deadline?: number;
}

export interface ReplaySpoolReport {
  /** Files whose every record was accepted, and which were then removed. */
  completed: number;
  /** Records a handler accepted, across every file this run touched. */
  replayed: number;
  /** Lines moved to `spool/failed/`: unreadable, or out of attempts. */
  failed: number;
  /**
   * The code of a database that would not take a write, when that is what
   * stopped the run. The one answer the caller has to act on: the drain stops
   * there rather than scanning and claiming against a database it cannot write
   * to (AD-9).
   */
  unwritable?: string;
  /**
   * Why the run stopped before the spool was empty, or `undefined` when it ran
   * dry or reached its limit. It is a sentence and not a code: what stopped it
   * is a handler's own message or a kind nobody handles, and neither of those is
   * a state of the brain (NFR-2).
   */
  stopped?: string;
}

/**
 * Replay the spool, oldest file first, and report.
 *
 * Nothing throws in here. A file that could not be dealt with whole is either
 * rewritten — the lines that still have attempts left, plus the ones nobody will
 * try again — or released exactly as it was, and in both cases a later drain
 * finds whatever is left.
 */
export async function replaySpool(
  dependencies: ReplaySpoolDependencies,
  options: ReplaySpoolOptions = {},
): Promise<ReplaySpoolReport> {
  const { spool, handlers, store, clock, idGen } = dependencies;
  const { maxFiles, deadline } = options;

  let completed = 0;
  let replayed = 0;
  let failed = 0;

  while (maxFiles === undefined || completed < maxFiles) {
    if (deadline !== undefined && clock.now().getTime() >= deadline) {
      return {
        completed,
        replayed,
        failed,
        stopped: '시간 예산이 끝나 남은 spool 파일은 다음 처리로 넘깁니다',
      };
    }

    const claimed = await spool.claim();
    if (!claimed.ok) {
      return {
        completed,
        replayed,
        failed,
        stopped: `spool 파일을 claim할 수 없습니다: ${claimed.message}`,
      };
    }
    // Nothing waiting, which is the state of a brain whose database is fine.
    if (claimed.claim === null) return { completed, replayed, failed };

    const { handle, lines } = claimed.claim;
    const outcome = await replayFile({ handlers, store, clock, idGen }, lines);
    replayed += outcome.replayed;

    if (outcome.stop !== undefined) {
      // Back where it was, under the name a later claim looks for, with every
      // attempt count as it was: nothing was decided about these records.
      const released = await spool.release(handle);
      const stopped = released.ok
        ? outcome.stop.message
        : `${outcome.stop.message}. 그 파일을 되돌릴 수도 없었습니다: ${released.message}`;
      return {
        completed,
        replayed,
        failed,
        ...(outcome.stop.code === undefined ? {} : { unwritable: outcome.stop.code }),
        stopped,
      };
    }

    if (outcome.keep.length === 0 && outcome.failed.length === 0) {
      const removed = await spool.complete(handle);
      if (!removed.ok) {
        // Every record is in the database and the file is still there. Stopping
        // is the safe half: the records are idempotent on their ids (AD-8), so a
        // later drain replaying this file changes nothing, while carrying on now
        // would mean doing it again inside this same run.
        return {
          completed,
          replayed,
          failed,
          stopped: `되넣은 spool 파일을 지울 수 없습니다: ${removed.message}`,
        };
      }
      completed += 1;
      continue;
    }

    const rewritten = await spool.rewrite(handle, {
      keep: outcome.keep,
      failed: outcome.failed,
    });
    if (!rewritten.ok) {
      // The claimed file is still there with all of its lines, so nothing is
      // lost; stopping is what stops this run from rewriting it again.
      return {
        completed,
        replayed,
        failed,
        stopped: `남은 spool 줄을 다시 쓸 수 없습니다: ${rewritten.message}`,
      };
    }
    failed += outcome.failed.length;

    // And the run ends here, which is the rule story 2.10 established and this
    // one keeps: stop at the first file that did not go back whole. It is not
    // politeness — the kept lines are waiting under a name a claim looks for, so
    // carrying on would claim them again in this same run and spend every one of
    // their ten attempts on one unavailable database, in one loop, in seconds.
    return {
      completed,
      replayed,
      failed,
      stopped: outcome.refused ?? '일부 spool 줄이 되넣어지지 않았습니다',
    };
  }

  return { completed, replayed, failed };
}

/** What one claimed file came to, line by line. */
interface FileOutcome {
  /** Records a handler accepted. They are gone from the spool. */
  replayed: number;
  /** Lines to write back as a new waiting file, with their raised counts. */
  keep: readonly string[];
  /** Lines to move aside: unreadable, or out of attempts. */
  failed: readonly string[];
  /** What the first line that did not go in had to say, for the report. */
  refused?: string;
  /**
   * Set when the file has to go back exactly as it was: the database would not
   * take a write, or this build has no handler for one of its kinds. `code` is
   * the database's, and `undefined` for the handler case.
   */
  stop?: { code?: SpoolCause; message: string };
}

interface ReplayFileDependencies {
  handlers: SpoolReplayHandlers;
  store: Pick<WorkStore, 'recordFailure'>;
  clock: Clock;
  idGen: IdGen;
}

/**
 * Hand every line of one file to the handler of its kind, and sort the ones
 * that did not go in into "try again" and "give up".
 *
 * It walks the whole file rather than stopping at the first refusal, which is
 * the difference from the all-or-nothing frame of story 2.10: one unreadable
 * transcript in the middle of three marks must not hold up the other two, and
 * the attempt count on the line is what keeps that from being an endless retry.
 * The one thing it does stop for is a database that will not take a write,
 * because then nothing after it could go in either.
 */
async function replayFile(
  dependencies: ReplayFileDependencies,
  lines: readonly string[],
): Promise<FileOutcome> {
  const { handlers, store, clock, idGen } = dependencies;

  let replayed = 0;
  const keep: string[] = [];
  const failed: string[] = [];
  /** The first refusal, which is the one the report names. */
  let refused: string | undefined;

  for (const [index, line] of lines.entries()) {
    const where = `${String(index + 1)}번째 줄`;

    const decoded = decodeSpoolLine(line);
    if (!decoded.ok) {
      // Nothing to retry and nothing to count against: there is no record here.
      failed.push(line);
      refused ??= `spool 파일의 ${where}: ${decoded.message}`;
      continue;
    }
    const record = decoded.record;

    const handler = handlers[record.kind];
    if (handler === undefined) {
      return {
        replayed,
        keep,
        failed,
        stop: {
          message: `spool 파일의 ${where}: ${record.kind} 레코드를 되넣을 handler가 없습니다`,
        },
      };
    }

    const handled = await handler(record);
    if (handled.ok) {
      replayed += 1;
      continue;
    }

    const code = handled.code;
    if (code !== undefined && isSpoolCause(code)) {
      return {
        replayed,
        keep,
        failed,
        stop: { code, message: `spool 파일의 ${where}: ${handled.message}` },
      };
    }

    refused ??= `spool 파일의 ${where}: ${handled.message}`;
    const attempts = (record.attempts ?? 0) + 1;
    const again = encodeSpoolLine({ ...record, attempts });
    if (!again.ok) {
      // A record this build cannot spell any more. There is nothing to write
      // back, so it goes aside rather than being dropped in silence (NFR-2).
      failed.push(line);
      continue;
    }

    if (attempts < MAX_WORK_ATTEMPTS) {
      keep.push(again.line.replace(/\n$/, ''));
      continue;
    }

    // Out of attempts. The record is the only place this write exists — a log
    // entry and an injection record have no original to be read again from — so
    // the failure is recorded before the line is moved aside, and a database
    // that refuses even that puts the whole file back (NFR-2).
    const recorded = await recordGivingUp({ store, clock, idGen }, record, handled);
    if (recorded !== undefined) {
      return {
        replayed,
        keep,
        failed,
        stop: { code: recorded, message: `spool 파일의 ${where}: ${handled.message}` },
      };
    }
    failed.push(again.line.replace(/\n$/, ''));
  }

  return refused === undefined ? { replayed, keep, failed } : { replayed, keep, failed, refused };
}

/**
 * Record that this record will not be tried again, or say which way the
 * database refused.
 *
 * The target is whatever the record is about and the stage is the record's own
 * kind, so a mark that could never be replayed is recorded against the session
 * it names rather than against the spool (Boundaries). `closeWork` is
 * deliberately absent: no queue item is involved — this is the spool's own
 * bookkeeping — and the id of a `failure` record is the record's own, so a
 * replay of the same line twice cannot write two rows (AD-8).
 */
async function recordGivingUp(
  dependencies: Pick<ReplayFileDependencies, 'store' | 'clock' | 'idGen'>,
  record: SpoolRecord,
  handled: { code?: string; message: string },
): Promise<SpoolCause | undefined> {
  const { store, clock, idGen } = dependencies;

  const target = failureTargetOf(record);
  const code = handled.code ?? SPOOL_REPLAY_FAILED;
  const stage = record.kind;
  const written = await store.recordFailure({
    id: idGen.next(),
    targetKind: target.targetKind,
    targetId: target.targetId,
    stage,
    fingerprint: failureFingerprint({
      stage,
      input: `${target.targetKind}:${target.targetId}`,
      code,
    }),
    harness: target.harness,
    sessionId: null,
    code,
    message: failureText(handled.message),
    occurredAt: clock.now(),
  });
  if (written.ok) return undefined;
  return isSpoolCause(written.code) ? written.code : undefined;
}

/**
 * What a record is about, in the target columns `failures` is keyed on (Table
 * Contract).
 *
 * A `session_ingest` mark is about its session, which the token names whether or
 * not a row exists. A `failure` record already carries the target of the failure
 * it was going to write, and that target is what the record is about too — the
 * row it could not write is not a thing of its own.
 */
function failureTargetOf(record: SpoolRecord): {
  targetKind: string;
  targetId: string;
  harness: string | null;
} {
  switch (record.kind) {
    case 'session_ingest': {
      const session = record.payload.session;
      const token = parseSessionToken(session);
      return {
        targetKind: 'session',
        targetId: session,
        harness: token.ok ? token.key.harness : null,
      };
    }
    case 'failure':
      return {
        targetKind: record.payload.targetKind,
        targetId: record.payload.targetId,
        harness: record.payload.harness,
      };
  }
}

function isSpoolCause(code: string): code is SpoolCause {
  return SPOOL_CAUSES.includes(code as SpoolCause);
}
