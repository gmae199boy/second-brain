import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  errorCodeSpec,
  requireConfirmation,
  type Connector,
  type DoctorCheck,
  type DoctorReport,
  type DoctorSummary,
  type Failure,
  type SqliteMigrationResult,
  type SqliteProjectKeyCollision,
  type WarningCode,
} from 'second_brain';
import { daemonLiveness } from '../daemon/liveness.js';
import type { DaemonRestartResult } from '../daemon/control.js';
import { daemonPlistPath, type DaemonRegistration } from '../daemon/launchd.js';
import { installedPluginRoot, connectionLines } from '../connectors/plugin.js';
import { formatCheck } from '../commands/doctor-run.js';
import type { SelfUserResult } from './store.js';
import {
  DEFAULT_UPDATE_AUTO,
  defaultFilesPath,
  defaultMirrorPath,
  defaultStorePath,
  type ReadSetupConfigResult,
  type SetupConfig,
  type WriteConfigInput,
  type WriteConfigResult,
} from '../config/codec.js';
import { configFilePath, configHome, envFilePath } from '../config/paths.js';
import type { BuildIdentity, InstalledFacts, InstalledRecord } from './installed.js';
import { shimPath } from './shim.js';

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

/**
 * What the install did, as a structured report rather than as the lines it
 * printed. The keys are `snake_case` because this is the envelope's `data`
 * (Conventions, CLI `--json` 응답) and `brain setup run --json` hands it over
 * untouched: a caller that had to parse log lines back into facts — which is
 * what `data.lines` made it do — reads a different install than the one that
 * ran the moment a sentence is reworded.
 */
export interface InstallReport {
  /** The configuration folder this install belongs to. */
  home: string;
  config_path: string;
  store: {
    path: string;
    /** The version the file ends at. */
    schema_version: number;
    /** The migration files this run applied. Empty on a re-run. */
    applied: readonly string[];
  };
  owner: { name: string; created: boolean };
  files: { path: string; created: boolean };
  /** Recorded, not created: the folder itself is epic 4's. */
  mirror_path: string;
  shim: { path: string; changed: boolean };
  daemon: Omit<DaemonRegistration, 'message'> & { restarted: boolean };
  /** The harnesses this run registered the shim with. */
  harnesses: readonly { harness: string; target: string; changed: boolean }[];
  checks: readonly DoctorCheck[];
  summary: DoctorSummary;
  /** Whether the plugin may install a newer app on its own (AD-19). */
  update: { auto: boolean };
  /**
   * The completion record this run wrote, once the install proved itself from
   * the outside. A report that said nothing about it would leave the one fact
   * a plugin's `SessionStart` reads unaccounted for.
   */
  installed: { path: string; commit: string | null };
}

/**
 * What the flow answers with: the report, or the failure, and in both cases the
 * warning codes it collected.
 *
 * A value and not an exit code, because an exit code is a number somebody has
 * to look the meaning of up again — which `setup run` did by parsing the log
 * lines backwards, and which is how an install that exited 1 came back as
 * `ok: true` (F6). The doors render this; the flow prints no failure line of
 * its own.
 */
export type InstallResult =
  | { ok: true; report: InstallReport; warnings: readonly WarningCode[] }
  | { ok: false; failure: Failure; warnings: readonly WarningCode[] };

/** `--help` printed the usage; there was no install to report on. */
export interface InstallHelped {
  ok: true;
  helped: true;
}

/** What `runInstallFlow` answers: a result, or the usage it just printed. */
export type InstallFlowResult = InstallResult | InstallHelped;

/** Whether this result is the usage rather than an install. */
export function wasHelped(result: InstallFlowResult): result is InstallHelped {
  return result.ok && 'helped' in result;
}

/**
 * The exit code of one result, decided in one place so the npx entry point and
 * `brain setup run` cannot answer a failure with two different numbers. The
 * rule is the envelope's own: the failure's `exit` when it named one, then the
 * code table's, then 1 (Conventions).
 */
