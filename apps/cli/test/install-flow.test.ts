import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  Connector,
  DoctorReport,
  SqliteMigrationResult,
  SqliteProjectKeyCollision,
} from 'second_brain';
import type { SelfUserResult } from '../src/install/store.js';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
import type { ConfigWarning, WriteConfigInput } from '../src/config/codec.js';
import { HOME_ENV } from '../src/config/paths.js';
import {
  failureLines,
  installExit,
  parseFlags,
  runInstall,
  runInstallFlow,
  wasHelped,
  type Choice,
  type InstallDeps,
  type InstallExitCode,
  type InstallFiles,
  type InstallFlags,
  type InstallFlowResult,
  type InstallPrompts,
  type InstallInstalled,
  type InstallResult,
  type InstallStore,
  type RecordedConfig,
} from '../src/install/flow.js';
import type {
  BuildIdentity,
  InstalledFacts,
  InstalledRecord,
} from '../src/install/installed.js';
import { shimPath } from '../src/install/shim.js';
import { assertKoreanLine } from './language.js';

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
 * The harness names these tests register. The flow lists them back — "아는
 * 하네스: demo." — and a harness name is an identifier, not prose, so the
 * output-language check is told about them rather than tripping over them.
 */
const HARNESS_NAMES = ['demo', 'other', 'absent', 'nope'] as const;

/**
 * What the codec must be handed every time: all four values, because
 * `writeConfig` renders both files whole and anything left out goes back to its
 * default. A run with nothing recorded passes no time zone, which is the one
 * value that has a default of its own rather than a question.
 */
function fresh(storePath = STORE, filesPath = FILES, mirrorPath = MIRROR): WriteConfigInput {
  return { timezone: undefined, storePath, filesPath, mirrorPath, updateAuto: true };
}

/** The same, over a folder that already said something. */
function kept(
  timezone = 'Asia/Seoul',
  storePath = STORE,
  filesPath = FILES,
  mirrorPath = MIRROR,
): WriteConfigInput {
  return { timezone, storePath, filesPath, mirrorPath, updateAuto: true };
}

/**
 * What a run answers to the questions every path in a terminal now ends with:
 * Enter for the database file, Enter for the mirror path — both take the
 * default — no to embeddings, yes to automatic updating, and yes to the screen
 * that says what the install is about to write. They are appended to whatever a
 * test queues, so a test that cares about none of them says nothing about them;
 * the per-kind queues keep the order right either way.
 */
