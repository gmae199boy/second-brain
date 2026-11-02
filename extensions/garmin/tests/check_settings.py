"""설정 snapshot과 세션 설정을 네트워크 없이 검증한다."""
import json
from datetime import date
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from collect_settings import decode
from garmin_session import GarminAdapter, GarminError


def snapshot(values):
    return json.dumps({'version': 1, 'extension': 'garmin', 'values': values})


def invalid(values):
    try:
        decode(snapshot({'garmin.timezone': 'UTC', **values}), require_timezone=True)
    except ValueError:
        return
    raise AssertionError(values)


for values in ({'garmin.unknown': 1}, {'garmin.date_pause_seconds': True},
               {'garmin.cffi_api_session': 1}, {'garmin.date_pause_seconds': float('nan')},
               {'garmin.call_pause_min_seconds': 3, 'garmin.call_pause_max_seconds': 2},
               {'garmin.max_dates_per_run': 2}, {'garmin.max_dates_per_run': 3.5},
               {'garmin.max_rejected_attempts': 0}, {'garmin.max_consecutive_403': 0},
               {'garmin.lock_wait_seconds': -1}):
    invalid(values)
manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
assert all(isinstance(entry['default'], str) for entry in manifest['settings'] if 'default' in entry)
defaults = decode(snapshot({}))
assert type(defaults['garmin.date_pause_seconds']) is float and defaults['garmin.date_pause_seconds'] == 5
assert type(defaults['garmin.cffi_api_session']) is bool and defaults['garmin.cffi_api_session'] is False
values = decode(snapshot({'garmin.timezone': 'UTC', 'garmin.cffi_api_session': True}), require_timezone=True)
assert values['garmin.max_dates_per_run'] == 10 and values['garmin.cffi_api_session'] is True

class FakeError(OSError):
    response = type('Response', (), {'status_code': 403})()

class Fake:
    def login(self, tokenstore): pass
    def get_sleep_data(self, day): raise FakeError()

with tempfile.TemporaryDirectory() as path:
    waits, bounds = [], []
    def uniform(a, b):
        bounds.append((a, b))
        return a
    adapter = GarminAdapter(path, client_factory=Fake, today=lambda: date(2026, 1, 1),
                            sleep=waits.append, uniform=uniform, date_pause_seconds=7,
                            call_pause_min_seconds=0.25, call_pause_max_seconds=0.5,
                            max_consecutive_403=2, lock_wait_seconds=4)
    with adapter.open_session() as session:
        for code in ('GARMIN_REJECTED', 'BLOCKED_403'):
            try:
                session.fetch_day('sleep_data', date(2026, 1, 1))
            except GarminError as error:
                assert error.code == code
            else:
                raise AssertionError(code)
        session.next_date()
    assert waits == [0.25, 0.25, 7] and bounds == [(0.25, 0.5)] * 2
    assert adapter.lock_wait_seconds == 4
print('check_settings: all checks passed')
