"""Account-scoped report input contracts; all data here is synthetic."""
import json
import tempfile
import unittest
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from psycopg.rows import dict_row
from garmin_pipeline import report_input

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')


class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def __iter__(self): return iter(self.rows)


class FakeConnection:
    user_id = USER
    connection_id = CONNECTION
    def __init__(self): self.calls, self.closed = [], False
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if 'COUNT(*)' in sql: return Result([(1,)])
        if 'MIN(key' in sql: return Result([('2026-01-01',)])
        if 'FROM garmin.run' in sql: return Result([])
        if 'FROM garmin.evaluation' in sql:
            return Result([('2026-01-01', 'day', 'synthetic', '[]', '[]', '[]')])
        return Result([])
    def cursor(self, *, row_factory):
        assert row_factory is dict_row
        return DictCursor(self)
    def close(self): self.closed = True


class DictCursor:
    def __init__(self, conn): self.conn = conn
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def execute(self, sql, params):
        self.conn.calls.append((sql, params))
        self.sql = sql
    def fetchall(self):
        if 'FROM garmin.day_summary' in self.sql and 'AVG(' not in self.sql:
            return [{c: ('2026-01-01' if c == 'date' else None) for c in report_input._DAY_COLUMNS}]
        return []


class ReportInputPGTest(unittest.TestCase):
    def assert_scoped(self, conn):
        self.assertTrue(conn.closed)
        for sql, args in conn.calls:
            self.assertEqual(args[:2], (USER, CONNECTION), sql)
            self.assertNotIn('?', sql)
            self.assertNotIn('SELECT *', sql.upper())
            self.assertNotIn('BEGIN', sql.upper())

    def test_daily_snapshot_uses_scoped_tuple_reads(self):
        conn = FakeConnection()
        cfg = SimpleNamespace(timezone='UTC', collect_time=time(7))
        with patch.object(report_input.store, 'read_connection', return_value=conn):
            result = report_input._snapshot(cfg, date(2026, 1, 2), 1000, [])
        self.assertEqual(result[6], date(2026, 1, 1))
        self.assert_scoped(conn)

    def test_previous_evaluations_decode_json_and_use_separate_snapshot(self):
        conn = FakeConnection()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(report_input.store, 'read_connection', return_value=conn):
                report_input._previous_evaluations(None, Path(tmp), date(2026, 1, 1), [])
            value = json.loads((Path(tmp) / 'previous_evaluations/day.json').read_text())
        self.assertEqual(value['judgments'], [])
        self.assertEqual(value['summary'], 'synthetic')
        self.assert_scoped(conn)

    def test_each_period_scopes_joins_and_only_emits_legacy_columns(self):
        for scope in ('7d', '30d', 'all'):
            conn = FakeConnection()
            with self.subTest(scope=scope), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                manifest = {'period_windows': {scope: {'from': '2026-01-01', 'to': '2026-01-02'}},
                            'months': ['2026-01'], 'data_cutoff': '2026-01-02T00:00:00+00:00'}
                (folder / 'manifest.json').write_text(json.dumps(manifest))
                with patch.object(report_input.store, 'read_connection', return_value=conn):
                    target = report_input.build_period(None, folder, date(2026, 1, 2), scope)
                values = json.loads((target / 'day_values.json').read_text())
                if scope != 'all':
                    self.assertEqual(list(values['day_summary'][0]), list(report_input._DAY_COLUMNS))
                    self.assertNotIn('user_id', values['day_summary'][0])
                    self.assertIsNone(values['day_summary'][0]['sleep_total_s'])
                else:
                    month_sql = next(sql for sql, _ in conn.calls if 'AVG(' in sql)
                    self.assertNotIn('AVG(user_id)', month_sql)
                    self.assertNotIn('AVG(connection_id)', month_sql)
                    subquery = next(sql for sql, _ in conn.calls if 'SELECT MAX(m.report_date' in sql)
                    self.assertIn('m.user_id=e.user_id', subquery)
                    self.assertIn('m.connection_id=e.connection_id', subquery)
                join = next(sql for sql, _ in conn.calls if 'JOIN garmin.workout' in sql)
                self.assertIn('w.user_id=e.user_id', join)
                self.assertIn('w.connection_id=e.connection_id', join)
                self.assert_scoped(conn)

