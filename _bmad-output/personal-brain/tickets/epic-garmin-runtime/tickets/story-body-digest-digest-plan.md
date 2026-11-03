---
title: 'body와 digest: 원본 보존과 건강 요약'
type: 'feature'
ticket: '5'
created: '2026-11-03'
status: 'built'
baseline_revision: 'be9c01c9df5df852f50f7f2a51c74beb5b2b612d'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      대형 raw snapshot batch가 1.9초 트랜잭션 제한을 넘을 가능성 (미검증)
    evidence: |-
      pass2 H4: 현재 25행 기준으로 나누며 body byte 크기는 제한하지 않는다. 실제 합성 대형 endpoint의 timeout 재현·바이트/시간 측정이 있어야 배치 예산 필요성을 확정할 수 있다. 원문 보존·2초 제한은 유지한다.
    location: >-
      extensions/garmin/src/collect_store.py:247
    severity: medium (unverified)
  - summary: >-
      토큰 계정 전환과 과거 target 산출 재실행에서 공유 body inbox의 귀속 가능성 (미검증)
    evidence: |-
      pass3 J5: 기본 단일 tokenstore/default mapping에서 재현되지 않았다. 서로 다른 계정의 수집 target을 만든 뒤 토큰을 전환하고 과거 artifacts를 재실행하는 합성 시나리오로 실제 오귀속 여부와 owner 계약 필요성을 확인해야 한다.
    location: >-
      extensions/garmin/src/body_runtime.py:133
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** 체성분 원본과 측정 출처를 안전하게 보존하고 전체 digest를 core에서 소비하는 산출 경로가 없다.

**Approach:** collect 뒤 artifacts 일감이 검증된 body와 합성 가능한 순수 digest를 만들고 파일 등록 및 건강 계약으로 발행한다.

## Boundaries & Constraints

**Always:** inbox·inbody 바로 아래 원본 참조, 필드별 source mtime 최대값(동률이면 새 값), 측정 행의 필드 mtime·원본 관계를 보존한다. 사용자와 epic 18 body_intake가 쓴 측정 JSON에 동일 계약을 적용한다. file_requests staging과 core 완료 확인 후에만 원본을 이동한다. core 건강 계약은 INSERT만, attempt 확인과 짧은 트랜잭션을 지키고 기존 기록·권위 v1은 유지한다. 합성 fixture/fake와 compose.test.yaml 시험 PG만 사용한다.

**Never:** 모델·실계정·운영 데이터를 호출하거나 기록하지 않는다. 그래프 구현과 epic 18의 평가·snapshot 필터는 범위 밖이다.

## I/O & Edge-Case Matrix

| 상황 | 입력 / 상태 | 결과 | 오류 처리 |
|---|---|---|---|
| body 병합 | 서로 다른 필드 mtime과 동률 | 필드별 최신 값과 출처 관계 유지, 동률은 새 값 | 유효한 다른 측정 보존 |
| 부정 JSON | NaN, Infinity, 중복 키 또는 잘못된 shape | 해당 측정 거부 | 다른 측정 삭제 금지 |
| 원본 인계 | 요청 후 core 확인 전 kill | 원본 제자리와 staging 보존 | 재시작하여 같은 요청으로 수렴, 완료 확인 뒤 processed 이동 |
| 늦은 intake | 이전 처리 뒤 body_intake 또는 사용자 측정 도착 | 같은 검증·mtime 규칙으로 반영 | 이전 유효 값 보존 |
| digest | manifest 시간대·cutoff·baseline, raw·활동·labels·body | 전체 순수 dict 및 day values | NULL은 0으로 치환하지 않음 |
| 재실행 | 동일 입력 및 revision | 건강 행·파일 요청 중복 없음 | 변경 입력은 새 revision, 이전 행 보존 |

</intent-contract>

## Code Map

- `extensions/garmin/src/digest.py`: `build`는 전체 dict, `day_values`는 day_summary/workout/exercise_log를 계산한다. 계산을 재사용하고 전체 결과를 별도로 검증한다.
- `extensions/garmin/src/normalize_runtime.py`, `normalize_store.py`, `health.py`: 계정 raw snapshot, day 발행·revision·attempt 검증과 catalog 변환을 재사용한다. 현재 runtime은 labels JSON을 직접 읽으므로 공통 loader 사용 시 원본 bytes hash 기반 revision도 유지한다.
- `extensions/garmin/src/labels.py`, `src/labels/exercise_types_ko.json`: 리소스와 loader가 이미 존재한다. normalize·digest와 후속 그래프가 같은 loader를 사용하도록 연결하고 패키징을 확인한다.
- `extensions/garmin/src/artifacts.py`, `analyses.py`: 안전한 상대 파일 읽기, 내구 staging, 결정적 locator, `brain.file_requests` INSERT와 `brain.file_request_results_public_v1` 완료 확인의 선행 패턴이다. import 전용 분류를 body 계약과 혼동하지 않는다.
- `extensions/garmin/manifest.json`, `collect.py`: supervised work ABI 및 collect 결과 경계. artifacts 종류와 collect 의존을 선언하고 진행·취소·오래된 attempt를 지킨다.
- `packages/postgres/migrations/0023_health_contract.sql`, `0026_health_json_comparison.sql`, `packages/core/schemas/health/v1/catalog.json`: 건강 catalog·current 계약. 필요한 지표만 호환 migration으로 추가한다.
- `extensions/garmin/scripts/legacy_normalize_oracle.py`, `tests/fixtures/normalize_v8/`, `tests/check_normalize_equivalence.py`: 격리 archive opt-in 기대값 생성과 고정 fixture 패턴. 현재 generator는 normalize만 검증하므로 전체 digest·weight-lifestyle 합성 기대값을 확장한다.
- `apps/cli/python-test/garmin-artifacts.test.ts`, `garmin-normalize.test.ts`, `apps/cli/test/ext-fixture.ts`: 임시 홈·설치된 감독자·파일 인계 및 current/멱등 PG 관찰 재사용. `extensions/garmin/tests/check_artifacts.py`는 staging 단위 경계만 입증한다.
- 옛 body/digest와 합성 시험은 `prep-garmin-absorption/inputs/garmin-source.tar.gz`의 `garmin-source/src/garmin_pipeline/` 및 `garmin-source/tests/test_body.py`, `test_digest.py`, `test_weight_lifestyle.py`를 참고한다. 실데이터 fixture는 사용하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] `extensions/garmin/src/` 및 `extensions/garmin/migrations/` -- body 입력 검증·필드별 mtime·원본 관계와 내구적 등록/확인/이동, kill 재개와 늦은 intake를 구현한다.
- [x] `extensions/garmin/src/digest.py`, 새 산출 entry와 `manifest.json` -- 수집 결과 id·UTC cutoff·시간대·현지 날짜·산출 revision을 가진 전체 digest JSON 파일 요청과 day values 건강 발행, collect 뒤 artifacts 의존을 구현한다.
- [x] `extensions/garmin/src/labels.py`, `normalize_runtime.py`, 패키징 -- 공통 loader를 연결하고 labels 변경을 revision에 반영한다.
- [x] `packages/core/schemas/health/v1/catalog.json`, `packages/postgres/migrations/` -- 누락 지표를 호환 방식으로 추가한다.
- [x] `extensions/garmin/scripts/legacy_normalize_oracle.py`, `extensions/garmin/tests/fixtures/`, `extensions/garmin/tests/check_digest_equivalence.py` -- 옛 합성 digest·weight-lifestyle 입력의 고정 기대 JSON을 opt-in으로 만들고 전체 dict 및 Matrix 경계를 독립 비교한다.
- [x] `apps/cli/python-test/garmin-body-digest.test.ts` -- 실제 감독자·시험 PG·core 파일 인계 경계와 Matrix를 검증한다.

