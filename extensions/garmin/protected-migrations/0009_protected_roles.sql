insert into brain.protected_work_kinds(kind,hold_group,extension_name) values
 ('garmin.auth','extension:garmin','garmin'),('garmin.collect','extension:garmin','garmin'),('garmin.release_block','extension:garmin','garmin');

-- 보호된 supervisor와 broker만 보호 함수를 호출한다. 역할은 NOLOGIN으로 준비된다.

create or replace function garmin.reserve_admission(p_work uuid, p_token uuid, p_generation bigint,
 p_target text, p_binding_generation bigint, p_zone text default 'UTC') returns boolean
language plpgsql security definer set search_path='' as $$
declare b record; w record;
begin
 if session_user <> 'brain_protected_supervisor' or p_zone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone) or not brain.attempt_is_current(p_work,p_token) then return false; end if;
 select kind, attempts, cancel_requested_at, hold_group into w from brain.work_items where id=p_work for share;
 if not found or w.kind not in ('garmin.auth','garmin.collect') or w.attempts<>p_generation
    or w.cancel_requested_at is not null or (w.hold_group is not null and exists
      (select 1 from brain.work_hold_groups where name=w.hold_group)) then return false; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('garmin.admission',0));
 select binding.protection_id, binding.generation, p.profile_id into b
   from garmin.account_binding binding join garmin.account_protection p on p.id=binding.protection_id
   where binding.target=p_target for update of binding,p;
 if not found or b.generation<>p_binding_generation then return false; end if;
 if exists(select 1 from garmin.admission_holder h where h.discovery_exclusive
           or b.profile_id is null or h.protection_id=b.protection_id) then return false; end if;
 if b.profile_id is null and exists (select 1 from garmin.account_protection p where p.id<>b.protection_id
     and (p.auth_required or p.rate_day is not null or p.manual_required or p.uncertain
       or exists(select 1 from garmin.external_call_intent i where i.protection_id=p.id and i.outcome is null))) then return false; end if;
 insert into garmin.admission_holder(work_id,attempt_token,run_generation,target,binding_generation,protection_id,discovery_exclusive,time_zone)
 values(p_work,p_token,p_generation,p_target,p_binding_generation,b.protection_id,b.profile_id is null,p_zone);
 return true;
end $$;

create or replace function garmin.admission_valid(p_work uuid, p_token uuid, p_generation bigint,
 p_target text, p_binding_generation bigint) returns boolean
language sql volatile security definer set search_path='' as $$
 select session_user='brain_protected_broker' and brain.attempt_is_current(p_work,p_token) and exists (
  select 1 from garmin.admission_holder h join garmin.account_binding b on b.target=h.target
  join brain.work_items w on w.id=h.work_id
  where h.work_id=p_work and h.attempt_token=p_token and h.run_generation=p_generation
   and h.target=p_target and h.binding_generation=p_binding_generation
   and b.generation=h.binding_generation and b.protection_id=h.protection_id
   and w.attempts=p_generation and w.kind in ('garmin.auth','garmin.collect')
   and w.cancel_requested_at is null and not exists (select 1 from brain.work_hold_groups g where g.name=w.hold_group)
 )
$$;

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
 elsif w.kind='garmin.auth' then selected_target:=p_target;
 else return pg_catalog.jsonb_build_object('state','blocked'); end if;
 select binding.generation,binding.protection_id,p.profile_id into b from garmin.account_binding binding
  join garmin.account_protection p on p.id=binding.protection_id where binding.target=selected_target;
 if not found or (w.kind='garmin.collect' and (b.profile_id is null or b.profile_id<>w.target_id)) then return pg_catalog.jsonb_build_object('state','blocked'); end if;
 if exists(select 1 from garmin.admission_holder h where h.discovery_exclusive or b.profile_id is null or h.protection_id=b.protection_id) then return pg_catalog.jsonb_build_object('state','busy'); end if;
 if garmin.reserve_admission(p_work,p_token,p_generation,selected_target,b.generation,p_zone) then
  return pg_catalog.jsonb_build_object('state','admitted','target',selected_target);
 end if;
 return pg_catalog.jsonb_build_object('state','blocked');
end $$;

create or replace function garmin.release_work_admission(p_work uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare held record;
begin
 if session_user <> 'brain_protected_supervisor' then return false; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('garmin.admission',0));
 select * into held from garmin.admission_holder where work_id=p_work and attempt_token=p_token for update;
 if not found or not brain.attempt_is_current(p_work,p_token) then return false; end if;
 if exists(select 1 from garmin.external_call_intent where protection_id=held.protection_id and outcome is null) then return false; end if;
 delete from garmin.admission_holder where work_id=p_work and attempt_token=p_token;
 return true;
