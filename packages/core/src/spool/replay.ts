import {
  decodeSpoolLine,
  type SpoolRecord,
  type SpoolRecordKind,
} from '../domain/spool-record.js';
import type { Spool } from '../ports/spool.js';

/**
 * The frame that puts spooled records back into the database (AD-9).
 *
 * It is a frame and not a worker: what one record *means* belongs to the unit
 * that wrote it, so the handlers come from outside and this decides only the
 * order and what happens when one of them says no. A file is claimed, every
 * line of it is decoded and handed to the handler for its kind, and the file is
 * removed only once all of them have been accepted.
 *
 * What is deliberately not here, and is story 11's and 12's: rewriting the
 * lines that failed into a new file with their attempt counts, the ten-attempt
 * rule and `spool/failed/`, the `work_items` row a drain claims the whole run
 * under, and the `session_ingest` handler itself. All of those need either the
 * queue table or the use case they belong to; the rule this frame keeps —
 * all-or-nothing per file, and stop at the first file that did not go — is what
 * makes adding them safe, because a file that was released is a file nothing
 * has consumed.
 */

/**
 * One record put back. A handler says what happened and never throws: a replay
 * runs on a drain path, and the thing that went wrong is usually the database
 * being unavailable again, which is a value everywhere else in this codebase.
 */
export type SpoolReplayHandlerResult = { ok: true } | { ok: false; message: string };

/** What a unit does with one of its own records. */
export type SpoolReplayHandler = (record: SpoolRecord) => Promise<SpoolReplayHandlerResult>;

/**
 * The handlers by kind, as a partial map: a build that has no handler for a
 * kind must leave the file alone rather than drop it, so a missing entry is a
 * reason to stop and not a reason to delete.
 */
export type SpoolReplayHandlers = Readonly<Partial<Record<SpoolRecordKind, SpoolReplayHandler>>>;

export interface ReplaySpoolDependencies {
  spool: Spool;
  handlers: SpoolReplayHandlers;
}

export interface ReplaySpoolOptions {
  /**
   * How many files this run may take at most. Left out, it runs until the
   * spool is dry or something stops it. A caller with a time budget — the
   * periodic drain, the opportunistic one at the end of a command (AD-7) —
   * passes a number.
   */
  maxFiles?: number;
}

export interface ReplaySpoolReport {
  /** Files whose every record was accepted, and which were then removed. */
  completed: number;
  /** Records a handler accepted, across those files. */
  replayed: number;
  /**
   * Why the run stopped before the spool was empty, or `undefined` when it ran
   * dry or reached `maxFiles`. It is a sentence and not a code: what stopped it
   * is a handler's own message, a line nothing could read, or a kind nobody
   * handles, and none of those is a state of the brain (NFR-2).
   */
  stopped?: string;
}

/**
 * Replay the spool, oldest file first, and report.
 *
 * Nothing throws and nothing is retried in here. A file that did not go back
 * whole is released — put back exactly where it was — and the run stops: the
 * usual reason one file failed is the reason the next one would too, and
 * walking the rest of the spool to fail on every file would turn one
 * unavailable database into a hundred attempt counts.
 */
export async function replaySpool(
  dependencies: ReplaySpoolDependencies,
  options: ReplaySpoolOptions = {},
): Promise<ReplaySpoolReport> {
  const { spool, handlers } = dependencies;
  const { maxFiles } = options;

  let completed = 0;
  let replayed = 0;

  while (maxFiles === undefined || completed < maxFiles) {
    const claimed = await spool.claim();
    if (!claimed.ok) {
      return { completed, replayed, stopped: `spool 파일을 claim할 수 없습니다: ${claimed.message}` };
    }
    // Nothing waiting, which is the state of a brain whose database is fine.
    if (claimed.claim === null) return { completed, replayed };

    const { handle, lines } = claimed.claim;
    const outcome = await replayFile(lines, handlers);
    if (!outcome.ok) {
      // Back where it was, under the name a later claim looks for. The release
      // itself can fail — a folder that went away — and that is worth saying
      // instead of the handler's reason, because a file nobody can put back is
      // the more urgent of the two.
      const released = await spool.release(handle);
      const stopped = released.ok
        ? outcome.message
        : `${outcome.message}. 그 파일을 되돌릴 수도 없었습니다: ${released.message}`;
      return { completed, replayed: replayed + outcome.replayed, stopped };
    }

    const removed = await spool.complete(handle);
    if (!removed.ok) {
      // Every record is in the database and the file is still there. Stopping
      // is the safe half: the records are idempotent on their ids (AD-8), so a
      // later drain replaying this file changes nothing, while carrying on now
      // would mean doing it again inside this same run.
      return {
        completed,
        replayed: replayed + outcome.replayed,
        stopped: `되넣은 spool 파일을 지울 수 없습니다: ${removed.message}`,
      };
    }

    completed += 1;
    replayed += outcome.replayed;
  }

  return { completed, replayed };
}

/** What one claimed file came to: every record accepted, or the first refusal. */
type FileOutcome =
  | { ok: true; replayed: number }
  | { ok: false; replayed: number; message: string };

/**
 * Hand every line of one file to the handler of its kind.
 *
 * It stops at the first line it cannot place, and reports how many went in
 * before it: those records are in the database, and the file is going back
 * whole, so the count is what a caller needs to understand a report that says
 * "three records, nothing completed".
 */
async function replayFile(
  lines: readonly string[],
  handlers: SpoolReplayHandlers,
): Promise<FileOutcome> {
  let replayed = 0;
  for (const [index, line] of lines.entries()) {
    const where = `${String(index + 1)}번째 줄`;
    const decoded = decodeSpoolLine(line);
    if (!decoded.ok) {
      return { ok: false, replayed, message: `spool 파일의 ${where}: ${decoded.message}` };
    }
    const handler = handlers[decoded.record.kind];
    if (handler === undefined) {
      return {
        ok: false,
        replayed,
        message: `spool 파일의 ${where}: ${decoded.record.kind} 레코드를 되넣을 handler가 없습니다`,
      };
    }
    const handled = await handler(decoded.record);
    if (!handled.ok) {
      return { ok: false, replayed, message: `spool 파일의 ${where}: ${handled.message}` };
    }
    replayed += 1;
  }
  return { ok: true, replayed };
}
