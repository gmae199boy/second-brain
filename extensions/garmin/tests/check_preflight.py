"""합성 다섯 후보에 대해 보존과 집계의 독립 기대값을 확인한다."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from preflight import analyze, readiness, public_report, classify_files, unit_risks, estimate_candidates
from reports import write_reports
from reader import read_snapshot
from fixtures import five_candidates, capture_manifest
from capture_manifest import load_capture


def sha(path):
    return hashlib.sha256(path.read_bytes()).digest()


def main():
    with TemporaryDirectory() as tmp:
        paths = five_candidates(Path(tmp))
        manifest, contents = capture_manifest(Path(tmp), paths)
        capture = load_capture(str(manifest.resolve()))
        assert capture['datasets'] == {role: path.resolve() for role, path in paths.items()}
        for change in ('duplicate', 'traversal', 'version', 'size'):
            broken = json.loads(json.dumps(contents))
            if change == 'duplicate': broken['datasets'][0]['source'] = broken['datasets'][1]['source']
            if change == 'traversal': broken['datasets'][0]['snapshot'] = '../outside'
            if change == 'version': broken['version'] = 2
            if change == 'size': broken['files'][0]['bytes'] += 1
            manifest.write_text(json.dumps(broken))
            try:
                load_capture(str(manifest.resolve()))
                raise AssertionError('잘못된 manifest를 거부하지 않았다')
            except ValueError as exc:
                assert str(exc) == 'PREFLIGHT_INVALID'
        manifest.write_text(json.dumps(contents))
        before = {role: sha(path) for role, path in paths.items()}
        d1 = read_snapshot(paths['D1'])
        assert d1['schema'] == 15
        assert d1['tables']['day_summary']['rows'] == [{'date': '2026-01-01', 'body': None, 'extra': '원문'}]
        assert d1['tables']['raw_response']['rows'][0]['raw'] == '{"userProfileId": 12345, "한글": null, "order": [2,1]}'
        assert 'day_summary' not in read_snapshot(paths['D2'])['tables']
        report = analyze(paths)
        raw = report['tables']['raw_response']
        assert (raw['union'], raw['conflicts'], raw['raw_conflicts']) == (2, 1, 1)
        assert raw['pairs']['D2:D4'] == {'overlap': 1, 'conflicts': 1, 'left_only': 0, 'right_only': 0, 'raw_conflicts': 1, 'metadata_conflicts': 1}
        assert raw['pairs']['D2:D5']['raw_conflicts'] == 0
        assert raw['pairs']['D2:D5']['metadata_conflicts'] == 1
        assert raw['metadata_conflicts'] == 1
        assert raw['only']['D5'] == 1
        assert report['tables']['daily_metric']['conflicts'] == 1
        assert report['tables']['day_summary']['pairs']['D2:D1'] is None
        assert report['datasets']['D1']['tables']['raw_response']['count'] == 1
        assert report['datasets']['D3']['tables']['raw_response']['count'] == 0
        assert report['datasets']['D5']['tables']['raw_response']['count'] == 2
        assert report['tables']['auth_event']['dataset_local']
        assert report['tables']['auth_event']['only']['D3'] == 1
        assert report['tables']['raw_response']['authority_v1'][0]['selected'] == 'D2'
        assert report['datasets']['D1']['tables']['raw_response']['range']['min'] == '2026-01-01'
        assert report['datasets']['D1']['account']['confirmed']
        assert not report['datasets']['D3']['account']['confirmed']
        assert not report['datasets']['D5']['account']['confirmed']
        assert report['authority_order'] == ['D2', 'D1', 'D4', 'D5', 'D3']
        assert report['unselected_keys'] == 0
        meta = {'version': 1, 'core': 23, 'expected_core': 23, 'extension': 1, 'migrations': [1], 'applied_migrations': [1], 'manifest_version': '1', 'abi': 1}
        ready = readiness(meta, 'brain_ext_garmin', True, [])
        assert ready['ready'] and not readiness(meta, 'brain_ext_garmin', False, [])['ready']
        public = public_report(report, ready)
        categories = classify_files([{'source': source, 'snapshot': str(i), 'bytes': 1} for i, source in enumerate(['reports/a.md', 'data/facts/a.json', 'reports/a.png', 'data/report-input/a.json', 'config/settings.toml', 'data/a.log', 'unknown.bin'])])
        estimates = estimate_candidates(report, categories, 2)
        assert {key: estimates[key] for key in ('preservation_candidates', 'dataset_candidates', 'mapping_candidates', 'file_request_candidates', 'existing_mapping_count', 'total_insert_known')} == {'preservation_candidates': 21, 'dataset_candidates': 5, 'mapping_candidates': 21, 'file_request_candidates': 4, 'existing_mapping_count': 2, 'total_insert_known': False}
        assert categories['expected_requests'] == 4 and all(categories['groups'][group] == 1 for group in categories['groups'])
        catalog = [{'metric': 'steps', 'unit': 'count', 'mappings': [{'table': 'daily_metric', 'column': 'steps', 'factor': 1}]}]
        assert any(item['column'] == 'steps' and item['catalog'][0]['unit'] == 'count' for item in unit_risks(report, catalog))
        assert report['datasets']['D1']['tables']['day_summary']['null_counts']['body'] == 1
        assert any(item['table'] == 'day_summary' and 'extra' in item.get('columns', []) for item in report['unsupported'])
        assert public['counts']['datasets'] == 5 and public['counts']['raw_conflict_keys'] == 1
        assert '12345' not in json.dumps(public) and '2026-01-01' not in json.dumps(public)
        output = Path(tmp) / 'extension'
        output.mkdir(mode=0o700)
        # 임시 디렉터리의 실제 경로를 사용하여 운영체제의 경로 별칭을 제거한다.
        work = '00000000-0000-7000-8000-000000000001'
        write_reports(str(output.resolve()), work, report, public)
        destination = output / 'reports' / work
        assert (destination / 'private.json').stat().st_mode & 0o777 == 0o600
        assert destination.stat().st_mode & 0o777 == 0o700
        assert json.loads((destination / 'public.json').read_text()) == public
        bad = Path(tmp) / 'link'
        bad.symlink_to(output, target_is_directory=True)
        try:
            write_reports(str(bad), work, report, public)
            raise AssertionError('심볼릭 링크를 거부하지 않았다')
        except OSError:
            pass
        assert before == {role: sha(path) for role, path in paths.items()}
        for role in ('D1', 'D2'):
            with sqlite3.connect(paths[role]) as conn:
                for key, body, checked in [('body', 'a' if role == 'D1' else 'b', 1), ('metadata', 'a', 1 if role == 'D1' else 2), ('both', 'a' if role == 'D1' else 'b', 1 if role == 'D1' else 2)]:
                    conn.execute('insert into raw_response values (?,?,?,?,?,?,?)', ('day', key, 'test', body, 1, checked, 'test'))
        comparison = analyze(paths)['tables']['raw_response']['pairs']['D2:D1']
        assert comparison['raw_conflicts'] == 2 and comparison['metadata_conflicts'] == 2 and comparison['conflicts'] == 3
        for version in (9, 16):
            with sqlite3.connect(paths['D3']) as conn:
                conn.execute('pragma user_version=' + str(version))
            try:
                read_snapshot(paths['D3'])
                raise AssertionError('지원하지 않는 schema를 거부하지 않았다')
            except ValueError as exc:
                assert str(exc) == 'PREFLIGHT_SCHEMA_UNSUPPORTED'
    print('합성 reader와 충돌 집계 성공')


if __name__ == '__main__':
    main()
