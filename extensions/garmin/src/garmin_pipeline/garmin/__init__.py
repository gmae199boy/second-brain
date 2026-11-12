"""Garmin 어댑터: 무인 세션 열기, 계정 단위 당일 차단, 로그인 예외의 도메인 오류 변환(AD-1·5·6).

- 호출자는 `GarminPort`(`blocked_today()`·`open_session()`)로만 쓴다. 실제 구현은
  `GarminAdapter(cfg)`이고 테스트는 `tests/garmin_fakes.py`의 `FakeGarmin`으로 바꾼다.
- `open_session()` 순서: tokenstore가 디렉터리가 아니면 아무것도 만들지 않고
  `AuthFailed(token_invalid)` → `<tokenstore>/.session.lock` `flock(LOCK_EX)` → `block.json`
  확인 → `_new_client()` → (`cffi_api_session`이면 API 세션 교체) → `login(tokenstore)` →
  블록 실행. 블록을 나가면 정상이든 예외든 락을 푼다.
- 당일 차단은 `<tokenstore>/block.json` 하나다. 오늘 날짜면 로그인하지 않고 `SessionBlocked`,
  지난 날짜는 무시하고 지우지 않는다. 깨진 파일은 네트워크 없이 `BlockFileInvalid`다.
- 로그인 단계의 `garminconnect` 예외와 `OSError`만 `errors`의 도메인 오류로 바꾼다. 그 밖의
  예외는 그대로 전파한다. 429·403이면 `block.json`을 쓴 뒤 던진다.
- 세션의 데이터 호출은 `fetch_day(endpoint, day)`(`DAY_ENDPOINTS`)·`fetch_activity(endpoint,
  activity_id)`(`ACTIVITY_ENDPOINTS`)뿐이다. 라이브러리가 디코드한 원문을 그대로
  `RawResponse`에 담고, 데이터 단계 예외를 도메인 오류로 바꾸며(429·401·403·404·4xx·5xx·
  상태 없음), 연속 403을 `Blocked403`로 승격한다. 429·`Blocked403`이면 `block.json`을 쓰고 그
  세션의 이후 호출은 네트워크 없이 `SessionBlocked`다. 매 데이터 호출 직전에 설정 간격을 쉰다.
- 첫 호출 보호(AD-6): `open_session(first_call_endpoints=...)`로 받은 endpoint의 403은 `Rejected`
  그대로지만 연속 403을 늘리지도 되돌리지도 않는다(승격 없음). 어느 endpoint를 보호할지는 호출자
  (`collect`)가 저장 상태로 정한다. 모르는 이름이면 락·네트워크 전에 `ValueError`다.
- 대화형 로그인(`login` 명령)은 `interactive_login(cfg, prompts)` 하나다. 비밀번호·이메일은
  파라미터가 아니라 `LoginPrompts`(`credentials()`·`mfa_code()`)로 받는다. 순서: `block.json`이
  오늘이면 프롬프트·네트워크 없이 `SessionBlocked` → 락 밖에서 `credentials()` → 세션 락 →
  차단 재확인 → 클라이언트 생성(`cffi_api_session`이면 같은 교체) → 자격 증명 로그인
  (`return_on_mfa=True`). MFA가 필요하면 락을 놓고 `mfa_code()`를 부른 뒤 다시 락 → 차단
  재확인 → 같은 인스턴스로 `resume_login`(틀린 코드는 최대 `MFA_MAX_ATTEMPTS`번), MFA가 없으면
  프로필 확인. 끝으로 락을 쥔 채 tokenstore에 토큰을 쓴다(`garmin_tokens.json`, 0600). 기존
  토큰은 읽지 않고 늘 자격 증명으로 새로 로그인한다. 로그인 단계 예외는 무인 세션과 같은 규칙으로
  바꾸고, 토큰 쓰기의 `OSError`는 바꾸지 않고 그대로 던진다.
- 토큰 파일은 `<tokenstore>/garmin_tokens.json`(`TOKEN_FILENAME`, 라이브러리가 쓰는 이름)이다.
  `token_saved_at(cfg)`는 그 mtime(UTC epoch ms)만 읽고, 파일이 없거나 읽을 수 없으면 `None`이다.
  `collect`의 재로그인 판정(AD-5)이 쓴다.
- 라이브러리 클라이언트는 `_new_client()` 하나에서만 만든다. 테스트는 이것만 바꾼다.
- 로그와 도메인 오류 메시지에는 단계·endpoint·상태 코드·오류 이름·연속 403 횟수·첫 호출 보호
  여부·차단 사유(대화형 로그인은 MFA 여부·시도 횟수도)만 남긴다. 라이브러리 예외 문자열, 토큰, 응답 본문, 이메일,
  비밀번호, MFA 코드, 날짜, activityId는 남기지 않는다(AD-12).

패키지 모듈은 `config`·`dates`·`errors`만 import한다. `garminconnect`·`curl_cffi`를 직접
import하는 곳은 이 패키지뿐이다.
"""

import contextlib
import fcntl
import functools
import importlib.metadata
import json
import logging
import os
import random
import re
import stat
import tempfile
import time
from collections.abc import Callable, Collection, Iterator
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Protocol, runtime_checkable

