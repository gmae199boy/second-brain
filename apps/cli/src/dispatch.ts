import { Command, CommanderError } from 'commander';
import { hostname } from 'node:os';
import {
  BUSY_TIMEOUT_MS,
  SQLITE_SCHEMA_VERSION,
  checkSchema,
  createBrain,
  sqliteStore,
  type Brain,
  type Clock,
  type FailureExit,
  type IdGen,
  type SchemaStore,
  type SqliteStoreOptions,
  type Store,
  type WarningCode,
} from 'second_brain';
import { readConfig, type BrainConfig } from './config/codec.js';
import { configHome } from './config/paths.js';
import { runtimeChecks } from './doctor/checks.js';
import { failedConfigStore } from './doctor/store.js';
import { harnessParsers, harnesses } from './harnesses.js';
import { uuidV7IdGen } from './runtime/id-gen.js';
import { readStdin } from './runtime/stdin.js';
import { fileTranscriptReader } from './runtime/transcript.js';
import {
  JSON_FLAG,
  argumentName,
  errorEnvelope,
  okEnvelope,
  retryArgv,
  type CliEnvelope,
  type EnvelopeMeta,
  type Failure,
  type VerbCall,
} from './envelope.js';

/**
 * The one path every command takes. It reads the configuration, builds the SDK,
 * enforces the write guard, assembles the envelope, and decides the exit code,
 * so a command itself does nothing but translate arguments and format output
 * (AD-5). Adding a command means adding a spec to the registry — never
 * repeating any of the above, because a rule repeated thirty times is a rule
 * that will be forgotten once.
 */

/**
 * 0 success, 1 ran but failed or degraded, 2 could not run at all (usage or
 * configuration), 3 needs a confirmation nobody gave. A `hook` command returns
 * 0 whatever happens, confirmation included (AD-6, Conventions).
 *
 * Which number a failure takes is the code table's answer, not this module's:
 * see `ERROR_CODES` in Core, and `FailureExit` for the three a failure may use.
 */
export type ExitCode = 0 | FailureExit;

/** One flag of a command, in commander's own syntax. */
export interface CommandOption {
  /** For example `--json` or `--limit <n>`. */
  flags: string;
  description: string;
}

/** What every command gets, whether or not it has a brain to talk to. */
export interface CommandContextBase {
  /** The one clock. A command that needs a time asks this (AD-13). */
  clock: Clock;
  /** The parsed flags of this invocation, including `json`. */
  options: Record<string, unknown>;
  /** The positional arguments, in the order `arguments` declared them. */
  args: readonly string[];
  /**
   * Everything on standard input, as text. The one thing this CLI reads from
   * there is a harness hook payload, so it is a function and not a value: a
   * command that does not want it must not wait on a pipe nobody is writing
   * to, and a terminal answers with the empty string at once.
   */
  stdin: () => Promise<string>;
}

/** What a command gets. No file, no environment, no connection of its own. */
export interface CommandContext extends CommandContextBase {
  /** The SDK surface. The only thing a command is allowed to call (AD-5). */
  brain: Brain;
  /**
   * The configuration, already read, checked and resolved (AD-18).
   *
   * `undefined` only for a `diagnostic` command that ran without one: every
   * other command is refused with `CONFIG_MISSING` or `CONFIG_INVALID` before
   * it is reached, so a command that needs a value here can say so by failing
   * on the `undefined` rather than by checking anything else.
   */
  config: BrainConfig | undefined;
}

/**
 * What a standalone command gets instead: the environment, because there is no
 * configuration to have read it for them. It is the whole point of being
 * standalone — `setup run` is what writes the configuration, and `setup connect`
 * writes a harness file and never touches the database.
 */
export interface StandaloneCommandContext extends CommandContextBase {
  env: NodeJS.ProcessEnv;
}

