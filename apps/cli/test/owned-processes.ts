import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { spawn, type ChildProcessByStdio, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Duplex, Readable } from 'node:stream';
import { ProcessTracker, sampleProcesses, terminateGroup, type ProcessSample } from '../../../tooling/test-db/src/slots/processes.js';

type Child = ChildProcessByStdio<null, Readable, Readable>;
type Group = { token: string; pid?: number; tracker?: ProcessTracker; pending?: Promise<void>; ready: Promise<void>; child: Child; closed: Promise<void>; spawnError?: NodeJS.ErrnoException; journalError?: unknown; gateError?: unknown; gone: boolean };

/** Per-test scope. A timeout runs Vitest afterEach even while the test promise is pending. */
export class OwnedProcesses {
  private readonly groups: Group[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private readonly timer = setInterval(() => { for (const group of this.groups) this.sample(group); }, 100);
  constructor(private readonly snapshot: () => Promise<ProcessSample[]> = sampleProcesses) {}

  spawn(command: string, args: readonly string[], options: SpawnOptions = {}): Child {
    if (this.closed) throw new Error('test process scope is closed');
    if (options.shell) throw new Error('shell mode is not supported by the owned process gate');
    const targetEnv = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const gate = fileURLToPath(new URL('./owned-process-gate.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--no-warnings', gate], { ...options, env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] }) as Child;
    const originalKill = child.kill.bind(child);
    child.kill = (signal = 'SIGTERM') => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
      try { process.kill(-child.pid, signal); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    };
    // Keep the standard ChildProcess available if Node could not start the leader.
    if (!child.pid) child.kill = originalKill;
    const token = (child as unknown as Record<symbol, string>)[Symbol.for('brain.test.child-token')] ?? randomBytes(12).toString('hex');
    const group: Group = { token, pid: child.pid, child, gone: false, closed: Promise.resolve(), ready: Promise.resolve() };
    child.on('error', error => { group.spawnError = error; });
    group.closed = new Promise(resolve => { child.once('close', () => resolve()); });
    this.groups.push(group);
    const gatePipe = child.stdio[3] as Duplex;
    gatePipe.on('error', () => { /* openGate or observeExec will quarantine failure */ });
    group.ready = this.openGate(group, gatePipe, { command, args: [...args], env: targetEnv, argv0: options.argv0 });
    void group.ready.catch(() => {});
    return child;
  }