**Acceptance Criteria:**
- Given 옛 digest·weight-lifestyle 합성 fixture와 고정 기대 JSON, When 새 순수 계산을 실행하면, Then sleep·day·workouts·recovery·body·weight·drinks를 포함한 전체 dict가 같고 cutoff·날짜 경계 및 NULL을 보존한다.
- Given 정상 collect 결과와 측정 JSON, When 설치된 artifacts 일감을 실행하면, Then 일 값이 core 건강 요약 current view에 보이고 동일 입력 재실행 시 건강 행·파일 요청 수가 증가하지 않는다.
- Given 필드별로 서로 다른 mtime 또는 같은 mtime의 원본들과 측정, When artifacts를 실행하면, Then 필드별 최신 값(동률은 새 값)·mtime·원본 관계가 보존된다. NaN·Infinity·중복 key·잘못된 shape 하나가 있어도 다른 유효 측정은 남는다.
- Given core 확인 전 동기화 hook에 도달한 artifacts worker, When 그 프로세스를 kill하고 재시작하면, Then 원본은 제자리에 남아 있다가 같은 요청으로 core 파일 등록이 완료된 후에만 processed로 이동한다.
- Given 이미 artifacts를 처리한 날짜와 이후 도착한 사용자 또는 body_intake 측정 JSON, When artifacts를 다시 실행하면, Then 같은 계약으로 새 측정을 한 번 병합한다.
- Given 정상 artifacts 실행, When core 파일 인계가 완료되면, Then 전체 digest JSON의 파일 바이트가 계산 dict와 같고 요청 metadata에 수집 결과 id·UTC cutoff·시간대·현지 날짜·산출 revision이 있으며 모델 호출은 0이다.

## Implementation Notes

2026-11-03 최종 좁은 patch: raw snapshot 경합 오류를 retryable로 투영하고 선행 결과 helper 필수 EXECUTE probe와 body_sources 경로 인덱스를 추가했다. 두 부모의 다른 snapshot을 실제 core 파일의 서로 다른 값·metadata로 검증하고 core 원본 파일 실패를 실제 ingest와 감독 작업의 비재시도 실패로 전달하는 시험을 추가했다. 독립 최종 patch 검토(`.brain-automation/final-patch-review.md`)가 5건 해결과 새 필수 공백 없음으로 확인했다.


2026-11-03 리뷰 수정 1: B2 이전 cutoff는 부모 성공 트랜잭션에 고정했고, B3/E1 processed occurrence에 mtime을 포함했다. B7/E2 기존 대기 부모의 followup을 설치·재사용 경로에서 보정했다. E3 shape 격리, B6 최종 파일 실패 비재시도, V1~V3의 정규 시험 연결과 확장간 격리, B5/I-A의 archive day_values→current 값·NULL/최신성, I-C의 18개 이름별 archive 합성 dict 비교를 추가했다. 세부 실행·fixture 대응표는 구현 보고 `.brain-automation/implementation-report-16-5.md`에 있다.
- 수정 후 전체 회귀 보고: Python 54건/프로젝트 3,926건 통과·1건 skip. 이후 실제 감독자 업그레이드 자동 실행 시험·typecheck를 추가 통과했다. 지휘자가 후속 리뷰·검증을 수행한다.
- 생성 bytecode는 소스가 아니므로 `.brain-automation/generated-bytecode-backup/`에 별도 보존했다. 추적된 캐시 한 파일만 HEAD 바이트로 복원하고 미추적 src cache는 백업으로 이동했다. 소스 변경은 그대로 유지했다.

2026-11-03: `runtime_artifacts.py`, `artifact_inputs.py`, `body.py`, `body_runtime.py`, `runtime_files.py`와 Garmin migration 0010을 추가했다. core migration 0028은 파일 metadata·선행 결과 조회·followup 등록을 확장한다. core manifest/queue/store·PG adapter 변경은 collect 성공 결과와 artifacts 의존을 실제 감독자 경로로 연결하기 위해 필요했다. catalog를 대조한 결과 필요한 day_summary/workout/exercise_log 지표는 이미 존재했다.

