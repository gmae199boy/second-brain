import {
  formatInstant,
  FILE_REDACTION_RESOLVES,
  parseInstant,
  type FileLocationRow,
  type FileName,
  type FileRef,
  type MissingFileName,
  type ReadFileSharingResult,
  type AttachmentStore,
  type IngestAttachment,
  type ListRedactedContentHashesResult,
  type MessageAttachment,
  type RedactFileResult,
} from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { ensureWork } from './work.js';
import { withWrite } from './write.js';
import { pgText, originalText } from './text.js';
import type { PgSchema } from './connect.js';
import { databaseFailure, describe, type PgConnect } from './connect.js';

/** Shared by ingest and replay; every statement uses the held transaction. */
export async function writeAttachments(db: Kysely<PgSchema>, attachments: readonly IngestAttachment[], messages: ReadonlyMap<string, string>, at: string): Promise<number> {
  let linked = 0;
  for (const a of attachments) {
    const messageId = messages.get(a.harnessMessageId);
    if (messageId === undefined) throw new Error('첨부 메시지가 없습니다');
    const existing = await sql`select id from brain.message_attachments where message_id = ${messageId} and ordinal = ${a.ordinal}`.execute(db);
    if (existing.rows.length > 0) continue;
    let fileId: string | null = null;
    if (a.file !== null) {
      await sql`insert into brain.files (id, content_hash, size_bytes, first_seen_at) values (${a.file.id}, ${a.file.contentHash}, ${a.file.sizeBytes}, ${at}) on conflict (content_hash) do nothing`.execute(db);
      const file = (await sql<{id: string}>`select id from brain.files where content_hash = ${a.file.contentHash}`.execute(db)).rows[0];
      if (file === undefined) throw new Error('첨부 파일이 없습니다');
      fileId = file.id;
      for (const l of [a.file.location, a.file.external]) {
        if (l === null) continue;
        await sql`insert into brain.file_locations (id, file_id, store_kind, locator, ownership, first_seen_at) values (${l.id}, ${file.id}, ${l.storeKind}, ${l.locator}, ${l.ownership}, ${at}) on conflict (file_id, store_kind, locator) do nothing`.execute(db);
        const location = (await sql<{id: string; ownership: string}>`select id, ownership from brain.file_locations where file_id = ${file.id} and store_kind = ${l.storeKind} and locator = ${l.locator}`.execute(db)).rows[0];
        if (location?.ownership === 'brain') await sql`update brain.files set home_location_id = ${location.id} where id = ${file.id} and home_location_id is null`.execute(db);
      }
    }
    const status = fileId === null ? 'missing_at_ingest' : 'stored';
    const result = await sql`insert into brain.message_attachments (id, message_id, ordinal, source_kind, source_ref, source_ref_raw, display_name, display_name_raw, file_id, status) values (${a.id}, ${messageId}, ${a.ordinal}, ${a.sourceKind}, ${pgText(a.sourceRef).text}, ${pgText(a.sourceRef).raw}, ${pgText(a.displayName).text}, ${pgText(a.displayName).raw}, ${fileId}, ${status}) on conflict (message_id, ordinal) do nothing returning id`.execute(db);
    linked += result.rows.length;
  }
  return linked;
}

/** One `file_locations` row as the port spells it; the instant is an ISO string. */
interface FileLocationColumns {
  id: string;
  fileId: string;
  storeKind: 'local' | 'drive';
  locator: string;
  ownership: 'brain' | 'external';
  deletedAt: string | null;
}

function fileLocationRow(row: FileLocationColumns): FileLocationRow {
  return { ...row, deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt) };
}

/** An instant as the column holds it. A caller's bad instant is a bug (AD-13). */
function instant(value: Date, column: string): string {
  const formatted = formatInstant(value);
  if (!formatted.ok) throw new TypeError(`${column} cannot hold this instant: ${formatted.message}`);
  return formatted.value;
}

/** The other direction. A row holding anything else was not written by us. */
function at(value: string, column: string): Date {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(`${column}을 읽을 수 없습니다: ${parsed.message}`);
  return parsed.value;
}

