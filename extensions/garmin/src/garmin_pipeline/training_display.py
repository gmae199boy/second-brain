"""C1의 한글 표시명과 수행 한 줄. 식별자와 원본 측정은 변경하지 않는다."""
import copy
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

ACTIVITIES = {
    'walking': '걷기', 'treadmill_walking': '트레드밀 걷기', 'indoor_walking': '실내 걷기',
    'running': '달리기', 'treadmill_running': '트레드밀 달리기', 'trail_running': '트레일 달리기',
    'strength_training': '근력 운동', 'hiit': '고강도 인터벌', 'cardio_training': '유산소 운동',
    'cycling': '자전거', 'indoor_cycling': '실내 자전거', 'swimming': '수영',
    'lap_swimming': '수영장 수영', 'hiking': '등산', 'elliptical': '일립티컬',
    'yoga': '요가', 'pilates': '필라테스', 'rowing': '로잉', 'indoor_rowing': '실내 로잉',
    'stair_climbing': '계단 오르기', 'other': '기타 운동',
}


def korean(value):
    return re.sub(r'\([^)]*[A-Za-z][^)]*\)', '', str(value)).strip()


@lru_cache(maxsize=1)
def labels():
    raw = json.loads((Path(__file__).parent / 'labels/exercise_types_ko.json').read_text())
    result = {key: korean(value) for group in ('categories', 'exercises') for key, value in raw[group].items()}
    # 옛 라벨표에서 영어 괄호 제거 뒤 충돌하는 등록 변형도 사람이 구별하게 한다.
    for key, value in list(result.items()):
        if key.endswith('_WHEELCHAIR'):
            result[key] = value + ' · 휠체어'
    by_label = {}
    for key in raw['exercises']:
        by_label.setdefault(result[key], []).append(key)
    for keys in by_label.values():
        if len(keys) > 1:
            for key in keys:
                result[key] += ' · 변형 ' + hashlib.sha256(key.encode()).hexdigest()[:6]
    return result


def display_name(key, missing=None):
    if not key or key == 'UNKNOWN':
        return '유형 미상'
    key = str(key)
    table = labels() | ACTIVITIES
    if key in table:
        return table[key]
    # 기구 접미사가 붙은 canonical 키는 알려진 변형명과 기구를 함께 표시한다.
    for equipment, name in (('DUMBBELL', '덤벨'), ('BARBELL', '바벨'), ('CABLE', '케이블'), ('MACHINE', '머신')):
        suffix = '_' + equipment
        if key.endswith(suffix) and key[:-len(suffix)] in table:
            return table[key[:-len(suffix)]] + ' · ' + name
    if re.search('[가-힣]', key) and not re.search('[A-Za-z]', key):
        return key
    if missing is not None:
        missing.add(key)
    # 모르는 변형을 상위 운동과 합치지 않는다. 영문 코드 대신 안정적인 식별번호로 구분한다.
    identity = hashlib.sha256(key.encode()).hexdigest()[:6]
    return f'미등록 운동(식별 {identity})'


def localize_text(text, extra=()):
    """서술 안의 알려진 코드와 영문 활동명을 치환한다. 기계용 식별자는 호출자가 제외한다."""
    text = str(text or '')
    table = labels() | ACTIVITIES
    for key in extra:
        if key:
            table[str(key)] = display_name(key)
    pattern = r'(?<![A-Za-z0-9_])(' + '|'.join(re.escape(key) for key in sorted(table, key=len, reverse=True)) + r')(?![A-Za-z0-9_])'
    return re.sub(pattern, lambda match: table[match[0]], text)


def localized_measurements(measurements):
    result = copy.deepcopy(measurements)
    missing = set()
    for window in ('current', 'comparison'):
        if not result.get(window):
            continue
        for session in result[window]['sessions']:
            session['display_name'] = display_name(session.get('type'), missing)
            for row in session['sets']:
                row['display_name'] = display_name(row['exercise_key'], missing)
        for row in result[window]['strength']:
            row['display_name'] = display_name(row['exercise_key'], missing)
    result['display'] = {'performance_lines': measurements.get('display', {}).get('performance_lines', performance_lines(result)),
                         'missing_labels': sorted(missing | set(measurements.get('display', {}).get('missing_labels', [])))}
    return result


