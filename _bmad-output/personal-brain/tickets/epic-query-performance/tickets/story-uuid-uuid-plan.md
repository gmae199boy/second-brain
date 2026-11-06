---
title: '22.5 위치 조회 UUID 조건과 기존 입력 계약 보존'
type: feature
ticket: 5
created: '2026-11-06'
status: built
baseline_revision: eaff4ccd4de4932f8a899dd9c8d69277380f44f7
route: full
route_source: pinned
risk: low
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 위치 read/list/mark가 UUID 열을 text로 바꿔 10만 행에서 전체를 훑는다. 무조건 UUID cast하면 대문자·비정규 입력이 새 일치로 바뀐다.

**Approach:** 기존 text 비교에 일치할 수 있는 canonical 소문자 입력만 인덱스를 타는 UUID 조건으로 조회한다. 공개 store 반환값·오류·검증 순서와 실제 변경 행을 독립 oracle로 확인한다.

## Boundaries & Constraints

**Always:** 원본 baseline 보존. connect 실패 우선순위·mark 시각 검증·write transaction 오류·한 번만 deleted_at 채움과 목록 순서를 유지한다. accepted22.4 batchwrite와 schema39를 유지한다. 합성 전용 PG/role/home/venv/산출물만 사용한다. 개발 중 시험 실행 금지, 컴파일 확인만. 독립 마지막 수정 확인 후 최종 전체 회귀를 순차 실행한다.

**Never:** 중앙 state/main 수정·병합·push, 운영/다른 티켓 자원 접근·정리, 실제 개인정보 사용, 검색·snapshot·마스킹·Drive·migration·API·plugin ref 변경, 임계 완화·성능 통과 목적 반복 재시도.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| canonical hit/miss | 소문자 canonical UUID, 존재/부재 | read 위치/NOT_FOUND, list 정렬된 목록/빈 목록, mark 첫 true·재호출 false | 기존 code/message 유지 |
| 다른 표기 | 대문자·혼합·괄호·무하이픈·공백·비UUID·빈 문자열 | 기존 text와 같은 miss, mark 행 불변 | cast 오류 없음 |
| 경계 | null/undefined의 실제 공개 진입 경계 | 기존 오류 분류·반환·행 불변을 oracle와 대조 | 포트 string 밖 입력도 기존 동작 확인 |
| mark validation | 부재/비정규 id와 잘못된 deletedAt | 기존 시각 검증 우선·부작용 없음 | 기존 오류 유지 |
| DB 실패 | 연결 불가/쓰기 거절 | 기존 DB_UNAVAILABLE/쓰기 오류 우선순위 | 입력검증으로 실패를 숨기지 않음 |

</intent-contract>

## Code Map

- `packages/postgres/src/attachments.ts` readFileLocation/listFileLocations/markFileLocationDeleted가 대상. listFileNames의 text 비교와 writeAttachments는 범위 밖. connect→instant→withWrite 순서를 보존한다.
- `packages/core/src/ports/store.ts` 위치 API 및 결과 계약, `packages/core/src/testing/contracts/attachment-store.ts` 첫/반복 mark·소유권·정렬 계약. 포트 변경 금지.
- `packages/postgres/test/attachment-extraction.test.ts`, `fixture.ts` 실제 PG 계약 fixture·DB 실패/시각 검증 선례. 새 시험을 별도 파일로 추가할 수 있다.
- `tooling/query-perf/{run.mjs,src/core.mjs,src/revision.mjs}` 기존 가산 시나리오 등록/비교·checkout dist·runner/lock/migration 지문. `src/attachments.mjs` brain_app/origin·전용 DB 생성/정리·실제 SQL 캡처 선례. 기존 시나리오 공통 계약 변경 금지.
- `tooling/test-changed/rules.mjs` packages/postgres 경로가 Python 전체를 선택한다. 새 SQL/자식프로세스 경로가 별도 영향이면 규칙을 추가한다.
- 선행22.1 계획의 결정: 같은 runner와 fixture, warmup1+3표본 중앙값, 별도 EXPLAIN, 원시 실패 보존. archive baseline은 `.query-perf-revision` 사용. schema39 인덱스 및 기존 batchwrite를 유지한다.

## Tasks & Acceptance

