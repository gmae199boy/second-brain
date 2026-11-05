"""Supervised adapter contract; all tests run later in 21.8."""
import contextlib
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from collect_credentials import CredentialEvidenceError, _evidence, verify_credentials
from collect_refresh import approve, begin, recover
from collect_runtime import SupervisedGarmin
from garmin_pipeline import collect, errors, garmin, store
from test_collect_credentials import USER, CONNECTION, CredentialTest, Conn


class RefreshTest(CredentialTest):
    def test_refresh_recovery_and_manual_replacement(self):
        conn = Conn()
        @contextlib.contextmanager
        def transaction(_): yield
        with patch.object(store, 'transaction', transaction):
            verify_credentials(conn, self.cfg)
            evidence, _ = _evidence(self.directory)
            stage = begin(self.cfg, evidence)
            (stage / 'garmin_tokens.json').write_bytes(b'refreshed-synthetic-token')
            approve(stage, evidence, evidence['external_identity'])
            # Simulate a restart with the active journal still present.
            recover(conn, self.cfg)
            verify_credentials(conn, self.cfg)
            self.assertEqual(self.token.read_bytes(), b'refreshed-synthetic-token')
            self.assertFalse(stage.exists())
            self.token.write_bytes(b'manually-replaced')
            with self.assertRaises(CredentialEvidenceError): verify_credentials(conn, self.cfg)

    def test_recovery_after_database_commit_before_token_publish(self):
        import collect_refresh
        conn = Conn()
        @contextlib.contextmanager
        def transaction(_): yield
        with patch.object(store, 'transaction', transaction):
            verify_credentials(conn, self.cfg)
            evidence, _ = _evidence(self.directory)
            stage = begin(self.cfg, evidence)
            (stage / 'garmin_tokens.json').write_bytes(b'refreshed-after-crash')
            approve(stage, evidence, evidence['external_identity'])
            original = collect_refresh._atomic
            def crash(path, data):
                if path.name == 'garmin_tokens.json' and path.parent == self.directory:
                    raise OSError('synthetic crash')
                return original(path, data)
            with patch.object(collect_refresh, '_atomic', side_effect=crash):
                with self.assertRaises(OSError): recover(conn, self.cfg)
            self.assertTrue(stage.exists())
            recover(conn, self.cfg)
            verify_credentials(conn, self.cfg)
            self.assertEqual(self.token.read_bytes(), b'refreshed-after-crash')


