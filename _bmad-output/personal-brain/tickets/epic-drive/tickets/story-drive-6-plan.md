---
title: '8.6 첨부와 Drive 문서 찾기 통합'
type: 'feature'
ticket: 6
created: '2026-11-09'
status: 'built'
baseline_revision: '8839c35408cbd02e07d2d6b62ebd848cdb03e4ca'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md
  - _bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml
  - .brain-automation/tickets/8.6/independent-spec.md
  - .brain-automation/tickets/8.6/investigation.md
warnings: [oversized]
deferred:
  - summary: >-
      수락19.8 실행기록의 이미 알려진 일반 sk- API키 형태 가림 누락; 중앙이 원소유자 최소후속을 배정함.
    evidence: |-
      R2 BH3: tooling/test-changed/record.mjs credentialShape가 일반 sk- 뒤16자 이상 형태를 제외하지 않으나 core SECRET_PATTERNS는 이를 인식한다. 8.6 신규변경이 아닌 수락incoming 기존문제다. 중앙 msg_e888ea0e933e가 정적 확인하고 원19.8 지휘자에게 record.mjs와 전용회귀만 교정을 배정했다. 임의불투명문자열 일반한계와 구별한다. 수락source 통지 후 정상경계에서 통합·해결근거를 추가한다.
      해결: 중앙 msg_0233f5c9fa92가 source def615ae783c14b67dd6832a0f879c372272e431의 교정·독립확인·관련38pass와 수락main a5d40c60614b764f2530f5ec69a12c866c583469를 인계했다. R3 종료경계에서 해당main을 정상fast-forward 통합하고 정확record helper 변경과전용회귀를 대조했다. 기존항목은이력보존하며 현재미해결이아니다.
    location: >-
      tooling/test-changed/record.mjs:9
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 일반 첨부 본문과 file_names 질의가 문서 검색에서 빠지고, 같은 내용의 Drive 출처가 결과 상한을 중복 소비한다. 이름·본문·원본을 한 검색으로 찾고 미색인 사유를 구별해야 한다.

**Approach:** 기존 문서 질의에 첨부 본문·이름과 Drive 이름을 결합하고, 권위있는 내용 정체성·정확 추출세대·locator로 본문 hit를 limit 전에 합친다. typed origins[]로 모든 유효 원본 링크와 개별 상태를 보존하며 기존 SDK/CLI/show/가림 코덱을 소비한다.

## Boundaries & Constraints

**Always:** schema44와 0001~0044 바이트 불변. 같은 snapshot에서 가림·권한·유효원본 필터 후 집계·정렬·limit을 계산. 다른 file/세대/locator는 합치지 않는다. 이름-only는 실제 file/source identity로 구별하며 null끼리 합치지 않는다. 본문 hit가 있으면 중복 이름행은 제거하되 이름·원본은 보존. report provenance와 현재 세대 전체문맥 가림·budget/next·SDK 봉투를 유지. 실제 source 행을 이름 정본으로 써 rename/move의 옛 복사본을 만들지 않는다. source별 불가·stale·상태는 다른 정상 원본과 보존본문을 오염시키지 않는다.

**Never:** 본문문자열·이름만으로 dedupe, 임의 URL/내부 remote ID 공개, 새 가림 함수/출력 우회, chunk/tool 점수·SQL·22.3 oracle 변경, Docs heading/R16/D9·새 folderCLI/D12 필터·새 점수/R14·별도 meta.documents[] 추가, plugin release, 실계정/운영DB/공용54329 사용, 중앙 main/state 변경. 19.1 fixture.ts/pg-home/test-db 준비와 19.8 test-changed 영역 편집 금지. 새 DDL 필요시 중앙0045 예약 질문 전 생성 금지.

## I/O & Edge-Case Matrix

| ID | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| M1 | 같은 PDF 첨부+Drive, 동일 세대/쪽 | 본문 hit 하나, local·Drive 링크 두 개; 다른 쪽/파일/세대는 유지 | 이름/문자열 유사성만으로 합치지 않음 |
| M2 | 첨부 본문·표시명·external 경로 각각만 일치 | 한 검색으로 찾고 쪽/글자 위치 유지; 이름-only show도 실제 상태 반환 | 미색인 locator 조작 금지 |
| M3 | Drive 사진/큰/unsupported/pending/failed | 폴더·파일명 검색, nullable file/locator, 정확 상태·사유 | source_unreachable 별도 유지 |
| M4 | rename/move sync | 새 이름·경로 양성, 옛 이름 음성, 현재 source 정본 | 기존 동기화 fence/공유 provenance 보존 |
| M5 | 가린 첨부와 같은 content의 Drive 항목 | 본문/이름/경로/링크 검색 및 files.show 비노출, sync로 부활 안 함 | 현재 redaction 재검증 |
| M6 | 공백, a-b, AND, 따옴표, %, _, 역슬래시 | 모든 본문/이름/경로 branch에서 독립 전수 literal LIKE oracle과 일치 | 오류/조용한 누락 금지 |
| M7 | 여러 원본/locator, limit1·has_more·report | 중복 원본은 상한 미소비, 실제 다음 hit만 has_more, report provenance/동률 결정적 | 원본수 점수 가산 금지 |
| M8 | 정상+불가/stale 원본, 잘못된 remote/삭제 location | 개별 warning/상태, 검증된 기존 resolver 링크만 | 전체 불가로 오염/가짜 링크 금지 |
| M9 | 중첩 origins 이름·경로·URL/report에 합성 비밀, 큰 origins | 기존 typed probe·모든 renderer·SDK/CLI JSON/text에서 가림, budget/next/show 유지 | 필수 두 링크 조용한 유실/크기 우회 금지 |

</intent-contract>

## Code Map

정적 조사 보고서는 context에 있다. 연구의 옛 report-only 상태는 현재 코드와 재대조했다. 선행8.5 source ed915a226b26f7e14dda67003c0a94b8706399c8 수락/원격main 반영을 인계받았다.

