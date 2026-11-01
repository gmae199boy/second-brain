"""Node/Python 합성 frame 상호운용 시험 전용 child."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from auth_wire import FrameCodec
codec = FrameCodec(b'k'*32,b's'*16,b'worker',b'ui')
kind, prompt, payload = codec.decode(sys.stdin.buffer.read(), b'p'*16)
if kind != 2 or payload != b'synthetic': raise SystemExit(1)
sys.stdout.buffer.write(codec.encode(3,prompt,b'ack'))
