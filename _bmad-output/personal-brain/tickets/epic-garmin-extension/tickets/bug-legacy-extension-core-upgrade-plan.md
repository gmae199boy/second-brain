---
title: '등록 확장이 있는 옛 core 설치본의 안전한 오프라인 갱신 경로'
type: 'bugfix'
ticket: 9
created: '2026-11-06'
status: 'built'
baseline_revision: 'ae67108593b0b9407b116c3777c129bfc0f29575'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md, _bmad-output/personal-brain/automation/runbook.md, _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-extension-core-upgrade.md]
warnings: [oversized]
deferred:
  - summary: >-
      legacy 회계 보존 시험이 0033의 DST 중복/결손 변환 규칙을 독립 oracle로 검증하지 않는다.
    evidence: |-
      r3 blind R3-9. install-legacy 시험은 UTC fixture와 직접 AT TIME ZONE을 쓴다. 0033 변환 함수 자체의 DST 계약 검증은 이번 변경이 만든 문제가 아니라 기존 migration 시험 범위다.
    location: >-
      packages/postgres/test/install-legacy.test.ts
    severity: medium
  - summary: >-
      대화형 offline 확인 중 Ctrl-C(SIGINT) 종료 경로의 잠금 정리·무변경을 시험하지 않는다.
    evidence: |-
      r3 blind R3-10. 기존 cross-commit 확인과 같은 기존 동작이며 확인은 DB/app 변경 전 단계다. 잔존 설치 잠금은 AD-19 A1에 따라 명시 복구 대상이다.
    location: >-
      apps/cli/src/install.ts:171
    severity: low
---

<intent-contract>

## Intent

**Problem:** core schema<35(확장 정지 표 `brain.extension_quiesce` 없음)에 확장이 등록된 옛 설치본은 `installPostgres`가 `existing.names.length && !existing.fenceReady`(`apps/cli/src/install/postgres.ts:130`)와 `installed.schema_version < 35` 신원 검사에서 무조건 `DB_LOCKED`로 거부한다. 안전 전제를 갖춰도 운영자 offline 확인에 도달하지 못해 같은 DB·기억을 유지한 갱신이 불가능하다.

**Approach:** 거부 조건을 "옛 설치 신원(`installed.json` schema<35, 40자 commit, 대상 build와 다른 commit)이 확인된 legacy 전환"과 "그 외 불명"으로 나눈다. legacy 전환은 기계 확인 전제(모든 등록 확장 비활성·`extension:<name>` 보류·확장 예약/미완료 일감 보류·확장 claim/열린 attempt 0·전환 파일/타 owner gate/불일치 journal 없음)와 기존 cross-commit 운영자 offline 확인(home·이전/목표 commit·nonce)을 모두 통과해야 하고, 확인 뒤 같은 전제를 재확인한 다음 core 31→self→35까지 migration하고 그 시점에 journal owner로 새 정지 계약(`quiesceExtension` refuseRunning)에 진입한 뒤 기존 일반 경로(나머지 core·확장 migration·자기 gate 해제)로 이어진다. 중단 후 재시도는 DB가 어느 단계에 있든 `installed.json`이 legacy인 한 같은 legacy 규칙(전제 재확인·새 운영자 확인)을 다시 적용한다.

## Boundaries & Constraints

**Always:** 모든 기계 전제 검사와 운영자 확인은 첫 DB 변경·app 승격·journal 기록 전에 끝낸다. 운영자 확인은 대화형 TTY 경로에서만 받고 시도마다 새 nonce로 묻는다(hook·`--json`·`--yes`·비TTY·이전 시도 확인 재사용 불가). 확인 문구에 기계가 확인한 사실과 운영자가 확인할 사실(이전 데몬·직접 확장 명령·공유 상태 쓰기 자식 종료)을 구별해 보여 준다. PID 부재·daemon fence 획득·work0만으로 미추적 자식 부재를 주장하지 않는다. 설치 잠금·daemon offline fence·확장별 advisory 잠금을 지금처럼 확인 전부터 끝까지 유지한다. 기존 migration 순서(core 31 → `ensureSelfUser` → 나머지 core → 확장 owner)와 backfill을 지킨다. 확장 `enabled`·hold group·사용자 예약 변경·삭제 표식·회계·기억(대화·파일·채널·설정)을 보존하고 자동으로 활성화·재개·수집하지 않는다. 타 owner gate·사용자 보류·A1 잔존 설치 잠금은 보존한다. 신규 설치와 schema≥35 일반 갱신 동작은 바꾸지 않는다.

