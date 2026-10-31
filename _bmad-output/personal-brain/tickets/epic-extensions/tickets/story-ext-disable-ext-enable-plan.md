---
title: '확장 켜기·끄기와 공통 공개 상태'
type: 'feature'
ticket: '6'
created: '2026-10-31'
status: done
baseline_revision: '7c6689902993ea4963634ce445cc7f8f36c21e5f'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

확장을 끄면 원치 않는 외부 호출을 멈추고 데이터는 보존하며, 다시 켜면 대기 일감이 이어서 실행되게 한다. 설치·활성·로그인·연결·예약·실패와 중단 상태를 비밀 없는 한 SDK projection으로 조회하여 doctor·CLI 및 후속 install 스킬·검색이 같은 사실을 소비하게 한다.

## Boundaries & Constraints

- registry가 활성 의도의 유일한 작성자다. 활성 변경과 `extension:<name>` 보류/해제는 PostgreSQL의 같은 트랜잭션으로 확정한다. 기존 12.10 큐·감독자·예약 보류 수단을 재사용하고 별도 취소 엔진을 만들지 않는다. 새 port가 이 트랜잭션을 소유하므로 시작/status 재조정은 필요하지 않다.
- disable 뒤 진행 일감은 기존 감독자의 보류 취소 경로로 중단하고, 대기 일감은 `extension_disabled`로 남긴다. 예약 발화와 새 청구·retry/run 우회는 기존 보류 계약으로 차단한다. 같은 보류 그룹의 core 분석도 멈추며 다른 그룹은 유지한다. enable은 보류를 해제하고 대기 일감을 재개한다. disable 응답을 자식 종료 확정으로 꾸미지 않는다.
- 확장 schema·데이터·설치 파일·tokenstore는 유지한다. 반복 enable/disable은 멱등이며 미설치 이름은 거짓 성공하지 않는다. DB 실패는 실패로 전달하고 어느 한쪽만 변경하지 않는다.
- 공개 조회 계약은 core의 명명된 SDK projection과 Store port로 정한다. 미설치도 이름으로 조회할 수 있다. 설치 여부·버전·활성 의도, 로그인 단계 상태, 연결 확인 상태, 예약 등록 단계와 실제 보류 예약 수, 미완료 중단 일감 수, 설치 결과·단계별 고정 코드와 마지막 실패를 담는다. 설치 진행 중 journal만 있는 이름도 구분한다. 명시 필드만 반환하고 설정값·비밀 참조·DB URL·패키지 경로·자식 원문 진단은 포함하지 않는다.
- `ext status`, doctor는 이 동일 projection을 읽는다. CLI를 역해석하지 않고 SDK에서 직접 소비할 수 있도록 타입과 진입점을 export한다. install 스킬 구현은 13.7, 검색 응답 표시는 epic 17 소유다. 기존 CLI/SDK 설치 결과의 필요한 호환 필드는 보존하며 추가 필드로 공통 상태를 전달할 수 있다.
- 기존 `brain.extension_status_public_v1`의 세 열과 자기 행 ACL 및 13.2 비밀 보호를 보존한다. projection을 위해 확장 role의 core 테이블 권한을 넓히지 않는다. 적용된 migration은 수정하지 않는다. 새 migration이 필요하면 0016 다음 번호를 쓴다.
- 실제 Garmin·계정·Python 기본 의존·별도 LaunchAgent·운영 홈 변경은 범위 밖이다. 격리 home/PG와 Node fixture를 쓴다. 티켓 파일·tickets.toml·완료 상태·커밋은 지휘자/오케스트레이터 소유다. 워커는 커밋·done·tickets.py mark·push를 실행하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 관찰 결과 | 실패 처리 |
|---|---|---|---|
| 끄기 | 설치된 testext의 진행·대기 일감과 예약 | 진행 취소, 대기 extension_disabled, 예약 미발화, 데이터·파일 보존 | DB 오류 전달 |
| 다시 켜기·반복 | 비활성 확장과 보류 일감 | 보류 해제와 완료, 반복 호출 멱등, 다른 그룹 유지 | 미설치 거절 |
| crash | 활성 변경과 보류 확정 도중 프로세스 종료 | 두 사실이 함께 rollback 또는 commit, 재시작 후 disabled 일감 청구 없음 | 부분 성공 없음 |
| 공개 상태 | 미설치·로그인 미완료·활성·비활성·실패 | 같은 SDK 계약의 서로 다른 사실, 중단 일감·보류 예약 수와 고정 오류 코드 | 원문 진단·설정 비밀 없음 |
| 조회·쓰기 실패 | DB 연결 불가·트랜잭션 실패 | 거짓 성공·부분 활성 변경 없음 | 기존 DB 코드 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/status.ts`, `brain.ts`, `ports/store.ts`, `index.ts`: 현재 status는 registry/Python/journal을 따로 읽고 SDK는 install/status/list만 있다. 공통 상태 projection 타입·Store 조회 port와 enable/disable use case·SDK를 추가한다.
- `packages/postgres/src/extensions.ts`, `write.ts`: registry 작성자와 `withWrite` 트랜잭션을 재사용한다. 활성 변경과 hold 그룹 insert/delete를 같은 callback에서 실행한다. 읽기 projection도 일관된 DB snapshot으로 만들고 원문 message를 투영하지 않는다.
- `packages/postgres/src/work.ts`, `schedules.ts`, `packages/core/src/queue/hold-groups.ts`, `queue/supervisor.ts`: 기존 자동 확장 그룹·청구 차단·진행 취소·예약 보류 계약이다. `withWrite`가 외부 transaction을 받지 않으므로 새 registry port 내부에서 동일 SQL 경계를 묶는다. 큐/예약의 기존 검사와 새 쓰기의 경합도 검증한다.
- `packages/core/src/testing/fakes/store.ts`, `testing/contracts/extension-store.ts`, `packages/postgres/test/extensions.test.ts`: fake/PG 공통 계약으로 atomic port와 상태 projection을 검증한다.
- `apps/cli/src/commands/ext-status.ts`, `ext-list.ts`, `ext-install.ts`, `dispatch.ts`, `commands/` 등록부: 기존 중앙 codec과 단계 출력은 재사용하고 enable/disable CommandSpec·메타·SDK 1:1 등록을 추가한다.
- `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/store.ts`, doctor 조립 경로: 읽기 전용 doctor의 기존 check 경로를 유지하며 동일 공개 상태로 비활성·중단 일감·보류 예약을 보고한다. DB 불가 시 거짓 정상으로 보고하지 않는다.
- `apps/cli/src/daemon/supervisor.ts`: 매 polling 활성 registry를 읽어 protected launches를 구성한다. 기존 보류 취소가 disabled 실행도 회수하는지 확인한다.
- `apps/cli/test/ext-fixture.ts`, `ext-install-resume.test.ts`, `supervisor-fixture.ts`, `fixtures/extensions/`: 실제 CLI·격리 PG/home와 Node probe를 재사용한다. 전역 extension role 충돌을 피하는 기존 격리 규칙을 따른다.
- `packages/postgres/migrations/0015_extension_status_public.sql`, `extension-provision.ts`, `test/extension-permissions.test.ts`: 기존 v1 자기 행 권한·세 열을 변경하지 않는다. 공개 projection은 core 앱 권한만 사용한다.
- 선행 13.5 계획의 Code Map·Tasks·구현·리뷰 결과를 읽었다. journal의 고정 코드, 완료 단계·authWorkId·scheduleIds 보존과 조회 시 실제 예약 확인을 유지한다. 최상위 research-* 폴더는 없다. 옛 연구의 12.10 경계는 현재 `withWrite`·hold SQL로 재확인했다.

## Tasks & Acceptance

**실행:**
- [x] `packages/core/src/ports/store.ts`, `extensions/status.ts`, 새 활성 use case, `brain.ts`, `index.ts`에 공통 projection·atomic 활성 port와 SDK를 정의한다.
- [x] `packages/postgres/src/extensions.ts`, `packages/core/src/testing/fakes/store.ts`, `testing/contracts/extension-store.ts`에서 원자적 활성·보류 및 비밀 없는 일관된 조회를 구현·검증한다.
- [x] `apps/cli/src/commands/`, 등록부·doctor 경로·실패 store와 `README.md`에서 명령·메타·공통 상태와 중단 수 출력을 연결한다.
- [x] `apps/cli/test/ext-enable-disable.test.ts`, 관련 core/PG·doctor·권한 시험에서 matrix와 실제 CLI·데몬 중단/재개·데이터/파일 보존·crash를 검증한다.

- [x] `packages/core/src/ports/store.ts`, `packages/postgres/src/extensions.ts`, `packages/core/src/testing/fakes/store.ts`에 registry와 설치 journal 이름의 중복 없는 정렬된 합집합을 조회하는 내부 inventory port를 추가한다. 기존 설치 전용 `listExtensions` port 의미와 daemon 등록부는 유지한다. 공통 계약에서 registry만·journal만·둘 다 있는 이름과 조회 실패를 검증한다.
- [x] `packages/core/src/doctor/doctor.ts`는 위 inventory의 모든 이름을 같은 공개 projection으로 읽고 설치 여부·설치 결과·로그인 단계·연결 상태·실패 단계·마지막 고정 코드·보류 수를 구분한다. journal만 있는 실패, 활성이나 login_required, connection_failed, scheduler_unavailable 또는 failed/cancelled인 상태는 정상으로 판정하지 않는다. 미기록 legacy 사실은 실패로 꾸미지 않는다. 실패는 warn, DB 조회 불가는 fail로 구분한다.
- [x] `packages/core/test/doctor.test.ts`, `testing/contracts/extension-store.ts`, `apps/cli/test/ext-enable-disable.test.ts`에서 journal만 있는 설치 실패와 활성/로그인 미완료·연결 실패를 doctor 출력/판정으로 각각 확인한다. 실제 CLI가 만든 설치 전 실패를 SDK status·CLI status·doctor에서 같은 고정 결과로 확인하고 비밀 canary를 유지한다.

**인수 조건:**
- Given 격리 home/PG의 설치한 testext와 진행·대기 일감 및 due 예약, when 실제 `brain ext disable testext`를 실행하면, then 진행 자식이 취소되고 대기 일감이 extension_disabled로 보이며 예약이 발화하지 않고 schema 행 수·설치 파일 해시가 같으며 실제 doctor와 ext status가 비활성·중단 일감·보류 예약 수를 표시한다.
- Given 비활성 testext와 위 대기 일감, when 실제 `brain ext enable testext`를 실행하면, then 대기 일감이 완료되고 다른 그룹은 영향받지 않으며 반복 disable/enable과 미설치 입력이 명시한 결과를 낸다.
- Given 같은 트랜잭션에서 활성·보류를 바꾸는 실제 PG 경로, when commit 전/후 프로세스를 죽이고 다시 연결하면, then 부분 확정이 없고 disabled인 확장의 일감은 재시작 후 청구되지 않는다.
- Given 미설치·설치/로그인 미완료·활성·비활성·실패 fixture와 비밀 canary, when SDK 공개 상태 및 CLI와 doctor를 조회하면, then 동일 계약으로 각 사실과 수를 읽고 설정 비밀·원문 진단이 나타나지 않으며 기존 SQL v1 ACL 회귀가 통과한다.

## Implementation Notes

- 1단계의 SDK·atomic port·fake/PG 공개 projection diff를 확인했다. 독립 core/PG 검증은 3 파일 306개 통과했다(`/tmp/brain136-phase1-verify.log`). 실제 CLI·doctor 연결과 데몬/crash 인수는 후속 단계에서 확인한다. 구현 Dispatch는 같은 세션에서 유지한다.

- 2단계 CLI·doctor의 동일 공개 projection 소비와 출력 호환 diff를 확인했다. 독립 doctor/dispatch/실제 설치 검증은 3 파일 141개 통과했다(`/tmp/brain136-phase2-verify.log`). 진행 자식 종료는 비동기로 설명하며 완료 응답을 종료 증거로 사용하지 않는다.

- 3단계와 전체 diff를 직접 확인했다. 시험은 전역 role 충돌을 피하려고 testext를 복제한 고유 이름 extdisable을 사용한다. 실제 확장 자식·CLI·데몬·예약과 schema 행 수·manifest 해시 보존을 검증했다. 새 소스 migration이나 기존 SQL v1 ACL 변경은 없다.

- 재도출 1의 inventory/doctor와 실제 CLI 실패 시험을 확인했다. 지휘자 독립 검증은 빌드·타입·diff 검사 통과, verbose 인수 8파일 433개 통과(`/tmp/brain136-verify2-matrix.log`), 전체 143파일 3692개 통과·기존 선택 1개 건너뜀(`/tmp/brain136-verify2-full.log`)이다. 설치 전 journal과 활성 로그인·연결 실패가 doctor의 경고 및 고정 코드로 보임을 확인했다.

## Plan Change Log

### 2026-10-31 — 리뷰 후 재도출 1

리뷰 두 건을 주변 코드에서 확인했다. 기존 intent-contract의 공통 사실 조회와 실패 구분은 명확하지만 실행 항목과 시험이 doctor의 inventory 및 판정을 충분히 고정하지 않았다. 두 건을 medium/bad_plan으로 분류했다. 전체 소스 patch는 `/tmp/brain136-before-rederive.patch`, doctor 구현을 제외한 보존 patch는 `/tmp/brain136-keep.patch`에 저장했고, 구현자가 소스·시험·README 24개 파일을 baseline과 일치하게 되돌린 것을 확인한 뒤 실행 항목을 보강했다. index는 지휘자가 소유하며 재검증 때 현재 작업 파일을 다시 stage한다.

- KEEP: 원자적 registry/hold, 비밀 없는 단일 snapshot projection, CLI·SDK, 기존 SQL v1 ACL, 실제 daemon/crash/데이터 보존·고유 fixture·정상 회귀 구조를 보존한다. KEEP patch를 검토해 이 구조를 재사용하되 제외된 doctor 구현은 새 실행 항목으로 다시 구현한다.
- 새 inventory는 registry와 journal의 이름 합집합을 대상으로 한다. 기존 daemon의 설치 전용 목록 의미를 바꾸지 않으며, 공개 소비는 기존 projection을 재사용한다. journal만 있는 실패를 확장 0건이라고 보고하는 상태를 막는다.
- doctor는 활성 의도와 준비/실패를 분리해 출력하고 concrete 미완료·실패를 경고한다. 기존 활성/보류 수만 보던 진단을 복구하지 않는다. 정상 legacy 상태의 미기록 사실을 가짜 실패로 만들지 않는다.
- 재도출 단위: (1) KEEP 재사용·inventory와 doctor 재구현 및 해당 계약/진단 시험 → phase-ready, (2) 실제 CLI 미완료/실패 및 matrix·전체 검증 → implementation-ready. 같은 구현 Dispatch를 유지한다.

## Review Triage Log

### 2026-10-31 — Review pass 1

- verdicts: 2 findings — high 0, medium 2, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[bad_plan]` doctor가 journal만 남은 설치 전 실패를 누락한다 — PG listExtensions가 registry만 읽고 preflightFailure는 journal만 저장하는 경로를 확인했다. inventory 합집합 port와 실제 CLI 실패/doctor 시험을 실행 항목에 추가했다.
  - `[medium]` `[bad_plan]` 활성이나 로그인 미완료·연결 실패인 확장을 doctor가 ok로 표시한다 — extensionsCheck가 enabled와 보류 수만 판정하고 공개 failure/login/connection을 무시함을 확인했다. 단계·코드 출력 및 미완료/실패 경고와 doctor 시험을 실행 항목에 추가했다.

