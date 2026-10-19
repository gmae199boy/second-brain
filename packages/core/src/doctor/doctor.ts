import { transcriptChanges } from '../capture/scan.js';
import {
  TRANSCRIPT_DEADLINE_WARN_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
} from '../domain/transcript-file.js';
import { checkSchema } from '../schema.js';
import type { Clock } from '../ports/clock.js';
import type {
  HealthStore,
  SchemaStore,
  StoreProbe,
  TranscriptFileStore,
  WorkStore,
} from '../ports/store.js';
import type { TranscriptFolder, TranscriptListing } from '../ports/transcript.js';

/**
 * What one check came to (Conventions). `warn` is the status a report needs
 * most: a check that ran and could not settle its question — a brain another
 * process is writing to, a probe that has to wait for a lock — is neither a
 * pass nor a failure, and reporting it as either hides something. `skip` is a
 * check that never ran, and says in its `detail` why.
 *
 * Only `fail` makes the command exit 1. A `warn` is worth printing and not
 * worth failing a hook over.
 */
export type DoctorCheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  /** Stable, neutral identifier for the check. */
  id: string;
  status: DoctorCheckStatus;
  /**
   * Human-readable extra information, when there is any. Required in spirit
   * for `warn` and `skip`: the whole content of those two is why.
   */
  detail?: string;
  /** Machine-readable code, set only for failures that carry one. */
  code?: string;
}

/** How many checks came to each status. The last line of a report (Conventions). */
export interface DoctorSummary {
  passed: number;
  warned: number;
  failed: number;
  skipped: number;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /**
   * The counts of `checks`, computed here rather than by each reader: three
   * surfaces print this report, and three loops over it would be three chances
   * to count a `warn` as a pass.
   */
  summary: DoctorSummary;
}

/**
 * The `detail` of a check that did not run because another one failed. One
 * phrase, so `앞선 점검 실패: db` and `앞선 점검 실패: shim` read as the same
 * kind of answer wherever the skipped check lives — Core's own, or one the
 * runtime registered.
 */
export function prereqFailed(id: string): string {
  return `앞선 점검 실패: ${id}`;
}

/**
 * One check somebody outside Core registered.
 *
 * Which checks exist is Core's business (AD-5), but Core knows nothing about
 * machines: it has no filesystem, no environment and no child processes. So
 * everything a store can answer — the schema version today, spool depth later —
 * is Core's own, and every machine fact — the shim, the node that runs it, the
 * configuration file — is handed in as one of these by the runtime that does
 * have a filesystem. The list is the seam, so adding a check never changes the
 * shape of anything.
 */
export interface DoctorCheckSource {
  /** The id this source answers under, used when `run` throws. */
  id: string;
  /** Never throws, by contract — and a source that does is still only a `fail`. */
  run(): Promise<DoctorCheck>;
}

/**
 * The reads the two capture checks need: what is still failing, and what has
 * been collected out of which transcript (AD-21, Table Contract).
 *
 * It is a type of its own and not the whole `Store` because doctor may read and
 * must never write: a report is the command a person runs when things are
 * already wrong, and a check that took the write lock would be the one thing
 * that makes a busy brain look broken (AD-7).
 */
export type DoctorReadStore = Pick<WorkStore, 'listFailures'> &
  Pick<TranscriptFileStore, 'listTranscriptFiles'>;

export interface DoctorOptions {
  /** Schema version this build was made for, for the `schema-version` check. */
  schemaVersion: number;
  /**
   * The same store, under the capabilities the `failures` and `transcripts`
   * checks read. It is a second field rather than a wider first parameter
   * because `runDoctor`'s first parameter is what every adapter has to offer to
   * be reportable at all, and these two capabilities arrive later (AD-10).
   */
  store: DoctorReadStore;
  /** The one clock: the transcript deadline is measured against it (AD-13). */
  clock: Clock;
  /**
   * The transcript folders this build looks in. Empty — which is what the
   * capture switch being off means — makes the `transcripts` check a `skip`
   * rather than a report about nothing (Boundaries).
   */
  folders?: readonly TranscriptFolder[];
  /** Checks the runtime registered, run in order after the store's own. */
  checks?: readonly DoctorCheckSource[];
}