- archive SHA-256 `02cbaf47a5cca4a799fe42aa7d2eb988860b4395fd1ff9649439fffb87f56b25`의 격리 생성기로 두 합성 fixture의 전체 dict를 고정했다.
- 채택 가정: 선행 현지 날짜의 성공 cutoff가 없으면 운동 구간 시작은 이전 현지 날짜 11:00이다. 선행 결과가 있으면 실제 cutoff 최댓값을 사용한다.
- body 입력은 원본 mtime과 측정 mtime 일치를 검사하며, 등록 확인 후 이동과 중단 재개 및 원본 파일명 재사용을 처리한다. 늦은 intake는 날짜 처리 이력으로 걸러내지 않는다.
- 구현 보고의 최종 회귀: Python 50건 및 프로젝트 3,925건 통과·1건 skip. 지휘자 재검증과 독립 리뷰 결과는 아래에 별도 기록한다.
- 환경 복구: 중단된 이 checkout 합성 시험의 역할 잔여를 임시 홈 shim·DB 이름·프로세스/세션 부재로 확인해 해당 역할만 정리했다. 운영 DB는 사용하지 않았다.
- operator_actions: 없음. 실제 계정·운영 데이터·모델 호출을 수행하지 않았다.

## Plan Change Log

### 2026-11-03 — 재검토·수정 2
- H1/H2/H9/V3: 후보 검증과 실제 ingest의 provenance 적합성을 일치시키며, pending 원장의 이동 증거를 현재 경로보다 우선 복구한다. processed 이동 후 DB 기록 전·다중 원본 부분 완료·원래 경로에 새 파일 도착을 실제 PG 재개 경계로 검증한다.
- E1/E2: 목록/원본 읽기 race는 재시도 상태로 남기고 정상 측정은 격리 유지한다. H8/V1/V2/H10은 기존 정규 시험 목록 및 fixture의 직접 보강이다.
- KEEP: pass1에서 고친 cutoff 고정·같은 byte/newmtime 목적지·업그레이드 followup·정규화 current 최신성·18개 archive 사례·모든 기존 통과 경계를 보존한다. 소스는 삭제하지 않고 현재 코드에서 수정한다.

### 2026-11-03 — 재도출 1
- B2/B3/B5/B7/I-A/I-C/V1~3/E1~2가 원인이다. 구현 patch를 `.brain-automation/review-pass-1-preserved.patch`에 보존하고 아래 요구로 코드·시험을 재도출한다. 자동 승인 검토가 baseline 복원·미추적 파일 일괄 삭제를 원본 손실 위험으로 거부했으므로 현재 소스는 그대로 보존하며 같은 구현자가 제자리에서 재검토·수정한다. 원래 intent-contract는 유지한다.
- 이전 수집 경계는 부모 성공 시점에 존재하고 현재 cutoff보다 앞선 유효 결과로 고정해 재시도 시 변하지 않는다. 운동 NULL/배열/string shape는 항목 실패로 격리한다.
- processed 목적지의 occurrence 식별자에 원본 mtime을 포함해 동일 bytes 재접수 후 이동 완료/DB 기록 전 kill을 복구한다. 보존·이동 경계의 실행 시험을 정규 suite에 연결한다.
- followup 선언 업그레이드는 이미 대기/진행 중인 부모에도 자식과 의존성을 1회 생성한다. 신규/기존 ensureWork·설치의 일관성을 확인한다.
- 전체 digest는 수집 snapshot을 고정하지만 날짜별 건강 current는 기존 day_values의 최신 raw 의미를 유지한다. legacy 일 값의 구체 값·NULL을 core current에서 비교하고 과거 artifacts 재시도가 newer current를 되돌리지 않음을 검증한다.
- archive의 옛 digest/weight-lifestyle 합성 시험 사례 이름을 입력과 기대값에 대응해 전체 dict 동등성을 확장한다. 새 코드로 기대값을 생성하지 않는다.
- KEEP: 엄격 JSON·필드별 mtime·core 확인 후 이동, 원본 관계/late intake, 결정적 요청 및 metadata, labels byte hash, snapshot 및 attempt fencing, 이전 migration·권위 규칙 보존과 합성 시험 격리, 기존 통과 시험을 유지한다. 보존 patch를 출발점으로 재사용할 수 있다.

## Review Triage Log

### 2026-11-03 — 최종 좁은 patch 독립 확인
- verdicts: 신규 findings 0 — 지정 5건 해결 확인. raw 경합 재시도, 필수 helper 권한, 경로 인덱스, A/B 실제 core snapshot 구분, 실제 file failure의 ingest 전파를 원본·caller·assertion에서 독립 추적했다.
- pass3의 J9/J10/E1/V1/V2는 `.brain-automation/pass3-final-applied.diff`의 적용과 영향 시험으로 수정 완료했다. 마지막 검토는 `.brain-automation/final-patch-review.md`이며 미해결 필수 항목은 없다.
- 후속 리뷰 추가 권고: false. 이번 좁은 patch는 high 0, medium 4개·low 1개의 수정이며 구체 미검증 구현 위험은 최종 독립 확인으로 닫혔다. 두 미검증 권고는 단일 deferred 목록에 남긴다.

