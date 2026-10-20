-- The fifth migration of the source of truth: the places four later stories
-- write into, and the one comparison key that decides whether two checkouts of
-- a repository are one project (AD-11, AD-12, AD-21, AD-24, Table Contract).
--
-- Like 0004, nothing here does anything on its own. The record of a masked tool
-- note target is written by `messages redact`, the call id by the parser, the
-- failed stage by the extraction store, and the comparison key is read by the
-- story that moves it into Core. This is the shape they write into.
--
-- It only adds, and it preserves every row -- with one exception the installer
-- has to ask about first. `projects.identity_key` is `unique`, and a database
-- that already holds `github.com/Owner/Repo` *and* `github.com/owner/repo` has
-- two rows that become one key, so this file would be refused on it. The
-- installer finds those groups before it starts, shows them, asks, and merges
-- them inside this same transaction (`findSqliteProjectKeyCollisions`,
-- `mergeSqliteProjectKeyCollisions`): the merge and this file either both take
-- effect or neither does.
--
-- `0001_initial.sql` through `0004_capture_columns.sql` are not touched and
-- never will be: migrations go forward only (Conventions), and a file that has
-- been applied on somebody's machine cannot be edited into a different schema.
--
-- The spelling rules are 0001's: every ordinary table is `STRICT`, ids are
-- `text` holding a UUIDv7 (AD-8), instants are `text` in the one canonical
-- 24-character spelling pinned by a `glob` check (AD-13), and a boolean is
-- `integer` with `check (x in (0, 1))`.
--
-- Three tables are stashed, dropped and rebuilt the way 0004 rebuilt its three:
-- `redactions` has to widen a `check` and gain a foreign key, `projects` has to
-- gain a `not null unique` column, and `failures` has to gain two `not null`
-- columns with no default. SQLite cannot alter a column, a `check` or a key, so
-- each of the three goes through a temp stash -- all of it inside the one
-- transaction the migration runner already holds (`BEGIN IMMEDIATE` in
-- `withWrite`), so a reader never sees a database without them.
--
-- `pragma defer_foreign_keys` is what makes the `projects` rebuild legal:
-- `worktrees`, `sessions` and `log_entries` all point at `projects (id)`, and
-- with foreign keys enforced immediately the `drop` would be refused on the
-- spot. Deferred, the check happens at commit -- by which time the rows are
-- back under the same ids. The pragma lasts for this transaction only and
-- resets itself at commit; it is not `foreign_keys = OFF`, which would skip the
-- check altogether rather than postpone it.
--
-- It is a drop and not an `alter table ... rename`, for 0004's reason: with
-- `legacy_alter_table` off -- the default, and what `node:sqlite` gives us -- a
-- rename rewrites the foreign key clauses of every table that referred to the
-- old name, so `worktrees` would come out of it pointing at `projects_old`.
--
-- `tool_notes` is the one table that gains a column *without* a rebuild, for
-- the reason 0004 left `document_chunks` alone: it carries the
-- external-content FTS5 index `tool_notes_fts`, which finds its rows by
-- `search_rowid`, and a rebuild that renumbered one row would point the index
-- at another. A nullable column and a replaced immutability trigger give the
-- same observable result -- nullable, unique inside a session, immutable --
-- with nothing for the index to lose.
--
-- Postgres is a replica of this schema (AD-22) and is behind by 0004 already;
-- it catches up in epic 7, which is where these columns follow too.
pragma defer_foreign_keys = ON;

-- A masked span, of a message's body, of a file's content, *or* of a tool
-- note's target (AD-11, AD-23, Table Contract).
--
-- The third target is what `messages redact` needs: AD-11 has a masking cover
-- the tool notes of the message along with its body, and until now there was no
-- column for the row that records one. Capture does not write it -- a stored
-- target is the original the transcript carried, and the masking of an *output*
-- leaves no record because it changes nothing on disk (story 2.17) -- so the
-- one writer is the redaction verb.
--
-- Two things change and neither can be done by `alter table`: the target
-- `check` has to count three columns instead of two, and `tool_note_id` arrives
-- with a foreign key. So the table is stashed, dropped and rebuilt the way
-- 0004 rebuilt it. Nothing refers to `redactions`, so the rebuild needs no
-- deferral of its own.
--
-- Exactly one target, as a sum rather than 0004's `<>`: with three columns
-- there is no pair to compare, and `(a) + (b) + (c) = 1` says the same thing
-- for any number of them. `is not null` is 0 or 1 in SQLite, so the sum is the
-- count of targets.
--
-- The range follows the target. A file redaction has none -- the whole content
-- goes, and `[start, end)` over bytes nobody keeps would mean nothing -- while
-- a message redaction keeps 0001's half-open code point interval over the body
-- and a tool note redaction carries the same interval over its `target`. One
-- rule for both of the two that have a range, because they are the same kind of
-- span over a different column.
--
-- The foreign key is to `tool_notes (id)` and not to `search_rowid`: the row's
-- name is its UUIDv7, and `search_rowid` is this adapter's own anchor for the
-- FTS index, which an export does not carry.
create temp table redactions_stash as select * from redactions;

