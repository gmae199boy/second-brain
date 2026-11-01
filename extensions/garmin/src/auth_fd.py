"""검증된 전용 FD에만 사용하는 인증 frame 전송. 신원 검증 자체는 하지 않는다."""
import fcntl
import os
import selectors
import socket
import stat
import struct
import threading
import time

from auth_wire import FrameCodec, HEADER, MAX_FRAME, WireError


class AuthFD:
    def __init__(self, fd, key, session, send_direction, receive_direction):
        if type(fd) is not int or fd < 0:
            raise WireError('AUTH_PROTOCOL')
        self._fd = fd
        self._closed = False
        self._active = 0
        self._state_lock = threading.Lock()
        self._codec = None
        self._send_lock = threading.Lock()
        self._receive_lock = threading.Lock()
        try:
            self._codec = FrameCodec(key, session, send_direction, receive_direction)
            if not stat.S_ISSOCK(os.fstat(fd).st_mode):
                raise WireError('AUTH_PROTOCOL')
            fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.fcntl(fd, fcntl.F_GETFD) | fcntl.FD_CLOEXEC)
            os.set_blocking(fd, False)
        except (OSError, WireError):
            self.close()
            raise WireError('AUTH_PROTOCOL') from None

    @classmethod
    def from_bootstrap(cls, fd, session, send_direction, receive_direction, timeout, cancelled=None):
        # 호출자는 OS peer 검증과 전달된 전용 endpoint의 단독 소유권을 보장해야 한다.
        key = bytearray()
        transferred = False
        try:
            if type(fd) is not int or fd < 0 or not 0 < timeout <= 300 or not stat.S_ISSOCK(os.fstat(fd).st_mode):
                raise WireError('AUTH_PROTOCOL')
            fcntl.fcntl(fd, fcntl.F_SETFD, fcntl.fcntl(fd, fcntl.F_GETFD) | fcntl.FD_CLOEXEC)
            os.set_blocking(fd, False)
            deadline = time.monotonic() + timeout
            def read_exact(amount):
                value = bytearray()
                with selectors.DefaultSelector() as selector:
                    selector.register(fd, selectors.EVENT_READ)
                    while len(value) < amount:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or (cancelled is not None and cancelled.is_set()):
                            raise WireError('AUTH_PROTOCOL')
                        if not selector.select(min(remaining, 0.05)):
                            continue
                        if cancelled is not None and cancelled.is_set():
                            raise WireError('AUTH_PROTOCOL')
                        try:
                            chunk = os.read(fd, amount - len(value))
                        except BlockingIOError:
                            continue
                        if not chunk:
                            raise WireError('AUTH_PROTOCOL')
                        value.extend(chunk)
                return value
            prefix = read_exact(4)
            if struct.unpack('!I', prefix)[0] != 32:
                raise WireError('AUTH_PROTOCOL')
            key = read_exact(32)
            transferred = True
            return cls(fd, bytes(key), session, send_direction, receive_direction)
        except Exception:
            if not transferred and type(fd) is int and fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
            raise WireError('AUTH_PROTOCOL') from None
        finally:
            for i in range(len(key)):
                key[i] = 0

    def _finish_locked(self):
        if self._fd < 0:
            return
        fd, self._fd = self._fd, -1
        if self._codec is not None:
            self._codec.close()
        try:
            os.close(fd)
        except OSError:
            pass

    def _pin(self):
        with self._state_lock:
            if self._closed:
                raise WireError('AUTH_PROTOCOL')
            self._active += 1
            return self._fd

    def _unpin(self):
        with self._state_lock:
            self._active -= 1
            if self._closed and self._active == 0:
                self._finish_locked()

    def _is_closed(self):
        with self._state_lock:
            return self._closed

    def close(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            # FD 번호는 활성 I/O가 놓을 때까지 닫지 않아 재사용되지 않는다.
            try:
                wrapper = socket.socket(fileno=self._fd)
                try:
                    wrapper.shutdown(socket.SHUT_RDWR)
                finally:
                    wrapper.detach()
            except OSError:
                pass
            if self._active == 0:
                self._finish_locked()

    def _io(self, fd, amount, deadline, cancelled, outgoing=None):
        result = bytearray()
        offset = 0
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_WRITE if outgoing is not None else selectors.EVENT_READ)
            while offset < amount:
                if self._is_closed() or (cancelled is not None and cancelled.is_set()):
                    raise WireError('AUTH_PROTOCOL')
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise WireError('AUTH_PROTOCOL')
                # [ASSUMPTION] 취소 확인 주기 50ms는 UI 연결 검증 때 재평가한다.
                if not selector.select(min(remaining, 0.05)):
                    continue
                if self._is_closed() or (cancelled is not None and cancelled.is_set()):
                    raise WireError('AUTH_PROTOCOL')
                try:
                    if outgoing is None:
                        chunk = os.read(fd, amount - offset)
                        if not chunk:
                            raise WireError('AUTH_PROTOCOL')
                        result.extend(chunk)
                        offset += len(chunk)
                    else:
                        count = os.write(fd, outgoing[offset:])
                        if count <= 0:
                            raise WireError('AUTH_PROTOCOL')
                        offset += count
                except BlockingIOError:
                    continue
        return bytes(result)

    def send(self, kind, prompt, payload, timeout, cancelled=None):
        with self._send_lock:
            pinned = False
            try:
                fd = self._pin(); pinned = True
                if not 0 < timeout <= 300:
                    raise WireError('AUTH_PROTOCOL')
                frame = self._codec.encode(kind, prompt, payload)
                self._io(fd, len(frame), time.monotonic() + timeout, cancelled, frame)
                with self._state_lock:
                    if self._closed:
                        raise WireError('AUTH_PROTOCOL')
            except Exception:
                self.close()
                raise WireError('AUTH_PROTOCOL') from None
            finally:
                if pinned:
                    self._unpin()

    def receive(self, prompt, timeout, cancelled=None):
        with self._receive_lock:
            pinned = False
            try:
                fd = self._pin(); pinned = True
                if not isinstance(prompt, bytes) or len(prompt) != 16 or not 0 < timeout <= 300:
                    raise WireError('AUTH_PROTOCOL')
                deadline = time.monotonic() + timeout
                prefix = self._io(fd, 4, deadline, cancelled)
                length = struct.unpack('!I', prefix)[0]
                if length < HEADER.size + 32 or length > MAX_FRAME:
                    raise WireError('AUTH_PROTOCOL')
                frame = prefix + self._io(fd, length, deadline, cancelled)
                with self._state_lock:
                    if self._closed:
                        raise WireError('AUTH_PROTOCOL')
                    return self._codec.decode(frame, prompt)
            except Exception:
                self.close()
                raise WireError('AUTH_PROTOCOL') from None
            finally:
                if pinned:
                    self._unpin()
