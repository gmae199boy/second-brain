-- Private body input ledger. Core files remain the source of registered bytes.
create table garmin.body_documents (
 dataset text not null references garmin.datasets(dataset), fingerprint text not null, document_hash text not null,
 measured_on date not null, completed boolean not null default false,
 primary key(dataset,fingerprint)
);
create index body_documents_hash on garmin.body_documents(dataset,document_hash);
create table garmin.body_sources (
 dataset text not null references garmin.datasets(dataset), fingerprint text not null,
 source_path text not null, content_hash text not null, mtime_ns bigint not null,
 request_id uuid not null, source_size bigint not null, processed_path text,
 primary key(dataset,fingerprint,source_path),
 foreign key(dataset,fingerprint) references garmin.body_documents(dataset,fingerprint)
);
create index body_sources_path on garmin.body_sources(dataset,source_path);
create table garmin.body_measurements (
 dataset text not null references garmin.datasets(dataset), measured_on date not null,
 sidecar jsonb not null, field_sources jsonb not null,
 primary key(dataset,measured_on)
);
grant select,insert,update on garmin.body_documents,garmin.body_sources,garmin.body_measurements to brain_ext_garmin;
-- Immutable per-attempt raw inputs used by the dependent artifact job.
create table garmin.collect_snapshots (
 id uuid primary key, dataset text not null references garmin.datasets(dataset),
 work_id uuid not null, attempt_token uuid not null, history_start text,
 item_count integer not null check(item_count >= 0), complete boolean not null default false,
 unique(work_id,attempt_token)
);
create table garmin.collect_snapshot_items (
 snapshot_id uuid not null references garmin.collect_snapshots(id), scope text not null,
 key text not null, endpoint text not null, body text not null,
 fetched_at_ms bigint not null, checked_at_ms bigint not null, library_version text not null,
 primary key(snapshot_id,scope,key,endpoint)
);
grant select,insert,update on garmin.collect_snapshots,garmin.collect_snapshot_items to brain_ext_garmin;