const TAIL: Answers = { text: ['', ''], confirm: [false, true, true] };

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
  /** Each `confirm` question and the answer it offered as its default. */
  initial: readonly [string, boolean][];
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
  const initial: [string, boolean][] = [];

  return {
    asked,
    placeholders,
    checked,
    initial,
    async confirm(question: string, offered: boolean): Promise<boolean> {
      asked.push(question);
      initial.push([question, offered]);
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
  /** What the owner step answers. A first run that recorded it by default. */
  self?: SelfUserResult;
  /** Doctor's own verdict on the file. */
  walFails?: boolean;
  /** Whether there is already a file at the database path. */
  exists?: boolean;
  /**
   * The projects migration 0005 would fold into one comparison key. None by
   * default: a database that never split a repository over the case of its
   * remote is every database but the ones this story is about (AD-12).
   */
  collisions?: readonly SqliteProjectKeyCollision[];
}

interface Store extends InstallStore {
  /** Every path prepared, in order. */
  prepared: string[];
  /** The options each `prepare` was given, in the same order. */
  preparedWith: ({ mergeProjects?: boolean } | undefined)[];
  /** Every path the collision screen was pointed at, in order. */
  asked: string[];
  /** Every path the owner step was pointed at, in order. */
  owned: string[];
  doctored: string[];
  /** Every home doctor was pointed at, in order. */
  doctoredHomes: string[];
}

function fakeStore(world: StoreWorld = {}): Store {
  const prepared: string[] = [];
  const preparedWith: ({ mergeProjects?: boolean } | undefined)[] = [];
  const asked: string[] = [];
  const owned: string[] = [];
  const doctored: string[] = [];
  const doctoredHomes: string[] = [];

  return {
    prepared,
    preparedWith,
    asked,
    owned,
    doctored,
    doctoredHomes,
    async exists() {
      return world.exists ?? false;
    },
    async collisions(path) {
      asked.push(path);
      return world.collisions ?? [];
    },
    async prepare(path, options) {
      prepared.push(path);
      preparedWith.push(options);
      return (
        world.prepare ?? {
          ok: true,
          from: 0,
          to: 5,
          applied: [
            '0001_initial.sql',
            '0002_files_and_work.sql',
            '0003_users.sql',
            '0004_capture_columns.sql',
            '0005_identity_and_records.sql',
          ],
        }
      );
    },
    async self(path) {
      owned.push(path);
      return world.self ?? { ok: true, name: 'brain-owner', created: true };
    },
    async doctor(home, path): Promise<DoctorReport> {
      doctoredHomes.push(home);
      doctored.push(path);
      const checks: DoctorReport['checks'] = [
        { id: 'db', status: 'ok', detail: '3.50.4' },
        { id: 'writable', status: 'ok', detail: '파일이 쓰기를 받아들이고 되돌렸습니다' },
        world.walFails === true
          ? { id: 'wal', status: 'fail', detail: 'journal_mode가 wal이 아니라 delete입니다' }
          : { id: 'wal', status: 'ok', detail: 'wal' },
        { id: 'fts5-trigram', status: 'ok', detail: 'trigram 토크나이저가 있는 fts5' },
        { id: 'foreign-keys', status: 'ok', detail: '이 연결에서 적용됩니다' },
        { id: 'schema-version', status: 'ok', detail: '5' },
        { id: 'config', status: 'ok', detail: join(home, 'config.toml') },
        { id: 'shim', status: 'ok', detail: shimPath(home) },
        { id: 'node-path', status: 'ok', detail: '/usr/bin/node의 node 24.16.0' },
        { id: 'node-version', status: 'ok', detail: 'node 24.16.0' },
      ];
      return {
        checks,
        summary: {
          passed: checks.filter((check) => check.status === 'ok').length,
          warned: checks.filter((check) => check.status === 'warn').length,
          failed: checks.filter((check) => check.status === 'fail').length,
          skipped: checks.filter((check) => check.status === 'skip').length,
        },
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
          message: '파일 저장소 루트를 만들 수 없습니다: EEXIST: file already exists',
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
  installed: Installed;
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
  recordedUpdateAuto?: boolean;
  /** Keys this version does not know, as the codec reads them back. */
  recordedExtra?: Record<string, unknown>;
  /** The warnings the codec collected while reading the folder value by value. */
  readWarnings?: readonly ConfigWarning[];
  /** The whole file is unusable, so the install must write nothing. */
  readFails?: string;
  /** The codec refuses to write, as a value: a `.env` it cannot represent. */
  writeFails?: string;
  /** The registry. Empty, like the real one, unless a test fills it. */
  connectors?: readonly Connector[];
  /** The shim was already there and says exactly this. */
  shimCurrent?: boolean;
  /** Running the shim from outside the process refuses, with this sentence. */
  verifyFails?: string;
  /** What `dist/build.json` says. A build with no identity leaves it out. */
  build?: BuildIdentity;
  /** What a previous install recorded here. */
  recordedInstalled?: InstalledRecord;
}

/** The node the fake shim pins, which is what the record has to carry. */
const PINNED_NODE = '/opt/homebrew/bin/node';

/** The commit the fake `build.json` names, unless a test says otherwise. */
const BUILD_COMMIT = 'a'.repeat(40);

interface Installed extends InstallInstalled {
  /** Every home the completion check ran against, in order. */
  verified: string[];
  /** Every record written, in order. */
  wrote: InstalledFacts[];
}

function fakeInstalled(options: HarnessOptions): Installed {
  const verified: string[] = [];
  const wrote: InstalledFacts[] = [];

  return {
    verified,
    wrote,
    async verify(home) {
      verified.push(home);
      return options.verifyFails === undefined
        ? { ok: true as const }
        : { ok: false as const, message: options.verifyFails };
    },
    async build() {
      return 'build' in options
        ? options.build
        : { commit: BUILD_COMMIT, schema_version: 5 };
    },
    async read() {
      return options.recordedInstalled;
    },
    async write(home, facts) {
      expect(home).toBe(HOME);
      wrote.push(facts);
      return { path: join(home, 'installed.json') };
    },
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const prompts = fakePrompts(answersWith(options.answers ?? {}, options.tail ?? TAIL));
  const shimmed: string[] = [];
  const store = fakeStore(options.store);
  const files = fakeFiles(options.filesCreated ?? true, options.filesFails ?? false);
  const installed = fakeInstalled(options);
  const written: WriteConfigInput[] = [];
  const lines: string[] = [];
  const recorded =
    options.recorded === true ||
    options.recordedTimezone !== undefined ||
    options.recordedStorePath !== undefined ||
    options.recordedFilesPath !== undefined ||
    options.recordedMirrorPath !== undefined ||
    options.recordedUpdateAuto !== undefined ||
    options.recordedExtra !== undefined;

  const deps: InstallDeps = {
    prompts,
    isTTY: options.isTTY ?? true,
    log: (line: string): void => {
      // Every line the flow prints goes through here, so the output-language
      // rule covers the whole flow at once (Conventions, output language
      // 2026-10-16) — including the lines a branch below has yet to add. The
      // `CODE: ` prefix and whatever Node said stay English (Boundaries),
      // which the checker is told about.
      // The harness names the flow lists are identifiers, not prose.
      assertKoreanLine(line, { label: 'flow line', allow: HARNESS_NAMES });
      lines.push(line);
    },
    config: {
      write: async (home, input) => {
        expect(home).toBe(HOME);
        if (options.writeFails !== undefined) {
          return { ok: false as const, code: 'CONFIG_INVALID' as const, message: options.writeFails };
        }
        written.push(input);
        return { ok: true as const };
      },
      read: async () => {
        if (options.readFails !== undefined) {
          return { ok: false as const, code: 'CONFIG_INVALID' as const, message: options.readFails };
        }
        const held: RecordedConfig | undefined = recorded
          ? {
              timezone: options.recordedTimezone ?? 'Asia/Seoul',
              storePath: options.recordedStorePath ?? STORE,
              filesPath: options.recordedFilesPath ?? FILES,
              mirrorPath: options.recordedMirrorPath ?? MIRROR,
              updateAuto: options.recordedUpdateAuto ?? true,
              extra: options.recordedExtra ?? {},
            }
          : undefined;
        return { ok: true as const, recorded: held, warnings: options.readWarnings ?? [] };
      },
    },
    store,
    files,
    shim: {
      write: async (home: string): Promise<{ path: string; changed: boolean; node: string }> => {
        shimmed.push(home);
        return { path: shimPath(home), changed: options.shimCurrent !== true, node: PINNED_NODE };
      },
    },
    installed,
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
    installed,
    output: () => lines.join('\n'),
  };
}

/**
 * The flow, and then its result rendered the way a door renders it.
 *
 * The flow itself no longer prints a `CODE: …` line — the failure is the value
 * it hands back — so the one renderer both doors use is called here too, which
 * is what keeps `kit.output()` the whole of what a person would have seen and
 * the exit code the one `installExit` decides.
 */
async function install(
  argv: readonly string[],
  kit: Harness,
): Promise<InstallExitCode> {
  return rendered(await runInstallFlow(argv, ENV, kit.deps), kit);
}

/** The same, from flags somebody else parsed, as `brain setup run` comes in. */
async function installWithFlags(flags: InstallFlags, kit: Harness): Promise<InstallExitCode> {
  return rendered(await runInstall(flags, ENV, kit.deps), kit);
}

function rendered(result: InstallFlowResult, kit: Harness): InstallExitCode {
  if (!result.ok) for (const line of failureLines(result.failure)) kit.deps.log(line);
  return installExit(result);
}

/**
 * The result itself, for a test about the value rather than the lines. The
 * usage is not one of the shapes under test, so a run that printed it is a
 * broken test rather than a variant every assertion has to narrow away.
 */
async function resultOf(argv: readonly string[], kit: Harness): Promise<InstallResult> {
  const result = await runInstallFlow(argv, ENV, kit.deps);
  if (wasHelped(result)) throw new Error(`the flow printed the usage for: ${argv.join(' ')}`);
  return result;
}

describe('the installer flow on an empty folder', () => {
  it('asks the two path questions, writes everything, and ends on a green doctor', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      '데이터베이스 파일을 어디에 둘까요?',
      '미러를 어디에 둘까요?',
      '임베딩을 켤까요?',
      '자동 업데이트를 켤까요?',
      '이대로 진행할까요?',
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

  it('writes the configuration only after the store, the owner and the files root', async () => {
    const order: string[] = [];
    const kit = harness();
    const { config, store, files, shim } = kit.deps;
    const deps: InstallDeps = {
      ...kit.deps,
      config: {
        read: config.read,
        write: async (home, input) => {
          order.push('config');
          return config.write(home, input);
        },
      },
      store: {
        exists: store.exists,
        collisions: store.collisions,
        prepare: async (path, options) => {
          order.push('store');
          return store.prepare(path, options);
        },
        self: async (path) => {
          order.push('owner');
          return store.self(path);
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

    expect(installExit(await runInstallFlow([], ENV, deps))).toBe(0);
    // The configuration records where this install actually managed to write,
    // so every path in it has already been used by the time it is written
    // (F3). Only the mirror has nothing to prove: nobody creates it yet.
    expect(order).toEqual(['store', 'owner', 'files', 'config', 'shim', 'doctor']);
  });

  it('says what the migrations applied, and the modes it left behind', async () => {
    const kit = harness();

    await install([], kit);

    expect(kit.output()).toContain(
      '0001_initial.sql, 0002_files_and_work.sql, 0003_users.sql, ' +
        '0004_capture_columns.sql, 0005_identity_and_records.sql을 적용했고',
    );
    expect(kit.output()).toContain('스키마 버전은 5입니다');
    expect(kit.output()).toContain(`${FILES}를 만들었습니다 (mode 0700)`);
    expect(kit.output()).toContain(`${shimPath(HOME)}을 썼습니다 (mode 0755)`);
  });

  it('records the owner against the database it just migrated', async () => {
    const kit = harness();

    await install([], kit);

    expect(kit.store.owned).toEqual([STORE]);
    expect(kit.output()).toContain('이 brain은 brain-owner의 것입니다');
  });

  it('exits 1 and stops when the owner could not be recorded', async () => {
    const kit = harness({
      store: {
        self: { ok: false, code: 'DB_UNAVAILABLE', message: '파일이 사라졌습니다' },
      },
    });

    const exit = await install([], kit);

    // Nothing after it runs: a brain nobody owns cannot ingest a session, so
    // finishing the install would report an install that does not work.
    expect(exit).toBe(1);
    expect(kit.output()).toContain('DB_UNAVAILABLE: 파일이 사라졌습니다');
    expect(kit.files.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('exits 1 when doctor fails a check, having finished every step', async () => {
    const kit = harness({ store: { walFails: true } });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('wal: fail');
    expect(kit.shimmed).toEqual([HOME]);
  });
});

describe('the installer flow and the database file', () => {
  it('records the absolute path the answer named', async () => {
    const kit = harness({ tail: { text: ['/tmp/notes/brain.db', ''], confirm: [false, true, true] } });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
    expect(kit.store.prepared).toEqual(['/tmp/notes/brain.db']);
  });

  it('expands a leading ~, which no shell expanded for a typed answer', async () => {
    const kit = harness({ tail: { text: ['~/notes/brain.db', ''], confirm: [false, true, true] } });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(join(homedir(), 'notes/brain.db'))]);
  });

  it('expands a leading ~ on the flag too, and never asks about it', async () => {
    const kit = harness({ tail: { text: [''], confirm: [false, true, true] } });

    const exit = await install(['--store-path', '~/notes/brain.db'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      '미러를 어디에 둘까요?',
      '임베딩을 켤까요?',
      '자동 업데이트를 켤까요?',
      '이대로 진행할까요?',
    ]);
    expect(kit.written).toEqual([fresh(join(homedir(), 'notes/brain.db'))]);
  });

  it('asks again after a relative answer, and takes the next one', async () => {
    const kit = harness({
      tail: { text: ['notes/brain.db', '/tmp/notes/brain.db', ''], confirm: [false, true, true] },
    });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    // A line, not a `CODE: …` failure: the next question is about to offer a
    // way out of it, and this run does not fail.
    expect(kit.output()).toContain('notes/brain.db는 절대 경로가 아닙니다. 다시 묻습니다.');
    expect(kit.output()).not.toContain('CONFIG_INVALID');
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
  });

  it('asks again after a relative flag when there is a terminal to ask in', async () => {
    const kit = harness({ tail: { text: ['/tmp/notes/brain.db', ''], confirm: [false, true, true] } });

    const exit = await install(['--store-path', 'brain.db'], kit);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('--store-path brain.db는 절대 경로가 아닙니다. 다시 묻습니다.');
    expect(kit.output()).not.toContain('CONFIG_INVALID');
    expect(kit.written).toEqual([fresh('/tmp/notes/brain.db')]);
  });

  it('gives up after three relative answers and writes nothing', async () => {
    const kit = harness({ tail: { text: ['a', 'b', 'c'] } });

    const exit = await install([], kit);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('3번 물어도 쓸 수 있는 데이터베이스 파일 경로가 없어서');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('exits 2 without writing for a relative flag and no terminal to ask in', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install(['--store-path', 'brain.db', '--yes'], kit);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: --store-path brain.db');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('offers the recorded path as the default, and keeps it on Enter', async () => {
    const kit = harness({ recordedStorePath: '/tmp/notes/brain.db' });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[0]).toBe('/tmp/notes/brain.db');
    expect(kit.written).toEqual([kept('Asia/Seoul', '/tmp/notes/brain.db')]);
  });

  it('keeps the recorded path without asking when there is no terminal', async () => {
    const kit = harness({ isTTY: false, recordedStorePath: '/tmp/notes/brain.db' });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([kept('Asia/Seoul', '/tmp/notes/brain.db')]);
  });

  it('says the old file is still there when a re-run picks another path', async () => {
    const kit = harness({
      recordedStorePath: '/tmp/notes/brain.db',
      tail: { text: ['/tmp/elsewhere/brain.db', ''], confirm: [false, true, true] },
    });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('/tmp/notes/brain.db는 있던 자리에 그대로 둡니다');
    expect(kit.output()).toContain('아무것도 옮기지 않았습니다');
    expect(kit.store.prepared).toEqual(['/tmp/elsewhere/brain.db']);
  });

  it('says nothing about an old file when the path did not change', async () => {
    const kit = harness({ recorded: true });

    await install([], kit);

    expect(kit.output()).not.toContain('있던 자리에 그대로 둡니다');
  });
});

describe('the installer flow and the file store', () => {
  it('prepares the default root, which nothing asks about', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.files.prepared).toEqual([FILES]);
    expect(kit.prompts.asked).not.toContain('파일을 어디에 둘까요?');
  });

  it('keeps a recorded root rather than resetting it to the default', async () => {
    const kit = harness({ recordedFilesPath: '/tmp/notes/files' });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept('Asia/Seoul', STORE, '/tmp/notes/files')]);
    expect(kit.files.prepared).toEqual(['/tmp/notes/files']);
  });

  it('reports a root it could not make in one line, and skips the shim and doctor', async () => {
    const kit = harness({ filesFails: true });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('FILES_UNAVAILABLE: 파일 저장소 루트를 만들 수 없습니다: EEXIST');
    // The store was already prepared; the shim and doctor are not reached.
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('says the root was already there rather than claiming it made one', async () => {
    const kit = harness({ filesCreated: false });

    await install([], kit);

    expect(kit.output()).toContain(`${FILES}는 이미 있습니다 (mode 0700)`);
    expect(kit.output()).not.toContain(`${FILES}를 만들었습니다`);
  });
});

describe('the installer flow run a second time', () => {
  it('applies nothing, keeps every recorded value, and still exits 0', async () => {
    const kit = harness({
      recorded: true,
      filesCreated: false,
      store: {
        prepare: { ok: true, from: 5, to: 5, applied: [] },
        self: { ok: true, name: 'brain-owner', created: false },
      },
    });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([kept()]);
    expect(kit.output()).toContain('스키마는 이미 버전 5입니다');
    // The owner is decided once: a re-run says whose it is and changes nothing
    // (AD-12).
    expect(kit.output()).toContain('이미 brain-owner의 것입니다');
    expect(kit.output()).toContain('이미 있습니다');
  });

  it('keeps a time zone it did not choose', async () => {
    const kit = harness({ recordedTimezone: 'Europe/Berlin' });

    const exit = await install([], kit);

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

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders).toEqual(['/tmp/a/brain.db', '/tmp/a/mirror']);
    expect(kit.written).toEqual([
      kept('Europe/Berlin', '/tmp/a/brain.db', '/tmp/a/files', '/tmp/a/mirror'),
    ]);
  });
});

/**
 * The projects that only differ by the case of their remote (AD-12).
 *
 * Migration 0005 makes the comparison key `unique`, so a database that split
 * one repository into two projects over nothing but case cannot take it. Folding
 * them deletes a row, so this is the one thing the install asks about on its
 * own — and the one no it offers after everything else is agreed.
 */
describe('the installer flow and projects that collide on the comparison key', () => {
  const GROUP: SqliteProjectKeyCollision = {
    identityKey: 'github.com/brain-owner/notes',
    projects: [
      {
        id: '01960000-0000-7000-8000-000000000001',
        remoteIdentity: 'github.com/Brain-Owner/Notes',
        sessions: 3,
      },
      {
        id: '01960000-0000-7000-8000-000000000002',
        remoteIdentity: 'github.com/brain-owner/notes',
        sessions: 1,
      },
    ],
  };

  /** The usual tail with one more answer on it: the merge question. */
  function tailAnswering(merge: boolean): Answers {
    return { text: ['', ''], confirm: [false, true, true, merge] };
  }

  it('shows the group, asks once, and merges inside the migration when told yes', async () => {
    const kit = harness({ store: { collisions: [GROUP] }, tail: tailAnswering(true) });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.store.asked).toEqual([STORE]);
    // Both remotes, both session counts, and which one is kept: a person
    // agreeing to this is agreeing to lose a row, and they are owed the trade.
    expect(kit.output()).toContain(
      '비교 키 github.com/brain-owner/notes로 겹치는 프로젝트가 2개 있습니다',
    );
    expect(kit.output()).toContain('github.com/Brain-Owner/Notes (세션 3건)');
    expect(kit.output()).toContain('github.com/brain-owner/notes (세션 1건)');
    expect(kit.output()).toContain('남는 쪽은 github.com/Brain-Owner/Notes입니다');
    expect(kit.prompts.asked).toContain('겹치는 프로젝트 1묶음을 하나로 합칠까요?');
    // The flag the migration runner reads, and the line that says it took.
    expect(kit.store.preparedWith).toEqual([{ mergeProjects: true }]);
    expect(kit.output()).toContain('겹치는 프로젝트 1묶음을 하나로 합쳤습니다');
  });

  it('is SETUP_CANCELLED and writes nothing at all when told no', async () => {
    const kit = harness({ store: { collisions: [GROUP] }, tail: tailAnswering(false) });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain(
      'SETUP_CANCELLED: 프로젝트를 합치지 않기로 했습니다. 데이터베이스는 바꾸지 않았습니다.',
    );
    // The database is untouched, which is the whole of the promise: no
    // migration ran, so it stays at the version it was.
    expect(kit.store.prepared).toEqual([]);
    expect(kit.written).toEqual([]);
    expect(kit.files.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('merges without asking when --yes gave every consent in advance', async () => {
    const kit = harness({ store: { collisions: [GROUP] } });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    // `--yes` means every question answered in advance, this one included, and
    // the group is still printed: consent given early is not consent in the
    // dark (README).
    expect(kit.prompts.asked).not.toContain('겹치는 프로젝트 1묶음을 하나로 합칠까요?');
    expect(kit.output()).toContain('github.com/Brain-Owner/Notes (세션 3건)');
    expect(kit.store.preparedWith).toEqual([{ mergeProjects: true }]);
  });

  it('asks nothing and merges nothing when no group collides', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.store.asked).toEqual([STORE]);
    expect(kit.prompts.asked).not.toContain('겹치는 프로젝트 1묶음을 하나로 합칠까요?');
    expect(kit.store.preparedWith).toEqual([{}]);
    expect(kit.output()).not.toContain('합쳤습니다');
  });
});

describe('the installer flow when the store cannot be prepared', () => {
  it('reports MIGRATION_FAILED with the file, and skips the shim and doctor', async () => {
    const kit = harness({
      store: {
        prepare: {
          ok: false,
          code: 'MIGRATION_FAILED',
          message: '마이그레이션이 거부되었습니다: table sessions already exists',
          file: '0001_initial.sql',
        },
      },
    });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('MIGRATION_FAILED: 마이그레이션이 거부되었습니다: table sessions already exists');
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
          message: '데이터베이스를 열 수 없습니다: file is not a database',
          file: '',
        },
      },
    });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('MIGRATION_FAILED: 데이터베이스를 열 수 없습니다: file is not a database');
    expect(kit.output()).not.toContain('데이터베이스가 거부한 마이그레이션은');
    expect(kit.shimmed).toEqual([]);
  });

  it('reports DB_UNAVAILABLE in one line when the path cannot hold a database', async () => {
    const kit = harness({
      store: {
        prepare: {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: '데이터베이스 파일을 만들 수 없습니다: EISDIR: illegal operation',
        },
      },
    });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('DB_UNAVAILABLE: 데이터베이스 파일을 만들 수 없습니다: EISDIR');
    expect(kit.output()).not.toContain('MIGRATION_FAILED');
    expect(kit.shimmed).toEqual([]);
  });
});

describe('the installer flow with no terminal', () => {
  it('names the consent it needs and exits 3 when it has none', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install([], kit);

    // 3, not 2: nothing was wrong with the invocation and nothing is broken —
    // somebody has to agree to what the install does (Conventions).
    expect(exit).toBe(3);
    expect(kit.output()).toContain('--yes');
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
  });

  it('exits 3 when a path flag is given without the consent to use it', async () => {
    const kit = harness({ isTTY: false });

    expect(await install(['--store-path', '/tmp/a/brain.db'], kit)).toBe(3);
    expect(kit.written).toEqual([]);
  });

  it('answers the gate itself, with the arguments this call actually gave', async () => {
    const kit = harness({ isTTY: false });

    const result = await resultOf(['--store-path', '/tmp/a/brain.db', '--connect', 'demo'], {
      ...kit,
      deps: { ...kit.deps, connectors: [memoryConnector({ harness: 'demo' })] },
    });

    // Core's gate, from the flow and not translated out of a log line by a
    // command afterwards: the retry is this very install plus the consent.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('CONFIRMATION_REQUIRED');
    expect(result.failure.retry).toEqual({
      ns: 'setup',
      verb: 'run',
      args: { storePath: '/tmp/a/brain.db', connect: ['demo'], confirm: true },
    });
    // The code table decides the exit code and the hint, so the flow names
    // neither (Conventions).
    expect(result.failure.exit).toBeUndefined();
    expect(result.failure.hint).toBeUndefined();
  });

  it('installs with the defaults, asking nothing, given --yes alone', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([fresh()]);
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.files.prepared).toEqual([FILES]);
    expect(kit.output()).toContain('임베딩은 꺼져 있습니다 (아직 지원하지 않습니다)');
  });

  it('takes both path flags without asking', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install(['--store-path', '/tmp/a/brain.db', '--mirror-path', '/tmp/a/mirror', '--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/a/brain.db', FILES, '/tmp/a/mirror')]);
  });
});