- `packages/core/src/ports/document-recall-store.ts`: DocumentRow/SearchRow와 SourceDocument. 공개 origin과 내부 remote/location 참조 타입을 분리한다. 필요한 root export도 연결한다.
- `packages/postgres/src/recall.ts`: searchDocuments의 all_rows/candidates/context만 확장. file_names/text_raw 및 report provenance를 보존한다. 단일 snapshot에서 본문·이름 후보와 원본 집계를 수행한다. 바로 위 searchRecall SQL은 읽기 전용.
- `packages/core/src/testing/fakes/store.ts`: PG와 동등한 후보·가림·정체성·상태 의미.
- `packages/core/src/recall/documents.ts`, `brain.ts`: searchDocuments/showDocument와 FileStore 라우팅 재사용. local URL은 유효·미삭제·소유권 확인된 기존 위치/port로 해석하고 Drive는 기존 driveSourceUrl. 내부 ID를 public으로 spread하지 않는다.
- `packages/postgres/src/{attachments,sources}.ts`, `core/src/files/file-names.ts`: file_names는 첨부/external local 파생, source name/path는 sync가 교체하는 정본. Drive 파생 복사를 추가하지 않는다. 기존 가림/source fence 유지.
- `packages/core/src/output/{codecs,mask}.ts`, `apps/cli/src/commands/{recall-docs,files-show}.ts`: typed documents probe 확장과 실제 renderer를 연결. 별도 마스킹 구현 금지.
- core `document-recall`, `source-document-recall`, `output-codecs` 시험, PG `document-recall.test.ts`, CLI `document-commands`, `output-codecs`, `drive-source-tracer` 및 `fixtures/fake-drive.ts`: 외부 표면·실제 fake HTTP·독립 oracle 재사용. fixture.ts/pg-home.ts는 읽기 전용.

## Tasks & Acceptance

**Execution:**
- [x] E1 저장소 계약 — core document-recall-store 타입/root exports와 PG recall.ts/fake store — 일반 첨부 본문·file_names/source 이름 및 유효 원본의 단일snapshot 집계/정렬/limit/context, report provenance, redaction, 이름-only 상태를 구현하고 core/PG 계약 시험 작성(M1~M3/M5~M8). 내부/공개 origins 타입을 구분한다.
- [x] E2 공개 조회 연결 — core documents.ts/brain.ts와 필요한 기존 FileStore/Store 조회 port·SDK/CLI 조립 — 유효 원본 링크 해석, legacy 대표필드 관계, per-origin 상태, 이름-only files.show/next·원문/locator 가림을 연결. core/CLI document commands와 fake Drive tracer 시험 작성(M1~M5/M7~M9). E1의 아직 연결 안 된 내부 타입은 여기서 완결한다.
- [x] E3 출력·행렬 완결 — 기존 typed output probe/renderer·core/CLI codec 시험과 관련 PG/Drive tracer 시험 — 중첩 이름/경로/링크/상태/report 비밀, 7질의 전수 oracle, rename/move sync, 가림 후 sync/후속show, limit/budget/다른locator/두원본 보존을 확인하는 시험 코드를 완성한다. M1~M9와 원문verify를 파일·시험명으로 매핑한다.

- [x] E4 R1 저장소 재도출 — 보존패치 KEEP 부분을 재사용하고 core port/PG recall/fake와 관련 core/PG 시험을 교정한다. BH2~8/VG2/EC-old2~4/IA-A,F: 적격성 공통화, Drive-only 대표명/source 복원, 정확 file/extraction/locator로 limit전 한hit(그 위치의 모든 일치조각은 전체문맥 가림 뒤 본문 보존), 정상원본이 있으면 전체불가 금지, names[]의 정확별칭 보존과 권한필터. 동일locator 여러 조각+다른locator, 이름A/B, 참조없음/잘못된source, mixed origin 순서불변 회귀 작성.
- [x] E5 R1 원본 resolver 재도출 — core brain/documents와 실제 SDK/CLI 조립 시험. BH1/VG1/EC-old1/EC1/IA-B: FILES_UNAVAILABLE의 원격접근실패는 해당 origin만 불가 상태로 보존, 가림/DB오류는 별도 안전 실패. Drive 미연결·root불일치·url실패로 보존리포트/정상결과 전체를 잃지 않으며 URL대기중 위치삭제/가림은 재확인한다. names[]가 공개 가림/budget을 통과하도록 연결하고 내부참조 비노출 유지.
- [x] E6 R1 공개 검증 재도출 — 실제 공개타입을 소비하는 기존 typed probe/양성단언·SDK/CLI JSON/text/show 및 PG/fake oracle/Drive tracer. BH9~10/IA-C~E와 names 승인 matrix를 완성한다. file/extraction/locator 정확hit 다중집합, external 경로·연결source명/경로·Drive본문·7질의·새부모 move·모든상태·중첩 실제비밀/대형names를 포함하며 원문verify→시험명 matrix를 갱신한다. 시험 실행 금지, 컴파일 확인만.

- [x] E7 E6 시험표면 완결 — `apps/cli/test/drive-source-tracer.test.ts`의 SDK/CLI7질의 oracle corpus를 source-only에서 첨부본문·표시명·유효 external표시경로·file연결 Drive본문/이름/경로 및 source-only로 넓힌다. 정확 file/extraction/locator와 name identity 정렬배열을 독립 전수LIKE에 대조, 충분한limit·한fixture로 구성한다. PG source identity 시험의 Unicode별칭 기대는 실제 그시험에 삽입한 데이터와 동일해야 한다(다른시험의 별칭을 기대하지 않음); 별도 A/B 보존시험 단언은 약화하지 않는다. 외부표면준비를 위한 합성 DB행/fake는 허용하되 새로운 제품코드/계약 확대 금지. 시험 실행 금지, 컴파일 확인만.

- [x] E8 R2 조회 재도출 — 보존patch KEEP를 복구하고 PG/fake의 공개안전 source선별을 기존 driveSourceUrl로 동일읽기snapshot에서 limit전에 적용한다. 형식은맞지만 비밀패턴인ID/정상동반원본/뒤정상후보/고아source를 교정하고 source-only·본문·이름의같은필터를 보장한다. core documents의 확장메타선택은 extension report source를 Drive원본유무와 독립화한다. PG/fake/SDK report메타/limit 회귀작성, 신규DDL/가림함수/점수변경금지.
- [x] E9 R2 원본상태와 시험완결 — brain resolver는 로컬brain 실제존재/저장불가를 정확하게 반영하고 다른정상origin/보존본문을 유지, external은 기존 허용경로/저장상태계약을 유지한다. 실제 createBrain/SDK/CLI에서 missingbytes와정상Drive home/root/URL·external정확링크·연결미색인상태+보존세대·공유disconnect단일hit를 검증한다. text fixture는요청모드에따라파싱하며 기존JSON·show/redaction/비밀단언유지. 개발중시험실행금지,컴파일만.

