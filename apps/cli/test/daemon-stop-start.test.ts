import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { DAEMON_LABEL, daemonPlistPath } from '../src/daemon/launchd.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';
const temporary = tempHomes();
let daemon: ChildProcess | undefined;
afterEach(async () => {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'close'); }
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
it('stops the resident owner, falls back to command drain, and starts the installed Label once', async () => {
  const home = await temporary.create('brain-stop-start-');
  const config = join(home, 'claude');
  const fake = join(home, 'launchctl');
  const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home,
    CLAUDE_CONFIG_DIR: config, SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'), FAKE_LAUNCHCTL_DIR: fake };
  expect((await run(['--yes'], env, installer)).code).toBe(0);
  daemon = spawn(process.execPath, [bin, 'daemon', 'run'], { env, stdio: 'ignore' });
  const closed = once(daemon, 'close');
  const deadline = Date.now() + 10_000;
  let status;
  do {
    status = JSON.parse((await run(['daemon', 'status', '--json'], env)).stdout).data;
    if (status.alive) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  expect(status.alive).toBe(true);
  expect(status.commit).toBe(JSON.parse(await readFile(new URL('../dist/build.json', import.meta.url), 'utf8')).commit);
  await mkdir(join(fake, 'loaded'), { recursive: true });
  await writeFile(join(fake, 'loaded', DAEMON_LABEL), '');
  const stopped = await run(['daemon', 'stop', '--json'], env);
  expect(stopped.code, stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout).data).toEqual({ unloaded: process.platform === 'darwin', signalled_pid: daemon.pid, alive: false });
  await closed;
  expect(existsSync(join(home, 'run', 'daemon.pid'))).toBe(false);
  expect(JSON.parse((await run(['daemon', 'status', '--json'], env)).stdout).data.alive).toBe(false);
  const doctor = await run(['doctor', 'run', '--json'], env);
  expect(doctor.code).toBe(0);
  expect(JSON.parse(doctor.stdout).data.checks.find((c: { id: string }) => c.id === 'daemon').status).toBe('warn');
  const project = join(config, 'projects', '-demo');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, '4f1e7a90-1c2b-4d3e-8f55-000000000000.jsonl'), await readFile(new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url)));
  expect((await run(['failures', 'list', '--json'], env)).code).toBe(0);
  const db = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
  try { expect((db.prepare('select count(*) as n from sessions').get() as { n: number }).n).toBe(1); } finally { db.close(); }
  if (process.platform === 'darwin') {
    const callsBefore = (await readFile(join(fake, 'calls'), 'utf8')).split('\n').filter((line) => line.startsWith('bootstrap'));
    expect(JSON.parse((await run(['daemon', 'start', '--json'], env)).stdout).data.status).toBe('started');
    expect(JSON.parse((await run(['daemon', 'start', '--json'], env)).stdout).data.status).toBe('already-loaded');
    const calls = await readFile(join(fake, 'calls'), 'utf8');
    expect(calls).toContain(`bootout gui/${String(process.getuid?.())}/${DAEMON_LABEL}`);
    expect(calls.split('\n').filter((line) => line.startsWith('bootstrap'))).toHaveLength(callsBefore.length + 1);
    expect(calls).toContain(`bootstrap gui/${String(process.getuid?.())} ${daemonPlistPath(env)}`);
    const missing = await run(['daemon', 'start', '--json'], { ...env, SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'missing') });
    expect(missing.code).toBe(2); expect(JSON.parse(missing.stdout).error.code).toBe('DAEMON_NOT_INSTALLED');
  }
}, 30_000);
