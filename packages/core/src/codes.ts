/**
 * The warning and error codes of the Conventions table, in one place so every
 * surface uses the same vocabulary and the compiler rejects an invented code.
 *
 * Core owns both lists because every surface speaks them — the SDK, the CLI
 * envelope, the daemon socket — and because a code that no one can spell twice
 * is the same as no code at all. An error code brings its own exit code,
 * whether running the command again can work, and what to do about it, so that
 * those three facts are decided once here rather than at each of the thirty
 * places a failure is built.
 */

/**
 * A degraded-but-successful result must carry one of these in `warnings[]`;
 * there is no silent failure (NFR-2).
 */
export const WARNING_CODES = [
  /** A write went to the spool instead of the database (epic 2). */
  'SPOOLED',
  /** The database could not be reached. */
  'DB_UNAVAILABLE',
  /** The stored schema version differs from the one this code expects (AD-20). */
  'SCHEMA_MISMATCH',
  /** Reranking was asked for and failed; the unreranked order stands. */
  'RERANK_FAILED',
  /** The rows were built with another index config than the one in use. */
  'INDEX_CONFIG_MISMATCH',
  /** Part of the searched material has no embedding yet. */
  'UNINDEXED',
  /** The result was cut to fit a size limit. */
  'RESULT_TRUNCATED',
  /** A rule was included without being verified. */
  'RULE_UNVERIFIED',
  /** The parser read a transcript from the start because the cursor was lost. */
  'CURSOR_RESET',
  /**
   * The configuration file holds a key this version does not know. It is never
   * dropped in silence: the command runs and says which key it ignored (AD-18).
   */
  'CONFIG_UNKNOWN_KEY',
  /** An attachment was stored without the masking it should have had (AD-23). */
  'ATTACHMENT_NOT_REDACTED',
  /** A file this brain only points at could not be read where it lives. */
  'FILE_SOURCE_UNREACHABLE',
  /** The daemon was configured and could not be reached, so this ran direct. */
  'DAEMON_UNAVAILABLE',
  /** The harness plugin this brain expects is not installed. */
  'PLUGIN_NOT_INSTALLED',
  /** The installed plugin is older than the build answering this command. */
  'PLUGIN_BEHIND',
  /** More than one copy of the plugin is installed, so hooks may run twice. */
  'PLUGIN_DUPLICATE',
] as const;

/** One of the codes above. The only thing `warnings[]` may contain. */
export type WarningCode = (typeof WARNING_CODES)[number];

const KNOWN_WARNINGS = new Set<string>(WARNING_CODES);

/**
 * Narrow a string that came from outside — a store's own warning, a check code,
 * a parsed envelope — to a warning code.
 */
export function isWarningCode(value: string): value is WarningCode {
  return KNOWN_WARNINGS.has(value);
}

/**
 * The exit code of a command that did not produce a result: 1 ran and failed or
 * came back degraded, 2 could not run at all (usage, configuration, no
 * database), 3 needs a confirmation nobody has given. 0 is success and so never
 * belongs to a failure.
 */
export type FailureExit = 1 | 2 | 3;

/** Everything an error code decides on its own, before any one failure. */
export interface ErrorCodeSpec {
  /** The exit code, unless the failure names its own. */
  exit: FailureExit;
  /**
   * Whether running the same command again can work. Left out where that
   * depends on what went wrong, which the envelope reports as "unknown"
   * rather than guessing either way.
   */
  retryable?: boolean;
  /**
   * What to do about it: lower case, no full stop, commands in backticks, and
   * the real first step rather than a command that would fail the same way
   * (Conventions). Never destructive — a code a typo can produce must not
   * suggest removing anything.
   */
  hint: string;
}

