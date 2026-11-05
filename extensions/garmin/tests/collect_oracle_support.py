"""Shared synthetic network script, not a source of expected results."""
import contextlib
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from garmin_pipeline import errors, garmin

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'fixtures/legacy/normalize_v8/input.json'
DAY = date(2026, 10, 15)
NOW = 1792281600000
TABLES = ('daily_metric', 'activity', 'body_battery_sample', 'hr_sample', 'stress_bb_sample',
          'activity_hr_sample', 'exercise_set', 'normalize_result', 'day_summary', 'workout', 'exercise_log')


def fixture():
    data = json.loads(FIXTURE.read_text(encoding='utf-8'))
    # Equal timestamps exercise the original readiness array's stable tie rule.
    item = next(item for item in data['items'] if item['endpoint'] == 'training_readiness' and item['key'] == DAY.isoformat())
    array = json.loads(item['raw'])
    array.append(dict(array[-1], score=39, level='LOW'))
    item['raw'] = json.dumps(array, ensure_ascii=False)
    lifestyle = next(item for item in data['items'] if item['endpoint'] == 'lifestyle_logging_data' and item['key'] == DAY.isoformat())
    tracked = json.loads((ROOT / 'tests/collect_lifestyle_pinned.json').read_text(encoding='utf-8'))
    tracked['calendarDate'] = DAY.isoformat()
    lifestyle['raw'] = json.dumps(tracked, ensure_ascii=False)
    empty = next(item for item in data['items'] if item['scope'] == 'day' and item['key'] == DAY.isoformat() and item['endpoint'] == 'daily_weigh_ins')
    empty['raw'] = 'null'
    listing = next(item for item in data['items'] if item['endpoint'] == 'activities_by_date')
    activities = json.loads(listing['raw']); activities[0]['totalSets'] = 2
    listing['raw'] = json.dumps(activities, ensure_ascii=False)
    return data


def cfg():
    return SimpleNamespace(timezone='Asia/Seoul', max_dates_per_run=10,
                           max_rejected_attempts=3, date_pause_seconds=5)


class FakeNetwork:
    def __init__(self, items, *, fail_after=None):
        self.values = {(i['scope'], i['key'], i['endpoint']): json.loads(i['raw']) for i in items}
        self.fail_after, self.requests, self.waits = fail_after, [], []
    def blocked_today(self): return None
    @contextlib.contextmanager
    def open_session(self, *, first_call_endpoints=()): yield self
    def _fetch(self, scope, key, endpoint):
        if self.fail_after is not None and len(self.requests) == self.fail_after:
            raise RuntimeError('synthetic interruption')
        self.requests.append([scope, key, endpoint])
        value = self.values.get((scope, key, endpoint))
        if value is None: raise errors.NoData('synthetic')
        return garmin.RawResponse(endpoint, value, 'synthetic')
    def fetch_day(self, endpoint, day): return self._fetch('day', day.isoformat(), endpoint)
    def fetch_activity(self, endpoint, activity_id): return self._fetch('activity', str(activity_id), endpoint)
    def sleep(self, seconds): self.waits.append(seconds)


def recheck_scenario(conn, snapshot):
    """Drive identical observations through each independently implemented collector."""
    from datetime import UTC, datetime, timedelta
    from unittest.mock import patch
    from garmin_pipeline import collect, dates

    first_items = fixture()['items']
    second_items = json.loads(json.dumps(first_items))
    listing = next(item for item in second_items if item['scope'] == 'day' and item['key'] == DAY.isoformat() and item['endpoint'] == 'activities_by_date')
    activities = json.loads(listing['raw'])
    activity_id = str(activities[0]['activityId'])
    activities[0]['totalSets'] = 3
    listing['raw'] = json.dumps(activities, ensure_ascii=False)
    second_items = [item for item in second_items if not (item['scope'] == 'day' and item['key'] == DAY.isoformat() and item['endpoint'] == 'user_summary')]
    # A nonempty next-day response makes the third run prove today's recheck too.
    second_items.append({'scope': 'day', 'key': (DAY + timedelta(days=1)).isoformat(), 'endpoint': 'user_summary', 'raw': json.dumps({'totalSteps': 100})})
    times = [datetime(2026, 10, 15, 12, tzinfo=UTC), datetime(2026, 10, 15, 15, 1, tzinfo=UTC), datetime(2026, 10, 15, 16, tzinfo=UTC)]
    output = {'steps': [], 'activity_id': activity_id}
    for moment, items in zip(times, (first_items, second_items, second_items), strict=True):
        network = FakeNetwork(items)
        with patch.object(dates, '_utc_now', return_value=moment), patch.object(dates, 'system_timezone', return_value='UTC'):
            local_today = dates.today(cfg())
            collect.run(conn, cfg(), network, network.sleep, today=local_today,
                        started_at=dates.now_ms(), manual=True, force=True)
            state = snapshot(conn, local_today, cfg())
        output['steps'].append({'today': local_today.isoformat(), 'requests': network.requests, **state})
    return output


def timezone_scenario(conn, snapshot, timezone):
    from datetime import UTC, datetime
    from unittest.mock import patch
    from garmin_pipeline import collect, dates
    local_cfg = cfg(); local_cfg.timezone = timezone
    moment = datetime(2026, 10, 15, 15, 30, tzinfo=UTC)
    network = FakeNetwork(fixture()['items'])
    with patch.object(dates, '_utc_now', return_value=moment), patch.object(dates, 'system_timezone', return_value='UTC'):
        today = dates.today(local_cfg)
        collect.run(conn, local_cfg, network, network.sleep, today=today,
                    started_at=dates.now_ms(), manual=True, force=True)
        return {'today': today.isoformat(), 'requests': network.requests, **snapshot(conn, today, local_cfg)}
