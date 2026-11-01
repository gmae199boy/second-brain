"""인증되지 않은 입력·재전송·길이·방향·prompt는 즉시 폐기한다."""
from pathlib import Path
import sys
import hmac
import struct
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from auth_wire import FrameCodec, WireError, HEADER
key=b'k'*32; session=b's'*16; prompt=b'p'*16

def pair(): return FrameCodec(key,session,b'ui',b'worker'),FrameCodec(key,session,b'worker',b'ui')
def reject(receiver,frame,expected=prompt):
    try: receiver.decode(frame,expected)
    except WireError as exc: assert str(exc)=='AUTH_PROTOCOL'
    else: raise AssertionError('bad frame accepted')

sender, receiver = pair()
frame=sender.encode(2,prompt,b'synthetic-mfa')
assert receiver.decode(frame,prompt)==(2,prompt,b'synthetic-mfa')
reject(receiver,frame)
sender, receiver=pair()
assert receiver.decode(sender.encode(3,prompt,b'one'),prompt)[2] == b'one'
reject(receiver,sender.encode(3,prompt,b'two'))
for alter in (lambda x:x[:-1],lambda x:x[:3],lambda x:x[:-1]+bytes([x[-1]^1]),lambda x:b'\x00\x01\x00\x00'+x[4:]):
    sender, receiver=pair(); reject(receiver,alter(sender.encode(2,prompt,b'synthetic-mfa')))
sender, receiver=pair(); reject(receiver,sender.encode(2,prompt,b'code'),b'q'*16)
sender, receiver=pair(); reject(sender,sender.encode(2,prompt,b'code'))
def signed(version,seq,which_session,kind):
    body=HEADER.pack(version,seq,which_session,prompt,kind)+b'code'
    tag=hmac.digest(key,b'ui'+body,'sha256')
    return struct.pack('!I',len(body)+len(tag))+body+tag
for malformed in (signed(2,1,session,2),signed(1,2,session,2),signed(1,1,b'x'*16,2),signed(1,1,session,99)):
    _, receiver=pair(); reject(receiver,malformed)
sender, receiver=pair()
try: sender.encode(99,prompt,b'code')
except WireError: pass
else: raise AssertionError('unknown kind accepted')
print('합성 인증 frame 순서·무결성 검사 통과')
for bad_kind,bad_prompt in ((True,prompt),(2,'x'*16)):
    sender,_=pair()
    try: sender.encode(bad_kind,bad_prompt,b'code')
    except WireError as exc: assert str(exc)=='AUTH_PROTOCOL'
    else: raise AssertionError('invalid frame argument accepted')
