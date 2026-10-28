import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { supervisorFixture, pidAlive, killGroup } from './supervisor-fixture.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { createProcessInspector } from '../src/runtime/process-inspector.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
const worker = fileURLToPath(new URL('./fixtures/process-worker.mjs', import.meta.url));
const hostPath = fileURLToPath(new URL('./fixtures/daemon-host.mjs', import.meta.url));
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
async function records(path: string): Promise<{ leader?: number; grandchild?: number; term?: number }[]> {
  return readFile(path, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line))).catch(() => []);
}
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'brain-supervisor-cancel-')); const f = await supervisorFixture(home);
  const pidFile = join(home, 'worker-pids.jsonl'); const env = { ...withoutHarnessFolders(process.env), ...f.env, [HOME_ENV]: home };
  const seam = { pollMs: 100, cancelPollMs: 50, cancelGraceMs: 300, groupConfirmMs: 1000,
    probeWorker: { command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ grandchild: true, ignoreTerm: true, pidFile, progressEveryMs: 100 }) } } };
  const controller = new AbortController(); let running: ReturnType<typeof runDaemon> | undefined;
  return { home, f, pidFile, env, seam, controller,
    start(extra = {}) { running = runDaemon({ home, env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal,
      drainPauseMs: 25, heartbeatMs: 100, supervisor: { ...seam, ...extra } }); return running; },
    async close() {
      controller.abort(); try { await running; } finally {
        for (const row of await records(pidFile)) if (row.leader) killGroup(row.leader);
        await f.close(); await rm(home, { recursive: true, force: true });
      }
    },
  };
}
it('queue cancel stops a TERM-ignoring probe and its grandchild with SIGKILL after the grace', async () => {
  const k = await setup();
  try {
    const id = await k.f.enqueueProbe(); k.start();
    await expect.poll(async () => (await records(k.pidFile))[0]?.grandchild, { timeout: 15000 }).toBeTruthy();
    const pids = (await records(k.pidFile))[0]!;
    const command = await new Promise<{ stdout: string; code: number }>(resolve => execFile(process.execPath, [bin, 'queue', 'cancel', id, '--json'], { env: k.env }, (error, stdout) => resolve({ stdout, code: error ? Number(error.code) : 0 })));
    expect(command.code).toBe(0); expect(JSON.parse(command.stdout).data).toEqual({ id, state: 'requested' });
    await expect.poll(async () => (await k.f.item(id))?.outcome, { timeout: 10000 }).toBe('cancelled');
    const attempt = (await k.f.attempts(id))[0]!; const item = (await k.f.item(id))!;
    expect(attempt.outcome).toBe('cancelled'); expect(item.completed_at).toBeTruthy();
    expect(new Date(attempt.finished_at).getTime() - new Date(item.cancel_requested_at).getTime()).toBeGreaterThanOrEqual(300);
    await expect.poll(() => [pidAlive(pids.leader!), pidAlive(pids.grandchild!)]).toEqual([false, false]);
    expect((await records(k.pidFile)).filter(r => r.term).map(r => r.term).sort()).toEqual([pids.leader, pids.grandchild].sort());
  } finally { await k.close(); }
});
it('a restarted daemon cleans the group a SIGKILLed supervisor left, then requeues it', async () => {
  const k = await setup(); let host: ReturnType<typeof spawn> | undefined;
  try {
    const id = await k.f.enqueueProbe();
    host = spawn(process.execPath, [hostPath], { env: { ...k.env, FAKE_SUPERVISOR_OPTIONS: JSON.stringify(k.seam) }, stdio: 'ignore' });
    await expect.poll(async () => (await records(k.pidFile))[0]?.grandchild, { timeout: 15000 }).toBeTruthy();
    const old = (await records(k.pidFile))[0]!; const closed = new Promise(resolve => host!.once('close', resolve));
    host.kill('SIGKILL'); await closed;
    expect(pidAlive(old.leader!)).toBe(true); expect(pidAlive(old.grandchild!)).toBe(true);
    k.start(); await expect.poll(async () => (await k.f.attempts(id)).length, { timeout: 15000 }).toBe(2);
    expect((await k.f.attempts(id))[0]!.outcome).toBe('died');
    await expect.poll(() => [pidAlive(old.leader!), pidAlive(old.grandchild!)]).toEqual([false, false]);
    await expect.poll(async () => (await records(k.pidFile)).filter(r => r.leader).length).toBe(2);
    k.controller.abort();
    await expect.poll(async () => (await k.f.attempts(id))[1]?.outcome, { timeout: 10000 }).toBe('cancelled');
    expect(await k.f.item(id)).toMatchObject({ attempts: 1, completed_at: null, current_attempt_token: null });
    const newer = (await records(k.pidFile)).filter(r => r.leader)[1]!;
    await expect.poll(() => [pidAlive(newer.leader!), pidAlive(newer.grandchild!)]).toEqual([false, false]);
  } finally { host?.kill('SIGKILL'); await k.close(); }
});
it('a restarted daemon does not kill a process that reuses the recorded pid', async () => {
  const k = await setup(); const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  try {
    const id = await k.f.enqueueProbe(); await k.f.claimProcess(id, unrelated.pid!, { startedAt: new Date(0) });
    // Observe recovery without launching a new worker before checking the unrelated group.
    k.start({ probeWorker: { command: '/missing/brain-worker', args: [] }, pollMs: 10000 });
    await expect.poll(async () => (await k.f.attempts(id))[0]?.outcome, { timeout: 15000 }).toBe('died');
    expect(pidAlive(unrelated.pid!)).toBe(true);
  } finally { killGroup(unrelated.pid!); await k.close(); }
});
it('an identity check that fails leaves the attempt unknown and the work unclaimed', async () => {
  const k = await setup(); const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  try {
    const id = await k.f.enqueueProbe(); const token = await k.f.claimProcess(id, unrelated.pid!);
    k.start({ inspector: createProcessInspector({ ps: '/missing/brain-ps' }) });
    await expect.poll(async () => (await k.f.attempts(id))[0]?.outcome, { timeout: 15000 }).toBe('unknown');
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(await k.f.attempts(id)).toHaveLength(1);
    expect(await k.f.item(id)).toMatchObject({ current_attempt_token: token, attempts: 1, completed_at: null });
    expect(pidAlive(unrelated.pid!)).toBe(true);
  } finally { killGroup(unrelated.pid!); await k.close(); }
});
