"""Run a real CLI with a controlling synthetic TTY; never contact Garmin."""
import os
import pty
import select
import signal
import sys
import time

mode, node, cli = sys.argv[1:4]
audit = os.path.join(os.environ['SECOND_BRAIN_HOME'], 'extensions', 'garmin', 'synthetic-auth-audit.jsonl')
audit_offset = os.path.getsize(audit) if os.path.exists(audit) else 0
pid, fd = pty.fork()
if pid == 0:
    os.execve(node, [node, cli, 'ext', 'login', 'garmin', '--json'], os.environ)
output = bytearray()
sent = set()
deadline = time.monotonic() + float(os.environ.get('SYNTHETIC_TTY_TIMEOUT', '40'))
reaped = False
status = None
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], .1)
        if ready:
            try:
                chunk = os.read(fd, 8192)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            for key, value in [(b'Garmin \xec\x9d\xb4\xeb\xa9\x94\xec\x9d\xbc:', b'synthetic-email\n'),
                               (b'Garmin \xeb\xb9\x84\xeb\xb0\x80\xeb\xb2\x88\xed\x98\xb8:', b'synthetic-bad-password\n' if mode == 'failure' else b'synthetic-password\n'),
                               (b'Garmin MFA \xec\xbd\x94\xeb\x93\x9c:', b'synthetic-mfa\n')]:
                if key in output and key not in sent:
                    with open(audit, encoding='utf8') as stream:
                        stream.seek(audit_offset)
                        events = [__import__('json').loads(line)['event'] for line in stream]
                    if not all(event in events for event in ('network-guard-active', 'network-guard-confirmed', 'native-guard-confirmed')):
                        raise RuntimeError('synthetic guard is not active')
                    sent.add(key)
                    os.write(fd, b'\x04' if mode == 'eof' else b'\x03' if mode == 'interrupt' else value)
        if not reaped:
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
        # Even after waitpid observes exit, the PTY may still contain the
        # final JSON envelope. Keep reading until EOF or the same deadline.
    if time.monotonic() >= deadline:
        raise RuntimeError('synthetic terminal timed out')
    while not reaped:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            reaped = True
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('synthetic terminal timed out after EOF')
        time.sleep(min(.02, max(0, deadline - time.monotonic())))
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    # pty.fork creates a session and process group led by pid. Kill the entire
    # owned group on every path, then reap the direct child before returning.
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if not reaped:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    os.close(fd)
    deadline = time.monotonic() + 5
    while True:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('synthetic terminal process group did not exit')
        time.sleep(.02)
