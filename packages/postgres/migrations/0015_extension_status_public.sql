-- 트리거 함수 실행에 호출자의 EXECUTE는 필요하지 않다.
-- 확장에 공개하는 core 함수는 attempt 확인 함수뿐이다.
revoke execute on all functions in schema brain from public;
grant execute on function brain.attempt_is_current(uuid, uuid) to public;
alter default privileges for role brain_owner revoke execute on functions from public;
create view brain.extension_status_public_v1 with (security_barrier = true) as
select name, enabled, connection_status from brain.extensions
where current_user = 'brain_app' or current_user = 'brain_ext_' || name;
revoke all on brain.extension_status_public_v1 from public, brain_app;
grant select on brain.extension_status_public_v1 to brain_app;
do $$
declare r record;
begin
  for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\'
    and shobj_description(oid, 'pg_authid') = 'second-brain extension:' || current_database()
  loop
    if exists (select 1 from pg_roles where rolname=r.rolname and (not rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication))
      or exists (select 1 from pg_auth_members m join pg_roles x on x.oid=m.member or x.oid=m.roleid where x.rolname=r.rolname) then
      raise exception '확장 역할 충돌';
    end if;
    if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='brain' and c.relkind in ('r','p','v','m','S','f')
        and (case when c.relname='extension_status_public_v1' then
          has_table_privilege(r.rolname,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege(r.rolname,c.oid,'INSERT,UPDATE,REFERENCES')
        else has_table_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') end))
      or exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='brain' and p.oid <> 'brain.attempt_is_current(uuid,uuid)'::regprocedure and has_function_privilege(r.rolname,p.oid,'EXECUTE')) then
      raise exception '확장 역할에 허용되지 않은 권한';
    end if;
    if exists (select 1 from pg_namespace n where n.nspname <> substr(r.rolname, 11)
      and n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
      and has_schema_privilege(r.rolname,n.oid,'CREATE')) then
      raise exception '확장 역할에 허용되지 않은 schema 생성 권한';
    end if;
    if exists (select 1 from pg_namespace n where n.nspname <> substr(r.rolname, 11)
      and n.nspname not in ('brain', 'public', 'information_schema') and n.nspname not like 'pg_%'
      and has_schema_privilege(r.rolname,n.oid,'USAGE')) then
      raise exception '확장 역할에 허용되지 않은 schema 권한';
    end if;
    execute format('grant select on brain.extension_status_public_v1 to %I', r.rolname);
  end loop;
end $$;
