#!/usr/bin/env python3
import copy
from datetime import date, timedelta
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import charts
import runtime_artifacts
import runtime_files
from contextlib import nullcontext

FIXTURE = Path(__file__).parent / 'fixtures/charts_v8/synthetic.json'

class ChartsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(FIXTURE.read_text())
        f = cls.fixture
        cls.data = charts.read_chart_data(f['snapshot'], f['measurements'], date.fromisoformat(f['report_date']), f['timezone'])

    def test_oracle(self):
        self.assertEqual(self.data, self.fixture['expected'])
        strength = self.data['strength_progress']['items']
        self.assertTrue(any(d['best_weight_kg'] == 22.5 and d['volume_kg'] == 465 for i in strength for d in i['days']))

    def test_render_and_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            names = []
            for name,size,draw in charts.graph_jobs(self.data):
                rendered = charts.render_one(temp,name,size,draw)
                if rendered:
                    path, title = rendered
                    self.assertTrue(title)
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    data = path.read_bytes()
                    self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
                    self.assertEqual(struct.unpack('>II',data[16:24]), (1800,900))
                    names.append(name)
                    path.unlink()
            self.assertEqual(names, ['01-yesterday.png','02-session-1.png','03-session-2.png',
                '04-strength-1.png','05-strength-2.png','50-sleep-30d.png','51-hrv-30d.png',
                '52-heart-30d.png','53-workouts-30d.png','54-sleep-all.png','55-hrv-all.png',
                '56-heart-all.png','57-workouts-all.png','58-strength-all.png','59-body.png'])
            self.assertEqual((Path(temp)/'.matplotlib').stat().st_mode & 0o777, 0o700)

    def test_empty_failure_and_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            self.assertIsNone(charts.render_one(temp, 'empty', (12,6), lambda f: False))
            with self.assertRaises(RuntimeError): charts.render_one(temp,'bad',(12,6),lambda f: (_ for _ in ()).throw(RuntimeError()))
            from matplotlib.figure import Figure
            def huge(fig, path, **kwargs): Path(path).write_bytes(b'x' * 10_000_001)
            with patch.object(Figure,'savefig',huge):
                with self.assertRaises(ValueError): charts.render_one(temp,'large',(12,6),lambda f: bool(f.subplots()))
            self.assertEqual(list((Path(temp)/'graph-work').iterdir()), [])

    def test_reader_independent_failure_boundaries(self):
        f = self.fixture
        with patch.object(charts.normalize_tables, 'normalize_all', side_effect=ValueError('raw')):
            result = charts.read_chart_data(f['snapshot'], f['measurements'], date.fromisoformat(f['report_date']), f['timezone'])
        self.assertEqual(set(result), {'report_date', 'body_measurements'})
        self.assertEqual(result['body_measurements'], f['expected']['body_measurements'])
        result = charts.read_chart_data(f['snapshot'], [None], date.fromisoformat(f['report_date']), f['timezone'])
        self.assertNotIn('body_measurements', result)
        self.assertEqual(result, {k:v for k,v in f['expected'].items() if k != 'body_measurements'})

    def test_size_boundary(self):
        from matplotlib.figure import Figure
        with tempfile.TemporaryDirectory() as home:
            for size in (10_000_000, 10_000_001):
                def save(fig, path, **kwargs): Path(path).write_bytes(b'x' * size)
                with patch.object(Figure, 'savefig', save):
                    if size == 10_000_000:
                        path, _ = charts.render_one(home,'size',(12,6),lambda fig: bool(fig.subplots()))
                        self.assertEqual(path.stat().st_size,size)
                        path.unlink()
                    else:
                        with self.assertRaises(ValueError): charts.render_one(home,'size',(12,6),lambda fig: bool(fig.subplots()))
            self.assertEqual(list((Path(home)/'graph-work').iterdir()), [])
        with patch.object(runtime_files, 'graph_identity', return_value=('dataset','identity','id')), \
             patch.object(runtime_files, 'locator_lock', return_value=nullcontext()), \
             patch.object(runtime_files, 'graph_lookup', return_value=('id',('completed','file'))):
            self.assertEqual(runtime_files.graph_request(None,'',None,None,None,b'x'*10_000_000,{},0), ('id',('completed','file')))
            with self.assertRaisesRegex(ValueError,'ARTIFACT_INVALID'):
                runtime_files.graph_request(None,'',None,None,None,b'x'*10_000_001,{},0)

    def test_graph_revision_failure_and_stop(self):
        jobs = [('01-yesterday.png',(12,6),None), ('59-body.png',(12,6),None)]
        def rev(name, *_):
            if name.startswith('01'): raise ValueError('synthetic revision failure')
            return 'revision'
        with patch.object(charts,'graph_jobs',return_value=jobs), patch.object(charts,'revision',side_effect=rev), \
             patch.object(runtime_artifacts.collect,'boundary') as boundary, \
             patch.object(runtime_files,'graph_lookup',return_value=('id',('completed','file'))):
            graphs, failed, skipped = runtime_artifacts.publish_graphs(None,'',None,None,None,'parent',date(2026,10,18),'UTC',0,{},'v','face')
            self.assertEqual((graphs,failed,skipped),(['59-body.png'],['01-yesterday.png'],0))
            self.assertEqual(boundary.call_count,3)
        with patch.object(charts,'graph_jobs',return_value=jobs), \
             patch.object(runtime_artifacts.collect,'boundary',side_effect=ValueError('COLLECT_STOPPED')):
            with self.assertRaisesRegex(ValueError,'COLLECT_STOPPED'):
                runtime_artifacts.publish_graphs(None,'',None,None,None,'parent',date(2026,10,18),'UTC',0,{},'v','face')
        with patch.object(charts,'graph_jobs',return_value=jobs[:1]), patch.object(charts,'revision',return_value='revision'), \
             patch.object(runtime_files,'graph_lookup',return_value=('id',('completed','file'))), \
             patch.object(runtime_artifacts.collect,'boundary',side_effect=[None,ValueError('COLLECT_STOPPED')]):
            with self.assertRaisesRegex(ValueError,'COLLECT_STOPPED'):
                runtime_artifacts.publish_graphs(None,'',None,None,None,'parent',date(2026,10,18),'UTC',0,{},'v','face')

    def test_bucket_calendar_rounding_and_month_bands(self):
        from matplotlib.figure import Figure
        def daily(first,last):
            start,end = date.fromisoformat(first),date.fromisoformat(last)
            keys = (*charts._METRIC_COLUMNS, 'workout_duration_s', 'sessions', 'strength_volume_kg')
            return {'from':first,'to':last,'days':[{'day_key':(start+timedelta(days=i)).isoformat(), **dict.fromkeys(keys)} for i in range((end-start).days+1)]}
        weekly = daily('2026-10-16','2026-10-20')
        weekly['days'][0].update(sleep_s=1,hrv_ms=1.1)
        weekly['days'][1].update(sleep_s=2,hrv_ms=1.2)
        result = charts._bucket(weekly)
        self.assertEqual(result['metrics']['sleep_s'],[{'from':'2026-10-16','to':'2026-10-18','days':2,'mean':2},{'from':'2026-10-19','to':'2026-10-20','days':0,'mean':None}])
        self.assertEqual(result['metrics']['hrv_ms'][0]['mean'],1.2)
        self.assertEqual(charts._bucket(daily('2026-01-31','2026-07-31'))['unit'],'week')
        monthly = daily('2026-01-31','2026-08-01')
        monthly['days'][0]['sessions'] = 2
        monthly['days'][1]['sessions'] = 3
        monthly['days'][2]['sessions'] = 6
        buckets = charts._bucket(monthly)
        self.assertEqual(buckets['unit'],'month')
        self.assertEqual(buckets['metrics']['sessions'][:2],[{'from':'2026-01-31','to':'2026-01-31','days':1,'mean':2.0,'min':2,'max':2},{'from':'2026-02-01','to':'2026-02-28','days':2,'mean':4.5,'min':3,'max':6}])
        self.assertEqual(buckets['metrics']['sessions'][-1],{'from':'2026-08-01','to':'2026-08-01','days':0,'mean':None,'min':None,'max':None})
        values = [{'from':'2026-01-01','to':'2026-01-31','days':17,'mean':7200,'min':3600,'max':10800},
                  {'from':'2026-02-01','to':'2026-02-28','days':0,'mean':None,'min':None,'max':None},
                  {'from':'2026-03-01','to':'2026-03-31','days':1,'mean':14400,'min':12000,'max':18000}]
        data = {'all':{'from':'2025-12-01','to':'2026-04-30','unit':'month','metrics':{'sleep_s':values,'sleep_score':values}}}
        fig = Figure()
        self.assertTrue(charts._all_trend(fig,data,charts._SLEEP,'전체','왼쪽','오른쪽'))
        paths = fig.axes[0].collections[0].get_paths()
        self.assertEqual(len(paths),2)
        self.assertEqual((paths[0].vertices[:,1].min(),paths[0].vertices[:,1].max()),(1,3))
        self.assertEqual(paths[1].vertices[:,1].max(),5)

    def test_54_draw_converts_seconds_to_hours(self):
        from matplotlib.figure import Figure
        values = [{'from':'2026-01-01','to':'2026-01-07','mean':28800}, {'from':'2026-01-08','to':'2026-01-14','mean':25200}]
        data = {'all':{'from':'2026-01-01','to':'2026-01-14','unit':'week','metrics':{'sleep_s':values,'sleep_score':[]}}}
        job = next(job for job in charts.graph_jobs(data) if job[0] == '54-sleep-all.png')
        fig = Figure()
        self.assertTrue(job[2](fig))
        self.assertEqual(list(fig.axes[0].lines[0].get_ydata()),[8,7])

    def test_dst(self):
        data = charts.read_chart_data({'raw':[], 'history_start':None}, [], date(2026,11,2), 'America/New_York')
        self.assertEqual((data['yesterday']['to_ms']-data['yesterday']['from_ms'])/3600000,25)
        data['yesterday']['hr'] = [[data['yesterday']['to_ms']-1000, 70]]
        with tempfile.TemporaryDirectory() as home:
            charts.prepare(home)
        from matplotlib.figure import Figure
        fig = Figure()
        self.assertTrue(charts._yesterday(fig,data))
        self.assertEqual(fig.axes[0].get_xlim(), (0,25))
        self.assertGreater(fig.axes[0].lines[0].get_xdata()[-1],24.99)

    def test_strength_plot_and_limits(self):
        from matplotlib.figure import Figure
        from matplotlib.dates import date2num
        from datetime import timedelta
        item = self.data['strength_progress']['items'][0]
        fig = Figure()
        self.assertTrue(charts._strength(fig,item,self.data['report_date']))
        left,right = fig.axes
        self.assertEqual(list(left.lines[0].get_ydata()), [d['best_weight_kg'] for d in item['days']])
        self.assertEqual([p.get_height() for p in right.patches], [d['volume_kg'] for d in item['days']])
        self.assertEqual(left.patches[0].get_x(),date2num(date.fromisoformat(self.data['report_date'])-timedelta(days=30)))
        self.assertEqual(left.patches[0].get_width(),30)
        data = copy.deepcopy(self.data)
        data['strength_progress']['items'] = [copy.deepcopy(item) for _ in range(50)]
        self.assertEqual(len([n for n,_,_ in charts.graph_jobs(data) if 'strength-' in n and int(n[:2]) < 50]),46)

    def test_empty_all_graphs(self):
        data = charts.read_chart_data({'raw':[], 'history_start':None}, [], date(2026,10,18), 'UTC')
        with tempfile.TemporaryDirectory() as home:
            self.assertTrue(all(charts.render_one(home,n,s,d) is None for n,s,d in charts.graph_jobs(data)))
            self.assertEqual(list((Path(home)/'graph-work').iterdir()),[])

    def test_revision_locality(self):
        changed = copy.deepcopy(self.data)
        changed['daily']['days'][-1]['sleep_s'] = 123
        self.assertNotEqual(charts.revision('50-sleep-30d.png', self.data, 'v','face'), charts.revision('50-sleep-30d.png', changed, 'v','face'))
        self.assertEqual(charts.revision('51-hrv-30d.png', self.data, 'v','face'), charts.revision('51-hrv-30d.png', changed, 'v','face'))
        changed = copy.deepcopy(self.data)
        changed['body_measurements']['items'][0]['values']['weight_kg'] += 1
        self.assertNotEqual(charts.revision('59-body.png',self.data,'v','face'),charts.revision('59-body.png',changed,'v','face'))
        self.assertEqual(charts.revision('51-hrv-30d.png',self.data,'v','face'),charts.revision('51-hrv-30d.png',changed,'v','face'))
        old = charts.revision('59-body.png',self.data,'v','face')
        with patch.object(charts,'RENDERER_VERSION',charts.RENDERER_VERSION+1):
            self.assertNotEqual(old,charts.revision('59-body.png',self.data,'v','face'))

if __name__ == '__main__': unittest.main(verbosity=2)
