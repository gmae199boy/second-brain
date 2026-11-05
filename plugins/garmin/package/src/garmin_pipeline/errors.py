"""모든 모듈이 같이 쓰는 닫힌 상태 어휘와 Garmin 도메인 오류(AD-2·5·6·10).

값은 DB·알림에 그대로 저장되므로 이름과 값을 바꾸지 않는다. 새 값이 필요하면
아키텍처 결정부터 고친다. stdlib만 import하고 다른 패키지 모듈은 import하지 않는다.
"""

from enum import StrEnum


class RunStatus(StrEnum):
    """`run` 행 하나의 상태(AD-5)."""

    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    RATE_LIMITED = "rate_limited"
    BLOCKED_403 = "blocked_403"
    AUTH_FAILED = "auth_failed"
    ERROR = "error"
    SKIPPED_BLOCKED = "skipped_blocked"


class NotifyEvent(StrEnum):
    """알림을 보내는 사건(AD-10)."""

    AUTH_FAILED = "auth_failed"
    RATE_LIMITED = "rate_limited"
    BLOCKED_403 = "blocked_403"
    NORMALIZE_FAILED = "normalize_failed"
    REPEATED_PARTIAL = "repeated_partial"
    ERROR = "error"
    REPORT_FAILED = "report_failed"


class DeliveryKind(StrEnum):
    """전송 결과의 종류(AD-10·17)."""

    NOTIFY = "notify"
    REPORT_TEXT = "report_text"
    REPORT_ALBUM = "report_album"
    REPORT_DOCUMENT = "report_document"


class DeliveryReason(StrEnum):
    """비밀을 포함하지 않는 전송 실패 사유(AD-17)."""

    NETWORK = "network"
    RATE_LIMITED = "rate_limited"
    HTTP_4XX = "http_4xx"
    HTTP_5XX = "http_5xx"
    INVALID_CONFIG = "invalid_config"
    TOO_LARGE = "too_large"


class AuthFailedReason(StrEnum):
    """`AuthFailed`의 사유(AD-6). `auth_failed` 실행의 `run.detail` 토큰으로도 쓴다(AD-5)."""

    TOKEN_INVALID = "token_invalid"
    PRIVACY_PROTECTED = "privacy_protected"


class RunDetail(StrEnum):
    """`run.detail`에 쓰는 토큰(AD-5·6·8).

    `detail`은 이 값과 `AuthFailedReason` 값만으로 만든 공백 구분 토큰열이다. 건수가 있는
    토큰은 `transient=N`·`rejected=M`처럼 `=건수`를 붙인다. 실행 중단 사유(`lock_timeout`·
    `session_lock_timeout`·`login_transient`·`block_file_invalid`, 또는 `auth_failed`의
    `AuthFailedReason` 값)는 맨 앞에 온다. `abandoned`는 다음 `collect`가 끝나지 않은 채 남은
    `running` 행을 `error`로 정리할 때 그 행의 `detail` 전체다. 사람이 실행한 수집의
    `manual`은 이번 실행 행에만 붙이며 `timezone_mismatch` 뒤, 늘 맨 뒤에 온다.
    """

    TRANSIENT = "transient"
    REJECTED = "rejected"
    TIMEZONE_MISMATCH = "timezone_mismatch"
    LOCK_TIMEOUT = "lock_timeout"
    SESSION_LOCK_TIMEOUT = "session_lock_timeout"
    LOGIN_TRANSIENT = "login_transient"
    BLOCK_FILE_INVALID = "block_file_invalid"
    ABANDONED = "abandoned"
    MANUAL = "manual"


class ReportFailReason(StrEnum):
    """`report`가 하루 분석이나 리포트 파일을 만들지 못한 사유(FR36·37, AD-10·16).

    `report_failed` 알림의 `detail`은 한 실행에서 생긴 이 값들의 공백 구분 토큰열(발생 순)이다.
    앞의 넷은 하루 분석 작성기 실패이고, 리포트는 하루 분석 자리에 사유를 적어 남긴다. `write_failed`면 리포트 파일이 없다.
    """

    CODEX_TIMEOUT = "codex_timeout"
    CODEX_FAILED = "codex_failed"
    OUTPUT_INVALID = "output_invalid"
    SKILL_FAILED = "skill_failed"
    WRITE_FAILED = "write_failed"


class DomainError(Exception):
    """`garmin` 어댑터가 라이브러리 예외를 바꿔 던지는 도메인 오류의 바탕(AD-6).

    다른 모듈은 라이브러리 예외가 아니라 이 계층으로만 분기한다. 메시지에는 응답 본문,
    토큰, 비밀번호, 이메일을 넣지 않는다(AD-12). 상태 코드나 엔드포인트 이름 정도만 담는다.
    """


class RateLimited(DomainError):
    """429. 저장분은 유지하고 실행을 멈추며 당일 차단을 남긴다."""


class Blocked403(DomainError):
    """로그인 단계 403 또는 데이터 403의 연속. 실행을 멈추고 당일 차단을 남긴다."""


class Transient(DomainError):
    """5xx·네트워크 오류(라이브러리 재시도 소진). 다음 실행에서 다시 시도한다."""


class AuthFailed(DomainError):
    """토큰이 무효하거나 계정이 비공개다. `.reason`은 `AuthFailedReason`이다.

    `reason`은 `AuthFailedReason(reason)`으로 바꾸므로 모르는 사유면 `ValueError`가 난다.
    """

    def __init__(self, reason: AuthFailedReason | str) -> None:
        self.reason = AuthFailedReason(reason)
        super().__init__(self.reason)


class Rejected(DomainError):
    """데이터 호출의 403·기타 4xx. 그 항목만 실패로 남긴다."""


class NoData(DomainError):
    """404·`None`·`[]`·빈 응답. 오류가 아니라 원본 `null`로 저장한다(AD-3)."""
