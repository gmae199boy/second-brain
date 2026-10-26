import { DRAIN_BUDGET_MS, type BrainDrainReport } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * `brain queue drain`: work the backlog of `work_items` within a time budget
 * (AD-7, AD-21).
 *
 * It is the command launchd calls every five minutes (AD-25) and the one a
 * person calls when they want the queue emptied now. It is also the one command
 * that turns the opportunistic drain *off*: a drain at the end of a drain would
 * be a second run of the same loop with whatever budget was left over.
 *
 * `writes: true`, so the dispatcher's write guard compares the stored schema
 * version before `run` is called at all (AD-20). No `spool` branch, and that is
 * deliberate: there is nothing to defer here — the work is already deferred,
 * which is what a queue is. A database the guard found out of reach means the
 * command is refused at the exit code of the guard's own code.
 *
 * One run is three steps, and the counts of all three are in one answer: the
 * spool goes back in, the transcript folders are scanned, and the queue is
 * worked (`BrainDrainReport`, Design Notes).
 */

/** The report, in the envelope's spelling (Conventions, 이름). */
export interface QueueDrainData {
  /** Spool records that went back into the database (AD-9). */
  replayed: number;
  /** Spool lines moved aside because nobody will try them again (AD-9). */
  spool_failed: number;
  /** `session_ingest` items the folder scan put on the queue (AD-4). */
  enqueued: number;
  /** Sessions an older parser read whose transcript is gone, so not re-read. */
  reread_missing: number;
  /** Files a newer extractor would read differently that are redacted (AD-11). */
  reextract_redacted: number;
  /** The same, for files whose original cannot be reached any more (AD-24). */
  reextract_unreachable: number;
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
  released: number;
  lost: number;
  spooled: number;
  /** `empty`, `budget` or `unwritable`. */
  stopped: string;
}

/** The widest and narrowest budget the flag accepts, in seconds. */
const MIN_BUDGET_SECONDS = 1;
const MAX_BUDGET_SECONDS = 3600;

export const queueDrainCommand: CommandSpec<QueueDrainData> = {
  ns: 'queue',
  verb: 'drain',
  nsDescription: '밀린 일을 처리합니다',
  usedFor: '밀린 일감을 시간 예산 안에서 처리합니다',
  required: [],
  examples: ['brain queue drain', 'brain queue drain --budget 60 --json'],
  output:
    '되넣음·실패로 옮김·새 일감·다시 못 읽음 건수(`replayed`, `spool_failed`, `enqueued`, `reread_missing`), 다시 추출을 건너뛴 가린 파일·원본 불가 파일 건수(`reextract_redacted`, `reextract_unreachable`), 청구·완료·다시 시도·실패·돌려줌·놓침·spool 건수(`claimed`, `completed`, `retried`, `failed`, `released`, `lost`, `spooled`)와 멈춘 이유 `stopped`',
  risk: 'write',
  hook: false,
  dryRun: false,
  writes: true,
  // A drain at the end of a drain would be a second run of the same loop.
  drain: false,
  options: [
    {
      flags: '--budget <seconds>',
      description: `일감을 청구할 수 있는 시간, 초 단위 (${String(MIN_BUDGET_SECONDS)}~${String(MAX_BUDGET_SECONDS)})`,
    },
  ],

  async run(context) {
    const budget = budgetMs(context.options['budget']);
    if (!budget.ok) return budget;

    const report = await context.brain.queue.drain({ budgetMs: budget.value });

    if (report.stopped === 'unwritable') {
      // The code of whatever stopped the write, so the exit code and the hint
      // are the code table's (Conventions). The counts go in the sentence,
      // because a failure envelope carries no `data` to put them in.
      return {
        ok: false as const,
        code: report.code ?? 'DB_UNAVAILABLE',
        message: `데이터베이스에 쓸 수 없어서 멈췄습니다. ${counts(report)}`,
      };
    }

    return {
      ok: true as const,
      // A file that is behind and out of reach is nothing this command can fix
      // and nothing anything else will queue, so the result is degraded and
      // says so under its own code (NFR-2, AD-24). A redacted one is not: there
      // are no bytes to read on purpose, which is the system working.
      ...(report.reextractUnreachable > 0
        ? { warnings: ['FILE_SOURCE_UNREACHABLE'] as const }
        : {}),
      data: {
        replayed: report.replayed,
        spool_failed: report.spoolFailed,
        enqueued: report.enqueued,
        reread_missing: report.rereadMissing,
        reextract_redacted: report.reextractRedacted,
        reextract_unreachable: report.reextractUnreachable,
        claimed: report.claimed,
        completed: report.completed,
        retried: report.retried,
        failed: report.failed,
        released: report.released,
        lost: report.lost,
        spooled: report.spooled,
        stopped: report.stopped,
      },
      text: [`${counts(report)} ${reasons[report.stopped]}`],
    };
  },
};

