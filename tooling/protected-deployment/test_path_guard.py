import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from path_guard import UnsafePath, open_protected, read_pinned_file, require_no_macos_acl


class PathGuardTest(unittest.TestCase):
    def test_pinned_directory_and_rejections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'safe').mkdir(mode=0o700)
            (root / 'link').symlink_to('safe')
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                held = open_protected(fd, ['safe'], os.getuid())
                (root / 'safe').rename(root / 'old')
                (root / 'safe').symlink_to('old')
                self.assertEqual(os.fstat(held).st_ino, os.stat(root / 'old').st_ino)
                os.close(held)
                for parts in (['link'], ['safe'], ['..'], ['a/b']):
                    with self.assertRaises(UnsafePath):
                        open_protected(fd, parts, os.getuid())
                (root / 'old').chmod(0o777)
                with self.assertRaises(UnsafePath):
                    open_protected(fd, ['old'], os.getuid())
            finally:
                os.close(fd)

    def test_pinned_file_rejects_replacement_and_links(self):
        import hashlib
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'file').write_bytes(b'fixed')
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            digest = hashlib.sha256(b'fixed').hexdigest()
            try:
                self.assertEqual(read_pinned_file(fd, 'file', os.getuid(), digest), b'fixed')
                (root / 'file').write_bytes(b'changed')
                with self.assertRaises(UnsafePath):
                    read_pinned_file(fd, 'file', os.getuid(), digest)
                (root / 'file').write_bytes(b'fixed')
                os.link(root / 'file', root / 'hardlink')
                with self.assertRaises(UnsafePath):
                    read_pinned_file(fd, 'file', os.getuid(), digest)
                (root / 'hardlink').unlink()
                (root / 'file').unlink()
                (root / 'file').symlink_to('/dev/null')
                with self.assertRaises(UnsafePath):
                    read_pinned_file(fd, 'file', os.getuid(), digest)
            finally:
                os.close(fd)

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS ACL fixture')
    def test_macos_acl_is_rejected(self):
        import getpass
        with tempfile.TemporaryDirectory() as temp:
            fd = os.open(temp, os.O_RDONLY | os.O_DIRECTORY)
            try:
                require_no_macos_acl(fd)
                result = subprocess.run(['/bin/chmod', '+a', getpass.getuser() + ' allow read', temp], capture_output=True)
                if result.returncode:
                    self.skipTest('fixture ACL 생성 불가')
                with self.assertRaisesRegex(UnsafePath, 'ACL_PRESENT'):
                    require_no_macos_acl(fd)
            finally:
                os.close(fd)

    def test_separate_process_detects_writable_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            os.mkdir(os.path.join(temp, 'bad'), 0o777)
            os.chmod(os.path.join(temp, 'bad'), 0o777)
            script = '''import os, sys
from path_guard import open_protected, UnsafePath
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    open_protected(fd, ['bad'], os.getuid())
except UnsafePath:
    sys.exit(0)
sys.exit(1)
'''
            result = subprocess.run([sys.executable, '-c', script, temp], cwd=os.path.dirname(__file__), check=False)
            self.assertEqual(result.returncode, 0)

class PreflightTest(unittest.TestCase):
    def test_noncanonical_path_and_unverified_engine_are_denied(self):
        from preflight import inspect
        result = inspect('/tmp/../tmp')
        self.assertFalse(result['ready'])
        self.assertIn('INVALID_PATH', result['failures'])
        self.assertIn('ENGINE_ISOLATION_UNVERIFIED', result['failures'])


if __name__ == '__main__':
    unittest.main()
