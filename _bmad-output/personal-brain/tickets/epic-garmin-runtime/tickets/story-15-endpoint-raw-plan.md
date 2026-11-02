---
title: '16.3 전수 수집과 재개 — 15개 endpoint, 진입표, 재개, 설정·예약 선언'
type: 'feature'
ticket: 3
created: '2026-11-02'
status: 'built'
baseline_revision: 'a6efa3eb7e66683cf82eb0de9344261eb09c5325'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: ['{project-root}/_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md']
warnings: ['oversized']
deferred:
  - summary: >-
      검토 필요: [ASSUMPTION] extension 대상의 계정은 로그인 profile의 `profile_id`이고, 이전 dataset의 `userProfileId`와 같은 문자열로 비교한다.
    evidence: |-
      epic 14 결정은 "epic 16은 로그인 profile의 같은 id를 쓴다"이다. 하지만 social profile `profileId`와 raw `userProfileId`가 같은지는 실계정으로 확인하지 않았다. 16.9 실수집에서 확인한다.
    location: >-
      extensions/garmin/src/collect.py
    severity: medium
  - summary: >-
      검토 필요: [ASSUMPTION] 여러 dataset의 raw는 checked_at이 가장 늦은 행으로 판단한다. 이전 행만 있을 때 같은 원문이나 NoData를 받으면, 이전 행의 값을 복사한 수집 dataset 행을 넣는다.
    evidence: |-
      E16-3은 "이전된 행을 덮지 않는다"와 "raw 전이는 옛 의미"를 함께 요구한다. 합쳐 본 값이 옛 upsert_raw와 같아지도록 정한 방식이다.
    location: >-
      extensions/garmin/src/collect_store.py
    severity: low
  - summary: >-
      검토 필요: [ASSUMPTION] partial 결과는 `COLLECT_PARTIAL`, retryable=false다. 재시도는 11:15 예약의 진입표가 맡는다.
    evidence: |-
      감독자 자동 재시도가 옛 재시도 규칙과 별개로 같은 날 호출을 늘리지 않게 하려는 보수적 선택이다.
    location: >-
      extensions/garmin/src/collect.py
    severity: low
  - summary: >-
      검토 필요: [ASSUMPTION] "설정 단계 거부"는 core 설정 CLI의 미선언 키 거부와 worker 시작 snapshot 검증을 합친 것이다. collect_time·retry_time 설정은 두지 않고, 예약 시각은 manifest default_schedules가 소유한다.
    evidence: |-
      core는 타입만 검사하고(`snapshot.ts:15`), core 무변경 조건이다. 사용자가 예약 시각을 바꾸려면 core 예약 명령을 쓴다.
    location: >-
      extensions/garmin/src/collect_settings.py
    severity: low
  - summary: >-
      기존 결함: garmin-import-verify.test.ts가 health_resolution_v1 조회의 2초 transaction_timeout 때문에 간헐적으로 실패한다.
    evidence: |-
      baseline a6efa3e와 변경본에서 각각 5회 단독 실행했고, 둘 다 3회 실패했다. PostgreSQL 로그는 transaction_timeout을 기록했다. 최종 전체 실행에서는 통과했다.
    location: >-
      apps/cli/python-test/garmin-import-verify.test.ts
    severity: medium
  - summary: >-
      시험 PG 클러스터에서 중단된 시험이 남긴 `brain_ext_garmin` role이 이후 시험 설치를 role 충돌로 막는다. 시험 DB도 125개가 남아 있었다.
    evidence: |-
      Orca 재시작으로 끊긴 실행 뒤, 모든 Garmin 설치 시험이 `DB_UNAVAILABLE`("확장 역할을 준비하지 못했습니다")로 실패했다. 지휘자가 남은 role을 지운 뒤 통과했다. 시험 harness의 정리 경로를 점검할 필요가 있다.
    location: >-
      tooling/test-db/src/global-setup.ts
    severity: low
---

<intent-contract>

## Intent

**문제:** collect는 아직 tracer 상태다. `user_summary` 하나를 지정된 날짜 하나만 받는다. 수동 실행(`target_kind=extension`, 날짜 없음)은 `COLLECT_INVALID`로 끝난다. 진입표, 재개, 설정, 기본 예약도 없다.

