import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BRAIN_MARKER,
  claudeCodeConnector,
  type Connector,
  SQLITE_MIGRATIONS_DIRECTORY,
  runSqliteMigrations,
} from 'second_brain';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
import { HOME_ENV, configFilePath, envFilePath } from '../src/config/paths.js';
import { setupConnectCommand } from '../src/commands/setup-connect.js';
import { dispatch } from '../src/dispatch.js';
import { parseShim, shimPath, writeShim } from '../src/install/shim.js';
import { systemClock } from '../src/runtime/clock.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

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
  data?: {
    harness?: string;
    target?: string;
    changed?: boolean;
    plugin_root?: string | null;
    home?: string;
    config_path?: string;
    store?: { path?: string; schema_version?: number; applied?: string[] };
    owner?: { name?: string; created?: boolean };
    files?: { path?: string; created?: boolean };
    mirror_path?: string;
    shim?: { path?: string; changed?: boolean };
    harnesses?: { harness: string; target: string; changed: boolean }[];
    checks?: { id: string; status: string; code?: string; detail?: string }[];
    summary?: { passed?: number; failed?: number };
    update?: { auto?: boolean };
    installed?: { path?: string; commit?: string | null };
  };
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

const temporary = tempHomes();

async function emptyHome(): Promise<string> {
  const home = await temporary.create('brain-setup-');
  return home;
}

