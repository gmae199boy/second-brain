---
title: 'Refactor sweep: epic 12의 1~10이 미룬 정리'
type: 'refactor'
ticket: '11'
created: '2026-10-29'
status: done
baseline_revision: 'ba6805496ba370bf54ecee0ad7802cf5fd18651c'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
closes_deferred: [DW-13, DW-14, DW-15, DW-20, DW-21]
---

<intent-contract>

## Intent

**Problem:** 12.1~12.10의 plan·리뷰가 남긴 정리 가운데 기능 추가 없이 닫을 수 있는 것이 넷 있다. (1) DW-20: 시작 때 이전 incarnation 회수(`reconcile`)가 `died`를 `settleSupervisedAttempt`로 정산하면 `attempts`를 보지 않고 바로 다시 열어, 데몬이 죽을 때마다 같은 일감이 10회 상한(`MAX_WORK_ATTEMPTS`)과 `failures` 기록 없이 계속 다시 돈다(12.5 deferred). (2) DW-21: 자식을 띄운 뒤 `execute()` 안에서 예외가 나면(예: `options.log`가 던지는 `problem()`, inspector·Store 호출) 살아 있는 자식이 정리·정산 없이 실행 집합에서 빠지고 슬롯이 돌아온다(12.7 deferred). (3) 감독자의 `checkSchema` 기본값 `{ core: 3 }`가 지금 core 스키마 10과 맞지 않는다(12.4 리뷰 defer). (4) `apps/cli/test/pg-client.ts`가 한 `pg.Client`에 query를 겹쳐 보내 전체 시험마다 pg deprecation 경고가 난다(12.7·12.9·12.10 남은 한계). 또 DW-13·DW-14·DW-15와 epic Notes의 Carry(재시도 주석)는 이미 12.2·12.5가 해결했으므로 닫기만 한다.

**Approach:** 넷을 일감 계약·명령 출력·스키마 변경 없이 고친다. 1·2는 감독자 안의 "자식을 잃은 시도의 정산"을 한 갈래로 모아, 회수와 실행 중 예외가 같은 규칙(그룹 정리 → `died`/`unknown` 정산, 10회째 `died`는 기록 후 닫기)을 따르게 한다. 범위 밖 항목은 Auto Run Result에 새 스토리 후보로 남긴다.

## Boundaries & Constraints

**Always:**
- 1: 회수 정산의 결과가 `died`이고, 그 일감의 `attempts`가 `MAX_WORK_ATTEMPTS` 이상이며, 취소 요청도 보류(`held`)도 없으면, `finishSupervisedWork`로 `outcome: 'died'`, 코드 `PROCESS_DIED`의 `failures` 행과 `lastError`를 남기고 일감을 `failed`로 닫는다(후행은 기존 규칙대로 `dependency_failed`). 실행 중 10회째 `died`(`supervisor.ts:199-216`)와 같은 fingerprint 규칙(`stage = kind`, `input = targetKind:targetId`)을 쓴다. 그 밖(상한 미만, 취소 요청, 보류, `unknown`)은 지금과 같다: `settleSupervisedAttempt`가 바로 다시 열거나 `cancelled`·`unknown`으로 남긴다.
- 1: 회수에 필요한 대상 값을 위해 `OpenSupervisedAttempt`에 `targetKind`·`targetId`를 더하고, PG와 fake 둘 다 채운다. 다른 필드와 의미는 그대로다.
- 2: `problem()`은 `options.log`가 던지거나 거부해도 예외를 내지 않는다(기록 실패는 감독을 바꾸지 않는다).
- 2: 자식이 뜬 뒤 감독 중 어떤 예외가 나도 감독자는 (a) 그 자식 그룹을 `cleanProcessGroup`으로 정리하고(정리 자체가 던지면 `unknown`), (b) 그 시도를 1과 같은 규칙으로 정산하며(`died`면 상한 규칙 포함, `unknown`이면 token 유지), (c) 정산이 성공할 때까지 기존 `pendingSettlement` 재시도에 남겨 새 청구를 막는다. 데몬 종료 때도 그 자식은 기다려진다.
- 3: `SupervisorOptions.schemaVersions`를 필수로 하고 `?? { core: 3 }` 기본값을 없앤다. CLI(`apps/cli/src/daemon/supervisor.ts`)는 이미 `opened.expected`를 넘기므로 동작은 그대로다. 시험의 `runSupervisor` 호출은 쓰는 `memorySchemaStore` 버전과 같은 값을 명시한다.
- 4: `PgTestClient`는 한 연결에 query를 한 번에 하나씩 보낸다(내부 직렬 큐). `exec`·`prepare().all/get/run`·`close`의 시그니처와 결과는 그대로다.
- 고친 시험은 고치기 전의 결함을 잡는다: 1은 상한 분기를 빼면 실패하고, 2는 `problem()`의 보호나 예외 정리를 빼면 실패한다.
- 테스트는 PG에서 돈다(OrbStack의 `second-brain-test-postgres-1`이 켜져 있음).

