"""보호 서비스 후보 경로를 검사하지만 엔진 미검증 상태에서는 설치를 허가하지 않는다."""
import json
import os
import pwd
import sys

from path_guard import UnsafePath, open_protected


def inspect(path):
    failures = []
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        failures.append('INVALID_PATH')
    else:
        root_fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            try:
                target_fd = open_protected(root_fd, [part for part in path.split('/') if part], 0)
            except UnsafePath:
                failures.append('PATH_UNVERIFIED')
            else:
                os.close(target_fd)
        finally:
            os.close(root_fd)
    ids = []
    for name in ('_brain_supervisor', '_brain_broker', '_brain_garmin'):
        try:
            entry = pwd.getpwnam(name)
            ids.append(entry.pw_uid)
        except KeyError:
            failures.append('PRINCIPAL_MISSING')
    if len(ids) == 3 and (len(set(ids)) != 3 or 0 in ids or os.getuid() in ids):
        failures.append('PRINCIPAL_NOT_SEPARATE')
    failures.extend(('ENGINE_ISOLATION_UNVERIFIED', 'PACKAGE_SIGNATURE_UNVERIFIED'))
    return {'ready': False, 'authInput': False, 'externalHttp': False, 'failures': failures}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(2)
    print(json.dumps(inspect(sys.argv[1])))
    sys.exit(1)
