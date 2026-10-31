-- 확장이 기록하는 원본 계약과 core가 소유하는 처리 상태를 분리한다.
create table brain.health_observations (
 id uuid primary key, source text not null, dataset text not null, import_batch text not null,
 original_table text not null, original_key text not null, account text, account_confirmed boolean not null default false,
 metric text not null, value double precision, unit text not null,
 local_date date, observed_at timestamptz, time_zone text, time_zone_missing boolean not null, revision text not null, fetched_at timestamptz not null,
 normalization_version integer not null check (normalization_version > 0), source_work_item_id uuid not null references brain.work_items(id), source_attempt_token uuid not null,
 check ((local_date is null) <> (observed_at is null)), check (not account_confirmed or account is not null), check ((time_zone is null) = time_zone_missing),
 unique nulls not distinct (source,dataset,account,original_table,original_key,metric,local_date,observed_at,time_zone,normalization_version,revision)
);
create view brain.health_current_v1 as
 select * from brain.health_observations h where h.account_confirmed and h.account is not null and (h.local_date is null or not h.time_zone_missing)
 and not exists (select 1 from brain.health_observations other where other.source=h.source and other.account=h.account and other.metric=h.metric and other.local_date is not distinct from h.local_date and other.observed_at is not distinct from h.observed_at and other.time_zone is not distinct from h.time_zone and other.dataset<>h.dataset and other.account_confirmed)
 and not exists (select 1 from brain.health_observations newer where newer.source=h.source and newer.dataset=h.dataset and newer.account=h.account and newer.metric=h.metric and newer.local_date is not distinct from h.local_date and newer.observed_at is not distinct from h.observed_at and newer.time_zone is not distinct from h.time_zone and (newer.fetched_at>h.fetched_at or (newer.fetched_at=h.fetched_at and newer.normalization_version>h.normalization_version)))
 and not exists (select 1 from brain.health_observations tied where tied.source=h.source and tied.dataset=h.dataset and tied.account=h.account and tied.metric=h.metric and tied.local_date is not distinct from h.local_date and tied.observed_at is not distinct from h.observed_at and tied.time_zone is not distinct from h.time_zone and tied.fetched_at=h.fetched_at and tied.normalization_version=h.normalization_version and (tied.revision<>h.revision or tied.value is distinct from h.value));
create table brain.file_requests (
 id uuid primary key, source text not null, request_key text not null, dataset text not null, import_batch text not null,
 locator text not null, sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), size_bytes bigint not null check (size_bytes >= 0), media_type text not null,
 created_at timestamptz not null, source_work_item_id uuid not null references brain.work_items(id), source_attempt_token uuid not null,
 unique(source,request_key)
);
create table brain.analyses (
 id uuid primary key, source text not null, dataset text not null, import_batch text not null, original_table text not null, original_key text not null,
 revision integer not null check (revision > 0), model text, model_missing boolean not null, created_at timestamptz, created_at_missing boolean not null,
 file_request_id uuid not null references brain.file_requests(id), source_work_item_id uuid not null references brain.work_items(id), source_attempt_token uuid not null,
 check ((model is null) = model_missing), check ((created_at is null) = created_at_missing), unique(source,dataset,original_table,original_key,revision)
);
create table brain.file_request_handoffs (request_id uuid primary key references brain.file_requests(id), work_item_id uuid not null references brain.work_items(id));
create table brain.file_request_results (request_id uuid primary key references brain.file_requests(id), file_id uuid references brain.files(id), error_code text, finished_at timestamptz not null, check ((file_id is null) <> (error_code is null)));
create view brain.file_request_results_public_v1 with (security_barrier=true) as
 select q.id as request_id,r.file_id,coalesce(r.error_code,f.code) as error_code,r.finished_at,
   case when r.file_id is not null then 'completed'
        when w.id is not null and w.completed_at is null then 'processing'
        when r.error_code is not null or w.outcome in ('failed','cancelled','dependency_failed') then 'failed'
        else 'pending' end as status,
   (r.file_id is null and not coalesce(w.completed_at is null,false)
     and (r.error_code is not null or w.outcome in ('failed','cancelled','dependency_failed'))) as resumable
 from brain.file_requests q
 left join brain.file_request_results r on r.request_id=q.id
 left join lateral (select id,completed_at,outcome from brain.work_items
   where kind='file_import' and target_kind='file_request' and target_id=q.id::text
   order by (completed_at is null) desc,created_at desc,id desc limit 1) w on true
 left join lateral (select code from brain.failures where target_kind='file_request' and target_id=q.id::text and stage='file_import' and resolved_at is null order by occurred_at desc limit 1) f on true
 where current_user = 'brain_ext_' || q.source;
create function brain.guard_import_attempt() returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (
   select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind
   where w.id=new.source_work_item_id and k.extension_name=new.source
 ) then raise exception '오래되었거나 다른 출처의 시도' using errcode='BRS01'; end if;
 if tg_table_name='analyses' then
   if not exists (select 1 from brain.file_requests f where f.id=new.file_request_id and f.source=new.source) then
     raise exception '다른 출처의 파일 요청';
   end if;
 end if;
 return new;
end $$;
create function brain.reject_import_mutation() returns trigger language plpgsql as $$ begin raise exception '불변 가져오기 계약'; end $$;
do $$ declare t text; begin
 foreach t in array array['health_observations','file_requests','analyses'] loop
   execute format('alter table brain.%I enable row level security',t);
   execute format('create policy import_app on brain.%I to brain_app using (true) with check (true)',t);
   execute format('create policy import_extension on brain.%I for insert with check (current_user = ''brain_ext_'' || source)',t);
   execute format('create trigger import_attempt before insert on brain.%I for each row execute function brain.guard_import_attempt()',t);
   execute format('create trigger import_immutable before update or delete on brain.%I for each row execute function brain.reject_import_mutation()',t);
   execute format('revoke all on brain.%I from public',t);
   execute format('grant select, insert on brain.%I to brain_app',t);
 end loop;
end $$;
revoke all on brain.file_request_handoffs,brain.file_request_results,brain.file_request_results_public_v1,brain.health_current_v1 from public;
grant select on brain.health_current_v1 to brain_app;
grant select,insert,update on brain.file_request_handoffs,brain.file_request_results to brain_app;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
   execute format('grant select on brain.file_request_results_public_v1 to %I',r.rolname);
   execute format('grant insert (id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) on brain.health_observations to %I',r.rolname);
   execute format('grant insert (id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) on brain.file_requests to %I',r.rolname);
   execute format('grant insert (id,source,dataset,import_batch,original_table,original_key,revision,model,model_missing,created_at,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) on brain.analyses to %I',r.rolname);
 end loop;
end $$;