### 2026-11-03 — Review pass 3
- verdicts: 17 findings — high 0, medium 4, low 3, false 9, maybe-false 1
- findings:
  - `[false]` `[reject]` J1 달력 날짜의 SQL 변환 실패 — carried H6: 정상 collect는 date.isoformat과 검증한 설정을 출력한다. 날짜 정규식만으로 임의로 주입한 2월30일은 이 producer의 도달 가능한 출력이 아니다.
  - `[false]` `[reject]` J2 공개 summary가 빠진 성공 부모 — carried H5: 정상 collect success/noop는 zone/snapshot을 필수 출력한다. 임의 변조 프로세스의 ABI 출력이 요구하는 신규 실패 계약을 추가하지 않는다.
  - `[false]` `[reject]` J3 snapshot 파일과 최신 current의 입력 분리 — carried I-A: 기존 day_values의 최신 current와 고정 수집 파일은 구분한 API 계약이다. 해당 분리와 새 raw 후 최신 current 보존은 실제 시험으로 확인했다.
  - `[false]` `[reject]` J4 당일 weight에도 cutoff 샘플 필터 필요 — archive report_input._truncate도 stress/heartRate 배열만 자르며 daily_weigh_ins는 날짜별 마지막 유효값 계약이다. digest.weight_for의 옛 동작을 유지하는 것이 이번 동등성 요구다. 시각 기반 snapshot 조립·scrub의 추가 정책은 epic18 경계다.
  - `[maybe-false]` `[defer]` J5 공유 inbox의 다계정 귀속 가능성 — 기본 설치는 하나의 tokenstore와 default target-account mapping을 사용하며 계정 불일치는 collect에서 거부한다. 토큰계정 교체·서로 다른 target의 과거 수집 산출 동시 재실행에서 잘못 귀속되는 구체 경로는 미재현이다. if-true medium: 두 계정 전환을 격리 fixture로 재현해 owner 선택 계약이 필요한지 확인한다.
  - `[low]` `[reject]` J6 sidecar 거부 사유 공개 진단 — carried B9/H7: 입력 격리 요구는 충족한다. 새 사용자 진단 surface는 직접 결함 수정 이상인 운영 사용성 권고다.
  - `[false]` `[reject]` J7 누락 원본에 무기한 재시도 — 원본 미도착은 안전한 대기 상태이며 supervisor의 MAX_WORK_ATTEMPTS로 재시도가 제한된다. 일반 실패 기록·재시도 경로가 있으므로 무기한 반복이라는 주장은 성립하지 않는다. TTL·격리 UI는 새 정책이다.
  - `[low]` `[reject]` J8 snapshot 보존 정책 — carried B8/H3: 고정 산출 재현을 위해 immutable 원문을 보존한다. 중복 저장 비용과 retention 권고는 잔여 위험으로 보존하며 복잡한 수명 정책을 임의 추가하지 않는다.
  - `[low]` `[patch]` J9 body_sources source_path 조회 인덱스 — primary key 중간 fingerprint를 건너뛰는 dataset/source_path 조회가 있다. 동일 table에 인덱스 한 개를 추가하는 직접 보완으로 조회 비용을 줄인다.
  - `[medium]` `[patch]` J10 선행 조회 함수 필수 실행 권한 점검 누락 — 초과권한 예외에는 있지만 필수 helper checks에 없다. 기존 role probe helper 점검에 존재/EXECUTE를 추가하고 revoke/restore 경계를 검증한다.
  - `[medium]` `[patch]` E1 raw snapshot 재예약 경합 오류가 비재시도 — publish_days의 명시적 COLLECT_RAW_CHANGED는 동시 raw 갱신으로 도달 가능하다. runtime_artifacts의 오류 매핑에 ARTIFACT_DB_RETRY retryable=true를 추가한다.
  - `[medium]` `[patch]` V1 부모별 두 수집 snapshot 실제 digest 분리 검증 누락 — 검증 렌즈의 소비·검색 근거를 채택한다. 같은 계정 A/B의 전날 값이 다르고 A 산출이 지연된 실제 감독자/core 파일의 값·metadata를 확인한다.
  - `[medium]` `[patch]` V2 실제 body 원본 파일 실패의 ingest 전파 검증 누락 — 검증 렌즈의 실제 catch 경로 누락을 채택한다. core 요청 failed를 실제 _wait/_ingest로 전달하고 work failed·ARTIFACT_FILE_FAILED·비재시도·원본보존·측정/성공digest 없음 상태를 검증한다.
  - `[false]` `[reject]` I-A 파일과 최신 current의 동일 snapshot 해석 — carried pass2 I-A: 정상 current 최신성·고정 파일 snapshot이라는 분리 계약을 명시하고 실제 관찰했다. 과거 파일 snapshot으로 current를 되돌리는 해석은 채택하지 않는다.
  - `[false]` `[reject]` I-B 전체 dict와 대표 current 비교 범위 차이 — carried pass2 I-B: API별 동등성·legacy expected day_values PG 연결·16.4 전체 정규화 저장 검증이 상호 보완한다. 모든 pure dict 필드의 core 투영은 원문 요구가 아니다.
  - `[false]` `[reject]` I-C 원본 보존·재실행 표면 — 보고서 자체도 실제 제품 경계와 일치함을 기술한다. 코드상 결함이나 미충족 기준이 제시되지 않았다.
  - `[false]` `[reject]` I-D 미래 writer/consumer와 catalog 조건 — carried pass2 I-C: 동일 parser와 파일 metadata 인계가 이 티켓 경계다. catalog에 필요한 day 지표가 이미 있어 조건부 migration 추가가 필요 없음을 확인했다.

