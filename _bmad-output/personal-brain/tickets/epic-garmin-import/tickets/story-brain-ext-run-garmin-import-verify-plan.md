---
title: '원본과 반입 대상의 전수 검증 및 안전한 공개 집계'
type: 'feature'
ticket: '6'
created: '2026-11-01'
status: in-progress
baseline_revision: '573647c4a102ebd6c7fd98efc04364eeb08a81b2'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 5
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

- `extensions/garmin/src/{verify_source,reader,capture_manifest,preflight}.py` — 재도출4는 descriptor로 고정한 SQLite bytes/hash와 메모리 reader·기존 snapshot의 순수 충돌 계산을 연결한다. verifier 경로에서는 source pathname을 hash/SQLite/analyze로 다시 열지 않는다. 기존 importer/preflight의 정상 API·판정과 원형 reader 로직은 유지한다.

## Tasks & Acceptance

**Execution:**
- [ ] 단계1 — `packages/core/src/{extensions/manifest,ports/import-store}.ts`, `packages/postgres/src/imports.ts`, `apps/cli/src/{runtime/import-verification,daemon/supervisor}.ts`와 관련 시험 — 출처 중립의 Python work opt-in `verification_snapshot: true` 계약과 private core snapshot을 구현한다. 초기 버전은 runtime=python에서만 이 옵션을 허용한다. 설치된 pinned Python으로 core 소유의 고정 writer를 실행하고 JSON은 stdin으로 전달해 descriptor 기반 openat/renameat·fsync로 쓴다. Node work에는 Python 의존을 추가하지 않는다. supervisor가 manifest source를 결정하고 source 필터한 건강 전체/권위/분석/요청/관계/legacy/작업 결과를 현재 work/token envelope로 전달한다. bytea는 손실 없는 표현이다. core 파일은 configured FileStore로 현재 재독해하여 실제 hash/size/위치 상태만 담고 경로/bytes는 확장에 주지 않는다. snapshot은 확장 홈 안 원자 0600 파일이고 BRAIN_IMPORT_VERIFICATION_SNAPSHOT으로 경로를 전달한다. 일반 job에는 생성하지 않는다. 타 source 노출·symlink·실패·현재 시도 불일치 시험을 포함한다.
- [ ] 단계2 — `extensions/garmin/src/import_verify.py`와 필요 순수 비교 모듈, `manifest.json` — capture/garmin/core snapshot을 전수 비교하는 읽기 전용 검증기를 구현한다. 새 snapshot envelope의 source/work/token 확인 후 사용한다. core SELECT grant는 추가하지 않는다. 단계별 상세·차이와 고정 공개 투영 하나를 만들고 manifest counts/checks를 일치시킨다. 차이는 기존 EXTENSION_REPORT_NOT_READY로 보고해 CLI가 검사를 출력하고 실패한다.
- [ ] 단계3 — `apps/cli/python-test/garmin-import-verify.test.ts`, `extensions/garmin/tests/fixtures.py`, `apps/cli/test/import-verification.test.ts` 및 기존 batch 시험 — 행렬 전체를 실제 관찰로 검증한다. core 값 변조/파일 위치 삭제 각각 CLI 실패와 해당 false, raw/NULL/단위/JSON/FK/분석/관계 변조, 원본 hash 변경, 재실행 불변, SIGKILL 재개, 비발신 0, 정상/실패 sentinel 비노출을 포함한다. 기대값은 손으로 적어 구현 자체를 되풀이하지 않는다. 단계별 phase-ready 후 전체 implementation-ready를 보고한다.

- [ ] 재도출1 — `extensions/garmin/src/verify_compare.py`, `packages/postgres/src/imports.ts`, `apps/cli/python-test/garmin-import-verify.test.ts` — 보존 patch의 모든 KEEP을 복원하고 아래 세 비교 경계를 구현·회귀 검증한다. (1) typed 보존 payload와 nested metadata/schema/JSON은 bool과 number를 구별해 비교하고 실제 target canonical payload도 원본 hash와 대조한다. JSONB의 정상 숫자 표현 동등성은 유지하되 1/true·0/false를 같다고 보지 않는다. (2) 소스에서 재구성한 기대 건강 후보를 논리 키별로 묶고 승인된 규칙1의 dataset 순서와 지원 정규화 버전으로 current/selected/unselected/reason/dataset/권위 id·version을 독립 계산해 core resolution과 대조한다. core snapshot에 출처 중립 계약 metadata인 `brain.health_supported_versions`의 version 목록을 추가한다. provenance가 가리키는 행만 검사하지 말고 해당 논리 키에 실제 적용된 더 높은 revision/구체 규칙도 결과 비교로 탐지한다. (3) 현재 capture의 `(dataset,original_table,original_key)`와 artifact/relation 논리 identity 및 연결된 분석/요청 ID 범위를 먼저 만든다. 이 범위의 모든 mapping·health·legacy·analysis revision·request·관계·inventory/provenance는 batch와 무관하게 양방향 대조하고, 현재 batch의 무관한 과잉도 거부한다. 과거 다른 capture의 무관한 identity는 보존하며 오탐하지 않는다.
- [ ] 재도출1 회귀 — `apps/cli/python-test/garmin-import-verify.test.ts`와 필요 순수 비교 시험 — target typed integer value 1→true와 nested JSON bool/number 변조가 실패함을 먼저 재현한다. 원래 규칙1을 유지한 채 역순 revision2 또는 더 구체적 규칙을 추가해 실제 current가 달라지는 경우 authority/선택 검사 실패를 보인다. capture A→B의 정상 old-batch mapping 재사용은 성공하며, 같은 현재 논리 키에 A batch의 예상 밖 health mapping/target 및 분석 revision/파일 요청/관계를 각각 더하면 실패한다. 무관한 A의 과거 identity는 남겨도 B 검증이 성공해야 한다. 각 실패는 비복구·공개 유출 없음과 함께 관찰한다. 수정 후 기존 전체 행렬을 그대로 실행하고 독립 Verify·quick 리뷰를 다시 받는다.

