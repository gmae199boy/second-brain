import { access } from 'node:fs/promises';
import { uptime } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import type { Clock } from 'second_brain';
import { systemIsAlive } from '../runtime/spool.js';
import { ownerIsAlive, readDaemonLock } from './lock.js';
import { DAEMON_LABEL, daemonPlistPath, type Launchctl, type LaunchctlResult } from './launchd.js';

export const DAEMON_STOP_WAIT_MS = 20_000;
interface Options {
  env: NodeJS.ProcessEnv;
  launchctl: Launchctl;
  platform: NodeJS.Platform;
}
export interface DaemonStopData { unloaded: boolean; signalled_pid: number | null; alive: boolean }
export interface DaemonStartData {
  status: 'started' | 'already-loaded' | 'unsupported';
  plist_path: string | null;
}
export class DaemonControlError extends Error {
  constructor(readonly code: 'DAEMON_NOT_INSTALLED' | 'DAEMON_CONTROL_FAILED', message: string) {
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
  const owner = await readDaemonLock(options.home);
  if (owner === undefined || !ownerIsAlive(owner, { bootAt, isAlive })) {
    return { unloaded, signalled_pid: null, alive: false };
  }
  try { process.kill(owner.pid, 'SIGTERM'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new DaemonControlError('DAEMON_CONTROL_FAILED', '데몬에 SIGTERM을 보내지 못했습니다');
    }
  }
  const deadline = Date.now() + (options.waitMs ?? DAEMON_STOP_WAIT_MS);
  for (;;) {
    const current = await readDaemonLock(options.home);
    // Never signal a replacement owner. Only wait for the owner we addressed.
    if (current === undefined || current.pid !== owner.pid || !ownerIsAlive(current, { bootAt, isAlive })) {
      return { unloaded, signalled_pid: owner.pid, alive: false };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DaemonControlError('DAEMON_CONTROL_FAILED', '기다리는 동안 데몬이 멈추지 않았습니다');
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

export async function restartDaemon({ env, launchctl, platform, plistChanged }: Options & {
  plistChanged: boolean;
}): Promise<{ ok: true; method: 'signal' | 'reload' } | { ok: false; message: string }> {
  if (platform !== 'darwin' || launchctl.uid === undefined) return { ok: false, message: '이 운영체제에는 launchd가 없습니다' };
  if (!plistChanged) {
    const result = await launchctl.kill(DAEMON_LABEL, 'SIGTERM');
    return result.ok ? { ok: true, method: 'signal' } : result;
  }
  const unloaded = await launchctl.bootout(DAEMON_LABEL);
  if (!unloaded.ok) return unloaded;
  let result = await launchctl.bootstrap(daemonPlistPath(env));
  for (let retry = 0; !result.ok && retry < 2; retry++) {
    await pause(1000);
    result = await launchctl.bootstrap(daemonPlistPath(env));
  }
  return result.ok ? { ok: true, method: 'reload' } : result;
}
