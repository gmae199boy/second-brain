-- The first migration: every table of the Table Contract except `embeddings`,
-- the idempotency keys of AD-8, the keyword-search indexes of AD-15, and the
-- immutability triggers of AD-11 together with their one way out.
--
-- Conventions: tables and columns are the `snake_case` of the fields in
-- `packages/core/src/domain`, every id is a `uuid` with no default (the writing
-- side mints a UUIDv7, AD-8), and every instant is `timestamptz` (AD-13).
-- `embeddings` and the `vector` extension are deliberately absent: they arrive
-- the day embedding is switched on (AD-15).

create extension if not exists pg_trgm;

-- A workspace groups projects and the sessions that belong to no project.
create table workspaces (
  id uuid primary key,
  name text not null unique
);

-- A repository, identified by its normalized git remote (AD-12).
create table projects (
  id uuid primary key,
  remote_identity text not null unique,
  workspace_id uuid references workspaces (id)
);

-- A checkout of a project. The row outlives the folder (AD-12).
create table worktrees (
  id uuid primary key,
  project_id uuid not null references projects (id),
  path text not null,
  removed_at timestamptz,
  unique (project_id, path)
);

-- One harness session. `last_harness_message_id` and `cursor_fingerprint` are
-- the two halves of the parser cursor (AD-4), so they are set together or not
-- at all.
create table sessions (
  id uuid primary key,
  harness text not null,
  harness_session_id text not null,
  user_id text not null,
  machine text not null,
  started_at timestamptz not null,
  workspace_id uuid references workspaces (id),
  project_id uuid references projects (id),
  worktree_id uuid references worktrees (id),
  ingest_source text not null,
  ended_at timestamptz,
  last_harness_message_id text,
  cursor_fingerprint text,
  parser_version text,
  ingested_at timestamptz,
  start_source text,
  continued_from_session_id uuid references sessions (id),
  unique (harness, harness_session_id),
  constraint sessions_ingest_source_check
    check (ingest_source in ('live', 'import')),
  constraint sessions_start_source_check
    check (start_source is null
           or start_source in ('startup', 'resume', 'clear', 'compact', 'fork')),
  constraint sessions_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null))
);

-- Conversation messages. Immutable, with `messages.redact` as the one
-- exception (AD-11).
create table messages (
  id uuid primary key,
  session_id uuid not null references sessions (id),
  harness_message_id text not null,
  seq integer not null,
  role text not null,
  model text,
  body text not null,
  occurred_at timestamptz not null,
  unique (session_id, harness_message_id),
  unique (session_id, seq),
  constraint messages_role_check check (role in ('user', 'assistant'))
);

-- One line per tool call. Immutable; the tool's output is never kept.
create table tool_notes (
  id uuid primary key,
  session_id uuid not null references sessions (id),
  harness_message_id text not null,
  ordinal integer not null,
  tool text not null,
  target text not null,
  ok boolean not null,
  unique (session_id, harness_message_id, ordinal)
);

-- Work log lines. `rule_state` exists for rules and only for rules (AD-14).
create table log_entries (
  id uuid primary key,
  kind text not null,
  session_id uuid not null references sessions (id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  author_model text,
  text text not null,
  rule_state text,
  apply_project_id uuid references projects (id),
  supersedes_id uuid references log_entries (id),
  anchor_seq integer,
  joined_upto_seq integer,
  constraint log_entries_kind_check
    check (kind in ('progress', 'decision', 'rule', 'preference')),
  constraint log_entries_rule_state_check
    check ((kind = 'rule') = (rule_state is not null)),
  constraint log_entries_rule_state_values_check
    check (rule_state is null or rule_state in ('pending', 'on', 'off'))
);

-- The sentence a `log.edit` replaced, written in the same transaction (AD-11).
create table log_entry_edits (
  id uuid primary key,
  log_entry_id uuid not null references log_entries (id),
  previous_text text not null,
  edited_at timestamptz not null
);

-- An index generation. `chunk_params` is part of the key, and a chunk-only
-- config leaves `model` and `dimensions` null, so nulls count as equal here.
create table index_configs (
  id uuid primary key,
  kind text not null,
  model text,
  dimensions integer,
  chunk_params jsonb not null,
  unique nulls not distinct (kind, model, dimensions, chunk_params),
  constraint index_configs_kind_check check (kind in ('chunk', 'embedding'))
);

-- Derived slices of a session's messages. Always built (AD-15).
create table chunks (
  id uuid primary key,
  session_id uuid not null references sessions (id),
  index_config_id uuid not null references index_configs (id),
  seq_from integer not null,
  seq_to integer not null,
  body text not null,
  unique (session_id, index_config_id, seq_from, seq_to)
);

-- One masked span. The removed text is not kept, only its hash (AD-11). The
-- range is the half-open code point interval `[start, end)` over the body as
-- it stood just before this masking -- that is, where the hashed text sat. The
-- marker then takes its place, so a later masking of the same message counts
-- over the body that marker left behind (Conventions); `end` is a reserved
-- word, hence the quotes.
create table redactions (
  id uuid primary key,
  message_id uuid not null references messages (id),
  start integer not null,
  "end" integer not null,
  kind text not null,
  content_hash text not null,
  occurred_at timestamptz not null,
  constraint redactions_range_check check (start >= 0 and start < "end")
);

-- Every attempt to deliver the start context, successful or not (AD-17).
create table context_injections (
  id uuid primary key,
  session_id uuid not null references sessions (id),
  attempted_at timestamptz not null,
  ok boolean not null,
  code text,
  chars integer not null
);

-- Failures from every path. The session key is always known, the Brain-side
-- `session_id` may not be (AD-12).
create table failures (
  id uuid primary key,
  harness text not null,
  harness_session_id text not null,
  stage text not null,
  fingerprint text not null,
  session_id uuid references sessions (id),
  code text not null,
  message text not null,
  occurred_at timestamptz not null,
  resolved_at timestamptz,
  unique (harness, harness_session_id, stage, fingerprint)
);

-- Transcript files drain found while scanning a harness folder.
create table transcript_files (
  id uuid primary key,
  harness text not null,
  path text not null,
  size_bytes bigint not null,
  fingerprint text not null,
  last_harness_message_id text,
  cursor_fingerprint text,
  scanned_at timestamptz not null,
  unique (harness, path),
  constraint transcript_files_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null))
);

