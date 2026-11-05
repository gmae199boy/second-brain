"""운영 DB에 보존된 Garmin 원문을 테스트 fixture 파일로 내보낸다(FR40, NFR2·3, AD-1·3·4·12).

Epic 3 정규화를 실제 Venu 3 응답 구조에 맞춰 만들고 검증하려고, `raw_response.raw`를 고른 그대로
`<출력 폴더>/<endpoint>/<key>.json`에 쓴다. 출력 폴더는 현재 폴더 기준 `OUTPUT_DIR`이다.

- `ignored_by_git(out_dir)`: 출력 폴더가 git에서 무시되지 않으면 거부 사유를 돌려준다. 건강 데이터가
  git에 들어갈 길을 막는다. 저장소 밖이거나 git을 실행할 수 없어도 거부한다.
- `select(conn, *, days, activity_ids)`: 내보낼 행을 고른다. 지정이 없으면 기본 선택(endpoint마다 최신
  data 하나, 상세가 있는 최근 활동 `RECENT_ACTIVITIES`개)이고, 지정이 있으면 지정한 날짜·활동의
  행만 `null`(NoData)까지 그대로 고른다. 경로가 될 key가 형식에 맞지 않으면 건너뛰고 WARNING이다.
- `write_fixture(path, raw)`: 같은 폴더 임시 파일(0600)에 쓰고 fsync한 뒤 `os.replace`로 바꾼다.
- `export(cfg, out_dir, *, days, activity_ids)`: 읽기 연결(`store.read_connection`)의 읽기
  트랜잭션 하나로 고르고, 파일을 쓰고, endpoint별 개수를 돌려준다. 새로 만드는 출력 폴더와
  endpoint 폴더는 0700이다. 기존 파일은 덮어쓰고 지우지 않는다.

DB에 쓰지 않고 네트워크에 닿지 않는다. 로그에는 endpoint별 개수와 건너뛴 행의 위치(scope·endpoint·key,
목록 형식 오류 메시지)만 남기고 원문 내용은 남기지 않는다.

stdlib과 `garmin_pipeline`의 `config`·`coverage`·`rawparse`·`store`만 import한다. `garmin`(어댑터)은
import하지 않는다(계약 `capture-imports-no-upper-modules`).
"""

import contextlib
import logging
import os
import subprocess
import tempfile
from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import NamedTuple

from garmin_pipeline import config, coverage, rawparse, store

OUTPUT_DIR = Path("tests/fixtures/garmin")
"""출력 폴더(현재 폴더 기준). `.gitignore`가 빼는 경로다."""

RECENT_ACTIVITIES = 3
"""기본 선택에서 내보낼 최근 활동 수."""

DIR_MODE = 0o700
ENDPOINTS = (*coverage.DAY_ENDPOINTS, *coverage.ACTIVITY_ENDPOINTS)
"""출력 순서: day-scope 11종 다음 activity-scope 4종(세트 상세는 저장된 근력 활동에만 있다)."""

_DAY = "day"
_ACTIVITY = "activity"
_ACTIVITY_LIST = "activities_by_date"
_NULL = "null"
_SUFFIX = ".json"

logger = logging.getLogger(__name__)


class Row(NamedTuple):
    """내보낼 원문 행 하나."""

    scope: str
    key: str
    endpoint: str
    raw: str


