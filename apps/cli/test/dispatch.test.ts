import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from 'second_brain';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';

/**
 * The dispatcher, against a real SQLite file and a registry that exists only
 * here: fake `writes` and `hook` commands, so the rows of the I/O matrix are
 * checked on the rules themselves rather than on whichever command happens to
 * be implemented. The registry has to be built in the child process, which is
 * why these tests run a small module instead of the `brain` binary.
 */
const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dispatchModule = join(distDir, 'dispatch.js');
const clockModule = join(distDir, 'runtime/clock.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  now: string;
  data?: unknown;
  warnings: string[];
  error?: { code: string; message: string };
}

/** The fake registry, as source the child evaluates. */
const REGISTRY = `
const registry = [
  {
    ns: 'fake',
    verb: 'read',
    description: 'a read command',
    run: async () => ({ ok: true, data: { read: true }, text: ['read ok'] }),
  },
  {
    ns: 'fake',
    verb: 'write',
    description: 'a write command',
    writes: true,
    run: async () => {
      // Proof the guard runs before this: a blocked write never gets here.
      console.log('RAN');
      return { ok: true, data: { wrote: true } };
    },
  },
  {
    ns: 'fake',
    verb: 'read-arg',
    description: 'a read command with a positional argument',
    arguments: ['<name>', '[extra]'],
    run: async (context) => ({ ok: true, data: { args: context.args } }),
  },
  {
    ns: 'fake',
    verb: 'standalone',
    description: 'a command that runs before there is any configuration',
    standalone: true,
    arguments: ['<name>'],
    run: async (context) => ({
      ok: true,
      data: {
        args: context.args,
        home: context.env.SECOND_BRAIN_HOME ?? null,
        // No brain and no config: it was given neither, by design.
        keys: Object.keys(context).sort(),
      },
      text: ['standalone ok'],
    }),
  },
  {
    ns: 'fake',
    verb: 'standalone-fails',
    description: 'a standalone command that could not run',
    standalone: true,
    run: async () => ({ ok: false, code: 'SHIM_MISSING', message: 'no shim', exit: 1 }),
  },
  {
    ns: 'fake',
    verb: 'hook-throw',
    description: 'a hook command that throws',
    hook: true,
    run: async () => {
      throw new Error('the hook blew up');
    },
  },
  {
    ns: 'fake',
    verb: 'hook-write',
    description: 'a hook command that writes',
    hook: true,
    writes: true,
    run: async () => ({ ok: true, data: { wrote: true } }),
  },
  {
    ns: 'fake',
    verb: 'hook-read',
    description: 'a hook command that succeeds',
    hook: true,
    run: async () => ({ ok: true, data: { read: true }, text: ['hook ok'] }),
  },
  {
    ns: 'fake',
    verb: 'hook-degraded',
    description: 'a hook command that ran and came back degraded',
    hook: true,
    run: async () => ({
      ok: true,
      data: { partial: true },
      warnings: ['RESULT_TRUNCATED'],
      text: ['degraded but useful'],
      failed: true,
    }),
  },
];
`;