/** The command ran. */
export interface CommandSuccess<T> {
  ok: true;
  /** The `data` of the envelope. */
  data: T;
  /** Codes for `warnings[]`. A degraded result must set one (NFR-2). */
  warnings?: readonly WarningCode[];
  /** Lines for the human-readable output. The command owns their shape. */
  text?: readonly string[];
  /**
   * What the result is, beside the result itself: a count, a page marker, the
   * call that carries on from here (Conventions).
   */
  meta?: EnvelopeMeta;
  /** The command ran and the outcome is a failure: exit 1, envelope still ok. */
  failed?: boolean;
}

/**
 * The command did not produce a result. Only `code` and `message` are the
 * command's to supply: the exit code, the retryability and the hint come from
 * the code table unless this one failure names its own (Core `ERROR_CODES`).
 *
 * `code` stays a string rather than the union of known codes, because a
 * connector names its own (`ports/connector.ts`) and the envelope handles a
 * code the table does not know by exiting 1 and adding no hint.
 */
export interface CommandFailure {
  ok: false;
  code: string;
  message: string;
  /**
   * 1 = ran and failed, 2 = could not run, 3 = needs confirmation. Left out,
   * the code decides — which is the only way thirty commands agree on the exit
   * code of a code. Set it to keep a failure at the number it has always had.
   */
  exit?: FailureExit;
  /** Whether running it again can work. Left out, the code decides. */
  retryable?: boolean;
  /** What to do about it. Left out, the code's own hint is used. */
  hint?: string;
  /**
   * The same call with the consent added, for a gated verb. The dispatcher
   * renders `error.retry_argv` from it and the command's declared arguments;
   * the value itself comes from Core's `requireConfirmation`.
   */
  retry?: VerbCall;
}

export type CommandOutcome<T> = CommandSuccess<T> | CommandFailure;

/** What every command declares, standalone or not. */
export interface CommandSpecBase {
  /** The namespace, as in `brain <ns> <verb>` (AD-5). */
  ns: string;
  verb: string;
  description: string;
  /** Description of the namespace itself, for `--help`. First one wins. */
  nsDescription?: string;
  options?: readonly CommandOption[];
  /**
   * Positional arguments, in commander's own syntax: `['<harness>']` for a
   * required one, `['[harness]']` for an optional one. They arrive in
   * `context.args` in this order, and a missing required one is a `USAGE`.
   */
  arguments?: readonly string[];
  /**
   * This command runs on a harness hook path, so it must never fail the
   * harness: whatever happens, the exit code is 0 and the failure is one line
   * on stderr (AD-6, Conventions).
   */
  hook?: boolean;
}

/** A command that talks to the brain, which is nearly all of them. */
export interface DatabaseCommandSpec<T = unknown> extends CommandSpecBase {
  standalone?: false;
  /**
   * This command writes to the database, so the dispatcher compares the stored
   * schema version with `SQLITE_SCHEMA_VERSION` first and refuses on a mismatch
   * (AD-20). Read commands leave this unset and are never blocked.
   */
  writes?: boolean;
  /**
   * This command's job is to report on a brain that may be broken, so it runs
   * even when the configuration could not be read: the dispatcher hands it a
   * store that answers `DB_UNAVAILABLE` and a `config` of `undefined` instead
   * of refusing with exit 2 (Decision 2026-10-14). `brain admin doctor` is the
   * one command that sets it — a command that would write, or that needs a
   * path out of the configuration, has nothing useful to do without one.
   */
  diagnostic?: boolean;
  run(context: CommandContext): Promise<CommandOutcome<T>>;
}

/**
 * A command that runs before, or without, a configuration and a database. The
 * dispatcher reads neither for it: `setup run` is the command that writes the
 * configuration in the first place, so reading it first would make every fresh
 * install end in `CONFIG_MISSING`. Everything else — the envelope, the exit
 * code, the hook rule, `--json` — is the same.
 */
export interface StandaloneCommandSpec<T = unknown> extends CommandSpecBase {
  standalone: true;
  run(context: StandaloneCommandContext): Promise<CommandOutcome<T>>;
}

