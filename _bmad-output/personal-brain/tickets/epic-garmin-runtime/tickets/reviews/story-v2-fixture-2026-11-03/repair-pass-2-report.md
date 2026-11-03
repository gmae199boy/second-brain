# 16.4 재리뷰 수정 결과

기존 baseline과 부분 diff를 보존하고 core·plugin·계획은 변경하지 않았다. 합성 입력과 `compose.test.yaml`의 시험 PostgreSQL만 사용했으며 PG 시험을 순차 실행했다. Python 3.14와 `PYTHONDONTWRITEBYTECODE=1`을 사용했다.

1. **라벨 A→B→A:** 0009 예약 원장에 base fingerprint를 저장하고 같은 source 최대 시각에서 현재 fingerprint가 이전에 있었다가 다시 나타나면 직전 발행 회차에 기초한 결정적 revision을 새로 예약한다. 연속 동일 입력과 다른 정규화 버전은 같은 회차를 재사용한다. 실제 운동 라벨을 변경·복원한 PG 시험에서 exercise_log와 day_summary current의 새 revision, 재실행 멱등, v8/v9 동일 revision·fetched를 확인했다. 기존 0008 동률 별칭과 stale snapshot 거부 시험도 통과했다.
2. **history_start:** 공통 날짜 발행과 collect dirty 생성에 시작일 필터를 적용했다. 시작일 이전 dirty 이력은 삭제·완료 처리하지 않고 `unfinished_days`에서 제외하므로 반복 재시도하지 않으며, 시작일을 과거로 변경하면 다시 대상이 될 수 있다. 실제 collect의 activity 시작 시각을 시작일 이전으로 이동시키고 해당 날짜에 파생 관측이 생기지 않으며 no-op가 유지됨을 PG에서 확인했다.
3. **snapshot 비용:** 날짜 계산 전 Python에서 raw별 SHA-256 및 metadata fingerprint를 만들고, 예약 잠금 안에서는 PostgreSQL이 동일 조건의 최신 raw fingerprint만 반환한다. body·fetched·checked·library 변경을 각각 stale로 거부한다. 같은 계정의 500일×20,000자 합성 본문을 더한 PG 이력에서 예약이 2초 미만이고 네 종류 변경이 모두 거부됨을 확인했다. 기존 1.9초 transaction 제한은 늘리지 않았다.
4. **NULL 전이:** `normalize_items.null_materialized`로 최초 NULL이 실제 대상 행을 만들었는지 기록하고, 다른 endpoint가 대상 행을 만든 후 미발행 NULL만 다시 선택한다. 0008의 성공 NULL은 0009에서 보수적으로 미확인으로 표시해 기존 대상이 있으면 불변 INSERT를 한 번 재시도한다. PG에서 최초 NULL 성공·다른 endpoint의 행 생성 뒤 재실행·기존 행 뒤 NULL·pending 중단과 새 시도 복구를 확인했다.
5. **고정 fixture의 제품 경로:** frozen `input.json` 전체를 실제 raw 저장·`retry_items`·`prepare`·`publish_days`로 처리했다. 기존 `expected.json`의 옛 표 행을 실제 catalog와 `health.convert` 및 반입 키 규칙으로 독립 투영해 전체 PG 관측과 비교했다. 소유 endpoint에 성공한 비NULL raw가 있는 항목만 item 열을 비교하고 날짜 파생 표는 별도로 비교했으며, 최초 NULL raw가 행을 만들지 않는 legacy 의미를 유지했다. 네 activity endpoint, 세트, 샘플의 밀리초 시각과 날짜 연결도 포함한다. 기대값 생성기는 실행하지 않았다.
6. **날짜 500행 경계:** 실제 `publish_day`에서 501개 workout 관측을 생성하고 첫 500행 commit 뒤 중단했다. 날짜 pending과 dirty 유지, 새 attempt로 501행 수렴, 기존 id·batch·revision·fetched 보존 및 마지막 chunk 뒤 성공/완료를 PG에서 확인했다.
7. **dirty 세대 경합:** 실제 두 psycopg 연결로 N 예약 → 다른 연결의 raw N+1 commit → N 발행 완료를 순서대로 실행했다. N+1이 unfinished로 남고 다음 실제 no-op collect가 새 day_summary current로 수렴하는 것을 확인했다.
8. **문법상 잘못된 JSON:** 수집 dataset에 잘못된 JSON 날짜와 그 뒤 정상 날짜를 함께 넣어 실제 normalize entry를 실행했다. 잘못된 날짜의 `internal` ledger와 result 실패 수, 뒤 날짜의 정상 current를 확인했다.
9. **인증 canary:** `normalize_fixture.py`의 리터럴을 테스트 marker로 전달하도록 바꿨다. 합성 암호로 실제 DB 인증 실패를 유발하고 기존 stdout·stderr·상태 비노출 assertion을 유지했다. `garmin-auth.test.ts`는 통과했다.

## 관련 검증

- 초기 `garmin-pass2.test.ts`는 테스트 SQL의 예약어 별칭 오류로 한 번 실패했고 `AS "day"`로 수정했다. 다음 실행은 실제 exercise별 라벨보다 category를 바꾼 fixture 오류로 실패해 실제 운동 라벨을 변경하도록 수정했다. 이후 통과했다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-pass2.test.ts apps/cli/python-test/garmin-upgrade.test.ts apps/cli/python-test/garmin-auth.test.ts`: 4파일·4시험 통과, 208.70초. 이 실행에는 NULL 전이와 손상 JSON 제품 경로가 포함된다.
- 이후 밀리초 단위 비교와 새 attempt assertion을 강화하고 `garmin-pass2.test.ts`, `garmin-collect.test.ts`, `garmin-collect-resume.test.ts`를 같은 설정으로 순차 실행했다: 3파일·3시험 통과, 43.24초.
- 0008 NULL 성공 상태의 보수적 backfill을 추가하고 `garmin-upgrade.test.ts`를 다시 실행했다: 1파일·1시험 통과, 5.95초. 마지막으로 `garmin-pass2.test.ts`와 `garmin-auth.test.ts`: 2파일·2시험 통과, 31.51초.
- `PYTHONDONTWRITEBYTECODE=1 pnpm typecheck`, `check_normalize_store.py`, `check_normalize_equivalence.py`, `git diff --check`: 통과. 추적된 pyc 변경 없음.

전체 suite는 지휘자의 최종 검증 단계에 남긴다. 기존에 defer/reject된 시간대 변경, 사라진 논리 키, 극단 timestamp 및 동일 source 밀리초의 1,000개 watermark 슬롯 한도는 이번에 변경하지 않았다.
