import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BUSY_TIMEOUT_MS,
  DRAIN_BUDGET_MS,
  runSqliteMigrations,
  type SchemaStore,
  type SqliteStoreOptions,
  type Store,
} from 'second_brain';
import { writeConfig } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import {
  dispatch,
  type CommandMeta,
  type CommandSpec,
  type CreateStore,
} from '../src/dispatch.js';
import { systemClock } from '../src/runtime/clock.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

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
const envelopeModule = join(distDir, 'envelope.js');

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

/**
 * The fake registry, as source the child evaluates.
 *
 * `meta` fills the seven mandatory fields of a spec (Conventions, 명령 메타)
 * from the one line each fake is about, so these tests stay about the
 * dispatcher's rules. That the real registry declares them properly is
 * `command-meta.test.ts`'s question, not this file's.
 */
const REGISTRY = `
const meta = (ns, verb, usedFor, over) => ({
  usedFor,
  required: [],
  examples: ['brain ' + ns + ' ' + verb],
  output: 'whatever this fake answers with',
  risk: 'read',
  hook: false,
  dryRun: false,
  ...over,
});

const registry = [
  {
    ns: 'fake',
    verb: 'read',
    ...meta('fake', 'read', 'a read command'),
    run: async () => ({ ok: true, data: { read: true }, text: ['read ok'] }),
  },
  {
    ns: 'fake',
    verb: 'write',
    ...meta('fake', 'write', 'a write command'),
    writes: true,
    run: async () => {
      // Proof the guard runs before this: a blocked write never gets here.
      console.log('RAN');
      return { ok: true, data: { wrote: true } };
    },
  },
  {
    ns: 'fake',
    verb: 'write-spool',
    ...meta('fake', 'write-spool', 'a write command whose write can wait'),
    writes: true,
    run: async () => {
      // Proof the guard runs before this: a blocked write never gets here,
      // and a command with a spool branch has its branch called instead.
      console.log('RAN');
      return { ok: true, data: { wrote: true } };
    },
    spool: async (context) => ({
      ok: true,
      data: {
        spooled: true,
        cause: context.cause,
        said: context.message !== '',
        // No brain, no store, no config: the branch is handed none of them,
        // so a mismatched database is unreachable by construction.
        keys: Object.keys(context).sort(),
      },
      warnings: ['SPOOLED', context.cause],
    }),
  },
  {
    ns: 'fake',
    verb: 'read-fails',
    ...meta('fake', 'read-fails', 'a database command that ran and failed'),
    run: async () => ({ ok: false, code: 'SEARCH_FAILED', message: 'nothing came back' }),
  },
  {
    ns: 'fake',
    verb: 'read-degraded',
    ...meta('fake', 'read-degraded', 'a database command that ran and came back degraded'),
    run: async () => ({ ok: true, data: { partial: true }, failed: true }),
  },
  {
    ns: 'fake',
    verb: 'no-drain',
    ...meta('fake', 'no-drain', 'a database command that turned the drain off'),
    drain: false,
    run: async () => ({ ok: true, data: { read: true }, text: ['read ok'] }),
  },
  {
    ns: 'fake',
    verb: 'read-arg',
    ...meta('fake', 'read-arg', 'a read command with a positional argument'),
    arguments: ['<name>', '[extra]'],
    run: async (context) => ({ ok: true, data: { args: context.args } }),
  },
  {
    ns: 'fake',
    verb: 'standalone',
    ...meta('fake', 'standalone', 'a command that runs before there is any configuration'),
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
    ...meta('fake', 'standalone-fails', 'a standalone command that could not run'),
    standalone: true,
    run: async () => ({ ok: false, code: 'SHIM_MISSING', message: 'no shim', exit: 1 }),
  },
  {
    ns: 'fake',
    verb: 'standalone-warns-and-fails',
    ...meta('fake', 'standalone-warns-and-fails', 'a standalone command that warned, then failed'),
    standalone: true,
    run: async () => ({
      ok: false,
      code: 'SHIM_MISSING',
      message: 'no shim',
      exit: 1,
      warnings: ['CONFIG_UNKNOWN_KEY'],
    }),
  },
  {
    ns: 'fake',
    verb: 'hook-throw',
    ...meta('fake', 'hook-throw', 'a hook command that throws'),
    hook: true,
    run: async () => {
      throw new Error('the hook blew up');
    },
  },
  {
    ns: 'fake',
    verb: 'hook-write',
    ...meta('fake', 'hook-write', 'a hook command that writes'),
    hook: true,
    writes: true,
    run: async () => ({ ok: true, data: { wrote: true } }),
  },
  {
    ns: 'fake',
    verb: 'hook-read',
    ...meta('fake', 'hook-read', 'a hook command that succeeds'),
    hook: true,
    run: async () => ({ ok: true, data: { read: true }, text: ['hook ok'] }),
  },
  {
    ns: 'fake',
    verb: 'hook-degraded',
    ...meta('fake', 'hook-degraded', 'a hook command that ran and came back degraded'),
    hook: true,
    run: async () => ({
      ok: true,
      data: { partial: true },
      warnings: ['RESULT_TRUNCATED'],
      text: ['degraded but useful'],
      failed: true,
    }),
  },
  {
    ns: 'fake',
    verb: 'gated',
    ...meta('fake', 'gated', 'a command that may not run without the consent of a person'),
    standalone: true,
    arguments: ['<id>'],
    options: [
      { flags: '--reason <reason>', description: 'why this is being done' },
      { flags: '-y, --yes', description: 'agree in advance' },
    ],
    run: async (context) => {
      // What the caller actually gave, which is what the retry has to ask for
      // back: not a default, and not the output flag.
      const args = { id: context.args[0] };
      if (typeof context.options.reason === 'string') args.reason = context.options.reason;
      if (context.options.yes === true) args.confirm = true;

      const gate = requireConfirmation({ ns: 'fake', verb: 'gated', args });
      if (gate !== undefined) return { ok: false, ...gate };
      // Proof the gate runs before this: a refused call never gets here.
      console.log('RAN');
      return { ok: true, data: { id: args.id } };
    },
  },
  {
    ns: 'fake',
    verb: 'hook-gated',
    ...meta('fake', 'hook-gated', 'a hook command that runs into the same gate'),
    standalone: true,
    hook: true,
    run: async () => {
      const gate = requireConfirmation({ ns: 'fake', verb: 'hook-gated', args: {} });
      if (gate !== undefined) return { ok: false, ...gate };
      return { ok: true, data: { ran: true } };
    },
  },
  {
    ns: 'fake',
    verb: 'locked',
    ...meta('fake', 'locked', 'a command that failed on something worth running again'),
    standalone: true,
    run: async () => ({ ok: false, code: 'DB_LOCKED', message: 'database is locked' }),
  },
  {
    ns: 'fake',
    verb: 'connector-fails',
    ...meta('fake', 'connector-fails', 'a command whose failure carries a code no table knows'),
    standalone: true,
    run: async () => ({
      ok: false,
      code: 'CLAUDE_CODE_SETTINGS_UNREADABLE',
      message: 'settings.json could not be parsed',
    }),
  },
  {
    ns: 'fake',
    verb: 'meta',
    ...meta('fake', 'meta', 'a command with something to say about its own result'),
    standalone: true,
    run: async () => ({
      ok: true,
      data: { rows: [] },
      meta: { count: 0, has_more: false },
    }),
  },
  {
    ns: 'fake',
    verb: 'diagnostic',
    ...meta('fake', 'diagnostic', 'a command that runs without a configuration, as doctor does'),
    diagnostic: true,
    run: async (context) => {
      const report = await context.brain.doctor.run();
      return {
        ok: true,
        data: {
          // Undefined is the whole point: this command ran without one.
          config: context.config ?? null,
          checks: report.checks.map((check) => check.id + ':' + check.status),
        },
        failed: report.checks.some((check) => check.status === 'fail'),
      };
    },
  },
];
`;

