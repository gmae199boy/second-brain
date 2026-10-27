import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { uptime } from 'node:os';
import type { Clock } from 'second_brain';
import { daemonPidPath } from '../config/paths.js';
import { systemIsAlive } from '../runtime/spool.js';

/**
 * The daemon's single-instance lock: `<home>/run/daemon.pid`.
 *
 * One daemon per configuration folder. The rule the whole module exists for is
 * that **a living owner is never taken over** — only a dead one is reclaimed.
 * The install lock reclaims on age after thirty minutes (`LOCK_FOLDER`), and
 * bringing that rule here would be exactly wrong: a daemon is supposed to hold
 * its lock for weeks, so an age limit would end in two daemons draining one
 * database and a pid file naming only the newer of them.
 *
 * Dead means one of three things, and every one of them is a fact about the
 * owner rather than about the clock:
 *
 *   * the signal says `ESRCH` — there is no such process. `EPERM` is a process
 *     this user may not signal, which is a living process (`systemIsAlive`);
 *   * the lock records a boot more than `BOOT_SLACK_MS` before this machine's
 *     current boot. A pid from a previous boot is dead by definition, and after
 *     a reboot some other process will eventually be given that number — which
 *     without this check would keep the daemon from ever starting again;
 *   * the file cannot be read or parsed. A lock nobody can read names no owner
 *     to protect.
 *
 * The slack is there because the boot instant is derived from `os.uptime()` and
 * a clock that was corrected moves it. Ten minutes is far more than any
 * correction and far less than the time between two boots. Even a reclaim that
 * was wrong is survivable rather than corrupting: the drain is built for
 * concurrent runs (AD-7).
 */

/** The three fields of the lock file, as the JSON line spells them. */
interface LockDocument {
  pid: number;
  boot_at: string;
  started_at: string;
}

/** The owner of a lock, as `readDaemonLock` reports it. */
export interface DaemonLockOwner {
  pid: number;
  /** When the machine the owner runs on booted, as the owner computed it. */
  bootAt: Date;
  /** When the owner took the lock. */
  startedAt: Date;
}

/**
 * How far before this boot a recorded boot may be and still count as this one.
 * See the module comment: it is slack for a corrected clock, not an age limit.
 */
export const BOOT_SLACK_MS = 600_000;

export interface DaemonLockOptions {
  home: string;
  clock: Clock;
  /** The pid to write. Defaults to this process's. */
  pid?: number;
  /**
   * Whether a pid is a living process. The default is the one `systemIsAlive`
   * rule the spool uses; a test hands in its own, because arranging a pid that
   * is alive, dead, or not this user's cannot be done from a test otherwise.
   */
  isAlive?: (pid: number) => boolean;
  /**
   * When this machine booted. Derived from `os.uptime()` by default — and a
   * seam, because the previous-boot row of the matrix cannot be arranged by
   * rebooting the machine the tests run on.
   */
  bootAt?: () => Date;
}

/** The shared previous-boot and process-existence rule for a lock owner. */
export function ownerIsAlive(
  owner: DaemonLockOwner,
  options: { isAlive?: (pid: number) => boolean; bootAt: () => Date },
): boolean {
  return owner.bootAt.getTime() >= options.bootAt().getTime() - BOOT_SLACK_MS &&
    (options.isAlive ?? systemIsAlive)(owner.pid);
}

export type DaemonLockResult =
  | {
      ok: true;
      /** The pid written into the file. */
      pid: number;
      /** Remove the lock, but only while it is still this pid's. */
      release(): Promise<void>;
    }
  | {
      ok: false;
      /**
       * The living owner this call refused to take the lock from, or `null`
       * when the file could not be read at the moment of the refusal — which
       * is a competitor having just written one, not an absence.
       */
      ownerPid: number | null;
      /** One Korean line naming the owner, for the failure and the log. */
      message: string;
    };

/**
 * Take the lock, or report who holds it.
 *
 * The create is atomic in two steps, and both matter. The content is written to
 * `daemon.pid.<pid>.tmp` first and `link`ed into place second, so a reader
 * never sees half a line — `readDaemonLock` is what story 9.3 answers `daemon
 * status` from, and "the file exists but is empty" would be an owner it could
 * not name. `link` is the create: it fails with `EEXIST` rather than replacing,
 * which is what makes two daemons starting in the same millisecond end with one
 * lock and one refusal.
 */