**Never:** guard 단순 삭제·완화로 해결, registry SQL 삭제·빈 DB 교체, 적용된 migration 파일 수정, 새 OS 감독/강제 종료 정책, core에 특정 확장 이름·표·지표 추가, 새 uninstall 기능, 운영 DB/home/app/설정/예약 접촉, 21.7 전환 작업, main 병합·push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| L1 legacy 정상 | core27 DB, 등록 확장 비활성+보류, 예약·미완료 일감 보류, claim/attempt 0, installed.json schema27 commit A, 대상 B, TTY 확인 정답 | core 38·확장 migration 완료, offline_confirmation 보고, gate 0, journal 제거, enabled/hold/기억/회계 보존 | 없음 |
| L2 전제 미충족 | 확장 enabled, hold 없음, 예약/미완료 일감 미보류, claim 또는 열린 attempt, 전환 파일, daemon 잠금 점유, 불일치 journal | 구체적 원인과 복구 안내의 `DB_LOCKED`, 확인 요청 전 거부 | schema_migrations·registry·app·journal 무변경 |
| L3 신원 불명 | installed.json 없음/손상/commit null/대상과 같은 commit, 또는 installed≥35인데 DB fence 없음, 대상 build 신원 불일치, manifest 비호환 | 기존 신원/호환 `DB_LOCKED` | 무변경 |
| L4 확인 거부 | 확인 없음(비TTY·`--json`·hook), 오답, 다른 home/commit, 이전 nonce, 확인 중 전제·신원·manifest·잠금 변경 | `DB_LOCKED` | 무변경 |
| L5 중단 재시도 | 31·35 직후, gate 생성 직후, core 완료 후 확장 migration 실패, app 승격 후 실패 | 같은 journal owner로 재개, 매번 새 확인, 확정 migration 되돌림 주장 없음 | 타 owner gate·사용자 보류 보존, 불명은 거부 |
| L6 경합 | 확인 대기 중 daemon/확장 명령/다른 설치 진입 시도 | 진입 실패(잠금 유지) | 설치 성공 여부와 무관하게 보존 |
| N1 회귀 | 신규 설치, 확장 없는 옛 DB, schema≥35 cross-commit/same-commit 갱신 | 기존 결과 그대로 | 기존 시험 유지 |

</intent-contract>

## Code Map

