"""격리 fixture용 배치 renderer. 운영 설치 권한을 부여하지 않는다."""
import hashlib
import json
import os
import stat

from path_guard import UnsafePath, read_pinned_file, require_no_macos_acl

# 역할마다 별도 경로를 사용한다. 실행물과 환경은 사용자 입력을 받지 않는다.
LAYOUT = {
    'package': 0o700, 'config': 0o700, 'credentials': 0o700,
    'socket': 0o700, 'backup': 0o700,
}
SERVICE_POLICY = b'''{"format":1,"engine":"orbstack","services":[{"role":"supervisor","principal":"_brain_supervisor","executable":"/usr/libexec/second-brain/supervisor"},{"role":"broker","principal":"_brain_broker","executable":"/usr/libexec/second-brain/broker"},{"role":"garmin-worker","principal":"_brain_garmin","executable":"/usr/libexec/second-brain/garmin-worker"}],"environment":{"PATH":"/usr/bin:/bin","LANG":"C"},"auth_input":false,"external_http":false}\n'''


def create_fixture(parent_fd, name, source_fd, source_digest, owner):
    """새 디렉터리에만 작성한다. 실패하면 생성한 항목만 되돌린다."""
    if not name or name in ('.', '..') or '/' in name:
        raise UnsafePath('INVALID_COMPONENT')
    parent = os.fstat(parent_fd)
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != owner or parent.st_mode & 0o022:
        raise UnsafePath('UNSAFE_PARENT')
    require_no_macos_acl(parent_fd)
    source_info = os.fstat(source_fd)
    if not stat.S_ISDIR(source_info.st_mode) or source_info.st_uid != owner or source_info.st_mode & 0o022:
        raise UnsafePath('UNSAFE_SOURCE')
    require_no_macos_acl(source_fd)
    source = read_pinned_file(source_fd, 'supervisor', owner, source_digest)
    os.mkdir(name, 0o700, dir_fd=parent_fd)
    root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    made = []
    root_identity = (os.fstat(root_fd).st_dev, os.fstat(root_fd).st_ino)
    try:
        for item, mode in LAYOUT.items():
            os.mkdir(item, mode, dir_fd=root_fd)
            info = os.stat(item, dir_fd=root_fd, follow_symlinks=False)
            made.append((item, info.st_dev, info.st_ino))
        manifest = json.dumps({'format': 1, 'files': {'supervisor.bin': hashlib.sha256(source).hexdigest(), 'service-policy.json': hashlib.sha256(SERVICE_POLICY).hexdigest()}}, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        for item, content in (('supervisor.bin', source), ('service-policy.json', SERVICE_POLICY), ('package-manifest.json', manifest)):
            fd = os.open(item, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root_fd)
            info = os.fstat(fd)
            made.append((item, info.st_dev, info.st_ino))
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
            except BaseException:
                raise
        os.fsync(root_fd)
        return hashlib.sha256(source).hexdigest()
    except BaseException:
        for item, dev, ino in reversed(made):
            current = os.stat(item, dir_fd=root_fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (dev, ino):
                raise UnsafePath('ROLLBACK_CHANGED') from None
            if item in LAYOUT:
                os.rmdir(item, dir_fd=root_fd)
            else:
                os.unlink(item, dir_fd=root_fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != root_identity:
            raise UnsafePath('ROLLBACK_CHANGED') from None
        os.rmdir(name, dir_fd=parent_fd)
        raise
    finally:
        try:
            os.close(root_fd)
        except OSError:
            pass