describe('the installer flow and a configuration it can only half read', () => {
  it('keeps every other value, warns, and still succeeds when one is unusable', async () => {
    // What the codec hands back for a relative `store.path` beside a files
    // root, a mirror and a time zone the user chose: the one bad value is
    // dropped and this run writes the default for that key alone (F1).
    const kit = harness({
      isTTY: false,
      recordedTimezone: 'Europe/Berlin',
      recordedFilesPath: '/tmp/a/files',
      recordedMirrorPath: '/tmp/a/mirror',
      readWarnings: [
        {
          code: 'CONFIG_VALUE_RESET',
          message: `${HOME}/config.toml: store.path는 문자열 "brain.db"입니다. 쓸 수 없으므로 버립니다. 기본값은 "${STORE}"입니다`,
        },
      ],
    });

    const result = await resultOf(['--yes'], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual(['CONFIG_VALUE_RESET']);
    // The three values the file still said are written back; only the store
    // falls to its default.
    expect(kit.written).toEqual([
      kept('Europe/Berlin', STORE, '/tmp/a/files', '/tmp/a/mirror'),
    ]);
    expect(kit.output()).toContain('경고:');
    expect(kit.output()).toContain('store.path');
  });

  it('writes the keys this version does not know straight back', async () => {
    const extra = { database: { url_env: 'X' }, store: { extra: 1 } };
    const kit = harness({
      isTTY: false,
      recorded: true,
      recordedExtra: extra,
      readWarnings: [
        {
          code: 'CONFIG_UNKNOWN_KEY',
          message: `${HOME}/config.toml: 이 버전이 모르는 키 "database.url_env"가 있습니다. 쓰지는 않고 그대로 둡니다`,
        },
      ],
    });

    const result = await resultOf(['--yes'], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual(['CONFIG_UNKNOWN_KEY']);
    expect(kit.written).toEqual([{ ...kept(), extra }]);
  });

  it('stops before writing anything when the whole file cannot be read', async () => {
    const kit = harness({
      isTTY: false,
      readFails: `${HOME}/config.toml: schema_version 2는 지원하지 않습니다.`,
    });

    const exit = await install(['--yes'], kit);

    // 2 and not 1: nothing ran. Overwriting it with this version's defaults
    // would be the install losing the one copy of what the person chose (F1).
    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: ');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
  });

  it('reports a codec that refuses to write, rather than throwing', async () => {
    const kit = harness({
      isTTY: false,
      writeFails: 'OTHER에 작은따옴표와 큰따옴표가 다 들어 있어서 .env로 나타낼 수 없습니다',
    });

    const exit = await install(['--yes'], kit);

    // 1, not 2: the store and the owner are already there, so this run did
    // happen — and the code table's own 2 would say it never started.
    expect(exit).toBe(1);
    expect(kit.output()).toContain('CONFIG_INVALID: OTHER');
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.shimmed).toEqual([]);
  });

  it('carries the warnings on a failure as well as on a result', async () => {
    const kit = harness({
      isTTY: false,
      readWarnings: [
        {
          code: 'CONFIG_UNKNOWN_KEY',
          message: `${HOME}/config.toml: 이 버전이 모르는 키 "x"가 있습니다. 쓰지는 않고 그대로 둡니다`,
        },
      ],
      store: { self: { ok: false, code: 'DB_UNAVAILABLE', message: '파일이 사라졌습니다' } },
    });

    const result = await resultOf(['--yes'], kit);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A code collected before the failure is still a code the caller has to
    // see (NFR-2).
    expect(result.warnings).toEqual(['CONFIG_UNKNOWN_KEY']);
  });
});

describe('the installer flow asking before it writes', () => {
  it('shows every path it is about to write, then asks once', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('이제 이것들을 씁니다.');
    expect(kit.output()).toContain(`설정 파일 ${HOME}/config.toml`);
    expect(kit.output()).toContain(`데이터베이스 ${STORE}를 새로 만듭니다`);
    expect(kit.output()).toContain(`파일 저장소 루트 ${FILES}`);
    expect(kit.output()).toContain(shimPath(HOME));
    expect(kit.output()).toContain(`미러 경로 ${MIRROR}는 적어 두기만 하고`);
    // Last of the questions, so everything it names is settled by then.
    expect(kit.prompts.asked.at(-1)).toBe('이대로 진행할까요?');
  });

  it('says it will migrate the database that is already there', async () => {
    const kit = harness({ store: { exists: true } });

    expect(await install([], kit)).toBe(0);
    expect(kit.output()).toContain(`이미 있는 데이터베이스 ${STORE}를 마이그레이션합니다`);
    expect(kit.output()).not.toContain('새로 만듭니다');
  });

  it('writes nothing at all when the answer is no', async () => {
    const kit = harness({ tail: { text: ['', ''], confirm: [false, true, false] } });

    const exit = await install([], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('SETUP_CANCELLED: 진행하지 않기로 했습니다.');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.files.prepared).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('skips this one question for --yes, and keeps the path questions', async () => {
    const kit = harness({ tail: { text: ['', ''], confirm: [false, true] } });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      '데이터베이스 파일을 어디에 둘까요?',
      '미러를 어디에 둘까요?',
      '임베딩을 켤까요?',
      '자동 업데이트를 켤까요?',
    ]);
    expect(kit.output()).not.toContain('이제 이것들을 씁니다.');
  });
});

