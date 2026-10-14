-- A second file, so a run applies more than one and the order shows.

create table tags (
  id text primary key,
  note_id text not null references notes (id),
  name text not null
);
