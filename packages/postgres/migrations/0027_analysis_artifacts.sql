-- 분석 원문과 역할별 요청은 불변이며 확정 파일은 core 결과에서 조회한다.
alter table brain.analyses add column report_date text;
alter table brain.analyses add column report_date_raw bytea, add column report_date_encoding text, add constraint analyses_report_date_pair check ((report_date_raw is null)=(report_date_encoding is null) and (report_date_raw is null or report_date is not null) and (report_date_encoding is null or report_date_encoding in ('utf-8','utf-16le','utf-16be','json-string-v1')));
alter table brain.analyses add column scope text;
alter table brain.analyses add column scope_raw bytea, add column scope_encoding text, add constraint analyses_scope_pair check ((scope_raw is null)=(scope_encoding is null) and (scope_raw is null or scope is not null) and (scope_encoding is null or scope_encoding in ('utf-8','utf-16le','utf-16be','json-string-v1')));
alter table brain.analyses add column summary text;
alter table brain.analyses add column summary_raw bytea, add column summary_encoding text, add constraint analyses_summary_pair check ((summary_raw is null)=(summary_encoding is null) and (summary_raw is null or summary is not null) and (summary_encoding is null or summary_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.analyses add column judgments text;
alter table brain.analyses add column judgments_raw bytea, add column judgments_encoding text, add constraint analyses_judgments_pair check ((judgments_raw is null)=(judgments_encoding is null) and (judgments_raw is null or judgments is not null) and (judgments_encoding is null or judgments_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.analyses add column evidence text;
alter table brain.analyses add column evidence_raw bytea, add column evidence_encoding text, add constraint analyses_evidence_pair check ((evidence_raw is null)=(evidence_encoding is null) and (evidence_raw is null or evidence is not null) and (evidence_encoding is null or evidence_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.analyses add column next_checks text;
alter table brain.analyses add column next_checks_raw bytea, add column next_checks_encoding text, add constraint analyses_next_checks_pair check ((next_checks_raw is null)=(next_checks_encoding is null) and (next_checks_raw is null or next_checks is not null) and (next_checks_encoding is null or next_checks_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.analyses add column report_md text;
alter table brain.analyses add column report_md_raw bytea, add column report_md_encoding text, add constraint analyses_report_md_pair check ((report_md_raw is null)=(report_md_encoding is null) and (report_md_raw is null or report_md is not null) and (report_md_encoding is null or report_md_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.analyses add column model_raw bytea, add column model_encoding text, add constraint analyses_model_pair check ((model_raw is null)=(model_encoding is null) and (model_raw is null or model is not null) and (model_encoding is null or model_encoding in ('utf-8','utf-16le','utf-16be','json-string-v1')));
create table brain.analysis_artifacts (
 id uuid primary key, source text not null, dataset text not null, import_batch text not null,
 analysis_id uuid not null references brain.analyses(id), file_request_id uuid not null references brain.file_requests(id),
 role text not null check (role in ('primary','image','input','source_file')),
 source_work_item_id uuid not null references brain.work_items(id), source_attempt_token uuid not null,
 unique(analysis_id,file_request_id,role)
);
alter table brain.analysis_artifacts enable row level security;
create policy import_app on brain.analysis_artifacts to brain_app using (true) with check (true);
create policy import_extension on brain.analysis_artifacts for insert with check (current_user='brain_ext_' || source);
create function brain.reconcile_analysis_artifact() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb;
begin
 if session_user like 'brain\_ext\_%' escape '\' then
  if session_user <> 'brain_ext_' || new.source then raise exception '다른 출처' using errcode='42501'; end if;
  if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source) then raise exception '오래된 시도' using errcode='BRS01'; end if;
 end if;
 if not exists (select 1 from brain.analyses a join brain.file_requests f on f.id=new.file_request_id where a.id=new.analysis_id and a.source=new.source and f.source=new.source and a.dataset=new.dataset and f.dataset=new.dataset and (new.role <> 'primary' or a.file_request_id=new.file_request_id)) then raise exception '다른 출처 또는 dataset 관계'; end if;
 if session_user not like 'brain\_ext\_%' escape '\' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.analysis_id,new.file_request_id,new.role)::text,5));
 select to_jsonb(t) into previous from brain.analysis_artifacts t where t.id=new.id or (t.analysis_id,t.file_request_id,t.role)=(new.analysis_id,new.file_request_id,new.role) limit 1;
 if previous is null then return new; end if;
 if (previous - 'source_work_item_id' - 'source_attempt_token') is distinct from (to_jsonb(new) - 'source_work_item_id' - 'source_attempt_token') then raise exception '분석 관계 충돌' using errcode='P0001'; end if;
 return null;
end $$;
revoke all on function brain.reconcile_analysis_artifact() from public;
create trigger a_artifact_reconcile before insert on brain.analysis_artifacts for each row execute function brain.reconcile_analysis_artifact();
create trigger import_immutable before update or delete on brain.analysis_artifacts for each row execute function brain.reject_import_mutation();
revoke all on brain.analysis_artifacts from public;
grant select,insert on brain.analysis_artifacts to brain_app;
-- 결과 확정과 같은 트랜잭션에서 정리 대상을 남기며, 완료 전에는 생기지 않는다.
create table brain.file_import_cleanup (request_id uuid primary key references brain.file_requests(id), cleaned_at timestamptz, deleting_at timestamptz);
grant select,insert,update on brain.file_import_cleanup to brain_app;
revoke all on brain.file_import_cleanup from public;
create function brain.queue_import_cleanup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.file_id is not null then insert into brain.file_import_cleanup(request_id) values (new.request_id) on conflict do nothing; end if;
 return new;
end $$;
revoke all on function brain.queue_import_cleanup() from public;
create trigger queue_import_cleanup after insert or update on brain.file_request_results for each row execute function brain.queue_import_cleanup();
-- 기존 완료 결과도 정리 대상을 재발견한다.
insert into brain.file_import_cleanup(request_id) select request_id from brain.file_request_results where file_id is not null on conflict do nothing;
create function brain.guard_analysis_dataset() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists (select 1 from brain.file_requests f where f.id=new.file_request_id and f.source=new.source and f.dataset=new.dataset) then raise exception '다른 출처 또는 dataset 파일 요청'; end if;
 return new;
end $$;
revoke all on function brain.guard_analysis_dataset() from public;
create trigger analysis_dataset before insert on brain.analyses for each row execute function brain.guard_analysis_dataset();
do $$ declare r record; begin for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
 execute format('grant insert (report_date,report_date_raw,report_date_encoding,scope,scope_raw,scope_encoding,summary,summary_raw,summary_encoding,judgments,judgments_raw,judgments_encoding,evidence,evidence_raw,evidence_encoding,next_checks,next_checks_raw,next_checks_encoding,report_md,report_md_raw,report_md_encoding,model_raw,model_encoding) on brain.analyses to %I',r.rolname);
 execute format('grant insert (id,source,dataset,import_batch,analysis_id,file_request_id,role,source_work_item_id,source_attempt_token) on brain.analysis_artifacts to %I',r.rolname);
end loop; end $$;

-- 새 요청과 삭제가 같은 locator에서 서로 추월하지 않는다.
create function brain.guard_import_locator() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.source,new.locator)::text,10));
 if exists (select 1 from brain.file_requests q join brain.file_import_cleanup c on c.request_id=q.id where q.source=new.source and q.locator=new.locator and (c.cleaned_at is not null or c.deleting_at is not null)) then
  raise exception '정리된 locator 재사용';
 end if;
 return new;
end $$;
revoke all on function brain.guard_import_locator() from public;
create trigger b_file_request_locator before insert on brain.file_requests for each row execute function brain.guard_import_locator();
