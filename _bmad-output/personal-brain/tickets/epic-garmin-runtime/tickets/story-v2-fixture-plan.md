---
title: '16.4 전수 정규화와 권위 v2 — v8 계산 이식, 불변 INSERT 발행, 동등성 fixture'
type: 'feature'
ticket: 4
created: '2026-11-02'
status: 'built'
baseline_revision: '1b31120e62c0b8787634f7c685dc7e3b7869609a'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md', '{project-root}/_bmad-output/personal-brain/tickets/epic-garmin-runtime/tickets/story-15-endpoint-raw-plan.md']
warnings: ['oversized']
deferred:
  - summary: >-
      검토 필요: [ASSUMPTION] rebuild는 현재 코드의 정규화 버전(8)으로 수집 dataset raw 전부를 다시 처리한다. 버전이 다른 행은 코드 버전을 올렸을 때만 생긴다. 새 버전을 "현재"로 쓰려면 core `health_supported_versions`에 그 버전을 더하는 core 마이그레이션이 같이 필요하다.
    evidence: |-
      확장 role은 `health_supported_versions`에 INSERT할 수 없다(`0023_health_contract.sql:18`, `:90`). 시험은 임시 확장 복사본의 버전 상수를 9로 바꾸고 관리자 연결로 9를 지원 목록에 넣어 확인한다.
    location: >-
      extensions/garmin/src/normalize_store.py
    severity: medium
  - summary: >-
      검토 필요: [ASSUMPTION] 새 raw에서 빠진 샘플 시각이나 다른 날짜로 옮겨 간 workout의 예전 논리 키는 "현재"에 남는다. 옛 정규화의 표 교체 의미는 불변 INSERT로 되살리지 않는다.
    evidence: |-
      current view는 논리 키별로만 고른다(`0026_health_json_comparison.sql:114`). 옛 교체는 `P/normalize/__init__.py:479`, `:574`~`:591`. 삭제 표식 같은 새 계약은 core 계약 변경이라 이 스토리 밖이다.
    location: >-
      extensions/garmin/src/normalize_store.py
    severity: medium
  - summary: >-
      검토 필요: [ASSUMPTION] 권위 규칙 v2는 계정마다 첫 발행 때 한 번 쓴다. 배열은 수집 dataset 뒤에 그 계정의 v1 배열(`garmin.authority_provenance`, D2·D1·D4·D5·D3 순)을 그대로 잇는다. v2를 쓴 뒤 새로 반입한 dataset은 v2에 들어가지 않는다.
    evidence: |-
      16.9 순서는 반입 뒤 수집이다. 반입이 수집보다 늦는 경우는 규칙 v3이 필요하며 이 스토리 밖이다.
    location: >-
      extensions/garmin/src/normalize_store.py
    severity: low
  - summary: >-
      검토 필요: [ASSUMPTION] 같은 항목의 본문이 A→B→A로 돌아오면 두 번째 A는 revision `<sha256>:<fetched_ms>`로 발행한다.
    evidence: |-
      revision을 본문 sha256만으로 두면 두 번째 A가 첫 A와 같은 보관 키이면서 fetched_at만 달라 core trigger가 충돌로 거부한다(`0025_original_text.sql:53`~`:54`). sha256 그대로는 epic 14 반입·tracer와 같은 규칙이라 유지한다.
    location: >-
      extensions/garmin/src/normalize_store.py
    severity: low
---

<intent-contract>

## Intent

**문제:** 수집은 15개 endpoint의 raw를 받지만(16.3), 건강 행은 `user_summary` 걸음 수 하나만 낸다. 그 걸음 수 행도 epic 14 반입 행과 원본 키 모양이 달라 같은 논리 키가 되지 않는다. 그래서 새 수집 값이 이전된 값보다 앞서지 못한다. `normalize` 일감, 항목별 정규화 상태, 권위 규칙 v2도 없다.

**접근:** 옛 정규화 v8의 순수 계산(daily·activity 파서와 `digest.day_values`)을 확장으로 옮긴다. 결과는 옛 표 모양의 행으로 만들고, epic 14 반입과 같은 논리 키로 `brain.health_observations`에 INSERT만 한다. 정규화 상태와 발행 기록은 garmin schema에 둔다. 첫 발행 때 권위 규칙 v2를 쓴다. 기대값은 opt-in 스크립트로 옛 archive 코드에서 한 번 만들어 저장소에 고정한다.

