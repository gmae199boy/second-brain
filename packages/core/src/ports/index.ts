// The ports every adapter implements, each with its own contract cases in
// `@second-brain/core/testing`.
export type {
  ListIdentityCandidatesResult,
  CountUntaggedSessionsResult,
  AddWorkInput,
  AddWorkResult,
  ClaimWorkInput,
  ClaimWorkResult,
  CompleteWorkInput,
  DueWorkQuery,
  EnsureCheckoutInput,
  EnsureSelfUserInput,
  EnsureSelfUserResult,
  EnsureSessionInput,
  EnsureSessionResult,
  FindSessionResult,
  FillSessionTagsInput,
  FillSessionTagsResult,
  FinishWorkInput,
  FinishWorkResult,
  HasDueWorkResult,
  HealthStore,
  IngestCounts,
  IngestResult,
  ListFailuresQuery,
  ListFailuresResult,
  ListOpenWorkTargetsResult,
  ListTranscriptFilesQuery,
  ListTranscriptFilesResult,
  ReadSchemaVersionResult,
  ReadSelfUserResult,
  ReadSessionResult,
  RedactMessageInput,
  RedactMessageResult,
  RecordFailureInput,
  RecordFailureResult,
  RecordTranscriptFileInput,
  RecordTranscriptFileResult,
  ResolveFailuresInput,
  ResolveFailuresResult,
  RetryWorkInput,
  SchemaStore,
  SessionContents,
  SessionStore,
  Store,
  StoreHealth,
  StoreProbe,
  StoreSourceHealth,
  StoreWarningCode,
  TranscriptFileStore,
  UserStore,
  WorkFinishOutcome,
  WorkStore,
  WorkTarget,
} from './store.js';
export type { ParseResult, Parser } from './parser.js';
export type {
  ListTranscriptsResult,
  ReadTranscriptResult,
  TranscriptFolder,
  TranscriptListing,
  TranscriptReader,
} from './transcript.js';
export type { Checkout, FolderListing, InspectResult, InspectUnknownReason, RepositoryInspector } from './repository.js';
export type { HookInput, HookInputReader, ReadHookInputResult } from './hook.js';
export { BRAIN_MARKER } from './connector.js';
export type { ConnectInput, ConnectResult, Connector } from './connector.js';
export type { EmbedResult, Embedder } from './embedder.js';
export type { RerankResult, RerankedDocument, Reranker } from './reranker.js';
export type { Clock } from './clock.js';
export type { IdGen } from './id-gen.js';
export type {
  Spool,
  SpoolAppendResult,
  SpoolClaim,
  SpoolClaimResult,
  SpoolCompleteResult,
  SpoolReleaseResult,
  SpoolRewriteInput,
  SpoolRewriteResult,
  SpoolStatsResult,
} from './spool.js';
export * from './file-store.js';
export type { AttachmentStore, MessageAttachment, LinkAttachmentsInput, LinkAttachmentsResult, ListMessageAttachmentsResult } from './store.js';

export type { SourceFileReader } from './source-file.js';
export type { MissingFileName, FileName, ListMissingFileNamesResult, ListFileNamesResult, WriteFileNamesResult } from './store.js';

// The extraction capability of AD-24: one reading of one file, in pieces.
export type {
  AppendExtractionChunksInput,
  AppendExtractionChunksResult,
  BeginExtractionInput,
  BeginExtractionResult,
  ExtractionChunkInput,
  ExtractionClaim,
  ExtractionOutcome,
  ExtractionStore,
  FileExtractionState,
  FinishExtractionInput,
  FinishExtractionResult,
  ListExtractionChunksResult,
  ListExtractionsResult,
  ListFilesAwaitingExtractionResult,
  ReadFileExtractionStateResult,
  SetFileSourceUnreachableInput,
  SetFileSourceUnreachableResult,
} from './store.js';
