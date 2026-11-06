---
title: '17.1 리포트 문서 검색과 원문 읽기'
type: 'feature'
ticket: '1'
created: '2026-11-06'
status: 'built'
baseline_revision: '3a263cccf2ef6c921d90cdc6f467ebdca0ce011e'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred:
  - summary: >-
      문서 전체 추출 가림 문맥의 최대 크기 조회/메모리 비용 실측
    evidence: |-
      R1 B8: 현재 세대 전체 조회 및 페이지별 반복은 확인했다. 실제 사용자 지연/메모리 한도 위반은 정적 코드로 확정할 수 없으며 8MiB 합성 추출의 최대 크기 실측으로 판단한다. 현재 티켓은 문맥 밖 비밀 유출 방지를 위해 전체 문맥을 유지한다.
    location: >-
      packages/postgres/src/recall.ts readDocument
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** 확장 리포트 파일을 텍스트로 검색하고 출처만으로 현재 원문을 읽는 공개 경로가 없다.

**Approach:** 17.3 공통 검색·가림 후 budget 위에 document 결과, recall docs, files show, SDK·명령 메타 및 출력 probe를 연결한다. 합성 리포트 한 파일·질의 하나·원문 경로 하나의 tracer로 검증한다.

## Boundaries & Constraints

**Always:** 성공한 확장 file_requests의 metadata.kind=report와 연결된 core 파일만 검색한다. 현재 성공 추출 세대만 읽고 가린 파일은 제외한다. 리포트 날짜·출처 확장·표시명·file_id·chunk_locator·추출 세대·원문 접근 상태를 보존한다. lower LIKE literal 검색과 한국어 두 글자, 17.3의 기본 5건·limit+1·가림 후 8,000자·하위 통째 생략·1위 유지/절단·RESULT_TRUNCATED·omitted/next·0건 hint·SEARCH_FAILED/DB_UNAVAILABLE 구분을 유지한다. 실제 JSON/text·SDK·출력 renderer가 모두 가린다. 시험은 합성 자료만 사용한다.

**Never:** Garmin schema/analyses를 core에서 읽거나 일반 파일/graph를 문서 검색에 넣지 않는다. 기존 migration을 수정하지 않는다. 21.11 bootstrap/TTY/배포, 22.1 migration0039/schema39/성능 러너, recall 건강 스킬 본문과 17.5 meta.extensions를 변경하지 않는다. main·중앙 state를 수정/병합/push하지 않는다. 개발 중 시험·eval 실행 금지, 컴파일 확인만. 구현자는 commit/push/티켓 전이를 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 출력 | 오류 처리 |
|---|---|---|---|
| tracer | 확장 요청→import→extract 합성 Markdown, 두 글자 질의 | document와 전체 출처, 그 출처로 현재 위치/앞뒤 원문 | 실패와 0건 구분 |
| 대상/중복 | 일반/graph/미완료 요청, 같은 hash의 여러 report 요청 | report만, 조각 중복 없음, 결정적 provenance | 잘못된 metadata는 날짜를 지어내지 않음 |
| 세대 | 이전 세대 출처 뒤 새 추출 | 현재 세대 같은 위치·변경 안내·주변 중복 제거 | 없는 위치/잘못된 locator 명시 실패 |
| 접근 | redacted/unsupported/failed/too_large/unreachable | 가린 본문 없음, 각 상태 구별 | 0건으로 합치지 않음 |
| 가림/크기 | 본문·이름·locator 합성 비밀, 긴 본문/여러 조각 | 가림 후 상한·실행 가능한 files show next·probe | 가림으로 변한 출처는 안전하게 거부 |
| 빈 결과/DB | 적중 없음 또는 DB/SQL 실패 | 빈 배열+hint 또는 오류 코드 | 기존 검색 오류 분류 보존 |

</intent-contract>

## Code Map

- `packages/core/src/ports/recall-store.ts`, `recall/search.ts`, `recall/results.ts`: 대화 고정 타입을 document와 안전하게 구별하고 공통 literal/budget을 재사용한다.
- `packages/postgres/src/recall.ts`, `imports.ts`, `extractions.ts`: file_requests→file_request_results→files.current_extraction_id→document_chunks. source_unreachable_at·redacted_at·추출 상태, locator 반열림 코드포인트 의미를 재사용한다. 기존 expression GIN 유지.
- `packages/core/src/domain/{document,chunk-locator}.ts`, `files/`, `ports/`, `brain.ts`, testing fake와 exports: 문서 원문 port/SDK 연결. file_locations.locator와 chunk_locator를 혼동하지 않는다.
- `apps/cli/src/commands/{recall-chunks,recall-text,files-redact,index}.ts`, `dispatch.ts`: docs/show CommandSpec·CommandMeta, next argv와 최종 budget 경계.
- `packages/core/src/output/codecs.ts`, Core/CLI output-codecs 시험: OutputProbe 문서 본문/표시명/locator와 실제 renderer.
- `extensions/garmin/src/report_publish.py`는 읽기 전용 producer 근거. metadata.kind/report_date와 해시 경로를 이용하며 제품 경로/이름을 추측하지 않는다.
- `packages/postgres/test/fixture.ts`, `apps/cli/test/recall.test.ts`, `tooling/test-db/src/index.ts`: 전용 PG·임시 홈·실제 CLI 합성 fixture. 신규 subprocess 경로는 `tooling/test-changed/rules.mjs`와 대조한다.

