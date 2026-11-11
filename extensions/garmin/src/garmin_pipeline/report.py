"""Daily AI analysis, body intake, graph assembly, and atomic report delivery.

Native inputs are read from PostgreSQL by report_input and charts.
Codex runs in the runtime root in the supervisor process group and without API keys.
"""

import contextlib
import importlib.resources
import json
import logging
import os
import shutil
import signal
import psycopg
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

from garmin_pipeline import (
    body,
    charts,
    config,
    dates,
    digest,
    errors,
    ports,
    report_input,
    report_message,
    store,
)

GRAPH_HEADING = "## 그래프"
FALLBACK_MARKER = "> 몸상태 종합을 쓰지 못했다"
"""폴백 하루 분석 본문의 첫머리. 예약 실행 판정은 evaluation을 읽는다."""
SKILL_MESSAGE_MAX = 200
"""폴백에 붙이는 skill 메시지 한 줄의 최대 글자 수."""

STATUS_OK = "ok"
STATUS_FAILED = "failed"
DAILY_STATUSES = (STATUS_OK, STATUS_FAILED)
"""`schemas/daily_analysis_output.schema.json`의 `status` enum과 같다(테스트가 고정한다)."""

class AnalysisAgentNotFound(RuntimeError):
    """설정된 분석 실행 파일을 사용할 수 없다."""


def codex_executable(env=None) -> str:
    actual = os.environ if env is None else env
    value = actual.get("BRAIN_CODEX_PATH", "")
    if not value or not Path(value).is_absolute() or not Path(value).is_file() or not os.access(value, os.X_OK):
        raise AnalysisAgentNotFound(
            "ANALYSIS_AGENT_NOT_FOUND: brain config set agent.codex_path <절대경로>로 실행 파일을 설정하세요"
        )
    return value
CODEX_SKILL_PROMPT = "$garmin-daily-analysis"
"""프롬프트 첫 줄(skill 호출). 셸을 거치지 않으므로 그대로 넘어간다."""
CODEX_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg")
"""첨부하는 이미지 확장자(소문자로 비교한다)."""
PROGRESS_INTERVAL_SECONDS = 30
KILL_GRACE_SECONDS = 5
"""그룹에 SIGTERM을 보낸 뒤 SIGKILL 전까지 리더를 기다리는 시간(초)."""
REPORT_OUTPUT_SCHEMA = "daily_analysis_output.schema.json"
"""패키지 리소스 `schemas/` 아래 codex 최종 메시지 스키마 파일 이름."""
CODEX_OUTPUT_FILENAME = "analysis.json"
"""`-o` 파일 이름(`<data_dir>/.codex-*` 임시 폴더 안)."""
_STRIPPED_ENV = ("OPENAI_API_KEY", "CODEX_API_KEY")
"""codex 하위 프로세스 env에서 빼는 키(API 키 금지, ChatGPT 로그인만 쓴다)."""

FALLBACK_TEXT: dict[errors.ReportFailReason, str] = {
    errors.ReportFailReason.CODEX_TIMEOUT: "분석 시간이 제한을 넘었다",
    errors.ReportFailReason.CODEX_FAILED: "분석 실행기가 실패했다",
    errors.ReportFailReason.OUTPUT_INVALID: "분석 결과가 정해진 형식이 아니다",
    errors.ReportFailReason.SKILL_FAILED: "분석 절차를 끝내지 못했다",
}
"""작성기 실패 사유별 폴백 문구. 작성기 실패는 이 네 사유뿐이다."""

_DIR_MODE = 0o700

logger = logging.getLogger(__name__)

@dataclass(frozen=True)
class DailyAnalysis:
    """Validated analysis, structured evaluation fields and optional numeric usage."""

    status: str
    report_md: str
    summary: str = ""
    judgments: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)
    next_checks: list[str] = field(default_factory=list)
    usage: dict[str, int] | None = None
    message: dict | None = None


class WriterFailed(Exception):
    """작성기가 하루 분석을 쓰지 못했다. `.reason`은 `errors.ReportFailReason`이다.

    `.detail`은 로그에 남는 짧은 진단(종료 코드 등)이다. 본문·건강 수치를 넣지 않는다.
    """

    def __init__(self, reason: errors.ReportFailReason | str, detail: str = "") -> None:
        self.reason = errors.ReportFailReason(reason)
        self.detail = detail
        super().__init__(f"{self.reason}: {detail}" if detail else str(self.reason))


class DailyWriter(Protocol):
    """하루 분석 본문을 쓰는 교체 지점. CLI는 `CodexWriter`, 테스트는 fake를 쓴다."""

    def period(
        self, cfg: config.Config, inputs: list[str], scope: str
    ) -> DailyAnalysis:
        """Review one prepared period using the same output contract."""
        ...

    def write(self, cfg: config.Config, inputs: list[str]) -> DailyAnalysis:
        """`inputs`의 입력 폴더(운영 루트 기준 상대 경로)를 참고해 하루 분석을 쓴다.

        실패는 `WriterFailed`로 알린다.
        """
        ...


# --- codex 실행기 ----------------------------------------------------------------------------


