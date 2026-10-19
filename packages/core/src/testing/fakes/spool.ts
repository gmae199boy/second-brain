import {
  SPOOL_CLAIM_STALE_MS,
  decodeSpoolLine,
  encodeSpoolLine,
  type SpoolRecord,
} from '../../domain/spool-record.js';
import type {
  Spool,
  SpoolAppendResult,
  SpoolClaimResult,
  SpoolCompleteResult,
  SpoolReleaseResult,
  SpoolStatsResult,
} from '../../ports/spool.js';

/** 2026-01-01T00:00:00Z, so a fake with no clock is still reproducible. */
const DEFAULT_INSTANT = new Date('2026-01-01T00:00:00.000Z');

export interface MemorySpoolOptions {
  /**
   * Answer every `append` with this instead of writing. The "the spool itself
   * could not take it" row of the matrix, and the only way to reach the
   * failure branch of `spoolSessionIngest` without a filesystem.
   */
  appendFailure?: string;
  /** Answer every `claim` with this instead of handing a file over. */
  claimFailure?: string;
  /** Answer every `complete` with this instead of removing the file. */
  completeFailure?: string;
  /** Answer every `release` with this instead of putting the file back. */
  releaseFailure?: string;
  /** Answer every `stats` with this instead of counting. */
  statsFailure?: string;
  /**
   * What "now" is, for the claim times this fake records. Left out, a fixed
   * instant, which is enough for everything but the stale-claim rule.
   */
  now?: () => Date;
}

export interface MemorySpool extends Spool {
  /** Every file, in the order they were appended, for a test that looks. */
  files(): readonly MemorySpoolFile[];
  /** The records of every file that is still waiting, claimed ones included. */
  records(): readonly SpoolRecord[];
  /**
   * Make a claim look abandoned: the claim time goes back past
   * `SPOOL_CLAIM_STALE_MS`, which is what a drain that was killed leaves
   * behind. There is no pid in here to kill (AD-1), so this is how the fake
   * says the same thing.
   */
  abandonClaims(): void;
}

/** One file of the fake spool. */
export interface MemorySpoolFile {
  /** `<stem>` — unique, and ordered the way the file adapter's names are. */
  stem: string;
  lines: readonly string[];
  /** When it was claimed, or `null` while it is waiting. */
  claimedAtMs: number | null;
}

/**
 * The in-memory `Spool`: what the spool contract is measured against (AD-9).
 *
 * It has no filesystem and so no `.open` state — a file exists here only once
 * `append` has returned, which is exactly the rule the rename in the file
 * adapter exists to keep. Everything else is the same: one file per append,
 * one claim per file, `complete` removes and `release` puts back.
 */
export function memorySpool(options: MemorySpoolOptions = {}): MemorySpool {
  const {
    appendFailure,
    claimFailure,
    completeFailure,
    releaseFailure,
    statsFailure,
    now = () => DEFAULT_INSTANT,
  } = options;

  const files: MemorySpoolFile[] = [];
  let serial = 0;

  /** The handle a claimed file answers to, built the way a file name is. */
  const handleOf = (file: MemorySpoolFile): string => `${file.stem}.claiming`;

  const find = (handle: string): MemorySpoolFile | undefined =>
    files.find((file) => handleOf(file) === handle && file.claimedAtMs !== null);

  return {
    async append(records: readonly SpoolRecord[]): Promise<SpoolAppendResult> {
      if (appendFailure !== undefined) return { ok: false, message: appendFailure };
      // A file of no lines is a file a claim would hand over with nothing in
      // it, and that `stats` would not count: there is no such thing as an
      // empty write waiting.
      if (records.length === 0) {
        return { ok: false, message: 'spool에 쓸 레코드가 없습니다' };
      }

      // Every line first, so a record nothing can spell leaves no file behind:
      // half a batch in a file is a batch nobody can tell is incomplete.
      const lines: string[] = [];
      for (const record of records) {
        const encoded = encodeSpoolLine(record);
        if (!encoded.ok) return { ok: false, message: encoded.message };
        lines.push(encoded.line.replace(/\n$/, ''));
      }

      const stem = `${String(serial).padStart(6, '0')}`;
      serial += 1;
      files.push({ stem, lines, claimedAtMs: null });
      return { ok: true, file: `${stem}.jsonl` };
    },

    async claim(): Promise<SpoolClaimResult> {
      if (claimFailure !== undefined) return { ok: false, message: claimFailure };

      // The claims nothing will ever finish go back first, same as the file
      // adapter's (AD-9). There is no process to ask about here, so age is the
      // whole of the rule.
      const nowMs = now().getTime();
      for (const file of files) {
        if (file.claimedAtMs !== null && nowMs - file.claimedAtMs >= SPOOL_CLAIM_STALE_MS) {
          file.claimedAtMs = null;
        }
      }

      const waiting = files.find((file) => file.claimedAtMs === null);
      if (waiting === undefined) return { ok: true, claim: null };
      waiting.claimedAtMs = nowMs;
      return { ok: true, claim: { handle: handleOf(waiting), lines: [...waiting.lines] } };
    },

    async complete(handle: string): Promise<SpoolCompleteResult> {
      if (completeFailure !== undefined) return { ok: false, message: completeFailure };
      const file = find(handle);
      // Already gone is done, as it is for the file adapter: a drain whose
      // claim went stale, was taken back and was completed by somebody else
      // has nothing left to remove, and that is not a problem to report.
      if (file === undefined) return { ok: true };
      files.splice(files.indexOf(file), 1);
      return { ok: true };
    },

    async release(handle: string): Promise<SpoolReleaseResult> {
      if (releaseFailure !== undefined) return { ok: false, message: releaseFailure };
      const file = find(handle);
      if (file === undefined) {
        return { ok: false, message: `claim한 spool 파일이 아닙니다: ${handle}` };
      }
      file.claimedAtMs = null;
      return { ok: true };
    },

    async stats(): Promise<SpoolStatsResult> {
      if (statsFailure !== undefined) return { ok: false, message: statsFailure };
      const records = decoded(files);
      const earliest = records.reduce<Date | null>(
        (oldest, record) =>
          oldest === null || record.occurredAt.getTime() < oldest.getTime()
            ? record.occurredAt
            : oldest,
        null,
      );
      return {
        ok: true,
        records: files.reduce((total, file) => total + file.lines.length, 0),
        earliest,
      };
    },

    files: () => files.map((file) => ({ ...file, lines: [...file.lines] })),
    records: () => decoded(files),
    abandonClaims: () => {
      for (const file of files) {
        if (file.claimedAtMs !== null) file.claimedAtMs -= SPOOL_CLAIM_STALE_MS;
      }
    },
  };
}

/**
 * Every readable record of these files, for the two inspectors above. The fake
 * only ever holds lines it encoded itself, so a line that does not decode is a
 * bug in the codec rather than a state worth reporting from here.
 */
function decoded(files: readonly MemorySpoolFile[]): SpoolRecord[] {
  const records: SpoolRecord[] = [];
  for (const file of files) {
    for (const line of file.lines) {
      const parsed = decodeSpoolLine(line);
      if (parsed.ok) records.push(parsed.record);
    }
  }
  return records;
}
