# 16.4 최종 검증

검증 전 checkout과 기존 미커밋 변경을 보존했다. 모든 Python 실행에 `PYTHONDONTWRITEBYTECODE=1`을 적용했고 Python 버전은 3.14.10이다. 시험 DB 설정은 `compose.test.yaml`의 기본 `127.0.0.1:54329`이며 `BRAIN_TEST_DATABASE_URL` 별도 지정은 없었다. PostgreSQL 명령은 순차 실행했다.

- 계획 Python 검사 7개(`check_normalize_equivalence.py`, `check_normalize_store.py`, `check_collect.py`, `check_raw_transitions.py`, `check_collect_plan.py`, `check_settings.py`, `check_session.py`)와 `check_health_contract.py`: exit 0, 8개 검사 통과, skip 0, 실시간 0.71초. 마지막 검사는 건강 선택 18건·집계 6건과 변환을 확인했다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm build`: exit 0, 실시간 0.70초.
- 대상 PG 시험: `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-upgrade.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-collect-resume.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/garmin-auth.test.ts`: exit 1, 6파일 중 5 통과·1 실패, 11시험 중 10 통과·1 실패, skip 0, Vitest 195.18초(실시간 195.35초). 테스트 Docker 접근을 위해 권한 상승으로 실행했다.
  - 실제 assertion 실패: `apps/cli/python-test/garmin-auth.test.ts:95`, `AssertionError: <임시 시험 home>/extensions/garmin/tests/normalize_fixture.py: expected true to be false // Object.is equality`. 해당 시험은 설치된 확장 파일에서 합성 canary의 부재를 검사하며, `extensions/garmin/tests/normalize_fixture.py`에 이 문자열이 리터럴로 포함되어 있다. assertion을 고치거나 재시도하지 않았다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test:python`: exit 1, 12파일 중 11 통과·1 실패, 47시험 중 46 통과·1 실패, skip 0, Vitest 418.77초(실시간 419.62초). 대상 시험과 같은 `apps/cli/python-test/garmin-auth.test.ts:95:75` 실패가 재현됐다: `AssertionError: <임시 시험 home>/extensions/garmin/tests/normalize_fixture.py: expected true to be false // Object.is equality`. 이 명령 자체의 build는 성공했다. 격리된 임시 패키지의 일부 누락된 원본 sourcemap 경고가 있었으며 추가 시험 실패는 없었다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test`: exit 0, 170파일 통과, 3,922시험 중 3,921 통과·1 skip, Vitest 81.37초(실시간 82.76초). 명령에 포함된 build 및 `pnpm typecheck`도 통과했다. 출력은 skip된 시험의 이름이나 이유를 제공하지 않았다.

추가 단독 재검증은 하지 않았다. 두 PG 명령에서 확인된 동일한 assertion은 현재 fixture의 명시적 문자열을 대상으로 한 재현 가능한 실패이며, 알려진 간헐 실패라는 근거가 없다. 전체 `pnpm test`의 성공을 별도 Python 통합 시험 실패의 성공으로 대체하지 않는다. 검증 종료 후 `git status --short`는 시작 당시와 같은 소스·시험·계획·fixture 변경 목록이며 추적된 pyc 변경은 없었고, `git diff --check`는 통과했다. 소스 수정, 커밋, 푸시는 하지 않았다.
