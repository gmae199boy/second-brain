"""합성 비밀과 socketpair만 사용하는 인증 FD 시험."""
import os
import socket
import struct
import threading
import time
import unittest

from auth_fd import AuthFD
from auth_wire import FrameCodec, WireError


class AuthFDTest(unittest.TestCase):
    def test_partial_frame_and_authenticated_response(self):
        left, right = socket.socketpair()
        receiver = AuthFD(os.dup(left.fileno()), b'k' * 32, b's' * 16, b'worker', b'ui')
        encoder = FrameCodec(b'k' * 32, b's' * 16, b'ui', b'worker')
        prompt = b'p' * 16
        frame = encoder.encode(3, prompt, b'fixture-secret-canary')
        def writer():
            for byte in frame:
                right.sendall(bytes([byte]))
        thread = threading.Thread(target=writer)
        thread.start()
        try:
            self.assertEqual(receiver.receive(prompt, 2), (3, prompt, b'fixture-secret-canary'))
        finally:
            thread.join(); receiver.close(); left.close(); right.close(); encoder.close()

    def test_timeout_cancel_oversize_and_eof_close_channel(self):
        for mode in ('timeout', 'cancel', 'oversize', 'eof'):
            with self.subTest(mode=mode):
                left, right = socket.socketpair()
                receiver = AuthFD(os.dup(left.fileno()), b'k' * 32, b's' * 16, b'worker', b'ui')
                cancelled = threading.Event()
                try:
                    if mode == 'cancel': cancelled.set()
                    if mode == 'oversize': right.sendall(struct.pack('!I', 16385))
                    if mode == 'eof': right.close()
                    started = time.monotonic()
                    with self.assertRaisesRegex(WireError, 'AUTH_PROTOCOL'):
                        receiver.receive(b'p' * 16, .1, cancelled)
                    self.assertLess(time.monotonic() - started, 1)
                    with self.assertRaises(WireError): receiver.send(3, b'p' * 16, b'x', .1)
                finally:
                    receiver.close(); left.close(); right.close()

    def test_invalid_key_and_non_socket_close_owned_fd(self):
        left, right = socket.socketpair()
        fd = os.dup(left.fileno())
        try:
            with self.assertRaises(WireError): AuthFD(fd, b'x', b's' * 16, b'ui', b'worker')
            with self.assertRaises(OSError): os.fstat(fd)
        finally:
            left.close(); right.close()
        fd = os.open('/dev/null', os.O_RDONLY)
        with self.assertRaises(WireError): AuthFD(fd, b'k' * 32, b's' * 16, b'ui', b'worker')
        with self.assertRaises(OSError): os.fstat(fd)

    def test_bootstrap_key_only_through_socket_and_cancellation(self):
        left, right = socket.socketpair()
        owned = os.dup(left.fileno())
        key = os.urandom(32)
        right.sendall(struct.pack('!I',32) + key)
        receiver = AuthFD.from_bootstrap(owned, b's' * 16, b'worker', b'ui', 1)
        encoder = FrameCodec(key, b's' * 16, b'ui', b'worker')
        try:
            right.sendall(encoder.encode(3,b'p' * 16,b'fixture'))
            self.assertEqual(receiver.receive(b'p' * 16,1)[2], b'fixture')
        finally:
            receiver.close(); encoder.close(); left.close(); right.close()
        left, right = socket.socketpair()
        owned = os.dup(left.fileno()); cancelled = threading.Event(); cancelled.set()
        try:
            with self.assertRaises(WireError): AuthFD.from_bootstrap(owned,b's' * 16,b'worker',b'ui',1,cancelled)
            with self.assertRaises(OSError): os.fstat(owned)
        finally:
            left.close(); right.close()

    def test_concurrent_close_pins_fd_until_send_and_receive_finish(self):
        left, right = socket.socketpair()
        fd = os.dup(left.fileno())
        channel = AuthFD(fd, b'k' * 32, b's' * 16, b'ui', b'worker')
        entered = threading.Barrier(3)
        release = threading.Event()
        original = channel._io
        errors = []
        def blocked(*args, **kwargs):
            entered.wait(timeout=2)
            release.wait(timeout=2)
            return original(*args, **kwargs)
        channel._io = blocked
        def send():
            try: channel.send(3, b'p' * 16, b'fixture-secret-canary', 2)
            except WireError: errors.append('send')
        def receive():
            try: channel.receive(b'p' * 16, 2)
            except WireError: errors.append('receive')
        threads = [threading.Thread(target=send), threading.Thread(target=receive)]
        for thread in threads: thread.start()
        entered.wait(timeout=2)
        channel.close()
        unrelated = os.open('/dev/null', os.O_RDONLY)
        try:
            self.assertNotEqual(unrelated, fd)
            self.assertEqual(channel._active, 2)
            self.assertNotEqual(channel._codec._key, bytearray(32))
            with self.assertRaises(WireError): channel._pin()
            release.set()
            for thread in threads: thread.join(timeout=2); self.assertFalse(thread.is_alive())
            self.assertCountEqual(errors, ['send', 'receive'])
            self.assertEqual(channel._codec._key, bytearray(32))
            self.assertEqual(channel._fd, -1)
            os.fstat(unrelated)
            os.dup2(unrelated, fd)
            try:
                channel.close()
                os.fstat(fd)
            finally:
                os.close(fd)
            right.settimeout(.2)
            self.assertEqual(right.recv(1), b'')
        finally:
            release.set()
            for thread in threads: thread.join(timeout=2)
            os.close(unrelated); channel.close(); left.close(); right.close()

    def test_replayed_response_closes_channel(self):
        left, right = socket.socketpair()
        receiver = AuthFD(os.dup(left.fileno()), b'k' * 32, b's' * 16, b'worker', b'ui')
        encoder = FrameCodec(b'k' * 32, b's' * 16, b'ui', b'worker')
        try:
            frame = encoder.encode(3, b'p' * 16, b'fixture')
            right.sendall(frame + frame)
            self.assertEqual(receiver.receive(b'p' * 16, 1)[0], 3)
            with self.assertRaises(WireError): receiver.receive(b'p' * 16, 1)
            self.assertTrue(receiver._closed)
        finally:
            receiver.close(); left.close(); right.close(); encoder.close()

    def test_mismatched_session_is_rejected(self):
        left, right = socket.socketpair()
        receiver = AuthFD(os.dup(left.fileno()), b'k' * 32, b's' * 16, b'worker', b'ui')
        encoder = FrameCodec(b'k' * 32, b't' * 16, b'ui', b'worker')
        try:
            right.sendall(encoder.encode(3, b'p' * 16, b'x'))
            with self.assertRaises(WireError): receiver.receive(b'p' * 16, 1)
        finally:
            receiver.close(); left.close(); right.close(); encoder.close()


if __name__ == '__main__':
    unittest.main()
