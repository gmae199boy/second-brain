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
 *
 * What each one means in words is `WARNING_CODE_MEANINGS`, right below: the
 * list stays an array because its order is the Conventions table's and because
 * `WarningCode` is read off it, and the meanings sit beside it in a record a
 * test holds against the same keys.
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
  /**
   * One value of the configuration could not be used, so that key — and only
   * that key — was written back as its default. The others keep what they
   * said: a single typo must not reset the keys nothing asks about (AD-18).
   */
  'CONFIG_VALUE_RESET',
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
  /**
   * The plugin carries a newer app than the one installed, and automatic
   * updating is off, so nothing will fetch it: the next session would install
   * it if `[update] auto` were on (AD-19).
   */
  'UPDATE_AVAILABLE',
] as const;

/** One of the codes above. The only thing `warnings[]` may contain. */
export type WarningCode = (typeof WARNING_CODES)[number];

/**
 * What each warning code means, in Korean, because a person reads it
 * (Conventions, output language 2026-10-16). `brain guide exit-codes` and the
 * README table are both rendered from here, so an agent that asks what
 * `CURSOR_RESET` was about is told the same thing the document says.
 *
 * The JSDoc above each code says the same in English for whoever is reading the
 * source; this record is what any surface prints.
 */
export const WARNING_CODE_MEANINGS: Readonly<Record<WarningCode, string>> = {
  SPOOLED: '쓰기가 데이터베이스가 아니라 spool로 갔습니다',
  DB_UNAVAILABLE: '데이터베이스에 닿지 못했습니다',
  SCHEMA_MISMATCH: '저장된 스키마 버전이 이 코드가 기대하는 버전과 다릅니다',
  RERANK_FAILED: '다시 순위를 매기려 했고 실패해서, 매기기 전 순서를 그대로 씁니다',
  INDEX_CONFIG_MISMATCH: '행들이 지금 쓰는 것과 다른 색인 설정으로 만들어졌습니다',
  UNINDEXED: '찾아본 자료의 일부에 아직 임베딩이 없습니다',
  RESULT_TRUNCATED: '결과가 크기 한도에 맞춰 잘렸습니다',
  RULE_UNVERIFIED: '규칙이 확인되지 않은 채 포함되었습니다',
  CURSOR_RESET: '커서를 잃어서 파서가 트랜스크립트를 처음부터 읽었습니다',
  CONFIG_UNKNOWN_KEY: '설정 파일에 이 버전이 모르는 키가 있고, 어떤 키를 무시했는지 말합니다',
  CONFIG_VALUE_RESET: '설정 값 하나를 쓸 수 없어서 그 키만 기본값으로 다시 썼습니다',
  ATTACHMENT_NOT_REDACTED: '첨부가 받아야 할 마스킹 없이 저장되었습니다',
  FILE_SOURCE_UNREACHABLE: '이 brain이 가리키기만 하는 파일을 그 자리에서 읽을 수 없었습니다',
  DAEMON_UNAVAILABLE: 'daemon이 설정되어 있고 닿지 못해서, 이 명령은 직접 돌았습니다',
  PLUGIN_NOT_INSTALLED: '이 brain이 기대하는 하네스 플러그인이 설치되어 있지 않습니다',
  PLUGIN_BEHIND: '설치된 플러그인이 이 명령에 답하는 빌드보다 오래되었습니다',
  PLUGIN_DUPLICATE: '플러그인이 두 벌 이상 설치되어 hook이 두 번 돌 수 있습니다',
  UPDATE_AVAILABLE: '플러그인이 더 새 앱을 담고 있는데 자동 업데이트가 꺼져 있습니다',
};

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
   * What the code means, in Korean, because a person reads it (Conventions,
   * output language 2026-10-16). It says what happened, where `hint` says what
   * to do about it: `brain guide exit-codes` and the README table carry both,
   * and one without the other is either a problem with no next step or a next
   * step for a problem nobody named.
   */
  meaning: string;
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
    meaning: '명령을 잘못 불렀습니다 — 모르는 동사, 잘못된 플래그, 쓸 수 없는 인자',
    retryable: false,
    hint: '`--help`를 붙여 이 명령이 무엇을 받는지 확인하세요',
  },
  /** There is no `config.toml`, so the installer has not run here (AD-18). */
  CONFIG_MISSING: {
    exit: 2,
    meaning: '이 폴더에 설정 파일이 없습니다 — 설치가 여기서 돈 적이 없습니다',
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
    meaning: '설정은 있고, 그 값 하나를 읽거나 쓸 수 없습니다',
    retryable: false,
    hint: '메시지가 가리키는 값을 고치세요 — `config.toml`의 키거나 명령의 옵션입니다',
  },
  /**
   * The database could not be reached. The Conventions table puts it at 2
   * because a brain with no database could not run the command at all.
   */
  DB_UNAVAILABLE: {
    exit: 2,
    meaning: '데이터베이스에 닿지 못했습니다',
    retryable: false,
    hint: '`brain doctor run`으로 데이터베이스 상태를 확인하세요',
  },
  /** Another connection held the write lock for longer than the budget (AD-7). */
  DB_LOCKED: {
    exit: 1,
    meaning: '다른 연결이 쓰기 잠금을 예산보다 오래 쥐고 있었습니다',
    retryable: true,
    hint: '다른 프로세스가 쓰는 중이니 잠시 뒤 같은 명령을 다시 실행하세요',
  },
  /** The stored schema version is not the one this build was made for (AD-20). */
  SCHEMA_MISMATCH: {
    exit: 1,
    meaning: '저장된 스키마 버전이 이 빌드가 만들어진 버전과 다릅니다',
    retryable: false,
    hint: '`brain setup run`으로 데이터베이스를 이 빌드에 맞추세요',
  },
  /** A migration was applied and the database refused it. */
  MIGRATION_FAILED: {
    exit: 1,
    meaning: '마이그레이션을 적용하다 데이터베이스가 거절했습니다',
    retryable: false,
    hint: '`brain doctor run`을 실행하고, 가리키는 파일을 읽을 수 있게 되면 `brain setup run`을 실행하세요',
  },
  /** The file store's root could not be made or written. */
  FILES_UNAVAILABLE: {
    exit: 1,
    meaning: '파일 저장소 루트를 만들거나 거기에 쓸 수 없었습니다',
    hint: '파일 저장소 루트가 이 사용자가 쓸 수 있는 폴더인지 확인하세요',
  },
  /** `<home>/bin/brain` is not there, so there is nothing to register (AD-19). */
  SHIM_MISSING: {
    exit: 1,
    meaning: '하네스 hook이 부르는 shim 파일이 없습니다',
    retryable: false,
    hint: '`brain setup run`으로 shim 파일을 만드세요',
  },
  /**
   * Every install step ran and the checks that close the install did not all
   * pass. It is 1 and not 2 because the install did run: the configuration, the
   * database and the shim are all where they belong, and what is left is one
   * check to read. The hint names `doctor run` rather than `setup run`, because
   * running the install again would end on the same report (AD-19).
   */
  SETUP_INCOMPLETE: {
    exit: 1,
    meaning: '설치는 끝까지 돌았고 마지막 점검이 통과하지 못했습니다',
    retryable: false,
    hint: '`brain doctor run`으로 어느 점검이 실패했는지 읽고 그것을 고치세요',
  },
  /**
   * A person stopped the install themselves: no at the screen that says what
   * it is about to write, or Ctrl-C at a question.
   *
   * At the consent screen — and at any question before it — nothing has been
   * written yet, which is the whole point of asking there. Ctrl-C at a later
   * question, such as which harnesses to connect, stops where it is and leaves
   * the steps already taken as they are. Either way this is not a failure of
   * the machine but an answer.
   */
  SETUP_CANCELLED: {
    exit: 1,
    meaning: '사람이 설치를 진행하지 않겠다고 답했습니다',
    retryable: false,
    hint: '진행해도 되면 같은 명령을 다시 실행하고 진행에 동의하세요',
  },
  /** The search itself failed, so there is no result to report. */
  SEARCH_FAILED: {
    exit: 1,
    meaning: '검색 자체가 실패해서 보고할 결과가 없습니다',
    hint: '`brain doctor run`으로 색인이 건강한지 확인하세요',
  },
  /** The daemon handshake found a build other than this one's (epic 9). */
  VERSION_MISMATCH: {
    exit: 1,
    meaning: 'daemon이 이 명령을 낸 빌드와 다른 빌드로 돌고 있습니다',
    retryable: false,
    hint: '이 명령을 낸 빌드로 daemon을 다시 시작하세요',
  },
  /** The verb needs a session and the invocation named none (AD-8). */
  SESSION_REQUIRED: {
    exit: 2,
    meaning: '이 동사는 세션이 필요한데 아무것도 주어지지 않았습니다',
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
    meaning: '이 데이터베이스에 주인 행이 없어서 세션을 누구에게도 붙일 수 없습니다',
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
    meaning: '사람의 동의가 필요한 동사인데 아무도 동의하지 않았습니다',
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

/**
 * One row of the exit-code table (Conventions). `code` is a string and not a
 * number because the last row is not an exit code but the rule that overrides
 * every one of them: a command on a harness hook path exits 0 whatever happened
 * (AD-6), and a reader told only about 0 through 3 would take that 0 for
 * success.
 *
 * `agent_action` is the field the table exists for. An agent that read only
 * `meaning` would be left to invent what to do about a 2 or a 3, and the two
 * things it invents — retry in a loop, add the consent itself — are the two
 * things it must not do.
 */
export interface ExitCodeRow {
  /** `0`, `1`, `2`, `3`, or `hook`. */
  readonly code: string;
  readonly meaning: string;
  readonly agent_action: string;
}

/**
 * The exit-code table, in Korean, as every surface renders it: `brain guide
 * exit-codes`, `guideShow()`'s conventions section, and the README table a
 * cross-check test holds against this list.
 *
 * The numbers themselves are `ExitCode` in the CLI and `FailureExit` here; this
 * is what they mean and what to do about them, which is a different fact and so
 * a different constant.
 */
export const EXIT_CODES: readonly ExitCodeRow[] = [
  {
    code: '0',
    meaning: '잘되었습니다',
    agent_action: '`data`를 그대로 쓰세요',
  },
  {
    code: '1',
    meaning: '실행했고 실패했거나 degraded로 끝났습니다',
    agent_action:
      '`warnings[]`와 `error`를 읽고, `error.retryable`이 참일 때만 같은 명령을 다시 실행하세요',
  },
  {
    code: '2',
    meaning: '아예 실행할 수 없었습니다: 명령줄, 설정, 또는 데이터베이스가 없음',
    agent_action: '같은 명령을 다시 실행하지 말고, `error.hint`가 가리키는 것을 먼저 고치세요',
  },
  {
    code: '3',
    // No `retry_argv` in here: that field is the CLI's own rendering of
    // `error.retry`, and this table is read by every surface (AD-5). What is
    // true everywhere is that the consent belongs to a person.
    meaning: '아무도 주지 않은 확인이 필요합니다',
    agent_action:
      '사람에게 진행해도 되는지 묻고, 그렇다고 할 때만 `error.retry`가 말하는 대로 다시 부르세요. 스스로 동의하지 마세요',
  },
  {
    code: 'hook',
    meaning: '하네스 hook 경로의 명령은 무슨 일이 있어도 0으로 끝납니다',
    agent_action: '종료 코드로는 실패를 알 수 없으니 stderr 한 줄을 읽으세요',
  },
];

/** One error code as the guide and the README carry it. */
export interface ErrorCodeRow {
  readonly code: ErrorCode;
  readonly exit_code: FailureExit;
  /** Left out where it depends on what went wrong, as the spec leaves it out. */
  readonly retryable?: boolean;
  readonly meaning: string;
  readonly hint: string;
}

/** One warning code as the guide and the README carry it. */
export interface WarningCodeRow {
  readonly code: WarningCode;
  readonly meaning: string;
}

/**
 * The three code tables as one value: the exit codes, the error codes with the
 * exit code and hint each one decides, and the warning codes.
 *
 * It is a function and not a constant so that no caller can hold a reference
 * and change it — `brain guide exit-codes` puts this straight into an envelope,
 * and the README cross-check test reads the same thing.
 */
export interface ExitCodeGuide {
  exit_codes: readonly ExitCodeRow[];
  error_codes: readonly ErrorCodeRow[];
  warning_codes: readonly WarningCodeRow[];
}

export function exitCodeGuide(): ExitCodeGuide {
  return {
    exit_codes: EXIT_CODES.map((row) => ({ ...row })),
    error_codes: (Object.keys(CODES) as ErrorCode[]).map((code) => {
      const spec = ERROR_CODES[code];
      return {
        code,
        exit_code: spec.exit,
        ...(spec.retryable === undefined ? {} : { retryable: spec.retryable }),
        meaning: spec.meaning,
        hint: spec.hint,
      };
    }),
    warning_codes: WARNING_CODES.map((code) => ({
      code,
      meaning: WARNING_CODE_MEANINGS[code],
    })),
  };
}
