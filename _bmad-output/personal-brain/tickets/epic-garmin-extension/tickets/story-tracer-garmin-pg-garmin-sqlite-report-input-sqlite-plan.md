---
title: '21.2 옛 Garmin native PG 저장소와 복사 반입 tracer'
type: 'feature'
ticket: 2
created: '2026-11-05'
status: 'built'
baseline_revision: '6deec16b3011a10c7a3dc7c9410edfcd45f5ee4e'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 3
followup_review_recommended: false
context:
  - AGENTS.md
  - _bmad-output/personal-brain/automation/runbook.md
  - _bmad-output/personal-brain/tickets/epic-garmin-extension/epic-garmin-extension.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 기존 보존 importer는 옛 행을 남겨도 옛 프로그램의 native 표와 report_input을 PG 위에서 제공하지 못한다.
**Approach:** 고정 원본의 프로그램·계산·프롬프트·schema를 확장으로 도입하고 native PG 저장소, 계정 문맥, 평가 revision, 재개 가능한 표 복사와 core 파일 관계를 연결한다.

## Boundaries & Constraints

**Always:** 원본은 `~/github/garmin`의 추적 commit `7fb33dd1661ad25cd73e14ed63abe0a87151f62e`만 읽는다. 옛 16 migration 최종 표의 자연키·값·NULL·계산 의미를 보존한다. 예외는 user_id/계정 연결, 평가 revision+최신 view다. raw는 불변, 파생 projection은 재계산 가능, 평가는 append-only다. 모든 native 자연키와 쿼리를 user/connection으로 한정한다. 읽기 snapshot은 read-only REPEATABLE READ다. migration은 기존 0013 뒤 새 forward 번호만 쓰며 core 실행기만 적용한다. attempt fence와 작은 원자 트랜잭션을 지킨다. 계정은 capture raw profile id 증거와 runtime self user를 결합하며 미확인은 native 반입하지 않는다. 미선택 원형은 preserved_rows에 보존한다. 공개 출력은 건수·상태만이며 원문·계정·경로는 공개하지 않는다.

**Never:** 운영 설치/DB/계정/모델/예약/원본 작업트리를 변경하지 않는다. core에 Garmin schema/지표/프롬프트/reader를 넣지 않는다. 21.3~21.5의 실제 수집·모델·예약·플러그인 연결은 구현하지 않는다. 옛 자체 scheduler/Telegram/config 파일 운영 경로를 활성화하지 않는다. 시험·fixture checker·실제 반입을 실행하지 않는다. 중앙 state·공용 follow-ups·main은 변경하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| native-copy | 합성 schema16 capture, 확인된 profile, self user | 설치된 native 표에 원본 열/키/건수/값/NULL 보존 | 미지원 schema는 보존 후 명시 실패 |
| snapshot | 같은 clock/cutoff·합성 원본의 day/7d/30d/all | SQLite와 PG report_input 폴더의 파일 목록·JSON·배열 순서·NULL 동일 | 일/기간별 원래 snapshot 경계 보존 |
| retry | 같은 batch 재실행, 행/파일 경계 중단 | 중복 없이 재개, row+mapping+checkpoint 함께 확정 | fingerprint 변경/같은 key 다른 값은 충돌 기록·완료 차단 |
| overlap | 운영→개발→보관본의 겹치는 자연키 | 선택 원본만 native 반영, 미선택 후보 원형 보존 | 불명 계정/복수 profile은 추정 귀속 금지 |
| files | 합성 report/graph/facts 및 evaluation 참조 | file_requests→core 파일, 중립 kind/report_date/scope/원래 경로 hash, evaluation revision→file_id | 미완료 요청은 바이트 유지·재개, 불명 관계는 명시 보존 |
| revisions | 동일 연결/date/scope 두 평가 | 두 revision 보존, 최신 view 한 행 | 동시 삽입 유일성·이전 평가 수정/삭제 거부 |
| isolation | 다른 user/connection 및 stale attempt | 연결 밖 조회/쓰기 금지, 오래된 attempt 확정 금지 | fence·소유권 오류 |
| memory | Garmin 설치/반입 전후 합성 대화/session/file | 공용 기억 계약과 기존 데이터 보존 | core Garmin 의존 추가 금지 |

</intent-contract>

## Code Map

