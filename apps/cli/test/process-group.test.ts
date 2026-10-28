import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { systemProcessLauncher } from '../src/runtime/process-group.js';
const worker = fileURLToPath(new URL('./fixtures/process-worker.mjs', import.meta.url));
it('preserves line order and reports the leader exit code', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ lines: ['one', 'two', 'three'], code: 7 }) } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  const lines = []; for await (const line of started.handle.lines) lines.push(line);
  expect(lines).toEqual(['one', 'two', 'three']); expect(await started.handle.exited).toEqual({ code: 7, signal: null });
});
it('kills the whole detached group including its grandchild and waits for leader exit', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: '{"grandchild":true}' } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  try {
    const line = await started.handle.lines[Symbol.asyncIterator]().next();
    const pid = JSON.parse(line.value).grandchild;
    started.handle.signalGroup('SIGKILL');
    expect(await started.handle.exited).toEqual({ code: null, signal: 'SIGKILL' });
    await expect.poll(() => {
      try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().match(/^[^Z]/); }
      catch { return true; }
    }).toBe(true);
  } finally { started.handle.signalGroup('SIGKILL'); }
});
it('reports failed spawn without throwing', async () => {
  expect(await systemProcessLauncher.start({ command: '/missing/worker', args: [], env: {} })).toMatchObject({ ok: false });
});
it('retains a short worker result emitted before output iteration and explicit pipe closure', async () => {
  const result = '{"abi":1,"type":"result","summary":"buffered"}';
  const started = await systemProcessLauncher.start({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(result + '\n')});`], env: {} });
  expect(started.ok).toBe(true); if (!started.ok) return;
  await started.handle.exited;
  expect(started.handle.leaderExited).toBe(true);
  started.handle.closeOutput();
  const lines = []; for await (const line of started.handle.lines) lines.push(line);
  expect(lines).toEqual([result]);
});

// Exercise inherited OS pipes with the supervisor, rather than substituting EOF
// for leader exit in a fake handle.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSupervisor } from '../../../packages/core/src/queue/supervisor.js';
import { memoryStore } from '../../../packages/core/src/testing/fakes/store.js';
import { memorySchemaStore } from '../../../packages/core/src/testing/fakes/schema-store.js';
import { sequenceIdGen } from '../../../packages/core/src/testing/fakes/id-gen.js';
import type { ProcessHandle } from '../../../packages/core/src/ports/process.js';
import { systemProcessInspector } from '../src/runtime/process-inspector.js';
import { systemClock, systemTimer } from '../src/runtime/clock.js';

it.each([false, true])('bounds inherited-pipe waits after leader reaping (escaped descendant: %s)', async escaped => {
  const directory = await mkdtemp(join(tmpdir(), 'brain-inherited-pipes-'));
  const pidFile = join(directory, 'descendant.pid');
  const store = memoryStore(); const createdAt = new Date(); const idGen = sequenceIdGen({ timestampMs: createdAt.getTime() });
  const id = idGen.next(); const controller = new AbortController();
  let handle: ProcessHandle | undefined; let descendant: number | undefined; let signals = 0;
  const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${escaped},stdio:['ignore','inherit','inherit']});
    child.unref(); fs.writeFileSync(process.env.PID_FILE,String(child.pid));
    process.stdout.write('{"abi":1,"type":"result"}\\n',()=>process.exit(0));`;
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt, nextAttemptAt: createdAt });
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen,
    launcher: { async start(spec) { const launched = await systemProcessLauncher.start(spec); if (launched.ok) handle = launched.handle; return launched; } },
    inspector: {
      ...systemProcessInspector,
      // Deliberately postpone iteration until the leader is reaped while the
      // descendant still holds both pipes, including a buffered result line.
      async startedAt(pid) { await handle!.exited; return systemProcessInspector.startedAt(pid); },
      async groupMembers(pgid) { return escaped ? systemProcessInspector.groupMembers(pgid) : { state: 'unknown' as const }; },
      async signalGroup(pgid, signal) { signals++; return systemProcessInspector.signalGroup(pgid, signal); },
    },
    launches: { process_probe: () => ({ command: process.execPath, args: ['-e', source], env: { PID_FILE: pidFile } }) },
    signal: controller.signal, pollMs: 10, cancelPollMs: 10, cancelGraceMs: 30, groupConfirmMs: 100,
  });
  try {
    await expect.poll(() => store.snapshot().workAttempts[0]?.outcome, { timeout: 3000 }).toBe(escaped ? 'succeeded' : 'unknown');
    descendant = Number(await readFile(pidFile, 'utf8'));
    expect(handle!.leaderExited).toBe(true);
    expect(signals).toBe(0);
    expect(() => process.kill(descendant!, 0)).not.toThrow();
    expect(store.snapshot().workItems[0]).toMatchObject(escaped
      ? { outcome: 'succeeded', currentAttemptToken: null }
      : { outcome: null, completedAt: null, currentAttemptToken: expect.any(String) });
  } finally {
    controller.abort(); await running;
    descendant ??= await readFile(pidFile, 'utf8').then(Number).catch(() => undefined);
    if (descendant !== undefined) { try { process.kill(descendant, 'SIGKILL'); } catch {} }
    handle?.closeOutput(); await rm(directory, { recursive: true, force: true });
  }
});