## Boundaries & Constraints

**항상:**
- 계산 의미는 옛 원본 그대로다: 반올림, 센티넬→NULL, 샘플 순서·중복 규칙, 세트 후보 선택, day_values. 기준은 `P/normalize/daily.py`·`activity.py`·`__init__.py`, `P/digest.py`, `P/dates.py`다.
- 건강 행 키는 반입(`batch_import.py:219`~`:280`, `health.py:110`~`:173`)과 같다.
  - `original_table` = 옛 표 이름
  - `original_key` = `sub_identity` = `canonical([encoded(PK 열)...])`
  - metric = catalog 이름
  - 값 = `health.convert`
  - 날짜 행은 `local_date`, `ts_ms` 행은 `observed_at`(UTC)
  - `time_zone` = `garmin.timezone`
  - `activity_id` = 문자열
- 행 id는 보관 키의 uuid5, `import_batch`는 발행 단위의 결정적 문자열이다. 같은 입력을 다시 발행하면 core trigger가 같은 행으로 보고 넘긴다.
- 성공한 항목은 그 endpoint가 소유한 열(`health.source_endpoint`)을 모두 발행한다. NULL 값도 행으로 낸다.
- 외부 호출·순수 계산 동안 트랜잭션을 잡지 않는다. 쓰기는 `collect_store._write`처럼 2초 안의 짧은 트랜잭션이고, 그 안에서 attempt를 확인한다.
- 시험은 합성 fixture와 fake client만 쓴다. 네트워크 호출은 0이다.

**금지:**
- DELETE·UPDATE로 건강 행이나 이전 dataset 행을 바꾸지 않는다. 파서가 실패해도 열을 지우지 않는다.
- 권위 규칙 v1 행과 `garmin.authority_provenance`의 v1 행을 바꾸지 않는다. `brain.reconcile_import_authority`를 v2에 쓰지 않는다.
- 이전 dataset의 raw는 다시 정규화하지 않는다. 대상은 수집 dataset(`collect-…`)뿐이다.
- body·digest JSON·그래프·사건 알림은 하지 않는다(16.5~16.7). core·postgres·CLI 코드는 바꾸지 않는다. catalog 지표 누락은 0건이라 core 마이그레이션이 필요 없다.
- opt-in 생성 스크립트를 기본 suite(check 스크립트·Vitest glob)에서 부르지 않는다.
- `plugin/app-ref`와 plugin version은 올리지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 동등성 | 고정 합성 입력 | 새 계산의 표 행이 `expected.json`과 같다: 열별 수치·NULL·단위·샘플 시각·activity와 day 연결·세트·휴식 | check 실패 |
| 같은 raw 재처리 | collect 뒤 `normalize` | 건강 행 수가 그대로다 | `result` |
| 바뀐 raw | 같은 날 `user_summary` 걸음 수가 바뀜 | 새 revision 행이 생기고 이전 행이 남는다. current는 새 값이다 | `result` |
| A→B→A | 본문이 처음 값으로 돌아옴 | 새 행(revision `<sha>:<fetched_ms>`), current는 A | `result` |
| rebuild 새 버전 | 버전 상수 9, 지원 목록에 9 | v9 행이 생기고 v8 행이 남는다 | `result` |
| 파서 실패 | 한 날의 `rhr_day` 구조 변경 | 그 항목은 `ok=false`와 오류 코드만 남는다. 다른 항목의 행과 그 항목의 이전 행은 그대로다 | `result`, summary의 실패 수 |
| 미발행 raw | raw만 있고 상태 없음 | `normalize`가 찾아 발행한다 | `result` |
| 권위 v2 | D2 반입 뒤 같은 날 다른 값 수집 | current는 수집 값이다. v1 행은 그대로, v2 행은 `[collect, D2, D1, D4, D5, D3]` 중 있는 것 | 없음 |
| 역순 발행 | 새 revision을 먼저, 옛 revision을 나중에 | current는 fetched_at이 늦은 값이다 | 없음 |
| 큰 항목 | 샘플 500행 초과 | 500행 단위 트랜잭션으로 나눈다. 마지막 트랜잭션에서 `ok=true`를 쓴다 | 중단되면 다음 실행이 이어 발행한다 |
| 회수된 attempt | 취소 뒤 쓰기 | 거부되고 행이 0이다 | `COLLECT_STOPPED` |

