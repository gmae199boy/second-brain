---
title: 'Drive OAuth·설정·연동 해제'
type: 'feature'
ticket: '3'
created: '2026-11-08'
status: 'blocked'
baseline_revision: '9004c35b20c1b38b66af795668056ecdcdbaa1a9'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 4
followup_review_recommended: false
context: ['_bmad-output/personal-brain/automation/runbook.md']
warnings: ['oversized']
deferred: []
blocking_condition: >-
  최초 전체 Python 회귀의 Garmin core 2건 및 native 1건이 미해결이다. 중앙이 19.11에 수정 소유를 배정했으며 정확한 수락 source SHA 인계 뒤 해당 파일만 통합 대조·관련 재검증한다.
---

<intent-contract>

## Intent

**Problem:** 8.1·8.2의 Drive 원본 이전과 외부 색인은 주입된 adapter로만 연결되며 일반 설치 CLI의 OAuth·예약·안전한 해제가 없다. 해제와 진행 중 publish·로컬 삭제 사이의 경합은 마지막 접근 가능한 사본을 잃게 할 수 있다.

**Approach:** desktop OAuth와 비밀 코덱, 지속 연결 상태와 generation fence·프로세스 간 I/O 장벽, sources 명령과 공통 예약을 연결한다. 가짜 HTTP OAuth/Drive와 격리 PG/home/Clock으로 공개 표면과 경합을 입증한다.

## Boundaries & Constraints

**Always:** 기존 8.1 검증→home→보관삭제, 8.2 source별 접근 경고·정상 동일내용 원본·가림·current 세대·임시bytes 소유를 보존한다. 외부 I/O 동안 DB 쓰기 transaction을 잡지 않는다. 토큰/secret/code/verifier/session URI/외부 오류 원문은 queue·doctor·로그·보고에 내보내지 않는다. 비밀은 코덱의 0600 `.env`, 사용자 설정은 DB, access token은 메모리뿐이다. 해제는 새 sync 청구/예약을 막고 진행 일감의 늦은 확정과 로컬삭제를 차단한 뒤 토큰을 삭제한다. Drive delete는 0회다.

**Never:** 실제 계정·credential·로그인·MFA·실Drive·운영자원 사용, 중앙 state/main 변경·merge/push, 검색 점수/순위/성능 runner(22.3 소유) 변경, 과거 0001~0041 migration 바이트·역사 기대 변경, 불필요 release 변경, 8.5의 보관 due 재계산 구현을 선행 호출하는 역의존. 개인 홈 절대경로와 실제 비밀을 문서·프롬프트·commit에 쓰지 않는다. 개발·리뷰 수정 중 시험 실행 금지, 컴파일 확인만.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| OAuth 정상 | 합성 desktop client, 실제 loopback HTTP callback | 임시포트·PKCE S256·state·offline·readonly+file scope, 일회용 code 교환, Brainroot 생성·DB root, 0600 refresh 저장 | access token 저장/출력 0 |
| callback 경계 | state 불일치·거절·중복·timeout·취소 | 교환/저장하지 않음, listener/타이머 종료, 고정 안전 오류 | code/verifier/외부 원문 비노출 |
| refresh | 새 실행·동시 요청·401 | 실행마다 refresh, 같은 실행 동시 refresh 직렬화, 401 뒤 refresh 한 번만 | 계속 401은 로그인 필요 |
| 인증 만료 | invalid_grant | 재동의 필요 doctor, queue 재시도 없음 | 토큰 없는 고정 코드 |
| 일시 오류 | 429·rate-limit403·5xx·network | 일시 오류, Retry-After 이전 재청구 없음 | 확정 403/404 접근불가와 구별 |
| 설정 | watch folders·interval·keep_local_days | DB 유지·기본 interval30/keep30, 잘못된 타입·음수 거부, no-op 변경 이벤트 | 뒤 8.5 due 재계산 호출 없음 |
| sources 표면 | connect/add/list/remove/sync/disconnect | CommandSpec·SDK·metadata 1:1, 출력 코덱, 일반 CLI/daemon 조립 | 비밀 입력을 argv/출력에 싣지 않음 |
| 해제 중 sync | HTTP/추출 진행 장벽 사이 disconnect | 예약 중지·신규 청구 금지·generation 증가, 늦은 handoff/publish 거부, 재시작에도 해제 유지 | 취소 일감 재시도 부활 없음 |
| 해제 중 삭제 | 원격 검증 뒤 local.delete 전 장벽 | 프로세스 간 직렬화로 disconnect 완료 뒤 local delete 0, 미실행 삭제 취소 | 불명 소유/크래시는 보수적 보존 |
| 검색 유지 | 해제 source와 정상 공유 원본 | 기존 세대·조각·이름 검색 유지, 해제 원본 링크만 경고 | 정상 공유 원본까지 불가로 만들지 않음 |
| 업그레이드 | schema40/41 합성 data·추출·설정·권한 | 새42 적용 후 기존 계약 보존·권한 유지 | 과거 migration bytes 불변 |

</intent-contract>

## Code Map

