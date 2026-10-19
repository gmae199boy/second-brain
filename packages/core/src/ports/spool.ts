import type { SpoolRecord } from '../domain/spool-record.js';

/**
 * The spool port: the queue of writes the database could not take (AD-9).
 *
 * Core defines the verbs and the rules between them and has no filesystem of
 * its own (AD-1). The one implementation is the Runtime's file spool; the
 * in-memory fake in `@second-brain/core/testing` is what the contract is
 * measured against, and both pass the same cases.
 *
 * Every result is a value. The spool exists for the moment the database is
 * already unreachable, so a spool that threw would turn the last place a write
 * could go into one more thing that fails.
 *
 * The rules the contract fixes:
 *
 *   * one `append` is one new file. Files are never shared, so two processes
 *     writing at the same moment cannot interleave their lines.
 *   * a file is only visible to `claim` once it is whole. Whatever the
 *     implementation does about that — the file adapter writes `<stem>.jsonl.open`
 *     and renames — a half-written file is never handed out.
 *   * `claim` hands one file to one caller. A second claim gets another file or
 *     nothing, never the same one.
 *   * `complete` removes a claimed file, `release` puts it back where a later
 *     claim will find it again, and `rewrite` replaces it with what is left of
 *     it. Nothing else may move a claimed file.
 */

/** Where one `append` put the records, so a caller can say which file. */
export type SpoolAppendResult =
  | { ok: true; file: string }
  | { ok: false; message: string };

/**
 * One file, claimed. `handle` is opaque — the caller hands it back to
 * `complete` or `release` and never takes it apart — and `lines` are the lines
 * of the file as they were written, newlines stripped.
 *
 * The lines are text and not records on purpose: decoding is Core's, and a
 * broken line is something the replay has to be able to see rather than
 * something the adapter decides about (`decodeSpoolLine`).
 */
export interface SpoolClaim {
  handle: string;
  lines: readonly string[];
}

/**
 * A claimed file, or `null` when there is nothing to claim. `null` is a value
 * and the usual answer: a brain whose database is healthy has an empty spool.
 */
export type SpoolClaimResult =
  | { ok: true; claim: SpoolClaim | null }
  | { ok: false; message: string };

/** `complete` and `release` have nothing to report but whether they worked. */
export type SpoolCompleteResult = { ok: true } | { ok: false; message: string };

export type SpoolReleaseResult = { ok: true } | { ok: false; message: string };

/**
 * What a claimed file turns into when some of its lines went in and some did
 * not (AD-9).
 *
 * `keep` are the lines a later drain has to try again — the ones that failed,
 * with their attempt counts raised — and `failed` are the ones nobody will try
 * again: a line nothing can read, or a record that has now failed ten times.
 * Both are lines and not records, because the attempt count is written by
 * re-encoding the record and the replay is what does that (`encodeSpoolLine`).
 */
export interface SpoolRewriteInput {
  keep: readonly string[];
  failed: readonly string[];
}

export type SpoolRewriteResult = { ok: true } | { ok: false; message: string };

/**
 * What is waiting: how many records, and the earliest instant among them. It
 * covers the files a claim could take *and* the claimed ones, because a record
 * somebody is in the middle of replaying has still not reached the database
 * (AD-9). Files that are still being written are not counted — they are not
 * waiting for anything yet.
 *
 * `earliest` is `null` when nothing is waiting, and also when nothing waiting
 * could be read: a count with no instant is still worth reporting.
 */
export type SpoolStatsResult =
  | {
      ok: true;
      records: number;
      earliest: Date | null;
      /**
       * Lines moved aside because nobody will try them again: a line nothing
       * could read, or a record that failed its ten attempts (AD-9).
       *
       * They are counted apart from `records` because they are not waiting for
       * anything — no drain will touch them — and they are counted at all
       * because a log entry or an injection record has no original to be read
       * again from, so the one thing that must not happen is their going
       * unnoticed (2026-10-16).
       */
      failed: number;
    }
  | { ok: false; message: string };

export interface Spool {
  /**
   * Write these records as one new file. The records are given whole — ids and
   * instants included — because the process that made them decided both and a
   * replay must not change either (AD-8, AD-9).
   *
   * A record that cannot be spelled as a line, or whose line would be over
   * `SPOOL_LINE_MAX_BYTES`, is refused and leaves no file behind: a file with
   * some of a batch in it would be a batch nobody could tell was incomplete.
   */
  append(records: readonly SpoolRecord[]): Promise<SpoolAppendResult>;
  /**
   * Take one file for this process to replay, oldest first.
   *
   * Before it looks, an implementation takes back the claims that will never
   * finish: a claim whose process is gone, or one older than
   * `SPOOL_CLAIM_STALE_MS` (AD-9). Losing a race for a file is not a failure —
   * another drain got there first, and this one carries on to the next file.
   */
  claim(): Promise<SpoolClaimResult>;
  /** The whole claimed file replayed: remove it. */
  complete(handle: string): Promise<SpoolCompleteResult>;
  /** Not replayed: put the file back, for this drain or another one to retry. */
  release(handle: string): Promise<SpoolReleaseResult>;
  /**
   * Partly replayed: write what is left as a new waiting file, put what nobody
   * will retry aside, and remove the claimed file (AD-9).
   *
   * The order is the whole of it. Both files are written *before* the claimed
   * one is removed, so a process killed in the middle leaves the claim behind —
   * which a later drain takes back and replays, idempotently (AD-8) — rather
   * than a file that was deleted with lines nothing has kept. A `keep` or
   * `failed` of no lines writes no file.
   */
  rewrite(handle: string, input: SpoolRewriteInput): Promise<SpoolRewriteResult>;
  /** How much is waiting and how much was given up on, for doctor (AD-9). */
  stats(): Promise<SpoolStatsResult>;
}
