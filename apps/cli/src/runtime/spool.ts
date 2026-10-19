import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SPOOL_CLAIM_STALE_MS,
  decodeSpoolLine,
  encodeSpoolLine,
  type Clock,
  type Spool,
  type SpoolAppendResult,
  type SpoolClaimResult,
  type SpoolCompleteResult,
  type SpoolRecord,
  type SpoolReleaseResult,
  type SpoolStatsResult,
} from 'second_brain';

/**
 * The Runtime's `Spool`: the queue of writes the database could not take, as
 * files in `<home>/spool/` (AD-9).
 *
 * The whole design is in the names, because the names are the only thing two
 * processes share. There is no lock and no index:
 *
 *   * `<stem>.jsonl.open` is being written. Nothing reads it, ever.
 *   * `<stem>.jsonl` is whole and waiting. A rename makes it so, and rename is
 *     atomic, so a reader never sees half a file.
 *   * `<stem>.<pid>-<claim ms>.claiming` is being replayed by that pid. Only a
 *     rename can create it, and a rename of a name that is already gone fails
 *     with `ENOENT` — which is how two drains racing for one file settle it
 *     without either of them knowing about the other.
 *
 * `<stem>` is `<compact occurred_at>-<pid>-<serial>`, so the name order is the
 * time order, and two processes can never choose the same one. The serial is
 * this process's own count, which is what keeps two appends in the same
 * millisecond apart.
 *
 * Nothing in here invents a value. The records arrive whole from Core and the
 * lines come out of Core's codec: `occurred_at` and `id` belong to the process
 * that first made the record, and a replay must not change either (AD-9).
 */

export interface FileSpoolOptions {
  /** The folder. Created on the first `append`, never at construction (AD-3). */
  folder: string;
  /** The one clock. The claim time in a `.claiming` name comes from it (AD-13). */
  clock: Clock;
  /** This process's id, for the file names. Defaults to the real one. */
  pid?: number;
  /**
   * Whether a process is still running, for taking back claims nobody will
   * finish. Injected because the interesting case — a drain that was killed —
   * cannot be arranged from inside the test process.
   */
  isAlive?: (pid: number) => boolean;
}

/** What a `.jsonl` or `.claiming` name was found to be. */
interface SpoolFile {
  /** The name as it is on disk right now. */
  name: string;
  /** `<stem>`, which is the name a release goes back to. */
  stem: string;
  /** The claim, when this is a `.claiming` file. */
  claim?: { pid: number; atMs: number };
}

const OPEN_SUFFIX = '.jsonl.open';
const READY_SUFFIX = '.jsonl';
const CLAIMING_SUFFIX = '.claiming';

/**
 * This process's own count, so two appends in one millisecond get different
 * names. It is module-wide and not per `fileSpool`, because one process builds
 * more than one of them over the same folder — the dispatcher's, for the SDK,
 * and the one the `spool` doctor check reports on — and two counters starting
 * at zero would mint the same stem for two different writes. The rename that
 * publishes the second file would then replace the first, and a write would be
 * lost with both appends answering ok.
 */
let serial = 0;

