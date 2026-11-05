-- HRR 제거(Epic 5, 5.7, FR47·AD-13). 2분 간격 일일 심박으로는 HRR이 꾸준히 계산되지 않아 facts v2(5.6)가 더는
-- 읽지 않으므로 normalize가 쓰던 activity_recovery를 없앤다. 0010이 늘 먼저 적용되므로 IF EXISTS는 두지 않는다.
-- 0010이 만든 인덱스 hr_sample_ts_ms는 hr_sample에 걸린 것이라 남긴다(수면 중 심박·복귀 시간(5.11)이 시각 범위
-- 조회에 쓴다). hr_sample 열·PK도 그대로다.
DROP TABLE activity_recovery;
