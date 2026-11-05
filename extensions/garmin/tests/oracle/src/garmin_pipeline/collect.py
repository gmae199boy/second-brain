"""웰니스·활동 일일 수집(`garmin-pipeline collect`)과 빠진 날 자동 메우기, 실행 중단 규칙,
하루 단위 멱등, 실패 알림(FR5~8·12·15~17·19~22, AD-4·5·6·8·10).

수집 계획은 커서·플래그 없이 저장된 데이터(`coverage.items`)에서 실행마다 유도한다. 그래서 빠진 날은
스스로 메우고, 첫 30일 백필은 며칠에 걸쳐(하루 한 번 성공 실행씩, 기본값 4일) 끝나며, 확정되지 않은
오늘·어제는 다시 받는다.

- `collect(cfg, port=None, *, sleep=time.sleep, force=False, manual=False, recent_lists=False,
  notifier_factory=None)`: 명령 시작 때
  `today`·`started_at`을 한 번 잡고 `store.write_session(cfg)` 안에서 `run`을 부른 뒤 0을 돌려준다.
  `port`가 없으면 `garmin.GarminAdapter(cfg)`, `notifier_factory`가 없으면 세션 안에서
  `ports.TableNotifier(conn)`이다. 쓰기 락을 잡지 못하면(`store.LockTimeout`) 네트워크·알림 없이
  `store.insert_run_unlocked`로 `error`(`lock_timeout`) 행 하나만 남기고 0이다. DB가 없거나 스키마
  버전이 다르거나 SQLite 오류면 그 행도 쓰지 않고 WARNING을 남긴 뒤 1이다.
- `run(conn, cfg, port, sleep, *, today, started_at, force=False, manual=False,
  recent_lists=False, notifier=None)` 순서: 수집(아래)을
  끝까지 돈 뒤(진입 표 1행 정지·"아무것도 안 함"·수집 정지·완료 모두) 같은 연결로 `normalize.run(conn, timezone=cfg.timezone)`을
  부르고 `normalize_failed`를 판정한다. 수집 순서: 남은
  `running` 행(날짜 무관)을 모두 `error`/`abandoned`(`finished_at`=지금)로 정리하고 행마다 그
  `local_date`로 `error`(`abandoned`)를 알림 → 진입 표 → `meta.history_start`
  확보(첫 실행이 `today − 30일`을 `INSERT OR IGNORE`로 쓴다) → `run`에 `running` 행 → 계획 →
  첫 호출 보호 대상 판정(아래) → 계획이 비어 있지 않을 때만
  `port.open_session(first_call_endpoints=...)` → 날짜마다 미완료 day 항목, 이어서 activity
  항목 수집 → 같은 `run` 행을 `status`·`finished_at`·`detail`로 갱신 → 끝 알림 판정.
- 진입 표(AD-5, 위에서 처음 맞는 행). `run` 행을 쓰기 전에 끝낸다.
  1. `port.blocked_today()`가 사유를 돌려주면 `skipped_blocked` 행 하나만 쓰고 끝(네트워크 0회).
     `garmin.BlockFileInvalid`면 `error`/`block_file_invalid` 행 하나로 끝.
  2. `coverage.day_status(today)`가 `not_run`·`error`·`rate_limited`·`blocked_403`이면 전체 계획.
  3. `auth_failed`이고 토큰 파일 mtime(`garmin.token_saved_at`)이 그 실행의 `finished_at`보다
     뒤(재로그인함)면 전체 계획. 파일이 없으면 이 행에 맞지 않는다.
  4. `partial`이고 `detail`에 `transient=N`이 있으면 재시도 계획: 전체 계획에서 원문을 오늘(로컬
     날짜) 확인한 항목과 오늘 `rejected`로 `fetch_error`에 남은 항목을 뺀다(day·activity 모두).
  5. 그 밖에는 `run` 행·`meta`·네트워크 없이 INFO 로그 한 줄만 남기고 끝.
  `force`면 1행만 평가하고 전체 계획으로 돈다.
- 계획: [history_start, today]의 항목 중 빼지 않았고 `coverage.incomplete`가 참인 항목의 일 키를
  최신순으로 최대 `max_dates_per_run`개. 미완료 판정은 `coverage.incomplete` 하나다(`plannable`이
  아니면 완료, `data`·`empty`가 아니면 미완료, 그 밖에는 day-scope는 `final`이 아니면, activity-scope는
  `final`과 상관없이 `fresh`가 아니면(세트 상세를 받은 뒤 소속 목록이 바뀜) 미완료). activity-scope는
  활동의 일 키로 센다. 재시도 계획도 같은 판정에 제외만 더한다. sync의 `recent_lists=True`는
  [오늘−6, 오늘]의 활동 목록을 완료 여부와 상관없이 같은 날짜 상한에 더하고, 오늘 `rejected`인
  항목만 계획 전체에서 뺀다. 오늘 확인한 원문은 빼지 않는다. 다른 day endpoint는 미완료만 받는다.
- 날짜마다 그 미완료 day 항목을 `DAY_ENDPOINTS` 순으로 부른 뒤, 그날 커버리지를 다시 구해 미완료
  activity 항목을 목록 순·`coverage.items` 순(기존 3종 다음 세트가 필요한 활동만 세트 상세)으로
  `fetch_activity`로 부른다. 그래서 방금 받은 목록의 새 활동과 바뀐 세트도 같은 실행에서 받는다.
  날짜 사이에만 `date_pause_seconds`를 쉰다.
- 첫 호출 보호(AD-6): `FIRST_CALL_ENDPOINTS` 중 세션을 열기 전(같은 연결로) `raw_response`에 원문이
  `'null'`이 아닌 행(`data`)이 하나도 없는 endpoint가 그 실행의 보호 대상이다. 판정은 실행당 한
  번이라 같은 실행에서 `data`가 생겨도 끝까지 유지되고 다음 실행부터 풀린다. 보호 대상은
  `open_session(first_call_endpoints=...)`로 세션에 알려 403을 연속 403 승격에서 빼고(없으면
  `()`), collect가 그 endpoint의 호출 시도(결과 무관)를 실행당 `FIRST_CALL_LIMIT`건으로 자른다.
  넘은 항목은 부르지 않고 건너뛴다. 실패가 아니라 `fetch_error`·`detail`에 남지 않고 다음 실행이
  다시 계획한다. 건너뛴 건수가 있으면 INFO 로그 한 줄(endpoint·건수)만 남긴다. 429는 보호와
  무관하게 실행 중단이다.
- 결과: 성공은 원문, `NoData`는 `null`로 `store.upsert_raw`. `Transient`·`Rejected`는
  `fetch_error` 한 행을 남기고 다음 항목으로 간다. 쓰기는 모두 autocommit 한 문장이라 그때까지
  저장한 원본이 남는다.
- 실행 중단: 세션 열기(로그인 단계)나 데이터 호출의 `RateLimited`→`rate_limited`,
  `Blocked403`→`blocked_403`, `AuthFailed`→`auth_failed`(사유 토큰 `token_invalid`·
  `privacy_protected`). 세션 열기의 `Transient`→`error`/`login_transient`,
  `garmin.SessionLockTimeout`→`error`/`session_lock_timeout`, `garmin.BlockFileInvalid`→
  `error`/`block_file_invalid`, `garmin.SessionBlocked`→`skipped_blocked`. 중단하면 다음 호출 없이
  세션 블록을 나가(세션 락 해제) 같은 `run` 행을 그 상태로 끝내고 0이다. `block.json`은 어댑터가
  쓴다. `fetch_error`에는 남기지 않는다. 그 밖의 예외는 그대로 전파하고 `run` 행은 `running`으로
  남는다(다음 `collect`가 `abandoned`로 정리한다). `open_session`의 `SessionBlocked`는 진입
  확인 뒤 다른 환경이 `block.json`을 쓴 경합이다.
- `detail`은 `errors.RunDetail`·`errors.AuthFailedReason` 토큰열(중단 사유 → `transient=N
  rejected=M` → `timezone_mismatch` → `manual`)이다. `manual=True`는 이번 실행 행에만 맨 뒤에
  `manual`을 붙이며 정리한 남의 `abandoned` 행은 그대로다. 중단이 없을 때 실패가 0건이면 `success`, 1건 이상이면
  `partial`이다.
- 로그에는 계획 날짜 수, 항목 실패(scope·key·endpoint·오류 이름), 중단(단계·오류 이름), 최종
  상태·detail만 남긴다. 오류는 이름만 남기고 오류 메시지·응답 본문은 남기지 않는다.

- 알림(AD-10): `notification`은 직접 쓰지 않고 주입받은 `ports.Notifier`로만 알린다. 이번 실행이
  `run` 행을 끝낸 뒤(진입 표 1행의 행 포함) `today`로 판정한다. 끝난 상태가 `auth_failed`·
  `rate_limited`·`blocked_403`·`error`면 같은 이름의 사건(`detail`은 그 실행의 `detail`)이다.
  `partial`로 끝났으면 `coverage.day_status`가 오늘과 어제 모두 `partial`이고 둘 다 `transient=N`이
  있을 때 `repeated_partial`(`detail`은 오늘 상태의 `detail`)이다. `success`·`skipped_blocked`·
  진입 표의 "아무것도 안 함"·쓰기 락 시간 초과는 알리지 않는다.
- 정규화(FR9·10·22, AD-13): 수집과 끝 알림 판정이 끝나면 같은 연결로(쓰기 락을 쥔 채) `normalize.run(conn, timezone=cfg.timezone)`을
  부른다. 그래서 죽어서 남은 원문과 정규화 버전 변경의 재구성을 매 `collect`가 줍는다. 그다음
  `normalize_result`에서 `ok = 0 AND normalized_at >= started_at`(이번 명령이 기록한 실패)인 행이 있으면
  `normalize_failed`(`today`, `detail`은 endpoint 오름차순 `<endpoint>=<건수>` 토큰을 공백으로 이은 것)를
  알린다. 이전 실행의 실패만 남았으면 알리지 않는다. 같은 날 두 번째부터는 `notification`의 (날짜, 사건)
  유일성으로 처음 행이 남는다. 쓰기 락 시간 초과 경로는 정규화도 알림도 하지 않는다. 수집이 예상 밖
  예외로 끝나지 못하면 정규화하지 않고(다음 명령이 줍는다), `normalize.run`의 예외는 그대로 전파한다.

최상위에서 stdlib과 `config`·`dates`·`errors`·`garmin`·`coverage`·`normalize`·`ports`·`store`만 import한다.
"""

