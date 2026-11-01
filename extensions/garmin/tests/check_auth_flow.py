"""합성 client만 사용하는 MFA 및 고정 오류 검증."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from auth_flow import AuthFailure, MfaRejected, authenticate

class Client:
    def __init__(self, count):
        self.remaining, self.calls, self.client = count, [], self
    def login(self, path):
        self.calls.append('login')
        return ('needs_mfa', object()) if self.remaining else (None, None)
    def resume_login(self, state, code):
        self.calls.append('mfa')
        self.remaining -= 1
        return ('needs_mfa', state) if self.remaining else (None, None)
    def dump(self, path): self.calls.append('dump')

for n in (0, 1, 3):
    client = Client(n)
    assert authenticate(client, 'fixture', lambda: 'synthetic-code', lambda *_: 'profile') == 'profile'
    assert client.calls == ['login'] + ['mfa'] * n + ['dump']
client = Client(4)
try: authenticate(client, 'fixture', lambda: 'synthetic-code', lambda *_: 'profile')
except AuthFailure as exc: assert str(exc) == 'AUTH_MFA_LIMIT'
else: raise AssertionError('fourth MFA permitted')
assert client.calls == ['login'] + ['mfa'] * 3
class Failure(Client):
    def login(self, path): raise ValueError('synthetic-secret-canary')
try: authenticate(Failure(0), 'fixture', lambda: '', lambda *_: 'profile')
except AuthFailure as exc: assert str(exc) == 'AUTH_FAILED' and exc.__cause__ is None
else: raise AssertionError('exception accepted')
print('합성 MFA 순서와 고정 오류 검사 통과')

# Python 출력·logging에 합성 canary를 기록하려는 library를 버린다.
import logging
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
class Noisy(Client):
    def login(self, path):
        print('nonpattern-canary-418')
        print('nonpattern-canary-418',file=sys.stderr)
        logging.error('nonpattern-canary-418')
        return super().login(path)
out, err = StringIO(), StringIO()
with redirect_stdout(out), redirect_stderr(err):
    assert authenticate(Noisy(0),'fixture',lambda:'',lambda *_:'profile') == 'profile'
assert 'nonpattern-canary-418' not in out.getvalue()+err.getvalue()
print('합성 library 출력 폐기 검사 통과')

class WrongCodes(Client):
    def resume_login(self, state, code):
        self.calls.append('mfa')
        self.remaining -= 1
        if self.remaining: raise MfaRejected()
        return None,None
client=WrongCodes(3)
assert authenticate(client,'fixture',lambda:'synthetic-code',lambda *_:'profile') == 'profile'
assert client.calls == ['login','mfa','mfa','mfa','dump']
client=WrongCodes(4)
try: authenticate(client,'fixture',lambda:'synthetic-code',lambda *_:'profile')
except AuthFailure as exc: assert str(exc)=='AUTH_MFA_LIMIT'
else: raise AssertionError('fourth rejected MFA sent')
assert client.calls == ['login','mfa','mfa','mfa']
print('같은 객체 오답 최대 3회 검사 통과')
