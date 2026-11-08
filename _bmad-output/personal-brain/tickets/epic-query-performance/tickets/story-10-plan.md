---
title: '흔한 검색어 10만 후보의 정확 동등 성능 개선'
type: 'feature'
ticket: '3'
created: '2026-11-06'
status: 'built'
baseline_revision: 'd6a0b4b614daa1c321c735a2ca09aab27d78e193'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** recall의 chunk/tool 검색은 흔한 단어가 후보10만건에 일치하면 모든 본문에 lower/length/replace 점수를 계산하고 tool 메시지까지 결합한다. 연구의 약1.54/1.74초는 조사값이며 이번 baseline에서 새로 전후 검증한다.

**Approach:** 정확한 점수의 반복 계산과 정렬/결합 비용을 줄이는 방안을 비교하고 원래 결과를 보존하는 최적화를 채택한다. 22.1/22.2의 실제 API·지문·오류/정리 계측을 재사용하는 common-search 러너와 독립 전수 oracle/고정 기대값으로 증명한다.

## Boundaries & Constraints

**Always:** 근접(worktree/project/기타) → 리터럴 비중첩 제거문자수 → from_at DESC NULLS LAST → id ASC 순서, index config, 원문 bytea 복원, 도구 orphan/메시지 유일결합, 가림 후8000코드포인트·has_more/omitted/next·0건/오류 분류·17.5 meta.extensions를 유지한다. 같은 전용PG·fixture·runner·Node/PG·환경의 baseline/change를 warmup1+3원시표본/중앙값으로 비교한다. common chunk/tool 각각 비율≤0.5, 짧은 a/긴 불일치 각 대상 비율≤1.0(무악화), 임계 완화 금지. 확정 측정 전 중앙에 명시만료창 요청. 준비/oracle/EXPLAIN은 표본 밖, 실제 core 검색 API wall과 별도 store/SQL 진단을 구별한다.

**Never:** 후보 누락·결과캐시·단언축소·시험전용우회·계약변경·운영/타티켓자원 접근변경·실대화/계정 사용·중앙 state/main 수정/병합/push. schema39/과거migration 불변, 새index는 번호/크기/같은쓰기비용 중앙조율 전 추가 금지. 첨부adapter/건강SQL/doc reader8MiB/설치bootstrap/metadata새기능/릴리스 변경은 범위 밖. 개발·리뷰수정중 시험/eval/성능실행 금지, 컴파일만. 최종 수정/필요후속 후 성능 및 worker2 전체순차회귀 수행.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 전역 순위 | chunk/tool, 단계0/1/2와 높은하위점수, 동점·동시각·NULL시각, limit1/5/200 | 고정기대순서와 독립 원형 전수SQL 양쪽 일치, 후보누락 없음 | 기존 분류 |
| 문자/원문 | 한국어2글자, NFC/NFD, %, _, 역슬래시, 대소문자·비중첩aa/aaaaa, NUL/raw, 다른index | 기존 literal LIKE 집합/순서·원문 및 필터 유지 | 잘못된입력 INVALID_ARGUMENT |
| 도구결합 | 연결/고아·raw harness id 구별 | 정확 message_id/from_at·NULL 마지막, 유일행 | DB_UNAVAILABLE/SEARCH_FAILED 유지 |
| 출력예산 | 긴본문·이모지·가림마커·출처·limit+1 | JSON/텍스트8000한도, 잘림/생략/next 및 has_more 독립, meta.extensions 유지 | 가린세션 출처/metadata오류 유지 |
| 0건 | 긴불일치 | 빈목록/hint·metadata·has_more false | 오류로 오인하지 않음 |
| 성능 | 대상별10만×1024 ASCII byte, common/a/긴불일치 | 동일 전체결과hash와 독립oracle; common 각각≤0.5, a/불일치 각각≤1.0 | 누락/실패/잘못된표본은 pass 금지 |

</intent-contract>

## Code Map

- `packages/postgres/src/recall.ts` searchRecall: LIKE trigram 후보, session 근접도, 중복 lower 및 length/replace 정렬. searchDocuments/readDocument는 보존한다. `text.ts`의 pgText/originalText, `0001_initial.sql` messages UNIQUE NULLS NOT DISTINCT 결합을 재사용한다.
- `packages/core/src/recall/{search,results,text-query,extension-metadata}.ts`: limit+1, mask, 예산과 metadata 경계. 제품 core 변경은 필요할 때만 최소화한다.
- `packages/postgres/test/{recall,recall-regression}.test.ts`: 고정Unicode/전수LIKE oracle·잠금오류·raw/orphan. `packages/core/test/{recall-budget,recall-read}.test.ts`, `apps/cli/test/{recall,recall-metadata}.test.ts` 기존 계약을 보존한다.
- `tooling/query-perf/src/{revision,import-cleanup,session-snapshot,core}.mjs`, `run.mjs`: checkout 실제 built API/pg, 산출물/runner/lock 지문·오류/정리 패턴 재사용. 공통 run/core는 새scenario 분기만; 새 `src/common-search.mjs`와 전용 비교모듈에 로직을 둔다. 기존scenario/공통비교API 변경 필요시 중앙조율.
- `tooling/query-perf/test/`, `vitest.config.ts`, `tooling/test-changed/rules.mjs`: 새 순수/DB 시험 등록과 JS 경로 의존 선정. 새 child/SQL 경로 추가시 규칙 확인.
- 연속성: 22.1의 fixture ANALYZE/실제API 및 22.2의 무간섭표본·별도EXPLAIN·오류보존/초기실패독립정리 원칙을 유지한다. 연구 표 번호는 검색이6이며 entry의5는 오기다. source-only 조사 수치를 이번 성능으로 대용하지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] T1 `packages/postgres/src/recall.ts`, 새 `packages/postgres/test/recall-performance-contract.test.ts` — lower/점수 계산 공유와 좁은정렬/최종행지연복원을 우선 구현한다. 정확상한 pruning·점수경계 지연tool결합을 대안으로 정적비교해 결정근거를 기록한다. 상한/동점 가지치기를 택하면 전수동점 및 같은statement snapshot을 보증한다. matrix 순위/문자/도구·raw/orphan에 독립 원형SQL과 고정값 시험을 작성한다.
- [x] T2 `tooling/query-perf/src/common-search.mjs`, 전용비교모듈, `run.mjs`, `src/core.mjs` — 동일 결정적10만chunk/tool×1024 ASCII, 연구와 같은20 chunk세션/연결tool장기세션, common/a/긴불일치 및 NULL문맥·기본limit5(store6) 조건을 작성한다. 실제core API와 독립 원형SQL·고정상위값을 비교하고 결과전체/순서/잘림/metadata hash, 원시3·중앙값·SQL수/시간·EXPLAIN·fixture/환경/산출물지문·UTC/load/process·실패 및 cleanup을 기록한다. 근접/가림 보조fixture는 기본을 대체하지 않는다.
- [x] T3 `tooling/query-perf/test/common-search*.test.ts`, 필요 core/CLI회귀, `tooling/query-perf/README.md`, 필요 `tooling/test-changed/rules.mjs` — matrix출력예산/metadata, 비교기6조건완전성·표본/중앙값/fixture/환경/지문/동등성/각임계 경계거부, runner warmup제외·실패분류·정리를 검증하는 시험코드와 재현절차 작성. 순수/DB 프로젝트 실제등록 확인.
- [x] T21 `packages/postgres/migrations/0040_recall_expression_statistics.sql`, `packages/postgres/src/migrate.ts`, 현재schema기대시험·새통계migration회귀 — 중앙예약식통계후보와39→40/권한/재실행·과거이력보존을구현한다.
- [x] T22 `tooling/query-perf/src/common-search.mjs`, 비교기/회귀/README — 준비프로토콜2의고정VACUUM(ANALYZE)·통계/GIN/관계/행수/시간/잠금/쓰기/유지비증거와동일준비완료판정을구현한다.
- [x] T23 진단 오류·준비 실패의 점진적 증거와 소켓 오류 정리를 보존한다.
- [x] T24 실제 brain_app 검색 연결·역할 설정과 같은 제품 SQL의 39→40 전후 계획 진단을 보강한다.
- [x] T25 프로토콜2 준비/비용/통계/이력 증거 비교와 거부 회귀를 보강한다.
- [x] T26 PG18 ANALYZE 폭 제한에 맞춰 1024바이트 통계의 정상 기대와 회귀를 교정한다.
- [x] T30 PG16이후 locale 카탈로그 수집을 교정하고 T29 잔여 병목의 정적 대안을 분석한다.
- [x] T31 효과 없는 미출하0040 후보를 증거 보존 후 철회하고 schema39/러너 계약을 복원한다.
- [x] T32 statement 불변 ASCII 환경 gate를 상관 없는 scalar subquery로 한 번 평가하고 계약 회귀를 보존한다.
- [x] T4 이 계획과 `.brain-automation/` — 독립4렌즈·행별triage·후속 리뷰, 성능 증거, 최초 전용전체회귀 실패별 수정과 관련 재검증·matrix 감사, 정확 소유 PG 정리/부재 및 증거 보존을 완료했다. 범위 commit·자기 branch push·원격 SHA 확인과 중앙 결과보고는 제출 gate로 남는다.

**Acceptance Criteria:**
- Given 같은 baseline과 변경 API/fixture/환경, when common-search 전후와 compare를 실행, then 결과목록/순서/잘림/has_more 등 전체가 같고 common chunk/tool 각각중앙값≤0.5배, a/긴불일치 각중앙값≤1.0배다.
- Given 위matrix와 기존회귀, when 최종 worker2 전체회귀를 순차 실행, then 각행을 검증하는 시험이 실제선정/통과하며 한국어2글자·기호/NFC/NFD·독립전수LIKE/고정값 및 metadata/예산/오류계약이 보존된다.
- Given 모든 수정과 필요한후속 완료, when 최종감사, then 리뷰행별처분·실측원시/실패/채택근거·명령/종료/로그·자원정리·원격SHA가 보존되고 필수미완료를 deferred로 숨기지 않는다.

## Implementation Notes

- T22프로토콜2: 고정순서VACUUM(ANALYZE)/pre-post행수·GINpending/관계·autovac·통계·권한준비, 별도DB쓰기/유지ANALYZE/실제39→40migration·잠금표본·정리/비교기·회귀구현. 지휘자가helper/러너/비교/시험diff를확인했다. `.brain-automation/reports/t22-protocol2.md`: build/typecheck/syntax/diff0, 시험/실측미실행. 준비/통계효과는후속검증전미입증.

- T21중앙승인후보: 0040식통계2개+ANALYZE/현재schema40, 현행설치·최고버전기대만40으로갱신하고역사39/이전migration보존. 지휘자가새SQL/실제owner신규·39→40/선택도/ledger·원문보존회귀와모든기대diff를확인했다. `.brain-automation/reports/t21-expression-stats.md`: build/typecheck/diff0, 실제효과/시험미실행으로미채택후보상태.

