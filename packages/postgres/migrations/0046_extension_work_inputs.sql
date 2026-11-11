-- 수동 일감의 입력을 접수 시 고정하고 현재 소유 attempt에만 공개한다.
create table brain.extension_work_inputs (
 work_id uuid primary key references brain.work_items(id),
 input jsonb not null check(jsonb_typeof(input)='object' and octet_length(input::text)<=32768)
);
grant select,insert on brain.extension_work_inputs to brain_app;
create function brain.extension_work_input(p_work uuid,p_attempt uuid)
 returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if session_user !~ '^brain_ext_[a-z][a-z0-9_]{0,30}$'
   or not brain.attempt_is_current(p_work,p_attempt)
   or not exists(select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind
     where w.id=p_work and k.extension_name=substring(session_user from 11))
 then raise exception 'invalid attempt' using errcode='42501'; end if;
 return (select input from brain.extension_work_inputs where work_id=p_work);
end $$;
revoke all on function brain.extension_work_input(uuid,uuid) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname ~ '^brain_ext_[a-z][a-z0-9_]{0,30}$'
   and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_work_input(uuid,uuid) to %I',r.rolname);
 end loop;
end $$;