</intent-contract>

## Code Map

옛 원본: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`. 저장소 밖 임시 폴더에 풀어 읽는다. `P/` = `garmin-source/src/garmin_pipeline/`, `G/` = `garmin-source/`.

- 옮길 계산:
  - `P/normalize/daily.py`(621줄): endpoint 파서와 공통 숫자·시계열 helper
  - `P/normalize/activity.py`(328줄): activity·zone·샘플·세트
  - `P/digest.py`(1,351줄): 순수 계산. `:1259` `day_values`가 day_summary·workout·exercise_log를 만든다. 16.5가 이 파일을 다시 쓰므로 통째로 옮긴다.
  - `P/dates.py`: 필요한 함수만
  - `P/labels/exercise_types_ko.json`: 리소스와 loader
- 옛 coordinator(`P/normalize/__init__.py`): 의미만 참고한다.
  - `:151`~`:206` 등록(day 10종, activity 4종; `activities_by_date`는 활동 날짜 연결용)
  - `:339`~`:353` 작업 집합
  - `:516`~`:623` `_refresh_days`(영향 날짜, activity 날짜 = start_ms의 현지 날짜, history_start 이전 제외, 빈 날 생략)
  - null raw 처리도 이 파일의 동작을 그대로 따른다.
- 옛 시험 입력(합성): `G/tests/test_normalize.py`
  - `:87`~`:529` helper
  - `:913` 구조 변경 격리
  - `:3541` 세트
  - `:4559` REBUILD_ROWS
  - `:5494`~`:5648` day_values
  - 실제 fixture 디렉터리를 읽는 시험(`:4056`, `:4135`, `:4297`)은 쓰지 않는다.
  - 옛 `conftest`나 pytest는 import하지 않는다.
- 확장 재사용:
  - `extensions/garmin/src/health.py`: `convert`, `source_endpoint`, catalog 검증
  - `batch_import.py`·`raw_codec.py`: `canonical`, `encoded`
  - `collect_store.py`: `_write`, `dataset_for`, `upsert_raw`, `coverage_snapshot`(계정 전체 최신 raw)
- 바꿀 것:
  - `collect_normalize.py`(user_summary 파서)는 이식한 daily 파서로 대체한다.
  - `collect_store.prepare`·`_publish_steps`와 `collect.py:156`~`:163`의 걸음 수 catalog 경로는 새 publisher로 대체한다.
  - `collect_published`(PK dataset,day,revision)는 남기되 쓰지 않는다.
- core(읽기만):
  - `0025_original_text.sql:43`~`:56`: 보관 키와 trigger. 같은 키에 id·batch·payload(fetched_at 포함)가 다르면 거부한다.
  - `0026_health_json_comparison.sql:112`~`:145`: 논리 키와 resolution
  - `0023_health_contract.sql:18`: 지원 버전 1·2·8
  - `0024_health_authority_import.sql`: 규칙 표와 `authority_attempt` trigger
  - `extension-provision.ts:64`~`:100`: 확장은 관측·규칙 INSERT와 catalog SELECT만 할 수 있고 core 관측은 SELECT할 수 없다. 발행 여부는 garmin 표로 판정한다.
- `garmin.authority_provenance`(0002·0003): 계정별 v1 datasets 배열
- `extensions/garmin/manifest.json`: work 6개(`normalize` 없음)와 error_codes
- 시험:
  - `apps/cli/python-test/garmin-collect.test.ts`, `garmin-collect-resume.test.ts`, `garmin-tracer.test.ts`(migration 기대값)
  - `apps/cli/test/ext-fixture.ts`(임시 확장 복사본과 fake 주입)
  - `extensions/garmin/tests/collect_fixture.py`, `check_collect.py`, `check_health_contract.py`
  - 시험 PG: `tooling/test-db`

## Tasks & Acceptance

**실행(단계마다 phase-ready 보고):**

- [ ] 1단계 — 순수 이식과 동등성.
  - `extensions/garmin/src/normalize_daily.py`, `normalize_activity.py`, `digest.py`, `garmin_dates.py`를 만든다. 옛 함수 본문을 옮기고 config·SQLite 의존만 끊는다.
  - `labels/exercise_types_ko.json`과 loader `labels.py`를 둔다. pyproject package data에 넣는다.
  - `normalize_tables.py`: raw 항목들 → 옛 표 모양 행(daily_metric·activity·샘플 4종·exercise_set)과 항목 결과(ok/error_code), 날짜별 day_values 행. 순수 함수다.
  - `extensions/garmin/tests/fixtures/normalize_v8/input.json`: 옛 시험의 합성 입력. Matrix 동등성 범위와 `:913` 실패, day_values, history_start를 담는다.
  - `extensions/garmin/scripts/legacy_normalize_oracle.py`(opt-in):
    - archive를 새 임시 폴더에 푼다.
    - 별도 프로세스에서 임시 HOME·cwd·PYTHONPATH(임시 `src`만)로 옛 `normalize.run(rebuild=True)`를 돌린다.
    - 파생 표와 `normalize_result`(normalized_at 제외)를 키 정렬해 `expected.json`으로 쓴다.
    - 구현자가 한 번 실행해 결과를 고정한다.
  - `tests/check_normalize_equivalence.py`: 새 순수 계산 결과를 `expected.json`과 정확히 비교한다.
- [ ] 2단계 — 저장.
  - `extensions/garmin/migrations/0008_normalize.sql`:
    - `normalize_items`: dataset, scope, key, endpoint, revision, normalization_version, ok, error_code, normalized_at_ms. PK는 앞 6개.
    - `normalize_days`: dataset, day, revision, normalization_version, ok, error_code.
    - `authority_v2`: account_identity PK, rule_id, datasets.
    - 확장 role 권한.
  - `src/normalize_store.py`:
    - 표 행 → 관측 행 변환(위 키 규칙)
    - revision과 id·batch 규칙(Design Notes)
    - 500행 chunk 발행. 마지막 chunk에 상태 행을 쓴다.
    - 실패 상태 기록
    - 첫 발행 트랜잭션에 v2 규칙과 `authority_v2` INSERT
    - 미발행·실패 항목 조회
  - `tests/check_normalize_store.py`: 변환 키가 `batch_import`와 같은 문자열인지, revision 규칙, chunk 경계를 검사한다.
- [ ] 3단계 — 실행 경로.
  - `collect.py`·`collect_store.py`:
    - 항목 raw 저장 직후 순수 계산(트랜잭션 밖)을 한다.
    - 500행 이하이면 raw와 같은 트랜잭션에서 발행하고, 넘으면 raw 뒤에 chunk로 발행한다.
    - run이 끝날 때 영향 날짜의 day_values를 발행한다.
    - result summary에 `normalized`·`normalize_failed` 수를 싣는다.
    - 걸음 수 전용 경로는 지운다.
  - `src/normalize.py`(새 entry):
    - `garmin.normalize` work(manual `normalize`, `required_settings` `garmin.timezone`)
    - 대상 계정은 `collect_targets`에서 찾는다. 없으면 no-op `result`다.
    - 수집 dataset raw 전부를 현재 버전으로 다시 처리한다. 이미 `ok`인 것은 건너뛰고, 실패·미발행은 다시 한다.
    - batch마다 progress를 내고 취소를 확인한다.
  - `manifest.json`: work를 더한다. 오류 코드가 새로 필요하면 더한다.
- [ ] 4단계 — 감독자 시험.
  - `apps/cli/python-test/garmin-normalize.test.ts`(새 파일)로 Matrix의 PG 행을 검사한다. 미발행 raw는 관리자 연결로 raw만 넣어 만든다. rebuild 버전은 임시 복사본 상수와 관리자 INSERT로 바꾼다. D2는 기존 반입 fixture를 쓴다.
  - `collect_fixture.py`에 합성 입력의 fake 응답과 바뀐 응답을 더한다.
  - 기존 collect·tracer·auth·install 시험의 걸음 수 기대값을 새 키 규칙에 맞춘다.

**수락 기준:**
- Given 고정 입력과 `expected.json`, When `check_normalize_equivalence.py`를 돌리면, Then 모든 표·열·NULL·순서가 같다. 그리고 기대값 생성 스크립트는 기본 check와 Vitest에서 호출되지 않는다.
- Given D2 반입과 같은 날의 다른 수집 값, When `health_current_v1`을 읽으면, Then 수집 값이 나온다. 그리고 수집 전에 읽은 v1 규칙 행·`authority_provenance` 행이 수집 뒤에도 바이트 단위로 같다.
- Given collect 결과 행, When 같은 날 반입 행과 비교하면, Then `original_table`·`original_key`·`sub_identity`·metric·`local_date`/`observed_at`·`time_zone`이 같다(같은 논리 키).
- Given 비밀 시험 문자열이 tokenstore에 있을 때, When collect·normalize가 성공하거나 실패하면, Then 그 문자열이 stdout·stderr·정규화 상태 행에 없다.

## Implementation Notes

- 같은 Orca 구현 Dispatch(Codex `gpt-6.1-terra`/medium)가 1~4단계를 phase-ready로 하나씩 했다. 지휘자는 단계마다 diff를 보고 check를 다시 돌렸다.
- 1단계: `normalize_daily.py`·`digest.py`는 옛 원본과 같고, `normalize_activity.py`는 import 두 줄만 다르다. 기대값은 opt-in 스크립트로 옛 archive(sha256 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`)를 격리 실행해 만들었다. 지휘자 요청으로 stress BB 채널과 음수·반올림 경계 입력을 더해 다시 생성했다.
- 지휘자 지적으로 고친 것:
  - 원본 PK의 문자열을 반입 reader와 같은 `SQLiteText(…, 'utf-8')`로 encoded한다. 처음 구현은 파이썬 `str`을 그대로 encoded해서 `original_key`·`sub_identity`가 반입 행과 달랐다. 그러면 권위 v2가 D2 값을 앞서지 못한다.
  - collect가 항목마다 계정 전체 raw 본문을 다시 읽던 것을, 날짜마다 읽은 snapshot을 갱신해 쓰도록 바꿨다(1.9초 statement 제한).
