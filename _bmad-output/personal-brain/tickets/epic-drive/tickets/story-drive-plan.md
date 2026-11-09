---
title: '8.5 증분 동기화와 중단 재개'
type: 'feature'
ticket: 5
created: '2026-11-09'
status: 'built'
baseline_revision: '870231c1baaa06d8d5bfd39c37f0f7cb1749fb4b'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - _bmad-output/personal-brain/tickets/epic-drive/epic-drive.md
  - _bmad-output/personal-brain/tickets/epic-drive/tickets/tickets.toml
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** entry 5 description/verify의 실패 경계가 미완성이다. 전체 목록 중심 sync, 결과불명 제출, 고정된 삭제 due는 변경 누락·중복 업로드·이른 삭제 위험을 만든다.

**Approach:** changes 페이지와 cursor의 원자 확정, 내구 resumable 진행, 현행 설정과 연결 세대를 확인하는 삭제 경계를 기존 core/Store/adapter/조립에 연결한다. 원문 수락조건은 entry 5 전체이며 아래 matrix와 시험으로 관찰한다.

## Boundaries & Constraints

**Always:** 8.1~8.4의 root/hash 단일 원격 identity·home CAS·redaction·source/claim/generation fence·임시 바이트 소유권·성공 세대 이전 포인터·공유 provenance를 보존한다. 외부 I/O 동안 DB 쓰기 transaction을 잡지 않는다. 공개 출력은 출력 코덱/고정 오류를 쓰며 비밀 내부 상태를 투영하지 않는다. 최종 상태는 사용자 인수 전 built다.

**Never:** 실 Drive/계정/credential/운영 DB/transcript 사용, 중앙 main/state 변경·main 병합/push, plugin app-ref/version 변경, 8.6 검색 기능/스냅샷/릴리스 확장, 0001~0043 변경. 19.5 test-db/slotrunner/Pythonconfig/hooklane/측정기·인프라 편집 금지. 19.13의 HOME/Docker 신규 회귀 3case 교정은 별도 소유이며 수락 source 통지 뒤 원래 단언을 보존해 합친다. 19.5 완료는 선행 gate가 아니다.

## I/O & Edge-Case Matrix

| ID / Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| M1 다음 주기/내용 세대 | 기존 색인 문서 수정, 실제 daemon 다음 tick | source_sync→추출→공개 recall docs 새 본문; 새 hash 행, 이전 hash/조각 불변 | 새 추출 실패는 이전 성공 포인터 보존 |
| M2 페이지 재시작 | changes 둘째 페이지 적용 직후 child 종료 | 해당 변경·다음 cursor 함께 영속; 새 프로세스는 남은 페이지부터, 마지막 newStartPageToken | 적용 실패는 페이지/cursor 전부 rollback, 중복·누락 없음 |
| M3 이름/계층 | 파일·폴더 rename, inside/outside move, 삭제·permission 상실·원본 복귀 | 자손 경로/이름 재계산, 해당 출처만 unreachable 및 복귀시 해제; 정상 공유 원본 보존 | 403 rate limit/5xx는 접근 불가로 오인하지 않음 |
| M4 cursor 거부/대조 | 거부 token, 다중 페이지 full scan 중 실패/취소/incomplete | 완주 전 기존 항목 접근/조각 보존, 완주 뒤에만 누락 unreachable | invalid list token은 새 scan으로 재시작; 불완전 목록 성공 처리 금지 |
| M5 합침 | 같은 source 수동·예약 sync 동시 요청 | 원자적으로 열린 일감 하나로 합침 | 오래된 claim/연결 세대 확정 거부 |
| M6 resumable | >5MiB, 20MiB 합성 bytes 절반 10MiB에서 중단/새 프로세스 | session URI/예약 remote ID/확인 offset 내구화; 서버 조회후 해당 offset부터 재개; 원격 하나 | 308 Range 검증, session 만료/유실은 동일 ID와 원격 검증으로 안전 복구 |
| M7 결과불명 | multipart/submitting POST 직전·직후·ACK DB저장 전 중단 및 완료 응답 유실 | 동일 root/hash/예약 ID로 검증·회복, 중복 create 없음 | 404 한번으로 미진행/삭제 완료 추정 금지, redaction/fence 후 늦은 publish 금지 |
| M8 보관 단축 | 검증+15일, 기존30→10, brain config set | due/청구가능시각 재계산해 원래30일 전에 청구·삭제 | 원격 재검증 실패면 로컬 보존 |
| M9 보관 연장/동시 | 30→40, 두 설정 동시, claim 후 원격확인중 연장 | 40일까지 보존; DB 최종값 하나로 due 수렴; 삭제 직전 현행값 재확인 | 오래된 hook 값 권위 금지, 설정/삭제 barrier 잠금 순서 일관 |
| M10 해제/삭제 경합 | disconnect와 만료 삭제, 취소된 일감 이후 설정 변경 | 마지막 사본 보존, 취소 작업 부활 금지, Drive delete 0 유지 | 기존 불확실 삭제 barrier/세대/claim fence 보존 |
| M11 취소/진행 | 긴 sync/upload 도중 취소 | 다음 페이지/chunk 전에 멈춤, 공통 runtime 진행 이벤트, 재시작 가능 | abort/claim lost는 고정 공개 오류, 완료로 숨기지 않음 |
| M12 공개 비노출 | 파일명/본문/token/URI/code/verifier/client secret/외부 오류에 합성 표식 | queue list·doctor·로그·CLI/SDK 출력에 표식 없음 | 외부 오류 원문/민감 영속 상태를 payload/plan으로 복사 금지 |
| M13 업그레이드 | 합성 schema43 기존 upload/retention/source/carry/provenance | 43→44 데이터/권한/이력 보존, 새 CAS/trigger/취소·복구 제약 | 과거39~43 guard/legacy fixture 및 migration 바이트 불변 |

</intent-contract>

## Code Map

정적 조사 완료(실행 관측/시험 결과 아님). baseline은 위 full SHA, 8.4 source `73c44191af88fe8ede445513fb02c84e83badf06`가 조상이다. entry 5는 after4/refinefalse/hitlfalse/high이며 충족된 선행을 다시 구현하지 않는다.

