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
  error?: {
    code: string;
    message: string;
    exit_code?: number;
    retryable?: boolean;
    hint?: string;
    retry?: { ns: string; verb: string; args: Record<string, unknown> };
    retry_argv?: string[];
  };
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

/** The owner row, which the install writes once and never again (AD-12). */
function owner(path: string): unknown {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare('select id, name, is_self from users').all();
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

    expect(first.stdout).toBe(`/memory/demo/settings.json에 Demo를 연결했습니다\n`);
    expect(again.stdout).toBe(
      `/memory/demo/settings.json에 Demo가 이미 연결되어 있습니다\n`,
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
    expect(envelope.error?.message).toContain('아는 하네스: demo.');
    expect(demo.entries()).toEqual([]);
  });

  it.each([
    ['an empty harness name', ''],
    ['a harness name of spaces', '  '],
  ])('answers USAGE, naming the argument, for %s', async (_what, name) => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', name, '--json'], home);

    // `brain setup connect "$(…)"` with a capture that came back empty: a
    // command that went looking for the harness "" would answer "no connector
    // for" what is really a broken command line.
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('harness');
    expect(envelope.error?.message).toContain('비어 있습니다');
    expect(demo.entries()).toEqual([]);
  });

  it.each([
    ['an escape sequence', '\u001b[31mdemo'],
    ['a zero-width space', 'de\u200bmo'],
    ['a bidi override', 'de\u202emo'],
  ])('answers USAGE for a harness name carrying %s', async (_what, name) => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', name, '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
    expect(demo.entries()).toEqual([]);
  });

  it('says there is no connector at all when the registry is empty', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });

    const run = await runConnect([], ['setup', 'connect', 'anything', '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.message).toContain('아직 커넥터를 등록하지 않습니다');
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
    const ownerBefore = owner(join(home, 'brain.db'));

    const again = await runBrain(args, home);

    expect(again.stderr).toBe('');
    expect(again.code).toBe(0);
    expect(await readFile(configFilePath(home), 'utf8')).toBe(configBefore);
    expect(await readFile(shimPath(home), 'utf8')).toBe(shimBefore);
    expect(rowCounts(join(home, 'brain.db'))).toEqual(countsBefore);
    // The same owner, down to the id: a re-run, and a database carried here
    // from another machine, both land on this branch (AD-12).
    expect(owner(join(home, 'brain.db'))).toEqual(ownerBefore);
    expect(again.stdout).toContain('이미 최신입니다');
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
    expect(run.stdout).toContain('아직 연결할 하네스가 없습니다 (epic 2)');
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

  it('asks for confirmation and exits 3 when --json leaves it nothing to go on', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--json'], home);

    // Not a usage mistake and not a broken install: somebody has to agree to
    // what the install does, which is its own exit code (Conventions).
    expect(run.code).toBe(3);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('CONFIRMATION_REQUIRED');
    // The envelope says the same number the process exited with, so nobody has
    // to read the shell to find out what happened.
    expect(envelope.error?.exit_code).toBe(3);
    // Running it again unchanged cannot work: it needs the consent, not time.
    expect(envelope.error?.retryable).toBe(false);
    // The flow's own Korean line, without the colon that introduced the flag
    // list the envelope now carries as `retry_argv`.
    expect(envelope.error?.message).toBe(
      '터미널이 아니어서 아무것도 물을 수 없습니다. --yes로 미리 동의하세요',
    );
    expect(envelope.error?.hint).toBeTruthy();
    expect(envelope.error?.retry).toEqual({
      ns: 'setup',
      verb: 'run',
      args: { confirm: true },
    });
    expect(envelope.error?.retry_argv).toEqual(['brain', 'setup', 'run', '--yes', '--json']);
    // And nothing was written: a gate that had already installed would be no
    // gate at all.
    expect(existsSync(configFilePath(home))).toBe(false);
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });

  it('keeps the arguments the caller gave in the retry it asks for', async () => {
    const home = await emptyHome();
    const path = join(home, 'elsewhere', 'b.db');

    const run = await runBrain(['setup', 'run', '--store-path', path, '--json'], home);

    expect(run.code).toBe(3);
    const envelope = JSON.parse(run.stdout) as Envelope;
    // The retry asks for this very install, not a wider one: the path the
    // caller chose travels, the defaults it did not choose do not, and `--json`
    // is output rather than input so it is not an argument either.
    expect(envelope.error?.retry).toEqual({
      ns: 'setup',
      verb: 'run',
      args: { storePath: path, confirm: true },
    });
    expect(envelope.error?.retry_argv).toEqual([
      'brain',
      'setup',
      'run',
      '--store-path',
      path,
      '--yes',
      '--json',
    ]);
    expect(existsSync(configFilePath(home))).toBe(false);
  });

  it('installs when the argv it asked for is run back, and only then', async () => {
    const home = await emptyHome();
    const refused = await runBrain(['setup', 'run', '--json'], home);
    expect(refused.code).toBe(3);
    const argv = (JSON.parse(refused.stdout) as Envelope).error?.retry_argv ?? [];

    // The first word is the binary, which this test supplies itself; the rest
    // is the command line, run exactly as it was handed over.
    expect(argv[0]).toBe('brain');
    const accepted = await runBrain(argv.slice(1), home);

    expect(accepted.code).toBe(0);
    const envelope = JSON.parse(accepted.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(existsSync(configFilePath(home))).toBe(true);
  });

  it('leaves a shim that runs doctor with no SECOND_BRAIN_HOME in the environment', async () => {
    const home = await emptyHome();
    const installed = await runBrain(['setup', 'run', '--yes'], home);
    expect(installed.code).toBe(0);

    const run = await runShim(home, ['doctor', 'run', '--json']);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope & {
      data?: { checks?: { id: string; status: string }[] };
    };
    expect(envelope.ok).toBe(true);
    // Every check this build has, through the shim of that install: the store
    // probes, the schema version, and the machine facts (story 8).
    expect(envelope.data?.checks?.map((check) => check.id)).toEqual([
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
    ]);
    const failed = (envelope.data?.checks ?? []).filter((check) => check.status !== 'ok');
    expect(failed, JSON.stringify(failed)).toEqual([]);
  });

  it('reports db as DB_UNAVAILABLE, and makes no file, once the database is gone', async () => {
    const home = await emptyHome();
    expect((await runBrain(['setup', 'run', '--yes'], home)).code).toBe(0);
    await unlink(join(home, 'brain.db'));

    const run = await runBrain(['doctor', 'run', '--json'], home);

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope & {
      data?: { checks?: { id: string; status: string; code?: string; detail?: string }[] };
    };
    // No probe is reported — nothing was probed — and the schema version says
    // it was skipped and why, rather than being left out for a reader to work
    // out. The machine checks still ran.
    expect(envelope.data?.checks?.map((check) => check.id)).toEqual([
      'db',
      'schema-version',
      'config',
      'shim',
      'node-path',
      'node-version',
    ]);
    expect(envelope.data?.checks?.[1]).toEqual({
      id: 'schema-version',
      status: 'skip',
      detail: '앞선 점검 실패: db',
    });
    expect(envelope.data?.checks?.[0]).toMatchObject({
      id: 'db',
      status: 'fail',
      code: 'DB_UNAVAILABLE',
    });
    expect(envelope.data?.checks?.filter((check) => check.status === 'fail')).toHaveLength(1);
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
  });
});