## Tasks & Acceptance

**Execution:**

- [x] E1 `packages/core/src/ports/`, `recall/`, `files/`, `brain.ts`, exports/fakes와 `packages/postgres/src/recall.ts`/store: document 검색·현재 원문 계약/adapter/SDK, Core·PG 경계 시험 코드 작성.
- [x] E2 `apps/cli/src/commands/`, `dispatch.ts`, `packages/core/src/output/codecs.ts`와 대응 시험: docs/show·메타·텍스트/JSON·실제 출력 probe, 기존 호출처 타입 호환 완성.
- [x] E3 `apps/cli/test/`, `packages/postgres/test/`: 요청→import→extract 합성 리포트 통합 fixture, 모든 행렬·명령/SDK 1:1 회귀 작성. build/typecheck/diffcheck로 컴파일 확인하고 기존 검색 보존 대조.

**Acceptance Criteria:**

- Given 확장 등록한 합성 리포트와 일반 core 파일, When CLI recall docs로 한국어 두 글자를 찾으면, Then report document만 날짜·확장·표시명·locator·접근 상태와 함께 나오며 같은 출처의 files show가 원문을 읽는다.
- Given 출처 발급 뒤 세대 교체나 가리기/추출 실패, When files show를 호출하면, Then 현재 위치와 변경 안내 또는 구별되는 실패 상태를 반환하며 가린 파일 본문은 노출하지 않는다.
- Given 합성 비밀/상한 초과/DB 오류, When SDK와 실제 CLI JSON/text 및 OutputProbe renderer를 실행하면, Then 비밀이 가려지고 17.3 크기·next·0건/실패 계약과 명령 메타 1:1을 지킨다.

## Implementation Notes

- R3-A/B: 검색 반환을 rows/세대별 contexts로 나누고 단일 snapshot의 후보 rank를 명시했다. 그룹 전환·표식 소유권·저장 문맥 오류·UUID 인덱스 조건을 교정하고 memoryStore/PG/CLI 회귀 코드를 보강했다. build/typecheck/diffcheck 성공, 시험 미실행.

- R2-A/B: 전체 추출 secret span 투영·구간별 출처/페이지/블록 보존·SDK 오류 가림·날짜 정렬/이름 원문을 재도출하고 공유 fixture 및 회귀를 보강했다. build/typecheck/diffcheck 성공, 시험 미실행. schema39 설치/조립은 정적으로 일치함을 확인했다.

- E3: 실제 확장 요청/import/extract와 SDK·CLI JSON/text fixture를 작성했다. 세대/본문 지문 변화 시 재시작+hint를 보완했다. build/typecheck/diffcheck 성공, 시험 미실행. 행렬별 시험 이름은 로컬 e3-report에 보존했다.

- E2: docs/show 명령·메타·실제 출력 probe와 offset next를 작성하고 build/typecheck/diffcheck 성공, 시험 미실행. 계획이 요구한 본문 fingerprint 및 세대 변경 재시작/hint는 현재 미충족이어서 E3 계약 검증과 함께 보완한다.

- E1: Core/PG document port·현재 세대 snapshot·SDK/fake와 경계 시험 코드를 작성했다. build/typecheck/diffcheck 성공, 시험 미실행. 큰 원문의 next가 같은 위치를 반복하는 공백을 E2에서 함께 닫는다.

## Plan Change Log

### 2026-11-06 — 검색 문맥 중복 제거와 후속 교정

R2 B3/E1은 검색 행마다 전체 세대를 반복 전송하는 구체적인 자원 증폭을 확인했다. KEEP은 R1의 전체 세대 가림·원문 기반 적중/순위·snapshot·public 결과 내부 문맥 제거·SDK/CLI/budget/구간 출처·격리다. 소스는 새 Git stash에 보존하고 재도출의 출발점으로 apply하며 stash는 삭제하지 않는다.

R3-A 계약 경계: DocumentRecallStore 검색 반환을 적중 rows와 추출 세대별 context 모음으로 분리한다. PG의 단일 일관 snapshot 안에서 limit+1 후보를 먼저 고르고 distinct extraction별 문맥은 한 번만 집계/전송한다. Core는 같은 세대의 documentContext/secret spans를 한 번만 복원해 재사용한다. fake와 호출/시험 대역도 동기화한다. 총 전송·복원 비용이 적중 조각 수 H에 비례해 같은 세대를 H번 복제하지 않는 구조를 정적 검사와 instrumented Core/PG 합성 사례로 확인한다. migration은 필요하지 않다. R2의 나머지 patch 항목도 해당 구현/시험 경계에서 닫는다.

