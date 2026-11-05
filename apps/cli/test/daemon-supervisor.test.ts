import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { supervisorFixture } from './supervisor-fixture.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { withoutHarnessFolders } from './environment.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { postgresStore } from 'second_brain/postgres';
it('completes a 1500ms probe with one successful attempt and recorded progress', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-'));
  const fixture = await supervisorFixture(home);
  const controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  try {
    const id = await fixture.enqueueProbe(1500);
    running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...fixture.env }, clock: systemClock, idGen: uuidV7IdGen(),
      signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    await expect.poll(async () => (await fixture.item(id))?.completed_at, { timeout: 15000 }).toBeTruthy();
    const attempts = await fixture.attempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'succeeded' });
    expect(attempts[0]?.last_progress_at).toBeTruthy();
    expect(attempts[0]?.finished_at).toBeTruthy();
    expect(new Date(attempts[0]!.finished_at).getTime() - new Date(attempts[0]!.started_at).getTime()).toBeGreaterThanOrEqual(1500);
    expect((await fixture.item(id))?.current_attempt_token).toBeNull();
  } finally {
    controller.abort(); await running; await fixture.close(); await rm(home, { recursive: true, force: true });
  }
});
it('completes core work while a real probe runs, then stores its successful attempt and progress', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-'));
  const fixture = await supervisorFixture(home);
  const controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  try {
    const id = await fixture.enqueueProbe(4000);
    running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...fixture.env }, clock: systemClock, idGen: uuidV7IdGen(),
      signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    await expect.poll(async () => (await fixture.attempts(id))[0]?.last_progress_at, { timeout: 15000 }).toBeTruthy();
    const coreId = uuidV7IdGen().next();
    const now = new Date();
    const store = postgresStore({ databaseUrl: fixture.db.appUrl });
    try {
      expect(await store.addWork({ id: coreId, kind: 'schedule_probe', targetKind: 'probe', targetId: coreId, createdAt: now, nextAttemptAt: now }))
        .toMatchObject({ ok: true, item: { executionClass: 'core' } });
    } finally { await store.close(); }
    await expect.poll(async () => (await fixture.item(coreId))?.completed_at, { timeout: 2000 }).toBeTruthy();
    expect(await fixture.attempts(id)).toMatchObject([{ finished_at: null, outcome: null }]);
    expect((await fixture.item(id))?.completed_at).toBeNull();
    await expect.poll(async () => (await fixture.item(id))?.completed_at, { timeout: 15000 }).toBeTruthy();
    const attempts = await fixture.attempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'succeeded' });
    expect(attempts[0]?.last_progress_at).toBeTruthy();
    expect(attempts[0]?.finished_at).toBeTruthy();
  } finally {
    controller.abort(); await running; await fixture.close(); await rm(home, { recursive: true, force: true });
  }
});
it('queue drain leaves due supervised work untouched without a daemon', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-'));
  const fixture = await supervisorFixture(home);
  try {
    const id = await fixture.enqueueProbe();
    const result = await runPgCommand(['queue', 'drain'], { ...withoutHarnessFolders(process.env), ...fixture.env, [HOME_ENV]: home });
    expect(result.code).toBe(0);
    expect(await fixture.item(id)).toMatchObject({ attempts: 0, claimed_by: null, completed_at: null, current_attempt_token: null });
    expect(await fixture.attempts(id)).toEqual([]);
  } finally { await fixture.close(); await rm(home, { recursive: true, force: true }); }
});