def codex_images(inputs: list[str]) -> list[str]:
    """`inputs` 중 첨부할 이미지(확장자 `.png`·`.jpg`·`.jpeg`, 대소문자 무시), `inputs` 순서 그대로."""
    return [
        path for path in inputs if Path(path).suffix.lower() in CODEX_IMAGE_SUFFIXES
    ]


def codex_prompt(
    inputs: list[str], *, intake: bool = False, scope: str | None = None
) -> str:
    """Daily folder path, or body images in attachment order, relative to runtime."""
    if intake:
        listing = [f"{n}. {path}" for n, path in enumerate(inputs, 1)]
        return "\n".join(
            [
                "$garmin-body-intake",
                "",
                "첨부 이미지(첨부 순서, 운영 루트 기준 경로):",
                *(listing or ["없음"]),
            ]
        )
    return "\n".join(
        [
            f"$garmin-period-review {scope}" if scope else CODEX_SKILL_PROMPT,
            "",
            "입력 폴더(운영 루트 기준 경로):",
            *inputs,
        ]
    )


def codex_argv(
    cfg: config.Config,
    schema: Path,
    output: Path,
    images: list[str],
    executable: str | None = None,
    *,
    inputs: list[str] | None = None,
    intake: bool = False,
    scope: str | None = None,
) -> list[str]:
    """`codex exec` argv(셸 없음). `-i`가 값을 여러 개 받으므로 프롬프트를 그 앞에 둔다."""
    argv = [
        codex_executable() if executable is None else executable,
        "exec",
        "-C",
        str(body.runtime_root(cfg)),
        "-s",
        "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "--json",
        "-c",
        "project_root_markers=[]",
        "-c",
        f"model_reasoning_effort={cfg.report_reasoning_effort}",
        "-m",
        str(cfg.report_model).strip(),
        "--output-schema",
        str(schema),
        "-o",
        str(output),
        codex_prompt(images if inputs is None else inputs, intake=intake, scope=scope),
    ]
    if images:
        argv += ["-i", *images]
    return argv


def _exit_on_signal(signum: int, frame: object) -> None:
    raise SystemExit(128 + signum)


def _trap_sigterm() -> tuple[bool, Any]:
    """codex를 기다리는 동안 SIGTERM을 `SystemExit`로 바꿔 `finally`(그룹 종료·임시 폴더 삭제)가 돌게 한다.

    (설치함, 이전 핸들러). 주 스레드가 아니어서 `signal.signal`이 거부하면 설치하지 않는다.
    """
    try:
        return True, signal.signal(signal.SIGTERM, _exit_on_signal)
    except ValueError:
        return False, None


def _codex_env() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if key not in _STRIPPED_ENV}