### 2026-11-03 — Review pass 2
- verdicts: 18 findings — high 1, medium 9, low 2, false 5, maybe-false 1
- findings:
  - `[medium]` `[bad_plan]` H1 검증 실패 후보가 latest_claim을 가로챈다 — 후보 선정은 일부 mtime 일치만 확인하므로 다른 필드 provenance가 부적합한 최신 sidecar가 유효한 재접수 원본을 가린다. 전체 후보 검증을 공유한다.
  - `[high]` `[bad_plan]` H2 이동/장부 기록 사이 중단 후 같은 경로 교체 시 영구 재시도 — pending source가 processed에 있지만 현재 경로를 먼저 읽어 옛 identity와 비교한다. 원장·이동 증거로 이전 occurrence를 먼저 복구하고 새 파일을 별도로 처리해야 한다.
  - `[low]` `[reject]` H3 snapshot 저장 비용 — carried B8: immutable 산출 재현을 위한 보존 비용은 실제다. 용량 장애가 입증되지 않았으며 참조 수명/retention 설계는 복잡성을 추가한다. 잔여 위험·운영 권고로 보존한다.
  - `[maybe-false]` `[defer]` H4 25개 raw snapshot batch의 1.9초 초과 가능성 — row 개수만 제한하는 사실은 확인했으나 실제 합성 대형 입력으로 시간 초과를 관측하지 않았다. if-true medium: 큰 endpoint bytes·실행시각과 statement timeout을 재현해야 배치 예산을 정할 수 있다. 일반 DB 일시 오류 분류의 시험은 별도로 추가한다.
  - `[false]` `[reject]` H5 잘못된 summary를 받은 collect가 성공한다 — publicCollectSummary는 불특정 ABI summary를 버리는 선택적 공개 투영이다. 이 제품 collect.result는 success/noop에서 zone/snapshot을 항상 포함하고 잘못된 summary를 생성하는 도달 경로는 제시되지 않았다. 임의 고장난 worker 입력을 새 계약으로 확장하지 않는다.
  - `[false]` `[reject]` H6 잘못된 달력·시간대 summary 의미 검증 — collect는 date 객체의 isoformat과 검증한 ZoneInfo 설정 및 현실 clock cutoff를 출력한다. 정상 producer에서 2월31일/가짜 zone이 출력되는 경로가 없다. 정규식만 보아 실제 producer가 만들지 못하는 상태를 결함으로 보지 않는다.
  - `[low]` `[reject]` H7 입력 거절 진단 부재 — carried B9: 부정 입력을 격리해 다른 측정을 보존하는 요구는 충족한다. 새 진단 payload·식별자·사유 API 추가는 운영 사용성 권고이며 현 AC 누락이 아니다.
  - `[medium]` `[patch]` H8 check_body 정규 실행 누락 — 기존 네 script 목록에 check_body만 없다. 목록 한 항목을 추가해 이미 통과한 필드별 과거/동률/provenance 검증을 정규 실행한다.
  - `[medium]` `[bad_plan]` H9 다중 원본 부분 완료 재개 시험 누락 — 서로 다른 mtime의 두 원본에서 한 원본 이동 후 중단한 실제 ingest/PG 경계가 없다. H2의 복구 보강과 함께 장부·바이트·관계·멱등을 검증한다.
  - `[medium]` `[patch]` H10 현지 날짜 및 DST 운동 window 시험 누락 — ZoneInfo를 사용하는 입력 선택의 날짜 경계 회귀는 UTC 단위 입력만으로 보장하지 못한다. 기존 순수 시험에 UTC와 현지 날짜가 다른 운동 및 DST 23/25시간 사례를 추가한다.
  - `[medium]` `[patch]` E1 sidecar 목록 stat 중 소실이 비재시도 오류 — scandir is_file 뒤 sorted key stat의 OSError가 루프 밖으로 나간다. 해당 transient race를 ARTIFACT_BODY_PENDING으로 분류하는 직접 guard와 동기화 시험을 추가한다.
  - `[medium]` `[patch]` E2 원본 읽기 중 BODY_CHANGED가 성공 누락된다 — validation except가 valid_sources만 false로 바꾸고 changed를 설정하지 않는다. BODY_CHANGED/OSError를 재시도로 반영하고 다른 정상 입력은 계속 처리한다.
  - `[medium]` `[patch]` V1 필드별 mtime 정규 실행 공백 — 검증 렌즈의 검색 근거 채택. H8과 같은 원인으로 check_body를 정규 목록에 등록한다.
  - `[medium]` `[patch]` V2 중복 key 시험이 잘못된 shape에 가려진다 — 검증 렌즈의 재현 근거 채택. 다른 조건과 원본이 모두 유효한 JSON의 values.weight_kg 중복을 넣어 측정/파일 요청이 늘지 않고 원본이 남는지 검증한다.
  - `[medium]` `[bad_plan]` V3 이동 뒤 장부 기록 전 재개의 소비 경로 공백 — 검증 렌즈의 실제 ingest 연결 누락 근거 채택. H2/H9와 함께 processed_path NULL·문서 미완료 상태를 실제 PG에서 재개해 같은 요청/완료를 검증한다.
  - `[false]` `[reject]` I-A 고정 파일과 최신 current 입력 분리 — pass1에서 명시한 기존 day_values/current 의미를 그대로 구현했다. 새 raw steps가 최신 current에 반영되고 파일은 기존 snapshot인 assertion이 추가되어 이전 검증 공백을 해소했다. 과거 snapshot으로 current를 되돌리는 별도 의미를 채택하지 않는다.
  - `[false]` `[reject]` I-B 전체 dict 비교와 두 current 지표 비교의 분리 — 전체 dict API와 날짜별 day_values는 별도 계약이다. 전체 legacy dict 20사례와 legacy day_values의 구체값/NULL 대표 PG 연결, 16.4의 normalize 전수 비교가 상호 보완한다. 전체 dict 모든 필드를 core 지표로 만들라는 요구는 없다.
  - `[false]` `[reject]` I-C body_intake 실제 writer와 epic18 소비 미실행 — 원문은 같은 JSON 읽기 계약과 파일 인계 제공을 요구한다. 실제 epic18 writer/consumer 구현은 별도 티켓이며 현재 writer 구분 없이 동일 parser를 사용한다.

