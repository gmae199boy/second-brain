"""Per-model-call file requests; the host alone owns the account and DB context."""
import json
import os
import time
from datetime import date
from pathlib import Path
from uuid import uuid4

import psycopg
from garmin_pipeline import store


def _publish(path, value):
    temp = path.with_name('.' + path.name + '-' + uuid4().hex)
    try:
        with temp.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def request(directory, payload):
    root = Path(directory)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('no active body request scope')
    request_id = uuid4().hex
    filename = root / (request_id + '.request')
    response = root / (request_id + '.response')
    _publish(filename, payload)
    try:
        while root.is_dir():
            try:
                result = json.loads(response.read_text(encoding='utf-8'))
            except FileNotFoundError:
                time.sleep(.05)
                continue
            if not result.get('ok'):
                raise ValueError('body request failed')
            return result['result']
        raise ValueError('body request scope closed')
    finally:
        filename.unlink(missing_ok=True)
        response.unlink(missing_ok=True)


def service(directory, handler, *, active):
    """Drain requests only while this model call remains alive and in time."""
    for path in sorted(directory.glob('*.request')):
        if not active():
            return
        ident = path.name.removesuffix('.request')
        if len(ident) != 32 or any(c not in '0123456789abcdef' for c in ident):
            path.unlink(missing_ok=True)
            continue
        response = directory / (ident + '.response')
        try:
            payload = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(payload, dict) or set(payload) != {'action', 'measured_on', 'sources', 'text', 'path'}:
                raise ValueError('invalid request')
            action = payload['action']
            measured = payload['measured_on']
            if measured is not None:
                if not isinstance(measured, str): raise ValueError('invalid date')
                measured = date.fromisoformat(measured)
                if measured.isoformat() != payload['measured_on']: raise ValueError('invalid date')
            sources = payload['sources']
            if not isinstance(sources, list) or any(not isinstance(s, str) for s in sources):
                raise ValueError('invalid sources')
            # Parsing may take time; do not start a new host operation after the
            # owning model exits or its deadline expires.
            if not active():
                return
            result = handler(action, measured_on=measured, sources=sources,
                             text=payload['text'], path=payload['path'])
        except (store.StoreError, psycopg.Error):
            _publish(response, {'ok': False})
            raise
        except Exception:
            _publish(response, {'ok': False})
        else:
            _publish(response, {'ok': True, 'result': result})
        finally:
            path.unlink(missing_ok=True)
