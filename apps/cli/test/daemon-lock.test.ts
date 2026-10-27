import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock } from 'second_brain';
import { RUN_FOLDER, daemonPidPath } from '../src/config/paths.js';
import {
  BOOT_SLACK_MS,
  acquireDaemonLock,
  readDaemonLock,
  releaseDaemonLock,
} from '../src/daemon/lock.js';
import { tempHomes } from './temp-home.js';

/**
 * The daemon lock, on the rules rather than on a daemon: whether a pid is
 * alive, and when this machine booted, are the two seams, because the rows
 * that matter — a living owner, a pid from before the reboot, a competitor
 * reclaiming the same file — cannot be arranged by starting processes.
 *
 * The one rule everything here is about: a living owner is never taken over.
 * The install lock reclaims on age after thirty minutes, and this one must not,
 * or two daemons end up draining one database (`daemon/lock.ts`).
 */

const temporary = tempHomes();

afterEach(() => temporary.cleanup());

const NOW = new Date('2026-10-27T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

/** This boot, as far as these tests are concerned: an hour ago. */
const BOOT = new Date(NOW.getTime() - 3_600_000);
const bootAt = (): Date => BOOT;

/** Nothing is alive unless a case says so. */
const noneAlive = (): boolean => false;
const allAlive = (): boolean => true;

async function home(): Promise<string> {
  return temporary.create('brain-daemon-lock-');
}

/** A lock file written by hand: a document, or raw text for the broken case. */
async function plant(at: string, content: unknown): Promise<void> {
  await mkdir(join(at, RUN_FOLDER), { recursive: true, mode: 0o700 });
  const text = typeof content === 'string' ? content : `${JSON.stringify(content)}\n`;
  await writeFile(daemonPidPath(at), text, 'utf8');
}

/** One owner document, with the instants these tests use by default. */
function owner(pid: number, over: { bootAt?: Date; startedAt?: Date } = {}): object {
  return {
    pid,
    boot_at: (over.bootAt ?? BOOT).toISOString(),
    started_at: (over.startedAt ?? NOW).toISOString(),
  };
}

describe('taking the daemon lock where there is none', () => {
  it('writes the pid, the boot and the start, and reads them back', async () => {
    const at = await home();

    const lock = await acquireDaemonLock({ home: at, clock, pid: 4242, isAlive: noneAlive, bootAt });

    expect(lock.ok).toBe(true);
    const read = await readDaemonLock(at);
    expect(read).toEqual({ pid: 4242, bootAt: BOOT, startedAt: NOW });
    // One line of JSON, written whole: a reader must never meet half of it,
    // which is why the file is linked into place rather than written in place.
    const text = await readFile(daemonPidPath(at), 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      pid: 4242,
      boot_at: BOOT.toISOString(),
      started_at: NOW.toISOString(),
    });
  });

  it('leaves no temporary file behind in the run folder', async () => {
    const at = await home();

    await acquireDaemonLock({ home: at, clock, pid: 4242, isAlive: noneAlive, bootAt });

    expect(await readdir(join(at, RUN_FOLDER))).toEqual(['daemon.pid']);
  });

  it('answers nothing for a folder with no lock in it', async () => {
    expect(await readDaemonLock(await home())).toBeUndefined();
  });
});

describe('the daemon lock and a living owner', () => {
  it('refuses, and names the pid that holds it', async () => {
    const at = await home();
    await plant(at, owner(111));

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: allAlive, bootAt });

    expect(lock.ok).toBe(false);
    if (lock.ok) return;
    expect(lock.ownerPid).toBe(111);
    expect(lock.message).toContain('111');
    // The file is untouched: the owner is still the owner.
    expect((await readDaemonLock(at))?.pid).toBe(111);
  });

  it('refuses however old the lock is, which is the rule this file exists for', async () => {
    const at = await home();
    // Taken a month ago, which is an ordinary age for a daemon's lock. The
    // install lock would have reclaimed this after thirty minutes.
    await plant(at, owner(111, { startedAt: new Date(NOW.getTime() - 30 * 86_400_000) }));

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: allAlive, bootAt });

    expect(lock.ok).toBe(false);
    expect((await readDaemonLock(at))?.pid).toBe(111);
  });

  it('counts a pid this user may not signal as living, as the spool does', async () => {
    const at = await home();
    await plant(at, owner(1));
    // `systemIsAlive` answers EPERM as alive, and the default is that very
    // function — so this case drives the real one rather than a fake.
    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, bootAt });

    // pid 1 is launchd on macOS and init on Linux: there, and not ours.
    expect(lock.ok).toBe(false);
  });
});

