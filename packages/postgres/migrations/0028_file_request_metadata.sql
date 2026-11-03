-- File producers can attach bounded, non-content identifying metadata to a request.
-- Existing requests retain the empty object and the immutable reconciliation trigger
-- compares metadata as part of the request payload.
alter table brain.file_requests add column metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384);
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\'
   and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant insert (metadata) on brain.file_requests to %I', r.rolname);
 end loop;
end $$;
-- Core records only the supervisor-validated public collect result.
alter table brain.work_attempts add column result_summary jsonb
  check (result_summary is null or (jsonb_typeof(result_summary) = 'object' and octet_length(result_summary::text) <= 2048));
alter table brain.work_attempts add column previous_result jsonb;
alter table brain.extension_work_kinds add column followup_kind text
  references brain.extension_work_kinds(kind) on delete set null
  check (followup_kind is null or followup_kind <> kind);

-- A supervised extension can inspect only successful direct predecessors from
-- its own extension, and only while its own attempt is current.
create function brain.extension_predecessor_results(work_id uuid, attempt_token uuid)
returns table(id uuid, kind text, target_kind text, target_id text, result_summary jsonb, previous_result jsonb)
language plpgsql security definer set search_path='' as $$
begin
 if not brain.attempt_is_current(work_id, attempt_token) or not exists (
   select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind
   where w.id=work_id and session_user='brain_ext_' || k.extension_name
 ) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
 return query
 select p.id, p.kind, p.target_kind, p.target_id, a.result_summary,
   a.previous_result
 from brain.work_dependencies d
 join brain.work_items p on p.id=d.prerequisite_id
 join brain.extension_work_kinds k on k.kind=p.kind
 join brain.work_attempts a on a.work_item_id=p.id and a.outcome='succeeded'
 where d.work_item_id=work_id and p.outcome='succeeded' and p.completed_at is not null
   and session_user='brain_ext_' || k.extension_name;
end $$;
revoke all on function brain.extension_predecessor_results(uuid,uuid) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\'
   and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_predecessor_results(uuid,uuid) to %I', r.rolname);
 end loop;
end $$;