- [ ] 재도출2 무손실 JSONB — `packages/postgres/src/imports.ts`, `apps/cli/src/runtime/import-verification.ts`, `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts`, `packages/postgres/test/import-contracts.test.ts` — patch2의 전체 KEEP을 복원한다. snapshot 전용 core JSONB 칸(건강 value_json 및 해당 조회가 운반하는 JSONB payload)을 PG에서 text로 꺼내 `encoding: jsonb-text-v1`과 원문 text `data`를 가진 명시적 wrapper로 운반한다. SQL NULL은 NULL로 유지하고 실제 JSON이 wrapper 모양이어도 한 번만 해석해 원래 객체를 보존한다. Node에서 DB JSON 숫자를 Number로 파싱하거나 재직렬화하지 않는다. Garmin receiver는 알려진 JSONB 칸만 풀고 큰 정수와 정밀 소수를 보존하는 parser(소수는 Decimal)를 사용한다. 숫자 비교는 source의 정상 JSON 숫자 표현과 동등성을 유지하며 bool과 number를 구분한다. 일반 pg 전역 parser·일반 readHealth/다른 consumer·권한·공개 집계 계약은 변경하지 않는다. source 2^53+1의 정상 성공, source 2^53에서 core JSONB만 2^53+1로 바꾼 실패를 먼저 재현하고, nested 정밀 소수 변조·정상 소수/1과1.0·NULL/boolean·wrapper 모양 객체·공개 비유출을 회귀 검증한다.
- [ ] 재도출2 inventory namespace — `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — `(dataset,evaluation,key)`와 inventory `(dataset,evaluation,'evaluation:'+key)`를 namespace를 보존하며 연결한다. 현재 논리 identity 또는 관련 요청/분석 ID에 붙은 inventory는 old-batch라도 예상 집합과 양방향 대조한다. normal evaluation에 `too_large` old-batch inventory를 더한 실제 오판을 먼저 재현해 inventory=false·실패·비복구로 교정한다. artifact의 같은 문자열 키·실제 대형 evaluation·무관한 과거 inventory의 정상 보존과 모든 이전 범위 회귀를 유지한다. 이후 전체 독립 Verify와 quick 재리뷰를 수행한다.

- [ ] 재도출3 내부 JSONB — `extensions/garmin/src/{import_verify,verify_compare}.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — `/tmp/bmad-14-6-dev2-review3-source.patch`의 전체15파일 KEEP을 복원한 뒤 verifier가 읽는 내부 JSONB의 숫자를 반올림 없이 해석한다. psycopg의 verifier 전용 cursor/decoder 경계에서 정수와 소수를 정확히 보존하고, 일반 importer·catalog 후보 변환·전역 parser에는 영향을 주지 않는다. JSON 수치 동등성과 target canonical hash 정렬도 정확한 수치로 비교하여 `1`과 `1.0`, 정상 소수 표기만 동등하게 보되 `1.0000000000000000001`을 `1`로 인정하지 않는다. Decimal 처리 때문에 정상 source float·metadata·schema 또는 private 보고 직렬화가 깨지지 않게 한다. 실제 CLI에서 보존 typed id의 `1→1.0000000000000000001`, schema 숫자와 중첩 inventory metadata의 같은 변조가 수정 전 성공하는 것을 먼저 재현하고, 교정 후 각각 해당 검사 false·실패·비복구·공개 비유출을 확인한다. 정상 `1/1.0`·소수·UTF16·큰 정수/core wrapper 회귀를 유지한다. 완료 후 phase-ready 보고한다.
- [ ] 재도출3 생성 시각 — `packages/postgres/src/imports.ts`, `packages/postgres/test/import-contracts.test.ts`, `apps/cli/python-test/garmin-import-verify.test.ts` — snapshot 전용 분석 `created_at`은 PostgreSQL text로 조회하여 마이크로초와 시간대 의미를 보존하고 수신 측 `time_equal`이 정확한 instant를 비교한다. 일반 연결 timestamptz parser·다른 consumer·publisher·권한은 변경하지 않는다. manifest에 허용된 `.123456` 생성 시각의 정상 반입은 성공하고 target만 1마이크로초 바뀌면 analyses=false·실패하도록 한다. 원본 `.123000`에 target `.123001` 변조가 수정 전 성공하는 반례도 먼저 재현하고 교정한다. 동일 instant의 다른 timezone 표현과 SQL NULL·missing flag의 정상 동작, 비복구·공개 비유출을 유지한다. 같은 parser 경계에 있는 verifier 대조 시각인 health의 observed_at/fetched_at, legacy notification/delivery의 at 및 raw view의 fetched_at/checked_at도 snapshot 전용 text로 보존한다. 원본 epoch ms와 target의 1마이크로초 변조가 같은 밀리초로 잘리는 health/legacy 반례를 실제 CLI에서 먼저 재현하고 해당 검사 실패·비복구·비유출로 교정한다. 일반 연결 parser는 유지한다. 완료 후 phase-ready 보고한다.
- [ ] 재도출3 raw 논리 범위 — `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — 현재 source의 `(dataset,scope,original_key,endpoint)`를 원형 byte/encoding까지 보존한 논리 identity로 잡고, 그 범위에 해당하는 stored raw 및 선언 raw view의 전체 건수·원문·시간·관계를 batch와 무관하게 대조한다. `raw_identity`와 본문이 같은 행만 먼저 걸러 과잉을 숨기지 말고, 현재 논리 키에 다른 raw_identity/본문으로 추가된 이전 batch 행도 거부한다. 현재 batch 예상 밖 raw도 계속 거부하고, 현재 capture와 무관한 A의 정상 과거 raw 및 정상 A→B 재사용은 보존한다. A→B fixture에 같은 현재 자연키·다른 canonical이 아닌 raw_identity·다른 본문의 A batch 행을 추가하여 수정 전 성공을 먼저 재현하고 교정 후 raw=false·실패·비복구·공개 비유출을 확인한다. UTF8/UTF16·NUL/invalid TEXT 원형 구분과 모든 이전 범위·namespace 회귀를 유지한다. 모든 항목 완료 후 implementation-ready 보고하고 전체 독립 Verify·행렬 감사·quick 재리뷰를 수행한다.

- [ ] 재도출4 원본 읽기 경계 — `extensions/garmin/src/{verify_source,reader,capture_manifest,preflight,verify_compare,import_verify}.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — `/tmp/bmad-14-6-dev2-review4-source.patch`의 전체15파일 KEEP을 먼저 복원한다. verifier의 모든 원본 SQLite 읽기·hash·충돌 계산을 동일한 안전한 원본 byte 관찰에 묶는다. 새 `verify_source.py`에서 `/`부터 모든 부모를 `dir_fd` 및 `O_DIRECTORY|O_NOFOLLOW`로 열고 파일은 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`로 열어 regular file을 확인한다. descriptor의 device/inode/size/mtime 및 부모 경계를 기록하고 읽기 전후와 최종 경로 재검사에서 교체·변경·WAL을 거부한다. 읽은 원본 bytes에서 SHA-256을 만들고 그 메모리 이미지로 SQLite 관찰을 만들며 SQLite가 source 경로를 새로 열게 하지 않는다. sidecar가 없는 WAL 이미지의 역직렬화는 SQLite 공식 절차에 따라 magic header와 offset18/19가 모두2인 경우에 한해 메모리 복사본의 이 두 byte만1로 바꿔 읽는 것을 허용한다. 원본 bytes/hash·파일은 바꾸지 않고 다른 header·row·schema 변환은 금지한다. 기존 WAL-mode 재개 fixture에서 원본 byte/hash 불변과 기존 reader의 관찰 동등성을 회귀로 확인한다. `reader.py`의 기존 conn→표 읽기 로직을 재사용할 수 있도록 분리하고 verifier 전용 bytes reader는 `:memory:` 연결의 `deserialize` 후 `query_only`로 읽는다. 원본이나 외부 파일에 SQLite 연결·backup·normalize·쓰기 작업을 하지 않는다. 기존 `read_snapshot(path)` 소비자의 정상 동작은 유지한다.
  capture manifest JSON 읽기와 파일 검증도 descriptor/no-follow로 수행하여 사전 lstat 뒤 경로 재열기로 외부를 읽는 틈을 남기지 않는다. `preflight.py`의 충돌 계산은 이미 읽은 snapshot 집합을 받는 순수 helper로 분리하여 verifier가 `analyze(paths)`로 원본을 다시 열지 않게 한다. 일반 preflight/importer의 기존 API·판정은 유지한다. 최종 source hash/identity 재검사도 no-follow descriptor로 하고 모든 descriptor·메모리 연결은 성공/실패/중단에서 닫는다. SQLite 손상은 `sqlite3.DatabaseError` 등 해당 입력 오류로 안전하게 private/public 불일치 보고와 source_unchanged=false·실패 exit로 이어지며 경로·예외 원문을 공개하지 않는다.
  실제 설치본의 격리 시험 instrumentation/동기화만 사용해 manifest 검증 뒤 첫 source 읽기 직전 파일과 부모 디렉터리 두 경우를 각각 같은 bytes의 외부 사본 symlink로 교체하는 경합을 만든다. 기존 경로 기반 hash가 외부 사본을 열고 원래 경로를 최종 manifest 확인 전에 되돌리면 성공하는 반례를 먼저 재현한다. 교정 후 외부 파일 read/SQLite open이 0이며 경계 거부·실패·비유출임을 확인한다. 관찰 가능한 경로 교체는 거부하고, 이미 붙잡은 원본 descriptor만 사용한 구간에서는 외부 경로를 따라 읽지 않는 것을 입증한다. production test hook은 추가하지 않는다. 원본 byte/hash 불변, 정상 schema10/15·UTF8/UTF16·NUL/invalid TEXT·WAL 및 기존 전체 KEEP 회귀를 유지한다. 완료 후 phase-ready와 한국어 상세 보고를 보낸다.
- [ ] 재도출4 실패 보고·관계·권위 — `extensions/garmin/src/{verify_compare,import_verify}.py`, `apps/cli/python-test/garmin-import-verify.test.ts` — `values_json`이 배열/JSON null인 실제 저장 가능 변조에서도 NULL 집계에서 AttributeError로 보고를 잃지 않도록 shape를 검사하고 실제 preserved=false·private/public 보고·실패 exit를 만든다. 개발 오류를 무차별 성공으로 숨기지 않으며 verifier는 변조 대상을 복구하지 않는다. 내부 `artifact_relations`의 과잉 검사는 현재 두 키뿐 아니라 현재 연결 폐쇄에 속한 request_id/analysis_id도 검사해 옛 batch의 현재 발행 대상 연결 과잉을 거부한다. 현재와 무관한 정상 과거 관계는 유지한다. 관련 ID 범위는 이미 읽은 동일 출처 전체에서 구하며, row.dataset이 현재 capture의 dataset 밖이어도 현재 target/request/analysis ID 또는 현재 논리 request key를 가리키면 제외하지 않는다. mapping·core request/analysis/관계·inventory·내부 관계의 관련 ID 폐쇄와 과잉 검사를 이 규칙으로 일관되게 적용하되 타 source는 읽지 않는다. 현재 capture 밖의 등록된 과거 dataset을 추가한 정상 상태는 성공하고, 그 dataset의 행이 현재 발행 ID를 가리키도록 한 저장 가능한 과잉 mapping/요청/분석/관계/inventory/내부 관계는 각각 수정 전 성공→교정 후 해당 검사 false·비복구·비유출로 확인한다. 연결되지 않은 정상 과거 행은 보존한다. `authority_provenance.revision`도 승인 버전1과 대조한다. 각 배열/null의 보고 소실, 옛 관계의 두 키는 모두 B에 없으나 request_id 또는 analysis_id만 B 대상으로 바뀐 두 경우, provenance revision만 바뀐 경우를 수정 전 실제 CLI로 재현하고 교정 뒤 각각 해당 검사 false·실패·비복구·공개 비유출을 확인한다. 모든 기존 회귀와 단일 공개 투영을 유지한다. 전체 실행 항목 완료 뒤 implementation-ready로 보고하고 전체 독립 Verify·행렬 감사·새 quick 리뷰를 받는다.

- [ ] 재도출5 metadata 표현 — `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts` 및 필요한 기존 artifact 시험 — `/tmp/bmad-14-6-dev2-review5-source.patch`의 제품·시험19파일과 모든 KEEP을 먼저 복원한다. verifier가 artifact/input inventory metadata를 대조할 때 공유 decode_metadata의 기본 float 재해석에 기대지 않는다. 원본 기대 metadata를 기존 encode_metadata의 정해진 표현으로 변환한 기대 JSONB display와 metadata_raw에 대조한다. display는 기존 strict json_equal로 수치·bool·중첩을 비교하고 raw가 있어야 하는 경우 그 canonical 버전 byte를 정확히 대조하며, 없어야 하면 실제 raw도 NULL이어야 한다. 원형 byte를 decode하여 반올림한 값만 비교해 통과시키지 않는다. malformed prefix·불필요 raw·누락 raw·변조 raw도 inventory 불일치로 안전하게 보고하고 복구하지 않는다. 일반 importer·공유 codec·일반 consumer의 기존 API/판정과 JSONB의 정상 수치 동등성은 변경하지 않는다. NUL 또는 단독 surrogate와 숫자1이 있는 input 및 artifact inventory의 정상 상태는 성공하고, raw bytea의 숫자만1.0000000000000000001로 바꾼 오판을 수정 전 실제 CLI로 각각 먼저 재현한다. 교정 뒤 inventory=false·실패·대상 불변·공개 sentinel 비노출을 확인하고 정상 소수·1/1.0 JSONB·원형 metadata 재개를 유지한다. 완료 후 phase-ready와 한국어 보고를 보낸다.
- [ ] 재도출5 발행 보조 필드 — `extensions/garmin/src/verify_compare.py`, `apps/cli/python-test/garmin-import-verify.test.ts` 및 기존 대형 evaluation fixture 시험 — Garmin legacy publisher가 쓰지 않는 original_key_label/original_key_label_raw/original_key_label_encoding은 notification·delivery 모두 NULL이어야 한다. verifier에서 identity·원형 일반 필드와 함께 세 label 칸을 모두 확인한다. plain label만 바꾼 경우와 display가 기존 key와 같아도 raw/encoding을 채운 저장 가능한 경우를 두 표 각각 실제 CLI로 수정 전 성공→교정 뒤 legacy=false·실패·비복구·공개 비유출로 확인한다. 정상 원형 original_id·dataset label과 UTF16/NUL legacy는 유지한다. 대형 evaluation inventory의 metadata_raw와 unlinked_reason도 publisher의 NULL 기대값과 대조한다. 각 칸만 독립 변조한 실제 CLI 오판을 먼저 재현하고 교정 뒤 inventory=false·실패·비복구·공개 비유출을 확인한다. 정상 metadata 객체와 source hash/bytes·제외 reason·요청/분석 NULL·namespace 및 정상 재개를 유지한다. 모든 기존 행렬과 재도출1~4 회귀를 보존하고 전체 implementation-ready 후 지휘자 독립 Verify·행렬 감사·새 quick 리뷰를 받는다.

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

### 2026-11-01 — 리뷰3 재도출

세 실제 high finding에 따라 내부 JSONB의 무손실 decoder/수치·canonical 비교, snapshot 전용 분석 생성시각 text 운반, batch와 무관한 raw 자연키·원문 양방향 전수 비교를 별도 실행 단계와 실패 회귀로 보강했다. 기본 psycopg decoder의 소수 반올림이 typed 값 변조를 성공시키고, 연결 Date parser가 정상 마이크로초를 잃거나 변조를 숨기며, old-batch raw의 같은 자연키 과잉이 body 필터와 batch 필터 사이에서 누락되는 잘못된 상태를 막는다. `json_equal`/hash 오판은 지휘자 순수 실행으로 확인했고 timestamp 허용·발행·parser 및 raw 제약·필터는 주변 코드로 검증했다.

KEEP: 보존 patch `/tmp/bmad-14-6-dev2-review3-source.patch`의 전체15파일과 기존 세 단계·재도출1·2의 모든 정상/실패 회귀, source/attempt/read-only·2초 제한·descriptor·FileStore bytes·원형 codec·단일 공개 투영·private 권한·관계/namespace·재실행·실제 SIGKILL 재개·비발신·sentinel·부모 교체 행렬을 유지한다. 일반 parser/catalog/consumer·권한·기존 migration·intent-contract는 변경하지 않는다. 같은 구현자가 patch byte 일치를 확인하고 해당15파일만 baseline으로 되돌렸으며 지휘자는 제품·시험 diff 없음과 계획 보존을 직접 확인했다. 이전 3915/38/16 독립 검증은 교정 전 근거이며 교정 후 전체 검증을 다시 수행한다.

### 2026-11-01 — 리뷰4 재도출

네 독립 finding을 주변 호출과 DDL에서 확인했다. 내부 관계는 키만 범위 검사해 연결 ID의 옛 과잉을 빠뜨리고, values_json 배열/null은 `.get`에서 AttributeError로 불일치 보고를 잃으며 손상 SQLite의 DatabaseError도 입력 오류 처리에서 빠진다. source manifest의 사전 검사 뒤 digest·reader·analyze가 pathname을 다시 열어 symlink 경합에서 capture 밖을 읽을 수 있고, authority provenance revision은 읽고도 비교하지 않는다. 관계/권위의 양방향 대조 및 실패 보고를 보강하고, source 읽기·hash·parser·충돌 계산을 pinned descriptor bytes에 묶는 설계를 실행 항목에 명시했다. source 경계는 새 안전 helper·메모리 SQLite reader·순수 snapshot 충돌 계산으로 나누어 검증한다.

KEEP: `/tmp/bmad-14-6-dev2-review4-source.patch`의 전체15파일과 모든 재도출1~3의 숫자·typed/hash·JSONB wrapper·전체 시각·권위 resolution·old-batch 범위·raw 원형 cardinality, 기존 정상/실패 CLI·private/public·최소권한·2초 DB 제한·attempt fence·descriptor writer·FileStore bytes·분류/namespace·재실행·SIGKILL 재개·비발신·sentinel·부모 교체 회귀를 유지한다. intent-contract·일반 parser·권한·기존 migrations는 변경하지 않는다. 일반 reader/preflight/importer의 기존 정상 API·판정은 유지한다. 같은 구현자가 source patch byte 일치와 해당15파일의 baseline 복귀를 보고했고 지휘자는 제품·시험 diff 없음과 계획 보존을 확인했다. 이전 3915/40/18 독립 검증은 교정 전 기록으로 보존하고 새 교정 뒤 다시 실행한다.

### 2026-11-01 — 리뷰5 재도출

metadata_raw의 기본 decode_metadata가 bytea JSON의 정밀 소수를 float로 반올림해 변조를 숨기는 것을 실제 함수로 재현했다. verifier의 artifact/input metadata는 원본 기대값을 기존 canonical encoder로 투영한 JSONB display와 raw bytes 양쪽에 대조하도록 실행 항목을 명시했다. 일반 codec·importer·consumer를 변경하지 않고 JSONB의 정상 숫자 동등성은 유지한다. legacy 원래 키 label3칸은 publisher가 쓰지 않아 NULL이지만 consumer는 있으면 originalKey를 덮어쓰므로 모두 검증한다. 대형 evaluation에서 빠진 metadata_raw·unlinked_reason도 발행자의 NULL 기대값과 대조하도록 보완했다. 알려진 잘못된 상태는 정밀 raw 숫자 변조의 정상 판정, 표시 키가 달라진 legacy의 성공, 실제 보고 decoder가 거부하는 대형 evaluation inventory의 성공이다.

KEEP: `/tmp/bmad-14-6-dev2-review5-source.patch`의 전체19파일과 기존 모든 구현·시험, 재도출1~4의 수치/시각/raw/namespace/권위 resolution/old-batch 및 동일 출처 전체 ID폐쇄·capture밖6종 연결 교정, 안전한 descriptor·메모리 SQLite·WAL 원본 불변/관찰동등성·shape보고·revision1, 기존 CLI·최소권한·attempt/read-only·FileStore bytes·단일 공개 투영·비복구·비발신·SIGKILL 재개·sentinel 회귀를 유지한다. intent-contract·일반 parser·공유 codec·권한·기존 migrations는 변경하지 않는다. 같은 구현자가 source patch 독립 byte 일치와 역·정방향 적용 검사를 확인하고 제품·시험19파일만 baseline으로 되돌렸으며 지휘자는 제품 diff 없음과 계획 보존을 직접 확인했다. 3915/42/20 독립 검증은 교정 전 기록으로 보존하고 교정 뒤 전체를 다시 실행한다.

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

### 2026-11-01 — Review pass 3
- verdicts: 3 findings — high 3, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 내부 JSONB 정밀 소수 반올림으로 typed/schema/metadata 변조 누락 — 기본 decoder와 비교·hash 정렬을 대조했고 AST에서 추출한 실제 함수로 `1.0000000000000000001`의 equal/hash 성공을 재현했다. verifier 전용 무손실 decoder와 정확한 수치·hash 동등성 및 세 실제 CLI 실패 회귀를 실행 항목에 명시했다.
  - `[high]` `[bad_plan]` 분석 생성시각 밀리초 절삭으로 정상 실패·미세 변조 누락 — manifest의 마이크로초 허용, Python publisher의 정확한 저장, connect.ts의 Date parser와 snapshot `select *` 및 `time_equal`을 직접 대조했다. snapshot 전용 created_at text 운반과 정상/1마이크로초 변조·timezone·NULL 회귀를 실행 항목에 명시했다.
  - `[high]` `[bad_plan]` 이전 batch raw의 현재 자연키 과잉 누락 — 0002/0003 제약은 별도 raw_identity의 동일 자연키 행을 허용하고 verifier는 rid/body 일치 행을 먼저 고른 뒤 현재 batch만 과잉 검사한다. 원형 자연키에 따른 batch 독립 stored/view 전수 대조와 A→B 반례·무관한 과거 보존을 실행 항목에 명시했다.

세 독립 root cause는 이전 로그의 core Node JSONB·health/mapping 범위와 위치/주장이 다르므로 carried로 처리하지 않는다. 보존 patch와 KEEP을 유지해 재도출하며 새 reject/defer는 없다. 리뷰 워커의 정식 성공 보고와 전문을 수락하고 release·mail ack를 완료했다.

### 2026-11-01 — Review pass 4
- verdicts: 4 findings — high 3, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 내부 artifact 관계의 연결 ID 범위 누락 — internal 표의 조건은 두 문자열 키만 보고 core 관계 폐쇄/inventory에만 관련 ID 검사가 있음을 확인했다. 해당 표 DDL에는 키/ID 일치 제약이 없어 B의 발행 ID를 가리키는 옛 관계가 실제로 범위에서 빠진다. 내부 관계에도 현재 request/analysis 연결 폐쇄를 적용하고 두 ID별 실제 CLI 실패 회귀를 계획에 명시했다.
  - `[medium]` `[bad_plan]` 보존 배열/null 및 손상 SQLite 예외의 불일치 보고 소실 — values_json의 JSONB NOT NULL은 배열과 JSON null을 허용하고 NULL 집계의 `.get`이 AttributeError를 내며 top-level IMPORT_INVALID는 보고를 읽지 않는 경로임을 확인했다. target shape 검증과 해당 입력 오류 분류·실제 CLI의 private/public 및 항목별 false 회귀를 계획에 명시했다.
  - `[high]` `[bad_plan]` SQLite source pathname 재열기의 symlink 경합 — capture의 lstat 뒤 Path.open·SQLite URI·analyze(paths)의 재열기가 모두 존재하고 inode/descriptor 고정이 없음을 확인했다. 동일 byte 외부 사본 후 복귀는 hash·최종 fingerprint로 배제되지 않는다. JSON manifest와 SQLite를 no-follow descriptor로 읽고 동일 bytes의 memory reader·순수 충돌 계산 및 최종 identity 검사를 수행하도록 설계와 파일/부모 경합 회귀를 명시했다.
  - `[high]` `[bad_plan]` 권위 provenance revision 비교 누락 — importer는1을 기록하지만 verifier의 found 조건·compare_resolution 모두 이 필드를 확인하지 않고 core 승인 버전은 별도로1을 만들고 있었다. 승인 버전과 실제 ledger revision 대조 및 revision 단독 변조의 실제 CLI 실패 회귀를 계획에 명시했다.

네 항목은 이전 로그와 다른 표·입력 shape·source 경계·ledger 필드의 주장으로 carried가 아니다. 새 reject/defer는 없고 네 계약 이탈을 재도출4에서 함께 교정한다. reviewer의 정식 성공 보고와 전문을 수락하고 release·mail ack를 완료했다.

### 2026-11-01 — Review pass 5

- verdicts: 3 findings — high 3, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` metadata_raw 정밀 수치 변조 누락 — 공유 decoder의 기본 json.loads와 verifier 호출을 대조하고 실제 decode_metadata·json_equal로1.0000000000000000001이1과 같다고 판정됨을 독립 재현했다. 원본 기대 display/raw 표현의 양방향 대조 및 input/artifact 실제 CLI 반례를 실행 항목에 명시했다.
  - `[high]` `[bad_plan]` legacy original_key_label3칸 검증 누락 — publisher의 NULL 기대, DDL의 저장 허용, channels consumer의 originalKey override 및 verifier의 누락 조건을 확인했다. 두 legacy 표의 plain/raw label 변조 실제 CLI 회귀와 세 칸 NULL 대조를 실행 항목에 명시했다.
  - `[high]` `[bad_plan]` 대형 evaluation inventory 보조 필드 누락 — publisher의 metadata_raw/unlinked_reason NULL 기대와 verifier의7필드 비교·예상identity 과잉검사 제외, 공유 보고 decoder의 비빈 display/raw 거부를 확인했다. 두 칸 독립 실제 CLI 변조와 NULL 기대 대조를 실행 항목에 명시했다.

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