- NULL raw는 옛 coordinator(`P/normalize/__init__.py:400-408`, `:441-459`)대로 처리한다. 그날 대상 행이 이미 있을 때만 소유 열을 NULL 관측으로 발행한다.
- 실제 PG 시험에서 수동 normalize가 반입 전용 날짜까지 수집 dataset에 날짜 요약을 만드는 문제를 찾았다. 재구성 날짜 범위를 수집 dataset의 raw로 좁혔다.
- 확장 역할 `brain_ext_garmin`은 시험 PG 클러스터 전역이다. 그래서 지휘자 검증과 구현자 시험을 동시에 돌리면 설치가 `DB_UNAVAILABLE`로 막힌다. 지휘자 실행을 멈추고 남은 역할을 시험 클러스터에서만 정리한 뒤 다시 돌렸다.
- 지휘자 도구 `_bmad/custom/bmad-orca-control.py`를 새 Orca `check` 출력 모양에 맞췄다. 새 출력에는 `runId`·`deliveryId`가 없고 발신자가 `from`에 있다. 이 스토리 기능과는 무관한 별도 커밋이다.

## Plan Change Log

## Review Triage Log

### 2026-11-02 — Review pass (quick, Codex `gpt-6.1-sol`)

- verdicts: 4 findings — high 0, medium 3, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `normalize_store.py` `reserve_item`·`anticipated_revision`: revision 이력을 현재 정규화 버전 안에서만 본다. 그래서 A→B→A 뒤 버전을 올려 rebuild하면 같은 fetched_at에 `<sha>:<ms>`(v8)와 `<sha>`(v9)가 함께 생기고, resolution(`0026:132-140`)이 그 논리 키를 `revision_ambiguous`로 뺀다. → 고쳤다. 이력을 모든 버전에서 읽는다. 날짜 입력 revision 조회도 같다. 버전 9 rebuild 뒤 current가 남는지 PG 시험에 더했다.
  - `[medium]` `[patch]` `normalize_runtime.py` 날짜 revision: 상태가 없는 입력(`activities_by_date`)이 A→B→A로 돌아오면 날짜 revision은 첫 A와 같은데 fetched_at만 다르다. core trigger가 이것을 충돌로 거부한다(`0025:54`). → 고쳤다. 날짜 revision 재료의 각 입력에 `fetched_at_ms`를 넣었다. 단위 검사를 더했다.
  - `[medium]` `[patch]` `collect.py`: `normalize_days.ok=false`인 날짜를 다음 collect가 다시 하지 않는다. `unfinished_days()`를 부르는 곳이 없고, 계획 Design Notes와 옛 `_refresh_days`와도 다르다. → 고쳤다. collect가 미완료 날짜를 발행 대상에 더한다. no-op 재진입에서도 다시 한다. 감독자 시험으로 복구를 확인했다.
  - `[low]` `[reject]` `normalize_store.py:65` `observations`: 파서가 받아들이는 극단 시각(예: `253402300800000`)은 `datetime.fromtimestamp` 범위를 넘는다. 이 오류는 항목 실패로 격리되지 않는다. Garmin이 보낼 수 없는 값이라 평소 사용에서 만날 일이 없다. 고치려면 변환 단계에 새 예외 경로를 더해야 해서 받지 않았다.

