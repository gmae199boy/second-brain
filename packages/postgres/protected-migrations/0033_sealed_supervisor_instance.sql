-- supervisor의 OS 신원은 spawn 전 기록하고 불명 상태는 자동 해제하지 않는다.
grant usage on schema brain to brain_protected_supervisor;
create table brain.sealed_supervisor_instance (
 singleton boolean primary key default true check(singleton),
 token uuid not null, pid integer not null check(pid>0), uid bigint not null check(uid>0),
 boot_seconds bigint not null check(boot_seconds>0), start_microseconds bigint not null check(start_microseconds>0),
 package_hash text not null check(package_hash ~ '^[0-9a-f]{64}$'), node_hash text not null check(node_hash ~ '^[0-9a-f]{40}$'),
 state text not null check(state in ('starting','verified'))
);
revoke all on brain.sealed_supervisor_instance from public,brain_app,brain_protected_supervisor;
create function brain.record_sealed_supervisor(p_token uuid,p_pid integer,p_uid bigint,p_boot bigint,p_start bigint,p_package text,p_node text) returns boolean
language plpgsql security definer set search_path=pg_catalog set lock_timeout='1500ms' set statement_timeout='1900ms' set transaction_timeout='1900ms' as $$
begin
 if session_user<>'brain_protected_supervisor' or p_token is null or p_pid<=0 or p_uid<=0 or p_boot<=0 or p_start<=0 or p_package !~ '^[0-9a-f]{64}$' or p_node !~ '^[0-9a-f]{40}$' then return false; end if;
 insert into brain.sealed_supervisor_instance(singleton,token,pid,uid,boot_seconds,start_microseconds,package_hash,node_hash,state)
 values(true,p_token,p_pid,p_uid,p_boot,p_start,p_package,p_node,'starting') on conflict do nothing;
 return found;
end $$;
create function brain.confirm_sealed_supervisor(p_token uuid,p_pid integer,p_uid bigint,p_boot bigint,p_start bigint,p_package text,p_node text) returns boolean
language plpgsql security definer set search_path=pg_catalog set lock_timeout='1500ms' set statement_timeout='1900ms' set transaction_timeout='1900ms' as $$
begin
 if session_user<>'brain_protected_supervisor' then return false; end if;
 update brain.sealed_supervisor_instance set state='verified' where singleton and state='starting' and token=p_token and pid=p_pid and uid=p_uid and boot_seconds=p_boot and start_microseconds=p_start and package_hash=p_package and node_hash=p_node;
 return found;
end $$;
create function brain.release_sealed_supervisor(p_token uuid) returns boolean
language plpgsql security definer set search_path=pg_catalog set lock_timeout='1500ms' set statement_timeout='1900ms' set transaction_timeout='1900ms' as $$
begin
 if session_user<>'brain_protected_supervisor' or p_token is null then return false; end if;
 delete from brain.sealed_supervisor_instance where singleton and token=p_token;
 return found;
end $$;
revoke all on function brain.record_sealed_supervisor(uuid,integer,bigint,bigint,bigint,text,text),brain.confirm_sealed_supervisor(uuid,integer,bigint,bigint,bigint,text,text),brain.release_sealed_supervisor(uuid) from public,brain_app;
grant execute on function brain.record_sealed_supervisor(uuid,integer,bigint,bigint,bigint,text,text),brain.confirm_sealed_supervisor(uuid,integer,bigint,bigint,bigint,text,text),brain.release_sealed_supervisor(uuid) to brain_protected_supervisor;
-- host는 root registry의 digest와 OS가 보고한 실제 process identity를 전달한다.
create function brain.sealed_supervisor_current(p_pid integer,p_uid bigint,p_boot bigint,p_start bigint,p_package text,p_node text) returns boolean
language sql security definer set search_path=pg_catalog set lock_timeout='1500ms' set statement_timeout='1900ms' set transaction_timeout='1900ms' as $$
 select session_user='brain_protected_supervisor' and exists(select 1 from brain.sealed_supervisor_instance where singleton and state='verified' and pid=p_pid and uid=p_uid and boot_seconds=p_boot and start_microseconds=p_start and package_hash=p_package and node_hash=p_node)
$$;
revoke all on function brain.sealed_supervisor_current(integer,bigint,bigint,bigint,text,text) from public,brain_app;
grant execute on function brain.sealed_supervisor_current(integer,bigint,bigint,bigint,text,text) to brain_protected_supervisor;
