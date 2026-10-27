import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, watch as fsWatch, type WatchListener } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createBrain,
  runSqliteMigrations,
  SQLITE_SCHEMA_VERSION,
  sqliteStore,
  type BrainDrainReport,
} from 'second_brain';
import * as configCodec from '../src/config/codec.js';
import { writeConfig } from '../src/config/codec.js';
import {
  HOME_ENV,
  RUN_FOLDER,
  configFilePath,
  daemonLogPath,
  daemonLogRotatedPath,
  daemonPidPath,
  heartbeatPath,
} from '../src/config/paths.js';
import { readDaemonLock } from '../src/daemon/lock.js';
import { DAEMON_LOG_MAX_BYTES } from '../src/daemon/log.js';
import { startHeartbeat } from '../src/daemon/heartbeat.js';
import {
  DAEMON_DRAIN_BUDGET_MS,
  DAEMON_DRAIN_PAUSE_MS,
  DAEMON_HEARTBEAT_MS,
  runDaemon,
  type RunDaemonOptions,
} from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { withoutHarnessFolders } from './environment.js';
import { assertKoreanLines } from './language.js';
import { tempHomes } from './temp-home.js';
import { SECRETS } from './secrets-fixture.js';

/**
 * `brain daemon run`, from both sides.
 *
 * In process, with the timers wound down to milliseconds: the heartbeat, the
 * state-change-only logging, and what a stop leaves behind. Those are facts
 * about the loop, and a test that waited thirty real seconds for a heartbeat
 * would be a test nobody runs.
 *
 * Then through the built binary, which is the only way to check the things that
 * are about a process rather than a function: that stdout stays empty, that a
 * second daemon is refused while the first is alive, that a dead pid is
 * reclaimed, and that `SIGTERM` ends in exit 0 with the lock gone.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const installPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const TWO_TURNS = fileURLToPath(
  new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url),
);
const TWO_TURNS_SESSION = '4f1e7a90-1c2b-4d3e-8f55-000000000000';

vi.mock('second_brain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('second_brain')>();
  return { ...actual, createBrain: vi.fn(actual.createBrain) };
});
const actualCreateBrain = vi.mocked(createBrain).getMockImplementation()!;

const temporary = tempHomes();
const daemonCleanups: (() => Promise<unknown>)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  const stopped = await Promise.allSettled(daemonCleanups.splice(0).map((stop) => stop()));
  vi.restoreAllMocks();
  vi.mocked(createBrain).mockReset();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await temporary.cleanup();
  for (const result of stopped) {
    if (result.status === 'rejected') throw result.reason;
  }
});

beforeAll(() => {
  for (const path of [binPath, installPath]) {
    if (!existsSync(path)) {
      throw new Error(`${path} does not exist. Run \`pnpm build\` before these tests.`);
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `ready` answers true, or say what was still not true. */
async function waitFor(
  what: string,
  ready: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > until) throw new Error(`${what}을 기다리다 시간이 지났습니다`);
    await delay(25);
  }
}

/** The environment every invocation here runs in: one home, no real harness. */
function environment(home: string, configDir?: string): NodeJS.ProcessEnv {
  // `withoutHarnessFolders` last would overwrite the folder this test made,
  // so the isolation goes first and the one folder a case names goes after it.
  const env: NodeJS.ProcessEnv = {
    ...withoutHarnessFolders(process.env),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    [HOME_ENV]: home,
    ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
  };
  delete env['SECOND_BRAIN_DATABASE_URL'];
  delete env['BRAIN_TEST_DATABASE_URL'];
  return env;
}