import contextlib
import logging
import sqlite3
import time
from collections.abc import Callable
from datetime import date, timedelta

from garmin_pipeline import (
    config,
    coverage,
    dates,
    errors,
    garmin,
    normalize,
    ports,
    store,
)

HISTORY_START_KEY = "history_start"
HISTORY_DAYS = 30
"""첫 실행의 `history_start`는 그날 `today`에서 이만큼 앞이다."""

FIRST_CALL_ENDPOINTS = (
    coverage.EXERCISE_SETS,
    "daily_weigh_ins",
    "lifestyle_logging_data",
)
"""첫 호출 보호를 받을 수 있는 endpoint. 실행 시작 때 `data` 원문이 하나도 없으면 보호한다."""
FIRST_CALL_LIMIT = 3
"""보호 대상 endpoint를 한 실행에서 부르는 최대 시도 수(결과 무관)."""

_DAY = "day"
_ACTIVITY = "activity"
_NULL = "null"
"""`NoData`로 저장한 원문(`coverage`·`capture`와 같은 값)."""

_Reason = errors.RunDetail | errors.AuthFailedReason
_Stop = tuple[errors.RunStatus, _Reason | None]
"""실행 중단의 (run 상태, `detail` 맨 앞 사유 토큰)."""

_Exclude = Callable[[coverage.CoverageItem], bool]
"""계획에서 뺄 항목이면 참. 전체 계획은 `_exclude_nothing`, 재시도 계획은 `_retry_exclude`다."""

