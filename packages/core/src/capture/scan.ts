import type { TranscriptFile } from '../domain/transcript-file.js';
import { formatSessionToken } from '../domain/session-token.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { TranscriptFileStore, WorkStore } from '../ports/store.js';
import type { TranscriptFolder, TranscriptListing } from '../ports/transcript.js';
import { SESSION_INGEST_KIND } from './session-ingest-work.js';

/**
 * The folder scan: the step of a drain that finds the sessions no hook
 * reported (AD-4, AD-7).
 *
 * It is a step of the drain and not a kind of work, deliberately (Decision 3,
 * 2026-10-19): a `transcript_scan` item would have to put itself back on the
 * queue for ever, and a queue holding one item that is always due is a queue
 * whose "is anything due" read is never false. So the drain scans, and what it
 * finds becomes one `session_ingest` item per changed file.
 *
 * The order of its reads is the whole design, and it is this order to save the
 * write lock: listing, then history, then the open items, then the unresolved
 * failures — four lock-free reads — and `addWork` only if something is left
 * over. So the opportunistic drain at the end of every command (AD-7) takes no
 * lock at all on a machine where nothing has changed, which is the ordinary
 * case.
 */

/**
 * The files a listing and the stored history disagree about: the ones with no
 * row, and the ones whose size is not the size the row remembers.
 *
 * Size and not the instant, because the instant is not evidence: a copy, a
 * restore and a backup tool all move `mtime` without changing a byte, and a
 * transcript that grew by one turn changed its size by construction. The
 * instant is used for the order the files are worked in and for the deadline
 * doctor warns about, and for nothing else.
 *
 * Pure, and shared by the scan and by doctor's `transcripts` check: "how many
 * are uncollected" and "which ones do I enqueue" have to be the same question,
 * or the report would be about a number no drain acts on.
 */
export function transcriptChanges(
  listing: readonly TranscriptListing[],
  rows: readonly TranscriptFile[],
): readonly TranscriptListing[] {
  const stored = new Map(rows.map((row) => [historyKey(row.harness, row.path), row.sizeBytes]));
  return listing.filter((file) => {
    const was = stored.get(historyKey(file.harness, file.path));
    return was === undefined || was !== file.sizeBytes;
  });
}

/** The key of `transcript_files`, as a string. A newline, because a path may hold anything else. */
function historyKey(harness: string, path: string): string {
  return `${harness}\n${path}`;
}

export interface ScanTranscriptsDependencies {
  /**
   * The history to compare against, the backlog to avoid queueing twice, the
   * failures to leave alone, and the one verb that writes.
   */
  store: TranscriptFileStore &
    Pick<WorkStore, 'addWork' | 'listOpenWorkTargets' | 'listFailures'>;
  /** The folders this build may look in. Empty scans nothing (Boundaries). */
  folders: readonly TranscriptFolder[];
  clock: Clock;
  /** Mints the id of each new queue row (AD-8). */
  idGen: IdGen;
}

export interface ScanTranscriptsOptions {
  /**
   * The instant, in milliseconds, after which no further item is enqueued.
   *
   * The drain's budget, shared with the replay and the queue loop around it: a
   * folder with a thousand changed files must not spend a command's whole
   * budget on `addWork` calls. Whatever is left over is found again by the next
   * scan, because nothing about this step remembers where it stopped.
   */
  deadline: number;
}

/** What one scan did (Boundaries, `brain queue drain`). */
export interface ScanTranscriptsReport {
  /** Files the listing and the history disagreed about. */
  changed: number;
  /** New `session_ingest` rows this scan put on the queue. */
  enqueued: number;
  /**
   * Changed files this scan deliberately left alone: a session already queued,
   * or one whose last collection failed and is waiting for `failures retry`
   * (Decision 4, 2026-10-19).
   */
  skipped: number;
  /**
   * What stopped the scan short, or `undefined` when nothing did. A sentence
   * and not a code: a folder nobody can read and a database that refused a
   * write are the scan's own trouble and not a state of the brain (NFR-2).
   */
  stopped?: string;
}

