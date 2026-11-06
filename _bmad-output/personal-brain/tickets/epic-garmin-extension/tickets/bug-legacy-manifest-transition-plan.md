---
title: '옛 확장 manifest가 등록된 설치본의 지원 core 갱신과 검증된 패키지 교체'
type: 'bugfix'
ticket: 10
created: '2026-11-06'
status: 'in-review'
baseline_revision: '133437602777e4771417a6b8a349fe930a786b3e'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: [AGENTS.md, _bmad-output/personal-brain/automation/runbook.md, _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-manifest-transition.md, _bmad-output/personal-brain/tickets/epic-garmin-extension/tickets/bug-legacy-extension-core-upgrade-plan.md]
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 21.9 legacy 전환(`installPostgres`)과 그 뒤 모든 core 설치가 등록 확장의 설치 manifest를 현재 decoder로만 읽고(`installedExtensionMigrations`, `apps/cli/src/runtime/extensions.ts:68`) 대상 core가 있으면 `core_compat`를 요구한다. 공개 옛 Garmin 1.0.0 manifest(`09947d2`)는 20.6(`e836ead`)이 core grammar에서 은퇴시킨 `work[].verification_snapshot`을 갖고 `core_compat`가 없어 `DB_LOCKED: 확장 manifest 또는 대상 core 호환성을 확인할 수 없습니다`로 거부된다. 실측: 그 키만 지우면 현재 decoder가 통과하므로 settings·default_schedules는 독립 문법 오류가 아니다. 옛 패키지를 실행하지 않고 교체를 기다리는 상태도 정의되어 있지 않다(현재 `enable`은 정지·manifest를 보지 않는다).

**Approach:** core에 범용 "은퇴 필드 판독"(`decodeRetiredExtensionManifest`)을 추가한다: 현재 decoder grammar에서 은퇴 목록의 필드(현재 `work[].verification_snapshot`, 옛 규칙대로 `true`·python만)만 허용하고 `core_compat` 부재를 허용하며, migration 판독에 필요한 이름·버전·migrations 경로만 돌려준다. 이 판독은 (a) 21.9 legacy 전환 중, (b) 이미 "패키지 교체 대기"인 확장에만 쓴다. core 설치기는 그런 확장의 적용 이력만 검증하고(옛 패키지 migration 적용 안 함) 정지 gate를 해제하지 않고 교체 대기 owner로 남긴 뒤 설치 진행 기록(`extension_install_progress`)에 교체 대기를 저장한다. gate가 예약·청구·명령을 이미 막고, `enable`·수동 `run`·login은 교체 대기면 진단과 함께 거부한다. 현재 형식·대상 core 호환·패키지 신원(`ext install --package`)을 통과한 새 패키지만 그 owner를 이어받아 기존 전환 경로(접두 checksum 검증 → 새 migration → 활성화 → registry)를 끝내고 gate를 해제한다. `enabled=false`와 `extension:<name>` 보류는 그대로 남아 사용자의 명시 `enable`만 재개한다.

## Boundaries & Constraints

**Always:** 은퇴 필드 판독은 현재 decoder와 같은 모든 검사(이름=폴더, 경로 내부성, 키·형식)를 적용하고 은퇴 목록 외 unknown key·malformed는 거부한다. 교체 대기 판정·이력 검증·전제 검사는 첫 DB 변경·app 승격·journal 기록 전에 끝낸다. 21.9 기계 전제·운영자 offline 확인(TTY·시도별 nonce)·확인 후 재검사·A1 잠금·daemon fence·확장 advisory 잠금·migration 순서(31→self→35→gate→나머지→확장)를 그대로 유지한다. 교체 대기 gate owner는 journal 제거 전에 진행 기록에 저장되어 모든 중단 경계에서 같은 owner로 재개된다. 기억·대화·파일·채널·설정·예약 변경·회계·확장 이력·registry `enabled`·hold group·삭제 표식을 보존한다. 일반 신규 설치·schema≥35 일반 갱신·현행 패키지 설치는 현재 decoder·`core_compat`·digest/files 검증을 그대로 쓴다. 다른 owner gate·타 설치 journal·사용자 보류는 해제하지 않는다.

