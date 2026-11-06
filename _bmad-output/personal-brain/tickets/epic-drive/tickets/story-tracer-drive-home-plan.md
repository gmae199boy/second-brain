---
title: '8.1 가짜 Drive 원본 이전 tracer'
type: 'feature'
ticket: 1
created: '2026-11-06'
status: 'built'
baseline_revision: 'f1a2f22e1b6026aeeedec88ec310aefbdb947556'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 1
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md
  - _bmad-output/personal-brain/automation/runbook.md
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 로컬 첨부 원본을 검증된 Drive home으로 옮기는 경로가 없어 로컬 용량을 줄일 수 없다. 기존 FileStore 계약과 files show는 로컬/추출 조각에 묶여 있다.

**Approach:** 작은 합성 txt 하나의 업로드·검증·원자적 home 전환·보관기간 뒤 로컬 삭제·Drive 원문 읽기를 잇는다. 중립 FileStore 의미 계약과 루트별 영속 매핑을 재사용한다.

## Boundaries & Constraints

**Always:** 모든 Drive 연산은 `(root_folder_id, content_hash)` 매핑 하나로 remote id를 해석한다. locator는 순수 `<hex><확장자>`, 이름 검색 금지. 매핑 생성/재개/확정 저장 API 하나를 put과 이전이 공유한다. 동시 put도 확정 id 하나로 수렴한다. 외부 I/O는 DB 쓰기 트랜잭션 밖. expected-home·미가림 CAS 확인과 위치·verified_at·home·삭제 예약은 단일 withWrite. due는 검증 시각+DB keep_local_days. 삭제 직전 원격 사본을 재확인하고 불확실하면 로컬 보존. redact 삭제와 이전 보관 삭제는 구분한다. 기존 마스킹·추출 세대·문맥·페이징 계약 보존.

**Never:** 운영자원·실Drive·로그인·기존 사용자파일·credential 접근 금지. OAuth·외부색인·resumable·전체오류행렬·검색/점수/perf·batchwrite/canonical 개선·release 변경은 범위 밖. migration0040 존재/채택 가정·복사·placeholder/gap 금지. 0001~0039 바이트와 역사 기대 불변. 번호 없는 DDL 초안은 로컬에 보존하고 실제 등록 직전 중앙 번호 확정을 요청한다. 중앙 state/main 수정·병합·push 금지.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 이전 | 합성 txt, local home, 기본30 또는0일 | 검증 뒤 Drive home/verified/due 동시 확정; 0일 삭제, 30일 이전 보존 | 업로드/검증 실패면 home 불변 |
| 멱등/동시 | 같은 root/hash의 중복·동시 put/이전 | 매핑 하나·확정 원격 파일 하나 | 중단/응답 유실 재시도도 같은 정체성 사용 |
| 검증 | SHA256, MD5만, 둘 다 없음 | 우선순위대로 SHA256→MD5→되읽기 확인 | 불일치/잘못된 metadata는 실패·로컬 보존 |
| CAS/redact | 업로드 후 확정 전 home변경 또는 가리기 | 전환·검증·예약의 부분 확정 없음 | 새 원격 사본 안전 처분; 가리기 삭제 별도 확인 |
| 보관 삭제 | due 도달, 원격 소실/불일치/접근 실패 | 로컬 보존; 정상 원격이면 해당 local만 삭제 | 재시도 가능 경계와 기존 redact 동작 유지 |
| 소유 안전 | external, 잘못된 locator, root밖 id/부모 | 모든 연산 거부, 외부 삭제 0회 | LOCATION_REFUSED |
| 설정 | 기본/0/30/음수/소수/비정상 정수 | 기본30,0허용, DB읽기/영속·정규화 | 잘못된 값 거부 |
| 원문 보기 | 이전·로컬삭제 뒤 files show | 가짜 Drive GET을 관찰하고 원문을 기존 마스킹/문맥 출력 | 원격 실패를 DB본문 성공으로 숨기지 않음 |

</intent-contract>

## Code Map

