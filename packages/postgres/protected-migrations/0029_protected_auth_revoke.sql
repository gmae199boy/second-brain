-- supervisor는 인증된 broker가 입력 권한과 복제 socket을 폐기한 뒤에만 이 사실을 기록한다.
alter table brain.protected_work_kinds add column requires_input_revoke boolean not null default false;
grant select on brain.protected_work_kinds,brain.schema_migrations to brain_protected_supervisor;
alter table brain.work_attempts add column protected_launch_lease uuid, add column protected_connection_epoch bigint;
alter table brain.work_attempts add constraint protected_launch_identity_pair check (
  (protected_launch_lease is null and protected_connection_epoch is null)
  or (protected_launch_lease is not null and protected_connection_epoch is not null and protected_connection_epoch > 0)
);
-- 청구와 함께 pending을 기록한다. spawning으로 넘어간 뒤에는 미spawn 취소를 허용하지 않는다.
create table brain.protected_input_launches (
  work_id uuid not null, attempt_token uuid not null, run_generation bigint not null,
  state text not null check(state in ('pending','spawning','closed')),
  primary key(work_id,attempt_token)
);
revoke all on brain.protected_input_launches from public,brain_app,brain_protected_supervisor;
grant select on brain.protected_input_launches to brain_protected_supervisor;
create function brain.begin_protected_input_launch(p_work uuid,p_token uuid,p_run bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'brain_protected_supervisor' or p_run<=0 then return false; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
 if not brain.attempt_is_current(p_work,p_token) then return false; end if;
 update brain.protected_input_launches l set state='spawning'
  where l.work_id=p_work and l.attempt_token=p_token and l.run_generation=p_run and l.state='pending'
    and exists(select 1 from brain.work_items w where w.id=p_work and w.attempts=p_run and w.cancel_requested_at is null
      and not exists(select 1 from brain.work_hold_groups h where h.name=w.hold_group));
 return found;
end $$;
create function brain.close_unstarted_protected_input(p_work uuid,p_token uuid,p_run bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'brain_protected_supervisor' or p_run<=0 then return false; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
 if not brain.attempt_is_current(p_work,p_token) then return false; end if;
 update brain.protected_input_launches l set state='closed'
  where l.work_id=p_work and l.attempt_token=p_token and l.run_generation=p_run and l.state='pending'
    and exists(select 1 from brain.work_attempts a where a.token=p_token and a.work_item_id=p_work and a.protected_launch_lease is null and a.protected_connection_epoch is null);
 return found;
end $$;
revoke all on function brain.begin_protected_input_launch(uuid,uuid,bigint),brain.close_unstarted_protected_input(uuid,uuid,bigint) from public,brain_app;
grant execute on function brain.begin_protected_input_launch(uuid,uuid,bigint),brain.close_unstarted_protected_input(uuid,uuid,bigint) to brain_protected_supervisor;
create table brain.protected_auth_revocations (
  work_id uuid not null,
  attempt_token uuid not null,
  run_generation bigint not null check (run_generation > 0),
  connection_epoch bigint not null check (connection_epoch > 0),
  launch_lease uuid not null,
  revoked_at timestamptz not null default clock_timestamp(),
  primary key(work_id,attempt_token)
);
revoke all on brain.protected_auth_revocations from public,brain_app;

create function brain.record_protected_auth_revoke(p_work uuid,p_token uuid,p_run bigint,p_epoch bigint,p_lease uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if session_user<>'brain_protected_supervisor' or p_run<=0 or p_epoch<=0 or p_lease is null then return false; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
 if not brain.attempt_is_current(p_work,p_token) or not exists(select 1 from brain.work_items w join brain.work_attempts a on a.token=w.current_attempt_token
   join brain.protected_work_kinds k on k.kind=w.kind and k.requires_input_revoke
   where w.id=p_work and w.attempts=p_run and a.protected_launch_lease=p_lease and a.protected_connection_epoch=p_epoch) then return false; end if;
 insert into brain.protected_auth_revocations(work_id,attempt_token,run_generation,connection_epoch,launch_lease)
 values(p_work,p_token,p_run,p_epoch,p_lease) on conflict do nothing;
 return found;
end $$;
revoke all on function brain.record_protected_auth_revoke(uuid,uuid,bigint,bigint,uuid) from public,brain_app;
grant execute on function brain.record_protected_auth_revoke(uuid,uuid,bigint,bigint,uuid) to brain_protected_supervisor;

create function brain.guard_auth_input_revoke() returns trigger language plpgsql security definer set search_path='' as $$
declare needs_check boolean:=false;
begin
 if tg_table_name='work_items' then
  if old.current_attempt_token is not null and exists(select 1 from brain.protected_work_kinds k where k.kind=old.kind and k.requires_input_revoke)
    and (new.kind is distinct from old.kind or not exists(select 1 from brain.protected_work_kinds k where k.kind=old.kind and k.requires_input_revoke and k.hold_group=new.hold_group)) then
   raise exception 'PROTECTED_WORK_GROUP_INVALID' using errcode='42501';
  end if;
  if exists(select 1 from brain.protected_work_kinds k where k.kind=new.kind and k.requires_input_revoke)
    and old.current_attempt_token is distinct from new.current_attempt_token and new.current_attempt_token is not null then
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
   if not exists(select 1 from brain.protected_work_kinds k where k.kind=new.kind and k.requires_input_revoke and k.hold_group=new.hold_group) then
    raise exception 'PROTECTED_WORK_GROUP_INVALID' using errcode='42501';
   end if;
   if new.hold_group is not null and exists(select 1 from brain.work_hold_groups h where h.name=new.hold_group) then
    raise exception 'AUTH_WORK_HELD' using errcode='42501';
   end if;
   insert into brain.protected_input_launches(work_id,attempt_token,run_generation,state)
    values(new.id,new.current_attempt_token,new.attempts,'pending');
  end if;
  if exists(select 1 from brain.protected_work_kinds k where k.kind=old.kind and k.requires_input_revoke)
    and old.current_attempt_token is not null and old.cancel_requested_at is null and new.cancel_requested_at is not null then
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
   if not exists(select 1 from brain.protected_auth_revocations r join brain.work_attempts a on a.token=r.attempt_token
     where r.work_id=old.id and r.attempt_token=old.current_attempt_token and r.run_generation=old.attempts
       and r.connection_epoch=a.protected_connection_epoch and r.launch_lease=a.protected_launch_lease)
     and not exists(select 1 from brain.protected_input_launches l where l.work_id=old.id and l.attempt_token=old.current_attempt_token and l.run_generation=old.attempts and l.state='closed') then
    raise exception 'AUTH_INPUT_REVOKE_REQUIRED' using errcode='42501';
   end if;
  end if;
  return new;
 elsif tg_table_name='work_hold_groups' then
  needs_check:=tg_op='INSERT' and exists(select 1 from brain.protected_work_kinds k where k.hold_group=new.name and k.requires_input_revoke);
 elsif tg_table_name='extensions' then
  needs_check:=old.enabled and not new.enabled and exists(select 1 from brain.protected_work_kinds k where k.extension_name=old.name and k.requires_input_revoke);
 end if;
 if needs_check then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('brain.protected.auth.revoke',0));
  if exists(select 1 from brain.work_items w join brain.protected_work_kinds k on k.kind=w.kind and k.requires_input_revoke
    where (case when tg_table_name='work_hold_groups' then k.hold_group=new.name else k.extension_name=new.name end)
    and w.current_attempt_token is not null and w.completed_at is null
    and not exists(select 1 from brain.protected_auth_revocations r join brain.work_attempts a on a.token=r.attempt_token
      where r.work_id=w.id and r.attempt_token=w.current_attempt_token and r.run_generation=w.attempts
        and r.connection_epoch=a.protected_connection_epoch and r.launch_lease=a.protected_launch_lease)
    and not exists(select 1 from brain.protected_input_launches l where l.work_id=w.id and l.attempt_token=w.current_attempt_token and l.run_generation=w.attempts and l.state='closed')) then
   raise exception 'AUTH_INPUT_REVOKE_REQUIRED' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
revoke all on function brain.guard_auth_input_revoke() from public,brain_app;
create trigger auth_input_revoke_work before update on brain.work_items for each row execute function brain.guard_auth_input_revoke();
create trigger auth_input_revoke_hold before insert on brain.work_hold_groups for each row execute function brain.guard_auth_input_revoke();
create trigger auth_input_revoke_disable before update on brain.extensions for each row execute function brain.guard_auth_input_revoke();
