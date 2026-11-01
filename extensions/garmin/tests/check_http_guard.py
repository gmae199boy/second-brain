"""네트워크 없는 전송 순서 및 미확정 결과 시험."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from http_guard import GuardedTransport, TransportFailure

class Admission:
    def __init__(self): self.events, self.fail = [], ''
    def begin(self, stage, endpoint):
        self.events.append('intent')
        if self.fail == 'begin': raise RuntimeError('secret-canary')
        return 'id'
    def finish(self, intent, outcome):
        self.events.append('finish:' + outcome)
        if self.fail == 'finish': raise RuntimeError('secret-canary')
class Response:
    status_code = 429

def run(failure):
    a = Admission(); a.fail = failure
    def send(_):
        a.events.append('send')
        if failure == 'send': raise RuntimeError('secret-canary')
        return Response()
    try: GuardedTransport(a,send).send('data','summary',object())
    except TransportFailure as exc:
        assert str(exc) == {'begin':'HTTP_ADMISSION_FAILED','send':'HTTP_UNCERTAIN','finish':'HTTP_RESULT_UNCERTAIN'}[failure]
        assert exc.__cause__ is None
    else: assert not failure
    return a.events
assert run('') == ['intent','send','finish:429']
assert run('begin') == ['intent']
assert run('send') == ['intent','send']
assert run('finish') == ['intent','send','finish:429']
print('합성 전송 intent 및 미확정 결과 검사 통과')

# 두 전송 라이브러리의 메서드에 합성 구현을 넣어 실제 네트워크 없이 관찰한다.
from http_intercept import intercept
import requests
import requests.adapters
import curl_cffi.requests
old_send, old_request = requests.adapters.HTTPAdapter.send, curl_cffi.requests.Session.request
calls = []
def requests_fake(self, request, *args, **kwargs): calls.append('requests'); return Response()
def curl_fake(self, method, url, *args, **kwargs):
    assert kwargs['allow_redirects'] is False
    calls.append('curl'); return Response()
requests.adapters.HTTPAdapter.send, curl_cffi.requests.Session.request = requests_fake, curl_fake
try:
    admission = Admission()
    with intercept(admission,'data','summary'):
        assert requests.adapters.HTTPAdapter().send(None).status_code == 429
        assert curl_cffi.requests.Session().request('GET','https://fixture.invalid').status_code == 429
        for operation in (lambda: requests.adapters.HTTPAdapter(max_retries=2).send(None),
                          lambda: curl_cffi.requests.Session(retry=2).request('GET','https://fixture.invalid')):
            try: operation()
            except TransportFailure as exc: assert str(exc) == 'HTTP_RETRY_FORBIDDEN'
            else: raise AssertionError('retry accepted')
    assert calls == ['requests','curl']
    assert admission.events == ['intent','finish:429','intent','finish:429']
finally:
    requests.adapters.HTTPAdapter.send, curl_cffi.requests.Session.request = old_send, old_request
print('합성 requests 및 curl 전송 경계 검사 통과')

from http_guard import MonotonicPacer
ticks = [0.0]
sleeps = []
def sleeper(seconds):
    sleeps.append(seconds)
    ticks[0] += seconds
pacer = MonotonicPacer(lambda: ticks[0], sleeper)
with pacer.call('2026-01-01'): pass
with pacer.call('2026-01-01'): pass
with pacer.call('2026-01-02'): pass
assert sleeps == [1.0, 5.0]
print('합성 단조 시계 호출 간격 검사 통과')

# 잠긴 실제 library의 MFA fallback 경로도 합성 HTTP 429 이후 두 번째 전송을 막는다.
import garminconnect
class BlockOnRate(Admission):
    def __init__(self): super().__init__(); self.blocked = False
    def begin(self, stage, endpoint):
        if self.blocked: raise RuntimeError('blocked')
        return super().begin(stage,endpoint)
    def finish(self, intent, outcome):
        super().finish(intent,outcome)
        if outcome == '429': self.blocked = True
sent = []
def mfa_fake(self, request, *args, **kwargs):
    sent.append('send')
    response=requests.Response(); response.status_code=429
    response._content=b'{}'; response.request=request
    return response
original_send=requests.adapters.HTTPAdapter.send
requests.adapters.HTTPAdapter.send=mfa_fake
try:
    client=garminconnect.Garmin(email='synthetic',password='synthetic',return_on_mfa=True,retry_attempts=0,verify_login=False)
    client.client._mfa_flow='portal'
    client.client._mfa_session=requests.Session()
    client.client._mfa_login_params={}
    client.client._mfa_post_headers={}
    admission=BlockOnRate()
    with intercept(admission,'auth','mfa'):
        try: client.client._complete_mfa('synthetic')
        except Exception: pass
        else: raise AssertionError('MFA failure accepted')
    assert sent == ['send']
    assert admission.events == ['intent','finish:429']
finally:
    requests.adapters.HTTPAdapter.send=original_send
print('실제 library의 합성 MFA fallback 차단 검사 통과')

# library 내부 자동 refresh도 admission 실패 시 실제 전송 함수에 도달하지 않는다.
curl_sent=[]
def refresh_fake(self, method, url, *args, **kwargs):
    curl_sent.append('send')
    return Response()
original_curl=curl_cffi.requests.Session.request
curl_cffi.requests.Session.request=refresh_fake
try:
    client=garminconnect.Garmin(email='synthetic',password='synthetic',retry_attempts=0,verify_login=False)
    client.client.di_refresh_token='synthetic-refresh'
    client.client.di_client_id='synthetic-client'
    admission=Admission(); admission.fail='begin'
    with intercept(admission,'auth','refresh'):
        try: client.client._refresh_di_token()
        except Exception: pass
        else: raise AssertionError('refresh without admission accepted')
    assert curl_sent == [] and admission.events == ['intent']
finally:
    curl_cffi.requests.Session.request=original_curl
print('실제 library의 합성 refresh 선행 admission 검사 통과')

# 실제 library 한 논리 MFA operation이 여러 HTTP를 시도해도 probe 전송은 한 건이다.
class OneProbe(Admission):
    def __init__(self): super().__init__(); self.used=False
    def begin(self, stage, endpoint):
        if self.used: raise RuntimeError('probe already used')
        self.used=True
        return super().begin(stage,endpoint)
probe_sent=[]
def unsuccessful_probe(self, request, *args, **kwargs):
    probe_sent.append('send')
    response=requests.Response(); response.status_code=200
    response._content=b'{"responseStatus":{"type":"FAILURE"}}'; response.request=request
    return response
original_send=requests.adapters.HTTPAdapter.send
requests.adapters.HTTPAdapter.send=unsuccessful_probe
try:
    client=garminconnect.Garmin(email='synthetic',password='synthetic',return_on_mfa=True,retry_attempts=0,verify_login=False)
    client.client._mfa_flow='portal'; client.client._mfa_session=requests.Session()
    client.client._mfa_login_params={}; client.client._mfa_post_headers={}
    admission=OneProbe()
    with intercept(admission,'probe','fixture'):
        try: client.client._complete_mfa('synthetic')
        except Exception: pass
        else: raise AssertionError('synthetic MFA failure accepted')
    assert probe_sent == ['send']
finally:
    requests.adapters.HTTPAdapter.send=original_send
print('실제 library 합성 operation의 probe HTTP 한 건 검사 통과')
