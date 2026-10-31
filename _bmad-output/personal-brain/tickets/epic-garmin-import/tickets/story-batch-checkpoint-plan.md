---
title: '전수 반입과 원자 checkpoint 재개'
type: 'feature'
ticket: '4'
created: '2026-10-31'
status: done
baseline_revision: bf521ea0b762cefea22abdf46bc60c00b4e96b8c
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 1
followup_review_recommended: false
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


### 2026-11-01 추천 결정: NUL 원문과 필수 투영

E14-2/E14-3 및 AD-30의 SQL 물리 text/7열 고정은 이 결정으로 확장한다. 전수 원형 보존과 필수 논리 조회는 줄이지 않는다. PostgreSQL text/jsonb는 실제 NUL을 담지 못한다. 정상 Unicode TEXT는 논리 원문 UTF-8로 왕복하고, SQLite snapshot 파일의 원래 바이트와 fingerprint를 별도로 보존한다. 비정상 TEXT나 다른 SQLite 인코딩의 원래 값도 손실 없이 보존할 수 있도록 원래 타입·바이트·인코딩을 추출하고 복원한다. 이를 이미 지원한다고 주장하거나 조용히 대체·누락하지 않는다.

- 자유 원천 TEXT는 NUL 없는 text와 nullable 원문 bytea 짝으로 저장한다. NUL 시 표시 text는 U+FFFD이며 원문 bytea가 권위다. NULL/빈값/실제 NUL/U+FFFD/문자열 `\u0000`은 구별하고 일관성·엄격 디코딩을 검증한다. 제어 식별자·권한 판정값은 원천 자유 필드와 분리한다. 표시값을 identity, UNIQUE, 원문 비교나 해시로 사용하지 않는다. 키는 타입을 포함한 가역 canonical 원문과 실제 바이트 비교를 사용한다.
- 기존 v1과 구분되는 공통 버전 raw view를 manifest와 Core에서 협상한다. 원문 짝과 dataset provenance를 전달하고 Core는 복원해 논리 필드를 제공한다. 동일 계정의 서로 다른 dataset과 slash 포함 scope/key도 충돌 없이 각각 식별하고 원래 키를 보존한다. 손실된 v1을 정확한 원문으로 가장하지 않으며 Core에 Garmin 분기를 넣지 않는다.
- legacy의 모든 원천 자유 문자열과 건강 text/JSON 값·중첩 객체 키도 같은 원칙으로 보존·복원한다. JSON 키 치환으로 서로 다른 키를 합치지 않는다. 원본 JSON을 재직렬화하거나 파생 손실 값을 exact 원문으로 노출하지 않는다. 복원 후 명시 DTO만 내보내 raw 짝을 제거하고, 가림이 필요한 출력은 복원 후 가린다. 공개 import 보고는 집계·boolean·고정 오류만 유지한다.
- 기존 migration은 수정하지 않고 후속 migration, 모든 batch/tracer 및 Store writer, Core reader, manifest, provisioning 허용목록과 role probe를 함께 갱신한다. RLS·attempt fence·최소권한·같은 conversation·발신 금지와 원자 transaction을 유지한다. 계정·dataset·source 자유값과 제어값의 표현 및 identity 경계를 명시하고 NUL 때문에 필수 행을 버리지 않는다.
- codec·projection·canonical key 순서·catalog의 버전 또는 fingerprint를 checkpoint에 고정한다. 기존 checkpoint를 덮거나 자동 reset하지 않는다. 기존 mapping도 skip의 충분한 증거가 아니므로 각 필수 대상의 원문·FK·버전을 확인해 누락만 보충하는 명시적 reconciliation을 구현한다. 같은 tracer 원문과 metadata는 재사용하고 차이는 기존 값을 보존하며 conflict를 영속화한다. source snapshot·충돌·checkpoint 검증과 stale attempt 거부를 유지한다.

실행은 단계별 phase-ready와 검증으로 나눈다: (1) reader 원형·타입·인코딩 및 canonical identity, (2) migration·공통 raw/legacy/건강 codec과 권한, (3) writer·Core 복원 및 기존 대상 reconciliation, (4) 전체 계약 검증과 독립 리뷰. 보존한 `story-batch-checkpoint-plan.patch`를 읽어 tracer 재사용과 8개 제한 병렬 수정의 의도를 반영하되 현재 트리에 적용됐다고 가정하지 않는다. 이전 성공은 보존 patch 상태의 증거이며 최종 트리 통과가 아니다.

