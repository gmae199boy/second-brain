-- Core collection baseline. Setup creates brain and its migration ledger.
-- Transcript text uses U+FFFD for NUL; nullable *_raw holds the original UTF-8.
-- Identity keys include raw bytes so U+0000 and literal U+FFFD stay distinct.
create extension if not exists pg_trgm;

create table brain.workspaces (
  id uuid primary key,
  name text not null unique
);

create table brain.users (
  id uuid primary key,
  name text not null,
  is_self integer not null,
  created_at timestamptz not null,
  constraint users_is_self_check check (is_self in (0, 1))
);

create table brain.projects (
  id uuid primary key,
  remote_identity text not null unique,
  workspace_id uuid references brain.workspaces (id),
  identity_key text not null unique
);

create table brain.worktrees (
  id uuid primary key,
  project_id uuid not null references brain.projects (id),
  path text not null,
  removed_at timestamptz,
  unique (project_id, path)
);

create table brain.sessions (
  id uuid primary key,
  harness text not null,
  harness_session_id text not null,
  user_id uuid not null references brain.users (id),
  machine text not null,
  started_at timestamptz not null,
  workspace_id uuid references brain.workspaces (id),
  project_id uuid references brain.projects (id),
  worktree_id uuid references brain.worktrees (id),
  ingest_source text not null,
  ended_at timestamptz,
  last_harness_message_id text,
  last_harness_message_id_raw bytea,
  cursor_fingerprint text,
  parser_version text,
  ingested_at timestamptz,
  start_source text,
  continued_from_session_id uuid references brain.sessions (id), tag_source text, first_cwd text,
  first_cwd_raw bytea,
  unique (harness, harness_session_id),
  constraint sessions_ingest_source_check
    check (ingest_source in ('live', 'import')),
  constraint sessions_start_source_check
    check (start_source is null
           or start_source in ('startup', 'resume', 'clear', 'compact', 'fork')),
  constraint sessions_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null))
);

create table brain.messages (
  id uuid primary key,
  session_id uuid not null references brain.sessions (id),
  harness_message_id text not null,
  harness_message_id_raw bytea,
  role text not null,
  model text,
  model_raw bytea,
  body text not null,
  body_raw bytea,
  occurred_at timestamptz not null,
  git_branch text,
  git_branch_raw bytea,
  is_subagent_report integer not null default 0,
  unique nulls not distinct (session_id, harness_message_id, harness_message_id_raw),
  constraint messages_role_check check (role in ('user', 'assistant')),
  constraint messages_is_subagent_report_check check (is_subagent_report in (0, 1))
);

create table brain.tool_notes (
  id uuid primary key,
  session_id uuid not null references brain.sessions (id),
  harness_message_id text not null,
  harness_message_id_raw bytea,
  ordinal integer not null,
  tool text not null,
  tool_raw bytea,
  target text not null,
  target_raw bytea,
  ok integer not null, call_id text,
  call_id_raw bytea,
  unique nulls not distinct (session_id, harness_message_id, harness_message_id_raw, ordinal),
  constraint tool_notes_ok_check check (ok in (0, 1))
);

create table brain.transcript_files (
  id uuid primary key,
  harness text not null,
  path text not null,
  size_bytes integer not null,
  fingerprint text not null,
  last_harness_message_id text,
  last_harness_message_id_raw bytea,
  cursor_fingerprint text,
  scanned_at timestamptz not null,
  unique (harness, path),
  constraint transcript_files_cursor_check
    check ((last_harness_message_id is null) = (cursor_fingerprint is null))
);

create table brain.failures (
  id uuid primary key,
  target_kind text not null,
  target_id text not null,
  stage text not null,
  fingerprint text not null,
  harness text,
  session_id uuid references brain.sessions (id),
  code text not null,
  message text not null,
  occurred_at timestamptz not null,
  resolved_at timestamptz,
  first_occurred_at timestamptz not null,
  occurrences integer not null,
  unique (target_kind, target_id, stage, fingerprint),
  constraint failures_occurrences_check check (occurrences >= 1)
);

create table brain.work_items (
  id uuid primary key,
  kind text not null,
  target_kind text not null,
  target_id text not null,
  created_at timestamptz not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claimed_by text,
  last_error text,
  completed_at timestamptz,
  constraint work_items_attempts_check check (attempts >= 0),
  constraint work_items_claim_check
    check ((claimed_at is null) = (claim_expires_at is null)
           and (claimed_at is null) = (claimed_by is null))
);

create table brain.files (
  id uuid primary key,
  content_hash text not null unique,
  size_bytes integer not null,
  first_seen_at timestamptz not null,
  home_location_id uuid,
  current_extraction_id uuid,
  redacted_at timestamptz, source_unreachable_at timestamptz,
  constraint files_size_bytes_check check (size_bytes >= 0)
);

