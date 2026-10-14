-- A stand-in for the real first migration, which arrives with story 11. It
-- holds what the runner itself needs — the single `schema_version` row — plus
-- one table, so a run that half applied would be visible.

create table schema_version (
  id integer primary key check (id = 1),
  version integer not null,
  applied_at text not null
);

create table notes (
  id text primary key,
  body text not null
);
