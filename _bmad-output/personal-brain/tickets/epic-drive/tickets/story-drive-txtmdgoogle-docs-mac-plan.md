---
title: '8.2 외부 Drive 폴더의 본문·이름 색인'
type: feature
ticket: 2
created: '2026-11-06'
status: built
baseline_revision: d5f4896afd2684316e3a8c943706c7cf433b0393
route: full
route_source: pinned
risk: high
review: thorough
review_source: pinned
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 3
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/automation/runbook.md
  - _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md
  - _bmad-output/personal-brain/inputs/rag-oss-patterns.md
  - _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 외부 Drive 폴더를 선택해도 문서 본문과 사진·큰 파일 이름을 검색할 수 없다. 외부 원본을 Mac의 영구 파일로 보관하지 않는 수직 경로가 필요하다.

**Approach:** sources/source_files, source_sync 일감과 전용 bytes reader를 기존 추출 세대 writer에 연결한다. 실제 sources sync CommandSpec·SDK·metadata에서 문서/이름 recall docs와 source 전용 files show까지 가짜 Drive로 관찰한다.

## Boundaries & Constraints

**Always:** 첫 목록 전 changes start token 확보, 하위 폴더·3페이지 완주, 완주 성공 뒤만 누락을 접근 불가로 표시. MIME/size 선별과 bounded download/export, byte 형식판정·SHA256, 동일 세대 writer·current pointer·claim fencing 사용. 외부 파일은 brain home/위치를 만들지 않는다. 원격 I/O 중 DB 쓰기 transaction 없음. 임시 0700/0600, terminal attempt 뒤 finally 삭제, 재시작시 자기 고아만 정리하고 열린 attempt/불명 소유 보존. remote version/hash의 성공표식은 색인 성공과 결합하며 실패를 완료 지문으로 저장하지 않는다. content 가림은 source 재연결/갱신으로 우회할 수 없고 이름·경로·링크도 제외. source별 접근 상태와 내용 전체의 원본 부재를 구별한다. 기존 성공 조각은 삭제/권한 상실로 지우지 않는다.

**Never:** 실Drive·OAuth·운영DB·credential·사용자 파일·다른 티켓 자원 접근/변경/정리, 중앙 state/main 수정·병합·push 금지. 0001~0040 바이트 불변, 실제0040/schema40은8.1. 새0041/core41만 등록. 8.1 FileStore/업로드/root매핑/CAS·가리기·보관, 22.4 batchwrite·22.5 UUID predicate 보존. 22.3 chunk/tool SQL·점수·common-search runner는 소유하지 않는다. 나머지 sources 명령/OAuth·설정/예약전체(8.3), changes 증분/전체재개/8.1 submitting복구·keep_local_days 변경(8.5), PDF/docx(8.4), 문서집계/폴더검색 API·새 locator·Docs API 딥링크는 이번 범위 밖. release/ref 변경 금지. 미충족 AC·필수확인을 defer로 숨기지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 목록 | 합성 감시폴더·하위폴더·3페이지 | starttoken 요청이 첫 목록보다 앞, 모든 항목·경로 저장 | 불완전/실패 목록으로 prune하지 않음 |
| 본문 | txt/md/Docs와 두 글자 한국어 | 같은 추출 세대/정상 locator·Drive URL로 recall docs→show | 형식판정·hash 불일치면 실패·기존성공 보존 |
| 이름 전용 | 사진·60MB 파일 | 다운로드0, photo/too_large·이름/경로 검색·상태/접근/링크 show | 가짜 file_id/locator 생성 금지 |
| 상한 | metadata 초과·길이 누락/거짓·Docs export 초과 | 받기 전·도중 상한, Docs API10MB와 기존8MiB추출 상한 구별 | too_large, stream 취소·임시 정리 |
| 멱등/실패 | 같은 sync 재실행·일시I/O/DB실패 | 행수 불변, 실패를 완료지문으로 남기지 않음 | 재시도 가능·접근불가 오판 금지 |
| 삭제/접근 | 원격삭제 뒤 재sync, 동일hash 다른 정상source/brain원본 | 해당source만 unreachable 경고·조각 보존, 정상원본 있으면 files.source_unreachable_at 비어 있음 | 전체목록 실패와 확인된 없음 구별 |
| 가리기 | content 연결 뒤 files.redact·재목록/재연결 | 본문·이름·경로·링크 검색/show에 없음 | 가림우선 DB publish 재확인 |
| 임시 수명 | 다운로드 뒤 중단/재시작·열린attempt·타인파일 | 자기 고아만 정리, 열린attempt bytes·타인파일 보존, terminal 뒤 잔존0 | DB/소유관측 불명은 보존 |
| migration | schema40 기존파일/추출/이력·fresh install | 41 설치/업그레이드, 이전행·checksum·권한 유지 | 역사 기대 일괄교체 금지 |

</intent-contract>

## Code Map