/** One in-process invocation against a registry this test owns. */
async function runConnect(
  registry: readonly Connector[],
  args: readonly string[],
  home: string,
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await dispatch([setupConnectCommand(registry)], args, {
    clock: systemClock,
    env: withoutHarnessFolders({ [HOME_ENV]: home }),
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
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  });
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

afterEach(() => temporary.cleanup());

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
      plugin_root: null,
      changed: true,
    });
    expect((JSON.parse(again.stdout) as Envelope).data).toEqual({
      harness: 'demo',
      target: '/memory/demo/settings.json',
      plugin_root: null,
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
    expect(run.stdout).toContain('연결한 하네스가 없습니다');
    // The mirror folder itself is epic 4's to create.
    expect(existsSync(join(home, 'mirror'))).toBe(false);
  });

  it('answers a `--json` envelope carrying a structured report, not log lines', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--yes', '--json'], home);

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual([]);
    const data = envelope.data ?? {};
    // Facts, not sentences: a caller that had to parse the lines back would
    // read a different install the moment one of them is reworded (F6).
    expect('lines' in data).toBe(false);
    expect(data.home).toBe(home);
    expect(data.config_path).toBe(configFilePath(home));
    expect(data.store).toMatchObject({ path: join(home, 'brain.db') });
    expect(data.store?.applied?.length).toBeGreaterThan(0);
    expect(data.owner).toMatchObject({ created: true });
    expect(data.files).toEqual({ path: join(home, 'files'), created: true });
    expect(data.mirror_path).toBe(join(home, 'mirror'));
    expect(data.shim).toEqual({ path: shimPath(home), changed: true });
    // No connector in this build, so nothing was registered (epic 2).
    expect(data.harnesses).toEqual([]);
    expect(data.checks?.map((check) => check.id)).toContain('wal');
    expect(data.summary?.failed).toBe(0);
    // The two this story added: what the install decided about updating, and
    // the completion record a plugin's `SessionStart` reads (AD-19).
    expect(data.update).toEqual({ auto: true });
    expect(data.installed?.path).toBe(join(home, 'installed.json'));
  });

  it('keeps every value beside the one it could not use, and warns', async () => {
    const home = await emptyHome();
    // A relative `store.path` beside a files root, a mirror and a time zone
    // the user chose. Before this story one bad value reset all four (F1).
    await writeFile(
      configFilePath(home),
      [
        'schema_version = 1',
        'timezone = "Europe/Berlin"',
        '[store]',
        'path = "brain.db"',
        '[files]',
        `path = "${join(home, 'elsewhere', 'files')}"`,
        '[mirror]',
        `path = "${join(home, 'elsewhere', 'mirror')}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    const run = await runBrain(['setup', 'run', '--yes', '--json'], home);

    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['CONFIG_VALUE_RESET']);
    const config = await readFile(configFilePath(home), 'utf8');
    expect(config).toContain('timezone = "Europe/Berlin"');
    expect(config).toContain(`path = "${join(home, 'elsewhere', 'files')}"`);
    expect(config).toContain(`path = "${join(home, 'elsewhere', 'mirror')}"`);
    // Only the store fell back to the default.
    expect(config).toContain(`path = "${join(home, 'brain.db')}"`);
  });

  it('writes the keys it does not know straight back, byte for byte on a re-run', async () => {
    const home = await emptyHome();
    await writeFile(
      configFilePath(home),
      ['schema_version = 1', '[database]', 'url_env = "X"', '[store]', 'extra = 1', ''].join('\n'),
      'utf8',
    );

    const first = await runBrain(['setup', 'run', '--yes', '--json'], home);

    expect(first.code).toBe(0);
    expect((JSON.parse(first.stdout) as Envelope).warnings).toEqual([
      'CONFIG_UNKNOWN_KEY',
      'CONFIG_UNKNOWN_KEY',
    ]);
    const once = await readFile(configFilePath(home), 'utf8');
    expect(once).toContain('url_env = "X"');
    expect(once).toContain('extra = 1');

    const again = await runBrain(['setup', 'run', '--yes'], home);

    expect(again.code).toBe(0);
    expect(await readFile(configFilePath(home), 'utf8')).toBe(once);
  });

  it('refuses a store path that is not a database, touching neither file', async () => {
    const home = await emptyHome();
    expect((await runBrain(['setup', 'run', '--yes'], home)).code).toBe(0);
    const configBefore = await readFile(configFilePath(home), 'utf8');
    const envBefore = await readFile(envFilePath(home), 'utf8');
    const stranger = join(home, 'notes.txt');
    await writeFile(stranger, 'not a database\n', 'utf8');
    await chmod(stranger, 0o644);

    const run = await runBrain(
      ['setup', 'run', '--store-path', stranger, '--yes', '--json'],
      home,
    );

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
    expect(envelope.error?.exit_code).toBe(1);
    // The file is as it was, there is no log beside it, and the recorded paths
    // did not move: the configuration is written after the store, not before
    // (F3, F4).
    expect(await readFile(stranger, 'utf8')).toBe('not a database\n');
    expect(((await stat(stranger)).mode & 0o777).toString(8)).toBe('644');
    expect(existsSync(`${stranger}-wal`)).toBe(false);
    expect(await readFile(configFilePath(home), 'utf8')).toBe(configBefore);
    expect(await readFile(envFilePath(home), 'utf8')).toBe(envBefore);
  });

  it('refuses a configuration it cannot read at all, writing nothing', async () => {
    const home = await emptyHome();
    await writeFile(configFilePath(home), 'schema_version = 2\n', 'utf8');

    const run = await runBrain(['setup', 'run', '--yes', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('CONFIG_INVALID');
    expect(envelope.error?.exit_code).toBe(2);
    // The one copy of what the person chose is still there to be fixed by hand.
    expect(await readFile(configFilePath(home), 'utf8')).toBe('schema_version = 2\n');
    expect(existsSync(join(home, 'brain.db'))).toBe(false);
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
      'failures',
      'untagged',
      'transcripts',
      'config',
      'shim',
      'node-path',
      'node-version',
      'plugin',
      'last-hook',
      'spool',
      'daemon',
    ]);
    const failed = (envelope.data?.checks ?? []).filter((check) => check.status !== 'ok' && check.id !== 'daemon');
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
      'failures',
      'untagged',
      'transcripts',
      'config',
      'shim',
      'node-path',
      'node-version',
      'plugin',
      'last-hook',
      'spool',
      'daemon',
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

/**
 * The one upgrade that can need somebody's consent, against a real database.
 *
 * Migration 0005 makes the project comparison key `unique`, and a brain that
 * split one repository into two projects over nothing but the case of its
 * remote has two rows that become one key. The install shows them, asks, and
 * merges inside the migration's own transaction — so a no leaves the file at
 * the version it was, and a yes keeps every session (AD-12).
 */
describe('brain setup run on a database whose projects collide', () => {
  /** Ids in the UUIDv7 shape every row carries (AD-8). */
  function id(ordinal: number): string {
    return `01960000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
  }

  const AT = '2026-02-03T04:05:06.000Z';
  const REMOTE_UPPER = 'github.com/Brain-Owner/Notes';
  const REMOTE_LOWER = 'github.com/brain-owner/notes';

  /**
   * A `<home>/brain.db` at version 4 — the version before the key — holding the
   * two projects, three sessions and three worktrees a merge has to reconcile.
   *
   * The folder of migration files is one this test writes, because a folder the
   * caller names is not held to `SQLITE_SCHEMA_VERSION`: that is the only way
   * to stop at an earlier version with the files this build ships.
   */
  async function versionFourHome(): Promise<string> {
    const home = await emptyHome();
    const directory = join(home, 'migrations-0004');
    await mkdir(directory, { recursive: true });
    for (const name of [
      '0001_initial.sql',
      '0002_files_and_work.sql',
      '0003_users.sql',
      '0004_capture_columns.sql',
    ]) {
      await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    const path = join(home, 'brain.db');
    expect(await runSqliteMigrations({ path, directory })).toMatchObject({ ok: true, to: 4 });

    const database = new DatabaseSync(path);
    try {
      database.exec('pragma foreign_keys = ON');
      database.exec(
        `insert into users (id, name, is_self, created_at)
              values ('${id(1)}', 'brain-owner', 1, '${AT}')`,
      );
      database.exec(
        `insert into projects (id, remote_identity)
              values ('${id(2)}', '${REMOTE_UPPER}'), ('${id(3)}', '${REMOTE_LOWER}')`,
      );
      // `/demo/repo` under both projects is one checkout seen twice, so the
      // merge folds it; `/demo/repo-review` belongs to the loser alone.
      database.exec(
        `insert into worktrees (id, project_id, path)
              values ('${id(4)}', '${id(2)}', '/demo/repo'),
                     ('${id(5)}', '${id(3)}', '/demo/repo'),
                     ('${id(6)}', '${id(3)}', '/demo/repo-review')`,
      );
      for (const [ordinal, project, worktree] of [
        [7, id(2), id(4)],
        [8, id(3), id(5)],
        [9, id(3), id(6)],
      ] as const) {
        database.exec(
          `insert into sessions (id, harness, harness_session_id, user_id, machine,
                                 started_at, ingest_source, project_id, worktree_id)
                values ('${id(ordinal)}', 'demo', 'session-000${String(ordinal)}', '${id(1)}',
                        'demo-machine', '${AT}', 'live', '${project}', '${worktree}')`,
        );
      }
    } finally {
      database.close();
    }
    return home;
  }

  /** One scalar off the database, read without writing. */
  function scalar(path: string, query: string): unknown {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return (database.prepare(query).get() as Record<string, unknown> | undefined)?.['n'];
    } finally {
      database.close();
    }
  }

  it('shows the group, merges it and reaches the current version with every session kept', async () => {
    const home = await versionFourHome();
    const path = join(home, 'brain.db');

    const run = await runBrain(['setup', 'run', '--yes'], home);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    // The trade, in full: both remotes, both session counts, and which row
    // stays. `--yes` is consent given in advance, not consent in the dark.
    expect(run.stdout).toContain(`비교 키 ${REMOTE_LOWER}로 겹치는 프로젝트가 2개 있습니다`);
    expect(run.stdout).toContain(`${REMOTE_UPPER} (세션 1건)`);
    expect(run.stdout).toContain(`${REMOTE_LOWER} (세션 2건)`);
    expect(run.stdout).toContain('겹치는 프로젝트 1묶음을 하나로 합쳤습니다');
    expect(run.stdout).toContain('0005_identity_and_records.sql');
    expect(run.stdout).toContain('스키마 버전은 8입니다');

    // One project, under the older id and keeping the remote it was written
    // with, and the shared folder folded into one worktree.
    expect(scalar(path, 'select count(*) as n from projects')).toBe(1);
    expect(scalar(path, `select remote_identity as n from projects`)).toBe(REMOTE_UPPER);
    expect(scalar(path, 'select count(*) as n from worktrees')).toBe(2);
    // Every session is still here, and every one points at what is left.
    expect(scalar(path, 'select count(*) as n from sessions')).toBe(3);
    expect(scalar(path, `select count(*) as n from sessions where project_id = '${id(2)}'`)).toBe(3);
    expect(scalar(path, 'select count(*) as n from pragma_foreign_key_check')).toBe(0);

    // The same number doctor reports, which is the question a later command
    // refuses to write on (AD-20).
    const doctor = await runBrain(['doctor', 'run', '--json'], home);
    const checks = (JSON.parse(doctor.stdout) as Envelope).data?.checks ?? [];
    expect(checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'ok',
      detail: '8',
    });
  });

  it('exits 3 without a terminal and without --yes, leaving the file byte for byte', async () => {
    const home = await versionFourHome();
    const path = join(home, 'brain.db');
    const before = await readFile(path);

    const run = await runBrain(['setup', 'run', '--json'], home);

    expect(run.code).toBe(3);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('CONFIRMATION_REQUIRED');
    // The consent gate is before every question, the merge one included, so
    // nothing was read and nothing was written.
    expect(await readFile(path)).toEqual(before);
    expect(scalar(path, 'select version as n from schema_version')).toBe(4);
    expect(existsSync(configFilePath(home))).toBe(false);
  });
});

