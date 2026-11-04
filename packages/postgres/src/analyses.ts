import { sql } from 'kysely';
import type { AnalysisStore, CoreAnalysis, AnalysisSnapshot } from '@second-brain/core';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';

export function postgresAnalysisStore(connect: PgConnect): AnalysisStore {
  async function find(where: { id: string } | { snapshotId: string; scope: string; revision: number }) {
    const c = connect(); if (!c.ok) return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: c.message };
    try {
      const condition = 'id' in where ? sql`a.id=${where.id}` : sql`a.snapshot_id=${where.snapshotId} and a.scope=${where.scope} and a.revision=${where.revision}`;
      const result = await sql<CoreAnalysis>`select a.id,a.snapshot_id as "snapshotId",a.bundle_id as "bundleId",a.report_date as "reportDate",a.scope,a.revision,a.agent,a.output_json as output,f.file_id as "fileId" from brain.analyses a join brain.analysis_files f on f.analysis_id=a.id and f.role='report' where a.source='core' and ${condition}`.execute(c.connection.db);
      return { ok: true as const, analysis: result.rows[0] ?? null };
    } catch (error) { return databaseFailure(error); }
  }
  return {
    async createAnalysisSnapshot(s) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      const result = await withWrite(c.connection, async db => {
        await sql`insert into brain.analysis_snapshots(id,bundle_id,local_date,time_zone,content,content_sha256,created_at) values (${s.id},${s.bundleId},${s.localDate},${s.timeZone},${Buffer.from(s.content)},${s.contentSha256},${s.createdAt}) on conflict(id) do nothing`.execute(db);
        const matches = await sql`select id from brain.analysis_snapshots where id=${s.id} and bundle_id=${s.bundleId} and local_date=${s.localDate}::date and time_zone=${s.timeZone} and content=${Buffer.from(s.content)} and content_sha256=${s.contentSha256} and created_at=${s.createdAt}`.execute(db);
        if (!matches.rows.length) throw Error('snapshot 내용 충돌');
      });
      return result.ok ? { ok: true } : result;
    },
    async readAnalysisSnapshot(id) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      try { const result = await sql<AnalysisSnapshot>`select id,bundle_id as "bundleId",local_date::text as "localDate",time_zone as "timeZone",content,content_sha256 as "contentSha256",created_at as "createdAt" from brain.analysis_snapshots where id=${id}`.execute(c.connection.db); return { ok: true, snapshot: result.rows[0] ? { ...result.rows[0], createdAt: new Date(result.rows[0].createdAt) } : null }; } catch (error) { return databaseFailure(error); }
    },
    findCoreAnalysis(snapshotId, scope, revision) { return find({ snapshotId, scope, revision }); },
    readCoreAnalysis(id) { return find({ id }); },
    async commitCoreAnalysis(input) {
      const c = connect(); if (!c.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: c.message };
      const result = await withWrite(c.connection, async db => {
        const fence = await sql`select id from brain.work_items where id=${input.workId} and kind='health_analysis' and target_kind='analysis_snapshot' and target_id=${input.snapshot.id} and brain.attempt_is_current(id,${input.attemptToken}) for update`.execute(db);
        if (!fence.rows.length) throw Error('오래된 분석 시도');
        const inserted = await sql<{id:string}>`insert into brain.analyses(id,source,dataset,revision,model,model_missing,created_at,created_at_missing,source_work_item_id,source_attempt_token,report_date,scope,bundle_id,snapshot_id,agent,output_json) values (${input.id},'core','health',1,null,true,${input.now},false,${input.workId},${input.attemptToken},${input.snapshot.localDate},'day',${input.snapshot.bundleId},${input.snapshot.id},${input.agent},${JSON.stringify(input.output)}::jsonb) on conflict (snapshot_id,scope,revision) where source='core' do nothing returning id`.execute(db);
        if (!inserted.rows.length) return (await sql<{id:string}>`select id from brain.analyses where source='core' and snapshot_id=${input.snapshot.id} and scope='day' and revision=1`.execute(db)).rows[0]!.id;
        await sql`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values (${input.fileId},${input.contentHash},${input.sizeBytes},${input.now}) on conflict(content_hash) do nothing`.execute(db);
        const file = (await sql<{id:string;redacted_at:Date|null}>`select id,redacted_at from brain.files where content_hash=${input.contentHash} for update`.execute(db)).rows[0]!;
        if (file.redacted_at) throw Error('가려진 파일');
        await sql`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values (${input.locationId},${file.id},${input.location.storeKind},${input.location.locator},${input.location.ownership},${input.now}) on conflict(file_id,store_kind,locator) do nothing`.execute(db);
        const loc = (await sql<{id:string;deleted_at:Date|null}>`select id,deleted_at from brain.file_locations where file_id=${file.id} and store_kind=${input.location.storeKind} and locator=${input.location.locator} for update`.execute(db)).rows[0]!;
        if (loc.deleted_at) throw Error('삭제된 파일 위치');
        await sql`update brain.files set home_location_id=${loc.id} where id=${file.id} and home_location_id is null`.execute(db);
        await sql`insert into brain.analysis_files(analysis_id,file_id,role) values (${input.id},${file.id},'report')`.execute(db);
        return input.id;
      });
      return result.ok ? { ok: true, id: result.value } : result;
    },
  };
}