필수 검증: 실제 NUL/U+FFFD/escape/NULL/빈값과 UTF-16·비정상 TEXT 원형; raw body·키·account·legacy·건강 JSON 중첩 값 및 키; dataset identity와 slash 충돌; 동일·상이 tracer와 mapping 존재/대상 누락; 구 checkpoint 버전 거부 및 reconciliation; 중단·재개·경합·stale attempt; 재provision/probe·RLS와 비발신; raw DTO 누출·가림; 격리 PG/홈 전체 suite 및 Python 검증. 검사자 두 명의 정적 코드·반례 대조는 `~/.local/share/second-brain-loop/14.4-nul-research.md`와 `~/.local/share/second-brain-loop/14.4-nul-verification.md`에 있다. 이들은 실행 시험이 아니다.

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

- 2026-11-01 재개 단계1: SQLite 저장 타입·원래 TEXT 바이트·DB encoding을 읽고 canonical 표현에 포함했다. UTF-8/UTF-16 LE·BE, NULL/빈값/NUL/U+FFFD/escape, 비정상 TEXT 집중 검사 `check_reader_bytes.py`를 지휘자도 실행해 성공했다. downstream 복원·migration·reconciliation과 전체 검증은 다음 단계로 남는다.
- 2026-11-01 재개 단계2: 후속 Garmin 0003·core 0025와 공통 원문 codec, raw v2·legacy·건강 원문 짝, 재provision·probe 허용목록의 변경을 확인했다. 워커가 격리 PG 108개·기존 tracer 4개 통과를 보고했다. SQL 짝 제약은 NULL 동치·허용 encoding·표시값 존재를 검사하며 엄격 디코딩·표시 일관성의 독립 보장은 아니다. 전체 writer/Core와 identity·reconciliation 검증은 단계3·4에서 수행한다.

- 단계1: 모든 원형 행·열 metadata·UUID/FK·행 단위 checkpoint와 기존 tracer 분기를 구현했다. 구현자 build 및 신규/기존 5개 시험 성공 보고를 확인했고 지휘자 신규 1개 시험도 성공했다. 원천 manifest fingerprint와 source-kind fence·독립 기대값·crash 검증 보완은 다음 단계에서 확인한다.

- 단계2: catalog 관측·권위 INSERT RLS/attempt·legacy 연결·원천 fingerprint/역할·source-kind 검사를 구현했다. 지휘자 집중 PG 시험 성공을 확인했다. 원천 연결 미확인 지표는 미발행 사유를 보존한다. 실제 CLI·감독자·중단/병렬·독립 mapping 전수 기대는 단계3에서 증명한다.

- 단계3 구현 보고: 실제 CLI/감독자·SIGKILL 종료 확인/재개·두 프로세스 동시 반입·timeout rollback·입력/계정/권위/conversation 변경 충돌·20개 합성 표·dataset-local FK·비발신을 구현했다. 지휘자 전체 기본 suite는 165파일 3899통과·기존1skip, 두 순수 Python 검사도 통과했다. 최종 Python suite를 독립 실행 중이다.

- 리뷰 수정 뒤 독립 전체 재검증도 성공했다: pnpm test 165파일3899통과·기존1skip, pnpm test:python 5파일18통과·skip없음, 두 순수 Python 검사 통과. 실제 누적 transaction timeout의 세션 소멸·rollback·재시도 가능과 정상 재개, WAL 거부·NUL PG 보존·초과권한 신규/skip 거부도 최종 suite에서 실행됐다.

## Plan Change Log

- 독립 Verify 완료: pnpm test는 build/typecheck 포함 165파일 3899통과·기존1skip, pnpm test:python은 5파일18통과·skip 없음이다. check_preflight.py/check_batch_import.py도 통과했다. 행렬 보존/관계/건강은 신규 첫 시험, legacy·공개/불변은 둘째, 재개/경쟁/변경/timeout/stale는 셋째와 권한 PG 시험으로 실행·통과를 대조했다. 원문 tracer 이동은 바이트 불변이며 기존 migration 시험 변경은 새 버전/목록/건수에 한정됨을 확인했다.

- 2026-11-01 실행1 재계획: 리뷰의 JSON 동등성·단독 surrogate 반례 때문에 실행 항목과 기존 행의 읽기 전용 비교 설계를 보완했다. 원문 바이트를 논리 동등성으로 쓰는 상태와 SQL 인코딩 실패로 필수 행을 누락하는 상태를 피한다. KEEP은 기존 커밋·원형·identity·권한·reconciliation·비발신과 채널 시계/기존 assertion·timeout이며 intent-contract를 유지한다.

## Review Triage Log

