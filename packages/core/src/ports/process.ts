export interface ProcessSpec { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
export interface ProcessExit { code: number | null; signal: string | null }
export interface ProcessHandle {
  pid: number;
  lines: AsyncIterable<string>;
  exited: Promise<ProcessExit>;
  signalGroup(signal: 'SIGKILL' | 'SIGTERM'): void;
}
export interface ProcessLauncher {
  start(spec: ProcessSpec): Promise<{ ok: true; handle: ProcessHandle } | { ok: false; message: string }>;
}
