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
import { assertKoreanLine, assertKoreanLines } from './language.js';
import { withoutHarnessFolders } from './environment.js';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Summary {
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

interface Envelope {
  ok: boolean;
  now: string;
  data?: {
    checks: { id: string; status: string; detail?: string; code?: string }[];
    summary: Summary;
  };
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
  'failures',
  'transcripts',
  'config',
  'shim',
  'node-path',
  'node-version',
  'plugin',
  'spool',
];

/** The machine checks alone: what is still reported when there is no database. */
const MACHINE_CHECKS = ['config', 'shim', 'node-path', 'node-version', 'plugin', 'spool'];

/**
 * What a report says about a database nobody can reach: `db` and the schema
 * version it could not ask for, then the machine half (story 2.1).
 */
const NO_DATABASE_CHECKS = [
  'db',
  'schema-version',
  'failures',
  'transcripts',
  ...MACHINE_CHECKS,
];

/**
 * The one check that is not `ok` on a finished install: no test here sets
 * `SECOND_BRAIN_CAPTURE`, so this build looks in no transcript folder and
 * `transcripts` is a `skip` saying so (Boundaries, Decision 1 2026-10-19).
 * Story 2.14 turns the folders on by default and this becomes `ok`.
 */
const SKIPPED_WITHOUT_CAPTURE = 'transcripts';

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
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders(process.env);
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

  const finished = new Promise<Run>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });

  // Every branch of the report goes through here, so the output-language rule
  // is checked on all of them at once rather than once per `it` (Conventions,
  // output language 2026-10-16). A branch added below is covered the moment it
  // runs. After the promise, not inside the `close` handler: a failure there
  // would be an uncaught exception rather than a failing test.
  return finished.then((run) => {
    assertKoreanDoctorOutput(run);
    return run;
  });
}

/**
 * The report, in Korean. Under `--json` the sentences are the checks' details
 * and the envelope's own `message` and `hint`; in text mode they are the lines.
 * The check ids and the status words stay English (Boundaries), which the
 * checker knows about.
 */
