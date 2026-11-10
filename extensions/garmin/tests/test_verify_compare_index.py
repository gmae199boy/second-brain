"""Synthetic lookup equivalence and full comparison performance regression."""
import copy
import hashlib
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import verify_compare as verify
from batch_import import VERSION, canonical, contract_fingerprint, encoded
from import_scope import batch_id
from raw_codec import project, restore
from reader import SQLiteText, InvalidSQLiteText
from import_verify import VerifyProgress


class LinearLookup:
    def __init__(self, stored, progress=lambda: None): self.stored = stored
    def find(self, name, **fields):
        return [r for r in self.stored[name] if all(str(r.get(k)) == str(v) for k,v in fields.items())]


class LinearRawLookup:
    def __init__(self, rows, progress=lambda: None): self.rows = rows
    def find(self, dataset, row):
        return [v for v in self.rows if v['dataset'] == dataset and all(
            restore(v[f],v[f+'_raw'],v[f+'_encoding']) == value
            for f,value in [('scope',row['scope']),('original_key',row['key']),('endpoint',row['endpoint'])])]


def fixture(size):
    capture = {'private': {'version': 1, 'capture_id': 'synthetic', 'fingerprint': 'synthetic',
                          'datasets': [{'dataset': 'synthetic', 'source': 'production'}]},
               'datasets': {'D2': 'synthetic-path'}}
    batch = batch_id(capture, 'synthetic')
    rows = [{'id': i, 'value': 'synthetic'} for i in range(size)]
    table = {'keys': ['id'], 'column_metadata': [], 'rows': rows}
    source = {'schema': 16, 'tables': {'meta': table}}
    stored = {name: [] for name in ('import_checkpoints','import_batches','datasets','source_schemas',
              'import_mapping','preserved_rows','raw_payloads','legacy_conversations','import_conflicts')}
    stored['datasets'] = [{'dataset': 'synthetic', 'account_confirmed': False, 'account': None,
                          'account_raw': None, 'account_encoding': None, 'dataset_label': None,
                          'dataset_label_raw': None, 'dataset_label_encoding': None}]
    stored['import_batches'] = [{'dataset': 'synthetic', 'id': batch}]
    stored['source_schemas'] = [{'dataset': 'synthetic', 'original_table': 'meta', 'schema_version': 16,
                                'columns_json': [], 'keys_json': ['id']}]
    keys = []
    for row in sorted(rows, key=lambda r: canonical([encoded(r['id'])])):
        key = canonical([encoded(row['id'])]); keys.append(key)
        payload = {k: encoded(v) for k,v in row.items()}
        stored['import_mapping'].append({'dataset': 'synthetic', 'batch': batch, 'original_table': 'meta',
            'original_key': key, 'target_kind': 'preserved', 'target_id': row['id'],
            'content_hash': hashlib.sha256(canonical(payload).encode()).hexdigest()})
        stored['preserved_rows'].append({'dataset': 'synthetic', 'original_table': 'meta', 'original_key': key,
            'id': row['id'], 'values_json': payload, 'run_id': None})
    stored['import_checkpoints'] = [{'dataset': 'synthetic', 'batch': batch, 'source_hash': 'hash',
        'schema_version': 16, 'importer_version': VERSION, 'manifest_fingerprint': contract_fingerprint('synthetic'),
        'source_role': 'production', 'conversation_id': None, 'original_table': 'meta', 'original_key': keys[-1]}]
    return capture, stored, source


def run_compare(capture, stored, source, **kwargs):
    with patch.object(verify, 'read_source', return_value=(b'', 'hash', None)), \
         patch.object(verify, 'read_snapshot_bytes', return_value=source), \
         patch.object(verify, 'recheck_source'):
        return verify.compare(capture, stored, [], None, **kwargs)


