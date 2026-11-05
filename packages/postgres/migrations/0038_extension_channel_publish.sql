-- Publish only for the active extension attempt, self conversation and its own
-- completed files from the same target. Core continues to own delivery state.
create function brain.extension_channel_publish(
 p_work uuid, p_token uuid, p_conversation uuid, p_key text, p_purpose text,
 p_revision text, p_summary text, p_document uuid, p_albums jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare w brain.work_items%rowtype; source_name text; item jsonb; album jsonb;
 document jsonb; albums jsonb := '[]'::jsonb; photos jsonb; loc jsonb;
 result_id uuid; existing brain.channel_requests%rowtype; body_bundle jsonb;
begin
 if session_user !~ '^brain_ext_[a-z][a-z0-9_]{0,30}$' or not brain.attempt_is_current(p_work,p_token) then raise exception 'invalid attempt' using errcode='42501'; end if;
 source_name := substring(session_user from 11);
 select * into w from brain.work_items where id=p_work;
 if not exists(select 1 from brain.extension_work_kinds k where k.kind=w.kind and k.extension_name=source_name)
   or not exists(select 1 from brain.channel_conversations c join brain.users u on u.id=c.user_id where c.id=p_conversation and u.is_self=1)
   or p_key is null or length(p_key) not between 1 and 512 or p_purpose is null or length(p_purpose) not between 1 and 100
   or p_summary is null or length(p_summary)>4000 or (p_revision is not null and length(p_revision)>512)
 then raise exception 'invalid publication' using errcode='42501'; end if;
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
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_key,p_conversation,p_purpose,p_revision)::text,11));
 select * into existing from brain.channel_requests where producer_result_id=p_key and conversation_id=p_conversation and purpose=p_purpose and revision is not distinct from p_revision;
 if found then
   if existing.producer<>source_name or existing.body<>p_summary or existing.bundle is distinct from body_bundle then raise exception 'publication conflict'; end if;
   return existing.id;
 end if;
 result_id := gen_random_uuid();
 insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,revision,body,bundle,created_at,source_work_item_id,source_attempt_token)
 values(result_id,p_conversation,source_name,p_key,p_purpose,p_revision,p_summary,body_bundle,now(),p_work,p_token);
 return result_id;
end $$;
-- Check a destination without exposing conversation rows to extension roles.
create function brain.extension_channel_conversation_valid(p_work uuid, p_token uuid, p_conversation uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare w brain.work_items%rowtype; source_name text;
begin
 if session_user !~ '^brain_ext_[a-z][a-z0-9_]{0,30}$' or not brain.attempt_is_current(p_work,p_token) then raise exception 'invalid attempt' using errcode='42501'; end if;
 source_name := substring(session_user from 11);
 select * into w from brain.work_items where id=p_work;
 if not exists(select 1 from brain.extension_work_kinds k where k.kind=w.kind and k.extension_name=source_name) then raise exception 'invalid attempt' using errcode='42501'; end if;
 return exists(select 1 from brain.channel_conversations c join brain.users u on u.id=c.user_id where c.id=p_conversation and u.is_self=1);
end $$;
revoke all on function brain.extension_channel_conversation_valid(uuid,uuid,uuid) from public;
revoke all on function brain.extension_channel_publish(uuid,uuid,uuid,text,text,text,text,uuid,jsonb) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_channel_publish(uuid,uuid,uuid,text,text,text,text,uuid,jsonb) to %I',r.rolname);
  execute format('grant execute on function brain.extension_channel_conversation_valid(uuid,uuid,uuid) to %I',r.rolname);
 end loop;
end $$;