## 재개2 지휘자 독립 Verify 및 Matrix Test Audit

원래 기준 `573647c4a102ebd6c7fd98efc04364eeb08a81b2`부터 제품·시험15파일과 계획의 전체 unified diff를 `/tmp/bmad-14-6-dev2-full.diff`로 기록하고 전문을 검토했다. 재도출2의 namespace·연결 ID 대조와 무손실 JSONB, 기존 모든 KEEP을 확인했다. 새 구현자는 기존 구현을 대조하고 수정 없이 집중16시험 통과를 보고했다.

지휘자 독립 실행은 `bash _bmad/custom/bmad-loop-verify.sh` exit 0, 169파일3915통과·기존 조건부1skip(`/tmp/bmad-14-6-dev2-verify.log`), `pnpm test:python` exit 0, 7파일38통과·skip없음(`/tmp/bmad-14-6-dev2-python.log`), 계획의 두 파일 집중 명령 exit 0, 2파일16통과·skip없음(`/tmp/bmad-14-6-dev2-focused-independent.log`)이다. staged/unstaged 공백 검사도 통과했다.

기존 행렬의 정상·버전, 값·집합, 원형·의미, 관계·발행, 파일·제외, 파일 소실, 변경·권한, 재실행·재개·비발신, 공개 유출 모든 행의 근거 시험을 위 전체 명령에서 다시 실행·통과했다. 새 verifier6시험의 정상/변조·schema10/15·old-batch·큰 정수 정상/변조·wrapper, batch5시험의 UTF16LE/BE·실제 SIGKILL 재개·비발신, artifact10시험의 동일 namespace·대형 evaluation·기존 파일 행렬과 기본 snapshot/PG/manifest 시험을 실제 include 및 선언에 대조했다. 행렬 근거에는 skip·disabled·필터 제외가 없다. 기본 조건부 skip은 Python 전체에서 실행됐다. 개인 값이나 원시 private 보고를 계획에 복사하지 않았으며 운영자 전용 외부 작업은 없다.