- `packages/core/src/ports/source-file.ts`의 reader와 Brain `sources` 주입은 첨부 로컬경로용이다. 별도 source sync 저장/원격/임시 reader port를 만든다. `packages/core/src/ports/store.ts`, `testing/fakes/store.ts`, `testing/contracts/`에 동등 계약을 유지한다.
- `packages/postgres/src/{store,attachments,extractions,work,write}.ts`: withWrite와 ensureWork, content_hash 고유행·파일잠금·가림우선 규칙을 재사용. 새 `sources.ts`와0041에서 sources(kind/account유일·cursor·연결세대), source_files(source/remote유일·이름/부모경로/MIME/version·nullable content·접근/색인상태), 임시attempt binding을 필요한 최소로 영속한다.
- `packages/core/src/files/extract-work.ts`: read state→유효file claim→beginExtraction→size→home get→hash→detect/extract→writeExtractionChunks→finishExtraction. `packages/postgres/src/extractions.ts`는 file target claim이 유효할 때만 begin, 열린attempt 정리·배치·단조pointer를 소유한다. source bytes를 명시적으로 주입해 같은 경로를 쓰고 pending 원격상태와 성공표식을 구별한다. 파일대상 document_extract와 source_sync의 소유/동시성·완료 publish를 결합하며 임의claim/가짜home로 우회하지 않는다.
- `apps/cli/src/runtime/drive-file-store.ts`는 brain 소유 제한 유지. source용 HTTP/remoteid resolver·temp adapter를 별도로 둔다. source_sync는 work handler로 조립하고 파일별 작업과 합쳐진 재시도를 기존 work port로 처리한다.
- `packages/core/src/ports/document-recall-store.ts`, `recall/{documents,results}.ts`, `packages/postgres/src/recall.ts`의 document 함수: 현재 report/추출 필수join을 source 본문/이름 branch로 확장. 이름전용 nullable file_id/extraction_id/locator와 source_file_id/상태/접근/URL, source별 경고·continuation을 전달. chunk/tool 함수 불변. `literalLikePattern`, documentContext·마스킹/상한/probe 재사용.
- `packages/core/src/brain.ts`, `apps/cli/src/{assembly,dispatch,commands/index,commands/files-show}.ts`: 기존 첨부 sources 주입과 구별해 최소 sources.sync SDK/CommandSpec/metadata 조립. files.show source_file_id 단독은 상태조회, 본문출처는 기존 문맥/이어읽기와 source정체성 유지.
- `packages/postgres/src/migrate.ts`: 현재40→41. migrate/schema·CLI setup/install/schedule migration·extensions 최신기대는 의미별 수정,39→40 역사시험은 coreMaxVersion40 유지. `tooling/test-changed/rules.mjs`에 새 SQL/자식경로 연결.
- `apps/cli/test/{drive-tracer,pg-home}.ts`, `test/fixtures/{fake-drive.ts,drive-fixture.md}`, `tooling/test-db/src/index.ts`: pgHome·createIsolatedTestDatabase·fakeClock·sequenceIdGen·dispatch·pgRunner와 역순cleanup 재사용. 조사 결과는 로컬 explore-report에 보존했으며 오래된 SQLite 연구 관찰보다 실제PG코드가 우선이다.

## Tasks & Acceptance

**Execution:**
- [x] 1. source 저장 계약 — `packages/core/src/ports/source-store.ts`(신규), core export/fake/계약, `packages/postgres/src/{sources,store,migrate}.ts`, `packages/postgres/migrations/0041_sources.sql`(신규), PG source/migration 시험 — source 정체성·연결세대·원격metadata/경로·nullable content·색인/접근상태·cursor·임시attempt binding·file대상 추출 handoff/publish 계약을 구현하고0041등록/최신기대/40→41데이터·이력·권한 시험을 작성한다. 임시열린attempt 관찰과 가림/claim fencing도 계약으로 고정한다.
- [x] 1a. 저장 의미 보완 — `ports/source-store.ts`, source fake/PG/0041·계약시험 — sources(kind,account) 하나·계정당cursor하나를 유지하고 감시root복수의 확장여지를 source 정체성과 구별한다. 접근불가시각은 명시적 Clock에서 남긴다. 새DDL의 generation/index_status/unreachable 값은 SQL default 대신 작성자가 명시해 AD-22/기존catalog계약을 지킨다. 동일계정 다른root의 source중복거부/안정정체성, 접근상실/회복시각과default없는catalog 기대 시험을작성한다. 아직미배포0041만고치며과거migration불변.
- [x] 2. source 실행·임시 bytes — core source_sync use case/handler와 `files/extract-work.ts`, runtime source HTTP/temp adapter, fake Drive 및 core/runtime 시험 — 목록·starttoken·계층/paging·선별·bounded export/download·hash/형식판정·같은 추출 writer와 terminal 정리·재시작 고아정리를 연결한다. 일시/접근 오류구분·완주후누락표시·원본전체접근집계·가림/동시성·D10 열린attempt 보존을 구현하고 해당matrix 시험코드를 쓴다.
- [x] 3. 문서·source 검색/show — document recall port/core/PG/fake·기존출력codec/probe·CLI files-show·관련회귀 — source본문/이름 branch와 nullable 출처·상태·링크·source별 경고·가림 필터·문맥/continuation을 연결한다. 기존chunk/tool SQL/점수는 변경하지 않고 query 함수/마스킹 경계를 재사용한다.
- [x] 4. 수직 조립과 fixture — Brain SDK·CLI assembly/dispatch/commands/metadata·새 `apps/cli/test/drive-source-tracer.test.ts`·fixture 지침·test-changed 규칙 — 실제 sources sync→metadata→두글자 docs→files show,3페이지·멱등·사진/60MB 다운로드0·삭제후조각보존·정상동일hash·가림·임시중단/열린attempt·잔존0를 격리PG/home/Clock/loopback에서 검증하는 시험을 완성한다. fixture 운영법과 자원정리/재사용 절차를 기록한다.

