import { projectIdentityKey } from '../domain/project-identity.js';
import type {
  IngestBatch,
  IngestMessage,
  IngestToolNote,
  IngestTracking,
} from '../domain/ingest-batch.js';
import { failureFingerprint } from '../domain/failure.js';
import { formatSessionToken, type SessionKey } from '../domain/session-token.js';
import {
  SPOOL_RECORD_VERSION,
  type SpoolCause,
  type SpoolRecord,
} from '../domain/spool-record.js';
import type {
  AddWorkInput,
  EnsureCheckoutInput,
  EnsureSelfUserInput,
  EnsureSessionInput,
  RecordFailureInput,
  RecordTranscriptFileInput,
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
    identityWork: null,
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
    identityKey: projectIdentityKey(overrides.remoteIdentity ?? 'demo.example/brain-owner/notes'),
    worktreeId: sampleWorktreeId,
    worktreePath: '/demo/repo',
    ...overrides,
  };
}

/**
 * The queue and the record, and two ids of each so a case can propose a
 * different one twice (AD-21).
 */
export const sampleWorkItemId = '01940000-0000-7000-8000-000000000010';
export const otherWorkItemId = '01940000-0000-7000-8000-000000000011';
/** A third, so a case can check that the id breaks a tie on attempts. */
export const lastWorkItemId = '01940000-0000-7000-8000-000000000014';
export const sampleFailureId = '01940000-0000-7000-8000-000000000012';
export const otherFailureId = '01940000-0000-7000-8000-000000000013';

/**
 * One piece of work, due at once.
 *
 * `demo_work` is a neutral kind nothing in this build handles, which is what a
 * contract wants: the cases are about the queue's rules, and a kind that some
 * story later gives a meaning to would make them about that story.
 */
export function sampleWorkInput(overrides: Partial<AddWorkInput> = {}): AddWorkInput {
  return {
    id: sampleWorkItemId,
    kind: 'demo_work',
    targetKind: 'session',
    targetId: sampleSessionToken,
    createdAt: new Date('2026-02-03T04:05:06.000Z'),
    nextAttemptAt: new Date('2026-02-03T04:05:06.000Z'),
    ...overrides,
  };
}

/**
 * One failure, as drain records it: the target key of the work item, the kind of
 * work as the stage, and no harness or session — drain knows which item failed,
 * not which conversation it belonged to (Boundaries).
 */
export function sampleFailureInput(
  overrides: Partial<RecordFailureInput> = {},
): RecordFailureInput {
  return {
    id: sampleFailureId,
    targetKind: 'session',
    targetId: sampleSessionToken,
    stage: 'demo_work',
    fingerprint: failureFingerprint({
      stage: 'demo_work',
      input: `session:${sampleSessionToken}`,
      code: 'DEMO_FAILED',
    }),
    harness: null,
    sessionId: null,
    code: 'DEMO_FAILED',
    message: '이 일감은 열 번 모두 실패했습니다',
    occurredAt: new Date('2026-02-03T04:05:06.000Z'),
    ...overrides,
  };
}

/** A spool record's own id, so a case can tell two of them apart. */
export const sampleSpoolRecordId = '01940000-0000-7000-8000-0000000000b0';

/** What `sampleSpoolRecord` can be asked to change. */
export interface SampleSpoolRecordOverrides {
  id?: string;
  occurredAt?: Date;
  session?: string;
  transcriptPath?: string;
  cause?: SpoolCause;
  /**
   * How many replays of this record have already failed (AD-9). Zero by
   * default, which is what every record a write path produces carries.
   */
  attempts?: number;
}

/**
 * One "ingest this session again" mark, as the ingest use case writes it
 * (AD-9). The default cause is a held lock, which is the row of the matrix a
 * turn actually meets.
 */
export function sampleSpoolRecord(
  overrides: SampleSpoolRecordOverrides = {},
): SpoolRecord {
  return {
    schemaVersion: SPOOL_RECORD_VERSION,
    id: overrides.id ?? sampleSpoolRecordId,
    kind: 'session_ingest',
    occurredAt: overrides.occurredAt ?? new Date('2026-01-02T03:06:00.000Z'),
    attempts: overrides.attempts ?? 0,
    payload: {
      session: overrides.session ?? sampleSessionToken,
      transcriptPath: overrides.transcriptPath ?? '/memory/transcripts/session-0001.jsonl',
      cause: overrides.cause ?? 'DB_LOCKED',
    },
  };
}

/** What `sampleFailureSpoolRecord` can be asked to change. */
export interface SampleFailureSpoolRecordOverrides {
  id?: string;
  occurredAt?: Date;
  attempts?: number;
  targetKind?: string;
  targetId?: string;
  stage?: string;
  code?: string;
  workItemId?: string | null;
}

/**
 * One failure record the database refused, as drain writes it (AD-9, AD-21).
 *
 * The second kind of spool line, and the one a replay has to be able to put
 * back without a work item: the claim it belonged to expired long before the
 * database came back.
 */
export function sampleFailureSpoolRecord(
  overrides: SampleFailureSpoolRecordOverrides = {},
): SpoolRecord {
  const occurredAt = overrides.occurredAt ?? new Date('2026-02-03T04:05:06.000Z');
  const stage = overrides.stage ?? 'demo_work';
  const targetKind = overrides.targetKind ?? 'session';
  const targetId = overrides.targetId ?? sampleSessionToken;
  const code = overrides.code ?? 'DEMO_FAILED';
  return {
    schemaVersion: SPOOL_RECORD_VERSION,
    id: overrides.id ?? sampleSpoolRecordId,
    kind: 'failure',
    occurredAt,
    attempts: overrides.attempts ?? 0,
    payload: {
      targetKind,
      targetId,
      stage,
      fingerprint: failureFingerprint({ stage, input: `${targetKind}:${targetId}`, code }),
      harness: null,
      sessionId: null,
      code,
      message: '이 일감은 열 번 모두 실패했습니다',
      occurredAt,
      workItemId: overrides.workItemId ?? sampleWorkItemId,
    },
  };
}

/** One transcript file's history, as a successful ingest records it. */
export function sampleTranscriptFileInput(
  overrides: Partial<RecordTranscriptFileInput> = {},
): RecordTranscriptFileInput {
  return {
    id: sampleTranscriptFileId,
    harness: sampleSessionKey.harness,
    path: '/memory/transcripts/session-0001.jsonl',
    sizeBytes: 1024,
    fingerprint: `sha256:${'a'.repeat(64)}`,
    cursor: { lastHarnessMessageId: 'm2', fingerprint: `sha256:${'b'.repeat(64)}` },
    scannedAt: new Date('2026-02-03T04:05:06.000Z'),
    reset: false,
    ...overrides,
  };
}

/** Two ids, so a case can propose a different one for the same file. */
export const sampleTranscriptFileId = '01940000-0000-7000-8000-000000000020';
export const otherTranscriptFileId = '01940000-0000-7000-8000-000000000021';

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
  const ingestedAt = overrides.tracking?.ingestedAt ?? new Date('2026-01-02T03:06:00.000Z');
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
      cursorReset: parsed.cursorReset,
      // Where the session stood when this read began. `null` is the honest
      // default for a fixture: the sample batch is what a first read produces,
      // and a case about an overlapping reset says what its base was itself.
      cursorBase: null,
      startSource: parsed.startSource,
      endedAt: null,
      ingestedAt,
      ...overrides.tracking,
    },
    messages,
    toolNotes,
  };
}
