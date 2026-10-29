create table brain.work_dependencies (
  work_item_id uuid not null references brain.work_items(id),
  prerequisite_id uuid not null references brain.work_items(id),
  primary key (work_item_id, prerequisite_id),
  check (work_item_id <> prerequisite_id)
);
create index work_dependencies_prerequisite on brain.work_dependencies(prerequisite_id);
grant select, insert on brain.work_dependencies to brain_app;