이전 batch의 정상 재사용·무관한 과거 보존과 모순 inventory 실패·비복구, 큰 정수·정밀 소수·bool/number·wrapper의 정상/실패, 각 공개 투영의 개인 표식 비노출을 확인했다. 과거 재개 이력과 v1 미할당 파일의 과거 해시는 현 상태만으로 입증하지 않는 기존 한계를 유지한다. 독립 quick 재리뷰로 진행하며 done은 엔진 소관이다.

## 재도출3 단계별 확인

내부 JSONB 단계: 내부 Garmin 표 전용 cursor의 Decimal decoder, 정확한 십진 수치 동등성과 canonical hash 정렬 및 세 실제 CLI 변조 회귀의 delta를 확인했다. 수정 전 세 오판 재현과 교정 후 해당 검사 실패·비복구·공개 비유출, verifier와 batch 전체11시험·정상 소수 metadata 집중 통과 보고를 수락했다. catalog·전역 parser·일반 consumer는 유지했다. 생성시각·raw 범위 및 교정 후 전체 독립 Verify·재리뷰는 남았다.

생성시각 단계 추가 추적: 같은 연결 Date parser를 지나는 health observed_at/fetched_at과 legacy at도 source의 ms 경계 안 1마이크로초 변조를 숨길 수 있어, 동일 root cause의 교정 범위를 verifier가 대조하는 모든 시각 칸으로 명시했다. raw view의 fetched_at/checked_at도 같은 운반 규칙을 적용한다. 일반 연결·publisher·다른 consumer는 유지하며 실제 health/legacy 오판 재현 및 실패 회귀를 추가한다.

