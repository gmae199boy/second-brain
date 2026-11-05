import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { systemProcessLauncher } from '../src/runtime/process-group.js';
const worker = fileURLToPath(new URL('./fixtures/process-worker.mjs', import.meta.url));
it('preserves line order and reports the leader exit code', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ lines: ['one', 'two', 'three'], code: 7 }) } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  const lines = []; for await (const line of started.handle.stdout) lines.push(line);
  expect(lines.join('')).toBe('one\ntwo\nthree\n'); expect(await started.handle.exited).toEqual({ code: 7, signal: null });
});
it('kills the whole detached group including its grandchild and waits for leader exit', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: '{"grandchild":true}' } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  try {
    const line = await started.handle.stdout[Symbol.asyncIterator]().next();
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
  const lines = []; for await (const line of started.handle.stdout) lines.push(line);
  expect(lines.join('')).toBe(result + '\n');
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
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen,
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

it('preserves raw unterminated stdout and stderr fragments from a real child', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ raw: '{"abi":1', stderr: 'diagnostic\nlast' }) } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  const collect = async (stream: AsyncIterable<string>) => { let text = ''; for await (const chunk of stream) text += chunk; return text; };
  expect(await Promise.all([collect(started.handle.stdout), collect(started.handle.stderr)])).toEqual(['{"abi":1', 'diagnostic\nlast']);
  expect(await started.handle.exited).toEqual({ code: 0, signal: null });
});
it('backpressures a multi-MiB child while stdout consumption is delayed, then rejects its oversized line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brain-output-backpressure-'));
  const checkpoint = join(directory, 'written.bytes');
  const totalBytes = 16 * 1024 * 1024;
  const source = `const fs = require('node:fs'); let written = 0;
    setTimeout(() => fs.writeFileSync(process.env.CHECKPOINT, String(written)), 300);
    (async () => {
      const chunk = Buffer.alloc(32768, 'x');
      while (written < ${totalBytes}) {
        await new Promise(resolve => process.stdout.write(chunk, resolve));
        written += chunk.length;
      }
    })();`;
  const store = memoryStore(), createdAt = new Date(), idGen = sequenceIdGen({ timestampMs: createdAt.getTime() });
  const controller = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt, nextAttemptAt: createdAt });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen,
    launcher: systemProcessLauncher, inspector: { ...systemProcessInspector,
      async bootTime() { await gate; return systemProcessInspector.bootTime(); },
    }, signal: controller.signal, pollMs: 10, cancelPollMs: 10, cancelGraceMs: 30, groupConfirmMs: 100,
    launches: { process_probe: () => ({ command: process.execPath, args: ['-e', source], env: { CHECKPOINT: checkpoint } }) },
  });
  try {
    let written = 0;
    await expect.poll(async () => {
      written = await readFile(checkpoint, 'utf8').then(Number).catch(() => 0);
      return written;
    }, { timeout: 3000 }).toBeGreaterThan(0);
    // The child has had time to write, but its pipe blocks before all 16 MiB
    // can enter the adapter while identity inspection holds the consumer back.
    expect(written).toBeLessThan(totalBytes);
    expect(store.snapshot().workAttempts[0]!.outcome).toBeNull();
    release();
    await expect.poll(() => store.snapshot().workAttempts[0]?.outcome, { timeout: 3000 }).toBe('failed');
    expect(store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'ABI_LINE_TOO_LONG', errorRetryable: false });
  } finally { release(); controller.abort(); await running; await rm(directory, { recursive: true, force: true }); }
});
it('records ABI_LINE_TRUNCATED and masked stderr from a real supervised child', async () => {
  const store = memoryStore(), createdAt = new Date(), idGen = sequenceIdGen({ timestampMs: createdAt.getTime() }), controller = new AbortController();
  const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt, nextAttemptAt: createdAt });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen,
    launcher: systemProcessLauncher, inspector: systemProcessInspector, signal: controller.signal, pollMs: 10, cancelPollMs: 10, cancelGraceMs: 30, groupConfirmMs: 100,
    launches: { process_probe: () => ({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ raw: '{"abi":1,"type":"res', stderr: 'x'.repeat(20000) + '\nTOKEN=secret-value\n' }) } }) } });
  try {
    await expect.poll(() => store.snapshot().workAttempts[0]?.outcome, { timeout: 3000 }).toBe('failed');
    const attempt = store.snapshot().workAttempts[0]!;
    expect(attempt).toMatchObject({ errorCode: 'ABI_LINE_TRUNCATED', errorRetryable: true, elapsedMs: expect.any(Number) });
    expect(attempt.stderr).not.toBeNull(); expect(attempt.stderr).not.toContain('secret-value');
    expect(Buffer.byteLength(attempt.stderr!)).toBeLessThanOrEqual(4096);
    expect(store.snapshot().workItems[0]!.lastError).toContain('ABI_LINE_TRUNCATED');
    expect(store.snapshot().workItems[0]!.nextAttemptAt.getTime()).toBeGreaterThan(createdAt.getTime());
  } finally { controller.abort(); await running; }
});
it.each(['missing', 'uppercase UUID', 'unpaired range', 'valid'])('probe validates %s environment and emits the ABI error contract', async mode => {
  const env: Record<string, string> = { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain',
    BRAIN_WORK_ID: '019a0000-0000-7000-8000-000000000001', BRAIN_ATTEMPT_TOKEN: '019a0000-0000-7000-8000-000000000002',
    BRAIN_WORK_KIND: 'process_probe', BRAIN_TARGET_KIND: 'probe', BRAIN_TARGET_ID: '0', BRAIN_RUN_GENERATION: '1' };
  if (mode === 'missing') delete env.BRAIN_RUN_GENERATION;
  if (mode === 'uppercase UUID') env.BRAIN_WORK_ID = env.BRAIN_WORK_ID!.toUpperCase();
  if (mode === 'unpaired range') env.BRAIN_RANGE_FROM = '2026-01-01';
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [fileURLToPath(new URL('../dist/workers/process-probe.js', import.meta.url))], env });
  expect(started.ok).toBe(true); if (!started.ok) return;
  let stdout = ''; for await (const chunk of started.handle.stdout) stdout += chunk;
  expect(JSON.parse(stdout)).toMatchObject(mode === 'valid' ? { abi: 1, type: 'result' } : { abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false });
  expect(await started.handle.exited).toEqual({ code: mode === 'valid' ? 0 : 2, signal: null });
});