describe('the daemon lock and a dead owner', () => {
  it('reclaims a pid that is gone, and the file names the new owner', async () => {
    const at = await home();
    await plant(at, owner(111));

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: noneAlive, bootAt });

    expect(lock.ok).toBe(true);
    expect((await readDaemonLock(at))?.pid).toBe(222);
    expect(await readdir(join(at, RUN_FOLDER))).toEqual(['daemon.pid']);
  });

  it('reclaims a living pid recorded in an earlier boot', async () => {
    const at = await home();
    // After a reboot the number will eventually belong to something else, and
    // without this the daemon would never start again (Design Notes).
    await plant(at, owner(111, { bootAt: new Date(BOOT.getTime() - BOOT_SLACK_MS - 1000) }));

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: allAlive, bootAt });

    expect(lock.ok).toBe(true);
    expect((await readDaemonLock(at))?.pid).toBe(222);
  });

  it('keeps a living pid whose recorded boot is only slightly early', async () => {
    const at = await home();
    // Inside the slack, which is there for a corrected clock rather than as an
    // age limit: this is the same boot, so the owner is still the owner.
    await plant(at, owner(111, { bootAt: new Date(BOOT.getTime() - BOOT_SLACK_MS + 1000) }));

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: allAlive, bootAt });

    expect(lock.ok).toBe(false);
    expect((await readDaemonLock(at))?.pid).toBe(111);
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'nonsense\n'],
    ['JSON with no pid', '{"boot_at":"2026-10-27T08:00:00.000Z"}\n'],
    ['a pid that is not a number', '{"pid":"x","boot_at":"2026-10-27T08:00:00.000Z","started_at":"2026-10-27T09:00:00.000Z"}\n'],
    ['an instant nobody can parse', '{"pid":111,"boot_at":"어제","started_at":"어제"}\n'],
  ])('reclaims a lock whose content is %s', async (_what, text) => {
    const at = await home();
    await plant(at, text);

    const lock = await acquireDaemonLock({ home: at, clock, pid: 222, isAlive: allAlive, bootAt });

    // A lock nobody can read names no owner to protect.
    expect(lock.ok).toBe(true);
    expect((await readDaemonLock(at))?.pid).toBe(222);
  });
});

describe('the daemon lock and a competitor', () => {
  it('puts back a lock that turned out to be somebody else’s, and refuses', async () => {
    const at = await home();
    await plant(at, owner(111));
    const target = daemonPidPath(at);

    // The race, arranged at the one moment it can happen: between the read of
    // the owner and the rename that moves it aside. `isAlive` is called right
    // in that gap, so a competitor writing its own lock there is exactly the
    // file the rename would take away.
    const lock = await acquireDaemonLock({
      home: at,
      clock,
      pid: 222,
      isAlive: (pid) => {
        if (pid === 111) {
          writeFileSync(target, `${JSON.stringify(owner(333))}\n`, 'utf8');
        }
        return false;
      },
      bootAt,
    });

    expect(lock.ok).toBe(false);
    if (lock.ok) return;
    expect(lock.ownerPid).toBe(333);
    // Back where it was, whole, and nothing left aside.
    expect((await readDaemonLock(at))?.pid).toBe(333);
    expect(await readdir(join(at, RUN_FOLDER))).toEqual(['daemon.pid']);
  });
});

describe('releasing the daemon lock', () => {
  it('removes the file when it is still this pid’s', async () => {
    const at = await home();
    const lock = await acquireDaemonLock({ home: at, clock, pid: 4242, isAlive: noneAlive, bootAt });
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    await lock.release();

    expect(existsSync(daemonPidPath(at))).toBe(false);
  });

  it('leaves somebody else’s lock alone', async () => {
    const at = await home();
    await plant(at, owner(999));

    // A daemon whose lock was reclaimed while it was being killed must not
    // delete the new owner's file on its way out.
    await releaseDaemonLock(at, 4242);

    expect((await readDaemonLock(at))?.pid).toBe(999);
  });

  it('says nothing about a lock that is already gone', async () => {
    const at = await home();

    await expect(releaseDaemonLock(at, 4242)).resolves.toBeUndefined();
  });
});
