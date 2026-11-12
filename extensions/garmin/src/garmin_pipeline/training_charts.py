"""C1 측정 snapshot만으로 만드는 기간별 운동 그림.

DB·원문·AI 평가를 읽지 않는다. canonical key와 load_kind를 유지하고,
기록되지 않은 reps·부하·세트 시작 시각은 추정하지 않는다.
"""
import hashlib
import json
import math
import os
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SCOPES = ('day', '7d', '30d', 'all')
LABELS = dict(zip(SCOPES, ('1일', '7일', '30일', '전체')))
RENDERER_VERSION = 'training-charts-v3'
MAX_EXERCISES = 8


@dataclass(frozen=True)
class TrainingGraph:
    name: str
    title: str
    scope: str
    range: dict
    metric: str
    exercise_keys: tuple = ()
    omitted_exercises: int = 0

    def metadata(self):
        return {'scope': self.scope, 'range': self.range, 'metric': self.metric,
                'exercise_keys': list(self.exercise_keys),
                'omitted_exercises': self.omitted_exercises,
                'renderer_version': RENDERER_VERSION}


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _key(value):
    # JSON 표준 직렬화로 category/name 조합의 경계를 보존한다.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _load_label(row):
    kind, load = row['load_kind'], row.get('load_kg')
    if kind == 'bodyweight':
        return '맨몸'
    if kind == 'weighted' and _number(load) and load > 0:
        return f'{load:g} kg'
    if kind == 'assisted':
        return f'보조 {load:g} kg' if _number(load) else '보조·무게 미기록'
    return '무게 미기록' if kind == 'missing' else '부하 불명'


def _epoch(value):
    if value is None:
        return None
    instant = datetime.fromisoformat(value)
    if instant.utcoffset() is None:
        raise ValueError('timestamp requires timezone')
    return instant.timestamp() * 1000


def adapt_measurements(measurements):
    """W3 C1 스키마의 current 창만 renderer용 얇은 모델로 투영한다."""
    if measurements['schema_version'] != 'training_measurements_v1':
        raise ValueError('invalid measurements version')
    scope = measurements['scope']
    if scope not in SCOPES:
        raise ValueError('invalid training scope')
    from garmin_pipeline.training_display import localized_measurements
    measurements = localized_measurements(measurements)
    current = measurements['current']
    window = {'start': current['from'], 'end': current['to'], 'timezone': measurements['timezone']}
    if window['start'] > window['end']:
        raise ValueError('invalid measurement range')
    sessions = []
    for session in current['sessions']:
        # 비교 창과 미완료 활동은 current 실적으로 혼입시키지 않는다.
        if session['status'] != 'completed' or not window['start'] <= session['completed_date'] <= window['end']:
            continue
        rows = []
        for row in session['sets']:
            rows.append(dict(row, label=row['display_name'], is_rest=row['set_type'] != 'ACTIVE',
                             start_ms=_epoch(row['start_at']), end_ms=_epoch(row['end_at'])))
        samples = sorted([(_epoch(sample['at']), sample['bpm']) for sample in session['heart_rate']
                          if sample['at'] is not None and _number(sample['bpm'])])
        zones = {int(zone['zone']): zone['seconds'] for zone in session['zones']
                 if _number(zone['zone']) and zone['zone'] in range(1, 6)}
        sessions.append({'session_id': session['session_id'], 'date': session['completed_date'],
                         'start_ms': _epoch(session['start_at']), 'end_ms': _epoch(session['end_at']),
                         'label': session['display_name'], 'zone_lows': [next((z['low_bpm'] for z in session['zones'] if z['zone'] == i), None) for i in range(1, 6)],
                         'sets': rows, 'hr_samples': samples,
                         'zone_seconds': [zones.get(index) for index in range(1, 6)] if zones else []})
    return {'scope': scope, 'range': window, 'snapshot_id': measurements['snapshot_id'],
            'data_cutoff': measurements['data_cutoff'], 'sessions': sessions,
            'strength': current['strength']}


def render(measurements, out_dir, *, cache_dir=None):
    return render_model(adapt_measurements(measurements), out_dir, cache_dir=cache_dir)


def _group_sets(sessions):
    groups = {}
    for session in sessions:
        for row in session['sets']:
            if row['is_rest']:
                continue
            key = _key(row['exercise_key'])
            group = groups.setdefault(key, {'key': row['exercise_key'], 'label': row['label'],
                                            'sets': [], 'sessions': set()})
            group['sessions'].add(session['session_id'])
            group['sets'].append(dict(row, session_id=session['session_id'], date=session['date'], session_start_ms=session['start_ms']))
    for group in groups.values():
        group['sets'].sort(key=lambda row: (row['date'], row['session_start_ms'] if row['session_start_ms'] is not None else float('inf'), str(row['session_id']), row['order']))
    return groups


