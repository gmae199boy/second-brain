"""`garmin-pipeline` 명령줄 진입점.

최상위 import는 stdlib과 공통 계층(`config`·`dates`·`errors`)만 쓴다.
하위 명령 모듈은 각 핸들러 안에서 import해 `--help`·인자 오류가 무거운 의존성을 읽지 않게 한다.

명령마다 `<data_dir>/logs/<명령>.log`(1 MB × 3 회전, 폴더 0700)를 `garmin_pipeline` 로거에 붙이고
끝나면 뗀다. 시각은 UTC ISO 8601이다. 라이브러리 로거(`_LIBRARY_LOGGERS`)는 명령 동안 전파를 끄고
수준을 CRITICAL보다 높여 기록 자체를 막는다(라이브러리 로그에 display name이 든 URL 경로·응답 본문·
예외 문자열이 있을 수 있다, AD-12·AD-20). 로거 설정은 이 모듈만 한다. 설정 오류는 stderr에 쓰고 2다.
`body`는 하위 명령 셋이다: `body pending`은 입력 경로를 한 줄에 하나씩, `body write`는 결과 JSON 한 줄,
`body reject`는 옮긴 경로 한 줄을 stdout에 쓴다. 거부되면 stdout 없이 stderr에 사유를 쓰고 1이다.
`sync`는 최근 7일 활동 목록을 포함해 강제 수집한 뒤 오늘 리포트를 다시 만들어 보낸다.
`report --regenerate`는 오늘을 다시 만들며 리포트 락이 바쁘면 stderr·WARNING과 1로 거부한다.
`report`는 락을 기다리고 오늘 완성본은 건너뛴다. stdout에 아무것도 쓰지 않는다(결과는 리포트 파일·`report.log`·종료 코드다).
"""

import argparse
import contextlib
import json
import logging
import logging.handlers
import os
import sys
import time
from collections.abc import Callable, Iterator
from datetime import date
from pathlib import Path
from typing import Any

from garmin_pipeline import config