- `extensions/garmin/src/`: 기존 capture_manifest.load_capture, reader.read_snapshot(읽기 전용 SQLite 및 TEXT 바이트), preflight.account(raw userProfileId 확인), batch_import.ingest/check/encoded/canonical(원형 보존·fence·체크포인트), artifacts 안전 읽기·locator·해시·stage를 재사용한다.
- `extensions/garmin/migrations/0001~0013`: immutable 이력. 0013은 collect/normalize/core-facing view를 제거했고 native 이름은 비어 있다. datasets/import_batches/preserved_rows/import_mapping/artifact_inventory는 남아 있다.
- 원본 `src/garmin_pipeline/store/__init__.py`: write_session/read_connection/transaction/savepoint/upsert_raw 및 sqlite 전용 SQL 교체 경계. 원본 migration의 최종 결과에 activity_recovery는 없으나 구 schema 후보는 원형 보존한다.
- 원본 `report_input.py`: _snapshot의 run/raw_response/activity, 별도 _previous_evaluations, build_period의 native projection/월 집계·evaluation. 각각 첫 조회 전에 RR snapshot, row 반환·숫자·NULL·정렬 보존.
- 원본 `report.py`의 evaluation UPSERT는 append revision으로, SQL 호출자 auth/collect/normalize/body/coverage/charts/digest까지 드라이버를 감사한다. 계산·프롬프트·schema 내용은 유지한다.
- `extensions/garmin/src/artifact_publish.py`, `artifacts.py`: 기존 요청 발행 및 inventory/relations. native 평가 관계를 새로 연결하고 공개 core 파일 metadata에는 원래 경로 대신 hash만 넣는다.
- `apps/cli/python-test/`, `apps/cli/test/pg-home.ts`, `tooling/test-db/`: 기존 격리 PG·home·감독 일감/daemon harness 재사용. `tooling/test-changed/rules.mjs`와 `tooling/test-db/test/test-changed.test.ts`는 새 subprocess/SQL/Python 경로 분류 근거.
- 설계 근거: spine AD-29/30/31/36/40, companion 처분표, redesign 연구 Q3. 현재 코드로 재확인한 사전조사 전문은 로컬 `.brain-automation/investigation.md`.

## Tasks & Acceptance

**Execution:**
- [x] 1. `extensions/garmin/src/garmin_pipeline/**`, `extensions/garmin/UPSTREAM.md` — 고정 src·정적 assets를 도입하고 추적 파일/해시·의존 provenance를 남긴다. 운영 파일/untracked는 제외하고 옛 독립 CLI·설정파일·발송·예약을 활성화하지 않는다.
- [x] 2. `extensions/garmin/migrations/0014_*.sql` 이후, `manifest.json` — 16개 옛 DDL의 최종 native 표/인덱스/NULL/자연키를 forward로 만든다. account_connections(user_id↔identity/tokenstore 참조/timezone), native user/connection 키·FK, 불변 raw·evaluation revisions/최신 view, native 단계 checkpoint/mapping·평가 파일 관계를 둔다. manifest version을 올리고 core 실행기와 설치 role/default grants를 유지한다.
- [x] 3. `extensions/garmin/src/garmin_pipeline/store/__init__.py` 및 SQL 호출부 — psycopg connection/예외/placeholder/upsert/metadata/RETURNING/row factory/transaction을 이식한다. read-only RR와 한 계정 문맥, native raw 불변·projection 재계산·평가 이력을 보존하며 자체 migration 실행은 없앤다. 보존용 SQLite reader/oracle 외 제품 sqlite3 사용은 남기지 않는다.
- [x] 4. `extensions/garmin/src/native_import.py`, `batch_import.py`, `import.py`/검증 경로 — capture·reader·hash·preserved_rows를 재사용해 profile-confirmed self 연결로 FK 순서 native 복사한다. 별도 버전/fingerprint/checkpoint로 행마다 원자적 재개·batch 멱등·충돌보존·선택 우선순위·stale attempt 차단을 구현한다. 미확인 계정은 원형 보존 후 native 반입 실패다.
- [x] 5. `extensions/garmin/src/native_artifacts.py`/기존 발행·검증 경로 — report/graph/facts를 core 파일로 요청하고 중립 metadata·원래 경로 hash 및 평가 revision→request→실제 file_id를 멱등 연결한다. pending 파일 바이트와 실패 재시도를 보존하고 import 완료/verify는 미완료 관계를 성공으로 숨기지 않는다.
- [x] 6. `extensions/garmin/tests/native_*`, `extensions/garmin/fixtures/native/**`, `apps/cli/python-test/garmin-native.test.ts` — 합성 SQLite·합성 파일·고정 SQLite report_input oracle·fake Garmin/model/Telegram·격리 home/PG 공통 fixture와 모든 matrix 행의 시험 코드를 작성한다. 독립 표별 건수/자연키/값/NULL 비교, day/7d/30d/all 폴더 동등성·revision 최신 view·중단재개·파일 관계·공용 기억 보존을 실제 외부 표면에서 검증한다. 시험을 실행하지 않는다.
- [x] 7. `tooling/test-changed/rules.mjs`, `tooling/test-db/test/test-changed.test.ts`, `extensions/garmin/README.md` — 새 경로 분류 및 분류 시험코드와 21.8 격리 실행·준비·기대결과·정리 인계를 적고 정적 컴파일만 수행한다.

