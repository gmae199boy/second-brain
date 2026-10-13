/** Where the session's data came from. Immutable (Table Contract). */
export type SessionIngestSource = 'live' | 'import';

/** Why the harness started this session. Changeable (Table Contract). */
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact' | 'fork';

/**
 * How far a parser read: the last harness message it saw plus the fingerprint
 * of everything up to that point. A missing message or a different fingerprint
 * means reading from the start again (AD-4).
 */
export interface ParserCursor {
  lastHarnessMessageId: string;
  fingerprint: string;
}

/**
 * One harness session. Created by `sessions.ensure` (find-or-create) and
 * updated by `sessions.ingest` (Table Contract).
 */
export interface Session {
  /** UUIDv7 minted by whoever creates the row; never a DB-generated id (AD-8). */
  id: string;
  /** Key together with `harnessSessionId`. Immutable. */
  harness: string;
  harnessSessionId: string;
  /** Immutable. In slice 1 the user is always me (AD-12). */
  userId: string;
  /** Immutable. Machine the session ran on (AD-12). */
  machine: string;
  /** Immutable. */
  startedAt: Date;
  /**
   * Tags, computed once from the cwd by whoever creates the session (AD-12).
   * `workspaceId` is the one a human may change afterwards.
   */
  workspaceId: string | null;
  projectId: string | null;
  worktreeId: string | null;
  /** Immutable. */
  ingestSource: SessionIngestSource;
  /** Monotonic; best effort, since correctness never waits for session end (AD-6). */
  endedAt: Date | null;
  /** Monotonic cursor, advanced in the same transaction as the batch (AD-7). */
  cursor: ParserCursor | null;
  /** Monotonic. Recorded per session so parser changes stay traceable (AD-4). */
  parserVersion: string | null;
  /** Monotonic. When the data reached the DB, apart from `startedAt` (AD-13). */
  ingestedAt: Date | null;
  startSource: SessionStartSource | null;
  /** Reserved: slice 1 never fills it (Table Contract). */
  continuedFromSessionId: string | null;
}
