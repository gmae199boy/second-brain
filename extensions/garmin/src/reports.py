"""고정 보고 경로에 제한된 권한으로 원자적으로 기록한다."""
import json
import os
from pathlib import Path
import re
import secrets
import stat


def _open_dir(parent, name, create=False):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    if create and stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
        os.close(fd)
        raise ValueError('PREFLIGHT_INVALID')
    return fd


def write_reports(home, work_id, private, public):
    if not Path(home).is_absolute() or not re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', work_id):
        raise ValueError('PREFLIGHT_INVALID')
    parts = Path(home).parts
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:]:
            next_dir = _open_dir(directory, part)
            os.close(directory)
            directory = next_dir
        for part in ('reports', work_id):
            next_dir = _open_dir(directory, part, create=True)
            os.close(directory)
            directory = next_dir
        for name, value in (('private.json', private), ('public.json', public)):
            temporary = '.' + secrets.token_hex(16) + '.tmp'
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as output:
                    json.dump(value, output, ensure_ascii=False, separators=(',', ':'))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
    finally:
        os.close(directory)
