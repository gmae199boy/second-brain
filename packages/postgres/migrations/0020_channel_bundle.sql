alter table brain.channel_requests add column bundle jsonb;
create table brain.channel_item_results (
 request_id uuid not null references brain.channel_requests(id), item_index integer not null check (item_index >= 0),
 work_item_id uuid not null references brain.work_items(id), attempt_token uuid not null,
 result jsonb not null, updated_at timestamptz not null, primary key(request_id,item_index)
);
create function brain.guard_channel_item_result() returns trigger language plpgsql as $$
begin
 if not brain.attempt_is_current(new.work_item_id,new.attempt_token) or not exists (
   select 1 from brain.channel_requests r join brain.channel_attempt_results a on a.request_id=r.id
   where r.id=new.request_id and r.work_item_id=new.work_item_id and r.status='pending' and r.bundle is not null
     and new.item_index < jsonb_array_length(r.bundle->'albums') + 2
     and a.work_item_id=new.work_item_id and a.attempt_token=new.attempt_token and a.outcome is null
 ) then raise exception '오래된 채널 항목 시도' using errcode='BRS01'; end if;
 if tg_op='UPDATE' and (old.result->>'outcome'='sent' or new.request_id<>old.request_id or new.item_index<>old.item_index) then
   raise exception '확정된 채널 항목' using errcode='BRS01';
 end if;
 return new;
end $$;
create trigger channel_item_result_fence before insert or update on brain.channel_item_results for each row execute function brain.guard_channel_item_result();
revoke all on brain.channel_item_results from public;
grant select,insert,update on brain.channel_item_results to brain_app;
do $$ declare r record; begin
 for r in select rolname from pg_roles where rolname like 'brain\_ext\_%' escape '\' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database() loop
   execute format('grant insert (bundle) on brain.channel_requests to %I', r.rolname);
 end loop;
end $$;
-- 미확인 상태에서도 모든 항목의 내구성 있는 성공을 증명한 경우에만 감독자가 성공으로 정산한다.
create or replace function brain.guard_channel_result_update() returns trigger language plpgsql as $$
begin
  if not brain.attempt_is_current(old.work_item_id, old.attempt_token) and not (
    exists (
      select 1 from brain.work_items w join brain.work_attempts a on a.work_item_id=w.id and a.token=w.current_attempt_token
      join brain.channel_requests r on r.id=old.request_id and r.work_item_id=w.id
      where w.id=old.work_item_id and w.current_attempt_token=old.attempt_token and w.completed_at is null and a.outcome='unknown'
        and r.status='pending' and r.bundle is not null and (
          (new.outcome='sent' and exists (select 1 from brain.channel_item_results last where last.request_id=r.id and last.item_index=jsonb_array_length(r.bundle->'albums')+1 and last.result->>'outcome'='sent' and new.external_message_id is not distinct from last.result->>'externalMessageId')
            and (select count(*) from brain.channel_item_results i where i.request_id=r.id and i.result->>'outcome'='sent')=jsonb_array_length(r.bundle->'albums')+2)
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