- T18직접축소: 외부ASCII CASE가참인경우만본문/Clower byte長동일성으로첫fold를생략하고guard/fold각1번. 非ASCII/localefallback·후보LIKE·정렬불변. 지휘자가제품diff/독립oracle/직접score동등회귀를확인했다. `.brain-automation/reports/t18-score-fold-once.md`: build/typecheck/diffcheck0, 시험/실측미실행.

- T15 R3교정: 전체실행setup~cleanup시각/단계snapshot·검색SQLspan지문/시간·locale정보·sessions포함결정적전체fixture필드·불일치ID/첫차이hash 보강. 지휘자가소스/시험전문을확인했다. `.brain-automation/reports/t15-evidence.md`: 최종build/typecheck/syntax/diffcheck0, 최초시험인덱스typecheck1은교정, 시험미실행.
- 중앙22.4수락SHA `eaff4ccd4de4932f8a899dd9c8d69277380f44f7`를원격확인후티켓branch에정상fast-forward통합. 정확22.3경로만stash보존뒤apply, README/run/core3충돌은양쪽가산등록/문서유지로해결했다. 소스SQL충돌없음, attachment3파일은main바이트유지. 백업stash/원래baseline은보존, `.brain-automation/tickets/22.3/main-integration.json` 참조. syntax/diff0, 통합compile/독립표적확인을진행한다.

- T14 R3교정: 전용PG18cluster의터키어ICU/template0 DB에서실제chunk/tool store를호출하고lower I전제/고정순서/원형oracle을검증하는시험작성. 지휘자가setup·실제경로·중첩finally정리를확인했다. `.brain-automation/reports/t14-locale-regression.md`: build/typecheck/diffcheck0, 시험미실행.

- T13재구현: baseline조회구조/병렬가능성을복원하고UTF8/ASCII/locale가드아래C소문자·바이트길이제거점수만교체. 지휘자가제품diff/새Unicode·ASCII·빈query·fallback/원형oracle시험과정적증명을확인했다. `.brain-automation/reports/t13-score-rework.md`: build/typecheck/diffcheck0, 아직실측/시험미실행. T12미달은그대로보존.

- T1: lower 공유 LATERAL/OFFSET0, 좁은 topN materialized CTE와 동일statement 원문복원 구현. 지휘자가 제품diff/전수oracle·고정순서·raw/orphan·index필터 시험 전문을 확인했다. 기존messages 결합/모든정렬키는 보존. `.brain-automation/reports/t1-implementation.md`: build/typecheck/diffcheck0, 시험/성능 미실행. 효과미입증이며 병렬계획/추가lookup 악화위험을 최종실측에서 판단한다.

- T2: 6조건 실제core/store 러너·독립원형SQL/fixed6·전체응답hash·SQL추적/EXPLAIN·fixture지문/환경·초기오류/독립정리·엄격비교기 작성. 지휘자가 두 새모듈과 run/core분기 전문을 확인했다. `.brain-automation/reports/t2-runner.md`: build/typecheck/syntax/diffcheck0, 런타임 미실행. 기본fixture는 모든후보동점/1024byte로 가지치기에 유리하게 바꾸지 않았다.

- T3: 비교6조건/임계·provenance·raw표본·실패정리·warmup·소형DB와 core예산/metadata 시험 및 재현문서 작성. 지휘자가 새시험/runner변경/문서 전문과 unified diff를 확인했다. `.brain-automation/reports/t3-tests-docs.md`: build/typecheck/syntax/diffcheck0. matrix실제선정/통과 감사는 개발종료후 전체회귀로 이월하며 현재미실행을 pass로 계산하지 않는다.

- T5 R1교정: 무계측wall/별도trace, partial실패증거·CLI실패교체시험, baseline/EXPLAIN/host+cluster·표본UTC검증보강. 지휘자가전체소스/시험을확인했다. `.brain-automation/reports/t5-r1-measurement.md`: build/typecheck/syntax/diffcheck0, 실행미검증. IA-C/BH8은다음Task.

- T6 R1교정: 기본6조건뒤 실제PG/core 가림·긴본문잘림·근접보조fixture 및 전체hash/고정next·omitted확인, NULL문맥3조합 전수oracle/고정순서회귀 추가. 지휘자가제품외변경/시험을확인했다. `.brain-automation/reports/t6-r1-contract.md`: build/typecheck/syntax/diffcheck0, 시험미실행.

- T7 R2교정: 생성DB실효PG설정·제품동일UTC/timeout옵션, 순차UTC포함/비중첩검증, socket/cleanup code보존과회귀코드추가. 지휘자가소스/시험을확인했다. `.brain-automation/reports/t7-r2-measurement.md`: build/typecheck/syntax/diffcheck0, 실행미검증.

- T8 R2교정: 실제PG 혼합영문횟수/반대시각의고정순서·양쪽query/oracle, tool_raw NUL복원, 역삽입고정UUID NULL시각동점orphan/limit경계회귀추가. 지휘자가추가fixture/단언을확인했다. `.brain-automation/reports/t8-r2-contract.md`: build/typecheck/diffcheck0, 시험미실행.

- T9최종준비: 정확baseline canonical/archive→독립node_modules/core+PG build, current build/typecheck 및실제지문영수증확인. 전용PG18.6 perf/test2개·소유HOME/Dockercontext/OrbStack실제child/Compose·repo밖TMPDIR준비. `.brain-automation/reports/t9-final-prep.md`, build-receipt/resources JSON에명령/종료/정확ID보존. 아직시험/성능미실행. 90분제안은과도하여조사query수/시간근거로10분창을먼저요청한다.

- T10최초실측실패보존: 중앙창09:53:26UTC, baseline09:44:54→09:45:02 exit1 chunks/common store oracle mismatch; 표본0/change·compare미실행/자동반복없음. qp_6d110759eee910f56d29 created/deleted=true·잔존0/client0. 원시 `/private/tmp/brain223-prep.DupxZd/performance.nn04gT/`, 보고 `.brain-automation/reports/t10-performance.md`. 지휘자정적대조: 러너CONFIG=…0001 vs제품CONVERSATION_CHUNK_INDEX_CONFIG_ID=…0003, oracle도같은오상수를공유해잘못된설정세대를검사했다. 제품필터/기대순위/임계는보존하고fixture만정확세대로교정한다.

- T11교정: CONFIG를정확대화세대0003으로변경하고checkout export+실제migration설정독립전제, 전체fixture행고정세대회귀를추가했다. 지휘자가변경/시험을확인. `.brain-automation/reports/t11-fixture-config.md`: 최종build/typecheck/syntax/diffcheck0(최초시험import typecheck1은상대source경로교정), 시험/실측미실행. baseline/current제품산출물불변, 새runner영수증t11-runner-receipt로보존.

## Plan Change Log

- 中央결정 `msg_c0f4dbcabc0a`: 0040을22.3식통계후보용예약, 채택시CORE_SCHEMA_VERSION40과현행기대만40으로갱신. 0001~0039불변/운영적용없음/인덱스·플래너강제금지. 실제추정/행/plan/효과·39→40/brain_owner/잠금/시간/크기/쓰기/통계갱신비용증거로채택판단. 준비프로토콜2는양fixture완료뒤동일VACUUM(ANALYZE), pre/post GIN상태·관계크기/행수·ANALYZE시각·autovac/UTC가능범위기록, 준비비용표본밖. baseline원래migration/current실제0040을사용하고이전프로토콜실패와혼합금지, 6조건/warmup+3/.5·1.0불변.


- T17실측: baseline10:19:28.094→10:20:28.660/current10:20:28.661→10:21:09.153 각0, compare1. common chunk1417.470→818.912(.5777)/tool1576.870→985.960(.6253)미달. a chunk.5734/tool.5938·chunk missing.4923은통과, tools missing1.068→1.765(1.6534)미달. 6조건/보조결과동등true. 원시 `/private/tmp/brain223-prep.DupxZd/performance-t17.1eMHWB/` 및t17보고보존, DB두개created/deleted·잔존0. threshold불변.
- T17정적계획: a의GatherMerge/worker2복구, common의BitmapHeap filter 약420/433ms 및전체803/995ms, tool메시지결합누적약600ms. 새점수식은같은ASCIIguard/length검사/Clower를2번반복. T18은외부CASE로가드1번/ASCII에서만body와Clower의byte길이동일성을사용해fold1번·검사1번으로줄인다. 非ASCII/locale불일치는기존byte제거식fallback유지, 전체LIKE/후보/순위불변. 무조건원문길이대체금지라는초기설계제약은유지하며ASCII증명하의조건부분만허용한다. tools missing의SQL EXPLAIN0.022→0.026ms와SQL진단0.34→0.5ms, core추가비용은실측상분리되지만잡음이라고단정하지않고동일엄격1.0기준재검증한다.


- T12실측미달보존: baseline09:52:52→09:53:52/change09:53:52→09:54:57 각0, compare1. common chunk1412.175→1040.600(.7369)/tool1615.940→1210.838(.7493), a chunk517.248→1030.392(1.9921)/tool553.546→1092.639(1.9739), missing chunk4.358→4.558(1.0460)/tool1.829→3.817(2.0863). 6조건결과hash/보조동등true이나모든임계미달. 원시 `/private/tmp/brain223-prep.DupxZd/performance-t12.5h3uDa/`, 보고t12-performance.md, DB두개삭제/잔존0보존.
- T12계획대조: baseline a는 Gather Merge/worker2, 변경a는OFFSET0상관LATERAL Result100000loops 및병렬없음. common도folded lower100000회와LIKE lower가남아1초이상. 시도한공유/좁은정렬안은미채택. KEEP: 기존원형oracle/고정순위·raw/NULL동점·기본6조건·잘림보조·모든실패·임계. 제품조회는baseline구조로되돌리고점수식만개선한다. UTF8이고ASCII(lower기본alphabet==C일치)본문일때만빠른C소문자변환, 그외원래lower로fallback; byte長제거차이는같은검색어안에서횟수×고정querybyte長이므로순위가원래char長차이와동일하다. querylower는원래locale를유지한다. gate/순위증명과혼합Unicode/빈query/localeguard 회귀를추가, 시험실행은개발뒤로유예. 새index/schema변경없음.


## Review Triage Log

### 2026-11-06 — R1 독립4렌즈

보고도착순 VG→EC→IA→BH, 총14행: high0/medium9/low2/false3/maybe-false0. 모든개별행을 유지하며 중복은 처분만 공유한다. 수정중 시험미실행.

