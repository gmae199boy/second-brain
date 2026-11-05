"""SQLite 저장소: 쓰기 세션(단일 작성자 락 + 마이그레이션), 읽기 연결, 락 확인(AD-8·15).

- 리포트 명령 전체는 `report_session(cfg, blocking)`으로 잠근다. 락 순서는 report → write → session이다.
  쓰기 락 안의 진입과 같은 스레드의 report_session 중첩은 즉시 RuntimeError다.
- 쓰기는 `write_session(cfg)` 하나다. `<data_dir>/.write.lock`에 `flock(LOCK_EX)`을 잡고
  밀린 마이그레이션을 적용한 연결을 내준다. 같은 프로세스에서 중첩하면 `RuntimeError`다.
- 읽기는 `read_connection(cfg)`이다. `mode=ro`로 열고 스키마 버전이 코드와 다르면
  `SchemaMismatch`다. 마이그레이션하지 않는다.
- 다른 명령이 락을 쥐고 있는지는 `write_lock_held(cfg)`로만 확인한다.
- 락 밖 쓰기는 `insert_run_unlocked(cfg, ...)` 하나다. 쓰기 락을 잡지 못한 `collect`가 `run`에
  `error`(`lock_timeout`) 행 하나를 남길 때만 쓴다(AD-8). `mode=rw`라 DB를 만들지 않고 스키마
  버전이 다르면 쓰지 않는다.
- 연결은 모두 `autocommit=True`다. 여러 문장을 묶을 때는 `transaction(conn)`을 쓴다.
  열린 트랜잭션 안에서 일부만 되돌릴 수 있게 묶을 때는 `savepoint(conn)`을 쓴다(중첩하지 않는다).
- 마이그레이션은 `migrations/NNNN_<name>.sql` 하나의 순서 목록이고 위치는
  `_migrations_dir()` 하나에서만 정한다. 테스트는 이 함수만 바꾼다.
- Garmin 응답 원문은 `upsert_raw(conn, ...)`로 `(scope, key, endpoint)`마다 보존한다.
- 쓰기 연결은 마이그레이션을 마친 뒤 `PRAGMA foreign_keys = ON`을 켜고 내준다. 읽기 연결은 그대로다.
- 정규화 규칙 버전 `NORMALIZE_VERSION`과 그 `meta` key `NORMALIZE_VERSION_KEY`는 여기서 정의한다(올리는 규칙은
  상수 docstring). `normalize`가 재구성을 판정할 때 사용한다.

stdlib과 `garmin_pipeline`의 `config`·`errors`만 import한다(`dates`는 금지라 시각은 호출자가 준다).
"""

import contextlib
import fcntl
import importlib.resources
import json
import os
import re
import sqlite3
import threading
import time
from collections.abc import Iterator
from importlib.resources.abc import Traversable
from pathlib import Path
from typing import NamedTuple

from garmin_pipeline import config

LOCK_FILENAME = ".write.lock"
REPORT_LOCK_FILENAME = ".report.lock"
_report_state = threading.local()
_LOCK_RETRY_SECONDS = 0.1
_MIGRATION_NAME = re.compile(r"([0-9]{4})_[a-z0-9_]+\.sql")
_GUARDED_COMPONENT = "runtime"
_SAVEPOINT = "garmin_pipeline_unit"

NORMALIZE_VERSION = 8
"""정규화 규칙의 버전. `meta.normalize_version`에는 `str(NORMALIZE_VERSION)`을 저장하고 문자열로 비교한다.

올리는 규칙: 같은 원문에서 나오는 파생 값이나 그 모양(테이블·열·행)이 바뀌는 코드 변경이면 1 올린다
(마이그레이션으로 파생 테이블을 더하거나 바꿀 때도). 저장 값과 다르면(없음 포함) 다음 `normalize.run`이 전체
재구성한다. `normalize`는 이 값을 같은 이름으로 다시 내보낸다.
"""
NORMALIZE_VERSION_KEY = "normalize_version"
"""`meta`에서 정규화 버전을 담는 key. 정규화 재구성이 쓰는 `meta` 행은 이것뿐이다."""

