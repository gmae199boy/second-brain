---
title: '원본과 반입 대상의 전수 검증 및 안전한 공개 집계'
type: 'feature'
ticket: '6'
created: '2026-11-01'
status: 'in-progress'
baseline_revision: '573647c4a102ebd6c7fd98efc04364eeb08a81b2'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md
  - _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `brain ext run garmin import-verify`는 미구현이다. 반입 성공만으로는 이후의 누락·변조·파일 소실을 발견할 수 없다.

**Approach:** capture를 읽기 전용으로 다시 읽어 보존·발행·파일을 전수 비교하고 차이가 있으면 명령을 실패시킨다. private 상세와 고정 허용 집계의 공개 투영을 분리한다.

## Boundaries & Constraints

**Always:** E14-12 전체를 충족한다. 출처별 표 건수·자연키 양방향 집합·typed 값·NULL·단위/수치·원문 byte hash·raw metadata·dataset-local FK와 mapping·건강 발행/권위·legacy 이력·분석 본문/JSON/누락 flag·모든 파일 hash/size/요청 결과/관계·inventory·미선택/제외 사유·checkpoint를 대조한다. 원본 파일 hash는 읽기 전후 및 반입 당시 checkpoint와 같다. 같은 batch 재실행·실제 중단 재개·비발신 결과는 시험에서 입증하며 실행 이력이 없으면 지어낸 과거 성공으로 표시하지 않는다. 없는 revision/evaluation은 만들거나 보고하지 않는다. private 상세는 확장 홈 reports 아래 0700/0600으로 기록한다. 공개는 고정 label의 비음수 safe integer 건수와 boolean 검사 결과만 단일 투영 함수가 만든다. 계획 증거도 이 함수 출력만 사용한다. mismatch는 private/public 보고를 남기고 CLI exit 실패이며 해당 검사 false다. 대상과 충돌 ledger는 검증으로 수정/복구하지 않는다.

**Never:** 실데이터·운영 홈·원본 Garmin 저장소 접근, 원본 수정·normalize·upgrade, 반입 재호출/INSERT rollback 검증, 재분석·모델·수집·발신·push, 기존 migration 수정, 확장의 core SELECT/UPDATE/DELETE 권한 확대, core에서 garmin 내부 표 읽기, 임의 SQL/경로를 받는 권한 helper, 개인 값·원문·해시 값·계정·개인 날짜·경로·예외 원문 공개, 커밋·계획 상태·티켓 상태 변경을 구현자가 하지 않는다. 지휘자는 built까지만 기록하고 done은 엔진 소관이다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 정상·버전 | 합성 schema10/15·v1/v2·evaluation 존재/부재 | 전체 일치, 부재는 0, 재검증해도 대상 불변 | 미지원 입력은 고정 오류 |
| 값·집합 | 행 값/NULL/자연키·mapping 누락/추가/변조 | 항목별 불일치·양방향 차이·실패 | 누락 복구 금지 |
| 원형·의미 | UTF8/UTF16/invalid TEXT/NUL·JSON·정수/실수·변환 단위 | 권위 bytes와 논리값 및 원형을 각각 대조 | 표시 placeholder 일치로 통과 금지 |
| 관계·발행 | dataset-local 정수 id/FK·health·authority·legacy·analysis flags/관계 변조 | 대상별 실패, 다른 dataset 병합 거부 | 다른 출처 행은 읽거나 노출하지 않음 |
| 파일·제외 | 다종 artifact·대형 evaluation·설정·비밀/scan_failed·미연결 | 모든 source hash/size·고정 제외/미선택 기대 건수·관계 일치 | 누락·과잉 요청/관계는 실패 |
| 파일 소실 | core 위치 삭제·blob 삭제·같은 크기 오염·pending/failed/redacted | 현재 FileStore bytes 검사 실패 | 과거 completed로 통과 금지 |
| 변경·권한 | 원본 변경/WAL·stale token·잘못된 work/source·snapshot 교체/symlink | 신선성/범위/경계 거부 | 고정 오류, private 유출 없음 |
| 재실행·재개·비발신 | 같은 batch 반복·checkpoint 뒤 실제 SIGKILL와 새 attempt 재개 | 동일 target id/건수/hash·검증 성공·channel 요청/송신 0 | 미입증 과거 실행은 성공 주장 금지 |
| 공개 유출 | 날짜·계정·건강값·원문·hash sentinel을 정상/실패 입력에 포함 | stdout/stderr/public.json/계획용 투영 모두 미포함 | 동적 label·private dict 복사 금지 |