describe('what the installer flow reports when it worked', () => {
  it('answers a structured report rather than the lines it printed', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const kit = harness({ isTTY: false, connectors: [demo] });

    const result = await resultOf(['--connect', 'demo', '--yes'], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({
      home: HOME,
      config_path: `${HOME}/config.toml`,
      store: {
        path: STORE,
        schema_version: 5,
        applied: [
          '0001_initial.sql',
          '0002_files_and_work.sql',
          '0003_users.sql',
          '0004_capture_columns.sql',
          '0005_identity_and_records.sql',
        ],
      },
      owner: { name: 'brain-owner', created: true },
      files: { path: FILES, created: true },
      mirror_path: MIRROR,
      shim: { path: shimPath(HOME), changed: true },
      harnesses: [{ harness: 'demo', target: '/memory/demo/settings.json', changed: true }],
    });
    expect(result.report.checks.map((check) => check.id)).toContain('wal');
    expect(result.report.summary.failed).toBe(0);
  });

  it('fails with SETUP_INCOMPLETE when the closing checks do not pass', async () => {
    const kit = harness({ isTTY: false, store: { walFails: true } });

    const result = await resultOf(['--yes'], kit);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('SETUP_INCOMPLETE');
    expect(result.failure.message).toContain('wal');
    // Doctor still printed every line: it is what a person reads to find out
    // what is wrong.
    expect(kit.output()).toContain('wal: fail');
  });
});

