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


MESSAGES_FORMAT_VERSION = 'report-messages-v2'


def utf16_length(text):
    return len(text.encode('utf-16-le')) // 2


def _plain(value):
    return ' '.join(str(value or '').replace('**', '').split())


def render_scope(structure):
    """C3 구조체 하나만 읽는다. 초과 내용은 완전한 문장 단위로 생략한다."""
    if structure.get('schema_version') != 'garmin.scope_analysis.v2' or structure.get('scope') not in SCOPES:
        raise ValueError('invalid scope message structure')
    scope = structure['scope']
    window = structure['range']
    title = f'{SCOPES.index(scope) + 1}/4 · ' + {'day': '1일', '7d': '7일', '30d': '30일', 'all': '전체'}[scope]
    header = [f'Garmin 운동 리포트 · {title}',
              f'{window["start"]} ~ {window["end"]} (양끝 포함, {window["timezone"]})',
              f'자료 기준: {structure["data_cutoff"]}']
    summary = structure['training_summary']
    message = structure.get('message') or {}
    # 우선순위: 핵심 판정, 다음 행동, 중요한 한계, 운동 관측/해석, 회복·추세.
    sections = []
    sections.append(('판정', [_plain(summary.get('headline')), _plain(summary.get('assessment'))]))
    actions = []
    for action in structure.get('next_workout_actions', [])[:2]:
        actions.append(' '.join(filter(None, (_plain(action.get('action')), _plain(action.get('reason')),
                                              _plain(action.get('condition'))))))
    sections.append(('다음 운동', actions or [_plain(x) for x in message.get('recommendations', [])[:2]]))
    limits = [_plain(x.get('detail') or x.get('affected_judgment')) for x in structure.get('limitations', [])
              if x.get('scope') == scope][:2]
    sections.append(('이 기간의 한계', limits))
    findings = []
    for finding in structure.get('strength_findings', []) + structure.get('aerobic_findings', []):
        label = _plain(finding.get('exercise_key') or finding.get('activity_type') or '유형 미상')
        for sentence in _sentences(' '.join(filter(None, (_plain(finding.get('observed_change')), _plain(finding.get('interpretation')))))):
            findings.append(label + ': ' + sentence)
    sections.append(('운동 수행', findings))
    progression = structure.get('progression') or {}
    sections.append(('진행·회복', [_plain(progression.get('observation_reason')), _plain(progression.get('decision_reason'))]
                     + [' '.join(filter(None, (_plain(x.get('context')), _plain(x.get('effect_on_training')), _plain(x.get('uncertainty'))))) for x in structure.get('recovery_context', [])]
                     + [_plain(message.get('trend_line'))]))
    note = '\n\n일부 내용은 길이 제한으로 생략했습니다. 통합 문서에서 전체 평가를 확인하세요.'
    lines = header[:]
    omitted = False
    seen = set()
    # 생략 안내를 위한 공간을 미리 남겨 어느 경우에도 4000 UTF-16 예산을 넘기지 않는다.
    budget = 4000 - utf16_length(note)
    if utf16_length('\n'.join(lines)) > budget:
        raise ValueError('scope header exceeds message budget')
    for label, values in sections:
        added_heading = False
        for value in values:
            # 단일 긴 문장도 문자 중간에서 자르지 않는다.
            for sentence in ([value] if label == '다음 운동' else _sentences(value)):
                if not sentence or sentence in seen:
                    continue
                seen.add(sentence)
                candidate = ([] if added_heading else ['', label]) + ['• ' + sentence]
                if utf16_length('\n'.join(lines + candidate)) <= budget:
                    lines.extend(candidate)
                    added_heading = True
                else:
                    omitted = True
    return '\n'.join(lines) + (note if omitted else '')


def load_messages(conn, day, revisions):
    """선택 revision별 불변 manifest를 먼저 읽는다. 렌더 배포로 재발신 본문이 바뀌지 않는다."""
    revision_key = json.dumps(revisions, sort_keys=True, separators=(',', ':'))
    saved = conn.execute('''select manifest from garmin.report_message_manifests
        where user_id=%s and connection_id=%s and report_date=%s and revision_key=%s''',
        (conn.user_id, conn.connection_id, day.isoformat(), revision_key)).fetchone()
    if saved:
        return saved[0]
    structures = []
    for scope in SCOPES:
        # to_jsonb는 W3 컬럼 설치 전 과거 revision도 NULL로 해석한다.
        row = conn.execute('''select to_jsonb(e)->'structured' from garmin.evaluation_revisions e
            where (user_id,connection_id,report_date,scope,revision)=(%s,%s,%s,%s,%s)''',
            (conn.user_id, conn.connection_id, day.isoformat(), scope, revisions[scope])).fetchone()
        if row is None:
            raise ValueError('missing evaluation revision')
        structures.append(row[0])
    if all(isinstance(value, dict) and value.get('schema_version') == 'garmin.scope_analysis.v2' for value in structures):
        if any(value['scope'] != scope for scope, value in zip(SCOPES, structures)):
            raise ValueError('scope structure mismatch')
        if len({value['snapshot_id'] for value in structures}) != 1:
            raise ValueError('scope snapshot mismatch')
        manifest = {'version': 2, 'format': MESSAGES_FORMAT_VERSION,
                    'messages': [{'itemId': 'summary:' + scope, 'text': render_scope(value)}
                                 for scope, value in zip(SCOPES, structures)]}
    else:
        # C7: 구 schema revision은 기존 표시를 그대로 보존하고 재분석하지 않는다.
        manifest = {'version': 1, 'format': FORMAT_VERSION, 'summary': load(conn, day, revisions)}
    conn.execute('''insert into garmin.report_message_manifests(user_id,connection_id,report_date,revision_key,manifest)
        values (%s,%s,%s,%s,%s::jsonb) on conflict do nothing''',
        (conn.user_id, conn.connection_id, day.isoformat(), revision_key, json.dumps(manifest, ensure_ascii=False)))
    # 동일 revision vector의 경쟁 렌더에서도 처음 저장한 본문만 발행한다.
    return conn.execute('''select manifest from garmin.report_message_manifests
        where user_id=%s and connection_id=%s and report_date=%s and revision_key=%s''',
        (conn.user_id, conn.connection_id, day.isoformat(), revision_key)).fetchone()[0]



def delivery_messages(manifest, missing_reason=None):
    """저장 본문을 보존하며 첨부 상태에 따른 실제 발신 표현을 고정한다."""
    items = manifest.get('messages')
    if items is None:
        return None
    items = [dict(item) for item in items]
    if not missing_reason:
        return items
    for item in items:
        item['text'] = item['text'].replace('통합 문서에서 전체 평가를 확인하세요.', '전체 평가는 저장되어 있습니다.')
    notice = '\n\n보고서·그래프 없음 (' + missing_reason + ')'
    # 조건부 행동은 한 줄로 저장된다. 첨부 안내 예산도 완전한 줄 단위로 확보한다.
    lines = items[-1]['text'].split('\n')
    while utf16_length('\n'.join(lines) + notice) > 4000 and len(lines) > 3:
        lines.pop()
    items[-1]['text'] = '\n'.join(lines).rstrip() + notice
    if utf16_length(items[-1]['text']) > 4000:
        raise ValueError('attachment notice exceeds message budget')
    return items
