alter table brain.work_items
  add constraint work_items_closed_outcome check (completed_at is null or outcome is not null) not valid;
