-- 각 파일과 명시적 inventory의 상태를 dataset 및 batch에 보존한다.
create table garmin.artifact_inventory (
 dataset text not null references garmin.datasets(dataset), artifact_key text not null, batch text not null references garmin.import_batches(id),
 category text not null, content_hash text, size_bytes bigint, request_id uuid, analysis_id uuid, exclusion_reason text, unlinked_reason text, metadata jsonb not null, metadata_raw bytea,
 primary key(dataset,artifact_key)
);
create table garmin.input_inventory (
 dataset text not null references garmin.datasets(dataset), batch text not null references garmin.import_batches(id),
 category text not null, state text not null check (state in ('unknown','absent','empty','present')), metadata jsonb, metadata_raw bytea,
 check (metadata_raw is null or metadata is not null),
 primary key(dataset,category)
);
create table garmin.artifact_relations (
 dataset text not null references garmin.datasets(dataset), artifact_key text not null, analysis_key text not null, role text not null,
 request_id uuid, analysis_id uuid, reason text,
 primary key(dataset,artifact_key,analysis_key,role)
);