</intent-contract>

## Code Map

- `extensions/garmin/src/{import_verify,reader,capture_manifest,batch_import,raw_codec,health,preflight}.py` — stub을 교체한다. read_snapshot·typed encoded/canonical·dataset_ref·계약 fingerprint·순수 후보/선택/변환을 재사용하되 ingest/reconcile_raw/run은 쓰기라 호출 금지다. 보존 행/키/hash/mapping과 raw 6쌍·epoch ms·source_schemas·checkpoint를 다시 비교한다.
- `extensions/garmin/src/{analyses,analysis_codec,artifacts,metadata_codec,reports}.py` — publication 규칙을 독립 비교한다. 정상 evaluation은 inventory가 아니라 mapping/core에 있다. 대형 evaluation은 inventory original_table namespace다. 원형 codec·안전 streaming read·분류·scan·원자 보고를 재사용하고 stage/publish는 호출하지 않는다.
- `extensions/garmin/migrations/000{1,2,3,4,5}_*.sql` — 현재 내부 표 계약이다. mapping은 기존 batch를 재사용하므로 capture batch만으로 오래된 정상 mapping을 거부하지 않는다. 현재 capture의 논리 identity와 해당 target 전부·현재 batch의 예상 외 target을 양방향 대조한다.
- `packages/core/src/{extensions/manifest,ports/import-store}.ts`, `packages/postgres/src/imports.ts` — core 역할은 기존 SELECT 권한으로 자기 출처 계약 표만 읽는다. 기존 readHealth는 current만, readAnalyses는 모든 출처라 전수 검증 snapshot 대체물로 부적합하다. raw는 선언 view만 읽는다.
- `apps/cli/src/{daemon/supervisor,runtime/file-store}.ts`와 새 `runtime/import-verification.ts` — manifest work opt-in을 보고 현재 work/token에 묶인 source 전용 private snapshot을 준비한다. 실제 FileStore.get hash/size와 missing/redacted/deleted 결과를 함께 담는다. DB 읽기와 파일 I/O를 분리한다. core 이름은 출처 중립이며 Garmin 분기를 추가하지 않는다.
- `packages/core/src/extensions/run.ts`, `apps/cli/src/commands/ext-run.ts`, `extensions/garmin/manifest.json` — 기존 정확한 counts/checks schema와 30초 대기/EXTENSION_REPORT_NOT_READY 실패 보고 계약을 재사용한다.
- `apps/cli/test/ext-fixture.ts`, `extensions/garmin/tests/fixtures.py`, `apps/cli/python-test/{garmin-batch-import,garmin-artifacts}.test.ts` — 격리 PG/홈·설치 Python·실제 감독자·파일 수용·IPC barrier/SIGKILL·비발신 기반이다. 새 시험은 Python suite의 자동 include 범위에 둔다.

## Tasks & Acceptance

**Execution:**
- [ ] 단계1 — `packages/core/src/{extensions/manifest,ports/import-store}.ts`, `packages/postgres/src/imports.ts`, `apps/cli/src/{runtime/import-verification,daemon/supervisor}.ts`와 관련 시험 — 출처 중립의 Python work opt-in `verification_snapshot: true` 계약과 private core snapshot을 구현한다. 초기 버전은 runtime=python에서만 이 옵션을 허용한다. 설치된 pinned Python으로 core 소유의 고정 writer를 실행하고 JSON은 stdin으로 전달해 descriptor 기반 openat/renameat·fsync로 쓴다. Node work에는 Python 의존을 추가하지 않는다. supervisor가 manifest source를 결정하고 source 필터한 건강 전체/권위/분석/요청/관계/legacy/작업 결과를 현재 work/token envelope로 전달한다. bytea는 손실 없는 표현이다. core 파일은 configured FileStore로 현재 재독해하여 실제 hash/size/위치 상태만 담고 경로/bytes는 확장에 주지 않는다. snapshot은 확장 홈 안 원자 0600 파일이고 BRAIN_IMPORT_VERIFICATION_SNAPSHOT으로 경로를 전달한다. 일반 job에는 생성하지 않는다. 타 source 노출·symlink·실패·현재 시도 불일치 시험을 포함한다.
- [ ] 단계2 — `extensions/garmin/src/import_verify.py`와 필요 순수 비교 모듈, `manifest.json` — capture/garmin/core snapshot을 전수 비교하는 읽기 전용 검증기를 구현한다. 새 snapshot envelope의 source/work/token 확인 후 사용한다. core SELECT grant는 추가하지 않는다. 단계별 상세·차이와 고정 공개 투영 하나를 만들고 manifest counts/checks를 일치시킨다. 차이는 기존 EXTENSION_REPORT_NOT_READY로 보고해 CLI가 검사를 출력하고 실패한다.
- [ ] 단계3 — `apps/cli/python-test/garmin-import-verify.test.ts`, `extensions/garmin/tests/fixtures.py`, `apps/cli/test/import-verification.test.ts` 및 기존 batch 시험 — 행렬 전체를 실제 관찰로 검증한다. core 값 변조/파일 위치 삭제 각각 CLI 실패와 해당 false, raw/NULL/단위/JSON/FK/분석/관계 변조, 원본 hash 변경, 재실행 불변, SIGKILL 재개, 비발신 0, 정상/실패 sentinel 비노출을 포함한다. 기대값은 손으로 적어 구현 자체를 되풀이하지 않는다. 단계별 phase-ready 후 전체 implementation-ready를 보고한다.

