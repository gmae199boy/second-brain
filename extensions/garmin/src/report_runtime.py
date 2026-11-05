"""Validated supervised report context; no standalone config file is loaded."""
import json
import shutil
from datetime import time
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

from garmin_pipeline import config, store


class InvalidReportInput(Exception):
    pass


_STRING_SETTINGS = {'garmin.timezone', 'garmin.tokenstore', 'garmin.capture_manifest',
                    'garmin.legacy_conversation_id', 'garmin.analysis_agent',
                    'garmin.analysis_model', 'garmin.analysis_reasoning_effort'}
_ALLOWED = _STRING_SETTINGS | {'garmin.analysis_timeout_minutes'}


def validate_settings(values):
    if not isinstance(values, dict) or not set(values) <= _ALLOWED:
        raise ValueError('invalid settings')
    if any(not isinstance(values[k], str) for k in _STRING_SETTINGS & values.keys()):
        raise ValueError('invalid string setting')
    if values.get('garmin.analysis_agent', 'codex') != 'codex':
        raise ValueError('invalid analysis agent')
    if 'garmin.analysis_model' in values and not values['garmin.analysis_model'].strip():
        raise ValueError('invalid model')
    if values.get('garmin.analysis_reasoning_effort', 'high') not in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh'):
        raise ValueError('invalid reasoning effort')
    timeout = values.get('garmin.analysis_timeout_minutes', 20)
    if type(timeout) not in (int, float) or not 1 <= timeout <= 9007199254740991 or int(timeout) != timeout:
        raise ValueError('invalid timeout')


def _uuid(value):
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError('non-canonical UUID')
    return parsed


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate snapshot key')
        result[key] = value
    return result


def envelope(env):
    try:
        if env['BRAIN_ABI_VERSION'] != '1' or env['BRAIN_WORK_KIND'] not in ('garmin.report', 'garmin.report_regenerate') or env['BRAIN_TARGET_KIND'] != 'extension':
            raise ValueError('wrong work')
        if not env['BRAIN_DATABASE_URL'].startswith(('postgres://', 'postgresql://')):
            raise ValueError('invalid database')
        generation = env['BRAIN_RUN_GENERATION']
        if not generation.isascii() or not generation.isdigit() or generation.startswith('0') or len(generation) > 9:
            raise ValueError('invalid generation')
        user = _uuid(env['BRAIN_USER_ID'])
        account = store.AccountContext(user, _uuid(env['BRAIN_TARGET_ID']), _uuid(env['BRAIN_WORK_ID']), _uuid(env['BRAIN_ATTEMPT_TOKEN']))
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'], object_pairs_hook=_unique_object)
        if not isinstance(snapshot, dict) or set(snapshot) != {'version', 'extension', 'user_id', 'values'} or type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['extension'] != 'garmin' or snapshot['user_id'] != str(user):
            raise ValueError('invalid snapshot')
        values = snapshot['values']
        validate_settings(values)
        # Collect shares settings validation but does not require an analysis model.
        model = values['garmin.analysis_model']
        if not model.strip():
            raise ValueError('missing analysis model')
        timezone = values['garmin.timezone']
        ZoneInfo(timezone)
        home = Path(env['BRAIN_EXTENSION_HOME'])
        if not home.is_absolute():
            raise ValueError('invalid home')
        root = home / 'reports' / 'accounts' / str(account.user_id) / str(account.connection_id)
        cfg = config.Config(path=root / 'runtime-config', environment='runtime', tokenstore=root / 'unused-tokenstore',
            data_dir=root / 'data', reports_dir=root / 'reports', inbox_dir=root / 'inbox', timezone=timezone,
            collect_time=time(11), retry_time=time(11, 15), report_time=time(11, 30), report_wait_minutes=30,
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
    account, cfg = envelope(actual)
    regenerate = actual['BRAIN_WORK_KIND'] == 'garmin.report_regenerate'
    with store.supervised_account(account), store.report_session(cfg, blocking=not regenerate):
        with store.write_session(cfg) as conn:
            validate_account(conn, account, cfg)
        install_skills(cfg)
        if writer is None:
            import body_runtime
            def body_handler(action, **kwargs):
                return body_runtime.execute(actual, action, **kwargs)
            writer = report.CodexWriter(body_handler=body_handler)
        return json.dumps(report.run_supervised(cfg, writer, regenerate=regenerate))