R3-B 검증 경계: memoryStore 계약·실제 CLI 최종 상한과 경고·PG 출현 횟수 정렬·중간 before·그룹/비밀 span 반복 회귀 및 타입 호환을 완성한다. 개발 중 시험은 실행하지 않는다. 이전 구현 워커가 6개 Task를 수행했으므로 새 Terra/medium 구현자를 사용한다.

### 2026-11-06 — 전체 세대 가림과 위치 보존 재도출

B1/B2/B5/B6/E3와 위치 검증 공백이 전체 문맥·출처 설계 누락을 드러냈다. 원래 소스를 gitignored patch와 Git stash에 보존하고 소스만 제거한 상태로 origin/main을 정상 fast-forward 통합했다. KEEP: report provenance/current 성공 세대/일반 파일 제외/기존 budget·명령·probe·SDK/offset·fingerprint 재시작/전용 PG 격리/개발 중 시험 금지. 기존 구현 patch를 재도출의 KEEP 출발점으로 복원한 뒤 아래 설계에 맞춰 변경한다. 중앙 main/state는 수정하지 않는다.

- 문서 검색과 show는 전체 성공 추출 세대의 원문 문맥에서 secret spans를 계산하고 요청 위치와 교차하는 비밀을 모두 가린다. span 좌표는 코드포인트다. 검색 SQL은 원시 본문으로 적중/순위를 고르고 Core에서 가린 조각을 출력한다. 내부 문맥은 공개 결과에 실리지 않으며 동일 세대 snapshot을 사용한다. maskSecrets의 기존 spans/표식을 재사용하고 출력에 원시 문맥 필드를 실수로 남기지 않는다.
- text의 실제 겹침은 중복을 제거하되 틈을 붙이지 않는다. 출력의 각 본문은 그 본문에 해당하는 locator 또는 명시적 locators 목록을 보존한다. PDF 페이지/DOCX 블록 및 비연속 text는 별도 구간/구분자를 유지한다. 잘린 본문도 위치 근거를 잃지 않게 한다. offset/fingerprint next는 이 구조의 가림 뒤 실제 소비 길이로 전진한다.
- 날짜는 유효한 YYYY-MM-DD 또는 null로 정규화한 값으로 정렬과 LIMIT을 적용한다. DB 내부 casting 오류로 검색 전체가 실패하지 않아야 한다. 표시명은 text_raw 복원과 원본 바이트 tie-break를 사용한다.
- E1 재도출 R2-A는 전체 세대 가림·출처/구간 보존·SDK 오류·정렬/이름 및 Core/PG 시험 코드 계약 경계다. E2/E3 R2-B는 CLI/공유 fixture·자격 증명·장애 기대·본문 재시작·literal/PDF/DOCX 시험 및 최종 컴파일 경계다. 각 Task 완료 후 같은 구현자에게 다음 Task를 보낸다.

## Review Triage Log

### 2026-11-06 — Review pass R3

- verdicts: 7 findings — high 0, medium 1, low 1, false 5, maybe-false 0. blind/edge는 각0건.
- findings:
  - `[medium]` `[patch]` V1 기본 앞뒤2 문맥 시험 — 기본 문맥을 1로 줄여도 기존 fixture는 차이가 없다. 7조각 중 가운데5 locator/body를 정확히 단언하는 Core 시험 하나를 작성한다.
  - `[false]` `[reject]` I2 파일당 대표 결과 — carried: R1 I-B/R2 I1과 같은 조각 검색 계약으로 반증했다.
  - `[false]` `[reject]` I3 원본 바이트 읽기 — carried: 현재 추출 텍스트가 명시 계약이다.
  - `[false]` `[reject]` I4 출처 객체 무변환 입력 — carried: 값이 보존된 file_id/locator 입력으로 충분하다.
  - `[false]` `[reject]` I5 reader report 제한 — carried: 대상 제한은 검색 집합이다.
  - `[false]` `[reject]` I6 동일 PG 문서 probe — carried: 실제 renderer에 문서 필드를 통과시켰으며 동일 fixture 의무는 없다.
  - `[low]` `[reject]` I7 계획 재현 정보 위치 — carried: 계획 편집만 요구하는 finding은 reject한다. 최종 Verification에는 정확한 시험 이름·정리 명령과 결과를 채우는 기존 의무를 유지한다.


### 2026-11-06 — Review pass R2

