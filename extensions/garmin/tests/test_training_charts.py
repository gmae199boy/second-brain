"""C1 합성 입력만 사용하는 그래프 수락 사례."""
import contextlib
import copy
import json
import struct
import sys
import tempfile
import types
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import training_charts as charts
import report_publish

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/training_charts/mixed-day.json'


def fixture(scope='day'):
    value = json.loads(FIXTURE.read_text())
    value['scope'] = scope
    if scope != 'day':
        value['current']['from'] = '2026-01-01'
    return value


def figure():
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib.figure import Figure
    return Figure()


def description(path):
    data = path.read_bytes()
    offset = 8
    while offset < len(data):
        length = struct.unpack('!I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length]
        if kind == b'tEXt' and chunk.startswith(b'Description\0'):
            return json.loads(chunk.split(b'\0', 1)[1])
        if kind == b'iTXt' and chunk.startswith(b'Description\0'):
            # keyword, compression flag/method, language, translated keyword, text
            _, rest = chunk.split(b'\0', 1)
            flag, rest = rest[0], rest[2:]
            _, rest = rest.split(b'\0', 1)
            _, text = rest.split(b'\0', 1)
            return json.loads(zlib.decompress(text) if flag else text)
        offset += 12 + length
    raise AssertionError('missing PNG metadata')


class TrainingChartsTest(unittest.TestCase):
    def test_c1_adapter_keeps_load_kinds_and_current_window(self):
        value = fixture()
        value['comparison'] = copy.deepcopy(value['current'])
        outside = copy.deepcopy(value['current']['sessions'][0])
        outside['completed_date'] = '2026-01-03'
        value['current']['sessions'].append(outside)
        model = charts.adapt_measurements(value)
        self.assertEqual(len(model['sessions']), 4)
        self.assertEqual(model['range'], {'start': '2026-01-02', 'end': '2026-01-02', 'timezone': 'Asia/Seoul'})
        rows = model['sessions'][0]['sets']
        self.assertEqual([row['load_kind'] for row in rows], ['weighted', 'bodyweight', 'missing', 'assisted', 'unknown'])
        self.assertIsNone(rows[1]['load_kg'])
        self.assertEqual(charts._load_label(rows[1]), '맨몸')
        self.assertEqual(charts._load_label(rows[2]), '무게 미기록')
        self.assertIsNone(value['current']['sessions'][0]['sets'][1]['load_kg'])

    def test_bodyweight_uses_reps_and_rest_or_missing_is_not_zero(self):
        value = fixture()
        rows = value['current']['sessions'][0]['sets']
        rows[0]['set_type'] = 'REST'
        rows[2]['reps'] = None
        rows[3]['reps'] = 0
        model = charts.adapt_measurements(value)
        group = next(iter(charts._groups(model).values()))
        fig = figure(); self.addCleanup(fig.clear)
        ax = fig.subplots(); charts._set_panel(ax, group)
        self.assertEqual([bar.get_height() for bar in ax.patches], [10, 0, 10])
        self.assertEqual(len(group['sets']), 4)
        self.assertTrue(any('10회 × 맨몸' in text.get_text() for text in ax.texts))
        self.assertTrue(any('reps 미기록' in text.get_text() for text in ax.texts))
        self.assertFalse(any('0 kg' in text.get_text() for text in ax.texts))

    def test_all_day_exercises_with_same_label_keep_stable_keys_and_three_pages(self):
        value = fixture()
        rows = value['current']['sessions'][0]['sets']
        template = rows[1]
        value['current']['sessions'][0]['sets'] = [dict(template, exercise_key=f'key-{i:02}', order=i, set_no=1) for i in range(17)]
        pages, omitted = charts._pages(charts.adapt_measurements(value))
        self.assertEqual(len(pages), 3)
        self.assertEqual(omitted, 0)
        self.assertEqual(len({group['key'] for page in pages for group in page}), 17)
        value['scope'] = '30d'
        pages, omitted = charts._pages(charts.adapt_measurements(value))
        self.assertEqual(len(pages), 2)
        self.assertEqual(omitted, 9)
        self.assertEqual([group['key'] for page in pages for group in page], [f'key-{i:02}' for i in range(8)])

    def test_frequency_precedes_canonical_key(self):
        value = fixture('7d')
        first = value['current']['sessions'][0]
        first['sets'] = [dict(first['sets'][1], exercise_key=key, order=i) for i, key in enumerate(['a', 'z'])]
        second = copy.deepcopy(first); second['session_id'] = 'synthetic-second'; second['sets'] = [second['sets'][1]]
        value['current']['sessions'].append(second)
        pages, _ = charts._pages(charts.adapt_measurements(value))
        self.assertEqual([group['key'] for page in pages for group in page], ['z', 'a'])

    def test_reps_series_does_not_connect_missing_load_or_different_equipment(self):
        value = fixture('7d')
        first = value['current']['sessions'][0]
        second = copy.deepcopy(first); second['session_id'] = 'synthetic-second'; second['completed_date'] = '2026-01-01'
        second['sets'][0]['load_kg'] = 7
        second['sets'][1]['equipment'] = 'other'
        value['current']['sessions'].append(second)
        model = charts.adapt_measurements(value)
        group = next(iter(charts._groups(model).values()))
        fig = figure(); self.addCleanup(fig.clear)
        ax = fig.subplots(); charts._trend_panel(ax, group, '7d')
        self.assertIn('5 kg', ax.get_legend_handles_labels()[1])
        self.assertIn('7 kg', ax.get_legend_handles_labels()[1])
        self.assertTrue(all(line.get_linestyle() == 'None' for line in ax.lines))
        self.assertCountEqual([line.get_label() for line in ax.lines if line.get_label().startswith('맨몸')], ['맨몸', '맨몸 · other'])

    def test_heart_spans_only_explicit_active_times(self):
        value = fixture()
        value['current']['sessions'] = value['current']['sessions'][:1]
        rows = value['current']['sessions'][0]['sets']
        rows[0]['set_type'] = 'REST'
        rows[2]['start_at'] = rows[2]['end_at'] = None
        model = charts.adapt_measurements(value)
        fig = figure(); self.addCleanup(fig.clear)
        charts._heart(fig, model)
        self.assertEqual(len(fig.axes), 1)
        self.assertEqual(len(fig.axes[0].patches), 3)
        self.assertIn('세트 구간 미기록 1개', fig.axes[0].get_title())

    def test_monthly_summary_does_not_need_all_raw_sets(self):
        value = fixture('all')
        value['current']['sessions'] = []
        value['current']['strength'] = [{'exercise_key': 'PUSH_UP', 'display_name': '푸시업', 'exposures': 12, 'sets': 24,
            'reps': 240, 'volume_kg': None, 'volume_partial': True, 'volume_sets': 0, 'missing_load_sets': 0,
            'bodyweight_sets': 24, 'max_kg': None, 'max_kg_reps': [], 'session_ids': [],
            'same_load_reps': [{'load_kind': 'bodyweight', 'load_kg': None,
                                'observations': [{'session_id': 's1', 'reps': 10}, {'session_id': 's2', 'reps': 14}]},
                               {'load_kind': 'weighted', 'load_kg': 5,
                                'observations': [{'session_id': 's2', 'reps': 7}]}],
            'comparability': {'status': 'limited', 'limitations': []},
            'monthly': [dict(month=month, reps=reps, sets=sets, exposures=6, volume_kg=None,
                             volume_sets=0, missing_load_sets=0, bodyweight_sets=sets)
                        for month, reps, sets in [('2025-12', 100, 10), ('2026-01', 140, 14)]]}]
        model = charts.adapt_measurements(value)
        pages, _ = charts._pages(model)
        self.assertEqual(pages[0][0]['key'], 'PUSH_UP')
        fig = figure(); self.addCleanup(fig.clear)
        charts._strength(fig, model, pages[0])
        self.assertEqual(list(fig.axes[1].lines[0].get_ydata()), [100, 140])
        self.assertEqual(fig.axes[0].get_legend_handles_labels()[1], ['맨몸', '5 kg'])
        self.assertEqual(list(fig.axes[0].lines[0].get_ydata()), [10, 14])
        self.assertTrue(fig.axes[-1].get_visible())  # twinx 세트 수 축도 보여야 한다.
        self.assertIn('같은 부하 비교 아님', fig.axes[1].get_xlabel())

    def test_monthly_missing_reps_keeps_chronological_axis_and_gap(self):
        group = {'label': '합성 운동', 'summary': {'monthly': [
            {'month': '2026-01', 'reps': 10, 'sets': 1},
            {'month': '2026-02', 'reps': None, 'sets': 2},
            {'month': '2026-03', 'reps': 30, 'sets': 3}]}}
        fig = figure(); self.addCleanup(fig.clear)
        ax = fig.subplots(); charts._monthly_panel(ax, group)
        primary, secondary = fig.axes
        x = list(primary.lines[0].get_xdata())
        self.assertEqual(x, sorted(x))
        self.assertEqual(x, list(secondary.lines[0].get_xdata()))
        self.assertIsNone(primary.lines[0].get_ydata()[1])
        self.assertEqual([tick.get_text() for tick in primary.get_xticklabels()], ['2026-01', '2026-02', '2026-03'])

    def test_overview_distinguishes_identical_labels(self):
        value = fixture('7d')
        rows = value['current']['sessions'][0]['sets']
        rows[1]['exercise_key'] = 'PUSH_UP_OTHER'
        model = charts.adapt_measurements(value)
        fig = figure(); self.addCleanup(fig.clear)
        charts._overview(fig, model)
        bars = fig.axes[0].patches
        self.assertEqual(len(bars), 2)
        self.assertNotEqual(bars[0].get_y(), bars[1].get_y())
        self.assertEqual(len(set(text.get_text() for text in fig.axes[0].get_yticklabels())), 2)

    def test_render_all_scopes_metadata_limits_and_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for scope in charts.SCOPES:
                with self.subTest(scope=scope):
                    value = fixture(scope)
                    out = root / scope
                    graphs = charts.render(value, out, cache_dir=root / 'cache')
                    self.assertLessEqual(sum(graph.metric != 'heart_rate_set_intervals' for graph in graphs), 3)
                    self.assertEqual(sum(graph.metric == 'heart_rate_set_intervals' for graph in graphs), int(scope == 'day'))
                    for graph in graphs:
                        path = out / graph.name
                        meta = description(path)
                        self.assertEqual((meta['scope'], meta['snapshot_id']), (scope, 'synthetic-snapshot'))
                        self.assertEqual(meta['range'], charts.adapt_measurements(value)['range'])
                        self.assertEqual(meta['metric'], graph.metric)
                        if scope == 'all' and 'strength' in graph.name:
                            self.assertEqual(meta['metric'], 'reps_by_load')
                        self.assertEqual(charts.png_metadata(path.read_bytes()), meta)
                        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                        self.assertLessEqual(path.stat().st_size, 10_000_000)
                        width, height = struct.unpack('!II', path.read_bytes()[16:24])
                        self.assertLessEqual(width + height, 10000)
                    manifests = list(out.glob('*-manifest.json'))
                    self.assertEqual(len(manifests), 1)
                    manifest = json.loads(manifests[0].read_text())
                    self.assertEqual(len(manifest['graphs']), len(graphs))
                    self.assertTrue(all(len(item['sha256']) == 64 for item in manifest['graphs']))

    def test_empty_period_renders_no_images(self):
        value = fixture(); value['current']['sessions'] = []; value['current']['strength'] = []
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(charts.render(value, Path(folder), cache_dir=Path(folder) / 'cache'), [])
            self.assertEqual(list(Path(folder).glob('*.png')), [])

    def test_invalid_version_fails_before_render(self):
        value = fixture(); value['schema_version'] = 'old'
        with self.assertRaises(ValueError): charts.adapt_measurements(value)


class PublicationChartsTest(unittest.TestCase):
    def structured(self, value):
        return {'schema_version': 'garmin.scope_analysis.v2', 'scope': value['scope'],
                'range': {'start': value['current']['from'], 'end': value['current']['to'], 'timezone': value['timezone']},
                'snapshot_id': value['snapshot_id'], 'data_cutoff': value['data_cutoff'],
                'measurements_version': value['schema_version'], 'profile_snapshot_id': None}

    def test_loader_uses_w3_api_and_rejects_different_range(self):
        value = fixture('7d'); structured = self.structured(value)
        fake = types.ModuleType('garmin_pipeline.training_measurements')
        seen = []
        fake.resolve_snapshot_root = lambda cfg, snapshot_id: seen.append(snapshot_id) or Path('/synthetic/snapshot')
        fake.load_training_measurements = lambda root, scope: seen.append((root, scope)) or value
        with patch.dict(sys.modules, {'garmin_pipeline.training_measurements': fake}):
            self.assertIs(report_publish._load_scope_measurements(None, structured), value)
            self.assertEqual(seen, ['synthetic-snapshot', (Path('/synthetic/snapshot'), '7d')])
            structured['range']['start'] = '2025-12-31'
            with self.assertRaises(ValueError): report_publish._load_scope_measurements(None, structured)

    def test_scope_publication_freezes_graphs_without_legacy_db_reader(self):
        from datetime import date
        from uuid import UUID
        value = fixture('7d'); structured = self.structured(value)
        class Cursor:
            def __init__(self, row=None): self.row = row
            def fetchone(self): return self.row
        class Conn:
            user_id, connection_id = UUID(int=1), UUID(int=2)
            def __init__(self): self.saved = []; self.exists = False
            def execute(self, sql, args):
                if 'select 1 from garmin.report_publications' in sql: return Cursor((1,) if self.exists else None)
                if 'select report_md' in sql: return Cursor(('합성 보고서', structured))
                if 'insert into garmin.report_publications(' in sql: self.exists = True; return Cursor()
                if 'insert into garmin.report_publication_items' in sql: self.saved.append(args); return Cursor()
                raise AssertionError(sql)
        conn = Conn()
        def render(measurements, folder, **kwargs):
            (folder / '02-7d-strength-1.png').write_bytes(b'synthetic-png')
            (folder / '02-7d-manifest.json').write_text('{"scope":"7d"}')
            return [charts.TrainingGraph('02-7d-strength-1.png', '7일', '7d', structured['range'], 'reps_by_load')]
        with tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
            cfg = types.SimpleNamespace(data_dir=Path(folder))
            stack.enter_context(patch.object(report_publish.store, 'write_session', return_value=contextlib.nullcontext(conn)))
            stack.enter_context(patch.object(report_publish.store, 'transaction', side_effect=lambda _: contextlib.nullcontext()))
            load = stack.enter_context(patch.object(report_publish, '_load_scope_measurements', return_value=value))
            draw = stack.enter_context(patch.object(report_publish.training_charts, 'render', side_effect=render))
            legacy = stack.enter_context(patch.object(report_publish.charts, 'render'))
            report_publish._prepare(cfg, date(2026, 1, 3), '7d', 2)
            frozen = list(conn.saved)
            report_publish._prepare(cfg, date(2026, 1, 3), '7d', 2)
            self.assertEqual(conn.saved, frozen)
            load.assert_called_once_with(cfg, structured)
            draw.assert_called_once(); legacy.assert_not_called()
            self.assertEqual([row[5] for row in conn.saved], ['report.md', '02-7d-strength-1.png'])
            self.assertIn(b'training-graph-manifest', conn.saved[0][8])
            self.assertEqual(conn.saved[1][3:5], ('7d', 2))


if __name__ == '__main__':
    unittest.main()
