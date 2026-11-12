"""운동 분석 v2의 참조 무결성과 입력 계약을 확인한다."""

from pathlib import Path
import json
import re

VERSION = 'garmin.scope_analysis.v2'
SCHEMA = 'training_analysis_output_v2.schema.json'


def measurements_for_inputs(root, inputs, scope=None):
    """C1이 있는 정기 기간만 새 계약을 쓴다. custom·구 입력은 유지한다."""
    if scope == 'custom':
        return None
    for folder in inputs:
        path = Path(root) / folder / 'training_measurements.json'
        if path.is_file():
            return json.loads(path.read_text(encoding='utf-8'))
    return None


def _pointer(document, pointer):
    if not pointer.startswith('training_measurements.json#/'):
        raise ValueError('evidence source')
    current = document
    for token in pointer.split('#', 1)[1].split('/')[1:]:
        key = token.replace('~1', '/').replace('~0', '~')
        if isinstance(current, list):
            if not key.isdecimal():
                raise ValueError('evidence index')
            current = current[int(key)]
        else:
            current = current[key]
    return current


def validate(data, measurements=None):
    """오류 값·건강 수치 대신 고정 진단만 반환한다."""
    if data.get('schema_version') != VERSION:
        return
    if data['status'] == 'ok' and data['message'] is None:
        raise ValueError('missing training message')
    if data['status'] == 'failed' and data['message'] is not None:
        raise ValueError('failed training message')
    refs = [item['ref'] for item in data['evidence_refs']]
    if len(refs) != len(set(refs)):
        raise ValueError('duplicate evidence reference')
    known = set(refs)
    groups = [data['progression'], *data['next_workout_actions'],
              *data['recovery_context'], *data['aerobic_findings']]
    if data['message'] is not None:
        groups.append(data['message'])
    used = [ref for group in groups for ref in group['evidence_refs']]
    used.extend(ref for finding in data['strength_findings'] for ref in finding['observation_refs'])
    if not set(used).issubset(known):
        raise ValueError('unknown evidence reference')
    for limitation in data['limitations']:
        target = limitation['affected_judgment']
        match = re.fullmatch(r'(strength_findings|aerobic_findings|next_workout_actions|recovery_context)\[(\d+)\]', target)
        valid = target in ('training_summary', 'progression', 'message')
        if match:
            valid = int(match[2]) < len(data[match[1]])
        if not valid or limitation['scope'] != data['scope']:
            raise ValueError('invalid limitation target')
    if measurements is None:
        return
    expected = {
        'scope': measurements['scope'],
        'range': {'start': measurements['current']['from'], 'end': measurements['current']['to'],
                  'timezone': measurements['timezone']},
        'data_cutoff': measurements['data_cutoff'],
        'snapshot_id': measurements['snapshot_id'],
        'measurements_version': measurements['schema_version'],
        'profile_snapshot_id': measurements['profile']['snapshot_id'],
    }
    if any(data[key] != value for key, value in expected.items()):
        raise ValueError('measurement header mismatch')
    sessions = measurements['current']['sessions']
    if data['status'] == 'ok':
        if bool(sessions) == (data['training_summary']['state'] == 'no_workout'):
            raise ValueError('workout state mismatch')
        exercises = {row['exercise_key'] for session in sessions for row in session['sets']
                     if row['set_type'] == 'ACTIVE'}
        exercises.update(row['exercise_key'] for row in measurements['current']['strength'])
        if not exercises.issubset({row['exercise_key'] for row in data['strength_findings']}):
            raise ValueError('missing strength finding')
        aerobic_sessions = {session['session_id']: session for session in sessions
                            if session['type'] != 'strength_training'}
        covered = set()
        for index, finding in enumerate(data['aerobic_findings']):
            activity_refs = finding['activity_refs']
            if not activity_refs or any(ref not in aerobic_sessions for ref in activity_refs):
                raise ValueError('invalid activity reference')
            selected = [aerobic_sessions[ref] for ref in activity_refs]
            if any(session['type'] != finding['activity_type'] for session in selected):
                raise ValueError('activity type mismatch')
            covered.update(activity_refs)
            needs_grade = any(session['type'] and ('walk' in session['type'] or 'treadmill' in session['type'])
                              and session['incline'] is None for session in selected)
            # 혼합 행은 미기록 조건을 우선 표시하거나 세션별 행으로 나눈다.
            if needs_grade and (finding['grade_status'] != 'unrecorded' or not any(
                    row['reason_code'] == 'incline_unrecorded'
                    and row['affected_judgment'] == f'aerobic_findings[{index}]'
                    for row in data['limitations'])):
                raise ValueError('missing incline limitation')
        if covered != set(aerobic_sessions):
            raise ValueError('missing aerobic finding')
    try:
        for item in data['evidence_refs']:
            _pointer(measurements, item['source_ref'])
    except (KeyError, IndexError, TypeError, ValueError):
        raise ValueError('unresolved evidence source') from None
