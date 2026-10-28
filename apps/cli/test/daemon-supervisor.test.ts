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