- `packages/core/src/ports/file-store.ts`, `domain/file.ts`, `testing/contracts/file-store.ts`: put local 고정과 local locator 단정을 일반화. local shard·symlink 시험은 `apps/cli/test/file-store.test.ts`에 보존.
- 새 `apps/cli/src/runtime/drive-file-store.ts`와 가짜 HTTP fixture: root/baseURL/Clock/매핑 주입, 모든 연산 단일 매핑 조회, metadata 부모 소속 검사. 원격 id 선예약 등 단순 업로드에서 중복을 막는 정체성 재개 경계를 설계한다.
- `packages/postgres/src/{store,attachments,write,work}.ts`, core `ports/store.ts`: postgresStore 합성, withWrite 유일 쓰기 경계, `ensureWork(held,input)` 재사용. redactFile은 같은 files 행을 잠그므로 이전 CAS와 잠금 순서 일치. FileLocationRow verifiedAt 노출 필요.
- `packages/core/src/files/blob-delete-work.ts`: 현재 due=createdAt, local/brain 전용 삭제. 이전 보관 삭제의 원격 재확인을 추가하되 redact 마지막 사본 삭제와 구별.
- `packages/core/src/settings/index.ts`, postgres `settings.ts`: CORE_SETTING_DEFINITIONS, get/set/readScopedSettings 재사용, 사용자→공통→기본 우선. 기본30·0이상 안전 정수와 날짜 범위 검증.
- `packages/core/src/{brain,recall/documents}.ts`, CLI `assembly.ts`: FileStore 주입은 현재 local 고정, showDocument는 readDocument 추출 조각만 사용. 기존 문맥/마스킹/페이징을 유지하면서 Drive home의 실제 바이트를 읽는 경로 연결.
- `packages/postgres/src/migrate.ts`, `test/{migrate,schema}.test.ts`: 현재 core39, 연속 migration. 번호 확정 전 버전·등록·최신 기대 변경 금지; 역사 기대 보존.
- `tooling/test-db/src/index.ts`, `apps/cli/test/pg-home.ts`, `tooling/test-changed/rules.mjs`: 고유 cluster·role·home 격리와 새 SQL/자식경로 선택 연결. test runner의 기본 공유 compose 접근을 명시 URL로 막는다.

## Tasks & Acceptance

**Execution:**
- [x] 1. 계약/adapter — `packages/core/src/ports/file-store.ts`, `packages/core/src/ports/drive-store.ts`(신규), `packages/core/src/domain/file.ts`, `packages/core/src/testing/contracts/file-store.ts`, `apps/cli/src/runtime/drive-file-store.ts`(신규), `apps/cli/test/drive-file-store.test.ts`(신규), `apps/cli/test/fixtures/fake-drive.ts`(신규) — FileStore 반환 일반화·backend 중립/local 시험 분리, Drive 순수 locator·mapping port/shared API·root 안전 adapter·loopback fake 서버/Clock 및 관련 계약 시험 작성. 번호 없는 DDL 설계는 `.brain-automation/tickets/8.1/drive-schema.sql`에만 보존.
- [x] 2. 이전/보관 — `packages/core/src/settings/index.ts`, `packages/core/src/ports/store.ts`, `packages/core/src/files/{drive-migrate-work,blob-delete-work}.ts`, `packages/postgres/src/{drive,attachments,store,migrate}.ts`, `packages/postgres/test/drive-migration.test.ts`(신규), `packages/postgres/test/{migrate,schema}.test.ts` — settings registry·DB읽기/검증, PG 매핑 및 CAS 이전 확정 API·fake/계약, 업로드 검증 우선순위·due·삭제 재검증·redact 구분과 경합/rollback 시험 작성. 실제 migration 등록 직전 지휘자에게 번호 확정 요청; 중앙 답 뒤 연속 등록·core 최신 버전/기대 수정.
- [x] 2a. 업로드 중단/가리기 복구 — `packages/core/src/files/drive-migrate-work.ts`, `packages/core/src/ports/drive-store.ts`, `packages/postgres/src/drive.ts`, `packages/postgres/migrations/0040_drive_uploads.sql`, `packages/postgres/test/drive-migration.test.ts` — 원격업로드 뒤 CAS 전 중단과 그 사이 가리기가 겹쳐도 지속된 의도를 재개하여 원격 고아를 안전하게 정리하는 경계를 구현하고 강제중단/재시도·가리기 경합 시험코드를 작성한다. 원격 I/O와 DB 트랜잭션 분리·단일매핑·가림우선 CAS를 유지하며 일시실패가 정리를 유실하지 않게 한다.
- [x] 3. 수직 조립 — `packages/core/src/{brain,recall/documents}.ts`, `apps/cli/src/assembly.ts`, `apps/cli/test/drive-tracer.test.ts`(신규), `packages/core/test/{blob-delete,settings}.test.ts`, `tooling/test-changed/rules.mjs` — Brain/CLI의 backend routing·Drive주입·이전 use case와 files show 실제 원문 읽기 연결, 합성 txt PG/가짜서버 tracer·0/30일·중복·checksum·소실·root안전·CAS/redact·양backend 시험, test-changed 규칙과 재사용 fixture 운영 문서 작성.

