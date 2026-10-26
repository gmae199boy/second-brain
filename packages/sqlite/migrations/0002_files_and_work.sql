-- The second migration of the source of truth: the rest of the Table Contract
-- -- the one queue of AD-21 and the seven tables files and their text live in
-- (AD-23, AD-24) -- together with their idempotency keys, the change rules of
-- AD-11 for `files` and `file_locations`, and the two keyword indexes AD-15
-- wants over document text and file names.
--
-- It only adds. `0001_initial.sql` is not touched and never will be:
-- migrations go forward only (Conventions), and a file that has been applied on
-- somebody's machine cannot be edited into a different schema.
--
-- The spelling rules are 0001's, and for the same reasons: every ordinary table
-- is `STRICT`, ids are `text` holding a UUIDv7 (AD-8), instants are `text` in
-- the one canonical 24-character spelling pinned by a `glob` check (AD-13),
-- booleans would be `integer check (x in (0, 1))`, and a searched column gets
-- an external-content FTS5 table with a `search_rowid integer primary key` to
-- anchor it, `secure-delete` turned on and triggers that keep it in step.
--
-- Postgres is a replica of this schema (AD-22) and does not have these tables
-- yet; it follows in epic 7, which is where the `tool_notes` redaction of 0001
-- is waiting too. This side is the source and goes first.
--
-- Nothing here does anything on its own. Claiming and draining work items,
-- the `FileStore` port, attachment collection, extraction and the `files.redact`
-- chain are all behaviour, and behaviour arrives with epics 2 and 4. This is
-- the shape those epics write into.

