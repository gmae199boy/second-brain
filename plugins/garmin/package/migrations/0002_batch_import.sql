alter table garmin.raw_payloads drop constraint raw_payloads_account_scope_original_key_endpoint_key;
create table garmin.source_schemas (dataset text not null references garmin.datasets, original_table text not null, schema_version integer not null, columns_json jsonb not null, keys_json jsonb not null, primary key(dataset, original_table));
create table garmin.preserved_rows (id uuid primary key, dataset text not null references garmin.datasets, original_table text not null, original_key text not null, values_json jsonb not null, run_id uuid references garmin.preserved_rows(id), unique(dataset, original_table, original_key));
create table garmin.import_checkpoints (batch text not null references garmin.import_batches, dataset text not null references garmin.datasets, source_hash text not null, schema_version integer not null, importer_version integer not null, original_table text, original_key text, primary key(batch, dataset));
create table garmin.import_conflicts (id uuid primary key, dataset text not null, batch text not null, original_table text, original_key text, reason text not null, recorded_at timestamptz not null);
alter table garmin.import_checkpoints add column manifest_fingerprint text not null, add column source_role text not null, add column conversation_id uuid;
create table garmin.import_provenance (dataset text not null, original_table text not null, original_key text not null, metric text not null, reason text not null, primary key(dataset,original_table,original_key,metric));
create table garmin.authority_provenance (account text primary key, datasets text[] not null, rule_id uuid not null, revision integer not null);
create function garmin.attempt_valid(work_id uuid, token uuid) returns boolean language sql security definer set search_path='' as $$
 select session_user='brain_ext_garmin' and brain.attempt_is_current(work_id,token) and exists (
  select 1 from brain.work_items w join brain.extension_work_kinds k on k.kind=w.kind where w.id=work_id and k.extension_name='garmin'
 )
$$;
revoke all on function garmin.attempt_valid(uuid,uuid) from public;
create table garmin.legacy_conversations (dataset text not null, original_table text not null, original_key text not null, conversation_id uuid not null, primary key(dataset,original_table,original_key));
