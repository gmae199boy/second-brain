"""수집 client 경계와 운영 Garmin 세션."""
from contextlib import contextmanager
from datetime import date, datetime
from zoneinfo import ZoneInfo
from typing import Protocol

from garmin_session import GarminAdapter, GarminError, LIBRARY_VERSION


class CollectClient(Protocol):
    def user_summary(self, day: str) -> object: ...


class SessionClient:
    library_version = LIBRARY_VERSION

    def __init__(self, session):
        self.session = session

    def user_summary(self, day):
        try:
            return self.session.fetch_day('user_summary', date.fromisoformat(day)).payload
        except GarminError as error:
            if error.code == 'GARMIN_NO_DATA':
                return None
            raise


@contextmanager
def open_client(tokenstore, zone):
    with GarminAdapter(tokenstore, today=lambda: datetime.now(ZoneInfo(zone)).date()).open_session() as session:
        yield SessionClient(session)
