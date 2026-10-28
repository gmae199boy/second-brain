alter table brain.work_items add column execution_class text;
update brain.work_items set execution_class = 'core';
alter table brain.work_items alter column execution_class set not null;
alter table brain.work_items add constraint work_execution_class check (execution_class in ('core', 'supervised'));
alter table brain.work_items add column current_attempt_token uuid;
create table brain.work_attempts (
  token uuid primary key,
  work_item_id uuid not null references brain.work_items(id),
  started_at timestamptz not null,
  last_progress_at timestamptz,
  renewed_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome in ('succeeded', 'failed', 'stalled', 'died', 'cancelled', 'unknown')),
  check ((finished_at is null) = (outcome is null))
);
create index work_attempts_work_item on brain.work_attempts(work_item_id);
alter table brain.work_items add constraint work_current_attempt foreign key (current_attempt_token) references brain.work_attempts(token);
alter table brain.work_items add constraint work_attempt_claim check (current_attempt_token is null or (claimed_at is not null and claim_expires_at is not null and claimed_by is not null));
grant select, insert, update, delete on brain.work_attempts to brain_app;