import garminconnect
from curl_cffi import requests as cffi_requests

from garmin_pipeline import config, dates, errors

BLOCK_FILENAME = "block.json"
BLOCK_SCHEMA_VERSION = 1
BLOCK_REASONS = (errors.RunStatus.RATE_LIMITED, errors.RunStatus.BLOCKED_403)
SESSION_LOCK_FILENAME = ".session.lock"
TOKEN_FILENAME = "garmin_tokens.json"
"""tokenstore 안 토큰 파일 이름. `garminconnect.client.token_file_path(<폴더>)`의 이름과 같다."""
MFA_MAX_ATTEMPTS = 3
"""대화형 로그인에서 틀린 MFA 코드를 같은 인스턴스로 다시 묻는 최대 횟수(첫 시도 포함)."""

_LOCK_RETRY_SECONDS = 0.1
_BLOCK_KEYS = frozenset({"schema_version", "local_date", "reason"})
_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_STATUS_IN_MESSAGE = re.compile(r"(?:API Error|Error|HTTP)\s*(\d{3})")
_LIBRARY_PACKAGE = "garminconnect"
_LOGIN_STAGE = "login"
_DATA_STAGE = "data"

DAY_ENDPOINTS = (
    "sleep_data",
    "hrv_data",
    "rhr_day",
    "heart_rates",
    "stress_data",
    "body_battery",
    "user_summary",
    "training_readiness",
    "daily_weigh_ins",
    "lifestyle_logging_data",
    "activities_by_date",
)
"""날짜 하나(`day`)로 부르는 endpoint. 이름은 라이브러리 메서드 이름에서 `get_`을 뺀 것이다."""

ACTIVITY_ENDPOINTS = (
    "activity",
    "activity_details",
    "activity_hr_in_timezones",
    "activity_exercise_sets",
)
"""activityId 하나로 부르는 endpoint. 이름 규칙은 `DAY_ENDPOINTS`와 같다.

어느 활동에 무엇을 부를지는 호출자(`coverage.items`)가 정한다. `activity_exercise_sets`(세트 상세)는
세트가 필요한 활동에만 부른다.
"""

LIBRARY_VERSION = importlib.metadata.version(_LIBRARY_PACKAGE)
"""원문을 받은 `garminconnect` 배포 버전. 라이브러리에 `__version__`이 없어 메타데이터로 읽는다."""

logger = logging.getLogger(__name__)

# 이 프로세스의 `open_session`이 지금 쥐고 있는 세션 락 파일의 (st_dev, st_ino).
# 같은 파일을 다른 fd로 다시 flock하면 자기 자신과 충돌해 대기 끝까지 막히므로 미리 거부한다.
_held_locks: set[tuple[int, int]] = set()


class GarminAdapterError(Exception):
    """어댑터 실행 환경 오류의 바탕. Garmin 실패(`errors.DomainError`)와 섞이지 않게 따로 둔다."""


class SessionLockTimeout(GarminAdapterError):
    """`lock_wait_seconds` 안에 세션 락을 잡지 못했다."""

    reason = "session_lock_timeout"


class SessionBlocked(GarminAdapterError):
    """오늘 날짜의 당일 차단이 있어 로그인하지 않았다. `.reason`은 차단 사유(`RunStatus`)다.

    같은 날 두 번째 실행은 `rate_limited`·`blocked_403`가 아니라 `skipped_blocked`로 남기므로
    도메인 오류(`RateLimited` 등)로 던지지 않는다.
    """

    def __init__(self, reason: errors.RunStatus | str) -> None:
        self.reason = errors.RunStatus(reason)
        super().__init__(f"Garmin 당일 차단 중이다: {self.reason}")


class BlockFileInvalid(GarminAdapterError):
    """`block.json`을 읽지 못했거나 형식이 틀렸다. 차단 여부를 모르므로 Garmin에 닿지 않는다."""


@dataclass(frozen=True)
class RawResponse:
    """데이터 호출 하나의 원문. `payload`는 라이브러리가 디코드한 값 그대로다(복사·가공 없음)."""

    endpoint: str
    payload: object
    library_version: str


@runtime_checkable
class GarminSession(Protocol):
    """열린 Garmin 세션. 실제 구현은 `GarminAdapter.open_session()`, 테스트는 `FakeSession`이다.

    실패는 `errors`의 도메인 오류다. `NoData`(빈 응답·404)는 원본 `null`, `Rejected`·`Transient`는
    그 항목만 실패, `RateLimited`·`Blocked403`·`AuthFailed`는 실행 중단이다. 당일 차단을 기록한
    세션의 이후 호출은 `SessionBlocked`다. 모르는 endpoint는 네트워크 없이 `ValueError`다.
    """

    def fetch_day(self, endpoint: str, day: date) -> RawResponse:
        """`DAY_ENDPOINTS`의 `endpoint`를 날짜 `day`로 부른다."""
        ...

    def fetch_activity(self, endpoint: str, activity_id: int) -> RawResponse:
        """`ACTIVITY_ENDPOINTS`의 `endpoint`를 `activity_id`로 부른다."""
        ...


