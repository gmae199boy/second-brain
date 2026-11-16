import { readFile, writeFile } from 'node:fs/promises';
import { lookupProcess } from '../../../tooling/test-db/src/slots/ledger.js';
import { ProcessTracker, sampleProcesses, terminateGroup } from '../../../tooling/test-db/src/slots/processes.js';

/** Owns the Vitest runner and observes its detached child group before signalling. */
export class TimeoutProcessSupervisor {
  private root?: ProcessTracker;
  private detached?: ProcessTracker;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private malformed = false;
  private markerSeen = false;
  private evidenceWritten = false;
  constructor(private readonly pid: number, private readonly marker: string, private readonly evidence: string) {}
  async start(): Promise<void> {
    const started = await lookupProcess(this.pid);
    if (!started) throw new Error('runner identity unavailable; evidence retained');
    this.root = new ProcessTracker({ pid: this.pid, started });
    await this.sample();
    this.timer = setInterval(() => { void this.sample(); }, 50);
  }
  async sample(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const rows = await sampleProcesses(); this.root?.update(rows); this.detached?.update(rows);
        let value: unknown;
        try { value = JSON.parse(await readFile(this.marker, 'utf8')); this.markerSeen = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return; this.malformed = true; return; }
        if (!Array.isArray(value) || value.length !== 3 || value.some(pid => !Number.isInteger(pid) || pid <= 1) || new Set(value).size !== 3) { this.malformed = true; return; }
        const [leaderPid, targetPid, grandchildPid] = value as number[];
        const known = this.root?.descendants;
        const owned = (pid: number) => rows.find(row => row.pid === pid && known?.has(`${row.pid}:${row.started}`));
        const leader = owned(leaderPid!), target = owned(targetPid!), grand = owned(grandchildPid!);
        if (leader && target && grand && leader.pgid === leader.pid && target.ppid === leader.pid && target.pgid === leader.pgid && grand.ppid === target.pid && grand.pgid === leader.pgid && !this.detached) {
          const tracker = new ProcessTracker(leader); tracker.update(rows); this.detached = tracker;
          await writeFile(this.evidence, JSON.stringify({ runner: this.root?.root, pgid: leader.pgid, leader, child: target, grandchild: grand }) + '\n', { mode: 0o600 });
          this.evidenceWritten = true;
        }
      } catch { if (this.root) this.root.samplingFailed = true; if (this.detached) this.detached.samplingFailed = true; }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  observed(): boolean { return this.evidenceWritten; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.finish().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private async finish(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending; await this.sample();
    const errors: string[] = [];
    if (this.malformed || !this.markerSeen || !this.detached || !this.evidenceWritten) errors.push('detached child identity unconfirmed');
    if (this.detached) {
      try { if (await terminateGroup(this.detached.root.pid, this.detached) !== 'gone') errors.push('detached child termination unconfirmed'); }
      catch { errors.push('detached child termination unconfirmed'); }
    }
    try { if (!this.root || await terminateGroup(this.pid, this.root) !== 'gone') errors.push('runner termination unconfirmed'); }
    catch { errors.push('runner termination unconfirmed'); }
    if (errors.length) throw new Error(`${errors.join('; ')}; evidence retained`);
  }
}
