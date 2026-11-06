create table brain.sources (
  id uuid primary key, kind text not null, account text not null, root_id text not null,
  generation integer not null check (generation > 0), cursor text,
  scan_id uuid, scan_token text, unique (kind, account)
);
create table brain.source_files (
  id uuid primary key, source_id uuid not null references brain.sources(id), remote_id text not null,
  name text not null, path text not null, mime_type text not null, remote_version text not null,
  size_bytes bigint check (size_bytes >= 0), file_id uuid references brain.files(id),
  index_status text not null check (index_status in ('pending','indexed','photo','too_large','unsupported','failed')),
  unreachable boolean not null, unreachable_at timestamptz, completed_version text, completed_hash text, seen_scan uuid,
  unique(source_id,remote_id), check (unreachable = (unreachable_at is not null)), check ((completed_version is null) = (completed_hash is null))
);
create table brain.source_handoffs (
  source_file_id uuid primary key references brain.source_files(id), file_id uuid not null references brain.files(id),
  remote_version text not null, content_hash text not null, source_generation integer not null, work_id uuid not null references brain.work_items(id)
);
create table brain.source_attempts (
  temp_key text primary key, source_file_id uuid not null references brain.source_files(id),
  file_id uuid not null references brain.files(id), remote_version text not null,
  work_id uuid not null references brain.work_items(id), extraction_id uuid,
  claimed_by text, claimed_at timestamptz, attempts integer
);
-- A publication is tied to the work that made the current extraction.  The
-- extraction id is deliberately not a foreign key: later generations remove
-- old extractions, and the current pointer is rechecked before reuse.
create table brain.source_work_publications (
  work_id uuid primary key references brain.work_items(id), file_id uuid not null references brain.files(id),
  content_hash text not null, extraction_id uuid not null
);
create table brain.source_staged_bytes (
  temp_key text primary key, source_file_id uuid not null references brain.source_files(id),
  source_generation integer not null, remote_version text not null, content_hash text not null,
  owner_work_id uuid not null references brain.work_items(id), owner_claimed_by text not null,
  owner_claimed_at timestamptz not null, owner_attempts integer not null,
  ready boolean not null, file_id uuid references brain.files(id), work_id uuid references brain.work_items(id),
  check ((not ready and file_id is null and work_id is null) or (ready and file_id is not null and work_id is not null))
);
create index source_files_file_id_idx on brain.source_files(file_id);
create index source_handoffs_file_id_idx on brain.source_handoffs(file_id);
create index source_staged_bytes_handoff_idx on brain.source_staged_bytes(source_file_id,work_id) where ready;
create index source_files_name_trgm_idx on brain.source_files using gin (lower(name) public.gin_trgm_ops);
create index source_files_path_trgm_idx on brain.source_files using gin (lower(path) public.gin_trgm_ops);
grant select, insert, update on brain.sources, brain.source_files, brain.source_handoffs, brain.source_attempts, brain.source_work_publications, brain.source_staged_bytes to brain_app;

-- Setup grants DELETE by default; source state is retained and fenced.
revoke delete on brain.sources, brain.source_files, brain.source_handoffs, brain.source_attempts, brain.source_work_publications, brain.source_staged_bytes from brain_app;