def _end_child(proc: subprocess.Popen[bytes]) -> None:
    """Reap the direct child; the supervisor owns cleanup of the shared group."""
    if proc.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        try:
            proc.wait(KILL_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
    proc.wait()


class ProcessCleanupError(store.StoreError):
    """Process ownership or termination could not be established."""


def _owned_process_group():
    pid = os.getpid()
    if os.getpgrp() != pid or os.getsid(0) != pid:
        raise ProcessCleanupError('report is not the supervised group leader')
    return pid


def _group_members(group):
    # ps runs in our group: exclude it and ourselves from its own snapshot.
    try:
        ps = subprocess.Popen(['ps', '-axo', 'pid=,pgid=,stat='], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, text=True)
        output, _ = ps.communicate(timeout=5)
        if ps.returncode != 0: raise ProcessCleanupError('cannot inspect supervised group')
        members = []
        for line in output.splitlines():
            fields = line.split()
            if len(fields) < 3: raise ProcessCleanupError('invalid process listing')
            pid, pgid = int(fields[0]), int(fields[1])
            if pgid == group and pid not in (os.getpid(), ps.pid) and not fields[2].startswith('Z'):
                members.append(pid)
        return members
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        if 'ps' in locals() and ps.poll() is None:
            ps.kill(); ps.wait()
        raise ProcessCleanupError('cannot inspect supervised group') from exc


def _cleanup_owned_group(group):
    if _owned_process_group() != group:
        raise ProcessCleanupError('supervised group changed')
    for sig in (signal.SIGTERM, signal.SIGKILL):
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while True:
            members = _group_members(group)
            if not members: return
            for pid in members:
                try:
                    if os.getpgid(pid) == group:
                        os.kill(pid, sig)
                except ProcessLookupError:
                    pass
                except OSError as exc:
                    raise ProcessCleanupError('cannot terminate supervised descendant') from exc
            if time.monotonic() >= deadline: break
            time.sleep(.05)
    if _group_members(group):
        raise ProcessCleanupError('supervised descendants still alive')


def _abi_progress() -> None:
    """Only ABI progress, never the model's JSON stream, reaches stdout."""
    print(json.dumps({'abi': 1, 'type': 'progress'}), flush=True)


def _schema_error(schema: dict[str, object], instance: object) -> str | None:
    """`instance`가 `schema`에 맞으면 `None`, 아니면 위치와 `validator` 키워드(값은 넣지 않는다)."""
    import jsonschema  # 검증할 때만 늦게 import

    validator = jsonschema.Draft202012Validator(schema)
    error = jsonschema.exceptions.best_match(validator.iter_errors(instance))
    if error is None:
        return None
    location = "".join(f"[{part!r}]" for part in error.absolute_path) or "(루트)"
    return f"{location}: {error.validator}"


def _read_output(output: Path, schema_path: Path) -> DailyAnalysis | dict:
    """`-o` 파일을 스키마로 검증해 `DailyAnalysis`. 맞지 않으면 `WriterFailed(output_invalid)`."""
    invalid = errors.ReportFailReason.OUTPUT_INVALID
    try:
        raw = output.read_bytes()
    except FileNotFoundError:
        raise WriterFailed(invalid, "출력 파일 없음") from None
    except OSError as error:
        raise WriterFailed(
            invalid, f"출력 파일을 읽지 못함: {type(error).__name__}"
        ) from None
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise WriterFailed(invalid, "출력이 JSON이 아님") from None
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    problem = _schema_error(schema, data)
    if problem is not None:
        raise WriterFailed(invalid, f"스키마 불일치 {problem}")
    if "detail" in data:
        return data
    if not data["report_md"].strip():
        raise WriterFailed(invalid, "report_md가 비어 있음")
    if not _utf8(data["report_md"]) or not _utf8(data["summary"]):
        raise WriterFailed(invalid, "summary이 UTF-8이 아님")
    return DailyAnalysis(
        data["status"],
        data["report_md"],
        data["summary"],
        data["judgments"],
        data["evidence"],
        data["next_checks"],
        message=data.get("message"),
    )


class CodexWriter:
    """`codex exec`로 skill `garmin-daily-analysis`를 실행해 하루 분석을 쓰는 작성기(FR34·AD-16).

    `executable`은 기본 `BRAIN_CODEX_PATH`(쓸 때 읽는다), `timeout_seconds`는 기본
    `report_codex_timeout_minutes * 60`이다.
    """

    def __init__(
        self, executable: str | None = None, timeout_seconds: float | None = None,
        progress: Callable[[], None] | None = None,
        body_handler: Callable[..., Any] | None = None,
    ) -> None:
        self.body_handler = body_handler
        self.executable = executable
        self.timeout_seconds = timeout_seconds
        self.progress = progress if progress is not None else (_abi_progress if os.environ.get("BRAIN_ABI_VERSION") == "1" else None)

    def write(self, cfg: config.Config, inputs: list[str]) -> DailyAnalysis:
        return self._execute(cfg, inputs, intake=False)

    def intake(self, cfg: config.Config, inputs: list[str]) -> dict:
        """Execute body intake before exporting raw report input."""
        return self._execute(cfg, inputs, intake=True)

    def period(
        self, cfg: config.Config, inputs: list[str], scope: str
    ) -> DailyAnalysis:
        """Execute the period review skill for a code-defined scope."""
        return self._execute(cfg, inputs, intake=False, scope=scope)

    def _execute(
        self,
        cfg: config.Config,
        inputs: list[str],
        *,
        intake: bool,
        scope: str | None = None,
    ):
        failed = errors.ReportFailReason.CODEX_FAILED
        if cfg.report_model is None or not cfg.report_model.strip():
            raise WriterFailed(failed, "report_model 미설정")
        timeout = (
            cfg.report_codex_timeout_minutes * 60
            if self.timeout_seconds is None
            else self.timeout_seconds
        )
        executable = codex_executable() if self.executable is None else self.executable
        images = codex_images(inputs) if intake else []
        try:
            cfg.data_dir.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
            workdir = Path(tempfile.mkdtemp(prefix=".codex-", dir=cfg.data_dir))
        except OSError as error:
            raise WriterFailed(
                failed, f"임시 폴더를 만들지 못함: {type(error).__name__}"
            ) from None
        try:
            resource = (
                importlib.resources.files("garmin_pipeline")
                / "schemas"
                / (
                    "body_intake_output.schema.json"
                    if intake
                    else "period_review_output.schema.json"
                    if scope
                    else REPORT_OUTPUT_SCHEMA
                )
            )
            with importlib.resources.as_file(resource) as schema_path:
                output = workdir / CODEX_OUTPUT_FILENAME
                argv = codex_argv(
                    cfg,
                    schema_path,
                    output,
                    images,
                    executable,
                    inputs=images if intake else inputs,
                    intake=intake,
                    scope=scope,
                )
                events = workdir / "events.jsonl"
                with events.open("wb") as stream:
                    self._run(cfg, argv, timeout, stdout=stream, progress=self.progress,
                              body_handler=self.body_handler if intake else None, workdir=workdir)
                result = _read_output(output, schema_path)
                if isinstance(result, DailyAnalysis):
                    result = replace(result, usage=_usage(events))
                return result
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    @staticmethod
    def _run(
        cfg: config.Config,
        argv: list[str],
        timeout: float,
        *,
        stdout=subprocess.DEVNULL,
        progress: Callable[[], None] | None = None,
        body_handler: Callable[..., Any] | None = None,
        workdir: Path | None = None,
    ) -> None:
        """Wait for Codex and serve its scoped body requests on the host."""
        group = _owned_process_group()
        ipc = None
        env = _codex_env()
        if body_handler is not None:
            if workdir is None: raise ProcessCleanupError("missing model scope")
            ipc = workdir / "body-ipc"
            ipc.mkdir(mode=0o700)
            env["BRAIN_BODY_IPC_DIR"] = str(ipc)
        else:
            env.pop("BRAIN_BODY_IPC_DIR", None)
        failed = errors.ReportFailReason.CODEX_FAILED
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                cwd=body.runtime_root(cfg),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=subprocess.DEVNULL,
                start_new_session=False,
            )
        except (OSError, ValueError) as error:
            logger.warning("codex를 실행하지 못했다: %s", type(error).__name__)
            raise WriterFailed(
                failed, f"실행하지 못함: {type(error).__name__}"
            ) from None
        returncode: int | None = None
        trapped, previous = _trap_sigterm()
        try:
            deadline = started + timeout
            next_progress = started + PROGRESS_INTERVAL_SECONDS
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if ipc is not None:
                    if proc.poll() is not None:
                        returncode = proc.returncode
                        break
                    import body_ipc
                    body_ipc.service(ipc, body_handler,
                                     active=lambda: proc.poll() is None and time.monotonic() < deadline)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                try:
                    returncode = proc.wait(min(remaining, .1 if ipc else PROGRESS_INTERVAL_SECONDS))
                    break
                except subprocess.TimeoutExpired:
                    now = time.monotonic()
                    if progress is not None and proc.poll() is None and now >= next_progress and now < deadline:
                        progress()
                        next_progress = now + PROGRESS_INTERVAL_SECONDS
        finally:
            try:
                _end_child(proc)
                _cleanup_owned_group(group)
            finally:
                if trapped:
                    signal.signal(signal.SIGTERM, signal.SIG_DFL if previous is None else previous)
        elapsed = time.monotonic() - started
        if returncode is None:
            logger.warning("codex 시간 초과: %.0f초 제한, %.1f초", timeout, elapsed)
            raise WriterFailed(
                errors.ReportFailReason.CODEX_TIMEOUT, f"{timeout:.0f}초 제한"
            )
        logger.info("codex 끝: exit=%d elapsed=%.1fs", returncode, elapsed)
        if returncode != 0:
            raise WriterFailed(failed, f"exit={returncode}")


