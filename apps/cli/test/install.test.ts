import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SQLITE_SCHEMA_VERSION } from 'second_brain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { configFilePath, envFilePath, HOME_ENV } from '../src/config/paths.js';
import { shimPath } from '../src/install/shim.js';

/**
 * The installer end to end, against a real SQLite file, through the built entry
 * point — the same file `tooling/bootstrap` starts. Piped stdio makes the child
 * non-interactive, which is why it runs on flags and never asks anything.
 *
 * The child's `PATH` is narrowed to the node folder plus `/usr/bin:/bin`, and
 * every database variable is stripped from its environment: the point of this
 * story is that an install needs no Docker and no Postgres, and a machine that
 * happens to have either must not be what makes these pass.
 */

const installerPath = fileURLToPath(new URL('../dist/install.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];

async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-install-'));
  homes.push(home);
  return home;
}

function runInstaller(args: readonly string[], home: string): Promise<Run> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [HOME_ENV]: home,
    // No Docker on the way, and nothing that could stand in for a Postgres.
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];

  const child = spawn(process.execPath, [installerPath, ...args], {
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

/** The permission bits of one path, as the three octal digits people read. */
async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

/** Every user table and how many rows it holds, read without writing. */
function rowCounts(path: string): Record<string, number> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database
      .prepare(
        `select name from sqlite_master
          where type = 'table' and name not like 'sqlite_%'
          order by name`,
      )
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = database.prepare(`select count(*) as rows from "${name}"`).get() as {
        rows: number;
      };
      counts[name] = row.rows;
    }
    return counts;
  } finally {
    database.close();
  }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('the installer with no Docker and no Postgres', () => {
  beforeAll(() => {
    if (!existsSync(installerPath)) {
      throw new Error(`${installerPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('writes the configuration, makes the database at 0600 and the files root at 0700', async () => {
    const home = await emptyHome();

    const run = await runInstaller(['--yes'], home);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('db: ok');
    expect(run.stdout).toContain('wal: ok');
    expect(run.stdout).toContain('fts5-trigram: ok');
    expect(run.stdout).toContain('foreign-keys: ok');

    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain('schema_version = 1');
    expect(config).toContain(`path = "${join(home, 'brain.db')}"`);
    expect(config).toContain(`path = "${join(home, 'files')}"`);
    expect(config).toContain(`path = "${join(home, 'mirror')}"`);
    // No Postgres key anywhere: the source is a file this folder names.
    expect(config).not.toContain('url_env');

    expect(await mode(join(home, 'brain.db'))).toBe('600');
    expect(await mode(join(home, 'files'))).toBe('700');
    expect(await mode(envFilePath(home))).toBe('600');
    expect(await mode(shimPath(home))).toBe('755');
    // The mirror folder itself is epic 4's to create.
    expect(existsSync(join(home, 'mirror'))).toBe(false);

    const counts = rowCounts(join(home, 'brain.db'));
    expect(counts['schema_version']).toBe(1);
    // Both default index configs come from the migrations, not an install step.
    expect(counts['index_configs']).toBe(2);
    // The owner, which is the one row an install step writes: SQL can read no
    // account name and mint no UUIDv7 (AD-12).
    expect(counts['users']).toBe(1);
    expect(run.stdout).toContain('의 것입니다');
  });

  it('records the schema version this build ships', async () => {
    const home = await emptyHome();

    const run = await runInstaller(['--yes'], home);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`스키마 버전은 ${String(SQLITE_SCHEMA_VERSION)}입니다`);
    const database = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
    try {
      expect(database.prepare('select version from schema_version').get()).toEqual({
        version: SQLITE_SCHEMA_VERSION,
      });
    } finally {
      database.close();
    }
  });

  it('is idempotent: a second run changes nothing and still exits 0', async () => {
    const home = await emptyHome();
    const first = await runInstaller(['--yes'], home);
    expect(first.code).toBe(0);
    const configBefore = await readFile(configFilePath(home), 'utf8');
    const shimBefore = await readFile(shimPath(home), 'utf8');
    const countsBefore = rowCounts(join(home, 'brain.db'));

    const again = await runInstaller(['--yes'], home);

    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(
      `스키마는 이미 버전 ${String(SQLITE_SCHEMA_VERSION)}입니다`,
    );
    expect(again.stdout).toContain('이미 있습니다');
    // Same owner, named rather than replaced.
    expect(again.stdout).toMatch(/이미 \S+의 것입니다/);
    expect(await readFile(configFilePath(home), 'utf8')).toBe(configBefore);
    expect(await readFile(shimPath(home), 'utf8')).toBe(shimBefore);
    expect(rowCounts(join(home, 'brain.db'))).toEqual(countsBefore);
    expect(await mode(join(home, 'brain.db'))).toBe('600');
    expect(await mode(join(home, 'files'))).toBe('700');
  });

  it('puts the database where --store-path says, creating its parent at 0700', async () => {
    const home = await emptyHome();
    const path = join(home, 'elsewhere', 'deeper', 'brain.db');

    const run = await runInstaller(['--store-path', path, '--yes'], home);

    expect(run.code).toBe(0);
    expect(await readFile(configFilePath(home), 'utf8')).toContain(`path = "${path}"`);
    expect(await mode(dirname(path))).toBe('700');
    expect(await mode(path)).toBe('600');
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });

  it('keeps the recorded path on a re-run, and leaves the old file alone when it changes', async () => {
    const home = await emptyHome();
    const first = join(home, 'one', 'brain.db');
    expect((await runInstaller(['--store-path', first, '--yes'], home)).code).toBe(0);

    // A re-run that says nothing about it: the recorded path has to survive.
    const kept = await runInstaller(['--yes'], home);
    expect(kept.code).toBe(0);
    expect(await readFile(configFilePath(home), 'utf8')).toContain(`path = "${first}"`);

    const second = join(home, 'two', 'brain.db');
    const moved = await runInstaller(['--store-path', second, '--yes'], home);

    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain(`${first}는 있던 자리에 그대로 둡니다`);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('names the consent it needs and exits 3 with no terminal and no --yes', async () => {
    const home = await emptyHome();

    const run = await runInstaller([], home);

    // The npx door and `brain setup run` share this branch, so both answer 3:
    // the consent is a question for the person, not a mistake of the caller's.
    expect(run.code).toBe(3);
    expect(run.stdout).toContain('--yes');
    expect(existsSync(configFilePath(home))).toBe(false);
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
    expect(existsSync(join(home, 'files'))).toBe(false);
  });

  it('exits 2 for a relative --store-path, writing nothing', async () => {
    const home = await emptyHome();

    const run = await runInstaller(['--store-path', 'brain.db', '--yes'], home);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('CONFIG_INVALID: --store-path brain.db');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it.each(['--database-url', '--docker'])('refuses the old flag %s', async (flag) => {
    const home = await emptyHome();

    const run = await runInstaller([flag, 'postgres://x/y', '--yes'], home);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain(`모르는 인자입니다: ${flag}`);
    expect(run.stdout).toContain('사용법: second-brain');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('reports one coded line and skips the shim when the path cannot hold a database', async () => {
    const home = await emptyHome();
    const path = join(home, 'brain.db');
    await mkdir(path);

    const run = await runInstaller(['--yes'], home);

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/\n(DB_UNAVAILABLE|MIGRATION_FAILED): .+\n/);
    expect(existsSync(shimPath(home))).toBe(false);
  });

  it('says where it will write, before it writes anything', async () => {
    const home = await emptyHome();

    const run = await runInstaller([], home);

    expect(run.stdout).toContain(`설정 폴더: ${home}`);
  });
});
