import { daemonLiveness } from './daemon/liveness.js';
import { Command, CommanderError } from 'commander';
import {
  BUSY_TIMEOUT_MS,
  DRAIN_BUDGET_MS,
  SQLITE_SCHEMA_VERSION,
  checkSchema,
  createBrain,
  encodeHookLine,
  encodeTextLine,
  errorLine,
  spoolSessionIngest,
  sqliteStore,
  type Brain,
  type BrainDependencies,
  type Clock,
  type FailureExit,
  type IdGen,
  type IngestSessionInput,
  type IngestSessionResult,
  type SchemaStore,
  type SpoolCause,
  type SqliteStoreOptions,
  type Store,
  type WarningCode,
  type WorkHandlers,
} from 'second_brain';
import { brainDependencies } from './assembly.js';
import { readConfig, type BrainConfig } from './config/codec.js';
import { configHome } from './config/paths.js';
import { failedConfigStore } from './doctor/store.js';
import { uuidV7IdGen } from './runtime/id-gen.js';
import { recordHookArrival } from './runtime/hook-arrival.js';
import { readStdin } from './runtime/stdin.js';
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
  recordHookArrival: (harness: string) => Promise<void>;
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
 * What a command's `spool` branch gets: no brain, no store, and no
 * configuration — only the invocation itself, why the database is out of
 * reach, and the one function that writes the mark (AD-9, AD-20).
 *
 * The absence is the design. A build where `run` is never called on a
 * mismatched schema cannot write to one by mistake, and a branch that is handed
 * no store cannot write to one at all: the type is what keeps the promise, not
 * the care of whoever adds the next command (Design Notes).
 */
export interface SpoolCommandContext extends CommandContextBase {
  /**
   * Why the guard refused. Both are warning codes as well, so the envelope
   * names them in `warnings[]` beside `SPOOLED` (Conventions).
   */
  cause: 'SCHEMA_MISMATCH' | 'DB_UNAVAILABLE';
  /** What the guard said, for a branch that wants to pass it on. */
  message: string;
  /**
   * Core's `spoolSessionIngest` with this run's spool, clock and id generator
   * already bound. The branch supplies the session and the transcript it read
   * off its own input, and the cause it was given.
   */
  spoolIngest(input: IngestSessionInput, cause: SpoolCause): Promise<IngestSessionResult>;
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
  /**
   * Codes for `warnings[]`, for a command that collected some before it
   * failed. A failure envelope carries them for the same reason a result does:
   * `brain setup run` over a configuration with an unknown key says so whether
   * or not the install then got as far as finishing (NFR-2).
   */
  warnings?: readonly WarningCode[];
}

export type CommandOutcome<T> = CommandSuccess<T> | CommandFailure;

/**
 * How much a command can cost whoever runs it. `read` changes nothing,
 * `write` adds or changes something, `destructive` removes something or
 * changes it in a way nothing here can undo (Conventions).
 */
export type CommandRisk = 'read' | 'write' | 'destructive';

/**
 * What a command says about itself, in the seven fields every one of them
 * declares (Conventions, 명령 메타). It is one place and not several because
 * `--help`, `brain guide schema` and — in epic 9 — the MCP tool schema are all
 * rendered from it: a command described twice is a command whose two
 * descriptions will disagree, and the one an agent happens to read will be the
 * stale one.
 *
 * The JSON spelling is the envelope's, `snake_case`: `used_for`, `dry_run`.
 * `guide schema` does that translation; the type stays `camelCase` like the
 * rest of the TypeScript (Conventions, 이름).
 */
export interface CommandMeta {
  /** One line: what this is for. It is also the `--help` description. */
  usedFor: string;
  /**
   * The names of the inputs a caller must supply: a positional argument or an
   * option by name, and `stdin` for a command that reads a payload from there.
   * Names, not syntax — `harness`, not `<harness>` — because the same list
   * answers for a flag, for an argument and for standard input.
   */
  required: readonly string[];
  /** Whole command lines, starting `brain <ns> <verb>`. */
  examples: readonly string[];
  /** One line about the shape of `data`. */
  output: string;
  risk: CommandRisk;
  /**
   * This command runs on a harness hook path, so it must never fail the
   * harness: whatever happens, the exit code is 0 and the failure is one line
   * on stderr (AD-6, Conventions).
   */
  hook: boolean;
  /**
   * This command takes `--dry-run` and will say what it would do without doing
   * it. Every command of this build sets it false; the field is declared
   * anyway, because "this cannot be rehearsed" is an answer an agent needs and
   * an absent field is not one.
   */
  dryRun: boolean;
}

