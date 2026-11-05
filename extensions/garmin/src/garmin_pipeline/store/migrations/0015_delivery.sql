-- 전송 결과 1차 테이블(AD-3·10·17). 쓰는 곳은 ports.record_delivery뿐이다.
-- at: UTC epoch ms. 본문·토큰·chat id는 저장하지 않는다.
CREATE TABLE delivery (
    id INTEGER PRIMARY KEY,
    local_date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('notify', 'report_text', 'report_album', 'report_document')),
    event TEXT CHECK (event IS NULL OR event IN ('auth_failed', 'rate_limited', 'blocked_403', 'normalize_failed', 'repeated_partial', 'error', 'report_failed')),
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    reason TEXT CHECK (reason IS NULL OR reason IN ('network', 'rate_limited', 'http_4xx', 'http_5xx', 'invalid_config', 'too_large')),
    at INTEGER NOT NULL,
    CHECK ((ok = 1) = (reason IS NULL))
);