describe('the installer flow and the mirror path', () => {
  it('offers the default and records it when the answer is just Enter', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.placeholders[1]).toBe(MIRROR);
    expect(kit.output()).toContain(`미러는 ${MIRROR}에 둡니다`);
  });

  it('records the absolute path the answer named', async () => {
    const kit = harness({ tail: { text: ['', '/tmp/notes/brain'], confirm: [false, true, true] } });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh(STORE, FILES, '/tmp/notes/brain')]);
  });

  it('expands a leading ~ on the flag, and never asks', async () => {
    const kit = harness({ tail: { text: [''], confirm: [false, true, true] } });

    const exit = await install(['--mirror-path', '~/notes/brain'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([
      '데이터베이스 파일을 어디에 둘까요?',
      '임베딩을 켤까요?',
      '자동 업데이트를 켤까요?',
      '이대로 진행할까요?',
    ]);
    expect(kit.written).toEqual([fresh(STORE, FILES, join(homedir(), 'notes/brain'))]);
  });

  it('exits 2 without writing for a relative flag and no terminal to ask in', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install(['--mirror-path', 'notes/mirror', '--yes'], kit);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('CONFIG_INVALID: --mirror-path notes/mirror');
    expect(kit.written).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
  });

  it('keeps a recorded path without asking when there is no terminal', async () => {
    const kit = harness({ isTTY: false, recordedMirrorPath: '/tmp/notes/brain' });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written).toEqual([kept('Asia/Seoul', STORE, FILES, '/tmp/notes/brain')]);
  });
});