- VG1 [medium][patch] CLI 실패후 이전성공JSON 교체/정리상태·정제·종료1 시험공백 — preverified. 실제 main 경계에서 성공파일 선작성후 합성실패를 주입해 파일/exit1/자원/정제를 확인하는 시험을 추가한다.
- EC1 [low][reject] CREATE응답유실시 created=false로잔존가능 — 실제 희귀실패. 새관리연결/복구분기를 더하는비용에 비해 일상발생가능성이 낮고 이번 disposable전용cluster 최종정확ID제거로 잔존을 제한한다. 랜덤DB이름/created미확정의 한계를 최종보고에 보존하고 실제최종부재를 확인한다.
- IA-A [false][reject] 후보계산수축소/대안비교 해석차이 — 원문 괄호는 예시이며 per-candidate lower중복도 본문점수계산비용이다. T0/T1보고에서 세대안의정확성/비용을 정적으로비교했다. diff밖로컬증거를 누락된제품요구로 취급하지 않는다. 실제0.5달성은 아직미검증으로유지.
- IA-B [false][reject] 큰성능fixture와 넓은계약fixture의분포차이 — 원문이모든분포의성능을 요구하지않음. 기본10만/1024byte·NULL문맥은연구재현이고 근접/점수차이계약은 별도실제PG시험으로검증한다.
- IA-C [medium][patch] 실제잘림을강제하는DB/core전후보조증거 없음 — 기본6조건을바꾸지않고 별도합성긴본문/가림/근접 보조실제API결과를기준/변경각각 oracle·고정값과확인해hash비교한다. 판정시간과혼합하지않는다.
- IA-D [false][reject] 실제성능/회귀통과증거 없음 — 현재사용자지시대로개발중미실행이며 built전필수검증으로남아있다. 통과했다고주장하지않는다.
- BH1 [low][reject] CREATE응답유실시잔존 — EC1과동일원인/위험제한. 추가복구복잡성은이번에기각, 정확이름·미확정한계와최종cluster제거증거보존.
- BH2 [medium][patch] 중간실패가완료표본/환경/revision/현재단계유실 — 실행초기부터partial evidence를두고 catch/CLI실패JSON에정제된기완료runs/시각/단계/지문을보존한다. 실패주입시험을추가한다.
- BH3 [medium][patch] 비교기가지정baseline/dirty정책미검사 — 기존API를바꾸지않고 이고정시나리오의baseline SHA 및 archive null쌍/clean git만허용한다. 다른SHA/dirty거부시험.
- BH4 [medium][patch] EXPLAIN truthy만확인 — JSON배열/Plan·Actual행/시간·Buffers/유한ExecutionTime 구조를검증하고 비어있거나형식틀린계획을거부한다.
- BH5 [medium][patch] 판정wall에trace오버헤드혼입 — 무계측warmup+3core wall과 별도trace진단3회/store/EXPLAIN분리, 매결과hash확인. warmup과계측경계시험보강.
- BH6 [medium][patch] 동일호스트/cluster 식별부재 — 비밀URL없이해시된호스트/CPU모델/메모리와PG system_identifier·주요설정기록/비교. 로컬증거를공개Git에복사하지않는다.
- BH7 [medium][patch] 각표본UTC없어측정창대조불가 — 각조건warmup/판정3/별도store·SQL진단/EXPLAIN의UTC범위보존. 중앙창과지휘자가대조한다.
- BH8 [medium][patch] NULL문맥조합의점수/시각충돌회귀부족 — worktree만/project만/둘다NULL에서독립전수oracle와고정기대순서비교추가.

patch9행은 독립root 측정증거·비교엄격성·출력보조/회귀로나눠같은Terra에순차배정한다. high0/medium다수이므로후속독립4렌즈필요: 새무간섭계측·partial실패증거·실제잘림보조가정확한지확인한다. deferred0, 미충족AC를기각/defer하지않았다.


### 2026-11-06 — R2 후속 독립4렌즈

도착순 VG→EC→IA→BH, 총18행 high0/medium9/low1/false8/maybe-false0. 후속pass high0이므로 추가전체4렌즈권고false. 측정환경/시간검증의직접교정은 표적독립확인을거쳐실행한다.

- VG1 [medium][patch] 혼합대소문자점수경쟁 통합시험공백 — preverified. chunks/tools에서오래된 AA Aa aa가최신 aa aa보다앞서는 고정순서+독립oracle시험.
- EC1 [medium][patch] 비UTC fixture일자가고정UTC next와불일치 — 관리자/fixture/EXPLAIN 원시연결 timezoneUTC, 실제제품설정과동일성을확인. 비UTC기본DB 회귀코드작성.
- EC2 [low][reject] carried R1 EC1 CREATE응답유실 잔존 — 같은위치/주장/코드라같은처분. 소유정확cluster최종제거·한계보존.
- IA-A [false][reject] carried R1 IA-A 계산후보수축소해석 — per-candidate중복계산제거도본문점수비용감소, 특정pruning강제아님. 후보수감소로주장하지않는다.
- IA-B [false][reject] carried R1 IA-A 대안비교diff부재 — T0/T1로컬정적비교와계획근거보존. 새기법의실측결과로꾸미지않는다.
- IA-C [false][reject] carried R1 IA-B 기본성능분포한정 — 연구동일분포의수락이고 모든분포성능보장아님.
- IA-D [false][reject] 실제잘림과기본성능fixture분리 — R1수정으로같은실행의별도실제PG잘림결과hash/고정출처증거추가. 원문은잘림을위해기본fixture를바꾸라고요구하지않음.
- IA-E [false][reject] carried R1 IA-D 실제성능/회귀증거없음 — 사용자개발중미실행정책. 필수최종실행은여전히남아있고built미전이.
- IA-F [false][reject] core wall 판정, SQL/store는진단 — 계획에실측전고정한관측API시간이며원문이계층별별도0.5를요구하지않음. 진단결과도최종에공개.
- BH1 [medium][patch] 비UTC fixture — EC1같은원인/수정.
- BH2 [false][reject] ps split이리터럴역슬래시n — 실제소스는 JS `.split('\n')` 즉newline escape한개다. Python repr도단일역슬래시한개를확인했다. 리터럴두문자로분리하는 `.split('\\n')`가아니므로주장불성립.
- BH3 [medium][patch] 관리자DB설정을제품환경으로기록 — 생성DB에서제품Pool과동일options의진단연결을사용해유효설정을수집하고EXPLAIN일치확인. 관리자DB별work_mem/jit설정회귀추가.
- BH4 [medium][patch] 표본UTC의실행포함/순서/전후비중첩미검사 — warmup→wall3→진단3→store3→EXPLAIN 및조건순서/전체포함·base끝≤change시작검증과거부시험추가.
- BH5 [medium][patch] socket/cleanup wrap시code유실 — 원래code를복사해failure.errors/CLIJSON까지보존하고주입시험보강.
- BH6 [false][reject] SHA와dist대응빌드증거미확인 — 지문이source대응을자동인증한다고주장하지않으며계획/README가독립archive/빌드와최종로그감사를필수화한다. 최종준비Task가정확SHA/archive/빌드명령·종료/산출물지문을연결한로컬영수증을작성한다. 자동제품/러너manifest API를추가할필수결함은아니다.
- BH7 [medium][patch] 혼합대소문자본문/검색어회귀 — VG1같은원인, 소문자/대문자query와고정순서·oracle추가.
- BH8 [medium][patch] tool_raw지연복원회귀없음 — raw NUL도구명저장/반환원문단언추가.
- BH9 [medium][patch] 같은점수·NULL시각orphan동점여러개없음 — 고정UUID역삽입/최종ID순서·limit경계회귀추가.

교정은 T7측정환경/시간/오류 및 T8계약회귀 두계약경계로 나눈다. 기존Terra6Task완료로새Terra/medium을사용하며부분작업/영수증/세션은보존한다. threshold/fixture/제품검색의미완화없음, deferred0.

### 2026-11-06 — T7/T8 표적 독립확인

Sol/medium `ctx_563336ea3bd5` 전문 `.brain-automation/reports/target-review.md`를읽었다. 지정측정환경/무계측/시간/오류코드/계약회귀에서새finding0. 추가수정필요없음, 독립확인완료. 개발·리뷰수정이끝났으므로최종검증준비로전환한다. 아직시험/성능통과는주장하지않는다.

### 2026-11-06 — T11 fixture교정 독립확인

Sol/medium `ctx_517a6f049506` 전문 `.brain-automation/reports/fixture-target-review.md`를읽었다. 최초실패와baseline0003·fixture교정·export/migration독립전제·회귀가일치하고제품SQL/기대순서/6조건/규모/임계불변, 새finding0. 새실측창을요청하고개발완료검증으로재전환한다.

### 2026-11-06 — R3 재구현 독립4렌즈

도착순 EC→VG→IA→BH, 총18행 high0/medium6/low6/false6/maybe-false0. 후속pass high0이므로추가전체4렌즈권고false. 실제locale제품회귀·전체증거시각의표적확인을한번수행한다.

- EC1 [low][reject] carried R1 EC1/R2 EC2 CREATE응답유실 — 희귀미확정생성복구분기기각·정확전용cluster최종제거/한계보존동일.
- EC2 [medium][patch] 전체실행비중첩이setup/cleanup을덮지못함 — 외부최초preflight시작부터자원정리완료끝을실행구간으로기록. 측정구간별span은그대로구별.
- VG1 [medium][patch] 실제locale의제품SQL fallback회귀부재 — preverified. 별도터키어ICU DB에서lower I 전제·오래된 I I vs최신 I의chunk/tool 고정순위/독립oracle 실store시험추가. 단순false CASE복사로대체금지.
- IA-A [false][reject] carried R1/R2 대안비교/후보수감소해석 — T0정적3대안/T12실제실패비교와선택근거보존. 전체후보수축소로주장하지않고점수비용개선수단으로판정.
- IA-B [false][reject] carried R1/R2 성능분포한정 — 원문연구와동일fixture판정이고모든Unicode분포성능보장아님.
- IA-C [false][reject] 내부점수숫자불변해석 — 제품응답에점수없고정렬순위가관련도계약. 같은query비중첩횟수에양의고정비례이므로순위/동점보존, 새시험고정값/oracle유지. localefallback공백은VG1로교정.
- IA-D [false][reject] carried R2 IA-D 잘림보조와기본성능분리 — 실제PG/core보조잘림계약및전후hash확인, 원문요구를충족하는검증분리.
- IA-E [false][reject] carried R1/R2 실제최종성능/회귀증거부재 — 아직T13재실측/전체회귀전, 미통과로명시·built미전이.
- BH1 [low][reject] 필수settings스키마를비교기가완전검증안함 — 실제runner는고정전체목록을생성하고원시/동일cluster/설정감사를수행한다. 양쪽JSON을임의축소하는일상외조작에추가스키마guard를늘리는비용이라기각. 실제필수환경누락은최종수락금지.
- BH2 [low][reject] wall값과UTCspan길이불모순검사없음 — 실제runner의같은호출에서두시계를직접기록한다. 손편집표본의모순을위한새허용오차/시계guard는일상외이고계획원시감사로확인. 실제값조작은허용안함.
- BH3 [low][patch] SQLspan검색/metadata구분없음 — 각span의정규화SQL지문/검색여부·검색SQL시간과전체DB합계를별도기록한다. 기존totalMs는총DB라는의미유지.
- BH4 [low][patch] locale provider/version증거없음 — 실제생성DB의provider/locale/version을직접기록하고양쪽동일성검사. 원시URL/호스트명노출없음.
- BH5 [medium][patch] setup앞snapshot과측정시작뒤startedAt불일치 — EC2전체구간으로교정하고setup/measurement 시작·종료snapshot각UTC를구별해보존.
- BH6 [medium][patch] fixture전체sessions/순위·출력·조인필드지문부족 — 결정적실제합성필드의sessions/chunks/messages/tools지문을확대하고서로다른fixture가동일하다고판정되지않게유지. 준비시각처럼비결정적운영필드는포함하지않는다.
- BH7 [low][reject] import/URL초기실패는evidence null — DB생성이전이므로소유자원없고CLI는실패JSON/메시지/exit1기록. 없는빌드/잘못된URL사전입력의희귀실패에새단계복구분기를더하는복잡성기각. 실제최종검증은T9build/urlready확인뒤실행.
- BH8 [medium][patch] mismatch실패기대/실제ID유실 — 합성expected/actual순서·해시/보조응답첫차이요약을partial에저장해재실행없이진단가능하게한다. 비밀/원문대량덤프금지.
- BH9 [medium][patch] 실제localefallback제품시험부재 — VG1같은원인/수정.
- BH10 [false][reject] carried R2 BH6 source/dist빌드대응자동검사없음 — 이미T9독립archive/build-command/exit/산출물영수증과T11불변확인으로실제대응감사를요구/수행. T13새currentbuild영수증을후속준비에서추가하고baseline은보존. 자동manifest새API불필요.

