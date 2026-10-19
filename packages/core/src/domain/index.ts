// The common language between the units: one type per table of the Table
// Contract, plus the ingest input of AD-4 and the session token of AD-8.
export type { Workspace } from './workspace.js';
export type { Project } from './project.js';
export { normalizeRemoteIdentity } from './project-identity.js';
export type { Worktree } from './worktree.js';
export type {
  ParserCursor,
  Session,
  SessionIngestSource,
  SessionStartSource,
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
export type { ToolNote } from './tool-note.js';
export type { LogEntry, LogEntryEdit, LogEntryKind, RuleState } from './log-entry.js';
export type { ChunkParams, IndexConfig, IndexConfigKind } from './index-config.js';
export type { Chunk } from './chunk.js';
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
  type SessionIngestSpoolPayload,
  type SpoolCause,
  type SpoolRecord,
  type SpoolRecordKind,
} from './spool-record.js';
export type { ContextInjection } from './context-injection.js';
export type { Failure } from './failure.js';
export type { TranscriptFile } from './transcript-file.js';
export type { SchemaVersion } from './schema-version.js';
export type {
  IngestBatch,
  IngestMessage,
  IngestRedaction,
  IngestToolNote,
  IngestTracking,
  ParsedMessage,
  ParsedToolNote,
} from './ingest-batch.js';
