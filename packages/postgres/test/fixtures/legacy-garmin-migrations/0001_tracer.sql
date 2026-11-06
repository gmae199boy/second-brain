create table garmin.datasets (dataset text primary key, account text, account_confirmed boolean not null default false, check (not account_confirmed or account is not null));
create table garmin.import_batches (id text primary key, dataset text not null references garmin.datasets(dataset), imported_at timestamptz not null);
create table garmin.raw_payloads (dataset text not null references garmin.datasets(dataset), batch text not null references garmin.import_batches(id), account text, scope text not null, original_key text not null, endpoint text not null, fetched_at_ms bigint not null, checked_at_ms bigint not null, library_version text not null, body text not null, primary key(dataset, scope, original_key, endpoint), unique nulls not distinct (account, scope, original_key, endpoint));
create view garmin.raw_records as select 'garmin'::text as source, account, scope || '/' || original_key as key, endpoint, to_timestamp(fetched_at_ms / 1000.0) as fetched_at, to_timestamp(checked_at_ms / 1000.0) as checked_at, body from garmin.raw_payloads;
create table garmin.import_mapping (dataset text not null references garmin.datasets(dataset), original_table text not null, original_key text not null, target_kind text not null, target_id uuid not null, content_hash text not null, batch text not null references garmin.import_batches(id), primary key(dataset, original_table, original_key, target_kind));
revoke all on schema garmin from public;
grant usage on schema garmin to brain_app;
grant select on garmin.raw_records to brain_app;