**접근:** 옛 Garmin(`7fb33dd`)의 collect 계획을 옮긴다. 옮길 것은 coverage, rawparse, 진입표, history_start, 날짜 상한, first-call, raw 전이다. 저장은 PG의 새 수집 dataset에 하고, 판단은 같은 계정의 모든 dataset을 읽어서 한다. 16.2의 세션(`garmin_session.py`)을 그대로 쓰고, 설정 snapshot 값을 그 세션에 넘긴다. 결과는 ABI 결과로 구분한다. manifest에는 기본 예약 둘과 옛 `_DEFAULTS` 대응을 선언한다.

## Boundaries & Constraints

**항상:**
- 옛 원본의 의미를 그대로 둔다. 기준은 `P/collect.py` 맨 위 docstring(진입표·계획·first-call·결과·중단), `P/coverage.py`, `P/rawparse.py`, `P/store/__init__.py:270` `upsert_raw`다.
- 외부 호출 동안 DB 트랜잭션을 잡지 않는다. 쓰기는 항목마다 짧은 트랜잭션이다(2초 제한). 그 트랜잭션 안에서 `garmin.attempt_valid`를 확인한다.
- 이전된 dataset의 행은 읽기만 한다. 새 쓰기는 모두 새 수집 dataset(`collect-<digest(account)>`) 안에 한다.
- stdout은 ABI JSONL뿐이다. 오류는 manifest `error_codes`의 코드만 낸다.
- 시험은 fake client·fake clock만 쓴다. 네트워크 호출은 0이다.

**금지:**
- 전 endpoint 정규화, 권위 v2, 사건 알림, artifacts는 하지 않는다(16.4·16.5·16.7). 정규화는 tracer의 `user_summary` 걸음 수 publish만 유지한다.
- core·postgres·CLI 코드는 바꾸지 않는다. 시험 fixture는 바꿀 수 있다.
- 옛 `_abandon_running`처럼 남의 run 행을 고치지 않는다.
- `plugin/app-ref`와 plugin version은 올리지 않는다.
- 실계정 호출은 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 빈 상태 첫 실행 | raw 없음, today=T | history_start=T−30을 기록한다. T부터 최신순으로 10일, 날짜마다 day 11개와 그날 활동 항목을 받는다 | `result` |
| 이전된 raw | 이전 dataset에 그날 data·final raw 있음 | 그 항목은 호출하지 않는다 | 없음 |
| history_start 이전값 | D2 dataset의 보존 `meta.history_start` 있음 | 그 값을 쓴다 | 없음 |
| 당일 block | 오늘 날짜의 `block.json` | 진입표 1행이다. `skipped_blocked` run을 쓰고 호출 0 | `SESSION_BLOCKED` |
| 재진입 not_run·error·rate_limited·blocked_403 | 오늘 마지막 run | 전체 계획 | 상황별 |
| 재진입 auth_failed | 같은 현지 날짜 | 토큰 mtime이 그 run의 finished_at보다 뒤면 전체 계획, 아니면 no-op(호출 0) | `result`(no-op) |
| 재진입 partial+transient | `transient=N` | 오늘 확인한 항목과 오늘 rejected 항목을 뺀 나머지만 | 상황별 |
| 재진입 success·거부만 있는 partial | — | no-op, run 행도 쓰지 않음, 호출 0 | `result`(no-op) |
| 항목 실패 | Transient·Rejected | fetch_error 행을 남기고 다음 항목으로 간다. 끝 상태는 partial | `COLLECT_PARTIAL`, retryable=false |
| 거부 상한 | 서로 다른 거부 날짜가 `max_rejected_attempts`만큼 | 그 항목을 계획에서 뺀다 | 없음 |
| 중단 | 로그인·데이터의 429·403×3·인증 실패 | run 상태를 기록하고 남은 호출 0 | `RATE_LIMITED`·`BLOCKED_403`·`LOGIN_REQUIRED` |
| kill 재개 | 3번째 날짜 중 SIGKILL, 재실행 | 앞 두 날의 raw가 남고, 빠진 항목만 받는다. 죽은 attempt의 `running` 행은 error로 읽는다 | 감독자 재시도 |
| 취소 | endpoint 사이 SIGTERM | 다음 endpoint 전에 멈춘다. 회수된 attempt의 쓰기는 거부된다 | `COLLECT_STOPPED` |
| 설정 오류 | 선언 안 된 `garmin.*` 키, `call_pause_min>max`, `max_dates_per_run<3` | 네트워크·DB 쓰기 전에 거부 | `COLLECT_INVALID` |
| 기본 예약 | 설치 두 번 | `garmin.collect` 11:00과 `garmin.collect_retry` 11:15가 하나씩 | 없음 |