- [x] E10 R3 최소교정/원문감사 — `core/src/brain.ts`의 위치before/after 무효반환을 원본불가로표시해 유일위치삭제가 전체가용으로되돌아가지않게 최소교정하고 실제createBrain 단일origin 삭제장벽회귀를작성한다. `apps/cli/test/drive-source-tracer.test.ts`의 기존 fakeDrive rename시나리오에 파일자체name변경→sync→새명양성/옛명음성·대표명새값을명시해 폴더rename만으로 원문verify를대체하지않는다. 기존show/redaction/정상동반origin단언보존,시험금지/컴파일만.

**Acceptance Criteria:**
- Given 같은 PDF 첨부와 Drive의 합성 원본, when SDK/CLI recall docs와 후속 files show를 호출, then M1~M9의 원본·위치·상태·가림·정체성 관찰이 일치한다.
- Given 7 literal 질의와 충분한 한도의 합성 corpus, when 공통 문서 검색, then 각 이름/본문/경로 표면이 독립 전수 LIKE oracle의 identity 집합과 같다.
- Given 마지막 구현·독립후속이 완료, when 격리 자원에서 전체 TS→Python을 순차 각1회 실행, then 최초 결과·실패처분·관련 재검증과 matrix 실행 증거가 보존되며 필수 미해결이 없다.

## Implementation Notes

E1: PG 단일snapshot 본문/이름 hit와 internal_origins를 구현하고 core/PG 계약 시험 코드를 작성했다. build/typecheck/diff 종료0, 시험 미실행. report 우선·location ID 후 source ID 원본 순서다. E2 전에는 내부 필드가 기존 spread에 남는 중간 상태이며 배포/완료로 취급하지 않는다. E2가 public origins 변환·내부 필드 제거·이름-only show를 연결한다. 최종 리뷰에서 PG/fake 대상 적격성, legacy 대표 필드·per-origin 상태, 같은 locator 중복과 모든 이름 보존을 대조한다. 기존 PG 공개 다중source 단언은 내부집계 단언으로 옮겨졌으므로 E3에서 공개 origins/두 링크 검증을 반드시 복원한다.

E2: 공개 결과에서 internal_origins/remote/location 참조를 제거하고 검증한 기존 resolver 링크와 개별 origins 상태를 연결했다. 이름-only 파일 show는 현재 snapshot 가림/상태를 확인한다. SDK·CLI/fake Drive 합성 text 이중원본 시험 코드를 작성했다. build/typecheck/diff 종료0, 시험 미실행. PDF·oracle·probe·sync/budget 행렬은 E3에서 완성한다.

중앙 msg_f43e804290fd에 따라 E2 종료 뒤 수락 main `7b09aead25094304f8aee9359899a69fc477a932`를 정상 fast-forward 통합했다. 원본 baseline 불변. incoming9파일은19.8 best-effort 실행기록/helper/시험/문서·ignore이며8.6 파일/DDL과 겹치지 않는다. 선택·명령·exit 의미 보존, rules 불변. test-changed 추가 전체 반복 없이 최종 전체회귀에 신규 회귀를 포함하며 독립 review에서 incoming 영향도 확인한다. 후속19.9 rules는 별도 소유다.

E3: typed documents probe와 실제 네 renderer의 중첩 이름/경로/링크/상태/report 필드를 기존 가림 경로에 연결했다. 합성 PDF 실제 첨부+Drive/쪽/show/redaction/sync, 사진 폴더 rename, 일곱 리터럴 전수LIKE oracle, limit/locator/원본 상태/budget 시험 코드를 작성했다. 원문verify→시험명 matrix는 `.brain-automation/tickets/8.6/e3-result.md`에 보존한다. build/typecheck/diff 종료0, 시험 미실행. 독립리뷰 뒤 최종회귀에서 실제 행렬 실행을 감사한다.

E4: 보존14파일을 복구하고 적격 source/name/관계 집합, Drive 대표명/source, 정상 원본이 있으면 전체가용, 정확 names[]/권한위치 연결, file/extraction/locator별 ordinal 집계와 기존 최대조각점수 정렬을 구현했다. PG/fake/공통문맥 투영 회귀 작성, build/typecheck/diff0, 시험 미실행. E5가 legacy warning과 resolver를 완결하고 E6가 전체행렬을 완성한다.

E5: Drive 미연결/root불일치/원격URL실패를 origin별 불가로 보존하고 DB/가림을 별도 실패로 처리했다. URL 성공/실패 뒤 위치 재검증, 전체불가 warning 분리, 실제 createBrain 장벽 및 SDK/CLI/큰names 시험 코드를 작성했다. build0, 첫 typecheck1(시험fake 타입) 교정뒤 최종0, diff0, 시험 미실행. 조사포함 6 Task를 완료한 첫 구현 워커는 정식 succeeded 뒤 worker-release closed_agent_terminal로 정리하고 E6은 새 Terra medium으로 교체한다.

지휘자 정적 대조 C1: E4의 일반 본문투영이 `position.start + position.trim`을 모든 검색hit에 적용해 앞선 비일치 text조각과 겹치는 일치조각의 앞부분을 제거할 수 있다. 원래 검색은 각 hit의 전체 위치를 투영했다. E6의 기존 문맥/locator 호환 회귀대조에서 앞조각 비일치·뒤조각 겹침부에만 질의가 있는 입력으로 검색본문이 실제 일치부분을 잃지 않는지 확인하고 최소교정한다. 실행재현 금지, 코드/시험으로만 확인. same-locator 그룹 내 중복제거와 다른 locator 전체범위를 혼동하지 않는다.

E6: 실제 DocumentRow 기반 probe/비밀음성·안전별칭양성, C1 선택locator내 중복투영 교정과 회귀, 정확locator PG oracle/external·연결source corpus 및 SDK/CLI source-only oracle, move/상태/show/중첩비밀 시험 코드를 작성했다. build/typecheck/diff 최종0(시험query 타입 첫실패 교정), 시험미실행. 지휘자 감사에서 SDK/CLI7질의 corpus는 source-only여서 E7로 외부행렬을 완결하고, PG source시험의 별칭4개 삽입 대비 다른시험의 별칭2개를 더 기대하는 단언을 올바른 입력으로 교정한다. 원문 수락기준을 약화하지 않는다.

