import { DAEMON_HEARTBEAT_MS } from './liveness.js';
import {
  BUSY_TIMEOUT_MS,
  SQLITE_SCHEMA_VERSION,
  checkSchema,
  createBrain,
  errorLine,
  sqliteStore,
  type BrainDrainReport,
  type Clock,
  type FailureExit,
  type IdGen,
  type SchemaStore,
  type Store,
  type WorkHandlers,
} from 'second_brain';
import { brainDependencies } from '../assembly.js';
import { readConfig, type ReadConfigResult } from '../config/codec.js';
import { acquireDaemonLock } from './lock.js';
import { daemonLog } from './log.js';
import { startHeartbeat } from './heartbeat.js';
import { watchFolders } from '../harnesses.js';
import { startTranscriptWatch, type TranscriptWatchFunction } from './watch.js';
import type { CreateStore } from '../dispatch.js';

/**
 * The resident loop behind `brain daemon run`: take the lock, keep a heartbeat,
 * and drain the backlog over and over until somebody aborts it.
 *
 * It takes an `AbortSignal` and installs no signal handler of its own. Signals
 * belong to the process and therefore to the command (`commands/daemon-run.ts`);
 * a module that attached its own would be a module a test could not run twice,
 * and would make `runDaemon` unusable from anything but a terminal.
 *
 * Each round opens its own store and checks the schema before it assembles
 * anything. That is why the command is `standalone` rather than a database
 * command: the dispatcher opens one store for the length of a command and sees
 * the write guard once, and a process that runs for weeks has to look again —
 * after a repair, after a migration, after the file was replaced underneath it
 * (AD-20). The assembly itself is the dispatcher's own (`assembly.ts`).
 */

/**
 * How often the heartbeat is rewritten. Thirty seconds: long enough that the
 * file is not a write loop of its own, short enough that story 9.3 can call a
 * daemon stalled without waiting minutes to say so.
 */
export { DAEMON_HEARTBEAT_MS } from './liveness.js';

/**
 * How long one drain may keep claiming work. Ten seconds keeps a normal
 * shutdown inside launchd's default twenty-second `ExitTimeOut`. An item
 * already being processed is awaited without a limit and may be killed past
 * that window; its claim returns to the queue when the ten-minute lease expires.
 */
export const DAEMON_DRAIN_BUDGET_MS = 10_000;

/**
 * How long the loop waits after a round that found nothing to do, or could not
 * do it: an empty queue, a database it may not write to, a mismatched schema,
 * an exception. A round that stopped on `budget` had more work in hand and is
 * followed by the next one at once.
 *
 * Watch batches wake this pause early; ten-second periodic scans backstop
 * missed events or failed watchers. Active work may extend transcript latency.
 */
export const DAEMON_DRAIN_PAUSE_MS = 10_000;

export interface RunDaemonOptions {
  /** The configuration folder this daemon is the daemon of (AD-18). */
  home: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  idGen: IdGen;
  /** Aborted to stop: no new drain starts, and the one in flight finishes. */
  signal: AbortSignal;
  /** Defaults to `DAEMON_HEARTBEAT_MS`. A test gives it something short. */
  heartbeatMs?: number;
  /** Defaults to `DAEMON_DRAIN_BUDGET_MS`. */
  drainBudgetMs?: number;
  /** Defaults to `DAEMON_DRAIN_PAUSE_MS`. */
  drainPauseMs?: number;
  /** Defaults to the two-second fixed watch window. */
  watchBatchMs?: number;
  /** Filesystem watch seam for failure and lifecycle tests. */
  watch?: TranscriptWatchFunction;
  /** Defaults to `sqliteStore`, which is what every real daemon uses. */
  createStore?: CreateStore;
  /** Kinds beyond Core's own. Empty for every real invocation (AD-21). */
  workHandlers?: WorkHandlers;
  /** Lock seams, for the rows of the matrix a test cannot arrange otherwise. */
  isAlive?: (pid: number) => boolean;
  bootAt?: () => Date;
}

export type RunDaemonResult =
  | { ok: true }
  | {
      ok: false;
      /** `CONFIG_MISSING`, `CONFIG_INVALID` or `DAEMON_RUNNING`. */
      code: string;
      message: string;
      exit: FailureExit;
    };

