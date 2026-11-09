import { CONVERSATION_CHUNK_INDEX_CONFIG_ID, driveSourceUrl, formatSessionToken, type RecallStore, type DocumentRecallStore } from '@second-brain/core';
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
      // A negative probe linearizes at this SELECT; a positive probe uses only
      // the later full SELECT's snapshot for ranking and returned rows.
      // Leave invalid or zero limits to the original query and its error semantics.
      if (Number.isSafeInteger(input.limit) && input.limit > 0) {
        const pattern = pgText(input.pattern).text;
        // Plan candidate retrieval independently of the outer LIMIT while letting
        // the executor stop once the parent has consumed a matching row.
        const found = input.kind === 'chunks'
          ? await sql`with candidates as materialized (select 1 as present from brain.chunks where index_config_id=${CONVERSATION_CHUNK_INDEX_CONFIG_ID}::uuid and lower(body) like lower(${pattern}) escape '\\') select present from candidates limit 1`.execute(opened.connection.db)
          : await sql`with candidates as materialized (select 1 as present from brain.tool_notes where lower(target) like lower(${pattern}) escape '\\') select present from candidates limit 1`.execute(opened.connection.db);
        if (found.rows.length === 0) return { ok: true, rows: [] };
      }
      const query = pgText(input.query).text!;
      let shortToolQuery = false;
      if (input.kind === 'tools') {
        let count = 0;
        for (const _point of query) { if (++count === 3) break; }
        shortToolQuery = count > 0 && count < 3;
      }
      const source = input.kind === 'chunks' ? sql`select c.id as chunk_id, null::uuid as tool_note_id, null::uuid as message_id, null::text as tool, null::bytea as tool_raw, c.body, c.body_raw, c.from_at, c.to_at, c.session_id from brain.chunks c where c.index_config_id=${CONVERSATION_CHUNK_INDEX_CONFIG_ID}::uuid and lower(c.body) like lower(${pgText(input.pattern).text}) escape '\\'` : null;
      // [ASSUMPTION] 근접 단계 다음 리터럴 일치 횟수, 시각 내림차순, id 순이다.
      // 검증된 ASCII 분기에서만 C lower가 원문 바이트 길이를 보존한다.
      // 도구 후보가 많을 때만 좁은 메시지 관계를 일괄 결합한다. 경계는 실제 후보 수다.
      const rows = input.kind === 'chunks' ? await sql<{ chunk_id: string | null; tool_note_id: string | null; message_id: string | null; tool: string | null; tool_raw: Buffer | null; body: string; body_raw: Buffer | null; from_at: string | null; to_at: string | null; harness: string; harness_session_id: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null }>`select x.*, s.harness, s.harness_session_id, s.started_at, s.workspace_id, s.tag_source, s.project_id, s.worktree_id from (${source}) x join brain.sessions s on s.id=x.session_id order by case when ${input.worktree ?? null}::text is not null and s.worktree_id::text=${input.worktree ?? null} then 0 when ${input.project ?? null}::text is not null and s.project_id::text=${input.project ?? null} then 1 else 2 end, (case when (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') and octet_length(x.body) = length(x.body) then octet_length(x.body)-octet_length(replace(lower(x.body collate "C"),lower(${query}),'')) else octet_length(lower(x.body))-octet_length(replace(lower(x.body),lower(${query}),'')) end) desc, x.from_at desc nulls last, coalesce(x.chunk_id,x.tool_note_id) asc limit ${input.limit}`.execute(opened.connection.db) : shortToolQuery ? await sql<{ chunk_id: string | null; tool_note_id: string | null; message_id: string | null; tool: string | null; tool_raw: Buffer | null; body: string; body_raw: Buffer | null; from_at: string | null; to_at: string | null; harness: string; harness_session_id: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null }>`
        select null::uuid as chunk_id, n.id as tool_note_id, m.id as message_id, n.tool, n.tool_raw, n.target as body, n.target_raw as body_raw,
          m.occurred_at as from_at, m.occurred_at as to_at, n.session_id, s.harness, s.harness_session_id, s.started_at, s.workspace_id, s.tag_source, s.project_id, s.worktree_id
        from brain.tool_notes n
        left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw
        join brain.sessions s on s.id=n.session_id
        where lower(n.target) like lower(${pgText(input.pattern).text}) escape '\\'
        order by case when ${input.worktree ?? null}::text is not null and s.worktree_id::text=${input.worktree ?? null} then 0 when ${input.project ?? null}::text is not null and s.project_id::text=${input.project ?? null} then 1 else 2 end,
          (case when (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') and octet_length(n.target) = length(n.target)
            then octet_length(n.target)-octet_length(replace(lower(n.target collate "C"),lower(${query}),''))
            else octet_length(lower(n.target))-octet_length(replace(lower(n.target),lower(${query}),'')) end) desc,
          m.occurred_at desc nulls last, n.id asc limit ${input.limit}`.execute(opened.connection.db) : await sql<{ chunk_id: string | null; tool_note_id: string | null; message_id: string | null; tool: string | null; tool_raw: Buffer | null; body: string; body_raw: Buffer | null; from_at: string | null; to_at: string | null; harness: string; harness_session_id: string; started_at: string; workspace_id: string | null; tag_source: string | null; project_id: string | null; worktree_id: string | null }>`
        with matched as materialized (
          select n.id, n.session_id, n.harness_message_id, n.harness_message_id_raw,
            (case when (select current_setting('server_encoding') = 'UTF8' and lower('ABCDEFGHIJKLMNOPQRSTUVWXYZ') collate "C" = 'abcdefghijklmnopqrstuvwxyz') and octet_length(n.target) = length(n.target)
              then octet_length(n.target)-octet_length(replace(lower(n.target collate "C"),lower(${query}),''))
              else octet_length(lower(n.target))-octet_length(replace(lower(n.target),lower(${query}),'')) end) as score
          from brain.tool_notes n where lower(n.target) like lower(${pgText(input.pattern).text}) escape '\\'
        ), mode as materialized (select count(*) > 256 as use_batch from matched),
        batch_messages as materialized (
          select m.id, m.session_id, m.harness_message_id, m.harness_message_id_raw, m.occurred_at
          from brain.messages m where (select use_batch from mode)
        ), joined as (
          select n.id, n.session_id, n.score, m.id as message_id, m.occurred_at
          from matched n left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw
          where not (select use_batch from mode)
          union all
          select n.id, n.session_id, n.score, m.id as message_id, m.occurred_at
          from matched n left join batch_messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw
          where (select use_batch from mode)
        ), ranked as materialized (
          select j.*, case when ${input.worktree ?? null}::text is not null and s.worktree_id::text=${input.worktree ?? null} then 0 when ${input.project ?? null}::text is not null and s.project_id::text=${input.project ?? null} then 1 else 2 end as proximity
          from joined j join brain.sessions s on s.id=j.session_id
          order by proximity, j.score desc, j.occurred_at desc nulls last, j.id asc limit ${input.limit}
        )
        select null::uuid as chunk_id, n.id as tool_note_id, r.message_id, n.tool, n.tool_raw, n.target as body, n.target_raw as body_raw,
          r.occurred_at as from_at, r.occurred_at as to_at, n.session_id, s.harness, s.harness_session_id, s.started_at, s.workspace_id, s.tag_source, s.project_id, s.worktree_id
        from ranked r join brain.tool_notes n on n.id=r.id join brain.sessions s on s.id=r.session_id
        order by r.proximity, r.score desc, r.occurred_at desc nulls last, r.id asc`.execute(opened.connection.db);
      return { ok: true, rows: rows.rows.map(originalText).map(r => ({ kind: 'conversation' as const, session: formatSessionToken({ harness: r.harness, harnessSessionId: r.harness_session_id }), harness: r.harness, started_at: new Date(r.started_at).toISOString(), workspace_id: r.workspace_id, tag_source: r.tag_source, project_id: r.project_id, worktree_id: r.worktree_id, from_at: r.from_at === null ? null : new Date(r.from_at).toISOString(), to_at: r.to_at === null ? null : new Date(r.to_at).toISOString(), ...(r.chunk_id ? { chunk_id: r.chunk_id } : { tool_note_id: r.tool_note_id!, message_id: r.message_id, tool: r.tool ?? '' }), body: r.body })) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return { ok: false, code: code?.startsWith('08') || code?.startsWith('28') || ['3D000', '57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code ?? '') || (code === undefined && error instanceof Error && ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Connection terminated unexpectedly', 'Connection terminated'].includes(error.message)) ? 'DB_UNAVAILABLE' : 'SEARCH_FAILED', message: describe(error) };
    }
  },
  async searchDocuments(input) {
    const opened=connect();if(!opened.ok)return {ok:false,code:'DB_UNAVAILABLE',message:opened.message};
    try {
      const pattern = pgText(input.pattern).text;
      return await opened.connection.db.transaction().execute(async held => {
      await sql`set transaction isolation level repeatable read read only`.execute(held);
      const sources=await sql<{id:string;remote_id:string}>`select sf.id,sf.remote_id from brain.source_files sf join brain.sources s on s.id=sf.source_id left join brain.files f on f.id=sf.file_id where s.kind='drive' and (sf.file_id is null or (f.id is not null and f.redacted_at is null))`.execute(held);
      const safeIds=sources.rows.filter(source=>driveSourceUrl(source.remote_id)!==null).map(source=>source.id);
      const result=await sql<{rows: import('@second-brain/core').DocumentSearchRow[];contexts:import('@second-brain/core').DocumentSearchContext[]}>`
        with valid_sources as materialized (
          select sf.*,s.kind from brain.source_files sf join brain.sources s on s.id=sf.source_id left join brain.files f on f.id=sf.file_id
          where sf.id = any(${safeIds}::uuid[]) and s.kind='drive' and (sf.file_id is null or (f.id is not null and f.redacted_at is null))
        ), eligible_names as materialized (
          select n.* from brain.file_names n join brain.files f on f.id=n.file_id and f.redacted_at is null
          where n.name_source='attachment_name' or (n.name_source='location_path' and exists(select 1 from brain.file_locations l where l.file_id=n.file_id and l.store_kind='local' and l.ownership='external' and l.deleted_at is null and l.locator=n.text and l.locator ~ '^~/([^/]+/)*[^/]+$' and l.locator !~ '(^|/)[.]{1,2}(/|$)' and l.locator !~ '[[:cntrl:]]'))
        ), files as materialized (
          select f.id,f.current_extraction_id,
            case when exists(select 1 from brain.file_locations l where l.file_id=f.id and l.deleted_at is null) or exists(select 1 from valid_sources sf where sf.file_id=f.id and not sf.unreachable) then false else f.source_unreachable_at is not null or exists(select 1 from valid_sources sf where sf.file_id=f.id) end as unreachable,
            q.source is not null as report_provenance,
            coalesce(n.text, case when q.source is not null then 'report:'||f.id::text else sf.name end, f.id::text) as display_name,
            n.text_raw as display_name_raw, q.source as report_source,q.report_date,
            case when q.source is not null then q.source when exists(select 1 from brain.message_attachments a where a.file_id=f.id) or exists(select 1 from eligible_names en where en.file_id=f.id) then 'attachment' when sf.id is not null then 'drive' else 'attachment' end as representative_source,
            coalesce(cur.status,latest.status,'pending') as file_status,
            coalesce((select jsonb_agg(jsonb_build_object('text',en.text,'text_raw',encode(en.text_raw,'base64')) order by coalesce(en.text_raw,convert_to(en.text,'UTF8')),en.name_source collate "C") from eligible_names en where en.file_id=f.id),'[]'::jsonb) as names
          from brain.files f
          left join lateral (select req.source,case when req.metadata->>'report_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(req.metadata->>'report_date','date') then req.metadata->>'report_date' else null end as report_date from brain.file_request_results r join brain.file_requests req on req.id=r.request_id where r.file_id=f.id and r.error_code is null and req.metadata->>'kind'='report' order by req.created_at desc,req.id desc limit 1) q on true
          left join lateral (select text,text_raw from eligible_names where file_id=f.id order by name_source collate "C",coalesce(text_raw,convert_to(text,'UTF8')) limit 1) n on true
          left join lateral (select id,name from valid_sources where file_id=f.id order by id limit 1) sf on true
          left join brain.document_extractions cur on cur.id=f.current_extraction_id and cur.file_id=f.id
          left join lateral (select status from brain.document_extractions where file_id=f.id order by attempt desc limit 1) latest on true
          where f.redacted_at is null and (q.source is not null or exists(select 1 from brain.message_attachments a where a.file_id=f.id) or exists(select 1 from eligible_names en where en.file_id=f.id) or sf.id is not null)
        ), origins as materialized (
          select f.id as file_id, jsonb_build_object('kind','location','location_id',l.id,'store_kind',l.store_kind,'locator',l.locator,'ownership',l.ownership,'display_name',f.display_name,'source_unreachable',false) as origin, '0:'||l.id::text as sort_key
          from files f join brain.file_locations l on l.file_id=f.id and l.deleted_at is null
          union all
          select sf.file_id, jsonb_build_object('kind','drive','source_file_id',sf.id,'source_remote_id',sf.remote_id,'display_name',sf.name,'source_path',sf.path,'index_status',sf.index_status,'source_unreachable',sf.unreachable,'current_version',sf.remote_version,'completed_version',sf.completed_version,'stale',sf.file_id is not null and sf.completed_version is distinct from sf.remote_version), '1:'||sf.id::text from valid_sources sf
        ), hits as (
          select f.id as file_id,f.display_name,f.display_name_raw,c.chunk_locator,min(c.ordinal) as ordinal,array_agg(c.ordinal order by c.ordinal) as ordinals,e.id as extraction_id,f.report_date,f.representative_source as source,f.unreachable as source_unreachable,f.report_provenance,(array_agg(c.body order by (length(lower(c.body))-length(replace(lower(c.body),lower(${pgText(input.query).text}),''))) desc,c.ordinal))[1] as body,(array_agg(c.id order by c.ordinal))[1] as tie_id,f.file_status,null::uuid as source_file_id,f.names
          from files f join brain.document_extractions e on e.id=f.current_extraction_id and e.file_id=f.id and e.status='ok' join brain.document_chunks c on c.extraction_id=e.id
          where lower(c.body) like lower(${pattern}) escape '\\'
          group by f.id,f.display_name,f.display_name_raw,c.chunk_locator,e.id,f.report_date,f.representative_source,f.unreachable,f.report_provenance,f.file_status,f.names
          union all
          select f.id,f.display_name,f.display_name_raw,null::text,null::integer,null::integer[],null::uuid,f.report_date,f.representative_source,f.unreachable,f.report_provenance,''::text,f.id,f.file_status,null::uuid,f.names
          from files f where (exists(select 1 from eligible_names n where n.file_id=f.id and lower(n.text) like lower(${pattern}) escape '\\') or exists(select 1 from valid_sources sf where sf.file_id=f.id and (lower(sf.name) like lower(${pattern}) escape '\\' or lower(sf.path) like lower(${pattern}) escape '\\')))
          and not exists(select 1 from brain.document_extractions e join brain.document_chunks c on c.extraction_id=e.id where e.id=f.current_extraction_id and e.file_id=f.id and e.status='ok' and lower(c.body) like lower(${pattern}) escape '\\')
          union all
          select null::uuid,sf.name,null::bytea,null::text,null::integer,null::integer[],null::uuid,null::text,sf.kind,sf.unreachable,false,''::text,sf.id,null::text,sf.id,'[]'::jsonb
          from valid_sources sf where sf.file_id is null and (lower(sf.name) like lower(${pattern}) escape '\\' or lower(sf.path) like lower(${pattern}) escape '\\')
        ), candidates as materialized (
          select *, row_number() over(order by (length(lower(body))-length(replace(lower(body),lower(${pgText(input.query).text}),''))) desc,report_date collate "C" desc nulls last,file_id nulls last,source_file_id nulls last,ordinal nulls last,tie_id) as rank from hits
          order by rank limit ${input.limit}
        ), contexts as (
          select ids.extraction_id,jsonb_agg(jsonb_build_object('ordinal',x.ordinal,'chunk_locator',x.chunk_locator,'body',x.body) order by x.ordinal) as pieces from (select distinct extraction_id from candidates where extraction_id is not null) ids join brain.document_chunks x on x.extraction_id=ids.extraction_id group by ids.extraction_id
        )
        select coalesce((select jsonb_agg((to_jsonb(candidates)-'rank'-'tie_id'-'display_name_raw') || jsonb_build_object('display_name_raw',encode(display_name_raw,'base64'),'internal_origins',coalesce((select jsonb_agg(origin order by sort_key) from origins o where o.file_id=candidates.file_id or (candidates.file_id is null and o.origin->>'source_file_id'=candidates.source_file_id::text)),'[]'::jsonb)) order by rank) from candidates),'[]'::jsonb) as rows,coalesce((select jsonb_agg(to_jsonb(contexts)) from contexts),'[]'::jsonb) as contexts`.execute(held);
      const data=result.rows[0]!;
      return {ok:true,rows:data.rows.map(raw=>{const r=raw as typeof raw & {display_name_raw:string|null};const decoded=originalText({...r,display_name_raw:r.display_name_raw===null?null:Buffer.from(r.display_name_raw,'base64')});const {display_name_raw:_raw,...rest}=decoded;const names=[...new Set(((rest.names??[]) as unknown as {text:string;text_raw:string|null}[]).map(n=>originalText({...n,text_raw:n.text_raw===null?null:Buffer.from(n.text_raw,'base64')}).text))];const first=rest.internal_origins?.find(o=>o.kind==='drive');return {...rest,names,kind:'document' as const,report_date:reportDate(rest.report_date),...(first?.kind==='drive'?{source_file_id:first.source_file_id,source_path:first.source_path,source_remote_id:first.source_remote_id,index_status:first.index_status,current_version:first.current_version,completed_version:first.completed_version,stale:first.stale}:{} )};}),contexts:data.contexts};
      });
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