**Acceptance Criteria:**
- Given 격리 Brain과 합성 capture, when 확장 설치와 감독 import/파일 drain을 수행하면, then native 표와 core 파일·평가 file_id가 원본 건수·키·값·NULL·해시와 일치하고 기존 기억 데이터는 유지된다.
- Given 같은 합성 fixture와 clock/cutoff, when 고정 원본 SQLite와 이식 PG의 report_input으로 day/7d/30d/all 폴더를 만들면, then 파일 목록·JSON 값·배열 순서·NULL이 같다.
- Given 동일 batch·중단점·겹친 원본 및 확인 불가 profile, when 재실행하면, then 중복/손실 없이 이어지고 우선 원본만 native에 있으며 미선택 원형과 충돌·차단 근거가 보존된다.
- Given 같은 연결/date/scope의 두 평가, when 저장 후 최신 view를 읽으면, then 이전 본문은 유지되고 마지막 revision만 옛 한 행 의미로 보인다.
- Given 시험 실행 유예, when 이번 티켓을 마무리하면, then 위 시험 코드는 준비되고 독립 리뷰·필요 수정/후속 리뷰·build/typecheck 증거가 있으며 시험 실행은21.8로 이관, 미실행이라고 기록된다.

## Implementation Notes

- 리뷰수정7c~7g: v1미귀속파일을 별도user/capture/path hash 장부와중립core요청으로등록하고 파일충돌근거를별도fenced확정한다. numeric cutoff산술, 모든19표비어있지않은fixture·다중월/cutoff/평가oracle, 실제APIrevision경쟁/trigger거부/다계정한정/RR/native변조검증, 실제PG↔고정SQLite정규화동등성·복구시험코드를작성했다. 정적대조에서찾은 rebuild history_start이전날짜추가도7g로고쳤다. 모든시험실행은21.8로이관,미실행이며컴파일만확인했다.

- 리뷰수정7a/7b: 원본dataset+rowid와표시순번 분리, 공용계정write락, 항목/pending원자확정 및 staging→단일publish rebuild를 작성했다. 실제PG경쟁/관찰/rollback/crash 시험코드는 작성했으나 실행하지 않았다. 여섯Task를 마친3세대 구현자를 교체한다.

- Task5/6~6c: 합성 schema16/고정 SQLite oracle/감독 native tracer와 모든 Python 단위시험 등록 및21.8인계를 작성했다. 기존 비정상TEXT/legacy 회귀는 격리test-only preservation adapter로 현재 primitives를 실행하여 유지하고 보존 comparator의 파일fingerprint/inventory/관계 변조검사를 명시 옵션으로 복원했다. 어떤 시험도 실행하지 않았다. Task6은 부분결과였고6a~6c로 작은계약을 완수했다.

- Task4: native 파일요청/중립metadata/선택평가revision↔실제file_id 관계와 pending retryable 재개·verify를 연결했다. v1 provenance불명 파일은 staging 보존 후 평가에 추정 연결하지 않는다. 실제 감독import/file drain/verify 실행은21.8로 이관, 미실행이다.

- Task3: native_import와 schema16 reader/contract 및 별도 checkpoint/mapping을 감독 반입에 연결했다. 새 계정은 profile+self+명시 garmin.timezone(ZoneInfo 검증)을 결합하고 tokenstore_ref는 NULL로 둔다. native 반입에서는 core legacy notification/delivery 발행을 강제하지 않는다. 파일·평가 관계는 Task4가 담당한다. 행 복사 실제 실행은21.8로 이관, 미실행이다.

