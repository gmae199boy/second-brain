-- 정규화 결과(FR9·11, NFR3·5, AD-13). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- normalize_result: 정규화한 원문 항목 (scope, key, endpoint)마다 마지막 결과 한 행이다.
-- raw_fetched_at: 정규화한 원문의 raw_response.fetched_at. 원문 fetched_at과 다르거나 행이 없으면
-- 다시 정규화할 작업 집합이다. normalized_at: 결과를 기록한 시각(둘 다 UTC epoch ms).
-- ok=1이면 error_code는 NULL, ok=0이면 normalize.NormalizeErrorCode('parse_error'·'internal')다.
CREATE TABLE normalize_result (
    scope TEXT NOT NULL CHECK (scope IN ('day', 'activity')),
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    error_code TEXT,
    raw_fetched_at INTEGER NOT NULL,
    normalized_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key, endpoint),
    CHECK ((ok = 1 AND error_code IS NULL) OR (ok = 0 AND error_code IS NOT NULL))
);

-- 일일 요약 지표: config `timezone` 기준 일 키(YYYY-MM-DD)마다 한 행이다.
-- endpoint마다 겹치지 않는 열을 소유하고, 정규화는 그 endpoint 열만 바꾼다. 모든 열은 NULL을 허용한다
-- (원문이 null·없음·음수 센티넬이거나 그 항목이 정규화에 실패했다). 열 값은 현재 원문만으로 다시 만든
-- 결과와 같지만 행이 있는지는 뜻이 없다(값이 모두 NULL인 행이 남거나 생길 수 있다). 읽는 쪽은 열의 NULL로 판단한다.
CREATE TABLE daily_metric (
    day_key TEXT NOT NULL PRIMARY KEY,
    -- user_summary
    steps INTEGER,                 -- totalSteps
    distance_m INTEGER,            -- totalDistanceMeters
    active_kcal INTEGER,           -- activeKilocalories
    moderate_intensity_s INTEGER,  -- moderateIntensityMinutes × 60
    vigorous_intensity_s INTEGER,  -- vigorousIntensityMinutes × 60
    min_hr INTEGER,                -- minHeartRate
    max_hr INTEGER,                -- maxHeartRate
    -- rhr_day
    resting_hr INTEGER,            -- allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE[calendarDate = 일 키].value
    -- hrv_data
    hrv_last_night_avg INTEGER,    -- hrvSummary.lastNightAvg
    hrv_weekly_avg INTEGER,        -- hrvSummary.weeklyAvg
    hrv_baseline_low INTEGER,      -- hrvSummary.baseline.balancedLow (baseline이 null이면 NULL)
    hrv_baseline_high INTEGER,     -- hrvSummary.baseline.balancedUpper (baseline이 null이면 NULL)
    hrv_status TEXT,               -- hrvSummary.status
    -- training_readiness
    readiness_score INTEGER,       -- [timestamp가 가장 이른 항목].score
    readiness_level TEXT           -- [timestamp가 가장 이른 항목].level
);
