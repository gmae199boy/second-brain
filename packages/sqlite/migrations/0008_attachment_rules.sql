-- Enforce the attachment and extraction change rules of the Table Contract
-- (I67, AD-23, AD-24) without changing existing rows. This supersedes 0002's
-- paragraph saying the derived tables may be freely rewritten: attachment
-- provenance is immutable, extraction generations close once, chunks can only
-- be removed for closed non-current generations or redaction, and redacted
-- files must never regain derived names or metadata.
create trigger message_attachments_immutable_update
  before update on message_attachments
  when new.id is not old.id
    or new.message_id is not old.message_id
    or new.ordinal is not old.ordinal
    or new.source_kind is not old.source_kind
    or new.source_ref is not old.source_ref
    or new.display_name is not old.display_name
    or (old.status is not null
        and (new.file_id is not old.file_id or new.status is not old.status))
begin
  select raise(abort, 'message_attachments is immutable: provenance cannot change and file_id and status may only be filled once');
end;

create trigger message_attachments_immutable_delete
  before delete on message_attachments
begin
  select raise(abort, 'message_attachments is immutable: delete is refused');
end;

create trigger document_extractions_immutable_update
  before update on document_extractions
  when new.id is not old.id
    or new.file_id is not old.file_id
    or new.extractor_version is not old.extractor_version
    or new.attempt is not old.attempt
    or new.started_at is not old.started_at
    or (old.finished_at is not null
        and (new.media_type is not old.media_type
             or new.status is not old.status
             or new.finished_at is not old.finished_at
             or new.error is not old.error
             or new.failed_stage is not old.failed_stage
             or new.index_config_id is not old.index_config_id))
begin
  select raise(abort, 'document_extractions is immutable: identity cannot change and only open generations may be updated');
end;

create trigger document_chunks_delete_rule
  before delete on document_chunks
  when coalesce(brain_redact_allowed(), 0) <> 1
    and exists (
      select 1 from document_extractions e
       where e.id = old.extraction_id
         and (e.finished_at is null
              or exists (select 1 from files f where f.current_extraction_id = e.id))
    )
begin
  select raise(abort, 'document_chunks delete requires a closed non-current generation or redaction');
end;

create trigger file_names_redacted_insert
  before insert on file_names
  when exists (select 1 from files where id = new.file_id and redacted_at is not null)
begin
  select raise(abort, 'file_names cannot be written for a redacted file');
end;

create trigger file_names_redacted_update
  before update on file_names
  when exists (select 1 from files where id = new.file_id and redacted_at is not null)
begin
  select raise(abort, 'file_names cannot be written for a redacted file');
end;

create trigger file_metadata_redacted_insert
  before insert on file_metadata
  when exists (select 1 from files where id = new.file_id and redacted_at is not null)
begin
  select raise(abort, 'file_metadata cannot be written for a redacted file');
end;

create trigger file_metadata_redacted_update
  before update on file_metadata
  when exists (select 1 from files where id = new.file_id and redacted_at is not null)
begin
  select raise(abort, 'file_metadata cannot be written for a redacted file');
end;