- `packages/core/src/ports/source-store.ts`, `packages/postgres/src/sources.ts`, `packages/core/src/testing/{fakes,contracts}/source-store.ts`: generation·source-first publish 잠금과 claim/scan/handoff 계약을 확장한다. 기존 bind/outcome에도 해제 경계를 확인한다.
- `packages/postgres/migrations/0041_sources.sql`: generation만 존재하고 연결 활성 상태가 없어 재시작 뒤 해제 판별 불가. 읽기 전용이며 새 `0042_drive_connection.sql`로 지속 상태를 추가한다. `packages/postgres/src/migrate.ts` CORE41→42와 현재 최신 기대만 올린다.
- `packages/core/src/files/drive-migrate-work.ts`: 원격 재확인과 local.delete 사이 장벽 공백. 기존 retention/root/hash 확인을 보존하며 공유 I/O 잠금과 연결 fence를 잇는다. `packages/core/src/sources/` 및 추출 writer와 같은 순서로 설계한다.
- `apps/cli/src/config/codec.ts`: `.env` 기존값 보존·0600 write 패턴 재사용. `config/paths.ts`의 SECOND_BRAIN_HOME 경계. 안전한 읽기/원자 갱신/삭제·동시성, process env로 삭제 토큰이 부활하지 않는 정책을 둔다.
- `apps/cli/src/runtime/source-drive.ts`, `drive-file-store.ts`: headers/fetch/baseURL 주입점에 공통 인증·오류를 연결. `packages/core/src/ports/source-remote.ts` 오류 계약 확장.
- `packages/core/src/settings/index.ts`: CORE_SETTING_DEFINITIONS/normalize/getSetting/setSetting; keep_local_days 기존 정의 유지. 변경 이벤트는 기본 no-op.
- `packages/core/src/brain.ts`, `apps/cli/src/{assembly,dispatch,bin}.ts`, `commands/{index,sources-sync}.ts`, `mcp/serve.ts`: SDK·CommandSpec·metadata·정상 설치 조립. factory 시험만으로 완료하지 않는다.
- `packages/core/src/queue/{schedules,schedule-tick}.ts`, `apps/cli/src/daemon/run.ts`: 공통 schedule tick과 취소/재시도 경계. 별도 데몬/타이머를 만들지 않는다.
- `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/{checks}.ts`: 안전한 재동의 상태만 진단.
- `apps/cli/test/fixtures/fake-drive.ts`: loopback HTTP·요청 기록·barrier·fakeClock을 OAuth 교환/refresh와 경합용으로 확장. `tooling/test-db/src/index.ts`, `packages/postgres/test/fixture.ts`: 격리 PG·역할·migration·Clock. 고정 role이 클러스터 전역이므로 전용 컨테이너를 쓴다.

## Tasks & Acceptance

**Execution:**
- [x] E1 `packages/core/src/ports/source-store.ts`, `packages/postgres/src/sources.ts`, 새 `packages/postgres/migrations/0042_drive_connection.sql`, `packages/postgres/src/migrate.ts`, fake/contract/PG 시험 — 지속 연결/계정 상태·disconnect/remove·신규 enqueue/claim 금지·generation 전이·예약 중지/취소를 원자적으로 제공한다. 0042는 실제 상태 필요에만 사용하며 40→42/41→42 보존·권한을 덮는다.
- [x] E2 `packages/core/src/sources/`, `packages/core/src/files/{drive-migrate-work,extract-work}.ts`, PG source/drive/work 경계·관련 시험 — 진행 sync/추출의 늦은 stage/handoff/publish 거부와 local delete의 프로세스 간 I/O 장벽을 완결한다. 원격 I/O 밖 쓰기 transaction, 잠금 순서/복구·중단·취소 재시도 불가를 실제 PG와 파일 장벽으로 관찰한다. source별 접근불가·공유 정상 원본·검색 보존을 유지한다.
- [x] E3 `apps/cli/src/config/codec.ts`, 새 `apps/cli/src/runtime/drive-oauth.ts`, 공통 인증 adapter·가짜서버·관련 시험 — desktop loopback·PKCE/state/timeout/일회용·안전한 credential 입력과 0600 비밀 원자 저장/삭제·refresh 직렬화·Brainroot 생성/DB root를 구현한다. 실제 HTTP callback과 재시작/부분실패·누출 행렬을 덮는다.
- [x] E4 `apps/cli/src/runtime/{source-drive,drive-file-store}.ts`, core source error/work retry 및 doctor·관련 시험 — invalid_grant/401/429/5xx/network/Retry-After를 공통 정책으로 연결하고 무한 refresh·원문 유출을 차단한다.
- [x] E5 `packages/core/src/settings/index.ts`, Brain sources SDK, CLI commands/metadata/dispatch/assembly/bin·daemon 예약·관련 시험 — watch folders/interval/root와 no-op 변경 이벤트, connect/add/list/remove/sync/disconnect 표면·출력 코덱·일반 설치 및 daemon 공통 예약을 연결한다. add/remove가 source 정체성과 계정 단일 cursor를 보존하고 재연결 generation을 안전하게 전이한다.
- [x] E6 `apps/cli/test/`·`packages/{core,postgres}/test/`·`tooling/test-changed/rules.mjs`·fixture 지침 — matrix 전체의 공개 명령/HTTP·PG 경합·설정 지속성/권한·비밀 비노출·정리 관찰을 완성하고 새 SQL/자식 경로 선정규칙과 후속 8.4~8.8 재사용 명령을 문서화한다.