- Task2e~2g: normalize/collect/auth/ports/report/cli 저장 호출부를 psycopg·계정복합키·짧은 transaction·평가append로 이식했다. body는 SQL이 없어 계산을 유지했다. manifest는 독립 CLI/config/schedule/telegram을 노출하지 않는다. 단위시험코드는 작성됐지만 실제 PG/SQLite 동등성 시험은21.8로 이관, 미실행이다.

- Task2b~2c: report_input/capture/coverage/charts의 명시 계정 SQL과 RR·원본열을 이식했다. SQLite 숨은 rowid로 정하는 차트 종목 순서는 별도 exercise_log_order 관계와 reader.rowids metadata로 보존한다. importer/normalize가 이를 채우는 필수 작업이 남았다. Task2d: 외부대기 중 transaction을 열지 않도록 session advisory lock과 짧은 fenced transaction을 분리했다. 모든 writable execute는 명시 transaction을 요구한다. 구현Task6개 뒤 Terra 워커를 교체한다.

- Task2는 CLI 차단·lock check만 완료한 부분 결과다. 외부 차단은 없어 Execution3을2a(store),2b(report_input),후속 호출부로 분할했다. Task2a가 psycopg store/계정/읽기RR/쓰기fence/revision API를 작성했다. store의 write/report session 전체 transaction은 장시간 I/O 제한과 충돌하므로 호출부 이식 때 작은 transaction 단위로 수정할 필수 항목이다. 제한된 Garmin migration 상태 함수는 core 직접 권한을 확대하지 않는다.

- Task1: 고정 src 전체와 UPSTREAM 해시·의존성, forward 0014 native DDL·계정/revision/checkpoint/파일 관계를 작성했다. 기존 0001~0013 diff는 없다. lock 오프라인 재생성 실패 후 원본 lock 항목을 병합했으므로 정합성 확인을 Task2에 포함한다. DDL 실제 실행은21.8로 이관, 미실행이다.

## Plan Change Log

- 2026-11-05 round3: provenance는dataset의평생rowid가아닌capture/snapshot세대안의rowid임을보조관계에반영한다. source_order계정유일성·현재선택prefix/보존suffix원자게시와과거원형mapping은KEEP한다. 산술제품함수는두리뷰가맞다고확인했으므로바꾸지않고잘못된시험기대만고친다.

- 2026-11-05 round2: 새batch표시순서원자게시, SQLite정수/REAL단계산술, rebuild기존pending예외와native verifier3계정검증을추가한다. 기존raw/native원형·행단위체크포인트·공유락·staging원자성·독립oracle·미실행유예는KEEP한다. round2diff를로컬보존하고해당경계만고친다.

- 2026-11-05 round1: 23개 보고 항목을 모두 판정했다(같은 원인은 수정Task에서만 묶음). Execution3/4/5/6에 원본별 rowid·공유계정락·durable pending·atomic rebuild publish·v1미귀속 파일요청과 실PG/풍부한oracle 시험 경계를 보강한다. 기존 원본이식·보존primitive·native복사·평가revision·파일request·비식별보고·미실행유예는 KEEP한다. 리뷰전 전체diff는 로컬 보존했고, 사용자 부분작업보존 지시에 따라 무관한 코드를 일괄 되돌리지 않고 결함 계약만 재도출한다.

## Review Triage Log

### 2026-11-05 — Review pass 4 최종 독립 확인
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- source/verification 두독립리뷰가 R3-S1과R3-V1/S2를모두resolved로확인했고추가결함은발견하지못했다. 실제시험통과판정은아니다. 최종원문은로컬 .brain-automation/review-round4-source.md 및 review-round4-verification.md에보존했다.
- 최초33개보고항목(중복포함)은 high13/medium18 수정·보강, false2 기각이며 defer0·미해결0이다. 같은원인의중복행은원문순서대로보존하고수정Task에서묶었다. 마지막후속수정 high0이므로 followup_review_recommended=false다.

### 2026-11-05 — Review pass 3 수정 증거
- R3-S1은Task8f의snapshot source_batch provenance로행별복사와현재선택/보존suffix namespace를구분했다. R3-V1/R3-S2는같은Task에서False기대와별도duration=-2 True사례로고쳤고제품산술함수는유지했다. 원문보고는 .brain-automation/implementation-task-8f-report.md에보존했다. 시험은미실행이다.

