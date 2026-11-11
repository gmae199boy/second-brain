"""Validated supervised report context; no standalone config file is loaded."""
import json
import shutil
from datetime import date, time
from pathlib import Path
from zoneinfo import ZoneInfo

from garmin_pipeline import config, store
from scheduled_date import scheduled_date
from supervised_input import decode_envelope


class InvalidReportInput(Exception):
    pass


def envelope(env, *, sending=False):
    try:
        account, values = decode_envelope(env, work_kinds=(('garmin.report_send',) if sending else ('garmin.report', 'garmin.report_regenerate', 'garmin.period_analysis')),
                                          reject_duplicate_keys=True)
        # Collect shares settings validation but does not require an analysis model.
        model = values.get('garmin.analysis_model') if sending else values['garmin.analysis_model']
        if not sending and not model.strip():
            raise ValueError('missing analysis model')
        timezone = values['garmin.timezone']
        ZoneInfo(timezone)
        home = Path(env['BRAIN_EXTENSION_HOME'])
        if not home.is_absolute():
            raise ValueError('invalid home')
        root = home / 'reports' / 'accounts' / str(account.user_id) / str(account.connection_id)
        cfg = config.Config(path=root / 'runtime-config', environment='runtime', tokenstore=root / 'unused-tokenstore',
            data_dir=root / 'data', reports_dir=root / 'reports', inbox_dir=root / 'inbox', timezone=timezone,
            # 기존 Config 생성자 호환용 중립값이며 분석 실행·자료 창에는 사용하지 않는다.
            collect_time=time.min, retry_time=time.min, report_time=time.min, report_wait_minutes=0,
            report_codex_timeout_minutes=int(values.get('garmin.analysis_timeout_minutes', 20)),
            report_model=model, report_reasoning_effort=values.get('garmin.analysis_reasoning_effort', 'high'),
            profile_path=root / 'profile.md', date_pause_seconds=5, call_pause_min_seconds=1,
            call_pause_max_seconds=2, max_dates_per_run=10, max_rejected_attempts=3,
            max_consecutive_403=3, lock_wait_seconds=60, cffi_api_session=False)
        return account, cfg
    except (KeyError, ValueError, TypeError, OverflowError, OSError) as exc:
        raise InvalidReportInput('invalid supervised report input') from exc


def validate_account(conn, account, cfg):
    """Check selected ownership and timezone under the store's attempt fence."""
    with store.transaction(conn):
        row = conn.execute('select timezone from garmin.account_connections where user_id=%s and connection_id=%s',
                           (account.user_id, account.connection_id)).fetchone()
        if not row or row[0] != cfg.timezone:
            raise InvalidReportInput('account timezone mismatch')


def install_skills(cfg):
    """Place the packaged skills under the selected account's Codex workspace."""
    source = Path(__file__).resolve().parent.parent / 'skills'
    destination = cfg.path.parent / '.agents' / 'skills'
    for name in ('garmin-body-intake', 'garmin-daily-analysis', 'garmin-period-review'):
        target = destination / name
        target.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(source / name / 'SKILL.md', target / 'SKILL.md')


def run(env=None, *, writer=None):
    """Validate and bind the selected account until every successful append."""
    import os
    from garmin_pipeline import report
    actual = os.environ if env is None else env
    if actual.get('BRAIN_WORK_KIND') == 'garmin.report_send':
        return send_saved(actual)
    account, cfg = envelope(actual)
    if writer is None:
        report.codex_executable(actual)
    try:
        day = scheduled_date(actual, cfg.timezone)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise InvalidReportInput('invalid scheduled date') from exc
    regenerate = actual['BRAIN_WORK_KIND'] == 'garmin.report_regenerate'
    with store.supervised_account(account), store.report_session(cfg, blocking=not regenerate):
        with store.write_session(cfg) as conn:
            validate_account(conn, account, cfg)
        install_skills(cfg)
        if writer is None:
            import body_runtime
            def body_handler(action, **kwargs):
                return body_runtime.execute(actual, action, **kwargs)
            writer = report.CodexWriter(executable=report.codex_executable(actual), body_handler=body_handler)
        import report_publish
        try:
            return json.dumps(report.run_supervised(cfg, writer, regenerate=regenerate, **({'today': day} if day is not None else {})))
        except (report.SupervisedReportFailed, report_publish.FilesFailed, OSError):
            import report_channel
            from garmin_pipeline import dates
            report_channel.failure(cfg, day if day is not None else dates.today(cfg), actual)
            raise


def send_saved(env):
    """manual의 target은 선택 계정의 리포트 날짜이며 기본값은 오늘이다."""
    from garmin_pipeline import dates, report
    import report_channel
    try:
        target = env['BRAIN_TARGET_ID']
        day = None if target == 'default' else date.fromisoformat(target)
        if day is not None and day.isoformat() != target:
            raise ValueError('invalid report date')
        # [ASSUMPTION] 날짜가 target인 이 manual만 연결은 검증된 사용자 설정에서 읽는다.
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
        selected = dict(env, BRAIN_TARGET_ID=snapshot['values']['garmin.connection_id'])
        account, cfg = envelope(selected, sending=True)
    except (KeyError, ValueError, TypeError) as exc:
        raise InvalidReportInput('invalid report-send input') from exc
    day = day or dates.today(cfg)
    with store.supervised_account(account), store.report_session(cfg, blocking=False):
        with store.write_session(cfg) as conn:
            validate_account(conn, account, cfg)
        # 각 attempt는 첫 선택 revision을 유지한다. 분석기는 호출하지 않는다.
        revisions = report._work_revisions(cfg, day, False)
        if set(revisions) != {'day', '7d', '30d', 'all'}:
            raise InvalidReportInput('missing saved evaluation')
        import report_publish
        reason = None
        try:
            document, rows, source = report_publish.saved_send_attachments(cfg, day, revisions, env)
        except report_publish.RenderUnavailable:
            # 결정적 렌더링을 사용할 수 없을 때만 문구 전용으로 명시한다.
            document, rows, source, reason = None, [], 'unavailable', 'artifact_render_unavailable'
        request = report_channel.success(cfg, day, revisions, document, env, regenerate=True,
                                         attachment_rows=rows, missing_reason=reason)
    return json.dumps({'status': 'queued', 'request_id': str(request),
                       'attachments': source, 'attachment_reason': reason})
