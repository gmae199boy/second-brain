# 16.4 두 번째 최종 검증

검증 중 소스·시험·계획·fixture를 수정하지 않는다. Python 3.14.10 및 `PYTHONDONTWRITEBYTECODE=1`을 사용하며, 별도 `BRAIN_TEST_DATABASE_URL` 설정 없이 `compose.test.yaml`의 `127.0.0.1:54329` 시험 DB를 사용한다. PG 시험은 순차 실행한다.

- 계획의 Python check 7개(`check_normalize_equivalence.py`, `check_normalize_store.py`, `check_collect.py`, `check_raw_transitions.py`, `check_collect_plan.py`, `check_settings.py`, `check_session.py`) 및 `check_health_contract.py`: exit 0, 8개 검사 통과, skip 0, 실시간 0.68초. 건강 계약 검사에서 선택 18건과 집계 6건 및 변환을 확인했다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test:python`: exit 0, 13파일·48시험 통과, skip 0, Vitest 473.47초(실시간 474.33초). 포함된 `pnpm build`도 통과했다. 임시 합성 패키지의 일부 누락된 원본 sourcemap 경고가 있었지만 시험 실패는 없었다. Docker 소켓 접근을 위해 권한 상승으로 최초 실행했으며 재시도는 없었다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test`: exit 0, 170파일 통과, 3,922시험 중 3,921 통과·1 skip, Vitest 81.52초(실시간 82.85초). 포함된 `pnpm build`와 `pnpm typecheck`도 통과했다. 테스트 출력은 skip된 시험의 이름과 이유를 제공하지 않았다. 권한 상승으로 최초 실행했으며 재시도는 없었다.

모든 요청 명령이 통과했으며 assertion 실패는 없었다. 검증 후 `git status --short`는 시작 시와 같은 소스·시험·계획·fixture 변경 목록이고 추적된 pyc 변경은 없었으며 `git diff --check`도 통과했다. 소스·시험·계획 변경, 커밋과 푸시는 하지 않았다.

검증 중 지휘자가 독립 정확성 확인의 별도 결함을 전달했다: 최초 수집에서 snapshot의 `history_start`가 `None`인 상태로 `set_history_start` 이후에도 갱신되지 않아 `publish_days`가 범위 밖 날짜를 허용할 수 있다. 이는 이 워커가 시험 실패로 재현한 내용이 아니라 지휘자가 전달한 미해결 리뷰 결과이며, 현재 테스트 통과와 구별해 후속 수정이 필요하다.
