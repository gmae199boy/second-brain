"""별도 UID가 이미 준비된 환경에서만 실행하는 격리 fixture."""
import os
import pathlib
import re
import select
import signal
import subprocess
import sys
import tempfile
import unittest


class PrincipalFixture(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'darwin' and os.geteuid() == 0 and os.getenv('BRAIN_FIXTURE_DENIED_UID', '').isdigit() and os.getenv('BRAIN_FIXTURE_WORKER_UID', '').isdigit(), 'macOS의 별도 fixture UID 둘과 root가 필요함')
    def test_native_peer_accepts_only_expected_principal(self):
        worker_uid=int(os.environ['BRAIN_FIXTURE_WORKER_UID']);denied_uid=int(os.environ['BRAIN_FIXTURE_DENIED_UID'])
        worker_gid=int(os.environ.get('BRAIN_FIXTURE_WORKER_GID',str(worker_uid)));denied_gid=int(os.environ.get('BRAIN_FIXTURE_DENIED_GID',str(denied_uid)))
        self.assertNotIn(0,(worker_uid,denied_uid));self.assertNotEqual(worker_uid,denied_uid)
        source=pathlib.Path(__file__).resolve().parent;repo=source.parent.parent
        env={'PATH':'/usr/bin:/bin','LANG':'C'}
        wrapper='''import os,sys
os.setgroups([]);os.setgid(int(sys.argv[2]));os.setuid(int(sys.argv[1]));os.execv(sys.argv[3],sys.argv[3:])
'''
        with tempfile.TemporaryDirectory(prefix='bpp-',dir='/private/tmp') as directory:
            os.chmod(directory,0o755);binary=str(pathlib.Path(directory,'peer'))
            subprocess.run(['/usr/bin/xcrun','clang','-Wall','-Wextra','-Werror',str(source/'peer-principal-fixture.c'),str(repo/'extensions/garmin/native/peer.c'),'-lbsm','-framework','Security','-framework','CoreFoundation','-o',binary],check=True,env=env,timeout=30)
            signature=subprocess.run(['/usr/bin/codesign','-dv','--verbose=4',binary],capture_output=True,text=True,check=True,env=env,timeout=5)
            match=re.search(r'^CDHash=([0-9a-f]{40})$',signature.stderr,re.MULTILINE);self.assertIsNotNone(match)
            socket_dir=pathlib.Path(directory,'socket');socket_dir.mkdir(mode=0o711);os.chown(socket_dir,worker_uid,worker_gid);os.chmod(socket_dir,0o711)
            for index,(peer_uid,peer_gid,expected) in enumerate(((worker_uid,worker_gid,'accepted'),(denied_uid,denied_gid,'rejected'))):
                socket_path=str(socket_dir/f'peer-{index}');read_fd,write_fd=os.pipe()
                server=subprocess.Popen(['/usr/bin/python3','-c',wrapper,str(worker_uid),str(worker_gid),binary,'server',socket_path,str(worker_uid),str(read_fd),match.group(1)],pass_fds=(read_fd,),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=env)
                os.close(read_fd);client=None
                try:
                    self.assertTrue(select.select([server.stdout],[],[],10)[0]);self.assertEqual(server.stdout.readline().strip(),'ready')
                    client=subprocess.Popen(['/usr/bin/python3','-c',wrapper,str(peer_uid),str(peer_gid),binary,'client',socket_path],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env)
                    os.write(write_fd,str(client.pid).encode());os.close(write_fd);write_fd=-1
                    self.assertTrue(select.select([server.stdout],[],[],10)[0]);self.assertEqual(server.stdout.readline().strip(),expected)
                    self.assertEqual(client.wait(timeout=5),0);self.assertEqual(server.wait(timeout=5),0)
                finally:
                    if write_fd>=0:os.close(write_fd)
                    for process in (client,server):
                        if process is not None and process.poll() is None:process.kill();process.wait(timeout=5)
                    if server.stdout:server.stdout.close()

    @unittest.skipUnless(os.geteuid() == 0 and os.getenv('BRAIN_FIXTURE_DENIED_UID', '').isdigit() and os.getenv('BRAIN_FIXTURE_WORKER_UID', '').isdigit(), '서로 다른 fixture UID 둘과 root가 필요함')
    def test_other_uid_cannot_signal_worker_group(self):
        worker_uid = int(os.environ['BRAIN_FIXTURE_WORKER_UID'])
        denied_uid = int(os.environ['BRAIN_FIXTURE_DENIED_UID'])
        worker_gid = int(os.environ.get('BRAIN_FIXTURE_WORKER_GID', str(worker_uid)))
        denied_gid = int(os.environ.get('BRAIN_FIXTURE_DENIED_GID', str(denied_uid)))
        self.assertNotIn(0, (worker_uid, denied_uid))
        self.assertNotEqual(worker_uid, denied_uid)
        run = '''import os,sys,time
os.setgroups([]);os.setgid(int(sys.argv[2]));os.setuid(int(sys.argv[1]));os.setsid()
print('ready',flush=True);time.sleep(30)
'''
        signal_group = '''import os,sys,signal
os.setgroups([]);os.setgid(int(sys.argv[2]));os.setuid(int(sys.argv[1]))
try: os.killpg(int(sys.argv[3]),signal.SIGTERM)
except PermissionError: sys.exit(3)
except ProcessLookupError: sys.exit(4)
sys.exit(0)
'''
        worker = subprocess.Popen([sys.executable, '-c', run, str(worker_uid), str(worker_gid)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(worker.stdout.readline().strip(), 'ready')
            denied = subprocess.run([sys.executable, '-c', signal_group, str(denied_uid), str(denied_gid), str(worker.pid)], check=False, timeout=5)
            self.assertEqual(denied.returncode, 3)
            self.assertIsNone(worker.poll())
            allowed = subprocess.run([sys.executable, '-c', signal_group, str(worker_uid), str(worker_gid), str(worker.pid)], check=False, timeout=5)
            self.assertEqual(allowed.returncode, 0)
            self.assertEqual(worker.wait(timeout=5), -signal.SIGTERM)
        finally:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)
            if worker.stdout:
                worker.stdout.close()

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
