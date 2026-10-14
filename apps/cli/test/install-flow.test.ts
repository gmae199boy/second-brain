import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Connector, DoctorReport, SqliteMigrationResult } from 'second_brain';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
import type { WriteConfigInput } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import {
  parseFlags,
  runInstall,
  runInstallFlow,
  type Choice,
  type InstallDeps,
  type InstallFiles,
  type InstallPrompts,
  type InstallStore,
  type RecordedConfig,
} from '../src/install/flow.js';
import { shimPath } from '../src/install/shim.js';

/**
 * The whole installer flow against fakes: no terminal, no filesystem, no
 * database. Every row of the plan's I/O matrix is one test here, and what is
 * asserted is which questions were asked, what was written, which paths were
 * prepared, and the exit code.
 */

const HOME = '/tmp/brain-install-flow';
const ENV: NodeJS.ProcessEnv = { [HOME_ENV]: HOME };

/** The three paths a run with nothing recorded and no flag settles on. */
const STORE = join(HOME, 'brain.db');
const FILES = join(HOME, 'files');
const MIRROR = join(HOME, 'mirror');

/**
 * What the codec must be handed every time: all four values, because
 * `writeConfig` renders both files whole and anything left out goes back to its
 * default. A run with nothing recorded passes no time zone, which is the one
 * value that has a default of its own rather than a question.
 */
function fresh(storePath = STORE, filesPath = FILES, mirrorPath = MIRROR): WriteConfigInput {
  return { timezone: undefined, storePath, filesPath, mirrorPath };
}

/** The same, over a folder that already said something. */
function kept(
  timezone = 'Asia/Seoul',
  storePath = STORE,
  filesPath = FILES,
  mirrorPath = MIRROR,
): WriteConfigInput {
  return { timezone, storePath, filesPath, mirrorPath };
}

/**
 * What a run answers to the two questions every path now ends with: Enter for
 * the database file, Enter for the mirror path — both take the default — and no
 * to embeddings. They are appended to whatever a test queues, so a test that
 * cares about none of them says nothing about them; the per-kind queues keep
 * the order right either way.
 */
const TAIL: Answers = { text: ['', ''], confirm: [false] };

function answersWith(own: Answers, tail: Answers): Answers {
  return {
    confirm: [...(own.confirm ?? []), ...(tail.confirm ?? [])],
    text: [...(own.text ?? []), ...(tail.text ?? [])],
    multiselect: [...(own.multiselect ?? []), ...(tail.multiselect ?? [])],
  };
}

interface Answers {
  confirm?: readonly boolean[];
  text?: readonly string[];
  /** One answer per `multiselect`: the values that stayed checked. */
  multiselect?: readonly (readonly string[])[];
}

interface Prompts extends InstallPrompts {
  asked: string[];
  /** The placeholder each `text` question offered, so a default is checkable. */
  placeholders: string[];
  /** What each `multiselect` started out with checked. */
  checked: readonly string[][];
}

/**
 * Questions with their answers queued up. Running out throws rather than
 * blocks, so a flow that asks in a loop fails the test instead of hanging.
 */
function fakePrompts(answers: Answers): Prompts {
  const confirms = [...(answers.confirm ?? [])];
  const texts = [...(answers.text ?? [])];
  const multiselects = [...(answers.multiselect ?? [])];
  const asked: string[] = [];
  const placeholders: string[] = [];
  const checked: string[][] = [];

  return {
    asked,
    placeholders,
    checked,
    async confirm(question: string): Promise<boolean> {
      asked.push(question);
      const answer = confirms.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer;
    },
    async text(question: string, placeholder: string): Promise<string> {
      asked.push(question);
      placeholders.push(placeholder);
      const answer = texts.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer;
    },
    async multiselect<T extends string>(
      question: string,
      _choices: readonly Choice<T>[],
      initial: readonly T[],
    ): Promise<readonly T[]> {
      asked.push(question);
      checked.push([...initial]);
      const answer = multiselects.shift();
      if (answer === undefined) throw new Error(`no answer queued for: ${question}`);
      return answer as readonly T[];
    },
  };
}

