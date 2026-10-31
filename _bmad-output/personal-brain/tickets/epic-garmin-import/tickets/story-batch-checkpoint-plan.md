---
title: '전수 반입과 원자 checkpoint 재개'
type: 'feature'
ticket: '4'
created: '2026-10-31'
status: 'built'
baseline_revision: '4601a1eb63581d62310781c3a788f75fece48c9a'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md
  - packages/core/schemas/health/v1/README.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 현재 importer는 tracer 한 행만 처리하며 전수 보존·checkpoint·충돌 영속·legacy 채널 연결이 없다.

**Approach:** 합성 다섯 후보의 모든 SQLite 표를 dataset별 원형으로 보존하고 catalog 건강 관측·권위 규칙 v1·legacy 이력을 함께 발행한다. 작은 트랜잭션마다 mapping과 checkpoint를 확정해 같은 batch 재실행·프로세스 중단·병렬 시작이 같은 결과로 수렴한다.

## Boundaries & Constraints

**Always:** 식별자는 dataset·원래 표·원래 키이며 batch는 포함하지 않는다. 모든 열·키·NULL·단위·raw TEXT·삭제된 activity_recovery와 선택되지 않은 대안을 보존한다. 정수 이력은 dataset별 UUIDv7이며 fetch_error→run도 같은 dataset이다. 데이터·mapping·checkpoint는 2초 안 트랜잭션에 함께 확정한다. source bytes fingerprint·schema·importer 버전을 고정하고 변경된 checkpoint 재사용을 거부하며 충돌을 영속화한다. 계정은 raw profile id의 단일값만 확인하고 권위는 manifest source의 D2→D1→D4→D5→D3이다. 정규화 버전·원래 수신 시각·미확인 의미를 지어내지 않는다. 자기 출처 INSERT·RLS·현재 attempt를 모든 쓰기/skip 경계에서 지킨다. 합성 fixture·격리 PG/홈만 사용하며 공개 결과는 집계·boolean·고정 오류만 보인다.

**Never:** 원본 migration/normalize·실데이터·운영 홈 접근, 기존 적용 migration 수정, 수집·모델·발신·channel_send 생성, 날짜 기반 notification/delivery 결합, gate의 성공 발신 변환, core의 Garmin 이름 분기, 무조건 ON CONFLICT DO NOTHING으로 차이 은폐, push·티켓 done·tickets.py mark를 하지 않는다. 파일 전수·분석 등록과 완성 import-verify는 후속 티켓이며 기존 tracer 파일 경로는 회귀 보존한다. 구현자는 소스·시험만 수정하며 계획 상태·커밋은 지휘자/엔진 소관이다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 보존 | schema10/15 다섯 후보·선택16 표·NULL·원문 | 모든 원래 표/열/키·건수·raw 바이트·recovery 보존 | 미지원 schema/불명 열은 고정 오류 또는 손실 없는 보존과 명시 보고 |
| 멱등·경쟁 | 같은/새 batch의 같은 키·같은 값, 두 프로세스 같은 batch | UUID·대상·mapping·checkpoint 중복 없이 수렴 | 잠금 경합은 재시도 가능 오류 |
| 재개 | 표 중간 commit 뒤 실제 프로세스 종료 | 종료 확인 후 checkpoint부터 이어 일회 실행과 같은 결과 | 미확정 단위 전부 rollback |
| 변경·충돌 | 같은 dataset/key 다른 값·snapshot bytes/schema/importer 버전 변경 | 기존 값 유지·영속 충돌·checkpoint 재사용 거부 | rollback 뒤에도 충돌 존속·고정 오류 |
| 관계 | 두 dataset의 같은 run/error/auth/delivery 정수 id | 다른 UUID·dataset-local run FK | 부모 부재를 조용히 누락하지 않음 |
| 건강·선택 | 겹치는 값·보관본 전용 BB·확인/미확인 계정·옛 버전 | catalog typed 값·단위·NULL·revision·권위 provenance와 현재/ambiguity | 근거 없는 시각/버전/계정 추정 금지 |
| legacy·권한 | notification/delivery·기존 conversation·stale/타 출처 attempt | 같은 conversation에서 한 번 조회·gate 의미·발신/인계/HTTP 0 | 연결 미설정/잘못된 UUID·권한 위반 실패 |