</intent-contract>

## Code Map

옛 원본: `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`. 저장소 밖 임시 폴더에 풀어 읽는다. `P/`는 `garmin-source/src/garmin_pipeline/`, `G/`는 `garmin-source/`다.

- 옛 동작:
  - `P/collect.py:1-120` 동작 명세(docstring), `:403` `_enter`, `:450` `_logged_in_again`, `:475` `_retry_exclude`, `:491` `_rejected_exclude`, `:528` `_collect_plan`, `:612` `_first_call_endpoints`, `:625` `_stop`, `:679` `_detail`, `:702` `_history_start`, `:720` `_plan`, `:754` `_pending_activities`
  - `P/coverage.py`: `:133` `items`, `:220` `incomplete`, `:233` `day_status`, `:318` `_stale_lifestyle`
  - `P/rawparse.py`: `:37` `activity_refs`, `:123` `completion_stats`
  - `P/store/__init__.py:270` `upsert_raw`(surrogate fallback 포함)
  - `P/config.py:34` `_DEFAULTS`, `:140-160` 검증
  - `P/garmin/__init__.py:409` cffi API 세션 교체
- 옛 시험(옮길 기준값):
  - `G/tests/test_raw_response.py:117`·`:129`·`:138`·`:157`·`:204`
  - `G/tests/test_coverage.py`, `G/tests/test_collect.py`의 진입표·계획·first-call·중단 경우
  - `G/tests/test_rawparse.py`
- `extensions/garmin/src/garmin_session.py` — 재사용한다. `DAY_ENDPOINTS`·`ACTIVITY_ENDPOINTS`·`FIRST_CALL_ENDPOINTS`, `Session.fetch_day`·`fetch_activity`·`next_date`, `GarminError`.
  - pacing(1~2초), 403 상한(3), lock 대기(60초), 날짜 대기(5초)는 지금 상수다. 설정 값을 받는 인자로 바꾼다. 기본값은 같다.
  - first-call 상한 3은 상수로 둔다.
- `extensions/garmin/src/collect.py` — `inputs`는 string 타입만 허용하고 `target_kind=account`와 range를 강제한다. 이것을 공용 설정 decoder로 바꾸고, `account`·`extension` 두 대상과 range 생략을 받게 한다. `run(client=None, env=None, connect=…)`은 fake 주입 경계라 유지한다.
- `extensions/garmin/src/collect_client.py` — `CollectClient`를 day·activity fetch, 날짜 대기, `library_version`, 계정 id(로그인 뒤 `client.profile_id`)로 넓힌다.
- `extensions/garmin/src/collect_store.py` — `covered`(user_summary 한 항목)와 `publish`(tracer)를 바꾼다. publish는 다음 셋으로 나눈다: 계정 전체 coverage 읽기, 수집 dataset raw upsert, `user_summary` 걸음 수 publish. 걸음 수는 같은 revision이 이미 있으면 넣지 않는다.
- `extensions/garmin/src/auth.py` — 같은 설정 decoder를 쓴다. 숫자·boolean 키가 들어와도 거부하지 않게 한다.
- 이전 데이터:
  - `garmin.raw_payloads`: 0002에서 계정 UNIQUE가 빠졌다. `raw_identity is null`이면 `(dataset,scope,original_key,endpoint)`가 유일하다.
  - `garmin.preserved_rows`: 옛 `run`·`fetch_error`·`meta`, `values_json`.
  - `garmin.import_checkpoints.source_role`: `D2` = 운영.
  - `garmin.datasets.account`: 계정 문자열, `account_confirmed`.
- `extensions/garmin/migrations/` — 새 마이그레이션은 `0007_*.sql`이다. 수집 dataset 안의 `collect_runs`(run_id, attempt token, status, detail, local_date, started/finished), `collect_fetch_errors`, `collect_meta`(history_start), `collect_targets`(대상→계정)를 만든다.
- `extensions/garmin/manifest.json`:
  - work `garmin.collect`(manual `collect`)
  - `garmin.collect_retry`(같은 entry)
  - `garmin.collect_recent`(manual `collect-recent`: 옛 sync의 force+recent_lists, report 없음)
  - `default_schedules`, settings, 새 error_codes
