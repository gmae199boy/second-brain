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
  type BrainDrainReport,
  type BrainFailures,
  type BrainQueue,
  type BrainQueueDrainInput,
  type BrainSessions,
} from './brain.js';
export {
  FAILURE_RETRY_KINDS,
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
  type IngestSessionData,
  type IngestSessionDependencies,
  type IngestSessionInput,
  type IngestSessionOptions,
  type IngestSessionResult,
} from './sessions/ingest.js';
export {
  spoolSessionIngest,
  type SpoolSessionIngestDependencies,
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