### 2026-11-06 — R3교정/22.4통합 표적독립확인

Sol/medium `ctx_fb871bcb99ed` 전문 `.brain-automation/reports/r3-target-review.md`를읽었다. T13순위동등/ASCII가드·T14실제터키어ICU제품관찰·T15전체증거와첨부가산등록을정적으로확인, 새finding0. 통합build/typecheck/diffcheck0. 개발·리뷰수정완료로최종검증재전환. baseline독립빌드는불변확인, 새current/runner/lock·통합로그지문은t16-build-receipt.json에보존. 아직새실측/전체회귀는미실행.

### 2026-11-06 — T18 표적독립확인

Sol/medium `ctx_63059d1749e7`후속결과전문 `.brain-automation/reports/t18-target-review.md`를읽었다. 외부CASE·조건부byte長대체/fallback·순위증명·실제store/Turkish회귀보존, 새finding0. 최종build/typecheck/diff0·t19-build-receipt로baseline불변/current대응확인. 개발완료검증으로전환, 새실측·전체회귀는남았다.

## 준비 프로토콜 2 사전 고정

중앙승인에따라 fixture직후 pre상태→같은UTC/lock0/statement0소유관리연결의transaction밖 `VACUUM (ANALYZE)`를sessions→messages→chunks→tool_notes 순서로각1회→post상태/행수불변/성공,GIN관측가능시pending0/0을확인→warmup+판정3/별도진단. schema는baseline원래39/current후보40. 프로토콜번호/정확명령·순서·준비완료기준이같아야비교하며protocol1결과와혼합금지. 준비·쓰기·ANALYZE유지·39→40migration진단은판정시간밖/별도소유DB,모든실패/정리보존. 관측불가stats/잠금은미관측으로명시하고성능임계.5/1.0은유지한다.

## Design Notes

T0은 상한 pruning의 정확성은 가능하나 고정1024byte에서 거의 pruning 못할 위험을 확인했다. 따라서 lower 공유/좁은정렬을 첫 구현으로 하고 실제측정 전까지 효과를 주장하지 않는다. 점수 length를 원문길이로 바꾸거나 regex/FTS로 의미를 바꾸지 않는다. 세션/메시지 조인은 순위에 필요한 시각/근접도를 남긴다. 목표미달은 원인분석과 안전한 재개발/리뷰 뒤 재측정하며 fixture/임계는 유지한다. 새index 미채택이면 추가쓰기비용 판단대상 없음.

## Verification

- 개발/리뷰수정중 `pnpm build`, `pnpm typecheck`, `git diff --check`만. 시험/eval/성능실행 금지. 22.4 측정창 heavy보류는 중앙 조기해제 통지(msg_f5f0441a6e8f)로 종료됐다.
- 최종 개발/필요후속 뒤 중앙명시만료창 내 같은runner의 `node tooling/query-perf/run.mjs common-search --checkout <baseline-or-current> --database-url <owned-perf-url> --out <local-result>` baseline→change 순차 및 `compare` 종료0. 원시/계획/동등성/무악화6조건 확인.
- 전용PG·role·HOME·venv·산출물, repo밖TMPDIR. hook은 소유Docker context/config·실제OrbStacksocket·Compose를 child환경에서 확인, DOCKER_HOST/전역context변경/원문인증복사 금지. 합성관리암호 fixture전제 확인.
- `VITEST_MAX_WORKERS=2 BRAIN_TEST_DATABASE_URL=<owned-test-url> pnpm test` → 같은환경 `pnpm test:python` 순차각1회, 명령/선정/종료/원시실패 보존. 실패수정 후 `pnpm test:changed -- d6a0b4b614daa1c321c735a2ca09aab27d78e193` 및 관련시험만 재검증. 전체회귀를 생략하지 않는다.
- migration/schema/릴리스불변, 비범위변경없음, 정확소유ID정리/부재, 워크트리/로컬branch/세션/실행증거보존 및 최종remote SHA/clean 확인.


### 2026-11-06 — R4 독립 4렌즈 triage

도착순 VG→IA→EC→BH, 총19행 high0/medium13/low1/false5. 후속pass high0이므로 전체4렌즈 반복 권고false. 교정 뒤 새 진단/역할/비교 계약을 Sol/medium 표적으로 독립 확인한다. deferred0, 실제 성능·회귀 수락은 아직 없다.

- VG1 [medium][patch] ledgerAfterHash 불일치 거부 시험 누락 — shifted 이후 한 필드만 변조하여 rawCompare 거부를 고정한다. T25.
- IA-A [false][reject] carried 후보수 감소/대안 비교 — T0 세 대안과 T12/T17/T20 실제 효과·실패 비교를 보존한다. 전체 후보수 감소라고 주장하지 않으며 결과 중심 계약을 유지한다.
- IA-B [false][reject] 최종 실측/시험 증거 없음 — 현 단계는 개발·리뷰이며 미통과를 명시하고 built 전이하지 않는다. 마지막 gate 필수다.
- IA-C [false][reject] carried ASCII 성능분포 한정 — 원문 고정 fixture의 수락범위이며 모든 Unicode 분포 성능을 주장하지 않는다.
- IA-D [false][reject] carried 기본 성능과 보조 잘림 분리 — 실제 PG/core 긴 보조 응답 및 Turkish/고정 순위·oracle 회귀를 별도로 검증한다. 계약/기대는 유지한다.
- IA-E [medium][patch] 통계 단독 인과 효과를 결합 비교로 단정할 수 없음 — 같은 current 제품 SQL을 upgrade 진단 DB의 39→40 전후에 별도 EXPLAIN하여 추정/실제행·계획을 보존한다. 이는 판정 표본이나 새 임계가 아니며 선택도 가설을 진단한다. T24.
- IA-F [false][reject] 운영·창·장기 비용 관찰 한계 — 지휘자 영수증/중앙 창과 별도 합성 비용 표본으로 확인하며 장기 운영비나 미관측 잠금은 주장하지 않는다. 한계는 최종 보고에 남긴다.
- EC1 [medium][patch] 진단 client/observer error 리스너 누락 — 오류를 수집하고 정리 후 실패로 전파한다. T23.
- EC2 [medium][patch] AggregateError에서 preparation/SQLSTATE 유실 — 중첩 오류와 단계별 준비 증거를 실패 partial에 보존한다. T23.
- BH1 [medium][patch] 제품 검색이 admin 연결 — fixture/migrate는 admin, 검색은 brain_app 자격을 사용하고 실제 역할·유효 설정을 기록한다. protocol2 최초 실행 전 고정하며 과거 protocol1 관리자 측정은 별도 보존한다. T24.
- BH2 [medium][patch] EC1과 같은 진단 소켓 오류 — 같은 수정/회귀로 닫는다. T23.
- BH3 [medium][patch] cost 완료 후 upgrade 실패 시 완료 진단 소실 — 단계별 partial과 표본/잠금·준비를 점진 저장한다. T23.
- BH4 [medium][patch] 빈 GIN inventory 수락 — 필수 이름/대상·중복 부재와 전후 inventory를 검증한다. T25.
- BH5 [medium][patch] autovac/reloptions 및 계획 설정 동등성 공백 — 실제 수집과 제한된 명시 목록 비교를 보강한다. 플래너 설정을 강제하지 않는다. T25.
- BH6 [low][reject] carried R3 BH2 wall 값/UTC 길이 손편집 불모순 검사 — 같은 호출의 단조시계와 UTC를 생성하며 원시 감사한다. 새 오차 규칙을 도입하지 않는다.
- BH7 [medium][patch] 비용 warmup/표본/ANALYZE 순서 검증 누락 — 준비 완료·실행 경계 내 전체 순차 구간을 확인한다. T25.
- BH8 [medium][patch] 통계 정의/분포의 내용 검증 부족 — 정확 name/table/owner/expression 및 고정 동일본문 fixture의 유효 분포를 검사한다. T25.
- BH9 [medium][patch] 진단 ledger applied_at 누락 — 기존39 이력의 적용 시각도 해시에 포함하고 변경 거부를 고정한다. T25.
- BH10 [medium][patch] 준비 pre snapshot 이전 실패 증거 누락 — support/pre 수집부터 단계·이미 수집한 값·SQLSTATE를 점진 보존한다. T23.

T23 전문 보고와 helper/러너의 오류·정리/부분 증거 및 회귀 소비 경로를 지휘자가 확인했다. build/typecheck/syntax/diff0, 시험/실측 미실행. EC1/2·BH2/3/10은 구현 반영, 후속 독립 확인은 T24/T25 뒤 수행한다.

T24 전문 보고와 실제 brain_app 로그인/설정·제품 EXPLAIN 및 upgrade 전후 같은 SQL/결과/정리 경로를 지휘자가 확인했다. build/typecheck/syntax/diff0, 시험/실측은 미실행이며 실제 인증·성능 효과를 아직 주장하지 않는다. BH1·IA-E 구현 반영, T25 뒤 독립 확인한다.

T25 전문 보고와 비교기/준비·설정·통계·이력 및 회귀를 지휘자가 확인했다. build/typecheck/syntax/diff0, 시험/실측은 미실행. R4 채택 교정을 독립 표적 확인에 넘기며 새 성능 수락이나 개발 완료를 아직 선언하지 않는다.


### 2026-11-06 — R4 교정 표적 확인과 후속

Sol/medium ctx_cc74be04ab5e 전문 r4-target-review.md를 읽었다. T23/T24/그 외 T25 계약에서 새 결함은 없었으나 F1 [medium][patch] 정상1024byte 분포 거부를 채택한다. PG18 analyze.c WIDTH_THRESHOLD1024는 detoast raw datum 크기(헤더 포함)를 비교하므로 payload1024는1028이고 모든 값이 toowide다. 정상 null_frac0/n_distinct-1/MCV NULL을 보존해야 한다. 지휘자도 PG18 공식 analyze.c/detoast.c 소스를 대조했다. T26으로 비교기·순수/실제DB 기대 및 README를 교정하고 같은 Sol의 후속 확인을 받는다. fixture/성능 임계·제품SQL/0040 불변, 통계 선택도 개선은 미입증이며 실제 before/after 계획으로 채택 판단한다. deferred0.

