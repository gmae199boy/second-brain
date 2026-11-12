-- 원문 예외 대신 고정 어휘의 실패 원인을 보존한다. 기존 행의 원인은 복원하지 않는다.
alter table garmin.fetch_error add column message text not null default ''
 check (length(message) <= 240);
