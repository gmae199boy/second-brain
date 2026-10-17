-- The fourth migration of the source of truth: the columns and keys that
-- capture, pre-store masking, the parser and drain write into, together with
-- the three tables whose shape has to change for them (AD-11, AD-15, AD-21,
-- AD-23, AD-24, Table Contract).
--
-- Nothing here does anything on its own. Masking, the parser, the failure
-- record, claiming and the extraction store are behaviour, and behaviour
-- arrives with the stories that use these columns (epic 2's 2.7, 2.9 and 2.11,
-- and epic-attachments for the file side). This is the shape they write into,
-- which is why Core's domain types are not touched here: the type grows in the
-- story that reads the column.
--
-- It only adds, and it preserves every row. `0001_initial.sql` through
-- `0003_users.sql` are not touched and never will be: migrations go forward
-- only (Conventions), and a file that has been applied on somebody's machine
-- cannot be edited into a different schema.
--
-- The spelling rules are 0001's, and for the same reasons: every ordinary table
-- is `STRICT`, ids are `text` holding a UUIDv7 (AD-8), instants are `text` in
-- the one canonical 24-character spelling pinned by a `glob` check (AD-13), and
-- a boolean is `integer` with `check (x in (0, 1))`.
--
-- Three tables cannot be changed by `alter table`: `redactions` has to make
-- `message_id` nullable and gain a foreign key, `document_extractions` has to
-- gain a column inside its unique key, and `failures` has to swap the two
-- columns its key is made of. SQLite cannot alter a column, a `check` or a key,
-- so each of the three is stashed, dropped and rebuilt the way 0002 rebuilt
-- `index_configs` and 0003 rebuilt `sessions` -- all of it inside the one
-- transaction the migration runner already holds (`BEGIN IMMEDIATE` in
-- `withWrite`), so a reader never sees a database without them.
--
-- `pragma defer_foreign_keys` is what makes that legal: `files` and
-- `document_chunks` both point at `document_extractions (id)`, and with foreign
-- keys enforced immediately the `drop` would be refused on the spot. Deferred,
-- the check happens at commit -- by which time the rows are back under the same
-- ids. The pragma lasts for this transaction only and resets itself at commit;
-- it is not `foreign_keys = OFF`, which would skip the check altogether rather
-- than postpone it.
--
-- It is a drop and not an `alter table ... rename`: with `legacy_alter_table`
-- off -- the default, and what `node:sqlite` gives us -- a rename rewrites the
-- foreign key clauses of every table that referred to the old name, so
-- `document_chunks` would come out of it pointing at
-- `document_extractions_old`. Dropping leaves those clauses spelling the real
-- name, and the new table takes it. The triggers on `files` that name
-- `document_extractions` in their bodies survive the drop untouched: SQLite
-- resolves a trigger body by name when it runs, not when it is created.
--
-- Postgres is a replica of this schema (AD-22) and is behind by the file tables
-- already; it catches up in epic 7, which is where these columns follow too.
pragma defer_foreign_keys = ON;