LOGS_DIRNAME = "logs"
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3
_PACKAGE_LOGGER = "garmin_pipeline"
# 명령 동안 막는 라이브러리 로거. 하위 로거(`garminconnect.client` 등)는 수준을 상속한다.
_LIBRARY_LOGGERS = ("garminconnect", "curl_cffi", "urllib3", "requests", "matplotlib")
_LIBRARY_BLOCK_LEVEL = logging.CRITICAL + 1
_LOG_FORMAT = "%(asctime)s.%(msecs)03dZ %(levelname)s %(name)s %(message)s"
_LOG_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="garmin-pipeline",
        description="Garmin 건강 데이터를 매일 무인으로 수집해 일일 리포트를 만드는 개인용 파이프라인.",
    )
    commands = parser.add_subparsers(dest="command", metavar="<명령>", required=True)
    login = commands.add_parser(
        "login",
        help="Garmin에 대화형으로 로그인해 tokenstore에 토큰을 만든다",
        description=(
            "이메일·비밀번호(화면에 보이지 않음)·MFA 코드를 물어 Garmin에 로그인하고, "
            "tokenstore에 토큰(garmin_tokens.json)을 저장한 뒤 로그인 기록을 남긴다."
        ),
    )
    _add_config_option(login)
    login.set_defaults(handler=_login)
    smoke = commands.add_parser(
        "smoke",
        help="저장된 토큰으로 Garmin 무인 인증과 데이터 호출을 한 번 점검한다",
        description=(
            "프롬프트 없이 tokenstore의 토큰으로 Garmin 세션을 열고 어제 user_summary를 한 번 "
            "불러 단계별 결과를 출력한다. 실패하면 사유와 다음 행동을 안내한다."
        ),
    )
    _add_config_option(smoke)
    smoke.set_defaults(handler=_smoke)
    collect = commands.add_parser(
        "collect",
        help="저장된 커버리지로 계획을 세워 웰니스 일일 데이터를 수집한다",
        description=(
            "저장된 데이터에서 빠졌거나 확정되지 않은 날을 최신순으로 골라(최대 max_dates_per_run개) "
            "웰니스 일일 응답과 활동 상세 원문을 받아 저장하고, 실행 결과를 run에 남긴다. 같은 날 "
            "다시 뜨면 그날 실행 결과로 정한다: 실패한 날은 다시, transient 실패가 있으면 그 항목을 "
            "다시 받고, 성공·rejected만 남은 날·재로그인 없는 auth_failed 날은 아무것도 하지 않는다. "
            "수집 판정이 끝나면 같은 쓰기 락 안에서 normalize와 같은 정규화를 하고, 이번 정규화에 "
            "실패 항목이 있으면 normalize_failed를 알린다."
        ),
    )
    _add_config_option(collect)
    collect.add_argument(
        "--force",
        action="store_true",
        help="당일 차단(block.json)만 지키고 그날 실행 결과와 상관없이 전체 계획으로 수집한다",
    )
    collect.set_defaults(handler=_collect)
    sync = commands.add_parser(
        "sync",
        help="최근 7일 활동 목록을 다시 수집하고 오늘 리포트를 다시 만들어 보낸다",
        description=(
            "강제 수집을 마치고 쓰기 락을 푼 뒤 report --regenerate를 실행한다. "
            "최근 7일 활동 목록은 날짜 상한 안에서 다시 받으며 오늘 rejected 항목은 뺀다. "
            "당일 차단 중에는 저장 데이터로만 리포트를 다시 만든다. "
            "Codex 세션 넷에 약 10분이 걸리며 리포트 락이 바쁘면 거부한다. "
            "로그는 <data_dir>/logs/sync.log다."
        ),
    )
    _add_config_option(sync)
    sync.set_defaults(handler=_sync)
    install_schedule = commands.add_parser(
        "install-schedule",
        help=(
            "운영 루트의 collect·report 예약(launchd LaunchAgent 두 개)을 설치하거나 같은 내용으로 "
            "교체한다"
        ),
        description=(
            "config의 collect_time·retry_time에 collect를 부르는 plist와 report_time에 report를 "
            "부르는 plist를 ~/Library/LaunchAgents에 쓰고 launchctl로 로드한다. 운영 루트는 config "
            "파일이 있는 폴더이고 그 아래 .venv의 스냅샷 실행 파일을 예약한다. launchd는 셸 프로필을 "
            "읽지 않으므로 report plist의 PATH에는 설치할 때 PATH에서 찾은 codex의 폴더를 넣는다. "
            "pytest 안, 운영(runtime) 설정이 아님, 시각 순서가 collect_time < retry_time < "
            "report_time이 아님, 시스템 시간대가 config timezone과 다르거나 알 수 없음, 스냅샷 실행 "
            "파일 없음, codex를 PATH에서 찾지 못함이면 사유를 모두 출력하고 1로 끝난다. 보통은 "
            "scripts/deploy.sh가 부른다."
        ),
    )
    _add_config_option(install_schedule)
    install_schedule.set_defaults(handler=_install_schedule)
    capture_fixtures = commands.add_parser(
        "capture-fixtures",
        help="운영 DB에 보존된 Garmin 원문을 tests/fixtures/garmin/에 테스트 fixture로 내보낸다",
        description=(
            "DB를 읽기만 해 raw_response 원문을 현재 폴더 기준 "
            "tests/fixtures/garmin/<endpoint>/<key>.json에 그대로 쓰고 endpoint별 개수만 "
            "출력한다. 옵션이 없으면 endpoint마다 최신 원문 하나와 상세가 있는 최근 활동 3개를, "
            "--date·--activity-id가 있으면 지정한 날짜·활동의 원문만(null 포함) 쓴다. 출력 "
            "폴더가 git에서 무시되지 않으면(저장소 루트가 아니면) 아무것도 쓰지 않고 1로 끝난다."
        ),
    )
    _add_config_option(capture_fixtures)
    capture_fixtures.add_argument(
        "--date",
        dest="dates",
        action="append",
        type=_iso_date,
        metavar="YYYY-MM-DD",
        help="이 날짜의 day-scope 원문 11종을 쓴다(여러 번 줄 수 있다)",
    )
    capture_fixtures.add_argument(
        "--activity-id",
        dest="activity_ids",
        action="append",
        type=_positive_int,
        metavar="N",
        help="이 activityId의 저장된 activity-scope 원문을 쓴다(여러 번 줄 수 있다)",
    )
    capture_fixtures.set_defaults(handler=_capture_fixtures)
    normalize = commands.add_parser(
        "normalize",
        help=(
            "보존된 원문 중 바뀌었거나 아직 정규화하지 않은 것을 일일 요약 지표와 활동으로 정규화한다"
            "(--rebuild나 정규화 버전 변경이면 전부 다시 만든다)"
        ),
        description=(
            "쓰기 락을 잡고 raw_response 원문 중 정규화 결과가 없거나 결과 이후 바뀐 것(day-scope "
            "user_summary·rhr_day·hrv_data·training_readiness·sleep_data·stress_data·body_battery·"
            "heart_rates·daily_weigh_ins·lifestyle_logging_data, activity-scope activity·activity_hr_in_timezones·activity_details·"
            "activity_exercise_sets)을 "
            "항목 하나씩 트랜잭션 하나로 daily_metric(body_battery는 샘플을 body_battery_sample에도, "
            "heart_rates는 샘플만 hr_sample에)과 activity(activity_details는 샘플만 "
            "activity_hr_sample(심박·운동 중 Body Battery)에, activity_exercise_sets는 세트만 "
            "exercise_set에)에 "
            "정규화하고, 항목별 결과를 normalize_result에 남긴다. 형식이 바뀐 원문 하나가 실패해도 "
            "나머지는 계속 처리한다. --rebuild이거나 meta.normalize_version이 코드의 정규화 버전과 "
            "다르면(없음 포함) 트랜잭션 하나에서 파생 테이블과 normalize_result를 비우고 원문 전부를 "
            "다시 정규화한 뒤 버전을 기록한다(실패하면 모두 이전 그대로다). 정규화 버전은 같은 "
            "원문에서 나오는 파생 값이나 모양이 바뀌는 코드 변경마다 1 올린다. 처리 수와 실패 수를 "
            "한 줄로 출력하고, 항목 실패가 있어도 0으로 끝난다. 락·DB 오류면 1이다."
        ),
    )
    _add_config_option(normalize)
    normalize.add_argument(
        "--rebuild",
        action="store_true",
        help=(
            "정규화 버전과 상관없이 파생 테이블을 모두 비우고 보존된 원문 전부로 다시 만든다"
            "(트랜잭션 하나라 실패하면 이전 그대로다)"
        ),
    )
    normalize.set_defaults(handler=_normalize)
    report = commands.add_parser(
        "report",
        help=(
            "수집을 기다린 뒤 AI 분석과 그래프로 오늘의 리포트 reports/<날짜>.md를 "
            "조립한다(완성본 건너뛰기, --regenerate로 다시 만들기)"
        ),
        description=(
            "리포트 락을 기다리고 오늘 하루 분석이 있으면 건너뛴다. --regenerate는 오늘만 다시 만들며 "
            "락이 바쁘면 기다리지 않고 종료 1로 거부한다. 오늘 수집이 끝나기를 최대 report_wait_minutes 동안 기다리고(당일 차단·중단된 실행이면 "
            "기다리지 않는다), 하루·7일·30일·전체 분석을 작성하고 DB 그래프를 붙여 <reports_dir>/<report_date>.md에 원자적으로 쓴다. 작성기가 실패하면 "
            "하루 분석 자리에 실패 사유를 적고 report_failed를 기록한다(같은 날 하루 분석이 있는 리포트는 "
            "덮어쓰지 않는다). stdout에는 아무것도 쓰지 않고 로그는 <data_dir>/logs/report.log다. "
            "리포트를 썼거나 같은 날 리포트를 남겼으면 0, 파일 쓰기 실패면 1, 설정 오류면 2다."
        ),
    )
    _add_config_option(report)
    report.add_argument(
        "--regenerate",
        action="store_true",
        help="오늘 리포트를 다시 만든다(락 대기 없음)",
    )
    report.set_defaults(handler=_report)
    body = commands.add_parser(
        "body",
        help="체성분 입력(inbox/inbody/)을 검증해 측정일별 장부(data/body/<날짜>.json)로 관리한다",
        description=(
            "체성분 입력 폴더(<inbox_dir>/inbody/)와 측정일별 장부(<data_dir>/body/YYYY-MM-DD.json)를 "
            "다룬다. 경로는 모두 운영 루트(config 파일이 있는 폴더) 기준 상대 POSIX 경로다. 네트워크를 "
            "쓰지 않고 운영 루트 밖에 쓰지 않는다. 거부되면 stderr에 사유를 쓰고 1, 설정 오류면 2다."
        ),
    )
    body_commands = body.add_subparsers(
        dest="body_command", metavar="<하위 명령>", required=True
    )
    body_pending = body_commands.add_parser(
        "pending",
        help="입력 폴더 바로 아래의 처리할 파일을 이름 순으로 한 줄에 하나씩 출력한다",
        description=(
            "<inbox_dir>/inbody/ 바로 아래의 일반 파일만(하위 폴더·심볼릭 링크·.으로 시작하는 파일 제외) "
            "이름 순으로 운영 루트 기준 상대 경로를 한 줄에 하나씩 출력한다. 입력 폴더가 없으면 아무것도 "
            "출력하지 않고 0이다. 읽기만 한다."
        ),
    )
    _add_config_option(body_pending)
    body_pending.set_defaults(handler=_body_pending)
    body_write = body_commands.add_parser(
        "write",
        help="stdin의 측정 JSON을 검증해 측정일 장부에 병합해 쓰고 입력을 processed/로 옮긴다",
        description=(
            "stdin의 JSON 객체를 schemas/body.schema.json의 $defs/measurement로 검증하고, 같은 측정일 "
            "장부와 키 단위로 병합해(입력 mtime이 나중인 값이 이긴다) 원자적으로 쓴 뒤 --source 파일을 "
            "inbox/inbody/processed/로 옮긴다(이름이 겹치면 -2, -3…). 성공하면 "
            '{"measured_on", "body_path", "processed"} JSON 한 줄을 출력하고 0이다. 측정일이 오늘보다 '
            "뒤이거나, 경로·입력·기존 장부가 잘못되면 아무것도 쓰거나 옮기지 않고 1이다."
        ),
    )
    _add_config_option(body_write)
    body_write.add_argument(
        "measured_on", type=_iso_date, metavar="YYYY-MM-DD", help="측정일"
    )
    body_write.add_argument(
        "--source",
        dest="sources",
        action="append",
        required=True,
        metavar="PATH",
        help=(
            "이 측정을 읽은 입력 파일(운영 루트 기준 상대 경로, inbox/inbody/ 바로 아래). "
            "여러 번 줄 수 있다"
        ),
    )
    body_write.set_defaults(handler=_body_write)
    body_reject = body_commands.add_parser(
        "reject",
        help="읽을 수 없는 입력을 unreadable/로 옮긴다",
        description=(
            "입력 파일(운영 루트 기준 상대 경로, inbox/inbody/ 바로 아래)을 inbox/inbody/unreadable/로 "
            "옮기고(이름이 겹치면 -2, -3…) 옮긴 상대 경로 한 줄을 출력한다."
        ),
    )
    _add_config_option(body_reject)
    body_reject.add_argument(
        "file", metavar="PATH", help="옮길 입력 파일(운영 루트 기준 상대 경로)"
    )
    body_reject.set_defaults(handler=_body_reject)
    args = parser.parse_args(argv)
    return args.handler(args)