def _num(value):
    return f'{value:g}' if isinstance(value, (int, float)) and not isinstance(value, bool) else '미기록'


def _load(row):
    kind = row['load_kind']
    if kind == 'bodyweight':
        return '맨몸'
    if kind == 'weighted' and row.get('load_kg') is not None:
        return _num(row['load_kg']) + 'kg'
    if kind == 'assisted':
        return '보조 ' + _num(row.get('load_kg')) + 'kg' if row.get('load_kg') is not None else '보조 무게 미기록'
    return '무게 미기록' if kind == 'missing' else '부하 불명'


def _sets_line(rows):
    groups = []
    for row in rows:
        load = _load(row)
        if not groups or groups[-1][0] != load:
            groups.append((load, []))
        groups[-1][1].append(_num(row.get('reps')))
    return ' / '.join(load + ' × ' + '·'.join(reps) for load, reps in groups)


def _groups(sessions):
    groups = {}
    for session in sorted(sessions, key=lambda s: (s.get('start_at') or s['completed_date'], s['session_id'])):
        for row in session['sets']:
            if row['set_type'] == 'ACTIVE':
                groups.setdefault(row['exercise_key'], {}).setdefault(session['session_id'], []).append(row)
    return groups


def _direction(rows, previous):
    if not previous:
        return '첫 기록 · 비교창 내'
    # 숫자의 관측 방향이며 적정 증량/향상 판정이 아니다. 같은 변형·기구·부하 종류만 비교한다.
    identity = lambda items: {(x.get('equipment'), x.get('variant'), x['load_kind'], x.get('role')) for x in items}
    if identity(rows) != identity(previous) or any(x['load_kind'] not in ('weighted', 'bodyweight') or x.get('reps') is None for x in rows + previous):
        return '비교 불가'
    if len(rows) != len(previous):
        return '비교 불가 · 세트 수 변경'
    loads = {x.get('load_kg') for x in rows}
    old_loads = {x.get('load_kg') for x in previous}
    if len(loads) != 1 or len(old_loads) != 1:
        return '비교 불가 · 혼합 무게'
    current, old = next(iter(loads)), next(iter(old_loads))
    if current != old:
        if current is None or old is None:
            return '비교 불가'
        return f'직전 {_num(old)}kg 대비 무게 ' + ('↑' if current > old else '↓')
    delta = sum(x['reps'] for x in rows) - sum(x['reps'] for x in previous)
    return '직전 대비 반복 ' + ('↑' if delta > 0 else '↓' if delta < 0 else '=')