시각 단계: 분석 created_at과 건강·legacy·raw의 대조 시각이 snapshot 전용 PostgreSQL text로 운반되는 SQL 및 회귀 delta를 확인했다. 분석 정상 마이크로초 거짓 실패·미세 변조 성공 및 health/legacy 네 미세 변조 오판의 수정 전 실제 CLI 재현과 교정 후 해당 검사 실패·비복구·공개 비유출 보고를 수락했다. verifier 전체8시험·PG 계약3시험이 통과했고 시간대·NULL·raw view 정밀도를 유지했다. raw 논리 범위 및 교정 후 전체 독립 Verify·재리뷰는 남았다.

raw 단계: stored raw와 선언 view를 원형 자연키로 먼저 묶고 batch·본문과 무관하게 cardinality를 검사한 뒤 account·본문·시간·canonical id를 대조하는 delta를 확인했다. A→B의 옛 batch 과잉 실제 CLI 오판 재현과 교정 후 실패·비복구·공개 비유출, 정상 재사용·무관한 과거 raw 보존 및 통합3파일23시험 통과 보고를 수락했다. 기존 source patch와 전체 diff를 대조해 동일10구간·변경5구간·제거없음을 확인하고 변경된 source/시험 delta 전문을 읽었다. 교정 후 전체 독립 Verify와 quick 재리뷰로 진행한다.


