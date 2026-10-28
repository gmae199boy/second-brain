alter table brain.work_items add column outcome text check (outcome in ('succeeded', 'failed', 'cancelled', 'dependency_failed'));
alter table brain.work_items add constraint work_outcome_closed check (outcome is null or completed_at is not null);
alter table brain.work_items add column cancel_requested_at timestamptz;
alter table brain.work_attempts add column incarnation text;
alter table brain.work_attempts add column pid integer check (pid > 0);
alter table brain.work_attempts add column pgid integer check (pgid > 0);
alter table brain.work_attempts add column os_boot_at timestamptz;
alter table brain.work_attempts add column os_started_at timestamptz;
update brain.work_attempts a set outcome = 'died',
  finished_at = greatest(a.started_at, coalesce(a.renewed_at, a.started_at), coalesce(a.last_progress_at, a.started_at))
where a.outcome is null and not exists (
  select 1 from brain.work_items w where w.current_attempt_token = a.token
);
grant select, insert, update, delete on brain.work_attempts to brain_app;
