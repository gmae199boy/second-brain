"""저장 평가와 digest 저장 지표로 만드는 메신저 중립 리포트.

normalize가 digest.day_values로 계산해 day_summary에 저장한 값을 읽는다.
원본 수면·HRV·Body Battery를 다시 집계하지 않으며 render는 표시 단위만 바꾼다.
저장 평가 재발신도 같은 저장 결과를 사용해 파일·원본 digest 재생성을 피한다.
"""
import json
import math
import re

FORMAT_VERSION = 'report-v1'
MARKUP_PREFIX = '[brain-markup-v1]\n'
SCOPES = ('day', '7d', '30d', 'all')
_LIMITATION = re.compile(r'(?:측정값|기록|데이터|자료|표본|근거|기준|정보|프로필)(?:은|는|이|가|도)?\s*(?:부족|없|미제공|불가)|(?:비교|판단)(?:가|이)?\s*불가|한계')
_ADVICE = re.compile(r'권장|권고|우선|피하|피한|줄이|줄여|보류|재개|쉬는|휴식')


def _line(value, limit=180):
    value = ' '.join(str(value or '').split())
    # 분석 문장은 데이터다. 마크업 구획이나 굵게 토큰을 삽입하지 못한다.
    value = value.replace('**', '').lstrip('#•👉 ')
    return value if len(value) <= limit else value[:limit - 1].rstrip() + '…'


def _sentences(value):
    return [s.strip() for s in re.split(r'(?<=[.!?。])\s+|\n+', value or '') if s.strip()]


def _array(value):
    if isinstance(value, str):
        try: value = json.loads(value)
        except ValueError: return []
    return [s for s in value if isinstance(s, str) and s.strip()] if isinstance(value, list) else []


def _parts(evaluation):
    message = evaluation.get('message') or {}
    if not isinstance(message, dict): message = {}
    sentences = _sentences(evaluation.get('summary', ''))
    limits = _array(message.get('limitations'))
    content = []
    for sentence in sentences:
        if _LIMITATION.search(sentence): limits.append(sentence)
        else: content.append(sentence)
    # 과거 평가에서는 기존 판단과 다음 확인 항목도 재사용한다. 새 판정은 추론하지 않는다.
    judgments = []
    for judgment in _array(evaluation.get('judgments')):
        if _LIMITATION.search(judgment): limits.append(judgment)
        else: judgments.append(judgment)
    headline = message.get('headline') or (judgments[0] if judgments else (content[0] if content else '판정 근거 부족'))
    recommendations = _array(message.get('recommendations'))
    if not recommendations:
        recommendations = [s for s in content if _ADVICE.search(s)] or _array(evaluation.get('next_checks'))
    usable = []
    for recommendation in recommendations:
        if _LIMITATION.search(recommendation): limits.append(recommendation)
        else: usable.append(recommendation)
    recommendations = usable
    trend = message.get('trend_line') or (content[0] if content else '추세 판단 근거 부족')
    return _line(headline), [_line(s) for s in recommendations[:2]], _line(trend), limits


def _number(value):
    return f'{value:g}' if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else '측정 없음'


def render(day, evaluations, metrics):
    headline, recommendations, _, limitations = _parts(evaluations['day'])
    seconds = metrics.get('sleep_total_s')
    duration = '측정 없음'
    if isinstance(seconds, (int, float)) and math.isfinite(seconds) and seconds >= 0:
        minutes = int(seconds) // 60
        duration = f'{minutes // 60}:{minutes % 60:02d}'
    lines = [f'# 🩺 Garmin 일일 리포트 · {day.month:02d}/{day.day:02d} ({"월화수목금토일"[day.weekday()]})', '',
             f'**오늘 회복: {headline}**',
             f'- 수면 {duration} · 점수 {_number(metrics.get("sleep_score"))}',
             f'- HRV {_number(metrics.get("hrv_avg"))}' + (' ms' if _number(metrics.get('hrv_avg')) != '측정 없음' else ''),
             f'- 기상 Body Battery {_number(metrics.get("wake_bb"))}', '']
    lines.extend('👉 ' + s for s in recommendations)
    lines.extend(['', '## 📈 추세'])
    for scope, label in (('7d', '7일'), ('30d', '30일'), ('all', '전체')):
        _, _, trend, limits = _parts(evaluations[scope])
        lines.append(f'- {label}: {trend}')
        limitations.extend(limits)
    unique = list(dict.fromkeys(_line(s, 120).rstrip('.。') for s in limitations if _line(s)))
    if unique:
        lines.extend(['', 'ℹ️ 비교 기준 부족: ' + ' · '.join(unique)[:500]])
    return MARKUP_PREFIX + '\n'.join(lines).strip()


def render_period(start, end, revision, evaluation):
    """기간 분석도 같은 마크업·과거 평가 fallback·한계 중복 제거를 사용한다."""
    headline, recommendations, trend, limitations = _parts(evaluation)
    lines = [f'# 🩺 Garmin 기간 리포트 · {start} ~ {end}', '',
             f'**기간 판단: {headline}**', f'- revision {revision}', '']
    lines.extend('👉 ' + s for s in recommendations)
    if trend != headline:
        lines.extend(['', '## 📈 추세', '- ' + trend])
    unique = list(dict.fromkeys(_line(s, 120).rstrip('.。') for s in limitations if _line(s)))
    if unique:
        lines.extend(['', 'ℹ️ 비교 기준 부족: ' + ' · '.join(unique)[:500]])
    return MARKUP_PREFIX + '\n'.join(lines).strip()


def load(conn, day, revisions):
    evaluations = {}
    for scope in SCOPES:
        row = conn.execute('''select summary,judgments,next_checks,message from garmin.evaluation_revisions
            where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)''',
            (conn.user_id, conn.connection_id, day.isoformat(), scope, revisions[scope])).fetchone()
        if row is None: raise ValueError('missing evaluation revision')
        evaluations[scope] = dict(zip(('summary', 'judgments', 'next_checks', 'message'), row))
    row = conn.execute('''select sleep_total_s,sleep_score,hrv_avg,wake_bb from garmin.day_summary
        where user_id=%s and connection_id=%s and date=%s''',
        (conn.user_id, conn.connection_id, day.isoformat())).fetchone()
    return render(day, evaluations, dict(zip(('sleep_total_s', 'sleep_score', 'hrv_avg', 'wake_bb'), row or (None,) * 4)))


def saved_or_fallback(cfg, day, summaries):
    """구 실행 경로도 저장 평가와 동일한 DB 지표 렌더러를 사용한다."""
    from garmin_pipeline import store
    conn = store.read_connection(cfg)
    try:
        evaluations = {}
        for scope in SCOPES:
            row = conn.execute('''select summary,judgments,next_checks,message from garmin.evaluation_revisions
                where user_id=%s and connection_id=%s and report_date=%s and scope=%s
                order by revision desc limit 1''',
                (conn.user_id, conn.connection_id, day.isoformat(), scope)).fetchone()
            evaluations[scope] = dict(zip(('summary', 'judgments', 'next_checks', 'message'), row)) if row else {'summary': summaries[scope]}
        row = conn.execute('''select sleep_total_s,sleep_score,hrv_avg,wake_bb from garmin.day_summary
            where user_id=%s and connection_id=%s and date=%s''',
            (conn.user_id, conn.connection_id, day.isoformat())).fetchone()
        return render(day, evaluations, dict(zip(('sleep_total_s', 'sleep_score', 'hrv_avg', 'wake_bb'), row or (None,) * 4)))
    finally:
        conn.close()