- [x] E7 `packages/postgres/src/{schedules,sources,work}.ts`, `packages/core/src/settings/index.ts`, `apps/cli/src/{runtime/drive-runtime,daemon/run}.ts`와관련시험 — R1 EC1/5·BH4/5/6/7을수정한다. 예약발화/해제/설정변경잠금순서를통일하고 config watch저장과generation/진행claim취소를같은transaction에묶는다. 정규화동일값은generation/일감을불필요변경하지않는다. 불명삭제표식의고정안전코드/복구안내를공개disconnect까지보존하고,Drive reconcile오류가무관한공통예약/drain을막지않게한다. 실제두PGbackend잠금경합·설정실패원자성·무관work진행시험을작성한다.
- [x] E8 `apps/cli/src/runtime/{drive-oauth,drive-http,drive-runtime}.ts`, `config/codec.ts`와관련시험 — EC2/3/4·BH1/2/8/9. 최초연결실패가미확정계정을영구고정하지않도록준비/확정과안전재선택을구분하고기존root의계정/폴더/MIME/trashed/접근을확인한다. 정상타프로세스refresh회전과삭제·계정변경을구별해제한적으로최신credential을사용한다. 캐시불일치로정상daemon작업을비재시도인증실패로닫지않는다. Retry-After Date범위검증. 공개동일계정재연결/다른계정거부·root실패·두auth인스턴스/프로세스회전경합시험을작성한다.
- [x] E9 `apps/cli/test/{sources-commands,daemon-run,drive-oauth,drive-http}.test.ts`, `packages/postgres/test/{drive-migration,migrate}.test.ts`,자식fixture/지침 — VG1/2/3·IA1/2/4/5/6·BH10의필수관찰보강. 공개명령중disconnect의진행HTTP/늦은publish·토큰삭제/검색/예약·delete0,고유감시/비감시문서와remove후접근상태,실제runDaemon회차/지속auth/오류격리,동일계정재연결의ID/cursor/폴더/예약보존,5xx/오류·전체격리home/출력로그합성비밀검사,자기컨테이너재생성뒤keep_local_days보존을작성한다. 삭제표식뒤자식SIGKILL및살아있는worker의DB세션만손실시보수장벽/파일·타인보존을관찰한다. 시험실행금지·컴파일만유지.

**Acceptance Criteria:**
- Given 격리 홈과 합성 OAuth/Drive, when 일반 sources connect와 실제 HTTP callback을 실행하면, then root가 생성·저장되고 refresh만0600으로 남으며 모든 출력/로그/queue/doctor에 합성 비밀이 없다.
- Given invalid_grant/반복401/일시실패 fixture, when SDK·CLI·daemon이 요청하면, then matrix의 고정 분류·1회refresh·Retry-After 및 비재시도/doctor 상태를 관찰한다.
- Given sync·추출·localdelete가 지정 장벽에 걸려 있을 때, when 다른 프로세스가 disconnect를 완료하면, then 신규 청구·늦은 게시/삭제·취소일감 부활이 없고 Drive delete0이며 기존 문서 검색/경고가 유지된다.
- Given schema40/41의 합성 기존 data/설정/권한·가린 내용·정상동일원본, when42로 업그레이드·재시작하면, then 기존 계약과 해제 지속성 및 설정을 보존한다.
- Given source 폴더와 interval 설정, when 공통 runtime tick과 add/list/remove/sync를 호출하면, then CommandSpec/SDK/meta와 출력 코덱이 일치하고 등록/중지된 예약만 실행된다.

## Implementation Notes

- E7: source→schedule잠금순서와PG감시설정저장/generation/claim취소/신규sync원자성을보강하고동일값세대/일감변경을피했다. 공개disconnect에DB_LOCKED고정안내보존·Drive reconcile오류에도무관공통tick/drain계속으로수정했다. 두PGbackend잠금경합/설정rollback·동일값·무관daemonwork시험작성,build/typecheck/diff체크각0(구현자보고),시험미실행. 후속독립해결확인전완료체크하지않는다.

- E6: matrix행별시험경로/이름을로컬보고에감사하고실HTTP중해제/실추출chunk장벽·공유검색/가림·실파일삭제/PG잠금대기·0040/41해시및41→42보존시험을보강했다. fixture지침에격리자원/Clock/명령·정리/불명잠금복구를기록하고선정규칙을연결했다. 마지막시험추가후build/typecheck/diff체크종료0(구현자보고),시험실행0. 장기실행daemon프로세스의오류주입은없고공통runtime tick/drain경로를시험코드로덮는다. 독립4렌즈로공백과필수성판단을확인한다.

- E5: drive-runtime으로일반dispatch/기회drain/daemon에같은auth/remote/temp/FileStore/control SDK를조립하고6sources동사·metadata·출력코덱/안전동의URL을연결했다. watch_folders정규화·기본interval30·no-op변경이벤트와공통schedule,add/remove의generation전이/진행sync취소를작성했다. permissionId계정바인딩·다른계정거부·remove는감시제거/disconnect는토큰삭제로구분한다. source root/Brainroot혼동은피하지만모호한옛root귀속/복수source는오류이고전역local-delete보수중지는유지한다. 마지막소스build/typecheck종료0,뒤에추가한daemon tick시험타입검사는T53해제뒤E6필수확인. 시험미실행이며일반명령/PG/가짜callback/예약시험은작성상태다.

- E4: 공통drive-http를source/BrainFileStore/최초root요청에연결했다. invalid_grant/refresh401은AUTH_REQUIRED·Drive401뒤1회refresh후반복401은AUTH_LOGIN_REQUIRED·429/rate-limit403/5xx/network는TEMPORARY,Retry-After초/HTTP날짜를Clock기준으로queue까지전달한다. 실패기록기반doctor재동의안내와성공sync실패해제·공유원본fallback을작성했다. 실제memory queue/doctor와가짜OAuth연결시험작성,시험미실행·build/typecheck/diff체크종료0(구현자보고). 일반설치auth주입/SDK·CLI·daemon조립은E5미완료다.

- E3: loopback/PKCE/state·일회용callback/timeout·취소와코덱0600원자rename·프로세스간env/connection잠금·refresh동시요청합치기·파일자격증명재확인·DBroot설정/원격appProperties루트재사용을작성했다. 실제HTTP/합성OAuth·root부분실패·PG설정·0600·refresh/해제/코덱경합시험작성,시험미실행·build/typecheck/diff체크종료0(구현자보고). E4공통HTTP오류·doctor와E5일반CLI/SDK/예약조립미완료. 다른홈최초동시루트생성/불명잠금복구는독립검토대상이다. 한도중단과재설정·T49유한창/조기반환은로컬증거보존,최종중앙수신처는명시통지로run_eeb956b860e8에갱신했다.

