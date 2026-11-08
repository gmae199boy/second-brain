import { SOURCE_SYNC_KIND, sourceSyncHandler, cleanupSourceTemps } from './sources/sync.js';
import type { SourceStore } from './ports/source-store.js';
import type { SourceRemote, SourceTemp } from './ports/source-remote.js';
import { withExtensionMetadata } from './recall/extension-metadata.js';
import { searchDocuments, showDocument, type DocumentSearchInput, type ShowDocumentInput } from './recall/documents.js';
import { executeExtensionCommand } from './extensions/commands.js';
import { FILE_IMPORT_KIND, importFileHandler } from './files/import-work.js';
import type { ImportStaging } from './ports/import-store.js';
import { maskOutputText } from './output/mask.js';
import type { ChannelPublicStatus, ChannelFailure, ChannelResendCode } from './channels/store.js';
import { searchRecall, type SearchInput } from './recall/search.js';
import { expandRecall, type ExpandInput } from './recall/expand.js';
import { readSessionPage, type ReadInput } from './sessions/read.js';
import { CONVERSATION_CHUNK_KIND, conversationChunkHandler } from './recall/conversation-work.js';
import { runExtension } from './extensions/run.js';
import { installExtension, type ExtensionRuntime } from './extensions/install.js';
import { extensionStatus, listExtensions, publicExtensionStatus, setExtensionEnabled } from './extensions/status.js';
import { holdWorkGroup, releaseWorkGroup } from './queue/hold-groups.js';
import { listWork } from './queue/list.js';
import { workExecutionClass } from './domain/work-item.js';
import type { SchemaVersions } from './schema.js';
import { getSetting, setSetting, settingDefinitions } from './settings/index.js';
import { addSchedule, updateSchedule, listSchedules, removeSchedule, runSchedule, type CreateScheduleInput, type AddDailyResult, type RunScheduleResult } from './queue/schedules.js';
import { tickSchedules, type ScheduleTickResult } from './queue/schedule-tick.js';
import { SCHEDULE_PROBE_KIND, scheduleProbeHandler } from './queue/schedule-probe-work.js';
import type { AttachmentLinkSpoolPayload } from './domain/spool-record.js';
import type { IngestAttachment } from './domain/ingest-batch.js';
import type { SourceFileReader } from './ports/source-file.js';
import { fillFileNames } from './files/file-names.js';
import { DRIVE_LOCAL_DELETE_KIND, DRIVE_MIGRATE_KIND, driveLocalDeleteHandler, driveMigrationHandler } from './files/drive-migrate-work.js';
import { contentHashOfBytes } from './domain/file.js';
import type { DriveMigrationStore, DriveUploadStore } from './ports/drive-store.js';
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
import type { SchemaStore, Store, SettingsStore } from './ports/store.js';
import type { TranscriptFolder, TranscriptReader } from './ports/transcript.js';
import {
  drainQueue,
  type DrainQueueReport,
  type WorkHandlers,
} from './queue/drain.js';
import {
  ingestSession,
  type IngestSessionDependencies,
  type IngestSessionInput,
  type IngestSessionResult,
} from './sessions/ingest.js';
import { replaySpool, type SpoolReplayHandlers } from './spool/replay.js';