class VerifyCompareIndexTest(unittest.TestCase):
    def test_string_keys_order_duplicates_and_field_sets(self):
        uid = UUID(int=1)
        rows = [{}, {'key': None}, {'key': 'None'}, {'key': 1, 'other': uid},
                {'key': '1', 'other': str(uid)}, {'key': True}, {'key': b'x'}]
        stored = {'t': rows, 'other': rows[::-1]}
        indexed, linear = verify.StoredLookup(stored), LinearLookup(stored)
        for table in stored:
            for fields in ({}, {'key': None}, {'key': 1}, {'key': True}, {'key': b'x'},
                           {'key': 'missing'}, {'key': 1, 'other': uid}, {'other': str(uid), 'key': '1'}):
                self.assertEqual(indexed.find(table, **fields), linear.find(table, **fields))
                self.assertEqual([id(r) for r in indexed.find(table, **fields)],
                                 [id(r) for r in linear.find(table, **fields)])
        self.assertEqual(len(indexed.indexes), 6)

    def test_raw_restored_equality_and_duplicate_order(self):
        values = ['plain', SQLiteText('plain'.encode('utf-16le'), 'utf-16le'),
                  'nul\x00text', InvalidSQLiteText(b'\xff', 'utf-8'), None]
        rows = []
        for index, value in enumerate(values):
            row = {'dataset': 'synthetic', 'index': index}
            for field, text in [('scope', value), ('original_key', 'key'), ('endpoint', 'endpoint')]:
                row[field], row[field+'_raw'], row[field+'_encoding'] = project(text)
            rows.append(row)
        rows.append(dict(rows[0]))
        rows.append({**rows[0], 'dataset': 'other'})
        indexed, linear = verify.RawLookup(rows), LinearRawLookup(rows)
        for dataset in ('synthetic', 'other', 'missing'):
            for value in values + ['absent']:
                row = {'scope': value, 'key': 'key', 'endpoint': 'endpoint'}
                self.assertEqual(indexed.find(dataset, row), linear.find(dataset, row))

    def test_complete_verdict_matches_linear_for_corruption_missing_and_duplicates(self):
        capture, stored, source = fixture(12)
        variants = [stored]
        for name in ('preserved_rows', 'import_mapping', 'source_schemas', 'import_checkpoints'):
            missing = copy.deepcopy(stored); missing[name].pop(); variants.append(missing)
            duplicate = copy.deepcopy(stored); duplicate[name].append(copy.deepcopy(duplicate[name][0])); variants.append(duplicate)
        mismatch = copy.deepcopy(stored); mismatch['preserved_rows'][0]['values_json'] = {}; variants.append(mismatch)
        self.assertEqual(run_compare(capture, stored, source)['counts']['mismatches'], 0)
        for index, variant in enumerate(variants):
            with self.subTest(variant=index):
                actual = run_compare(capture, variant, source)
                with patch.object(verify, 'StoredLookup', LinearLookup), patch.object(verify, 'RawLookup', LinearRawLookup):
                    expected = run_compare(capture, variant, source)
                self.assertEqual(actual, expected)
                if index: self.assertGreater(actual['counts']['mismatches'], 0)

    def test_100000_source_rows_with_progress_under_30_seconds(self):
        capture, stored, source = fixture(100000)
        events = []
        # Deterministic clock exercises throttled progress even on fast hosts.
        ticks = iter(i / 10000 for i in range(1000000))
        progress = VerifyProgress(lambda kind: events.append(kind), lambda: next(ticks))
        started = time.monotonic()
        result = run_compare(capture, stored, source, progress=progress)
        elapsed = time.monotonic() - started
        print(f'verify_compare synthetic source_rows=100000 elapsed_seconds={elapsed:.3f}', flush=True)
        self.assertEqual(result['counts']['source_rows'], 100000)
        self.assertEqual(result['counts']['mismatches'], 0)
        self.assertLess(elapsed, 30)
        self.assertGreater(len(events), 2)
        self.assertEqual(set(events), {'progress'})

    def test_100000_raw_identities_under_10_seconds(self):
        rows = []
        for i in range(100000):
            row = {'dataset': 'synthetic'}
            for field, value in [('scope', 'day'), ('original_key', str(i)), ('endpoint', 'synthetic')]:
                row[field], row[field+'_raw'], row[field+'_encoding'] = project(value)
            rows.append(row)
        started = time.monotonic()
        lookup = verify.RawLookup(rows)
        for i in range(100000):
            self.assertIs(lookup.find('synthetic', {'scope': 'day', 'key': str(i), 'endpoint': 'synthetic'})[0], rows[i])
        elapsed = time.monotonic() - started
        print(f'verify_compare synthetic raw_rows=100000 elapsed_seconds={elapsed:.3f}', flush=True)
        self.assertLess(elapsed, 10)

    def test_progress_is_cooperative_and_throttled(self):
        events = []
        times = iter([0, 0, 4.99, 5, 5.01, 10])
        progress = VerifyProgress(lambda kind: events.append(kind), lambda: next(times))
        for _ in range(6): progress()
        self.assertEqual(events, ['progress'] * 3)
