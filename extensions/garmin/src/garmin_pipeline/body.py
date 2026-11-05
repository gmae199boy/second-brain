"""체성분 입력 장부: `garmin-pipeline body {pending,write,reject}`(FR23·24·25, NFR3, AD-9).

경로 규칙:
- 운영 루트 = config 파일이 있는 폴더(`cfg.path.parent`, `schedule.runtime_root`와 같은 정의).
  입력 폴더 = `<inbox_dir>/inbody`, 장부 폴더 = `<data_dir>/body`. 둘 다 운영 루트 안이어야 한다.
- 출력과 `source_files`의 경로는 모두 운영 루트 기준 상대 POSIX 경로다. 포함 판정은 `resolve()`한 경로끼리
  한다(macOS `/var` → `/private/var`).
- `--source`와 `reject <file>`은 상대 경로여야 하고, 운영 루트 기준으로 풀었을 때 입력 폴더 바로 아래의 일반
  파일(심볼릭 링크 아님)이어야 한다. 그 밖은 `BodyError`다.

명령:
- `pending(cfg)`: 입력 폴더 바로 아래의 일반 파일(하위 폴더·심볼릭 링크·`.`으로 시작하는 파일 제외)을 이름 순으로
  돌려준다. 입력 폴더가 없으면 빈 목록이다. 읽기만 한다.
- `write(cfg, measured_on, sources, stdin_text)`: 날짜·경로 검사 → stdin JSON 파싱(`NaN`·`Infinity`·중복 키
  거부)과 `schemas/body.schema.json`의 `$defs/measurement` 검증 → 같은 측정일 사이드카 읽기(손상이면 거부)와
  키별 병합 → 병합 결과를 루트 스키마로 자체 검증 → 원자적 쓰기(같은 폴더 임시 파일 0600 → `os.replace`) →
  입력을 `processed/`로 이동. 이동 전 단계가 하나라도 실패하면 아무것도 쓰거나 옮기지 않고 `BodyError`다.
  병합은 키마다 기존 `value_mtime_ns[k]`가 입력 mtime(`--source`들 `st_mtime_ns`의 최댓값)보다 크면 기존 값을
  두고, 아니면(같으면 포함) 새 값을 쓴다. 기존에만 있는 키는 남고 `source_files`는 순서를 지켜 누적한다.
- `reject(cfg, path)`: 경로 검사 후 입력을 `unreadable/`로 옮긴다.
- 이동은 `processed/`·`unreadable/`(없으면 0700으로 만듦) 안에 같은 이름으로, 이미 있으면 덮어쓰지 않고
  `<stem>-2<suffix>`, `-3`…으로 `os.rename`한다(mtime 보존). 입력을 지우거나 덮어쓰지 않는다.
- 새로 만드는 `data_dir`·`data/body`는 0700이다. 측정일이 config timezone 기준 오늘보다 뒤이면 거부한다.

로그(`garmin_pipeline.body` 로거)에는 경로·개수만 남기고 측정값과 검증 메시지(값이 들어 있을 수 있다)는 남기지
않는다(AD-12). 네트워크를 쓰지 않고 운영 루트 밖에 쓰지 않는다. 이미지·Markdown 내용은 읽지 않는다.

최상위에서 stdlib과 `config`·`dates`만 import한다. `jsonschema`는 검증 함수 안에서 늦게 import한다.
"""

import contextlib
import importlib.resources
import json
import logging
import math
import os
import stat
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from garmin_pipeline import config, dates

INBODY_DIRNAME = "inbody"
BODY_DIRNAME = "body"
PROCESSED_DIRNAME = "processed"
UNREADABLE_DIRNAME = "unreadable"
SCHEMA_FILENAME = "body.schema.json"
SCHEMA_VERSION = 1
_DIR_MODE = 0o700

logger = logging.getLogger(__name__)


