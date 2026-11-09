-- Resumable state belongs to the immutable root/hash/remote identity.
alter table brain.drive_uploads add column session_uri text;
alter table brain.drive_uploads add column deleted_at timestamptz;
alter table brain.drive_uploads add column delete_intent_at timestamptz;
alter table brain.drive_uploads add column delete_submitted_at timestamptz;
alter table brain.drive_uploads add column delete_source_id uuid;
alter table brain.drive_uploads add column delete_generation integer;
alter table brain.drive_uploads add column delete_account text;
alter table brain.drive_uploads add constraint drive_delete_source_fence check ((delete_source_id is null and delete_generation is null and delete_account is null) or (delete_source_id is not null and delete_generation > 0 and delete_account is not null and delete_intent_at is not null));
alter table brain.drive_uploads add constraint drive_upload_delete_intent_state check ((delete_intent_at is null and delete_submitted_at is null and deleted_at is null) or (state='uploaded' and delete_intent_at is not null and (deleted_at is null or delete_submitted_at is not null)));
alter table brain.drive_uploads add constraint drive_upload_deleted_state check (deleted_at is null or state='uploaded');
alter table brain.drive_uploads add column confirmed_offset bigint not null default 0 check (confirmed_offset >= 0);
alter table brain.drive_uploads add constraint drive_upload_session_state check (session_uri is null or (session_uri <> '' and state in ('submitting','uploaded')));
alter table brain.drive_uploads add constraint drive_upload_offset_session check (confirmed_offset = 0 or session_uri is not null);
create or replace function brain.drive_uploads_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'drive_uploads cannot be deleted'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'reserved' or new.session_uri is not null or new.confirmed_offset <> 0 or new.deleted_at is not null or new.delete_intent_at is not null or new.delete_submitted_at is not null or new.delete_source_id is not null or new.delete_generation is not null or new.delete_account is not null then raise exception 'drive_uploads must begin reserved'; end if;
    return new;
  end if;
  if new.root_folder_id is distinct from old.root_folder_id or new.content_hash is distinct from old.content_hash
     or new.remote_id is distinct from old.remote_id or new.created_at is distinct from old.created_at
     or ((new.delete_source_id is distinct from old.delete_source_id or new.delete_generation is distinct from old.delete_generation or new.delete_account is distinct from old.delete_account) and not (old.delete_intent_at is null and new.delete_intent_at is not null and old.state='uploaded' and new.state='uploaded'))
     or (new.delete_intent_at is distinct from old.delete_intent_at and not (old.state='uploaded' and new.state='uploaded' and old.delete_intent_at is null and new.delete_intent_at is not null))
     or (new.delete_submitted_at is distinct from old.delete_submitted_at and not (old.state='uploaded' and new.state='uploaded' and old.delete_intent_at is not null and old.delete_submitted_at is null and new.delete_submitted_at is not null))
     or (new.deleted_at is distinct from old.deleted_at and not (old.state='uploaded' and new.state='uploaded' and old.deleted_at is null and new.deleted_at is not null))
     or (new.completed_at is distinct from old.completed_at and not (old.state='submitting' and new.state='uploaded' and old.completed_at is null and new.completed_at is not null))
     or (new.submission_id is distinct from old.submission_id and not (old.state='reserved' and new.state='submitting' and old.submission_id is null and new.submission_id is not null))
     or (new.state is distinct from old.state and not ((old.state='reserved' and new.state in ('submitting','cancelled')) or (old.state='submitting' and new.state='uploaded')))
     or ((new.session_uri is distinct from old.session_uri or new.confirmed_offset is distinct from old.confirmed_offset) and (old.state <> 'submitting' or new.state <> 'submitting'))
     or (new.session_uri is not distinct from old.session_uri and new.confirmed_offset < old.confirmed_offset)
     or (new.session_uri is distinct from old.session_uri and new.confirmed_offset <> 0)
  then raise exception 'drive_uploads identity or state change refused'; end if;
  return new;
end $$;
-- Setup's default table privileges are broader than the 0040 grant. Preserve
-- retention identity and allow only the recalculated due column to change.
revoke update, delete on brain.drive_retention from brain_app;
grant update (due_at) on brain.drive_retention to brain_app;

-- A consumed changes page owns durable follow-up until a handoff or terminal
-- classification is recorded. Historical rows also fence replay across crashes.
create table brain.source_change_tasks (
  source_file_id uuid not null references brain.source_files(id),
  source_generation integer not null check (source_generation > 0),
  remote_version text not null,
  work_id uuid not null references brain.work_items(id),
  resolved boolean not null default false,
  primary key (source_file_id, source_generation, remote_version)
);
grant select, insert, update on brain.source_change_tasks to brain_app;
revoke delete on brain.source_change_tasks from brain_app;

-- The cursor belongs to the connection generation and the last complete scan.
alter table brain.sources add column cursor_generation integer;
alter table brain.sources add column last_full_scan_at timestamptz;

-- Cursor-scoped evidence that a structural node was outside the watched roots.
create table brain.source_outside_nodes (
  source_id uuid not null references brain.sources(id),
  source_generation integer not null,
  remote_id text not null,
  primary key(source_id,source_generation,remote_id)
);
grant select,insert,delete on brain.source_outside_nodes to brain_app;
