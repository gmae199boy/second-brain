-- Advance a schedule together with its queue insertion: a crash must never
-- leave a firing recorded without its work, or enqueue the same firing twice.
create table schedules (
  id text primary key,
  kind text not null,
  target_kind text not null,
  target_id text not null,
  interval_seconds integer,
  next_run_at text,
  last_run_at text,
  created_at text not null,
  check (interval_seconds is null or interval_seconds > 0),
  check (interval_seconds is null or next_run_at is not null),
  check (created_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  check (next_run_at is null or next_run_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  check (last_run_at is null or last_run_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;
create index schedules_due_idx on schedules (next_run_at) where next_run_at is not null;