**Execution:**
1. [x] `packages/postgres/src/attachments.ts`, `packages/postgres/test/file-location-uuid.test.ts` — 위치 세 API 입력 계약을 보존하며 UUID 인덱스 조건 적용. 전체 matrix를 실제 PG oracle/오류 및 부작용 시험으로 작성한다.
2. [x] `tooling/query-perf/src/file-locations.mjs`, 전용 fixture/비교 모듈, `run.mjs`, `src/core.mjs`, `test/file-locations.test.ts`, `README.md`, 필요 시 `tooling/test-changed/rules.mjs` — 독립 시나리오를 가산 등록한다. 실제 store read/list/mark를 10만 행에서 측정하고 baseline/current 동일 fixture·runner·warmup1/3표본·별도 EXPLAIN·SQL수·정렬/반환수/실제행 변화·오류를 독립 oracle로 대조한다. mark는 매 표본 독립행 또는 정당한 초기화로 같은 첫 쓰기 조건을 만든다. provenance/필수조건 누락을 비교기가 거부하도록 시험한다.
3. [x] 이 계획·로컬 실행 증거 — 독립4렌즈와 채택 마지막 실질 수정 후속, 중앙 승인된 명시만료 성능창에서 원시 측정·비교·판단, 마지막 순차 전체 회귀·실패 처분·자원 정리·built/commit/branch push 증거를 기록한다.

**Acceptance Criteria:**
- Given 원본 baseline과 변경 store, when matrix의 각 공개 경로를 동일 합성 fixture에서 호출하면, then 결과/오류/순서/반환수/실제행 변화가 독립 oracle와 모두 같다.
- Given 같은 runner·10만 행 fixture·환경, when warmup 뒤3회 중앙값과 별도 EXPLAIN을 비교하면, then canonical 단건·첫 mark 각각 baseline의 50% 이하이고 변경 SQL 계획이 UUID 인덱스 조회다.
- Given 마지막 구현·독립 필요후속 완료, when `VITEST_MAX_WORKERS=2 pnpm test` 후 `pnpm test:python`을 순차 실행하면, then 기존 첨부를 포함한 전체 시험이 통과한다. 실패 수정은 원시 증거와 관련 재검증으로 남긴다.

## Implementation Notes

- Execution2(Terra): 전용 file-locations runner·fixture·독립 비교기·순수 시험·CLI 가산 등록 완료. build/typecheck/diff-check 각0. 시험·성능 계측은 미실행.

- Execution1(Terra): canonical 소문자만 UUID 인덱스 조건으로 처리하고 다른 런타임 입력은 기존 text predicate로 오류/매개변수 변환을 보존했다. 실제 PG text SQL oracle matrix·시각 검증·연결/쓰기 실패 시험을 작성했다. build/typecheck/diff-check 각0, 시험 미실행. 최초 ready와 depth1은 로컬 영수증에 보존했다.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — 독립 후속 pass 2

- F1 해결: file_locations heap 아래 UUID Bitmap Index Cond를 relation/열/동등조건으로 확인하고 Index/IndexOnly 및 text/다른열/전체scan 거부를 유지한다. 실제 통합시험도 동일 의미를 확인한다.
- F2 해결: baseline/change 모두 failed=false와 errors없음/빈배열을 요구한다. T3/T4 보완 유지, 새 실질결함0. 마지막 T5 수정의 해결을 독립 확인했으며 실행검증은 별도 남았다. 로컬 followup2-report.md.
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0

### 2026-11-06 — 독립 후속 pass 1

