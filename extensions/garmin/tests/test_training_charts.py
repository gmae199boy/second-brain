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

    def test_only_month_repeated_exercises_have_graph_pages(self):
        value = fixture('30d')
        template = value['current']['sessions'][0]
        template['sets'] = [dict(template['sets'][0], exercise_key=f'key-{i:02}', order=i) for i in range(17)]
        duplicate = copy.deepcopy(template); duplicate['session_id'] = 'second'; duplicate['completed_date'] = '2026-01-01'
        value['current']['sessions'] = [duplicate, template]; value['current']['strength'] = []
        model = charts.adapt_measurements(value)
        pages, omitted = charts._pages(model)
        self.assertEqual(len(pages), 3)
        self.assertEqual(omitted, 9)
        self.assertEqual(len([g for page in pages for g in page]), 8)
        for scope in ('day', '7d', 'all'):
            model['scope'] = scope
            self.assertEqual(charts._pages(model), ([], 0))
        value['current']['sessions'] = [template]
        self.assertEqual(charts._pages(charts.adapt_measurements(value)), ([], 0))

    def test_session_trend_keeps_same_day_sessions_and_three_metrics(self):
        value = fixture('30d')
        first = value['current']['sessions'][0]
        first['sets'] = [dict(first['sets'][0], load_kg=12, reps=10), dict(first['sets'][0], load_kg=14, reps=8)]
        second = copy.deepcopy(first); second['session_id'] = 'aaa-second'
        second['start_at'] = '2026-01-02T23:00:00+09:00'
        second['sets'] = [dict(first['sets'][0], load_kg=None, load_kind='missing', reps=None)]
        value['current']['sessions'] = [first, second]; value['current']['strength'] = []
        group = next(iter(charts._groups(charts.adapt_measurements(value)).values()))
        fig = figure(); self.addCleanup(fig.clear)
        axes = fig.subplots(1, 3)
        charts._session_trend(axes, group)
        self.assertEqual(list(axes[0].lines[0].get_ydata()), [14, None])
        self.assertEqual(list(axes[1].lines[0].get_ydata()), [18, None])
        self.assertEqual(list(axes[2].lines[0].get_ydata()), [2, 1])
        self.assertEqual(len(axes[0].get_xticklabels()), 2)
        self.assertTrue(any('무게 미기록' in text.get_text() for text in axes[0].texts))

    def test_heart_reuses_legacy_zone_background_without_set_shading(self):
        value = fixture()
        model = charts.adapt_measurements(value)
        fig = figure(); self.addCleanup(fig.clear)
        charts._heart(fig, model)
        primary = fig.axes[0]
        self.assertTrue(primary.lines)
        self.assertEqual(primary.lines[0].get_marker(), 'o')
        self.assertEqual(len(primary.patches), 0)
        self.assertTrue(any('심박' in line.get_label() for line in primary.lines))

    def test_render_all_scopes_metadata_limits_and_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for scope in charts.SCOPES:
                with self.subTest(scope=scope):
                    value = fixture(scope)
                    if scope == '30d':
                        second = copy.deepcopy(value['current']['sessions'][0])
                        second['session_id'] = 'second'; second['completed_date'] = '2026-01-01'
                        value['current']['sessions'].append(second)
                    out = root / scope
                    graphs = charts.render(value, out, cache_dir=root / 'cache')
                    self.assertLessEqual(sum(graph.metric != 'heart_rate_zones_legacy' for graph in graphs), 3)
                    self.assertEqual(sum(graph.metric == 'heart_rate_zones_legacy' for graph in graphs), int(scope == 'day'))
                    if scope == '30d':
                        self.assertTrue(graphs)
                        self.assertTrue(all(g.metric == 'session_load_reps_sets' for g in graphs))
                    if scope in ('7d', 'all'):
                        self.assertEqual(graphs, [])
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
