-- 수집 메타데이터(AD-4). key 하나에 값 하나다. 쓰는 곳은 collect뿐이다.
-- history_start: 수집 대상의 첫 일 키(YYYY-MM-DD). 첫 collect가 그날의 today − 30일로 한 번만 쓰고
-- (INSERT OR IGNORE), 이후 실행은 읽기만 한다.
CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
