import {
  checkExtractionChunkBatch,
  decodeChunkLocator,
  formatInstant,
  parseInstant,
  type AppendExtractionChunksInput,
  type AppendExtractionChunksResult,
  type BeginExtractionInput,
  type BeginExtractionResult,
  type ChunkLocator,
  type DocumentChunk,
  type DocumentExtraction,
  type DocumentExtractionFailedStage,
  type DocumentExtractionStatus,
  type ExtractionStore,
  type FinishExtractionInput,
  type FinishExtractionResult,
  type ListExtractionChunksResult,
  type ListExtractionsResult,
  type ListFilesAwaitingExtractionResult,
  type ListFilesWithStaleExtractionResult,
  type ReadFileExtractionStateResult,
  type SetFileSourceUnreachableInput,
  type SetFileSourceUnreachableResult,
} from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, type SqliteConnect } from './connect.js';
import type { SqliteSchema } from './driver.js';
import { withWrite } from './write.js';

/**
 * The extraction capability on the local source: one reading of one file, in
 * pieces, with the file's pointer moved only by a reading that earned it
 * (AD-24).
 *
 * Three things in here are worth reading twice.
 *
 * The order of the statements is load bearing. 0008's
 * `document_chunks_delete_rule` refuses a delete from a generation that is open
 * or current, so a successful replacement closes its own generation, *then*
 * moves `files.current_extraction_id`, *then* deletes the older generations'
 * pieces, *then* their rows — and a reading that did not succeed closes itself
 * before deleting its own pieces. Reordering any of that turns a commit into a
 * raised `abort`. The redaction marker is never raised here: taking text away
 * because it is secret is `messages.redact`'s business (AD-11).
 *
 * The claim is checked in `beginExtraction` and nowhere else. `work_items`'
 * open-row key is `(kind, target)`, so one file has one extraction claim at a
 * time; whoever holds it is the only live reader, and an open generation it
 * finds belongs to a claim that expired. The expired worker's late write is
 * stopped by its generation being closed, which is a cheaper question than a
 * second claim lookup and a truer one — it is the generation, not the claim,
 * that the late write would damage (Design Notes).
 *
 * Every write is one `BEGIN IMMEDIATE`, and a lock it could not take comes back
 * as `DB_LOCKED` (AD-7, AD-9). Anything else a write hits throws, after the
 * rollback, the way `linkAttachments` does: a statement the schema refused is a
 * bug in this file and not a state the caller can do anything with.
 */

/** A `document_extractions` row as SQLite hands it back: text instants. */
interface ExtractionRow {
  id: string;
  file_id: string;
  extractor_version: string;
  attempt: number;
  media_type: string | null;
  status: DocumentExtractionStatus | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  failed_stage: DocumentExtractionFailedStage | null;
  index_config_id: string | null;
}

/** A `document_chunks` row. `chunk_locator` is null only before 0004. */
interface ChunkRow {
  id: string;
  extraction_id: string;
  ordinal: number;
  page: number | null;
  body: string;
  chunk_locator: string | null;
}

/**
 * The generation's columns, once. Spelled in one place because four queries
 * select them and a list that drifted in one of them would be a row this file
 * reads differently depending on which verb asked.
 */
const EXTRACTION_COLUMNS = sql`id, file_id, extractor_version, attempt, media_type, status,
                               started_at, finished_at, error, failed_stage, index_config_id`;

/**
 * The `from` and `where` of "this file's stored reading is not the one this
 * build would make", for the two statements of
 * `listFilesWithStaleExtraction`.
 *
 * It is one fragment because the ids and the counts have to be about the same
 * set: a predicate that drifted in one of them would be a report contradicting
 * itself — files queued that the counts say were skipped, or the other way
 * round. It ends *inside* the `where`, so a caller adds its own `and …`.
 *
 * Both halves matter. The current pointer has to name a successful reading of
 * some other version, because `unsupported` and `too_large` are answers a
 * version bump does not change and only a success ever becomes current
 * (AD-24). And no generation of the asked-for version may exist at all,
 * whatever it says: without that, a re-reading that fails permanently is
 * queued again on every drain for ever.
 */
function behindPredicate(extractorVersion: string): ReturnType<typeof sql> {
  return sql`
      from files f
     where exists (
             select 1 from document_extractions c
              where c.id = f.current_extraction_id
                and c.status = 'ok'
                and c.extractor_version <> ${extractorVersion}
           )
       and not exists (
             select 1 from document_extractions e
              where e.file_id = f.id and e.extractor_version = ${extractorVersion}
           )
  `;
}