/** A command, as the registry holds it. */
export type CommandSpec<T = unknown> = DatabaseCommandSpec<T> | StandaloneCommandSpec<T>;

/**
 * How the dispatcher opens the database file. The one implementation is
 * `sqliteStore`; the seam exists so a test can see which lock budget the
 * dispatcher chose for an invocation without opening a file (AD-7).
 */
export type CreateStore = (options: SqliteStoreOptions) => Store & SchemaStore;

export interface DispatchRuntime {
  clock: Clock;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Defaults to `sqliteStore`, which is what every real invocation uses. */
  createStore?: CreateStore;
  /** Reads the hook payload. Defaults to this process's standard input. */
  stdin?: () => Promise<string>;
  /** Mints row ids. Defaults to UUIDv7, which is what every row carries (AD-8). */
  idGen?: IdGen;
}

/** What `execute` decided, before anything is printed. */
interface Outcome {
  /** `null` when commander already wrote the output, as it does for `--help`. */
  envelope: CliEnvelope<unknown> | null;
  text: readonly string[];
  /** Warning lines for the human-readable output, on stderr. */
  warningLines: readonly string[];
  exit: ExitCode;
}

/**
 * What an envelope needs to know about the invocation it belongs to, beyond
 * the outcome itself: the clock, whether the caller asked for JSON, and the
 * arguments the chosen command declares. The last two exist for `retry_argv` —
 * a retry has to be spelled the way this invocation was.
 */
interface Rendering {
  clock: Clock;
  json: boolean;
  /** The chosen command's `arguments`, in commander's syntax. Empty before one. */
  positional: readonly string[];
}

interface Selection {
  spec: CommandSpec;
  options: Record<string, unknown>;
  args: readonly string[];
}

/**
 * Run one invocation and hand back the exit code. `argv` is the user's
 * arguments, without the node and script entries.
 */
export async function dispatch(
  registry: readonly CommandSpec[],
  argv: readonly string[],
  runtime: DispatchRuntime,
): Promise<ExitCode> {
  const { clock } = runtime;
  const env = runtime.env ?? process.env;
  const stdout =
    runtime.stdout ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const stderr =
    runtime.stderr ??
    ((text: string): void => {
      process.stderr.write(text);
    });

  const json = argv.includes(JSON_FLAG);
  // Which command this is has to be known before anything can go wrong, since
  // a hook command swallows every failure — bad arguments and a missing
  // configuration included.
  const hook = findSpec(registry, argv)?.hook === true;

  let outcome: Outcome;
  try {
    outcome = await execute(registry, argv, { clock, json, positional: [] }, env, {
      createStore: runtime.createStore ?? sqliteStore,
      stdin: runtime.stdin ?? (() => readStdin()),
      idGen: runtime.idGen ?? uuidV7IdGen(),
    });
  } catch (error) {
    // An exception here is a bug, and a bug must still not break the harness.
    if (!hook) throw error;
    stderr(`brain: ${oneLine(error)}\n`);
    return 0;
  }

  // Only a command that could not run, or that failed outright, is swallowed. A
  // hook command that ran and came back degraded still has data and warning
  // codes worth printing — it just must not report the failure as an exit code.
  const failure = outcome.envelope?.error;
  if (hook && failure !== undefined) {
    stderr(`brain: ${failure.code}: ${failure.message}\n`);
    return 0;
  }

  if (outcome.envelope !== null) {
    if (json) {
      stdout(`${JSON.stringify(outcome.envelope)}\n`);
    } else {
      for (const line of outcome.text) stdout(`${line}\n`);
      if (failure !== undefined) {
        stderr(`${failure.code}: ${failure.message}\n`);
        // The hint, indented under the sentence it belongs to (Decision
        // 2026-10-16): text mode reads it instead of the envelope, and a
        // failure whose hint only `--json` carried would be a next step the
        // person at the terminal never sees. The hook path above never gets
        // here — one line is all a harness turn may be told (AD-6).
        if (failure.hint !== undefined && failure.hint !== '') {
          stderr(`  ${failure.hint}\n`);
        }
      }
      for (const line of outcome.warningLines) stderr(`${line}\n`);
    }
  }
  // A hook command never fails the harness, whatever the outcome was (AD-6).
  return hook ? 0 : outcome.exit;
}