export async function acquireDaemonLock(options: DaemonLockOptions): Promise<DaemonLockResult> {
  const { home, clock } = options;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? systemIsAlive;
  const bootAt = options.bootAt ?? (() => new Date(clock.now().getTime() - uptime() * 1000));
  const target = daemonPidPath(home);

  const taken = await take(target, pid, clock, bootAt());
  if (taken) return held(home, pid);

  const owner = await readOwner(target);
  // A boot from before this one is dead whatever the signal says: after a
  // reboot the number may well belong to something else entirely. Spelled as
  // one condition for the living case, because that is the case that returns:
  // everything else falls through to the reclaim.
  if (
    owner !== undefined &&
    ownerIsAlive(owner, { isAlive, bootAt })
  ) {
    return refused(owner.pid);
  }

  const reclaimed = await reclaim(target, owner?.pid, pid);
  if (!reclaimed) return refused((await readOwner(target))?.pid ?? null);

  // One more attempt, and one only: a second competitor that got in between the
  // reclaim and this line is a living owner, which is exactly what must not be
  // taken over.
  if (await take(target, pid, clock, bootAt())) return held(home, pid);
  return refused((await readOwner(target))?.pid ?? null);
}

/**
 * What the lock file says, or `undefined` when there is none or it cannot be
 * read. Story 9.3 reports the owner and the instant from here, which is why it
 * is a reader of its own rather than something only `acquire` can see.
 */
export async function readDaemonLock(home: string): Promise<DaemonLockOwner | undefined> {
  return readOwner(daemonPidPath(home));
}

/** The success branch, with the one thing the caller may do to the lock. */
function held(home: string, pid: number): DaemonLockResult {
  return {
    ok: true,
    pid,
    release: () => releaseDaemonLock(home, pid),
  };
}

function refused(ownerPid: number | null): DaemonLockResult {
  const who = ownerPid === null ? '다른 프로세스' : `pid ${String(ownerPid)}`;
  return {
    ok: false,
    ownerPid,
    message: `이 설정 폴더의 데몬이 이미 떠 있습니다 — 주인은 ${who}입니다`,
  };
}

/**
 * Remove the lock, but only while the file still names this pid.
 *
 * The check is the whole function. A daemon that was killed after its lock was
 * reclaimed and before it noticed would otherwise delete the new owner's file
 * on its way out, and the next start would find no lock at all.
 */
export async function releaseDaemonLock(home: string, pid: number): Promise<void> {
  const target = daemonPidPath(home);
  const owner = await readOwner(target);
  if (owner?.pid !== pid) return;
  await unlink(target).catch(() => undefined);
}

/**
 * Write the content to a temporary file and `link` it into place. `true` when
 * the lock is now this pid's, `false` when somebody already holds it.
 *
 * Anything other than `EEXIST` is thrown: a run folder that cannot be written
 * to is not a lock somebody else holds, and reporting it as one would tell the
 * person to look for a daemon that does not exist.
 */
async function take(target: string, pid: number, clock: Clock, boot: Date): Promise<boolean> {
  const temporary = `${target}.${String(pid)}.tmp`;
  const document: LockDocument = {
    pid,
    boot_at: boot.toISOString(),
    started_at: clock.now().toISOString(),
  };
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 });
    await link(temporary, target);
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Move a dead owner's lock aside and make sure that is what was moved.
 *
 * `rename` is atomic, so what it moved is whatever was at the name — which,
 * between the read above and this line, may be a lock a competitor has just
 * created. So the moved file is read again: the same dead owner means the
 * reclaim was right and the file is removed; anybody else means a living lock
 * was taken by accident, and it is `link`ed straight back.
 *
 * `false` means "do not take the lock": either the file was put back, or it
 * disappeared under us, which means somebody else is already reclaiming it.
 */
async function reclaim(
  target: string,
  ownerPid: number | undefined,
  ownPid: number,
): Promise<boolean> {
  const aside = `${target}.stale-${ownerPid === undefined ? 'unreadable' : String(ownerPid)}-${String(ownPid)}`;
  try {
    await rename(target, aside);
  } catch (error) {
    // Gone already: another starter reclaimed it, and its lock — or the gap it
    // left — is what the next `take` will meet.
    if (isCode(error, 'ENOENT')) return true;
    throw error;
  }

  const moved = await readOwner(aside);
  if (moved?.pid === ownerPid) {
    await unlink(aside).catch(() => undefined);
    return true;
  }

  try {
    await link(aside, target);
  } catch (error) {
    // Somebody else wrote a lock in the meantime; theirs stands, and ours is
    // the one that goes away.
    if (!isCode(error, 'EEXIST')) throw error;
  }
  await unlink(aside).catch(() => undefined);
  return false;
}

/** One lock file, parsed, or `undefined` for anything that is not one. */
async function readOwner(path: string): Promise<DaemonLockOwner | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;

  const { pid, boot_at: bootAt, started_at: startedAt } = document as Partial<LockDocument>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  const boot = instant(bootAt);
  const started = instant(startedAt);
  if (boot === undefined || started === undefined) return undefined;
  return { pid, bootAt: boot, startedAt: started };
}

function instant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown }).code === code;
}
