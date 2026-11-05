-- Keep the shared file-request fences while removing the analysis branch.
create or replace function brain.guard_import_attempt() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
 return new;
end $$;
create or replace function brain.reconcile_import_target() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; incoming jsonb;
begin
 if session_user not like 'brain\_ext\_%' escape '\' then return new; end if;
 if session_user <> 'brain_ext_' || new.source then raise exception '다른 출처' using errcode='42501'; end if;
 if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source) then raise exception '오래된 시도' using errcode='BRS01'; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.source,new.request_key)::text,2));
 select to_jsonb(t) into previous from brain.file_requests t where t.id=new.id or (t.source,t.request_key)=(new.source,new.request_key) limit 1;
 if previous is null then return new; end if;
 incoming=to_jsonb(new);
 if (previous - 'source_work_item_id' - 'source_attempt_token') is distinct from (incoming - 'source_work_item_id' - 'source_attempt_token') then raise exception '가져오기 대상 충돌' using errcode='P0001'; end if;
 return null;
end $$;
drop view brain.health_current_v1;
drop view brain.health_resolution_v1;
drop function brain.health_aggregate_v1(text,text,text,text);
drop function brain.health_json_comparison(jsonb,bytea,text);
drop function brain.health_text_comparison(text,bytea,text);
drop function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean);
drop table brain.analysis_files;
drop table brain.analysis_artifacts;
drop table brain.analyses;
drop table brain.analysis_snapshots;
drop function brain.reconcile_analysis_artifact();
drop function brain.guard_analysis_dataset();
drop table brain.health_observations;
drop table brain.health_authority_rules;
drop table brain.health_supported_versions;
drop table brain.health_catalog_v1;
drop function brain.validate_health_observation();
