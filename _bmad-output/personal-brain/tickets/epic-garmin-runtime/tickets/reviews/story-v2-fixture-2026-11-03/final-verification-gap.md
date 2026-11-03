# 16.4 수정 후 독립 검증 공백 검사

검사 완료. `/tmp/brain-16-4-final-review.diff`의 제품 동작 변경을 현재 코드·호출 경로·관련 시험과 대조했다. 빌드·시험은 지시대로 실행하지 않았으며, 실행 통과를 주장하지 않는다. 실제 계정·운영 데이터·비밀에 접근하지 않았고, 다른 리뷰 보고서는 열지 않았다. 별도 커밋의 자동화 도구 변경과 정적 문서·리소스는 이번 16.4 신규 제품 결함으로 등록하지 않았다.

### 날짜 발행 예약 뒤 증가한 dirty 세대가 보존되는지 검증하지 않는다

- **Changed surface:** raw 저장 시 날짜 `generation`을 증가시키고, 발행 완료 시 예약했던 세대와 현재 세대가 같을 때만 `completed_generation`을 갱신한다. `extensions/garmin/src/normalize_store.py:166`, `:202`, `:249`.
- **Impacted consumer or site:** `extensions/garmin/src/collect.py:113`의 no-op 재진입은 `unfinished_days()`가 돌려주는 날짜만 다시 발행한다. 해당 조회는 `extensions/garmin/src/normalize_store.py:260`에서 `generation > completed_generation`을 관찰한다. 수동 normalize는 collect의 세션 잠금을 획득하지 않고 `extensions/garmin/src/normalize.py:30`에서 rebuild하므로, 날짜 예약과 마지막 발행 사이에 collect가 raw를 갱신하는 경로가 있다.
- **Existing test evidence:** `apps/cli/python-test/garmin-normalize.test.ts:182`부터의 시험은 raw 저장 뒤 중단하고 다음 실행에서 pending→complete로 바뀌는 것을 검사한다. `:201`부터는 첫 날짜 chunk 전에 중단한다. 두 시험 모두 발행 예약 뒤 새로운 raw를 저장하지 않는다. `extensions/garmin/tests/day_repair_fixture.py:27`~`:36`은 새 raw를 먼저 발행한 뒤 오래된 snapshot의 **예약 거부**를 검사하며, 이미 예약한 발행이 나중 세대와 겹치는 경우는 만들지 않는다. 저장소 전체에서 `normalize_day_dirty`, `completed_generation`, `reserve_day`, `normalize_store`, `normalize_runtime`의 사용처와 시험 import를 검색했고, 위 시험 및 `garmin-upgrade.test.ts`와 Python check를 읽었다.
- **Missing verification:** 세대 N을 예약한 뒤 raw 갱신으로 N+1을 만들고 N의 발행을 완료했을 때, N+1이 여전히 미완료로 조회되는지와 다음 no-op collect가 새 요약 값을 발행하는지 확인하는 assertion이 없다.
- **Demonstration:** 마지막 발행에서 예약 세대 대신 현재 `generation`을 완료 처리하도록 회귀하면, N의 옛 요약만 발행한 상태에서 N+1까지 완료로 표시된다. 기존 시험은 예약과 완료 사이의 세대가 모두 같으므로 계속 통과하며, stale-snapshot 시험도 예약 전 검사라 이 회귀를 관찰하지 않는다.
- **Consequence:** raw의 새 값은 저장됐지만 자동 재진입이 해당 날짜를 건너뛰어 `day_summary`의 current 값이 이전 입력에 머무를 수 있다.
- **Disposition:** 기존 실제 PG fixture 방식으로 하나의 시험을 추가한다. 실제 attempt에서 날짜 N 예약 → 새 raw와 dirty N+1 저장 → N 발행 완료 순서를 결정적으로 만들고, dirty 미완료 조회와 이어지는 no-op collect의 새 current 값을 함께 검사한다.

### 잘못된 JSON의 날짜별 격리를 제품 실행 경로에서 검증하지 않는다

- **Changed surface:** 날짜별 `json.loads`를 실패 격리 안에서 수행하고, 실패한 날짜는 `internal` 상태를 기록하면서 다음 날짜를 계속 처리한다. 제품 경로는 `extensions/garmin/src/normalize_runtime.py:111`~`:120`이다.
- **Impacted consumer or site:** `extensions/garmin/src/normalize.py:30` → `normalize_runtime.rebuild()` → `publish_days()`가 실제 `garmin.normalize` 일감의 날짜 발행을 수행한다. collect도 `extensions/garmin/src/collect.py:212`에서 같은 제품 함수를 쓴다.
- **Existing test evidence:** 새 잘못된 JSON 검사는 `extensions/garmin/tests/check_normalize_equivalence.py:21`~`:26`에서 `raw='{'`를 넣지만, 호출 대상은 별도 순수 구현인 `normalize_tables.normalize_all()`이다. 그 함수는 제품 `publish_days()`를 호출하지 않는다(`extensions/garmin/src/normalize_tables.py:179`). PG 시험 `apps/cli/python-test/garmin-normalize.test.ts:149`~`:157`은 `{"allMetrics":"synthetic-token-canary"}`라는 **유효한 JSON**의 endpoint 구조 오류를 넣고 항목 실패를 확인한다. `normalize_runtime`, `normalize_all`, `publish_days` 및 관련 fixture의 전체 사용처를 검색하고 이 시험들을 다시 읽었으며, 제품 함수에 문법상 잘못된 JSON과 다른 정상 날짜를 함께 넣는 시험은 찾지 못했다. raw 저장 열은 JSON 형식을 강제하지 않는 text다(`extensions/garmin/migrations/0001_tracer.sql:3`).
- **Missing verification:** 실제 normalize 일감에서 한 날짜의 JSON decode가 실패해도 그 날짜의 실패 상태가 저장되고, 뒤의 정상 날짜는 건강 행을 발행하며, 일감은 실패 수를 포함한 result를 내는지 확인해야 한다.
- **Demonstration:** 제품 `publish_days()`의 JSON decode를 날짜별 `try` 바깥으로 옮기는 회귀가 생기면, 잘못된 보존 원문 하나가 전체 normalize 일감을 중단시키고 뒤의 정상 날짜 발행도 막는다. 순수 계산 검사는 별도 함수의 `try`만 실행하고, 기존 PG 입력은 JSON decode에 성공하므로 어느 쪽도 이 회귀를 잡지 못한다.
- **Consequence:** 한 날짜의 손상된 보존 raw 때문에 관계없는 정상 날짜까지 수동 재정규화가 완료되지 않는다.
- **Disposition:** `garmin-normalize.test.ts`에 한 개의 실제 PG 시험을 추가한다. 수집 dataset에 문법상 잘못된 JSON을 가진 날짜와 그 뒤의 정상 날짜 raw를 넣고 제품 normalize entry를 실행하여, 실패 날짜 ledger·정상 날짜 current 값·result의 실패 수를 검사한다. legacy oracle 생성기는 실행할 필요가 없다.