class BodyError(Exception):
    """명령을 거부했다. 메시지는 stderr용이다(입력 값이 들어 있을 수 있어 로그에 쓰지 않는다).

    `.kind`는 로그에 남기는 짧은 분류(`path`·`date`·`input`·`sidecar`·`internal`)다.
    """

    def __init__(self, message: str, kind: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class WriteResult:
    measured_on: str
    body_path: str
    processed: list[str]


# --- 경로 ----------------------------------------------------------------------------------


def runtime_root(cfg: config.Config) -> Path:
    """운영 루트: config 파일이 있는 폴더(`schedule.runtime_root`와 같은 정의)."""
    return cfg.path.parent


def inbox_dir(cfg: config.Config) -> Path:
    """체성분 입력 폴더: `<inbox_dir>/inbody`."""
    return cfg.inbox_dir / INBODY_DIRNAME


def body_dir(cfg: config.Config) -> Path:
    """체성분 장부 폴더: `<data_dir>/body`."""
    return cfg.data_dir / BODY_DIRNAME


def _inside_root(cfg: config.Config, path: Path, what: str) -> Path:
    """`path`를 `resolve()`해 운영 루트 안이면 돌려준다. 밖이면 `BodyError`다."""
    resolved = path.resolve()
    if not resolved.is_relative_to(runtime_root(cfg).resolve()):
        raise BodyError(f"{what}가 운영 루트 밖이다: {path}", "path")
    return resolved


def _relative(cfg: config.Config, resolved: Path) -> str:
    """운영 루트 안의 `resolve()`된 경로를 루트 기준 상대 POSIX 경로로 바꾼다."""
    return resolved.relative_to(runtime_root(cfg).resolve()).as_posix()


def _inbox_file(cfg: config.Config, raw: str) -> Path:
    """`--source`·`reject` 인자를 입력 폴더 바로 아래 일반 파일의 `resolve()`된 경로로 바꾼다."""
    if not raw:
        raise BodyError("빈 경로다", "path")
    candidate = Path(raw)
    if candidate.is_absolute():
        raise BodyError(f"절대경로는 받지 않는다: {raw}", "path")
    inbox = _inside_root(cfg, inbox_dir(cfg), "입력 폴더")
    joined = runtime_root(cfg) / candidate
    if joined.name in ("", ".", "..") or joined.parent.resolve() != inbox:
        raise BodyError(f"입력 폴더 바로 아래 파일이 아니다: {raw}", "path")
    path = inbox / joined.name
    # 대소문자를 가리지 않는 파일시스템(APFS)에서 `A.png`가 `a.png`로 풀리지 않게, 적힌 그대로의 이름만 받는다.
    try:
        exact = joined.name in os.listdir(inbox)
        mode = path.lstat().st_mode
    except FileNotFoundError:
        exact = False
    if not exact:
        raise BodyError(f"파일이 없다: {raw}", "path")
    if stat.S_ISLNK(mode):
        raise BodyError(f"심볼릭 링크는 받지 않는다: {raw}", "path")
    if not stat.S_ISREG(mode):
        raise BodyError(f"일반 파일이 아니다: {raw}", "path")
    return path


def _check_move_dir(directory: Path) -> None:
    """이동할 폴더가 없거나 진짜 폴더(심볼릭 링크 아님)인지 본다."""
    try:
        mode = directory.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(mode):
        raise BodyError(f"이동할 폴더가 폴더가 아니다: {directory.name}", "path")


def _move(source: Path, directory: Path) -> Path:
    """`source`를 `directory`(없으면 0700으로 만듦)에 덮어쓰지 않는 이름으로 옮기고 새 경로를 돌려준다."""
    _check_move_dir(directory)
    directory.mkdir(mode=_DIR_MODE, exist_ok=True)
    target = directory / source.name
    number = 2
    while os.path.lexists(target):
        target = directory / f"{source.stem}-{number}{source.suffix}"
        number += 1
    os.rename(source, target)
    return target


# --- 스키마·JSON --------------------------------------------------------------------------


def load_schema() -> dict[str, Any]:
    """패키지에 넣은 `schemas/body.schema.json`."""
    resource = (
        importlib.resources.files("garmin_pipeline") / "schemas" / SCHEMA_FILENAME
    )
    return json.loads(resource.read_text(encoding="utf-8"))


def _measurement_keys(schema: dict[str, Any]) -> list[str]:
    return list(schema["$defs"]["measurement"]["properties"])


def _first_error(schema: dict[str, Any], instance: object) -> str | None:
    """`instance`가 `schema`에 맞으면 `None`, 아니면 가장 알맞은 오류 한 줄."""
    import jsonschema  # 검증할 때만 늦게 import

    validator = jsonschema.Draft202012Validator(schema)
    error = jsonschema.exceptions.best_match(validator.iter_errors(instance))
    if error is None:
        return None
    location = "".join(f"[{part!r}]" for part in error.absolute_path) or "(루트)"
    return f"{location}: {error.message}"


def _measurement_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """루트 스키마의 `$defs`를 그대로 두고 `$defs/measurement`를 가리키는 스키마."""
    return {
        "$schema": schema["$schema"],
        "$defs": schema["$defs"],
        "$ref": "#/$defs/measurement",
    }


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"중복 키: {key!r}")
        result[key] = value
    return result


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name}은 받지 않는다")


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("유한하지 않은 수는 받지 않는다")
    return value


