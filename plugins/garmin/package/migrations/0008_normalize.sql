-- 항목별 불변 발행 이력과 마지막 chunk 완료 상태.
create table garmin.normalize_items (
 dataset text not null references garmin.datasets(dataset), scope text not null check (scope in ('day','activity')),
 key text not null, endpoint text not null, revision text not null, normalization_version integer not null,
 fetched_at_ms bigint not null, ok boolean not null, error_code text, normalized_at_ms bigint not null,
 primary key(dataset,scope,key,endpoint,revision,normalization_version),
 check ((ok and error_code is null) or (not ok and error_code is not null))
);
create table garmin.normalize_days (
 dataset text not null references garmin.datasets(dataset), day date not null, revision text not null,
 normalization_version integer not null, fetched_at_ms bigint not null, ok boolean not null, error_code text,
 normalized_at_ms bigint not null, primary key(dataset,day,revision,normalization_version),
 check ((ok and error_code is null) or (not ok and error_code is not null))
);
create table garmin.authority_v2 (
 account_identity text primary key, rule_id uuid not null, datasets text[] not null
);
grant select, insert, update on garmin.normalize_items, garmin.normalize_days, garmin.authority_v2 to brain_ext_garmin;
