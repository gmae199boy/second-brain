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
RENDERER_VERSION = 'training-charts-v1'
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
                         'start_ms': _epoch(session['start_at']), 'sets': rows, 'hr_samples': samples,
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
            group['sets'].append(dict(row, session_id=session['session_id'], date=session['date']))
    for group in groups.values():
        group['sets'].sort(key=lambda row: (row['date'], str(row['session_id']), row['order']))
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
    groups = _groups(model)
    ordered = sorted(groups, key=lambda key: (-_frequency(groups[key]), key))
    omitted = 0
    if model['scope'] != 'day':
        omitted = max(0, len(ordered) - MAX_EXERCISES)
        ordered = ordered[:MAX_EXERCISES]
    # [ASSUMPTION] 1일 모든 종목을 세 장 안에 균등 배치한다.
    page_size = max(4, math.ceil(len(ordered) / (3 if model['scope'] == 'day' else 2)))
    return [[groups[key] for key in ordered[start:start + page_size]]
            for start in range(0, len(ordered), page_size)], omitted


def _heading(model):
    window = model['range']
    return f"{LABELS[model['scope']]} · {window['start']} ~ {window['end']} · {window['timezone']}"


def _set_panel(ax, group):
    rows = group['sets']
    if not rows:
        ax.set(title=group['label'], ylabel='reps')
        ax.text(.5, .5, '세트 상세 미기록', transform=ax.transAxes, ha='center')
        return
    valid = [(index, row) for index, row in enumerate(rows) if _number(row.get('reps'))]
    for index, row in valid:
        reps = row['reps']
        ax.bar(index, reps, color='tab:blue', alpha=.6)
        ax.annotate(f"{reps:g}회 × {_load_label(row)}", (index, reps),
                    xytext=(0, 4), textcoords='offset points', ha='center', fontsize=8,
                    rotation=25 if len(rows) > 8 else 0)
    for index, row in enumerate(rows):
        if not _number(row.get('reps')):
            ax.annotate('reps 미기록', (index, 0), rotation=30, fontsize=8)
    ax.set_xticks(range(len(rows)), [f"S{row['set_no']}" for row in rows], fontsize=8)
    for index in range(1, len(rows)):
        if rows[index]['session_id'] != rows[index - 1]['session_id']:
            ax.axvline(index - .5, color='grey', linestyle=':', alpha=.6)
    ax.set(title=f"{group['label']} · {len(rows)}세트", ylabel='reps', xlabel='세션 순서 / 종목 내 세트 번호')
    ax.set_ylim(bottom=0, top=max([row['reps'] for _, row in valid] or [1]) * 1.45)