_Ended = tuple[errors.RunStatus, str]
"""끝낸 `run` 행의 (상태, `detail`). 끝 알림 판정에 넘긴다."""

_STOP_EVENTS = {
    errors.RunStatus.AUTH_FAILED: errors.NotifyEvent.AUTH_FAILED,
    errors.RunStatus.RATE_LIMITED: errors.NotifyEvent.RATE_LIMITED,
    errors.RunStatus.BLOCKED_403: errors.NotifyEvent.BLOCKED_403,
    errors.RunStatus.ERROR: errors.NotifyEvent.ERROR,
}
"""이 상태로 끝난 실행은 같은 이름의 사건으로 알린다(AD-10)."""

_FULL_PLAN_STATUSES = frozenset(
    {
        coverage.NOT_RUN,
        errors.RunStatus.ERROR,
        errors.RunStatus.RATE_LIMITED,
        errors.RunStatus.BLOCKED_403,
    }
)
"""진입 표 2행: 그날 상태가 이것이면 전체 계획으로 돈다."""

_DATA_STOPS = (errors.RateLimited, errors.Blocked403, errors.AuthFailed)
"""데이터 호출에서 실행을 멈추는 도메인 오류. `Transient`·`Rejected`·`NoData`는 `_fetch`가 처리한다."""

_OPEN_STOPS = (
    *_DATA_STOPS,
    errors.Transient,
    garmin.SessionLockTimeout,
    garmin.BlockFileInvalid,
    garmin.SessionBlocked,
)
"""세션 열기(로그인 단계)에서 실행을 멈추는 오류."""

logger = logging.getLogger(__name__)


