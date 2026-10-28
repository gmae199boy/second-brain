-- Contract tables attach the fence when they are created:
-- create trigger <table>_attempt_fence before insert on <table> for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token');
create function brain.attempt_is_current(work_item_id uuid, attempt_token uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if work_item_id is null or attempt_token is null then
    return false;
  end if;
  perform w.id
    from brain.work_items w join brain.work_attempts a on a.work_item_id = w.id
   where w.id = $1 and w.current_attempt_token = $2 and w.completed_at is null
     and a.token = $2 and a.outcome is null
   for share of w, a;
  return found;
end $$;
grant execute on function brain.attempt_is_current(uuid, uuid) to public;

create function brain.reject_stale_attempt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  row_data jsonb := pg_catalog.to_jsonb(new);
  work_column text := coalesce(tg_argv[0], 'work_item_id');
  token_column text := coalesce(tg_argv[1], 'attempt_token');
begin
  if not (row_data ? work_column) or not (row_data ? token_column) then
    raise exception 'reject_stale_attempt: missing configured column (%, %)', work_column, token_column;
  end if;
  if not brain.attempt_is_current((row_data ->> work_column)::uuid, (row_data ->> token_column)::uuid) then
    raise exception 'reject_stale_attempt: invariant refused' using errcode = 'BRS01';
  end if;
  return new;
end $$;
revoke execute on function brain.reject_stale_attempt() from public;