-- Which migration this database is at. One row, forever: the boolean primary
-- key with its `check` makes a second one impossible (AD-20).
create table schema_version (
  id boolean primary key,
  version integer not null,
  applied_at timestamptz not null,
  constraint schema_version_single_row_check check (id)
);

-- Keyword search is the default, so the three searched columns get their
-- trigram indexes right here (AD-15, Conventions: indexes are SQL too).
create index chunks_body_trgm_idx on chunks using gin (body gin_trgm_ops);
create index log_entries_text_trgm_idx on log_entries using gin ("text" gin_trgm_ops);
create index tool_notes_target_trgm_idx on tool_notes using gin (target gin_trgm_ops);

-- Immutability (AD-11). These triggers stop a coding mistake from rewriting
-- what a harness said; they are not a defence against deliberate SQL.
--
-- The one way out is `brain_redact_message`, which turns on the
-- transaction-local marker `brain.redacting` for exactly the message it is
-- about to mask. The trigger lets that update through only when the marker
-- names this very row and nothing but `body` changed.
create function brain_reject_mutation() returns trigger
language plpgsql as $$
declare
  -- `new` with the old body put back: if that equals `old`, only `body` moved.
  body_only_change messages;
begin
  if tg_op = 'UPDATE'
     and tg_table_name = 'messages'
     and current_setting('brain.redacting', true) = old.id::text then
    body_only_change := new;
    body_only_change.body := old.body;
    if body_only_change is not distinct from old then
      return new;
    end if;
    raise exception
      'messages is immutable: redacting message % may change body and nothing else',
      old.id
      using errcode = 'restrict_violation';
  end if;

  raise exception '% is immutable: % is refused', tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

create function brain_reject_truncate() returns trigger
language plpgsql as $$
begin
  raise exception '% is immutable: truncate is refused', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger messages_immutable
  before update or delete on messages
  for each row execute function brain_reject_mutation();

create trigger messages_immutable_truncate
  before truncate on messages
  for each statement execute function brain_reject_truncate();

create trigger tool_notes_immutable
  before update or delete on tool_notes
  for each row execute function brain_reject_mutation();

create trigger tool_notes_immutable_truncate
  before truncate on tool_notes
  for each statement execute function brain_reject_truncate();

-- The only sanctioned write to a stored body (AD-11). In one transaction it
-- replaces the half-open code point range `[range_start, range_end)` of the
-- body as it stands right now with `[REDACTED:<kind>]`, and records that range
-- -- where the removed text sat before the marker replaced it -- together with
-- the kind and the sha256 of what went away. The removed text itself is stored
-- nowhere.
--
-- Postgres counts `text` positions in characters, which in a UTF-8 database
-- are code points, so the range means the same thing here as in Core
-- (Conventions). `substr` counts from 1.
create function brain_redact_message(
  redaction_id uuid,
  target_message_id uuid,
  range_start integer,
  range_end integer,
  redaction_kind text,
  redacted_at timestamptz
) returns void
language plpgsql as $$
declare
  stored_body text;
  removed text;
  marker text := '[REDACTED:' || redaction_kind || ']';
begin
  if range_start < 0 or range_start >= range_end then
    raise exception
      'a redaction range is half-open and non-empty: got [%, %)', range_start, range_end
      using errcode = 'check_violation';
  end if;

  select body into stored_body from messages where id = target_message_id for update;
  if not found then
    raise exception 'no message %', target_message_id
      using errcode = 'no_data_found';
  end if;

  if range_end > length(stored_body) then
    raise exception
      'a redaction range must stay inside the body: [%, %) over % code points of message %',
      range_start, range_end, length(stored_body), target_message_id
      using errcode = 'check_violation';
  end if;

  removed := substr(stored_body, range_start + 1, range_end - range_start);

  perform set_config('brain.redacting', target_message_id::text, true);
  update messages
     set body = substr(stored_body, 1, range_start) || marker
                || substr(stored_body, range_end + 1)
   where id = target_message_id;
  perform set_config('brain.redacting', '', true);

  insert into redactions (id, message_id, start, "end", kind, content_hash, occurred_at)
  values (redaction_id, target_message_id, range_start, range_end, redaction_kind,
          encode(sha256(convert_to(removed, 'UTF8')), 'hex'), redacted_at);
end;
$$;
