-- Existing settings belong to self, except the machine-wide doctor probe.
alter table brain.settings add column user_id uuid references brain.users(id);
alter table brain.channel_conversations add column user_id uuid references brain.users(id);

do $$
declare self_id uuid;
begin
  select id into self_id from brain.users where is_self = 1;
  if self_id is null and (exists (select 1 from brain.settings where key <> 'doctor.writable')
      or exists (select 1 from brain.channel_conversations)) then
    raise exception 'USER_MISSING: existing rows require a self user';
  end if;
  update brain.settings set user_id = self_id where key <> 'doctor.writable';
  update brain.channel_conversations set user_id = self_id;
end $$;

alter table brain.settings drop constraint settings_pkey;
alter table brain.settings add constraint settings_user_id_key_key unique nulls not distinct (user_id, key);
alter table brain.channel_conversations alter column user_id set not null;

create or replace function brain.settings_immutable_update_fn() returns trigger language plpgsql as $$
begin
  if new.key is distinct from old.key or new.user_id is distinct from old.user_id then
    raise exception 'settings_immutable_update: invariant refused';
  end if;
  return new;
end $$;
