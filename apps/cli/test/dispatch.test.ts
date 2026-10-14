import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { runMigrations } from 'second_brain';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';

/**
 * The dispatcher, against a real database and a registry that exists only
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

/** A configuration folder pointing at `databaseUrl`. */
async function homeFor(databaseUrl: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
  homes.push(home);
  await writeConfig(home, { databaseUrl });
  return home;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('the dispatcher', () => {
  /** Migrated, so the stored version is the one the code expects. */
  let current: TestDatabase;
  /** Not migrated, so it holds no version row at all. */
  let empty: TestDatabase;

  beforeAll(async () => {
    if (!existsSync(dispatchModule)) {
      throw new Error(`${dispatchModule} does not exist. Run \`pnpm build\` before these tests.`);
    }
    current = await createTestDatabase();
    const migration = await runMigrations({ databaseUrl: current.url });
    expect(migration.ok).toBe(true);
    empty = await createTestDatabase();
  });

  afterAll(async () => {
    await current?.drop();
    await empty?.drop();
  });

  it('runs a read command without looking at the schema version', async () => {
    // `empty` has no `schema_version` row; a read must not care.
    const home = await homeFor(empty.url);

    const run = await runDispatch(['fake', 'read', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ read: true });
    expect(envelope.warnings).toEqual([]);
  });

  it('prints the text lines instead of the envelope without --json', async () => {
    const home = await homeFor(empty.url);

    const run = await runDispatch(['fake', 'read'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('read ok\n');
  });

  it('runs a write command when the schema version matches', async () => {
    const home = await homeFor(current.url);

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('RAN');
    const envelope = JSON.parse(run.stdout.split('\n')[1] ?? '{}') as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ wrote: true });
  });

  it('refuses a write and never calls run when the version does not match', async () => {
    const home = await homeFor(empty.url);

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
    const ahead = await createTestDatabase();
    try {
      const migration = await runMigrations({ databaseUrl: ahead.url });
      expect(migration.ok).toBe(true);
      await ahead.query('update schema_version set version = version + 1');
      const home = await homeFor(ahead.url);

      const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(1);
      expect(run.stdout).not.toContain('RAN');
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('SCHEMA_MISMATCH');
      expect(envelope.warnings).toEqual(['SCHEMA_MISMATCH']);
    } finally {
      await ahead.drop();
    }
  });

  it('refuses a write with DB_UNAVAILABLE, inside five seconds, when the database is down', async () => {
    const port = await closedPort();
    const home = await homeFor(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

    const startedAt = Date.now();
    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });
    const elapsed = Date.now() - startedAt;

    expect(run.code).toBe(1);
    expect(elapsed).toBeLessThan(5000);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
  });
});

describe('the dispatcher on a hook path', () => {
  it('exits 0 with one line on stderr when the command throws', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'hook-throw', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(run.stderr).toContain('the hook blew up');
    } finally {
      await empty.drop();
    }
  });

  it('exits 0 with one line on stderr when there is no configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
    homes.push(home);

    const run = await runDispatch(['fake', 'hook-throw', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('CONFIG_MISSING');
  });

  it('exits 0 with one line on stderr when the arguments are wrong', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
    homes.push(home);

    const run = await runDispatch(['fake', 'hook-throw', '--nonsense'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('USAGE');
  });

  it('exits 0 with one line on stderr when the schema version blocks the write', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'hook-write', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain('SCHEMA_MISMATCH');
    } finally {
      await empty.drop();
    }
  });

  it('still reports a degraded result, and exits 0 rather than swallowing it', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'hook-degraded', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      const envelope = JSON.parse(run.stdout) as Envelope;
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ partial: true });
      expect(envelope.warnings).toEqual(['RESULT_TRUNCATED']);
    } finally {
      await empty.drop();
    }
  });

  it('prints a degraded result as text and warnings too', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'hook-degraded'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stdout).toBe('degraded but useful\n');
      expect(run.stderr).toContain('RESULT_TRUNCATED');
    } finally {
      await empty.drop();
    }
  });

  it('still prints its result when it succeeds', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'hook-read', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect(run.stderr).toBe('');
      expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ read: true });
    } finally {
      await empty.drop();
    }
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
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'read-arg', 'one', 'two', '--json'], {
        [HOME_ENV]: home,
      });

      expect(run.code).toBe(0);
      expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ args: ['one', 'two'] });
    } finally {
      await empty.drop();
    }
  });

  it('leaves an optional argument out rather than passing undefined', async () => {
    const empty = await createTestDatabase();
    try {
      const home = await homeFor(empty.url);

      const run = await runDispatch(['fake', 'read-arg', 'one', '--json'], { [HOME_ENV]: home });

      expect(run.code).toBe(0);
      expect((JSON.parse(run.stdout) as Envelope).data).toEqual({ args: ['one'] });
    } finally {
      await empty.drop();
    }
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
    const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
    homes.push(home);

    const run = await runDispatch(['fake', 'write', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('CONFIG_MISSING');
  });

  it('exits 2 with CONFIG_INVALID for a broken file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'brain-dispatch-'));
    homes.push(home);
    await writeFile(join(home, 'config.toml'), 'schema_version = =\n', 'utf8');

    const run = await runDispatch(['fake', 'read', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('CONFIG_INVALID');
  });
});