@runtime_checkable
class GarminPort(Protocol):
    """호출자가 쓰는 Garmin 통로. 실제 구현은 `GarminAdapter`, 테스트는 `FakeGarmin`이다."""

    def blocked_today(self) -> errors.RunStatus | None:
        """오늘 날짜의 당일 차단 사유. 없으면 `None`이다. 네트워크를 쓰지 않는다."""
        ...

    def open_session(
        self, *, first_call_endpoints: Collection[str] = ()
    ) -> AbstractContextManager[GarminSession]:
        """세션 락을 잡고 로그인한 세션을 내주는 context manager. 락은 블록 끝까지 쥔다.

        `first_call_endpoints`의 403은 그 세션의 연속 403 승격에 세지 않는다(첫 호출 보호).
        """
        ...


@runtime_checkable
class LoginPrompts(Protocol):
    """대화형 로그인이 사용자에게 묻는 통로. 실제 구현은 `auth`의 터미널 프롬프트, 테스트는 대역이다.

    `interactive_login`은 세션 락을 쥐지 않은 동안에만 부른다. 빈 입력·취소는 구현이 예외로 알리고
    어댑터는 그 예외를 그대로 전파한다.
    """

    def credentials(self) -> tuple[str, str]:
        """(이메일, 비밀번호)."""
        ...

    def mfa_code(self) -> str:
        """MFA 코드 하나. 틀린 코드면 다시 불린다."""
        ...


Sleeper = Callable[[float], object]


def _display_name_url(client: garminconnect.Garmin, base: str) -> str:
    return f"{base}/{client._require_display_name()}"


# 라이브러리의 user_summary·heart_rates 메서드는 빈 응답을 상태 없는 예외로 바꿔 `NoData`를 구별할
# 수 없게 하므로, 그 메서드와 같은 URL·params로 `connectapi`를 직접 부른다(데코레이터·재시도는 같다).
_DAY_CALLS: dict[str, Callable[[garminconnect.Garmin, str], object]] = {
    "sleep_data": lambda client, day: client.get_sleep_data(day),
    "hrv_data": lambda client, day: client.get_hrv_data(day),
    "rhr_day": lambda client, day: client.get_rhr_day(day),
    "heart_rates": lambda client, day: client.connectapi(
        _display_name_url(client, client.garmin_connect_heartrates_daily_url),
        params={"date": day},
    ),
    "stress_data": lambda client, day: client.get_stress_data(day),
    "body_battery": lambda client, day: client.get_body_battery(day, day),
    "user_summary": lambda client, day: client.connectapi(
        _display_name_url(client, client.garmin_connect_daily_summary_url),
        params={"calendarDate": day},
    ),
    "training_readiness": lambda client, day: client.get_training_readiness(day),
    "daily_weigh_ins": lambda client, day: client.get_daily_weigh_ins(day),
    "lifestyle_logging_data": lambda client, day: client.get_lifestyle_logging_data(day),
    # 페이징은 라이브러리가 내부에서 한다.
    "activities_by_date": lambda client, day: client.get_activities_by_date(day, day),
}

_ACTIVITY_CALLS: dict[str, Callable[[garminconnect.Garmin, int], object]] = {
    "activity": lambda client, activity_id: client.get_activity(activity_id),
    # 라이브러리 기본 인자(maxchart·maxpoly)로 부르고 원문을 파싱하지 않는다.
    "activity_details": lambda client, activity_id: client.get_activity_details(
        activity_id
    ),
    "activity_hr_in_timezones": lambda client, activity_id: (
        client.get_activity_hr_in_timezones(activity_id)
    ),
    # `/activity-service/activity/{id}/exerciseSets`. 원문을 파싱하지 않는다.
    "activity_exercise_sets": lambda client, activity_id: (
        client.get_activity_exercise_sets(activity_id)
    ),
}


