---
title: '기존 분석과 파일 요청의 내구성 있는 반입'
type: 'feature'
ticket: '5'
created: '2026-11-01'
status: 'in-progress'
baseline_revision: '143ebf5fc002a08ba4aba72fe58ef71ae32960c0'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 3
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/tickets/epic-garmin-import/epic-garmin-import.md
  - _bmad-output/personal-brain/prep-garmin-absorption/migration-contract.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 현재 capture 반입은 DB 표를 보존하지만 파일·기존 분석을 발행하지 않는다. tracer의 단일 문서 계약만으로 다중 artifact 관계와 장애 뒤 안전한 정리를 충족하지 못한다.

**Approach:** capture의 리포트·facts·이미지·입력·안전 로그를 안정 식별자로 반입하고 기존 evaluation을 불변 분석과 원문 파일로 발행한다. core의 원자 인계·FileStore·공개 결과·문서 추출을 재사용하고 세 장애 지점과 정리 재개를 실제 프로세스로 검증한다.

## Boundaries & Constraints

**Always:** E14-5·6·11을 충족한다. 리포트·facts마다 분석 한 행과 주 파일 요청을 만들고 PNG·입력은 역할별 요청 관계로 잇는다. source/dataset/원래 표·키·batch/revision과 확인 가능한 날짜·출처를 남긴다. 모델·생성 시각은 근거가 없으면 NULL+각 missing flag이며 mtime을 생성 시각으로 사용하지 않는다. evaluation의 report_date/scope/summary/judgments/evidence/next_checks/report_md/model/created_at을 원형으로 보존한다. NUL·UTF16·비정상 SQLite TEXT는 14.4 원문 bytea/encoding 계약으로 잃지 않는다. 파일은 요청만 INSERT하고 core가 FileStore로 수용한다. 자기 출처 INSERT-only·현재 attempt·불변성과 동일 입력 재조정을 모든 새 계약에 적용한다. 요청/분석/관계/mapping/checkpoint는 짧은 원자 단위이며 파일 I/O는 트랜잭션 밖이다. staging은 Brain 홈의 확장 staging 안 상대 locator·내구 복사이며 원문 해시 검증과 결과 확정까지 보존하고 core가 그 뒤에만 정리한다. 공개 결과는 pending/processing/completed/failed와 재개 가능성을 보인다. 완료된 Markdown은 기존 추출 세대·조각을 만든다. body/profile/inbox는 없음/빈 상태/내용 있음과 측정일·필드별 mtime·원본 관계를 구별한다. 공개 기록은 집계·boolean·고정 오류뿐이다.

**Never:** 원본 수정·normalize/upgrade, 실데이터나 운영 홈 접근, 재분석·모델 호출·수집·발신·push, 기존 적용 migration 수정, 확장의 core SELECT/UPDATE/DELETE 확대, core→garmin FK, 추정 분석 관계·metadata 생성, 비밀 파일 마스킹 후 수용, 완료 전 staging 정리, 티켓 done·tickets.py mark를 하지 않는다. 커밋·계획 상태·최종 완료 판정은 지휘자/엔진 소유다. 완성 import-verify와 실제 Mac 반입은 후속 티켓이다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 파일·분석 | MD·facts JSON/MD·PNG·입력 JSON·같은 basename | 각각 주 분석/파일 및 명시 역할 관계, 원문 해시 보존·재실행 불변 | 관계 근거 없음은 미연결 사유, 임의 결합 금지 |
| 제외 | TOML·비밀 로그·안전 로그 | 설정/검출 로그는 제외 사유, 안전 로그는 파일 수용 | 검사 불가/실패는 허용하지 않음 |
| metadata·evaluation | 모델/시각 없는 문서와 optional evaluation | NULL/flag, 본문·JSON 원형·model·epoch ms·날짜/scope 보존 | 인코딩 손실·mtime 대체 금지 |
| 입력 상태 | body/profile/inbox 없음·비어 있음·내용 있음 | 상태와 값별 mtime·측정일·원본 요청 관계 보존 | 구형 manifest의 미제공 정보는 unknown |
| 장애 수렴 | 요청 commit 뒤·인계 commit 전·put 뒤 결과 commit 전 kill | 종료 확인 후 재시작해 요청당 결과 하나·내용당 파일 하나 | 미확정 DB 단위 rollback·재발견 |
| 바이트 검증 | 예상 hash/size 불일치·같은 크기 기존 blob 손상 | 불일치 요청 failed·신규 파일 없음, 손상 blob 완료/정리 방지 | 고정 오류·재개 의미 일치 |
| 정리 | 완료 전 cleanup·확정 뒤 unlink 실패/kill·locator 공유 | 완료 전 보존·뒤 재정리·다른 미완료 입력 보호 | 실패해도 결과와 원문 보존 |
| 경쟁·권한 | 두 인계·stale claim/attempt·타 source/dataset 관계 | 단일 인계·현재 소유권만 결과/관계 확정 | 거부·기존 대상 불변 |
| 변경·경계 | 같은 key 다른 bytes·동일 크기 변경·symlink/FIFO/traversal | 영속 충돌·재사용 거부·경계 밖 I/O 없음 | 안전한 오류·원본 불변 |
| 추출·가림 | 완료 MD·PNG·redacted 파일 | MD 세대/조각, PNG unsupported 허용, 가린 파일 부활 없음 | 기존 실패/재시도 계약 유지 |

