import type { OrbStackResult } from '../runtime/orbstack.js';
import type { PostgresInstallResult, PostgresInstallReport } from './postgres.js';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  errorCodeSpec,
  TIMEZONE_SETTING,
  type SettingResult,
  requireConfirmation,
  type Connector,
  type DoctorCheck,
  type DoctorReport,
  type DoctorSummary,
  type Failure,
  type WarningCode,
} from 'second_brain';
import { daemonLiveness } from '../daemon/liveness.js';
import type { DaemonRestartResult } from '../daemon/control.js';
import type { DaemonRegistration } from '../daemon/launchd.js';
import { installedPluginRoot, connectionLines } from '../connectors/plugin.js';
import { formatCheck } from '../commands/doctor-run.js';
import {
  DEFAULT_UPDATE_AUTO,
  DEFAULT_STORE_URL_ENV,
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

/**
 * The installer's one flow, as a function of its dependencies. Every question
 * and every write is injected, so the whole I/O matrix can be driven from a test
 * with no terminal and no filesystem — and so `brain setup run` runs this very
 * flow rather than a second one.
 *
 * The order is: the harnesses named, invocation consent, what the folder
 * already says, OrbStack, mirror path, embeddings, PostgreSQL preparation,
 * timezone, files, configuration, transcript import, shim, harnesses and doctor.
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
  analysis_agent?: string;
  postgres: PostgresInstallReport;
  timezone: string;
  /** The configuration folder this install belongs to. */
  home: string;
  config_path: string;
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
 * Retained for callers that inject a terminal adapter. Installation choices now
 * use recorded values or defaults; the flow never calls these methods.
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
  legacyFileExists(path: string): Promise<boolean>;
  orbstack?: (env: NodeJS.ProcessEnv) => Promise<OrbStackResult>;
  withInstallLock?: <T>(home: string, env: NodeJS.ProcessEnv, run: (env: NodeJS.ProcessEnv) => Promise<T>) => Promise<T>;
  systemTimezone?: () => string;
  detectCodex?: (home: string, env: NodeJS.ProcessEnv) => Promise<string>;
  postgresDoctor?: (home: string, env: NodeJS.ProcessEnv) => Promise<DoctorReport>;
  importTranscripts?: (home: string, env: NodeJS.ProcessEnv) => Promise<import('second_brain').BrainDrainReport>;
  postgres?: (home: string, urlEnv: string, env: NodeJS.ProcessEnv) => Promise<PostgresInstallResult>;
  settings?: {
    get(home: string, urlEnv: string, env: NodeJS.ProcessEnv): Promise<SettingResult>;
    set(home: string, urlEnv: string, env: NodeJS.ProcessEnv, value: string): Promise<SettingResult>;
  };
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
  /** Where the mirror goes. `~` is expanded; a relative path is refused. */
  mirrorPath?: string;
  /** Explicit harnesses to connect; otherwise a first install uses detection. */
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
  if (deps.withInstallLock) return deps.withInstallLock(configHome(env), env, lockedEnv => runInstallLocked(flags, lockedEnv, deps));
  return runInstallLocked(flags, env, deps);
}

