import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Connector, DoctorReport, SqliteMigrationResult } from 'second_brain';
import { formatCheck } from '../commands/doctor-run.js';
import type { SelfUserResult } from './store.js';
import {
  defaultFilesPath,
  defaultMirrorPath,
  defaultStorePath,
  type WriteConfigInput,
} from '../config/codec.js';
import { configFilePath, configHome, envFilePath } from '../config/paths.js';

/**
 * The installer's one flow, as a function of its dependencies. Every question
 * and every write is injected, so the whole I/O matrix can be driven from a test
 * with no terminal and no filesystem — and so `brain setup run` runs this very
 * flow rather than a second one.
 *
 * The order is AD-19's, whole: the harnesses named, consent, what the folder
 * already says, the database file's place, the mirror path, embeddings, the
 * configuration, the database file and its migrations, the file store's root,
 * the shim, the harnesses, doctor.
 */

/**
 * 0 it worked, 1 it ran and something failed, 2 it could not run at all, 3 it
 * needs the consent nobody gave (Conventions). 3 is the one a caller has to
 * tell apart: everything else is this run's own problem, and 3 is a question
 * for the person — which is why `brain setup run` turns it into a
 * `CONFIRMATION_REQUIRED` envelope with the command to run instead.
 */
export type InstallExitCode = 0 | 1 | 2 | 3;

/** One option of a question with a fixed set of answers. */
export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * The questions, behind an interface, because the flow must be testable without
 * a terminal and because a non-interactive run must not be able to reach them
 * by accident: nothing here is called unless `isTTY` is true.
 */
export interface InstallPrompts {
  confirm(question: string, initial: boolean): Promise<boolean>;
  /** Free text. Comes back empty when the user only pressed Enter. */
  text(question: string, placeholder: string): Promise<string>;
  /** Any number of the choices. `initial` is what starts out checked. */
  multiselect<T extends string>(
    question: string,
    choices: readonly Choice<T>[],
    initial: readonly T[],
  ): Promise<readonly T[]>;
}

/**
 * What a configuration folder already says. Everything in it has to be read
 * back and written out again: `writeConfig` renders the whole file from its
 * input, so passing only the database path would quietly reset a time zone, a
 * file store or a mirror the user chose.
 */
export interface RecordedConfig {
  timezone: string;
  /** Absolute. A re-run offers it as the default and must never reset it. */
  storePath: string;
  /** Absolute. Nothing asks for it, so a re-run can only keep it. */
  filesPath: string;
  /** Absolute. A re-run offers it as the default and must never reset it. */
  mirrorPath: string;
}

/** The configuration codec, as the flow uses it (AD-18: only the codec writes). */
export interface InstallConfigIo {
  write(home: string, input: WriteConfigInput): Promise<void>;
  /** What `<home>` already holds, or `undefined` when it holds nothing usable. */
  read(home: string): Promise<RecordedConfig | undefined>;
}

/** The source database: made at the right mode, migrated, then reported on. */
export interface InstallStore {
  /** Create the file at 0600 if it is not there, then migrate it (AD-20). */
  prepare(path: string): Promise<SqliteMigrationResult>;
  /**
   * Record who this brain belongs to, if nobody is yet (AD-12). It is a step
   * of its own and not part of `prepare`, because a migration can do neither
   * half of it: SQL cannot read an operating system user name and cannot mint
   * a UUIDv7. An owner already recorded is left exactly as it is.
   */
  self(path: string): Promise<SelfUserResult>;
  /**
   * The same checks `brain doctor run` runs: the store ones against this
   * file, the machine ones against the home being installed. Both, because an
   * install whose shim or node is wrong is an install that works until the
   * first harness turn.
   */
  doctor(home: string, path: string): Promise<DoctorReport>;
}

/** The file store's root. Blob writes themselves are epic 2's. */
export interface InstallFiles {
  /** Make the root at 0700, or say why it could not. Never throws. */
  prepare(path: string): Promise<
    | { ok: true; path: string; created: boolean }
    | { ok: false; code: 'FILES_UNAVAILABLE'; message: string }
  >;
}

