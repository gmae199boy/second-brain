/** The four things a work log line can be (FR-7, FR-19 … FR-22). */
export type LogEntryKind = 'progress' | 'decision' | 'rule' | 'preference';

/**
 * State of a rule. `pending` is never injected; only a human turns a rule
 * `off`, and only `log.append` or drain lift `pending` to `on` (AD-14).
 */
export type RuleState = 'pending' | 'on' | 'off';

/**
 * One work log line. Only `log.append` creates it: hooks, ingest and drain
 * never do (AD-14).
 */
export interface LogEntry {
  /** UUIDv7 minted by the writing process; the idempotency key (Table Contract). */
  id: string;
  /** Immutable. */
  kind: LogEntryKind;
  /** Immutable. */
  sessionId: string;
  /** Immutable. Set once by the writing process through `Clock` (AD-13). */
  occurredAt: Date;
  /** When the row reached the DB, apart from `occurredAt` (AD-13). */
  recordedAt: Date;
  /** Immutable. The model that wrote the line, when one did (AD-14). */
  authorModel: string | null;
  /** The current sentence. `log.edit` is the only way to change it (AD-11). */
  text: string;
  /** Set for rules only (AD-14). */
  ruleState: RuleState | null;
  /**
   * Where a rule applies. The one place a tag lives outside `sessions`,
   * because scope is a property of the rule (AD-12).
   */
  applyProjectId: string | null;
  /** Replacing a decision or preference is a new row plus this link (AD-11). */
  supersedesId: string | null;
  /** The message this line was joined to: the latest `seq` at or before
   * `occurredAt`, or `null` while no message qualifies yet (AD-14). */
  anchorSeq: number | null;
  /** How far the messages were read when the join was made (AD-14). */
  joinedUptoSeq: number | null;
}

/** The sentence a `log.edit` replaced, written in the same transaction (AD-11). */
export interface LogEntryEdit {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  logEntryId: string;
  previousText: string;
  editedAt: Date;
}