/**
 * Report on the brain without throwing. A degraded brain yields failing checks,
 * not an exception: the caller decides the exit code. One check that fails, or
 * that throws, never stops the ones after it — a report that stopped at the
 * first problem would hide every other one.
 *
 * The order is store first, then machine: `db`, the adapter's own probes, the
 * schema version, and then whatever the runtime registered.
 *
 * A store that could not be reached reports the `db` check and no probe: it ran
 * no probes, so there is nothing to say about them, and inventing a row for
 * each capability the adapter might have had would claim knowledge Core does
 * not have — it never learns which capabilities a source offers (AD-10). The
 * schema version is reported all the same, as a `skip` naming `db` as the
 * reason: "not checked" and "checked and fine" are different answers, and a
 * report that left the line out entirely would make a reader work out which
 * one it meant from what is missing.
 *
 * The registered checks still run: the shim and the node behind it are facts
 * about the machine, and an unreachable database is often exactly when a person
 * needs to know them.
 */
export async function runDoctor(
  store: HealthStore & SchemaStore,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const health = await store.checkHealth();
  if (!health.ok) {
    checks.push({ id: 'db', status: 'fail', code: health.code, detail: health.message });
    // Everything a store would have answered is skipped under the same reason,
    // so a reader never has to work out from what is missing whether a check
    // was skipped or never existed.
    for (const id of ['schema-version', 'failures', 'transcripts']) {
      checks.push({ id, status: 'skip', detail: prereqFailed('db') });
    }
  } else {
    checks.push({ id: 'db', status: 'ok', detail: health.serverVersion });
    checks.push(...health.source.probes.map(probeCheck));
    checks.push(await schemaCheck(store, options.schemaVersion));
    checks.push(await failuresCheck(options.store));
    checks.push(await transcriptsCheck(options));
  }

  for (const source of options.checks ?? []) {
    checks.push(await registered(source));
  }

  return { checks, summary: summarise(checks) };
}

/** The counts of one report, in the order the summary line prints them. */
function summarise(checks: readonly DoctorCheck[]): DoctorSummary {
  const count = (status: DoctorCheckStatus): number =>
    checks.filter((check) => check.status === status).length;
  return {
    passed: count('ok'),
    warned: count('warn'),
    failed: count('fail'),
    skipped: count('skip'),
  };
}

/**
 * One probe as one check. Core passes the adapter's own name through, and its
 * own verdict: a probe that passed without settling the question says so with
 * `warn: true`, because only the adapter knows that it had to give up on the
 * lock rather than find the file unwritable.
 */
function probeCheck(probe: StoreProbe): DoctorCheck {
  const check: DoctorCheck = { id: probe.id, status: probeStatus(probe) };
  if (probe.detail !== undefined && probe.detail !== '') {
    check.detail = probe.detail;
  }
  return check;
}

function probeStatus(probe: StoreProbe): DoctorCheckStatus {
  if (!probe.ok) return 'fail';
  return probe.warn === true ? 'warn' : 'ok';
}

/**
 * The stored schema version against the one this build was made for, through
 * the same `checkSchema` the write guard uses (AD-20), so doctor and the guard
 * can never disagree about what counts as a mismatch. A mismatch carries
 * `SCHEMA_MISMATCH`, which is a shared warning code, so the CLI puts it in
 * `warnings[]` as well.
 */
async function schemaCheck(store: SchemaStore, expected: number): Promise<DoctorCheck> {
  const schema = await checkSchema(store, expected);
  if (schema.ok) {
    return { id: 'schema-version', status: 'ok', detail: String(schema.version) };
  }
  return { id: 'schema-version', status: 'fail', code: schema.code, detail: schema.message };
}

/**
 * What is still failing (FR-5, NFR-2).
 *
 * A `warn` and not a `fail` whenever there is anything, because a recorded
 * failure is the mechanism working: the work stopped, it said so, and `brain
 * failures retry` is what asks for another go. Nothing is broken about the
 * brain, and a hook must not be failed over it.
 *
 * No code: a failure record is not one of the degraded states of the
 * Conventions table, and inventing a code for it would mean every surface had
 * to learn a word that says no more than the count does (Boundaries).
 */
