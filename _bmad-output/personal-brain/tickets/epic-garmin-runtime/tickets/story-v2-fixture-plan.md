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
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
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
  - summary: >-
      16.3 평문 steps 논리 키의 과거 관측과 canonical 키 관측을 함께 보유한 시험/설치 이력의 정리가 필요하다.
    evidence: |-
      원래 baseline의 _publish_steps가 original_key/sub_identity에 day 평문을 기록했다. 16.4는 반입과 같은 canonical 키를 사용하며 기존 불변 건강 행을 수정하지 않는다. 배포 전 과거 합성 데이터 정리와 소비 계약을 별도 판단한다.
    location: >-
      extensions/garmin/src/normalize_store.py
    severity: medium
  - summary: >-
      옛 Orca 제어 helper의 새 from 메시지 및 지역 ack 검증 공백은 해당 도구 소유 작업으로 남긴다.
    evidence: |-
      기존 제어 시험은 from_handle과 서버 delivery만 사용한다. 이번 독립 명세는 옛 helper 사용을 금지하므로 실행하거나 수정하지 않았다.
    location: >-
      _bmad/custom/test_bmad_orca_control.py
    severity: medium
  - summary: >-
      garmin.timezone 설정 전환 뒤 기존/새 시간대 관측의 재발행과 소비 계약은 별도 정리가 필요하다.
    evidence: |-
      item 상태는 raw revision/fetched/version을 기준으로 하고 건강 logical key는 timezone을 포함한다. 고정 시간대 v8 이식과 재개는 검증했으나 기존 16.3의 시간대 전환을 새로운 마이그레이션 기능으로 넓히지 않았다.
    location: >-
      extensions/garmin/src/normalize_runtime.py
    severity: medium

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


## 2026-11-03 필수 후속 리뷰

# 16.4 후속 리뷰 triage — 수정 전 판정

모든 독립 렌즈 완료 후 현재 코드·호출자·기존 시험·기존 triage와 대조했다. 아래 번호는 원문 항목과 일대일 대응한다. 수정 결과와 검증은 완료 뒤 계획에 추가한다. 원래 baseline과 기존 증거를 보존한다.

## Blind Hunter — 10건

- B1 `[medium]` `[patch]` account 정규화 no-op: collect.py는 account target에서 set_target을 생략하고 normalize.py는 target_account 매핑만 사용한다. 시험의 관리자 INSERT가 이 공백을 가린다. 실제 account 경로 연결과 관리자 보충 없는 PG 시험을 채택한다.
- B2 `[medium]` `[patch]` collect 재진입의 pending item 누락: unpublished 호출은 rebuild뿐이고 no-op 경로는 unfinished_days만 읽는다. raw coverage가 완료면 남은 chunk를 채울 길이 없다. 수집과 독립된 미완료 발행 복구를 채택한다.
- B3 `[medium]` `[patch]` 날짜 pending 누락: publish_day는 마지막 chunk에서만 상태를 쓴다. 최초 chunk 뒤 및 raw commit 뒤 날짜 집계 전 중단을 재발견하도록 보완하고 시험한다.
- B4 `[medium]` `[patch]` 반입 전용 날짜 복제: rebuild는 수집 raw의 연속 범위를 만들고 publish_days는 계정 전체 raw를 읽는다. 중간 반입 전용 날짜가 새 수집 요약으로 바뀐다. 실제 수집 날짜·영향 활동으로 후보를 제한한다. 같은 날짜의 계정 전체 보조 입력 사용은 기존 Design Notes대로 유지한다.
- B5 `[medium]` `[patch]` 날짜 revision 충돌: day_revision은 입력별 fetched/labels를 포함하나 fetched는 max 하나뿐이다. migration 0026의 revision_count는 normalization_version 선택 전이므로 같은 max에 다른 revision이면 current에서 제외한다. 날짜 파생 발행 순서 설계 보완과 역순·동률·버전 재사용 시험을 채택한다. 원문 항목의 fetched 의미는 보존한다.
- B6 `[medium]` `[patch]` unpublished 이중 선형 탐색: raw마다 전체 revision 상태를 any로 순회하고 raw hash도 반복 계산한다. 장기 이력에서 수동 재정규화 선택 비용이 곱으로 커진다. 성공 키 집합으로 단순화한다.
- B7 `[medium]` `[patch]` 잘못된 JSON 날짜 격리 실패: normalize_all의 날짜 json.loads가 try 바깥임을 확인했다. decode를 날짜 격리 안으로 이동하고 정상 날짜와 함께 검증한다.
- B8 `[medium]` `[patch]` PG text/json/활동 키 검증 공백: 기존 storage check는 세 numeric catalog뿐이며 PG 직접 키 대조도 steps뿐이다. 실제 publisher의 text/json·활동·세트·문자열 PK를 검증한다.
- B9 `[medium]` `[patch]` chunk 중간 attempt 회수 검증 공백: 501행 완주와 완료 token 처음부터 거부는 중간 상태를 만들지 않는다. 500행 commit 뒤 회수·거부·새 attempt 수렴을 검증한다.
- B10 `[medium]` `[patch]` normalize 출력 비밀 검증 공백: 상태 행 canary 확인은 stdout/stderr를 관찰하지 않는다. 성공·파서 실패·DB 실패의 출력과 상태를 검증한다.