**Never:** 범용 decoder에 unknown key 허용, `core_compat` 요구 완화(교체 대기 판독 외), core에 `garmin` 이름·표·분기, 옛 패키지의 코드·명령·예약·청구·migration 실행, registry SQL 삭제·빈 DB·수동 파일 덮어쓰기 경로, 적용된 migration 파일 수정, 이름만으로 resolve한 패키지(`ext install <name>`)의 교체 대기 해소, 새 core migration 파일 추가(22.1과 번호 충돌 회피), 운영 DB/home/daemon/예약 접촉, 21.7 작업, main 병합·push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| M1 정상 core 갱신 | 합성 core27 + 21.9 L1 전제, 등록 `garmin`(09947d2 manifest·0001~0008 적용) 또는 다른 이름 `oldext`(같은 은퇴 키·`core_compat` 없음), TTY 확인 | core 38 완료, 확장 migration 적용 0건(이력 검증만), gate 유지(교체 대기 owner), 진행 기록에 교체 대기, journal 제거, installed.json 새 commit | 없음 |
| M2 교체 전 실행 | M1 뒤 core만 갱신 | `ext enable`·`ext run`·확장 명령·`ext login` 진단 거부, 예약·청구 0, daemon 재시작 뒤 동일 | 상태 무변경 |
| M3 교체 대기 중 core 재실행 | M1 뒤 같은/새 commit `setup run` | 교체 대기 확장을 타 owner로 오인하지 않고 성공, gate·진행 기록 유지 | 없음 |
| M4 정상 교체 | M1 뒤 현행 패키지 `ext install --package`(현재 형식·호환 core·files/digest) | 적용 이력 접두 checksum 일치 확인 → 새 migration만 적용 → 활성화 → registry 갱신 → gate 해제, `enabled=false`·보류 유지, 이후 `ext enable`로만 재개 | 없음 |
| M5 교체 거부 | 비호환 `core_compat`, malformed·이름 불일치·digest/files 불일치, 접두 checksum 불일치, 이름만 지정한 설치 | 변경 전 거부, 교체 대기·gate·옛 패키지 보존 | 진단 코드 |
| M6 판독 거부 | 은퇴 목록 외 unknown key, 은퇴 키 형식 위반(`false`·node), malformed JSON, 이름 불일치, 경로 이탈·symlink, migration checksum 불일치, 진행 기록 손상·미완료 transition, 21.9 전제 미충족, 타 owner gate | core 갱신을 첫 변경 전 `DB_LOCKED` 거부 | 무변경 |
| M7 일반 경로 회귀 | schema≥35 일반 갱신에 은퇴 키 manifest(교체 대기 아님), 신규 설치, 현행 패키지 설치 | 기존과 같이 거부/성공 | 기존 시험 유지 |
| M8 중단 재개 | core 갱신: gate 직후·진행 기록 저장 직후·journal 제거 전 실패/SIGKILL. 교체: 준비·migration·활성화·registry 직후 실패 | 같은 owner로 재개(core는 새 확인), 옛 코드 미실행, 옛·새 writer 동시 없음 | 확정 migration 되돌림 주장 없음 |

</intent-contract>

## Code Map