export async function runDaemon(options: RunDaemonOptions): Promise<RunDaemonResult> {
  const { home, env, clock, idGen, signal } = options;
  const log = daemonLog(home, clock);

  // Before the lock, so a folder nothing was installed into leaves no pid file
  // behind: a daemon that cannot find its database is not a daemon that holds
  // the right to be the only one.
  const config = await readConfig(home);
  if (!config.ok) {
    return { ok: false, code: config.code, message: config.message, exit: 2 };
  }

  const lock = await acquireDaemonLock({
    home,
    clock,
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.bootAt === undefined ? {} : { bootAt: options.bootAt }),
  });
  if (!lock.ok) {
    await log.write(lock.message);
    return { ok: false, code: 'DAEMON_RUNNING', message: lock.message, exit: 1 };
  }

  const heartbeat = await startHeartbeat({
    home,
    clock,
    intervalMs: options.heartbeatMs ?? DAEMON_HEARTBEAT_MS,
    log,
  });
  // One clause, with the pid inside it rather than after a full stop: the
  // output-language check reads a line clause by clause, and `pid 4242` on its
  // own is a clause with no Korean in it at all (Conventions, 출력 언어).
  await log.write(`데몬을 시작했습니다 — pid ${String(lock.pid)}`);

  // What the last round complained about, so a problem that lasts is said once
  // rather than every ten seconds. A round that worked clears it, which is what
  // makes the next occurrence worth a line again.
  let said: string | undefined;
  let pendingBatch = false;
  let wake: (() => void) | undefined;
  const watcher = startTranscriptWatch({
    folders: watchFolders(env),
    log,
    ...(options.watchBatchMs === undefined ? {} : { batchMs: options.watchBatchMs }),
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    onBatch() {
      pendingBatch = true;
      wake?.();
    },
  });

  try {
    await watcher.retry();
    while (!signal.aborted) {
      const config = await readConfig(home);
      if (signal.aborted) break;
      const round: Round = config.ok
        ? await drainOnce({
            home,
            env,
            clock,
            idGen,
            signal,
            storePath: config.config.storePath,
            config,
            createStore: options.createStore ?? sqliteStore,
            workHandlers: options.workHandlers ?? {},
            budgetMs: options.drainBudgetMs ?? DAEMON_DRAIN_BUDGET_MS,
          })
        : { pause: true, problem: { key: config.code, message: config.message } };

      if (round.problem === undefined) {
        said = undefined;
      } else if (round.problem.key !== said) {
        said = round.problem.key;
        await log.write(round.problem.message);
      }
      if (round.counts !== undefined) await log.write(round.counts);

      // An abort during the drain must not be followed by a pause.
      if (signal.aborted) break;
      await watcher.retry();
      if (signal.aborted) break;
      if (round.pause && !pendingBatch) {
        await pause(options.drainPauseMs ?? DAEMON_DRAIN_PAUSE_MS, signal, (done) => { wake = done; });
        wake = undefined;
      }
      pendingBatch = false;
    }
  } finally {
    watcher.close();
    // Watchers and their batch timer close first. Then the heartbeat timer,
    // because a beat written after the lock is
    // gone would be a heartbeat with no owner; the lock second, so no second
    // daemon can start while this one is still finishing; the line last, so
    // the log's last word about this run is that it ended cleanly. The
    // heartbeat file itself stays — story 9.3 shows the last one.
    await heartbeat.stop();
    await lock.release();
    await log.write(`데몬을 멈췄습니다 — pid ${String(lock.pid)}`);
  }

  return { ok: true };
}

/** What one round of the loop did, and what it has to say about it. */
interface Round {
  /** Whether to wait before the next round. `false` only after `budget`. */
  pause: boolean;
  /** A state worth one log line, with the key that tells it from the last. */
  problem?: { key: string; message: string };
  /** The counts line, only for a round that actually did something. */
  counts?: string;
}

interface RoundOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  clock: Clock;
  idGen: IdGen;
  storePath: string;
  config: ReadConfigResult;
  createStore: CreateStore;
  workHandlers: WorkHandlers;
  budgetMs: number;
  signal: AbortSignal;
}

