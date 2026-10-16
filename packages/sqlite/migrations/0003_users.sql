-- Who this brain belongs to, and the foreign key that says so.
--
-- `sessions.user_id` has been `text not null` with nothing behind it since
-- 0001: the column said a session has an owner and no row anywhere said who
-- that was. This migration adds the table, points the column at it, and leaves
-- the question of *filling* it to the installer -- SQL cannot read an operating
-- system user name and cannot mint a UUIDv7, so a migration that seeded the row
-- would have to invent both (AD-12).
--
-- Same schema as `packages/postgres/migrations/` will grow, column for column:
-- Postgres is a replica of this and two schemas that drift are two schemas
-- (AD-22). `users` and this foreign key are the first thing epic 7 replicates.

-- One row per person. In slice 1 there is exactly one and it is me.
--
-- `is_self` is an integer with a 0/1 check, because SQLite has no boolean, and
-- the partial unique index below is what makes "at most one owner" a property
-- of the database rather than a rule the code remembers: a second `is_self = 1`
-- row is refused at the door. It is partial on purpose -- a plain `unique` on
-- the column would also allow only one non-owner, and epic 5's import brings
-- other people's rows in.
--
-- `name` is the operating system user name the installer found. Nothing here
-- updates it: a database carried to another machine keeps the name it was made
-- with, and deciding what to do about that is epic 5's (Boundaries).
create table users (
  id text primary key,
  name text not null,
  is_self integer not null,
  created_at text not null,
  constraint users_is_self_check check (is_self in (0, 1)),
  constraint users_created_at_check
    check (created_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

create unique index users_self_idx on users (is_self) where is_self = 1;

-- `sessions` gains `user_id text not null references users (id)`, and SQLite
-- cannot add a foreign key to a column that is already there: `alter table ...
-- add column` can carry one, `alter table` on an existing column cannot. So the
-- table is stashed, dropped and rebuilt, exactly the way 0002 rebuilt
-- `index_configs`, and all of it inside the one transaction the migration
-- runner already holds (`BEGIN IMMEDIATE` in `withWrite`) -- a reader never
-- sees a database without `sessions`.
--
-- `pragma defer_foreign_keys` is what makes that legal: seven tables point at
-- `sessions (id)` -- `messages`, `tool_notes`, `log_entries`, `chunks`,
-- `context_injections`, `failures`, and `sessions` itself through
-- `continued_from_session_id` -- and with foreign keys enforced immediately the
-- `drop` would be refused on the spot. Deferred, the check happens at commit,
-- by which time the rows are back under the same ids. The pragma lasts for this
-- transaction only and resets itself at commit; it is not `foreign_keys = OFF`,
-- which would skip the check altogether rather than postpone it.
--
-- It is a drop and not an `alter table ... rename`: with `legacy_alter_table`
-- off -- the default, and what `node:sqlite` gives us -- a rename rewrites the
-- foreign key clauses of every table that referred to the old name, so
-- `messages` would come out of it pointing at `sessions_old`. Dropping leaves
-- those clauses spelling `sessions`, and the new table takes that name.
--
-- In practice the stash is empty every time this runs: `SessionStore` arrives
-- in the same story as this migration, so no build before it could write a
-- session. The copy is here because a schema step that only works on an empty
-- table is a step nobody can trust on the one database that turns out not to
-- be.
pragma defer_foreign_keys = ON;

create temp table sessions_stash as select * from sessions;

drop table sessions;

-- Any user id a stashed session already names needs a row to point at, or the
-- new foreign key refuses the data this migration is meant to preserve. It
-- cannot happen on a database any released build wrote -- there are no
-- sessions before this story -- but a migration that would strand a row rather
-- than carry it is one nobody can run on the database that turns out to have
-- one.
--
-- `is_self = 0`: nobody here is the owner. Only the install step decides that
-- (AD-12), and it runs right after this one. The name is the id, because that
-- is the only thing the old row ever said about the person, and `created_at`
-- is the epoch, because the row records a reference and not an event.
insert into users (id, name, is_self, created_at)
     select distinct user_id, user_id, 0, '1970-01-01T00:00:00.000Z'
       from sessions_stash
      where user_id not in (select id from users);

-- The same table as 0001's, with one change: `user_id` now references
-- `users (id)`. Every other column, check and key is untouched, down to the
-- order they are written in, so the two can be read side by side.
create table sessions (
  id text primary key,
  harness text not null,
  harness_session_id text not null,
  user_id text not null references users (id),
  machine text not null,
  started_at text not null,
  workspace_id text references workspaces (id),
  project_id text references projects (id),
  worktree_id text references worktrees (id),
  ingest_source text not null,
  ended_at text,
  last_harness_message_id text,
  cursor_fingerprint text,
  parser_version text,
  ingested_at text,
  start_source text,
  continued_from_session_id text references sessions (id),
  unique (harness, harness_session_id),
  constraint sessions_ingest_source_check
    check (ingest_source in ('live', 'import')),
  constraint sessions_start_source_check
    check (start_source is null
           or start_source in ('startup', 'resume', 'clear', 'compact', 'fork')),
  constraint sessions_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null)),
  constraint sessions_started_at_check
    check (started_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint sessions_ended_at_check
    check (ended_at is null
           or ended_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint sessions_ingested_at_check
    check (ingested_at is null
           or ingested_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

insert into sessions (id, harness, harness_session_id, user_id, machine, started_at,
                      workspace_id, project_id, worktree_id, ingest_source, ended_at,
                      last_harness_message_id, cursor_fingerprint, parser_version,
                      ingested_at, start_source, continued_from_session_id)
     select id, harness, harness_session_id, user_id, machine, started_at,
            workspace_id, project_id, worktree_id, ingest_source, ended_at,
            last_harness_message_id, cursor_fingerprint, parser_version,
            ingested_at, start_source, continued_from_session_id
       from sessions_stash;

drop table sessions_stash;