/**
 * Compare every folder against the history and queue what changed.
 *
 * Nothing throws and nothing is read twice. A folder that cannot be listed does
 * not stop the others — one harness's permissions are not another's — and its
 * sentence is reported; a database that refuses the `addWork` stops the scan
 * there, because the next call would refuse too.
 *
 * A session whose last `session_ingest` failed and has not been resolved is not
 * queued again. That is what keeps the ten-attempt rule meaningful: a scan that
 * re-enqueued it every five minutes would retry a permanently broken transcript
 * for ever, and `failures retry` is the deliberate act that asks for another go
 * (Decision 4, 2026-10-19).
 */
export async function scanTranscripts(
  dependencies: ScanTranscriptsDependencies,
  options: ScanTranscriptsOptions,
): Promise<ScanTranscriptsReport> {
  const { store, folders, clock, idGen } = dependencies;
  const { deadline } = options;

  const tally = { changed: 0, enqueued: 0, skipped: 0 };
  let stopped: string | undefined;
  const changed: TranscriptListing[] = [];

  for (const folder of folders) {
    const listed = await folder.list();
    if (!listed.ok) {
      stopped ??= `"${folder.harness}" 트랜스크립트 폴더를 읽을 수 없습니다: ${listed.message}`;
      continue;
    }
    const history = await store.listTranscriptFiles({ harness: folder.harness });
    if (!history.ok) {
      stopped ??= `"${folder.harness}" 트랜스크립트 내역을 읽을 수 없습니다: ${history.message}`;
      continue;
    }
    changed.push(...transcriptChanges(listed.files, history.files));
  }

  tally.changed = changed.length;
  // Nothing changed: no further read, and above all no write. This is the path
  // every opportunistic drain takes on a quiet machine (AD-7).
  if (changed.length === 0) return report(tally, stopped);

  const open = await store.listOpenWorkTargets({ kind: SESSION_INGEST_KIND });
  if (!open.ok) {
    return report(tally, stopped ?? `열린 일감을 읽을 수 없습니다: ${open.message}`);
  }
  const failures = await store.listFailures({
    targetKind: 'session',
    stage: SESSION_INGEST_KIND,
  });
  if (!failures.ok) {
    return report(tally, stopped ?? `미해결 실패를 읽을 수 없습니다: ${failures.message}`);
  }

  const leaveAlone = new Set<string>([
    ...open.targets
      .filter((target) => target.targetKind === 'session')
      .map((target) => target.targetId),
    ...failures.failures.map((failure) => failure.targetId),
  ]);

  // Oldest first: a transcript the harness will delete soonest is the one worth
  // collecting first when the budget runs out (`TRANSCRIPT_RETENTION_DAYS`).
  const queue = [...changed].sort(
    (left, right) => left.modifiedAt.getTime() - right.modifiedAt.getTime(),
  );

  for (const file of queue) {
    const target = formatSessionToken({
      harness: file.harness,
      harnessSessionId: file.harnessSessionId,
    });
    if (leaveAlone.has(target)) {
      tally.skipped += 1;
      continue;
    }
    if (clock.now().getTime() >= deadline) {
      return report(tally, '시간 예산이 끝나 남은 트랜스크립트는 다음 처리로 넘깁니다');
    }
    const now = clock.now();
    const added = await store.addWork({
      id: idGen.next(),
      kind: SESSION_INGEST_KIND,
      targetKind: 'session',
      targetId: target,
      createdAt: now,
      nextAttemptAt: now,
    });
    if (!added.ok) {
      return report(tally, stopped ?? `일감을 넣을 수 없습니다: ${added.message}`);
    }
    // `created: false` is an item somebody added between the read above and
    // here, which is not a failure and not this scan's work either (AD-21).
    if (added.created) tally.enqueued += 1;
    else tally.skipped += 1;
    // One session is one item, however many drains noticed the same file.
    leaveAlone.add(target);
  }

  return report(tally, stopped);
}

function report(
  tally: { changed: number; enqueued: number; skipped: number },
  stopped: string | undefined,
): ScanTranscriptsReport {
  return stopped === undefined ? { ...tally } : { ...tally, stopped };
}