interface StoreWorld {
  /** What `prepare` answers. A fresh install by default. */
  prepare?: SqliteMigrationResult;
  /** Doctor's own verdict on the file. */
  walFails?: boolean;
}

interface Store extends InstallStore {
  /** Every path prepared, in order. */
  prepared: string[];
  doctored: string[];
  /** Every home doctor was pointed at, in order. */
  doctoredHomes: string[];
}

function fakeStore(world: StoreWorld = {}): Store {
  const prepared: string[] = [];
  const doctored: string[] = [];
  const doctoredHomes: string[] = [];

  return {
    prepared,
    doctored,
    doctoredHomes,
    async prepare(path) {
      prepared.push(path);
      return (
        world.prepare ?? {
          ok: true,
          from: 0,
          to: 2,
          applied: ['0001_initial.sql', '0002_files_and_work.sql'],
        }
      );
    },
    async doctor(home, path): Promise<DoctorReport> {
      doctoredHomes.push(home);
      doctored.push(path);
      return {
        checks: [
          { id: 'db', status: 'ok', detail: '3.50.4' },
          { id: 'writable', status: 'ok', detail: 'the file took a write and gave it back' },
          world.walFails === true
            ? { id: 'wal', status: 'fail', detail: 'journal_mode is delete, not wal' }
            : { id: 'wal', status: 'ok', detail: 'wal' },
          { id: 'fts5-trigram', status: 'ok', detail: 'fts5 with the trigram tokenizer' },
          { id: 'foreign-keys', status: 'ok', detail: 'enforced on this connection' },
          { id: 'schema-version', status: 'ok', detail: '2' },
          { id: 'config', status: 'ok', detail: join(home, 'config.toml') },
          { id: 'shim', status: 'ok', detail: shimPath(home) },
          { id: 'node-path', status: 'ok', detail: 'node 24.16.0 at /usr/bin/node' },
          { id: 'node-version', status: 'ok', detail: 'node 24.16.0' },
        ],
      };
    },
  };
}

interface Files extends InstallFiles {
  /** Every root prepared, in order. */
  prepared: string[];
}

function fakeFiles(created = true, fails = false): Files {
  const prepared: string[] = [];
  return {
    prepared,
    async prepare(path) {
      prepared.push(path);
      if (fails) {
        return {
          ok: false,
          code: 'FILES_UNAVAILABLE',
          message: 'EEXIST: file already exists',
        };
      }
      return { ok: true, path, created };
    },
  };
}

interface Harness {
  deps: InstallDeps;
  prompts: Prompts;
  store: Store;
  files: Files;
  written: WriteConfigInput[];
  lines: string[];
  /** Every home the shim was written for, in order. */
  shimmed: string[];
  output(): string;
}

interface HarnessOptions {
  answers?: Answers;
  /** Replaces the answers every path ends with, for a test about them. */
  tail?: Answers;
  store?: StoreWorld;
  /** Whether the file store's root was made by this run. */
  filesCreated?: boolean;
  /** The root cannot be made at all: something else is already in the way. */
  filesFails?: boolean;
  isTTY?: boolean;
  /** The folder already holds a readable configuration. */
  recorded?: boolean;
  recordedTimezone?: string;
  recordedStorePath?: string;
  recordedFilesPath?: string;
  recordedMirrorPath?: string;
  /** The registry. Empty, like the real one, unless a test fills it. */
  connectors?: readonly Connector[];
  /** The shim was already there and says exactly this. */
  shimCurrent?: boolean;
}