### 2026-11-03 — Review pass 1
- verdicts: 20 findings — high 3, medium 10, low 2, false 5, maybe-false 0
- findings:
  - `[false]` `[reject]` B1 첫 fixture labels 누락 — 고정 input.json에 labels: {}가 있고 지휘자 check_digest_equivalence 실행이 통과했다.
  - `[high]` `[bad_plan]` B2 전일 cutoff가 미래·후발 결과로 변동 — previous_result 쿼리에 현재 cutoff 상한·부모 성공 당시 경계가 없어 지연/과거 재수집에서 창이 역전되거나 동일 부모 결과가 변한다. 부모별 이전 결과 경계를 고정한다.
  - `[high]` `[bad_plan]` B3 같은 바이트·경로의 새 mtime 이동 복구 실패 — _stored_name은 mtime을 제외하고 _recover_move는 최종 파일의 mtime을 요구한다. 새 occurrence 이동 후 DB 기록 전 kill이면 이전 파일이 복구를 막는다. occurrence를 목적지 식별자에 반영한다.
  - `[false]` `[reject]` B4 이동 실패 전 수락한 body 값이 발행된다 — 측정 병합 전에 모든 source request의 completed를 확인한다. 그 바이트와 provenance는 이미 core에 보존된 유효 측정이며 뒤의 경로 교체가 기존 측정 자체를 무효화하지 않는다. BODY_CHANGED는 재시도를 유지하며 새 바이트를 수락하지 않는다.
  - `[medium]` `[bad_plan]` B5 고정 파일 snapshot과 현재 건강 행 연결 검증 부족 — rebuild가 현재 raw를 읽는 사실은 확인했다. 날짜 전체 day_values/current는 최신 raw를 유지해야 하므로 과거 snapshot으로 current를 되돌리면 안 된다. 같은 입력의 legacy 일 값과 실제 current 값·NULL을 비교하고, 새 raw 후 과거 artifacts 재실행의 최신 current 보존을 명시·검증한다.
  - `[medium]` `[patch]` B6 최종 실패 file request의 무의미한 자동 재시도 — 동일 요청 삽입으로 failed file_import를 재개하지 않는데 ARTIFACT_FILE_FAILED를 retryable로 표기한다. 자동 재시도 가능 표기를 제거하고 core 실패 재시도 후 동일 요청 수렴을 검증한다.
  - `[medium]` `[bad_plan]` B7 업그레이드 전 대기 부모에 artifacts 누락 — ensureWork의 신규 INSERT 분기에만 자식이 생긴다. 설치 시 기존 미완료 부모 및 existing 재사용 경로에 의존 자식을 멱등 보장한다.
  - `[low]` `[reject]` B8 raw snapshot 중복 저장과 보존 정책 — 매 수집 시도 전체 snapshot을 보존하는 비용은 실제이나 immutable 재현·후속 epic 입력에 필요한 명시적 선택이다. 현재 용량 장애 근거가 없고 참조 수명·retention을 새로 설계하는 복잡성은 일상 결함의 직접 수정이 아니다. 잔여 저장 비용으로 공개한다.
  - `[low]` `[reject]` B9 잘못된 sidecar 무시 진단 부재 — 값을 지우지 않고 해당 입력을 건너뛰는 동작은 AC와 일치한다. 공개 진단 식별자·사유 API 추가는 직접 수정 이상이며 필수 거부 피드백 요구는 없다. 운영 사용성 권고로 남긴다.
  - `[false]` `[reject]` B10 diff에 pyc 파일 포함 — 검토 diff의 diff --git 목록과 git status에는 __pycache__/pyc 항목이 없다. 로컬 ignored cache의 존재를 변경 집합으로 오인했다.
  - `[medium]` `[bad_plan]` I-A 수집 snapshot과 day 건강 값의 외부 표면 연결 — 대표 current 행 존재만으로 값·NULL을 증명하지 못한다. B5와 같은 원인으로 legacy day_values 대비 실제 core current 값을 검사하고 최신 current의 의미를 보존한다.
  - `[false]` `[reject]` I-B body도 core 일 값에 포함해야 하는 넓은 해석 — 원문은 body 측정 원장/필드 mtime/원본 관계와 digest.day_values를 구분한다. day_values의 body 없는 계약을 재사용하며 body 수치의 별도 core 지표 발행은 요구되지 않았다.
  - `[medium]` `[bad_plan]` I-C 옛 digest·weight-lifestyle 입력 집합 동등성의 부족 — 두 대표 fixture만 있고 옛 시험의 stale completionStats·기간/평균·잘못된 shape/notes 등 사례 대응이 없다. archive 합성 시험을 조사해 이름별 fixture/기대값/실행 대응을 확장한다.
  - `[false]` `[reject]` I-D epic18 소비 자체 부재 — 이번 티켓은 파일과 metadata 제공까지이며 epic18 소비 구현은 원문 범위 밖이다. 파일 SHA/metadata/멱등은 실제 core 경로에서 검증한다.
  - `[medium]` `[bad_plan]` V1 cutoff 경계 Python 검사의 정규 회귀 미연결 — 검증 렌즈의 검색 근거를 채택한다. check_artifact_inputs를 설치 Python의 정규 pnpm test:python 실행에 등록한다.
  - `[medium]` `[bad_plan]` V2 이동 경쟁 Python 검사의 정규 회귀 미연결 — 검증 렌즈의 검색 근거를 채택한다. check_body_runtime를 정규 pnpm test:python에 등록하고 이동 후 기록 전 kill 재개도 추가한다.
  - `[medium]` `[bad_plan]` V3 다른 확장 선행 결과 제외 assertion 누락 — 검증 렌즈의 실제 소비/검색 근거를 채택한다. 두 확장과 cross-extension 간선에서 실제 반환 결과 격리를 검사한다.
  - `[high]` `[bad_plan]` E1 동일 바이트 새 mtime 이동 복구 — B3와 같은 원인. 이전 최종 파일이 새 occurrence 복구를 차단하는 경로를 재현해 수정한다.
  - `[medium]` `[bad_plan]` E2 기존 대기 collect 업그레이드 누락 — B7와 같은 원인. 선언 설치 전 부모를 만들고 설치 후 자식/간선 1개와 자동 실행을 검증한다.
  - `[medium]` `[patch]` E3 잘못된 summaryDTO shape가 전체 산출 중단 — summary.get 앞 dict 검사가 없고 AttributeError를 포착하지 않는다. shape를 검사해 해당 운동만 건너뛰고 정상 운동·다른 자료는 남긴다.

## Design Notes