/** What every command declares, standalone or not. */
export interface CommandSpecBase extends CommandMeta {
  /** The namespace, as in `brain <ns> <verb>` (AD-5). */
  ns: string;
  verb: string;
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
   * Set to `false` for a command whose standard output is not an envelope, and
   * is nothing at all: `brain daemon run` is a process that stays, not a call
   * that answers, and a caller that read its stdout would be waiting for a line
   * that never comes — under `--json` as much as without it.
   *
   * It changes the printing and nothing else. A failure still goes to stderr as
   * `CODE: message` with its hint under it, the way text mode prints one, and
   * the exit code is still the code table's. Every other command leaves this
   * unset and keeps the envelope it has always had.
   */
  envelope?: false;
}

/** A command that talks to the brain, which is nearly all of them. */
export interface DatabaseCommandSpec<T = unknown> extends CommandSpecBase {
  standalone?: false;
  /**
   * This command writes to the database, so the dispatcher compares the stored
   * schema version with `SQLITE_SCHEMA_VERSION` first and does not call `run`
   * on a mismatch (AD-20). Read commands leave this unset and are never
   * blocked.
   */
  writes?: boolean;
  /** Input validation and consent before configuration, schema checks or database I/O. */
  preflight?(context: CommandContextBase): CommandFailure | undefined;
  /**
   * What this command does instead of writing, when the guard above found the
   * database out of reach: write the mark that says "do this later" to the
   * spool and answer as a degraded success (AD-9).
   *
   * Declaring it is a statement that this command's write *can* wait. A
   * command whose write may not be deferred — `messages redact`, which has to
   * remove a secret from the stored copy or fail — leaves it unset and is
   * refused, which is the behaviour every `writes` command had before this
   * existed (Boundaries).
   */
  spool?(context: SpoolCommandContext): Promise<CommandOutcome<T>>;
  /**
   * Set to `false` to keep the opportunistic drain from running after this
   * command (AD-7).
   *
   * Every other database command gets one: a harness without hooks has no
   * periodic drain, so the end of a command a person ran is the one moment the
   * backlog can be worked at all. `queue drain` itself turns it off — a drain
   * at the end of a drain would be a second run of the same loop with whatever
   * budget was left over — and so would any command whose own work must not be
   * followed by a write.
   */
  drain?: false;
  /**
   * This command's job is to report on a brain that may be broken, so it runs
   * even when the configuration could not be read: the dispatcher hands it a
   * store that answers `DB_UNAVAILABLE` and a `config` of `undefined` instead
   * of refusing with exit 2 (Decision 2026-10-14). `brain doctor run` is the
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
  /**
   * Kinds of work the opportunistic drain can do *beyond* the ones Core owns
   * (AD-21). Empty for every real invocation — `session_ingest` is Core's own
   * and `createBrain` merges it in — and the seam exists so a test can watch a
   * command's own drain pick up a kind of its own.
   */
  workHandlers?: WorkHandlers;
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
  // The two sinks of this file. What reaches them has already been through an
  // output codec — `encodeTextLine` for the lines a person reads, and
  // `encodeHookLine` on the hook path — and the `--json` envelope was masked
  // where Core built it. Nothing writes to either without passing one of the
  // three (AD-11, and the sink table of `test/output-codecs.test.ts`).
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
  // configuration included, and a command with no envelope must write nothing
  // to stdout whatever went wrong with it.
  const chosen = findSpec(registry, argv);
  const hook = chosen?.hook === true;
  const silent = chosen?.envelope === false;

  let outcome: Outcome;
  try {
    outcome = await execute(registry, argv, { clock, json, positional: [] }, env, {
      createStore: runtime.createStore ?? sqliteStore,
      stdin: runtime.stdin ?? (() => readStdin()),
      recordHookArrival: (harness) => recordHookArrival(configHome(env), harness, env['SECOND_BRAIN_PLUGIN_ROOT']),
      idGen: runtime.idGen ?? uuidV7IdGen(),
      workHandlers: runtime.workHandlers ?? {},
      stderr,
    });
  } catch (error) {
    // An exception here is a bug, and a bug must still not break the harness.
    if (!hook) throw error;
    stderr(`${encodeHookLine(`brain: ${errorLine(error)}`)}\n`);
    return 0;
  }

