-- 결과 생산과 발송 결정을 분리한다. 기존 topic 경로는 수동 발신용으로 유지한다.
create table brain.work_manual_requests (
 work_id uuid primary key references brain.work_items(id)
);
grant select,insert on brain.work_manual_requests to brain_app;
create table brain.channel_subscriptions (
 id uuid primary key default gen_random_uuid(),
 event text not null unique check(length(event) between 1 and 200),
 conversation_id uuid not null references brain.channel_conversations(id),
 deliver_at text check(deliver_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 time_zone text,
 check(deliver_at is not null or time_zone is null)
);
create table brain.result_events (
 id uuid primary key,
 event text not null, semantic_key text not null, producer text not null,
 subject_date date not null, revision text, body text not null, bundle jsonb,
 created_at timestamptz not null, requested boolean not null,
 source_work_item_id uuid not null references brain.work_items(id), source_attempt_token uuid not null,
 unique(event,semantic_key)
);
alter table brain.channel_dispatches add column event_id uuid references brain.result_events(id),
 add column subscription_id uuid,
 add constraint event_subscription_once unique(event_id,subscription_id);
-- 구독 제거·재등록 때 새 id를 부여한다. 이미 접수된 요청은 구독 삭제와 독립이다.
revoke all on brain.work_manual_requests,brain.channel_subscriptions,brain.result_events from public;
grant select,insert,update,delete on brain.channel_subscriptions to brain_app;
grant select on brain.result_events to brain_app;

-- 현지 시각과 날짜를 한 곳에서 해석한다. DST 중복/누락 시각은 PostgreSQL 규칙을 따른다.
create function brain.subscription_zone(p_subscription uuid) returns text
 language sql stable set search_path='' as $$
 select coalesce(s.time_zone,(select value from brain.settings t where t.key='timezone'
   and (t.user_id=c.user_id or t.user_id is null) order by t.user_id nulls last limit 1),'Asia/Seoul')
 from brain.channel_subscriptions s join brain.channel_conversations c on c.id=s.conversation_id
 where s.id=p_subscription
$$;
revoke all on function brain.subscription_zone(uuid) from public;
grant execute on function brain.subscription_zone(uuid) to brain_app;

-- core 파이프라인. 자동 접수는 기록 당시의 구독·날짜·시각을 고정한다.
create function brain.dispatch_result_event(p_event uuid,p_now timestamptz,p_force boolean default false)
 returns integer language plpgsql set search_path='' as $$
declare e brain.result_events%rowtype; s brain.channel_subscriptions%rowtype;
 zone text; due timestamptz; dispatch_id uuid;
begin
 select * into e from brain.result_events where id=p_event;
 if not found then return 0; end if;
 select sub.* into s from brain.channel_subscriptions sub
 join brain.channel_conversations c on c.id=sub.conversation_id join brain.users u on u.id=c.user_id
 where sub.event=e.event and u.is_self=1 for share of sub;
 if not found then return 0; end if;
 zone := brain.subscription_zone(s.id);
 if not p_force and not e.requested and e.subject_date<>(e.created_at at time zone zone)::date then return 0; end if;
 due := null;
 if not p_force and s.deliver_at is not null then
   due := (((e.created_at at time zone zone)::date + s.deliver_at::time) at time zone zone);
   -- 분석이 늦게 끝났다는 이유로 다음 날까지 미루지 않는다.
   if due<=e.created_at then due := null; end if;
 end if;
 insert into brain.channel_dispatches(id,topic,semantic_key,producer,purpose,revision,body,bundle,direct_conversation_id,
   send_at,created_at,state,source_work_item_id,source_attempt_token,event_id,subscription_id)
 values(gen_random_uuid(),e.event,e.id::text||':'||s.id::text,e.producer,'event',e.revision,e.body,e.bundle,s.conversation_id,
   due,p_now,'scheduled',case when p_force then null else e.source_work_item_id end,
   case when p_force then null else e.source_attempt_token end,e.id,s.id)
 on conflict do nothing returning id into dispatch_id;
 if dispatch_id is null then return 0; end if;
 perform brain.route_channel_dispatch(dispatch_id,p_now);
 return 1;
end $$;
revoke all on function brain.dispatch_result_event(uuid,timestamptz,boolean) from public;
grant execute on function brain.dispatch_result_event(uuid,timestamptz,boolean) to brain_app;

create function brain.on_result_event() returns trigger language plpgsql set search_path='' as $$
begin
 perform brain.dispatch_result_event(new.id,new.created_at);
 return new;
end $$;
revoke all on function brain.on_result_event() from public;
create trigger result_event_pipeline after insert on brain.result_events for each row execute function brain.on_result_event();

create function brain.extension_event_emit(
 p_work uuid,p_attempt uuid,p_event text,p_key text,p_subject_date date,p_revision text,
 p_summary text,p_document uuid,p_albums jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare w brain.work_items%rowtype; source_name text; item jsonb; album jsonb;
 document jsonb; albums jsonb := '[]'::jsonb; photos jsonb; loc jsonb;
 result_id uuid; body_bundle jsonb;
begin
 if session_user !~ '^brain_ext_[a-z][a-z0-9_]{0,30}$' or not brain.attempt_is_current(p_work,p_attempt) then raise exception 'invalid attempt' using errcode='42501'; end if;
 source_name := substring(session_user from 11);
 select * into w from brain.work_items where id=p_work;
 if not exists(select 1 from brain.extension_work_kinds k where k.kind=w.kind and k.extension_name=source_name)
   or p_event is null or length(p_event)>200 or left(p_event,length(source_name)+1)<>source_name||'.' or length(p_event)<=length(source_name)+1
   or p_key is null or length(p_key) not between 1 and 512
   or p_subject_date is null
   or p_summary is null or length(p_summary)>4000 or (p_revision is not null and length(p_revision)>512)
 then raise exception 'invalid publication' using errcode='42501'; end if;
 -- A semantic key acknowledges once, regardless of route or schedule changes.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_event,p_key)::text,12));
 select id into result_id from brain.result_events where event=p_event and semantic_key=p_key;
 if found then return result_id; end if;
 if p_document is null then
   if p_albums is not null then raise exception 'invalid bundle'; end if;
   body_bundle := null;
 else
   if jsonb_typeof(p_albums) <> 'array' or jsonb_array_length(p_albums)>20 then raise exception 'invalid albums'; end if;
   select jsonb_build_object('location',jsonb_build_object('storeKind',l.store_kind,'locator',l.locator,'ownership',l.ownership),'filename','report.md') into document
   from brain.file_requests q join brain.work_items origin on origin.id=q.source_work_item_id
   join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id
   join brain.file_locations l on l.id=f.home_location_id
   where q.id=p_document and q.source=source_name and origin.target_kind=w.target_kind and origin.target_id=w.target_id and f.redacted_at is null and l.deleted_at is null and l.ownership='brain';
   if document is null then raise exception 'invalid document'; end if;
   for album in select value from jsonb_array_elements(p_albums) loop
     if jsonb_typeof(album)<>'array' or jsonb_array_length(album) not between 1 and 10 then raise exception 'invalid album'; end if;
     photos := '[]'::jsonb;
     for item in select value from jsonb_array_elements(album) loop
       if jsonb_typeof(item)<>'object' or not (item ? 'request_id' and item ? 'filename') or jsonb_typeof(item->'filename') is distinct from 'string' or length(item->>'filename') not between 1 and 255 or (item->>'filename') ~ '[/\\]' or (item->>'filename') ~ '[[:cntrl:]]' then raise exception 'invalid photo'; end if;
       select jsonb_build_object('location',jsonb_build_object('storeKind',l.store_kind,'locator',l.locator,'ownership',l.ownership),'filename',item->>'filename') into loc
       from brain.file_requests q join brain.work_items origin on origin.id=q.source_work_item_id
       join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id
       join brain.file_locations l on l.id=f.home_location_id
       where q.id=(item->>'request_id')::uuid and q.source=source_name and origin.target_kind=w.target_kind and origin.target_id=w.target_id and f.redacted_at is null and l.deleted_at is null and l.ownership='brain';
       if loc is null then raise exception 'invalid photo'; end if;
       photos := photos || jsonb_build_array(loc);
     end loop;
     albums := albums || jsonb_build_array(jsonb_build_object('photos',photos));
   end loop;
   body_bundle := jsonb_build_object('summary',p_summary,'albums',albums,'document',document);
 end if;

 result_id := gen_random_uuid();
 insert into brain.result_events(id,event,semantic_key,producer,subject_date,revision,body,bundle,created_at,requested,source_work_item_id,source_attempt_token)
 values(result_id,p_event,p_key,source_name,p_subject_date,p_revision,p_summary,body_bundle,now(),exists(select 1 from brain.work_manual_requests where work_id=p_work),p_work,p_attempt);
 return result_id;
end $$;
revoke all on function brain.extension_event_emit(uuid,uuid,text,text,date,text,text,uuid,jsonb) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname ~ '^brain_ext_[a-z][a-z0-9_]{0,30}$'
   and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_event_emit(uuid,uuid,text,text,date,text,text,uuid,jsonb) to %I',r.rolname);
 end loop;
end $$;

-- 설정만 옮기고 과거 이벤트·요청은 발송하지 않는다. 다른 topic 경로는 보존한다.
insert into brain.channel_subscriptions(event,conversation_id)
 select topic||'.completed',conversation_id from brain.channel_routes
 where topic in ('garmin.report','garmin.period_report');
-- 옮겨지는 경로에 이미 예약·보관된 발신은 당시 목적지를 고정하여 이행 뒤에도 전달한다.
update brain.channel_dispatches d set direct_conversation_id=r.conversation_id
 from brain.channel_routes r where d.topic=r.topic and d.state in ('scheduled','unrouted') and d.direct_conversation_id is null
 and r.topic in ('garmin.report','garmin.period_report');
delete from brain.channel_routes where topic in ('garmin.report','garmin.period_report');