describe('the installer flow and embeddings', () => {
  it('says they are not supported yet when the answer is yes, and writes nothing about them', async () => {
    const kit = harness({ tail: { text: ['', ''], confirm: [true, true, true] } });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toContain('임베딩을 켤까요?');
    expect(kit.output()).toContain('아직 지원하지 않으므로');
    // The same write as a run that said no: there is no key for this yet.
    expect(kit.written).toEqual([fresh()]);
  });

  it('asks nothing and says one line when there is no terminal', async () => {
    const kit = harness({ isTTY: false });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(kit.output()).toContain('임베딩은 꺼져 있습니다');
  });
});

describe('the installer flow, the shim and the harnesses', () => {
  it('writes the shim for this home and says so', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.shimmed).toEqual([HOME]);
    expect(kit.output()).toContain(`${shimPath(HOME)}을 썼습니다 (mode 0755)`);
  });

  it('says the shim is current rather than claiming it wrote one', async () => {
    const kit = harness({ shimCurrent: true });

    await install([], kit);

    expect(kit.output()).toContain(`${shimPath(HOME)}은 이미 최신입니다`);
    // The consent screen says it will write the shim at 0755; the step itself
    // must not claim it did when the file already said this.
    expect(kit.output()).not.toContain(`${shimPath(HOME)}을 썼습니다`);
  });

  it('says there is no harness to connect when the registry is empty', async () => {
    const kit = harness();

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.output()).toContain('아직 연결할 하네스가 없습니다 (epic 2)');
    expect(kit.prompts.checked).toEqual([]);
  });

  it('offers every detected harness checked, and connects the ones left checked', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const other = memoryConnector({ harness: 'other', label: 'Other' });
    const kit = harness({
      connectors: [demo, other],
      tail: { text: ['', ''], confirm: [false, true, true], multiselect: [['demo']] },
    });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([['demo', 'other']]);
    expect(demo.marked()).toHaveLength(1);
    expect(demo.entries()[0]).toContain(shimPath(HOME));
    expect(other.entries()).toEqual([]);
    expect(kit.output()).toContain('Demo를 연결했습니다');
  });

  it('never offers a harness that is not installed here', async () => {
    const absent = memoryConnector({ harness: 'absent', detected: false });
    const kit = harness({ connectors: [absent] });

    const exit = await install([], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(kit.output()).toContain('이 빌드가 아는 하네스가 여기에 설치되어 있지 않습니다');
    expect(absent.entries()).toEqual([]);
  });

  it('says it is already connected the second time, writing nothing', async () => {
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });
    const run = async (): Promise<string> => {
      const kit = harness({
        connectors: [demo],
        tail: { text: ['', ''], confirm: [false, true, true], multiselect: [['demo']] },
      });
      expect(await install([], kit)).toBe(0);
      return kit.output();
    };

    await run();
    const second = await run();

    expect(second).toContain('Demo가 이미 연결되어 있습니다');
    expect(demo.marked()).toHaveLength(1);
  });

  it('connects only what --connect named when there is no terminal', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({ isTTY: false, connectors: [demo, other] });

    const exit = await install(['--connect', 'demo', '--yes'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.asked).toEqual([]);
    expect(demo.marked()).toHaveLength(1);
    // A harness nobody asked about must not have its configuration written.
    expect(other.entries()).toEqual([]);
  });

  it('writes no harness configuration at all without a terminal and without the flag', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const kit = harness({ isTTY: false, connectors: [demo] });

    const exit = await install(['--yes'], kit);

    expect(exit).toBe(0);
    expect(demo.entries()).toEqual([]);
    expect(kit.output()).toContain('연결한 하네스가 없습니다');
  });

  it('takes --connect over the question in a terminal too', async () => {
    const demo = memoryConnector({ harness: 'demo' });
    const other = memoryConnector({ harness: 'other' });
    const kit = harness({ connectors: [demo, other] });

    const exit = await install(['--connect', 'other'], kit);

    expect(exit).toBe(0);
    expect(kit.prompts.checked).toEqual([]);
    expect(other.marked()).toHaveLength(1);
    expect(demo.entries()).toEqual([]);
  });

  it('exits 2 before touching anything for a harness nobody registered', async () => {
    const kit = harness({ isTTY: false, connectors: [memoryConnector({ harness: 'demo' })] });

    const exit = await install(['--connect', 'nope', '--yes'], kit);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('USAGE: nope를 위한 커넥터가 없습니다');
    expect(kit.output()).toContain('아는 하네스: demo.');
    expect(kit.written).toEqual([]);
    expect(kit.shimmed).toEqual([]);
    expect(kit.store.prepared).toEqual([]);
    expect(kit.store.doctored).toEqual([]);
  });

  it('exits 1 when a connector refuses, having finished everything else', async () => {
    const broken: MemoryConnector = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json이 JSON이 아닙니다' },
    });
    const kit = harness({ isTTY: false, connectors: [broken] });

    const exit = await install(['--connect', 'demo', '--yes'], kit);

    expect(exit).toBe(1);
    expect(kit.output()).toContain('HARNESS_UNREADABLE: settings.json이 JSON이 아닙니다');
    // The database half of the install still happened and still counts.
    expect(kit.store.prepared).toEqual([STORE]);
    expect(kit.output()).toContain('db: ok');
  });

  it('keeps connecting the other harnesses after one refuses, and fails with its code', async () => {
    const broken: MemoryConnector = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json이 JSON이 아닙니다' },
    });
    const other = memoryConnector({ harness: 'other', label: 'Other' });
    const kit = harness({ isTTY: false, connectors: [broken, other] });

    const result = await resultOf(['--connect', 'demo', '--connect', 'other', '--yes'], kit);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: 'HARNESS_UNREADABLE', exit: 1 });
    expect(installExit(result)).toBe(1);
    // The second harness was still connected, and doctor still had its say.
    expect(other.marked()).toHaveLength(1);
    expect(kit.output()).toContain('Other를 연결했습니다');
    expect(kit.store.doctored).toHaveLength(1);
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
    {
      argv: ['--yes', '--plugin-root', '/Users/me/.claude/plugins/cache/x/second-brain/0.1.0'],
      expected: {
        pluginRoot: '/Users/me/.claude/plugins/cache/x/second-brain/0.1.0',
        connect: [],
        yes: true,
        help: false,
      },
    },
  ])('reads $argv', ({ argv, expected }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.flags).toEqual(expected);
  });

  it.each([
    { argv: ['--plugin-root'], contains: '--plugin-root 뒤에는 경로가 와야 합니다' },
    // Absolute only: the only caller is the plugin launcher, and a relative
    // one would be recorded against whatever directory that hook had.
    { argv: ['--plugin-root', 'plugin'], contains: '절대 경로가 아닙니다' },
    { argv: ['--nope'], contains: '모르는 인자입니다' },
    // The flags the Postgres install needed are gone, and an unknown flag is
    // refused rather than ignored.
    { argv: ['--database-url', 'postgres://x/y'], contains: '모르는 인자입니다' },
    { argv: ['--docker'], contains: '모르는 인자입니다' },
    { argv: ['--store-path'], contains: '뒤에는 경로가 와야 합니다' },
    { argv: ['--store-path', '--yes'], contains: '뒤에는 경로가 와야 합니다' },
    { argv: ['--mirror-path'], contains: '뒤에는 경로가 와야 합니다' },
    { argv: ['--connect'], contains: '뒤에는 하네스 이름이 와야 합니다' },
  ])('refuses $argv', ({ argv, contains }) => {
    const parsed = parseFlags(argv);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain(contains);
  });

  it('prints the usage and exits 2 on an argument it does not know', async () => {
    const kit = harness();

    const exit = await install(['--nope'], kit);

    expect(exit).toBe(2);
    expect(kit.output()).toContain('사용법: second-brain');
    expect(kit.output()).toContain('--store-path <경로>');
    expect(kit.output()).not.toContain('--database-url');
    expect(kit.written).toEqual([]);
  });

  it('prints the usage and exits 0 for --help', async () => {
    const kit = harness();

    expect(await install(['--help'], kit)).toBe(0);
    expect(kit.written).toEqual([]);
  });

  it('runs from flags somebody else parsed, as `brain setup run` does', async () => {
    const kit = harness({ isTTY: false });

    const exit = await installWithFlags(
      { storePath: '/tmp/a/brain.db', connect: [], yes: true, help: false },
      kit,
    );

    expect(exit).toBe(0);
    expect(kit.written).toEqual([fresh('/tmp/a/brain.db')]);
  });
});

