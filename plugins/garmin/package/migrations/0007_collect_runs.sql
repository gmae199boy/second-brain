-- 수집 기록은 새 수집 dataset에만 쓴다. 시각은 UTC epoch milliseconds다.
create table garmin.collect_runs (
 dataset text not null references garmin.datasets(dataset),
 run_id uuid not null, work_id uuid not null, attempt_token uuid not null,
 local_date date not null, started_at bigint not null, finished_at bigint,
 status text not null check (status in ('running','success','partial','rate_limited','blocked_403','auth_failed','error','skipped_blocked')),
 detail text not null default '', primary key(dataset,run_id)
);
create index collect_runs_date on garmin.collect_runs(dataset,local_date,started_at);
create table garmin.collect_fetch_errors (
 id uuid primary key, dataset text not null, run_id uuid not null,
 scope text not null check (scope in ('day','activity')), original_key text not null,
 endpoint text not null, kind text not null check (kind in ('transient','rejected')),
 local_date date not null, occurred_at bigint not null, error_code text not null,
 foreign key (dataset,run_id) references garmin.collect_runs(dataset,run_id)
);
create index collect_fetch_errors_item on garmin.collect_fetch_errors(dataset,scope,original_key,endpoint);
create table garmin.collect_meta (
 dataset text not null references garmin.datasets(dataset), key text not null, value text not null,
 primary key(dataset,key)
);
create table garmin.collect_targets (
 target_kind text not null, target_id text not null, account text not null,
 dataset text not null references garmin.datasets(dataset), primary key(target_kind,target_id)
);
create table garmin.collect_published (
 dataset text not null references garmin.datasets(dataset), day date not null, revision text not null,
 primary key(dataset,day,revision)
);

insert into garmin.collect_published(dataset,day,revision)
 select dataset,day,revision from garmin.collect_state on conflict do nothing;