- [ ] 재도출1 — `extensions/garmin/src/verify_compare.py`, `packages/postgres/src/imports.ts`, `apps/cli/python-test/garmin-import-verify.test.ts` — 보존 patch의 모든 KEEP을 복원하고 아래 세 비교 경계를 구현·회귀 검증한다. (1) typed 보존 payload와 nested metadata/schema/JSON은 bool과 number를 구별해 비교하고 실제 target canonical payload도 원본 hash와 대조한다. JSONB의 정상 숫자 표현 동등성은 유지하되 1/true·0/false를 같다고 보지 않는다. (2) 소스에서 재구성한 기대 건강 후보를 논리 키별로 묶고 승인된 규칙1의 dataset 순서와 지원 정규화 버전으로 current/selected/unselected/reason/dataset/권위 id·version을 독립 계산해 core resolution과 대조한다. core snapshot에 출처 중립 계약 metadata인 `brain.health_supported_versions`의 version 목록을 추가한다. provenance가 가리키는 행만 검사하지 말고 해당 논리 키에 실제 적용된 더 높은 revision/구체 규칙도 결과 비교로 탐지한다. (3) 현재 capture의 `(dataset,original_table,original_key)`와 artifact/relation 논리 identity 및 연결된 분석/요청 ID 범위를 먼저 만든다. 이 범위의 모든 mapping·health·legacy·analysis revision·request·관계·inventory/provenance는 batch와 무관하게 양방향 대조하고, 현재 batch의 무관한 과잉도 거부한다. 과거 다른 capture의 무관한 identity는 보존하며 오탐하지 않는다.
- [ ] 재도출1 회귀 — `apps/cli/python-test/garmin-import-verify.test.ts`와 필요 순수 비교 시험 — target typed integer value 1→true와 nested JSON bool/number 변조가 실패함을 먼저 재현한다. 원래 규칙1을 유지한 채 역순 revision2 또는 더 구체적 규칙을 추가해 실제 current가 달라지는 경우 authority/선택 검사 실패를 보인다. capture A→B의 정상 old-batch mapping 재사용은 성공하며, 같은 현재 논리 키에 A batch의 예상 밖 health mapping/target 및 분석 revision/파일 요청/관계를 각각 더하면 실패한다. 무관한 A의 과거 identity는 남겨도 B 검증이 성공해야 한다. 각 실패는 비복구·공개 유출 없음과 함께 관찰한다. 수정 후 기존 전체 행렬을 그대로 실행하고 독립 Verify·quick 리뷰를 다시 받는다.