- `packages/core/src/extensions/manifest.ts` -- `decodeManifestUnchecked`: 은퇴 필드 판독을 별도 export 함수로 추가(현재 grammar 재사용, 은퇴 키만 제거 후 검증, `core_compat` 선택). 옛 grammar 근거는 `git show e33a787:packages/core/src/extensions/manifest.ts`의 `verification_snapshot` 규칙(L46·L49). `decodeExtensionManifest` 동작은 바꾸지 않는다. `packages/core/src/index.ts`에 export.
- `apps/cli/src/runtime/extensions.ts:68` `installedExtensionMigrations` -- 교체 대기 허용 이름 집합을 받는 옵션 추가, 결과에 `replacement` 표시. 경로·symlink·migration 파일 검사는 동일.
- `apps/cli/src/install/postgres.ts` -- `legacy` 판정(L138), 확인 전·후 `installedExtensionMigrations`(L146·L199)·`checkLegacy`, 이력 `validateOnly`(L176-180), journal, 21.9 bridge 뒤 `quiesceExtension`(L238), 확장 migration(L246), `endExtensionQuiesce`(L251). 교체 대기 확장은 owners 적용에서 빼고 이력만 검증, gate 해제 대신 진행 기록 저장. 교체 대기가 이미 있으면(M3) 그 gate를 타 owner(L155·L185)로 보지 않는다. 전제 검사에 진행 기록 유효성·미완료 transition 부재 추가.
- `packages/core/src/extensions/install-progress.ts` -- `ExtensionInstallProgress`·`validInstallProgress`에 교체 대기 필드(owner uuid·옛 version·시각) 추가, 옛 진행 기록(필드 없음)도 계속 유효.
- `packages/core/src/extensions/install.ts` -- `installExtensionUnlocked`의 gate 소유 검사(약 L213)·`previous?.transition` digest 불일치 거부(약 L170)·transition 경로. 교체 대기 + `prepared`일 때만 owner를 이어받아 기존 transition 경로를 사용하고 완료 시 교체 대기 필드 제거. 이름 resolve 경로는 교체 대기를 거부.
- `packages/core/src/extensions/status.ts` `setExtensionEnabled`, `run.ts` `runExtension`, `apps/cli/src/commands/ext-login.ts`, `commands.ts` -- 교체 대기(또는 gate) 진단 거부. disable은 허용. `ext-status`·public projection에 교체 대기 표시(선택).
- `packages/postgres/src/extensions.ts` -- `recordExtensionInstall` upsert는 `enabled`를 바꾸지 않음(확인 완료), `beginExtensionQuiesce` 같은 owner 재진입 의미 확인.
- 재사용 시험 기반: `packages/postgres/test/install-legacy.test.ts`(합성 core27 fixture·PTY `setup run`·SIGKILL 경계·보존 해시), `apps/cli/test/ext-fixture.ts`·`ext-install-resume.test.ts`, `apps/cli/python-test/garmin-upgrade.test.ts`(Garmin package 갱신).
- release: `plugin/app-ref`·`plugin/.claude-plugin/plugin.json`(현재 0.1.18), 패턴은 21.9 release `5e7d5f8`·`dbcd369`. Garmin 패키지 바이트를 바꾸지 않으면 Garmin 플러그인은 그대로.
- `tooling/test-changed/rules.mjs` -- 새 시험이 기존 접두(`packages/postgres/`, `packages/core/src/extensions/`, `apps/cli/src/install/`, `apps/cli/src/runtime/`) 밖이면 규칙 추가.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/extensions/manifest.ts`, `packages/core/src/index.ts`, `install-progress.ts` -- 은퇴 필드 판독 함수와 교체 대기 진행 필드·validator -- 제한 판독의 경계를 core 한 곳에 둔다
- [x] `packages/core/test/…` -- 판독 단위 시험: 09947d2 manifest 통과(현재 decoder 거부 대조), 은퇴 키 외 unknown key·형식 위반·malformed 거부, 다른 이름 합성 manifest -- AC3·M6
- [x] `apps/cli/src/runtime/extensions.ts`, `apps/cli/src/install/postgres.ts` -- 교체 대기 판정·이력 검증·gate 유지·진행 기록·M3 재실행·전제 추가 -- AC1·AC3·AC4
- [x] `packages/core/src/extensions/{install,status,run,commands}.ts`, `apps/cli/src/commands/ext-login.ts` -- 실행 진입 거부와 검증된 패키지의 owner 승계·완료 -- AC2
- [x] `packages/postgres/test/install-legacy-manifest.test.ts`(신규) -- 실제 PG·CLI 표면: M1~M8을 `garmin`(09947d2 manifest·0001~0008 → 현행 패키지 0001~0016) 및 다른 이름 합성 확장으로, 보존 해시 전후 대조, daemon 재시작 뒤 거부 유지, SIGKILL 경계 -- AC1~AC5
- [x] 기존 시험(`install-legacy.test.ts`, `install-orbstack.test.ts`, `ext-*.test.ts`) -- 메시지·동작 정합, N1/M7 회귀 유지 -- AC5
- [ ] release commit -- 구현 commit 뒤 별도 commit에서 `plugin/app-ref`를 그 구현 commit으로, core plugin version은 릴리스 직전 실제 원격 main과 17.4의 예정 0.1.19를 대조해 중복 없는 다음 버전(예상 0.1.20), release 시험(`tooling/bootstrap/test/{plugin,garmin-plugin,extension-plugin}.test.ts`) -- 21.7 설치 경로

**Acceptance Criteria:**
- Given 소유 전용 PG·격리 home의 합성 core27 설치본(09947d2 Garmin manifest와 0001~0008, 또는 다른 이름 합성 확장)이 21.9 전제를 갖췄을 때, when 대화형 `setup run`으로 core를 갱신하고 이어 `ext install --package`로 현행 패키지를 설치하면, then 같은 DB에서 두 단계가 끝나고 0001~0008은 재적용·변조 없이 접두 checksum이 확인된 뒤 0009 이후만 적용되며, 기억·이력·사용자 상태가 보존되고 core 갱신 직후부터 교체 완료까지 옛 확장의 코드·명령·예약·청구가 0건이다.
- Given core만 갱신된 교체 대기 또는 교체 중단 상태, when enable·run·명령·login·예약 청구·daemon 재시작·core 재실행을 시도하면, then 실행 진입은 진단과 함께 거부되고 상태가 유지되며, 교체 성공 뒤에도 비활성·보류는 남아 명시 `ext enable` 뒤에만 실행된다.
- Given M5·M6 조건, when 같은 갱신·교체를 요청하면, then 첫 변경 전 거부되고 앱·패키지·DB·기억·소유권이 보존되며 일반 신규·현행 갱신·현행 패키지 설치는 기존 검증 결과 그대로다.
- Given 모든 구현·리뷰 수정 뒤 최종 트리, when `pnpm test` 다음 `pnpm test:python`을 순차 실행하면, then 둘 다 종료 0이고 skip 추가·단언 축소가 없다.

## Implementation Notes

- 시험 환경: 소유 전용 PG18 컨테이너 `brain-2110-test`(id `e9b95c92efc3`, 라벨 `second-brain.ticket=21.10`, `127.0.0.1:54210`, tmpfs, 합성 비밀번호), `BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54210/postgres`. 운영(54320)·공용(54329)·타 티켓(22.1 `brain-221-*`, 17.4 `brain-t174-*` 등) 컨테이너는 건드리지 않는다. 로그는 `.brain-automation/logs/<UTC>-<label>-<rand>/`에 배타 생성한다.
- 조사 근거: 현재 decoder에 09947d2 manifest는 거부, `work[].verification_snapshot`만 제거하면 통과(지휘자 실측). 09947d2 migration 0001~0011과 현재 0001~0011 sha256 동일.

## Plan Change Log

## Review Triage Log

### 2026-11-06 — Review pass (r1, 4렌즈 Sol)
- 보고: `.brain-automation/review/r1-{edge-case-hunter,verification-gap,adversarial,intent-alignment}.md`, diff `.brain-automation/review/diff-r1.patch`(계획 파일 제외).
- verdicts: 17 findings — high 0, medium 12, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` E1 은퇴 키 없이 `core_compat`만 없는 옛 manifest가 legacy 전환에서 교체 대기 대신 `DB_LOCKED`(`apps/cli/src/runtime/extensions.ts:80-85`) — 허용 이름이고 현재 decoder 통과·`core_compat` 부재면 교체 대기로 판정(P1)
  - `[medium]` `[patch]` V1 거부된 교체 패키지가 관측 기록(`run/extension-packages/<name>.json`)을 바꾸지 않는지 미검증 — M5 snapshot에 관측 추가(P2)
  - `[medium]` `[patch]` V2 offline 확인 중 진행 기록이 바뀌는 경우의 변경 전 거부 미검증 — 확인 callback에서 progress 삽입 시험(P2)
  - `[medium]` `[patch]` B1 공개 상태가 교체 대기를 표시하지 않아 옛 `result: installed`가 그대로 보임(`public-projection.ts:14`, `ext-status.ts:19`) — owner 비노출 `replacement_required`와 텍스트 안내 추가(계획 Code Map이 이 표면을 이미 지정)(P1)
  - `[medium]` `[patch]` B2 교체 대기가 있는 비legacy cross-commit 갱신에서 확인 후 교체 owner 이력 `validateOnly` 재검사 없음(`postgres.ts:239-243`) — 확인 후에도 재검증·시험(P1, 시험 P2)
  - `[medium]` `[patch]` B3 은퇴 manifest version과 registry version 불일치를 검사하지 않고 registry 값을 `fromVersion`으로 기록 — 불일치면 변경 전 거부(P1, 시험 P2)
  - `[medium]` `[patch]` B4 `checkExtensionExecution`이 모든 gate를 `EXTENSION_REPLACEMENT_REQUIRED`로 바꿔 일반 전환 중단의 기존 진단·코드가 바뀜(Boundaries 일반 경로 불변 위반) — replacement 기록이 있을 때만 새 코드, 그 외 gate는 기존 코드·안내 유지, 기존 시험 기대 복원(P1)
  - `[low]` `[patch]` B5 동적 명령 fallback이 실행 검사 실패(`DB_LOCKED`·`DB_UNAVAILABLE`)를 null로 버림(`extension-commands.ts:49`) — 실패 전달(직접 수정)(P1)
  - `[medium]` `[patch]` B6 core 단위 경계 주입이 부작용 전에 예외 — registry 기록 뒤·활성화 뒤·journal commit 뒤 실패와 progress 저장 실패 사례 추가(P2)
  - `[medium]` `[patch]` B7 일반 확장과 은퇴 확장 혼합·복수 교체 대상·두 번째 저장 실패 재개 미검증(P2)
  - `[medium]` `[patch]` B8 progress 표 없는 schema 11/15와 16 경계 미검증(0016이 표 생성 확인) (P2)
  - `[medium]` `[patch]` B9 Garmin 보존 데이터가 `datasets` 한 행뿐 — raw/bytea·반입·수집·정규화 대표 행 추가·전후 대조(P2)
  - `[low]` `[patch]` B10 PTY wrong/eof/json 모드 미호출 — 모드별 거부·보존 단언(P2)
  - `[low]` `[reject]` IA-A CLI E2E가 staged app 승격을 거치지 않음 — `promoteStagedApp`은 변경하지 않았고 모든 manifest·이력 사전 검사 뒤에 호출되며 21.9 시험이 그 경계를 덮는다. 새 판독 경로와 독립이라 추가 시험은 중복
  - `[medium]` `[patch]` IA-B Garmin 교체 시험이 종료 코드 4종을 허용 — 격리 fixture에서 결정적인 기대 코드 하나로 좁히고 그 이유를 주석(P2)
  - `[low]` `[patch]` IA-C SIGKILL 재개 시험이 install.lock을 직접 제거 — A1 안내 문구(`install-lock.ts:17`의 문서화된 복구 절차)가 나온 것을 먼저 단언한 뒤 그 절차대로 제거(P2)
  - `[low]` `[reject]` IA-D 예약·청구 차단을 store 메서드로 관찰 — daemon은 같은 `fireSchedule`(`queue/schedule-tick.ts:46`)·`claimSupervisedWork`(`queue/supervisor.ts:450`)를 호출하므로 같은 SQL gate가 실제 차단 지점이다. 실행 증거 공백은 마무리 전체 회귀로 닫는다
