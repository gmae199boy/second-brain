"""별도 UID가 이미 준비된 환경에서만 실행하는 격리 fixture."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


class PrincipalFixture(unittest.TestCase):
    @unittest.skipUnless(os.geteuid() == 0 and os.getenv('BRAIN_FIXTURE_DENIED_UID', '').isdigit(), '별도 fixture UID와 root가 필요함')
    def test_other_principal_cannot_read_or_replace(self):
        uid = int(os.environ['BRAIN_FIXTURE_DENIED_UID'])
        self.assertNotEqual(uid, 0)
        with tempfile.TemporaryDirectory() as root:
            target = pathlib.Path(root, 'protected')
            target.write_bytes(b'fixture')
            target.chmod(0o600)
            code = '''import os, sys
os.setgroups([])
os.setgid(int(sys.argv[2]))
os.setuid(int(sys.argv[1]))
for flags in (os.O_RDONLY, os.O_WRONLY | os.O_TRUNC):
    try:
        fd = os.open(sys.argv[3], flags)
    except PermissionError:
        continue
    os.close(fd)
    sys.exit(1)
sys.exit(0)
'''
            gid = int(os.environ.get('BRAIN_FIXTURE_DENIED_GID', str(uid)))
            result = subprocess.run([sys.executable, '-c', code, str(uid), str(gid), str(target)], check=False)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(target.read_bytes(), b'fixture')
