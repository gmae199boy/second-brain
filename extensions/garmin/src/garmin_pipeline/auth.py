"""최초 로그인(`garmin-pipeline login`)과 연결 점검(`garmin-pipeline smoke`)(FR1~4).

`login`: tokenstore 준비, 터미널 프롬프트, `auth_event` 기록.

- 순서: tokenstore와 없는 부모를 0700으로 만들고(이미 있는 tokenstore는 `chmod 0700`) →
  `garmin.interactive_login`(차단 확인 → 이메일·비밀번호 → 로그인 → MFA 코드 → 토큰 저장) →
  `store.write_session` 안에서 `auth_event` 한 행 INSERT.
- 기록까지 마치면 0, 그 밖(차단·인증 실패·일시 오류·락 시간 초과·깨진 차단 파일·빈 입력·취소·
  쓰기 실패)은 사유 한 줄을 stderr에 쓰고 1이다.
- 비밀번호는 `getpass`로만 받는다. 인자·환경변수·설정·파일에서 읽지 않고, 이메일·비밀번호·MFA
  코드를 출력·로그·파일에 남기지 않는다(NFR1, AD-12).

`smoke`: 저장된 토큰만으로 무인 인증과 데이터 호출이 되는지 한 번 확인한다(AD-6, A4).

- `GarminPort.open_session()`으로 프롬프트 없이 세션을 열고(로그인 = 프로필 헬스체크), 어제
  날짜 `user_summary`를 한 번 부른다. 재시도·자동 재로그인·프롬프트가 없다.
- stdout에 `cffi_api_session`·`garminconnect` 버전과 단계별 결과 줄을 쓴다. 성공·`데이터 없음`은
  0, 실패는 사유와 다음 행동 한 줄을 stderr에 쓰고 1이다. DB는 열지 않고, tokenstore 폴더는
  만들거나 권한을 바꾸지 않는다(세션 락 파일, 라이브러리의 토큰 갱신 저장은 있을 수 있다).
  로그인 429·403, 데이터 429(·연속 403)이면 어댑터가 `block.json`을 쓴다.
- 응답 본문·이메일·토큰은 출력·로그에 쓰지 않는다. 로그에는 단계·오류 이름·사유·
  `cffi_api_session` 값만 남기고 날짜도 남기지 않는다.

stdlib과 `config`·`dates`·`errors`·`garmin`·`store`만 import한다.
"""

import errno
import getpass
import logging
import os
import psycopg
import sys
from datetime import timedelta
from pathlib import Path

from garmin_pipeline import config, dates, errors, garmin, store

logger = logging.getLogger(__name__)

_DIR_MODE = 0o700


class _EmptyInput(Exception):
    """프롬프트 입력이 비어 있다. `.field`는 무엇이 비었는지(사람이 읽는 이름)다."""

    def __init__(self, field: str) -> None:
        super().__init__(field)
        self.field = field


class _NotInteractive(Exception):
    """표준 입력이 터미널이 아니다. 비밀번호를 파일·파이프로 받지 않으려고 묻기 전에 거부한다."""


def _require_tty() -> None:
    # stdin이 터미널이 아니면 `getpass`가 stdin에서 비밀번호를 읽으므로(FR1 위반) 거부한다.
    if not sys.stdin.isatty():
        raise _NotInteractive


class TerminalPrompts:
    """기본 프롬프트. 이메일·MFA 코드는 `input`, 비밀번호는 `getpass.getpass`로 받는다.

    표준 입력이 터미널이 아니면 묻지 않고 `_NotInteractive`다. 부를 때마다 `sys.stdin`·`input`·
    `getpass.getpass`를 찾으므로 테스트가 바꿀 수 있다.
    """

    def credentials(self) -> tuple[str, str]:
        _require_tty()
        email = input("Garmin 이메일: ")
        password = getpass.getpass("Garmin 비밀번호: ")
        return email, password

    def mfa_code(self) -> str:
        _require_tty()
        return input("Garmin MFA 코드: ")


