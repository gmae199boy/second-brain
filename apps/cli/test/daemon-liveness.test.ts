import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isoWithOffset } from 'second_brain';
import { daemonLiveness, DAEMON_ALIVE_MS, DAEMON_HEARTBEAT_MS } from '../src/daemon/liveness.js';
import { runtimeChecks } from '../src/doctor/checks.js';
import { tempHomes } from './temp-home.js';

const temporary = tempHomes();
afterEach(() => temporary.cleanup());
const now = new Date('2026-10-27T12:00:00Z');
const clock = { now: () => now };
const boot = new Date('2026-10-27T00:00:00Z');
async function state(age: number | null = 89_000): Promise<string> {
  const home = await temporary.create('brain-liveness-');
  await mkdir(join(home, 'run'));
  await writeFile(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid: process.pid, boot_at: boot.toISOString(), started_at: now.toISOString() }));
  if (age !== null) {
    const path = join(home, 'run', 'heartbeat');
    await writeFile(path, 'ignored: only mtime matters');
    const at = new Date(now.getTime() - age);
    await utimes(path, at, at);
  }
  return home;
}
function inspect(home: string, isAlive = () => true, bootAt = () => boot) {
  return daemonLiveness({ home, clock, isAlive, bootAt });
}

describe('daemon liveness', () => {
  it('allows three heartbeat intervals', () => {
    expect(DAEMON_ALIVE_MS).toBe(3 * DAEMON_HEARTBEAT_MS);
    expect(DAEMON_ALIVE_MS).toBe(90_000);
  });
  it.each([89_000, 90_000])('is alive at age %i', async (age) => {
    const home = await state(age);
    expect(await inspect(home)).toEqual({ alive: true, pid: process.pid, heartbeatAt: new Date(now.getTime() - age) });
  });
  it.each([[91_000, 'stale-heartbeat'], [-1000, 'future-heartbeat'], [null, 'no-heartbeat']] as const)('rejects age %s as %s', async (age, reason) => {
    expect(await inspect(await state(age))).toMatchObject({ alive: false, reason, pid: process.pid });
  });
  it('keeps the heartbeat when the lock is absent or broken', async () => {
    const home = await state();
    const at = new Date(Math.floor((await stat(join(home, 'run', 'heartbeat'))).mtimeMs));
    await rm(join(home, 'run', 'daemon.pid'));
    expect(await inspect(home)).toEqual({ alive: false, reason: 'no-lock', pid: null, heartbeatAt: at });
    await writeFile(join(home, 'run', 'daemon.pid'), '{broken');
    expect(await inspect(home)).toMatchObject({ alive: false, reason: 'no-lock', heartbeatAt: at });
  });
  it('checks the lock owner before heartbeat and preserves the read fields', async () => {
    const home = await state(-1000);
    expect(await inspect(home, () => false)).toMatchObject({ alive: false, reason: 'pid-dead', pid: process.pid, heartbeatAt: expect.any(Date) });
    expect(await inspect(home, () => true, () => new Date(boot.getTime() + 600_001))).toMatchObject({ alive: false, reason: 'pid-dead' });
  });
  it('never throws for unreadable files or a failing process probe', async () => {
    const home = await state();
    expect(await inspect(home, () => { throw new Error('probe'); })).toMatchObject({ alive: false, reason: 'pid-dead' });
    await rm(join(home, 'run'), { recursive: true });
    await writeFile(join(home, 'run'), 'not a directory');
    expect(await inspect(home)).toEqual({ alive: false, reason: 'no-lock', pid: null, heartbeatAt: null });
  });
});

describe('doctor daemon check', () => {
  it('warns without a code for missing files', async () => {
    const home = await temporary.create('brain-doctor-daemon-');
    const source = runtimeChecks({ home, clock }).find((entry) => entry.id === 'daemon');
    expect(await source?.run()).toEqual({ id: 'daemon', status: 'warn', detail: '데몬이 살아 있지 않습니다: 잠금 주인이 없습니다' });
  });
  it('reports the real pid and last heartbeat and warns when it becomes stale', async () => {
    // A current boot is needed because this check uses the system process probe.
    const { uptime } = await import('node:os');
    const home = await state();
    await writeFile(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid: process.pid, boot_at: new Date(now.getTime() - uptime() * 1000).toISOString(), started_at: now.toISOString() }));
    const source = runtimeChecks({ home, clock }).find((entry) => entry.id === 'daemon');
    const good = await source?.run();
    expect(good).toMatchObject({ status: 'ok', detail: expect.stringContaining(`pid ${String(process.pid)}`) });
    expect(good?.detail).toContain(isoWithOffset(new Date(now.getTime() - 89_000)));
    await utimes(join(home, 'run', 'heartbeat'), now, new Date(now.getTime() - 91_000));
    const stale = await source?.run();
    expect(stale).toMatchObject({ status: 'warn', detail: expect.stringContaining('90초') });
    expect(stale?.code).toBeUndefined();
    expect(stale?.detail).toContain(isoWithOffset(new Date(now.getTime() - 91_000)));
  });
});
