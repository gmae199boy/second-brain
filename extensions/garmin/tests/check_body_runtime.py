"""Exercise no-overwrite source movement and recovery without a database."""
from pathlib import Path
import os
import sys
import tempfile
from unittest.mock import patch
sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'src'))
import body
import body_runtime

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve(); directory=root/'inbox'/'inbody'; directory.mkdir(parents=True)
    source=directory/'synthetic.png'; source.write_bytes(b'original')
    _, identity=body.read_source(root,'inbox/inbody/synthetic.png')
    processed=directory/'processed'; processed.mkdir()
    name=body_runtime._stored_name('inbox/inbody/synthetic.png',identity['sha256'],identity['mtime_ns'])
    pending=processed/('.pending-'+name+'-synthetic')
    source.rename(pending)
    path=body_runtime._recover_move(root,'inbox/inbody/synthetic.png',identity['sha256'],identity['size'],identity['mtime_ns'])
    assert (root/path).read_bytes() == b'original' and not source.exists() and not pending.exists()

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve(); directory=root/'inbox'/'inbody'; directory.mkdir(parents=True)
    source=directory/'synthetic.png'; source.write_bytes(b'original')
    _, identity=body.read_source(root,'inbox/inbody/synthetic.png')
    real_rename=os.rename
    def replace_before_move(src,dst,*,src_dir_fd,dst_dir_fd):
        real_rename(src,'retained.png',src_dir_fd=src_dir_fd,dst_dir_fd=src_dir_fd)
        fd=os.open(src,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=src_dir_fd)
        os.write(fd,b'replacement'); os.close(fd)
        return real_rename(src,dst,src_dir_fd=src_dir_fd,dst_dir_fd=dst_dir_fd)
    with patch.object(body_runtime.os,'rename',replace_before_move):
        try: body_runtime._move(root,'inbox/inbody/synthetic.png',identity)
        except ValueError: pass
        else: raise AssertionError('changed source accepted')
    assert source.read_bytes()==b'replacement' and (directory/'retained.png').read_bytes()==b'original'
print('body move recovery: ok')

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve(); directory=root/'inbox'/'inbody'; directory.mkdir(parents=True)
    source=directory/'synthetic.png'; source.write_bytes(b'same')
    _, first=body.read_source(root,'inbox/inbody/synthetic.png')
    first_path=body_runtime._move(root,'inbox/inbody/synthetic.png',first)
    source.write_bytes(b'same'); os.utime(source,ns=(first['mtime_ns']+1000000000,first['mtime_ns']+1000000000))
    _, second=body.read_source(root,'inbox/inbody/synthetic.png')
    second_path=body_runtime._move(root,'inbox/inbody/synthetic.png',second)
    assert first_path != second_path
    assert body_runtime._recover_move(root,'inbox/inbody/synthetic.png',second['sha256'],second['size'],second['mtime_ns']) == second_path
    assert (root/first_path).read_bytes() == (root/second_path).read_bytes() == b'same'

# Listing races and unstable source reads remain retryable rather than succeeding.
from contextlib import contextmanager
from datetime import date
import json

class EmptyCursor:
    def execute(self, *args): return self
    def fetchall(self): return []

@contextmanager
def fake_write(*args):
    yield EmptyCursor(), None

with tempfile.TemporaryDirectory() as temp:
    root=Path(temp).resolve(); directory=root/'inbox'/'inbody'; directory.mkdir(parents=True)
    class VanishingEntry:
        name='vanishing.json'
        def is_file(self, **kwargs): return True
        def stat(self, **kwargs): raise FileNotFoundError('vanished during sort')
    @contextmanager
    def disappearing_scandir(*args): yield iter([VanishingEntry()])
    with patch.object(body_runtime.os,'scandir',disappearing_scandir):
        try: body_runtime._ingest(None,root,'account','work','token',date(2026,1,1))
        except ValueError as exc: assert str(exc)=='ARTIFACT_BODY_PENDING'
        else: raise AssertionError('listing race was not retryable')
    sidecar={'schema_version':1,'measured_on':'2026-01-01','values':{'weight_kg':70},'value_mtime_ns':{'weight_kg':1},'source_files':['inbox/inbody/unstable.png']}
    (directory/'measurement.json').write_text(json.dumps(sidecar))
    original=body.read_source
    for failure in (ValueError('BODY_CHANGED'), OSError('read race')):
        def unstable(home, relative):
            if relative.endswith('unstable.png'): raise failure
            return original(home,relative)
        with patch.object(body_runtime.collect_store,'_write',fake_write), patch.object(body_runtime.collect,'boundary'), patch.object(body_runtime.body,'read_source',side_effect=unstable):
            try: body_runtime._ingest(None,root,'account','work','token',date(2026,1,1))
            except ValueError as exc: assert str(exc)=='ARTIFACT_BODY_PENDING'
            else: raise AssertionError('source race was not retryable')

    calls=0
    def replaced_sidecar(home, relative):
        global calls
        if relative.endswith('measurement.json'):
            calls += 1
            if calls == 2: raise ValueError('BODY_CHANGED')
            return original(home,relative)
        return b'synthetic', {'mtime_ns':1}
    with patch.object(body_runtime.collect_store,'_write',fake_write), patch.object(body_runtime.collect,'boundary'), patch.object(body_runtime.body,'read_source',side_effect=replaced_sidecar):
        try: body_runtime._ingest(None,root,'account','work','token',date(2026,1,1))
        except ValueError as exc: assert str(exc)=='ARTIFACT_BODY_PENDING'
        else: raise AssertionError('sidecar changed between discovery and processing')
