"""Garmin authentication: unattended token check and terminal-only login."""
import getpass
from datetime import date, datetime
from zoneinfo import ZoneInfo
import json
import os
from pathlib import Path
import sys

from collect_settings import decode
from garmin_session import GarminAdapter, GarminError, session_lock, silence_library_logging

DEFAULT_TOKENSTORE = '~/.garmin-pipeline/tokens'


def tokenstore_from_env(env):
    return Path(decode(env.get('BRAIN_SETTINGS_SNAPSHOT'), strict=False)['garmin.tokenstore']).expanduser()


def today_from_env(env):
    zone = decode(env.get('BRAIN_SETTINGS_SNAPSHOT'), strict=False).get('garmin.timezone')
    if zone is None:
        # [ASSUMPTION] 설정 시간대가 없으면 시스템 현지 날짜를 사용한다.
        return date.today
    timezone = ZoneInfo(zone)
    return lambda: datetime.now(timezone).date()


def prepare_tokenstore(path):
    missing = []
    for parent in (path, *path.parents):
        if os.path.lexists(parent):
            break
        missing.append(parent)
    for parent in reversed(missing):
        try:
            os.mkdir(parent, 0o700)
        except FileExistsError:
            pass
        os.chmod(parent, 0o700)
    if not path.is_dir():
        raise OSError('invalid tokenstore')
    os.chmod(path, 0o700)


def unattended(adapter):
    with adapter.open_session():
        pass


def terminal_login(adapter, *, isatty=None, input_fn=None, password_fn=None):
    isatty = sys.stdin.isatty if isatty is None else isatty
    input_fn = input if input_fn is None else input_fn
    password_fn = getpass.getpass if password_fn is None else password_fn
    if not isatty():
        raise GarminError('LOGIN_REQUIRED')
    prepare_tokenstore(adapter.tokenstore)
    if adapter.blocked_today():
        raise GarminError('SESSION_BLOCKED')
    email = input_fn('Garmin 이메일: ').strip()
    password = password_fn('Garmin 비밀번호: ')
    if not email or not password:
        raise GarminError('LOGIN_REQUIRED')
    with session_lock(adapter.tokenstore, adapter.lock_wait_seconds, monotonic=adapter.monotonic, sleep=adapter.sleep):
        if adapter.blocked_today():
            raise GarminError('SESSION_BLOCKED')
        client = adapter.client_factory()
        try:
            status, _ = adapter.login_step(lambda: client.client.login(email, password, return_on_mfa=True))
        finally:
            password = None
        if status == 'needs_mfa':
            raise GarminError('LOGIN_REQUIRED')
        adapter.login_step(client._load_profile_and_settings)
        client.client.dump(str(adapter.tokenstore))
        token = adapter.tokenstore / 'garmin_tokens.json'
        os.chmod(token, 0o600)
        if token.stat().st_mode & 0o777 != 0o600:
            raise GarminError('LOGIN_REQUIRED')


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}, ensure_ascii=False), flush=True)


def main(argv=None, env=None):
    silence_library_logging()
    argv = sys.argv[1:] if argv is None else argv
    env = os.environ if env is None else env
    terminal = argv == ['--terminal']
    try:
        if argv and not terminal:
            raise GarminError('LOGIN_REQUIRED')
        settings = decode(env.get('BRAIN_SETTINGS_SNAPSHOT'), strict=False)
        kwargs = {} if settings['garmin.lock_wait_seconds'] == 60 else {'lock_wait_seconds': settings['garmin.lock_wait_seconds']}
        adapter = GarminAdapter(tokenstore_from_env(env), today=today_from_env(env), **kwargs)
        if terminal:
            terminal_login(adapter)
            print('Garmin 로그인 완료')
        else:
            unattended(adapter)
            emit('result', summary='Garmin 인증 확인 완료')
        return 0
    except (Exception, KeyboardInterrupt) as error:
        code = error.code if isinstance(error, GarminError) else 'LOGIN_REQUIRED'
        retryable = error.retryable if isinstance(error, GarminError) else False
        if terminal:
            print(code, file=sys.stderr)
        else:
            emit('error', code=code, retryable=retryable)
        return 1


if __name__ == '__main__':
    sys.exit(main())
