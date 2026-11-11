import { runtimeFencePath, RUNTIME_FENCE_RECOVERY } from '../install/runtime-fence.js';
import { driveAuth } from '../runtime/drive-oauth.js';
import { createDriveRuntime } from '../runtime/drive-runtime.js';
import type { SettingsStore } from 'second_brain';
import { startDaemonSupervisor, type DaemonSupervisorOptions } from './supervisor.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { DAEMON_HEARTBEAT_MS } from './liveness.js';
import {
  checkSchema,
  handoffChannelRequests,
  handoffImportRequests,
  cleanupImportRequests,
  createBrain,
  errorLine,
  type BrainDrainReport,
  type Clock,
  type FailureExit,
  type IdGen,
  type SchemaStore,
  type Store,
  type WorkHandlers,
} from 'second_brain';
import { brainDependencies } from '../assembly.js';
import { importStaging } from '../runtime/import-staging.js';
import { readConfig, readDriveCredentials, resolveStoreUrl, type DriveCredentials, type ReadConfigResult } from '../config/codec.js';
import { readBuildIdentity } from '../install/installed.js';
import { acquireDaemonLock } from './lock.js';
import { daemonLog } from './log.js';
import { startHeartbeat } from './heartbeat.js';
import { watchFolders } from '../harnesses.js';
import { startTranscriptWatch, type TranscriptWatchFunction } from './watch.js';
import { openBrainStore } from '../runtime/brain-store.js';
import { composeArgs, commandEnv, systemCommandRunner, type CommandRunner } from '../runtime/command-runner.js';
import type { CreateConnectionStore, DispatchRuntime } from '../dispatch.js';

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

/** Delay after successive container restart attempts, capped at five minutes. */
export const DAEMON_RECONNECT_BACKOFF_MS = { initial: 10_000, max: 300_000 };
/** A compose start must finish within one minute and remains abortable. */
export const DAEMON_COMPOSE_UP_TIMEOUT_MS = 60_000;

export interface RunDaemonOptions {
  /** The configuration folder this daemon is the daemon of (AD-18). */
  supervisor?: DaemonSupervisorOptions;
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
  /** PostgreSQL 연결 생성 시험 seam. */
  createStore?: CreateConnectionStore;
  driveFactory?: DispatchRuntime['driveFactory'];
  sourceSyncFactory?: DispatchRuntime['sourceSyncFactory'];
  driveNetwork?: DispatchRuntime['driveNetwork'];
  /** Test seam after credential sampling and before the round claims work. */
  afterDriveAuthSample?: () => Promise<void>;
  runner?: CommandRunner;
  reconnectBackoffMs?: { initial: number; max: number };
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

  // Before the lock, so a folder nothing was installed into leaves no pid file
  // behind: a daemon that cannot find its database is not a daemon that holds
  // the right to be the only one.
  const config = await readConfig(home);
  if (!config.ok) {
    return { ok: false, code: config.code, message: config.message, exit: 2 };
  }

