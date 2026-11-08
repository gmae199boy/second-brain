import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { acquireLock } from '../src/slots/lock.js';

it('serializes owners, records wait and owner, times out, and releases idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lock-'));
  let first: Awaited<ReturnType<typeof acquireLock>> | undefined, second: Awaited<ReturnType<typeof acquireLock>> | undefined;
  try {
    first = await acquireLock('hook', { pid: 10, started: 'first' }, 'one', { directory });
    const ownerPath = `${first.path}.owner.json`, recorded = JSON.parse(await readFile(ownerPath, 'utf8'));
    expect(recorded).toEqual(first.owner); expect(recorded.acquiredAt).toEqual(expect.any(String));
    await expect(acquireLock('hook', { pid: 11, started: 'timeout' }, 'timeout', { directory, timeoutMs: 100 })).rejects.toThrow('lock wait timed out');
    let acquired = false;
    const pending = acquireLock('hook', { pid: 12, started: 'second' }, 'two', { directory, timeoutMs: 10_000 }).then(lock => { acquired = true; return lock; });
    await new Promise(resolve => setTimeout(resolve, 150)); expect(acquired).toBe(false);
    await first.release(); await first.release();
    second = await pending; expect(second.waitMs).toBeGreaterThan(0); expect(second.owner.runId).toBe('two');
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual(second.owner);
    await second.release(); await second.release();
    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await first?.release(); await second?.release(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('does not delete another owner diagnostic file on release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lock-'));
  try {
    const lock = await acquireLock('hook', { pid: 10, started: 'first' }, 'one', { directory });
    const path = `${lock.path}.owner.json`; await writeFile(path, JSON.stringify({ token: 'different' }));
    await lock.release(); expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('different');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('releases the kernel lock when the owning process is killed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lock-kill-'));
  const modulePath = fileURLToPath(new URL('../dist/slots/lock.js', import.meta.url));
  const script = `import { acquireLock } from ${JSON.stringify(pathToFileURL(modulePath).href)}; await acquireLock('hook', {pid: process.pid, started: 'child'}, 'child', {directory: process.argv[1]}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<void>(resolve => child.once('close', () => resolve()));
  let second: Awaited<ReturnType<typeof acquireLock>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) resolve(); }); child.once('error', reject); child.once('exit', () => reject(new Error('child exited before readiness'))); });
    await expect(acquireLock('hook', { pid: 20, started: 'parent' }, 'parent', { directory, timeoutMs: 100 })).rejects.toThrow('lock wait timed out');
    child.kill('SIGKILL'); await done;
    second = await acquireLock('hook', { pid: 20, started: 'parent' }, 'parent', { directory, timeoutMs: 10_000 });
    expect(second.owner.runId).toBe('parent');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; await second?.release(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