  // Only a command that could not run, or that failed outright, is swallowed. A
  // hook command that ran and came back degraded still has data and warning
  // codes worth printing — it just must not report the failure as an exit code.
  const failure = outcome.envelope?.error;
  if (hook && failure !== undefined) {
    stderr(`${encodeHookLine(`brain: ${failure.code}: ${failure.message}`)}\n`);
    return 0;
  }

  if (outcome.envelope !== null) {
    if (silent) {
      // Nothing on stdout, `--json` included: there is no envelope to write.
      // A failure still has to be readable, so it goes out as text mode's own
      // two lines — the sentence and the hint under it — because the caller of
      // a daemon that would not start is a person or a launchd log.
      if (failure !== undefined) {
        stderr(`${encodeTextLine(`${failure.code}: ${failure.message}`)}\n`);
        if (failure.hint !== undefined && failure.hint !== '') {
          stderr(`  ${encodeTextLine(failure.hint)}\n`);
        }
      }
      for (const line of outcome.warningLines) stderr(`${encodeTextLine(line)}\n`);
    } else if (json) {
      stdout(`${JSON.stringify(outcome.envelope)}\n`);
    } else {
      for (const line of outcome.text) stdout(`${encodeTextLine(line)}\n`);
      if (failure !== undefined) {
        stderr(`${encodeTextLine(`${failure.code}: ${failure.message}`)}\n`);
        // The hint, indented under the sentence it belongs to (Decision
        // 2026-10-16): text mode reads it instead of the envelope, and a
        // failure whose hint only `--json` carried would be a next step the
        // person at the terminal never sees. The hook path above never gets
        // here — one line is all a harness turn may be told (AD-6).
        if (failure.hint !== undefined && failure.hint !== '') {
          stderr(`  ${encodeTextLine(failure.hint)}\n`);
        }
        if (failure.retry_argv !== undefined) {
          const quoted = failure.retry_argv.map((arg) => /^[a-zA-Z0-9_./:=@-]+$/u.test(arg)
            ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
          stderr(`  다시 하려면: ${encodeTextLine(quoted)}\n`);
        }
      }
      for (const line of outcome.warningLines) stderr(`${encodeTextLine(line)}\n`);
    }
  }
  // A hook command never fails the harness, whatever the outcome was (AD-6).
  return hook ? 0 : outcome.exit;
}

/** The parts of the runtime `execute` passes on to a command or to the SDK. */
interface Wiring {
  createStore: CreateStore;
  stdin: () => Promise<string>;
  recordHookArrival: (harness: string) => Promise<void>;
  idGen: IdGen;
  /** Kinds beyond Core's own. Empty for every real invocation. */
  workHandlers: WorkHandlers;
  /**
   * Where the one line about a drain that threw goes. The opportunistic drain
   * has no envelope of its own — it must not change the command's result — so
   * stderr is the only thing it may say anything on (AD-7).
   */
  stderr: (text: string) => void;
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
  const { createStore, stdin, recordHookArrival, idGen, workHandlers, stderr } = wiring;
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
    return finish(rendering, await spec.run({ env, clock, options, args, stdin, recordHookArrival }), [], []);
  }