/** The `where` that picks one file by id or by content hash (`FileRef`). */
function fileWhere(ref: FileRef, alias: string): ReturnType<typeof sql> {
  const column = sql.ref(`${alias}.${'fileId' in ref ? 'id' : 'content_hash'}`);
  return sql`${column} = ${'fileId' in ref ? ref.fileId : ref.contentHash}`;
}

export function postgresAttachmentStore(connect: PgConnect): AttachmentStore {
  return {
    async redactFile(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const written = await withWrite(opened.connection, async (held): Promise<RedactFileResult> => {
        const file = (await sql<{ id: string; contentHash: string; redactedAt: string | null }>`
          select id,content_hash as "contentHash",redacted_at as "redactedAt" from brain.files
          where id=${input.fileId} for no key update`.execute(held)).rows[0];
        if (file === undefined) return { ok: false, code: 'FILE_NOT_FOUND', message: '지정한 파일이 없습니다' };
        const locations = (await sql<FileLocationColumns>`select id,file_id as "fileId",store_kind as "storeKind",
          locator,ownership,deleted_at as "deletedAt" from brain.file_locations where file_id=${file.id}
          order by ownership,locator`.execute(held)).rows.map(fileLocationRow);
        const plan = input.plan({ file: { ...file, redactedAt: file.redactedAt === null ? null : at(file.redactedAt, 'files.redacted_at') }, locations });
        for (const work of [...plan.work, ...plan.cleanup]) await ensureWork(held, work);
        let counts = { extractionsRemoved: 0, chunksRemoved: 0, namesRemoved: 0, metadataRemoved: 0, failuresResolved: 0 };
        if (file.redactedAt === null && plan.redaction !== null) {
          counts = (await sql<{ counts: typeof counts }>`select brain.redact_file(${file.id}::uuid,
            ${JSON.stringify(plan.redaction)}::jsonb) as counts`.execute(held)).rows[0]!.counts;
          counts.failuresResolved = (await sql`update brain.failures
            set resolved_at=${instant(plan.redaction.occurredAt, 'failures.resolved_at')}
            where target_kind=${FILE_REDACTION_RESOLVES.targetKind} and target_id=${file.id}
              and stage=${FILE_REDACTION_RESOLVES.stage} and resolved_at is null returning id`.execute(held)).rows.length;
        }
        const shared = (await sql<{ n: number }>`select count(distinct message_id) as n from brain.message_attachments
          where file_id=${file.id}`.execute(held)).rows[0]!.n;
        return { ok: true, fileId: file.id, contentHash: file.contentHash, messages: Number(shared),
          alreadyRedacted: file.redactedAt !== null, ...counts, blobDeletesQueued: plan.work.length };
      });
      return written.ok ? written.value : written;
    },

    async listMissingFileNames({ limit }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        // Sort the original UTF-8 bytes: bytea also preserves the NUL that
        // PostgreSQL text cannot hold. Other text keys use SQLite's binary order.
        const result = await sql<MissingFileName & { text_raw: Buffer | null }>`
          select c.file_id as "fileId", c.name_source as "nameSource", c.text, c.text_raw from (
            select a.file_id, 'attachment_name' as name_source, a.display_name as text, a.display_name_raw as text_raw
            from brain.message_attachments a join brain.files f on f.id = a.file_id
            where f.redacted_at is null and a.display_name is not null
            union
            select l.file_id, 'location_path', l.locator, null::bytea
            from brain.file_locations l join brain.files f on f.id = l.file_id
            where f.redacted_at is null and l.store_kind = 'local' and l.ownership = 'external'
          ) c where not exists (select 1 from brain.file_names n where n.file_id = c.file_id and n.name_source = c.name_source and n.text is not distinct from c.text and n.text_raw is not distinct from c.text_raw)
          order by c.file_id, c.name_source collate "C", coalesce(c.text_raw, convert_to(c.text, 'UTF8')) limit ${limit}
        `.execute(opened.connection.db);
        return { ok: true, names: result.rows.map(originalText).map(({ text_raw: _raw, ...row }) => row) };
      } catch (error) { return { ...databaseFailure(error), message: `파일 이름을 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async writeFileNames({ names }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async db => {
        let inserted = 0;
        for (const n of names) {
          const encoded = pgText(n.text);
          const added = await sql`insert into brain.file_names (id, file_id, name_source, text, text_raw)
            select ${n.id}, id, ${n.nameSource}, ${encoded.text}, ${encoded.raw} from brain.files where id = ${n.fileId} and redacted_at is null
            on conflict (file_id, name_source, text, text_raw) do nothing returning id`.execute(db);
          inserted += added.rows.length;
        }
        return { ok: true as const, inserted };
      });
      return result.ok ? result.value : result;
    },
    async listFileNames(fileId) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<FileName & { text_raw: Buffer | null }>`select id, file_id as "fileId", name_source as "nameSource", text, text_raw from brain.file_names where file_id::text = ${fileId} order by name_source collate "C", coalesce(text_raw, convert_to(text, 'UTF8'))`.execute(opened.connection.db);
        return { ok: true, names: result.rows.map(originalText).map(({ text_raw: _raw, ...row }) => row) };
      } catch (error) { return { ...databaseFailure(error), message: `파일 이름을 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async readFileLocation(id) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<FileLocationColumns>`select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where id::text = ${id}`.execute(opened.connection.db);
        const row = result.rows[0];
        if (row === undefined) return { ok: false, code: 'FILE_LOCATION_NOT_FOUND', message: '파일 위치가 없습니다' };
        return { ok: true, location: fileLocationRow(row) };
      } catch (error) { return { ...databaseFailure(error), message: `파일 위치를 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async listFileLocations(fileId) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<FileLocationColumns>`select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where file_id::text = ${fileId} order by ownership collate "C", locator collate "C"`.execute(opened.connection.db);
        return { ok: true, locations: result.rows.map(fileLocationRow) };
      } catch (error) { return { ...databaseFailure(error), message: `파일 위치를 읽을 수 없습니다: ${describe(error)}` }; }
    },
    async markFileLocationDeleted({ id, deletedAt }) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      // Validate before opening the write transaction, including repeated marks.
      let result;
      try {
        const checked = instant(deletedAt, 'file_locations.deleted_at');
        result = await withWrite(opened.connection, async db => {
          // The `and deleted_at is null` is the one-way fill of 0002 said in SQL
          // rather than left to the trigger: the trigger aborts the statement, and
          // a second piece of work about the same place is an ordinary answer.
          const filled = await sql`update brain.file_locations set deleted_at = ${checked} where id::text = ${id} and deleted_at is null returning id`.execute(db);
          const read = (await sql<{ deletedAt: string | null }>`select deleted_at as "deletedAt" from brain.file_locations where id::text = ${id}`.execute(db)).rows[0];
          if (read === undefined) return { ok: false as const, code: 'FILE_LOCATION_NOT_FOUND' as const, message: '파일 위치가 없습니다' };
          // Read back and not assumed: the stored instant is what the row says,
          // and on the second call that is the first call's value.
          if (read.deletedAt === null) return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '파일 위치의 삭제 시각을 쓰지 못했습니다' };
          return { ok: true as const, deletedAt: new Date(read.deletedAt), marked: filled.rows.length > 0 };
        });
      } catch (error) {
        return { ...databaseFailure(error), message: `파일 위치를 표시할 수 없습니다: ${describe(error)}` };
      }
      return result.ok ? result.value : result;
    },
    async readFileSharing(ref: FileRef): Promise<ReadFileSharingResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        // One statement, because the port says this is one read: the count a
        // confirmation message is built from must be the count as of the same
        // instant as the row, and two statements could straddle a write.
        // `count(distinct message_id)` and not attachment rows — the same file
        // attached twice to one message is one conversation that loses it.
        const row = (await sql<{ id: string; contentHash: string; redactedAt: string | null; messages: number }>`
          select f.id, f.content_hash as "contentHash", f.redacted_at as "redactedAt",
                 (select count(distinct a.message_id) from brain.message_attachments a
                   where a.file_id = f.id) as messages
            from brain.files f where ${fileWhere(ref, 'f')}
        `.execute(opened.connection.db)).rows[0];
        if (row === undefined) return { ok: false, code: 'FILE_NOT_FOUND', message: '지정한 파일이 없습니다' };
        return {
          ok: true,
          file: {
            id: row.id,
            contentHash: row.contentHash,
            redactedAt: row.redactedAt === null ? null : at(row.redactedAt, 'files.redacted_at'),
          },
          messages: Number(row.messages),
        };
      } catch (error) {
        return { ...databaseFailure(error), message: `파일을 읽을 수 없습니다: ${describe(error)}` };
      }
    },
    async linkAttachments(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      let linkedAt: string;
      try { linkedAt = instant(input.linkedAt, 'files.first_seen_at'); }
      catch (error) { return databaseFailure(error); }
      const result = await withWrite(opened.connection, async db => {
        const session = (await sql<{id: string}>`select id from brain.sessions where harness = ${input.key.harness} and harness_session_id = ${input.key.harnessSessionId}`.execute(db)).rows[0];
        if (session === undefined) return { ok: false as const, code: 'SESSION_NOT_FOUND' as const, message: '세션이 없습니다' };
        const rows = await sql<{id: string; harness_message_id: string}>`select id, harness_message_id, harness_message_id_raw from brain.messages where session_id = ${session.id}`.execute(db);
        const messages = new Map(rows.rows.map(originalText).map(r => [r.harness_message_id, r.id]));
        if (input.attachments.some(a => !messages.has(a.harnessMessageId))) return { ok: false as const, code: 'MESSAGE_NOT_FOUND' as const, message: '메시지가 없습니다' };
        return { ok: true as const, linked: await writeAttachments(db, input.attachments, messages, linkedAt) };
      }, `${input.key.harness}:${input.key.harnessSessionId}`);
      return result.ok ? result.value : result;
    },
    async listRedactedContentHashes(hashes): Promise<ListRedactedContentHashesResult> {
      // No hashes is no question, and the collection path asks this on every
      // turn: a turn with no attachment must not open the database for it.
      if (hashes.length === 0) return { ok: true, hashes: [] };
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const rows = await sql<{ contentHash: string }>`
          select content_hash as "contentHash" from brain.files
           where redacted_at is not null and content_hash in (${sql.join(hashes.map(hash => sql`${hash}`))})
        `.execute(opened.connection.db);
        return { ok: true, hashes: rows.rows.map(row => row.contentHash) };
      } catch (error) {
        return { ...databaseFailure(error), message: `가린 파일을 읽을 수 없습니다: ${describe(error)}` };
      }
    },
    async listMessageAttachments(messageId) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{id: string; ordinal: number; source_kind: string; source_ref: string | null; display_name: string | null; status: MessageAttachment['status']; file_id: string | null; content_hash: string; size_bytes: number; store_kind: 'local' | 'drive' | null; locator: string; ownership: 'brain' | 'external'}>`
          select a.id, a.ordinal, a.source_kind, a.source_ref, a.source_ref_raw, a.display_name, a.display_name_raw, a.status,
                 f.id as file_id, f.content_hash, f.size_bytes, l.store_kind, l.locator, l.ownership
            from brain.message_attachments a left join brain.files f on f.id = a.file_id
            left join brain.file_locations l on l.id = f.home_location_id
           where a.message_id = ${messageId} order by a.ordinal
        `.execute(opened.connection.db);
        const fileIds = [...new Set(result.rows.flatMap(r => r.file_id === null ? [] : [r.file_id]))];
        const locations = fileIds.length === 0 ? [] : (await sql<{file_id: string; store_kind: 'local' | 'drive'; locator: string; ownership: 'brain' | 'external'}>`select file_id, store_kind, locator, ownership from brain.file_locations where file_id in (${sql.join(fileIds)}) order by ownership, locator`.execute(opened.connection.db)).rows;
        return { ok: true, attachments: result.rows.map(originalText).map(r => ({ id: r.id, ordinal: r.ordinal, sourceKind: r.source_kind, sourceRef: r.source_ref, displayName: r.display_name, status: r.status,
          file: r.file_id === null ? null : { id: r.file_id, contentHash: r.content_hash, sizeBytes: r.size_bytes, locations: locations.filter(l => l.file_id === r.file_id).map(l => ({ storeKind: l.store_kind, locator: l.locator, ownership: l.ownership })), home: r.store_kind === null ? null : { storeKind: r.store_kind, locator: r.locator, ownership: r.ownership } } })) };
      } catch (error) {
        return { ...databaseFailure(error), message: `첨부를 읽을 수 없습니다: ${describe(error)}` };
      }
    },
  };
}