### 2026-10-31 — Review pass
- verdicts: 4 findings — high 1, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 반입이 초과권한 role을 검사하지 않는다 — check는 token/source만 검사하고 기존 probe_role은 preflight만 호출한다. 기존 최소권한 probe를 반입 시작에 적용했고 신규/skip-only 초과 SELECT 거부 회귀를 적용했다.
  - `[high]` `[patch]` main DB hash만으로 WAL의 확정 변경을 놓친다 — 합성 DB에서 main bytes 불변·reader의 WAL 변경 관측을 직접 재현했다. WAL이 있는 입력을 명시 거부하고 기존 checkpoint에는 wal_present 영속 충돌을 남긴다. immutable reader·주 파일/WAL 불변과 실제 commit된 변경의 거부 회귀를 적용했다.
  - `[medium]` `[patch]` 연결 종료 뒤 finally unlock이 원래 오류를 덮고 재시도 불가로 분류한다 — 무조건 unlock과 SQLSTATE 없는 OperationalError 누락을 기존 tracer 처리와 대조했다. 닫힌 연결 unlock 생략·원래 예외 보존·일시 OperationalError 재시도 분류를 적용했다. 각 SQL 0.8초의 누적 transaction timeout에서 세션 PID 소멸·rollback·재시도 가능·후속 재개를 검증했다.
  - `[medium]` `[patch]` NUL 포함 TEXT 인코딩이 jsonb 저장 경계에서 실패한다 — encoded는 그대로의 TEXT를 넘기며 PostgreSQL jsonb가 NUL escape를 거부한다. 원래 TEXT 타입을 유지하는 UTF-8 base64 표현과 실제 PG 저장·재실행 회귀를 적용했다.


### 2026-11-01 — Review pass
- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[intent_gap]` NUL 포함 TEXT의 raw/legacy 공개 투영과 고정 계약이 양립하지 않는다 — `batch_import.py:150-161`의 PostgreSQL text 대상은 NUL을 받지 않으며 encoded 원형 보존만으로 raw view와 legacy 조회를 충족하지 못한다. health의 미발행 사유만으로 raw/legacy 필수 투영을 생략할 권한은 없다. 구현자의 명시적 질문으로 같은 결론을 대조했고 계약을 임의 축소하지 않는다. 시도한 변경은 `story-batch-checkpoint-plan.patch`에 저장하며 이번 세션의 소스 변경만 되돌린다. 이전 커밋은 보존한다.
  - `[medium]` `[patch]` 기존 tracer raw와 capture 전수 반입의 동일 키 충돌 — `0001_tracer.sql`의 raw PK는 유지되는데 새 importer가 preserved mapping만 조회하므로 기존 raw를 발견하지 못한다. 모든 열을 대조해 동일 값을 재사용하고 차이는 영속 conflict로 처리하는 최소 수정 대상이다. 앞선 intent_gap이 우선하므로 부분 수정은 패치에 보존한 뒤 되돌리며 완료로 주장하지 않는다.

### 2026-11-01 — 재개 Review pass
- verdicts: 7 findings — high 3, medium 4, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 건강 JSON의 리터럴 escape를 실제 NUL로 오판 — Python 직렬화 문자열의 부분 일치와 TS의 재귀 문자 판정이 다름을 합성 boolean 재현과 writer/Core 코드에서 확인했다. 실제 문자열·중첩 키의 NUL을 재귀 검사하도록 수정하고 writer/Core escape 회귀를 추가했다.
  - `[medium]` `[patch]` 비정상 TEXT의 건강 JSON writer 경로 단절 — convert는 InvalidSQLiteText를 반환하지만 source_value 분기가 이를 거부해 다음 표시 분기에 도달하지 못한다. 원래 바이트·encoding을 기존 원문 쌍으로 연결하고 비정상 TEXT JSON 반입·복원 회귀를 추가했다.
  - `[medium]` `[patch]` 건강 identity의 표시값 변조를 reconciliation이 놓침 — raw 기반 검색 후 payload 대조에 account/activity_id/sub_identity 표시값이 없어 성공하고 Core 복원은 실패한다. 기존 대조 tuple에 세 표시값과 원문 쌍을 포함하고 각각의 변조·영속 충돌 회귀를 추가했다.
  - `[high]` `[patch]` 업그레이드한 tracer의 건강 mapping 해시 변경 — 기존 day_key/steps 두 열 대신 전체 daily_metric 행이 해시에 들어가 동일 snapshot도 이전 mapping과 충돌한다. 기존 두 열 투영과 정상 원문의 논리 UTF-8 해시를 유지했다. UTF-8/UTF-16의 이전 mapping UUID·batch·metadata 재사용과 원문 쌍 보강 회귀를 추가했다.
  - `[medium]` `[patch]` 건강 JSON escape 오판의 독립 중복 finding — 첫 finding과 같은 직렬화 부분 일치 결함이며 실제 NUL 없는 escape도 빈 SQL JSON으로 저장돼 readHealth 전체가 실패한다. 같은 원인 묶음에서 재귀 NUL 판정으로 수정하고 실제 writer/Core의 리터럴 escape 회귀를 추가했다.
  - `[high]` `[patch]` 변경된 tracer 쓰기·재조정 경로의 초과권한 검사 누락 — import 분기부터 tracer까지 probe_role 호출이 없고 valid attempt만 검사해 금지 SELECT 역할도 쓰기를 진행한다. 모든 writer의 최소권한 경계를 맞추도록 기존 probe를 staging 및 DB 쓰기 전에 호출하고 신규·재실행의 초과 SELECT 거부 회귀를 추가했다.
  - `[high]` `[patch]` tracer의 stale 검사 전에 staging 쓰기 — 현재 순서에서 이미 만료된 token도 mkdir/open/write를 수행하며 DB rollback이 파일을 지우지 못한다. 기존 attempt 검사를 staging 이전으로 옮기고 DB 쓰기 전 재검사를 유지했다. stale token에서 새 staging 디렉터리가 생기지 않는 회귀를 추가했다.

### 2026-11-01 — 결정적 검증 복구 Review pass
- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` 건강 JSON 표현 차이를 typed 값 차이로 취급 — `0025_original_text.sql`의 value_count는 원문 바이트·인코딩을 포함한다. 동일 논리 키의 서로 다른 보관키는 허용되므로 같은 객체도 공백 차이로 ambiguity가 된다. 실행 계획에 논리 동등성의 독립 비교와 회귀를 명시하고 원문 보존과 비교 표현을 분리하도록 보완한다.
  - `[medium]` `[bad_plan]` 단독 surrogate JSON escape에서 필수 반입 중단 — Python json.loads 뒤 canonical 문자열의 UTF-8 인코딩 실패를 재현했다. 실행 계획에 SQL이 담지 못하는 JSON 중첩 값·키의 공통 표시/복원 규약과 회귀를 보완한다. 원문은 그대로 보존한다.

