---
title: '17.5 확장 metadata와 recall 검색 회귀'
type: 'feature'
ticket: '5'
created: '2026-11-06'
status: 'built'
baseline_revision: '4d0ec474627b9ca3e6b440b6b565757ddd72a9d8'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 검색과 수치 응답에서 확장 상태가 빠져 미설치·비활성·검색 0건·실패가 혼동되고, recall 스킬의 검색·원문 절차와 종합 문자열 회귀·실행계획 증거가 없다.

**Approach:** registry 공개 SDK projection의 필요한 사실만 meta.extensions로 재투영하고 기존 data 모양과 검색을 보존한다. 건강 절차를 유지한 검색 스킬·합성 회귀·독립 LIKE oracle·가짜 CLI 실제 행동 네 사례와 합성 EXPLAIN 증거를 완성한다.

## Boundaries & Constraints

**Always:** 검색 data 배열·Garmin 기존 객체 producer schema·17.4 절차를 각각 보존한다. metadata는 공개 getExtensionPublicStatus/listExtensionInventory 계약만 소비하고 registry/진행 원문을 직접 읽지 않는다. 비활성 보존 리포트를 검색에서 제외하지 않는다. 원문·metadata는 기존 출력 코덱을 거치며 secret/내부 진단은 공개하지 않는다. 적용 migration 불변/schema39 유지. source 집합은 명시 요청+공개 inventory+결과 출처를 정렬·중복 제거한다. core에 Garmin 상수/특수 분기를 넣지 않는다. metadata 조회 실패는 미설치나 빈 metadata로 성공시키지 않는다.

**Never:** bootstrap/설치 연결/TTY·배포 bootstrap(21.11), session snapshot/지문·stale/redaction/perf runner(22.2), 검색순위/성능 개선, 첨부 반입·Drive 원격쓰기, 운영자원·실계정·실건강을 변경하지 않는다. 중앙 main/state 수정·병합·push 금지. 개발/리뷰 수정 중 시험·eval 실행 금지, 컴파일만 확인한다. 구현자는 커밋·push하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력/상태 | 기대 관찰 | 실패 처리 |
|---|---|---|---|
| 미설치 | 명시 source, 공개 installed=false, 검색0건 | data:[]와 installed=false, enabled=null, searchable=null, work_state=공개사실 또는 unknown | 설치 안내, 전체 source 상태로 확대 금지 |
| 비활성 자료 | installed=true, enabled=false, 보존 report | report 적중과 출처 원문 유지, searchable=true, enabled=false | 건강 명령 unavailable와 검색 가능을 구분 |
| 활성0건 | installed=true, enabled=true, 불일치 질의 | data:[], hint, meta.extensions | 일감 없음/미설치 추정 금지 |
| 검색·연결 실패 | SEARCH_FAILED 또는 DB_UNAVAILABLE | 기존 구별되는 오류 코드 | metadata 실패도 실제 오류, 미설치 치환 금지 |
| 수치 | period-summary/daily-values 성공·실패 | 기존 객체 schema와 값/NULL·단위·기간 유지, meta만 추가 | 명령 오류를 0건과 합치지 않음 |
| 전체 문자 | 두/세 글자, 공백, a-b, AND, 따옴표, %, _, 역슬래시, NFC/NFD | 대화·도구·리포트 기대 id 및 독립 전수 LIKE와 동일 | 정규화/검색계획 강제 없음 |
| 표현 바꾸기·원문 | 고정 재질의 묶음, 적중 source | 허용 질의 뒤 적중 id, source만으로 원문 조회 | 무근거 성공·허위 출처 거부 |

</intent-contract>

## Code Map

- `packages/core/src/envelope.ts`, `output/codecs.ts`, `extensions/public-projection.ts`, `ports/store.ts`: 공통 봉투와 기존 ExtensionPublicStatus 사실. 공개 projection을 소비하는 새 `recall/extension-metadata.ts` helper와 필요한 타입만 추가한다. 기존 SDK 공개 projection SQL은 변경하지 않는다.
- `packages/core/src/recall/{search,documents}.ts`, `brain.ts`: 검색·SDK input에 선택 source 목록을 연결하고 budget·data 배열 유지. `extensions/commands.ts`: 수치 포함 확장 명령의 기존 검증/마스킹/실행 gate 보존하며 metadata 연결. `testing/fakes/store.ts`, `index.ts`: 필요한 타입만 동기화.
- `apps/cli/src/commands/recall-{chunks,tools,docs}.ts`, `dispatch.ts`, `mcp/serve.ts`: CommandSpec/메타/SDK 1:1, 명시 source 옵션, 성공/실패 metadata 전파. `files-show.ts`, `packages/core/src/output/codecs.ts` 예제/probe에도 공통 봉투를 검증한다.
- `packages/postgres/src/recall.ts`, `packages/postgres/test/conversation-index.test.ts`, 기존 `document-recall` 시험/fixture: literal LIKE·현재 report 세대·비활성 필터 부재를 재사용. oracle는 제품 escape 함수를 재사용하지 않는다.
- `plugin/skills/recall/SKILL.md`, `tooling/recall-eval/`, `tooling/bootstrap/test/recall-{skill,eval}.test.ts`: 기존 건강 eval 보존. 검색 네 사례·fake/prepare/verify·정적 명령 대조·음성 자기시험을 확장한다. 자기시험과 실제 에이전트 실행은 별개다.
- `apps/cli/python-test/recall-health.test.ts`, `apps/cli/test/ext-fixture.ts`, `tooling/test-db/src/index.ts`: 실제 CLI/MCP·전용 PG fixture 패턴. bootstrap fixture 자체의 변경은 피한다.
- 새 검색 회귀/EXPLAIN 도구는 `tooling/recall-eval/` 또는 PG test의 전용 경로에 둔다. 새 자식 프로세스 경로는 `tooling/test-changed/rules.mjs`와 해당 규칙 시험에 추가한다.

