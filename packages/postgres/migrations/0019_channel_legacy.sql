-- 확장 출처 시도는 인계 상태와 별도로 기록한다.
alter table brain.channel_requests add column source_work_item_id uuid references brain.work_items(id), add column source_attempt_token uuid;
create table brain.channel_legacy_notifications (
 id uuid primary key, conversation_id uuid not null references brain.channel_conversations(id),
 source text not null, dataset text not null, original_table text not null, original_key text not null, import_batch text not null,
 local_date text not null, event text not null, detail text not null, at timestamptz not null,
 external_message_id text check (external_message_id is null), body text check (body is null), metadata_missing boolean not null default true check (metadata_missing), resend_eligible boolean not null default false check (not resend_eligible),
 source_work_item_id uuid references brain.work_items(id), source_attempt_token uuid,
 unique(dataset, original_table, original_key)
);
create table brain.channel_legacy_deliveries (
 id uuid primary key, conversation_id uuid not null references brain.channel_conversations(id),
 source text not null, dataset text not null, original_table text not null, original_key text not null, import_batch text not null,
 original_id text not null, local_date text not null, kind text not null, event text, ok boolean not null, reason text, at timestamptz not null,
 external_message_id text check (external_message_id is null), body text check (body is null), metadata_missing boolean not null default true check (metadata_missing), resend_eligible boolean not null default false check (not resend_eligible),
 source_work_item_id uuid references brain.work_items(id), source_attempt_token uuid,
 unique(dataset, original_table, original_key)
);
create function brain.guard_channel_source_attempt() returns trigger language plpgsql as $$
begin
 if current_user <> 'brain_app' or new.source_work_item_id is not null or new.source_attempt_token is not null then
   if not brain.attempt_is_current(new.source_work_item_id, new.source_attempt_token) then
     raise exception '오래된 채널 출처 시도' using errcode = 'BRS01';
   end if;
 end if;
 return new;
end $$;
create trigger channel_request_source_fence before insert on brain.channel_requests for each row execute function brain.guard_channel_source_attempt();
create trigger channel_notification_source_fence before insert on brain.channel_legacy_notifications for each row execute function brain.guard_channel_source_attempt();
create trigger channel_delivery_source_fence before insert on brain.channel_legacy_deliveries for each row execute function brain.guard_channel_source_attempt();
alter table brain.channel_requests enable row level security;
alter table brain.channel_legacy_notifications enable row level security;
alter table brain.channel_legacy_deliveries enable row level security;
create policy channel_request_app on brain.channel_requests to brain_app using (true) with check (true);
create policy channel_request_extension on brain.channel_requests for insert with check (current_user = 'brain_ext_' || producer);
create policy channel_notification_app on brain.channel_legacy_notifications to brain_app using (true) with check (true);
create policy channel_notification_extension on brain.channel_legacy_notifications for insert with check (current_user = 'brain_ext_' || source);
create policy channel_delivery_app on brain.channel_legacy_deliveries to brain_app using (true) with check (true);
create policy channel_delivery_extension on brain.channel_legacy_deliveries for insert with check (current_user = 'brain_ext_' || source);
revoke all on brain.channel_legacy_notifications, brain.channel_legacy_deliveries from public;
grant select, insert on brain.channel_legacy_notifications, brain.channel_legacy_deliveries to brain_app;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid, 'pg_authid') = 'second-brain extension:' || current_database() loop
   if exists (select 1 from pg_roles where rolname=r.rolname and (not rolcanlogin or rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)) or exists (select 1 from pg_auth_members m join pg_roles x on x.oid=m.member or x.oid=m.roleid where x.rolname=r.rolname) then raise exception '확장 역할 충돌'; end if;
   if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='brain' and c.relkind in ('r','p','v','m','S','f')
       and (case when c.relname='extension_status_public_v1' then
         has_table_privilege(r.rolname,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege(r.rolname,c.oid,'INSERT,UPDATE,REFERENCES')
       else has_table_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege(r.rolname,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') end))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='brain' and p.prorettype <> 'pg_catalog.trigger'::regtype and p.oid <> 'brain.attempt_is_current(uuid,uuid)'::regprocedure and has_function_privilege(r.rolname,p.oid,'EXECUTE')) then
     raise exception '확장 역할에 허용되지 않은 권한';
   end if;
   execute format('grant insert (id,conversation_id,producer,producer_result_id,purpose,revision,body,created_at,source_work_item_id,source_attempt_token) on brain.channel_requests to %I', r.rolname);
   execute format('grant insert (id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) on brain.channel_legacy_notifications to %I', r.rolname);
   execute format('grant insert (id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,reason,at,source_work_item_id,source_attempt_token) on brain.channel_legacy_deliveries to %I', r.rolname);
 end loop;
end $$;