async function failuresCheck(store: DoctorReadStore): Promise<DoctorCheck> {
  const read = await store.listFailures({ includeResolved: false });
  if (!read.ok) {
    return { id: 'failures', status: 'fail', code: read.code, detail: read.message };
  }
  if (read.failures.length === 0) {
    return { id: 'failures', status: 'ok', detail: '0건' };
  }

  // By kind of target, because that is what tells a reader which command to
  // reach for: sessions are collected again, and other kinds arrive with the
  // stories that add them (`FAILURE_RETRY_KINDS`).
  const byKind = new Map<string, number>();
  for (const failure of read.failures) {
    byKind.set(failure.targetKind, (byKind.get(failure.targetKind) ?? 0) + 1);
  }
  const detail = [...byKind.entries()]
    .map(([kind, count]) => `${kind} ${String(count)}건`)
    .join(', ');
  return { id: 'failures', status: 'warn', detail };
}

/**
 * How many transcripts on the disk this brain has not collected, and whether
 * any of them is close to being deleted (FR-5, SM-5).
 *
 * The comparison is the scan's own function, so the number this reports is the
 * number a drain would act on (`transcriptChanges`). What makes it a `warn` is
 * a deadline and not a count: a harness keeps a transcript for
 * `TRANSCRIPT_RETENTION_DAYS` and then it is gone for good, so an uncollected
 * file older than that minus `TRANSCRIPT_DEADLINE_WARN_DAYS` is the one case
 * where waiting loses something. A folder nobody could list is a `warn` too —
 * "there is nothing to collect" and "I could not look" are different answers,
 * and reporting the second as the first is the silent failure of NFR-2.
 *
 * No folders is a `skip`, naming why: a build whose capture switch is off is
 * not a build with nothing to collect, and `ok` would say it was (Boundaries).
 */
async function transcriptsCheck(options: DoctorOptions): Promise<DoctorCheck> {
  const folders = options.folders ?? [];
  if (folders.length === 0) {
    return {
      id: 'transcripts',
      status: 'skip',
      detail: '트랜스크립트 폴더 수집이 꺼져 있습니다',
    };
  }

  const uncollected: TranscriptListing[] = [];
  const problems: string[] = [];
  for (const folder of folders) {
    const listed = await folder.list();
    if (!listed.ok) {
      problems.push(`"${folder.harness}" 폴더를 읽을 수 없습니다: ${listed.message}`);
      continue;
    }
    const history = await options.store.listTranscriptFiles({ harness: folder.harness });
    if (!history.ok) {
      problems.push(`"${folder.harness}" 내역을 읽을 수 없습니다: ${history.message}`);
      continue;
    }
    uncollected.push(...transcriptChanges(listed.files, history.files));
  }

  const count = `미수집 ${String(uncollected.length)}건`;
  if (problems.length > 0) {
    return { id: 'transcripts', status: 'warn', detail: `${count}, ${problems.join('. ')}` };
  }

  const deadlineMs =
    options.clock.now().getTime() -
    (TRANSCRIPT_RETENTION_DAYS - TRANSCRIPT_DEADLINE_WARN_DAYS) * DAY_MS;
  const overdue = uncollected.filter((file) => file.modifiedAt.getTime() < deadlineMs);
  if (overdue.length > 0) {
    return {
      id: 'transcripts',
      status: 'warn',
      detail:
        `${count}, 그중 ${String(overdue.length)}건은 하네스가 ` +
        `${String(TRANSCRIPT_RETENTION_DAYS)}일 뒤 지우는 기한에 가까워졌습니다`,
    };
  }
  return { id: 'transcripts', status: 'ok', detail: count };
}

/** One day in milliseconds, for the retention arithmetic above. */
const DAY_MS = 86_400_000;

/**
 * One registered check. A source that throws is a failed check and nothing
 * more: doctor is the command a person runs when things are already wrong, so
 * it is the last place that may crash.
 */
async function registered(source: DoctorCheckSource): Promise<DoctorCheck> {
  try {
    return await source.run();
  } catch (error) {
    return { id: source.id, status: 'fail', detail: `점검이 실패했습니다: ${oneLine(error)}` };
  }
}

/** The first line of whatever went wrong, so a detail stays one line. */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '알 수 없는 오류';
}