it('records externally SIGKILLed real children as died and schedules a retry', async () => {
  const store = memoryStore(), createdAt = new Date(), idGen = sequenceIdGen({ timestampMs: createdAt.getTime() }), controller = new AbortController();
  const id = idGen.next(); let handle: ProcessHandle | undefined;
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt, nextAttemptAt: createdAt });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen,
    launcher: { async start(spec) { const started = await systemProcessLauncher.start(spec); if (started.ok) handle = started.handle; return started; } },
    inspector: systemProcessInspector, signal: controller.signal, pollMs: 10, cancelPollMs: 10, cancelGraceMs: 30, groupConfirmMs: 100,
    launches: { process_probe: () => ({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify({abi:1,type:"progress"})+"\\n");setInterval(()=>{},1000)'], env: {} }) } });
  try {
    await expect.poll(() => store.snapshot().workAttempts[0]?.lastProgressAt, { timeout: 3000 }).toBeInstanceOf(Date);
    process.kill(handle!.pid, 'SIGKILL');
    await expect.poll(() => store.snapshot().workAttempts[0]?.outcome, { timeout: 3000 }).toBe('died');
    expect(store.snapshot().workAttempts[0]).toMatchObject({ errorCode: null, errorRetryable: null });
    expect(store.snapshot().workItems[0]).toMatchObject({ completedAt: null, lastError: expect.stringContaining('PROCESS_DIED') });
    expect(store.snapshot().workItems[0]!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime() + 900_000);
  } finally { controller.abort(); await running; handle?.closeOutput(); }
});

it('projects real child diagnostics before storing attempts, failures and logs', async () => {
  const secret = 'SYNTHETIC_VALUE_49';
  const store = memoryStore(); const now = new Date(); const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.recordExtensionInstall({ name: 'testext', version: '1', now, workKinds: ['testext.sync'] });
  const id = idGen.next(); await store.addWork({ id, kind: 'testext.sync', targetKind: 'account', targetId: '1', createdAt: now, nextAttemptAt: now });
  const controller = new AbortController(); const logs: string[] = []; const args: string[][] = [];
  const source = `const x=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values['testext.token']; process.stderr.write(x.slice(0,5)); process.stderr.write(x.slice(5)); const line=JSON.stringify({abi:1,type:'error',code:x,retryable:false,message:x+'\\n'}); process.stdout.write(line.slice(0,9)); process.stdout.write(line.slice(9)+'\\n');`;
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, clock: systemClock, timer: systemTimer, idGen, inspector: systemProcessInspector,
    launcher: { start(spec) { args.push([...spec.args]); return systemProcessLauncher.start(spec); } },
    launches: {}, protectedLaunches: { 'testext.sync': { extension: 'testext', declarations: { 'testext.token': 'string' }, errorCodes: [], async prepare(item, token) { return { ok: true, spec: { command: process.execPath, args: ['-e', source], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: JSON.stringify({ version: 1, extension: 'testext', user_id: '019a0000-0000-7000-8000-000000000001', values: { 'testext.token': secret } }) } } }; } } },
    log: message => { logs.push(message); }, signal: controller.signal, pollMs: 10, cancelPollMs: 10, cancelGraceMs: 30, groupConfirmMs: 100 });
  try {
    await expect.poll(() => store.snapshot().workItems[0]?.outcome, { timeout: 5000 }).toBe('failed');
    const facts = JSON.stringify({ state: store.snapshot(), logs, args });
    expect(facts).not.toContain(secret);
    expect(store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'EXTENSION_WORKER_ERROR', errorRetryable: false, stderr: null });
    expect(store.snapshot().failures[0]).toMatchObject({ code: 'EXTENSION_WORKER_ERROR' });
  } finally { controller.abort(); await running; }
});