## 재도출3 지휘자 독립 Verify 및 Matrix Test Audit

원래 기준부터 전체 unified diff를 `/tmp/bmad-14-6-dev2-rederive3-full.diff`로 갱신했다. 리뷰3 보존 source patch의 동일10구간은 byte 일치를 확인했고 변경5구간의 소스·시험 전체 문맥과 delta를 전문 검토했으며 제거 구간은 없다. 원래 intent-contract·기존 전체 KEEP 및 새 내부 JSONB·대조 시각·raw 자연키 교정을 유지했다.

첫 기본 검증은 새 PG 시험의 optional 배열 접근 세 곳에서 TS18048로 실패했다(`/tmp/bmad-14-6-dev2-rederive3-verify.log`). 같은 구현자가 기대값 불변의 optional chaining 세 줄만 교정하고 typecheck·PG3시험을 통과했다. 다음 기본 실행은 미변경 unavailable의 terminated 시험 하나가 30초 timeout으로 실패했다(`/tmp/bmad-14-6-dev2-rederive3-verify-recheck.log`). 해당 시험은 imports를 순회에서 명시 제외하며 이 티켓의 소스·시험 timeout·기대값을 바꾸지 않았다. 단독10시험은 exit 0(`/tmp/bmad-14-6-dev2-rederive3-unavailable.log`), 변경 없는 전체 기본 재실행은 exit 0, 169파일3915통과·기존 조건부1skip(`/tmp/bmad-14-6-dev2-rederive3-verify-final.log`)이다.