/** Writing the shim, injected so the flow test touches no filesystem. */
export interface InstallShim {
  /** Write `<home>/bin/brain`, or leave it alone when it already says this. */
  write(home: string): Promise<{ path: string; changed: boolean }>;
}

export interface InstallDeps {
  prompts: InstallPrompts;
  /** Both ends are a terminal. Anything else means no question may be asked. */
  isTTY: boolean;
  log(line: string): void;
  config: InstallConfigIo;
  store: InstallStore;
  files: InstallFiles;
  shim: InstallShim;
  /** Every harness this build can connect to. Empty until epic 2. */
  connectors: readonly Connector[];
}

/** The flags a non-interactive run needs, since it cannot be asked anything. */
export interface InstallFlags {
  /** Where the database file goes. `~` is expanded; a relative path is refused. */
  storePath?: string;
  /** Where the mirror goes. `~` is expanded; a relative path is refused. */
  mirrorPath?: string;
  /** Harnesses to connect, by name. The only consent there is without a TTY. */
  connect: readonly string[];
  /** Consent, given in advance, to everything the install has to do. */
  yes: boolean;
  help: boolean;
}

/** How many times a path that cannot be used is asked for again. */
const PATH_ATTEMPTS = 3;

/**
 * Run the installer. `argv` is the user's arguments, without the node and
 * script entries.
 */
export async function runInstallFlow(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: InstallDeps,
): Promise<InstallExitCode> {
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    deps.log(parsed.message);
    for (const line of usage()) deps.log(line);
    return 2;
  }
  const flags = parsed.flags;
  if (flags.help) {
    for (const line of usage()) deps.log(line);
    return 0;
  }

  return runInstall(flags, env, deps);
}

/**
 * The flow itself, from flags that are already parsed. `brain setup run` comes
 * in here with flags commander built, so the installer and the command run the
 * same steps in the same order rather than two readings of the same intent.
 */