- [x] 4. R1 매핑/위치 복구 재도출 — `packages/core/src/ports/drive-store.ts`, `packages/core/src/files/drive-migrate-work.ts`, `packages/core/src/brain.ts`, `packages/core/src/files/blob-delete-work.ts`, `apps/cli/src/runtime/drive-file-store.ts`, `packages/postgres/src/drive.ts`, `packages/postgres/migrations/0040_drive_uploads.sql`와 관련 시험 — BH1~4/7·EC1/2·IA3의 root결합·CAS탈락의영속처분·업로드진행과가림삭제fencing/불확실요청복구·메타일회확정을 보완한다. 여러업로더중하나를삭제뒤까지지연·POST전중단·실제home교체·동일hash두root 시험코드를작성하고시험불가한외부원자성은정확히분리한다.
- [x] 5. R1 실행 경로 교정 — `apps/cli/src/{dispatch,commands/daemon-run}.ts`, `apps/cli/src/runtime/drive-file-store.ts`, `packages/core/src/{brain,files/drive-migrate-work}.ts`와관련시험 — BH5/6/10·EC3의daemon주입전달·성공/기삭제failure해소·주입가능HTTP/header/body timeout/취소(불확실mapping보존) 및멈춘fake요청/dispatch데몬시험코드를작성한다.
- [x] 6. R1 시험 공백 보완 — `apps/cli/test/{drive-tracer,drive-file-store}.test.ts`, `apps/cli/test/fixtures/fake-drive.ts`, `packages/core/test/drive-migrate.test.ts` — VG1~3/BH8/9의GET중home변경 local보존·Drivehome실제재추출·양checksum상충우선순위/잘못된readback·다중문맥/마스킹/중첩/next/세대교체시험코드를작성한다. 개발중실행하지않고컴파일만한다.

- [x] 7. R2 직접교정 — `apps/cli/src/runtime/drive-file-store.ts`, `packages/core/src/brain.ts`, `apps/cli/test/{drive-tracer,drive-file-store}.test.ts` — R2-S1/G1/G2/N1의HTTP body취소·보관GET관찰순서·불변세대fixture·root일시실패분류와재시도회귀를 최소변경으로수정한다.

- [x] 8. 최종회귀 실패 교정 — `apps/cli/src/dispatch.ts`, `packages/postgres/migrations/0040_drive_uploads.sql`, `packages/postgres/src/drive.ts`, 관련migration/PG시험, `tooling/bootstrap/test/hook.test.ts`의격리도구fixture — standalone미주입context호환·DB상태값명시생성·bootstrap의실제OrbStack probe와제한PATH불일치를원인별로교정하고관련재검증한다. 기존catalog기대를새default에맞추지않고작성자가state를명시하도록한다. bootstrap은제품probe를우회하지않고시험격리환경을바로잡는다.

**Acceptance Criteria:**
- Given 합성 첨부 txt와 격리PG/홈/가짜Drive, when 이전하고0일 삭제한 뒤 `brain files show`를 호출하면, then 원격 파일 한 개와 동일 트랜잭션의 Drive home/verified_at/삭제예약이 확인되고 실제 Drive GET을 통해 마스킹된 원문이 보인다.
- Given 기본30일 보관, when 가짜Clock을 검증뒤30일 직전/도달로 옮겨 처리하면, then 직전에는 local 존재, 도달 뒤 정상원격 재확인후 local만 삭제된다.
- Given 같은 내용의 반복·동시 이전, when 실행하면, then 매핑과 확정 원격파일은 각 하나이며 이름검색 요청은0이다.
- Given checksum 불일치·원격소실·root밖/external·expected-home 불일치·업로드뒤redact, when 해당 경계를 실행하면, then matrix의 보존/CAS/거부 결과가 실제PG/요청기록에서 확인된다.
- Given local/Drive adapter, when 공통 의미 계약을 실행하면, then 양쪽이 통과하고 local 전용 안전계약도 유지된다.

## Implementation Notes

