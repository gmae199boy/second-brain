-- The first migration of the source of truth (AD-10): every table of the Table
-- Contract except `embeddings`, the idempotency keys of AD-8, the keyword-search
-- indexes of AD-15, and the immutability triggers of AD-11 together with their
-- one way out.
--
-- It is the same schema as `packages/postgres/migrations/0001_initial.sql` --
-- same tables, same columns, same keys, same checks -- because the Postgres side
-- is a replica of this one and two schemas that drift are two schemas (AD-22).
-- Only the spelling differs, and only where SQLite has no word for what Postgres
-- says:
--
--   * `uuid` -> `text`. The writing side mints a UUIDv7 either way (AD-8).
--   * `timestamptz` -> `text` in the one canonical spelling Core's codec
--     produces, `YYYY-MM-DDTHH:MM:SS.sssZ`, pinned by a `glob` check (AD-13).
--     SQLite has no instant type, so the check is the type.
--   * `boolean` -> `integer` with `check (x in (0, 1))`, for the same reason.
--   * `jsonb` -> `text`. jsonb compares by value; text does not, so the one
--     JSON column gets a canonical-form check instead (see `index_configs`).
--   * `unique nulls not distinct` -> a unique index over `coalesce` expressions,
--     because SQLite's unique indexes treat every null as its own value.
--   * gin trigram indexes -> FTS5 tables with the `trigram` tokenizer and the
--     triggers that keep them in step (AD-15).
--   * plpgsql triggers -> `before` triggers whose `when` clause does the
--     deciding, over the `brain_redact_allowed()` function `openSqlite`
--     registers (AD-11).
--
-- One trigger is not just spelled differently, it decides differently: Postgres
-- refuses every `update` on `tool_notes`, because its `brain_redact_message`
-- masks a message body only and has no way to mask a tool note yet. Here the
-- redaction is an ordinary update under a raised marker, and AD-11 has it mask
-- the tool notes along with the message, so the `tool_notes` trigger lets a
-- marked `target`-only update through. The Postgres side has to catch up before
-- it can replicate one (deferred, epic 7). The tables and keys are the same;
-- this is the one behaviour that is not.
--
-- Every ordinary table is `STRICT`: without it SQLite stores whatever it is
-- given in whatever column it is given, and a replica that copies this data has
-- no way back. `embeddings` and its virtual table are deliberately absent: they
-- arrive the day embedding is switched on (AD-15).

-- A workspace groups projects and the sessions that belong to no project.
create table workspaces (
  id text primary key,
  name text not null unique
) strict;

-- A repository, identified by its normalized git remote (AD-12).
create table projects (
  id text primary key,
  remote_identity text not null unique,
  workspace_id text references workspaces (id)
) strict;

