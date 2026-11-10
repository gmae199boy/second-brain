"""Synthetic fixed selection and full-byte receipts; no live data or DB."""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'fixtures/native'))
from capture_manifest import load_capture
from import_scope import selected_capture, recheck_capture, batch_id
from native_import import validate_sources
from preflight import analyze
from reader import read_snapshot
from synthetic import make_capture


class ImportScopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.path = make_capture(self.root)
        self.value = json.loads(self.path.read_text())
        self.value.update(version=3, selection={'version': 1,
            'include': ['synthetic-' + r for r in ('D2','D1','D4','D5')],
            'exclude': [{'dataset':'synthetic-D3','reason':'unconfirmed-account'}]})
        # D3 has exactly one unassigned historical row, not a guessed profile.
        with sqlite3.connect(self.root / 'D3.db') as db:
            for (name,) in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'").fetchall():
                if name != 'auth_event': db.execute('delete from "' + name + '"')
        (self.root / 'excluded.md').write_text('excluded original')
        self.value['files'].append({'dataset':'synthetic-D3','artifact_key':'excluded',
            'source':'excluded.md','snapshot':'excluded.md','bytes':17,'category':'report'})
        self.save()

    def save(self): self.path.write_text(json.dumps(self.value))

    def test_full_five_selected_four_and_exclusion_receipt(self):
        full = load_capture(self.path, secure=True)
        selected = selected_capture(full)
        self.assertEqual(set(full['datasets']), {'D1','D2','D3','D4','D5'})
        self.assertEqual(set(selected['datasets']), {'D1','D2','D4','D5'})
        self.assertEqual(len(full['private']['datasets']), 5)
        self.assertEqual(len(selected['private']['datasets']), 4)
        self.assertFalse(any(f['dataset'] == 'synthetic-D3' for f in selected['private']['files']))
        receipt = full['private']['selection_receipt']
        self.assertEqual(sum(receipt['table_counts']['synthetic-D3'].values()), 1)
        self.assertEqual(receipt['table_counts']['synthetic-D3']['raw_response'], 0)
        self.assertEqual(receipt['selection']['exclude'][0]['reason'], 'unconfirmed-account')
        report = analyze(selected['datasets'], fixed4=True)
        self.assertEqual(report['authority_order'], ['D2','D1','D4','D5'])
        recheck_capture(self.path, full)

    def test_only_fixed_four_is_accepted(self):
        original = copy.deepcopy(self.value)
        mutations = [
            lambda m: m.pop('selection'),
            lambda m: m['selection'].update(include=['synthetic-D2']),
            lambda m: m['selection']['include'].append('synthetic-D3'),
            lambda m: m['selection']['include'].__setitem__(0,'synthetic-D1'),
            lambda m: m['selection']['include'].__setitem__(0,'unknown'),
            lambda m: m['selection']['exclude'][0].update(reason='operator-excluded'),
            lambda m: m['selection']['exclude'][0].update(dataset='synthetic-D4'),
            lambda m: m['datasets'].pop(0),
            lambda m: m['datasets'].append(dict(m['datasets'][0])),
            lambda m: m['datasets'][0].update(source='archive'),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.value = copy.deepcopy(original); mutate(self.value); self.save()
                with self.assertRaises(ValueError): load_capture(self.path)
        self.path.write_text(json.dumps(original)[:-1] + ',"version":3}')
        with self.assertRaises(ValueError): load_capture(self.path)

    def test_full_bytes_and_reason_are_immutable_during_run(self):
        full = load_capture(self.path, secure=True)
        before = full['private']['fingerprint']
        with sqlite3.connect(self.root/'D3.db') as db: db.execute('update auth_event set logged_in_at=logged_in_at+1')
        self.assertNotEqual(load_capture(self.path)['private']['fingerprint'], before)
        with self.assertRaises(ValueError): recheck_capture(self.path, full)
        full = load_capture(self.path, secure=True)
        (self.root/'excluded.md').write_text('changed original!')
        with self.assertRaises(ValueError): recheck_capture(self.path, full)
        self.value['selection']['exclude'][0]['reason'] = 'archive-retained'; self.save()
        with self.assertRaises(ValueError): load_capture(self.path)

    def test_semantic_order_and_role_anchor_are_stable(self):
        full = load_capture(self.path)
        self.value['datasets'].reverse(); self.value['files'].reverse()
        self.value['selection']['include'].reverse(); self.save()
        same = load_capture(self.path)
        self.assertEqual(full['private']['fingerprint'], same['private']['fingerprint'])
        anchor = batch_id(full, 'synthetic-D2')
        self.value['datasets'][3]['dataset'] = 'renamed-D2'
        self.value['selection']['include'] = ['renamed-D2' if x == 'synthetic-D2' else x for x in self.value['selection']['include']]
        for entry in self.value['files']:
            if entry['dataset'] == 'synthetic-D2': entry['dataset'] = 'renamed-D2'
        self.save(); renamed = load_capture(self.path)
        self.assertEqual(batch_id(renamed, 'renamed-D2'), anchor)
        self.assertNotEqual(full['private']['fingerprint'], renamed['private']['fingerprint'])

    def test_profile_absence_multi_profile_and_mismatch_reject_before_writes(self):
        capture = selected_capture(load_capture(self.path))
        entries = capture['private']['datasets']
        def verified(): return {e['dataset']:{'snapshot':read_snapshot(capture['datasets'][{'development':'D1','production':'D2','production-pre-epic5':'D4','production-before-history-start':'D5'}[e['source']]])} for e in entries}
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(validate_sources(entries, verified(), fixed4=True), {'12345'})
            with sqlite3.connect(self.root/'D5.db') as db: db.execute("update raw_response set raw='{}'")
            with self.assertRaises(ValueError): validate_sources(entries, verified(), fixed4=True)
            with sqlite3.connect(self.root/'D5.db') as db: db.execute("update raw_response set raw='{" + '"userProfileId":999' + "}'")
            with self.assertRaises(ValueError): validate_sources(entries, verified(), fixed4=True)
            with sqlite3.connect(self.root/'D5.db') as db: db.execute("update raw_response set raw='{" + '"userProfileId":[{"userProfileId":12345},{"userProfileId":999}]' + "}'")
            with self.assertRaises(ValueError): validate_sources(entries, verified(), fixed4=True)

    def test_excluded_paths_and_relations_are_still_validated(self):
        original = copy.deepcopy(self.value)
        for mutation in ('dangling','cross','path','symlink','wal'):
            self.value = copy.deepcopy(original)
            if mutation == 'dangling': self.value['files'][-1]['relations'] = [{'analysis_key':'missing','role':'source_file'}]
            if mutation == 'cross': self.value['files'][0]['relations'] = [{'analysis_key':'excluded','role':'source_file'}]
            if mutation == 'path': self.value['files'][-1]['snapshot'] = '../excluded.md'
            if mutation == 'symlink':
                (self.root/'excluded.md').unlink(); (self.root/'excluded.md').symlink_to(self.root/'report.md')
            if mutation == 'wal': (self.root/'D3.db-wal').touch()
            self.save()
            with self.assertRaises((ValueError,OSError)): load_capture(self.path)
            if mutation == 'symlink':
                (self.root/'excluded.md').unlink(); (self.root/'excluded.md').write_text('excluded original')

    def test_legacy_contract_stays_strict_five(self):
        for version in (1,2):
            value = copy.deepcopy(self.value); value.pop('selection'); value['version'] = version
            if version == 1:
                value.pop('inventory'); value['files'] = [{k:f[k] for k in ('source','snapshot','bytes')} for f in value['files']]
            self.path.write_text(json.dumps(value)); full = load_capture(self.path)
            self.assertIs(selected_capture(full), full)
            value['datasets'].pop(); self.path.write_text(json.dumps(value))
            with self.assertRaises(ValueError): load_capture(self.path)

    def test_owner_and_stale_attempt_fail_before_account_creation(self):
        import native_import as native
        from unittest.mock import MagicMock
        full = selected_capture(load_capture(self.path))
        entries = full['private']['datasets']
        from capture_manifest import ROLES
        verified = {e['dataset']:{'snapshot':read_snapshot(full['datasets'][ROLES[e['source']]])} for e in entries}
        settings = {'user_id':'00000000-0000-4000-8000-000000000001','values':{'garmin.timezone':'UTC'}}
        conn = MagicMock()
        with patch.dict('os.environ', {'BRAIN_USER_ID':'00000000-0000-4000-8000-000000000002'}, clear=True), patch.object(native,'_connect_account') as connect:
            with self.assertRaises(ValueError):
                with native.account_locks(conn, full, entries, verified, settings): pass
            connect.assert_not_called()
            conn.transaction.assert_not_called()
        with patch.dict('os.environ', {'BRAIN_USER_ID':settings['user_id']}, clear=True), patch.object(native,'check',side_effect=ValueError('IMPORT_INVALID')), patch.object(native,'_connect_account') as connect:
            with self.assertRaises(ValueError):
                with native.account_locks(conn, full, entries, verified, settings): pass
            connect.assert_not_called()