T26 전문 보고와 validStats 및 네 통계 지점·순수 변조 회귀/README를 지휘자가 확인했다. null_frac0/n_distinct-1/MCV NULL의 소스 기반 기대이며 실제 관측은 아직 없다. build/typecheck/syntax/diff0, 시험/실측 미실행. F1 후속 독립 확인에 넘긴다.

### 2026-11-06 — T26 후속 독립 확인 완료

Sol/medium ctx_0b6eec404b5b 전문 t26-target-review.md를 읽었다. F1 교정 반영·새finding0, fixture/제품/임계 불변을 확인했다. 개발·필요후속이 끝나 최종 준비로 전환한다. 실제 PG분포·계획·성능과 전체 TS→Python 회귀는 아직 남았고 통과로 주장하지 않는다.


### 2026-11-06 — T27 부분 준비와 T28 복구/22.5 통합

T27 build/typecheck/diff0·기준불변/전용PG 준비는 확인했으나 기존Python3.9 venv가고정환경이아니어서failed로보존했다. T28이실제확장설치경로를읽고소유HOME/PATH/uv cache에서Garmin3.14.10·pyfixture3.12.13고정interpreter와각확장 frozen lock설치/import를완료했다. 원래3.9venv/실패다운로드로그는보존하고최종회귀는 resources.json의t28RegressionEnvironment를사용한다. 제품시험은미실행이다.

수락22.5 main f1a2f22e1b6026aeeedec88ec310aefbdb947556을자기branch에fast-forward통합했다. 세공통파일명시stash/backup을보존하고양쪽scenario/문서를가산해충돌해결,원래baseline d6a0b4b614daa1c321c735a2ca09aab27d78e193불변. 검색SQL/0040/common-search모듈·신규시험해시불변,첨부UUID변경은검색의미에영향없음. 지휘자가전문보고/통합diff/영수증을읽었고통합build/typecheck/diff0이다. t28-build-receipt.json에기준39·현재40후보/runner지문을묶었다. 공통dispatch충돌표적확인뒤새protocol2창을요청한다. 중앙8.1의0041예약은조건부이며0040채택/철회변경전에중앙통지할의무를보존한다.

T28 통합 표적 Sol/medium ctx_ee58a961c505 전문 t28-integration-review.md를 읽었다. 새finding0,기존file-locations/첨부/스냅샷/cleanup·실패정제와common-search가산등록 및보호10파일해시불변확인. 개발·필요후속완료로새protocol2확정창을요청한다. 전체TS→Python은아직미실행이며최종gate로남긴다.


### 2026-11-06 — T29 protocol2 실패·0040 철회 판단

전문 t29-protocol2-performance.md와raw performance-t29.rbgckpm5의steps/base/current·계획을직접읽었다. base0/current0/compare1(invalid environment). PG16에서lc_collate/lc_ctype서버변수가제거되었으므로pg_settings의두행이없다. PG18pg_database datcollate/datctype를실제로수집해동등성을복원할필요가있고가드를삭제해서통과시키지않는다. 공식PG16release16와PG18catalog문서를대조했다.

원시wall비율 chunkcommon.4614/a.4578/missing1.2670,toolcommon.5173/a.5076/missing.6858. 비교기수락아닌독립산술이며두미달을보존한다. 모든6조건result/store/oracle/fixed및aux전체hash동일. 양쪽pending0/0,동일준비후missing계획은index31hit/actual0으로이전pending차이제거;남은ms급wall악화원인은미확정이다. toolcommon은filter약423ms+message100000indexlookup약165ms+score/session약203ms이고전체385ksharedhits로여전히미달.

0040은철회한다. 같은currentSQLの39→40前後추정32/실제100000행·계획불변,실행chunk664.321→663.713/tool890.349→897.117ms로선택도개선없음. 실제wide분포0/-1/NULL,정의각476/data154논리byte. ANALYZE중앙값388.764→910.145ms,upgrade910.085ms·ShareUpdateExclusiveLock관측. 유효성/정의존재만으로채택할이유없고명확한유지비가있다. 중앙질문 msg_4ba4c46f3b86에파일/번호/schema변경전에철회확정근거를회신했다(영수증t29-statistics-withdrawal-notice.json). 원시/후보SQL/과정은로컬보존,기존39바이트불변,8.1번호는중앙이확정한다. 제품검색최적화는독립계속하며시험/실측자동반복없음,개발중컴파일만. 최종전체TS→Pythongate미실행/필수유지.

중앙 msg_de4d94c5a50e가T29원문을읽고미출하식통계0040철회를수락·번호를8.1 Drive용0040으로이관했다. T31에서자기후보/현재40기대만제거해수락main기준39로복원,과거1~39/역사기대불변·가짜downgrade금지·원시/후보SQL백업보존·마지막수정독립확인/compile를수행한다. 향후수락main의8.1실제0040과철회후보를구별하고새migration은중앙재조율한다.

T30 전문보고/locale수집·필수검증/회귀를읽었다. PG18실제앱카탈로그datcollate/datctype를같은baseline/current/upgrade경로에수집하며기존설정누락을가드삭제로숨기지않았다. build/typecheck/syntax/diff0,시험미실행. 정적3후보중InitPlan gate1회평가가가장작은변경이며T31철회후별도제품Task에서채택여부를결정한다.

T31 보고/복원diff·runner/비교/시험변경을읽었다. 후보SQL/전용시험/철회前러너는withdrawn-expression-statistics/receipt.json에보존,0001~0039/현재schema기대는수락HEAD39복원,제품recall해시불변. 후보upgrade기능을제거하고생존cost/소켓/부분증거계약을회귀로유지했다. build/typecheck/syntax/diff0·시험미실행. T32는정적3대안중최소구조변경인불변gate1회평가만채택하며성능효과는미입증이다.

T32 전문보고와실제제품diff/회귀를읽었다. 환경boolean만외부참조없는단일row scalarSELECT로옮기고행별ASCII판정/기본fallback·全순위/조인/LIKE/LIMIT불변,직접동등성및실제Turkishstoreoracle회귀보강. build/typecheck/diff0,시험·계획·성능미실행. T30~32결합표적Sol확인에넘긴다.

### 2026-11-06 — T30~32 독립 후속 완료

Sol/medium ctx_001bff9ae239 전문 t32-target-review.md를 읽었다. locale실제카탈로그/필수동등성·후보백업8개SHA/기존migration39불변·생존cost실패·scalar분기/순위동등성을확인,새finding0. 개발완료검증으로전환하며새빌드영수증·승인실측·최종TS→Python은미실행이다.


### 2026-11-06 — T34 미수락과 비교기 교정

t34-performance.md 전문과준비소스를읽었다. base/current0·compare1(invalid protocol2). PROCEDURE.ready문자열을준비출력p.ready booleantrue와동시에동일하다고요구해정상수락불가능한모순이다. T35에서준비완료기준명(readinessCriterion)과관측ready boolean을분리하고실제runner형태 정상수락/각각변조거부회귀를보강한다. 이는기준완화가아닌동일정책의필드구분이며T34raw는변조/소급수락하지않는다.

T34원시비율 chunkcommon.4521/a.4458/missing.6627,toolscommon.5189/a.4767/missing1.1877. 全6hash와aux동일/GINpending0·locale카탈로그동일·schema39/후보통계없음,정확4DB삭제/잔여0. InitPlan common/a는Result1행1회,missing은0회로gate의평가축소는관측했으나잔여toolscommon/도구missing미달이유지됐다. toolsmessage10만indexlookup은여전히남는다. 최종회귀는아직미실행이며다음개발도컴파일만. 원시/실패전부보존·추가계측자동반복없음.


### 2026-11-06 — T35 교정과 T36 구조 선택

T35전문보고/실제ready정책필드·독립정상fixture와회귀를읽었다. readinessCriterion문자열/readyboolean분리·동일의미가드·main/cost정리보존,build/typecheck/syntax/diff0·시험미실행. 다음독립확인에서실제정상수락제어흐름도대조한다.

T32의InitPlan은실제1회로관측됐으나toolscommon미달은.5189로남았다. 따라서query별휴리스틱이아닌실제후보수로작은indexed-message lookup과대량batch結合을분기하는SQL구조를T36에서구현한다. 좁은matched CTE에全候補ID/메시지복합키/점수만두고,한statement에서후보수>256일때만narrow message관계를materialize하여반복인덱스10만lookup을줄인다. 후보256이하는既存indexed LEFT JOIN으로,0이면messages全scan을피한다. 양쪽分岐는동일行/시각/ID를만들고원래近接/점수/時刻/UUIDの全體순위뒤최종原文을복원한다. 메모리/spill·planning/missing·parallel손실위험은실제검증전미입증이다. 새index/schema/GUC강제/후보누락·fixture특화는없다. 원형oracle와閾値양쪽경계·raw/NULL회귀를보존하고새SQL은독립검토후에만실측한다.

T36 전문보고/SQL과 경계 회귀를 읽었다. 실제후보0/1/255/256/257/300·복합raw/NULL/동일text다른session·전수oracle/고정선두·상세행을 작성했고 build/typecheck/diff0, 시험/실측 미실행. 256은 지휘자의 구현 선택 경계이며 티켓 수락조건의 수치가 아니다. T35 정상수락 계약과 T36 SQL을 독립4렌즈 R5에 넘긴다.

### 2026-11-06 — R5 독립4렌즈 판정

네 전문 r5-blind-hunter/edge-case-hunter/verification-gap/intent-alignment.md를 모두 읽고 소스와 대조했다. edge 0건, blind10건, VG1건, 의도4해석이다. High0, 필수수락조건/검증을 defer하지 않는다.