class _Session:
    """`GarminSession` 구현. 로그인한 라이브러리 클라이언트와 세션 단위 상태(연속 403·차단)를 쥔다.

    `open_session()` 블록 안(세션 락을 쥔 동안)에서만 쓴다. `first_call`은 403을 연속 403에 세지
    않는 endpoint 집합(첫 호출 보호)이다.
    """

    def __init__(
        self,
        client: garminconnect.Garmin,
        cfg: config.Config,
        tokenstore: Path,
        sleep: Sleeper,
        first_call: frozenset[str] = frozenset(),
    ) -> None:
        self._client = client
        self._cfg = cfg
        self._tokenstore = tokenstore
        self._sleep = sleep
        self._consecutive_403 = 0
        self._first_call = first_call
        self._blocked: errors.RunStatus | None = None

    def fetch_day(self, endpoint: str, day: date) -> RawResponse:
        call = _DAY_CALLS.get(endpoint)
        if call is None:
            raise ValueError(f"모르는 day endpoint다: {endpoint!r}")
        if not isinstance(day, date) or isinstance(day, datetime):
            raise TypeError(f"day는 date여야 한다: {type(day).__name__}")
        iso_day = day.isoformat()
        return self._fetch(endpoint, lambda: call(self._client, iso_day))

    def fetch_range(self, endpoint: str, start: date, end: date) -> RawResponse:
        """설치 라이브러리 0.3.20의 기간 API. 각 HTTP 페이지도 호출 보호를 거친다."""
        first, last = start.isoformat(), end.isoformat()
        if start > end or (end - start).days >= 7:
            raise ValueError('invalid range')
        if endpoint == 'daily_weigh_ins':
            return self._fetch(endpoint, lambda: self._client.get_weigh_ins(first, last))
        if endpoint == 'body_battery':
            return self._fetch(endpoint, lambda: self._client.get_body_battery(first, last))
        if endpoint != 'activities_by_date':
            raise ValueError('unsupported range endpoint')
        activities = []
        # 라이브러리 get_activities_by_date와 같은 20행 페이지를 사용하되 각 페이지를 보호한다.
        for offset in range(0, 20000, 20):
            try:
                page = self._fetch(endpoint, lambda: self._client.connectapi(self._client.garmin_connect_activities,
                    params={'startDate': first, 'endDate': last, 'start': str(offset), 'limit': '20'}))
            except errors.NoData:
                return RawResponse(endpoint, activities, LIBRARY_VERSION)
            if not isinstance(page.payload, list):
                raise errors.InvalidResponse('expected_range_list')
            activities.extend(page.payload)
        raise errors.InvalidResponse('activity_range_pagination_limit')

    def fetch_activity(self, endpoint: str, activity_id: int) -> RawResponse:
        call = _ACTIVITY_CALLS.get(endpoint)
        if call is None:
            raise ValueError(f"모르는 activity endpoint다: {endpoint!r}")
        return self._fetch(endpoint, lambda: call(self._client, activity_id))

    def _fetch(self, endpoint: str, call: Callable[[], object]) -> RawResponse:
        if self._blocked is not None:
            logger.info(
                "Garmin 당일 차단을 기록한 세션이라 부르지 않는다: "
                "stage=%s endpoint=%s reason=%s",
                _DATA_STAGE,
                endpoint,
                self._blocked,
            )
            raise SessionBlocked(self._blocked)
        self._sleep(
            random.uniform(
                self._cfg.call_pause_min_seconds, self._cfg.call_pause_max_seconds
            )
        )
        status: int | None = None
        domain_error: errors.DomainError | None = None
        try:
            payload = call()
        except Exception as error:
            if not _is_classifiable(error):
                # Garmin 응답이 아니므로 연속 403을 늘리지도 되돌리지도 않는다.
                raise
            status, domain_error = _classify_data(error, endpoint)
        else:
            domain_error = _check_payload(endpoint, payload)
        if status == 403 and endpoint in self._first_call:
            # 첫 호출 보호: 연속 403을 늘리지도 되돌리지도 않는다. 결과는 `Rejected` 그대로다.
            pass
        elif status == 403:
            self._consecutive_403 += 1
            if self._consecutive_403 >= self._cfg.max_consecutive_403:
                domain_error = errors.Blocked403(f"{endpoint}: HTTP 403")
        else:
            self._consecutive_403 = 0
        if domain_error is None:
            return RawResponse(endpoint, payload, LIBRARY_VERSION)
        # except 블록 밖에서 던져 라이브러리 예외(메시지에 본문·토큰이 있을 수 있다)를 끊는다.
        level = (
            logging.INFO if isinstance(domain_error, errors.NoData) else logging.WARNING
        )
        logger.log(
            level,
            "Garmin 데이터 호출 실패: stage=%s endpoint=%s status=%s error=%s "
            "consecutive_403=%d first_call=%s",
            _DATA_STAGE,
            endpoint,
            status,
            type(domain_error).__name__,
            self._consecutive_403,
            endpoint in self._first_call,
        )
        reason = _block_reason(domain_error)
        if reason is not None:
            self._blocked = reason
            _record_block(self._tokenstore, self._cfg, reason)
        raise domain_error from None


def _range_day(stamp, result):
    """원문 값을 오류 메시지에 넣지 않고 요청한 날짜인지 검사한다."""
    try:
        if not isinstance(stamp, str):
            raise ValueError
        key = stamp[:10]
        if date.fromisoformat(key).isoformat() != key:
            raise ValueError
    except (ValueError, TypeError):
        raise errors.InvalidResponse('invalid_range_date') from None
    if key not in result:
        raise errors.InvalidResponse('range_date_outside_request')
    return key


