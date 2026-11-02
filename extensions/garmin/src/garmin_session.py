"""Garmin session locking, pacing and legacy daily call protection."""
import contextlib
from dataclasses import dataclass
from datetime import date, datetime
import fcntl
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import random
import re
import tempfile
import time

import garminconnect

LIBRARY_VERSION = importlib.metadata.version('garminconnect')
DAY_ENDPOINTS = ('sleep_data', 'hrv_data', 'rhr_day', 'heart_rates', 'stress_data', 'body_battery', 'user_summary', 'training_readiness', 'daily_weigh_ins', 'lifestyle_logging_data', 'activities_by_date')
ACTIVITY_ENDPOINTS = ('activity', 'activity_details', 'activity_hr_in_timezones', 'activity_exercise_sets')
FIRST_CALL_ENDPOINTS = frozenset(('activity_exercise_sets', 'daily_weigh_ins', 'lifestyle_logging_data'))


class GarminError(Exception):
    def __init__(self, code, retryable=False):
        self.code, self.retryable = code, retryable
        super().__init__(code)


@dataclass(frozen=True)
class RawResponse:
    endpoint: str
    payload: object
    library_version: str = LIBRARY_VERSION


def _chain(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        yield error
        error = error.__cause__ if error.__cause__ is not None else error.__context__


def silence_library_logging():
    logger = logging.getLogger('garminconnect')
    logger.handlers = [logging.NullHandler()]
    logger.propagate = False


def _status(error):
    for error in _chain(error):
        code = getattr(getattr(error, 'response', None), 'status_code', None)
        if type(code) is int:
            return code
        if isinstance(error, garminconnect.GarminConnectTooManyRequestsError):
            return 429
        if any(c.__module__.partition('.')[0] == 'garminconnect' for c in type(error).__mro__):
            match = re.search(r'(?:API Error|Error|HTTP)\s*(\d{3})', str(error))
            if match:
                return int(match[1])
    return None


def _classifiable(error):
    return isinstance(error, OSError) or any(c.__module__.partition('.')[0] == 'garminconnect' for c in type(error).__mro__)


def classify(error, login=False):
    status = _status(error)
    if status == 429:
        return status, GarminError('RATE_LIMITED')
    if login:
        if status == 403:
            return status, GarminError('BLOCKED_403')
        if status is not None and 500 <= status <= 599 or status is None and any(isinstance(link, OSError) for link in _chain(error)):
            return status, GarminError('GARMIN_TRANSIENT', True)
        return status, GarminError('LOGIN_REQUIRED')
    if status == 401:
        return status, GarminError('LOGIN_REQUIRED')
    if status == 404:
        return status, GarminError('GARMIN_NO_DATA')
    if status is not None and 400 <= status <= 499:
        return status, GarminError('GARMIN_REJECTED')
    return status, GarminError('GARMIN_TRANSIENT', True)


def read_block(tokenstore, today):
    try:
        raw = (tokenstore / 'block.json').read_bytes()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        raise GarminError('BLOCK_FILE_INVALID') from None
    try:
        obj = json.loads(raw.decode('utf-8'))
        if not isinstance(obj, dict) or set(obj) != {'schema_version', 'local_date', 'reason'} or type(obj['schema_version']) is not int or obj['schema_version'] != 1 or not isinstance(obj['local_date'], str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', obj['local_date']) or date.fromisoformat(obj['local_date']).isoformat() != obj['local_date'] or obj['reason'] not in ('rate_limited', 'blocked_403'):
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        raise GarminError('BLOCK_FILE_INVALID') from None
    return obj['reason'] if obj['local_date'] == today.isoformat() else None


def write_block(tokenstore, today, reason):
    fd, name = tempfile.mkstemp(prefix='.block.', suffix='.tmp', dir=tokenstore)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump({'schema_version': 1, 'local_date': today.isoformat(), 'reason': reason}, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, tokenstore / 'block.json')
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)
        raise


@contextlib.contextmanager
def session_lock(tokenstore, wait_seconds=60, *, monotonic=time.monotonic, sleep=time.sleep):
    fd = os.open(tokenstore / '.session.lock', os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
    try:
        deadline = monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise GarminError('SESSION_LOCK_TIMEOUT', True) from None
                sleep(min(0.1, remaining))
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


class GarminAdapter:
    def __init__(self, tokenstore, *, client_factory=garminconnect.Garmin, today=date.today, sleep=time.sleep, uniform=random.uniform, monotonic=time.monotonic, lock_wait_seconds=60):
        self.tokenstore = Path(tokenstore).expanduser()
        self.client_factory, self.today, self.sleep, self.uniform = client_factory, today, sleep, uniform
        self.monotonic, self.lock_wait_seconds = monotonic, lock_wait_seconds

    def blocked_today(self):
        return read_block(self.tokenstore, self.today())

    def record_block(self, reason):
        try:
            write_block(self.tokenstore, self.today(), reason)
        except OSError:
            pass

    def login_step(self, call):
        try:
            return call()
        except Exception as error:
            if not _classifiable(error):
                raise
            _, mapped = classify(error, login=True)
        if mapped.code in ('RATE_LIMITED', 'BLOCKED_403'):
            self.record_block(mapped.code.lower())
        raise mapped from None

    @contextlib.contextmanager
    def open_session(self, *, first_call_endpoints=()):
        first = frozenset(first_call_endpoints)
        if first - set(DAY_ENDPOINTS + ACTIVITY_ENDPOINTS):
            raise ValueError('invalid endpoint')
        if not self.tokenstore.is_dir():
            raise GarminError('LOGIN_REQUIRED')
        with session_lock(self.tokenstore, self.lock_wait_seconds, monotonic=self.monotonic, sleep=self.sleep):
            if self.blocked_today():
                raise GarminError('SESSION_BLOCKED')
            client = self.client_factory()
            self.login_step(lambda: client.login(str(self.tokenstore)))
            yield Session(self, client, first)


class Session:
    def __init__(self, adapter, client, first):
        self.adapter, self.client, self.first = adapter, client, first
        self.consecutive_403 = 0
        self.blocked = False
        self.attempts = dict.fromkeys(first, 0)

    def next_date(self):
        self.adapter.sleep(5)

    def fetch_day(self, endpoint, day):
        if endpoint not in DAY_ENDPOINTS or not isinstance(day, date) or isinstance(day, datetime):
            raise ValueError('invalid endpoint or date')
        day = day.isoformat()
        if endpoint in ('user_summary', 'heart_rates'):
            base = getattr(self.client, 'garmin_connect_daily_summary_url' if endpoint == 'user_summary' else 'garmin_connect_heartrates_daily_url')
            call = lambda: self.client.connectapi(f'{base}/{self.client._require_display_name()}', params={('calendarDate' if endpoint == 'user_summary' else 'date'): day})
        elif endpoint in ('body_battery', 'activities_by_date'):
            call = lambda: getattr(self.client, 'get_' + endpoint)(day, day)
        else:
            call = lambda: getattr(self.client, 'get_' + endpoint)(day)
        return self._fetch(endpoint, call)

    def fetch_activity(self, endpoint, activity_id):
        if endpoint not in ACTIVITY_ENDPOINTS:
            raise ValueError('invalid endpoint')
        return self._fetch(endpoint, lambda: getattr(self.client, 'get_' + endpoint)(activity_id))

    def _fetch(self, endpoint, call):
        if self.blocked:
            raise GarminError('SESSION_BLOCKED')
        if endpoint in self.attempts:
            if self.attempts[endpoint] >= 3:
                return None
            self.attempts[endpoint] += 1
        self.adapter.sleep(self.adapter.uniform(1, 2))
        status = None
        try:
            payload = call()
        except Exception as error:
            if not _classifiable(error):
                raise
            status, mapped = classify(error)
        else:
            if endpoint == 'user_summary' and isinstance(payload, dict) and payload.get('privacyProtected') is True:
                mapped = GarminError('LOGIN_REQUIRED')
            elif payload is None or isinstance(payload, (list, dict)) and not payload:
                mapped = GarminError('GARMIN_NO_DATA')
            else:
                mapped = None
        if status == 403 and endpoint in self.first:
            pass
        elif status == 403:
            self.consecutive_403 += 1
            if self.consecutive_403 >= 3:
                mapped = GarminError('BLOCKED_403')
        else:
            self.consecutive_403 = 0
        if mapped is None:
            return RawResponse(endpoint, payload)
        if mapped.code in ('BLOCKED_403', 'RATE_LIMITED'):
            self.blocked = True
            self.adapter.record_block(mapped.code.lower())
        raise mapped from None