- [ ] 재도출2 무손실 JSONB — `packages/postgres/src/imports.ts`, `apps/cli/src/runtime/import-verification.ts`, `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts`, `packages/postgres/test/import-contracts.test.ts` — patch2의 전체 KEEP을 복원한다. snapshot 전용 core JSONB 칸(건강 value_json 및 해당 조회가 운반하는 JSONB payload)을 PG에서 text로 꺼내 `encoding: jsonb-text-v1`과 원문 text `data`를 가진 명시적 wrapper로 운반한다. SQL NULL은 NULL로 유지하고 실제 JSON이 wrapper 모양이어도 한 번만 해석해 원래 객체를 보존한다. Node에서 DB JSON 숫자를 Number로 파싱하거나 재직렬화하지 않는다. Garmin receiver는 알려진 JSONB 칸만 풀고 큰 정수와 정밀 소수를 보존하는 parser(소수는 Decimal)를 사용한다. 숫자 비교는 source의 정상 JSON 숫자 표현과 동등성을 유지하며 bool과 number를 구분한다. 일반 pg 전역 parser·일반 readHealth/다른 consumer·권한·공개 집계 계약은 변경하지 않는다. source 2^53+1의 정상 성공, source 2^53에서 core JSONB만 2^53+1로 바꾼 실패를 먼저 재현하고, nested 정밀 소수 변조·정상 소수/1과1.0·NULL/boolean·wrapper 모양 객체·공개 비유출을 회귀 검증한다.
- [ ] 재도출2 inventory namespace — `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — `(dataset,evaluation,key)`와 inventory `(dataset,evaluation,'evaluation:'+key)`를 namespace를 보존하며 연결한다. 현재 논리 identity 또는 관련 요청/분석 ID에 붙은 inventory는 old-batch라도 예상 집합과 양방향 대조한다. normal evaluation에 `too_large` old-batch inventory를 더한 실제 오판을 먼저 재현해 inventory=false·실패·비복구로 교정한다. artifact의 같은 문자열 키·실제 대형 evaluation·무관한 과거 inventory의 정상 보존과 모든 이전 범위 회귀를 유지한다. 이후 전체 독립 Verify와 quick 재리뷰를 수행한다.

**Acceptance Criteria:**
- Given 합성 capture 반입과 core 파일 완료, When 공용 명령 `brain ext run garmin import-verify --json` 실행, Then 모든 비교 검사가 true이고 명령은 성공하며 private 상세와 공개 집계가 기록된다.
- Given 정상 반입, When 보존/core 행 하나를 시험용으로 바꾸거나 core 파일 위치를 제거한 뒤 각각 명령 실행, Then 해당 항목의 검사 false와 실패 exit가 나오고 verifier는 대상을 복구하지 않는다.
- Given 미선택 충돌과 제외 사유가 있는 합성 fixture, When 검증 실행, Then 공개 건수는 독립 기대값과 같고 source별 상세 차이는 private에만 있다.
- Given 개인 sentinel과 해시·원문이 있는 정상 및 실패 fixture, When 공개 출력과 계획용 단일 투영을 검사, Then 해당 값이 하나도 없고 허용 counts/checks만 있다.
- Given 동일 batch 재실행 및 실제 중단 뒤 새 attempt 재개, When 다시 검증, Then target identity와 bytes가 보존되고 발신 요청·송신은 0이며 없던 이력은 생성되지 않는다.

## Implementation Notes

단계1~3을 같은 구현 Dispatch에서 완료했다. core source/현재 attempt에 묶인 read-only snapshot·원형 codec·현재 파일 hash/size 재검사와 Python descriptor writer, Garmin 전수 비교와 단일 공개 투영, 변조/소실/인코딩/비복구/중단 재개/비발신/유출 행렬 시험을 추가했다. 구현자는 기본 3914통과·기존1skip, Python 전체34통과·skip없음, 집중12통과를 보고했다. 이는 지휘자 독립 Verify 전의 구현 보고이며 완료 판정은 아니다. private 상태만으로 과거 재실행/재개와 v1 미할당 파일의 반입 당시 해시는 입증하지 않았다고 명시한다.

## Plan Change Log

### 2026-11-01 — 리뷰1 재도출

세 실제 high finding에 따라 실행 항목에 typed canonical/타입 동등성, 실제 건강 resolution 독립 재계산, batch와 분리한 현재 논리 범위의 전수 대조 및 각각의 실패 회귀를 명시했다. code map의 기존 순수 health 판정과 core snapshot을 재사용하고 지원 버전 metadata만 더하며 기존 공개 계약과 권한은 유지한다. 기존 source 전체 diff를 `/tmp/bmad-14-6-review1-source.patch`로 보존한 뒤 같은 구현자가 제품/시험15파일만 기준 revision으로 되돌렸고, 지휘자는 소스 diff 없음과 계획 보존을 확인했다.

알려진 잘못된 상태는 bool/number 변조가 일치로 통과함, 승인 규칙1이 남아 있어도 다른 실제 권위 규칙으로 선택이 바뀜, 현재 source key의 old-batch 과잉 발행이 검사 범위에서 빠짐이다. KEEP: 기존 전체 소스·시험, 정상/실패 공용 CLI, 단일 공개 투영과 private 권한/원자성, core SELECT grant 비확대·출처/attempt fence·read-only transaction, 원형 codec·현재 FileStore 바이트/metadata, 파일 제외/namespace/관계, 재실행·실제 중단 재개·비발신·sentinel·부모 교체 행렬을 모두 복원·유지한다. 원래 intent-contract는 수정하지 않는다.


### 2026-11-01 — 리뷰2 재도출

Node pg JSONB 기본 parser가 임의 JSON 숫자를 먼저 Number로 반올림하는 경계를 snapshot 전용 PG text/wrapper 및 수신 측 무손실 수치 해석으로 명시했다. 전역 parser나 일반 consumer는 건드리지 않는다. old-batch 논리 범위의 evaluation 키와 inventory 접두 namespace 및 연결 ID의 대응도 실행 항목에 고정했다. 알려진 잘못된 상태는 큰 정수 변조의 잘못된 성공·정상 큰 정수의 거짓 실패와, normal evaluation의 과거 batch `too_large` 모순 inventory가 성공하는 것이다.

같은 구현자가 patch2와 제품·시험 전체 diff의 byte 일치를 확인한 뒤 해당15파일만 기준으로 되돌렸고 지휘자는 소스 diff 없음·계획 보존을 확인했다. KEEP: patch2의 기존 전체 구현과 시험, 첫 세 교정(strict JSON/실제 resolution/old-batch 논리 범위), 출처·attempt·read-only·descriptor·파일 재독해·원형 codec·private/public 단일 투영·재개/비발신/유출/namespace 행렬과 3914/35/13 독립 검증 기록을 보존한다. 원래 intent-contract는 유지한다.

## Review Triage Log

### 2026-11-01 — Review pass 1
- verdicts: 3 findings — high 3, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` typed JSON의 1/true 변조를 Python ==가 같다고 보는 검증 누락 — encoded 형식과 Python dict 비교를 직접 확인했다. source/mapping hash만 확인해 target payload 변조가 성공할 수 있으므로 strict canonical/재귀 타입 대조와 회귀를 계획에 명시한다.
  - `[high]` `[bad_plan]` 실제 선택을 바꾸는 추가 권위 규칙·resolution 미검증 — provenance가 가리키는 revision1만 비교하고 SQL은 더 구체적/높은 revision을 선택한다. 소스 기대 후보와 승인 규칙으로 expected current/selected/unselected/reason/권위를 재계산해 실제 resolution과 비교하도록 계획을 보강한다.
  - `[high]` `[bad_plan]` 이전 batch 재사용 논리 키의 과잉 mapping/발행 누락 — 현재 batch 조건과 all_health 예외가 현재 source identity의 옛 batch 과잉 행까지 제외한다. 현재 논리 범위와 무관한 과거 범위를 분리하고 batch와 무관하게 관련 target 전체를 대조하는 회귀와 구현 기준을 명시한다.

