"""사람에게 알릴 실패를 받는 교체 지점(FR22, AD-8·10).

- `Notifier`: `notify(local_date, event, detail)` 하나뿐인 프로토콜이다. 나중에 Slack·Telegram
  구현체로 바꿀 때 이 프로토콜만 맞춘다.
- `TableNotifier(conn)`: 열린 쓰기 세션 연결에 `notification` 행 하나를 `ON CONFLICT DO NOTHING`로 쓴다.
  `at`은 `dates.now_ms()`(UTC epoch ms)다. (`local_date`, `event`)가 UNIQUE라 같은 날 같은
  사건은 처음 기록한 행(`at`·`detail` 포함)이 남는다. 새 행이면 True다. 쓰기 락 안에서만 쓴다(AD-8).
- `TelegramNotifier`: 표에 새 행을 커밋한 뒤 예산 안에서 한 번 보내고 `delivery`에 결과를 남긴다.
- `ReportSink`: `deliver(bundle)` 하나뿐인 프로토콜이다. `report`가 리포트 파일을 쓴 뒤
  부른다(AD-10). `TelegramReportSink`는 요약 → 앨범 → 전문 순서로 보내고 결과 기록은 주입한다.

stdlib과 `dates`·`errors`·`telegram`만 import한다.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from time import sleep as _sleep
from typing import Protocol

from garmin_pipeline import dates, errors, store, telegram


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


SEND_INTERVAL_SECONDS = 1.0
REPORT_SEND_TIMEOUT_SECONDS = 30
REGENERATED_MARK = "[재생성] "
DeliveryRecorder = Callable[
    [date, errors.DeliveryKind, errors.DeliveryReason | None], None
]


class TelegramReportSink:
    """쓰기 연결 없이 보내고 항목마다 주입된 함수로 결과를 기록한다."""

    def __init__(
        self,
        tokenstore: Path,
        *,
        record: DeliveryRecorder,
        api_base: str = telegram.API_BASE,
        session=None,
    ):
        self._adapter = telegram.TelegramAdapter(
            tokenstore, api_base=api_base, session=session
        )
        self._record = record

    def deliver(self, bundle: ReportBundle) -> None:
        text = (REGENERATED_MARK if bundle.regenerated else "") + bundle.summary_text
        items = [(errors.DeliveryKind.REPORT_TEXT, self._adapter.send_message, text)]
        for album in bundle.albums:
            for offset in range(0, len(album), 10):
                batch = album[offset : offset + 10]
                method = (
                    self._adapter.send_photo
                    if len(batch) == 1
                    else self._adapter.send_media_group
                )
                items.append(
                    (
                        errors.DeliveryKind.REPORT_ALBUM,
                        method,
                        batch[0] if len(batch) == 1 else batch,
                    )
                )
        items.append(
            (
                errors.DeliveryKind.REPORT_DOCUMENT,
                self._adapter.send_document,
                bundle.document_path,
            )
        )
        for index, (kind, send, value) in enumerate(items):
            try:
                if index:
                    _sleep(SEND_INTERVAL_SECONDS)
                reason = send(
                    value,
                    timeout_seconds=REPORT_SEND_TIMEOUT_SECONDS,
                    wait_rate_limit=True,
                )
            except Exception as error:  # noqa: BLE001 - 항목 실패 뒤에도 계속 보낸다
                logger.warning("Telegram: network (%s)", type(error).__name__)
                reason = errors.DeliveryReason.NETWORK
            try:
                self._record(bundle.report_date, kind, reason)
            except Exception as error:  # noqa: BLE001 - 기록 실패 뒤에도 계속 보낸다
                logger.warning("delivery 기록 실패 (%s)", type(error).__name__)


NOTIFY_TIMEOUT_SECONDS = 10
MIN_NOTIFY_TIMEOUT_SECONDS = 1
logger = logging.getLogger(__name__)
NotifierFactory = Callable[[store.Connection], Notifier]

NOTICE_TEXT = {
    errors.NotifyEvent.AUTH_FAILED: (
        "Garmin 인증 실패",
        (
            "token_invalid면 `garmin-pipeline login`으로 다시 로그인하고, "
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


class TelegramNoticeSender:
    def __init__(
        self, tokenstore: Path, *, api_base: str = telegram.API_BASE, session=None
    ):
        self._adapter = telegram.TelegramAdapter(
            tokenstore, api_base=api_base, session=session
        )

    def send(
        self,
        local_date: date,
        event: errors.NotifyEvent,
        detail: str,
        *,
        timeout_seconds: float,
    ) -> errors.DeliveryReason | None:
        return self._adapter.send_message(
            notice_text(local_date, event, detail), timeout_seconds=timeout_seconds
        )


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


class TelegramNotifier:
    def __init__(
        self, conn: store.Connection, sender: NoticeSender, *, budget_seconds: float
    ):
        self._conn = conn
        self._table = TableNotifier(conn)
        self._sender = sender
        self._remaining = budget_seconds

    def notify(self, local_date: date, event: errors.NotifyEvent, detail: str) -> bool:
        if not self._table.notify(local_date, event, detail):
            return False
        timeout = min(NOTIFY_TIMEOUT_SECONDS, self._remaining)
        reason = errors.DeliveryReason.NETWORK
        if timeout < MIN_NOTIFY_TIMEOUT_SECONDS:
            logger.warning("Telegram: network (budget_exhausted)")
        else:
            self._remaining -= timeout
            try:
                reason = self._sender.send(
                    local_date, event, detail, timeout_seconds=timeout
                )
            except Exception as error:  # noqa: BLE001 - 전송 실패는 사유만 남기고 명령을 계속한다
                logger.warning("Telegram: network (%s)", type(error).__name__)
        try:
            record_delivery(
                self._conn,
                local_date,
                errors.DeliveryKind.NOTIFY,
                reason is None,
                reason,
                event,
            )
        except Exception as error:  # noqa: BLE001 - 전송 실패는 사유만 남기고 명령을 계속한다
            logger.warning("delivery 기록 실패 (%s)", type(error).__name__)
        return True
