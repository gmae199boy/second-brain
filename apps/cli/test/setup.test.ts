import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BRAIN_MARKER } from 'second_brain';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
import { HOME_ENV, configFilePath } from '../src/config/paths.js';
import { setupConnectCommand } from '../src/commands/setup-connect.js';
import { dispatch } from '../src/dispatch.js';
import { shimPath, writeShim } from '../src/install/shim.js';
import { systemClock } from '../src/runtime/clock.js';

/**
 * `brain setup connect` against a fake harness, and `brain setup run` against a
 * real SQLite file through the built `brain`. The connector half runs in
 * process because the registry is what is being faked; the installer half runs
 * the built entry point, since the point of it is the artifacts on disk — the
 * configuration folder, the database, the files root and the shim — and that
 * they do not move on a re-run.
 */

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
  data?: { harness?: string; target?: string; changed?: boolean; lines?: string[] };
  warnings: string[];
  error?: { code: string; message: string };
}

const homes: string[] = [];

async function emptyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-setup-'));
  homes.push(home);
  return home;
}

/** One in-process invocation against a registry this test owns. */
async function runConnect(
  registry: readonly MemoryConnector[],
  args: readonly string[],
  home: string,
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await dispatch([setupConnectCommand(registry)], args, {
    clock: systemClock,
    env: { [HOME_ENV]: home },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/**
 * A child environment with nothing a Postgres install left behind: `PATH` is
 * the node folder plus the system ones, so there is no `docker` to find, and
 * every database variable is gone.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

/** The built `brain`, as a child process, with one configuration folder. */
function runBrain(args: readonly string[], home: string): Promise<Run> {
  return spawned(process.execPath, [binPath, ...args], {
    ...childEnvironment(),
    [HOME_ENV]: home,
  });
}

/** The shim itself, with no `SECOND_BRAIN_HOME` anywhere in its environment. */
function runShim(home: string, args: readonly string[]): Promise<Run> {
  const childEnv = childEnvironment();
  delete childEnv[HOME_ENV];
  return spawned(shimPath(home), args, childEnv);
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

function spawned(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  const child = spawn(command, [...args], {
    cwd: repoRoot,
    env,
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

describe('brain setup connect', () => {
  it('registers the shim once, however many times it is run', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });

    const first = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);
    const again = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(first.code).toBe(0);
    expect(again.code).toBe(0);
    expect((JSON.parse(first.stdout) as Envelope).data).toEqual({
      harness: 'demo',
      target: '/memory/demo/settings.json',
      changed: true,
    });
    expect((JSON.parse(again.stdout) as Envelope).data).toEqual({
      harness: 'demo',
      target: '/memory/demo/settings.json',
      changed: false,
    });
    // One entry, carrying the marker, naming this home's shim.
    expect(demo.marked()).toEqual([`${BRAIN_MARKER} hook -> ${shimPath(home)}`]);
  });

  it('prints one line in text mode, and says the second time nothing changed', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });

    const first = await runConnect([demo], ['setup', 'connect', 'demo'], home);
    const again = await runConnect([demo], ['setup', 'connect', 'demo'], home);

    expect(first.stdout).toBe(`connected Demo in /memory/demo/settings.json\n`);
    expect(again.stdout).toBe(
      `Demo was already connected in /memory/demo/settings.json\n`,
    );
    expect(first.stderr).toBe('');
  });

  it('answers USAGE and exits 2 for a harness nobody registered', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'nope', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('Known harnesses: demo.');
    expect(demo.entries()).toEqual([]);
  });

  it('says there is no connector at all when the registry is empty', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });

    const run = await runConnect([], ['setup', 'connect', 'anything', '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.message).toContain('no connector yet');
  });

  it('reports SHIM_MISSING and writes nothing when the shim is gone', async () => {
    const home = await emptyHome();
    const { path } = await writeShim(home, { bin: binPath });
    await unlink(path);
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('SHIM_MISSING');
    expect(envelope.error?.message).toContain('brain setup run');
    expect(demo.entries()).toEqual([]);
  });

  it('runs with no configuration folder, because it needs none', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(existsSync(configFilePath(home))).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('CONFIG_MISSING');
  });

  it('reports a connector that refuses, as its own code', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const broken = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json is not JSON' },
    });

    const run = await runConnect([broken], ['setup', 'connect', 'demo', '--json'], home);

    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('HARNESS_UNREADABLE');
  });
});