- [x] 5. R1 source 공유/청구/완료 계약 재도출 — `ports/source-store.ts`, source fake/PG/0041·계약/PG시험, `sources/sync.ts`, `brain.ts` — BH2/5/7·EC1의 source 작업 청구갱신(원래 claim identity와만료fence 유지), publish→complete 사이 늦은동일hash handoff의 원자적 성공연결 또는확실한후속실행, 요청source와현재handoff만의완료/대기/영구실패판정과필요한실행격리를 구현한다. backoff대기0due·무관source/첨부실패·동시late handoff·lease경계시험작성. 공통 WorkStore/검색API를넓히지않고source소유내부능력으로구현하며필요하면중앙조율. BH9의file참조/이름경로검색인덱스를0041에추가하고PG카탈로그/합성접근계획검사코드작성. VG1만료게시·VG3후반UPDATE실패rollback을실제PG로검증하는시험코드추가.
- [x] 5a. source sync lease — `ports/source-store.ts`, source PG/fake/계약시험, `sources/sync.ts` — source_sync 진행중동일work/claimed_by/claimed_at/attempts·미완료/미만료fence로만lease갱신하고페이지/파일진행에서호출한다. 원격I/O중DB잠금없이600초를넘는정상진행은갱신으로완료,이미만료/소유변경은부활하지않음을실제PG와Clock/fake시험코드로구별한다. 공통WorkStore공개API는변경하지않는다.
- [x] 5b. 요청 source 완료/실행격리 — source port/PG/fake·Brain·관련시험 — 요청source_sync와그현재handoff만claim/상태집계하고미래due backoff·실행중·영구실패가있으면미완료,무관source/첨부실패나backlog가해당성공을오염/선점하지않게한다. 기존drain을source소유wrapper/내부query로제한하며공통API확대금지. backoff0due재호출·무관큐시험코드작성.
- [x] 5c. 늦은 공유handoff와인덱스합성확인 — source PG/fake·계약/PG시험 — publish완료→complete전새handoff가이미확정된같은hash현재세대에원자연결되거나확실한후속실행을얻도록파일잠금/publish와공유순서로재도출한다. 실제PG장벽교차시험과유효version/가림fence·멱등을보장하고BH9인덱스의대량합성데이터접근계획검사코드를보완한다.
- [x] 6. R1 source bytes/추출 수명 재도출 — source port/fake/PG/0041, `files/extract-work.ts`, source sync·temp/runtime와관련시험 — BH4/6/10·EC2/3·IA4의일회정상다운로드→소유temp handoff→같은추출writer/지문확정을구현한다. 한후보404/일시실패에도다른유효source/검증된brain원본을사용하며모든현재handoff에unsupported/too_large/실패상태반영. 게시거부/terminal작업의열린attempt를정확한소유/fence로안전종결하고자기잔여만회수,살아있는/open또는불명attempt보존. 정상일회download/export·공유fallback·late조건·terminal잔여회수·열린/타인보존시험작성. VG2추출후metadata변경과해시동일시publish거부시험추가. IA2는공통8MiB상한은유지하되source Docs의유효상한을10,000,000bytes로별도적용하고8MiB~10MB사이정상UTF8/상한넘음시험작성. Docs가아닌기존첨부상한변경금지.
- [x] 6a. 일회 bytes handoff와Docs상한 — source port/PG/fake/0041·sync/temp·extract-work·관련시험 — Execution6의일회download/export→소유temp handoff→추출재사용을완성한다. 원래version/hash/claim·가림fence유지,준비중/DB불명/동시청구시원문보존과준비완료확정을설계한다. source Docs만10,000,000byte상한,기존첨부8MiB유지. 정상원문요청1회·9MBDocs성공/10MB초과·추출후metadata변경VG2·중단보존시험코드작성.
- [x] 6b. 공유원본fallback과terminal수명 — source port/PG/fake/추출handler/temp·관련시험 — Execution6의한후보404/일시실패후다른정상source/brain원본fallback·모든현재handoff종료상태와열린attempt/terminal작업의정확소유결합을완성한다. terminal원문회수는살아있는작성자/열린청구를지우지않는fence하에서만,불명보존. 실제PG정상공유원본/unsupported/terminal잔여회수와열린/타인보존시험코드작성.
- [x] 7. R1 검색버전/실제중단 검증 — document source port/core/PG/fake·codec/CLI·tracer/fixture — BH3의보존된본문을현재원격본문으로오인하지않도록완료version/현재version·stale표시를source검색/show/마스킹/continuation에일관되게반영한다(기존성공본문은보존). IA3은source sync/document_extract실제handler를실행한합성자식을temp생성뒤장벽에서SIGKILL하고새실행의cleanup/작업재개경계를관찰하는high시험코드작성,8.5전체재시작완료를주장하지않음. VG4 arrayContaining의각예상원소를objectContaining으로교정하고R1전체matrix실행대응갱신. 소유API/점수와과거migration불변확인.

- [x] 8. R2 실제SQL/잠금경계 — `packages/postgres/src/sources.ts`, source관련PG시험 — R2-S4의실제file참조query는기존canonical검증계약을보존하고UUIDcolumn을text변환하지않도록안전한parameter UUID비교로인덱스와맞춘다. 합성EXPLAIN도실제list/publish SELECT/UPDATE형태를검사한다. R2-S5의scan/observe↔publish잠금역전을명시순서로해결/확인하고두독립store/backend와장벽으로실제양방향경합·DB_LOCKED/재시도시보존·최종지문/포인터정합을검사하는시험코드작성. 기존전역UUIDpredicate/commonAPI/22.3범위와과거migration불변.
- [x] 9. R2 검증fixture교정 — `packages/postgres/test/source-store.test.ts`, `apps/cli/test/drive-source-tracer.test.ts`·fixture지침 — C4/S1의publish/handoff장벽은별도store/pool/실제backend와명시된시험lock/query예산으로교정한다. C1/S2의VG2는실제handler가동일hash bytes를읽은뒤최종remote metadata만v2로바뀌는입력으로기존성공current/본문/지문보존·새publication부재·재시도가능실패를검사한다(원격경로와ready경로구분). C2/S3의VG3는기존성공세대/조각을먼저게시하고새열린세대/조각후sourceUPDATE오류에서이전/새세대/양쪽조각/포인터/지문/publication전체snapshot을검사한다. C3의9MB공백fixture에는앞/뒤UTF8표식을넣고실제조각쓰기·두글자본문검색/show·정상1회요청/잔존0을검사한다. 작성주장과실제시험소스대응을정확히갱신한다.