function harness(options: HarnessOptions = {}): Harness {
  const prompts = fakePrompts(answersWith(options.answers ?? {}, options.tail ?? TAIL));
  const shimmed: string[] = [];
  const store = fakeStore(options.store);
  const files = fakeFiles(options.filesCreated ?? true, options.filesFails ?? false);
  const written: WriteConfigInput[] = [];
  const lines: string[] = [];
  const recorded =
    options.recorded === true ||
    options.recordedTimezone !== undefined ||
    options.recordedStorePath !== undefined ||
    options.recordedFilesPath !== undefined ||
    options.recordedMirrorPath !== undefined;

  const deps: InstallDeps = {
    prompts,
    isTTY: options.isTTY ?? true,
    log: (line: string): void => {
      lines.push(line);
    },
    config: {
      write: async (home, input): Promise<void> => {
        expect(home).toBe(HOME);
        written.push(input);
      },
      read: async (): Promise<RecordedConfig | undefined> =>
        recorded
          ? {
              timezone: options.recordedTimezone ?? 'Asia/Seoul',
              storePath: options.recordedStorePath ?? STORE,
              filesPath: options.recordedFilesPath ?? FILES,
              mirrorPath: options.recordedMirrorPath ?? MIRROR,
            }
          : undefined,
    },
    store,
    files,
    shim: {
      write: async (home: string): Promise<{ path: string; changed: boolean }> => {
        shimmed.push(home);
        return { path: shimPath(home), changed: options.shimCurrent !== true };
      },
    },
    connectors: options.connectors ?? [],
  };

  return {
    deps,
    prompts,
    store,
    files,
    written,
    lines,
    shimmed,
    output: () => lines.join('\n'),
  };
}

describe('the installer flow on an empty folder', () => {
  it('asks the two path questions, writes everything, and ends on a green doctor', async () => {
    const kit = harness();

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      'Where should the database file go?',
      'Where should the mirror go?',
      'Turn embeddings on?',
    ]);
    expect(kit.prompts.placeholders).toEqual([STORE, MIRROR]);
    expect(kit.written).toEqual([fresh()]);
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.files.prepared).toEqual([FILES]);
    expect(kit.shimmed).toEqual([HOME]);
    expect(kit.store.doctored).toEqual([STORE]);
    // The machine checks are about the home, not the database file, so doctor
    // has to be told both (story 8).
    expect(kit.store.doctoredHomes).toEqual([HOME]);
    for (const id of [
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
    ]) {
      expect(kit.output()).toContain(`${id}: ok`);
    }
  });

  it('runs the steps in AD-19 order: config, store, files, shim, doctor', async () => {
    const order: string[] = [];
    const kit = harness();
    const { config, store, files, shim } = kit.deps;
    const deps: InstallDeps = {
      ...kit.deps,
      config: {
        read: config.read,
        write: async (home, input) => {
          order.push('config');
          await config.write(home, input);
        },
      },
      store: {
        prepare: async (path) => {
          order.push('store');
          return store.prepare(path);
        },
        doctor: async (home, path) => {
          order.push('doctor');
          return store.doctor(home, path);
        },
      },
      files: {
        prepare: async (path) => {
          order.push('files');
          return files.prepare(path);
        },
      },
      shim: {
        write: async (home) => {
          order.push('shim');
          return shim.write(home);
        },
      },
    };

    expect(await runInstallFlow([], ENV, deps)).toBe(0);
    expect(order).toEqual(['config', 'store', 'files', 'shim', 'doctor']);
  });

  it('says what the migrations applied, and the modes it left behind', async () => {
    const kit = harness();

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.output()).toContain('applied 0001_initial.sql, 0002_files_and_work.sql');
    expect(kit.output()).toContain('schema version 2');
    expect(kit.output()).toContain(`created ${FILES} (mode 0700)`);
    expect(kit.output()).toContain(`wrote ${shimPath(HOME)} (mode 0755)`);
  });

  it('exits 1 when doctor fails a check, having finished every step', async () => {
    const kit = harness({ store: { walFails: true } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('wal: fail');
    expect(kit.shimmed).toEqual([HOME]);
  });
});