- verdicts: 18 findings — high 2, medium 9, low 1, false 6, maybe-false 0
- findings:
  - `[false]` `[reject]` B1 budget와 has_more — 17.3/entry 계약은 limit+1로 has_more를 정하며 budget 생략은 omitted/next 축이다. 현 구현은 그 구분을 따른다.
  - `[false]` `[reject]` B2 검색 결과 커서 — 원래 계약의 next는 생략 출처의 원문 읽기이고 검색 cursor/pagination은 요구하지 않는다. 기존 17.3 방식과 일치한다.
  - `[high]` `[bad_plan]` B3 세대 문맥 행별 증폭 — searchDocuments가 같은 context를 적중 행마다 JSON 집계·전송하며 Core도 반복 복원한다. limit200/8MiB에서 약1.6GiB가 가능하다. R1의 단일 show 실측 보류와 달리 새로운 검색 H배 증폭이다.
  - `[medium]` `[patch]` B4 가림 표식 반복 — 하나의 secret span을 여러 show 행에 project하면 표식이 반복된다. 선택된 창 안에서 span 소유권을 공유하고 개별 검색 조각은 여전히 독립적으로 가린다.
  - `[medium]` `[patch]` B5 역방향 text 그룹 누락 — documentContext는 새 그룹을 허용하지만 show covered는 이어진다. 그룹 변경 시 중복 제거 상태를 초기화한다.
  - `[low]` `[reject]` B6 bbox 맞닿음 — 기존 codec은 점/선 bbox도 허용하고 교차의 양의 면적 정책은 intent에 없다. 양의 면적만 강제하면 유효 점/선 조회를 잃는다. 복잡한 새 정책은 추가하지 않는다.
  - `[medium]` `[patch]` B7 UUID PK cast — 파일 PK의 text cast는 직접 인덱스 조회를 방해한다. adapter에서 UUID를 검증하고 매개변수 쪽 cast로 변경한다.
  - `[medium]` `[patch]` B8 저장 문맥 오류 코드 — 올바른 입력의 저장 문맥 복원 실패는 사용자 입력 오류가 아니다. 기존 SEARCH_FAILED와 안전한 오류 문장으로 분류한다.
  - `[medium]` `[patch]` B9 memoryStore 계약 검증 — 신규 fake 동작을 실제 memoryStore로 검사하는 계약 사례가 없다. 현재세대/provenance/가림·정렬 계약 사례를 작성한다.
  - `[medium]` `[patch]` B10 실제 CLI 상한 단언 — 현재 Core만 길이를 직접 검사한다. 실제 CLI 두 명령의 JSON/text stdout 및 설정 경고 동반 출력을 검증한다.
  - `[high]` `[bad_plan]` E1 행별 문맥 증폭 — B3와 동일한 구체적8MiB×201 검색 결과 전송 경로.
  - `[medium]` `[patch]` E2 그룹 변경 누락 — B5와 동일한 역방향 text 그룹의 covered 잔존 경로.
  - `[medium]` `[patch]` V1 출현 횟수 정렬 시험 — 날짜 반대 순서를 가진 2회/1회 적중 후보의 PG limit1 단언이 없다. 실제 PG 기대 id를 추가한다.
  - `[medium]` `[patch]` V2 양수 before 시험 — 중간 조각에 before1을 지정해 바로 앞 조각 포함/더 앞 제외를 단언하는 사례가 없다. 정확한 locator/body 배열을 추가한다.
  - `[false]` `[reject]` I1 파일당 한 결과 독해 — carried: R1 I-B와 같은 해석이며 문서 조각 결과 계약을 유지한다.
  - `[false]` `[reject]` I2 원본 바이트 독해 — epic/entry의 현재 추출 텍스트 읽기를 충족하며 원본 바이트 출력은 의도가 아니다.
  - `[false]` `[reject]` I3 reader report 제한 독해 — epic은 문서 출처 files show이고 report 제한은 검색 대상이다. 일반 파일 읽기를 차단할 요구는 없다.
  - `[false]` `[reject]` I4 동일 PG 문서 probe 독해 — 원문은 probe에 문서 필드와 실제 renderer를 요구한다. 같은 PG fixture를 probe에 넣을 의무는 없으며 실제 renderer를 시험한다.

### 2026-11-06 — Review pass R1/R1b

