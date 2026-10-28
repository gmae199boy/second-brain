import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProcessLauncher } from 'second_brain';

export const systemProcessLauncher: ProcessLauncher = {
  async start(spec) {
    return new Promise((resolve) => {
      const child = spawn(spec.command, [...spec.args], { env: { ...spec.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      // Start buffering before spawn resolves: identity/database inspection may
      // outlast a short worker, and readline's own iterator misses past events.
      const queue: string[] = [];
      let outputEnded = false;
      let wake: (() => void) | undefined;
      lines.on('line', line => { queue.push(line); wake?.(); });
      lines.once('close', () => { outputEnded = true; wake?.(); });
      const output: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {
        while (!outputEnded || queue.length > 0) {
          if (queue.length > 0) yield queue.shift()!;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      } };
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
        child.once('exit', (code, signal) => done({ code, signal }));
      });
      child.once('error', () => { lines.close(); resolve({ ok: false, message: '자식 프로세스를 시작할 수 없습니다' }); });
      child.once('spawn', () => resolve({ ok: true, handle: {
        pid: child.pid!, lines: output, exited,
        get leaderExited() { return child.exitCode !== null || child.signalCode !== null; },
        closeOutput() { lines.close(); child.stdout.destroy(); child.stderr.destroy(); },
        signalGroup(signal) {
          try { process.kill(-child.pid!, signal); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        },
      } }));
    });
  },
};
