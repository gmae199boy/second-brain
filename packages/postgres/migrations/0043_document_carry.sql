-- A completed byte classification, never a lease or pending owner.
create table brain.document_carry_checks (
  file_id uuid not null references brain.files(id),
  extractor_version text not null,
  primary key (file_id, extractor_version)
);
-- A queued extraction's version is recorded before it can be joined.
create table brain.document_carry_work_versions (
  work_id uuid primary key references brain.work_items(id),
  extractor_version text not null,
  pinned boolean not null
);
create table brain.source_carry_checks (
  source_file_id uuid not null references brain.source_files(id),
  remote_version text not null,
  extractor_version text not null,
  requires_handoff boolean not null,
  primary key (source_file_id, remote_version, extractor_version)
);
create table brain.source_carry_runs (
  source_id uuid not null references brain.sources(id),
  generation integer not null check (generation > 0),
  extractor_version text not null,
  work_id uuid not null references brain.work_items(id),
  completed boolean not null,
  started boolean not null,
  check (not completed or started),
  primary key (source_id, generation, extractor_version)
);
grant select, insert, update on brain.document_carry_checks, brain.document_carry_work_versions, brain.source_carry_checks, brain.source_carry_runs to brain_app;
revoke delete on brain.document_carry_checks, brain.document_carry_work_versions, brain.source_carry_checks, brain.source_carry_runs from brain_app;