export function installExit(result: InstallFlowResult): InstallExitCode {
  if (result.ok) return 0;
  return result.failure.exit ?? errorCodeSpec(result.failure.code)?.exit ?? 1;
}

/**
 * One failure as the lines a door prints: the coded sentence, and the hint
 * indented under it as every other failure of this CLI prints it (Decision
 * 2026-10-16). The flow prints neither — it hands back the value — and this
 * lives here so the npx entry point and a test read it the same way.
 */
export function failureLines(failure: Failure): readonly string[] {
  const lines = [`${failure.code}: ${failure.message}`];
  const hint = failure.hint ?? errorCodeSpec(failure.code)?.hint;
  if (hint !== undefined && hint !== '') lines.push(`  ${hint}`);
  return lines;
}

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
 *
 * Every value is optional, because the codec reads them one at a time: a value
 * it cannot use is the only one dropped, and this install writes its default
 * for that key alone (AD-18, F1).
 *
 * It is the codec's own `SetupConfig`, under the name the flow calls it by, and
 * not a second shape: the two would have to be kept in step, and the adapter
 * that used to translate between them is what lost the warnings (F1, F2).
 */
export type RecordedConfig = SetupConfig;

/** The configuration codec, as the flow uses it (AD-18: only the codec writes). */
export interface InstallConfigIo {
  /** Both files, whole. Never throws: a failure is a value (`CONFIG_INVALID`). */
  write(home: string, input: WriteConfigInput): Promise<WriteConfigResult>;
  /**
   * What `<home>` already holds, value by value, with a warning for each value
   * it had to drop — or a refusal when the file as a whole cannot be read,
   * which stops the install before a byte is written (F1).
   */
  read(home: string): Promise<ReadSetupConfigResult>;
}

/** The source database: made at the right mode, migrated, then reported on. */
export interface InstallStore {
  /** Create the file at 0600 if it is not there, then migrate it (AD-20). */
  prepare(path: string, options?: { mergeProjects?: boolean }): Promise<SqliteMigrationResult>;
  /**
   * The projects migration 0005 would fold into one comparison key (AD-12).
   *
   * Read-only, and it creates nothing: a path with no database at it answers
   * with no groups. The flow asks before it writes anything, because folding
   * two projects into one deletes rows and nothing may do that unasked.
   */
  collisions(path: string): Promise<readonly SqliteProjectKeyCollision[]>;
  /**
   * Whether there is already a file here. Only the screen that asks for
   * consent uses it: "a new database" and "the database already there" are
   * different promises, and the person agreeing is owed the right one.
   */
  exists(path: string): Promise<boolean>;
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
  write(home: string): Promise<{ path: string; changed: boolean; node: string }>;
}

/**
 * The completion record, and the proof that goes before it (AD-19, AD-20).
 *
 * `verify` is separate from doctor on purpose: doctor says the parts are in
 * place, from inside this process, and `verify` runs the shim from the outside
 * as a harness hook would. An install that passes the first and fails the
 * second is exactly the install that fails on every turn and looks fine in
 * every report, which is what the record is supposed to rule out.
 */