|ID|판정|근거와 처분|
|---|---|---|
|BH1|성능 위험, 코드 결함 주장은 불채택|전체 messages 좁은 materialization은 반복 index lookup을 없애기 위한 의도한 대안이다. 결과 누락/오순위 근거 없고 후보 키 semijoin은 다시 lookup 비용을 만들 수 있다. 실제 scan/메모리/spill·missing 비용을 승인된 다음 계획/실측에서 확인한다. 무제한 모든 분포 성능 보장이 아닌 고정6조건 수락이다. 성능 통과 주장 없음.|
|BH2|분기 구현 mirror 시험 불채택; 비일치자료 회귀 채택|양분기 결과가 같다는 것이 계약이며 SQL 문자열/256 상수 단언은 구현을 복제한다. 정적 matched count 근거와 승인 실측 실제 plan으로 전략을 관찰한다. 많은 비일치 note가 있어도 정확 결과 보존 회귀는 T38에 추가한다.|
|BH3|Low 채택 T38|대량 분기의 비ASCII 점수 경쟁·역순시각을 독립 oracle/고정기대로 보강한다.|
|BH4|Low 채택 T38|대량 분기에 proximity2의 고득점/최신행을 넣어 세단계 순위를 고정한다.|
|BH5|Low 채택 T38|재조회된 공개 상세행 전체와 서로 다른 session metadata 기대를 비교한다.|
|BH6|Medium 채택 T37|runner 준비 ready에 pre/post table options/settings 안정성도 필요하며 비교기와 같은 정책으로 조기 거부한다.|
|BH7|Medium 채택 T37|선언한 fixture.rows와 main/cost 준비·ANALYZE count를 연결해 모순 증거를 거부한다.|
|BH8|Medium 채택 T37|UTC/timeout0 정책과 실제 main/cost/app 관측 설정을 연결, 독립 정상 fixture를 실제 값으로 고친다.|
|BH9|Medium 채택 T37|pending 미지원 SQLSTATE를 runner의 정확 허용 목록과 대조해 연결 오류 위장을 거부한다.|
|BH10|Low 채택 T37|네 준비 위치 모두 supported:true/pending0 정상 수락과 한 값 변조 거부를 작성한다.|
|VG1|Medium 채택 T37|pending 거부 mock의 GIN 목록도 무효여서 조건 제거를 검출하지 못한다. 정상 inventory 고정 후 pages/tuples 각각만 양수로 분리하고 preserved ready:false를 단언한다.|
|IA1~4|설명적 해석, 기존 결과중심 채택 유지|후보 제한/조기 종료 대안은 T0에서 비교했고 정확 상위순위 보장이 약한 임의 제한은 채택하지 않았다. 점수 단가/메시지 결합 비용 감소 전략이며 전체 후보 점수 횟수 감소를 주장하지 않는다. 고정6조건 성능과 별도 출력 계약 검증·기존 시험 통과가 여전히 필수다.|

수정 가능한 측정/회귀 공백은 T37/T38에 나눠 같은 단일Terra가 수행한다. 개발중 시험/eval/DB실험/실측 금지·compile만, 이후 Sol 표적 독립 확인과 새 빌드 영수증/승인창 실제 성능 및 최종전체TS→Python 순차각1회가 남는다. deferred는 비어 있다.

T37 전문과실제준비/비교소스를읽었다. BH6~10/VG1 설정·count·pending 증거/정상control/단일변조거부를보강했고build/typecheck/syntax/diff0,시험/실측미실행이다. T38 제품결과회귀뒤 묶어서Sol표적확인한다.

T38 전문보고와전체추가시험을읽었다. 비일치300개+matched256/257·비ASCII가나반복점수/역시각·3근접단계·세션별전체공개상세행기대와원형oracle를보강했다. 제품SQL/runner불변,build/typecheck/diff0·시험미실행이다. T35~38최종계약을Sol표적후속에넘긴다.

R5 표적후속 전문을읽었다. F1 Medium 채택: appSettings 공유참조로work_mem단일변조거부가무효화되고UTC/timeout변조가뒤supported정상fixture를오염시킨다. 새Terra T39에서행까지독립복제·공유mutable입력점검·의미있는독립성회귀후Sol재확인한다. T35~38제품/증거계약의다른새finding은없었다. 시험/실측미실행상태유지.

T39 전문보고와실제설정깊은복제/role새객체/targets새배열및양순서독립성시험을읽었다. build/typecheck/diff0·시험/실측미실행. F1표적독립재확인뒤최종검증준비로간다.

Sol ctx_fb2350d44614 T39표적전문을읽었다. F1공유원인해소/양순서정상·거부격리·새finding0. 개발/필요후속완료경계로전환하여T40빌드영수증을갱신하고승인된6조건한쌍및최종TS→Python을진행한다. 현재실측/회귀통과주장은없다.

### 2026-11-06 — T40 소유권 복구 승인 대기

T40보고/컴파일0영수증은보존했으나worker_done과escalation이worker_identity_changed로거부됐다. 중앙 msg_a84b90944967의공식대조결과 pane/session leaf불일치·stale terminal·projection unverifiable이나observation live/exactWorker=true/addressable=false라정확물리종료증거없음이다. 중앙이해당Dispatch ctx_8cbf20dce77e만fence하고세션/자원보존하는사용자승인을요청한다. 승인전stop/abandon/retry/release/새편집자금지,Task미정산·물리종료주장금지. 현재계획in-review/성능미수락/전체회귀미실행유지. 8.1수락main d5f4896의실제Drive0040/schema40은원본baseline39와구별하며안전한소유권경계복구뒤정상통합·provenance수정·독립영향확인한다. 현원시/후보철회백업/전용PG/세션/워크트리모두보존한다.

### 2026-11-08 — T40 같은Task 정산 완료·Drive통합 재개
사용자/중앙 msg_572ae1c03f02 승인과최신exact-exited대조후옛배정만abandon/processActionnone·자원보존. 같은task_62b399d670ef의새ctx_93765d47a8eb가읽기전용정산성공했다. t40-recovery-settlement.md전문을읽었고2026-11-06당시로그3SHA/HEAD/기록exit일치확인,현재환경·실측·전체회귀통과로취급하지않는다. T41수락d5f4896실제Drive40통합→T42원본baseline39/current40 provenance검증→독립확인/새검증으로이어간다.

T41보고와통합영수증을읽었다. 자기branch가수락d5f4896으로fast-forward,충돌없음·backup과기존dirty코드·원본migration39바이트/검색SQL해시보존,Drive0040/CORE40반영·compile0. T42는원본39/current실제Drive40의엄격고정manifest/API/to검증으로provenance만수정하며식통계후보40을허용하지않는다. 원본archive/실패/전체회귀미실행불변.

T42전문보고/고정schemahelper/maincost검증연결을읽었다. baseline39고정파일/SHA와수락Drive40추가SHA·실제checkout모든SQL/API/to를대조하고비교기side39/40을분리,식통계부재검사유지. build/typecheck/syntax/diff0·시험/실측미실행. T41통합·T42계약을독립Sol표적확인에넘긴다.

Sol T41/T42 표적전문을읽었다. 원본39파일/수락Drive40지문·보호/철회백업·정상39→40및변조거부제어흐름독립확인,새finding0. Orca재시작후실제T42구현/리뷰succeeded/exited/released와T43미시작을대조했고완료작업재실행없이T43새준비영수증부터재개한다. 개발/필요후속완료,성능미수락/전체TS→Python미실행은유지한다.

### 2026-11-08 — 임시환경/과거 원시 손실과 새 복원
T43전문을읽었다. 현재compile0/artifact·runner지문·Git39+Drive40/후보백업8은확인했으나 /private/tmp/brain223-prep.DupxZd와과거원시6경로모두부재라Taskfailed다. 옛archive/venv/context/URL·PG현재상태는확인불가,삭제원인은미확정이다. 중앙 msg_897922c76b1b 감사에도과거raw/checkpointarchive사본없고남은창요약/worker-read/ps는원시표본대체가아니다. 중앙은현재checkout의.brain-automation전체를surviving-evidence-after-temp-loss에퇴피했다. 기존보고/receipt/누적실패요약/철회후보백업과증거손실범위를유지하며과거raw를재생성해동일증거로주장하지않는다.
중앙승인으로T44에서원본Git39archive/독립build·자기PG/Dockercontext/URL/HOME를새ID/시각/지문으로복원하고T45Python고정환경을별도준비한다. 새증거/원시는repo gitignored영역에도보존한다. 과거실패재현만위한재계측반복없음,새현재한쌍은독립확인뒤별도명시창필요. 최종전체TS→Python각1회는아직미실행/필수이며새성공으로과거원시손실을덮지않고최종보고의독립감사항목으로남긴다.

T44중OrbStacksocket부재/서버연결실패는중앙에운영경계질문했고중앙 msg_c31d66422d8c가사용자명시승인orb start/Running·Docker29.8.2확인후자기전용복원재개를확정했다. 구현자가기존정확PG두ID/라벨/이미지일치·exited를확인했으므로그두개만정상start/readiness를승인했다. 타소유/운영설정·데이터변경/잔존DB임의삭제금지,새context/복원시각과기존ID재사용을구별한다. 이전tmp/raw손실기록불변.

T44전문과새resources/영수증을읽었다. recovered-f04cc4507d29새archive/독립baselinebuild지문이과거기록과일치하나과거raw復元아님. 기존소유PG정확두ID재사용/현재PG18.6·loopback32768/32769·ready/qpDB0/타client0·새context/실제socket/Compose준비확인. 제품/runner/revision은T43같고전체source는지휘자계획기록후달라져새파일별SHA로보존. T45고정Python설치후독립준비감사·새명시창/전체회귀는남았다.

中央 msg_cce6fd1f0d29 수락8.2 main9004c35/core41·실제0041sources통지를수신했다. 현재T45복원명령기준을유지해끝낸뒤정상통합하고원본baseline39불변/current실제41의고정migrationprovenance만의미별갱신·필요독립확인한다. 중앙대조상chunk/tool prefix와common-searchrunner는8.2부모대비불변이며실제Git통합영향을다시대조한다. 8.3OAuth/config/disconnect/19.5문서정제는별도소유,성능창중앙조율/일반개발회귀독립유지. 과거raw손실과새환경증거구별불변.

T45 전문과 frozen 설치 영수증을 읽었다. Garmin3.14.10/pyfixture3.12.13 제한PATH pin탐색·입력3파일 바이트일치·frozen설치/import0, 시험실행아님. 실제 T45 settled/exited 확인후 T46에서 수락8.2 정상통합 및 baseline39/current41 고정provenance와 의미별 회귀를 작성한다. 과거raw손실·새환경 구별과 성능미수락/전체회귀미실행은 유지한다.

T46 전문·backup기준 schema/비교기/회귀 diff를 읽었다. 수락9004c35로정상FF·recall만scopedstash보존/자동병합,검색본문바이트보존·문서/source수락본문보존. baseline39/Drive40/sources41고정Git SHA와 main/cost 실제API/to 검증·현재side41/역사current39·40거부 작성,compile/syntax/diff0·시험/실측미실행. Sol에 통합·정상/거부 제어흐름 및 새복원/과거손실 경계 감사를 요청한다.

Sol T46 감사전문을읽었다. 통합/strict39→41와새복원바이트·로그독립대조에서제품/runner결함0. Low F1채택: README145의당시T29raw현재보존문구는손실사실과모순이라T47에서교정한다. 과거판단수치/후보백업·보고잔존은보존하고원시손실/원인미확정/새복원과구별. T47은최신입력/환경준비영수증을작성하며문서만변경이면T46컴파일로그를연결하고중복build안함. 새실측은중앙명시창까지보류·최종전체회귀미실행유지.

