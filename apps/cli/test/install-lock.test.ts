import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { withHomeInstallLock } from '../src/runtime/install-lock.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function home() { const dir = await mkdtemp(join(tmpdir(), 'brain-lock-test-')); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }
const moduleUrl = pathToFileURL(fileURLToPath(new URL('../dist/runtime/install-lock.js', import.meta.url))).href;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('separate process waits and enters only after the owner releases', async () => {
  const dir = await home(); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = withHomeInstallLock(dir, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await started;
  const script = `import {withHomeInstallLock} from ${JSON.stringify(moduleUrl)}; await withHomeInstallLock(process.argv[1], async()=>process.stdout.write('entered\\n'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; child.stdout.on('data', data => { output += data.toString(); });
  const done = new Promise<number | null>(resolve => child.once('close', resolve));
  await pause(250); expect(output).toBe(''); release(); await first;
  expect(await done).toBe(0); expect(output).toBe('entered\n');
});
it.each(['dead', 'missing', 'corrupt', 'old-live'] as const)('retains %s owner until explicit recovery and permits cancellation', async state => {
  const dir = await home(), lock = join(dir, 'install.lock'); await mkdir(lock);
  if (state !== 'missing') await writeFile(join(lock, 'pid'), state === 'corrupt' ? 'not a pid' : state === 'dead' ? '999999999\n' : `${process.pid}\n`);
  await utimes(lock, new Date(0), new Date(0));
  const controller = new AbortController(); let called = false;
  const waiting = withHomeInstallLock(dir, async () => { called = true; }, controller.signal);
  await pause(200); controller.abort(); await expect(waiting).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(called).toBe(false); expect(await readFile(join(lock, 'pid'), 'utf8').catch(() => '')).toBe(state === 'missing' ? '' : state === 'corrupt' ? 'not a pid' : state === 'dead' ? '999999999\n' : `${process.pid}\n`);
});
it('does not remove a replacement owner when an old owner returns', async () => {
  const dir = await home(), lock = join(dir, 'install.lock');
  await withHomeInstallLock(dir, async () => { await writeFile(join(lock, 'owner'), 'replacement\n'); });
  expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('replacement\n');
});
it('parent death immediately after spawning a surviving writer never permits automatic recovery', async () => {
  const dir = await home();
  const script = `import {spawn} from 'node:child_process'; import {withHomeInstallLock} from ${JSON.stringify(moduleUrl)};
    await withHomeInstallLock(process.argv[1], async()=>{ const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)+'\\n'); await new Promise(()=>{}); });`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const childPid = await new Promise<number>((resolve, reject) => {
    parent.once('error', reject); parent.stdout.once('data', data => resolve(Number(data.toString().trim())));
  });
  cleanups.push(async () => { try { process.kill(childPid, 'SIGKILL'); } catch {} if (parent.exitCode === null) parent.kill('SIGKILL'); });
  const closed = new Promise<void>(resolve => parent.once('close', () => resolve()));
  parent.kill('SIGKILL'); await closed;
  expect(() => process.kill(childPid, 0)).not.toThrow();
  const controller = new AbortController(); let entered = false;
  const next = withHomeInstallLock(dir, async () => { entered = true; }, controller.signal);
  await pause(200); controller.abort();
  await expect(next).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(entered).toBe(false);
  expect(await readFile(join(dir, 'install.lock', 'pid'), 'utf8')).toBe(`${parent.pid}\n`);
});
it('two waiters never own the lock together', async () => {
  const dir = await home(); let active = 0, max = 0;
  await Promise.all(Array.from({ length: 4 }, () => withHomeInstallLock(dir, async () => { active++; max = Math.max(max, active); await pause(30); active--; })));
  expect(max).toBe(1);
});

it('bootstrap hook waits for an extension installer in another process', async () => {
  const dir = await home(), bin = join(dir, 'fake-bin'); await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 1\n'); await chmod(join(bin, 'git'), 0o755);
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const owner = withHomeInstallLock(dir, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); }); await acquired;
  const bootstrap = fileURLToPath(new URL('../../../plugin/bootstrap.mjs', import.meta.url));
  const child = spawn(process.execPath, [bootstrap, '--yes', '--ref', 'a'.repeat(40)], { env: { PATH: bin, SECOND_BRAIN_HOME: dir, HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const done = new Promise<number | null>(resolve => child.once('close', resolve));
  await pause(300); expect(child.exitCode).toBeNull();
  expect(await readFile(join(dir, 'install.lock', 'pid'), 'utf8')).toBe(`${process.pid}\n`);
  release(); await owner; expect(await done).not.toBeNull();
});
it('releases its own lock after a failed operation and lets another operation enter', async () => {
  const dir = await home();
  await expect(withHomeInstallLock(dir, async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
  expect(await withHomeInstallLock(dir, async () => 'next')).toBe('next');
});