export async function runInstall(
  flags: InstallFlags,
  env: NodeJS.ProcessEnv,
  deps: InstallDeps,
): Promise<InstallExitCode> {
  const home = configHome(env);

  // Named before anything is asked or written: a harness nobody registered is
  // a typo, and finding that out after the database is set up would leave the
  // user to guess whether the install took.
  const unknown = flags.connect.filter(
    (name) => !deps.connectors.some((connector) => connector.harness === name),
  );
  if (unknown.length > 0) {
    deps.log(`USAGE: ${unknown.join(', ')}를 위한 커넥터가 없습니다. ${knownHarnesses(deps)}`);
    return 2;
  }

  // A question needs an answer and a place to be read. Without both, `--yes` is
  // the only consent there is, and saying so is the only useful thing left to
  // do (I/O matrix).
  //
  // Exit 3, not 2: nothing about the invocation was wrong, and nothing here is
  // broken — somebody has to agree to what the install does. That is a distinct
  // answer from "could not run", and the whole reason an agent can tell a
  // question for the person from a mistake of its own (Conventions).
  //
  // One branch for both doors: `brain setup run` and the npx installer come
  // through here, so neither can drift into deciding consent differently.
  if (!deps.isTTY && !flags.yes) {
    for (const line of nonInteractiveGuidance()) deps.log(line);
    return 3;
  }

  // Read before anything is asked: what the folder already says is what a
  // re-run offers as its defaults, and what it must not overwrite with them.
  const recorded = await deps.config.read(home);

  const store = await chooseStorePath(flags, home, recorded, deps);
  if (!store.ok) return store.exit;
  deps.log(`데이터베이스 파일은 ${store.path}입니다`);
  // Nothing is moved and nothing is removed (Boundaries): a re-run pointed
  // somewhere else makes a second database, and saying so is all that is owed.
  if (recorded !== undefined && recorded.storePath !== store.path) {
    deps.log(`${recorded.storePath}는 있던 자리에 그대로 둡니다. 아무것도 옮기지 않았습니다.`);
  }

  const mirror = await chooseMirrorPath(flags, home, recorded, deps);
  if (!mirror.ok) return mirror.exit;
  deps.log(`미러는 ${mirror.path}에 둡니다`);

  await askAboutEmbeddings(deps);

  // Nothing asks for the file store's root, so a re-run can only keep what is
  // recorded; a first run takes the default beside the configuration folder.
  const filesPath = recorded?.filesPath ?? defaultFilesPath(home);

  await deps.config.write(home, settings(recorded, store.path, filesPath, mirror.path));
  deps.log(`${configFilePath(home)}과 ${envFilePath(home)}를 썼습니다 (mode 0600)`);

  const migrated = await deps.store.prepare(store.path);
  if (!migrated.ok) {
    deps.log(`${migrated.code}: ${migrated.message}`);
    // Only when there is a file to name: a target that is not a database at all
    // is refused before the first migration is in hand, and "the migration the
    // database refused is ." says less than nothing.
    if (migrated.code === 'MIGRATION_FAILED' && migrated.file !== '') {
      deps.log(`데이터베이스가 거부한 마이그레이션은 ${migrated.file}입니다.`);
    }
    return 1;
  }
  deps.log(
    migrated.applied.length === 0
      ? `스키마는 이미 버전 ${String(migrated.to)}입니다`
      : `${migrated.applied.join(', ')}을 적용했고, 스키마 버전은 ${String(migrated.to)}입니다`,
  );

  // Straight after the migrations, because the `users` table arrives with one,
  // and before anything else, because every session this brain ingests points
  // at this row (AD-12).
  const owner = await deps.store.self(store.path);
  if (!owner.ok) {
    deps.log(`${owner.code}: ${owner.message}`);
    return 1;
  }
  deps.log(
    owner.created
      ? `이 brain은 ${owner.name}의 것입니다`
      : `이미 ${owner.name}의 것입니다`,
  );

  const filesRoot = await deps.files.prepare(filesPath);
  if (!filesRoot.ok) {
    deps.log(`${filesRoot.code}: ${filesRoot.message}`);
    return 1;
  }
  deps.log(
    filesRoot.created
      ? `${filesRoot.path}를 만들었습니다 (mode 0700)`
      : `${filesRoot.path}는 이미 있습니다 (mode 0700)`,
  );

  // The shim before the harnesses, because connecting one means registering
  // this exact path with it.
  const shim = await deps.shim.write(home);
  deps.log(shim.changed ? `${shim.path}을 썼습니다 (mode 0755)` : `${shim.path}은 이미 최신입니다`);

  const connected = await connectHarnesses(flags, shim.path, deps);

  // Doctor has the last word, and its verdict is the exit code: an install that
  // finished every step and still cannot report a healthy brain did not work.
  const report = await deps.store.doctor(home, store.path);
  for (const check of report.checks) deps.log(formatCheck(check));
  return report.checks.some((check) => check.status === 'fail') || !connected ? 1 : 0;
}

/**
 * Everything the folder decided, which is what the codec has to be handed every
 * time: it renders both files whole, so anything left out is written back as
 * its default. That is the trap stories 6 and 7 will meet — a re-run that
 * passed only the database path would silently move the file store and the
 * mirror back under the configuration folder.
 */
function settings(
  recorded: RecordedConfig | undefined,
  storePath: string,
  filesPath: string,
  mirrorPath: string,
): WriteConfigInput {
  return {
    timezone: recorded?.timezone,
    storePath,
    filesPath,
    mirrorPath,
  };
}

/** Chosen path, or the exit code of a run that could not settle on one. */
type ChosenPath = { ok: true; path: string } | { ok: false; exit: 2 };

/**
 * Where this install's database file goes. Nothing here creates it: the file is
 * made at mode 0600 further down the flow, by `store.prepare` (AD-20).
 */