세 항목은 전수 원형·권위·논리 범위 수락 계약의 직접 이탈이며 작은 개별 equality 교체만으로 선택 결과·범위를 해결할 수 없다. 독립 root cause 3개를 각각 유지하고 명확한 재도출 계획으로 처리한다. 재도출 전 소스 patch는 `/tmp/bmad-14-6-review1-source.patch`에 보존했다. 기존 정상·실패 CLI, private/public 분리, 최소권한, descriptor 경계, 파일 bytes, 34개 Python/3914개 기본 검증·모든 행렬 KEEP을 유지한다.


### 2026-11-01 — Review pass 2
- verdicts: 2 findings — high 2, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` core JSONB 숫자가 Node Number를 거쳐 정밀도를 잃어 오판 — pg 기본 JSONB parser와 Buffer만 처리하는 snapshot serializer를 확인했고 서로 다른 큰 정수가 같은 Number가 되는 것을 독립 계산으로 재현했다. snapshot 전용 JSONB를 DB text로 운반하고 수신 측에서 큰 정수·정밀 소수를 무손실 해석하는 계약 및 회귀를 명시한다. 전역 pg parser·일반 consumer 동작은 변경하지 않는다.
  - `[high]` `[bad_plan]` 현재 evaluation의 옛 batch 제외 inventory namespace 과잉 누락 — 정상 evaluation은 inventory가 없지만 마지막 과잉 검사가 batch만 보므로 현재 `(dataset,evaluation,key)`와 `evaluation:<key>` inventory의 연결이 빠진 것을 확인했다. 해당 원형 namespace 및 연결 ID를 현재 논리 범위로 해석해 모순된 이전 batch inventory도 거부하도록 계획을 보강한다.

두 독립 root cause를 각각 유지한다. 기존 세 교정과 전체 KEEP은 `/tmp/bmad-14-6-review2-source.patch`에 보존하고 재도출한다. 이전 reviewer의 세 finding과 같은 위치/같은 주장이 아니므로 carried로 처리하지 않는다. 새 reject/defer는 없다.

## Design Notes

최소권한을 유지하기 위해 DB helper 권한을 새로 열지 않고 supervisor/core가 자기 출처의 계약 자료와 현재 파일 검증을 private snapshot으로 제공한다. core는 Garmin 내부 표를 읽지 않는다. DB 자료는 일관된 읽기 단위로 가져오고 2초 transaction 제한을 유지하며 파일 I/O는 밖에서 수행한다. snapshot은 현재 검사 시점 관찰이며 이후 삭제까지 보증하지 않는다. 다른 capture의 보존 자료는 현재 capture의 extra로 오판하지 않되 현재 논리 범위의 누락·과잉은 감추지 않는다. 과거 kill/재실행을 현 상태만으로 증명할 수 없다는 사실과 시험 증거를 분리한다.

## Verification

- `bash _bmad/custom/bmad-loop-verify.sh` — 기본 빌드·typecheck·전체 TS/PG 시험 성공.
- `pnpm test:python` — 새 verifier 및 기존 tracer/preflight/batch/artifact 포함 전체 Python 통합 시험 성공.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-import-verify.test.ts apps/cli/python-test/garmin-artifacts.test.ts` — 집중 공개 CLI/변조/파일 소실/행렬 시험 모두 실행, skip 없음.
- `git diff --check`와 staged diff 검사 — 공백 오류와 절대 홈 경로·실데이터 없음.
- 시험 구성은 extHome의 격리 PG와 홈, fixture 설치 `.venv/bin/python`, runDaemon의 25ms 감독/드레인이다. checkpoint barrier 후 자식 SIGKILL→exit 확인→새 token으로 같은 batch 재시작, finally에서 daemon abort·store.close·fixture.cleanup 한다. 운영자 전용 외부 작업은 없다.