def default_writer(cfg: config.Config) -> DailyWriter:
    """CLI가 쓰는 작성기: `CodexWriter()`."""
    return CodexWriter()


# --- 하루 분석 ----------------------------------------------------------------------------------


def _pending_inputs(cfg: config.Config) -> list[str]:
    try:
        return body.pending(cfg)
    except (body.BodyError, OSError) as error:
        logger.warning(
            "체성분 입력을 나열하지 못해 빈 목록으로 간다: %s", type(error).__name__
        )
        return []


def _one_line(text: str) -> str:
    return " ".join(text.split())[:SKILL_MESSAGE_MAX]


def _fallback(reason: errors.ReportFailReason, skill_message: str | None = None) -> str:
    """폴백 하루 분석 본문(끝 줄바꿈 없음)."""
    return f"{FALLBACK_MARKER}: {FALLBACK_TEXT[reason]} (`{reason.value}`)."


def _utf8(text: str) -> bool:
    """UTF-8로 인코딩되면 참(짝 없는 surrogate가 있으면 거짓)."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _daily_analysis(
    cfg: config.Config, writer: DailyWriter, inputs: list[str]
) -> tuple[str, errors.ReportFailReason | None, str | None]:
    """(하루 분석 본문, 작성기 실패 사유, summary). 실패면 본문은 폴백이다."""
    try:
        result = writer.write(cfg, inputs)
    except WriterFailed as error:
        reason = error.reason
        if reason not in FALLBACK_TEXT:
            logger.warning(
                "하루 분석 작성기가 작성기 사유가 아닌 %s를 알려 codex_failed로 본다",
                reason,
            )
            reason = errors.ReportFailReason.CODEX_FAILED
        logger.warning("하루 분석 작성기 실패: %s (%s)", reason, error.detail or "-")
        return _fallback(reason), reason, None
    except (store.StoreError, psycopg.Error):
        raise
    except Exception as error:  # noqa: BLE001 - 작성기의 예상 밖 실패도 폴백으로 바꾼다
        reason = errors.ReportFailReason.CODEX_FAILED
        logger.warning("하루 분석 작성기 예외: %s (%s)", reason, type(error).__name__)
        return _fallback(reason), reason, None
    status = getattr(result, "status", None)
    text = getattr(result, "report_md", None)
    summary = getattr(result, "summary", None)
    if (
        not isinstance(status, str)
        or status not in DAILY_STATUSES
        or not isinstance(text, str)
        or not text.strip()
        or not _utf8(text)
        or not isinstance(summary, str)
        or not _utf8(summary)
    ):
        reason = errors.ReportFailReason.OUTPUT_INVALID
        logger.warning("하루 분석 작성기 결과가 형식에 맞지 않는다: %s", reason)
        return _fallback(reason), reason, None
    if status == STATUS_FAILED:
        reason = errors.ReportFailReason.SKILL_FAILED
        logger.warning("하루 분석 skill이 실패를 알렸다: %s", reason)
        return _fallback(reason, _one_line(text)), reason, None
    logger.info("하루 분석 작성: status=%s", status)
    return text, None, summary


# --- 리포트 파일 ----------------------------------------------------------------------------


def report_path(cfg: config.Config, report_date: date) -> Path:
    """`<reports_dir>/<report_date>.md`."""
    return cfg.reports_dir / f"{report_date.isoformat()}.md"


def _today_evaluation(cfg, day, scope):
    try:
        conn = store.read_connection(cfg)
        try:
            row = store.latest_evaluation(conn, report_date=day.isoformat(), scope=scope)
            return None if row is None else (row[6], row[2])
        finally:
            conn.close()
    except (store.StoreError, psycopg.Error):
        return None


def _assemble(
    report_md: str,
    report_date: date,
    graphs: list[charts.Graph] | tuple[charts.Graph, ...] = (),
) -> bytes:
    block = "\n\n" + GRAPH_HEADING + "\n"
    existing = [graph for graph in graphs]
    if existing:
        block += (
            "\n"
            + "\n\n".join(
                f"![{graph.title}]({report_date.isoformat()}/{graph.name})"
                for graph in existing
            )
            + "\n"
        )
    return (report_md.rstrip() + block).encode("utf-8")


def _render_charts(cfg: config.Config, day: date) -> list[charts.Graph]:
    """임시 폴더에 그린 뒤 날짜 폴더를 통째로 교체한다. 실패면 기존 폴더를 복구한다."""
    temporary = None
    backup = None
    target = cfg.reports_dir / day.isoformat()
    installed = False
    try:
        cfg.reports_dir.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
        temporary = Path(
            tempfile.mkdtemp(prefix=f".{day.isoformat()}.charts-", dir=cfg.reports_dir)
        )
        names = charts.render(cfg, day, temporary)
        if target.exists():
            previous = temporary.with_name(
                temporary.name.replace(".charts-", ".charts-old-", 1)
            )
            target.rename(previous)
            backup = previous
        if names:
            temporary.rename(target)
            installed = True
        if backup is not None:
            try:
                shutil.rmtree(backup)
            except Exception as cleanup_error:  # noqa: BLE001 - 삭제 중인 이전 앨범은 복구하지 않는다
                logger.warning(
                    "report 그래프 정리 실패: error=%s",
                    type(cleanup_error).__name__,
                )
            backup = None
        return names
    except Exception as error:  # noqa: BLE001 - 그래프 실패는 report 결과를 바꾸지 않는다
        logger.warning("report 그래프 실패: error=%s", type(error).__name__)
        try:
            if backup is not None:
                if installed:
                    shutil.rmtree(target)
                backup.rename(target)
            elif installed:
                shutil.rmtree(target, ignore_errors=True)
        except Exception as restore_error:  # noqa: BLE001 - 복구 오류도 그래프 실패로 격리한다
            logger.warning(
                "report 그래프 복구 실패: error=%s", type(restore_error).__name__
            )
        return []
    finally:
        if temporary is not None and temporary.exists():
            try:
                shutil.rmtree(temporary)
            except Exception as cleanup_error:  # noqa: BLE001 - 정리 오류도 종료 코드를 바꾸지 않는다
                logger.warning(
                    "report 그래프 정리 실패: error=%s", type(cleanup_error).__name__
                )


def _write_report(cfg: config.Config, path: Path, content: bytes) -> None:
    """같은 폴더 임시 파일(0600) → fsync → `os.replace`. 실패하면 임시 파일을 지우고 `OSError`다."""
    cfg.reports_dir.mkdir(mode=_DIR_MODE, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with open(fd, "wb") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


# --- 알림·전달 ------------------------------------------------------------------------------


def _notify_failed(
    cfg: config.Config,
    day: date,
    reasons: list[errors.ReportFailReason],
    notice_sender: ports.NoticeSender | None = None,
    *,
    scopes: list[str] | None = None,
) -> None:
    """`report_failed`를 기록한다. 실패는 로그만 남긴다."""
    detail = " ".join(dict.fromkeys(reason.value for reason in reasons))
    if scopes:
        detail += " scopes=" + ",".join(scopes)
    try:
        with store.write_session(cfg) as conn:
            inserted = ports.TableNotifier(conn).notify(
                day, errors.NotifyEvent.REPORT_FAILED, detail
            )
    except Exception as error:  # noqa: BLE001 - 알림 기록 실패는 종료 코드를 바꾸지 않는다
        logger.warning(
            "report_failed 알림을 기록하지 못했다: %s (%s)",
            detail,
            type(error).__name__,
        )
        return
    logger.info("report_failed 기록: date=%s detail=%s", day.isoformat(), detail)
    if not inserted or notice_sender is None:
        return
    try:
        reason = notice_sender.send(
            day,
            errors.NotifyEvent.REPORT_FAILED,
            detail,
            timeout_seconds=ports.NOTIFY_TIMEOUT_SECONDS,
        )
    except Exception as error:  # noqa: BLE001 - 전송 실패는 사유만 남기고 명령을 계속한다
        logger.warning("notice delivery failed (%s)", type(error).__name__)
        reason = errors.DeliveryReason.NETWORK
    try:
        with store.write_session(cfg) as conn:
            ports.record_delivery(
                conn,
                day,
                errors.DeliveryKind.NOTIFY,
                reason is None,
                reason,
                errors.NotifyEvent.REPORT_FAILED,
            )
    except Exception as error:  # noqa: BLE001 - 전송 실패는 사유만 남기고 명령을 계속한다
        logger.warning("delivery 기록 실패 (%s)", type(error).__name__)


def delivery_recorder(
    cfg: config.Config,
) -> Callable[[date, errors.DeliveryKind, errors.DeliveryReason | None], None]:
    """결과 하나마다 짧은 쓰기 세션을 열고 닫는다."""

    def record(day, kind, reason):
        try:
            with store.write_session(cfg) as conn:
                ports.record_delivery(conn, day, kind, reason is None, reason)
        except Exception as error:  # noqa: BLE001 - 기록 실패는 전달을 막지 않는다
            logger.warning("delivery 기록 실패 (%s)", type(error).__name__)

    return record


SUMMARY_FALLBACK = "[Garmin] {report_date} 리포트 요약을 만들지 못했다 — 전문을 본다"


def _deliver(sink: ports.ReportSink | None, bundle: ports.ReportBundle) -> None:
    if sink is None:
        return
    try:
        sink.deliver(bundle)
    except Exception as error:  # noqa: BLE001 - 전달 실패는 리포트 파일과 종료 코드를 바꾸지 않는다
        logger.warning("리포트 전달 실패: %s", type(error).__name__)


# --- 실행 ------------------------------------------------------------------------------------


def run(
    cfg: config.Config,
    writer: DailyWriter,
    sink: ports.ReportSink | None = None,
    *,
    notice_sender: ports.NoticeSender | None = None,
    regenerate: bool = False,
    on_written: Callable[[Path], None] | None = None,
) -> int:
    """저장 자료 snapshot → intake → analysis → graphs → atomic write → delivery.

    `on_written`은 이번 실행의 파일 쓰기 성공 직후에만 부른다. 종료 코드는 그대로다.
    """
    with store.report_session(cfg, blocking=not regenerate):
        started_at = dates.now_ms()
        today = dates.today(cfg)
        path = report_path(cfg, today)
        existing_day = _today_evaluation(cfg, today, "day")
        preserved_success = existing_day is not None and path.is_file()
        if not regenerate and existing_day:
            logger.info("report 건너뜀: 오늘 성공 리포트가 이미 있다")
            return 0
        pending = _pending_inputs(cfg)
        if pending:
            try:
                intake = getattr(writer, "intake", None)
                if intake is None:
                    intake = CodexWriter().intake
                result = intake(cfg, pending)
                if result.get("status") != "ok":
                    logger.warning("체성분 입력 실행 실패")
            except Exception as error:  # noqa: BLE001 - inbox inputs remain for retry
                logger.warning("체성분 입력 실행 실패: %s", type(error).__name__)
        reasons: list[errors.ReportFailReason] = []
        failed_scopes = []
        session_usage = []
        exported = None
        session_started = time.monotonic()
        try:
            with store.write_session(cfg):
                pass
            exported = report_input.build(cfg, today, started_at=started_at)
            measurements = digest.build(
                exported.manifest,
                exported.days,
                exported.activities,
                exported.labels,
                exported.body,
            )
            report_input.write_json(exported.path / "digest.json", measurements)
            relative = os.path.relpath(exported.path, body.runtime_root(cfg))
            analysis, report_md, writer_failure, text = _evaluate(
                cfg, writer, [relative], "day", session_usage
            )
            if writer_failure is None:
                _save_evaluation(cfg, today, "day", analysis)
            collect_status = exported.manifest["collect"]["status"]
        except Exception as error:  # noqa: BLE001 - still write a useful failure report
            logger.warning("리포트 입력 준비 실패: %s", type(error).__name__)
            writer_failure = errors.ReportFailReason.CODEX_FAILED
            report_md, text, collect_status = _fallback(writer_failure), None, "unknown"
        if writer_failure is not None:
            reasons.append(writer_failure)
            failed_scopes.append("day")
            if _today_evaluation(cfg, today, "day"):
                _notify_failed(cfg, today, reasons, notice_sender, scopes=failed_scopes)
                logger.info(
                    "report total seconds=%.3f tokens=unknown",
                    time.monotonic() - session_started,
                )
                return 0
            report_md = (
                f"# {today} 하루 리포트\n\n수집 상태: {collect_status}\n\n{report_md}"
            )
            text = f"[Garmin] {today} 분석 실패: {FALLBACK_TEXT[writer_failure]} ({writer_failure.value})"
        period_summaries = []
        report_md += "\n\n## 기간 평가"
        for scope, label in (("7d", "7일"), ("30d", "30일"), ("all", "전체")):
            try:
                if exported is None:
                    raise WriterFailed(errors.ReportFailReason.CODEX_FAILED)
                folder = report_input.build_period(cfg, exported.path, today, scope)
                inputs = [
                    os.path.relpath(folder, body.runtime_root(cfg)),
                    os.path.relpath(
                        exported.path / "profile.md", body.runtime_root(cfg)
                    ),
                ]
                analysis, period_md, failure, period_summary = _evaluate(
                    cfg, writer, inputs, scope, session_usage
                )
                if failure is None:
                    _save_evaluation(cfg, today, scope, analysis)
            except Exception as error:  # noqa: BLE001 - a failed scope does not stop subsequent scopes
                failure = (
                    error.reason
                    if isinstance(error, WriterFailed)
                    else errors.ReportFailReason.CODEX_FAILED
                )
            if failure is not None:
                reasons.append(failure)
                failed_scopes.append(scope)
                previous = _today_evaluation(cfg, today, scope)
                if previous:
                    period_md, period_summary = previous
                else:
                    period_md = f"> 기간 평가를 쓰지 못했다: {FALLBACK_TEXT[failure]}"
                    period_summary = "평가를 쓰지 못했다"
            report_md += f"\n\n### {label}\n\n{period_md.rstrip()}"
            period_summaries.append(f"{label}: {' '.join(period_summary.split())}")
        text = report_message.saved_or_fallback(cfg, today, {
            'day': text or SUMMARY_FALLBACK.format(report_date=today),
            **{scope: value.split(': ', 1)[-1] for scope, value in zip(('7d', '30d', 'all'), period_summaries)},
        })
        totals = [u for u in session_usage if u is not None]
        if len(totals) == 4:
            logger.info(
                "report total seconds=%.3f input_tokens=%d cached_input_tokens=%d output_tokens=%d",
                time.monotonic() - session_started,
                sum(u["input_tokens"] for u in totals),
                sum(u["cached_input_tokens"] for u in totals),
                sum(u["output_tokens"] for u in totals),
            )
        else:
            logger.info(
                "report total seconds=%.3f tokens=unknown",
                time.monotonic() - session_started,
            )
        graphs = _render_charts(cfg, today)
        graphs = [
            g
            for g in graphs
            if (cfg.reports_dir / today.isoformat() / g.name).is_file()
        ]
        regenerated = regenerate and os.path.lexists(path)
        try:
            _write_report(cfg, path, _assemble(report_md, today, graphs))
        except OSError as error:
            reasons.append(errors.ReportFailReason.WRITE_FAILED)
            logger.warning("리포트를 쓰지 못했다: %s", type(error).__name__)
            _notify_failed(cfg, today, reasons, notice_sender, scopes=failed_scopes)
            return 0 if preserved_success else 1
        if on_written is not None:
            on_written(path)
        if reasons:
            _notify_failed(cfg, today, reasons, notice_sender, scopes=failed_scopes)
        albums = tuple(
            group
            for low, high in ((1, 49), (50, 99))
            if (
                group := tuple(
                    cfg.reports_dir / today.isoformat() / g.name
                    for g in graphs
                    if low <= int(g.name[:2]) <= high
                )
            )
        )
        _deliver(
            sink,
            ports.ReportBundle(
                today,
                text
                if text is not None
                else SUMMARY_FALLBACK.format(report_date=today),
                albums,
                path,
                regenerated,
            ),
        )
        return 0


def _usage(path):
    """Read only numeric usage from private JSONL; callers always delete the file."""
    usage = None
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict) or event.get("type") != "turn.completed":
                continue
            numbers = event.get("usage")
            fields = ("input_tokens", "cached_input_tokens", "output_tokens")
            if isinstance(numbers, dict) and all(
                type(numbers.get(k)) is int and numbers[k] >= 0 for k in fields
            ):
                if usage is None:
                    usage = dict.fromkeys(fields, 0)
                for key in fields:
                    usage[key] += numbers[key]
    return usage


def _evaluate(cfg, writer, inputs, scope, usages):
    started = time.monotonic()
    result = None
    try:

        def write(cfg, inputs):
            nonlocal result
            result = (
                writer.write(cfg, inputs)
                if scope == "day"
                else writer.period(cfg, inputs, scope)
            )
            return result

        report_md, failure, summary = _daily_analysis(
            cfg, SimpleNamespace(write=write), inputs
        )
        return result, report_md, failure, summary
    finally:
        usage = (
            getattr(result, "usage", None)
            if getattr(result, "status", None) == "ok"
            else None
        )
        usages.append(usage)
        if usage is None:
            logger.info(
                "report session scope=%s seconds=%.3f tokens=unknown",
                scope,
                time.monotonic() - started,
            )
        else:
            logger.info(
                "report session scope=%s seconds=%.3f input_tokens=%d cached_input_tokens=%d output_tokens=%d",
                scope,
                time.monotonic() - started,
                usage["input_tokens"],
                usage["cached_input_tokens"],
                usage["output_tokens"],
            )


def _save_evaluation(cfg, day, scope, analysis):
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            revision = store.append_evaluation(
                conn,
                report_date=day.isoformat(),
                scope=scope,
                summary=analysis.summary,
                judgments=json.dumps(analysis.judgments, ensure_ascii=False),
                evidence=json.dumps(analysis.evidence, ensure_ascii=False),
                next_checks=json.dumps(analysis.next_checks, ensure_ascii=False),
                report_md=analysis.report_md,
                model=cfg.report_model or "",
                created_at=dates.now_ms(),
                message=getattr(analysis, "message", None),
            )
            conn.execute('insert into garmin.report_work_revisions(work_id,user_id,connection_id,report_date,scope,revision) values (%s,%s,%s,%s,%s,%s)',
                         (os.environ['BRAIN_WORK_ID'], conn.user_id, conn.connection_id, day.isoformat(), scope, revision))


def _combined_summary(day, periods):
    """Drop whole period lines before truncating the day without splitting surrogates."""
    lines = [day, *periods]
    while len("\n".join(lines).encode("utf-16-le")) // 2 > 4000 and len(lines) > 1:
        lines.pop()
    if len(lines[0].encode("utf-16-le")) // 2 > 4000:
        lines[0] = (
            lines[0].encode("utf-16-le")[:8000].decode("utf-16-le", errors="ignore")
        )
    return "\n".join(lines)


class SupervisedReportFailed(Exception):
    """A supervised analysis scope or body intake did not complete."""


def _completed_scopes(cfg, day):
    """Read latest revisions without converting database failures into missing work."""
    conn = store.read_connection(cfg)
    try:
        return {scope for scope in ('day', '7d', '30d', 'all')
                if store.latest_evaluation(conn, report_date=day.isoformat(), scope=scope) is not None}
    finally:
        conn.close()


def _assert_attempt_current(cfg):
    """Fence before each model call so a revoked attempt does not continue."""
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            pass


def _work_revisions(cfg, today, regenerate):
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            recorded = dict(conn.execute('select scope,revision from garmin.report_work_revisions where work_id=%s and user_id=%s and connection_id=%s and report_date=%s',
                                         (os.environ['BRAIN_WORK_ID'], conn.user_id, conn.connection_id, today.isoformat())).fetchall())
            if not regenerate:
                for scope in ('day', '7d', '30d', 'all'):
                    if scope not in recorded:
                        row = store.latest_evaluation(conn, report_date=today.isoformat(), scope=scope)
                        if row is not None:
                            conn.execute('insert into garmin.report_work_revisions(work_id,user_id,connection_id,report_date,scope,revision) values (%s,%s,%s,%s,%s,%s)',
                                         (os.environ['BRAIN_WORK_ID'], conn.user_id, conn.connection_id, today.isoformat(), scope, row[9]))
                            recorded[scope] = row[9]
    return recorded


def _read_work_revisions(cfg, today):
    conn = store.read_connection(cfg)
    try:
        return dict(conn.execute('select scope,revision from garmin.report_work_revisions where work_id=%s and user_id=%s and connection_id=%s and report_date=%s',
                                 (os.environ['BRAIN_WORK_ID'], conn.user_id, conn.connection_id, today.isoformat())).fetchall())
    finally:
        conn.close()


def run_supervised(cfg, writer, *, regenerate=False, today=None):
    """Run only analysis, appending each success before starting the next scope.

    The caller owns the supervised_account binding and the report session lock.
    All read snapshots are closed by the input builders before model invocation.
    """
    today = dates.today(cfg) if today is None else today
    started_at = dates.now_ms()
    recorded = _work_revisions(cfg, today, regenerate)
    completed = set(recorded)
    remaining = [scope for scope in ('day', '7d', '30d', 'all') if scope not in completed]
    if not remaining:
        import report_publish
        document = report_publish.publish_and_wait(cfg, today, recorded)
        import report_channel
        report_channel.success(cfg, today, recorded, document)
        return {'status': 'noop', 'scopes': 0}
    failed = False
    try:
        pending = body.pending(cfg)
    except (store.StoreError, psycopg.Error):
        raise
    except (body.BodyError, OSError):
        pending = []
        failed = True
    if pending:
        _assert_attempt_current(cfg)
        try:
            intake_result = writer.intake(cfg, pending)
        except (store.StoreError, psycopg.Error):
            raise
        except Exception:
            failed = True
        else:
            if not isinstance(intake_result, dict) or intake_result.get('status') != 'ok':
                failed = True
            else:
                try:
                    unhandled = set(pending).intersection(body.pending(cfg))
                except (store.StoreError, psycopg.Error):
                    raise
                except (body.BodyError, OSError):
                    failed = True
                else:
                    # New arrivals belong to a later run; reject removes pending too.
                    if unhandled:
                        failed = True
    exported = report_input.build(cfg, today, started_at=started_at)
    measurements = digest.build(exported.manifest, exported.days, exported.activities,
                                exported.labels, exported.body)
    report_input.write_json(exported.path / 'digest.json', measurements)
    runtime = body.runtime_root(cfg)
    usages = []
    for scope in remaining:
        if scope == 'day':
            inputs = [os.path.relpath(exported.path, runtime)]
        else:
            try:
                folder = report_input.build_period(cfg, exported.path, today, scope)
            except (store.StoreError, psycopg.Error):
                raise
            except (OSError, UnicodeError, json.JSONDecodeError):
                failed = True
                continue
            inputs = [os.path.relpath(folder, runtime),
                      os.path.relpath(exported.path / 'profile.md', runtime)]
        _assert_attempt_current(cfg)
        analysis, _, failure, _ = _evaluate(cfg, writer, inputs, scope, usages)
        if failure is not None:
            failed = True
            continue
        _save_evaluation(cfg, today, scope, analysis)
    if failed:
        raise SupervisedReportFailed('analysis or body intake failed')
    recorded = _read_work_revisions(cfg, today)
    import report_publish
    document = report_publish.publish_and_wait(cfg, today, recorded)
    import report_channel
    report_channel.success(cfg, today, recorded, document)
    return {'status': 'success', 'scopes': len(remaining)}
