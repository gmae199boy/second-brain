from pathlib import Path
import os
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from tokenstore_check import TokenstoreError, check_tokenstore

with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as parent:
    path = Path(parent) / 'tokens'
    path.mkdir(mode=0o700)
    token = path / 'fixture'
    token.write_text('fixture', encoding='utf8')
    token.chmod(0o600)
    observed = check_tokenstore(str(path))
    assert observed.path == str(path) and observed.owner == os.getuid()
    assert observed == check_tokenstore(str(path.parent) + '//' + path.name)
    token.chmod(0o644)
    try: check_tokenstore(str(path))
    except TokenstoreError as exc: assert str(exc) == 'TOKENSTORE_UNSAFE'
    else: raise AssertionError('permissive token accepted')
    token.unlink()
    token.symlink_to('/dev/null')
    try: check_tokenstore(str(path))
    except TokenstoreError: pass
    else: raise AssertionError('symlink accepted')
print('합성 tokenstore 권한 검사 통과')