- Execution7: 미소비/늦은Response body취소와stream abort reader정리,30일선행migrate종료후보관GET장벽및eligible true→false관찰,새완성세대fixture,pointer전환,rootDB실패의재시도분류와queue회귀작성. build/typecheck/diff-check0,시험미실행.

- Execution5~6: standalone daemon driveFactory전달·보관삭제failure해소·헤더/fetch/JSON/바이너리timeout과AbortSignal·GET중home변경·Drive재추출·양checksum/오류readback·다중조각/next/세대교체시험 보완. build/typecheck/diff-check0, 시험미실행. 불확실submitting과최종상태조회~local삭제사이추가경합은독립후속에서판정한다.

- Execution4: DB단일제출토큰(reserved→submitting→uploaded)·reserved취소·root/location영속결합·CAS stale/재개·메타일회확정과관련시험코드작성, build/typecheck/diff-check0. 불확실한submitting은시간/존재만으로완료시키지않으며최종잔여위험과후속리뷰에명시한다. 시험미실행.

- Execution3: Brain/CLI/데몬의 명시적 Drive 주입과 위치별 읽기·drain handler 등록, Drive bytes로 text문맥 재구성 뒤 기존출력 codec 적용. 격리PG/합성홈/loopback/Clock의 CLI tracer·0/30일·중복·소실·redact 장벽과 fixture지침 작성. build/typecheck/diff-check 종료0, 시험미실행. 다중지연 업로드+가리기삭제 경계는 독립리뷰 필수확인 대상으로 남김.

- Execution2a: beginDriveMigration이 업로드 전 미검증 위치·의도·drive_migrate를 파일잠금 트랜잭션으로 저장. reserved 응답유실 복구와 가리기 삭제 재예약·SIGKILL fixture 작성, build/typecheck/diff-check 종료0. 시험 미실행. Execution3에서 handler 실제 등록과 지연응답/동시업로드·삭제 경계를 확인하며 독립 리뷰에도 전달한다.

- Execution2의0040/PG매핑·CAS·설정·보관삭제와 시험코드, build/typecheck/diff-check 종료0을 확인했다. 시험은 미실행. 업로드후CAS전중단+가리기 원격고아 복구가 미해결이므로 Execution2a로 보완하고2는 아직 완료체크하지 않는다.

- 중앙 번호 확정(msg_db5c7d3e7d4e): 22.3 미출하 식통계 후보는 철회되어 8.1 자체 forward0040을 배정받았다. 선행 main은 원본baseline(schema39)과 동일. 조건부0041 해제. 0001~0039와 역사 기대는 보존하고 자기0040·현행버전40만 등록한다.

- Execution1: FileStore 공통 의미 계약과 로컬 전용 확장자 시험 분리, Drive 사전생성 ID 예약→동일 매핑 업로드/재개, fake 서버/Clock·동시 put/응답유실/root/검증 시험 작성. build/typecheck/diff-check 종료0. 시험 미실행. 최초 build 타입좁힘 실패와 typecheck fixture local 타입 실패는 수정했으며 원시 증거는 로컬 보고에 보존.

## Plan Change Log

- R1: root결합·CAS탈락처분·작성자/삭제fencing·메타확정·I/O제한·소비자시험 공백을 발견했다. intent-contract는 보존하고 아래 Execution4~6으로 계약경계를 재도출한다. 기존전체변경을지우지않고 해당결함경계만재도출하며 R1전체patch는 로컬 `/tmp/brain-8-1-review-r1.diff`에보존. KEEP: 단일root/hash사전ID매핑·검증우선순위·외부I/O중DB쓰기없음·미가림/expectedhomeCAS·local안전계약·실제원문GET/마스킹·격리fixture·0001~0039불변.

## Review Triage Log

### 2026-11-06 — Review pass R3
- verdicts: 0 new findings — high 0, medium 0, low 0, false 0, maybe-false 0
- R2-S1: safety/coverage 모두미소비body취소·reader abort·늦은Response finally를실제소스로확인. R2-G1: 선행migrate종료후보관조회eligible true→false관찰. R2-G2: 새세대완성후pointer전환으로trigger불변식보존. R2-N1: 일시DB실패는FILES_UNAVAILABLE이며sourceUnreachable미기록·queue재시도성공단언확인. 각실질수정의독립해결근거는 R3 safety/coverage원문에보존. 실행통과를뜻하지않음. 마지막전체회귀진입승인.