async function runInstallLocked(flags: InstallFlags, env: NodeJS.ProcessEnv, deps: InstallDeps): Promise<InstallResult> {
  const home = configHome(env);
  const previousInstall = await deps.installed.read(home);
  const priorConfig = previousInstall ? await deps.config.read(home) : undefined;
  const updating = priorConfig?.ok === true && priorConfig.recorded !== undefined;
  if (updating) {
    flags = { ...flags, yes: true };
    deps.log('기존 설치를 갱신합니다. 저장된 선택을 그대로 사용합니다');
  }
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
  const read = priorConfig ?? await deps.config.read(home);
  if (!read.ok) return fail({ code: read.code, message: read.message, exit: 2 });
  const recorded = read.recorded;
  const urlEnv = recorded?.storeUrlEnv ?? DEFAULT_STORE_URL_ENV;
  if (deps.orbstack === undefined) return fail({ code: 'ORBSTACK_UNAVAILABLE', message: 'OrbStack 확인 단계가 없습니다', exit: 2 });
  const orb = await deps.orbstack(env);
  if (!orb.ok) return fail({ code: 'ORBSTACK_UNAVAILABLE', message: orb.message, hint: orb.hint, exit: 2 });
  for (const warning of read.warnings) {
    warnings.push(warning.code);
    deps.log(`경고: ${warning.message}`);
  }

  const legacyPath = recorded?.legacySqlitePath ?? defaultStorePath(home);
  const mirror = await chooseMirrorPath(flags, home, recorded);
  if (!mirror.ok) return fail(mirror.failure);
  deps.log(`미러는 ${mirror.path}에 둡니다`);

  await reportEmbeddings(deps);

  const updateAuto = await reportUpdates(recorded, deps);

  // Nothing asks for the file store's root, so a re-run can only keep what is
  // recorded; a first run takes the default beside the configuration folder
  // (F10).
  const filesPath = recorded?.filesPath ?? defaultFilesPath(home);

  if (deps.postgres === undefined) return fail({ code: 'DB_UNAVAILABLE', message: 'PostgreSQL 설치 단계가 없습니다', exit: 1 });
  const pg = await deps.postgres(home, urlEnv, env);
  if (!pg.ok) return fail({ code: pg.code, message: pg.message });
  const postgres = pg.report;
  postgres.legacy_sqlite_path = await deps.legacyFileExists(legacyPath) ? legacyPath : null;
  if (postgres.legacy_sqlite_path !== null) deps.log(`옛 SQLite 파일 ${legacyPath}는 지우지 않았고 더 쓰지 않습니다`);
  const owner = { name: postgres.owner_name, created: postgres.owner_created };
  deps.log(`PostgreSQL ${postgres.project}: 스키마 ${postgres.schema_version}, 적용 ${postgres.applied.length}건`);
  let timezone = recorded?.timezone ?? (deps.systemTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  {
    if (deps.settings === undefined) return fail({ code: 'DB_UNAVAILABLE', message: 'PostgreSQL 설정 단계가 없습니다', exit: 1 });
    const current = await deps.settings.get(home, urlEnv, env);
    if (!current.ok) return fail({ code: current.code, message: current.message });
    const fallback = current.source === 'db' ? current.value : timezone;
    const checked = TIMEZONE_SETTING.normalize(fallback);
    if (!checked.ok) return fail({ code: 'CONFIG_INVALID', message: checked.message, exit: 2 });
    timezone = checked.value;
    if (current.source !== 'db' || current.value !== timezone) {
      const written = await deps.settings.set(home, urlEnv, env, timezone);
      if (!written.ok) return fail({ code: written.code, message: written.message });
    }
    deps.log(`시간대: ${timezone} (DB)`);
  }
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
    settings(recorded, filesPath, mirror.path, updateAuto),
  );
  if (!written.ok) {
    return fail({ code: written.code, message: written.message, exit: 1 });
  }
  // Only `.env` is named at 0600: it is the one of the two that holds a key
  // value, and the one the codec tightens. `config.toml` holds no secret.
  deps.log(`${configFilePath(home)}과 ${envFilePath(home)}를 썼습니다 (.env는 mode 0600)`);

  const analysisAgent = deps.detectCodex ? await deps.detectCodex(home, env) : undefined;
  if (analysisAgent) deps.log(analysisAgent);
  postgres.import = null;
  try {
    if (deps.importTranscripts === undefined) throw new Error('transcript 가져오기 단계가 없습니다');
    postgres.import = await deps.importTranscripts(home, env);
    deps.log(postgres.import.scanStopped !== undefined
      ? `경고: ${postgres.import.scanStopped}. 남은 일감은 이후 drain이 이어서 처리합니다`
      : postgres.import.stopped === 'unwritable' || postgres.import.failed > 0 || postgres.import.spoolFailed > 0
        ? '경고: transcript 가져오기에 실패한 일감이 있습니다. 남은 일감은 이후 drain이 이어서 처리합니다'
        : '디스크의 transcript를 가져왔습니다. 남은 일감은 이후 drain이 이어서 처리합니다');
  } catch (error) { deps.log(`경고: transcript를 가져오지 못했습니다. 남은 일감은 이후 drain이 이어서 처리합니다. ${error instanceof Error ? error.message : String(error)}`); }

  // The shim before the harnesses, because connecting one means registering
  // this exact path with it.
  const shim = await deps.shim.write(home);
  deps.log(shim.changed ? `${shim.path}을 썼습니다 (mode 0755)` : `${shim.path}은 이미 최신입니다`);

  const connected = await connectHarnesses(flags, shim.path, deps, home, warnings, !updating);

  // Doctor has the last word, and it runs to the end whatever a connector did:
  // its ten lines are what a person reads to find out what is wrong, and
  // skipping them because a harness file could not be written would hide the
  // half of the install that worked.
  if (deps.postgresDoctor === undefined) return fail({ code: 'DB_UNAVAILABLE', message: 'PostgreSQL 점검 단계가 없습니다', exit: 1 });
  const report = await deps.postgresDoctor(home, env);
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

  const previous = previousInstall;
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
    // Record the PG core version this installation actually measured.
    schema_version: postgres.schema_version,
    ...(build?.schema_versions === undefined ? {} : { schema_versions: build.schema_versions }),
    node: shim.node,
    plugin_root: flags.pluginRoot ?? previous?.plugin_root ?? null,
  });
  deps.log(`${installed.path}에 완료 기록을 썼습니다`);

  return {
    ok: true,
    warnings,
    report: {
      ...(analysisAgent ? { analysis_agent: analysisAgent } : {}),
      home,
      config_path: configFilePath(home),
      timezone,
      postgres,
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
  if (flags.mirrorPath !== undefined) args['mirrorPath'] = flags.mirrorPath;
  if (flags.pluginRoot !== undefined) args['pluginRoot'] = flags.pluginRoot;
  if (flags.connect.length > 0) args['connect'] = [...flags.connect];
  return args;
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
  filesPath: string,
  mirrorPath: string,
  updateAuto: boolean,
): WriteConfigInput {
  const extra = recorded?.extra;
  return {
    timezone: recorded?.timezone,
    storeUrlEnv: recorded?.storeUrlEnv ?? DEFAULT_STORE_URL_ENV,
    filesPath,
    mirrorPath,
    updateAuto,
    ...(extra === undefined || Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

/** Chosen path, or why this run could not settle on one. */
type ChosenPath = { ok: true; path: string } | { ok: false; failure: Failure };

/** Where this install's mirror goes. Nothing here creates the folder (epic 4). */
async function chooseMirrorPath(
  flags: InstallFlags,
  home: string,
  recorded: RecordedConfig | undefined,
): Promise<ChosenPath> {
  const path = flags.mirrorPath === undefined ? recorded?.mirrorPath ?? defaultMirrorPath(home) : expandHome(flags.mirrorPath);
  return isAbsolute(path) ? { ok: true, path } : { ok: false, failure: { code: 'CONFIG_INVALID', message: '--mirror-path는 절대 경로여야 합니다', exit: 2 } };
}

/** 임베딩 런타임은 미지원이며 설치 선택으로 활성화하지 않는다. */
async function reportEmbeddings(deps: InstallDeps): Promise<void> {
  deps.log('임베딩은 꺼져 있습니다 (아직 지원하지 않습니다)');
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
async function reportUpdates(
  recorded: RecordedConfig | undefined,
  deps: InstallDeps,
): Promise<boolean> {
  const auto = recorded?.updateAuto ?? DEFAULT_UPDATE_AUTO;
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
 * Register explicitly named harnesses, or detected harnesses on first install.
 * Updates preserve existing connections unless a new connection was requested.
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
  detect: boolean,
): Promise<Connected> {
  if (deps.connectors.length === 0) {
    deps.log('아직 연결할 하네스가 없습니다 (epic 2)');
    return { connected: [] };
  }

  const chosen = await chooseHarnesses(flags, deps, detect);
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
  detect: boolean,
): Promise<readonly Connector[]> {
  const named = deps.connectors.filter(connector => flags.connect.includes(connector.harness));
  if (flags.connect.length > 0 || !detect) return named;

  const detected: Connector[] = [];
  for (const connector of deps.connectors) {
    if (await connector.detect()) detected.push(connector);
  }
  if (detected.length === 0) {
    deps.log('이 빌드가 아는 하네스가 여기에 설치되어 있지 않습니다');
    return [];
  }

  return detected;
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
    '사용법: second-brain [--mirror-path <경로>]',
    '                     [--plugin-root <경로>] [--connect <하네스>]… [--yes]',
    '  --mirror-path <경로>  미러 폴더의 절대 경로',
    '  --plugin-root <경로>  이 설치를 시작한 플러그인 폴더의 절대 경로',
    '  --connect <하네스>    이 하네스를 연결합니다. 여럿이면 되풀이하세요',
    '  --yes                 설치가 해야 할 일에 미리 동의합니다',
  ];
}
