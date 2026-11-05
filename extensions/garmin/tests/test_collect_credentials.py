"""Offline binding contract; execution deferred to 21.8."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

from collect_credentials import CredentialEvidenceError, verify_credentials

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')


class Cursor:
    def __init__(self, row): self.row = row
    def fetchone(self): return self.row


class Conn:
    user_id, connection_id = USER, CONNECTION
    def __init__(self, ref=None, other=False, profile='synthetic-profile'):
        self.ref, self.other, self.profile, self.sql = ref, other, profile, []
    def execute(self, query, args):
        self.sql.append((query, args))
        if 'select external_identity' in query: return Cursor((self.profile, self.ref))
        if 'select 1 from' in query: return Cursor((1,) if self.other else None)
        if query.startswith('update '): self.ref = args[0]; return Cursor((CONNECTION,))
        return Cursor(None)


class CredentialTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.directory = Path(os.path.realpath(self.tmp.name)); os.chmod(self.directory, 0o700)
        self.token = self.directory / 'garmin_tokens.json'
        self.token.write_bytes(b'synthetic-token'); self.token.chmod(0o600)
        self.evidence = self.directory / 'brain-account-binding.json'
        self.data = {'version': 1, 'user_id': str(USER), 'connection_id': str(CONNECTION),
                     'external_identity': 'synthetic-profile', 'token_sha256': hashlib.sha256(b'synthetic-token').hexdigest()}
        self.write_evidence()
        self.cfg = SimpleNamespace(tokenstore=self.directory)
    def write_evidence(self):
        self.evidence.write_text(json.dumps(self.data)); self.evidence.chmod(0o600)
    def test_null_is_bound_once_and_same_value_accepted(self):
        conn = Conn(); verify_credentials(conn, self.cfg)
        self.assertEqual(conn.ref, 'sha256:' + self.data['token_sha256'])
        self.assertEqual(sum(q.startswith('update ') for q, _ in conn.sql), 1)
        verify_credentials(conn, self.cfg)
        self.assertEqual(sum(q.startswith('update ') for q, _ in conn.sql), 1)
        self.assertIn('pg_advisory_xact_lock', conn.sql[0][0])
    def test_conflicts_and_wrong_profile_are_rejected(self):
        for conn in (Conn(ref='another'), Conn(other=True), Conn(profile='different')):
            with self.subTest(conn=conn), self.assertRaises(CredentialEvidenceError): verify_credentials(conn, self.cfg)
            self.assertFalse(any(q.startswith('update ') for q, _ in conn.sql))
    def test_missing_or_untrusted_evidence_rejected(self):
        for key, bad in [('user_id', str(CONNECTION)), ('connection_id', str(USER)),
                         ('external_identity', 'different'), ('token_sha256', '0' * 64)]:
            old = self.data[key]; self.data[key] = bad; self.write_evidence()
            with self.subTest(key=key), self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
            self.data[key] = old
        self.evidence.unlink()
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
    def test_permissions_symlinks_and_changed_token_rejected(self):
        self.token.chmod(0o644)
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
        self.token.chmod(0o600); self.evidence.chmod(0o644)
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
        self.evidence.chmod(0o600); self.directory.chmod(0o755)
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
        self.directory.chmod(0o700); self.token.write_bytes(b'changed')
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
        self.token.unlink(); self.token.symlink_to(self.evidence)
        with self.assertRaises(CredentialEvidenceError): verify_credentials(Conn(), self.cfg)
