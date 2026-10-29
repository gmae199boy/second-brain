---
title: '확장 끄기 계약: 보류 그룹을 보류하면 진행 일감은 끊기고 대기 일감은 켤 때까지 멈춘다'
type: 'feature'
ticket: '10'
created: '2026-10-29'
status: done
baseline_revision: '1aaecbf89a13804f50da56879accb6d20a883001'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 확장을 끌 때 그 확장의 일감·예약을 멈출 공통 수단이 없다. 대기 일감은 계속 청구되고, 예약은 발화하며, 진행 중인 감독 일감을 끊을 길은 사용자 취소(일감을 닫는다)뿐이다(E12-11).

**Approach:** 보류 그룹을 DB 표로 두고, 일감·예약 행에 선택 칸 `hold_group`을 더한다. 보류 그룹이 보류 중이면 모든 청구 경로와 예약 발화가 그 그룹의 행을 건너뛰고, 감독자는 그 그룹의 진행 attempt를 기존 취소 경로로 끊되 일감은 닫지 않고 대기로 되돌린다. 해제하면 표에서 행이 빠지고 대기 일감이 그대로 다시 청구된다. Store verb `holdWorkGroup`·`releaseWorkGroup`과 Core use case·SDK `brain.queue.hold|release`가 이것을 연다.

## Boundaries & Constraints

**Always:**
- **저장:** 새 core 마이그레이션 `0010_work_hold_groups.sql`(`CORE_SCHEMA_VERSION` 10). 표 `brain.work_hold_groups(name text primary key, held_at timestamptz not null)`, `name`은 1~200자 check. 행이 있으면 보류 중이다. `brain.work_items`와 `brain.schedules`에 `hold_group text`(null 또는 1~200자 check) 칸. `brain_app`에 새 표 select·insert·delete 권한. 0001~0009는 고치지 않는다.
- **그룹 결정(Core 함수 하나, `domain/work-item.ts`의 `workHoldGroup(kind, explicit?)`):** 종류에 `.`이 있으면(`<ext>.<kind>`) 그룹은 늘 `extension:<첫 . 앞>`이다(호출자가 다른 그룹을 줘도 이것이 이긴다). 그 밖은 호출자가 준 그룹, 없으면 null. `AddWorkInput`·`Schedule`/예약 추가 입력에 선택 칸 `holdGroup`을 더하고, fake·PG의 일감 생성(`ensureWork`, 그래프 포함)과 예약 추가가 이 함수로 저장 값을 정한다. 이미 열린 행과 합쳐질 때는 기존 행의 그룹을 바꾸지 않는다(`serializationKey`와 같다). 예약 발화와 수동 실행이 만드는 일감은 예약의 `holdGroup`을 받는다.
- **청구 차단:** core drain의 `claimCandidateQuery`(→ `hasDueWork`·`claimWork`)와 `claimSupervisedWork`는 `hold_group`이 보류 중인 행을 건너뛴다. 그룹이 null이거나 보류 중이 아닌 행의 청구 순서·결과는 그대로다.
- **예약 차단:** `listDueSchedules`는 보류 중인 그룹의 예약을 내지 않고, `fireSchedule`은 같은 트랜잭션 안에서 다시 확인해 보류 중이면 `fired: false`를 돌려주며 `next_run_at`·성공 기록·일감을 건드리지 않는다. 그래서 해제 뒤 첫 tick이 기존 놓친 예약 규칙(빠진 날짜를 한 번에)대로 한 번 돈다.
- **진행 중 일감:** `listOpenSupervisedAttempts`의 항목에 `held: boolean`을 더하고, 감독자의 취소 감시(`queue/supervisor.ts`의 `a.cancelRequested` 검사)가 `cancelRequested || held`이면 같은 그룹 SIGTERM → 유예 → SIGKILL → reap 경로로 끊는다. 정산은 기존 `settleSupervisedAttempt(outcome: 'cancelled')`이고 `cancel_requested_at`이 없으므로 attempt 결과는 `cancelled`, 일감은 열린 채 청구가 풀리고 `attempts`가 하나 돌려진다(데몬 종료 경로와 같다). 결과와 exit 0이 먼저 온 경쟁은 지금처럼 성공이 이긴다.
- **verb:** `WorkStore.holdWorkGroup({group, now}) → {ok, held: boolean}`(새로 보류했으면 true, 이미 보류 중이면 false, 값은 바꾸지 않음), `releaseWorkGroup({group}) → {ok, released: boolean}`. 실패는 `DB_UNAVAILABLE | DB_LOCKED`. use case `packages/core/src/queue/hold-groups.ts`가 그룹 이름(공백뿐·200자 초과 → `USAGE`)을 검사하고 SDK `brain.queue.hold({group})`/`release({group})`가 `{ok: true, group, held|released}`를 돌려준다. CLI 명령은 만들지 않는다(registry가 부르는 SDK 전용, `schedules.tick` 선례).
- **보이기:** `listWork` 항목에 `held: boolean`을 더한다. `workListState`는 `completedAt` → outcome, 현재 attempt `unknown` → `unknown`, `claimedAt` → `running`, 보류 중 → `extension_disabled`, 그 밖 `queued`. `queue list` 행에 `hold_group`, `schedules list` 행에 `hold_group`을 더한다(사람용 줄은 한국어, 보류 행은 "보류 중"이 보인다).
- **우회 없음:** `failures retry`와 `schedules run`은 `addWork`를 거치므로 보류 중 그룹의 열린 행과 합쳐지거나 그 그룹으로 새 행을 만들 뿐 청구 가능하게 만들지 않는다. `queue cancel`은 보류 중 대기 일감도 지금처럼 닫는다.
- 새 Store verb와 바뀐 verb는 fake·PG에 같은 의미로 두고 계약 suite가 둘에서 돈다. 새 오류 코드는 없다.