- [x] 10. R3 잠금순서 최소회귀 구별 — `packages/postgres/test/source-store.test.ts`·fixture지침 — R3-C1의기존timeout/재시도시험은유지하고,finish-first가source만잠근장벽에서publisher가source를기다리는동안제3독립연결의source_file NOWAIT probe로publisher의source_file선취없음을검사한다(또는동등하게역전최소회귀를확실히구별). publisher가살아있는지/실제blocked backend인지확인한뒤probe하고,동일max1pool/timeout후관찰로대체하지않는다. 명시source-first잠금제거회귀가실패할구체적행사/단언을보고한다. 제품코드변경없이검증소스/지침만보완.

- [x] 11. 최초전체회귀실패교정 — 신규source-store PGfixture는work_items.execution_class를작성자명시하고테스트DDL에default를추가하지않는다. 미배포0041은setup의default DELETE권한을새6표에서명시revoke해최소권한을지키고권한fixture로검사한다. store maxima/계약·Drive SIGKILL자식·supervised회수의현행schemaVersion은CORE41로연결하되40역사시험불변. readSourceDocument missing-schema의DB_UNAVAILABLE계약은source전용catch에서지키며chunk/tool search공유오류분류는변경하지않는다. `packages/postgres/test/{source-store,migrate,store,unavailable,drive-migration,work-store}.test.ts`의최초29실패를원인별교정하고격리PG/홈에서관련재검증한다. 새로행사되는PG경계의실제실패도같은수락범위안에서해결하고원시보존. 전체TS/Python명령재실행금지,관련/changed만사용.

**Acceptance Criteria:**
- Given 합성 Drive 폴더(txt/md/Docs/사진/60MB·하위경로·3페이지)와 격리PG/home/Clock, when 실제 CommandSpec/SDK sources sync 뒤 recall docs에 본문 두글자와 이름을 질의하면, then 본문세종류는 현재세대/Drive링크로 검색되고 사진/큰파일은 상태와 이름으로 검색되며 download0이다.
- Given 이름전용 검색출처, when files show(source_file_id)를 실행하면, then 색인/접근상태·Drive링크를 출력하고 file_id/locator를 지어내지 않는다.
- Given 반복sync와원격삭제, when 각각 완료하면, then 행수불변·해당source접근불가·기존조각보존, 동일hash 정상원본의 files.source_unreachable_at은 비어 있고 경고는 삭제된출처만 붙는다.
- Given 가린내용 연결source, when 재목록/재연결후 검색/show하면, then 이름·경로·링크·본문이 노출되지 않는다.
- Given 정상종료·다운로드후강제중단/재시작과타인/열린attempt bytes, when 자기namespace를 정리하면, then 외부bytes는 FileStore루트에0, terminal잔여0이고 열린attempt/타인bytes는 보존한다.
- Given schema40의 기존행·이력·권한과 새설치, when0041적용하면, then core41이며기존데이터/1~40checksum·brain_app/확장권한경계가 보존된다.

## Implementation Notes

- Execution10: finish-first소스장벽·실제publisher차단중제3독립연결source NOWAIT거부/source_file NOWAIT성공probe와publisher생존대조를추가. build/typecheck/diff0,시험미실행. R4 coverage해결확인뒤최종회귀.

- Execution9: 독립store/pool/backend·명시예산양방향장벽,ready/download실제handler의읽기/조각쓰기후remote v2와기존본문보존,기존성공+새열린두세대후반UPDATErollback전체snapshot,9MB앞뒤UTF8표식의실제chunk/검색/show시험작성. build/typecheck/diff0,시험미실행. R3독립해결확인필수.

- Execution8: canonicalUUIDparameter비교/비정규입력기존의미보존과실제list/publish형태EXPLAIN시험작성,sourceUUID순→source_fileUUID순→handoff/attempt→file명시잠금·scan/observe양방향독립backend시험작성. build/typecheck/diff0,시험미실행. R2장벽fixture/VG2/VG3/9MBDocs는9에남음.

- Execution7: source현재/완료version·stale본문표시/마스킹·문맥continuation과실제Brain SDK handler자식temp쓰기/읽기장벽SIGKILL→새실행cleanup/재개시험작성,VG4교정. build/typecheck/diff0,시험미실행. R2독립후속으로실질수정해결을개별확인한다.

- Execution6b: 유효source후보/검증된brain원본fallback·현재handoff전부종료상태·정확extraction/claimbinding과terminalrecovery·preparing작성자/완료표식정리안전및PG/fake/runtime시험작성. build/typecheck/diff0,시험미실행. 실제handler중단경계와stale본문표시는7에남음.

- Execution6a: preparing예약→트랜잭션밖temp쓰기→같은sourceclaim으로ready/fileworkhandoff원자확정·실제fileclaim재binding/추출재사용,sourceDocs10MB별도상한·정상1회요청/9MB/초과/VG2/준비중보존시험작성. build/typecheck/diff0,시험미실행. 준비중/공유temp의terminal회수와fallback은6b확인대상.

- Execution5c: 동일hash advisory→file잠금순서·publication/current검증으로latehandoff원자연결,오래된publication재시도와실제PG양방향장벽·가림/version시험작성. 1000file/20000handoff ANALYZE·기본planner인덱스검사코드작성. build/typecheck/diff0,시험미실행. Execution5범위는5a/b/c로구현완료했고실행/독립확인은남음.

- Execution5b: source소유due/claim/완료조회와Brain scopedStore wrapper구현,현재generation/versionhandoff만대상·무관큐미청구·backoff/실행중/실패미완료시험작성. 공통WorkStore공개API불변확인. build/typecheck/diff0,시험미실행. PG work내부후보규칙재사용의동등성은후속독립확인한다.

- Execution5a: source전용renewSourceClaim·PG조건부미만료갱신·fake/계약/600초초과진행/만료·교체거부시험작성. handler단계사이갱신직접대조. 최초오래된dist typecheck1뒤 build/typecheck/diff0,시험미실행.

