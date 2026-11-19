"""Official Garmin authentication entry point: terminal login or token probe."""
import contextlib
import getpass
import io
import json
import logging
import os
import sys
import warnings
import signal
import secrets
import stat
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

from garmin_pipeline import auth, config, errors, garmin
from supervised_input import _unique_object, canonical_uuid, validate_settings
from collect_credentials import CredentialEvidenceError, _read_private


def runtime_config(env):
    snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'], object_pairs_hook=_unique_object)
    if (not isinstance(snapshot, dict) or set(snapshot) != {'version', 'extension', 'user_id', 'values'}
            or type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['extension'] != 'garmin'):
        raise ValueError('invalid snapshot')
    canonical_uuid(snapshot['user_id'])
    values = snapshot['values']
    validate_settings(values)
    home = Path(env['BRAIN_EXTENSION_HOME'])
    tokenstore = Path(values['garmin.tokenstore'])
    if not home.is_absolute() or not tokenstore.is_absolute() or tokenstore != home / 'tokenstore' or '..' in home.parts:
        raise ValueError('invalid tokenstore')
    timezone = values.get('garmin.timezone', 'UTC')
    ZoneInfo(timezone)
    return config.Config(path=home / 'unused-config', environment='runtime', tokenstore=tokenstore,
        data_dir=home, reports_dir=home, inbox_dir=home, timezone=timezone,
        collect_time=time(11), retry_time=time(11, 15), report_time=time(11, 30),
        report_wait_minutes=30, report_codex_timeout_minutes=20, report_model=None,
        report_reasoning_effort='high', profile_path=home / 'unused-profile',
        date_pause_seconds=5, call_pause_min_seconds=1, call_pause_max_seconds=2,
        max_dates_per_run=10, max_rejected_attempts=3, max_consecutive_403=3,
        lock_wait_seconds=60, cffi_api_session=False)


class BindingRecoveryRequired(Exception):
    """A bound account must be recovered without replacing its credentials."""


class AccessTokenUnconfirmed(Exception):
    """The observed access token was rejected; refresh was not attempted."""