E7: 한 격리fixture의 모든 지정 검색표면·7질의·정확identity 다중집합을 SDK와 CLI 실제결과에 독립 전수LIKE로 대조하도록 확장했다. PG 별칭 기대는 실제 4개삽입에 맞췄으며 별도 A/B 유실/권한위치 부정단언은 보존했다. build/typecheck/diff0, 시험미실행. E4~E7 실제 수정으로 R1을 해소했는지 네렌즈 독립후속에서 확인한다. 0044 hash는 승인값 ba31747c34b80f435ed1a3781bb54866200196e0c64f161039e6098f430dae3c와 일치한다.

E8: R2 보존15파일을 복구하고 read-only repeatable-read 동일snapshot의 source ID 선별→기존 Core driveSourceUrl 안전판정→후보SQL 전체분기에 같은적격ID를 적용했다. 새로운가림술어·외부I/O·DDL 없이 limit전부적격제외/정상동반원본/첨부report유지를 연결했다. report_provenance 내부플래그를 공개에서 제거하며 확장메타를 원본유무와독립화했다. PG/fake/SDK의동시snapshot·limit·고아·안전ID·report회귀작성, build/typecheck/diff0, 시험미실행.

E9: brain위치의 실제 FileStore.exists 확인뒤 URL, 로컬 저장불가 전후 재검사, 정상동반원본/보존본문유지를 연결했다. 실제 SDK/CLI의 정상Drive home/root/exists/url·external정확링크·연결된모든미색인상태+보존세대·공유disconnect단일hit 및 요청모드별fixture파서를 교정하고 해당회귀를 작성했다. 기존source show/redaction/가림단언보존, build/typecheck/diff0, 시험미실행. R3 독립후속뒤 최종전체TS→Python과 행렬실행감사를 한다.

R3: 단일무효위치의 상태전달누락1개root는명시된기존접근상태계약의최소patch(E10)로교정한다. 새공개surface/DDL/점수/가림정책없음. 원문verify감사에서폴더rename과별도로파일자체rename의새/옛양음성도기존fakeDrive시험에명시한다. 이는새요구아닌원문관찰보완이다. 수락19.8후속 a5d40c60614b764f2530f5ec69a12c866c583469는R3종료뒤정상통합,기존deferred에원문증거+해결근거를함께보존했다. 제품/codec/rules불변incoming4파일영향은최종독립확인과전체회귀에포함한다.

E10: 위치사전/사후무효시명시적불가를반환해단일원본전체불가와정상동반원본가용성을보존한다. 실제createBrain의단일/혼합origin 삭제장벽회귀와fakeDrive파일자체rename→sync→SDK/CLI새명·대표명양성/옛명음성관찰을작성했다. build/typecheck/diff0,시험미실행. R4는이최소patch와수락19.8후속incoming의독립해결확인이며새전체리뷰가아니다.

## Plan Change Log

R2 bad_plan: 적격원본의 공개안전판정과 SQL형식필터 불일치·리포트메타·로컬존재상태·성공경로시험을 E8/E9로 구체화한다. 제품15파일 diff를 `.brain-automation/tickets/8.6/r2-implementation-preserved.patch`에 보존하고 정확소유파일만 HEAD로 되돌린 뒤 KEEP 재사용/교정한다. KEEP는 R1의 모든 양성동작·원문수락행렬·names승인·비밀/예산/locator/fence를 포함한다. 단일snapshot은 read-only repeatable-read의 동일snapshot에서 기존 Core resolver로 source적격성을 읽어 후보SQL에 적용하는 방식도 허용하며 외부I/O/새가림술어 복사 없이 한다. 부적격원본은 limit전에 제외하되 정상동반원본·report/attachment는 유지한다. 빈적격집합/DB실패/동시변경 회귀로 그 의미를 고정한다.

R2의 성능/추가faultfixture 제안6건은 위 triage근거로 미채택이며 필수결함을 성능제안으로 숨기지 않는다. 19.8의 알려진가림누락1건은 중앙원소유후속으로deferred, 현재8.6완료선행gate가 아니다. IA 표의 기타 증거한계는 새구체결함으로 주장되지않았으며 기존전체시험 실행감사와 구별한다.

R1: 구현이 행/원본 정체성·장애격리·전체별칭/typed probe를 충분히 구체화하지 못했다. 공식 bad_plan 분기로 현재 제품diff를 `.brain-automation/tickets/8.6/r1-implementation-preserved.patch`에 저장하고 제품14파일만 HEAD로 되돌린 뒤 E4~E6으로 재도출한다. 원본baseline과 수락19.8 incoming은 유지한다. KEEP: 전체문맥 가림·단일snapshot·report 최신 provenance/기존점수·source정본 rename·내부/공개원본 분리·실제 FileStore 소유/삭제 앞뒤검사·이름-only show·PDF/source tracer·기존시험 단언을 보존한다. 보존패치의 올바른 부분은 재사용하되 알려진 결함 상태로 복귀시키지 않는다. E4~E6은 같은 계약을 다시 도출하는 작업이며 다른기능 확장이 아니다.

중앙 msg_3d19083416e3는 기존 이름보존 결함을 교정하는 typed names?:string[]만 추가 승인했다. 적격 file_names의 모든 정확표시명/external표시경로를 동일snapshot에서 결정적 순서·정확문자열 중복제거로 보존한다. 대소문자/Unicode 정규화로 이름을 합치지 않는다. source이름은 origins에만 둔다. names는 표시메타이며 URL/조회권한을 대신하지 않는다. 가린file·권한없는위치·raw bytes 제외, 전체 가림/budget/SDK/CLI/probe·대형메타 오류검증 포함. intent-contract의 기존 이름정보 보존을 구현하는 최소 구체화다.

## Review Triage Log

