#!/usr/bin/env python3
"""Create a private Garmin capture from an explicit descriptor.

Descriptor JSON: {"manifest": <v1/v2/v3 manifest>, "sources": {<snapshot>: <absolute source>}}.
Optionally supply --previous pointing to a previous normalized manifest.
"""
import argparse
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import secrets
import sqlite3
import stat
import sys
import tempfile
import traceback

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'extensions/garmin/src'))
from capture_manifest import load_capture
from verify_source import inspect_file, _open


def checked_path(value, *, directory=False):
    p = Path(value)
    if not p.is_absolute() or '..' in p.parts:
        raise ValueError('invalid path')
    current = Path('/')
    for part in p.parts[1:]:
        current /= part
        if stat.S_ISLNK(current.lstat().st_mode):
            raise ValueError('symlink')
    if directory != p.is_dir() or (not directory and not p.is_file()):
        raise ValueError('invalid path type')
    return p



def directory_identity(path):
    path = Path(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    identities = []
    try:
        identities.append((os.fstat(fd).st_dev, os.fstat(fd).st_ino))
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            identities.append((info.st_dev, info.st_ino))
        return identities
    finally:
        os.close(fd)


def open_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_child_directory(root_fd, parts):
    fd = os.dup(root_fd)
    try:
        for part in parts:
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.fchmod(child, 0o700)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


class Guard:
    def __init__(self, path, directory=False):
        self.path = checked_path(path, directory=directory)
        self.directory = directory
        self.token = directory_identity(self.path) if directory else inspect_file(self.path)

    def check(self):
        actual = directory_identity(self.path) if self.directory else inspect_file(self.path)
        if actual != self.token:
            raise ValueError('path changed')

    def open(self):
        self.check()
        parent, name, parents = _open(self.path)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            info = os.fstat(fd)
            token = (parents, (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns))
            if not stat.S_ISREG(info.st_mode) or token != self.token:
                os.close(fd)
                raise ValueError('path changed')
            return os.fdopen(fd, 'rb')
        finally:
            os.close(parent)


def copy_guarded(guard, directory_fd, name):
    h = hashlib.sha256()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    with guard.open() as source, os.fdopen(fd, 'wb') as dest:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
            dest.write(block)
    guard.check()
    with guard.open() as source:
        after = hashlib.file_digest(source, 'sha256').hexdigest()
    guard.check()
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    with os.fdopen(fd, 'rb') as result:
        target_hash = hashlib.file_digest(result, 'sha256').hexdigest()
    if h.hexdigest() != after or target_hash != after:
        raise ValueError('source changed')


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value:
        raise ValueError('invalid snapshot')
    p = PurePosixPath(value)
    if p.is_absolute() or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('invalid snapshot')
    return p


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def digest_at(directory_fd, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    with os.fdopen(fd, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(directory_fd, name, value):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write('\n')


def counts(path):
    con = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        tables = con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        return {name: con.execute('SELECT count(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for (name,) in tables}
    finally:
        con.close()


def inventory(manifest_path):
    capture = load_capture(str(manifest_path))
    private = capture['private']
    return {'snapshots': sorted([x['snapshot'] for x in private['datasets']] + [x['snapshot'] for x in private['files']]),
            'tables': {x['dataset']: counts(manifest_path.parent / x['snapshot']) for x in private['datasets']}}


def publish(parent_fd, stage_name, output_name, parent_guard):
    parent_guard.check()
    # Both operands are relative to the same pinned directory.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        result = libc.renameatx_np(parent_fd, os.fsencode(stage_name), parent_fd, os.fsencode(output_name), 4)
    elif sys.platform.startswith('linux'):
        result = libc.renameat2(parent_fd, os.fsencode(stage_name), parent_fd, os.fsencode(output_name), 1)
    else:
        raise OSError(errno.ENOTSUP, 'exclusive rename unavailable')
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    try:
        parent_guard.check()
    except BaseException:
        os.rename(output_name, stage_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        raise


def create(descriptor, output, previous=None):
    descriptor = Guard(descriptor)
    output = Path(output)
    if not output.is_absolute() or '..' in output.parts or not output.name:
        raise ValueError('invalid output')
    parent_guard = Guard(output.parent, directory=True)
    parent = parent_guard.path
    if output.exists() or output.is_symlink():
        raise ValueError('output exists')
    with descriptor.open() as stream:
        data = json.load(stream)
    descriptor.check()
    if not isinstance(data, dict) or set(data) != {'manifest', 'sources'} or not isinstance(data['sources'], dict):
        raise ValueError('invalid descriptor')
    manifest = data['manifest']
    entries = manifest['datasets'] + manifest['files']
    names = [x['snapshot'] for x in entries]
    if len(set(names)) != len(names) or set(names) != set(data['sources']):
        raise ValueError('source mapping mismatch')
    for name in names:
        relative(name)
        if name.split('/')[0] in ('manifest.json', 'private-report.json'):
            raise ValueError('reserved snapshot')
    sources = {name: Guard(data['sources'][name]) for name in names}
    if any(output == p.path or output in p.path.parents for p in sources.values()):
        raise ValueError('source inside output')
    previous_guard = Guard(previous) if previous else None
    if previous_guard:
        previous_guard.check()
        old_capture = load_capture(str(previous_guard.path))
        previous_sources = [Guard(previous_guard.path.parent / entry['snapshot'])
                            for entry in old_capture['private']['datasets'] + old_capture['private']['files']]
        previous_guard.check()
        old = inventory(previous_guard.path)
        previous_guard.check()
        for source in previous_sources: source.check()
    else:
        old = None
    parent_guard.check()
    parent_fd = open_directory(parent)
    stage_name = '.capture-' + secrets.token_hex(16)
    stage_fd = None
    created = False
    try:
        parent_guard.check()
        info = os.fstat(parent_fd)
        if (info.st_dev, info.st_ino) != parent_guard.token[-1]:
            raise ValueError('parent changed')
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        created = True
        stage_info = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
        stage_fd = os.open(stage_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        stage_info = os.fstat(stage_fd)
        stage = parent / stage_name
        parent_guard.check()
        def check_stage():
            parent_guard.check()
            info = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode) or (info.st_dev, info.st_ino) != (stage_info.st_dev, stage_info.st_ino):
                raise ValueError('stage changed')
        databases = {x['snapshot'] for x in manifest['datasets']}
        hashes = {}
        for name in names:
            source = sources[name]
            target = stage.joinpath(*relative(name).parts)
            target_fd = open_child_directory(stage_fd, relative(name).parts[:-1])
            try:
                check_stage()
                if name in databases:
                    with source.open():
                        src = sqlite3.connect(source.path.as_uri() + '?mode=ro', uri=True)
                        try:
                            source.check()
                            dst = sqlite3.connect(':memory:')
                            try:
                                src.backup(dst)
                                snapshot = dst.serialize()
                            finally:
                                dst.close()
                        finally:
                            src.close()
                        source.check()
                    # Backup is a complete database. A WAL source can retain WAL
                    # header bytes after serialization; its standalone copy uses
                    # rollback mode, as in reader.read_snapshot_bytes.
                    if snapshot[:16] != b'SQLite format 3\x00' or len(snapshot) < 100:
                        raise ValueError('invalid snapshot')
                    snapshot = snapshot[:18] + b'\x01\x01' + snapshot[20:]
                    fd = os.open(target.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_fd)
                    with os.fdopen(fd, 'wb') as result:
                        result.write(snapshot)
                else:
                    copy_guarded(source, target_fd, target.name)
                hashes[name] = digest_at(target_fd, target.name)
            finally:
                os.close(target_fd)
        check_stage()
        write_json(stage_fd, 'manifest.json', manifest)
        captured = load_capture(str(stage / 'manifest.json'))
        hashes['manifest.json'] = digest_at(stage_fd, 'manifest.json')
        new = inventory(stage / 'manifest.json')
        check_stage()
        for name in databases:
            target = stage.joinpath(*relative(name).parts)
            if any(target.with_name(target.name + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
                raise ValueError('snapshot sidecar')
        report = {'sources': {k: str(v.path) for k, v in sources.items()}, 'sha256': hashes,
                  'current': new, 'previous': old}
        if captured['private']['version'] == 3:
            report['selection_receipt'] = captured['private']['selection_receipt']
        if old is not None:
            report['comparison'] = {'added': sorted(set(new['snapshots']) - set(old['snapshots'])),
                                    'removed': sorted(set(old['snapshots']) - set(new['snapshots'])),
                                    'table_counts_before': old['tables'], 'table_counts_after': new['tables']}
        write_json(stage_fd, 'private-report.json', report)
        # Refuse a concurrently created output, including an empty directory.
        descriptor.check()
        check_stage()
        for source in sources.values(): source.check()
        if previous_guard:
            previous_guard.check()
            for source in previous_sources: source.check()
        publish(parent_fd, stage_name, output.name, parent_guard)
        created = False
    finally:
        if stage_fd is not None:
            os.close(stage_fd)
        if created:
            try:
                current = os.stat(stage_name, dir_fd=parent_fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (stage_info.st_dev, stage_info.st_ino):
                    shutil.rmtree(stage_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass
        os.close(parent_fd)


class PrivateParser(argparse.ArgumentParser):
    def error(self, message):
        print('CAPTURE_ERROR', file=sys.stderr)
        raise SystemExit(2)


def main():
    parser = PrivateParser()
    parser.add_argument('descriptor')
    parser.add_argument('output')
    parser.add_argument('--previous')
    args = parser.parse_args()
    try:
        create(args.descriptor, args.output, args.previous)
    except (Exception, KeyboardInterrupt) as exc:
        # Details remain private, outside the unpublished capture.
        try:
            parent = checked_path(Path(args.output).parent, directory=True)
            fd, path = tempfile.mkstemp(prefix='.capture-error-', suffix='.log', dir=parent)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as f:
                traceback.print_exc(file=f)
        except Exception:
            pass
        print('CAPTURE_ERROR', file=sys.stderr)
        return 130 if isinstance(exc, KeyboardInterrupt) else 1
    print('CAPTURE_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
