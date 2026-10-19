import type { FailuresRetrySkipped } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * `brain failures retry`: ask for one more go at everything that is still
 * failing (FR-5, NFR-2).
 *
 * It writes to the queue and not to `failures`, which is the whole of its
 * design: a failure row is a record, and what marks one resolved is the work
 * actually going through. So this adds one queue item per target and answers at
 * once — and the opportunistic drain at the end of this very command is what
 * then does the work (AD-7), which is why a successful retry usually looks
 * instant from the outside.
 *
 * `writes: true`, so the write guard compares the schema version before `run`
 * is called (AD-20). No `spool` branch: a request for a retry is not a write
 * that has to be kept — the failures are still recorded, and the same command
 * can be run again once the database is reachable (AD-9).
 */

/** The result, in the envelope's spelling (Conventions, 이름). */
export interface FailuresRetryData {
  /** New queue rows this call created. */
  added: number;
  /** Targets that already had an open item, so nothing was added (AD-21). */
  already_open: number;
  /** Target kinds this build has no retry work for, with their counts. */
  skipped: readonly { target_kind: string; count: number }[];
}

export const failuresRetryCommand: CommandSpec<FailuresRetryData> = {
  ns: 'failures',
  verb: 'retry',
  nsDescription: '실패를 보고 다시 합니다',
  usedFor: '미해결 실패의 대상을 다시 처리하도록 일감을 넣습니다',
  required: [],
  examples: ['brain failures retry', 'brain failures retry --target-kind session --json'],
  output:
    '새로 넣은 일감 수 `added`, 이미 열려 있던 수 `already_open`, 다시 할 방법이 없어 건너뛴 대상 종류와 건수 `skipped`',
  risk: 'write',
  hook: false,
  dryRun: false,
  writes: true,
  options: [
    {
      flags: '--target-kind <kind>',
      description: '이 종류의 대상만 다시 합니다 (예: `session`)',
    },
  ],

  async run(context) {
    const targetKind = textOf(context.options['target-kind']);
    const result = await context.brain.failures.retry(
      targetKind === undefined ? {} : { targetKind },
    );
    if (!result.ok) {
      return { ok: false as const, code: result.code, message: result.message };
    }

    return {
      ok: true as const,
      data: {
        added: result.added,
        already_open: result.alreadyOpen,
        skipped: result.skipped.map((entry) => ({
          target_kind: entry.targetKind,
          count: entry.count,
        })),
      },
      text: [line(result.added, result.alreadyOpen), ...skippedLines(result.skipped)],
    };
  },
};

/**
 * The one line a person reads. Every clause carries `건`, the last one
 * included: the output-language check reads a line clause by clause, and a
 * clause of a bare number and an English word is exactly what it exists to
 * catch (Conventions, 출력 언어).
 */
function line(added: number, alreadyOpen: number): string {
  return `새 일감 ${String(added)}건, 이미 열려 있던 것 ${String(alreadyOpen)}건.`;
}

/**
 * What was left alone, by kind. A line each rather than a clause, because the
 * answer is "nothing in this build can retry that" and that deserves its own
 * sentence (`FAILURE_RETRY_KINDS`).
 */
function skippedLines(skipped: readonly FailuresRetrySkipped[]): readonly string[] {
  return skipped.map(
    (entry) =>
      `${entry.targetKind} 대상 ${String(entry.count)}건은 이 빌드가 다시 할 방법이 없어 건너뜁니다.`,
  );
}

/** One option as a non-empty string, or `undefined` for a flag nobody gave. */
function textOf(given: unknown): string | undefined {
  if (typeof given !== 'string') return undefined;
  const trimmed = given.trim();
  return trimmed === '' ? undefined : trimmed;
}