-- The one queue (AD-21). Every kind of deferred work -- chunking, mirror
-- writes, extraction, orphan sweeps -- is a row here rather than a table of its
-- own, because a second queue means a second claim window and a second retry
-- schedule that disagree with the first.
--
-- `kind` and `target_kind` have no `check`: they are Core constants that grow
-- with every drain job, and a `check` listing them would mean a migration for
-- each new kind of work. The three claim columns are one fact -- who holds this
-- row until when -- so they are set together or not at all, the same shape the
-- parser cursor on `sessions` uses.
--
-- `failures` is a record and not a queue (AD-21), which is why it has no claim
-- columns and this table does.
create table work_items (
  id text primary key,
  kind text not null,
  target_kind text not null,
  target_id text not null,
  created_at text not null,
  attempts integer not null default 0,
  next_attempt_at text not null,
  claimed_at text,
  claim_expires_at text,
  claimed_by text,
  last_error text,
  completed_at text,
  constraint work_items_attempts_check check (attempts >= 0),
  constraint work_items_claim_check
    check ((claimed_at is null) = (claim_expires_at is null)
           and (claimed_at is null) = (claimed_by is null)),
  constraint work_items_created_at_check
    check (created_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint work_items_next_attempt_at_check
    check (next_attempt_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint work_items_claimed_at_check
    check (claimed_at is null
           or claimed_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint work_items_claim_expires_at_check
    check (claim_expires_at is null
           or claim_expires_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint work_items_completed_at_check
    check (completed_at is null
           or completed_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- "One open item per piece of work", as a partial index (AD-21, Table
-- Contract). Partial and not plain, because the uniqueness is only over the
-- rows still to be done: the same session gets chunked again after an edit, and
-- a plain unique key would mean the second request is refused for good by the
-- first one's completed row. Completed rows may also be swept, and a key that
-- counted them would change meaning the day they are.
create unique index work_items_open_key_idx
  on work_items (kind, target_kind, target_id) where completed_at is null;

-- What drain asks for: the earliest unfinished item that is due. Partial on the
-- same condition, so the index holds the backlog and not the history.
create index work_items_due_idx
  on work_items (next_attempt_at) where completed_at is null;

-- A file's content (AD-23). The content is the identity -- `content_hash` is
-- the idempotency key, so putting the same bytes in twice is one row -- and
-- where those bytes sit is `file_locations`, because a user's file moving is
-- not the content changing.
--
-- `home_location_id` and `current_extraction_id` are the two pointers the rest
-- of the system reads: the `brain`-owned copy this row calls its own, and the
-- one extraction generation search uses (AD-24). They point forward, at tables
-- created further down this file; SQLite resolves a foreign key by name when a
-- row is written, not when the table is declared, so the cycle between `files`
-- and `file_locations` is declarable here and holds at write time.
--
-- There is no media type on this row. What a file *is* was decided by reading
-- its bytes with one version of one library, which makes it a property of that
-- reading and not of the content: it lives on `document_extractions`, with the
-- `extractor_version` that produced it (AD-24).
create table files (
  id text primary key,
  content_hash text not null unique,
  size_bytes integer not null,
  first_seen_at text not null,
  home_location_id text references file_locations (id),
  current_extraction_id text references document_extractions (id),
  redacted_at text,
  -- `sha256:` and 64 lower-case hex digits, spelled out (AD-23). GLOB is case
  -- sensitive, which is what keeps one set of bytes from arriving under two
  -- hashes that differ only in case.
  constraint files_content_hash_check
    check (content_hash glob 'sha256:'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
             || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  constraint files_size_bytes_check check (size_bytes >= 0),
  constraint files_first_seen_at_check
    check (first_seen_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint files_redacted_at_check
    check (redacted_at is null
           or redacted_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Where one content sits, once per place (AD-23). The same bytes being both a
-- Brain copy and the user's own file is the normal case, not a conflict: one
-- `files` row, two locations.
--
-- Ownership is a property of the place and not of the content, which is the
-- whole reason this table exists: the `FileStore` port writes and deletes only
-- where `ownership = 'brain'` inside the configured root, so a user's file
-- cannot be moved or removed by anything here.
--
-- `locator` is relative, never absolute: a path under the files root for
-- `local`, a file id for `drive`. Absolute paths and URLs are built from it
-- when they are needed, so moving the root is a configuration change and not a
-- rewrite of this table.
create table file_locations (
  id text primary key,
  file_id text not null references files (id),
  store_kind text not null,
  locator text not null,
  ownership text not null,
  first_seen_at text not null,
  source_modified_at text,
  uploaded_at text,
  remote_checksum text,
  verified_at text,
  deleted_at text,
  unique (file_id, store_kind, locator),
  constraint file_locations_store_kind_check check (store_kind in ('local', 'drive')),
  constraint file_locations_ownership_check check (ownership in ('brain', 'external')),
  constraint file_locations_first_seen_at_check
    check (first_seen_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint file_locations_source_modified_at_check
    check (source_modified_at is null
           or source_modified_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint file_locations_uploaded_at_check
    check (uploaded_at is null
           or uploaded_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint file_locations_verified_at_check
    check (verified_at is null
           or verified_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint file_locations_deleted_at_check
    check (deleted_at is null
           or deleted_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- An attachment's place in a message (AD-23). The parser writes the place and
-- where it came from -- that much it can read from the transcript -- and
-- collection fills `file_id` and `status` once, after the bytes are in the
-- store (AD-7: the blob is written outside the write transaction).
--
-- `source_kind` has no `check`: it is whatever the harness called the thing,
-- and a parser that meets a new word should record it rather than fail. The
-- two statuses are ours, so those are checked.
--
-- Both columns null is the state between the parser's write and collection's,
-- and is allowed. What is not allowed is the pair disagreeing: content is
-- exactly what `stored` means, so `stored` with no content is refused, and so
-- is content under any other status -- `missing_at_ingest`, or no status at
-- all.
create table message_attachments (
  id text primary key,
  message_id text not null references messages (id),
  ordinal integer not null,
  source_kind text not null,
  source_ref text,
  display_name text,
  file_id text references files (id),
  status text,
  unique (message_id, ordinal),
  constraint message_attachments_ordinal_check check (ordinal >= 0),
  constraint message_attachments_status_check
    check (status is null or status in ('stored', 'missing_at_ingest')),
  constraint message_attachments_file_check
    check ((file_id is not null) = (status is 'stored'))
) strict;

-- One reading of one file by one version of the extractor (AD-24). Text is a
-- derivative with generations, not a column on the file: a better extractor
-- makes a new row, and `files.current_extraction_id` is switched over to it in
-- the same transaction that deletes the old one's chunks. A failed re-read
-- leaves the pointer where it was, so search keeps answering from the last
-- generation that worked.
--
-- `status` and `finished_at` are one fact -- how this reading ended -- so they
-- are both null while it runs and both set once it stops. `media_type` is what
-- reading the bytes said the file was, which is why it is here and not on
-- `files`.
--
-- These rows and their chunks are in `admin.export` and come back on restore,
-- because the bytes they were made from live outside the database and may be
-- unreachable by then (AD-24).
create table document_extractions (
  id text primary key,
  file_id text not null references files (id),
  extractor_version text not null,
  media_type text,
  status text,
  started_at text not null,
  finished_at text,
  error text,
  constraint document_extractions_status_check
    check (status is null
           or status in ('ok', 'failed', 'unsupported', 'too_large', 'redacted')),
  constraint document_extractions_finished_check
    check ((finished_at is null) = (status is null)),
  constraint document_extractions_started_at_check
    check (started_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  constraint document_extractions_finished_at_check
    check (finished_at is null
           or finished_at glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- "One generation of this version at a time", as a partial index (AD-24, Table
-- Contract). Partial on `finished_at is null`, because the key is about work in
-- flight: two drain workers must not read the same file with the same extractor
-- at once, while the finished generations of that version are history and may
-- sit side by side.
create unique index document_extractions_open_idx
  on document_extractions (file_id, extractor_version) where finished_at is null;

-- The text of one generation, in pieces (AD-24). `page` is where the piece came
-- from when the format has such a thing, and null when it does not.
--
-- `search_rowid` is this table's rowid under a name, because `body` is searched
-- and an external-content FTS5 index finds its rows by rowid; see `tool_notes`
-- in 0001 for why an implicit rowid will not do.
create table document_chunks (
  search_rowid integer primary key,
  id text not null unique,
  extraction_id text not null references document_extractions (id),
  ordinal integer not null,
  page integer,
  body text not null,
  unique (extraction_id, ordinal)
) strict;

-- The names a file has been seen under (AD-24): the path of each location and
-- the display name of each attachment, collected so that searching for a file
-- by its name is the same keyword search as searching for its text. Derived,
-- and rebuildable from the rows it was gathered from.
--
-- `text` is a reserved word here as well, hence the quotes; `search_rowid` is
-- the FTS5 anchor, as on `document_chunks`.
create table file_names (
  search_rowid integer primary key,
  id text not null unique,
  file_id text not null references files (id),
  name_source text not null,
  "text" text not null,
  unique (file_id, name_source, "text"),
  constraint file_names_name_source_check
    check (name_source in ('location_path', 'attachment_name'))
) strict;

-- What the bytes said about themselves, EXIF above all (AD-24). One row per
-- key, because the keys an image carries are not known in advance and a column
-- per key would be a migration per camera.
--
-- EXIF is untrusted input. A capture time in it has no timezone, so AD-24 keeps
-- three keys apart: `captured_at_local` is the original text exactly as it was
-- found, `captured_at_source` says where it came from, and `captured_at` exists
-- only when the zone is actually known -- which is why it, and only it, is held
-- to the canonical instant spelling of AD-13.
create table file_metadata (
  id text primary key,
  file_id text not null references files (id),
  key text not null,
  value text not null,
  unique (file_id, key),
  constraint file_metadata_captured_at_check
    check (key <> 'captured_at'
           or value glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) strict;

-- Immutability for files (AD-11, AD-23). The same instrument as 0001's: a
-- `before` trigger whose `when` clause lists every column that may not move,
-- compared with `is` and not `=` so a null column is checked like any other.
-- The scope is the same too -- these stop a coding mistake, not deliberate SQL
-- -- and it is deliberately narrow: only `files` and `file_locations` get these
-- triggers, because only they hold a fact about the user's own bytes that
-- nothing may rewrite. The derived tables around them (`document_extractions`,
-- `document_chunks`, `file_names`, `file_metadata`, and the queue) are rewritten
-- by generation changes and sweeps as a matter of course.
--
-- `files` is content, so content cannot change: a row whose `content_hash` or
-- `size_bytes` moved is a different file and belongs in a different row. The
-- two pointers are free, because switching the home copy or the current
-- extraction generation is exactly what AD-23 and AD-24 have the owning code
-- do. `redacted_at` is the second exception to original-text immutability
-- (`files.redact`, AD-23): under a raised marker it may go from null to a value
-- once, and never back or on to another value. What the marker does not buy is
-- the four content columns: `id`, `content_hash`, `size_bytes` and
-- `first_seen_at` are refused whether or not a redaction is in progress, which
-- is what keeps one from carrying a rewrite in with it. The two pointers stay
-- free either way -- `files.redact` moves them itself, clearing the current
-- generation as it deletes it.
create trigger files_immutable_update
  before update on files
  when not (new.id is old.id
            and new.content_hash is old.content_hash
            and new.size_bytes is old.size_bytes
            and new.first_seen_at is old.first_seen_at
            and (new.redacted_at is old.redacted_at
                 or (brain_redact_allowed() = 1
                     and old.redacted_at is null
                     and new.redacted_at is not null)))
begin
  select raise(abort,
    'files is immutable: only home_location_id and current_extraction_id may be updated, and redacted_at once while a redaction is in progress');
end;

create trigger files_immutable_delete
  before delete on files
begin
  select raise(abort, 'files is immutable: delete is refused');
end;

-- The home copy is one of *this* file's `brain` locations. A pointer at
-- somebody else's location, or at a location the user owns, would hand the
-- `FileStore` port a target outside what it is allowed to write (AD-23), and
-- the port would be the only thing noticing.
create trigger files_home_check
  before update of home_location_id on files
  when new.home_location_id is not null
       and not exists (select 1 from file_locations
                        where id = new.home_location_id
                          and file_id = new.id
                          and ownership = 'brain')
begin
  select raise(abort, 'files.home_location_id must be a brain-owned location of the same file');
end;

-- The same at insert time. A `before update of` trigger does not see a row
-- arriving with the pointer already set, and the cycle between the two tables
-- means a caller may well write `files` after its locations exist.
create trigger files_home_check_insert
  before insert on files
  when new.home_location_id is not null
       and not exists (select 1 from file_locations
                        where id = new.home_location_id
                          and file_id = new.id
                          and ownership = 'brain')
begin
  select raise(abort, 'files.home_location_id must be a brain-owned location of the same file');
end;

-- The same for the generation search reads: one of this file's own (AD-24). A
-- pointer at another file's extraction would show one file's text under
-- another's name.
create trigger files_extraction_check
  before update of current_extraction_id on files
  when new.current_extraction_id is not null
       and not exists (select 1 from document_extractions
                        where id = new.current_extraction_id
                          and file_id = new.id)
begin
  select raise(abort, 'files.current_extraction_id must be an extraction of the same file');
end;

-- And the same at insert time; see `files_home_check_insert`.
create trigger files_extraction_check_insert
  before insert on files
  when new.current_extraction_id is not null
       and not exists (select 1 from document_extractions
                        where id = new.current_extraction_id
                          and file_id = new.id)
begin
  select raise(abort, 'files.current_extraction_id must be an extraction of the same file');
end;

-- A location is a place, and a place does not become another place: the store,
-- the locator and -- above all -- the ownership are fixed when the row is
-- written (AD-23, Table Contract). An `ownership` that could be edited would
-- turn a user's own file into something the `FileStore` port may delete.
--
-- `verified_at` and `deleted_at` are what the move path fills in, in that
-- order: the copy is checked, then the old place is marked gone. Each is a
-- one-way fill, the same shape as `files.redacted_at`: null to a value, once.
-- A verification that could be withdrawn, or a deletion that could be
-- un-recorded, would let the move path delete the last copy of something it had
-- already said was gone. Delete of the row is refused outright, because it is
-- the record that the bytes were once there, and the orphan sweep needs it to
-- tell a stray blob from a known one.
create trigger file_locations_immutable_update
  before update on file_locations
  when not (new.id is old.id
            and new.file_id is old.file_id
            and new.store_kind is old.store_kind
            and new.locator is old.locator
            and new.ownership is old.ownership
            and new.first_seen_at is old.first_seen_at
            and new.source_modified_at is old.source_modified_at
            and new.uploaded_at is old.uploaded_at
            and new.remote_checksum is old.remote_checksum
            and (new.verified_at is old.verified_at
                 or (old.verified_at is null and new.verified_at is not null))
            and (new.deleted_at is old.deleted_at
                 or (old.deleted_at is null and new.deleted_at is not null)))
begin
  select raise(abort,
    'file_locations is immutable: verified_at and deleted_at may each be filled in once, and nothing else may change');
end;

create trigger file_locations_immutable_delete
  before delete on file_locations
begin
  select raise(abort, 'file_locations is immutable: delete is refused');
end;

-- Document text and file names are keyword-searched like everything else
-- (AD-15, AD-24), so they get the same instrument as 0001's three columns:
-- external content, the `trigram` tokenizer for languages that do not put
-- spaces between words, `secure-delete` so a removal overwrites instead of
-- leaving a tombstone with the old trigrams in it, and triggers that mirror
-- every write in the same transaction.
--
-- Both tables are written and rewritten freely -- a new extraction generation
-- replaces its predecessor's chunks, a redaction deletes them -- so unlike
-- `tool_notes_fts` these need the delete trigger as well as the update one.
create virtual table document_chunks_fts using fts5(
  body, content='document_chunks', content_rowid='search_rowid', tokenize='trigram');
-- See `chunks_fts` in 0001: a tombstone is not a removal, and for a redaction
-- that is the difference between the text being gone and still being on disk.
insert into document_chunks_fts(document_chunks_fts, rank) values ('secure-delete', 1);

create trigger document_chunks_fts_ai after insert on document_chunks begin
  insert into document_chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

create trigger document_chunks_fts_ad after delete on document_chunks begin
  insert into document_chunks_fts(document_chunks_fts, rowid, body)
       values ('delete', old.search_rowid, old.body);
end;

create trigger document_chunks_fts_au after update of body on document_chunks begin
  insert into document_chunks_fts(document_chunks_fts, rowid, body)
       values ('delete', old.search_rowid, old.body);
  insert into document_chunks_fts(rowid, body) values (new.search_rowid, new.body);
end;

create virtual table file_names_fts using fts5(
  "text", content='file_names', content_rowid='search_rowid', tokenize='trigram');
-- See `chunks_fts` in 0001.
insert into file_names_fts(file_names_fts, rank) values ('secure-delete', 1);

create trigger file_names_fts_ai after insert on file_names begin
  insert into file_names_fts(rowid, "text") values (new.search_rowid, new."text");
end;

create trigger file_names_fts_ad after delete on file_names begin
  insert into file_names_fts(file_names_fts, rowid, "text")
       values ('delete', old.search_rowid, old."text");
end;

create trigger file_names_fts_au after update of "text" on file_names begin
  insert into file_names_fts(file_names_fts, rowid, "text")
       values ('delete', old.search_rowid, old."text");
  insert into file_names_fts(rowid, "text") values (new.search_rowid, new."text");
end;

-- Document chunking is a third kind of index generation, so `index_configs`
-- needs a third `kind` -- and SQLite cannot alter a `check`. The table is
-- therefore stashed, dropped and rebuilt, all inside the one transaction the
-- migration runner already holds (`BEGIN IMMEDIATE` in `withWrite`), so a
-- reader never sees a database without it.
--
-- `pragma defer_foreign_keys` is what makes that legal: `chunks.index_config_id`
-- points at these rows, and with foreign keys enforced immediately the `drop`
-- would be refused on the spot. Deferred, the check happens at commit -- by
-- which time the rows are back, under the same ids. The pragma lasts for this
-- transaction only and resets itself at commit; it is not `foreign_keys = OFF`,
-- which would skip the check altogether rather than postpone it.
--
-- It is a drop and not an `alter table ... rename`: with `legacy_alter_table`
-- off -- the default, and what `node:sqlite` gives us -- a rename rewrites the
-- foreign key clauses of every table that referred to the old name, so
-- `chunks` would come out of it pointing at `index_configs_old`. Dropping
-- leaves `chunks`'s clause spelling `index_configs`, and the new table takes
-- that name.
pragma defer_foreign_keys = ON;

create temp table index_configs_stash as select * from index_configs;

drop table index_configs;

-- The same table as 0001's, with two changes: `document_chunk` joins the kinds,
-- and the canonical-form check for `chunk_params` now depends on the kind,
-- because document chunking has parameters of its own. The point of the check
-- is unchanged: SQLite compares JSON as text, so rather than make two spellings
-- of one value equal, only one spelling is possible -- exactly what
-- `json_object` builds from the column's own values, in that order. Any other
-- key order, any extra key, any stray whitespace is refused at the door instead
-- of quietly becoming a second row with the same meaning.
--
-- Core's `IndexConfigKind` now includes `document_chunk` as well (story 10.7,
-- which also added `DocumentChunkParams` for this kind's pair of parameters).
-- It did not when this migration was written: the database is deliberately the
-- wider of the two -- the row has to exist before anything can read it -- and
-- the type grew with the codec its readers (stories 10.14 and 10.8) will use.
create table index_configs (
  id text primary key,
  kind text not null,
  model text,
  dimensions integer,
  chunk_params text not null,
  constraint index_configs_kind_check
    check (kind in ('chunk', 'embedding', 'document_chunk')),
  constraint index_configs_chunk_params_check
    check (case
             when kind = 'document_chunk'
               then chunk_params = json_object(
                      'targetChars', json_extract(chunk_params, '$.targetChars'),
                      'overlapChars', json_extract(chunk_params, '$.overlapChars'))
             else chunk_params = json_object(
                      'targetChars', json_extract(chunk_params, '$.targetChars'),
                      'overlapMessages', json_extract(chunk_params, '$.overlapMessages'),
                      'splitMessagesOverChars', json_extract(chunk_params, '$.splitMessagesOverChars'))
           end)
) strict;

-- `nulls not distinct`, by hand, exactly as in 0001: the index went with the
-- dropped table and has to come back, or two chunk-only configs with the same
-- parameters would both be allowed in.
create unique index index_configs_key_idx
  on index_configs (kind, coalesce(model, ''), coalesce(dimensions, -1), chunk_params);

insert into index_configs (id, kind, model, dimensions, chunk_params)
     select id, kind, model, dimensions, chunk_params from index_configs_stash;

drop table index_configs_stash;

-- The document chunking rules a fresh install starts with (AD-24), written by
-- the migration for the same reason 0001 writes the conversation one: the
-- canonical-form check already settled what the text has to look like, so there
-- is nothing left for an install step to decide. The id is a fixed UUIDv7
-- literal, because a row minted per machine would have a different name on
-- every one of them and the replica would end up with two (AD-22).
--
-- `model` and `dimensions` stay null: chunking is not embedding. The parameters
-- are the document-shaped pair -- a target size and an overlap, both in
-- characters, never tokens -- and they live in the row rather than in code, so
-- changing them is `admin.reindex` on a new row and not a new release.
insert into index_configs (id, kind, model, dimensions, chunk_params)
     values ('019a0000-0000-7000-8000-000000000002', 'document_chunk', null, null,
             '{"targetChars":1200,"overlapChars":120}');
