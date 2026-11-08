-- Existing sources were connected at upgrade; retain their identity and cursor.
alter table brain.sources add column connected boolean not null default true;

-- A deletion of uncertain outcome survives process or session loss.
create table brain.drive_delete_barriers (work_id uuid primary key, created_at timestamptz not null);
grant select, insert, delete on brain.drive_delete_barriers to brain_app;
