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
    def __init__(self, home, marker): self.home, self.marker = home, marker
    def user_summary(self, day):
        with (self.home / 'collect-calls').open('a') as calls: calls.write('fetch\n')
        if self.marker.get('barrier'):
            (self.home / 'collect-reached').write_text(str(os.getpid()))
            deadline = time.monotonic() + 30
            while not (self.home / 'collect-release').exists():
                if time.monotonic() > deadline: raise ValueError('fixture timeout')
                time.sleep(.02)
        return self.marker['response']


def main():
    try:
        home, marker = checked_fixture()
        original_connect = socket.socket.connect
        def guarded_connect(sock, address):
            if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in ('127.0.0.1', '::1'):
                with (home / 'collect-outbound').open('a') as output: output.write('blocked\n')
                raise OSError('outbound blocked')
            return original_connect(sock, address)
        socket.socket.connect = guarded_connect
        original_emit = collect.emit
        def record_emit(kind, **values):
            if kind == 'error':
                (home / ('collect-error-' + os.environ['BRAIN_ATTEMPT_TOKEN'])).write_text(json.dumps({'abi': 1, 'type': kind, **values}))
            original_emit(kind, **values)
        collect.emit = record_emit
        collect.run(Fake(home, marker))
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc) in ('COLLECT_INVALID_ATTEMPT', 'COLLECT_STOPPED') else 'COLLECT_INVALID'
        collect.emit('error', code=code, retryable=False)
        return 1
    finally:
        if 'home' in locals():
            (home / ('collect-exited-' + os.environ.get('BRAIN_ATTEMPT_TOKEN', 'unknown'))).touch()
    return 0


if __name__ == '__main__': sys.exit(main())
