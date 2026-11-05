-- 활동 요약·존별 시간·활동 심박 정규화(FR11·13, AD-4·13). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- activity-scope 원문 3종(activity·activity_hr_in_timezones·activity_details)을 정규화한다. daily_metric·hr_sample은
-- 바꾸지 않는다.

-- 활동: activityId 하나에 한 행이다. 열은 모두 NULL을 허용한다. activity가 요약 열을, activity_hr_in_timezones가
-- 존별 시간 열을 소유한다(activity_details는 열을 소유하지 않고 샘플만 activity_hr_sample에 쓴다).
-- day_key는 저장된 activities_by_date 목록(rawparse.activity_refs, 목록 key 오름차순의 처음 것)에서 정하고,
-- 어느 목록에도 없으면 NULL이다. activity-scope 항목이 행을 쓸 때만 갱신한다.
CREATE TABLE activity (
    activity_id INTEGER PRIMARY KEY, -- 원문의 activityId(raw_response.key)
    day_key TEXT,                    -- activities_by_date 항목 startTimeLocal의 날짜 부분(YYYY-MM-DD)
    type_key TEXT,                   -- activity: activityTypeDTO.typeKey
    start_ms INTEGER,                -- activity: summaryDTO.startTimeGMT (UTC로 읽은 epoch ms)
    duration_s INTEGER,              -- activity: summaryDTO.duration (초, round)
    distance_m INTEGER,              -- activity: summaryDTO.distance (m, round. 키가 없으면 NULL)
    avg_hr INTEGER,                  -- activity: summaryDTO.averageHR (round. 키가 없으면 NULL)
    max_hr INTEGER,                  -- activity: summaryDTO.maxHR (round. 키가 없으면 NULL)
    hr_zone1_s INTEGER,              -- activity_hr_in_timezones: zoneNumber 1의 secsInZone (round)
    hr_zone2_s INTEGER,              -- activity_hr_in_timezones: zoneNumber 2의 secsInZone (round)
    hr_zone3_s INTEGER,              -- activity_hr_in_timezones: zoneNumber 3의 secsInZone (round)
    hr_zone4_s INTEGER,              -- activity_hr_in_timezones: zoneNumber 4의 secsInZone (round)
    hr_zone5_s INTEGER               -- activity_hr_in_timezones: zoneNumber 5의 secsInZone (round)
);

-- 활동 심박 샘플: activity_details 원문의 activityDetailMetrics 한 샘플에 한 행이다. 위치는 metricDescriptors의
-- key(directTimestamp·directHeartRate)와 metricsIndex로 찾는다. 정규화는 그 활동의 행을 통째로 지우고 현재 원문의
-- 샘플로 다시 넣는다(null 원문·실패면 지우기만 한다). 결측 샘플도 bpm NULL 행으로 남는다.
CREATE TABLE activity_hr_sample (
    activity_id INTEGER NOT NULL, -- 원문의 activityId(raw_response.key)
    ts_ms INTEGER NOT NULL,       -- activityDetailMetrics[i].metrics[directTimestamp 위치] (UTC epoch ms, round)
    bpm INTEGER,                  -- activityDetailMetrics[i].metrics[directHeartRate 위치] (round. null·음수거나 반올림 결과가 0이면 NULL)
    PRIMARY KEY (activity_id, ts_ms)
);