- 처리: P1(제품 수정, 기존 구현 워커 6번째 Task), P2(시험 보강, 새 구현 워커 — Task 6개 초과 방지). 사용자 최신 지시로 패치 메시지의 "커버 시험 실행"은 "시험 실행 금지, build·typecheck·diff --check만"으로 대체.

### 2026-11-06 — Review pass (r2 후속, Sol 단일)
- 보고: `.brain-automation/review/r2-followup.md`, diff `.brain-automation/review/diff-r2.patch`. r1 patch 15건 판정: 해결 14, 부분 1(B4). reject 2건 기각 타당.
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` F1 일반 확장(gate·replacement 없음)의 무효 진행 기록이 enable/run/login을 새로 `DB_LOCKED`로 막음(`replacement.ts:10-14`) — 무효 기록은 차단 사유에서 제외(기준 동작 복원), 유효 replacement만 판별. gate 있으면 거부는 계획 결정으로 유지(gate는 중단 전환에서만 존재, 그동안 enable 거부가 안전 방향)
  - `[low]` `[patch]` F2 미등록 동적 명령 fallback이 일반 gate에 `DB_LOCKED` 반환(`extension-commands.ts:49`) — `'command'` 종류 전달로 `EXTENSION_COMMAND_UNAVAILABLE` 일치, 시험 추가

### 2026-11-06 — Review pass (r3 집중 후속, Sol)
- 보고: `.brain-automation/review/r3-followup.md`. F1·F2 및 B4 잔여 모두 해결, 새 발견 0건. gate·유효 replacement 차단과 조회 실패 전달을 정적으로 확인했다. 시험 실행 통과 판정과 구분한다.
- 추가 수정 없음. 마지막 제품 수정의 build·typecheck·diff 검사는 종료 0이며 이제 최종 전체 회귀를 순차 실행한다.

### 2026-11-06 — 최종 회귀 및 r4 처분
- 전체 `pnpm test` 종료 1(188파일 통과, 신규 legacy 파일 5실패); fixture canonical 경로·rename 중 DB 연결·PTY 제어 터미널을 수정했다. `test:changed` 첫 재검증은 종료 1(150파일 통과, 7실패·오류2). 정상 node 교체·SIGKILL 재개·oldext 실제 setup은 통과했으나 첫 timeout과 Garmin 보존 검사는 미해결이다. 기존 시험의 SIGINT·DB 실패도 제한 worker 재검증 전까지 미해결로 유지한다.
- r4 후속 리뷰 `.brain-automation/review/r4-regression-followup.md`: `[medium]` `[patch]` F1 setup 거부 모드가 PTY deadline SIGKILL을 정상 거부로 수락 — helper timeout/signal 실패 및 `DB_LOCKED`·challenge 도달 여부 단언을 추가한다.
- 중앙 결정 `msg_89805287692b`: 원문 AC1은 과거 migration 불변·접두 이력/바이트 보존과 새 migration 적용을 함께 요구한다. 기존 Garmin `0013_remove_legacy_collect.sql`이 `import_provenance`·`collect_state`·`normalize_items`를 명시 제거하므로 교체 후까지 이 3표 동일 해시를 요구한 B9의 시험 기대를 단계별로 정정한다. core 전환 전후에는 기존 8표 전체 보존; Garmin 교체 전후에는 비어 있지 않은 영속 6표(`datasets/import_batches/raw_payloads/import_mapping/artifact_inventory/preserved_rows`)와 core 기억·사용자·예약·회계·기존 이력 접두 및 raw bytes/hash/매핑 보존; 제거 3표는 교체 전 데이터 존재와 교체 후 예상 부재를 검사한다. oldext의 DROP 없는 표 전체 보존과 migration 확정 전 거부/실패의 기존 보존 단언을 유지한다. 제품·과거 migration·skip 변경 없이 승인된 migration 의미를 검사하며 새 데이터 손실을 허용한 결정이 아니다.

### 2026-11-06 — r5 집중 후속 리뷰
- `.brain-automation/review/r5-followup.md`: r4 F1과 중앙 보존 결정 반영을 정적으로 해결 확인, 새 발견 0건. timeout 단계 계측은 진단 보강이며 실제 원인 해결을 뜻하지 않는다. wrong/eof/json의 정상 진단 종료·정리 및 신규/기존 실패는 제한 worker 실행 전까지 미확정이다.

### 2026-11-06 — r6 후속 및 최종 실행 결과
- `.brain-automation/review/r6-eof-followup.md`: login PTY 종료 후 drain의 빈 read break 누락을 최소 수정한 결과를 정적으로 확인, 새 발견 0건. 실행 r3에서 login end·예약 발화 차단·두 번의 재연결/청구 차단·최종 snapshot·정리 end까지 완료해 기존 timeout을 닫았다.
- 최종 `VITEST_MAX_WORKERS=2 ... pnpm test:changed -- 133437602777e4771417a6b8a349fe930a786b3e` 종료 0: TS 153파일/3,591시험 통과, 기존 skip1; 경로 규칙의 Python 전체 15파일/66시험 및 내부 Python 244시험 OK. full Python config의 전체 선택·실행·완료를 확인했으므로 중앙 최신 `msg_a4cc2f09c989`에 따라 별도 `pnpm test:python` 중복 실행은 하지 않았다. 마지막 build는 같은 명령에서 종료0, 별도 최종 `pnpm typecheck`·`git diff --check`도 종료0.
- 원시 로그 `.brain-automation/logs/20261106T042923Z-final-pk0nwbok/`: 최초 `test.log` 종료1(신규5실패), `changed-r1.log` 종료1(7실패/오류2), `changed-r2-workers2.log` 종료1(PTY timeout1), `changed-r3-workers2.log` 종료0(TS와Python전체), `typecheck-final.log` 종료0. 최초 실패를 소급 통과로 쓰지 않는다. 기존 SIGINT·DB 실패는 worker2 재실행에서 모두 통과했으며 호스트 부하를 확정 원인으로 단정하지 않는다.
- 실행별 fixture 컨테이너118/118/118/174개는 모두 removed 최종 이벤트를 확인했다. 별도 소유 `brain-2110-test` 정확 ID·라벨 대조 뒤 제거, inspect 종료1의 부재를 확인했다. 운영·타 티켓 자원 변경 없음.

## Design Notes

교체 대기를 새 core 표 대신 기존 정지 gate(`brain.extension_quiesce`)와 설치 진행 기록에 두는 이유: gate는 이미 예약·청구(`packages/postgres/src/{schedules,work}.ts`)와 명령(`commands.ts`)을 SQL·코드 수준에서 막고 재시작 뒤에도 남는다. 진행 기록은 "gate 전에 owner를 저장한다"는 기존 설치 재개 규약의 자리다. 새 migration을 만들지 않아 22.1의 번호와 충돌하지 않는다. 은퇴 필드 판독은 확장 이름이 아니라 core가 한때 받아들인 manifest 필드 목록으로 정의되므로 Garmin 전용 분기가 아니다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 성공
- 개발 중 시험은 중앙 최신 지시로 실행하지 않고 build/typecheck/diff 검사만 수행했다. 최종 전체 회귀 실패 뒤에만 `VITEST_MAX_WORKERS=2 BRAIN_TEST_DATABASE_URL=… pnpm test:changed -- 133437602777e4771417a6b8a349fe930a786b3e`로 재검증했다.
- `BRAIN_TEST_DATABASE_URL=… pnpm test` 후 `pnpm test:python` 순차 각 1회 -- expected: 둘 다 종료 0, 고유 로그 보존


## Auto Run Result

- 결과: 옛 manifest는 제한된 판독으로 migration 신원/바이트만 검증하고 core를 갱신하며, 기존 gate와 유효 교체 기록으로 옛 실행 진입을 막는다. 현행 호환·신원·접두 검증을 마친 명시 패키지만 owner를 승계해 교체를 완료하고 사용자 비활성·보류를 유지한다. 일반 runtime decoder와 새 패키지 검증은 그대로다.
- 변경: core manifest/progress/replacement/install/명령·enable·run·공개 상태와 store port/export; CLI core 설치/확장 목록·명령 fallback/login/status; PG migration 사전 검사; README 오류 코드; 공개 옛 manifest·migration fixture와 core/CLI/실PG 시험을 추가·보강했다. 적용된 migration 파일이나 새 core migration은 바꾸지 않았다.
- 리뷰: r1 17건 중 patch15/reject2(IA-A staged app 승격 조합 중복, IA-D 같은 최종 SQL gate를 검사하는 표면); r2 잔여 F1/F2 patch2와 r3 해결 확인; 회귀 r4 F1 patch와 r5/r6 후속 확인. deferred 없음, 마지막 후속 새 발견0으로 followup_review_recommended=false다.
- 검증: 최초 전체 `pnpm test`는 실패했고 모든 실패의 처분은 위 이력에 보존했다. 최종 test:changed TS153파일/3,591시험·Python전체15파일/66시험 및 내부244시험 통과, 종료0. 기존 skip1 이외 skip 추가나 단언 축소 없음. build/typecheck/diff 검사 종료0.
- 릴리스: 중앙의17.4 예정0.1.19와 원격main0.1.18을 대조해0.1.20을 사용한다. 구현 commit 다음 별도 commit에서 app-ref를 그 구현 SHA로 갱신한다.
- 남은 경계: 실제 운영 전환·계정/TTY 운영자 확인은21.7 소관이다. 중앙 안내의22.1 schema39는 현재 원격main49c23630dc9f520d805a15d830d41cc81f7dfdb6에 아직 없으며, 이후 직렬 main 통합 시 이 시험의 명시 core38 기대를 최신 core와 재대조하고 필요한 검증을 수행한다. 현재 티켓 자체의 미해결 기능 실패는 없다.