describe('brain setup run against the local SQLite source', () => {
  beforeAll(() => {
    if (!existsSync(binPath)) {
      throw new Error(`${binPath} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('installs into an empty folder and runs again, byte for byte the same', async () => {
    const home = await emptyHome();
    const args = ['setup', 'run', '--yes'];

    const first = await runBrain(args, home);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    const configBefore = await readFile(configFilePath(home), 'utf8');
    const shimBefore = await readFile(shimPath(home), 'utf8');
    const countsBefore = rowCounts(join(home, 'brain.db'));

    const again = await runBrain(args, home);

    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(await readFile(configFilePath(home), 'utf8')).toBe(configBefore);
    expect(await readFile(shimPath(home), 'utf8')).toBe(shimBefore);
    expect(rowCounts(join(home, 'brain.db'))).toEqual(countsBefore);
    expect(again.stdout).toContain('is already current');
    expect(((await stat(shimPath(home))).mode & 0o777).toString(8)).toBe('755');
    expect(((await stat(join(home, 'brain.db'))).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(join(home, 'files'))).mode & 0o777).toString(8)).toBe('700');
  });

  it('records all three paths and says there is no harness to connect', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--yes'], home);

    expect(run.code).toBe(0);
    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain(`path = "${join(home, 'brain.db')}"`);
    expect(config).toContain(`path = "${join(home, 'files')}"`);
    expect(config).toContain(`path = "${join(home, 'mirror')}"`);
    expect(run.stdout).toContain('no harness to connect yet (epic 2)');
    // The mirror folder itself is epic 4's to create.
    expect(existsSync(join(home, 'mirror'))).toBe(false);
  });

  it('answers a `--json` envelope carrying every line of the flow', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--yes', '--json'], home);

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    const lines = envelope.data?.lines ?? [];
    expect(lines.some((line) => line.startsWith('db: ok'))).toBe(true);
    expect(lines.some((line) => line.startsWith('wal: ok'))).toBe(true);
    expect(lines.some((line) => line.includes('mode 0755'))).toBe(true);
    expect(lines.some((line) => line.includes('mode 0700'))).toBe(true);
  });

  it('keeps paths the folder already chose, rather than resetting them', async () => {
    const home = await emptyHome();
    const store = join(home, 'elsewhere', 'brain.db');
    const mirror = join(home, 'elsewhere', 'mirror');
    const first = await runBrain(
      ['setup', 'run', '--store-path', store, '--mirror-path', mirror, '--yes'],
      home,
    );
    expect(first.code).toBe(0);
    expect(existsSync(store)).toBe(true);
    expect(((await stat(dirname(store))).mode & 0o777).toString(8)).toBe('700');

    // A re-run that says nothing about either: the recorded paths have to
    // survive, or every re-install would move them back to the defaults.
    const again = await runBrain(['setup', 'run', '--yes'], home);

    expect(again.code).toBe(0);
    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain(`path = "${store}"`);
    expect(config).toContain(`path = "${mirror}"`);
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });

  it('keeps the code the flow named, rather than calling every exit 2 a USAGE', async () => {
    const home = await emptyHome();

    const run = await runBrain(
      ['setup', 'run', '--store-path', 'brain.db', '--yes', '--json'],
      home,
    );

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    // The command was invoked correctly; the value it was given was not.
    expect(envelope.error?.code).toBe('CONFIG_INVALID');
    expect(envelope.error?.message).toContain('--store-path brain.db');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it.each(['--database-url', '--docker'])('answers USAGE for the old flag %s', async (flag) => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', flag, 'postgres://x/y', '--yes', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('USAGE');
    expect(existsSync(configFilePath(home))).toBe(false);
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });

  it('answers USAGE and exits 2 when --json leaves it nothing to go on', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('USAGE');
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('leaves a shim that runs doctor with no SECOND_BRAIN_HOME in the environment', async () => {
    const home = await emptyHome();
    const installed = await runBrain(['setup', 'run', '--yes'], home);
    expect(installed.code).toBe(0);

    const run = await runShim(home, ['admin', 'doctor', '--json']);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope & {
      data?: { checks?: { id: string; status: string }[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.checks?.map((check) => check.id)).toEqual([
      'db',
      'wal',
      'fts5-trigram',
      'foreign-keys',
    ]);
    expect(envelope.data?.checks?.every((check) => check.status === 'ok')).toBe(true);
  });

  it('reports db as DB_UNAVAILABLE, and makes no file, once the database is gone', async () => {
    const home = await emptyHome();
    expect((await runBrain(['setup', 'run', '--yes'], home)).code).toBe(0);
    await unlink(join(home, 'brain.db'));

    const run = await runBrain(['admin', 'doctor', '--json'], home);

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope & {
      data?: { checks?: { id: string; status: string; code?: string }[] };
    };
    expect(envelope.data?.checks).toHaveLength(1);
    expect(envelope.data?.checks?.[0]).toMatchObject({
      id: 'db',
      status: 'fail',
      code: 'DB_UNAVAILABLE',
    });
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });
});
