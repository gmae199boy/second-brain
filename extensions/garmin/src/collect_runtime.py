"""Validate the supervised collect envelope before any external access."""
import contextlib
import json
import time
import os
from datetime import time as clock_time
from pathlib import Path
from uuid import UUID
from zoneinfo import ZoneInfo

from garmin_pipeline import collect, config, dates, errors, garmin, ports, store
from collect_credentials import CredentialEvidenceError, _evidence, verify_credentials
from collect_refresh import approve, begin, recover


class InvalidCollectInput(Exception):
    pass


def _uuid(value):
    parsed = UUID(value)
    if str(parsed) != value:
        raise ValueError('non-canonical UUID')
    return parsed


def envelope(env):
    try:
        if env['BRAIN_ABI_VERSION'] != '1' or env['BRAIN_WORK_KIND'] != 'garmin.collect' or env['BRAIN_TARGET_KIND'] != 'extension':
            raise ValueError('wrong work')
        if not env['BRAIN_DATABASE_URL'].startswith(('postgres://', 'postgresql://')):
            raise ValueError('invalid database')
        generation = env['BRAIN_RUN_GENERATION']
        if not generation.isascii() or not generation.isdigit() or generation.startswith('0') or len(generation) > 9:
            raise ValueError('invalid generation')
        user = _uuid(env['BRAIN_USER_ID'])
        account = store.AccountContext(user, _uuid(env['BRAIN_TARGET_ID']), _uuid(env['BRAIN_WORK_ID']), _uuid(env['BRAIN_ATTEMPT_TOKEN']))
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
        if not isinstance(snapshot, dict) or set(snapshot) != {'version', 'extension', 'user_id', 'values'} or type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['extension'] != 'garmin' or snapshot['user_id'] != str(user):
            raise ValueError('invalid snapshot')
        values = snapshot['values']
        from report_runtime import validate_settings
        if not isinstance(values, dict):
            raise ValueError('invalid settings')
        validate_settings(values)
        allowed = {'garmin.timezone', 'garmin.tokenstore', 'garmin.capture_manifest', 'garmin.legacy_conversation_id'}
        if any(not isinstance(values[k], str) for k in allowed & values.keys()):
            raise ValueError('invalid settings')
        timezone = values['garmin.timezone']
        ZoneInfo(timezone)
        tokenstore = Path(values['garmin.tokenstore'])
        home = Path(env['BRAIN_EXTENSION_HOME'])
        if not tokenstore.is_absolute() or not home.is_absolute():
            raise ValueError('invalid paths')
        # The runtime supplies this machine path. No legacy config file is read.
        cfg = config.Config(path=home / 'unused-config', environment='runtime', tokenstore=tokenstore,
            data_dir=home, reports_dir=home, inbox_dir=home, timezone=timezone,
            collect_time=clock_time(11), retry_time=clock_time(11, 15), report_time=clock_time(11, 30),
            report_wait_minutes=30, report_codex_timeout_minutes=20, report_model=None,
            report_reasoning_effort='high', profile_path=home / 'unused-profile',
            date_pause_seconds=5, call_pause_min_seconds=1, call_pause_max_seconds=2,
            max_dates_per_run=10, max_rejected_attempts=3, max_consecutive_403=3,
            lock_wait_seconds=60, cffi_api_session=False)
        return account, cfg
    except (KeyError, ValueError, TypeError, OverflowError) as exc:
        raise InvalidCollectInput('invalid supervised collect input') from exc


class SupervisedGarmin(garmin.GarminAdapter):
    """Verify and journal the token while holding the adapter session lock."""
    def __init__(self, cfg, conn, *, sleep=time.sleep):
        super().__init__(cfg, sleep=sleep)
        self._conn = conn

    @contextlib.contextmanager
    def open_session(self, *, first_call_endpoints=()):
        first = garmin._first_call_endpoints(first_call_endpoints)
        tokenstore = self._cfg.tokenstore
        with garmin._session_lock(tokenstore, self._cfg.lock_wait_seconds):
            garmin._refuse_if_blocked(tokenstore, self._cfg)
            recover(self._conn, self._cfg)
            with store.transaction(self._conn):
                verify_credentials(self._conn, self._cfg, bind=False)
            evidence, _ = _evidence(tokenstore)
            stage = begin(self._cfg, evidence)
            try:
                client = garmin._configured_client(self._cfg)
                garmin._run_login_step(lambda: client.login(str(stage)), tokenstore, self._cfg)
                profile = getattr(client, 'profile_id', None)
                if profile is None or str(profile) != evidence['external_identity']:
                    raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
                # Snapshot and durably approve the exact token after profile validation.
                # Later library changes to its working copy are never published.
                approve(stage, evidence, str(profile))
                yield garmin._Session(client, self._cfg, tokenstore, self._sleep, first)
            finally:
                recover(self._conn, self._cfg)



def run(env=None, *, port_factory=SupervisedGarmin, sleep=time.sleep):
    account, cfg = envelope(os.environ if env is None else env)
    with store.supervised_account(account), store.write_session(cfg) as conn:
        with store.transaction(conn):
            row = conn.execute('select timezone from garmin.account_connections where user_id=%s and connection_id=%s', (account.user_id, account.connection_id)).fetchone()
            if not row or row[0] != cfg.timezone:
                raise InvalidCollectInput('account timezone mismatch')
        with store.transaction(conn):
            before = conn.execute('select coalesce(max(id), 0) from garmin.run where user_id=%s and connection_id=%s', (account.user_id, account.connection_id)).fetchone()[0]
        collect.run(conn, cfg, port_factory(cfg, conn, sleep=sleep), sleep,
                    today=dates.today(cfg), started_at=dates.now_ms(), manual=True,
                    notifier=ports.TableNotifier(conn))
        with store.transaction(conn):
            row = conn.execute('select id, status from garmin.run where user_id=%s and connection_id=%s and id>%s order by id desc limit 1', (account.user_id, account.connection_id, before)).fetchone()
            if row is None:
                return json.dumps({'status': 'noop', 'runs': 0, 'errors': 0})
            count = conn.execute('select count(*) from garmin.fetch_error where user_id=%s and connection_id=%s and run_id=%s', (account.user_id, account.connection_id, row[0])).fetchone()[0]
        status = str(row[1])
        if status not in {str(value) for value in errors.RunStatus if value != errors.RunStatus.RUNNING}:
            raise RuntimeError('invalid final run status')
        public_status = {
            'success': 'success', 'partial': 'partial',
            'rate_limited': 'blocked', 'blocked_403': 'blocked',
            'skipped_blocked': 'blocked', 'auth_failed': 'auth_required', 'error': 'error',
        }[status]
        if not isinstance(count, int) or isinstance(count, bool) or not 0 <= count <= 9007199254740991:
            raise RuntimeError('invalid error count')
        return json.dumps({'status': public_status, 'runs': 1, 'errors': count})