def collect(
    cfg: config.Config,
    port: garmin.GarminPort | None = None,
    *,
    sleep: garmin.Sleeper = time.sleep,
    force: bool = False,
    manual: bool = False,
    recent_lists: bool = False,
    notifier_factory: ports.NotifierFactory | None = None,
) -> int:
    """쓰기 세션 안에서 한 번 수집하고 종료 코드를 돌려준다.

    0: 수집했거나, 실행을 멈추고 `run` 행을 끝냈거나(쓰기 락 시간 초과의 `lock_timeout` 행 포함),
    진입 표가 아무것도 하지 않기로 했다.
    1: 쓰기 락을 잡지 못했고 DB 없음·스키마 불일치·SQLite 오류로 `lock_timeout` 행도 쓰지 못했다.
    `force`면 진입 표에서 당일 차단만 지키고 전체 계획으로 돈다. `notifier_factory`가 없으면 세션 연결의
    `ports.TableNotifier`다. 쓰기 락을 잡지 못한 실행은 알리지 않는다(열린 연결이 없다).
    `manual`은 이번 실행 detail 맨 뒤에 붙인다. `recent_lists`는 sync 전용으로 최근 7일
    활동 목록을 상한 안에서 다시 받되 오늘 rejected 항목은 계획 전체에서 제외한다.
    """
    today = dates.today(cfg)
    started_at = dates.now_ms()
    port = port if port is not None else garmin.GarminAdapter(cfg)
    with contextlib.ExitStack() as stack:
        try:
            conn = stack.enter_context(store.write_session(cfg))
        except store.LockTimeout:
            return _record_lock_timeout(cfg, today, started_at, manual=manual)
        run(
            conn,
            cfg,
            port,
            sleep,
            today=today,
            started_at=started_at,
            force=force,
            manual=manual,
            recent_lists=recent_lists,
            notifier=(notifier_factory or ports.TableNotifier)(conn),
        )
    return 0


def run(
    conn: sqlite3.Connection,
    cfg: config.Config,
    port: garmin.GarminPort,
    sleep: garmin.Sleeper,
    *,
    today: date,
    started_at: int,
    force: bool = False,
    manual: bool = False,
    recent_lists: bool = False,
    notifier: ports.Notifier | None = None,
) -> None:
    """실행 한 번: 수집(`_collect_once`) → 정규화(`normalize.run`) → `normalize_failed` 판정.

    연결은 쓰기 세션의 autocommit 연결이다. `today`·`started_at`은 명령 시작 때 잡은 값이다.
    `notifier`가 없으면 이 연결의 `ports.TableNotifier`다.
    """
    if notifier is None:
        notifier = ports.TableNotifier(conn)
    _collect_once(
        conn,
        cfg,
        port,
        sleep,
        today=today,
        started_at=started_at,
        force=force,
        manual=manual,
        recent_lists=recent_lists,
        notifier=notifier,
    )
    normalize.run(conn, timezone=cfg.timezone)
    _notify_normalize_failed(conn, notifier, today, started_at)


def _collect_once(
    conn: sqlite3.Connection,
    cfg: config.Config,
    port: garmin.GarminPort,
    sleep: garmin.Sleeper,
    *,
    today: date,
    started_at: int,
    force: bool,
    manual: bool,
    recent_lists: bool,
    notifier: ports.Notifier,
) -> None:
    """수집 한 번: `abandoned` 정리 → 진입 표 → 계획 → 수집 → `run` 행 기록 → 끝 알림 판정."""
    _abandon_running(conn, notifier)
    entered = _enter(conn, cfg, port, today, started_at, force, manual=manual)
    if entered is None:
        return
    if isinstance(entered, tuple):
        _notify_end(conn, notifier, today, entered)
        return
    exclude = _rejected_exclude(conn, today) if recent_lists else entered
    history_start = _history_start(conn, today)
    run_id = conn.execute(
        "INSERT INTO run (local_date, started_at, status) VALUES (?, ?, ?)",
        (today.isoformat(), started_at, errors.RunStatus.RUNNING.value),
    ).lastrowid
    assert run_id is not None
    plan = _plan(conn, cfg, history_start, today, exclude, recent_lists=recent_lists)
    logger.info("collect 계획: dates=%d", len(plan))
    first_call = _first_call_endpoints(conn)

    failures = {
        coverage.FetchErrorKind.TRANSIENT: 0,
        coverage.FetchErrorKind.REJECTED: 0,
    }
    stop = (
        _collect_plan(
            conn,
            cfg,
            port,
            sleep,
            plan,
            run_id,
            today,
            failures,
            exclude,
            first_call,
        )
        if plan
        else None
    )

    if stop is not None:
        status, reason = stop
    else:
        status = (
            errors.RunStatus.PARTIAL
            if any(failures.values())
            else errors.RunStatus.SUCCESS
        )
        reason = None
    detail = _detail(cfg, failures, reason, manual=manual)
    conn.execute(
        "UPDATE run SET status = ?, finished_at = ?, detail = ? WHERE id = ?",
        (status.value, dates.now_ms(), detail, run_id),
    )
    logger.info("collect 끝: status=%s detail=%s", status, detail)
    _notify_end(conn, notifier, today, (status, detail))