## Tasks & Acceptance

**Execution:**

- [x] E1. `packages/core/src/recall/extension-metadata.ts`, `packages/core/src/envelope.ts`, `apps/cli/src/dispatch.ts`와 Code Map의 호출처에서 Core metadata 타입/helper와 `brain.ts`/검색/확장명령/CLI·MCP 봉투 전파·명시 source 입력·메타 예제를 연결한다. Core envelope/metadata, CLI/MCP/SDK 상태 행렬 회귀 코드를 작성한다. Store/root export는 helper/봉투 범위만 허용한다.
- [x] E2. `plugin/skills/recall/SKILL.md`, `tooling/recall-eval/eval.mjs`, `tooling/bootstrap/test/recall-{skill,eval}.test.ts`에서 recall 스킬에 질의 바꾸기→검색→출처 원문→수치/없음/설치 안내를 연결하고 건강 절차를 보존한다. 정적 검사와 검색 네 사례(두 글자·표현 바꾸기·없음·비활성), 판정기 음성 시험·문서를 작성한다. 기존 bootstrap 설치 시험은 변경하지 않는다.
- [x] E3. 신규 `packages/postgres/test/recall-regression.test.ts`, `apps/cli/test/recall-metadata.test.ts`, `tooling/recall-eval/explain.mjs`에 PG/CLI 검색 합성 전체 문자·재질의·원문 fixture와 고정 기대 id/독립 전수 LIKE 비교, 실행계획 수집 도구·문서를 작성한다. 기본 suite와 별도 행동/EXPLAIN 명령, 격리·정리 절차를 구체화한다. 개발 중 실행하지 않는다.

- [x] E4. `apps/cli/src/mcp/serve.ts`, `apps/cli/test/extension-commands.test.ts`, `apps/cli/test/recall-metadata.test.ts`, `packages/core/test/extension-metadata.test.ts`, `apps/cli/python-test/recall-health.test.ts` — R1 MCP 리터럴 옵션형 검색어·chunks/tools 실제 호출, 명령 실패 metadata, 결과 전용 source 합집합, Garmin 실제 metadata 관찰을 보강한다.
- [x] E5. `plugin/skills/recall/SKILL.md`, `tooling/recall-eval/search.mjs`, `tooling/bootstrap/test/recall-{skill,eval}.test.ts` — R1 도구 메모 공개 reader와 고아 메모/오류·미설치/원문 실패 행동 fixture, extraction-id 필수 전달·상태 안내 판정과 음성 회귀를 보강한다.
- [x] E6. `tooling/recall-eval/explain.mjs`, `README.md` — R1 정리 실패에도 모든 정리·증거 저장을 독립 시도하고 실패를 기록한다. 측정은 3대상 단일표 predicate probe이며 제품 전체 SQL 계획과 다르고 5색인 중2개는 정의만 기록한다는 한계를 명시한다.

- [x] E7. `tooling/recall-eval/search.mjs`, `tooling/recall-eval/explain.mjs`와 `tooling/bootstrap/test/recall-eval.test.ts` — R2 오류코드와 일반0건 단정 동시 보고를 거부하고 AggregateError의 개별 정리 원인을 가려 기록한다. 관련 양성/음성 자기시험 코드를 작성한다.

- [x] E8. `tooling/recall-eval/search.mjs`, `tooling/bootstrap/test/recall-eval.test.ts` — R3 결과부재 단정을 부정하는 오류 설명은 허용하고 별도문장의 부재단정은 계속 거부하도록 문장별 판정을 직접 정정한다.

- [x] E9. `tooling/recall-eval/search.mjs`, `tooling/bootstrap/test/recall-eval.test.ts` — 개발뒤실행실패의 한국어 어미·유효한 원문메시지출처·미설치0건 재질의 계약을 정정하고 음성회귀를 유지한다.
- [x] E10. `tooling/recall-eval/explain.mjs` — PG18환경 locale/ctype를 pg_database카탈로그에서 읽고 기존 독립정리·실패기록을 보존한다.

- [x] E11. `tooling/recall-eval/explain.mjs` — 원문불변 DELETE금지를우회하지않고 각합성자료규모를독립트랜잭션으로적재·수집뒤rollback해다음규모와분리한다.

**Acceptance Criteria:**

- Given 명시 source·공개 inventory와 실제 report, When SDK/CLI JSON·MCP 검색을 실행하면, Then 검색 data 배열과 비활성 적중을 유지하고 필요한 공개 필드만 metadata로 나오며 미설치/비활성/0건/SEARCH_FAILED/DB 연결 실패가 구별된다.
- Given Garmin 기존 합성 건강 fixture, When CLI/MCP 수치 명령을 실행하면, Then producer 객체·손계산 값·NULL·단위·기간 계약을 유지하고 meta만 추가되며 core에 Garmin SQL/상수가 없다.
- Given 네 검색 행동 사례, When 실제 에이전트가 fake CLI로 스킬을 수행하면, Then 질의/허용 재질의·출처 원문 호출·안내가 기대와 일치하고 판정기가 통과한다. 판정기 자기시험도 허위 성공/누락 호출을 거부한다.
- Given 세 검색 대상의 고정 합성 fixture, When 전체 문자 문항과 재질의를 실행하면, Then 기대 id와 독립 전수 LIKE 결과가 모두 같고 source→원문이 복원된다.
- Given 자기 전용 공식 PG 이미지 합성 자료, When 강제 planner 설정 없이 ANALYZE/EXPLAIN을 수집하면, Then 이미지 digest·locale/provider/encoding·pg_trgm·다섯 expression index 정의 및 선택도별 ANALYZE BUFFERS 출력이 이 계획에 보존된다.