/**
 * What a generation closed by a later `beginExtraction` says about itself.
 *
 * It names the new begin rather than an expired claim: closing the leftovers is
 * what every begin does, and the usual reason there are leftovers — a claim that
 * ran out — is not the only one. A worker that begins twice under its own live
 * claim closes its first generation here too, and a sentence saying its claim
 * had expired would be a false sentence stored as a fact (AD-24).
 */
const STALE_EXTRACTION_ERROR = '새 begin이 열려 있던 이 세대를 닫았습니다';

export function sqliteExtractionStore(connect: SqliteConnect): ExtractionStore {
  return {
    async beginExtraction(input: BeginExtractionInput): Promise<BeginExtractionResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const startedAt = instant(input.startedAt, 'document_extractions.started_at');

      const written = await withWrite(opened.connection, async (db) => {
        const file = (
          await sql<{ redacted_at: string | null }>`
            select redacted_at from files where id = ${input.fileId}
          `.execute(db)
        ).rows[0];
        if (file === undefined) {
          return { ok: false as const, code: 'FILE_NOT_FOUND' as const, message: '파일이 없습니다' };
        }
        if (file.redacted_at !== null) {
          return {
            ok: false as const,
            code: 'FILE_REDACTED' as const,
            message: '가린 파일은 다시 읽지 않습니다',
          };
        }

        // The claim, as the four columns it is made of: still open, this file's,
        // this caller's, and not yet expired at the moment this reading begins.
        const claim = (
          await sql<{ id: string }>`
            select id from work_items
             where id = ${input.claim.workItemId}
               and completed_at is null
               and target_kind = 'file'
               and target_id = ${input.fileId}
               and claimed_by = ${input.claim.claimedBy}
               and claim_expires_at is not null
               and claim_expires_at > ${startedAt}
          `.execute(db)
        ).rows[0];
        if (claim === undefined) {
          return {
            ok: false as const,
            code: 'CLAIM_LOST' as const,
            message: '추출 청구가 더 이상 이 호출자의 것이 아닙니다',
          };
        }

        let closedStale: DocumentExtraction | null = null;
        const stale = (
          await sql<ExtractionRow>`
            select ${EXTRACTION_COLUMNS} from document_extractions
             where file_id = ${input.fileId} and finished_at is null
          `.execute(db)
        ).rows[0];
        if (stale !== undefined) {
          // Read before the pieces go, because the pieces are what the stage is
          // read from — and they are the only thing it can be read from, since
          // nothing writes `media_type` before a generation is closed. So the
          // guess is two-way: pieces mean it was indexing them, and no pieces
          // mean it never got that far (Design Notes).
          const pieces =
            (
              await sql<{ n: number }>`
                select count(*) as n from document_chunks where extraction_id = ${stale.id}
              `.execute(db)
            ).rows[0]?.n ?? 0;
          const failedStage: DocumentExtractionFailedStage = pieces > 0 ? 'index' : 'read';
          await sql`
            update document_extractions
               set status = 'failed', finished_at = ${startedAt},
                   error = ${STALE_EXTRACTION_ERROR}, failed_stage = ${failedStage}
             where id = ${stale.id} and finished_at is null
          `.execute(db);
          // Closed first, then its pieces: `document_chunks_delete_rule` would
          // refuse the delete while the generation was still open.
          await sql`delete from document_chunks where extraction_id = ${stale.id}`.execute(db);
          closedStale = toExtraction(await readExtraction(db, stale.id, '닫은 옛 세대'));
        }

        const highest =
          (
            await sql<{ m: number | null }>`
              select max(attempt) as m from document_extractions where file_id = ${input.fileId}
            `.execute(db)
          ).rows[0]?.m ?? null;
        await sql`
          insert into document_extractions (id, file_id, extractor_version, attempt, started_at)
               values (${input.id}, ${input.fileId}, ${input.extractorVersion},
                       ${(highest ?? 0) + 1}, ${startedAt})
        `.execute(db);
        return {
          ok: true as const,
          extraction: toExtraction(await readExtraction(db, input.id, '새 세대')),
          closedStale,
        };
      });
      return written.ok ? written.value : written;
    },

    async appendExtractionChunks(
      input: AppendExtractionChunksInput,
    ): Promise<AppendExtractionChunksResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };

      const written = await withWrite(opened.connection, async (db) => {
        const row = (
          await sql<{ finished_at: string | null; redacted_at: string | null }>`
            select e.finished_at, f.redacted_at
              from document_extractions e join files f on f.id = e.file_id
             where e.id = ${input.extractionId}
          `.execute(db)
        ).rows[0];
        if (row === undefined) {
          return {
            ok: false as const,
            code: 'EXTRACTION_NOT_FOUND' as const,
            message: '추출 세대가 없습니다',
          };
        }
        if (row.finished_at !== null) {
          return {
            ok: false as const,
            code: 'EXTRACTION_CLOSED' as const,
            message: '추출 세대가 이미 닫혔습니다',
          };
        }
        if (row.redacted_at !== null) {
          return {
            ok: false as const,
            code: 'FILE_REDACTED' as const,
            message: '가린 파일의 조각은 쓰지 않습니다',
          };
        }

        const held = (
          await sql<{ id: string; ordinal: number }>`
            select id, ordinal from document_chunks where extraction_id = ${input.extractionId}
          `.execute(db)
        ).rows;
        // The one list of rules, shared with every other adapter and with the
        // fake, so none of them can drift on what a valid piece is.
        const checked = checkExtractionChunkBatch(input.chunks, {
          ordinals: new Set(held.map((row) => row.ordinal)),
          ids: new Set(held.map((row) => row.id)),
        });
        if (!checked.ok) return checked;

        // One statement for the whole batch, which is what keeps the bound of
        // `DOCUMENT_CHUNK_BATCH_MAX` a bound on one short transaction rather
        // than on two hundred round trips. The FTS triggers of 0002 still run
        // per row, inside this transaction.
        const rows = sql.join(
          checked.chunks.map(
            (chunk) =>
              sql`(${chunk.id}, ${input.extractionId}, ${chunk.ordinal}, ${chunk.page},
                   ${chunk.body}, ${chunk.text})`,
          ),
        );
        await sql`
          insert into document_chunks (id, extraction_id, ordinal, page, body, chunk_locator)
               values ${rows}
        `.execute(db);
        return { ok: true as const, appended: checked.chunks.length };
      });
      return written.ok ? written.value : written;
    },

    async finishExtraction(input: FinishExtractionInput): Promise<FinishExtractionResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const finishedAt = instant(input.finishedAt, 'document_extractions.finished_at');

      const written = await withWrite(opened.connection, async (db) => {
        const row = (
          await sql<{
            id: string;
            file_id: string;
            attempt: number;
            finished_at: string | null;
            redacted_at: string | null;
            current_extraction_id: string | null;
          }>`
            select e.id, e.file_id, e.attempt, e.finished_at,
                   f.redacted_at, f.current_extraction_id
              from document_extractions e join files f on f.id = e.file_id
             where e.id = ${input.extractionId}
          `.execute(db)
        ).rows[0];
        if (row === undefined) {
          return {
            ok: false as const,
            code: 'EXTRACTION_NOT_FOUND' as const,
            message: '추출 세대가 없습니다',
          };
        }
        if (row.finished_at !== null) {
          // An attempt whose claim is long gone, answering late. Nothing moves.
          return {
            ok: false as const,
            code: 'EXTRACTION_CLOSED' as const,
            message: '추출 세대가 이미 닫혔습니다',
          };
        }

        const { outcome } = input;
        const redacted = row.redacted_at !== null;
        const currentAttempt =
          row.current_extraction_id === null
            ? 0
            : ((
                await sql<{ attempt: number }>`
                  select attempt from document_extractions where id = ${row.current_extraction_id}
                `.execute(db)
              ).rows[0]?.attempt ?? 0);
        // The pointer moves only forward, and never onto a reading of a file
        // somebody has redacted (AD-24).
        const replaces = outcome.status === 'ok' && !redacted && row.attempt > currentAttempt;
        // A successful reading of a file that was redacted while it ran is a
        // reading whose text may not be kept, and `redacted` is the status that
        // says so (migration 0002's check).
        const status: DocumentExtractionStatus =
          outcome.status === 'ok' && redacted ? 'redacted' : outcome.status;

        await sql`
          update document_extractions
             set status = ${status}, finished_at = ${finishedAt},
                 media_type = ${outcome.mediaType},
                 error = ${outcome.status === 'ok' ? null : outcome.error},
                 failed_stage = ${outcome.status === 'failed' ? outcome.failedStage : null},
                 index_config_id = ${outcome.status === 'ok' && replaces ? outcome.indexConfigId : null}
           where id = ${row.id} and finished_at is null
        `.execute(db);

        if (replaces) {
          await sql`
            update files set current_extraction_id = ${row.id} where id = ${row.file_id}
          `.execute(db);
          // Now that this generation is the current one, every other closed
          // generation of the file is neither open nor current, which is exactly
          // what `document_chunks_delete_rule` asks for. The rows follow their
          // pieces, because the foreign key points that way.
          await sql`
            delete from document_chunks
             where extraction_id in (select id from document_extractions
                                      where file_id = ${row.file_id}
                                        and id <> ${row.id}
                                        and finished_at is not null)
          `.execute(db);
          await sql`
            delete from document_extractions
             where file_id = ${row.file_id} and id <> ${row.id} and finished_at is not null
          `.execute(db);
        } else {
          // A reading that did not take over leaves no text behind, whatever it
          // had written before it stopped.
          await sql`delete from document_chunks where extraction_id = ${row.id}`.execute(db);
        }

        return {
          ok: true as const,
          extraction: toExtraction(await readExtraction(db, row.id, '닫은 세대')),
          current: replaces,
        };
      });
      return written.ok ? written.value : written;
    },

    async setFileSourceUnreachable(
      input: SetFileSourceUnreachableInput,
    ): Promise<SetFileSourceUnreachableResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const unreachableAt =
        input.unreachableAt === null
          ? null
          : instant(input.unreachableAt, 'files.source_unreachable_at');

      const written = await withWrite(opened.connection, async (db) => {
        // One column, and no generation, chunk or pointer touched: the pieces
        // already extracted keep answering searches (AD-24).
        const result = await sql`
          update files set source_unreachable_at = ${unreachableAt} where id = ${input.fileId}
        `.execute(db);
        if (Number(result.numAffectedRows ?? 0n) === 0) {
          return { ok: false as const, code: 'FILE_NOT_FOUND' as const, message: '파일이 없습니다' };
        }
        return { ok: true as const };
      });
      return written.ok ? written.value : written;
    },

    async readFileExtractionState(fileId: string): Promise<ReadFileExtractionStateResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const { db } = opened.connection;
        // `file_locations` is joined in rather than read after, because the home
        // location is part of one answer: a worker that got the state and then
        // the location could be told about a file whose home arrived in
        // between, and the port says this is one lock-free read (AD-7).
        const file = (
          await sql<{
            content_hash: string;
            size_bytes: number;
            store_kind: 'local' | 'drive' | null;
            locator: string | null;
            ownership: 'brain' | 'external' | null;
            redacted_at: string | null;
            source_unreachable_at: string | null;
            current_extraction_id: string | null;
          }>`
            select f.content_hash, f.size_bytes,
                   l.store_kind, l.locator, l.ownership,
                   f.redacted_at, f.source_unreachable_at, f.current_extraction_id
              from files f left join file_locations l on l.id = f.home_location_id
             where f.id = ${fileId}
          `.execute(db)
        ).rows[0];
        if (file === undefined) {
          return { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' };
        }
        const open = (
          await sql<ExtractionRow>`
            select ${EXTRACTION_COLUMNS} from document_extractions
             where file_id = ${fileId} and finished_at is null
          `.execute(db)
        ).rows[0];
        const highest = (
          await sql<{ m: number | null }>`
            select max(attempt) as m from document_extractions where file_id = ${fileId}
          `.execute(db)
        ).rows[0];
        return {
          ok: true,
          fileId,
          contentHash: file.content_hash,
          sizeBytes: file.size_bytes,
          home:
            file.store_kind === null || file.locator === null || file.ownership === null
              ? null
              : { storeKind: file.store_kind, locator: file.locator, ownership: file.ownership },
          redactedAt: file.redacted_at === null ? null : at(file.redacted_at, 'files.redacted_at'),
          sourceUnreachableAt:
            file.source_unreachable_at === null
              ? null
              : at(file.source_unreachable_at, 'files.source_unreachable_at'),
          currentExtractionId: file.current_extraction_id,
          openExtraction: open === undefined ? null : toExtraction(open),
          lastAttempt: highest?.m ?? 0,
        };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `파일의 추출 상태를 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async listFilesAwaitingExtraction({
      limit,
    }: {
      limit: number;
    }): Promise<ListFilesAwaitingExtractionResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        // A lock-free read, shaped like `listMissingFileNames`: the drain asks
        // this before it takes any write lock, and a brain with nothing new
        // attached must not queue behind whatever is writing (AD-7).
        //
        // `not exists` and not "no successful generation": a file whose only
        // reading answered `unsupported` or `too_large` has been read, and
        // asking again would be the same work every drain for ever. The row of
        // a reading that failed is swept away by the next success (AD-24), and
        // until then it is what keeps the file out of here.
        const rows = await sql<{ id: string }>`
          select f.id from files f
           where f.home_location_id is not null
             and f.redacted_at is null
             and f.source_unreachable_at is null
             and not exists (select 1 from document_extractions e where e.file_id = f.id)
           order by f.id limit ${limit}
        `.execute(opened.connection.db);
        return { ok: true, fileIds: rows.rows.map((row) => row.id) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `추출을 기다리는 파일을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async listFilesWithStaleExtraction({
      extractorVersion,
      limit,
    }: {
      extractorVersion: string;
      limit: number;
    }): Promise<ListFilesWithStaleExtractionResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const { db } = opened.connection;
        // Two reads of the same predicate and no lock, for the same reason the
        // list above takes none: the drain asks before it takes any write lock
        // (AD-7). They are two statements and not one because the counts are
        // over the whole set and the ids are bounded by `limit` — one statement
        // would have had to read every behind file into memory to count them.
        const behind = behindPredicate(extractorVersion);
        const rows = await sql<{ id: string }>`
          select f.id ${behind}
             and f.home_location_id is not null
             and f.redacted_at is null
             and f.source_unreachable_at is null
           order by f.id limit ${limit}
        `.execute(db);
        const counted = (
          await sql<{ redacted: number; unreachable: number }>`
            select
              coalesce(sum(case when f.redacted_at is not null then 1 else 0 end), 0) as redacted,
              coalesce(sum(case when f.redacted_at is null
                             and f.source_unreachable_at is not null then 1 else 0 end), 0)
                as unreachable
            ${behind}
          `.execute(db)
        ).rows[0];
        return {
          ok: true,
          fileIds: rows.rows.map((row) => row.id),
          redacted: Number(counted?.redacted ?? 0),
          sourceUnreachable: Number(counted?.unreachable ?? 0),
        };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `추출기 버전이 뒤처진 파일을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async listExtractions(fileId: string): Promise<ListExtractionsResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = await sql<ExtractionRow>`
          select ${EXTRACTION_COLUMNS} from document_extractions
           where file_id = ${fileId} order by attempt
        `.execute(opened.connection.db);
        return { ok: true, extractions: rows.rows.map(toExtraction) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `추출 세대를 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async listExtractionChunks(extractionId: string): Promise<ListExtractionChunksResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = await sql<ChunkRow>`
          select id, extraction_id, ordinal, page, body, chunk_locator
            from document_chunks where extraction_id = ${extractionId} order by ordinal
        `.execute(opened.connection.db);
        return { ok: true, chunks: rows.rows.map(toChunk) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `추출 조각을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },
  };
}

/**
 * One generation back from the database, as the truth rather than as what was
 * just written. A row that is not there after its own insert or update is this
 * file being wrong about the schema, which is a throw and not a code.
 */
async function readExtraction(
  db: Kysely<SqliteSchema>,
  id: string,
  what: string,
): Promise<ExtractionRow> {
  const row = (
    await sql<ExtractionRow>`
      select ${EXTRACTION_COLUMNS} from document_extractions where id = ${id}
    `.execute(db)
  ).rows[0];
  if (row === undefined) throw new Error(`${what}를 쓴 뒤에도 그 행을 읽을 수 없습니다: ${id}`);
  return row;
}

function toExtraction(row: ExtractionRow): DocumentExtraction {
  return {
    id: row.id,
    fileId: row.file_id,
    extractorVersion: row.extractor_version,
    attempt: row.attempt,
    mediaType: row.media_type,
    status: row.status,
    startedAt: at(row.started_at, 'document_extractions.started_at'),
    finishedAt:
      row.finished_at === null ? null : at(row.finished_at, 'document_extractions.finished_at'),
    error: row.error,
    failedStage: row.failed_stage,
    indexConfigId: row.index_config_id,
  };
}

/**
 * One piece back, with its position decoded. Only the canonical spelling is
 * taken: a non-null locator this codec cannot read was not written by this
 * codec, and the read says so rather than handing back a position it guessed
 * (`chunk-locator.ts`). A null is a row from before migration 0004.
 */
function toChunk(row: ChunkRow): DocumentChunk {
  let chunkLocator: ChunkLocator | null = null;
  if (row.chunk_locator !== null) {
    const decoded = decodeChunkLocator(row.chunk_locator);
    if (!decoded.ok) {
      throw new Error(`document_chunks.chunk_locator를 읽을 수 없습니다: ${decoded.message}`);
    }
    chunkLocator = decoded.locator;
  }
  return {
    id: row.id,
    extractionId: row.extraction_id,
    ordinal: row.ordinal,
    page: row.page,
    body: row.body,
    chunkLocator,
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

/** The other direction. A row holding anything else was not written by us. */
function at(value: string, column: string): Date {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(`${column}을 읽을 수 없습니다: ${parsed.message}`);
  return parsed.value;
}
