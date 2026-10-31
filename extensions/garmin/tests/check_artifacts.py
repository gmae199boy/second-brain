"""합성 version2 inventory와 파일 경계·분류를 독립적으로 검사한다."""
import json
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import artifacts
from artifacts import MAX_BYTES, classify, read_relative, stage, locator_for, encode_identity, decode_identity
from capture_manifest import load_capture
from preflight import classify_files
from metadata_codec import encode_metadata, decode_metadata, safe_dumps
from analysis_codec import project_analysis
from fixtures import artifact_capture, capture_manifest, five_candidates

for key in ['normal', 'key' + chr(0xd800), '~garmin-key-v1~literal', '~garmin-key-v1~a2V5']:
    assert decode_identity(encode_identity(key)) == key
assert encode_identity('normal') == 'normal'
assert len({encode_identity(k) for k in ['key' + chr(0xd800), '~garmin-key-v1~literal', 'normal']}) == 3

normal = {'nested': {'key': 'ordinary'}, 'literal': 'brain-metadata-v1'}
assert encode_metadata(normal) == (normal, None)
assert decode_metadata(*encode_metadata(normal)) == normal
original = {'필드\0키': {'값': '원형\0값'}, 'literal': 'brain-metadata-v1'}
display, raw = encode_metadata(original)
assert display == {} and raw is not None and decode_metadata(display, raw) == original
assert decode_metadata({'literal': 'brain-metadata-v1'}, None) == {'literal': 'brain-metadata-v1'}
ordinary = {'한글':'원문', 'emoji':'😀'}
assert safe_dumps(ordinary,ensure_ascii=False,sort_keys=True,separators=(',',':')) == json.dumps(ordinary,ensure_ascii=False,sort_keys=True,separators=(',',':'))
surrogate = {'key' + chr(0xd800): 'value' + chr(0xdfff)}
assert json.loads(safe_dumps(surrogate,ensure_ascii=False)) == surrogate
assert decode_metadata(*encode_metadata(surrogate)) == surrogate
analysis_value = '비ASCII' + chr(0xd800) + '\0끝'
display, raw, encoding = project_analysis(analysis_value)
assert display == '비ASCII��끝' and encoding == 'json-string-v1' and json.loads(raw) == analysis_value
assert project_analysis('정상\0문자')[2] == 'utf-8'
assert locator_for('dataset','artifact','key','a'*64) != locator_for('dataset','evaluation','key','a'*64)


with tempfile.TemporaryDirectory(prefix='brain-artifacts-') as tmp:
    root = Path(tmp).resolve()
    v1root=root/'legacy'; v1root.mkdir()
    v1path,v1value=capture_manifest(v1root,five_candidates(v1root))
    v1expected=hashlib.sha256(json.dumps(v1value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    assert load_capture(v1path)['private']['fingerprint'] == v1expected
    manifest = artifact_capture(root)
    capture = load_capture(manifest)
    assert capture['private']['version'] == 2
    original_manifest=json.loads(manifest.read_bytes())
    old_fingerprint=hashlib.sha256(json.dumps(original_manifest,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    assert capture['private']['fingerprint'] == old_fingerprint
    files = capture['private']['files']
    assert [classify(f) for f in files] == ['report','facts','image','input','log','log','log','log','config','config','unknown']
    assert [i['state'] for i in capture['private']['inventory']] == ['present','empty','absent']
    cases = [
        {'source':'report.md','snapshot':'a','bytes':1,'category':'unknown'},
        {'source':'report.md','snapshot':'b','bytes':1,'category':'config'},
        {'source':'secret.log','snapshot':'c','bytes':1,'category':'report'},
        {'source':'machine.toml','snapshot':'d','bytes':1,'category':'report'},
        {'source':'data.json','snapshot':'e','bytes':1,'category':'input'},
        {'source':'settings.log','snapshot':'f','bytes':1,'category':'config'},
        {'source':'mystery.log','snapshot':'g','bytes':1,'category':'unknown'},
    ]
    classified = classify_files(cases)
    assert [f['category'] for f in classified['files']] == [classify(f) for f in cases] == ['unknown','config','log','config','input','config','unknown']
    assert classified['expected_requests'] == 2
    assert [f['reason'] for f in classified['files']] == ['분류 확인 필요','비밀·기계 설정','비밀 검사 필요','비밀·기계 설정',None,'비밀·기계 설정','분류 확인 필요']

    report, report_hash = read_relative(str(root), 'report.md', files[0]['bytes'])
    assert report == b'# synthetic report\n' and report_hash == hashlib.sha256(report).hexdigest()
    home=root/'home'; home.mkdir(mode=0o700)
    first=stage(str(home),'dataset','artifact','key',report)
    assert stage(str(home),'dataset','artifact','key',report)==first
    assert (home/'staging'/first).read_bytes()==report
    (root/'outside-link').symlink_to(root/'report.md')
    os.mkfifo(root/'pipe')
    with (root/'large').open('wb') as large: large.truncate(MAX_BYTES + 1)
    large_data, large_hash = read_relative(str(root),'large',MAX_BYTES+1)
    assert large_data is None and large_hash == hashlib.sha256(bytes(MAX_BYTES+1)).hexdigest()
    # 실제 fd의 첫 chunk 뒤 파일을 늘려 예상 길이 초과 시 즉시 중단한다.
    growing = root/'growing'; growing.write_bytes(b'a' * (2 * 1024 * 1024))
    real_fdopen = os.fdopen
    reads = []
    class GrowingStream:
        def __init__(self, stream): self.stream = stream
        def __enter__(self): return self
        def __exit__(self, *args): self.stream.close()
        def read(self, size):
            chunk = self.stream.read(size); reads.append(len(chunk))
            if len(reads) == 1:
                with growing.open('ab') as output: output.write(b'b' * (4 * 1024 * 1024))
            return chunk
    def wrapped_fdopen(fd, mode, **kwargs):
        return GrowingStream(real_fdopen(fd, mode, **kwargs))
    with patch.object(artifacts.os, 'fdopen', wrapped_fdopen):
        try: read_relative(str(root), 'growing', 2 * 1024 * 1024)
        except ValueError as exc: assert str(exc) == 'IMPORT_INVALID'
        else: raise AssertionError('growing input accepted')
    assert reads == [1024 * 1024] * 3
    for name,size in [('outside-link',len(report)),('../report.md',len(report)),('report.md',len(report)+1),('pipe',0)]:
        try: read_relative(str(root),name,size)
        except (OSError,ValueError): pass
        else: raise AssertionError('unsafe input accepted')
    value=json.loads(manifest.read_text())
    value['files'][1]['created_at']='2026-01-02T03:04:05'
    manifest.write_text(json.dumps(value))
    try: load_capture(manifest)
    except ValueError: pass
    else: raise AssertionError('timezone-free creation accepted')
    value['files'][1]['created_at']='2026-01-02T03:04:05+09:00'
    value['files'][2]['relations'][0]['analysis_key']='missing'
    manifest.write_text(json.dumps(value))
    try: load_capture(manifest)
    except ValueError: pass
    else: raise AssertionError('unknown relation accepted')
print('합성 artifact 분류·inventory·관계·경계 통과')
