-- 자유 원천 값의 표시값과 권위 원형 바이트를 함께 저장한다.
alter table brain.channel_legacy_notifications add column local_date_raw bytea, add column local_date_encoding text, add constraint channel_legacy_notifications_local_date_pair check ((local_date_raw is null) = (local_date_encoding is null) and (local_date_raw is null or local_date is not null) and (local_date_encoding is null or local_date_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column event_raw bytea, add column event_encoding text, add constraint channel_legacy_notifications_event_pair check ((event_raw is null) = (event_encoding is null) and (event_raw is null or event is not null) and (event_encoding is null or event_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column detail_raw bytea, add column detail_encoding text, add constraint channel_legacy_notifications_detail_pair check ((detail_raw is null) = (detail_encoding is null) and (detail_raw is null or detail is not null) and (detail_encoding is null or detail_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.channel_legacy_deliveries add column original_id_raw bytea, add column original_id_encoding text, add constraint channel_legacy_deliveries_original_id_pair check ((original_id_raw is null) = (original_id_encoding is null) and (original_id_raw is null or original_id is not null) and (original_id_encoding is null or original_id_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column local_date_raw bytea, add column local_date_encoding text, add constraint channel_legacy_deliveries_local_date_pair check ((local_date_raw is null) = (local_date_encoding is null) and (local_date_raw is null or local_date is not null) and (local_date_encoding is null or local_date_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column kind_raw bytea, add column kind_encoding text, add constraint channel_legacy_deliveries_kind_pair check ((kind_raw is null) = (kind_encoding is null) and (kind_raw is null or kind is not null) and (kind_encoding is null or kind_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column event_raw bytea, add column event_encoding text, add constraint channel_legacy_deliveries_event_pair check ((event_raw is null) = (event_encoding is null) and (event_raw is null or event is not null) and (event_encoding is null or event_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column reason_raw bytea, add column reason_encoding text, add constraint channel_legacy_deliveries_reason_pair check ((reason_raw is null) = (reason_encoding is null) and (reason_raw is null or reason is not null) and (reason_encoding is null or reason_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.health_observations add column account_raw bytea, add column account_encoding text, add constraint health_observations_account_pair check ((account_raw is null) = (account_encoding is null) and (account_raw is null or account is not null) and (account_encoding is null or account_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column activity_id_raw bytea, add column activity_id_encoding text, add constraint health_observations_activity_id_pair check ((activity_id_raw is null) = (activity_id_encoding is null) and (activity_id_raw is null or activity_id is not null) and (activity_id_encoding is null or activity_id_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column sub_identity_raw bytea, add column sub_identity_encoding text, add constraint health_observations_sub_identity_pair check ((sub_identity_raw is null) = (sub_identity_encoding is null) and (sub_identity_raw is null or sub_identity is not null) and (sub_identity_encoding is null or sub_identity_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column value_text_raw bytea, add column value_text_encoding text, add constraint health_observations_value_text_pair check ((value_text_raw is null) = (value_text_encoding is null) and (value_text_raw is null or value_text is not null) and (value_text_encoding is null or value_text_encoding in ('utf-8','utf-16le','utf-16be'))),
 add column value_json_raw bytea, add column value_json_encoding text, add constraint health_observations_value_json_pair check ((value_json_raw is null) = (value_json_encoding is null) and (value_json_raw is null or value_json is not null) and (value_json_encoding is null or value_json_encoding in ('utf-8','utf-16le','utf-16be')));
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant insert (local_date_raw,local_date_encoding,event_raw,event_encoding,detail_raw,detail_encoding) on brain.channel_legacy_notifications to %I',r.rolname);
  execute format('grant insert (original_id_raw,original_id_encoding,local_date_raw,local_date_encoding,kind_raw,kind_encoding,event_raw,event_encoding,reason_raw,reason_encoding) on brain.channel_legacy_deliveries to %I',r.rolname);
  execute format('grant insert (account_raw,account_encoding,activity_id_raw,activity_id_encoding,sub_identity_raw,sub_identity_encoding,value_text_raw,value_text_encoding,value_json_raw,value_json_encoding) on brain.health_observations to %I',r.rolname);
 end loop;
end $$;

alter table brain.health_observations add column dataset_label text, add column dataset_label_raw bytea, add column dataset_label_encoding text, add constraint health_observations_dataset_label_pair check ((dataset_label_raw is null)=(dataset_label_encoding is null) and (dataset_label_raw is null or dataset_label is not null) and (dataset_label_encoding is null or dataset_label_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.channel_legacy_notifications add column dataset_label text, add column dataset_label_raw bytea, add column dataset_label_encoding text, add constraint channel_legacy_notifications_dataset_label_pair check ((dataset_label_raw is null)=(dataset_label_encoding is null) and (dataset_label_raw is null or dataset_label is not null) and (dataset_label_encoding is null or dataset_label_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.channel_legacy_deliveries add column dataset_label text, add column dataset_label_raw bytea, add column dataset_label_encoding text, add constraint channel_legacy_deliveries_dataset_label_pair check ((dataset_label_raw is null)=(dataset_label_encoding is null) and (dataset_label_raw is null or dataset_label is not null) and (dataset_label_encoding is null or dataset_label_encoding in ('utf-8','utf-16le','utf-16be')));
do $$ declare r record; begin for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
 execute format('grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.health_observations to %I',r.rolname);
 execute format('grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.channel_legacy_notifications to %I',r.rolname);
 execute format('grant insert (dataset_label,dataset_label_raw,dataset_label_encoding) on brain.channel_legacy_deliveries to %I',r.rolname);
end loop; end $$;
alter table brain.channel_legacy_notifications add column original_key_label text, add column original_key_label_raw bytea, add column original_key_label_encoding text, add constraint channel_legacy_notifications_key_label_pair check ((original_key_label_raw is null)=(original_key_label_encoding is null) and (original_key_label_raw is null or original_key_label is not null) and (original_key_label_encoding is null or original_key_label_encoding in ('utf-8','utf-16le','utf-16be')));
alter table brain.channel_legacy_deliveries add column original_key_label text, add column original_key_label_raw bytea, add column original_key_label_encoding text, add constraint channel_legacy_deliveries_key_label_pair check ((original_key_label_raw is null)=(original_key_label_encoding is null) and (original_key_label_raw is null or original_key_label is not null) and (original_key_label_encoding is null or original_key_label_encoding in ('utf-8','utf-16le','utf-16be')));
-- 원형 identity는 표시용 치환 문자열과 별개다.
create function brain.original_utf8(value text) returns bytea language sql immutable strict parallel safe set search_path='' as $$ select pg_catalog.convert_to(value,'UTF8') $$;
revoke all on function brain.original_utf8(text) from public;
grant execute on function brain.original_utf8(text) to brain_app;
do $$ declare r record; begin for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop execute format('grant execute on function brain.original_utf8(text) to %I',r.rolname); end loop; end $$;
alter table brain.health_authority_rules add column account_raw bytea, add column account_encoding text, add column activity_id_raw bytea, add column activity_id_encoding text;
alter table brain.health_authority_rules add constraint authority_account_pair check ((account_raw is null)=(account_encoding is null) and (account_encoding is null or account_encoding in ('utf-8','utf-16le','utf-16be'))), add constraint authority_activity_pair check ((activity_id_raw is null)=(activity_id_encoding is null) and (activity_id_raw is null or activity_id is not null) and (activity_id_encoding is null or activity_id_encoding in ('utf-8','utf-16le','utf-16be')));
do $$ declare n text; begin select conname into n from pg_constraint where conrelid='brain.health_authority_rules'::regclass and contype='u'; execute format('alter table brain.health_authority_rules drop constraint %I',n); end $$;
create unique index health_authority_identity on brain.health_authority_rules (source,(coalesce(account_encoding,'utf-8') || ':' || encode(coalesce(account_raw,brain.original_utf8(account)),'hex')),metric,(coalesce(activity_id_encoding,'utf-8') || ':' || encode(coalesce(activity_id_raw,brain.original_utf8(activity_id)),'hex')),date_from,date_to,revision) nulls not distinct;
do $$ declare r record; begin for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop execute format('grant insert (account_raw,account_encoding,activity_id_raw,activity_id_encoding) on brain.health_authority_rules to %I',r.rolname); end loop; end $$;
alter table brain.health_observations drop constraint health_storage_key;
create unique index health_storage_identity on brain.health_observations (source,dataset,(coalesce(health_observations.account_encoding,'utf-8') || ':' || encode(coalesce(health_observations.account_raw,brain.original_utf8(health_observations.account)),'hex')),original_table,original_key,metric,(coalesce(health_observations.activity_id_encoding,'utf-8') || ':' || encode(coalesce(health_observations.activity_id_raw,brain.original_utf8(health_observations.activity_id)),'hex')),(coalesce(health_observations.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(health_observations.sub_identity_raw,brain.original_utf8(health_observations.sub_identity)),'hex')),local_date,observed_at,time_zone,normalization_version,revision) nulls not distinct;
create or replace function brain.validate_health_observation() returns trigger language plpgsql security definer set search_path='' as $$
declare definition jsonb; oldrow brain.health_observations%rowtype;
begin
 select c.definition into definition from brain.health_catalog_v1 c where c.metric=case when new.metric='steps' then 'daily_metric.steps' else new.metric end;
 if definition is null or definition->>'type'<>new.value_type or definition->>'unit'<>new.unit then raise exception '건강 지표 타입 또는 단위 위반'; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.source,new.dataset,(coalesce(new.account_encoding,'utf-8') || ':' || encode(coalesce(new.account_raw,convert_to(new.account,'UTF8')),'hex')),new.original_table,new.original_key,new.metric,(coalesce(new.activity_id_encoding,'utf-8') || ':' || encode(coalesce(new.activity_id_raw,convert_to(new.activity_id,'UTF8')),'hex')),(coalesce(new.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(new.sub_identity_raw,convert_to(new.sub_identity,'UTF8')),'hex')),new.local_date,extract(epoch from new.observed_at),new.time_zone,new.normalization_version,new.revision)::text,0));
 select * into oldrow from brain.health_observations h where h.source=new.source and h.dataset=new.dataset and (coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')) is not distinct from (coalesce(new.account_encoding,'utf-8') || ':' || encode(coalesce(new.account_raw,convert_to(new.account,'UTF8')),'hex')) and h.original_table=new.original_table and h.original_key=new.original_key and h.metric=new.metric and (coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')) is not distinct from (coalesce(new.activity_id_encoding,'utf-8') || ':' || encode(coalesce(new.activity_id_raw,convert_to(new.activity_id,'UTF8')),'hex')) and (coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')) is not distinct from (coalesce(new.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(new.sub_identity_raw,convert_to(new.sub_identity,'UTF8')),'hex')) and h.local_date is not distinct from new.local_date and h.observed_at is not distinct from new.observed_at and h.time_zone is not distinct from new.time_zone and h.normalization_version=new.normalization_version and h.revision=new.revision;
 if found then
   if session_user like 'brain\_ext\_%' escape '\' and (oldrow.id,oldrow.import_batch) is distinct from (new.id,new.import_batch) then raise exception '건강 보관키 대상 충돌'; end if;
   if (oldrow.dataset_label,oldrow.account,oldrow.account_raw,oldrow.account_encoding,oldrow.activity_id,oldrow.activity_id_raw,oldrow.activity_id_encoding,oldrow.sub_identity,oldrow.sub_identity_raw,oldrow.sub_identity_encoding,oldrow.dataset_label_raw,oldrow.dataset_label_encoding,oldrow.value,oldrow.value_type,oldrow.value_text,oldrow.value_text_raw,oldrow.value_text_encoding,oldrow.value_json,oldrow.value_json_raw,oldrow.value_json_encoding,oldrow.unit,oldrow.fetched_at,oldrow.account_confirmed,oldrow.time_zone_missing,oldrow.catalog_version) is distinct from (new.dataset_label,new.account,new.account_raw,new.account_encoding,new.activity_id,new.activity_id_raw,new.activity_id_encoding,new.sub_identity,new.sub_identity_raw,new.sub_identity_encoding,new.dataset_label_raw,new.dataset_label_encoding,new.value,new.value_type,new.value_text,new.value_text_raw,new.value_text_encoding,new.value_json,new.value_json_raw,new.value_json_encoding,new.unit,new.fetched_at,new.account_confirmed,new.time_zone_missing,new.catalog_version) then raise exception '건강 보관키 payload 충돌'; end if;
   return null;
 end if;
 return new;
end $$;
create or replace view brain.health_resolution_v1 as
with keys as (
 select distinct source,account,metric,activity_id,sub_identity,local_date,observed_at,time_zone,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')) as account_identity,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')) as activity_id_identity,(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')) as sub_identity_identity from brain.health_observations h
), decisions as (
 select k.*, a.id as authority_id,a.revision as authority_version,a.datasets,
   (select count(distinct h.dataset) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as dataset_count,
   (select bool_and(h.account_confirmed) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as confirmed,
   (select array_agg(h.id order by h.id) from brain.health_observations h where (h.source,(coalesce(h.account_encoding,'utf-8') || ':' || encode(coalesce(h.account_raw,convert_to(h.account,'UTF8')),'hex')),h.metric,(coalesce(h.activity_id_encoding,'utf-8') || ':' || encode(coalesce(h.activity_id_raw,convert_to(h.activity_id,'UTF8')),'hex')),(coalesce(h.sub_identity_encoding,'utf-8') || ':' || encode(coalesce(h.sub_identity_raw,convert_to(h.sub_identity,'UTF8')),'hex')),h.local_date,h.observed_at,h.time_zone) is not distinct from (k.source,k.account_identity,k.metric,k.activity_id_identity,k.sub_identity_identity,k.local_date,k.observed_at,k.time_zone)) as all_ids
 from keys k left join lateral (
   select r.* from brain.health_authority_rules r where r.source=k.source and (coalesce(r.account_encoding,'utf-8') || ':' || encode(coalesce(r.account_raw,convert_to(r.account,'UTF8')),'hex'))=k.account_identity and (r.metric is null or r.metric=k.metric) and (r.activity_id is null or (coalesce(r.activity_id_encoding,'utf-8') || ':' || encode(coalesce(r.activity_id_raw,convert_to(r.activity_id,'UTF8')),'hex'))=k.activity_id_identity) and (r.date_from is null or k.local_date>=r.date_from) and (r.date_to is null or k.local_date<=r.date_to)
   order by ((r.metric is not null)::int+(r.activity_id is not null)::int+(r.date_from is not null)::int+(r.date_to is not null)::int) desc,r.revision desc,r.id limit 1
 ) a on true
), selected_dataset as (
 select d.*, case when d.authority_id is null and d.dataset_count=1 then
   (select h.dataset from brain.health_observations h where h.id=d.all_ids[1])
 else (select x.dataset from unnest(d.datasets) with ordinality x(dataset,ord) where exists(select 1 from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=x.dataset) order by x.ord limit 1) end as dataset
 from decisions d
), latest as (
 select d.*, (select max(h.fetched_at) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset) as fetched_at from selected_dataset d
), revisions as (
 select d.*, (select count(distinct h.revision) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as revision_count,
 (select array_agg(h.id order by h.id) from brain.health_observations h where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as observed_ids,
 (select max(h.normalization_version) from brain.health_observations h join brain.health_supported_versions v on v.version=h.normalization_version where h.id=any(d.all_ids) and h.dataset=d.dataset and h.fetched_at=d.fetched_at) as version
 from latest d
), candidates as (
 select d.*, (select array_agg(h.id order by h.id) from brain.health_observations h where h.id=any(d.observed_ids) and h.normalization_version=d.version) as candidate_ids,
 (select count(distinct jsonb_build_array(h.value_type,h.value,h.value_text,h.value_text_raw,h.value_text_encoding,h.value_json,h.value_json_raw,h.value_json_encoding)) from brain.health_observations h where h.id=any(d.observed_ids) and h.normalization_version=d.version) as value_count from revisions d
), reasons as (
 select d.*, case when account is null or not confirmed then 'account_unconfirmed' when local_date is not null and time_zone is null then 'timezone_unconfirmed' when authority_id is null and dataset_count>1 then 'dataset_ambiguous' when dataset is null then 'dataset_unselected' when revision_count>1 then 'revision_ambiguous' when version is null then 'version_unsupported' when value_count>1 then 'value_ambiguous' else null end as reason from candidates d
)
select source,account,metric,activity_id,sub_identity,local_date,observed_at,time_zone,authority_id,authority_version,dataset,reason,
 case when reason is null then candidate_ids[1] else null end as current_id,
 case when reason in ('revision_ambiguous','version_unsupported') then observed_ids when reason='value_ambiguous' or reason is null then candidate_ids else array[]::uuid[] end as selected_ids,
 all_ids, array(select id from unnest(all_ids) id where not (id=any(coalesce(case when reason in ('revision_ambiguous','version_unsupported') then observed_ids when reason='value_ambiguous' or reason is null then candidate_ids else array[]::uuid[] end,array[]::uuid[]))) order by id) as unselected_ids from reasons;
create or replace view brain.health_current_v1 as select h.* from brain.health_observations h join brain.health_resolution_v1 r on r.current_id=h.id;
-- 재삽입은 현재 자기 출처 시도에 한해 기존 대상의 전체 원문과 identity를 대조한다.
create function brain.reconcile_channel_legacy() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; incoming jsonb;
begin
 if session_user like 'brain\_ext\_%' escape '\' and session_user <> 'brain_ext_' || new.source then
  raise exception '다른 채널 출처' using errcode='42501';
 end if;
 if session_user like 'brain\_ext\_%' escape '\' and (not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source)) then
  raise exception '오래된 채널 출처 시도' using errcode='BRS01';
 end if;
 if session_user not like 'brain\_ext\_%' escape '\' then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.dataset,new.original_table,new.original_key)::text,0));
 if tg_table_name='channel_legacy_notifications' then
  select to_jsonb(t) into previous from brain.channel_legacy_notifications t where (t.id=new.id or (t.dataset,t.original_table,t.original_key)=(new.dataset,new.original_table,new.original_key)) limit 1;
 else
  select to_jsonb(t) into previous from brain.channel_legacy_deliveries t where (t.id=new.id or (t.dataset,t.original_table,t.original_key)=(new.dataset,new.original_table,new.original_key)) limit 1;
 end if;
 if previous is null then return new; end if;
 incoming=to_jsonb(new);
 if (previous - 'source_work_item_id' - 'source_attempt_token') is distinct from (incoming - 'source_work_item_id' - 'source_attempt_token') then
  raise exception 'legacy 원문 충돌' using errcode='P0001';
 end if;
 return null;
end $$;
revoke all on function brain.reconcile_channel_legacy() from public;
create trigger a_channel_notification_reconcile before insert on brain.channel_legacy_notifications for each row execute function brain.reconcile_channel_legacy();
create trigger a_channel_delivery_reconcile before insert on brain.channel_legacy_deliveries for each row execute function brain.reconcile_channel_legacy();
create function brain.reconcile_import_target() returns trigger language plpgsql security definer set search_path='' as $$
declare previous jsonb; incoming jsonb;
begin
 if session_user not like 'brain\_ext\_%' escape '\' then return new; end if;
 if session_user <> 'brain_ext_' || new.source then raise exception '다른 출처' using errcode='42501'; end if;
 if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=new.source_work_item_id and k.extension_name=new.source) then raise exception '오래된 시도' using errcode='BRS01'; end if;
 if tg_table_name='file_requests' then
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.source,new.request_key)::text,2));
  select to_jsonb(t) into previous from brain.file_requests t where t.id=new.id or (t.source,t.request_key)=(new.source,new.request_key) limit 1;
 else
  if not exists (select 1 from brain.file_requests f where f.id=new.file_request_id and f.source=new.source) then raise exception '다른 출처의 파일 요청'; end if;
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(new.source,new.dataset,new.original_table,new.original_key,new.revision)::text,3));
  select to_jsonb(t) into previous from brain.analyses t where t.id=new.id or (t.source,t.dataset,t.original_table,t.original_key,t.revision)=(new.source,new.dataset,new.original_table,new.original_key,new.revision) limit 1;
 end if;
 if previous is null then return new; end if;
 incoming=to_jsonb(new);
 if (previous - 'source_work_item_id' - 'source_attempt_token') is distinct from (incoming - 'source_work_item_id' - 'source_attempt_token') then raise exception '가져오기 대상 충돌' using errcode='P0001'; end if;
 return null;
end $$;
revoke all on function brain.reconcile_import_target() from public;
create trigger a_file_request_reconcile before insert on brain.file_requests for each row execute function brain.reconcile_import_target();
create trigger a_analysis_reconcile before insert on brain.analyses for each row execute function brain.reconcile_import_target();
-- 지정한 자기 출처·시도의 규칙만 원문과 대조하고 ID를 반환한다.
create function brain.reconcile_import_authority(wanted_id uuid, wanted_source text, wanted_account text, wanted_raw bytea, wanted_encoding text, wanted_datasets text[], work_id uuid, token uuid, mapped boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare prior brain.health_authority_rules%rowtype;
begin
 if session_user <> 'brain_ext_' || wanted_source then raise exception '다른 출처' using errcode='42501'; end if;
 if not brain.attempt_is_current(work_id,token) or not exists (select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=work_id and k.extension_name=wanted_source) then raise exception '오래된 시도' using errcode='BRS01'; end if;
 if wanted_account is null or (wanted_raw is null) <> (wanted_encoding is null) or (wanted_encoding is not null and wanted_encoding not in ('utf-8','utf-16le','utf-16be')) then raise exception '잘못된 계정 원문'; end if;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(wanted_source,wanted_account,encode(wanted_raw,'hex'),wanted_encoding)::text,4));
 select * into prior from brain.health_authority_rules r where r.id=wanted_id or (r.source=wanted_source and (coalesce(r.account_encoding,'utf-8') || ':' || encode(coalesce(r.account_raw,brain.original_utf8(r.account)),'hex'))=(coalesce(wanted_encoding,'utf-8') || ':' || encode(coalesce(wanted_raw,brain.original_utf8(wanted_account)),'hex')) and r.metric is null and r.activity_id is null and r.date_from is null and r.date_to is null and r.revision=1) order by (r.id=wanted_id) desc limit 1;
 if found then
  if (mapped and prior.id<>wanted_id) or prior.source<>wanted_source or prior.account is distinct from wanted_account or prior.account_raw is distinct from wanted_raw or prior.account_encoding is distinct from wanted_encoding or prior.metric is not null or prior.activity_id is not null or prior.date_from is not null or prior.date_to is not null or prior.revision<>1 or prior.datasets is distinct from wanted_datasets then raise exception '권위 규칙 충돌' using errcode='P0001'; end if;
  return prior.id;
 end if;
 insert into brain.health_authority_rules(id,source,account,account_raw,account_encoding,revision,datasets,source_work_item_id,source_attempt_token) values (wanted_id,wanted_source,wanted_account,wanted_raw,wanted_encoding,1,wanted_datasets,work_id,token);
 return wanted_id;
end $$;
revoke all on function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean) from public;
do $$ declare r record; begin for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop execute format('grant execute on function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean) to %I',r.rolname); end loop; end $$;