class _CheckedPrompts:
    """프롬프트 결과를 검사한다. 이메일·MFA 코드는 앞뒤 공백을 떼고, 빈 입력은 `_EmptyInput`이다."""

    def __init__(self, prompts: garmin.LoginPrompts) -> None:
        self._prompts = prompts

    def credentials(self) -> tuple[str, str]:
        email, password = self._prompts.credentials()
        email = email.strip()
        if not email:
            raise _EmptyInput("이메일")
        if not password:
            raise _EmptyInput("비밀번호")
        return email, password

    def mfa_code(self) -> str:
        code = self._prompts.mfa_code().strip()
        if not code:
            raise _EmptyInput("MFA 코드")
        return code


def login(cfg: config.Config, prompts: garmin.LoginPrompts | None = None) -> int:
    """대화형으로 로그인해 토큰을 저장하고 `auth_event`를 기록한다. 종료 코드(0·1)를 돌려준다.

    `prompts`가 없으면 `TerminalPrompts()`다.
    """
    checked = _CheckedPrompts(prompts if prompts is not None else TerminalPrompts())
    try:
        _prepare_tokenstore(cfg.tokenstore)
        garmin.interactive_login(cfg, checked)
    except (KeyboardInterrupt, EOFError) as error:
        return _fail("login", "login", error, "취소했다.")
    except Exception as error:
        message = _login_failure_message(cfg, error)
        if message is None:
            _log_unexpected("login", "login", error)
            raise
        return _fail("login", "login", error, message)
    # 로그인한 시각이다. 쓰기 락을 기다린 시간이 끼지 않게 락 전에 잡는다.
    local_date, logged_in_at = dates.today(cfg).isoformat(), dates.now_ms()
    saved = f"토큰은 {cfg.tokenstore}에 저장했지만 로그인 기록(auth_event)을"
    try:
        with store.write_session(cfg) as conn:
            with store.transaction(conn):
                store.identity_lock(conn, 'auth_event')
                conn.execute(
                    "INSERT INTO garmin.auth_event (user_id, connection_id, local_date, logged_in_at) VALUES (%s, %s, %s, %s)",
                    (conn.user_id, conn.connection_id, local_date, logged_in_at),
                )
    except (KeyboardInterrupt, EOFError) as error:
        return _fail("login", "record", error, f"{saved} 남기기 전에 취소했다.")
    except (store.StoreError, psycopg.Error, OSError) as error:
        return _fail(
            "login", "record", error, f"{saved} 남기지 못했다: {_describe(error)}"
        )
    except Exception as error:
        _log_unexpected("login", "record", error)
        raise
    logger.info("로그인 기록을 남겼다: stage=record")
    print(f"Garmin에 로그인했다. 토큰을 {cfg.tokenstore}에 저장했다.")
    return 0


def _login_failure_message(cfg: config.Config, error: Exception) -> str | None:
    """로그인 단계 예외의 사유 한 줄. 모르는 예외면 `None`(그대로 전파)이다."""
    if isinstance(error, _NotInteractive):
        return (
            "터미널에서 실행해야 한다(표준 입력이 터미널이 아니다). "
            "비밀번호는 파일·파이프로 받지 않는다."
        )
    if isinstance(error, _EmptyInput):
        return f"입력이 비어 있다: {error.field}"
    if isinstance(error, garmin.SessionBlocked):
        return (
            f"오늘 Garmin 당일 차단({error.reason}) 중이라 로그인하지 않았다. "
            "내일 다시 시도한다."
        )
    if isinstance(error, errors.RateLimited | errors.Blocked403):
        status = 429 if isinstance(error, errors.RateLimited) else 403
        return (
            f"Garmin이 로그인을 거부했다(HTTP {status}). 오늘은 당일 차단을 기록했으니 "
            "내일 다시 시도한다."
        )
    if isinstance(error, errors.AuthFailed):
        return (
            "Garmin 인증에 실패했다. 이메일·비밀번호·MFA 코드를 확인하고 다시 시도한다."
        )
    if isinstance(error, errors.Transient):
        return f"일시적인 오류로 로그인하지 못했다({error}). 잠시 뒤 다시 시도한다."
    if isinstance(error, errors.DomainError):
        return f"Garmin 로그인에 실패했다({type(error).__name__})."
    if isinstance(error, garmin.SessionLockTimeout):
        return f"다른 명령이 Garmin 세션을 쓰고 있다: {error}"
    if isinstance(error, garmin.BlockFileInvalid):
        return f"당일 차단 파일이 잘못돼 Garmin에 닿지 않았다: {error}"
    if isinstance(error, OSError):
        return f"tokenstore({cfg.tokenstore})에 쓰지 못했다: {_describe(error)}"
    return None