- T3/T4의 채택14행(E1,VG1,VG2,B1~B7,IA1~IA4)을 각각 확인했다. VG1은 아래 F1만 잔존, 나머지 해결. E2는 전용컨테이너 정확ID 정리 조건으로 기각 수용, IA5는 현단계 미실행과 필수완료를 구별한 기각 수용. 원문은 로컬 followup1-report.md.
- verdicts: 2 new findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` F1 정상 UUID Bitmap 계획 거절 — 현재 허용 Node Type은 Index Scan/Index Only Scan뿐이다. 복수 위치에서 가능한 UUID Bitmap 경로를 relation/Index Cond로 확인하여 수용하고 잘못된 열·text cast는 거부한다(T5).
  - `[medium]` `[patch]` F2 완성형 실패 raw 비교 채택 — validate는 failed/errors를 보지 않고 정리/socket 오류 후 raw는 필수필드를 모두 가질 수 있다. failed=false 및 errors없음/빈배열을 요구하고 양쪽 거부시험을 추가한다(T5).

### 2026-11-06 — Review pass 1

- verdicts: 16 findings — high 0, medium 13, low 2, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` E1 probe 무제한 대기 — probe Client는 timeout이 없고 connect가 finally 밖이다. 연결/질의 기한과 연결시도부터 정리를 적용한다(T3).
  - `[low]` `[reject]` E2 CREATE DATABASE 응답 유실 — created 플래그 이전 응답 유실은 실제 낮은 확률의 불명 상태다. 자동 재연결/파괴 경로 추가보다 전용 container 최종 정확ID 제거·부재 확인으로 잔존을 처리한다. 실패 원시와 불명 생성 시도는 기록하고 잔여 위험으로 남긴다.
  - `[medium]` `[patch]` VG1 실제 UUID 계획 자동시험 공백 — 수제 Index Scan만 통과하는 현재 시험은 생산 SQL 퇴행을 놓친다. 실제 store 캡처/EXPLAIN 자동 통합 시험을 작성한다(T3).
  - `[medium]` `[patch]` VG2 CLI 실패 JSON 시험 공백 — 실패 catch를 직접 실행하고 파일/정제/exitCode/자원 및 부분 원시를 검사하는 시험이 없다. CLI 경계 시험을 추가한다(T3).
  - `[medium]` `[patch]` B1 probe 제한/정리 — E1과 같은 근거. 같은 T3 수정으로 해결한다.
  - `[medium]` `[patch]` B2 EXPLAIN 역할 불일치 — 관리자 fixture 연결에서 계획을 얻는다. 진단 연결을 brain_app/origin 및 생산측 세션설정과 맞추고 기록한다(T3).
  - `[medium]` `[patch]` B3 mark 후속 SELECT 계획 누락 — queries.find는 UPDATE만 선택한다. 두 대상 SQL을 각각 별도 EXPLAIN해 UUID 인덱스를 모두 확인한다(T3).
  - `[medium]` `[patch]` B4 전체 변화 oracle 폭 — 선택행과 deleted_at 집합은 행 추가/삭제·다른 열 변화를 입증하지 않는다. 측정 밖 전체 행수·결정적 지문과 의도된 mark 제외 불변성을 추가한다(T4).
  - `[medium]` `[patch]` B5 migration 동등성 지문 — 통합 artifacts 지문은 빌드 차이 때문에 서로 달라도 정상이다. 시나리오 전용 migration 내용/적용내역 동등성 증거와 비교 거절 시험을 추가한다(T4).
  - `[medium]` `[patch]` B6 list 단일행 fixture — 대규모 list도 복수 ownership/locator 순서와 반환수를 독립 oracle로 대조하도록 같은 규모 fixture를 보완한다(T4).
  - `[low]` `[patch]` B7 SQL 수 양수만 확인 — SQL수는 필수 원시증거다. 실제 read/list/mark SQL 계약의 누락/추가를 판별하고 단위시험의 mark=1 허구 값을 고친다(T4).
  - `[medium]` `[patch]` IA1 모든 입력의 측정 러너 동등성 — entry5 verify의 지정 표면은 명확하다. timing은 canonical로 유지하고 대문자·비정규·비UUID·null/빈값 matrix를 동일 러너 baseline/current 결과 및 독립 oracle로 추가한다(T4).
  - `[medium]` `[patch]` IA2 mark 계획 범위 — B3과 동일 누락. 전체 호출 timing은 이미 정확하며 두 SQL 계획을 보완한다(T3).
  - `[medium]` `[patch]` IA3 순서/행 변화 표면 — B4/B6과 같은 증거 공백. 전체행 불변성 및 복수 목록 oracle로 보완한다(T4).
  - `[medium]` `[patch]` IA4 실패 중간 원시 보존 — 현재 AggregateError/CLI JSON은 runs/environment를 버린다. 실패시 수집된 부분 원시·SQL·시각·정리 증거를 정제하여 보존한다(T3).
  - `[false]` `[reject]` IA5 완료 실행 증거 미존재 — 현재는 in-review이며 미실행을 명시한다. 지금의 단계 자체는 결함이 아니다. T5에서 승인계측·최종회귀·정리·push를 완료한 뒤에만 built 처리한다.

## Design Notes

- 리뷰 후 보완은 기존 실행항목2의 증거 누락을 작은 내부 수정으로 채우며 공개 API·제품 predicate·수락기준을 변경하지 않는다. T3는 진단/실패/자동시험, T4는 동등성/provenance, T5는 실행 증거다. 고위험0만으로 수렴 판정을 대체하지 않고 마지막 실질 수정 후 독립 확인한다.

입력은 정규화하지 않는다. canonical 검증은 UUID version/variant 제한이 아닌 PostgreSQL 출력 표기의 소문자 8-4-4-4-12 전체 일치다. DB 연결/mark 검증·쓰기 오류의 실제 순서를 보존할 방법은 구현에서 확인한다. 성능 측정 전 중앙의 짧은 명시만료 창 승인이 필요하며 승인 전 계측하지 않는다.

## Verification

