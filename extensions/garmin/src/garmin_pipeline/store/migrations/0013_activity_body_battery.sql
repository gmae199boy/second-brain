-- 운동 중 Body Battery(Epic 5, 5.9, AD-13). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- activity_details 원문의 directBodyBattery 채널을 activity_hr_sample의 같은 샘플 행에 더한다. 세션과 소모(시작 − 끝)는
-- facts가 매번 계산하고 저장하지 않는다. 기존 행은 NULL로 남고 NORMALIZE_VERSION 5의 재구성이 값을 채운다.
ALTER TABLE activity_hr_sample ADD COLUMN body_battery INTEGER; -- activityDetailMetrics[i].metrics[directBodyBattery 위치] (round. 채널이 없거나 null·음수면 NULL, 0은 0)