- Execution5 첫Task는인덱스·VG1/VG3시험코드만부분작성하고종료했다. compile0/시험미실행이며완료로계산하지않음. 단순범위미완료를차단으로취급하지않고5a/5b/5c계약단위로분할해이어구현한다. 인덱스의첫EXPLAIN은enable_seqscan=off사용가능성만이며합성규모검사는5c에남음.

- Execution4: sourceSyncFactory→Brain SDK/CommandSpec/metadata·file추출queue·전용temp주입과격리tracer4건,fixture운영/Clock/정리및test-changed규칙작성. build/typecheck/diff-check0,시험미실행. 4렌즈뒤최종회귀에서실제실행을확인한다.

- Execution3: PG/report기존branch와source본문/이름branch·nullable출처·Drive resolver·source-only show/문맥/continuation·가림/경고및시험코드를작성했다. 직접diff로chunk/tool SQL·점수보존확인. build/typecheck/diff-check0,시험미실행. 실제SDK/CLI조립은4에남는다.

- Execution2: source_sync의starttoken·계층/페이지·선별/접근오류와file대상추출handoff,source전용HTTP/temp·열린attempt보존·동일writer/publish연결 및시험코드를작성했다. build/typecheck/diff-check0,시험미실행. 원격bytes는sync해시확인과file추출청구에서각각읽으며중간version을재확인한다. 최종독립리뷰에서중복읽기의수명/실패/가림/동시성안전과강제중단fixture의실제관찰을확인한다. 검색/show가림필터와실제SDK/CLI조립은3/4에남는다.

- Execution1a: sources(kind,account)유일·다른root거부/동일정체성보존, Clock접근불가시각·회복, 작성자명시값/새DDLdefault제거를직접대조했다. build/typecheck/diff-check0,시험미실행. 복수감시root매핑은8.3확장경계다.

- Execution1: source port/PG/fake/계약·0041·40→41시험 작성, build/typecheck/diff-check 종료0. 시험미실행. 직접대조에서 계정당source정체성과접근시각/명시값작성 보완이필요하여1a로분리했다. 원시최초DNS실패는로컬보고보존.

## Plan Change Log

- R3: R3-C1의잠금순서회귀검출공백을Execution10검증전용으로보완한다. 제품명시잠금순서·기존timeout/재시도시험과모든KEEP를유지하고역전구현이통과하는잘못된검증완료판정을피한다.

- R2: C1/S2 VG2작성주장과실제원격응답경계불일치, C2/S3 이전세대없는rollbackfixture, C4/S1 동일max1pool장벽모순, C3 9MB공백본문미검증을확인했다. S4 UUIDcolumn textcast/합성query불일치와S5 scan/publish잠금불확실도Execution8/9로해당경계만재도출한다. KEEP는R1과동일하며기존안전코드/시험삭제없이교정한다. R2diff는로컬 `/tmp/brain-82-review-r2.diff`보존. 5~7구현체크는검증완료뜻이아니며남은필수항목은8/9다.

- R1: 공유handoff·완료판정·임시bytes소유/terminal회수·검증경계공백을확인하여Execution5~7로해당계약을재도출한다. 전체attemptpatch는로컬 `/tmp/brain-82-review-r1.diff`보존. 잘못된분기만교체하고원본/선행작업을reset/clean하지않는다. KEEP: source/brain소유분리,0041및0001~0040불변,계정당source/cursor,claim세대와가림fence·원격I/O밖transaction,기존추출writer/current단조전환,source별접근경고/정상동일내용원본보존,nullable이름show·마스킹/문맥/continuation,실제CommandSpec/SDK/PG/가짜Drive격리,chunk/tool SQL·점수보존. Docs10MB를별도source상한으로지켜기존첨부8MiB를바꾸지않는다.

## Review Triage Log

### 2026-11-07 — Review pass R5
- verdicts: 1 finding — high 0, medium 0, low 1, false 0, maybe-false 0
- R5-E1 `[low]` `[patch]` 구현보고권한관찰범위과장 —여섯표effective권한카탈로그와sources실제DELETE한표만검사했으므로로컬보고문구정정/원근거보존. 제품코드변경없음,추가권한시험요구아님.
- 독립원시대조로최초29실패/추가planner1의처분·6파일303건파일별최종통과·필수PGmatrix·Python69및TSskip1의Python후속실행을확인했다. 마지막제품/fixture교정에서새결함/AC숨김없음. planner는행폭이큰합성부하의기본비용선택이며모든실제분포의계획보장아님. changed선정재검증이남음.

### 2026-11-07 — Review pass R4
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- R3-C1: coverage가source잠김/source_file비잠김초기probe·세독립PID·살아있는publisher전후blocker대조·NOWAIT성공·timeoutrollback/재시도유지를실제시험소스에서확인했다. 마지막실질수정의정적해결확인완료이며시험통과뜻이아님. 최종순차전체회귀진입.

### 2026-11-07 — Review pass R3
- verdicts: 1 finding — high 0, medium 1, low 0, false 0, maybe-false 0
- R3-C1 `[medium]` `[bad_plan]` timeout뒤경쟁transaction종료후장벽해제로source-first회귀구별못함 —현재시험은DB_LOCKED원자실패/재시도는검사하지만잘못된선취잠금도같이통과. Execution10에서publisher생존중제3연결NOWAIT probe로보완.
- R3-safety는R2-S1~5실질소스수정과VG2양경로/두세대rollback/9MB표식·독립pool을개별확인했고새확정코드결함0. coverage가발견한위필수공백을그판정으로무시하지않는다. 시험은미실행.