### 2026-11-01 — 실행1 재리뷰
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 문자열의 인코딩 차이를 typed 값 차이로 취급 — 0026의 value_count에 문자열 raw/encoding이 남아 같은 논리 문자열이 ambiguity가 된다. 읽기 전용 코드 단위 비교를 문자열에도 적용했고 UTF-8/UTF-16 LE·BE 수렴, NUL/U+FFFD/escape·비정상 바이트 구별과 저장 원문 불변 회귀를 추가했다.

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
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_reader_bytes.py` — 원래 TEXT 타입·인코딩·바이트 및 canonical identity 검사 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_preflight.py` — reader/preflight 회귀 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_batch_import.py` — 추가 순수 mapping/키/hash 행렬 성공.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-batch-import.test.ts` — 실제 설치·공용 CLI·감독자·PG·kill/restart·병렬·충돌·legacy 비발신 성공.
- `pnpm test` — 기본 전체 suite 성공.
- `pnpm test:python` — Python 전체 suite 성공, 신규 skip 없음.

실제 시험 이름·실행 결과는 구현 뒤 기록한다. fixture extHome/globalSetup으로 격리 PG/Brain 홈을 만들고 실제 프로세스 PID와 checkpoint 관찰로 kill 지점을 동기화한다. exit를 확인한 뒤 재개하고 finally에서 자식·daemon abort/종료·store·DB·marker role·임시 홈을 정리한다. 실데이터·운영 접근은 없다.


## Verification Repair — 2026-11-01

- 재개 근거: `.bmad-loop/runs/20261030-175233-8a92/feedback/14.4-1.md`의 결정적 검증에서 `packages/postgres/test/unavailable.test.ts`의 terminated 행렬이 30초 안에 끝나지 않았다. 기존 intent-contract와 baseline은 그대로 유지한다.
- 단계 1: `packages/postgres/test/unavailable.test.ts`와 필요한 연결/시험 fixture를 조사하여 전체 store verb의 실제 연결 종료 및 DB_UNAVAILABLE 검증을 유지하면서 시간 초과 원인을 수정한다. 단순 assertion 제거·skip·임의 timeout 증가는 하지 않는다. 집중 시험 실행 결과와 원인·변경 근거를 한국어 보고에 남긴다.
- 단계 2: 지휘자가 누적 diff와 모든 기존 Verification 명령 및 `bash _bmad/custom/bmad-loop-verify.sh` 결과를 대조한다. 기존 matrix·AC를 유지하고 quick 리뷰 후 같은 구현자가 필요한 수정만 반영한다.
- 기존 generation의 Orca 워커 세 명은 모두 completed/released이며 제어 셸은 operator_close로 종료됐다. 현재 generation `14.4-dev-2`는 별도 Run과 체크포인트로 소유권을 기록한다. 티켓 완료와 커밋 판정은 엔진에 남긴다.

