import { sql } from 'kysely';
import type { AnalysisInputStore, AnalysisInputSources, AnalysisSnapshot, InputAnalysisRecord } from '@second-brain/core';
import { databaseFailure, type PgConnect } from './connect.js';
import { withWrite } from './write.js';

const invalid = (message: string) => ({ok:false as const,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID' as const,message});
const normalize = (s: AnalysisSnapshot): AnalysisSnapshot => ({...s,createdAt:new Date(s.createdAt)});
export function postgresAnalysisInputStore(connect: PgConnect): AnalysisInputStore {
  return {
    async findAnalysisSnapshotByInputs(collectWorkId,artifactsWorkId) {
      const c = connect(); if (!c.ok) return {ok:false,code:'DB_UNAVAILABLE',message:c.message};
      try {
        const rows = await sql<AnalysisSnapshot>`select id,bundle_id as "bundleId",local_date::text as "localDate",time_zone as "timeZone",content,content_sha256 as "contentSha256",created_at as "createdAt" from brain.analysis_snapshots where collect_work_id=${collectWorkId} and artifacts_work_id=${artifactsWorkId}`.execute(c.connection.db);
        return {ok:true,snapshot:rows.rows[0] ? normalize(rows.rows[0]) : null};
      } catch (error) { return databaseFailure(error); }
    },
    async createInputSnapshot(s,collectWorkId,artifactsWorkId) {
      const c = connect(); if (!c.ok) return {ok:false,code:'DB_UNAVAILABLE',message:c.message};
      const result = await withWrite(c.connection,async db => {
        await sql`insert into brain.analysis_snapshots(id,bundle_id,local_date,time_zone,content,content_sha256,created_at,collect_work_id,artifacts_work_id) values (${s.id},${s.bundleId},${s.localDate},${s.timeZone},${Buffer.from(s.content)},${s.contentSha256},${s.createdAt},${collectWorkId},${artifactsWorkId}) on conflict (collect_work_id,artifacts_work_id) where collect_work_id is not null and artifacts_work_id is not null do nothing`.execute(db);
        const rows = await sql<AnalysisSnapshot>`select id,bundle_id as "bundleId",local_date::text as "localDate",time_zone as "timeZone",content,content_sha256 as "contentSha256",created_at as "createdAt" from brain.analysis_snapshots where collect_work_id=${collectWorkId} and artifacts_work_id=${artifactsWorkId}`.execute(db);
        if (!rows.rows[0]) throw Error('snapshot insert did not return a row');
        return normalize(rows.rows[0]);
      });
      return result.ok ? {ok:true,snapshot:result.value} : result;
    },
    async readAnalysisInputSources(collectWorkId,artifactsWorkId) {
      const c = connect(); if (!c.ok) return {ok:false,code:'DB_UNAVAILABLE',message:c.message};
      try {
        return await c.connection.db.transaction().execute(async db => {
          await sql`set transaction isolation level repeatable read read only`.execute(db);
          const pair = await sql<{account:string;dataset:string;reportDate:string;timeZone:string;cutoffMs:string;collectStatus:string;finishedAt:string|null;requestId:string;collectSnapshotId:string}>`
            select t.account,t.dataset,ca.result_summary->>'snapshot_id' as "collectSnapshotId",ca.result_summary->>'local_date' as "reportDate",ca.result_summary->>'timezone' as "timeZone",ca.result_summary->>'cutoff_ms' as "cutoffMs",ca.result_summary->>'status' as "collectStatus",to_char(ca.finished_at at time zone (ca.result_summary->>'timezone'),'YYYY-MM-DD HH24:MI') as "finishedAt",aa.result_summary->>'request_id' as "requestId"
            from brain.work_items cw join brain.work_attempts ca on ca.work_item_id=cw.id and ca.outcome='succeeded'
            join garmin.collect_target_accounts t on t.target_kind=cw.target_kind and t.target_id=cw.target_id
            join brain.work_items aw on aw.id=${artifactsWorkId} and aw.kind='garmin.artifacts' and aw.outcome='succeeded' and aw.completed_at is not null
            join brain.work_attempts aa on aa.work_item_id=aw.id and aa.outcome='succeeded'
            where cw.id=${collectWorkId} and cw.kind in ('garmin.collect','garmin.collect_retry','garmin.collect_recent') and cw.outcome='succeeded' and cw.completed_at is not null
              and ca.result_summary->>'status' in ('success','noop') and ca.result_summary->>'snapshot_id' is not null and aa.result_summary->>'status'='success'
            order by ca.finished_at desc,aa.finished_at desc limit 1`.execute(db);
          const p = pair.rows[0]; if (!p || !p.reportDate || !p.timeZone || !p.cutoffMs || !Number.isFinite(Number(p.cutoffMs)) || !p.requestId) return invalid('성공한 수집 및 산출물 결과가 필요합니다');
          const digest = await sql<{fileId:string;storeKind:'local'|'drive';locator:string;ownership:'brain'|'external'}>`select f.id as "fileId",l.store_kind as "storeKind",l.locator,l.ownership from brain.file_requests q join brain.file_request_results r on r.request_id=q.id and r.file_id is not null join brain.files f on f.id=r.file_id and f.redacted_at is null join brain.file_locations l on l.id=f.home_location_id and l.deleted_at is null where q.id=${p.requestId}::uuid and q.metadata->>'kind'='digest' and q.metadata->>'collect_result_id'=${collectWorkId}`.execute(db);
          if (!digest.rows[0]) return invalid('완료된 digest 파일이 필요합니다');
          const prior = await sql<{value:string}>`select coalesce((select (a.result_summary->>'cutoff_ms')::bigint from brain.work_items w join brain.work_attempts a on a.work_item_id=w.id and a.outcome='succeeded' join garmin.collect_target_accounts t on t.target_kind=w.target_kind and t.target_id=w.target_id where t.account=${p.account} and w.kind in ('garmin.collect','garmin.collect_retry','garmin.collect_recent') and w.outcome='succeeded' and w.completed_at is not null and a.result_summary->>'status'<>'skipped_blocked' and a.result_summary->>'local_date'=(${p.reportDate}::date - 1)::text and a.result_summary->>'cutoff_ms' is not null order by (a.result_summary->>'cutoff_ms')::bigint desc limit 1), (extract(epoch from ((${p.reportDate}::date - 1 + time '11:00') at time zone ${p.timeZone}))*1000)::bigint)::text as value`.execute(db);
          const setting = await sql<{value:string}>`select value from brain.settings where key='analysis.profile_path'`.execute(db);
          const earliest = await sql<{value:string|null}>`select min(substr(key,5)) as value from garmin.raw_records where account=${p.account} and key like 'day/%'`.execute(db);
          const body = await sql<{measuredOn:string;sidecar:unknown}>`select measured_on::text as "measuredOn",sidecar::text as sidecar from garmin.body_records where account=${p.account} and dataset=${p.dataset} and measured_on<=${p.reportDate}::date order by measured_on`.execute(db);
          const metrics = await sql<AnalysisInputSources['metrics'][number]>`select h.id,h.metric,h.local_date::text as "localDate",h.activity_id as "activityId",h.sub_identity as "subIdentity",case when h.value_type='number' then to_jsonb(h.value) when h.value_type='text' then to_jsonb(h.value_text) else h.value_json end as value,h.value_json_raw as "jsonRaw",h.value_json_encoding as "jsonEncoding",coalesce((select (m->>'factor')::float8 from jsonb_array_elements(c.definition->'mappings') m where m->>'table'=split_part(h.metric,'.',1) and m->>'column'=split_part(h.metric,'.',2) limit 1),1) as factor,h.normalization_version as "normalizationVersion",array(select jsonb_array_elements_text(c.definition->'aggregations')) as aggregations,r.authority_id as "authorityId",r.authority_version as "authorityRevision" from brain.health_current_v1 h join brain.health_resolution_v1 r on r.current_id=h.id join brain.health_catalog_v1 c on c.metric=h.metric where h.source='garmin' and h.account=${p.account} and h.time_zone=${p.timeZone} and split_part(h.metric,'.',1) in ('day_summary','workout','exercise_log','activity') and h.local_date<=${p.reportDate}::date order by h.metric,h.local_date,h.activity_id,h.sub_identity,h.id`.execute(db);
          const activityKeys = [...new Set(metrics.rows.filter(row => row.metric === 'activity.start_ms' && row.activityId !== null && row.localDate !== null && row.localDate >= new Date(Date.parse(`${p.reportDate}T00:00:00Z`) - 30*86400000).toISOString().slice(0,10) && typeof row.value === 'number' && row.value < Number(p.cutoffMs)).map(row => `activity/${row.activityId}`))];
          const raw = await sql<{key:string;endpoint:string;body:string}>`select key,endpoint,body from garmin.raw_records where account=${p.account} and ((key >= 'day/' || (${p.reportDate}::date-30)::text and key <= 'day/' || ${p.reportDate}) or key=any(${activityKeys}::text[])) order by key,endpoint`.execute(db);
          const excluded = await sql<AnalysisInputSources['excluded'][number]>`select metric,local_date::text as "localDate",activity_id as "activityId",sub_identity as "subIdentity",reason,all_ids as ids from brain.health_resolution_v1 where source='garmin' and account=${p.account} and (time_zone=${p.timeZone} or time_zone is null) and reason is not null and split_part(metric,'.',1) in ('day_summary','workout','exercise_log','activity') and local_date<=${p.reportDate}::date order by metric,local_date,activity_id,sub_identity`.execute(db);
          const graphs = await sql<AnalysisInputSources['graphs'][number]>`select q.id as "requestId",q.metadata->>'role' as role,q.metadata->>'name' as name from brain.file_requests q join brain.file_request_results r on r.request_id=q.id and r.file_id is not null where q.metadata->>'collect_result_id'=${collectWorkId} and q.metadata->>'kind'='graph' order by role,name,q.id`.execute(db);
          const rows = await sql<{id:string;reportDate:string;scope:InputAnalysisRecord['scope'];source:string;revision:number;createdAt:string|null;summary:string|null;judgments:string|null;evidence:string|null;nextChecks:string|null;reportMd:string|null;output:Record<string,unknown>|null;reportFileId:string|null;storeKind:'local'|'drive'|null;locator:string|null;ownership:'brain'|'external'|null}>`select a.id,a.report_date as "reportDate",a.scope,a.source,a.revision,a.created_at::text as "createdAt",a.summary,a.judgments,a.evidence,a.next_checks as "nextChecks",a.report_md as "reportMd",a.output_json as output,af.file_id as "reportFileId",l.store_kind as "storeKind",l.locator,l.ownership from brain.analyses a left join brain.analysis_snapshots snap on snap.id=a.snapshot_id left join brain.analysis_files af on af.analysis_id=a.id and af.role='report' left join brain.files f on f.id=af.file_id and f.redacted_at is null left join brain.file_locations l on l.id=f.home_location_id and l.deleted_at is null where a.report_date<=${p.reportDate} and a.scope in ('day','7d','30d','all') and (a.source='garmin' or (a.source='core' and (case when snap.collect_work_id is not null then (convert_from(snap.content,'UTF8')::jsonb)->'manifest'->>'account' else null end)=${p.account})) order by a.report_date,a.scope,a.id`.execute(db);
          const analyses: InputAnalysisRecord[] = rows.rows.map(r => ({id:r.id,reportDate:r.reportDate,scope:r.scope,source:r.source === 'core' ? 'core':'legacy',revision:r.revision,createdAt:r.createdAt ?? '',summary:r.output?.summary ?? r.summary,judgments:r.output?.judgments ?? JSON.parse(r.judgments ?? 'null'),evidence:r.output?.evidence ?? JSON.parse(r.evidence ?? 'null'),nextChecks:r.output?.next_checks ?? JSON.parse(r.nextChecks ?? 'null'),reportMd:r.reportMd,reportFileId:r.reportFileId,reportLocation:r.storeKind && r.locator && r.ownership ? {storeKind:r.storeKind,locator:r.locator,ownership:r.ownership} : null}));
          const d = digest.rows[0]!;
          return {ok:true as const,sources:{reportDate:p.reportDate,firstEver:earliest.rows[0]?.value ?? p.reportDate,timeZone:p.timeZone,cutoffMs:Number(p.cutoffMs),windowFromMs:Number(prior.rows[0]!.value),collectWorkId,artifactsWorkId,collectSnapshotId:p.collectSnapshotId,collectStatus:p.collectStatus,finishedAt:p.finishedAt,account:p.account,dataset:p.dataset,profilePath:setting.rows[0]?.value ?? null,raw:raw.rows,body:body.rows,metrics:metrics.rows.map(row => { const r = row as typeof row & {jsonRaw: Uint8Array | null; jsonEncoding: string | null}; return {...row,valueJsonRaw:r.jsonRaw && r.jsonEncoding ? new TextDecoder(r.jsonEncoding,{fatal:true}).decode(r.jsonRaw) : null}; }),excluded:excluded.rows,analyses,digest:{fileId:d.fileId,location:{storeKind:d.storeKind,locator:d.locator,ownership:d.ownership}},graphs:graphs.rows}};
        });
      } catch (error) {
        const failure = error as {code?:string; message?:string};
        if ((['42P01','3F000'].includes(failure.code ?? '') && (failure.message ?? '').includes('garmin')) || ['22P02','22023','22007','22008'].includes(failure.code ?? '')) return invalid('Garmin 확장 읽기 계약을 사용할 수 없습니다');
        return databaseFailure(error);
      }
    },
  };
}
