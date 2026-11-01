-- 보호 work 종류와 hold 그룹은 신뢰된 설치 경계만 등록한다.
create table brain.protected_work_kinds (kind text primary key, hold_group text not null, extension_name text not null);
revoke all on brain.protected_work_kinds from public, brain_app;

create function brain.guard_protected_work() returns trigger language plpgsql security definer set search_path='' as $$
declare protected boolean; allowed boolean;
begin
 select session_user = 'brain_protected_supervisor' or coalesce((select rolsuper from pg_catalog.pg_roles where rolname=session_user),false) into allowed;
 if allowed then if tg_op='DELETE' then return old; else return new; end if; end if;
 if tg_table_name in ('work_items','schedules') then
  if tg_op='INSERT' then select exists(select 1 from brain.protected_work_kinds where kind=new.kind) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.protected_work_kinds where kind=old.kind) into protected;
  else select exists(select 1 from brain.protected_work_kinds where kind in (old.kind,new.kind)) into protected; end if;
 elsif tg_table_name in ('extensions','extension_install_progress') then
  if tg_op='INSERT' then select exists(select 1 from brain.protected_work_kinds where extension_name=new.name) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.protected_work_kinds where extension_name=old.name) into protected;
  else select exists(select 1 from brain.protected_work_kinds where extension_name in (old.name,new.name)) into protected; end if;
 elsif tg_table_name='extension_work_kinds' then
  if tg_op='INSERT' then select exists(select 1 from brain.protected_work_kinds where kind=new.kind or extension_name=new.extension_name) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.protected_work_kinds where kind=old.kind or extension_name=old.extension_name) into protected;
  else select exists(select 1 from brain.protected_work_kinds where kind in (old.kind,new.kind) or extension_name in (old.extension_name,new.extension_name)) into protected; end if;
 elsif tg_table_name='schedule_successes' then
  if tg_op='INSERT' then select exists(select 1 from brain.schedules s join brain.protected_work_kinds p on p.kind=s.kind where s.id=new.schedule_id) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.schedules s join brain.protected_work_kinds p on p.kind=s.kind where s.id=old.schedule_id) into protected;
  else select exists(select 1 from brain.schedules s join brain.protected_work_kinds p on p.kind=s.kind where s.id in (old.schedule_id,new.schedule_id)) into protected; end if;
 elsif tg_table_name='work_dependencies' then
  if tg_op='INSERT' then select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id in (new.work_item_id,new.prerequisite_id)) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id in (old.work_item_id,old.prerequisite_id)) into protected;
  else select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id in (old.work_item_id,old.prerequisite_id,new.work_item_id,new.prerequisite_id)) into protected; end if;
 elsif tg_table_name='work_attempts' then
  if tg_op='INSERT' then select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id=new.work_item_id) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id=old.work_item_id) into protected;
  else select exists(select 1 from brain.work_items w join brain.protected_work_kinds p on p.kind=w.kind where w.id in (old.work_item_id,new.work_item_id)) into protected; end if;
 else
  if tg_op='INSERT' then select exists(select 1 from brain.protected_work_kinds where hold_group=new.name) into protected;
  elsif tg_op='DELETE' then select exists(select 1 from brain.protected_work_kinds where hold_group=old.name) into protected;
  else select exists(select 1 from brain.protected_work_kinds where hold_group in (old.name,new.name)) into protected; end if;
 end if;
 if protected then raise exception 'PROTECTED_SERVICE_REQUIRED' using errcode='42501'; end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function brain.guard_protected_work() from public, brain_app;
create trigger protected_work_guard before insert or update or delete on brain.work_items for each row execute function brain.guard_protected_work();
create trigger protected_attempt_guard before insert or update or delete on brain.work_attempts for each row execute function brain.guard_protected_work();
create trigger protected_extension_guard before insert or update or delete on brain.extensions for each row execute function brain.guard_protected_work();
create trigger protected_install_guard before insert or update or delete on brain.extension_install_progress for each row execute function brain.guard_protected_work();
create trigger protected_extension_kind_guard before insert or update or delete on brain.extension_work_kinds for each row execute function brain.guard_protected_work();
create trigger protected_schedule_guard before insert or update or delete on brain.schedules for each row execute function brain.guard_protected_work();
create trigger protected_schedule_success_guard before insert or update or delete on brain.schedule_successes for each row execute function brain.guard_protected_work();
create trigger protected_dependency_guard before insert or update or delete on brain.work_dependencies for each row execute function brain.guard_protected_work();
create trigger protected_hold_guard before insert or update or delete on brain.work_hold_groups for each row execute function brain.guard_protected_work();
grant usage on schema brain to brain_protected_supervisor;
grant select,insert,update,delete on brain.work_items,brain.work_attempts,brain.work_hold_groups,brain.work_dependencies,brain.schedules,brain.schedule_successes,brain.extensions,brain.extension_work_kinds,brain.extension_install_progress to brain_protected_supervisor;