- `packages/core/src/ports/{source-store,source-remote,drive-store}.ts`: SourceRemote는 startToken/list/metadata/download만, SourceStore는 scan/seenScan 및 durable extraction handoff/publish, DriveUpload는 reserved/submitting/uploaded/cancelled. 새 계약과 public root export를 함께 연결.
- `packages/core/src/sources/sync.ts`: 먼저 token 취득 후 전체 폴더 순회/renew/finishSourceScan. 기존 임시 byte prepare→handoff→publish 및 completedVersion/hash 성공 결합 재사용.
- `packages/postgres/src/{sources,drive,settings,drive-barrier}.ts`: page apply/cursor transaction, upload identity 및 retention due/claim, source→schedule 잠금 순서와 disconnect barrier의 영속 구현. `packages/core/src/testing/fakes/`와 공통 contracts에 같은 의미 구현.
- `apps/cli/src/runtime/{drive-file-store,drive-http,source-drive,drive-runtime}.ts`: 예약 ID multipart, checksum 우선순위와 root/name 검증, 401 refresh/403 reason/429/5xx 분류, bounded stream/shortcut, setting changed 훅과 연결 wrapper. submitting은 현재 보수적으로 거부하므로 결과불명 회복 필요.
- `packages/core/src/files/drive-migrate-work.ts`: upload→독립 read→home/verified/retention CAS, 삭제는 원격 확인 후 withDriveLocalDelete에서 재조회. 현행 설정과 장벽 재확인을 보강.
- `packages/core/src/settings/index.ts`, `packages/core/src/brain.ts`, `apps/cli/src/commands/{config-set,sources-sync}.ts`, `apps/cli/src/daemon/run.ts`: DB 저장 뒤 설정 훅, 수동/예약 enqueue·취소·진행 실제 조립 경로.
- `apps/cli/test/fixtures/fake-drive.ts`: 공용 fake HTTP에 changes/resumable/308/응답유실/cursor거부/메타변경·요청기록 확장. 기존 drive-*.test.ts 및 core source-sync/drive-migrate, PG drive-migration/migrate/source 계약을 보강.
- `packages/postgres/migrations/0044_drive_resume.sql` 후보, `packages/postgres/src/migrate.ts`, `packages/postgres/test/migrate.test.ts`: 새 forward DDL/최신 버전44와 합성43 upgrade. 기존0040은 session/offset이 없고 trigger가 전이를 제한하며 retention due UPDATE 권한이 없다.
- `tooling/test-changed/rules.mjs`: 신규 SQL/child path가 기존 규칙으로 선택되는지 정적으로 확인하고 필요한 최소 규칙만 추가, 같은 영역 중앙 조율. 다른 시험인프라는 읽기 전용.

## Tasks & Acceptance

**Execution:**
- [x] E1 영속 계약 — `packages/postgres/migrations/0044_drive_resume.sql`, `packages/postgres/src/{migrate,drive,sources,settings}.ts`, core ports/fakes/contracts/root exports — upload session/확인 offset·안전 recovery 및 page+cursor 원자 적용·retention 재계산 영속 계약을 구현. schema43 합성 upgrade와 역할 권한/trigger/CAS/취소·복구 시험 코드를 작성. 이 단계에서 adapter 호출은 다음 항목과 호환되게 연결하되 기능 완료로 표시하지 않음.
- [x] E2 resumable — `apps/cli/src/runtime/{drive-file-store,drive-http}.ts`, core drive migrate, 공용 fake/drive-file-store 및 PG crash child 시험 — >5MiB/308/status query/10MiB 재개/응답유실/submitting 회복, redaction·취소 fence. 고정 root/hash/ID와 checksum 확인 유지.
- [x] E3 changes — core sync/SourceRemote, source-drive, PG/fake source 계약과 fake HTTP/관련 시험 — page transaction·cursor/새 hash handoff·경로/상태/복귀·거부 token fallback·안전 주기 대조. M1~M4를 덮는 코드 작성.
- [x] E4 보관 — core driveLocalDelete/settings, PG drive/settings/barrier, drive-runtime 및 관련 시험 — 실제 config set 훅·최신 DB값 수렴·due 깨움·실행직전 현행값 재확인·disconnect/취소 불가역을 연결. M8~M10 경합 계약 코드 작성.
- [x] E5 외부 표면 — brain/CLI/SDK/daemon/queue 조립 및 drive-daemon-dispatch/source tracer 시험 — 수동/예약 같은 열린 일감·다음 tick 검색·취소/진행·모든 비밀 비노출 관찰을 연결. 새 검색 기능은 추가하지 않음.
- [x] E6 완결성 — 관련 공통 fake/PG/CLI 통합 시험 및 필요한 신규 child fixture/rules 최소 변경 — matrix M1~M13과 8.1~8.4 안전 회귀를 diff로 대조해 빠진 시험 작성. 19.13 교정 incoming 보존, migration 역사 기대 재대조. 시험은 개발 종료까지 실행 금지.

각 구현 Task는 위 한 계약 또는 1~3 항목만, 동시 편집자 하나. Terra/medium 동일 워커가 이어받은 Task 6개 초과시 새 워커. 리뷰 수정도 같은 크기로 배정한다.

**Acceptance Criteria:**
- Given 합성 Drive와 격리 PG/clock, when matrix M1~M13의 공개 명령·실제 scheduler/worker·프로세스 재시작을 수행하면, then 표의 동작과 entry5 verify 전체가 관찰되고 원본 손실·중복 원격·조용한 누락·민감 출력이 없다.
- Given 필요한 구현 및 독립 4렌즈/실질 수정 후속 검토 완료, when 최종 전체 회귀를 순차 실행하면, then 두 suite 결과와 최초 실패 처분·관련 재검증이 증거로 남고 미해결 필수 항목이 없어야 built다.

## Implementation Notes

2026-11-09 E1 부분 결과: schema44/upload checkpoint/source page CAS/retention due 코드와 일부 시험 작성, build·typecheck·diff 확인 성공(시험 미실행). 실제 extraction handoff 내구화·설정/삭제 barrier 직렬화·합성43 데이터 전범위 보존이 남아 E1 미완료다. E1을 E1a(스키마/업그레이드 역사), E1b(page/handoff 원자성), E1c(보관 직렬화 영속 계약)로 축소해 순차 진행한다. 최초 typecheck sandbox DNS 실패 뒤 권한 확장 build 의존성 설치로 컴파일 확인, 원문 보고는 로컬 보존.

2026-11-09 E1a: 42→43 guard에 coreMaxVersion:43/단독0043 적용 기대를 복원했고, 합성 schema43 upload/retention/source/carry/provenance 및 역할권한/이력/신규 trigger/CAS/취소·복구 시험 코드를 작성했다. build·typecheck·diff 확인 성공, 시험 미실행. 0001~0043 diff 없음. E1b/E1c는 미완료다.

중앙 수락 incoming19.13 source `94fa0e76bcd3f3527cd4acb28cf5953fcecd474b`를 정상 Task 종료 뒤 cherry-pick `4bd95b7b7f56bd2e98ced60ce29c2ec2d830f1e8`으로 통합했다. 두 Drive 시험 HOME/Docker fixture 준비만 바뀌며 기존 단언을 보존한다. 원본 baseline은 변경하지 않는다. 중앙 확인 main은 `4d636c6a9ad4c8f3d44532db82d7b4eb2df8e6a3`다.

## Plan Change Log

### 2026-11-09 — R2 경계 재도출, loop2
트리 전체 시도는 로컬 고정 review-r2.diff에 보존한다. sync.ts와 drive-file-store.ts만 양성 보존 사본 뒤 원본 구현으로 복원해 E3/E2 경계를 재도출한다. intent-contract/원본 baseline 불변, 다른 R1 수락 수정 및19.13 incoming은 유지한다.
KEEP: R1 page/cursor/outbox와 outside 증거, alias 첫 경로, Carry 실패 재인계·크기·가림 terminal, batch Map, 서버 session/offset CAS·동일ID·검증 뒤uploaded·multipart progress 및 공개 비노출, source/claim fence, 모든 기존 시험과 역사 migration bytes.
E3 보완: Carry 예약 의무가 현행 work에 남으면 최근 cursor/빈 changes여도 full scan begin/finish로 한 번 완료한다. MIME 변경은 내용 지문 재사용과 별도로 재분류한다. VG marker fixture는 실제 내용 버전으로 준비한다.
E2 보완: 검증한 동일 root/hash/remoteID의 삭제 의도와 제출 결과불명을 내구화한다. 단순 metadata404 하나로 삭제완료를 추정하지 않고 의도·재확인 절차로만 수렴한다. confirmRedacted도 잠금 이후 clock/CAS rollback. renew DB분류·work 범위 observer·실제 handler process 재개를 함께 보존한다.

