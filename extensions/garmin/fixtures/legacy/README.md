# 이전 분석 입력 fixture

출처: `bd2744df645af4f39ebee501b880861e60063a35`의 `apps/cli/test/fixtures/`. 18.2 report input oracle과 합성 입력 및 18.1 fake Codex를 21.2~21.4 이식 회귀 기준으로 보존한다. 현재 실행하는 시험은 없다.

`legacy_normalize_oracle.py`와 `normalize_v8/`은 같은 기준 commit의 epic 16 정규화 oracle과 합성 입출력이다. 21.2 독립 정규화 비교 시험이 `normalize_v8/input.json`을 사용한다. 고정 SQLite 원본은 `tests/oracle/src`에서 별도 subprocess로 불러오며 이 생성 스크립트는 호출하지 않는다. 시험 실행은 21.8로 이관되어 미실행이다.
보존한 oracle이 참조하던 `charts_v8/`, `digest_v8/`도 같은 출처로 함께 옮겼다. 실행 경로는 향후 이식 시 새 위치에 맞춰 조정해야 한다.