describe('the installer flow and the database file', () => {
  it('records the absolute path the answer named', async () => {
    const kit = harness({ tail: { text: ['/tmp/notes/brain.db', ''], confirm: [false] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
    expect(kit.store.prepared).toEqual(['/tmp/notes/brain.db']);
  });

  it('expands a leading ~, which no shell expanded for a typed answer', async () => {
    const kit = harness({ tail: { text: ['~/notes/brain.db', ''], confirm: [false] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(join(homedir(), 'notes/brain.db'))]);
  });

  it('expands a leading ~ on the flag too, and never asks about it', async () => {
    const kit = harness({ tail: { text: [''], confirm: [false] } });

    const exit = await runInstallFlow(['--store-path', '~/notes/brain.db'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual(['Where should the mirror go?', 'Turn embeddings on?']);
    expect(kit.written).toEqual([fresh(join(homedir(), 'notes/brain.db'))]);
  });

  it('asks again after a relative answer, and takes the next one', async () => {
    const kit = harness({
      tail: { text: ['notes/brain.db', '/tmp/notes/brain.db', ''], confirm: [false] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('CONFIG_INVALID');
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
  });

  it('asks again after a relative flag when there is a terminal to ask in', async () => {
    const kit = harness({ tail: { text: ['/tmp/notes/brain.db', ''], confirm: [false] } });

    const exit = await runInstallFlow(['--store-path', 'brain.db'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('CONFIG_INVALID: --store-path brain.db');
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
  });

  it('gives up after three relative answers and writes nothing', async () => {
    const kit = harness({ tail: { text: ['a', 'b', 'c'] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('No usable database file path in 3 attempts');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('exits 2 without writing for a relative flag and no terminal to ask in', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(['--store-path', 'brain.db', '--yes'], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: --store-path brain.db');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('offers the recorded path as the default, and keeps it on Enter', async () => {
    const kit = harness({ recordedStorePath: '/tmp/notes/brain.db' });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[0]).toBe('/tmp/notes/brain.db');
    expect(kit.written).toEqual([kept('Asia/Seoul', '/tmp/notes/brain.db')]);
  });

  it('keeps the recorded path without asking when there is no terminal', async () => {
    const kit = harness({ isTTY: false, recordedStorePath: '/tmp/notes/brain.db' });

    const exit = await runInstallFlow(['--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([kept('Asia/Seoul', '/tmp/notes/brain.db')]);
  });

  it('says the old file is still there when a re-run picks another path', async () => {
    const kit = harness({
      recordedStorePath: '/tmp/notes/brain.db',
      tail: { text: ['/tmp/elsewhere/brain.db', ''], confirm: [false] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('/tmp/notes/brain.db is left where it is');
    expect(kit.output()).toContain('nothing was moved or removed');
    expect(kit.store.prepared).toEqual(['/tmp/elsewhere/brain.db']);
  });

  it('says nothing about an old file when the path did not change', async () => {
    const kit = harness({ recorded: true });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.output()).not.toContain('is left where it is');
  });
});

describe('the installer flow and the file store', () => {
  it('prepares the default root, which nothing asks about', async () => {
    const kit = harness();

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.files.prepared).toEqual([FILES]);
    expect(kit.prompts.asked).not.toContain('Where should the files go?');
  });

  it('keeps a recorded root rather than resetting it to the default', async () => {
    const kit = harness({ recordedFilesPath: '/tmp/notes/files' });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept('Asia/Seoul', STORE, '/tmp/notes/files')]);
    expect(kit.files.prepared).toEqual(['/tmp/notes/files']);
  });

  it('reports a root it could not make in one line, and skips the shim and doctor', async () => {
    const kit = harness({ filesFails: true });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('FILES_UNAVAILABLE: EEXIST: file already exists');
    // The store was already prepared; the shim and doctor are not reached.
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('says the root was already there rather than claiming it made one', async () => {
    const kit = harness({ filesCreated: false });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.output()).toContain(`${FILES} is already there (mode 0700)`);
    expect(kit.output()).not.toContain(`created ${FILES}`);
  });
});

describe('the installer flow run a second time', () => {
  it('applies nothing, keeps every recorded value, and still exits 0', async () => {
    const kit = harness({
      recorded: true,
      filesCreated: false,
      store: { prepare: { ok: true, from: 2, to: 2, applied: [] } },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept()]);
    expect(kit.output()).toContain('the schema is already at version 2');
    expect(kit.output()).toContain('is already there');
  });

  it('keeps a time zone it did not choose', async () => {
    const kit = harness({ recordedTimezone: 'Europe/Berlin' });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept('Europe/Berlin')]);
  });

  it('keeps all three recorded paths at once', async () => {
    const kit = harness({
      recordedTimezone: 'Europe/Berlin',
      recordedStorePath: '/tmp/a/brain.db',
      recordedFilesPath: '/tmp/a/files',
      recordedMirrorPath: '/tmp/a/mirror',
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders).toEqual(['/tmp/a/brain.db', '/tmp/a/mirror']);
    expect(kit.written).toEqual([
      kept('Europe/Berlin', '/tmp/a/brain.db', '/tmp/a/files', '/tmp/a/mirror'),
    ]);
  });
});

describe('the installer flow when the store cannot be prepared', () => {
  it('reports MIGRATION_FAILED with the file, and skips the shim and doctor', async () => {
    const kit = harness({
      store: {
        prepare: {
          ok: false,
          code: 'MIGRATION_FAILED',
          message: 'table sessions already exists',
          file: '0001_initial.sql',
        },
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('MIGRATION_FAILED: table sessions already exists');
    expect(kit.output()).toContain('0001_initial.sql');
    expect(kit.files.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('names no migration file when it was refused before the first one', async () => {
    const kit = harness({
      store: {
        prepare: {
          ok: false,
          code: 'MIGRATION_FAILED',
          message: 'file is not a database',
          file: '',
        },
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('MIGRATION_FAILED: file is not a database');
    expect(kit.output()).not.toContain('The migration the database refused is');
    expect(kit.shimmed).toEqual([]);
  });

  it('reports DB_UNAVAILABLE in one line when the path cannot hold a database', async () => {
    const kit = harness({
      store: {
        prepare: { ok: false, code: 'DB_UNAVAILABLE', message: 'EISDIR: illegal operation' },
      },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('DB_UNAVAILABLE: EISDIR: illegal operation');
    expect(kit.output()).not.toContain('MIGRATION_FAILED');
    expect(kit.shimmed).toEqual([]);
  });
});

describe('the installer flow with no terminal', () => {
  it('names the consent it needs and exits 2 when it has none', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('--yes');
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
  });

  it('exits 2 when a path flag is given without the consent to use it', async () => {
    const kit = harness({ isTTY: false });

    expect(await runInstallFlow(['--store-path', '/tmp/a/brain.db'], ENV, kit.deps)).toBe(2);
    expect(kit.written).toEqual([]);
  });

  it('installs with the defaults, asking nothing, given --yes alone', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(['--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([fresh()]);
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.files.prepared).toEqual([FILES]);
    expect(kit.output()).toContain('embeddings are off (not supported yet)');
  });

  it('takes both path flags without asking', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(
      ['--store-path', '/tmp/a/brain.db', '--mirror-path', '/tmp/a/mirror', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/a/brain.db', FILES, '/tmp/a/mirror')]);
  });
});

describe('the installer flow and the mirror path', () => {
  it('offers the default and records it when the answer is just Enter', async () => {
    const kit = harness();

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[1]).toBe(MIRROR);
    expect(kit.output()).toContain(`the mirror goes in ${MIRROR}`);
  });

  it('records the absolute path the answer named', async () => {
    const kit = harness({ tail: { text: ['', '/tmp/notes/brain'], confirm: [false] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(STORE, FILES, '/tmp/notes/brain')]);
  });

  it('expands a leading ~ on the flag, and never asks', async () => {
    const kit = harness({ tail: { text: [''], confirm: [false] } });

    const exit = await runInstallFlow(['--mirror-path', '~/notes/brain'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      'Where should the database file go?',
      'Turn embeddings on?',
    ]);
    expect(kit.written).toEqual([fresh(STORE, FILES, join(homedir(), 'notes/brain'))]);
  });

  it('exits 2 without writing for a relative flag and no terminal to ask in', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(
      ['--mirror-path', 'notes/mirror', '--yes'],
      ENV,
      kit.deps,
    );

    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: --mirror-path notes/mirror');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('keeps a recorded path without asking when there is no terminal', async () => {
    const kit = harness({ isTTY: false, recordedMirrorPath: '/tmp/notes/brain' });

    const exit = await runInstallFlow(['--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([kept('Asia/Seoul', STORE, FILES, '/tmp/notes/brain')]);
  });
});

describe('the installer flow and embeddings', () => {
  it('says they are not supported yet when the answer is yes, and writes nothing about them', async () => {
    const kit = harness({ tail: { text: ['', ''], confirm: [true] } });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toContain('Turn embeddings on?');
    expect(kit.output()).toContain('not supported yet');
    // The same write as a run that said no: there is no key for this yet.
    expect(kit.written).toEqual([fresh()]);
  });

  it('asks nothing and says one line when there is no terminal', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstallFlow(['--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.output()).toContain('embeddings are off');
  });
});

describe('the installer flow, the shim and the harnesses', () => {
  it('writes the shim for this home and says so', async () => {
    const kit = harness();

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.shimmed).toEqual([HOME]);
    expect(kit.output()).toContain(`wrote ${shimPath(HOME)} (mode 0755)`);
  });

  it('says the shim is current rather than claiming it wrote one', async () => {
    const kit = harness({ shimCurrent: true });

    await runInstallFlow([], ENV, kit.deps);

    expect(kit.output()).toContain('is already current');
    expect(kit.output()).not.toContain('(mode 0755)');
  });

  it('says there is no harness to connect when the registry is empty', async () => {
    const kit = harness();

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('no harness to connect yet (epic 2)');
    expect(kit.prompts.checked).toEqual([]);
  });

  it('offers every detected harness checked, and connects the ones left checked', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const other = memoryConnector({ harness: 'other', label: 'Other' });
    const kit = harness({
      connectors: [demo, other],
      tail: { text: ['', ''], confirm: [false], multiselect: [['demo']] },
    });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([['demo', 'other']]);
    expect(demo.marked()).toHaveLength(1);
    expect(demo.entries()[0]).toContain(shimPath(HOME));
    expect(other.entries()).toEqual([]);
    expect(kit.output()).toContain('connected Demo in');
  });

  it('never offers a harness that is not installed here', async () => {
    const absent = memoryConnector({ harness: 'absent', detected: false });
    const kit = harness({ connectors: [absent] });

    const exit = await runInstallFlow([], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(kit.output()).toContain('no harness this build knows is installed here');
    expect(absent.entries()).toEqual([]);
  });

  it('says it is already connected the second time, writing nothing', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const run = async (): Promise<string> => {
      const kit = harness({
        connectors: [demo],
        tail: { text: ['', ''], confirm: [false], multiselect: [['demo']] },
      });
      expect(await runInstallFlow([], ENV, kit.deps)).toBe(0);
      return kit.output();
    };

    await run();
    const second = await run();

    expect(second).toContain('Demo was already connected in');
    expect(demo.marked()).toHaveLength(1);
  });

  it('connects only what --connect named when there is no terminal', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({ isTTY: false, connectors: [demo, other] });

    const exit = await runInstallFlow(['--connect', 'demo', '--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(demo.marked()).toHaveLength(1);
    // A harness nobody asked about must not have its configuration written.
    expect(other.entries()).toEqual([]);
  });

  it('writes no harness configuration at all without a terminal and without the flag', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const kit = harness({ isTTY: false, connectors: [demo] });

    const exit = await runInstallFlow(['--yes'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(demo.entries()).toEqual([]);
    expect(kit.output()).toContain('no harness was connected');
  });

  it('takes --connect over the question in a terminal too', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({ connectors: [demo, other] });

    const exit = await runInstallFlow(['--connect', 'other'], ENV, kit.deps);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(other.marked()).toHaveLength(1);
    expect(demo.entries()).toEqual([]);
  });

  it('exits 2 before touching anything for a harness nobody registered', async () => {
    const kit = harness({ isTTY: false, connectors: [memoryConnector({ harness: 'demo' })] });

    const exit = await runInstallFlow(['--connect', 'nope', '--yes'], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('USAGE: no connector for nope');
    expect(kit.output()).toContain('Known harnesses: demo.');
    expect(kit.written).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('exits 1 when a connector refuses, having finished everything else', async () => {
    const broken: MemoryConnector = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json is not JSON' },
    });
    const kit = harness({ isTTY: false, connectors: [broken] });

    const exit = await runInstallFlow(['--connect', 'demo', '--yes'], ENV, kit.deps);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('HARNESS_UNREADABLE: settings.json is not JSON');
    // The database half of the install still happened and still counts.
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.output()).toContain('db: ok');
  });
});

describe('the installer flags', () => {
  it.each([
    { argv: [], expected: { connect: [], yes: false, help: false } },
    { argv: ['--yes'], expected: { connect: [], yes: true, help: false } },
    { argv: ['-y'], expected: { connect: [], yes: true, help: false } },
    {
      argv: ['--store-path', '/tmp/a/brain.db'],
      expected: { storePath: '/tmp/a/brain.db', connect: [], yes: false, help: false },
    },
    {
      argv: ['--store-path', '/tmp/a/brain.db', '--mirror-path', '/tmp/notes'],
      expected: {
        storePath: '/tmp/a/brain.db',
        mirrorPath: '/tmp/notes',
        connect: [],
        yes: false,
        help: false,
      },
    },
    {
      argv: ['--mirror-path', '/tmp/notes', '--connect', 'demo', '--connect', 'other'],
      expected: {
        mirrorPath: '/tmp/notes',
        connect: ['demo', 'other'],
        yes: false,
        help: false,
      },
    },
    {
      argv: ['--connect', 'demo', '--connect', 'demo'],
      expected: { connect: ['demo'], yes: false, help: false },
    },
  ])('reads $argv', ({ argv, expected }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags).toEqual(expected);
  });

  it.each([
    { argv: ['--nope'], contains: 'unknown argument' },
    // The flags the Postgres install needed are gone, and an unknown flag is
    // refused rather than ignored.
    { argv: ['--database-url', 'postgres://x/y'], contains: 'unknown argument' },
    { argv: ['--docker'], contains: 'unknown argument' },
    { argv: ['--store-path'], contains: 'needs a path' },
    { argv: ['--store-path', '--yes'], contains: 'needs a path' },
    { argv: ['--mirror-path'], contains: 'needs a path' },
    { argv: ['--connect'], contains: 'needs a harness name' },
  ])('refuses $argv', ({ argv, contains }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(contains);
  });

  it('prints the usage and exits 2 on an argument it does not know', async () => {
    const kit = harness();

    const exit = await runInstallFlow(['--nope'], ENV, kit.deps);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('Usage: second-brain');
    expect(kit.output()).toContain('--store-path <path>');
    expect(kit.output()).not.toContain('--database-url');
    expect(kit.written).toEqual([]);
  });

  it('prints the usage and exits 0 for --help', async () => {
    const kit = harness();

    expect(await runInstallFlow(['--help'], ENV, kit.deps)).toBe(0);
    expect(kit.written).toEqual([]);
  });

  it('runs from flags somebody else parsed, as `brain setup run` does', async () => {
    const kit = harness({ isTTY: false });

    const exit = await runInstall(
      { storePath: '/tmp/a/brain.db', connect: [], yes: true, help: false },
      ENV,
      kit.deps,
    );

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/a/brain.db')]);
  });
});