### 2026-11-08 — T46~49 최종준비와 새실측 실패
T46/47독립전문·T48보고한문장역변환일치를확인해README과거raw손실안내F1/T47docker형제경로F2를해결했다. T47제품/runner/전체source·로그지문독립대조일치. scratch별칭은기존T44worker세션170f3b1639050086238af630d8e66e7a의소유root로고정해새T49worker의다른env경로와구별했다. 중앙19.5docs cb521429는제품영향없고현재고정환경유지,새slot실행기미적용. 중앙보고주소는수신msg_330fa43f3436에따라run_eeb956b860e8로전환,ownRun불변.
T49승인창03:52:54~04:02:54UTC에서baseline39→current41같은runner한쌍종료0/0/compare1·정리0;창즉시반환/중앙해제확인. 새raw는recovered-f04cc4507d29/future-performance/t49-20261108T035441449310Z에완결보존,과거raw복구아님. 동등성·strictmanifest·실제brain_app/locale/protocol2/보조계약통과이나비율chunkscommon.4550/a.4530/missing1.0396,toolscommon.4574/a1.2726/missing1.0664로세조건미달. toolsa는기준병렬2worker대비변경matched/batchCTE비병렬+temp2146blocks를관측,missing은~1ms라계획/실행/부하를분리해가설로분석한다. 자동재실측/기준완화없음. T50정적잔여분석후최소교정판단·독립확인·새중앙창·최종전체TS→Python각1회는여전히필수미실행이다.

T50전문/raw독립검산을읽었다. toolsa비병렬matched631ms/전체724ms·spill2146blocks대비기준GatherMerge2worker574ms관측에따라일반정제query1~2코드포인트만원형단일join전략T51을채택한다. 긴querybatchcommon효과보존·빈query불변·동등점수/순위/상세계약유지·효과가설. missing두wall차이~.038/.078ms와planning증가관측은미해결이며잡음수락/threshold완화/성공으로처분하지않는다. T51회귀작성/compile뒤Sol표적확인·별도새실측창필요.

T51전문/전체diff와Sol리뷰를읽었다. 제품결함0이나가나2자회귀가단일경로로이동한Medium F1채택, T52에서가나유지+가나다3자256/257·비일치300·고정공개행/oracle를복원했다. 호출고정비용제안도채택해tools미사용chunkfragment를지연생성하고tools만3코드포인트에서판정중단,SQL/파라미터는불변. T52build/typecheck/diff0·시험미실행. Sol후속전문에서F1해결/새finding0·바이트/로그/runner일치확인. 현재artifact02827ae7/runneraeb90f5c,효과와missing해결은미확정. T53새준비영수증후중앙새명시창6조건한쌍으로실측,자동반복금지·최종전체TS→Python각1회미실행필수gate유지.

### 2026-11-08 — T53~T57 최종 성능 결과와 실패 이력

T53 중앙 승인 `msg_bae6734d5de1` 창에서 동일 runner의 baseline39→current41을 순차 측정했다. baseline/current/compare exit 0/0/1, 결과 동등은 통과했지만 chunks/missing 1.01450·tools/missing 1.32720으로 실패했다. T54는 같은 정제 패턴의 실제 존재 확인으로 빈 결과를 처리하고 양성은 최종 조회 snapshot을 사용한다. Sol 표적 리뷰 `.brain-automation/reports/t54-target-review.md`는 정적 새 finding 0이며 그 자체가 실행 통과는 아니다. T53 raw와 명령·로그 SHA는 `.brain-automation/tickets/22.3/recovered-f04cc4507d29/future-performance/t53-20261108T041845513703Z/` 및 `.brain-automation/reports/t53-performance.md`에 있다.

T55 승인 `msg_7243b455a694` 한 쌍은 baseline/current/compare 0/0/1로 실패했다. 두 missing probe의 Limit→Seq Scan은 각 10만 행을 조사했고 chunks 506.56662배·tools 631.81796배였다. 네 양성 통과는 전체 실패를 바꾸지 않는다. `.brain-automation/tickets/22.3/recovered-f04cc4507d29/future-performance/t55-20261108T043914Z/`, `.brain-automation/reports/t55-performance.md`에 원시 결과와 SHA를 보존한다. T56은 내부 LIMIT 없는 MATERIALIZED CTE와 외부 LIMIT로 계획을 수정했고 PG18 공식 소스·문서 대조의 독립 표적 리뷰 `.brain-automation/reports/t56-target-review.md`는 새 finding 0이다. 정적 계획 가설 자체가 실제 인덱스 선택 보장은 아니다.

T57 승인 `msg_c2beb7b4ef5a` 창의 원본 baseline39/current 실제41 동일 runner 한 쌍은 baseline/current/compare 0/0/0, 여섯 비율은 순서대로 chunks common/a/missing **0.45314079 / 0.46319883 / 0.88510474**, tools common/a/missing **0.44164241 / 0.46677553 / 0.81751429**로 지정 임계를 충족했다. 10만×1024, warmup1+3, protocol2 동일 준비, 독립 전수 oracle·고정순서·전체 hash 및 가림/잘림/has_more/omitted/next/metadata 보조 검증, migration39/41 provenance, 실제 `brain_app`·locale, SQL span/EXPLAIN과 별도 쓰기·ANALYZE 비용, 네 DB 삭제 및 잔여 client/DB 확인을 기록했다. raw `.brain-automation/tickets/22.3/recovered-f04cc4507d29/future-performance/t57-20261108T045926Z/`, 보고 `.brain-automation/reports/t57-performance.md`; base/current/compare/commands SHA는 각각 `25025394cf012551c1975e2788d36ddd041e4cb0e7ca5827df380a7c87e4ad1b`, `950a1d4f48975d8ba6645fbf84b13f0358de9e7cf3d77e92b28b1c8af85f865b`, `e5f50a378ec31a337303053631687181acf323edebe0b48e0e23518cb407a72d`, `843a3e40c6f86c3348c85e9920370e0e19884ecc35f3eb207e86a0d544722918`다. 현재 제품 artifact `07b3eedc41aad43d53c5ca73fe8b3cbac2a79fb225e014f84534079d79813662`, runner `aeb90f5c40815ee81f9da5c25ca39be1580f3772d3b823e3db6aa174db6c548d`에 한정된 단일 쌍이다.

T10의 첫 baseline 오류 및 T12/T17/T20/T29/T34와 T49/T53/T55의 실패·미수락은 앞선 이력대로 유지한다. 철회된 미출하 식통계 후보 0040은 수락된 실제 Drive 0040 및 sources 0041과 다르다. T10/T12/T17/T20/T29/T34의 과거 raw 여섯 경로는 손실됐고 원인은 미확정이므로 독립 재감사에 한계가 있다. 새 raw는 이전 raw 복구가 아니다. load/process 기록만으로 호스트 간섭 부재를 증명하지 않으며 이 최적화는 전체 후보 점수 계산 횟수 감소나 모든 데이터 분포에서의 성능을 보장한다고 주장하지 않는다.

### 2026-11-08 — T58~T63 최초 전체 실패와 관련 재검증

T58은 `VITEST_MAX_WORKERS=2`로 `pnpm test` → `pnpm test:python`을 순차 각 1회 **실행**했고 둘 다 exit 1이다. TS는 4742통과·12실패·1 skip, Python 설정은 59통과·10실패였다. 원문 `.brain-automation/tickets/22.3/recovered-f04cc4507d29/final-regression/t58-20261108T051900Z/`, 명령·로그 SHA와 자원 영수증 `.brain-automation/tickets/22.3/t58-regression-receipt.json`, 분류 `.brain-automation/reports/t59-regression-triage.md`를 보존한다. 이것을 미실행이나 전체 통과로 소급하지 않는다.

T59는 검색 관련 실패를 금지된 tool note 삭제, 일반 단어 `secret`과 artifact 경로 충돌, 불변 session tag 수정, offset 입력의 사전 정규화로 분류했다. T60은 해당 세 시험 파일만 가림 update·고유 합성 비밀/URL 및 masking 단언·적법한 ended_at·raw offset 입력으로 교정했고 Sol 표적 리뷰 `.brain-automation/reports/t60-target-review.md`의 새 finding 0이다. T61 지정 postgres 7개와 query-perf 66개는 실제 선택되어 모두 통과했으며 앞서 도달하지 못한 snapshot interposition/CONFIG/SEARCH_FAILED 및 masking·chronology 단언이 속한 시험도 완료됐다. 로그·SHA `.brain-automation/tickets/22.3/t61-receipt.json` 및 `recovered-f04cc4507d29/related-regression/t61-20261108T053340Z/`; 생성 fixture 14개 제거·부재를 확인했다.

T58의 훅 TS 7개와 Python 8개 실패는 최초 `ORBSTACK_UNAVAILABLE` 뒤 연쇄 가능성을 포함했다. T61에서 격리 HOME의 실제 `orb status`는 Stopped였고 사용자 HOME은 Running이었다. T62는 소유 Docker config에 실제 endpoint의 `orbstack` 별칭을 만들었으나 status 표식 단일 링크만으로는 Stopped가 유지됐다. 자동 승인 심사는 실제 상태 디렉터리 링크 교체를 접근 범위 확대 위험으로 거절했고 해당 동작은 실행·재시도하지 않았다. T58 생성 추적 pyc는 백업 SHA `cecef93966bbba1d5be9e0eb30a5a8742b4580b382eb9280dc8276dbeda8e60d`를 보존한 뒤 HEAD SHA `5b22cb946c865d5b412cc85dddb742d345f234b48fd8f421c4a9641b6ebc9ce2`만 복원했다. `.brain-automation/reports/t62-hook-environment.md`, `.brain-automation/tickets/22.3/t62-receipt.json`.

중앙 `msg_e63bdccd242b`가 8.1 선례의 더 좁은 status 전용 위임을 허용했다. T63 소유 wrapper는 정확히 `status` 하나만 실제 사용자 HOME의 `/usr/local/bin/orb status`에 exec하며 stdout/stderr/exit를 그대로 전달한다. 실제 CLI와 wrapper는 둘 다 Running/exit0, 금지·누락·추가 인자는 exit2였다. 이는 상수 응답이나 제품 probe 변경이 아닌 시험 환경 증거다. harness `which`→allowed-tools 링크, Node 복사 및 pnpm의 원래 PATH 복원을 대조했고 축소 재현에서도 같은 wrapper가 선택됐다. 소유 context/실제 엔진·Compose를 확인한 뒤 관련 TS hook은 7통과·1 skip, Python 설정 hook은 offline 사례 포함 8통과였다. 두 fixture container는 제거·재조회 부재, volume 목록 전후 일치다. `.brain-automation/reports/t63-hook-related.md`, `.brain-automation/tickets/22.3/t63-receipt.json`, `recovered-f04cc4507d29/related-regression/t63-20261108T054213Z/`에 전체 로그·SHA가 있다. 정상 TS skip은 Python 설정의 offline 통과로 실행됐다. T61/T63 전후 제품 artifact와 runner는 T57과 같고 source 바이트는 해당 실행 전후 불변이다.

T58 Python의 Garmin 두 실패는 중앙 `msg_89d4bce431d1`에 따라 19.11의 별도 소유이며 현재 checkout에서는 미해결이다. 수락된 수정의 통합과 정확한 관련 재검증, 실패 뒤 도달하지 못한 lifecycle 단언 확인이 필요하다. 중복 수정하거나 이 기록으로 해결을 선언하지 않는다. 최초 전체 실패 이후 AGENTS 기준 기본 `origin/main` 대비 `pnpm test:changed` 및 필요한 관련 재검증, 독립 최종 증거·환경·raw 손실 감사, 정확한 소유 자원 정리/부재, 범위 커밋·브랜치 push·원격 SHA 확인과 중앙 최종 보고도 남는다. T4는 미완료, status는 `in-review`, `deferred: []`이며 필수 미완료를 보류 항목으로 바꾸지 않는다.