- 개발/리뷰 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 시험 코드는 작성하지만 실행 금지.
- 마지막 수정 후 `VITEST_MAX_WORKERS=2 pnpm test` → `VITEST_MAX_WORKERS=2 pnpm test:python` 각1회, 전용 PG와 checkout 밖 소유 TMPDIR·격리 HOME 사용. 실패 수정 후 `pnpm test:changed -- <확정ref>`/관련 시험만 재검증.
- `node tooling/query-perf/run.mjs file-locations --checkout <baseline/current> --database-url <전용PG> --out <로컬JSON>` 및 `compare` — 승인창 안에서만 계측. provenance·oracle·중앙값·계획 조건 모두 통과, 원시 JSON과 종료코드 보존.
- 독립4렌즈/후속 보고 행별 처분 및 owned 자원 정확ID 제거/부재 확인. 브랜치만 push 후 원격SHA·clean 확인.

## 실행 검증 기록

- 마지막 T5 독립후속 확인 뒤 전체 `VITEST_MAX_WORKERS=2 pnpm test` → `VITEST_MAX_WORKERS=2 pnpm test:python`을 순차 각1회 실행했다. 첫 회귀(10:48:59~10:57:40 UTC)는 종료1,207파일 중206통과·1실패,4555시험통과·4실패·1skip. 신규 위치PG3시험/성능러너14시험/기존첨부45시험은 통과했다. Python 회귀(10:57:40~11:04:57 UTC)는 종료0,16파일69시험 전부 통과했다. 최초 원시/환경/자원 증거는 로컬 verification/에 보존했다.
- 최초4실패는 기존 install-legacy-manifest의CLI경계다.3건은 postgres 관리자 인증실패가 직접 기록됐고1건은PgSleep30초대기 실패다. cliForWorld의 고정 `postgres` 암호와 초기격리parent의 `brain-fixture-test` 불일치를 확인했다. 제품/시험코드를 수정하지 않고 동일 파일 전체를 올바른 전용parent에서 관련재검증하며 대기실패 원인은 결과와 함께 구별한다. 전체회귀 통과로 덮어쓰지 않는다.
- 회귀fixture197/197정리/정확ID부재와 회귀parent정리 완료. 성능 전용 PG와 baseline archive는 준비만 했고 아직계측하지 않았다. E2 CREATE응답유실 잔여위험은 최종 전용container정확ID정리·부재확인으로 처리할 의무가 남는다.

- 관련재검증: 새 전용parent를 기존fixture의 `postgres` 암호와 맞춘 뒤 `VITEST_MAX_WORKERS=2 pnpm exec vitest run packages/postgres/test/install-legacy-manifest.test.ts` 실행,11:10:59~11:11:35 UTC,종료0,1파일31시험통과. 최초PgSleep대기 경로도 통과했으며 초기환경불일치로 처분한다(최초대기실패의 인증원인은 직접계측하지 않았다는 한계 보존). 코드변경0,부하2.28→2.95. 정확parentID정리/부재확인 완료. 원시로그/명령/자원은 로컬 retest-legacy/에 보존했다.

## 확정 성능과 채택 근거

중앙 `msg_df99c5a7581b`의 11:13:08~11:23:08 UTC 승인창에서 baseline/current를 순차 한 쌍 실행했다. 실제 baseline 11:13:40.380~11:13:43.964, current 11:13:44.085~11:13:47.480 UTC. baseline/current/compare 각각 종료 0, pass=true. 종료 즉시 반환했고 중앙 `msg_53f4273b4dbe`가 해제를 확인했다. 자동 재시도·추가 계측은 없다.

| 공개 호출 | baseline 중앙값 ms | current 중앙값 ms | 기준 대비 |
|---|---:|---:|---:|
| read | 5.257542 | 0.240375 | 4.572% |
| list | 4.789709 | 0.212041 | 4.427% |
| mark | 10.493333 | 1.551333 | 14.784% |