def performance_lines(measurements):
    current = measurements['current']
    sessions = sorted(current['sessions'], key=lambda s: (s.get('start_at') or s['completed_date'], s['session_id']))
    groups = _groups(sessions)
    comparison = _groups((measurements.get('comparison') or {}).get('sessions', []))
    lines = []
    for key in sorted({*groups, *(x['exercise_key'] for x in current['strength'])}):
        exposures = list(groups.get(key, {}).values())
        summary = next((x for x in current['strength'] if x['exercise_key'] == key), {})
        label = display_name(key)
        if not exposures:
            lines.append(f"{label} {_num(summary.get('exposures'))}회 · {_num(summary.get('sets'))}세트 (비교 불가 · 세트 상세 미기록)")
            continue
        latest = exposures[-1]
        previous = exposures[-2] if len(exposures) > 1 else next(reversed(comparison.get(key, {}).values()), None)
        detail = _sets_line(latest)
        if measurements['scope'] == 'day' and len(exposures) > 1:
            detail = f'{len(exposures)}회 · {sum(map(len, exposures))}세트 · ' + ' / '.join(f'{i}차 ' + _sets_line(rows) for i, rows in enumerate(exposures, 1))
        if measurements['scope'] != 'day':
            detail = f"{_num(summary.get('exposures', len(exposures)))}회 · {_num(summary.get('sets', sum(map(len, exposures))))}세트 · 최근 " + detail
        lines.append(f'{label} {detail} ({_direction(latest, previous)})')
    missing_strength = [s for s in sessions if s.get('type') == 'strength_training' and not any(x['set_type'] == 'ACTIVE' for x in s['sets'])]
    if missing_strength:
        duration = sum(s['duration_s'] for s in missing_strength if s.get('duration_s') is not None)
        recorded = all(s.get('duration_s') is not None for s in missing_strength)
        time = (' · ' + _num(round(duration / 60, 1)) + '분') if recorded else ''
        lines.append(f'근력 운동 {len(missing_strength)}회{time} (세트 상세 미기록 · 비교 불가)')
    for kind in dict.fromkeys(s.get('type') for s in sessions if s.get('type') != 'strength_training'):
        selected = [s for s in sessions if s.get('type') == kind]
        latest = selected[-1]
        bits = []
        if measurements['scope'] != 'day':
            bits.append(f'{len(selected)}회 · 최근')
        elif len(selected) > 1:
            bits.append(f'{len(selected)}회 합계')
        for field, unit, divisor in (('duration_s', '분', 60), ('distance_m', 'm', 1)):
            rows = selected if measurements['scope'] == 'day' else [latest]
            observed = [row[field] for row in rows if row.get(field) is not None]
            if observed:
                total = sum(observed)
                bits.append(_num(round(total / divisor, 1)) + unit + ('(일부 미기록)' if len(observed) != len(rows) else ''))
        hr_rows = selected if measurements['scope'] == 'day' else [latest]
        if len(hr_rows) > 1:
            # 세션 평균을 단순 평균하지 않고 각 세션 평균의 범위로 표시한다.
            hrs = [row['hr_avg'] for row in hr_rows if row.get('hr_avg') is not None]
            hr = (_num(min(hrs)) + '~' + _num(max(hrs))) if hrs else '미기록'
            bits.append('세션 평균 심박 ' + hr + ('(일부 미기록)' if len(hrs) != len(hr_rows) else ''))
        else:
            bits.append('평균 심박 ' + _num(latest.get('hr_avg')))
        zones = [z for row in hr_rows for z in row.get('zones', []) if z.get('seconds') is not None]
        if zones:
            highest = max(z['zone'] or 0 for z in zones)
            seconds = sum(z['seconds'] for z in zones if z['zone'] == highest)
            bits.append(f'존{_num(highest)} {_num(round(seconds / 60, 1))}분')
        if kind and ('walk' in kind or 'treadmill' in kind) and any(row.get('incline') is None for row in hr_rows):
            bits.append('경사 미기록')
        lines.append(display_name(kind) + ' ' + ' · '.join(bits))
    return lines


def enrich_analysis(data, measurements):
    """검증 뒤 호스트가 추가하는 표시 필드. 모델이 만든 수행 줄은 채택하지 않는다."""
    result = copy.deepcopy(data)
    view = localized_measurements(measurements)
    keys = {row['exercise_key'] for window in ('current', 'comparison') if measurements.get(window)
            for row in measurements[window]['strength']}
    keys.update(s.get('type') for s in measurements['current']['sessions'])
    keys.update(row['exercise_key'] for window in ('current', 'comparison') if measurements.get(window)
                for session in measurements[window]['sessions'] for row in session['sets'])
    def visit(value, field=None):
        if isinstance(value, dict):
            return {key: visit(item, key) for key, item in value.items()}
        if isinstance(value, list):
            return [visit(item, field) for item in value]
        if isinstance(value, str) and field in {'summary', 'report_md', 'judgments', 'evidence', 'next_checks', 'headline', 'assessment', 'observed_change', 'interpretation', 'observation_reason', 'decision_reason', 'action', 'reason', 'condition', 'context', 'effect_on_training', 'uncertainty', 'detail', 'recommendations', 'trend_line'}:
            return localize_text(value, keys)
        return value
    result = visit(result)
    result['performance_lines'] = view['display']['performance_lines']
    result['missing_labels'] = view['display']['missing_labels']
    return result
