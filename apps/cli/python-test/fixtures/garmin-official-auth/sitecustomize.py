"""Test-only Garmin transport stub, installed in owned extension virtualenvs."""
import os
import sys

if os.path.basename(sys.argv[0]) == 'auth.py':
    try:
        import json
        from pathlib import Path
        import socket
        import requests
        from curl_cffi import curl

        home = Path(os.environ['BRAIN_EXTENSION_HOME'])
        audit = home / 'synthetic-auth-audit.jsonl'

        def record(event, **fields):
            with audit.open('a', encoding='utf8') as stream:
                stream.write(json.dumps({'event': event, **fields}) + '\n')

        record('argv', argv=sys.argv)
        def deny_network(self, address):
            record('network-blocked')
            raise RuntimeError('synthetic network blocked')
        socket.socket.connect = deny_network
        socket.create_connection = lambda *args, **kwargs: deny_network(None, None)
        requests.sessions.Session.request = lambda *args, **kwargs: deny_network(None, None)
        curl.Curl.perform = lambda *args, **kwargs: deny_network(None, None)
        if (home / 'synthetic-init-fail').exists():
            raise RuntimeError('synthetic setup failure')
        import garminconnect
        record('network-guard-active')
        # Exercise the guard without allowing an actual connection.
        try:
            with socket.socket() as probe:
                probe.connect(('203.0.113.1', 443))
        except RuntimeError:
            record('network-guard-confirmed')
        else:
            raise RuntimeError('network guard failed')
        try:
            curl.Curl.perform(None)
        except RuntimeError:
            record('native-guard-confirmed')
        else:
            raise RuntimeError('native network guard failed')

        class SyntheticGarmin:
            def __init__(self):
                self.client = self
                self.profile_id = 'synthetic-profile'
                self._mfa_pending = True
                import threading
                self._token_lock = threading.RLock()

            def login(self, *args, **kwargs):
                if kwargs.get('return_on_mfa'):
                    if args[1] == 'synthetic-bad-password':
                        raise garminconnect.GarminConnectAuthenticationError('synthetic-private-error')
                    return 'needs_mfa', None
                payload = json.loads(args[0])
                mode = (home / 'tokenstore/synthetic-probe-mode').read_text() if (home / 'tokenstore/synthetic-probe-mode').exists() else 'success'
                record('probe', mode=mode, inline=isinstance(payload, dict))
                if mode == 'transient':
                    raise garminconnect.GarminConnectConnectionError('HTTP 503 synthetic-private-error')
                if mode == 'invalid' or payload.get('di_token') != 'synthetic-token':
                    raise garminconnect.GarminConnectAuthenticationError('synthetic-private-error')
                self.refreshed = 'synthetic-refreshed-token'

            def resume_login(self, unused, code):
                if code != 'synthetic-mfa':
                    raise garminconnect.GarminConnectAuthenticationError('synthetic-private-error')
                self._mfa_pending = False

            def dumps(self):
                return json.dumps({'di_token': 'synthetic-token', 'di_refresh_token': 'synthetic-refresh', 'di_client_id': 'synthetic-client'})

        garminconnect.Garmin = SyntheticGarmin
    except BaseException:
        # site.py ignores ordinary exceptions; stop before the product entry.
        os._exit(91)