- 복구 Verify 중간 결과: `bash _bmad/custom/bmad-loop-verify.sh` 성공(내부 `pnpm test`의 build/typecheck 포함), 165파일 3899통과·기존1skip. 순수 Python `check_preflight.py`와 `check_batch_import.py`도 성공했다. `pnpm test:python`을 독립 실행 중이다.
- 수정은 종료 행렬의 105개 동작을 최대 8개 묶음으로 실행하며 실제 잠금 대기·backend 종료·각 오류 검증을 보존한다. 고정 계약이 HEAD의 원문과 바이트 동일함을 확인했다.

- 복구 Verify 최종 결과: `pnpm test:python` 5파일18통과·skip없음, 별도 `garmin-batch-import.test.ts` 1파일3통과(13.30초). 별도 집중 시험을 Python 전체 실행과 겹친 최초 시도는 공유 role 충돌로 실패했으므로 두 실행 종료 후 단독 재실행으로 확인했다. 소스 변경으로 숨기지 않았다.

### 복구 Matrix Test Audit

| 행렬 | 실행·통과한 시험과 관찰 |
|---|---|
| 보존 | `다섯 합성 snapshot의 원형과 키를 보존하고 재실행한다`: 20개 표·71개 schema metadata·원형 전수·NUL·recovery 보존. `check_preflight.py`의 미지원 입력 및 `check_batch_import.py`의 독립 인코딩 기대값도 통과했다. |
| 멱등·경쟁 | 첫 시험의 재실행과 `checkpoint 중단·재개와 동시 반입 및 입력 변경 충돌을 검증한다`의 두 실제 프로세스 결과·행·UUID 불변을 확인했다. |
| 재개 | 셋째 시험의 실제 PID SIGKILL·exit 확인·중간 건수·최종 재개 및 누적 timeout의 backend 소멸·대상/mapping rollback을 확인했다. |
| 변경·충돌 | 셋째 시험에서 source bytes·schema·importer 버전·manifest·계정·권위·conversation·WAL 변경의 거부 및 영속 conflict와 기존 대상 불변을 확인했다. |
| 관계 | 첫 시험에서 두 dataset의 서로 다른 run UUID와 fetch_error의 dataset-local 부모 FK를 확인했다. |
| 건강·선택 | 첫 시험의 archive BB 현재 view·catalog 단위와 typed 값, `health-contract.test.ts` 및 순수 mapping 검사로 NULL·구버전·미확인 ambiguity를 확인했다. |
| legacy·권한 | `공용 명령과 실제 감독자가 capture를 반입하고 발신 없이 재실행한다`: 같은 conversation의 legacy gate·delivery 1회, channel_requests/channel_send/HTTP 0과 공개 표식 비노출·원본 hash 불변을 확인했다. 첫·셋째 시험의 초과권한/skip-only·stale/타 출처 및 `extension-permissions.test.ts`의 authority INSERT 권한도 통과했다. |

- 위 Python 통합 3시험은 전체 suite와 단독 실행 모두 skip 없이 통과했고, 기본 suite의 health-contract/extension-permissions도 실행·통과했다. 기존 skip 1개는 신규 행렬 시험이 아니다.


## 재개 검증 — 2026-11-01

단계3·4에서 batch/tracer·Core reader와 Store writer의 원문 복원, 원형 identity, 누락 대상과 권위 기록 재조정, codec/projection/canonical/catalog fingerprint 고정을 구현했다. 새 migration은 Garmin 0003·core 0025이며 기존 적용 migration은 바꾸지 않았다. 공통 raw v2와 건강 복원 계약 문서를 갱신했다. 운영자 외부 작업이 필요한 AC는 없다.

지휘자가 누적 diff를 읽고 격리 환경에서 독립 실행한 결과는 다음과 같다. `bash _bmad/custom/bmad-loop-verify.sh`는 내부 `pnpm test`·build·typecheck를 포함해 166파일 3900통과·기존1skip, `pnpm test:python`은 5파일20통과·skip없음, 별도 `garmin-batch-import.test.ts`는 1파일4통과다. `check_reader_bytes.py`, `check_preflight.py`, `check_batch_import.py`도 각각 성공했다. 원시 로그는 버전 관리 밖 임시 경로에 보관하며 공개 기록에는 집계와 boolean만 남긴다. `git diff --cached --check`도 성공했다.

