create table brain.extensions (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,30}$' and name !~ '^(core|brain|public|pg_)'),
  version text not null,
  installed_at timestamptz not null,
  enabled boolean not null,
  enabled_changed_at timestamptz not null,
  connection_status text check (connection_status in ('connected', 'failed')),
  connection_checked_at timestamptz,
  connection_code text,
  connection_message text,
  check ((connection_status is null) = (connection_checked_at is null))
);
