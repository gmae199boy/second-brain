import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { installChildGuard } from '../../../tooling/test-db/test/child-guard.js';
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveness, lookupProcess } from '../../../tooling/test-db/src/slots/ledger.js';
import { sampleProcesses } from '../../../tooling/test-db/src/slots/processes.js';
import { TimeoutProcessSupervisor } from './timeout-process-supervisor.js';
import { expect, it, vi } from 'vitest';
import { closeTestScope, OwnedProcesses } from './owned-processes.js';

it('continues later fixture cleanup after an earlier cleanup error', async () => {
  const order: string[] = [];
  await expect(closeTestScope({ close: async () => {} }, [async () => { order.push('first'); throw new Error('first'); }, async () => { order.push('second'); }])).rejects.toThrow('test fixture cleanup failed');
  expect(order).toEqual(['first', 'second']);
});
it('quarantines all fixture cleanup if group termination is unconfirmed', async () => {
  let dropped = false;
  await expect(closeTestScope({ close: async () => { throw new Error('unknown'); } }, [async () => { dropped = true; }])).rejects.toThrow('unknown');
  expect(dropped).toBe(false);
});
it('Vitest timeout invokes teardown, kills child and grandchild, then drops the fixture', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'timeout-scope-'));
  const pids = join(dir, 'pids.json'), marker = join(dir, 'cleanup');
  const cli = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'run', '--config', 'apps/cli/test/fixtures/process-timeout/vitest.config.ts'], { cwd: root, detached: true, env: { ...process.env, PROCESS_PIDS: pids, PROCESS_CLEANUP_MARKER: marker }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (!child.pid) { void done.catch(() => {}); throw new Error('runner pid unavailable; evidence retained'); }
  const evidence = join(dir, 'process-evidence.json');
  const supervisor = new TimeoutProcessSupervisor(child.pid, pids, evidence);
  let watchdogError: unknown, watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await supervisor.start();
    watchdog = setTimeout(() => { void supervisor.close().catch(error => { watchdogError = error; }); }, 20000);
    const code = await done;
    expect(code, output).not.toBe(0); expect(output).toMatch(/timed out/i);
    const values = JSON.parse(await readFile(pids, 'utf8')) as number[];
    expect(values).toHaveLength(3);
    expect(await readFile(marker, 'utf8')).toBe('fixture dropped');
    const identities = JSON.parse(await readFile(evidence, 'utf8')) as { pgid: number; leader: { pid: number; started: string }; child: { pid: number; started: string; ppid: number; pgid: number }; grandchild: { pid: number; started: string; ppid: number; pgid: number } };
    expect([identities.leader.pid, identities.child.pid, identities.grandchild.pid]).toEqual(values);
    expect(identities.pgid).toBe(identities.leader.pid); expect(identities.child.ppid).toBe(identities.leader.pid); expect(identities.grandchild.ppid).toBe(identities.child.pid);
    expect(identities.child.pgid).toBe(identities.pgid); expect(identities.grandchild.pgid).toBe(identities.pgid);
    expect(await liveness(identities.leader)).toBe('dead');
    expect(await liveness(identities.child)).toBe('dead'); expect(await liveness(identities.grandchild)).toBe('dead');
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await supervisor.close();
    if (watchdogError) throw watchdogError;
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
it('writes one active and one gone record even when close is repeated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'process-journal-')), path = join(dir, 'journal.jsonl'), old = process.env.BRAIN_TEST_PROCESS_LOG;
  process.env.BRAIN_TEST_PROCESS_LOG = path;
  const scope = new OwnedProcesses();
  try {
    const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); child.stdout.resume(); child.stderr.resume();
    await scope.close(); await scope.close();
    const events = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { token: string; pid: number; state: string });
    expect(events.map(event => event.state)).toEqual(['active', 'gone']);
    expect(events[0]?.token).toBe(events[1]?.token); expect(events[0]?.pid).toBe(child.pid);
    const guardToken = (child as unknown as Record<symbol, string>)[Symbol.for('brain.test.child-token')];
    if (guardToken) expect(events[0]?.token).toBe(guardToken);
  } finally {
    try { await scope.close(); } finally {
      if (old === undefined) delete process.env.BRAIN_TEST_PROCESS_LOG; else process.env.BRAIN_TEST_PROCESS_LOG = old;
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
it('handles an asynchronous spawn ENOENT and confirms that no process started', async () => {
  const scope = new OwnedProcesses(), child = scope.spawn('/nonexistent-brain-test-command', []);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  expect((await failure).code).toBe('ENOENT'); expect(await closed).toEqual([-2, null]);
  await expect(scope.close()).resolves.toBeUndefined();
});
it('reports actual ENOENT when the executable disappears after the first identity sample', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-exec-race-')), executable = join(dir, 'target');
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o700);
  let removed = false;
  const scope = new OwnedProcesses(async () => {
    const rows = await sampleProcesses();
    if (!removed && rows.some(row => row.pid === child.pid && row.status?.startsWith('T'))) { await unlink(executable); removed = true; }
    return rows;
  });
  const child = scope.spawn(executable, []);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  try {
    expect((await failure).code).toBe('ENOENT'); expect(await closed).toEqual([-2, null]); expect(removed).toBe(true);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it('reports actual ENOENT for an executable with a missing shebang interpreter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-shebang-')), executable = join(dir, 'target');
  await writeFile(executable, '#!/nonexistent-brain-test-interpreter\n'); await chmod(executable, 0o700);
  const scope = new OwnedProcesses(), child = scope.spawn(executable, []);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  try {
    expect((await failure).code).toBe('ENOENT'); expect(await closed).toEqual([-2, null]);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it('reports EACCES from the actual exec attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-eacces-')), executable = join(dir, 'target');
  await writeFile(executable, '#!/bin/sh\nexit 0\n'); await chmod(executable, 0o600);
  const scope = new OwnedProcesses(), child = scope.spawn(executable, []);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  try {
    expect((await failure).code).toBe('EACCES'); expect(await closed).toEqual([-13, null]);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it.each([126, 127])('preserves exit %i and target environment after successful exec', async exitCode => {
  const scope = new OwnedProcesses(), env = { PATH: process.env.PATH, NODE_OPTIONS: '--no-warnings', BRAIN_EXEC_CHANNEL_TEST: 'retained' };
  const child = scope.spawn(process.execPath, ['-e', `process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS, process.env.BRAIN_EXEC_CHANNEL_TEST])); process.exit(${exitCode})`], { env });
  let output = '', error: Error | undefined;
  child.stdout.on('data', data => { output += String(data); }); child.stderr.resume(); child.on('error', value => { error = value; });
  const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  try {
    expect(await closed).toEqual([exitCode, null]); expect(error).toBeUndefined();
    expect(JSON.parse(output)).toEqual(['--no-warnings', 'retained']);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); }
}, 15000);
it('uses native PATH lookup while preserving cwd and the leader process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-path-')), scope = new OwnedProcesses();
  const child = scope.spawn(basename(process.execPath), ['-e', 'process.stdout.write(JSON.stringify({cwd: process.cwd(), ppid: process.ppid, pid: process.pid, value: process.env.GATE_VALUE}))'], { cwd: dir, env: { PATH: `/nonexistent-brain-path:${dirname(process.execPath)}`, GATE_VALUE: 'ok' } });
  let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  try {
    expect(await closed).toBe(0);
    const result = JSON.parse(output) as { cwd: string; ppid: number; pid: number; value: string };
    expect(await realpath(result.cwd)).toBe(await realpath(dir)); expect(result.value).toBe('ok');
    expect(result.ppid).toBe(child.pid); expect(result.pid).not.toBe(child.pid);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it('keeps ownership and terminates a child even when the active journal write fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'process-journal-error-')), old = process.env.BRAIN_TEST_PROCESS_LOG, scope = new OwnedProcesses();
  process.env.BRAIN_TEST_PROCESS_LOG = dir;
  const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  try {
    expect((await failure).code).toBe('BRAIN_GATE_FAILED');
    await expect(scope.close()).rejects.toThrow('process journal unavailable');
    expect(() => process.kill(child.pid!, 0)).toThrow();
    await expect(scope.close()).rejects.toThrow('process journal unavailable');
  } finally {
    if (old === undefined) delete process.env.BRAIN_TEST_PROCESS_LOG; else process.env.BRAIN_TEST_PROCESS_LOG = old;
    try { await scope.close(); } catch { /* failed journal remains quarantined */ }
  }
}, 15000);
it('returns ownership after only the child PID append fails and never releases the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guard-pid-failure-')), journal = join(dir, 'children'), marker = join(dir, 'target');
  const originalError = new Error('synthetic PID journal failure');
  const unguard = installChildGuard(journal, record => {
    if ((record as { state?: string }).state === 'pid') throw originalError;
    appendFileSync(journal, JSON.stringify(record) + '\n', { mode: 0o600 });
  });
  const scope = new OwnedProcesses();
  let child: ReturnType<OwnedProcesses['spawn']> | undefined;
  try {
    child = scope.spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "ran")', marker]);
    expect(child.pid).toBeGreaterThan(1);
    expect((child as unknown as Record<symbol, unknown>)[Symbol.for('brain.test.child-journal-error')]).toBe(originalError);
    const failure = await new Promise<Error>(resolve => child!.once('error', resolve));
    expect(failure.cause).toBe(originalError);
    await expect(scope.close()).rejects.toThrow('synthetic PID journal failure');
    expect(() => process.kill(child!.pid!, 0)).toThrow();
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
    const rows = (await readFile(journal, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string });
    expect(rows.some(row => row.state === 'spawned')).toBe(true); expect(rows.some(row => row.state === 'pid')).toBe(false);
  } finally {
    try { await scope.close(); } catch { /* preserve quarantine until helper termination is proved */ }
    unguard();
    if (child?.pid && await lookupProcess(child.pid) === null) await rm(dir, { recursive: true, force: true });
  }
}, 20000);
it('quarantines an injected gate identity failure without running the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-identity-failure-')), marker = join(dir, 'executed');
  const scope = new OwnedProcesses(async () => { throw new Error('identity unavailable'); });
  const child = scope.spawn(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "ran")', marker]);
  const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
  expect((await failure).code).toBe('BRAIN_GATE_FAILED');
  await expect(scope.close()).rejects.toThrow('unknown');
  await expect(readFile(marker, 'utf8')).rejects.toThrow();
  // Keep the directory as evidence for the unverified helper.
}, 15000);
it('retains identity for repeated fast successful commands', async () => {
  const scope = new OwnedProcesses();
  try {
    for (let index = 0; index < 12; index++) {
      const child = scope.spawn(process.execPath, ['-e', 'process.stdout.write("ok")']);
      let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.resume();
      const result = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(result).toBe(0); expect(output).toBe('ok');
    }
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); }
}, 60000);
it('keeps the returned child signal and close observation on the gated target', async () => {
  const scope = new OwnedProcesses();
  try {
    const child = scope.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)']);
    child.stderr.resume();
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
    expect(child.kill('SIGTERM')).toBe(true);
    expect(await closed).toEqual([null, 'SIGTERM']);
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); }
}, 15000);
it('propagates child.kill to the target in the owned process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-signal-')), marker = join(dir, 'term');
  const scope = new OwnedProcesses();
  try {
    const child = scope.spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => { require("fs").writeFileSync(process.argv[1], "received"); process.exit(0); }); process.stdout.write("ready"); setInterval(() => {}, 1000)', marker]);
    child.stderr.resume();
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
    expect(child.kill(0)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(child.kill('SIGTERM')).toBe(true); expect(await closed).toEqual([0, null]);
    expect(await readFile(marker, 'utf8')).toBe('received');
    await expect(scope.close()).resolves.toBeUndefined();
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 15000);
it('preserves the target signal when the target signals itself', async () => {
  const scope = new OwnedProcesses();
  const child = scope.spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']);
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal])); });
  try { expect(await closed).toEqual([null, 'SIGTERM']); } finally { await scope.close(); }
}, 15000);
it.each(['child.kill', 'external group'] as const)('%s delivers one group signal to an asynchronous target and grandchild', async mode => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-single-signal-')), marker = join(dir, 'signals');
  const grand = `const fs=require('node:fs'); process.on('SIGTERM',()=>{fs.appendFileSync(process.argv[1],'grandchild\\n'); setTimeout(()=>process.exit(0),300)}); process.stdout.write('ready'); setInterval(()=>{},1000)`;
  const target = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(grand)},process.argv[1]],{stdio:['ignore','pipe','inherit']}); c.stdout.once('data',()=>process.stdout.write('ready')); process.on('SIGTERM',()=>{fs.appendFileSync(process.argv[1],'target\\n'); setTimeout(()=>process.exit(0),600)}); setInterval(()=>{},1000)`;
  const scope = new OwnedProcesses();
  const child = scope.spawn(process.execPath, ['-e', target, marker]);
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
    if (mode === 'child.kill') expect(child.kill('SIGTERM')).toBe(true);
    else process.kill(-child.pid!, 'SIGTERM');
    expect(await closed).toEqual([0, null]);
    expect((await readFile(marker, 'utf8')).trim().split('\n').sort()).toEqual(['grandchild', 'target']);
  } finally { await scope.close(); await rm(dir, { recursive: true, force: true }); }
}, 20000);
it('sends SIGKILL to the owned group', async () => {
  const scope = new OwnedProcesses();
  const child = scope.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)']);
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
    const closed = new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.once('close', (code, signal) => resolve([code, signal])));
    expect(child.kill('SIGKILL')).toBe(true); expect(await closed).toEqual([null, 'SIGKILL']);
  } finally { await scope.close(); }
}, 15000);
it('does not report a failed group signal as successful', async () => {
  const scope = new OwnedProcesses();
  const child = scope.spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)']);
  child.stderr.resume();
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); });
    const actualKill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (child.pid !== undefined && pid === -child.pid && signal === 'SIGTERM') throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
      return actualKill(pid, signal);
    }) as typeof process.kill);
    try { expect(() => child.kill('SIGTERM')).toThrow('signal denied'); } finally { spy.mockRestore(); }
  } finally { await scope.close(); }
}, 15000);
it('handles SIGCONT failure without an unhandled channel rejection', async () => {
  const scope = new OwnedProcesses(), actualKill = process.kill.bind(process), rejected: unknown[] = [];
  let targetPid: number | undefined;
  const listener = (reason: unknown) => { rejected.push(reason); };
  process.on('unhandledRejection', listener);
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === targetPid && signal === 'SIGCONT') throw Object.assign(new Error('synthetic ESRCH'), { code: 'ESRCH' });
    return actualKill(pid, signal);
  }) as typeof process.kill);
  try {
    const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)']); targetPid = child.pid;
    const failure = new Promise<NodeJS.ErrnoException>(resolve => child.once('error', resolve));
    expect((await failure).code).toBe('BRAIN_GATE_FAILED');
    await expect(scope.close()).rejects.toThrow('gate identity unconfirmed');
    await new Promise(resolve => setImmediate(resolve));
    expect(rejected).toEqual([]);
  } finally {
    spy.mockRestore(); process.off('unhandledRejection', listener);
    try { await scope.close(); } catch { /* preserve the failed gate evidence */ }
  }
}, 20000);
it('watchdog terminates an observed detached child group and grandchild before removing evidence', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'forced-watchdog-'));
  const pids = join(dir, 'pids.json'), evidence = join(dir, 'evidence.json');
  const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/cli/test/fixtures/process-timeout/vitest.config.ts'], { cwd: root, detached: true, env: { ...process.env, PROCESS_PIDS: pids, PROCESS_CLEANUP_MARKER: join(dir, 'cleanup') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume();
  const done = new Promise<void>(resolve => { child.once('error', () => resolve()); child.once('close', () => resolve()); });
  if (!child.pid) { await done; throw new Error('runner pid unavailable; evidence retained'); }
  const supervisor = new TimeoutProcessSupervisor(child.pid, pids, evidence);
  try {
    await supervisor.start();
    await expect.poll(() => supervisor.observed(), { timeout: 10000, interval: 30 }).toBe(true);
    // This is the watchdog path: terminate before the inner Vitest test times out.
    await supervisor.close(); await done;
    const identities = JSON.parse(await readFile(evidence, 'utf8')) as { pgid: number; leader: { pid: number; started: string }; child: { pid: number; started: string; ppid: number; pgid: number }; grandchild: { pid: number; started: string; ppid: number; pgid: number } };
    const values = JSON.parse(await readFile(pids, 'utf8')) as number[];
    expect([identities.leader.pid, identities.child.pid, identities.grandchild.pid]).toEqual(values);
    expect(identities.pgid).toBe(identities.leader.pid); expect(identities.child.ppid).toBe(identities.leader.pid); expect(identities.grandchild.ppid).toBe(identities.child.pid);
    expect(identities.child.pgid).toBe(identities.pgid); expect(identities.grandchild.pgid).toBe(identities.pgid);
    expect(await liveness(identities.leader)).toBe('dead');
    expect(await liveness(identities.child)).toBe('dead'); expect(await liveness(identities.grandchild)).toBe('dead');
  } finally {
    await supervisor.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 45000);

it('does not repeat a completed group journal transition when another group is quarantined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'partial-group-close-')), log = join(dir, 'journal.jsonl'), old = process.env.BRAIN_TEST_PROCESS_LOG;
  process.env.BRAIN_TEST_PROCESS_LOG = log;
  let blockedPid: number | undefined;
  const scope = new OwnedProcesses(async () => (await sampleProcesses()).filter(row => row.pid !== blockedPid));
  try {
    const first = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); first.stdout.resume(); first.stderr.resume();
    const second = scope.spawn(process.execPath, ['-e', '']); blockedPid = second.pid; second.stdout.resume(); second.stderr.resume();
    await new Promise<void>(resolve => second.once('error', () => resolve()));
    await expect(scope.close()).rejects.toThrow('unknown'); await expect(scope.close()).rejects.toThrow('unknown');
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; state: string });
    expect(records.filter(record => record.pid === first.pid).map(record => record.state)).toEqual(['active', 'gone']);
    expect(records.filter(record => record.pid === second.pid)).toEqual([]);
  } finally {
    if (old === undefined) delete process.env.BRAIN_TEST_PROCESS_LOG; else process.env.BRAIN_TEST_PROCESS_LOG = old;
    try { await scope.close(); } catch { /* intentionally unresolved journal */ }
    // The intentionally unresolved journal is retained for quarantine.
  }
}, 20000);
