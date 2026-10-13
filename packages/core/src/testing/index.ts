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
  assertStoreHealth,
  clockContract,
  embedderContract,
  idGenContract,
  parserContract,
  rerankerContract,
  sessionStoreContract,
  storeContract,
  type ParserSubject,
} from './contracts/index.js';
export {
  memoryStore,
  type MemoryStore,
  type MemoryStoreOptions,
  type MemoryStoreSnapshot,
} from './fakes/store.js';
export {
  memoryParser,
  memoryTranscript,
  unreadableTranscript,
  type MemoryParserOptions,
} from './fakes/parser.js';
export { memoryEmbedder, type MemoryEmbedderOptions } from './fakes/embedder.js';
export { memoryReranker, type MemoryRerankerOptions } from './fakes/reranker.js';
export { fixedClock, steppingClock } from './fakes/clock.js';
export { sequenceIdGen, type SequenceIdGenOptions } from './fakes/id-gen.js';
export {
  otherSessionId,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSessionId,
  sampleSessionKey,
  sampleSessionToken,
  unknownSessionToken,
} from './fixtures.js';
export { smallHash } from './hash.js';
export { UUID_V7_PATTERN, isUuidV7 } from './uuid-v7.js';
