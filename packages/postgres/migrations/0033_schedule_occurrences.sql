-- Preserve the existing wall-clock rule: fold chooses the first instant and
-- a gap advances to the transition instant, independently of PG's default.
create function brain.migration_0033_occurrence(d date, t text, z text)
returns timestamptz language sql stable strict as $$
  with wall as (select d + t::time as ts),
  anchor as (select ts, ts at time zone z as a from wall),
  candidates as (
    select i, i at time zone z as local_ts, ts
    from anchor cross join lateral generate_series(a - interval '3 hours', a + interval '3 hours', interval '1 minute') i
  )
  select coalesce(min(i) filter (where local_ts = ts), min(i) filter (where local_ts > ts)) from candidates
$$;

alter table brain.schedules
  add column trigger_kind text,
  add column cron_expr text,
  add column run_at timestamptz,
  add column trigger_updated_at timestamptz,
  add column time_zone_source text,
  add column extension text,
  add column schedule_key text,
  add column user_id uuid references brain.users(id),
  add column enabled boolean not null default true,
  add column removed_at timestamptz;

do $$
declare self_id uuid;
begin
  select id into self_id from brain.users where is_self = 1;
  if self_id is null and exists (select 1 from brain.schedules) then
    raise exception 'USER_MISSING: existing rows require a self user';
  end if;
  update brain.schedules set user_id = self_id;
end $$;

update brain.schedules set
  trigger_kind = case when local_time is not null then 'cron' when interval_seconds is not null then 'interval' else 'once' end,
  cron_expr = case when local_time is not null then extract(minute from local_time::time)::int::text || ' ' || extract(hour from local_time::time)::int::text || ' * * *' end,
  run_at = case when local_time is null and interval_seconds is null then coalesce(next_run_at, last_run_at, created_at) end,
  time_zone_source = case when local_time is not null then 'user' end,
  extension = case when position('.' in kind) > 1 then split_part(kind, '.', 1) end,
  schedule_key = case when position('.' in kind) > 1 then kind || ':' || target_kind || ':' || target_id || case when local_time is null then ':' || id::text else '' end end;

alter table brain.schedules alter column user_id set not null,
  alter column trigger_kind set not null,
  drop constraint schedules_daily_shape,
  add constraint schedules_trigger_shape check (
    (trigger_kind = 'cron' and cron_expr is not null and time_zone is not null and time_zone_source is not null and time_zone_source in ('user','fixed') and run_at is null and interval_seconds is null) or
    (trigger_kind = 'once' and run_at is not null and cron_expr is null and time_zone is null and time_zone_source is null and interval_seconds is null) or
    (trigger_kind = 'interval' and interval_seconds is not null and cron_expr is null and run_at is null and time_zone is null and time_zone_source is null)
  );
drop index brain.schedules_daily_target_unique;
create unique index schedules_extension_key_user_unique on brain.schedules (extension, schedule_key, user_id) nulls not distinct where schedule_key is not null;

create table brain.schedule_occurrences (
  schedule_id uuid not null references brain.schedules(id) on delete cascade,
  occurrence_at timestamptz not null,
  time_zone text,
  status text not null check (status in ('pending','claimed','done','skipped','failed')),
  work_id uuid references brain.work_items(id),
  user_id uuid not null references brain.users(id),
  recorded_at timestamptz not null,
  primary key (schedule_id, occurrence_at)
);
create index schedule_occurrences_work_id_idx on brain.schedule_occurrences(work_id);
grant select, insert, update, delete on brain.schedule_occurrences to brain_app;

insert into brain.schedule_occurrences(schedule_id, occurrence_at, time_zone, status, work_id, user_id, recorded_at)
select s.id, brain.migration_0033_occurrence(su.local_date, s.local_time, su.time_zone), su.time_zone, 'done', su.work_id, s.user_id, su.recorded_at
from brain.schedule_successes su join brain.schedules s on s.id = su.schedule_id;

insert into brain.schedule_occurrences(schedule_id, occurrence_at, time_zone, status, work_id, user_id, recorded_at)
select s.id, brain.migration_0033_occurrence(d::date, s.local_time, w.local_time_zone), w.local_time_zone,
  case when d::date between w.claimed_date_from and w.claimed_date_to then 'claimed' else 'pending' end,
  w.id, s.user_id, w.created_at
from brain.work_items w join brain.schedules s on s.id = w.schedule_id
cross join lateral generate_series(w.local_date_from::timestamp, w.local_date_to::timestamp, interval '1 day') d
where w.completed_at is null and s.local_time is not null
on conflict (schedule_id, occurrence_at) do nothing;

alter table brain.extension_work_kinds add column missed_policy text not null default 'latest'
  check (missed_policy in ('latest','coalesce','skip'));
drop table brain.schedule_successes;
alter table brain.schedules drop column local_time;
alter table brain.work_items drop constraint work_local_dates_shape, drop constraint work_claimed_dates_shape,
  drop column local_date_from, drop column local_date_to, drop column claimed_date_from, drop column claimed_date_to, drop column local_time_zone;
drop function brain.migration_0033_occurrence(date,text,text);