### 2026-11-06 — Review pass R2
- verdicts: 4 findings — high 1, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `R2-S1` `[medium]` `[patch]` POST/DELETE/non-OK 응답의 미소비body가취소되지않음 — request finally는timer/listener만해제. body소유정리를제한범위안에서수행하고늦은Response도정리.
  - `R2-G1` `[medium]` `[patch]` VG1 장벽이 선행drive_migrate GET을잡음 — 작업claim정렬이attempts/id순이라보관재조회없어도통과. 선행migrate완료후만기에서보관GET장벽설치.
  - `R2-G2` `[medium]` `[patch]` BH9 fixture의현행세대조각DELETE가불변trigger거부 — 새완성세대/조각을먼저만들고current전환하여불변식보존.
  - `R2-N1` `[high]` `[patch]` root조회일시DB오류가LOCATION_REFUSED로바뀌어영구sourceUnreachable — binding실패는재시도가능오류로보존,실제root불일치만거부하고소비자회귀작성.

R1 해결대조: root결합/단일제출권/CAS재개/메타확정/daemon전달/failure해소는R2-safety가코드·시험소스로교정을확인했다. VG2/VG3/BH8도R2-coverage소스상확인. BH10/EC3는R2-S1추가수정필요. VG1/BH9는G1/G2보완전미해결. ACK후업로드확정→CAS전SIGKILL 복구와결과불명submitting을구별하며,후자는8.5후속상태로남긴다.

### 2026-11-06 — Review pass R1
- verdicts: 20 findings — high 3, medium 14, low 0, false 3, maybe-false 0
- findings:
  - `VG1` `[medium]` `[bad_plan]` 원격GET중home변경 보관삭제 시험 부재; 검증렌즈 사전확인 근거대로 장벽시험 보완
  - `VG2` `[medium]` `[bad_plan]` Drive home재추출 시험 부재; 추출routing 소비자 실제drain 검증 보완
  - `VG3` `[medium]` `[bad_plan]` 복수checksum 우선순위 교차시험 부재; fake독립주입/단언 보완
  - `EC1` `[high]` `[bad_plan]` blob_delete가 위치의원래root를 확인하지 않음; 현재root의부재/다른사본 삭제로 deleted_at 오기록 가능
  - `EC2` `[medium]` `[bad_plan]` begin 선삽입후commit conflict로 uploaded_at/remote_checksum 누락; 메타데이터 일회확정 보완
  - `EC3` `[medium]` `[bad_plan]` fetch/arrayBuffer/json에 timeout없음; handler budget이진행중I/O를중단하지 않음
  - `IA1` `[false]` `[reject]` 원문연구§2의사전위치/의도등록과미검증예약은일치; 검증된위치/home/삭제예약의원자공개와구분. 미검증행존재자체를결함으로채택하지않음
  - `IA2` `[false]` `[reject]` OAuth/실계정후속인최소fake tracer에서주입dispatch가승인된명령표면; 일반설치CLI완성을8.1에요구하지않음
  - `IA3` `[medium]` `[bad_plan]` CAS SQL단위시험은있지만실업로드장벽중home교체통합시험없음; BH3와같은원인으로보완
  - `IA4` `[false]` `[reject]` 중앙실제메시지msg_db5c7d3e7d4e가0040배정/선행SHA확정; 로컬체크포인트로통신대조
  - `BH1` `[high]` `[bad_plan]` 업로드작성자진행여부와삭제완료가결합되지않아지연POST재생성후정리유실; 영속fencing/재정리필요
  - `BH2` `[medium]` `[bad_plan]` reserved+POST전중단/가리기는existsfalse영구재시도; 제출전예약과불확실요청의처분경계보완
  - `BH3` `[medium]` `[bad_plan]` CAS changed는정리없고intent가옛home고정; 변경후재시도충돌/원격처분누락
  - `BH4` `[high]` `[bad_plan]` root A/B동일hash위치가현재root로잘못해석; EC1과공통원인
  - `BH5` `[medium]` `[patch]` standalone dispatch context와daemonRunCommand가driveFactory를전달하지않음; 기존주입 seam전달보완
  - `BH6` `[medium]` `[patch]` drive_local_delete 성공/이미삭제 분기에resolveFailures없어failure장부미해소
  - `BH7` `[medium]` `[bad_plan]` 정상begin→commit의업로드메타NULL; EC2와공통원인
  - `BH8` `[medium]` `[bad_plan]` 복수checksum과잘못된readback교차시험없음; VG3와같은공백
  - `BH9` `[medium]` `[bad_plan]` Drive원문문맥의복수조각/이어읽기/세대교체시험없음
  - `BH10` `[medium]` `[bad_plan]` HTTP본문/헤더끝없는대기제한없음; EC3와공통원인