**Never:**
- 확장 registry·manifest·`extensions` 명령(epic 13), 분석 일감에 그룹을 붙이는 일(epic 18), `brain queue hold|release` CLI 명령, `schedules add`의 그룹 CLI 옵션을 만들지 않는다.
- 이름으로 실행 분류를 정하지 않는다(`<ext>.*`도 등록부에 없으면 `core`다). 보류 때문에 일감을 닫거나 `failures`를 쓰지 않는다. 보류는 사용자 취소(`cancel_requested_at`)를 쓰지 않는다.
- 진행 중 core drain 일감은 끊지 않는다(짧은 회차라 끝나게 둔다). 기존 청구·임대·token CAS·의존·직렬화 키 규칙은 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 자동 그룹 | `testext.job` 일감·예약 추가(그룹 미지정, 또는 다른 그룹 지정) | `hold_group = 'extension:testext'` | — |
| 붙인 그룹 | core 종류 일감에 `holdGroup: 'extension:testext'` | 그 그룹 저장. 그룹 없는 core 일감은 null | — |
| 보류 중 청구 | 그룹 보류 뒤 drain·감독자 청구 | 그 그룹 행은 청구 안 됨, `queue list` state `extension_disabled`. 다른 그룹·그룹 없는 행은 지금처럼 청구 | — |
| 진행 중 끊기 | 그룹을 붙인 probe가 진행 중일 때 보류 | 자식 그룹이 정리되고 attempt `cancelled`, 일감은 열림·미청구·`attempts` 0, state `extension_disabled` | — |
| 예약 | 그 그룹 예약의 발화 시각이 지나 tick | `fired` 0, `next_run_at` 그대로. 해제 뒤 tick은 한 번 발화 | — |
| 우회 시도 | 보류 중 `schedules run`, `failures retry`(보류 중 열린 행과 같은 대상) | 일감은 생기거나 합쳐지지만 drain이 청구하지 않음 | — |
| 해제 | `release` | 대기 일감이 다시 청구되어 끝까지 돈다(probe 성공) | — |
| 두 번 | 같은 그룹 두 번 hold / 없는 그룹 release | `held: false` / `released: false` | — |
| 잘못된 그룹 | `''`, 공백, 201자 | 아무것도 쓰지 않음 | `USAGE` |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0009_local_schedules.sql`, `0008_work_serialization_key.sql` -- 칸·check·grant 모양의 선례. `packages/postgres/src/migrate.ts:7` `CORE_SCHEMA_VERSION`을 10으로. 버전 9를 고정한 시험(예: `apps/cli/test/daemon-run.test.ts:235`의 버전 되돌리기, installed-schema·migrate 시험)이 걸리면 의미를 지키며 맞춘다.
- `packages/core/src/domain/work-item.ts` -- `WorkItem`(`:29`)에 `holdGroup: string | null`, `WORK_KINDS`(`:160`) 곁에 `workHoldGroup`. `packages/core/src/domain/schedule.ts` -- `Schedule`에 `holdGroup`.
- `packages/core/src/ports/store.ts` -- `AddWorkInput`(`:403`)에 `holdGroup?`, `OpenSupervisedAttempt`(`:548`)에 `held`, `WorkStore`(`:686`)에 두 verb, `listWork` 항목에 `held`. `ScheduleStore`(`:1421`)는 입력이 `Schedule`이라 칸만 따라온다.
- `packages/postgres/src/work.ts` -- `WorkItemRow`(`:38`)·`toWorkItem`(`:765`)에 `hold_group`. `claimCandidateQuery`(`:86`)와 `claimSupervisedWork`(`:315`)의 where에 같은 보류 술어(작은 SQL 조각 함수 하나, `keyAvailable` 선례). `ensureWork`(`:110`) insert에 `workHoldGroup(...)`. `listOpenSupervisedAttempts`(`:283`)에 `held`. `listWork`(`:350`)에 `held`.
- `packages/postgres/src/schedules.ts` -- `listDueSchedules`(`:109` 근처 where)와 `fireSchedule`(`:125` 근처 CAS)에 보류 술어, 예약 행 읽기·쓰기에 `hold_group`, 발화 일감에 예약의 그룹.
- `packages/core/src/testing/fakes/store.ts` -- 일감·예약 맵, `listDueSchedules`(`:497`)·`fireSchedule`(`:503`), 청구 함수들, `listOpenSupervisedAttempts`. 보류 그룹 `Map<string, Date>`를 더하고 PG와 같은 규칙.
- `packages/core/src/testing/contracts/work-store.ts`, `schedule-store.ts` -- 새 case(아래 Tasks).
- `packages/core/src/queue/supervisor.ts:117-119` -- 취소 감시가 `held`도 본다. 정산 분기(`:195`)는 그대로 둔다.
- `packages/core/src/queue/schedule-tick.ts`, `queue/schedules.ts` -- 발화·수동 실행 일감에 `holdGroup: schedule.holdGroup`. `addDaily` 입력에 선택 `holdGroup`(SDK 전용).
- `packages/core/src/queue/list.ts` -- `workListState`에 `extension_disabled`. `packages/core/src/brain.ts:199-205,425` -- `BrainQueue`에 `hold`·`release`. `packages/core/src/index.ts` -- 새 use case·타입 재export.
- `apps/cli/src/commands/queue-list.ts`, `schedules-list.ts` -- 행에 `hold_group`, 사람용 줄. `apps/cli/test/supervisor-fixture.ts` -- `enqueueProbe`에 그룹 인자, `apps/cli/test/daemon-supervisor-cancel.test.ts` -- 실제 데몬·probe 자식·짧은 seam(`pollMs` 등)의 선례. `apps/cli/test/schedules-queue-list.test.ts` -- CLI로 예약을 만들고 PG store·Core `tickSchedules`를 시험 안에서 직접 부르는 선례.
- `packages/core/src/failures/retry.ts` -- 고치지 않는다. `FAILURE_RETRY_STAGES`가 고르는 종류(예: `session_ingest`)로 보류 중 열린 행을 만들어 우회 없음을 시험한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0010_work_hold_groups.sql`, `packages/postgres/src/migrate.ts` -- 표·칸·권한, 버전 10.
- [x] `packages/core/src/domain/{work-item,schedule}.ts`, `ports/store.ts`, `queue/{hold-groups,list,schedules,schedule-tick,supervisor}.ts`, `brain.ts`, `index.ts` -- 타입·`workHoldGroup`·use case·SDK·state·감독자 취소.
- [x] `packages/core/src/testing/fakes/store.ts`, `packages/postgres/src/{work,schedules}.ts` -- verb·술어·칸의 fake·PG 구현.
- [x] `packages/core/src/testing/contracts/work-store.ts`, `schedule-store.ts` -- case: `stores the automatic extension group and an explicit core group`, `skips held groups on every claim path and resumes on release`, `marks open supervised attempts of a held group`, `reports hold and release idempotently`, `does not fire a held schedule and fires once after release`.
- [x] `packages/core/test/work-hold.test.ts`(새, `memoryStore`·`manualTime`·`createBrain`) -- 행렬 전체: `testext.job`과 그룹을 붙인 core 종류 일감은 보류 중 drain(시험 handler 등록)이 건드리지 않고 `queue.list`에 `extension_disabled`, 다른 그룹·그룹 없는 일감은 처리, 보류 중 `schedules.run`·`failures.retry`가 청구를 만들지 못함, 해제 뒤 drain이 둘 다 끝냄, 잘못된 그룹 `USAGE`. 시험 이름: `holds and resumes only the named group`, `manual run and failures retry do not bypass a hold`, `rejects an invalid group name`.
- [x] `packages/core/test/supervisor-cancel.test.ts` -- `cancels a running attempt of a held group without closing the work`(가짜 프로세스 port).
- [x] `apps/cli/src/commands/queue-list.ts`, `schedules-list.ts` -- `hold_group` 칸과 보류 표시.
- [x] `apps/cli/test/work-hold.test.ts`(새, PG, 실제 데몬과 probe 자식) -- `holding testext cancels the running probe, parks queued work and blocks its schedule`: 그룹 `extension:testext`를 붙인 probe가 진행 중일 때 SDK/Core use case로 보류 → attempt `cancelled`, 일감 열림·`queue list --json`의 state `extension_disabled`; `testext.job` 일감과 그룹을 붙인 `session_ingest` 일감(같은 대상의 failure 기록 포함)이 `queue drain`·`failures retry` 뒤에도 열림·미청구; `schedules add --kind testext.daily` 예약이 `next_run_at` 뒤 tick에서 `fired` 0이고 `schedules run`이 만든 일감도 `extension_disabled`; 그룹 없는 probe와 다른 그룹(`extension:otherext`) 일감은 끝까지 돈다. 이어서 `releasing testext resumes the parked work`: 해제 뒤 probe가 다시 청구되어 `succeeded`, tick이 한 번 발화.