create table brain.file_locations (
  id uuid primary key,
  file_id uuid not null references brain.files (id),
  store_kind text not null,
  locator text not null,
  ownership text not null,
  first_seen_at timestamptz not null,
  source_modified_at timestamptz,
  uploaded_at timestamptz,
  remote_checksum text,
  verified_at timestamptz,
  deleted_at timestamptz,
  unique (file_id, store_kind, locator),
  constraint file_locations_store_kind_check check (store_kind in ('local', 'drive')),
  constraint file_locations_ownership_check check (ownership in ('brain', 'external'))
);

create table brain.message_attachments (
  id uuid primary key,
  message_id uuid not null references brain.messages (id),
  ordinal integer not null,
  source_kind text not null,
  source_ref text,
  source_ref_raw bytea,
  display_name text,
  display_name_raw bytea,
  file_id uuid references brain.files (id),
  status text,
  unique (message_id, ordinal),
  constraint message_attachments_ordinal_check check (ordinal >= 0),
  constraint message_attachments_status_check
    check (status is null or status in ('stored', 'missing_at_ingest')),
  constraint message_attachments_file_check
    check ((file_id is not null) = (status is not distinct from 'stored'))
);

create table brain.redactions (
  id uuid primary key,
  message_id uuid references brain.messages (id),
  file_id uuid references brain.files (id),
  start integer,
  "end" integer,
  kind text not null,
  content_hash text not null,
  occurred_at timestamptz not null,
  pattern_version text,
  tool_note_id uuid references brain.tool_notes (id),
  constraint redactions_target_check
    check ((message_id is not null)::int + (file_id is not null)::int + (tool_note_id is not null)::int = 1),
  constraint redactions_range_check
    check (case
             when file_id is not null
               then start is null and "end" is null
             else start is not null and "end" is not null
                  and start >= 0 and start < "end"
           end)
);

alter table brain.files add foreign key (home_location_id) references brain.file_locations(id);
alter table brain.files add constraint files_content_hash_check check (content_hash ~ '^sha256:[0-9a-f]{64}$');
create unique index users_self_idx on brain.users(is_self) where is_self = 1;
create unique index tool_notes_call_id_idx on brain.tool_notes(session_id, call_id, call_id_raw) nulls not distinct where call_id is not null;
create unique index work_items_open_key_idx on brain.work_items(kind, target_kind, target_id) where completed_at is null;
create index work_items_due_idx on brain.work_items(attempts, id, next_attempt_at) where completed_at is null;
create index messages_session_occurred_idx on brain.messages(session_id, occurred_at);
create index tool_notes_target_idx on brain.tool_notes using gin (lower(target) public.gin_trgm_ops);

-- Remaining core tables, matching the final SQLite schema without FTS internals.
create table brain.log_entries (
  id uuid primary key,
  kind text not null,
  session_id uuid not null references brain.sessions(id),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  author_model text,
  "text" text not null,
  rule_state text,
  apply_project_id uuid references brain.projects(id),
  supersedes_id uuid references brain.log_entries(id),
  constraint log_entries_kind_check check (kind in ('progress', 'decision', 'rule', 'preference')),
  constraint log_entries_rule_state_check check ((kind = 'rule') = (rule_state is not null)),
  constraint log_entries_rule_state_values_check check (rule_state is null or rule_state in ('pending', 'on', 'off'))
);
create table brain.log_entry_edits (
  id uuid primary key,
  log_entry_id uuid not null references brain.log_entries(id),
  previous_text text not null,
  edited_at timestamptz not null
);
create table brain.index_configs (
  id uuid primary key,
  kind text not null,
  model text,
  dimensions integer,
  chunk_params jsonb not null,
  constraint index_configs_kind_check check (kind in ('chunk', 'embedding', 'document_chunk')),
  constraint index_configs_chunk_params_check check (
    jsonb_typeof(chunk_params) = 'object'
    and case when kind = 'document_chunk' then
      chunk_params ?& array['targetChars', 'overlapChars']
      and chunk_params - array['targetChars', 'overlapChars'] = '{}'::jsonb
      and jsonb_typeof(chunk_params->'targetChars') = 'number'
      and jsonb_typeof(chunk_params->'overlapChars') = 'number'
    else
      chunk_params ?& array['targetChars', 'overlapMessages', 'splitMessagesOverChars']
      and chunk_params - array['targetChars', 'overlapMessages', 'splitMessagesOverChars'] = '{}'::jsonb
      and jsonb_typeof(chunk_params->'targetChars') = 'number'
      and jsonb_typeof(chunk_params->'overlapMessages') = 'number'
      and jsonb_typeof(chunk_params->'splitMessagesOverChars') = 'number'
    end
  )
);
create unique index index_configs_key_idx on brain.index_configs(kind, model, dimensions, chunk_params) nulls not distinct;
insert into brain.index_configs(id, kind, model, dimensions, chunk_params) values
  ('019a0000-0000-7000-8000-000000000001', 'chunk', null, null, '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}'),
  ('019a0000-0000-7000-8000-000000000002', 'document_chunk', null, null, '{"targetChars":1200,"overlapChars":120}');