## Design Notes

**revision.**
- raw 한 개에서 나온 행의 revision은 raw 저장 문자열 UTF-8의 sha256이다. epic 14 반입·tracer와 같다. fetched_at은 raw의 fetched_at이다. 발행 시각을 쓰지 않으므로 역순 발행에도 current가 되돌아가지 않는다.
- 같은 항목·버전에 같은 sha가 다른 fetched_at으로 이미 발행돼 있으면 `<sha>:<fetched_ms>`를 쓴다. `[ASSUMPTION]`
- day_values 행의 revision은 입력 목록의 sha256이다. 입력 목록은 정렬한 `(scope,key,endpoint,입력 revision)`과 labels sha다. fetched_at은 입력 중 가장 늦은 것이다.

**id와 batch.**
- `id = uuid5(고정 namespace, canonical(보관 키 열))`
- `import_batch = 'normalize-' + digest(dataset,scope,key,endpoint,revision,version)`. day_values는 `'day-values-' + …`이다.
- 재시도한 chunk는 같은 행이라 trigger가 넘긴다.

**표 PK**(`original_key`·`sub_identity`의 재료):
- `daily_metric`(day_key)
- `activity`(activity_id)
- `body_battery_sample`·`stress_bb_sample`·`hr_sample`(day_key,ts_ms)
- `activity_hr_sample`(activity_id,ts_ms)
- `exercise_set`(activity_id,set_index)
- `day_summary`(date)
- `workout`(activity_id)
- `exercise_log`(activity_id,exercise)

