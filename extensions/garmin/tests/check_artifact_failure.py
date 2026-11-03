"""A terminal core file failure must not cause blind supervisor retries."""
from pathlib import Path
import sys
from unittest.mock import patch
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import runtime_artifacts
with patch.object(runtime_artifacts,'run',side_effect=ValueError('ARTIFACT_FILE_FAILED')), patch.object(runtime_artifacts.collect,'emit') as emit:
    assert runtime_artifacts.main() == 1
    emit.assert_called_once_with('error',code='ARTIFACT_FILE_FAILED',retryable=False)
print('terminal file failure: ok')

import psycopg
with patch.object(runtime_artifacts,'run',side_effect=psycopg.OperationalError('temporary')), patch.object(runtime_artifacts.collect,'emit') as emit:
    assert runtime_artifacts.main() == 1
    emit.assert_called_once_with('error',code='ARTIFACT_DB_RETRY',retryable=True)

with patch.object(runtime_artifacts,'run',side_effect=ValueError('COLLECT_RAW_CHANGED')), patch.object(runtime_artifacts.collect,'emit') as emit:
    assert runtime_artifacts.main() == 1
    emit.assert_called_once_with('error',code='ARTIFACT_DB_RETRY',retryable=True)
