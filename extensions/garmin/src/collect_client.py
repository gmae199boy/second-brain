"""수집 client 경계와 운영 Garmin 세션."""
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Protocol

import garminconnect
from garmin_session import GarminAdapter, LIBRARY_VERSION, read_block

class CollectClient(Protocol):
    def fetch_day(self, endpoint, day): ...
    def fetch_activity(self, endpoint, activity_id): ...
    def next_date(self): ...

class SessionClient:
    library_version = LIBRARY_VERSION
    def __init__(self, session):
        self.session = session
        self.profile_id = getattr(getattr(session, 'client', None), 'profile_id', None)
    def configure_first(self, endpoints):
        self.session.first = frozenset(endpoints)
        self.session.attempts = dict.fromkeys(endpoints, 0)
    def fetch_day(self, endpoint, day):
        return self.session.fetch_day(endpoint, day)
    def fetch_activity(self, endpoint, activity_id):
        return self.session.fetch_activity(endpoint, activity_id)
    def next_date(self):
        self.session.next_date()


def adapter_for(tokenstore, zone, settings=None):
    kwargs = {}
    if settings is not None:
        kwargs = {name: settings['garmin.'+name] for name in ('date_pause_seconds','call_pause_min_seconds','call_pause_max_seconds','max_consecutive_403','lock_wait_seconds')}
        if settings['garmin.cffi_api_session']:
            def factory():
                from curl_cffi import requests
                client = garminconnect.Garmin()
                client.client._api_session = requests.Session(impersonate='chrome', discard_cookies=True)
                return client
            kwargs['client_factory'] = factory
    return GarminAdapter(tokenstore, today=lambda: datetime.now(ZoneInfo(zone)).date(), **kwargs)


def blocked_today(tokenstore, day):
    return read_block(Path(tokenstore).expanduser(), day)


@contextmanager
def open_client(tokenstore, zone, settings=None, first_call_endpoints=(), *, lock_held=False):
    adapter = adapter_for(tokenstore, zone, settings)
    kwargs = {}
    if first_call_endpoints: kwargs['first_call_endpoints'] = first_call_endpoints
    if lock_held: kwargs['lock_held'] = True
    session_context = adapter.open_session(**kwargs)
    with session_context as session:
        yield SessionClient(session)
