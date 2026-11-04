create table brain.analysis_snapshots (
 id uuid primary key, bundle_id uuid not null, local_date date not null, time_zone text not null,
 content bytea not null, content_sha256 text not null check (content_sha256 = encode(sha256(content),'hex')), created_at timestamptz not null
);
alter table brain.analysis_snapshots enable row level security;
create policy analysis_snapshot_app on brain.analysis_snapshots to brain_app using (true) with check (true);
create trigger immutable before update or delete on brain.analysis_snapshots for each row execute function brain.reject_import_mutation();
revoke all on brain.analysis_snapshots from public;
grant select,insert on brain.analysis_snapshots to brain_app;
alter table brain.analyses alter column import_batch drop not null, alter column original_table drop not null, alter column original_key drop not null, alter column file_request_id drop not null;
alter table brain.analyses add column bundle_id uuid, add column snapshot_id uuid references brain.analysis_snapshots(id), add column agent text, add column output_json jsonb;
alter table brain.analyses add constraint analyses_source_shape check (
 (source='core' and bundle_id is not null and snapshot_id is not null and agent is not null and output_json is not null and import_batch is null and original_table is null and original_key is null and file_request_id is null and scope is not null and report_date is not null)
 or (source <> 'core' and import_batch is not null and original_table is not null and original_key is not null and file_request_id is not null and bundle_id is null and snapshot_id is null and agent is null and output_json is null)
);
create unique index analyses_core_snapshot_scope_revision on brain.analyses(snapshot_id,scope,revision) where source='core';
create or replace function brain.guard_import_attempt() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_table_name='analyses' then
  if new.source='core' then
   if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w where w.id=new.source_work_item_id and w.kind='health_analysis' and w.target_kind='analysis_snapshot' and w.target_id=new.snapshot_id::text) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
   return new;
  end if;
 end if;
 if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
 if tg_table_name='analyses' then
  if not exists (select 1 from brain.file_requests f where f.id=new.file_request_id and f.source=new.source) then raise exception '다른 출처의 파일 요청'; end if;
 end if;
 return new;
end $$;
create or replace function brain.guard_analysis_dataset() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.source='core' then
  if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w where w.id=new.source_work_item_id and w.kind='health_analysis' and w.target_kind='analysis_snapshot' and w.target_id=new.snapshot_id::text) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
 elsif not exists (select 1 from brain.file_requests f where f.id=new.file_request_id and f.source=new.source and f.dataset=new.dataset) then raise exception '다른 출처 또는 dataset 파일 요청'; end if;
 return new;
end $$;
create table brain.analysis_files (analysis_id uuid not null references brain.analyses(id), file_id uuid not null references brain.files(id), role text not null check(role='report'), unique(analysis_id,role));
alter table brain.analysis_files enable row level security;
create policy analysis_files_app on brain.analysis_files to brain_app using (true) with check (true);
create trigger immutable before update or delete on brain.analysis_files for each row execute function brain.reject_import_mutation();
revoke all on brain.analysis_files from public;
grant select,insert on brain.analysis_files to brain_app;
