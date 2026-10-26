import type { AttachmentLinkSpoolPayload } from './domain/spool-record.js';
import type { IngestAttachment } from './domain/ingest-batch.js';
import type { SourceFileReader } from './ports/source-file.js';
import { fillFileNames } from './files/file-names.js';
import { BLOB_DELETE_KIND, blobDeleteHandler } from './files/blob-delete-work.js';
import {
  DOCUMENT_EXTRACT_KIND,
  documentExtractHandler,
  enqueueDocumentExtractions,
} from './files/extract-work.js';
import type { FileStore } from './ports/file-store.js';
import { formatSessionToken, parseSessionToken } from './domain/session-token.js';
import { redactFile, type FilesRedactInput, type FilesRedactResult } from './files/redact.js';
import { redactMessage, type MessagesRedactInput, type MessagesRedactResult } from './messages/redact.js';
import { SESSION_IDENTITY_KIND, sessionIdentityHandler } from './capture/session-identity-work.js';
import {
  SESSION_INGEST_KIND,
  sessionIngestHandler,
} from './capture/session-ingest-work.js';
import { scanTranscripts } from './capture/scan.js';
import {
  runDoctor,
  type DoctorCheckSource,
  type DoctorReport,
} from './doctor/doctor.js';
import {
  listFailures,
  type FailuresListInput,
  type FailuresListResult,
} from './failures/list.js';
import {
  retryFailures,
  type FailuresRetryInput,
  type FailuresRetryResult,
} from './failures/retry.js';
import type { Clock } from './ports/clock.js';
import type { IdGen } from './ports/id-gen.js';
import type { Parser } from './ports/parser.js';
import type { RepositoryInspector } from './ports/repository.js';
import type { Spool } from './ports/spool.js';
import type { SchemaStore, Store } from './ports/store.js';
import type { TranscriptFolder, TranscriptReader } from './ports/transcript.js';
import {
  drainQueue,
  type DrainQueueReport,
  type WorkHandlers,
} from './queue/drain.js';
import {
  ingestSession,
  type IngestSessionInput,
  type IngestSessionResult,
} from './sessions/ingest.js';
import { replaySpool, type SpoolReplayHandlers } from './spool/replay.js';

export interface BrainDependencies {
  sources?: SourceFileReader;
  userHome?: string | null;
  /**
   * The persistence port, plus the schema-version capability `doctor.run`
   * asks for. It is the whole `Store` now that a verb writes conversation
   * data: an adapter that offers only health and the schema version can still
   * answer `doctor.run`, but it cannot ingest, and the type is where that is
   * decided rather than at the call (AD-10).
   */
  store: Store & SchemaStore;
  /** Original attachment bytes, written before the database transaction. */
  files: FileStore;
  /**
   * Where a write goes when the database will not take it (AD-9). Every verb
   * that writes conversation data needs it, because a lock that is held too
   * long is not a failure of the verb — it is a write that has to wait, and
   * the spool is where it waits.
   */
  spool: Spool;
  /**
   * Schema version this build was made for. The caller passes the constant of
   * the adapter it built, because which schema is current is the adapter's
   * fact, not Core's.
   */
  schemaVersion: number;
  /** The one clock. Every stored instant is read from it once (AD-13). */
  clock: Clock;
  /** Record ids. UUIDv7, minted by this side, never by the database (AD-8). */
  idGen: IdGen;
  /** Every harness this build can read a transcript of (AD-4). */
  parsers: readonly Parser[];
  /** Reading a transcript file. Core has no filesystem of its own (AD-1). */
  transcripts: TranscriptReader;
  /**
   * The transcript folders this build may look in, by harness (AD-4).
   *
   * Three things depend on it and all three are off without it: the drain's
   * folder scan, finding a transcript from a session token alone, and doctor's
   * `transcripts` check. That is deliberate — the runtime decides whether this
   * brain reads the harness's folders at all, and an empty list is a complete,
   * working brain that collects only what a hook reports (Boundaries).
   */
  transcriptFolders?: readonly TranscriptFolder[];
  /**
   * Asking git what a working folder is, for the project and worktree tags of
   * a session (AD-12). Core has no git of its own (AD-1).
   */
  repositories: RepositoryInspector;
  /** The machine sessions ingested here ran on, recorded per session (AD-12). */
  machine: string;
  /**
   * Checks the runtime registers on top of the store's own — the shim, the node
   * behind it, the configuration file. Core has no filesystem, so these come
   * from whoever does.
   */
  checks?: readonly DoctorCheckSource[];
  /**
   * What this build's drain can do beyond the kinds Core owns itself (AD-21).
   *
   * It is a dependency and not a constant because a handler needs the ports the
   * caller assembled — a file store, an embedder — and because the kinds a build
   * can do are a fact about the build, not about Core. Core's own kinds are
   * merged under these, so a caller can neither lose them by forgetting nor
   * silently replace one.
   */
  workHandlers?: WorkHandlers;
}

