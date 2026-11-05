-- Preserve every received response while keeping the SQLite-visible current row.
-- Existing imported raw_response rows remain immutable and require no backfill.
create table garmin.raw_observations (
 id bigint generated always as identity primary key,
 user_id uuid not null, connection_id uuid not null,
 scope text not null check (scope in ('day','activity')),
 key text not null, endpoint text not null, raw text not null,
 observed_at bigint not null, library_version text not null,
 foreign key (user_id,connection_id) references garmin.account_connections(user_id,connection_id)
);
create trigger raw_observations_immutable before update or delete on garmin.raw_observations
 for each row execute function garmin.reject_native_mutation();

create table garmin.raw_current_state (
 user_id uuid not null, connection_id uuid not null,
 scope text not null check (scope in ('day','activity')),
 key text not null, endpoint text not null, raw text not null,
 fetched_at bigint not null, checked_at bigint not null, library_version text not null,
 primary key (user_id,connection_id,scope,key,endpoint),
 foreign key (user_id,connection_id) references garmin.account_connections(user_id,connection_id)
);

create view garmin.raw_current as
 select user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version
 from garmin.raw_current_state
 union all
 select r.user_id,r.connection_id,r.scope,r.key,r.endpoint,r.raw,r.fetched_at,r.checked_at,r.library_version
 from garmin.raw_response r
 where not exists (select 1 from garmin.raw_current_state s
  where s.user_id=r.user_id and s.connection_id=r.connection_id and s.scope=r.scope and s.key=r.key and s.endpoint=r.endpoint);
