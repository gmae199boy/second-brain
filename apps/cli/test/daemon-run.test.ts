import { postgresStore, CORE_SCHEMA_VERSION, type PostgresStoreOptions } from 'second_brain/postgres';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, watch as fsWatch, type WatchListener } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PgTestClient } from './pg-client.js';
import { preparePgHome, pgDatabaseUrl, pgAppUrl, runPgCommand } from './pg-home.js';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createBrain,
  type BrainDrainReport,
} from 'second_brain';
import * as brainStore from '../src/runtime/brain-store.js';
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
  const stopped = await Promise.allSettled(daemonCleanups.splice(0).map(async (stop) => (await stop())));
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
  const finished = runDaemon({ supervisor: { disabled: true }, ...options, signal: controller.signal });
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
    await preparePgHome(home);
    const storePath = pgDatabaseUrl(home);
    if (!options.migrated) { const db = new PgTestClient(storePath); await db.exec('drop schema brain cascade'); await db.close(); return home; }
    if (options.version !== undefined) {
      const database = new PgTestClient(storePath);
      try {
        (await database.prepare('update brain.schema_migrations set version = $1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)').run(options.version));
      } finally {
        (await database.close());
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
    const store = postgresStore({ databaseUrl: pgAppUrl(path) });
    await store.addSchedule({ id: '01940000-0000-7000-8000-000000000001', kind: 'schedule_probe', targetKind: 'probe', targetId: '01940000-0000-7000-8000-000000000001',
      triggerKind: 'once' as const, cronExpr: null, runAt: at, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: null, nextRunAt: due, lastRunAt: null, createdAt: at });
    await store.close();
    let rounds = 0;
    const daemon = startDaemon({ home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), drainPauseMs: 20, heartbeatMs: 40,
      createStore: options => { rounds++; return postgresStore(options); } });
    await waitFor('시각 전 회차', () => rounds >= 2);
    const db = new PgTestClient(path);
    try {
      expect((await db.prepare('select * from work_items').all())).toHaveLength(0);
      at = new Date(due.getTime() + 1000);
      await waitFor('예약 처리', async () => !!(await db.prepare('select id from work_items where completed_at is not null').get()));
      const firedRound = rounds;
      at = new Date(at.getTime() + 500000);
      await waitFor('발화 뒤 여러 회차', () => rounds >= firedRound + 3);
      expect((await db.prepare('select * from work_items').all())).toHaveLength(1);
      expect((await db.prepare('select next_run_at from schedules').get())).toEqual({ next_run_at: null });
    } finally { (await db.close()); await daemon.stop(); }
  });

  it('rolls back failing ticks, logs once, keeps draining and recovers one missed recurrence', async () => {
    const home = await homeFor({ migrated: true });
    const path = join(home, 'brain.db');
    const at = new Date('2026-02-03T04:05:06.000Z');
    const due = new Date(at.getTime() - 185000);
    const store = postgresStore({ databaseUrl: pgAppUrl(path) });
    await store.addSchedule({ id: '01940000-0000-7000-8000-000000000002', kind: 'schedule_probe', targetKind: 'probe', targetId: '01940000-0000-7000-8000-000000000002',
      triggerKind: 'interval' as const, cronExpr: null, runAt: null, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: 60, nextRunAt: due, lastRunAt: null, createdAt: due });
    await store.addWork({ id: '01940000-0000-7000-8000-000000000003', kind: 'schedule_probe', targetKind: 'probe', targetId: 'other',
      createdAt: at, nextAttemptAt: at });
    await store.close();
    const db = new PgTestClient(path);
    (await db.exec("create or replace function brain.reject_tick() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$; create trigger reject_tick before update on brain.schedules for each row execute function brain.reject_tick()"));
    let rounds = 0;
    const daemon = startDaemon({ home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), drainPauseMs: 20, heartbeatMs: 40,
      createStore: options => { rounds++; return postgresStore(options); } });
    try {
      await waitFor('실패 회차 반복', () => rounds >= 4);
      expect((await db.prepare("select * from work_items where target_id='01940000-0000-7000-8000-000000000002'").all())).toHaveLength(0);
      expect((await db.prepare('select next_run_at,last_run_at from schedules').get())).toEqual({ next_run_at: due.toISOString(), last_run_at: null });
      expect((await db.prepare("select completed_at from work_items where id='01940000-0000-7000-8000-000000000003'").get())).toEqual({ completed_at: at.toISOString() });
      const logs = await readFile(daemonLogPath(home), 'utf8');
      expect(logs.match(/예약 틱 실패/g)).toHaveLength(1);
      expect(logs).toContain('DB_UNAVAILABLE');
      // A skipped tick (schema mismatch) must not reset the tick failure state.
      (await db.exec('update brain.schema_migrations set version = version + 1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)'));
      const mismatched = rounds;
      await waitFor('스키마 불일치 회차', () => rounds >= mismatched + 2);
      (await db.exec('update brain.schema_migrations set version = version - 1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)'));
      const restored = rounds;
      await waitFor('스키마 복구 뒤 실패 회차', () => rounds >= restored + 2);
      expect((await readFile(daemonLogPath(home), 'utf8')).match(/예약 틱 실패/g)).toHaveLength(1);
      (await db.exec('drop trigger reject_tick on brain.schedules'));
      await waitFor('복구 후 예약 처리', async () => !!(await db.prepare("select id from work_items where target_id='01940000-0000-7000-8000-000000000002' and completed_at is not null").get()));
      const recovered = rounds;
      await waitFor('복구 뒤 회차', () => rounds >= recovered + 2);
      expect((await db.prepare("select * from work_items where target_id='01940000-0000-7000-8000-000000000002'").all())).toHaveLength(1);
      expect((await db.prepare('select next_run_at,last_run_at from schedules').get())).toEqual({
        next_run_at: new Date(due.getTime() + 240000).toISOString(), last_run_at: at.toISOString() });
      expect(await readFile(daemonLogPath(home), 'utf8')).toContain('예약 1건 발화, 새 일감 1건');
      (await db.prepare('update schedules set next_run_at = $1').run(at.toISOString()));
      (await db.exec("create or replace function brain.reject_tick() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$; create trigger reject_tick before update on brain.schedules for each row execute function brain.reject_tick()"));
      await waitFor('새 예약 실패 기록', async () =>
        ((await readFile(daemonLogPath(home), 'utf8')).match(/예약 틱 실패/g) ?? []).length === 2);

    } finally { (await db.close()); await daemon.stop(); }
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
    const createStore = vi.fn(postgresStore);
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
    const store = postgresStore({ databaseUrl: pgAppUrl(join(home, 'brain.db')) });
    const readSchemaVersions = store.readSchemaVersions.bind(store);
    const checking = gate();
    let entered = false;
    vi.spyOn(store, 'readSchemaVersions').mockImplementation(async () => {
      entered = true;
      await checking.promise;
      return readSchemaVersions();
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

  it('drains unrelated work even when Drive schedule reconciliation fails', async () => {
    const home = await homeFor({ migrated: true });
    const store = postgresStore({ databaseUrl: pgAppUrl(join(home, 'brain.db')) });
    await store.ensureSource({id:'01940000-0000-7000-8000-000000000071',kind:'drive',account:'synthetic-a',rootId:'a'});
    await store.ensureSource({id:'01940000-0000-7000-8000-000000000072',kind:'drive',account:'synthetic-b',rootId:'b'});
    const at = new Date('2026-02-03T04:05:06.000Z');
    await store.addWork({id:'01940000-0000-7000-8000-000000000073',kind:'unrelated_probe',targetKind:'probe',targetId:'probe',createdAt:at,nextAttemptAt:at});
    const controller = new AbortController();let ran=false;
    const finished=runDaemon({supervisor:{disabled:true},home,env:environment(home),clock:{now:()=>at},idGen:uuidV7IdGen(),signal:controller.signal,heartbeatMs:40,createStore:()=>store,workHandlers:{unrelated_probe:async()=>{ran=true;controller.abort();return {ok:true};}}});
    daemonCleanups.push(async()=>{controller.abort();await finished;});
    await waitFor('무관한 일감 처리',()=>ran);expect(await finished).toEqual({ok:true});expect(ran).toBe(true);
  });

  it('keeps tick logs but does not drain when aborted during a schedule firing', async () => {
    const home = await homeFor({ migrated: true });
    const store = postgresStore({ databaseUrl: pgAppUrl(join(home, 'brain.db')) });
    const at = new Date('2026-02-03T04:05:06.000Z');
    expect((await store.addSchedule({ id: '01940000-0000-7000-8000-000000000004', kind: 'schedule_probe', targetKind: 'probe',
      targetId: '01940000-0000-7000-8000-000000000004', triggerKind: 'once' as const, cronExpr: null, runAt: at, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: null, nextRunAt: at, lastRunAt: null, createdAt: at })).ok).toBe(true);
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
    const finished = runDaemon({ supervisor: { disabled: true }, home, env: environment(home), clock: { now: () => new Date(at) },
      idGen: uuidV7IdGen(), signal: controller.signal, heartbeatMs: 40, createStore: () => store });
    daemonCleanups.push(async () => { controller.abort(); await finished; });

    expect(await finished).toEqual({ ok: true });
    expect(store.fireSchedule).toHaveBeenCalledOnce();
    expect(drain).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(await readFile(daemonLogPath(home), 'utf8')).toContain('예약 1건 발화, 새 일감 1건');
    expect(existsSync(daemonPidPath(home))).toBe(false);
    const db = new PgTestClient(join(home, 'brain.db'));
    try {
      expect((await db.prepare('select attempts, completed_at from work_items').all()))
        .toEqual([{ attempts: 0, completed_at: null }]);
    } finally { (await db.close()); }
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
    expect(lines.filter((line) => line.includes('데이터베이스 확인 실패'))).toHaveLength(1);
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
        return postgresStore(options);
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
    if (args[0] === 'doctor') return runPgCommand(args, env);
  const run = spawned(args, env, script);
    return run.ended.then(({ code }) => ({ code, stdout: run.stdout(), stderr: run.stderr() }));
  }

  /** One installed brain and one empty harness folder beside it. */
  async function installed(): Promise<{ home: string; configDir: string }> {
    const home = await temporary.create('brain-daemon-run-');
    const configDir = await temporary.create('brain-daemon-claude-');
    await preparePgHome(home);
    return { home, configDir };
  }

  /** One transcript where the editor would have written it. */
  async function transcript(configDir: string, sessionId: string): Promise<void> {
    const folder = join(configDir, 'projects', '-demo-a');
    await mkdir(folder, { recursive: true });
    const text = (await readFile(TWO_TURNS, 'utf8')).replaceAll(TWO_TURNS_SESSION, sessionId);
    await writeFile(join(folder, `${sessionId}.jsonl`), text, 'utf8');
  }

  async function sessionCount(home: string, path = join(home, 'brain.db')): Promise<number> {
    const database = new PgTestClient(path);
    try {
      return ((await database.prepare('select count(*) as n from sessions').get()) as { n: number }).n;
    } finally {
      (await database.close());
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

  it('fires one missed recurring probe in an installed process and doctor reports PG core schema', async () => {
    const { home, configDir } = await installed();
    const path = join(home, 'brain.db');
    const db = new PgTestClient(path);
    const due = new Date(Date.now() - 185000).toISOString();
    let daemon: Daemon | undefined;
    try {
      await db.prepare(`insert into schedules
        (id, kind, target_kind, target_id, interval_seconds, next_run_at, last_run_at, created_at, trigger_kind, user_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'interval',$9)`)
        .run('01940000-0000-7000-8000-000000000005', 'schedule_probe', 'probe', '01940000-0000-7000-8000-000000000005', 60, due, null, due, '01940000-0000-7000-8000-00000000000a');
      daemon = spawned(['daemon', 'run'], environment(home, configDir));
      await waitFor('설치본 예약 처리', async () => !!(await db.prepare("select id from work_items where kind='schedule_probe' and completed_at is not null").get()));
      expect((await db.prepare("select * from work_items where kind='schedule_probe'").all())).toHaveLength(1);
      const schedule = (await db.prepare('select next_run_at,last_run_at from schedules').get()) as { next_run_at: string; last_run_at: string };
      const firedAt = new Date(schedule.last_run_at).getTime();
      const dueAt = new Date(due).getTime();
      const nextAt = dueAt + (Math.floor((firedAt - dueAt) / 60000) + 1) * 60000;
      expect(new Date(schedule.next_run_at).getTime()).toBe(nextAt);
      const doctor = await ran(['doctor', 'run', '--json'], environment(home, configDir));
      const report = JSON.parse(doctor.stdout);
      expect(JSON.stringify(report)).toContain('schema-version');
      const schema = report.data.checks.find((check: { id: string }) => check.id === 'schema-version');
      expect(schema).toMatchObject({ status: 'ok' });
      expect(JSON.stringify(schema)).toContain(String(CORE_SCHEMA_VERSION));
    } finally { if (daemon) { daemon.child.kill('SIGTERM'); await daemon.ended; } await db.close(); }
  });

  it('collects five writes in one watch batch while the idle pause is long, then closes watchers', async () => {
    const { home, configDir } = await installed();
    await mkdir(join(configDir, 'projects', '-demo-a'), { recursive: true });
    const opened = vi.fn(postgresStore);
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
    await waitFor('감시 수집', async () => (await sessionCount(home)) === 1, 5_000);
    await delay(650);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(await daemon.stop()).toEqual({ ok: true });
    await waitFor('감시 닫기', () => closed.mock.calls.length === 1);
  });

  it('retains several batches closed during a drain as one immediate following round', async () => {
    const { home, configDir } = await installed();
    const checking = gate();
    const opened = vi.fn(postgresStore);
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
          const read = store.readSchemaVersions.bind(store);
          store.readSchemaVersions = async () => { await checking.promise; return read(); };
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
    await waitFor('복구 수집', async () => (await sessionCount(home)) === 1);
    await waitFor('감시 복구 줄', async () =>
      (await readFile(daemonLogPath(home), 'utf8')).includes('파일 감시를 시작했습니다'));
    await daemon.stop();
  });

  it('collects hook-free writes within ten seconds and catches offline writes on restart', async () => {
    const { home, configDir } = await installed();
    await mkdir(join(configDir, 'projects', '-demo-a'), { recursive: true });
    const daemon = spawned(['daemon', 'run'], environment(home, configDir));
    let restarted: Daemon | undefined;
    try {
      await waitFor('감시 시작', async () => existsSync(daemonLogPath(home)) &&
        (await readFile(daemonLogPath(home), 'utf8')).includes('파일 감시를 시작했습니다'), 4_000);
      // Let the initial round finish so this transcript must wake the idle loop.
      await delay(250);
      await transcript(configDir, 'watch-process');
      await waitFor('프로세스 감시 수집', async () => (await sessionCount(home)) === 1, 9_500);
      daemon.child.kill('SIGTERM');
      expect((await daemon.ended).code).toBe(0);
      await transcript(configDir, 'offline-process');
      restarted = spawned(['daemon', 'run'], environment(home, configDir));
      await waitFor('재기동 수집', async () => (await sessionCount(home)) === 2, 4_000);
      restarted.child.kill('SIGTERM');
      expect((await restarted.ended).code).toBe(0);
    } finally {
      for (const process of [daemon, restarted]) {
        if (process === undefined) continue;
        if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
        await process.ended;
      }
    }
  }, 20_000);

  it('uses a newly configured migrated database for subsequent rounds', async () => {
    const { home, configDir } = await installed();
    const oldPath = pgDatabaseUrl(home);
    const { home: newHome } = await installed();
    const newPath = pgDatabaseUrl(newHome);
    const opened: string[] = [];
    const daemon = startDaemon({
      home, env: environment(home, configDir), clock: systemClock, idGen: uuidV7IdGen(),
      heartbeatMs: 40, drainBudgetMs: 200, drainPauseMs: 20,
      createStore: (options) => {
        opened.push(options.databaseUrl!);
        return postgresStore(options);
      },
    });

    await waitFor('이전 데이터베이스 회차', () => opened.includes(pgAppUrl(oldPath)));
    expect((await writeConfig(home, { storeUrlEnv: 'SWITCHED_DATABASE_URL' })).ok).toBe(true);
    await writeFile(join(home, '.env'), `SWITCHED_DATABASE_URL=${pgAppUrl(newPath)}\n`);
    await waitFor('새 데이터베이스 회차', () => opened.includes(pgAppUrl(newPath)));
    await transcript(configDir, 'session-switched');
    await waitFor('새 데이터베이스 수집', async () => (await sessionCount(home, newPath)) === 1);
    expect(await daemon.stop()).toEqual({ ok: true });
    expect((await sessionCount(home, oldPath))).toBe(0);
    const database = new PgTestClient(newPath);
    try {
      expect((await database.prepare('select harness, harness_session_id from sessions').all()))
        .toEqual([{ harness: 'claude-code', harness_session_id: 'session-switched' }]);
    } finally {
      (await database.close());
    }
  });

  it('recovers from a schema mismatch and ingests without restarting', async () => {
    const { home, configDir } = await installed();
    await transcript(configDir, 'session-recovered');
    const database = new PgTestClient(join(home, 'brain.db'));
    (await database.prepare('update brain.schema_migrations set version = version + 1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)').run());
    const daemon = shortDaemon(home, configDir);
    try {
      await waitFor('스키마 불일치', async () =>
        existsSync(daemonLogPath(home)) &&
        (await readFile(daemonLogPath(home), 'utf8')).includes('스키마'),
      );
      await delay(100);
      expect((await sessionCount(home))).toBe(0);
      (await database.prepare('update brain.schema_migrations set version = $1 where owner=$$core$$ and version=(select max(version) from brain.schema_migrations where owner=$$core$$)').run(CORE_SCHEMA_VERSION));
      await waitFor('복구 뒤 수집된 세션', async () => (await sessionCount(home)) === 1);
    } finally {
      (await database.close());
      daemon.controller.abort();
      expect(await daemon.finished).toEqual({ ok: true });
    }
    expect(existsSync(daemonPidPath(home))).toBe(false);
  });

  it('waits for an active handler on abort before releasing the lock', async () => {
    const { home, configDir } = await installed();
    const store = postgresStore({ databaseUrl: pgAppUrl(join(home, 'brain.db')) });
    try {
      expect((await store.addWork({
        id: '01940000-0000-7000-8000-000000000006', kind: 'test_blocked', targetKind: 'test', targetId: 'blocked',
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
    const database = new PgTestClient(join(home, 'brain.db'));
    try {
      expect((await database.prepare('select completed_at from work_items where id = $1')
        .get('01940000-0000-7000-8000-000000000006'))).toEqual({ completed_at: expect.any(String) });
    } finally {
      (await database.close());
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
    await waitFor('수집된 세션', async () => (await sessionCount(home)) === 1);

    daemon.child.kill('SIGTERM');
    const { code } = await daemon.ended;

    // Exit 0, the lock gone, the heartbeat left, and a stop line in the log.
    expect(code).toBe(0);
    const database = new PgTestClient(join(home, 'brain.db'));
    try {
      expect((await database.prepare(
        "select completed_at from work_items where kind = 'session_ingest' and target_id = $1",
      ).get('claude-code:session-aaaa'))).toEqual({ completed_at: expect.any(String) });
    } finally {
      (await database.close());
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

describe('PostgreSQL daemon reconnect', () => {
  async function pgHome(compose = true) {
    const home = await temporary.create('brain-daemon-reconnect-');
    await writeFile(join(home, 'config.toml'), 'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
    if (compose) {
      await mkdir(join(home, 'postgres'));
      await writeFile(join(home, 'postgres', 'compose.yaml'), '# test placeholder\n');
    }
    return home;
  }
  function options(home: string) {
    return { home, env: { ...environment(home), BRAIN_DATABASE_URL: 'postgresql://unused@127.0.0.1:1/brain' },
      clock: systemClock, idGen: uuidV7IdGen(), drainPauseMs: 15,
      reconnectBackoffMs: { initial: 80, max: 160 } };
  }
  it('backs off despite frequent wake-ups and suppresses repeated compose failures', async () => {
    const home = await pgHome();
    const calls: number[] = [];
    let wake: WatchListener<string> | undefined;
    const runner: NonNullable<RunDaemonOptions['runner']> = async request => {
      calls.push(Date.now());
      expect(request.args.slice(-2)).toEqual(['up', '-d']);
      expect(request.signal).toBeDefined();
      return { ok: false, code: calls.length < 3 ? 'ENOENT' : 'OTHER', stdout: '', stderr: '', message: 'failure' };
    };
    const configDir = join(home, 'claude'); await mkdir(configDir);
    const reads = vi.spyOn(configCodec, 'readConfig');
    const daemon = startDaemon({ ...options(home), env: { ...options(home).env, CLAUDE_CONFIG_DIR: configDir },
      runner, watchBatchMs: 2, watch: (_folder, _options, listener) => { wake = listener; return { on() { return this; }, close() {} } as unknown as ReturnType<typeof fsWatch>; } });
    const timer = setInterval(() => wake?.('change', 'transcript.jsonl'), 4);
    try {
      await waitFor('네 번째 compose 시도', () => calls.length >= 4);
      expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(80);
      expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(160);
      expect(calls[3]! - calls[2]!).toBeGreaterThanOrEqual(160);
      expect(calls[3]! - calls[2]!).toBeLessThan(300);
      expect(reads.mock.calls.length).toBeGreaterThan(calls.length);
    } finally { clearInterval(timer); await daemon.stop(); }
    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log.match(/컨테이너를 다시 띄웁니다/g)).toHaveLength(1);
    expect(log.match(/오류 코드 ENOENT/g)).toHaveLength(1);
    expect(log.match(/오류 코드 OTHER/g)).toHaveLength(1);
    assertKoreanLines(log, { label: 'daemon reconnect' });
  });
  it('reports a missing compose file once without running docker', async () => {
    const home = await pgHome(false); const runner = vi.fn();
    const daemon = startDaemon({ ...options(home), runner });
    await waitFor('설정 파일 없음 안내', async () => (await readFile(daemonLogPath(home), 'utf8').catch(() => '')).includes('설정 파일'));
    await delay(300); await daemon.stop();
    expect(runner).not.toHaveBeenCalled();
    expect((await readFile(daemonLogPath(home), 'utf8')).match(/설정 파일/g)).toHaveLength(1);
  });
  it('uses initial backoff for the first actual calls after the compose file returns', async () => {
    const home = await pgHome(false);
    const initial = 120;
    const calls: number[] = [];
    const reads = vi.spyOn(configCodec, 'readConfig');
    const daemon = startDaemon({ ...options(home), drainPauseMs: 1000,
      reconnectBackoffMs: { initial, max: 960 }, runner: async () => {
        calls.push(Date.now());
        return { ok: true, stdout: '', stderr: '' };
      } });
    try {
      await waitFor('설정 파일 없음 안내', async () =>
        (await readFile(daemonLogPath(home), 'utf8').catch(() => '')).includes('설정 파일'));
      const before = reads.mock.calls.length;
      await delay(initial * 4 + 30);
      // Missing files are rechecked at the initial interval, without spinning.
      expect(reads.mock.calls.length - before).toBeGreaterThanOrEqual(4);
      expect(reads.mock.calls.length - before).toBeLessThanOrEqual(6);
      expect(calls).toHaveLength(0);
      await mkdir(join(home, 'postgres'));
      await writeFile(join(home, 'postgres', 'compose.yaml'), '# restored fixture\n');
      await waitFor('복구 뒤 세 번째 compose 시도', () => calls.length >= 3);
      expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(initial);
      expect(calls[1]! - calls[0]!).toBeLessThan(initial * 2);
      expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(initial * 2);
      expect(calls[2]! - calls[1]!).toBeLessThan(initial * 3);
    } finally { await daemon.stop(); }
    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log.match(/설정 파일/g)).toHaveLength(1);
    expect(log.match(/컨테이너를 다시 띄웁니다/g)).toHaveLength(1);
  });
  it('cancels an active compose and exits independently of the drain budget', async () => {
    const home = await pgHome(); let entered = false; let cancelled = false;
    const daemon = startDaemon({ ...options(home), drainBudgetMs: 60_000,
      runner: request => new Promise(resolve => {
        entered = true;
        request.signal!.addEventListener('abort', () => { cancelled = true;
          resolve({ ok: false, code: 'ABORT_ERR', stdout: '', stderr: '', message: 'cancelled' });
        }, { once: true });
      }) });
    await waitFor('compose 진입', () => entered);
    const before = Date.now(); expect(await daemon.stop()).toEqual({ ok: true });
    expect(Date.now() - before).toBeLessThan(1000); expect(cancelled).toBe(true);
    expect(await readFile(daemonLogPath(home), 'utf8')).not.toContain('ABORT_ERR');
  });
  it('never calls compose when the default URL cannot be resolved', async () => {
    const home = await temporary.create('brain-daemon-sqlite-');
    await writeConfig(home, {});
    const runner = vi.fn(); const daemon = startDaemon({ ...options(home), runner });
    await delay(100); await daemon.stop(); expect(runner).not.toHaveBeenCalled();
  });
  it('never starts compose with the default selector when neither process env nor .env supplies a URL', async () => {
    const home = await temporary.create('brain-daemon-no-url-');
    await writeFile(join(home, 'config.toml'), 'schema_version=1\n');
    await writeFile(join(home, '.env'), '');
    // A compose file is present so missing configuration cannot suppress an up call.
    await mkdir(join(home, 'postgres'));
    await writeFile(join(home, 'postgres', 'compose.yaml'), '# test placeholder\n');
    const env = environment(home);
    expect(env).not.toHaveProperty('BRAIN_DATABASE_URL');
    const runner = vi.fn<NonNullable<RunDaemonOptions['runner']>>(async () => ({ ok: true, stdout: '', stderr: '' }));
    const reads = vi.spyOn(configCodec, 'readConfig');
    const daemon = startDaemon({ ...options(home), env, runner });
    try {
      await waitFor('URL 없는 데몬 회차 완료', async () =>
        reads.mock.calls.length >= 3 &&
        (await readFile(daemonLogPath(home), 'utf8')).includes('데이터베이스 확인 실패'));
    } finally { await daemon.stop(); }
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['DB_LOCKED', 'SCHEMA_MISMATCH', 'DRAIN_THREW', 'CONFIG_INVALID'] as const)('does not restart for %s', async code => {
    const home = await pgHome(); const runner = vi.fn();
    if (code === 'CONFIG_INVALID') await writeFile(join(home, 'config.toml'), 'broken = [');
    else {
      vi.spyOn(brainStore, 'openBrainStore').mockImplementation(async () => {
        const store = postgresStore({ databaseUrl: pgAppUrl(':memory:') });
        vi.spyOn(store, 'readSchemaVersions').mockImplementation(async () => {
          if (code === 'DRAIN_THREW') throw new Error('시험 오류');
          if (code === 'SCHEMA_MISMATCH') return { ok: true as const, versions: { core: { version: 999, appliedAt: new Date() } } };
          return { ok: false as const, code, message: '시험 오류' };
        });
        return { kind: 'postgres', store, expected: { core: CORE_SCHEMA_VERSION }, adapterProbeIds: [] } as unknown as brainStore.BrainStore;
      });
    }
    const daemon = startDaemon({ ...options(home), runner });
    await delay(150); await daemon.stop(); expect(runner).not.toHaveBeenCalled();
  });
  it('resets the backoff after schema recovery', async () => {
    const home = await pgHome(); let unavailable = true;
    const report: BrainDrainReport = { stopped: 'empty', claimed: 0, completed: 0, retried: 0, failed: 0,
      released: 0, lost: 0, spooled: 0, replayed: 0, spoolFailed: 0, enqueued: 0,
      rereadMissing: 0, reextractRedacted: 0, reextractUnreachable: 0 };
    vi.spyOn(brainStore, 'openBrainStore').mockImplementation(async () => {
      const store = postgresStore({ databaseUrl: pgAppUrl(':memory:') });
      vi.spyOn(store, 'listUnhandedChannelRequests').mockResolvedValue({ ok: true, requestIds: [] });
      vi.spyOn(store.imports, 'listUnhandedImports').mockResolvedValue({ ok: true, ids: [] });
      vi.spyOn(store, 'readSchemaVersions').mockImplementation(async () => unavailable
        ? { ok: false as const, code: 'DB_UNAVAILABLE', message: '시험 연결 끊김' }
        : { ok: true as const, versions: { core: { version: CORE_SCHEMA_VERSION, appliedAt: new Date() } } });
      return { kind: 'postgres', store, expected: { core: CORE_SCHEMA_VERSION }, adapterProbeIds: [] } as unknown as brainStore.BrainStore;
    });
    vi.mocked(createBrain).mockImplementation(dependencies => {
      const brain = actualCreateBrain(dependencies);
      brain.schedules.tick = async () => ({ ok: true, fired: 0, enqueued: 0 });
      brain.queue.drain = async () => unavailable ? { ...report, stopped: 'unwritable', code: 'DB_UNAVAILABLE' } : report;
      return brain;
    });
    const calls: number[] = []; const daemon = startDaemon({ ...options(home),
      reconnectBackoffMs: { initial: 100, max: 1000 }, runner: async () => {
        calls.push(Date.now()); return { ok: true, stdout: '', stderr: '' };
      } });
    await waitFor('두 번째 시도', () => calls.length === 2);
    unavailable = false;
    await waitFor('복구 안내', async () => (await readFile(daemonLogPath(home), 'utf8')).includes('다시 닿았습니다'));
    unavailable = true; const lostAt = Date.now();
    await waitFor('새 구간 첫 시도', () => calls.length === 3);
    expect(calls[2]! - lostAt).toBeLessThan(150);
    await waitFor('새 구간 두 번째 시도', () => calls.length === 4);
    expect(calls[3]! - calls[2]!).toBeGreaterThanOrEqual(100);
    expect(calls[3]! - calls[2]!).toBeLessThan(200);
    await daemon.stop();
    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log.match(/컨테이너를 다시 띄웁니다/g)).toHaveLength(2);
    expect(log.match(/다시 닿았습니다/g)).toHaveLength(1);
  });


  it.each(['drain', 'handoff'] as const)('starts a new recovery interval immediately when schema recovers but %s is unavailable', async failure => {
    const home = await pgHome();
    const base = Date.now(); let now = base;
    const calls: number[] = [];
    const controller = new AbortController();
    vi.spyOn(brainStore, 'openBrainStore').mockImplementation(async () => {
      const store = postgresStore({ databaseUrl: pgAppUrl(':memory:') });
      vi.spyOn(store.imports, 'listUnhandedImports').mockResolvedValue({ ok: true, ids: [] });
      vi.spyOn(store, 'listUnhandedChannelRequests').mockResolvedValue(failure === 'handoff'
        ? { ok: false, code: 'DB_UNAVAILABLE', message: '시험 연결 끊김' }
        : { ok: true, requestIds: [] });
      vi.spyOn(store, 'readSchemaVersions').mockImplementation(async () => {
        // Build up a 400ms next retry deadline, then reach PG at 300ms.
        now = base + (calls.length === 1 ? 100 : calls.length >= 2 ? 300 : 0);
        return calls.length < 3
          ? { ok: false as const, code: 'DB_UNAVAILABLE', message: '시험 연결 끊김' }
          : { ok: true as const, versions: { core: { version: CORE_SCHEMA_VERSION, appliedAt: new Date() } } };
      });
      return { kind: 'postgres', store, expected: { core: CORE_SCHEMA_VERSION }, adapterProbeIds: [] } as unknown as brainStore.BrainStore;
    });
    const drain = vi.fn(async (): Promise<BrainDrainReport> => ({
      stopped: 'unwritable', code: 'DB_UNAVAILABLE', claimed: 0, completed: 0, retried: 0, failed: 0,
      released: 0, lost: 0, spooled: 0, replayed: 0, spoolFailed: 0, enqueued: 0,
      rereadMissing: 0, reextractRedacted: 0, reextractUnreachable: 0,
    }));
    vi.mocked(createBrain).mockImplementation(dependencies => {
      const brain = actualCreateBrain(dependencies);
      brain.schedules.tick = async () => ({ ok: true, fired: 0, enqueued: 0 });
      brain.queue.drain = drain;
      return brain;
    });
    const finished = runDaemon({ supervisor: { disabled: true }, ...options(home), signal: controller.signal,
      clock: { now: () => new Date(now) }, drainPauseMs: 1,
      reconnectBackoffMs: { initial: 100, max: 1000 }, runner: async () => {
        calls.push(now);
        if (calls.length === 4) controller.abort();
        return { ok: true, stdout: '', stderr: '' };
      } });
    daemonCleanups.push(async () => { controller.abort(); await finished; });
    await waitFor('복구 직후 즉시 compose 호출', () => calls.length === 4, 1000);
    expect(await finished).toEqual({ ok: true });
    expect(calls).toEqual([base, base + 100, base + 300, base + 300]);
    expect(drain).toHaveBeenCalledTimes(failure === 'drain' ? 1 : 0);
    const log = await readFile(daemonLogPath(home), 'utf8');
    expect(log.match(/데이터베이스에 다시 닿았습니다/g)).toHaveLength(1);
    expect(log.match(/컨테이너를 다시 띄웁니다/g)).toHaveLength(2);
  });

  it.each(['invalid', 'missing-url'] as const)('keeps the normal pause after reconnecting config becomes %s', async transition => {
    const home = await pgHome();
    let now = Date.now();
    const runner = vi.fn(async () => ({ ok: true as const, stdout: '', stderr: '' }));
    const reads = vi.spyOn(configCodec, 'readConfig');
    const daemonOptions = options(home);
    const priorReads = reads.mock.calls.length;
    const daemon = startDaemon({ ...daemonOptions, clock: { now: () => new Date(now) },
      drainPauseMs: 40, reconnectBackoffMs: { initial: 20, max: 20 }, runner });
    await waitFor('첫 재연결 시도', () => runner.mock.calls.length === 1);
    if (transition === 'invalid') await writeFile(join(home, 'config.toml'), 'broken = [');
    else { await writeConfig(home, {}); daemonOptions.env.BRAIN_DATABASE_URL = ''; }
    now += 1000;
    await waitFor('바뀐 설정 회차', () => reads.mock.calls.length > priorReads + 2);
    const before = reads.mock.calls.length;
    await delay(160);
    expect(reads.mock.calls.length - before).toBeLessThanOrEqual(5);
    expect(runner).toHaveBeenCalledOnce();
    await daemon.stop();
  });
  it.each(['missing', 'empty', 'unreadable-env'] as const)('does not restart when the selected URL is %s', async state => {
    const home = await pgHome(); const env: NodeJS.ProcessEnv = { ...options(home).env };
    delete env.BRAIN_DATABASE_URL;
    if (state === 'empty') {
      env.BRAIN_DATABASE_URL = '  ';
      await writeFile(join(home, '.env'), 'BRAIN_DATABASE_URL=postgresql://unused@127.0.0.1:1/brain');
    }
    if (state === 'unreadable-env') await mkdir(join(home, '.env'));
    const runner = vi.fn();
    const reads = vi.spyOn(configCodec, 'readConfig');
    const daemon = startDaemon({ ...options(home), env, runner });
    await waitFor('URL 오류 뒤 반복 회차', () => reads.mock.calls.length >= 4);
    await daemon.stop();
    expect(runner).not.toHaveBeenCalled();
  });

});

it('runs real daemon rounds with persistent Drive auth, 5xx backoff and unrelated work',async()=>{
  const {createIsolatedTestDatabase}=await import('@second-brain/test-db');const {pgHome}=await import('./pg-home.js');const {saveDriveCredentials}=await import('../src/config/codec.js');
  const home=await temporary.create('daemon-drive-round-'),db=await pgHome(home,true,createIsolatedTestDatabase);const store=postgresStore({databaseUrl:db.appUrl});const source='01940000-0000-7000-8000-000000000081',work='01940000-0000-7000-8000-000000000082',other='01940000-0000-7000-8000-000000000083';let now=new Date('2026-01-01T00:00:00Z'),tokens=0,requests=0,otherRan=0,expired=false;
  const controller=new AbortController();let finished:Promise<unknown>|undefined;
  try {
    await saveDriveCredentials(home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});await store.ensureSource({id:source,kind:'drive',account:'synthetic-account',rootId:'root'});await db.query("insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','synthetic-account','2026-01-01Z' from brain.users where is_self=1");
    await store.addWork({id:work,kind:'source_sync',targetKind:'source',targetId:source,createdAt:now,nextAttemptAt:now});await store.addWork({id:other,kind:'unrelated_probe',targetKind:'probe',targetId:'probe',createdAt:now,nextAttemptAt:now});await store.close();
    const network:typeof fetch=async(input)=>{const url=new URL(String(input));if(url.pathname==='/token'){tokens++;return expired?new Response(JSON.stringify({error:'invalid_grant',error_description:'synthetic-secret'}),{status:400}):new Response(JSON.stringify({access_token:'synthetic-access'}));}if(url.pathname==='/drive/v3/changes/startPageToken'){requests++;if(expired)return new Response('synthetic-secret',{status:401});return requests===1?new Response('synthetic-secret',{status:503,headers:{'Retry-After':'120'}}):new Response(JSON.stringify({startPageToken:'cursor'}));}return new Response(JSON.stringify({files:[]}));};
    finished=runDaemon({supervisor:{disabled:true},home,env:{...environment(home),...db.env},clock:{now:()=>new Date(now)},idGen:uuidV7IdGen(),signal:controller.signal,heartbeatMs:40,drainPauseMs:20,driveNetwork:{tokenEndpoint:'http://fake/token',driveBaseUrl:'http://fake',fetch:network},workHandlers:{unrelated_probe:async()=>{otherRan++;return {ok:true};}}});
    daemonCleanups.push(async()=>{controller.abort();await finished;});
    await waitFor('Drive 재시도 등록과 무관 작업',async()=>requests===1&&otherRan===1&&(await db.rows<{attempts:number}>(`select attempts from brain.work_items where id='${work}'`))[0]?.attempts===1);
    const waiting=await db.rows<{next_attempt_at:Date}>(`select next_attempt_at from brain.work_items where id='${work}'`);expect(new Date(waiting[0]!.next_attempt_at).toISOString()).toBe('2026-01-01T00:02:00.000Z');
    now=new Date('2026-01-01T00:01:59Z');await delay(100);expect(requests).toBe(1);now=new Date('2026-01-01T00:02:00Z');await waitFor('Drive 재시도',()=>requests===2);await waitFor('동기화 완료',async()=>(await db.rows<{outcome:string|null}>(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome==='succeeded');
    expect(tokens).toBe(1);expired=true;const failing='01940000-0000-7000-8000-000000000084',again=postgresStore({databaseUrl:db.appUrl});try{expect(await again.addWork({id:failing,kind:'source_sync',targetKind:'source',targetId:source,createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});}finally{await again.close();}
    await waitFor('재동의 필요 비재시도 실패',async()=>(await db.rows<{outcome:string|null}>(`select outcome from brain.work_items where id='${failing}'`))[0]?.outcome==='failed');expect(tokens).toBe(2);expect(await db.rows(`select attempts from brain.work_items where id='${failing}'`)).toEqual([{attempts:1}]);controller.abort();expect(await finished).toEqual({ok:true});const log=await readFile(daemonLogPath(home),'utf8');expect(log).not.toContain('synthetic-secret');expect(log).not.toContain('synthetic-access');expect(JSON.stringify(await db.rows('select last_error from brain.work_items'))).not.toContain('synthetic-secret');
  }finally{controller.abort();await finished;await store.close().catch(()=>{});await db.drop();}
},120000);

it('after public disconnect and same-account reconnect, the next daemon round uses the new consent',async()=>{
 const {createIsolatedTestDatabase}=await import('@second-brain/test-db');const {pgHome}=await import('./pg-home.js');const {saveDriveCredentials}=await import('../src/config/codec.js');const {dispatch}=await import('../src/dispatch.js');const {commands}=await import('../src/commands/index.js');
 const home=await temporary.create('daemon-reconnect-drive-'),db=await pgHome(home,true,createIsolatedTestDatabase),store=postgresStore({databaseUrl:db.appUrl});const source='01940000-0000-7000-8000-000000000091',first='01940000-0000-7000-8000-000000000092',second='01940000-0000-7000-8000-000000000093',at=new Date('2026-01-01T00:00:00Z');const seen:string[]=[];const controller=new AbortController();let finished:Promise<unknown>|undefined;
 const network:typeof fetch=async(input,init)=>{const url=new URL(String(input)),method=init?.method??'GET';if(url.pathname==='/token'){const body=new URLSearchParams(String(init?.body));return new Response(JSON.stringify(body.get('grant_type')==='authorization_code'?{access_token:'connect-access',refresh_token:'fresh-refresh'}:{access_token:body.get('refresh_token')==='fresh-refresh'?'access-fresh':'access-initial'}));}if(url.pathname==='/drive/v3/about')return new Response(JSON.stringify({user:{permissionId:'account'}}));if(url.pathname==='/drive/v3/files/root')return new Response(JSON.stringify({id:'root',mimeType:'application/vnd.google-apps.folder',trashed:false,owners:[{permissionId:'account'}],capabilities:{canListChildren:true}}));if(url.pathname==='/drive/v3/changes/startPageToken'){seen.push(new Headers(init?.headers).get('authorization')??'');return new Response(JSON.stringify({startPageToken:'cursor'}));}if(url.pathname==='/drive/v3/files'&&method==='GET')return new Response(JSON.stringify({files:[]}));return new Response('',{status:404});};
 let samples=0,releaseOld!:()=>void,oldSampled!:()=>void,releaseNext!:()=>void,nextSampled!:()=>void;const oldReady=new Promise<void>(r=>{oldSampled=r;}),oldGate=new Promise<void>(r=>{releaseOld=r;}),nextReady=new Promise<void>(r=>{nextSampled=r;}),nextGate=new Promise<void>(r=>{releaseNext=r;});
 const env={...environment(home),...db.env},driveNetwork={authorizationEndpoint:'https://auth.invalid/authorize',tokenEndpoint:'https://auth.invalid/token',driveBaseUrl:'https://drive.invalid',fetch:network},clock={now:()=>at};
 try{
  await saveDriveCredentials(home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'first-refresh'});await store.ensureSource({id:source,kind:'drive',account:'account',rootId:'root'});await db.query("insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account','2026-01-01Z' from brain.users where is_self=1; insert into brain.settings(user_id,key,value,updated_at) select id,'drive.root_folder_id','root','2026-01-01Z' from brain.users where is_self=1");await store.addWork({id:first,kind:'source_sync',targetKind:'source',targetId:source,createdAt:at,nextAttemptAt:at});await store.close();
  finished=runDaemon({supervisor:{disabled:true},home,env,clock,idGen:uuidV7IdGen(),signal:controller.signal,heartbeatMs:40,drainPauseMs:20,driveNetwork,afterDriveAuthSample:async()=>{samples++;if(samples===2){oldSampled();await oldGate;}else if(samples===3){nextSampled();await nextGate;}}});daemonCleanups.push(async()=>{controller.abort();await finished;});
  await waitFor('첫 daemon sync',async()=>(await db.rows<{outcome:string|null}>(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome==='succeeded');expect(seen).toEqual(['Bearer access-initial']);await oldReady;
  const call=async(args:string[])=>{let out='';await dispatch(commands,[...args,'--json'],{env,clock,driveNetwork,stdout:text=>{out+=text;},stderr:text=>{const match=text.match(/https:\/\/auth\.invalid\/authorize\S+/);if(match){const u=new URL(match[0]),redirect=new URL(u.searchParams.get('redirect_uri')!);redirect.searchParams.set('state',u.searchParams.get('state')!);redirect.searchParams.set('code','synthetic-code');void fetch(redirect);}}});return JSON.parse(out);};
  expect(await call(['sources','disconnect','drive'])).toMatchObject({ok:true});expect(await call(['sources','connect','drive'])).toMatchObject({ok:true,data:{source_id:source}});
  const writer=postgresStore({databaseUrl:db.appUrl});try{expect(await writer.addWork({id:second,kind:'source_sync',targetKind:'source',targetId:source,createdAt:at,nextAttemptAt:at})).toMatchObject({ok:true});}finally{await writer.close();}
  releaseOld();await nextReady;expect(await db.rows(`select attempts,completed_at from brain.work_items where id='${second}'`)).toEqual([{attempts:0,completed_at:null}]);releaseNext();
  await waitFor('재연결 후 첫 daemon sync',async()=>(await db.rows<{outcome:string|null}>(`select outcome from brain.work_items where id='${second}'`))[0]?.outcome==='succeeded');expect(seen).toEqual(['Bearer access-initial','Bearer access-fresh']);controller.abort();expect(await finished).toEqual({ok:true});
 }finally{releaseOld();releaseNext();controller.abort();await finished;await store.close().catch(()=>{});await db.drop();}
},120000);

it('quarantines ambiguous Drive sources in daemon, CLI and SDK while unrelated work proceeds',async()=>{
 const {createIsolatedTestDatabase}=await import('@second-brain/test-db');const {pgHome}=await import('./pg-home.js');const {saveDriveCredentials,readConfig}=await import('../src/config/codec.js');const {dispatch}=await import('../src/dispatch.js');const {commands}=await import('../src/commands/index.js');const {createDriveRuntime}=await import('../src/runtime/drive-runtime.js');const {brainDependencies}=await import('../src/assembly.js');const {EXPECTED_SCHEMA_VERSIONS}=await import('second_brain/postgres');
 const home=await temporary.create('daemon-ambiguous-drive-'),db=await pgHome(home,true,createIsolatedTestDatabase),store=postgresStore({databaseUrl:db.appUrl});const sourceA='01940000-0000-7000-8000-0000000000a1',sourceB='01940000-0000-7000-8000-0000000000a2',work='01940000-0000-7000-8000-0000000000a3',other='01940000-0000-7000-8000-0000000000a4',at=new Date('2026-01-01T00:00:00Z');let remoteCalls=0,otherRan=0;const controller=new AbortController();let finished:Promise<unknown>|undefined;const env={...environment(home),...db.env},clock={now:()=>at},idGen=uuidV7IdGen(),network={tokenEndpoint:'https://fake.invalid/token',driveBaseUrl:'https://fake.invalid',fetch:async()=>{remoteCalls++;return new Response('{}');}};
 try {
  await saveDriveCredentials(home,{clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'});await store.ensureSource({id:sourceA,kind:'drive',account:'account-a',rootId:'a'});await store.ensureSource({id:sourceB,kind:'drive',account:'account-b',rootId:'b'});await db.query(`insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account-a','2026-01-01Z' from brain.users where is_self=1; update brain.sources set cursor='cursor-b' where id='${sourceB}'`);
  const before=await db.rows(`select * from brain.sources where id='${sourceB}'`);let output='';await dispatch(commands,['sources','sync',sourceB,'--json'],{env,clock,driveNetwork:network,stdout:text=>{output+=text;},stderr:()=>{}});expect(JSON.parse(output)).toMatchObject({ok:false});
  const runtime=await createDriveRuntime({home,store,clock,idGen,schemaVersions:EXPECTED_SCHEMA_VERSIONS,network});if(!runtime)throw Error('Drive runtime missing');const config=await readConfig(home),brain=createBrain(brainDependencies({home,env,config,store,clock,idGen,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},sourceSyncFactory:()=>runtime.sourceSync,sourceControl:runtime.control}));expect(await brain.sources.sync({sourceId:sourceB})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
  await store.addWork({id:work,kind:'source_sync',targetKind:'source',targetId:sourceB,createdAt:at,nextAttemptAt:at});await store.addWork({id:other,kind:'unrelated_probe',targetKind:'probe',targetId:'probe',createdAt:at,nextAttemptAt:at});await store.close();
  finished=runDaemon({supervisor:{disabled:true},home,env,clock,idGen,signal:controller.signal,heartbeatMs:40,drainPauseMs:20,driveNetwork:network,workHandlers:{unrelated_probe:async()=>{otherRan++;return {ok:true};}}});daemonCleanups.push(async()=>{controller.abort();await finished;});await waitFor('무관 일감과 격리된 sync',async()=>otherRan===1&&(await db.rows<{attempts:number}>(`select attempts from brain.work_items where id='${work}'`))[0]?.attempts===1);controller.abort();expect(await finished).toEqual({ok:true});expect(remoteCalls).toBe(0);expect(await db.rows(`select * from brain.sources where id='${sourceB}'`)).toEqual(before);expect(await db.rows(`select completed_at from brain.work_items where id='${work}'`)).toEqual([{completed_at:null}]);
  await db.query(`delete from brain.sources where id='${sourceB}'; update brain.settings set value='other-account' where key='drive.account_id'`);let mismatch='';await dispatch(commands,['sources','sync',sourceA,'--json'],{env,clock,driveNetwork:network,stdout:text=>{mismatch+=text;},stderr:()=>{}});expect(JSON.parse(mismatch)).toMatchObject({ok:false});expect(remoteCalls).toBe(0);
 }finally{controller.abort();await finished;await store.close().catch(()=>{});await db.drop();}
},120000);
