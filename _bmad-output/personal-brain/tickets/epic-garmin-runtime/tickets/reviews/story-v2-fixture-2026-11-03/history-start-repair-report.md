# 최초 수집 history_start 경계 수정

`collect_store.set_history_start`의 반환값을 planned 및 empty 두 경로에서 현재 snapshot의 `history_start`로 반영하고, 로컬 `history`도 같은 확정값으로 갱신했다. 기존 DB 시작일은 함수의 `on conflict do nothing` 규칙을 그대로 사용해 덮어쓰지 않는다. 따라서 dirty 후보와 unfinished 날짜 필터, 공통 `publish_days`가 모두 DB에서 확정된 경계를 사용한다.

새 `garmin-history-start.test.ts`는 시작일이 없는 계정에서 실제 collect를 실행한다. 날짜 범위 안의 활동 목록은 2026-01-31을 가리키고 상세 `startTimeGMT`는 최초 시작일 2026-01-01의 하루 전인 2025-12-31을 가리킨다. 시험은 최초 저장된 시작일, 실제 상세 raw, 시작일 이전 날짜의 day_summary/workout/exercise_log 미발행, 다음 collect가 no-op이며 기존 관측과 시작일이 불변임을 확인한다.

## 검증

- 수정 전 `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-history-start.test.ts`: exit 1, 1파일 1시험 실패. 시작일 이전 날짜의 파생 관측이 0개여야 하는 assertion에서 50개가 확인돼 실제 결함을 재현했다.
- 수정 후 시험용 번들을 갱신하고 같은 단일 시험: exit 0, 1파일 1시험 통과, 4.40초.
- `PYTHONDONTWRITEBYTECODE=1` Python 3.14의 `check_collect.py`, `check_collect_plan.py`, `check_raw_transitions.py`: 3개 통과. `pnpm typecheck` 및 `git diff --check`: 통과.
- `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-collect-resume.test.ts apps/cli/python-test/garmin-pass2.test.ts apps/cli/python-test/garmin-history-start.test.ts`: exit 0, 4파일 4시험 통과, skip 0, 47.54초. 시험 DB는 127.0.0.1:54329이며 파일을 순차 실행했다.

추적된 pyc 변경은 없다. 지시대로 전체 suite를 반복하지 않았으며 계획·커밋·원격 상태를 변경하지 않았다.
