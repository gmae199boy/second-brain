"""백필 계획·기간 호출·재개와 차단 보호의 합성 수락 시험."""
import contextlib
import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
import backfill_runtime
from garmin_pipeline import backfill, backlog, collect, coverage, dates, errors, fetch_diagnostics, garmin, store
from collect_oracle_support import cfg, fixture, NOW

DAY = date(2026, 10, 15)


def item(day, endpoint='sleep_data', scope='day', key=None, state=coverage.CoverageState.MISSING):
    return coverage.CoverageItem(scope, key or day.isoformat(), endpoint, day.isoformat(), state, False, None, True, True)


class PlanTest(unittest.TestCase):
    def test_dry_plan_groups_only_adjacent_missing_dates_and_does_not_expose_activity_ids(self):
        items = [item(DAY + timedelta(days=n), 'activities_by_date') for n in (0, 1, 3)]
        items += [item(DAY, coverage.EXERCISE_SETS, 'activity', '123456')]
        plan = backfill.plan(items)
        self.assertEqual(plan['expected_calls_min'], 3)
        self.assertEqual(plan['remaining_dates'], 3)
        self.assertEqual(plan['remaining_activities'], 1)
        self.assertTrue(plan['additional_activity_details_unknown'])
        self.assertNotIn('123456', json.dumps(plan))
        self.assertEqual([len(g) for g in backfill.batches(items)], [2, 1, 1])

    def test_range_split_preserves_fields_and_rejects_unassignable_rows(self):
        days = [DAY.isoformat(), (DAY + timedelta(days=1)).isoformat()]
        row = {'startTimeLocal': days[0] + ' 10:00:00', 'activityId': 42, 'totalSets': 4}
        self.assertEqual(garmin.split_range('activities_by_date', [row], days, 'UTC'), {days[0]: [row], days[1]: None})
        weight = {'calendarDate': days[1], 'weight': 60000, 'timestampGMT': 1}
        split = garmin.split_range('daily_weigh_ins', {'dateWeightList': [weight], 'extra': {'preserved': True}}, days, 'UTC')
        self.assertEqual(split[days[1]]['extra'], {'preserved':True})
        self.assertEqual(split[days[1]]['dateWeightList'], [weight])
        self.assertIsNone(split[days[0]])
        with self.assertRaises(errors.InvalidResponse): garmin.split_range('body_battery', [{'date':'2020-01-01'}], days, 'UTC')
        with self.assertRaises(errors.InvalidResponse): garmin.split_range('daily_weigh_ins', {'dateWeightList':[{}]}, days, 'UTC')

    def test_weight_range_summaries_use_only_requested_daily_measurements(self):
        days = [DAY.isoformat(), (DAY + timedelta(days=1)).isoformat(), (DAY + timedelta(days=2)).isoformat()]
        metric = {'calendarDate': days[1], 'timestampGMT': NOW, 'weight': 60000, 'unknown': True}
        payload = {'dailyWeightSummaries': [
            {'summaryDate': days[1], 'numOfWeightEntries': 1, 'allWeightMetrics': [metric], 'latestWeight': metric},
            {'summaryDate': days[2], 'allWeightMetrics': []}],
            'previousDateWeight': {'calendarDate': '2000-01-01', 'weight': 90000},
            'nextDateWeight': {'calendarDate': '2099-01-01', 'weight': 90000},
            'totalAverage': {'weight': 90000}}
        self.assertEqual(garmin.split_range('daily_weigh_ins', payload, days, 'UTC'),
                         {days[0]: None, days[1]: {'dateWeightList': [metric]}, days[2]: None})
        self.assertEqual(garmin.split_range('daily_weigh_ins', {'dailyWeightSummaries': []}, days, 'UTC'), dict.fromkeys(days))

    def test_weight_shape_errors_are_rejected_without_echoing_input(self):
        for payload in ([], {}, {'dailyWeightSummaries': None}, {'dailyWeightSummaries': [None]},
                        {'dailyWeightSummaries': [{'summaryDate': DAY.isoformat(), 'allWeightMetrics': None}]},
                        {'dailyWeightSummaries': [{'summaryDate': 'SYNTHETIC_SECRET', 'allWeightMetrics': []}]},
                        {'dateWeightList': [{}]}, {'dateWeightList': [{'calendarDate': 12345}]},
                        {'dateWeightList': [{'calendarDate': '2000-01-01'}]},
                        {'dateWeightList': [{'timestampGMT': float('inf')}]},
                        {'dailyWeightSummaries': [{'summaryDate': DAY.isoformat(), 'allWeightMetrics': [
                            {'calendarDate': (DAY + timedelta(days=1)).isoformat()}]}]}):
            with self.subTest(payload=payload), self.assertRaises(errors.InvalidResponse) as caught:
                garmin.split_range('daily_weigh_ins', payload, [DAY.isoformat()], 'UTC')
            self.assertIsInstance(caught.exception, errors.Rejected)
            self.assertNotIsInstance(caught.exception, errors.Transient)
            self.assertNotIn('SYNTHETIC_SECRET', str(caught.exception))

    def test_timestamp_fallback_uses_configured_zone(self):
        stamp = '2026-10-14T16:00:00Z'
        metric = {'timestampGMT': stamp, 'weight': 60000}
        split = garmin.split_range('daily_weigh_ins', {'dailyWeightSummaries': [
            {'summaryDate': DAY.isoformat(), 'allWeightMetrics': [metric]}]}, [DAY.isoformat()], 'Asia/Seoul')
        self.assertEqual(split[DAY.isoformat()]['dateWeightList'], [metric])

    def test_diagnostics_project_only_fixed_causes_and_bound_messages(self):
        for error, expected in ((errors.Transient('token=SECRET weight=60000 ' * 100), ('transient', 'network_or_service_failure')),
                                (errors.Rejected('private health=60000'), ('rejected', 'request_failed')),
                                (errors.InvalidResponse('SECRET'), ('invalid_response', 'invalid_response')),
                                (errors.Transient('daily_weigh_ins: HTTP 503'), ('transient', 'http_503'))):
            code, reason = fetch_diagnostics.diagnostic(error, 'daily_weigh_ins')
            self.assertEqual((code, reason), expected)
            self.assertLessEqual(len('daily_weigh_ins: ' + reason), 240)
            events = []
            with fetch_diagnostics.progress_events(events.append):
                fetch_diagnostics.emit('daily_weigh_ins', code, reason)
            self.assertEqual(json.loads(events[0])['message'], f'garmin.fetch_error:daily_weigh_ins:{code}:{reason}')
            self.assertNotIn('SECRET', events[0])
            self.assertNotIn('60000', events[0])

    def test_abi_entry_emits_safe_fetch_progress_before_result(self):
        import backfill as entry
        import io
        from contextlib import redirect_stdout
        def run():
            fetch_diagnostics.emit('daily_weigh_ins', 'invalid_response', 'expected_daily_weight_summaries_list')
            return '{"status":"partial"}'
        output = io.StringIO()
        with patch.object(backfill_runtime, 'run', side_effect=run), redirect_stdout(output):
            self.assertEqual(entry.main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([e['type'] for e in events], ['progress', 'result'])
        self.assertEqual(events[0]['message'], 'garmin.fetch_error:daily_weigh_ins:invalid_response:expected_daily_weight_summaries_list')

    def test_oldest_slot_and_pending_counts(self):
        items = [item(DAY + timedelta(days=n)) for n in range(15)]
        with patch.object(collect.store, 'transaction', contextlib.nullcontext), patch.object(coverage, 'items', return_value=items):
            plan = collect._plan(None, cfg(), DAY, DAY + timedelta(days=14), lambda i:False, oldest_backlog=True)
        self.assertEqual(len(plan), 10)
        self.assertEqual(plan[0][0], DAY)
        self.assertEqual(plan[1][0], DAY + timedelta(days=14))
        self.assertEqual(backlog.summarize(items, DAY + timedelta(days=14))['remaining_endpoints'], 15)
        fresh = item(DAY, state=coverage.CoverageState.DATA)._replace(checked_at=NOW)
        self.assertEqual(backlog.summarize([fresh], DAY)['remaining_endpoints'], 0)
        self.assertEqual(backlog.summarize([fresh], DAY + timedelta(days=1))['remaining_endpoints'], 1)

    def test_input_is_validated_before_collection(self):
        for value in ({'dry_run':1}, {'start_date':'2026-02-30'}, {'endpoints':['unknown']}, {'endpoints':['sleep_data'] * 2}, {'force':True}):
            with self.subTest(value=value), self.assertRaises(backfill_runtime.InvalidCollectInput):
                backfill_runtime.validate_input(value)
        self.assertEqual(backfill_runtime.validate_input(None), {})

    def test_range_pages_keep_spacing_and_stop_on_rate_limit(self):
        from garminconnect import GarminConnectTooManyRequestsError
        with tempfile.TemporaryDirectory() as root:
            calls, waits = [], []
            class Client:
                garmin_connect_activities = '/synthetic'
                def connectapi(self, url, params):
                    calls.append(dict(params))
                    if len(calls) == 2: raise GarminConnectTooManyRequestsError('synthetic')
                    return [{'activityId':42}]
            config = SimpleNamespace(call_pause_min_seconds=1, call_pause_max_seconds=2, timezone='UTC', max_consecutive_403=3)
            session = garmin._Session(Client(), config, Path(root), waits.append)
            with self.assertRaises(errors.RateLimited): session.fetch_range('activities_by_date', DAY, DAY)
            with self.assertRaises(garmin.SessionBlocked): session.fetch_range('activities_by_date', DAY, DAY)
            self.assertEqual(len(calls), 2)
            self.assertEqual(len(waits), 2)
            self.assertTrue(all(1 <= wait <= 2 for wait in waits))
            self.assertTrue((Path(root) / 'block.json').is_file())


class Network:
    def __init__(self, *, values=None, ranges=None, fail_after=None, stop=None):
        self.values, self.ranges = values or {}, ranges or {}
        self.fail_after, self.stop = fail_after, stop
        self.requests, self.waits = [], []
    @contextlib.contextmanager
    def open_session(self, **kwargs): yield self
    def _record(self, request):
        if self.fail_after is not None and len(self.requests) == self.fail_after:
            raise self.stop if self.stop else RuntimeError('synthetic interruption')
        self.requests.append(request)
    def fetch_day(self, endpoint, day):
        self._record(('day', endpoint, day.isoformat()))
        payload = self.values.get((endpoint, day.isoformat()))
        if payload is None: raise errors.NoData('synthetic')
        return garmin.RawResponse(endpoint, payload, 'synthetic')
    def fetch_activity(self, endpoint, key):
        self._record(('activity', endpoint, str(key)))
        payload = self.values.get((endpoint, str(key)))
        if payload is None: raise errors.NoData('synthetic')
        return garmin.RawResponse(endpoint, payload, 'synthetic')
    def fetch_range(self, endpoint, start, end):
        self._record(('range', endpoint, start.isoformat(), end.isoformat()))
        payload = self.ranges.get(endpoint)
        if payload is None: raise errors.NoData('synthetic')
        return garmin.RawResponse(endpoint, payload, 'synthetic')


class BackfillPGTest(unittest.TestCase):
    @contextlib.contextmanager
    def database(self):
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
            user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            account, work, token = uuid4(), uuid4(), uuid4()
            owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'Asia/Seoul')", (user, account, 'synthetic-' + str(account)))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.backfill','extension',%s,now(),now(),'supervised',now(),now()+interval '1 hour','synthetic')", (work, str(account)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())', (token, work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s', (token, work))
            with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'], autocommit=True) as raw:
                conn = store.Connection(raw, store.AccountContext(user, account, work, token), readonly=False)
                self.assertTrue(store._try_lock(conn, 'write', transaction=False))
                yield conn

    def run_backfill(self, conn, network, end=DAY, **kwargs):
        with patch.object(dates, 'now_ms', return_value=NOW), patch.object(dates, 'today', return_value=end + timedelta(days=1)), patch.object(dates, 'system_timezone', return_value='Asia/Seoul'):
            return backfill.run(conn, cfg(), network, DAY, end, sleep=network.waits.append, **kwargs)

    def seed(self, conn, scope, key, endpoint, payload):
        store.upsert_raw(conn, scope=scope, key=key, endpoint=endpoint, payload=payload, library_version='synthetic', now_ms=NOW - 10000)

    def test_dry_run_no_session_or_writes_and_keeps_existing_data(self):
        with self.database() as conn:
            self.seed(conn, 'day', DAY.isoformat(), 'user_summary', {'totalSteps':100})
            network = Network()
            with patch.object(network, 'open_session', side_effect=AssertionError('network')):
                result = self.run_backfill(conn, network, dry_run=True, endpoints=['user_summary', 'sleep_data'])
            self.assertEqual(result['plan']['items'], [{'date':DAY.isoformat(),'endpoint':'sleep_data','count':1}])
            self.assertEqual(result['plan']['expected_calls_min'], 1)
            with store.transaction(conn):
                self.assertEqual(conn.execute('select count(*) from garmin.run where user_id=%s and connection_id=%s', (conn.user_id,conn.connection_id)).fetchone()[0], 0)

    def test_range_lists_discover_sets_and_normalize_without_recalling_existing(self):
        with self.database() as conn:
            day_items = fixture()['items']
            base = next(json.loads(i['raw']) for i in day_items if i['endpoint'] == 'activity')
            listing, values = [], {}
            for index in range(4):
                key = str(900 + index)
                listing.append({'activityId':int(key),'startTimeLocal':DAY.isoformat()+' 10:00:00','totalSets':1})
                self.seed(conn, 'activity', key, 'activity', base)
                values[(coverage.EXERCISE_SETS, key)] = {'exerciseSets':[{'setType':'ACTIVE','repetitionCount':5,'weight':-1,'duration':1000,'exercises':[]}]}
            network = Network(values=values, ranges={'activities_by_date':listing})
            result = self.run_backfill(conn, network, endpoints=['activities_by_date', 'activity', coverage.EXERCISE_SETS])
            self.assertEqual(result['received'], 4)
            self.assertEqual(result['remaining_endpoints'], 1)
            self.assertTrue(result['projection_complete'])
            self.assertEqual(len(network.requests), 4)
            self.assertTrue(all(row[1] != 'activity' for row in network.requests))
            with store.transaction(conn):
                rows = conn.execute('select reps from garmin.exercise_set where user_id=%s and connection_id=%s', (conn.user_id,conn.connection_id)).fetchall()
                self.assertEqual(rows, [(5,)] * 3)
                self.assertIsNotNone(conn.execute('select date from garmin.day_summary where user_id=%s and connection_id=%s and date=%s', (conn.user_id,conn.connection_id,DAY.isoformat())).fetchone())
            resumed = Network(values=values)
            result = self.run_backfill(conn, resumed, endpoints=['activities_by_date', 'activity', coverage.EXERCISE_SETS])
            self.assertEqual(resumed.requests, [('activity', coverage.EXERCISE_SETS, '903')])
            self.assertEqual(result['remaining_endpoints'], 0)
            again = Network()
            self.run_backfill(conn, again, endpoints=['activities_by_date', 'activity', coverage.EXERCISE_SETS])
            self.assertEqual(again.requests, [])

    def test_ranges_bundle_three_days_and_preserve_no_data_resume(self):
        with self.database() as conn:
            end = DAY + timedelta(days=2)
            original = {'dateWeightList':[{'calendarDate':DAY.isoformat(),'timestampGMT':NOW,'weight':60000}], 'unknownField': {'preserved':True}}
            network = Network(ranges={'daily_weigh_ins': original})
            result = self.run_backfill(conn, network, end, endpoints=['daily_weigh_ins','body_battery'])
            self.assertEqual(result['received'], 1)
            self.assertEqual(result['not_provided'], 5)
            self.assertEqual(result['remaining_endpoints'], 0)
            self.assertEqual(len(network.requests), 2)
            with store.transaction(conn):
                raw = conn.execute("select raw from garmin.raw_current where user_id=%s and connection_id=%s and endpoint like 'backfill_range.daily_weigh_ins.%%'", (conn.user_id, conn.connection_id)).fetchone()[0]
                self.assertEqual(json.loads(raw), original)
            resumed = Network()
            self.run_backfill(conn, resumed, end, endpoints=['daily_weigh_ins','body_battery'])
            self.assertEqual(resumed.requests, [])

    def test_failed_weight_ranges_remain_pending_then_resume_and_normalize(self):
        with self.database() as conn:
            end = DAY + timedelta(days=25)
            self.seed(conn, 'day', (DAY - timedelta(days=1)).isoformat(), 'daily_weigh_ins', {'dateWeightList': []})
            # 예전 버전과 같은 transient 26건을 만든 뒤 공식 run 경로로 재개한다.
            class TransientNetwork(Network):
                def fetch_range(self, endpoint, start, end):
                    raise errors.Transient('synthetic secret health=60000')
            failed = self.run_backfill(conn, TransientNetwork(), end, endpoints=['daily_weigh_ins'])
            self.assertEqual(failed['errors'], 26)
            self.assertEqual(failed['remaining_endpoints'], 26)
            with store.transaction(conn):
                pending = coverage.items(conn, cfg(), DAY, end)
                self.assertTrue(all(i.plannable for i in pending if i.endpoint == 'daily_weigh_ins'))
            # 매 기간마다 합성 측정을 첫날 하나 반환한다.
            class SummaryNetwork(Network):
                def fetch_range(self, endpoint, start, end):
                    self._record(('range', endpoint, start.isoformat(), end.isoformat()))
                    return garmin.RawResponse(endpoint, {'dailyWeightSummaries': [
                        {'summaryDate': start.isoformat(), 'allWeightMetrics': [
                            {'calendarDate': start.isoformat(), 'timestampGMT': NOW, 'weight': 60000}]}]}, 'synthetic')
            network = SummaryNetwork()
            result = self.run_backfill(conn, network, end, endpoints=['daily_weigh_ins'])
            self.assertEqual((result['received'], result['not_provided'], result['remaining_endpoints']), (4, 22, 0))
            self.assertTrue(result['projection_complete'])
            self.assertEqual(len(network.requests), 4)
            with store.transaction(conn):
                weights = conn.execute('select weight_kg from garmin.day_summary where user_id=%s and connection_id=%s and weight_kg is not null', (conn.user_id, conn.connection_id)).fetchall()
                self.assertEqual(weights, [(60.0,)] * 4)
            again = Network()
            self.run_backfill(conn, again, end, endpoints=['daily_weigh_ins'])
            self.assertEqual(again.requests, [])

    def test_shape_failure_records_safe_message_and_spends_rejected_budget(self):
        with self.database() as conn:
            events = []
            network = Network(ranges={'daily_weigh_ins': {'unexpected': 'SECRET weight=60000'}})
            with fetch_diagnostics.progress_events(events.append), self.assertLogs(collect.logger, level='WARNING') as logs:
                result = self.run_backfill(conn, network, endpoints=['daily_weigh_ins'])
            self.assertEqual(result['errors'], 1)
            with store.transaction(conn):
                row = conn.execute('select kind,error_code,message from garmin.fetch_error where user_id=%s and connection_id=%s', (conn.user_id, conn.connection_id)).fetchone()
            self.assertEqual(row, ('rejected', 'invalid_response', 'daily_weigh_ins: expected_daily_weight_summaries_list'))
            self.assertIn('expected_daily_weight_summaries_list', logs.output[0])
            self.assertIn('expected_daily_weight_summaries_list', events[0])
            self.assertNotIn('SECRET', ''.join(logs.output) + ''.join(events) + row[2])
            # 날짜별 rejected 상한에 이르면 자동 무한 재시도를 하지 않는다.
            for n in range(1, cfg().max_rejected_attempts):
                with patch.object(dates, 'today', return_value=DAY + timedelta(days=n + 1)):
                    backfill.run(conn, cfg(), network, DAY, DAY, endpoints=['daily_weigh_ins'], sleep=lambda _: None)
            with store.transaction(conn):
                remaining = [i for i in coverage.items(conn, cfg(), DAY, DAY) if i.endpoint == 'daily_weigh_ins']
            self.assertEqual(len(remaining), 1)
            self.assertFalse(remaining[0].plannable)
            before = len(network.requests)
            self.run_backfill(conn, network, endpoints=['daily_weigh_ins'])
            self.assertEqual(len(network.requests), before)

    def test_interruption_and_rate_limit_resume_only_remaining(self):
        for stop in (None, errors.RateLimited('synthetic')):
            with self.subTest(stop=type(stop).__name__), self.database() as conn:
                end = DAY + timedelta(days=2)
                network = Network(fail_after=1, stop=stop)
                if stop is None:
                    with self.assertRaisesRegex(RuntimeError, 'synthetic interruption'):
                        self.run_backfill(conn, network, end, endpoints=['user_summary'])
                else:
                    result = self.run_backfill(conn, network, end, endpoints=['user_summary'])
                    self.assertEqual(result['status'], 'rate_limited')
                    self.assertEqual(result['remaining_endpoints'], 2)
                self.assertEqual(len(network.requests), 1)
                resumed = Network()
                result = self.run_backfill(conn, resumed, end, endpoints=['user_summary'])
                self.assertEqual(result['remaining_endpoints'], 0)
                self.assertEqual(len(resumed.requests), 2)
                self.assertNotIn(network.requests[0], resumed.requests)

    def test_first_call_cap_is_visible_and_resume_advances(self):
        with self.database() as conn:
            end = DAY + timedelta(days=4)
            network = Network()
            result = self.run_backfill(conn, network, end, endpoints=['lifestyle_logging_data'])
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['deferred_first_call'], 2)
            self.assertEqual(result['not_provided'], 3)
            self.assertEqual(result['remaining_endpoints'], 2)
            self.assertEqual(len(network.requests), 3)
            resumed = Network()
            result = self.run_backfill(conn, resumed, end, endpoints=['lifestyle_logging_data'])
            self.assertEqual(result['remaining_endpoints'], 0)
            self.assertEqual(len(resumed.requests), 2)

    def test_backfill_status_is_separate_from_regular_provenance_and_normalize_errors(self):
        with self.database() as conn:
            result = self.run_backfill(conn, Network(), endpoints=['user_summary'])
            self.assertEqual(result['status'], 'success')
            with store.transaction(conn):
                self.assertEqual(coverage.day_status(conn, DAY + timedelta(days=1)).status, coverage.NOT_RUN)
            with patch.object(backfill.normalize, 'run', side_effect=RuntimeError('synthetic normalize')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic normalize'):
                    self.run_backfill(conn, Network(), endpoints=['user_summary'])
            with store.transaction(conn):
                state = conn.execute('select status,detail from garmin.run where user_id=%s and connection_id=%s order by id desc limit 1', (conn.user_id,conn.connection_id)).fetchone()
            self.assertEqual(state[0], 'error')
            self.assertIn('normalize_failed', state[1])

    def test_public_result_query_is_scoped_and_keeps_plan_visible(self):
        import query_backfill_status
        with self.database() as conn:
            result = self.run_backfill(conn, Network(), dry_run=True, endpoints=['sleep_data'])
            with store.transaction(conn):
                conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'backfill_latest',%s)", (conn.user_id,conn.connection_id,json.dumps(result)))
            envelope = {'abi':1,'user_id':str(conn.user_id),'settings':{},'input':{'connection_id':str(conn.connection_id)}}
            public = query_backfill_status.execute(os.environ['GARMIN_TEST_EXTENSION_DSN'], envelope)
            self.assertEqual(public['result']['plan']['items'], [{'date':DAY.isoformat(),'endpoint':'sleep_data','count':1}])
            envelope['input']['connection_id'] = str(uuid4())
            self.assertEqual(query_backfill_status.execute(os.environ['GARMIN_TEST_EXTENSION_DSN'], envelope), {'result':None})

    def test_supervised_dry_run_publishes_work_scoped_receipt_without_network(self):
        import query_backfill_status
        with self.database() as conn:
            data = {'dry_run':True,'start_date':DAY.isoformat(),'end_date':DAY.isoformat(),'endpoints':['sleep_data']}
            with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
                owner.execute('insert into brain.extension_work_inputs(work_id,input) values (%s,%s::jsonb)', (conn.account.work_id,json.dumps(data)))
            env = {'BRAIN_ABI_VERSION':'1','BRAIN_WORK_KIND':'garmin.backfill','BRAIN_TARGET_KIND':'extension',
                'BRAIN_TARGET_ID':str(conn.connection_id),'BRAIN_USER_ID':str(conn.user_id),
                'BRAIN_WORK_ID':str(conn.account.work_id),'BRAIN_ATTEMPT_TOKEN':str(conn.account.attempt_token),
                'BRAIN_RUN_GENERATION':'1','BRAIN_DATABASE_URL':os.environ['GARMIN_TEST_EXTENSION_DSN'],
                'BRAIN_EXTENSION_HOME':'/synthetic/extension',
                'BRAIN_SETTINGS_SNAPSHOT':json.dumps({'version':1,'extension':'garmin','user_id':str(conn.user_id),
                    'values':{'garmin.timezone':'Asia/Seoul','garmin.tokenstore':'/synthetic/tokenstore'}})}
            network = Network()
            with patch.object(store,'write_session', return_value=contextlib.nullcontext(conn)), patch.object(network,'open_session', side_effect=AssertionError('network')):
                result = json.loads(backfill_runtime.run(env, port_factory=lambda *args,**kwargs:network))
            self.assertEqual(result['status'], 'dry_run')
            envelope = {'abi':1,'user_id':str(conn.user_id),'settings':{},
                'input':{'connection_id':str(conn.connection_id),'work_id':str(conn.account.work_id)}}
            public = query_backfill_status.execute(os.environ['GARMIN_TEST_EXTENSION_DSN'], envelope)
            self.assertEqual(public['result'], result)
            with store.transaction(conn):
                self.assertEqual(conn.execute('select count(*) from garmin.raw_current where user_id=%s and connection_id=%s',(conn.user_id,conn.connection_id)).fetchone()[0], 0)
                self.assertEqual(conn.execute('select count(*) from garmin.run where user_id=%s and connection_id=%s',(conn.user_id,conn.connection_id)).fetchone()[0], 0)
            envelope['user_id'] = str(uuid4())
            self.assertEqual(query_backfill_status.execute(os.environ['GARMIN_TEST_EXTENSION_DSN'], envelope), {'result':None})

    def test_doctor_reads_safe_live_counts_without_garmin_access(self):
        import doctor_backlog
        with self.database() as conn:
            counts = doctor_backlog.inspect(os.environ['GARMIN_TEST_EXTENSION_DSN'])
            self.assertGreater(counts['remaining_endpoints'], 0)
            self.assertTrue(all(type(value) is int and value >= 0 for value in counts.values()))