/** Register shutdown before a caller can fail an assertion or a file read. */
function startDaemon(options: Omit<RunDaemonOptions, 'signal'>, unblock = () => {}) {
  const controller = new AbortController();
  const finished = runDaemon({ ...options, signal: controller.signal });
  const stop = async () => {
    controller.abort();
    unblock();
    return finished;
  };
  daemonCleanups.push(stop);
  return { controller, finished, stop };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('runDaemon, with its timers wound down', () => {
  /** A configuration folder naming a database, which may or may not be there. */
  async function homeFor(options: { migrated: boolean; version?: number }): Promise<string> {
    const home = await temporary.create('brain-daemon-');
    const storePath = join(home, 'brain.db');
    await writeConfig(home, { storePath });
    if (!options.migrated) return home;
    const migrated = await runSqliteMigrations({ path: storePath });
    expect(migrated.ok).toBe(true);
    if (options.version !== undefined) {
      const database = new DatabaseSync(storePath);
      try {
        database.prepare('update schema_version set version = ?').run(options.version);
      } finally {
        database.close();
      }
    }
    return home;
  }

  /** One daemon, with short timers, and the handle to stop it. */
  function start(home: string, over: { heartbeatMs?: number } = {}) {
    return startDaemon({
      home,
      env: environment(home),
      clock: systemClock,
      idGen: uuidV7IdGen(),
      heartbeatMs: over.heartbeatMs ?? 40,
      drainBudgetMs: 200,
      drainPauseMs: 20,
    });
  }

  it('ticks future schedules on a later round and ends one-shots', async () => {
    const home = await homeFor({ migrated: true });
    const path = join(home, 'brain.db');
    let at = new Date('2026-02-03T04:05:06.000Z');
    const due = new Date(at.getTime() + 60000);
    const store = sqliteStore({ path });
    await store.addSchedule({ id: 'once', kind: 'schedule_probe', targetKind: 'probe', targetId: 'once',
      intervalSeconds: null, nextRunAt: due, lastRunAt: null, createdAt: at });
    await store.close();
    let rounds = 0;
    const daemon = startDaemon({ home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), drainPauseMs: 20, heartbeatMs: 40,
      createStore: options => { rounds++; return sqliteStore(options); } });
    await waitFor('시각 전 회차', () => rounds >= 2);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare('select * from work_items').all()).toHaveLength(0);
      at = new Date(due.getTime() + 1000);
      await waitFor('예약 처리', () => !!db.prepare('select id from work_items where completed_at is not null').get());
      const firedRound = rounds;
      at = new Date(at.getTime() + 500000);
      await waitFor('발화 뒤 여러 회차', () => rounds >= firedRound + 3);
      expect(db.prepare('select * from work_items').all()).toHaveLength(1);
      expect(db.prepare('select next_run_at from schedules').get()).toEqual({ next_run_at: null });
    } finally { db.close(); await daemon.stop(); }
  });

  it('rolls back failing ticks, logs once, keeps draining and recovers one missed recurrence', async () => {
    const home = await homeFor({ migrated: true });
    const path = join(home, 'brain.db');
    const at = new Date('2026-02-03T04:05:06.000Z');
    const due = new Date(at.getTime() - 185000);
    const store = sqliteStore({ path });
    await store.addSchedule({ id: 'repeat', kind: 'schedule_probe', targetKind: 'probe', targetId: 'repeat',
      intervalSeconds: 60, nextRunAt: due, lastRunAt: null, createdAt: due });
    await store.addWork({ id: 'independent', kind: 'schedule_probe', targetKind: 'probe', targetId: 'other',
      createdAt: at, nextAttemptAt: at });
    await store.close();
    const db = new DatabaseSync(path);
    db.exec("create trigger reject_tick before update on schedules begin select raise(abort, 'refused'); end");
    let rounds = 0;
    const daemon = startDaemon({ home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), drainPauseMs: 20, heartbeatMs: 40,
      createStore: options => { rounds++; return sqliteStore(options); } });
    try {
      await waitFor('실패 회차 반복', () => rounds >= 4);
      expect(db.prepare("select * from work_items where target_id='repeat'").all()).toHaveLength(0);
      expect(db.prepare('select next_run_at,last_run_at from schedules').get()).toEqual({ next_run_at: due.toISOString(), last_run_at: null });
      expect(db.prepare("select completed_at from work_items where id='independent'").get()).toEqual({ completed_at: at.toISOString() });
      const logs = await readFile(daemonLogPath(home), 'utf8');
      expect(logs.match(/예약 틱 실패/g)).toHaveLength(1);
      expect(logs).toContain('DB_UNAVAILABLE');
      // A skipped tick (schema mismatch) must not reset the tick failure state.
      db.exec('update schema_version set version = 8');
      const mismatched = rounds;
      await waitFor('스키마 불일치 회차', () => rounds >= mismatched + 2);
      db.exec('update schema_version set version = 9');
      const restored = rounds;
      await waitFor('스키마 복구 뒤 실패 회차', () => rounds >= restored + 2);
      expect((await readFile(daemonLogPath(home), 'utf8')).match(/예약 틱 실패/g)).toHaveLength(1);
      db.exec('drop trigger reject_tick');
      await waitFor('복구 후 예약 처리', () => !!db.prepare("select id from work_items where target_id='repeat' and completed_at is not null").get());
      const recovered = rounds;
      await waitFor('복구 뒤 회차', () => rounds >= recovered + 2);
      expect(db.prepare("select * from work_items where target_id='repeat'").all()).toHaveLength(1);
      expect(db.prepare('select next_run_at,last_run_at from schedules').get()).toEqual({
        next_run_at: new Date(at.getTime() + 60000).toISOString(), last_run_at: at.toISOString() });
      expect(await readFile(daemonLogPath(home), 'utf8')).toContain('예약 1건 발화, 새 일감 1건');
      db.prepare('update schedules set next_run_at = ?').run(at.toISOString());
      db.exec("create trigger reject_tick before update on schedules begin select raise(abort, 'refused'); end");
      await waitFor('새 예약 실패 기록', async () =>
        ((await readFile(daemonLogPath(home), 'utf8')).match(/예약 틱 실패/g) ?? []).length === 2);

    } finally { db.close(); await daemon.stop(); }
  });

  it('declares the constants the plan fixed, in milliseconds', () => {
    // Thirty seconds, and ten for the budget so a normal stop finishes inside
    // launchd's default `ExitTimeOut` of twenty (Boundaries).
    expect(DAEMON_HEARTBEAT_MS).toBe(30_000);
    expect(DAEMON_DRAIN_BUDGET_MS).toBe(10_000);
    expect(DAEMON_DRAIN_PAUSE_MS).toBe(10_000);
  });

  it('does not open a store when aborted during the round configuration read', async () => {
    const home = await homeFor({ migrated: true });
    const config = await configCodec.readConfig(home);
    const reading = gate();
    let entered = false;
    vi.spyOn(configCodec, 'readConfig')
      .mockResolvedValueOnce(config)
      .mockImplementation(async () => {
        entered = true;
        await reading.promise;
        return config;
      });
    const createStore = vi.fn(sqliteStore);
    const daemon = startDaemon({
      home, env: environment(home), clock: systemClock, idGen: uuidV7IdGen(),
      heartbeatMs: 40, createStore,
    }, reading.release);

    await waitFor('회차 설정 읽기', () => entered);
    daemon.controller.abort();
    reading.release();

    expect(await daemon.finished).toEqual({ ok: true });
    expect(createStore).not.toHaveBeenCalled();
    expect(createBrain).not.toHaveBeenCalled();
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('closes the store without draining when aborted during the schema check', async () => {
    const home = await homeFor({ migrated: true });
    const store = sqliteStore({ path: join(home, 'brain.db') });
    const readSchemaVersion = store.readSchemaVersion.bind(store);
    const checking = gate();
    let entered = false;
    vi.spyOn(store, 'readSchemaVersion').mockImplementation(async () => {
      entered = true;
      await checking.promise;
      return readSchemaVersion();
    });
    const close = vi.spyOn(store, 'close');
    const daemon = startDaemon({
      home, env: environment(home), clock: systemClock, idGen: uuidV7IdGen(),
      heartbeatMs: 40, createStore: () => store,
    }, checking.release);

    await waitFor('스키마 확인', () => entered);
    daemon.controller.abort();
    checking.release();

    expect(await daemon.finished).toEqual({ ok: true });
    expect(createBrain).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('keeps tick logs but does not drain when aborted during a schedule firing', async () => {
    const home = await homeFor({ migrated: true });
    const store = sqliteStore({ path: join(home, 'brain.db') });
    const at = new Date('2026-02-03T04:05:06.000Z');
    expect((await store.addSchedule({ id: 'abort-tick', kind: 'schedule_probe', targetKind: 'probe',
      targetId: 'abort-tick', intervalSeconds: null, nextRunAt: at, lastRunAt: null, createdAt: at })).ok).toBe(true);
    const controller = new AbortController();
    const fireSchedule = store.fireSchedule.bind(store);
    vi.spyOn(store, 'fireSchedule').mockImplementation(async input => {
      const result = await fireSchedule(input);
      controller.abort();
      return result;
    });
    const claim = vi.spyOn(store, 'claimWork');
    const close = vi.spyOn(store, 'close');
    const drain = vi.fn();
    vi.mocked(createBrain).mockImplementation(dependencies => {
      const brain = actualCreateBrain(dependencies);
      brain.queue.drain = drain;
      return brain;
    });
    const finished = runDaemon({ home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), signal: controller.signal, heartbeatMs: 40, createStore: () => store });
    daemonCleanups.push(async () => { controller.abort(); await finished; });

    expect(await finished).toEqual({ ok: true });
    expect(store.fireSchedule).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(daemonLogPath(home), 'utf8')).toContain('예약 1건 발화, 새 일감 1건');
    expect(existsSync(daemonPidPath(home))).toBe(false);
    const db = new DatabaseSync(join(home, 'brain.db'));
    try {
      expect(db.prepare('select attempts, completed_at from work_items').all())
        .toEqual([{ attempts: 0, completed_at: null }]);
    } finally { db.close(); }
  });

  it.each(['budget', 'empty', 'unwritable'] as const)(
    'schedules the next round correctly after %s',
    async (stopped) => {
      const home = await homeFor({ migrated: true });
      const empty: BrainDrainReport = {
        stopped: 'empty', claimed: 0, completed: 0, retried: 0, failed: 0,
        released: 0, lost: 0, spooled: 0, replayed: 0, spoolFailed: 0,
        enqueued: 0, rereadMissing: 0, reextractRedacted: 0, reextractUnreachable: 0,
      };
      const drain = vi.fn<ReturnType<typeof createBrain>['queue']['drain']>()
        .mockResolvedValue(empty)
        .mockResolvedValueOnce({ ...empty, stopped });
      vi.mocked(createBrain).mockImplementation((dependencies) => {
        const brain = actualCreateBrain(dependencies);
        brain.queue.drain = drain;
        return brain;
      });
      // Observe the actual pause and release its callback ourselves. The long
      // timer cannot elapse during these assertions; abort also clears it.
      const pauseMs = 60_000;
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const daemon = startDaemon({
        home, env: environment(home), clock: systemClock, idGen: uuidV7IdGen(),
        heartbeatMs: 40, drainBudgetMs: 200, drainPauseMs: pauseMs,
      });
      await waitFor('회차 대기', () => timers.mock.calls.some(([, ms]) => ms === pauseMs));
      const beforePause = stopped === 'budget' ? 2 : 1;
      expect(drain).toHaveBeenCalledTimes(beforePause);
      await delay(50);
      expect(drain).toHaveBeenCalledTimes(beforePause);
      const pauseCall = timers.mock.calls.find(([, ms]) => ms === pauseMs);
      expect(pauseCall).toBeDefined();
      pauseCall?.[0]();
      await waitFor('대기 뒤 다음 회차', () => drain.mock.calls.length === beforePause + 1);
      expect(await daemon.stop()).toEqual({ ok: true });
    },
  );

  it('moves the heartbeat mtime forward every period', async () => {
    const home = await homeFor({ migrated: true });
    const daemon = start(home, { heartbeatMs: 40 });

    await waitFor('heartbeat 파일', () => existsSync(heartbeatPath(home)));
    const marks: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      marks.push((await stat(heartbeatPath(home))).mtimeMs);
      await delay(80);
    }
    const result = await daemon.stop();

    expect(result.ok).toBe(true);
    // Forward every time: the timer is the heartbeat's own, and a drain that
    // found nothing to do does not hold it up.
    expect(marks[1]).toBeGreaterThan(marks[0] ?? 0);
    expect(marks[2]).toBeGreaterThan(marks[1] ?? 0);
  });

  it('takes the lock with its own pid, and leaves the heartbeat behind on abort', async () => {
    const home = await homeFor({ migrated: true });
    const daemon = start(home);

    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    const held = JSON.parse(await readFile(daemonPidPath(home), 'utf8')) as { pid: number };
    expect(held.pid).toBe(process.pid);

    const result = await daemon.stop();

    expect(result).toEqual({ ok: true });
    // The lock goes, the heartbeat stays: story 9.3 shows the last one.
    expect(existsSync(daemonPidPath(home))).toBe(false);
    expect(existsSync(heartbeatPath(home))).toBe(true);
  });

  it('writes a start line and a stop line, in Korean', async () => {
    const home = await homeFor({ migrated: true });
    const daemon = start(home);
    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));

    await daemon.stop();

    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log).toContain('데몬을 시작했습니다');
    expect(log).toContain('데몬을 멈췄습니다');
    expect(log).toContain(String(process.pid));
    // Every line is stamped with an instant and then a Korean sentence.
    for (const line of log.trimEnd().split('\n')) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /);
    }
    assertKoreanLines(log, { label: 'daemon.log' });
  });

  it('says a mismatched schema once, however many rounds it runs', async () => {
    const home = await homeFor({ migrated: true, version: 9999 });
    const daemon = start(home);
    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    // Several rounds at a twenty-millisecond pause: a problem said every round
    // would be a log line every ten seconds in real life.
    await delay(300);

    await daemon.stop();

    const lines = (await readFile(daemonLogPath(home), 'utf8')).trimEnd().split('\n');
    expect(lines.filter((line) => line.includes('스키마'))).toHaveLength(1);
    // Still running when it was stopped, and nothing was written to the
    // database it refused (AD-20).
    expect(lines.some((line) => line.includes('데몬을 멈췄습니다'))).toBe(true);
  });

  it('says a database it cannot reach once, and keeps running', async () => {
    const home = await homeFor({ migrated: false });
    const daemon = start(home);
    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    await delay(300);

    const result = await daemon.stop();

    expect(result.ok).toBe(true);
    const lines = (await readFile(daemonLogPath(home), 'utf8')).trimEnd().split('\n');
    expect(lines.filter((line) => line.includes('데이터베이스'))).toHaveLength(1);
    // A runtime process opens the file and never creates it (AD-20).
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });

  it('reports a config made unreadable mid-run once and stops cleanly', async () => {
    const home = await homeFor({ migrated: true });
    const daemon = start(home);
    try {
      await waitFor('시작 줄', async () =>
        existsSync(daemonLogPath(home)) &&
        (await readFile(daemonLogPath(home), 'utf8')).includes('데몬을 시작했습니다'),
      );
      await writeFile(configFilePath(home), 'invalid = [', 'utf8');
      await waitFor('설정 오류', async () =>
        (await readFile(daemonLogPath(home), 'utf8')).includes('TOML로 읽을 수 없습니다'),
      );
      await delay(150);
      expect(existsSync(daemonPidPath(home))).toBe(true);
    } finally {
      expect(await daemon.stop()).toEqual({ ok: true });
    }
    const lines = (await readFile(daemonLogPath(home), 'utf8')).split('\n');
    expect(lines.filter((line) => line.includes('TOML로 읽을 수 없습니다'))).toHaveLength(1);
  });

  it('survives a round that threw, says so once, and stops cleanly', async () => {
    const home = await homeFor({ migrated: true });
    let opened = 0;
    const { controller, finished } = startDaemon({
      home,
      env: environment(home),
      clock: systemClock,
      idGen: uuidV7IdGen(),
      heartbeatMs: 40,
      drainBudgetMs: 200,
      drainPauseMs: 20,
      // Opening the store is the one place in a round that is not already
      // guarded, so this is what a bug anywhere inside a round looks like from
      // the loop's side: an exception on the way out.
      createStore: () => {
        opened += 1;
        throw new Error(`열다 터졌습니다: password: ${SECRETS[4]}`);
      },
    });

    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    await delay(300);
    controller.abort();
    const result = await finished;

    // The process did not die, and the rounds kept coming.
    expect(result).toEqual({ ok: true });
    expect(opened).toBeGreaterThan(1);
    const lines = (await readFile(daemonLogPath(home), 'utf8')).trimEnd().split('\n');
    expect(lines.filter((line) => line.includes('밀린 일 처리 중 오류'))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(SECRETS[4]);
    expect(lines.join('\n')).toContain('[REDACTED:password]');
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('refuses to start a second time while the first holds the lock', async () => {
    const home = await homeFor({ migrated: true });
    const daemon = start(home);
    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));

    const second = await startDaemon({
      home,
      env: environment(home),
      clock: systemClock,
      idGen: uuidV7IdGen(),
      // A pid of its own, so this is not the lock's owner asking.
      isAlive: () => true,
    }).finished;

    expect(second).toMatchObject({ ok: false, code: 'DAEMON_RUNNING', exit: 1 });
    await daemon.stop();
  });

  it('appends a refused start without rotating an oversized log', async () => {
    const home = await homeFor({ migrated: true });
    const firstRound = gate();
    const daemon = startDaemon({
      home, env: environment(home), clock: systemClock, idGen: uuidV7IdGen(),
      createStore: (options) => {
        firstRound.release();
        return sqliteStore(options);
      },
    });
    // A round opens its store only after watcher.retry() has awaited startup logging.
    await firstRound.promise;
    const previous = `${'가'.repeat(DAEMON_LOG_MAX_BYTES)}\n`;
    await writeFile(daemonLogPath(home), previous);
    const second = await startDaemon({
      home, env: environment(home), clock: systemClock, idGen: uuidV7IdGen(),
      isAlive: () => true,
    }).finished;
    expect(second).toMatchObject({ ok: false, code: 'DAEMON_RUNNING', exit: 1 });
    expect(await readFile(daemonLogPath(home), 'utf8')).toMatch(/^가+\n.*데몬/u);
    expect((await readFile(daemonLogPath(home), 'utf8')).startsWith(previous)).toBe(true);
    expect(existsSync(daemonLogRotatedPath(home, 1))).toBe(false);
    await daemon.stop();
  });

  it('answers CONFIG_MISSING and takes no lock where nothing is installed', async () => {
    const home = await temporary.create('brain-daemon-bare-');

    const result = await startDaemon({
      home,
      env: environment(home),
      clock: systemClock,
      idGen: uuidV7IdGen(),
    }).finished;

    expect(result).toMatchObject({ ok: false, code: 'CONFIG_MISSING', exit: 2 });
    // Nothing at all: a daemon that cannot find its database has no right to
    // be the only one.
    expect(existsSync(join(home, RUN_FOLDER))).toBe(false);
  });
});