## Edge Case Hunter — 6건

- E1 `[medium]` `[patch]` labels 변경의 날짜 revision 동률: B5와 같은 원인. 날짜 입력 max가 같아도 파생 revision이 달라지는 실제 경로이므로 같은 수정과 시험으로 해결한다.
- E2 `[medium]` `[patch]` 날짜 chunk 중단 미재발견: B3과 같은 원인. 마지막 chunk 전 상태가 없으므로 같은 pending 보완으로 해결한다.
- E3 `[low]` `[reject]` 극단 timestamp: carried — 기존 quick의 같은 위치·같은 주장이다. datetime 범위 밖 값은 평소 입력에서 만나기 어렵고 새 예외 경로가 필요하다는 기존 판정과 조치를 유지한다.
- E4 `[medium]` `[defer]` 16.3 평문 steps 키와 새 canonical 키 중복: 원래 baseline의 _publish_steps가 이미 평문 sub_identity/day를 썼다. 16.4의 새 canonical 키는 반입과 같은 키라는 수락조건을 충족하며 옛 잘못된 관측을 변경하는 core 계약 작업은 이번 후속 리뷰 명세 밖이다. 실제 배포 전 16.3 합성/설치 시험 데이터가 남는 경우의 별도 정리 대상으로 기록한다. 건강 행 UPDATE/DELETE로 숨기지 않는다.
- E5 `[medium]` `[defer]` 빠진 샘플의 예전 current 유지: carried — 계획 frontmatter의 같은 deferred 항목과 같은 원인이다. 기존 불변 보관/키별 current 계약을 유지하며 재등록하지 않는다.
- E6 `[medium]` `[patch]` 순수 날짜 JSON decode 격리 주장 반증: B7과 같은 원인. 같은 날짜 격리 수정으로 해결한다.

## Verification Gap — 3건

- V1 `[medium]` `[patch]` 큰 항목 첫 chunk 뒤 재개 관찰 없음: 렌즈의 시험 검색 증거를 수용한다. B9와 같은 중단·새 attempt 수렴 시험으로 해결한다.
- V2 `[medium]` `[patch]` 유효 체중 원문 최신 선택·반올림 검증 없음: 렌즈의 fixture/검색 증거를 수용한다. 합성 역순 측정을 격리 legacy oracle로 고정하고 동등성 검사를 확장한다.
- V3 `[medium]` `[defer]` 옛 Orca helper 새 메시지/지역 ack 시험 없음: 렌즈의 공백 증거는 유효하지만 이번 명세는 그 helper 사용을 금지한다. baseline 이후 별도 도구 커밋이 diff에 포함된 것이며 제품 16.4의 필수 조건이 아니다. 도구 소유 작업으로 남기고 이번 수정에서 사용·변경하지 않는다.

## Intent Alignment — 관찰 A~G 7건