파일 요청은 INSERT 성공과 core 완료를 구별한다. 원본 변경·재시작·늦은 입력이 있을 때도 등록한 바이트와 이동할 원본의 동일성을 확인하고, 기존 요청과 관계를 재사용한다. digest 기대값은 새 구현에서 생성하지 않고 archive의 격리 프로세스에서 opt-in으로 고정한다.

## Verification

추가 필수 검증: 위 재도출 항목의 회귀는 `pnpm test:python` 또는 `pnpm test`의 정규 수집 대상에 등록한다. archive 합성 입력 이름별 동등성 대응표와 실제 실행 결과를 남긴다. 임의 토큰·종료 attempt뿐 아니라 다른 확장 선행 결과도 제외돼야 한다.

**Commands:**
- `PYTHONDONTWRITEBYTECODE=1 pnpm test:python` -- 정규 Python integration과 body·cutoff·archive 경계 포함.
- `PYTHONDONTWRITEBYTECODE=1 pnpm test` -- 전체 프로젝트 회귀 및 typecheck.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-body-digest.test.ts apps/cli/python-test/garmin-preflight.test.ts apps/cli/python-test/garmin-review-boundaries.test.ts` -- 마지막 patch의 A/B snapshot·파일 실패·권한 revoke/restore.

- `pnpm install --frozen-lockfile` 및 `uv sync --frozen --project extensions/garmin` -- checkout 의존성 준비.
- `python3.14 extensions/garmin/scripts/legacy_normalize_oracle.py` -- 확장된 opt-in 생성기로 합성 기대값 생성; 기본 suite에서는 실행하지 않는다. archive 해시와 생성 결과를 기록한다.
- `extensions/garmin/.venv/bin/python extensions/garmin/tests/check_digest_equivalence.py` -- 전체 dict와 NULL·오류 경계 통과.
- `extensions/garmin/.venv/bin/python extensions/garmin/tests/check_artifacts.py` -- 기존 staging 경계 회귀 통과.
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-body-digest.test.ts apps/cli/python-test/garmin-artifacts.test.ts apps/cli/python-test/garmin-normalize.test.ts` -- 시험 PG에서 실제 파일 완료, kill/restart, late intake, metadata, current·멱등과 모델 0을 관찰.
- `pnpm test:python && pnpm test && git diff --check` -- 전체 회귀와 공백 검사 통과.

시험 DB harness는 `compose.test.yaml`의 127.0.0.1:54329 전용 인스턴스를 사용한다. 단위 staging 시험만으로 core 파일 완료나 kill 경계를 주장하지 않는다.

## Auto Run Result

상태: `built`. 구현·독립 리뷰·필수 검증을 완료했다. 사용자 인수 전이므로 done으로 올리지 않는다. 자기 브랜치 commit/원격 SHA는 최종 실행 보고에서 확인한다.

### 구현과 변경 파일
- `extensions/garmin/src/body.py`, `body_runtime.py`: 엄격 JSON·필드별 mtime/원본 관계·core 확인 후 이동·중단 및 다중 원본 재개.
- `extensions/garmin/src/artifact_inputs.py`, `runtime_artifacts.py`, `runtime_files.py`: 시간대·수집 snapshot·cutoff를 사용한 순수 digest와 core 파일/건강 행 산출, 결정적 요청·metadata.
- `extensions/garmin/src/collect.py`, `collect_store.py`: 성공 결과의 cutoff/시간대/날짜·고정 원문 snapshot 기록.
- `extensions/garmin/src/labels.py`, `normalize_runtime.py`: labels의 동일 바이트 snapshot 파싱과 revision hash 공유, 기존 최신 day_values/current 계약 유지.
- `extensions/garmin/src/role_probe.py`: metadata INSERT 및 선행 결과 helper의 필수 EXECUTE/초과 권한 검사.
- `extensions/garmin/manifest.json`, `migrations/0010_runtime_body.sql`: artifacts 선언·collect followup·body 원장·원문 snapshot·경로 인덱스.
- `extensions/garmin/scripts/legacy_normalize_oracle.py`, `tests/fixtures/digest_v8/`: archive 격리 프로세스로 생성한 기본/edge/18개 이름별 전체 dict와 core day_values 고정 기대값.
- `extensions/garmin/tests/check_{body,body_runtime,artifact_inputs,artifact_failure,digest_equivalence}.py`: mtime/엄격 JSON·이동 race·현지 날짜/DST·cutoff·오류 투영·옛 구현 전체 dict 비교.
- `apps/cli/python-test/garmin-body-digest.test.ts`, `garmin-review-boundaries.test.ts`, `garmin-preflight.test.ts`: 실제 감독자·시험 PG·core 파일의 kill 재개·late intake·A/B snapshot·최종 실패·권한 경계.
- `apps/cli/python-test/garmin-{pass2,tracer,upgrade}.test.ts`, `apps/cli/test/{install,setup}.test.ts`: 새 schema 및 기존 설치/upgrade 회귀; 느린 합성 tracer timeout 조정.
- `packages/core/schemas/extensions/v1/manifest.schema.json`, `src/extensions/{manifest,install}.ts`: 선언된 비순환 followup 읽기 및 설치.
- `packages/core/src/domain/work-item.ts`, `src/ports/store.ts`, `src/process-abi/codec.ts`, `src/queue/supervisor.ts`, `src/testing/fakes/store.ts`: 제한된 공개 결과 보존·선행 의존·fake 계약의 동일 동작.
- `packages/postgres/migrations/0028_file_request_metadata.sql`, `src/{extension-provision,extensions,migrate,work}.ts`: 요청 metadata·성공 결과와 직전 cutoff 고정·제한된 선행 결과 조회·신규/기존 부모 followup 보정.
- core/Postgres 관련 시험: manifest·ABI·supervisor·schema·migration·import 계약 및 retry·followup 결과/타확장 격리를 검증하고 schema 기대 버전을 갱신했다.
- 이 계획: 원래 수락 기준, 코드 지도, 전체 triage, 적용 가정·권고·검증과 제출 근거를 보존한다.