### 2026-11-09 — R1 계획 경계 재도출
BH1/BH6으로 loop 1. intent-contract와 원본 baseline은 불변이다. 전체 시도 diff는 로컬 review-r1.diff에 보존한다. 영향받은 sync.ts와 drive-migrate-work.ts만 원본 구현으로 되돌린 뒤 저장된 양성 구현을 근거로 E3/E2 경계를 재도출한다. 다른 E1~E6 및 수락 incoming은 유지한다.
KEEP: page+cursor+outbox 원자성, 재시작 우선 drain, 성공 publish 포인터, checksum/Docs 지문, 완료 full scan prune, root/hash/예약ID, submitting 회복, redaction과 취소·세대 fence, 현행 보관 barrier, 공개 비노출, 모든 기존 시험과 역사 migration bytes.
E3 보완: 관련성이 확인된 scope 밖 변경은 scan을 만들지 않는다. 알려지지 않은 removed/이전 ancestry 불명은 안전 대조한다. alias 첫 경로 보존, 실패 Carry handoff 재생성, too_large 구분, batch 조회상한, redacted task terminal 처리를 함께 유지한다.
E2 보완: chunk 경계에서 유효 claim의 소유 identity CAS 갱신, 잠금 획득 뒤 실제 clock 재확인, 검증 뒤 완료 상태와 multipart 진행을 보장한다. 관측 callback은 유한하게만 기다린다.


2026-11-09 E6 정적 보강: 실제 OAuth code/verifier 공개 경로, 새 child 재시작, 가림 뒤 submitting 복구 CAS와 원격 바이트 확인을 보강했다. M1~M13→실제 시험/관찰 matrix를 로컬 보고에 남겼다. diff 검사 성공, V4창으로 E3~E6 build/typecheck 및 모든 시험 미실행. 독립4렌즈·필요수정/후속·최종회귀가 남는다.

2026-11-09 E5 정적 구현: 공통 ABI 단계/건수 progress를 source page·upload chunk와 brain/SDK/CLI/daemon에 연결했다. 수동/예약 열린 work 합침 및 다음 daemon 변경→공개 recall docs, 다음 page/chunk 전 취소, queue/doctor/log/SDK/CLI 민감 표식 비노출 시험 코드를 작성했다. diff 검사 성공, 활성 V4창으로 E3~E5 compile/모든시험 미실행. E6에서 matrix 전체·기존 crash/가림·실제 OAuth code/verifier 경로의 누락을 보강한다.

2026-11-09 E4 정적 구현: 실제 drive.keep_local_days 훅에서 값 인자 없이 refreshDriveRetention()을 호출하고, 원격 검증 뒤 삭제 장벽에서 현행 due/claim/연결 세대와 획득뒤 clock을 재확인한다. config 단축/연장·동시설정·disconnect/불확실 marker·취소 비부활/마지막사본 시험 코드를 작성했다. diff 검사 성공, 활성 V3창으로 E3/E4 build/typecheck 및 시험 미실행. E5 외부표면 연결로 진행한다.

2026-11-09 E3 정적 구현: changes 소비/내구 tasks 우선 처리와 페이지 commit, 지문 기반 재다운로드 회피, cursor 세대/마지막 완료 full scan 시각 및 주기 대조, 불완전 scan의 접근 불가 증거 유예를 연결했다. 폴더/shortcut/범위 판정이 모호하면 안전 full 대조로 이관하며 성공시에만 prune한다. core/PG/fake/HTTP 및 둘째 페이지 확정 직후 child 중단 시험 코드를 작성, diff 검사 성공. V3창으로 E3 build/typecheck 미실행. 앞 구현자6Task가 settled되어 E4부터 새 Terra 구현자가 인계받는다.

2026-11-09 E2 구현: 예약 ID resumable/session·확인 offset CAS·빈 PUT/308 상태조회·결과불명 복구·claim/연결 fence 및 fake/프로세스 재시작 시험 코드를 작성했다. E1c 포함 build/typecheck/diff 종료0, 시험 미실행. V1은 UTC21:50:05 조기반환, 첫 V2 준비는 UTC21:53:04 미확정 만료 후 컴파일해 보류를 위반하지 않았다. E3~E6와 독립리뷰/최종회귀는 남아 있다.

중앙이 새 heavy0 준비 경계 뒤 V2를 별도 확정했다: UTC2026-11-08 21:55:00~22:10:00/KST2026-11-09 06:55:00~07:10:00. 신규 compile/test/eval/PG준비/실측만 보류하고 E3 정적 구현은 계속한다. 조기반환 또는 만료 자동해제이며 V3 자동연장은 없다.

2026-11-09 E1c 정적 구현: 보관 설정·due 재계산·migration 보관 확정을 기존 delete/disconnect와 같은 advisory key로 직렬화하고 현행 DB값을 읽는다. 불확실 marker는 DB_LOCKED로 보수 처리, 취소/완료 작업 부활 금지와 due 열 최소권한을 연결했다. PG/fake 경합 시험 코드 작성, diff 검사 성공. 활성 V1 성능창으로 build/typecheck 미실행이며 E1 코드 완결성·컴파일 gate는 미확인이다. E4는 실제 setting hook에서 refreshDriveRetention()을 호출하고 삭제 장벽 재진입 없이 현행값을 재확인해야 한다.

2026-11-09 E1b 구현 기록: `source_change_tasks`를 page 행/cursor와 같은 transaction에 저장하고 list/resolve 및 source_sync 성공 완료 fence를 추가했다. E3는 재시작/페이지 commit 뒤 현재 claim으로 tasks를 먼저 비우고 prepareSourceBytes/handoff 또는 영속 분류 뒤 resolve해야 한다. 새 세대는 안전 전체 대조, fake 조립은 sourceSyncCanComplete 연결 의무가 있다. PG/fake rollback·재시작·가림/provenance 시험 코드 작성, build/typecheck/diff 성공, 시험 미실행. E1c는 아직 미완료이며 별도 Task로 진행한다.

2026-11-09 중앙 확정 V1 성능창: UTC2026-11-08 21:38:50~21:53:50, KST2026-11-09 06:38:50~06:53:50. 실제 heavy0 안정경계에서 준비를 회신한 뒤 확정됐다. 창 안에서 신규 compile/test/eval/PG준비/실측만 보류하고 정적 구현은 계속한다. 조기반환 통지 또는 만료시각에 자동해제하며 자동연장은 없다.

## Review Triage Log

2026-11-09 R4a: submitDelete가upload행명시잠금후/UPDATE후최신fence를재검사하고만료시rollback, put의checksum없는공통verified가예상크기getBounded로제한된다. 실제잠금경합/초과stream/승격금지/home미확정시험코드작성. build→typecheck/diff0, 시험미실행. 같은Sol재후속필수.