def _add_config_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--config",
        metavar="PATH",
        help=f"설정 파일 경로(기본: ${config.CONFIG_ENV} 또는 ./{config.CONFIG_FILENAME})",
    )


def _iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"날짜(YYYY-MM-DD)가 아니다: {value!r}"
        ) from None


def _positive_int(value: str) -> int:
    if value.isascii() and value.isdecimal() and int(value) > 0:
        return int(value)
    raise argparse.ArgumentTypeError(f"양의 정수가 아니다: {value!r}")


def _load_config(args: argparse.Namespace) -> config.Config | None:
    try:
        return config.load(args.config)
    except config.ConfigError as error:
        print(f"설정 오류: {error}", file=sys.stderr)
        return None


def _login(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import auth  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "login"))
        except OSError as error:
            print(f"login 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        return auth.login(cfg)


def _smoke(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import auth  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "smoke"))
        except OSError as error:
            print(f"smoke 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        return auth.smoke(cfg)


def _telegram_enabled(cfg: config.Config) -> bool:
    return (
        cfg.environment == "runtime"
        and os.path.lexists(cfg.tokenstore / "telegram.json")
        and not config.under_pytest()
    )


def _notice_sender(cfg: config.Config):
    from garmin_pipeline import ports

    return (
        ports.TelegramNoticeSender(cfg.tokenstore) if _telegram_enabled(cfg) else None
    )


def _report_sink(cfg: config.Config):
    from garmin_pipeline import ports, report

    return (
        ports.TelegramReportSink(cfg.tokenstore, record=report.delivery_recorder(cfg))
        if _telegram_enabled(cfg)
        else None
    )


def _notifier_factory(cfg: config.Config):
    from garmin_pipeline import ports

    sender = _notice_sender(cfg)
    if sender is None:
        return ports.TableNotifier
    return lambda conn: ports.TelegramNotifier(
        conn, sender, budget_seconds=cfg.lock_wait_seconds / 2
    )


def _collect(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import collect  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "collect"))
        except OSError as error:
            print(f"collect 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        return collect.collect(
            cfg,
            force=args.force,
            manual=args.force,
            notifier_factory=_notifier_factory(cfg),
        )


