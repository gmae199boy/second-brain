import { cronCalculator } from '../src/runtime/cron.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { holdWorkGroup, releaseWorkGroup, tickSchedules } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { supervisorFixture, pidAlive } from './supervisor-fixture.js';
import { runPgCommand } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
import { HOME_ENV } from '../src/config/paths.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'brain-work-hold-')); const f = await supervisorFixture(home);
  const store = postgresStore({ databaseUrl: f.db.appUrl });
  const env = withoutHarnessFolders({ ...process.env, ...f.env, [HOME_ENV]: home });
  const controller = new AbortController(); let daemon: ReturnType<typeof runDaemon> | undefined;
  const idGen = uuidV7IdGen();
  const run = (args: string[], json = true) => runPgCommand(json ? [...args, '--json'] : args, env);
  const add = async (kind: string, holdGroup?: string) => {
    const now = new Date(); const id = idGen.next();
    const result = await store.addWork({ id, kind, targetKind: 'probe', targetId: id, holdGroup, createdAt: now, nextAttemptAt: now });
    if (!result.ok) throw new Error(result.message); return id;
  };
  return { f, store, run, add,
    start() { daemon = runDaemon({ home, env, clock: systemClock, idGen, signal: controller.signal,
      drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 50, cancelPollMs: 50, cancelGraceMs: 100, groupConfirmMs: 1000 } }); },
    tick: (now: Date) => tickSchedules({ cron: cronCalculator, store, clock: { now: () => now }, idGen, readTimeZone: async () => ({ ok: true, value: 'Asia/Seoul' }) }),
    async close() { controller.abort(); try { await daemon; } finally { await store.close(); await f.close(); await rm(home, { recursive: true, force: true }); } },
  };
}
describe('work hold with PostgreSQL and a real daemon', () => {
  let k: Awaited<ReturnType<typeof fixture>>;
  let probe: string; let scheduleId: string; let due: Date;
  beforeAll(async () => { k = await fixture(); });
  afterAll(async () => { await k?.close(); });
  it('holding testext cancels the running probe, parks queued work and blocks its schedule', async () => {
    probe = await k.f.enqueueProbe(2000, null, 'extension:testext'); k.start();
    await expect.poll(async () => (await k.f.attempts(probe))[0]?.pid, { timeout: 15000 }).toBeTruthy();
    const pid = (await k.f.attempts(probe))[0]!.pid;
    expect(await holdWorkGroup({ store: k.store, clock: systemClock }, { group: 'extension:testext' })).toMatchObject({ held: true });
    await expect.poll(async () => (await k.f.attempts(probe))[0]?.outcome, { timeout: 10000 }).toBe('cancelled');
    await expect.poll(() => pidAlive(pid)).toBe(false);
    expect(await k.f.item(probe)).toMatchObject({ completed_at: null, cancel_requested_at: null, claimed_at: null, current_attempt_token: null, attempts: 0 });
    const automatic = await k.add('testext.job'); const core = await k.add('session_ingest', 'extension:testext');
    const failure = await k.store.recordFailure({ id: uuidV7IdGen().next(), stage: 'session_ingest', fingerprint: 'hold-test', targetKind: 'probe', targetId: core,
      harness: null, sessionId: null, code: 'TEST_FAILURE', message: '시험 실패', occurredAt: new Date() });
    expect(failure.ok).toBe(true);
    expect((await k.run(['queue', 'drain'])).code).toBe(0);
    expect((await k.run(['failures', 'retry'])).code).toBe(0);
    const schedule = await k.run(['schedules', 'add', '--kind', 'testext.daily', '--target-kind', 'probe', '--target-id', 'daily', '--at', '11:00']);
    expect(schedule.code).toBe(0); scheduleId = JSON.parse(schedule.stdout).data.id;
    const read = await k.store.readSchedule({ id: scheduleId }); if (!read.ok || !read.schedule) throw new Error('예약 없음');
    due = new Date(read.schedule.nextRunAt!.getTime() + 1000);
    expect(read.schedule.holdGroup).toBe('extension:testext');
    expect(await k.tick(due)).toMatchObject({ fired: 0, enqueued: 0 });
    expect(await k.store.readSchedule({ id: scheduleId })).toEqual(read);
    const manual = await k.run(['schedules', 'run', scheduleId]); expect(manual.code).toBe(0);
    const manualId = JSON.parse(manual.stdout).data.work_id;
    const listed = await k.run(['queue', 'list']); expect(listed.code).toBe(0);
    const rows = JSON.parse(listed.stdout).data.items;
    for (const id of [probe, automatic, core, manualId]) expect(rows).toContainEqual(expect.objectContaining({ id, state: 'extension_disabled', hold_group: 'extension:testext', attempts: 0 }));
    expect((await k.run(['queue', 'list'], false)).stdout).toContain('보류 중');
    expect((await k.run(['schedules', 'list'], false)).stdout).toContain('보류 중');
    expect(JSON.parse((await k.run(['schedules', 'list'])).stdout).data.schedules[0]).toMatchObject({ hold_group: 'extension:testext' });
    const control = await k.f.enqueueProbe(100); const other = await k.f.enqueueProbe(101, null, 'extension:otherext');
    for (const id of [control, other]) await expect.poll(async () => (await k.f.item(id))?.outcome, { timeout: 15000 }).toBe('succeeded');
    for (const id of [automatic, core, manualId]) expect(await k.f.item(id)).toMatchObject({ completed_at: null, claimed_at: null, attempts: 0 });
  });
  it('releasing testext resumes the parked work', async () => {
    expect(probe).toBeTruthy();
    expect(await releaseWorkGroup({ store: k.store }, { group: 'extension:testext' })).toMatchObject({ released: true });
    await expect.poll(async () => (await k.f.item(probe))?.outcome, { timeout: 15000 }).toBe('succeeded');
    expect((await k.f.attempts(probe)).map(a => a.outcome)).toEqual(['cancelled', 'succeeded']);
    expect(await k.tick(due)).toMatchObject({ fired: 1 });
    expect(await k.tick(due)).toMatchObject({ fired: 0 });
    const schedule = await k.store.readSchedule({ id: scheduleId });
    expect(schedule).toMatchObject({ schedule: { lastRunAt: due } });
  });
});