# 이 프로세스의 `write_session`이 지금 쥐고 있는 락 파일의 (st_dev, st_ino).
# 같은 파일을 다른 fd로 다시 flock하면 자기 자신과 충돌해 대기 끝까지 막히므로 미리 거부한다.
_held_locks: set[tuple[int, int]] = set()


class StoreError(Exception):
    """저장소 오류의 바탕. Garmin 실패(`errors.DomainError`)와 섞이지 않게 따로 둔다."""


class ReportLockBusy(StoreError):
    """기다리지 않는 리포트 락을 잡지 못했다."""


class LockTimeout(StoreError):
    """`lock_wait_seconds` 안에 쓰기 락을 잡지 못했다."""


class SchemaMismatch(StoreError):
    """DB `user_version`(`.found`)이 코드의 최신 마이그레이션 번호(`.expected`)와 다르다."""

    def __init__(self, found: int, expected: int) -> None:
        super().__init__(
            f"DB 스키마 버전 {found}이 코드의 최신 마이그레이션 번호 {expected}와 다르다"
        )
        self.found = found
        self.expected = expected


class DbMissing(StoreError):
    """읽을 DB 파일이 없다."""


class MigrationError(StoreError):
    """마이그레이션 목록이 잘못됐거나 마이그레이션 하나를 적용하지 못했다."""


class _Migration(NamedTuple):
    number: int
    name: str
    source: Traversable


def _migrations_dir() -> Traversable:
    """마이그레이션 폴더 seam. 테스트는 이것만 바꾼다."""
    return importlib.resources.files(__package__) / "migrations"


@contextlib.contextmanager
def report_session(cfg: config.Config, blocking: bool) -> Iterator[None]:
    """명령 전체의 리포트 락. report → write → session 순서를 지킨다.

    예약 실행은 끝까지 기다리고, 수동 재생성은 한 번 시도한 뒤 ReportLockBusy다.
    같은 호출 스레드의 중첩과 프로세스의 쓰기 락 안에서의 진입은 즉시 거부한다.
    """
    _refuse_runtime_under_pytest(cfg)
    if _held_locks or getattr(_report_state, "held", False):
        raise RuntimeError("report_session 중첩 또는 쓰기 락 안에서 리포트 락 진입")
    cfg.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = cfg.data_dir / REPORT_LOCK_FILENAME
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise ReportLockBusy(f"다른 report가 실행 중이다: {path}") from None
        _report_state.held = True
        try:
            yield
        finally:
            _report_state.held = False
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


@contextlib.contextmanager
def write_session(cfg: config.Config) -> Iterator[sqlite3.Connection]:
    """쓰기 락을 잡고 밀린 마이그레이션을 적용한 autocommit 연결을 내준다(FK 켬).

    블록을 나가면 정상이든 예외든 연결을 먼저 닫고(열린 트랜잭션은 롤백) 락을 푼다.
    """
    _refuse_runtime_under_pytest(cfg)
    migrations = _load_migrations()
    # 건강 데이터라 새로 만드는 data_dir은 0700이다. 이미 있는 폴더와 부모는 건드리지 않는다.
    cfg.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with _write_lock(cfg):
        conn = sqlite3.connect(cfg.db_path, autocommit=True)
        try:
            # 코드보다 새 DB는 journal_mode도 바꾸기 전에 거부한다.
            found, expected = _user_version(conn), _latest(migrations)
            if found > expected:
                raise SchemaMismatch(found, expected)
            mode = conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if str(mode).lower() != "wal":
                raise StoreError(
                    f"WAL 모드로 바꾸지 못했다(journal_mode={mode}): {cfg.db_path}"
                )
            _migrate(conn, migrations)
            # 마이그레이션은 FK가 꺼진 채 돌아 테이블 재구성이 가능하다. 쓰기는 FK를 강제한다.
            conn.execute("PRAGMA foreign_keys = ON")
            yield conn
        finally:
            _close(conn)