class SQLiteCutoffArithmeticIntegrationTest(unittest.TestCase):
    """Independent SQLite expressions versus installed PG; deferred to 21.8."""
    def test_integer_and_real_overflow_boundaries_match_sqlite(self):
        import os
        import sqlite3
        import psycopg

        # The cancellation case rounds the product to 2**63 and the start to
        # -2**63 + 1767355199488 in binary64; their sum is 1767355199488.
        cancellation_start = -9223370269499575908
        cancellation_duration = 9223372036854776
        cases = [
            ('exact-integer-equal', 9007199254740993, 0, 9007199254740993, False),
            ('exact-integer-below', 9007199254740992, 0, 9007199254740993, True),
            ('integer-product-boundary', -9223372036854775808, 9223372036854775, -800, True),
            ('positive-product-overflow-cancellation', cancellation_start, cancellation_duration, 1767355200000, True),
            ('real-versus-inexact-integer-cutoff', -9214364837600034816, 9223372036854776, 9007199254740993, True),
            ('real-equal-cutoff', cancellation_start, cancellation_duration, 1767355199488, False),
            ('real-just-below-cutoff', cancellation_start, cancellation_duration, 1767355199489, True),
            ('real-above-cutoff', cancellation_start, cancellation_duration, 1767355199487, False),
            ('negative-product-overflow', 0, -9223372036854776, -9223372036854775808, False),
            ('positive-add-overflow', 9223372036854775807, 1, 9223372036854775807, False),
            ('negative-add-overflow', -9223372036854775808, -1, -9223372036854775808, False),
            ('negative-add-overflow-outside', -9223372036854775808, -2, -9223372036854775808, True),
            ('negative-integer', -1001, 1, 0, True),
            ('null-start', None, 1, 0, None),
            ('null-duration', 0, None, 0, None),
            ('null-cutoff', 0, 1, None, None),
        ]
        with sqlite3.connect(':memory:') as sqlite, psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as pg:
            for label, start, duration, cutoff, expected in cases:
                with self.subTest(label=label):
                    sqlite_result = sqlite.execute('select ? + ? * 1000 < ?', (start,duration,cutoff)).fetchone()[0]
                    pg_result = pg.execute('select garmin.activity_ends_before_cutoff(%s::bigint,%s::bigint,%s::bigint)', (start,duration,cutoff)).fetchone()[0]
                    self.assertEqual(None if sqlite_result is None else bool(sqlite_result), expected)
                    self.assertEqual(pg_result, expected)

