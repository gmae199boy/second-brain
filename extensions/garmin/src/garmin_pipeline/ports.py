"""Account-scoped notification storage and neutral report/notice contracts."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Protocol

from garmin_pipeline import dates, errors, store


class Notifier(Protocol):
    """사람이 봐야 하는 사건 하나를 알린다.

    구현체는 (`local_date`, `event`)마다 많아야 한 번만 전달하고 처음 받은 것(`detail` 포함)을
    남긴다. `collect`는 같은 쌍으로 다시 부른다(`--force` 재실행, 11:15 재시도, `abandoned` 행).
    """

    def notify(
        self, local_date: date, event: errors.NotifyEvent, detail: str
    ) -> bool | None:
        """`local_date`(config `timezone` 기준 날)의 `event`를 `detail`과 함께 알린다.

        같은 (`local_date`, `event`)를 이미 알렸으면 아무것도 하지 않는다.
        """
        ...


class TableNotifier:
    """`notification` 테이블에 기록하는 `Notifier`. 연결은 쓰기 세션의 autocommit 연결이다."""

    def __init__(self, conn: store.Connection) -> None:
        self._conn = conn

    def notify(self, local_date: date, event: errors.NotifyEvent, detail: str) -> bool:
        with store.transaction(self._conn):
            cursor = self._conn.execute(
                "INSERT INTO garmin.notification (user_id, connection_id, local_date, event, detail, at)"
                " VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (user_id, connection_id, local_date, event) DO NOTHING RETURNING local_date",
                (self._conn.user_id, self._conn.connection_id, local_date.isoformat(), event.value, detail, dates.now_ms()),
            )
            return cursor.fetchone() is not None


@dataclass(frozen=True)
class ReportBundle:
    """report가 조립한 요약·그래프 앨범·전문 전달 입력."""

    report_date: date
    summary_text: str
    albums: tuple[tuple[Path, ...], ...]
    document_path: Path
    regenerated: bool


class ReportSink(Protocol):
    """report가 파일을 쓴 실행에서만 호출하는 전달 포트(AD-10)."""

    def deliver(self, bundle: ReportBundle) -> None: ...


NOTIFY_TIMEOUT_SECONDS = 10
NotifierFactory = Callable[[store.Connection], Notifier]

NOTICE_TEXT = {
    errors.NotifyEvent.AUTH_FAILED: (
        "Garmin 인증 실패",
        (
            "token_invalid면 `brain ext login garmin`으로 다시 인증하고, "
            "privacy_protected면 Garmin Connect 프로필 공개 범위를 확인한다."
        ),
    ),
    errors.NotifyEvent.RATE_LIMITED: (
        "Garmin 요청 제한",
        "오늘 추가 호출을 멈추고 다음 날 다시 확인한다.",
    ),
    errors.NotifyEvent.BLOCKED_403: (
        "Garmin 접근 차단",
        "오늘 추가 호출을 멈추고 다음 날 다시 확인한다.",
    ),
    errors.NotifyEvent.NORMALIZE_FAILED: (
        "정규화 실패",
        "원문 구조와 코드를 확인하고 정규화를 다시 실행한다.",
    ),
    errors.NotifyEvent.REPEATED_PARTIAL: (
        "이틀 연속 수집 미완료",
        "다음 실행 뒤에도 이어지면 collect.log의 항목 실패를 확인한다.",
    ),
    errors.NotifyEvent.ERROR: (
        "수집 오류",
        "collect.log의 사유를 확인한다. block_file_invalid면 block.json을 확인한다.",
    ),
    errors.NotifyEvent.REPORT_FAILED: (
        "리포트 작성 실패",
        "report.log와 실패 사유를 확인하고 report를 다시 실행한다.",
    ),
}


def notice_text(local_date: date, event: errors.NotifyEvent, detail: str) -> str:
    """같은 사건을 항상 같은 평문 세 줄로 만든다."""
    title, action = NOTICE_TEXT[event]
    return f"[Garmin] {local_date.isoformat()} {event.value} {title}\n{action}\n사유: {detail or '-'}"


class NoticeSender(Protocol):
    def send(
        self,
        local_date: date,
        event: errors.NotifyEvent,
        detail: str,
        *,
        timeout_seconds: float,
    ) -> errors.DeliveryReason | None: ...


def record_delivery(
    conn: store.Connection,
    local_date: date,
    kind: errors.DeliveryKind,
    ok: bool,
    reason: errors.DeliveryReason | None,
    event: errors.NotifyEvent | None = None,
) -> None:
    """전송 결과를 쓰는 유일한 지점. 비밀·본문은 저장하지 않는다."""
    with store.transaction(conn):
        store.identity_lock(conn, 'delivery')
        conn.execute(
            "INSERT INTO garmin.delivery(user_id, connection_id, local_date, kind, event, ok, reason, at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                conn.user_id, conn.connection_id, local_date.isoformat(),
                kind.value,
                event.value if event else None,
                int(ok),
                reason.value if reason else None,
                dates.now_ms(),
            ),
        )