  const preflight = spec.preflight?.({ clock, options, args, stdin, recordHookArrival });
  if (preflight !== undefined) return failed(rendering, preflight, [], []);

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
  // Held as a value rather than spelled inline, because the opportunistic drain
  // below builds a second brain from the same ports over a store of its own —
  // and because the daemon assembles its own rounds from the same function
  // (`assembly.ts`), which is what keeps the two from drifting apart.
  const dependencies = brainDependencies({
    home,
    env,
    config,
    store,
    clock,
    idGen,
    workHandlers,
  });
  // One spool per invocation, taken off the assembly rather than built again:
  // the spool branch below writes a mark with no brain in its hands (AD-9), and
  // two `fileSpool` values over one folder would mint the same file name twice.
  const spool = dependencies.spool;
  const brain = createBrain(dependencies);
  try {
    if (spec.writes === true) {
      // The write guard of AD-20, in the one place that cannot be skipped by
      // forgetting it: `run` is not called at all when the database is at
      // another version, so no code path of this build can write into one.
      const schema = await checkSchema(store, SQLITE_SCHEMA_VERSION);
      if (!schema.ok) {
        // A command whose write can wait writes the mark instead, with no
        // brain and no store in its hands (AD-9). The codes of that outcome
        // are the branch's own — `SPOOLED` and the cause beside it, which is
        // what `spoolSessionIngest` answers with — so the guard adds none of
        // its own here: the same code twice in `warnings[]` would read as two
        // problems (Conventions).
        if (spec.spool !== undefined) {
          const spooled = await spec.spool({
            clock,
            options,
            args,
            stdin,
            recordHookArrival,
            cause: schema.code,
            message: schema.message,
            spoolIngest: (input, cause) =>
              spoolSessionIngest({ spool, clock, idGen }, input, cause),
          });
          return finish(rendering, spooled, warningCodes, warningLines);
        }
        // And one whose write cannot is refused, at the exit code the table
        // gives its code: `DB_UNAVAILABLE` is 2 because the command could not
        // run at all, `SCHEMA_MISMATCH` is 1 (Conventions, 종료 코드).
        return failed(
          rendering,
          { code: schema.code, message: schema.message },
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
      recordHookArrival,
    });
    const result = finish(rendering, outcome, warningCodes, warningLines);

    // The opportunistic drain of AD-7, after the result is built and before the
    // connection is closed: a harness without hooks has no periodic drain, so
    // the end of a command a person ran is the one moment the backlog gets
    // worked at all. Nothing about it reaches the envelope or the exit code —
    // the command has already answered, and a drain that changed that answer
    // would make every command's result depend on somebody else's backlog.
    if (shouldDrain(spec, config.ok, outcome) && config.ok &&
      !(await daemonLiveness({ home, clock })).alive) {
      await drainOpportunistically(
        { ...dependencies, createStore, storePath: config.config.storePath },
        stderr,
      );
    }
    return result;
  } finally {
    await brain.close();
  }
}

/**
 * Whether the drain at the end of this command may run (AD-7).
 *
 * Every condition is a way of saying "this command is a normal, successful use
 * of a database we could reach":
 *
 *   * not a hook command. A turn is somebody waiting, and the drain's budget is
 *     time taken from them (AD-6).
 *   * not a command that turned it off — `queue drain` itself.
 *   * the configuration was read, so there is a database at all. Without one
 *     the store answers `DB_UNAVAILABLE` to everything anyway, and a
 *     `diagnostic` command reporting on a broken brain must not try to write.
 *   * the command succeeded *and* its result is not a failure. Both halves are
 *     needed, because a command can answer `ok: true, failed: true` — which is
 *     exactly what `doctor run` does when a check fails. A drain right after
 *     that would write into the database the report just called broken.
 *
 * The schema check is the last one and is made at the call, because it costs a
 * query. A standalone command never gets here: it returns before the store is
 * built.
 */
function shouldDrain(
  spec: DatabaseCommandSpec,
  hasConfig: boolean,
  outcome: CommandOutcome<unknown>,
): boolean {
  return (
    spec.hook !== true &&
    spec.drain !== false &&
    hasConfig &&
    outcome.ok &&
    outcome.failed !== true
  );
}

/** What the drain at the end of a command is built from. */
type OpportunisticDrain = BrainDependencies & {
  createStore: CreateStore;
  /** Where the database is, from the configuration this invocation read. */
  storePath: string;
};

/**
 * Work the backlog for a moment, and say nothing unless something threw.
 *
 * It opens a connection of its own, and the reason is the budget. A drain is
 * two seconds of somebody else's command, but the command's own store waits
 * `BUSY_TIMEOUT_MS.command` — ten seconds — for the write lock, and
 * `DRAIN_BUDGET_MS.opportunistic` does not bound that wait: it decides whether
 * to claim again, not how long one claim may block. On a database somebody else
 * is writing to, the command's output would be held for ten seconds over work
 * nobody asked for. So the drain's store waits its own budget and no longer
 * (AD-7).
 *
 * The schema is checked with the same function the write guard uses, on that
 * same store: a database at another version is one this build must not write
 * to, and that is as true of a drain nobody asked for as of the command
 * itself (AD-20).
 *
 * The `catch` is the whole reason this is a function. A bug in a handler must
 * not turn a command that already succeeded into a crash, so whatever comes out
 * of it is one line on stderr — not a warning code, because the envelope has
 * been built and sealed, and not a non-zero exit, because the command did its
 * job (AD-7).
 */
async function drainOpportunistically(
  options: OpportunisticDrain,
  stderr: (text: string) => void,
): Promise<void> {
  const { createStore, storePath, ...dependencies } = options;
  let store: (Store & SchemaStore) | undefined;
  try {
    store = createStore({ path: storePath, busyTimeoutMs: DRAIN_BUDGET_MS.opportunistic });
    const schema = await checkSchema(store, SQLITE_SCHEMA_VERSION);
    if (!schema.ok) return;
    const brain = createBrain({ ...dependencies, store });
    await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.opportunistic });
  } catch (error) {
    stderr(`${encodeTextLine(`brain: 밀린 일 처리 중 오류: ${errorLine(error)}`)}\n`);
  } finally {
    // This connection is the drain's own, so closing it is the drain's own job;
    // the command's store is closed by the `finally` around the command.
    await store?.close().catch(() => undefined);
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
    // The command's own warnings join the configuration's, and say so on
    // stderr the same way a result's do: a code collected before the failure
    // is still a code the caller has to see (NFR-2).
    const { ok: _ran, warnings: failureWarnings, ...failure } = outcome;
    const collected = failureWarnings ?? [];
    return failed(
      rendering,
      failure,
      [...warningCodes, ...collected],
      [...warningLines, ...collected.map((code) => `경고: ${code}`)],
    );
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
    if (error.code === 'commander.helpDisplayed') {
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

    const command = quiet(namespace.command(spec.verb).description(spec.usedFor));
    command.option(JSON_FLAG, '기계가 읽는 응답 엔벨로프를 출력합니다');
    for (const option of spec.options ?? []) {
      command.option(option.flags, option.description);
    }
    // The rest of the meta, under the flags commander listed: the same seven
    // fields `brain guide schema` answers with, so `--help` and the schema
    // cannot describe one command two ways.
    command.addHelpText('after', helpAfter(spec));
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

/** What each `risk` means to the person reading `--help`, in Korean. */
const RISK_LABELS: Readonly<Record<CommandRisk, string>> = {
  read: '읽기만 하고 아무것도 바꾸지 않습니다',
  write: '무언가를 더하거나 바꿉니다',
  destructive: '무언가를 지우거나 되돌릴 수 없게 바꿉니다',
};

/**
 * The meta `--help` prints after commander's own sections: the examples, the
 * inputs that must be given, the shape of the result, and how much this command
 * can cost. `usedFor` is already the description above, so it is not repeated,
 * and `hook`/`dryRun` are left to `guide schema` — they are facts about how a
 * caller is wired, not about how to type this line.
 */
function helpAfter(spec: CommandSpec): string {
  const lines: string[] = [];
  if (spec.required.length > 0) {
    // In backticks, as every identifier in a sentence of this CLI is: these are
    // input names, not prose, and the output-language check knows the
    // difference by the backticks.
    lines.push('', '반드시 줄 것:', `  ${spec.required.map((name) => `\`${name}\``).join(', ')}`);
  }
  lines.push('', '예시:', ...spec.examples.map((example) => `  ${example}`));
  lines.push('', `출력: ${spec.output}`, `위험도: ${RISK_LABELS[spec.risk]}`);
  return lines.join('\n');
}

/**
 * Everything wrong with one command's meta, as a list rather than as thrown
 * errors, so a test can hold the rules against a spec that breaks them. The
 * type already makes the seven fields mandatory; this exists for the two things
 * a type cannot see — a value outside its union at runtime, because a registry
 * entry may be built from a cast or from data, and the agreements *between*
 * fields: a command that writes is not a `read`, a declared `<argument>` is a
 * required input, an example has to be a line somebody could actually type.
 *
 * Empty means the spec is fine. The problems are English, because only a test
 * ever reads them.
 */
export function validateCommandMeta(spec: CommandSpec): readonly string[] {
  const problems: string[] = [];
  const where = `${spec.ns} ${spec.verb}`;

  if (typeof spec.usedFor !== 'string' || spec.usedFor.trim() === '') {
    problems.push(`${where}: usedFor is missing`);
  }
  if (!Array.isArray(spec.required) || spec.required.some((name) => typeof name !== 'string')) {
    problems.push(`${where}: required must be a list of input names`);
  }
  if (!Array.isArray(spec.examples) || spec.examples.length === 0) {
    problems.push(`${where}: examples is missing`);
  }
  if (typeof spec.output !== 'string' || spec.output.trim() === '') {
    problems.push(`${where}: output is missing`);
  }
  // `Object.hasOwn`, not `in`: `in` walks the prototype, so `risk: 'toString'`
  // would pass a check that is supposed to accept exactly three words.
  if (!Object.hasOwn(RISK_LABELS, spec.risk)) {
    problems.push(`${where}: risk must be one of read, write, destructive`);
  }
  if (typeof spec.hook !== 'boolean') problems.push(`${where}: hook is missing`);
  if (typeof spec.dryRun !== 'boolean') problems.push(`${where}: dryRun is missing`);

  // A command that writes and calls itself a read would be a command an agent
  // reaches for believing it changes nothing.
  if (spec.standalone !== true && spec.writes === true && spec.risk === 'read') {
    problems.push(`${where}: writes, so risk may not be read`);
  }
  // The spool branch is reached from the write guard and from nowhere else, so
  // one declared without `writes` is a branch that can never run (AD-9).
  if (spec.standalone !== true && spec.spool !== undefined && spec.writes !== true) {
    problems.push(`${where}: declares spool, so it must declare writes`);
  }
  // `dryRun` is a promise about a flag; the flag has to be there to keep it.
  if (spec.dryRun === true && !(spec.options ?? []).some((option) => hasDryRun(option.flags))) {
    problems.push(`${where}: dryRun is true, so it must declare a --dry-run option`);
  }
  // Every required positional argument is an input a caller must supply, so it
  // belongs in the one list that answers "what do I have to give this".
  for (const declared of spec.arguments ?? []) {
    if (!declared.startsWith('<')) continue;
    const name = argumentName(declared);
    if (!(Array.isArray(spec.required) ? spec.required : []).includes(name)) {
      problems.push(`${where}: required does not name the argument ${declared}`);
    }
  }
  for (const example of Array.isArray(spec.examples) ? spec.examples : []) {
    if (typeof example !== 'string' || !example.startsWith(`brain ${where}`)) {
      problems.push(`${where}: example does not start with \`brain ${where}\`: ${String(example)}`);
    }
  }

  return problems;
}