### 2026-11-07 — Review pass R2
- verdicts: 9 findings — high 0, medium 9, low 0, false 0, maybe-false 0
- findings:
  - R2-C1 `[medium]` `[bad_plan]` VG2실제추출후metadata변경시험없음 —기존시험은DBmetadata변경/별도sync만검사. Execution9동일bytes/hash와최종remote응답변경.
  - R2-C2 `[medium]` `[bad_plan]` VG3기존성공세대/조각없음 —snapshot이새열린세대만검사. Execution9두세대교체rollback.
  - R2-C3 `[medium]` `[bad_plan]` 9MB공백본문은chunk writer/검색/show미검사 —공백조각제외확인. Execution9앞/뒤표식·실제본문관찰.
  - R2-C4 `[medium]` `[bad_plan]` max1동일pool의두Promise장벽불성립 —store/fixture/createPool대조로둘째세션이없음. Execution9독립pool과예산교정.
  - R2-S1 `[medium]` `[bad_plan]` BH5장벽미성립 —C4와같은원인,실행전확정시험결함이며제품훼손주장이아님. Execution9동일처분.
  - R2-S2 `[medium]` `[bad_plan]` VG2필수입력미작성 —C1과같은Execution9처분.
  - R2-S3 `[medium]` `[bad_plan]` VG3기존current와조각보존미검사 —C2와같은Execution9처분.
  - R2-S4 `[medium]` `[bad_plan]` 실제h.file_id::textpredicate와UUID B-tree/합성query불일치 —실제columncast확인. Execution8실제queryparameter UUID대응/실제형태계획검사.
  - R2-S5 `[medium]` `[bad_plan]` scan/source-first와publish복수relation lock순서미고정 —독립source/filework중첩가능하고query의명시순서/시험부재를확인. 데이터훼손관찰로주장하지않고Execution8명시잠금순서/경합검사로보완.
- R1수정상태: EC1/2/3·BH2/3/4/6/7/10·IA2/3/4·VG1/4는R2원문이각실질교정을소스로확인. BH5/9·VG2/3은위보완전수락하지않음. 모든시험은미실행상태다.

### 2026-11-07 — Review pass R1
- verdicts: 21 findings — high 4, medium 15, low 1, false 1, maybe-false 0
- 개별검증은각리뷰원문과현재호출/SQL·시험코드대조. VG1~3은검증렌즈사전확인근거를수락했다. 순서는도착순EC→VG→IA→BH다.
- findings:
  - EC1 `[high]` `[bad_plan]` backoff미완료추출이있어도다음sync의전역report가0이면성공 — Brain은source work outcome만확인하고미래duehandoff를조회하지않음. Execution5에서요청별상태대조.
  - EC2 `[high]` `[bad_plan]` 공유file work에서첫원본404면정상원본도미추출 — handler find하나·UNREACHABLE영구실패확인. Execution6다중후보/fallback.
  - EC3 `[medium]` `[bad_plan]` unsupported가선택source한행만갱신 — markSourceFileOutcome단일source predicate확인. Execution6현재공유handoff상태반영.
  - VG1 `[medium]` `[bad_plan]` 만료추출claim게시거부의DB불변단언없음 — 현재만료predicate는있지만삭제회귀못잡음. Execution5만료경계시험.
  - VG2 `[medium]` `[bad_plan]` 추출후metadata버전변경시험없음 — sync시험은별도표면. Execution6동일bytes/hash·후metadata변경시험.
  - VG3 `[medium]` `[bad_plan]` source후반UPDATE실패시세대/포인터rollback시험없음 — 정상/쓰기전거부만존재. Execution5실제PG오류trigger/상태비교.
  - VG4 `[medium]` `[patch]` PG검색시험arrayContaining이부분객체를정확객체로비교 —101행예상원소필드누락확인. Execution7objectContaining교정.
  - IA1 `[false]` `[reject]` 일반설치CLI연결이fixture주입과다름 — 원문이8.3의OAuth·나머지sources/설정과명시분리하고가짜서버CommandSpec/SDK최소형을요구하므로주입dispatch는허용표면. 운영연결완료라고보고하지않음.
  - IA2 `[medium]` `[bad_plan]` Docs유효상한8MiB가10MB표현보다작음 —sync수신후와추출사전검사에서거부확인. Execution6sourceDocs상한별도적용,기존첨부유지.
  - IA3 `[medium]` `[bad_plan]` crash자식이temp.write만실행 —실제handlerbind→writer사이중단은미행사. Execution7실제handler자식/장벽/새실행관찰.
  - IA4 `[medium]` `[bad_plan]` sync해시읽기와추출원격읽기두번 —bytes해시검증은있으나이미받은원문미재사용. Execution6일회temp handoff.
  - BH1 `[medium]` `[reject]` starttoken후changes따라잡기없음 —실제소비경로없음을확인했으나원문이증분changes전체를8.5로명시분리. 이번token확보/전체목록완주만구현하며스냅샷정합/증분완료주장금지. 8.5인계.
  - BH2 `[medium]` `[bad_plan]` 긴정상source가600초lease만료로영원히처음부터 —sourceclaim갱신없음확인. Execution5진행중유효claim갱신과600초경계시험,전체crashresume는8.5.
  - BH3 `[medium]` `[bad_plan]` 실패한새version의이름으로옛본문을현행처럼제공 —observe는file_id보존하고query/show는version미노출. Execution7명시된stale/완료version.
  - BH4 `[high]` `[bad_plan]` 정상공유원본fallback누락 —EC2와같은원인/처분,각발견은보존.
  - BH5 `[high]` `[bad_plan]` publish뒤complete전latehandoff가완료work에미게시상태로남음 —ensureWork열린row반환과publish갱신대상시점대조. Execution5동시경계재도출.
  - BH6 `[medium]` `[bad_plan]` terminalwork의열린추출이temp영구보존 —readSourceAttempt는아무open추출을항상open판정. Execution6정확attempt/work결합·안전종결/회수,열린생존보존.
  - BH7 `[medium]` `[bad_plan]` 무관큐실패가요청source오실패 —전역report판정/대상필터없음확인. Execution5요청별판정/실행격리.
  - BH8 `[low]` `[reject]` 같은target의둘째shortcut별칭은보존안됨 —targetid중복억제에서발생. 원문이요구하지않는별칭관계API/DDL추가가필요한복잡성대비일상적해악이낮아이번에추가하지않음. 대상정체성dedup은유지하고제약을잔여위험으로기록.
  - BH9 `[medium]` `[patch]` file_id참조인덱스부재 —조회/publish/접근집계가반복file_id필터이고새DDL키는source측뿐. Execution5참조·이름검색인덱스추가/합성계획검사코드.
  - BH10 `[medium]` `[bad_plan]` 첫색인두번download/export —BH의40MB예시는기존8MiB사전거부로해당없지만허용크기에서도두번읽는실제해악은확인. IA4와같은Execution6수정.