- verdicts: 24 findings — high 6, medium 14, low 1, false 2, maybe-false 1
- 최초 edge 렌즈는 claims가 diff에 포함되어 절차 failed. 소스 전용 diff와 새 독립 Sol 리뷰어로 R1b를 완료했고 두 보고 원문을 모두 보존했다.
- findings:
  - `[high]` `[bad_plan]` B1 검색 조각 경계 비밀 — 각 body의 독립 가림은 창 밖 password/private-key 문맥을 보지 못한다. 전체 세대 가림 범위를 해당 출처로 투영하도록 재도출한다.
  - `[high]` `[bad_plan]` B2 원문 창 밖 비밀 — before=0 중간 조각의 값이 노출된다. 전체 세대 문맥을 사용한다.
  - `[high]` `[patch]` B3 SDK 오류 가림 — 실패 객체를 그대로 반환한다. 공개 Core 실패 message를 maskOutputText로 가린다.
  - `[medium]` `[bad_plan]` B4 무효 날짜 정렬 — SQL이 raw metadata 날짜로 LIMIT한 뒤 null화한다. 검증 날짜의 정렬을 일치시킨다.
  - `[medium]` `[bad_plan]` B5 합친 본문 출처 손실 — 첫 locator만으로 여러 범위를 대표한다. 반환된 본문별 위치/범위를 보존한다.
  - `[medium]` `[bad_plan]` B6 페이지/블록 경계 손실 — join 빈 구분자가 페이지/블록 문장을 붙인다. 구조적 경계를 보존한다.
  - `[medium]` `[patch]` B7 표시명 원문 복원 — text_raw를 읽지 않는다. 기존 originalText와 원본 바이트 정렬을 재사용한다.
  - `[maybe-false]` `[defer]` B8 전체 세대 읽기 비용 — 전체 jsonb_agg와 반복 처리는 사실이나 실제 지연/메모리 악화는 아직 실측하지 않았다. 추출 8MiB 상한과 안전한 전체 문맥 가림을 유지하고 별도 합성 최대 크기 실측으로 판단한다.
  - `[medium]` `[bad_plan]` B9 PDF/DOCX 위치 시험 — text locator 시험만 존재한다. 분기별 선택/제외·세대 위치 소실 시험을 작성한다.
  - `[medium]` `[patch]` V1 missing-schema 단언 — 새 두 메서드는 SEARCH_FAILED이나 예외 목록은 searchRecall뿐이다. 새 메서드 기대값을 맞춘다.
  - `[medium]` `[patch]` V2 같은 세대 재시작 단언 — hint만 확인해 offset 유지 회귀를 놓친다. 변경 본문의 고유 접두어부터 출력함을 단언한다.
  - `[medium]` `[bad_plan]` V3 PDF/DOCX 분기 공백 — B9와 같은 근거이며 위치 계약 시험을 보강한다.
  - `[medium]` `[patch]` V4 문서 literal LIKE 공백 — helper/대화 시험만 있고 문서 경로는 일반 질의뿐이다. 문서 PG의 특수문자/대소문자 정확한 적중 id 시험을 작성한다.
  - `[false]` `[reject]` I-B 파일당 한 건 해석 — entry와 epic은 문서 조각 검색이다. tracer 한 파일/한 적중 요구가 모든 질의에서 파일당 대표 한 행을 요구하지 않는다.
  - `[false]` `[reject]` I-C 출처 통째 전달 해석 — 명시된 file_id+chunk_locator(+세대)만으로 읽을 수 있다. 출처 객체 자체를 CLI stdin으로 받는 의무는 없다.
  - `[medium]` `[bad_plan]` I-D 공유 fixture — 등록 helper가 단일 it 내부에 있어 뒤 스토리가 import할 수 없다. 합성 리포트 fixture를 분리해 재사용한다.
  - `[low]` `[reject]` I-E 계획 재현 정보 — 계획 편집을 요구하는 finding은 공식 분류 규칙에 따라 reject한다. 최종 검증 산출물로 시험 이름·정리 명령/실제 결과를 계획에 직접 기록하는 기존 의무는 수행한다.
  - `[medium]` `[patch]` E1 자격 증명 길이 — 40자리 생성과 provisionExtension의 48자리 검사가 불일치한다. 24바이트로 고친다. 최초 경계 리뷰는 절차 failed이며 발견 자체는 코드로 확인했다.
  - `[high]` `[bad_plan]` E2 전체 문맥 가림 — 검색/show 모두 독립 문자열만 가리는 경로가 있다. B1/B2와 같은 원인.
  - `[medium]` `[bad_plan]` E3 비연속 범위 병합 — chunkDocumentText는 공백 창을 생략한다. 틈을 원문이라고 합치지 않고 분리된 출처/구간 경계로 표현한다.
  - `[medium]` `[patch]` E1b 자격 증명 길이 — 재리뷰에서도 같은 40/48자리 불일치 확인. E1과 함께 수정한다.
  - `[high]` `[bad_plan]` E2b 검색 비밀 중간 조각 — 전체 세대 문맥이 없으므로 비밀 꼬리가 노출된다. B1과 같은 원인.
  - `[high]` `[bad_plan]` E3b show 비밀 중간 창 — 선택 창 이전 BEGIN/password 표식을 보지 못한다. B2와 같은 원인.
  - `[medium]` `[bad_plan]` E4b 무효 날짜 LIMIT — B4와 같은 SQL raw 날짜 정렬을 재도출한다.

## Design Notes

full route는 저장소·SDK·CLI·코덱을 함께 검증하기 위해 고정한다. 동일 파일의 여러 report provenance는 성공 요청 created_at/id의 안정 순서에서 최신 한 건을 선택해 조각을 중복하지 않는다. report_date는 producer metadata 값을 검증해 사용하며 부재/잘못된 값은 null로 나타낸다. 표시 이름이 없으면 개인 경로를 추측하지 않고 `report:<file_id>`를 쓴다. 추출 세대 id는 출처에 포함하되 show 입력에서는 선택이다.

