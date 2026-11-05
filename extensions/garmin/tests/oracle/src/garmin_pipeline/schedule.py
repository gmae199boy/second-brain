"""운영 루트의 collect·report 예약: launchd LaunchAgent plist 두 개를 만들고 로드한다(FR38·39, AD-11·14).

- 운영 루트는 config 파일이 있는 폴더다. `scripts/deploy.sh`가 그 아래 `.venv`에 lock 기준 비편집
  스냅샷을 설치하고(AD-14) skill을 복사한 뒤 마지막에 `install-schedule`을 부른다.
- `find_codex()`: `PATH`에서 `codex`를 찾아 절대경로로 돌려준다(심링크는 풀지 않는다). launchd는 셸
  프로필을 읽지 않으므로 report plist의 `PATH`에 이 폴더를 넣는다(`launchd_path`).
- `refusals(cfg, *, system_zone, in_pytest, codex)`: 예약을 거부할 사유를 모두 모은다(pytest 안,
  `environment != "runtime"`, `collect_time < retry_time < report_time` 아님, 시스템 시간대가
  config `timezone`과 다르거나 알 수 없음, 스냅샷 실행 파일 없음, `codex`를 찾지 못함). 부작용이 없다.
- `collect_plist(cfg)`·`report_plist(cfg, codex)`: plist 바이트를 만드는 순수 함수다. 시각은 config
  값만 쓰고(AD-11) 시스템 로컬 시각은 쓰지 않는다. 키를 정렬해 쓰므로 같은 입력이면 같은 바이트다(멱등).
- `install(cfg)`: 거부 사유가 하나라도 있으면 모두 stderr에 쓰고 1이다. 통과하면 `<data_dir>/logs`
  (0700), 두 plist 원자적 쓰기(0644), 그다음 collect·report 순으로 label마다 `launchctl print`가 0일
  때만 `bootout`, 그다음 `bootstrap`. 폐기된 `launchctl load`/`unload`는 쓰지 않는다. `subprocess`는
  `install`에서만 쓴다.

stdlib과 `config`·`dates`만 import한다.
"""

import contextlib
import logging
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
from datetime import time
from pathlib import Path

from garmin_pipeline import config, dates

COLLECT_LABEL = "local.garmin-pipeline.collect"
REPORT_LABEL = "local.garmin-pipeline.report"
CODEX = "codex"
VENV_DIRNAME = ".venv"
EXECUTABLE = Path("bin") / "garmin-pipeline"
LOGS_DIRNAME = "logs"
STDOUT_LOG = "launchd-collect.out.log"
STDERR_LOG = "launchd-collect.err.log"
REPORT_STDOUT_LOG = "launchd-report.out.log"
REPORT_STDERR_LOG = "launchd-report.err.log"
# launchd가 에이전트에 주는 기본 `PATH`. report plist에는 codex 폴더를 그 앞에 더한다.
LAUNCHD_BASE_PATH = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
PLIST_MODE = 0o644
LAUNCHCTL = "launchctl"

logger = logging.getLogger(__name__)


def runtime_root(cfg: config.Config) -> Path:
    """운영 루트: config 파일이 있는 폴더(절대경로, `resolve`하지 않음)."""
    return cfg.path.parent


def executable(cfg: config.Config) -> Path:
    """예약할 스냅샷 실행 파일: `<운영 루트>/.venv/bin/garmin-pipeline`."""
    return runtime_root(cfg) / VENV_DIRNAME / EXECUTABLE


def default_agents_dir() -> Path:
    """사용자 LaunchAgents 폴더: `~/Library/LaunchAgents`(`HOME` 기준)."""
    return Path.home() / "Library" / "LaunchAgents"


def plist_path(agents_dir: Path, label: str) -> Path:
    return agents_dir / f"{label}.plist"


def find_codex() -> Path | None:
    """`PATH`에서 찾은 `codex`의 절대경로(심링크를 풀지 않음). 없으면 None."""
    found = shutil.which(CODEX)
    return None if found is None else Path(found).absolute()


def launchd_path(codex: Path) -> str:
    """report plist의 `PATH`: codex 폴더 + launchd 기본 폴더(codex 폴더가 기본 폴더면 중복 없음)."""
    folder = str(codex.parent)
    extra = [] if folder in LAUNCHD_BASE_PATH else [folder]
    return ":".join([*extra, *LAUNCHD_BASE_PATH])


