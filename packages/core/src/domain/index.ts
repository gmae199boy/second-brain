// The common language between the units: one type per table of the Table
// Contract, plus the ingest input of AD-4 and the session token of AD-8.
export type { Workspace } from './workspace.js';
export type { Project } from './project.js';
export { normalizeRemoteIdentity, CASE_INSENSITIVE_HOSTS, projectIdentityKey } from './project-identity.js';
export type { Worktree } from './worktree.js';
export type {
  ParserCursor,
  Session,
  SessionIngestSource,
  SessionStartSource,
  TagSource,
} from './session.js';
export {
  SESSION_TOKEN_SEPARATOR,
  formatSessionToken,
  parseSessionToken,
  type ParseSessionTokenResult,
  type SessionKey,
  type SessionToken,
} from './session-token.js';
export type { Message, MessageRole } from './message.js';
export type { User } from './user.js';
export { TOOL_NOTE_TARGET_LIMIT, type ToolNote } from './tool-note.js';
export type { LogEntry, LogEntryEdit, LogEntryKind, RuleState } from './log-entry.js';
export { DOCUMENT_CHUNK_INDEX_CONFIG_ID } from './index-config.js';
export type {
  ChunkParams,
  ConversationIndexConfig,
  DocumentChunkIndexConfig,
  DocumentChunkParams,
  IndexConfig,
  IndexConfigKind,
} from './index-config.js';
export type { Chunk } from './chunk.js';
export {
  CHUNK_LOCATOR_TYPES,
  chunkLocatorPage,
  chunkPageMatches,
  decodeChunkLocator,
  encodeChunkLocator,
  type ChunkLocator,
  type ChunkLocatorType,
  type DecodeChunkLocatorResult,
  type DocxChunkLocator,
  type EncodeChunkLocatorResult,
  type PdfChunkLocator,
  type TextChunkLocator,
} from './chunk-locator.js';
export {
  DOCUMENT_CHUNK_BATCH_MAX,
  DOCUMENT_CHUNK_PARAMS,
  DOCUMENT_EXTRACT_MAX_BYTES,
} from './document.js';
export type {
  DocumentChunk,
  DocumentExtraction,
  DocumentExtractionFailedStage,
  DocumentExtractionStatus,
} from './document.js';
export type { Embedding, EmbeddingTargetKind } from './embedding.js';
export type { Redaction } from './redaction.js';
export {
  SECRET_PATTERNS,
  SECRET_PATTERN_VERSION,
  maskSecrets,
  type MaskSecretsResult,
  type SecretField,
  type SecretSpan,
} from './secret-patterns.js';
export { CONTENT_HASH_PREFIX, contentHash, sha256, sha256Hex, utf8Bytes } from './sha256.js';
export {
  SPOOL_CAUSES,
  SPOOL_CLAIM_STALE_MS,
  SPOOL_LINE_MAX_BYTES,
  SPOOL_RECORD_KINDS,
  SPOOL_RECORD_VERSION,
  decodeSpoolLine,
  encodeSpoolLine,
  type DecodeSpoolLineResult,
  type EncodeSpoolLineResult,
  type FailureSpoolPayload,
  type FailureSpoolRecord,
  type SessionIngestSpoolPayload,
  type SessionIngestSpoolRecord,
  type SpoolCause,
  type SpoolRecord,
  type SpoolRecordKind,
} from './spool-record.js';
export type { ContextInjection } from './context-injection.js';
export {
  FAILURE_MESSAGE_MAX_BYTES,
  failureFingerprint,
  failureText,
  truncateUtf8,
  type Failure,
  type FailureFingerprintInput,
} from './failure.js';
export {
  DEFAULT_WORK_POLICY,
  DRAIN_BUDGET_MS,
  MAX_WORK_ATTEMPTS,
  retryDelayMs,
  workKindPolicy,
  type WorkItem,
  type WorkKindPolicy,
} from './work-item.js';
export {
  TRANSCRIPT_DEADLINE_WARN_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
  type TranscriptFile,
} from './transcript-file.js';
export type { SchemaVersion } from './schema-version.js';
export type {
  IngestBatch,
  IngestAttachment,
  ParsedAttachment,
  IngestMessage,
  IngestToolNote,
  IngestTracking,
  ParsedMessage,
  ParsedToolNote,
  ToolNotePosition,
} from './ingest-batch.js';

export { planRedaction, type RedactionCurrent, type RedactionRequest, type RedactionPlan, type RedactionRefusal } from './redact-plan.js';
export * from './file.js';
export type { AttachmentLinkSpoolPayload, AttachmentLinkSpoolRecord } from './spool-record.js';

export type { Schedule } from './schedule.js';