**Acceptance Criteria:**
- Given 이 Mac의 PG 시험 DB와 실제 데몬·probe 자식, when 위 CLI 시험이 `extension:testext`를 보류했다가 해제한다, then 보류 동안 진행 중 probe는 취소되고 대기 일감(그룹을 붙인 core 종류 포함)은 `queue list`에 `extension_disabled`로 남으며 그 그룹의 예약은 발화하지 않고 `failures retry`·`schedules run`이 그 일감을 청구하게 만들지 못하며, 다른 그룹과 그룹 없는 일감은 영향을 받지 않고, 해제 뒤 대기 일감이 이어서 돌아 끝난다.
- Given 바뀐 Store verb들, when 계약 suite가 fake와 PG에서 돈다, then 같은 결과를 낸다.

## Implementation Notes

- 0010에서 기존 v9 확장 일감·예약의 자동 보류 그룹을 채우고 200자 초과 그룹은 건너뛰도록 수정했으며, `pnpm exec vitest run --project postgres test/migrate.test.ts`로 업그레이드·길이 경계를 검증했다.

- 계획의 저장·청구·예약·감독자·SDK·CLI·시험 항목을 구현했다. 설치/설정 및 스키마 카탈로그 시험의 core 버전 기대값도 10으로 갱신했다.
- 보류는 `cancel_requested_at`을 쓰지 않으며 기존 정산 경로로 attempt만 취소한다. 진행 중 core drain과 실행 분류 규칙은 유지한다.

