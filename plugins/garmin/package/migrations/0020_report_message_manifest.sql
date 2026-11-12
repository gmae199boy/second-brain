-- 선택 revision의 표시 본문은 분석 없이 재발신할 때도 동일하게 보존한다.
create table garmin.report_message_manifests (
 user_id uuid not null, connection_id uuid not null, report_date text not null,
 revision_key text not null, manifest jsonb not null,
 primary key(user_id,connection_id,report_date,revision_key)
);
-- 기간별 실패 횟수는 감독자 attempt 재실행과 무관하게 보존한다.
create table garmin.report_scope_failures (
 work_id uuid not null, report_date text not null, scope text not null,
 failures integer not null check(failures between 0 and 6),
 primary key(work_id,report_date,scope)
);
