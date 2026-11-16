import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { lookupProcess } from '../src/slots/ledger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ownedDocker } from '../src/slots/owned-command.js';
import { installChildGuard } from './child-guard.js';

it('identifies docker operation and exit code without embedding arguments in the error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-command-error-')), previousPath = process.env.PATH;
  await writeFile(join(dir, 'docker'), '#!/bin/sh\nprintf output\nprintf diagnostic >&2\nexit 72\n'); await chmod(join(dir, 'docker'), 0o700);
  process.env.PATH = `${dir}:${previousPath}`;
  try {
    const error = await ownedDocker(['rm', '--password=synthetic-secret']).then(() => undefined, reason => reason as Error & { code: number; stdout: string; stderr: string });
    expect(error?.message).toBe('docker rm exited 72'); expect(error?.message).not.toContain('synthetic-secret');
    expect(error).toMatchObject({ code: 72, stdout: 'output', stderr: 'diagnostic' });
    const unknown = await ownedDocker(['synthetic-secret']).then(() => undefined, reason => reason as Error);
    expect(unknown?.message).toBe('docker command exited 72');
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); }
}, 15000);

it('records the gated child and group termination using the same token and PID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-command-')), journal = join(dir, 'processes'), children = join(dir, 'children');
  const previousPath = process.env.PATH, previousLog = process.env.BRAIN_TEST_PROCESS_LOG;
  await writeFile(join(dir, 'docker'), '#!/bin/sh\nprintf owned\n'); await chmod(join(dir, 'docker'), 0o700);
  process.env.PATH = `${dir}:${previousPath}`; process.env.BRAIN_TEST_PROCESS_LOG = journal;
  const close = installChildGuard(children);
  try {
    expect((await ownedDocker(['version'])).stdout).toBe('owned');
    const groups = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string; token: string; pid: number });
    const records = (await readFile(children, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string; token?: string; pid?: number });
    expect(groups.map(row => row.state)).toEqual(['active', 'gone']);
    expect(groups[0]!.token).toBe(groups[1]!.token); expect(groups[0]!.pid).toBe(groups[1]!.pid);
    expect(records).toContainEqual(expect.objectContaining({ state: 'pid', token: groups[0]!.token, pid: groups[0]!.pid }));
  } finally {
    close(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.BRAIN_TEST_PROCESS_LOG; else process.env.BRAIN_TEST_PROCESS_LOG = previousLog;
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

it('does not release the target when the active journal cannot be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-command-gate-')), marker = join(dir, 'executed');
  const previousPath = process.env.PATH, previousLog = process.env.BRAIN_TEST_PROCESS_LOG;
  await writeFile(join(dir, 'docker'), `#!/bin/sh\nprintf started > "$1"\n`); await chmod(join(dir, 'docker'), 0o700);
  process.env.PATH = `${dir}:${previousPath}`; process.env.BRAIN_TEST_PROCESS_LOG = join(dir, 'missing', 'journal');
  try {
    await expect(ownedDocker([marker])).rejects.toThrow();
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.BRAIN_TEST_PROCESS_LOG; else process.env.BRAIN_TEST_PROCESS_LOG = previousLog;
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

it('retains and terminates the infrastructure helper after its PID journal append fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-command-pid-failure-')), marker = join(dir, 'executed'), journal = join(dir, 'children');
  const previousPath = process.env.PATH, originalError = new Error('synthetic PID append failure');
  await writeFile(join(dir, 'docker'), '#!/bin/sh\nprintf started > "$1"\n'); await chmod(join(dir, 'docker'), 0o700);
  process.env.PATH = `${dir}:${previousPath}`;
  let pid: number | undefined;
  const close = installChildGuard(journal, record => {
    const row = record as { state?: string; pid?: number };
    if (row.state === 'pid') { pid = row.pid; throw originalError; }
    appendFileSync(journal, JSON.stringify(record) + '\n', { mode: 0o600 });
  });
  try {
    await expect(ownedDocker([marker])).rejects.toBe(originalError);
    expect(pid).toBeGreaterThan(1); expect(await lookupProcess(pid!)).toBeNull();
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string });
    expect(rows.some(row => row.state === 'spawned')).toBe(true); expect(rows.some(row => row.state === 'pid')).toBe(false);
  } finally {
    close(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (pid && await lookupProcess(pid) === null) await rm(dir, { recursive: true, force: true });
  }
}, 20000);