### 2026-11-05 — Review pass 3
- verdicts: 3 findings — high 1, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R3-V1 negative-add-overflow 기대오류 — -2^63-1000은binary64에서-2^63으로반올림되어SQLite/PG모두False다. 제품함수는유지하고기대False와별도-2 True사례를작성한다.
  - `[high]` `[bad_plan]` R3-S1 capture간rowid재사용 즉시제약충돌 — 기존A의D2/17과새C의D2/17이행별transaction에서겹치고최종defer가늦다. 과거snapshot과현재선택provenance namespace를분리해반입·suffix보존·원자게시·verify를일치시킨다.
  - `[medium]` `[patch]` R3-S2 negative-add-overflow 기대오류 — R3-V1과같은원인이다. binary64인접값간격2048과엄격비교를근거로동일수정에묶는다.


### 2026-11-05 — Review pass 2 수정 증거
- U1/N2/R2-V1은Task8a(계획충돌문맥·최종완료와평가link원자확정·원본건수/키),N1은8b(선택prefix+보존suffix순서와완료원자게시),N3은8c(SQLite단계별정수/REAL함수),N4는8d(기존durablepending별도전달),BH9잔여는8e(실제2user/3connection nativecopy/verify변조결과)로수정했다. 원문보고는로컬 .brain-automation/implementation-task-8a-report.md~8e-report.md에보존했다. 모든시험은미실행이다.

### 2026-11-05 — Review pass 2
- verdicts: 7 findings — high 4, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R2-V1 미확인계정 raw보존 건수 기대오류 — fixture raw14행을UPDATE만했는데1행을기대한다. 원본SQLite건수/키를독립읽어보존을검사하도록수정한다.
  - `[medium]` `[bad_plan]` BH9잔여 native verifier 다계정결과검사 — 조회/쓰기3계정시험은있으나native.verify는1계정뿐이다. 실제3계정장부/동일키·상호변조영향을검사하는코드를추가한다.
  - `[medium]` `[patch]` U1 관계계획충돌 장부누락 — plan의inferred모순은_publish_one catch바깥이며manifest검증은허용한다. 문맥있는계획충돌을쓰기경로에서만별도fenced기록한다.
  - `[high]` `[bad_plan]` N1 새batch선택합집합 표시순서불일치 — MAX+1은우선원본신규행을낮은우선원본뒤에붙이고verify는거부한다. 완료전현재선택집합순서를원자게시·대조하고재개정책을보강한다.
  - `[high]` `[patch]` N2 core완료/평가file_id확정 race — 마지막개별조회pending뒤최종스캔completed이면평가linkNULL로성공한다. 최종완료단위에서관계file_id도함께확정·대조한다.
  - `[high]` `[bad_plan]` N3 numeric정확산술과SQLiteREAL승격선택차이 — overflow곱셈/덧셈때SQLitebinary64반올림이cutoff근처활동선택을바꾼다. 정수구간정확도와overflow단계별REAL의미를분리보존한다.
  - `[high]` `[bad_plan]` N4 기존durablepending을rebuild에서폐기 — 고정원본은history범위밖이라도기존pending을합치는데새코드는모든pending을제외한다. rebuild진입전pending과새stagingpending을구분해전자의복구/실패보존을유지한다.


### 2026-11-05 — Review pass 1 수정 증거
- BH1/BH3: Task7a(원본순서보조관계·공유락), BH2/EH1/IA-D: Task7b/7g(pending원자확정·staging atomicpublish·날짜범위), BH4/EH3: Task7c(충돌장부·v1중립요청), EH2/BH5/BH6/IA-B: Task7d(numeric/풍부한fixture), BH7~9/VG1~2/VG4/IA-C: Task7e(실PG행위), BH10/VG3: Task7f(정규화독립oracle)로 수정했다. 한국어 원문보고는 로컬 .brain-automation/implementation-task-7a-report.md~7g-report.md에 보존했다.
- 내부 정적 추가발견: 새 pending이 rebuild history_start 전 날짜를다시합하는차이를확인해7g에서원본범위로제한했다. 미실행oracle기대는변경하지않았다.
- 후속 독립리뷰는 원래high결함과수정위험을 source-contract/verification 두전문검사로나눠확인한다. 최초공식thorough의네렌즈는모두실행완료했다.