def _abandon_running(conn: sqlite3.Connection, notifier: ports.Notifier) -> None:
    """남은 `running` 행(날짜 무관)을 `error`/`abandoned`로 끝내고 행마다 알린다.

    알림은 그 행의 `local_date`로 `error`(`detail`=`abandoned`)다. 예상 못 한 예외로 끝나지 못한
    실행을 알리는 유일한 경로다. 쓰기 락을 쥔 채 부른다.
    """
    rows = conn.execute(
        "UPDATE run SET status = ?, finished_at = ?, detail = ? WHERE status = ?"
        " RETURNING id, local_date",
        (
            errors.RunStatus.ERROR.value,
            dates.now_ms(),
            errors.RunDetail.ABANDONED.value,
            errors.RunStatus.RUNNING.value,
        ),
    ).fetchall()
    if not rows:
        return
    logger.warning(
        "끝나지 않은 실행을 정리했다: rows=%d status=%s detail=%s",
        len(rows),
        errors.RunStatus.ERROR,
        errors.RunDetail.ABANDONED,
    )
    for _, local_date in sorted(rows):
        notifier.notify(
            date.fromisoformat(local_date),
            errors.NotifyEvent.ERROR,
            errors.RunDetail.ABANDONED.value,
        )


def _notify_end(
    conn: sqlite3.Connection,
    notifier: ports.Notifier,
    today: date,
    ended: _Ended,
) -> None:
    """이번 실행이 끝낸 `run` 행으로 알릴 사건을 판정한다(AD-10 "실행 끝").

    `auth_failed`·`rate_limited`·`blocked_403`·`error`면 같은 이름의 사건이다. `partial`이면
    오늘과 어제의 `coverage.day_status`가 모두 `transient=N`이 있는 `partial`일 때
    `repeated_partial`이다. 그 밖(`success`·`skipped_blocked`)은 알리지 않는다.
    """
    status, detail = ended
    event = _STOP_EVENTS.get(status)
    if event is not None:
        notifier.notify(today, event, detail)
        return
    if status != errors.RunStatus.PARTIAL:
        return
    today_state = coverage.day_status(conn, today)
    yesterday_state = coverage.day_status(conn, today - timedelta(days=1))
    if _transient_partial(today_state) and _transient_partial(yesterday_state):
        notifier.notify(today, errors.NotifyEvent.REPEATED_PARTIAL, today_state.detail)


def _notify_normalize_failed(
    conn: sqlite3.Connection,
    notifier: ports.Notifier,
    today: date,
    started_at: int,
) -> None:
    """이번 명령의 정규화 실패(`ok = 0 AND normalized_at >= started_at`)가 있으면 `normalize_failed`를 알린다.

    `detail`은 endpoint 오름차순의 `<endpoint>=<건수>` 토큰을 공백으로 이은 것이다.
    """
    rows = conn.execute(
        "SELECT endpoint, count(*) FROM normalize_result"
        " WHERE ok = 0 AND normalized_at >= ? GROUP BY endpoint ORDER BY endpoint",
        (started_at,),
    ).fetchall()
    if not rows:
        return
    detail = " ".join(f"{endpoint}={count}" for endpoint, count in rows)
    logger.warning("collect 정규화 실패: %s", detail)
    notifier.notify(today, errors.NotifyEvent.NORMALIZE_FAILED, detail)


def _transient_partial(state: coverage.DayStatus) -> bool:
    """그날 상태가 `transient=N`이 있는 `partial`이면 참."""
    return state.status == errors.RunStatus.PARTIAL and _has_transient(state.detail)


def _enter(
    conn: sqlite3.Connection,
    cfg: config.Config,
    port: garmin.GarminPort,
    today: date,
    started_at: int,
    force: bool,
    *,
    manual: bool = False,
) -> _Exclude | _Ended | None:
    """진입 표(AD-5)를 위에서부터 평가한다.

    돌 계획이면 그 제외 판정을 돌려준다. 당일 차단(1행)이면 `run` 행 하나를 쓰고 그 (상태,
    `detail`)을 돌려준다. "아무것도 안 함"은 아무것도 쓰지 않고 `None`이다.
    """
    try:
        blocked = port.blocked_today()
    except garmin.BlockFileInvalid as error:
        return _record_entry_stop(
            conn, cfg, today, started_at, _stop("entry", error), manual=manual
        )
    if blocked is not None:
        logger.info("collect 중단: stage=entry blocked=%s", blocked)
        return _record_entry_stop(
            conn,
            cfg,
            today,
            started_at,
            (errors.RunStatus.SKIPPED_BLOCKED, None),
            manual=manual,
        )
    if force:
        logger.info("collect 진입: plan=full force=True")
        return _exclude_nothing
    state = coverage.day_status(conn, today)
    if state.status in _FULL_PLAN_STATUSES or (
        state.status == errors.RunStatus.AUTH_FAILED and _logged_in_again(cfg, state)
    ):
        logger.info("collect 진입: plan=full day_status=%s", state.status)
        return _exclude_nothing
    if state.status == errors.RunStatus.PARTIAL and _has_transient(state.detail):
        logger.info("collect 진입: plan=retry day_status=%s", state.status)
        return _retry_exclude(conn, cfg, today)
    logger.info("collect 건너뜀: day_status=%s detail=%s", state.status, state.detail)
    return None


