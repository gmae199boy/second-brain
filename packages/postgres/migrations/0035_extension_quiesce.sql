-- Installation fencing is independent of user holds and survives installer death.
create table brain.extension_quiesce (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,30}$' and name !~ '^(core|brain|public|pg_)'),
  owner text not null check (owner ~ '^[a-f0-9-]{36}$'),
  started_at timestamptz not null
);
revoke all on brain.extension_quiesce from public;
grant select, insert, delete on brain.extension_quiesce to brain_app;