`pnpm test:python`은 exit 0, 7파일40통과·skip없음(`/tmp/bmad-14-6-dev2-rederive3-python.log`), 계획의 두 파일 집중 명령은 exit 0, 2파일18통과·skip없음(`/tmp/bmad-14-6-dev2-rederive3-focused.log`)이다. staged/unstaged 공백 검사도 통과했다.

기존 Matrix Test Audit의 아홉 행을 현재 시험 선언·include·성공 결과에 다시 대조했다. 정상/버전·값/집합·원형/의미·관계/발행·파일/제외·파일 소실·변경/권한·재실행/재개/비발신·공개 유출 모두 covering test가 실제 실행·통과했다. verifier8시험, batch5시험, artifact10시험과 기본 snapshot/PG/manifest 시험이 기존 모든 행렬과 세 번의 재도출 회귀를 포함하며 skip·disabled·선택 제외를 근거로 쓰지 않았다. 기본 조건부 skip은 Python 전체에서 실행됐다.

추가로 실제 공용 CLI의 내부 typed/schema/metadata 미세 소수 변조, 정상 소수와 1/1.0, 마이크로초 생성시각 정상/1마이크로초 변조·timezone/NULL, health 두 시각·legacy 두 표의 미세 시각 변조, A→B raw의 같은 원형 자연키 과잉과 무관한 과거 보존이 실행·통과했다. 각 변조는 해당 검사 false·실패·비복구·공개 표식 비노출을 확인한다. 운영자 전용 외부 작업은 없고 합성 데이터·격리 홈/PG만 사용했다. 새로운 독립 quick 리뷰로 진행하며 티켓 done은 엔진 소관이다.