export function fileSpool(options: FileSpoolOptions): Spool {
  const { folder, clock } = options;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? systemIsAlive;

  const spool: Spool = {
    async append(records: readonly SpoolRecord[]): Promise<SpoolAppendResult> {
      if (records.length === 0) {
        return { ok: false, message: 'spool에 쓸 레코드가 없습니다' };
      }

      // Every line before any file exists, so a record nothing can spell
      // leaves nothing behind (AD-9, port contract).
      const lines: string[] = [];
      for (const record of records) {
        const encoded = encodeSpoolLine(record);
        if (!encoded.ok) return { ok: false, message: encoded.message };
        lines.push(encoded.line);
      }

      const first = records[0];
      if (first === undefined) {
        return { ok: false, message: 'spool에 쓸 레코드가 없습니다' };
      }
      const stem = `${compactInstant(first.occurredAt)}-${String(pid)}-${String(serial)}`;
      serial += 1;
      const open = join(folder, `${stem}${OPEN_SUFFIX}`);
      const ready = join(folder, `${stem}${READY_SUFFIX}`);

      try {
        // The folder is made here and not at construction: importing this
        // module must do no I/O (AD-3), and a brain whose database is healthy
        // never has a spool folder at all.
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(open, lines.join(''), { encoding: 'utf8', mode: 0o600 });
        // Only now is the file something a drain may take.
        await rename(open, ready);
      } catch (error) {
        // Whatever is left of the attempt goes away: a `.open` file nothing
        // will finish is litter, and the one thing that must not happen is a
        // half-written file under a name a drain reads.
        await unlink(open).catch(() => undefined);
        return { ok: false, message: `spool에 쓸 수 없습니다: ${describe(error)}` };
      }

      return { ok: true, file: ready };
    },

    async claim(): Promise<SpoolClaimResult> {
      const listed = await list(folder);
      if (!listed.ok) return listed;

      // The claims nobody will finish go back first, so the loop below can see
      // them (AD-9). A reclaim that loses a race is not a failure: somebody
      // else got there, and the file is claimed either way.
      const nowMs = clock.now().getTime();
      for (const file of listed.files) {
        if (file.claim === undefined) continue;
        const dead = !isAlive(file.claim.pid);
        const stale = nowMs - file.claim.atMs >= SPOOL_CLAIM_STALE_MS;
        if (!dead && !stale) continue;
        await rename(join(folder, file.name), join(folder, `${file.stem}${READY_SUFFIX}`)).catch(
          () => undefined,
        );
      }

      // Listed again, because the pass above may have put files back, and
      // oldest first by name — which is oldest by time, since a stem starts
      // with the instant of the first record in the file.
      const after = await list(folder);
      if (!after.ok) return after;

      for (const file of after.files.filter((candidate) => candidate.claim === undefined)) {
        const claimed = join(folder, `${file.stem}.${String(pid)}-${String(nowMs)}${CLAIMING_SUFFIX}`);
        try {
          await rename(join(folder, file.name), claimed);
        } catch (error) {
          // Gone: another drain claimed or completed it between the listing
          // and the rename. Not a failure — the next file is this one's job.
          if (isMissing(error)) continue;
          return { ok: false, message: `spool 파일을 claim할 수 없습니다: ${describe(error)}` };
        }

        let text: string;
        try {
          text = await readFile(claimed, 'utf8');
        } catch (error) {
          // The file is claimed and cannot be read. Putting it back is the
          // only honest move: this drain cannot replay it, and leaving it
          // claimed would hide it until the stale rule came round.
          await rename(claimed, join(folder, `${file.stem}${READY_SUFFIX}`)).catch(() => undefined);
          return { ok: false, message: `spool 파일을 읽을 수 없습니다: ${describe(error)}` };
        }
        return { ok: true, claim: { handle: claimed, lines: splitLines(text) } };
      }

      return { ok: true, claim: null };
    },

    async complete(handle: string): Promise<SpoolCompleteResult> {
      try {
        await unlink(handle);
        return { ok: true };
      } catch (error) {
        // Already gone is done: a drain whose claim went stale and was
        // reclaimed, then completed by somebody else, has nothing to remove.
        if (isMissing(error)) return { ok: true };
        return { ok: false, message: `spool 파일을 지울 수 없습니다: ${describe(error)}` };
      }
    },

    async release(handle: string): Promise<SpoolReleaseResult> {
      const parsed = parseName(basename(handle));
      if (parsed?.claim === undefined) {
        return { ok: false, message: `claim한 spool 파일 이름이 아닙니다: ${handle}` };
      }
      try {
        await rename(handle, join(folder, `${parsed.stem}${READY_SUFFIX}`));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: `spool 파일을 되돌릴 수 없습니다: ${describe(error)}` };
      }
    },

    async stats(): Promise<SpoolStatsResult> {
      const listed = await list(folder);
      if (!listed.ok) return listed;

      let records = 0;
      let earliest: Date | null = null;
      for (const file of listed.files) {
        let text: string;
        try {
          text = await readFile(join(folder, file.name), 'utf8');
        } catch (error) {
          // A file another drain completed between the listing and this read
          // is not something waiting; anything else is worth reporting.
          if (isMissing(error)) continue;
          return { ok: false, message: `spool 파일을 읽을 수 없습니다: ${describe(error)}` };
        }
        for (const line of splitLines(text)) {
          records += 1;
          const decoded = decodeSpoolLine(line);
          // A line nothing can read is still a record waiting — it is counted,
          // and it just has no instant to compare. Reporting a count with no
          // instant says more than refusing to report either (NFR-2).
          if (!decoded.ok) continue;
          const at = decoded.record.occurredAt;
          if (earliest === null || at.getTime() < earliest.getTime()) earliest = at;
        }
      }
      return { ok: true, records, earliest };
    },
  };
  return spool;
}

