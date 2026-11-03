import importlib.util
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('capture.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
from reader import read_snapshot


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.connections = []
        roles = ['development', 'production', 'development-before-change', 'production-pre-epic5', 'production-before-history-start']
        datasets, sources = [], {}
        for i, role in enumerate(roles):
            db = self.root / ('db%d' % i)
            con = sqlite3.connect(db)
            con.execute('pragma journal_mode=wal')
            con.execute('pragma user_version=15')
            con.execute('create table records (value text)')
            con.execute('insert into records values (?)', ('private-marker',))
            con.commit()
            self.connections.append(con)
            self.addCleanup(con.close)
            name = 'db/%d.sqlite' % i
            datasets.append({'dataset': 'data%d' % i, 'source': role, 'snapshot': name})
            sources[name] = str(db)
        source = self.root / 'source'
        source.write_bytes(b'private-marker')
        sources['files/file'] = str(source)
        self.descriptor = self.root / 'descriptor.json'
        self.value = {'manifest': {'version': 1, 'capture_id': 'test', 'datasets': datasets,
                      'files': [{'source': 'explicit', 'snapshot': 'files/file', 'bytes': 14}]}, 'sources': sources}
        self.save()

    def save(self):
        self.descriptor.write_text(json.dumps(self.value))

    def test_snapshot_permissions_and_comparison(self):
        output = self.root / 'first'
        capture.create(self.descriptor, output)
        self.connections[0].execute("insert into records values ('second')")
        self.connections[0].commit()
        second = self.root / 'second'
        capture.create(self.descriptor, second, output / 'manifest.json')
        report = json.loads((second / 'private-report.json').read_text())
        self.assertEqual(report['comparison']['table_counts_before']['data0']['records'], 1)
        self.assertEqual(report['comparison']['table_counts_after']['data0']['records'], 2)
        self.assertEqual(report['comparison']['added'], [])
        self.assertEqual(capture.load_capture(str(second / 'manifest.json'))['private']['version'], 1)
        for p in [second, *second.rglob('*')]:
            self.assertEqual(p.stat().st_mode & 0o777, 0o700 if p.is_dir() else 0o600)
        self.assertEqual(self.connections[0].execute('select count(*) from records').fetchone()[0], 2)

    def test_standalone_snapshot_with_open_wal_writer(self):
        writer = self.connections[0]
        writer.execute('create table paired (id integer primary key, left_value integer, right_value integer)')
        writer.execute('insert into paired values (1, 7, 7)')
        writer.commit()
        source = Path(self.value['sources']['db/0.sqlite'])
        source_hash = capture.digest(source)
        source_rows = writer.execute('select * from paired').fetchall()
        # The backup must see the committed state, not half of an open transaction.
        writer.execute('begin')
        writer.execute('update paired set left_value=8')
        output = self.root / 'standalone'
        capture.create(self.descriptor, output)
        self.assertEqual(capture.digest(source), source_hash)
        self.assertEqual(writer.execute('select * from paired').fetchall(), [(1, 8, 7)])
        writer.rollback()
        self.assertEqual(writer.execute('select * from paired').fetchall(), source_rows)
        loaded = capture.load_capture(str(output / 'manifest.json'))
        for path in loaded['datasets'].values():
            before = capture.digest(path)
            self.assertEqual(path.read_bytes()[18:20], b'\x01\x01')
            self.assertFalse(path.with_name(path.name + '-wal').exists())
            snapshot = read_snapshot(path)
            self.assertEqual(snapshot['schema'], 15)
            self.assertEqual(capture.digest(path), before)
            for suffix in ('-wal', '-shm', '-journal'):
                self.assertFalse(path.with_name(path.name + suffix).exists())
        rows = read_snapshot(loaded['datasets']['D1'])['tables']['paired']['rows']
        self.assertEqual(rows, [{'id': 1, 'left_value': 7, 'right_value': 7}])
        self.assertFalse(list(output.rglob('*-wal')))
        self.assertFalse(list(output.rglob('*-shm')))

    def test_version_two_metadata_is_preserved(self):
        manifest = self.value['manifest']
        manifest['version'] = 2
        manifest['files'][0].update(dataset='data0', artifact_key='artifact', category='input')
        manifest['inventory'] = [{'dataset': 'data0', 'category': 'body', 'state': 'present',
                                  'metadata': {}, 'source_files': ['artifact']}]
        self.save()
        output = self.root / 'v2'
        capture.create(self.descriptor, output)
        self.assertEqual(capture.load_capture(str(output / 'manifest.json'))['private']['inventory'], manifest['inventory'])

    def test_rejections_and_private_output(self):
        output = self.root / 'out'
        output.mkdir()
        with self.assertRaises(Exception): capture.create(self.descriptor, output)
        self.value['manifest']['files'][0]['snapshot'] = '../private-marker'
        self.save()
        result = subprocess.run([sys.executable, capture.__file__, str(self.descriptor), str(self.root / 'new')], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('private-marker', result.stdout + result.stderr)
        self.assertFalse((self.root / 'new').exists())
        self.assertEqual(next(self.root.glob('.capture-error-*')).stat().st_mode & 0o777, 0o600)

    def test_symlink_and_changed_file(self):
        link = self.root / 'link'
        link.symlink_to(self.root / 'source')
        self.value['sources']['files/file'] = str(link)
        self.save()
        with self.assertRaises(Exception): capture.create(self.descriptor, self.root / 'out')
        self.value['sources']['files/file'] = str(self.root / 'source')
        self.save()
        original = capture.Guard.open
        calls = 0
        def changed(guard):
            nonlocal calls
            if guard.path == self.root / 'source':
                calls += 1
                if calls == 2:
                    guard.path.write_bytes(b'changed-content')
            return original(guard)
        with patch.object(capture.Guard, 'open', changed):
            with self.assertRaises(Exception): capture.create(self.descriptor, self.root / 'out')
        self.assertFalse((self.root / 'out').exists())
        self.assertFalse(list(self.root.glob('.capture-*')))

    def test_report_hashes_and_bidirectional_difference(self):
        first = self.root / 'first'
        capture.create(self.descriptor, first)
        entry = self.value['manifest']['files'][0]
        del self.value['sources'][entry['snapshot']]
        entry['snapshot'] = 'new/file'
        self.value['sources']['new/file'] = str(self.root / 'source')
        self.save()
        second = self.root / 'second'
        capture.create(self.descriptor, second, first / 'manifest.json')
        report = json.loads((second / 'private-report.json').read_text())
        self.assertEqual(report['comparison']['added'], ['new/file'])
        self.assertEqual(report['comparison']['removed'], ['files/file'])
        names = set(self.value['sources']) | {'manifest.json'}
        self.assertEqual(set(report['sha256']), names)
        for name in names:
            self.assertEqual(report['sha256'][name], hashlib.sha256((second / name).read_bytes()).hexdigest())

    def test_publish_race_preserves_directory(self):
        output = self.root / 'out'
        original = capture.publish
        def race(parent_fd, stage, target, guard):
            os.mkdir(target, dir_fd=parent_fd)
            original(parent_fd, stage, target, guard)
        with patch.object(capture, 'publish', race):
            with self.assertRaises(OSError): capture.create(self.descriptor, output)
        self.assertEqual(list(output.iterdir()), [])
        self.assertFalse(list(self.root.glob('.capture-*')))

    def test_parent_replaced_before_publish(self):
        parent = self.root / 'destination'
        parent.mkdir()
        moved = self.root / 'moved'
        outside = self.root / 'outside'
        outside.mkdir()
        original = capture.publish
        def swap(fd, stage, target, guard):
            parent.rename(moved)
            parent.symlink_to(outside, target_is_directory=True)
            original(fd, stage, target, guard)
        with patch.object(capture, 'publish', swap):
            with self.assertRaises((OSError, ValueError)):
                capture.create(self.descriptor, parent / 'out')
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(list(moved.iterdir()), [])

    def test_destination_parent_swap_during_database_backup(self):
        for when in ('memory_open', 'backup'):
            with self.subTest(when=when):
                parent = self.root / ('destination-' + when)
                moved = self.root / ('moved-' + when)
                outside = self.root / ('outside-' + when)
                parent.mkdir()
                outside.mkdir()
                original = sqlite3.connect
                marker = b'external database must remain unchanged'
                swapped = False
                external_file = None

                def swap():
                    nonlocal swapped, external_file
                    self.assertFalse(swapped)
                    stage = next(parent.glob('.capture-*')).name
                    parent.rename(moved)
                    parent.symlink_to(outside, target_is_directory=True)
                    directory = outside / stage / 'db'
                    directory.mkdir(parents=True)
                    external_file = directory / '0.sqlite'
                    external_file.write_bytes(marker)
                    swapped = True

                class SourceProxy:
                    def __init__(self, connection): self.connection = connection
                    def backup(self, destination):
                        swap()
                        return self.connection.backup(destination)
                    def close(self): self.connection.close()

                def connect(path, *args, **kwargs):
                    if path == ':memory:' and when == 'memory_open':
                        swap()
                    result = original(path, *args, **kwargs)
                    if when == 'backup' and isinstance(path, str) and '?mode=ro' in path and not swapped:
                        return SourceProxy(result)
                    return result

                with patch.object(capture.sqlite3, 'connect', connect):
                    with self.assertRaises((OSError, ValueError)):
                        capture.create(self.descriptor, parent / 'out')
                self.assertTrue(swapped)
                self.assertEqual(external_file.read_bytes(), marker)
                self.assertEqual([p for p in outside.rglob('*') if p.is_file()], [external_file])
                self.assertEqual(list(moved.iterdir()), [])
                self.assertFalse((outside / 'out').exists())

    def test_deep_permissions(self):
        entry = self.value['manifest']['files'][0]
        del self.value['sources'][entry['snapshot']]
        entry['snapshot'] = 'deep/one/two/file'
        self.value['sources'][entry['snapshot']] = str(self.root / 'source')
        self.save()
        previous = os.umask(0o022)
        try: capture.create(self.descriptor, self.root / 'out')
        finally: os.umask(previous)
        for path in [self.root / 'out', *(self.root / 'out').rglob('*')]:
            self.assertEqual(path.stat().st_mode & 0o777, 0o700 if path.is_dir() else 0o600)

    def test_case_collision(self):
        probe = self.root / 'caseprobe'
        probe.write_text('x')
        if not (self.root / 'CASEPROBE').exists(): self.skipTest('case-sensitive filesystem')
        entry = self.value['manifest']['datasets'][1]
        del self.value['sources'][entry['snapshot']]
        entry['snapshot'] = 'db/0.SQLITE'
        self.value['sources'][entry['snapshot']] = str(self.root / 'db1')
        self.save()
        with self.assertRaises(FileExistsError): capture.create(self.descriptor, self.root / 'out')
        self.assertFalse((self.root / 'out').exists())

    def test_path_replaced_after_inspection(self):
        for kind in ('file', 'parent', 'descriptor', 'sqlite'):
            with self.subTest(kind=kind):
                parent = self.root / ('parent-' + kind)
                parent.mkdir()
                victim = parent / 'victim'
                original_source = self.root / ('db0' if kind == 'sqlite' else 'source')
                import shutil
                shutil.copyfile(original_source, victim)
                if kind == 'descriptor':
                    victim.write_text(self.descriptor.read_text())
                    descriptor = victim
                else:
                    descriptor = self.descriptor
                    key = 'db/0.sqlite' if kind == 'sqlite' else 'files/file'
                    self.value['sources'][key] = str(victim)
                    self.save()
                original = capture.Guard.check
                done = False
                def swap(guard):
                    nonlocal done
                    if not done and guard.path == victim:
                        done = True
                        if kind == 'parent':
                            moved = self.root / 'moved-parent'
                            parent.rename(moved)
                            parent.symlink_to(moved, target_is_directory=True)
                        else:
                            victim.rename(parent / 'old')
                            victim.symlink_to(parent / 'old')
                    return original(guard)
                with patch.object(capture.Guard, 'check', swap):
                    with self.assertRaises(Exception): capture.create(descriptor, self.root / ('out-' + kind))
                self.assertTrue(done)
                self.assertFalse((self.root / ('out-' + kind)).exists())
                if kind == 'parent': parent.unlink()
                if kind != 'descriptor':
                    self.value['sources'][key] = str(original_source)
                    self.save()

    def test_keyboard_interrupt_redacted_and_cleaned(self):
        output = self.root / 'out'
        with patch.object(capture, 'digest_at', side_effect=KeyboardInterrupt('private-marker')):
            with patch.object(sys, 'argv', ['capture', str(self.descriptor), str(output)]):
                from contextlib import redirect_stdout, redirect_stderr
                import io
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    code = capture.main()
        self.assertEqual(code, 130)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(stderr.getvalue(), 'CAPTURE_ERROR\n')
        self.assertFalse(output.exists())
        self.assertEqual(len(list(self.root.glob('.capture-*'))), 1)
        logs = list(self.root.glob('.capture-error-*'))
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0].stat().st_mode & 0o777, 0o600)
        self.assertIn('private-marker', logs[0].read_text())


if __name__ == '__main__': unittest.main()
