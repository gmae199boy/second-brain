create table garmin.collect_notices (
 id uuid primary key, source text not null, account text not null, timezone text not null,
 local_date date not null, event text not null check (event in ('auth_failed','rate_limited','blocked_403','normalize_failed','repeated_partial','error')),
 detail text not null, created_at timestamptz not null, work_id uuid not null, attempt_token uuid not null,
 unique(source,account,timezone,local_date,event)
);
grant select, insert on garmin.collect_notices to brain_ext_garmin;
