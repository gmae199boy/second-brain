-- 과거 revision은 NULL을 유지하고 렌더러가 기존 요약을 사용한다.
alter table garmin.evaluation_revisions add column message jsonb;
