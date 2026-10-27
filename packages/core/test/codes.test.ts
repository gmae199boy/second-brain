import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  EXIT_CODES,
  WARNING_CODES,
  WARNING_CODE_MEANINGS,
  errorCodeSpec,
  exitCodeGuide,
  isErrorCode,
  isWarningCode,
  type ErrorCode,
} from '../src/codes.js';
import { guideShow } from '../src/guide.js';
import { assertKoreanProse, englishSentences } from '../src/testing/language.js';

/**
 * The two code lists against the Conventions table. They are a constant rather
 * than a convention precisely so a test can hold them against the document: if
 * these lists and the table ever disagree, one of the two is wrong and nobody
 * reading an envelope can tell which.
 */
describe('the warning codes', () => {
  it('holds the warning codes of the Conventions table, in its order', () => {
    expect([...WARNING_CODES]).toEqual([
      'SPOOLED',
      'DB_UNAVAILABLE',
      'SCHEMA_MISMATCH',
      'RERANK_FAILED',
      'INDEX_CONFIG_MISMATCH',
      'UNINDEXED',
      'RESULT_TRUNCATED',
      'RULE_UNVERIFIED',
      'CURSOR_RESET',
      'TRANSCRIPT_LINES_SKIPPED',
      'CONFIG_UNKNOWN_KEY',
      'CONFIG_VALUE_RESET',
      'ATTACHMENT_NOT_REDACTED',
      'FILE_SOURCE_UNREACHABLE',
      'DAEMON_UNAVAILABLE',
      'DAEMON_NOT_REGISTERED',
      'DAEMON_NOT_RESTARTED',
      'PLUGIN_NOT_INSTALLED',
      'PLUGIN_BEHIND',
      'PLUGIN_DUPLICATE',
      'UPDATE_AVAILABLE',
    ]);
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length);
  });

  it('recognises its own codes and nothing else', () => {
    for (const code of WARNING_CODES) {
      expect(isWarningCode(code)).toBe(true);
    }
    expect(isWarningCode('CONFIG_MISSING')).toBe(false);
    expect(isWarningCode('db_unavailable')).toBe(false);
    expect(isWarningCode('')).toBe(false);
  });

  it('says what every one of them means, and means nothing it does not list', () => {
    // The list is an array because its order is the table's; the meanings are
    // a record beside it. The two can only disagree by one of them growing
    // without the other, which is what this holds them to.
    expect(Object.keys(WARNING_CODE_MEANINGS).sort()).toEqual([...WARNING_CODES].sort());
    for (const code of WARNING_CODES) {
      expect(WARNING_CODE_MEANINGS[code], code).not.toBe('');
    }
  });
});

describe('the error codes', () => {
  it('holds every code of the Conventions table with the exit code it names', () => {
    const exits = Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, spec]) => [code, spec.exit]),
    );

    expect(exits).toEqual({
      USAGE: 2,
      CONFIG_MISSING: 2,
      CONFIG_INVALID: 2,
      DB_UNAVAILABLE: 2,
      SESSION_REQUIRED: 2,
      USER_MISSING: 2,
      DB_LOCKED: 1,
      MESSAGE_NOT_FOUND: 1,
      REDACT_TEXT_NOT_FOUND: 1,
      FILE_NOT_FOUND: 1,
      SCHEMA_MISMATCH: 1,
      MIGRATION_FAILED: 1,
      FILES_UNAVAILABLE: 1,
      SHIM_MISSING: 1,
      SHIM_INVALID: 1,
      SETUP_INCOMPLETE: 1,
      SETUP_CANCELLED: 1,
      SEARCH_FAILED: 1,
      VERSION_MISMATCH: 1,
      DAEMON_RUNNING: 1,
      DAEMON_NOT_INSTALLED: 2,
      DAEMON_CONTROL_FAILED: 1,
      CONFIRMATION_REQUIRED: 3,
    });
  });

  it('never gives a failure the exit code of success', () => {
    for (const spec of Object.values(ERROR_CODES)) {
      expect([1, 2, 3]).toContain(spec.exit);
    }
  });

  it('says a lock is worth running again, and a usage mistake is not', () => {
    expect(ERROR_CODES.DB_LOCKED.retryable).toBe(true);
    expect(ERROR_CODES.USAGE.retryable).toBe(false);
    expect(ERROR_CODES.CONFIRMATION_REQUIRED.retryable).toBe(false);
    // Left out where it depends on what went wrong: the envelope reports that
    // as "nobody knows" rather than as a guess either way (Conventions).
    expect(ERROR_CODES.FILES_UNAVAILABLE.retryable).toBeUndefined();
  });

  it('recognises its own codes and nothing else', () => {
    for (const code of Object.keys(ERROR_CODES)) {
      expect(isErrorCode(code)).toBe(true);
    }
    // A warning code is not an error code, and a connector's own code is
    // neither: `errorCodeSpec` has to answer `undefined` rather than guess.
    expect(isErrorCode('SPOOLED')).toBe(false);
    expect(isErrorCode('CLAUDE_CODE_SETTINGS_UNREADABLE')).toBe(false);
    expect(errorCodeSpec('CLAUDE_CODE_SETTINGS_UNREADABLE')).toBeUndefined();
    expect(errorCodeSpec('USAGE')).toBe(ERROR_CODES.USAGE);
  });
});