class AdapterTest(unittest.TestCase):
    def test_blocked_and_invalid_evidence_never_login(self):
        ledger = []
        cfg = SimpleNamespace(tokenstore=Path('/synthetic'), lock_wait_seconds=0)
        @contextlib.contextmanager
        def lock(*args): yield
        @contextlib.contextmanager
        def transaction(*args): yield
        adapter = SupervisedGarmin(cfg, object(), sleep=lambda value: ledger.append(('sleep', value)))
        with patch.object(garmin, '_session_lock', lock), patch.object(store, 'transaction', transaction), patch('collect_runtime.recover'), patch('collect_runtime.verify_credentials', side_effect=CredentialEvidenceError('invalid')), patch.object(garmin, '_refuse_if_blocked'), patch.object(garmin, '_configured_client', side_effect=lambda _: ledger.append(('login',))):
            with self.assertRaises(CredentialEvidenceError):
                with adapter.open_session(): pass
        self.assertEqual(ledger, [])
        with patch.object(garmin, '_session_lock', lock), patch.object(garmin, '_refuse_if_blocked', side_effect=garmin.SessionBlocked(errors.RunStatus.RATE_LIMITED)), patch.object(garmin, '_configured_client', side_effect=lambda _: ledger.append(('login',))):
            with self.assertRaises(garmin.SessionBlocked):
                with adapter.open_session(): pass
        self.assertEqual(ledger, [])

    def test_login_failure_and_profile_mismatch_have_no_data_calls(self):
        ledger = []
        with tempfile.TemporaryDirectory() as root:
            cfg = SimpleNamespace(tokenstore=Path(root), lock_wait_seconds=0)
            @contextlib.contextmanager
            def lock(*args): yield
            @contextlib.contextmanager
            def transaction(*args): yield
            client = SimpleNamespace(profile_id=99)
            def login(*args): ledger.append('login')
            def stage(*args):
                path = cfg.tokenstore / '.brain-refresh'; path.mkdir(exist_ok=True); return path
            adapter = SupervisedGarmin(cfg, object())
            with patch.object(garmin, '_session_lock', lock), patch.object(store, 'transaction', transaction), patch('collect_runtime.recover'), patch('collect_runtime.verify_credentials'), patch('collect_runtime._evidence', return_value=({'external_identity':'1'}, 'ref')), patch('collect_runtime.begin', side_effect=stage), patch('collect_runtime.approve'), patch.object(garmin, '_refuse_if_blocked'), patch.object(garmin, '_configured_client', return_value=client), patch.object(garmin, '_run_login_step', side_effect=login):
                with self.assertRaises(errors.AuthFailed):
                    with adapter.open_session(): ledger.append('data')
            self.assertEqual(ledger, ['login'])

    def test_plan_stops_after_auth_failure_and_counts_waits(self):
        ledger = []
        class Port:
            @contextlib.contextmanager
            def open_session(self, *, first_call_endpoints=()):
                ledger.append(('login', first_call_endpoints))
                raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
                yield
        stop = collect._collect_plan(object(), SimpleNamespace(date_pause_seconds=5), Port(), lambda n: ledger.append(('wait', n)), [(date(2026,1,2), ['sleep_data'])], 1, date(2026,1,2), {}, lambda _: False, ())
        self.assertEqual(stop[0], errors.RunStatus.AUTH_FAILED)
        self.assertEqual(ledger, [('login', ())])

    def test_date_wait_and_first_call_limit_use_fake_request_ledger(self):
        ledger = []
        class Session: pass
        class Port:
            @contextlib.contextmanager
            def open_session(self, *, first_call_endpoints=()):
                ledger.append(('open', first_call_endpoints)); yield Session()
        def fetch(conn, session, run_id, today, scope, key, endpoint):
            ledger.append(('fetch', key, endpoint)); return None
        dates = [date(2026, 1, day) for day in range(1, collect.FIRST_CALL_LIMIT + 3)]
        plan = [(day, ['sleep_data']) for day in dates]
        failures = {collect.coverage.FetchErrorKind.TRANSIENT: 0, collect.coverage.FetchErrorKind.REJECTED: 0}
        with patch.object(collect, '_fetch', side_effect=fetch), patch.object(collect, '_pending_activities', return_value=[]):
            result = collect._collect_plan(object(), SimpleNamespace(date_pause_seconds=5), Port(), lambda seconds: ledger.append(('wait', seconds)), plan, 1, dates[-1], failures, lambda _: False, ('sleep_data',))
        self.assertIsNone(result)
        self.assertEqual(sum(item[0] == 'fetch' for item in ledger), collect.FIRST_CALL_LIMIT)
        self.assertEqual(sum(item == ('wait', 5) for item in ledger), len(dates) - 1)

    def test_adapter_data_call_waits_before_each_request(self):
        ledger = []
        cfg = SimpleNamespace(call_pause_min_seconds=1, call_pause_max_seconds=2)
        session = garmin._Session(object(), cfg, Path('/synthetic'), lambda seconds: ledger.append(('wait', seconds)))
        with patch.object(garmin.random, 'uniform', return_value=1.5):
            result = session._fetch('sleep_data', lambda: ledger.append(('request',)) or {'synthetic': True})
        self.assertEqual(ledger, [('wait', 1.5), ('request',)])
        self.assertEqual(result.endpoint, 'sleep_data')