def _groups(model):
    groups = _group_sets(model['sessions'])
    for summary in model['strength']:
        key = _key(summary['exercise_key'])
        group = groups.setdefault(key, {'key': summary['exercise_key'], 'label': summary['display_name'],
                                        'sets': [], 'sessions': set()})
        group['summary'] = summary
    return groups


def _frequency(group):
    return group.get('summary', {}).get('exposures', len(group['sessions']))


def _pages(model):
    if model['scope'] != '30d':
        return [], 0
    groups = _groups(model)
    # summary의 대표/누적 횟수가 아니라 실제 30일 세션 두 건 이상만 그린다.
    eligible = [key for key in groups if len(groups[key]['sessions']) >= 2]
    ordered = sorted(eligible, key=lambda key: (-len(groups[key]['sessions']), key))
    omitted = max(0, len(ordered) - MAX_EXERCISES)
    ordered = ordered[:MAX_EXERCISES]
    size = max(1, math.ceil(len(ordered) / 3))
    return [[groups[key] for key in ordered[i:i + size]] for i in range(0, len(ordered), size)], omitted


def _heading(model):
    window = model['range']
    return f"{LABELS[model['scope']]} · {window['start']} ~ {window['end']} · {window['timezone']}"


def _session_trend(axes, group):
    sessions = {}
    for row in group['sets']:
        sessions.setdefault((row['date'], row.get('session_start_ms') if row.get('session_start_ms') is not None else float('inf'), str(row['session_id'])), []).append(row)
    observations = sorted(sessions.items())
    ticks = [f"{key[0][5:]} / {i}" for i, (key, _) in enumerate(observations, 1)]
    positions = list(range(len(observations)))
    weight, reps, sets = axes
    for kind, label, color in (('weighted', '외부 무게', 'tab:blue'), ('assisted', '보조 무게', 'tab:orange')):
        maxima, minima = [], []
        for _, rows in observations:
            loads = [r['load_kg'] for r in rows if r['load_kind'] == kind and _number(r.get('load_kg'))]
            maxima.append(max(loads) if loads else None); minima.append(min(loads) if loads else None)
        if any(x is not None for x in maxima):
            weight.plot(positions, maxima, marker='o', label=label)
            for index, (low, high) in enumerate(zip(minima, maxima)):
                if low is not None:
                    weight.vlines(index, low, high, color=color, alpha=.5)
    for index, (_, rows) in enumerate(observations):
        notes = list(dict.fromkeys(_load_label(r) for r in rows if r['load_kind'] not in ('weighted', 'assisted')))
        if notes:
            weight.text(index, .03, ' / '.join(notes), transform=weight.get_xaxis_transform(), ha='center', fontsize=7)
    rep_values = [sum(r['reps'] for r in rows) if all(_number(r.get('reps')) for r in rows) else None for _, rows in observations]
    reps.plot(positions, rep_values, marker='o', color='tab:green')
    sets.plot(positions, [len(rows) for _, rows in observations], marker='o', color='grey')
    for index, value in enumerate(rep_values):
        if value is None:
            reps.text(index, .03, '반복 미기록', transform=reps.get_xaxis_transform(), fontsize=7)
    for ax, metric in zip(axes, ('무게 kg · 세션 내 최저~최고', '총 반복 횟수', '기록 세트 수')):
        ax.set(title=group['label'] + ' · ' + metric, xlabel='수행일 / 세션 순서', ylabel=metric)
        stride = max(1, math.ceil(len(positions) / 8))
        ax.set_xticks(positions[::stride], ticks[::stride], rotation=30, fontsize=8)
        ax.set_ylim(bottom=0)
        ax.grid(alpha=.15)
    if weight.get_legend_handles_labels()[0]:
        weight.legend(fontsize=7)


def _strength(figure, model, groups):
    axes = figure.subplots(len(groups), 3, squeeze=False)
    for row, group in zip(axes, groups):
        _session_trend(row, group)


def _heart(figure, model):
    # 이전 _session의 한 축에 그날 모든 활동과 표본을 함께 표시한다.
    # C1에 없는 BB는 채우지 않으며 세트 수직 음영은 추가하지 않는다.
    from garmin_pipeline.charts import _session
    sessions = sorted(model['sessions'], key=lambda s: (
        s['start_ms'] if s['start_ms'] is not None else
        s['hr_samples'][0][0] if s['hr_samples'] else float('inf'), str(s['session_id'])))
    samples, activities, starts = {}, [], []
    for session in sessions:
        start = session['start_ms']
        if start is None and session['hr_samples']:
            start = session['hr_samples'][0][0]
        for at, bpm in session['hr_samples']:
            # 이전 _read_sessions와 같이 겹치는 timestamp는 첫 활동 표본을 보존한다.
            samples.setdefault(at, bpm)
        if start is not None:
            starts.append(start)
            activities.append({'start_ms': start, 'end_ms': session['end_ms'],
                               'label': session['label'], 'zone_low_bpm': session['zone_lows']})
    if not samples:
        return False
    item = {'hr': sorted(samples.items()), 'start_ms': min(starts + list(samples)),
            'body_battery': [], 'activities': activities}
    return _session(figure, item, 1)