def _strict_json(text: str) -> object:
    """`NaN`·`Infinity`·범위를 넘는 실수·중복 키를 거부하는 `json.loads`. 실패하면 `ValueError`다."""
    return json.loads(
        text,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_constant,
        parse_float=_finite_float,
    )


# --- 명령 ----------------------------------------------------------------------------------


def pending(cfg: config.Config) -> list[str]:
    """입력 폴더 바로 아래 일반 파일의 상대 POSIX 경로(이름 순). 폴더가 없으면 빈 목록이다."""
    directory = inbox_dir(cfg)
    if not directory.is_dir():
        logger.info("body pending: 입력 폴더 없음")
        return []
    inbox = _inside_root(cfg, directory, "입력 폴더")
    with os.scandir(inbox) as entries:
        names = sorted(
            entry.name
            for entry in entries
            if not entry.name.startswith(".") and entry.is_file(follow_symlinks=False)
        )
    logger.info("body pending: %d개", len(names))
    return [_relative(cfg, inbox / name) for name in names]


def write(
    cfg: config.Config, measured_on: date, sources: Iterable[str], stdin_text: str
) -> WriteResult:
    """측정 1건을 검증해 측정일 사이드카에 병합해 쓰고 입력을 `processed/`로 옮긴다."""
    try:
        return _write(cfg, measured_on, list(sources), stdin_text)
    except BodyError as error:
        logger.warning("body write 거부: %s", error.kind)
        raise


def reject(cfg: config.Config, raw: str) -> str:
    """입력 하나를 `unreadable/`로 옮기고 옮긴 상대 경로를 돌려준다."""
    try:
        source = _inbox_file(cfg, raw)
    except BodyError as error:
        logger.warning("body reject 거부: %s", error.kind)
        raise
    moved = _move(source, source.parent / UNREADABLE_DIRNAME)
    relative = _relative(cfg, moved)
    logger.info("body reject: %s", relative)
    return relative


