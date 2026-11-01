"""인증 전용 frame codec. OS peer/bootstrap 확인 전에는 사용하지 않는다."""
import hmac
import struct

MAX_FRAME = 16 * 1024
TYPES = frozenset((1, 2, 3, 4, 5))  # credentials, mfa, response, cancel, ack
HEADER = struct.Struct('!BQ16s16sB')


class WireError(Exception):
    pass


class FrameCodec:
    def __init__(self, key, session, send_direction, receive_direction):
        if (not isinstance(key,bytes) or not isinstance(session,bytes) or len(key) != 32 or len(session) != 16
            or not isinstance(send_direction,bytes) or not isinstance(receive_direction,bytes)
            or {send_direction,receive_direction} != {b'ui',b'worker'}):
            raise WireError('AUTH_PROTOCOL')
        self._key, self._session = bytearray(key), bytes(session)
        self._send_direction, self._receive_direction = send_direction, receive_direction
        self._send_seq, self._receive_seq, self._closed = 0, 0, False
        self._seen_responses = set()

    def close(self):
        self._closed = True
        for i in range(len(self._key)): self._key[i] = 0

    def encode(self, kind, prompt, payload):
        if (self._closed or self._send_seq >= 64 or type(kind) is not int or kind not in TYPES
            or not isinstance(prompt,bytes) or len(prompt) != 16 or not isinstance(payload,bytes) or len(payload) > 4096):
            self.close(); raise WireError('AUTH_PROTOCOL')
        self._send_seq += 1
        body = HEADER.pack(1,self._send_seq,self._session,prompt,kind) + payload
        tag = hmac.digest(self._key,self._send_direction + body,'sha256')
        return struct.pack('!I',len(body)+len(tag)) + body + tag

    def decode(self, frame, expected_prompt=None):
        try:
            if self._closed or not isinstance(frame,bytes) or len(frame) < 4:
                raise ValueError()
            length = struct.unpack('!I',frame[:4])[0]
            if length > MAX_FRAME or length < HEADER.size + 32 or len(frame) != 4 + length:
                raise ValueError()
            body, tag = frame[4:-32], frame[-32:]
            if not hmac.compare_digest(tag,hmac.digest(self._key,self._receive_direction + body,'sha256')):
                raise ValueError()
            version, seq, session, prompt, kind = HEADER.unpack(body[:HEADER.size])
            payload = body[HEADER.size:]
            if (version != 1 or seq > 64 or seq != self._receive_seq + 1 or session != self._session or kind not in TYPES
                or len(payload)>4096 or (kind == 3 and prompt in self._seen_responses)
                or (expected_prompt is not None and prompt != expected_prompt)):
                raise ValueError()
            self._receive_seq = seq
            if kind == 3: self._seen_responses.add(prompt)
            return kind,prompt,payload
        except Exception:
            self.close()
            raise WireError('AUTH_PROTOCOL') from None
