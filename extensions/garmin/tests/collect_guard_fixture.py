"""Exercise session protection through the supervisor, with no external network."""
import contextlib
from datetime import date
import json
import os
from pathlib import Path
import socket
import sys

from collect_fixture import checked_fixture
home, marker = checked_fixture()
ext = home / 'extensions/garmin'
sys.path.insert(0, str(ext / 'src'))
import collect
import garmin_session as g

original_connect = socket.socket.connect
def guarded(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in ('127.0.0.1', '::1'):
        raise OSError('network disabled')
    return original_connect(sock, address)
socket.socket.connect = guarded
canaries = ['-'.join(('synthetic', 'password', 'canary')), '-'.join(('synthetic', 'token', 'canary'))]
for value in (*sys.argv, *os.environ.values()):
    assert all(secret not in value for secret in canaries)
with (home / 'process-audit').open('a') as audit: audit.write('collect: clean\n')
original_emit = collect.emit
def checked_emit(kind, **values):
    assert all(secret not in json.dumps(values) for secret in canaries)
    original_emit(kind, **values)
collect.emit = checked_emit

class FakeError(OSError):
    response = type('Response', (), {'status_code': 403})()
class Fake:
    garmin_connect_daily_summary_url = '/summary'
    def login(self, path):
        with (home / 'guard-logins').open('a') as stream: stream.write('login\n')
    def _require_display_name(self): return 'synthetic'
    def connectapi(self, path, params):
        with (home / 'guard-calls').open('a') as stream: stream.write('call\n')
        if marker['guard_fail']: raise FakeError('private')
        return marker['response']

@contextlib.contextmanager
def open_client(_path, _zone):
    adapter = g.GarminAdapter(home / 'guard-tokens', client_factory=Fake, today=lambda: date.fromisoformat(marker['guard_date']), sleep=lambda _: None, uniform=lambda a,b: 1)
    with adapter.open_session() as session:
        class Client:
            library_version = g.LIBRARY_VERSION
            def user_summary(self, day):
                for _ in range(2 if marker['guard_fail'] else 0):
                    try: session.fetch_day('user_summary', date.fromisoformat(day))
                    except g.GarminError as error:
                        if error.code != 'GARMIN_REJECTED': raise
                return session.fetch_day('user_summary', date.fromisoformat(day)).payload
        yield Client()
collect.open_client = open_client
raise SystemExit(collect.main())