_SMOKE_ENDPOINT = "user_summary"
_OPEN_STAGE = "open"
_DATA_STAGE = "data"


def smoke(cfg: config.Config, port: garmin.GarminPort | None = None) -> int:
    """저장된 토큰으로 세션을 열고 어제 `user_summary`를 한 번 부른다. 종료 코드(0·1)를 돌려준다.

    `port`가 없으면 `garmin.GarminAdapter(cfg)`다. 프롬프트·재시도·자동 재로그인이 없다.
    """
    port = port if port is not None else garmin.GarminAdapter(cfg)
    day = dates.today(cfg) - timedelta(days=1)
    cffi = "true" if cfg.cffi_api_session else "false"
    data_label = f"데이터 호출({_SMOKE_ENDPOINT}, {day.isoformat()})"
    print(f"cffi_api_session: {cffi}")
    print(f"garminconnect: {garmin.LIBRARY_VERSION}")
    logger.info("smoke 시작: cffi_api_session=%s", cffi)
    stage = _OPEN_STAGE
    try:
        with port.open_session() as session:
            print("세션 열기: 성공")
            stage = _DATA_STAGE
            try:
                session.fetch_day(_SMOKE_ENDPOINT, day)
            except errors.NoData:
                # 404·빈 응답이어도 인증과 API 경로는 확인됐다.
                result, outcome = "데이터 없음", "no_data"
            else:
                result, outcome = "성공", "ok"
    except Exception as error:
        message = _smoke_failure_message(cfg, stage, error)
        if message is None:
            _log_unexpected("smoke", stage, error)
            raise
        print(f"{'세션 열기' if stage == _OPEN_STAGE else data_label}: 실패")
        reason = getattr(error, "reason", None)
        extra = f" cffi_api_session={cffi}"
        if reason is not None:
            extra = f" reason={reason}{extra}"
        return _fail("smoke", stage, error, message, extra)
    print(f"{data_label}: {result}")
    logger.info(
        "smoke 성공: stage=%s result=%s cffi_api_session=%s", stage, outcome, cffi
    )
    return 0


