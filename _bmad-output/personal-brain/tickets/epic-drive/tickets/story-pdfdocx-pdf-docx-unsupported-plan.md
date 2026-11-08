---
title: 'PDF·docx 추출과 버전별 unsupported Carry'
type: 'feature'
ticket: '4'
created: '2026-11-08'
status: 'built'
baseline_revision: 'fd4532f415e08da0ffbbb33822c04dd401fd49f7'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** PDF·docx는 현재 text 추출기에서 unsupported로 닫히며 실패행도 없어 버전 상승으로 살아나지 않는다. Drive에는 다운로드 전에 닫혀 file 자체가 없는 항목도 있다.

**Approach:** Node runtime의 바이트 기반 PDF·OOXML 추출기를 Core DocumentExtractor에 주입하고 일반 CLI까지 연결한다. 새 형식만 버전별 한 번 재큐잉하는 Store/PG/fake 계약으로 로컬·source 추출 세대와 기존 소유권을 유지한다.

## Boundaries & Constraints

**Always:** PostgreSQL이 원천이다. 입력 PDF/docx 50MiB, PDF 2000쪽, docx 실제 해제 200MiB, 추출 500만 코드포인트를 넘으면 too_large다. 페이지·문단 경계를 넘지 않는 locator와 실패 시 기존 성공 current/chunks 보존, 단조 attempt/version/CAS·source generation/claim/remote version/hash·disconnect fence를 유지한다. bytes I/O 동안 쓰기 transaction을 잡지 않는다. 개발·리뷰 수정 중 시험 실행 금지, 컴파일 확인만. 마지막 수정·독립 후속 뒤 전체 TS→Python 순차 회귀를 각1회 실행한다.

**Never:** OCR/HWP·새 문서 집계·제목계층·검색 점수/순위/상위결과·22.3 검색SQL·19.5 runner/config/측정driver·새 Python 실행기·canvas/native renderer·실문서/실Drive/OAuth/운영DB를 사용하거나 수정하지 않는다. 중앙 main/state·plugin0.1.23/ref598497c·0001~0042 migration bytes와 역사 기대를 변경하지 않는다. 개인 홈 절대경로는 공개 문서·하위 prompt·commit에 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| PDF | 합성3쪽·바뀐 확장자 | bytes 판정, pdf.page/page 사본1·2·3, 쪽별 chunk | bbox는 생략 |
| DOCX | 빈 문단·표 셀·개행·바뀐 확장자 | OOXML 검증 후 mammoth raw text, document order 문단1기반 block | 일반 ZIP은 unsupported |
| 한도 | 51MiB·2001쪽·ZIP 폭탄·500만자 초과 | 할당/해제/누적 전 제한, too_large | 현재 포인터 보존 |
| 빈/오류 | 이미지 PDF·손상문서·child timeout/비정상 종료 | 빈 PDF는 빈 성공, 나머지 failed extract | 부모 회수·기존 성공 보존 |
| Carry | 과거 unsupported PDF/docx와 다른 binary | 새 지원 bytes만 버전당 한 번 enqueue, 비대상 판정도 한 번 | 일시 읽기/DB 실패는 marker 미확정 |
| 경합/재시작 | 동시drain·열린sync·kill·remote 변경·disconnect·redaction | work/attempt 중복 없음, source fence와 열린/unknown temp 보존 | 확정 성공 뒤 자기 임시bytes 정리 |

</intent-contract>

## Code Map

