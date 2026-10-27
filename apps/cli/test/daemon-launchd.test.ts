import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_LABEL, daemonPlistPath, registerDaemon, renderDaemonPlist, systemLaunchctl,
  unregisterDaemon, type Launchctl, type LaunchctlResult,
} from '../src/daemon/launchd.js';
import { shimPath } from '../src/install/shim.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

const execute = promisify(execFile);
const temporary = tempHomes();
afterEach(() => temporary.cleanup());

async function world() {
  const home = await temporary.create('brain-launchd-');
  const env = {
    ...withoutHarnessFolders(process.env),
    SECOND_BRAIN_HOME: home,
    SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'),
    FAKE_LAUNCHCTL_DIR: join(home, 'launchctl'),
  };
  let loaded = false;
  const calls: string[] = [];
  let failure: LaunchctlResult = { ok: true };
  const launchctl: Launchctl = {
    uid: 501,
    async kill(label, signal) {
      calls.push(`kill ${signal} ${label}`);
      return loaded ? failure : { ok: false, message: '가짜 launchctl에 올라 있는 Label이 없습니다' };
    },
    async isLoaded(label) { calls.push(`print ${label}`); return loaded; },
    async bootstrap(path) { calls.push(`bootstrap ${path}`); if (failure.ok) loaded = true; return failure; },
    async bootout(label) { calls.push(`bootout ${label}`); if (failure.ok) loaded = false; return failure; },
  };
  return {
    home, env, calls, launchctl,
    options: { shim: shimPath(home), env, launchctl, platform: 'darwin' as const },
    fail: () => { failure = { ok: false, message: '등록을 거절했습니다' }; },
  };
}