## Design Notes

route full/pinned, risk high: 마지막 사본 보존과 가리기 경합을 다루는 연결 변경이다. 초기에 개발중 시험을 돌리지 않고 독립 후속 리뷰까지 마친 다음 전체 회귀를 실행한다. migration번호는 기능 설계와 독립이며 등록 경계에서만 중앙조율한다. 과거 SQLite 연구 관찰보다 baseline의 PG 코드가 우선이다.

## Verification

개발·리뷰수정 중 **시험 실행 금지, 컴파일 확인만**: `pnpm build`, `pnpm typecheck`, `git diff --check`. 시험 코드는 작성한다. 다운로드가 필요한 build는 처음부터 권한 확장.

마지막 구현·독립4렌즈 및 필요한 후속 확인 뒤 커밋 전 전용 PGcluster/role·홈·venv·checkout밖 TMPDIR·loopback fake/Clock·자기 산출물을 사용한다. legacy fixture 관리자암호 전제를 사전 확인하고 BRAIN_TEST_DATABASE_URL을 명시한다. 원시 로그는 gitignored 로컬에 보존.

- `VITEST_MAX_WORKERS=2 pnpm test` → 종료0, 새/기존 TS 전체 및 위 matrix 시험 실행 증거.
- 이어서 `pnpm test:python` → 종료0, 전체 Python 회귀. 두 명령은 build하므로 순차 각1회.
- 최초 실패 원문·처분을 보존하고 수정 후 `pnpm test:changed -- f1a2f22e1b6026aeeedec88ec310aefbdb947556` 및 관련 시험으로 재검증.
- fixture별 정확한 실행명령/사전조건/Clock제어/관찰·정리와 소유 자원 ID/부재확인은 구현 후 기록. 외부 I/O중 쓰기 transaction 부재·매핑단일성·redact CAS는 독립 정적 리뷰도 수행한다.

## 후속 인계와 잔여 위험

- 8.5 명시범위: `submitting` 결과불명(POST직전중단·응답유실·ACK후DB저장전중단)은자동복구미완료이며위치삭제완료로쓰지않고실패/재시도이력으로보존한다. ACK후업로드확정→CAS전중단의가림복구와동일한완료로표현하지않는다. 원격소실후동일ID재생성도지원완료가아니다.
- 8.5 명시범위: keep_local_days변경의기존due재계산/깨우기와handler실행시현재설정재확인은후속이다. 8.1은고정0/기본30일 tracer만검증한다. 설정변경후기존예약동작까지완료라고표현하지않는다.
- 마지막원격GET/DB재조회와실local삭제사이외부변화는분산I/O한계다. 현재제품에Drivehome→local복원writer는없으며그writer/해제가생기는후속에는삭제와공유전이fence를재검토한다.

## 최초 전체 회귀 실패 이력

- 2026-11-06 UTC12:57:56→13:06:16 `VITEST_MAX_WORKERS=2 pnpm test` exit1:212files=209pass/3fail;4615tests=4605pass/9fail/1skip. 13:06:28→13:17:47 `pnpm test:python` exit1:16files=15pass/1fail;69tests=61pass/8fail. 둘다build/typecheck(해당명령)통과. 최초원시로그는 로컬 regression-ts.log/regression-python.log에보존.
- 실패: bootstrap제한PATH의OrbStack probe로첫설치실패(TS7/Python8의연쇄),standalonecontext의불필요undefined driveFactory키(TS1),신규intent.state default active의catalog계약위반(TS1). 전체회귀를통과로기록하지않으며관련수정후test:changed/관련시험으로재검증한다. 명시TS skip은Python전용case이며Python회귀에서실행됐으나설치실패의영향을받았다.

## Review pass R4 및 최종 처분