- `apps/cli/src/install/postgres.ts` -- `installPostgresLocked`: L130 fence 거부, L141 신원 검사(`installed.schema_version < 35`), `migrate()` 확인·재확인·journal·`quiesceExtension`·`promoteStagedApp`·`runMigrations(coreMaxVersion:31)`·`ensureSelfUser`·나머지·확장 owner·`endExtensionQuiesce`. legacy 분기는 여기서 기존 확인/재확인 블록을 재사용해 확장한다. `migrate()` 안 `store.readExtensionQuiesce`는 schema<35에서 표가 없어 실패하므로 legacy 단계에서는 35 이후에만 호출한다.
- `packages/postgres/src/migrate.ts` -- `inspectExtensionFence`(읽기 전용, migration 전 호출) 옆에 legacy 전제 읽기 함수를 추가한다(확장 `enabled`, `brain.work_hold_groups`의 `extension:<name>`, kind 접두 `<name>.` 예약/미완료 일감의 `hold_group` 보류 여부, claim/`current_attempt_token`, `work_attempts.finished_at is null`). 0001/0002/0009/0010/0011 표만 사용해 schema27에서 동작해야 한다. `packages/postgres/src/index.ts`, `packages/second_brain/src/postgres.ts`로 export.
- `packages/postgres/src/extensions.ts` -- `readExtensionQuiesce` running 정의(재사용 기준), `setExtensionEnabled`의 hold group 의미(비활성 = `extension:<name>` 보류).
- `apps/cli/src/install.ts:170-178` -- TTY에서만 `confirmOffline` 제공. legacy 전환이면 요청에 기계 확인 사실/legacy schema를 넣고 문구를 확장한다(challenge 형식 `확인 <home> <prev> <target> <uuid>` 유지). `apps/cli/src/commands/setup-run.ts:86` `allowOfflinePrompt: !json`.
- `apps/cli/src/install/installed.ts` -- `readInstalled`: core27 시기 `installed.json`(schema_versions 없음 가능)을 읽는지 git 이력으로 확인하고 합성 fixture에 그 형식을 쓴다.
- `apps/cli/src/daemon/lock.ts:155` `acquireOfflineDaemonFence`, `apps/cli/src/runtime/install-lock.ts`, `packages/postgres/src/extension-install-lock.ts` -- 진입 차단 재사용, 변경 금지.
- `packages/postgres/test/install-orbstack.test.ts` -- `extensionWorld()`·기존 cross-commit/offline/journal/gate/legacy 사례. 기존 `legacy` 사례(표 drop으로 흉내)는 확인 없이 거부를 계속 단언하되 메시지를 새 진단에 맞춘다. 새 legacy 시험은 별도 파일 `packages/postgres/test/install-legacy.test.ts`에서 `runMigrations({coreMaxVersion:27})`로 진짜 core27 DB를 만들고 registry/hold/예약/회계 행을 SQL로 넣는다(새 컬럼 쓰는 `recordExtensionInstall` 사용 금지).
- `tooling/bootstrap/src/bootstrap.ts:335-345,1299` -- 대화형 npx/bootstrap은 stdin을 상속해 설치기에 TTY를 넘기고 hook 모드는 `ignore`. 변경 불필요 예상, 확인만.
- `plugin/app-ref`, `plugin/.claude-plugin/plugin.json`, `plugins/garmin/{app-ref,.claude-plugin/plugin.json,package/digest,package/manifest.json}` -- release 패턴은 `dbcd369` 참고.
- `tooling/test-changed/rules.mjs` -- `packages/postgres/`·`apps/cli/src/install/` 접두 규칙 이미 존재. 새 경로가 그 밖이면 규칙 추가.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/src/migrate.ts`, `packages/postgres/src/index.ts`, `packages/second_brain/src/postgres.ts` -- schema27 호환 읽기 전용 legacy 전제 함수 추가·export -- migration 전 기계 사실 확보
- [x] `apps/cli/src/install/postgres.ts` -- legacy 전환 분기: 신원 판정, 전제 미충족 구체 진단, 확인 요청에 사실 전달, 확인 후 전제·신원 재확인, journal(names/commit/owner, offline 감사 사실), promote → 31 → self → 35 → `quiesceExtension`(journal owner, refuseRunning) → 나머지 core → 확장 → 해제 → journal 제거; 재시도는 installed legacy면 DB 단계와 무관하게 같은 규칙 -- 지원 전환과 변경 전 거부
- [x] `apps/cli/src/install.ts` -- legacy 확인 문구(기계 사실/운영자 확인 구별), 비TTY 미제공 유지 -- AC3
- [x] `packages/postgres/test/install-legacy.test.ts` -- L1~L6 실제 PG 시험(합성 core27 확장·대화·파일·채널·설정·예약 변경·schedule_successes 회계, 전후 해시 대조), 중단 주입(31/35/gate 직후, 확장 migration 실패, app 승격 후) 재시도, 경합(확인 대기 중 daemon/advisory/설치 잠금 실패), 비대화 표면(`setup run --json` dispatch 또는 `runInstaller` non-TTY) 거부 -- AC1~6
- [x] `packages/postgres/test/install-orbstack.test.ts` -- 기존 legacy 사례 메시지 정합, 기존 N1 회귀 유지 -- AC5
- [ ] release: 구현 commit 뒤 별도 release commit에서 `plugin/app-ref`를 그 이전 구현 commit으로, core plugin version 증가, Garmin plugin app-ref/version/package digest·manifest를 `dbcd369` 패턴과 시험이 요구하는 대로 동기화 -- 21.7 설치 경로

**Acceptance Criteria:**
- Given 소유 전용 PG·격리 home의 합성 core27 설치본이 L1 전제를 갖췄을 때, when 지원 대화형 설치 경로로 갱신하고 운영자가 새 challenge를 입력하면, then 같은 DB가 core 38·확장 최신으로 이행되고 기억·설치 이력·enabled/hold·예약 변경·회계가 forward migration 허용 정리 외 보존되며 확장 활성·예약 재개·수집은 일어나지 않는다.
- Given L2~L4의 어느 조건, when 같은 갱신을 요청하면, then 첫 DB migration·app 승격·journal 기록 전에 원인별 진단과 복구 안내로 `DB_LOCKED` 거부되고 상태가 보존된다.
- Given L5 중단 지점마다, when 재시도하면, then 새 확인을 다시 요구하고 같은 owner로 완료하거나 불명 상태를 보존해 거부하며, 새·옛 writer 동시 허용이나 타 owner gate·사용자 보류 해제가 없다.
- Given 변경 후 전체 트리, when `pnpm test` 다음 `pnpm test:python`을 순차 실행하면, then 모두 성공하고 skip 추가·단언 축소가 없다.

## Implementation Notes

- 가정(지휘자 결정): "진행 중 work/attempt 0"은 등록 확장 소유(kind 접두 `<name>.`) 일감의 claim/`current_attempt_token`과 그 일감의 미종료 `work_attempts`로 한정한다(기존 `readExtensionQuiesce` running 정의와 일치). core 일감은 daemon fence와 운영자 확인이 덮는다.
- 가정: 비활성 확장의 보류는 `setExtensionEnabled(false)`가 만드는 `extension:<name>` hold group으로 판정한다.
- 시험 환경: 소유 전용 PG18 컨테이너(`second-brain.ticket=21.9` 라벨, 고유 포트, tmpfs)와 `BRAIN_TEST_DATABASE_URL`. 기존 컨테이너(운영 54320, 공용 54329, 다른 티켓)는 건드리지 않는다. 실행마다 `.brain-automation/logs/<UTC>-<rand>/`를 배타 생성한다.

- 구현(Task 1~9, Terra 구현자 2명: `ctx_dd632e7c7770` 계열 Task 1~6, 교체 `ctx_a518373cfd8c` 계열 Task 7~9): legacy 판정은 `installed.json` schema 11 이상 35 미만, 40자 commit, 대상 build와 다른 commit일 때만 성립한다. 판정 기준이 DB 상태가 아니므로 중단 재시도에서도 같은 legacy 규칙을 적용한다.
- 확인 전후 검사: 기계 전제(`inspectLegacyExtensionPrerequisites`), core·확장 migration 이력(`runMigrations({validateOnly})`, core 최대 버전이 설치 기록 schema보다 낮으면 거부), 확장 패키지 파일 유형·호환(`installedExtensionMigrations` 재실행).
- 경로 순서: promote → core 31 → self → core 35 → `quiesceExtension`(journal owner) → 나머지 core → 확장 → 자기 gate 해제 → journal 제거.
- readline EOF(`ABORT_ERR`)를 빈 답으로 처리해 `DB_UNAVAILABLE` 대신 확인 거부 `DB_LOCKED`로 끝난다(실제 PTY 시험에서 발견).
- 결정: 잔존 home 설치 잠금이 있으면 재시도는 즉시 거부하지 않고, 복구 안내를 낸 뒤 대기한다. 이는 기존 AD-19 A1 계약이며 시험은 대기 중 미진입과 owner 불변을 단언한다.
- 결정: Garmin 플러그인 패키지 바이트와 계약은 바뀌지 않았으므로 release는 core 플러그인만 올린다.
- `readInstalled`는 schema27 시기 `installed.json`(`schema_versions` 없음)을 그대로 읽는다(`2e69c3b` 대조).

## Plan Change Log

## Review Triage Log

### 2026-11-06 — Review pass (r1)
- verdicts: 13 findings — high 0, medium 10, low 1, false 2 (IA2·IA3: 결함이 아니라 의도 해석 선택), maybe-false 0
- findings:
  - `[medium]` `[patch]` B1 legacy 판정이 schema_version 음수·0도 허용(`apps/cli/src/install/postgres.ts:138`) — 11≤schema<35만 legacy, L3 사례 추가(Task 3)
  - `[medium]` `[patch]` B2 정상 이행이 내부 `installPostgres`+콜백으로만 검증, 실제 대화형 진입점·readline 문구·installed.json 갱신 미검증 — pty로 빌드된 CLI `setup run` E2E와 `--json`/hook 거부 시험 추가(Task 4)
  - `[medium]` `[patch]` B3 fixture에 기존 확장 migration 이력 없음 — v1 선적용·v2 pending·checksum 불일치 거부 시험(Task 3)
  - `[medium]` `[patch]` B4 보존 대조 범위 부족(users/sessions/channels/예약 전 행/회계) — 허용 변경 열만 제외하고 전 행 대조(Task 3)
  - `[low]` `[patch]` B5 확인 후 legacy 재검사가 enabled만 시험 — hold 삭제·보류 해제·claim·attempt 변형 추가(Task 3)
  - `[medium]` `[patch]` B6 복수 확장 순차 잠금·부분 gate 중단 미검증 — 두 확장 fixture 시험(Task 4)
  - `[medium]` `[patch]` B7 실제 프로세스 강제 종료 미검증 — 자식 설치기 SIGKILL 경계 시험, 잔존 잠금 자동 회수 금지·명시 복구·확인 재사용 거부(Task 4)
  - `[medium]` `[patch]` V1 사용자 hold 행만 삭제된 예약·일감 거부 미검증 — L2 변형 추가(Task 3)
  - `[medium]` `[patch]` IA1 외부 설치 표면과 시험 표면 차이 — B2와 동일 원인, 같은 처리
  - `[medium]` `[patch]` IA4 보존 관측 범위 차이 — B4와 동일 원인
  - `[medium]` `[patch]` IA5 실제 강제 중단 표면 부재 — B7과 동일 원인
  - `[false]` `[reject]` IA2 work/attempt 0 범위를 등록 확장 소유로 한정 — 원문 AC1·AD-38 정지 계약(`readExtensionQuiesce` running 정의)이 확장 정지 대상이며 core 일감은 daemon fence·운영자 확인이 덮음. Implementation Notes 가정으로 기록
  - `[false]` `[reject]` IA3 `extension:<name>` 보류 그룹 존재 요구가 원문보다 좁음 — 원문 "모든 등록 확장은 비활성"의 제품 표현이 `setExtensionEnabled(false)`의 그룹 생성이므로 동치 조건. 더 엄격한 쪽은 변경 전 거부라 안전
  - edge-case-hunter: 발견 0

### 2026-11-06 — Review pass (r2 후속)
- verdicts: 10 findings — high 0, medium 6, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` R2-1 SIGKILL 시험 finally가 waiter·후속 자식을 정리하지 않음 — 모든 자식 추적·종료 보장(Task 5)
  - `[low]` `[patch]` R2-2 TTY 시험 admin 연결·DB rename이 try 밖 — try/finally로 연결 종료·이름 복구 보장(Task 5)
  - `[medium]` `[patch]` R2-3 TTY 시험이 고정 DB 이름 `brain`을 공유해 동시 실행과 경합 — 서버 단위 advisory lock으로 직렬화, 기존 DB 삭제 금지(Task 5)
  - `[medium]` `[patch]` R2-4 legacy 범위 11~34 중 정상 시작은 27만 검증 — 11·27·34 시작 fixture로 L1 매개화(Task 6)
  - `[medium]` `[patch]` R2-5 비어 있지 않은 local/claimed 날짜·시간대 변환 미검증 — 값 있는 work 추가·변환 결과 단언(Task 6)
  - `[medium]` `[patch]` R2-6 종료된 work_attempts 이력 보존 미검증 — fixture·전후 대조 추가(Task 6)
  - `[medium]` `[patch]` R2-7 SIGKILL 경계의 보존 snapshot·확장 migration 1회 적용 미검증 — 전후 normalized 대조(Task 5)
  - `[medium]` `[patch]` R2-8 실제 TTY 오답·EOF 거부 미검증 — pty 사례 추가(Task 6)
  - `[low]` `[patch]` R2-9 확인 후 재검사의 installed/build 신원·home lock owner·확장 목록·gate·journal 변경 주입 없음 — L4 변형 추가(Task 6)
  - `[low]` `[patch]` IA-r2 지원 후보 범위(11~34)와 검증 출발점 차이 — R2-4와 동일 원인
  - edge-case-hunter·verification-gap: 발견 0