-- A checkout of a project. The row outlives the folder (AD-12).
create table worktrees (
  id text primary key,
  project_id text not null references projects (id),
  path text not null,
  removed_at text,
  unique (project_id, path),
  constraint worktrees_removed_at_check
    check (removed_at is null
           or removed_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- One harness session. `last_harness_message_id` and `cursor_fingerprint` are
-- the two halves of the parser cursor (AD-4), so they are set together or not
-- at all.
create table sessions (
  id text primary key,
  harness text not null,
  harness_session_id text not null,
  user_id text not null,
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

-- Conversation messages. Immutable, with `messages.redact` as the one
-- exception (AD-11).
create table messages (
  id text primary key,
  session_id text not null references sessions (id),
  harness_message_id text not null,
  seq integer not null,
  role text not null,
  model text,
  body text not null,
  occurred_at text not null,
  unique (session_id, harness_message_id),
  unique (session_id, seq),
  constraint messages_role_check check (role in ('user', 'assistant')),
  constraint messages_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- One line per tool call. Immutable; the tool's output is never kept.
--
-- `search_rowid` is this table's rowid under a name, because `target` is one of
-- the three searched columns and an external-content FTS5 index finds its rows
-- by rowid. An implicit rowid is not stable -- `VACUUM` and `VACUUM INTO` are
-- both allowed to renumber -- and a renumbered rowid silently points the index
-- at the wrong row. The column is this adapter's own: it is not in the domain
-- types, not in the Table Contract keys, and not carried by an export, which is
-- rebuilt with `rebuild` after a restore.
create table tool_notes (
  search_rowid integer primary key,
  id text not null unique,
  session_id text not null references sessions (id),
  harness_message_id text not null,
  ordinal integer not null,
  tool text not null,
  target text not null,
  ok integer not null,
  unique (session_id, harness_message_id, ordinal),
  constraint tool_notes_ok_check check (ok in (0, 1))
) strict;

-- Work log lines. `rule_state` exists for rules and only for rules (AD-14).
-- `search_rowid` is the FTS5 anchor for `text`; see `tool_notes`.
create table log_entries (
  search_rowid integer primary key,
  id text not null unique,
  kind text not null,
  session_id text not null references sessions (id),
  occurred_at text not null,
  recorded_at text not null,
  author_model text,
  "text" text not null,
  rule_state text,
  apply_project_id text references projects (id),
  supersedes_id text references log_entries (id),
  anchor_seq integer,
  joined_upto_seq integer,
  constraint log_entries_kind_check
    check (kind in ('progress', 'decision', 'rule', 'preference')),
  constraint log_entries_rule_state_check
    check ((kind = 'rule') = (rule_state is not null)),
  constraint log_entries_rule_state_values_check
    check (rule_state is null or rule_state in ('pending', 'on', 'off')),
  constraint log_entries_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint log_entries_recorded_at_check
    check (recorded_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- The sentence a `log.edit` replaced, written in the same transaction (AD-11).
create table log_entry_edits (
  id text primary key,
  log_entry_id text not null references log_entries (id),
  previous_text text not null,
  edited_at text not null,
  constraint log_entry_edits_edited_at_check
    check (edited_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- An index generation. `chunk_params` is part of the key, and a chunk-only
-- config leaves `model` and `dimensions` null, so nulls count as equal here --
-- which the unique index below spells out, because SQLite's own `unique` would
-- let every chunk-only config in.
--
-- Postgres compares `jsonb` by value, so `{"a":1,"b":2}` and `{"b":2,"a":1}`
-- are the same key there. SQLite compares the text, so instead of making two
-- spellings equal this check leaves only one spelling possible: the column has
-- to be exactly what `json_object` builds from its own three values, in this
-- order. Any other order, any extra key and any stray whitespace is refused at
-- the door rather than quietly becoming a second row with the same meaning.
create table index_configs (
  id text primary key,
  kind text not null,
  model text,
  dimensions integer,
  chunk_params text not null,
  constraint index_configs_kind_check check (kind in ('chunk', 'embedding')),
  constraint index_configs_chunk_params_check
    check (chunk_params = json_object(
             'targetChars', json_extract(chunk_params, '$.targetChars'),
             'overlapMessages', json_extract(chunk_params, '$.overlapMessages'),
             'splitMessagesOverChars', json_extract(chunk_params, '$.splitMessagesOverChars')))
) strict;

-- `nulls not distinct`, by hand. The stand-ins are values the columns cannot
-- hold: `model` is a model name and never empty, `dimensions` is a width and
-- never negative.
create unique index index_configs_key_idx
  on index_configs (kind, coalesce(model, ''), coalesce(dimensions, -1), chunk_params);

-- Derived slices of a session's messages. Always built (AD-15). `search_rowid`
-- is the FTS5 anchor for `body`; see `tool_notes`.
create table chunks (
  search_rowid integer primary key,
  id text not null unique,
  session_id text not null references sessions (id),
  index_config_id text not null references index_configs (id),
  seq_from integer not null,
  seq_to integer not null,
  body text not null,
  unique (session_id, index_config_id, seq_from, seq_to)
) strict;

-- One masked span. The removed text is not kept, only its hash (AD-11). The
-- range is the half-open code point interval `[start, end)` over the body as
-- it stood just before this masking -- that is, where the hashed text sat. The
-- marker then takes its place, so a later masking of the same message counts
-- over the body that marker left behind (Conventions); `end` is a reserved
-- word here as well, hence the quotes.
create table redactions (
  id text primary key,
  message_id text not null references messages (id),
  start integer not null,
  "end" integer not null,
  kind text not null,
  content_hash text not null,
  occurred_at text not null,
  constraint redactions_range_check check (start >= 0 and start < "end"),
  constraint redactions_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Every attempt to deliver the start context, successful or not (AD-17).
create table context_injections (
  id text primary key,
  session_id text not null references sessions (id),
  attempted_at text not null,
  ok integer not null,
  code text,
  chars integer not null,
  constraint context_injections_ok_check check (ok in (0, 1)),
  constraint context_injections_attempted_at_check
    check (attempted_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Failures from every path. The session key is always known, the Brain-side
-- `session_id` may not be (AD-12).
create table failures (
  id text primary key,
  harness text not null,
  harness_session_id text not null,
  stage text not null,
  fingerprint text not null,
  session_id text references sessions (id),
  code text not null,
  message text not null,
  occurred_at text not null,
  resolved_at text,
  unique (harness, harness_session_id, stage, fingerprint),
  constraint failures_occurred_at_check
    check (occurred_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint failures_resolved_at_check
    check (resolved_at is null
           or resolved_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Transcript files drain found while scanning a harness folder.
create table transcript_files (
  id text primary key,
  harness text not null,
  path text not null,
  size_bytes integer not null,
  fingerprint text not null,
  last_harness_message_id text,
  cursor_fingerprint text,
  scanned_at text not null,
  unique (harness, path),
  constraint transcript_files_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null)),
  constraint transcript_files_scanned_at_check
    check (scanned_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Which migration this database is at. One row, forever: Postgres uses a
-- boolean primary key, SQLite has no boolean, so it is the integer 1 and the
-- `check` is what makes a second row impossible (AD-20).
create table schema_version (
  id integer primary key,
  version integer not null,
  applied_at text not null,
  constraint schema_version_single_row_check check (id = 1),
  constraint schema_version_applied_at_check
    check (applied_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Immutability (AD-11). These triggers stop a coding mistake from rewriting
-- what a harness said; they are not a defence against deliberate SQL.
--
-- The one way out is a redaction, which raises a marker for the length of its
-- transaction -- `withWrite(..., { redact: true })` on one side, the
-- `brain_redact_allowed()` SQL function `openSqlite` registers on the other.
-- Unlike Postgres, the marker does not name a row: a single redaction
-- transaction masks a message and the tool notes that go with it, so it says
-- "a redaction is in progress" and the `when` clause below does the rest --
-- every column but the one holding the text has to be untouched.
--
-- `is` and not `=`, because `=` is null against a null column and a `when`
-- that is null does not fire, which would let a null column through unchecked.
--
-- There is no truncate to refuse: SQLite has no `truncate` statement, and the
-- optimisation it does run for a bare `delete from t` is switched off for any
-- table that has a delete trigger -- so the trigger below sees those rows one
-- by one and stops at the first. `INSERT OR REPLACE` and `on conflict do
-- update` are the two that look like inserts: the first deletes the conflicting
-- row (the delete trigger refuses it, because `openSqlite` turns on
-- `recursive_triggers`, without which REPLACE skips triggers entirely) and the
-- second updates it (the update trigger refuses it).
create trigger messages_immutable_update
  before update on messages
  when not (brain_redact_allowed() = 1
            and new.id is old.id
            and new.session_id is old.session_id
            and new.harness_message_id is old.harness_message_id
            and new.seq is old.seq
            and new.role is old.role
            and new.model is old.model
            and new.occurred_at is old.occurred_at)
begin
  select raise(abort,
    'messages is immutable: an update is refused unless a redaction is in progress and changes body alone');
end;

create trigger messages_immutable_delete
  before delete on messages
begin
  select raise(abort, 'messages is immutable: delete is refused');
end;

create trigger tool_notes_immutable_update
  before update on tool_notes
  when not (brain_redact_allowed() = 1
            and new.search_rowid is old.search_rowid
            and new.id is old.id
            and new.session_id is old.session_id
            and new.harness_message_id is old.harness_message_id
            and new.ordinal is old.ordinal
            and new.tool is old.tool
            and new.ok is old.ok)
begin
  select raise(abort,
    'tool_notes is immutable: an update is refused unless a redaction is in progress and changes target alone');
end;

create trigger tool_notes_immutable_delete
  before delete on tool_notes
begin
  select raise(abort, 'tool_notes is immutable: delete is refused');
end;

-- Keyword search is the default, so the three searched columns get their
-- indexes right here (AD-15, Conventions: indexes are SQL too). `trigram` is
-- the tokenizer that searches languages with no spaces between words, which is
-- half of what gets written here; `checkHealth` probes for it (AD-10).
--
-- External content (`content=`): the index holds the terms, the table holds the
-- text, and nothing is stored twice. The price is that FTS5 cannot see a write
-- it was not told about, so every write to a searched column is mirrored by a
-- trigger in the same transaction -- including the ones a redaction, a
-- `log.edit` or a chunk rebuild makes, which is what keeps a masked secret out
-- of the index (AD-11).
create virtual table chunks_fts using fts5(
  body, content='chunks', content_rowid='search_rowid', tokenize='trigram');
-- A `delete` the index has been told about stops the row being found, but by
-- default it only writes a tombstone: the trigrams of the old text sit in the
-- `_fts_data` blocks until some later write happens to merge that segment. For
-- a redaction that is the secret still on disk, which is the one thing AD-11
-- promises it is not, so the index overwrites instead of tombstoning.
insert into chunks_fts(chunks_fts, rank) values ('secure-delete', 1);

create trigger chunks_fts_ai after insert on chunks begin
  insert into chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

create trigger chunks_fts_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, body) values ('delete', old.search_rowid, old.body);
end;

create trigger chunks_fts_au after update of body on chunks begin
  insert into chunks_fts(chunks_fts, rowid, body) values ('delete', old.search_rowid, old.body);
  insert into chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

create virtual table log_entries_fts using fts5(
  "text", content='log_entries', content_rowid='search_rowid', tokenize='trigram');
-- See `chunks_fts`: a tombstone is not a removal.
insert into log_entries_fts(log_entries_fts, rank) values ('secure-delete', 1);

create trigger log_entries_fts_ai after insert on log_entries begin
  insert into log_entries_fts(rowid, "text") values (new.search_rowid, new."text");
end;

create trigger log_entries_fts_ad after delete on log_entries begin
  insert into log_entries_fts(log_entries_fts, rowid, "text")
       values ('delete', old.search_rowid, old."text");
end;

create trigger log_entries_fts_au after update of "text" on log_entries begin
  insert into log_entries_fts(log_entries_fts, rowid, "text")
       values ('delete', old.search_rowid, old."text");
  insert into log_entries_fts(rowid, "text") values (new.search_rowid, new."text");
end;

-- `tool_notes` has no delete trigger here because it has no delete: the one
-- above refuses every one of them. The update is the redaction, and nothing
-- else.
create virtual table tool_notes_fts using fts5(
  target, content='tool_notes', content_rowid='search_rowid', tokenize='trigram');
-- See `chunks_fts`: a tombstone is not a removal.
insert into tool_notes_fts(tool_notes_fts, rank) values ('secure-delete', 1);

create trigger tool_notes_fts_ai after insert on tool_notes begin
  insert into tool_notes_fts(rowid, target) values (new.search_rowid, new.target);
end;

create trigger tool_notes_fts_au after update of target on tool_notes begin
  insert into tool_notes_fts(tool_notes_fts, rowid, target)
       values ('delete', old.search_rowid, old.target);
  insert into tool_notes_fts(rowid, target) values (new.search_rowid, new.target);
end;

-- The chunking rules a fresh install starts with (AD-15). On Postgres the
-- installer seeds this row, because `ensureDefaultIndexConfig` can lean on
-- jsonb's by-value conflict; here the canonical-form check already settled what
-- the text has to look like, so the migration writes it and the SQLite install
-- path has no seeding step. The id is a fixed UUIDv7 literal: a migration that
-- minted a new one on every machine would give the same row a different name
-- everywhere, and the replica would have two (AD-22).
--
-- The values are `DEFAULT_CHUNK_PARAMS` in `packages/postgres/src/setup.ts`;
-- they live in the row and not in code, and this is only what the first row is
-- created with. No embedding config is created: that one arrives the day
-- embedding is switched on, with its model and its width (AD-15).
insert into index_configs (id, kind, model, dimensions, chunk_params)
     values ('019a0000-0000-7000-8000-000000000001', 'chunk', null, null,
             '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}');