## Design Notes

full/pinned·high: 소스 정체성·가림·추출claim과임시수명이 함께 변한다. 기존8.1계약과source전용reader/링크resolver를 분리하고 실패상태를 source 성공지문으로 저장하지 않는다. source본문·이름은같은질의함수, 내용과source정체성을 함께 유지한다. Docs export10MB는 API의상한이며기존8MiB추출상한을 몰래늘리지 않는다.

companion 착수 처분:
- R5/R14: 문서집계·별도순위는8.6공통계약 조율대상,이번미채택. R6: 본문/이름동일질의는채택, 새점수/가산은이번미채택(22.3소유분리). R16 제목경로접두는8.4/8.6이며미채택.
- D1/D2: rate-limit403/429·5xx는 일시실패,확인된403/404만접근불가라는안전분류채택. 기존재시도queue를쓰고긴sleep loop는추가하지않는다. 공식API사실확인이필요하면 Google공식문서만조회하고출처기록.
- D3: incompleteSearch/목록실패를성공·prune로치지않음채택,token재시작전체는8.5. D4: 바로가기는대상ID중복억제·순환안전규칙을이번목록에적용하되전체changes시각창은8.5.
- D5: trashed=false·parent제약·필드최소목록채택,시간창증분은8.5. D6: 성공한동일원격지문의재다운로드회피채택,rename/move증분전체는8.5.
- D7: 사전size·수신stream상한채택,추출상한기존보존. D8: 이번수동전체sync는완주후누락대조채택,주기전체대조예약은8.5.
- D9: 기존text/plain·textlocator결정과충돌하여미채택,Docs API/scope/heading·tab locator추가금지.
- D10: terminal attempt뒤삭제·열린attempt보존채택. 불명DB/claim상태는고아로추정하지않는다. D11: 성공version/hash표식과세대publish결합채택. D12: 새folder검색인자/조상배열은8.6공통API조율까지미채택.
- core-architecture §2-3/7: content identity와성공색인표식·열린attempt중간bytes보존채택. 별도검색엔진/벡터복제/외부커넥터는쓰지않는다.

## Verification

개발·리뷰수정중 **시험 실행 금지, 컴파일 확인만**: `pnpm build`, `pnpm typecheck`, `git diff --check`. 수락조건시험코드는작성한다. 의존성다운로드 build는처음부터require_escalated.

마지막구현·독립Sol medium4렌즈및필요후속확인뒤커밋/push전, 자기PGcluster/role·home·venv·checkout밖TMPDIR·loopback fake·Clock·산출물격리. legacy관리자암호고정전제확인, BRAIN_TEST_DATABASE_URL명시. 자기DOCKER_CONFIG로실제OrbStackcontext/Compose/socket검증,전역context/DOCKER_HOST변경·비밀파일복사금지.

- `VITEST_MAX_WORKERS=2 pnpm test` → 전체TS종료0. 이어서 `pnpm test:python` → 전체Python종료0. 순차각1회,중복실행금지.
- 최초실패원문/종료코드/원인별처분보존,수정뒤 `pnpm test:changed -- d5f4896afd2684316e3a8c943706c7cf433b0393`와관련시험으로재검증한다.
- 최종matrix감사에서모든새시험이실행됐는지확인. 시험파일/실제명령·사전조건·요청기록·Clock제어·DB/디스크관찰·정리/정확자원ID·부재확인·한계는fixture지침과로컬원시증거/Auto Run Result에기록한다. 기존과거migration불변은git diff로확인한다.

## 최초 전체 회귀 실패 이력

- 2026-11-06 UTC16:22:59→16:32:17 `VITEST_MAX_WORKERS=2 pnpm test` 종료1:218files중212통과/6실패,4681tests중4651통과/29실패/1skip. 이어16:32:17→16:40:00 `pnpm test:python` 종료0:16files/69tests통과. 두명령각1회실행했고최초원시로그는로컬regression-ts.log/regression-python.log에보존.
- TS29실패: source-store23건은execution_class NOT NULL fixture누락으로필수PGmatrix미행사;40→41권한1건은setup default grant DELETE를미상쇄;store현재schema기대2건40잔존;source readSourceDocument missing-schema오류계약1건;Drive SIGKILL/supervised회수각1건은core40주입가능성을원문대조하여수정한다. skip1건은bootstrap의Python전용사례이며Python69통과와대조한다.
- 새CLI source tracer10/core source sync9/runtime6/source contract3/source document4/PG doc recall2는통과했다. PGsource25중23실패는통과로계산하지않는다. 전용PG3799dc0bfcda50c98d513dd066abb4e07cc8c791c0b66369fd4f25548216d624와fixture226개는정확ID생성/제거·부재확인,잔존0. 환경/원시/자원증거는로컬보존. 실패교정뒤관련시험/changed로재검증하며전체회귀를다시돌리지않는다.

## 최초 실패 교정과 관련 재검증

