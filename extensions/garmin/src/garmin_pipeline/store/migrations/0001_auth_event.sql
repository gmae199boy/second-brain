-- 대화형 로그인(`garmin-pipeline login`) 성공 기록(FR2). 토큰 수명을 관측하는 데 쓴다.
-- local_date: config `timezone` 기준 로그인한 날(YYYY-MM-DD), logged_in_at: UTC epoch ms.
CREATE TABLE auth_event (
    id INTEGER PRIMARY KEY,
    local_date TEXT NOT NULL,
    logged_in_at INTEGER NOT NULL
);