def _sync(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import collect, report, store

    logger = logging.getLogger("garmin_pipeline.cli")
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "sync"))
        except OSError as error:
            print(f"sync 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        collect_code = 1
        try:
            collect_code = collect.collect(
                cfg,
                force=True,
                manual=True,
                recent_lists=True,
                notifier_factory=_notifier_factory(cfg),
            )
        except Exception as error:  # noqa: BLE001 - 수집 실패 뒤에도 저장 데이터로 보고한다
            logger.warning("sync 수집 실패: %s", type(error).__name__)
        if collect_code != 0:
            logger.warning("sync 수집 종료: code=%d", collect_code)
        written: list[Path] = []
        try:
            report_code = report.run(
                cfg,
                report.default_writer(cfg),
                _report_sink(cfg),
                notice_sender=_notice_sender(cfg),
                regenerate=True,
                on_written=written.append,
            )
        except store.ReportLockBusy:
            message = "sync 리포트 거부: 다른 report가 실행 중이다"
            print(message, file=sys.stderr)
            logger.warning(message)
            return 1
        except Exception as error:  # noqa: BLE001 - 오류 이름만 로그에 남긴다
            logger.warning("sync 리포트 실패: %s", type(error).__name__)
            return 1
        return 0 if collect_code == 0 and report_code == 0 and written else 1


def _install_schedule(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import schedule  # 핸들러 안에서 늦게 import

    # 거부되면 로그 폴더도 만들지 않는다. 로그는 거부 검사를 통과한 뒤에만 붙인다.
    if not schedule.check(cfg):
        return 1
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "install-schedule"))
        except OSError as error:
            print(
                f"install-schedule 실패: 로그 파일을 열지 못했다: {error}",
                file=sys.stderr,
            )
            return 1
        return schedule.install(cfg)


