import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { installChildGuard } from './child-guard.js';

it('preserves callback, custom Promise and sync contracts, journals calls and restores APIs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-guard-')), path = join(dir, 'children');
  const original = childProcess.execFile;
  const close = installChildGuard(path);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = childProcess.execFile(process.execPath, ['-e', 'process.stdout.write("callback")'], (error, stdout) => error ? reject(error) : resolve(stdout));
      expect(child.pid).toBeGreaterThan(0);
    });
    expect(output).toBe('callback');
    const promise = promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("promise")']);
    expect(promise.child.pid).toBeGreaterThan(0);
    expect((await promise).stdout).toBe('promise');
    expect(childProcess.execFileSync(process.execPath, ['-e', 'process.stdout.write("sync")'], { encoding: 'utf8' })).toBe('sync');
    expect(readFileSync(path, 'utf8').match(/spawned/g)).toHaveLength(3);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
  expect(childProcess.execFile).toBe(original);
});

it('routes a retained Promise wrapper to the next file journal after restoring builtins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'child-guard-reinstall-'));
  const first = join(dir, 'first'), second = join(dir, 'second');
  const closeFirst = installChildGuard(first);
  const retained = promisify(childProcess.execFile);
  closeFirst();
  const before = readFileSync(first, 'utf8');
  const closeSecond = installChildGuard(second);
  try {
    const result = await retained(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(result.stdout).toBe('ok');
    expect(readFileSync(first, 'utf8')).toBe(before);
    expect(readFileSync(second, 'utf8')).toContain('spawned');
  } finally { closeSecond(); rmSync(dir, { recursive: true, force: true }); }
});

it('records one token for callback exec and promisified exec while preserving their child and output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-exec-')), path = join(dir, 'children');
  const close = installChildGuard(path);
  try {
    let callbackPid: number | undefined;
    const result = await new Promise<string>((resolve, reject) => {
      const child = childProcess.exec('printf callback', (error, stdout) => error ? reject(error) : resolve(stdout));
      callbackPid = child.pid; expect(child.pid).toBeGreaterThan(0);
    });
    expect(result).toBe('callback');
    const promise = promisify(childProcess.exec)('printf promise');
    expect(promise.child.pid).toBeGreaterThan(0);
    expect((await promise).stdout).toBe('promise');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { state: string; token?: string; pid?: number });
    const spawned = rows.filter(row => row.state === 'spawned'), pids = rows.filter(row => row.state === 'pid');
    expect(spawned).toHaveLength(2); expect(pids).toHaveLength(2);
    expect(pids.map(row => row.token)).toEqual(spawned.map(row => row.token));
    expect(pids.map(row => row.pid)).toEqual([callbackPid, promise.child.pid]);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});