</intent-contract>

## Code Map

- `extensions/garmin/src/{capture_manifest,preflight,import_preflight,batch_import,tracer_import,reader,raw_codec,role_probe,reports}.py` — 엄격 version1·안전 상대 경로·파일 분류·2초 transaction·dataset/mapping/checkpoint·영속 충돌·원문 codec·최소권한·private/public 보고를 재사용한다. 현재 batch는 파일을 발행하지 않고 manifest fingerprint는 파일 bytes를 포함하지 않는다. tracer는 `[dataset,key]` 요청 키와 hash 기반 staging·원래 batch/시각 재사용을 제공한다.
- `packages/postgres/migrations/{0022_import_contracts,0025_original_text,0026_health_json_comparison}.sql` — 불변 analyses/단일 주 요청·공개 결과 view·현재 attempt·RLS·reconcile_import_target. 새 core `0027` 이후와 garmin `0004` 이후만 추가한다. 재조정은 work/token 외 보존 필드를 전부 대조한다.
- `packages/core/src/{ports/import-store,files/import-work,files/extract-work,domain/secret-patterns}.ts`, `packages/postgres/src/{imports,extension-provision,original-text}.ts` — 원자 handoff·DB 밖 put·결과 확정과 기존 추출·Core 단일 비밀 패턴을 재사용한다. 현재 finish 뒤 remove 실패는 삼켜져 완료 work 이후 재정리 근거가 없다. readAnalyses는 a.* 단일 관계뿐이므로 명시 DTO/다중 관계로 확장한다.
- `apps/cli/src/{assembly,daemon/run,daemon/supervisor,runtime/import-staging,runtime/file-store}.ts` — 데몬이 미인계를 재발견하고 drain이 추출을 발견한다. staging은 경계·descriptor 확인을 재사용한다. FileStore 기존 같은 크기 blob은 hash를 확인하지 않으므로 완료 전 readback/해시 검증이 필요하다.
- `apps/cli/python-test/{garmin-tracer,garmin-preflight,garmin-batch-import}.test.ts`, `apps/cli/test/ext-fixture.ts`, `extensions/garmin/tests/fixtures.py`, `packages/postgres/test/{import-contracts,import-retry,import-redaction}.test.ts` — 격리 홈/PG·frozen Python·실제 감독자·attempt·비발신·정리의 시험 기반이다. rich fixture는 user_version15에 optional evaluation 표를 포함하며 user_version16 지원을 뜻하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] 단계1 — `packages/postgres/migrations/0027_analysis_artifacts.sql`, `extensions/garmin/migrations/0004_artifacts.sql`, `packages/postgres/src/{imports,extension-provision,migrate}.ts`, `packages/core/src/ports/import-store.ts`, `extensions/garmin/src/role_probe.py`, 관련 `packages/postgres/test/`와 설치 기대값: 불변 분석 payload·날짜/scope·원문 codec·역할별 request 관계와 core 확정 file 관계, 원자 정리 근거/재탐색을 호환 확장한다. source/dataset/attempt·재조정·기존/신규 role 최소권한을 집중 검증한 뒤 phase-ready로 보고한다.
- [x] 단계2 — `extensions/garmin/src/{capture_manifest,artifacts,analyses,batch_import,preflight,import_preflight}.py`, `extensions/garmin/manifest.json`, `apps/cli/src/daemon/supervisor.ts`와 scanner helper, `extensions/garmin/tests/{fixtures,check_artifacts}.py`, `apps/cli/python-test/garmin-artifacts.test.ts`: version1 호환·version2 명시 provenance와 관계·directory inventory, 파일별 hash/checkpoint·안전 staging, 전수 분류/제외·evaluation·body/profile/inbox metadata 발행을 구현한다. 안전 로그의 검사는 Core maskSecrets/SECRET_PATTERN_VERSION을 사용하는 generic Node helper로 실행하고 Python에 패턴을 복제하지 않는다. 설치 패키지·감독자 경로에서 helper를 전달하며 stdout에는 boolean/version만 허용한다. 집중 합성 반입 후 phase-ready로 보고한다.
- [x] 단계3 — `packages/core/src/files/import-work.ts`, `packages/postgres/src/imports.ts`, `apps/cli/src/{runtime/file-store,daemon/run}.ts`, `packages/postgres/test/import-crash.test.ts`, `apps/cli/python-test/garmin-artifacts.test.ts`, 관련 staging/redaction 시험: 결과 전 blob readback 검증·소유권 fence·재정리·공유 locator 보호를 완성한다. 세 kill 지점·경쟁·변조·경계·추출을 실제 프로세스와 전체 행렬로 검증한다. 계약 문서를 `packages/core/schemas/imports/v1/README.md`에 남기고 전체 구현을 implementation-ready로 보고한다. 같은 Dispatch에서 검증/리뷰 수정을 기다린다.