- I-A `[medium]` `[patch]` 계산 fixture와 PG publisher 관찰 폭 차이: B8과 같은 검증 공백. DB 변환·키·타입 검증을 추가한다.
- I-B `[false]` `[reject]` NULL raw 무조건 행 생성이라는 해석: 원래 intent는 옛 coordinator의 계산 의미를 보존하며 계획 Code Map과 Implementation Notes가 NULL raw의 기존 행 조건을 명시한다. 파서가 만든 열 NULL과 raw 자체 null은 별개다. 새 결함으로 판정하지 않는다.
- I-C `[false]` `[reject]` 계정 전체 보조 raw 사용 자체가 금지라는 해석: Design Notes는 day_values의 계정 전체 coverage snapshot을 명시한다. 반입 dataset 항목 자체를 재발행하거나 반입 dataset에 쓰지 않는 경계와 양립한다. 반입 전용 날짜가 수집 출력 후보가 되는 별도 실제 결함은 B4로 수정한다.
- I-D `[medium]` `[patch]` 완주 결과와 chunk 중단 관찰 차이: B9/V1과 같은 시험 공백. 실제 중간 commit·회수·수렴을 관찰한다.
- I-E `[low]` `[reject]` matrix COLLECT_STOPPED와 invalid attempt 코드 차이: signal은 STOPPED, DB token 회수는 INVALID_ATTEMPT이며 둘 다 fail closed다. 코드 결함이 아니라 계획의 포괄 표현이다. 계획만 고치는 finding은 워크플로 규칙상 reject하고 검증 결과에 원인별 코드를 기록한다.
- I-F `[medium]` `[defer]` 옛 샘플 표 교체와 current 집합 차이: carried — E5 및 기존 deferred와 같은 원인. 새 항목으로 다시 등록하지 않는다.
- I-G `[false]` `[reject]` 입력 diff에 자동화·타 티켓 변경이 포함됨: 공식 워크플로는 원래 baseline 이후 전체 diff를 요구한다. 이미 커밋된 별도 변경을 이번 신규 제품 변경으로 해석하지 않으며 해당 파일을 수정하지 않는다.

합계 26건: medium 21, low 2, false 3. patch 17건(공유 원인 그룹 포함), defer 4건(그중 carried 2건), reject 5건. high 및 maybe-false 0건. 이 수는 실제 수정 완료 수가 아니라 채택 판정 수다.


# 16.4 후속 수정의 설계 보완과 검증 범위

원래 baseline `1b31120e62c0b8787634f7c685dc7e3b7869609a`와 기존 구현·quick 리뷰 증거를 보존한다. intent-contract는 변경하지 않았다. 후속 수정은 기존 수락조건의 불변 발행·멱등·실제 중단 복구를 완성한다.

