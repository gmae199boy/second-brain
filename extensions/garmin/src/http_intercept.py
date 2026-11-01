"""고정된 라이브러리의 동기 전송 실험 경계. 검증 완료 전 배송 경로에 연결하지 않는다."""
from contextlib import contextmanager
from threading import Lock
from http_guard import GuardedTransport, TransportFailure

_lock = Lock()


@contextmanager
def intercept(admission, stage, endpoint, pacer=None, request_day=None, classify=None):
    """requests adapter 및 curl-cffi 동기 request를 관찰한다.

    단독 worker에서만 사용한다. 내부 retry와 curl 자동 redirect를 금지한다.
    다른 전송 경로를 차단하는 OS sandbox가 없으므로 이것만으로 보안 경계를
    주장할 수 없다. URL, header와 본문은 intent에 기록하지 않는다.
    """
    import requests.adapters
    import curl_cffi.requests
    if not _lock.acquire(blocking=False):
        raise TransportFailure('HTTP_INTERCEPT_BUSY')
    adapter = requests.adapters.HTTPAdapter
    curl = curl_cffi.requests.Session
    old_send, old_request = adapter.send, curl.request
    def send(self, request, *args, **kwargs):
        if self.max_retries.total not in (0, False):
            raise TransportFailure('HTTP_RETRY_FORBIDDEN')
        return GuardedTransport(admission, lambda _: old_send(self, request, *args, **kwargs), pacer, request_day, classify).send(stage, endpoint, None)
    def curl_request(self, method, url, *args, **kwargs):
        if self.retry.count != 0:
            raise TransportFailure('HTTP_RETRY_FORBIDDEN')
        if len(args) > 9:
            raise TransportFailure('HTTP_ARGUMENTS_UNSUPPORTED')
        kwargs['allow_redirects'] = False
        return GuardedTransport(admission, lambda _: old_request(self, method, url, *args, **kwargs), pacer, request_day, classify).send(stage, endpoint, None)
    try:
        adapter.send, curl.request = send, curl_request
        yield
    finally:
        adapter.send, curl.request = old_send, old_request
        _lock.release()