</intent-contract>

## Code Map

- `extensions/garmin/src/{reader,contract,capture_manifest,preflight,health,reports}.py` — 전수 read-only reader·schema 열 목록·정규화 v1 manifest·단일 profile 계정·권위 순서·catalog convert·안전 private/public 보고를 재사용한다. manifest fingerprint는 DB bytes를 포함하지 않아 별도 source hash가 필요하다.
- `extensions/garmin/{migrations/0001_tracer.sql,src/import.py,manifest.json}` — 현재 raw는 dataset 밖 account/key UNIQUE로 다섯 후보를 막고 mapping은 target_kind별이다. 다음 `0002_batch_import.sql`로 보존 표·열 metadata·checkpoint·충돌·권위 provenance를 추가하고 dataset 밖 UNIQUE를 제거한다. raw view 고정 열과 scope/key는 유지한다. 기존 tracer는 별도 모듈로 보존해 manifest capture가 설정된 import와 구분한다.
- `packages/postgres/migrations/{0022_import_contracts,0023_health_contract}.sql`, `packages/core/schemas/health/v1/catalog.json` — 건강 불변·source/attempt fence·catalog·typed 값·identity·현재 판정을 재사용한다. 다음 `0024_health_authority_import.sql`에서 권위 기록에 source work/token과 RLS·guard_import_attempt를 추가하고 확장 자기 출처 INSERT 열만 허용한다. core SELECT/UPDATE/DELETE는 늘리지 않는다. 기존 brain_app 규칙 작성은 호환한다.
- `packages/postgres/src/extension-provision.ts`, `extensions/garmin/src/role_probe.py` — 신규 권위 INSERT 허용 열/필수 권한을 서로 일치시키고 초과권한 검사를 유지한다. 새/기존 설치 모두 확인한다.
- `packages/postgres/migrations/0019_channel_legacy.sql`, `packages/core/src/channels/store.ts`, `packages/postgres/src/channels.ts` — legacy 두 표의 입력/불변 의미와 conversation FK·source attempt를 그대로 소비한다. extension에는 SELECT를 주지 않는다. brain 설정의 명시 `garmin.legacy_conversation_id`로 검증된 기존 봇/채팅 conversation UUID를 전달하며 실제 PG FK와 합성 새 이력의 동일 conversation 조회로 검증한다.
- `apps/cli/python-test/{garmin-tracer,garmin-preflight}.test.ts`, `apps/cli/test/ext-fixture.ts`, `extensions/garmin/tests/fixtures.py`, `packages/postgres/test/{health-contract,extension-permissions}.test.ts` — 실제 frozen 설치·감독자·claim/token·격리 DB·fake HTTP·finally 정리 기반이다. 기존 tracer의 단일 입력 동작을 유지하고 migration version 기대만 의도적으로 갱신한다.

## Tasks & Acceptance

**Execution:**
- [x] 단계 1 — `extensions/garmin/migrations/0002_batch_import.sql`, `src/{batch_import,import,reader}.py`, `manifest.json`, `tests/fixtures.py`, `apps/cli/python-test/garmin-batch-import.test.ts`: dataset별 모든 표 보존·schema metadata·UUID/FK·작은 원자 checkpoint·hash/version·충돌 영속·병렬 직렬화를 구현한다. 새 파일명은 동일 책임으로 세분할 수 있다. 표별 행/키/NULL/raw·동일 재실행 집중 시험 후 phase-ready로 보고한다.
- [x] 단계 2 — `extensions/garmin/src/{batch_import,health,preflight,import_preflight,role_probe}.py`, manifest, `packages/postgres/migrations/0024_health_authority_import.sql`, `packages/postgres/src/extension-provision.ts`, `packages/postgres/test/{health-contract,extension-permissions}.test.ts`, 신규 importer 시험: catalog 전수 관측·규칙 v1·선택/대안 provenance·보관본 전용 BB·legacy mapper와 conversation·source/attempt 최소권한을 완성한다. preflight 재개 정보도 실제 checkpoint를 반영한다.
- [x] 단계 3 — `apps/cli/python-test/garmin-batch-import.test.ts`, `extensions/garmin/tests/{fixtures,check_batch_import}.py` 및 관련 회귀: 실제 SIGKILL 동기화·종료 확인/재개·두 프로세스 동시 시작·fingerprint/schema/version 변경·영속 충돌·timeout rollback·stale skip-only·비발신·공개 비노출 행렬을 검증하고 전체 suite를 실행한다.

