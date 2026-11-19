"""Synthetic coverage for the official Garmin authentication ABI."""
import contextlib
import base64
import threading
import io
import json
import logging
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import auth as entry
from garmin_pipeline import errors, garmin

USER = '019a0000-0000-7000-8000-000000000001'
SECRET = 'synthetic-password-mfa-token'
TOKEN = json.dumps({'di_token': 'synthetic-token', 'di_refresh_token': 'synthetic-refresh', 'di_client_id': 'synthetic-client'})


class OfficialAuthTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.tokenstore = self.home / 'tokenstore'
        self.env = {'BRAIN_EXTENSION_HOME': str(self.home), 'BRAIN_SETTINGS_SNAPSHOT': json.dumps({
            'version': 1, 'extension': 'garmin', 'user_id': USER,
            'values': {'garmin.tokenstore': str(self.tokenstore)}})}

    def invoke(self, args, env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = entry.main(args, self.env if env is None else env)
        return status, stdout.getvalue(), stderr.getvalue()

    def put_token(self, value=TOKEN):
        self.tokenstore.mkdir(mode=0o700, exist_ok=True)
        path = self.tokenstore / 'garmin_tokens.json'
        path.write_text(value)
        path.chmod(0o600)
        return path

    def test_inline_probe_preserves_original_and_binding_without_temporary_file(self):
        token = self.put_token()
        binding = self.tokenstore / 'brain-account-binding.json'
        binding.write_text('synthetic-binding')
        seen = []
        class Client:
            def __init__(self): self.client = self
            def login(self, arg):
                seen.append(json.loads(arg))
                self.assert_no_path = arg.startswith('{')
        with patch.object(entry.garmin, '_configured_client', return_value=Client()):
            status, out, err = self.invoke([])
        self.assertEqual((status, json.loads(out), err), (0, {'abi': 1, 'type': 'result'}, ''))
        self.assertEqual(seen, [json.loads(TOKEN)])
        self.assertEqual(token.read_text(), TOKEN)
        self.assertEqual(binding.read_text(), 'synthetic-binding')
        self.assertFalse(any(p.name.startswith('.auth-probe-') for p in self.tokenstore.iterdir()))

    def test_missing_malformed_oversized_and_bound_tokens_have_distinct_results(self):
        self.assertEqual(json.loads(self.invoke([])[1])['code'], 'LOGIN_REQUIRED')
        token = self.put_token('invalid')
        self.assertEqual(json.loads(self.invoke([])[1])['code'], 'LOGIN_REQUIRED')
        token.write_text('x' * (1048576 + 1))
        self.assertEqual(json.loads(self.invoke([])[1])['code'], 'LOGIN_REQUIRED')
        binding = self.tokenstore / 'brain-account-binding.json'
        binding.write_text('bound')
        self.assertEqual(json.loads(self.invoke([])[1])['code'], 'GARMIN_BINDING_RECOVERY_REQUIRED')
        self.assertEqual(binding.read_text(), 'bound')

    def test_rejected_bound_token_never_exposes_secrets(self):
        token = self.put_token()
        (self.tokenstore / 'brain-account-binding.json').write_text('bound')
        def reject(*args):
            print(SECRET)
            raise errors.AuthFailed(errors.AuthFailedReason.TOKEN_INVALID)
        client = type('Client', (), {})()
        client.client = client
        with patch.object(entry.garmin, '_configured_client', return_value=client), patch.object(entry.garmin, '_run_login_step', side_effect=reject):
            status, out, err = self.invoke([])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(out)['code'], 'GARMIN_ACCESS_TOKEN_UNCONFIRMED')
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(token.read_text(), TOKEN)

    def test_rate_limit_and_forbidden_write_original_block_and_keep_token(self):
        token = self.put_token()
        class Client:
            def __init__(self): self.client = self
            def login(self, arg): raise RuntimeError(SECRET)
        for status_code, domain_error in [(429, errors.RateLimited('429')), (403, errors.Blocked403('403'))]:
            with self.subTest(status_code=status_code):
                block = self.tokenstore / 'block.json'
                block.unlink(missing_ok=True)
                with patch.object(entry.garmin, '_configured_client', return_value=Client()), \
                     patch.object(entry.garmin, '_is_classifiable', return_value=True), \
                     patch.object(entry.garmin, '_classify', return_value=(status_code, domain_error)):
                    status, out, err = self.invoke([])
                self.assertEqual(status, 1)
                self.assertEqual(json.loads(out)['code'], 'AUTH_UNAVAILABLE')
                self.assertNotIn(SECRET, out + err)
                self.assertTrue(block.is_file())
                self.assertEqual(token.read_text(), TOKEN)

    def test_actual_client_transport_never_refreshes_and_classifies_response(self):
        # Exercise the pinned Garmin client's real login and request machinery;
        # the only transport is this in-process synthetic response.
        payload = base64.urlsafe_b64encode(b'{"exp":1}').decode().rstrip('=')
        header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
        token = self.put_token(json.dumps({'di_token': header + '.' + payload + '.c2ln', 'di_refresh_token': SECRET, 'di_client_id': 'client'}))
        original = token.read_bytes()
        for status_code in (200, 401, 403, 429, 503):
            with self.subTest(status_code=status_code):
                block = self.tokenstore / 'block.json'
                block.unlink(missing_ok=True)
                client = garmin.garminconnect.Garmin()
                client.client.loads(token.read_text())
                self.assertTrue(client.client._token_expires_soon())
                calls = []
                class Response:
                    status_code = 200
                    text = 'synthetic'
                    def json(self): return {'displayName': 'synthetic', 'userData': {'measurementSystem': 'metric'}}
                class Transport:
                    def request(self, method, url, **kwargs):
                        calls.append((method, url))
                        return Response()
                Response.status_code = status_code
                client.client._api_session = Transport()
                with patch.object(entry.garmin, '_configured_client', return_value=client), \
                     patch.object(client.client, '_http_post', side_effect=AssertionError('refresh transport called')) as refresh, \
                     patch('garminconnect.time.sleep'):
                    status, out, err = self.invoke([])
                refresh.assert_not_called()
                self.assertTrue(calls)
                self.assertEqual(token.read_bytes(), original)
                self.assertNotIn(SECRET, out + err)
                if status_code == 200:
                    self.assertEqual(status, 0)
                elif status_code == 401:
                    self.assertEqual(json.loads(out)['code'], 'LOGIN_REQUIRED')
                else:
                    self.assertEqual(json.loads(out)['code'], 'AUTH_UNAVAILABLE')
                    self.assertEqual(block.is_file(), status_code in (403, 429))

    def test_token_save_keyboard_interrupt_removes_temporary_secret(self):
        self.tokenstore.mkdir(mode=0o700)
        client = type('Client', (), {})()
        client.client = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: TOKEN})()
        with patch.object(entry.os, 'replace', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                entry._safe_dump_tokens(client, self.tokenstore, mfa=False, attempts=0)
        self.assertEqual(list(self.tokenstore.iterdir()), [])

    def test_terminal_rejects_non_di_session_before_replacing_token(self):
        token = self.put_token()
        native = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: json.dumps({'di_token': None, 'di_refresh_token': None, 'di_client_id': None})})()
        client = type('Client', (), {'client': native})()
        with self.assertRaises(errors.AuthFailed):
            entry._safe_dump_tokens(client, self.tokenstore, mfa=False, attempts=0)
        self.assertEqual(token.read_text(), TOKEN)
        self.assertEqual([p.name for p in self.tokenstore.iterdir()], ['garmin_tokens.json'])

    def test_terminal_rejects_symlink_tokenstore_and_parent(self):
        other = self.home / 'other'
        other.mkdir()
        self.tokenstore.symlink_to(other, target_is_directory=True)
        with self.assertRaises(OSError):
            entry._open_tokenstore(self.tokenstore)
        self.tokenstore.unlink()
        parent = self.home / 'link'
        parent.symlink_to(other, target_is_directory=True)
        with self.assertRaises(OSError):
            entry._open_tokenstore(parent / 'tokenstore')
        self.assertEqual(list(other.iterdir()), [])

    def test_bound_at_publication_preserves_token(self):
        token = self.put_token()
        (self.tokenstore / 'brain-account-binding.json').write_text('bound')
        native = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: TOKEN})()
        with self.assertRaises(entry.BindingRecoveryRequired):
            entry._safe_dump_tokens(type('Client', (), {'client': native})(), self.tokenstore, mfa=False, attempts=0)
        self.assertEqual(token.read_text(), TOKEN)

    def test_interrupt_before_publication_cleans_secret_and_preserves_old_token(self):
        token = self.put_token('old-token')
        native = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: TOKEN})()
        client = type('Client', (), {'client': native})()
        fsync = os.fsync
        def interrupt(fd):
            fsync(fd)
            os.kill(os.getpid(), signal.SIGINT)
        with patch.object(entry.os, 'fsync', side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                entry._safe_dump_tokens(client, self.tokenstore, mfa=False, attempts=0)
        self.assertEqual(token.read_text(), 'old-token')
        self.assertEqual([p.name for p in self.tokenstore.iterdir()], ['garmin_tokens.json'])

    def test_interrupt_around_publication_preserves_transaction(self):
        token = self.put_token()
        native = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: TOKEN})()
        client = type('Client', (), {'client': native})()
        replace = os.replace
        def after(*args, **kwargs):
            replace(*args, **kwargs)
            os.kill(os.getpid(), signal.SIGINT)
        with patch.object(entry.os, 'replace', side_effect=after):
            entry._safe_dump_tokens(client, self.tokenstore, mfa=False, attempts=0)
        self.assertEqual(token.read_text(), TOKEN)
        self.assertFalse(any(p.name.startswith('.garmin-login-') for p in self.tokenstore.iterdir()))

    def test_directory_swap_after_fsync_never_publishes_in_either_directory(self):
        token = self.put_token('old-token')
        moved = self.home / 'moved'
        native = type('Native', (), {'_token_lock': threading.RLock(), 'dumps': lambda self: TOKEN})()
        client = type('Client', (), {'client': native})()
        fsync = os.fsync
        def swap(fd):
            fsync(fd)
            self.tokenstore.rename(moved)
            self.tokenstore.mkdir(mode=0o700)
        with patch.object(entry.os, 'fsync', side_effect=swap):
            with self.assertRaises(ValueError):
                entry._safe_dump_tokens(client, self.tokenstore, mfa=False, attempts=0)
        self.assertEqual((moved / token.name).read_text(), 'old-token')
        self.assertFalse((self.tokenstore / token.name).exists())
        self.assertFalse(any(p.name.startswith('.garmin-login-') for p in moved.iterdir()))

    def test_mfa_swap_keeps_lock_and_403_429_block_in_open_directory(self):
        for code, domain in ((403, errors.Blocked403('403')), (429, errors.RateLimited('429'))):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as root:
                store = Path(root) / 'tokenstore'
                store.mkdir(mode=0o700)
                moved = Path(root) / 'moved'
                cfg = entry.runtime_config(dict(self.env, BRAIN_EXTENSION_HOME=root,
                    BRAIN_SETTINGS_SNAPSHOT=json.dumps({'version': 1, 'extension': 'garmin', 'user_id': USER,
                        'values': {'garmin.tokenstore': str(store)}})))
                class Prompts:
                    def credentials(self): return ('synthetic-email', SECRET)
                    def mfa_code(self):
                        store.rename(moved)
                        store.mkdir(mode=0o700)
                        garmin._write_block(store, garmin.dates.today(cfg), errors.RunStatus.BLOCKED_403)
                        return 'synthetic-mfa'
                class Client:
                    def __init__(self): self.client = self
                    def login(self, *args, **kwargs): return ('needs_mfa', None)
                    def resume_login(self, *args): raise OSError('synthetic')
                fd = entry._open_tokenstore(store)
                try:
                    with patch.object(garmin, '_configured_client', return_value=Client()), \
                         patch.object(garmin, '_classify', return_value=(code, domain)):
                        with self.assertRaises(type(domain)):
                            garmin.interactive_login(cfg, Prompts(), tokenstore_fd=fd)
                    self.assertTrue((moved / '.session.lock').exists())
                    self.assertTrue((moved / 'block.json').exists())
                    self.assertEqual(json.loads((store / 'block.json').read_text())['reason'], 'blocked_403')
                    self.assertEqual(json.loads((moved / 'block.json').read_text())['reason'],
                        'blocked_403' if code == 403 else 'rate_limited')
                finally:
                    os.close(fd)

    def test_terminal_uses_checked_hidden_credentials_and_mfa(self):
        prompts = []
        def login(cfg, inputs, **kwargs):
            self.assertEqual(inputs.credentials(), (SECRET, SECRET))
            self.assertEqual(inputs.mfa_code(), SECRET)
            self.assertEqual(cfg.tokenstore.stat().st_mode & 0o777, 0o700)
        with patch.object(entry.auth, '_require_tty'), \
             patch.object(entry.getpass, 'getpass', side_effect=lambda prompt, stream: prompts.append(prompt) or SECRET), \
             patch.object(entry.garmin, 'interactive_login', side_effect=login):
            status, out, err = self.invoke(['--terminal'])
        self.assertEqual(status, 0)
        self.assertEqual(len(prompts), 3)
        self.assertNotIn(SECRET, out + err)

    def test_terminal_cancel_failure_and_bound_guard(self):
        for failure, code in [(EOFError(SECRET), 'AUTH_CANCELLED'), (KeyboardInterrupt(SECRET), 'AUTH_CANCELLED'), (ValueError(SECRET), 'AUTH_UNAVAILABLE')]:
            def login(*args, **kwargs):
                print(SECRET)
                print(SECRET, file=sys.stderr)
                logging.warning(SECRET)
                raise failure
            with self.subTest(code=code), patch.object(entry.auth, '_require_tty'), patch.object(entry.garmin, 'interactive_login', side_effect=login):
                status, out, err = self.invoke(['--terminal'])
                self.assertEqual((status, err.strip()), (1, code))
                self.assertNotIn(SECRET, out + err)
        binding = self.tokenstore / 'brain-account-binding.json'
        binding.write_text(SECRET)
        with patch.object(entry.auth, '_require_tty'), patch.object(entry.garmin, 'interactive_login') as login:
            status, out, err = self.invoke(['--terminal'])
        self.assertEqual((status, err.strip()), (1, 'GARMIN_BOUND_LOGIN_REFUSED'))
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(binding.read_text(), SECRET)
        login.assert_not_called()

    def test_noninteractive_and_bad_snapshot_are_sanitized(self):
        with patch.object(entry.auth, '_require_tty', side_effect=entry.auth._NotInteractive()):
            self.assertEqual(self.invoke(['--terminal'])[2].strip(), 'LOGIN_REQUIRED')
        bad = dict(self.env, BRAIN_SETTINGS_SNAPSHOT=SECRET)
        status, out, err = self.invoke([], bad)
        self.assertEqual((status, json.loads(out)['code']), (1, 'AUTH_UNAVAILABLE'))
        self.assertNotIn(SECRET, out + err)
