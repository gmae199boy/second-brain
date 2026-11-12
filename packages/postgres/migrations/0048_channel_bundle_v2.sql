-- 문자열의 UTF-16 단위 수. supplementary 문자는 2단위다.
create function brain.utf16_length(value text) returns integer language sql immutable strict set search_path='' as $$
 select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0)::integer from regexp_split_to_table(value,'') ch
$$;
create function brain.channel_bundle_size(value jsonb) returns integer language sql immutable strict set search_path='' as $$
 select case when value->>'version'='2' then jsonb_array_length(value->'items') else jsonb_array_length(value->'albums')+2 end
$$;
revoke all on function brain.utf16_length(text),brain.channel_bundle_size(jsonb) from public;
grant execute on function brain.utf16_length(text),brain.channel_bundle_size(jsonb) to brain_app;
create or replace function brain.guard_channel_item_result() returns trigger language plpgsql as $$
begin
 if not brain.attempt_is_current(new.work_item_id,new.attempt_token) or not exists (
   select 1 from brain.channel_requests r join brain.channel_attempt_results a on a.request_id=r.id
   where r.id=new.request_id and r.work_item_id=new.work_item_id and r.status='pending' and r.bundle is not null
     and new.item_index < brain.channel_bundle_size(r.bundle)
     and a.work_item_id=new.work_item_id and a.attempt_token=new.attempt_token and a.outcome is null
 ) then raise exception '오래된 채널 항목 시도' using errcode='BRS01'; end if;
 if tg_op='UPDATE' and (old.result->>'outcome'='sent' or new.request_id<>old.request_id or new.item_index<>old.item_index) then
   raise exception '확정된 채널 항목' using errcode='BRS01';
 end if;
 return new;
end $$;
create or replace function brain.guard_channel_result_update() returns trigger language plpgsql as $$
begin
  if not brain.attempt_is_current(old.work_item_id, old.attempt_token) and not (
    exists (
      select 1 from brain.work_items w join brain.work_attempts a on a.work_item_id=w.id and a.token=w.current_attempt_token
      join brain.channel_requests r on r.id=old.request_id and r.work_item_id=w.id
      where w.id=old.work_item_id and w.current_attempt_token=old.attempt_token and w.completed_at is null and a.outcome='unknown'
        and r.status='pending' and r.bundle is not null and (
          (new.outcome='sent' and exists (select 1 from brain.channel_item_results last where last.request_id=r.id and last.item_index=brain.channel_bundle_size(r.bundle)-1 and last.result->>'outcome'='sent' and new.external_message_id is not distinct from last.result->>'externalMessageId')
            and (select count(*) from brain.channel_item_results i where i.request_id=r.id and i.result->>'outcome'='sent')=brain.channel_bundle_size(r.bundle))
          or (new.outcome in ('unknown','definite_failed') and exists (select 1 from brain.channel_item_results i where i.request_id=r.id and i.work_item_id=old.work_item_id and i.attempt_token=old.attempt_token
            and i.result->>'outcome'=new.outcome and i.result->>'code'=new.error_code and (i.result->>'retryable')::boolean=new.retryable
            and (i.result->>'retryAfterMs')::bigint is not distinct from new.retry_after_ms))
        )
      for share of w,a
    )
  ) then raise exception '오래된 채널 시도' using errcode = 'BRS01'; end if;
  if old.outcome is not null or new.outcome is null or
     new.request_id is distinct from old.request_id or new.work_item_id is distinct from old.work_item_id or
     new.attempt_token is distinct from old.attempt_token or new.created_at is distinct from old.created_at or
     new.finished_at is null or
     (new.outcome = 'sent' and (new.error_code is not null or new.retryable is not null or new.retry_after_ms is not null)) or
     (new.outcome in ('unknown','definite_failed') and (new.external_message_id is not null or new.error_code is null or new.retryable is null)) then
    raise exception '채널 결과는 한 번만 확정할 수 있습니다' using errcode = 'BRS01';
  end if;
  return new;