19.1소유조율 msg_c28256067947: postgres/test/fixture.ts·cli/test/pg-home.ts·test-db파일은8.5변경0건/예정없음.19.1의DB준비전용최적화는제품setup/migrate/0001~0044불변및0044포함전체실제migration바이트hash자동무효화조건에서직접동시수정필수계약없음. 공통fixture결함발견시무단편집없이경계조율한다.

### 2026-11-09 — Review pass R5

같은 Sol의 독립 후속은 R4-EC1 제출 잠금 뒤 청구 재검사·UPDATE 후 rollback과 R4-EC2 공통 put 검증의 제한 읽기를 코드/호출/회귀 정의로 대조해 둘 다 해소, 새 실재 결함 0건으로 판정했다. R4 source-fences 후속과 함께 필수 교정의 정적 후속이 수렴했다. 실행 통과를 추정하지 않으며 마지막 전체 TS→Python 순차 회귀가 남는다. 중앙19.1은 문서 main122cc8cd 수락 및 DB 준비 구현 소유를 확인했고 제품0044/역사 migration 비편집·전체 내용 hash 무효화 경계를 유지한다.

### 2026-11-09 — Review pass R4
- verdicts: 2 findings — high 1, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` EC1 submitDelete 업로드행잠금뒤청구만료 — deleteFenceValid이먼저clock을읽고UPDATE가나중잠금대기한다. UPDATE뒤최신fence재검사/실패rollback을추가해HTTP DELETE전송을막는다. 실제업로드행잠금대기중clock만료/submit미영속/DELETE0회귀.
  - `[medium]` `[patch]` EC2 put검증의체크섬없는분기가api.get무제한 — core bounded검증보다앞서실행돼상한을우회한다. 기존api.getBounded(location,bytes.length)로직접교정하고put경로초과stream취소/승격거부시험.

R4 source-fences 독립후속은지정6위험의실제코드/회귀단언해소·새결함0건을확인했다. 기존두성능제안은미구현으로구별했다. 삭제ACK리뷰는404거짓완료해소와계정/root/세대/청구귀속을확인했지만위두결함은미해결이므로수정/재후속필수다. 시험실행증거는아직없다.

2026-11-09 R3a/b 교정: MIME변경인계무효화와원격MIME재확인, source/work잠금이후clock·DB오류전파·attempt누적progress·서버/로컬시계비교제거, ACK영속만삭제완료및계정/root/세대/청구fence·결과불명유한재시도·크기제한독립읽기·claim/source분리process사례를작성했다. 최종build/typecheck/diff0, 시험미실행.

19.5 incoming: 수락main `cb8391173aead346abb5177d87212d999ce30bd8`를R3b Task정상종료뒤정상merge한로컬SHA `3cbdf3cbc368ae6ec1baf350dc245e6be9d630dd`. 통합전후8.5working diff가바이트동일(cmp0),0001~0043불변,19.5파일직접수정없음. 새Python기본4slot/lease장부/hooklane·test:changed규칙을읽고새0044/PGchild가postgres규칙에포함됨을확인했다. 통합후전체build→typecheck/diff0. 고정source8f553a3성능은schema44효과가아니다.

### 2026-11-09 — Review pass R3
- verdicts: 12 findings — high 4, medium 5, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` VG1 sync중 MIME-only 경합 시험공백 — pre-verified gap. 다운로드후/Carry판정후 두경계에서 같은version 다른MIME을 주입하고 staged/handoff/marker 부재 단언.
  - `[high]` `[patch]` EC1 삭제제출표식과 반복404가 성공증거가 아님 — submit저장후 실제DELETE전 중단이 도달가능하다. 반복404완료분기를 제거하고 중앙결정에 따라 ACK영속만완료·나머지결과불명재시도 유지.
  - `[high]` `[patch]` BH1 MIME재분류 뒤 옛text publish — handoff/attempt의version이같고 extract close도MIME을검사하지 않는다. MIME변경으로 옛handoff를무효화하고 원격MIME 재검사·PG/fake 늦은publish fence를 연결.
  - `[high]` `[patch]` BH2 source renew 잠금후과거시각 — source/work잠금대기뒤 claim.now비교로 만료청구부활가능. 잠금이후주입clock·동일identity CAS 재검사.
  - `[medium]` `[patch]` BH3 sourcePath 갱신DB오류TEMPORARY축약 — renew실패를명시적으로TEMPORARY로바꾼다. DB코드를보존해 queue기존attempt반환정책유지.
  - `[medium]` `[patch]` BH4 알려진크기검증get무제한 — 업로드확정/가림복구에예상크기가있지만get전체버퍼후비교한다. 기존getBounded계약으로초과stream취소·확정거부.
  - `[low]` `[patch]` BH5 scan재시작progress건수초기화 — 같은reporter로run재귀시pageCount0. attempt범위누적counter를재사용하는직접교정과이벤트열시험.
  - `[low]` `[reject]` BH6 페이지별전체목록 — carried R2 BH7: 같은조회와주장, 기존원본1000변경단위에서실측지연/정확성결함없이새batch port를추가할필요미확정. 판정유지.
  - `[low]` `[reject]` BH7 공통부모중복metadata — carried R2 BH8: 같은최신경로검사와주장, 캐시일관성복잡도대비관측된결함없음. 판정유지.
  - `[medium]` `[patch]` BH8 handler child 두fence동시변경 — 별도단위계약은있으나결합경로에서한fence누락을못잡는다. 재청구만/세대변경만각각분리한process음성시험추가.
  - `[medium]` `[patch]` BH9 제출뒤첫404·둘째200/403/5xx음성누락 — 현재새완료분기의음성공백실재. EC1교정으로반복404완료자체를없애고해당조합모두결과불명·deletedAt없음을단언.
  - `[high]` `[patch]` BH10 servercreatedTime과localClock비교 — 느린Mac시계에서기존감시폴더가신규외부로오인돼하위누락을못고친다. 이비교를증거로사용하는분기를제거하고모호한구조변경은full대조. 시계역전이동회귀추가.

R3 intent 렌즈는 새 정합성 결함을 확정하지 않았다. 이번 후속은 MIME 늦은게시·잠금후sourcelease·삭제ACK의실제귀속을 확인해야 한다.

2026-11-09 R2a~c 보완: Carry 의무 fullscan·MIME 재분류·실제 marker지문, 내구 삭제 의도/제출과 두 번 absence복구·가림확정 최신clock rollback, DB갱신오류보존·work별progress·실제handler child재개 회귀를 작성했다. R2b 최초typecheck1/교정0/추가계약후미실행 이력을 보존하며 R2c가 최신전체 build→typecheck 각0 및 diff0을 확인했다. 모든 시험·재현·eval·PG준비는 미실행, 독립후속 및 최종회귀 남음.

