"""합성 전송 seam. 모든 라이브러리 전송의 연결을 검증하기 전에는 배송 경로에서 사용하지 않는다."""


class TransportFailure(Exception):
    pass


class GuardedTransport:
    def __init__(self, admission, transmit, pacer=None, request_day=None, classify=None):
        # admission은 독립 durable supervisor admission과 pacing을 확인하고
        # 각 send 전에 intent를 commit해야 한다. 미구현이면 객체를 만들지 않는다.
        self._admission = admission
        self._transmit = transmit
        self._pacer, self._request_day, self._classify = pacer, request_day, classify

    def send(self, stage, endpoint, request):
        if self._pacer is not None:
            with self._pacer.call(self._request_day):
                return self._send(stage, endpoint, request)
        return self._send(stage, endpoint, request)

    def _send(self, stage, endpoint, request):
        try:
            intent = self._admission.begin(stage, endpoint)
        except Exception:
            raise TransportFailure('HTTP_ADMISSION_FAILED') from None
        if intent is None:
            raise TransportFailure('HTTP_ADMISSION_FAILED')
        try:
            response = self._transmit(request)
        except Exception:
            # 전송 여부를 알 수 없으므로 결과를 추정하여 기록하지 않는다.
            raise TransportFailure('HTTP_UNCERTAIN') from None
        status = getattr(response, 'status_code', None)
        if type(status) is not int or status < 100 or status > 599:
            raise TransportFailure('HTTP_UNCERTAIN')
        outcome = '429' if status == 429 else '403' if status == 403 else 'other'
        if 200 <= status < 300 and self._classify is not None:
            try: outcome = self._classify(response)
            except Exception: raise TransportFailure('HTTP_UNCERTAIN') from None
            if outcome not in ('success','other'): raise TransportFailure('HTTP_UNCERTAIN')
        try:
            self._admission.finish(intent, outcome)
        except Exception:
            # 결과 commit이 실패하거나 불명이면 pending을 남긴다.
            raise TransportFailure('HTTP_RESULT_UNCERTAIN') from None
        return response


class ProtectionAdmission:
    """현재 attempt와 supervisor admission을 DB 내부 함수로 강제한다."""
    def __init__(self, conn, target, binding_generation, work_id, attempt_token,
                 run_generation, clock, validate, request_day=None, first_call=False, zone='UTC'):
        self._conn, self._target, self._generation = conn, target, binding_generation
        self._work, self._attempt, self._run = work_id, attempt_token, run_generation
        self._request_day, self._first_call, self._zone = request_day, first_call, zone
        self._validate = validate

    def begin(self, stage, endpoint):
        from protection import _tx
        with _tx(self._conn,self._validate):
            return self._conn.execute('select garmin.start_external_call(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (self._work,self._attempt,self._run,self._target,self._generation,stage,endpoint,self._zone,self._request_day,self._first_call)).fetchone()[0]

    def finish(self, intent, outcome):
        from protection import _tx, ProtectionError
        with _tx(self._conn,self._validate):
            result=self._conn.execute('select garmin.finish_external_call(%s,%s,%s,%s,%s,%s,%s)',
                (self._work,self._attempt,self._run,self._target,self._generation,intent,outcome)).fetchone()
            if not result or result[0] is not True: raise ProtectionError('PROTECTION_INVALID_INTENT')


class MonotonicPacer:
    """한 프로세스에서 완료 뒤 최소 간격을 유지한다. DB 검사를 대체하지 않는다."""
    def __init__(self, monotonic, sleep):
        from threading import Lock
        self._monotonic, self._sleep, self._lock = monotonic, sleep, Lock()
        self._finished, self._day = None, None

    def call(self, day):
        from contextlib import contextmanager
        @contextmanager
        def scope():
            with self._lock:
                if self._finished is not None:
                    interval = 5 if day is not None and self._day is not None and day != self._day else 1
                    delay = self._finished + interval - self._monotonic()
                    if delay > 0:
                        self._sleep(delay)
                    if self._monotonic() < self._finished + interval:
                        raise TransportFailure('HTTP_CLOCK_UNCERTAIN')
                try:
                    yield
                finally:
                    self._finished, self._day = self._monotonic(), day
        return scope()
