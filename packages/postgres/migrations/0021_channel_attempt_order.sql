-- 기존 이력의 기록된 시각을 우선해 순번을 채우고, 이후 삽입을 그 뒤에 잇는다.
alter table brain.channel_attempt_results add column sequence bigint;
alter table brain.channel_attempt_results disable trigger channel_result_update_fence;
with ordered as (
  select a.request_id, a.attempt_token,
         -- [ASSUMPTION] 두 시각이 같으면 과거 실제 선후가 기록되지 않아 결정적인 ID 순서를 사용한다.
         row_number() over (order by a.created_at, w.started_at nulls first, a.attempt_token, a.request_id) as sequence
  from brain.channel_attempt_results a
  left join brain.work_attempts w on w.token=a.attempt_token and w.work_item_id=a.work_item_id
)
update brain.channel_attempt_results a set sequence=o.sequence
from ordered o where a.request_id=o.request_id and a.attempt_token=o.attempt_token;
alter table brain.channel_attempt_results enable trigger channel_result_update_fence;
alter table brain.channel_attempt_results alter column sequence set not null;
alter table brain.channel_attempt_results alter column sequence add generated always as identity;
select setval(pg_get_serial_sequence('brain.channel_attempt_results', 'sequence'),
              coalesce(max(sequence), 1), count(*) > 0) from brain.channel_attempt_results;