class RegularPolicyTest(unittest.TestCase):
    def test_backlog_reentry_does_not_bypass_auth_or_rejected_partial(self):
        config = cfg()
        for status in (errors.RunStatus.AUTH_FAILED, errors.RunStatus.PARTIAL):
            with self.subTest(status=status), patch.object(collect, '_abandon_running'), patch.object(collect, '_enter', return_value=None), patch.object(store, 'transaction', contextlib.nullcontext), patch.object(coverage, 'day_status', return_value=coverage.DayStatus(status,'',NOW)), patch.object(collect,'_history_start') as history, patch.object(collect,'_plan') as planner:
                collect._collect_once(None, config, None, lambda _:None, today=DAY, started_at=NOW, force=False, manual=False, recent_lists=False, notifier=None, oldest_backlog=True)
                history.assert_not_called()
                planner.assert_not_called()

    def test_oldest_is_actually_called_before_first_call_cap_on_repeated_transients(self):
        config = cfg()
        network = Network()
        for length in (5, 10, 15):
            items = [item(DAY + timedelta(days=n), 'lifestyle_logging_data') for n in range(length)]
            for _ in range(2):
                with self.subTest(length=length), patch.object(store, 'transaction', contextlib.nullcontext), patch.object(coverage, 'items', return_value=items):
                    plan = collect._plan(None, config, DAY, DAY + timedelta(days=length-1), lambda i:False, oldest_backlog=True)
                calls = []
                def fail(conn, session, run_id, today, scope, key, endpoint):
                    calls.append(key)
                    return coverage.FetchErrorKind.TRANSIENT
                metrics = {}
                with patch.object(collect, '_fetch', side_effect=fail), patch.object(collect,'_pending_activities', return_value=[]):
                    failures = dict.fromkeys(coverage.FetchErrorKind, 0)
                    collect._collect_plan(None, config, network, lambda _:None, plan, 1, DAY, failures, lambda i:False, ('lifestyle_logging_data',), metrics=metrics)
                self.assertEqual(calls[0], DAY.isoformat())
                self.assertEqual(len(calls), 3)
                self.assertEqual(metrics['deferred_first_call'], min(length, 10) - 3)
