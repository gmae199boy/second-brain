"""시험 디렉터리에만 복사되는 합성 client wrapper. 배송 manifest는 참조하지 않는다."""
import json
import os
from pathlib import Path
import sys
import socket
import time
from urllib.parse import urlsplit

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
import collect


def checked_fixture():
    extension = Path(os.environ['BRAIN_EXTENSION_HOME']).resolve(strict=True)
    home = extension.parent.parent.resolve(strict=True)
    default = (Path.home() / '.second_brain').resolve()
    temporary_roots = (Path('/tmp').resolve(), Path('/private/var/folders'))
    if home == default or not any(home.is_relative_to(root) for root in temporary_roots) or not home.name.startswith('brain-ext-') or extension != home / 'extensions' / 'garmin':
        raise ValueError('fixture invalid')
    marker = json.loads((home / '.garmin-collect-fixture.json').read_text())
    if marker.get('home') != str(home) or not marker.get('database', '').startswith('brain_test_'):
        raise ValueError('fixture invalid')
    url = os.environ['BRAIN_DATABASE_URL']
    parsed = urlsplit(url)
    params = psycopg.conninfo.conninfo_to_dict(url)
    if (parsed.scheme not in ('postgres', 'postgresql') or parsed.query or parsed.fragment
        or set(params) - {'host', 'port', 'dbname', 'user', 'password'}
        or params.get('host') not in ('127.0.0.1', 'localhost') or params.get('host') != marker.get('host')
        or params.get('port') != marker.get('port') or params.get('dbname') != marker['database']
        or any(key.startswith('PG') for key in os.environ)):
        raise ValueError('fixture invalid')
    credentials = parsed.netloc.rsplit('@', 1)[0] + '@' if '@' in parsed.netloc else ''
    url = parsed._replace(netloc=credentials + '127.0.0.1:' + params['port']).geturl()
    os.environ['BRAIN_DATABASE_URL'] = url
    with (home / 'collect-connections').open('a') as output: output.write('connect\n')
    with psycopg.connect(url, autocommit=True) as conn:
        if conn.execute('select current_database()').fetchone()[0] != marker['database']:
            raise ValueError('fixture invalid')
    return home, marker


class Fake:
    profile_id = 'fixture-account'
    library_version = 'fixture-v1'
    def __init__(self, home, marker): self.home, self.marker = home, marker
    def configure_first(self, endpoints): self.first = {endpoint: 0 for endpoint in endpoints}
    def fetch_day(self, endpoint, day):
        return self._fetch('day', day.isoformat(), endpoint)
    def fetch_activity(self, endpoint, activity_id):
        return self._fetch('activity', str(activity_id), endpoint)
    def next_date(self): pass
    def _fetch(self, scope, key, endpoint):
        if endpoint in getattr(self, 'first', {}):
            if self.first[endpoint] >= 3: return None
            self.first[endpoint] += 1
        with (self.home / 'collect-calls').open('a') as calls:
            calls.write(json.dumps([scope,key,endpoint]) + '\n')
        if self.marker.get('barrier') and endpoint == self.marker.get('barrier_endpoint', 'sleep_data') and key == self.marker.get('barrier_key', key):
            (self.home / 'collect-reached').write_text(str(os.getpid()))
            deadline = time.monotonic() + 30
            while not (self.home / 'collect-release').exists():
                if time.monotonic() > deadline: raise ValueError('fixture timeout')
                time.sleep(.02)
        if endpoint == self.marker.get('fail_endpoint'):
            from garmin_session import GarminError
            raise GarminError(self.marker.get('fail_code', 'GARMIN_TRANSIENT'), True)
        if endpoint == 'sleep_data' and 'sleep_payload' in self.marker:
            if self.marker['sleep_payload'] is None:
                from garmin_session import GarminError
                raise GarminError('GARMIN_NO_DATA')
            return self.marker['sleep_payload']
        return self.marker['response'] if endpoint == 'user_summary' else ([] if endpoint == 'activities_by_date' else {'ok': True})

