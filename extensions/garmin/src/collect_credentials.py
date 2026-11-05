"""Offline, owner-attested tokenstore binding for supervised collection."""
import errno
import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import Path


class CredentialEvidenceError(Exception):
    """Evidence or binding is missing, unsafe, or inconsistent."""


def classify_file_error(exc):
    """Unsafe or missing input is permanent; operational I/O remains retryable."""
    if exc.errno in {errno.ENOENT, errno.ENOTDIR, errno.ELOOP, errno.EACCES, errno.EPERM}:
        raise CredentialEvidenceError('missing or unsafe credential file') from exc
    raise exc


def _read_private(dir_fd, name, maximum):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(name, flags, dir_fd=dir_fd)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                or stat.S_IMODE(before.st_mode) & 0o077 or before.st_nlink != 1
                or before.st_size > maximum):
            raise CredentialEvidenceError('unsafe credential file')
        chunks, size = [], 0
        while True:
            chunk = os.read(fd, min(65536, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                raise CredentialEvidenceError('credential file too large')
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise CredentialEvidenceError('credential changed')
        return b''.join(chunks)
    finally:
        os.close(fd)


def _evidence(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise CredentialEvidenceError('invalid tokenstore')
    # Walk from the filesystem root using directory descriptors: no component
    # may be swapped for a symlink between inspection and open.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
    except BaseException:
        os.close(fd)
        raise
    try:
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise CredentialEvidenceError('unsafe tokenstore directory')
        evidence = json.loads(_read_private(fd, 'brain-account-binding.json', 16384))
        token = _read_private(fd, 'garmin_tokens.json', 1048576)
        if not token:
            raise CredentialEvidenceError('empty token')
        digest = hashlib.sha256(token).hexdigest()
        if (not isinstance(evidence, dict) or set(evidence) != {'version', 'user_id', 'connection_id', 'external_identity', 'token_sha256'}
                or type(evidence['version']) is not int or evidence['version'] != 1
                or not all(isinstance(evidence[k], str) for k in ('user_id', 'connection_id', 'external_identity', 'token_sha256'))
                or not re.fullmatch(r'[0-9a-f]{64}', evidence['token_sha256'])
                or not hmac.compare_digest(digest, evidence['token_sha256'])):
            raise CredentialEvidenceError('invalid credential evidence')
        return evidence, 'sha256:' + digest
    finally:
        os.close(fd)


def verify_credentials(conn, cfg, *, bind=True):
    """Call inside a fenced transaction and the selected account session lock.

    The common transaction lock serializes all binding checks, including different
    account sessions. Only the protected extension writer may establish bindings.
    """
    try:
        evidence, reference = _evidence(cfg.tokenstore)
        if evidence['user_id'] != str(conn.user_id) or evidence['connection_id'] != str(conn.connection_id):
            raise CredentialEvidenceError('evidence account mismatch')
        conn.execute("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s,0))", ('garmin:credential-binding',))
        row = conn.execute('select external_identity, tokenstore_ref from garmin.account_connections where user_id=%s and connection_id=%s for update', (conn.user_id, conn.connection_id)).fetchone()
        if not row or not hmac.compare_digest(row[0].encode('utf-8'), evidence['external_identity'].encode('utf-8')):
            raise CredentialEvidenceError('profile mismatch')
        if row[1] is not None and not hmac.compare_digest(row[1], reference):
            raise CredentialEvidenceError('existing binding differs')
        other = conn.execute('select 1 from garmin.account_connections where tokenstore_ref=%s and (user_id,connection_id)<>(%s,%s) limit 1', (reference, conn.user_id, conn.connection_id)).fetchone()
        if other:
            raise CredentialEvidenceError('credential already bound')
        if row[1] is None and bind:
            changed = conn.execute('update garmin.account_connections set tokenstore_ref=%s where user_id=%s and connection_id=%s and tokenstore_ref is null returning connection_id', (reference, conn.user_id, conn.connection_id)).fetchone()
            if not changed:
                raise CredentialEvidenceError('binding changed')
    except OSError as exc:
        classify_file_error(exc)
    except (ValueError, TypeError, UnicodeError) as exc:
        raise CredentialEvidenceError('invalid credential evidence') from exc
