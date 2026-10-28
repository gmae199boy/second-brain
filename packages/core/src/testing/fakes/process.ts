import type { ProcessExit, ProcessHandle, ProcessLauncher, ProcessSpec } from '../../ports/process.js';
export interface FakeProcess extends ProcessHandle { push(line: string): void; exit(code?: number | null, signal?: string | null): void; signals: string[] }
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
      pid: processes.length + 100, signals: [], exited,
      lines: { async *[Symbol.asyncIterator]() {
        while (!ended || queue.length > 0) {
          if (queue.length > 0) yield queue.shift()!;
          else await new Promise<void>((resolve) => { wake = resolve; });
        }
      } },
      push(line) { if (ended) throw new Error('종료된 프로세스입니다'); queue.push(line); wake?.(); },
      exit(code = 0, signal = null) { ended = true; finish({ code, signal }); wake?.(); },
      signalGroup(signal) { handle.signals.push(signal); handle.exit(null, signal); },
    };
    processes.push(handle);
    return { ok: true, handle };
  } };
}
