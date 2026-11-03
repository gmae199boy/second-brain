"""Idempotent, attempt-fenced core file requests for runtime artifacts."""
from datetime import datetime, timezone
import hashlib
import json
from uuid import UUID, uuid5

from artifacts import MAX_BYTES, locator_for, locator_lock, stage
from collect_store import _write

_NAMESPACE = UUID('359bd9be-093e-51ec-97e0-7ce077352f21')


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def request(conn, home, account, work, token, kind, key, data, metadata, created_ms):
    """Stage exact bytes and insert a deterministic request; return id and status.

    A completed request is never staged again because core may already have
    removed its staging locator. The caller must wait for completed before any
    source move and must check that the source still matches its staged bytes.
    """
    if kind not in ('body_source', 'digest') or not isinstance(key, str) or not key or not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise ValueError('ARTIFACT_INVALID')
    if not isinstance(metadata, dict) or type(created_ms) is not int or created_ms < 0:
        raise ValueError('ARTIFACT_INVALID')
    meta = _canonical(metadata)
    if len(meta.encode('utf-8')) > 16000:
        raise ValueError('ARTIFACT_INVALID')
    content_hash = hashlib.sha256(data).hexdigest()
    from collect_store import dataset_for
    dataset = dataset_for(account)
    identity = _canonical([dataset, kind, key, content_hash, metadata, created_ms])
    request_id = uuid5(_NAMESPACE, identity)
    request_key = 'runtime-' + hashlib.sha256(identity.encode('utf-8')).hexdigest()
    locator = locator_for(dataset, kind, identity, content_hash)
    with locator_lock(conn, locator):
        with _write(conn, account, work, token) as (cur, _):
            row = cur.execute('select status from brain.file_request_results_public_v1 where request_id=%s', (request_id,)).fetchone()
        if not row or row[0] != 'completed':
            if stage(home, dataset, kind, identity, data) != locator:
                raise ValueError('ARTIFACT_INVALID')
        with _write(conn, account, work, token) as (cur, _):
            cur.execute('''insert into brain.file_requests
                (id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata)
                values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)''',
                (request_id,request_key,dataset,'runtime-'+hashlib.sha256(identity.encode()).hexdigest(),locator,content_hash,len(data),
                 'application/json' if kind == 'digest' else 'application/octet-stream',
                 datetime.fromtimestamp(created_ms / 1000, timezone.utc),work,token,meta))
            row = cur.execute('select status from brain.file_request_results_public_v1 where request_id=%s', (request_id,)).fetchone()
    return request_id, row[0] if row else 'pending'
