import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ProcessLauncher } from 'second_brain';

export const systemProcessLauncher: ProcessLauncher = {
  async start(spec) {
    return new Promise((resolve) => {
      const child = spawn(spec.command, [...spec.args], { env: { ...spec.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
        child.once('close', (code, signal) => done({ code, signal }));
      });
      child.once('error', () => { lines.close(); resolve({ ok: false, message: '자식 프로세스를 시작할 수 없습니다' }); });
      child.once('spawn', () => resolve({ ok: true, handle: {
        pid: child.pid!, lines, exited,
        signalGroup(signal) {
          try { process.kill(-child.pid!, signal); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        },
      } }));
    });
  },
};