### 2026-10-31 — Review pass 2

- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` queue.release가 disabled 확장의 보류를 지워 일감·예약을 재개한다 — PG와 fake의 무조건 삭제 및 SDK 호출 경로를 확인했다. 기존 해제 port에서 registry 행을 활성 변경과 같은 순서로 잠그고 disabled이면 삭제하지 않도록 직접 보정했다. 공개 API 추가 없이 SDK/fake·PG의 비활성 보존과 enable 뒤 청구·예약 재개 시험을 추가했다.

## Verification

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 모두 성공해야 한다.
- `pnpm exec vitest run packages/core/test/contracts.test.ts packages/core/test/extensions.test.ts packages/core/test/work-hold.test.ts packages/core/test/doctor.test.ts packages/postgres/test/extensions.test.ts packages/postgres/test/extension-permissions.test.ts apps/cli/test/ext-enable-disable.test.ts`: 격리 PG 사용, 위 matrix·CLI/SDK/doctor·비밀·권한 인수와 회귀 모두 통과해야 한다. 추가 시험 파일은 구현 보고서에 실제 이름을 적는다.
- `pnpm test`: 기본 Node/PG 전체 회귀가 통과해야 한다. 선택 Python 구현은 변경하지 않으며 영향이 발견될 때만 `pnpm test:python`을 추가한다.
- 실제 CLI 시험은 기존 fixture의 격리 home/DB를 생성하고 finally에서 자식·DB·소유 role·임시 홈을 정리한다. 운영 계정·실제 Garmin·외부 인간 작업은 요구하지 않는다.

### 지휘자 독립 검증

- `pnpm build`, `pnpm typecheck`, `git diff --check`: 통과. 로그는 `/tmp/brain136-verify-build.log`, `/tmp/brain136-verify-typecheck.log`다.
- 계획 선택 7파일과 `packages/postgres/test/extension-atomic.test.ts`를 verbose로 실행해 8파일 421개 통과했다(`/tmp/brain136-verify-matrix.log`). 끄기·재개·보존은 실제 CLI 인수, crash와 쓰기 실패·경합은 atomic 시험, 공개 상태는 fake/PG 공통 계약과 SDK/CLI canary, DB 읽기 불가는 전체 suite의 unavailable 시험에 대응한다. 건너뛴 matrix 시험은 없다.
- `pnpm test`: 143파일 3680개 통과, 기존 선택 시험 1개 건너뜀(`/tmp/brain136-verify-full.log`).

## Auto Run Result

Status: built

확장 활성 의도와 보류 그룹을 같은 PostgreSQL 트랜잭션에서 바꾸는 enable/disable을 구현했다. 진행 자식 취소·대기 일감 보류·예약 발화 차단·enable 뒤 재개를 기존 감독자/큐로 연결하고 데이터와 설치 파일을 보존한다. 공개 SDK projection과 journal 포함 inventory로 설치·활성·로그인·연결·예약·실패·보류 수를 비밀 없이 조회하며 CLI와 doctor가 같은 사실을 읽는다. 일반 queue.release로 비활성을 우회할 수 없도록 registry 행 잠금을 적용했다.

quick 리뷰를 두 번 수행했다. 첫 pass의 medium 2건은 계획의 실행 항목과 시험을 보강한 재도출로 해결했다. 두 번째 pass의 medium 1건은 기존 port의 최소 patch와 SDK/fake·PG 회귀 시험으로 해결했다. 이번 pass patch 집계는 high 0, medium 1, low 0이며 deferred 0, reject 0이다. `followup_review_recommended: false`다. 최종 patch 뒤 별도 독립 재리뷰는 하지 않았으며 diff·잠금 순서와 아래 독립 검증으로 확인했다.

최종 독립 검증은 `pnpm build`, `pnpm typecheck`, `git diff --check` 통과, 계획 선택 7파일과 atomic 시험을 포함한 verbose 8파일 434개 통과, `pnpm test` 143파일 3693개 통과·기존 선택 시험 1개 건너뜀이다. 로그는 `/tmp/brain136-final-build.log`, `/tmp/brain136-final-typecheck.log`, `/tmp/brain136-final-matrix.log`, `/tmp/brain136-final-full-retry.log`다. 직전 전체 실행은 명령 본문 전 PG 시험 DB 준비의 연결 timeout 1건이 있었고, 코드 변경 없이 같은 dispatch 파일 87개와 전체 재실행이 통과했다(`/tmp/brain136-final-full.log`, `/tmp/brain136-final-dispatch-recheck.log`). 모든 matrix 행의 시험이 실행·성공했으며 설치 전 실패·활성 로그인 미완료·연결 실패도 실제 SDK/CLI/doctor 표면에서 확인했다.

실제 Garmin·실계정은 호출하지 않았다. crash 시험은 PostgreSQL 서버 자체가 아니라 트랜잭션을 수행하는 실제 프로세스를 종료한다. Python 환경 구현은 변경하지 않았으며 선택 Python suite는 실행하지 않았다. 사람만 저장소 밖에서 수행할 인수 작업은 없으므로 awaiting-operator와 operator_actions는 적용하지 않는다. 티켓과 tickets.toml을 변경하거나 tickets.py mark를 실행하지 않았고 done을 표시하지 않는다. 오케스트레이터가 자체 검증 후 완료를 결정한다. 원격 push는 하지 않는다.

### 변경 파일

- `README.md` — 켜기·끄기와 비동기 취소 및 데이터 보존 사용법을 설명했다.
- `_bmad-output/personal-brain/tickets/epic-extensions/tickets/story-ext-disable-ext-enable-plan.md` — 계획·구현·검증·리뷰 triage와 최종 결과를 기록했다.
- `apps/cli/src/commands/ext-activation.ts` — enable/disable CommandSpec을 SDK와 연결했다.
- `apps/cli/src/commands/ext-install.ts` — 성공·실패 설치 응답에 공통 공개 상태를 연결했다.
- `apps/cli/src/commands/ext-list.ts` — 공개 projection 목록을 중앙 출력으로 전달했다.
- `apps/cli/src/commands/ext-status.ts` — 공개 상태와 단계·보류 수의 JSON/텍스트 출력을 조립했다.
- `apps/cli/src/commands/index.ts` — enable/disable 명령을 등록했다.
- `apps/cli/src/doctor/store.ts` — 새 조회·활성 port의 실패 응답을 연결했다.
- `apps/cli/test/dispatch.test.ts` — 새 Store port의 실패 fixture를 보정했다.
- `apps/cli/test/doctor-run.test.ts` — 확장 점검이 포함된 진단 출력과 개수를 검증했다.
- `apps/cli/test/ext-enable-disable.test.ts` — 실제 CLI·데몬 중단/재개·보존·진단·비밀 비노출을 검증했다.
- `apps/cli/test/ext-fixture.ts` — 고유 시험 확장 role을 정리한다.
- `packages/core/src/brain.ts` — 공개 상태·enable/disable SDK와 doctor를 연결했다.
- `packages/core/src/doctor/doctor.ts` — journal 포함 inventory와 공개 상태로 미완료·실패·보류를 진단한다.
- `packages/core/src/extensions/public-projection.ts` — 비밀과 원문 진단을 제외한 명시 조회 계약을 만들었다.
- `packages/core/src/extensions/status.ts` — 공개 상태·안전한 목록과 활성 use case를 제공한다.
- `packages/core/src/index.ts` — 공개 projection과 상태 타입·함수를 export한다.
- `packages/core/src/ports/store.ts` — 원자적 활성·공개 조회·inventory port를 정의했다.
- `packages/core/src/testing/contracts/extension-store.ts` — fake/PG의 상태·inventory·멱등성·비밀 보호 공통 계약을 검증한다.
- `packages/core/src/testing/fakes/store.ts` — 원자적 활성·공개 상태·inventory와 비활성 보류 보호를 구현했다.
- `packages/core/test/doctor.test.ts` — 설치 전 실패·로그인·연결·DB 실패와 legacy 진단을 검증한다.
- `packages/core/test/work-hold.test.ts` — SDK의 활성·수동 해제 우회 차단과 일감·예약 재개를 검증한다.
- `packages/postgres/src/extensions.ts` — 단일 snapshot 조회·합집합 inventory·활성/hold 트랜잭션을 구현했다.
- `packages/postgres/src/work.ts` — 비활성 확장의 수동 보류 해제를 registry 행 잠금으로 차단했다.
- `packages/postgres/test/extension-atomic.test.ts` — 실제 프로세스 crash·rollback·경합·수동 해제 우회 차단을 검증한다.
- `packages/postgres/test/unavailable.test.ts` — 새 port의 DB 불가 응답을 검증한다.

### Orca 정리와 인계

Run `run_556487597aa8`의 구현 Dispatch `ctx_3655d5678227`와 리뷰 Dispatch `ctx_1df57f336361`, `ctx_3fd8e7be319c`가 모두 succeeded로 정식 완료했다. 전체 보고를 수락한 뒤 세 워커를 release했고 restore 및 현재 Run의 fleet을 대조했다. 활성·reclaimable 워커와 미처리 mail은 0건이며 미확인 워커나 남은 과업은 없다. 보존 patch와 보고서는 삭제하지 않았다. 체크포인트는 `/tmp/brain136-orca-coordination.json`에 보존하며 커밋 확인 뒤 마지막 체크포인트를 기록하고 전용 제어 셸을 닫는다.

검토한 소스·시험·계획을 한 커밋으로 기록한다. plan의 최종 status는 built이며 티켓 done 판정은 오케스트레이터에 남긴다.
