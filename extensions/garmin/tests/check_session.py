"""Network-free checks for session behavior and lock contention."""
from datetime import date, timedelta
import fcntl
import contextlib
import io
import logging
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import garmin_session as g

TODAY = date(2026, 11, 2)


class FakeError(OSError):
    def __init__(self, status):
        self.response = type('Response', (), {'status_code': status})()
        super().__init__('private response')


class Fake:
    def __init__(self, results=()):
        self.results = list(results)
        self.calls = []
        self.logins = 0

    def login(self, tokenstore):
        self.logins += 1

    def get_sleep_data(self, day):
        self.calls.append(day)
        result = self.results.pop(0) if self.results else {'ok': True}
        if isinstance(result, Exception):
            raise result
        return result

    get_daily_weigh_ins = get_sleep_data


def expect(code, call):
    try:
        call()
    except g.GarminError as error:
        assert error.code == code, (error.code, code)
        assert 'private response' not in str(error)
        return error
    raise AssertionError('expected ' + code)


def run():
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp)
        waits = []
        client = Fake([FakeError(403), {'ok': 1}, FakeError(403), FakeError(403), FakeError(403)])
        adapter = g.GarminAdapter(path, client_factory=lambda: client, today=lambda: TODAY, sleep=waits.append, uniform=lambda a, b: 1.5)
        with adapter.open_session() as session:
            fetch = lambda: session.fetch_day('sleep_data', TODAY)
            expect('GARMIN_REJECTED', fetch)
            assert fetch().payload == {'ok': 1}
            expect('GARMIN_REJECTED', fetch)
            expect('GARMIN_REJECTED', fetch)
            expect('BLOCKED_403', fetch)
            expect('SESSION_BLOCKED', fetch)
            session.next_date()
        assert waits == [1.5] * 5 + [5]
        assert json.loads((path / 'block.json').read_text())['reason'] == 'blocked_403'
        assert (path / 'block.json').stat().st_mode & 0o777 == 0o600
        expect('SESSION_BLOCKED', lambda: adapter.open_session().__enter__())
        assert client.logins == 1
        adapter.today = lambda: TODAY + timedelta(days=1)
        with adapter.open_session() as session:
            assert session.fetch_day('sleep_data', TODAY).payload == {'ok': True}
        (path / 'block.json').write_text('{bad')
        expect('BLOCK_FILE_INVALID', lambda: adapter.open_session().__enter__())
        (path / 'block.json').unlink()
        client.results = [FakeError(429)]
        with patch.object(g, 'write_block', side_effect=OSError('private path')):
            with adapter.open_session() as session:
                expect('RATE_LIMITED', lambda: session.fetch_day('sleep_data', TODAY))
                expect('SESSION_BLOCKED', lambda: session.fetch_day('sleep_data', TODAY))
        assert not (path / 'block.json').exists()
        client.results = [FakeError(403)] * 3
        with adapter.open_session(first_call_endpoints=('daily_weigh_ins',)) as session:
            for _ in range(3):
                expect('GARMIN_REJECTED', lambda: session.fetch_day('daily_weigh_ins', TODAY))
            assert session.fetch_day('daily_weigh_ins', TODAY) is None
            assert session.consecutive_403 == 0
        fd = os.open(path / '.session.lock', os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            adapter.lock_wait_seconds = 0
            error = expect('SESSION_LOCK_TIMEOUT', lambda: adapter.open_session().__enter__())
            assert error.retryable
            with adapter.open_session(lock_held=True) as session:
                assert session is not None
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        try:
            raise OSError('private connection')
        except OSError as cause:
            wrapped = g.garminconnect.GarminConnectConnectionError('private response')
            wrapped.__cause__ = cause
        _, transient = g.classify(wrapped, login=True)
        assert transient.code == 'GARMIN_TRANSIENT' and transient.retryable
        for status, code in [(401, 'LOGIN_REQUIRED'), (404, 'GARMIN_NO_DATA'), (400, 'GARMIN_REJECTED'), (500, 'GARMIN_TRANSIENT')]:
            assert g.classify(FakeError(status))[1].code == code
        client.results = [FakeError(429)]
        with adapter.open_session() as session:
            expect('RATE_LIMITED', lambda: session.fetch_day('sleep_data', TODAY))
        assert json.loads((path / 'block.json').read_text())['reason'] == 'rate_limited'
    import collect
    import collect_client
    class Clock:
        @staticmethod
        def now(zone):
            assert zone.key == 'Pacific/Kiritimati'
            return __import__('datetime').datetime(2026, 11, 3, tzinfo=zone)
    class Adapter:
        def __init__(self, path, *, today):
            assert today() == date(2026, 11, 3)
        @contextlib.contextmanager
        def open_session(self):
            yield object()
    with patch.object(collect_client, 'datetime', Clock), patch.object(collect_client, 'GarminAdapter', Adapter):
        with collect_client.open_client('/tmp/unused', 'Pacific/Kiritimati'):
            pass
    def fail_with_warning():
        logging.getLogger('garminconnect.child').warning('private remote response')
        raise g.GarminError('LOGIN_REQUIRED')
    stderr = io.StringIO()
    with patch.object(collect, 'run', fail_with_warning), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
        assert collect.main() == 1
    assert 'private remote response' not in stderr.getvalue()
    print('check_session: all checks passed')


if __name__ == '__main__':
    run()
