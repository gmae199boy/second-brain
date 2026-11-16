"""명시된 원본만 안전하게 읽고 해시 기반 staging에 내구 복사한다."""
import hashlib
import os
from pathlib import Path
import stat
import secrets
from metadata_codec import safe_dumps

MAX_BYTES = 32 * 1024 * 1024



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