**Acceptance Criteria:**
- Given 합성 다섯 후보, When 설치된 확장을 공용 `brain ext run garmin import`와 실제 감독자로 실행하면, Then 표별 건수·자연키·열·NULL·원래 값·raw 바이트가 원본과 같고 동일 batch 재실행 후 모든 대상 행 수가 같다.
- Given 표 중간 checkpoint가 확정된 실제 importer 프로세스, When 해당 프로세스를 죽이고 종료를 확인한 뒤 같은 입력으로 재시작하면, Then checkpoint에서 이어 최종 값·행 수·mapping이 중단 없는 실행과 같으며 두 동시 importer도 같은 결과다.
- Given 같은 dataset/key의 원문 또는 source fingerprint/schema/importer 버전 변경, When 같은 batch를 재개하면, Then checkpoint 재사용이 거부되고 기존 대상은 불변이며 충돌 기록이 실패 후에도 조회된다.
- Given 같은 정수 id를 가진 여러 dataset과 보관본만의 BB, When 반입 결과를 조회하면, Then UUID는 서로 다르고 fetch_error는 자기 dataset run을 가리키며 BB는 보존되고 건강 현재 view에서 읽힌다. catalog 단위/typed 값/NULL·원래 normalization과 미확인 ambiguity도 일치한다.
- Given 합성 notification/delivery와 기존 Garmin 봇·채팅 conversation, When import를 두 번 실행하고 새 발신과 같은 conversation으로 이력을 조회하면, Then legacy 두 종류가 한 번씩 보이며 gate는 성공 발신으로 바뀌지 않고 channel_requests·channel_send·fake Telegram POST는 0이다.
- Given stale token 또는 타 출처/초과권한과 공개 표식 fixture, When 신규/skip-only 반입과 report를 관찰하면, Then 쓰기가 거부되고 공개 출력에는 private 계정·날짜·원문·해시·경로가 없다.

## Implementation Notes

- 단계1: 모든 원형 행·열 metadata·UUID/FK·행 단위 checkpoint와 기존 tracer 분기를 구현했다. 구현자 build 및 신규/기존 5개 시험 성공 보고를 확인했고 지휘자 신규 1개 시험도 성공했다. 원천 manifest fingerprint와 source-kind fence·독립 기대값·crash 검증 보완은 다음 단계에서 확인한다.

- 단계2: catalog 관측·권위 INSERT RLS/attempt·legacy 연결·원천 fingerprint/역할·source-kind 검사를 구현했다. 지휘자 집중 PG 시험 성공을 확인했다. 원천 연결 미확인 지표는 미발행 사유를 보존한다. 실제 CLI·감독자·중단/병렬·독립 mapping 전수 기대는 단계3에서 증명한다.

- 단계3 구현 보고: 실제 CLI/감독자·SIGKILL 종료 확인/재개·두 프로세스 동시 반입·timeout rollback·입력/계정/권위/conversation 변경 충돌·20개 합성 표·dataset-local FK·비발신을 구현했다. 지휘자 전체 기본 suite는 165파일 3899통과·기존1skip, 두 순수 Python 검사도 통과했다. 최종 Python suite를 독립 실행 중이다.