def _weight_day(row, zone):
    stamp = row.get('calendarDate')
    if stamp is not None:
        return stamp
    moment = row.get('timestampGMT', row.get('date'))
    try:
        if isinstance(moment, (int, float)) and not isinstance(moment, bool):
            parsed = datetime.fromtimestamp(moment / 1000, timezone.utc)
        elif isinstance(moment, str):
            parsed = datetime.fromisoformat(moment.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
        else:
            raise ValueError
        return parsed.astimezone(ZoneInfo(zone)).date().isoformat()
    except (ValueError, TypeError, OverflowError, OSError):
        raise errors.InvalidResponse('invalid_weight_date') from None


def _split_weight_range(payload, days, zone):
    """range API는 summary 목록, dayview API는 dateWeightList다. 앞뒤 측정·평균은 분리한다."""
    result = {day: [] for day in days}
    if not isinstance(payload, dict):
        raise errors.InvalidResponse('expected_weight_range_object')
    if 'dailyWeightSummaries' not in payload:
        # 기존 일별 호환 원문과 합성 클라이언트도 계속 지원한다.
        rows = payload.get('dateWeightList')
        if not isinstance(rows, list):
            raise errors.InvalidResponse('expected_daily_weight_summaries_list')
        for row in rows:
            if not isinstance(row, dict):
                raise errors.InvalidResponse('expected_weight_metric_object')
            result[_range_day(_weight_day(row, zone), result)].append(row)
        return {day: {**payload, 'dateWeightList': rows} if rows else None
                for day, rows in result.items()}
    summaries = payload['dailyWeightSummaries']
    if not isinstance(summaries, list):
        raise errors.InvalidResponse('expected_daily_weight_summaries_list')
    seen = set()
    for summary in summaries:
        if not isinstance(summary, dict):
            raise errors.InvalidResponse('expected_weight_summary_object')
        stamp = summary.get('summaryDate')
        key = _range_day(stamp, result)
        if stamp != key or key in seen:
            raise errors.InvalidResponse('invalid_weight_summary_date')
        seen.add(key)
        rows = summary.get('allWeightMetrics')
        if not isinstance(rows, list):
            raise errors.InvalidResponse('expected_all_weight_metrics_list')
        for row in rows:
            if not isinstance(row, dict):
                raise errors.InvalidResponse('expected_weight_metric_object')
            if _range_day(_weight_day(row, zone), result) != key:
                raise errors.InvalidResponse('weight_summary_date_mismatch')
        # 전체 원문은 backfill_range.*에 이미 보존했다. 일별 원문에 기간 평균을 섞지 않는다.
        result[key] = rows
    return {day: {'dateWeightList': rows} if rows else None for day, rows in result.items()}


def split_range(endpoint, payload, days, zone):
    """기간 응답을 일별 기존 원문 모양으로 분할한다. 형식 오류는 일시 장애가 아니다."""
    if endpoint == 'daily_weigh_ins':
        return _split_weight_range(payload, days, zone)
    result = {day: [] for day in days}
    if endpoint not in ('activities_by_date', 'body_battery') or not isinstance(payload, list):
        raise errors.InvalidResponse('expected_range_list')
    for row in payload:
        if not isinstance(row, dict):
            raise errors.InvalidResponse('expected_range_row_object')
        stamp = row.get('startTimeLocal') if endpoint == 'activities_by_date' else row.get('date')
        result[_range_day(stamp, result)].append(row)
    return {day: rows or None for day, rows in result.items()}


def _check_payload(endpoint: str, payload: object) -> errors.DomainError | None:
    """정상 응답의 원문 검사. 비공개 계정·빈 응답이면 도메인 오류, 아니면 `None`이다."""
    if (
        endpoint == "user_summary"
        and isinstance(payload, dict)
        and payload.get("privacyProtected") is True
    ):
        return errors.AuthFailed(errors.AuthFailedReason.PRIVACY_PROTECTED)
    if payload is None or (isinstance(payload, list | dict) and not payload):
        return errors.NoData(f"{endpoint}: 빈 응답")
    return None


def _block_reason(domain_error: errors.DomainError) -> errors.RunStatus | None:
    if isinstance(domain_error, errors.RateLimited):
        return errors.RunStatus.RATE_LIMITED
    if isinstance(domain_error, errors.Blocked403):
        return errors.RunStatus.BLOCKED_403
    return None


def _record_block(
    tokenstore: Path, cfg: config.Config, reason: errors.RunStatus
) -> None:
    """오늘 날짜로 `block.json`을 쓴다. 쓰기 실패는 errno만 로그에 남기고 삼킨다."""
    try:
        _write_block(tokenstore, dates.today(cfg), reason)
    except OSError as write_error:
        # 차단 기록에 실패해도 Garmin 실패 자체는 호출자에게 알린다.
        logger.error(
            "당일 차단 파일을 쓰지 못했다: reason=%s errno=%s",
            reason,
            write_error.errno,
        )
    else:
        logger.warning("당일 차단을 기록했다: reason=%s", reason)


def token_saved_at(cfg: config.Config) -> int | None:
    """`<tokenstore>/garmin_tokens.json`의 mtime(UTC epoch ms). 파일이 없거나 읽지 못하면 `None`이다.

    파일 내용은 읽지 않는다. 없음이 아닌 `OSError`는 errno만 WARNING으로 남긴다.
    """
    try:
        info = (cfg.tokenstore / TOKEN_FILENAME).stat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as error:
        logger.warning("토큰 파일 시각을 읽지 못했다: errno=%s", error.errno)
        return None
    return info.st_mtime_ns // 1_000_000


def _new_client() -> garminconnect.Garmin:
    """라이브러리 클라이언트 생성 seam. 생성은 네트워크를 쓰지 않는다. 테스트는 이것만 바꾼다."""
    return garminconnect.Garmin()


def _configured_client(cfg: config.Config) -> garminconnect.Garmin:
    """`_new_client()`로 만들고 `cffi_api_session`이면 API 세션을 curl_cffi로 바꾼 클라이언트."""
    client = _new_client()
    if cfg.cffi_api_session:
        # 원래 API 세션의 "쿠키 전부 거부" 정책과 같게 받은 쿠키를 버린다.
        client.client._api_session = cffi_requests.Session(
            impersonate="chrome", discard_cookies=True
        )
    return client


def _refuse_if_blocked(tokenstore: Path, cfg: config.Config) -> None:
    """`block.json`이 오늘 날짜면 `SessionBlocked`, 깨졌으면 `BlockFileInvalid`다."""
    reason = _blocked_on(tokenstore, dates.today(cfg))
    if reason is not None:
        logger.info("Garmin 당일 차단 중이라 로그인하지 않는다: reason=%s", reason)
        raise SessionBlocked(reason)


class GarminAdapter:
    """`GarminPort`의 실제 구현. 비밀번호·이메일은 받지 않고 tokenstore로만 로그인한다."""

    def __init__(self, cfg: config.Config, *, sleep: Sleeper = time.sleep) -> None:
        """`sleep`은 데이터 호출 사이 간격을 쉬는 함수다. 테스트가 바꾼다."""
        self._cfg = cfg
        self._sleep = sleep

    def blocked_today(self) -> errors.RunStatus | None:
        """`block.json`이 오늘 날짜면 그 사유. 파일이 없거나 지난 날짜면 `None`이다.

        잘못된 파일은 `BlockFileInvalid`다. 락을 잡지 않는다(쓰기는 원자적 교체다).
        """
        return _blocked_on(self._cfg.tokenstore, dates.today(self._cfg))

    @contextlib.contextmanager
    def open_session(
        self, *, first_call_endpoints: Collection[str] = ()
    ) -> Iterator[GarminSession]:
        """세션 락 → 당일 차단 확인 → 로그인 순서로 세션을 연다. 나가면 락을 푼다.

        `first_call_endpoints`는 첫 호출 보호 대상(403을 연속 403에 세지 않음)이다. 모르는
        endpoint 이름이면 락·네트워크 전에 `ValueError`다.
        """
        first_call = _first_call_endpoints(first_call_endpoints)
        tokenstore = self._cfg.tokenstore
        if not tokenstore.is_dir():
            logger.warning(
                "Garmin 세션을 열지 못했다: stage=tokenstore error=AuthFailed reason=%s",
                errors.AuthFailedReason.TOKEN_INVALID,
            )
            raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
        with _session_lock(tokenstore, self._cfg.lock_wait_seconds):
            _refuse_if_blocked(tokenstore, self._cfg)
            client = _configured_client(self._cfg)
            _login(client, tokenstore, self._cfg)
            yield _Session(client, self._cfg, tokenstore, self._sleep, first_call)


def _first_call_endpoints(endpoints: Collection[str]) -> frozenset[str]:
    """첫 호출 보호 대상 집합. `DAY_ENDPOINTS`·`ACTIVITY_ENDPOINTS` 밖 이름이면 `ValueError`다."""
    names = frozenset(endpoints)
    unknown = names - frozenset(DAY_ENDPOINTS) - frozenset(ACTIVITY_ENDPOINTS)
    if unknown:
        raise ValueError(f"모르는 endpoint다: {sorted(unknown)!r}")
    return names


def _login(client: garminconnect.Garmin, tokenstore: Path, cfg: config.Config) -> None:
    """tokenstore로 로그인한다. 라이브러리 예외는 도메인 오류로 바꿔 던진다."""
    _run_login_step(lambda: client.login(str(tokenstore)), tokenstore, cfg)


def interactive_login(cfg: config.Config, prompts: LoginPrompts) -> None:
    """자격 증명(과 MFA 코드)으로 새로 로그인해 tokenstore에 토큰을 쓴다.

    tokenstore 폴더는 호출자가 미리 만든다. 프롬프트는 세션 락을 놓은 동안에만 부르고, 네트워크와
    토큰 쓰기는 락을 쥔 채 한다. 실패는 `SessionBlocked`·`BlockFileInvalid`·`SessionLockTimeout`,
    로그인 단계 도메인 오류(429·403이면 `block.json`을 쓴 뒤), 토큰 쓰기의 `OSError`, 프롬프트가
    던진 예외다. 기존 토큰 파일은 읽지 않는다(`Garmin.login(tokenstore)`를 쓰지 않는다).
    """
    tokenstore = cfg.tokenstore
    _refuse_if_blocked(tokenstore, cfg)
    email, password = prompts.credentials()
    with _session_lock(tokenstore, cfg.lock_wait_seconds):
        _refuse_if_blocked(tokenstore, cfg)
        client = _configured_client(cfg)
        mfa_status, _ = _run_login_step(
            lambda: client.client.login(email, password, return_on_mfa=True),
            tokenstore,
            cfg,
            " step=credentials",
        )
        if mfa_status != "needs_mfa":
            logger.info("Garmin 자격 증명 로그인: stage=%s mfa=False", _LOGIN_STAGE)
            _run_login_step(
                client._load_profile_and_settings,
                tokenstore,
                cfg,
                " step=profile mfa=False",
            )
            _dump_tokens(client, tokenstore, mfa=False, attempts=0)
            return
    logger.info("Garmin 자격 증명 로그인: stage=%s mfa=True", _LOGIN_STAGE)
    for attempt in range(1, MFA_MAX_ATTEMPTS + 1):
        code = prompts.mfa_code()
        with _session_lock(tokenstore, cfg.lock_wait_seconds):
            _refuse_if_blocked(tokenstore, cfg)
            try:
                _run_login_step(
                    functools.partial(client.resume_login, None, code),
                    tokenstore,
                    cfg,
                    f" step=mfa mfa=True attempt={attempt}",
                )
            except errors.AuthFailed:
                # 틀린 코드면 라이브러리가 MFA 대기 상태를 유지한다. 대기가 풀린 뒤의 실패(MFA는
                # 통과했지만 프로필 확인 실패 등)는 다시 물어도 소용없으므로 바로 중단한다.
                if attempt == MFA_MAX_ATTEMPTS or not _mfa_pending(client):
                    raise
                logger.info(
                    "MFA 코드가 틀려 다시 묻는다: stage=%s attempt=%d",
                    _LOGIN_STAGE,
                    attempt,
                )
                continue
            _dump_tokens(client, tokenstore, mfa=True, attempts=attempt)
            return


def _mfa_pending(client: garminconnect.Garmin) -> bool:
    """라이브러리가 아직 MFA 코드를 기다리면 참이다. 속성을 모르면 거짓(다시 묻지 않음)으로 본다."""
    return bool(getattr(client.client, "_mfa_pending", False))


def _dump_tokens(
    client: garminconnect.Garmin, tokenstore: Path, *, mfa: bool, attempts: int
) -> None:
    """`<tokenstore>/garmin_tokens.json`(`TOKEN_FILENAME`, 0600)을 쓴다. `OSError`는 그대로 던진다."""
    client.client.dump(str(tokenstore))
    logger.info(
        "Garmin 토큰을 저장했다: stage=%s mfa=%s attempts=%d",
        _LOGIN_STAGE,
        mfa,
        attempts,
    )


def _run_login_step[T](
    call: Callable[[], T], tokenstore: Path, cfg: config.Config, context: str = ""
) -> T:
    """로그인 단계 호출 하나. 라이브러리 예외·`OSError`는 도메인 오류로 바꿔 던진다.

    429·403이면 `block.json`을 쓴 뒤 던진다. `context`는 로그 끝에 붙는 안전한 필드(단계 이름·
    MFA 여부·시도 횟수)다.
    """
    try:
        return call()
    except Exception as error:
        if not _is_classifiable(error):
            raise
        status, domain_error = _classify(error)
    # except 블록 밖에서 던져 라이브러리 예외(메시지에 토큰·본문이 있을 수 있다)를 끊는다.
    name = type(domain_error).__name__
    logger.warning(
        "Garmin 로그인 실패: stage=%s status=%s error=%s%s",
        _LOGIN_STAGE,
        status,
        name,
        context,
    )
    reason = _block_reason(domain_error)
    if reason is not None:
        _record_block(tokenstore, cfg, reason)
    raise domain_error from None


def _is_classifiable(error: BaseException) -> bool:
    """분류 대상: `garminconnect`가 정의한 예외(하위 클래스 포함)와 `OSError`."""
    return isinstance(error, OSError) or _is_library_error(error)


def _is_library_error(error: BaseException) -> bool:
    return any(
        cls.__module__.partition(".")[0] == _LIBRARY_PACKAGE
        for cls in type(error).__mro__
    )


def _chain(error: BaseException) -> Iterator[BaseException]:
    """예외 자신부터 `__cause__`(없으면 `__context__`)를 따라간다. 순환하면 멈춘다."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = (
            current.__cause__ if current.__cause__ is not None else current.__context__
        )


def _own_status(error: BaseException) -> int | None:
    """예외 하나에서 읽을 수 있는 HTTP 상태. 없으면 `None`이다."""
    code = getattr(getattr(error, "response", None), "status_code", None)
    if isinstance(code, int) and not isinstance(code, bool):
        return code
    if isinstance(error, garminconnect.GarminConnectTooManyRequestsError):
        return 429
    if _is_library_error(error):
        match = _STATUS_IN_MESSAGE.search(str(error))
        if match is not None:
            return int(match[1])
    return None


def _classify(error: BaseException) -> tuple[int | None, errors.DomainError]:
    """(처음 찾은 HTTP 상태, 바꾼 도메인 오류). 메시지에는 단계와 상태 코드만 담는다."""
    chain = list(_chain(error))
    status = _first_status(error)
    where = f"{_LOGIN_STAGE} 단계"
    if status == 403:
        return status, errors.Blocked403(f"{where}: HTTP 403")
    if status == 429:
        return status, errors.RateLimited(f"{where}: HTTP 429")
    if status is not None and 500 <= status <= 599:
        return status, errors.Transient(f"{where}: HTTP {status}")
    if status is None and any(isinstance(link, OSError) for link in chain):
        return status, errors.Transient(f"{where}: 네트워크 오류")
    return status, errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)


def _classify_data(
    error: BaseException, endpoint: str
) -> tuple[int | None, errors.DomainError]:
    """데이터 단계 분류. (처음 찾은 HTTP 상태, 도메인 오류). 메시지에는 endpoint와 상태만 담는다.

    403은 여기서 `Rejected`이고 연속 403 승격은 세션이 한다. 상태가 없으면(네트워크·비JSON 본문·
    라이브러리 내부 래핑) 다음 실행에서 다시 시도하도록 `Transient`다.
    """
    status = _first_status(error)
    if status is None:
        return status, errors.Transient(f"{endpoint}: 상태 코드 없음")
    where = f"{endpoint}: HTTP {status}"
    if status == 429:
        return status, errors.RateLimited(where)
    if status == 401:
        # 라이브러리가 토큰을 갱신하고 다시 요청한 뒤에도 401이다.
        return status, errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
    if status == 404:
        return status, errors.NoData(where)
    if 400 <= status <= 499:
        return status, errors.Rejected(where)
    return status, errors.Transient(where)


def _first_status(error: BaseException) -> int | None:
    return next(
        (code for code in map(_own_status, _chain(error)) if code is not None), None
    )


def _blocked_on(tokenstore: Path, today: date) -> errors.RunStatus | None:
    block = _read_block(tokenstore)
    if block is None:
        return None
    local_date, reason = block
    return reason if local_date == today.isoformat() else None


def _read_block(tokenstore: Path) -> tuple[str, errors.RunStatus] | None:
    """`block.json`의 (local_date, reason). 파일이 없으면 `None`, 틀리면 `BlockFileInvalid`다."""
    path = tokenstore / BLOCK_FILENAME
    try:
        raw = path.read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as error:
        raise BlockFileInvalid(
            f"차단 파일을 읽지 못했다: {path} ({error.strerror})"
        ) from None
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise BlockFileInvalid(f"차단 파일이 UTF-8 JSON이 아니다: {path}") from None
    if not isinstance(data, dict) or set(data) != _BLOCK_KEYS:
        raise BlockFileInvalid(
            f"차단 파일의 키는 {sorted(_BLOCK_KEYS)}여야 한다: {path}"
        )
    version = data["schema_version"]
    if type(version) is not int or version != BLOCK_SCHEMA_VERSION:
        raise BlockFileInvalid(
            f"차단 파일의 schema_version이 {BLOCK_SCHEMA_VERSION}이 아니다: {path}"
        )
    local_date = data["local_date"]
    if not isinstance(local_date, str) or not _is_iso_date(local_date):
        raise BlockFileInvalid(f"차단 파일의 local_date가 YYYY-MM-DD가 아니다: {path}")
    reason = data["reason"]
    if not isinstance(reason, str) or reason not in BLOCK_REASONS:
        raise BlockFileInvalid(
            f"차단 파일의 reason은 {[str(r) for r in BLOCK_REASONS]} 중 하나여야 한다: {path}"
        )
    return local_date, errors.RunStatus(reason)


def _is_iso_date(value: str) -> bool:
    if _ISO_DATE.fullmatch(value) is None:
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _write_block(tokenstore: Path, day: date, reason: errors.RunStatus) -> None:
    """`block.json`을 같은 폴더 임시 파일(0600) + `os.replace`로 원자적으로 쓴다.

    호출자가 세션 락을 쥔 채로 부른다.
    """
    payload = {
        "schema_version": BLOCK_SCHEMA_VERSION,
        "local_date": day.isoformat(),
        "reason": reason.value,
    }
    fd, temp_name = tempfile.mkstemp(prefix=".block.", suffix=".tmp", dir=tokenstore)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(json.dumps(payload) + "\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_name, tokenstore / BLOCK_FILENAME)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)
        raise


@contextlib.contextmanager
def _session_lock(tokenstore: Path, wait_seconds: float) -> Iterator[None]:
    """`<tokenstore>/.session.lock`(0600)에 `flock(LOCK_EX)`을 잡고, 나갈 때 푼다.

    `os.open`의 fd는 상속되지 않으므로 하위 프로세스가 락을 물려받지 않는다.
    """
    lock_path = tokenstore / SESSION_LOCK_FILENAME
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1:
            raise GarminAdapterError("unsafe session lock")
        key = (info.st_dev, info.st_ino)
        if key in _held_locks:
            raise RuntimeError(
                f"이 프로세스가 이미 세션 락을 쥐고 있다(open_session 중첩): {lock_path}"
            )
        _acquire(fd, lock_path, wait_seconds)
        _held_locks.add(key)
        try:
            yield
        finally:
            _held_locks.discard(key)
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _acquire(fd: int, lock_path: Path, wait_seconds: float) -> None:
    """`LOCK_NB`를 0.1초 간격으로 다시 시도한다. `wait_seconds`가 0이면 한 번만 시도한다."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.warning(
                    "Garmin 세션 락을 잡지 못했다: stage=session_lock error=%s",
                    SessionLockTimeout.__name__,
                )
                raise SessionLockTimeout(
                    f"세션 락을 {wait_seconds:g}초 안에 잡지 못했다: {lock_path}"
                ) from None
            time.sleep(min(_LOCK_RETRY_SECONDS, remaining))
