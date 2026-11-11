export * from './channels/handoff.js';
export * from './channels/send.js';
export * from './channels/store.js';
export * from './domain/index.js';
export * from './ports/index.js';
/**
 * The `failures` row, under a second name.
 *
 * `Failure` at this entry point is the envelope's — the shape of a command that
 * did not produce a result — because an explicitly re-exported name wins over a
 * `export *` one, and that has been the meaning of the word here since the
 * envelope existed. An adapter outside this package still needs the domain type,
 * so it gets a name of its own, and the name says what the table is: a record of
 * what went wrong, and never a queue (AD-21).
 */
export type { Failure as FailureRecord } from './domain/failure.js';
export {
  ERROR_CODES,
  EXIT_CODES,
  WARNING_CODES,
  WARNING_CODE_MEANINGS,
  errorCodeSpec,
  exitCodeGuide,
  isErrorCode,
  isWarningCode,
  type ErrorCode,
  type ErrorCodeRow,
  type ErrorCodeSpec,
  type ExitCodeGuide,
  type ExitCodeRow,
  type FailureExit,
  type WarningCode,
  type WarningCodeRow,
} from './codes.js';
export { guideShow } from './guide.js';
export {
  CONFIRM_ARG,
  errorEnvelope,
  isoWithOffset,
  okEnvelope,
  requireConfirmation,
  type Envelope,
  type EnvelopeError,
  type EnvelopeMeta,
  type ExtensionMetadata,
  type Failure,
  type VerbCall,
} from './envelope.js';
/**
 * The output masking and the registry of the ways out (AD-11, 마스킹 B).
 * `TOOL_NOTE_TARGET_LIMIT` is not repeated here: it is a domain constant and
 * the `export *` above already carries it.
 */
export {
  OUTPUT_CODECS,
  encodeHookLine,
  encodeHookOutput,
  encodeTextLine,
  maskOutputText,
  maskOutputValue,
  maskToolNoteTarget,
  sessionForOutput,
  toolNoteForOutput,
  type MaskableToolNote,
  type OutputCodec,
  type OutputProbe,
} from './output/index.js';
export {
  INSTANT_PATTERN,
  formatInstant,
  parseInstant,
  type FormatInstantResult,
  type InstantFailure,
  type ParseInstantResult,
} from './instant.js';
export { BUSY_TIMEOUT_MS, type BusyTimeoutPath } from './busy-timeout.js';
export { checkSchema, type SchemaCheck } from './schema.js';
export {
  prereqFailed,
  runDoctor,
  type DoctorCheck,
  type DoctorCheckSource,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorReadStore,
  type DoctorReport,
  type DoctorSummary,
} from './doctor/doctor.js';
export {
  createBrain,
  type Brain,
  type BrainDoctor,
  type BrainDependencies,
  type SourceControl,
  type SourceControlFailure,
  type BrainDrainReport,
  type BrainFailures,
  type BrainFiles,
  type BrainQueue,
  type BrainQueueDrainInput,
  type BrainSessions,
  type BrainMessages,
} from './brain.js';
export {
  FAILURE_RETRY_KINDS,
  FAILURE_RETRY_STAGES,
  SESSION_INGEST_KIND,
  sessionIngestHandler,
  type SessionIngestWorkDependencies,
} from './capture/session-ingest-work.js';
export {
  scanTranscripts,
  transcriptChanges,
  type ScanTranscriptsDependencies,
  type ScanTranscriptsOptions,
  type ScanTranscriptsReport,
} from './capture/scan.js';
export {
  FAILURES_LIST_LIMIT,
  listFailures,
  type FailuresListData,
  type FailuresListDependencies,
  type FailuresListInput,
  type FailuresListResult,
} from './failures/list.js';
export {
  retryFailures,
  type FailuresRetryData,
  type FailuresRetryDependencies,
  type FailuresRetryInput,
  type FailuresRetryResult,
  type FailuresRetrySkipped,
} from './failures/retry.js';
export {
  WORK_HANDLER_MISSING,
  WORK_HANDLER_THREW,
  classifyWorkFailure,
  drainQueue,
  type DrainQueueDependencies,
  type DrainQueueInput,
  type DrainQueueReport,
  type WorkHandler,
  type WorkHandlerFailure,
  type WorkHandlerResult,
  type WorkHandlers,
  type WorkVerdict,
} from './queue/drain.js';
export {
  ingestSession,
  MAX_SOURCE_FILE_BYTES,
  type IngestSessionData,
  type IngestSessionDependencies,
  type IngestSessionInput,
  type IngestSessionOptions,
  type IngestSessionResult,
} from './sessions/ingest.js';
export {
  spoolSessionIngest,
  type SpoolSessionIngestDependencies,
  type SpoolSessionIngestRead,
} from './sessions/spool-ingest.js';
export {
  SPOOL_REPLAY_FAILED,
  replaySpool,
  type ReplaySpoolDependencies,
  type ReplaySpoolOptions,
  type ReplaySpoolReport,
  type SpoolReplayHandler,
  type SpoolReplayHandlerResult,
  type SpoolReplayHandlers,
} from './spool/replay.js';