def _capture_fixtures(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    import sqlite3

    from garmin_pipeline import capture, store  # 핸들러 안에서 늦게 import

    # 거부되면 로그 폴더·출력 폴더·DB 연결을 만들지 않는다. 로그는 git 확인을 통과한 뒤에만 붙인다.
    out_dir = Path.cwd() / capture.OUTPUT_DIR
    refusal = capture.ignored_by_git(out_dir)
    if refusal is not None:
        print(f"capture-fixtures 거부: {refusal}", file=sys.stderr)
        return 1
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "capture-fixtures"))
        except OSError as error:
            print(
                f"capture-fixtures 실패: 로그 파일을 열지 못했다: {error}",
                file=sys.stderr,
            )
            return 1
        try:
            counts = capture.export(
                cfg,
                out_dir,
                days=args.dates or [],
                activity_ids=args.activity_ids or [],
            )
        except (store.StoreError, sqlite3.Error) as error:
            print(f"capture-fixtures 실패: {error}", file=sys.stderr)
            return 1
        except OSError as error:
            print(
                f"capture-fixtures 실패: fixture 파일을 쓰지 못했다: {error}",
                file=sys.stderr,
            )
            return 1
    for endpoint, count in counts.items():
        print(f"{endpoint}: {count}")
    if not any(counts.values()):
        print("capture-fixtures: 내보낼 원문이 없다", file=sys.stderr)
        return 1
    return 0


