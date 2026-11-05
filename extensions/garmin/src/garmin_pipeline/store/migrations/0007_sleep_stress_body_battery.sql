-- 수면·스트레스·Body Battery 정규화(FR11, AD-13, A3). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- daily_metric에 세 endpoint가 소유하는 열을 더한다. 0006과 같이 모든 열은 NULL을 허용한다(원문이
-- null·없음·음수 센티넬이거나 그 항목이 정규화에 실패했다). 시각은 UTC epoch ms다.
-- 3.2부터 training_readiness의 readiness_score·readiness_level(0006 주석은 "timestamp가 가장 이른 항목")은
-- inputContext == "AFTER_WAKEUP_RESET"인 항목 중 timestamp가 가장 이른 항목에서 오고, 그런 항목이 없으면
-- 전체에서 timestamp가 가장 이른 항목에서 온다. 열 정의는 바뀌지 않는다.
-- sleep_data (dailySleepDTO.*). sleepTimeSeconds가 null·음수면 잠이 기록되지 않은 날로 보고 수면 열이 모두 NULL이다.
ALTER TABLE daily_metric ADD COLUMN sleep_s INTEGER;         -- dailySleepDTO.sleepTimeSeconds
ALTER TABLE daily_metric ADD COLUMN deep_sleep_s INTEGER;    -- dailySleepDTO.deepSleepSeconds
ALTER TABLE daily_metric ADD COLUMN light_sleep_s INTEGER;   -- dailySleepDTO.lightSleepSeconds
ALTER TABLE daily_metric ADD COLUMN rem_sleep_s INTEGER;     -- dailySleepDTO.remSleepSeconds
ALTER TABLE daily_metric ADD COLUMN awake_sleep_s INTEGER;   -- dailySleepDTO.awakeSleepSeconds
ALTER TABLE daily_metric ADD COLUMN sleep_score INTEGER;     -- dailySleepDTO.sleepScores.overall.value (sleepScores·overall이 null이면 NULL)
ALTER TABLE daily_metric ADD COLUMN sleep_start_ms INTEGER;  -- dailySleepDTO.sleepStartTimestampGMT
ALTER TABLE daily_metric ADD COLUMN sleep_end_ms INTEGER;    -- dailySleepDTO.sleepEndTimestampGMT
-- stress_data. stressValuesArray의 stressLevel(stressValueDescriptorsDTOList로 위치를 찾는다) 중
-- null·음수(센티넬)를 뺀 유효 샘플로 계산한다. 유효 샘플이 없으면 NULL이다.
ALTER TABLE daily_metric ADD COLUMN stress_avg INTEGER;      -- round(유효 stressLevel 평균)
ALTER TABLE daily_metric ADD COLUMN stress_max INTEGER;      -- 유효 stressLevel 최대
-- body_battery ([date = 일 키인 첫 항목]. 그런 항목이 없으면 NULL)
ALTER TABLE daily_metric ADD COLUMN bb_charged INTEGER;      -- charged
ALTER TABLE daily_metric ADD COLUMN bb_drained INTEGER;      -- drained
ALTER TABLE daily_metric ADD COLUMN bb_high INTEGER;         -- bodyBatteryValuesArray의 유효 bodyBatteryLevel 최대
ALTER TABLE daily_metric ADD COLUMN bb_low INTEGER;          -- bodyBatteryValuesArray의 유효 bodyBatteryLevel 최소

-- Body Battery 샘플: body_battery 원문의 [date = 일 키인 첫 항목].bodyBatteryValuesArray 한 샘플에 한 행이다.
-- 위치는 bodyBatteryValueDescriptorDTOList(timestamp·bodyBatteryLevel)로 찾는다. ts_ms: timestamp(UTC epoch ms),
-- level: bodyBatteryLevel(null·음수면 NULL). 정규화는 그 일 키의 행을 통째로 지우고 현재 원문의 샘플로 다시
-- 넣는다(null 원문·실패면 지우기만 한다). 기상 값 유도 후보: 같은 일 키에서 ts_ms <= daily_metric.sleep_end_ms인
-- 마지막 level IS NOT NULL 샘플(계산은 facts 몫).
CREATE TABLE body_battery_sample (
    day_key TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    level INTEGER,
    PRIMARY KEY (day_key, ts_ms)
);
