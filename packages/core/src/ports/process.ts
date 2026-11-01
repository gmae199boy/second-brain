export interface ProcessSpec { bootstrapPipe?: true; cwd?: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
/** 봉인 launcher가 OS에서 얻은 현재 실행 세대다. 입력 비밀은 포함하지 않는다. */
export interface ProtectedProcessIdentity { launchLease: string; connectionEpoch: number; startTimeUs: string }
export interface ProcessExit { code: number | null; signal: string | null; unknown?: true }
export interface ProcessHandle {
  pid: number;
  readonly protectedIdentity?: ProtectedProcessIdentity;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /** The leader's exit/reaping, independent of descendant-held stdio. */
  exited: Promise<ProcessExit>;
  /** 선택적 보호 host: PID를 고정한 종료 관찰이며 아직 reap 증거가 아니다. */
  leaderObserved?: Promise<ProcessExit>;
  /** 그룹이 비었을 때만 leader reap을 요청한다. 불명은 false다. */
  reapLeader?(): Promise<boolean>;
  readonly leaderExited: boolean;
  /** bootstrap의 비밀 없는 ACK만 보낸다. 상대 인증은 별도 경계가 책임진다. */
  sendBootstrapAck?(): Promise<boolean>;
  closeBootstrap?(): void;
  /** 보호 입력 폐기의 인증된 ACK를 기다린다. 불명이면 false다. */
  revokeInput?(): Promise<boolean>;
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
