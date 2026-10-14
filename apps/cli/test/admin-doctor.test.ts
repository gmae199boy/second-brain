import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SQLITE_SCHEMA_VERSION, runSqliteMigrations } from 'second_brain';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV, configFilePath } from '../src/config/paths.js';
import { runtimeChecks } from '../src/doctor/checks.js';
import { shimPath, writeShim } from '../src/install/shim.js';

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

/**
 * Every check doctor reports, in order: the store's own first, then the machine
 * ones the runtime registers (story 8). A check added to `doctor/checks.ts`
 * belongs on this list, and nowhere else in this file.
 */
const CHECKS = [
  'db',
  'writable',
  'wal',
  'fts5-trigram',
  'foreign-keys',
  'schema-version',
  'config',
  'shim',
  'node-path',
  'node-version',
];

/** The machine checks alone: what is still reported when there is no database. */
const MACHINE_CHECKS = ['config', 'shim', 'node-path', 'node-version'];

const homes: string[] = [];

/** A folder with no configuration at all. */
async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-doctor-'));
  homes.push(home);
  return home;
}

/**
 * A configuration folder for one run, with a database beside it at the version
 * this build ships and the shim a finished install leaves. The command reads it
 * through `SECOND_BRAIN_HOME`, so no test touches the real `~/.second_brain`
 * (AD-18).
 */
async function configuredHome(): Promise<string> {
  const home = await emptyHome();
  const migrated = await runSqliteMigrations({ path: join(home, 'brain.db') });
  expect(migrated.ok).toBe(true);
  await writeConfig(home, {});
  // The built entry point, because these tests import `src/`, where
  // `cliEntryPath()` would name a file that is not there.
  await writeShim(home, { bin: binPath });
  return home;
}

