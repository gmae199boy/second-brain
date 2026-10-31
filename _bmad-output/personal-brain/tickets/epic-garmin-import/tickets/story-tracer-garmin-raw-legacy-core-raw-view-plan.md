---
title: 'Garmin 합성 raw·legacy 문서의 core tracer'
type: 'feature'
ticket: '1'
created: '2026-10-31'
status: 'in-review'
baseline_revision: 'aa67551a81383a6b13967a5b724825fefb69636e'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 설치·감독자 기반은 있지만 Garmin 패키지와 건강·분석·파일 요청 계약이 없어 기존 원문을 core에서 읽을 수 없다.

**Approach:** 설치된 Python 확장이 합성 schema15 snapshot의 raw 한 건·일 지표 하나와 legacy Markdown 하나를 이전하고, core가 파일 요청을 FileStore·문서 추출로 인계하는 가장 얇은 경로를 만든다.

## Boundaries & Constraints

**Always:** Python 3.14.10과 psycopg[binary] 3만 잠근다. 표준 sqlite3 read-only URI로 snapshot을 읽는다. raw TEXT·UTF-8·epoch ms·NULL과 dataset·batch·원래 키를 보존한다. UUID·시각·해시는 작성자가 공급한다. 건강·분석·파일 요청은 불변이며 source에 결합한 RLS INSERT와 현재 attempt fence를 적용한다. core는 출처 중립 port와 선언된 raw view만 읽는다. 파일 I/O는 PG 트랜잭션 밖, 요청→work 생성·인계 표식은 한 트랜잭션이다. 같은 입력은 멱등, 다른 내용은 충돌이다. 시험은 격리 PG·Brain 홈과 합성 자료만 쓴다.