### 2026-11-06 — Review pass (r3 후속)
- verdicts: 10 findings — high 0, medium 5, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R3-1 legacy 사전 검증 `validateOnly`가 확장 owner만 확인해 core checksum/번호 불일치가 app 승격·prepare 뒤에야 실패 — core 이력도 확인 전·후 검증하고 거부 시험 추가(Task 7)
  - `[medium]` `[patch]` R3-2 확인 후 확장 패키지 파일 유형(symlink/일반 파일) 재검사 없음 — 확인 후 `installedExtensionMigrations` 재실행, symlink 교체 주입 시험(Task 7)
  - `[low]` `[patch]` R3-3 afterEach 정리가 DB 삭제 실패 시 home 정리를 건너뜀 — 각각 끝까지 시도(Task 8)
  - `[low]` `[patch]` R3-4 TTY 시험의 설치기 관리자 비밀번호 고정 — 시험 URL에서 일관 전달(Task 8)
  - `[low]` `[patch]` R3-5 TTY pipe/PTY 자식 미추적·내부 제한 합계가 바깥 제한 초과 — 추적·종료 보장·제한 조정(Task 8)
  - `[low]` `[patch]` R3-6 출력 수집을 `exit`에서 완료 — `close`·spawn 오류 처리(Task 8)
  - `[medium]` `[patch]` R3-7 schema34 시작에서 이미 존재하는 attempt/kind 열을 보존 비교에서 제외 — 값 넣고 대조(Task 8)
  - `[medium]` `[patch]` R3-8 비활성·삭제 표식 예약 보존 미검증 — schema34 fixture에 추가·정상/재개 대조(Task 8)
  - `[medium]` `[defer]` R3-9 회계 oracle이 UTC·직접 AT TIME ZONE만 사용해 0033의 DST 규칙을 독립 검증하지 않음 — 0033 고유 계약(기존 migration, 이번 변경 무관)이며 legacy 경로는 같은 migration을 호출할 뿐
  - `[low]` `[defer]` R3-10 TTY 확인 중 Ctrl-C/SIGINT 경로 미검증 — 기존 cross-commit 확인과 동일한 기존 동작, 변경 전 단계라 DB 무변경이며 잔존 잠금은 A1 명시 복구 대상
  - edge-case-hunter: 발견 0