create table brain.chunks (
  id uuid primary key,
  session_id uuid not null references brain.sessions(id),
  index_config_id uuid not null references brain.index_configs(id),
  from_at timestamptz not null,
  to_at timestamptz not null,
  body text not null,
  unique(session_id, index_config_id, from_at, to_at),
  constraint chunks_range_check check (from_at <= to_at)
);
create table brain.context_injections (
  id uuid primary key,
  session_id uuid not null references brain.sessions(id),
  attempted_at timestamptz not null,
  ok integer not null,
  code text,
  chars integer not null,
  constraint context_injections_ok_check check (ok in (0, 1))
);
create table brain.document_extractions (
  id uuid primary key,
  file_id uuid not null references brain.files(id),
  extractor_version text not null,
  attempt integer not null,
  media_type text,
  status text,
  started_at timestamptz not null,
  finished_at timestamptz,
  error text,
  failed_stage text,
  index_config_id uuid references brain.index_configs(id),
  unique(file_id, attempt),
  constraint document_extractions_attempt_check check (attempt >= 1),
  constraint document_extractions_status_check check (status is null or status in ('ok', 'failed', 'unsupported', 'too_large', 'redacted')),
  constraint document_extractions_finished_check check ((finished_at is null) = (status is null)),
  constraint document_extractions_failed_stage_check check (
    (status is not distinct from 'failed') = (failed_stage is not null)
    and (failed_stage is null or failed_stage in ('read', 'extract', 'chunk', 'index')))
);
create unique index document_extractions_running_idx on brain.document_extractions(file_id) where finished_at is null;
alter table brain.files add foreign key (current_extraction_id) references brain.document_extractions(id);
create table brain.document_chunks (
  id uuid primary key,
  extraction_id uuid not null references brain.document_extractions(id),
  ordinal integer not null,
  page integer,
  body text not null,
  chunk_locator text not null,
  unique(extraction_id, ordinal),
  constraint document_chunks_locator_check check (case when pg_input_is_valid(chunk_locator, 'jsonb') then
    coalesce(jsonb_typeof(chunk_locator::jsonb) = 'object'
      and chunk_locator::jsonb->>'type' in ('pdf', 'docx', 'text', 'time', 'sheet')
      and to_jsonb(page) is not distinct from
        (case when chunk_locator::jsonb->>'type' = 'pdf' then chunk_locator::jsonb->'page' end), false)
    else false end)
);
create table brain.file_names (
  id uuid primary key,
  file_id uuid not null references brain.files(id),
  name_source text not null,
  "text" text not null,
  unique nulls not distinct(file_id, name_source, "text", text_raw),
  constraint file_names_name_source_check check (name_source in ('location_path', 'attachment_name')),
  text_raw bytea
);
create table brain.file_metadata (
  id uuid primary key,
  file_id uuid not null references brain.files(id),
  key text not null,
  value text not null,
  unique(file_id, key),
  constraint file_metadata_captured_at_check check (key <> 'captured_at' or value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
);
create table brain.schedules (
  id uuid primary key,
  kind text not null,
  target_kind text not null,
  target_id text not null,
  interval_seconds integer,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null,
  check (interval_seconds is null or interval_seconds > 0),
  check (interval_seconds is null or next_run_at is not null)
);
create index schedules_due_idx on brain.schedules(next_run_at) where next_run_at is not null;
create table brain.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null
);
create index chunks_body_idx on brain.chunks using gin (lower(body) public.gin_trgm_ops);
create index log_entries_text_idx on brain.log_entries using gin (lower("text") public.gin_trgm_ops);
create index document_chunks_body_idx on brain.document_chunks using gin (lower(body) public.gin_trgm_ops);
create index file_names_text_idx on brain.file_names using gin (lower("text") public.gin_trgm_ops);

create function brain.tool_notes_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'tool_notes_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger tool_notes_immutable_delete before delete on brain.tool_notes for each row execute function brain.tool_notes_immutable_delete_fn();

