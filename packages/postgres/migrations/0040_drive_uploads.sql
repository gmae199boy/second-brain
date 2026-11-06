-- Core 0040: Brain-owned Drive identity, retention and resumable intent.
-- 예약 ID는 원격 I/O 전에 확정하며 root/hash별 최초 ID만 보존한다.
create table brain.drive_uploads (
  root_folder_id text not null check (root_folder_id <> ''),
  content_hash text not null check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  remote_id text not null check (remote_id <> ''),
  state text not null check (state in ('reserved', 'submitting', 'uploaded', 'cancelled')),
  submission_id uuid,
  completed_at timestamptz,
  check ((state in ('submitting','uploaded')) = (submission_id is not null)),
  check ((state = 'uploaded') = (completed_at is not null)),
  created_at timestamptz not null,
  primary key (root_folder_id, content_hash),
  unique (remote_id)
);
-- Store save는 INSERT ON CONFLICT DO NOTHING 후 기존 행을 읽는다.
-- 제출 토큰이 일치할 때만 submitting → uploaded로 전진하며 ID와 이력은 불변이다.
-- verified_at 및 이전 확정은 별도 동일 withWrite 트랜잭션에서 처리한다.

-- Identity is immutable; reserved → submitting → uploaded or reserved → cancelled.
create function brain.drive_uploads_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'drive_uploads cannot be deleted'; end if;
  if tg_op = 'INSERT' then
    if new.state <> 'reserved' then raise exception 'drive_uploads must begin reserved'; end if;
    return new;
  end if;
  if new.root_folder_id is distinct from old.root_folder_id
     or new.content_hash is distinct from old.content_hash
     or new.remote_id is distinct from old.remote_id
     or new.created_at is distinct from old.created_at
     or (new.completed_at is distinct from old.completed_at and not (old.state='submitting' and new.state='uploaded' and old.completed_at is null and new.completed_at is not null))
     or (new.submission_id is distinct from old.submission_id and not (old.state='reserved' and new.state='submitting' and old.submission_id is null and new.submission_id is not null))
     or (new.state is distinct from old.state and not ((old.state = 'reserved' and new.state in ('submitting','cancelled')) or (old.state = 'submitting' and new.state = 'uploaded')))
  then raise exception 'drive_uploads identity or state change refused'; end if;
  return new;
end $$;
create trigger drive_uploads_guard before insert or update or delete on brain.drive_uploads
for each row execute function brain.drive_uploads_guard();

-- A retention job remains bound to the exact verified Drive home and root.
create table brain.drive_retention (
  local_location_id uuid primary key references brain.file_locations(id),
  drive_location_id uuid not null references brain.file_locations(id),
  root_folder_id text not null,
  content_hash text not null,
  verified_at timestamptz not null,
  due_at timestamptz not null check (due_at >= verified_at),
  foreign key (root_folder_id, content_hash) references brain.drive_uploads(root_folder_id, content_hash)
);
grant select, insert, update on brain.drive_uploads to brain_app;
grant select, insert on brain.drive_retention to brain_app;

-- The intent and its queue item are committed before any remote create call.
create table brain.drive_migration_intents (
  file_id uuid primary key references brain.files(id),
  root_folder_id text not null,
  content_hash text not null,
  expected_home_id uuid not null references brain.file_locations(id),
  location_id uuid not null references brain.file_locations(id),
  locator text not null,
  created_at timestamptz not null
);
grant select, insert on brain.drive_migration_intents to brain_app;

-- A Drive location belongs to exactly one root; locator remains content-derived.
create table brain.drive_location_roots (
  location_id uuid primary key references brain.file_locations(id),
  root_folder_id text not null,
  content_hash text not null
);
revoke update, delete on brain.drive_location_roots from brain_app;
grant select, insert on brain.drive_location_roots to brain_app;
alter table brain.drive_migration_intents add column state text not null check (state in ('active','stale','committed'));
revoke update, delete on brain.drive_migration_intents from brain_app;
grant update (expected_home_id, state) on brain.drive_migration_intents to brain_app;

-- Only the verification transaction can fill upload metadata exactly once.
create or replace function brain.file_locations_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if not (new.id is not distinct from old.id and new.file_id is not distinct from old.file_id
    and new.store_kind is not distinct from old.store_kind and new.locator is not distinct from old.locator
    and new.ownership is not distinct from old.ownership and new.first_seen_at is not distinct from old.first_seen_at
    and new.source_modified_at is not distinct from old.source_modified_at
    and (new.uploaded_at is not distinct from old.uploaded_at or (old.uploaded_at is null and new.uploaded_at is not null and old.verified_at is null and new.verified_at is not null and old.store_kind='drive'))
    and (new.remote_checksum is not distinct from old.remote_checksum or (old.remote_checksum is null and new.remote_checksum is not null and old.verified_at is null and new.verified_at is not null and old.store_kind='drive'))
    and (new.verified_at is not distinct from old.verified_at or (old.verified_at is null and new.verified_at is not null))
    and (new.deleted_at is not distinct from old.deleted_at or (old.deleted_at is null and new.deleted_at is not null)))
  then raise exception 'file_locations_immutable_update: invariant refused'; end if;
  return new;
end $$;