/**
 * The hint style of the Conventions table, on every code: Korean, no full stop,
 * commands in backticks. A hint is what an agent reads instead of guessing a
 * next step, so one written in another voice is one it will skip — and since
 * the person reading it reads Korean (Conventions, output language 2026-10-16),
 * an English hint is one of the two ways to get that wrong.
 *
 * There is no "starts in lower case" rule any more: Korean has no case, so the
 * rule that used to carry the register is `assertKoreanProse` plus the full
 * stop below.
 */
/**
 * Everything wrong with one hint's style, as a list rather than as assertions,
 * so the rules themselves can be held against hints that break them — a style
 * check nobody has ever seen fail is a style check that may not work.
 */
function hintStyleProblems(hint: string): readonly string[] {
  const problems: string[] = [];
  if (hint === '') problems.push('빈 hint');
  if (/[.。]$/.test(hint)) problems.push('마침표로 끝난다');
  // Everything inside backticks removed: what is left must not read like a
  // command. A command is the binary followed by a verb — `brain` on its own
  // is the noun, which a Korean sentence says all the time (`이 brain을 …`),
  // and JavaScript's `\b` does not see a Hangul particle as a word break.
  if (/brain +[a-z]/.test(hint.replace(/`[^`]*`/g, ''))) problems.push('백틱 밖의 명령');
  if (hint.split('`').length % 2 === 0) problems.push('백틱이 짝이 맞지 않는다');
  // A code a typo can produce must not point at a destructive command
  // (Conventions): the hint is read by something that will run it. Both
  // languages, because the command stays English inside a Korean sentence.
  if (/\b(rm|delete|remove|uninstall|drop)\b/.test(hint)) problems.push('파괴적인 명령');
  if (/(지우|삭제|제거|없애|비우)/.test(hint)) problems.push('파괴적인 안내');
  return problems;
}

describe('the hint of every error code', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  it.each(codes)('%s has one, in the Conventions style', (code) => {
    const { hint } = ERROR_CODES[code];

    expect(hint).not.toBe('');
    expect(hintStyleProblems(hint), hint).toEqual([]);
  });

  it.each(codes)('%s is Korean', (code) => {
    assertKoreanProse(ERROR_CODES[code].hint, { label: `${code} hint` });
  });
});

describe('the hint style check', () => {
  it.each([
    ['마침표로 끝나는 한국어 hint', '`brain setup run`으로 설치하세요.', '마침표로 끝난다'],
    ['백틱 없는 명령', 'brain setup run 을 실행하세요', '백틱 밖의 명령'],
    ['백틱 없는 명령이 뒤에 섞인 것', '`--help`를 보고 brain doctor run 하세요', '백틱 밖의 명령'],
    ['열린 백틱', '`brain setup run으로 설치하세요', '백틱이 짝이 맞지 않는다'],
    ['영어 파괴 낱말', '`brain setup run`을 rm 하세요', '파괴적인 명령'],
    ['한국어 파괴 안내', '`config.toml`을 지우고 다시 실행하세요', '파괴적인 안내'],
  ])('catches %s', (_what, hint, problem) => {
    expect(hintStyleProblems(hint)).toContain(problem);
  });

  it('allows brain as a noun, which a Korean sentence needs', () => {
    expect(hintStyleProblems('`brain setup run`으로 이 brain을 설치하세요')).toEqual([]);
  });

  it('passes every hint this build ships', () => {
    for (const spec of Object.values(ERROR_CODES)) {
      expect(hintStyleProblems(spec.hint), spec.hint).toEqual([]);
    }
  });
});

/**
 * The checker itself, on the cases it exists for. A test that only ever ran
 * against text that passes would not notice a checker that passes everything —
 * and every later story leans on this one to catch an English sentence it
 * added.
 */
describe('the output-language check', () => {
  it('passes a Korean sentence that carries commands, codes and paths', () => {
    expect(
      englishSentences('`brain setup run`으로 이 brain을 설치하세요'),
    ).toEqual([]);
    expect(
      englishSentences('config: fail [CONFIG_MISSING] /home/me/config.toml이 없습니다'),
    ).toEqual([]);
    expect(englishSentences('요약: 통과 3, 경고 0, 실패 1, 건너뜀 2')).toEqual([]);
    // A detail that is only data — a version, a path — is not prose at all.
    expect(englishSentences('db: ok 3.50.4')).toEqual([]);
  });

  it('catches an English hint', () => {
    expect(englishSentences('run `brain setup run` to install this brain')).not.toEqual([]);
    expect(() => assertKoreanProse('fix the key the message names')).toThrow(/영어/);
  });

  it('catches an English doctor detail', () => {
    expect(englishSentences('wal: fail journal_mode is delete, not wal')).not.toEqual([]);
    // One English word and no Korean anywhere is still an English line.
    expect(englishSentences('foreign-keys: ok enforced')).not.toEqual([]);
  });

  it('catches an English clause in a line that is otherwise Korean', () => {
    // Hangul is decided per clause: a line that ends in an English sentence is
    // the usual way a translation gets left out, and the Korean in front of it
    // must not excuse it.
    expect(
      englishSentences('/x/bin/brain에 실행 권한이 없습니다. Run `brain setup run`.'),
    ).not.toEqual([]);
    expect(englishSentences('요약: passed 3, warned 0, failed 1, skipped 2')).not.toEqual([]);
  });

  it('names what it caught, so a failing test says which string to fix', () => {
    expect(() => assertKoreanProse('this is not Korean', { label: 'hint' })).toThrow(/hint/);
  });
});

/**
 * The exit-code table, and the one value every surface renders it from. It is
 * the fact an agent needs most and the one nothing else in the code says: the
 * numbers themselves live in `FailureExit`, what they mean and what to do
 * about them live only here.
 */
describe('the exit codes', () => {
  it('covers 0 through 3 and the hook rule that overrides all of them', () => {
    expect(EXIT_CODES.map((row) => row.code)).toEqual(['0', '1', '2', '3', 'hook']);
  });

  it('says what each one means and what an agent should do about it', () => {
    for (const row of EXIT_CODES) {
      expect(row.meaning, row.code).not.toBe('');
      expect(row.agent_action, row.code).not.toBe('');
    }
  });

  it('gives every error code an exit code the table also explains', () => {
    const explained = new Set(EXIT_CODES.map((row) => row.code));
    for (const spec of Object.values(ERROR_CODES)) {
      expect(explained).toContain(String(spec.exit));
    }
  });
});

describe('the guide', () => {
  it('carries the three tables, whole', () => {
    const guide = exitCodeGuide();

    expect(guide.exit_codes).toEqual([...EXIT_CODES]);
    expect(guide.error_codes.map((row) => row.code)).toEqual(Object.keys(ERROR_CODES));
    expect(guide.warning_codes.map((row) => row.code)).toEqual([...WARNING_CODES]);
  });

  it('hands each error code its own exit code, retryability, meaning and hint', () => {
    for (const row of exitCodeGuide().error_codes) {
      const spec = ERROR_CODES[row.code];
      expect(row.exit_code).toBe(spec.exit);
      expect(row.meaning).toBe(spec.meaning);
      expect(row.hint).toBe(spec.hint);
      // Left out rather than guessed at, the way the spec leaves it out.
      expect('retryable' in row).toBe(spec.retryable !== undefined);
    }
  });

  it('cannot be changed by whoever asked for it', () => {
    // Every surface renders this; one that edited the table it was handed
    // would change what the next caller is told. The row fields are `readonly`,
    // so this takes a cast — and the copy `exitCodeGuide` hands out is what
    // makes even the cast harmless.
    const first = exitCodeGuide();
    (first.exit_codes[0] as { meaning: string }).meaning = '아무 말';

    expect(exitCodeGuide().exit_codes[0]?.meaning).toBe(EXIT_CODES[0]?.meaning);
  });

  it('writes a conventions section built from the same exit-code table', () => {
    const shown = guideShow();

    expect(shown).toContain('## CLI 사용 규약');
    for (const row of EXIT_CODES) {
      expect(shown).toContain(row.meaning);
      expect(shown).toContain(row.agent_action);
    }
  });

  it('names all six things an agent must not do', () => {
    const shown = guideShow();

    // The Conventions' own list. A section that quietly loses one is a section
    // that permits it.
    for (const forbidden of [
      '`--yes`',
      '`error.retry`',
      '백오프',
      '덜 파괴적인 동사',
      '이전 승인',
      '`--json`으로 확인을 피해',
    ]) {
      expect(shown, forbidden).toContain(forbidden);
    }
    expect(shown).toContain('stderr');
  });
});

describe('the meaning of every error code', () => {
  const codes = Object.keys(ERROR_CODES) as ErrorCode[];

  it.each(codes)('%s says what happened, not what to do about it', (code) => {
    const { meaning, hint } = ERROR_CODES[code];

    expect(meaning).not.toBe('');
    // The two are different sentences: the meaning is the diagnosis and the
    // hint is the next step, and one standing in for the other leaves a reader
    // either with no problem named or with no way out of it.
    expect(meaning).not.toBe(hint);
  });

  it.each(codes)('%s is Korean', (code) => {
    assertKoreanProse(ERROR_CODES[code].meaning, { label: `${code} meaning` });
  });
});