end $$;

create or replace function garmin.bind_admitted_profile(p_work uuid,p_token uuid,p_run bigint,p_target text,p_generation bigint,p_profile text)
returns bigint language plpgsql security definer set search_path='' as $$
declare old_id uuid; dest_id uuid; old_profile text; new_generation bigint;
begin
 if session_user<>'brain_protected_broker' or p_profile is null or length(p_profile)=0 then return null; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('garmin.admission',0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('garmin.binding',0));
 if not garmin.admission_valid(p_work,p_token,p_run,p_target,p_generation) then return null; end if;
 if not exists(select 1 from brain.work_items where id=p_work and kind='garmin.auth') then return null; end if;
 select b.protection_id,p.profile_id into old_id,old_profile from garmin.account_binding b
  join garmin.account_protection p on p.id=b.protection_id where b.target=p_target for update of b;
 if old_profile is not null and old_profile<>p_profile then return null; end if;
 select id into dest_id from garmin.account_protection where profile_id=p_profile;
 if dest_id is null then dest_id:=old_id; end if;
 perform id from garmin.account_protection where id in (old_id,dest_id) order by id for update;
 if exists(select 1 from garmin.admission_holder where protection_id=dest_id and work_id<>p_work) then return null; end if;
 if old_id<>dest_id then
  if exists(select 1 from garmin.probe_reservation a join garmin.probe_reservation b on a.day=b.day
    where a.protection_id=old_id and b.protection_id=dest_id) then return null; end if;
  update garmin.account_protection d set auth_required=d.auth_required or s.auth_required,
   rate_day=case when d.rate_day is null then s.rate_day when s.rate_day is null then d.rate_day else greatest(d.rate_day,s.rate_day) end,
   manual_required=d.manual_required or s.manual_required,uncertain=d.uncertain or s.uncertain,
   consecutive_403=greatest(d.consecutive_403,s.consecutive_403),rate_generation=greatest(d.rate_generation,s.rate_generation)+1,
   last_request_day=case when s.last_finished_at>d.last_finished_at or d.last_finished_at is null then s.last_request_day else d.last_request_day end,
   last_finished_at=greatest(d.last_finished_at,s.last_finished_at),version=d.version+1
   from garmin.account_protection s where d.id=dest_id and s.id=old_id;
  update garmin.tokenstore_identity set protection_id=dest_id where protection_id=old_id;
  update garmin.external_call_intent set protection_id=dest_id where protection_id=old_id;
  update garmin.probe_reservation set protection_id=dest_id where protection_id=old_id;
  update garmin.account_binding set protection_id=dest_id,generation=generation+1 where protection_id=old_id;
  update garmin.account_binding set generation=generation+1 where protection_id=dest_id and target<>p_target;
 else
  update garmin.account_protection set profile_id=p_profile,version=version+1 where id=old_id;
  update garmin.account_binding set generation=generation+1 where protection_id=old_id;
 end if;
 select generation into new_generation from garmin.account_binding where target=p_target;
 update garmin.admission_holder set protection_id=dest_id,binding_generation=new_generation,discovery_exclusive=false
  where work_id=p_work and attempt_token=p_token and target=p_target;
 if old_id<>dest_id then delete from garmin.account_protection where id=old_id; end if;
 return new_generation;
end $$;

create or replace function garmin.release_protection(p_work uuid,p_token uuid,p_profile text) returns boolean
language plpgsql security definer set search_path='' as $$
declare account uuid; w record;
begin
 if session_user<>'brain_protected_broker' or p_profile is null or p_profile='default' or not brain.attempt_is_current(p_work,p_token) then return false; end if;
 select kind,target_kind,target_id,cancel_requested_at,hold_group,schedule_id into w from brain.work_items where id=p_work for share;
 if not found or w.kind<>'garmin.release_block' or w.target_kind<>'extension' or w.target_id<>p_profile or w.schedule_id is not null
  or w.cancel_requested_at is not null or exists(select 1 from brain.work_hold_groups where name=w.hold_group) then return false; end if;
 select id into account from garmin.account_protection where profile_id=p_profile for update;
 if not found then return false; end if;
 update garmin.account_protection set rate_day=null,manual_required=false,consecutive_403=0,rate_generation=rate_generation+1,version=version+1 where id=account;
 insert into garmin.protection_release_events(work_id,attempt_token,protection_id) values (p_work,p_token,account);
 return true;
end $$;