const CODES = {
  /** The command was invoked wrongly: unknown verb, bad flag, bad argument. */
  USAGE: {
    exit: 2,
    retryable: false,
    hint: 'run the command with `--help` to see what it takes',
  },
  /** There is no `config.toml`, so the installer has not run here (AD-18). */
  CONFIG_MISSING: {
    exit: 2,
    retryable: false,
    hint: 'run `brain setup run` to install this brain',
  },
  /**
   * There is a configuration and it cannot be understood or used.
   *
   * The hint names no command on purpose: the installer renders both files
   * whole from what it can read, so running it over a configuration with one
   * unreadable value writes the keys nothing asks about — the time zone, the
   * file store root, the mirror — back as their defaults (deferred, fixed in
   * 2.4). Editing the one key the message names loses nothing.
   */
  CONFIG_INVALID: {
    exit: 2,
    retryable: false,
    hint: 'fix the key the message names in `config.toml`',
  },
  /**
   * The database could not be reached. The Conventions table puts it at 2
   * because a brain with no database could not run the command at all.
   */
  DB_UNAVAILABLE: {
    exit: 2,
    retryable: false,
    hint: 'run `brain admin doctor` to see what the database is doing',
  },
  /** Another connection held the write lock for longer than the budget (AD-7). */
  DB_LOCKED: {
    exit: 1,
    retryable: true,
    hint: 'another process is writing; run the command again in a moment',
  },
  /** The stored schema version is not the one this build was made for (AD-20). */
  SCHEMA_MISMATCH: {
    exit: 1,
    retryable: false,
    hint: 'run `brain setup run` to bring the database to this build',
  },
  /** A migration was applied and the database refused it. */
  MIGRATION_FAILED: {
    exit: 1,
    retryable: false,
    hint: 'run `brain admin doctor`, then `brain setup run` once the file it names is readable',
  },
  /** The file store's root could not be made or written. */
  FILES_UNAVAILABLE: {
    exit: 1,
    hint: 'check that the file store root is a folder this user may write',
  },
  /** `<home>/bin/brain` is not there, so there is nothing to register (AD-19). */
  SHIM_MISSING: {
    exit: 1,
    retryable: false,
    hint: 'run `brain setup run` to write the shim',
  },
  /** The search itself failed, so there is no result to report. */
  SEARCH_FAILED: {
    exit: 1,
    hint: 'run `brain admin doctor` to see whether the index is healthy',
  },
  /** The daemon handshake found a build other than this one's (epic 9). */
  VERSION_MISMATCH: {
    exit: 1,
    retryable: false,
    hint: 'restart the daemon so it runs the build this command came from',
  },
  /** The verb needs a session and the invocation named none (AD-8). */
  SESSION_REQUIRED: {
    exit: 2,
    retryable: false,
    hint: 'pass the session token the harness hook reported',
  },
  /**
   * The verb is gated: it changes or removes something, and nothing in the
   * invocation agreed to it. `error.retry` carries the same call with
   * `confirm: true`, and the CLI adds the argv for it.
   *
   * The hint names `error.retry` and not the CLI's `error.retry_argv`: this
   * table is read by the socket and the MCP server too, and neither of those
   * has an argv to run (AD-5).
   */
  CONFIRMATION_REQUIRED: {
    exit: 3,
    retryable: false,
    hint: 'ask the person whether to go ahead, and make the call in `error.retry` only if they say yes',
  },
} as const satisfies Record<string, ErrorCodeSpec>;

/** One of the codes above. `error.code` may also carry a connector's own. */
export type ErrorCode = keyof typeof CODES;

/**
 * Every error code this build knows, with its exit code, its retryability and
 * its hint. Read through `errorCodeSpec` rather than indexed directly, so a
 * code that came from outside — a connector, a parsed envelope — is handled the
 * same way as one of these.
 */
export const ERROR_CODES: Readonly<Record<ErrorCode, ErrorCodeSpec>> = CODES;

const KNOWN_ERRORS = new Set<string>(Object.keys(CODES));

/** Narrow a string that came from outside to one of the error codes above. */
export function isErrorCode(value: string): value is ErrorCode {
  return KNOWN_ERRORS.has(value);
}

/**
 * What the table says about a code, or `undefined` for a code it does not know
 * — a connector names its own codes (`ports/connector.ts`), and an unknown code
 * must not be turned into a guess about exit codes or hints.
 */
export function errorCodeSpec(code: string): ErrorCodeSpec | undefined {
  return isErrorCode(code) ? ERROR_CODES[code] : undefined;
}