- 구현 세션(codex, 커밋 `520016153dcdbd2bd8a4f40886e7fc00efd24ee7`)의 자체 점검: quick / medium / patch: `packages/core/src/testing/fakes/store.ts`의 Store 직접 입력은 빈 그룹명·201자 그룹명을 저장하지만 PG의 0010 CHECK는 `DB_UNAVAILABLE`로 거부한다. `holdWorkGroup`, `addWork`, `addSchedule` 경로를 확인했으며, fake 검증과 공유 계약 시험으로 수정 완료. 경계값·Unicode·자동 그룹 우선·그래프 원자성 시험이 fake와 PG 모두 통과했다.
  - (조율자 주: 구현 세션이 frontmatter를 `built`·`quick`으로 바꾸고 자체 점검을 Review Triage Log에 적었다. 조율자가 `in-progress`로 되돌리고 그 내용을 여기로 옮겼다.)
- 조율자 검증(2026-10-29): `git diff --check` 통과, 집중 core 시험 340개·CLI 시험 158개 통과(`apps/cli/test/work-hold.test.ts` 2개가 실제 데몬·probe 자식으로 실행됨), `pnpm test` build·typecheck와 125개 파일 3,328개 시험 통과. I/O 행렬 9행 모두 실행된 시험이 덮는다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` quick 1: `packages/postgres/migrations/0010_work_hold_groups.sql`가 v9에 이미 있던 `<ext>.*` 일감·예약 행의 `hold_group`을 채우지 않아, 업그레이드한 DB에서는 그 행이 보류를 우회한다 — 확인: `groupAvailable()`은 저장된 `hold_group`만 보고 `ensureWork()`는 열린 행의 그룹을 바꾸지 않으며, 12.9의 `schedules add`로 점이 든 종류를 이미 만들 수 있다. 지금은 확장 registry가 없어 그런 행이 드물어 low로 판정했다. 구현 세션이 같은 마이그레이션에 `'extension:' || split_part(kind, '.', 1)` 백필(200자 초과는 건너뜀)과 업그레이드 시험을 더했다(커밋 `ca0625729496ea10bc9b66cc5b9e39ede7799918`). `pnpm test` 3,329개 통과.

### 2026-10-29 — 후속 리뷰
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` quick 1: fake `ensureSession`이 잘못된 `identityWork.holdGroup`의 `addWork` 실패를 무시하고 세션·checkout을 저장한다 — `packages/core/src/testing/fakes/store.ts`의 오류 미확인과 `packages/postgres/src/sessions.ts`의 트랜잭션 롤백을 대조해 공동 커밋 계약 위반을 확인했다. fake에서 일감 저장 결과를 세션·checkout 쓰기 전에 확인하도록 수정하고, 공유 세션 계약에 빈 그룹·201자 그룹의 실패 원자성·정상 재시도·기존 세션 보존 시험을 추가했다. 구현 세션 식별자가 인계되지 않아 별도 수정 세션을 사용했다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): 보류로 끊긴 진행 일감은 닫지 않고 대기로 되돌린다(attempt `cancelled`, 일감 열림, `attempts` 반환). "다시 켜면 이어서 돈다"(에픽 Decision)와 맞고, 사용자 취소(일감 `cancelled`로 닫힘)와 확장 끄기를 구분한다. 일감을 닫는 안은 해제 뒤 이어서 돌 일감이 없어지므로 택하지 않았다.
- Decision(2026-10-29, 추천으로 정함): 보류 상태는 일감 행이 아니라 그룹 표 하나에 둔다. 보류 중에 새로 들어온 일감도 곧바로 `extension_disabled`가 되고, 해제가 행을 하나씩 고치지 않는다. 에픽 Notes의 "일감 행의 보류 이유"는 행의 `hold_group`과 그룹 표의 조인으로 정해진다. 이유 값은 지금 `extension_disabled` 하나라 칸을 두지 않는다.
- Decision(2026-10-29, 추천으로 정함): 보류 중 `schedules run`은 거부하지 않고 일감을 만들거나 합친다. 그 일감은 보류 상태로 기다렸다가 해제 뒤 돈다. 새 오류 코드 없이 "우회하지 않는다"를 지킨다. `failures retry`도 같은 이유로 고치지 않는다. 지금 retry가 만드는 종류는 core 수집·추출뿐이고, 보류 중 그룹의 열린 행과는 합쳐진다. 분석 일감의 retry 경로를 더하는 쪽(epic 18)이 그룹을 넘긴다.
- Decision(2026-10-29, 추천으로 정함): 보류·해제는 SDK 전용이다. 사람이 CLI로 확장 그룹을 풀면 registry의 끄기 상태와 어긋나므로, 부르는 쪽은 epic 13 registry뿐이다.
- 경쟁: 보류와 같은 순간의 청구는 이미 청구될 수 있다. 감독 일감은 다음 취소 감시(`SUPERVISOR_CANCEL_POLL_MS`)에서 끊기고, core drain 일감은 짧은 회차라 끝나게 둔다. 발화와 보류가 겹쳐 생긴 일감도 그룹을 갖고 있어 청구되지 않는다.