create function brain.files_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((not (new.id is not distinct from old.id
            and new.content_hash is not distinct from old.content_hash
            and new.size_bytes is not distinct from old.size_bytes
            and new.first_seen_at is not distinct from old.first_seen_at
            and (new.redacted_at is not distinct from old.redacted_at
                 or (current_setting('brain.redacting', true) = 'on'
            and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'MEMBER')
                     and old.redacted_at is null
                     and new.redacted_at is not null)))), true) then raise exception 'files_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger files_immutable_update before update on brain.files for each row execute function brain.files_immutable_update_fn();

create function brain.files_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'files_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger files_immutable_delete before delete on brain.files for each row execute function brain.files_immutable_delete_fn();

create function brain.files_home_check_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.home_location_id is not null
       and not exists (select 1 from brain.file_locations
                        where id = new.home_location_id
                          and file_id = new.id
                          and ownership = 'brain')), true) then raise exception 'files_home_check: invariant refused'; end if;
  return new;
end $$;
create trigger files_home_check before update of home_location_id on brain.files for each row execute function brain.files_home_check_fn();

create function brain.files_home_check_insert_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.home_location_id is not null
       and not exists (select 1 from brain.file_locations
                        where id = new.home_location_id
                          and file_id = new.id
                          and ownership = 'brain')), true) then raise exception 'files_home_check_insert: invariant refused'; end if;
  return new;
end $$;
create trigger files_home_check_insert before insert on brain.files for each row execute function brain.files_home_check_insert_fn();

create function brain.file_locations_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((not (new.id is not distinct from old.id
            and new.file_id is not distinct from old.file_id
            and new.store_kind is not distinct from old.store_kind
            and new.locator is not distinct from old.locator
            and new.ownership is not distinct from old.ownership
            and new.first_seen_at is not distinct from old.first_seen_at
            and new.source_modified_at is not distinct from old.source_modified_at
            and new.uploaded_at is not distinct from old.uploaded_at
            and new.remote_checksum is not distinct from old.remote_checksum
            and (new.verified_at is not distinct from old.verified_at
                 or (old.verified_at is null and new.verified_at is not null))
            and (new.deleted_at is not distinct from old.deleted_at
                 or (old.deleted_at is null and new.deleted_at is not null)))), true) then raise exception 'file_locations_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger file_locations_immutable_update before update on brain.file_locations for each row execute function brain.file_locations_immutable_update_fn();

create function brain.file_locations_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'file_locations_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger file_locations_immutable_delete before delete on brain.file_locations for each row execute function brain.file_locations_immutable_delete_fn();

create function brain.redactions_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'redactions_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger redactions_immutable_update before update on brain.redactions for each row execute function brain.redactions_immutable_update_fn();

create function brain.redactions_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'redactions_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger redactions_immutable_delete before delete on brain.redactions for each row execute function brain.redactions_immutable_delete_fn();

create function brain.tool_notes_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((not (current_setting('brain.redacting', true) = 'on'
            and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'MEMBER')
            and new.id is not distinct from old.id
            and new.session_id is not distinct from old.session_id
            and new.harness_message_id is not distinct from old.harness_message_id
            and new.harness_message_id_raw is not distinct from old.harness_message_id_raw
            and new.ordinal is not distinct from old.ordinal
            and new.tool is not distinct from old.tool
            and new.tool_raw is not distinct from old.tool_raw
            and new.ok is not distinct from old.ok
            and new.call_id is not distinct from old.call_id
            and new.call_id_raw is not distinct from old.call_id_raw)), true) then raise exception 'tool_notes_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger tool_notes_immutable_update before update on brain.tool_notes for each row execute function brain.tool_notes_immutable_update_fn();

create function brain.messages_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((not (current_setting('brain.redacting', true) = 'on'
            and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'MEMBER')
            and new.id is not distinct from old.id
            and new.session_id is not distinct from old.session_id
            and new.harness_message_id is not distinct from old.harness_message_id
            and new.harness_message_id_raw is not distinct from old.harness_message_id_raw
            and new.role is not distinct from old.role
            and new.model is not distinct from old.model
            and new.model_raw is not distinct from old.model_raw
            and new.occurred_at is not distinct from old.occurred_at
            and new.git_branch is not distinct from old.git_branch
            and new.git_branch_raw is not distinct from old.git_branch_raw
            and new.is_subagent_report is not distinct from old.is_subagent_report)), true) then raise exception 'messages_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger messages_immutable_update before update on brain.messages for each row execute function brain.messages_immutable_update_fn();

create function brain.messages_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'messages_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger messages_immutable_delete before delete on brain.messages for each row execute function brain.messages_immutable_delete_fn();

create function brain.sessions_tag_evidence_insert_fn() returns trigger language plpgsql as $$
begin
  if coalesce(((new.tag_source is not null and new.tag_source not in ('cwd', 'ancestor', 'sibling'))
  or ((new.tag_source is null) != (new.project_id is null))), true) then raise exception 'sessions_tag_evidence_insert: invariant refused'; end if;
  return new;
