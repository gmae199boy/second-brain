-- 최초 gate와 기존에 확정된 결과를 모두 보존한다.
alter table brain.channel_attempt_results drop constraint channel_attempt_results_pkey;
alter table brain.channel_attempt_results add primary key (request_id, attempt_token);
alter table brain.channel_attempt_results add column outcome text default 'sent' check (outcome in ('sent', 'definite_failed', 'unknown'));
alter table brain.channel_attempt_results add column error_code text;
alter table brain.channel_attempt_results add column retryable boolean;
alter table brain.channel_attempt_results add column retry_after_ms bigint check (retry_after_ms >= 0);
alter table brain.channel_attempt_results add column finished_at timestamptz;
update brain.channel_attempt_results set finished_at = created_at;
-- 결과 없는 기존 gate는 원격 서버에 도달했을 수 있다.
drop trigger channel_result_fence on brain.channel_attempt_results;
insert into brain.channel_attempt_results (request_id, work_item_id, attempt_token, created_at, outcome, error_code, retryable, finished_at)
select g.request_id, g.work_item_id, g.attempt_token, g.created_at, 'unknown', 'INTERRUPTED', true, g.created_at
from brain.channel_gates g where not exists (select 1 from brain.channel_attempt_results r where r.request_id = g.request_id);
create trigger channel_result_fence before insert on brain.channel_attempt_results for each row execute function brain.reject_stale_attempt('work_item_id', 'attempt_token');
grant update on brain.channel_attempt_results to brain_app;
-- 진행 중인 현재 시도만 한 번 확정할 수 있고 이미 확정된 행은 불변이다.
create function brain.guard_channel_result_update() returns trigger language plpgsql as $$
begin
  if not brain.attempt_is_current(old.work_item_id, old.attempt_token) then
    raise exception '오래된 채널 시도' using errcode = 'BRS01';
  end if;
  if old.outcome is not null or new.outcome is null or
     new.request_id is distinct from old.request_id or new.work_item_id is distinct from old.work_item_id or
     new.attempt_token is distinct from old.attempt_token or new.created_at is distinct from old.created_at or
     new.finished_at is null or
     (new.outcome = 'sent' and (new.error_code is not null or new.retryable is not null or new.retry_after_ms is not null)) or
     (new.outcome in ('unknown','definite_failed') and (new.external_message_id is not null or new.error_code is null or new.retryable is null)) then
    raise exception '채널 결과는 한 번만 확정할 수 있습니다' using errcode = 'BRS01';
  end if;
  return new;
end $$;
create trigger channel_result_update_fence before update on brain.channel_attempt_results for each row execute function brain.guard_channel_result_update();
