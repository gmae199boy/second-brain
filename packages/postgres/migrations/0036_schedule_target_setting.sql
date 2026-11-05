-- A schedule keeps its declaration; each firing freezes the selected value in its work item.
alter table brain.schedules add column target_setting text;
alter table brain.schedules add constraint schedule_target_setting_owner check (
  target_setting is null or (extension is not null and starts_with(target_setting, extension || '.'))
);
