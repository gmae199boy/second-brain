/**
 * The one queue, as a type and as the constants that decide how it is worked
 * through (AD-21).
 *
 * Every kind of deferred work — ingesting a session the database would not take,
 * scanning a transcript folder, chunking, writing a mirror, extracting a
 * document — is a row of `work_items` rather than a table of its own, because a
 * second queue means a second claim window and a second retry schedule that
 * disagree with the first. This file holds the row's shape and the three numbers
 * a drain needs to work it: how long a claim lasts, how long to wait before the
 * next attempt, and how many attempts there may be at all.
 *
 * There is no kind in here. A kind is a fact about a unit of work — `ingest`,
 * `chunk`, `mirror` — and the unit that knows how to do it is the one that names
 * it: `session_ingest` is named in `capture/session-ingest-work.ts`, beside the
 * handler that does it. What is here is what every kind shares.
 */

/**
 * One row of `work_items` (0002, 0004).
 *
 * The three claim columns are one fact — who holds this row until when — so
 * they are all three set or all three null, which is what the table's own check
 * constraint says. `attempts` counts the claims that went into processing, so it
 * is raised by the claim and not by the outcome: an item that killed the worker
 * holding it still counted once, which is what stops it from being claimed for
 * ever (Decision 1, 2026-10-19).
 */
export interface WorkItem {
  /** UUIDv7 minted by whoever created the row (AD-8). */
  id: string;
  /** What has to be done. A Core constant of the unit that does it. */
  kind: string;
  /** Together with `targetId`, what it has to be done to. */
  targetKind: string;
  targetId: string;
  createdAt: Date;
  /** How many claims have gone into processing this row. */
  attempts: number;
  /** Not before this instant. A fresh row is due at once (AD-13). */
  nextAttemptAt: Date;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  /** The id of the drain run holding the claim, or `null` for an open row. */
  claimedBy: string | null;
  /** The last failure's message, already masked and cut (`failureText`). */
  lastError: string | null;
  completedAt: Date | null;
}

/**
 * How many attempts a retryable failure gets before it becomes a record.
 *
 * Ten, from AD-21. It is a count of *attempts* and not of failures, which is
 * why a worker that died mid-item spends one of them: the alternative is a row
 * that kills every drain that touches it and is never recorded as a problem
 * (Decision 1, 2026-10-19).
 */
export const MAX_WORK_ATTEMPTS = 10;

/** What one kind of work decides about claiming and waiting (AD-21). */
export interface WorkKindPolicy {
  /**
   * How long a claim holds the row. Past it, the next drain may take the row
   * even though the first one may still be working on it — which is why every
   * finishing verb is a compare-and-set on `claimed_by` (Design Notes).
   */
  claimForMs: number;
  /**
   * How long to wait after attempt `n` failed with an error nothing classified.
   * Exponential, from one second to one hour (AD-21).
   */
  retryDelayMs(attempt: number): number;
  /**
   * How long to wait after a failure that said it was temporary and did not say
   * until when. A `Retry-After` the adapter turned into an instant wins over
   * this; with nothing to go on, a long wait is the right guess for a 429 or a
   * 503 (AD-21).
   */
  transientDelayMs: number;
}

/** The longest an exponential wait may grow to: one hour (AD-21). */
const RETRY_DELAY_CEILING_MS = 3_600_000;

/**
 * `min(1000 · 2^(n−1), one hour)`, where `n` is the attempt that just failed.
 *
 * So the first failure waits a second, the second two, and the eighth is
 * already at the ceiling. An attempt number below one is treated as one: the
 * only way to get there is a caller doing its own arithmetic on `attempts`, and
 * a negative exponent would mean the first failure waits less than the code
 * says it does.
 */
export function retryDelayMs(attempt: number): number {
  const steps = Math.max(1, Math.floor(attempt)) - 1;
  // `2 ** steps` overflows to Infinity around a thousand, and `Math.min` of
  // Infinity is the ceiling, so there is nothing to guard here.
  return Math.min(1000 * 2 ** steps, RETRY_DELAY_CEILING_MS);
}

/**
 * What a kind decides unless it says otherwise: a ten-minute claim, the
 * exponential wait above, and fifteen minutes for an external hiccup.
 *
 * Ten minutes is the same window the spool's claims use (`SPOOL_CLAIM_STALE_MS`)
 * and for the same reason: an item has to be taken back from a worker that was
 * killed, and the budget of one drain run is far below it, so a claim that
 * expired means the worker is gone rather than slow.
 */
export const DEFAULT_WORK_POLICY: WorkKindPolicy = {
  claimForMs: 600_000,
  retryDelayMs,
  transientDelayMs: 900_000,
};

/**
 * The kinds that want something other than the default.
 *
 * Empty, and that is not an oversight. The one kind this build has —
 * `session_ingest` — wants exactly the default: a ten-minute claim, the
 * exponential wait and fifteen minutes for an external hiccup. A table seeded
 * with numbers no measurement produced would be worse than no table, so a kind
 * earns an entry here only when something has shown it needs one.
 */
const WORK_KIND_POLICIES: Readonly<Record<string, WorkKindPolicy>> = {};

/** The policy for one kind: its own entry, or the default (AD-21). */
export function workKindPolicy(kind: string): WorkKindPolicy {
  return Object.hasOwn(WORK_KIND_POLICIES, kind)
    ? (WORK_KIND_POLICIES[kind] ?? DEFAULT_WORK_POLICY)
    : DEFAULT_WORK_POLICY;
}

/**
 * How long one drain run may spend claiming new work, by who called it (AD-7).
 *
 * `command` is `brain queue drain`, which a person or launchd ran on purpose and
 * which may take its time. `opportunistic` is the run at the end of an ordinary
 * command, where the person is waiting for that command's output: two seconds is
 * enough to take one item off the queue and not enough to be noticed.
 *
 * Neither number interrupts an item that is already being processed. The budget
 * decides whether to claim another one, which is the only point at which
 * stopping is free (Boundaries).
 */
export const DRAIN_BUDGET_MS = {
  command: 30_000,
  opportunistic: 2_000,
} as const;