- [x] 실행1 — Plan Change Log의 경로별 재도출·세 교정과 집중 회귀를 수행하고 implementation-ready로 보고한다.

- [x] 실행2 — Plan Change Log의 metadata 원형·미연결 사유·primary 일치 교정과 집중 회귀를 수행하고 implementation-ready로 보고한다.

**Acceptance Criteria:**
- Given 합성 다종 capture와 명시 분석/이미지/입력 관계, When 설치한 확장을 공용 `brain ext run garmin import`와 실제 데몬으로 실행하고 재실행하면, Then report/facts마다 분석 한 행과 동일 bytes core 파일·PNG/input 역할 관계가 조회되고 대상 ID/건수는 불변이며 안전 로그만 수용되고 설정·비밀 로그는 제외 사유가 조회된다.
- Given 모델/생성 시각 없는 MD와 원형 JSON·비ASCII·특수 TEXT evaluation, When 반입 결과와 core 분석 DTO/파일을 읽으면, Then missing NULL/flag와 원형 본문·JSON·model·created_at·report_date/scope가 일치하고 파일 mtime은 생성 시각으로 들어가지 않는다.
- Given body/profile/inbox가 각각 absent/empty/present인 manifest, When 반입 private 결과와 원본 관계를 조회하면, Then 상태와 측정일·필드별 mtime·source_files 요청 관계가 정확하고 구형 미제공은 unknown이다.
- Given 세 동기화 지점에 도달한 별도 프로세스, When SIGKILL 후 exit를 확인하고 새 프로세스로 재시작하면, Then 요청별 완료 결과/인계가 하나이고 내용당 core 파일이 하나이며 완료 전 정리는 staging을 남긴다.
- Given hash/size 불일치 및 같은 크기 오염 blob, When core 인계를 실행하면, Then 불일치 요청은 failed·안전 error이고 새 파일은 없으며 오염 blob으로 completed·staging 삭제가 일어나지 않는다.
- Given 결과 확정 뒤 unlink 실패/프로세스 종료와 공유 locator, When 데몬을 다시 실행하면, Then 완료 입력만 재정리되고 다른 미완료 요청 바이트는 남으며 Markdown의 추출 세대·조각이 생성된다.
- Given stale attempt/claim·타출처/타dataset 관계·경계 밖 staging·같은 artifact key의 변경, When 쓰기/인계를 시도하면, Then 거부 또는 영속 충돌이 남고 기존 분석·파일·원본과 redaction은 불변이며 HTTP 발신은 0이다.

## Implementation Notes

- 단계2: version2 명시 provenance·다종 파일·evaluation·inventory·Core scanner를 구현했다. 지휘자는 설치 확장의 garmin-artifacts 종단 1시험과 순수 check_artifacts를 독립 실행해 통과했다. 중간에 발견한 명시 created_at 누락은 같은 구현자에게 수정시켰으며 timezone 포함 시각 보존 회귀가 통과했다. version1의 미제공 provenance는 private unknown_provenance로 남긴다. 단계3의 실제 파일 결과·kill·정리/추출 검증은 남아 있다.

- 단계1: 분석 payload·원문 codec·불변 역할 관계·core 정리 근거와 기존/신규 role 권한을 추가했다. 지휘자 독립 집중 검증은 import-contracts·migrate·extension-permissions 3파일27통과다. 구현자의 실제 설치 tracer/preflight 7시험도 통과했으며 최초 준비 실패는 CLI 설치 패키지의 이전 빌드가 원인이었다. 단계2·3은 아직 미완료다.

## Plan Change Log

### 2026-11-01 — 실행 1 재도출