- 리뷰 수정 뒤 독립 전체 재검증도 성공했다: pnpm test 165파일3899통과·기존1skip, pnpm test:python 5파일18통과·skip없음, 두 순수 Python 검사 통과. 실제 누적 transaction timeout의 세션 소멸·rollback·재시도 가능과 정상 재개, WAL 거부·NUL PG 보존·초과권한 신규/skip 거부도 최종 suite에서 실행됐다.

## Plan Change Log

- 독립 Verify 완료: pnpm test는 build/typecheck 포함 165파일 3899통과·기존1skip, pnpm test:python은 5파일18통과·skip 없음이다. check_preflight.py/check_batch_import.py도 통과했다. 행렬 보존/관계/건강은 신규 첫 시험, legacy·공개/불변은 둘째, 재개/경쟁/변경/timeout/stale는 셋째와 권한 PG 시험으로 실행·통과를 대조했다. 원문 tracer 이동은 바이트 불변이며 기존 migration 시험 변경은 새 버전/목록/건수에 한정됨을 확인했다.

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 4 findings — high 1, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 반입이 초과권한 role을 검사하지 않는다 — check는 token/source만 검사하고 기존 probe_role은 preflight만 호출한다. 기존 최소권한 probe를 반입 시작에 적용했고 신규/skip-only 초과 SELECT 거부 회귀를 적용했다.
  - `[high]` `[patch]` main DB hash만으로 WAL의 확정 변경을 놓친다 — 합성 DB에서 main bytes 불변·reader의 WAL 변경 관측을 직접 재현했다. WAL이 있는 입력을 명시 거부하고 기존 checkpoint에는 wal_present 영속 충돌을 남긴다. immutable reader·주 파일/WAL 불변과 실제 commit된 변경의 거부 회귀를 적용했다.
  - `[medium]` `[patch]` 연결 종료 뒤 finally unlock이 원래 오류를 덮고 재시도 불가로 분류한다 — 무조건 unlock과 SQLSTATE 없는 OperationalError 누락을 기존 tracer 처리와 대조했다. 닫힌 연결 unlock 생략·원래 예외 보존·일시 OperationalError 재시도 분류를 적용했다. 각 SQL 0.8초의 누적 transaction timeout에서 세션 PID 소멸·rollback·재시도 가능·후속 재개를 검증했다.
  - `[medium]` `[patch]` NUL 포함 TEXT 인코딩이 jsonb 저장 경계에서 실패한다 — encoded는 그대로의 TEXT를 넘기며 PostgreSQL jsonb가 NUL escape를 거부한다. 원래 TEXT 타입을 유지하는 UTF-8 base64 표현과 실제 PG 저장·재실행 회귀를 적용했다.


## Design Notes

- route는 pinned full이며 데이터 손실 위험 high다. 실제 HEAD 조사로 tracer·legacy·health 계약을 확인했다. 14.3의 정규화 manifest·source 역할·안전 보고·원본 불변 경계를 이어받는다.
- 보존 형식은 원래 표/키/열 metadata와 타입을 잃지 않는 행을 갖추며 raw는 별도 TEXT로 유지한다. 건강 catalog에 없는 표/열도 보존한다. 원래 키 순서를 고정하고 source 해시/버전과 함께 checkpoint를 고정한다. 각 단위에서 실제 attempt를 검사하고 dataset/batch 잠금으로 경쟁을 직렬화한다. 충돌은 별도 확정하여 오류 rollback에 없어지지 않는다.
- catalog publish는 원래 normalize_version이 없거나 원천 수신 시각 연결이 불명확하면 보존 자료와 명시 미발행 사유를 남기고 근거 없는 관측을 만들지 않는다. 확인 가능한 행은 catalog 전체 mapping을 발행한다. dataset 단독 BB는 같은 dataset/day raw 연결로 원래 fetched/revision을 얻는다. 원본 열·단위·NULL은 항상 보존한다.
- 권위 INSERT 확장은 AD-30의 자기 출처 INSERT 계약에 맞춘 신규 core 계약 변경이다. RLS·work-kind 출처·현재 attempt·불변 trigger·허용 열을 모두 갖추며 일반 core 권한을 열지 않는다. 선택 provenance는 확장에 영속화한다. raw view는 여러 dataset의 원형을 보이고 건강 현재 view는 권위 규칙으로 고른다.
- 기존 tracer의 파일·분석 처리는 호환 경로로 남기고 새 capture 반입은 DB 표를 담당한다. evaluation 등 분석 자료도 원형 표로 보존하고 분석/파일 등록은 14.5가 맡는다. 사람 외부 작업이 필요한 AC는 없다.

