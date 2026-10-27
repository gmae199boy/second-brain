import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorLine, type Clock } from 'second_brain';
import { heartbeatPath } from '../config/paths.js';
import type { DaemonLog } from './log.js';

/**
 * The daemon's heartbeat: `<home>/run/heartbeat`, rewritten on its own timer.
 *
 * The record is the mtime, which is what story 9.3 reads to decide whether a
 * daemon that holds the lock is actually working. The line inside is the same
 * instant written out, so a person who opens the file sees it too.
 *
 * It is a timer of its own and not a step of the drain loop, and that is the
 * point: a drain that is stuck inside a handler must still look alive, or
 * rather — must still stop looking alive for the right reason. A heartbeat tied
 * to the loop would stop at the same moment the work did, and `daemon status`
 * could no longer tell "the process is gone" from "the process is busy".
 *
 * A write that fails is one log line and nothing else. The heartbeat is
 * evidence about the daemon, and evidence that cannot be written is not a
 * reason to stop doing the work it is evidence of.
 */
export interface Heartbeat {
  /** Stop the timer and await any pending write. Idempotent, and leaves the file. */
  stop(): Promise<void>;
}

export interface HeartbeatOptions {
  home: string;
  clock: Clock;
  /** How often to rewrite it. `DAEMON_HEARTBEAT_MS` for a real daemon. */
  intervalMs: number;
  log: DaemonLog;
}

/**
 * Write the mark once, then every `intervalMs`.
 *
 * The first write is awaited, so a caller that starts a daemon and looks for
 * the file finds it: a heartbeat that only appeared after the first interval
 * would make a freshly started daemon indistinguishable from a stalled one for
 * thirty seconds.
 */
export async function startHeartbeat(options: HeartbeatOptions): Promise<Heartbeat> {
  const { home, clock, intervalMs, log } = options;
  await beat(home, clock, log);

  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending !== undefined) return;
    pending = beat(home, clock, log).finally(() => {
      pending = undefined;
    });
  }, intervalMs);

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      await pending;
    },
  };
}

/** One mark, written whole. Reports a failure and keeps the daemon running. */
async function beat(home: string, clock: Clock, log: DaemonLog): Promise<void> {
  const path = heartbeatPath(home);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${clock.now().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    await log.write(`heartbeat를 쓸 수 없었습니다: ${errorLine(error)}`);
  }
}