-- Two facts the parser can read off a transcript line and nothing could store
-- until now (AD-4, spine: "the branch is tracking information on the message,
-- not a label").
--
-- `git_branch` is the value exactly as the line carried it, with no
-- normalisation: a branch that was renamed later was still that branch when the
-- message was written. It is nullable because most lines do not carry one.
--
-- `is_subagent_report` marks the final report of a subagent -- the one message
-- of a sidechain that is worth recalling as a result rather than as a step. It
-- is the smallest promise that can be kept now: *where* that report is read
-- from is a question about one harness's transcript format, and the story that
-- reads it settles that against a fixture. `default 0` is what lets it be `not
-- null` on a table that already has rows, and it is the right default: a
-- message nobody has looked at is not a report.
alter table messages add column git_branch text;
alter table messages add column is_subagent_report integer not null default 0
  constraint messages_is_subagent_report_check check (is_subagent_report in (0, 1));

-- The immutability trigger of 0001 lists every column that may not move, so a
-- column it does not list is a column a redaction could rewrite. It cannot be
-- altered, only replaced -- and the message is deliberately the same one, down
-- to the wording: what it says is still true, and a caller that matched on it
-- is matching on the rule and not on this migration.
drop trigger messages_immutable_update;

create trigger messages_immutable_update
  before update on messages
  when not (brain_redact_allowed() = 1
            and new.id is old.id
            and new.session_id is old.session_id
            and new.harness_message_id is old.harness_message_id
            and new.seq is old.seq
            and new.role is old.role
            and new.model is old.model
            and new.occurred_at is old.occurred_at
            and new.git_branch is old.git_branch
            and new.is_subagent_report is old.is_subagent_report)
begin
  select raise(abort,
    'messages is immutable: an update is refused unless a redaction is in progress and changes body alone');
end;

-- A file whose bytes cannot be reached any more: the database came back from a
-- restore without them, or the integration that held them was disconnected
-- (AD-24). The chunks already extracted keep answering searches; what the mark
-- buys is that no re-extraction work is created for the file and results built
-- from it carry the `FILE_SOURCE_UNREACHABLE` warning.
--
-- `files_immutable_update` is left alone on purpose. It is written as a list of
-- the columns that may *not* move, so a column added here is free by
-- construction -- which is what AD-24 wants: this mark is set and cleared as
-- the bytes come and go, and it says nothing about the content.
alter table files add column source_unreachable_at text
  constraint files_source_unreachable_at_check
    check (source_unreachable_at is null
           or source_unreachable_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z');

-- Where a piece of a document came from, as the one truth (AD-24). `page` was
-- never enough: a text document has a character range, a recording has a time
-- range, a spreadsheet has rows, and a PDF has a page *and* a region on it. The
-- locator is one JSON object per piece, `type` first, and the existing `page`
-- column stays as a read-only copy of `$.page` for indexing and ordering.
--
-- It is added as a nullable column rather than by rebuilding the table, for two
-- reasons. `document_chunks` carries the external-content FTS5 index
-- `document_chunks_fts`, which finds its rows by `search_rowid`; a rebuild that
-- renumbered one row would point the index at another. And the rows already
-- there have no locator that is true -- they were written before anything
-- recorded one -- so the alternative was inventing a position for text somebody
-- may later be shown. A null says "unknown", which is what it is.
--
-- The `check` is therefore `null or ...`, and the triggers below are what make
-- the column effectively `not null` from here on: a new row, or an update that
-- writes a null into it, is refused. Together they say "every locator written
-- from now on is a real one, and the old rows are left alone".
--
-- Canonical form, the same instrument `index_configs` uses in 0001: SQLite
-- compares JSON as text, so `{"type":"pdf","page":1}` and `{"page":1,"type":
-- "pdf"}` would be two different values of one fact. Rather than make the
-- spellings equal, only one spelling is allowed in -- `json(x) = x` is what
-- rules out stray whitespace, and Core's codec is what fixes the key order.
--
-- `page is (case ... end)` is the copy rule, compared with `is` and not `=` so
-- that null counts as a value: a PDF piece's `page` has to equal the locator's,
-- and any other kind of piece has to have none at all.
alter table document_chunks add column chunk_locator text
  constraint document_chunks_locator_check
    check (chunk_locator is null
           or (json_valid(chunk_locator)
               and json_type(chunk_locator) = 'object'
               and json(chunk_locator) = chunk_locator
               and json_extract(chunk_locator, '$.type')
                     in ('pdf', 'docx', 'text', 'time', 'sheet')
               and page is (case
                              when json_extract(chunk_locator, '$.type') = 'pdf'
                                then json_extract(chunk_locator, '$.page')
                            end)));

-- The column is nullable for the rows that came before it and for nothing else.
-- A `not null` constraint cannot say that, so a pair of triggers does: every
-- row written from here on carries a locator, and no update may take one away
-- (an update that leaves an old row's null where it was takes nothing away).
create trigger document_chunks_locator_insert
  before insert on document_chunks
  when new.chunk_locator is null
begin
  select raise(abort,
    'document_chunks.chunk_locator is required: only rows written before migration 0004 may have none');
end;

create trigger document_chunks_locator_update
  before update of chunk_locator on document_chunks
  when new.chunk_locator is null and old.chunk_locator is not null
begin
  select raise(abort,
    'document_chunks.chunk_locator is required: only rows written before migration 0004 may have none');
end;

-- A masked span, of a message *or* of a file's content (AD-11, AD-23).
--
-- Three things change, and none of them can be done by `alter table`:
-- `message_id` becomes nullable, `file_id` arrives with a foreign key, and the
-- range columns become nullable. So the table is stashed, dropped and rebuilt
-- (see the header). Nothing refers to `redactions`, so the rebuild needs no
-- deferral of its own -- it follows the same pattern as 0002's and 0003's
-- because a rebuild that is spelled differently is a rebuild that has to be
-- read differently.
--
-- `pattern_version` is which version of Core's secret-pattern list did the
-- masking (AD-11): the list is one thing with a version, and a record that
-- did not say which version made it could not be re-examined when the list
-- grows. It is nullable because a hand-made redaction has no pattern behind it,
-- and because the rows written before this migration have no version to name.
--
-- Exactly one target, as a `check`: a redaction masks a message's body or a
-- file's content and there is no third thing it could mask, so both set and
-- neither set are the same mistake. A file redaction has no range -- the whole
-- content goes, and `[start, end)` over bytes nobody keeps would mean nothing
-- -- while a message redaction keeps 0001's half-open code point interval over
-- the body as it stood just before the masking.
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
  constraint redactions_target_check
    check ((message_id is null) <> (file_id is null)),
  constraint redactions_range_check
    check (case
             when message_id is null
               then start is null and "end" is null
             else start is not null and "end" is not null
                  and start >= 0 and start < "end"
           end),
  constraint redactions_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Every stashed row was a message redaction, because a file redaction had
-- nowhere to be recorded until now: `file_id` is null, the range is carried
-- over as it stood, and `pattern_version` is null because the version that
-- masked it was never written down.
insert into redactions (id, message_id, file_id, start, "end", kind, content_hash,
                        occurred_at, pattern_version)
     select id, message_id, null, start, "end", kind, content_hash,
            occurred_at, null
       from redactions_stash;

drop table redactions_stash;

-- `redactions` is immutable, and unlike `messages` and `tool_notes` it has no
-- way out at all (AD-11, Table Contract). The raised redact marker is what lets
-- a masking *write* this table; it is not a licence to edit what an earlier one
-- wrote, so these two triggers refuse without looking at it. A record of a
-- removal that could itself be removed would be no record.
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

-- One reading of one file (AD-24), with the three things the extraction story
-- needs and 0002 could not give it.
--
-- `attempt` is a per-file counter the store assigns as `max + 1` inside the
-- insert transaction, and `(file_id, attempt)` is the key. It is what the
-- pointer guard is built on: `files.current_extraction_id` may only move to a
-- generation whose `attempt` is higher than the current one's, so an old
-- reading that finishes late cannot overwrite a newer one's text. 0002 keyed
-- the work in flight on `(file_id, extractor_version)` instead, which could not
-- say which of two readings was the later.
--
-- `failed_stage` is where a failed reading stopped -- reading the bytes,
-- extracting the text, cutting it into pieces, or indexing them -- so that a
-- failure can be retried from knowledge rather than from the beginning. It has
-- a value only on a failed reading, and it is not required even then: the rows
-- already here failed before anything recorded a stage, and inventing one for
-- them would be a guess stored as a fact. The store is what fills it going
-- forward.
--
-- `index_config_id` is which chunking generation cut these pieces, the same
-- question `chunks.index_config_id` answers for conversations. Nullable for the
-- same reason: 0002's rows were written before the column existed and naming
-- the document-chunk config of the day would be a guess.
create temp table document_extractions_stash as select * from document_extractions;

drop table document_extractions;

create table document_extractions (
  id text primary key,
  file_id text not null references files (id),
  extractor_version text not null,
  attempt integer not null,
  media_type text,
  status text,
  started_at text not null,
  finished_at text,
  error text,
  failed_stage text,
  index_config_id text references index_configs (id),
  unique (file_id, attempt),
  constraint document_extractions_attempt_check check (attempt >= 1),
  constraint document_extractions_status_check
    check (status is null
           or status in ('ok', 'failed', 'unsupported', 'too_large', 'redacted')),
  constraint document_extractions_finished_check
    check ((finished_at is null) = (status is null)),
  constraint document_extractions_failed_stage_check
    check (failed_stage is null
           or (status = 'failed'
               and failed_stage in ('read', 'extract', 'chunk', 'index'))),
  constraint document_extractions_started_at_check
    check (started_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint document_extractions_finished_at_check
    check (finished_at is null
           or finished_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- "One reading of a file at a time", as a partial index (AD-24, Table
-- Contract). It is per file now and not per extractor version: with `attempt`
-- ordering the generations, two readings of one file running at once is the
-- race the guard exists to stop, whatever versions they are. Finished
-- generations are history and may sit side by side, which is why it is partial.
--
-- 0002's `document_extractions_open_idx` went with the dropped table and is not
-- recreated: it keyed the same work on `(file_id, extractor_version)` and would
-- now be the weaker half of this one.
create unique index document_extractions_running_idx
  on document_extractions (file_id) where finished_at is null;

-- The stashed rows get the `attempt` they would have had, numbered per file in
-- the order they were started -- `id` breaking the tie, because a UUIDv7 sorts
-- by the moment it was minted and two readings can share a millisecond. The
-- counter starts at 1, so the next reading the store inserts is `max + 1` with
-- nothing to reconcile.
insert into document_extractions (id, file_id, extractor_version, attempt, media_type,
                                  status, started_at, finished_at, error,
                                  failed_stage, index_config_id)
     select id, file_id, extractor_version,
            row_number() over (partition by file_id order by started_at, id),
            media_type, status, started_at, finished_at, error, null, null
       from document_extractions_stash;

drop table document_extractions_stash;

-- Failures from every path, keyed on what failed and not on where it was seen
-- (AD-21, Table Contract). 0001 keyed them on the harness session, which meant
-- a failure about a file, a project or a transcript folder had no key at all --
-- the two columns it would have had to fill name a session it has nothing to do
-- with.
--
-- The target key is `work_items`'s, column for column, because they are the
-- same two halves of one question: which piece of work is this about. Neither
-- `target_kind` nor `stage` gets a `check` for the same reason `work_items`'s
-- does not -- they are Core constants that grow with every path that can fail,
-- and a `check` listing them would mean a migration for each new one.
--
-- `harness` and `session_id` stay as information, both nullable: a session
-- collection failure can be recorded before any session row exists (AD-12), and
-- a failure that is not about a session has neither to give.
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
  unique (target_kind, target_id, stage, fingerprint),
  constraint failures_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint failures_resolved_at_check
    check (resolved_at is null
           or resolved_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Every stashed row was about a harness session, so each becomes the session
-- target it already was: `target_kind = 'session'` and the session token
-- `harness:harness_session_id`, which is the one spelling a session has outside
-- this process (Conventions, AD-8) and exactly the key a session collection
-- failure is recorded under from here on. The two columns it was keyed on are
-- kept as well -- `harness` as information, and the token holds both -- so
-- nothing the row said is lost.
--
-- In practice the stash is empty: nothing writes `failures` yet, the record
-- function arrives later in this epic. The copy is here because a schema step
-- that only works on an empty table is a step nobody can trust on the one
-- database that turns out not to be.
insert into failures (id, target_kind, target_id, stage, fingerprint, harness,
                      session_id, code, message, occurred_at, resolved_at)
     select id, 'session', harness || ':' || harness_session_id, stage, fingerprint,
            harness, session_id, code, message, occurred_at, resolved_at
       from failures_stash;

drop table failures_stash;

-- What drain actually asks for (AD-21). 0002's index was on
-- `(next_attempt_at)`, which answers "is anything due" and leaves the ordering
-- to a temporary B-tree: the claim query takes the *least attempted* item
-- first, so that one poisonous row cannot starve the rest of the backlog.
--
-- The column order is the `order by` -- `(attempts, id)` -- so the index is
-- read in the order the answer wants, and `next_attempt_at` is the third column
-- so the due filter is answered from the index instead of a table lookup. The
-- partial condition is the query's own `completed_at is null`, which is what
-- lets the planner use a partial index at all.
--
-- The old index is dropped rather than kept beside it: left there, the planner
-- could pick it and sort afterwards, which is the plan this one exists to
-- avoid.
drop index work_items_due_idx;

create index work_items_due_idx
  on work_items (attempts, id, next_attempt_at) where completed_at is null;
