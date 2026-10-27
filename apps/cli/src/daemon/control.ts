import { access } from 'node:fs/promises';
import { uptime } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import type { Clock } from 'second_brain';
import { systemIsAlive } from '../runtime/spool.js';
import { daemonLiveness } from './liveness.js';
import { ownerIsAlive, readDaemonLock } from './lock.js';
import { DAEMON_LABEL, daemonPlistPath, type Launchctl, type LaunchctlResult } from './launchd.js';

export const DAEMON_STOP_WAIT_MS = 20_000;
export const DAEMON_RESTART_WAIT_MS = 15_000;
interface Options {
  env: NodeJS.ProcessEnv;
  launchctl: Launchctl;
  platform: NodeJS.Platform;
}
export interface DaemonStopData { unloaded: boolean; alive: boolean; owner_pid: number | null }
export interface DaemonStartData {
  status: 'started' | 'already-loaded' | 'unsupported';
  plist_path: string | null;
}
export class DaemonControlError extends Error {
  constructor(readonly code: 'DAEMON_NOT_INSTALLED' | 'DAEMON_CONTROL_FAILED', message: string, readonly hint?: string, readonly data?: DaemonStopData) {
    super(message);
  }
}
function checked(result: LaunchctlResult): void {
  if (!result.ok) throw new DaemonControlError('DAEMON_CONTROL_FAILED', result.message);
}

export async function stopDaemon(options: Options & {
  home: string;
  clock: Clock;
  isAlive?: (pid: number) => boolean;
  bootAt?: () => Date;
  waitMs?: number;
}): Promise<DaemonStopData> {
  const { launchctl, platform } = options;
  let unloaded = false;
  if (platform === 'darwin' && launchctl.uid !== undefined && await launchctl.isLoaded(DAEMON_LABEL)) {
    checked(await launchctl.bootout(DAEMON_LABEL));
    unloaded = true;
  }
  const bootAt = options.bootAt ?? (() => new Date(options.clock.now().getTime() - uptime() * 1000));
  const isAlive = options.isAlive ?? systemIsAlive;
  const deadline = Date.now() + (options.waitMs ?? DAEMON_STOP_WAIT_MS);
  for (;;) {
    const owner = await readDaemonLock(options.home);
    const alive = owner !== undefined && ownerIsAlive(owner, { bootAt, isAlive });
    const data = { unloaded, alive, owner_pid: alive ? owner!.pid : null };
    if (!alive) return data;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DaemonControlError('DAEMON_CONTROL_FAILED',
      `기다리는 동안 데몬이 멈추지 않았습니다 (pid ${owner!.pid})`,
      `pid ${owner!.pid}: launchd 밖에서 띄운 데몬은 그 터미널에서 멈추세요`, data);
    await pause(Math.min(200, remaining));
  }
}

export async function startDaemon({ env, launchctl, platform }: Options): Promise<DaemonStartData> {
  if (platform !== 'darwin' || launchctl.uid === undefined) return { status: 'unsupported', plist_path: null };
  const path = daemonPlistPath(env);
  try { await access(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DaemonControlError('DAEMON_NOT_INSTALLED', '데몬 plist가 없어 다시 올릴 Label이 없습니다');
    }
    throw new DaemonControlError('DAEMON_CONTROL_FAILED', '데몬 plist를 읽지 못했습니다');
  }
  if (await launchctl.isLoaded(DAEMON_LABEL)) return { status: 'already-loaded', plist_path: path };
  checked(await launchctl.bootstrap(path));
  return { status: 'started', plist_path: path };
}

export type DaemonRestartResult =
  | { ok: true; method: 'signal' | 'reload'; pid: number; commit: string }
  | { ok: false; message: string };

export async function restartDaemon(options: Options & {
  home: string;
  clock: Clock;
  plistChanged: boolean;
  expectCommit: string;
  waitMs?: number;
}): Promise<DaemonRestartResult> {
  const { env, launchctl, platform, plistChanged, expectCommit } = options;
  if (platform !== 'darwin' || launchctl.uid === undefined) return { ok: false, message: '이 운영체제에는 launchd가 없습니다' };
  if (!plistChanged) {
    const result = await launchctl.kill(DAEMON_LABEL, 'SIGTERM');
    if (!result.ok) return result;
  } else {
    const unloaded = await launchctl.bootout(DAEMON_LABEL);
    if (!unloaded.ok) return unloaded;
    let result = await launchctl.bootstrap(daemonPlistPath(env));
    for (let retry = 0; !result.ok && retry < 2; retry++) {
      await pause(1000);
      result = await launchctl.bootstrap(daemonPlistPath(env));
    }
    if (!result.ok) return result;
  }
  const deadline = Date.now() + (options.waitMs ?? DAEMON_RESTART_WAIT_MS);
  for (;;) {
    const state = await daemonLiveness({ home: options.home, clock: options.clock });
    if (state.alive && state.commit === expectCommit) {
      return { ok: true, method: plistChanged ? 'reload' : 'signal', pid: state.pid, commit: expectCommit };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false,
      message: `기다리는 동안 새 빌드 데몬을 확인하지 못했습니다 (pid ${state.pid ?? '없음'}, commit ${state.commit ?? '없음'})` };
    await pause(Math.min(200, remaining));
  }
}