create or replace function garmin.complete_verified_auth(p_work uuid,p_token uuid,p_run bigint,p_target text,p_generation bigint,p_profile text)
returns boolean language plpgsql security definer set search_path='' as $$
declare account uuid;
begin
 if session_user<>'brain_protected_broker' or not garmin.admission_valid(p_work,p_token,p_run,p_target,p_generation)
  or not exists(select 1 from brain.work_items where id=p_work and kind='garmin.auth') then return false; end if;
 select p.id into account from garmin.account_binding b join garmin.account_protection p on p.id=b.protection_id
  where b.target=p_target and b.generation=p_generation and p.profile_id=p_profile for update of b,p;
 if not found or not exists(select 1 from garmin.auth_success_evidence e where e.work_id=p_work and e.attempt_token=p_token
  and e.run_generation=p_run and e.binding_generation=p_generation and e.profile_id=p_profile) then return false; end if;
 if exists(select 1 from garmin.external_call_intent where protection_id=account and outcome is null)
  or not exists(select 1 from garmin.external_call_intent where protection_id=account and work_id=p_work and attempt_token=p_token
   and run_generation=p_run and binding_generation=p_generation and stage='auth' and outcome='success') then return false; end if;
 update garmin.account_protection set auth_required=false,version=version+1 where id=account;
 delete from garmin.auth_success_evidence where work_id=p_work and attempt_token=p_token;
 return true;
end $$;

create or replace function garmin.start_external_call(p_work uuid,p_token uuid,p_run bigint,p_target text,p_generation bigint,
 p_stage text,p_endpoint text,p_zone text,p_request_day date,p_first_call boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare p record; w record; t timestamptz; local_day date; intent uuid; slots integer;
begin
 if session_user<>'brain_protected_broker' or not garmin.admission_valid(p_work,p_token,p_run,p_target,p_generation)
  or p_stage not in ('auth','data','probe') or p_endpoint !~ '^[a-z][a-z0-9_]{0,63}$'
  or p_first_call is null or p_zone is null or not exists(select 1 from garmin.admission_holder where work_id=p_work and attempt_token=p_token and time_zone=p_zone)
  or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_zone)
  then raise exception 'PROTECTION_INVALID_ATTEMPT'; end if;
 select kind into w from brain.work_items where id=p_work;
 if (p_stage='auth' and w.kind<>'garmin.auth') or (p_stage in ('data','probe') and w.kind<>'garmin.collect')
  then raise exception 'PROTECTION_INVALID_ATTEMPT'; end if;
 select protection.* into p from garmin.account_binding b join garmin.account_protection protection on protection.id=b.protection_id
  where b.target=p_target and b.generation=p_generation for update of b,protection;
 if not found then raise exception 'PROTECTION_BINDING_CHANGED'; end if;
 t:=pg_catalog.clock_timestamp(); local_day:=(t at time zone p_zone)::date;
 if p.uncertain or exists(select 1 from garmin.external_call_intent i where i.protection_id=p.id and i.outcome is null)
  then raise exception 'PROTECTION_UNCERTAIN'; end if;
 if p_stage='auth' and exists(select 1 from garmin.external_call_intent i where i.protection_id=p.id and i.attempt_token=p_token
  and i.stage='auth' and i.outcome in ('403','auth_required')) then raise exception 'PROTECTION_BLOCKED'; end if;
 if p.manual_required or (p.auth_required and (p_stage<>'auth' or p.profile_id is null)) then raise exception 'PROTECTION_BLOCKED'; end if;
 if p.rate_day is not null and (p_stage<>'probe' or p.auth_required or local_day<=p.rate_day) then raise exception 'PROTECTION_BLOCKED'; end if;
 if p_stage='probe' and p.rate_day is null then raise exception 'PROTECTION_INVALID_PROBE'; end if;
 if p.profile_id is null and exists(select 1 from garmin.account_protection other where other.id<>p.id
  and (other.auth_required or other.rate_day is not null or other.manual_required or other.uncertain
   or exists(select 1 from garmin.external_call_intent i where i.protection_id=other.id and i.outcome is null)))
  then raise exception 'PROTECTION_DISCOVERY_BLOCKED'; end if;
 if p.last_finished_at is not null and t<p.last_finished_at + (case when p_request_day is not null and p.last_request_day is not null
  and p_request_day<>p.last_request_day then interval '5 seconds' else interval '1 second' end) then raise exception 'PROTECTION_PACING'; end if;
 if p_first_call then
  insert into garmin.first_call_budget(work_id,endpoint,used) values(p_work,p_endpoint,1)
   on conflict(work_id,endpoint) do update set used=garmin.first_call_budget.used+1
   where garmin.first_call_budget.used<3 returning used into slots;
  if not found then raise exception 'PROTECTION_FIRST_CALL_LIMIT'; end if;
 end if;
 intent:=pg_catalog.gen_random_uuid();
 insert into garmin.external_call_intent(id,protection_id,work_id,attempt_token,run_generation,binding_generation,stage,endpoint,started_at,request_day,time_zone,first_call)
  values(intent,p.id,p_work,p_token,p_run,p_generation,p_stage,p_endpoint,t,p_request_day,p_zone,p_first_call);
 if p_stage='probe' then
  insert into garmin.probe_reservation values(p.id,local_day,p.rate_generation,intent) on conflict do nothing;
  if not found then raise exception 'PROTECTION_PROBE_RESERVED'; end if;
 end if;
 return intent;
