import { stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import type { Clock } from 'second_brain';
import { heartbeatPath } from '../config/paths.js';
import { ownerIsAlive, readDaemonLock } from './lock.js';

export const DAEMON_HEARTBEAT_MS = 30_000;
/** Three missed heartbeat intervals allow scheduling delays before falling back to command drain. */
export const DAEMON_ALIVE_MS = 3 * DAEMON_HEARTBEAT_MS;

export type DaemonDeadReason = 'no-lock' | 'pid-dead' | 'no-heartbeat' | 'future-heartbeat' | 'stale-heartbeat';
export type DaemonLiveness =
  | { alive: true; pid: number; heartbeatAt: Date }
  | { alive: false; reason: DaemonDeadReason; pid: number | null; heartbeatAt: Date | null };

/** Read-only and conservative: unreadable files mean no daemon to rely on. */
export async function daemonLiveness(options: {
  home: string;
  clock: Clock;
  isAlive?: (pid: number) => boolean;
  bootAt?: () => Date;
}): Promise<DaemonLiveness> {
  const owner = await readDaemonLock(options.home).catch(() => undefined);
  const heartbeatAt = await stat(heartbeatPath(options.home))
    .then((info) => new Date(Math.floor(info.mtimeMs))).catch(() => null);
  const dead = (reason: DaemonDeadReason): DaemonLiveness => ({
    alive: false, reason, pid: owner?.pid ?? null, heartbeatAt,
  });
  if (owner === undefined) return dead('no-lock');
  try {
    const bootAt = options.bootAt ?? (() => new Date(options.clock.now().getTime() - uptime() * 1000));
    if (!ownerIsAlive(owner, { bootAt, ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }) })) return dead('pid-dead');
    if (heartbeatAt === null) return dead('no-heartbeat');
    const age = options.clock.now().getTime() - heartbeatAt.getTime();
    if (age < 0) return dead('future-heartbeat');
    if (age > DAEMON_ALIVE_MS || !Number.isFinite(age)) return dead('stale-heartbeat');
    return { alive: true, pid: owner.pid, heartbeatAt };
  } catch {
    return dead('pid-dead');
  }
}

/** The same Korean explanation on status and doctor. */
export function daemonDeadReason(reason: DaemonDeadReason): string {
  return {
    'no-lock': '잠금 주인이 없습니다',
    'pid-dead': '잠금 주인의 프로세스가 죽었거나 이전 부팅의 기록입니다',
    'no-heartbeat': 'heartbeat 기록이 없습니다',
    'future-heartbeat': 'heartbeat 시각이 미래입니다',
    'stale-heartbeat': '마지막 heartbeat가 90초를 넘었습니다',
  }[reason];
}