drop table redactions;

create table redactions (
  id text primary key,
  message_id text references messages (id),
  file_id text references files (id),
  start integer,
  "end" integer,
  kind text not null,
  content_hash text not null,
  occurred_at text not null,
  pattern_version text,
  tool_note_id text references tool_notes (id),
  constraint redactions_target_check
    check ((message_id is not null) + (file_id is not null) + (tool_note_id is not null) = 1),
  constraint redactions_range_check
    check (case
             when file_id is not null
               then start is null and "end" is null
             else start is not null and "end" is not null
                  and start >= 0 and start < "end"
           end),
  constraint redactions_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Every stashed row targets a message or a file, because a tool note had
-- nowhere to be recorded until now: `tool_note_id` is null and everything else
-- is carried over exactly as it stood.
insert into redactions (id, message_id, file_id, start, "end", kind, content_hash,
                        occurred_at, pattern_version, tool_note_id)
     select id, message_id, file_id, start, "end", kind, content_hash,
            occurred_at, pattern_version, null
       from redactions_stash;

drop table redactions_stash;

-- The two triggers went with the dropped table and come back word for word,
-- message included: what they say is still true, and a caller that matched on
-- the sentence is matching on the rule and not on this migration.
--
-- `redactions` is immutable, and unlike `messages` and `tool_notes` it has no
-- way out at all (AD-11, Table Contract). The raised redact marker is what lets
-- a masking *write* this table; it is not a licence to edit what an earlier one
-- wrote, so these two refuse without looking at it. A record of a removal that
-- could itself be removed would be no record.
create trigger redactions_immutable_update
  before update on redactions
begin
  select raise(abort, 'redactions is immutable: update is refused');
end;

create trigger redactions_immutable_delete
  before delete on redactions
begin
  select raise(abort, 'redactions is immutable: delete is refused');
end;

-- `failed_stage` is required from here on, and only from here on (AD-24).
--
-- 0004 added the column nullable and said why: the rows already in the table
-- failed before anything recorded a stage, and inventing one for them would be
-- a guess stored as a fact. A `not null` constraint cannot say "the old rows
-- may have none", so a pair of triggers does -- the same instrument 0004 used
-- for `document_chunks.chunk_locator`.
--
-- The insert rule is the whole of it: a reading that is being stored as failed
-- names the step it stopped at. The update rule has to be narrower, because an
-- old row that was already `failed` with no stage must stay editable -- its
-- `error` is still a column somebody may rewrite, and a trigger that refused
-- that would make those rows unusable. So the update is refused only when this
-- write is the one that creates the gap: the row is becoming failed now
-- (`old.status is not 'failed'`), or it already had a stage and this write is
-- taking it away (`old.failed_stage is not null`).
--
-- `is` and `is not`, never `=`: a comparison against a null column is null, and
-- a `when` that is null does not fire, which would let the very row these exist
-- for through unchecked.
create trigger document_extractions_failed_stage_insert
  before insert on document_extractions
  when new.status = 'failed' and new.failed_stage is null
begin
  select raise(abort,
    'document_extractions.failed_stage is required when status becomes failed');
end;

create trigger document_extractions_failed_stage_update
  before update on document_extractions
  when new.status = 'failed' and new.failed_stage is null
       and (old.status is not 'failed' or old.failed_stage is not null)
begin
  select raise(abort,
    'document_extractions.failed_stage is required when status becomes failed');
end;

-- The one key that decides whether two checkouts are one repository (AD-12).
--
-- `remote_identity` is the normalized remote as the capture path produced it,
-- and it stays exactly that: the value a person recognises, spelled the way
-- their remote spells it. What it cannot do is answer "is this the same
-- repository": GitHub and Bitbucket treat an owner and a repository name as
-- case-insensitive, so one clone saying `github.com/Owner/Repo` and another
-- saying `github.com/owner/repo` are the same repository under two
-- `remote_identity` values -- and two projects, with the sessions of one
-- checkout invisible from the other.
--
-- So the comparison key is its own column, `not null unique`, and
-- `remote_identity not null unique` stays beside it. The key is folded only for
-- the hosts that are known to compare that way; every other host, and every
-- local path, keeps its value byte for byte, because a host that is
-- case-sensitive would have two repositories folded into one -- which is the
-- worse mistake of the two and cannot be undone.
--
-- `lower()` in SQLite folds ASCII and nothing else, which is enough here:
-- GitHub and Bitbucket owner and repository names are ASCII.
--
-- The same expression is spelled in `project-keys.ts`, because a migration file
-- cannot import a constant. That the two agree is held by a test, not by
-- hope: the groups the finder shows are exactly the groups this `unique`
-- refuses.
--
-- The rebuild is deferred-foreign-key work: `worktrees`, `sessions` and
-- `log_entries` all point here (see the header).
create temp table projects_stash as select * from projects;

drop table projects;

create table projects (
  id text primary key,
  remote_identity text not null unique,
  workspace_id text references workspaces (id),
  identity_key text not null unique
) strict;

insert into projects (id, remote_identity, workspace_id, identity_key)
     select id, remote_identity, workspace_id,
            case
              when lower(remote_identity) glob 'github.com/*'
                or lower(remote_identity) glob 'bitbucket.org/*'
                then lower(remote_identity)
              else remote_identity
            end
       from projects_stash;

drop table projects_stash;

-- When a cause was first met and how often it has been met since (AD-21, Table
-- Contract, Decision 2 of 2026-10-19).
--
-- 0004's row says when the cause was *last* met: the same key met again keeps
-- its id, is opened again, and takes the latest instant and sentence. That is
-- the question a person asks first, and it costs the other one -- a row that
-- has been failing every ten minutes for a week looks exactly like one that
-- failed once a moment ago.
--
-- Neither column has a default, on purpose: a default would let a writer that
-- has not been taught the rule put a row in that quietly says "first met now,
-- once", and the two columns exist to be true. `recordFailure` fills them --
-- `first_occurred_at = occurred_at` and `occurrences = 1` on the insert, and on
-- the conflict it raises the count and leaves the first instant alone.
--
-- The rows already here have been met once as far as anything knows, and the
-- only instant they carry is the one they were recorded with, so that is what
-- they get. It is not a guess: for a row written before this file, "first" and
-- "last" are the same occurrence.
create temp table failures_stash as select * from failures;

drop table failures;

create table failures (
  id text primary key,
  target_kind text not null,
  target_id text not null,
  stage text not null,
  fingerprint text not null,
  harness text,
  session_id text references sessions (id),
  code text not null,
  message text not null,
  occurred_at text not null,
  resolved_at text,
  first_occurred_at text not null,
  occurrences integer not null,
  unique (target_kind, target_id, stage, fingerprint),
  constraint failures_occurrences_check check (occurrences >= 1),
  constraint failures_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint failures_resolved_at_check
    check (resolved_at is null
           or resolved_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint failures_first_occurred_at_check
    check (first_occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

insert into failures (id, target_kind, target_id, stage, fingerprint, harness,
                      session_id, code, message, occurred_at, resolved_at,
                      first_occurred_at, occurrences)
     select id, target_kind, target_id, stage, fingerprint, harness,
            session_id, code, message, occurred_at, resolved_at,
            occurred_at, 1
       from failures_stash;

drop table failures_stash;

-- Which tool call a note is about, as the harness named it (story 23, parser
-- v4).
--
-- 0001 keys a note on `(session_id, harness_message_id, ordinal)`, which is
-- where it sat in the transcript and not what it was. Two reads of the same
-- transcript can put the same call at a different ordinal -- a line the parser
-- skipped the first time shifts every note after it -- and a note that moved is
-- a note stored twice. The call id is the harness's own name for the call, so a
-- re-read lands on the row it wrote before.
--
-- It is nullable because the notes already stored have no call id to give, and
-- because not every harness line carries one. The unique index is therefore
-- partial: one row per call inside a session, and the rows with no id are not
-- compared at all. Per session and not globally, for the reason the rest of the
-- keys are: a call id is unique to the harness run that minted it, and two
-- harnesses are free to spell one the same way.
alter table tool_notes add column call_id text;

create unique index tool_notes_call_id_idx
  on tool_notes (session_id, call_id) where call_id is not null;

-- 0001's immutability trigger lists every column that may not move, so a column
-- it does not list is a column a redaction could rewrite. It cannot be altered,
-- only replaced -- and the message is deliberately the same one, down to the
-- wording, for the reason 0004 kept `messages`'s: what it says is still true,
-- and a caller that matched on it is matching on the rule.
drop trigger tool_notes_immutable_update;

create trigger tool_notes_immutable_update
  before update on tool_notes
  when not (brain_redact_allowed() = 1
            and new.search_rowid is old.search_rowid
            and new.id is old.id
            and new.session_id is old.session_id
            and new.harness_message_id is old.harness_message_id
            and new.ordinal is old.ordinal
            and new.tool is old.tool
            and new.ok is old.ok
            and new.call_id is old.call_id)
begin
  select raise(abort,
    'tool_notes is immutable: an update is refused unless a redaction is in progress and changes target alone');
end;