## Verification

**Commands:**
- `pnpm build` — 빌드 성공.
- `pnpm typecheck` — 타입 검사 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_preflight.py` — reader/preflight 회귀 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_batch_import.py` — 추가 순수 mapping/키/hash 행렬 성공.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-batch-import.test.ts` — 실제 설치·공용 CLI·감독자·PG·kill/restart·병렬·충돌·legacy 비발신 성공.
- `pnpm test` — 기본 전체 suite 성공.
- `pnpm test:python` — Python 전체 suite 성공, 신규 skip 없음.

실제 시험 이름·실행 결과는 구현 뒤 기록한다. fixture extHome/globalSetup으로 격리 PG/Brain 홈을 만들고 실제 프로세스 PID와 checkpoint 관찰로 kill 지점을 동기화한다. exit를 확인한 뒤 재개하고 finally에서 자식·daemon abort/종료·store·DB·marker role·임시 홈을 정리한다. 실데이터·운영 접근은 없다.

## Auto Run Result

Status: built

다섯 후보의 DB 표를 원래 타입·키·NULL·raw TEXT와 함께 dataset별로 보존하고 UUID/FK·원자 checkpoint·동일 입력 재실행·동시 재개·입력 변경 영속 충돌을 구현했다. catalog 건강 관측과 권위 규칙 v1, 기존 conversation의 legacy 이력을 연결하며 반입 중 발신 요청·channel_send·HTTP 발신은 0이다. 원문·정규화 근거 없는 관측은 원형과 미발행 사유를 남긴다.

변경 파일:
- `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-batch-checkpoint-plan.md` — 계획·검증·리뷰 판정·최종 결과를 기록한다.
- `apps/cli/python-test/garmin-batch-import.test.ts` — 원형 전수·실제 CLI/감독자·중단/동시 재개·충돌·권한·WAL/NUL·세션 종료를 검증한다.
- `apps/cli/python-test/garmin-preflight.test.ts` — 새 Garmin migration 버전에 맞춘 준비 실패 회귀를 유지한다.
- `apps/cli/python-test/garmin-tracer.test.ts` — 두 Garmin migration의 설치 ledger를 확인한다.
- `apps/cli/test/install.test.ts` — 설치 schema 24 기대를 갱신한다.
- `apps/cli/test/setup.test.ts` — 설정·설치 결과 schema 24 기대를 갱신한다.
- `extensions/garmin/manifest.json` — capture/tracer 분기와 명시 legacy conversation 설정을 선언한다.
- `extensions/garmin/migrations/0002_batch_import.sql` — 원형·schema metadata·checkpoint·충돌·권위/legacy provenance와 source fence를 만든다.
- `extensions/garmin/src/batch_import.py` — 원자 행 반입·UUID/FK·멱등/재개·영속 충돌·건강/legacy·안전 실패를 구현한다.
- `extensions/garmin/src/health.py` — catalog별 원천 endpoint와 정규화 근거를 연결해 typed 관측을 만든다.
- `extensions/garmin/src/import.py` — capture와 기존 tracer를 분기한다.
- `extensions/garmin/src/import_preflight.py` — 실제 checkpoint와 미발행 사유를 private 보고서에 기록한다.
- `extensions/garmin/src/reader.py` — WAL 입력을 거부하고 immutable read-only snapshot을 읽는다.
- `extensions/garmin/src/role_probe.py` — 권위 계약의 최소 INSERT 허용 열을 대조한다.
- `extensions/garmin/src/tracer_import.py` — 기존 tracer 동작을 바이트 변경 없이 별도 모듈로 보존한다.
- `extensions/garmin/tests/check_batch_import.py` — 독립 literal 타입·NUL 인코딩·archive catalog 소유권을 검증한다.
- `extensions/garmin/tests/fixtures.py` — 20개 합성 표·FK·보관본 BB·legacy·NUL 입력을 만든다.
- `packages/postgres/migrations/0024_health_authority_import.sql` — 불변 권위 기록에 자기 출처 INSERT RLS와 현재 attempt를 적용한다.
- `packages/postgres/src/extension-provision.ts` — 권위 INSERT의 열 권한을 신규/기존 확장에 제공하며 초과권한을 거부한다.
- `packages/postgres/src/migrate.ts` — core schema 버전을 24로 올린다.
- `packages/postgres/test/extension-permissions.test.ts` — 권위의 자기 출처·현재 token·읽기/수정 거부와 재provision을 검증한다.
- `packages/postgres/test/import-contracts.test.ts` — 권위 작성에 token을 요구하는 고정 오류를 확인한다.
- `packages/postgres/test/migrate.test.ts` — 신규 migration과 기존 자료·checksum 보존 기대를 갱신한다.
- `packages/postgres/test/store.test.ts` — 소유자별 schema 최대 버전 기대를 갱신한다.
- `packages/postgres/test/work-store.test.ts` — 감독자에 전달하는 core schema 기대를 갱신한다.

리뷰: quick 한 렌즈, 총 4건(high 1·medium 3)을 모두 patch했다. WAL 무감지, 초과권한 검사 누락, 연결 종료 오류 분류, NUL TEXT 저장을 수정했다. defer 0·reject 0이며 기각 사유는 없다. followup_review_recommended: true — WAL 부재 확인 직후 sidecar가 생기는 동시 변경 경계는 별도 독립 재검토를 권고한다. 이번 합성 검증은 이미 존재하는 WAL commit의 명시 거부와 원본 불변을 입증했으며 실제 private capture의 전수 품질은 후속 14.8에서 확인한다.

최종 독립 검증:
- `pnpm test` — build/typecheck 포함 성공, 165파일3899통과·기존1skip.
- `pnpm test:python` — 성공, 5파일18통과·skip없음. 새 batch 통합 시험 3개를 포함한다.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_preflight.py` — 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_batch_import.py` — 성공.
- `git diff --check` — 성공.

행렬의 보존·관계·건강·legacy·공개 비노출·원본 불변·중단·경쟁·변경 거부·권한을 실행된 시험과 대조했다. 실제 누적 transaction timeout에서는 각 SQL 0.8초의 총합으로 확장 세션 PID 소멸, rollback, 재시도 가능 오류와 후속 정상 재개를 확인했다. 순수 인코딩 검사에 그치지 않고 NUL TEXT의 실제 PG 저장·재실행을 확인했다. 앞선 회귀 중 기존 schema 번호 기대와 병렬 부하 실패는 최종 독립 전체 성공으로 해소했고, 단일 statement timeout을 세션 종료로 과장한 초기 보고는 정정했다.

실데이터·운영 홈·배포·push는 수행하지 않았다. 외부에서 사람만 수행할 AC는 없으며 operator_actions는 필요하지 않다. 티켓 done과 tickets.py mark를 수행하지 않으며 최종 완료 판정은 오케스트레이터 소관이다.

정리 결과: 자기 Orca Run의 조사·구현·quick 리뷰 워커 세 개 모두 정식 succeeded 보고 전문을 수락하고 release했다. 최종 목록은 completed/released 3개이며 active·reclaimable·다음 페이지와 미처리 Delivery는 없다. 생성 Python cache는 제거했다. 제어 셸의 미실행 따옴표 입력 대기는 입력 취소 뒤 동일 key·payload의 스크립트로 복구했고, transcript source_changed는 관찰 오류로 보존했으며 실제 구현 실패로 세지 않았다. 중복 워커·강제 취소·kill은 없었다. 최종 커밋과 HALT checkpoint를 저장한 뒤 자기 전용 제어 셸만 마지막에 닫는다.
