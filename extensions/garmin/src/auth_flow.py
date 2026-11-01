"""동일 객체 MFA 순서 계산. 보안 bootstrap/HTTP gate가 생기기 전 worker에서 사용하지 않는다."""
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import logging


class _Discard:
    def write(self, value): return len(value)
    def flush(self): pass


@contextmanager
def _quiet_library():
    # 단독 worker에 한정된다. raw fd/native 출력은 이 조치로 차단되지 않는다.
    previous = logging.root.manager.disable
    logging.disable(2**31-1)
    try:
        with redirect_stdout(_Discard()), redirect_stderr(_Discard()):
            yield
    finally:
        logging.disable(previous)


class AuthFailure(Exception):
    pass


class MfaRejected(Exception):
    """검증된 adapter가 오답으로 확정한 경우만 사용한다."""
    pass


def authenticate(client, tokenstore, next_code, verify_identity_and_permissions):
    """주입된 client 한 개로 login/resume/dump를 수행한다.

    호출자는 각 내부 HTTP의 사전 intent 및 검증된 비밀 채널을 보장해야 한다.
    이 함수 자체는 그 보안 보장을 제공하지 않는다.
    """
    try:
        with _quiet_library():
            status, state = client.login(tokenstore)
        attempts = 0
        while status == 'needs_mfa':
            if attempts >= 3:
                raise AuthFailure('AUTH_MFA_LIMIT')
            code = next_code()
            if not isinstance(code, str) or not code:
                raise AuthFailure('AUTH_CANCELLED')
            attempts += 1
            try:
                with _quiet_library():
                    status, state = client.resume_login(state, code)
            except MfaRejected:
                status = 'needs_mfa'
            finally:
                code = None
        if status is not None:
            raise AuthFailure('AUTH_FAILED')
        with _quiet_library():
            profile = verify_identity_and_permissions(client, tokenstore)
        if not isinstance(profile, str) or not profile:
            raise AuthFailure('AUTH_IDENTITY_UNVERIFIED')
        with _quiet_library():
            client.client.dump(tokenstore)
            verified_profile = verify_identity_and_permissions(client, tokenstore)
        # dump 뒤 권한 검증이 성공하지 않으면 성공을 알리지 않는다.
        if verified_profile != profile:
            raise AuthFailure('AUTH_IDENTITY_UNVERIFIED')
        return profile
    except AuthFailure as exc:
        if str(exc) in ('AUTH_MFA_LIMIT', 'AUTH_CANCELLED', 'AUTH_FAILED', 'AUTH_IDENTITY_UNVERIFIED'):
            raise AuthFailure(str(exc)) from None
        raise AuthFailure('AUTH_FAILED') from None
    except Exception:
        # 라이브러리 예외 및 세션 상태는 외부로 노출하지 않는다.
        raise AuthFailure('AUTH_FAILED') from None