- 같은 PostgreSQL 18.6/aarch64 전용 cluster, Node 24, 12 CPU, 파일/위치 각 10만 행, warmup 1회와 3표본이다. 1분 부하는 baseline 2.62→2.89, current 2.89→2.82였다. mark 표본은 0.592917/4.950125/1.551333ms로 변동까지 보존했다. 운영 분포·p95 개선을 주장하지 않는다.
- read/list SQL 수 각 1, mark BEGIN/UPDATE/SELECT/COMMIT 4로 양쪽이 같다. baseline 4계획은 Seq Scan, current read/mark 두 문장은 PK Index Scan, list는 기존 `(file_id,store_kind,locator)` 인덱스 Index Scan+C Sort다. read/mark 대상 스캔 hit blocks는 1334→4였다. 별도 진단은 brain_app/origin과 같은 설정에서 실행하고 rollback했다. 새 인덱스·migration 및 그에 따른 쓰기 비용은 없다.
- 입력 matrix 12종의 read/list/첫·반복 mark/잘못된 시각 결과가 양쪽 및 독립 oracle와 같다. timed list 3행 순서·반환수, files/locations 10만 행 전체 지문·행수, 허용된 5개 삭제 시각 변경 집합도 같다. 기존 0001~0039 manifest와 실제 적용 checksum도 같다.
- runner 지문 `59288e240f4884aeabda091882a1357156302cfd7fb9669a074323c4bd2a9c4b`, fixture 지문 `06091ff86df486469be7c804fb123224156a58dd19efc49120c6093ae6ecd021`, migration 지문 `33fd06b5138fc880a660b266291274c3838903a6e7b158770c041e894094d631`.
- built 산출물 baseline `142b8fe488c0a59379f764d453139c3ca300740bf94a492d7d0948ef2ce68583`, current `2934ef76ee57c64e0eac2faec0e51636236260a836da76e4dfbb1b8cb6293f8b`. 원시 JSON/SQL/계획/표본/시각/load/process·stdout/exit는 로컬 verification에, 실제 built/runner는 로컬 artifacts archive에 보존한다.

## Auto Run Result

- 결과: built(사용자 인수 done 아님). 위치 read/list/mark의 canonical 소문자 경로만 UUID 인덱스 조건으로 최적화했다. 다른 입력은 원래 text 조건으로 결과/오류/부작용·검증 순서를 유지한다. 파일명 목록·accepted22.4 batchwrite·schema39·과거 migration·plugin/app-ref는 불변이다.
- 변경: attachments.ts predicate helper와 네 호출부, 실제 PG matrix 시험, 전용 file-locations fixture/runner/compare·순수 및 격리 통합 시험, run/core 가산 등록과 README, 이 계획이다. 신규 성능 경로를 제품 Python 통합이 소비하지 않아 test-changed 규칙 추가는 불필요하며 packages/postgres 기존 규칙은 Python 전체를 선정한다.
- 개발 중 시험 미실행, 마지막 compile 각 0. 독립 4렌즈 16관찰을 행별 처분했다(13 medium patch, 1 low patch, 1 low reject, 1 false reject). 후속1의 2 medium을 T5로 수정했고 후속2가 마지막 수정 해결·퇴행 없음을 확인했다. deferred 없음. followup_review_recommended=false이며 실질 미확인 수정은 없다.
- 마지막 전체 회귀는 순차 각 1회다. 첫 실행은 4555 통과/4환경실패/1기존skip, Python은 69 통과다. 최초 원시를 보존하고 환경을 맞춘 관련 파일 31통과로 4실패를 해소했다. 추가 코드 수정·중복 전체 회귀는 없다. 기존 첨부 45·새 위치 3·러너 14시험은 전체 회귀에서 통과했다.
- 회귀 fixture 197/197 및 회귀 parent, 관련 재검증 parent, 성능 PG 정확 ID를 제거하고 부재를 확인했다. 소유 runtime root도 제거했다. built/runner archive·원시·검증·리뷰·체크포인트·워크트리/브랜치/세션은 보존했다. 운영·다른 티켓 자원은 변경·정리하지 않았다.
- 잔여 위험: E2 CREATE 응답 유실 때 확정 생성 플래그만으로 DB 잔존을 제거하지 못할 수 있다. createAttempted/DB 이름을 실패 raw에 보존하며 이번 전용 cluster 정확 ID 제거로 닫았다. 이후에도 전용 PG 최종 정리가 필요하다. 합성 10만 행/세 표본의 결과이며 비정규 입력 fallback은 기존 스캔 비용을 유지한다.
- 운영 인계: 필수 사람 입력 없음. 중앙이 결과 수락·main 병합/push와 후속 모음을 맡는다. 현재 plugin0.1.23/app-ref598497c에 accepted22.4 미포함인 기존 배포 후속을 유지하며 이번 티켓은 ref/version을 바꾸지 않는다. 향후 schema40 수락 시 중앙 소유 정상 통합과 기대 의미의 최소 검증을 조율하며 이번 계측 기준을 소급 변경하지 않는다.
- baseline `eaff4ccd4de4932f8a899dd9c8d69277380f44f7`, branch `gmae199boy/brain-ticket-22-5`, ownRun `run_13d7390a4431`. 최종 commit/원격 SHA·clean·중앙 전송 영수증은 로컬 최종 보고에 기록한다.