- E2: source-first generation/connected·claim재확인을scan/stage/handoff/bind/outcome까지연결하고별도PG세션advisory lock과지속삭제표식으로disconnect/local.delete를직렬화했다. 외부I/O중쓰기transaction없음. 프로세스간실파일삭제fixture/늦은publish·공유원본시험작성,시험미실행·build/typecheck/diff체크종료0(구현자보고). 불명표식은자동회수하지않고DB_LOCKED로보존한다. 계정↔Brainroot매핑부재로모든Drive삭제를보수중지하는제한과remove=disconnect의임시동일의미는E3/E5조립에서해결/범위확정하며최종완료로세지않는다. 독립리뷰에서장벽세션실패/잠금순서/복구절차를필수확인한다.

- E1: connected 지속 상태의0042/CORE42, connect/disconnect/remove·generation, 예약/일감취소와 enqueue/claim제한 및 fake/contract·PG/업그레이드시험을 작성했다. build/typecheck/diff체크 종료0(구현자보고), 시험미실행. diff대조에서source root와Brainroot매칭/진행I/O장벽은E2미완료로유지한다. 40→41역사시험은coreMaxVersion41로고정하고기대는보존했다. E1체크는E2와연결·검토후확정한다.

## Plan Change Log

- R1: EC/IA/VG/BH의위개별근거에따라E7~9를추가한다. 설정commit/fence분리·잠금역전·Drive오류의공통daemon중단·인증회전오분류와공개수락관찰공백을피한다. KEEP: 과거migration불변/0042forward,source-firstpublish·가림·정상공유원본,토큰비노출/0600·PKCE/state,취소삭제부활금지,외부I/O중쓰기transaction없음,공통Runtime/명령1:1,검색점수소유분리. intent-contract는불변이다.

## Review Triage Log

### 2026-11-08 — Review pass R1
- verdicts: 25 findings — high 2, medium 20, low 0, false 3, maybe-false 0
- 개별원문/코드대조후판정. 도착순EC→IA→VG→BH. 공통원인은묶되각행보존. 원시diff `/tmp/brain-83-review-r1.diff`보존,기존안전코드/다른범위를reset하지않고해당계약만E7~9재도출한다. 시험미실행.
- EC1 `[medium]` `[bad_plan]` schedule→source와disconnect source→schedule역전 — fireSchedule선취잠금과ensureWork공유잠금확인. E7통일/실경합시험.
- EC2 `[medium]` `[bad_plan]` 유효credential회전시캐시AUTH_REQUIRED — token캐시불일치분기refresh미호출확인. E8제한회복.
- EC3 `[medium]` `[patch]` 유한숫자도Invalid Date — parseRetryAfter는Date범위미검사. E8 getTime검사.
- EC4 `[medium]` `[bad_plan]` 기존root원격확인없음 — rootId존재시문자형식만확인후저장성공. E8폴더/접근확인.
- EC5 `[medium]` `[bad_plan]` 동일watch값도진행sync취소 — setSetting무조건이벤트/invalidate확인. E7동일값처분.
- IA1 `[medium]` `[bad_plan]` 공개disconnect경합관찰분리 — 공개명령은직렬,진행경합은Store직접호출. E9실공개경합.
- IA2 `[medium]` `[bad_plan]` 실제daemon회차대신수동조립 — E9/VG2로runDaemon검증.
- IA3 `[false]` `[reject]` 다중source제어표면차이 — 원문은정상공유원본보존이지다중Google계정운영요구가아님. PG조회/가림계약보존,단일계정제약은잔여위험에명시. 무관daemon차단은별도BH7로수정.
- IA4 `[medium]` `[bad_plan]` 비밀전칭주장대비선택단언 — E9격리home/출력/queue/doctor/log표식검사범위명시.
- IA5 `[medium]` `[bad_plan]` 실제컨테이너재생성관찰없음 — 원문verify명시. E9자기시험volume재생성/DB읽기.
- IA6 `[medium]` `[bad_plan]` 오류행렬관찰분산/5xxqueue공백 — E9실daemon/5xx시점관찰보강,분산시험자체는결함으로단정하지않음.
- IA7 `[false]` `[reject]` 정책안내는계획표면 — 원문은connect출력에반드시넣으라하지않음. 공식문서7일제약/운영자인계를계획과fixture지침에보존했으므로추가제품문구불필요.
- VG1 `[medium]` `[bad_plan]` watch범위실색인미관찰 — reviewer시험/검색근거수락. E9고유폴더문서/제거결과.
- VG2 `[medium]` `[bad_plan]` 실제runDaemon조립미검증 — reviewer근거수락. E9실회차.
- VG3 `[medium]` `[bad_plan]` 동일계정재연결공개CLI미검증 — reviewer근거수락. E8/E9공개보존관찰.
- BH1 `[medium]` `[bad_plan]` 실패한최초연결계정고정 — bindAccount선저장/후단실패rollback없음확인. E8준비/확정.
- BH2 `[medium]` `[bad_plan]` 기존root접근/폴더검증없음 — EC4와같은원인,E8.
- BH3 `[false]` `[reject]` 재연결시취소retention되살리기 — 원문이취소삭제작업부활금지명시. 취소로로컬보존은의도된안전계약이며8.5역의존/새삭제정책으로바꾸지않는다.
- BH4 `[high]` `[bad_plan]` config watch저장뒤fence분리 — DB설정commit후별도invalidate로제거폴더latepublish가능. E7원자경계/실패주입.
- BH5 `[medium]` `[bad_plan]` 예약/해제잠금역전 — EC1과같은원인,E7.
- BH6 `[medium]` `[bad_plan]` disconnect고정AUTH_STORAGE가표식복구정보소실 — stopped실패의DB코드무시확인. E7안전코드보존.
- BH7 `[high]` `[bad_plan]` Drive reconcile오류가전체daemon멈춤 — drainOnce조기return으로공통tick/drain미호출. E7기능오류격리/무관work관찰.
- BH8 `[medium]` `[patch]` Retry-After Invalid Date — EC3와같은원인,E8.
- BH9 `[medium]` `[bad_plan]` 두auth회전CAS패배를영구AUTH_REQUIRED — 응답저장만직렬화/이전토큰CAS실패확인. E8정상회전회복·삭제보존.
- BH10 `[medium]` `[bad_plan]` 실제자식kill/DB세션손실미검증 — 자식정상종료와callback예외만관찰. E9실실패경계.

