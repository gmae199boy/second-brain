-- Garmin 인증만 제출별 입력 폐기가 필요한 보호 일감으로 등록한다.
do $$
begin
 update brain.protected_work_kinds set requires_input_revoke=true
  where kind='garmin.auth' and extension_name='garmin' and hold_group='extension:garmin';
 if not found then raise exception 'GARMIN_AUTH_REGISTRY_MISSING'; end if;
end $$;

-- 이미 commit된 auth holder 확인만 허용한다. 새 holder는 만들지 않는다.
create function garmin.supervisor_admission_valid(p_work uuid,p_token uuid,p_run bigint,p_target text,p_binding bigint)
returns boolean language sql volatile security definer set search_path='' as $$
 select session_user='brain_protected_supervisor' and brain.attempt_is_current(p_work,p_token) and exists (
  select 1 from garmin.admission_holder h join garmin.account_binding b on b.target=h.target
  join brain.work_items w on w.id=h.work_id
  where h.work_id=p_work and h.attempt_token=p_token and h.run_generation=p_run
    and h.target=p_target and h.binding_generation=p_binding and b.generation=h.binding_generation
    and b.protection_id=h.protection_id and w.attempts=p_run and w.kind='garmin.auth'
    and w.cancel_requested_at is null and not exists(select 1 from brain.work_hold_groups g where g.name=w.hold_group)
 )
$$;
revoke all on function garmin.supervisor_admission_valid(uuid,uuid,bigint,text,bigint) from public,brain_app,brain_protected_broker,brain_protected_worker;
grant execute on function garmin.supervisor_admission_valid(uuid,uuid,bigint,text,bigint) to brain_protected_supervisor;

-- Core가 예약한 현재 holder의 대상과 세대만 보호 supervisor에 돌려준다.
create function garmin.supervisor_admission_context(p_work uuid,p_token uuid,p_run bigint)
returns table(target text,binding_generation bigint) language sql volatile security definer set search_path='' as $$
 select h.target,h.binding_generation from garmin.admission_holder h
 join garmin.account_binding b on b.target=h.target
 join brain.work_items w on w.id=h.work_id
 where session_user='brain_protected_supervisor' and brain.attempt_is_current(p_work,p_token)
   and h.work_id=p_work and h.attempt_token=p_token and h.run_generation=p_run
   and b.generation=h.binding_generation and b.protection_id=h.protection_id
   and w.kind='garmin.auth' and w.attempts=p_run and w.cancel_requested_at is null
   and not exists(select 1 from brain.work_hold_groups g where g.name=w.hold_group)
$$;
revoke all on function garmin.supervisor_admission_context(uuid,uuid,bigint) from public,brain_app,brain_protected_broker,brain_protected_worker;
grant execute on function garmin.supervisor_admission_context(uuid,uuid,bigint) to brain_protected_supervisor;
