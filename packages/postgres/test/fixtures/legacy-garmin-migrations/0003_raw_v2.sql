-- v1의 표시 키는 서로 다른 원형을 합칠 수 있으므로 v2 원형 identity를 별도로 둔다.
alter table garmin.datasets add column account_raw bytea, add column account_encoding text,
 add constraint datasets_account_pair check ((account_raw is null) = (account_encoding is null) and (account_raw is null or account is not null) and (account_encoding is null or account_encoding in ('utf-8','utf-16le','utf-16be')));
alter table garmin.datasets add column dataset_label text, add column dataset_label_raw bytea, add column dataset_label_encoding text;
alter table garmin.authority_provenance drop constraint authority_provenance_pkey;
alter table garmin.authority_provenance add column account_identity text;
create unique index authority_provenance_v1 on garmin.authority_provenance(account) where account_identity is null;
create unique index authority_provenance_v2 on garmin.authority_provenance(account_identity) where account_identity is not null;
alter table garmin.raw_payloads drop constraint raw_payloads_pkey;
alter table garmin.raw_payloads add column raw_identity text,
 add column account_raw bytea, add column account_encoding text,
 add column scope_raw bytea, add column scope_encoding text,
 add column original_key_raw bytea, add column original_key_encoding text,
 add column endpoint_raw bytea, add column endpoint_encoding text,
 add column library_version_raw bytea, add column library_version_encoding text,
 add column body_raw bytea, add column body_encoding text;
alter table garmin.raw_payloads add constraint raw_payloads_account_pair check ((account_raw is null) = (account_encoding is null) and (account_raw is null or account is not null) and (account_encoding is null or account_encoding in ('utf-8','utf-16le','utf-16be'))),
 add constraint raw_payloads_scope_pair check ((scope_raw is null) = (scope_encoding is null) and (scope_raw is null or scope is not null) and (scope_encoding is null or scope_encoding in ('utf-8','utf-16le','utf-16be'))),
 add constraint raw_payloads_original_key_pair check ((original_key_raw is null) = (original_key_encoding is null) and (original_key_raw is null or original_key is not null) and (original_key_encoding is null or original_key_encoding in ('utf-8','utf-16le','utf-16be'))),
 add constraint raw_payloads_endpoint_pair check ((endpoint_raw is null) = (endpoint_encoding is null) and (endpoint_raw is null or endpoint is not null) and (endpoint_encoding is null or endpoint_encoding in ('utf-8','utf-16le','utf-16be'))),
 add constraint raw_payloads_library_version_pair check ((library_version_raw is null) = (library_version_encoding is null) and (library_version_raw is null or library_version is not null) and (library_version_encoding is null or library_version_encoding in ('utf-8','utf-16le','utf-16be'))),
 add constraint raw_payloads_body_pair check ((body_raw is null) = (body_encoding is null) and (body_raw is null or body is not null) and (body_encoding is null or body_encoding in ('utf-8','utf-16le','utf-16be')));
create unique index raw_payloads_v1_identity on garmin.raw_payloads(dataset,scope,original_key,endpoint) where raw_identity is null;
create unique index raw_payloads_v2_identity on garmin.raw_payloads(dataset,raw_identity) where raw_identity is not null;
-- v1에는 원형을 표현할 수 없는 행을 정확한 TEXT로 가장하지 않는다.
create or replace view garmin.raw_records as
 select 'garmin'::text as source, account, scope || '/' || original_key as key, endpoint,
 to_timestamp(fetched_at_ms / 1000.0) as fetched_at, to_timestamp(checked_at_ms / 1000.0) as checked_at, body
 from garmin.raw_payloads where account_raw is null and scope_raw is null and original_key_raw is null
 and endpoint_raw is null and body_raw is null;
create view garmin.raw_records_v2 as
 select 'garmin'::text as source, coalesce(d.dataset_label,r.dataset) as dataset, d.dataset_label_raw as dataset_raw, d.dataset_label_encoding as dataset_encoding, r.account, r.account_raw, r.account_encoding,
 scope, scope_raw, scope_encoding, original_key, original_key_raw, original_key_encoding,
 endpoint, endpoint_raw, endpoint_encoding, to_timestamp(fetched_at_ms / 1000.0) as fetched_at,
 to_timestamp(checked_at_ms / 1000.0) as checked_at, body, body_raw, body_encoding
 from garmin.raw_payloads r join garmin.datasets d on d.dataset=r.dataset;
grant select on garmin.raw_records_v2 to brain_app;
