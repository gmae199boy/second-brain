"""Build synthetic v2 output from the exact C1 file supplied by the host."""

def scope_output(measurements, result):
    scope = measurements['scope']
    current = measurements['current']
    sessions = current['sessions']
    keys = {row['exercise_key'] for row in current['strength']}
    keys.update(row['exercise_key'] for session in sessions for row in session['sets'] if row['set_type'] == 'ACTIVE')
    aerobic, limitations = [], []
    for session in sessions:
        kind = session['type']
        if kind == 'strength_training':
            continue
        missing_grade = bool(kind and ('walk' in kind or 'treadmill' in kind) and session['incline'] is None)
        if missing_grade:
            limitations.append({'reason_code': 'incline_unrecorded', 'scope': scope,
                'affected_judgment': f'aerobic_findings[{len(aerobic)}]', 'detail': '합성 경사 미기록'})
        aerobic.append({'activity_type': kind, 'activity_refs': [session['session_id']],
            'observed_change': '합성 수행 관측', 'interpretation': '합성 심박 기준 평가',
            'comparison_status': 'insufficient_history', 'comparison_conditions': '합성 비교 없음',
            'intensity_basis': 'hr_summary', 'grade_status': 'unrecorded' if missing_grade else 'not_applicable',
            'evidence_refs': []})
    return {**result, 'schema_version': 'garmin.scope_analysis.v2', 'scope': scope,
        'range': {'start': current['from'], 'end': current['to'], 'timezone': measurements['timezone']},
        'data_cutoff': measurements['data_cutoff'], 'snapshot_id': measurements['snapshot_id'],
        'measurements_version': measurements['schema_version'], 'profile_snapshot_id': measurements['profile']['snapshot_id'],
        'training_summary': {'headline': 'synthetic ' + scope, 'assessment': '합성 수행을 확인한다.',
            'state': 'performed' if sessions else 'no_workout'},
        'strength_findings': [{'exercise_key': key, 'observation_refs': [], 'observed_change': '합성 수행 관측',
            'comparison_status': 'insufficient', 'interpretation': '합성 비교 없음', 'confidence': 'low',
            'missing_evidence': []} for key in sorted(keys)],
        'aerobic_findings': aerobic,
        'progression': {'observed_progress': 'not_comparable', 'observation_reason': '합성 비교 없음',
            'overload_decision': 'maintain', 'decision_reason': '합성 조건 유지', 'missing_evidence': [], 'evidence_refs': []},
        'next_workout_actions': [], 'recovery_context': [], 'evidence_refs': [], 'limitations': limitations,
        'message': None if result['status'] != 'ok' else {'schema_version': 2, 'headline': 'synthetic ' + scope,
            'recommendations': [], 'trend_line': '합성 기간 관측', 'limitations': [], 'evidence_refs': []}}
