"""Contract checks for the immutable normalization publisher."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from batch_import import canonical, encoded
from reader import SQLiteText
from normalize_store import (observations, raw_revision, revision_for, chunks, day_revision, item_batch, day_batch)

catalog = [
    {'metric':'daily_metric.steps','type':'number','unit':'count','mappings':[{'table':'daily_metric','column':'steps','factor':1}]},
    {'metric':'hr_sample.bpm','type':'number','unit':'bpm','mappings':[{'table':'hr_sample','column':'bpm','factor':1}]},
    {'metric':'exercise_set.weight_g','type':'number','unit':'kg','mappings':[{'table':'exercise_set','column':'weight_g','factor':.001}]},
]
args = dict(catalog=catalog,dataset='collect-test',account='1',zone='Asia/Seoul',revision='abc',fetched_ms=1760000000000,batch='batch')
rows = observations({'daily_metric':[{'day_key':'2026-10-15','steps':None}], 'hr_sample':[{'day_key':'2026-10-15','ts_ms':1000,'bpm':60}], 'exercise_set':[{'activity_id':42,'set_index':2,'weight_g':40000,'day_key':'2026-10-15'}]},**args)
assert len(rows)==3
for row, values in zip(rows, [('2026-10-15',), ('2026-10-15',1000), (42,2)]):
    assert row['key']==canonical([encoded(SQLiteText(v.encode('utf-8'), 'utf-8') if isinstance(v,str) else v) for v in values])
assert rows[0]['value'] is None and rows[0]['day']=='2026-10-15'
assert rows[1]['day'] is None and rows[1]['observed'].isoformat()=='1970-01-01T00:00:01+00:00'
assert rows[2]['activity']=='42' and rows[2]['value']==40
assert observations({'daily_metric':[{'day_key':'2026-10-15','steps':1}]}, **args)[0]['id'] == observations({'daily_metric':[{'day_key':'2026-10-15','steps':2}]}, **args)[0]['id']
sha=raw_revision('A')
assert revision_for('A',1,[])==sha
assert revision_for('A',1,[(sha,1)])==sha
assert revision_for('A',3,[(sha,1)])==sha+':3'
assert revision_for('A',3,[(sha,1),(sha+':3',3)])==sha+':3'
assert [len(c) for c in chunks(list(range(1001)))]==[500,500,1]
assert chunks([])==[[]]
inputs=[dict(scope='day',key='x',endpoint='a',revision='1',fetched_at_ms=1),dict(scope='activity',key='1',endpoint='b',revision='2',fetched_at_ms=2)]
assert day_revision(inputs,'labels')==day_revision(list(reversed(inputs)),'labels')
assert day_revision(inputs,'labels') != day_revision([inputs[0] | {'fetched_at_ms': 3}, inputs[1]],'labels')
assert item_batch('d','day','x','a','r') != day_batch('d','x','r')
print('normalize storage contract: ok')
