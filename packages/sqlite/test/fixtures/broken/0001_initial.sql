-- The same good first file, so the broken run has something to roll back from.

create table schema_version (
  id integer primary key check (id = 1),
  version integer not null,
  applied_at text not null
);

create table notes (
  id text primary key,
  body text not null
);
