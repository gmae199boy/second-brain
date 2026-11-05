"""Journaled token refresh, under the account and tokenstore session locks."""
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from pathlib import Path
from uuid import uuid4

from collect_credentials import CredentialEvidenceError, _read_private, classify_file_error, verify_credentials
from garmin_pipeline import store

STAGE = '.brain-refresh'


def _atomic(path, data):
    fd, name = tempfile.mkstemp(prefix='.brain-write-', dir=path.parent)
    tmp = Path(name)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data); output.flush(); os.fsync(output.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if tmp.exists(): tmp.unlink()


def _safe_file(folder, name, limit):
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: return _read_private(fd, name, limit)
    finally: os.close(fd)


def _hash(value): return hashlib.sha256(value).hexdigest()


def begin(cfg, evidence):
    root = cfg.tokenstore
    stage = root / STAGE
    pending = Path(tempfile.mkdtemp(prefix='.brain-stage-', dir=root))
    try:
        token = _safe_file(root, 'garmin_tokens.json', 1048576)
        if _hash(token) != evidence['token_sha256']:
            raise CredentialEvidenceError('token changed before staging')
        _atomic(pending / 'garmin_tokens.json', token)
        _atomic(pending / 'binding.json', json.dumps(evidence, sort_keys=True).encode())
        os.rename(pending, stage)
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if pending.exists(): shutil.rmtree(pending)
    return stage



def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def _validate_dir(path, allowed):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise CredentialEvidenceError('unsafe refresh directory')
    for item in path.iterdir():
        if item.name not in allowed and not re.fullmatch(r'\.brain-write-[a-z0-9_]{8}', item.name):
            raise CredentialEvidenceError('unexpected refresh file')
        _safe_file(path, item.name, 1048576)


def _remove(path):
    shutil.rmtree(path)
    _sync_dir(path.parent)


def _retire(path):
    # The protected directory name is a durable deletion-only state. No file
    # is removed until all required binding/publication checks have passed.
    target = path.parent / ('.brain-cleanup-' + uuid4().hex)
    os.rename(path, target)
    _sync_dir(path.parent)
    _remove(target)


def approve(stage, evidence, profile):
    """Durably bind a verified profile to an immutable snapshot of the working token."""
    if profile != evidence['external_identity']:
        raise CredentialEvidenceError('profile mismatch')
    _validate_dir(stage, {'binding.json', 'garmin_tokens.json'})
    if json.loads(_safe_file(stage, 'binding.json', 16384)) != evidence:
        raise CredentialEvidenceError('binding changed')
    token = _safe_file(stage, 'garmin_tokens.json', 1048576)
    if not token: raise CredentialEvidenceError('empty refresh token')
    _atomic(stage / 'approved-token.json', token)
    approval = {'version': 1, 'user_id': evidence['user_id'],
                'connection_id': evidence['connection_id'], 'profile': profile,
                'token_sha256': _hash(token)}
    # This durable marker is the commit point; a snapshot without it is unapproved.
    _atomic(stage / 'approval.json', json.dumps(approval, sort_keys=True).encode())


def recover(conn, cfg):
    """Recover only approved snapshots; discard owned unapproved copies without network."""
    root = cfg.tokenstore
    try:
        if not root.is_absolute() or '..' in root.parts:
            raise CredentialEvidenceError('invalid tokenstore')
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in root.parts[1:]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise CredentialEvidenceError('unsafe tokenstore')
        finally:
            os.close(fd)
        for path in root.iterdir():
            if path.name.startswith('.brain-stage-'):
                if not re.fullmatch(r'\.brain-stage-[a-z0-9_]{8}', path.name):
                    raise CredentialEvidenceError('invalid stage name')
                _validate_dir(path, {'binding.json', 'garmin_tokens.json'})
                _retire(path)
            elif path.name.startswith('.brain-cleanup-'):
                if not re.fullmatch(r'\.brain-cleanup-[0-9a-f]{32}', path.name):
                    raise CredentialEvidenceError('invalid cleanup name')
                # A prior validated transition authorized deletion only. Partial
                # files and an empty directory are normal after interrupted rmtree.
                _validate_dir(path, {'binding.json', 'garmin_tokens.json', 'approved-token.json', 'approval.json'})
                _remove(path)
            elif path.name.startswith('.brain-finished-'):
                if not re.fullmatch(r'\.brain-finished-[0-9a-f]{32}', path.name):
                    raise CredentialEvidenceError('invalid finished name')
                _recover_one(conn, cfg, path, finished=True)
        stage = root / STAGE
        if os.path.lexists(stage): _recover_one(conn, cfg, stage, finished=False)
    except OSError as exc:
        classify_file_error(exc)
    except (ValueError, TypeError, KeyError) as exc:
        raise CredentialEvidenceError('invalid refresh journal') from exc


def _recover_one(conn, cfg, stage, *, finished):
    _validate_dir(stage, {'binding.json', 'garmin_tokens.json', 'approved-token.json', 'approval.json'})
    evidence = json.loads(_safe_file(stage, 'binding.json', 16384))
    current = json.loads(_safe_file(cfg.tokenstore, 'brain-account-binding.json', 16384))
    fields = {'version', 'user_id', 'connection_id', 'external_identity', 'token_sha256'}
    if (not isinstance(evidence, dict) or set(evidence) != fields or not isinstance(current, dict) or set(current) != fields
            or type(evidence['version']) is not int or evidence['version'] != 1 or type(current['version']) is not int or current['version'] != 1
            or any(evidence[k] != current[k] for k in fields - {'token_sha256'})
            or evidence['user_id'] != str(conn.user_id) or evidence['connection_id'] != str(conn.connection_id)):
        raise CredentialEvidenceError('invalid refresh binding')
    marker = stage / 'approval.json'
    if not os.path.lexists(marker):
        if finished: raise CredentialEvidenceError('unapproved finished journal')
        # No publication may have begun. Verify the original binding before cleanup.
        with store.transaction(conn): verify_credentials(conn, cfg, bind=False)
        if current != evidence: raise CredentialEvidenceError('unapproved binding changed')
        _retire(stage)
        return
    approval = json.loads(_safe_file(stage, 'approval.json', 16384))
    token = _safe_file(stage, 'approved-token.json', 1048576)
    if (not token or not isinstance(approval, dict) or set(approval) != {'version', 'user_id', 'connection_id', 'profile', 'token_sha256'}
            or type(approval['version']) is not int or approval['version'] != 1
            or approval['user_id'] != evidence['user_id'] or approval['connection_id'] != evidence['connection_id']
            or approval['profile'] != evidence['external_identity'] or approval['token_sha256'] != _hash(token)):
        raise CredentialEvidenceError('invalid refresh approval')
    actual = _safe_file(cfg.tokenstore, 'garmin_tokens.json', 1048576)
    old = evidence['token_sha256']; new = _hash(token)
    if current['token_sha256'] not in (old, new) or _hash(actual) not in (old, new):
        raise CredentialEvidenceError('credential replaced during refresh')
    with store.transaction(conn):
        conn.execute('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s,0))', ('garmin:credential-binding',))
        row = conn.execute('select external_identity,tokenstore_ref from garmin.account_connections where user_id=%s and connection_id=%s for update', (conn.user_id,conn.connection_id)).fetchone()
        if not row or row[0] != evidence['external_identity'] or row[1] not in (None, 'sha256:' + old, 'sha256:' + new):
            raise CredentialEvidenceError('refresh binding mismatch')
        duplicate = conn.execute('select 1 from garmin.account_connections where tokenstore_ref=%s and (user_id,connection_id)<>(%s,%s) limit 1', ('sha256:' + new,conn.user_id,conn.connection_id)).fetchone()
        if duplicate: raise CredentialEvidenceError('refreshed credential already bound')
        if finished and (row[1] != 'sha256:' + new or _hash(actual) != new or current['token_sha256'] != new):
            raise CredentialEvidenceError('unfinished finished journal')
        if row[1] != 'sha256:' + new:
            conn.execute('update garmin.account_connections set tokenstore_ref=%s where user_id=%s and connection_id=%s and tokenstore_ref is not distinct from %s', ('sha256:' + new,conn.user_id,conn.connection_id,row[1]))
    if _hash(actual) != new: _atomic(cfg.tokenstore / 'garmin_tokens.json', token)
    if current['token_sha256'] != new:
        current['token_sha256'] = new
        _atomic(cfg.tokenstore / 'brain-account-binding.json', json.dumps(current, sort_keys=True).encode())
    if not finished:
        finished_path = cfg.tokenstore / ('.brain-finished-' + uuid4().hex)
        os.rename(stage, finished_path)
        _sync_dir(cfg.tokenstore)
        stage = finished_path
    _retire(stage)