## Verification

**Commands:**
- `pnpm exec vitest run --project core test/work-hold.test.ts test/contracts.test.ts test/queue-list.test.ts test/supervisor-cancel.test.ts` -- expected: 새 시험 이름 통과.
- `pnpm exec vitest run --project postgres` -- expected: PG 계약 suite·마이그레이션 시험 통과. PG 사전 조건: OrbStack이 켜져 있다(global setup이 시험 컨테이너를 띄운다).
- `pnpm exec vitest run --project cli test/work-hold.test.ts test/schedules-queue-list.test.ts test/daemon-supervisor-cancel.test.ts test/output-language.test.ts` -- expected: 통과. 실제 Node 자식(probe)을 쓰는 시험이다.
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.
- `git diff --check` -- expected: 출력 없음.

### 실행 결과 (2026-10-29)

- Core 지정 4개 파일: 340개 시험 통과.
- PostgreSQL 전체: 19개 파일, 430개 시험 통과.
- CLI 지정 4개 파일: 158개 시험 통과. 실제 데몬·probe의 보류 취소/해제 재실행, 다른 그룹 정상 처리, 예약 차단/해제 후 1회 발화 확인.
- 최종 `pnpm test`: build·typecheck 및 125개 파일, 3,328개 시험 통과.
- `git diff --check`: 통과.
- 행렬의 자동/명시적 그룹, 청구 차단, 진행 attempt 취소, 예약 보류, 수동 실행·실패 재시도 우회 차단, 해제, 멱등성, 잘못된 그룹 입력은 실행된 계약·Core·CLI 시험으로 확인했다.
- quick 독립 리뷰 1건 수정 완료. 이연/미완료 항목 없음. 기존 PG 동시 query deprecation 경고는 기능 실패 없이 출력됨.

