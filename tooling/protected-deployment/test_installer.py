import hashlib
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from installer import create_fixture
from path_guard import UnsafePath


class InstallerTest(unittest.TestCase):
    def test_isolated_render_and_bad_source(self):
        with tempfile.TemporaryDirectory() as parent, tempfile.TemporaryDirectory() as source:
            pathlib.Path(source, 'supervisor').write_bytes(b'fixture binary')
            source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            digest = hashlib.sha256(b'fixture binary').hexdigest()
            try:
                with self.assertRaises(UnsafePath):
                    create_fixture(parent_fd, 'bad', source_fd, '0' * 64, os.getuid())
                self.assertFalse(pathlib.Path(parent, 'bad').exists())
                create_fixture(parent_fd, 'stage', source_fd, digest, os.getuid())
                self.assertEqual(pathlib.Path(parent, 'stage/supervisor.bin').read_bytes(), b'fixture binary')
                self.assertEqual(os.stat(pathlib.Path(parent, 'stage/credentials')).st_mode & 0o777, 0o700)
                policy = json.loads(pathlib.Path(parent, 'stage/service-policy.json').read_text())
                self.assertEqual(policy['environment'], {'PATH': '/usr/bin:/bin', 'LANG': 'C'})
                self.assertEqual(len({service['principal'] for service in policy['services']}), 3)
                self.assertFalse(policy['auth_input'])
                self.assertFalse(policy['external_http'])
                with self.assertRaises(FileExistsError):
                    create_fixture(parent_fd, 'stage', source_fd, digest, os.getuid())
            finally:
                os.close(source_fd)
                os.close(parent_fd)

    def test_partial_creation_rolls_back(self):
        with tempfile.TemporaryDirectory() as parent, tempfile.TemporaryDirectory() as source:
            pathlib.Path(source, 'supervisor').write_bytes(b'fixture binary')
            source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            digest = hashlib.sha256(b'fixture binary').hexdigest()
            original_mkdir = os.mkdir
            def fail_config(path, *args, **kwargs):
                if path == 'config':
                    raise OSError('fixture failure')
                return original_mkdir(path, *args, **kwargs)
            try:
                with patch('installer.os.mkdir', side_effect=fail_config):
                    with self.assertRaises(OSError):
                        create_fixture(parent_fd, 'stage', source_fd, digest, os.getuid())
                self.assertFalse(pathlib.Path(parent, 'stage').exists())
            finally:
                os.close(source_fd)
                os.close(parent_fd)

    def test_rejects_unsafe_parent(self):
        with tempfile.TemporaryDirectory() as parent, tempfile.TemporaryDirectory() as source:
            pathlib.Path(source, 'supervisor').write_bytes(b'fixture binary')
            source_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.chmod(parent, 0o777)
                with self.assertRaisesRegex(UnsafePath, 'UNSAFE_PARENT'):
                    create_fixture(parent_fd, 'stage', source_fd, hashlib.sha256(b'fixture binary').hexdigest(), os.getuid())
                self.assertFalse(pathlib.Path(parent, 'stage').exists())
            finally:
                os.close(source_fd)
                os.close(parent_fd)