- `packages/core/src/files/{extractors,extract-work}.ts`: 동기 detect/text-only doc/1, awaiting/stale 두 후보군, source reader·generation writer 재사용.
- `packages/core/src/domain/document.ts`, `ports/{file-store,source-remote,source-store,store}.ts`: 공통8MiB를 형식별 상한으로 분리하고 bounded reader·Carry 능력 추가.
- `packages/core/src/{brain.ts,sources/sync.ts}`: 현재 Drive MIME/8MiB 사전차단 및 createBrain 조립에 주입 연결. Google Docs 10000000 bytes/사진 metadata 전용 유지.
- `packages/postgres/src/{extractions,sources,store,migrate}.ts`, `packages/postgres/migrations/`: stale는 ok current만 고르므로 unsupported 별도 경로 필요. source handoff/publish·source-first 잠금 재사용.
- `packages/core/src/testing/{fakes,contracts}/`: fake와 실제 PG에 같은 Carry/reader 계약 적용.
- `apps/cli/src/{assembly.ts,runtime/}`: parser import·Node child·부모 adapter·로컬/Drive bounded get/temp; 일반 설치 dist child 배포 경로 확인.
- `apps/cli/package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: 정확 의존과 optional canvas 제외 설정. `tooling/test-changed/rules.mjs`: 새 자식 실행 경로 선정 추가만.
- 선행8.3 plan의 source publish/claim·AUTH_SESSION_CHANGED·DB 장애 분류·temp cleanup·19.11 수락 시험을 보존한다. 옛 research SQLite 구현은 부활시키지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] E1 Runtime/형식 — 위 extractor/domain/reader port·fake/runtime·Brain/CLI 조립·manifest/lock 및 합성 runtime 시험 코드를 구현한다. detector를 await 가능하게 하고 caller를 모두 갱신한다. PDF·docx 판정은 text보다 먼저, 구조검증과 실제 streaming 한도를 지킨다. 시험 이름: `PDF 3쪽 locator/page`, `바뀐 확장자 PDF DOCX`, `일반 ZIP 거부`, `51MiB bounded read`, `ZIP 실제 팽창 상한`, `2001쪽과 출력 상한`, `이미지 PDF 빈 성공`, `빈 문단·표 셀 block`, `child timeout 회수`, `일반 CLI canvas 없는 조립`.
- [x] E2 파일 Carry — Store/fake/공유계약/PG와 enqueue, 필요한0043 등록·현재 schema 기대를 구현한다. bounded bytes/hash 판정은 lock 밖, marker+enqueue는 file lock/CAS 한 transaction. 시험 이름: `unsupported PDF DOCX 버전별 한번`, `비대상 bytes 재읽기 없음`, `동시 CAS work 하나`, `marker enqueue rollback`, `redacted unreachable 제외`, `새 세대 실패 current chunks 보존`, `fake PG 계약`, `기존 migration 이력 불변`.
- [x] E3 source Carry/수직 연결 — source sync/port/fake/PG·source reader·CLI tracer·선정규칙을 완성한다. 다운로드 전 unsupported와 source-only file도 기존 prepare/handoff/publish로 연결한다. 시험 이름: `source unsupported PDF 재색인`, `octet-stream 다른 이름 DOCX`, `비대상 source 재다운로드 없음`, `열린 scan와 후속 carry 중단재개`, `source-only 새 work handoff`, `remote version disconnect redaction fence`, `unknown 열린 attempt temp 보존`, `성공 temp 정리`, `로컬 Drive 같은 extractor`.

**Acceptance Criteria:**
- Given 일반 CLI에 합성 PDF·docx를 로컬 첨부 또는 가짜 Drive로 공급할 때, when drain/sync가 끝나면, then 현재 세대의 chunks는 matrix locator/page와 같은 본문을 갖고 source 임시bytes는 정리된다.
- Given 구버전 unsupported와 지원 안 되는 binary가 있을 때, when 동일 버전 drain을 반복·동시 실행하고 재시작하면, then 새 지원 형식만 한 번 재큐잉되며 비대상은 새 세대 없이 판정 marker만 남는다.
- Given 기존 성공 current가 있을 때, when 새 추출이 한도·파서·source fence 때문에 실패하면, then 기존 성공 current/chunks는 남고 새 실패 조각은 검색되지 않는다.

## Implementation Notes

E10: Mammoth emitted row/cell·gridSpan/continue 조건을 추적해 생략가능한 계속셀의marker누락만허용하고 실제출력marker는검증한다. restart/고아continue/non-cell/wrapper/삭제행·정상형제와원본block 시험코드를작성했다. build/typecheck/diff exit0, 시험미실행. F-R3-P1의마지막독립재확인뒤최종회귀로진행한다.

E9: FileStore.getBounded 필수화와 Core/Drive 조립 TypeError 조기거부·공유bounded계약/컴파일오류기대·get-only fixture를정합화했다. 최초typecheck는옛fixture에서TS2741, 교정뒤최종build/typecheck/diff exit0. 시험미실행이며 마지막제품/시험변경의 독립집중후속을받는다.

E8: Google native 비대상예약제외, pinned A→B의 완전claim승계/oldattempt차단, 동일generation 과거미완료source run승계와 foreground시험을 작성했다. build/typecheck/diff exit0, 시험미실행. 각version/claim해결은 독립집중후속대상이다.

E7: deleted표행/drawing문단의 marker활성조건, PDF스타일연속/배치공백, 제어child stdout상한 close/PID회수, parser경계만주입하는 실제extract실패PG시험을 보강했다. build/typecheck/diff exit0, 시험미실행. 마지막개별해결은 독립집중후속대상.

E6: Unicode overlap·8MiB실제text·Drive getBounded cancel·실제OOXML폭탄 handler too_large·51MiB PDF·DOCX출력상한·child SIGKILL의 PG current보존·반복Carry 세대수 시험을 보강했다. OOXML 선택읽기 정체성 확인 뒤 전체해제 상한을 적용해 일반ZIP과 구별한다. build/typecheck/diff exit0, 시험 미실행. 마지막 E4/E5/E6 개별해결은 R2 독립후속에서 확인한다.

22.3 수락 main `e8a80b18451b43a14157cf673f40c28531b7dbb9`를 실제 incoming14파일과 대조한 뒤 자기 브랜치에 정상 fast-forward 통합했다. 검색/성능도구 소유변경만이며 8.4 편집파일과 중첩0, 충돌0. 원본baseline은 유지하며 R2 ticket diff는 통합HEAD 대비 작성한다. 신규 heavy는 W3 07:44:32~07:59:32UTC 동안 보류한다. 최종회귀는 통합소스를 대상으로 한 번만 수행한다.

E5: 일반 queue 뒤 Carry probe·deadline 뒤 시작단건 판정확정, work version pin/동일bytes 합류·terminal source run 복구·foreground 후속 scoped 청구·전송초과 marker·일반ZIP 비대상 처리를 추가했다. build/typecheck/diff exit0이며 E4 최종 AlternateContent도 포함했다. 시험 미실행, 각 해결은 독립후속 전까지 미검증이다.

E4: parser 문단 재포장 P×S를 단일 Mammoth 호출/검증 marker 매핑으로 교체하고 UTF16/Strict/main target/CMap/실제 raster/timeout-close와 정확 본문 시험 코드를 작성했다. W1 해제 뒤 build/typecheck exit0, 마지막 AlternateContent 수정은 W2 중 정적변경으로 아직 재컴파일되지 않았다. E4 실행완료와 최종컴파일/독립후속 완료를 구별한다.

E1: runtime child·await detector·bounded file/temp reader·일반 CLI 주입과 합성 시험 코드를 작성했다. build/typecheck/diff exit0, 시험 미실행. 첫 no-optional 설치가 TypeScript platform 패키지를 제외하여 build 실패했고 canvas만 제외한 frozen install로 복구했다. 정확 의존/lock과 최초 compile 실패는 전용 E1 보고에 보존했다. source 선별/Carry와 실제 실행 검증은 E2/E3 및 최종 회귀에서 남는다.

E2: Store/fake/PG marker+enqueue 및 0043을 구현했다. 열린 work는 버전 완료로 추정하지 않고 marker 미확정으로 유지한다. 41→42/40→42는 coreMaxVersion42로 역사경계를 보존했다. build/typecheck/diff exit0, 시험 미실행.

E3: source 버전별 marker·scan 요청/started·fenced 완료 후 후속 work·기존 handoff/publish 연결과 CLI tracer 시험을 추가했다. build/typecheck/diff exit0, 시험 미실행. 최초 stale Core 선언 typecheck 오류는 build 뒤 해소했다.

## Plan Change Log

### R3 파서 좁은 보강

KEEP: source문단번호/빈문단번호유지·단일Mammoth·이미지/Choice/삭제행생략·형제본문·Strict/UTF16·PDF현재본문·bounded/Carry계약. 모든vMerge를제외하지않는다.

- [x] E10 DOCX 세로병합 marker — `apps/cli/src/runtime/document-parser-child.ts`와 `apps/cli/test/document-extractors.test.ts`만. F-R3-P1의 실제Mammoth병합조건에맞춰 계속셀의marker기대와원본block번호를일치시킨다. Transitional/Strict에서 restart·기본continue·명시continue·선행셀없는continue 및 앞뒤정상형제본문/원래번호를 실제DOCX로정확검사한다. 시험실행금지·compile만, 완성뒤마지막변경을독립후속에서직접재확인한다.

### R2 계약 재도출

intent-contract와 R1 KEEP 불변. 마지막 E4/E6 파서제품·시험변경의 추가누락과 E5버전승계 공백을 아래작업으로 해결한다. 정상문서원문·source fence·bytes상한·사진다운로드0·기존success pointer를보존한다.

- [x] E7 파서/adapter 후속 — R2-BH2/6/7/VG1. `apps/cli/src/runtime/document-{parser-child,extractors}.ts`와 document-extractors/drive-source-tracer 시험에서 생략문단/정상형제·스타일연속PDF·공백/줄·부모stdout회수·실제extract실패변환을 구현/단언한다. 테스트 실행경계 주입은 production동작을 유지하는 최소factory/옵션으로 하며 항상실패 wrapper금지. child fixture경로를 새로 만들면 test-changed 선정에 포함한다.
- [x] E8 Carry 버전승계 — R2-BH1/4/5. core/fake/Store/PG/source/work의 native비대상 판정멱등성과 A예약후 B업데이트/재시작·oldclaim차단·terminal A source run의 B foreground복구를 구현/시험코드로확인한다. work 버전pin은 구버전실행파일부재에서도 안전히진행할수있어야하며 완료marker를덮어소유fence를우회하지않는다.
- [x] E9 bounded reader 계약 — R2-BH3. `FileStore.getBounded` 필수계약과 runtime/fake/조립/custom fixture를정합화하고 무제한get fallback없이 compile로누락을검출한다. 관련공유계약에서 실제 bounded읽기를확인한다. 변경된호출처를rg로감사하고 기존get-only 구현이조용히retry하지않도록검증한다.

E7→E8→E9 동일Terra순차(현재새구현자2Tasks완료). 매Task 시험실행금지·compile만, W3명시창07:44:32~07:59:32UTC동안신규compile도금지. 마지막변경은 독립집중후속에서 각finding별확인하며 총high0문구로대체하지않는다.

### R1 재도출 범위와 KEEP

intent-contract는 불변이다. 전체 소스를 폐기하지 않고 아래 결함이 있는 계약 경계만 순차 재도출하여 검토된 정상 경로를 보존한다. KEEP: PG 원천·0001~0042 bytes·source-first 잠금/claim/connection fence·bytes hash·단조 attempt/current 보존·bounded 입력/해제/출력·사진다운로드0·일반 CLI 주입·canvas 제외·19.11수락시험·검색/runner 소유경계.

- [x] E4 파서 재도출 — runtime document-extractors/parser-child와 관련 합성 시험만. BH3~7/9~10, OBH5~8/10, OVG4~5를 해결한다. Mammoth raw text를 한 번 호출하면서 안전한 원문 충돌없는 문단 경계 토큰과 명시개행 보존 등으로 문단 mapping을 확보하고 재포장 P×S를 제거한다. UTF16/Strict/실제 main target·bundled CMap·실제 raster·timeout close를 정확히 검사한다. 새 설계와 라이브러리 API 근거를 보고한다.
- [x] E5 Carry 재도출 — file enqueue/Store/fake/PG/source scoped queue 계약과 해당 시험. BH1~2/8, EC1~4, OBH1~4를 해결한다. 일반작업이 무거운 probe에 굶지 않으며 완료된 단건판정은 deadline 뒤에도 잃지 않는다. 현재버전 work 합류/구버전 후속·terminal run 복구·foreground lineage·전송한도 marker와 비DOCX ZIP 제외를 원자성/재시작 시험으로 확인한다. source-specific 선정 최소변경만 허용한다.
- [x] E6 검증 보강 — core document-extract/CLI document-extractors/drive-file-store/drive-source-tracer 시험과 필요한 최소 교정. VG1~3/OVG1~5/OIA3의 관찰 표면을 메운다. 51MiB PDF 실제 handler too_large·진짜 OOXML ZIP 폭탄·DOCX 출력 초과·new child failure의 기존 pointer·반복 Carry 성공세대수/일감수 불변도 명시 단언한다. 시험실행금지, 컴파일만. 최종 코드변경 각각에 독립 후속을 받는다.

수정 Task는 한 번에 한 계약경계만, 구현자6회초과 금지. W1 07:09:42~07:24:42UTC/16:09:42~16:24:42KST에는 신규 compile/test/eval/측정 금지, 정적수정 계속; 만료/조기반환 자동해제. 개발중 시험금지는 별도로 계속 적용된다.

## Review Triage Log

### R3 독립 집중 후속

세 Sol medium reviewer가 E7/R2-BH2·6·7/VG1, E8/R2-BH1·4·5, E9/R2-BH3를 각각 consumer와 정확시험도달로 개별확인했다. Carry와 bounded 추가확정결함0, parser 추가1건. 원문 focused-r3-parser/carry/bounded_verification 보고를 보존한다. 정적해결과 실행통과는 구별하며 별도OS재시작·모든PDF배치·binary crash결합의 한계는 최종보고에 보존한다.

- F-R3-P1 [high] [bad_plan] Mammoth가 앞행과 세로병합된 계속셀을 제거하는데 그셀의빈문단도active로세어 seen불일치로 정상DOCX전체실패. 설치body-reader readVMerge/calculateRowSpans근거를 확인했다. restart/선행셀없는continue까지버리면본문손실이므로 실제병합조건을 반영하는 E10을 추가한다.
- 판정총1건 high1, medium0, low0, false0, maybe-false0. 기존R2개별해결은 유지하며 마지막E10코드/시험을 별도독립확인한다.

### 2026-11-08 R2 개별 판정

- verdicts: 8 findings — high1, medium7, low0, false0, maybe-false0. Edge는 새발견0이며 EC1~4 해결을 개별확인했다. Verification은 VG1~3/OVG1~5 시험의 개별도달·정확단언을 확인했다. Intent는 메타데이터선별+bytes확정/사진다운로드0의 방어가능한 해석과 관찰한계를 기술했고 새확정결함은 없었다.
- R2-BH1 [medium] [bad_plan] native Google 비대상이 unsupported지만 marker없이 남아 reserve가 매drain fullscan을 만든다. E8에서 byte다운로드 없는 명시 제외판정과 예약조건을 일치시킨다.
- R2-BH2 [medium] [bad_plan] deleted 표행/drawing textbox 문단은 Mammoth가 생략하는데 marker active에 포함된다. 설치 body-reader의 w:trPr/w:del, wp:anchor/inline 분기를 확인했다. E7 정상형제본문 보존과 block번호계약을 맞춘다.
- R2-BH3 [medium] [bad_plan] optional getBounded의 기존 FileStore 구현이 타입상 유효하지만 추출에서는 무조건실패한다. E9 필수제한읽기를 타입/조립계약에서 강제하고 구현 누락을 컴파일에서 드러낸다. 무제한get fallback은 넣지 않는다.
- R2-BH4 [high] [bad_plan] pinned A queued work를 B가 begin하면 영구 CLAIM_LOST, 기존work가열려 Carry재예약도 불가. E8 claim/fence를 검증한 안전한 버전승계·재시작·old owner차단을 구현한다.
- R2-BH5 [medium] [bad_plan] oldversion A terminal run은 B의 reserve/scan에 승계되지 않고 readSourceWorkStatus 전버전미완료조건을 막는다. E8 같은generation의 과거미완료요청을 안전하게 충족/종결한다.
- R2-BH6 [medium] [bad_plan] PDF TextItem마다 강제공백을 붙여 스타일별로 분할된 한단어를 파괴한다. E7 PDFjs의 문자열/공백/줄/배치정보를 사용하여 단어연속성과 명시공백을 함께 보존한다.
- R2-BH7 [medium] [bad_plan] 부모 stdout30MiB 제한시험이 child 문자상한만 거쳐 실제부모회수를 관찰하지 못한다. E7 제어가능한 자식출력·SIGKILL/close/부재를 단언한다.
- R2-VG1 [medium] [bad_plan] PG child kill시험이 actual.extract를 항상실패 wrapper로 덮어써 runtime failed→ok:false 변환이 제거돼도 통과한다. E7 parser실행경계만 주입하고 실제extract 결과/PGpointer/실패행을 관찰한다.

R2 blind는 실제7건만발견해floor10미달로 outcome failed다. 최초실패/원문은 보존하고 제품전체검사 성공으로 바꾸지 않는다. 실제7건을수정하고 독립집중후속으로 각해결을확인하며 지적수를맞추지않는다. R1 절차복구 이력도 보존한다.

### 2026-11-08 R1 독립 검사 및 절차 복구

최초 diff에 plan을 포함한 지휘자 오류로 blind/verification/intent의 비노출 조건이 깨졌다. 원문15개 개별기술발견과 의도3개 관찰은 보존하며 독립 완료로 계산하지 않는다. 의도 Task는 실제 failed다. 계획 제외 diff를 새 Sol medium3명에게 재검사하여 유효 blind10/verification3/intent1과 허용된 edge4를 수신했다. 아래 모든 기술발견을 개별 판정하며 수를 맞추기 위한 결함은 만들지 않았다.

유효 R1/R1b: 18 findings — high 1, medium 16, low 0, false 1, maybe-false 0

- BH1 [medium] [bad_plan] 동일 바이트 remote 두 개가 ensureWork created=false로 scan 중단. 현재버전 work 합류와 구버전 후속 경계를 E5에서 재도출한다.
- BH2 [medium] [bad_plan] terminal 실패 run 존재만으로 재예약 거부, 새 수동 sync의 workId가 run을 충족하지 못한다. E5 복구.
- BH3 [medium] [bad_plan] Mammoth raw-text가 break를 빈 문자열로 만들어 Cellnext가 된다. E4에서 개행 보존.
- BH4 [medium] [bad_plan] UTF8 강제 디코드가 UTF16 OOXML을 손상시킨다. E4 encoding/BOM 처리.
- BH5 [medium] [bad_plan] 실제 root relationship target 대신 고정 word/document.xml만 허용한다. E4 내부 target 정규화.
- BH6 [medium] [bad_plan] 문단마다 공통 XML을 재포장/재해석해 P×S 비용. E4 단일 Mammoth 호출과 문단 매핑.
- BH7 [medium] [bad_plan] PDFjs cMapUrl 미설정으로 predefined CMap 소비자가 실패/누락 가능. E4 bundled local CMap과 합성 CID fixture.
- BH8 [medium] [bad_plan] unknown size TOO_LARGE 다운로드 결과에 marker가 없어 동일버전 반복. E5 remote 재검증 뒤 한도판정 확정.
- BH9 [medium] [bad_plan] image-only 시험은 빈 Tj이며 XObject가 없다. E4 실제 합성 raster 및 최종 빈 성공 경로.
- BH10 [medium] [bad_plan] timeout 시험은 어떤 실패도 통과. E4 시작/close/signal과 회수의 정확 관찰.
- EC1 [high] [bad_plan] 판정 뒤 deadline 초과이면 결과를 버리고 다음 drain도 같은 후보부터 읽는다. 일반 enqueue와 queue가 굶는다. E5 일반 처리 우선 및 재개가능 단건 판정.
- EC2 [medium] [bad_plan] BH2와 같은 실패 run 복구 공백. E5.
- EC3 [medium] [bad_plan] BH1과 같은 동일 bytes handoff 거절. E5.
- EC4 [medium] [bad_plan] detectCarry의 'too_large' 문자열을 로컬이 truthy로 받아 OOXML 미확인 일반ZIP도 새 세대 생성. E5 지원정체성/초과를 구별하고 비대상 marker만.
- VG1 [medium] [bad_plan] 긴 block/겹침/코드포인트 분할 루프를 실제 시험이 호출하지 않는다. E6 긴 Unicode 문단 정확 배열/locator.
- VG2 [medium] [bad_plan] 일반 8MiB+1 실제 text 상태가 검증되지 않는다. E6 too_large/current/chunks/failure 단언.
- VG3 [medium] [bad_plan] Drive getBounded 호출 시험이 없다. E6 누적 초과/정확경계/cancel 단언.
- IA1 [false] [reject] 독립 명세는 이미지 다운로드 정책을 바꾸라는 요구가 아니며 원문 부모E8-2와 선행8.2는 사진 다운로드0을 명시한다. 바이트 판정은 다운로드 후보의 내용 확정에 적용한다. photo/native Google 사전 제외를 유지하고 확장자/octet-stream을 확정 근거로 쓰지 않는다. 잘못된 image MIME의 모든 bytes까지 읽는 해석은 사진0회와 충돌하여 채택하지 않는다.

독립성 실패 원문 기술발견 보존: 18 findings — high 1, medium 15, low 0, false 2, maybe-false 0

- OBH1 [medium] [bad_plan] BH1과 동일, E5
- OBH2 [medium] [bad_plan] BH2와 동일, E5
- OBH3 [medium] [bad_plan] foreground scope는 최초 syncWorkId만 허용하고 후속 Carry work는 못 청구하지만 완료조회는 기다린다. E5 source scoped 후속 lineage 처리 및 foreground 자체 시험.
- OBH4 [high] [bad_plan] EC1과 동일, E5
- OBH5 [medium] [bad_plan] BH6과 동일, E4
- OBH6 [medium] [bad_plan] BH5와 동일, E4
- OBH7 [medium] [bad_plan] Strict OOXML namespace/relationship을 앞단이 탈락시킨다. E4 Strict/Transitional 정규화와 합성 fixture.
- OBH8 [medium] [bad_plan] BH3과 동일, E4
- OBH9 [medium] [bad_plan] ZIP 폭탄 fixture가 선언크기만 초과하여 실제 streaming 오류 경계 미관찰. E6 forged size/여러 entry 회귀.
- OBH10 [medium] [bad_plan] BH9와 동일, E4
- OVG1 [medium] [bad_plan] VG2와 동일, E6
- OVG2 [medium] [bad_plan] tooLarge 결과→handler too_large/실패행0/current 보존 경로 미관찰. E6 주입 결과와 실제 parser end-to-end.
- OVG3 [medium] [bad_plan] VG3과 동일, E6
- OVG4 [medium] [patch] 3쪽 PDF가 locator만 검사해 본문 뒤바뀜을 놓친다. E4 페이지별 본문 정확 단언.
- OVG5 [medium] [bad_plan] BH3의 본문 정확 기대 누락. E4
- OIA1 [false] [reject] IA1과 동일 photo0 요구의 명시 제외. 독립성 실패 이력 유지.
- OIA2 [false] [reject] 추가 시간/heap/entry 방어한도는 명시상한 이내 모든문서 성공보장이 없고 parser 폭발 방지 요구에 필요한 정책이다. 운영 한계로 공개하되 추가 기능결함으로 세지 않는다.
- OIA3 [medium] [bad_plan] 원문 관찰 표면 차이는 E4/E6 실제 이미지·51MiB PDF/ZIP폭탄 상태·반복 성공 세대수·child 오류 포인터 보존·DOCX출력상한으로 보강한다.

## Design Notes

공식 registry/API 확인 근거: pdfjs-dist6.4.299 Apache-2.0, Node>=22.13.0 또는>=24; mammoth1.13.0 BSD-2-Clause Node>=12; yauzl3.4.0 MIT Node>=12; JSZip3.10.2 MIT 선택. Node>=24.16.0과 호환한다. PDF optional @napi-rs/canvas는 pnpm ignoredOptionalDependencies로 설치 제외하고 실제 부재를 확인한다. 정확 전이/license/integrity는 구현 pnpm lock과 별도 지문 증거로 남긴다. 공식 출처는 npm registry의 각 정확버전 package와 mozilla/pdf.js·mwilliamson/mammoth.js·thejoshwolfe/yauzl의 API다.

Node child는 process.execPath/256MiB V8 heap·60초 timeout으로 격리한다. 부모와 child 모두 입력·출력 상한을 검사하고 IPC도 제한한다. 실제 stream 해제량을200MiB 전에 제한하며 entry수·경로·중복·암호화·overflow와 OOXML content types/root relationship/document 정합성을 검증한다. Buffer는 heap 상한 밖이므로 child 격리만으로 안전하다고 주장하지 않는다. 한도 초과만 too_large, timeout/비정상종료는 failed다.

PDF getDocument/streamTextContent를 사용하고 렌더링하지 않는다. 문단 번호는 word/document.xml 본문의 document order w:p이며 빈 문단·표 셀도 번호를 차지한다. 문단별 최소 OOXML 패키지와 필요한 검증 부품으로 mammoth.extractRawText를 호출하여 개행 split의 모호함을 피한다. 중첩 문단 중복을 제거하고 문단 끝 두 개행만 제거한다. 모든 다른 문단을 매번 복제하는 불필요한 제곱 비용을 피한다. 표 wrapper는 내용 순서가 유지되면 최소화할 수 있다. 빈 문단은 번호만 차지하고 chunk는 없다.

0043은 조건부 예약된8.4 번호이며 필요하다. 최소 DDL은 file/version 검사 marker, source file/remote version/extractor version marker, source/generation/version Carry 요청(work 참조·완료상태)이다. 미지원 전체를 매 drain 읽지 않으면서 세대는 새 지원 bytes만 만들기 위해 필요하다. 기존 work 유일성·lease를 소유권으로 사용하고 marker에 별도 영구 pending lease는 만들지 않는다. 기존 source sync가 이미 scan을 지나쳤으면 단순 합류로 충족 처리하지 않고 fenced completion에서 후속 sync를 원자 예약한다. source marker와 handoff는 같은 확정 transaction, 실패 시 기존 retry가 이어받는다. 기존0041/42 키 타입·권한·export 계약과 일치시킨다. 등록 전 실제 번호 경합만 중앙에 통지한다.

## Verification

개발·리뷰 수정 중 `pnpm build`, `pnpm typecheck`, `git diff --check`만 실행한다. 수락조건 시험 코드는 작성하되 실행·eval·측정 금지다. 다운로드가 필요한 compile은 처음부터 정식 권한 확장 사용. 워커는 commit/push/상태 전이·추가 워커·build-auto 재귀 실행을 하지 않는다.

마지막 구현·독립4렌즈·필요후속 이후 전용 PG/role/home/venv/Clock/가짜HTTP와 checkout 밖 TMPDIR에서 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 순차 각1회 수행한다. 최초 실패 raw/exit/지문을 보존하고 수정 후 관련 시험/test:changed만 재검증한다. 위 E1 runtime/CLI, E2 core·extraction-store 공통계약/PG, E3 source-sync/source-store/drive-source-tracer 시험이 실제 suite에 등록·실행됐는지 matrix별 감사한다. runner/frozen lock는 baseline 사용, 새19.5 runner 적용 금지다. 명시 측정창 동안 신규 heavy만 보류하고 만료 때 자동 해제한다.

전용 `.brain-automation/worker.json`과 증거는 보존한다. 최종 한국어 Auto Run Result/operator_actions에는 baseline/source·원격SHA·clean·review별 처분·후속·전체 최초 실패/관련처분·ready/depth·정확 소유 자원 정리/부재·미해결/한계를 기록한다. built는 인수done이 아니며 범위 commit/branch push와 중앙 Run 결과보고까지 지휘자 책임이다.


## 최초 전체 회귀와 교정 계획

TS `VITEST_MAX_WORKERS=2 pnpm test` 2026-11-08 08:28:57~08:38:54UTC exit1:226파일중220통과/6실패,4916시험통과/21실패/1skip. Python `pnpm test:python` 08:38:54~08:46:05UTC exit0:16파일73시험전부통과(내부Python unittest별도로그). 두전체는각1회이며반복하지않는다. 최초raw/exit/SHA256·source지문/전용자원/실제OrbStackstatus위임증거는gitignored로보존한다.

실패21건중16건은22.3incoming query-perf의current42고정guard/manifest와필수0043의통합충돌이다. 중앙 msg_ee8915bc687e가 아래4파일의최소schema43호환만8.4소유로승인하고22.6편집금지를통지했다. 나머지5건은source-only binding행수·OOXML too_large의source link·PDF출력상한fixture·Drive cancel fixture·child stdout sink등록이다. 이원인들은아래작업에서정확히확정하고기대완화로숨기지않는다. 최초Python종료전source수정0을유지했다.

- [x] E11 최초 자체5실패 — `apps/cli/test/{document-extractors,drive-file-store,drive-source-tracer,output-codecs}.test.ts`와필요최소 runtime/core교정. F1 PDF쪽/출력상한의실제추출텍스트가상한을넘는합성fixture·내부childstdout JSON의코덱sink등록/부모파이프범위/원문비노출. F2 Drive누적초과stream cancel은초과시점에아직열린stream으로실제취소를관찰하고이미닫힌stream정상동작을오류로취급하지않는다. F3 source-only의source_attempts는임시키binding행과실제추출attempt를구분해중복세대/work/누수0을관찰하며, OOXML too_large의file_id/current게시계약을기존source실패경로와대조해source상태·handoff·실제실패세대·포인터보존/임시정리를정확단언한다. 실제제품결함이면수정하며단순기대치맞추기는금지. 최초오류별원인/처분을한국어로남긴다.
- [x] E12 승인schema43통합 — `tooling/query-perf/src/{common-search-schema,common-search-compare}.mjs`, `tooling/query-perf/test/{common-search,common-search-db}.test.ts` 네파일만.0043실제filename/최종SHA상수·43manifest추가,baseline39/current43의schema/API/to/main·cost엄격일치,역사current42/미래44거부유지. 실제디렉터리43정상/0043누락거부뒤역사42/41/40/39를명시검증. DBactualto/API43기대만정확갱신하고역사1~42bytes/hash·role/cleanup/오류/시간/판정단언·프로토콜/fixture규모/성능조건/driver/runner는불변. 추가실질파일변경은중앙재조율.43성능재측정통과나과거측정소급을주장하지않는다.

E11→E12 새Terra medium순차. 수정중시험실행금지·compile만. 마지막실질수정은독립Sol표적후속의개별해결확인뒤, 실패한6파일의관련시험만최초실패재검증한다. Python/전체/이미통과한파일/새benchmark는반복하지않는다. W5확정08:47:13~09:02:13UTC/17:47:13~18:02:13KST동안신규compile/test/eval/측정도보류·정적작업계속·만료/조기반환자동해제.


### E11 최초 자체실패 처분

자체5건은정적근거상fixture/기대/등록누락으로교정했다. PDF원본문자와viewBox내실제추출문자를구별하여넓은쪽의실제10000자단언후501쪽으로500만초과를만든다. Drive닫힌stream은underlyingcancel이불리지않으므로열린highWaterMark0stream에서실제취소를단언하고닫힌경계는별도로단언한다. source-only의2temp_key binding행을2extraction으로오인하지않고1work/1extraction/1publication·attempt2·반복불변·정리를정확검사한다. too_large는success게시전이므로source.file_id null과handoff실제file/too_large세대/nullcurrent/0publication을검사한다. 내부childJSON pipe는원문포함내부ABI로sink예외를명시하고실제부모stdout/stderr누출0을단언한다. 제품코드변경0. W5중이므로compile은아직미실행이며E12최종compile에함께포함하고독립후속을받는다.


E12: 중앙승인네파일에43정확manifest·baseline39/current43 provenance·역사current42/미래44/누락/추가/rename/변조거부·DBactualto/API43기대를추가했다.0001~0042지문차이0·검색/측정의미불변. E11포함최종build/typecheck/diff exit0, 시험미실행. 다음독립표적2건뒤실패6파일만관련재검증한다.


### E11/E12 독립 표적 후속

서로독립인Sol medium2명이 최초21개오류의자체5건/통합16건을분리해현재diff·권위계약·정확시험도달로개별확인했고추가확정결함0이다. E11은viewBox/stream닫힘/2binding1attempt/success-only게시/내부pipe예외를직접대조했으며기대완화로판정하지않았다. E12는0043실제SHA·baseline1~42bytes/hash·승인네파일diff·역사guard·측정의미불변을직접확인했다. 관련6파일실제재검증은W6해제뒤수행한다. 전체/Python/성능반복은하지않는다.

최초하위full worker-show 원문에서 dispatch.depth=1을확인해ready영수증과함께보존했다. 최초조사failed이력은유지한다. 비노출계획실패와R2 blind floor미달도최종리뷰결과에서삭제하지않는다.


## Auto Run Result

상태는 **built**다. 사용자 인수done·운영설치배포·실Drive연결 완료와 구별한다. 원본baseline `fd4532f415e08da0ffbbb33822c04dd401fd49f7`, 정상통합source base `e8a80b18451b43a14157cf673f40c28531b7dbb9`. 그뒤중앙문서전용main변경은 실행source를바꾸지않고보존했으며 main병합/push와중앙state수정은하지않았다. 자기브랜치의범위commit/branchpush와정확원격SHA는전용최종보고및Git기록에남긴다.

### 구현과 경계

- Node runtime의PDF.js6.4.299 텍스트경로와Mammoth1.13.0 원시텍스트·OOXML구조검증을 DocumentExtractor로주입하고 일반CLI조립/로컬첨부/Drive임시reader에연결했다. 바이너리를text보다먼저 bytes로판정한다. PDF쪽별locator/page사본, DOCX빈문단·표를포함한원본문단1기반block을유지한다. bbox는생략하고이미지PDF는0chunk성공이다.
- 입력PDF/docx50MiB,PDF2000쪽,docx실제해제200MiB,출력500만코드포인트와bounded file/source읽기를적용한다. parser는256MiBV8heap/60초child와부모30MiB출력제한·close회수로격리한다. canvas/native renderer/새Python실행기/OCR/HWP는추가하지않았다.
- doc/2+pdfjs-6.4.299+mammoth-1.13.0 버전및0043 Store/fake/계약/PG검사marker·workversionpin·source후속scan과승계를추가했다. 새지원bytes의과거unsupported만버전별한번재큐잉하며비대상재판정·native비대상반복scan을억제한다. 성공전current를바꾸지않고실패/한도초과는기존성공을보존한다. source-first/claim/attempt/generation/version/hash/CAS·disconnect/redaction fence와소유temp수명을유지한다.
- 0001~0042 원문42개/hash불변,0043 SHA256 `c0eb6f1c8339ae4bbdebdf689e7bbcf24b4ac12c0c2395f3992203ff5e69a410`. plugin0.1.23/ref598497c불변. 검색SQL/점수·19.5runner/config/driver는미수정이다. 중앙승인네query-perf파일은43고정manifest/엄격provenance/역사guard호환만변경했으며43성능재측정또는과거실측소급을뜻하지않는다.
- 정확고정의존/전이27개license·engine·설치package메타데이터와lock SHA를로컬증거에보존했다. PDF.js Apache-2.0, Mammoth BSD-2-Clause, yauzl MIT, JSZip MIT선택, xmldom MIT, @types/yauzl MIT. optionalcanvas설치부재를확인했다.

### 실제 검증과 최초실패 처분

개발·리뷰수정중시험실행0,수락시험코드는계속작성하고build/typecheck/diff로만확인했다. E10마지막독립후속뒤전용PG/role/home/venv/tmp/Clock/가짜HTTP에서다음최초전체를순차각1회실행했다.

| 실행 | 실제 결과 |
| --- | --- |
| 전체 `VITEST_MAX_WORKERS=2 pnpm test` | 08:28:57~08:38:54UTC exit1,226파일중220pass/6fail,4916pass/21fail/1skip |
| 전체 `pnpm test:python` | 08:38:54~08:46:05UTC exit0,16파일73시험모두pass;내부Python unittest와hook보존실행도원문에포함 |
| E11/E12최종compile | build/typecheck/diff각exit0, 독립Sol2명의자체5오류/통합16오류개별확인완료 |
| 실패6파일관련 `pnpm exec vitest run …` | 09:14:51~09:15:42UTC exit0,6파일157시험모두pass |

최초TS전체가녹색이었다고쓰지않는다. 최초21개오류는E11자체5개fixture/기대/내부sink등록교정과E12중앙승인schema43호환16개로분리하고독립표적확인후동일실패6파일의실제관련통과로해소했다. 나머지220파일의최초통과와Python73통과는그대로보존하고전체/이미통과파일/Python/새benchmark를반복하지않았다. 원문·명령/시각/exit/SHA256/source manifest는 `.brain-automation/tickets/8.4/`에보존한다.

### 리뷰 및 개별 후속

R1유효네렌즈18개판정(high1/medium16/false1)과비독립최초원문18개(high1/medium15/false2)를각각triage에남겼다. 지휘자diff의계획노출로세렌즈를새Sol에재배정해독립성을복구했고최초의도Task failed를보존했다. R2실제8개판정(high1/medium7)은E7~E9및세명독립집중후속에서개별확인했다. R2blind는7건으로floor10미달failed이므로검사성공으로바꾸지않았다. R3에서추가F-R3-P1(high1)을E10으로수정하고동일독립리뷰어가정확병합조건/형제본문/원본block·시험도달을재확인했다. E11/E12마지막실질변경도별도독립Sol2명이각오류의권위계약/정확시험도달을확인했다. 총high0문구로개별해결을대체하지않았다. 현재미해결확정결함0, deferred0,추가후속리뷰권고false다.

### 소유 자원과 증거

최초하위ready영수증및full worker-show의dispatch.depth=1,ownRun `run_ebbc1c8510ae`의Task/Dispatch/receipt·원문보고·체크포인트를보존한다. 중앙Run을run-use하거나타caller신원을쓰지않았다. 동시에소스편집한구현자는항상하나이며Terra6Task뒤순차교체했다. 독립리뷰는Sol medium으로수행했다.

자기전용PG관리자container는정확label확인뒤제거했고, 원문생성로그의정확container311개/volume1개전부부재를확인했다. 자기checkout밖HOME/tmp/cache/venv/Dockercontext/statuswrapper루트도제거·부재확인했다. 초기감사기의대소문자부재분류오류는원문을보존하고정확exit1/error/CID로교정했다. 운영·다른티켓자원정리/전역context/서비스시작/비밀복사0. OrbStackstatus만실제CLI로위임/그외exit2인wrapper본문·SHA·실제제한PATH선택·위임stdout/stderr/exit와Compose/socket검증증거를보존한다. 워크트리·브랜치·세션·gitignored실행증거는보존한다.

### operator_actions와 한계

이티켓의필수운영자인계조치없음. 실계정로그인/실Drive/실문서는사용하지않았으며설치본배포·이Mac실사용확인은후속티켓의인수표면이다. FileStore 사용자adapter는필수getBounded를제공해야하며구형get-only는타입/Brain조립에서즉시거부한다.

V8heap상한은Buffer를포함한OS전체메모리하드한도가아니다. 입력/해제/출력제한과child격리로파서폭발을제한하지만모든OS자원부족을막는다고주장하지않는다. PDF배치공백은font크기기반휴리스틱이며모든RTL/세로쓰기/회전을검증하지않았다. DOCX제거후보안의marker완전누락허용은Mammoth변환에맞춘의도된범위이며모든미래변환의손실검출을보장하지않는다. source재시작일부는새Store/Brain재조립이며binaryCarry SIGKILL결합전체나모든DB열의반복byte불변을단일시험으로증명하지않는다. 사진은image MIME사전선별후다운로드0,나머지후보는bytes확정이며octet-stream실제사진의최초다운로드0까지주장하지않는다. 정상내부pipe비노출시험과기존사용자코덱검사를수행했지만모든미래오류출력의안전을전칭증명하지않는다. 이관찰한계는원문독립보고와구별해보존하며미충족필수AC를defer로숨기지않는다.
