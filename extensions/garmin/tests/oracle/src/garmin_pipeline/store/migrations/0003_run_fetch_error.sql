-- 실행 기록과 실패 기록(FR16·20, AD-5). 커버리지 판정(coverage)이 raw_response와 함께 읽는다.
-- run: 실행 한 번에 한 행. local_date: config `timezone` 기준 실행한 날(YYYY-MM-DD).
-- started_at·finished_at: UTC epoch ms. finished_at은 status가 'running'인 동안 NULL이다.
-- status: errors.RunStatus 8종. detail: 사람이 읽는 요약(없으면 빈 문자열).
CREATE TABLE run (
    id INTEGER PRIMARY KEY,
    local_date TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL CHECK (status IN (
        'running',
        'success',
        'partial',
        'rate_limited',
        'blocked_403',
        'auth_failed',
        'error',
        'skipped_blocked'
    )),
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX run_local_date ON run (local_date);

-- fetch_error: 항목 하나의 호출 실패 한 번에 한 행. (scope, key, endpoint)는 raw_response와 같은 뜻이다.
-- kind: 'transient'(다음 실행에서 다시) 또는 'rejected'(403·기타 4xx).
-- local_date: 시도한 날의 일 키(YYYY-MM-DD), occurred_at: UTC epoch ms.
-- error_code: 실패 코드(값은 collect가 정한다).
CREATE TABLE fetch_error (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run (id),
    scope TEXT NOT NULL CHECK (scope IN ('day', 'activity')),
    key TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('transient', 'rejected')),
    local_date TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    error_code TEXT NOT NULL
);

CREATE INDEX fetch_error_item ON fetch_error (scope, key, endpoint);