**Never:** 실데이터 반입, 원본 migration/normalize, 재분석·모델 호출·수집·발신, core→확장 FK, core 안의 Garmin 분기, 기존 migration 수정, plugin 배포·push·티켓 done 처리를 하지 않는다. 전체 catalog·현재 선택은 14.2, 전수 reader·preflight·수동 CLI/manifest 수동 허용 표시는 14.3, 전수 mapping/재개는 14.4, 파일 실패 행렬·전수 분석은 14.5에 남긴다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 동작 | 오류 처리 |
|---|---|---|---|
| 정상 이전 | 설치된 확장·schema15 raw/일 지표·Markdown | core 건강 값·raw view 원문·분석 파일 원문·추출 세대가 읽힘 | 성공 ABI 결과 |
| 재실행 | 같은 dataset·원래 키·본문 | 새 일감으로 다시 처리해도 계약·보존·mapping·파일 행 수 불변 | 성공 |
| 충돌 | 같은 식별자·다른 원문 | 기존 값을 보존하고 성공으로 숨기지 않음 | 선언한 충돌 코드 |
| 출처 권한 | 확장 role의 다른 source INSERT 또는 UPDATE/DELETE | 세 계약 모두 거부·기존 값 유지 | DB 권한/RLS 오류 |
| 회수된 시도 | 더 이상 current가 아닌 attempt token | 세 계약 INSERT 모두 거부 | BRS01 |
| 파일 경계 | staging 밖·상대 상위 경로·symlink 또는 해시/크기 불일치 | 바깥 파일을 등록하지 않고 FileStore에 쓰지 않음 | 값 없는 실패 분류 |
| 비발신 | 정상 이전과 재실행 | channel_requests·channel_send·시험 전송 호출 모두 0 | 발신 경로 없음 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/manifest.ts`, `extensions/install.ts`, `process-abi/codec.ts`: manifest v1·설치·ABI 재사용. kind는 `garmin.import`, raw_views는 `raw_records`. auth/예약 없음. 수동 실행 필드 추가는 뒤 티켓이다.
- `apps/cli/src/runtime/extensions.ts:154`: resolver는 현재 `apps/cli/extensions/`를 찾는다. 정본 `extensions/garmin/`을 CLI build 산출물에 복사해 기본 resolver로 실제 설치되게 한다. fixture 전용 resolver로 대체하지 않는다. 복사에서 venv/cache를 제외하고 깨끗한 패키지만 배송한다.
- `apps/cli/src/runtime/extension-python.ts`: exact pin·frozen sync·다운로드 금지 정책 유지. 사전 설치된 정확한 Python 사용. `apps/cli/scripts/write-build-info.mjs`, `apps/cli/package.json`이 배송 연결점이다.
- `packages/postgres/src/migrate.ts`: 현재 버전 21. 신규 core `packages/postgres/migrations/0022_import_contracts.sql` 및 상수 22, Garmin은 `extensions/garmin/migrations/0001_tracer.sql`, owner garmin으로 기존 실행기가 적용한다.
- `packages/postgres/migrations/0004_attempt_fence.sql`: `attempt_is_current(uuid,uuid)`와 `reject_stale_attempt()` 재사용. `0019_channel_legacy.sql`은 출처 RLS/column GRANT 선례다.
- `packages/postgres/src/extension-provision.ts`: 신규·기존 role grant와 허용 column 감사, 공개 결과 view SELECT를 함께 갱신해야 재설치된다. 모든 확장에 자기 source INSERT만 허용한다. 원본 표 SELECT나 core UPDATE/DELETE를 부여하지 않는다.
- `packages/core/src/channels/handoff.ts`, `packages/postgres/src/channels.ts`: 목록 읽기→요청별 원자 인계 선례. 파일은 별도 출처 중립 port/PG 구현으로 둔다.
- `packages/core/src/brain.ts`, `apps/cli/src/daemon/run.ts`: core handler·반복 인계 조립. `apps/cli/src/daemon/supervisor.ts`의 실제 manifest 기반 Python 감독자를 그대로 사용한다.
- `packages/core/src/ports/file-store.ts`, `apps/cli/src/runtime/file-store.ts`: put/get 재사용. `packages/postgres/src/attachments.ts`는 session/message 전제이므로 직접 쓰지 않고 파일 요청 확정 API에서 files·file_locations·request 결과를 원자 기록한다.
- `packages/core/src/files/extract-work.ts`: 파일 행에 home_location_id가 있으면 기존 추출 enqueue/handler가 처리한다. `packages/postgres/src/extractions.ts`의 읽기로 세대·조각 관찰.
- `apps/cli/test/pg-home.ts`, `ext-fixture.ts`, `supervisor-fixture.ts`, `apps/cli/python-test/install.test.ts`, `tooling/test-db/src/index.ts`: 격리 홈·무작위 PG·실제 CLI·데몬 선례. extension role은 DB marker를 확인하고 정리한다. Python 시험은 별도 opt-in suite를 유지한다.

## Tasks & Acceptance

**Execution:**
- [x] 단계 1 — `extensions/garmin/{pyproject.toml,uv.lock,.python-version,manifest.json,migrations/0001_tracer.sql}`, `apps/cli/scripts/write-build-info.mjs` 또는 전용 배송 스크립트 — exact pin·driver만의 frozen 패키지, 연결 확인과 raw 보존·dataset/batch/mapping 최소형을 만들고 기본 설치 경로로 배송한다.
- [x] 단계 1 — `packages/postgres/migrations/0022_import_contracts.sql`, `packages/postgres/src/{migrate,extension-provision}.ts`, `packages/postgres/test/import-contracts.test.ts` — 건강 최소형·현재 view·analyses·file_requests·core 처리/결과 표, 세 계약 RLS·attempt·불변 제약과 provisioning을 만든다. NULL 안전 보관 키·날짜/순간 배타와 분석 누락 metadata를 둔다. 현재 view는 tracer의 확인된 계정/단일 dataset만 다루며 미확인 계정을 현재로 올리지 않는다.
- [x] 단계 2 — `packages/core/src/ports/import-store.ts`, `packages/core/src/files/import-work.ts`, `packages/postgres/src/imports.ts`, 기존 Store·public export·brain/daemon 조립 — 미인계 재발견·원자 일감 인계·바이트 검증·FileStore·PG 파일 확정·추출 연결과 건강/분석/파일 결과 읽기를 구현한다. 동등한 기존 명명 관례에 맞춘 파일명 조정은 Implementation Notes에 기록한다.
- [x] 단계 2 — `extensions/garmin/src/`와 실행 entry — 보호된 ABI snapshot에서 입력을 받고 표준 read-only reader로 한 raw·일 지표·Markdown을 최소 트랜잭션으로 옮긴다. 같은 식별자 mapping을 대조하고 내용 충돌을 드러낸다. 분석은 file_request 관계를 불변으로 기록하며 model/created_at 누락은 NULL+flag로 둔다.
- [x] 단계 2 — `extensions/garmin/tests/fixtures.py`, `apps/cli/python-test/garmin-tracer.test.ts`, `packages/postgres/test/import-contracts.test.ts` — schema10/15 합성 생성기·legacy 문서·정리 도구를 재사용 가능하게 만들고 위 행렬과 실제 설치·데몬·Python·PG 수직 경로를 증명한다.

- [x] 재구현 보완 — `extensions/garmin/src/import.py`, `apps/cli/python-test/garmin-tracer.test.ts` — staging locator를 dataset·안정 artifact key·내용 revision으로 분리하여 한 요청의 정리가 다른 미확정 요청의 바이트를 삭제하지 않게 한다. 동일 본문인 서로 다른 문서 키의 요청을 처리 전 모두 넣고, core가 처리한 뒤 두 분석의 원문·결과가 모두 확인되는 시험을 추가한다.
- [x] 재구현 보완 — `extensions/garmin/migrations/0001_tracer.sql`, `extensions/garmin/src/import.py`, `apps/cli/python-test/garmin-tracer.test.ts` — 공개 raw identity `(source,account,key,endpoint)`가 하나의 원본만 가리키게 한다. tracer는 아직 권위 선택을 하지 않으므로, 이미 보관한 공개 identity에 다른 dataset이 들어오면 명시적 IMPORT_CONFLICT로 거부하고 기존 원문과 새 snapshot을 보존한다. NULL account도 동등하게 식별한다. dataset 문자열 순서로 고르거나 충돌 행을 조용히 숨기지 않는다. 같은 dataset 재실행은 계속 멱등이며 전체 dataset 공존·권위 선택은 14.2/14.4에서 호환 확장한다.
- [x] 재구현 보완 — `packages/postgres/migrations/0022_import_contracts.sql`, `packages/postgres/src/imports.ts`, `packages/core/src/failures/retry.ts`, 관련 PG/CLI 시험 — 파일 저장이 최종 실패로 닫히면 공개 상태도 failed·재개 가능으로 보이고, 기존 failures retry가 같은 요청의 작업을 다시 열도록 연결한다. 새 재시도 작업의 진행/완료 상태를 반영하고 확정 전 staging은 남긴다. 10회 실패→재시도→성공 결과 전이를 실제 core drain/PG 시험에서 관찰한다. 전체 파일 crash 행렬을 앞당기지는 않는다.

- [x] 재구현 2차 C — `packages/core/src/files/import-work.ts`, `packages/postgres/src/imports.ts`, `packages/core/src/brain.ts`, `packages/postgres/test/import-redaction.test.ts` — 기존 AttachmentStore의 가린 해시 조회를 put 전에 적용하고 조회 실패는 쓰지 않고 반환한다. 이미 가린 파일은 원래 행·삭제 상태를 유지한 관계로 재사용하며 블롭·삭제된 위치를 복원하지 않는다. 파일 확정도 redacted_at/deleted_at을 확인한다. put 도중 가리기가 확정돼도 남은 블롭이 지속되지 않도록 완료/재시도에서 정리를 확정한다. 기존 파일 가리기·blob 삭제를 끝낸 뒤 같은 내용을 다른 요청 키로 넣는 시험에서 put 0·블롭 부재·가리기/삭제 표식 유지·추출 재생성 0을 관찰한다. put과 확정 사이 가리기 및 정리 재시도의 회귀도 추가한다.
- [x] 재구현 2차 D — `extensions/garmin/manifest.json`, `extensions/garmin/src/import.py`, `apps/cli/python-test/garmin-tracer.test.ts` — ABI 설정에 dataset의 기준 디렉터리 `garmin.artifact_root`를 명시하고 문서의 정규 상대 경로를 original_key로 보존한다. 기준 밖 경로는 거부하고 절대 경로나 basename만으로 키를 만들지 않는다. mapping·request_key·staging·완료 조회 모두 같은 상대 artifact key를 쓴다. request_key는 dataset과 상대 key의 경계가 모호하지 않은 정규 인코딩을 사용하여 콜론 등 문자가 있어도 다른 두 식별자가 합쳐지지 않게 한다. 같은 dataset의 서로 다른 디렉터리에 같은 basename인 문서를 동일 본문과 다른 본문 양쪽으로 시험해 두 분석/요청과 원문이 구분돼 보존되는지 확인한다.
- [x] 재구현 2차 D — `packages/postgres/migrations/0022_import_contracts.sql`, `packages/postgres/src/extension-provision.ts`, `extensions/garmin/src/import.py`, `extensions/garmin/tests/fixtures.py`, PG/실제 Python 시험 — 건강 행에 원본 IANA `time_zone`과 `time_zone_missing`을 보존하고 논리/보관 키 및 현재 view 비교에 포함한다. 원본 snapshot meta의 timezone이 있으면 검증해 보존하고, 없으면 NULL+누락 flag로 남기며 실행 기계나 현재 사용자 설정으로 추정하지 않는다. 시간대 미확인 일 값은 현재 view에서 제외하되 보관 행은 유지한다. 합성 fixture에는 명시적 원본 시간대를 두어 정상 tracer가 읽히게 하고, 원본 시간대 없음 및 현재 사용자 시간대 변경에도 원본 날짜·시간대가 유지되는 시험을 추가한다. 지표 catalog·권위 선택 전체는 계속 14.2 범위다.

**Acceptance Criteria:**
- Given 격리 PG·Brain 홈과 exact Python이 준비됐을 때, When 기본 패키지 resolver로 `brain ext install garmin`하고 실제 데몬이 import 일감을 처리하면, Then core 읽기에서 정규 단위·source·dataset을 가진 건강 한 행, scope 포함 key와 원문이 일치하는 raw 한 행, 분석→요청→파일 원문이 읽히고 기존 문서 추출 세대가 생긴다.
- Given 같은 입력을 새 import 일감으로 재실행할 때, When 실제 감독자가 다시 처리하면, Then 보존·계약·mapping·파일 행 수가 그대로이고 발신 요청·일감·전송 호출은 0이다.
- Given macOS arm64 frozen 설치본일 때, When driver를 import하고 PG에서 UTF-8·epoch ms·NULL을 왕복하면, Then 정확히 보존된다.
- Given 확장 role 또는 회수된 token일 때, When 위 행렬의 금지 쓰기를 시도하면, Then 모든 세 계약에서 거부가 관찰된다.

## Implementation Notes

- 두 번째 재구현의 최종 독립 검증은 build/typecheck, 가리기 포함 PG 95개, staging 4개, 실제 Garmin tracer 4개, 기본 3858개와 전체 Python 14개가 성공했다. 최종 전체 실행에는 추가 실패가 없었다. 원래 행렬과 누적 리뷰 6건의 회귀가 모두 실행됐고 intent-contract 원문 보존도 확인했다.
- 가린 hash 조회는 put 전 실패 시 쓰지 않고 반환하며 파일 확정도 가리기·삭제를 재확인한다. 도중 가리기는 블롭 정리 뒤에만 관계를 확정하고 정리 실패는 재시도한다. 상대 artifact key·JSON tuple 요청 키·원본 IANA 시간대/누락 flag와 2초 SQL 트랜잭션 상한을 추가했다.

- 재구현 최종 독립 검증은 build/typecheck, PG 54개, staging 3개, 실제 Garmin tracer 3개, 기본 3855개와 전체 Python 13개가 성공했다. 기본 선택적 Python 시험 1개는 별도 Python suite에서 실제 실행됐다. 리뷰의 공유 staging·raw identity·최종 실패/재시도 3건은 새 회귀로 검증했다.
- 최종 기본 suite 최초 실행에는 변경하지 않은 commit-unknown ingest의 30초 시간 초과와 daemon missing-url 재연결 호출 횟수 시험 실패가 있었다. 소스 변경 없이 전체 재실행은 3855개 성공했다. 최초 및 성공 로그는 각각 `/tmp/brain14-final-default.log`, `/tmp/brain14-final-default-retry.log`다. 원인과 재현 빈도의 추가 조사가 필요한 시험 비결정성으로 남긴다.

- 전체 구현은 정본 패키지 배송, 보호된 실제 Python importer, 세 core 계약과 출처/attempt 권한, 파일 인계·FileStore·추출·core 읽기를 연결했다. 계정·정규화 버전은 원본에서 확인하고 누락 분석 metadata·NULL·epoch ms를 보존한다.
- 독립 검증: build/typecheck 성공, 지정 PG 53개·tracer 2개·기본 3854개 성공. 기본 suite의 선택적 Python 보존 시험 1개 skip은 전체 Python suite에서 실행됐으며 재실행 12개 모두 성공했다.
- 전체 Python 최초 실행은 기존 bootstrap 임시 Git SHA가 개인정보 패턴에 맞아 commit 비교 1개가 실패했다. hook 시험·마스킹 코드는 이번 diff에 없고 재실행은 소스 변경 없이 통과했다. 최초 실패와 재실행 로그를 모두 보존한다.
- 행렬 감사: 정상·재실행·충돌·비발신은 garmin-tracer 2시험, 금지 출처/UPDATE/DELETE·회수/타 확장 token은 import-contracts 시험, 경로·symlink·크기·같은 크기 다른 해시는 import-staging 3시험으로 실행·성공을 확인했다.

- 2단계 대조에서 계정 identity·정규화 버전을 설정으로 주입하는 초안을 발견해 에픽 결정대로 raw profile id·snapshot meta에서 읽도록 요청했다. 합성 schema10/15는 실제 관련 열/표 차이를 반영하며 생성만 fixture에서 수행한다. Python이 공급하는 UUID도 UUIDv7을 사용한다.

- 1단계 워커는 build/typecheck, PG 18시험, 기본 resolver 실제 frozen 설치와 arm64 driver 왕복을 성공 보고했다. 지휘자는 staged diff를 확인하고 raw의 library_version 누락과 정규화 버전 text를 보완하도록 요청했다.
- Python 3.14.10은 기존 uv 0.13.1 다운로드 목록에 없었으나 임시 uv 0.13.6으로 공식 standalone 배포를 설치했다. 기존 설치기의 다운로드 금지 탐색도 exact 버전을 찾는다. 근거: [Python 공식 릴리스](https://www.python.org/downloads/release/python-31410/).
- 2단계에서 요청 결과 공개 view는 pending/processing/completed/failed와 재개 가능 여부를 포함한다. source별 접근 경계와 core 읽기를 함께 확인한다.

## Plan Change Log

### 2026-10-31 — 리뷰 1회 뒤 재구현

- 원인: 요청별 staging 소유권, dataset 간 공개 raw identity, 파일 저장 최종 실패/재시도의 구체적 상태 규칙이 실행 계획에서 빠져 세 결함을 허용했다.
- 보완: 요청 의미별 locator, tracer의 명시적 dataset 충돌 거부, 실제 실패·재시도 상태 공개와 기존 retry 연결을 실행 항목으로 고정하고 회귀 시험을 추가했다. intent-contract는 보존한다.
- 회피할 상태: 남은 요청의 바이트 삭제, 한 공개 key의 복수 원문, 닫힌 실패를 processing으로 표시하는 상태다.
- KEEP: pin·lock·설치/배송, raw 원문/metadata와 NULL·UUIDv7, RLS/attempt 및 출처 결합, 정상 core 인계·FileStore·추출·읽기, 멱등/충돌/원본불변/비발신 검증을 보존한다. 기존 검증과 전문 보고는 임시 파일에 남겼다. 소스·시험은 `/tmp/brain14-before-rederive.patch`로 보존한 뒤 baseline으로 복원했고 정방향 적용 검사를 확인했다.

### 2026-10-31 — 리뷰 2회 뒤 재구현

- 원인: 기존 내용 단위 가리기 보호를 새 인계 경로에 적용하지 않았고, 원래 artifact 상대 경로와 일 지표 시간대 보존을 최소형에 명시하지 않았다.
- 보완: 가린 hash put 금지·파일 확정의 가리기 재확인·재시도 정리, dataset 기준 상대 artifact key, 원본 시간대 및 누락 flag와 현재 view 제외를 실행 항목에 추가했다. intent-contract는 보존한다.
- 회피할 상태: 가린 블롭 복원, 서로 다른 문서 합치기/거짓 충돌, 시간대 해석을 복원할 수 없는 일 지표다.
- KEEP: 앞선 모든 정상 경로와 원문·권한·attempt·멱등·비발신, 요청별 staging·NULL 안전 raw identity·최종 실패/기존 retry 성공의 세 회귀를 유지한다. 소스·시험 39개 파일은 `/tmp/brain14-before-rederive2.patch`로 보존 후 baseline으로 복원했고 정방향 적용 검사를 확인했다.

## Review Triage Log

### 2026-10-31 — Review pass 1
- verdicts: 3 findings — high 1, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 공유 staging 조기 삭제 — importer의 내용 해시 단독 locator와 handler의 즉시 remove 때문에 같은 본문의 다른 요청이 실패한다. 요청 의미별 staging 소유권과 두 대기 요청 회귀 시험을 계획에 고정했다.
  - `[medium]` `[bad_plan]` dataset 간 raw 공개 identity 중복 — 보관 PK는 dataset을 포함하지만 view identity는 포함하지 않아 같은 계정·key·endpoint에 둘 이상의 원문이 노출된다. tracer에서는 두 번째 dataset의 겹친 identity를 명시적으로 거부하는 규칙과 NULL 안전 시험을 계획에 고정했다.
  - `[medium]` `[bad_plan]` 파일 최종 실패의 processing 고착 — FileStore 실패는 결과 표에 없고 drain의 10회 종료를 view가 읽지 않는다. 실제 실패·재시도 상태와 기존 retry 연결 시험을 계획에 고정했다.

### 2026-10-31 — Review pass 2
- verdicts: 3 findings — high 1, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` 가린 내용의 블롭 재생성 — 새 handler는 redacted hash를 묻지 않고 put하며 확정도 redacted_at/deleted_at을 확인하지 않았다. 기존 ingest의 가리기 보호와 새 경로의 확정/재시도 정리를 계획에 반영했다.
  - `[medium]` `[bad_plan]` basename 기반 artifact 식별 충돌 — legacy.name이 디렉터리를 잃어 다른 문서가 합쳐지거나 충돌했다. 명시적 dataset 기준의 상대 경로와 같은 basename 회귀를 계획에 반영했다.
  - `[medium]` `[bad_plan]` 일 지표의 IANA 시간대 누락 — AD-13/32가 요구한 시간대가 키·관측·현재 view에서 빠졌다. 원본 시간대/누락 flag 보존과 시간대 미확인 일 값의 현재 제외를 계획에 반영했다.