/**
 * One round: open the store, check the schema, drain, close.
 *
 * The `catch` is why this is a function. A handler that throws must not end a
 * process that is supposed to outlive every one of its rounds, so whatever
 * comes out of it is a state the loop reports once and then carries on from.
 *
 * Nothing new goes to the spool here. A transcript the database would not take
 * is already handled by the drain's own spool path, over the very
 * `fileSpool(spoolPath(home))` every other surface uses (AD-9) — a daemon with
 * a spool of its own would be a second queue for the same writes.
 */
async function drainOnce(options: RoundOptions): Promise<Round> {
  const { home, env, clock, idGen, storePath, config, createStore, workHandlers, budgetMs, signal } =
    options;
  let store: (Store & SchemaStore) | undefined;
  try {
    store = createStore({ path: storePath, busyTimeoutMs: BUSY_TIMEOUT_MS.command });
    // Every round, not once at startup: a database that was repaired or
    // migrated while this process ran is one the next round may write to, and
    // one that was replaced by another version is one it may not (AD-20).
    const schema = await checkSchema(store, SQLITE_SCHEMA_VERSION);
    if (signal.aborted) return { pause: false };
    if (!schema.ok) {
      return { pause: true, problem: { key: schema.code, message: schema.message } };
    }

    const brain = createBrain(
      brainDependencies({ home, env, config, store, clock, idGen, workHandlers }),
    );
    const report = await brain.queue.drain({ budgetMs });
    if (report.stopped === 'unwritable') {
      const key = report.code ?? 'DB_UNAVAILABLE';
      return {
        pause: true,
        problem: { key, message: '데이터베이스에 쓸 수 없어서 이번 회차를 멈췄습니다.' },
        ...(worked(report) ? { counts: counts(report) } : {}),
      };
    }
    return {
      pause: report.stopped !== 'budget',
      ...(worked(report) ? { counts: counts(report) } : {}),
    };
  } catch (error) {
    // The key is the code rather than the sentence: the same bug carries a
    // different path or line each time, and a key that moved would put a line
    // in the log every ten seconds for one broken handler.
    return {
      pause: true,
      problem: { key: 'DRAIN_THREW', message: `밀린 일 처리 중 오류: ${errorLine(error)}` },
    };
  } finally {
    // The round's own connection, so closing it is the round's own job: a
    // process that kept one open per round would run out of descriptors.
    await store?.close().catch(() => undefined);
  }
}

/** Whether this round touched anything worth a line in the log. */
function worked(report: BrainDrainReport): boolean {
  return (
    report.claimed > 0 ||
    report.completed > 0 ||
    report.failed > 0 ||
    report.spooled > 0 ||
    report.enqueued > 0 ||
    report.replayed > 0 ||
    report.spoolFailed > 0 ||
    report.retried > 0 ||
    report.released > 0 ||
    report.lost > 0 ||
    report.rereadMissing > 0 ||
    report.reextractUnreachable > 0
  );
}

/**
 * The counts of one round as one Korean line.
 *
 * Every clause carries `건`, the last one included, for the reason `queue
 * drain`'s own line does: the output-language check reads a line clause by
 * clause, and `spool 0` on its own is a clause with no Korean in it at all
 * (Conventions, 출력 언어).
 */
function counts(report: BrainDrainReport): string {
  return (
    `되넣음 ${String(report.replayed)}건, 실패로 옮김 ${String(report.spoolFailed)}건, ` +
    `새 일감 ${String(report.enqueued)}건, 다시 못 읽음 ${String(report.rereadMissing)}건, ` +
    `다시 추출 건너뜀 원본 불가 ${String(report.reextractUnreachable)}건, ` +
    `청구 ${String(report.claimed)}건, 완료 ${String(report.completed)}건, ` +
    `다시 시도 ${String(report.retried)}건, 실패 ${String(report.failed)}건, ` +
    `돌려줌 ${String(report.released)}건, 놓침 ${String(report.lost)}건, ` +
    `spool ${String(report.spooled)}건.`
  );
}

/**
 * Wait, or wake at once on an abort or a watch batch. The listener is removed either
 * way: a process that runs for weeks adds one of these every ten seconds, and
 * a signal with thousands of listeners on it is a leak that ends in a warning
 * nobody can act on.
 */
function pause(ms: number, signal: AbortSignal, subscribe: (wake: () => void) => void): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    subscribe(done);
  });
}