- core(읽기만):
  - `packages/core/src/extensions/manifest.ts:13`·`:67` — `default_schedules`의 모양
  - `packages/core/src/queue/schedules.ts:51` — `ensureDaily`의 키는 (kind, target_kind, target_id)다. 그래서 retry는 kind가 달라야 한다.
  - `schedules.ts:21` — 예약 실행은 range=오늘을 넘긴다.
  - `extensions/run.ts:20` — 수동 실행은 `extension`/`default`이고 range가 없다.
  - `extensions/snapshot.ts:15` — 타입만 검사한다.
  - `process-abi/codec.ts:5` — `result`에는 `summary` 문자열만 있다.
  - `install.ts:272` — 예약 등록에는 scheduler가 있어야 한다.
- 시험:
  - `extensions/garmin/tests/collect_fixture.py`(합성 client wrapper, 시험 홈에만 복사)
  - `apps/cli/python-test/garmin-collect.test.ts`
  - `apps/cli/test/ext-fixture.ts`
  - `extensions/garmin/tests/check_collect.py`·`check_session.py`

## Tasks & Acceptance

**실행(단계마다 phase-ready 보고):**

- [ ] 1단계: `src/collect_settings.py`(새 파일), `manifest.json` settings, `garmin_session.py`, `collect.py`·`auth.py` 입력부.
  - 옛 `_DEFAULTS` 대응을 선언하고 snapshot을 검증한다. 대응표는 Design Notes에 있다.
  - 세션이 설정 값을 받게 한다.
  - `tests/check_settings.py`: 선언 안 된 키, 타입 오류, min>max, 하한 미달이 거부되는지 검사한다.
- [ ] 2단계: `migrations/0007_collect_runs.sql`, `src/collect_store.py`.
  - 계정 전체를 읽는 coverage snapshot을 만든다. raw·fetch_error·run을 모든 같은 계정 dataset에서 읽는다. 이전 run·fetch_error는 보존 행에서 읽는다.
  - 수집 dataset raw upsert는 옛 전이 그대로다. 이전 dataset 행을 덮지 않는다.
  - run·fetch_error·meta·target 쓰기는 attempt 확인과 같은 트랜잭션에 둔다.
  - `tests/check_raw_transitions.py`: 옛 raw 시험 입력의 저장 문자열과 시각 전이를 검사한다.
- [ ] 3단계: `src/collect_coverage.py`·`src/collect_rawparse.py`(새 파일, 행을 받는 순수 함수).
  - items·incomplete·day_status·stale lifestyle·activity refs·진입표·계획·first-call을 옮긴다.
  - `tests/check_collect_plan.py`: 옛 시험의 진입표 각 경우, 10일 상한, 거부 상한, recent_lists, first-call을 검사한다.
- [ ] 4단계: `src/collect.py`, `collect_client.py`, `manifest.json` work·schedule·error_codes.
  - 실행 흐름: 진입표 → 날짜·endpoint → 활동 순으로 돈다. endpoint 전후와 날짜 대기마다 progress를 내고 취소를 확인한다.
  - 대상 계정을 해석한다.
  - 결과를 ABI로 투영한다. 결과 summary에는 cutoff와 현지 날짜를 싣는다.
- [ ] 5단계: `tests/collect_fixture.py`, `apps/cli/python-test/garmin-collect.test.ts`, 새 `garmin-collect-resume.test.ts`, `ext-fixture.ts`.
  - 실제 감독자로 Matrix의 감독자 행(빈 상태, 이전 raw, 재진입, kill 재개, 취소, partial, 실행 중 설정 변경, 예약 두 번 등록, summary)을 검사한다.
  - 기존 tracer·auth·install 시험이 회귀하지 않게 한다.

**수락 기준:**

- Given 예약 실행(range=오늘)이나 수동 `brain ext run garmin collect`(range 없음)가 있을 때, When collect가 돌면, Then 둘 다 같은 진입표로 계획한다. 수동 실행의 today는 설정 시간대의 현재 날짜다.
- Given 실행 시작 뒤 DB 설정을 바꿀 때, When 그 실행이 계속되면, Then 그 실행의 pacing·상한은 시작 snapshot 값이다.
- Given collect가 성공하거나 no-op일 때, Then 마지막 ABI 이벤트는 `result`이다. summary JSON에는 `status`, `cutoff_ms`(수집 snapshot UTC ms), `local_date`가 있다. partial·차단·인증 필요는 서로 다른 `error` 코드다.
- Given 비밀 시험 문자열이 tokenstore에 있을 때, When collect가 성공·실패하면, Then stdout·stderr·DB 오류 행 어디에도 나타나지 않는다.