이전 쌍 중 T20은 baseline/current/compare 0/0/1, chunks/missing 2.3213·tools/common 0.5240·tools/missing 1.4655로 미달했다(`.brain-automation/reports/t20-performance.md`). T29는 compare 1의 환경 검증 실패와 독립 산술상 chunks/missing 1.2670·tools/common 0.5173 미달을 함께 보존하며, T34는 protocol2 비교기 모순으로 미수락이고 별도 산술상 tools/common 0.5189·tools/missing 1.1877도 미달이었다. 이 수치들은 소실된 원시 자료를 독립 검산한 결과가 아니라 생존 보고의 이력이다.

### 2026-11-08 — T65~68 최종 감사·schema42 통합 영향 검증
T65 독립 증거 감사는 실제 T57 표본·계획·SQL span/원시 SHA·T58 최초 전체 실패·T61 검색73/T63 hook 관련 통과·실제 status 전용 위임과 과거 raw6 손실 한계를 대조해 새 finding0이었다. T66에서 기존 13개 파일 통합 전 checkpoint와 공개 후보 manifest/최종 보고 초안·정확 소유 정리 계획을 보존했다. 중앙 msg_532cf672d7da 기준 Garmin19.11은 아직 수락 전이며 중복 수정하지 않는다.
중앙 msg_2f0bba3ed389의 수락 부분 main f1185a89db0d173200c953edfdb1ac80d6829322를 T67에서 자기 브랜치에 정상 fast-forward했다. incoming80경로/기존13경로 교집합0·충돌/stash추가없음, 기존 stash/파일 checkpoint 보존. 실제0042_drive_connection.sql SHA 1ed2dca551de313f02e636568186d245618a48880300147f42ad5da9a2ffb57d와 CORE42를 반영했고 0001~41 바이트는 불변이다. provenance 다섯 파일만 의미별 갱신하여 baseline39/current42 및 main/cost API/to/전체 고정 manifest를 엄격히 요구하며 역사39/40/41과 미래43/변조/철회 식통계 거부를 보존했다. build/typecheck/구문/diff0, 독립 Sol T67 리뷰 새 finding0이다.
현재 전역 artifact587678c2502a66212ffc0dfdb408ae7c761c60b9595f38755b80e8e2290292e0와 runner0095dd76f48617e2dee8fd4156b74a23ed2e49dd91a3b932102c595f42997b02는 수락 비검색 코드/실제42 migration/고정 provenance 변경으로 T57과 다르다. 검색 SQL·점수·core/store 검색·fixture/oracle/준비/판정 의미는 바이트 동일하며 Drive barrier는 해당 동작 호출 때만 pool/lock을 연다는 독립 대조로 T57 증거를 그 검색 범위에 한정해 전승한다. CLI 초기화 전체 지연·호스트 효과·모든 분포 보장은 아니다. T57 raw는 당시 current41로 불변 보존하며42 실측으로 재표기하지 않았다.
T68은 schema42에서 worker2로 query-perf66/postgres7/core11/CLI4, 총7파일88시험을 네 그룹 순차 각1회 실행해 모두 exit0/skip0이었다. 실제39→42 DB/manifest 거부·Unicode/순위/raw/snapshot·가림/예산/metadata와 CLI 경로를 확인했고 소스13/pyc/artifact/runner/lock 전후 동일, 생성fixture15개는 제거 및 각ID부재 확인했다. 보고/영수증은 .brain-automation/reports/t68-schema42-related.md 및 tickets/22.3/t68-receipt.json이다. 최초 T58 전체 suite 두 exit1과 누적 성능 실패/과거 raw6 손실·원인 미확정은 그대로 보존한다.
남은 필수 항목은 중앙19.11 수락 커밋 정상 통합 및 Garmin 관련 재검증, 기본 origin/main changed 결과, 최종 영향/증거 대조·정확 소유 자원 정리·commit/자기 branch push/원격SHA 확인과 중앙 최종보고다. 현재 in-review/T4미완료/deferred[] 유지, 이미 통과한 성능/전체 suite를 이 통합만으로 반복하지 않는다.

### 2026-11-08 — T69~T75 수락 통합과 실패별 처분
T69는 중앙 수락 19.11 source `77180866dbdad7f37b93f70a7267a8ce6f6b7aba`를 포함하는 main `7c72cbfaf8860d0703595d134b760e87fa563817`으로 정상 fast-forward했고 core/native 두 시험 외 제품 검색 경로는 변경하지 않았다. Sol 독립 통합 리뷰 새 finding 0이다. T70은 로컬 기본 ref 변경을 발견한 사전 확인 실패로 시험을 실행하지 않았고, 중앙이 문서만 바뀐 `fd4532f415e08da0ffbbb33822c04dd401fd49f7`를 승인한 뒤 T71이 기본 ref를 사용했다.

T58 최초 full TS `pnpm test`는 4742통과·12실패·1skip, 이어 Python `pnpm test:python`은 59통과·10실패, 두 명령 모두 exit1이며 각 한 번 실행했다. TS 검색 5실패의 네 시험 설정 원인(금지된 tool note 삭제, 합성 비밀과 경로 문자열 충돌 2건, 불변 session tag 수정, offset 정규화)은 T60 교정 후 T61 postgres 7/query-perf 66 통과 및 T68 schema42 관련 88통과로 재검증했다. TS hook 7실패와 Python hook 8실패는 최초 OrbStack 상태 실패와 연쇄 가능성을 구별하여 T63 실제 status 한정 wrapper 환경에서 TS hook 7통과·1skip, Python hook 8통과로 재검증했다. T58 Garmin core의 database/exit 2실패 및 그 뒤 미도달 lifecycle은 수락 19.11 통합 후 T71 core 6·native 4 통과로 관련 시험 함수 전체가 완료됐고 T74 PythonAll에서도 포함됐다. 개별 assertion 계측을 한 것은 아니다. 최초 full 두 suite가 나중에 전체 통과한 것은 아니다. 상세 원문은 `.brain-automation/reports/t59-regression-triage.md`, `t61-receipt.json`, `t63-receipt.json`, `t68-receipt.json`, `t71-receipt.json`, `t74-receipt.json`에 있다.

T71 기본 `pnpm test:changed`는 TS 120파일 중 119통과·1실패, 2390통과·1실패·1skip으로 exit1해 PythonAll 전에 중단됐다. 실패한 role/settings 시험의 app-client/app-pool `terminating connection due to administrator command` 원문과 당시 실제 소켓 interleaving 미관측은 보존한다. T72는 app client 종료를 DROP 전에 기다리도록 수정했고 독립 리뷰 P2는 정상 종료 회귀의 결정적 순서 증명 공백이었다. T73 gate 보강 뒤 독립 후속 리뷰가 정적 해소·새 finding 0으로 판단했다. T74에서 해당 TS 파일 기존 13개와 정상/timeout 2개, 총 15개가 exit0·skip0으로 통과했고 기존 role/settings 시험도 재검증됐다. T71에서 미도달한 PythonAll은 직접 config로 16파일 73개 exit0·skip0으로 통과했다. Garmin core/native 10 및 artifacts 10이 이 범위에 포함되며 별도 중복 실행하지 않았다. 이 결과는 T71 changed 명령 자체의 실패를 소급해 성공으로 바꾸지 않는다. 기존 artifacts 최초 실패의 원인은 미확정이며 새 실패 면제 근거가 아니다. 해당 원문·명령·ID와 정리 증거는 `.brain-automation/reports/t71-final-changed.md`, `t72-target-review.md`, `t73-target-review.md`, `t74-related-regression.md`와 관련 영수증에 있다.

현재 schema42 제품 artifact `587678c2502a66212ffc0dfdb408ae7c761c60b9595f38755b80e8e2290292e0`, 종료 관측을 추가한 runner `d48c7227e467d723d986506bbaacfbc0239dddd57a53a9a216268502eeaf77ee`다. T57 당시 current schema41과 runner `aeb90f5c40815ee81f9da5c25ca39be1580f3772d3b823e3db6aa174db6c548d`의 여섯 측정값은 검색 SQL·fixture/oracle·timed 표본 의미가 유지되는 범위의 역사 증거이며 새 cleanup gate 또는 schema42의 새 성능 실행으로 소급하지 않는다. 옛 T10/T12/T17/T20/T29/T34 raw 6경로 손실과 원인 미확정은 재생성되지 않았다. T62 상태 디렉터리 링크 교체는 승인 거절로 미실행·미재시도했고 T63 wrapper는 실제 사용자 HOME을 오직 실제 `orb status` 한 인자에 위임한다. 이 증거로 모든 자식의 완전한 HOME 격리를 주장하지 않는다.

### Auto Run Result — 제출 전 상태
T76 최종 감사의 P3는 T77에서 보완됐고 T78은 정확 소유 PG 두 개를 정상 stop/remove 및 개별 부재 확인했다. T79 독립 후속은 P3 해소·정리 증거 충족·새 finding 0을 확인했으며 기술 검증·리뷰·소유 PG 정리 gate가 충족돼 지휘자가 built를 승인했다. T58 최초 full 두 exit1과 T71 changed exit1은 그대로 남고 T74 관련 TS15 및 PythonAll 16파일73통과로 실패별 재검증을 연결한다. `status: built`, T4 완료, `deferred: []`다. 공개 staged bytes의 비밀·개인 홈 경로 검사와 정상 hook, 범위 commit·자기 branch 정상 push·원격 SHA 확인 및 중앙 보고는 별도 제출 gate로 아직 미완료다. T75 정리 명세는 당시 절차이고 실제 결과는 `.brain-automation/reports/t78-owned-pg-cleanup.md`와 `t79-final-followup.md`다.

### 2026-11-08 — T80 staged 검사와 T81 공백 교정
T80의 staged diff 검사 exit2는 `tooling/query-perf/src/common-search.mjs:112` 끝 공백 한 글자였다. T81은 해당 한 바이트만 제거했으며 T74 실행 당시 runner `d48c7227e467d723d986506bbaacfbc0239dddd57a53a9a216268502eeaf77ee`와 현재 정적 runner `10d13f4e1f02989582246c8fb25429a755610bcff64c1c41137522cda9170381`는 구별한다. 제품 artifact는 `587678c2502a66212ffc0dfdb408ae7c761c60b9595f38755b80e8e2290292e0` 그대로다. 공백만 바뀌어 실행 의미는 유지되지만 과거 실행 증거를 새 지문으로 소급하지 않는다. T80 실패·T74 결과·T57 역사 수치와 모든 한계는 유지하며 compile/시험/성능은 반복하지 않았다. 정상 hook·commit·자기 branch push·원격 SHA 및 중앙 보고는 여전히 pending이다.