### 2026-11-09 — Review pass R3
- verdicts: 11 findings — high 0, medium 3, low 8, false 0, maybe-false 0
- findings:
  - `R3-BH1` `[medium]` `[patch]` 유일위치 삭제후 snapshot가용성 유지 — brain invalid위치 반환에불가상태 누락;E10에서before/after 무효위치 표시와단일origin 회귀교정.
  - `R3-BH2` `[medium]` `[defer]` 알려진sk 기록가림누락 — carried R2-BH3;중앙수락source def615ae783c14b67dd6832a0f879c372272e431/main a5d40c60614b764f2530f5ec69a12c866c583469 통합으로해결,새deferred추가안함.
  - `R3-BH3` `[low]` `[reject]` 19.8 Unicode경로 관측정보 손실 — ASCII보수적가림은알려진안전한계,선택/실행손상아님;새Unicode/비가역ID정책복잡도미채택.
  - `R3-BH4` `[low]` `[reject]` 19.8 Unicode ref SHA미관측 — best-effort null을명시하고실행불변,새ref해석정책복잡도미채택.
  - `R3-BH5` `[low]` `[reject]` 동일원본 반복해석 — carried R2-BH4;실측/정확성결함없이cache/최종재확인복잡도증가.
  - `R3-BH6` `[low]` `[reject]` limit전 전체메타구축 — carried R2-BH5;성능창/실측위반없고재작성복잡도높음,공개안전필터유지.
  - `R3-BH7` `[low]` `[reject]` 상태only show 본문조회 — carried R2-BH6;새경량포트추가복잡도대비정확성결함없음.
  - `R3-BH8` `[low]` `[reject]` 가변ref와기록SHA차이 — 기존runner실행의가변ref동작이며19.8 best-effort가관측시점SHA를기록;새단계별관측정책복잡도대비입증결함없음.
  - `R3-BH9` `[low]` `[reject]` list JSON실패추가시험 — carried R2-BH8;runnerfail/childexit구분명시,고장근거없는faultfixture추가미채택.
  - `R3-BH10` `[low]` `[reject]` 19.8 stdout/stderr baseline비교추가 — 출력변경실재근거없고fixture값정규화복잡도추가,수락incoming의선택/명령/exit불변증거보존.
  - `R3-EC1` `[medium]` `[patch]` 단일위치 무효화후불가경고누락 — BH1과동일root,최소상태전달교정과공개SDK회귀.
- verification-gap: 신규0, 검사실패없음. intent-alignment: 명백한의도위반0, 검사실패없음. 설명된합성시험/실행증거한계는최종검증과구별한다.

### 2026-11-09 — Review pass R2
- verdicts: 15 findings — high 0, medium 9, low 6, false 0, maybe-false 0
- findings:
  - `R2-BH1` `[medium]` `[bad_plan]` 미삭제 위치 존재가 저장된 로컬 불가 상태를 지움 — FileStore.url은 존재를확인하지 않음; E9에서 실제존재·저장상태와 원본별 접근을 구별.
  - `R2-BH2` `[medium]` `[bad_plan]` Drive결합 리포트 확장상태 메타 누락 — !source_file_id 필터가 실제extension source를 제외함; E8에서 출처종류와 원본유무 독립화.
  - `R2-BH3` `[medium]` `[defer]` 수락19.8 알려진sk API키 가림누락 — 정적확인/중앙 msg_e888ea0e933e 원소유자후속; 단일deferred에 보존,8.6직접수정금지.
  - `R2-BH4` `[low]` `[reject]` 같은 원본 해석의 반복조회 비용 — 정확성 실패/실측지연 근거없고 캐시+최종검사 복잡도추가;성능창없음,보존정책 변경안함.
  - `R2-BH5` `[low]` `[reject]` limit전 전체 메타 구축 비용 — 정적비용 제안이나 허용성능위반 미관측;후보/정체성/fence를 바꾸는 재작성 복잡도대비 미채택.
  - `R2-BH6` `[low]` `[reject]` 이름-only show가 전체pieces 조회 — 성능개선 제안이며 결과정확성 결함없음;새projection/공개옵션 복잡도추가 미채택.
  - `R2-BH7` `[low]` `[reject]` 후원본 대기중 선원본 삭제의 마지막재검사 — 각resolver가 자기 검증시점에 선형화하며 전체DB snapshot을 response시점으로 잠그는 계약없음;비동기후 즉시변경은 언제든가능,집합잠금/추가pass복잡도 미채택. 파일가림은 이후resolver의 동일file 재확인으로 별도차단.
  - `R2-BH8` `[low]` `[reject]` 19.8 malformed list출력 추가시험 — 문서가 child성공과 runner실패를구별하고 실제고장근거없음;별도incoming 검증제안,중앙기각처분동의.
  - `R2-BH9` `[low]` `[reject]` 19.8 첫snapshot실패후복구 추가시험 — best-effort 다음snapshot재시도 구조상손상근거없음;새faultfixture복잡도 대비낮음,중앙기각처분동의.
  - `R2-BH10` `[medium]` `[bad_plan]` file연결 미색인source+보존본문 시험누락 — 별도union/상태조합 실제가능;E9에서모든상태의 이름/show·보존본문검증.
  - `R2-VG1` `[medium]` `[bad_plan]` disconnect 공유시험의 옛별도행 단언 — preverified;새origins단일hit·전체정상·source별warning으로 교정,후속show/redaction보존.
  - `R2-VG2` `[medium]` `[bad_plan]` Drive home 정상URL 공개경로 미검증 — preverified;root일치/exists/url성공 SDK원본링크·경고부재 회귀.
  - `R2-VG3` `[medium]` `[bad_plan]` external 경로의 공개URL 미검증 — preverified;기존SDK/CLI oracle witness에정확경로·가용상태 양성추가.
  - `R2-EC1` `[medium]` `[patch]` text출력에 JSON전용 fixture parser 적용 — fixture.cli 무조건JSON.parse 확인;args --json여부로파싱분리,가림 text단언유지.
  - `R2-IA1` `[medium]` `[bad_plan]` safe 원본판정 전 limit순서불일치 — SQL remote형식과 driveSourceUrl safe가다름;동일repeatable-read 읽기snapshot 안에서 기존resolver로 적격source를 선별하고 후보SQL에 적용,새가림함수/DDL금지.