  private async openGate(group: Group, pipe: Duplex, request: { command: string; args: string[]; env: Record<string, string>; argv0?: string }): Promise<void> {
    const pid = group.pid;
    try {
      if (!pid) {
        await group.closed;
        if (group.spawnError) return;
        throw new Error('gate PID unavailable');
      }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await this.snapshot(), row = rows.find(item => item.pid === pid && item.pgid === pid);
        if (row) { group.tracker = new ProcessTracker({ pid, started: row.started }); group.tracker.update(rows); break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!group.tracker) throw new Error('gate starting identity unconfirmed');
      const guardKey = Symbol.for('brain.test.child-journal-error');
      if (guardKey in group.child) {
        const guardError = (group.child as unknown as Record<symbol, unknown>)[guardKey];
        group.journalError = guardError ?? new Error('child journal write failed'); throw group.journalError;
      }
      // The helper cannot stop or execute the target until the first sample.
      pipe.end(JSON.stringify(request));
      let stopped = false;
      while (Date.now() < deadline) {
        const rows = await this.snapshot(), row = rows.find(item => item.pid === pid && item.pgid === pid && item.started === group.tracker!.root.started);
        if (row?.status?.startsWith('T')) { group.tracker.update(rows); stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!stopped) throw new Error('gate stopped identity unconfirmed');
      try { this.record(group, 'active'); } catch (error) { group.journalError = error; throw error; }
      const outcome = this.observeExec(group, pipe, request.command);
      void outcome.catch(() => {});
      this.sample(group);
      process.kill(pid, 'SIGCONT');
      await outcome;
      return;
    } catch (error) {
      group.gateError = error; pipe.destroy();
      group.child.stdout.resume(); group.child.stderr.resume();
      group.child.emit('error', Object.assign(new Error('test process gate failed', { cause: error }), { code: 'BRAIN_GATE_FAILED' }));
      throw error;
    }
  }

  private observeExec(group: Group, pipe: Duplex, command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let text = '', settled = false, failureErrno: number | undefined;
      const buffered: { event: string; values: any[] }[] = [];
      const originalEmit = group.child.emit as (...values: any[]) => boolean;
      group.child.emit = function (this: Child, event: string | symbol, ...values: any[]): boolean {
        if (!settled && (event === 'exit' || event === 'close')) { buffered.push({ event, values }); return true; }
        if (failureErrno !== undefined && event === 'exit') return true;
        if (failureErrno !== undefined && event === 'close') return originalEmit.call(this, 'close', failureErrno, null);
        return originalEmit.call(this, event, ...values);
      } as typeof group.child.emit;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        for (const item of buffered) group.child.emit(item.event as 'exit', ...item.values as [number, NodeJS.Signals]);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { pipe.destroy(); finish(new Error('exec channel timed out')); }, 5000);
      const rows: { state?: unknown; code?: unknown; errno?: unknown; pid?: unknown }[] = [];
      pipe.setEncoding('utf8');
      pipe.on('data', chunk => {
        if (settled) return;
        text += String(chunk);
        if (text.length > 4096) { pipe.destroy(); finish(new Error('exec channel overflow')); return; }
        try {
          while (text.includes('\n')) {
            const index = text.indexOf('\n'), line = text.slice(0, index); text = text.slice(index + 1);
            const row = JSON.parse(line) as typeof rows[number]; rows.push(row);
            if (rows.length === 1 && row.state !== 'armed') throw new Error('invalid gate armed record');
            if (rows.length === 2 && row.state !== 'attempt') throw new Error('invalid gate attempt record');
            if (rows.length !== 3) continue;
            if (row.state === 'started' && Number.isInteger(row.pid) && (row.pid as number) > 1) {
              this.sample(group); finish(); return;
            }
            if (row.state !== 'error' || typeof row.code !== 'string' || !/^E[A-Z0-9]+$/.test(row.code) || !Number.isInteger(row.errno) || (row.errno as number) >= 0) throw new Error('invalid spawn error');
            failureErrno = row.errno as number;
            group.child.emit('error', Object.assign(new Error(`spawn ${command} ${row.code}`), { code: row.code, errno: row.errno, syscall: `spawn ${command}`, path: command }));
            finish(); return;
          }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      pipe.once('error', () => finish(new Error('exec channel error')));
      pipe.once('close', () => { if (!settled) finish(new Error('exec channel closed without result')); });
      pipe.once('end', () => { if (!settled) finish(new Error('exec channel ended without result')); });
    });
  }

  private record(group: Group, state: 'active' | 'gone'): void {
    if (process.env.BRAIN_TEST_PROCESS_LOG) appendFileSync(process.env.BRAIN_TEST_PROCESS_LOG, JSON.stringify({ token: group.token, pid: group.pid, state }) + '\n', { mode: 0o600 });
  }
  private sample(group: Group): void {
    if (!group.tracker || group.pending || group.gone) return;
    group.pending = group.tracker.sample(this.snapshot).catch(() => { group.tracker!.samplingFailed = true; }).finally(() => { group.pending = undefined; });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.timer);
    this.closing = this.closeGroups().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private async closeGroups(): Promise<void> {
    const errors: string[] = [];
    for (const group of this.groups) {
      if (group.gone) continue;
      await group.ready.catch(() => {}); await group.pending;
      let state: 'gone' | 'alive' | 'unknown' = 'unknown';
      if (!group.pid) {
        await Promise.race([group.closed, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
        if (group.spawnError && !group.child.pid) state = 'gone';
      } else if (group.tracker) {
        try { state = await terminateGroup(group.pid, group.tracker); } catch { state = 'unknown'; }
      }
      process.stderr.write(`test process group ${group.pid ?? 'not-started'}: ${state}\n`);
      if (state !== 'gone') { errors.push(`${group.pid ?? 'not-started'}: ${state}`); continue; }
      if (group.journalError) { errors.push(`${group.pid}: process journal unavailable: ${String(group.journalError)}`); continue; }
      if (group.gateError) { errors.push(`${group.pid}: gate identity unconfirmed`); continue; }
      if (group.pid) try { this.record(group, 'gone'); } catch (error) { group.journalError = error; errors.push(`${group.pid}: process journal unavailable`); continue; }
      group.gone = true;
    }
    if (errors.length) throw new Error(`test process termination unconfirmed: ${errors.join(', ')}`);
  }
}

/** Never discard fixtures until every owned process is confirmed gone. */
export async function closeTestScope(processes: Pick<OwnedProcesses, 'close'>, cleanup: (() => Promise<void>)[]): Promise<void> {
  await processes.close();
  const errors: unknown[] = [];
  for (const close of cleanup.splice(0)) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'test fixture cleanup failed');
}