/**
 * Every file of the spool that is waiting or claimed, oldest name first.
 * `.open` files are left out: they are being written, and nothing but the
 * process writing one may touch it.
 *
 * A folder that is not there is an empty spool and not a failure — a brain
 * whose database has always been reachable never made one.
 */
async function list(
  folder: string,
): Promise<{ ok: true; files: SpoolFile[] } | { ok: false; message: string }> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (isMissing(error)) return { ok: true, files: [] };
    return { ok: false, message: `spool 폴더를 읽을 수 없습니다: ${describe(error)}` };
  }

  const files = names
    .map((name) => parseName(name))
    .filter((file): file is SpoolFile => file !== undefined)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { ok: true, files };
}

/**
 * What one name in the spool folder is, or `undefined` for a name this spool
 * did not write — a `.open` file, an editor's backup, a folder.
 *
 * A stem never contains a `.` (the compact instant has none and neither do a
 * pid or a serial), so splitting on it is exact: two parts is a waiting file
 * and three is a claimed one.
 */
function parseName(name: string): SpoolFile | undefined {
  if (name.endsWith(OPEN_SUFFIX)) return undefined;

  if (name.endsWith(READY_SUFFIX)) {
    const stem = name.slice(0, -READY_SUFFIX.length);
    return stem === '' || stem.includes('.') ? undefined : { name, stem };
  }

  if (name.endsWith(CLAIMING_SUFFIX)) {
    const body = name.slice(0, -CLAIMING_SUFFIX.length);
    const dot = body.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const stem = body.slice(0, dot);
    const claim = body.slice(dot + 1);
    if (stem.includes('.')) return undefined;
    const matched = /^(\d+)-(\d+)$/.exec(claim);
    const [, pid, atMs] = matched ?? [];
    if (pid === undefined || atMs === undefined) return undefined;
    return { name, stem, claim: { pid: Number(pid), atMs: Number(atMs) } };
  }

  return undefined;
}

/**
 * `2026-01-02T03:04:05.678Z` as `20260102T030405678Z`: the canonical instant
 * with the separators taken out, so the name sorts the way the instant does
 * and carries no character a filesystem argues about.
 */
function compactInstant(instant: Date): string {
  return instant.toISOString().replace(/[-:.]/g, '');
}

/** The lines of one file, with the trailing newline of the last one dropped. */
function splitLines(text: string): string[] {
  return text.split('\n').filter((line) => line !== '');
}

/** The last segment of a path, without pulling in `basename`'s whole module. */
function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/** Whether a process is still there. EPERM is a process this user may not signal. */
function systemIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

/** Whether the filesystem said "there is nothing at that name". */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ENOENT';
}

/** Whatever went wrong, in one non-empty line (Conventions: no silent failure). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [oneLine(error.message), typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}

function oneLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