def _logged_in_again(cfg: config.Config, state: coverage.DayStatus) -> bool:
    """토큰 파일 mtime이 그 `auth_failed` 실행의 `finished_at`보다 뒤면 참(파일이 없으면 거짓).

    무인 로그인은 만료가 가까운 토큰을 갱신하며 파일을 다시 쓸 수 있어 `started_at`이 아니라
    `finished_at`과 비교한다. 대화형 `login`은 세션 락을 쥐고 쓰므로 실패 실행이 끝난 뒤다.
    """
    saved_at = garmin.token_saved_at(cfg)
    return (
        saved_at is not None
        and state.finished_at is not None
        and saved_at > state.finished_at
    )


def _has_transient(detail: str) -> bool:
    """`detail`에 `transient=N` 토큰이 있으면 참."""
    prefix = f"{errors.RunDetail.TRANSIENT.value}="
    return any(token.startswith(prefix) for token in detail.split())


def _exclude_nothing(item: coverage.CoverageItem) -> bool:
    """전체 계획: 아무 항목도 빼지 않는다."""
    return False


def _retry_exclude(
    conn: sqlite3.Connection, cfg: config.Config, today: date
) -> _Exclude:
    """재시도 계획의 제외 판정: 원문을 오늘 확인한 항목, 오늘 `rejected`로 남은 항목(FR20)."""
    today_key = today.isoformat()
    rejected = _rejected_exclude(conn, today)

    def exclude(item: coverage.CoverageItem) -> bool:
        return (
            item.checked_at is not None
            and dates.day_key(item.checked_at, cfg) == today_key
        ) or rejected(item)

    return exclude


def _rejected_exclude(conn: sqlite3.Connection, today: date) -> _Exclude:
    """오늘 거부된 항목만 뺀다. sync는 오늘 확인한 원문도 다시 받을 수 있다."""
    rejected = frozenset(
        conn.execute(
            "SELECT scope, key, endpoint FROM fetch_error"
            " WHERE kind = ? AND local_date = ?",
            (coverage.FetchErrorKind.REJECTED.value, today.isoformat()),
        ).fetchall()
    )

    def exclude(item: coverage.CoverageItem) -> bool:
        return (item.scope, item.key, item.endpoint) in rejected

    return exclude


def _record_entry_stop(
    conn: sqlite3.Connection,
    cfg: config.Config,
    today: date,
    started_at: int,
    stop: _Stop,
    *,
    manual: bool = False,
) -> _Ended:
    """진입 표에서 끝낸 실행의 `run` 행 하나(끝난 상태)를 쓰고 그 (상태, `detail`)을 돌려준다."""
    status, reason = stop
    detail = _detail(cfg, None, reason, manual=manual)
    conn.execute(
        "INSERT INTO run (local_date, started_at, finished_at, status, detail)"
        " VALUES (?, ?, ?, ?, ?)",
        (today.isoformat(), started_at, dates.now_ms(), status.value, detail),
    )
    logger.info("collect 끝: status=%s detail=%s", status, detail)
    return status, detail


def _collect_plan(
    conn: sqlite3.Connection,
    cfg: config.Config,
    port: garmin.GarminPort,
    sleep: garmin.Sleeper,
    plan: list[tuple[date, list[str]]],
    run_id: int,
    today: date,
    failures: dict[coverage.FetchErrorKind, int],
    exclude: _Exclude,
    first_call: tuple[str, ...],
) -> _Stop | None:
    """세션을 열어 계획을 수집한다. 실행을 멈추면 그 (상태, 사유 토큰)을 돌려준다.

    멈추면 다음 호출 없이 세션 블록을 나가 세션 락을 푼다. 항목 실패 건수는 `failures`에 센다.
    `first_call`(첫 호출 보호 대상)은 세션에 알리고, 그 endpoint의 호출 시도는 실행당
    `FIRST_CALL_LIMIT`건까지만 하고 나머지는 건너뛴다.
    """
    attempts = dict.fromkeys(first_call, 0)
    skipped = dict.fromkeys(first_call, 0)

    def over_limit(endpoint: str) -> bool:
        """보호 대상이 상한을 채웠으면 건너뛴 건수를 세고 참, 아니면 시도를 세고 거짓."""
        if endpoint not in attempts:
            return False
        if attempts[endpoint] >= FIRST_CALL_LIMIT:
            skipped[endpoint] += 1
            return True
        attempts[endpoint] += 1
        return False

    try:
        with contextlib.ExitStack() as stack:
            try:
                session = stack.enter_context(
                    port.open_session(first_call_endpoints=first_call)
                )
            except _OPEN_STOPS as error:
                return _stop("login", error)
            try:
                for index, (day, endpoints) in enumerate(plan):
                    if index:
                        sleep(cfg.date_pause_seconds)
                    for endpoint in endpoints:
                        if over_limit(endpoint):
                            continue
                        kind = _fetch(
                            conn,
                            session,
                            run_id,
                            today,
                            _DAY,
                            day.isoformat(),
                            endpoint,
                        )
                        if kind is not None:
                            failures[kind] += 1
                    for item in _pending_activities(conn, cfg, day, exclude):
                        if over_limit(item.endpoint):
                            continue
                        kind = _fetch(
                            conn,
                            session,
                            run_id,
                            today,
                            _ACTIVITY,
                            item.key,
                            item.endpoint,
                        )
                        if kind is not None:
                            failures[kind] += 1
            except _DATA_STOPS as error:
                return _stop("data", error)
        return None
    finally:
        for endpoint, count in skipped.items():
            if count:
                logger.info(
                    "collect 첫 호출 보호로 건너뜀: endpoint=%s skipped=%d",
                    endpoint,
                    count,
                )