function runDispatch(args: string[], env: Record<string, string | undefined>): Promise<Run> {
  const script = [
    `const { dispatch } = await import(${JSON.stringify(dispatchModule)});`,
    `const { systemClock } = await import(${JSON.stringify(clockModule)});`,
    `const { requireConfirmation } = await import(${JSON.stringify(envelopeModule)});`,
    REGISTRY,
    // The handler the opportunistic drain gets, only when a test named a file
    // for it to append to: every real invocation of this build has none
    // (AD-21), so the seam is what lets these tests watch the drain at all.
    `const log = process.env.DRAIN_LOG;`,
    `const workHandlers = log === undefined ? {} : {`,
    `  demo_work: async (item) => {`,
    `    (await import('node:fs')).appendFileSync(log, item.id + '\\n');`,
    `    return { ok: true };`,
    `  },`,
    `};`,
    // With `node -e`, `process.argv[1]` is already the first user argument.
    'process.exitCode = await dispatch(registry, process.argv.slice(1), { clock: systemClock, workHandlers });',
  ].join('\n');

  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders(process.env);
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

const temporary = tempHomes();

async function scratch(): Promise<string> {
  const home = await temporary.create('brain-dispatch-');
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

afterEach(() => temporary.cleanup());

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

    // Exit 2, as the code table says for `DB_UNAVAILABLE`: the command could
    // not run at all (Conventions, 종료 코드). A command whose write can wait
    // declares `spool` instead and is not refused at all.
    expect(run.code).toBe(2);
    expect(elapsed).toBeLessThan(5000);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('DB_UNAVAILABLE');
    expect(envelope.error?.exit_code).toBe(2);
    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE']);
    // A runtime command opens the file and never creates it (AD-20).
    expect(existsSync(path)).toBe(false);
  });

  it('calls the spool branch instead of run when the version does not match', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'write-spool', '--json'], { [HOME_ENV]: home });

    // A success, and `run` was never called: a mismatched database is
    // unreachable by construction rather than by care (AD-9, AD-20).
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['SPOOLED', 'SCHEMA_MISMATCH']);
    expect(envelope.data).toEqual({
      spooled: true,
      cause: 'SCHEMA_MISMATCH',
      said: true,
      // The invocation, why the database is out of reach, and the one function
      // that writes the mark — and nothing else. No `brain`, no `config`.
      keys: ['args', 'cause', 'clock', 'message', 'options', 'recordHookArrival', 'spoolIngest', 'stdin'],
    });
  });

  it('calls the spool branch, and makes no file, when there is no database', async () => {
    const path = await missingDatabase();
    const home = await homeFor(path);

    const run = await runDispatch(['fake', 'write-spool', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['SPOOLED', 'DB_UNAVAILABLE']);
    expect(envelope.data).toMatchObject({ cause: 'DB_UNAVAILABLE' });
    // Still nothing created: the spool branch has no store to open (AD-20).
    expect(existsSync(path)).toBe(false);
  });

  it('runs the command itself when the version matches, spool branch or not', async () => {
    const home = await homeFor(await migratedDatabase());

    const run = await runDispatch(['fake', 'write-spool', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('RAN');
    const envelope = JSON.parse(run.stdout.split('\n')[1] ?? '{}') as Envelope;
    expect(envelope.data).toEqual({ wrote: true });
    expect(envelope.warnings).toEqual([]);
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
      // No brain and no config, and `stdin` is a function it never called:
      // a standalone command that does not read a hook payload must not wait
      // on a pipe nobody is writing to.
      keys: ['args', 'clock', 'env', 'options', 'recordHookArrival', 'stdin'],
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

  it('carries the warnings it collected before it failed', async () => {
    const run = await runDispatch(['fake', 'standalone-warns-and-fails', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    // A code collected before the failure is still a code the caller has to
    // see: `brain setup run` over a configuration with an unknown key says so
    // whether or not the install then got as far as finishing (NFR-2).
    expect(envelope.warnings).toEqual(['CONFIG_UNKNOWN_KEY']);
  });

  it('prints the warning line of a failure on stderr too, as a result does', async () => {
    const run = await runDispatch(['fake', 'standalone-warns-and-fails'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('SHIM_MISSING: no shim');
    expect(run.stderr).toContain('경고: CONFIG_UNKNOWN_KEY');
  });

  it('answers USAGE when a required argument is missing', async () => {
    const run = await runDispatch(['fake', 'standalone', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    // The Korean sentence the code table chose, with commander's own quoted
    // value kept: the argument it named is the fact worth carrying over.
    expect(envelope.error?.message).toContain('반드시 주어야 하는 인자가 빠졌습니다');
    expect(envelope.error?.message).toContain("'name'");
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

  /**
   * Every positional argument of this CLI is an id — a body arrives on stdin,
   * never as an argument — so an empty one or one carrying control characters
   * can only be a broken command line. The check is in the dispatcher because
   * it has to hold for every command without each one remembering it.
   */
  it.each([
    ['an empty one', ''],
    ['one that is only spaces', '   '],
    ['one that is only a tab', '\t'],
  ])('answers USAGE and names the argument for %s', async (_what, value) => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read-arg', value, '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    // Named, so the caller knows which of two arguments came back empty — which
    // is nearly always a shell capture that produced nothing.
    expect(envelope.error?.message).toContain('name');
  });

  it.each([
    ['a C0 control', 'one\u0001two'],
    ['an escape', '\u001b[31mred'],
    ['a delete', 'one\u007ftwo'],
    ['a C1 control', 'one\u0085two'],
    ['a zero-width space', 'one\u200btwo'],
    ['a zero-width joiner', 'one\u200dtwo'],
    ['a byte-order mark', 'one\ufefftwo'],
    ['a line separator', 'one\u2028two'],
    ['a paragraph separator', 'one\u2029two'],
    ['a bidi override', 'one\u202etwo'],
    ['a bidi isolate', 'one\u2066two'],
  ])('answers USAGE for an argument carrying %s', async (_what, value) => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read-arg', value, '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
  });

  it('checks the optional argument too, not just the first one', async () => {
    const home = await homeFor(await emptyDatabase());

    const run = await runDispatch(['fake', 'read-arg', 'one', '', '--json'], { [HOME_ENV]: home });

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('extra');
  });

  it('refuses before it reads the configuration, so a broken home is beside the point', async () => {
    const run = await runDispatch(['fake', 'read-arg', '', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    // CONFIG_MISSING would be the answer if anything had been read; it is not,
    // because an argument that cannot be used is settled before that.
    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
  });

  it('lets through everything an id really contains', async () => {
    const home = await homeFor(await emptyDatabase());
    const id = '0199a0b1-2c3d-7e4f-8a9b-0c1d2e3f4a5b';

    const run = await runDispatch(['fake', 'read-arg', id, 'claude-code:abc', '--json'], {
      [HOME_ENV]: home,
    });

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).data).toEqual({
      args: [id, 'claude-code:abc'],
    });
  });
});

/**
 * Exit code 3 and the shape that goes with it: the gate is Core's, the argv is
 * this surface's, and the two have to agree about what the caller should run.
 */
describe('the dispatcher and a command that needs confirmation', () => {
  it('exits 3 with the call to run instead, and never runs the command', async () => {
    const run = await runDispatch(['fake', 'gated', 'm-1', '--reason', 'secret', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(3);
    expect(run.stdout).not.toContain('RAN');
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(envelope.error?.exit_code).toBe(3);
    expect(envelope.error?.retryable).toBe(false);
    expect(envelope.error?.hint).toBeTruthy();
    expect(envelope.error?.retry).toEqual({
      ns: 'fake',
      verb: 'gated',
      args: { id: 'm-1', reason: 'secret', confirm: true },
    });
    // The declared argument goes in bare and the rest as flags, because only
    // the registry knows which of the two a key is.
    expect(envelope.error?.retry_argv).toEqual([
      'brain',
      'fake',
      'gated',
      'm-1',
      '--reason',
      'secret',
      '--yes',
      '--json',
    ]);
  });

  it('selects the same command, with the same arguments, when that argv is run back', async () => {
    const refused = await runDispatch(['fake', 'gated', 'm-1', '--reason', 'secret', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });
    const argv = (JSON.parse(refused.stdout) as Envelope).error?.retry_argv ?? [];

    // `brain` is the binary this test is already running, so what is handed
    // back to the dispatcher is the rest of the line, unedited.
    const accepted = await runDispatch(argv.slice(1), { [HOME_ENV]: '/nonexistent/home' });

    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain('RAN');
    const envelope = JSON.parse(accepted.stdout.split('\n')[1] ?? '{}') as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ id: 'm-1' });
  });

  it('leaves the output choice of the caller out of the argv in text mode', async () => {
    const run = await runDispatch(['fake', 'gated', 'm-1'], { [HOME_ENV]: '/nonexistent/home' });

    expect(run.code).toBe(3);
    // Text mode prints the failure, not the envelope, so the argv is not on
    // screen — but it is still the argv a JSON caller would have been given.
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('CONFIRMATION_REQUIRED');
  });

  it('exits 0 on a hook path, with one line on stderr and nothing on stdout', async () => {
    // A gate on a hook path must not fail the harness turn, and must not do
    // the thing either: it says so on stderr and stops (AD-6, Conventions).
    const run = await runDispatch(['fake', 'hook-gated', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(run.stderr).toContain('CONFIRMATION_REQUIRED');
  });
});

/**
 * The envelope's `error.exit_code` is the number the process exited with, for
 * every failure there is: an agent that read one and got the other would have
 * to check the shell to find out which to believe.
 */
describe('the dispatcher and the exit code in the envelope', () => {
  it.each([
    ['fake', 'gated', 'm-1'],
    ['fake', 'locked'],
    ['fake', 'connector-fails'],
    ['fake', 'standalone-fails'],
    ['nope', 'verb'],
  ])('agrees with the process for `%s %s`', async (...words) => {
    const run = await runDispatch([...words, '--json'], { [HOME_ENV]: '/nonexistent/home' });

    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.exit_code).toBe(run.code);
  });

  it('fills a blank hint from the code table, and says a lock is worth retrying', async () => {
    const run = await runDispatch(['fake', 'locked', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.retryable).toBe(true);
    expect(envelope.error?.hint).toBeTruthy();
  });

  it('exits 1 and adds no hint for a code the table does not know', async () => {
    const run = await runDispatch(['fake', 'connector-fails', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    // A connector names its own codes, and guessing a hint for one would be
    // the dispatcher claiming to know what another package's failure means.
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error).toEqual({
      code: 'CLAUDE_CODE_SETTINGS_UNREADABLE',
      message: 'settings.json could not be parsed',
      exit_code: 1,
    });
  });

  it('carries the meta a command had to add, and nothing when it had none', async () => {
    const withMeta = await runDispatch(['fake', 'meta', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });
    const without = await runDispatch(['fake', 'standalone', 'x', '--json'], {
      [HOME_ENV]: '/nonexistent/home',
    });

    expect((JSON.parse(withMeta.stdout) as { meta?: unknown }).meta).toEqual({
      count: 0,
      has_more: false,
    });
    expect('meta' in (JSON.parse(without.stdout) as object)).toBe(false);
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

  it('runs a diagnostic command anyway, with no config and an unavailable store', async () => {
    const home = await scratch();

    const run = await runDispatch(['fake', 'diagnostic', '--json'], { [HOME_ENV]: home });

    // Exit 1, not 2: the command ran, and the result is a bad one. That is the
    // whole difference `diagnostic` makes (Decision 2026-10-14).
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeUndefined();

    const data = envelope.data as { config: unknown; checks: string[] };
    expect(data.config).toBeNull();
    // `db` says the configuration is why, and the machine checks ran too.
    expect(data.checks[0]).toBe('db:fail');
    expect(data.checks).toContain('config:fail');
    expect(data.checks).toContain('node-version:ok');
    // Turning a check's code into a warning is the command's own doing, and
    // this fake does not: there is nothing the dispatcher adds here.
    expect(envelope.warnings).toEqual([]);
  });

  it('creates nothing in the folder it could not read a configuration from', async () => {
    const home = await scratch();

    await runDispatch(['fake', 'diagnostic', '--json'], { [HOME_ENV]: home });

    expect(await readdir(home)).toEqual([]);
  });
});

/**
 * The opportunistic drain of AD-7: the run at the end of an ordinary command,
 * which is the one moment a harness without hooks gets its backlog worked at
 * all.
 *
 * Nothing about it may reach the command's own answer, so every case here looks
 * at two things — whether the item was handled, and whether the envelope and
 * the exit code are what they are without a drain.
 */
describe('the dispatcher and the drain at the end of a command', () => {
  /** One item of `demo_work`, due now, as a drain would find it. */
  function seedWork(path: string, id: string): void {
    const database = new DatabaseSync(path);
    try {
      const now = new Date().toISOString();
      database
        .prepare(
          `insert into work_items (id, kind, target_kind, target_id, created_at,
                                   attempts, next_attempt_at)
                values (?, 'demo_work', 'session', ?, ?, 0, ?)`,
        )
        .run(id, `demo:${id}`, now, now);
    } finally {
      database.close();
    }
  }

  /** Whether the one item is closed, and by whom nothing is holding it. */
  function closed(path: string, id: string): boolean {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare('select completed_at from work_items where id = ?').get(id) as
        | { completed_at: string | null }
        | undefined;
      return row?.completed_at !== null && row?.completed_at !== undefined;
    } finally {
      database.close();
    }
  }

  const ITEM = '01940000-0000-7000-8000-000000000031';

  it('works the backlog after an ordinary command', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);

    const run = await runDispatch(['fake', 'read', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    expect(run.code).toBe(0);
    // The command's own answer, unchanged: the drain adds no warning, no field
    // and no exit code of its own.
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ read: true });
    expect(envelope.warnings).toEqual([]);
    expect(run.stderr).toBe('');

    expect(await readFile(log, 'utf8')).toBe(`${ITEM}\n`);
    expect(closed(path, ITEM)).toBe(true);
  });

  it('answers exactly what it answers without a drain', async () => {
    const withDrain = await (async () => {
      const path = await migratedDatabase();
      seedWork(path, ITEM);
      return runDispatch(['fake', 'read', '--json'], {
        [HOME_ENV]: await homeFor(path),
        DRAIN_LOG: join(await scratch(), 'handled.log'),
      });
    })();
    const without = await runDispatch(['fake', 'read', '--json'], {
      [HOME_ENV]: await homeFor(await migratedDatabase()),
    });

    expect(withDrain.code).toBe(without.code);
    const left = JSON.parse(withDrain.stdout) as Envelope;
    const right = JSON.parse(without.stdout) as Envelope;
    // `now` is the one field that differs, because it is this invocation's.
    expect({ ...left, now: '' }).toEqual({ ...right, now: '' });
  });

  it('does not run on a hook path', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);

    const run = await runDispatch(['fake', 'hook-read', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    // A turn is somebody waiting, and the drain's budget is time taken from
    // them (AD-6, AD-7).
    expect(run.code).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(closed(path, ITEM)).toBe(false);
  });

  it('does not run after a command that failed', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);

    const run = await runDispatch(['fake', 'read-fails', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    // A command that failed may have failed because of the database, and a
    // drain right after it would be a second write into the same problem.
    expect(run.code).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(closed(path, ITEM)).toBe(false);
  });

  it('does not run after a command whose own result is a failure', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);

    // `ok: true, failed: true` is exactly what `doctor run` answers when a
    // check fails: the command ran, and its answer is that this brain is
    // broken. A drain right after it would write into that brain.
    const run = await runDispatch(['fake', 'read-degraded', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as Envelope).ok).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(closed(path, ITEM)).toBe(false);
  });

  it('does not run after a command that turned it off', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);

    const run = await runDispatch(['fake', 'no-drain', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    expect(run.code).toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(closed(path, ITEM)).toBe(false);
  });

  it('does not run on a database at another schema version', async () => {
    const path = await migratedDatabase();
    const home = await homeFor(path);
    const log = join(await scratch(), 'handled.log');
    seedWork(path, ITEM);
    const database = new DatabaseSync(path);
    try {
      database.exec('update schema_version set version = 2');
    } finally {
      database.close();
    }

    // A read is not guarded, so the command itself succeeds — and the drain
    // behind it still must not write to a mismatched database (AD-20).
    const run = await runDispatch(['fake', 'read', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as Envelope).ok).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(closed(path, ITEM)).toBe(false);
  });

  it('does not run without a configuration, and creates nothing', async () => {
    const home = await scratch();
    const log = join(await scratch(), 'handled.log');

    const run = await runDispatch(['fake', 'diagnostic', '--json'], {
      [HOME_ENV]: home,
      DRAIN_LOG: log,
    });

    // The store a `diagnostic` command gets answers `DB_UNAVAILABLE` to
    // everything; the drain is skipped before it can ask (AD-20).
    expect(run.code).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });
});

/**
 * The lock budget of AD-7 is a choice the dispatcher makes before it opens
 * anything, so these run in process with a store creator of their own: the fake
 * records the options it was handed and opens nothing at all. The subprocess
 * tests above cannot see this, which is why the seam exists.
 */
describe('the dispatcher and the lock budget', () => {
  /** A store that opens no file and remembers how it was asked for. */
  function recorder(): { calls: SqliteStoreOptions[]; createStore: CreateStore } {
    const calls: SqliteStoreOptions[] = [];
    const createStore: CreateStore = (options) => {
      calls.push(options);
      const unavailable = {
        ok: false as const,
        code: 'DB_UNAVAILABLE' as const,
        message: 'the budget tests never open a database',
      };
      // The whole `Store`, because that is what `createBrain` takes: these
      // tests are about the lock budget, so every capability answers the same
      // way and none of them is reached.
      const store: Store & SchemaStore = {
        async listMissingFileNames() { return unavailable; },
        async writeFileNames() { return unavailable; },
        async listFileNames() { return unavailable; },
        async linkAttachments() { return unavailable; },
        async listMessageAttachments() { return unavailable; },
        async readFileLocation() { return unavailable; },
        async listFileLocations() { return unavailable; },
        async markFileLocationDeleted() { return unavailable; },
        async beginExtraction() { return unavailable; },
        async appendExtractionChunks() { return unavailable; },
        async finishExtraction() { return unavailable; },
        async setFileSourceUnreachable() { return unavailable; },
        async readFileExtractionState() { return unavailable; },
        async listFilesAwaitingExtraction() { return unavailable; },
        async listFilesWithStaleExtraction() { return unavailable; },
        async listExtractions() { return unavailable; },
        async listExtractionChunks() { return unavailable; },
        async checkHealth() {
          return unavailable;
        },
        async readSchemaVersion() {
          return unavailable;
        },
        async ensureSelfUser() {
          return unavailable;
        },
        async readSelfUser() {
          return unavailable;
        },
        async redactMessage() {
          return unavailable;
        },
        async countUntaggedSessions() { return unavailable; },
        async listStaleSessions() { return unavailable; },
        async listIdentityCandidates() { return unavailable; },
        async fillSessionTags() {
          return unavailable;
        },
        async ensureSession() {
          return unavailable;
        },
        async findSession() {
          return unavailable;
        },
        async ingest() {
          return unavailable;
        },
        async readSession() {
          return unavailable;
        },
        async addWork() {
          return unavailable;
        },
        async hasDueWork() {
          return unavailable;
        },
        async claimWork() {
          return unavailable;
        },
        async completeWork() {
          return unavailable;
        },
        async retryWork() {
          return unavailable;
        },
        async releaseWork() {
          return unavailable;
        },
        async recordFailure() {
          return unavailable;
        },
        async listOpenWorkTargets() {
          return unavailable;
        },
        async listFailures() {
          return unavailable;
        },
        async resolveFailures() {
          return unavailable;
        },
        async listTranscriptFiles() {
          return unavailable;
        },
        async recordTranscriptFile() {
          return unavailable;
        },
        async close() {
          // Nothing was ever opened.
        },
      };
      return store;
    };
    return { calls, createStore };
  }

  /** The seven mandatory fields, for a fake these tests do not vary them on. */
  function meta(ns: string, verb: string, usedFor: string): CommandMeta {
    return {
      usedFor,
      required: [],
      examples: [`brain ${ns} ${verb}`],
      output: 'whatever this fake answers with',
      risk: 'read',
      hook: false,
      dryRun: false,
    };
  }

  const registry: readonly CommandSpec[] = [
    {
      ns: 'fake',
      verb: 'hook-read',
      ...meta('fake', 'hook-read', 'a hook command on the critical path of a turn'),
      hook: true,
      run: async () => ({ ok: true, data: { read: true } }),
    },
    {
      ns: 'fake',
      verb: 'read',
      ...meta('fake', 'read', 'a command the person ran and is watching'),
      run: async () => ({ ok: true, data: { read: true } }),
    },
  ];

  /** One in-process invocation against the recording store. */
  async function run(
    argv: readonly string[],
    home: string,
  ): Promise<{ exit: number; calls: SqliteStoreOptions[] }> {
    const { calls, createStore } = recorder();
    const exit = await dispatch(registry, argv, {
      clock: systemClock,
      env: withoutHarnessFolders({ [HOME_ENV]: home }),
      // The envelope has its own tests; nothing here should reach the console.
      stdout: () => {},
      stderr: () => {},
      createStore,
    });
    return { exit, calls };
  }

  it('gives a hook command the shorter turn budget', async () => {
    const path = await missingDatabase();
    const home = await homeFor(path);

    // No exit code in here: a hook command returns 0 whatever happens (AD-6),
    // so asserting it would assert nothing.
    const { calls } = await run(['fake', 'hook-read', '--json'], home);

    expect(calls).toEqual([{ path, busyTimeoutMs: BUSY_TIMEOUT_MS.turn }]);
  });

  it('gives any other command the command budget, and the drain behind it its own', async () => {
    const path = await missingDatabase();
    const home = await homeFor(path);

    const { exit, calls } = await run(['fake', 'read', '--json'], home);

    expect(exit).toBe(0);
    expect(calls).toEqual([
      { path, busyTimeoutMs: BUSY_TIMEOUT_MS.command },
      // The drain at the end of a successful command opens a connection of its
      // own, and the reason is the budget: the command's store waits ten
      // seconds for the write lock, and the drain may only spend two. Its own
      // store waits its own budget and no longer (AD-7).
      { path, busyTimeoutMs: DRAIN_BUDGET_MS.opportunistic },
    ]);
  });

  it('makes no database file with nothing injected, as the default store must not', async () => {
    // No `createStore`: the default is the real one, which refuses a file that
    // is not there rather than making one (AD-20).
    const path = await missingDatabase();
    const home = await homeFor(path);

    const exit = await dispatch(registry, ['fake', 'read', '--json'], {
      clock: systemClock,
      env: withoutHarnessFolders({ [HOME_ENV]: home }),
      stdout: () => {},
      stderr: () => {},
    });

    expect(exit).toBe(0);
    expect(existsSync(path)).toBe(false);
  });
});

it('keeps --version as USAGE, exit 2, without writing home', async () => {
  const home = await scratch();
  await writeFile(join(home, 'sentinel'), 'unchanged');
  const result = await runDispatch(['--version', '--json'], { [HOME_ENV]: home });
  expect(result.code).toBe(2);
  expect((JSON.parse(result.stdout) as Envelope).error?.code).toBe('USAGE');
  expect(await readdir(home)).toEqual(['sentinel']);
  expect(await readFile(join(home, 'sentinel'), 'utf8')).toBe('unchanged');
});
