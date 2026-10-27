import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DAEMON_LABEL, daemonPlistPath } from '../src/daemon/launchd.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

const temporary = tempHomes();
let daemon: ChildProcess | undefined;
afterEach(async () => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM'); await once(daemon, 'close');
  }
  daemon = undefined;
  await temporary.cleanup();
});
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const installer = fileURLToPath(new URL('../dist/install.js', import.meta.url));
function run(args: string[], env: NodeJS.ProcessEnv, script = bin): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function installed() {
  const home = await temporary.create('brain-uninstall-');
  const fake = join(home, 'launchctl');
  const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'), SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'),
    FAKE_LAUNCHCTL_DIR: fake, FAKE_LAUNCHCTL_PID_FILE: join(home, 'managed-pid') };
  const result = await run(['--yes'], env, installer);
  expect(result.code, result.stderr).toBe(0);
  return { home, fake, env };
}
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

it.skipIf(process.platform !== 'darwin')('uninstalls only daemon traces, waits for shutdown, and is idempotent', async () => {
  const { home, fake, env } = await installed();
  daemon = spawn(process.execPath, [bin, 'daemon', 'run'], { env, stdio: 'ignore' });
  const closed = once(daemon, 'close');
  const deadline = Date.now() + 10_000;
  let alive = false;
  do {
    alive = JSON.parse((await run(['daemon', 'status', '--json'], env)).stdout).data.alive;
    if (alive) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  expect(alive).toBe(true);
  await mkdir(join(fake, 'loaded'), { recursive: true });
  await writeFile(join(fake, 'loaded', DAEMON_LABEL), '');
  await writeFile(join(home, 'managed-pid'), String(daemon.pid));
  await writeFile(join(home, 'log', 'daemon.log.1'), 'old log');
  await mkdir(join(home, 'files'), { recursive: true });
  await writeFile(join(home, 'files', 'sample.txt'), 'user data');
  const retained = ['brain.db', 'installed.json', 'bin/brain', 'config.toml', 'files/sample.txt'];
  const before = await Promise.all(retained.map((path) => digest(join(home, path))));
  const files = await readdir(join(home, 'files'), { recursive: true });
  const traces = ['run/daemon.pid', 'run/heartbeat', 'log/daemon.log', 'log/daemon.log.1'].map((path) => join(home, path));
  const result = await run(['setup', 'uninstall', '--json'], env);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).data).toMatchObject({ label: DAEMON_LABEL, plist_path: daemonPlistPath(env), unloaded: true, plist_removed: true });
  await closed;
  expect(daemon.exitCode).toBe(0);
  for (const path of [...traces, daemonPlistPath(env)]) expect(existsSync(path)).toBe(false);
  expect(await Promise.all(retained.map((path) => digest(join(home, path))))).toEqual(before);
  expect(await readdir(join(home, 'files'), { recursive: true })).toEqual(files);
  const bootouts = async () => (await readFile(join(fake, 'calls'), 'utf8')).split('\n').filter((line) => line.startsWith('bootout'));
  expect(await bootouts()).toEqual([`bootout gui/${String(process.getuid?.())}/${DAEMON_LABEL}`]);
  const second = await run(['setup', 'uninstall', '--json'], env);
  expect(second.code, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout).data).toMatchObject({ unloaded: false, plist_removed: false, removed: [] });
  expect(await bootouts()).toHaveLength(1);
  for (const path of [...traces, daemonPlistPath(env)]) expect(existsSync(path)).toBe(false);
  expect(await Promise.all(retained.map((path) => digest(join(home, path))))).toEqual(before);
  expect(await readdir(join(home, 'files'), { recursive: true })).toEqual(files);
}, 30_000);

it.skipIf(process.platform !== 'darwin')('returns a failure envelope and preserves traces when bootout fails', async () => {
  const { home, env } = await installed();
  await mkdir(join(home, 'run'), { recursive: true });
  await mkdir(join(home, 'log'), { recursive: true });
  const traces = ['run/daemon.pid', 'run/heartbeat', 'log/daemon.log'].map((path) => join(home, path));
  for (const path of traces) await writeFile(path, 'trace');
  const result = await run(['setup', 'uninstall', '--json'], { ...env, FAKE_LAUNCHCTL_FAIL: 'bootout' });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.code).toBe('DAEMON_CONTROL_FAILED');
  for (const path of [...traces, daemonPlistPath(env)]) expect(existsSync(path)).toBe(true);
});

it('runs without configuration or a database and prints the Korean no-op message', async () => {
  const home = await temporary.create('brain-uninstall-empty-');
  const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'), FAKE_LAUNCHCTL_DIR: join(home, 'fake') };
  const result = await run(['setup', 'uninstall'], env);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('지울 데몬 흔적이 없습니다');
  expect(await readdir(home)).toEqual(process.platform === 'darwin' ? ['fake'] : []);
});