- 원인: evaluation 발행의 snapshot 수명과 단일 분류/지원 텍스트 경계가 실행 항목에서 충분히 구체화되지 않았다. intent-contract는 변경하지 않는다.
- KEEP: 신규 불변 분석/관계와 원문 codec·최소권한·단일 handoff·readback·현재 claim·durable 정리/locator 잠금·실제 kill/restart·가림·비발신·파일 전수 bytes/evaluation/mtime assertion은 그대로 보존한다. 알려진 세 결함 외의 동작과 기존 assertion을 되돌리지 않는다. 보존 patch는 버전 관리 밖 임시 파일에 있다.
- 재도출: 구현자가 본 실행의 소스·시험 diff를 보존 patch에서 확인하고 기준으로 되돌린 뒤, KEEP을 유지하는 동일 기능을 재적용하며 다음 교정을 포함한다. root는 소스·시험을 편집하지 않는다.
- `extensions/garmin/src/batch_import.py`, `extensions/garmin/src/analyses.py`: ingest가 읽기 전후 hash/WAL 검사를 통과한 snapshot 객체와 fingerprint를 발행 단계까지 전달해 evaluation이 같은 불변 입력만 사용하게 한다. 발행 중 파일 재독해로 다른 자료를 혼합하지 않는다. 대안으로 재독해해야 한다면 읽기 전후 및 checkpoint hash/WAL을 대조해 차이는 영속 충돌로 거부한다. 기존 checkpoint를 초기화하지 않는다. `apps/cli/python-test/garmin-artifacts.test.ts`와 필요한 fixture에서 보존 checkpoint 확정과 evaluation 발행 사이 동일 크기 원본 변경을 동기화하여 분석과 보존 원형이 같은 검증본이거나 안전 실패임을 확인한다.
- `apps/cli/src/workers/secret-scan.ts`, `extensions/garmin/tests/check_artifacts.py`, `apps/cli/python-test/garmin-artifacts.test.ts`: UTF-8 decoding 성공만으로 지원 텍스트라고 판단하지 않는다. NUL 포함 UTF-16LE/BE 등 불명 텍스트는 검사 불가로 거부해 원문 자격 증명이 수용되지 않게 하고 정상 UTF-8 안전 로그·비밀 로그의 기존 판정은 유지한다. raw 파일을 마스킹해 수용하지 않는다.
- `extensions/garmin/src/preflight.py`, `extensions/garmin/src/artifacts.py`, `extensions/garmin/tests/check_artifacts.py`: version2는 publisher의 단일 분류 함수를 쓰고 config/unknown 및 안전 override·로그 후보 수와 제외 사유를 실제 반입 의미와 일치시킨다. version1 분류는 호환 유지한다. version2의 명시 config는 확장자와 관계없이 제외하며 명시 unknown도 파일명으로 수용 분류에 올리지 않는다. config/unknown인 .log 반례를 공유 분류와 실제 제외 결과에서 확인한다.
- 집중 시험 뒤 구현자는 implementation-ready를 보고하고, 지휘자는 모든 Verification·행렬 감사와 quick 재리뷰를 수행한다. 최종 보고 전까지 같은 활성 Dispatch를 유지한다.


### 2026-11-01 — 실행 2 재도출

- 원인: 허용된 문자열 metadata의 JSONB 표현과 미연결 사유 보관 위치가 실행 항목에 구체적으로 고정되지 않아 원형/재개와 보고 계약에 틈이 남았다. intent-contract와 baseline은 유지한다.
- KEEP: 실행1의 검증 snapshot 전달·NUL 로그 거부·명시 config/unknown 우선 분류, 기존 분석 원형·관계·권한·전수 파일/metadata 대조·실제 kill/restart·readback·claim·정리·가림·비발신을 모두 보존한다. 본 실행의 전체 소스·시험은 별도 임시 patch로 보존한다. 같은 구현자가 patch의 정확한 역적용·재적용을 확인하여 자신의 diff를 기준으로 되돌린 뒤 KEEP과 아래 교정을 포함해 재도출한다. 계획은 되돌리지 않는다.
- `extensions/garmin/migrations/0004_artifacts.sql`, `extensions/garmin/src/{analyses,batch_import}.py`와 필요한 공통 codec: artifact_inventory와 input_inventory의 metadata를 손실 없이 저장/복원한다. 정상 metadata의 기존 JSONB 모양과 reconciliation은 유지하고, SQL JSONB가 받지 못하는 NUL 포함 키/값은 버전 있는 가역 원문 표현으로 보존한다. 새 bytea/encoding 짝 또는 충돌 없는 버전 codec을 사용할 수 있으며 private 보고·기존 행 재실행·원형 비교는 논리 원문으로 수행한다. dataset label/model/scope/report_date 및 중첩 body metadata의 NUL을 손실 없이 처리한다. 단순 문자 삭제·대체·미지원 거부로 기존 허용 입력을 축소하지 않는다.
- `extensions/garmin/migrations/0004_artifacts.sql`, `extensions/garmin/src/{analyses,batch_import}.py`: 관계 배열이 없거나 빈 수용 PNG/input은 파일을 유지하면서 미연결 사유를 별도 영속 필드로 기록하고 공개 unlinked 집계에 정확히 포함한다. 실제 analysis key가 없는 것을 가짜 참조로 만들지 않는다. 재실행과 명시 관계가 있는 파일의 집계는 중복되지 않는다. 설정 등 제외 파일은 제외로만 센다.
- `packages/postgres/migrations/0027_analysis_artifacts.sql`, `packages/postgres/test/import-contracts.test.ts`: role=primary는 분석의 불변 file_request_id와 일치하는 요청만 허용한다. 같은 출처/dataset이어도 다른 요청의 primary INSERT는 거부하고 올바른 primary 재삽입과 image/input 관계는 유지한다. 기존 기준 migration은 수정하지 않는다.
- `apps/cli/python-test/garmin-artifacts.test.ts`, `extensions/garmin/tests/check_artifacts.py` 및 합성 fixture: NUL metadata/model/dataset label과 body 중첩 키·값의 정확한 원문/private 복원·재실행 성공, relations 생략/빈 PNG/input의 파일 완료와 미연결 사유·공개 건수, primary 불일치 거부를 실제 경계에서 검증한다. 먼저 재도출과 집중 시험 뒤 implementation-ready로 보고하며 전체 Verify·행렬 감사·재리뷰는 지휘자가 수행한다.