class LoginBoundaryTest(unittest.TestCase):
    def test_actual_adapter_login_classification_and_profile_gate(self):
        class LibraryError(Exception):
            __module__ = 'garminconnect.synthetic'
            def __init__(self, status=None):
                self.response = SimpleNamespace(status_code=status)
        cases = [(LibraryError(401), errors.AuthFailed, None),
                 (LibraryError(None), errors.AuthFailed, None),  # MFA/reauth required
                 (LibraryError(429), errors.RateLimited, errors.RunStatus.RATE_LIMITED),
                 (LibraryError(403), errors.Blocked403, errors.RunStatus.BLOCKED_403),
                 (OSError('synthetic'), errors.Transient, None),
                 (None, errors.AuthFailed, None)]  # missing profile
        for failure, expected, block in cases:
            with self.subTest(kind=expected, block=block), tempfile.TemporaryDirectory() as root:
                ledger = []
                cfg = SimpleNamespace(tokenstore=Path(root), lock_wait_seconds=0)
                @contextlib.contextmanager
                def lock(*args): yield
                @contextlib.contextmanager
                def transaction(*args): yield
                def login(_):
                    ledger.append('login')
                    if failure: raise failure
                client = SimpleNamespace(login=login, profile_id=None)
                def stage(*args):
                    path = cfg.tokenstore / '.brain-refresh'; path.mkdir(); return path
                adapter = SupervisedGarmin(cfg, object())
                with patch.object(garmin, '_session_lock', lock), patch.object(store, 'transaction', transaction), patch('collect_runtime.verify_credentials'), patch('collect_runtime._evidence', return_value=({'external_identity': '1'}, 'ref')), patch('collect_runtime.begin', side_effect=stage), patch('collect_runtime.approve'), patch.object(garmin, '_refuse_if_blocked'), patch.object(garmin, '_configured_client', return_value=client), patch.object(garmin, '_record_block', side_effect=lambda token, cfg, reason: ledger.append(('block', reason))), patch('collect_runtime.recover') as recover:
                    with self.assertRaises(expected):
                        with adapter.open_session(): ledger.append('data')
                    self.assertEqual(recover.call_count, 2)
                self.assertEqual(ledger, ['login'] + ([('block', block)] if block else []))

    def test_matching_profile_allows_data_then_verified_publish(self):
        with tempfile.TemporaryDirectory() as root:
            ledger = []
            cfg = SimpleNamespace(tokenstore=Path(root), lock_wait_seconds=0)
            @contextlib.contextmanager
            def lock(*args): yield
            @contextlib.contextmanager
            def transaction(*args): yield
            def stage(*args):
                path = cfg.tokenstore / '.brain-refresh'; path.mkdir(); return path
            client = SimpleNamespace(profile_id='1', login=lambda _: ledger.append('login'))
            with patch.object(garmin, '_session_lock', lock), patch.object(store, 'transaction', transaction), patch('collect_runtime.verify_credentials'), patch('collect_runtime._evidence', return_value=({'external_identity': '1'}, 'ref')), patch('collect_runtime.begin', side_effect=stage), patch('collect_runtime.approve'), patch.object(garmin, '_refuse_if_blocked'), patch.object(garmin, '_configured_client', return_value=client), patch('collect_runtime.recover', side_effect=lambda *args: ledger.append('recover')):
                with SupervisedGarmin(cfg, object()).open_session(): ledger.append('data')
            self.assertEqual(ledger, ['recover', 'login', 'data', 'recover'])