**Never:**
- DW-16~DW-19(비밀 탐지기의 인용·줄바꿈·괄호·한국어 인용 정책), `unknown` 해제 수단, 그룹을 벗어난 자손 정리, 실행 중 DB URL 변경 반영은 만들지 않는다. 새 스토리 후보로 남긴다.
- 마이그레이션을 더하거나 고치지 않는다. `settleSupervisedAttempt`·`finishSupervisedWork`의 SQL 의미와 입력 타입을 바꾸지 않는다(1은 기존 verb의 조합이다). 실행 중 정산의 재시도 대기·코드·`retryable` 판정을 바꾸지 않는다.
- `brain queue`·`doctor`·데몬의 출력(JSON 필드·문구)을 바꾸지 않는다.
- `deferred-work.md`와 티켓 파일(`tickets.toml`, epic 파일)을 고치지 않는다. 닫기는 frontmatter `closes_deferred`로 오케스트레이터가 한다.
- 실제 Brain 홈·운영 compose 자원을 건드리지 않는다. 기존 리뷰가 기각한 항목을 다시 열지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 회수 10회째 사망 | 이전 incarnation의 열린 시도, 일감 `attempts = 10`, 그룹 없음 | 시도 `died`, 일감 `outcome = failed`·`completed_at` 설정, `failures`에 `PROCESS_DIED` 한 행, 다시 청구되지 않음 | 정산 실패면 기존처럼 회수 재시도 |
| 회수 상한 미만 | `attempts = 3`, 그룹 없음 | 지금과 같음: 시도 `died`, 일감 바로 다시 청구 가능, `failures` 없음 | 없음 |
| 회수 10회째 + 취소 요청 | `attempts = 10`, `cancel_requested_at` 있음 | 지금과 같음: `cancelled`로 닫힘, `failures` 없음 | 없음 |
| 회수 10회째 + 보류 | `attempts = 10`, 그룹 보류 | 지금과 같음: `died` 정산, 일감은 열린 채 해제를 기다림 | 없음 |
| 기록 함수 실패 | `options.log`가 매번 던짐, 자식이 progress→result | 일감 `succeeded`로 확정, 다음 일감도 청구됨 | 기록만 잃음 |
| 감독 중 예외 | 자식이 뜬 뒤 inspector 또는 Store 호출이 던짐 | 자식 그룹이 정리되고(fake 자식 종료), 시도가 `died` 또는 `unknown`으로 정산, 그 전에는 새 청구 없음 | 정리가 던지면 `unknown`, token 유지 |
| 전체 시험 | `pnpm test` | pg `client.query()` deprecation 경고 없음 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/queue/supervisor.ts:28-31` -- `problem()`; `options.log` 호출을 보호할 자리.
- `packages/core/src/queue/supervisor.ts:58-69` -- `reconcile()`; `inspectGroup`→`cleanup`→`settleSupervisedAttempt`. 상한 분기를 더할 자리(1). 실행 중 예외 정산도 같은 도우미를 쓴다(2).
- `packages/core/src/queue/supervisor.ts:86-189` -- 자식이 뜬 뒤 구간. `:102-108`(신원·기록), `:113-130`(취소·정체 감시 루프, 안의 `problem()`), `:185-188`(`finally`의 `Promise.all([poll, stall])`)이 예외가 새는 자리다. `:168-176`의 `unknown` 정산과 `:32-47` `retrySettlement`·`pendingSettlement` 관례를 재사용한다.
- `packages/core/src/queue/supervisor.ts:199-216` -- 실행 중 10회째 `died`의 `failure`·`lastError`·fingerprint 모양. 회수 쪽이 따른다.
- `packages/core/src/queue/supervisor.ts:231`, `:10-17` -- `schemaVersions` 기본값과 옵션 타입(3).
- `packages/core/src/queue/supervisor.ts:236-248` -- 청구 루프. `pendingSettlement`가 있으면 청구하지 않는 조건과 `.catch` — 바꾸지 않는다.
- `packages/core/src/queue/process-cleanup.ts` -- `inspectGroup`·`cleanProcessGroup`. 읽기 전용.
- `packages/core/src/ports/store.ts:549-558` -- `OpenSupervisedAttempt`(대상 값 추가), `SettleSupervisedAttemptInput`(그대로), `:527-533` `FinishSupervisedWorkInput`(그대로, `died`+`failure` 이미 허용).
- `packages/postgres/src/work.ts:307-320` -- `listOpenSupervisedAttempts`; `w.target_kind`·`w.target_id`를 select·매핑에 더한다. `:321-338` settle, `:437-470` finish는 그대로.
- `packages/core/src/testing/fakes/store.ts` -- fake의 `listOpenSupervisedAttempts`도 대상 값을 채운다. `:1331` settle, `:1370` finish는 그대로.
- `packages/core/src/testing/contracts/work-store.ts` -- 공유 Store 계약; 열린 시도 목록이 대상 값을 돌려준다는 단언을 더한다(PG·fake 공통).
- `packages/core/test/supervisor-cancel.test.ts:159-175` -- 회수 시험 틀(`settles prior incarnation as %s`). 10회째 회수·상한 미만·취소·보류 시험을 여기 더한다.
- `packages/core/test/supervisor-stall.test.ts:74` -- 실행 중 10회째 `died` 시험; 회수 시험의 단언 모양을 따른다.
- `packages/core/test/supervisor*.test.ts`, `apps/cli/test/process-group.test.ts` -- `runSupervisor`를 `schemaVersions` 없이 부르는 곳(3). `memorySchemaStore({ version: 3 })`에 맞춰 `{ core: 3 }`을 명시한다.
- `packages/core/src/testing/fakes/process.ts` -- fake launcher·inspector. 예외 주입은 시험 안에서 메서드를 덮어 한다.
- `apps/cli/test/pg-client.ts:10-23` -- `PgTestClient`; 직렬 큐를 둘 자리(4). 쓰는 시험 파일은 고치지 않는다.
- 이미 해결된 항목의 근거(읽기 전용): DW-13 `supervisor.ts:122-130`과 `supervisor-stall.test.ts:27`; DW-14 `supervisor.ts:207`과 `supervisor-stall.test.ts:136`; DW-15 `work.ts` `claimSupervisedWork`의 `current_attempt_token is null` 조건과 `supervisor-cancel.test.ts:159`; Carry `packages/core/src/domain/work-item.ts:95-103`(이미 "the eighth is 128 seconds").

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `packages/postgres/src/work.ts`, `packages/core/src/testing/fakes/store.ts`, `packages/core/src/testing/contracts/work-store.ts` -- `OpenSupervisedAttempt.targetKind/targetId`와 PG·fake 채우기, 계약 단언 -- 1의 fingerprint 입력.
- [x] `packages/core/src/queue/supervisor.ts` -- 자식을 잃은 시도의 정산 도우미(상한 분기 포함)를 `reconcile`과 실행 중 예외 경로가 함께 쓰게 하고, `problem()` 보호, `schemaVersions` 필수화 -- DW-20·DW-21·12.4 defer.
- [x] `packages/core/test/supervisor-cancel.test.ts` -- 매트릭스의 회수 네 행 -- DW-20.
- [x] `packages/core/test/supervisor*.test.ts` 중 알맞은 파일 -- 기록 함수가 던지는 경우, 자식이 뜬 뒤 inspector·Store가 던지는 경우(fake 자식 종료, 정산, 그 사이 청구 없음) -- DW-21.
- [x] `packages/core/test/*.test.ts`, `apps/cli/test/process-group.test.ts` -- `runSupervisor` 호출에 `schemaVersions` 명시 -- 3.
- [x] `apps/cli/test/pg-client.ts` -- query 직렬 큐 -- 4.

**Acceptance Criteria:**
- Given 이전 incarnation이 남긴 열린 시도(그룹 없음)와 PG 시험 DB의 `attempts = 10`인 `process_probe` 일감, when 새 감독자가 시작하면, then 그 일감은 `failed`로 닫히고 `failures`에 `PROCESS_DIED` 행이 하나 생기며 이후 청구에서 다시 나오지 않는다(PG Store로 도는 시험 하나 이상).
- Given `schemaVersions` 없이 `runSupervisor`를 부르는 코드, when `pnpm typecheck`를 돌리면, then 타입 오류가 난다(`@ts-expect-error` 한 줄로 확인).
- Given 정리 뒤 코드, when `pnpm test`(build·typecheck·vitest, PG 포함)를 돌리면, then 모두 통과하고 출력에 `Calling client.query() when the client is already executing a query`가 없다.

## Implementation Notes

- `lostSettlement`을 회수와 실행 중 예외 경로에서 공유한다. 예외 진입 즉시 `pendingSettlement`를 설치하고 정리 Promise를 공유해 정리 대기·정산 재시도 중 새 청구를 차단한다.
- `schemaVersions` 필수 호출은 `@ts-expect-error`로 확인하고, `PgTestClient`는 연결별 큐로 query와 close를 직렬화한다.
- 리뷰 patch(2026-10-29): 예외 경로의 정산은 재시도마다 열린 시도를 다시 읽어 `lostSettlement`를 새로 만든다. 그래서 첫 정산 실패 뒤 생긴 보류·취소 요청이 다음 재시도에 반영된다. 그룹 정리(`recovery`)는 한 번만 하고 재시도가 공유한다.

## Plan Change Log

## Review Triage Log

- medium / patch — `packages/core/src/queue/supervisor.ts`: 예외 정리 전 `pendingSettlement`가 없어 다른 자식 종료 시 정리·정산 전에 새 청구가 가능했다. 청구 루프의 유일한 차단 조건과 정리 대기 순서를 확인했다. 예외 진입 즉시 정산 대기를 등록하고 복수 자식 회귀 시험으로 검증한다.
- 위 행은 구현 세션(codex)이 스스로 돌린 자체 점검 기록이다(계획의 상태·리뷰 칸과 Auto Run Result 초안도 그 세션이 썼고, 상태·리뷰 칸은 오케스트레이터가 되돌렸다). 오케스트레이터의 리뷰 회차가 아니며, 아래 회차가 정식 리뷰다.

### 2026-10-29 — Review pass
- verdicts: 2 findings — high 0, medium 0, low 2, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `packages/core/src/queue/supervisor.ts:221-231`: 임대 갱신이 던진 순간 취소 감시가 `listOpenSupervisedAttempts()`를 기다리는 중이면, 안쪽 `finally`의 `stopWatching()`이 그 조회를 기다리는 동안 바깥 `catch`의 `pendingSettlement` 등록이 늦어져 다른 자식이 끝나면 새 청구가 들어올 수 있다 — 실제다. 다만 그 동안 예외 난 자식의 task는 아직 `running`에 있어 용량(2)은 넘지 않고, 정상 경로의 그룹 정리도 같은 방식으로 슬롯을 쥔 채 기다린다. 창은 진행 중 Store 조회 한 번 길이이고, 계약상 결과를 돌려주는 `renewSupervisedLease`가 던지면서 다른 자식이 바로 그때 끝나야 만난다. 고치려면 감시 실패 시점에 별도 차단 상태를 더해야 하므로(분기·상태 추가) 기각한다.
  - `[low]` `[patch]` `packages/core/src/queue/supervisor.ts:241-250`: 예외 경로의 정산이 처음 읽은 `held`·`cancelRequested`로 만든 함수를 캐시해, 첫 시도가 `DB_UNAVAILABLE`로 실패한 뒤 그룹이 보류되면 재시도가 보류된 10회째 일감을 `PROCESS_DIED`와 함께 `failed`로 닫는다 — PG `finishSupervisedWork`는 취소 요청만 다시 보고 보류는 보지 않음을 확인했다(`packages/postgres/src/work.ts:437-470`). 드물지만 고침이 캐시 삭제라 patch: 구현 세션이 재시도마다 열린 시도를 다시 읽어 `lostSettlement`를 새로 만들게 했고(정리 `recovery`는 공유 유지), 첫 정산 실패 → 보류 → 재시도에서 일감이 열린 채 `failures`가 없는 회귀 시험을 더했다(수정 전 실패 확인).

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `packages/core/src/queue/supervisor.ts:74-80`: 이전 incarnation 그룹 정리 도중 보류가 완료되어도 처음 읽은 `held` 값으로 10회째 일감을 실패 처리한다 — `holdWorkGroup`은 별도 표에 보류를 저장하며 `finishSupervisedWork`는 보류를 재확인하지 않으므로 재현 가능하다. 기존 리뷰의 실행 중 예외 재시도 경로와 위치·진입점이 다르다. 정리 후 열린 시도를 다시 읽어 최신 보류·취소 상태로 정산하도록 최소 수정했다. 정리 중 보류를 확정하는 회귀 시험의 수정 전 실패와 수정 후 통과를 구현 세션이 확인했다.

## Design Notes

- 정리 목록을 정한 근거(2026-10-29 착수): 10개 plan의 `deferred`, Review Triage Log의 defer 행, Auto Run Result의 남은 위험, `deferred-work.md`의 epic 12 항목(DW-13~DW-21), epic Notes의 Carry를 모았다. DW-13·14·15와 Carry는 현재 코드와 시험이 해결을 보여 코드 변경 없이 닫는다. DW-16~19는 비밀 탐지 정책을 새로 정해야 하는 기능 변경이고 epic 12 이전 코드의 한계라 "정리만" 범위를 넘는다. 12.2의 `unknown` 해제 수단 등은 밀려난 기능이다.
- pg 경고는 `NODE_OPTIONS=--trace-deprecation pnpm vitest run`으로 출처를 확인했다: `apps/cli/test/pg-client.ts:19` 하나뿐이고, 제품 코드(postgres 프로젝트 19파일)에서는 나지 않는다. 기준 시점 전체 시험은 125파일 3331개 통과.
- 1을 Store가 아니라 감독자에서 하는 이유: 상한은 실행 중 정산에서도 감독자가 판정한다(`supervisor.ts:207`). 같은 판정을 Store 안에 두면 두 곳이 갈라진다. 기존 `finishSupervisedWork`가 `died`+`failure`를 이미 받으므로 SQL은 그대로다.
- 보류 중 10회째 회수를 닫지 않는 이유: 보류는 "켤 때까지 멈춤"이다(E12-11). 해제 뒤 다음 청구가 11번째가 되어 실행 중 상한 규칙이 기록한다.
- 2의 정리 결과가 `unknown`이면 token을 남겨 다시 청구하지 않는다. 감독자가 자식 상태를 모를 때 다시 돌리지 않는 기존 규칙(E12-3)과 같다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 오류 없음
- `pnpm vitest run --project core supervisor` -- expected: 통과
- `pnpm vitest run --project postgres work-store` -- expected: 통과
- `pnpm test 2>&1 | grep -c 'already executing a query'` -- expected: `0`, 그리고 `pnpm test` 자체 통과

## Auto Run Result

상태: `built` 유지. 이번 실행은 기존 구현의 후속 리뷰이며 티켓·계획 상태를 변경하지 않았다. `tickets.py mark`는 실행하지 않았다. 기존 deferred-work 원장 항목과 `closes_deferred`는 변경하지 않았으며 완료 판정과 원장 반영은 오케스트레이터에 맡긴다. 사람의 결정이 필요한 차단 사항은 없다.

**구현 요약:** 기준 커밋 `ba6805496ba370bf54ecee0ad7802cf5fd18651c` 이후의 기존 정리 구현(회수 상한, 실행 중 예외 정리·정산, 기록 함수 보호, 필수 스키마 버전, PG 시험 query 직렬화)을 후속 리뷰했다. 회수 과정에서 프로세스 그룹 정리 중 변경된 보류 상태를 놓치는 경합을 수정했다.

**이번 변경 파일:**
- `packages/core/src/queue/supervisor.ts` — 회수 그룹 정리 후 열린 시도를 다시 읽어 최신 보류·취소 상태로 정산한다. 재조회가 실패하면 회수를 재시도하고, 이미 정산된 token은 건너뛴다.
- `packages/core/test/supervisor-cancel.test.ts` — 10회째 회수의 그룹 정리 도중 보류가 완료되면 일감이 열린 채로 남고 실패 기록·재청구가 없는지 검증한다.
- 이 계획 — 후속 리뷰 판정과 최종 검증 결과를 기록했다. 진입 시 제거되어 있던 이전 Auto Run Result 대신 이번 실행 결과를 썼다.

**리뷰 결과:** 새 읽기 전용 codex 세션 `01a185ca-88a1-7761-807d-2dbebb5bcef5`의 Quick 지적 1건을 직접 확인해 medium / patch로 판정했다. 기존 구현 세션 `01a185b6-8dd0-7921-b0b0-f703723d858c`를 재개해 최소 수정과 회귀 시험을 적용했다. 이번 회차 patch: high 0, medium 1, low 0. defer 0, 기각 0. 이전 리뷰의 기각 항목은 다시 열지 않았다.

**후속 리뷰 권고:** `false`. 후속 회차에 high patch가 없고, 수정 경로의 회귀 시험과 전체 검증이 통과했다.

**검증:**
- 수정 전 전체 `pnpm test` 통과: 125파일 3346개.
- 회귀 시험은 수정 전 실패를 구현 세션이 확인했다.
- 수정 후 전체 `pnpm test` 통과: build·typecheck·PG 포함 125파일 3347개. `already executing a query` 경고 0회.
- 수정 후 `pnpm vitest run --project core supervisor` 통과: 4파일 130개.
- 수정 후 `pnpm vitest run --project postgres work-store` 통과: 1파일 157개.

**남은 위험:** 이전 리뷰에서 기각한 임대 갱신 예외와 감시 조회 사이의 짧은 청구 구간은 기존 판단을 유지한다. 이번 수정은 그룹 정리 뒤 관측한 상태를 반영하며 Store의 트랜잭션 계약이나 마이그레이션을 바꾸지 않는다. 기존 계획의 범위 밖 기능과 deferred-work 항목은 오케스트레이터가 다룬다.
