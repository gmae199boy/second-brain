"""수집 클라이언트 경계. 실제 인증 어댑터는 후속 작업에서 제공한다."""
from typing import Protocol


class CollectClient(Protocol):
    def user_summary(self, day: str) -> object: ...


class UnavailableClient:
    def user_summary(self, day: str) -> object:
        raise ValueError('COLLECT_CLIENT_UNAVAILABLE')
