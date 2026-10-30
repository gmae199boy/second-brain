create table brain.extension_work_kinds (
  extension_name text not null references brain.extensions(name) on delete cascade,
  kind text primary key
);
