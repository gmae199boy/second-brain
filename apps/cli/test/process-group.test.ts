import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { systemProcessLauncher } from '../src/runtime/process-group.js';
const worker = fileURLToPath(new URL('./fixtures/process-worker.mjs', import.meta.url));
it('preserves line order and resolves the exit code after stdout closes', async () => {
  const started = await systemProcessLauncher.start({ command: process.execPath, args: [worker], env: { FAKE_WORKER_PLAN: JSON.stringify({ lines: ['one', 'two', 'three'], code: 7 }) } });
  expect(started.ok).toBe(true); if (!started.ok) return;
  const lines = []; for await (const line of started.handle.lines) lines.push(line);
  expect(lines).toEqual(['one', 'two', 'three']); expect(await started.handle.exited).toEqual({ code: 7, signal: null });
});
it('kills the whole detached group including its grandchild and waits for close', async () => {
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
