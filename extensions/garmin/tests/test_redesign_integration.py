"""Synthetic checks for the merged snapshot, profile and provider contracts."""
import contextlib
import copy
import json
import os
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from garmin_pipeline import report, store, training_measurements as training

DAY = date(2026, 1, 3)
SNAPSHOT = 'a' * 64
CUTOFF = '2026-01-03T08:00:00+00:00'


class SnapshotAdoptionTest(unittest.TestCase):
    def setUp(self):
        self.cfg = SimpleNamespace(timezone='UTC')
        self.rows = {scope: {'revision': 2, 'structured': {
            'schema_version': 'garmin.scope_analysis.v2', 'status': 'ok', 'scope': scope,
            'snapshot_id': SNAPSHOT, 'range': {'start': '2026-01-02', 'end': '2026-01-02', 'timezone': 'UTC'},
            'data_cutoff': CUTOFF, 'measurements_version': training.SCHEMA_VERSION,
            'profile_snapshot_id': 'profile-hash',
        }} for scope in training.SCOPES}
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, {'BRAIN_WORK_ID': 'new-synthetic-work'}))
        stack.enter_context(patch.object(training, 'resolve_snapshot_root', return_value=Path('synthetic-snapshot')))
        stack.enter_context(patch.object(training, 'validate_snapshot', return_value={
            'report_date': DAY.isoformat(), 'data_cutoff': CUTOFF, 'profile_snapshot_id': 'profile-hash'}))
        stack.enter_context(patch.object(training, 'load_training_measurements', return_value={
            'current': {'from': '2026-01-02', 'to': '2026-01-02'}}))

    def test_only_complete_matching_vector_is_accepted(self):
        self.assertEqual(report._validate_completed_snapshot(self.cfg, DAY, self.rows), SNAPSHOT)
        for field, changed in [('snapshot_id', 'b' * 64), ('profile_snapshot_id', None),
                               ('data_cutoff', '2026-01-03T09:00:00+00:00'), ('status', 'failed'),
                               ('range', {'start': '2026-01-01', 'end': '2026-01-02', 'timezone': 'UTC'})]:
            with self.subTest(field=field):
                rows = copy.deepcopy(self.rows)
                rows['7d']['structured'][field] = changed
                with self.assertRaises(ValueError):
                    report._validate_completed_snapshot(self.cfg, DAY, rows)
        del self.rows['all']
        with self.assertRaises(ValueError):
            report._validate_completed_snapshot(self.cfg, DAY, self.rows)

    def test_new_work_adopts_and_retry_keeps_the_persisted_vector(self):
        mappings = []
        latest = [(scope, row['revision'], row['structured']) for scope, row in self.rows.items()]
        class Rows:
            def __init__(self, values): self.values = list(values)
            def fetchall(self): return self.values
        class Conn:
            user_id = 'synthetic-user'
            connection_id = 'synthetic-account'
            def execute(self, sql, args):
                if 'join garmin.evaluation_revisions' in sql:
                    return Rows(mappings)
                if 'select distinct on (scope)' in sql:
                    return Rows(latest)
                if 'insert into garmin.report_work_revisions' in sql:
                    scope, revision = args[-2:]
                    mappings.append((scope, revision, self_outer.rows[scope]['structured']))
                    return Rows([])
                raise AssertionError(sql)
        self_outer = self
        @contextlib.contextmanager
        def session(_): yield Conn()
        with patch.object(store, 'write_session', session), \
             patch.object(store, 'transaction', lambda _: contextlib.nullcontext()), \
             patch.object(store, 'successful_scope_results', return_value={}):
            first = report._work_revisions(self.cfg, DAY, False)
            self.assertEqual(first.snapshot_id, SNAPSHOT)
            self.assertEqual(first, dict.fromkeys(training.SCOPES, 2))
            latest.clear()  # A retry must use its mapping, never latest revisions.
            retry = report._work_revisions(self.cfg, DAY, False)
            self.assertEqual(retry, first)
            self.assertEqual(retry.snapshot_id, SNAPSHOT)
            self.assertEqual(len(mappings), 4)
            mappings.clear()
            latest.extend((scope, row['revision'], row['structured']) for scope, row in self.rows.items())
            fresh = report._work_revisions(self.cfg, DAY, True)
            self.assertEqual(fresh, {})
            self.assertNotEqual(fresh.snapshot_id, SNAPSHOT)


class ProfileBridgeTest(unittest.TestCase):
    def test_profile_status_is_not_confused_with_an_empty_profile(self):
        from test_training_measurements import manifest, activity
        # C1 computation uses the producer's profile_status, including absent snapshots.
        for status, expected in [('absent', 'unset'), ('partial', 'configured'), ('complete', 'configured')]:
            value = training.build_training_measurements(manifest(), {}, {}, {}, [], 'day',
                profile={'profile_status': status, 'profile': {'schema_version': 1}})
            self.assertEqual(value['profile']['status'], expected)