function runDispatch(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const script = [
    `const { dispatch } = await import(${JSON.stringify(dispatchModule)});`,
    `const { systemClock } = await import(${JSON.stringify(clockModule)});`,
    REGISTRY,
    // With `node -e`, `process.argv[1]` is already the first user argument.
    'process.exitCode = await dispatch(registry, process.argv.slice(1), { clock: systemClock });',
  ].join('\n');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv[HOME_ENV];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', ...args], {
    cwd: join(repoRoot, 'apps', 'cli'),
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

const homes: string[] = [];

async function scratch(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
  homes.push(home);
  return home;
}

/** A configuration folder naming `storePath`. */
async function homeFor(storePath: string): Promise<string> {
  const home = await scratch();
  await writeConfig(home, { storePath });
  return home;
}

/** A database file at the version this build ships. */
async function migratedDatabase(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const migrated = await runSqliteMigrations({ path });
  expect(migrated.ok).toBe(true);
  return path;
}

/**
 * A file that is a database and holds no `schema_version` at all, which is what
 * an un-migrated brain looks like. Made with a plain path, the way only the
 * migration runner is otherwise allowed to (AD-20).
 */
async function emptyDatabase(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const database = new DatabaseSync(path);
  database.exec('pragma journal_mode = WAL');
  database.close();
  return path;
}

/** A path with no file at it, which is `DB_UNAVAILABLE` every time. */
async function missingDatabase(): Promise<string> {
  return join(await scratch(), 'brain.db');
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('the dispatcher', () => {
  beforeAll(() => {
    if (!existsSync(dispatchModule)) {
      throw new Error(`${dispatchModule} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  it('runs a read command without looking at the schema version', async () => {
    // An empty file has no `schema_version` table; a read must not care.
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ read: true });
    expect(envelope.warnings).toEqual([]);
  });

  it('prints the text lines instead of the envelope without --json', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('read ok\n');
  });

  it('runs a write command when the schema version matches', async () => {
    const home = await homeFor(await migratedDatabase());

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('RAN');
    const envelope = JSON.parse(run.stdout.split('\n')[1] ?? '{}') as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ wrote: true });
  });

  it('refuses a write and never calls run when the version does not match', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('SCHEMA_MISMATCH');
    expect(envelope.warnings).toEqual(['SCHEMA_MISMATCH']);
    expect(envelope.data).toBeUndefined();
  });

  it('refuses a write and never calls run when the database is at another version', async () => {
    const path = await migratedDatabase();
    const ahead = new DatabaseSync(path);
    ahead.exec('update schema_version set version = version + 1');
    ahead.close();
    const home = await homeFor(path);

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('SCHEMA_MISMATCH');
    expect(envelope.warnings).toEqual(['SCHEMA_MISMATCH']);
  });

  it('refuses a write with DB_UNAVAILABLE, and makes no file, when there is none', async () => {
    const path = await missingDatabase();
    const home = await homeFor(path);

    const startedAt = Date.now();
    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });
    const elapsed = Date.now() - startedAt;

    expect(run.code).toBe(1);
    expect(elapsed).toBeLessThan(5000);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
    // A runtime command opens the file and never creates it (AD-20).
    expect(existsSync(path)).toBe(false);
  });

  it('runs a read against a missing file, and still creates nothing', async () => {
    const path = await missingDatabase();
    const home = await homeFor(path);

    const run = await runDispatch(['fake', 'read', '--json'], { [HOME_ENV]: home });

    // The read itself never touches the store, so it still succeeds: the file
    // only has to be there for a command that asks the database something.
    expect(run.code).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

describe('the dispatcher on a hook path', () => {
  it('exits 0 with one line on stderr when the command throws', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'hook-throw', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('the hook blew up');
  });

  it('exits 0 with one line on stderr when there is no configuration', async () => {
    const home = await scratch();

    const run = await runDispatch(['fake', 'hook-throw', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('CONFIG_MISSING');
  });

  it('exits 0 with one line on stderr when the arguments are wrong', async () => {
    const home = await scratch();

    const run = await runDispatch(['fake', 'hook-throw', '--nonsense'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('USAGE');
  });

  it('exits 0 with one line on stderr when the schema version blocks the write', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'hook-write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('SCHEMA_MISMATCH');
  });

  it('still reports a degraded result, and exits 0 rather than swallowing it', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'hook-degraded', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ partial: true });
    expect(envelope.warnings).toEqual(['RESULT_TRUNCATED']);
  });

  it('prints a degraded result as text and warnings too', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'hook-degraded'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('degraded but useful\n');
    expect(run.stderr).toContain('RESULT_TRUNCATED');
  });

  it('still prints its result when it succeeds', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'hook-read', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ read: true });
  });
});

describe('the dispatcher and a standalone command', () => {
  it('runs it with no configuration at all, and hands it the environment', async () => {
    // A folder that does not exist: any other command would end in
    // CONFIG_MISSING here, which is exactly why `setup run` is standalone.
    const run = await runDispatch(['fake', 'standalone', 'thing', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      args: ['thing'],
      home: '/nonexistent/home',
      keys: ['args', 'clock', 'env', 'options'],
    });
  });

  it('prints its text and its exit code the same way as any other command', async () => {
    const run = await runDispatch(['fake', 'standalone', 'thing'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('standalone ok\n');
  });

  it('reports its own failure code and exit 1', async () => {
    const run = await runDispatch(['fake', 'standalone-fails', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('SHIM_MISSING');
  });

  it('answers USAGE when a required argument is missing', async () => {
    const run = await runDispatch(['fake', 'standalone', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain("missing required argument 'name'");
  });
});

describe('the dispatcher and positional arguments', () => {
  it('hands a database command its arguments in the order they were declared', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read-arg', 'one', 'two', '--json'], {
      [HOME_ENV]: home,
    });

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ args: ['one', 'two'] });
  });

  it('leaves an optional argument out rather than passing undefined', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read-arg', 'one', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ args: ['one'] });
  });

  it('answers USAGE for one argument too many', async () => {
    const run = await runDispatch(['fake', 'read-arg', 'one', 'two', 'three', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
  });
});

describe('the dispatcher and a command it does not know', () => {
  it('answers a USAGE envelope and exits 2, reading no configuration', async () => {
    const run = await runDispatch(['nope', 'verb', '--json'], { [HOME_ENV]: '/nonexistent/home' });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('fake read');
    expect(envelope.warnings).toEqual([]);
  });

  it('reports an unknown verb inside a known namespace', async () => {
    const run = await runDispatch(['fake', 'nope', '--json'], { [HOME_ENV]: '/nonexistent/home' });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
  });

  it('reports an unknown flag on a known command', async () => {
    const run = await runDispatch(['fake', 'read', '--nonsense', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
  });

  it('reports USAGE in text mode too, on stderr', async () => {
    const run = await runDispatch(['nope', 'verb'], { [HOME_ENV]: '/nonexistent/home' });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('USAGE');
  });

  // Commander's own `help` subcommand would print help and then fail, putting
  // two things on stdout where the caller expects exactly one envelope.
  for (const words of [['help'], ['help', 'fake'], ['fake', 'help']]) {
    it(`answers one parseable envelope for \`brain ${words.join(' ')} --json\``, async () => {
      const run = await runDispatch([...words, '--json'], { [HOME_ENV]: '/nonexistent/home' });

      expect(run.code).toBe(2);
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('USAGE');
    });
  }

  it('prints help and exits 0 for --help', async () => {
    const run = await runDispatch(['--help'], { [HOME_ENV]: '/nonexistent/home' });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('fake');
    expect(run.stdout).not.toContain('"ok"');
  });
});

describe('the dispatcher and an unusable configuration', () => {
  it('exits 2 with CONFIG_MISSING and never connects', async () => {
    const home = await scratch();

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('CONFIG_MISSING');
  });

  it('exits 2 with CONFIG_INVALID for a broken file', async () => {
    const home = await scratch();
    await writeFile(join(home, 'config.toml'), 'schema_version = =\n', 'utf8');

    const run = await runDispatch(['fake', 'read', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('CONFIG_INVALID');
  });

  it('exits 2 with CONFIG_INVALID for a relative store path, running no command', async () => {
    const home = await scratch();
    await writeFile(
      join(home, 'config.toml'),
      'schema_version = 1\n[store]\npath = "brain.db"\n',
      'utf8',
    );

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('CONFIG_INVALID');
    expect(envelope.error?.message).toContain('store.path');
  });
});