## 단계1 경계 결정

Node 표준 fs에 dirfd 상대 openat/renameat가 없어 검증 옵션을 초기에는 Python work에 한정한다. 이는 티켓의 Garmin Python runtime을 충족하며 일반 Node 확장에는 새 의존을 만들지 않는다. core 소유 고정 writer가 stdin 자료를 받아 descriptor 기반으로 private snapshot을 쓴다. 실제 bytes와 core files metadata 및 요청 metadata를 모두 대조하고 파일 재독해는 순차/제한 병렬로 메모리를 제한한다.

## 단계1 지휘자 확인

core 자료는 출처 필터와 현재 work/token으로 묶이며 확장 DB 권한 변화는 없다. descriptor writer와 core files/요청/실제 바이트의 hash·size, 순차 재독해를 직접 확인했다. `pnpm exec vitest run apps/cli/test/import-verification.test.ts packages/core/test/extensions.test.ts packages/postgres/test/import-contracts.test.ts` 독립 실행은 3파일83시험 통과, exit 0이다. 원시 로그는 `/tmp/bmad-14-6-phase1-independent.log`에 있다. 부모 교체 강제 경합과 실제 감독자 전수 실행은 단계3에서 확인한다.

## 단계2 지휘자 확인

읽기 전용 비교기·현재 snapshot 확인·단일 공개 투영·고정 실패 경로 및 관련 diff를 확인했다. `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-import-verify.test.ts` 독립 실행에서 정상 전체 검사와 preserved 변조 실패의 공용 CLI 시험 1개가 통과했다. 로그는 `/tmp/bmad-14-6-phase2-independent.log`이다. 이는 전체 행렬 완료를 뜻하지 않으며 단계3에서 변조·소실·재개·비발신·유출·경계 반례를 확대한다.

## 지휘자 독립 Verify 및 Matrix Test Audit

기준 revision의 전체 staged unified diff를 `/tmp/bmad-14-6-full.diff`로 저장하고 전문을 읽었다. `bash _bmad/custom/bmad-loop-verify.sh`는 exit 0, 169파일3914통과·기존 조건부1skip이다. `pnpm test:python`은 exit 0, 7파일34통과·skip없음이다. 계획의 두 파일 집중 명령도 exit 0, 2파일12통과·skip없음이다. 로그는 `/tmp/bmad-14-6-independent-{verify,python,focused}.log`에 있다. staged/unstaged 공백 검사는 성공했다.