class ReportInputIndependentOracleIntegrationTest(unittest.TestCase):
    """Pinned SQLite child and account-scoped PG consume the same fixed fixture."""
    def test_one_work_records_and_resumes_revisions_on_two_dates(self):
        import os
        from uuid import uuid4
        import psycopg
        from garmin_pipeline import report, store
        from report_runtime import envelope
        from test_report_runtime import report_env
        user, account, work, token = None, uuid4(), uuid4(), uuid4()
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
            user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,%s)', (user,account,'work-dates-'+str(account),'UTC'))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.report','extension',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')", (work,str(account)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())', (token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s', (token,work))
            for day in ('2026-01-01','2026-01-02'):
                owner.execute("insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values (%s,%s,%s,'day','synthetic','[]','[]','[]','synthetic','fake',1,1)", (user,account,day))
        _, cfg = envelope(report_env())
        with patch.dict(os.environ, {'BRAIN_DATABASE_URL':os.environ['GARMIN_TEST_EXTENSION_DSN'],'BRAIN_USER_ID':str(user),'BRAIN_WORK_ID':str(work),'BRAIN_ATTEMPT_TOKEN':str(token)}), store.supervised_account(store.AccountContext(user,account,work,token)):
            for day in (date(2026,1,1),date(2026,1,2),date(2026,1,1),date(2026,1,2)):
                self.assertEqual(report._work_revisions(cfg,day,False), {'day':1})
                self.assertEqual(report._read_work_revisions(cfg,day), {'day':1})
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN']) as owner:
            self.assertEqual(owner.execute('select report_date,scope,revision from garmin.report_work_revisions where work_id=%s order by report_date', (work,)).fetchall(), [('2026-01-01','day',1),('2026-01-02','day',1)])

    def test_report_input_matches_independent_sqlite_and_model_contract(self):
        import os
        import subprocess
        import sys
        from datetime import timedelta
        from uuid import uuid4
        import psycopg
        from garmin_pipeline import body, digest, report, store
        from report_runtime import envelope
        from test_report_runtime import report_env, setting

        root = Path(__file__).resolve().parents[1]
        fixture_path = root / 'fixtures/legacy/analysis-input-fixture.json'
        fixture = json.loads(fixture_path.read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory(prefix='report-input-comparison-') as tmp:
            base = Path(tmp)
            env = {'HOME':os.path.realpath(tmp),'TMPDIR':os.path.realpath(tmp),'PATH':os.defpath,'PYTHONPATH':str(root / 'tests/oracle/src'),'PYTHONDONTWRITEBYTECODE':'1'}
            child = subprocess.run([sys.executable,str(root / 'tests/report_input_oracle_child.py'),str(fixture_path)],cwd=tmp,env=env,text=True,capture_output=True,timeout=60)
            self.assertEqual(child.returncode, 0, child.stderr)
            expected = json.loads(child.stdout)
            snapshot_env = report_env()
            snapshot_env['BRAIN_EXTENSION_HOME'] = str(base)
            setting(snapshot_env, 'garmin.timezone', fixture['timezone'])
            _, cfg = envelope(snapshot_env)
            user, account, work, token = None, uuid4(), uuid4(), uuid4()
            with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'],autocommit=True) as owner:
                user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
                owner.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,%s)',(user,account,'report-oracle-'+str(account),fixture['timezone']))
                owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')",(work,str(work)))
                owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
                owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
                yesterday = str(date.fromisoformat(fixture['date']) - timedelta(days=1))
                for day, start, finish in ((fixture['date'],fixture['cutoff'],fixture['cutoff']),(yesterday,fixture['previous_cutoff'],None)):
                    owner.execute("insert into garmin.run(user_id,connection_id,local_date,started_at,finished_at,status,detail) values (%s,%s,%s,%s,%s,'success','')",(user,account,day,start,finish))
                for row in fixture['raw']:
                    owner.execute('insert into garmin.raw_response(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)',(user,account,row['scope'],row['key'],row['endpoint'],row['body'],fixture['cutoff'],fixture['cutoff'],'test'))
                for table, rows in [('activity',fixture['activities']),('day_summary',fixture['day_summary']),('workout',fixture['workout']),('exercise_log',fixture['exercise_log'])]:
                    for row in rows:
                        columns = ['user_id','connection_id',*row]
                        owner.execute('insert into garmin.'+table+'('+','.join(columns)+') values ('+','.join(['%s']*len(columns))+')',(user,account,*row.values()))
                for row in fixture['evaluations']:
                    owner.execute('insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)',(user,account,row['report_date'],row['scope'],row['summary'],json.dumps(row['judgments']),json.dumps(row['evidence']),json.dumps(row['next_checks']),row['report_md'],'fixture',fixture['cutoff']))
            (cfg.data_dir / 'body').mkdir(parents=True,exist_ok=True)
            for row in fixture['body']:
                (cfg.data_dir / 'body' / (row['measured_on']+'.json')).write_text(json.dumps(row['sidecar']),encoding='utf-8')
            cfg.profile_path.parent.mkdir(parents=True,exist_ok=True)
            cfg.profile_path.write_text(fixture['profile'],encoding='utf-8')
            previous = next((r for r in fixture['evaluations'] if r['report_date']==yesterday and r['scope']=='day'),None)
            if previous:
                cfg.reports_dir.mkdir(parents=True,exist_ok=True)
                (cfg.reports_dir / (yesterday+'.md')).write_text(previous['report_md'],encoding='utf-8')
            account_context = store.AccountContext(user,account,work,token)
            with patch.dict(os.environ,{'BRAIN_DATABASE_URL':os.environ['GARMIN_TEST_EXTENSION_DSN'],'BRAIN_USER_ID':str(user),'BRAIN_WORK_ID':str(work),'BRAIN_ATTEMPT_TOKEN':str(token)}), store.supervised_account(account_context):
                result = report_input.build(cfg,date.fromisoformat(fixture['date']),started_at=fixture['cutoff'])
                report_input.write_json(result.path / 'digest.json', digest.build(result.manifest,result.days,result.activities,result.labels,result.body))
                for scope in ('7d','30d','all'):
                    report_input.build_period(cfg,result.path,date.fromisoformat(fixture['date']),scope)
            actual = {str(p.relative_to(result.path)):p.read_text(encoding='utf-8') for p in result.path.rglob('*') if p.is_file()}
            self.assertEqual(set(actual),set(expected['files']))
            for name, value in actual.items():
                with self.subTest(path=name):
                    if name.endswith('.json'):
                        self.assertEqual(json.loads(value),json.loads(expected['files'][name]))
                    else:
                        self.assertEqual(value,expected['files'][name])
            schemas = Path(report.__file__).parent / 'schemas'
            contracts = {'prompts':[report.codex_prompt(['report-input/day']), *(report.codex_prompt(['report-input/period','profile.md'],scope=s) for s in ('7d','30d','all')),report.codex_prompt(['body/a.png'],intake=True)], 'schemas':{name:json.loads((schemas / name).read_text()) for name in ('body.schema.json','body_intake_output.schema.json','daily_analysis_output.schema.json','period_review_output.schema.json')}}
            measurement = json.loads((fixture_path.parent / 'report_v8/measurement.json').read_text(encoding='utf-8'))
            self.assertIsNone(expected['measurement_error'])
            self.assertEqual(body._first_error(body._measurement_schema(body.load_schema()),measurement),expected['measurement_error'])
            # 메시지 구조는 의도적으로 확장했다. 원래 계약의 나머지는 oracle과 같아야 한다.
            for name in ('daily_analysis_output.schema.json', 'period_review_output.schema.json'):
                message = contracts['schemas'][name]['properties'].pop('message')
                self.assertEqual(message['required'], ['headline', 'recommendations', 'trend_line', 'limitations'])
                contracts['schemas'][name]['required'].remove('message')
            self.assertEqual(contracts,expected['contracts'])
            self.assertEqual(digest.build(result.manifest,result.days,result.activities,result.labels,result.body),expected['digest'])