**day_values 입력.** 그날과 그날 활동의 raw는 `coverage_snapshot`처럼 계정의 모든 dataset 중 최신 행을 읽는다. 결과는 수집 dataset에 쓴다. 실패한 날짜는 `normalize_days`에 `ok=false`로 남고 다음 collect·normalize가 다시 한다. `[ASSUMPTION]`

**rebuild.** 새 버전 행은 현재 코드의 버전 상수가 기존 행과 다를 때만 생긴다. 시험에서 상수를 바꾸는 것은 임시 복사본에서만 한다. 제품 코드에는 버전을 바꾸는 입력을 두지 않는다.

## Verification

**Commands:**
- `extensions/garmin/.venv/bin/python extensions/garmin/tests/check_normalize_equivalence.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_normalize_store.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_collect.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_raw_transitions.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_collect_plan.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_settings.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_session.py` -- expected: 모두 통과
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-normalize.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-collect-resume.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/garmin-auth.test.ts` -- expected: 전부 통과, skip 0
- `pnpm test:python && pnpm test` -- expected: 기존 시험 회귀 없음(알려진 간헐 실패는 단독 재실행으로 구분)

**Manual checks:**
- `git diff --stat`에 `packages/`·`apps/cli/src`·`plugin/` 변경이 없다.
- `expected.json`이 opt-in 스크립트 출력과 같다(구현자가 생성 명령과 archive sha256을 보고에 적는다).

## Auto Run Result

**요약:** 옛 정규화 v8의 순수 계산을 확장으로 옮겼다. 옮긴 것은 daily·activity 파서와 `digest.day_values`(day_summary·workout·exercise_log)다. 결과는 epic 14 반입과 같은 논리 키로 `brain.health_observations`에 INSERT만 한다. 행 id는 보관 키의 uuid5이고 batch는 결정적 문자열이라, 같은 raw를 다시 처리하면 행이 늘지 않는다.
- 바뀐 raw는 새 revision 행이 된다. A→B→A는 `<sha>:<fetched_ms>`이다. 코드 버전이 다르면 새 버전 행이 생긴다.
- 항목·날짜별 정규화 상태는 garmin 표에 남는다. 큰 항목은 500행 chunk로 발행한다.
- 첫 발행 때 권위 규칙 v2(수집 dataset + v1 배열)를 쓴다. v1과 `authority_provenance`는 바꾸지 않는다.
- collect는 항목마다 발행하고, run 끝에 영향 날짜와 미완료 날짜의 요약을 발행한다. 새 `garmin.normalize` 일감이 미발행·실패 raw와 날짜를 다시 처리한다.
- 동등성 기대값은 opt-in 스크립트로 옛 archive에서 만들어 고정했다.

**바뀐 파일:**
- `extensions/garmin/src/normalize_daily.py`, `normalize_activity.py`, `digest.py`, `garmin_dates.py` — 옛 v8 파서·digest 이식(원본과 같음, import만 다름)
- `extensions/garmin/src/labels.py`, `labels/exercise_types_ko.json`, `pyproject.toml` — 한국어 종목 리소스와 loader, package data
- `extensions/garmin/src/normalize_tables.py` — raw 항목 → 옛 표 모양 행·항목 결과(순수)
- `extensions/garmin/src/normalize_store.py` — 관측 변환(반입과 같은 키), revision·id·batch 규칙, chunk 발행, 상태, 권위 v2
- `extensions/garmin/src/normalize_runtime.py` — collect·normalize가 함께 쓰는 준비, NULL raw, 날짜 요약 발행, rebuild
- `extensions/garmin/src/normalize.py`, `manifest.json` — `garmin.normalize` 일감(manual `normalize`)
- `extensions/garmin/src/collect.py`, `collect_store.py` — 걸음 수 전용 경로 제거, 항목 발행·날짜 요약 연결, snapshot 재사용, summary에 정규화 수
- `extensions/garmin/migrations/0008_normalize.sql` — `normalize_items`, `normalize_days`, `authority_v2`
- `extensions/garmin/scripts/legacy_normalize_oracle.py` — opt-in 기대값 생성기(기본 suite 밖)
- 시험:
  - `extensions/garmin/tests/fixtures/normalize_v8/{input,expected}.json`, `check_normalize_equivalence.py`, `check_normalize_store.py`
  - `check_collect.py`, `collect_fixture.py`
  - `apps/cli/python-test/garmin-normalize.test.ts`(새 파일), `garmin-collect.test.ts`, `garmin-tracer.test.ts`(migration 8)
- `_bmad/custom/bmad-orca-control.py` — 지휘자 도구의 새 Orca `check` 출력 호환. 별도 커밋이다.

**리뷰:** Quick 1회에서 findings 4건(medium 3, low 1)이 나왔다.
- patch 3건: 버전과 무관한 revision 이력, 날짜 revision에 입력 fetched_at 포함, 실패 날짜를 다음 collect가 재시도
- reject 1건: 범위 밖 극단 시각 변환. Garmin이 보낼 수 없는 값이고 고치려면 새 예외 경로가 필요하다.
- 새로 deferred한 항목은 없다. 계획의 [ASSUMPTION] 4건은 frontmatter에 있다.

**후속 리뷰 권고:** `true`. 첫 리뷰에서 medium patch가 3건이다(high 0). 확인되지 않은 위험은 다음과 같다.
- revision 규칙(버전 간 재사용, suffix, 날짜 입력 fetched_at)과 chunk 중단 뒤 재개는 함께 바뀌었다. chunk 사이 실제 중단은 `pending` 상태 재발견 경로로만 덮었고 crash 주입 시험은 없다.
- 계정 id(로그인 profile id = 반입 `userProfileId`)는 실계정 확인 전이다(16.9).

**검증(지휘자, patch 뒤):**
- Python check 8종(normalize_equivalence·normalize_store·collect·raw_transitions·collect_plan·settings·session·health_contract) 통과
- `pnpm build` 뒤 대상 Vitest 5파일 10/10
- `pnpm test:python` 11파일 46/46
- `pnpm test` 170파일 3921 통과, 기존 skip 1
- `packages/`·`apps/cli/src`·`plugin/` 변경 없음. 홈 절대 경로 없음.

**남은 위험:**
- 새 raw에서 빠진 샘플과 날짜를 옮긴 workout의 예전 논리 키는 current에 남는다(deferred [ASSUMPTION]).
- 새 정규화 버전을 current로 쓰려면 core 지원 버전 마이그레이션이 필요하다(deferred).
- `unfinished_days`는 같은 날의 최신 상태가 성공이면 건너뛴다. 실패가 남은 날은 collect마다 다시 계산한다. 멱등이라 비용만 든다.
- 실계정 호출은 하지 않았다(16.9).