def refusals(
    cfg: config.Config,
    *,
    system_zone: str | None,
    in_pytest: bool,
    codex: Path | None,
) -> list[str]:
    """예약을 거부할 사유를 모두 돌려준다. 비어 있으면 통과다."""
    reasons: list[str] = []
    if in_pytest:
        reasons.append("pytest 안에서는 예약을 설치하지 않는다")
    if cfg.environment != "runtime":
        reasons.append(
            f'`environment`가 "runtime"이 아니다(받은 값: {cfg.environment!r}). '
            "운영 루트의 config로 실행한다"
        )
    if not cfg.collect_time < cfg.retry_time < cfg.report_time:
        reasons.append(
            "`collect_time` < `retry_time` < `report_time`이어야 한다(받은 값: "
            f"{_hhmm(cfg.collect_time)}·{_hhmm(cfg.retry_time)}·{_hhmm(cfg.report_time)})"
        )
    if system_zone is None:
        reasons.append(
            f"시스템 시간대를 알 수 없다(config `timezone`: {cfg.timezone}). "
            "launchd는 시스템 시각으로 예약한다"
        )
    elif system_zone != cfg.timezone:
        reasons.append(
            f"시스템 시간대({system_zone})가 config `timezone`({cfg.timezone})과 다르다. "
            "launchd는 시스템 시각으로 예약한다"
        )
    binary = executable(cfg)
    if not (binary.is_file() and os.access(binary, os.X_OK)):
        reasons.append(
            f"스냅샷 실행 파일이 없거나 실행할 수 없다: {binary}. "
            "scripts/deploy.sh로 배포한다"
        )
    if codex is None:
        reasons.append(
            f"`{CODEX}`를 PATH에서 찾지 못했다. report 예약은 설치할 때 찾은 codex 폴더를 "
            "PATH로 넣으므로 codex가 필요하다"
        )
    return reasons


def collect_plist(cfg: config.Config) -> bytes:
    """collect LaunchAgent plist(XML). 모든 경로는 절대경로다."""
    root = runtime_root(cfg)
    logs_dir = cfg.data_dir / LOGS_DIRNAME
    agent = {
        "Label": COLLECT_LABEL,
        "ProgramArguments": [
            str(executable(cfg)),
            "collect",
            "--config",
            str(cfg.path),
        ],
        "WorkingDirectory": str(root),
        "StartCalendarInterval": [
            {"Hour": moment.hour, "Minute": moment.minute}
            for moment in (cfg.collect_time, cfg.retry_time)
        ],
        "StandardOutPath": str(logs_dir / STDOUT_LOG),
        "StandardErrorPath": str(logs_dir / STDERR_LOG),
    }
    return plistlib.dumps(agent, fmt=plistlib.FMT_XML, sort_keys=True)


def report_plist(cfg: config.Config, codex: Path) -> bytes:
    """report LaunchAgent plist(XML). 모든 경로는 절대경로이고 `PATH`에 codex 폴더가 들어간다."""
    logs_dir = cfg.data_dir / LOGS_DIRNAME
    agent = {
        "Label": REPORT_LABEL,
        "ProgramArguments": [
            str(executable(cfg)),
            "report",
            "--config",
            str(cfg.path),
        ],
        "WorkingDirectory": str(runtime_root(cfg)),
        "StartCalendarInterval": [
            {"Hour": cfg.report_time.hour, "Minute": cfg.report_time.minute}
        ],
        "StandardOutPath": str(logs_dir / REPORT_STDOUT_LOG),
        "StandardErrorPath": str(logs_dir / REPORT_STDERR_LOG),
        "EnvironmentVariables": {"PATH": launchd_path(codex)},
    }
    return plistlib.dumps(agent, fmt=plistlib.FMT_XML, sort_keys=True)


