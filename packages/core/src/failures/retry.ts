import { FAILURE_RETRY_KINDS, FAILURE_RETRY_STAGES } from '../capture/session-ingest-work.js';
import { DOCUMENT_EXTRACT_KIND } from '../files/extract-work.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ExtractionStore, WorkStore } from '../ports/store.js';

/**
 * `failures.retry`: ask for one more go at everything that is still failing
 * (FR-5, NFR-2).
 *
 * It writes to the queue and not to `failures`, and that is the whole of its
 * design. `failures` is a record: a row says what went wrong and whether
 * anybody has fixed it, and the thing that marks it fixed is the work actually
 * going through (`resolveFailures`). So this verb puts one item on the queue per
 * target and answers at once — the opportunistic drain at the end of the command
 * is what then does the work (AD-7), and the row resolves itself when it
 * succeeds.
 *
 * Which kind of work a target gets is the table in
 * `capture/session-ingest-work.ts`. A target kind that is not in it is counted
 * and reported rather than guessed at: an item of a kind no handler claims would
 * sit in the backlog for ever.
 */

export interface FailuresRetryInput {
  /** Only the failures about this kind of target. Left out, all of them. */
  targetKind?: string;
}

/** One kind of target nothing could be asked to do, and how many there were. */
export interface FailuresRetrySkipped {
  targetKind: string;
  count: number;
}

export interface FailuresRetryData {
  /** New queue rows this call created. */
  added: number;
  /** Targets that already had an open item, so nothing was added (AD-21). */
  alreadyOpen: number;
  /** Targets this build has no kind of retry work for, by kind. */
  skipped: readonly FailuresRetrySkipped[];
  /**
   * Files whose reading failed and which have been redacted since, so there are
   * no bytes to read again (AD-11).
   *
   * These two are counted here rather than queued because the handler would
   * close such an item without doing anything, and the failure row would stay
   * exactly as it was — a retry that looked like it worked and changed nothing.
   * Saying how many is the honest answer (AD-24).
   */
  redacted: number;
  /** The same, for files whose original cannot be reached any more. */
  sourceUnreachable: number;
}

export type FailuresRetryResult =
  | ({ ok: true } & FailuresRetryData)
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

export interface FailuresRetryDependencies {
  store: Pick<WorkStore, 'listFailures' | 'addWork'> &
    /**
     * One lock-free read per failing file, to tell a retry worth asking for
     * from one that cannot go anywhere (`redacted`, `sourceUnreachable`).
     */
    Pick<ExtractionStore, 'readFileExtractionState'>;
  clock: Clock;
  /** Mints the id of each new queue row (AD-8). */
  idGen: IdGen;
}

/**
 * Queue one piece of work per target that is still failing.
 *
 * One item per kind and target, so separate ingest and identity failures
 * each get their own work, and the open-row key of AD-21 would have
 * collapsed the duplicates anyway — at the cost of a write lock per duplicate.
 *
 * `created: false` is counted apart from `added` because the two mean different
 * things to whoever ran the command: a target that already had an open item is
 * work that was going to happen, and a target that got a new row is work this
 * command asked for.
 *
 * A failing file is asked about first. A redacted file and a file whose original
 * is out of reach get no item and are counted instead: the handler would close
 * such an item without doing anything and the failure row would stay exactly as
 * it was, so queueing it is a retry that looks like it worked and changes
 * nothing (AD-24, `files/extract-work.ts`).
 */
export async function retryFailures(
  dependencies: FailuresRetryDependencies,
  input: FailuresRetryInput = {},
): Promise<FailuresRetryResult> {
  const { store, clock, idGen } = dependencies;

  const read = await store.listFailures({
    ...(input.targetKind === undefined ? {} : { targetKind: input.targetKind }),
    includeResolved: false,
  });
  if (!read.ok) return read;

  let added = 0;
  let alreadyOpen = 0;
  let redacted = 0;
  let sourceUnreachable = 0;
  const skipped = new Map<string, number>();
  const seen = new Set<string>();

  for (const failure of read.failures) {
    const kind = Object.hasOwn(FAILURE_RETRY_STAGES, failure.stage)
      ? FAILURE_RETRY_STAGES[failure.stage]
      : Object.hasOwn(FAILURE_RETRY_KINDS, failure.targetKind)
        ? FAILURE_RETRY_KINDS[failure.targetKind]
        : undefined;
    const target = `${kind ?? ''}\n${failure.targetKind}\n${failure.targetId}`;
    if (seen.has(target)) continue;
    seen.add(target);

    if (kind === undefined) {
      skipped.set(failure.targetKind, (skipped.get(failure.targetKind) ?? 0) + 1);
      continue;
    }

    if (kind === DOCUMENT_EXTRACT_KIND && failure.targetKind === 'file') {
      // A read and not a write, so a target that is going nowhere costs this
      // command no lock at all (AD-7). A file that is not there any more is
      // queued exactly as before: the handler closes that item as done, which
      // is how work about something that no longer exists ends
      // (`files/extract-work.ts`). Only a database that could not answer stops
      // the command, under its own code.
      const state = await store.readFileExtractionState(failure.targetId);
      if (!state.ok) {
        if (state.code === 'DB_UNAVAILABLE') {
          return { ok: false, code: state.code, message: state.message };
        }
      } else if (state.redactedAt !== null) {
        redacted += 1;
        continue;
      } else if (state.sourceUnreachableAt !== null) {
        sourceUnreachable += 1;
        continue;
      }
    }

    const now = clock.now();
    const queued = await store.addWork({
      id: idGen.next(),
      kind,
      targetKind: failure.targetKind,
      targetId: failure.targetId,
      createdAt: now,
      // Due at once: a person asking for a retry is asking for it now, and the
      // drain at the end of this command is what picks it up (AD-7).
      nextAttemptAt: now,
    });
    if (!queued.ok) return queued;
    if (queued.created) added += 1;
    else alreadyOpen += 1;
  }

  return {
    ok: true,
    added,
    alreadyOpen,
    skipped: [...skipped.entries()].map(([targetKind, count]) => ({ targetKind, count })),
    redacted,
    sourceUnreachable,
  };
}