def read_connection(cfg: config.Config) -> sqlite3.Connection:
    """스키마 버전을 확인한 읽기 전용 autocommit 연결. 닫기는 호출자가 한다."""
    _refuse_runtime_under_pytest(cfg)
    expected = _latest(_load_migrations())
    if not cfg.db_path.is_file():
        raise DbMissing(f"DB 파일이 없다: {cfg.db_path}")
    conn = sqlite3.connect(cfg.db_path.as_uri() + "?mode=ro", uri=True, autocommit=True)
    try:
        found = _user_version(conn)
        if found != expected:
            raise SchemaMismatch(found, expected)
    except BaseException:
        conn.close()
        raise
    return conn


def insert_run_unlocked(
    cfg: config.Config,
    *,
    local_date: str,
    started_at: int,
    finished_at: int,
    status: str,
    detail: str,
) -> None:
    """쓰기 락 없이 `run`에 끝난 행 하나를 autocommit INSERT 한 문장으로 남긴다(AD-8 `lock_timeout`).

    쓰기 락을 잡지 못한 `collect`만 쓴다. 락·마이그레이션·`journal_mode` 변경 없이 기존 DB에
    `mode=rw`로 붙으므로 DB 파일을 만들지 않는다. DB가 없으면 `DbMissing`, `user_version`이
    코드의 최신 마이그레이션 번호와 다르면 `SchemaMismatch`이고 둘 다 아무것도 쓰지 않는다.
    다른 작성자와의 충돌은 SQLite 자체 잠금(WAL, 기본 busy 대기)에 맡긴다.
    """
    _refuse_runtime_under_pytest(cfg)
    expected = _latest(_load_migrations())
    if not cfg.db_path.is_file():
        raise DbMissing(f"DB 파일이 없다: {cfg.db_path}")
    conn = sqlite3.connect(cfg.db_path.as_uri() + "?mode=rw", uri=True, autocommit=True)
    try:
        found = _user_version(conn)
        if found != expected:
            raise SchemaMismatch(found, expected)
        conn.execute(
            "INSERT INTO run (local_date, started_at, finished_at, status, detail)"
            " VALUES (?, ?, ?, ?, ?)",
            (local_date, started_at, finished_at, status, detail),
        )
    finally:
        conn.close()


def write_lock_held(cfg: config.Config) -> bool:
    """누군가(이 프로세스의 세션 포함) 쓰기 락을 쥐고 있으면 참이다.

    기다리지 않는다. 락 파일이나 `data_dir`이 없으면 아무것도 만들지 않고 거짓이다.
    """
    _refuse_runtime_under_pytest(cfg)
    try:
        fd = os.open(_lock_path(cfg), os.O_RDONLY)
    except (FileNotFoundError, NotADirectoryError):
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


@contextlib.contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """`BEGIN` → `COMMIT`. 예외가 나면 `ROLLBACK`하고 다시 던진다.

    autocommit 연결에서는 `conn.commit()`·`conn.rollback()`이 아무것도 하지 않으므로 SQL로
    직접 끝낸다. 읽기 연결에서는 읽기 트랜잭션 하나가 된다.
    """
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


