/**
 * The contract cases every adapter must pass, plus the in-memory fakes that
 * define what passing looks like. This entry point depends on nothing — no
 * Node API, no test runner — because Core may not (AD-1): an adapter imports
 * the cases and plugs them into whatever runner it uses.
 *
 * ```ts
 * import { sessionStoreContract } from '@second-brain/core/testing';
 * for (const c of sessionStoreContract()) it(c.name, () => c.run(makeStore));
 * ```
 */
export {
  ContractViolation,
  assertEqual,
  assertFiniteNumber,
  assertInteger,
  assertNonEmptyString,
  assertNotEqual,
  assertNotOk,
  assertOk,
  assertTrue,
  assertValidDate,
  deepEqual,
  describeValue,
  fail,
} from './assert.js';
export {
  contractCase,
  withSubject,
  type ContractCase,
  type SubjectFactory,
} from './contract.js';
export {
  assertReadSchemaVersion,
  assertStoreHealth,
  clockContract,
  connectorContract,
  embedderContract,
  idGenContract,
  parserContract,
  rerankerContract,
  schemaStoreContract,
  sessionStoreContract,
  spoolContract,
  storeContract,
  transcriptFileStoreContract,
  userStoreContract,
  workStoreContract,
  type ConnectorSubject,
  type ParserPair,
  type ParserSubject,
  type SessionStoreSubject,
} from './contracts/index.js';
export {
  memorySchemaStore,
  type MemorySchemaStore,
  type MemorySchemaStoreOptions,
} from './fakes/schema-store.js';
export {
  memoryStore,
  type MemoryStore,
  type MemoryStoreOptions,
  type MemoryStoreSnapshot,
} from './fakes/store.js';
export {
  memorySpool,
  type MemorySpool,
  type MemorySpoolFile,
  type MemorySpoolOptions,
} from './fakes/spool.js';
export {
  memoryParser,
  memoryTranscript,
  unreadableTranscript,
  type MemoryParserOptions,
} from './fakes/parser.js';
export {
  memoryRepositories,
  type MemoryRepositories,
} from './fakes/repository.js';
export {
  memoryTranscriptReader,
  type MemoryTranscriptReader,
  type MemoryTranscriptReaderOptions,
} from './fakes/transcript.js';
export {
  memoryTranscriptFolder,
  type MemoryTranscriptFile,
  type MemoryTranscriptFolder,
  type MemoryTranscriptFolderOptions,
} from './fakes/transcript-folder.js';
export {
  memoryConnector,
  type MemoryConnector,
  type MemoryConnectorOptions,
} from './fakes/connector.js';
export { memoryEmbedder, type MemoryEmbedderOptions } from './fakes/embedder.js';
export { memoryReranker, type MemoryRerankerOptions } from './fakes/reranker.js';
export { fixedClock, steppingClock } from './fakes/clock.js';
export { sequenceIdGen, type SequenceIdGenOptions } from './fakes/id-gen.js';
export {
  lastWorkItemId,
  otherFailureId,
  otherProjectId,
  otherSessionId,
  otherTranscriptFileId,
  otherUserId,
  otherWorkItemId,
  otherWorktreeId,
  sampleCheckoutInput,
  sampleEnsureSessionInput,
  sampleFailureId,
  sampleFailureInput,
  sampleFailureSpoolRecord,
  sampleIngestBatch,
  sampleProjectId,
  sampleSelfUserInput,
  sampleSessionId,
  sampleSessionKey,
  sampleSessionToken,
  sampleSpoolRecord,
  sampleSpoolRecordId,
  sampleTranscriptFileId,
  sampleTranscriptFileInput,
  sampleUserId,
  sampleWorkInput,
  sampleWorkItemId,
  sampleWorktreeId,
  unknownSessionToken,
  type SampleFailureSpoolRecordOverrides,
  type SampleIngestBatchOverrides,
  type SampleSpoolRecordOverrides,
} from './fixtures.js';
export {
  ALLOWED_PROPER_NOUNS,
  assertKoreanProse,
  englishSentences,
  type LanguageCheckOptions,
} from './language.js';
export { smallHash } from './hash.js';
export { UUID_V7_PATTERN, isUuidV7 } from './uuid-v7.js';
export { memoryFileStore } from './fakes/file-store.js';
export { fileStoreContract } from './contracts/file-store.js';
export { attachmentStoreContract, type AttachmentStoreSubject } from './contracts/attachment-store.js';
export { extractionStoreContract, type ExtractionStoreSubject } from './contracts/extraction-store.js';
export { fileRedactionContract, type FileRedactionSubject } from './contracts/file-redaction.js';