end $$;

create or replace function garmin.finish_external_call(p_work uuid,p_token uuid,p_run bigint,p_target text,p_generation bigint,
 p_intent uuid,p_outcome text) returns boolean language plpgsql security definer set search_path='' as $$
declare i record; p record; t timestamptz; local_day date; reservation bigint;
begin
 if session_user<>'brain_protected_broker' or p_outcome not in ('success','403','429','auth_required','other')
  or not garmin.admission_valid(p_work,p_token,p_run,p_target,p_generation) then return false; end if;
 select * into i from garmin.external_call_intent where id=p_intent and work_id=p_work and attempt_token=p_token
  and run_generation=p_run and binding_generation=p_generation and outcome is null for update;
 if not found then return false; end if;
 select * into p from garmin.account_protection where id=i.protection_id for update;
 if not found or not exists(select 1 from garmin.account_binding where target=p_target and generation=p_generation and protection_id=p.id) then return false; end if;
 t:=pg_catalog.clock_timestamp();
 if t<i.started_at then return false; end if;
 local_day:=(t at time zone i.time_zone)::date;
 if i.stage='probe' then
  select rate_generation into reservation from garmin.probe_reservation where intent_id=p_intent;
  if not found or reservation<>p.rate_generation then return false; end if;
 end if;
 update garmin.external_call_intent set outcome=p_outcome,finished_at=t where id=p_intent;
 update garmin.account_protection set
  auth_required=auth_required or p_outcome='auth_required' or (i.stage='auth' and p_outcome='403'),
  consecutive_403=case when p_outcome='403' and i.stage='data' and not i.first_call then consecutive_403+1
   when p_outcome='success' and i.stage='data' and not i.first_call then 0 else consecutive_403 end,
  rate_day=case when i.stage='probe' and p_outcome='success' then null
   when p_outcome='429' or (p_outcome='403' and i.stage='data' and (i.first_call or consecutive_403+1>=3)) then local_day else rate_day end,
  manual_required=manual_required or (i.stage='probe' and p_outcome in ('403','429')) or (i.first_call and p_outcome='403'),
  rate_generation=rate_generation+case when p_outcome='429' or (p_outcome='403' and i.stage='data' and (i.first_call or consecutive_403+1>=3)) then 1 else 0 end,
  last_finished_at=t,last_request_day=coalesce(i.request_day,last_request_day),version=version+1 where id=p.id;
 return true;
end $$;

revoke all on function garmin.reserve_admission(uuid,uuid,bigint,text,bigint,text),
 garmin.reserve_work_admission(uuid,uuid,bigint,text,text), garmin.release_work_admission(uuid,uuid),
 garmin.admission_valid(uuid,uuid,bigint,text,bigint), garmin.bind_admitted_profile(uuid,uuid,bigint,text,bigint,text),
 garmin.release_protection(uuid,uuid,text), garmin.complete_verified_auth(uuid,uuid,bigint,text,bigint,text),
 garmin.start_external_call(uuid,uuid,bigint,text,bigint,text,text,text,date,boolean),
 garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text) from public, brain_app, brain_ext_garmin, brain_protected_worker;
grant usage on schema garmin to brain_protected_supervisor, brain_protected_broker;
grant execute on function garmin.reserve_admission(uuid,uuid,bigint,text,bigint,text),
 garmin.reserve_work_admission(uuid,uuid,bigint,text,text), garmin.release_work_admission(uuid,uuid) to brain_protected_supervisor;
grant execute on function garmin.admission_valid(uuid,uuid,bigint,text,bigint),
 garmin.bind_admitted_profile(uuid,uuid,bigint,text,bigint,text), garmin.release_protection(uuid,uuid,text),
 garmin.complete_verified_auth(uuid,uuid,bigint,text,bigint,text),
 garmin.start_external_call(uuid,uuid,bigint,text,bigint,text,text,text,date,boolean),
 garmin.finish_external_call(uuid,uuid,bigint,text,bigint,uuid,text) to brain_protected_broker;
grant select,insert,delete on garmin.auth_success_evidence to brain_protected_broker;