def _trend_panel(ax, group, scope):
    # 같은 load_kind·같은 외부 부하만 한 계열로 묶는다. 결측·불명은 연결하지 않는다.
    series = defaultdict(lambda: defaultdict(list))
    rows = list(group['sets'])
    summary = group.get('summary', {})
    ordinal = False
    if scope == 'all' and summary.get('same_load_reps'):
        # C1 장기 입력은 대표 비교 관측만 제공할 수 있다. 날짜가 없으면 순서로 명시한다.
        observations = summary['same_load_reps']
        ids = list(dict.fromkeys([item['session_id'] for series in observations for item in series['observations']]))
        rows = [dict(item, load_kind=series['load_kind'], load_kg=series['load_kg'],
                     date=f"관측 {ids.index(item['session_id']) + 1:03d}")
                for series in observations for item in series['observations']]
        ordinal = True
    for row in rows:
        if not _number(row.get('reps')):
            continue
        kind = row['load_kind']
        load = row.get('load_kg')
        comparable = kind == 'bodyweight' or (kind in ('weighted', 'assisted') and _number(load))
        identity = (kind, load if kind != 'bodyweight' else None, row.get('equipment'), row.get('variant'))
        if not comparable:
            identity += (str(row['session_id']),)
        bucket = row['date'][:7] if scope == 'all' and not ordinal else row['date']
        series[identity][(bucket, str(row['session_id']))].append(row['reps'])
    buckets = sorted({bucket for observations in series.values() for bucket, _ in observations})
    positions = {bucket: int(bucket.split()[-1]) if ordinal else
                 datetime.strptime(bucket, '%Y-%m' if scope == 'all' else '%Y-%m-%d').date().toordinal()
                 for bucket in buckets}
    for identity, observations in sorted(series.items(), key=lambda item: str(item[0])):
        sample = {'load_kind': identity[0], 'load_kg': identity[1]}
        label = _load_label(sample)
        if identity[2] or identity[3]:
            label += ' · ' + '/'.join(str(value) for value in identity[2:4] if value)
        points = defaultdict(list)
        for (bucket, _), reps in observations.items():
            points[bucket].extend(reps)
        x = sorted(points)
        means = [sum(points[day]) / len(points[day]) for day in x]
        # 전체 범위는 월 평균·범위를 사용하여 원본 점 무제한 증가를 막는다.
        line, = ax.plot([positions[day] for day in x], means, marker='o', linestyle='-' if len(identity) == 4 and group.get('summary', {}).get('comparability', {}).get('status') == 'comparable' else 'None', label=label)
        if scope == 'all':
            ax.vlines([positions[day] for day in x], [min(points[day]) for day in x], [max(points[day]) for day in x], color=line.get_color(), alpha=.3)
        else:
            for day in x:
                ax.scatter([positions[day]] * len(points[day]), points[day], color=line.get_color(), alpha=.3, s=12)
    ax.set(title=f"{group['label']} · {_frequency(group)}회 · {summary.get('sets', len(group['sets']))}세트",
           ylabel='세트당 reps', xlabel=('대표 관측 순서 · 날짜 미기록' if ordinal else '월별 평균·범위') if scope == 'all' else '수행일 · 같은 부하·비교 조건 확인 시만 연결')
    ax.set_ylim(bottom=0)
    if series:
        ax.legend(fontsize=7)
    else:
        ax.text(.5, .5, 'reps 미기록', transform=ax.transAxes, ha='center')
    ticks = buckets[::max(1, math.ceil(len(buckets) / 8))]
    ax.set_xticks([positions[day] for day in ticks], ticks)
    ax.tick_params(axis='x', labelrotation=30, labelsize=8)


def _monthly_panel(ax, group):
    monthly = sorted(group.get('summary', {}).get('monthly', []), key=lambda row: row['month'])
    if not monthly:
        ax.set(title='월 집계 미기록')
        return
    positions = [datetime.strptime(row['month'], '%Y-%m').date().toordinal() for row in monthly]
    ax.plot(positions, [row['reps'] if _number(row['reps']) else None for row in monthly], marker='o', label='총 reps')
    right = ax.twinx()
    right.plot(positions, [row['sets'] for row in monthly], color='grey', linestyle=':', label='세트 수')
    right.set_ylabel('기록 세트 수')
    ax.set(title=f"{group['label']} · 월 총 reps / 세트 수", ylabel='총 reps', xlabel='월 · 부하·세트 수 혼합, 같은 부하 비교 아님')
    ax.set_ylim(bottom=0)
    stride = max(1, math.ceil(len(monthly) / 8))
    ax.set_xticks(positions[::stride], [row['month'] for row in monthly[::stride]])
    ax.tick_params(axis='x', labelrotation=30, labelsize=8)


def _strength(figure, model, groups):
    if model['scope'] == 'all':
        axes = figure.subplots(len(groups), 2, squeeze=False)
        for (left, right), group in zip(axes, groups):
            _trend_panel(left, group, 'all')
            _monthly_panel(right, group)
        return
    axes = list(figure.subplots(math.ceil(len(groups) / 2), 2, squeeze=False).flat)
    for ax, group in zip(axes, groups):
        if model['scope'] == 'day':
            _set_panel(ax, group)
        else:
            _trend_panel(ax, group, model['scope'])
    for ax in axes[len(groups):]:
        ax.set_visible(False)


