import { parseSessionToken } from '../domain/session-token.js';
import { DOCUMENT_EXTRACT_KIND } from '../files/extract-work.js';
import type { Clock } from '../ports/clock.js';
import type { SessionStore, WorkStore } from '../ports/store.js';
import type { WorkHandler, WorkHandlerResult } from '../queue/drain.js';
import type {
  IngestSessionInput,
  IngestSessionOptions,
  IngestSessionResult,
} from '../sessions/ingest.js';

/**
 * The first kind of work this project has: collect one session again (AD-21).
 *
 * It is owned by Core and not by the runtime, which is why it lives here and is
 * merged into `createBrain`'s own handlers: the thing it does is a use case
 * (`sessions.ingest`), and the ports it needs are the ones the brain was
 * assembled from. A runtime that had to register it would be a runtime that
 * could forget to.
 *
 * Who creates these items: the folder scan (`capture/scan.ts`), the spool
 * replay of an "ingest this session again" mark (AD-9), and `brain failures
 * retry`. All three name the same target — `session` and the session token —
 * so the open-row key of AD-21 keeps them to one item however many of them
 * noticed.
 */

/** The kind, as `work_items.kind` spells it. */
export const SESSION_INGEST_KIND = 'session_ingest';

/** Known stages take precedence; the target table supports older failure rows. */
export const FAILURE_RETRY_STAGES: Readonly<Record<string, string>> = {
  session_ingest: SESSION_INGEST_KIND,
  session_identity: 'session_identity',
  document_extract: DOCUMENT_EXTRACT_KIND,
};
export const FAILURE_RETRY_KINDS: Readonly<Record<string, string>> = {
  session: SESSION_INGEST_KIND,
  file: DOCUMENT_EXTRACT_KIND,
};

export interface SessionIngestWorkDependencies {
  /**
   * The ingest, already bound to its ports. A function and not the use case
   * itself, so this file needs none of the ingest's dependencies and the brain
   * that assembled them passes exactly the one it built.
   */
  ingest(
    input: IngestSessionInput,
    options: IngestSessionOptions,
  ): Promise<IngestSessionResult>;
  /**
   * Closing the failures of a session that finally went through, and reading
   * the session row for the information columns of a failure that did not.
   */
  store: Pick<WorkStore, 'resolveFailures'> & Pick<SessionStore, 'findSession'>;
  clock: Clock;
}

/**
 * The handler for one `session_ingest` item.
 *
 * Three things it decides, and nothing else — the drain decides the rest
 * (`queue/drain.ts`):
 *
 *   * the ingest is an `import` and is told not to spool. This path *is* the
 *     deferred one, so a mark in the spool would be a second copy of work the
 *     queue is already holding; handing the code back instead gets the item
 *     released with its attempt given back (AD-21).
 *   * a transcript that cannot be read or found, and a database with no owner,
 *     are permanent. Neither is fixed by waiting: the harness has deleted the
 *     file, or the install step that records the owner has not run. So they are
 *     recorded on the first failure rather than retried ten times (AD-21).
 *   * success closes whatever failures that session had. `resolveFailures` is
 *     what makes `failures retry` finish: the row the retry was asked about
 *     becomes resolved, and `brain failures list` is empty again.
 */
export function sessionIngestHandler(
  dependencies: SessionIngestWorkDependencies,
): WorkHandler {
  const { ingest, store, clock } = dependencies;

  return async (item) => {
    const session = item.targetId;
    const result = await ingest(
      { session, source: 'import' },
      { spoolOnUnwritable: false },
    );

    if (result.ok) {
      // Whatever this session's failures were, they are over. Its own failure
      // is dropped: the collection worked, and refusing to say so because a
      // bookkeeping row could not be closed would turn a success into a retry
      // of work that is already done. The next drain closes it.
      await store.resolveFailures({
        targetKind: item.targetKind,
        targetId: session,
        stage: SESSION_INGEST_KIND,
        now: clock.now(),
      });
      return { ok: true };
    }

    const failure: WorkHandlerResult = {
      ok: false,
      code: result.code,
      message: result.message,
      ...(PERMANENT_CODES.has(result.code) ? { retryable: false } : {}),
      ...(await about(store, session)),
    };
    return failure;
  };
}

/**
 * The codes a session collection never gets a second attempt at.
 *
 * `TRANSCRIPT_UNREADABLE` covers a file the harness deleted, one this user may
 * not read, and content that is not a transcript — none of which another
 * attempt changes. `USER_MISSING` is an install step that has not run, which a
 * drain cannot run for it (AD-12).
 *
 * `USAGE` is deliberately not here: the only way a handler meets it is a token
 * for a harness this build has no parser for, which the *next* build may well
 * have, so it backs off like anything else nobody classified.
 */
const PERMANENT_CODES = new Set<string>(['TRANSCRIPT_UNREADABLE', 'USER_MISSING']);

/**
 * The two information columns of a failure row about a session (Table
 * Contract): the harness, which the token always carries, and the session id,
 * which exists only once something has created the row.
 *
 * Both are left out rather than guessed when the read says nothing. A read that
 * failed is not worth reporting from here — the failure being recorded is the
 * interesting one, and a database that cannot answer this read will refuse the
 * record as well.
 */
export async function about(
  store: Pick<SessionStore, 'findSession'>,
  session: string,
): Promise<{ harness?: string; sessionId?: string }> {
  const token = parseSessionToken(session);
  if (!token.ok) return {};

  const found = await store.findSession(token.key);
  const sessionId = found.ok && found.session !== null ? found.session.id : undefined;
  return sessionId === undefined
    ? { harness: token.key.harness }
    : { harness: token.key.harness, sessionId };
}
