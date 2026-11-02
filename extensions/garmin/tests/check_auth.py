"""Exercise auth without a network or real credentials."""
import contextlib
import io
import json
import logging
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import auth
import garmin_session as g


class Fake:
    def __init__(self, mfa=False):
        self.client = self
        self.mfa = mfa
        self.calls = []

    def login(self, *args, **kwargs):
        self.calls.append('login')
        if kwargs:
            return ('needs_mfa' if self.mfa else 'ok', None)

    def _load_profile_and_settings(self):
        self.calls.append('profile')

    def dump(self, path):
        self.calls.append('dump')
        (Path(path) / 'garmin_tokens.json').write_text('fake token')


def expect(code, func):
    try:
        func()
    except g.GarminError as error:
        assert error.code == code
        return
    raise AssertionError(code)


def run():
    with tempfile.TemporaryDirectory() as root:
        path = Path(root) / 'nested' / 'tokens'
        fake = Fake()
        adapter = g.GarminAdapter(path, client_factory=lambda: fake)
        prompts = dict(isatty=lambda: True, input_fn=lambda _: ' fake@example.invalid ', password_fn=lambda _: 'fake password')
        expect('LOGIN_REQUIRED', lambda: auth.terminal_login(adapter, isatty=lambda: False))
        assert not path.exists()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            auth.terminal_login(adapter, **prompts)
        assert 'fake password' not in out.getvalue() + err.getvalue()
        assert 'fake token' not in out.getvalue() + err.getvalue()
        for item in Path(root).rglob('*'):
            if item.is_file() and item != path / 'garmin_tokens.json':
                assert b'fake password' not in item.read_bytes() and b'fake token' not in item.read_bytes()
        assert fake.calls == ['login', 'profile', 'dump']
        assert path.stat().st_mode & 0o777 == 0o700
        assert (path / 'garmin_tokens.json').stat().st_mode & 0o777 == 0o600
        auth.unattended(adapter)
        assert fake.calls[-1] == 'login'
        mfa = Fake(mfa=True)
        adapter.client_factory = lambda: mfa
        expect('LOGIN_REQUIRED', lambda: auth.terminal_login(adapter, **prompts))
        assert mfa.calls == ['login']
        g.write_block(path, adapter.today(), 'rate_limited')
        expect('SESSION_BLOCKED', lambda: auth.terminal_login(adapter, isatty=lambda: True, input_fn=lambda _: (_ for _ in ()).throw(AssertionError('prompted'))))
        output = io.StringIO()
        assert auth.today_from_env({'BRAIN_SETTINGS_SNAPSHOT': json.dumps({'values': {'garmin.timezone': 'Pacific/Kiritimati'}})})() == __import__('datetime').datetime.now(__import__('zoneinfo').ZoneInfo('Pacific/Kiritimati')).date()
        with contextlib.redirect_stdout(output):
            assert auth.main([], {'BRAIN_SETTINGS_SNAPSHOT': json.dumps({'values': {'garmin.tokenstore': str(path)}})}) == 1
        assert json.loads(output.getvalue()) == {'abi': 1, 'type': 'error', 'code': 'SESSION_BLOCKED', 'retryable': False}
        stderr = io.StringIO()
        class WarningAdapter:
            def open_session(self):
                logging.getLogger('garminconnect.child').warning('private remote response')
                raise g.GarminError('LOGIN_REQUIRED')
        from unittest.mock import patch
        with patch.object(auth, 'GarminAdapter', return_value=WarningAdapter()), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            assert auth.main([], {}) == 1
        assert 'private remote response' not in stderr.getvalue()
        import fcntl
        with (path / '.session.lock').open('r+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            (path / 'block.json').unlink()
            adapter.lock_wait_seconds = 0
            from unittest.mock import patch
            with patch.object(auth, 'GarminAdapter', return_value=adapter):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    assert auth.main([], {}) == 1
                assert json.loads(output.getvalue()) == {'abi': 1, 'type': 'error', 'code': 'SESSION_LOCK_TIMEOUT', 'retryable': True}
    print('check_auth: all checks passed')


if __name__ == '__main__':
    run()