describe('daemon launchd registration', () => {
  it('renders only the four keys, escapes XML and is a valid plist on macOS', async () => {
    const kit = await world();
    const plist = renderDaemonPlist('/tmp/a&b<c>\r/bin/brain');
    expect(plist.match(/<key>/g)).toHaveLength(4);
    expect(plist).toContain('<key>Label</key><string>' + DAEMON_LABEL + '</string>');
    expect(plist).toContain('<array><string>/tmp/a&amp;b&lt;c&gt;&#13;/bin/brain</string><string>daemon</string><string>run</string></array>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    if (process.platform === 'darwin') {
      const path = join(kit.home, 'check.plist');
      await writeFile(path, plist);
      await expect(execute('/usr/bin/plutil', ['-lint', path])).resolves.toBeDefined();
    }
  });

  it('registers once, preserves identical content, and updates a loaded job without restarting', async () => {
    const kit = await world();
    expect(await registerDaemon(kit.options)).toMatchObject({ status: 'registered', plist_changed: true });
    const path = daemonPlistPath(kit.env);
    const before = await stat(path);
    expect(before.mode & 0o777).toBe(0o644);
    const content = await readFile(path, 'utf8');
    await chmod(path, 0o666);
    expect(await registerDaemon(kit.options)).toMatchObject({ status: 'loaded', plist_changed: false });
    const repaired = await stat(path);
    expect(repaired.mode & 0o777).toBe(0o644);
    expect(repaired.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await registerDaemon({ ...kit.options, shim: '/tmp/new/bin/brain' })).toMatchObject({ status: 'loaded', plist_changed: true });
    expect(await readFile(path, 'utf8')).toContain('/tmp/new/bin/brain');
    expect(kit.calls.filter((call) => call.startsWith('bootstrap'))).toHaveLength(1);
    expect(kit.calls.filter((call) => call.startsWith('bootout'))).toHaveLength(0);
  });

  it('recognizes the established Label without bootstrapping a second job', async () => {
    const kit = await world();
    const loadedDir = join(kit.env.FAKE_LAUNCHCTL_DIR, 'loaded');
    await mkdir(loadedDir, { recursive: true });
    await writeFile(join(loadedDir, 'io.github.gmae199boy.second-brain.daemon'), '');
    const result = await registerDaemon({
      ...kit.options, launchctl: systemLaunchctl({ env: kit.env, uid: 501 }),
    });
    const path = join(kit.env.SECOND_BRAIN_LAUNCH_AGENTS, 'io.github.gmae199boy.second-brain.daemon.plist');
    expect(result).toMatchObject({
      status: 'loaded', label: 'io.github.gmae199boy.second-brain.daemon', plist_path: path,
    });
    expect(await readdir(kit.env.SECOND_BRAIN_LAUNCH_AGENTS)).toEqual(['io.github.gmae199boy.second-brain.daemon.plist']);
    expect(await readFile(path, 'utf8')).toContain('<key>Label</key><string>io.github.gmae199boy.second-brain.daemon</string>');
    expect(await readFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'calls'), 'utf8')).toBe('print gui/501/io.github.gmae199boy.second-brain.daemon\n');
    expect(await readdir(loadedDir)).toEqual(['io.github.gmae199boy.second-brain.daemon']);
  });

  it.each(['linux', 'missing uid'] as const)('skips all I/O for %s', async (kind) => {
    const kit = await world();
    if (kind === 'missing uid') kit.launchctl = { ...kit.launchctl, uid: undefined };
    const result = await registerDaemon({ ...kit.options, launchctl: kit.launchctl, platform: kind === 'linux' ? 'linux' : 'darwin' });
    expect(result).toMatchObject({ status: 'unsupported', plist_path: null, plist_changed: false });
    expect(kit.calls).toEqual([]);
    expect(await readdir(kit.home)).toEqual([]);
  });

  it('reports bootstrap and filesystem failures as values', async () => {
    const kit = await world();
    kit.fail();
    expect(await registerDaemon(kit.options)).toMatchObject({ status: 'failed', message: '등록을 거절했습니다' });
    await writeFile(join(kit.home, 'blocked'), 'file');
    expect(await registerDaemon({ ...kit.options, env: { SECOND_BRAIN_LAUNCH_AGENTS: join(kit.home, 'blocked', 'agents') } })).toMatchObject({ status: 'failed' });
  });

  it('bootouts before deleting, tolerates absent jobs/plists, and keeps plist when bootout fails', async () => {
    const kit = await world();
    await registerDaemon(kit.options);
    kit.fail();
    expect(await unregisterDaemon(kit.options)).toEqual({ ok: false, message: '등록을 거절했습니다' });
    expect(await readFile(daemonPlistPath(kit.env), 'utf8')).toContain(DAEMON_LABEL);
    const fresh = await world();
    await registerDaemon(fresh.options);
    expect(await unregisterDaemon(fresh.options)).toEqual({ ok: true, booted_out: true, plist_removed: true });
    expect(await unregisterDaemon(fresh.options)).toEqual({ ok: true, booted_out: false, plist_removed: false });
    await mkdir(join(fresh.home, 'agents'), { recursive: true });
    await writeFile(daemonPlistPath(fresh.env), 'old');
    expect(await unregisterDaemon(fresh.options)).toEqual({ ok: true, booted_out: false, plist_removed: true });
  });

  it('the system adapter uses its env, domain and argv and returns execution failures', async () => {
    const kit = await world();
    const adapter = systemLaunchctl({ env: kit.env, uid: 501 });
    await mkdir(kit.env.SECOND_BRAIN_LAUNCH_AGENTS, { recursive: true });
    await writeFile(daemonPlistPath(kit.env), renderDaemonPlist(shimPath(kit.home)));
    expect(await adapter.isLoaded(DAEMON_LABEL)).toBe(false);
    expect(await adapter.bootstrap(daemonPlistPath(kit.env))).toEqual({ ok: true });
    expect(await adapter.isLoaded(DAEMON_LABEL)).toBe(true);
    expect(await adapter.bootout(DAEMON_LABEL)).toEqual({ ok: true });
    expect((await readFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'calls'), 'utf8')).trim().split('\n')).toEqual([
      `print gui/501/${DAEMON_LABEL}`, `bootstrap gui/501 ${daemonPlistPath(kit.env)}`,
      `print gui/501/${DAEMON_LABEL}`, `bootout gui/501/${DAEMON_LABEL}`,
    ]);
    const absent = systemLaunchctl({ env: { SECOND_BRAIN_LAUNCHCTL: join(kit.home, 'absent') }, uid: 501 });
    expect(await absent.bootstrap('x')).toMatchObject({ ok: false });
    expect(await absent.isLoaded(DAEMON_LABEL)).toBe(false);
    const rejected = systemLaunchctl({ env: { ...kit.env, FAKE_LAUNCHCTL_FAIL: 'bootstrap' }, uid: 501 });
    expect(await rejected.bootstrap(daemonPlistPath(kit.env))).toMatchObject({ ok: false, message: expect.stringContaining('bootstrap을 거절했습니다') });
    expect(await adapter.bootstrap(join(kit.home, 'missing.plist'))).toMatchObject({
      ok: false, message: expect.stringContaining('plist 파일을 찾지 못했습니다'),
    });
  });

  it('times out a stalled launchctl before its sleep ends', async () => {
    const kit = await world();
    const path = join(kit.home, `${DAEMON_LABEL}.plist`);
    await writeFile(path, renderDaemonPlist(shimPath(kit.home)));
    const adapter = systemLaunchctl({
      env: { ...kit.env, FAKE_LAUNCHCTL_HANG: 'bootstrap' }, uid: 501,
    });
    const started = performance.now();
    expect(await adapter.bootstrap(path)).toMatchObject({ ok: false });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(await readFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'calls'), 'utf8')).toBe(`bootstrap gui/501 ${path}\n`);
  }, 20_000);
});

