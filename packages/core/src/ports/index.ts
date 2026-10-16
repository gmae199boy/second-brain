// The ports every adapter implements, each with its own contract cases in
// `@second-brain/core/testing`.
export type {
  EnsureSelfUserInput,
  EnsureSelfUserResult,
  EnsureSessionInput,
  EnsureSessionResult,
  HealthStore,
  IngestCounts,
  IngestResult,
  ReadSchemaVersionResult,
  ReadSelfUserResult,
  ReadSessionResult,
  SchemaStore,
  SessionContents,
  SessionStore,
  Store,
  StoreHealth,
  StoreProbe,
  StoreSourceHealth,
  StoreWarningCode,
  UserStore,
} from './store.js';
export type { ParseResult, Parser } from './parser.js';
export type { ReadTranscriptResult, TranscriptReader } from './transcript.js';
export type { HookInput, HookInputReader, ReadHookInputResult } from './hook.js';
export { BRAIN_MARKER } from './connector.js';
export type { ConnectInput, ConnectResult, Connector } from './connector.js';
export type { EmbedResult, Embedder } from './embedder.js';
export type { RerankResult, RerankedDocument, Reranker } from './reranker.js';
export type { Clock } from './clock.js';
export type { IdGen } from './id-gen.js';
