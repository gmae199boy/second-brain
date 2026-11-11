"""수동 기간 분석: 일감 입력·평가 revision을 고정하고 완료한 평가를 항상 발신 접수한다."""
import json
import os
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

import query
import report_runtime
from garmin_pipeline import body, dates, report, report_input, report_message, store

InvalidReportInput = report_runtime.InvalidReportInput


def validate_input(data):
    if not isinstance(data, dict) or not {'start_date', 'end_date'} <= data.keys() or data.keys() - {'start_date', 'end_date', 'metric', 'aggregation', 'activity_type', 'exercise'}:
        raise InvalidReportInput('invalid period fields')
    try:
        for name in ('start_date', 'end_date'):
            if not isinstance(data[name], str) or date.fromisoformat(data[name]).isoformat() != data[name]:
                raise ValueError('invalid date')
        if data['start_date'] > data['end_date']:
            raise ValueError('invalid range')
        if 'metric' in data and data['metric'] not in query.METRICS:
            raise ValueError('invalid metric')
        if 'aggregation' in data and ('metric' not in data or data['aggregation'] not in query.METRICS[data['metric']][3]):
            raise ValueError('invalid aggregation')
        for name in ('activity_type', 'exercise'):
            if name in data and (not isinstance(data[name], str) or not data[name].strip() or len(data[name]) > 200):
                raise ValueError('invalid condition')
    except (ValueError, TypeError, KeyError) as exc:
        raise InvalidReportInput('invalid period input') from exc
    return data


def _saved(conn, work):
    return conn.execute('''select start_date,end_date,revision,summary from garmin.period_evaluations
        where user_id=%s and connection_id=%s and work_id=%s''',
        (conn.user_id, conn.connection_id, work)).fetchone()


def _save(cfg, data, result, work):
    focus = {k: data[k] for k in ('metric', 'aggregation', 'activity_type', 'exercise') if k in data}
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            row = conn.execute('''insert into garmin.period_evaluations
                (user_id,connection_id,start_date,end_date,revision,work_id,focus,summary,report_md,judgments,evidence,next_checks,model,created_at,message)
                select %s,%s,%s,%s,coalesce(max(revision),0)+1,%s,%s::jsonb,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,%s::jsonb
                from garmin.period_evaluations where user_id=%s and connection_id=%s and start_date=%s and end_date=%s
                returning start_date,end_date,revision,summary''',
                (conn.user_id, conn.connection_id, data['start_date'], data['end_date'], work,
                 json.dumps(focus), result.summary, result.report_md, json.dumps(result.judgments),
                 json.dumps(result.evidence), json.dumps(result.next_checks), cfg.report_model, dates.now_ms(), json.dumps(result.message),
                 conn.user_id, conn.connection_id, data['start_date'], data['end_date'])).fetchone()
    return row


def _analyze(cfg, data, writer):
    cfg.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='period-input-', dir=cfg.data_dir) as temporary:
        folder = Path(temporary)
        start, end = data['start_date'], data['end_date']
        months = [f'{year:04d}-{month:02d}' for year in range(int(start[:4]), int(end[:4]) + 1)
                  for month in range(1, 13) if start[:7] <= f'{year:04d}-{month:02d}' <= end[:7]]
        # 끝난 날짜는 일일 수집 시점으로 자르지 않는다. 오늘·미래 날짜의 불완전성은 명시한다.
        today = dates.today(cfg).isoformat()
        partial = {'date': today, 'description': '진행 중인 현지 날짜 또는 미래 날짜의 자료는 불완전하다',
                   'data_cutoff': dates.now_ms()} if end >= today else {}
        report_input.write_json(folder / 'manifest.json', {
            'period_windows': {'custom': {'from': start, 'to': end}}, 'months': months,
            'data_cutoff': dates.now_ms(), 'partial_date': partial})
        try:
            profile = cfg.profile_path.read_text(encoding='utf-8')
        except FileNotFoundError:
            profile = '사용자 프로필이 없다. 목표나 선호를 추정하지 않는다.\n'
        (folder / 'profile.md').write_text(profile, encoding='utf-8')
        focus = {k: data[k] for k in ('metric', 'aggregation', 'activity_type', 'exercise') if k in data}
        inputs = report_input.build_period(cfg, folder, date.fromisoformat(end), 'custom', focus=focus)
        report._assert_attempt_current(cfg)
        result, _, failure, _ = report._evaluate(cfg, writer,
            [os.path.relpath(inputs, body.runtime_root(cfg)), os.path.relpath(folder / 'profile.md', body.runtime_root(cfg))],
            'custom', [])
        if failure is not None:
            raise report.SupervisedReportFailed('period analysis failed')
        return result


def _send(cfg, saved, env):
    import report_channel
    import report_publish
    import time
    start, end, revision, summary = saved
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            artifact = conn.execute('''select report_md,created_at from garmin.period_evaluations
                where user_id=%s and connection_id=%s and work_id=%s''',
                (conn.user_id, conn.connection_id, env['BRAIN_WORK_ID'])).fetchone()
    # 임의 기간용 그래프 렌더러는 없다. 저장된 기간 문서는 분석 없이 게시한다.
    deadline = time.monotonic() + report_publish.PENDING_WAIT_SECONDS
    while True:
        report._assert_attempt_current(cfg)
        try:
            document = report_publish.publish_send_copy(cfg, env, 'report.md', artifact[0].encode('utf-8'),
                datetime.fromtimestamp(artifact[1] / 1000, timezone.utc),
                ['period', start, end, revision], 'text/markdown')
            break
        except report_publish.FilesPending:
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise
            report._abi_progress()
            time.sleep(min(report_publish.PENDING_POLL_SECONDS, remaining))
    with store.write_session(cfg) as conn:
        with store.transaction(conn):
            key = report_channel._key(str(conn.user_id), str(conn.connection_id), start, end, revision, report_message.FORMAT_VERSION, 'attachments-v1', str(document))
            row = conn.execute('''select summary,judgments,next_checks,message from garmin.period_evaluations
                where user_id=%s and connection_id=%s and work_id=%s''',
                (conn.user_id, conn.connection_id, env['BRAIN_WORK_ID'])).fetchone()
            text = report_message.render_period(start, end, revision,
                dict(zip(('summary', 'judgments', 'next_checks', 'message'), row)))
            conn.execute('select brain.extension_channel_send(%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)',
                (env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], 'garmin.period_report', key,
                 'period_report', str(revision), text, document, '[]', None)).fetchone()


def run(env=None, *, writer=None):
    actual = os.environ if env is None else env
    if actual.get('BRAIN_WORK_KIND') != 'garmin.period_analysis':
        raise InvalidReportInput('wrong work kind')
    account, cfg = report_runtime.envelope(actual)
    with store.supervised_account(account), store.report_session(cfg, blocking=True):
        with store.write_session(cfg) as conn:
            report_runtime.validate_account(conn, account, cfg)
            with store.transaction(conn):
                raw = conn.execute('select brain.extension_work_input(%s,%s)',
                    (account.work_id, account.attempt_token)).fetchone()[0]
                data = validate_input(raw)
                saved = _saved(conn, account.work_id)
        if saved is None:
            report_runtime.install_skills(cfg)
            result = _analyze(cfg, data, report.CodexWriter(executable=report.codex_executable(actual)) if writer is None else writer)
            saved = _save(cfg, data, result, account.work_id)
        _send(cfg, saved, actual)
        return json.dumps({'status': 'success', 'revision': saved[2], 'send_requested': True})