  if (await access(runtimeFencePath(home)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    await daemonLog(home, clock, { rotate: false }).write(RUNTIME_FENCE_RECOVERY);
    return { ok: false, code: 'DB_LOCKED', message: RUNTIME_FENCE_RECOVERY, exit: 1 };
  }
  const lock = await acquireDaemonLock({
    commit: (await readBuildIdentity())?.commit ?? null,
    home,
    clock,
    ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
    ...(options.bootAt === undefined ? {} : { bootAt: options.bootAt }),
  });
  if (!lock.ok) {
    await daemonLog(home, clock, { rotate: false }).write(lock.message);
    return { ok: false, code: 'DAEMON_RUNNING', message: lock.message, exit: 1 };
  }

  const log = daemonLog(home, clock);
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
  const supervisor = startDaemonSupervisor(options, config, log);
  let persistentDriveAuth=driveAuth({home,clock,...options.driveNetwork});
  let authIdentity:DriveCredentials|null|undefined;
  const authForRound=async()=>{
    const current=await readDriveCredentials(home).catch(()=>null);
    if(authIdentity===undefined||!current||!authIdentity||current.session!==authIdentity.session||current.clientId!==authIdentity.clientId||current.clientSecret!==authIdentity.clientSecret){
      persistentDriveAuth=driveAuth({home,clock,...options.driveNetwork,expectedCredentials:current});
    }
    authIdentity=current;
    return persistentDriveAuth;
  };
  let said: string | undefined;
  let tickSaid: string | undefined;
  let recovery: { attempt: number; nextAt: number; failureCode?: string; missing?: boolean } | undefined;
  const backoff = options.reconnectBackoffMs ?? DAEMON_RECONNECT_BACKOFF_MS;
  const runner = options.runner ?? systemCommandRunner;
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
      const roundAuth = config.ok ? await authForRound() : undefined;
      if (config.ok) await options.afterDriveAuthSample?.();
      const round: Round = config.ok
        ? await drainOnce({
            home,
            env,
            clock,
            idGen,
            signal,
            config,
            createStore: options.createStore,
            driveFactory: options.driveFactory,
            sourceSyncFactory: options.sourceSyncFactory,
            driveNetwork: options.driveNetwork,
            driveAuth:roundAuth,
            onWorkProgress: event=>log.write(`Drive 진행 ${event.message ?? ""}`),
            workHandlers: options.workHandlers ?? {},
            budgetMs: options.drainBudgetMs ?? DAEMON_DRAIN_BUDGET_MS,
          })
        : { pause: true, problem: { key: config.code, message: config.message } };

      if (round.reached && recovery !== undefined) {
        recovery = undefined;
        await log.write('데이터베이스에 다시 닿았습니다');
      }
      if (!signal.aborted && round.unreachable && clock.now().getTime() >= (recovery?.nextAt ?? 0)) {
        if (recovery === undefined) {
          recovery = { attempt: 0, nextAt: 0 };
          await log.write('데이터베이스에 닿지 않아 컨테이너를 다시 띄웁니다 — 간격을 두고 재시도합니다');
        }
        const composeExists = await access(join(home, 'postgres', 'compose.yaml')).then(() => true, () => false);
        if (signal.aborted) break;
        if (!composeExists) {
          if (!recovery.missing) await log.write('데이터베이스 컨테이너 설정 파일 postgres/compose.yaml이 없어 다시 띄울 수 없습니다');
          recovery.missing = true;
        } else {
          const result = await runner({ command: 'docker', args: composeArgs(home, ['up', '-d']),
            env: commandEnv(env), timeoutMs: DAEMON_COMPOSE_UP_TIMEOUT_MS, signal });
          if (signal.aborted) break;
          recovery.attempt += 1;
          if (!result.ok) {
            const code = result.code ?? 'unknown';
            if (code !== recovery.failureCode) await log.write(`데이터베이스 컨테이너 시작 실패 — 오류 코드 ${code}`);
            recovery.failureCode = code;
          }
        }
        recovery.nextAt = clock.now().getTime() + (composeExists
          ? Math.min(backoff.initial * 2 ** (recovery.attempt - 1), backoff.max)
          : backoff.initial);
      }

      if (round.problem === undefined) {
        said = undefined;
      } else if (round.problem.key !== said) {
        said = round.problem.key;
        await log.write(round.problem.message);
      }
      if (round.tickRan && round.tickProblem === undefined) tickSaid = undefined;
      else if (round.tickProblem !== undefined && round.tickProblem.key !== tickSaid) {
        tickSaid = round.tickProblem.key;
        await log.write(round.tickProblem.message);
      }
      if (round.tickCounts !== undefined) await log.write(round.tickCounts);
      if (round.counts !== undefined) await log.write(round.counts);

      // An abort during the drain must not be followed by a pause.
      if (signal.aborted) break;
      await watcher.retry();
      if (signal.aborted) break;
      if (round.pause && !pendingBatch) {
        const regularPause = options.drainPauseMs ?? DAEMON_DRAIN_PAUSE_MS;
        const pauseMs = recovery === undefined || !round.unreachable ? regularPause
          : Math.min(regularPause, Math.max(0, recovery.nextAt - clock.now().getTime()));
        await pause(pauseMs, signal, (done) => { wake = done; });
        wake = undefined;
      }
      pendingBatch = false;
    }
  } finally {
    watcher.close();
    await supervisor.stop();
    // Watchers and their batch timer close first. Then the heartbeat timer,
    // because a beat written after the lock is
    // gone would be a heartbeat with no owner; the stop line next, while this
    // daemon still holds the right to rotate; the lock last, so no second
    // daemon can start while this one is still finishing. The
    // heartbeat file itself stays — story 9.3 shows the last one.
    await heartbeat.stop();
    await log.write(`데몬을 멈췄습니다 — pid ${String(lock.pid)}`);
    await lock.release();
  }

  return { ok: true };
}