end $$;
create trigger sessions_tag_evidence_insert before insert on brain.sessions for each row execute function brain.sessions_tag_evidence_insert_fn();

create function brain.sessions_tag_evidence_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce(((new.tag_source is not null and new.tag_source not in ('cwd', 'ancestor', 'sibling'))
  or ((new.tag_source is null) != (new.project_id is null))
  or (old.tag_source is not null and new.tag_source is distinct from old.tag_source)
  or (old.first_cwd is not null and (new.first_cwd is distinct from old.first_cwd or new.first_cwd_raw is distinct from old.first_cwd_raw))), true) then raise exception 'sessions_tag_evidence_update: invariant refused'; end if;
  return new;
end $$;
create trigger sessions_tag_evidence_update before update on brain.sessions for each row execute function brain.sessions_tag_evidence_update_fn();

create function brain.message_attachments_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.id is distinct from old.id
    or new.message_id is distinct from old.message_id
    or new.ordinal is distinct from old.ordinal
    or new.source_kind is distinct from old.source_kind
    or new.source_ref is distinct from old.source_ref
    or new.source_ref_raw is distinct from old.source_ref_raw
    or new.display_name is distinct from old.display_name
    or new.display_name_raw is distinct from old.display_name_raw
    or (old.status is not null
        and (new.file_id is distinct from old.file_id or new.status is distinct from old.status))), true) then raise exception 'message_attachments_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger message_attachments_immutable_update before update on brain.message_attachments for each row execute function brain.message_attachments_immutable_update_fn();

create function brain.message_attachments_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  if coalesce((true), true) then raise exception 'message_attachments_immutable_delete: invariant refused'; end if;
  return new;
end $$;
create trigger message_attachments_immutable_delete before delete on brain.message_attachments for each row execute function brain.message_attachments_immutable_delete_fn();

create function brain.refuse_truncate() returns trigger language plpgsql as $$
begin raise exception 'immutable table: truncate refused'; end $$;
create trigger messages_no_truncate before truncate on brain.messages for each statement execute function brain.refuse_truncate();
create trigger tool_notes_no_truncate before truncate on brain.tool_notes for each statement execute function brain.refuse_truncate();
create trigger redactions_no_truncate before truncate on brain.redactions for each statement execute function brain.refuse_truncate();
create trigger files_no_truncate before truncate on brain.files for each statement execute function brain.refuse_truncate();
create trigger file_locations_no_truncate before truncate on brain.file_locations for each statement execute function brain.refuse_truncate();
create trigger message_attachments_no_truncate before truncate on brain.message_attachments for each statement execute function brain.refuse_truncate();
revoke update, delete on brain.messages, brain.tool_notes, brain.redactions from brain_app;
revoke insert, update, delete on brain.schema_migrations from brain_app;

-- A custom GUC is caller-settable: keep the redaction column outside runtime DML.
revoke update on brain.files from brain_app;
grant update (home_location_id, source_unreachable_at, current_extraction_id) on brain.files to brain_app;
revoke insert on brain.files from brain_app;
grant insert (id, content_hash, size_bytes, first_seen_at) on brain.files to brain_app;

create function brain.files_extraction_check_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.current_extraction_id is not null and not exists (select 1 from brain.document_extractions where id = new.current_extraction_id and file_id = new.id)), true) then raise exception 'files_extraction_check: invariant refused'; end if;
  return new;
end $$;
create trigger files_extraction_check before update of current_extraction_id on brain.files for each row execute function brain.files_extraction_check_fn();

create function brain.files_extraction_check_insert_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.current_extraction_id is not null and not exists (select 1 from brain.document_extractions where id = new.current_extraction_id and file_id = new.id)), true) then raise exception 'files_extraction_check_insert: invariant refused'; end if;
  return new;
end $$;
create trigger files_extraction_check_insert before insert on brain.files for each row execute function brain.files_extraction_check_insert_fn();

create function brain.document_extractions_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((new.id is distinct from old.id
    or new.file_id is distinct from old.file_id
    or new.extractor_version is distinct from old.extractor_version
    or new.attempt is distinct from old.attempt
    or new.started_at is distinct from old.started_at
    or (old.finished_at is not null and (new.media_type is distinct from old.media_type or new.status is distinct from old.status or new.finished_at is distinct from old.finished_at or new.error is distinct from old.error or new.failed_stage is distinct from old.failed_stage or new.index_config_id is distinct from old.index_config_id))), true) then raise exception 'document_extractions_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger document_extractions_immutable_update before update on brain.document_extractions for each row execute function brain.document_extractions_immutable_update_fn();

