import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startDaemon, stopDaemon, restartDaemon } from '../src/daemon/control.js';
import { DAEMON_LABEL, daemonPlistPath, type Launchctl, type LaunchctlResult } from '../src/daemon/launchd.js';
import { tempHomes } from './temp-home.js';

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
    async owner(boot = now) {
      await mkdir(join(home, 'run'), { recursive: true });
      await writeFile(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid: 4242, boot_at: boot.toISOString(), started_at: now.toISOString() }));
    },
    async plist() { await mkdir(join(home, 'agents')); await writeFile(daemonPlistPath(env), 'plist'); },
  };
}
describe('daemon control', () => {
  it('unloads before signalling only the lock owner and waits for exit', async () => {
    const kit = await world(); await kit.owner();
    let alive = true;
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      expect(pid).toBe(4242); expect(sig).toBe('SIGTERM'); kit.calls.push('signal'); alive = false; return true;
    });
    expect(await stopDaemon({ ...kit.options, isAlive: () => alive })).toEqual({ unloaded: true, signalled_pid: 4242, alive: false });
    expect(kit.calls).toEqual(['print', 'bootout', 'signal']); expect(signal).toHaveBeenCalledTimes(1);
  });
  it('does not signal after a failed bootout', async () => {
    const kit = await world(); await kit.owner(); kit.fail();
    const signal = vi.spyOn(process, 'kill');
    await expect(stopDaemon({ ...kit.options, isAlive: () => true })).rejects.toMatchObject({ code: 'DAEMON_CONTROL_FAILED' });
    expect(signal).not.toHaveBeenCalled();
  });
  it.each(['absent', 'dead', 'old-boot'] as const)('does not signal an %s owner', async (state) => {
    const kit = await world(false);
    if (state !== 'absent') await kit.owner(state === 'old-boot' ? new Date(0) : undefined);
    const signal = vi.spyOn(process, 'kill');
    expect(await stopDaemon({ ...kit.options, isAlive: () => state !== 'dead' })).toEqual({ unloaded: false, signalled_pid: null, alive: false });
    expect(signal).not.toHaveBeenCalled(); expect(kit.calls).toEqual(['print']);
  });
  it('stops a manual daemon off macOS and reports timeout without SIGKILL', async () => {
    const kit = await world(); await kit.owner();
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(stopDaemon({ ...kit.options, platform: 'linux', isAlive: () => true, waitMs: 1 })).rejects.toMatchObject({ code: 'DAEMON_CONTROL_FAILED' });
    expect(kit.calls).toEqual([]); expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
  });
  it('stops a manually started owner without launchd registration', async () => {
    const kit = await world(false); await kit.owner(); let alive = true;
    vi.spyOn(process, 'kill').mockImplementation(() => { alive = false; return true; });
    expect(await stopDaemon({ ...kit.options, isAlive: () => alive })).toEqual({ unloaded: false, signalled_pid: 4242, alive: false });
    expect(kit.calls).toEqual(['print']);
  });
  it('makes no launchctl calls when uid is unavailable', async () => {
    const kit = await world();
    expect(await stopDaemon({ ...kit.options, launchctl: { ...kit.options.launchctl, uid: undefined } })).toEqual({ unloaded: false, signalled_pid: null, alive: false });
    expect(kit.calls).toEqual([]);
  });
  it('ignores ESRCH', async () => {
    const kit = await world(false); await kit.owner(); let alive = true;
    vi.spyOn(process, 'kill').mockImplementation(() => { alive = false; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    expect(await stopDaemon({ ...kit.options, isAlive: () => alive })).toMatchObject({ alive: false });
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
  it('signals unchanged jobs and reloads changed plists', async () => {
    const kit = await world();
    expect(await restartDaemon({ ...kit.options, plistChanged: false })).toEqual({ ok: true, method: 'signal' });
    expect(kit.calls).toEqual([`kill SIGTERM ${DAEMON_LABEL}`]);
    expect(await restartDaemon({ ...kit.options, plistChanged: true })).toEqual({ ok: true, method: 'reload' });
    expect(kit.calls.slice(1)).toEqual(['bootout', 'bootstrap']);
  });
  it('retries bootstrap twice after unloading, and stops on a bootout failure', async () => {
    const kit = await world();
    kit.options.launchctl.bootstrap = async () => { kit.calls.push('bootstrap'); return { ok: false, message: '실패' }; };
    expect(await restartDaemon({ ...kit.options, plistChanged: true })).toEqual({ ok: false, message: '실패' });
    expect(kit.calls).toEqual(['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    kit.calls.length = 0; kit.fail();
    expect(await restartDaemon({ ...kit.options, plistChanged: true })).toEqual({ ok: false, message: '실패' });
    expect(kit.calls).toEqual(['bootout']);
  });
});