/** The parts of the runtime `execute` passes on to a command or to the SDK. */
interface Wiring {
  createStore: CreateStore;
  stdin: () => Promise<string>;
  idGen: IdGen;
}

/** Everything but the printing, so the hook wrapper has one thing to catch. */
async function execute(
  registry: readonly CommandSpec[],
  argv: readonly string[],
  base: Rendering,
  env: NodeJS.ProcessEnv,
  wiring: Wiring,
): Promise<Outcome> {
  const { clock } = base;
  const { createStore, stdin, idGen } = wiring;
  const selected = select(registry, argv);
  if (selected.kind === 'helped') {
    return { envelope: null, text: [], warningLines: [], exit: 0 };
  }
  if (selected.kind === 'usage') {
    // Nothing is read and nothing is connected: the command never ran.
    return failed(base, { code: 'USAGE', message: selected.message, exit: 2 }, [], []);
  }

  const { spec, options, args } = selected.selection;
  const rendering: Rendering = { ...base, positional: spec.arguments ?? [] };

  // Right after the choice and before anything is read, opened or run: a
  // positional argument is an id, and an id that is empty or carries control
  // characters is a broken command line rather than a thing to look up.
  const unusable = unusableArgument(rendering.positional, args);
  if (unusable !== undefined) {
    return failed(rendering, { code: 'USAGE', message: unusable, exit: 2 }, [], []);
  }

  // Before the configuration, because this command may be the one that writes
  // it, and before the store, because it has no database to reach.
  if (spec.standalone === true) {
    return finish(rendering, await spec.run({ env, clock, options, args, stdin }), [], []);
  }

  const home = configHome(env);
  const config = await readConfig(home);
  if (!config.ok && spec.diagnostic !== true) {
    return failed(rendering, { code: config.code, message: config.message, exit: 2 }, [], []);
  }

  const warningCodes = config.ok ? config.warnings.map((warning) => warning.code) : [];
  const warningLines = config.ok
    ? config.warnings.map((warning) => `경고: ${warning.message}`)
    : [];

  // The file is opened, never created: a runtime command that made an empty
  // database would report a healthy brain to somebody who has not installed one
  // (AD-20). A hook on the critical path of a turn gets the shorter lock budget,
  // because the person is waiting on it (AD-7).
  //
  // Without a configuration there is no path to open, so a `diagnostic` command
  // gets a store that says exactly that: the report then carries the machine
  // checks as well, which is the point of running at all (Decision 2026-10-14).
  const store = config.ok
    ? createStore({
        path: config.config.storePath,
        busyTimeoutMs: spec.hook === true ? BUSY_TIMEOUT_MS.turn : BUSY_TIMEOUT_MS.command,
      })
    // No `config.message` in here: the `config` check carries it, and the same
    // sentence printed twice in one report reads as two problems.
    : failedConfigStore('설정을 읽을 수 없어서 데이터베이스 위치를 알 수 없습니다');
  const brain = createBrain({
    store,
    schemaVersion: SQLITE_SCHEMA_VERSION,
    clock,
    idGen,
    // The ingest registry, not the connector one: a harness can be ingested
    // from before anything has written its hook entry (see `harnesses.ts`).
    parsers: harnessParsers(harnesses),
    transcripts: fileTranscriptReader(),
    // Recorded on every session this machine ingests (AD-12). The host name,
    // because it is the one name a person reading a report would recognise.
    machine: hostname(),
    // One list, for the dispatcher and the installer both: see `doctor/checks`.
    checks: runtimeChecks({ home, config }),
  });
  try {
    if (spec.writes === true) {
      // The write guard of AD-20, in the one place that cannot be skipped by
      // forgetting it. Epic 2 turns this refusal into a spool.
      const schema = await checkSchema(store, SQLITE_SCHEMA_VERSION);
      if (!schema.ok) {
        // Exit 1 is named rather than left to the code table: this refusal has
        // always exited 1, and the table puts `DB_UNAVAILABLE` at 2. Epic 2
        // turns the refusal into a spool, which settles the question.
        return failed(
          rendering,
          { code: schema.code, message: schema.message, exit: 1 },
          [...warningCodes, schema.code],
          warningLines,
        );
      }
    }

    const outcome = await spec.run({
      brain,
      config: config.ok ? config.config : undefined,
      clock,
      options,
      args,
      stdin,
    });
    return finish(rendering, outcome, warningCodes, warningLines);
  } finally {
    await brain.close();
  }
}