describe('the heartbeat on its own', () => {
  it('skips overlapping beats and waits for a pending beat when stopped', async () => {
    const parent = await temporary.create('brain-heartbeat-pending-');
    const home = join(parent, 'not-a-folder');
    await writeFile(home, 'not a folder', 'utf8');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let beats = 0;
    const heartbeat = await startHeartbeat({
      home, clock: systemClock, intervalMs: 10,
      log: {
        write: async () => {
          beats += 1;
          if (beats > 1) await blocked;
        },
      },
    });
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await waitFor('진행 중 heartbeat', () => beats === 2);
      await delay(50);
      expect(beats).toBe(2);
      stopping = heartbeat.stop().then(() => { stopped = true; });
      await delay(30);
      expect(stopped).toBe(false);
    } finally {
      release();
      await (stopping ?? heartbeat.stop());
    }
    expect(stopped).toBe(true);
    await delay(30);
    expect(beats).toBe(2);
  });

  it('reports a write it could not make, and keeps the timer', async () => {
    const parent = await temporary.create('brain-heartbeat-');
    // A folder that cannot be created: the run folder's parent is a file.
    const home = join(parent, 'not-a-folder');
    await writeFile(home, 'this is a file where a folder would go', 'utf8');
    const said: string[] = [];

    const heartbeat = await startHeartbeat({
      home,
      clock: systemClock,
      intervalMs: 10_000,
      log: {
        write: async (line) => {
          said.push(line);
        },
      },
    });
    await heartbeat.stop();

    // One line, and `startHeartbeat` returned rather than threw: the heartbeat
    // is evidence about the daemon, not a reason to stop it.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('heartbeat');
    assertKoreanLines(said.join('\n'), { label: 'heartbeat 실패' });
  });
});