export interface BrainDoctor {
  /** Check whether this brain is reachable and healthy, and report. */
  run(): Promise<DoctorReport>;
}

export interface BrainSessions {
  /** Read a harness transcript and append what is new (AD-4, AD-14). */
  ingest(input: IngestSessionInput): Promise<IngestSessionResult>;
}

export interface BrainFailures {
  /** What is still wrong, and — asked for — what was (FR-5). */
  list(input?: FailuresListInput): Promise<FailuresListResult>;
  /** Ask for one more go at everything that is still failing (FR-5). */
  retry(input?: FailuresRetryInput): Promise<FailuresRetryResult>;
}

/** What one call to `queue.drain` is given (AD-7, AD-21). */
export interface BrainQueueDrainInput {
  /** How long this run may keep claiming, in milliseconds (`DRAIN_BUDGET_MS`). */
  budgetMs: number;
  /**
   * Handlers for this call only, merged over the ones the brain was built with.
   * The seam exists for a test and for a caller that knows about a kind the
   * assembly did not — never to replace the build's own set silently.
   */
  handlers?: WorkHandlers;
}

/**
 * What one drain run did: the queue loop's own report, plus what the two steps
 * before it did (Design Notes).
 *
 * They are three numbers on one report and not three reports because one drain
 * is one answer to "was there anything to do": a person reading
 * `brain queue drain` wants the spool, the folders and the queue in one line.
 */
export interface BrainDrainReport extends DrainQueueReport {
  /** Spool records the replay put back into the database (AD-9). */
  replayed: number;
  /** Spool lines moved aside because nobody will try them again (AD-9). */
  spoolFailed: number;
  /** `session_ingest` items the folder scan put on the queue (AD-4). */
  enqueued: number;
  /**
   * Sessions an older parser version read whose transcript is no longer on the
   * disk, so the scan could not queue them to be read again (`capture/scan.ts`).
   */
  rereadMissing: number;
  /**
   * Files a newer extractor would read differently that are redacted, so there
   * are no bytes left to read: counted rather than queued (`files/extract-work.ts`).
   */
  reextractRedacted: number;
  /**
   * The same, for files whose original cannot be reached any more. A drain that
   * said nothing about these would leave a person with an attachment that is
   * quietly never re-read, so the command turns this one into a warning (AD-24).
   */
  reextractUnreachable: number;
}

export interface BrainQueue {
  /** Work the backlog within a time budget, and report what happened (AD-21). */
  drain(input: BrainQueueDrainInput): Promise<BrainDrainReport>;
}

export interface BrainMessages {
  redact(input: MessagesRedactInput): Promise<MessagesRedactResult>;
}