## Implementation Notes

- E11: 규모별begin→적재/ANALYZE/수집→rollback으로변경해도구원문DELETE를제거했다. 실패시열린트랜잭션rollback을재시도해오류기록후독립정리/출력을보존한다. 구문/diffcheck0.

- E9/E10: 실제실패의 아닙 어미, 검증된원문메시지출처 인용 허용, 미설치 고정재질의 두질의, PG18카탈로그 locale조회로정정했다. 음성 위조출처·허용밖질의·혼합부재단정은유지했다. 원본최초판정/실패는변경하지않는다. 구문/diffcheck0, 후속컴파일/관련재검증진행중이다.

- E8: 검색결과 부재표현마다 바로 뒤의 국소 부정문맥을 확인한다. 두 오류코드에서 부재단정 부정/단정불가를 양성으로, 별도 실제부재문장과의 혼합을 음성으로 추가했다. build/typecheck/diffcheck 종료0. 시험/eval은 미실행.

- E7: 오류코드와 결과없음 단정은 거부하고 “결과를 확인할 수 없습니다” 설명은 허용한다. `explain-error.mjs`는 AggregateError.errors·cause를 구조화하고 URL/홈경로를 가리며 순환을 제한한다. 두 정정 자기시험 작성, build/typecheck/diffcheck 종료0. 시험/eval/EXPLAIN·PG 미실행.

- E5/E6: 고아메모 `sessions read --note`, search-orphan/search-failed/search-db-failed/search-not-installed/search-read-failed 행동 fixture·판정과 음성시험을 추가했다. 문서 extraction-id 전달과 본문/비활성 상태안내 판정을 구분했다. EXPLAIN 정리·기록은 개별 실패를 보존하며 측정범위는 단일표 predicate로 명시했다. 구문/diffcheck 종료0. 개발중 시험/eval은 미실행. 중앙 측정창은 msg_200c2231066e로 조기해제됐다.

- E4: MCP query를 옵션 뒤 `--`로 분리했고 실제 3종 MCP/CLI/SDK 리터럴 검색·실패 metadata·결과전용 source·Garmin meta 단언을 보강했다. diffcheck 종료0. 중앙 측정창에 따라 build/typecheck와 모든 시험/eval은 미실행이며 후속 컴파일이 남는다.

- E3: `recall-regression.test.ts`에 세 대상의 11문자 문항·재질의·전수 LIKE·고정 id·출처 원문을, `recall-metadata.test.ts`에 실제 CLI/MCP 상태·비활성 report·잠금/연결 실패를 작성했다. `tooling/recall-eval/explain.mjs --out <새파일>`은 자기 공식 postgres:18 컨테이너에서 100/10000행·3대상·3선택도·필터별 실행계획과 환경/5색인을 수집/정리한다. build/typecheck/node 구문/diffcheck 종료0; 시험/eval/EXPLAIN·PG 생성은 미실행. 지휘자가 새 시험/수집 도구 전문을 확인했다.

- E2: 검색 스킬과 `tooling/recall-eval/search.mjs`의 search-two/search-rephrase/search-empty/search-disabled를 추가했다. 기존 건강 절차를 유지하며 질의 순서·출처 원문 호출·보고와 우회/출력 변조 음성 자기시험을 작성했다. build/typecheck/node 구문/diffcheck 종료0, 시험/eval은 미실행. 실제 네 사례 명령은 Verification과 구현자 보고에 보존했다. 지휘자가 스킬·검색 판정기 및 관련 시험 diff 전문을 확인했다.

- E1: 공개 projection helper·metadata 타입·검색 SDK/CLI/MCP source 입력과 성공/실패 봉투를 연결했다. 검색 배열/수치 객체를 유지하고 metadata를 검색 budget에 포함한다. 기존 Store/PG/migration 변경 없음. `extension-metadata.test.ts`와 `extension-commands.test.ts`에 회귀 코드를 작성했다. 구현자 build/typecheck/diffcheck 종료0; build 뒤 마지막 입력검증 추가는 typecheck로 확인했다. 시험/eval 미실행. 지휘자가 E1 소스 diff와 새 helper/시험 전문을 확인했다. 최종 컴파일·독립리뷰·전체 회귀는 아직 남았다.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — Review pass R1

