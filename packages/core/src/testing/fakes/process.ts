import type { ProcessExit, ProcessHandle, ProcessLauncher, ProcessSpec } from '../../ports/process.js';
export interface FakeProcess extends ProcessHandle { push(line: string): void; exit(code?: number | null, signal?: string | null): void; signals: string[]; ended: boolean; ignoreTerm: boolean }
export function fakeProcessLauncher(): ProcessLauncher & { processes: FakeProcess[]; specs: ProcessSpec[] } {
  const processes: FakeProcess[] = [];
  const specs: ProcessSpec[] = [];
  return { processes, specs, async start(spec) {
    specs.push(spec);
    const queue: string[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    let finish!: (exit: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => { finish = resolve; });
    const handle: FakeProcess = {
      pid: processes.length + 100, signals: [], exited, ended: false, ignoreTerm: false,
      get leaderExited() { return handle.ended; },
      closeOutput() { ended = true; wake?.(); },
      lines: { async *[Symbol.asyncIterator]() {
        while (!ended || queue.length > 0) {
          if (queue.length > 0) yield queue.shift()!;
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } },
      push(line) { if (handle.ended) throw new Error('종료된 프로세스입니다'); if (ended) return; queue.push(line); wake?.(); },
      exit(code = 0, signal = null) { ended = true; handle.ended = true; finish({ code, signal }); wake?.(); },
      signalGroup(signal) { handle.signals.push(signal); if (signal !== 'SIGTERM' || !handle.ignoreTerm) handle.exit(null, signal); },
    };
    processes.push(handle);
    return { ok: true, handle };
  } };
}

export function fakeProcessInspector(launcher?: { processes: FakeProcess[] }): import('../../ports/process.js').ProcessInspector & {
  boot: import('../../ports/process.js').ProcessObservation<Date>;
  starts: Map<number, import('../../ports/process.js').ProcessObservation<Date>>;
  groups: Map<number, import('../../ports/process.js').ProcessObservation<import('../../ports/process.js').ProcessGroupMember[]>>;
  signals: { pgid: number; signal: string }[];
  signalFailure: boolean;
} {
  const started = new Date('2026-10-29T00:00:00Z');
  const result = {
    boot: { state: 'found' as const, value: started } as import('../../ports/process.js').ProcessObservation<Date>,
    starts: new Map<number, import('../../ports/process.js').ProcessObservation<Date>>(),
    groups: new Map<number, import('../../ports/process.js').ProcessObservation<import('../../ports/process.js').ProcessGroupMember[]>>(),
    signals: [] as { pgid: number; signal: string }[], signalFailure: false,
    async bootTime() { return result.boot; },
    async startedAt(pid: number) { return result.starts.get(pid) ?? { state: 'found' as const, value: started }; },
    async groupMembers(pgid: number) {
      const configured = result.groups.get(pgid);
      if (configured) return configured;
      const child = launcher?.processes.find(p => p.pid === pgid);
      return child && !child.ended ? { state: 'found' as const, value: [{ pid: pgid, pgid, startedAt: started }] } : { state: 'none' as const };
    },
    async signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL') {
      result.signals.push({ pgid, signal });
      if (result.signalFailure) return 'failed' as const;
      const child = launcher?.processes.find(p => p.pid === pgid);
      child?.signalGroup(signal);
      return child ? 'sent' as const : 'none' as const;
    },
  };
  return result;
}
