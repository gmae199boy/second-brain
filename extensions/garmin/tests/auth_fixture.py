"""Test-only auth entry; confined to a marked temporary extension home."""
import json
import os
from pathlib import Path
import socket
import sys

extension = Path(os.environ['BRAIN_EXTENSION_HOME']).resolve(strict=True)
home = extension.parent.parent
marker = json.loads((home / '.garmin-auth-fixture.json').read_text())
if not home.name.startswith('brain-ext-') or not home.is_relative_to(Path('/tmp').resolve()) and not home.is_relative_to(Path('/private/var/folders')) or marker['home'] != str(home) or extension != home / 'extensions/garmin':
    raise SystemExit(1)
original_connect = socket.socket.connect

def guarded_connect(sock, address):
    if sock.family in (socket.AF_INET, socket.AF_INET6) and address[0] not in ('127.0.0.1', '::1'):
        raise OSError('network disabled')
    return original_connect(sock, address)
socket.socket.connect = guarded_connect
canaries = ['-'.join(('synthetic', 'password', 'canary')), '-'.join(('synthetic', 'token', 'canary'))]
for value in (*sys.argv, *os.environ.values()):
    assert all(secret not in value for secret in canaries)
with (home / 'process-audit').open('a') as audit:
    audit.write(('terminal' if sys.argv[1:] == ['--terminal'] else 'auth') + ': clean\n')
sys.path.insert(0, str(extension / 'src'))
import auth
import garmin_session as session
original_emit = auth.emit
def checked_emit(kind, **values):
    assert all(secret not in json.dumps(values) for secret in canaries)
    original_emit(kind, **values)
auth.emit = checked_emit

class Fake:
    def __init__(self): self.client = self
    def login(self, path, password=None, **kwargs):
        if password is not None:
            with (home / 'terminal-calls').open('a') as stream: stream.write('login\n')
            return ('needs_mfa' if marker.get('mfa') else 'ok', None)
        with (home / 'auth-calls').open('a') as stream:
            stream.write('login\n')
        if marker['invalid']:
            raise session.garminconnect.GarminConnectAuthenticationError('private')

    def _load_profile_and_settings(self):
        with (home / 'terminal-calls').open('a') as stream: stream.write('profile\n')
    def dump(self, path):
        with (home / 'terminal-calls').open('a') as stream: stream.write('dump\n')
        (Path(path) / 'garmin_tokens.json').write_text(canaries[1])

if sys.argv[1:] == ['--terminal']:
    original_terminal_login = auth.terminal_login
    auth.terminal_login = lambda adapter: original_terminal_login(adapter, isatty=lambda: True, input_fn=lambda _: 'synthetic@example.invalid', password_fn=lambda _: canaries[0])
auth.GarminAdapter = lambda path, **kwargs: session.GarminAdapter(path, client_factory=Fake, lock_wait_seconds=0, **kwargs)
raise SystemExit(auth.main())
