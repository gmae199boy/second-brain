-- 계정 대상 auth는 확인된 binding의 내부 보호 ID와 일치해야 한다.
create or replace function garmin.reserve_work_admission(p_work uuid,p_token uuid,p_generation bigint,p_target text,p_zone text default 'UTC')
returns jsonb language plpgsql security definer set search_path='' as $$
declare b record; w record; selected_target text;
begin
 if session_user <> 'brain_protected_supervisor' or not brain.attempt_is_current(p_work,p_token) then return pg_catalog.jsonb_build_object('state','blocked'); end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('garmin.admission',0));
 select kind,target_kind,target_id into w from brain.work_items where id=p_work;
 if not found then return pg_catalog.jsonb_build_object('state','blocked'); end if;
 if w.kind='garmin.collect' and w.target_kind='account' then
  select binding.target into selected_target from garmin.account_binding binding
   join garmin.account_protection p on p.id=binding.protection_id where p.profile_id=w.target_id
   order by binding.target collate "C" limit 1;
 elsif w.kind='garmin.auth' and ((w.target_kind='extension' and w.target_id='garmin') or w.target_kind='account') then selected_target:=p_target;
 else return pg_catalog.jsonb_build_object('state','blocked'); end if;
 select binding.generation,binding.protection_id,p.profile_id into b from garmin.account_binding binding
  join garmin.account_protection p on p.id=binding.protection_id where binding.target=selected_target;
 if not found or (w.kind='garmin.collect' and (b.profile_id is null or b.profile_id<>w.target_id))
   or (w.kind='garmin.auth' and w.target_kind='account' and (b.profile_id is null or b.protection_id::text<>w.target_id)) then
  return pg_catalog.jsonb_build_object('state','blocked'); end if;
 if exists(select 1 from garmin.admission_holder h where h.discovery_exclusive or b.profile_id is null or h.protection_id=b.protection_id) then return pg_catalog.jsonb_build_object('state','busy'); end if;
 if garmin.reserve_admission(p_work,p_token,p_generation,selected_target,b.generation,p_zone) then
  return pg_catalog.jsonb_build_object('state','admitted','target',selected_target);
 end if;
 return pg_catalog.jsonb_build_object('state','blocked');
end $$;