export { SESSION_IDENTITY_KIND, REPOSITORY_UNANSWERED, sessionIdentityHandler, type SessionIdentityWorkDependencies } from './capture/session-identity-work.js';

export { redactMessage, checkMessagesRedact, type MessagesRedactInput, type MessagesRedactData, type MessagesRedactResult } from './messages/redact.js';

/** Taking one stored file out of the brain: the check, the verb, the plan (AD-23). */
export {
  FILE_REDACTION_KIND,
  FILE_REDACTION_RESOLVES,
  checkFilesRedact,
  planFileRedaction,
  redactFile,
  type FilesRedactData,
  type FilesRedactDependencies,
  type FilesRedactInput,
  type FilesRedactResult,
} from './files/redact.js';

export { errorLine, describeError } from './error-text.js';

export {
  checkExtractionChunkBatch,
  writeExtractionChunks,
  type CheckExtractionChunkBatchResult,
  type CheckedExtractionChunk,
  type HeldExtractionChunks,
  type WriteExtractionChunksInput,
} from './files/extraction-chunks.js';

/** Deleting the bytes at one place: the kind, the helper that queues it, the worker. */
export {
  BLOB_DELETE_KIND,
  FILE_LOCATION_NOT_FOUND,
  FILE_LOCATION_TARGET_KIND,
  LOCATION_REFUSED,
  blobDeleteHandler,
  blobDeleteWork,
  type BlobDeleteWorkDependencies,
  type BlobDeleteWorkInput,
} from './files/blob-delete-work.js';

/** Reading one stored file into pieces: the kind, the worker, the step before it. */
export {
  DOCUMENT_EXTRACT_KIND,
  EXTRACTION_FAILED,
  FILE_CONTENT_MISMATCH,
  FILE_SOURCE_UNREACHABLE,
  documentExtractHandler,
  enqueueDocumentExtractions,
  enqueueUnsupportedCarry,
  type DocumentExtractWorkDependencies,
  type EnqueueDocumentExtractionsDependencies,
  type EnqueueDocumentExtractionsOptions,
  type EnqueueDocumentExtractionsReport,
} from './files/extract-work.js';
export {
  DOCUMENT_EXTRACTORS,
  DOCUMENT_EXTRACTOR_VERSION,
  textExtractor,
  type DocumentExtractResult,
  type DocumentExtractor,
  type DocumentExtractorPiece,
} from './files/extractors.js';
export {
  TEXT_MEDIA_TYPE,
  chunkDocumentText,
  decodeUtf8Text,
  type DecodeUtf8TextResult,
  type DocumentTextPiece,
} from './files/text-extractor.js';

export * from './queue/schedule-tick.js';
export * from './queue/schedule-probe-work.js';