## Design Notes

Python importer도 AD-7의 2초 트랜잭션 상한을 지킨다. PG18의 transaction_timeout과 필요한 statement/lock timeout을 연결에 명시해 잠금 대기 중에도 열린 이전 트랜잭션이 무기한 남지 않게 한다. 바이트 읽기·해시·staging 작업은 계속 트랜잭션 밖에 둔다.

출처에 대한 RLS는 변경 가능한 GUC 대신 current_user와 결합한다. attempt 현재성은 기존 함수를 사용하며 추가로 등록된 work kind의 확장과 source를 결합해 다른 확장의 token을 사용하지 못하게 한다. core 결과 view는 자신의 source 행만 노출한다. core→확장 FK 없이 불변 request 관계에서 분석 파일을 조회한다.

staging 바이트는 `<home>/extensions/<source>/staging/` 아래에 두고 요청에는 상대 locator만 넣는다. core가 신뢰하는 source와 홈에서 루트를 정하며 absolute/..·symlink·다른 확장 경로를 거부한다. 열린 파일 descriptor의 경계·regular file·크기 상한과 요청 hash/size를 검증한 다음 put한다. 생산자는 결과 확정 전까지 바이트를 보존하고 core는 확정 후 정리한다. ABI snapshot의 명시 경로로 importer 입력과 staging을 설정하며 process cwd·HOME을 추정하지 않는다.

