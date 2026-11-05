import { FILE_IMPORT_KIND, type ImportStore } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';
export function postgresImportStore(connect: PgConnect): ImportStore {
  return {
    async listUnhandedImports() {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const result = await sql<{id: string}>`select q.id from brain.file_requests q left join brain.file_request_handoffs h on h.request_id=q.id where h.request_id is null order by q.created_at,q.id limit 500`.execute(c.connection.db);
        return { ok: true, ids: result.rows.map(r => r.id) };
      } catch (error) { return databaseFailure(error); }
    },
    async listImportCleanups() {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const result = await sql<{ id: string }>`select c.request_id as id from brain.file_import_cleanup c join brain.file_requests target on target.id=c.request_id where c.cleaned_at is null and not exists (select 1 from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.source=target.source and q.locator=target.locator and r.file_id is null) order by c.request_id limit 500`.execute(c.connection.db);
        return { ok: true, ids: result.rows.map(r => r.id) };
      } catch (error) { return databaseFailure(error); }
    },
    async cleanupImport(input) {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        return await c.connection.db.connection().execute(async db => {
          const row = (await sql<{source:string;locator:string}>`select q.source,q.locator from brain.file_requests q join brain.file_import_cleanup c on c.request_id=q.id where q.id=${input.requestId} and c.cleaned_at is null`.execute(db)).rows[0];
          if (!row) return { ok: true as const, cleaned: false };
          await sql`select pg_advisory_lock(hashtextextended(jsonb_build_array(${row.source}::text,${row.locator}::text)::text,10))`.execute(db);
          try {
            const pending = await sql`select 1 from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.source=${row.source} and q.locator=${row.locator} and r.file_id is null limit 1`.execute(db);
            if (pending.rows.length) return { ok: true as const, cleaned: false };
            // unlink 중 세션이 죽어도 같은 locator의 신규 요청을 거부한다.
            await sql`update brain.file_import_cleanup c set deleting_at=${input.now} from brain.file_requests q where q.id=c.request_id and q.source=${row.source} and q.locator=${row.locator} and c.cleaned_at is null`.execute(db);
            await input.remove(row.source,row.locator);
            await sql`update brain.file_import_cleanup c set cleaned_at=${input.now} from brain.file_requests q where q.id=c.request_id and q.source=${row.source} and q.locator=${row.locator} and c.cleaned_at is null`.execute(db);
            return { ok: true as const, cleaned: true };
          } finally { await sql`select pg_advisory_unlock(hashtextextended(jsonb_build_array(${row.source}::text,${row.locator}::text)::text,10))`.execute(db); }
        });
      } catch (error) { return databaseFailure(error); }
    },
    async handoffImport(input) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      const result = await withWrite(c.connection, async db => {
        const q = await sql`select id from brain.file_requests where id=${input.requestId} for update`.execute(db);
        if (!q.rows.length) return { ok: true as const, created: false };
        const existing = await sql`select request_id from brain.file_request_handoffs where request_id=${input.requestId}`.execute(db);
        if (existing.rows.length) return { ok: true as const, created: false };
        const work = await ensureWork(db, { id: input.workId, kind: FILE_IMPORT_KIND, targetKind: 'file_request', targetId: input.requestId, createdAt: input.now, nextAttemptAt: input.now });
        await sql`insert into brain.file_request_handoffs(request_id,work_item_id) values (${input.requestId},${work.row.id})`.execute(db);
        return { ok: true as const, created: true };
      }); return result.ok ? result.value : result;
    },
    async readImport(id) {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const result = await sql<{id: string; source: string; locator: string; sha256: string; sizeBytes: string; mediaType: string; completed: boolean}>`select q.id,q.source,q.locator,q.sha256,q.size_bytes as "sizeBytes",q.media_type as "mediaType",(r.file_id is not null) as completed from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where q.id=${id}`.execute(c.connection.db);
        const row = result.rows[0]; return { ok: true, request: row ? { ...row, sizeBytes: Number(row.sizeBytes) } : null, completed: row?.completed ?? false };
      } catch (error) { return databaseFailure(error); }
    },
    async finishImport(input) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      const result = await withWrite(c.connection, async db => {
        const claim = await sql`select w.id from brain.work_items w join brain.file_request_handoffs h on h.request_id=${input.requestId} where w.id=${input.workId} and w.kind=${FILE_IMPORT_KIND} and w.target_kind='file_request' and w.target_id=${input.requestId} and w.claimed_by=${input.claimedBy} and w.claimed_at=${input.claimedAt} and w.attempts=${input.claimAttempt} and w.claim_expires_at>${input.now} and w.completed_at is null for update of w`.execute(db);
        if (!claim.rows.length) throw Error('청구가 만료되었습니다');
        await sql`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values (${input.fileId},${input.hash},${input.size},${input.now}) on conflict(content_hash) do nothing`.execute(db);
        const file = (await sql<{id: string; redacted_at: Date | null}>`select id,redacted_at from brain.files where content_hash=${input.hash} for update`.execute(db)).rows[0]!;
        if (file.redacted_at && !input.cleanupDone) return { redacted: true };
        if (file.redacted_at) {
          await sql`insert into brain.file_request_results(request_id,file_id,finished_at) values (${input.requestId},${file.id},${input.now}) on conflict(request_id) do update set file_id=excluded.file_id,error_code=null,finished_at=excluded.finished_at`.execute(db);
          return { redacted: false };
        }
        await sql`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values (${input.locationId},${file.id},${input.location.storeKind},${input.location.locator},${input.location.ownership},${input.now}) on conflict(file_id,store_kind,locator) do nothing`.execute(db);
        const location = (await sql<{id: string; deleted_at: Date | null}>`select id,deleted_at from brain.file_locations where file_id=${file.id} and store_kind=${input.location.storeKind} and locator=${input.location.locator} for update`.execute(db)).rows[0]!;
        if (location.deleted_at) throw Error('삭제된 위치는 복원하지 않습니다');
        await sql`update brain.files set home_location_id=${location.id} where id=${file.id} and home_location_id is null`.execute(db);
        await sql`insert into brain.file_request_results(request_id,file_id,finished_at) values (${input.requestId},${file.id},${input.now}) on conflict(request_id) do update set file_id=excluded.file_id,error_code=null,finished_at=excluded.finished_at`.execute(db);
        return { redacted: false };
      }); return result.ok ? { ok: true, redacted: result.value.redacted } : result;
    },
    async failImport(input) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      const result = await withWrite(c.connection, async db => {
        const claim = await sql`select w.id from brain.work_items w join brain.file_request_handoffs h on h.request_id=${input.requestId} where w.id=${input.workId} and w.kind=${FILE_IMPORT_KIND} and w.target_kind='file_request' and w.target_id=${input.requestId} and w.claimed_by=${input.claimedBy} and w.claimed_at=${input.claimedAt} and w.attempts=${input.claimAttempt} and w.claim_expires_at>${input.now} and w.completed_at is null for update of w`.execute(db);
        if (!claim.rows.length) throw Error('청구가 만료되었습니다');
        await sql`insert into brain.file_request_results(request_id,error_code,finished_at) values (${input.requestId},${input.code},${input.now}) on conflict(request_id) do nothing`.execute(db);
      }); return result.ok ? { ok: true } : result;
    },
  };
}
