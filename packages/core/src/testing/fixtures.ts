import type {
  IngestBatch,
  IngestMessage,
  IngestRedaction,
  IngestToolNote,
  IngestTracking,
} from '../domain/ingest-batch.js';
import { SECRET_PATTERN_VERSION } from '../domain/secret-patterns.js';
import { formatSessionToken, type SessionKey } from '../domain/session-token.js';
import type {
  EnsureCheckoutInput,
  EnsureSelfUserInput,
  EnsureSessionInput,
} from '../ports/store.js';
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

/**
 * The project and worktree `sampleCheckoutInput` proposes, and two more so a
 * case can propose different ones for the same identity and the same path.
 */
export const sampleProjectId = '01940000-0000-7000-8000-00000000000c';
export const otherProjectId = '01940000-0000-7000-8000-00000000000d';
export const sampleWorktreeId = '01940000-0000-7000-8000-00000000000e';
export const otherWorktreeId = '01940000-0000-7000-8000-00000000000f';

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
    // No tags by default: a session whose cwd said nothing is the shape most
    // cases want, and the ones about the tags ask for a checkout themselves.
    checkout: null,
    ...overrides,
  };
}

/**
 * The checkout a tagged session is created with. Neutral names only, and a
 * normalized identity: `host/owner/repo` is what Core's one normalizing
 * function produces, and the store never looks at a URL (AD-12).
 */
export function sampleCheckoutInput(
  overrides: Partial<EnsureCheckoutInput> = {},
): EnsureCheckoutInput {
  return {
    projectId: sampleProjectId,
    remoteIdentity: 'demo.example/brain-owner/notes',
    worktreeId: sampleWorktreeId,
    worktreePath: '/demo/repo',
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
  /**
   * How many masking records to hang on every message. The default is none,
   * because that is what nearly every message carries; a case about the
   * records asks for them (AD-11).
   */
  redactions?: number;
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
  const ingestedAt = overrides.tracking?.ingestedAt ?? new Date('2026-01-02T03:06:00.000Z');
  const perMessage = overrides.redactions ?? 0;
  const messages: IngestMessage[] = kept.map((message) => {
    // The message's id first and then its records', which is the order the use
    // case mints them in (AD-8).
    const id = idGen.next();
    const redactions: IngestRedaction[] = Array.from({ length: perMessage }, (_unused, index) => ({
      id: idGen.next(),
      // Any valid half-open range: the schema only asks for `0 <= start < end`,
      // and no store reads the body to check that something was there.
      start: index * 10,
      end: index * 10 + 5,
      kind: 'api_key',
      contentHash: `sha256:${String(index).padStart(64, '0')}`,
      patternVersion: SECRET_PATTERN_VERSION,
      occurredAt: ingestedAt,
    }));
    return { ...message, id, redactions };
  });
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
      cursorReset: parsed.cursorReset,
      startSource: parsed.startSource,
      endedAt: null,
      ingestedAt,
      ...overrides.tracking,
    },
    messages,
    toolNotes,
  };
}
