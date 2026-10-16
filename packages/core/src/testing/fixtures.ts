import type {
  IngestBatch,
  IngestMessage,
  IngestToolNote,
  IngestTracking,
} from '../domain/ingest-batch.js';
import { formatSessionToken, type SessionKey } from '../domain/session-token.js';
import type { EnsureSelfUserInput, EnsureSessionInput } from '../ports/store.js';
import { memoryParser, memoryTranscript } from './fakes/parser.js';
import { sequenceIdGen } from './fakes/id-gen.js';

/** Neutral names only: the repository is public (Conventions). */
export const sampleSessionKey: SessionKey = {
  harness: 'demo',
  harnessSessionId: 'session-0001',
};

export const sampleSessionToken = formatSessionToken(sampleSessionKey);

/** A token no store has ever seen. */
export const unknownSessionToken = formatSessionToken({
  harness: 'demo',
  harnessSessionId: 'session-9999',
});

/** Two caller-minted UUIDv7 ids, so a case can propose a different one twice. */
export const sampleSessionId = '01940000-0000-7000-8000-000000000001';
export const otherSessionId = '01940000-0000-7000-8000-000000000002';

/**
 * The owner `sampleEnsureSessionInput` points at, and two more so a case can
 * propose a different one. A real adapter has a foreign key from
 * `sessions.user_id`, so a session fixture needs a user that exists (AD-12).
 */
export const sampleUserId = '01940000-0000-7000-8000-00000000000a';
export const otherUserId = '01940000-0000-7000-8000-00000000000b';

/** 2026-01-01T00:00:00Z, so the fixture ids and instants are reproducible. */
const FIXTURE_INSTANT = new Date('2026-01-01T00:00:00.000Z');

export function sampleSelfUserInput(
  overrides: Partial<EnsureSelfUserInput> = {},
): EnsureSelfUserInput {
  return {
    id: sampleUserId,
    name: 'brain-owner',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function sampleEnsureSessionInput(
  overrides: Partial<EnsureSessionInput> = {},
): EnsureSessionInput {
  return {
    id: sampleSessionId,
    key: sampleSessionKey,
    userId: sampleUserId,
    machine: 'demo-machine',
    startedAt: new Date('2026-01-02T03:04:00.000Z'),
    ingestSource: 'live',
    startSource: 'startup',
    workspaceId: null,
    projectId: null,
    worktreeId: null,
    ...overrides,
  };
}

/** What `sampleIngestBatch` can be asked to change. */
export interface SampleIngestBatchOverrides {
  key?: SessionKey;
  tracking?: Partial<IngestTracking>;
  /**
   * First counter value for the row ids, so a second batch in one case gets
   * ids of its own rather than the first batch's again.
   */
  idStart?: number;
  /** Keep only the messages whose harness id is in here, in this order. */
  only?: readonly string[];
}

/**
 * The batch the sample transcript parses into, with the ids and the instant the
 * use case would have added, so the fixture and the parser fake can never
 * drift apart.
 */
export function sampleIngestBatch(
  overrides: SampleIngestBatchOverrides = {},
): IngestBatch {
  const parser = memoryParser();
  const parsed = parser.parse(memoryTranscript);
  if (!parsed.ok) {
    // The fixture and the fake ship together, so this can only be a bug.
    throw new Error(`the sample transcript no longer parses: ${parsed.message}`);
  }

  const kept =
    overrides.only === undefined
      ? parsed.messages
      : overrides.only.flatMap((id) =>
          parsed.messages.filter((message) => message.harnessMessageId === id),
        );
  const keptIds = new Set(kept.map((message) => message.harnessMessageId));

  // Ids are the caller's, and a fixture is a caller: deterministic UUIDv7s, so
  // a case can assert that the row kept the id the batch proposed (AD-8).
  const idGen = sequenceIdGen({
    timestampMs: FIXTURE_INSTANT.getTime(),
    start: overrides.idStart ?? 0,
  });
  const messages: IngestMessage[] = kept.map((message) => ({
    ...message,
    id: idGen.next(),
  }));
  const toolNotes: IngestToolNote[] = parsed.toolNotes
    .filter((note) => keptIds.has(note.harnessMessageId))
    .map((note) => ({ ...note, id: idGen.next() }));

  // A batch of part of the transcript ends where that part ends, not where the
  // whole file does, so the cursor names the last message actually carried.
  const last = messages.at(-1);
  const cursor =
    parsed.cursor === null || last === undefined
      ? parsed.cursor
      : { ...parsed.cursor, lastHarnessMessageId: last.harnessMessageId };

  return {
    key: overrides.key ?? sampleSessionKey,
    tracking: {
      parserVersion: parsed.parserVersion,
      cursor,
      cursorReset: false,
      endedAt: null,
      ingestedAt: new Date('2026-01-02T03:06:00.000Z'),
      ...overrides.tracking,
    },
    messages,
    toolNotes,
  };
}
