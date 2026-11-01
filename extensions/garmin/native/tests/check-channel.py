"""서로 다른 언어와 프로세스 사이의 합성 비밀 전송만 검증한다."""
import os
import socket
import struct
import subprocess
import sys
from auth_fd import AuthFD

left, right = socket.socketpair()
key = os.urandom(32)
left.sendall(struct.pack('!I', 32) + key)
right.sendall(struct.pack('!I', 32) + key)
child = subprocess.Popen([sys.argv[1], str(right.fileno())], pass_fds=(right.fileno(),),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
right.close()
channel = AuthFD.from_bootstrap(left.detach(), b's' * 16, b'ui', b'worker', 2)
try:
    secret = os.urandom(64)
    channel.send(3, b'p' * 16, secret, 2)
    assert channel.receive(b'p' * 16, 2) == (3, b'p' * 16, secret)
    out, err = child.communicate(timeout=2)
    assert child.returncode == 0 and not out and not err
finally:
    channel.close()
    if child.poll() is None:
        child.kill()
        child.wait()