def _normalize(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    import sqlite3

    from garmin_pipeline import normalize, store  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "normalize"))
        except OSError as error:
            print(f"normalize 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        try:
            with store.write_session(cfg) as conn:
                summary = normalize.run(
                    conn, rebuild=args.rebuild, timezone=cfg.timezone
                )
        except (store.StoreError, sqlite3.Error, OSError) as error:
            print(f"normalize 실패: {error}", file=sys.stderr)
            return 1
    print(f"normalize: processed={summary.processed} failed={summary.failed}")
    return 0


def _report(args: argparse.Namespace) -> int:
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import report, store  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "report"))
        except OSError as error:
            print(f"report 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr)
            return 1
        try:
            return report.run(
                cfg,
                report.default_writer(cfg),
                _report_sink(cfg),
                notice_sender=_notice_sender(cfg),
                regenerate=args.regenerate,
            )
        except store.ReportLockBusy:
            message = (
                "report 거부: 다른 report가 실행 중이다(--regenerate는 기다리지 않는다)"
            )
            print(message, file=sys.stderr)
            logging.getLogger("garmin_pipeline.report").warning(message)
            return 1


def _body_pending(args: argparse.Namespace) -> int:
    def run(body: Any, cfg: config.Config) -> None:
        for line in body.pending(cfg):
            print(line)

    return _run_body(args, "pending", run)


def _body_write(args: argparse.Namespace) -> int:
    def run(body: Any, cfg: config.Config) -> None:
        # launchd처럼 로캘이 없으면 Python UTF-8 모드가 stdin을 surrogateescape로 읽어 잘못된 바이트가
        # 통과한다. 바이트로 읽어 엄격한 UTF-8로 디코드한다.
        try:
            stdin_text = sys.stdin.buffer.read().decode("utf-8")
        except UnicodeDecodeError:
            raise body.BodyError("stdin이 UTF-8 텍스트가 아니다", "input") from None
        result = body.write(cfg, args.measured_on, args.sources, stdin_text)
        line = {
            "measured_on": result.measured_on,
            "body_path": result.body_path,
            "processed": result.processed,
        }
        print(json.dumps(line, ensure_ascii=False))

    return _run_body(args, "write", run)


def _body_reject(args: argparse.Namespace) -> int:
    def run(body: Any, cfg: config.Config) -> None:
        print(body.reject(cfg, args.file))

    return _run_body(args, "reject", run)


def _run_body(
    args: argparse.Namespace, name: str, run: Callable[[Any, config.Config], None]
) -> int:
    """`body` 하위 명령 공통: 설정·로그를 준비하고 `run`을 부른다. 거부·파일 오류는 stderr와 1이다."""
    cfg = _load_config(args)
    if cfg is None:
        return 2
    from garmin_pipeline import body  # 핸들러 안에서 늦게 import

    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(_command_log(cfg, "body"))
        except OSError as error:
            print(
                f"body {name} 실패: 로그 파일을 열지 못했다: {error}", file=sys.stderr
            )
            return 1
        try:
            run(body, cfg)
        except body.BodyError as error:
            print(f"body {name} 거부: {error}", file=sys.stderr)
            return 1
        except OSError as error:
            logging.getLogger(_PACKAGE_LOGGER).warning(
                "body %s 실패: %s: %s", name, type(error).__name__, error
            )
            print(f"body {name} 실패: {error}", file=sys.stderr)
            return 1
    return 0


@contextlib.contextmanager
def _stderr_log() -> Iterator[None]:
    """명령 동안 `garmin_pipeline` 로거에 stderr 처리기(INFO)를 붙이고, 나갈 때 떼고 수준을 되돌린다."""
    handler = logging.StreamHandler(sys.stderr)
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FORMAT)
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    handler.setLevel(logging.INFO)
    package_logger = logging.getLogger(_PACKAGE_LOGGER)
    saved_level = package_logger.level
    package_logger.addHandler(handler)
    if package_logger.getEffectiveLevel() > logging.INFO:
        package_logger.setLevel(logging.INFO)
    try:
        yield
    finally:
        package_logger.setLevel(saved_level)
        package_logger.removeHandler(handler)
        handler.close()


