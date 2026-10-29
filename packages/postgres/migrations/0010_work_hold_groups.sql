create table brain.work_hold_groups (
  name text primary key check (length(name) between 1 and 200),
  held_at timestamptz not null
);
alter table brain.work_items add column hold_group text
  check (hold_group is null or length(hold_group) between 1 and 200);
alter table brain.schedules add column hold_group text
  check (hold_group is null or length(hold_group) between 1 and 200);
update brain.work_items set hold_group = 'extension:' || split_part(kind, '.', 1)
  where position('.' in kind) > 0
    and length('extension:' || split_part(kind, '.', 1)) <= 200;
update brain.schedules set hold_group = 'extension:' || split_part(kind, '.', 1)
  where position('.' in kind) > 0
    and length('extension:' || split_part(kind, '.', 1)) <= 200;
grant select, insert, delete on brain.work_hold_groups to brain_app;
