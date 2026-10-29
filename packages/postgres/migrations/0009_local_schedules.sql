alter table brain.schedules
  add column local_time text check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column time_zone text,
  add constraint schedules_daily_shape check (
    (local_time is null and time_zone is null) or
    (local_time is not null and time_zone is not null and interval_seconds is null and next_run_at is not null)
  );
create unique index schedules_daily_target_unique on brain.schedules (kind, target_kind, target_id) where local_time is not null;
alter table brain.work_items
  add column schedule_id uuid references brain.schedules(id) on delete set null,
  add column local_date_from date,
  add column local_date_to date,
  add column local_time_zone text,
  add column claimed_date_from date,
  add column claimed_date_to date,
  add constraint work_local_dates_shape check (
    (local_date_from is null and local_date_to is null and local_time_zone is null) or
    (local_date_from is not null and local_date_to is not null and local_time_zone is not null and local_date_from <= local_date_to)
  ),
  add constraint work_claimed_dates_shape check (
    (claimed_date_from is null and claimed_date_to is null) or
    (claimed_date_from is not null and claimed_date_to is not null and claimed_date_from <= claimed_date_to)
  );
create table brain.schedule_successes (
  schedule_id uuid not null references brain.schedules(id) on delete cascade,
  local_date date not null,
  time_zone text not null,
  work_id uuid not null references brain.work_items(id),
  recorded_at timestamptz not null,
  primary key (schedule_id, local_date)
);