@contextlib.contextmanager
def savepoint(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """열린 트랜잭션 안의 `SAVEPOINT` → `RELEASE`. 예외면 `ROLLBACK TO` + `RELEASE` 뒤 다시 던진다.

    그 안의 쓰기만 되돌리고 바깥 트랜잭션은 그대로 둔다. 이름은 고정 상수라 중첩해 부르지 않는다.
    """
    conn.execute(f"SAVEPOINT {_SAVEPOINT}")
    try:
        yield conn
    except BaseException:
        if conn.in_transaction:
            conn.execute(f"ROLLBACK TO {_SAVEPOINT}")
            conn.execute(f"RELEASE {_SAVEPOINT}")
        raise
    conn.execute(f"RELEASE {_SAVEPOINT}")


def upsert_raw(
    conn: sqlite3.Connection,
    *,
    scope: str,
    key: str,
    endpoint: str,
    payload: object,
    library_version: str,
    now_ms: int,
) -> None:
    """응답 원문 하나를 `raw_response`의 `(scope, key, endpoint)` 행에 보존한다(FR6·7, AD-3).

    `payload`는 어댑터가 돌려준 값 그대로이고 `None`은 `NoData`라는 뜻이다. 원문은
    `json.dumps(payload, ensure_ascii=False)` 텍스트(키 순서 그대로)이고, 같은지는 이 텍스트로 본다.
    그 텍스트가 UTF-8로 인코딩되지 않으면(짝 없는 surrogate) 그 원문만 `ensure_ascii=True`로 만든다.

    - 행이 없으면 원문(`NoData`면 `'null'`)을 넣고 `fetched_at = checked_at = now_ms`다.
    - 원문이 다르면 `raw`·`fetched_at`·`checked_at`·`library_version`을 바꾼다.
    - 원문이 같거나 `NoData`면 `checked_at`만 바꾼다. 일시적인 빈 응답이 이미 받은 원문을
      지우지 않게 한다.

    트랜잭션을 열지 않는다. 쓰기 세션(단일 작성자 락) 안에서 호출자가 묶는다. `scope`가
    `'day'`·`'activity'`가 아니면 `sqlite3.IntegrityError`다.
    """
    raw = json.dumps(payload, ensure_ascii=False)
    try:
        raw.encode("utf-8")
    except UnicodeEncodeError:
        # sqlite가 바인딩하지 못하는 짝 없는 surrogate는 `\udXXX` 이스케이프로 남긴다.
        raw = json.dumps(payload, ensure_ascii=True)
    where = (scope, key, endpoint)
    row = conn.execute(
        "SELECT raw FROM raw_response WHERE scope = ? AND key = ? AND endpoint = ?",
        where,
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO raw_response"
            " (scope, key, endpoint, raw, fetched_at, checked_at, library_version)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (*where, raw, now_ms, now_ms, library_version),
        )
    elif payload is None or row[0] == raw:
        conn.execute(
            "UPDATE raw_response SET checked_at = ?"
            " WHERE scope = ? AND key = ? AND endpoint = ?",
            (now_ms, *where),
        )
    else:
        conn.execute(
            "UPDATE raw_response"
            " SET raw = ?, fetched_at = ?, checked_at = ?, library_version = ?"
            " WHERE scope = ? AND key = ? AND endpoint = ?",
            (raw, now_ms, now_ms, library_version, *where),
        )


def _lock_path(cfg: config.Config) -> Path:
    return cfg.data_dir / LOCK_FILENAME


def _refuse_runtime_under_pytest(cfg: config.Config) -> None:
    """pytest 안에서 `runtime` 아래 data_dir·DB·락을 거부한다(NFR12).

    data_dir 그대로와 data_dir·DB·락 파일의 `resolve()` 결과를 보므로 심링크로 닿아도 막는다.
    대소문자를 가리지 않는 파일시스템(macOS)을 생각해 구성요소를 `casefold()`로 비교한다.
    """
    if not config.under_pytest():
        return
    candidates = (
        cfg.data_dir,
        cfg.data_dir.resolve(),
        cfg.db_path.resolve(),
        _lock_path(cfg).resolve(),
        (cfg.data_dir / REPORT_LOCK_FILENAME).resolve(),
    )
    for candidate in candidates:
        if any(part.casefold() == _GUARDED_COMPONENT for part in candidate.parts):
            raise StoreError(
                f"pytest 안에서는 `{_GUARDED_COMPONENT}` 아래 data_dir·DB·락을 쓰지 않는다: "
                f"{candidate}"
            )


@contextlib.contextmanager
def _write_lock(cfg: config.Config) -> Iterator[None]:
    """`<data_dir>/.write.lock`에 `flock(LOCK_EX)`을 잡고, 나갈 때 푼다."""
    lock_path = _lock_path(cfg)
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        info = os.fstat(fd)
        key = (info.st_dev, info.st_ino)
        if key in _held_locks:
            raise RuntimeError(
                f"이 프로세스가 이미 쓰기 락을 쥐고 있다(write_session 중첩): {lock_path}"
            )
        _acquire(fd, lock_path, cfg.lock_wait_seconds)
        _held_locks.add(key)
        try:
            yield
        finally:
            _held_locks.discard(key)
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _acquire(fd: int, lock_path: Path, wait_seconds: float) -> None:
    """`LOCK_NB`를 짧은 간격으로 다시 시도한다. `wait_seconds`가 0이면 한 번만 시도한다."""
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LockTimeout(
                    f"쓰기 락을 {wait_seconds:g}초 안에 잡지 못했다: {lock_path}"
                ) from None
            time.sleep(min(_LOCK_RETRY_SECONDS, remaining))


def _close(conn: sqlite3.Connection) -> None:
    """열린 트랜잭션을 롤백하고 연결을 닫는다. 롤백이 실패해도 닫는다."""
    try:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
    finally:
        conn.close()


def _load_migrations() -> list[_Migration]:
    """마이그레이션 목록을 번호순으로 읽어 검증한다. 잘못되면 `MigrationError`다.

    이름은 `NNNN_<소문자·숫자·밑줄>.sql`이고 번호는 0001부터 빈틈없이 이어진다. `.`으로
    시작하는 이름(`.gitkeep` 등)은 무시한다.
    """
    directory = _migrations_dir()
    if not directory.is_dir():
        raise MigrationError(f"마이그레이션 폴더가 없다: {directory}")
    migrations: dict[int, _Migration] = {}
    for entry in sorted(directory.iterdir(), key=lambda entry: entry.name):
        name = entry.name
        if name.startswith("."):
            continue
        match = _MIGRATION_NAME.fullmatch(name)
        if match is None or not entry.is_file():
            raise MigrationError(
                f"마이그레이션 파일 이름이 `NNNN_<name>.sql` 형식이 아니다: {name}"
            )
        number = int(match[1])
        if number == 0:
            raise MigrationError(f"마이그레이션 번호는 0001부터다: {name}")
        if number in migrations:
            raise MigrationError(
                f"마이그레이션 번호 {match[1]}이 겹친다: {migrations[number].name}, {name}"
            )
        migrations[number] = _Migration(number, name, entry)
    for expected, number in enumerate(sorted(migrations), start=1):
        if number != expected:
            raise MigrationError(
                f"마이그레이션 번호는 0001부터 빈틈없이 이어져야 한다: "
                f"{expected:04d} 자리에 {migrations[number].name}"
            )
    return [migrations[number] for number in sorted(migrations)]


def _latest(migrations: list[_Migration]) -> int:
    return migrations[-1].number if migrations else 0


def _user_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def _migrate(conn: sqlite3.Connection, migrations: list[_Migration]) -> None:
    """밀린 마이그레이션을 파일 하나씩 트랜잭션 하나로 적용한다."""
    for migration in migrations[_user_version(conn) :]:
        try:
            script = migration.source.read_text(encoding="utf-8")
            with transaction(conn):
                conn.executescript(script)
                if not conn.in_transaction:
                    # 스크립트가 `COMMIT` 등으로 트랜잭션을 스스로 끝냈다. 번호는 올리지 않는다.
                    raise MigrationError("스크립트가 트랜잭션을 스스로 끝냈다")
                conn.execute(f"PRAGMA user_version = {migration.number:d}")
        except Exception as error:
            raise MigrationError(
                f"마이그레이션 {migration.name}을 적용하지 못했다: {error}"
            ) from error