def render_model(model, out_dir, *, cache_dir=None):
    """adapter로 검증된 C1 모델을 렌더하고 scope별 manifest를 남긴다."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if cache_dir is not None:
        Path(cache_dir).mkdir(parents=True, exist_ok=True, mode=0o700)
        os.environ['MPLCONFIGDIR'] = str(cache_dir)
    import matplotlib
    from matplotlib.figure import Figure
    from garmin_pipeline.charts import FONT_FAMILY, ChartRenderFailed
    matplotlib.use('Agg')
    pages, omitted = _pages(model)
    prefix = f"{SCOPES.index(model['scope']) + 1:02d}-{model['scope']}"
    jobs = [(f'{prefix}-strength-{index}.png', 'session_load_reps_sets', groups,
             lambda fig, groups=groups: _strength(fig, model, groups)) for index, groups in enumerate(pages, 1)]
    if model['scope'] == 'day' and any(session['hr_samples'] for session in model['sessions']):
        jobs.append((f'{prefix}-heart.png', 'heart_rate_zones_legacy', [], lambda fig: _heart(fig, model)))
    graphs = []
    for name, metric, groups, draw in jobs:
        path, figure = out_dir / name, None
        try:
            rows = len(groups)
            with matplotlib.rc_context({'font.family': FONT_FAMILY, 'axes.unicode_minus': False}):
                figure = Figure(figsize=(14, min(24, max(5, rows * 3.5))) if groups else (12, 6), dpi=150)
                draw(figure)
                title = _heading(model)
                figure.suptitle(title, fontsize=12)
                if omitted:
                    figure.text(.5, .01, f'빈도 상위 종목 · {omitted}종목 그래프 생략(분석 입력에는 포함)', ha='center', fontsize=9)
                graph = TrainingGraph(name, title, model['scope'], model['range'], metric,
                                      tuple(group['key'] for group in groups), omitted)
                figure.tight_layout(rect=(0, 0, 1, .96))
                with path.open('xb'):
                    path.chmod(0o600)
                metadata = graph.metadata() | {'snapshot_id': model['snapshot_id'], 'data_cutoff': model['data_cutoff']}
                figure.savefig(path, format='png', metadata={'Description': json.dumps(metadata, ensure_ascii=False, sort_keys=True)})
                if path.stat().st_size > 10_000_000:
                    raise ValueError('PNG size limit')
                graphs.append(graph)
        except Exception as error:
            path.unlink(missing_ok=True)
            raise ChartRenderFailed(name) from error
        finally:
            if figure is not None:
                figure.clear()
    manifest = {'renderer_version': RENDERER_VERSION, 'scope': model['scope'], 'range': model['range'],
                'snapshot_id': model['snapshot_id'], 'data_cutoff': model['data_cutoff'],
                'graphs': [graph.metadata() | {'name': graph.name, 'sha256': hashlib.sha256((out_dir / graph.name).read_bytes()).hexdigest()}
                           for graph in graphs]}
    path = out_dir / f'{prefix}-manifest.json'
    with path.open('x', encoding='utf-8') as handle:
        path.chmod(0o600)
        json.dump(manifest, handle, ensure_ascii=False, sort_keys=True)
    return graphs


def scope_from_name(name):
    """새 그림 이름은 기간 식별자이며 구 01/50 슬롯과 혼동하지 않는다."""
    for index, scope in enumerate(SCOPES, 1):
        if name.startswith(f'{index:02d}-{scope}-') and name.endswith('.png'):
            return scope
    return None


def png_metadata(data):
    """저장 PNG의 자체 기술 metadata를 파일 게시에도 사용한다. 구 그림은 빈 값."""
    import struct
    import zlib
    if not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return {}
    offset = 8
    while offset + 12 <= len(data):
        length = struct.unpack('!I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 8:offset + 8 + length]
        if kind in (b'tEXt', b'iTXt') and chunk.startswith(b'Description\0'):
            _, content = chunk.split(b'\0', 1)
            if kind == b'iTXt':
                flag, content = content[0], content[2:]
                _, content = content.split(b'\0', 1)
                _, content = content.split(b'\0', 1)
                if flag:
                    content = zlib.decompress(content)
            result = json.loads(content)
            if not isinstance(result, dict):
                raise ValueError('invalid graph metadata')
            return result
        offset += length + 12
    return {}