def _open_tokenstore(path):
    # Walk from root without following any component, and create only the
    # final directory beneath the already verified extension home.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(path.parts[1:]):
            if index == len(path.parts[1:]) - 1:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            info = os.stat(part, dir_fd=fd, follow_symlinks=False)
            # System-owned ancestry links (for example macOS /var) are stable;
            # the final tokenstore itself is never allowed to be a link.
            if stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and index < len(path.parts[1:]) - 1:
                flags &= ~os.O_NOFOLLOW
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if info.st_uid != os.geteuid():
            raise ValueError('unsafe tokenstore owner')
        os.fchmod(fd, 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


_published = False


def _safe_dump_tokens(client, tokenstore, *, mfa, attempts, directory_fd=None):
    global _published
    owned = directory_fd is None
    fd = _open_tokenstore(tokenstore) if owned else directory_fd
    temporary = None
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    published = False
    try:
        current_fd = _open_tokenstore(tokenstore)
        try:
            current, locked = os.fstat(current_fd), os.fstat(fd)
            if (current.st_dev, current.st_ino) != (locked.st_dev, locked.st_ino):
                raise ValueError('tokenstore changed while locked')
        finally:
            os.close(current_fd)
        with client.client._token_lock:
            payload = client.client.dumps()
        parsed = json.loads(payload)
        if not isinstance(parsed, dict) or any(not isinstance(parsed.get(key), str) or not parsed[key] for key in ('di_token', 'di_refresh_token', 'di_client_id')):
            raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
        try:
            os.stat('brain-account-binding.json', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise BindingRecoveryRequired()
        temporary = '.garmin-login-' + secrets.token_hex(16)
        out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(out, 'w', encoding='utf-8') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        if signal.sigpending() & {signal.SIGINT, signal.SIGTERM}:
            raise KeyboardInterrupt()
        current_fd = _open_tokenstore(tokenstore)
        try:
            current, locked = os.fstat(current_fd), os.fstat(fd)
            if (current.st_dev, current.st_ino) != (locked.st_dev, locked.st_ino):
                raise ValueError('tokenstore changed before publication')
        finally:
            os.close(current_fd)
        os.replace(temporary, 'garmin_tokens.json', src_dir_fd=fd, dst_dir_fd=fd)
        temporary = None
        current_fd = _open_tokenstore(tokenstore)
        try:
            current, locked = os.fstat(current_fd), os.fstat(fd)
            if (current.st_dev, current.st_ino) != (locked.st_dev, locked.st_ino):
                raise ValueError('tokenstore changed during publication')
        finally:
            os.close(current_fd)
        published = True
        _published = True
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=fd)
        # A signal after publication must not turn the completed transaction
        # into a cancelled journal. Before publication it remains cancellation.
        pending = signal.sigpending() & {signal.SIGINT, signal.SIGTERM}
        for item in pending:
            signal.sigwait({item})
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        if owned:
            os.close(fd)
        if pending and not published:
            raise KeyboardInterrupt()


class HiddenPrompts:
    def __init__(self, output):
        self.output = output

    def _read(self, prompt):
        auth._require_tty()
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            return getpass.getpass(prompt, stream=self.output)

    def credentials(self):
        return self._read('Garmin 이메일: '), self._read('Garmin 비밀번호: ')

    def mfa_code(self):
        return self._read('Garmin MFA 코드: ')


def run(env, terminal, output):
    cfg = runtime_config(env)
    bound = os.path.lexists(cfg.tokenstore / 'brain-account-binding.json')
    if terminal:
        auth._require_tty()
        if bound:
            raise BindingRecoveryRequired()
        fd = _open_tokenstore(cfg.tokenstore)
        try:
            def save(client, tokenstore, **kwargs):
                return _safe_dump_tokens(client, tokenstore, directory_fd=fd, **kwargs)
            garmin.interactive_login(cfg, auth._CheckedPrompts(HiddenPrompts(output)), save_tokens=save, tokenstore_fd=fd)
        finally:
            os.close(fd)
        return
    if not cfg.tokenstore.is_dir():
        if bound:
            raise BindingRecoveryRequired()
        raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
    with garmin._session_lock(cfg.tokenstore, cfg.lock_wait_seconds):
        garmin._refuse_if_blocked(cfg.tokenstore, cfg)
        # Recheck under the session lock before deciding which recovery path is safe.
        bound = os.path.lexists(cfg.tokenstore / 'brain-account-binding.json')
        fd = os.open(cfg.tokenstore, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                token = _read_private(fd, 'garmin_tokens.json', 1048576)
                parsed = json.loads(token)
                if not isinstance(parsed, dict) or not isinstance(parsed.get('di_token'), str) or not parsed['di_token']:
                    raise ValueError('invalid token')
                # Garmin.login accepts inline JSON. No path is set on its client,
                # so refresh cannot save back to the original tokenstore.
                serialized = json.dumps(parsed)
            except (FileNotFoundError, CredentialEvidenceError, ValueError, UnicodeError):
                if bound:
                    raise BindingRecoveryRequired() from None
                raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID) from None
        finally:
            os.close(fd)
        client = garmin._configured_client(cfg)
        # Garmin 0.3.20 calls this on proactive expiry and on HTTP 401.
        # Suppress both on this instance: only the access token is probed and
        # no remote rotation can invalidate the persisted refresh token.
        client.client._refresh_session = lambda: None
        try:
            garmin._run_login_step(lambda: client.login(serialized), cfg.tokenstore, cfg)
        except errors.AuthFailed:
            if bound:
                raise AccessTokenUnconfirmed() from None
            raise



def main(argv=None, env=None):
    global _published
    _published = False
    args = sys.argv[1:] if argv is None else argv
    terminal = args == ['--terminal']
    output = sys.stdout
    previous_handlers = {}
    if terminal:
        def cancel_or_finish(signum, frame):
            if not _published:
                raise KeyboardInterrupt()
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, cancel_or_finish)
    # No exception, third-party output or diagnostic may expose credentials.
    old_disable = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            if args not in ([], ['--terminal']):
                raise ValueError('invalid arguments')
            run(os.environ if env is None else env, terminal, output)
    except (KeyboardInterrupt, EOFError):
        code = None if _published else 'AUTH_CANCELLED'
    except AccessTokenUnconfirmed:
        code = 'GARMIN_ACCESS_TOKEN_UNCONFIRMED'
    except BindingRecoveryRequired:
        code = 'GARMIN_BOUND_LOGIN_REFUSED' if terminal else 'GARMIN_BINDING_RECOVERY_REQUIRED'
    except (errors.AuthFailed, auth._NotInteractive, auth._EmptyInput):
        code = 'LOGIN_REQUIRED'
    except Exception:
        code = 'AUTH_UNAVAILABLE'
    else:
        code = None
    finally:
        logging.disable(old_disable)
    # Embedded callers share their process; the CLI process keeps the handler
    # through exit so a late signal cannot contradict a published token.
    if env is not None:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if code is not None:
        if terminal:
            print(code, file=sys.stderr)
        else:
            print(json.dumps({'abi': 1, 'type': 'error', 'code': code, 'retryable': code == 'AUTH_UNAVAILABLE'}))
        return 1
    if terminal:
        if _published:
            print('GARMIN_TOKEN_PUBLISHED', file=sys.stderr)
        print('Garmin 인증을 완료했습니다.')
    else:
        print(json.dumps({'abi': 1, 'type': 'result'}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