/** What one round of the loop did, and what it has to say about it. */
interface Round {
  unreachable?: true;
  reached?: true;
  tickRan?: boolean;
  tickProblem?: { key: string; message: string };
  tickCounts?: string;
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
  config: ReadConfigResult;
  createStore: CreateConnectionStore | undefined;
  driveFactory?: DispatchRuntime['driveFactory'];
  sourceSyncFactory?: DispatchRuntime['sourceSyncFactory'];
  driveNetwork?: DispatchRuntime['driveNetwork'];
  driveAuth?:ReturnType<typeof driveAuth>;
  onWorkProgress?: import('second_brain').WorkProgressSink;
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
  const { home, env, clock, idGen, config, createStore, workHandlers, budgetMs, signal } =
    options;
  let store: (Store & SchemaStore & SettingsStore) | undefined;
  let tickState: Pick<Round, 'tickRan' | 'tickProblem' | 'tickCounts'> = {};
  let reached: Pick<Round, 'reached'> = {};
  try {
    // The factory represents URL resolution failures with an unavailable store.
    // Only a resolved URL authorizes trying to start the configured container.
    const reconnectEligible = config.ok && Boolean(await resolveStoreUrl(home, config.config.storeUrlEnv, env).catch(() => undefined));
    const opened = await openBrainStore({ home, env, config, path: 'drain', createStore });
    store = opened.store;
    // Every round, not once at startup: a database that was repaired or
    // migrated while this process ran is one the next round may write to, and
    // one that was replaced by another version is one it may not (AD-20).
    const schema = await checkSchema(store, opened.expected);
    if (schema.ok || schema.code !== 'DB_UNAVAILABLE') reached = { reached: true };
    if (signal.aborted) return { pause: false };
    if (!schema.ok) {
      return { ...reached, ...(reconnectEligible && schema.code === 'DB_UNAVAILABLE' ? { unreachable: true as const } : {}), pause: true, problem: { key: schema.code, message: `데이터베이스 확인 실패: ${schema.message}` } };
    }

    if (store.imports) {
      await cleanupImportRequests(store.imports, importStaging(home), clock);
      const imports = await handoffImportRequests(store.imports, clock, idGen);
      if (!imports.ok) return { ...reached, ...(reconnectEligible && imports.code === 'DB_UNAVAILABLE' ? { unreachable: true as const } : {}), pause: true, problem: { key: imports.code, message: '파일 요청 인계 실패' } };
    }
    const handoff = await handoffChannelRequests(store, clock, idGen);
    if (!handoff.ok) return {
      ...reached,
      ...(reconnectEligible && handoff.code === 'DB_UNAVAILABLE' ? { unreachable: true as const } : {}),
      pause: true,
      problem: { key: handoff.code, message: `채널 인계 실패 (${handoff.code})` },
    };
    if (signal.aborted) return { ...reached, pause: false };
    const driveRuntime=await createDriveRuntime({home,store,clock,idGen,schemaVersions:opened.expected,network:options.driveNetwork,auth:options.driveAuth});
    const driveReconcile = driveRuntime ? await driveRuntime.reconcile() : null;
    const brain = createBrain(
      brainDependencies({ home, env, config, schemaVersions: opened.expected, store, clock, idGen, workHandlers, onWorkProgress:options.onWorkProgress, driveFactory:options.driveFactory??(driveRuntime?.drive?()=>driveRuntime.drive:undefined),sourceSyncFactory:options.sourceSyncFactory??(driveRuntime?()=>driveRuntime.sourceSync:undefined),sourceControl:driveRuntime?.control }),
    );
    const tick = await brain.schedules.tick();
    tickState = {
      tickRan: true,
      ...(!tick.ok ? { tickProblem: { key: tick.code, message: `예약 틱 실패 (${tick.code}): ${tick.message}` } } : {}),
      ...(tick.fired > 0 ? { tickCounts: [`예약 ${String(tick.fired)}건 발화, 새 일감 ${String(tick.enqueued)}건`, ...(tick.ok ? tick.warnings ?? [] : [])].join(' — ') } : {}),
    };
    if (signal.aborted) return { ...tickState, pause: false };
    const report = await brain.queue.drain({ budgetMs });
    if (report.stopped === 'unwritable') {
      const key = report.code ?? 'DB_UNAVAILABLE';
      const unavailable = reconnectEligible && report.code === 'DB_UNAVAILABLE';
      return {
        ...tickState,
        ...reached,
        ...(unavailable ? { unreachable: true as const } : {}),
        pause: true,
        problem: { key, message: '데이터베이스에 쓸 수 없어서 이번 회차를 멈췄습니다.' },
        ...(worked(report) ? { counts: counts(report) } : {}),
      };
    }
    return {
      ...tickState,
      ...reached,
      ...(driveReconcile && !driveReconcile.ok ? {problem:{key:driveReconcile.code,message:'Drive 예약을 갱신하지 못했습니다'}} : {}),
      pause: report.stopped !== 'budget',
      ...(worked(report) ? { counts: counts(report) } : {}),
    };
  } catch (error) {
    // The key is the code rather than the sentence: the same bug carries a
    // different path or line each time, and a key that moved would put a line
    // in the log every ten seconds for one broken handler.
    return {
      pause: true,
      ...tickState,
      ...reached,
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