files show는 canonical locator의 현재 세대 겹치는 위치를 기준으로 앞뒤 조각 창(기본 2, 최대100)을 읽는다. text 위치는 코드포인트 반열림 범위이며 겹친 조각의 중복을 제거한다. pdf/docx는 같은 locator 종류/페이지·block의 위치 규칙을 쓴다. 존재하지 않는 위치는 명시 실패다. source_unreachable은 원본 접근 상태로 알리며 유효한 현재 추출이 있으면 그 저장 텍스트를 읽을 수 있다. 추출이 없으면 unsupported/failed/too_large/아직 없음 등을 명시한다. source metadata와 표시명도 공통 출력 코덱을 통과한다.

## Verification

E2 이어 읽기 보강: 큰 원문이 잘린 경우 files show next를 반복해 남은 내용을 실제로 읽을 수 있어야 한다. 가림 후 본문의 코드포인트 offset과 현재 세대/본문 fingerprint를 가진 유효성 검증 커서(또는 동등한 고정 크기 상태)를 사용한다. 세대/본문 변경 시 이전 offset을 새 본문에 적용하지 않고 현재 위치에서 재시작하며 hint를 표시한다. 변경 없는 원문은 next 진행 중 중복·누락과 무한 반복이 없어야 한다. 실제 CLI JSON/text next 재호출 회귀를 E2/E3에서 작성한다.

개발/수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 시험 코드는 계속 작성한다. 마지막 구현·필요 후속 리뷰 뒤 시험 worker 2 설정 `VITEST_MAX_WORKERS=2 pnpm test` → `VITEST_MAX_WORKERS=2 pnpm test:python`을 각1회 순차 실행한다. 최초 실패 원문/종료 코드/로그를 보존하고 수정 후에는 `VITEST_MAX_WORKERS=2 pnpm test:changed -- 3a263cccf2ef6c921d90cdc6f467ebdca0ce011e`와 관련 시험으로 재검증한다.

사전 조건은 pnpm/Node, Docker와 자신 소유 PG cluster·role·home·venv·산출물이다. `tooling/test-db`의 격리 cluster 경로를 이용하고 고정 extension role 때문에 다른 티켓 PG와 공유하지 않는다. 연결 A는 공개 검색/show, B는 필요시 잠금/세대 변경용 별도 pg.Client다. 잠금 시험은 B가 필요한 표 ACCESS EXCLUSIVE를 보유하고 A lockTimeoutMs=100/queryTimeoutMs=2000, 시험 30초 안에 SEARCH_FAILED를 관찰한다. finally에서 B ROLLBACK/end, A/store.close, 자기 DB drop/home 삭제를 수행한다. 실제 fixture·시험 이름·자원 ID·정리 명령과 결과는 구현 메모/최종 보고에 남긴다. 운영 및 다른 티켓 자원은 정리하지 않는다. 전체 회귀가 행렬을 실제 실행했는지 최종 로그로 대조한다.

### 수락조건별 최종 실행 대상

전체 `pnpm test`는 다음 파일의 모든 시험을 포함하고 선택/skip 없이 실행한다. Python 전체는 `pnpm test:python`으로 별도 순차 실행한다.

- `packages/core/test/document-recall.test.ts`: `가림 후 크기 제한과 원문 출처를 보존한다` / `limit+1과 빈 결과 및 저장소 오류를 구별한다` / `현재 세대에서 겹치는 위치와 문맥을 읽고 텍스트 중복을 제거한다` / `가린 파일, 미추출과 없는 위치를 구별한다` / `원본을 못 읽어도 유효한 추출은 사용한다` / `분할 경계에 걸친 비밀도 원문 출력에서 가린다` / `긴 원문은 next를 그대로 사용해 반복 없이 모두 이어 읽는다` / `선택 바깥의 비밀 문맥을 사용하고 내부 문맥을 결과에 실지 않는다` / `서로 떨어진 텍스트와 페이지 출처를 별도 결과로 보존한다` / `SDK 실패 메시지의 비밀을 가린다` / `PDF 페이지와 영역 및 DOCX 블록을 선택하고 소실된 위치를 거부한다` / `긴 비연속 문서의 각 출력과 이어 읽기가 정확한 locator를 유지한다` / `같은 세대의 검색 행은 문맥을 한 번 복원하고 저장 문맥 오류를 검색 실패로 반환한다` / `원문 창에서 하나의 비밀 표식을 한 번만 출력하고 역방향 그룹을 보존한다` / `중간 위치의 before 1은 바로 앞 조각만 포함한다` / `memoryStore 실제 추출의 현재 세대, 출처, 가림과 순위를 지킨다` / `기본 문맥은 가운데 조각과 앞뒤 두 조각만 반환한다`
- `packages/postgres/test/document-recall.test.ts`: `리포트 요청의 최신 provenance와 현재 추출만 검색한다`
- `apps/cli/test/document-commands.test.ts`: `명령 메타와 검색 출처 및 JSON/text 다음 명령을 보존한다` / `검색 출처와 다음 인자를 show에 전달하면 본문 다음 부분으로 진행한다` / `가린 파일 상태를 오류 data로 내보낸다` / `여러 문서 위치를 JSON과 텍스트에서 각각 보존한다`
- `apps/cli/test/document-tracer.test.ts`: `확장 요청에서 리포트 추출, 출처 검색, SDK와 CLI 원문·다음 호출까지 연결한다` / `실제 docs와 show의 JSON 및 text 출력과 설정 경고는 최종 8000자 안에 든다`