| 행렬 | 실행하고 통과한 시험 근거 |
|---|---|
| 정상·버전 | 새 `garmin-import-verify.test.ts`의 합성 전수·schema10/15 v1 부재 시험에서 정상 CLI 전체 true, evaluation 부재 0과 v1 미할당 수를 확인했다. |
| 값·집합 | 같은 전수 시험의 보존 값·자연키 누락/과잉·mapping 삭제/과잉 변조에서 해당 false·실패 exit와 대상 표 전후 동일성을 확인했다. |
| 원형·의미 | `garmin-batch-import.test.ts`의 UTF-16LE/BE 매개 시험에서 NUL·invalid TEXT·JSON 단독 surrogate·빈 원문과 원문 view/DTO를 보존하고 실제 verifier까지 통과했다. 새 전수 시험의 건강 수치·NULL·단위·JSON 변조도 실패했다. |
| 관계·발행 | 새 전수 시험의 dataset-local 부모·legacy·권위·분석 flag/본문/관계 변조가 각각 실패했다. PostgreSQL import-contracts는 타 출처 실제 행 제외와 잘못된 source/token 거부를 확인했다. |
| 파일·제외 | 새 전수 시험의 고정 미선택·제외 사유 기대값과 inventory/provenance 변조, 기존 artifact의 같은 키/대형 evaluation namespace 시험에서 실제 verifier의 건수와 제외를 확인했다. |
| 파일 소실 | 새 전수 시험에서 위치 제거·pending/failed/redacted·blob 삭제·같은 크기 오염 각각 files=false와 실패 exit를 확인했다. core CLI 스냅샷 시험은 실제 bytes·요청/files metadata 및 Buffer 모양 일반 JSON 구분을 확인했다. |
| 변경·권한 | 새 전수 시험의 원본 SQLite 변경·WAL 실패, PostgreSQL 현재 token/source 경계, CLI snapshot 정적 symlink·시도 교체·writer 직전 부모 교체 시험이 통과했다. |
| 재실행·재개·비발신 | 새 전수 시험의 같은 batch identity 불변과 기존 batch의 checkpoint barrier→실제 SIGKILL→exit 확인→새 attempt 재개→공개 verifier 성공, 로컬 발신 수신기·요청·결과 0을 확인했다. |
| 공개 유출 | 새 전수 시험의 계정·날짜·건강값 전용·원문·hash 표식이 정상/실패 stdout/stderr/public.json 및 private에서 직접 실행한 단일 공개 투영에 없었다. 각 변조 후 대상 표 집계가 동일해 검증 비복구도 관찰했다. |

행렬 근거 시험은 전부 실행했고 skip·disabled·필터 제외는 없다. 기본 조건부 skip은 Python 전체 묶음에서 실행했으며 미실행 시험을 행렬 증거로 쓰지 않았다. 합성 fixture·격리 홈/PG 검증이며 운영자 전용 외부 작업은 없다. 독립 리뷰로 진행하며 티켓 done은 표시하지 않는다.

## 재도출1 단계별 확인

typed 단계: 보존15파일을 복원했고 수정 전 1→true가 실제 CLI에서 성공하는 반례를 재현했다. strict 재귀 JSON 비교와 실제 target canonical hash를 소스에서 확인했으며 보존/schema/metadata/건강 JSON의 bool-number 변조 실패, 정상 1/1.0 동등성과 비복구·공개 비유출의 집중 시험 보고를 수락했다. actual resolution과 old-batch 범위 및 전체 독립 재검증은 아직 남았다.

actual resolution 단계: 원본 후보·승인 규칙1·지원 버전으로 기대 current/selected/unselected/reason/dataset/권위를 계산해 core view와 대조하는 코드를 확인했다. 높은 revision 역순·구체 metric·같은 순서의 높은 revision, 정상 version_unsupported와 UTF16 실제 CLI 집중 시험 보고를 수락했다. old-batch 범위 교정과 전체 독립 검증·재리뷰는 남았다.