create function brain.document_chunks_delete_rule_fn() returns trigger language plpgsql as $$
declare
  extraction_finished_at timestamptz;
  file_current_extraction_id uuid;
begin
  if not (coalesce(current_setting('brain.redacting', true) = 'on', false)
    and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'MEMBER')) then
    select e.finished_at, f.current_extraction_id
      into extraction_finished_at, file_current_extraction_id
      from brain.document_extractions e join brain.files f on f.id = e.file_id
      where e.id = old.extraction_id for share of f;
    if found and (extraction_finished_at is null or file_current_extraction_id = old.extraction_id) then
      raise exception 'document_chunks_delete_rule: invariant refused';
    end if;
  end if;
  return old;
end $$;
create trigger document_chunks_delete_rule before delete on brain.document_chunks for each row execute function brain.document_chunks_delete_rule_fn();

create function brain.file_names_redacted_insert_fn() returns trigger language plpgsql as $$
declare target_redacted_at timestamptz;
begin
  -- Lock unredacted targets too, serializing derived writes with redaction.
  select redacted_at into target_redacted_at from brain.files where id = new.file_id for share;
  if target_redacted_at is not null then raise exception 'file_names_redacted_insert: invariant refused'; end if;
  return new;
end $$;
create trigger file_names_redacted_insert before insert on brain.file_names for each row execute function brain.file_names_redacted_insert_fn();

create function brain.file_names_redacted_update_fn() returns trigger language plpgsql as $$
declare target_redacted_at timestamptz;
begin
  -- Lock unredacted targets too, serializing derived writes with redaction.
  select redacted_at into target_redacted_at from brain.files where id = new.file_id for share;
  if target_redacted_at is not null then raise exception 'file_names_redacted_update: invariant refused'; end if;
  return new;
end $$;
create trigger file_names_redacted_update before update on brain.file_names for each row execute function brain.file_names_redacted_update_fn();

create function brain.file_metadata_redacted_insert_fn() returns trigger language plpgsql as $$
declare target_redacted_at timestamptz;
begin
  -- Lock unredacted targets too, serializing derived writes with redaction.
  select redacted_at into target_redacted_at from brain.files where id = new.file_id for share;
  if target_redacted_at is not null then raise exception 'file_metadata_redacted_insert: invariant refused'; end if;
  return new;
end $$;
create trigger file_metadata_redacted_insert before insert on brain.file_metadata for each row execute function brain.file_metadata_redacted_insert_fn();

create function brain.file_metadata_redacted_update_fn() returns trigger language plpgsql as $$
declare target_redacted_at timestamptz;
begin
  -- Lock unredacted targets too, serializing derived writes with redaction.
  select redacted_at into target_redacted_at from brain.files where id = new.file_id for share;
  if target_redacted_at is not null then raise exception 'file_metadata_redacted_update: invariant refused'; end if;
  return new;
end $$;
create trigger file_metadata_redacted_update before update on brain.file_metadata for each row execute function brain.file_metadata_redacted_update_fn();

create trigger document_extractions_no_truncate before truncate on brain.document_extractions for each statement execute function brain.refuse_truncate();

create trigger document_chunks_no_truncate before truncate on brain.document_chunks for each statement execute function brain.refuse_truncate();

-- Range replacement is checked inside the privileged entry point. PostgreSQL
-- substring offsets count code points, as do Core's stored redaction ranges.
create function brain.redacted_text(original text, records jsonb) returns text
language plpgsql set search_path = pg_catalog, brain as $$
declare r jsonb; result text := original; boundary integer := char_length(original);
begin
  for r in select value from jsonb_array_elements(records) order by (value->>'start')::integer desc loop
    if (r->>'start')::integer < 0 or (r->>'end')::integer <= (r->>'start')::integer
      or (r->>'end')::integer > boundary or r->>'kind' is null then
      raise exception 'redaction range: invariant refused';
    end if;
    result := substring(result from 1 for (r->>'start')::integer)
      || '[REDACTED:' || (r->>'kind') || ']'
      || substring(result from (r->>'end')::integer + 1);
    boundary := (r->>'start')::integer;
  end loop;
  return result;
end $$;
revoke all on function brain.redacted_text(text,jsonb) from public;

-- Raw bytes can contain NUL, which text cannot. Compare sanitized UTF-8 bytes
-- without ever attempting to decode a NUL-containing bytea into text.
create function brain.redaction_raw_valid(raw bytea, old_raw bytea, target text) returns boolean
language plpgsql immutable set search_path = pg_catalog as $$
declare expected bytea := convert_to(target, 'UTF8');
  raw_length integer := length(raw); expected_length integer := length(expected);
  i integer := 0; j integer := 0;
