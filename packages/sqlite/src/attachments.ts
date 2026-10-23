import type { AttachmentStore, IngestAttachment, MessageAttachment } from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import type { SqliteSchema } from './driver.js';
import { describe, type SqliteConnect } from './connect.js';
import { withWrite } from './write.js';

/** Shared by ingest and replay; every statement uses the held transaction. */
export async function writeAttachments(db: Kysely<SqliteSchema>, attachments: readonly IngestAttachment[], messages: ReadonlyMap<string, string>, at: string): Promise<number> {
  let linked = 0;
  for (const a of attachments) {
    const messageId = messages.get(a.harnessMessageId);
    if (messageId === undefined) throw new Error('첨부 메시지가 없습니다');
    const existing = await sql`select id from message_attachments where message_id = ${messageId} and ordinal = ${a.ordinal}`.execute(db);
    if (existing.rows.length > 0) continue;
    await sql`insert into files (id, content_hash, size_bytes, first_seen_at) values (${a.file.id}, ${a.file.contentHash}, ${a.file.sizeBytes}, ${at}) on conflict (content_hash) do nothing`.execute(db);
    const file = (await sql<{id: string}>`select id from files where content_hash = ${a.file.contentHash}`.execute(db)).rows[0];
    if (file === undefined) throw new Error('첨부 파일이 없습니다');
    const l = a.file.location;
    await sql`insert into file_locations (id, file_id, store_kind, locator, ownership, first_seen_at) values (${l.id}, ${file.id}, ${l.storeKind}, ${l.locator}, ${l.ownership}, ${at}) on conflict (file_id, store_kind, locator) do nothing`.execute(db);
    const location = (await sql<{id: string; ownership: string}>`select id, ownership from file_locations where file_id = ${file.id} and store_kind = ${l.storeKind} and locator = ${l.locator}`.execute(db)).rows[0];
    if (location?.ownership === 'brain') await sql`update files set home_location_id = ${location.id} where id = ${file.id} and home_location_id is null`.execute(db);
    const result = await sql`insert into message_attachments (id, message_id, ordinal, source_kind, source_ref, display_name, file_id, status) values (${a.id}, ${messageId}, ${a.ordinal}, ${a.sourceKind}, ${a.sourceRef}, ${a.displayName}, ${file.id}, 'stored') on conflict (message_id, ordinal) do nothing returning id`.execute(db);
    linked += result.rows.length;
  }
  return linked;
}

export function sqliteAttachmentStore(connect: SqliteConnect): AttachmentStore {
  return {
    async linkAttachments(input) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      const result = await withWrite(opened.connection, async db => {
        const session = (await sql<{id: string}>`select id from sessions where harness = ${input.key.harness} and harness_session_id = ${input.key.harnessSessionId}`.execute(db)).rows[0];
        if (session === undefined) return { ok: false as const, code: 'SESSION_NOT_FOUND' as const, message: '세션이 없습니다' };
        const rows = await sql<{id: string; harness_message_id: string}>`select id, harness_message_id from messages where session_id = ${session.id}`.execute(db);
        const messages = new Map(rows.rows.map(r => [r.harness_message_id, r.id]));
        if (input.attachments.some(a => !messages.has(a.harnessMessageId))) return { ok: false as const, code: 'MESSAGE_NOT_FOUND' as const, message: '메시지가 없습니다' };
        return { ok: true as const, linked: await writeAttachments(db, input.attachments, messages, input.linkedAt.toISOString()) };
      });
      return result.ok ? result.value : result;
    },
    async listMessageAttachments(messageId) {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const result = await sql<{id: string; ordinal: number; source_kind: string; source_ref: string | null; display_name: string | null; status: MessageAttachment['status']; file_id: string | null; content_hash: string; size_bytes: number; store_kind: 'local' | 'drive' | null; locator: string; ownership: 'brain' | 'external'}>`
          select a.id, a.ordinal, a.source_kind, a.source_ref, a.display_name, a.status,
                 f.id as file_id, f.content_hash, f.size_bytes, l.store_kind, l.locator, l.ownership
            from message_attachments a left join files f on f.id = a.file_id
            left join file_locations l on l.id = f.home_location_id
           where a.message_id = ${messageId} order by a.ordinal
        `.execute(opened.connection.db);
        return { ok: true, attachments: result.rows.map(r => ({ id: r.id, ordinal: r.ordinal, sourceKind: r.source_kind, sourceRef: r.source_ref, displayName: r.display_name, status: r.status,
          file: r.file_id === null ? null : { id: r.file_id, contentHash: r.content_hash, sizeBytes: r.size_bytes, home: r.store_kind === null ? null : { storeKind: r.store_kind, locator: r.locator, ownership: r.ownership } } })) };
      } catch (error) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: `첨부를 읽을 수 없습니다: ${describe(error)}` };
      }
    },
  };
}