def _first_call_endpoints(conn: sqlite3.Connection) -> tuple[str, ...]:
    """`FIRST_CALL_ENDPOINTS` 중 `data` 원문(`'null'`이 아닌 `raw_response` 행)이 없는 것."""
    return tuple(
        endpoint
        for endpoint in FIRST_CALL_ENDPOINTS
        if conn.execute(
            "SELECT 1 FROM raw_response WHERE endpoint = ? AND raw != ? LIMIT 1",
            (endpoint, _NULL),
        ).fetchone()
        is None
    )


def _stop(stage: str, error: Exception) -> _Stop:
    """중단 오류를 (상태, 사유 토큰)으로 바꾸고 단계·오류 이름만 로그에 남긴다."""
    # 당일 차단으로 건너뛰는 것은 예정된 결과라 어댑터처럼 INFO다.
    level = (
        logging.INFO if isinstance(error, garmin.SessionBlocked) else logging.WARNING
    )
    logger.log(level, "collect 중단: stage=%s error=%s", stage, type(error).__name__)
    if isinstance(error, errors.RateLimited):
        return errors.RunStatus.RATE_LIMITED, None
    if isinstance(error, errors.Blocked403):
        return errors.RunStatus.BLOCKED_403, None
    if isinstance(error, errors.AuthFailed):
        return errors.RunStatus.AUTH_FAILED, error.reason
    if isinstance(error, garmin.SessionBlocked):
        return errors.RunStatus.SKIPPED_BLOCKED, None
    if isinstance(error, garmin.SessionLockTimeout):
        return errors.RunStatus.ERROR, errors.RunDetail.SESSION_LOCK_TIMEOUT
    if isinstance(error, garmin.BlockFileInvalid):
        return errors.RunStatus.ERROR, errors.RunDetail.BLOCK_FILE_INVALID
    assert isinstance(error, errors.Transient), type(error)
    return errors.RunStatus.ERROR, errors.RunDetail.LOGIN_TRANSIENT


def _record_lock_timeout(
    cfg: config.Config, today: date, started_at: int, *, manual: bool = False
) -> int:
    """쓰기 락 없이 `error`(`lock_timeout`) 행 하나를 남긴다. 못 남기면 1, 남기면 0이다.

    DB 없음·스키마 불일치·SQLite 오류(busy 대기 초과, DB가 아닌 파일 등)면 오류 이름만 WARNING으로
    남기고 1이다.
    """
    status = errors.RunStatus.ERROR
    detail = _detail(cfg, None, errors.RunDetail.LOCK_TIMEOUT, manual=manual)
    logger.warning(
        "collect 중단: stage=write_lock error=%s", store.LockTimeout.__name__
    )
    try:
        store.insert_run_unlocked(
            cfg,
            local_date=today.isoformat(),
            started_at=started_at,
            finished_at=dates.now_ms(),
            status=status.value,
            detail=detail,
        )
    except (store.DbMissing, store.SchemaMismatch, sqlite3.Error) as error:
        logger.warning(
            "lock_timeout 실행 행을 남기지 못했다: error=%s", type(error).__name__
        )
        return 1
    logger.info("collect 끝: status=%s detail=%s", status, detail)
    return 0


