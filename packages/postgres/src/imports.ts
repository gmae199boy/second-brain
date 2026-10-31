import { FILE_IMPORT_KIND, type ImportStore, type AnalysisRecord } from '@second-brain/core';
import { sql } from 'kysely';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';
import { originalJson, originalText } from './original-text.js';
/** 분석 JSON에서 온 단독 surrogate와 SQLite의 비정상 원문 바이트는 구별한다. */
function originalAnalysisText(display: unknown, raw: unknown, encoding: unknown): unknown {
  if (encoding !== 'json-string-v1') return originalText(display,raw,encoding);
  if (!Buffer.isBuffer(raw) || typeof display !== 'string' || raw.some(byte => byte > 0x7f)) throw Error('IMPORT_INVALID');
  let value: unknown;
  try { value = JSON.parse(raw.toString('ascii')); } catch { throw Error('IMPORT_INVALID'); }
  if (typeof value !== 'string' || value.isWellFormed() || value.toWellFormed().replaceAll('\0','�') !== display) throw Error('IMPORT_INVALID');
  return value;
}
export function postgresImportStore(connect: PgConnect): ImportStore {
  return {
    async readHealth() {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const rows = (await sql<Record<string, unknown>>`select * from brain.health_current_v1`.execute(c.connection.db)).rows;
        const fields = ['id','source','dataset','import_batch','original_table','original_key','account_confirmed','metric','value','unit','local_date','observed_at','time_zone','time_zone_missing','revision','fetched_at','normalization_version','source_work_item_id','source_attempt_token','value_type','catalog_version'];
        return { ok: true, rows: rows.map(r => {
          const dto = Object.fromEntries(fields.map(k => [k, r[k]]));
          if (r.dataset_label != null) dto.dataset = originalText(r.dataset_label,r.dataset_label_raw,r.dataset_label_encoding);
          for (const k of ['account','activity_id','sub_identity','value_text']) dto[k] = originalText(r[k],r[k+'_raw'],r[k+'_encoding']);
          dto.value_json = originalJson(r.value_json,r.value_json_raw,r.value_json_encoding);
          return dto;
        }) };
      }
      catch (error) { return databaseFailure(error); }
    },
    async readAnalyses() {
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const rows = (await sql<Record<string, unknown>>`select a.*,r.file_id,r.error_code from brain.analyses a left join brain.file_request_results r on r.request_id=a.file_request_id`.execute(c.connection.db)).rows;
        const relations = (await sql<{ analysis_id: string; file_request_id: string; role: string; file_id: string | null; error_code: string | null }>`select x.analysis_id,x.file_request_id,x.role,r.file_id,r.error_code from brain.analysis_artifacts x left join brain.file_request_results r on r.request_id=x.file_request_id order by x.analysis_id,x.role,x.file_request_id`.execute(c.connection.db)).rows;
        const fields = ['id','source','dataset','import_batch','original_table','original_key','revision','model_missing','created_at','created_at_missing','file_request_id','source_work_item_id','source_attempt_token','file_id','error_code'];
        return { ok: true, rows: rows.map(r => {
          const dto = Object.fromEntries(fields.map(k => [k,r[k]]));
          for (const k of ['report_date','scope','summary','judgments','evidence','next_checks','report_md','model']) dto[k] = originalAnalysisText(r[k],r[k+'_raw'],r[k+'_encoding']);
          dto.artifacts = relations.filter(x => x.analysis_id === r.id).map(({analysis_id: _analysisId,...relation}) => relation);
          return dto as AnalysisRecord;
        }) };
      }
      catch (error) { return databaseFailure(error); }
    },
    async readRaw(input) {
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(input.source) || !input.rawViews.some(view => view === 'raw_records' || view === 'raw_records_v2')) return { ok: false, code: 'IMPORT_VIEW_INVALID', message: '선언된 원문 view가 없습니다' };
      try { const c = connect(); if (!c.ok) throw Error(c.message);
        const exists = await sql<{ enabled: boolean }>`select enabled from brain.extensions where name=${input.source}`.execute(c.connection.db);
        if (!exists.rows.length) return { ok: false, code: 'IMPORT_VIEW_INVALID', message: '설치된 확장이 없습니다' };
        if (input.rawViews.includes('raw_records_v2')) {
          const rows = (await sql<Record<string, unknown>>`select source,dataset,dataset_raw,dataset_encoding,account,account_raw,account_encoding,scope,scope_raw,scope_encoding,original_key,original_key_raw,original_key_encoding,endpoint,endpoint_raw,endpoint_encoding,fetched_at,checked_at,body,body_raw,body_encoding from ${sql.ref(input.source + '.raw_records_v2')}`.execute(c.connection.db)).rows;
          return { ok: true, extensionEnabled: exists.rows[0]!.enabled, rows: rows.map(r => {
            const field = (name: string) => originalText(r[name], r[name + '_raw'], r[name + '_encoding']);
            return { source: r.source, dataset: field('dataset'), account: field('account'), scope: field('scope'), originalKey: field('original_key'), endpoint: field('endpoint'), fetched_at: r.fetched_at, checked_at: r.checked_at, body: field('body') };
          }) };
        }
        return { ok: true, extensionEnabled: exists.rows[0]!.enabled, rows: (await sql<Record<string, unknown>>`select source,account,key,endpoint,fetched_at,checked_at,body from ${sql.ref(input.source + '.raw_records')}`.execute(c.connection.db)).rows };
      } catch (error) { return databaseFailure(error); }
    },
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
