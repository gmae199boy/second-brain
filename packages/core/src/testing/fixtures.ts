import type { IngestBatch, IngestTracking } from '../domain/ingest-batch.js';
import { formatSessionToken, type SessionKey } from '../domain/session-token.js';
import type { EnsureSessionInput } from '../ports/store.js';
import { memoryParser, memoryTranscript } from './fakes/parser.js';

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

export function sampleEnsureSessionInput(
  overrides: Partial<EnsureSessionInput> = {},
): EnsureSessionInput {
  return {
    id: sampleSessionId,
    key: sampleSessionKey,
    userId: 'owner',
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

/**
 * The batch the sample transcript parses into, so the fixture and the parser
 * fake can never drift apart.
 */
export function sampleIngestBatch(
  overrides: { key?: SessionKey; tracking?: Partial<IngestTracking> } = {},
): IngestBatch {
  const parser = memoryParser();
  const parsed = parser.parse(memoryTranscript);
  if (!parsed.ok) {
    // The fixture and the fake ship together, so this can only be a bug.
    throw new Error(`the sample transcript no longer parses: ${parsed.message}`);
  }
  return {
    key: overrides.key ?? sampleSessionKey,
    tracking: {
      parserVersion: parsed.parserVersion,
      cursor: parsed.cursor,
      cursorReset: false,
      endedAt: null,
      ...overrides.tracking,
    },
    messages: parsed.messages,
    toolNotes: parsed.toolNotes,
  };
}