## Review Triage Log

### 2026-11-01 — Review pass 1
- verdicts: 3 findings — high 2, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` BOM 없는 UTF-16 로그의 비밀 검사 우회 — 실제 helper에 합성 UTF-16LE 비밀 로그를 주자 성공·hasSecrets=false가 반환됐다. NUL/지원하지 않는 텍스트를 검사 실패로 거부하는 최소 교정과 안전 로그·비밀 로그 회귀가 필요하다. 아래 bad_plan 재도출에 함께 반영한다.
  - `[high]` `[bad_plan]` evaluation 재독해가 검증한 snapshot fingerprint와 분리됨 — ingest의 읽기 전후 hash 검증 뒤 publish가 파일을 다시 읽고 대조하지 않는다. 실행 항목에 검증된 불변 snapshot의 재사용과 중간 동일 크기 변경 회귀를 명시한다. 최초 구현을 임시 patch로 보존하고 같은 구현자가 되돌린 뒤 재도출한다.
  - `[medium]` `[patch]` version2의 config/unknown preflight 분류 불일치 — 순수 호출에서 같은 report.md/category=unknown이 preflight=report, publisher=unknown으로 나왔다. 공유 분류 함수로 일치시키는 최소 교정과 사유/예상 요청 수 회귀를 재도출에 함께 반영한다.


### 2026-11-01 — Review pass 2
- verdicts: 3 findings — high 1, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` NUL metadata의 JSONB 저장 실패 — manifest가 NUL model/scope/dataset 문자열을 허용하고 core는 project로 보존하지만 artifact/input metadata는 원문 dict를 JSONB로 저장해 PostgreSQL이 거부한다. 허용 입력이 요청/분석 커밋 뒤 영구 실패하므로 가역 metadata codec·정상 호환·재실행 원형 비교를 실행2에 고정했다.
  - `[medium]` `[bad_plan]` 관계 없는 PNG/input의 미연결 사유와 집계 누락 — relations 생략/빈 배열이 허용되고 해당 루프 외에는 이유가 기록되지 않아 수용 파일이 unlinked=0으로 보고된다. 실제 분석 참조를 만들지 않는 별도 미연결 사유 보관과 집계를 실행2에 고정했다.
  - `[medium]` `[patch]` 단일 주 요청과 다른 primary 관계 허용 — 관계 trigger의 source/dataset 대조와 (analysis,request,role) UNIQUE는 다른 request의 primary를 막지 못한다. 분석의 file_request_id 일치 조건과 거부/정상 재삽입 회귀를 실행2 재도출에 함께 반영한다.

### 2026-11-01 — 실행3 추적 보완

- 원인: 지휘자 추적과 같은 구현자의 정적 확인에서 artifact의 허용 model/scope/report_date 문자열은 safe_dumps 뒤에도 기존 raw_codec.project의 strict UTF-8 변환에서 실패함을 확인했다. inventory 회귀만으로는 자유 분석 metadata 경계가 닫히지 않았다. intent와 기존 실행3 KEEP은 유지한다.
- `extensions/garmin/src/analyses.py`, `packages/postgres/migrations/0027_analysis_artifacts.sql`, `packages/postgres/src/imports.ts` 및 필요한 분석 전용 codec: 기존 SQLite 원형과 UTF-8/UTF-16 encoding 의미를 유지하며 JSON에서 온 단독 surrogate 문자열을 구별 가능한 버전 원형 표현으로 저장하고 core 분석 DTO에서 정확한 원문 문자열로 복원한다. 새 분석 열만 허용하는 json-string-v1 bytea/encoding 표현과 분석 전용 검증·복원을 사용할 수 있다. 기존 전역 원문 codec의 의미와 이미 적용된 migration은 바꾸지 않는다. 손실·문자 대체만으로 완료하거나 malformed SQLite 바이트와 JSON 문자열의 출처 의미를 혼합하지 않는다.
- `apps/cli/python-test/garmin-artifacts.test.ts`, `packages/postgres/test/import-contracts.test.ts`와 순수 검사: artifact의 model/scope/report_date 각각 단독 surrogate와 NUL·비ASCII를 혼합해 실제 설치 명령·core 분석 DTO·private metadata·같은 입력 재실행에서 정확한 원문을 대조한다. 새 codec 표시값/원형/버전 불일치를 거부하고 기존 SQLite invalid-text 원형과 정상문자 fingerprint를 유지하는 회귀를 보존한다.
- 현재 root 기본 Verify는 성공(168파일3907통과·기존1skip)했고 실행3 순수 네 검사도 성공했다. 이 추가 교정 뒤 전체 검증을 다시 수행한다.