class DurableRefreshTest(CredentialTest):
    @contextlib.contextmanager
    def transaction(self, _):
        yield

    def prepared(self):
        conn = Conn()
        verify_credentials(conn, self.cfg)
        evidence, _ = _evidence(self.directory)
        stage = begin(self.cfg, evidence)
        (stage / 'garmin_tokens.json').write_bytes(b'verified-refresh')
        return conn, evidence, stage

    def test_unapproved_or_interrupted_approval_preserves_original_and_can_retry(self):
        import collect_refresh as refresh
        for boundary in ('before-snapshot', 'after-snapshot'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as nested:
                # Use independent credential fixtures for each crash boundary.
                other = CredentialTest(); other.setUp()
                try:
                    conn = Conn(); verify_credentials(conn, other.cfg)
                    evidence, _ = _evidence(other.directory)
                    stage = begin(other.cfg, evidence)
                    (stage / 'garmin_tokens.json').write_bytes(b'unapproved')
                    atomic = refresh._atomic
                    def crash(path, data):
                        if path.name == ('approved-token.json' if boundary == 'before-snapshot' else 'approval.json'):
                            raise OSError('crash')
                        return atomic(path, data)
                    with patch.object(refresh, '_atomic', side_effect=crash):
                        with self.assertRaises(OSError): approve(stage, evidence, evidence['external_identity'])
                    with patch.object(store, 'transaction', self.transaction): recover(conn, other.cfg)
                    self.assertEqual(other.token.read_bytes(), b'synthetic-token')
                    self.assertEqual(conn.ref, 'sha256:' + evidence['token_sha256'])
                    self.assertFalse(stage.exists())
                    verify_credentials(conn, other.cfg)
                finally: other.doCleanups()

    def test_approved_snapshot_survives_later_working_token_change(self):
        conn, evidence, stage = self.prepared()
        approve(stage, evidence, evidence['external_identity'])
        (stage / 'garmin_tokens.json').write_bytes(b'unverified-later-refresh')
        with patch.object(store, 'transaction', self.transaction): recover(conn, self.cfg)
        self.assertEqual(self.token.read_bytes(), b'verified-refresh')
        verify_credentials(conn, self.cfg)

    def test_publication_crash_boundaries_are_recoverable(self):
        import collect_refresh as refresh
        # Before/after DB commit, token replace, evidence replace, rename, and cleanup.
        for boundary in ('db-before', 'db-after', 'token-before', 'token-after',
                         'evidence-before', 'evidence-after', 'rename-after', 'cleanup-before'):
            with self.subTest(boundary=boundary):
                other = CredentialTest(); other.setUp()
                try:
                    conn = Conn(); verify_credentials(conn, other.cfg)
                    evidence, _ = _evidence(other.directory)
                    stage = begin(other.cfg, evidence)
                    (stage / 'garmin_tokens.json').write_bytes(b'verified-refresh')
                    approve(stage, evidence, evidence['external_identity'])
                    atomic, rename, remove = refresh._atomic, refresh.os.rename, refresh._remove
                    @contextlib.contextmanager
                    def transaction(_):
                        if boundary == 'db-before': raise RuntimeError('crash')
                        yield
                        if boundary == 'db-after': raise RuntimeError('crash')
                    def interrupted_atomic(path, data):
                        kind = 'token' if path.name == 'garmin_tokens.json' else 'evidence'
                        if boundary == kind + '-before': raise RuntimeError('crash')
                        atomic(path, data)
                        if boundary == kind + '-after': raise RuntimeError('crash')
                    def interrupted_rename(src, dst):
                        rename(src, dst)
                        if boundary == 'rename-after': raise RuntimeError('crash')
                    def interrupted_remove(path):
                        if boundary == 'cleanup-before': raise RuntimeError('crash')
                        remove(path)
                    with patch.object(store, 'transaction', transaction), patch.object(refresh, '_atomic', side_effect=interrupted_atomic), patch.object(refresh.os, 'rename', side_effect=interrupted_rename), patch.object(refresh, '_remove', side_effect=interrupted_remove):
                        with self.assertRaises(RuntimeError): recover(conn, other.cfg)
                    with patch.object(store, 'transaction', self.transaction): recover(conn, other.cfg)
                    self.assertEqual(other.token.read_bytes(), b'verified-refresh')
                    verify_credentials(conn, other.cfg)
                    self.assertFalse(list(other.directory.glob('.brain-finished-*')))
                    self.assertFalse(stage.exists())
                finally: other.doCleanups()

    def test_unknown_or_unsafe_residue_is_preserved_and_rejected(self):
        conn, evidence, stage = self.prepared()
        (stage / 'unexpected').write_bytes(b'unknown')
        with patch.object(store, 'transaction', self.transaction):
            with self.assertRaises(CredentialEvidenceError): recover(conn, self.cfg)
        self.assertTrue(stage.exists())
        self.assertEqual(self.token.read_bytes(), b'synthetic-token')

    def test_unapproved_null_database_binding_stays_null(self):
        conn = Conn()
        verify_credentials(conn, self.cfg, bind=False)
        evidence, _ = _evidence(self.directory)
        stage = begin(self.cfg, evidence)
        (stage / 'garmin_tokens.json').write_bytes(b'unapproved')
        with patch.object(store, 'transaction', self.transaction): recover(conn, self.cfg)
        self.assertIsNone(conn.ref)
        self.assertEqual(self.token.read_bytes(), b'synthetic-token')
        self.assertFalse(stage.exists())

    def test_owned_pending_is_removed_and_unsafe_pending_is_preserved(self):
        conn = Conn(); verify_credentials(conn, self.cfg)
        pending = self.directory / '.brain-stage-abcdefgh'; pending.mkdir(mode=0o700)
        (pending / 'garmin_tokens.json').write_bytes(b'partial'); (pending / 'garmin_tokens.json').chmod(0o600)
        with patch.object(store, 'transaction', self.transaction): recover(conn, self.cfg)
        self.assertFalse(pending.exists())
        pending.mkdir(mode=0o700); (pending / 'unknown').write_bytes(b'unknown')
        with patch.object(store, 'transaction', self.transaction):
            with self.assertRaises(CredentialEvidenceError): recover(conn, self.cfg)
        self.assertTrue(pending.exists())


class CleanupAndAbiTest(CredentialTest):
    @contextlib.contextmanager
    def transaction(self, _):
        yield

    def test_partial_unlink_and_empty_cleanup_resume_after_required_validation(self):
        import collect_refresh as refresh
        for approved in (False, True):
            names = ('binding.json', 'garmin_tokens.json', 'approved-token.json', 'approval.json', 'all') if approved else ('binding.json', 'garmin_tokens.json', 'all')
            for removed in names:
                with self.subTest(approved=approved, removed=removed):
                    case = CredentialTest(); case.setUp()
                    try:
                        conn = Conn(); verify_credentials(conn, case.cfg)
                        original_ref, original_token, original_evidence = conn.ref, case.token.read_bytes(), case.evidence.read_bytes()
                        evidence, _ = _evidence(case.directory)
                        stage = begin(case.cfg, evidence)
                        (stage / 'garmin_tokens.json').write_bytes(b'changed-working-token')
                        if approved: approve(stage, evidence, evidence['external_identity'])
                        def interrupt_after_unlink(path):
                            self.assertTrue(path.name.startswith('.brain-cleanup-'))
                            targets = list(path.iterdir()) if removed == 'all' else [path / removed]
                            for item in targets: item.unlink()
                            raise OSError(5, 'synthetic I/O failure')
                        with patch.object(store, 'transaction', self.transaction), patch.object(refresh, '_remove', side_effect=interrupt_after_unlink):
                            with self.assertRaises(OSError): recover(conn, case.cfg)
                        residues = list(case.directory.glob('.brain-cleanup-*'))
                        self.assertEqual(len(residues), 1)
                        if removed == 'all': self.assertEqual(list(residues[0].iterdir()), [])
                        if not approved:
                            self.assertEqual((conn.ref, case.token.read_bytes(), case.evidence.read_bytes()), (original_ref, original_token, original_evidence))
                        with patch.object(store, 'transaction', self.transaction): recover(conn, case.cfg)
                        self.assertFalse(residues[0].exists())
                        verify_credentials(conn, case.cfg)
                        self.assertEqual(case.token.read_bytes(), b'changed-working-token' if approved else original_token)
                    finally: case.doCleanups()

    def test_unsafe_cleanup_and_unverified_original_are_preserved(self):
        conn = Conn(); verify_credentials(conn, self.cfg)
        evidence, _ = _evidence(self.directory)
        stage = begin(self.cfg, evidence)
        # No approval and an altered current credential must never enter cleanup.
        self.token.write_bytes(b'replaced')
        with patch.object(store, 'transaction', self.transaction):
            with self.assertRaises(CredentialEvidenceError): recover(conn, self.cfg)
        self.assertTrue(stage.exists())
        self.assertFalse(list(self.directory.glob('.brain-cleanup-*')))
        self.token.write_bytes(b'synthetic-token')
        residue = self.directory / ('.brain-cleanup-' + 'a' * 32)
        residue.mkdir(mode=0o700)
        (residue / 'unknown').write_bytes(b'unknown')
        with patch.object(store, 'transaction', self.transaction):
            with self.assertRaises(CredentialEvidenceError): recover(conn, self.cfg)
        self.assertTrue(residue.exists()); self.assertTrue(stage.exists())

    def test_real_recover_io_and_validation_errors_reach_safe_abi(self):
        import errno
        import importlib
        import io
        from contextlib import redirect_stdout
        import collect_refresh as refresh
        import collect_runtime as runtime
        entry = importlib.import_module('collect')
        conn = Conn(); verify_credentials(conn, self.cfg)
        evidence, _ = _evidence(self.directory)
        stage = begin(self.cfg, evidence)
        (stage / 'garmin_tokens.json').write_bytes(b'approved-new')
        approve(stage, evidence, evidence['external_identity'])
        original = refresh._atomic
        def fail_publication(path, data):
            if path == self.token: raise OSError(errno.EIO, 'private detail')
            return original(path, data)
        output = io.StringIO()
        with patch.object(store, 'transaction', self.transaction), patch.object(refresh, '_atomic', side_effect=fail_publication), patch.object(runtime, 'run', side_effect=lambda: recover(conn, self.cfg)), redirect_stdout(output):
            self.assertEqual(entry.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'abi': 1, 'type': 'error', 'code': 'COLLECT_UNAVAILABLE', 'retryable': True})
        self.assertTrue(stage.exists()); self.assertEqual(self.token.read_bytes(), b'synthetic-token')
        # Corrupt the approval after the recoverable publication error; preserve it.
        (stage / 'approval.json').write_text('{invalid')
        output = io.StringIO()
        with patch.object(store, 'transaction', self.transaction), patch.object(runtime, 'run', side_effect=lambda: recover(conn, self.cfg)), redirect_stdout(output):
            self.assertEqual(entry.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), {'abi': 1, 'type': 'error', 'code': 'COLLECT_INVALID', 'retryable': False})
        self.assertTrue(stage.exists())

    def test_actual_recover_validation_failures_are_permanent_and_preserved(self):
        import importlib
        import io
        from contextlib import redirect_stdout
        import collect_runtime as runtime
        entry = importlib.import_module('collect')
        for failure in ('missing', 'profile', 'hash', 'permissions', 'symlink'):
            with self.subTest(failure=failure):
                case = CredentialTest(); case.setUp()
                try:
                    conn = Conn(); verify_credentials(conn, case.cfg)
                    evidence, _ = _evidence(case.directory)
                    stage = begin(case.cfg, evidence)
                    (stage / 'garmin_tokens.json').write_bytes(b'approved')
                    approve(stage, evidence, evidence['external_identity'])
                    approval = stage / 'approval.json'
                    if failure == 'missing': (stage / 'approved-token.json').unlink()
                    elif failure in ('profile', 'hash'):
                        value = json.loads(approval.read_text())
                        value['profile' if failure == 'profile' else 'token_sha256'] = 'mismatch'
                        approval.write_text(json.dumps(value))
                    elif failure == 'permissions': approval.chmod(0o644)
                    else:
                        approval.unlink(); approval.symlink_to(stage / 'binding.json')
                    output = io.StringIO()
                    with patch.object(store, 'transaction', self.transaction), patch.object(runtime, 'run', side_effect=lambda: recover(conn, case.cfg)), redirect_stdout(output):
                        self.assertEqual(entry.main(), 1)
                    self.assertEqual(json.loads(output.getvalue()), {'abi': 1, 'type': 'error', 'code': 'COLLECT_INVALID', 'retryable': False})
                    self.assertTrue(stage.exists())
                    self.assertFalse(list(case.directory.glob('.brain-cleanup-*')))
                    self.assertEqual(case.token.read_bytes(), b'synthetic-token')
                finally: case.doCleanups()

    def test_recover_operational_failures_at_each_publication_boundary_are_retryable(self):
        import errno
        import importlib
        import io
        from contextlib import redirect_stdout
        import collect_refresh as refresh
        import collect_runtime as runtime
        entry = importlib.import_module('collect')
        for boundary in ('token', 'evidence', 'rename', 'cleanup'):
            with self.subTest(boundary=boundary):
                case = CredentialTest(); case.setUp()
                try:
                    conn = Conn(); verify_credentials(conn, case.cfg)
                    evidence, _ = _evidence(case.directory)
                    stage = begin(case.cfg, evidence)
                    (stage / 'garmin_tokens.json').write_bytes(b'approved')
                    approve(stage, evidence, evidence['external_identity'])
                    atomic, rename, remove = refresh._atomic, refresh.os.rename, refresh._remove
                    def interrupted_atomic(path, data):
                        if (boundary == 'token' and path == case.token) or (boundary == 'evidence' and path == case.evidence):
                            raise OSError(errno.ENOSPC, 'private')
                        return atomic(path, data)
                    def interrupted_rename(source, target):
                        if boundary == 'rename': raise OSError(errno.EIO, 'private')
                        return rename(source, target)
                    def interrupted_remove(path):
                        if boundary == 'cleanup': raise OSError(errno.EIO, 'private')
                        return remove(path)
                    output = io.StringIO()
                    with patch.object(store, 'transaction', self.transaction), patch.object(refresh, '_atomic', side_effect=interrupted_atomic), patch.object(refresh.os, 'rename', side_effect=interrupted_rename), patch.object(refresh, '_remove', side_effect=interrupted_remove), patch.object(runtime, 'run', side_effect=lambda: recover(conn, case.cfg)), redirect_stdout(output):
                        self.assertEqual(entry.main(), 1)
                    self.assertEqual(json.loads(output.getvalue()), {'abi': 1, 'type': 'error', 'code': 'COLLECT_UNAVAILABLE', 'retryable': True})
                    self.assertTrue(stage.exists() or list(case.directory.glob('.brain-finished-*')) or list(case.directory.glob('.brain-cleanup-*')))
                    with patch.object(store, 'transaction', self.transaction): recover(conn, case.cfg)
                    self.assertEqual(case.token.read_bytes(), b'approved')
                    verify_credentials(conn, case.cfg)
                finally: case.doCleanups()