def _smoke_failure_message(
    cfg: config.Config, stage: str, error: Exception
) -> str | None:
    """smoke 단계 예외의 사유와 다음 행동 한 줄. 모르는 예외면 `None`(그대로 전파)이다."""
    at_open = stage == _OPEN_STAGE
    if isinstance(error, errors.AuthFailed):
        if error.reason is errors.AuthFailedReason.PRIVACY_PROTECTED:
            return (
                "Garmin 계정 프로필이 비공개라 데이터를 받을 수 없다(privacy_protected). "
                "Garmin Connect에서 프로필 공개 범위를 확인한다."
            )
        return (
            "Garmin 토큰이 없거나 만료됐다(token_invalid). "
            "`garmin-pipeline login`을 다시 실행하라."
        )
    if isinstance(error, errors.RateLimited | errors.Blocked403):
        status = 429 if isinstance(error, errors.RateLimited) else 403
        target = "로그인" if at_open else "데이터 호출"
        message = (
            f"Garmin이 {target}을 거부했다(HTTP {status}). 오늘은 당일 차단을 기록했으니 "
            "내일 다시 시도하라."
        )
        if at_open and status == 429:
            message += " 로그인 429는 #453 의심이다."
        if at_open and status == 403:
            message += " 로그인 403은 #444 의심이다."
            if not cfg.cffi_api_session:
                message += (
                    " 내일 config에 `cffi_api_session = true`를 적고 다시 `smoke`하라."
                )
        return message
    if isinstance(error, errors.Rejected):
        if cfg.cffi_api_session:
            return (
                f"curl_cffi로도 Garmin이 데이터 호출을 거부했다({error}). #444 의심이다. "
                "VPN·회사망 등 네트워크를 확인하라."
            )
        return (
            f"Garmin이 데이터 호출을 거부했다({error}). #444 의심이다. "
            f"config({cfg.path})에 `cffi_api_session = true`를 적고 다시 `smoke`하라."
        )
    if isinstance(error, garmin.SessionBlocked):
        return (
            f"오늘 Garmin 당일 차단({error.reason}) 중이라 로그인하지 않았다. "
            "내일 다시 시도한다."
        )
    if isinstance(error, errors.Transient):
        target = "세션을 열지" if at_open else "데이터를 받지"
        return f"일시적인 오류로 {target} 못했다({error}). 잠시 뒤 다시 시도한다."
    if isinstance(error, errors.DomainError):
        target = "세션 열기" if at_open else "데이터 호출"
        return f"Garmin {target}에 실패했다({type(error).__name__})."
    if isinstance(error, garmin.SessionLockTimeout):
        return f"다른 명령이 Garmin 세션을 쓰고 있다: {error}"
    if isinstance(error, garmin.BlockFileInvalid):
        return f"당일 차단 파일이 잘못돼 Garmin에 닿지 않았다: {error}"
    return None


def _describe(error: BaseException) -> str:
    """사유 문구. `OSError`는 strerror와 파일 이름만 쓴다."""
    if isinstance(error, OSError) and error.strerror:
        return (
            f"{error.strerror} ({error.filename})" if error.filename else error.strerror
        )
    return str(error) or type(error).__name__


def _log_unexpected(command: str, stage: str, error: BaseException) -> None:
    """모르는 예외를 다시 던지기 전에 단계와 예외 이름만 남긴다(메시지는 남기지 않는다)."""
    logger.warning(
        "%s 중단(예상하지 못한 오류): stage=%s error=%s",
        command,
        stage,
        type(error).__name__,
    )


def _fail(
    command: str, stage: str, error: BaseException, message: str, extra: str = ""
) -> int:
    """실패를 로그(단계·예외 이름·`extra`)와 stderr 한 줄(`<command> 실패: <message>`)로 남긴다."""
    logger.warning(
        "%s 실패: stage=%s error=%s%s", command, stage, type(error).__name__, extra
    )
    print(f"{command} 실패: {message}", file=sys.stderr)
    return 1


def _prepare_tokenstore(tokenstore: Path) -> None:
    """tokenstore와 없는 부모를 0700으로 만든다. 이미 있는 tokenstore는 0700으로 바꾼다.

    이미 있는 부모(홈 폴더 등)는 건드리지 않는다. tokenstore가 디렉터리가 아니면
    `NotADirectoryError`다.
    """
    missing: list[Path] = []
    for path in (tokenstore, *tokenstore.parents):
        if os.path.lexists(path):
            break
        missing.append(path)
    for path in reversed(missing):
        try:
            os.mkdir(path, _DIR_MODE)
        except FileExistsError:
            pass
        # mkdir의 mode는 umask가 깎으므로 다시 맞춘다.
        os.chmod(path, _DIR_MODE)
    if not tokenstore.is_dir():
        raise NotADirectoryError(
            errno.ENOTDIR, "tokenstore가 디렉터리가 아니다", str(tokenstore)
        )
    os.chmod(tokenstore, _DIR_MODE)