/**
 * The last two steps of AD-19, which are what a plugin's `SessionStart` reads:
 * proving the installation answers from outside this process, and only then
 * recording that it did.
 */
describe('the installer flow, proving itself and recording it', () => {
  it('runs the shim after doctor, then writes the record, and reports both', async () => {
    const kit = harness();

    const result = await resultOf([], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Doctor first: its lines are what a person reads to find out what is
    // wrong, and a report cut short by a shim that will not start would hide
    // every check that passed.
    expect(kit.store.doctored).toHaveLength(1);
    expect(kit.installed.verified).toEqual([HOME]);
    expect(kit.installed.wrote).toEqual([
      {
        commit: BUILD_COMMIT,
        schema_version: 5,
        node: PINNED_NODE,
        // Nothing named a plugin folder and nothing was recorded before.
        plugin_root: null,
      },
    ]);
    expect(result.report.installed).toEqual({
      path: join(HOME, 'installed.json'),
      commit: BUILD_COMMIT,
    });
  });

  it('records the plugin folder the install was started from', async () => {
    const kit = harness();

    await installWithFlags(
      { connect: [], yes: true, help: false, pluginRoot: '/plugins/second-brain' },
      kit,
    );

    expect(kit.installed.wrote[0]?.plugin_root).toBe('/plugins/second-brain');
  });

  it('keeps the plugin folder a previous install recorded when nothing names one', async () => {
    // `brain setup run` by hand must not turn a plugin install into one the
    // `plugin` check then says nothing about.
    const kit = harness({
      recordedInstalled: {
        commit: 'f'.repeat(40),
        schema_version: 4,
        node: PINNED_NODE,
        plugin_root: '/plugins/second-brain',
        installed_at: '2026-10-17T00:00:00.000Z',
      },
    });

    await install(['--yes'], kit);

    expect(kit.installed.wrote[0]?.plugin_root).toBe('/plugins/second-brain');
  });

  it('falls back to the schema version this run measured when there is no build.json', async () => {
    const kit = harness({ build: undefined });

    const result = await resultOf([], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kit.installed.wrote[0]).toMatchObject({ commit: null, schema_version: 5 });
    expect(result.report.installed.commit).toBeNull();
  });

  it('is SETUP_INCOMPLETE, and writes no record, when the shim will not answer', async () => {
    const kit = harness({ verifyFails: 'shim이 `ok: true`가 아닌 엔벨로프를 냈습니다' });

    const result = await resultOf([], kit);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ code: 'SETUP_INCOMPLETE', exit: 1 });
    // The record means "this install finished and answered", so a run that
    // could not answer must not leave one: a `SessionStart` would otherwise
    // never try again.
    expect(kit.installed.wrote).toEqual([]);
  });

  it('does not reach the record when doctor already failed', async () => {
    const kit = harness({ store: { walFails: true } });

    const result = await resultOf([], kit);

    expect(result.ok).toBe(false);
    expect(kit.installed.verified).toEqual([]);
    expect(kit.installed.wrote).toEqual([]);
  });
});