def write_plist(path: Path, data: bytes) -> None:
    """같은 폴더 임시 파일에 쓰고 `os.replace`로 바꾼다(0644). 폴더가 없으면 만든다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, PLIST_MODE)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def launchctl_print(uid: int, label: str) -> list[str]:
    return [LAUNCHCTL, "print", f"gui/{uid}/{label}"]


def launchctl_bootout(uid: int, label: str) -> list[str]:
    return [LAUNCHCTL, "bootout", f"gui/{uid}/{label}"]


def launchctl_bootstrap(uid: int, plist: Path) -> list[str]:
    return [LAUNCHCTL, "bootstrap", f"gui/{uid}", str(plist)]


def check(cfg: config.Config) -> bool:
    """현재 시스템 상태로 거부 사유를 모두 stderr에 한 줄씩 쓴다. 통과하면 참이다."""
    return _check(cfg, find_codex())


def _check(cfg: config.Config, codex: Path | None) -> bool:
    reasons = refusals(
        cfg,
        system_zone=dates.system_timezone(),
        in_pytest=config.under_pytest(),
        codex=codex,
    )
    for reason in reasons:
        print(f"install-schedule 거부: {reason}", file=sys.stderr)
    return not reasons


def install(cfg: config.Config, *, agents_dir: Path | None = None) -> int:
    """collect·report 예약을 설치(또는 같은 내용으로 교체)하고 로드한다. 0 성공, 1 거부·실패."""
    codex = find_codex()  # 한 번만 찾아 거부 검사와 report plist에 같은 값을 쓴다
    if not _check(cfg, codex) or codex is None:
        return 1
    folder = default_agents_dir() if agents_dir is None else agents_dir
    agents = [
        ("collect", COLLECT_LABEL, collect_plist(cfg)),
        ("report", REPORT_LABEL, report_plist(cfg, codex)),
    ]
    uid = os.getuid()
    try:
        logs_dir = cfg.data_dir / LOGS_DIRNAME
        # 건강 데이터 폴더라 새로 만드는 data_dir과 logs는 0700이다(이미 있는 data_dir은 그대로).
        cfg.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        logs_dir.mkdir(mode=0o700, exist_ok=True)
        os.chmod(logs_dir, 0o700)
        for _, label, data in agents:
            write_plist(plist_path(folder, label), data)
    except OSError as error:
        print(f"install-schedule 실패: {error}", file=sys.stderr)
        logger.error(
            "install-schedule 실패: stage=write error=%s", type(error).__name__
        )
        return 1
    for _, label, _ in agents:
        logger.info("install-schedule plist: %s", plist_path(folder, label))

    replaced: dict[str, bool] = {}
    for name, label, _ in agents:
        target = plist_path(folder, label)
        loaded = _load(uid, name, label, target)
        if loaded is None:
            return 1
        replaced[name] = loaded
    logger.info(
        "install-schedule 끝: collect_replaced=%s report_replaced=%s "
        "collect=%s retry=%s report=%s codex=%s",
        replaced["collect"],
        replaced["report"],
        _hhmm(cfg.collect_time),
        _hhmm(cfg.retry_time),
        _hhmm(cfg.report_time),
        codex,
    )
    for _, label, _ in agents:
        print(f"예약을 설치했다: {label} ({plist_path(folder, label)})")
    return 0


def _load(uid: int, name: str, label: str, target: Path) -> bool | None:
    """label 하나를 (로드돼 있으면 내리고) 로드한다. 이미 로드돼 있었으면 참, 실패하면 None."""
    try:
        probe = subprocess.run(
            launchctl_print(uid, label), capture_output=True, text=True, check=False
        )
        loaded = probe.returncode == 0
        steps = [launchctl_bootout(uid, label)] if loaded else []
        steps.append(launchctl_bootstrap(uid, target))
        for argv in steps:
            result = subprocess.run(argv, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                reason = (result.stderr or result.stdout or "").strip()
                print(
                    f"install-schedule 실패: `{' '.join(argv)}` 종료 코드 "
                    f"{result.returncode}: {reason}. {name} 예약이 내려가 있을 수 있다. "
                    f"{_skipped(name)}scripts/deploy.sh를 다시 실행한다",
                    file=sys.stderr,
                )
                logger.error(
                    "install-schedule 실패: stage=launchctl-%s label=%s returncode=%d",
                    argv[1],
                    label,
                    result.returncode,
                )
                return None
    except OSError as error:
        print(
            f"install-schedule 실패: launchctl을 실행하지 못했다: {error}. "
            f"{name} 예약이 내려가 있을 수 있다. {_skipped(name)}"
            "scripts/deploy.sh를 다시 실행한다",
            file=sys.stderr,
        )
        logger.error(
            "install-schedule 실패: stage=launchctl label=%s error=%s",
            label,
            type(error).__name__,
        )
        return None
    return loaded


def _skipped(name: str) -> str:
    """collect 단계에서 멈추면 report plist는 썼지만 로드하지 않았다는 안내(report 단계면 빈 문자열)."""
    if name != "collect":
        return ""
    return "report plist는 썼지만 report 예약은 다시 로드하지 않았다. "


def _hhmm(moment: time) -> str:
    return f"{moment.hour:02d}:{moment.minute:02d}"