def main():
    try:
        home, marker = checked_fixture()
        class Tee:
            def __init__(self, stream, path):
                self.stream, self.file = stream, path.open('w')
            def write(self, data):
                self.file.write(data); self.file.flush()
                return self.stream.write(data)
            def flush(self): self.file.flush(); self.stream.flush()
        token = os.environ['BRAIN_ATTEMPT_TOKEN']
        sys.stdout = Tee(sys.stdout, home / ('collect-stdout-' + token))
        sys.stderr = Tee(sys.stderr, home / ('collect-stderr-' + token))
        original_connect = socket.socket.connect
        def guarded_connect(sock, address):
            if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in ('127.0.0.1', '::1'):
                with (home / 'collect-outbound').open('a') as output: output.write('blocked\n')
                raise OSError('outbound blocked')
            return original_connect(sock, address)
        socket.socket.connect = guarded_connect
        original_emit = collect.emit
        def record_emit(kind, **values):
            if kind in ('error', 'result'):
                (home / ('collect-' + kind + '-' + os.environ['BRAIN_ATTEMPT_TOKEN'])).write_text(json.dumps({'abi': 1, 'type': kind, **values}))
            original_emit(kind, **values)
        collect.emit = record_emit
        if marker.get('publish_failure'):
            def fail_publish(*args, **kwargs):
                raise ValueError('synthetic publication failure')
            collect.store._publish_steps = fail_publish
        import signal
        signal.signal(signal.SIGTERM, collect._stop)
        (home / ('collect-start-' + os.environ['BRAIN_ATTEMPT_TOKEN'])).touch()
        if marker.get('guard_status'):
            from contextlib import contextmanager
            from datetime import date
            import garmin_session as g
            class RemoteError(OSError):
                def __init__(self, status):
                    self.response = type('Response', (), {'status_code': status})()
                    super().__init__('-'.join(('synthetic','token','canary')))
            class Remote:
                profile_id = 'fixture-account'
                def login(self, path):
                    if marker['guard_status'] == 401: raise RemoteError(401)
                def __getattr__(self, name):
                    if name.startswith('get_'):
                        def request(*args):
                            with (home / 'guard-calls').open('a') as calls: calls.write('call\n')
                            raise RemoteError(marker['guard_status'])
                        return request
                    raise AttributeError(name)
            @contextmanager
            def guarded_client(path, zone, settings=None, first_call_endpoints=(), *, lock_held=False):
                adapter = g.GarminAdapter(path,client_factory=Remote,today=lambda:date.fromisoformat(os.environ['BRAIN_RANGE_FROM']),sleep=lambda _:None,uniform=lambda a,b:0,
                                          max_consecutive_403=int(settings['garmin.max_consecutive_403']))
                with adapter.open_session(first_call_endpoints=first_call_endpoints,lock_held=lock_held) as session:
                    from collect_client import SessionClient
                    yield SessionClient(session)
            collect.open_client = guarded_client
            collect.run()
        else:
            collect.run(Fake(home, marker))
    except Exception as exc:
        code = exc.code if isinstance(exc, collect.GarminError) else str(exc) if isinstance(exc, ValueError) and str(exc) in ('COLLECT_INVALID_ATTEMPT', 'COLLECT_STOPPED', 'COLLECT_PARTIAL', 'COLLECT_ACCOUNT_UNKNOWN', 'COLLECT_ACCOUNT_MISMATCH') else 'COLLECT_INVALID'
        collect.emit('error', code=code, retryable=False)
        return 1
    finally:
        if 'home' in locals():
            (home / ('collect-exited-' + os.environ.get('BRAIN_ATTEMPT_TOKEN', 'unknown'))).touch()
    return 0


if __name__ == '__main__': sys.exit(main())
