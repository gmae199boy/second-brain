"""격리된 실제 library dump의 pathname 교체 반례. 운영 tokenstore는 사용하지 않는다."""
import os
from pathlib import Path
import socket
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from tokenstore_check import check_tokenstore
from garminconnect.client import Client

with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as root:
    target=Path(root)/'tokens'; target.mkdir(mode=0o700)
    before=check_tokenstore(str(target))
    target.rename(Path(root)/'old')
    target.mkdir(mode=0o700)
    # 허구의 token 데이터만 사용하고 모든 소켓 연결은 거부한다.
    original=socket.socket.connect
    def denied(*_): raise OSError('outbound denied')
    socket.socket.connect=denied
    try:
        client=Client()
        client.di_token='synthetic-token'
        client.dump(str(target))
    finally:
        socket.socket.connect=original
    after=check_tokenstore(str(target))
    assert before.inode != after.inode
    assert (target/'garmin_tokens.json').exists()
    assert not (Path(root)/'old'/'garmin_tokens.json').exists()
    fd=os.open(Path(root)/'old',os.O_RDONLY|os.O_DIRECTORY)
    try:
        try:
            with open(f'/dev/fd/{fd}/fixture','w') as out: out.write('fixture')
            fd_child_supported=True
        except OSError:
            fd_child_supported=False
    finally:
        os.close(fd)
    print('synthetic library pathname replacement observed; fd-child-supported=',fd_child_supported)
