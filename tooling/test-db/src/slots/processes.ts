import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Identity } from './ledger.js';
export interface ProcessSample extends Identity { ppid: number; pgid: number; cpu: number; time: string }
export type Sampler = () => Promise<ProcessSample[]>;
const exec = promisify(execFile);
export function parseProcesses(output: string): ProcessSample[] {
  return output.split('\n').filter(line => line.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+([\d.]+)\s+(\S+)$/);
    if (!m) throw new Error(`invalid ps row: ${line}`);
    return { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), started: m[4]!, cpu: Number(m[5]), time: m[6]! };
  });
}
export const sampleProcesses: Sampler = async () => parseProcesses((await exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,%cpu=,time='], { env: { ...process.env, LC_ALL: 'C' } })).stdout);
const key = (p: Identity) => `${p.pid}:${p.started}`;
export class ProcessTracker {
  readonly descendants = new Map<string, ProcessSample>();
  peakCpu = 0;
  currentCpu = 0;
  samplingFailed = false;
  constructor(readonly root: Identity) {}
  update(rows: ProcessSample[]): void {
    const root = rows.find(p => key(p) === key(this.root));
    const live = new Set<number>();
    if (root) live.add(root.pid);
    for (const p of rows) if (this.descendants.has(key(p))) live.add(p.pid);
    let changed = true;
    while (changed) { changed = false; for (const p of rows) if (!live.has(p.pid) && live.has(p.ppid)) { live.add(p.pid); this.descendants.set(key(p), p); changed = true; } }
    this.currentCpu = rows.filter(p => live.has(p.pid)).reduce((sum, p) => sum + p.cpu, 0);
    this.peakCpu = Math.max(this.peakCpu, this.currentCpu);
  }
  async sample(sampler: Sampler = sampleProcesses): Promise<void> { this.update(await sampler()); }
}
export class SharedProcessSampler {
  private readonly trackers = new Set<ProcessTracker>();
  private timer?: ReturnType<typeof setInterval>;
  private pending = false;
  constructor(private readonly sampler: Sampler = sampleProcesses, private readonly onSample?: () => void) {}
  subscribe(tracker: ProcessTracker): () => void { this.trackers.add(tracker); return () => this.trackers.delete(tracker); }
  async sample(): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try { const rows = await this.sampler(); for (const tracker of this.trackers) tracker.update(rows); this.onSample?.(); }
    catch { for (const tracker of this.trackers) tracker.samplingFailed = true; }
    finally { this.pending = false; }
  }
  start(): void { if (!this.timer) this.timer = setInterval(() => { void this.sample(); }, 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
export async function terminateGroup(pgid: number, tracker: ProcessTracker, options: { sampler?: Sampler; signal?: (pid: number, signal: NodeJS.Signals) => void; now?: () => number; sleep?: (ms: number) => Promise<void>; deadlineMs?: number } = {}): Promise<'gone' | 'alive' | 'unknown'> {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error('invalid process group');
  const sampler = options.sampler ?? sampleProcesses, signal = options.signal ?? process.kill, now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const snapshot = async (): Promise<ProcessSample[] | undefined> => {
    try { const rows = await sampler(); tracker.update(rows); return rows; } catch { return undefined; }
  };
  const knownRows = (rows: ProcessSample[]) => {
    const known = new Set([tracker.root, ...tracker.descendants.values()].map(key));
    return rows.filter(p => known.has(key(p)));
  };
  const status = (rows: ProcessSample[]): 'gone' | 'alive' | 'unknown' => {
    if (knownRows(rows).length) return 'alive';
    // A reused PID is not our process. An otherwise unknown group occupant
    // may still be an unsampled descendant, so do not declare cleanup complete.
    const knownPids = new Set([tracker.root, ...tracker.descendants.values()].map(p => p.pid));
    return rows.some(p => p.pgid === pgid && !knownPids.has(p.pid)) ? 'unknown' : 'gone';
  };
  const deliver = async (sig: NodeJS.Signals): Promise<boolean> => {
    const rows = await snapshot(); if (!rows) return false;
    const owned = knownRows(rows), inGroup = owned.some(p => p.pgid === pgid);
    for (const pid of [...(inGroup ? [-pgid] : []), ...owned.filter(child => child.pgid !== pgid).map(child => child.pid)]) {
      try { signal(pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
    }
    return true;
  };
  if (!await deliver('SIGTERM')) return 'unknown';
  const deadline = now() + (options.deadlineMs ?? 5000);
  let rows = await snapshot(); if (!rows) return 'unknown';
  let state = status(rows);
  while (state === 'alive' && now() < deadline) { await sleep(100); rows = await snapshot(); if (!rows) return 'unknown'; state = status(rows); }
  if (state !== 'alive') return state === 'gone' && tracker.samplingFailed ? 'unknown' : state;
  if (!await deliver('SIGKILL')) return 'unknown';
  await sleep(100); rows = await snapshot(); state = rows ? status(rows) : 'unknown'; return state === 'gone' && tracker.samplingFailed ? 'unknown' : state;
}
