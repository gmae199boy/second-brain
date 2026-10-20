import { FAILURES_LIST_LIMIT, isoWithOffset, type FailureRecord } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * `brain failures list`: what is still wrong (FR-5, NFR-2).
 *
 * `failures` is a record and not a queue (AD-21), so this reads and changes
 * nothing — `risk: read`, no `writes`. What asks for another attempt is
 * `brain failures retry`, and what closes a row is the work finally going
 * through.
 *
 * The default is the unresolved rows alone, because that is the question: a
 * brain that has been running for a year has far more history than trouble, and
 * a list that mixed the two would need reading before it could be acted on.
 */

/** One failure, in the envelope's spelling (Conventions, 이름). */
export interface FailuresListRow {
  id: string;
  target_kind: string;
  target_id: string;
  stage: string;
  code: string;
  message: string;
  harness: string | null;
  session_id: string | null;
  /** ISO-8601 with this machine's offset, as every instant in `--json` is. */
  occurred_at: string;
  resolved_at: string | null;
  /** When the cause was first met, and how often it has been met (0005). */
  first_occurred_at: string;
  occurrences: number;
}

export interface FailuresListData {
  failures: readonly FailuresListRow[];
}

export const failuresListCommand: CommandSpec<FailuresListData> = {
  ns: 'failures',
  verb: 'list',
  nsDescription: '실패를 보고 다시 합니다',
  usedFor: '기록된 실패를 봅니다',
  required: [],
  examples: [
    'brain failures list',
    'brain failures list --target-kind session --json',
    'brain failures list --all --limit 20',
  ],
  output:
    '실패 목록 `failures`(각 행에 `id`, `target_kind`, `target_id`, `stage`, `code`, `message`, `harness`, `session_id`, `occurred_at`, `resolved_at`, `first_occurred_at`, `occurrences`)와 건수 `count`·더 있는지 `has_more`',
  risk: 'read',
  hook: false,
  dryRun: false,
  options: [
    {
      flags: '--target-kind <kind>',
      description: '이 종류의 대상에 대한 실패만 봅니다 (예: `session`)',
    },
    { flags: '--all', description: '이미 해결된 실패도 함께 봅니다' },
    {
      flags: '--limit <n>',
      description: `몇 건까지 볼지 (${String(FAILURES_LIST_LIMIT.min)}~${String(FAILURES_LIST_LIMIT.max)}, 기본 ${String(FAILURES_LIST_LIMIT.default)})`,
    },
  ],

  async run(context) {
    const limit = limitOf(context.options['limit']);
    if (!limit.ok) return limit;

    const targetKind = textOf(context.options['target-kind']);
    const result = await context.brain.failures.list({
      ...(targetKind === undefined ? {} : { targetKind }),
      all: context.options['all'] === true,
      ...(limit.value === undefined ? {} : { limit: limit.value }),
    });
    if (!result.ok) {
      return { ok: false as const, code: result.code, message: result.message };
    }

    return {
      ok: true as const,
      data: { failures: result.failures.map(row) },
      meta: { count: result.count, has_more: result.hasMore },
      text: lines(result.failures),
    };
  },
};

/**
 * One row of the human-readable output, and the count line under them.
 *
 * Every clause carries a Korean word, the identifiers included. The
 * output-language check reads a line clause by clause, and `session` on its own
 * is a clause with no Korean in it at all — which is exactly what that check
 * exists to catch (Conventions, 출력 언어).
 */
function lines(failures: readonly FailureRecord[]): readonly string[] {
  const rows = failures.map(
    (failure) =>
      `${isoWithOffset(failure.occurredAt)} 대상 ${failure.targetKind} ${failure.targetId}, ` +
      `단계 ${failure.stage}, 코드 ${failure.code}, ` +
      `횟수 ${String(failure.occurrences)}` +
      `${failure.resolvedAt === null ? '' : ' (해결됨)'}: ${failure.message}`,
  );
  // Always, 0 included: "there is nothing wrong" is an answer, and an empty
  // output would read as a command that did not run (NFR-2).
  return [...rows, `실패 ${String(failures.length)}건.`];
}

function row(failure: FailureRecord): FailuresListRow {
  return {
    id: failure.id,
    target_kind: failure.targetKind,
    target_id: failure.targetId,
    stage: failure.stage,
    code: failure.code,
    message: failure.message,
    harness: failure.harness,
    session_id: failure.sessionId,
    // The offset form, which is what every `--json` instant carries
    // (Conventions, 시각); the storage form is the database's own.
    occurred_at: isoWithOffset(failure.occurredAt),
    resolved_at: failure.resolvedAt === null ? null : isoWithOffset(failure.resolvedAt),
    first_occurred_at: isoWithOffset(failure.firstOccurredAt),
    occurrences: failure.occurrences,
  };
}

/**
 * The page this invocation asked for, or why the flag cannot be used.
 *
 * A whole number of rows in range, or a `USAGE`: a list asked for `abc`, for
 * zero or for a million is a broken command line and not a page to guess about.
 * The range itself is Core's, so the SDK and the CLI cannot disagree about it.
 */
function limitOf(
  given: unknown,
): { ok: true; value: number | undefined } | { ok: false; code: 'USAGE'; message: string; exit: 2 } {
  if (given === undefined) return { ok: true, value: undefined };

  const text = String(given);
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      code: 'USAGE',
      message: `\`--limit\`은 정수입니다. "${text}"는 정수가 아닙니다.`,
      exit: 2,
    };
  }
  const value = Number(text);
  if (value < FAILURES_LIST_LIMIT.min || value > FAILURES_LIST_LIMIT.max) {
    return {
      ok: false,
      code: 'USAGE',
      message:
        `\`--limit\`은 ${String(FAILURES_LIST_LIMIT.min)}에서 ${String(FAILURES_LIST_LIMIT.max)} 사이입니다. ` +
        `${String(value)}는 그 밖입니다.`,
      exit: 2,
    };
  }
  return { ok: true, value };
}

/** One option as a non-empty string, or `undefined` for a flag nobody gave. */
function textOf(given: unknown): string | undefined {
  if (typeof given !== 'string') return undefined;
  const trimmed = given.trim();
  return trimmed === '' ? undefined : trimmed;
}
