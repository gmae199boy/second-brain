"""운동 측정 snapshot 계약. 모든 수치는 생산자가 계산하고 소비자는 그대로 읽는다."""
import json
from pathlib import Path

SCHEMA_VERSION = 'training_measurements_v1'
SCOPES = ('day', '7d', '30d', 'all')


def load_training_measurements(snapshot: Path, scope: str | None = None) -> dict:
    """기간 폴더 또는 저장된 snapshot 루트에서 C1을 읽는다. DB·에이전트 호출은 없다.

    scope 생략: snapshot/training_measurements.json.
    scope 지정: snapshot/day 또는 snapshot/period/<scope>/training_measurements.json.
    """
    folder = Path(snapshot)
    if scope is not None:
        if scope not in SCOPES:
            raise ValueError('invalid training scope')
        folder = folder / 'day' if scope == 'day' else folder / 'period' / scope
    result = json.loads((folder / 'training_measurements.json').read_text(encoding='utf-8'))
    if result.get('schema_version') != SCHEMA_VERSION or (scope and result.get('scope') != scope):
        raise ValueError('invalid training measurements version or scope')
    return result