def _detail(
    cfg: config.Config,
    failures: dict[coverage.FetchErrorKind, int] | None,
    reason: _Reason | None = None,
    *,
    manual: bool = False,
) -> str:
    """사유, 실패 건수, `timezone_mismatch`, `manual` 순으로 붙인다."""
    tokens = [] if reason is None else [reason.value]
    if failures is not None:
        counts = (
            (errors.RunDetail.TRANSIENT, failures[coverage.FetchErrorKind.TRANSIENT]),
            (errors.RunDetail.REJECTED, failures[coverage.FetchErrorKind.REJECTED]),
        )
        tokens.extend(f"{token}={count}" for token, count in counts if count)
    system_zone = dates.system_timezone()
    if system_zone is not None and system_zone != cfg.timezone:
        tokens.append(errors.RunDetail.TIMEZONE_MISMATCH.value)
    if manual:
        tokens.append(errors.RunDetail.MANUAL.value)
    return " ".join(tokens)


def _history_start(conn: sqlite3.Connection, today: date) -> date:
    """`meta.history_start`. 없으면 `today − 30일`을 한 번만 쓴다."""
    value = _meta(conn, HISTORY_START_KEY)
    if value is None:
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
            (HISTORY_START_KEY, (today - timedelta(days=HISTORY_DAYS)).isoformat()),
        )
        value = _meta(conn, HISTORY_START_KEY)
        assert value is not None
    return date.fromisoformat(value)


def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return None if row is None else row[0]


def _plan(
    conn: sqlite3.Connection,
    cfg: config.Config,
    history_start: date,
    today: date,
    exclude: _Exclude,
    *,
    recent_lists: bool = False,
) -> list[tuple[date, list[str]]]:
    """(날짜, 그날 미완료 day endpoint 목록 `DAY_ENDPOINTS` 순)을 최신순으로 최대 `max_dates_per_run`개.

    미완료 activity 항목만 있는 날짜는 빈 목록으로 들어간다. 그 항목은 수집 때 다시 구한다.
    `exclude`가 참인 항목은 상한을 세기 전에 뺀다.
    `recent_lists`면 최근 7일 활동 목록도 완료 여부와 상관없이 같은 날짜 상한에 넣는다.
    """
    if history_start > today:
        return []
    pending: dict[str, list[str]] = {}
    for item in coverage.items(conn, cfg, history_start, today):
        recent_list = (
            recent_lists
            and item.scope == _DAY
            and item.endpoint == "activities_by_date"
            and item.day_key >= (today - timedelta(days=6)).isoformat()
        )
        if exclude(item) or not (recent_list or coverage.incomplete(item)):
            continue
        endpoints = pending.setdefault(item.day_key, [])
        if item.scope == _DAY:
            endpoints.append(item.endpoint)
    keys = sorted(pending, reverse=True)[: cfg.max_dates_per_run]
    return [(date.fromisoformat(key), pending[key]) for key in keys]


def _pending_activities(
    conn: sqlite3.Connection, cfg: config.Config, day: date, exclude: _Exclude
) -> list[coverage.CoverageItem]:
    """그날 일 키의 미완료 activity 항목(`coverage.items` 순). 방금 받은 목록도 본다."""
    return [
        item
        for item in coverage.items(conn, cfg, day, day)
        if item.scope == _ACTIVITY and not exclude(item) and coverage.incomplete(item)
    ]


def _fetch(
    conn: sqlite3.Connection,
    session: garmin.GarminSession,
    run_id: int,
    today: date,
    scope: str,
    key: str,
    endpoint: str,
) -> coverage.FetchErrorKind | None:
    """항목 하나를 받아 저장한다. 항목 실패면 `fetch_error`를 남기고 그 종류를 돌려준다.

    `key`는 day-scope면 일 키, activity-scope면 activityId 문자열이다.
    """
    try:
        if scope == _DAY:
            response = session.fetch_day(endpoint, date.fromisoformat(key))
        else:
            response = session.fetch_activity(endpoint, int(key))
    except errors.NoData:
        payload, library_version = None, garmin.LIBRARY_VERSION
    except (errors.Transient, errors.Rejected) as error:
        kind = (
            coverage.FetchErrorKind.TRANSIENT
            if isinstance(error, errors.Transient)
            else coverage.FetchErrorKind.REJECTED
        )
        conn.execute(
            "INSERT INTO fetch_error"
            " (run_id, scope, key, endpoint, kind, local_date, occurred_at, error_code)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                scope,
                key,
                endpoint,
                kind.value,
                today.isoformat(),
                dates.now_ms(),
                kind.value,
            ),
        )
        logger.warning(
            "항목 실패: scope=%s key=%s endpoint=%s error=%s",
            scope,
            key,
            endpoint,
            type(error).__name__,
        )
        return kind
    else:
        payload, library_version = response.payload, response.library_version
    store.upsert_raw(
        conn,
        scope=scope,
        key=key,
        endpoint=endpoint,
        payload=payload,
        library_version=library_version,
        now_ms=dates.now_ms(),
    )
    return None