- 계정 대상 수동 normalize는 account ID를 직접 사용한다. extension 대상은 기존 확인된 매핑을 사용한다.
- 수집 시작 시 미발행 항목을 다시 처리한다. raw 저장 트랜잭션에서 날짜 dirty generation을 기록하고, 날짜 발행 완료는 예약한 세대에만 적용한다. 첫 날짜 chunk 전에 pending을 예약해 raw commit 뒤와 날짜 chunk 사이 중단을 재발견한다.
- 날짜 후보는 수집 dataset에 실제로 있는 날짜와 활동의 영향 날짜다. 같은 날짜를 계산하는 보조 입력은 기존 설계의 계정 전체 coverage snapshot을 유지한다.
- 날짜 revision 재료의 입력 fetched와 labels SHA는 유지한다. 원문 항목 관측의 fetched는 원문 fetched 그대로다. 날짜 파생 관측은 source max 밀리초 안의 마이크로초 슬롯을 사용한다. 원래 source max는 ledger에 별도로 보존하며, 같은 source max의 다른 입력 조합은 다음 슬롯에 예약한다. 다른 source max의 자연 순서는 유지된다. 같은 revision은 버전 전체에서 같은 슬롯을 재사용한다. 1밀리초의 1,000개 슬롯이 모두 쓰이면 명시적으로 실패하며 현재를 임의로 되돌리지 않는다.
- 예약은 짧은 트랜잭션에서 현재 raw와 계산 snapshot을 검증한다. stale snapshot은 새 슬롯을 얻지 않고 다시 계산한다. 기존 0008의 동일시각 revision 충돌은 기존 관측을 보존하면서 현재 base revision의 결정적 repair alias를 다음 슬롯에 발행한다. 충돌 없는 기존 revision은 그대로 재사용한다.
- `0009_day_publication.sql`은 dirty generation과 버전 공통 revision 예약을 확장 schema에 추가한다. core·plugin·app-ref는 변경하지 않는다.
- 미발행 검색은 성공 키 집합으로 바꾸었고 순수 날짜 JSON decode는 날짜별 실패 격리 안으로 옮겼다.
- 실제 PG 시험에 500행 commit 뒤 중단/attempt 회수/새 attempt 재개, text 원문/JSONB/활동·세트·문자열 PK/단위·날짜·시각, normalize 출력 비밀 비노출, 반입 전용 중간 날짜 불변, 0008→0009 충돌 복구와 버전 재사용을 추가했다.
- 고정 oracle에 합성 역순 체중 측정을 추가했다. 최신 72,346g이 72.3kg으로 계산됨을 격리 legacy oracle로 고정했으며 archive SHA-256 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`는 유지한다. 기본 suite에서 oracle은 실행하지 않는다.

구현 워커의 대상 시험은 통과했으며 독립 재리뷰와 최종 전체 검증을 추가로 수행한다. 정상화 버전9 시험은 임시 확장 복사본과 시험 DB 지원 목록에서만 실행한다.


# 16.4 수정 후 thorough 재리뷰 triage

4렌즈 전부 완료 후 18개 항목을 현재 코드·호출자와 대조했다. 이전 판정과 같은 위치·주장은 carried로 보존했다. 최종 검증 워커가 소스 수정 없이 전체 시험을 마칠 때까지 다음 수정을 시작하지 않는다.

## Blind Hunter — 10건

- F-B1 `[medium]` `[defer]` 시간대 변경 재발행: item/day 상태에 zone이 없고 건강 logical key에는 zone이 있으므로 설정 전환은 단순 재발행으로 옛 그룹을 없앨 수 없다. 이는 원래 baseline의 16.3에서도 존재하던 시간대 설정 전환 계약 문제다. 이번 명세는 동일 timezone에서의 v8 이식·revision·복구이며 시간대 마이그레이션은 요구하지 않는다. 현재 실행은 고정 zone snapshot을 따른다. 별도 설정/소비 계약의 후속 작업으로 기록한다.
- F-B2 `[medium]` `[patch]` labels A→B→A: 현재 reserve_day는 A의 과거 성공을 재사용하므로 B의 높은 슬롯이 current에 남는다. B5 수정이 도입한 예약 재사용에서 드러난 실제 결함이다. 현재 입력 조합의 재등장을 별도 결정적 발행 회차로 예약하고 버전 공통 재사용·멱등을 유지한다.
- F-B3 `[low]` `[reject]` datetime 상한: carried — 기존 quick 및 E3의 같은 위치/주장/코드다. 극단 입력에 새 예외 경로를 더하지 않는 기존 판정을 유지한다.
- F-B4 `[medium]` `[patch]` collect history_start 누락: rebuild 후보만 history_start를 거르고 공통 publish_days는 거르지 않는다. collect 활동의 옛/새 시작 날짜는 시작일 이전으로 갈 수 있다. 공통 경계에 필터를 두고 실제 경계 시험을 추가한다.
- F-B5 `[medium]` `[patch]` NULL 상태 전이 검증 공백: 최초 NoData·다른 소유 endpoint의 대상 행 생성·기존 행 뒤 null·재시도의 상태 의존은 순수 fixture가 관찰하지 않는다. 원래 legacy 의미를 유지하는 제품 경로 PG 전이를 추가한다.
- F-B6 `[medium]` `[patch]` rich frozen 입력과 제품 runtime 연결 공백: publisher 직접 생성 행 시험은 저장 계약은 증명하지만 raw→prepare→publish_days 전체를 통과하지 않는다. 합성 frozen 입력 전체를 제품 경로로 발행하고 고정 expected의 catalog 투영과 대조한다.
- F-B7 `[medium]` `[patch]` 날짜의 실제 여러 chunk 중단 검증: 항목 501행 및 날짜 첫 chunk 전 중단은 날짜 마지막 chunk의 generation 완료 조건을 증명하지 않는다. 날짜 관측 500초과의 첫 commit 뒤 중단·새 attempt 복구·id/batch/watermark 보존을 추가한다.
- F-B8 `[medium]` `[patch]` dirty 세대 경합 검증 공백: 예약 N 뒤 raw commit N+1, N 완료의 generation 조건을 시험하지 않는다. 실제 두 연결을 결정적 순서로 제어해 N+1 pending 및 최종 current 수렴을 관찰한다.
- F-B9 `[medium]` `[patch]` 잠금 안 전체 raw 전송 비용: reserve_day는 날짜마다 계정 전체 본문을 SHARE 잠금 아래 전송·정렬·비교한다. 몇 년치 샘플이 있는 정상 계정에서 1.9초 제한과 전체 writer 차단을 유발할 수 있다. stale 검증 정확성을 보존하면서 본문 전송·비교 범위를 줄이고 대표 합성 이력의 짧은 transaction 경계를 검증한다.
- F-B10 `[low]` `[reject]` 같은 source millisecond의 1000슬롯 소진: 명시적 fail closed가 이미 구현돼 있어 임의 최신성 훼손은 없다. 고정 labels와 실제 endpoint timestamp가 유지된 채 1000회 서로 다른 조합이 발행되는 것은 평소 입력에서 드물다. 자동 복구 정책을 새로 추가하는 것은 단순 정정이 아니므로 reject하고 알려진 한도를 최종 보고에 보존한다.

## Edge Case Hunter — 2건

- F-E1 `[medium]` `[defer]` 사라진 샘플/세트/라벨 키 current 잔존: carried — E5와 I-F 및 원래 deferred의 같은 키별 current 계약이다. 불변 발행의 삭제 표식 계약을 이번에 새로 만들지 않고 기존 판정과 후속 항목을 유지한다.
- F-E2 `[low]` `[reject]` 극단 timestamp 변환 격리: carried — F-B3과 같은 기존 quick 판정이다. 추가 patch/defer하지 않는다.

## Verification Gap — 2건

- F-V1 `[medium]` `[patch]` 예약 뒤 새 dirty 세대 보존 시험 없음: 렌즈의 검색·시험 증거를 수용한다. F-B8과 같은 경합 시험으로 해결한다.
- F-V2 `[medium]` `[patch]` 제품 runtime의 문법상 잘못된 JSON 격리 시험 없음: 렌즈의 검색·시험 증거를 수용한다. 순수 normalize_all 검사와 실제 normalize의 날짜 ledger/result/current는 별도 표면이다. 손상 날짜와 뒤의 정상 날짜를 제품 일감으로 함께 검증한다.

## Intent Alignment — A~D 4건

- F-I-A `[false]` `[reject]` imported raw를 날짜 보조 입력으로 쓰는 것 자체가 금지라는 해석: carried — I-C와 같은 주장이다. 기존 Design Notes가 계정 전체 snapshot 보조 입력을 명시하며 대상 항목/출력 dataset 경계와 양립한다. 반입 전용 날짜의 출력 오염은 B4 수정/PG 시험으로 별도 해결했다.
- F-I-B `[medium]` `[patch]` 고정 기대값과 실제 제품 발행 경로의 연결 폭: F-B6과 같은 검증 공백이다. rich fixture 전체를 제품 runtime으로 검증한다.
- F-I-C `[false]` `[reject]` 최초 null의 무조건 열 발행 해석: carried — I-B와 같은 주장이다. 옛 coordinator의 기존 행 조건을 우선하는 원래 판정은 유지하며, F-B5의 전이 시험으로 이 의미를 명시적으로 관찰한다.
- F-I-D `[low]` `[reject]` 취소 코드 문자 차이: carried — I-E와 같은 주장이다. signal STOPPED와 DB INVALID_ATTEMPT는 원인별로 구분되고 모두 fail closed이며 실제 chunk 회수 시험이 이를 관찰한다. 계획 문구만 바꾸는 finding은 reject한다.

합계 18건: medium 12, low 4, false 2; patch 10, defer 2, reject 6. high 및 maybe-false 0. 공유 원인별 수정/검증 후 결과와 독립 확인을 추가한다.


## 2026-11-03 필수 후속 리뷰 최종 결과

기존 구현 commit `149c3e0ed59817834501e6486ac0edb38c26e833`, 원래 baseline `1b31120e62c0b8787634f7c685dc7e3b7869609a`, 이번 checkout 기준 `0fe53a467be768374b1f679286845a19dae41695`를 보존했다. 새 기능 재계획 없이 공식 full/thorough의 독립 4렌즈를 실행하고, 수정 후 4렌즈 재리뷰와 정확성·검증 증거 확인 및 마지막 시작일 확인을 수행했다.

### Review Triage Log 보완

두 번째 4렌즈 판정 전문은 `reviews/story-v2-fixture-2026-11-03/triage-pass-2.md`에 있다. 18개 항목 각각의 verdict·route·근거를 보존했다. 1차 26개 판정은 위 본문과 `triage-pass-1.md`에 보존했다. 후속 정확성 확인에서 추가한 1건은 다음과 같다.

- C1 `[medium]` `[patch]` 최초 수집의 확정 history_start가 snapshot에 반영되지 않음: `collect.py`의 planned/empty 두 경로가 `set_history_start`의 DB 확정 반환값으로 snapshot과 로컬 history를 갱신하도록 고쳤다. 기존 DB 값의 `on conflict do nothing`은 유지한다. 새 실제 collect 시험은 패치 전 시작일 이전 파생 관측 50행으로 실패하고 패치 후 0행 및 no-op 불변으로 통과했다. 마지막 독립 확인의 발견사항은 0건이다.

이번 후속 실행 전체 발견사항은 45건(26+18+1): medium 34, low 6, false 5, high/maybe-false 0. 행별 route는 patch 28, defer 6(기존 carried 포함), reject 11이다. 공유 원인으로 묶은 medium patch entry는 1차 11개, 2차 8개, 마지막 최초 시작일 1개다. 별도 실행 검증에서 발견한 canary 리터럴 시험 fixture 회귀도 수정했다. 실제 인증 비노출 assertion은 완화하지 않았다. 모든 채택 항목은 코드/시험과 독립 확인으로 처리했고, 현재 티켓의 미충족 수락조건을 defer하지 않았다.

### 최종 설계와 변경 파일

- `collect.py`, `collect_store.py`, `normalize.py`, `normalize_runtime.py`, `normalize_store.py` — account 수동 정규화 연결, pending 항목 재개, raw commit과 날짜 dirty 세대 연결, 날짜 pending 예약/완료 세대 검사, 실제 수집 날짜·활동 후보 및 확정 history_start, 짧은 snapshot fingerprint 검증, 성공 키 집합 조회, NULL 상태 전이를 보완했다.
- `0009_day_publication.sql` — 확장 schema의 날짜 dirty·버전 공통 revision 예약과 NULL materialization 상태를 추가한다. 기존 건강 관측과 v1 권위는 수정하지 않는다.
- 날짜 파생 revision은 base fingerprint와 실제 발행 occurrence를 구별한다. 원래 source max 밀리초와 버전 공통 watermark를 보존하며, 동일 source max의 새 조합/라벨 복원은 같은 밀리초 안의 다음 마이크로초 슬롯을 예약한다. 연속 동일 입력·다른 정규화 버전은 같은 occurrence를 재사용한다. stale raw snapshot은 예약하지 않는다. 기존 0008 동일시각 충돌은 원래 관측을 보존한 결정적 복구 별칭으로 수렴한다. 원문 항목 관측의 fetched는 원문 fetched 그대로다. 이 내용은 위 초기 Design Notes의 단순 max와 초기 후속 설계의 base 재사용 설명을 보완한다.
- `normalize_tables.py`, `check_normalize_equivalence.py`, frozen `normalize_v8/input.json`·`expected.json` — 날짜 decode 격리와 역순 합성 체중 oracle를 검증한다. 나머지 옛 계산 본문과 archive SHA는 유지했다.
- `garmin-normalize.test.ts`, `garmin-pass2.test.ts`, `garmin-upgrade.test.ts`, `garmin-history-start.test.ts`, `garmin-tracer.test.ts` 및 합성 Python fixture — actual 500행 중단/회수/재개, 날짜 chunk와 세대 경합, raw 전체 제품 경로와 고정 expected의 독립 투영, PG text/json/키/단위/시각, NULL 전이, 비밀 비노출, 이전 전용 날짜 불변, watermark/라벨 복원/버전 재사용, 실제 0008→0009 upgrade 및 최초 수집 경계를 검증한다.
- 리뷰·triage·구현·검증 보고서는 `reviews/story-v2-fixture-2026-11-03/`에 보존한다. 원래 quick 보고와 Auto Run Result는 과거 증거로 남긴다. 이 최종 결과가 현재 완료 판정이다.

### 최종 Verification

- frozen 의존성 설치: `pnpm install --frozen-lockfile`, `uv sync --frozen --python python3.14 --project extensions/garmin` 성공. 초기 sandbox DNS/cache 제한은 권한 확장으로 같은 명령을 실행해 해결했다.
- 격리 oracle: `PYTHONDONTWRITEBYTECODE=1 extensions/garmin/.venv/bin/python extensions/garmin/scripts/legacy_normalize_oracle.py`로 합성 역순 체중 기대값을 고정했다. archive SHA-256 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`. 기본 suite는 oracle를 호출하지 않는다.
- 계획 Python check 7개와 `check_health_contract.py`: 8개 모두 통과.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test:python`: 13파일 48시험 통과, skip 0. `pnpm build` 포함. 앞선 canary 리터럴 실패를 수정한 뒤 전체 통과를 확인했다.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test`: 170파일, 3,921시험 통과, 기존 skip 1. build와 typecheck 포함.
- 위 전체 검증 뒤 추가된 작은 history_start 전달 수정은 패치 전 실패를 재현하고, 수정 후 `garmin-collect`, `garmin-collect-resume`, `garmin-pass2`, `garmin-history-start` 4파일 4시험 모두 통과(skip 0)했다. Python collect/collect_plan/raw_transitions 3개 및 typecheck도 통과했다. 이 마지막 경계 수정 후 전체 suite를 불필요하게 다시 반복하지 않았다.
- 시험 PostgreSQL은 `compose.test.yaml`의 `127.0.0.1:54329`이며 합성 fixture/fake client만 사용했다. 시험 파일은 전역 확장 role 충돌을 피하도록 순차 실행했다. 실계정 호출과 운영 데이터 변경은 하지 않았다.
- `git diff --check` 및 문서 홈 절대경로 검사를 통과했다. 이번 신규 diff에 core 실행 코드·plugin/app-ref 변경은 없다.

### Auto Run Result 보완

최종 상태는 `built`이며 사용자 인수 전 `done`으로 올리지 않는다. 이번 실행은 follow-up pass이며 patched high가 0개이므로 `followup_review_recommended: false`다. medium patch 수 자체는 후속 pass를 다시 권고하는 기준이 아니다. 채택 항목의 수정 뒤 필요한 독립 확인과 시험을 마쳤으며 남은 미검증 high 위험은 없다.

원래 deferred 4개와 새로 기록한 16.3 평문 키 이력 정리, 금지된 옛 Orca helper 시험, 시간대 설정 전환 계약은 별도 후속 범위다. 사라진 키의 current 잔존, 새 지원 버전의 core migration 필요, 늦은 반입의 권위 버전 갱신 필요는 기존 범위와 같다. 같은 source 밀리초의 1,000개 파생 watermark 슬롯이 소진되면 명시적으로 실패한다. 극단 datetime과 슬롯 소진은 평소 발생 가능성이 낮고 복구 정책 확장이 필요한 low reject로 기록했다. 실제 계정 identity 확인은 16.9이며 이번 합성 검증의 성공으로 대신하지 않는다.