/** The checks of one envelope, by id, so a row names what it cares about. */
function byId(envelope: Envelope): Map<string, { status: string; detail?: string; code?: string }> {
  return new Map((envelope.data?.checks ?? []).map((check) => [check.id, check]));
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
    const failed = checks.filter((check) => check.status !== 'ok');
    expect(failed, JSON.stringify(failed)).toEqual([]);
    // The SQLite version, then what each probe and each machine check found.
    expect(checks[0]?.detail).toMatch(/^\d+\./);
    const found = byId(envelope);
    expect(found.get('wal')?.detail).toBe('wal');
    expect(found.get('schema-version')?.detail).toBe(String(SQLITE_SCHEMA_VERSION));
    expect(found.get('config')?.detail).toBe(configFilePath(home));
    expect(found.get('shim')?.detail).toBe(shimPath(home));
    expect(found.get('node-version')?.detail).toContain(process.versions.node);
    // The machine half comes from the registry rather than from a second list
    // written out here: a check added to `doctor/checks.ts` turns up in this
    // report, and in the installer's, with nothing else touched (story 8).
    const registered = runtimeChecks({ home }).map((source) => source.id);
    expect(checks.slice(-registered.length).map((check) => check.id)).toEqual(registered);
    expect(registered).toEqual(MACHINE_CHECKS);
  });

  it('prints one line per check in text mode, with the same exit code', async () => {
    const home = await configuredHome();
    const run = await runBrain(['admin', 'doctor'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(CHECKS.length);
    for (const [index, id] of CHECKS.entries()) {
      expect(lines[index]).toMatch(new RegExp(`^${id}: ok`));
    }
  });

  it('reports the same checks through the shim of that install, as a hook would', async () => {
    const home = await configuredHome();

    // `env -u SECOND_BRAIN_HOME`: the shim carries the folder it belongs to,
    // which is the whole reason a hook can call it (AD-19).
    const run = await new Promise<Run>((resolve, reject) => {
      const child = spawn(shimPath(home), ['admin', 'doctor', '--json'], {
        env: (() => {
          const childEnv = { ...process.env };
          delete childEnv[HOME_ENV];
          return childEnv;
        })(),
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
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect((envelope.data?.checks ?? []).map((check) => check.id)).toEqual(CHECKS);
    expect((envelope.data?.checks ?? []).every((check) => check.status === 'ok')).toBe(true);
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

    const found = byId(envelope);
    expect(found.get('db')).toMatchObject({ status: 'ok' });
    expect(found.get('wal')).toMatchObject({ status: 'fail' });
    expect(found.get('wal')?.code).toBeUndefined();
    expect(found.get('wal')?.detail).toContain('not wal');
    // One failing probe is not a failing report: everything else still ran.
    expect(found.get('writable')).toMatchObject({ status: 'ok' });
    expect(found.get('node-version')).toMatchObject({ status: 'ok' });
  });

  it('fails the writable check alone, and exits 1, for a database nobody may write', async () => {
    const home = await configuredHome();
    const database = join(home, 'brain.db');
    await chmod(database, 0o444);

    try {
      const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(1);
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(true);

      const found = byId(envelope);
      expect(found.get('writable')).toMatchObject({ status: 'fail' });
      expect(found.get('writable')?.detail).toBeTruthy();
      // Reading still works, so nothing else may be dragged down with it.
      expect(found.get('db')).toMatchObject({ status: 'ok' });
      expect(found.get('wal')).toMatchObject({ status: 'ok' });
      expect(found.get('schema-version')).toMatchObject({ status: 'ok' });
    } finally {
      // Before the folder is removed: a 0444 database and its sidecars are
      // what `rm -r` cannot always take away.
      for (const suffix of ['', '-wal', '-shm']) {
        await chmod(`${database}${suffix}`, 0o600).catch(() => {});
      }
    }
  });

  it('fails schema-version with SCHEMA_MISMATCH, and warns, when the stored version differs', async () => {
    const home = await configuredHome();
    const database = new DatabaseSync(join(home, 'brain.db'));
    database.exec('update schema_version set version = 1');
    database.close();

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    // A shared code, so the degraded result travels in `warnings[]` too.
    expect(envelope.warnings).toEqual(['SCHEMA_MISMATCH']);

    const found = byId(envelope);
    expect(found.get('schema-version')).toMatchObject({
      status: 'fail',
      code: 'SCHEMA_MISMATCH',
    });
    expect(found.get('schema-version')?.detail).toContain('setup upgrade');
  });

  it('reports DB_UNAVAILABLE as a warning, and makes no file, when there is none', async () => {
    const home = await emptyHome();
    await writeConfig(home, {});
    await writeShim(home, { bin: binPath });

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
    // Nothing was probed and no version is known, so the store's half of the
    // report is `db` alone — and the machine checks still ran, which is most of
    // what a person needs when the database is the thing that is missing.
    expect(checks.map((check) => check.id)).toEqual(['db', ...MACHINE_CHECKS]);
    expect(checks.filter((check) => check.status === 'fail')).toHaveLength(1);
    // And nothing was created: a doctor that made the database it was looking
    // for would report a brain nobody installed (AD-20).
    expect((await readdir(home)).some((entry) => entry.startsWith('brain.db'))).toBe(false);
  });

  it('fails the shim check, and skips node-path, when the shim was removed', async () => {
    const home = await configuredHome();
    await rm(shimPath(home));

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const found = byId(JSON.parse(run.stdout) as Envelope);
    expect(found.get('shim')).toMatchObject({ status: 'fail' });
    expect(found.get('node-path')).toMatchObject({ status: 'skip' });
    // The store knew nothing about any of this and said so anyway.
    expect(found.get('db')).toMatchObject({ status: 'ok' });
  });

  it('fails node-path when the shim names a node that is not there', async () => {
    const home = await configuredHome();
    await writeShim(home, { bin: binPath, node: join(home, 'nonexistent', 'node') });

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const found = byId(JSON.parse(run.stdout) as Envelope);
    expect(found.get('shim')).toMatchObject({ status: 'ok' });
    expect(found.get('node-path')).toMatchObject({ status: 'fail' });
    expect(found.get('node-path')?.detail).toContain('nonexistent');
    expect(found.get('node-version')).toMatchObject({ status: 'ok' });
  });
});

/**
 * Doctor is the command a person runs when the install is already broken, so it
 * is the one command that runs without a configuration: `config` fails, `db`
 * fails because nothing says where the database is, and the machine checks
 * answer as usual (Decision 2026-10-14).
 */
describe('brain admin doctor without a configuration it can read', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('exits 1, not 2, and reports config and db as failures when there is no file', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    // A result, not an error: the command ran and the result is a bad one.
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();

    const found = byId(envelope);
    expect(found.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_MISSING' });
    expect(found.get('db')).toMatchObject({ status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(found.get('db')?.detail).toContain('configuration');
    expect(found.get('shim')).toMatchObject({ status: 'ok' });
    expect(found.get('node-path')).toMatchObject({ status: 'ok' });
    expect(found.get('node-version')).toMatchObject({ status: 'ok' });
    // No store means no probes and no schema version to report on.
    expect([...found.keys()]).toEqual(['db', ...MACHINE_CHECKS]);
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
  });

  it('reports CONFIG_INVALID the same way for a file it cannot understand', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    // A relative path, which `readConfig` refuses: it would mean a different
    // database for every working directory a command is started from.
    await writeFile(
      configFilePath(home),
      'schema_version = 1\n[store]\npath = "relative/brain.db"\n',
      'utf8',
    );

    const run = await runBrain(['admin', 'doctor', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const found = byId(JSON.parse(run.stdout) as Envelope);
    expect(found.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_INVALID' });
    expect(found.get('db')).toMatchObject({ status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(found.get('shim')).toMatchObject({ status: 'ok' });
  });

  it('prints the failing checks, and no error line, in text mode', async () => {
    const home = await emptyHome();

    const run = await runBrain(['admin', 'doctor'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('config: fail [CONFIG_MISSING]');
    expect(run.stdout).toContain('db: fail [DB_UNAVAILABLE]');
    expect(run.stdout).toContain('shim: fail');
    expect(run.stdout).toContain('node-path: skip');
    // Not an error envelope, so nothing goes to stderr but the warning line.
    expect(run.stderr).not.toContain('CONFIG_MISSING');
  });

});