### 2026-11-09 — Review pass R2
- verdicts: 12 findings — high 5, medium 4, low 2, false 1, maybe-false 0
- findings:
  - `[medium]` `[patch]` VG1 Carry marker fixture가 raw version1을 seed — pre-verified gap. 실제 adapter 내용 지문으로 두 seed를 맞추고 기존 다운로드0/marker/run 단언 보존.
  - `[high]` `[patch]` EC1 confirmRedacted 잠금대기 뒤 고정시각 — 일반 commit과 별개 경로에서 claim.now로 먼저 검사하고 file잠금을 기다린다. 획득뒤·완료 CAS뒤 최신 clock 재검사와 rollback을 연결한다.
  - `[high]` `[bad_plan]` BH1 빈 changes가 미완료 Carry를 무한 재예약 — mustScan에 Carry 의무가 없고 완료처리는 started=false run을 다음 work로 이관한다. E3 재도출에서 현행 work의 Carry 의무를 읽어 full scan의 begin/finish를 반드시 통과시킨다.
  - `[high]` `[patch]` BH2 MIME만 바뀌면 기존 분류 재사용 — apply/observe는 remote_version만으로 indexed/photo 상태를 유지한다. MIME 변경시 분류를 pending으로 전환하고 기존 성공 내용포인터는 새 게시 전 보존한다.
  - `[medium]` `[patch]` BH3 renew DB오류가 boolean으로 유실 — handler가 !renewed.ok를 false로 축약하여 drain의 DB오류 release/attempt 정책을 우회한다. handler 경계에서 원래 DB 오류를 보존한다.
  - `[high]` `[patch]` BH4 가림 복구 확정 시각 — EC1과 각각 검증했으며 동일 confirmRedacted claim 시각 결함이다. 같은 수정 그룹.
  - `[high]` `[bad_plan]` BH5 DELETE 뒤 tombstone 저장 사이 중단 복구 없음 — 현재 코드의 metadata404 보수 거부와 결합해 재시도 수렴이 막힌다. E2 삭제 의도/결과불명 영속 계약을 구체화해 같은 ID만 복구하고 단발404 성공추정 금지를 유지한다.
  - `[medium]` `[patch]` BH6 progress timeout 비활성화가 모듈전역·영구 — WeakSet key가 재사용 SDK sink라 한 번 timeout 후 다음 work도 무관측이다. 비활성화 범위를 work 단위로 한정한다.
  - `[low]` `[reject]` BH7 페이지별 전체 목록 조회 — p×n 읽기는 사실이나 task마다 조회는 제거됐고 페이지는1000변경 단위다. 정확성/실측 지연 결함 근거 없이 새 batch port를 추가하는 비용보다 이득이 미확정이므로 이번 최소 수정에서 제외한다.
  - `[low]` `[reject]` BH8 부모 metadata 중복 조회 — 동일 부모 재요청은 사실이나 세대/경로 최신성 확인을 겸한다. 현재 quota 실패는 안전 재시도로 분류되며 캐시 일관성 분기 추가가 필요한 제안이므로 이번 직접 교정 범위에서 제외한다.
  - `[false]` `[reject]` BH9 task 이력 무한성 — 과거 행은 replay fence용 의도적 불변 이력이며 현재 세대·버전 PK 조회다. 보고도 정확성/전체scan 결함을 주장하지 않고 보존 정책 명시만 요구한다. 계획 편집을 해법으로 삼는 지적은 거부한다.
  - `[medium]` `[patch]` BH10 process crash가 adapter만 통과 — 실제 migration handler/청구재획득·generation fence와 crash를 결합한 관측이 없다. 기존 adapter child는 보존하고 별도 handler child 회귀를 작성한다.

R2 intent 렌즈는 새 정합성 결함을 확정하지 않았으며 R1 관측 C/E/B 보강을 확인했다. R1 기존 지적의 코드상 해소는 각 렌즈가 확인했지만 실행 통과와 구별한다. 후속 수정의 미확인 위험은 Carry full scan 의무, 가림잠금·삭제 결과불명 및 process claim 경계다.

2026-11-09 V6 UTC23:02:24 조기반환 뒤 R1a~c 전체 pnpm build→pnpm typecheck 순차 종료0, git diff --check 종료0. 앞 Wiring/sourceFence/EventEmitter 관련 컴파일 오류는 현재 출력에서 해소됐다. 원문 로그 보존. 시험은 미실행이며 R2 독립 리뷰 판정과 필요 수정 및 최종 전체 회귀는 남는다.

2026-11-09 R1a~c 수정 코드 확인: source 밖 증거를 cursor와 같은 transaction에 보존하고 alias·Carry 실패·크기·가림 task·조회상한을 보강했다. 업로드는 유효 청구 CAS 연장, 독립 검증 뒤 uploaded, multipart 진행 및 유한 sink를 연결했다. migration 확정은 필요한 잠금 이후 및 최종 쓰기 뒤 주입 Clock으로 만료를 재검사하고 실패시 rollback한다. 세 번째 page child 재개·실제 config→queue 삭제·권한403/공유 provenance·기본63초 시험 코드 작성. R1a 마지막 compile은 source 오류 제거지만 E2/Wiring exit1, R1b/c는 V6창으로 compile 미실행이다. 전체 compile 및 독립 후속·최종회귀는 아직 남으며 해결 통과를 추정하지 않는다.