행렬 감사: 보존·관계·건강 선택은 batch 첫 시험과 health-contract/import-contracts 및 순수 Python 검사, 멱등·경쟁·재개·변경 충돌은 batch 셋째 시험의 실제 SIGKILL 종료 확인·두 프로세스·timeout rollback·version/catalog/WAL 변경 검증, legacy·권한·비발신은 둘째 시험과 extension-permissions 및 channels-legacy에 대응한다. NUL/U+FFFD/escape/빈값·UTF-16·비정상 TEXT·JSON 중첩 키·dataset/slash identity·명시 DTO는 batch 넷째 시험과 reader/original-text 검사에 대응한다. 기존 tracer 동일 원문 재사용·변경 충돌·mapping 존재/대상 누락은 batch 첫 시험과 tracer 신규 시험, 권위 규칙/provenance 각각의 누락 복구는 batch 첫 시험에 대응한다. 모두 이번 지휘자 실행에서 통과했고 신규 skip은 없다. 공개 집계 비노출과 복원 후 가림 순서도 통과했다. 현재 이 Store 조회를 별도로 공개하는 출력 경로가 없다는 범위를 함께 유지한다.



## 결정적 검증 복구 — 2026-11-01

- 근거: `.bmad-loop/runs/20261030-175233-8a92/feedback/14.4-3.md`의 앨범 0장 실패 처리 결과 대기 시간 초과다. 동결 계약과 baseline을 유지한다.
- 단계1: 구현자가 채널 시험·fixture와 필요한 처리 경로를 조사하고 실패 원인을 수정한다. 기존 관찰·assertion을 유지하며 단순 timeout 증가·skip으로 숨기지 않는다. 집중 시험 통과와 원인을 phase-ready로 보고한다.
- 단계2: 지휘자가 누적 diff·행렬·전체 Verification 및 결정적 검증을 확인한다. quick 리뷰와 필요한 수정을 같은 구현자에게 맡긴 뒤 최종 결과를 기록한다.

- 이번 복구 독립 Verify: `bash _bmad/custom/bmad-loop-verify.sh` 성공(빌드·타입 검사 포함, 166파일3900통과·기존1skip), `pnpm test:python` 성공(5파일21통과), 별도 `garmin-batch-import.test.ts` 성공(1파일4통과), 순수 Python 세 검사 성공이다. 기존 행렬과 추가 NUL·인코딩·재조정 시험이 모두 실행됐고 신규 skip은 없다. 동결 계약이 HEAD와 동일함을 확인했다.
- 구현자 집중 시험은 채널 번들·재시도 38개 통과다. 과거 실패의 직접 원인은 당시 프로세스 상태가 없어 미확정이며, 실제 프로세스 정리에 고정 시계를 쓰면 기한이 진행되지 않는 경로를 수정했다.

## 리뷰 재계획 — 실행 1

- 변경 근거: typed JSON 논리 동등성과 SQL이 표현하지 못하는 JSON escape의 필수 투영을 기존 실행 항목이 구체적으로 검증하지 않았다. intent-contract는 변경하지 않는다.
- KEEP: 기존 커밋의 원형·identity·권한·reconciliation·비발신 구현과 검증, 이번 채널 흐르는 시계 변경의 의도와 기존 assertion·timeout을 보존한다. 커밋된 소스를 되돌리지 않는다. 이번 미커밋 채널 두 파일 변경은 임시 patch에 보존한 뒤 재도출하여 반영한다.
- 단계1: `packages/postgres/migrations/`의 새 후속 migration과 `extensions/garmin/src/batch_import.py`, `packages/postgres/src/original-text.ts` 및 필요한 provisioning/role probe·schema version 코드에서 원형 바이트와 typed JSON 비교 표현을 분리한다. 기존 적용 migration은 수정하지 않는다. 같은 논리 객체·배열의 공백·키순서·UTF-8/UTF-16 차이는 현재값 하나로 수렴하고, 다른 중첩 키·값(NUL 포함)은 ambiguity로 남게 한다. 원형·재조정 payload 대조는 바이트를 유지한다. 공개 DTO에는 비교용 내부 표현을 노출하지 않는다. codec 의미가 달라지면 checkpoint fingerprint로 이전 checkpoint 재사용을 거부한다. 기존 checkpoint를 자동 초기화하지 않는다.
- 단계2: `extensions/garmin/src/batch_import.py`, `packages/postgres/src/original-text.ts` 및 관련 codec에서 단독 surrogate escape가 중첩 값 또는 키에 있는 JSON을 원형으로 보존하고 SQL 표시/복원 규약을 맞춘다. 실제 surrogate 바이트를 UTF-8 문자열로 억지 저장하거나 대체하지 않는다. 기존 NUL/U+FFFD/리터럴 escape·비정상 TEXT의 의미는 유지한다.
- 단계3: `packages/postgres/test/import-contracts.test.ts`, `packages/postgres/test/original-text.test.ts`, `apps/cli/python-test/garmin-batch-import.test.ts` 및 필요한 순수 Python 검사에서 위 반례를 실제 writer→PG→Core 조회로 검증한다. 같은 typed JSON의 원문 차이와 서로 다른 값을 구별하고 단독 surrogate escape의 중첩 값·키와 정상 surrogate pair를 확인한다. 복구한 채널 두 파일 변경도 재적용한다. 관련 집중 검증 뒤 phase-ready로 보고하고 전체 Verification·결정적 검증·quick 리뷰는 지휘자가 실행한다.
- 피할 상태: 원문 bytea를 typed 동등성으로 그대로 사용하거나 SQL UTF-8 실패 때문에 필수 행을 누락하는 상태다.

