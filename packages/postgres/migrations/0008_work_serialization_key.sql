alter table brain.work_items add column serialization_key text
  check (serialization_key is null or length(serialization_key) between 1 and 200);

create index work_items_serialization_key_open_idx
  on brain.work_items (serialization_key)
  where serialization_key is not null and completed_at is null;