- `packages/core/test/output-codecs.test.ts`, `apps/cli/test/output-codecs.test.ts`: 등록된 모든 실제 renderer에서 문서 본문·표시명·locator 가림을 검사한다.
- `packages/postgres/test/unavailable.test.ts`: 문서 두 메서드의 연결 실패/SQL 실패 분류를 전체 장애 행렬로 검사한다.

관찰값은 tracer의 report 한 적중·SDK/CLI data 동일·출처만으로 읽기·비밀 부재·현재 세대/상태·전체 이어 읽기 무누락과 PG/Core 계약 단언이다. 공개 기록에는 합성 질의·식별자와 판정만 남긴다.

정리 재현: 정상 fixture 종료는 `documentReportFixture().close()` 및 `TestDatabase.drop()`의 finally가 연결·소유 DB·소유 container·임시 home을 정리한다. 강제 중단 복구 시 `.brain-automation/tickets/17.1/fixture-pg-resources.jsonl`의 created/removed 영수증으로 정확히 본 Run이 만든 ID만 대조하고 `docker inspect <owned-id>` 후 `docker rm -f <owned-id>`를 사용한다. 전체 회귀의 전용 부모 PG도 `.brain-automation/tickets/17.1/regression-state.json`의 containerId를 확인한 뒤 같은 명령으로 정리하고 `docker inspect <owned-id>`의 no-such-object를 확인한다. 다른 티켓·운영 DB/role·전역 compose는 내리지 않는다. 실제 제거/부재와 로그는 최종 결과에 기록한다.

### 최초 전체 회귀 기록 — 진행 중

- `VITEST_MAX_WORKERS=2 pnpm test`: exit1, 196파일/4404시험 통과, 2파일/5시험 실패, 기존1 skip, 465.13초. 새 document Core/PG/명령/tracer/probe 시험은 실패 목록에 없다. 원본 로그는 로컬 final-ts.log에 보존했다.
- 실패 원인: `guide schema`가 `<file-id>`를 fileId로 정규화한 반면 기존 메타 계약 시험은 선언 이름을 그대로 기대한다. 위치 인자 선언을 기존 camelCase 계약에 맞춘 뒤 관련 guide/document 시험으로 재검증한다.
- legacy 설치 4건: 새 전용 부모 PG의 합성 관리자 암호와 해당 fixture의 고정 `postgres`가 불일치했다. 자신의 PG 관리자 암호를 기존 합성 계약으로 맞추고 같은 legacy 시험을 재검증한다. 운영 또는 다른 티켓의 암호/DB는 변경하지 않는다.
- `VITEST_MAX_WORKERS=2 pnpm test:python`: TS 종료 뒤 순차 시작했으며 결과는 아직 미확정이다.

### 최초 Python 회귀 및 수정 경계

- `pnpm test:python`: exit1, 15파일/68시험 통과, 1파일/1시험 실패, 450.23초. preflight의 공개 work_id가 전화번호 패턴으로 가려진 뒤 private.json 경로로 사용되어 ENOENT였다. 기존 출력 코덱은 유지한다. 합성 private 검증에서 원본 식별자는 소유 DB에서 읽어 공개 값과 가림 후 대조한 뒤 사용하도록 fixture를 교정한다. 운영/private 결과를 공개하지 않는다.
- 개발 완료 뒤 최초 전체 두 실행은 보존하며 이 실패 교정은 관련 TS/PG/Python 시험과 `test:changed`로 재검증한다.

### 회귀 교정 독립 확인

- files show의 위치 인자 선언을 `<fileId>`로 맞춰 기존 guide schema 계약을 보존했다. positional 값과 next 동작은 유지한다.
- preflight의 private 파일/원본 work 조회는 소유 DB UUID를 공개 masked ID와 유일 대조한 뒤 사용한다. 공개 보안 코덱과 기존 결과/권한/비밀 가림 assertions는 유지한다.
- 독립 Sol/medium 집중 리뷰 결함0건, R3-C 기본 문맥 시험도 2/1 차이 검출을 확인했다. 추가 제품 동작 변경은 없고 필요한 후속 리뷰는 완료했다.
- 재검증 기준은 schema39 통합 기준 `b581a90abc6956364d394e5b19aac8e90cb32609`다. 원본 baseline은 보존한다. 최신 origin/main도 같은 SHA임을 확인했다. 자기 PG의 합성 관리자 암호만 기존 fixture 기본값으로 변경했다.

