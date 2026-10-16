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
   * What to do about it, in Korean, because a person reads it (Conventions,
   * output language, 2026-10-16): no full stop, commands in backticks, and the
   * real first step rather than a command that would fail the same way. Never
   * destructive — a code a typo can produce must not suggest removing
   * anything.
   */
  hint: string;
}

const CODES = {
  /** The command was invoked wrongly: unknown verb, bad flag, bad argument. */
  USAGE: {
    exit: 2,
    retryable: false,
    hint: '`--help`를 붙여 이 명령이 무엇을 받는지 확인하세요',
  },
  /** There is no `config.toml`, so the installer has not run here (AD-18). */
  CONFIG_MISSING: {
    exit: 2,
    retryable: false,
    hint: '`brain setup run`으로 설치하세요',
  },
  /**
   * There is a configuration and it cannot be understood or used.
   *
   * The hint names no command on purpose: the installer renders both files
   * whole from what it can read, so running it over a configuration with one
   * unreadable value writes the keys nothing asks about — the time zone, the
   * file store root, the mirror — back as their defaults (deferred, fixed in
   * 2.4). Editing the one value the message names loses nothing.
   *
   * It says "value" and not "key" because the same code answers a flag the
   * installer could not use — `setup run --store-path notes/brain.db` — and a
   * hint that sent that reader to `config.toml` would send them to a file that
   * is not the problem.
   */
  CONFIG_INVALID: {
    exit: 2,
    retryable: false,
    hint: '메시지가 가리키는 값을 고치세요 — `config.toml`의 키거나 명령의 옵션입니다',
  },
  /**
   * The database could not be reached. The Conventions table puts it at 2
   * because a brain with no database could not run the command at all.
   */
  DB_UNAVAILABLE: {
    exit: 2,
    retryable: false,
    hint: '`brain admin doctor`로 데이터베이스 상태를 확인하세요',
  },
  /** Another connection held the write lock for longer than the budget (AD-7). */
  DB_LOCKED: {
    exit: 1,
    retryable: true,
    hint: '다른 프로세스가 쓰는 중이니 잠시 뒤 같은 명령을 다시 실행하세요',
  },
  /** The stored schema version is not the one this build was made for (AD-20). */
  SCHEMA_MISMATCH: {
    exit: 1,
    retryable: false,
    hint: '`brain setup run`으로 데이터베이스를 이 빌드에 맞추세요',
  },
  /** A migration was applied and the database refused it. */
  MIGRATION_FAILED: {
    exit: 1,
    retryable: false,
    hint: '`brain admin doctor`를 실행하고, 가리키는 파일을 읽을 수 있게 되면 `brain setup run`을 실행하세요',
  },
  /** The file store's root could not be made or written. */
  FILES_UNAVAILABLE: {
    exit: 1,
    hint: '파일 저장소 루트가 이 사용자가 쓸 수 있는 폴더인지 확인하세요',
  },
  /** `<home>/bin/brain` is not there, so there is nothing to register (AD-19). */
  SHIM_MISSING: {
    exit: 1,
    retryable: false,
    hint: '`brain setup run`으로 shim 파일을 만드세요',
  },
  /** The search itself failed, so there is no result to report. */
  SEARCH_FAILED: {
    exit: 1,
    hint: '`brain admin doctor`로 색인이 건강한지 확인하세요',
  },
  /** The daemon handshake found a build other than this one's (epic 9). */
  VERSION_MISMATCH: {
    exit: 1,
    retryable: false,
    hint: '이 명령을 낸 빌드로 daemon을 다시 시작하세요',
  },
  /** The verb needs a session and the invocation named none (AD-8). */
  SESSION_REQUIRED: {
    exit: 2,
    retryable: false,
    hint: '하네스 hook이 보고한 세션 토큰을 넘기세요',
  },
  /**
   * The database is at a version that has a `users` table and holds no owner
   * row, so there is nobody to attribute a session to (AD-12).
   *
   * It is 2 and not 1 for the same reason `CONFIG_MISSING` is: the install
   * step that creates the row has not run here, so the command could not run
   * at all rather than ran and failed. The hint names the installer, which is
   * the only thing that creates it — a migration cannot read an operating
   * system user name.
   */
  USER_MISSING: {
    exit: 2,
    retryable: false,
    hint: '`brain setup run`으로 이 데이터베이스의 주인을 기록하세요',
  },
  /**
   * The verb is gated: it changes or removes something, and nothing in the
   * invocation agreed to it. `error.retry` carries the same call with
   * `confirm: true`, and the CLI adds the argv for it.
   *
   * The hint says what to do rather than which field to read: text mode prints
   * it under the failure, where there is no envelope to look `error.retry` up
   * in. What the consent is spelled as — `--yes` on a command line, `confirm`
   * in `error.retry` — is the same consent on every surface (Conventions).
   */
  CONFIRMATION_REQUIRED: {
    exit: 3,
    retryable: false,
    hint: '사람에게 진행해도 되는지 묻고, 그렇다고 할 때만 같은 명령에 `--yes`를 붙여 다시 실행하세요',
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
