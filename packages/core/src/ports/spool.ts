import type { SpoolRecord } from '../domain/spool-record.js';

/**
 * The spool port: the queue of writes the database could not take (AD-9).
 *
 * Core defines the five verbs and the rules between them and has no filesystem
 * of its own (AD-1). The one implementation is the Runtime's file spool; the
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
 *     claim will find it again. Nothing else may move a claimed file.
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
  | { ok: true; records: number; earliest: Date | null }
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
  /** How much is waiting, for `brain doctor run` (AD-9). */
  stats(): Promise<SpoolStatsResult>;
}