async function chooseStorePath(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<ChosenPath> {
  return choosePath(
    {
      flag: flags.storePath,
      flagName: '--store-path',
      question: '데이터베이스 파일을 어디에 둘까요?',
      fallback: recorded?.storePath ?? defaultStorePath(home),
      what: '데이터베이스 파일',
    },
    deps,
  );
}

/** Where this install's mirror goes. Nothing here creates the folder (epic 4). */
async function chooseMirrorPath(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<ChosenPath> {
  return choosePath(
    {
      flag: flags.mirrorPath,
      flagName: '--mirror-path',
      question: '미러를 어디에 둘까요?',
      fallback: recorded?.mirrorPath ?? defaultMirrorPath(home),
      what: '미러',
    },
    deps,
  );
}

/** One path question: the flag, or the recorded value, or the default. */
interface PathQuestion {
  /** The flag's value, if it was given. Not yet expanded or checked. */
  flag: string | undefined;
  /** How the flag is spelled, for the message that refuses it. */
  flagName: string;
  question: string;
  /** What Enter takes: the recorded value, or this install's default. */
  fallback: string;
  /** What this path is, for the line that gives up on it. */
  what: string;
}

/**
 * Where one of this install's paths goes. Nothing here creates anything: the
 * store and the file store are made further down the flow, and the mirror is
 * epic 4's.
 */
async function choosePath(question: PathQuestion, deps: InstallDeps): Promise<ChosenPath> {
  if (question.flag !== undefined) {
    const given = expandHome(question.flag);
    if (isAbsolute(given)) return { ok: true, path: given };
    deps.log(`CONFIG_INVALID: ${question.flagName} ${question.flag}는 절대 경로가 아닙니다.`);
    // A terminal can be asked again; a script cannot, and taking the default
    // instead would put the path somewhere the flag plainly did not ask for.
    if (!deps.isTTY) return { ok: false, exit: 2 };
  } else if (!deps.isTTY) {
    return { ok: true, path: question.fallback };
  }

  for (let attempt = 1; attempt <= PATH_ATTEMPTS; attempt += 1) {
    const typed = (await deps.prompts.text(question.question, question.fallback)).trim();
    const chosen = typed === '' ? question.fallback : expandHome(typed);
    if (isAbsolute(chosen)) return { ok: true, path: chosen };
    deps.log(`CONFIG_INVALID: ${chosen}는 절대 경로가 아닙니다.`);
  }
  deps.log(
    `${String(PATH_ATTEMPTS)}번 물어도 쓸 수 있는 ${question.what} 경로가 없어서 아무것도 쓰지 않았습니다.`,
  );
  return { ok: false, exit: 2 };
}

/**
 * The embedding question of AD-19, asked and then answered for the user: epic 6
 * owns embeddings, and until it lands saying yes can only mean "not yet". It
 * writes nothing either way — there is no configuration key to write, and
 * inventing one now would be a key epic 6 has to migrate away from.
 */
async function askAboutEmbeddings(deps: InstallDeps): Promise<void> {
  if (!deps.isTTY) {
    deps.log('임베딩은 꺼져 있습니다 (아직 지원하지 않습니다)');
    return;
  }
  const wanted = await deps.prompts.confirm('임베딩을 켤까요?', false);
  deps.log(
    wanted
      ? '임베딩은 아직 지원하지 않으므로 꺼진 채로 둡니다. 아무것도 쓰지 않았습니다.'
      : '임베딩은 꺼져 있습니다',
  );
}

/**
 * Register the shim with the harnesses the user chose. Only `connect` writes a
 * harness's own file (AD-19), so everything here is a question and a log line.
 * Comes back false when a connector refused, which the exit code picks up.
 */
async function connectHarnesses(
  flags: InstallFlags,
  shimPath: string,
  deps: InstallDeps,
): Promise<boolean> {
  if (deps.connectors.length === 0) {
    deps.log('아직 연결할 하네스가 없습니다 (epic 2)');
    return true;
  }

  const chosen = await chooseHarnesses(flags, deps);
  if (chosen.length === 0) {
    deps.log('연결한 하네스가 없습니다');
    return true;
  }

  let allConnected = true;
  for (const connector of chosen) {
    const result = await connector.connect({ shimPath });
    if (!result.ok) {
      deps.log(`${result.code}: ${result.message}`);
      allConnected = false;
      continue;
    }
    deps.log(
      result.changed
        ? `${result.target}에 ${connector.label}를 연결했습니다`
        : `${result.target}에 ${connector.label}가 이미 연결되어 있습니다`,
    );
  }
  return allConnected;
}

/** Which harnesses to connect: the ones checked, or the ones the flags named. */
async function chooseHarnesses(
  flags: InstallFlags,
  deps: InstallDeps,
): Promise<readonly Connector[]> {
  // Without a terminal the flags are the only consent there is, and a harness
  // nobody asked about must not have its configuration written (AD-19).
  if (!deps.isTTY) {
    return deps.connectors.filter((connector) => flags.connect.includes(connector.harness));
  }

  const named = deps.connectors.filter((connector) => flags.connect.includes(connector.harness));
  if (named.length > 0) return named;

  const detected: Connector[] = [];
  for (const connector of deps.connectors) {
    if (await connector.detect()) detected.push(connector);
  }
  if (detected.length === 0) {
    deps.log('이 빌드가 아는 하네스가 여기에 설치되어 있지 않습니다');
    return [];
  }

  // Everything detected starts out checked: connecting is what the user came
  // for, and unchecking is the cheaper correction of the two.
  const answer = await deps.prompts.multiselect(
    '이 brain을 어떤 하네스에 연결할까요?',
    detected.map((connector) => ({ value: connector.harness, label: connector.label })),
    detected.map((connector) => connector.harness),
  );
  return detected.filter((connector) => answer.includes(connector.harness));
}

/**
 * A leading `~` as the user's home directory. A path typed into a question
 * never passes a shell, so nobody expands it but us.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function knownHarnesses(deps: InstallDeps): string {
  if (deps.connectors.length === 0) return '이 빌드는 아직 커넥터를 등록하지 않습니다 (epic 2).';
  return `아는 하네스: ${deps.connectors.map((connector) => connector.harness).join(', ')}.`;
}

export type ParsedFlags =
  | { ok: true; flags: InstallFlags }
  | { ok: false; message: string };

/**
 * The installer's own arguments. It is not a command of the dispatcher, so
 * commander never sees these; there are four of them and an unknown one is
 * refused rather than ignored.
 */
export function parseFlags(argv: readonly string[]): ParsedFlags {
  const connect: string[] = [];
  const flags: InstallFlags = { connect, yes: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--store-path': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--store-path 뒤에는 경로가 와야 합니다.' };
        }
        flags.storePath = value;
        index += 1;
        continue;
      }
      case '--mirror-path': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--mirror-path 뒤에는 경로가 와야 합니다.' };
        }
        flags.mirrorPath = value;
        index += 1;
        continue;
      }
      case '--connect': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--connect 뒤에는 하네스 이름이 와야 합니다.' };
        }
        // Repeatable: one `--connect` per harness, so no separator has to be
        // invented and a name with a comma in it stays one name.
        if (!connect.includes(value)) connect.push(value);
        index += 1;
        continue;
      }
      case '--yes':
      case '-y':
        flags.yes = true;
        continue;
      case '--help':
      case '-h':
        flags.help = true;
        continue;
      default:
        return { ok: false, message: `모르는 인자입니다: ${String(argument)}.` };
    }
  }

  return { ok: true, flags };
}

export function usage(): readonly string[] {
  return [
    '사용법: second-brain [--store-path <경로>] [--mirror-path <경로>]',
    '                     [--connect <하네스>]… [--yes]',
    '  --store-path <경로>   데이터베이스 파일의 절대 경로',
    '  --mirror-path <경로>  미러 폴더의 절대 경로',
    '  --connect <하네스>    이 하네스를 연결합니다. 여럿이면 되풀이하세요',
    '  --yes                 설치가 해야 할 일에 미리 동의합니다',
  ];
}

function nonInteractiveGuidance(): readonly string[] {
  return [
    '터미널이 아니어서 아무것도 물을 수 없습니다. --yes로 미리 동의하세요:',
    '  --yes                        기록된 값이나 기본값으로 설치합니다',
    '  --store-path <경로> --yes    데이터베이스 파일을 다른 곳에 둡니다',
  ];
}
