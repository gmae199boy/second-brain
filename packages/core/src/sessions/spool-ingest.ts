import type { IngestAttachment } from '../domain/ingest-batch.js';
import { encodeSpoolLine } from '../domain/spool-record.js';
import { ERROR_CODES, isWarningCode, type WarningCode } from '../codes.js';
import {
  SPOOL_RECORD_VERSION,
  type SpoolCause,
  type SpoolRecord,
} from '../domain/spool-record.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Spool } from '../ports/spool.js';
import type { IngestSessionInput, IngestSessionResult } from './ingest.js';

/**
 * "Ingest this session again" as one line in the spool (AD-9).
 *
 * This is the whole of what happens when the database cannot take a turn's
 * conversation: a mark naming the session and the transcript, and a success
 * carrying `SPOOLED`. Not the conversation itself — the transcript is a file
 * the harness keeps, so the replay reads it again and gets everything that has
 * been added since, where a copy in the spool would be stale the moment it was
 * written (story 12).
 *
 * It takes no store, and that is the point of it being its own function: both
 * callers are paths where writing to the database is exactly what must not
 * happen. The ingest use case comes here when a store step answered
 * `DB_UNAVAILABLE` or `DB_LOCKED`, and the CLI's `spool` branch comes here when
 * the write guard found the schema version wrong — in which case the command's
 * `run` is never called at all, and a mismatched database is unreachable by
 * construction rather than by care (AD-20).
 *
 * The answer is an ingest result, because the caller's caller — a hook — must
 * not learn that anything unusual happened beyond the warning code: a turn
 * whose conversation went to the spool is a turn that worked (NFR-3).
 */

export interface SpoolSessionIngestDependencies {
  spool: Spool;
  /** The one clock. The record's instant is read from it once (AD-13). */
  clock: Clock;
  /** The record's id. UUIDv7, minted here and never changed again (AD-8). */
  idGen: IdGen;
}

/**
 * What the transcript read had already found by the time the write was refused,
 * for a mark written *after* the parse (`sessions/ingest.ts`).
 *
 * A lock is discovered in the middle of the use case, and by then the file has
 * been read: what the parse walked past is a fact about the transcript and not
 * about where the write went, so it is reported either way, and a line it could
 * not read at all still has to raise its warning. Left out for the one spool
 * that happens before any parse, where there is nothing to report.
 */
export interface SpoolSessionIngestRead {
  /** How many lines the parse walked past, by reason (`ports/parser.ts`). */
  droppedLines: Readonly<Record<string, number>>;
  /** The warnings that read raised, which go behind the spool's own. */
  warnings: readonly WarningCode[];
  attachments?: readonly IngestAttachment[];
}

/**
 * Write the mark and answer as a degraded success, or — when even the spool
 * could not take it — as the failure of whatever sent us here.
 *
 * `warnings` always carries `SPOOLED`, and the cause too when the cause is one
 * of the shared warning codes: "the write is in the spool" and "the database
 * was unreachable" are two different facts and a reader needs both (NFR-2).
 * `DB_LOCKED` is not a warning code, so a lock leaves `SPOOLED` alone. A read
 * that had already happened adds its own warnings behind those, without
 * repeating one (`SpoolSessionIngestRead`).
 */
export async function spoolSessionIngest(
  dependencies: SpoolSessionIngestDependencies,
  input: IngestSessionInput,
  cause: SpoolCause,
  read: SpoolSessionIngestRead | null = null,
): Promise<IngestSessionResult> {
  const { spool, clock, idGen } = dependencies;

  const record: SpoolRecord = {
    schemaVersion: SPOOL_RECORD_VERSION,
    id: idGen.next(),
    kind: 'session_ingest',
    occurredAt: clock.now(),
    payload: {
      session: input.session,
      // The empty string is a path nobody gave: the replay then looks the file
      // up by session id, the same way this ingest would have (story 12).
      transcriptPath: input.transcriptPath ?? '',
      cause,
    },
  };

  const records: SpoolRecord[] = [record];
  for (const a of read?.attachments ?? []) {
    const link: SpoolRecord = { schemaVersion: SPOOL_RECORD_VERSION, id: idGen.next(), kind: 'attachment_link', occurredAt: record.occurredAt,
      payload: { session: input.session, harnessMessageId: a.harnessMessageId, ordinal: a.ordinal, sourceKind: a.sourceKind, sourceRef: a.sourceRef, displayName: a.displayName,
        contentHash: a.file.contentHash, sizeBytes: a.file.sizeBytes, storeKind: a.file.location.storeKind, locator: a.file.location.locator, ownership: a.file.location.ownership } };
    if (encodeSpoolLine(link).ok) records.push(link);
  }
  const appended = await spool.append(records);
  if (!appended.ok) {
    // Both halves, in that order: what stopped the write, and that the fallback
    // did not work either. The code stays the cause's, because that is what a
    // caller deciding what to do next has to act on — the spool failing is the
    // reason there is nothing else to say, not a different problem.
    return {
      ok: false,
      code: cause,
      message: `${ERROR_CODES[cause].meaning}. spool에도 쓸 수 없었습니다: ${appended.message}`,
    };
  }

  return {
    ok: true,
    session: input.session,
    spooled: true,
    // Nothing was created and nothing was inserted: the numbers say what
    // reached the database, and `spooled` says where the write went instead.
    created: false,
    inserted: { messages: 0, toolNotes: 0 },
    // What the parse found, when there was one. `null` is "this read never
    // happened" — the spool that beat the parse to it — where an empty record
    // would read as "the whole file was conversation" (`sessions/ingest.ts`).
    droppedLines: read?.droppedLines ?? null,
    warnings: warningsOf(cause, read),
  };
}

/**
 * The spool's own warnings first, then the read's, and neither twice: where the
 * write went is this function's news, and what the file looked like is the
 * read's (NFR-2).
 */
function warningsOf(
  cause: SpoolCause,
  read: SpoolSessionIngestRead | null,
): readonly WarningCode[] {
  const spooled = warningsFor(cause);
  if (read === null) return spooled;
  const already = new Set<string>(spooled);
  return [...spooled, ...read.warnings.filter((code) => !already.has(code))];
}

function warningsFor(cause: SpoolCause): readonly WarningCode[] {
  return isWarningCode(cause) ? ['SPOOLED', cause] : ['SPOOLED'];
}
