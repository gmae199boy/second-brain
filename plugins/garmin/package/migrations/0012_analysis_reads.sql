-- Expose only the fields needed to build a core analysis input snapshot.
create view garmin.body_records as
 select d.account, b.dataset, b.measured_on, b.sidecar
 from garmin.body_measurements b join garmin.datasets d on d.dataset = b.dataset;
create view garmin.collect_target_accounts as
 select target_kind, target_id, account, dataset from garmin.collect_targets;
grant select on garmin.body_records, garmin.collect_target_accounts to brain_app;
