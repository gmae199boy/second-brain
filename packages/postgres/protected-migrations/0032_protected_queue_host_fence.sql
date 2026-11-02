-- 보호 supervisor만 시작과 확인된 종료를 기록한다. crash나 불명은 자동 해제하지 않는다.
grant usage on schema brain to brain_protected_supervisor;
create table brain.protected_queue_host_fence (
 singleton boolean primary key default true check (singleton),
 token uuid not null, state text not null check (state in ('running','unknown'))
);
revoke all on brain.protected_queue_host_fence from public,brain_app,brain_protected_supervisor;
create function brain.begin_queue_host(p_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if session_user <> 'brain_protected_supervisor' or p_token is null then return false; end if;
 insert into brain.protected_queue_host_fence(singleton,token,state) values(true,p_token,'running') on conflict do nothing;
 return found;
end $$;
create function brain.settle_queue_host(p_token uuid,p_confirmed boolean) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
begin
 if session_user <> 'brain_protected_supervisor' or p_token is null or p_confirmed is null then return false; end if;
 if p_confirmed then
   delete from brain.protected_queue_host_fence where singleton and token=p_token and state='running';
 else
   update brain.protected_queue_host_fence set state='unknown' where singleton and token=p_token and state='running';
 end if;
 return found;
end $$;
revoke all on function brain.begin_queue_host(uuid),brain.settle_queue_host(uuid,boolean) from public,brain_app;
grant execute on function brain.begin_queue_host(uuid),brain.settle_queue_host(uuid,boolean) to brain_protected_supervisor;
