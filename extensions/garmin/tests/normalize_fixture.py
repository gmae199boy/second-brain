"""Synthetic normalize wrapper that records ABI output without secrets."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
import normalize
import normalize_runtime
from collect_fixture import checked_fixture

home, marker = checked_fixture()
if marker.get('normalize_interrupt_item'):
    original_item = normalize_runtime.store.publish_item
    def interrupted_item(*args, **kwargs):
        if (args[4],args[5],args[6]) == tuple(marker['normalize_interrupt_item']):
            def stop_at_batch(message=None):
                raise ValueError('COLLECT_STOPPED')
            kwargs['boundary'] = stop_at_batch
        return original_item(*args, **kwargs)
    normalize_runtime.store.publish_item = interrupted_item
if marker.get('normalize_database_failure'):
    parsed = urlsplit(os.environ['BRAIN_DATABASE_URL'])
    host = parsed.hostname + ':' + str(parsed.port)
    os.environ['BRAIN_DATABASE_URL'] = urlunsplit((parsed.scheme, parsed.username + ':' + marker['normalize_password_canary'] + '@' + host, parsed.path, '', ''))
stdout, stderr = io.StringIO(), io.StringIO()
with redirect_stdout(stdout), redirect_stderr(stderr):
    code = normalize.main()
token = os.environ['BRAIN_ATTEMPT_TOKEN']
(home / ('normalize-stdout-' + token)).write_text(stdout.getvalue())
(home / ('normalize-stderr-' + token)).write_text(stderr.getvalue())
sys.stdout.write(stdout.getvalue())
sys.stderr.write(stderr.getvalue())
sys.exit(code)