export interface BrainFiles {
  /**
   * Take one stored file's content out of the brain: Brain's copy of the bytes,
   * the text read out of it, the searchable name index and the metadata read
   * off the bytes (AD-11, AD-23). The attachment's own record of the name it
   * was carried under, and the `external` location of the user's original, stay
   * as provenance — `message_attachments` is immutable (0008).
   *
   * It is by content, so it removes the file from every message that shares it,
   * and it is gated: the call without consent reads how many messages that is
   * and says so (`files/redact.ts`).
   */
  redact(input: FilesRedactInput): Promise<FilesRedactResult>;
}

export interface Brain {
  messages: BrainMessages;
  files: BrainFiles;
  doctor: BrainDoctor;
  sessions: BrainSessions;
  failures: BrainFailures;
  queue: BrainQueue;
  close(): Promise<void>;
}

/**
 * Assemble the SDK surface from its ports. Calling this does no I/O; every
 * connection is made by the adapter factory the caller already built (AD-3).
 */
export function createBrain(dependencies: BrainDependencies): Brain {
  const {
    store,
    files,
    sources,
    userHome,
    spool,
    schemaVersion,
    clock,
    idGen,
    parsers,
    transcripts,
    transcriptFolders = [],
    repositories,
    machine,
    checks,
    workHandlers,
  } = dependencies;

  const ingestDependencies = {
    store,
    files,
    ...(sources === undefined ? {} : { sources }),
    ...(userHome === undefined ? {} : { userHome }),
    spool,
    clock,
    idGen,
    parsers,
    transcripts,
    transcriptFolders,
    repositories,
    machine,
  };

  // The kinds Core owns, and then the caller's. `session_ingest` is Core's own
  // because what it does is a use case and the ports it needs are the ones this
  // brain was assembled from (`capture/session-ingest-work.ts`).
  const coreHandlers: WorkHandlers = {
    [SESSION_IDENTITY_KIND]: sessionIdentityHandler(ingestDependencies),
    [SESSION_INGEST_KIND]: sessionIngestHandler({
      ingest: (input, options) => ingestSession(ingestDependencies, input, options),
      store,
      clock,
    }),
    // Core's own for the same reason: reading a stored attachment is a use case,
    // and the ports it needs — the store, the file store, the clock, the ids —
    // are exactly the ones this brain was assembled from (`files/extract-work.ts`).
    [DOCUMENT_EXTRACT_KIND]: documentExtractHandler({ store, files, clock, idGen }),
    // And the same again for deleting one of them: the ports it needs are the
    // store, the file store and the clock, and what it does — empty one place
    // and record that it is empty — is a use case (`files/blob-delete-work.ts`).
    [BLOB_DELETE_KIND]: blobDeleteHandler({ store, files, clock }),
  };
  const handlers: WorkHandlers = { ...coreHandlers, ...workHandlers };

  /**
   * What each kind of spool record means, by the unit that wrote it (AD-9).
   *
   * Both of them are writes that already failed once, so neither may go back to
   * the spool: the ingest is told not to, and the failure record is written
   * straight through. A refusal comes back as the database's own code, which is
   * what makes the replay put the file back and stop (`spool/replay.ts`).
   */
  const attachmentFromSpool = (p: AttachmentLinkSpoolPayload): IngestAttachment => ({
    id: idGen.next(), harnessMessageId: p.harnessMessageId, ordinal: p.ordinal,
    sourceKind: p.sourceKind, sourceRef: p.sourceRef, displayName: p.displayName,
    file: p.status === 'missing_at_ingest' ? null : {
      id: idGen.next(), contentHash: p.contentHash, sizeBytes: p.sizeBytes,
      location: { id: idGen.next(), storeKind: p.storeKind, locator: p.locator, ownership: p.ownership },
      external: p.externalLocator === null ? null : { id: idGen.next(), storeKind: 'local', ownership: 'external', locator: p.externalLocator },
    },
  });
  const spoolHandlers: SpoolReplayHandlers = {
    session_ingest: async (record, context) => {
      if (record.kind !== 'session_ingest') return { ok: true };
      const result = await ingestSession(
        ingestDependencies,
        {
          session: record.payload.session,
          // Whatever the process that spooled it knew. Empty means it knew no
          // path, and the ingest looks the file up by session id instead.
          transcriptPath: record.payload.transcriptPath,
          // A mark written by a hook is about a session happening now, which is
          // what `live` means: the row it may create is not an import (Table
          // Contract).
          source: 'live',
        },
        { spoolOnUnwritable: false, attachmentOverrides: context.records.flatMap(link =>
          link.kind === 'attachment_link' && link.payload.session === record.payload.session
            ? [attachmentFromSpool(link.payload)] : []) },
      );
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      // The session went in, so whatever was recorded about collecting it is
      // over (`resolveFailures`). Its own failure is dropped: the write
      // succeeded, and the next drain closes the row.
      await store.resolveFailures({
        targetKind: 'session',
        targetId: record.payload.session,
        stage: SESSION_INGEST_KIND,
        now: clock.now(),
      });
      return { ok: true };
    },
    attachment_link: async (record) => {
      if (record.kind !== 'attachment_link') return { ok: true };
      const p = record.payload;
      const token = parseSessionToken(p.session);
      if (!token.ok) return { ok: false, code: 'USAGE', message: token.message };
      return store.linkAttachments({ key: token.key, linkedAt: record.occurredAt, attachments: [attachmentFromSpool(p)] });
    },
    failure: async (record) => {
      if (record.kind !== 'failure') return { ok: true };
      // `workItemId` is deliberately dropped. It named the item this record was
      // going to close, and that claim expired long ago: closing it from here
      // would be a compare-and-set against a worker that no longer exists, and
      // a later drain meets the item again anyway (AD-21).
      const { workItemId: _item, ...failure } = record.payload;
      const written = await store.recordFailure({
        // The record's own id, so replaying the same line twice writes one row
        // (AD-8).
        id: record.id,
        ...failure,
      });
      if (!written.ok) return { ok: false, code: written.code, message: written.message };
      return { ok: true };
    },
  };

  return {
    messages: { redact: (input) => redactMessage({ store, clock, idGen }, input) },
    files: { redact: (input) => redactFile({ store, clock, idGen }, input) },
    doctor: {
      run: () =>
        runDoctor(store, {
          schemaVersion,
          store,
          clock,
          folders: transcriptFolders,
          checks,
        }),
    },
    sessions: {
      ingest: async (input) => {
        const result = await ingestSession(ingestDependencies, input);
        if (result.ok && !result.spooled) {
          try {
            const failures = await store.listFailures({ targetKind: 'session', stage: SESSION_INGEST_KIND });
            if (failures.ok && failures.failures.some((failure) => failure.targetId === input.session)) {
              await store.resolveFailures({ targetKind: 'session', targetId: input.session,
                stage: SESSION_INGEST_KIND, now: clock.now() });
            }
          } catch {
            // Dropped, as in the work handler: the collection worked, and a
            // bookkeeping row that could not be closed must not turn it into a
            // failed turn. The next success or `failures retry` closes it.
          }
        }
        return result;
      },
    },
    failures: {
      list: (input) => listFailures({ store }, input),
      retry: (input) => retryFailures({ store, clock, idGen }, input),
    },
    queue: {
      drain: (input) =>
        drain(
          { store, spool, clock, idGen, folders: transcriptFolders, parsers, spoolHandlers },
          {
            budgetMs: input.budgetMs,
            handlers: input.handlers === undefined ? handlers : { ...handlers, ...input.handlers },
          },
        ),
    },
    close: () => store.close(),
  };
}

