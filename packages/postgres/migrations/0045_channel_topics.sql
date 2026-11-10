-- Existing physical channels are messenger accounts; conversations are destinations.
create table brain.messenger_aliases (
 messenger_id uuid primary key references brain.channels(id), name text not null unique
);
create table brain.channel_aliases (
 conversation_id uuid primary key references brain.channel_conversations(id),
 messenger_id uuid not null references brain.channels(id), name text not null,
 unique(messenger_id,name)
);
revoke all on brain.messenger_aliases,brain.channel_aliases from public;
grant select,insert,update,delete on brain.messenger_aliases,brain.channel_aliases to brain_app;
-- Channel credentials are core-only; public DTOs expose configured, never tokens.
create table brain.messenger_credentials (
 messenger_id uuid primary key references brain.channels(id), bot_token text not null check(length(bot_token)>0)
);
create table brain.channel_routes (
 topic text primary key check(length(topic) between 1 and 200),
 conversation_id uuid not null references brain.channel_conversations(id)
);
create table brain.channel_dispatches (
 id uuid primary key, topic text not null, semantic_key text not null,
 producer text not null, purpose text not null, revision text, body text not null, bundle jsonb,
 direct_conversation_id uuid references brain.channel_conversations(id),
 send_at timestamptz, created_at timestamptz not null,
 state text not null check(state in ('scheduled','unrouted','queued')),
 source_work_item_id uuid references brain.work_items(id), source_attempt_token uuid,
 unique(topic,semantic_key)
);
create index channel_dispatch_due on brain.channel_dispatches(send_at) where state='scheduled';
revoke all on brain.messenger_credentials,brain.channel_routes,brain.channel_dispatches from public;
grant select,insert,update,delete on brain.messenger_credentials,brain.channel_routes to brain_app;
grant select,insert,update on brain.channel_dispatches to brain_app;

-- A durable accepted dispatch remains deliverable after its producer attempt ends.
create or replace function brain.guard_channel_source_attempt() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='channel_requests' and current_user='brain_app' then
   if exists(select 1 from brain.channel_dispatches d where d.id=new.id
     and d.state in ('scheduled','unrouted') and d.producer=new.producer
     and d.source_work_item_id is not distinct from new.source_work_item_id
     and d.source_attempt_token is not distinct from new.source_attempt_token
     and d.body=new.body and d.bundle is not distinct from new.bundle
     and d.purpose=new.purpose and d.revision is not distinct from new.revision)
   then return new; end if;
 end if;
 if current_user <> 'brain_app' or new.source_work_item_id is not null or new.source_attempt_token is not null then
   if not brain.attempt_is_current(new.source_work_item_id,new.source_attempt_token) then
     raise exception '오래된 채널 출처 시도' using errcode='BRS01';
   end if;
 end if;
 return new;
end $$;

create trigger channel_dispatch_source_fence before insert on brain.channel_dispatches for each row execute function brain.guard_channel_source_attempt();

-- Caller holds the dispatch lock. Only an explicit operator call may retry unrouted.
create function brain.route_channel_dispatch(p_id uuid,p_now timestamptz,p_force boolean default false)
returns boolean language plpgsql set search_path='' as $$
declare d brain.channel_dispatches%rowtype; dest uuid;
begin
 select * into d from brain.channel_dispatches where id=p_id for update;
 if not found or d.state='queued' or (d.state='unrouted' and not p_force)
   or (d.send_at>p_now and not p_force) then return false; end if;
 if d.direct_conversation_id is not null then
   select c.id into dest from brain.channel_conversations c join brain.users u on u.id=c.user_id where c.id=d.direct_conversation_id and u.is_self=1;
 else
 select r.conversation_id into dest from brain.channel_routes r
 join brain.channel_conversations c on c.id=r.conversation_id join brain.users u on u.id=c.user_id
 where r.topic=d.topic and u.is_self=1;
 end if;
 if dest is null then
   update brain.channel_dispatches set state='unrouted' where id=p_id;
   return false;
 end if;
 insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,revision,body,bundle,created_at,source_work_item_id,source_attempt_token)
 values(d.id,dest,d.producer,d.id::text,d.purpose,d.revision,d.body,d.bundle,d.created_at,d.source_work_item_id,d.source_attempt_token);
 update brain.channel_dispatches set state='queued' where id=p_id;
 return true;
end $$;
revoke all on function brain.route_channel_dispatch(uuid,timestamptz,boolean) from public;
grant execute on function brain.route_channel_dispatch(uuid,timestamptz,boolean) to brain_app;

create function brain.extension_channel_send(
 p_work uuid,p_attempt uuid,p_topic text,p_key text,p_purpose text,p_revision text,
 p_summary text,p_document uuid,p_albums jsonb,p_send_at timestamptz default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare w brain.work_items%rowtype; source_name text; item jsonb; album jsonb;
 document jsonb; albums jsonb := '[]'::jsonb; photos jsonb; loc jsonb;
 result_id uuid; body_bundle jsonb;
begin
 if session_user !~ '^brain_ext_[a-z][a-z0-9_]{0,30}$' or not brain.attempt_is_current(p_work,p_attempt) then raise exception 'invalid attempt' using errcode='42501'; end if;
 source_name := substring(session_user from 11);
 select * into w from brain.work_items where id=p_work;
 if not exists(select 1 from brain.extension_work_kinds k where k.kind=w.kind and k.extension_name=source_name)
   or p_topic is null or length(p_topic)>200 or left(p_topic,length(source_name)+1)<>source_name||'.' or length(p_topic)<=length(source_name)+1
   or p_key is null or length(p_key) not between 1 and 512
   or p_purpose is null or length(p_purpose) not between 1 and 100
   or p_summary is null or length(p_summary)>4000 or (p_revision is not null and length(p_revision)>512)
 then raise exception 'invalid publication' using errcode='42501'; end if;
 -- A semantic key acknowledges once, regardless of route or schedule changes.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_topic,p_key)::text,12));
 select id into result_id from brain.channel_dispatches where topic=p_topic and semantic_key=p_key;
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
 insert into brain.channel_dispatches(id,topic,semantic_key,producer,purpose,revision,body,bundle,send_at,created_at,state,source_work_item_id,source_attempt_token)
 values(result_id,p_topic,p_key,source_name,p_purpose,p_revision,p_summary,body_bundle,p_send_at,now(),'scheduled',p_work,p_attempt);
 if p_send_at is null then perform brain.route_channel_dispatch(result_id,now()); end if;
 return result_id;
end $$;
revoke all on function brain.extension_channel_send(uuid,uuid,text,text,text,text,text,uuid,jsonb,timestamptz) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_channel_send(uuid,uuid,text,text,text,text,text,uuid,jsonb,timestamptz) to %I',r.rolname);
 end loop;
end $$;