## Implementation Notes

- 같은 Orca 구현 Dispatch(Codex `gpt-6.1-terra`/medium)가 1~5단계를 phase-ready로 하나씩 했다. 지휘자는 단계마다 diff를 보고 check 스크립트를 다시 돌렸다.
- 지휘자 지적으로 고친 것:
  - manifest의 setting `default`를 문자열로 바꿨다. core manifest 검증기(`manifest.ts:34`)가 문자열만 받는다.
  - `recent_lists` 실행에서 오늘 rejected 항목을 뺀다(`P/collect.py:269`).
  - 활동 retry 제외는 활동 날짜가 아니라 실행 today 기준으로 판정한다.
- 실제 manifest에 `default_schedules`가 생겼다. 그래서 시험 설치는 scheduler를 켜고 한다(`apps/cli/test/ext-fixture.ts`). `garmin-tracer.test.ts`의 migration 기대값에 7을 더했다(지휘자 승인).
- 확장 role은 `brain.health_observations`를 읽을 수 없다. 그래서 걸음 수 발행 중복은 확장 표 `collect_published`로 판정한다.
- `garmin-import-verify.test.ts`는 간헐적으로 실패한다. baseline과 변경본을 각각 5회 단독 실행했고, 둘 다 3회 실패했다. 원인은 기존 `health_resolution_v1` 조회의 2초 `transaction_timeout`이다. 이번 변경과 무관하다(로그 `/tmp/garmin-{baseline,changed}-N-ctx51682.log`).
- Orca 재시작으로 구현자의 시험이 끊겼고, 시험 PG 클러스터에 `brain_ext_garmin` role이 남았다. 그 때문에 그 뒤 시험 설치가 role 충돌(`DB_UNAVAILABLE`)로 실패했다. 지휘자가 남은 role을 지운 뒤 대상 시험 13개가 통과했다.

## Plan Change Log

## Review Triage Log

### 2026-11-02 — Review pass (quick, Codex `gpt-6.1-sol`)

- verdicts: 4 findings — high 0, medium 3, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `collect.py`·`collect_store.py`: raw upsert와 걸음 수 발행이 별도 트랜잭션이다. 그 사이에 kill되면 final raw만 남고 걸음 수는 다시 발행되지 않는다. tracer `publish`의 원자성이 깨졌다. → 고쳤다. `user_summary` raw upsert, `collect_published`, 걸음 수 INSERT를 같은 `_write` 트랜잭션에 넣었고, 발행 실패 시 롤백되는지 시험을 더했다.
  - `[medium]` `[patch]` `0007_collect_runs.sql`·`collect_store.py`: `collect_published`가 비어 있어서, tracer가 발행한 revision을 다시 받으면 보관키 충돌로 수집이 실패한다. → 고쳤다. 0007이 `collect_state`를 `collect_published`로 옮긴다. 같은 revision을 다시 받아도 성공하는지 시험을 더했다.
  - `[low]` `[reject]` `collect.py:89-99`: 계정 매핑 전 첫 로그인이 실패하면 run 기록이 없어서 같은 날 retry가 다시 로그인한다. 설치가 인증 단계를 통과해야 예약이 생기므로 평소 사용에서는 드물다. 고치려면 계정 없는 인증 실패 상태를 새로 둬야 해서 받지 않았다.
  - `[medium]` `[patch]` `collect.py:98-113`: 진입표·계획을 `.session.lock` 밖에서 계산한다. collect와 retry가 겹치면 낡은 계획으로 재호출한다. 옛 collect는 단일 쓰기 잠금 안에서 판단부터 수집까지 했다. → 고쳤다. collect가 `.session.lock`을 먼저 잡고, 그 안에서 block·진입표·계획·수집을 한다. 세션을 열 때는 `lock_held`로 다시 잡지 않는다. 겹친 collect·retry 시험을 더했다.

## Design Notes

