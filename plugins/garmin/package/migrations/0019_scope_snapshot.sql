-- 구 revision은 NULL 유지. 새 v2 전체 구조체와 입력 snapshot provenance를 함께 보존한다.
alter table garmin.evaluation_revisions add column structured jsonb;
create index evaluation_snapshot_scope on garmin.evaluation_revisions
 (user_id, connection_id, report_date, (structured->>'snapshot_id'), scope)
 where structured is not null;