describe('brain daemon run, as a process', () => {
  interface Daemon {
    child: ChildProcess;
    stdout: () => string;
    stderr: () => string;
    /** The exit code, once it has one. */
    ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }

  /** One `brain` child, with both streams collected. */
  function spawned(args: readonly string[], env: NodeJS.ProcessEnv, script = binPath): Daemon {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    return {
      child,
      stdout: () => out,
      stderr: () => err,
      ended: new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
    };
  }

  function ran(args: readonly string[], env: NodeJS.ProcessEnv, script = binPath) {
    const run = spawned(args, env, script);
    return run.ended.then(({ code }) => ({ code, stdout: run.stdout(), stderr: run.stderr() }));
  }

  /** One installed brain and one empty harness folder beside it. */
  async function installed(): Promise<{ home: string; configDir: string }> {
    const home = await temporary.create('brain-daemon-run-');
    const configDir = await temporary.create('brain-daemon-claude-');
    const install = await ran(['--yes'], environment(home, configDir), installPath);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    return { home, configDir };
  }

  /** One transcript where the editor would have written it. */
  async function transcript(configDir: string, sessionId: string): Promise<void> {
    const folder = join(configDir, 'projects', '-demo-a');
    await mkdir(folder, { recursive: true });
    const text = (await readFile(TWO_TURNS, 'utf8')).replaceAll(TWO_TURNS_SESSION, sessionId);
    await writeFile(join(folder, `${sessionId}.jsonl`), text, 'utf8');
  }

  function sessionCount(home: string, path = join(home, 'brain.db')): number {
    if (!existsSync(path)) return 0;
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return (database.prepare('select count(*) as n from sessions').get() as { n: number }).n;
    } finally {
      database.close();
    }
  }

  /**
   * A pid that is certainly nobody: a node that did nothing, waited for, so it
   * has been reaped by the time this returns. Arranged rather than invented,
   * because a made-up number may well be somebody else's process.
   */
  async function deadPid(): Promise<number> {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      gone.once('error', reject);
      gone.once('close', () => resolve());
    });
    const pid = gone.pid;
    expect(pid).toBeDefined();
    return pid ?? 0;
  }

  function shortDaemon(home: string, configDir: string, workHandlers = {}, unblock = () => {}) {
    return startDaemon({
      home, env: environment(home, configDir), clock: systemClock,
      idGen: uuidV7IdGen(),
      heartbeatMs: 40, drainBudgetMs: 200, drainPauseMs: 20, workHandlers,
    }, unblock);
  }

  it('fires one missed recurring probe in an installed process and doctor reports schema 9', async () => {
    const { home, configDir } = await installed();
    const path = join(home, 'brain.db');
    const db = new DatabaseSync(path);
    const due = new Date(Date.now() - 185000).toISOString();
    db.prepare('insert into schedules values (?,?,?,?,?,?,?,?)')
      .run('process-repeat', 'schedule_probe', 'probe', 'process-repeat', 60, due, null, due);
    const daemon = spawned(['daemon', 'run'], environment(home, configDir));
    try {
      await waitFor('설치본 예약 처리', () => !!db.prepare("select id from work_items where kind='schedule_probe' and completed_at is not null").get());
      expect(db.prepare("select * from work_items where kind='schedule_probe'").all()).toHaveLength(1);
      const schedule = db.prepare('select next_run_at,last_run_at from schedules').get() as { next_run_at: string; last_run_at: string };
      expect(new Date(schedule.next_run_at).getTime() - new Date(schedule.last_run_at).getTime()).toBe(60000);
      const doctor = await ran(['doctor', 'run', '--json'], environment(home, configDir));
      const report = JSON.parse(doctor.stdout);
      expect(JSON.stringify(report)).toContain('schema-version');
      const schema = report.data.checks.find((check: { id: string }) => check.id === 'schema-version');
      expect(schema).toMatchObject({ status: 'ok' });
      expect(JSON.stringify(schema)).toContain('9');
    } finally { db.close(); daemon.child.kill('SIGTERM'); await daemon.ended; }
  });

  it('collects five writes in one watch batch while the idle pause is long, then closes watchers', async () => {
    const { home, configDir } = await installed();
    await mkdir(join(configDir, 'projects', '-demo-a'), { recursive: true });
    const opened = vi.fn(sqliteStore);
    const closed = vi.fn();
    const daemon = startDaemon({
      home, env: environment(home, configDir), clock: systemClock, idGen: uuidV7IdGen(),
      drainPauseMs: 60_000, watchBatchMs: 500, createStore: opened,
      watch: (folder, options, listener) => {
        const watcher = fsWatch(folder, options, listener);
        watcher.on('close', closed);
        return watcher;
      },
    });
    await waitFor('첫 회차', () => opened.mock.calls.length === 1);
    await delay(100);
    for (let index = 0; index < 5; index += 1) {
      await transcript(configDir, 'batched-session');
      await delay(40);
    }
    await waitFor('감시 수집', () => sessionCount(home) === 1, 5_000);
    await delay(650);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(await daemon.stop()).toEqual({ ok: true });
    await waitFor('감시 닫기', () => closed.mock.calls.length === 1);
  });

  it('retains several batches closed during a drain as one immediate following round', async () => {
    const { home, configDir } = await installed();
    const checking = gate();
    const opened = vi.fn(sqliteStore);
    let change!: WatchListener<string>;
    const daemon = startDaemon({
      home, env: environment(home, configDir), clock: systemClock, idGen: uuidV7IdGen(),
      drainPauseMs: 60_000, watchBatchMs: 30,
      watch: (folder, options, listener) => {
        change = listener;
        // Watch an existing temporary folder while controlling its callbacks.
        return fsWatch(configDir, options, () => {});
      },
      createStore: (options) => {
        const store = opened(options);
        if (opened.mock.calls.length === 1) {
          const read = store.readSchemaVersion.bind(store);
          store.readSchemaVersion = async () => { await checking.promise; return read(); };
        }
        return store;
      },
    }, checking.release);
    await waitFor('진행 중 회차', () => opened.mock.calls.length === 1);
    change('change', 'first.jsonl');
    await delay(60);
    change('change', 'second.jsonl');
    await delay(60);
    expect(opened).toHaveBeenCalledOnce();
    checking.release();
    await waitFor('묶음 뒤 회차', () => opened.mock.calls.length === 2, 2_000);
    await delay(150);
    expect(opened).toHaveBeenCalledTimes(2);
    await daemon.stop();
  });

  it('retries a missing watch root each round and collects after recovery', async () => {
    const { home, configDir } = await installed();
    const daemon = startDaemon({
      home, env: environment(home, configDir), clock: systemClock, idGen: uuidV7IdGen(),
      drainPauseMs: 40, watchBatchMs: 30,
    });
    await waitFor('감시 실패 줄', async () => existsSync(daemonLogPath(home)) &&
      (await readFile(daemonLogPath(home), 'utf8')).includes('파일 감시를 시작하거나'));
    await delay(150);
    expect((await readFile(daemonLogPath(home), 'utf8')).match(/파일 감시를 시작하거나/g)).toHaveLength(1);
    await transcript(configDir, 'recovered-watch');
    await waitFor('복구 수집', () => sessionCount(home) === 1);
    await waitFor('감시 복구 줄', async () =>
      (await readFile(daemonLogPath(home), 'utf8')).includes('파일 감시를 시작했습니다'));
    await daemon.stop();
  });

  it('collects hook-free writes within ten seconds and catches offline writes on restart', async () => {
    const { home, configDir } = await installed();
    await mkdir(join(configDir, 'projects', '-demo-a'), { recursive: true });
    const daemon = spawned(['daemon', 'run'], environment(home, configDir));
    await waitFor('감시 시작', async () => existsSync(daemonLogPath(home)) &&
      (await readFile(daemonLogPath(home), 'utf8')).includes('파일 감시를 시작했습니다'));
    // Let the initial round finish so this transcript must wake the idle loop.
    await delay(250);
    await transcript(configDir, 'watch-process');
    await waitFor('프로세스 감시 수집', () => sessionCount(home) === 1, 9_500);
    daemon.child.kill('SIGTERM');
    expect((await daemon.ended).code).toBe(0);
    await transcript(configDir, 'offline-process');
    const restarted = spawned(['daemon', 'run'], environment(home, configDir));
    await waitFor('재기동 수집', () => sessionCount(home) === 2, 5_000);
    restarted.child.kill('SIGTERM');
    expect((await restarted.ended).code).toBe(0);
  }, 20_000);

  it('uses a newly configured migrated database for subsequent rounds', async () => {
    const { home, configDir } = await installed();
    const oldPath = join(home, 'brain.db');
    const { home: newHome } = await installed();
    const newPath = join(newHome, 'brain.db');
    const opened: string[] = [];
    const daemon = startDaemon({
      home, env: environment(home, configDir), clock: systemClock, idGen: uuidV7IdGen(),
      heartbeatMs: 40, drainBudgetMs: 200, drainPauseMs: 20,
      createStore: (options) => {
        opened.push(options.path);
        return sqliteStore(options);
      },
    });

    await waitFor('이전 데이터베이스 회차', () => opened.includes(oldPath));
    expect((await writeConfig(home, { storePath: newPath })).ok).toBe(true);
    await waitFor('새 데이터베이스 회차', () => opened.includes(newPath));
    await transcript(configDir, 'session-switched');
    await waitFor('새 데이터베이스 수집', () => sessionCount(home, newPath) === 1);
    expect(await daemon.stop()).toEqual({ ok: true });
    expect(sessionCount(home, oldPath)).toBe(0);
    const database = new DatabaseSync(newPath, { readOnly: true });
    try {
      expect(database.prepare('select harness, harness_session_id from sessions').all())
        .toEqual([{ harness: 'claude-code', harness_session_id: 'session-switched' }]);
    } finally {
      database.close();
    }
  });

  it('recovers from a schema mismatch and ingests without restarting', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, 'session-recovered');
    const database = new DatabaseSync(join(home, 'brain.db'));
    database.prepare('update schema_version set version = 2').run();
    const daemon = shortDaemon(home, configDir);
    try {
      await waitFor('스키마 불일치', async () =>
        existsSync(daemonLogPath(home)) &&
        (await readFile(daemonLogPath(home), 'utf8')).includes('스키마'),
      );
      await delay(100);
      expect(sessionCount(home)).toBe(0);
      database.prepare('update schema_version set version = ?').run(SQLITE_SCHEMA_VERSION);
      await waitFor('복구 뒤 수집된 세션', () => sessionCount(home) === 1);
    } finally {
      database.close();
      daemon.controller.abort();
      expect(await daemon.finished).toEqual({ ok: true });
    }
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('waits for an active handler on abort before releasing the lock', async () => {
    const { home, configDir } = await installed();
    const store = sqliteStore({ path: join(home, 'brain.db') });
    try {
      expect((await store.addWork({
        id: 'blocked-work', kind: 'test_blocked', targetKind: 'test', targetId: 'blocked',
        createdAt: new Date(), nextAttemptAt: new Date(),
      })).ok).toBe(true);
    } finally {
      await store.close();
    }
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let handlerFinished = false;
    const daemon = shortDaemon(home, configDir, {
      test_blocked: async () => {
        entered = true;
        await blocked;
        handlerFinished = true;
        return { ok: true as const };
      },
    }, release);
    let resolved = false;
    void daemon.finished.then(() => { resolved = true; });
    try {
      await waitFor('핸들러 진입', () => entered);
      daemon.controller.abort();
      let previous = (await stat(heartbeatPath(home))).mtimeMs;
      for (let beat = 0; beat < 3; beat += 1) {
        await waitFor('막힌 핸들러 동안 heartbeat 갱신', async () =>
          (await stat(heartbeatPath(home))).mtimeMs > previous,
        );
        const current = (await stat(heartbeatPath(home))).mtimeMs;
        expect(current).toBeGreaterThan(previous);
        expect(handlerFinished).toBe(false);
        expect(resolved).toBe(false);
        previous = current;
      }
      expect(resolved).toBe(false);
      expect(existsSync(daemonPidPath(home))).toBe(true);
    } finally {
      release();
      daemon.controller.abort();
      expect(await daemon.finished).toEqual({ ok: true });
    }
    const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
    try {
      expect(database.prepare('select completed_at from work_items where id = ?')
        .get('blocked-work')).toEqual({ completed_at: expect.any(String) });
    } finally {
      database.close();
    }
    expect(existsSync(daemonPidPath(home))).toBe(false);
    expect(await readFile(daemonLogPath(home), 'utf8')).toContain('완료 1건');
  });

  it('starts, says nothing on stdout, and collects the session on the disk', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, 'session-aaaa');

    const daemon = spawned(['daemon', 'run'], environment(home, configDir));

    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    const held = JSON.parse(await readFile(daemonPidPath(home), 'utf8')) as { pid: number };
    expect(held.pid).toBe(daemon.child.pid);
    await waitFor('heartbeat 파일', () => existsSync(heartbeatPath(home)));
    await waitFor('시작 줄', async () =>
      existsSync(daemonLogPath(home)) &&
      (await readFile(daemonLogPath(home), 'utf8')).includes('데몬을 시작했습니다'),
    );
    await waitFor('수집된 세션', () => sessionCount(home) === 1);

    daemon.child.kill('SIGTERM');
    const { code } = await daemon.ended;

    // Exit 0, the lock gone, the heartbeat left, and a stop line in the log.
    expect(code).toBe(0);
    const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
    try {
      expect(database.prepare(
        "select completed_at from work_items where kind = 'session_ingest' and target_id = ?",
      ).get('claude-code:session-aaaa')).toEqual({ completed_at: expect.any(String) });
    } finally {
      database.close();
    }
    expect(existsSync(daemonPidPath(home))).toBe(false);
    expect(existsSync(heartbeatPath(home))).toBe(true);
    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log).toContain('데몬을 멈췄습니다');
    assertKoreanLines(log, { label: 'daemon.log' });
    // The whole point of `envelope: false`: nothing on stdout, ever.
    expect(daemon.stdout()).toBe('');
    assertKoreanLines(daemon.stderr(), { label: 'daemon stderr' });
  });

  it('refuses a second daemon with exit 1 and DAEMON_RUNNING, --json included', async () => {
    const { home, configDir } = await installed();
    const first = spawned(['daemon', 'run'], environment(home, configDir));
    await waitFor('pid 파일', () => existsSync(daemonPidPath(home)));
    const held = await readFile(daemonPidPath(home), 'utf8');

    const second = await ran(['daemon', 'run', '--json'], environment(home, configDir));

    expect(second.code).toBe(1);
    // No envelope on stdout even with `--json`: there is none to write.
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain('DAEMON_RUNNING');
    expect(second.stderr).toContain(String(first.child.pid));
    assertKoreanLines(second.stderr, { label: 'second daemon stderr' });
    // The first daemon's lock is exactly as it was.
    expect(await readFile(daemonPidPath(home), 'utf8')).toBe(held);

    first.child.kill('SIGTERM');
    expect((await first.ended).code).toBe(0);
  });

  it('reclaims a lock left by a process that is gone', async () => {
    const { home, configDir } = await installed();
    const pid = await deadPid();
    await mkdir(join(home, RUN_FOLDER), { recursive: true, mode: 0o700 });
    await writeFile(
      daemonPidPath(home),
      `${JSON.stringify({
        pid,
        boot_at: new Date(Date.now() - 60_000).toISOString(),
        started_at: new Date().toISOString(),
      })}\n`,
      'utf8',
    );

    const daemon = spawned(['daemon', 'run'], environment(home, configDir));

    await waitFor('새 주인', async () => {
      const held = await readDaemonLock(home);
      return held?.pid === daemon.child.pid;
    });

    daemon.child.kill('SIGTERM');
    expect((await daemon.ended).code).toBe(0);
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('answers CONFIG_MISSING with exit 2 and no pid file where nothing is installed', async () => {
    const home = await temporary.create('brain-daemon-bare-');

    const run = await ran(['daemon', 'run'], environment(home));

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('CONFIG_MISSING');
    expect(existsSync(daemonPidPath(home))).toBe(false);
    assertKoreanLines(run.stderr, { label: 'daemon stderr' });
  });

  it('is described by guide schema like every other command', async () => {
    const { home, configDir } = await installed();

    const run = await ran(['guide', 'schema', 'daemon', 'run', '--json'], environment(home, configDir));

    expect(run.code).toBe(0);
    const schema = (
      JSON.parse(run.stdout) as { data?: { commands?: Record<string, unknown>[] } }
    ).data?.commands?.[0];
    expect(schema).toMatchObject({
      ns: 'daemon',
      verb: 'run',
      risk: 'write',
      hook: false,
      dry_run: false,
      required: [],
    });
  });

  it('is the only command whose output changed: queue drain still answers an envelope', async () => {
    const { home, configDir } = await installed();

    const run = await ran(['queue', 'drain', '--json'], environment(home, configDir));

    // The guard of the last acceptance criterion, in one line: a dispatcher
    // branch added for one command must leave every other command's bytes
    // exactly as they were.
    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as { ok: boolean }).ok).toBe(true);
  });
});