@contextlib.contextmanager
def _block_library_logs() -> Iterator[None]:
    """명령 동안 `_LIBRARY_LOGGERS`의 각 로거를 막고, 나갈 때(예외 포함) 진입 전 전파·수준으로 되돌린다.

    기록을 막는 것은 수준이다. `CRITICAL + 1`이면 `isEnabledFor`가 거짓이라 `LogRecord`가 만들어지지 않아
    어떤 처리기에도, `lastResort`(stderr)에도 가지 않는다. 하위 로거(`garminconnect.client` 등)는 수준을
    상속한다. 전파를 끄는 것은 기록이 루트 처리기에 닿지 않게 하는 것뿐이다. 하위 로거가 자기 수준을 따로
    두면 이 차단을 비켜 가고, 부모에 처리기가 없으니 그 기록은 `lastResort`로 간다(지금 다섯 라이브러리 중
    그렇게 하는 것은 없다). 루트 로거·`lastResort`는 건드리지 않고, `logging.disable`도 쓰지 않는다(패키지
    로그까지 막는다). 겹쳐 들어가도 각 단계가 자기가 저장한 값을 되돌린다.
    """
    saved: list[tuple[logging.Logger, bool, int]] = []
    for name in _LIBRARY_LOGGERS:
        library_logger = logging.getLogger(name)
        saved.append((library_logger, library_logger.propagate, library_logger.level))
        library_logger.propagate = False
        library_logger.setLevel(_LIBRARY_BLOCK_LEVEL)
    try:
        yield
    finally:
        for library_logger, propagate, level in reversed(saved):
            library_logger.propagate = propagate
            library_logger.setLevel(level)


@contextlib.contextmanager
def _command_log(cfg: config.Config, command: str) -> Iterator[None]:
    """`<data_dir>/logs/<command>.log` 처리기를 `garmin_pipeline` 로거에 붙이고, 나갈 때 떼고 닫는다.

    같은 동안 라이브러리 로거를 `_block_library_logs`로 막는다.
    """
    logs_dir = cfg.data_dir / LOGS_DIRNAME
    # 건강 데이터 폴더라 새로 만드는 data_dir과 logs는 0700이다(이미 있는 data_dir은 그대로).
    cfg.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    logs_dir.mkdir(mode=0o700, exist_ok=True)
    os.chmod(logs_dir, 0o700)
    handler = logging.handlers.RotatingFileHandler(
        logs_dir / f"{command}.log",
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FORMAT)
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    handler.setLevel(logging.INFO)

    package_logger = logging.getLogger(_PACKAGE_LOGGER)
    saved_level = package_logger.level
    package_logger.addHandler(handler)
    if package_logger.getEffectiveLevel() > logging.INFO:
        package_logger.setLevel(logging.INFO)
    try:
        with _block_library_logs():
            yield
    finally:
        package_logger.setLevel(saved_level)
        package_logger.removeHandler(handler)
        handler.close()