/** Why the run stopped, for the person reading the one line it prints. */
const reasons: Readonly<Record<BrainDrainReport['stopped'], string>> = {
  empty: '할 일이 없습니다.',
  budget: '시간 예산이 끝나 남은 일은 다음 실행으로 넘깁니다.',
  unwritable: '데이터베이스에 쓸 수 없습니다.',
};

/**
 * The counts as one sentence, shared by the line and the failure message.
 *
 * Every clause carries `건`, the last one included. The output-language check
 * reads a line clause by clause, and `spool 0` on its own is a clause with no
 * Korean in it at all — which is exactly what that check exists to catch
 * (Conventions, 출력 언어).
 */
function counts(report: BrainDrainReport): string {
  return (
    `되넣음 ${String(report.replayed)}건, 실패로 옮김 ${String(report.spoolFailed)}건, ` +
    `새 일감 ${String(report.enqueued)}건, 다시 못 읽음 ${String(report.rereadMissing)}건, ` +
    `다시 추출 건너뜀 가림 ${String(report.reextractRedacted)}건, ` +
    `다시 추출 건너뜀 원본 불가 ${String(report.reextractUnreachable)}건, ` +
    `청구 ${String(report.claimed)}건, 완료 ${String(report.completed)}건, ` +
    `다시 시도 ${String(report.retried)}건, 실패 ${String(report.failed)}건, ` +
    `돌려줌 ${String(report.released)}건, 놓침 ${String(report.lost)}건, ` +
    `spool ${String(report.spooled)}건.`
  );
}

/**
 * The budget this invocation asked for, in milliseconds, or why the flag cannot
 * be used.
 *
 * Seconds on the command line and milliseconds inside, because a person types
 * seconds and every budget in Core is a millisecond count. Anything that is not
 * a whole number of seconds in range is a `USAGE`: a drain asked to run for
 * `abc`, for zero or for a day is a broken command line, not a run to make a
 * guess about.
 */
function budgetMs(
  given: unknown,
): { ok: true; value: number } | { ok: false; code: 'USAGE'; message: string; exit: 2 } {
  if (given === undefined) return { ok: true, value: DRAIN_BUDGET_MS.command };

  const text = String(given);
  const seconds = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(seconds)) {
    return {
      ok: false,
      code: 'USAGE',
      message: `\`--budget\`은 초 단위 정수입니다. "${text}"는 정수가 아닙니다.`,
      exit: 2,
    };
  }
  if (seconds < MIN_BUDGET_SECONDS || seconds > MAX_BUDGET_SECONDS) {
    return {
      ok: false,
      code: 'USAGE',
      message:
        `\`--budget\`은 ${String(MIN_BUDGET_SECONDS)}에서 ${String(MAX_BUDGET_SECONDS)}초 사이입니다. ` +
        `${String(seconds)}는 그 밖입니다.`,
      exit: 2,
    };
  }
  return { ok: true, value: seconds * 1000 };
}