export { createIngestBrain, type IngestBrain } from './brain.js';
export type { SessionIngestStore } from './ports/store.js';

export * from './maintenance/table-cleanup-work.js';
export type { TableMaintenance } from './ports/table-maintenance.js';

export type { SettingsStore, DriveRetentionSettingsStore, SettingRecord, SettingsStoreFailure } from './ports/store.js';

export * from './settings/index.js';
export { createSettingsBrain, type SettingsBrain } from './brain.js';

export { CONNECT_TIMEOUT_MS } from './busy-timeout.js';
export { CORE_SCHEMA_OWNER, type SchemaVersions } from './schema.js';
export * from './process-abi/codec.js';
export * from './queue/supervisor.js';

export type { BrainQueueCancelResult } from './brain.js';

export { SUPERVISOR_CAPACITY, dependencyFailedText } from './domain/work-item.js';
export { SOURCE_SYNC_LEASE_MS } from './ports/source-store.js';
export * from './queue/work-graph.js';

export * from './local-time.js';
export * from './queue/schedules.js';

export * from './queue/list.js';
export { modelWorkKinds } from './domain/work-item.js';

export type { WorkAttempt } from './domain/work-item.js';

export type { BrainSchedules } from './brain.js';

export { workHoldGroup } from './domain/work-item.js';
export { holdWorkGroup, releaseWorkGroup } from './queue/hold-groups.js';

export type { ExtensionStore, ExtensionRecord, ExtensionStoreFailure, ExtensionPythonEnvironment, ExtensionPublicStatus } from './ports/store.js';

export { validateMigrationNames } from './extensions/migration-names.js';
export { comparePackagePaths, EXTENSION_CORE_VERSION, decodeExtensionManifest, decodeRetiredExtensionManifest, isExtensionName, type ExtensionManifest } from './extensions/manifest.js';
export { runExtensionCheck } from './extensions/check.js';
export { quiesceExtension } from './extensions/quiesce.js';
export { installExtension, type ExtensionPackages, type ExtensionMigrator, type ExtensionRuntime } from './extensions/install.js';
export { extensionStatus, listExtensions, publicExtensionStatus, setExtensionEnabled } from './extensions/status.js';
export type { BrainExt } from './brain.js';
export * from './extensions/snapshot.js';
export * from './recall/conversation-chunker.js';
export * from './recall/conversation-fingerprint.js';
export * from './recall/conversation-work.js';
export * from './recall/text-query.js';
export type * from './ports/conversation-index-store.js';

export { CONVERSATION_CHUNK_INDEX_CONFIG_ID } from './domain/index-config.js';

export type * from './ports/recall-store.js';
export * from './recall/search.js';
export * from './recall/expand.js';
export * from './sessions/read.js';

export { validInstallProgress, installStages } from './extensions/install-progress.js';
export type { ExtensionInstallProgress, StoredExtensionInstallProgress, InstallStage, InstallStageProgress, InstallResult } from './extensions/install-progress.js';

export { cleanProcessGroup } from './queue/process-cleanup.js';

export { extensionPublicProjection } from './extensions/public-projection.js';
export type * from './ports/import-store.js';
export * from './files/import-work.js';


export { runExtension } from './extensions/run.js';

export * from './extensions/commands.js';

export { hasOnlyFiniteNumbers } from './extensions/json-values.js';

export { resolveSelfUser } from './users/self.js';

export type { CronCalculator } from './ports/cron.js';

export { checkExtensionExecution } from './extensions/replacement.js';

export type * from './ports/document-recall-store.js';
export * from './recall/documents.js';
export * from './files/drive-migrate-work.js';

export type * from './ports/source-store.js';
export type * from './ports/source-remote.js';
export * from './sources/sync.js';

export type { WorkProgress, WorkProgressSink } from './queue/progress.js';

export type { ChannelControlStore, ChannelControlFailure, ChannelRoute, ChannelSubscription } from './channels/control.js';

export * from './executable.js';