## Design Notes

- full은 pinned이며 원문 손실 위험으로 high다. 14.4의 원형·불변·재조정·비발신은 유지한다. 요청·관계는 UUID/mapping으로 고정하고 분석을 UPDATE해 file_id를 채우지 않는다. 같은 bytes의 파일 하나와 서로 다른 역할 관계 여러 개는 정상이다.
- version2는 파일의 dataset/artifact key/category·명시 analysis 참조/역할과 확인된 metadata, body/profile/inbox inventory를 받는다. version1의 shape는 유지하고 알 수 없는 정보는 unknown/미연결로 보존한다. 경로 유사성만으로 dataset·analysis를 지어내지 않는다. 없음과 빈 폴더는 생산자의 명시 inventory로만 판정한다. 기존 capture 소비자는 계속 동작한다.
- report/facts 주 문서는 원래 bytes 그대로다. evaluation은 원형 각 열을 lossless payload와 보고 Markdown 파일로 함께 보존한다. 새 metadata는 nullable 호환 확장이고 불변 행을 backfill하지 않는다. 데이터 제공자만 알 수 있는 사항을 생성하지 않는다는 기존 C5 계약의 적용이다.
- core 정리는 completed 결과의 durable 일감/상태를 재탐색한다. locator가 같은 미완료 요청이 있으면 삭제를 보류한다. 요청 결과 확정/관계와 추출 발견이 crash 뒤에도 이어져야 한다. scanner 실패·불명 encoding은 안전 로그 수용으로 해석하지 않는다. 기존 32MiB 상한 초과는 명시 too_large 제외/실패와 원본 보존으로 보고한다.
- 운영자만 할 저장소 밖 AC는 없다. 구현자는 소스·시험·계약 문서만 편집하고 계획의 상태·티켓·커밋은 변경하지 않는다. 세 단계의 파일명은 동일 책임으로 세분할 수 있으며 모든 prose 보고는 한국어로 남긴다.

## Verification

**Commands:**
- `bash _bmad/custom/bmad-loop-verify.sh` — build·typecheck·기본 suite 포함 성공.
- `pnpm test:python` — 실제 frozen 설치·공용 명령·감독자·격리 PG/홈의 전체 Python 종단 suite 성공, 신규 skip 없음.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-artifacts.test.ts` — 다종 파일·evaluation·metadata·제외·재개·추출·비발신 집중 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_artifacts.py` — 분류·안정 키·원문 metadata 순수 행렬 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_reader_bytes.py` — 기존 원형 codec 회귀 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_preflight.py` — preflight/version1 호환 성공.
- `uv run --project extensions/garmin --frozen --python 3.14.10 python extensions/garmin/tests/check_batch_import.py` — 기존 mapping/원자 재개 회귀 성공.
- `git diff --check` — 공백 오류 없음.

시험 이름은 구현 보고와 최종 Matrix Test Audit에 기록한다. TS/PG suite와 Python 통합 suite는 role 충돌 방지를 위해 직렬 실행한다. `extHome()`/globalSetup이 compose.test.yaml의 격리 PG와 Brain 홈을 구성하고 실제 설치 interpreter와 데몬을 사용한다. kill 시험은 IPC/DB barrier로 요청 commit 뒤·인계 work INSERT 뒤 commit 전·실제 put 뒤 results commit 전에 도달했음을 확인하고 SIGKILL→exit/close→새 프로세스 재시작 순서를 지킨다. sleep만으로 위치를 추정하지 않는다. cleanup은 결과 미확정 시 실행해 바이트 보존을 별도로 확인한다. finally에서 daemon abort/대기→자식 종료 확인→store close→격리 DB/role/홈/marker 정리하며 자신이 시작한 시험 컨테이너만 종료한다. 실데이터를 fixture로 옮기지 않는다.


## 지휘자 Verify 및 Matrix Test Audit — 2026-11-01

누적 diff 전문을 기준과 대조했다. 지휘자 실행은 `bash _bmad/custom/bmad-loop-verify.sh` 성공(빌드·타입 검사 포함 168파일3907통과·기존1skip), `pnpm test:python` 성공(6파일22통과·skip없음), 별도 garmin-artifacts 1통과, 순수 check_artifacts/check_reader_bytes/check_preflight/check_batch_import 각각 성공, `git diff --check` 성공이다. 원시 로그는 버전 관리 밖에 보존한다. 기본 suite 뒤에는 종단 assertion만 보강했고 해당 집중 시험을 다시 독립 통과했다.

