"""디렉터리 FD로 경로를 고정하는 설치 사전 검사 부품.

ACL과 엔진 격리는 이 부품만으로 증명되지 않으므로 설치 허가는 하지 않는다.
"""
import os
import stat


class UnsafePath(Exception):
    pass


def open_protected(root_fd, components, owner):
    """열린 기준 디렉터리 아래 경로를 따라가며 각 inode의 소유권을 검사한다."""
    current = os.dup(root_fd)
    try:
        root_info = os.fstat(current)
        if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != owner or root_info.st_mode & 0o022:
            raise UnsafePath('UNSAFE_OWNER_OR_MODE')
        require_no_macos_acl(current)
        for component in components:
            if not component or component in ('.', '..') or '/' in component:
                raise UnsafePath('INVALID_COMPONENT')
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            try:
                child = os.open(component, flags, dir_fd=current)
            except OSError:
                raise UnsafePath('OPEN_FAILED') from None
            os.close(current)
            current = child
            info = os.fstat(current)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
                raise UnsafePath('UNSAFE_OWNER_OR_MODE')
            require_no_macos_acl(current)
        return current
    except BaseException:
        os.close(current)
        raise


def read_pinned_file(directory_fd, name, owner, expected_sha256, limit=1048576):
    """고정 디렉터리에서 일반 파일을 열고 FD 내용의 고정 digest를 확인한다."""
    import hashlib
    if not name or name in ('.', '..') or '/' in name:
        raise UnsafePath('INVALID_COMPONENT')
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    except OSError:
        raise UnsafePath('OPEN_FAILED') from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022 or info.st_nlink != 1:
            raise UnsafePath('UNSAFE_FILE')
        require_no_macos_acl(fd)
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > limit or hashlib.sha256(data).hexdigest() != expected_sha256:
            raise UnsafePath('DIGEST_MISMATCH')
        return bytes(data)
    finally:
        os.close(fd)


def require_no_macos_acl(fd):
    """macOS의 열린 inode에 확장 ACL이 없을 때만 통과한다."""
    import ctypes
    import errno
    import sys
    if sys.platform != 'darwin':
        raise UnsafePath('ACL_UNSUPPORTED')
    try:
        libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        get_acl = libc.acl_get_fd_np
        get_acl.argtypes = [ctypes.c_int, ctypes.c_int]
        get_acl.restype = ctypes.c_void_p
        free_acl = libc.acl_free
        free_acl.argtypes = [ctypes.c_void_p]
        free_acl.restype = ctypes.c_int
        ctypes.set_errno(0)
        acl = get_acl(fd, 0x100)
        if acl:
            free_acl(acl)
            raise UnsafePath('ACL_PRESENT')
        if ctypes.get_errno() != errno.ENOENT:
            raise UnsafePath('ACL_UNVERIFIED')
    except (AttributeError, OSError):
        raise UnsafePath('ACL_UNVERIFIED') from None