begin
  if raw is null then return true; end if;
  if old_raw is null then return false; end if;
  while i < raw_length loop
    if get_byte(raw,i)=0 then
      if j+3 > expected_length then return false; end if;
      if get_byte(expected,j)<>239 or get_byte(expected,j+1)<>191 or get_byte(expected,j+2)<>189 then
        return false;
      end if;
      j := j+3;
    else
      if j >= expected_length then return false; end if;
      if get_byte(raw,i)<>get_byte(expected,j) then return false; end if;
      j := j+1;
    end if;
    i := i+1;
  end loop;
  return j=expected_length;
end $$;
revoke all on function brain.redaction_raw_valid(bytea,bytea,text) from public;

create function brain.redact_message(message_id uuid, payload jsonb) returns integer
language plpgsql security definer set search_path = pg_catalog, brain as $$
declare m brain.messages%rowtype; n brain.tool_notes%rowtype; note jsonb; r jsonb;
  old_marker text := current_setting('brain.redacting', true);
  records jsonb; new_text text; raw bytea; removed integer := 0; redaction_session_key text;
begin
  select sess.harness || ':' || sess.harness_session_id into strict redaction_session_key
    from brain.messages msg join brain.sessions sess on sess.id=msg.session_id where msg.id=message_id;
  perform pg_advisory_xact_lock(hashtextextended(redaction_session_key, 0));
  perform set_config('brain.redacting', 'on', true);
  select * into strict m from brain.messages where id = message_id for update;
  if exists(select from jsonb_array_elements(payload->'toolNotes') t
    group by (t->>'id')::uuid having count(*)>1) then
    raise exception 'redaction duplicate tool target: invariant refused';
  end if;
  records := coalesce(payload->'redactions', '[]'::jsonb);
  if exists(select from jsonb_array_elements(records) v where
    not ((v->>'messageId' = m.id::text and v->>'toolNoteId' is null)
      or (v->>'messageId' is null and exists(select from brain.tool_notes t where t.id::text=v->>'toolNoteId'
        and t.session_id=m.session_id and t.harness_message_id=m.harness_message_id
        and t.harness_message_id_raw is not distinct from m.harness_message_id_raw)))) then
    raise exception 'redaction target: invariant refused';
  end if;
  new_text := payload->>'body';
  raw := decode(payload->>'bodyRaw', 'hex');
  if new_text is distinct from brain.redacted_text(m.body,
    (select coalesce(jsonb_agg(v), '[]'::jsonb) from jsonb_array_elements(records) v where v->>'messageId'=m.id::text))
    or not brain.redaction_raw_valid(raw, m.body_raw, new_text) then
    raise exception 'redaction body: invariant refused';
  end if;
  if exists(select from jsonb_array_elements(records) v where v->>'messageId'=m.id::text) then
    update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
      where kind='table_cleanup' and target_kind='table'
      and target_id='messages' and completed_at is null;
    if not found then raise exception 'redaction cleanup messages: invariant refused'; end if;
    update brain.messages set body=new_text, body_raw=raw where id=m.id;
  end if;
  for note in select value from jsonb_array_elements(payload->'toolNotes') loop
    update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
      where kind='table_cleanup' and target_kind='table'
      and target_id='tool_notes' and completed_at is null;
    if not found then raise exception 'redaction cleanup tool_notes: invariant refused'; end if;
    select * into n from brain.tool_notes where id=(note->>'id')::uuid
      and session_id=m.session_id and harness_message_id=m.harness_message_id
      and harness_message_id_raw is not distinct from m.harness_message_id_raw for update;
    if not found then raise exception 'redaction tool target: invariant refused'; end if;
    new_text := note->>'target'; raw := decode(note->>'targetRaw', 'hex');
    if new_text is distinct from brain.redacted_text(n.target,
      (select coalesce(jsonb_agg(v), '[]'::jsonb) from jsonb_array_elements(records) v where v->>'toolNoteId'=n.id::text))
      or not brain.redaction_raw_valid(raw, n.target_raw, new_text) then
      raise exception 'redaction tool target: invariant refused';
    end if;
    update brain.tool_notes set target=new_text, target_raw=raw where id=n.id;
  end loop;
  if exists(select from jsonb_array_elements(records) v where v->>'toolNoteId' is not null
    and not exists(select from jsonb_array_elements(payload->'toolNotes') t where t->>'id'=v->>'toolNoteId')) then
    raise exception 'redaction missing tool target: invariant refused';
  end if;
  for r in select value from jsonb_array_elements(records) loop
    insert into brain.redactions(id,message_id,tool_note_id,file_id,start,"end",kind,content_hash,occurred_at,pattern_version)
      values ((r->>'id')::uuid,(r->>'messageId')::uuid,(r->>'toolNoteId')::uuid,null,
        (r->>'start')::integer,(r->>'end')::integer,r->>'kind',r->>'contentHash',
        (r->>'occurredAt')::timestamptz,r->>'patternVersion');
  end loop;
  if jsonb_array_length(records)>0 then
    update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
      where kind='table_cleanup' and target_kind='table'
      and target_id='chunks' and completed_at is null;
    if not found then raise exception 'redaction cleanup chunks: invariant refused'; end if;
    delete from brain.chunks where session_id=m.session_id and from_at<=m.occurred_at and to_at>=m.occurred_at;
    get diagnostics removed = row_count;
  end if;
  perform set_config('brain.redacting', coalesce(old_marker,''), true);
  return removed;