### 2026-11-05 — Review pass 1
- verdicts: 23 findings — high 8, medium 13, low 0, false 2, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` BH1 독립 원본 rowid 충돌 — source_order 계정전체 unique와 importer 중복거부가 서로 다른 자연키를 차단한다. 원본별 rowid provenance/선택합집합 표시순서를 분리하는 보조관계로 수정한다.
  - `[high]` `[bad_plan]` BH2 증분 정규화 항목 확정 뒤 projection 누락 — 항목+normalize_result만 commit하고 pending은 이후 예외에만 기록한다. 같은 항목 단위에서 영향날짜를 내구화하고 projection 확정과 함께 해제한다.
  - `[high]` `[bad_plan]` BH3 native import와 계정 writer 락 불일치 — native copy는 store의 garmin:write:user:connection session lock에 참여하지 않는다. 모든 계정 락을 정렬획득해 같은 직렬화 계약으로 고친다.
  - `[medium]` `[patch]` BH4 파일 충돌 장부 누락 — native_artifacts ValueError만으로는 import_conflicts가 남지 않는다. rollback 후 별도 fenced 충돌기록을 추가한다.
  - `[medium]` `[bad_plan]` BH5 빈 native 표 fixture — 합성fixture가 7표만 채워 ID/FK/sample NULL 비교가 빈행이다. 최종 native 표마다 비어있지 않은 입력과 독립 비교를 보강한다.
  - `[medium]` `[bad_plan]` BH6 희소 report_input oracle — run/activity/cutoff/tie/다중월/기간평가 데이터가 없다. 해당 분기를 구분하는 합성fixture로 고정oracle 비교를 강화한다.
  - `[medium]` `[bad_plan]` BH7 실제 동시 append API 시험 부재 — owner 직접revision삽입/고정mock은 MAX+1 경쟁을 덮지 않는다. 실제 fenced extension 연결 두 개로 append/최신view 이력 검사를 작성한다.
  - `[medium]` `[bad_plan]` BH8 불변trigger 실DB 거부 시험 부재 — raw/평가 UPDATE·DELETE를 실제 role로 시도하는 시험이 없다. 네 거부와 원형유지를 검증하는 코드를 작성한다.
  - `[medium]` `[bad_plan]` BH9 실제 다계정 결과 한정 시험 부재 — mock SQL UUID 검사뿐이므로 두 user/connection의 동일 자연키 자료를 배치해 조회/쓰기 결과 한정을 검사한다. 다중사용자 보안 완성 주장은 하지 않는다.
  - `[high]` `[bad_plan]` BH10 실제 PG normalize 결과/복구 시험 부재 — 빈mock와 patch된 digest는 PG 작업집합·계산·샘플·rebuild를 검증하지 못한다. 고정SQLite와 실제PG의 정규화 및 중단재개 시험코드를 작성한다.
  - `[high]` `[bad_plan]` EH1 증분 항목 뒤 projection crash — BH2와 같은 코드경계·원인이다. durable pending+atomic clear 수정으로 함께 해결한다.
  - `[high]` `[patch]` EH2 report_input bigint 산술 overflow — SQLite가 실수 승격하는 duration*1000은 PG bigint overflow가 된다. numeric 산술로 비교하되 원본 출력타입/값은 유지한다.
  - `[high]` `[bad_plan]` EH3 v1 report/graph/facts core 요청 누락 — v1 unassigned 파일은 stage만 하고 verify는 specs만 검사해 성공한다. 명시 미귀속 중립파일 요청/완료 장부를 두고 평가 연결은 추정하지 않는다.
  - `[medium]` `[bad_plan]` VG1 실제 revision API 자동증가 검증 공백 — 렌즈가 전용시험/호출부검색으로 검증한 공백이다. BH7과 실제 sequential+concurrent append 검사로 해결한다.
  - `[medium]` `[bad_plan]` VG2 실제 raw/evaluation UPDATE DELETE 거부 공백 — 렌즈의 trigger/테스트검색 근거를 수용한다. BH8과 실제role 거부/원본유지 코드를 작성한다.
  - `[medium]` `[bad_plan]` VG3 실제 PG 정규화 작업집합 결과 공백 — 렌즈가 신규raw 누락 회귀를 기존mock이 검출못함을 확인했다. BH10과 실제 값/샘플/처리건수 비교로 해결한다.
  - `[medium]` `[bad_plan]` VG4 native 행변조 공개검증 실패 공백 — 운영native verifier는 정상성공만 검사하고 기존tamper는 보존adapter다. native 값만 변조한 실제verify 실패/불변/복원성공 코드를 추가한다.
  - `[false]` `[reject]` IA-A 라이브러리와 설치제품 전체 실행 표면 — 독립명세가21.3~5 실제수집/모델/예약연결을 제외하고21.2 report_input tracer를 명시한다. 전체프로그램 운영 미제공은 이번 미충족이 아니다. export는 설치src를 쓰도록 증거표면을 명료화한다.
  - `[medium]` `[bad_plan]` IA-B 희소fixture의 동등성 증거범위 — BH5/6와 같은 관찰공백이며 풍부한 합성자료를 추가한다.
  - `[medium]` `[bad_plan]` IA-C1 revision view와 실제writer 증거경계 — 최신view 좁은AC는 덮지만 store교체 API 검증이 부족하다. BH7/VG1 실제API시험으로 보강한다.
  - `[medium]` `[bad_plan]` IA-C2 RR 코드설정과 동시writer 관찰 차이 — 실제PG에서 snapshot열고 다른연결commit 뒤 반복읽기 불변·새snapshot변화를 확인하는 코드를 추가한다.
  - `[high]` `[bad_plan]` IA-D normalize rebuild 원자성 변경 — reset을 먼저commit해 신규reader가 빈/부분projection을 보는 것은 원본 의미와 다르다. staging에서 재계산 후 단일짧은 fenced publish로 기존투영/버전의 원자전환을 복원한다.
  - `[false]` `[reject]` IA-E 과거 activity_recovery native 부재 — 원본0012가 제거한 표이며 고정16개migration 최종모양을 요구한다. 구표는 preserved_rows에 보존하므로 의도 위반이 아니다.

## Design Notes

기존 preservation checkpoint는 native 완료 증거가 아니므로 별도 단계를 둔다. 원본 다중 데이터셋 선택은 운영→개발→보관본 순서를 보존하고 후보는 제거하지 않는다. account_connections는 runtime이 제공한 self user와 각 capture의 유일 profile 증거만 결합하며 다중 사용자 보안을 완성했다고 주장하지 않는다. 고정 src 도입과 저장소 SQL 교체는21.2, 실제 외부 수집·분석 실행·예약/채널/플러그인 연결은21.3~21.5다.

## Review Repair Execution

- [x] R1 `native_import.py`, `0014_native_store.sql`, `garmin_pipeline/store` — 원본별 rowid provenance와 공유계정락을 보강한다.
- [x] R2 `garmin_pipeline/normalize` — 항목확정과 날짜pending을 결합하고 rebuild는 staging→짧은 atomic publish로 원본의 이전/새 투영 관찰과 실패복구를 유지한다.
- [x] R3 `native_artifacts.py` — v1미귀속파일도 중립요청·완료검증하되 평가/계정을 추정하지 않고 파일충돌 근거를 별도 확정한다.
- [x] R4 `garmin_pipeline/report_input.py` — overflow없는 cutoff 산술로 고정원본 의미를 유지한다.
- [x] R5 `fixtures/native`, `garmin-native.test.ts` — 모든표의 비어있지 않은값/NULL/키·cutoff/동률/다중월/기간평가·설치src의 독립oracle 비교를 보강한다.
- [x] R6 `tests/native_pg_integration.py`, `garmin-native.test.ts` — 실제append연속/경쟁·trigger4거부·다계정결과·RR동시쓰기·정규화SQLite동등성/crash/rebuild·운영native변조verify 시험코드를 작성하고 등록한다. 실행하지 않는다.

## Verification

시험 실행은21.8로 이관, 미실행. 이번에는 시험/fixture/실제 반입을 실행하지 않으며 static compilation과 독립 리뷰로 마무리한다.

**Commands (이번 실행):**
- `pnpm build` — 의존 준비 후 전체 TS build exit 0.
- `pnpm typecheck` — TS 시험코드 포함 정적 타입 확인 exit 0.
- `python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests` — Python 정적 컴파일 exit 0; 실행/외부접근 없음.
- `git diff --check` — 공백 오류 0.

**21.8 인계(실행 금지):**
- 전용 시험 DB·소유 role/container·합성 자료·격리 Brain home만 사용한다. `apps/cli/python-test/garmin-native.test.ts`가 기존 pg-home/test-db 수명주기로 준비/정리하고 외부 Garmin/model/Telegram은 fake다.
- 전체 `pnpm test` 다음 `pnpm test:python`을 순차 실행한다. 관련 재검증은 `pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-native.test.ts`.
- 기대: 모든 matrix 비교가 일치, 두 revision/최신 한 행, 재개/재실행 증분0, unconfirmed/stale 차단, 파일 해시/metadata/관계·대화 보존 일치. 새·기존 Garmin 시험과 분류 시험을 모두 포함한다.
- 준비/정리는 기존 harness 소유 자원에만 한정하고 운영 DB·공유 role·기존 자원은 삭제하지 않는다. 실패 로그는 private home과 ticket 증거 디렉터리에 보존하며 소유 자원 정리 후에도 원인별 처분·기준 SHA·환경·명령·종료코드·재검증 증거를 기록한다.
- 미실행/미해결 실패가 있으면21.8 built 및21.7 시작 금지.


## Auto Run Result

- 결과: **built**(사용자인수전). 고정 Garmin 프로그램·정적자원을 도입하고 SQLite store를 psycopg·계정문맥·read-only REPEATABLE READ로 이식했다. 새 forward0014에 native19표·계정연결·평가revision/최신view·원형순서provenance·복사checkpoint·평가파일관계를두었다.
- 반입은 기존capture/읽기전용reader/hash/preserved_rows를재사용한다. profile확인·runtime self·명시 garmin.timezone으로귀속하고 행단위fence/재개·원형충돌보존·공유계정락을유지한다. report/graph/facts는중립metadata와file_requests를거쳐평가file_id에연결하며v1미귀속파일은추정관계없이별도보존한다.
- 정규화의durablepending과staging→atomicpublish, 새capture순서게시·snapshot별rowid와SQLite정수/REAL선택의미를리뷰에서보강했다.
- 변경파일: `extensions/garmin/src/garmin_pipeline/**`(고정프로그램·PG store/호출부), `migrations/0014_native_store.sql`(native/보조계약), `src/native_import.py`·`native_artifacts.py`(복사/파일), 기존capture/reader/verify경로(연결), manifest/pyproject/uv.lock/UPSTREAM/README(의존·선언·인계), `fixtures/native/**`·`tests/**`·`apps/cli/python-test/garmin-*.test.ts`(고정oracle/실PG·보존회귀), `tooling/test-changed/rules.mjs` 및분류시험(새경로선택).
- 리뷰: 최초공식 full/thorough 네렌즈 + source/verification 후속3라운드. 원문지적33행(중복포함)중31행수정·보강,2행기각(IA-A는명시적으로후속운영범위, IA-E는고정migration0012가제거한과거표의native부재로원형보존과구별). deferred없음. 마지막두독립리뷰추가발견0·미해결0.
- 실제컴파일: `pnpm build` exit0, `pnpm typecheck` exit0, `PYTHONPYCACHEPREFIX=<temp>/brain-21-2-final-pycache python3.14 -m compileall -q extensions/garmin/src extensions/garmin/tests extensions/garmin/fixtures/native` exit0. 전체로그는로컬 .brain-automation/build-final.log·typecheck-final.log·python-compile-final.log에보존했다. 신규파일포함최종공백/개인경로검사는커밋전확인한다.
- **시험 실행은21.8로 이관, 미실행.** 직접시험·fixture생성/checker·합성반입·test:changed·전체시험을실행하지않았다. 기능시험통과나실제PG/동시성성공으로표현하지않는다.21.8은README의전용DB/소유자원/합성fixture에서새·기존시험포함 `pnpm test` 다음 `pnpm test:python`을순차실행하고실패원인별최소수정·관련재검증증거를남긴다.
- 잔여위험: 실제DB DDL/권한·패키지wheel설치·시험시간/동시성·고정oracle동등성의실행결과는21.8에서만확정된다. 미실행/미해결실패가있으면21.8 built/21.7 시작금지다. 다중사용자권한격리완성은주장하지않는다.
- 운영설치/운영DB/실계정/실건강자료/모델/예약·원본checkout을변경하지않았다. main병합/push·에픽전이·중앙state수정은하지않는다. 티켓브랜치commit/push·원격SHA확인뒤실제최종보고파일을작성·확인하여중앙Run으로전달한다.
