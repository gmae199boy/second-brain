alter table brain.analysis_snapshots
 add column collect_work_id uuid,
 add column artifacts_work_id uuid;
create unique index analysis_snapshots_inputs_unique
 on brain.analysis_snapshots (collect_work_id, artifacts_work_id)
 where collect_work_id is not null and artifacts_work_id is not null;