## Verification

**Commands:**
- `pnpm build` — CLI 배송 패키지와 전체 TypeScript 빌드 성공.
- `pnpm typecheck` — 시험 포함 타입 검사 성공.
- `pnpm exec vitest run --project postgres test/import-contracts.test.ts test/import-retry.test.ts test/import-redaction.test.ts test/redaction.test.ts test/extension-permissions.test.ts test/attempt-fence.test.ts test/attachment-extraction.test.ts` — 실제 PG 계약·기존 보안·추출 회귀 통과.
- `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-tracer.test.ts` — 설치된 실제 Python·실제 데몬·PG 경로와 행렬 통과, skip 없음.
- `pnpm exec vitest run --project cli test/import-staging.test.ts` — 경로·symlink·크기/해시 거부 3시험 성공.
- `pnpm test` — 기본 suite 회귀 통과.
- `pnpm test:python` — 기존 Python 설치 suite와 신규 Garmin suite 통과.

사전 조건은 Docker의 시험 PG18(기본 54329)과 정확한 Python 3.14.10이다. 실행 중 임시 홈/DB를 만들고 합성 fixture를 그 안에 생성한다. 시험 finally에서 데몬 AbortController 중지 후 await, Store/client close, 자기 DB marker의 garmin role DROP OWNED/DROP ROLE, DB drop, 임시 홈 제거를 수행한다. globalSetup이 띄운 시험 컨테이너는 teardown으로 내린다. 운영 홈·DB·원본 capture를 사용하지 않는다. 합성 시험의 비공개 상세 원문 대신 공개 plan에는 건수·단계·성공 여부만 기록한다.

## 2026-10-31 감독자 재개 인계

- 원래 기준은 `aa67551a81383a6b13967a5b724825fefb69636e`. 시간 초과로 엔진이 멈췄으며 기존 구현자의 정식 관리상 인계를 받았다. 이는 코드 실패가 아니다. 보존 위치 `.bmad-loop/runs/20261030-175233-8a92/restore/14.1-user-resume-20261031-203925/`의 전체 patch와 구현 인계, task 디렉터리의 review-quick-pass3.md 및 기존 리뷰 보고를 대조한다.
- 마지막 FIFO 및 일시 PG 오류 수정의 관련 시험은 통과했으나 그 후 전체 검증과 리뷰는 미완료다. 이 WIP는 완료 증거가 아니다. 전체 원래 diff와 intent-contract, 격리된 Python·기본·PostgreSQL 검증 및 리뷰를 다시 확인하고 미완료를 수정한다. 기존 구현을 버리지 않는다.
