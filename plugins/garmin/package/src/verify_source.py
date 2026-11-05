"""검증 원본을 no-follow descriptor에서 읽고 동일 경계를 재검사한다."""
import hashlib
import os
from pathlib import Path
import stat


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _open(path):
    path = Path(path)
    if not path.is_absolute() or any(p in ('', '.', '..') for p in path.parts[1:]): raise ValueError('IMPORT_INVALID')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    parents = [(os.fstat(fd).st_dev, os.fstat(fd).st_ino)]
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            info = os.fstat(fd)
            parents.append((info.st_dev, info.st_ino))
        return fd, path.name, parents
    except BaseException:
        os.close(fd)
        raise


def inspect_file(path):
    directory, name, parents = _open(path)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode): raise ValueError('IMPORT_INVALID')
            if identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != identity(info): raise ValueError('IMPORT_INVALID')
            return parents, identity(info)
        finally: os.close(fd)
    finally: os.close(directory)


def read_source(path, *, reject_wal=False):
    directory, name, parents = _open(path)
    try:
        def check_wal():
            if reject_wal:
                try: os.stat(name + '-wal', dir_fd=directory, follow_symlinks=False)
                except FileNotFoundError: return
                raise ValueError('IMPORT_INVALID')
        check_wal()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode): raise ValueError('IMPORT_INVALID')
            with os.fdopen(fd, 'rb', closefd=False) as stream: data = stream.read()
            after = os.fstat(fd)
            if identity(before) != identity(after) or len(data) != before.st_size or identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) != identity(before): raise ValueError('IMPORT_INVALID')
            check_wal()
        finally: os.close(fd)
    finally: os.close(directory)
    token = (parents, identity(before))
    if inspect_file(path) != token: raise ValueError('IMPORT_INVALID')
    return data, hashlib.sha256(data).hexdigest(), token


def recheck_source(path, expected):
    _, digest, token = read_source(path, reject_wal=True)
    if (digest, token) != expected: raise ValueError('IMPORT_INVALID')
