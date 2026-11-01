-- 예상 밖 role 권한을 조용히 정상으로 취급하지 않는다.
do $$
begin
 if exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('brain_app','brain_ext_garmin')
   and (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls
     or exists (select 1 from pg_catalog.pg_auth_members m where m.member=r.oid or m.roleid=r.oid)))
 then raise exception 'PROTECTION_ROLE_CONFLICT'; end if;
end $$;

-- 보호 서비스 경계가 준비될 때까지 기존 사용자 자격으로 보호 사실을 변경하지 않는다.
-- 역할 provisioning과 제한 API는 별도 보호 경계에서 연결한다.
revoke create on schema garmin from public, brain_app, brain_ext_garmin;
alter default privileges for role brain_owner in schema garmin revoke all on tables from brain_ext_garmin;
alter default privileges for role brain_owner in schema garmin revoke all on sequences from brain_ext_garmin;
alter default privileges for role brain_owner in schema garmin revoke execute on functions from brain_ext_garmin;
alter default privileges for role brain_owner revoke execute on functions from public;

revoke all on garmin.account_protection, garmin.tokenstore_identity, garmin.account_binding,
 garmin.external_call_intent, garmin.probe_reservation, garmin.first_call_budget,
 garmin.admission_holder, garmin.auth_success_evidence, garmin.protection_release_events
 from public, brain_app, brain_ext_garmin;
revoke all on function garmin.reserve_admission(uuid,uuid,bigint,text,bigint,text),
 garmin.reserve_work_admission(uuid,uuid,bigint,text,text),
 garmin.release_work_admission(uuid,uuid),
 garmin.admission_valid(uuid,uuid,bigint,text,bigint),
 garmin.bind_admitted_profile(uuid,uuid,bigint,text,bigint,text),
 garmin.release_protection(uuid,uuid,text),
 garmin.complete_verified_auth(uuid,uuid,bigint,text,bigint,text),
 garmin.start_external_call(uuid,uuid,bigint,text,bigint,text,text,text,date,boolean),
 garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text)
 from public, brain_app, brain_ext_garmin;