- verdicts: 20 findings — high 0, medium 13, low 6, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` BH1 MCP 옵션형 query — Commander argv의 query가 --help/-h로 해석된다. E4에서 옵션 뒤 -- 구분자로 리터럴을 전달하고 SDK/CLI/MCP 동등성 시험을 작성한다.
  - `[medium]` `[patch]` BH2 도구 원문 안내 — expand는 메시지만 반환해 tool_note_id/고아메모 원문을 읽지 못한다. E5에서 기존 sessions read --note 명령을 안내·평가한다.
  - `[low]` `[reject]` BH3 대량 metadata 예산 — 전체 봉투 상한은 기존 계약이며 수십~수백 source의 metadata 자체가 한도를 넘으면 명시 INVALID_ARGUMENT이다. 일반 개인 사용에서 드문 큰 inventory/명시source 묶음이며 pagination/새 누락 계약은 추가 복잡성을 요구하므로 도입하지 않는다. 대량 상태 집합은 현재 상한을 넘을 수 있음을 잔여 한계로 보존한다.
  - `[low]` `[patch]` BH4 EXPLAIN 제품 SQL 차이 — 계획/티켓은 합성 선택도별 검색 조건 실측을 요구한다. 실제 제품 SQL 비용이라고 주장하면 오해이므로 E6에서 predicate probe와 실제 조인/정렬/문맥 수집 비용의 차이를 문서에 직접 명시한다. 제품 SQL 전체 실측은 이 증거로 주장하지 않는다.
  - `[false]` `[reject]` BH5 다섯 색인 모두 실측 필요 — 티켓은 다섯 expression index 정의 기록과 합성 EXPLAIN을 요구하며 로그/파일명 검색은 명시적으로 다른 에픽이다. 3검색대상 실측+5정의로 충족하며 E6에서 정의만 기록한2개를 명시한다.
  - `[medium]` `[patch]` BH6 EXPLAIN 정리 예외 — 직렬 finally에서 client.end 실패가 drop을, drop 실패가 출력을 건너뛴다. E6에서 독립 정리/출력 시도와 각 오류·종료 실패를 보존한다.
  - `[medium]` `[patch]` BH7 검색 오류 안내 행동 누락 — 스킬은 검색/연결실패·미설치·원문실패를 구분하지만 fake가 만들지 못한다. E5에 해당 fixture/음성판정 코드를 추가하고 최종 실제평가에 포함한다.
  - `[medium]` `[patch]` BH8 tools 행동 누락 — BH2의 공개 reader 공백과 같다. E5 tools 고아메모 적중→sessions read --note 행동과 잘못된 reader/id 음성시험을 추가한다.
  - `[low]` `[patch]` BH9 추출세대 전달 누락 — 실제 files show 입력은 선택이나 스킬은 발급된 extraction_id 전달을 요구한다. E5 fake가 생략/변조를 거부하도록 직접 조건을 정정한다.
  - `[low]` `[reject]` BH10 transcript 명령 대조 — 실제 calls/outputs가 명령 순서를 직접 기록하고 지휘자가 transcript 전문과 함께 대조한다. 정직한 에이전트 평가에서 transcript의 구체문구 자동파싱을 추가할 실익이 작고 복잡성을 늘리므로 거절한다. 자기시험 고정 재생은 실제 행동 증거로 세지 않는다.
  - `[medium]` `[patch]` EC1 옵션형 query — BH1과 같은 argv 원인. E4 리터럴 전달과 회귀로 닫는다.
  - `[medium]` `[patch]` EC2 정리 예외 — BH6과 같은 직렬 finally 원인. E6 독립 시도/기록으로 닫는다.
  - `[low]` `[patch]` EC3 추출세대 생략 — BH9과 같은 허용 조건. E5에서 직접 정정한다.
  - `[medium]` `[patch]` EC4 비활성 음성 자기시험 충돌 — report.replace가 첫 비활성만 바꿔 인용 본문의 비활성이 남는다. 현재 판정은 substring만 보아 양성으로 남는다. E5 상태 안내를 본문과 구별해 잘못된 활성 안내·누락을 거부하고 자기시험을 정정한다.
  - `[medium]` `[patch]` VG1 확장 명령 실패 metadata — 실제 명령 실패 경로는 수동 errorEnvelope 시험으로 덮이지 않는다. E4 설치된 testext 입력 실패의 CLI/MCP 코드와 metadata를 함께 assert한다.
  - `[medium]` `[patch]` VG2 MCP chunks/tools — docs만 실제 호출한다. E4 두 MCP 도구 등록/호출·고정 id·명시 source metadata를 관찰한다.
  - `[medium]` `[patch]` VG3 결과 전용 source — rows source 합치기를 빼도 기존 시험이 통과한다. E4 빈 inventory/명시source 없음에서 결과 source의 미설치 metadata와 data를 함께 assert한다.
  - `[medium]` `[patch]` IA-A Garmin metadata 표면 — 범용 testext transport만 metadata를 단언한다. E4 실제 Garmin CLI/MCP 성공·오류 metadata를 기존 독립 값 fixture와 함께 assert한다. 미설치/비활성 명령등록 gate는 기존 status 조회+USAGE/UNAVAILABLE 계약을 보존하며 단일 unavailable 봉투의 자기설명성을 주장하지 않는다.
  - `[medium]` `[patch]` IA-B tools 공개 원문 — BH2/BH8과 동일. E5 기존 sessions read --note를 스킬·실제행동평가로 연결한다.
  - `[low]` `[patch]` IA-C 측정 표면 차이 — BH4와 동일. E6 문서에서 단일표 predicate의 좁은 측정 범위를 명시한다.

### 2026-11-06 — Review pass R2

- 원문 `.brain-automation/tickets/17.5/r2-followup.md`는 R1 patch17행의 해결/부분해결과 reject3행 유지를 각각 대조했다.
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R2-1 오류코드와 검색결과없음 동시보고 수락 — failure 분기에서 “검색 결과가 없습니다”를 금지하지 않아 모순 보고가 통과한다. E7에 코드동반 부재단정 음성과 “실패하여 결과를 확인할 수 없습니다” 양성을 추가한다.
  - `[low]` `[patch]` R2-2 복합 정리 원인유실 — drop은 AggregateError.errors에 두 원인을 담지만 capture는 상위message만 저장한다. E7에서 하위원인/cause를 가림 처리해 보존하는 직접 정정과 합성 회귀를 작성한다.

### 2026-11-06 — Review pass R3

- R2 두 원래 반례는 해결됐고 serializeError 순환·원인가림이 정적으로 확인됐다.
- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- `[medium]` `[patch]` R3-1 부재 단정을 부정하는 오류설명 거짓거부 — 새 substring 정규식이 “검색 결과가 없다는 뜻은 아닙니다”를 부재단정으로 읽는다. E8에서 각 부재표현의 국소적인 부정문맥을 확인하도록 정정하고 두오류코드 양성과 실제부재 별도문장 음성을 함께 고정한다. 범용 자연어 이해를 주장하지 않는다.

### 2026-11-06 — Review pass R4

- 원문 `.brain-automation/tickets/17.5/r4-followup.md`: R3-1 해결·새 finding0건. 국소부정과 별도부재문장 앞뒤혼합을 두오류코드의 자기시험이 직접 관찰하도록 작성됐음을 확인했다. 수정없음. 시험/실제평가/EXPLAIN은 아직 미실행이다.
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0

### 2026-11-06 — 개발 뒤 최초 검증 및 처분 대기

- 전체 TS: 201파일 중200통과·1실패, 4423passed·2failed·1skipped, 종료1. 실패둘은 recall-eval 자기시험192행의국소부정양성으로 `/아니/`가 `아닙니다`를거부한실제반례다. R3/R4정적검사는어미를동일하게읽어놓쳤으며 실제통과증거로쓰지않는다. 원본 `.brain-automation/logs/final-test.log`. Python전체는이어서순차실행해16파일69개통과·종료0, 내부Python244시험도통과했다. 전용PG정리성공.
- 실제행동평가 최초9사례:7통과/2실패. search-two는 적중+원문read는정상이고 보고의유효한메시지출처를판정기가인정하지않았다. search-not-installed는스킬의재질의를따랐으나fake고정집합에없어USAGE였다. 최초원문/판정은 `.brain-automation/evals/round1/`, `.brain-automation/tickets/17.5/eval-round1-verdicts.json`에보존한다. 고정호출재생/판정기자기시험과다른실제에이전트실행이다.
- EXPLAIN최초종료1:PG18의 current_setting(lc_collate)가없다. 원본 `.brain-automation/tickets/17.5/explain-round1.json`에실패와DB/컨테이너정리성공을보존했다. 수집성공으로세지않는다. E10정정뒤새출력으로재수집한다.
- 처음에는Python종료뒤수정하려했으나 실행경로대조결과수정3파일(search.mjs/recall-eval.test.ts/explain.mjs)은Python회귀가실행하지않는다. health-cases.json/제품코드/build산출물은보존하고정적수정만병행하며컴파일/재검증은Python종료뒤진행한다. 전체TS를재실행하지않고실패수정뒤관련시험·행동평가·수집도구를재검증한다.

### 2026-11-06 — Review pass R5 및 실패수정 재검증

- 원문 `.brain-automation/tickets/17.5/r5-followup.md`: E9/E10은사용자계약에맞는정정이며새finding0건. 앞선R4어미오독을명시했다.
- build/typecheck0, 관련bootstrap2파일22시험통과·종료0 (`recovery-recall-tests.log`). 수정후전체TS를반복하지않고최초실패와변경영향을재검증했다.
- 후속실제평가 새round2 search-two/search-not-installed모두통과. 지휘자가calls/outputs/report/transcript전문을대조했다. 최초round1의7통과+2실패는그대로보존하며round2로실패2건이해소됐음을구별한다.
- EXPLAIN round2는환경/색인조회와첫규모수집뒤 tool_notes_immutable_delete가두번째규모초기화DELETE를거부해종료1. 원본JSON·로그와정리성공보존. E11에서가드를끄거나원문을지우지않고규모별트랜잭션rollback으로합성자료를분리한다.

## Design Notes

중앙 결정 `msg_d236d40c4716`(2026-11-06): 최초 명세의 “공개 view”는 13.6이 허용한 SDK projection으로 충족한다. 검색층은 SQL view를 읽었다고 주장하지 않는다. “검색·수치 data 배열 유지”는 실제 producer와 충돌하므로 검색 배열/수치 기존 객체를 각각 유지하고 meta만 추가한다. 중앙이 부모 E17-5 문구도 정정했다. 새 migration 없이 schema39를 유지한다.

metadata 상태 정의와 우선순위(공개 사실만):

| 필드/우선순위 | 공개 근거 | 값 |
|---|---|---|
| source | 명시 source + listExtensionInventory.names + 결과 extension 출처 | 사전순 중복제거 source |
| installed / enabled | getExtensionPublicStatus | installed 그대로 / enabled 그대로(null 허용) |
| searchable | installed=true | true: 보존 자료 검색 허용, 적중 존재 보장 아님; enabled와 무관 |
| searchable 불명 | installed=false | null: 보존 자료의 유무/검색 가능성은 미설치만으로 확정 못함 |
| work_state 1 | replacementRequired | replacement_required |
| work_state 2 | quiesced | quiesced |
| work_state 3 | interruptedWorkCount>0 | interrupted |
| work_state 4 | heldScheduleCount>0 | held |
| work_state 5 | failedStage 또는 installResult=failed | failed |
| work_state 6 | 공개 stage.status=pending | pending |
| work_state 나머지 | 위 사실 없음 | unknown: 0건이나 설치 성공에서 idle/없음을 추정하지 않음 |

명시 source는 SDK sources 배열, CLI --source 쉼표구분 문자열로 전달하고 CLI/MCP schema와 일치시킨다. Garmin 이름은 스킬·fixture의 명시 입력에만 둔다. source 조회 실패를 침묵시키지 않되 기존 검색 실패는 해당 오류를 우선 보존하고 이미 얻은 metadata만 안전하게 붙인다. 오류 meta를 위해 공통 Failure/Envelope 전파를 확장할 수 있다.

연속성: 17.1은 현재 세대 전체 문맥 가림·source locator·증폭 제거를 유지한다. 17.1 reader 8MiB 비용 실측 deferred는 그 계획에 별도 보존하며 이번 정확도/EXPLAIN을 대체하지 않는다. 17.4는 status→config→현지 날짜/schema→조회→값·NULL·기간 보고, 오류/미설치·비활성 명령 부재 안내를 유지한다. 텍스트 재질의와 건강 조건 바꿔 맞추기를 혼동하지 않는다. 실제 Mac 설치본 10문항은 17.7이다.

릴리스: 중앙이 예약한21.11 기본0.1.22와 겹치지 않게 기본0.1.23 이상을 사용하고 마지막 release 직전 중앙과 최신 ref/version을 대조한다. metadata API를 포함하는 앞선 구현 commit을 먼저 만든 뒤 app-ref와 version을 같은 후속 release commit으로 올린다. ref가 가리키는 구현/시험 바이트를 검증한다. 기계적 릴리스 순서로 구현을 기다리지 않는다.

## Verification

- 개발·리뷰 수정: `pnpm build`, `pnpm typecheck`, `git diff --check`만. 시험 코드는 계속 작성한다.
- 마지막 구현·필요 후속 리뷰 뒤 전용 PG·home·venv·산출물에서 `VITEST_MAX_WORKERS=2 pnpm test` → `VITEST_MAX_WORKERS=2 pnpm test:python` 순차 각1회. 실패 수정 후 changed/관련 시험만 재검증한다. 로그·명령·종료코드·원본 실패와 처분을 `.brain-automation/`에 보존한다.
- `pnpm eval:recall prepare <검색사례> <새폴더>` → 실제 에이전트 → `pnpm eval:recall verify <폴더>` 네 사례. 호출/출력/보고/transcript 전문을 지휘자가 읽고 판정기 자기시험과 구별한다.
- E3 도구의 정확한 EXPLAIN 명령과 모든 새 시험 이름을 구현 notes에 보충한다. 두/세 글자·기호·NFC/NFD·재질의 각 문항의 기대 id와 전수 LIKE 결과를 기록한다.
- 자기 PG는 공식 postgres:18 전용 container/cluster·role을 사용한다. 운영/다른 티켓 PG를 공유하지 않는다. 잠금 사례는 별도 연결이 ACCESS EXCLUSIVE를 잡고 시험 adapter timeout을 유발하며 finally에서 rollback/연결종료한다. 모든 자원 ID와 부재 확인을 기록한다.
- 최종 diff 전문·행렬별 실행 증거·독립4렌즈 및 필요 후속 원문/행별 triage·문서 개인 홈 절대 경로0건·정확 원격 branch SHA·clean을 확인한다. main/state/운영 변경은 없다.

## 합성 PG 실행계획 증거

명령: `BRAIN_TEST_PG_RESOURCE_LOG=<전용로그> node tooling/recall-eval/explain.mjs --out <새파일>` 최종round3 종료0. 원본환경/SQL/ANALYZE BUFFERS 출력전문: [EXPLAIN JSON](evidence-17-5/explain.json). 공식이미지/환경/색인정의와36시나리오를아래고정했다. 단일표predicate probe이며제품전체검색조인·정렬·report세대·전체문맥비용을대표하지않는다. planner설정강제없음.

```json
{
  "server_version": "PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit",
  "encoding": "UTF8",
  "lc_collate": "en_US.utf8",
  "lc_ctype": "en_US.utf8",
  "datlocprovider": "c",
  "datlocale": null,
  "pg_trgm": "1.6",
  "image_id": "sha256:979bccfde35445db618c65107d27d08c6c21339d8dc3ad4c830c6633947be0e4",
  "repo_digests": [
    "postgres@sha256:979bccfde35445db618c65107d27d08c6c21339d8dc3ad4c830c6633947be0e4"
  ],
  "os": "linux",
  "architecture": "arm64"
}
```

```sql
CREATE INDEX chunks_body_idx ON brain.chunks USING gin (lower(body) gin_trgm_ops);
CREATE INDEX document_chunks_body_idx ON brain.document_chunks USING gin (lower(body) gin_trgm_ops);
CREATE INDEX file_names_text_idx ON brain.file_names USING gin (lower(text) gin_trgm_ops);
CREATE INDEX log_entries_text_idx ON brain.log_entries USING gin (lower(text) gin_trgm_ops);
CREATE INDEX tool_notes_target_idx ON brain.tool_notes USING gin (lower(target) gin_trgm_ops);
```

| 행수 | 대상 | 선택도 | 필터 | root node | 실제행 | 실행ms | shared hit/read |
|---|---|---|---|---|---|---|---|
| 100 | chunks | two-char | False | Seq Scan | 100 | 0.034 | 2 / 0 |
| 100 | chunks | two-char | True | Seq Scan | 49 | 0.034 | 2 / 0 |
| 100 | chunks | common | False | Seq Scan | 99 | 0.033 | 2 / 0 |
| 100 | chunks | common | True | Seq Scan | 49 | 0.033 | 2 / 0 |
| 100 | chunks | rare | False | Seq Scan | 1 | 0.033 | 2 / 0 |
| 100 | chunks | rare | True | Seq Scan | 0 | 0.037 | 2 / 0 |
| 100 | tool_notes | two-char | False | Seq Scan | 100 | 0.033 | 2 / 0 |
| 100 | tool_notes | two-char | True | Seq Scan | 10 | 0.01 | 2 / 0 |
| 100 | tool_notes | common | False | Seq Scan | 99 | 0.033 | 2 / 0 |
| 100 | tool_notes | common | True | Seq Scan | 10 | 0.009 | 2 / 0 |
| 100 | tool_notes | rare | False | Seq Scan | 1 | 0.033 | 2 / 0 |
| 100 | tool_notes | rare | True | Seq Scan | 0 | 0.009 | 2 / 0 |
| 100 | document_chunks | two-char | False | Seq Scan | 100 | 0.033 | 3 / 0 |
| 100 | document_chunks | two-char | True | Seq Scan | 50 | 0.019 | 3 / 0 |
| 100 | document_chunks | common | False | Seq Scan | 99 | 0.033 | 3 / 0 |
| 100 | document_chunks | common | True | Seq Scan | 50 | 0.019 | 3 / 0 |
| 100 | document_chunks | rare | False | Seq Scan | 1 | 0.034 | 3 / 0 |
| 100 | document_chunks | rare | True | Seq Scan | 0 | 0.019 | 3 / 0 |
| 10000 | chunks | two-char | False | Seq Scan | 10000 | 3.564 | 195 / 0 |
| 10000 | chunks | two-char | True | Index Scan | 49 | 0.067 | 110 / 0 |
| 10000 | chunks | common | False | Seq Scan | 9900 | 3.093 | 195 / 0 |
| 10000 | chunks | common | True | Index Scan | 49 | 0.023 | 8 / 0 |
| 10000 | chunks | rare | False | Seq Scan | 100 | 3.281 | 195 / 0 |
| 10000 | chunks | rare | True | Index Scan | 0 | 0.025 | 8 / 0 |
| 10000 | tool_notes | two-char | False | Seq Scan | 10000 | 3.264 | 195 / 0 |
| 10000 | tool_notes | two-char | True | Seq Scan | 1000 | 0.749 | 195 / 0 |
| 10000 | tool_notes | common | False | Seq Scan | 9900 | 3.204 | 195 / 0 |
| 10000 | tool_notes | common | True | Seq Scan | 1000 | 0.731 | 195 / 0 |
| 10000 | tool_notes | rare | False | Seq Scan | 100 | 3.297 | 195 / 0 |
| 10000 | tool_notes | rare | True | Seq Scan | 0 | 0.735 | 195 / 0 |
| 10000 | document_chunks | two-char | False | Seq Scan | 10000 | 3.368 | 225 / 0 |
| 10000 | document_chunks | two-char | True | Index Scan | 50 | 0.022 | 6 / 0 |
| 10000 | document_chunks | common | False | Seq Scan | 9900 | 3.308 | 225 / 0 |
| 10000 | document_chunks | common | True | Index Scan | 50 | 0.021 | 6 / 0 |
| 10000 | document_chunks | rare | False | Seq Scan | 100 | 3.224 | 225 / 0 |
| 10000 | document_chunks | rare | True | Index Scan | 0 | 0.021 | 6 / 0 |

100/10000행규모는각트랜잭션에서적재후rollback해분리했다. cleanup client_end/database_drop/container_remove 모두succeeded, errors=[]이다. 원본round1(PG18설정조회실패)·round2(불변DELETE거부)도로컬에보존하며완료실측으로세지않는다.

### 2026-11-06 — R6 수집기 확인

- 원문 `.brain-automation/tickets/17.5/r6-followup.md`: E11은DELETE/가드우회없고규모별rollback·실패정리가일관되며36시나리오/환경/5색인/정리성공/빈errors와자원로그를대조했다. 새finding0건·추가수정없음.

## 원문 회귀·검증 수락

- 전체회귀 순차명령: `VITEST_MAX_WORKERS=2 PYTHONDONTWRITEBYTECODE=1 BRAIN_TEST_DATABASE_URL=<전용PG> pnpm test` 종료1(201파일중200통과,4423passed/2failed/1skipped) → 같은환경 `pnpm test:python` 종료0(16파일69시험, 내부Python244시험). 원본TS의2실패는아닙니다어미를E9에서정정했고 `VITEST_MAX_WORKERS=2 pnpm exec vitest run --project bootstrap tooling/bootstrap/test/recall-eval.test.ts tooling/bootstrap/test/recall-skill.test.ts` 2파일22시험종료0으로재검증했다. 전체TS가처음부터통과했다고쓰지않는다.
- 수락행렬: 미설치/비활성보존report/활성0건/SEARCH_FAILED/DB_UNAVAILABLE은 `recall-metadata.test.ts`와 `extension-metadata.test.ts`, 명령오류meta·3MCP리터럴검색은 `extension-commands.test.ts`/recall-metadata, 수치객체와값/NULL·기간은 Python recall-health, 전체문자11문항×3대상+고정재질의/전수LIKE/원문은 `recall-regression.test.ts`, 스킬·판정기는 recall-skill/recall-eval에서실행됐다. 해당신규행렬시험 skip없음. 기존전체TS skip1은티켓수락시험을대체하지않는다.
- 실제행동 최초9사례7통과+2실패, 새round2의실패2사례모두통과. 기존나머지7사례는바뀐분기를사용하지않고원문읽기·코드/안내가대조돼불필요반복하지않았다. 지휘자는11회실제수행의calls/outputs/report/transcript를전문대조했다. 판정기22자기시험과구별한다.
- 시험·수집 소유PG/fixture 186개ID를정확ID Docker inspect로대조해잔존0. `resource-audit.json`에ID·확인결과보존. 자기워크트리·로컬브랜치·세션·gitignored원본증거는보존하며운영/다른티켓자원은변경하지않았다.
- 잔여한계: 큰source/inventory metadata는기존8000자봉투상한으로INVALID_ARGUMENT가될수있다(R1 BH3 low reject). transcript 자동파싱대신실제호출로그와원문수동대조를사용한다(BH10). EXPLAIN은단일표predicate이며제품전체SQL/reader8MiB비용을입증하지않는다. 17.1 reader비용deferred는원래계획에별도보존했다. 이번deferred는없고필수미실행을defer로숨기지않는다.
- 실제Mac설치본확인·운영사용은17.7범위이며이번에는합성검증만했다. 중앙main/state·운영변경없음. 최신 main 통합·릴리스 ref/버전과 관련 검증을 아래에서 수락했다.

## 중앙 최신 main 통합·릴리스 검증

- 구현커밋 `692b72a9b13a85c8af174fb88e43a287c9172787` 후 중앙지시 msg_c5c730506e83에따라 latest main `395a49a8eb70d8784c263b710e0842d63defd56f`를티켓브랜치에정상merge했다. 충돌없음. 중앙main/state는변경하지않았다.
- 통합커밋 `598497c4db6f0a6bea827f4dac5f483276fedf61`는metadata구현과21.11 bootstrap/22.2 snapshot을함께포함한다. plugin app-ref는이앞선통합커밋으로, version은0.1.22→0.1.23으로같은release변경에지정한다. bootstrap/snapshot소스는main과동일하며17.5가수정하지않았다.
- 통합후선정검증은 bootstrap/interactive-ref/recall스킬·판정기/extension-plugin, core fingerprint/metadata, PG conversation-index, CLI recall-metadata/extension-commands와Python recall-health이다. 기존전체회귀를무의미하게반복하지않고새bootstrap·snapshot과검색/확장명령연결표면을관찰한다. 결과전에는built로올리지않는다.


## Auto Run Result

- **결과: built.** 공개 SDK projection의 확장 상태를 검색·수치 응답 meta로 제공하고 기존 data 계약과 검색·원문·건강 절차를 보존했다. 구현 파일별 역할은 Code Map 및 E1~E11 구현 기록을 따른다. 핵심 변경은 core metadata/helper·봉투/검색/명령 연결, CLI/MCP source·봉투 연결, recall 스킬, 합성 행동 판정기·PG 회귀·EXPLAIN 도구와 시험, README·실측 JSON·이 계획이다. 릴리스 두 파일은 version 0.1.23과 앞선 통합 commit ref를 함께 고정한다.
- **독립 리뷰:** R1 네 렌즈 20행(중간13·낮음6·false1)을 전부 triage했다. 17행 patch(중복 포함), reject3은 BH3(큰 metadata 상한과 페이지화 복잡성), BH5(false: 다섯 색인 정의와 세 검색 대상 실측 구분), BH10(실제 호출 원문 수동 대조로 충분, 자동 transcript parser 추가 복잡성)이며 자세한 근거는 Review Triage Log에 남겼다. deferred는 단일 빈 목록이다.
- R2 중간1·낮음1 patch, R3 중간1 patch, R4 새 finding0. 이후 실제 회귀가 드러낸 한국어 어미/평가 출처/PG18 설정·불변 자료 정리를 E9~E11에서 정정했다. R5·R6·R7 모두 새 finding0이며 원본 실패를 보존했다. 최신 R7의 patch high0/medium0/low0, followup_review_recommended=false다. 전체 원문은 `.brain-automation/tickets/17.5/r1-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`, `r2-followup.md`~`r6-followup.md`, `r7-integration.md`이다.
- **최종 검증:** 앞 절의 전체 TS→Python 순차 실행과 실패 처분을 수락했다. 통합 뒤 `pnpm build`·`pnpm typecheck` 종료0, 선정 TS 10파일241시험 종료0 → Python recall-health 1파일3시험 종료0. 모두 worker2이며 명령 전문·시각·로그는 `.brain-automation/tickets/17.5/integration-result.json`에 있다. 실제 행동 최초7/9 및 실패2개 새 평가 통과, 합성 EXPLAIN 최종36개 성공을 수락했다.
- R7은 merge 부모·구현 전용26파일/main 전용24파일의 실제 바이트, README 양쪽 보존, ref 안의 제품·시험과 작업 트리 일치, bootstrap 설치·Garmin 객체·fingerprint·source·가림·metadata 호환을 독립 확인했다. 최신 통합 선정 시험의 성공은 지휘자가 별도로 확인했다.
- **소유 자원:** 전체 회귀·실측·통합 fixture와 부모 PG의 정확한 214개 ID를 Docker inspect로 확인해 잔존0이다. 운영/다른 티켓 자원을 정리하지 않았다. 워크트리·로컬 브랜치·세션·원본 증거는 보존한다. 최초 Terra ready 영수증은 investigation-start.json, 전체 worker-show는 investigation-show-full.json의 depth1/succeeded/released다.
- **잔여 위험:** 큰 inventory metadata의 8000자 상한, 판정기의 언어 휴리스틱 및 transcript 수동 대조, 단일표 predicate EXPLAIN의 전체 제품 SQL 비용 대표성 한계는 위 수락 기록과 같다. 등록되지 않은 확장 명령의 기존 USAGE/UNAVAILABLE gate를 모든 경우 자기설명 metadata 계약으로 확대하지 않았다. 미해결 필수 조건은 없다.
- **operator_actions:** 실제 Mac 설치본 확인·10문항 운영 검증은 17.7 소유자 범위다. 중앙의 결과 수락·main 병합/push는 중앙이 수행한다. 이 티켓의 branch push와 원격 SHA/clean 확인 결과는 로컬 ticket-result.md에 기록한다. 중앙 main/state와 운영은 변경하지 않았다.