### 리뷰와 처분
공식 `full/thorough` 4렌즈를 3회 실행하고 마지막 한정 patch를 별도 Sol/medium이 독립 확인했다. 총 55개 finding을 개별 기록했다(high 4, medium 23, low 7, false 19, maybe-false 2). 중복 원인은 그룹으로 수정했으며 모든 high/medium과 직접 인덱스 보완을 완료했다. false 19건은 원문 도달성·기존 API 의미·실제 diff로 반증했고, low 6건은 새 진단/retention 정책의 복잡성 대비 현재 결함 근거가 없어 기각했다. 세부 근거는 각 Review Triage Log 행에 있다. maybe-false 2건만 단일 deferred 목록에 남긴다.

- 원문 보고: `.brain-automation/review-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}-pass1.md`(첫 edge/gap/intent 원본은 suffix 없는 파일에도 보존), 같은 `-pass2.md`, `-pass3.md`.
- 마지막 5건 해결 확인: `.brain-automation/final-patch-review.md`; 새 필수 결함 0.
- `followup_review_recommended: false`: 마지막 pass는 high patch 0이며 실제 수정 위험은 후속 독립 확인에서 닫혔다. 특정 미확인 구현 위험을 추가로 확인할 필요는 없다. 검증되지 않은 두 가능성은 완료를 막는 AC로 가장하지 않고 단일 deferred에 정확히 구별했다.

### Matrix 검증 대응
| Matrix 행 | 정규 실행 증거 |
|---|---|
| body 병합 | `check_body.py`: 필드별 과거값 거부·동률·mtime·provenance·입력 불변, `garmin-body-digest.test.ts`: 실제 원장/원본 관계 |
| 부정 JSON | `check_body.py` 및 실제 설치 통합의 shape가 정상인 중복key·NaN/Infinity·불량 mtime과 다른 측정 보존 |
| 원본 인계 | 실제 supervisor PID SIGKILL·core 미완료 원본 존재·같은 요청 재개 및 core 바이트/processed 확인; 다중원본 부분이동 장부 상태의 실제 ingest 재개 |
| 늦은 intake | 같은 parser로 늦은 sidecar 반영·필드 tie·원본명 재사용·반복 행수 불변 |
| digest | archive 기본/edge/18개 전체 dict 비교; 실제 A/B 부모별 core 파일 값·metadata; 현지 날짜/DST·cutoff; day_values의 current 값·NULL |
| 재실행 | core 요청·관측 행수 불변, 새 body/labels provenance는 새 digest revision, 최신 raw 뒤 과거 artifacts 재발행도 current 최신성 보존 |

### 가정·권고·잔여 위험
- 채택 가정: 이전 현지 날짜 성공 cutoff가 없으면 전일 11:00으로 운동 창을 시작한다. 존재하면 부모 성공 당시의 유효한 이전 cutoff를 고정한다.
- 고정 collect digest 파일과 날짜별 최신 raw 건강 current는 기존 `digest.build`/`day_values` API 의미를 구별한다. 옛 daily weight는 날짜별 마지막 유효값이며 추가 시각 scrub 정책은 epic18에서 다룬다.
- 미검증 권고 2건: 대형 raw snapshot batch의 1.9초 제한 가능성, 토큰계정/target 전환 시 공유 body inbox 귀속 가능성. 재현 조건·검증 방법은 frontmatter `deferred`에 있다.
- 운영 권고: immutable snapshot의 중복 저장 비용/retention, 부정 sidecar의 값 비노출 거절 진단. 신규 정책으로 임의 구현하지 않았으며 현재 필수 조건 이연은 아니다.
- `operator_actions: []`. 이 작업은 실계정·운영 데이터·모델 호출을 하지 않았다. 전용 compose 시험 PG만 사용했다.
- 원격 main은 기준 이후 자동화 런북/모음 문서만 바뀌어 소스 충돌은 없었다. main 병합·push는 중앙이 소유한다.
- 자동 승인 검토는 광범위 baseline 복원/비추적 삭제를 거부했다. 현재 소스를 보존하는 제자리 수정으로 전환했고 원본을 삭제하지 않았다. 생성 bytecode는 gitignored 실행 증거로 백업하고 제출에서 제외했다.

### 최종 검증 기록
- `pnpm install --frozen-lockfile`, `uv sync --frozen --project extensions/garmin`, archive opt-in 생성/고정 expected 재검증 통과.
- 지휘자가 마지막 patch 후 `extensions/garmin/.venv/bin/python -B`로 body/body_runtime/artifact_inputs/artifact_failure/digest_equivalence/artifacts/normalize_equivalence 7개 진입점을 모두 직접 실행해 통과했다. digest 기본/edge/18개 전체 dict 비교가 포함된다.
- 마지막 patch 전 지휘자 전체: Python 55건·프로젝트 3,926건 통과(1 skip). 마지막 patch 후 Python 정규 전체: 16파일 56건 통과.
- 마지막 patch 후 첫 프로젝트 전체: 170파일 통과/1파일 실패, 3,925건 통과/1건 실패/1 skip. 티켓에서 변경하지 않은 `packages/postgres/test/redaction.test.ts`의 MAINTAIN 회수 시험에서 미해결 실패 행수가 기대1/실제2였다. 소스/기대값을 변경하지 않고 같은 파일을 독립 재실행해 39건 통과했다. 전체 재실행은 171파일 3,926건 통과·1 skip으로 종료했고 `git diff --check`도 통과했다. 첫 실패의 원인은 재현되지 않아 소스나 기대값을 변경하지 않았으며 해당 실패·재실행 증거를 모두 보존했다.

- 최종 실행 로그: `.brain-automation/commander-python-postpatch.log`(56건 통과), `.brain-automation/commander-project-postpatch-recheck.log`(3,926건 통과·1 skip), `.brain-automation/commander-redaction-recheck.log`(미변경 파일39건 통과). 빌드·typecheck는 전체 명령에 포함되어 통과했다.