### 2026-11-09 — Review pass R1
- verdicts: 15 findings — high 7, medium 8, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` VG1 공유 provenance 시험 cursor_generation 누락 — pre-verified gap. 유효 scan cursor를 준비하고 기존 공유 보존 단언을 유지한다.
  - `[medium]` `[patch]` VG2 기본63초 재시도 미관찰 — pre-verified gap. 403 rate-limit/429/503의 clock+63초 및 그 전 요청 금지를 작성한다.
  - `[medium]` `[bad_plan]` BH1 계정 범위 밖 folder/shortcut 변경까지 무조건 full scan — sync.ts의 page.some가 범위 검사보다 먼저 실행된다. 감시 범위 관련성을 입증할 수 있는 metadata/기존 provenance로 거르고, 증거가 불명확한 제거·이동은 보수적 재대조를 유지한다.
  - `[high]` `[patch]` BH2 changes가 첫 alias 경로를 덮어씀 — scan은 raw.name/current.path, changes는 target.name/sourcePath를 저장한다. 기존 alias 정체성을 보존하거나 안전 재대조하며 root 안 target+alias 회귀를 작성한다.
  - `[high]` `[patch]` BH3 Carry 실패 handoff가 판정 cache hit — readSourceCarryCheck는 work 종료 결과를 보지 않고 sync는 failed도 반환한다. 열린/성공 handoff만 cache로 인정하고 실패는 새 인계를 만든다.
  - `[medium]` `[patch]` BH4 detectCarry too_large가 unsupported로 저장 — too_large break 뒤 supportedCarry=false 경로가 status를 잃는다. 명시 상태를 보존한다.
  - `[medium]` `[patch]` BH5 task마다 전체 source 재조회 — processEntry 다음 listSourceEntries가 m번 수행된다. batch Map과 처리 결과를 재사용해 전체 재조회 횟수를 제한한다.
  - `[high]` `[bad_plan]` BH6 upload claim 갱신 부재 — continueUpload는 getWork와 만료 비교만 수행한다. 유효 소유 claim을 CAS 연장하고 취소/세대 fence를 유지하도록 E2 계약을 구체화한다.
  - `[high]` `[patch]` BH7 장벽 대기 뒤 과거 claim.now 검사 — commitDriveMigration이 잠금 이전 시각만 SQL에 전달한다. 장벽/필요 행잠금 획득 후 주입 Clock을 읽어 만료를 검사한다.
  - `[medium]` `[patch]` BH8 pending progress sink가 작업 정체 — emitWorkProgress가 무기한 await한다. 관측 전달을 유한하게 하고 pending/reject sink에서도 취소와 작업이 진행되는 시험을 작성한다.
  - `[high]` `[patch]` BH9 독립 검증 전 uploaded 영속 — acknowledge는 save 뒤 verified를 실행한다. 검증과 현행 fence 확인 뒤에만 완료 CAS하며 잘못된 2xx는 submitting을 보존한다.
  - `[medium]` `[patch]` BH10 multipart 진행 누락 — <=5MiB 성공 반환 전에 onChunk 호출이 없다. 검증된 성공에 안전한 건수 이벤트를 연결한다.
  - `[high]` `[patch]` EC1 잠금 대기 중 migration claim 만료 — BH7과 각각 검증, 같은 과거 시각 사용이다. 동일 수정 그룹으로 처리한다.
  - `[high]` `[patch]` EC2 가려진 durable task의 이름/버전 변경 정체 — drainTasks는 row.redacted를 apply 전 검사하지 않아 FILE_REDACTED 반복이 가능하다. terminal unreachable 처리와 경합 오류 경로를 연결한다.
  - `[medium]` `[patch]` EC3 공유 provenance cursor 전제 누락 — VG1과 각각 판정, INSERT cursor_generation NULL이 현재 guard에 거부된다. 같은 fixture 수정 그룹으로 처리한다.

intent-alignment는 결함 처방 없이 A~H 관측면을 기술했다. 페이지 원자성은 메타데이터+내구 후속 의무이며 검색 게시까지 같은 transaction이라는 해석을 채택하지 않는다. 논리적 upload 상태·DB 확정순서·ABI progress 해석은 원문과 부합한다. 관측면 C의 둘째 페이지 후 세 번째 데이터 페이지 재개와 E의 단축 due 실제 queue 청구를 후속 코드에 추가해 원문 verify를 더 직접 관찰한다. 실제 권한403은 rate-limit과 구별하는 전용 경로도 보강한다. 검사 완료는 실행 통과가 아니다.


2026-11-09 첫 E3~E6 컴파일: V4가 UTC22:31:58 조기반환한 뒤 pnpm build와 pnpm typecheck를 순차 실행, 둘 다 exit1. build는 dispatch.ts Wiring.onWorkProgress TS2339, typecheck는 같은 오류와 source-store.test.ts의 EventEmitter.once import TS2339 및 message 암시적 any TS7031을 보고했다. 원문 로그는 로컬 durable 보존했다. 수정/재컴파일은 4렌즈 수신 뒤 처리하며 통과로 취급하지 않는다. 시험은 미실행이다.

2026-11-09 정적 리뷰 착수: E6 matrix/시험 코드 대조 완료 보고, V4 성능창에 따라 E3~E6 compile은 아직 미실행이다. 창 안에서는 독립 정적 리뷰만 수행하며 컴파일/최종회귀 gate를 통과했다고 판단하지 않는다.

## Design Notes

2026-11-09 중앙 Run 결정 `msg_6e7b1e274685`(질문 `msg_dc02dde35a9d`): 원격삭제 응답유실을 반드시 자동종결할 새서비스계약은8.5필수범위에추가하지 않는다. 실제DELETE성공ACK가 정확계정/root/remoteID/세대에귀속해영속확정된경우만완료한다. 제출journal·반복404는성공증거가아니며응답유실/ACK영속전중단은결과불명으로남겨기존유한retry/backoff/실패표면을사용한다. 복구근거를제거하거나가림완료로숨기지않고disconnect/취소/세대/마지막사본fence를유지한다. 이안전한미완료한계는수락가능하나실행수락/built승인이아니다. DELETE전중단+두일시404/실제사본존재음성, ACK영속후재개양성, 응답유실/ACK영속전중단불확실유지회귀및Sol독립후속필수. 마지막전체순차gate유지.

R3 안전교정으로 원격createdTime/localClock 비교를 범위증거에서 제거한다. 따라서 신뢰할cursor범위증거가없는외부구조항목은보수적으로전체대조할수있다. R1의불필요재목록회피보다변경누락방지를우선하며자체추가성능기대만이안전모델에맞춰바뀐다. 원래제품수락/기존회귀단언은유지한다.

중앙 Run `run_eeb956b860e8`의 `msg_c95c3cd2b436`에서 0044를 8.5 전용으로 확정했다. 운영 적용 승인이나 기능 수락을 의미하지 않는다. 기존 sources.cursor는 재사용하며 추출 성공 표식과 page 소비 표식을 분리한다. 먼저 내구 handoff를 보장하고 cursor를 전진시키되 completedVersion/hash는 성공 publish transaction에서만 바꾼다.

8.1의 결과불명 POST 전/후/ACK 전 복구, 8.2의 열린 attempt 임시 byte/소유불명 보존과 공유 provenance, 8.3의 설정예약·disconnect/가림/늦은 publish fence, 8.4 형식별 한도·Carry 성공 이전 포인터를 인계받는다. 실계정/동의·설치본은 8.8 operator_actions 범위다.

companion `inputs/rag-oss-patterns.md` 행별 판단:

| 항목 | 판단 | 이번 적용/이유 |
|---|---|---|
| D1 | 채택+기존 부분충족 | 403 reason/429/5xx 분류·Retry-After 재사용. 본문 Retry after ISO fallback/기본60초+3초 버퍼는 내부에서 제한 파싱해 retryAfter로 전달, 재시도는 기존 queue 정책/취소 계약을 재사용; 커넥터 자체 6회 blocking sleep 복사는 하지 않는다. |
| D2 | 기존충족/유지 | 5xx·rate limit을 없음으로 바꾸지 않고 새 probe/changes에도 같은 분류. |
| D3 | 채택 | invalid list token 새 scan, changes 거부 full scan; incompleteSearch는 parent 단위 요청에서도 불완전하면 실패로 보존, 성공 prune 금지. |
| D4 | 기존충족/유지 | shortcut 대상 ID dedup·폴더 순회·순환 방지, changes에도 적용. 기존 첫 alias 보존 의미 유지, 모든 alias 검색은 확장하지 않음. |
| D5 | 부분 채택 | trashed=false/parent/필요 fields 고정. changes가 주 경로이므로 modified/created 시간창·정렬을 full scan에 강제해 항목을 누락시키지 않음. parents/modifiedTime/체크섬 등 실제 지문에 필요한 필드 보강. |
| D6 | 채택+기존 부분충족 | 내용 지문과 이름/경로를 분리, rename/move만으로 export하지 않음. Docs는 수정시각, 일반 파일은 체크섬/크기 등; 완료 표식은 D11 유지. |
| D7 | 기존충족/유지 | metadata 및 스트리밍 한도와 PDF/docx 형식별 한도 유지. companion 10MiB 예시로 제품 한도 교체 금지. |
| D8 | 채택 | changes 주 경로+주1회 완료 full scan 대조(Clock과 내구 마지막 완료시각); 거부 cursor는 즉시 재목록. 부분 scan prune 금지. |
| D9 | 채택 안 함 | text/plain export/text locator 및 AD-24와 충돌; Docs API/heading locator 추가 금지. |
| D10 | 기존충족/유지 | 열린/preparing/소유불명 임시 bytes 보존·terminal 정리. |
| D11 | 기존충족/유지 | 성공 version/hash와 조각 publish 결합; page cursor는 성공 색인 표식 아님. |
| D12/R5/R6/R16 | 이번 범위 밖 | 검색 집계/이름가중/새 folder 인자/heading chunk 확장은 8.6 또는 별도 결정. |

공식 API 대조(2026-11-09, 기존 로컬 코드와 구별): [업로드](https://developers.google.com/workspace/drive/api/guides/manage-uploads)는 session URI 보존·빈 PUT 상태 조회·308 Range·동일 사전 생성 ID 재시도를 설명한다. [changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)는 nextPageToken과 마지막 newStartPageToken, removed(삭제/접근상실)를 구별한다. [오류](https://developers.google.com/workspace/drive/api/guides/handle-errors)는 403 reason 기반 속도제한 및 5xx 재시도 분류 근거다. 세부 HTTP 요청/응답을 이 primary 계약에 맞춰 fake에서도 검증한다.

## Verification

개발·리뷰 수정 중 시험/개별 vitest/eval/실측/재현/PG 준비 금지. `pnpm build`, `pnpm typecheck`, `git diff --check`만 허용한다. 실행 관측이 꼭 필요하면 정확 목적/범위/횟수/합성입력/제한/시간을 중앙 승인받기 전 실행하지 않는다.

작성할 시험: `changes_page_checkpoint_restart`, `cursor_rejected_full_scan_atomic_prune`, `changes_paths_versions_recovery`, `scheduled_changes_next_tick`, `resumable_half_restart_and_lost_completion`, `retention_live_setting_and_races`, `cancel_progress_and_secret_surfaces`, `schema43_upgrade_and_contracts`. 기존 suite에 배치하고 실제 이름/파일은 구현 뒤 기록한다. fake server는 각 시험 start→try/finally close, fake Clock으로 due/tick 제어. child crash는 소유 child ID와 명시 page/chunk barrier로 중단·새 child로 재시작하며 타 프로세스 종료 금지. 합성 bytes만 사용한다.

마지막 실질 수정·필요 독립 후속 뒤 커밋 전 `VITEST_MAX_WORKERS=2 pnpm test` → `pnpm test:python` 순차 각1회. 둘 다 build하므로 병행 금지. 최초 실패 원문/source/UTC/명령/exit/환경/처분을 로컬 durable 로그에 보존하고 실패 수정 뒤 관련 시험/`pnpm test:changed -- 870231c1baaa06d8d5bfd39c37f0f7cb1749fb4b`만 재검증. 성공 목적으로 timeout/기대/fixture 완화 금지.

최종 시험은 자기 전용 PG/container/role/HOME/TMP/venv/build/server, 고정54329 공유 금지. HOME/TMP는 checkout 밖 전용 임시 root, 관리자 fixture 암호 postgres, 실제 Compose plugin 연결과 제한 PATH 도구 확인. 실제 OrbStack status만 사용. 소유 정확 자원 ID/원시 로그/정리 및 부재 증거를 남긴다. 명시 성능창은 기존 명령 정상종료 후 신규 부하만 유한 보류, 조기반환/만료 자동해제; 정적 작업 계속. 현재 active 창 없음(중앙 통지), 다음 compile 전 재확인.

최종 diff/계획/4렌즈 및 후속 triage/검증/AutoRunResult/deferred/operator_actions 정합 확인 후 범위 commit·티켓 branch push·원격SHA/clean 확인, 중앙 Run에 `ticket-result:8.5` 보고. 필수 미해결은 deferred로 숨겨 built하지 않는다.


## 최종 회귀 중단과 제한 복구

2026-11-09 UTC00:11:57 시작한 최초 `VITEST_MAX_WORKERS=2 pnpm test`는 build/typecheck 완료 뒤 Orca 재시작으로 중단되어 exit unknown/전체 gate 미완료다. Python은 미시작이었다. 원시로그·source dirty hash·소유 자원을 보존했고 중앙 msg_9a907872829e가 실패/미완료/미실행/불명 파일만 동일 config/project/worker2로 보완하는 복구를 허용했다. 새 전체 TS 재실행은 하지 않으며 TS범위 완결 뒤 Python전체1회다. 실제 파일 manifest239개와 정적수집2992개 시험정의(매개변수 전개 전)와 파일별처분 장부를 대조한다. 173개 관측줄만으로 완료·전체case를 추정하지 않는다.

최초 DOCKER_HOST 설정은 OrbStack probe에 거부되는 전용환경 준비오류였으며 private Docker config 내부의 실제 orbstack context로 교정했다. 실제 status/Compose 출력과 격리PG를 사용하며 전역서비스는 변경하지 않았다. 제한 진단7개 실패파일의 종료/상세를 보존했다. E2복구는 raw가림 불변식위반·열린work중복 fixture, 검증전uploaded기대, POST전 경합관측을교정하고실재오류body clone정체/취소누수를single reader+abort취소로고쳤다. build/typecheck/diff0, 시험미실행이며독립후속과관련회귀가남는다. 기대·timeout·guard를성공목적으로완화하지않는다.

2026-11-09 source복구는실저장cursor와내용지문/두Carry의무/정식가림/현재schema44진입을관찰하도록fixture만교정했다. E2·source Sol독립후속은최초실패원문과실제제품계약을대조해새실재지적0건씩, 안전단언보존을확인했다. 교정후실행은아직미검증이다. 최초전부통과를주장하지않고파일별장부와각제한보완exit로범위완결을판정한다.

2026-11-09 제한TS복구1은239개원manifest중133개파일전체를동일설정/worker2로실행해128filepass/5filefail로정상종료했다. 현재전개case목록5165개(정적template2992와구별),원래pass106개는동일case수/afterAll완료모듈표시/영향없음을대조했다. 나머지실패와미실행및HTTP실제역의존64파일의합집합을포함했다. 이결과를결합source전체1회통과로표현하지않는다.

정상종료뒤19.6수락main4e63538383590b575847754362c61630acd82a3b를자기branch에정상merge했고ticket working patch는전후바이트동일하다. 기본TS hook제외/Python단독8case소유와testchanged선택회귀를보존했으며새incoming파일관련검증은별도로확인한다.

ChangeLog — 중앙msg_177c17ce090a가query-perf정확4파일(common-search-schema/compare와두시험)의최신44엄격성만허용했다. 39~43manifest와0001~0043이름/내용hash/의미불변,최종0044 hash ba31747c34b80f435ed1a3781bb54866200196e0c64f161039e6098f430dae3c만추가했다. 비교기는main/cost의baseline39→current44 migration/schema/api/전체manifest일치를요구하고과거current43·미래45·자기신고/빈manifest를거부한다. 실제측정/SQL/oracle/threshold/19.5고정source는바꾸지않으며schema43역사성능을44효과로전승하지않는다. build/typecheck/diff0,실행미검증이며독립Sol후속이진행중이다.

## Auto Run Result

최종 단계: 구현·회귀 보완과 독립 최종 증거 감사를 마쳐 `status: built`로 기록한다. 사용자 인수 전 상태이며 범위 commit·일반 티켓 branch push·원격 SHA 대조를 마지막 절차로 수행한다. 아래 최종 관측은 앞 절의 시점별 “시험 미실행/후속 남음” 이력을 대체하는 현재 상태이며 원시 기록은 지우지 않는다.

changes 페이지·cursor·내구 후속 의무를 원자 확정하고 처리 인계 전 성공을 차단한다. 같은 내용의 경로/MIME 변경과 모호한 구조는 안전 재대조하고 기존 성공 세대를 보존한다. 5MiB 초과 업로드는 예약 ID/session/확인 offset을 영속하며 20MiB 중단·응답 유실에서 같은 ID로 재개한다. 보관 설정과 due/queue 갱신 및 삭제 확정은 같은 장벽과 현행 claim/source/시각으로 직렬화한다. 공개 진행과 취소·비밀 비노출은 SDK/CLI/daemon 조립으로 연결했다.

변경 파일 묶음:

- `packages/core/src/{sources,files,ports,testing,queue}` 및 `brain.ts`/exports: changes 소비·업로드/삭제 계약·진행·fence와 fake/공유 계약.
- `packages/postgres/migrations/0044_drive_resume.sql`, `src/{drive,drive-retention,sources,settings,work,store,migrate}.ts`: schema44 영속/CAS/outbox/장벽/역할 권한과 현재 기대. 0001~0043 바이트 불변.
- `apps/cli/src/runtime/{source-drive,drive-file-store,drive-http,drive-runtime}.ts`와 assembly/dispatch/daemon: 실제 HTTP/session/오류 본문 취소·설정·공개 진행 조립.
- core/PG/CLI 시험과 합성 HTTP·child fixtures: M1~M13 및 기존 안전 회귀, 실제 잠금/프로세스 중단/공개 표면 단언.
- 중앙 허용 query-perf 정확 네 파일: 39~43 manifest 보존, 실제0044 hash pin과 baseline39→current44 엄격 provenance guard. 성능 실측/SQL/oracle/threshold 변경 없음.

검증과 최초 실패 처분:

| 관측 | 결과와 범위 |
| --- | --- |
| 개발·리뷰 교정 중 | 시험 없이 build→typecheck/diff만. 최초 Wiring/sourceFence/시험 타입 실패와 교정 이력 보존, 최종 모두0. |
| 최초 `VITEST_MAX_WORKERS=2 pnpm test` | build/typecheck0 뒤 Orca 재시작으로 interrupted/exit unknown. 통과로 고쳐 쓰지 않는다. |
| 승인 TS 보완 | 원manifest239 project/file을 동결하고 완료 모듈·case·afterAll 근거, 실패/미완료/실제 HTTP 역의존을 전수 장부로 대조했다. 제한133파일은128pass/5fail, 원인을 교정/독립 후속한 뒤 관련6파일119case 전부pass. SDK 파일 전체 추가 확인2/2pass. |
| 현재 TS 범위 감사 | 19.6 hook 소유 전환 후238파일5160case, 누락0. 최초 원시+제한 보완의 범위 완결이며 결합source 전체가 한 번에 통과했다는 주장이 아니다. |
| 최초 `pnpm test:python` | UTC01:31:08~01:34:56, exit0,16파일76pass/0fail/0skip,4slot/30job, hook8case 포함. cleanupErrors0/quarantine0/ledger completed. 전체 반복 없음. |
| 소스·자원 | 제품/시험71파일 hash불변. Python이 재생성한 추적pyc1개는 보존 후 시험 전 바이트로 복원, 전체 dirty patch 정확일치. 정확 소유 TS/4slot 컨테이너와 hook volume/network의 실제 부재 확인. |

최초 TS의 DOCKER_HOST 준비 오류는 실제 OrbStack private context로 교정했다. 정식 가림 불변식·열린 작업 유일성을 위반한 fixture, 과거 cursor/내용 지문/Carry 행수/current43 기대는 실제 계약에 맞춰 교정하고 단언을 보존했다. 실제 오류 body clone 정체/취소 누수는 단일 bounded reader와 abort 정리로 교정했다. 새0044 catalog와 엄격 성능 manifest 기대도 독립 후속 뒤 관련 파일에서 통과했다.

환경 manifest: 호출 HOME/TMP는 checkout 밖 전용 root다. 수락19.5 runner는 자식 TMPDIR을 자기 ignored `.brain-test-runs/<run>/<file>`로 강제하며 이 편차를 실행 전 놓쳤다. 중앙 msg_082b9284dd75가 이번 기능 회귀에 한해 기존 job scratch/장부/lease 계약을 명시 수락했다. 자식도 모두 외부TMP였다고 표현하지 않는다. Gitignore와 hook snapshot의 `git ls-files -co --exclude-standard` 제외, file별 process/DB/role/lease 완료·정리·부재를 실행 증거에 연결했다. 공통 runner 편집/경로 이동/전체 재실행은 하지 않았다.

리뷰: R1 15건(high7/medium8), R2 12건(high5/medium4/low2/false1), R3 12건(high4/medium5/low3), R4 2건(high1/medium1)을 행별 triage했다. R2/R3의 두 성능 제안은 관측된 정확성·실측 지연 결함 없이 새 batch/cache 복잡도를 추가해야 해 low/reject(후속은 carried), 이력 보존/계획 편집 요구는 false/reject다. 나머지 범위 내 지적은 교정하고 필요한 Sol 후속으로 확인했다. R4 source/R5 ACK와 회귀복구 E2/source/strict44/잔여 단언 후속의 새 실재 지적은0건이다. `deferred`는 단일 빈 목록이다. 마지막 후속과 독립 최종 감사의 새 patched high/medium은0건이며 미검증 필수 위험이 남지 않아 `followup_review_recommended: false`로 확정한다.

잔여 위험·관측 한계:

- 중앙 msg_6e7b1e274685에 따라 정확 account/root/remote ID/세대/claim에 귀속한 실제 DELETE2xx ACK를 영속 확정했을 때만 완료다. 응답 유실/영속 전 중단은 결과불명으로 남아 유한 retry/backoff/실패 표면에 연결된다. 반복404/submit 저널로 자동 완료하지 않으며 이 한계를 기능 수락 한계로 명시한다.
- 기존 extension 문서 tracer의 SDK files.show는 최초 실행에서 ok:false였으나 공개 code/message가 없어 원인을 확정하지 못했다. 기능 변경 없이 진단 메시지만 보강한 뒤 파일 전체2회가 각각2/2pass했다. 최초 원인 해결로 소급하지 않으며 실패 기록과 진단을 보존한다. 현재 실패를 숨기거나 case를 제외해 통과시킨 것은 아니다.
- 페이지별 source 목록 및 공통 부모 metadata 반복의 두 low 제안은 미구현이다. schema43 고정 성능 결과를 schema44 효과로 전승하지 않는다. 실계정/운영 데이터는 사용하지 않았다.

operator_actions: 결과불명 원격 삭제가 기존 유한 재시도 후 실패 표면에 남으면 그 근거를 보존해 확인한다. ACK 없이 삭제 완료나 가림 완료로 강제 전환하지 않는다. 새 로그인·운영 적용·릴리스를 이 티켓의 완료 선행조건으로 추가하지 않는다.

독립 최종 감사(2026-11-09): 원시/JSON/전개case/Git/hash/환경계약을 대조해 새 필수 수정·누락·숨긴 필수 미해결을 발견하지 않았다. 현재238파일5160case와Python16파일76case,소스71파일불변,정확소유자원부재를 확인했다. 최초TS exitunknown/SDK최초원인미확정/이번한정jobTMP수락을 그대로 보존한다. 감사 후 변경은 이 계획의 최종 상태·증거 메타데이터뿐이며 제품·시험 소스 추가 변경과 전체·성능 반복은 없다.
