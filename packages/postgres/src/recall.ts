import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, formatSessionToken, type RecallStore, type DocumentRecallStore } from '@second-brain/core';
import { sql } from 'kysely';
import { describe, type PgConnect } from './connect.js';
import { originalText, pgText } from './text.js';

function documentError(error: unknown) {
  const code = (error as { code?: string }).code;
  return { ok: false as const, code: (code?.startsWith('08') || code?.startsWith('28') || ['3D000','57P01','57P02','57P03','ECONNREFUSED','ECONNRESET','EPIPE','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT'].includes(code ?? '') || (code === undefined && error instanceof Error && ['timeout exceeded when trying to connect','Connection terminated due to connection timeout','Connection terminated unexpectedly','Connection terminated'].includes(error.message))) ? 'DB_UNAVAILABLE' as const : 'SEARCH_FAILED' as const, message: describe(error) };
}
function reportDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value ? value : null;
}
export function postgresRecallStore(connect: PgConnect): RecallStore & DocumentRecallStore {
  return { async searchRecall(input) {
    const opened = connect();
    if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
    try {
      const source = input.kind === 'chunks'
        ? sql`select c.id as chunk_id, null::uuid as tool_note_id, null::uuid as message_id, null::text as tool, null::bytea as tool_raw, c.body, c.body_raw, c.from_at, c.to_at, c.session_id from brain.chunks c where c.index_config_id=${CONVERSATION_CHUNK_INDEX_CONFIG_ID}::uuid and lower(c.body) like lower(${pgText(input.pattern).text}) escape '\\'`
        : sql`select null::uuid as chunk_id, n.id as tool_note_id, m.id as message_id, n.tool, n.tool_raw, n.target as body, n.target_raw as body_raw, m.occurred_at as from_at, m.occurred_at as to_at, n.session_id from brain.tool_notes n left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw where lower(n.target) like lower(${pgText(input.pattern).text}) escape '\\'`;
      // [ASSUMPTION] 근접 단계 다음 리터럴 일치 횟수, 시각 내림차순, id 순이다.
      const rows = await sql<{ chunk_id: string | null; tool_note_id: string | null; message_id: string | null; tool: string | null; tool_raw: Buffer | null; body: string; body_raw: Buffer | null; from_at: string | null; to_at: string | null; harness: string; harness_session_id: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null }>`select x.*, s.harness, s.harness_session_id, s.started_at, s.workspace_id, s.tag_source, s.project_id, s.worktree_id from (${source}) x join brain.sessions s on s.id=x.session_id order by case when ${input.worktree ?? null}::text is not null and s.worktree_id::text=${input.worktree ?? null} then 0 when ${input.project ?? null}::text is not null and s.project_id::text=${input.project ?? null} then 1 else 2 end, (length(lower(x.body))-length(replace(lower(x.body),lower(${pgText(input.query).text}),''))) desc, x.from_at desc nulls last, coalesce(x.chunk_id,x.tool_note_id) asc limit ${input.limit}`.execute(opened.connection.db);
      return { ok: true, rows: rows.rows.map(originalText).map(r => ({ kind: 'conversation' as const, session: formatSessionToken({ harness: r.harness, harnessSessionId: r.harness_session_id }), harness: r.harness, started_at: new Date(r.started_at).toISOString(), workspace_id: r.workspace_id, tag_source: r.tag_source, project_id: r.project_id, worktree_id: r.worktree_id, from_at: r.from_at === null ? null : new Date(r.from_at).toISOString(), to_at: r.to_at === null ? null : new Date(r.to_at).toISOString(), ...(r.chunk_id ? { chunk_id: r.chunk_id } : { tool_note_id: r.tool_note_id!, message_id: r.message_id, tool: r.tool ?? '' }), body: r.body })) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return { ok: false, code: code?.startsWith('08') || code?.startsWith('28') || ['3D000', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code ?? '') || (code === undefined && error instanceof Error && ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Connection terminated unexpectedly', 'Connection terminated'].includes(error.message)) ? 'DB_UNAVAILABLE' : 'SEARCH_FAILED', message: describe(error) };
    }
  },
  async searchDocuments(input) {
    const opened=connect();if(!opened.ok)return {ok:false,code:'DB_UNAVAILABLE',message:opened.message};
    try {
      const result=await sql<{rows: Array<{file_id:string|null;display_name:string;display_name_raw:string|null;chunk_locator:string|null;ordinal:number|null;extraction_id:string|null;report_date:string|null;source:string;source_unreachable:boolean;body:string;source_file_id:string|null;source_path:string|null;source_remote_id:string|null;index_status:import('@second-brain/core').SourceIndexStatus|null;current_version:string|null;completed_version:string|null;stale:boolean|null}>;contexts:import('@second-brain/core').DocumentSearchContext[]}>`
        with all_rows as (
          select f.id as file_id,coalesce(n.text,'report:'||f.id::text) as display_name,n.text_raw as display_name_raw,c.chunk_locator,c.ordinal,e.id as extraction_id,q.report_date,q.source,f.source_unreachable_at is not null as source_unreachable,c.body,null::uuid as source_file_id,null::text as source_path,null::text as source_remote_id,null::text as index_status,null::text as current_version,null::text as completed_version,null::boolean as stale,c.id as tie_id
          from brain.files f
          join lateral (select req.source,case when req.metadata->>'report_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(req.metadata->>'report_date','date') then req.metadata->>'report_date' else null end as report_date from brain.file_request_results r join brain.file_requests req on req.id=r.request_id where r.file_id=f.id and r.error_code is null and req.metadata->>'kind'='report' order by req.created_at desc,req.id desc limit 1) q on true
          join brain.document_extractions e on e.id=f.current_extraction_id and e.file_id=f.id and e.status='ok'
          join brain.document_chunks c on c.extraction_id=e.id
          left join lateral (select text,text_raw from brain.file_names where file_id=f.id order by name_source collate "C",coalesce(text_raw,convert_to(text,'UTF8')) limit 1) n on true
          where f.redacted_at is null and lower(c.body) like lower(${pgText(input.pattern).text}) escape '\\'
          union all
          select f.id,sf.name,null::bytea,c.chunk_locator,c.ordinal,e.id,null::text,s.kind,sf.unreachable,c.body,sf.id,sf.path,sf.remote_id,sf.index_status,sf.remote_version,sf.completed_version,(sf.file_id is not null and sf.completed_version is distinct from sf.remote_version),c.id
          from brain.source_files sf join brain.sources s on s.id=sf.source_id join brain.files f on f.id=sf.file_id and f.redacted_at is null join brain.document_extractions e on e.id=f.current_extraction_id and e.file_id=f.id and e.status='ok' join brain.document_chunks c on c.extraction_id=e.id
          where s.kind='drive' and lower(c.body) like lower(${pgText(input.pattern).text}) escape '\\'
          union all
          select sf.file_id,sf.name,null::bytea,null::text,null::integer,null::uuid,null::text,s.kind,sf.unreachable,''::text,sf.id,sf.path,sf.remote_id,sf.index_status,sf.remote_version,sf.completed_version,(sf.file_id is not null and sf.completed_version is distinct from sf.remote_version),sf.id
          from brain.source_files sf join brain.sources s on s.id=sf.source_id left join brain.files f on f.id=sf.file_id
          where s.kind='drive' and (sf.file_id is null or f.redacted_at is null) and (lower(sf.name) like lower(${pgText(input.pattern).text}) escape '\\' or lower(sf.path) like lower(${pgText(input.pattern).text}) escape '\\')
        ), candidates as materialized (
          select *,row_number() over(order by (length(lower(body))-length(replace(lower(body),lower(${pgText(input.query).text}),''))) desc,report_date collate "C" desc nulls last,file_id nulls last,source_file_id nulls last,ordinal nulls last,tie_id) as rank from all_rows
          order by rank limit ${input.limit}
        ), contexts as (
          select ids.extraction_id,jsonb_agg(jsonb_build_object('ordinal',x.ordinal,'chunk_locator',x.chunk_locator,'body',x.body) order by x.ordinal) as pieces from (select distinct extraction_id from candidates where extraction_id is not null) ids join brain.document_chunks x on x.extraction_id=ids.extraction_id group by ids.extraction_id
        )
        select coalesce((select jsonb_agg((to_jsonb(candidates)-'rank'-'tie_id') || jsonb_build_object('display_name_raw',encode(display_name_raw,'base64')) order by rank) from candidates),'[]'::jsonb) as rows,coalesce((select jsonb_agg(to_jsonb(contexts)) from contexts),'[]'::jsonb) as contexts`.execute(opened.connection.db);
      const data=result.rows[0]!;
      return {ok:true,rows:data.rows.map(r=>{const decoded=originalText({...r,display_name_raw:r.display_name_raw===null?null:Buffer.from(r.display_name_raw,'base64')});const {display_name_raw:_raw,source_file_id,source_path,source_remote_id,index_status,current_version,completed_version,stale,...rest}=decoded;return {...rest,kind:'document' as const,report_date:reportDate(rest.report_date),...(source_file_id!==null&&source_path!==null&&source_remote_id!==null&&index_status!==null?{source_file_id,source_path,source_remote_id,index_status,current_version:current_version!,completed_version,stale:stale!}:{})};}),contexts:data.contexts};
    }catch(error){return documentError(error);}
  },
  async readSourceDocument(sourceFileId) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceFileId))return {ok:true,source:null};
    const opened=connect();if(!opened.ok)return {ok:false,code:'DB_UNAVAILABLE',message:opened.message};
    try {const result=await sql<import('@second-brain/core').SourceDocument>`select sf.id as source_file_id,sf.file_id,sf.name as display_name,sf.path as source_path,sf.remote_id as source_remote_id,s.kind as source,sf.index_status,sf.unreachable as source_unreachable,sf.remote_version as current_version,sf.completed_version,(sf.file_id is not null and sf.completed_version is distinct from sf.remote_version) as stale from brain.source_files sf join brain.sources s on s.id=sf.source_id left join brain.files f on f.id=sf.file_id where sf.id=${sourceFileId}::uuid and s.kind='drive' and (sf.file_id is null or f.redacted_at is null)`.execute(opened.connection.db);return {ok:true,source:result.rows[0]??null};}catch(error){if(['42P01','3F000'].includes((error as {code?:string}).code??''))return {ok:false,code:'DB_UNAVAILABLE',message:describe(error)};return documentError(error);}
  },
  async readDocument(fileId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return { ok: true, snapshot: null };
    const opened = connect(); if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
    try {
      const result = await sql<{redacted: boolean; source_unreachable: boolean; extraction_id: string | null; status: import('@second-brain/core').DocumentExtractionStatus | 'pending' | null; pieces: {ordinal: number; chunk_locator: string; body: string}[]}>`
        select f.redacted_at is not null as redacted, f.source_unreachable_at is not null as source_unreachable,
          f.current_extraction_id as extraction_id,
          coalesce(cur.status, latest.status, case when latest.id is not null then 'pending' end) as status,
          case when f.redacted_at is not null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('ordinal', c.ordinal, 'chunk_locator', c.chunk_locator, 'body', c.body) order by c.ordinal)
            from brain.document_chunks c where c.extraction_id=cur.id and cur.status='ok'), '[]'::jsonb) end as pieces
        from brain.files f left join brain.document_extractions cur on cur.id=f.current_extraction_id and cur.file_id=f.id
        left join lateral (select id,status from brain.document_extractions where file_id=f.id order by attempt desc limit 1) latest on true
        where f.id=${fileId}::uuid`.execute(opened.connection.db);
      return { ok: true, snapshot: result.rows[0] ?? null };
    } catch (error) { return documentError(error); }
  } };
}
