import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from 'second_brain';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV, configFilePath } from '../src/config/paths.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  now: string;
  data?: { checks: { id: string; status: string; detail?: string; code?: string }[] };
  warnings: string[];
  error?: { code: string; message: string };
}

/** The checks a SQLite source answers with, in the order doctor reports them. */
const CHECKS = ['db', 'wal', 'fts5-trigram', 'foreign-keys'];

const homes: string[] = [];

/** A folder with no configuration at all. */
async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-doctor-'));
  homes.push(home);
  return home;
}

/**
 * A configuration folder for one run, with a database beside it at the version
 * this build ships. The command reads it through `SECOND_BRAIN_HOME`, so no
 * test touches the real `~/.second_brain` (AD-18).
 */
async function configuredHome(): Promise<string> {
  const home = await emptyHome();
  const migrated = await runSqliteMigrations({ path: join(home, 'brain.db') });
  expect(migrated.ok).toBe(true);
  await writeConfig(home, {});
  return home;
}

function runBrain(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[HOME_ENV];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const child = spawn(process.execPath, [binPath, ...args], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('brain admin doctor', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('reports every check as ok against the local database', async () => {
    const home = await configuredHome();
    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    const checks = envelope.data?.checks ?? [];
    expect(checks.map((check) => check.id)).toEqual(CHECKS);
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    // The SQLite version, then what each probe found.
    expect(checks[0]?.detail).toMatch(/^\d+\./);
    expect(checks[1]?.detail).toBe('wal');
  });

  it('prints one line per check in text mode, with the same exit code', async () => {
    const home = await configuredHome();
    const run = await runBrain(['admin', 'doctor'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(CHECKS.length);
    expect(lines[0]).toMatch(/^db: ok /);
    expect(lines[1]).toMatch(/^wal: ok /);
    expect(lines[2]).toMatch(/^fts5-trigram: ok /);
    expect(lines[3]).toMatch(/^foreign-keys: ok /);
  });

  it('runs anyway and warns when the configuration holds a key it does not know', async () => {
    const home = await configuredHome();
    await appendFile(configFilePath(home), 'colour = "x"\n', 'utf8');

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['CONFIG_UNKNOWN_KEY']);
    expect(envelope.data?.checks).toHaveLength(CHECKS.length);
  });

  it('names the unknown key on stderr in text mode', async () => {
    const home = await configuredHome();
    await appendFile(configFilePath(home), 'colour = "x"\n', 'utf8');

    const run = await runBrain(['admin', 'doctor'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('colour');
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(CHECKS.length);
  });

  it('fails the wal check and exits 1 when the file is not in write-ahead mode', async () => {
    const home = await configuredHome();
    const database = new DatabaseSync(join(home, 'brain.db'));
    database.exec('pragma journal_mode = DELETE');
    database.close();

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);

    const checks = envelope.data?.checks ?? [];
    expect(checks[0]).toMatchObject({ id: 'db', status: 'ok' });
    expect(checks[1]).toMatchObject({ id: 'wal', status: 'fail' });
    expect(checks[1]?.code).toBeUndefined();
    expect(checks[1]?.detail).toContain('not wal');
  });

  it('reports DB_UNAVAILABLE as a warning, and makes no file, when there is none', async () => {
    const home = await emptyHome();
    await writeConfig(home, {});

    const startedAt = Date.now();
    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });
    const elapsed = Date.now() - startedAt;

    expect(run.stderr).toBe('');
    expect(run.code).toBe(1);
    expect(elapsed).toBeLessThan(5000);

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);

    const checks = envelope.data?.checks ?? [];
    expect(checks[0]).toMatchObject({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(checks[0]?.detail).toBeTruthy();
    // Nothing was probed, so `db` is the whole report.
    expect(checks).toHaveLength(1);
    // And nothing was created: a doctor that made the database it was looking
    // for would report a brain nobody installed (AD-20).
    expect((await readdir(home)).some((entry) => entry.startsWith('brain.db'))).toBe(false);
  });

  it('exits 2 with CONFIG_MISSING when there is no configuration folder', async () => {
    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: await emptyHome() });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('CONFIG_MISSING');
    expect(envelope.data).toBeUndefined();
    expect(envelope.warnings).toEqual([]);
  });

  it('uses the same exit code in text mode when configuration is missing', async () => {
    const run = await runBrain(['admin', 'doctor'], { [HOME_ENV]: await emptyHome() });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('CONFIG_MISSING');
  });
});