/** One command's outcome as an `Outcome`, the same way for every command. */
function finish(
  rendering: Rendering,
  outcome: CommandOutcome<unknown>,
  warningCodes: readonly WarningCode[],
  warningLines: readonly string[],
): Outcome {
  if (!outcome.ok) {
    const { ok: _ran, ...failure } = outcome;
    return failed(rendering, failure, warningCodes, warningLines);
  }

  const commandWarnings = outcome.warnings ?? [];
  return {
    envelope: okEnvelope(
      rendering.clock,
      outcome.data,
      [...warningCodes, ...commandWarnings],
      outcome.meta,
    ),
    text: outcome.text ?? [],
    warningLines: [...warningLines, ...commandWarnings.map((code) => `경고: ${code}`)],
    exit: outcome.failed === true ? 1 : 0,
  };
}

/**
 * One failure as an `Outcome`. The exit code is read back out of the envelope
 * rather than decided a second time here, which is what makes `error.exit_code`
 * and the process's own exit code the same number by construction.
 *
 * `retry_argv` is added here and nowhere else: Core decided the call, and the
 * command's declared arguments — which only the registry knows — say which of
 * its keys go on the command line bare and which as flags.
 */
function failed(
  rendering: Rendering,
  failure: Failure,
  warnings: readonly WarningCode[],
  warningLines: readonly string[],
): Outcome {
  const envelope: CliEnvelope<never> = errorEnvelope(rendering.clock, failure, warnings);
  const error = envelope.error;
  if (error?.retry !== undefined) {
    error.retry_argv = retryArgv(error.retry, rendering.positional, rendering.json);
  }
  return {
    envelope,
    text: [],
    warningLines,
    exit: error?.exit_code ?? 1,
  };
}

/**
 * Characters that must never reach a command inside a positional argument: C0
 * and C1 controls (ESC among them), the zero-width ones, the line and
 * paragraph separators, and the bidirectional overrides. Every positional
 * argument of this CLI is an id — a body is read from stdin, never typed as an
 * argument — so none of these can be anything but a broken command line, a
 * pasted terminal escape, or a name built to read as something it is not. The
 * separators are in here with the controls because text-mode output is one
 * line per thing, and an id carrying one would split a line in two.
 */
const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

/**
 * Why one of these positional arguments cannot be used, or `undefined` when
 * they are all fine. The empty case is worth its own sentence: an empty
 * argument is almost always a shell capture that came back empty — `brain
 * setup connect "$(…)"` — and a command that went looking for the id "" would
 * answer "not found" to what is really a broken command line.
 */