it('runs two keyed probes at once and a third after a slot frees', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-capacity-'));
  const fixture = await supervisorFixture(home);
  const controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  try {
    const ids = await Promise.all([6000, 6001, 6002].map((duration, index) => fixture.enqueueProbe(duration, `account-${index}`)));
    running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...fixture.env }, clock: systemClock, idGen: uuidV7IdGen(),
      signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    await expect.poll(async () => {
      const attempts = (await Promise.all(ids.map(id => fixture.attempts(id)))).flat();
      return attempts.filter(attempt => attempt.last_progress_at && !attempt.finished_at).length;
    }, { timeout: 25000, interval: 20 }).toBe(2);
    const coreId = uuidV7IdGen().next(); const at = new Date();
    const store = postgresStore({ databaseUrl: fixture.db.appUrl });
    try {
      expect(await store.addWork({ id: coreId, kind: 'schedule_probe', targetKind: 'probe', targetId: coreId, createdAt: at, nextAttemptAt: at })).toMatchObject({ ok: true });
    } finally { await store.close(); }
    await expect.poll(async () => (await fixture.item(coreId))?.completed_at, { timeout: 4000, interval: 20 }).toBeTruthy();
    expect((await Promise.all(ids.map(id => fixture.attempts(id)))).flat().filter(attempt => attempt.finished_at === null)).toHaveLength(2);
    await expect.poll(async () => (await Promise.all(ids.map(id => fixture.item(id)))).every(item => item?.completed_at), { timeout: 25000 }).toBe(true);
    const attempts = (await Promise.all(ids.map(id => fixture.attempts(id)))).flat();
    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) expect(attempt.outcome).toBe('succeeded');
    const intervals = attempts.map(attempt => ({ start: new Date(attempt.started_at).getTime(), end: new Date(attempt.finished_at).getTime() })).sort((a, b) => a.start - b.start);
    expect(intervals[1]!.start).toBeLessThan(intervals[0]!.end);
    expect(intervals[2]!.start).toBeGreaterThanOrEqual(Math.min(intervals[0]!.end, intervals[1]!.end));
    const events = intervals.flatMap(interval => [{ at: interval.start, change: 1 }, { at: interval.end, change: -1 }]).sort((a, b) => a.at - b.at || a.change - b.change);
    let open = 0; let maximum = 0;
    for (const event of events) { open += event.change; maximum = Math.max(maximum, open); }
    expect(maximum).toBe(2);
    expect(new Date((await fixture.item(coreId))!.completed_at).getTime()).toBeLessThan(Math.min(intervals[0]!.end, intervals[1]!.end));
  } finally { controller.abort(); await running; await fixture.close(); await rm(home, { recursive: true, force: true }); }
});
it('never overlaps two probes of one key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-serialization-'));
  const fixture = await supervisorFixture(home);
  const controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  try {
    const ids = [await fixture.enqueueProbe(6000, 'account'), await fixture.enqueueProbe(6001, 'account')];
    running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...fixture.env }, clock: systemClock, idGen: uuidV7IdGen(),
      signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
    await expect.poll(async () => (await Promise.all(ids.map(id => fixture.item(id)))).every(item => item?.completed_at), { timeout: 25000 }).toBe(true);
    const attempts = (await Promise.all(ids.map(id => fixture.attempts(id)))).flat();
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) expect(attempt.outcome).toBe('succeeded');
    attempts.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
    expect(new Date(attempts[1]!.started_at).getTime()).toBeGreaterThanOrEqual(new Date(attempts[0]!.finished_at).getTime());
  } finally { controller.abort(); await running; await fixture.close(); await rm(home, { recursive: true, force: true }); }
});

it('passes the database self ID to an actual supervised process probe', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-self-'));
  const fixture = await supervisorFixture(home), controller = new AbortController();
  const worker = join(home, 'probe.mjs'), output = join(home, 'user-id');
  await writeFile(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.PROBE_OUTPUT, process.env.BRAIN_USER_ID ?? 'missing'); console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  let running: ReturnType<typeof runDaemon> | undefined;
  try {
    const id = await fixture.enqueueProbe();
    running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...fixture.env }, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25, probeWorker: { command: process.execPath, args: [worker], env: { PROBE_OUTPUT: output } } } });
    await expect.poll(async () => (await fixture.item(id))?.outcome, { timeout: 15000 }).toBe('succeeded');
    const self = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    expect(await readFile(output, 'utf8')).toBe(self);
  } finally { controller.abort(); await running; await fixture.close(); await rm(home, { recursive: true, force: true }); }
});