| 행렬 | 실제 실행·통과한 시험과 관찰 |
|---|---|
| 파일·분석 / 제외 | garmin-artifacts의 설치된 감독자 시험: report/facts/PNG/input/안전 로그 다섯 파일 전수 완료·core bytes·요청/core 해시와 크기를 독립 기대값으로 대조했다. 설정·비밀 로그는 사유와 함께 제외됐고 역할 관계·미연결 이유와 재실행 ID 불변을 확인했다. |
| metadata·evaluation / 입력 상태 | 같은 종단 시험에서 NULL/누락 flag·명시 생성 시각과 evaluation 아홉 필드·NUL/비정상 TEXT 원형, body 측정일·필드 mtime·정확한 원본 요청 UUID와 profile empty/inbox absent를 대조했다. version1 미제공 상태는 기존 batch 시험과 unknown inventory 경로에 대응한다. |
| 장애 수렴 | import-crash의 request/handoff/put/result 4행: IPC/DB barrier→실제 SIGKILL→close 확인→새 프로세스 재시작, 원자 rollback과 단일 요청/인계/결과/파일 및 최종 bytes를 확인했다. |
| 바이트 검증 / 정리 | import-safety의 공유 locator·unlink 실패·삭제 뒤 확정 전 SIGKILL·재정리·새 요청 거부, 예상 해시 불일치·같은 크기 오염 blob의 failed/파일 미생성/바이트 보존이 통과했다. import-staging의 크기 불일치도 통과했다. |
| 경쟁·권한 | import-safety의 두 연결 동시 인계·만료/다른 회차 claim 거부, import-contracts·migrate·extension-permissions의 source/dataset·stale attempt·불변·기존/신규 role 검증이 통과했다. |
| 변경·경계 | garmin-artifacts의 동일 크기 원본 변경·영속 충돌, check_artifacts와 import-staging의 symlink/FIFO/traversal·크기/상한·시각 형식 거부, 기존 batch 원형/재개 시험이 통과했다. |
| 추출·가림 | garmin-artifacts의 Markdown bytes·추출 세대/조각·PNG unsupported, import-redaction의 이미 가린 파일과 put 중 가림·삭제 실패 재시도, import-retry의 공개 failed/resumable→completed·staging 정리가 통과했다. |

단계3 구현은 원자 정리 근거와 삭제 시작 표식, locator 직렬화, blob readback 및 claim 시각·회차·만료 fence를 포함한다. 기존 적용 migration과 원본은 변경하지 않았다. 행렬 감사에서 발견한 전수 bytes/evaluation/mtime assertion 부족은 같은 구현자에게 시험 보강으로 해결했고 보강 diff를 재확인했다. 신규 skip은 없으며 운영자만 수행할 저장소 밖 AC도 없다. 최종 완료 판정은 오케스트레이터에 남긴다.


## 실행1 지휘자 재검증

보존 patch의 역적용·재적용으로 KEEP을 유지한 뒤 검증 snapshot 재사용·NUL 로그 거부·공유 분류를 교정했다. 추가로 명시 config/unknown의 .log 확장자 승격도 차단했다. 동결 intent는 보존 해시와 같으며 기존 적용 migration은 바꾸지 않았다.

지휘자 재실행: `bash _bmad/custom/bmad-loop-verify.sh` 성공(168파일3907통과·기존1skip·빌드/타입 포함), `pnpm test:python` 성공(6파일23통과·skip없음), 별도 garmin-artifacts 2통과, 순수 네 검사 각각 성공, diff 검사 성공이다. 전체 기존 행렬이 실행·통과했고 추가 종단 시험은 보존 checkpoint 직후 동일 크기 SQLite 변경을 동기화하여 보존 원형·checkpoint hash·분석이 같은 검증본임을 대조했다. UTF-16LE/BE는 scan_failed로 요청 없이 제외되고 정상 UTF-8 안전/비밀 로그는 기존 판정대로다. 명시 config/unknown .log는 실제 반입에서 각각의 사유로 제외됐으며 preflight의 공유 분류·사유·후보 수를 순수 검사로 대조했다.


## 실행2 지휘자 재검증 및 시험 소유권 교정

실행2 재도출 뒤 기본 Verify는 빌드·타입 포함 168파일3907통과·기존1skip이며 순수 네 검사는 모두 성공했다. Python 전체는 23통과1실패로 tracer의 잠금 오류 retryable 기대가 어긋났다. 독립 반복에서는 통과했고, 코드 추적상 실행 중인 데몬 supervisor와 수동 claim이 경쟁하며 수동 결과를 확인하지 않았다. 같은 구현자가 네 파일 인계 검증 뒤 데몬 종료를 await하고 수동 claim의 정확한 일감·token을 확인하도록 시험을 고쳤다. 실제 잠금·재시도·재개·stale·충돌 assertion과 timeout은 유지했다. 해당 시험 세 반복 및 tracer 6시험은 통과했다. 제품 소스 추가 변경은 없다. 최종 전체 Python 검증과 quick 재리뷰를 수행한다.