describe.skipIf(process.platform !== 'darwin')('built setup run launchd surface', () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  async function setup(env: NodeJS.ProcessEnv) {
    const result = await execute(process.execPath, [bin, 'setup', 'run', '--yes', '--json'], { env });
    return JSON.parse(result.stdout) as { ok: boolean; warnings: string[]; data: { daemon: { status: string } } };
  }
  it('installs twice with exactly one Label and one bootstrap', async () => {
    const kit = await world();
    expect((await setup(kit.env)).data.daemon.status).toBe('registered');
    expect((await setup(kit.env)).data.daemon.status).toBe('loaded');
    expect(await readdir(kit.env.SECOND_BRAIN_LAUNCH_AGENTS)).toEqual([`${DAEMON_LABEL}.plist`]);
    expect(await readFile(daemonPlistPath(kit.env), 'utf8')).toBe(renderDaemonPlist(shimPath(kit.home)));
    const calls = await readFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'calls'), 'utf8');
    expect(calls.split('\n').filter((call) => call.startsWith('bootstrap '))).toEqual([
      `bootstrap gui/${String(process.getuid?.())} ${daemonPlistPath(kit.env)}`,
    ]);
  });
  it('still records a completed install when bootstrap refuses', async () => {
    const kit = await world();
    const result = await setup({ ...kit.env, FAKE_LAUNCHCTL_FAIL: 'bootstrap' });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('DAEMON_NOT_REGISTERED');
    expect(result.data.daemon.status).toBe('failed');
    expect(JSON.parse(await readFile(join(kit.home, 'installed.json'), 'utf8'))).toBeDefined();
  });
  it('still records a completed install when launchctl is absent', async () => {
    const kit = await world();
    const result = await setup({
      ...kit.env,
      SECOND_BRAIN_LAUNCHCTL: join(kit.home, 'absent-launchctl'),
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain('DAEMON_NOT_REGISTERED');
    expect(result.data.daemon.status).toBe('failed');
    expect(JSON.parse(await readFile(join(kit.home, 'installed.json'), 'utf8'))).toBeDefined();
  });
});

it('sends restart signals through the adapter and rejects unloaded labels', async () => {
  const kit = await world();
  const adapter = systemLaunchctl({ env: kit.env, uid: 501 });
  expect(await adapter.kill(DAEMON_LABEL, 'SIGTERM')).toMatchObject({ ok: false });
  await mkdir(join(kit.env.FAKE_LAUNCHCTL_DIR, 'loaded'), { recursive: true });
  await writeFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'loaded', DAEMON_LABEL), '');
  expect(await adapter.kill(DAEMON_LABEL, 'SIGTERM')).toEqual({ ok: true });
  const calls = (await readFile(join(kit.env.FAKE_LAUNCHCTL_DIR, 'calls'), 'utf8')).trim().split('\n');
  expect(calls).toEqual([`kill SIGTERM gui/501/${DAEMON_LABEL}`, `kill SIGTERM gui/501/${DAEMON_LABEL}`]);
});

it('makes the memory signal fake reject unloaded labels and preserve loaded failures', async () => {
  const kit = await world();
  expect(await kit.launchctl.kill(DAEMON_LABEL, 'SIGTERM')).toEqual({ ok: false, message: '가짜 launchctl에 올라 있는 Label이 없습니다' });
  await kit.launchctl.bootstrap(daemonPlistPath(kit.env));
  expect(await kit.launchctl.kill(DAEMON_LABEL, 'SIGTERM')).toEqual({ ok: true });
  kit.fail();
  expect(await kit.launchctl.kill(DAEMON_LABEL, 'SIGTERM')).toEqual({ ok: false, message: '등록을 거절했습니다' });
});
