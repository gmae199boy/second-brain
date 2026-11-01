export interface ProcessSpec { bootstrapPipe?: true; cwd?: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
export interface ProcessExit { code: number | null; signal: string | null }
export interface ProcessHandle {
  pid: number;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /** The leader's exit/reaping, independent of descendant-held stdio. */
  exited: Promise<ProcessExit>;
  readonly leaderExited: boolean;
  /** bootstrap의 비밀 없는 ACK만 보낸다. 상대 인증은 별도 경계가 책임진다. */
  sendBootstrapAck?(): Promise<boolean>;
  closeBootstrap?(): void;
  /** Stop waiting for pipe EOF while preserving already queued chunks. */
  closeOutput(): void;
  signalGroup(signal: 'SIGKILL' | 'SIGTERM'): void;
}
export interface ProcessLauncher {
  start(spec: ProcessSpec): Promise<{ ok: true; handle: ProcessHandle } | { ok: false; message: string }>;
}

export type ProcessObservation<T> = { state: 'found'; value: T } | { state: 'none' } | { state: 'unknown' };
export interface ProcessGroupMember { pid: number; pgid: number; startedAt: Date }
export interface ProcessInspector {
  bootTime(): Promise<ProcessObservation<Date>>;
  startedAt(pid: number): Promise<ProcessObservation<Date>>;
  groupMembers(pgid: number): Promise<ProcessObservation<ProcessGroupMember[]>>;
  signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<'sent' | 'none' | 'failed'>;
}
