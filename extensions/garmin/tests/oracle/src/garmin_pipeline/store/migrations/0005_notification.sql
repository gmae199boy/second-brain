-- 사람에게 알릴 실패 기록(FR22, AD-10). 쓰는 곳은 ports.TableNotifier뿐이다(쓰기 락 안).
-- local_date: 알릴 실행의 날(config `timezone` 기준 YYYY-MM-DD). event: errors.NotifyEvent 7종.
-- detail: 그 실행의 run.detail(없으면 빈 문자열). at: 처음 기록한 시각(UTC epoch ms).
-- (local_date, event)는 하루에 한 번이다. INSERT OR IGNORE라 처음 기록한 행이 남는다.
CREATE TABLE notification (
    local_date TEXT NOT NULL,
    event TEXT NOT NULL CHECK (event IN (
        'auth_failed',
        'rate_limited',
        'blocked_403',
        'normalize_failed',
        'repeated_partial',
        'error',
        'report_failed'
    )),
    detail TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    UNIQUE (local_date, event)
);
