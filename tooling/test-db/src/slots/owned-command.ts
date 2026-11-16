import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { ProcessTracker, sampleProcesses, terminateGroup, type ProcessSample } from './processes.js';

/** Private infrastructure command. The shell cannot exec the target until its
 * identity and detached group have been sampled and durably journaled. */
export async function ownedDocker(args: string[], options: { timeout?: number; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  const child = spawn('/bin/sh', ['-c', 'kill -STOP $$; exec "$@"', 'brain-owned-command', 'docker', ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pid = child.pid;
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let stdout = '', stderr = '', overflow = false;
  const max = options.maxBuffer ?? 1024 * 1024;
  const collect = (current: string, chunk: Buffer) => {
    if (Buffer.byteLength(current) + chunk.length > max) { overflow = true; return current; }
    return current + chunk.toString();
  };
  child.stdout!.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
  if (!pid) { await closed; throw spawnError ?? new Error('owned command PID unavailable'); }
  const token = (child as unknown as Record<symbol, string>)[Symbol.for('brain.test.child-token')] ?? randomBytes(12).toString('hex');
  const record = (state: 'active' | 'gone') => {
    if (process.env.BRAIN_TEST_PROCESS_LOG) appendFileSync(process.env.BRAIN_TEST_PROCESS_LOG, JSON.stringify({ token, pid, state }) + '\n', { mode: 0o600 });
  };
  let tracker: ProcessTracker | undefined, sampling: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let completed: { code: number | null; signal: NodeJS.Signals | null } | undefined, timedOut = false, active = false;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows: ProcessSample[] = await sampleProcesses();
      const row: ProcessSample | undefined = rows.find(item => item.pid === pid);
      if (row?.pgid === pid && !tracker) { tracker = new ProcessTracker({ pid, started: row.started }); tracker.update(rows); }
      if (tracker && row?.started === tracker.root.started && row.status?.startsWith('T')) break;
      if (spawnError) throw spawnError;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!tracker) throw new Error('owned command gate identity unconfirmed');
    const gate = (await sampleProcesses()).find(row => row.pid === pid && row.started === tracker!.root.started && row.pgid === pid && row.status?.startsWith('T'));
    if (!gate) throw new Error('owned command gate not stopped');
    const guardKey = Symbol.for('brain.test.child-journal-error');
    if (guardKey in child) throw (child as unknown as Record<symbol, unknown>)[guardKey] ?? new Error('child journal write failed');
    record('active'); active = true;
    const sample = () => { if (!sampling) sampling = tracker!.sample().catch(() => { tracker!.samplingFailed = true; }).finally(() => { sampling = undefined; }); };
    timer = setInterval(sample, 25);
    process.kill(pid, 'SIGCONT');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    completed = await Promise.race([closed, new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), options.timeout ?? 15000); })]);
    if (timeout) clearTimeout(timeout);
    timedOut = !completed;
  } finally {
    if (timer) clearInterval(timer);
    await sampling;
    if (tracker) {
      const state = await terminateGroup(pid, tracker);
      if (state !== 'gone') throw new Error(`owned command termination ${state}`);
      if (active) record('gone');
    } else {
      // The gate has not been released. Do not signal an unverified PID; its
      // unresolved guard record fences recovery for an operator to inspect.
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
  }
  if (timedOut || overflow || spawnError || completed?.code !== 0) {
    const operation = ['run', 'start', 'rm', 'inspect', 'logs', 'ps', 'version', 'volume', 'network'].includes(args[0] ?? '') ? `docker ${args[0]}` : 'docker command';
    const error = Object.assign(new Error(timedOut ? `${operation} timed out` : overflow ? `${operation} output exceeded limit` : spawnError ? `${operation} spawn failed` : `${operation} exited ${completed?.code}`), { code: completed?.code ?? undefined, signal: completed?.signal, stdout, stderr });
    throw error;
  }
  return { stdout, stderr };
}