### 기존 특수 JSON의 비교 복구 설계

- 기존 불변 행의 원문/metadata를 backfill하거나 UPDATE할 필요 없이, 새 migration의 읽기 전용 비교 함수를 현재값 view에서 호출하는 방식을 우선한다. 비교 함수는 기존 원문 쌍 또는 기존 JSON 표시값을 받아 같은 논리 비교 표현을 만든다. 공개 DTO는 바꾸지 않는다.
- SQL에서 NUL·surrogate를 실제 문자열로 디코딩하지 말고, 원본 JSON의 모든 문자열 토큰(객체 키 포함)을 가역적인 ASCII UTF-16 code-unit 표현으로 변환한 뒤 JSONB로 구조·숫자·키순서를 정규화할 수 있다. 모든 문자열에 같은 변환을 적용하여 실제 NUL과 리터럴 escape, 숫자와 문자열, 정상 surrogate pair와 문자 원형의 충돌을 방지한다. JSON escape는 문자 단위로 파싱하여 중복 역슬래시를 구별한다.
- UTF-16 LE/BE 원문은 엄격히 유효성을 확인하며 디코딩한다. 원래 JSON 문법이 깨지거나 TEXT 자체가 디코딩 불능인 경우는 원문 보존 태그로 구별하며 유효 JSON 객체로 가장하지 않는다. 정상 객체·배열의 의미 비교를 원문 바이트 fallback으로 대체하지 않는다. 신규 writer의 보조 비교 표현만 믿고 기존 행을 놓치지 않는다.
- 이 설계는 내부 읽기 계산이며 저장된 원문과 불변·권한 경계를 바꾸지 않는다. 기존 특수 JSON 행에도 migration 후 동일 규칙이 적용되는 회귀를 추가한다.

## 실행1 독립 재검증

- `bash _bmad/custom/bmad-loop-verify.sh` 성공: 빌드·타입 검사 포함 166파일3902통과·기존1skip이다. `pnpm test:python`은 5파일21통과, 별도 `garmin-batch-import.test.ts`는 1파일4통과이며 순수 Python 세 검사도 성공했다. 신규 skip은 없다.
- 추가된 두 회귀는 원문 JSON의 논리 비교와 기존 0025 특수 JSON을 유지하는 0026 업그레이드다. 기존 행렬의 모든 시험이 실행·통과했고 batch 넷째 시험은 중첩 surrogate 키·값과 정상 쌍을 추가로 왕복했다. SQL 비교는 UTF-8/UTF-16 LE·BE, 공백·키순서·숫자 표기와 실제 다른 값을 구별한다.
- intent-contract는 HEAD와 동일하다. 새 migration만 추가했으며 기존 적용 migration의 소스와 저장된 원형은 바꾸지 않았다.

## Auto Run Result

Status: built

채널 번들 시험에 흐르는 시계를 적용해 실제 자식 프로세스 정리 기한이 진행되도록 복구했다. 재시도 시험의 고정 시계와 기존 assertion·timeout은 유지했다. 기존 반입·재개·mapping·충돌·legacy 비발신 구현도 보존했다.