- Execution11: source직접workINSERT에execution_class='core'명시,미배포0041새6표DELETE revoke(기존setupdefault유지),현재schema기대/Drive자식/supervisor core41,source show자체missing-schema오류계약교정. 과거0001~0040/40역사시험/공통검색오류분류불변.
- 관련6파일첫실행303건중302통과/planner1실패(exit1). 합성source행의현실적인이름/경로길이패딩으로기본planner/실제query인덱스검사를유지하고source25/25재검증(exit0). 나머지drive12/store83/migrate21/work152/unavailable10은첫관련실행통과,합산303건의파일별최종통과이며단일실행합산이아니다.
- 실제VG1~3·BH5양방향·scan/publish4경계/NOWAIT·공유fallback·terminal·실제query EXPLAIN이source25통과에서행사됐다. 원시로그는로컬regression-fix-targeted-1/2.log. 전용04f4c660dcf27be30b2c6bc631d2c92efa66907bce6ad5c0bcbed82171234736와임시root부재확인. R5독립확인과changed는남음.

## 최종 변경영향 재검증과 matrix 감사

- 2026-11-06 UTC16:55:26→17:12:54 `VITEST_MAX_WORKERS=2 pnpm test:changed -- d5f4896afd2684316e3a8c943706c7cf433b0393` 종료0. 기본172files/3429pass/1skip → PG46files/738pass → Python16files/69pass 순차선정실행. 명령전체통과이며파일수는고유합산아님. skip은Python전용bootstrap사례이며Python단계에서실행/통과했다.
- 최종실행에서Drive source tracer10/runtime6/core source sync9/source계약3/source document4/PG source25/document2가통과했다. 목록/starttoken/3페이지·본문두글자/이름전용show·사진/60MB download0·일회원문·9MB앞뒤표식/10MB초과·재sync멱등·삭제/정상동일내용·가림·stale/continuation·실제handler SIGKILL/open·타인보존/terminal회수·claim/latehandoff/잠금순서/rollback/40→41권한의matrix코드가선정/실행됐음을원시로그와대조했다. 모든필수matrix누락0/미해결실패0.
- 전용PG ab175076c8dd9686d7c32d37b4ae4d20eb1daf54cfd9ece1610a54a0d5d6681f·fixture240개정확ID부재,임시root/관련자식잔존0을로컬자원로그로확인했다. 최초전체PG·fixture226개와교정PG도제거/부재증거보존. 시험생성tracked pycache 한파일만원래bytes로복원했고제품변경으로stage하지않는다.

## Auto Run Result

- result: built (사용자인수done아님). baseline: d5f4896afd2684316e3a8c943706c7cf433b0393. ownRun: run_b566f8e0a7fc. 최초Terra ready/depth1영수증은로컬보존. source/workspace/main소유경계를지켰고중앙state/main은수정하지않았다.
- 구현: source계정/cursor·source_files/추출handoff/publication/임시소유관계의새0041·core41,PG/fake/계약;source_sync계층/paging/선별·bounded source HTTP/temp reader;기존추출세대writer/가림/claim·공유fallback/원자publish/수명정리;document/source본문·이름·nullable출처/링크/상태/stale·show;Brain SDK/CommandSpec/metadata·합성fixture/자식중단·선정규칙을연결했다.
- 파일역할: core ports/sources/files는source저장·원격·임시수명과실행계약,postgres sources/work/extractions/migration은PG원자성·queue범위·권한,core recall/PG recall은document/source검색·문맥,CLI assembly/dispatch/commands/runtime은실제명령/주입/파일안전,tests/fixture지침은수락경계관찰,tooling/test-changed는SQL/자식경로선정,현행schema의기존시험기대는41연결이다. Code Map과Execution에구체경로를남겼다.
- review: 독립Sol medium4렌즈R1과safety/coverage R2/R3,coverage R4,원시교정R5. R1은21개(고4/중15/저1/false1),R2중9,R3중1,R4신규0,R5보고표현저1. 각finding triage와그룹별수정·후속개별해결근거는위로그/로컬원문보존. IA1은8.3연결/OAuth분리로주입dispatch허용, BH1은8.5증분명시범위, BH8은별칭관계추가복잡성대비저위험이라기각했다. 나머지는해당Execution으로교정/검증했다. deferred는빈목록.
- followup_review_recommended: false. 마지막실질코드/fixture교정은R5가각실패처분/관련통과로확인했고,보고표현1건은실제권한관찰범위(여섯표effective카탈로그+sources실제DELETE거부)로정정했다. 이후제품수정없음. changed최종통과증거를지휘자가대조했다.
- verification: 개발/리뷰중시험미실행·build/typecheck/diff체크. 최종전체TS1/Python0의최초실패를보존하고최초29실패와추가planner1을교정,관련303건파일별최종통과및changed3단계종료0. 전체TS성공으로원시실패를덮어쓰지않는다.
- operator_actions: 현재8.2필수운영자입력없음. 실제Drive/OAuth/나머지sources명령·설정·예약은8.3/8.8인계이며이번일반설치CLI운영연결완료를주장하지않는다. release/ref변경없음.
- 잔여위험/후속: changes소비/스캔중원격변화정합·전체재시작/8.1submitting·keep_local_days변경은8.5,PDF/docx는8.4,문서집계/점수/폴더API와shortcut별칭전체보존은이번미지원이다. 동일target shortcut은첫이름/경로로dedup한다. preparing/open/DB불명임시bytes는소유/작성자종료가확인될때까지보수적으로보존한다. planner검사는행폭이큰합성부하의접근경로이며모든실제분포의계획/성능을보장하지않는다.
- 자원/증거: 자기시험PG/fixture/home/cache/venv/temp는정확ID로정리·부재확인,워크트리/로컬·원격티켓branch/지휘·구현세션/원시증거는보존한다. raw로그·보고/영수증은gitignored로컬에만있고공개commit에넣지않는다. branch commit/push/정확remoteSHA와clean확인은지휘자최종로컬보고에기록한다.
