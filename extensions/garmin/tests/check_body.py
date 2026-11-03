"""Pure body validation and per-field timestamp behavior."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import body

first = {'schema_version': 1, 'measured_on': '2026-10-15', 'values': {'weight_kg': 80, 'bmi': 24}, 'value_mtime_ns': {'weight_kg': 5, 'bmi': 10}, 'source_files': ['inbox/inbody/a.png']}
second = {'schema_version': 1, 'measured_on': '2026-10-15', 'values': {'weight_kg': 81, 'bmi': 25}, 'value_mtime_ns': {'weight_kg': 5, 'bmi': 9}, 'source_files': ['inbox/inbody/b.png']}
result = body.merge(first, second)
assert result['values'] == {'weight_kg': 81, 'bmi': 24}
assert result['value_mtime_ns'] == {'weight_kg': 5, 'bmi': 10}
assert result['source_files'] == first['source_files'] + second['source_files']
assert first['values']['weight_kg'] == 80
for raw in ('{"x": NaN}', '{"x": Infinity}', '{"x": 1, "x": 2}', '{"x": 1e999}'):
    try:
        body.parse(raw)
    except ValueError:
        pass
    else:
        raise AssertionError(raw)
print('body validation: ok')

import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / 'inbox' / 'inbody').mkdir(parents=True)
    source = root / 'inbox' / 'inbody' / 'synthetic.png'
    source.write_bytes(b'synthetic source')
    contents, identity = body.read_source(root, 'inbox/inbody/synthetic.png')
    assert contents == b'synthetic source' and identity['mtime_ns'] == source.stat().st_mtime_ns
    (root / 'inbox' / 'inbody' / 'link').symlink_to(source)
    for invalid in ('inbox/inbody/link', 'inbox/inbody/../synthetic.png', 'else/inbody/synthetic.png', 'inbox/inbody/.hidden'):
        try:
            body.read_source(root, invalid)
        except (ValueError, OSError):
            pass
        else:
            raise AssertionError(invalid)
merged, provenance = body.merge_with_provenance(first, {'weight_kg': ['old'], 'bmi': ['old']}, second, {'weight_kg': ['new'], 'bmi': ['new']})
assert merged == result and provenance == {'weight_kg': ['new'], 'bmi': ['old']}
integer_doc = {'schema_version':1,'measured_on':'2026-10-15','values':{'inbody_score':78.0},'value_mtime_ns':{'inbody_score':1},'source_files':['inbox/inbody/synthetic.png']}
assert type(body.merge(None,integer_doc)['values']['inbody_score']) is int
