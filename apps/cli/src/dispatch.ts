import { Command, CommanderError } from 'commander';
import {
  SCHEMA_VERSION,
  checkSchema,
  createBrain,
  postgresStore,
  type Brain,
  type Clock,
  type WarningCode,
} from 'second_brain';
import { readConfig, type BrainConfig } from './config/codec.js';
import { configHome } from './config/paths.js';
import { errorEnvelope, okEnvelope, type Envelope } from './envelope.js';

/**
 * The one path every command takes. It reads the configuration, builds the SDK,
 * enforces the write guard, assembles the envelope, and decides the exit code,
 * so a command itself does nothing but translate arguments and format output
 * (AD-5). Adding a command means adding a spec to the registry — never
 * repeating any of the above, because a rule repeated thirty times is a rule
 * that will be forgotten once.
 */

/** The flag that switches the agent-readable output on, on every command. */
const JSON_FLAG = '--json';

/**
 * Connect budget. Doctor is allowed five seconds end to end, so leave room for
 * process startup inside it.
 */
const CONNECT_TIMEOUT_MS = 4000;

/**
 * Per-query budget when a command does not set its own. It matches the connect
 * budget, which suits a command that answers in a moment.
 */
const DEFAULT_QUERY_TIMEOUT_MS = CONNECT_TIMEOUT_MS;

/**
 * 0 success, 1 ran but failed or degraded, 2 could not run at all (usage or
 * configuration). A `hook` command returns 0 whatever happens.
 */
export type ExitCode = 0 | 1 | 2;

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
}

/** What a command gets. No file, no environment, no connection of its own. */
export interface CommandContext extends CommandContextBase {
  /** The SDK surface. The only thing a command is allowed to call (AD-5). */
  brain: Brain;
  /** The configuration, already read, checked and resolved (AD-18). */
  config: BrainConfig;
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
  /** The command ran and the outcome is a failure: exit 1, envelope still ok. */
  failed?: boolean;
}

/** The command did not produce a result. */
export interface CommandFailure {
  ok: false;
  code: string;
  message: string;
  /** 1 = ran and failed, 2 = could not run. Defaults to 1. */
  exit?: 1 | 2;
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
   * schema version with `SCHEMA_VERSION` first and refuses on a mismatch
   * (AD-20). Read commands leave this unset and are never blocked.
   */
  writes?: boolean;
  /**
   * How long one query of this command may take. Defaults to the connect
   * budget, which is right for a command that answers at once. A command whose
   * queries legitimately run long — an export, a reindex, a large ingest —
   * sets its own budget, or `0` for no limit.
   */
  queryTimeoutMs?: number;
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

export interface DispatchRuntime {
  clock: Clock;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** What `execute` decided, before anything is printed. */
interface Outcome {
  /** `null` when commander already wrote the output, as it does for `--help`. */
  envelope: Envelope<unknown> | null;
  text: readonly string[];
  /** Warning lines for the human-readable output, on stderr. */
  warningLines: readonly string[];
  exit: ExitCode;
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
    outcome = await execute(registry, argv, clock, env);
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
      if (failure !== undefined) stderr(`${failure.code}: ${failure.message}\n`);
      for (const line of outcome.warningLines) stderr(`${line}\n`);
    }
  }
  // A hook command never fails the harness, whatever the outcome was (AD-6).
  return hook ? 0 : outcome.exit;
}

/** Everything but the printing, so the hook wrapper has one thing to catch. */
async function execute(
  registry: readonly CommandSpec[],
  argv: readonly string[],
  clock: Clock,
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  const selected = select(registry, argv);
  if (selected.kind === 'helped') {
    return { envelope: null, text: [], warningLines: [], exit: 0 };
  }
  if (selected.kind === 'usage') {
    // Nothing is read and nothing is connected: the command never ran.
    return failed(clock, 'USAGE', selected.message, 2, [], []);
  }

  const { spec, options, args } = selected.selection;

  // Before the configuration, because this command may be the one that writes
  // it, and before the store, because it has no database to reach.
  if (spec.standalone === true) {
    return finish(clock, await spec.run({ env, clock, options, args }), [], []);
  }

  const config = await readConfig(configHome(env), env);
  if (!config.ok) {
    return failed(clock, config.code, config.message, 2, [], []);
  }
  const warningCodes = config.warnings.map((warning) => warning.code);
  const warningLines = config.warnings.map((warning) => `warning: ${warning.message}`);

  const store = postgresStore({
    databaseUrl: config.config.databaseUrl,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    queryTimeoutMs: spec.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  });
  const brain = createBrain({ store });
  try {
    if (spec.writes === true) {
      // The write guard of AD-20, in the one place that cannot be skipped by
      // forgetting it. Epic 2 turns this refusal into a spool.
      const schema = await checkSchema(store, SCHEMA_VERSION);
      if (!schema.ok) {
        return failed(
          clock,
          schema.code,
          schema.message,
          1,
          [...warningCodes, schema.code],
          warningLines,
        );
      }
    }

    const outcome = await spec.run({ brain, config: config.config, clock, options, args });
    return finish(clock, outcome, warningCodes, warningLines);
  } finally {
    await brain.close();
  }
}

/** One command's outcome as an `Outcome`, the same way for every command. */
function finish(
  clock: Clock,
  outcome: CommandOutcome<unknown>,
  warningCodes: readonly WarningCode[],
  warningLines: readonly string[],
): Outcome {
  if (!outcome.ok) {
    return failed(
      clock,
      outcome.code,
      outcome.message,
      outcome.exit ?? 1,
      warningCodes,
      warningLines,
    );
  }

  const commandWarnings = outcome.warnings ?? [];
  return {
    envelope: okEnvelope(clock, outcome.data, [...warningCodes, ...commandWarnings]),
    text: outcome.text ?? [],
    warningLines: [...warningLines, ...commandWarnings.map((code) => `warning: ${code}`)],
    exit: outcome.failed === true ? 1 : 0,
  };
}

function failed(
  clock: Clock,
  code: string,
  message: string,
  exit: 1 | 2,
  warnings: readonly WarningCode[],
  warningLines: readonly string[],
): Outcome {
  return {
    envelope: errorEnvelope(clock, code, message, warnings),
    text: [],
    warningLines,
    exit,
  };
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
  const program = quiet(new Command().name('brain').description('Personal Brain command line'));

  const namespaces = new Map<string, Command>();
  for (const spec of registry) {
    let namespace = namespaces.get(spec.ns);
    if (namespace === undefined) {
      namespace = quiet(
        program.command(spec.ns).description(spec.nsDescription ?? `${spec.ns} commands`),
      );
      namespaces.set(spec.ns, namespace);
    }

    const command = quiet(namespace.command(spec.verb).description(spec.description));
    command.option(JSON_FLAG, 'print the machine-readable response envelope');
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
    .configureOutput({ writeErr: () => {} });
}

function usageMessage(registry: readonly CommandSpec[], error: CommanderError | undefined): string {
  const known = registry.map((spec) => `${spec.ns} ${spec.verb}`).join(', ');
  // `commander.help` is the help commander prints when no command was given;
  // its own message is a placeholder, so say what happened instead.
  const detail =
    error === undefined || error.code === 'commander.help'
      ? 'no command given'
      : error.message.replace(/^error:\s*/, '');
  return `${detail}. Usage: brain <ns> <verb> [--json]. Known commands: ${known}.`;
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
  return text.split('\n')[0]?.trim() ?? 'unknown error';
}