### 2026-11-06 — Review pass (r4 후속)
- verdicts: 11 findings — high 0, medium 5, low 6, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` R4-1 core 이력 말단 누락/빈 이력이 사전 검증 통과 → app 승격 뒤 실패 — `to < installed.schema_version` 변경 전 거부·시험(Task 9)
  - `[low]` `[patch]` R4-2 SIGKILL `start()`가 exit 기준·error 미처리 — close/error(Task 9)
  - `[low]` `[reject]` R4-3 시험 `.env` 비밀번호 JSON.stringify 직렬화 — 전용 컨테이너 비밀번호는 고정 합성값 `postgres`라 따옴표·역슬래시가 없어 발생하지 않으며 수정은 제품 codec 재현이라 복잡도만 증가
  - `[medium]` `[patch]` R4-4 schema34 기존 예약 열 비교 제외 — 포함·fixture 보강(Task 9)
  - `[low]` `[patch]` R4-5 schema34 기존 self 행 비교 제외 — 포함(Task 9)
  - `[medium]` `[patch]` R4-6 schema34 package_digest/plugin_version 비교 제외 — 값 넣고 대조(Task 9)
  - `[medium]` `[patch]` R4-7 `project()` id 정렬로 비결정적 비교 — 표별 키 정렬(Task 9)
  - `[low]` `[patch]` R4-8 `validateOnly` 직접 계약 시험 없음 — migrate.test.ts 추가(Task 9)
  - `[low]` `[patch]` R4-9 TTY 오답·EOF 뒤 config/.env/compose 보존 단언 없음 — 추가(Task 9)
  - `[low]` `[patch]` R4-10 완료 work의 열린 attempt 거부 사례 없음 — 추가(Task 9)
  - `[medium]` `[patch]` E4-1(edge) SIGKILL 자식 대기 exit 기준 출력 경합 — R4-2와 동일 원인(Task 9)
- 후속 리뷰 판단: 이번 후속 패스에서 high patch 0 → step-04 규칙상 수렴. 추가 독립 리뷰 대신 최종 바이트 전체 회귀로 확인.

## Design Notes

legacy 판정 기준을 DB 상태가 아니라 `installed.json`의 옛 core 신원으로 두는 이유: DB는 중단 재시도에서 27·31·35·38 어디에나 있을 수 있지만, 옛 core가 실행 주체였다는 사실과 그 실행기가 새 fence를 모른다는 위험은 설치 기록이 새 core로 바뀔 때까지 그대로다. 따라서 legacy 설치 기록이 남아 있는 한 매 시도 전제 재확인과 새 운영자 확인을 요구하고, 정지 표가 생긴 뒤에는 새 계약의 gate로 이어 간다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 성공
- `BRAIN_TEST_DATABASE_URL=<소유 컨테이너> pnpm test:changed` -- expected: 반복 중 관련 시험 통과
- `BRAIN_TEST_DATABASE_URL=<소유 컨테이너> pnpm test` 후 `pnpm test:python` 순차 -- expected: 둘 다 exit 0, 고유 로그 보존

## Auto Run Result

- 요약: core schema 11~34에 확장이 등록된 옛 설치본을 위한 지원 전환 경로를 추가했다. 기계 전제와 운영자 offline 확인을 모두 통과해야 진입하며, 확인 전후로 전제를 재검사한다. 이어 schema 35 bridge를 거쳐 새 정지 계약에 진입한다. 전제가 충족되지 않거나 불명이면 변경 전에 `DB_LOCKED`로 거부한다.
- 변경 파일:
  - `apps/cli/src/install/postgres.ts`: legacy 판정·전제/이력/패키지 재검사·bridge·quiesce
  - `apps/cli/src/install.ts`: legacy 확인 문구(기계 사실과 운영자 확인 구별)·EOF 처리
  - `packages/postgres/src/migrate.ts`: `inspectLegacyExtensionPrerequisites`·`validateOnly`
  - `packages/postgres/src/index.ts`: export
  - `packages/postgres/test/install-legacy.test.ts`: 신규. L1~L6·N1, schema 11/27/34, 두 확장, SIGKILL 3경계, 실제 PTY `setup run`
  - `packages/postgres/test/migrate.test.ts`: `validateOnly` 계약
  - `packages/postgres/test/install-orbstack.test.ts`·`apps/cli/test/postgres-setup.test.ts`: 진단 문구·mock export 정합
- 리뷰 집계: r1(4렌즈) patch 11·false 2, r2(4렌즈) patch 10, r3(2렌즈) patch 8·defer 2, r4(2렌즈) patch 10·reject 1. high는 없었다. 거부·보류 사유는 Review Triage Log에, 보류 2건은 frontmatter `deferred`에 있다.
- 후속 리뷰 권고: false. r4 후속 패스에서 high patch가 0건이라 step-04 규칙상 수렴으로 판정했다. r4 수정은 최종 전체 회귀로 확인했다.
- 검증:
  - 최종 바이트 전체 회귀 `.brain-automation/logs/20261106T021737Z-final2-f332b68d/`: `pnpm test` 종료 0(187 files, 4277 passed, 1 skipped — skip은 기존 1건), 이어 `pnpm test:python` 종료 0(15 files, 66 passed). 전용 PG `brain-219-test`(127.0.0.1:54219)를 사용했다.
  - 시험 대상 바이트: 같은 디렉터리의 `tree.diff`·`untracked.sha256`. 회귀가 다시 쓴 추적 부산물 `extensions/garmin/tests/__pycache__/fixtures.cpython-314.pyc`는 HEAD로 복원했다.
  - 앞선 interim 실행 `20261106T015604Z-final-7f6aa1d1`(r3 이전 바이트)은 `pnpm test`만 종료 0이고 `pnpm test:python`은 사용자 수동 중단이다. 이 실행은 증거로 보존만 한다.
- 잔여 위험·운영 인계:
  - 실제 운영 전환(21.7)에서는 운영자가 직접 확인해야 하는 사실이 있다. 이전 데몬·직접 명령·쓰기 자식이 모두 종료됐는지와, 확장이 비활성·보류 상태인지다(옛 CLI의 `ext disable`).
  - 0033 DST oracle과 Ctrl-C 경로는 `deferred`에 남겼다.
  - 합성 testext 기반 시험이며, 실제 옛 Garmin 패키지의 manifest 호환은 21.7 운영 진단에서 확인해야 한다.
- Release: 구현 commit `118df4718cb44ec99a12f6e24048f5131b2df923` 다음의 별도 release commit에서 `plugin/app-ref`를 `118df4718cb44ec99a12f6e24048f5131b2df923`로 올리고 `plugin/.claude-plugin/plugin.json` version을 0.1.17에서 0.1.18로 올렸다. Garmin 플러그인은 바꾸지 않았다.
