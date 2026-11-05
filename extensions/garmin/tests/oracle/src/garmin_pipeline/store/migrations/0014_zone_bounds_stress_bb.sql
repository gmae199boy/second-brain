-- 그래프 전용 존 하한·촘촘한 Body Battery(5.12 후속). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- NORMALIZE_VERSION 7의 전체 재구성이 기존 원문에서도 값을 채운다. body_battery_sample은 그대로 둔다.
ALTER TABLE activity ADD COLUMN hr_zone1_low_bpm INTEGER; -- activity_hr_in_timezones: zoneNumber 1의 zoneLowBoundary (bpm, round)
ALTER TABLE activity ADD COLUMN hr_zone2_low_bpm INTEGER; -- activity_hr_in_timezones: zoneNumber 2의 zoneLowBoundary (bpm, round)
ALTER TABLE activity ADD COLUMN hr_zone3_low_bpm INTEGER; -- activity_hr_in_timezones: zoneNumber 3의 zoneLowBoundary (bpm, round)
ALTER TABLE activity ADD COLUMN hr_zone4_low_bpm INTEGER; -- activity_hr_in_timezones: zoneNumber 4의 zoneLowBoundary (bpm, round)
ALTER TABLE activity ADD COLUMN hr_zone5_low_bpm INTEGER; -- activity_hr_in_timezones: zoneNumber 5의 zoneLowBoundary (bpm, round)

-- stress_data 원문의 bodyBatteryValueDescriptorsDTOList로 위치를 찾는다. 결측 level도 NULL 행으로 남긴다.
CREATE TABLE stress_bb_sample (
    day_key TEXT NOT NULL, -- 원문의 일 키(raw_response.key, YYYY-MM-DD)
    ts_ms INTEGER NOT NULL, -- bodyBatteryValuesArray[i][timestamp 위치] (UTC epoch ms)
    level INTEGER, -- bodyBatteryValuesArray[i][bodyBatteryLevel 위치] (round. null·음수면 NULL)
    PRIMARY KEY (day_key, ts_ms)
);
CREATE INDEX stress_bb_sample_ts_ms ON stress_bb_sample(ts_ms);
