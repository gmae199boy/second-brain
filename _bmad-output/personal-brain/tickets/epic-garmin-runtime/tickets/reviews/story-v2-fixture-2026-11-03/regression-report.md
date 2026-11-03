# 16.4 후속 회귀 검증

## 고정 oracle

`extensions/garmin/tests/fixtures/normalize_v8/input.json`의 합성 `daily_weigh_ins`에 최신 측정이 먼저 있는 역순 배열을 넣었다. 최신 72,346g이 72.3kg으로 선택·반올림됨을 명시적으로 검사하며 기존 expected의 다른 증거는 그대로다. 격리 임시 HOME·cwd·archive 소스만을 사용하는 opt-in 명령 `PYTHONDONTWRITEBYTECODE=1 extensions/garmin/.venv/bin/python extensions/garmin/scripts/legacy_normalize_oracle.py`로 기대값을 갱신했다. archive SHA-256은 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`다. 기본 검사에서 oracle을 실행하지 않는다.

## 0008에서 0009 업그레이드의 잔여 위험

실제 0008 데이터에 같은 dataset·날짜·논리 관측 키에서 서로 다른 두 성공 revision이 같은 `fetched_at`을 갖는 경우, core resolution은 `revision_ambiguous`로 current를 내지 않는다. 0009는 두 revision 모두 같은 원래 밀리초에서 동일 watermark를 seed하며, 현재 raw의 revision이 이미 성공이면 `reserve_day`는 기존 watermark를 재사용하고 발행을 건너뛴다. 따라서 이 기존 ambiguity는 migration이나 동일 입력 재실행만으로 해소되지 않는다. 이후 현재 raw 또는 labels 변경으로 새 revision이 예약되고 성공하면 같은 source max에서 다음 마이크로초 watermark로 발행되어 정상화될 수 있지만, 입력 변경이 없다면 지속된다. 정상적인 충돌 없는 0008 이력은 기존 fetched를 유지한다. 이는 0009의 seed SQL, `reserve_day`의 기존 revision 재사용 및 core `health_resolution_v1`의 동률 판정에서 확인한 정적 분석이며, 실제 0008→0009 업그레이드 PG 재현 시험이나 복구 구현은 이번 변경에 포함하지 않았다. 감지 시 동일 dataset과 논리 키에 대해 `brain.health_resolution_v1.reason = 'revision_ambiguous'`를 확인해야 하며, 불변 보관 행과 같은 revision/fetched 재사용 규칙을 유지하는 복구 설계가 별도로 필요하다.

## 검증

- `PYTHONDONTWRITEBYTECODE=1 extensions/garmin/.venv/bin/python extensions/garmin/tests/check_normalize_equivalence.py`: 통과. 역순 체중 oracle 출력 `72.3`과 고정 expected 전체를 비교했다.
- 최종 `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-tracer.test.ts`: 2파일, 7시험 통과, 190.77초. 설정의 `fileParallelism: false`로 PG 파일을 순차 실행했다. `git diff --check`도 통과했다.
- 첫 실행은 반입 전용 날짜의 합성 관측을 종료된 attempt로 직접 삽입하려다 core fence가 거부했다. 실행 중인 합성 attempt에서 삽입하도록 수정했다. 다음 실행에서는 회수된 기존 작업이 같은 target의 새 작업을 중복 제거해 대기했다. 실제 거부와 프로세스 종료를 확인한 뒤 합성 작업을 cancelled로 닫고 새 작업을 시작하도록 수정했다. 수정 후 시험은 통과했고, 이후 파서 실패 raw에도 canary를 넣어 최종 두 파일을 다시 실행했다.

## 추가한 검증

- 501개 합성 심박 관측의 첫 500개 commit 직후 실제 DB 상태가 `ok=false, error_code=pending`임을 확인하고 attempt를 회수했다. 다음 chunk가 `COLLECT_INVALID_ATTEMPT`로 거부된 뒤 500개 id·batch·revision·값이 유지됐으며, 새 attempt의 collect no-op이 501개로 수렴하고 상태가 성공으로 바뀌었다.
- 실제 catalog와 반입의 `canonical`/`encoded` 규칙을 통해 활동, 세트, exercise_log 문자열 PK·sub_identity를 확인했다. PostgreSQL에 저장된 NUL 포함 텍스트의 표시값과 원문 바이트·인코딩, JSONB, g/count/category/json/bpm 단위 및 local_date·UTC observed_at을 확인했다.
- 정상 normalize, canary 포함 잘못된 raw의 파서 실패, canary를 암호로 사용한 실제 DB 인증 실패 각각의 stdout·stderr와 정규화/작업 상태를 검사했다. 합성 canary를 의도적으로 담은 입력 raw 자체는 검사 대상 상태에서 제외했다.
- 수집 날짜 사이의 반입 전용 날짜에 대해 수집 dataset의 day_summary/workout/exercise_log 행이 없고 반입 day_summary current가 변하지 않음을 확인했다. 모든 버전에서 item revision 재사용, 날짜 입력 fetched 반영, 실패 날짜의 collect 재시도 기존 시험도 유지했다. tracer의 Garmin migration 기대값은 9까지 갱신했다.

전체 suite는 지휘자 소관으로 실행하지 않았다. 남은 사항은 위 0008→0009의 기존 동률 이력 위험과 그 위험의 실제 업그레이드 PG 재현·복구 설계다.