## Design Notes

route full/pinned, risk high: 해제와 마지막 로컬 사본 삭제 사이 분산 I/O 경합 때문에 entry medium에서 올린다. source generation만으로 비활성 상태를 구별하지 못하므로0042 신규 forward가 필요하다. I/O 직렬화는 DB 쓰기 transaction을 원격 요청 동안 유지하지 않으면서 여러 프로세스에 적용되고 죽은 소유자/불명 생존을 구별해야 한다. 구체 구현은 E1/E2 보고에 근거를 남긴다.

2026-11-08 공식 Google 확인: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)는 시스템 브라우저·desktop loopback·PKCE를 설명한다. [OAuth 수명](https://developers.google.com/identity/protocols/oauth2)은 External/Testing refresh token7일 만료를 명시하며 기본 프로필 scope 예외는 이번 Drive scope에 해당하지 않는다. [state 권고](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)를 따른다. 실제 동의·MFA·client 발급/게시상태 판단은8.8 운영자 몫이며 이번에는 시도하지 않는다.

## Verification

개발·리뷰 수정 중 **시험 실행 금지, 컴파일 확인만**: `pnpm build`, `pnpm typecheck`, `git diff --check`. 시험 코드는 계속 작성한다. 각 Task는 범위를 마칠 때까지 멈추지 않고 실제 차단만 failed로 보고한다. 최초 조사 ready 및 depth1은 로컬 영수증으로 보존했다.

최종 구현·독립Sol medium4렌즈와 필요한 후속 수정의 독립확인 뒤 커밋/push 전에만 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python`을 순차 각1회 실행한다. 최초 원시로그·종료코드·실패별 처분을 보존하고 실패교정 뒤 `pnpm test:changed -- 9004c35b20c1b38b66af795668056ecdcdbaa1a9` 및 관련 시험으로만 재검증한다. 모든 matrix 시험이 실제 실행됐는지 최종 감사한다.

예정 핵심 시험: core `source-sync/drive-migrate/settings/contracts/document-extract/doctor`, PG `source-store/source-resolution/drive-migration/migrate`, CLI `source-runtime/drive-file-store/drive-daemon-dispatch/command-meta/config/doctor-checks`와 새OAuth/명령 종단. 실제 추가 파일명/명령/관찰값은 구현 Notes와 최종 결과에 기록한다.

시험은 전용PGcluster/role/home/venv·checkout밖 소유TMPDIR·loopback가짜서버·주입Clock·산출물을 쓴다. legacy fixture 관리자암호와 자기DOCKER_CONFIG의 실제OrbStackcontext/Compose/socket을 검증하며 DOCKER_HOST/전역context·다른 소유자원 변경 금지다. 자원 정확ID·생성/정리·부재확인, callback HTTP 주입·가짜 요청/Clock/DB/파일 관찰과 한계를 로컬에 기록한다. raw비밀/증거는 공개Git에 넣지 않는다. 워크트리·branch·세션·증거는 보존한다.


### R2 Review Triage Log

R2 원문은 로컬 `review-r2-{blind-hunter,edge-case-hunter,verification-gap,intent-alignment}.md`에 보존한다. 아래 각 finding을 개별 판정한 뒤 같은 원인만 구현 과업에서 묶었다. 전부 정적 근거이며 시험은 미실행이다.

- R2-VG1 [medium] [bad_plan] watch 설정 성공 뒤 새 ID·source target·주입 시각의 대체 sync/청구 단언 부재. source-store 원자성 시험의 기존 cancellation/no-op 비교만으로는 생성 누락을 잡지 못함을 수락. E10 보강.
- R2-EC1 [medium] [bad_plan] add/remove의 폴더/fence commit 뒤 별도 addWork 실패, 동일 인자 changed=false 성공. runtime change와 PG updateSourceFolders를 대조해 확인. E10 원자 enqueue 및 실패 재시도.
- R2-EC2 [medium] [bad_plan] interval 저장 뒤 reconcile 실패, 동일값 Core 조기 반환이 복구 hook을 건너뜀. E10 재시도 복구.
- R2-EC3 [medium] [bad_plan] 동일 계정 재동의의 session 변경에 persistent auth가 첫 새 작업을 AUTH_REQUIRED 처리. 늦은 이전 응답 거부와 새 회차 초기화를 구별. E11.
- R2-BH1 [medium] [bad_plan] add/remove no-op 재시도 누락. EC1과 같은 원인, E10.
- R2-BH2 [high] [bad_plan] PG watch writer가 self 행 부재를 []로 간주하여 global fallback을 제거하지 못함. getSettings fallback과 writer no-op 비교 확인. E10 명시 override/메타데이터/원자 fence.
- R2-BH3 [medium] [bad_plan] 모든 설정의 유효값 no-op이 timezone·확장 설정의 명시 사용자 override를 소실. Core 조기 반환 확인. E10 기존 scope 계약 회복.
- R2-BH4 [medium] [bad_plan] interval 동일값 재시도 복구 공백. EC2와 같은 원인, E10.
- R2-BH5 [medium] [bad_plan] 지속 daemon의 재연결 첫 sync 실패. EC3와 같은 원인, E11.
- R2-BH6 [high] [bad_plan] 여러 source/account 불일치 reconcile 거절에도 공통 credential sourceSync adapter가 drain에서 실행 가능. 다중 계정 지원 추가 없이 모호한 Drive 작업 격리·무관 work 진행을 E11에서 검증.
- R2-BH7 [medium] [bad_plan] 새 refresh lock의 보수 복구 안내/진단과 실제 자식 종료 관찰 부재. 시간만으로 stale 제거 금지 유지, E12 명시 대상·소유/종료 확인과 안전 복구.
- R2-BH8 [medium] [patch] 비밀 검사 doctor 단독 호출은 USAGE. 실제 doctor run과 checks 구조 단언으로 수정, E12.
- R2-BH9 [medium] [patch] root discovery가 incompleteSearch를 요청/검사하지 않음. 빈/단일 불완전 목록으로 생성·확정 금지, E11.
- R2-BH10 [medium] [patch] container fixture finally의 첫 오류가 나머지 소유 자원 정리 시도를 중단. 개별 소유 확인·독립 정리·실패 집계/잔여 ID 기록, E12.

R2 intent-alignment는 새 명백한 의도 위반을 확정하지 않았다. R1 IA1/2/4/5/6의 관찰 보강을 인정하되 공개 다운로드/handoff와 저장소 publish, daemon 함수와 OS daemon, auth 인스턴스와 OS 프로세스, 합성 표식 snapshot과 모든 운영 시점은 구별한다. 이 구별을 보존하고 전칭 통과 주장을 하지 않는다. 다중 계정 운영·connect 출력 정책 위치에 대한 R1 reject는 유지한다.

### R2 실행 보강

- [x] E10 설정/folder mutation 원자 enqueue, scope 상속·명시 override·no-op 메타데이터, 실패한 interval 후처리의 동일값 재시도와 실청구 단언. 시험 실행 금지·컴파일만.
- [x] E11 인증 회차 갱신/옛 응답 fence, 모호한 Drive 계정 source 작업 격리, incomplete root discovery 거절. 실제 daemon 재연결·타계정 보존·root 생성0 시험 코드. 시험 실행 금지·컴파일만.
- [x] E12 refresh lock 복구 진단/지침·자식 종료 시험 코드, 실제 doctor run 구조 단언, container fixture 독립 정리/실패 집계. 시험 실행 금지·컴파일만.

계획 보강은 intent-contract를 변경하지 않는다. R2 수정·필요한 독립 후속 뒤 최종 전체 TS→Python 순차 회귀를 각 1회 수행한다.


### R3 Review Triage Log

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- R3 verification-gap 원문은 `No verification gaps found.`, edge-case-hunter는 `[]`. intent-alignment는 새 명백한 의도 위반을 확정하지 않았으며 R2의 관찰 표면 한계는 carried로 보존한다. 실행 통과 주장은 하지 않는다.
- R3-BH1 [medium] [bad_plan] 새 remote guard가 validateSource의 DB_UNAVAILABLE/DB_LOCKED를 TEMPORARY로 변환한다. remote error union에 DB 코드가 없고 wrapper가 일괄 변환함을 확인. 후속 metadata/download에서 발생한 DB 실패가 queue attempt를 소진하지 않도록 오류 경계/전파와 실패 주입을 E13에 추가한다.
- R3-BH2 [medium] [bad_plan] carried R2-BH5의 잔여 위험이나 원인이 더 좁아졌다. authForRound는 claim 전에 A를 샘플링하고 reconnect B 뒤 새 work를 같은 drain이 청구 가능하며 expectedCredentials A가 AUTH_REQUIRED를 낸다. 이전 회차를 B에 재귀속하지 않으면서 새 작업은 비재시도 실패로 닫지 않는 경계와 결정적 장벽 시험을 E13에 추가한다.

blind-hunter는 정적 검사를 마쳤으나 고정 floor 10건 중 근거 있는 2건만 발견하여 Task outcome failed로 보존한다. 원문/실패를 성공으로 바꾸거나 수를 맞추려고 결함을 만들지 않는다. 이 실패는 제품 실행 실패나 코드 조사 미수행과 구별한다. 확인된 두 위험을 수정하고 독립적인 집중 후속 검사로 해결을 입증하며, 최종 보고에서 건수 조건 미충족을 공개한다. R1/R2의 동일 lens 독립 검사는 보존한다.

### R3 Plan Change Log

intent-contract 불변. KEEP: 원격 요청 전 계정 격리, 무관 work 진행, 이전 동의 요청의 CAS/source generation fence와 비밀 미노출. E13은 DB 장애의 attempt 반환과 claim 전후 동의 변경의 안전 재시도를 보강한다. 기존 기능을 전면 재설계하지 않고 해당 경계만 재도출한다.

- [x] E13 remote guard DB 오류 분류 전파와 auth sampling/claim 경합의 새 work 보존, 결정적 경계 시험 코드. 새로운 Terra medium 구현 세션으로 진행하고 시험 실행 금지·컴파일만 유지.


### E13 집중 후속 Review Triage Log

- verdicts: 4 findings — high 0, medium 4, low 0, false 0, maybe-false 0
- SAF1 [medium] [patch] OAuth 세션 전이 기대값 불일치. 각 반환 분기는 AUTH_SESSION_CHANGED이고 기존 assertion은 AUTH_REQUIRED. 최초 credential 없음·실제 invalid_grant는 유지하여 해당 전이만 E14에서 수정한다.
- VER1 [medium] [bad_plan] 새 추출 work와 source_handoff 미연결로 remote guard 경로에 도달하지 않는 fixture. 검증 lens의 경로 근거를 수락하며 E14에 handoff/candidate 선행 단언·실패 guard 관찰 횟수 추가.
- VER2 [medium] [patch] OAuth 전이의 오래된 기대값. SAF1과 같은 원인, E14 해당 분기 수정.
- EDGE1 [medium] [patch] OAuth 전이의 오래된 기대값. SAF1과 같은 원인, E14 해당 분기 수정.

R3의 두 제품 결함은 세 독립 집중 검사에서 수정 경로를 확인했다. 기존 안전 경계를 KEEP하고 fixture 경로만 보강한다. 새 제품 기능이나 오류 정책 변경은 하지 않는다.
- [x] E14 OAuth 세션 전이 assertion 갱신과 추출 handoff/candidate 연결·guard 도달 증명. 시험 실행 금지·컴파일만. 이후 검증 reviewer의 좁은 후속 확인을 받는다.


### E14 독립 재확인

`review-e14-verification.md`에서 OAuth 전이/최초 부재/invalid_grant 구분과 추출 handoff/candidate·guard 실제 실패 횟수 단언을 독립 확인했다. 추가 발견0. E1~E14 개발 수정과 필요한 독립 후속을 마쳤으며, 전체 TS→Python 순차 회귀의 최초 실행을 진행한다. R3 floor 미충족 failed 이력과 관찰 한계는 보존한다.


## 최종 회귀 실패 처분 및 E15/E16

이전 Implementation Notes는 각 Task 당시의 이력이다. 아래 결과가 현재 구현·시험 상태다. 전체 시험 미실행이라는 과거 기록은 최초 실행 결과로 덮어쓰거나 삭제하지 않는다.

- [x] E15 최초 전체 실패의 한국어 문구·doctor 요약/standalone context·최신 schema catalog/installed 신원·현재 migration 자식·refresh 자식 생존/close 관찰을 수정했다. source 장벽 원인 미확정으로 Task failed를 보고한 이력은 그대로 보존하고 E16에서 이어 처리했다.
- [x] E16 connected 기본값 정확 기대, 별도 autocommit 통계 observer, write schema guard 성공 뒤에만 Drive 조립하는 순서를 구현했다. DB 불가 hook의 반복 연결 지연을 제거하고 합성 store의 schema1회·Drive조회0·spool/close 관찰을 추가했다. source 장벽이 최초에 통계 snapshot 때문에 실패했다고 단정하지 않으며 변경 후 실제 장벽과 결과의 통과를 확인했다.

| 최초 실패 묶음 | 원인/처분 | 관련 재검증 |
|---|---|---|
| doctor 44건·텍스트/요약·dispatch context | 새 `Drive refresh` 연속 영문을 한국어로 수정, 새 check/옵션 정확 기대 반영. 검사기 불변 | 관련 E15 파일 통과 |
| 최신 schema catalog/default | 새 삭제 장벽 테이블과 connected=true 정확 기대 누락 반영, 과거 migration/역사 경계 불변 | schema 전부 통과 |
| legacy CLI 3건 | 현재 installed 신원에 남은41을 등록 상수42로 교정, 역사 fixture 시작 버전 불변 | install-legacy-manifest 전부 통과 |
| upload 중단 자식 | 현재 스키마 검사에41을 써 장벽 전 반환. 실제 등록 상수와 즉시 close 관찰 사용 | drive-migration 전부 통과 |
| refresh 잠금 자식 | 미해결 Promise만으로 이벤트 루프를 유지하지 못함. 살아있는 소유자 유지와 fork 직후 close 관찰 | drive-oauth 전부 통과 |
| source-before-schedule | 관리자 transaction의 통계 관찰을 별도 autocommit observer로 분리, 실제 blocker PID/실대기·fired=false 유지 | source-store 전부 통과 |
| DB 무응답 hook 시간창 | schema guard 전 Drive 조회가 여러 연결 timeout을 소비. schema 실패 시 Drive조회0·원래 spool 보존 | postgres CLI 전부 통과, 시간 기대 불변 |
| bootstrap 7건(TS)/8건(Python) | 격리 HOME에서 실제 OrbStack 상태 조회 실패. 자기 PATH의 조회 전용 `orb status` 중계로 실제 서비스 상태를 확인하고 나머지 제품 HOME/DB/설정은 격리 유지. 서비스 시작/전역 변경 없음 | Python 보존 case 포함 hook8건 통과 |
| Garmin core2/native1 | core는 sendPhoto 기대1/실제0(:161), document500→200 단언은 통과. native는 표시 work_id의 card_number 가림 결과를 SQL UUID로 재사용(:96/:197). 서로 다른 실패이며 중앙19.11 소유 | 미해결. 이 브랜치에서 해당 파일·공통 가림/runner 수정하지 않음 |

## Auto Run Result

현재 상태는 **blocked**다. 8.3 제품 구현·독립 리뷰·자체 회귀 교정은 완료했으나 최초 전체 Python에서 남은 다른 소유의 세 실패가 아직 재검증되지 않아 built로 표시하지 않는다. 중앙의 정확한 수락 source SHA가 오면 해당 Garmin 파일만 대조·통합하고 관련 시험으로 확인한다. 전체 suite를 다시 돌리거나 이 실패를 deferred로 숨기지 않는다.

### 구현 결과와 파일

- CLI `runtime/drive-{oauth,http,runtime}.ts`, `config/codec.ts`, `commands/sources-control.ts`, command registry/dispatch/assembly/daemon: 합성 HTTP로 검증 가능한 desktop OAuth·PKCE/state/loopback·비밀 저장/삭제·refresh·계정/root 연결·6개 sources 동사와 공통 예약.
- Core Brain/ports/settings/source sync 및 추출/이전/삭제/queue: 연결 generation fence·설정 원자성·DB 오류 원분류·동의 변경 시 claim/attempt 반환과 다음 회차 재시도·기존 current/공유 provenance 보존.
- PostgreSQL `0042_drive_connection.sql`, migrate/sources/settings/work/schedules/drive-barrier: 지속 connected와 불명 삭제 표식·source-first 잠금·별도 세션 I/O 장벽. 0001~0041 바이트 불변,40/41→42 데이터·권한 보존.
- CLI/Core/PG 시험과 자식 fixture·소유 컨테이너 cleanup·`tooling/test-changed/rules.mjs`·Drive fixture 지침: 공개 명령/실제 daemon 함수 회차·HTTP/PG/파일 장벽·중단/세션손실·설정/역사·비밀 표식·복구 및 정확 소유 정리.

### 검증 결과

- 개발·리뷰 수정 중 시험 실행0, 각 구현 Task의 build/typecheck/diff compile 결과 보존. 최종 E16 build/typecheck/diff 종료0. 초기 compile 실패는 수정 후 결과와 함께 로컬 보고에 보존했다.
- 마지막 E14 수정·독립 후속 뒤 전체 `VITEST_MAX_WORKERS=2 pnpm test`(2026-11-08 05:21:52~05:31:21 UTC): exit1,221파일 중211통과/10실패,4,719시험 통과/62실패/1skip.
- 이어 전체 `pnpm test:python`(05:31:21~05:38:13 UTC): exit1,16파일 중13통과/3실패,58시험 통과/11실패. 내부 Garmin unittest244개는 통과했다. 전체 실행은 각각1회이며 반복하지 않았다.
- E15 관련9파일 `vitest run`: exit1,313시험 중310통과/3실패. 최초/선별 실패 모두 보존했다.
- E16 관련 `dispatch`, PG `schema/source-store/cli`4파일: exit0,154시험 전부통과.
- 환경 교정 후 Python config의 bootstrap hook 단독: exit0,8시험 전부통과(`HOOK_PYTHON_PRESERVATION_PASS`).
- 마지막 dispatcher 정상 Drive 경로 `sources-commands/drive-source-tracer/drive-tracer`3파일: exit0,32시험 전부통과.
- 이 선별 재검증과 최초 전체 통과 파일을 합쳐 8.3 자체 실패는 해소됐다. Garmin 세 실패가 남으므로 전체가 녹색이라고 주장하지 않는다. raw 로그·명령/종료코드/파일별SHA256·정확 자원 영수증은 gitignored `.brain-automation/tickets/8.3/`에 보존한다.

### 리뷰 처분과 한계

R1 네 Sol medium lens:25개별판정(high2/medium20/false3). R2 네 lens:14개별판정(high2/medium12), 의도 lens는 새 명백한 위반 없음. R3 edge/verification은 무발견, intent는 새 명백한 위반 없음; blind는 근거 있는2건만 찾아 floor10 미충족으로 failed 이력을 보존했다. 두 제품 위험은 E13과 독립 안전/edge/verification에서 확인하고 E14 검증 결함 수정·독립 재확인을 완료했다. E15/E16도 각2명 좁은 독립 검사에서 새 확정 결함 없음과 관련 실행 통과로 확인했다. 실패/건수 부족을 성공으로 바꾸지 않았다. deferred0이며 R1의 false3은 기존 개별 반증에 따라 기각했다. 현재 미검증 high 수정은 없고 추가 리뷰 권고는 false다.

공개 다운로드/handoff와 저장소 late publish·별도 프로세스 삭제 I/O는 분리된 경계 시험을 조합한 증거다. daemon은 실제 함수 회차를 쓰며 OS daemon CLI 전체 수명주기의 모든 경우를 관찰한 것은 아니다. 정상 refresh 회전은 두 auth 인스턴스, 별도 자식은 잠금 소유/kill/보존을 관찰한다. 비밀 검사는 지정 합성 표식과 선택 실행 경로/출력·최종 home snapshot이며 모든 운영 시점에 대한 전칭 증명이 아니다.

### 운영 인계와 잔여 위험

- 실제 client 발급·동의화면 상태/게시·사용자 로그인/MFA·운영 계정/root 확인은 운영자 몫이다. 이번에는 실계정/OAuth 로그인·실Drive·운영자원을 사용하지 않았다. 공식 Google 수명·scope 근거는 Design Notes에 있다.
- 일반 CLI는 단일 Drive 계정/source 정책이다. 여러 기존 source나 계정 불일치는 원격 실행을 차단하며 무관 일감은 계속한다. 다중 계정 운영은 제공하지 않는다.
- 연결 해제는 모든 미실행 Drive local-delete를 보수 취소하고 하나의 해제 source도 로컬 삭제를 막을 수 있다. 취소된 삭제는 재연결로 부활시키지 않는다. 이는 마지막 사본 보존을 위한 보수 정책이다.
- secrets/connection/refresh 잠금과 삭제 불명 표식은 시간 경과로 제거하지 않는다. 소유자·자식·진행 I/O 종료와 정확한 파일/원격 결과를 확인한 운영자만 fixture 지침의 개별 복구 절차를 따른다.
- source watch root와 Brainroot는 별도이며, 연결·보관 due 재계산의8.5 역의존은 없다. 검색 점수/순위/성능 runner·19.5 runner·Garmin 소유 파일·plugin release는 변경하지 않았다.
- 자체 시험 자원 로그의271개 container ID와1개 volume 부재를 최종 확인했다. 관리자 container도 소유 label 확인 후 제거·부재 확인했고 checkout 밖 자기 home/tmp/Docker/uv 경로를 제거했다. bootstrap의 자기 Compose 자원은 시험 finally의 정확 ID 제거/부재 단언을 통과했다. 워크트리·브랜치·세션·로컬 실행 증거는 보존한다.