### 2026-11-01 — Review pass 3
- verdicts: 2 findings — high 1, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` 허용 metadata의 단독 surrogate가 원형 codec 전에 실패 — inventory metadata는 dict만 검사하고 단독 surrogate를 허용하지만 manifest fingerprint의 비 ASCII UTF-8 인코딩이 실패한다. 합성 manifest 호출로 PREFLIGHT_INVALID를 재현했고 private 보고도 같은 인코딩을 사용한다. 실행3에 정상 fingerprint 호환을 유지하는 가역 직렬화와 전체 private 출력 회귀를 고정한다.
  - `[high]` `[bad_plan]` artifact/evaluation 사이 staging locator 충돌 — 요청 mapping과 request_key는 원래 표를 포함하지만 locator는 dataset/key/hash만 포함한다. 같은 key·본문이면 첫 요청 정리 뒤 아직 등록되지 않은 evaluation 요청이 영속 거부되며 공유 locator 보호는 이미 등록된 요청만 보호한다. 실행3에 원래 표를 포함한 단일 locator 함수와 정리 뒤 재시작 회귀를 고정한다.

### 2026-11-01 — 실행 3 재도출

- 원인: metadata 원형 경로 전체의 문자열 직렬화와 staging identity의 원래 표 구분이 실행 항목에서 빠졌다. intent-contract와 baseline은 유지한다.
- KEEP: 실행1·2의 모든 교정·안전성·행렬과 tracer의 데몬 종료/정확한 claim assertion을 유지한다. 전체 소스·시험 diff를 임시 patch로 보존했다. 같은 구현자는 계획을 제외한 patch의 역적용 가능성·정확한 역적용·재적용을 확인하고 모든 기능과 아래 교정을 재도출한다. 기존 적용 migration·checkpoint·version1의 정상 fingerprint는 바꾸지 않는다.
- `extensions/garmin/src/{capture_manifest,analyses,metadata_codec,reports}.py`와 필요한 직렬화 호출자: JSON escape로 표현 가능한 단독 surrogate를 포함한 허용 metadata 키/값이 capture fingerprint·artifact fingerprint·가역 inventory·private JSON 보고·재실행 전체 경로를 통과하도록 한다. 정상 문자열의 기존 canonical/hash를 보존하고 문제 문자열만 손실 없이 escape하는 공통 직렬화 경계를 사용한다. 문자 삭제·대체·허용 입력 축소는 하지 않는다. 데이터셋 등 식별자의 별도 검증 경계는 실제 계약을 따라 확인한다.
- `extensions/garmin/src/{artifacts,analyses}.py`: staging identity는 요청의 dataset·original_table·key·본문 hash를 모두 포함한다. 생성과 이미 완료된 요청의 locator 복원은 단일 함수를 사용하여 어긋나지 않게 한다. 기존 baseline 적용 migration과 원본은 수정하지 않는다.
- `apps/cli/python-test/garmin-artifacts.test.ts`, `extensions/garmin/tests/check_artifacts.py`와 합성 fixture: metadata의 단독 surrogate 키/값을 실제 설치 명령/private JSON으로 원형 복원하고 동일 입력 재실행이 성공하는지 검증한다. 같은 dataset에서 artifact key를 evaluation canonical key와 같게 하고 bytes도 같게 한 두 요청을 만든다. 첫 artifact 완료·staging 정리 뒤 evaluation 발행 전 종료/재시작을 동기화해 서로 다른 locator·두 요청 완료·내용당 core 파일 하나·불변 재실행을 실제 경계에서 확인한다. sleep만으로 순서를 추정하지 않는다. 집중 시험 뒤 implementation-ready로 보고하고 같은 Dispatch를 유지한다.


## 2026-11-01 감독자 시간 초과 복구

엔진 90분 시간 초과로 기존 구현자를 관리상 인계하고 정식 failed 보고를 수락했다. 기능 실패가 아니며 원래 기준은 `143ebf5fc002a08ba4aba72fe58ef71ae32960c0`이다. 부분 구현을 미검증 보존 커밋으로 보존한다. 전체 diff는 원래 기준부터 확인하고, 최신 분석 metadata 교정 후 기본 Verify·Python 전체 suite·집중 종단·순수 네 검사와 행렬 감사 및 독립 재리뷰를 다시 수행한다. 기존 계약과 모든 KEEP을 유지하고 검증 전 완료로 간주하지 않는다. 기준 수락 후 변경 없음으로 재정지하면 보존 patch를 사용한 엔진 지원 복구 경로를 조사한다. 인계 및 집중 검증 보고는 run task의 Orca 기록과 `/tmp/bmad-14-5-handoff.md`, `/tmp/bmad-14-5-analysis-surrogate-fix.md`에 있다.
