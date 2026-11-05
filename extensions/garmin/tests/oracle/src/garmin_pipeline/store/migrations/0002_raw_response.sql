-- Garmin 응답 원문 보존(FR6·7·12, AD-3). (scope, key, endpoint)마다 마지막으로 받은 원문 한 행이다.
-- scope: 'day'면 key는 config `timezone` 기준 일 키(YYYY-MM-DD), 'activity'면 str(activityId).
-- raw: json.dumps(payload, ensure_ascii=False) 텍스트. NoData는 'null'이다.
-- fetched_at: raw가 마지막으로 바뀐 시각, checked_at: 마지막으로 확인한 시각(둘 다 UTC epoch ms).
-- library_version: raw를 받은 garminconnect 배포 버전.
CREATE TABLE raw_response (
    scope TEXT NOT NULL CHECK (scope IN ('day', 'activity')),
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    raw TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    library_version TEXT NOT NULL,
    PRIMARY KEY (scope, key, endpoint)
);