def ignored_by_git(out_dir: Path) -> str | None:
    """현재 폴더에서 `git check-ignore`로 `out_dir/`을 본다. 무시되면 `None`, 아니면 거부 사유다."""
    cwd = Path.cwd()
    try:
        result = subprocess.run(
            ["git", "check-ignore", "-q", f"{out_dir}/"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        return f"git을 실행하지 못했다: {error}"
    if result.returncode == 0:
        return None
    if result.returncode == 1:
        return (
            f"출력 폴더가 git에서 무시되지 않는다: {out_dir}. "
            "`.gitignore`에 tests/fixtures/garmin/이 있는 저장소 루트에서 실행한다"
        )
    lines = (result.stderr or "").strip().splitlines()
    detail = f" (git: {lines[0].strip()})" if lines else ""
    return (
        f"git 저장소 안이 아니다(git check-ignore 종료 코드 {result.returncode}): {cwd}. "
        f"저장소 루트에서 실행한다{detail}"
    )


def select(
    conn: store.Connection,
    *,
    days: Iterable[date],
    activity_ids: Iterable[int],
) -> list[Row]:
    """내보낼 행. `days`·`activity_ids`가 모두 비면 기본 선택, 하나라도 있으면 지정 선택이다.

    트랜잭션을 열지 않는다. 같은 시점의 상태가 필요하면 호출자가 `store.transaction(conn)`으로 묶는다.
    """
    wanted_days = list(dict.fromkeys(days))
    wanted_ids = list(dict.fromkeys(activity_ids))
    if wanted_days or wanted_ids:
        return _selected(conn, wanted_days, wanted_ids)
    return _latest_days(conn) + _recent_activities(conn)


def write_fixture(path: Path, raw: str) -> None:
    """`raw`의 UTF-8 바이트를 같은 폴더 임시 파일(0600)에 쓰고 `os.replace`로 바꾼다.

    폴더는 호출자가 만든다. 실패하면 임시 파일을 지우고 다시 던진다.
    """
    fd, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def export(
    cfg: config.Config,
    out_dir: Path,
    *,
    days: Iterable[date],
    activity_ids: Iterable[int],
) -> dict[str, int]:
    """고른 원문을 `out_dir/<endpoint>/<key>.json`에 쓰고 `ENDPOINTS` 순서의 endpoint별 개수를 돌려준다.

    `store.DbMissing`·`store.SchemaMismatch`와 쓰기 `OSError`는 그대로 던진다.
    """
    conn = store.read_connection(cfg)
    try:
        with store.transaction(conn):
            rows = select(conn, days=days, activity_ids=activity_ids)
    finally:
        conn.close()

    counts = dict.fromkeys(ENDPOINTS, 0)
    if rows:
        out_dir.parent.mkdir(parents=True, exist_ok=True)
        _make_dir(out_dir)
    for row in rows:
        directory = out_dir / row.endpoint
        _make_dir(directory)
        write_fixture(directory / f"{row.key}{_SUFFIX}", row.raw)
        counts[row.endpoint] += 1
    logger.info(
        "capture-fixtures 끝: %s",
        " ".join(f"{endpoint}={count}" for endpoint, count in counts.items()),
    )
    return counts


def _make_dir(path: Path) -> None:
    """없으면 0700으로 만든다. 이미 있으면 모드를 건드리지 않는다."""
    try:
        path.mkdir(mode=DIR_MODE)
    except FileExistsError:
        return
    os.chmod(path, DIR_MODE)


def _valid_key(scope: str, key: str) -> bool:
    """경로가 될 key가 일 키(`YYYY-MM-DD`)나 activityId(10진 숫자)인지."""
    if scope == _ACTIVITY:
        return key.isdecimal()
    try:
        return date.fromisoformat(key).isoformat() == key
    except ValueError:
        return False


def _checked(row: Row) -> bool:
    if _valid_key(row.scope, row.key):
        return True
    logger.warning(
        "경로로 쓸 수 없는 key라 건너뛴다: scope=%s endpoint=%s key=%r",
        row.scope,
        row.endpoint,
        row.key,
    )
    return False


def _selected(
    conn: store.Connection, days: list[date], activity_ids: list[int]
) -> list[Row]:
    """지정한 날짜의 day-scope 11종과 지정한 활동의 activity-scope 원문(저장된 것만, `null` 포함)."""
    wanted = [
        (_DAY, day.isoformat(), endpoint)
        for day in days
        for endpoint in coverage.DAY_ENDPOINTS
    ] + [
        (_ACTIVITY, str(activity_id), endpoint)
        for activity_id in activity_ids
        for endpoint in coverage.ACTIVITY_ENDPOINTS
    ]
    rows: list[Row] = []
    for scope, key, endpoint in wanted:
        found = conn.execute(
            "SELECT raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope = %s AND key = %s AND endpoint = %s",
            (conn.user_id, conn.connection_id, scope, key, endpoint),
        ).fetchone()
        if found is not None:
            row = Row(scope, key, endpoint, found[0])
            if _checked(row):
                rows.append(row)
    return rows


def _latest_days(conn: store.Connection) -> list[Row]:
    """`DAY_ENDPOINTS`마다 `null`이 아닌 행 중 key가 가장 큰 유효한 행 하나."""
    rows: list[Row] = []
    for endpoint in coverage.DAY_ENDPOINTS:
        candidates = conn.execute(
            "SELECT key, raw FROM garmin.raw_current"
            " WHERE user_id=%s AND connection_id=%s AND scope = %s AND endpoint = %s AND raw != %s ORDER BY key COLLATE \"C\" DESC",
            (conn.user_id, conn.connection_id, _DAY, endpoint, _NULL),
        )
        for key, raw in candidates:
            row = Row(_DAY, key, endpoint, raw)
            if _checked(row):
                rows.append(row)
                break
    return rows


def _recent_activities(conn: store.Connection) -> list[Row]:
    """상세 data 행이 하나라도 있는 최근 활동 `RECENT_ACTIVITIES`개의 activity-scope data 행."""
    rows: list[Row] = []
    chosen = 0
    for activity_id in _activity_ids(conn):
        key = str(activity_id)
        found = [
            Row(_ACTIVITY, key, endpoint, raw)
            for endpoint, raw in conn.execute(
                "SELECT endpoint, raw FROM garmin.raw_current"
                " WHERE user_id=%s AND connection_id=%s AND scope = %s AND key = %s AND raw != %s",
                (conn.user_id, conn.connection_id, _ACTIVITY, key, _NULL),
            )
            if endpoint in coverage.ACTIVITY_ENDPOINTS
        ]
        if not found:
            continue
        if not _checked(found[0]):
            continue
        found.sort(key=lambda row: coverage.ACTIVITY_ENDPOINTS.index(row.endpoint))
        rows.extend(found)
        chosen += 1
        if chosen == RECENT_ACTIVITIES:
            break
    return rows


def _activity_ids(conn: store.Connection) -> list[int]:
    """저장된 활동 목록의 activityId: 일 키 내림차순, 같은 날은 목록 순, 처음 것만.

    목록은 key 내림차순으로 읽는다. 형식이 틀린 목록은 그 목록만 건너뛰고 WARNING(key와 오류
    메시지만)을 남긴다.
    """
    lists = conn.execute(
        "SELECT key, raw FROM garmin.raw_current"
        " WHERE user_id=%s AND connection_id=%s AND scope = %s AND endpoint = %s ORDER BY key COLLATE \"C\" DESC",
        (conn.user_id, conn.connection_id, _DAY, _ACTIVITY_LIST),
    )
    refs: list[rawparse.ActivityRef] = []
    seen: set[int] = set()
    for key, raw in lists:
        try:
            parsed = rawparse.activity_refs(raw)
        except rawparse.RawParseError as error:
            logger.warning("활동 목록 원문 형식 오류(key=%s): %s", key, error)
            continue
        for ref in parsed:
            if ref.activity_id not in seen:
                seen.add(ref.activity_id)
                refs.append(ref)
    # 안정 정렬이라 같은 일 키 안에서는 위에서 읽은 순서(목록 key 내림차순, 목록 순)가 남는다.
    refs.sort(key=lambda ref: ref.day_key, reverse=True)
    return [ref.activity_id for ref in refs]