독립 리뷰에서 확인한 JSON 논리 동등성과 단독 surrogate 반입 문제를 수정했다. 후속 0026은 기존 불변 행을 갱신하지 않고 원문을 읽어 JSON·문자열의 논리 값을 비교한다. UTF-8/UTF-16의 표현 차이는 현재값 하나로 수렴하며 NUL·U+FFFD·리터럴 escape·디코딩 불능 원형은 구별한다. writer/Core는 단독 surrogate 중첩 키·값을 원문 쌍으로 보존·복원하고 checkpoint fingerprint에 새 투영 버전을 포함한다. 동결 intent-contract와 기존 적용 migration은 변경하지 않았다.

검토 결과는 medium 3건이다. 첫 두 건은 bad_plan으로 실행 항목을 보완해 수정했고, 재리뷰의 문자열 비교 1건은 patch로 수정했다. 최종 pass의 patch 집계는 high 0·medium 1·low 0이며 deferred 0·rejected 0이다. `followup_review_recommended: false`다. 마지막 문자열 patch는 지휘자의 코드 대조와 전체 실행 검증을 거쳤으며 별도 추가 리뷰는 수행하지 않았다.

최종 지휘자 검증은 모두 성공했다.

- `bash _bmad/custom/bmad-loop-verify.sh`와 내부 `pnpm test`: 빌드·타입 검사 포함 166파일3902통과·기존1skip
- `pnpm test:python`: 5파일21통과·skip없음
- 별도 `garmin-batch-import.test.ts`: 1파일4통과
- `check_reader_bytes.py`·`check_preflight.py`·`check_batch_import.py`: 각각 성공
- 기존 행렬의 전수 보존·관계·건강 선택·중단 재개·경쟁·충돌·권한·비발신 및 원문 복원 시험: 모두 실행·통과, 신규 skip 없음
- 기존 0025 특수 JSON의 0026 업그레이드: 원문 바이트 불변과 현재값 복구 성공
- `git diff --check`: 성공

이번 복구에서 변경한 파일은 다음과 같다. 이전 커밋의 검토된 변경은 보존한다.

- `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-batch-checkpoint-plan.md` — 실행 보완·리뷰 판정·검증·종료 결과 기록
- `apps/cli/python-test/garmin-batch-import.test.ts` — 중첩 surrogate 원문 반입·Core 복원 회귀
- `apps/cli/test/channel-fixture.ts` — 실제로 흐르는 시험 시계 모드 추가
- `apps/cli/test/channels-bundle.test.ts` — 실제 프로세스 정리에 흐르는 시계 적용
- `apps/cli/test/install.test.ts` — core schema 26 설치 기대값 갱신
- `apps/cli/test/setup.test.ts` — core schema 26 setup 기대값 갱신
- `extensions/garmin/src/batch_import.py` — surrogate의 원문 투영과 checkpoint fingerprint 갱신
- `packages/postgres/migrations/0026_health_json_comparison.sql` — 기존 원문을 유지하는 JSON·문자열 논리 비교
- `packages/postgres/src/migrate.ts` — core schema 26 선언
- `packages/postgres/src/original-text.ts` — surrogate 원문 쌍의 표시 검증·복원
- `packages/postgres/test/import-contracts.test.ts` — 논리 수렴·ambiguity·원문 불변·인코딩 구별 회귀
- `packages/postgres/test/migrate.test.ts` — 기존 0025 원형을 유지하는 0026 업그레이드 회귀
- `packages/postgres/test/original-text.test.ts` — 중첩 surrogate 키·값 복원 회귀
- `packages/postgres/test/store.test.ts` — schema 26 Store 기대값 갱신
- `packages/postgres/test/work-store.test.ts` — schema 26 감독자 기대값 갱신

과거 앨범 timeout의 직접 원인은 당시 프로세스 상태가 기록되지 않아 확정하지 않는다. 고정 시계로 정리 기한이 진행되지 않는 경로를 제거했고 최종 트리의 결정적 검증은 통과했다. 알려진 미해결 차단은 없으며 운영자만 수행할 저장소 밖 AC도 없다. 티켓 done·tickets.py mark·원격 push는 수행하지 않는다. 완료 판정은 오케스트레이터에 남긴다.

정리 결과: 구현자와 독립 리뷰어 두 명의 정식 성공 보고·전문을 수락하고 모두 completed/released로 정리했다. 자기 Run의 활성·reclaimable 워커와 미처리 Delivery·미확인 요청은 없다. 과거 transcript source 변경의 unknown 관측은 정식 완료와 실제 Run 대조로 해소했고 생성 Python cache도 정리했다. 체크포인트에 검증·판정·정리를 보존하고, 커밋과 청결 확인 뒤 정리된 자기 전용 제어 셸만 마지막에 닫는다.
