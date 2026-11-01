"""tokenstore의 권한과 실제 디렉터리 identity를 보수적으로 관찰한다."""
from dataclasses import dataclass
import os
import stat
from pathlib import Path


class TokenstoreError(Exception):
    pass


@dataclass(frozen=True)
class TokenstoreIdentity:
    path: str
    device: int
    inode: int
    owner: int


def check_tokenstore(path):
    """O_NOFOLLOW 디렉터리 FD로 identity와 직접 파일의 현재 권한을 확인한다.

    내용은 읽지 않는다. 별도 보호된 저장 경계가 없으면 이 검사와 라이브러리
    열기 사이의 교체나 같은 UID 접근을 막을 수 없으므로 이 검사만으로 실제
    인증을 허용하지 않는다.
    """
    fd = None
    try:
        expanded = Path(path).expanduser()
        if not expanded.is_absolute() or '..' in expanded.parts or not hasattr(os, 'O_NOFOLLOW'):
            raise TokenstoreError('TOKENSTORE_UNSAFE')
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        fd = os.open('/', flags)
        for part in expanded.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise TokenstoreError('TOKENSTORE_UNSAFE')
        for name in os.listdir(fd):
            entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or stat.S_IMODE(entry.st_mode) != 0o600:
                raise TokenstoreError('TOKENSTORE_UNSAFE')
        after = os.fstat(fd)
        if (info.st_dev,info.st_ino,info.st_uid) != (after.st_dev,after.st_ino,after.st_uid):
            raise TokenstoreError('TOKENSTORE_UNSAFE')
        return TokenstoreIdentity(str(expanded), info.st_dev, info.st_ino, info.st_uid)
    except TokenstoreError:
        raise
    except Exception:
        raise TokenstoreError('TOKENSTORE_UNSAFE') from None
    finally:
        if fd is not None:
            os.close(fd)
