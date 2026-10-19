export * from './domain/index.js';
export * from './ports/index.js';
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
  type DoctorReport,
  type DoctorSummary,
} from './doctor/doctor.js';
export {
  createBrain,
  type Brain,
  type BrainDoctor,
  type BrainDependencies,
  type BrainQueue,
  type BrainQueueDrainInput,
  type BrainSessions,
} from './brain.js';
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
  type IngestSessionResult,
} from './sessions/ingest.js';
export {
  spoolSessionIngest,
  type SpoolSessionIngestDependencies,
} from './sessions/spool-ingest.js';
export {
  replaySpool,
  type ReplaySpoolDependencies,
  type ReplaySpoolOptions,
  type ReplaySpoolReport,
  type SpoolReplayHandler,
  type SpoolReplayHandlerResult,
  type SpoolReplayHandlers,
} from './spool/replay.js';