## Auto Run Result

- 인계 상태: `built`. 기존 frontmatter `status`는 보존했다. 티켓 완료 판정은 오케스트레이터가 하며 `tickets.py mark`는 실행하지 않았다. 기존 deferred-work 원장 항목을 수정·재개·재작성하지 않았다.
- 구현 요약: 보류 그룹으로 확장·명시적 core 일감과 예약을 멈추고 해제하면 재개한다. 진행 중 감독 일감은 기존 프로세스 그룹 취소 경로로 끊고 대기로 돌린다. SDK 보류·해제와 목록의 `extension_disabled` 표시를 제공한다.
- 기준 커밋: `1aaecbf89a13804f50da56879accb6d20a883001`. 이번 실행은 이미 `built`인 계획의 후속 quick 리뷰다.
- 변경 파일과 역할:
  - `packages/postgres/migrations/0010_work_hold_groups.sql`, `packages/postgres/src/{migrate,work,schedules}.ts` — 그룹 표·칸·권한·백필과 청구·발화 차단.
  - `packages/core/src/domain/{work-item,schedule}.ts`, `ports/store.ts`, `brain.ts`, `index.ts`, `queue/{hold-groups,list,schedules,schedule-tick,supervisor}.ts` — 타입·SDK·목록 상태·그룹 전달·감독자 취소.
  - `apps/cli/src/commands/{queue-list,schedules-list}.ts`, `apps/cli/src/doctor/store.ts` — 목록 표시와 Store 계약 반영.
  - `packages/core/src/testing/fakes/store.ts`, `testing/contracts/{work,schedule,session}-store.ts` — fake 동작과 PG 공유 계약. 이번 패치는 `ensureSession`의 일감 저장 실패를 세션·checkout 쓰기 전에 전파한다.
  - `packages/core/test/{work-hold,supervisor-cancel}.test.ts`, `apps/cli/test/work-hold.test.ts`, `apps/cli/test/supervisor-fixture.ts`, `packages/postgres/test/migrate.test.ts` 및 버전 기대값 관련 시험 — 보류·재개·실제 probe 취소·업그레이드 검증. 이번에는 공유 세션 계약에 실패 원자성·정상 재시도·기존 세션 보존 시험을 추가했다.
- 후속 리뷰 판정: 발견 1건, medium 1건을 patch로 수정했다(high 0, medium 1, low 0). 이연 0건, 기각 0건. 기존 리뷰 기록은 보존했다.
- 후속 리뷰 권고: `false`. 후속 회차에서 high 패치가 없으며 별도의 미검증 위험을 찾지 못했다.
- 검증: 지정 core 341개, PostgreSQL 432개, CLI 158개 시험 통과. 수정 세션의 세션 계약 시험도 fake·PG 각각 33개 통과했다. 패치 후 기본 `pnpm test`는 두 차례 각각 다른 PG 시험의 연결/실행 timeout으로 1개 실패·3,330개 통과했다. 설정 파일 변경 없이 `pnpm test --maxWorkers=2`로 build·typecheck와 125개 파일의 3,331개 시험이 모두 통과했다. `git diff --check`도 통과했다.
- 남은 한계: 기본 병렬 전체 시험에서 PG timeout이 재현되어 검증의 동시 실행 수를 줄였다. 기존 PostgreSQL query deprecation 경고가 남는다. 보류와 동시에 이미 시작된 감독 일감은 다음 취소 감시에서 끊기며 진행 중 core drain은 완료된다. 사람이 결정해야 할 사항은 없다.