export interface InstallInstalled {
  /** `<home>/bin/brain guide schema --json`: exit 0 and an `ok: true` envelope. */
  verify(home: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /** What this `dist/` was built from, or `undefined` when it cannot say. */
  build(): Promise<BuildIdentity | undefined>;
  /** What a previous install recorded here, for the values a re-run keeps. */
  read(home: string): Promise<InstalledRecord | undefined>;
  /** Write the record, temp file and rename. The time is the writer's. */
  write(home: string, facts: InstalledFacts): Promise<{ path: string }>;
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
  installed: InstallInstalled;
  daemon: {
    register(shim: string, env: NodeJS.ProcessEnv): Promise<DaemonRegistration>;
    restart(plistChanged: boolean, expectCommit: string, env: NodeJS.ProcessEnv): Promise<DaemonRestartResult>;
  };
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
  /**
   * The plugin folder this install was started from, absolute. The bootstrap's
   * hook mode passes it on so the completion record says where the app-ref that
   * asked for this commit lives, which is what the `plugin` check reads. Left
   * out — an `npx` install, or `brain setup run` by hand — keeps whatever a
   * previous install recorded.
   */
  pluginRoot?: string;
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
): Promise<InstallFlowResult> {
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    // The usage goes out as progress lines, because it is what the reader needs
    // next; the refusal itself travels as the value, so the door prints it with
    // its code and its hint exactly once.
    for (const line of usage()) deps.log(line);
    return { ok: false, warnings: [], failure: { code: 'USAGE', message: parsed.message, exit: 2 } };
  }
  const flags = parsed.flags;
  if (flags.help) {
    for (const line of usage()) deps.log(line);
    return { ok: true, helped: true };
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
): Promise<InstallResult> {
  const home = configHome(env);
  const warnings: WarningCode[] = [];
  /** One failure, with whatever warnings had been collected by then. */
  const fail = (failure: Failure): InstallResult => ({ ok: false, failure, warnings });

  // Named before anything is asked or written: a harness nobody registered is
  // a typo, and finding that out after the database is set up would leave the
  // user to guess whether the install took.
  const unknown = flags.connect.filter(
    (name) => !deps.connectors.some((connector) => connector.harness === name),
  );
  if (unknown.length > 0) {
    return fail({
      code: 'USAGE',
      message: `${unknown.join(', ')}를 위한 커넥터가 없습니다. ${knownHarnesses(deps)}`,
      exit: 2,
    });
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
  // Core's gate, called here rather than translated by a command afterwards:
  // `error.retry` is the same call with the consent added, and the one place
  // that knows which arguments this call actually carried is this one. Both
  // doors come through here, so neither can decide consent differently.
  if (!deps.isTTY && !flags.yes) {
    const gate = requireConfirmation(
      { ns: 'setup', verb: 'run', args: givenArgs(flags) },
      NO_TERMINAL,
    );
    // The branch is reached only where nothing gave consent, so the gate is
    // closed; the fallback is there so a later change cannot turn this into a
    // silent success.
    return fail(gate ?? { code: 'CONFIRMATION_REQUIRED', message: NO_TERMINAL });
  }

  // Read before anything is asked: what the folder already says is what a
  // re-run offers as its defaults, and what it must not overwrite with them. A
  // file that cannot be read at all stops the install here, with nothing
  // written: one typo must not cost the keys nothing asks about (F1).
  const read = await deps.config.read(home);
  if (!read.ok) return fail({ code: read.code, message: read.message, exit: 2 });
  const recorded = read.recorded;
  for (const warning of read.warnings) {
    warnings.push(warning.code);
    deps.log(`경고: ${warning.message}`);
  }

  const store = await chooseStorePath(flags, home, recorded, deps);
  if (!store.ok) return fail(store.failure);
  deps.log(`데이터베이스 파일은 ${store.path}입니다`);
  // Nothing is moved and nothing is removed (Boundaries): a re-run pointed
  // somewhere else makes a second database, and saying so is all that is owed.
  if (recorded?.storePath !== undefined && recorded.storePath !== store.path) {
    deps.log(`${recorded.storePath}는 있던 자리에 그대로 둡니다. 아무것도 옮기지 않았습니다.`);
  }

  const mirror = await chooseMirrorPath(flags, home, recorded, deps);
  if (!mirror.ok) return fail(mirror.failure);
  deps.log(`미러는 ${mirror.path}에 둡니다`);

  await askAboutEmbeddings(deps);

  const updateAuto = await askAboutUpdates(recorded, deps);

  // Nothing asks for the file store's root, so a re-run can only keep what is
  // recorded; a first run takes the default beside the configuration folder
  // (F10).
  const filesPath = recorded?.filesPath ?? defaultFilesPath(home);

  // The last moment at which nothing has been written. Every question has an
  // answer, so what the install is about to do can be said in full — and a
  // person who says no here loses nothing, which is the only kind of no worth
  // offering.
  const agreed = await askToProceed(
    { home, storePath: store.path, filesPath, mirrorPath: mirror.path },
    env,
    flags,
    deps,
  );
  if (!agreed) {
    return fail({
      code: 'SETUP_CANCELLED',
      message: '진행하지 않기로 했습니다. 아무것도 쓰지 않았습니다.',
      exit: 1,
    });
  }

  // The one thing this install may have to destroy, asked for on its own
  // (AD-12). Migration 0005 makes the project comparison key `unique`, and a
  // database that split one repository into two projects over nothing but the
  // case of its remote has two rows that become one key. Folding them deletes
  // a row and moves its sessions, which no migration may decide by itself — so
  // the groups are shown, the question is asked, and a no leaves the database
  // exactly as it is, at the version it was.
  //
  // After `askToProceed` and before `prepare`: it is the last question, and it
  // is only worth asking once everything else is agreed.
  const collisions = await deps.store.collisions(store.path);
  if (collisions.length > 0) {
    for (const group of collisions) {
      const kept = group.projects[0];
      deps.log(
        `비교 키 ${group.identityKey}로 겹치는 프로젝트가 ` +
          `${String(group.projects.length)}개 있습니다:`,
      );
      for (const project of group.projects) {
        deps.log(`  ${project.remoteIdentity} (세션 ${String(project.sessions)}건)`);
      }
      if (kept !== undefined) deps.log(`  남는 쪽은 ${kept.remoteIdentity}입니다`);
    }
    // `--yes` is every consent given in advance, which is what it means
    // everywhere else in this flow — including the plugin's non-interactive
    // bootstrap (README).
    const agreedToMerge =
      flags.yes ||
      (await deps.prompts.confirm(
        `겹치는 프로젝트 ${String(collisions.length)}묶음을 하나로 합칠까요?`,
        true,
      ));
    if (!agreedToMerge) {
      return fail({
        code: 'SETUP_CANCELLED',
        message: '프로젝트를 합치지 않기로 했습니다. 데이터베이스는 바꾸지 않았습니다.',
        exit: 1,
      });
    }
  }

  // The store, the owner and the file store's root before the configuration:
  // what is recorded has to be a place this run has actually managed to use,
  // or one bad `--store-path` would overwrite the path that worked (F3).
  const migrated = await deps.store.prepare(
    store.path,
    collisions.length > 0 ? { mergeProjects: true } : {},
  );
  if (!migrated.ok) {
    return fail({
      code: migrated.code,
      // Only when there is a file to name: a target that is not a database at
      // all is refused before the first migration is in hand, and "the
      // migration the database refused is ." says less than nothing.
      message:
        migrated.code === 'MIGRATION_FAILED' && migrated.file !== ''
          ? `${migrated.message} 데이터베이스가 거부한 마이그레이션은 ${migrated.file}입니다.`
          : migrated.message,
      // Named rather than left to the table, which puts `DB_UNAVAILABLE` at 2:
      // this install ran and this step failed, which has always been a 1.
      exit: 1,
    });
  }
  deps.log(
    migrated.applied.length === 0
      ? `스키마는 이미 버전 ${String(migrated.to)}입니다`
      : `${migrated.applied.join(', ')}을 적용했고, 스키마 버전은 ${String(migrated.to)}입니다`,
  );
  // Said after the fact, not before: the merge happened inside the migration's
  // own transaction, so this line is the one place that can say it took.
  if (collisions.length > 0) {
    deps.log(`겹치는 프로젝트 ${String(collisions.length)}묶음을 하나로 합쳤습니다`);
  }

  // Straight after the migrations, because the `users` table arrives with one,
  // and before anything else, because every session this brain ingests points
  // at this row (AD-12).
  const owner = await deps.store.self(store.path);
  if (!owner.ok) return fail({ code: owner.code, message: owner.message, exit: 1 });
  deps.log(
    owner.created
      ? `이 brain은 ${owner.name}의 것입니다`
      : `이미 ${owner.name}의 것입니다`,
  );

  const filesRoot = await deps.files.prepare(filesPath);
  if (!filesRoot.ok) {
    return fail({ code: filesRoot.code, message: filesRoot.message, exit: 1 });
  }
  deps.log(
    filesRoot.created
      ? `${filesRoot.path}를 만들었습니다 (mode 0700)`
      : `${filesRoot.path}는 이미 있습니다 (mode 0700)`,
  );

  // Now, and not before: every path in here is one this run has used. The
  // mirror is the exception and has nothing to prove — nobody creates it yet
  // (epic 4) — so it is recorded as chosen.
  const written = await deps.config.write(
    home,
    settings(recorded, store.path, filesPath, mirror.path, updateAuto),
  );
  if (!written.ok) {
    return fail({ code: written.code, message: written.message, exit: 1 });
  }
  // Only `.env` is named at 0600: it is the one of the two that holds a key
  // value, and the one the codec tightens. `config.toml` holds no secret.
  deps.log(`${configFilePath(home)}과 ${envFilePath(home)}를 썼습니다 (.env는 mode 0600)`);

  // The shim before the harnesses, because connecting one means registering
  // this exact path with it.
  const shim = await deps.shim.write(home);
  deps.log(shim.changed ? `${shim.path}을 썼습니다 (mode 0755)` : `${shim.path}은 이미 최신입니다`);

  const connected = await connectHarnesses(flags, shim.path, deps, home, warnings);

  // Doctor has the last word, and it runs to the end whatever a connector did:
  // its ten lines are what a person reads to find out what is wrong, and
  // skipping them because a harness file could not be written would hide the
  // half of the install that worked.
  const report = await deps.store.doctor(home, store.path);
  for (const check of report.checks) deps.log(formatCheck(check));

  // A connector's own code wins, because it is the more specific thing that
  // went wrong; `SETUP_INCOMPLETE` is for an install whose every step took and
  // whose closing checks still do not pass.
  if (connected.failure !== undefined) return fail(connected.failure);
  const failed = report.checks.filter((check) => check.status === 'fail');
  if (failed.length > 0) {
    return fail({
      code: 'SETUP_INCOMPLETE',
      message: `설치는 끝까지 돌았고 점검 ${failed.map((check) => check.id).join(', ')}이 실패했습니다.`,
      exit: 1,
    });
  }

  // The last step, and the only one that runs the installation from outside
  // this process: the shim, the node it pinned, the entry point it names and
  // the CLI behind them, as a harness hook would reach them (AD-19).
  //
  // After doctor rather than instead of it: doctor's lines are what a person
  // reads to find out what is wrong, and a report cut short because the shim
  // would not start would hide every check that passed.
  const verified = await deps.installed.verify(home);
  if (!verified.ok) {
    return fail({
      code: 'SETUP_INCOMPLETE',
      message: `설치는 끝까지 돌았고 shim으로 확인하지 못했습니다. ${verified.message}`,
      exit: 1,
    });
  }

  const previous = await deps.installed.read(home);
  const build = await deps.installed.build();
  const registration = await deps.daemon.register(shim.path, env);
  const { message: daemonMessage, ...registered } = registration;
  const daemon = { ...registered, restarted: false };
  switch (daemon.status) {
    case 'registered':
      deps.log('데몬을 launchd에 등록했습니다');
      break;
    case 'loaded':
      deps.log(daemon.plist_changed
        ? '데몬이 이미 올라 있습니다. 새 plist는 다음 로그인이나 Label을 내린 뒤 다시 등록할 때 읽습니다. 프로세스만 다시 뜨면 기존 실행 인자를 유지합니다'
        : '데몬이 이미 올라 있습니다');
      break;
    case 'unsupported':
      deps.log('이 운영체제에는 launchd가 없어 데몬 등록을 건너뜁니다');
      break;
    case 'failed':
      warnings.push('DAEMON_NOT_REGISTERED');
      deps.log(`데몬을 등록하지 못했습니다. ${daemonMessage ?? ''}`);
      break;
  }

  const running = daemon.status === 'loaded' && build?.commit != null
    ? await daemonLiveness({ home, clock: { now: () => new Date() } }) : null;
  // Heartbeat health does not change whether the old process needs a restart.
  const ownerAlive = running !== null && (running.alive || (running.reason !== 'no-lock' && running.reason !== 'pid-dead'));
  if (ownerAlive && build?.commit != null && running.commit !== build.commit) {
    const restarted = await deps.daemon.restart(daemon.plist_changed, build.commit, env);
    daemon.restarted = restarted.ok;
    if (restarted.ok) deps.log('데몬을 새 빌드로 다시 띄웠습니다');
    else {
      warnings.push('DAEMON_NOT_RESTARTED');
      deps.log(`데몬을 다시 띄우지 못했습니다. 데몬을 새 빌드로 다시 띄우지 못해 옛 빌드가 계속 돌 수 있습니다. ${restarted.message}`);
    }
  }

  // Only now, and only here: `installed.json` means "this install finished and
  // answered", so it is written after the proof and never before it. A plugin's
  // `SessionStart` compares the commit it carries against this record, and a
  // record written for an install that does not run would stop every future
  // session from repairing it.
  const installed = await deps.installed.write(home, {
    commit: build?.commit ?? null,
    // The build's version when there is one; otherwise the version the file
    // actually ends at, which this run has just measured.
    schema_version: build?.schema_version ?? migrated.to,
    node: shim.node,
    plugin_root: flags.pluginRoot ?? previous?.plugin_root ?? null,
  });
  deps.log(`${installed.path}에 완료 기록을 썼습니다`);

  return {
    ok: true,
    warnings,
    report: {
      home,
      config_path: configFilePath(home),
      store: { path: store.path, schema_version: migrated.to, applied: migrated.applied },
      owner: { name: owner.name, created: owner.created },
      files: { path: filesRoot.path, created: filesRoot.created },
      mirror_path: mirror.path,
      shim: { path: shim.path, changed: shim.changed },
      daemon,
      harnesses: connected.connected,
      checks: report.checks,
      summary: report.summary,
      update: { auto: updateAuto },
      installed: { path: installed.path, commit: build?.commit ?? null },
    },
  };
}

/**
 * The one sentence a run with nothing to ask and nobody to ask can say. It is
 * the failure's `message` on both doors, so the envelope and the terminal say
 * the same thing (Conventions, output language).
 */
const NO_TERMINAL = '터미널이 아니어서 아무것도 물을 수 없습니다. --yes로 미리 동의하세요';

/**
 * The arguments this invocation actually gave, as `error.retry` carries them:
 * not the defaults the flow would fall back to, not `--json`, and not `--yes` —
 * the consent travels as `confirm`, which is the one name it has on every
 * surface (Conventions). So a retry asks for this very install, not a wider one.
 */
function givenArgs(flags: InstallFlags): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (flags.storePath !== undefined) args['storePath'] = flags.storePath;
  if (flags.mirrorPath !== undefined) args['mirrorPath'] = flags.mirrorPath;
  if (flags.pluginRoot !== undefined) args['pluginRoot'] = flags.pluginRoot;
  if (flags.connect.length > 0) args['connect'] = [...flags.connect];
  return args;
}

/** The four places this install has settled on, for the screen that asks. */
interface Settled {
  home: string;
  storePath: string;
  filesPath: string;
  mirrorPath: string;
}

/**
 * Show what the install is about to do, and ask once (AD-19's consent, in the
 * terminal). It is the last step before the first write, so a no costs
 * nothing — which is why the question is worth asking at all.
 *
 * `--yes` skips this one question and nothing else: the path questions are
 * about what to install, and this one is about whether to. Without a terminal
 * there is nothing to show and nobody to answer, and the consent gate above has
 * already turned that into an exit 3.
 */
async function askToProceed(
  settled: Settled,
  env: NodeJS.ProcessEnv,
  flags: InstallFlags,
  deps: InstallDeps,
): Promise<boolean> {
  if (!deps.isTTY || flags.yes) return true;

  deps.log('이제 이것들을 씁니다.');
  deps.log(
    `  설정 파일 ${configFilePath(settled.home)}과 ${envFilePath(settled.home)} (.env는 mode 0600)`,
  );
  deps.log(
    (await deps.store.exists(settled.storePath))
      ? `  이미 있는 데이터베이스 ${settled.storePath}를 마이그레이션합니다`
      : `  데이터베이스 ${settled.storePath}를 새로 만듭니다 (mode 0600)`,
  );
  deps.log(`  파일 저장소 루트 ${settled.filesPath} (mode 0700)`);
  deps.log(`  하네스 hook이 부를 shim ${shimPath(settled.home)} (mode 0755)`);
  deps.log(`  로그인 때 데몬을 띄울 plist ${daemonPlistPath(env)} (mode 0644)`);
  // The mirror is recorded and not created, so it is not on the list of what
  // this run writes (epic 4).
  deps.log(`  미러 경로 ${settled.mirrorPath}는 적어 두기만 하고 폴더는 만들지 않습니다`);

  return deps.prompts.confirm('이대로 진행할까요?', true);
}

/**
 * Everything the folder decided, which is what the codec has to be handed every
 * time: it renders both files whole, so anything left out is written back as
 * its default. That is the trap F1 names — a re-run that passed only the
 * database path would silently move the file store and the mirror back under
 * the configuration folder — and `extra` is the same rule for the keys this
 * version does not know (F2).
 */
function settings(
  recorded: RecordedConfig | undefined,
  storePath: string,
  filesPath: string,
  mirrorPath: string,
  updateAuto: boolean,
): WriteConfigInput {
  const extra = recorded?.extra;
  return {
    timezone: recorded?.timezone,
    storePath,
    filesPath,
    mirrorPath,
    updateAuto,
    ...(extra === undefined || Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

/** Chosen path, or why this run could not settle on one. */
type ChosenPath = { ok: true; path: string } | { ok: false; failure: Failure };

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
    const refused = `${question.flagName} ${question.flag}는 절대 경로가 아닙니다.`;
    // A terminal can be asked again; a script cannot, and taking the default
    // instead would put the path somewhere the flag plainly did not ask for.
    if (!deps.isTTY) {
      return { ok: false, failure: { code: 'CONFIG_INVALID', message: refused, exit: 2 } };
    }
    // A progress line and not a failure: the question below is about to offer
    // a way out of it, and a `CODE: …` line for something this run recovers
    // from is a failure the reader then has to un-read.
    deps.log(`${refused} 다시 묻습니다.`);
  } else if (!deps.isTTY) {
    return { ok: true, path: question.fallback };
  }

  for (let attempt = 1; attempt <= PATH_ATTEMPTS; attempt += 1) {
    const typed = (await deps.prompts.text(question.question, question.fallback)).trim();
    const chosen = typed === '' ? question.fallback : expandHome(typed);
    if (isAbsolute(chosen)) return { ok: true, path: chosen };
    deps.log(
      attempt === PATH_ATTEMPTS
        ? `${chosen}는 절대 경로가 아닙니다.`
        : `${chosen}는 절대 경로가 아닙니다. 다시 묻습니다.`,
    );
  }
  return {
    ok: false,
    failure: {
      code: 'CONFIG_INVALID',
      message: `${String(PATH_ATTEMPTS)}번 물어도 쓸 수 있는 ${question.what} 경로가 없어서 아무것도 쓰지 않았습니다.`,
      exit: 2,
    },
  };
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
 * Whether the harness plugin may install a newer app by itself (AD-19). Unlike
 * the embedding question this one is real: the answer is written as
 * `[update] auto`, and it is what the bootstrap's `SessionStart` reads before
 * it fetches anything.
 *
 * The default offered is what the folder already says, so a person who turned
 * it off once does not have to turn it off at every re-run. Without a terminal
 * the recorded value stands — and a first install with nothing recorded gets
 * the codec's default, which is on: the plugin exists so that a session carries
 * its own update.
 */
async function askAboutUpdates(
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<boolean> {
  const initial = recorded?.updateAuto ?? DEFAULT_UPDATE_AUTO;
  const auto = deps.isTTY
    ? await deps.prompts.confirm('자동 업데이트를 켤까요?', initial)
    : initial;
  deps.log(
    auto
      ? '자동 업데이트는 켜져 있습니다. 플러그인이 더 새 앱을 담고 있으면 다음 세션에서 설치합니다'
      : '자동 업데이트는 꺼져 있습니다. 갱신할 것이 있으면 `brain doctor run`이 말합니다',
  );
  return auto;
}

/** What the harness step did: what it registered, and the first refusal. */
interface Connected {
  connected: readonly { harness: string; target: string; changed: boolean }[];
  /** The first connector that refused, as the failure the result carries. */
  failure?: Failure;
}

/**
 * Register the shim with the harnesses the user chose. Only `connect` writes a
 * harness's own file (AD-19), so everything here is a question and a log line.
 *
 * A refusal does not stop the others: the harnesses are independent, and a
 * second one left unconnected because the first had a broken settings file
 * would be two problems where there was one. The first refusal travels on as
 * the failure, with the rest named in its sentence.
 */
async function connectHarnesses(
  flags: InstallFlags,
  shim: string,
  deps: InstallDeps,
  home: string,
  warnings: WarningCode[],
): Promise<Connected> {
  if (deps.connectors.length === 0) {
    deps.log('아직 연결할 하네스가 없습니다 (epic 2)');
    return { connected: [] };
  }

  const chosen = await chooseHarnesses(flags, deps);
  if (chosen.length === 0) {
    deps.log('연결한 하네스가 없습니다');
    return { connected: [] };
  }

  const connected: { harness: string; target: string; changed: boolean }[] = [];
  const refused: { harness: string; code: string; message: string }[] = [];
  const pluginRoot = flags.pluginRoot ?? await installedPluginRoot(home, (folder) => deps.installed.read(folder));
  for (const connector of chosen) {
    const result = await connector.connect({ shimPath: shim, pluginRoot });
    if (!result.ok) {
      refused.push({ harness: connector.harness, code: result.code, message: result.message });
      continue;
    }
    connected.push({
      harness: connector.harness,
      target: result.target,
      changed: result.changed,
    });
    warnings.push(...(result.warnings ?? []));
    for (const line of connectionLines(connector, result, pluginRoot)) deps.log(line);
  }

  const first = refused[0];
  if (first === undefined) return { connected };
  const others = refused.slice(1).map((one) => one.harness);
  return {
    connected,
    failure: {
      code: first.code,
      message:
        others.length === 0
          ? first.message
          : `${first.message} ${others.join(', ')}도 연결하지 못했습니다.`,
      exit: 1,
    },
  };
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
      case '--plugin-root': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-')) {
          return { ok: false, message: '--plugin-root 뒤에는 경로가 와야 합니다.' };
        }
        // Absolute only, and refused rather than expanded: the only caller is
        // the plugin launcher, which passes `CLAUDE_PLUGIN_ROOT` straight on,
        // and a relative one would be recorded against whatever working
        // directory that hook happened to have.
        if (!isAbsolute(value)) {
          return { ok: false, message: `--plugin-root ${value}는 절대 경로가 아닙니다.` };
        }
        flags.pluginRoot = value;
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
    '                     [--plugin-root <경로>] [--connect <하네스>]… [--yes]',
    '  --store-path <경로>   데이터베이스 파일의 절대 경로',
    '  --mirror-path <경로>  미러 폴더의 절대 경로',
    '  --plugin-root <경로>  이 설치를 시작한 플러그인 폴더의 절대 경로',
    '  --connect <하네스>    이 하네스를 연결합니다. 여럿이면 되풀이하세요',
    '  --yes                 설치가 해야 할 일에 미리 동의합니다',
  ];
}