def _write(
    cfg: config.Config, measured_on: date, raw_sources: list[str], stdin_text: str
) -> WriteResult:
    # 1. 날짜·경로
    if measured_on > dates.today(cfg):
        raise BodyError(f"측정일이 오늘보다 뒤다: {measured_on.isoformat()}", "date")
    if not raw_sources:
        raise BodyError("--source가 없다", "path")
    sources: list[Path] = []
    for raw in raw_sources:
        path = _inbox_file(cfg, raw)
        if path not in sources:
            sources.append(path)
    processed_dir = sources[0].parent / PROCESSED_DIRNAME
    _check_move_dir(processed_dir)
    ledger = _inside_root(cfg, body_dir(cfg), "장부 폴더")
    sidecar = ledger / f"{measured_on.isoformat()}.json"
    source_mtime = max(path.lstat().st_mtime_ns for path in sources)

    # 2. stdin
    schema = load_schema()
    try:
        measurement = _strict_json(stdin_text)
    except (ValueError, RecursionError) as error:
        raise BodyError(f"stdin이 올바른 JSON이 아니다: {error}", "input") from None
    problem = _first_error(_measurement_schema(schema), measurement)
    if problem is not None:
        raise BodyError(f"stdin이 측정 스키마에 맞지 않는다: {problem}", "input")
    assert isinstance(measurement, dict)

    # 3. 기존 사이드카와 병합
    existing = read_sidecar(schema, sidecar, measured_on)
    keys = _measurement_keys(schema)
    values: dict[str, Any] = dict(existing["values"]) if existing else {}
    mtimes: dict[str, int] = dict(existing["value_mtime_ns"]) if existing else {}
    properties = schema["$defs"]["measurement"]["properties"]
    for key, value in measurement.items():
        if mtimes.get(key, -1) > source_mtime:
            continue
        # jsonschema는 78.0도 integer로 받으므로 정수 키는 int로 저장한다.
        values[key] = int(value) if properties[key]["type"] == "integer" else value
        mtimes[key] = source_mtime
    source_files: list[str] = list(existing["source_files"]) if existing else []
    for path in sources:
        relative = _relative(cfg, path)
        if relative not in source_files:
            source_files.append(relative)
    doc = {
        "schema_version": SCHEMA_VERSION,
        "measured_on": measured_on.isoformat(),
        "values": {key: values[key] for key in keys if key in values},
        "value_mtime_ns": {key: mtimes[key] for key in keys if key in mtimes},
        "source_files": source_files,
    }

    # 4. 자체 검증
    problem = _first_error(schema, doc)
    if problem is not None:
        raise BodyError(
            f"병합한 사이드카가 스키마에 맞지 않는다: {problem}", "internal"
        )

    # 5. 원자적 쓰기. 건강 데이터 폴더라 새로 만드는 data_dir은 0700이고, body 폴더는 이미 있어도 0700으로 좁힌다.
    cfg.data_dir.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
    ledger.mkdir(mode=_DIR_MODE, exist_ok=True)
    os.chmod(ledger, _DIR_MODE)
    _atomic_write(sidecar, json.dumps(doc, ensure_ascii=False, indent=2) + "\n")

    # 6. 입력 이동
    processed = [_relative(cfg, _move(path, processed_dir)) for path in sources]
    body_path = _relative(cfg, sidecar)
    logger.info(
        "body write: %s 키 %d개, 입력 %d개 → %s",
        doc["measured_on"],
        len(measurement),
        len(processed),
        body_path,
    )
    return WriteResult(doc["measured_on"], body_path, processed)


def read_sidecar(
    schema: dict[str, Any], sidecar: Path, measured_on: date
) -> dict[str, Any] | None:
    """같은 측정일 사이드카를 읽어 검증한다. 없으면 `None`, 손상이면 `BodyError`다."""
    try:
        mode = sidecar.lstat().st_mode
    except FileNotFoundError:
        return None
    name = sidecar.name
    if not stat.S_ISREG(mode):
        raise BodyError(f"기존 사이드카가 일반 파일이 아니다: {name}", "sidecar")
    try:
        doc = _strict_json(sidecar.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise BodyError(
            f"기존 사이드카가 올바른 JSON이 아니다: {name}", "sidecar"
        ) from None
    problem = _first_error(schema, doc)
    if problem is not None:
        raise BodyError(
            f"기존 사이드카가 스키마에 맞지 않는다: {name}: {problem}", "sidecar"
        )
    assert isinstance(doc, dict)
    if doc["measured_on"] != measured_on.isoformat():
        raise BodyError(
            f"기존 사이드카의 측정일이 파일 이름과 다르다: {name}", "sidecar"
        )
    if set(doc["values"]) != set(doc["value_mtime_ns"]):
        raise BodyError(
            f"기존 사이드카의 values와 value_mtime_ns 키가 다르다: {name}", "sidecar"
        )
    return doc


def _atomic_write(path: Path, text: str) -> None:
    """같은 폴더의 임시 파일(0600)에 쓰고 `os.replace`한다. 실패하면 임시 파일을 지우고 다시 던진다."""
    fd, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with open(fd, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise
