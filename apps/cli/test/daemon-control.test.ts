import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import * as timers from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as liveness from '../src/daemon/liveness.js';
import { startDaemon, stopDaemon, restartDaemon } from '../src/daemon/control.js';
import { DAEMON_LABEL, daemonPlistPath, type Launchctl, type LaunchctlResult } from '../src/daemon/launchd.js';
import { tempHomes } from './temp-home.js';

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
}));

const temporary = tempHomes();
afterEach(async () => { vi.restoreAllMocks(); await temporary.cleanup(); });
async function world(loaded = true) {
  const home = await temporary.create('brain-control-');
  const env = { SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents') };
  const calls: string[] = [];
  let failure: LaunchctlResult = { ok: true };
  const launchctl: Launchctl = {
    uid: 501,
    async isLoaded() { calls.push('print'); return loaded; },
    async bootout() { calls.push('bootout'); if (failure.ok) loaded = false; return failure; },
    async bootstrap() { calls.push('bootstrap'); if (failure.ok) loaded = true; return failure; },
    async kill(label, signal) { calls.push(`kill ${signal} ${label}`); return failure; },
  };
  const now = new Date();
  const options = { home, env, launchctl, platform: 'darwin' as const, clock: { now: () => now }, bootAt: () => now };
  return { options, calls, fail: () => { failure = { ok: false, message: '실패' }; },
    async owner(boot = now, pid = 4242) {
      await mkdir(join(home, 'run'), { recursive: true });
      await writeFile(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid, boot_at: boot.toISOString(), started_at: now.toISOString() }));
    },
    async plist() { await mkdir(join(home, 'agents')); await writeFile(daemonPlistPath(env), 'plist'); },
  };
}
describe('daemon control', () => {
  it('unloads and waits without sending any direct signal', async () => {
    const kit = await world(); await kit.owner();
    const signal = vi.spyOn(process, 'kill');
    let checks = 0;
    expect(await stopDaemon({ ...kit.options, isAlive: () => ++checks < 2 })).toEqual({ unloaded: true, owner_pid: null, alive: false });
    expect(kit.calls).toEqual(['print', 'bootout']); expect(signal).not.toHaveBeenCalled();
  });
  it('does not continue after a failed bootout', async () => {
    const kit = await world(); await kit.owner(); kit.fail();
    await expect(stopDaemon({ ...kit.options, isAlive: () => true })).rejects.toMatchObject({ code: 'DAEMON_CONTROL_FAILED', message: '실패' });
    expect(kit.calls).toEqual(['print', 'bootout']);
  });
  it.each(['absent', 'dead', 'old-boot'] as const)('ignores an %s owner', async (state) => {
    const kit = await world(false);
    if (state !== 'absent') await kit.owner(state === 'old-boot' ? new Date(0) : undefined);
    const signal = vi.spyOn(process, 'kill');
    expect(await stopDaemon({ ...kit.options, isAlive: () => state !== 'dead' })).toEqual({ unloaded: false, owner_pid: null, alive: false });
    expect(signal).not.toHaveBeenCalled(); expect(kit.calls).toEqual(['print']);
  });
  it.each(['linux', 'darwin'] as const)('leaves manual daemons alone on %s and reports the owner', async (platform) => {
    const kit = await world(false); await kit.owner();
    const signal = vi.spyOn(process, 'kill');
    await expect(stopDaemon({ ...kit.options, platform, isAlive: () => true, waitMs: 0 })).rejects.toMatchObject({
      code: 'DAEMON_CONTROL_FAILED', hint: expect.stringContaining('4242'),
      data: { unloaded: false, alive: true, owner_pid: 4242 },
    });
    expect(signal).not.toHaveBeenCalled(); expect(kit.calls).toEqual(platform === 'darwin' ? ['print'] : []);
  });
  it('reports a launchd owner that remains alive after bootout', async () => {
    const kit = await world(); await kit.owner();
    await expect(stopDaemon({ ...kit.options, isAlive: () => true, waitMs: 0 })).rejects.toMatchObject({
      code: 'DAEMON_CONTROL_FAILED', data: { unloaded: true, alive: true, owner_pid: 4242 },
    });
    expect(kit.calls).toEqual(['print', 'bootout']);
  });
  it('reports a replacement owner as still alive', async () => {
    const kit = await world(); await kit.owner();
    const bootout = kit.options.launchctl.bootout;
    kit.options.launchctl.bootout = async (label) => { const result = await bootout(label); await kit.owner(undefined, 4243); return result; };
    await expect(stopDaemon({ ...kit.options, isAlive: () => true, waitMs: 0 })).rejects.toMatchObject({
      data: { unloaded: true, alive: true, owner_pid: 4243 },
    });
  });
  it('rechecks the lock when its original owner dies during the wait', async () => {
    const kit = await world(); await kit.owner();
    const now = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(now);
    let replaced = false;
    const alive = vi.fn((pid: number) => pid === (replaced ? 4243 : 4242));
    const pause = vi.spyOn(timers, 'setTimeout').mockImplementation(async () => {
      expect(alive.mock.calls).toEqual([[4242]]);
      await kit.owner(undefined, 4243);
      replaced = true;
      time.mockReturnValue(now + 200);
    });
    await expect(stopDaemon({ ...kit.options, isAlive: alive, waitMs: 200 })).rejects.toMatchObject({
      code: 'DAEMON_CONTROL_FAILED', data: { unloaded: true, alive: true, owner_pid: 4243 },
    });
    expect(alive.mock.calls).toEqual([[4242], [4243]]);
    expect(pause).toHaveBeenCalledExactlyOnceWith(200);
    expect(kit.calls).toEqual(['print', 'bootout']);
  });
  it('makes no launchctl calls when uid is unavailable', async () => {
    const kit = await world();
    expect(await stopDaemon({ ...kit.options, launchctl: { ...kit.options.launchctl, uid: undefined } })).toEqual({ unloaded: false, owner_pid: null, alive: false });
    expect(kit.calls).toEqual([]);
  });
  it('starts an existing plist once and preserves it', async () => {
    const kit = await world(false); await kit.plist();
    expect(await startDaemon(kit.options)).toEqual({ status: 'started', plist_path: daemonPlistPath(kit.options.env) });
    expect(await startDaemon(kit.options)).toMatchObject({ status: 'already-loaded' });
    expect(kit.calls).toEqual(['print', 'bootstrap', 'print']);
  });
  it('rejects missing installation without calls and skips unsupported hosts', async () => {
    const kit = await world();
    await expect(startDaemon(kit.options)).rejects.toMatchObject({ code: 'DAEMON_NOT_INSTALLED' });
    expect(await startDaemon({ ...kit.options, platform: 'linux' })).toEqual({ status: 'unsupported', plist_path: null });
    expect(await startDaemon({ ...kit.options, launchctl: { ...kit.options.launchctl, uid: undefined } })).toMatchObject({ status: 'unsupported' });
    expect(kit.calls).toEqual([]);
  });
  it('reports bootstrap failures', async () => {
    const kit = await world(false); await kit.plist(); kit.fail();
    await expect(startDaemon(kit.options)).rejects.toMatchObject({ code: 'DAEMON_CONTROL_FAILED' });
  });
  const commit = 'b'.repeat(40);
  function observed() {
    return vi.spyOn(liveness, 'daemonLiveness').mockResolvedValue({ alive: true, pid: 4243, commit, heartbeatAt: new Date() });
  }
  it('observes the new build after signalling or reloading', async () => {
    const kit = await world(); const probe = observed();
    probe.mockResolvedValueOnce({ alive: true, pid: 4242, commit: 'a'.repeat(40), heartbeatAt: new Date() });
    expect(await restartDaemon({ ...kit.options, plistChanged: false, expectCommit: commit })).toEqual({ ok: true, method: 'signal', pid: 4243, commit });
    expect(kit.calls).toEqual([`kill SIGTERM ${DAEMON_LABEL}`]);
    expect(await restartDaemon({ ...kit.options, plistChanged: true, expectCommit: commit })).toEqual({ ok: true, method: 'reload', pid: 4243, commit });
    expect(kit.calls.slice(1)).toEqual(['bootout', 'bootstrap']);
  });
  it('observes a real live lock changing from the old commit to the expected commit', async () => {
    const kit = await world();
    const now = kit.options.clock.now();
    const oldCommit = 'a'.repeat(40);
    const lock = (build: string) => writeFile(join(kit.options.home, 'run', 'daemon.pid'), JSON.stringify({
      pid: process.pid, boot_at: new Date(now.getTime() - uptime() * 1000).toISOString(),
      started_at: now.toISOString(), commit: build,
    }));
    await mkdir(join(kit.options.home, 'run'));
    await lock(oldCommit);
    const heartbeat = join(kit.options.home, 'run', 'heartbeat');
    await writeFile(heartbeat, '');
    await utimes(heartbeat, now, now);
    const pause = vi.spyOn(timers, 'setTimeout').mockImplementation(async () => {
      expect(await liveness.daemonLiveness({ home: kit.options.home, clock: kit.options.clock }))
        .toMatchObject({ alive: true, pid: process.pid, commit: oldCommit });
      await lock(commit);
    });
    expect(await restartDaemon({ ...kit.options, plistChanged: false, expectCommit: commit })).toEqual({
      ok: true, method: 'signal', pid: process.pid, commit,
    });
    expect(pause).toHaveBeenCalledExactlyOnceWith(200);
    expect(kit.calls).toEqual([`kill SIGTERM ${DAEMON_LABEL}`]);
  });
  it('passes failed kill diagnostics through without polling', async () => {
    const kit = await world(); kit.fail(); const probe = observed();
    expect(await restartDaemon({ ...kit.options, plistChanged: false, expectCommit: commit })).toEqual({ ok: false, message: '실패' });
    expect(probe).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires a live matching build (alive=%s)', async (alive) => {
    const kit = await world();
    vi.spyOn(liveness, 'daemonLiveness').mockResolvedValue(alive
      ? { alive: true, pid: 4242, commit: 'a'.repeat(40), heartbeatAt: new Date() }
      : { alive: false, reason: 'no-heartbeat', pid: 4242, commit, heartbeatAt: null });
    expect(await restartDaemon({ ...kit.options, plistChanged: false, expectCommit: commit, waitMs: 0 })).toMatchObject({ ok: false, message: expect.stringContaining('pid 4242, commit') });
  });
  it('recovers from a transient bootstrap failure without retaining the failure', async () => {
    const kit = await world(); observed(); let attempts = 0;
    kit.options.launchctl.bootstrap = async () => { kit.calls.push('bootstrap'); return ++attempts === 1 ? { ok: false, message: '처음 실패' } : { ok: true }; };
    expect(await restartDaemon({ ...kit.options, plistChanged: true, expectCommit: commit })).toEqual({ ok: true, method: 'reload', pid: 4243, commit });
    expect(kit.calls).toEqual(['bootout', 'bootstrap', 'bootstrap']);
  });
  it('retries bootstrap twice and stops on bootout failure', async () => {
    const kit = await world();
    kit.options.launchctl.bootstrap = async () => { kit.calls.push('bootstrap'); return { ok: false, message: '실패' }; };
    expect(await restartDaemon({ ...kit.options, plistChanged: true, expectCommit: commit })).toEqual({ ok: false, message: '실패' });
    expect(kit.calls).toEqual(['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    kit.calls.length = 0; kit.fail();
    expect(await restartDaemon({ ...kit.options, plistChanged: true, expectCommit: commit })).toEqual({ ok: false, message: '실패' });
    expect(kit.calls).toEqual(['bootout']);
  });
});