export interface BrainDependencies {
  cron?: import('./ports/cron.js').CronCalculator;
  importStaging?: ImportStaging;
  extensions?: ExtensionRuntime;
  sources?: SourceFileReader;
  /** External source runtime, separate from local attachment readers and Drive home. */
  sourceSync?: {store:SourceStore;remote:SourceRemote;temp:SourceTemp};
  userHome?: string | null;
  /**
   * The persistence port, plus the schema-version capability `doctor.run`
   * asks for. It is the whole `Store` now that a verb writes conversation
   * data: an adapter that offers only health and the schema version can still
   * answer `doctor.run`, but it cannot ingest, and the type is where that is
   * decided rather than at the call (AD-10).
   */
  store: Store & SchemaStore & SettingsStore;
  /** Explicitly injected Drive connection; credentials and OAuth are runtime concerns. */
  drive?: { store:DriveMigrationStore; uploads:DriveUploadStore; files:FileStore; rootFolderId:string };
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
  schemaVersions: SchemaVersions;
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
  prerequisites?: readonly DoctorCheckSource[];
  /** Adapter probe IDs supplied by the assembly for failed prerequisites. */
  adapterProbeIds?: readonly string[];
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
  read(input: ReadInput): ReturnType<typeof readSessionPage>;
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
  /** Why the transcript scan stopped short, when the queue remained writable. */
  scanStopped?: string;
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

export type BrainQueueCancelResult = { ok: true; id: string; state: 'cancelled' | 'requested' | 'already_closed' } | { ok: false; code: 'WORK_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export interface BrainQueue {
  hold(input: { group: string }): ReturnType<typeof holdWorkGroup>;
  release(input: { group: string }): ReturnType<typeof releaseWorkGroup>;
  list(input?: Parameters<typeof listWork>[1]): ReturnType<typeof listWork>;
  cancel(input: { id: string }): Promise<BrainQueueCancelResult>;
  /** Work the backlog within a time budget, and report what happened (AD-21). */
  drain(input: BrainQueueDrainInput): Promise<BrainDrainReport>;
}

export interface BrainMessages {
  redact(input: MessagesRedactInput): Promise<MessagesRedactResult>;
}

export interface BrainFiles {
  show(input: ShowDocumentInput): ReturnType<typeof showDocument>;
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

export interface BrainSchedules {
  tick(): Promise<ScheduleTickResult>;
  add(input: CreateScheduleInput): Promise<AddDailyResult>;
  update(input: Parameters<typeof updateSchedule>[1]): ReturnType<typeof updateSchedule>;
  list(input?: { limit?: number }): ReturnType<typeof listSchedules>;
  remove(input: { id: string }): ReturnType<typeof removeSchedule>;
  run(input: { scheduleId: string }): Promise<RunScheduleResult>;
}
export interface BrainExt {
  command(input: { name: string; command: string; input: unknown; signal?: AbortSignal }): Promise<Awaited<ReturnType<typeof executeExtensionCommand>> & { meta?: import('./envelope.js').EnvelopeMeta } | { ok: false; code: string; message: string; meta?: import('./envelope.js').EnvelopeMeta }>;
  run(input: { name: string; job: string; target?: string; waitMs?: number }): ReturnType<typeof runExtension>;
  install(input: { name?: string; packagePath?: string; signal?: AbortSignal }): ReturnType<typeof installExtension>;
  status(input: { name: string }): ReturnType<typeof publicExtensionStatus>;
  list(): ReturnType<typeof listExtensions>;
  publicStatus(input: { name: string }): ReturnType<typeof publicExtensionStatus>;
  enable(input: { name: string }): ReturnType<typeof setExtensionEnabled>;
  disable(input: { name: string }): ReturnType<typeof setExtensionEnabled>;
}
type ChannelSdkError = ChannelFailure | { ok: false; code: ChannelResendCode | 'INVALID_ARGUMENT'; message: string };
export interface BrainChannels {
  list(): Promise<{ ok: true; requests: ChannelPublicStatus[] } | ChannelFailure>;
  status(input: { id: string }): Promise<{ ok: true; request: ChannelPublicStatus } | ChannelSdkError>;
  resend(input: { id: string }): Promise<{ ok: true; workItemId: string } | ChannelSdkError>;
}
export interface Brain {
  channels: BrainChannels;
  sources: {sync(input:{sourceId:string}):Promise<{ok:true;sourceId:string;workId:string;created:boolean}|{ok:false;code:string;message:string}>};
  recall: { docs(input: DocumentSearchInput): Promise<Awaited<ReturnType<typeof searchDocuments>> | { ok: false; code: string; message: string; meta?: import('./envelope.js').EnvelopeMeta }>; chunks(input: SearchInput): Promise<Awaited<ReturnType<typeof searchRecall>> | { ok: false; code: string; message: string; meta?: import('./envelope.js').EnvelopeMeta }>; tools(input: SearchInput): Promise<Awaited<ReturnType<typeof searchRecall>> | { ok: false; code: string; message: string; meta?: import('./envelope.js').EnvelopeMeta }>; expand(input: ExpandInput): ReturnType<typeof expandRecall> };
  ext: BrainExt;
  messages: BrainMessages;
  files: BrainFiles;
  doctor: BrainDoctor;
  sessions: BrainSessions;
  failures: BrainFailures;
  queue: BrainQueue;
  schedules: BrainSchedules;
  close(): Promise<void>;
}

/**
 * Assemble the SDK surface from its ports. Calling this does no I/O; every
 * connection is made by the adapter factory the caller already built (AD-3).
 */
export function createBrain(dependencies: BrainDependencies): Brain {
  const {
    store,
    cron = { validate: () => ({ok:false as const,code:'SCHEDULE_INVALID' as const,message:'cron 계산기가 없습니다'}), next: () => null },
    files,
    sources,
    userHome,
    spool,
    schemaVersions,
    clock,
    idGen,
    parsers,
    transcripts,
    transcriptFolders = [],
    repositories,
    machine,
    checks,
    prerequisites,
    adapterProbeIds,
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

  const drive = dependencies.drive;
  const sourceFiles: FileStore = {
    put: bytes => files.put(bytes),
    get: async location => {
      if (location.storeKind !== 'drive' || !drive) return files.get(location);
      const binding=await drive.store.readDriveLocatorRoot(location.locator);
      if (!binding.ok) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 위치의 루트를 확인할 수 없습니다'};
      if (binding.rootFolderId !== drive.rootFolderId) return {ok:false,code:'LOCATION_REFUSED',message:'Drive 위치의 루트가 다릅니다'};
      return drive.files.get(location);
    },
    exists: location => location.storeKind === 'drive' && drive ? drive.files.exists(location) : files.exists(location),
    url: location => location.storeKind === 'drive' && drive ? drive.files.url(location) : files.url(location),
    delete: location => location.storeKind === 'drive' && drive ? drive.files.delete(location) : files.delete(location),
  };
  const driveDeps = drive ? {store:drive.store,uploads:drive.uploads,local:files,drive:drive.files,settings:{store,schemaVersions,clock},rootFolderId:drive.rootFolderId,clock,idGen} : undefined;
  // The kinds Core owns, and then the caller's. `session_ingest` is Core's own
  // because what it does is a use case and the ports it needs are the ones this
  // brain was assembled from (`capture/session-ingest-work.ts`).
  const coreHandlers: WorkHandlers = {
    ...(store.imports && dependencies.importStaging ? { [FILE_IMPORT_KIND]: importFileHandler(store.imports, dependencies.importStaging, files, clock, idGen, store, store) } : {}),
    [CONVERSATION_CHUNK_KIND]: conversationChunkHandler({ store, clock, idGen }),
    [SCHEDULE_PROBE_KIND]: scheduleProbeHandler,
    [SESSION_IDENTITY_KIND]: sessionIdentityHandler(ingestDependencies),
    [SESSION_INGEST_KIND]: sessionIngestHandler({
      ingest: (input, options) => ingestSession(ingestDependencies, input, options),
      store,
      clock,
    }),
    // Core's own for the same reason: reading a stored attachment is a use case,
    // and the ports it needs — the store, the file store, the clock, the ids —
    // are exactly the ones this brain was assembled from (`files/extract-work.ts`).
    [DOCUMENT_EXTRACT_KIND]: documentExtractHandler({ store, files:sourceFiles, clock, idGen, ...(dependencies.sourceSync ? {source:dependencies.sourceSync} : {}) }),
    ...(dependencies.sourceSync ? {[SOURCE_SYNC_KIND]:sourceSyncHandler({...dependencies.sourceSync,clock,idGen})} : {}),
    // And the same again for deleting one of them: the ports it needs are the
    // store, the file store and the clock, and what it does — empty one place
    // and record that it is empty — is a use case (`files/blob-delete-work.ts`).
    [BLOB_DELETE_KIND]: blobDeleteHandler({ store, files, clock, ...(drive ? {driveFiles:drive.files,driveRoot:{store:drive.store,rootFolderId:drive.rootFolderId}} : {}) }),
    ...(driveDeps ? {
      [DRIVE_MIGRATE_KIND]: driveMigrationHandler(driveDeps),
      [DRIVE_LOCAL_DELETE_KIND]: driveLocalDeleteHandler({store:{readDriveRetention:id=>driveDeps.store.readDriveRetention(id),markFileLocationDeleted:input=>store.markFileLocationDeleted(input),resolveFailures:input=>store.resolveFailures(input)},local:files,drive:driveDeps.drive,rootFolderId:driveDeps.rootFolderId,clock}),
    } : {}),
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

  const readTimeZone = () => getSetting({ store, schemaVersions, clock }, { key: 'timezone' });
  return {
    channels: {
      list: async () => {
        const result = await store.listChannelStatuses();
        return result.ok ? result : { ...result, message: maskOutputText(result.message) };
      },
      status: async ({ id }) => {
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) return { ok: false, code: 'INVALID_ARGUMENT', message: '요청 ID가 UUID 형식이 아닙니다' };
        const result = await store.readChannelStatus(id);
        if (!result.ok) return { ...result, message: maskOutputText(result.message) };
        return result.request ? { ok: true, request: result.request } : { ok: false, code: 'CHANNEL_REQUEST_NOT_FOUND', message: '요청이 없습니다' };
      },
      resend: async ({ id }) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)
        ? ((result) => result.ok ? result : { ...result, message: maskOutputText(result.message) })(await store.resendChannelRequest({ requestId: id, workId: idGen.next(), now: clock.now() }))
        : { ok: false, code: 'INVALID_ARGUMENT', message: '요청 ID가 UUID 형식이 아닙니다' },
    },
    sources: {async sync({sourceId}) {
      if(!dependencies.sourceSync)return {ok:false,code:'SOURCE_UNAVAILABLE',message:'연결된 source가 없습니다'};
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))return {ok:false,code:'INVALID_ARGUMENT',message:'source ID가 올바르지 않습니다'};
      const source=await dependencies.sourceSync.store.readSource(sourceId);if(!source.ok)return source;if(!source.source)return {ok:false,code:'INVALID_ARGUMENT',message:'source가 없습니다'};
      const now=clock.now(),added=await store.addWork({id:idGen.next(),kind:SOURCE_SYNC_KIND,targetKind:'source',targetId:sourceId,createdAt:now,nextAttemptAt:now});if(!added.ok)return added;
      const sourceStore=dependencies.sourceSync.store;
      const scopedStore={...store,hasDueWork:({now}:{now:Date})=>sourceStore.hasDueSourceWork({sourceId,syncWorkId:added.item.id,now}),claimWork:({now,claimedBy}:{now:Date;claimedBy:string})=>sourceStore.claimSourceWork({sourceId,syncWorkId:added.item.id,now,claimedBy})};
      const report=await drainQueue({store:scopedStore,spool,clock,idGen},{budgetMs:60_000,handlers:{[SOURCE_SYNC_KIND]:handlers[SOURCE_SYNC_KIND]!,[DOCUMENT_EXTRACT_KIND]:handlers[DOCUMENT_EXTRACT_KIND]!}});
      await cleanupSourceTemps(dependencies.sourceSync.temp,sourceStore,clock);
      if(report.stopped==='unwritable')return {ok:false,code:report.code??'DB_UNAVAILABLE',message:'source 동기화 중 저장할 수 없습니다'};
      const result=await sourceStore.readSourceWorkStatus({sourceId,syncWorkId:added.item.id});if(!result.ok)return result;
      if(!result.complete)return {ok:false,code:'SOURCE_SYNC_INCOMPLETE',message:'source 동기화 또는 추출 작업이 완료되지 않았습니다'};
      return {ok:true,sourceId,workId:added.item.id,created:added.created};
    }},
    recall: { docs: async input => { const result = await searchDocuments(store, input, store); return result.ok ? result : withExtensionMetadata(store, result, input.sources); }, chunks: async input => { const result = await searchRecall(store, 'chunks', input, store); return result.ok ? result : withExtensionMetadata(store, result, input.sources); }, tools: async input => { const result = await searchRecall(store, 'tools', input, store); return result.ok ? result : withExtensionMetadata(store, result, input.sources); }, expand: input => expandRecall(store, input) },
    ext: { command: async input => withExtensionMetadata(store, await executeExtensionCommand(dependencies, input), [input.name]), run: input => runExtension(dependencies, input), publicStatus: input => publicExtensionStatus(dependencies, input), enable: input => setExtensionEnabled(dependencies, { ...input, enabled: true }), disable: input => setExtensionEnabled(dependencies, { ...input, enabled: false }), install: input => installExtension({ ...dependencies, cron, readTimeZone }, input), status: input => publicExtensionStatus(dependencies, input), list: () => listExtensions(dependencies) },
    messages: { redact: (input) => redactMessage({ store, clock, idGen }, input) },
    files: { show: input => showDocument(store, input, async (fileId, extractionId) => {
      const state=await store.readFileExtractionState(fileId);
      if (!state.ok) return {ok:false,code:state.code === 'DB_LOCKED' ? 'DB_LOCKED' : 'DB_UNAVAILABLE',message:state.message};
      if (state.redactedAt !== null) return {ok:false,code:'FILES_UNAVAILABLE',message:'가린 파일입니다'};
      if (state.home?.storeKind !== 'drive') return {ok:true,bytes:null};
      if (!drive || state.home.ownership !== 'brain') return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 원본에 접근할 수 없습니다'};
      const candidate=await drive.store.readDriveCandidate(fileId);
      if (!candidate.ok || !candidate.candidate || candidate.candidate.home.locator !== state.home.locator) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 위치를 확인할 수 없습니다'};
      const binding=await drive.store.readDriveLocationRoot(candidate.candidate.homeId);
      if (!binding.ok || binding.rootFolderId !== drive.rootFolderId) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 위치의 루트가 다릅니다'};
      const read=await drive.files.get(state.home);
      if (!read.ok || read.bytes.length !== state.sizeBytes || contentHashOfBytes(read.bytes) !== state.contentHash) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 원본을 확인할 수 없습니다'};
      const after=await store.readFileExtractionState(fileId);
      if (!after.ok) return {ok:false,code:after.code === 'DB_LOCKED' ? 'DB_LOCKED' : 'DB_UNAVAILABLE',message:after.message};
      if (after.redactedAt !== null || after.currentExtractionId !== extractionId || after.contentHash !== state.contentHash || after.home?.storeKind !== 'drive' || after.home.locator !== state.home.locator || after.home.ownership !== 'brain') return {ok:false,code:'FILES_UNAVAILABLE',message:'파일 상태가 변경되어 다시 읽어야 합니다'};
      const current=await drive.store.readDriveCandidate(fileId);
      if (!current.ok || !current.candidate || current.candidate.homeId !== candidate.candidate.homeId) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 위치가 변경되어 다시 읽어야 합니다'};
      return {ok:true,bytes:read.bytes};
    }), redact: (input) => redactFile({ store, clock, idGen }, input) },
    doctor: {
      run: () =>
        runDoctor(store, {
          schemaVersions,
          extensionStore: store,
          ...(dependencies.extensions?.packages.readObservation ? { readPackageObservation: dependencies.extensions.packages.readObservation } : {}),
          store,
          clock,
          folders: transcriptFolders,
          checks,
          prerequisites,
          adapterProbeIds,
        }),
    },
    sessions: {
      read: input => readSessionPage(store, input),
      ingest: async (input) => {
        const result = await createIngestBrain(ingestDependencies).sessions.ingest(input);
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
    schedules: {
      tick: () => tickSchedules({ store, clock, idGen, readTimeZone, cron }),
      list: input => listSchedules({ store }, input),
      remove: input => removeSchedule({ store, clock }, input),
      add: input => addSchedule({ store, clock, idGen, readTimeZone, cron }, input),
      update: input => updateSchedule({ store, clock, idGen, readTimeZone, cron }, input),
      run: input => runSchedule({ store, clock, idGen, readTimeZone, cron }, input),
    },
    queue: {
      hold: input => holdWorkGroup({ store, clock }, input),
      release: input => releaseWorkGroup({ store }, input),
      list: input => listWork({ store, clock }, input),
      async cancel(input) {
        const result = await store.requestWorkCancel({ id: input.id, now: clock.now() });
        if (!result.ok) return result;
        if (result.state === 'not_found') return { ok: false, code: 'WORK_NOT_FOUND', message: '지정한 일감이 없습니다' };
        return { ok: true, id: input.id, state: result.state };
      },
      drain: (input) =>
        drain(
          { store, spool, clock, idGen, folders: transcriptFolders, parsers, spoolHandlers, ...(dependencies.sourceSync?{sourceCleanup:dependencies.sourceSync}:{}) },
          {
            budgetMs: input.budgetMs,
            handlers: Object.fromEntries(Object.entries({ ...handlers, ...input.handlers }).filter(([kind]) => workExecutionClass(kind) === 'core')),
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
  sourceCleanup?:{store:SourceStore;temp:SourceTemp};
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
  if(dependencies.sourceCleanup)await cleanupSourceTemps(dependencies.sourceCleanup.temp,dependencies.sourceCleanup.store,clock);

  return {
    ...queue,
    replayed: replay.replayed,
    spoolFailed: replay.failed,
    enqueued: scan.enqueued,
    ...(queue.stopped !== 'unwritable' && scan.stopped !== undefined ? { scanStopped: scan.stopped } : {}),
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

export type IngestBrain = { sessions: Pick<BrainSessions, 'ingest'> };
export function createIngestBrain(dependencies: IngestSessionDependencies): IngestBrain {
  return { sessions: { ingest: input => ingestSession(dependencies, input) } };
}

export type SettingsBrain = { config: {
  get(input: { key: string }): Promise<import('./settings/index.js').SettingResult>;
  set(input: { key: string; value: string; scope?: 'user' | 'global' }): Promise<import('./settings/index.js').SettingResult>;
} };
export function createSettingsBrain(dependencies: import('./settings/index.js').SettingsDependencies): SettingsBrain {
  // Validate registrations at assembly time, before any I/O.
  settingDefinitions(dependencies.settingDefinitions);
  return { config: { get: input => getSetting(dependencies, input), set: input => setSetting(dependencies, input) } };
}