/**
 * The upgrade migration 0006 is: `messages.seq` goes away, and with it the
 * table it was a column of. The table is dropped and rebuilt, which is the one
 * shape of upgrade that can lose rows, so this runs it against a real
 * `<home>/brain.db` through the built `brain` and counts what came out.
 */
describe('brain setup run on a version 5 database', () => {
  /** Ids in the UUIDv7 shape every row carries (AD-8). */
  function id(ordinal: number): string {
    return `01970000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
  }

  const AT = '2026-02-03T04:05:06.000Z';
  /**
   * Two messages whose numbers run the other way from their instants, which is
   * exactly the state 0006 exists for: the second one of the conversation was
   * collected later and took the higher number.
   */
  const FIRST_BODY = '먼저 한 말';
  const SECOND_BODY = 'the answer, collected in a later batch';

  /**
   * A `<home>/brain.db` at version 5 with a conversation in it. The folder of
   * migration files is one this test writes, because a folder the caller names
   * is not held to `SQLITE_SCHEMA_VERSION`: that is the only way to stop at an
   * earlier version with the files this build ships.
   */
  async function versionFiveHome(): Promise<string> {
    const home = await emptyHome();
    const directory = join(home, 'migrations-0005');
    await mkdir(directory, { recursive: true });
    for (const name of [
      '0001_initial.sql',
      '0002_files_and_work.sql',
      '0003_users.sql',
      '0004_capture_columns.sql',
      '0005_identity_and_records.sql',
    ]) {
      await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
    }
    const path = join(home, 'brain.db');
    expect(await runSqliteMigrations({ path, directory })).toMatchObject({ ok: true, to: 5 });

    const database = new DatabaseSync(path);
    try {
      database.exec('pragma foreign_keys = ON');
      database.exec(
        `insert into users (id, name, is_self, created_at)
              values ('${id(1)}', 'brain-owner', 1, '${AT}')`,
      );
      database.exec(
        `insert into sessions (id, harness, harness_session_id, user_id, machine,
                               started_at, ingest_source)
              values ('${id(2)}', 'demo', 'session-0001', '${id(1)}', 'demo-machine',
                      '${AT}', 'live')`,
      );
      // `seq` 1 at 04:05:07 and `seq` 0 at 04:05:08: the numbers and the
      // instants disagree, so the upgrade cannot quietly be sorting by either
      // and still come out right.
      database.exec(
        `insert into messages (id, session_id, harness_message_id, seq, role, model, body,
                               occurred_at, git_branch, is_subagent_report)
              values ('${id(3)}', '${id(2)}', 'h-1', 1, 'user', null, '${FIRST_BODY}',
                      '2026-02-03T04:05:07.000Z', 'main', 0),
                     ('${id(4)}', '${id(2)}', 'h-2', 0, 'assistant', 'demo-model',
                      '${SECOND_BODY}', '2026-02-03T04:05:08.000Z', 'main', 1)`,
      );
      database.exec(
        `insert into tool_notes (id, session_id, harness_message_id, ordinal, tool, target, ok)
              values ('${id(5)}', '${id(2)}', 'h-2', 0, 'Read', '/demo/repo/notes.md', 1)`,
      );
      database.exec(
        `insert into log_entries (id, kind, session_id, occurred_at, recorded_at, "text",
                                  anchor_seq, joined_upto_seq)
              values ('${id(6)}', 'progress', '${id(2)}', '${AT}', '${AT}', '초안을 읽었습니다',
                      0, 1)`,
      );
    } finally {
      database.close();
    }
    return home;
  }

  /** Every row of one query, read without writing. */
  function rows(path: string, query: string): unknown[] {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare(query).all();
    } finally {
      database.close();
    }
  }

  it('reaches version 8 and keeps the conversation, with no number left in it', async () => {
    const home = await versionFiveHome();
    const path = join(home, 'brain.db');

    const run = await runBrain(['setup', 'run', '--yes'], home);

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('0006_drop_message_seq.sql');
    expect(run.stdout).toContain('스키마 버전은 8입니다');

    // The number doctor reports, which is the one a later command refuses to
    // write on (AD-20).
    const doctor = await runBrain(['doctor', 'run', '--json'], home);
    const checks = (JSON.parse(doctor.stdout) as Envelope).data?.checks ?? [];
    expect(checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'ok',
      detail: '8',
    });

    // Every row came back, under its own id and body, and in the order it was
    // uttered rather than the order it was numbered.
    expect(
      rows(
        path,
        `select id, harness_message_id, role, model, body, occurred_at, git_branch,
                is_subagent_report
           from messages order by occurred_at`,
      ),
    ).toEqual([
      {
        id: id(3),
        harness_message_id: 'h-1',
        role: 'user',
        model: null,
        body: FIRST_BODY,
        occurred_at: '2026-02-03T04:05:07.000Z',
        git_branch: 'main',
        is_subagent_report: 0,
      },
      {
        id: id(4),
        harness_message_id: 'h-2',
        role: 'assistant',
        model: 'demo-model',
        body: SECOND_BODY,
        occurred_at: '2026-02-03T04:05:08.000Z',
        git_branch: 'main',
        is_subagent_report: 1,
      },
    ]);
    expect(rows(path, 'select id, tool, target, ok from tool_notes')).toEqual([
      { id: id(5), tool: 'Read', target: '/demo/repo/notes.md', ok: 1 },
    ]);
    expect(rows(path, 'select id, "text" from log_entries')).toEqual([
      { id: id(6), text: '초안을 읽었습니다' },
    ]);

    // And the columns are gone, not merely unused.
    expect(
      rows(path, `select name from pragma_table_info('messages') where name = 'seq'`),
    ).toEqual([]);
    expect(
      rows(
        path,
        `select name from pragma_table_info('log_entries')
          where name in ('anchor_seq', 'joined_upto_seq')`,
      ),
    ).toEqual([]);
    expect(rows(path, 'select * from pragma_foreign_key_check')).toEqual([]);
  });
});

/**
 * The completion record, written by the real install against a real home: the
 * shim is run from outside the process, the build's identity is read off
 * `dist/build.json`, and only then is the record written (AD-19, AD-20).
 */
describe('brain setup run and the completion record', () => {
  interface Record {
    commit?: string | null;
    schema_version?: number;
    node?: string;
    plugin_root?: string | null;
    installed_at?: string;
  }

  async function recordOf(home: string): Promise<Record> {
    return JSON.parse(await readFile(join(home, 'installed.json'), 'utf8')) as Record;
  }

  it('records the build, the pinned node and no plugin folder, at mode 0644', async () => {
    const home = await emptyHome();

    const run = await runBrain(['setup', 'run', '--yes'], home);

    expect(run.code).toBe(0);
    const record = await recordOf(home);
    // `dist/build.json` is written by this package's own build, so the commit
    // and the schema version are this build's own facts.
    const build = JSON.parse(
      await readFile(fileURLToPath(new URL('../dist/build.json', import.meta.url)), 'utf8'),
    ) as { commit: string | null; schema_version: number };
    expect(record.commit).toBe(build.commit);
    expect(record.schema_version).toBe(build.schema_version);
    // The node the shim was pinned to, which is the node a hook will run.
    expect(record.node).toBe(parseShim(await readFile(shimPath(home), 'utf8'))?.node);
    // Nothing started this install from a plugin folder.
    expect(record.plugin_root).toBeNull();
    expect(record.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Nothing private in it, and a hook may run as another process than the
    // install did.
    expect(((await stat(join(home, 'installed.json'))).mode & 0o777).toString(8)).toBe('644');
  });

  it('records the plugin folder --plugin-root names, and keeps it on a re-run', async () => {
    const home = await emptyHome();

    await runBrain(['setup', 'run', '--yes', '--plugin-root', '/plugins/second-brain'], home);
    expect((await recordOf(home)).plugin_root).toBe('/plugins/second-brain');

    // A hand-run `setup run` afterwards must not turn a plugin install into
    // one the `plugin` check then has nothing to say about.
    const again = await runBrain(['setup', 'run', '--yes'], home);
    expect(again.code).toBe(0);
    expect((await recordOf(home)).plugin_root).toBe('/plugins/second-brain');
  });

  it('records [update] auto and reads it back as a configuration key', async () => {
    const home = await emptyHome();

    await runBrain(['setup', 'run', '--yes'], home);

    expect(await readFile(configFilePath(home), 'utf8')).toContain('auto = true');
  });

  it('reports the plugin check as ok, since the install came from no plugin', async () => {
    const home = await emptyHome();
    await runBrain(['setup', 'run', '--yes'], home);

    const run = await runBrain(['doctor', 'run', '--json'], home);

    const envelope = JSON.parse(run.stdout) as Envelope;
    const plugin = envelope.data?.checks?.find((check) => check.id === 'plugin');
    expect(plugin).toMatchObject({ status: 'ok' });
  });
});

describe('plugin connections', () => {
  it.each(['mode', 'signature', 'entry', 'parse'])('rejects an unusable shim before invoking the connector: %s', async (problem) => {
    const home = await emptyHome();
    const { path } = await writeShim(home, { bin: binPath });
    if (problem === 'mode') await chmod(path, 0o600);
    if (problem === 'signature') await writeFile(path, (await readFile(path, 'utf8')).replace('Written by second-brain', 'Written by somebody'));
    if (problem === 'entry') await writeShim(home, { bin: join(home, 'missing.js') });
    if (problem === 'parse') await writeFile(path, '#!/bin/sh\nexit 0\n');
    const demo = memoryConnector();
    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe(problem === 'parse' ? 'SHIM_MISSING' : 'SHIM_INVALID');
    expect(demo.entries()).toEqual([]);
  });
  it('warns when no plugin has run and leaves unmarked settings byte for byte', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const config = join(home, 'claude');
    await mkdir(config);
    const target = join(config, 'settings.json');
    const text = '{ "hooks": {"Stop":[{"hooks":[{"type":"command","command":"echo user"}]}]} }';
    await writeFile(target, text);
    const run = await runConnect([claudeCodeConnector({ configDir: config })], ['setup', 'connect', 'claude-code', '--json'], home);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(run.code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['PLUGIN_NOT_INSTALLED']);
    expect(envelope.data).toMatchObject({ plugin_root: null, changed: false });
    expect(await readFile(target, 'utf8')).toBe(text);
    const human = await runConnect([claudeCodeConnector({ configDir: config })], ['setup', 'connect', 'claude-code'], home);
    expect(human.stdout).toContain('Claude Code 플러그인이 설치되어 있지 않습니다. Claude Code에서 second-brain 플러그인을 설치하세요');
  });
  it('prefers run/plugin.json, reports the root and explains cleanup in Korean', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const config = join(home, 'claude');
    await mkdir(config);
    const target = join(config, 'settings.json');
    await writeFile(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old # second-brain' }] }] } }));
    await mkdir(join(home, 'run'));
    await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: 'a'.repeat(40), schema_version: 6, node: process.execPath, plugin_root: '/installed/plugin', installed_at: new Date().toISOString() }));
    await writeFile(join(home, 'run', 'plugin.json'), JSON.stringify({ plugin_root: '/current/plugin', app_ref: 'a'.repeat(40), seen_at: new Date().toISOString() }));
    const connector = claudeCodeConnector({ configDir: config });
    const text = await runConnect([connector], ['setup', 'connect', 'claude-code'], home);
    expect(text.stdout).toBe(`${target}에서 예전 brain hook을 지웠습니다\nClaude Code는 /current/plugin의 플러그인으로 연결되어 있습니다\n`);
    const run = await runConnect([connector], ['setup', 'connect', 'claude-code', '--json'], home);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.warnings).toEqual([]);
    expect(envelope.data).toMatchObject({ plugin_root: '/current/plugin', changed: false });
  });
});