exception when others then
  perform set_config('brain.redacting', coalesce(old_marker,''), true);
  raise;
end $$;
revoke all on function brain.redact_message(uuid,jsonb) from public;
grant execute on function brain.redact_message(uuid,jsonb) to brain_app;

create function brain.redact_file(file_id uuid, record jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, brain as $$
declare old_marker text := current_setting('brain.redacting', true); f brain.files%rowtype; chunks integer; extractions integer; names integer; metadata integer;
begin
  perform set_config('brain.redacting', 'on', true);
  select * into strict f from brain.files where id=file_id for no key update;
  if f.redacted_at is not null then raise exception 'file already redacted: invariant refused'; end if;
  if record->>'fileId' is distinct from file_id::text
    or record->>'contentHash' is distinct from f.content_hash or record->>'messageId' is not null
    or record->>'toolNoteId' is not null then raise exception 'redaction file: invariant refused'; end if;
  update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
    where kind='table_cleanup' and target_kind='table'
    and target_id='document_chunks' and completed_at is null;
  if not found then raise exception 'redaction cleanup document_chunks: invariant refused'; end if;
  update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
    where kind='table_cleanup' and target_kind='table'
    and target_id='document_extractions' and completed_at is null;
  if not found then raise exception 'redaction cleanup document_extractions: invariant refused'; end if;
  update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
    where kind='table_cleanup' and target_kind='table'
    and target_id='file_names' and completed_at is null;
  if not found then raise exception 'redaction cleanup file_names: invariant refused'; end if;
  update brain.work_items set claimed_at=null, claim_expires_at=null, claimed_by=null
    where kind='table_cleanup' and target_kind='table'
    and target_id='file_metadata' and completed_at is null;
  if not found then raise exception 'redaction cleanup file_metadata: invariant refused'; end if;
  update brain.files set redacted_at=(record->>'occurredAt')::timestamptz,current_extraction_id=null where id=f.id;
  delete from brain.document_chunks where extraction_id in (select id from brain.document_extractions e where e.file_id=f.id);
  get diagnostics chunks = row_count;
  delete from brain.document_extractions e where e.file_id=f.id and finished_at is not null;
  get diagnostics extractions = row_count;
  delete from brain.file_names n where n.file_id=f.id;
  get diagnostics names = row_count;
  delete from brain.file_metadata m where m.file_id=f.id;
  get diagnostics metadata = row_count;
  insert into brain.redactions(id,message_id,tool_note_id,file_id,start,"end",kind,content_hash,occurred_at,pattern_version)
    values ((record->>'id')::uuid,null,null,f.id,null,null,record->>'kind',record->>'contentHash',
      (record->>'occurredAt')::timestamptz,record->>'patternVersion');
  perform set_config('brain.redacting', coalesce(old_marker,''), true);
  return jsonb_build_object('chunksRemoved',chunks,'extractionsRemoved',extractions,'namesRemoved',names,
    'metadataRemoved',metadata,'failuresResolved',0);
exception when others then
  perform set_config('brain.redacting', coalesce(old_marker,''), true);
  raise;
end $$;
revoke all on function brain.redact_file(uuid,jsonb) from public;
grant execute on function brain.redact_file(uuid,jsonb) to brain_app;

grant maintain on brain.messages, brain.tool_notes, brain.chunks, brain.document_chunks,
  brain.document_extractions, brain.file_names, brain.file_metadata to brain_maintenance;

create function brain.settings_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if new.key is distinct from old.key then raise exception 'settings_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger settings_immutable_update before update on brain.settings for each row execute function brain.settings_immutable_update_fn();
create function brain.settings_immutable_delete_fn() returns trigger language plpgsql as $$
begin
  raise exception 'settings_immutable_delete: invariant refused';
end $$;
create trigger settings_immutable_delete before delete on brain.settings for each row execute function brain.settings_immutable_delete_fn();