describe('the installer flow and automatic updating', () => {
  it('asks, writes the answer, and reports it', async () => {
    // The question after embeddings, answered no: the one new value an install
    // records (AD-19).
    const kit = harness({ tail: { text: ['', ''], confirm: [false, false, true] } });

    const result = await resultOf([], kit);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kit.prompts.asked).toContain('자동 업데이트를 켤까요?');
    expect(kit.written[0]?.updateAuto).toBe(false);
    expect(result.report.update).toEqual({ auto: false });
    expect(kit.output()).toContain('자동 업데이트는 꺼져 있습니다');
  });

  it('offers what the folder already says as the default', async () => {
    const kit = harness({ recorded: true, recordedUpdateAuto: false });

    await install([], kit);

    // Somebody who turned it off once does not have to turn it off again at
    // every re-run, which is what a default of `true` here would mean.
    expect(kit.prompts.initial).toContainEqual(['자동 업데이트를 켤까요?', false]);
  });

  it('keeps the recorded value without asking when there is no terminal', async () => {
    const kit = harness({ isTTY: false, recorded: true, recordedUpdateAuto: false });

    const result = await resultOf(['--yes'], kit);

    expect(kit.prompts.asked).toEqual([]);
    expect(kit.written[0]?.updateAuto).toBe(false);
    expect(result.ok && result.report.update).toEqual({ auto: false });
  });

  it('is on for a first install with nothing recorded and nobody to ask', async () => {
    const kit = harness({ isTTY: false });

    const result = await resultOf(['--yes'], kit);

    expect(kit.written[0]?.updateAuto).toBe(true);
    expect(result.ok && result.report.update).toEqual({ auto: true });
  });
});