old-batch 단계: source/artifact/evaluation identity와 분석/요청/관계의 연결 범위를 기준으로 이전 batch 과잉을 검사하는 diff를 확인했다. A→B 정상 재사용과 무관한 과거 보존, 네 과잉의 잘못된 성공 전 재현→각 실패 교정, provenance/artifact 관계 추가 반례의 집중 시험 보고를 수락했다. 전체 독립 Verify와 quick 재리뷰는 이후 진행한다.

## 재도출1 지휘자 독립 Verify 및 Matrix Test Audit

전체 기준 diff를 `/tmp/bmad-14-6-rederive1-full.diff`로 다시 저장했다. 첫 리뷰 전체 diff와 16개 구간을 대조해 10개 구간의 byte 동일·제거 없음 및 변경된 계획/제품/시험6개 구간의 전체 문맥과 delta를 확인했다. strict 비교/target hash, source 기반 resolution과 지원 버전 metadata, old-batch 논리 범위·연결 대상 대조 및 세 실패 회귀가 모든 KEEP 위에 반영됐다.

기본 첫 실행은 변경하지 않은 capture-scan 1시험이 30초에 timeout해 3913통과·1실패·기존1skip이었다(`/tmp/bmad-14-6-rederive1-verify.log`). 해당 파일 단독18시험은 exit 0이며 코드·timeout·기대값을 변경하지 않은 전체 재실행은 exit 0, 169파일3914통과·기존1skip이다(`/tmp/bmad-14-6-rederive1-verify-recheck.log`). `pnpm test:python`은 exit 0, 7파일35통과·skip없음(`/tmp/bmad-14-6-rederive1-python.log`), 계획 집중 명령은 exit 0, 2파일13통과·skip없음(`/tmp/bmad-14-6-rederive1-focused.log`)이다. staged/unstaged 공백 검사도 통과했다.

기존 Matrix Test Audit 전 행을 위 전체 명령에서 다시 실행·통과했다. 추가로 원형·의미 행은 typed 1/true·0/false 및 nested schema/metadata/건강 JSON 변조 실패와 정상 JSON 숫자1/1.0 성공, 관계·발행 행은 높은 revision·구체 규칙·권위 ID 변경의 실제 current 관찰과 독립 resolution 실패 및 정상 지원 버전 사유, 값·집합/파일·제외 행은 A→B old-batch 정상 재사용·무관한 과거 행과 연결 관계 보존 및 이전 batch 과잉 mapping/health·분석 revision·요청·관계·provenance/artifact 관계 실패를 확인했다. 새 반례에서 verifier 비복구와 공개 비유출도 통과했다. 관련 시험의 skip·disabled·선택 제외는 없으며 부분 집중 명령의 제외 시험을 완료 근거로 쓰지 않았다. 기존 세 high finding은 각각 실제 오판 재현→회귀/교정→전체 독립 검증까지 확인했고 새 quick 리뷰를 진행한다.

## 재도출2 단계별 확인

무손실 JSONB 단계: patch2의 전체 KEEP 복원과 PG text wrapper·알려진 두 JSONB 칸의 단일 Decimal 해석을 소스와 시험 delta에서 확인했다. 실제 CLI의 큰 정수 정상 실패·큰 정수 변조의 잘못된 성공을 수정 전 재현한 보고를 수락했다. 큰 정수 정상/변조·정밀 소수·NULL/boolean·숫자1/1.0·최상위 wrapper 모양 JSON·비복구·공개 비유출, UTF16 및 snapshot 집중 회귀가 통과했다. 일반 parser·consumer·권한은 변경하지 않았다. inventory 단계와 전체 독립 Verify·재리뷰는 남았다.

## 2026-11-01 timeout 인계 및 재개

지휘자 90분 timeout으로 중단. 원래 기준은 `573647c4a102ebd6c7fd98efc04364eeb08a81b2`이며 제품·시험 전체 diff와 인계 보고는 `.bmad-loop/runs/20261030-175233-8a92/restore-14.6-timeout.patch`, `/tmp/bmad-14-6-timeout-handoff.md`에 보존했다. 기존 구현자는 관리상 failed 인계로 정식 종료했고 구현 실패로 세지 않는다. 재도출2 집중 시험은 보고됐으나 최신 전체 검증·독립 리뷰는 미완료다. 다음 지휘자는 원래 기준부터 전체 diff와 모든 KEEP을 검토하고 inventory 단계 보고를 확인한 뒤 전체 기본 검증, Python 전체, 계획 집중 시험, 행렬 감사 및 독립 quick 리뷰를 실행하고 발견 사항을 수정한다. 미검증 보존 커밋을 완료로 취급하지 않는다.