def _overview(figure, model):
    groups = _groups(model)
    axes = figure.subplots(1, 2)
    names = sorted(groups, key=lambda key: (-_frequency(groups[key]), key))[:MAX_EXERCISES]
    if names:
        keys = list(reversed(names))
        labels = [groups[key]['label'] for key in keys]
        axes[0].barh(range(len(keys)), [groups[key].get('summary', {}).get('sets', len(groups[key]['sets'])) for key in keys])
        axes[0].set_yticks(range(len(keys)), [f"{label} [{groups[key]['key']}]" if labels.count(label) > 1 else label
                                             for key, label in zip(keys, labels)])
    axes[0].set(title='기록된 ACTIVE 세트 수', xlabel='세트')
    aerobic = [session for session in model['sessions'] if session.get('zone_seconds')]
    for session_index, session in enumerate(aerobic, 1):
        left = 0
        for index, value in enumerate(session['zone_seconds']):
            if _number(value) and value >= 0:
                axes[1].barh(f"{session['date']} / {session_index}", value / 60, left=left,
                             color=f'C{index}', label=f'Z{index + 1}')
                left += value / 60
    axes[1].set(title='심박존 체류 · 미기록은 0으로 보충하지 않음', xlabel='분')
    if not aerobic:
        axes[1].text(.5, .5, '심박존 기록 없음', transform=axes[1].transAxes, ha='center')
    else:
        handles, labels = axes[1].get_legend_handles_labels()
        unique = dict(zip(labels, handles))
        axes[1].legend(unique.values(), unique.keys(), fontsize=8)


def _heart(figure, model):
    sessions = [session for session in model['sessions'] if session['hr_samples']]
    axes = figure.subplots(len(sessions), 1, squeeze=False).flat
    for session_index, (ax, session) in enumerate(zip(axes, sessions), 1):
        origin = session['start_ms'] if session['start_ms'] is not None else session['hr_samples'][0][0]
        samples = session['hr_samples']
        ax.plot([(sample[0] - origin) / 60000 for sample in samples], [sample[1] for sample in samples], color='tab:red', marker='o' if len(samples) == 1 else None)
        missing = 0
        for row in session['sets']:
            if row['is_rest']:
                continue
            start, end = row.get('start_ms'), row.get('end_ms')
            if _number(start) and _number(end) and end > start:
                ax.axvspan((start - origin) / 60000, (end - origin) / 60000, alpha=.15, color='tab:blue')
            else:
                missing += 1
        ax.set(title=f"세션 {session_index} · 세트 구간 미기록 {missing}개", xlabel='시작 후 분', ylabel='심박 bpm')


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
    jobs = [(f'{prefix}-strength-{index}.png', 'set_reps_load' if model['scope'] == 'day' else ('reps_by_load_and_monthly_reps_sets' if model['scope'] == 'all' and any(g.get('summary', {}).get('monthly') for g in groups) else 'reps_by_load'),
             groups, lambda fig, groups=groups: _strength(fig, model, groups))
            for index, groups in enumerate(pages, 1)]
    if model['scope'] != 'day' and (model['sessions'] or model['strength']):
        jobs.append((f'{prefix}-overview.png', 'active_sets_hr_zones', [], lambda fig: _overview(fig, model)))
    if model['scope'] == 'day' and any(session['hr_samples'] for session in model['sessions']):
        jobs.append((f'{prefix}-heart.png', 'heart_rate_set_intervals', [], lambda fig: _heart(fig, model)))
    graphs = []
    for name, metric, groups, draw in jobs:
        path, figure = out_dir / name, None
        try:
            rows = (len(groups) if model['scope'] == 'all' else math.ceil(len(groups) / 2)) if groups else (sum(bool(s['hr_samples']) for s in model['sessions']) if metric == 'heart_rate_set_intervals' else 1)
            with matplotlib.rc_context({'font.family': FONT_FAMILY, 'axes.unicode_minus': False}):
                figure = Figure(figsize=(12, min(24, max(5, rows * 3.5))), dpi=150)
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
