-- Same-extension schedule key; existing occurrences and user edits stay intact.
alter table brain.schedules add column after_schedule text;
alter table brain.schedules add constraint schedule_dependency_shape check (
  after_schedule is null or (extension is not null and schedule_key is not null and after_schedule <> schedule_key and length(btrim(after_schedule)) > 0)
);