**대상 계정.** `account` 대상은 target_id를 계정으로 쓴다(시험·tracer 경로). `extension` 대상(예약·수동)은 `collect_targets`에 기록된 계정을 쓴다. 기록이 없으면 진입표 1행(block)을 확인한 뒤 세션을 연다. 로그인 profile의 `profile_id`를 기록하고 나서 coverage를 계산한다. 기록과 로그인 id가 다르면 `COLLECT_ACCOUNT_MISMATCH`이고, id가 없으면 `COLLECT_ACCOUNT_UNKNOWN`이다. 둘 다 retryable=false이고 쓰기는 0이다.
`[ASSUMPTION]` 계정 id는 epic 14 결정대로 로그인 profile id이고, 이전 dataset의 `userProfileId`와 같은 문자열로 비교한다.

**여러 dataset의 raw 전이.** coverage는 항목마다 같은 계정의 모든 dataset 행 중 `checked_at_ms`가 가장 늦은 행을 본다. 같으면 수집 dataset 행을 고른다. 수집 dataset에 행이 없고 이전 행만 있을 때 다시 받으면 다음과 같다.
- 원문이 같거나 NoData: 이전 행의 body·fetched_at·library_version을 복사한 새 행을 넣고, checked_at만 지금으로 한다.
- 원문이 다름: 새 원문으로 넣는다.

그러면 합쳐 본 값이 옛 `upsert_raw`와 같다. `[ASSUMPTION]`

**결과.** 결과는 다음과 같이 투영한다.
- success·no-op → `result`
- partial → `COLLECT_PARTIAL`(retryable=false; 재시도는 11:15 예약의 진입표가 한다)
- 차단 → 기존 코드
- 인증 → `LOGIN_REQUIRED`

`[ASSUMPTION]` partial을 retryable=false로 두는 이유는 감독자 자동 재시도가 옛 재시도 규칙과 별개로 같은 날 호출을 늘리지 않게 하기 위해서다.

**설정 대응**(옛 키 → 새 키 · 타입 · 기본값 · 검증):
- `tokenstore` → `garmin.tokenstore` · string · `~/.garmin-pipeline/tokens`(기존)
- `timezone` → `garmin.timezone` · string · 필수(기존)
- `date_pause_seconds` → `garmin.date_pause_seconds` · number · `5` · ≥0
- `call_pause_min_seconds`/`max` → `garmin.call_pause_min_seconds`/`garmin.call_pause_max_seconds` · number · `1`/`2` · ≥0, min≤max
- `max_dates_per_run` → `garmin.max_dates_per_run` · number · `10` · 정수 ≥3
- `max_rejected_attempts` → `garmin.max_rejected_attempts` · number · `3` · 정수 ≥1
- `max_consecutive_403` → `garmin.max_consecutive_403` · number · `3` · 정수 ≥1
- `lock_wait_seconds` → `garmin.lock_wait_seconds` · number · `60` · ≥0
- `cffi_api_session` → `garmin.cffi_api_session` · boolean · `false`

제외하는 키와 사유:
- `data_dir`: PG가 대신한다.
- `inbox_dir`: 16.5 body가 선언한다.
- `reports_dir`·`report_*`·`profile_path`: epic 18이 맡는다.
- `collect_time`/`retry_time`: 예약 시각은 manifest `default_schedules`(11:00/11:15)와 core 예약이 소유한다.
- `environment`·`db_path`: core 홈·DB가 대신한다.

`[ASSUMPTION]` 다음 둘은 core 무변경 조건 때문에 이렇게 정했다.
- "설정 단계 거부"는 core 설정 CLI의 미선언 키 거부와, worker가 시작할 때 하는 snapshot 검증을 합친 것이다.
- 예약 시각을 설정으로 바꾸는 기능은 없다.

**설치.** 실제 manifest에 `default_schedules`가 생기므로, scheduler 없이 설치하는 기존 시험 fixture는 `EXTENSION_SCHEDULER_UNAVAILABLE`로 멈출 수 있다. 이런 fixture는 core를 바꾸지 않고, scheduler를 켜거나 시험 복사본 manifest를 조정해서 맞춘다.

## Verification

