import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';
import { assertKoreanLines } from './language.js';
import { tempHomes } from './temp-home.js';

const temporary = tempHomes();
afterEach(() => temporary.cleanup());
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const installer = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../packages/claude-code/test/fixtures/two-turns.jsonl', import.meta.url));
function run(args: string[], env: NodeJS.ProcessEnv, script = bin): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function environment() {
  const home = await temporary.create('brain-status-');
  const configDir = await temporary.create('brain-status-harness-');
  const env: NodeJS.ProcessEnv = { ...withoutHarnessFolders(process.env), [HOME_ENV]: home, CLAUDE_CONFIG_DIR: configDir };
  delete env['SECOND_BRAIN_DATABASE_URL'];
  delete env['BRAIN_TEST_DATABASE_URL'];
  return { home, configDir, env };
}
function sessions(home: string): number {
  const db = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
  try { return (db.prepare('select count(*) as n from sessions').get() as { n: number }).n; }
  finally { db.close(); }
}

describe('daemon status and command drain fallback', () => {
  it.each([[89_000, true, null], [91_000, false, 'stale-heartbeat'], [null, false, 'no-heartbeat']] as const)('agrees across surfaces for heartbeat age %s', async (age, alive, reason) => {
    const { home, configDir, env } = await environment();
    const install = await run(['--yes'], env, installer);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const project = join(configDir, 'projects', '-tmp-status');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, '4f1e7a90-1c2b-4d3e-8f55-000000000000.jsonl'), await readFile(fixture));
    await mkdir(join(home, 'run'), { recursive: true });
    const now = Date.now();
    await writeFile(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid: process.pid, boot_at: new Date(now - uptime() * 1000).toISOString(), started_at: new Date(now).toISOString() }) + '\n');
    const heartbeat = join(home, 'run', 'heartbeat');
    const recordedHeartbeatTimes = new Set<number>();
    async function recordHeartbeat(at: Date): Promise<void> {
      await utimes(heartbeat, at, at);
      recordedHeartbeatTimes.add(Math.floor((await stat(heartbeat)).mtimeMs));
    }
    if (age !== null) {
      await writeFile(heartbeat, 'heartbeat');
      await recordHeartbeat(new Date(now - age));
    }
    let refreshing = Promise.resolve();
    // Keep every alive surface near the 89-second boundary, even during slow probes.
    const refreshTimer = alive ? setInterval(() => {
      refreshing = refreshing.then(() => recordHeartbeat(new Date(Date.now() - 89_000)));
      // Surface filesystem failures below while avoiding an unhandled timer rejection.
      void refreshing.catch(() => undefined);
    }, 50) : undefined;
    try {
      const listed = await run(['failures', 'list', '--json'], env);
      expect(listed.code, listed.stderr).toBe(0);
      expect(listed.stderr).toBe('');
      expect(sessions(home)).toBe(alive ? 0 : 1);
      const doctor = await run(['doctor', 'run', '--json'], env);
      expect(doctor.code, doctor.stderr).toBe(0);
      const check = JSON.parse(doctor.stdout).data.checks.find((entry: { id: string }) => entry.id === 'daemon');
      expect(check.status).toBe(alive ? 'ok' : 'warn');
      expect(check.code).toBeUndefined();
      const status = await run(['daemon', 'status', '--json'], env);
      expect(status.code).toBe(0);
      expect(status.stderr).toBe('');
      const data = JSON.parse(status.stdout).data;
      expect(data).toMatchObject({ alive, pid: process.pid, reason });
      expect(data.heartbeat_at).toEqual(age === null ? null : expect.stringMatching(/^\d{4}-.+[+-]\d{2}:\d{2}$/));
      await refreshing;
      if (age !== null) expect(recordedHeartbeatTimes.has(new Date(data.heartbeat_at).getTime())).toBe(true);
      const text = await run(['daemon', 'status'], env);
      expect(text.code).toBe(0);
      expect(text.stdout.trim().split('\n')).toHaveLength(1);
      assertKoreanLines(text.stdout);
      if (alive) {
        // Explicit drain remains available even while the daemon is alive.
        expect((await run(['queue', 'drain', '--json'], env)).code).toBe(0);
        expect(sessions(home)).toBe(1);
      }
    } finally {
      clearInterval(refreshTimer);
      await refreshing;
    }
  });
  it('answers without configuration or database', async () => {
    const { env } = await environment();
    const status = await run(['daemon', 'status', '--json'], env);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, data: { alive: false, pid: null, heartbeat_at: null, reason: 'no-lock' } });
  });
});