## Auto Run Result

- status: built. 사용자 최종 인수 done과 구별한다.
- 구현: 성공한 확장 report 요청의 최신 provenance와 현재 추출 세대에서 document를 검색하고, SDK/CLI recall docs·files show를 연결했다. 전체 세대 secret span을 조각/문맥에 투영하며 내부 context는 공개 결과에 넣지 않는다. 검색 context는 세대당 한 번만 전송·복원한다. 현재 위치·주변 범위·PDF/DOCX/비연속 text 출처, 세대/본문 변경 재시작과 가림 후 공통 budget/next를 보존한다.
- 변경: Core document port/context/search/show와 SDK/Store/fake/exports, PG 단일 snapshot 검색/reader 및 날짜·표시명·순위, CLI 명령/메타/next/최종 budget, OutputProbe documents, 재사용 가능한 실제 요청/import/extract fixture와 Core/PG/CLI 회귀를 추가했다. 전체 회귀에서 발견한 files show 메타 및 합성 Python private ID lookup도 최소 교정했다.
- 개발/리뷰 수정 중 시험은 실행하지 않았다. build/typecheck/diffcheck만 확인하고 수락조건 시험 코드는 작성했다.
- 최초 최종 전체: `VITEST_MAX_WORKERS=2 pnpm test` exit1(196파일/4404통과·5실패·기존1skip), 그 뒤 `VITEST_MAX_WORKERS=2 pnpm test:python` exit1(15파일/68통과·1실패)를 각각 한 번 순차 실행했다. 원본 실패와 로그는 gitignored 증거에 보존했다. 원인과 처분은 위 기록에 있다.
- 교정 후 `VITEST_MAX_WORKERS=2 pnpm test:changed -- b581a90abc6956364d394e5b19aac8e90cb32609` exit0. 관련 TS/PG 157파일/3308시험 통과·기존1skip, 경로 규칙이 선택한 Python 전체16파일/69시험 통과다. 최초6실패 모두 해소했고 신규 수락조건 시험은 skip/미등록이 없다. 새 subprocess/Python/SQL 경로는 만들지 않았으며 기존 경로 규칙이 Python 전체를 선택했다.
- 리뷰: 독립 Sol/medium 4렌즈 R1/R1b·R2·R3 및 마지막 회귀 교정 집중 리뷰를 마쳤다. 최초 edge의 claims 선행 미열람 실패를 숨기지 않고 새 리뷰어/source-only diff로 보완했다. 단일 triage 로그의49행(중복 지적 포함)은 high8·medium24·low3·false13·maybe-false1이다. 실제 제품/시험 결함은 수정했고, low/false의 기각 근거는 행별 기록했다. 마지막 R3의 medium 시험1개를 보강했고 제품 코드 교정 집중 리뷰는0건이다. followup_review_recommended=false, 미해결 필수 후속 리뷰는 없다.
- 보류: 단일 deferred의 최대 크기 문서 전체 가림 문맥 읽기 비용 실측1개를 보존했다. 구체적인 검색 H배 증폭은 R3에서 제거했다. 미충족 수락조건/실행하지 않은 필수 시험을 보류로 숨긴 항목은 없다.
- 통합: 원본 baseline `3a263cccf2ef6c921d90cdc6f467ebdca0ce011e`를 보존하고 최신 main `b581a90abc6956364d394e5b19aac8e90cb32609`를 자기 브랜치에 fast-forward했다. schema39/설치/빌드 연결과 현행 기대를 확인했다. 과거 migration과 과거 fixture 버전은 변경하지 않았다. 21.11 bootstrap/22.2 session snapshot·지문 lane은 건드리지 않았다.
- 자원: 전용 부모 PG1개와 fixture 소유 PG360개의 정확한 생성 ID를 대조했다. fixture360개는 이미 제거됐고 부모 PG만 정확한 ID로 제거했다. 전체361개 소유 container의 잔존0을 확인했다. 임시 home/venv는 fixture finally가 정리했고 운영/다른 티켓 자원은 수정·정리하지 않았다. 상세 영수증과 전체/재검증 로그는 로컬 .brain-automation/tickets/17.1에 보존한다.
- 운영 인계: 설치본 배포/실제 질문 인수는 기존17.7 범위다. 이번 티켓은 plugin/app-ref·version을 변경하지 않았다. 수락조건을 위해 필요한 외부 계정/실건강/실파일/실발신은 사용하지 않았다. 이번 구현 완료에 필요한 별도 사람 입력은 없다.
- Git/중앙 인계: 티켓 범위만 커밋·자기 브랜치 push 후 원격 SHA/clean을 확인하고 중앙 Run에 한국어 최종 보고를 보낸다. 중앙 main/state는 수정하지 않으며 main 병합·push와 최종 인수는 중앙 소관이다. 워크트리·로컬 브랜치·세션·보존 stash/증거는 유지한다.