/** Whether one option declaration is the `--dry-run` flag. */
function hasDryRun(flags: string): boolean {
  return /(?:^|[\s,])--dry-run\b/.test(flags);
}

/**
 * Which command an argv selects, without running it. The examples of the meta
 * have to be lines this very registry accepts, and the only honest way to check
 * that is to put each one through the same selection a real invocation takes.
 */
export function selectedCommand(
  registry: readonly CommandSpec[],
  argv: readonly string[],
): CommandSpec | undefined {
  const selected = select(registry, argv);
  return selected.kind === 'selected' ? selected.selection.spec : undefined;
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

/**
 * What an exception out of `dispatch` prints, line by line, through the `text`
 * codec — the stack included.
 *
 * A non-hook command that throws reaches the entry point, and node's own
 * handler writes the message and the stack exactly as they are. An exception's
 * message is made of whatever the code was holding when it broke, which is as
 * likely to be a secret as any other output (follow-up review), so the entry
 * point catches it and prints this instead (`bin.ts`).
 *
 * The stack is kept, masked a line at a time: the first line of a crash says
 * what, and the rest says where, and a crash report without the where is one
 * nobody can act on. It is a function here, beside the dispatcher's other
 * output, so the masking can be tested without starting a process.
 */
export function crashLines(error: unknown): string[] {
  const text =
    error instanceof Error ? (error.stack ?? error.message) : `알 수 없는 오류: ${String(error)}`;
  return text.split('\n').map((line) => encodeTextLine(line));
}
