import { spawn } from 'node:child_process';
import { PROCESS_ABI_MAX_LINE_BYTES, type ProcessLauncher } from 'second_brain';

export const systemProcessLauncher: ProcessLauncher = {
  async start(spec) {
    return new Promise((resolve) => {
      const child = spawn(spec.command, [...spec.args], { env: { ...spec.env }, ...(spec.cwd ? { cwd: spec.cwd } : {}), detached: true, stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      child.stdin?.on('error', () => { /* A child can close its input before reading it. */ });
      child.stdin?.end(spec.stdin);
      function buffer(stream: NonNullable<typeof child.stdout>) {
        stream.setEncoding('utf8');
        const queue: string[] = [];
        let queuedBytes = 0;
        let ended = false;
        let error: Error | undefined;
        let wake: (() => void) | undefined;
        stream.on('data', (chunk: string) => {
          queue.push(chunk); queuedBytes += Buffer.byteLength(chunk, 'utf8');
          // One incoming chunk may cross the bound; pause before accepting more.
          if (queuedBytes >= PROCESS_ABI_MAX_LINE_BYTES) stream.pause();
          wake?.();
        });
        const close = () => { ended = true; wake?.(); };
        stream.once('end', close); stream.once('close', close);
        stream.once('error', value => { error = value; close(); });
        const output: AsyncIterable<string> = { async *[Symbol.asyncIterator]() {
          while (!ended || queue.length) {
            if (queue.length) {
              const chunk = queue.shift()!;
              queuedBytes -= Buffer.byteLength(chunk, 'utf8');
              if (!ended && queuedBytes < PROCESS_ABI_MAX_LINE_BYTES / 2) stream.resume();
              yield chunk;
            }
            else await new Promise<void>(resolve => { wake = resolve; });
          }
          if (error) throw error;
        } };
        return { output, close };
      }
      const stdoutStream = child.stdout!, stderrStream = child.stderr!;
      const stdout = buffer(stdoutStream), stderr = buffer(stderrStream);
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
        child.once('exit', (code, signal) => done({ code, signal }));
      });
      child.once('error', () => { stdout.close(); stderr.close(); resolve({ ok: false, message: '자식 프로세스를 시작할 수 없습니다' }); });
      child.once('spawn', () => resolve({ ok: true, handle: {
        pid: child.pid!, stdout: stdout.output, stderr: stderr.output, exited,
        get leaderExited() { return child.exitCode !== null || child.signalCode !== null; },
        closeOutput() { stdout.close(); stderr.close(); stdoutStream.destroy(); stderrStream.destroy(); },
        signalGroup(signal) {
          try { process.kill(-child.pid!, signal); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        },
      } }));
    });
  },
};
