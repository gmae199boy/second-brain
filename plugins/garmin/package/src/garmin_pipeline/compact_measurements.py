"""Model view of sealed C1: keep every session, set, window and missing value.

Only dense heart-rate samples become computed summaries. Original C1 stays the
validation authority; the index names original pointers, never compact pointers.
"""
import copy
import json
import shutil
from pathlib import Path


def build(measurements):
    from garmin_pipeline.training_display import localized_measurements
    result = localized_measurements(measurements)
    index = []
    for window in ('current', 'comparison'):
        if result.get(window) is None:
            continue
        for i, session in enumerate(result[window]['sessions']):
            pointer = f'training_measurements.json#/{window}/sessions/{i}'
            index.append({'session_id': session['session_id'], 'window': window,
                          'source_ref': pointer, 'sets_ref': pointer + '/sets',
                          'heart_rate_ref': pointer + '/heart_rate'})
            samples = session.pop('heart_rate', [])
            values = [row['bpm'] for row in samples if isinstance(row.get('bpm'), (int, float))
                      and not isinstance(row['bpm'], bool)]
            session['heart_rate_summary'] = {
                'source_ref': pointer + '/heart_rate', 'sample_count': len(samples),
                'valid_count': len(values), 'min_bpm': min(values) if values else None,
                'max_bpm': max(values) if values else None,
                'mean_bpm': sum(values) / len(values) if values else None,
                'first_at': samples[0].get('at') if samples else None,
                'last_at': samples[-1].get('at') if samples else None,
                'quality': 'unknown',
                'limitation': 'sample_count_is_not_zone_duration',
            }
    return {'view_schema_version': 'training_measurements_compact_v1',
            'measurements': result, 'evidence_ref_index': index,
            'reference_contract': 'All source_ref pointers resolve against original training_measurements.json; append original field paths to indexed session bases. Summaries cite heart_rate_ref, not heart_rate_summary.'}


def prepare(root, inputs, destination, measurements):
    destination.mkdir(mode=0o700)
    payload = json.dumps(build(measurements), ensure_ascii=False, separators=(',', ':'))
    (destination / 'training_measurements.compact.json').write_text(payload, encoding='utf-8')
    # C1 already includes attribution, all training data, windows, recovery and coverage.
    # Include profile and same-scope past hypotheses; do not duplicate raw exports/digest.
    for item in inputs:
        folder = Path(root) / item
        if not folder.is_dir():
            continue
        for name in ('profile.json', 'profile.md', 'scope.json', 'previous.json'):
            if (folder / name).is_file():
                shutil.copyfile(folder / name, destination / name)
        previous = folder / 'previous_evaluations' / 'day.json'
        if measurements['scope'] == 'day' and previous.is_file():
            shutil.copyfile(previous, destination / 'previous.json')
    return [str(destination.relative_to(root))]
