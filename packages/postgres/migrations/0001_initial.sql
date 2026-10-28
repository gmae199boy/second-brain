-- Core collection baseline. Setup creates brain and its migration ledger.
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
  cursor_fingerprint text,
  parser_version text,
  ingested_at timestamptz,
  start_source text,
  continued_from_session_id uuid references brain.sessions (id), tag_source text, first_cwd text,
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
  role text not null,
  model text,
  body text not null,
  occurred_at timestamptz not null,
  git_branch text,
  is_subagent_report integer not null default 0,
  unique (session_id, harness_message_id),
  constraint messages_role_check check (role in ('user', 'assistant')),
  constraint messages_is_subagent_report_check check (is_subagent_report in (0, 1))
);

create table brain.tool_notes (
  id uuid primary key,
  session_id uuid not null references brain.sessions (id),
  harness_message_id text not null,
  ordinal integer not null,
  tool text not null,
  target text not null,
  ok integer not null, call_id text,
  unique (session_id, harness_message_id, ordinal),
  constraint tool_notes_ok_check check (ok in (0, 1))
);

create table brain.transcript_files (
  id uuid primary key,
  harness text not null,
  path text not null,
  size_bytes integer not null,
  fingerprint text not null,
  last_harness_message_id text,
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
  display_name text,
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
create unique index tool_notes_call_id_idx on brain.tool_notes(session_id, call_id) where call_id is not null;
create unique index work_items_open_key_idx on brain.work_items(kind, target_kind, target_id) where completed_at is null;
create index work_items_due_idx on brain.work_items(attempts, id, next_attempt_at) where completed_at is null;
create index messages_session_occurred_idx on brain.messages(session_id, occurred_at);
create index tool_notes_target_idx on brain.tool_notes using gin (lower(target) public.gin_trgm_ops);

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
            and new.id is not distinct from old.id
            and new.session_id is not distinct from old.session_id
            and new.harness_message_id is not distinct from old.harness_message_id
            and new.ordinal is not distinct from old.ordinal
            and new.tool is not distinct from old.tool
            and new.ok is not distinct from old.ok
            and new.call_id is not distinct from old.call_id)), true) then raise exception 'tool_notes_immutable_update: invariant refused'; end if;
  return new;
end $$;
create trigger tool_notes_immutable_update before update on brain.tool_notes for each row execute function brain.tool_notes_immutable_update_fn();

create function brain.messages_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if coalesce((not (current_setting('brain.redacting', true) = 'on'
            and new.id is not distinct from old.id
            and new.session_id is not distinct from old.session_id
            and new.harness_message_id is not distinct from old.harness_message_id
            and new.role is not distinct from old.role
            and new.model is not distinct from old.model
            and new.occurred_at is not distinct from old.occurred_at
            and new.git_branch is not distinct from old.git_branch
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
  or (old.first_cwd is not null and new.first_cwd is distinct from old.first_cwd)), true) then raise exception 'sessions_tag_evidence_update: invariant refused'; end if;
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
    or new.display_name is distinct from old.display_name
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
grant update (home_location_id, source_unreachable_at) on brain.files to brain_app;
revoke insert on brain.files from brain_app;
grant insert (id, content_hash, size_bytes, first_seen_at) on brain.files to brain_app;
