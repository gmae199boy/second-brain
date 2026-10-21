import {
  formatInstant,
  parseInstant,
  type ListTranscriptFilesQuery,
  type ListTranscriptFilesResult,
  type RecordTranscriptFileInput,
  type RecordTranscriptFileResult,
  type TranscriptFile,
  type TranscriptFileStore,
} from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, type SqliteConnect } from './connect.js';
import type { SqliteSchema } from './driver.js';
import { withWrite } from './write.js';

/** A `transcript_files` row as SQLite hands it back: text instants (0001). */
interface TranscriptFileRow {
  id: string;
  harness: string;
  path: string;
  size_bytes: number;
  fingerprint: string;
  last_harness_message_id: string | null;
  cursor_fingerprint: string | null;
  scanned_at: string;
}

/**
 * The transcript-history capability on the local source: how far each file has
 * been read (Table Contract).
 *
 * The read takes no lock — it is what the folder scan asks before deciding
 * whether to write anything at all (AD-7) — and the record is one short write
 * transaction that reads the row and then moves it, because "only forwards" is a
 * comparison against what is stored and two statements outside a transaction
 * could be interleaved by another hook.
 */
export function sqliteTranscriptFileStore(connect: SqliteConnect): TranscriptFileStore {
  return {
    async listTranscriptFiles(
      query: ListTranscriptFilesQuery,
    ): Promise<ListTranscriptFilesResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }
      try {
        const found = await sql<TranscriptFileRow>`
          select id, harness, path, size_bytes, fingerprint, last_harness_message_id,
                 cursor_fingerprint, scanned_at
            from transcript_files
           where harness = ${query.harness}
        order by path asc
        `.execute(opened.connection.db);
        return { ok: true, files: found.rows.map(toTranscriptFile) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `트랜스크립트 내역을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async recordTranscriptFile(
      input: RecordTranscriptFileInput,
    ): Promise<RecordTranscriptFileResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      // Both halves of the cursor or neither: the table's own check says so,
      // because half a cursor is a cursor no parse could start from.
      const cursorId = input.cursor === null ? null : input.cursor.lastHarnessMessageId;
      const cursorFingerprint = input.cursor === null ? null : input.cursor.fingerprint;

      // Everything that can fail is inside the one `try`, the codec of the
      // instant on the way in and the one on the way out included: this verb is
      // called by a successful ingest for its own bookkeeping, and a throw out
      // of here would turn a collected turn into a broken one over a row
      // nothing depends on (follow-up review #19).
      try {
        const scannedAt = instant(input.scannedAt, 'transcript_files.scanned_at');
        const written = await withWrite(opened.connection, async (held) => {
          const existing = await readOne(held, input.harness, input.path);
          if (existing === null) {
            await sql`
              insert into transcript_files (id, harness, path, size_bytes, fingerprint,
                                            last_harness_message_id, cursor_fingerprint,
                                            scanned_at)
                   values (${input.id}, ${input.harness}, ${input.path}, ${input.sizeBytes},
                           ${input.fingerprint}, ${cursorId}, ${cursorFingerprint},
                           ${scannedAt})
              on conflict (harness, path) do nothing
            `.execute(held);
            return readOne(held, input.harness, input.path);
          }

          // The history only moves forward (Table Contract). A smaller size is
          // an older read finishing late, and taking it would tell the next
          // scan to re-read a stretch of file that is already stored — unless
          // the parse reset, which is the one case where the file really did
          // shrink under us.
          if (!input.reset && input.sizeBytes < existing.size_bytes) {
            return existing;
          }

          await sql`
            update transcript_files
               set size_bytes = ${input.sizeBytes},
                   fingerprint = ${input.fingerprint},
                   last_harness_message_id = ${cursorId},
                   cursor_fingerprint = ${cursorFingerprint},
                   scanned_at = ${scannedAt}
             where harness = ${input.harness} and path = ${input.path}
          `.execute(held);
          return readOne(held, input.harness, input.path);
        });
        if (!written.ok) return written;

        const row = written.value;
        if (row === null) {
          // Not reachable: this transaction holds the only writer, so the
          // insert either added the row or the lookup above found it. Here
          // because the read-back is typed as nullable and a silent `undefined`
          // further on would be worse than a sentence nobody reads.
          return {
            ok: false,
            code: 'DB_UNAVAILABLE',
            message: '트랜스크립트 내역을 기록한 뒤에도 그 행을 읽을 수 없습니다',
          };
        }
        return { ok: true, file: toTranscriptFile(row) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `트랜스크립트 내역을 기록할 수 없습니다: ${describe(error)}`,
        };
      }
    },
  };
}

/** The row for one `(harness, path)`, or `null` (Table Contract). */
async function readOne(
  held: Kysely<SqliteSchema>,
  harness: string,
  path: string,
): Promise<TranscriptFileRow | null> {
  const found = await sql<TranscriptFileRow>`
    select id, harness, path, size_bytes, fingerprint, last_harness_message_id,
           cursor_fingerprint, scanned_at
      from transcript_files
     where harness = ${harness} and path = ${path}
  `.execute(held);
  return found.rows[0] ?? null;
}

function toTranscriptFile(row: TranscriptFileRow): TranscriptFile {
  const scannedAt = parseInstant(row.scanned_at);
  if (!scannedAt.ok) {
    throw new Error(`transcript_files.scanned_at을 읽을 수 없습니다: ${scannedAt.message}`);
  }
  return {
    id: row.id,
    harness: row.harness,
    path: row.path,
    sizeBytes: row.size_bytes,
    fingerprint: row.fingerprint,
    cursor:
      row.last_harness_message_id === null || row.cursor_fingerprint === null
        ? null
        : {
            lastHarnessMessageId: row.last_harness_message_id,
            fingerprint: row.cursor_fingerprint,
          },
    scannedAt: scannedAt.value,
  };
}

/** An instant as the column holds it. A caller's bad instant is a bug. */
function instant(value: Date, column: string): string {
  const formatted = formatInstant(value);
  if (!formatted.ok) {
    throw new TypeError(`${column} cannot hold this instant: ${formatted.message}`);
  }
  return formatted.value;
}