end $$;
create function brain.extension_event_emit_v2(
 p_work uuid,p_attempt uuid,p_event text,p_key text,p_subject_date date,p_revision text,
 p_summary text,p_document uuid,p_albums jsonb,p_messages jsonb,p_intent text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare w brain.work_items%rowtype; source_name text; item jsonb; album jsonb;
 document jsonb; albums jsonb := '[]'::jsonb; photos jsonb; loc jsonb;
 result_id uuid; body_bundle jsonb; messages jsonb; idx integer;
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
 if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages) not between 1 and 4 then raise exception 'invalid messages'; end if;
 if p_intent is not null then
   if length(p_intent) not between 1 and 200 or not exists(select 1 from brain.work_manual_requests where work_id=p_work) then raise exception 'invalid send intent' using errcode='42501'; end if;
   p_key := 'send-intent:' || md5(jsonb_build_array(p_key,p_intent)::text);
 end if;
 messages := '[]'::jsonb;
 for item in select value from jsonb_array_elements(p_messages) loop
   if jsonb_typeof(item) is distinct from 'object' or jsonb_typeof(item->'itemId') is distinct from 'string'
     or length(item->>'itemId') not between 1 and 200 or item->>'itemId' ~ '^(album:|document$)' or jsonb_typeof(item->'text') is distinct from 'string'
     or brain.utf16_length(item->>'text') not between 1 and 4000
     or exists(select 1 from jsonb_array_elements(messages) m where m->>'itemId'=item->>'itemId')
   then raise exception 'invalid message'; end if;
   messages := messages || jsonb_build_array(jsonb_build_object('type','text','itemId',item->>'itemId','text',item->>'text'));
 end loop;
 -- A semantic key acknowledges once, regardless of route or schedule changes.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_event,p_key)::text,12));
 select id into result_id from brain.result_events where event=p_event and semantic_key=p_key;
 if found then
   -- 같은 결과의 명시적 수동 요청은 보관 이벤트를 현재 구독에 한 번 접수한다.
   -- 원본의 종료된 attempt 대신 현재 검증된 수동 요청 출처를 사용한다.
   if exists(select 1 from brain.work_manual_requests where work_id=p_work) then
     perform brain.dispatch_result_event(result_id,now(),true,p_work,p_attempt);
   end if;
   return result_id;
 end if;
 if p_document is null then
   if p_albums is not null then raise exception 'invalid bundle'; end if;
   body_bundle := null;
 else
   if jsonb_typeof(p_albums) is distinct from 'array' or jsonb_array_length(p_albums)>20 then raise exception 'invalid albums'; end if;
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

 body_bundle := jsonb_build_object('version',2,'items',messages);
 if p_document is not null then
   idx := 0;
   for album in select value from jsonb_array_elements(albums) loop
     body_bundle := jsonb_set(body_bundle,'{items}',(body_bundle->'items') || jsonb_build_array(album || jsonb_build_object('type','album','itemId','album:'||idx)));
     idx := idx+1;
   end loop;
   body_bundle := jsonb_set(body_bundle,'{items}',(body_bundle->'items') || jsonb_build_array(jsonb_build_object('type','document','itemId','document','document',document)));
 end if;
 result_id := gen_random_uuid();
 insert into brain.result_events(id,event,semantic_key,producer,subject_date,revision,body,bundle,created_at,requested,source_work_item_id,source_attempt_token)
 values(result_id,p_event,p_key,source_name,p_subject_date,p_revision,p_summary,body_bundle,now(),exists(select 1 from brain.work_manual_requests where work_id=p_work),p_work,p_attempt);
 if p_intent is not null then perform brain.dispatch_result_event(result_id,now(),true,p_work,p_attempt); end if;
 return result_id;
end $$;
revoke all on function brain.extension_event_emit_v2(uuid,uuid,text,text,date,text,text,uuid,jsonb,jsonb,text) from public;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname ~ '^brain_ext_[a-z][a-z0-9_]{0,30}$'
   and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
  execute format('grant execute on function brain.extension_event_emit_v2(uuid,uuid,text,text,date,text,text,uuid,jsonb,jsonb,text) to %I',r.rolname);
 end loop;
end $$;