### 2026-11-09 — Review pass R1
- verdicts: 23 findings — high 4, medium 19, low 0, false 0, maybe-false 0
- findings:
  - `BH1` `[high]` `[bad_plan]` 원본 링크 해석 실패가 전체검색 중단 — brain resolver와 documents 즉시return 확인; 개별 접근실패 상태화/DB·가림 오류 분리. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH2` `[medium]` `[bad_plan]` 첫 Drive 불가가 통합행 오염 — PG mapper/Core representative가 덮어씀; 전체 가용성과 대표 source 상태 분리. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH3` `[medium]` `[bad_plan]` Drive-only source가 attachment로 퇴행 — coalesce report/attachment 고정 확인; 실제 관계기반 대표 source 복원. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH4` `[medium]` `[bad_plan]` Drive-only 대표명이 UUID — source명 미복사와 name fallback 확인; 현재 결정적 source명 사용. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH5` `[medium]` `[bad_plan]` 검색된 두번째 첨부별칭 유실 — file_names EXISTS 대 첫name출력 확인; 중앙 msg_3d19083416e3 names[] 승인. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH6` `[medium]` `[bad_plan]` 같은 세대/locator 복수chunk 중복 — extractor가 같은 PDF쪽을 여러 ordinal로 생성; limit전 정확locator 집계와 본문 보존. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH7` `[medium]` `[bad_plan]` PG/fake 검색 적격성 불일치 — fake 모든files 대 PG 관계필터 확인; 참조없는 파일과 유효관계 공통 계약 교정. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH8` `[medium]` `[bad_plan]` 잘못된 source만 가진 본문 후보 — body EXISTS의 remote검증 누락 확인; 유효source 집합 재사용. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH9` `[medium]` `[bad_plan]` probe가 실제 공개 문자열 필드 일부 미검증 — 가짜report 대신 source/report_date/versions/names 타입·양성출력 연결. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `BH10` `[medium]` `[bad_plan]` oracle locator/external 경로 검증 부족 — file Set로 locator누락 은폐; 정확hit키와 external/연결source/외부표면 확장. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `VG1` `[medium]` `[bad_plan]` URL대기중 location삭제 재검증 시험 없음 — 검증공백 preverified; 실제 createBrain 장벽과 최종 origin 비노출 회귀 작성. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `VG2` `[medium]` `[bad_plan]` Drive 대표표시명 기존시험과 충돌 — tracer 새이름.txt 단언과 UUID fallback 대조; BH4와 같은 교정. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `EC-old1` `[high]` `[bad_plan]` 개별 location실패 전체전파 — 절차상 failed 원문도 보존; 독립재검사EC1과 코드로 재확인. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `EC-old2` `[medium]` `[bad_plan]` 동일locator hit중복 — 절차상 failed 원문 보존; extractor 분할과 hit ordinal로 재확인. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `EC-old3` `[medium]` `[bad_plan]` 첨부별칭 유실 — 절차상 failed 원문 보존; BH5와 동일 실재 근거. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `EC-old4` `[medium]` `[bad_plan]` Drive source라벨 삭제 — 절차상 failed 원문 보존; BH3와 동일 실재 근거. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `EC1` `[high]` `[bad_plan]` 기존 Drive리포트의 원격실패 전체전파 — 새 독립검사 완료; 보존본문이 링크I/O 실패에 종속됨을 확인. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-A` `[medium]` `[bad_plan]` 대표 source/전체 가용성 계약차이 — BH2/BH3과 같은 반환경로; 기존 source/provenance·통합가용성 보존. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-B` `[high]` `[bad_plan]` 원본 상태와 실패격리 차이 — BH1과 같은 즉시실패; 정상결과 보존하도록 교정. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-C` `[medium]` `[bad_plan]` 7질의 oracle의 표면 축소 — 연결source·external·정확locator·SDK/CLI 관찰 보강. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-D` `[medium]` `[bad_plan]` typed probe와 실제 recall/show 가림 증거차이 — 실제 공개문자열과 CLI JSON/text 합성비밀·양성출력 연결. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-E` `[medium]` `[bad_plan]` move·상태 외부행렬 증거차이 — 새부모 이동의 새/옛경로 및 상태별 이름/show 보강; 별도첨부인입재작성은 요구하지 않음. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.
  - `IA-F` `[medium]` `[bad_plan]` 검색가능별칭과 표시별칭 집합차이 — 중앙 names[] 승인으로 해석 확정, 새 surface 최소추가로 해당이름 보존. 아래 R1 재도출 E4~E6으로 교정 후 독립 후속 확인.

## Design Notes

중앙 msg_bffca34815a3가 최소 typed origins[] 계약을 승인했다. 결정적 대표행은 기존 report provenance를 우선 보존하고, 동일 조건에서 기존 정렬키와 안정 identity를 따른다. legacy source_*는 대표 source origin에 대응하며 origins 전체상태를 대체하지 않는다. 원본수로 점수를 더하지 않는다. 구현자는 정확 대표행 규칙을 코드/시험/보고에 명시한다.

R5는 필수 hit집계만 채택, R6은 본문+이름 동일질의만 채택. 새 meta.documents[]·이름 점수/R14 미채택. R16/D9 heading과 D12 새 folder인자 미채택. D1~D8/D10~D11의 오류분류·목록완주·shortcut·지문·크기·임시수명·성공 publish는8.5 인계를 보존하며 재구현하지 않는다. 실제 source 정본을 질의하여 rename/move의 옛 파생값 잔존을 막는다.

## Verification

개발·리뷰 수정중 시험 실행 금지, 컴파일 확인만: `pnpm build`, `pnpm typecheck`, `git diff --check`. AC시험은 계속 작성한다. build/typecheck는 순차 실행하고 의존성 다운로드 필요 명령은 처음부터 require_escalated로 실행한다.

마지막 실질 수정과 필요한 독립 Sol medium 네렌즈/후속 뒤, 커밋·push 전에 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 순차 각1회. 최초 실패/중단도 UTC·exit·원시·환경/source/config와 보존, 교정뒤 관련 시험 및 `pnpm test:changed -- 8839c35408cbd02e07d2d6b62ebd848cdb03e4ca`만 재검증. 전체/성능 자동반복 금지. 행렬의 실제 실행/미skip을 최종 감사한다.

전용 PG/role/HOME/외부TMP/venv·fake Drive·합성문서만 사용. PG 관리자암호 postgres, genuine OrbStack status 한 인자 한정 위임/제한PATH·실제 private Docker context/Compose를 사전 정적 확인. DOCKER_HOST override 거부와 공용자원 금지. 19.5 runner 자식 ignored job scratch와 실제 외부 부모 TMP를 구별하고 장부를 보존, 공통 runner 편집 금지. 개발중 PG생성/시험·재현·list/eval 금지. 실행관측 추가 필요시 중앙 질문. 정확 자기 소유ID만 정리·부재확인.

지휘자가 최종 계획·diff·검증·review/후속·deferred/operator_actions를 정합화하고 built(인수done아님)·범위commit·자기branch 일반push·정확remoteSHA/clean을 확인한다. 중앙 run_eeb956b860e8에 ticket-result:8.6 보고. 중앙 main/state 변경 금지. 8.8 실계정/릴리스와8.5 결과불명삭제 operator_actions는 원계획 인계로 남긴다.

### 2026-11-09 — R4 해결 확인과 R5 incoming 확인

R4 독립 Sol medium 검토는 E10의 단일 원본 삭제 상태·파일 자체 rename·수락 19.8 가림 후속이 정적으로 해결됐음을 확인했고 새 지적은 0건이다. R5는 수락 19.9의 정확 `a5d40c6..d117f78` incoming 11파일과 8.6의 15변경경로를 대조했다. 정확 네 독립 시험만 Python broad 예외이며 8.6 혼합 변경의 전체 Python 선택과 hook raw 신원/공개 가림 분리에 충돌하는 지적은 0건이다. 두 검토는 런타임 성공을 대신하지 않는다. 원문은 `.brain-automation/tickets/8.6/r4-resolution.md`, `r5-incoming.md`에 보존한다.

## Auto Run Result

문서 검색은 첨부 본문·표시 별칭·external 표시경로·Drive 본문/이름/경로를 함께 읽는다. 같은 file·추출세대·locator의 본문은 limit 전에 한 결과로 묶고 검증된 모든 원본과 개별 상태를 `origins`로 보존한다. `names`는 정확 별칭을 표시하며 권한이나 URL을 대신하지 않는다. 이름-only 조회, 현재 rename/move 이름, report provenance, 기존 가림·예산·이어 읽기 계약을 연결했다.

최종 실행 증거의 독립 R6 감사는 새 지적 0건으로 완료돼 상태를 **built**로 기록한다. 사용자 인수 done과 구별하며 범위 커밋·자기 브랜치 push의 정확 SHA는 Git 및 최종 보고서에 남긴다. 원본 baseline은 `8839c35408cbd02e07d2d6b62ebd848cdb03e4ca`다. 최초 전체 회귀 source base는 `a5d40c60614b764f2530f5ec69a12c866c583469`, 종료 후 정상 통합한 관련 검증 source base는 `d117f7821ee56025f865076677975291ed45569f`다. 제품 15파일의 SHA-256은 최초 전체 실행 전후와 모든 후속 실행 뒤 동일하다.

### 변경 파일

| 경로 | 변경 |
| --- | --- |
| `packages/core/src/ports/document-recall-store.ts` | 내부 위치 참조와 공개 typed origins/names 계약 분리 |
| `packages/postgres/src/recall.ts` | 같은 repeatable-read snapshot에서 적격 source를 선별하고 본문/이름을 집계 |
| `packages/core/src/testing/fakes/store.ts` | PG와 같은 정체성·적격성·별칭 집계 |
| `packages/core/src/recall/documents.ts` | 공개 원본 변환·전체문맥 가림·본문 투영·report 메타·budget 연결 |
| `packages/core/src/brain.ts` | 실제 원본 존재/위치 검증과 원본별 장애 격리 |
| `packages/core/src/output/codecs.ts` | 문서 probe와 text 출력에 origins/names 및 provenance 포함 |
| `apps/cli/src/commands/files-show.ts` | 이름-only 문서의 실제 색인 상태 표시 |
| `packages/core/test/brain-drain.test.ts` | 실제 createBrain의 원본 장애·삭제 장벽·정상 동반 원본 회귀 |
| `packages/core/test/document-recall.test.ts` | 본문 집계·이름-only show·가림·메타 예산 회귀 |
| `packages/core/test/source-document-recall.test.ts` | source 정체성·이름/path oracle·부적격 원본 회귀 |
| `packages/core/test/output-codecs.test.ts` | typed 문서의 중첩 원본/별칭 probe |
| `packages/postgres/test/document-recall.test.ts` | 실제 PG의 집계·별칭·locator·literal oracle·snapshot 회귀 |
| `apps/cli/test/document-commands.test.ts` | SDK/CLI 문서 호환과 이름-only show |
| `apps/cli/test/drive-source-tracer.test.ts` | 실제 합성 PDF·Drive sync/rename/move·SDK/CLI oracle·가림·상태 |
| `apps/cli/test/output-codecs.test.ts` | CLI 문서 probe와 출력 가림 |
| 이 계획 | 승인 계약·리뷰 처분·실행 및 인계 증거 |

### 수락 행렬의 실제 실행

아래 시험을 포함한 지정 8파일은 최초 TS 전체 실행에서 **178 pass, 0 fail, 0 skip**이었다. 파일별 수는 core brain-drain 33, document-recall 25, source-document-recall 7, output-codecs 34, PG document-recall 7, CLI document-commands 7, drive-source-tracer 47, output-codecs 18이다. 전체 사례 이름과 상태는 `.brain-automation/tickets/8.6/acceptance-ts-execution.json`에 보존한다.

| 행렬 | 실행한 관찰과 대표 시험 |
| --- | --- |
| M1 | tracer `같은 PDF의 대화 첨부와 Drive 본문은 쪽 위치 하나와 두 원본을 표시한다`; 후속 show와 가림 포함 |
| M2 | PG `첨부 이름과 본문을 검색하고 같은 내용의 원본은 limit 전에 결합한다`; core 이름 결과 files show; tracer external 정확 링크 |
| M3 | tracer `모든 미색인 상태를 SDK와 CLI 이름 검색 및 show에서 보존한다`와 연결된 상태/보존 본문 시험 |
| M4 | tracer 폴더 rename·파일 자체 rename·새 부모 move의 새 이름/경로 양성과 옛 이름 음성 |
| M5 | tracer 원본 공유 뒤 redaction·sync와 후속 show; core 현재 가림 장벽 |
| M6 | PG 본문/첨부명/source 이름·경로 전수 LIKE oracle, tracer 모든 문서 표면의 SDK/CLI 7질의 oracle |
| M7 | PG 동일 locator 조각 집계/다른 위치 보존과 limit, core provenance·상한·이어 읽기 |
| M8 | createBrain 단일/혼합 원본 삭제 장벽·Drive home 링크·로컬 불가·DB 오류, PG 공개 불가 source의 limit 전 제외 |
| M9 | core/CLI typed probe·실제 SDK/CLI JSON/text·후속 show의 중첩 합성 비밀, 두 링크 보존·큰 names/origins의 명시적 예산 오류 |

### 검증 결과와 최초 실패 처분

개발 중에는 시험을 실행하지 않고 build/typecheck/diff만 확인했다. E10과 R4 뒤 `VITEST_MAX_WORKERS=2 pnpm test`와 `pnpm test:python`을 순차 각 1회 실행했다. 두 최초 명령의 종료 코드는 모두 1이며 이를 전체 통과로 바꾸어 기록하지 않는다. 전체 명령과 성능 시험은 반복하지 않았다.

| 실행 | UTC 시작 → 종료 | 실제 결과 |
| --- | --- | --- |
| 최초 전체 TS | 03:12:08 → 03:24:52 | 239파일, 5159 pass / 76 fail / 0 skip, exit 1 |
| 최초 전체 Python | 03:24:52 → 03:54:56 | 16파일 중 1 pass / 14 fail / 1 timeout, 관측 8 pass / 60 fail / 0 skip, exit 1; hook은 JSON 미생성으로 사례 성공을 추정하지 않음 |
| 관련 TS | 03:55:43 → 03:58:26 | 최초 실패 8파일과 incoming 관련 3파일, 235 pass / 1 fail / 0 skip, exit 1 |
| 관련 Python | 03:58:26 → 04:02:11 | 최초 실패/timeout 15파일, 68 pass / 6 fail / 0 skip, exit 1 |
| 남은 TS | 04:02:54 → 04:03:40 | extension-commands 1파일, 20 pass / 0 fail / 0 skip, exit 0 |
| 남은 Python | 04:03:40 → 04:04:55 | install와 hook 2파일, 14 pass / 0 fail / 0 skip, exit 0 |

모든 시각은 2026-11-09 UTC다. 최초 TS의 npm/npx ENOENT 3건은 제한 PATH에 실제 실행 파일을 제공해 해결했다. 나머지 73건과 다수 Python DB 준비 실패는 부모 `BRAIN_POSTGRES_PASSWORD`가 fixture의 전용 `.env` 암호를 덮어쓴 환경 오류였다. 부모 변수를 제거하여 각 fixture가 자신의 암호를 사용하게 했다. 최초 hook timeout도 같은 환경 교정 후 정상 종료했으며 이후의 8사례를 실제 실행했다.

남은 TS 1건과 Python 6건은 Python 3.12.13 발견 실패였다. 복사한 전용 런타임의 `UV_PYTHON_INSTALL_DIR`는 제품의 최소 자식 환경에 전달되지 않으므로 실제 pinned `python3.12`를 전용 PATH에 연결했다. 제품과 같은 PATH/HOME만 가진 자식 환경에서 발견/버전을 확인한 뒤 위 정확 실패 파일만 재실행했다. 제품·단언·timeout·가림을 약화하지 않았다. 원래 환경과 실패 로그는 보존했다.

최초 TS 실패 76사례 각각을 같은 file/fullName의 최종 pass와 대조했다. 최신 파일별 실행 증거의 합집합은 TS 241파일 5299 pass, Python 16파일 76 pass이며 fail/skip은 0이다. 이는 서로 다른 실행에서 확보한 파일별 증거이며 새로운 전체 회귀 1회 성공을 뜻하지 않는다. 원시 명령/UTC/exit는 `.brain-automation/tickets/8.6/{final,related,remaining}-regression.json`, 실패별 대응은 `execution-audit.json`에 있다. 후속 build와 typecheck도 각각 exit 0, 마지막 diff 확인도 exit 0이다.

### 리뷰 처분과 잔여 위험

R1은 high 4/medium 19를 bad_plan으로 처리해 보존 patch와 E4~E7 재도출을 남겼다. R2는 medium 9/low 6 중 bad_plan 7·patch 1을 E8/E9로 교정하고, 범위 밖 19.8 1건은 원소유자에게 인계했다. R3의 medium patch 2건은 같은 root이며 E10으로 교정했다. R2 low 6건과 R3 low 8건은 각각 Review Triage Log에 기록한 정확성 근거 부족·추가 복잡도·관측 시점 계약 등의 이유로 기각했다. R3에 carried된 19.8 항목은 수락 교정과 전용 38사례 통과로 닫혔고 단일 deferred 목록에는 해결 이력을 보존한다. 현재 미해결 필수 finding은 없다.

R4/R5는 새 지적 0건, patch high 0/medium 0이다. 후속 리뷰 권고는 false다. 최종 실행 증거 감사는 아래에 별도로 기록하며 정적 리뷰를 실행 통과로 대신하지 않는다.

0001~0044의 모든 바이트를 원본 baseline과 대조했고 schema44·0044 승인 hash를 유지했다. 새 DDL과 기존 chunk/tool 검색 본문 변경은 없다. 수락 19.8/19.9는 정상 명령 종료 경계에서 통합했고 제품 15파일과 충돌하지 않았다. 실제 변경 경로의 선택 함수 결과는 `pythonAll: true`다. peer 소유 파일을 직접 교정하지 않았다.

전용 PG·role·HOME·외부 TMP·Python 런타임·private 실제 Docker context/Compose와 genuine OrbStack status 한 인자 제한 위임을 사용했다. 기존 Python runner의 checkout 내부 ignored job scratch는 외부 부모 TMP와 구별했다. 자기 장부의 정확 컨테이너 390 ID를 확인해 남은 전용 TS 컨테이너 1개만 제거했고 모두 부재다. hook 세 project의 volume/container/network도 부재이며 runner cleanup 오류·quarantine은 0이다. 환경 정리기의 첫 optional-key 읽기 오류는 Docker 조작 전에 종료됐고 원문과 교정 근거를 보존했다. 워크트리·브랜치·세션·원시 로그·장부·외부 런타임 파일은 보존한다.

### operator_actions

8.6 자체의 필수 운영자 조치는 없다. 실계정 OAuth·실제 개인 문서·운영 DB·이 Mac 설치본 배포는 실행하지 않았다. 실제 계정과 릴리스 인수는 후속 8.8 범위이며 선행 티켓의 결과불명 삭제 등 운영 인계는 원계획에서 유지한다. 합성 입력과 fake Drive의 실행 증거를 실제 계정 성공으로 확대하지 않는다. 성능창이 없어 새 성능 측정을 하지 않았고 기각된 성능 제안은 이 티켓의 필수 미해결로 취급하지 않는다.

### R6 최종 실행 증거 독립 감사

독립 Sol medium은 TS 원시 JSON 3개·Python job JSON/로그·세 run 장부를 읽어 최초 TS 76실패의 동일 file/fullName 최종 pass, 지정 8파일 178pass, 최신 Python 16파일 76pass 및 case-shard 15/15 완주를 확인했다. 제품 15파일 해시·44 migration 바이트·공통 검색 본문·390개 자원 ID 영수증도 독립 대조했고 새 실재 지적은 0건이다. 최초 hook timeout의 단독 원인은 확정하지 않으며 환경 교정 뒤 실제 정상 종료한 증거와 구별한다. 보고서는 `.brain-automation/tickets/8.6/r6-execution-audit.md`다. 최종 patch high 0/medium 0이므로 후속 리뷰 권고 false, 미해결 필수 항목과 자체 운영자 조치 없음이다.
