// The ports every adapter implements, each with its own contract cases in
// `@second-brain/core/testing`.
export type {
  EnsureSessionInput,
  EnsureSessionResult,
  HealthStore,
  IngestCounts,
  IngestResult,
  ReadSchemaVersionResult,
  ReadSessionResult,
  SchemaStore,
  SessionContents,
  SessionStore,
  Store,
  StoreHealth,
  StoreProbe,
  StoreSourceHealth,
  StoreWarningCode,
} from './store.js';
export type { ParseResult, Parser } from './parser.js';
export { BRAIN_MARKER } from './connector.js';
export type { ConnectInput, ConnectResult, Connector } from './connector.js';
export type { EmbedResult, Embedder } from './embedder.js';
export type { RerankResult, RerankedDocument, Reranker } from './reranker.js';
export type { Clock } from './clock.js';
export type { IdGen } from './id-gen.js';