function unusableArgument(
  positional: readonly string[],
  args: readonly string[],
): string | undefined {
  for (const [index, value] of args.entries()) {
    const name = argumentName(positional[index] ?? `${String(index + 1)}번째 인자`);
    if (value.trim() === '') {
      return `${name} 인자가 비어 있습니다. 위치 인자는 id이므로, 빈 값은 보통 아무것도 내놓지 못한 셸 치환입니다.`;
    }
    if (CONTROL_CHARACTERS.test(value)) {
      return `${name} 인자에 제어 문자나 보이지 않는 문자가 있습니다. 이 brain의 어떤 id에도 그런 문자는 없습니다.`;
    }
  }
  return undefined;
}

type Selected =
  | { kind: 'selected'; selection: Selection }
  /** commander printed help or the version; there is nothing to add. */
  | { kind: 'helped' }
  | { kind: 'usage'; message: string };

/**
 * Turn the registry into a commander tree and find out which command this
 * invocation asked for. The actions only record the choice: running it here
 * would put the configuration and the write guard inside commander's parse,
 * where a failure has nowhere sensible to go.
 */
function select(registry: readonly CommandSpec[], argv: readonly string[]): Selected {
  let selection: Selection | undefined;
  const program = buildProgram(registry, (chosen) => {
    selection = chosen;
  });

  try {
    program.parse([...argv], { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      return { kind: 'helped' };
    }
    return { kind: 'usage', message: usageMessage(registry, error) };
  }

  if (selection === undefined) {
    return { kind: 'usage', message: usageMessage(registry, undefined) };
  }
  return { kind: 'selected', selection };
}

function buildProgram(
  registry: readonly CommandSpec[],
  onSelect: (selection: Selection) => void,
): Command {
  const program = quiet(new Command().name('brain').description('Personal Brain 명령줄'));

  const namespaces = new Map<string, Command>();
  for (const spec of registry) {
    let namespace = namespaces.get(spec.ns);
    if (namespace === undefined) {
      namespace = quiet(
        program.command(spec.ns).description(spec.nsDescription ?? `${spec.ns} 명령`),
      );
      namespaces.set(spec.ns, namespace);
    }

    const command = quiet(namespace.command(spec.verb).description(spec.description));
    command.option(JSON_FLAG, '기계가 읽는 응답 엔벨로프를 출력합니다');
    for (const option of spec.options ?? []) {
      command.option(option.flags, option.description);
    }
    const positional = spec.arguments ?? [];
    for (const argument of positional) command.argument(argument);
    // Commander hands the declared arguments in first, then the options, then
    // the command itself; an optional one that was not given arrives undefined.
    command.action((...given: unknown[]) => {
      const args = given
        .slice(0, positional.length)
        .filter((value): value is string => typeof value === 'string');
      onSelect({ spec, options: command.opts(), args });
    });
  }

  return program;
}

/**
 * Commander must not exit the process or write its own error text: the exit
 * code and the `USAGE` envelope are this module's to decide. Help still goes
 * out through `writeOut`, untouched.
 */
function quiet(command: Command): Command {
  return command
    .exitOverride()
    .showHelpAfterError(false)
    // `brain help …` would print help and then fail, writing a second thing to
    // stdout after the envelope. `-h`/`--help` is the one help path; `help` is
    // just a command nobody registered.
    .helpCommand(false)
    // The one flag every command carries whether or not it declared it, so its
    // description is written here rather than in thirty registry entries.
    .helpOption('-h, --help', '이 명령의 도움말을 보여 줍니다')
    // Commander writes its section headings itself, and `styleTitle` is the one
    // place it hands them over (`Usage:`, `Options:`, …). Anything it adds
    // later falls through untranslated rather than disappearing.
    .configureHelp({ styleTitle: (title: string) => HELP_TITLES[title] ?? title })
    .configureOutput({ writeErr: () => {} });
}

/** Commander's own section headings, in Korean. */
const HELP_TITLES: Readonly<Record<string, string>> = {
  'Usage:': '사용법:',
  'Arguments:': '인자:',
  'Options:': '옵션:',
  'Global Options:': '전체 옵션:',
  'Commands:': '명령:',
};

/**
 * What commander refused, said in Korean. Its own messages are English and
 * built from a template, so they are not translated but replaced: the code is
 * the stable fact, and the values worth keeping — the option, the argument, the
 * command it named — travel in quotes inside its message (Conventions, output
 * language).
 */
const COMMANDER_REASONS: Readonly<Record<string, string>> = {
  'commander.unknownOption': '모르는 옵션입니다',
  'commander.unknownCommand': '모르는 명령입니다',
  'commander.missingArgument': '반드시 주어야 하는 인자가 빠졌습니다',
  'commander.optionMissingArgument': '옵션에 값이 빠졌습니다',
  'commander.missingMandatoryOptionValue': '반드시 주어야 하는 옵션이 빠졌습니다',
  'commander.conflictingOption': '함께 쓸 수 없는 옵션입니다',
  'commander.excessArguments': '인자가 너무 많습니다',
  'commander.invalidArgument': '인자 값이 올바르지 않습니다',
};

function usageMessage(registry: readonly CommandSpec[], error: CommanderError | undefined): string {
  const known = registry.map((spec) => `${spec.ns} ${spec.verb}`).join(', ');
  return `${usageReason(error)}. 사용법: brain <ns> <verb> [--json]. 아는 명령: ${known}.`;
}

/**
 * Why this invocation did not name a command to run.
 *
 * `commander.help` is the help commander prints when no command was given; its
 * own message is a placeholder, so say what happened instead. A code this table
 * does not know keeps commander's own sentence after a Korean one: inventing a
 * translation for a message nobody here has read would say less than the
 * original does (Boundaries).
 */
function usageReason(error: CommanderError | undefined): string {
  if (error === undefined || error.code === 'commander.help') return '명령이 없습니다';
  const original = error.message.replace(/^error:\s*/, '').replace(/\s+/g, ' ').trim();
  const reason = COMMANDER_REASONS[error.code];
  if (reason === undefined) return `명령을 읽을 수 없습니다: ${original}`;
  // Everything commander quoted, in the order it quoted it: the flag, the
  // argument name, the command. The rest of its sentence is the part this
  // table just said in Korean.
  const quoted = [...original.matchAll(/'[^']*'/g)].map(([value]) => value);
  const first = quoted[0];
  const said =
    // "too many arguments for 'connect'" names the command, not the extra
    // argument, so the quoted value goes in front of the sentence: appended
    // after it, it would read as the argument that was one too many.
    error.code === 'commander.excessArguments' && first !== undefined
      ? `${first}에 ${reason}`
      : quoted.length === 0
        ? reason
        : `${reason}: ${quoted.join(', ')}`;
  return withSuggestion(said, original);
}

/**
 * `reason`, plus what commander guessed the person meant. The guess is the most
 * useful half of an unknown-option failure — it is the difference between "that
 * flag does not exist" and "you wrote `--jsn`" — so it is carried over rather
 * than dropped with the rest of the English sentence. Only the flag names are
 * kept: commander's own wording around them is said here instead.
 */
function withSuggestion(reason: string, original: string): string {
  const guessed = /\(Did you mean (.+?)\?\)/.exec(original)?.[1];
  if (guessed === undefined) return reason;
  return `${reason} (혹시 ${guessed.replace(/^one of /, '')}?)`;
}

/**
 * The spec an invocation names, found from the raw arguments. It has to work
 * before commander runs, and for arguments commander will reject, because that
 * is exactly when a hook command still has to exit 0.
 */
function findSpec(
  registry: readonly CommandSpec[],
  argv: readonly string[],
): CommandSpec | undefined {
  const words = argv.filter((argument) => !argument.startsWith('-'));
  const [ns, verb] = words;
  if (ns === undefined || verb === undefined) return undefined;
  return registry.find((spec) => spec.ns === ns && spec.verb === verb);
}

/** The first line of whatever went wrong: a hook failure gets one line. */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '알 수 없는 오류';
}