- 독립 coverage 후속은 마지막 dispatch/DDL/bootstrap 교정에서 새 코드 결함을 찾지 못했고 최초 TS9/Python8 실패의 후속 통과·새 Drive matrix 실행·세 changed 단계를 원시 로그로 확인했다. 로컬 보고 `reviews/r4-regression.md`.
- R4-E1 `[medium]` `[patch-evidence]`: orb wrapper 원문 누락을 실제 구현자 도구 호출에서 복원했다. status 외 종료2, 허용호출은 `HOME="$BRAIN_TEST_ORBSTACK_HOME" exec /usr/local/bin/orb status`로 실제 CLI에 위임하여 stdout/종료코드를 보존한다. 제품 probe 변경은 없다. 지휘자가 `regression-environment.md`의 복원 원문·환경과 R4 요구를 직접 대조하여 보완 완료로 판정했다. 원래 확장 PATH 전체와 각 위임의 개별 영수증은 미보존이며 재현 증거의 한계로 남긴다. 이 한계를 시험 실패나 새 제품 결함으로 계산하지 않는다. 새 시험은 실행하지 않았다.

## 최종 재검증 결과

최초 전체 TS→Python은 위 실패 이력 그대로 보존했다. 원인 교정 뒤 첫 changed도 hook 후속설치3건 실패(exit1)였으며 Node 실행파일의 realpath가 제한 PATH를 벗어나던 fixture를 수정했다. 관련 TS 상세8파일159통과/1skip(exit0), Python hook8통과(exit0), 최종 `pnpm test:changed -- f1a2f22e1b6026aeeedec88ec310aefbdb947556`의 기본171파일3444통과/1skip·PG45파일711통과·Python16파일69통과(exit0)를 확인했다. TS skip은 Python 전용 보존 사례이며 Python 상세/changed에서 통과했다. build/typecheck/diff-check도 종료0. full명령 두 개는 각1회만 실행했고 실패수정 재검증을 관련/changed로 수행했다.

Drive 상세 matrix는 tracer17·adapter11·core이전9·PG이전12·daemon주입1건을 포함하며 39→40 설치/업그레이드·기존행/이력/권한·CAS·SIGKILL·보관·가리기와 원문 show/마스킹/이어읽기를 실제 격리PG 및 loopback fake에서 검증했다. 0001~0039 바이트는 baseline과 동일하다. 운영법/Clock/가짜서버 제어는 `apps/cli/test/fixtures/drive-fixture.md`, 개별 성공행은 로컬 `regression-fix-targeted.log`에 있다.

## Auto Run Result

- result: built (사용자 인수 done 아님)
- baseline: f1a2f22e1b6026aeeedec88ec310aefbdb947556
- 구현: Terra medium, 독립 Sol medium 4렌즈 및 R2/R3/R4 후속. 마지막 실질 수정과 실패 처분을 독립 확인했다. 최초 하위 ready/turnStart/depth1 증거는 로컬 보존.
- 변경: backend 중립 FileStore·Drive adapter/영속 매핑·forward0040·CAS 이전/보관·설정·Brain/CLI/daemon/원문 읽기·합성 fixture/회귀 선정 규칙. release/ref와 검색/점수/성능은 변경하지 않았다.
- review: R1 20건 중17채택교정·3reject(사전 미검증 예약 허용/주입 fake tracer 범위/중앙0040확정 근거). R2 4건 추가교정, R3 해결확인, R4 코드결함0·환경증거1건 보완. deferred는 비어 있다.
- followup_review_recommended: false. 8.1 필수 미해결 없음. 위 8.5 명시범위와 분산 I/O 경계는 지원완료로 표현하지 않는다.
- operator_actions: 현재 없음. 실제 Drive/OAuth/운영자 로그인은 후속8.3/8.8에서 준비하며 이 티켓은 실제 Drive/운영DB/사용자파일/credential을 사용하지 않았다.
- 자원: 전용PG `79ecd66152b5417c063d82492071453801bd14f6e146595afeb8e21ce44c14cd` 및 `eb21a72e1e38e1fbc0133515352be27a0035ad6217093b9c4e66136a8d4515c9` 제거, 두 실행의 fixture 소유ID와 Docker목록 대조 잔존0. 임시HOME/venv/cache/Docker설정 제거. 개별ID 미출력 passing Compose는 fixture cleanup성공으로 확인했고 모든ID 개별inspect를 주장하지 않는다. 원시 로그/자원 증거는 gitignored 로컬 보존.
- 잔여 위험: 결과불명 submitting 및 보관설정 변경 후 기존 예약 갱신은 8.5 후속, 최종 재조회와 local삭제 사이 분산 I/O 경계는 향후 복원writer 도입 시 공유fence 재검토. 환경 원래 확장 PATH/개별 orb 위임 영수증 미보존.
