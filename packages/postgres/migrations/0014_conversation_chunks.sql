alter table brain.chunks drop constraint chunks_session_id_index_config_id_from_at_to_at_key;
alter table brain.chunks add column part integer not null default 0 check (part >= 0), add column body_raw bytea;
alter table brain.chunks add unique (session_id, index_config_id, from_at, to_at, part);
alter table brain.index_configs drop constraint index_configs_chunk_params_check;
alter table brain.index_configs add constraint index_configs_chunk_params_check check (
  jsonb_typeof(chunk_params) = 'object' and case when kind = 'document_chunk' then
    chunk_params ?& array['targetChars','overlapChars'] and chunk_params - array['targetChars','overlapChars'] = '{}'::jsonb
    and jsonb_typeof(chunk_params->'targetChars') = 'number' and jsonb_typeof(chunk_params->'overlapChars') = 'number'
  else
    chunk_params ?& array['targetChars','overlapMessages','splitMessagesOverChars']
    and chunk_params - array['targetChars','overlapMessages','splitMessagesOverChars','rules'] = '{}'::jsonb
    and jsonb_typeof(chunk_params->'targetChars') = 'number' and jsonb_typeof(chunk_params->'overlapMessages') = 'number'
    and jsonb_typeof(chunk_params->'splitMessagesOverChars') = 'number'
    and (not chunk_params ? 'rules' or jsonb_typeof(chunk_params->'rules') = 'object')
  end
);
insert into brain.index_configs(id,kind,model,dimensions,chunk_params) values
('019a0000-0000-7000-8000-000000000003','chunk',null,null,
 '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400,"rules":{"version":1,"order":"occurred_at,id","units":"code_points","separator":"newline","boundary":"include_timestamp_group_at_target","split":"split_limit","parts":"range_0_or_1_to_n"}}');

-- 직접 SQL 가리기와 수집 모두 같은 열린 행의 청구를 무효화한다.
create function brain.enqueue_conversation_chunk(session_id uuid, ready_at timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, brain as $$
begin
  loop
    insert into brain.work_items(id, kind, execution_class, target_kind, target_id, created_at, next_attempt_at)
      values (uuidv7(), 'conversation_chunk', 'core', 'session', session_id::text, ready_at, ready_at)
      on conflict (kind, target_kind, target_id) where completed_at is null do nothing;
    if found then return; end if;
    update brain.work_items set claimed_at = null, claim_expires_at = null, claimed_by = null,
      next_attempt_at = ready_at, attempts = 0
      where kind = 'conversation_chunk' and target_kind = 'session' and target_id = session_id::text and completed_at is null;
    if found then return; end if;
  end loop;
end $$;
revoke all on function brain.enqueue_conversation_chunk(uuid,timestamptz) from public;
grant execute on function brain.enqueue_conversation_chunk(uuid,timestamptz) to brain_app;

alter function brain.redact_message(uuid,jsonb) rename to redact_message_before_conversation_chunks;
revoke all on function brain.redact_message_before_conversation_chunks(uuid,jsonb) from public, brain_app;
create function brain.redact_message(message_id uuid, payload jsonb) returns integer
language plpgsql security definer set search_path = pg_catalog, brain as $$
declare removed integer; session_id uuid;
begin
  removed := brain.redact_message_before_conversation_chunks(message_id, payload);
  if jsonb_array_length(coalesce(payload->'redactions', '[]'::jsonb)) > 0 then
    select m.session_id into strict session_id from brain.messages m where m.id = message_id;
    perform brain.enqueue_conversation_chunk(session_id, coalesce((payload->'redactions'->0->>'occurredAt')::timestamptz, now()));
  end if;
  return removed;
end $$;
revoke all on function brain.redact_message(uuid,jsonb) from public;
grant execute on function brain.redact_message(uuid,jsonb) to brain_app;