function assertKoreanDoctorOutput(run: Run): void {
  if (run.stdout.startsWith('{')) {
    const envelope = JSON.parse(run.stdout) as Envelope;
    for (const check of envelope.data?.checks ?? []) {
      assertKoreanLine(check.detail ?? '', { label: `${check.id} detail` });
    }
    if (envelope.error !== undefined) {
      assertKoreanLine(envelope.error.message, { label: `${envelope.error.code} message` });
    }
  } else {
    assertKoreanLines(run.stdout, { label: 'doctor stdout' });
  }
  assertKoreanLines(run.stderr, { label: 'doctor stderr' });
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('brain doctor run', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('reports every check as ok against the local database', async () => {
    const home = await configuredHome();
    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);

    const checks = envelope.data?.checks ?? [];
    expect(checks.map((check) => check.id)).toEqual(CHECKS);
    const failed = checks.filter(
      (check) => check.status !== 'ok' && check.id !== SKIPPED_WITHOUT_CAPTURE,
    );
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(byId(envelope).get(SKIPPED_WITHOUT_CAPTURE)?.status).toBe('skip');
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
    // Everything passed but the folders nobody asked for, and the counts add
    // up to the whole report.
    expect(envelope.data?.summary).toEqual({
      passed: CHECKS.length - 1,
      warned: 0,
      failed: 0,
      skipped: 1,
    });
  });

  it('prints one line per check in text mode, then the summary', async () => {
    const home = await configuredHome();
    const run = await runBrain(['doctor', 'run'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    const lines = run.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(CHECKS.length + 1);
    for (const [index, id] of CHECKS.entries()) {
      const status = id === SKIPPED_WITHOUT_CAPTURE ? 'skip' : 'ok';
      expect(lines[index]).toMatch(new RegExp(`^${id}: ${status}`));
    }
    // Last, so the line that says whether to read the rest is the one left on
    // screen (Conventions: passed, warned, failed, skipped).
    expect(lines.at(-1)).toBe(
      `요약: 통과 ${String(CHECKS.length - 1)}, 경고 0, 실패 0, 건너뜀 1`,
    );
  });

  it('reports the same checks through the shim of that install, as a hook would', async () => {
    const home = await configuredHome();

    // `env -u SECOND_BRAIN_HOME`: the shim carries the folder it belongs to,
    // which is the whole reason a hook can call it (AD-19).
    const run = await new Promise<Run>((resolve, reject) => {
      const child = spawn(shimPath(home), ['doctor', 'run', '--json'], {
        env: (() => {
          const childEnv = withoutHarnessFolders(process.env);
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
    expect(
      (envelope.data?.checks ?? []).every(
        (check) => check.status === 'ok' || check.id === SKIPPED_WITHOUT_CAPTURE,
      ),
    ).toBe(true);
  });

  it('runs anyway and warns when the configuration holds a key it does not know', async () => {
    const home = await configuredHome();
    await appendFile(configFilePath(home), 'colour = "x"\n', 'utf8');

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['CONFIG_UNKNOWN_KEY']);
    expect(envelope.data?.checks).toHaveLength(CHECKS.length);
  });

  it('names the unknown key on stderr in text mode', async () => {
    const home = await configuredHome();
    await appendFile(configFilePath(home), 'colour = "x"\n', 'utf8');

    const run = await runBrain(['doctor', 'run'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('colour');
    expect(run.stdout.trimEnd().split('\n')).toHaveLength(CHECKS.length + 1);
  });

  it('fails the wal check and exits 1 when the file is not in write-ahead mode', async () => {
    const home = await configuredHome();
    const database = new DatabaseSync(join(home, 'brain.db'));
    database.exec('pragma journal_mode = DELETE');
    database.close();

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);

    const found = byId(envelope);
    expect(found.get('db')).toMatchObject({ status: 'ok' });
    expect(found.get('wal')).toMatchObject({ status: 'fail' });
    expect(found.get('wal')?.code).toBeUndefined();
    expect(found.get('wal')?.detail).toContain('wal이 아니라');
    // One failing probe is not a failing report: everything else still ran.
    expect(found.get('writable')).toMatchObject({ status: 'ok' });
    expect(found.get('node-version')).toMatchObject({ status: 'ok' });
  });

  it('fails the writable check alone, and exits 1, for a database nobody may write', async () => {
    const home = await configuredHome();
    const database = join(home, 'brain.db');
    await chmod(database, 0o444);

    try {
      const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

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

  it('warns on writable, and still exits 0, while another connection holds the lock', async () => {
    const home = await configuredHome();
    const holder = new DatabaseSync(join(home, 'brain.db'));
    holder.exec('pragma busy_timeout = 0');
    holder.exec('begin immediate');
    holder.exec('create table brain_lock_holder(x)');

    try {
      const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

      // A brain in use is not a brain that cannot be written to, and it is not
      // one that proved it can be either: `warn` is the only honest answer,
      // and only `fail` makes the command exit 1 (Conventions).
      expect(run.code).toBe(0);
      const envelope = JSON.parse(run.stdout) as Envelope;
      const found = byId(envelope);
      expect(found.get('writable')).toMatchObject({ status: 'warn' });
      expect(found.get('writable')?.detail).toContain('쓰기 잠금');
      expect(found.get('db')).toMatchObject({ status: 'ok' });

      const summary = envelope.data?.summary;
      expect(summary).toEqual({ passed: CHECKS.length - 2, warned: 1, failed: 0, skipped: 1 });
      // The counts and the lines cannot disagree about one report.
      expect(
        (summary?.passed ?? 0) + (summary?.warned ?? 0) + (summary?.skipped ?? 0),
      ).toBe(envelope.data?.checks.length);
    } finally {
      holder.exec('rollback');
      holder.close();
    }
  });

  it('prints a warned check and the summary that counts it in text mode', async () => {
    const home = await configuredHome();
    const holder = new DatabaseSync(join(home, 'brain.db'));
    holder.exec('pragma busy_timeout = 0');
    holder.exec('begin immediate');
    holder.exec('create table brain_lock_holder(x)');

    try {
      const run = await runBrain(['doctor', 'run'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stdout).toContain('writable: warn');
      expect(run.stdout.trimEnd().split('\n').at(-1)).toBe(
        `요약: 통과 ${String(CHECKS.length - 2)}, 경고 1, 실패 0, 건너뜀 1`,
      );
    } finally {
      holder.exec('rollback');
      holder.close();
    }
  });

  it('fails schema-version with SCHEMA_MISMATCH, and warns, when the stored version differs', async () => {
    const home = await configuredHome();
    const database = new DatabaseSync(join(home, 'brain.db'));
    database.exec('update schema_version set version = 1');
    database.close();

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

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
    // What the report tells the person to run has to be a command they have:
    // `setup upgrade` is an epic 5 plan and does not exist yet.
    expect(found.get('schema-version')?.detail).toContain('setup run');
    expect(found.get('schema-version')?.detail).not.toContain('setup upgrade');
  });

  it('reports DB_UNAVAILABLE as a warning, and makes no file, when there is none', async () => {
    const home = await emptyHome();
    await writeConfig(home, {});
    await writeShim(home, { bin: binPath });

    const startedAt = Date.now();
    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });
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
    // Nothing was probed, so no probe is reported. The schema version says it
    // was skipped and which check made it pointless, and the machine checks
    // still ran — most of what a person needs when the database is the thing
    // that is missing.
    expect(checks.map((check) => check.id)).toEqual(NO_DATABASE_CHECKS);
    expect(checks[1]).toEqual({
      id: 'schema-version',
      status: 'skip',
      detail: '앞선 점검 실패: db',
    });
    expect(checks.filter((check) => check.status === 'fail')).toHaveLength(1);
    // A skip is not a pass: the summary counts it as its own thing. Three of
    // them here — the schema version and the two capture checks, all of which
    // a store would have answered (`runDoctor`).
    expect(envelope.data?.summary).toEqual({
      passed: MACHINE_CHECKS.length,
      warned: 0,
      failed: 1,
      skipped: 3,
    });
    // And nothing was created: a doctor that made the database it was looking
    // for would report a brain nobody installed (AD-20).
    expect((await readdir(home)).some((entry) => entry.startsWith('brain.db'))).toBe(false);
  });

  it('fails the shim check, and skips node-path, when the shim was removed', async () => {
    const home = await configuredHome();
    await rm(shimPath(home));

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    const found = byId(envelope);
    expect(found.get('shim')).toMatchObject({ status: 'fail' });
    // The skip names the check that caused it, in the one phrase every skipped
    // prerequisite uses, so nobody has to guess which line above is the cause.
    expect(found.get('node-path')).toMatchObject({
      status: 'skip',
      detail: '앞선 점검 실패: shim',
    });
    // The store knew nothing about any of this and said so anyway.
    expect(found.get('db')).toMatchObject({ status: 'ok' });
    expect(envelope.data?.summary).toEqual({
      passed: CHECKS.length - 3,
      warned: 0,
      failed: 1,
      // `node-path` and, with no capture switch, `transcripts`.
      skipped: 2,
    });
  });

  it('fails node-path when the shim names a node that is not there', async () => {
    const home = await configuredHome();
    await writeShim(home, { bin: binPath, node: join(home, 'nonexistent', 'node') });

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

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
describe('brain doctor run without a configuration it can read', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('exits 1, not 2, and reports config and db as failures when there is no file', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    // A result, not an error: the command ran and the result is a bad one.
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();

    const found = byId(envelope);
    expect(found.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_MISSING' });
    expect(found.get('db')).toMatchObject({ status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(found.get('db')?.detail).toContain('설정을 읽을 수 없어서');
    expect(found.get('shim')).toMatchObject({ status: 'ok' });
    expect(found.get('node-path')).toMatchObject({ status: 'ok' });
    expect(found.get('node-version')).toMatchObject({ status: 'ok' });
    // No store means no probes, and a schema version nobody could ask for.
    expect([...found.keys()]).toEqual(NO_DATABASE_CHECKS);
    expect(found.get('schema-version')).toMatchObject({
      status: 'skip',
      detail: '앞선 점검 실패: db',
    });
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

    const run = await runBrain(['doctor', 'run', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    const found = byId(JSON.parse(run.stdout) as Envelope);
    expect(found.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_INVALID' });
    expect(found.get('db')).toMatchObject({ status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(found.get('shim')).toMatchObject({ status: 'ok' });
  });

  it('prints the failing checks, and no error line, in text mode', async () => {
    const home = await emptyHome();

    const run = await runBrain(['doctor', 'run'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('config: fail [CONFIG_MISSING]');
    expect(run.stdout).toContain('db: fail [DB_UNAVAILABLE]');
    expect(run.stdout).toContain('shim: fail');
    expect(run.stdout).toContain('schema-version: skip 앞선 점검 실패: db');
    expect(run.stdout).toContain('node-path: skip 앞선 점검 실패: shim');
    // Three failures, two skips, three passes — `node-version`, `plugin`,
    // which has nothing to report about a folder nothing installed into, and
    // `spool`, which has nothing waiting because nothing was ever written:
    // the summary is the last line.
    expect(run.stdout).toContain('spool: ok 0건');
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe(
      '요약: 통과 3, 경고 0, 실패 3, 건너뜀 4',
    );
    // Not an error envelope, so nothing goes to stderr but the warning line.
    expect(run.stderr).not.toContain('CONFIG_MISSING');
  });

});
