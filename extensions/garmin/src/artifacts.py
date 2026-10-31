"""명시된 원본만 안전하게 읽고 해시 기반 staging에 내구 복사한다."""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import secrets
from metadata_codec import safe_dumps

MAX_BYTES = 32 * 1024 * 1024


def read_relative(root, relative, expected):
    parts = relative.split('/')
    if not Path(root).is_absolute() or any(p in ('', '.', '..') for p in parts) or '\\' in relative:
        raise ValueError('IMPORT_INVALID')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(root).parts[1:] + tuple(parts[:-1]):
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory); directory = nxt
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size != expected: raise ValueError('IMPORT_INVALID')
            if before.st_size > MAX_BYTES: return None
            with os.fdopen(fd, 'rb', closefd=False) as stream: data = stream.read(MAX_BYTES + 1)
            after = os.fstat(fd)
            current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns) or (current.st_dev,current.st_ino) != (before.st_dev,before.st_ino) or len(data) != expected: raise ValueError('IMPORT_INVALID')
            return data
        finally: os.close(fd)
    finally: os.close(directory)


def scan_log(data):
    try:
        result = subprocess.run([os.environ['BRAIN_SECRET_SCANNER_NODE'], os.environ['BRAIN_SECRET_SCANNER_SCRIPT']], input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
        answer = json.loads(result.stdout)
        if set(answer) != {'hasSecrets','version'} or type(answer['hasSecrets']) is not bool or not isinstance(answer['version'],str) or not answer['version']: raise ValueError('IMPORT_INVALID')
        return answer
    except (OSError, KeyError, subprocess.SubprocessError, ValueError, TypeError):
        raise ValueError('IMPORT_INVALID')


def locator_for(dataset, original_table, key, content_hash):
    return hashlib.sha256(safe_dumps([dataset,original_table,key,content_hash], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def stage(home, dataset, original_table, key, data):
    locator = locator_for(dataset,original_table,key,hashlib.sha256(data).hexdigest())
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(home).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory); directory = nxt
        try: os.mkdir('staging', 0o700, dir_fd=directory)
        except FileExistsError: pass
        nxt = os.open('staging', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        os.close(directory); directory = nxt
        temporary = '.' + secrets.token_hex(16) + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd,'wb') as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            try:
                os.link(temporary, locator, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            except FileExistsError:
                existing = os.open(locator, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                try:
                    if not stat.S_ISREG(os.fstat(existing).st_mode): raise ValueError('IMPORT_INVALID')
                    with os.fdopen(existing,'rb',closefd=False) as stream:
                        if stream.read(MAX_BYTES + 1) != data: raise ValueError('IMPORT_CONFLICT')
                finally: os.close(existing)
            os.fsync(directory)
        finally:
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass
        return locator
    finally: os.close(directory)


def classify(entry):
    category = entry['category']
    source = entry['source'].lower()
    if source.endswith(('.toml','.env','.ini','.yaml','.yml')) or 'config' in source: return 'config'
    if category in ('config', 'unknown'): return category
    if source.endswith('.log'): return 'log'
    return category