재도출4 WAL 읽기 결정: sidecar 없는 WAL-mode 이미지에 대한 메모리 deserialize의 SQLITE_CANTOPEN을 기존 재개 회귀에서 관찰했다. [SQLite 공식 deserialize 문서](https://www.sqlite.org/c3ref/deserialize.html)는 메모리 입력의 offset18/19를1로 바꾸는 호환 방법을 명시한다. 이를 정상 magic·두 WAL byte2·sidecar 부재 조건에 한정하고, 원본 hash와 bytes 및 파일은 그대로 두며 메모리 복사본의 저널 flag만 바꾼다. 값·schema·원형 관찰은 기존 reader와 같아야 한다. 이는 원본에 normalize/upgrade/쓰기 하는 작업을 허용하지 않으며 intent-contract는 유지한다.

재도출4 연결 범위 추가 추적: 같은 source의 전체 snapshot에서 관련 request/analysis/target ID를 알고도 row.dataset이 현재 capture 밖이라는 이유로 과잉 검사를 생략하는 조건이 남아 있음을 확인했다. 현재 ID에 연결된 행은 무관한 과거 행이 아니므로, 기존 연결 범위 교정의 동일 원인으로 dataset 밖 등록 이력까지 포함하도록 두 번째 실행 항목을 명확히 했다. 타 source 조회/권한은 유지하며 저장 가능한 실제 CLI 반례와 정상 비연결 과거 보존을 검증한다.


## 재도출4 단계별 확인

원본 단계: 모든 부모와 파일을 no-follow descriptor로 열고 동일 byte의 hash·메모리 SQLite 관찰·순수 충돌 계산을 사용하며 최종 source 및 manifest identity를 재검사하는 변경을 확인했다. 기존 read_snapshot과 analyze API는 유지했다. 공식 SQLite 절차에 한정한 메모리 WAL flag 처리는 원본 불변 및 기존 reader와 전체 관찰 동등성 시험으로 검증했다. manifest 검사가 끝난 compare의 첫 source 읽기에서 파일·부모 각각의 동일 byte 외부 symlink 교체를 시도하고, 수정 전 외부 open 및 잘못된 성공과 수정 후 외부 open 없음·실패를 실제 CLI로 관찰했다. 제품 시험 hook은 없다.

비교 단계: 보존 배열/JSON null의 shape guard와 손상 SQLite 입력 오류 분류, 내부 관계의 현재 request/analysis ID 범위, provenance revision1 대조를 확인했다. 같은 출처의 현재 capture 밖 dataset까지 관련 ID 폐쇄와 과잉 검사를 확장했다. mapping·요청·분석·core 관계·inventory·내부 관계 여섯 실제 CLI 반례의 수정 전 성공과 수정 후 해당 false·실패·비복구·공개 비유출 보고를 수락했다. 비연결 과거 dataset의 정상 성공과 기존 A→B 재사용은 유지됐다. 구현자의 통합3파일25시험·typecheck 성공 후 지휘자 독립 검증으로 진행했다.


## 재도출4 지휘자 독립 Verify 및 Matrix Test Audit

기준573647c4a102ebd6c7fd98efc04364eeb08a81b2부터 전체 unified diff를 `/tmp/bmad-14-6-dev2-rederive4-full.diff`에 갱신했다. 이전 전체 diff와 동일11구간·변경9구간을 byte 대조하고 변경 소스·시험 delta 및 새 verify_source 전문을 읽었다. 기존 KEEP과 intent-contract는 유지했다.

첫 기본 실행은 미변경 install-orbstack의 재시작 시험 하나가30초 timeout으로 실패했다(`/tmp/bmad-14-6-dev2-rederive4-verify.log`). 관련 setup·doctor 문맥을 확인한 뒤 코드·기대값·timeout 변경 없이 단독16시험이 통과했고(`/tmp/bmad-14-6-dev2-rederive4-install-isolated.log`), 전체 기본 재실행은 exit0·169파일3915통과·기존조건부1skip이었다(`/tmp/bmad-14-6-dev2-rederive4-verify-final.log`). `pnpm test:python`은 exit0·7파일42통과·skip없음(`/tmp/bmad-14-6-dev2-rederive4-python.log`), 계획의 두 파일 집중 명령은 exit0·2파일20통과·skip없음(`/tmp/bmad-14-6-dev2-rederive4-focused.log`)이다. staged/unstaged 공백 검사도 통과했다.

기존 Matrix Test Audit의 아홉 행을 실제 시험 선언·include·성공 결과와 다시 대조했다. 정상·버전, 값·집합, 원형·의미, 관계·발행, 파일·제외, 파일 소실, 변경·권한, 재실행·재개·비발신, 공개 유출을 verifier10·batch5·artifact10과 기본 snapshot/PG/manifest 시험이 포함하며 모두 실행·통과했다. 조건부 기본skip은 Python 전체에서 실행됐고 선택 제외·disabled 시험은 근거로 쓰지 않았다.

추가 회귀인 보존 배열/null의 항목별 보고·비복구, 손상 SQLite의 안전한 보고, manifest 확인 뒤 source 첫 읽기의 파일·부모 symlink 경합 거부 및 외부 open0, WAL 원본 bytes/hash 불변·기존 reader와 전체 관찰 동등성, 내부 관계의 두 연결 ID, 권위 ledger revision, capture밖 같은 출처의 여섯 과잉 연결과 비연결 과거 보존도 실제 CLI에서 실행·통과했다. 이전 정밀 숫자·시각·raw 자연키·namespace 회귀도 유지했다. 합성 격리 자료만 사용했고 운영자 전용 외부 작업은 없다. 새 독립 quick 리뷰로 진행한다. 티켓 done은 엔진 소관이다.


## 2026-11-01 두 번째 timeout 인계

지휘자 dev-2가 90분 timeout으로 멈췄다. 기존 구현자는 관리상 failed 인계로 정식 종료·release 및 delivery ack했으며 구현 실패로 세지 않는다. 원래 기준 `573647c4a102ebd6c7fd98efc04364eeb08a81b2`, 이전 미검증 WIP `1a8df1a`와 리뷰5의 19파일 보존 patch 및 전체 인계 보고는 run의 `bmad-14-6-dev2-review5-source.patch`, `14.6-dev2-handoff.md`에 보존했다. 현재 변경은 미검증이며 완료가 아니다.

재추진은 세 단계로 나눈다: (1) metadata 원형의 display/raw 정확한 대조와 input/artifact 정밀 소수 변조 시험의 임시 성공 기대를 실패 기대와 inventory=false로 고친다. (2) legacy 두 표의 label 세 칸 NULL 계약과 plain/raw 변조를 검증한다. (3) 대형 evaluation의 metadata_raw 및 unlinked_reason NULL 계약과 각각의 변조를 검증한다. 각 단계에서 기존 전체 KEEP과 정상·실패·비복구·비유출 시험을 유지하고 단계별 보고를 수락한다. 그 후 원래 기준 전체 diff, 전체 기본 검증, Python 전체, 행렬과 독립 리뷰를 다시 수행한다. 이전 통과 결과는 리뷰5 교정 전 증거일 뿐이다.