**Commands:**
- `extensions/garmin/.venv/bin/python extensions/garmin/tests/check_settings.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_raw_transitions.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_collect_plan.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_session.py && extensions/garmin/.venv/bin/python extensions/garmin/tests/check_collect.py` -- expected: 모든 검사 통과
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-collect-resume.test.ts apps/cli/python-test/garmin-auth.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/install.test.ts` -- expected: 전부 통과, skip 0
- `pnpm test:python && pnpm test` -- expected: 기존 시험 회귀 없음

## Auto Run Result

**요약:** collect를 tracer(`user_summary` 하루)에서 옛 Garmin 전수 수집으로 넓혔다. 날짜 endpoint 11개와 활동 endpoint 4개를 받고, history_start, 실행당 10일 상한, 진입표(당일 block·재진입·auth_failed mtime·partial retry·no-op), 거부 상한, recent_lists, first-call을 옛 의미대로 옮겼다. raw는 같은 계정의 모든 dataset을 보고 판단하고, 쓰기는 새 수집 dataset 안에서만 한다. 쓰기는 항목마다 attempt 확인을 거치는 짧은 트랜잭션이다. 판단부터 수집까지는 `.session.lock` 안에서 한다. 결과는 ABI로 구분한다: `result`의 summary에는 status·cutoff_ms·local_date가 있고, partial·차단·인증은 서로 다른 오류 코드다. manifest에는 옛 `_DEFAULTS` 대응 설정, `garmin.collect`(11:00)·`garmin.collect_retry`(11:15) 기본 예약, `garmin.collect_recent`(수동)를 선언했다.

**바뀐 파일:**
- `extensions/garmin/manifest.json` — 설정 9개, work 셋, 기본 예약 둘, 오류 코드 셋
- `extensions/garmin/migrations/0007_collect_runs.sql` — 수집 run·fetch_error·meta·target·발행 기록 표, tracer `collect_state` 이관
- `extensions/garmin/src/collect_settings.py` — snapshot 공용 decoder(미선언 키·타입·범위·min≤max 검증)
- `extensions/garmin/src/collect_coverage.py`, `collect_rawparse.py` — 옛 coverage·rawparse·진입표·계획·first-call(순수 함수)
- `extensions/garmin/src/collect_store.py` — 계정 전체 coverage snapshot, raw 전이 upsert, run·error·meta·target 쓰기, 원자적 걸음 수 발행
- `extensions/garmin/src/collect.py`, `collect_client.py` — 실행 흐름, 대상 계정 해석, 진행·취소, 결과 투영, 설정·cffi 세션 전달
- `extensions/garmin/src/garmin_session.py` — pacing·403 상한·대기를 설정 인자로 받음, `lock_held`
- `extensions/garmin/src/auth.py` — 공용 설정 decoder 사용
- 시험:
  - `extensions/garmin/tests/check_settings.py`, `check_raw_transitions.py`, `check_collect_plan.py`(새 파일)
  - `check_collect.py`, `check_session.py`, `collect_fixture.py`
  - `apps/cli/python-test/garmin-collect.test.ts`(다시 씀), `garmin-collect-resume.test.ts`(새 파일), `garmin-tracer.test.ts`(migration 7)
  - `apps/cli/test/ext-fixture.ts`(scheduler를 켜고 설치)
- `_bmad/custom/bmad-orca-control.py` — 지휘자 도구를 새 Orca 출력 모양(`runId`, 평평한 worker-show, page 생략)에 맞춘 호환 수정. 이 스토리 기능과는 무관하고, 별도 커밋이다.

**리뷰:** Quick 1회에서 findings 4건(medium 3, low 1)이 나왔다.
- patch 3건: 걸음 수 발행 원자화, tracer revision 이관, session lock 안에서 판단
- reject 1건: 계정 매핑 전 첫 로그인 실패 기록. 드물고 고치려면 새 상태가 필요하다.
- deferred: [ASSUMPTION] 4건, 기존 import-verify 간헐 실패, 시험 role 잔여

**후속 리뷰 권고:** `true`. 첫 리뷰에서 medium patch가 3건이다. 확인되지 않은 위험은 두 가지다:
- session lock 재구성(판단~수집 전체 잠금, `lock_held`)과 원자 발행이 실계정 세션에서도 같게 동작하는지는 합성 client 시험으로만 확인했다.
- 계정 id 대응도 실계정 확인 전이다.

**검증(지휘자, patch 뒤):**
- Python check 6종(settings·raw_transitions·collect_plan·session·collect·auth) 통과
- `pnpm build` 뒤 대상 Vitest 5파일 13/13
- `pnpm test:python` 10파일 45/45
- `pnpm test` 170파일 3921 통과, 기존 skip 1

**남은 위험:**
- 실계정 호출은 하지 않았다(16.9).
- 실제 설치는 이제 데몬 scheduler가 있어야 예약 단계가 끝난다.
- 테스트 DB 정리 문제는 deferred에 남겼다.