/** What the three steps of one drain run share (Design Notes). */
interface DrainDependencies {
  store: Store;
  spool: Spool;
  clock: Clock;
  idGen: IdGen;
  folders: readonly TranscriptFolder[];
  parsers: readonly Parser[];
  spoolHandlers: SpoolReplayHandlers;
}

/**
 * One drain run: replay the spool, scan the folders, work the queue.
 *
 * The order is the whole of it. The replay comes first because its records are
 * writes that have already been waiting, and because what it finds out — that
 * the database still will not take a write — is what makes the other two steps
 * pointless: a scan that enqueued work and a loop that claimed it would both
 * fail, and each failure would cost an attempt. So an unwritable database ends
 * the run there, under the code that stopped it (AD-9, AD-21).
 *
 * The scan comes second because what it produces is queue rows, and the loop
 * that works them is third: a session a scan found is collected in the same run
 * rather than in the next one, which is what makes a single `brain queue drain`
 * on a fresh install collect everything on the disk (SM-5).
 *
 * All three share one deadline, read once. Three budgets would mean a command's
 * opportunistic two seconds could become six.
 */
async function drain(
  dependencies: DrainDependencies,
  input: { budgetMs: number; handlers: WorkHandlers },
): Promise<BrainDrainReport> {
  const { store, spool, clock, idGen, folders, parsers, spoolHandlers } = dependencies;
  const deadline = clock.now().getTime() + input.budgetMs;

  const replay = await replaySpool(
    { spool, handlers: spoolHandlers, store, clock, idGen },
    { deadline },
  );
  if (replay.unwritable !== undefined) {
    return {
      ...EMPTY_QUEUE_REPORT,
      stopped: 'unwritable',
      code: replay.unwritable,
      replayed: replay.replayed,
      spoolFailed: replay.failed,
      enqueued: 0,
      rereadMissing: 0,
      reextractRedacted: 0,
      reextractUnreachable: 0,
    };
  }

  const scan = await scanTranscripts({ store, folders, parsers, clock, idGen }, { deadline });

  const candidates = await store.listIdentityCandidates();
  if (candidates.ok) {
    for (const session of candidates.sessions) {
      if (clock.now().getTime() >= deadline) break;
      const now = clock.now();
      const added = await store.addWork({ id: idGen.next(), kind: SESSION_IDENTITY_KIND,
        targetKind: 'session', targetId: formatSessionToken(session),
        createdAt: now, nextAttemptAt: now });
      if (!added.ok) break;
    }
  }

  if (clock.now().getTime() < deadline) await fillFileNames({ store, idGen });

  // After the names and before the loop, which is where the files it finds come
  // from: nothing before the loop stores a file, so an attachment this run's
  // `session_ingest` collects is queued and read by the *next* drain. What this
  // step catches is every file already stored — the ones story 5 filled in
  // included (Design Notes). What it produces is queue rows, and the loop's own
  // counters say whether anything happened; the two numbers it does report are
  // the files it met and could not queue at all (`files/extract-work.ts`).
  let reextract = { redacted: 0, sourceUnreachable: 0 };
  if (clock.now().getTime() < deadline) {
    reextract = await enqueueDocumentExtractions({ store, clock, idGen }, { deadline });
  }

  const queue = await drainQueue(
    { store, spool, clock, idGen },
    {
      budgetMs: Math.max(0, deadline - clock.now().getTime()),
      handlers: input.handlers,
    },
  );

  return {
    ...queue,
    replayed: replay.replayed,
    spoolFailed: replay.failed,
    enqueued: scan.enqueued,
    rereadMissing: queue.stopped === 'unwritable' ? 0 : scan.rereadMissing,
    reextractRedacted: queue.stopped === 'unwritable' ? 0 : reextract.redacted,
    reextractUnreachable: queue.stopped === 'unwritable' ? 0 : reextract.sourceUnreachable,
  };
}

/** The queue loop's counters, all zero: a run that never got to it (AD-21). */
const EMPTY_QUEUE_REPORT = {
  claimed: 0,
  completed: 0,
  retried: 0,
  failed: 0,
  released: 0,
  lost: 0,
  spooled: 0,
} as const;
