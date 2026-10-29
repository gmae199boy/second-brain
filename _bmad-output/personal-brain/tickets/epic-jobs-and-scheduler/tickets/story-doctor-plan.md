---
title: '상태 구분: 정체·사망·오류·취소가 다른 결과로 남고 doctor에 보인다'
type: 'feature'
ticket: '5'
created: '2026-10-29'
status: done
baseline_revision: '49d0adadbb036752dc8f82604e974a991f729e86'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-abi-v1-fixture-ts-plan.md'
warnings: [oversized]
deferred:
  - summary: >-
      이전 incarnation 회수 정산(`reconcile` → `settleSupervisedAttempt`의 `died`)에는 10회 상한이 없어, 데몬이 죽을 때마다 같은 일감이 `failures`에 남지 않고 계속 다시 청구될 수 있다.
    evidence: |-
      `packages/core/src/queue/supervisor.ts` `reconcile()`은 `settleSupervisedAttempt({ outcome: 'died' })`를 부르고, PG·fake 모두 `next_attempt_at = now`로 바로 다시 열며 `attempts`를 보지 않는다. 이 동작은 12.2부터 있었고 이번 변경(plan Never·Design Notes)이 그대로 두었다. 이번 변경은 실행 중 정산(`finishSupervisedWork`)에만 AD-21 10회 상한을 더했다. 회수 경로에도 `MAX_WORK_ATTEMPTS`에서 기록 후 닫기를 적용하려면 settle 입력이나 reconcile 분기를 바꿔야 한다.
    location: >-
      packages/core/src/queue/supervisor.ts reconcile(); packages/postgres/src/work.ts settleSupervisedAttempt
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 일감 행의 `outcome` 칸(0003)은 취소와 감독 성공만 채우고, core drain은 성공·영구 실패 모두 `completed_at`만 채운다. 감독자는 정체를 판정하지 않고, 결과 없이 죽은 자식과 오류를 구분하지 않으며, 모든 `failed`를 `retryDelayMs`로 끝없이 다시 시도하고 `failures`에 남기지 않는다. doctor는 정체·사망·불명을 보이지 않는다(E12-6, AD-21·33).

**Approach:** Core가 감독 attempt의 결과(`succeeded`·`failed`·`stalled`·`died`)를 정하고, `classifyWorkFailure`(AD-21)로 일감 처리(완료·재시도·기록 후 닫기)를 정해 Store에 넘긴다. 감독자에 종류별 정체 창 타이머를 더하고, core drain의 완료·기록 경로가 `outcome`을 채운다. `0006`이 닫힌 행의 `outcome`을 DB로 강제하고, doctor에 `work-stalled`·`work-died`·`work-unknown`·`work-last-error` 네 항목을 더한다.

## Boundaries & Constraints

**Always:**
- 일감 결과: core drain `completeWork` → `outcome='succeeded'`. `recordFailure`의 `closeWork` → `outcome='failed'`. 감독 성공 → `succeeded`, 감독 기록 후 닫기 → `failed`, 취소 → `cancelled`(기존). `dependency_failed`는 12.6 몫으로 쓰지 않는다.
- `0006_work_outcome_closed.sql`: `brain.work_items`에 `check (completed_at is null or outcome is not null) not valid` 제약을 더한다(옛 닫힌 행은 채우지 않는다). `CORE_SCHEMA_VERSION = 6`. 0001~0005는 고치지 않는다. 버전 고정 시험들(12.4가 4→5로 바꾼 곳)을 `grep -rn`으로 찾아 5→6, 불일치 값 6→7, `migrate.test.ts` 목록에 `0006`.
- 진행과 heartbeat: `progress`·`result`·`error` 이벤트가 진행이다. `heartbeat`는 임대만 갱신하고(지금처럼 60초 throttle) `last_progress_at`과 정체 시계를 바꾸지 않는다. `RenewSupervisedLeaseInput.progressAt`은 `Date | null`이고, null이면 `last_progress_at`을 그대로 둔다(PG·fake).
- 정체 창: Core 상수 `SUPERVISOR_STALL_WINDOW_MS = { default: 900_000, model: 1_500_000 }`. 종류 등록부(`work-item.ts`, 이름 규칙이 아니라 표)에 모델을 부르는지 여부를 두고 `workStallWindowMs(kind)`가 창을 고른다. 지금 등록된 모델 종류는 없다(`process_probe`는 default). `runSupervisor` 선택 옵션 `stallWindowMs?: (kind: string) => number`(기본 `workStallWindowMs`)로 시험이 모델 창을 고른다.
- 정체 판정: 마지막 진행(없으면 자식 시작) 뒤 창이 지나도록 진행이 없으면 감독자가 기존 `stop` 경로로 그룹을 정리(`cleanProcessGroup`: SIGTERM → 유예 → SIGKILL → reap)한다. 정리 결과가 `unknown`이면 기존 불명 정산을 따른다. 그 밖에는 attempt `stalled`.
- 사망 판정: 최종 이벤트 없이 signal로 끝났고(ABI 판정 코드 `ABI_EXIT_FAILED`이면서 `exit.signal !== null`) 감독자가 멈추게 한 것(취소·정체·종료·프로토콜 위반)이 아니면 attempt `died`. 최종 이벤트 없이 0이 아닌 exit code로 끝난 것은 지금처럼 `failed` `ABI_EXIT_FAILED`다.
- 우선순위(기존 규칙 확장): 데몬 종료(abort) → `cancelled` 정산(기존). 취소 요청이 있으면 Store가 `cancelled`로 닫는다(기존). 정상 result + exit 0은 취소·정체 경합에서도 `succeeded`. 그 밖에 정체로 멈췄으면 `stalled`, 위 사망 조건이면 `died`, 나머지는 ABI 판정.
- 일감 처리(AD-21, Core가 정한다): attempt가 `failed`면 판정의 `code`·`retryable`로, `stalled`·`died`는 `retryable: true`(코드 `PROCESS_STALLED`·`PROCESS_DIED`)로 `classifyWorkFailure(…, item.attempts, workKindPolicy(kind), now)`를 부른다. `retry` → `next_attempt_at`·`last_error`, 일감 열림. `record` → 같은 트랜잭션에서 `failures` upsert(stage = kind, fingerprint = `failureFingerprint({stage, input: targetKind:targetId, code})`, harness·session null)와 일감 닫기(`completed_at`, `outcome='failed'`, `last_error`). 취소 요청이 있으면 기록하지 않고 `cancelled`로 닫는다. 기록이 DB에 안 들어가면 지금처럼 `pendingSettlement`가 다시 시도한다(spool 없음).
- 새 코드 `PROCESS_STALLED`·`PROCESS_DIED`: `codes.ts` `CODES`에 exit 1, `retryable: true`, 한국어 meaning·hint. README 오류 코드 표도 맞춘다(교차 시험). attempt의 `error_code`는 `failed`에만 남는다(0005 check 유지). 이 두 코드는 `failures.code`와 `last_error` 문장에만 쓴다.
- doctor(읽기 전용, 새 Store 읽기 verb 하나를 `DoctorReadStore`에 더함): 열린 일감(`completed_at is null`)의 가장 최근 attempt 결과가 `stalled`인 것 → `work-stalled`, `died` → `work-died`, 현재 attempt가 `unknown`인 것 → `work-unknown`, 열린 일감의 가장 최근 `failed` attempt → `work-last-error`. 각 항목은 0건/없음이면 `ok`, 있으면 `warn`(코드 없음, `failures` 항목과 같은 이유)이고 detail은 건수와 가장 최근 하나(kind, 일감 id, 시각, `work-last-error`는 `error_code`·retryable·`last_error`). DB 확인 실패와 선행 검사 실패 때는 두 skip 목록에 네 id를 더해 `skip`과 이유를 낸다. 읽기 실패는 `fail`과 그 코드.

**Never:**
- ABI 코덱 판정, `runs.json`·schema·ABI README의 판정 표는 바꾸지 않는다(`died`는 감독자 해석이다).
- 이전 incarnation 회수 정산(`reconcile`, `settleSupervisedAttempt`의 `died` 즉시 재시도·`unknown`), 취소 경로, 0004 판정 함수는 바꾸지 않는다.
- 옛 닫힌 행의 `outcome`을 추정해 채우지 않는다. 새 의존을 더하지 않는다. `queue list`·토큰 doctor 항목(12.9)은 만들지 않는다. 일감 의존(12.6)은 만들지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| heartbeat만 | probe가 heartbeat만, 15분 경과 | 그룹 정리, attempt `stalled`, 일감 열림·`next_attempt_at = now + 15분`, 다시 청구되어 attempt 2개 | — |
| 진행 중 | 같은 15분 동안 1분마다 progress | 정리되지 않음, attempt 열림 | — |
| 모델 창 | `stallWindowMs` = model, heartbeat만 | 15분엔 그대로, 25분에 `stalled` | — |
| 사망 | progress 뒤 외부 SIGKILL로 끝남 | attempt `died`, 일감 재시도 예약 | — |
| 최종 없는 exit≠0 | exit 2, 최종 없음 | attempt `failed` `ABI_EXIT_FAILED`(재시도) | — |
| 영구 오류 | error(`GARMIN_AUTH`, false) | attempt `failed`, `failures` 1행, 일감 `completed_at`·`outcome='failed'` | — |
| 일시 오류 10번째 | error(retryable true), `attempts` 10 | 기록 후 닫기 `failed` | — |
| 정체 10번째 | heartbeat만, `attempts` 10 | attempt `stalled`, `failures`에 `PROCESS_STALLED`, `outcome='failed'` | — |
| 정체와 result 경합 | 정리 중 result + exit 0 | `succeeded` | — |
| 정체 정리 불명 | 정리 뒤 그룹 확인 불가 | attempt `unknown`, 다시 청구 안 됨 | — |
| core 성공 | drain handler ok | `outcome='succeeded'` | — |
| core 영구 실패 | handler `retryable:false` | `failures` 1행, `outcome='failed'` | — |
| 닫기 강제 | `completed_at`만 넣는 직접 SQL update | DB가 check 위반으로 거부 | — |
| doctor | stalled·died·unknown 각 1건, failed attempt 1건 | 네 항목 각각 `warn`과 해당 일감 | — |
| doctor DB 불가 | health 실패 | 네 항목 `skip`, 이유 `db` | — |

</intent-contract>

## Code Map

- `packages/core/src/queue/supervisor.ts:58-174` `execute` -- 판정 뒤 Core 처리 결정. 정체 타이머는 `poll`과 같은 모양의 루프(`timer.sleep(deadline - now, watch.signal)`)로 두고, `read`가 진행 이벤트마다 `lastProgress`를 옮긴다. 지금 `for (const _event of progress)`는 모든 이벤트로 갱신한다 — 이벤트 type을 보고 heartbeat는 `progressAt: null`로 넘긴다. `stopped` 옆에 `stalled` 표시. `checkSchema(... { core: 3 })` 기본값은 건드리지 않는다(12.4 보류).
- `packages/core/src/queue/drain.ts:146` `classifyWorkFailure`, `:377` `record` -- 감독 처리에 재사용(fingerprint·`failureText`). drain 자체 로직은 그대로, Store 쪽 완료·기록이 `outcome`을 채운다.
- `packages/core/src/domain/work-item.ts:129-160` -- 종류 등록부(실행 분류 옆에 모델 호출 여부), `SUPERVISOR_STALL_WINDOW_MS`, `workStallWindowMs`. 지금 `workExecutionClass`는 `kind === 'process_probe'` 비교 — 같은 표에서 읽게 바꿔도 된다(동작 불변).
- `packages/core/src/ports/store.ts:511-535,668-670` -- `RenewSupervisedLeaseInput.progressAt: Date | null`. `FinishSupervisedWorkInput.outcome`에 `stalled`·`died`, 선택 `failure`(기록 후 닫기: failure id·stage·fingerprint·code·message·occurredAt). 새 읽기 verb(예: `readWorkAttemptHealth`)와 결과 타입. `DoctorReadStore`(doctor.ts:99)에 더한다.
- `packages/postgres/src/work.ts:247-311,356-405` -- `renewSupervisedLease`(null이면 `last_progress_at` 유지), `finishSupervisedWork`(outcome 넷, `failure`가 있으면 같은 트랜잭션에서 `recordFailure`와 같은 upsert 후 `outcome='failed'`로 닫기, 취소 요청이 이기면 기록 없음), `completeWork`·`recordFailure` closeWork가 `outcome` 설정, 새 읽기 verb(`work_attempts`·`work_items` join, `distinct on (work_item_id) … order by started_at desc, token desc`).
- `packages/core/src/testing/fakes/store.ts:1144-1320` -- 같은 의미. `packages/core/src/testing/contracts/work-store.ts` -- 계약 case: 완료·기록의 `outcome`, finish의 stalled·died·record, heartbeat 갱신이 `lastProgressAt` 유지, 읽기 verb.
- `packages/postgres/migrations/0006_work_outcome_closed.sql`(새), `packages/postgres/src/migrate.ts` -- 버전 6.
- `packages/core/src/doctor/doctor.ts:150-180` -- 네 항목, 두 skip 목록. `apps/cli/src/doctor/store.ts` `failedConfigStore` -- 새 verb도 `DB_UNAVAILABLE`. CLI doctor 출력·시험의 항목 목록(`grep -rn "'transcripts'" apps/cli`)과 README doctor 설명이 있으면 맞춘다.
- `packages/core/src/codes.ts` `CODES`, `README.md` 오류 코드 표 -- 두 코드.
- `packages/core/src/testing/fakes/process.ts` -- 시험 재사용: `push`, `exit(null,'SIGKILL')`, `ignoreTerm`. `manualTime().advance`가 sleep을 깨운다. `packages/core/test/supervisor.test.ts:13-27` `kit`이 기준 모양.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/work-item.ts`, `codes.ts`, `README.md` -- 등록부·정체 상수·두 코드.
- [x] `packages/core/src/ports/store.ts`, fakes `store.ts`, contracts `work-store.ts` -- port 변경, fake, 계약 case.
- [x] `packages/postgres/migrations/0006_work_outcome_closed.sql`, `migrate.ts`, `work.ts`, 버전 고정 시험들 -- 제약·쓰기·읽기 verb.
- [x] `packages/core/src/queue/supervisor.ts` -- 정체 타이머, heartbeat 분리, 사망 해석, AD-21 처리.
- [x] `packages/core/src/doctor/doctor.ts`, `apps/cli/src/doctor/store.ts`, CLI doctor 조립·시험 -- 네 항목.
- [x] `packages/core/test/supervisor-stall.test.ts`(새, `manualTime`·fake launcher·memory store) -- 행렬의 감독자 행 전부: `heartbeat only stalls after 15 minutes and is claimed again`(attempt 2개), `progress every minute is not stalled`, `model window is 25 minutes`, `signal death without a final event is died`, `nonzero exit without a final event stays failed`, `permanent worker error is recorded and closed failed`, `tenth retryable failure is recorded`, `tenth stall is recorded as PROCESS_STALLED`, `result and exit zero win a stall race`, `unclear stall cleanup stays unknown`, heartbeat가 `lastProgressAt`을 옮기지 않음. 기존 `supervisor*.test.ts`의 재시도 기대(예: 시작 실패 `now+1000`)는 새 분류로 맞춘다.
- [x] `packages/core/test/queue-drain.test.ts` -- `core drain success and permanent failure leave different outcomes`.
- [x] `packages/core/test/doctor.test.ts` -- 네 항목의 ok·warn·skip(DB 불가·선행 실패)·fail(읽기 실패).
- [x] `packages/postgres/test/work-store.test.ts` -- PG에서 0006 제약이 `completed_at`만 넣는 update를 거부, 감독 기록 후 닫기가 `failures` 행과 `outcome='failed'`를 한 트랜잭션에 남김, 읽기 verb가 stalled·died·unknown·last error를 구분.
- [x] `apps/cli/test/` 실제 Node 자식 시험 하나(기존 `process-group.test.ts`의 실제 자식 감독자 실행 모양) -- 자식을 밖에서 SIGKILL하면 attempt `died`, 일감 재시도 예약.

**Acceptance Criteria:**
- Given PG에 stalled·died·unknown attempt를 가진 열린 일감 셋과 failed attempt 하나, when `brain doctor run --json`을 돌린다, then `work-stalled`·`work-died`·`work-unknown`·`work-last-error`가 각자 `warn`과 해당 일감을 보이고, DB를 멈추면 넷 모두 `skip`과 이유다.
- Given core drain이 성공 일감 하나와 `retryable:false` 실패 일감 하나를 처리한다, when PG에서 두 행을 읽는다, then `outcome`이 `succeeded`와 `failed`로 다르고 둘 다 `completed_at`이 있다.

## Implementation Notes

### 2026-10-29 — 감독 worker 오류의 release 제외 결정 반영

- 조율자 결정(2026-10-29, 추천으로 정함): 감독 경로는 `classifyWorkFailure`의 `release` 분기를 쓰지 않는다. attempt는 실제로 실행됐고 worker의 ABI `error`에는 `retryable`이 반드시 있으므로, 코드가 `DB_UNAVAILABLE`·`DB_LOCKED` 등 spool cause여도 그 값을 따른다. true는 종류의 `transientDelayMs`(기본 15분) 뒤 재시도하고 10번째 attempt에서 `failures`에 기록 후 `outcome='failed'`로 닫는다. false는 첫 실패에서 바로 기록 후 닫는다. core drain의 `release` 동작은 유지한다. 앞선 Review Triage Log와 검증 기록의 미결 정책은 이 결정과 구현으로 해소했다.
- `packages/core/src/queue/supervisor.ts`: 공용 `classifyWorkFailure` 호출을 감독 경로의 retry/record 판단으로 바꿨다. ABI의 `retryable`, 공용 `MAX_WORK_ATTEMPTS`, 종류의 `transientDelayMs`를 사용한다. 원래 worker 오류 코드는 attempt·last_error·failures 및 fingerprint에 그대로 남긴다. `packages/core/src/queue/drain.ts`와 공용 분류기는 변경하지 않았다.
- `packages/core/test/supervisor-stall.test.ts`: `worker DB_UNAVAILABLE with retryable true is retried, not released`와 retryable false 즉시 기록 case를 추가했다. `DB_UNAVAILABLE`·`DB_LOCKED`·`SCHEMA_MISMATCH` 각각에 대해 true의 15분 재시도·attempt 소비, false의 즉시 기록·닫기, true의 10번째 기록·닫기를 검증한다. 재시도 시각 전 재청구가 없고 닫힌 일감이 다시 청구되지 않는 것도 확인한다.
- 이 plan 파일의 `Implementation Notes`에만 이번 결정·변경·검증 결과를 추가했다. frontmatter `status`와 intent-contract는 변경하지 않았다. 커밋·배포·push는 하지 않았다.
- 검증: `pnpm exec vitest run --project core test/supervisor-stall.test.ts`의 30개 테스트 통과. 이후 `pnpm test`의 build·typecheck와 118개 파일·3068개 테스트 전부 통과(51.87초). `git diff --check` 통과. 이번 결정 범위의 미완료 항목은 없다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — quick review

- `[medium]` `[intent_gap]` `packages/core/src/queue/supervisor.ts`: worker의 `DB_UNAVAILABLE`·`DB_LOCKED`는 `classifyWorkFailure`에서 retryable·attempt 상한보다 먼저 `release`가 된다. 계획은 감독자의 retry·record 처리만 정의하므로 이 분기의 정책은 미결이다. 현재는 `nextAttemptAt` 없이 finish되어 now부터 다시 청구되고, 시도가 늘어도 기록 후 닫기에 도달하지 않는다. 공용 classifier·drain은 변경하지 않았다. 사용자에게 일시 오류 정책 적용 또는 현 동작 유지 선택을 요청했다. 답을 받기 전 완료 처리·커밋은 하지 않는다.
- `[medium]` `[patch]` `packages/core/src/queue/supervisor.ts`: exit 등으로 시작한 정리가 정체 창을 넘으면 watcher가 결과를 stalled로 덮었다. 최초 종료 원인을 고정하고, 정리 중 deadline을 지나는 nonzero exit·signal death·취소·프로토콜 실패 회귀 시험으로 수정했다.
- `[medium]` `[patch]` `packages/core/src/queue/supervisor.ts`: heartbeat가 공용 갱신 throttle을 선점하면 뒤따르는 progress의 last_progress_at이 계속 누락됐다. 진행 저장의 throttle을 분리하고 반복 heartbeat→progress 시험으로 수정했다.
- 조율자 후속 확인: 최초 종료 원인을 고정하더라도 취소 관측은 별도 stopped 표시로 유지한다. 프로토콜 실패·비정상 exit 정리 중 취소가 기존처럼 cancelled로 정산되는 회귀 시험 두 건을 더했다.
- 조율자 주: 위 quick review는 구현 세션(codex)이 커밋 전에 스스로 돌린 검토의 기록이다. 첫 행의 `intent_gap`은 조율자가 추천으로 정해(감독 경로는 `release` 없이 worker `retryable`을 따른다, Implementation Notes) 같은 세션이 구현했으므로 HALT 사유가 아니다. 이 워크플로의 thorough 리뷰는 아래 pass다.

### 2026-10-29 — Review pass
- verdicts: 22 findings — high 0, medium 2, low 9, false 11, maybe-false 0
- findings:
  - `[medium]` `[patch]` blind-hunter 1: 최종 `error`(`retryable:false`)나 `result` 뒤 종료하지 않은 자식이 정체 창을 넘기면 `stalled`·`retryable:true`로 덮여 영구 오류가 10번까지 재시도된다 — 확인: `supervisor.ts` outcome 식이 `terminationCause === 'stalled'`만 보고 `sawFinal`을 보지 않았다. 조치: `stalled`를 `!sawFinal`일 때만 붙이고, `final error then hang keeps the worker classification` 등 회귀 시험을 더했다.
  - `[false]` `[reject]` blind-hunter 2: stdout 소비가 임대 갱신을 기다려 DB 지연 중 progress를 못 읽고 정체로 오판 — 반박: daemon 연결은 `connect.ts`의 `lock_timeout`·`statement_timeout`·`query_timeout`·`connectionTimeoutMillis`로 한 호출이 수 초 안에 끝난다. 실패한 갱신도 곧 돌아오고 `lastProgress`는 이벤트를 처리할 때마다 옮겨지므로 15분 동안 한 await에 묶일 수 없다.
  - `[medium]` `[defer]` blind-hunter 3: 재시작 회수(`reconcile`)의 `died`는 10회 상한 없이 다시 청구된다 — 12.2부터 있던 동작이고 이번 변경이 만들지 않았다(이전에는 모든 감독 실패가 무한 재시도). frontmatter `deferred`에 등록했다.
  - `[low]` `[reject]` blind-hunter 4: `failures retry`에 `process_probe` stage 매핑이 없어 probe 실패를 건너뛴다 — 사실이나 `skipped`로 정직하게 보고되고, probe 실패는 일상에서 드물며 매핑 추가는 새 표면이다.
  - `[low]` `[reject]` blind-hunter 5: 감독 성공이 같은 대상의 기존 `failures`를 해결하지 않는다 — core도 해결은 각 단위(handler)의 몫이고(`completeWork`는 `table_cleanup`만), probe에는 해결할 실패가 일상에서 생기지 않는다. 새 분기가 필요해 기각.
  - `[false]` `[reject]` blind-hunter 6: `work-last-error`가 core 일감 `last_error`와 정체·사망 오류를 빠뜨려 문서와 다르다 — 반박: README(`README.md:1044`)와 plan이 `work-last-error`를 열린 일감의 가장 최근 `failed` attempt로 정했고 구현이 그대로다. 정체·사망은 각자 항목이 있다.
  - `[low]` `[reject]` blind-hunter 7: 최신 attempt를 `started_at`으로만 골라 시계가 뒤로 가면 현재 `unknown`을 놓칠 수 있다 — attempt는 재시도 대기(기본 15분) 간격으로 시작되어 그보다 큰 시계 역행이 있어야 하므로 일상에서 드물고, 정렬 키 추가는 두 저장소의 수정이다.
  - `[low]` `[reject]` blind-hunter 8: 스키마 점검 실패 뒤에도 work 조회가 돌아 같은 원인의 fail이 더 나온다 — 기존 `failures`·`untagged`·`transcripts` 점검도 같은 순서로 도는 기존 모양이고, `work_attempts`는 0002부터 있어 v2 이상에서는 생기지 않는다.
  - `[low]` `[reject]` blind-hunter 9: 조건에 맞는 모든 행을 앱으로 가져온다 — 열린 일감 중 최근 attempt가 문제인 것만이라 일상에서 작다. DB 집계로 바꾸는 이득이 작다.
  - `[low]` `[reject]` blind-hunter 10: 줄 중간에 SIGKILL되면 `ABI_LINE_TRUNCATED`라 `died`가 아니라 `failed`로 남는다 — 사실이나 Node 자식은 줄 단위로 쓰여 드물고, 그 판정도 `retryable:true`로 다시 시도된다. plan의 사망 정의(`ABI_EXIT_FAILED` + signal)를 넓히는 일이라 기각.
  - `[false]` `[reject]` edge-case-hunter 1: DB 갱신 지연·반복 실패 중 progress가 쌓여 정체로 오판 — blind-hunter 2와 같은 반박(호출마다 수 초 상한).
  - `[low]` `[reject]` edge-case-hunter 2: 최종 이벤트 없이 줄을 쓰던 자식의 SIGKILL이 `died`에서 빠진다 — blind-hunter 10과 같은 판단.
  - `[false]` `[reject]` edge-case-hunter 3: plan은 `classifyWorkFailure`를 쓴다고 했으나 구현은 자체 분류로 DB 오류도 시도를 소모한다 — 반박: 조율자 결정(Implementation Notes, 2026-10-29 추천으로 정함)이 감독 경로의 `release` 제외를 정했고 구현이 그것을 따른다. 고칠 대상이 plan 문구뿐이라 기각.
  - `[low]` `[patch]` verification-gap 1: 같은 상태의 열린 일감이 둘 이상일 때 건수·최근 항목 선택을 검증하는 시험이 없다 — 조치: PG 시험에 종료 시각이 다른 `stalled` 일감 둘을 만들어 `count === 2`와 늦은 일감이 `latest`임을 단언했다.
  - `[low]` `[patch]` verification-gap 2: 0006이 옛 닫힌 행의 `outcome`을 채우지 않는다는 것을 실제 v5 데이터로 확인하지 않는다 — 조치: `migrate.test.ts`에 v5 닫힌 행을 넣고 v6 업그레이드 뒤 `completed_at`·`outcome: null` 보존을 단언했다.
  - `[false]` `[reject]` intent-alignment 1: 모델 25분은 주입한 창으로만 시험되고 등록부에 모델 종류가 없다 — 이 에픽에 모델 일감 종류가 없다(epic 18 몫). `workStallWindowMs`는 등록부의 `callsModel`로 창을 고르고, 25분 타이머 동작은 시험이 확인한다. 잘못 고르는 경로가 없다.
  - `[false]` `[reject]` intent-alignment 2: "결과 없이 사라지면"을 signal 사망으로 좁혔다 — plan Design Notes의 Decision(추천으로 정함)이고 exit code 종료는 `ABI_EXIT_FAILED`로 남아 다시 시도된다. 결함 주장이 아니다.
  - `[false]` `[reject]` intent-alignment 3: doctor가 열린 일감의 최신 attempt만 본다 — plan Decision이고, 닫힌 실패는 `failures` 항목이 보인다. blind-hunter 6과 같은 반박.
  - `[false]` `[reject]` intent-alignment 4: 실행부터 doctor 출력까지 한 시험으로 잇지 않는다 — 감독자 시험이 저장 결과를, PG·CLI `doctor run --json` 시험이 같은 저장 상태의 표시를 확인한다. 한 시험으로 이으라는 요구는 없다.
  - `[false]` `[reject]` intent-alignment 5: 건강 점검 통과 뒤 읽기 실패는 `skip`이 아니라 `fail`이다 — "DB를 읽을 수 없으면 skip"은 `db` 점검 실패 때 네 항목이 `skip`과 이유를 내는 것으로 지켜진다. 그 뒤의 개별 읽기 오류를 `fail`로 내는 것은 기존 `failures` 항목과 같은 규칙이다.
  - `[false]` `[reject]` intent-alignment 6: 감독 경로가 `release`를 쓰지 않는다 — edge-case-hunter 3과 같은 반박(조율자 결정).
  - `[false]` `[reject]` intent-alignment 7: 0006이 `not valid`라 옛 행을 채우지 않고 `dependency_failed` 생성 경로가 없다 — 옛 행은 성공·실패를 알 수 없어 채우지 않는 것이 plan Decision이고, `dependency_failed`는 12.6 몫이다.

- 네 렌즈가 모두 돌아온 뒤 판정했다. intent_gap·bad_plan은 없다. 패치 세 건은 같은 구현 세션(`01a184d3-548f-7773-b415-61f2ff7b0d8c`)이 적용했고, 그 뒤 `pnpm test` 118파일·3,072개 통과, `git diff --check` 통과.

### 2026-10-29 — Review pass (후속 thorough)
- verdicts: 22 findings — high 0, medium 1, low 10, false 11, maybe-false 0
- findings:
  - `[low]` `[reject]` blind-hunter 1: `process_probe` 실패의 `failures retry` 매핑 없음 — carried: 이전 blind-hunter 4와 같은 위치·주장이다. probe 실패는 드물고 매핑 추가는 새 표면이므로 기존 기각 판정을 유지한다.
  - `[low]` `[reject]` blind-hunter 2: 감독 성공이 기존 실패를 해결하지 않음 — carried: 이전 blind-hunter 5와 같은 위치·주장이다. 해결은 handler의 몫이고 probe에 새 해결 분기를 더하는 이득이 작다는 기존 판정을 유지한다.
  - `[false]` `[reject]` blind-hunter 3: 임대 갱신 대기가 진행 소비를 막아 정체로 오판 — carried: 이전 blind-hunter 2와 같은 위치·주장이다. 이번 보고서는 마감 직전 수 초 지연을 예로 들었지만, 동일 주장에 대한 기존 판정·경로를 유지하라는 후속 검토 규칙에 따라 재검증·재패치하지 않았다.
  - `[low]` `[reject]` blind-hunter 4: memory fake의 동시 동일 토큰 정산이 중복 실패를 기록할 수 있음 — `finishSupervisedWork`가 토큰 확인 뒤 `await this.recordFailure`를 호출하므로 동시 호출이면 중복 기록 가능하다. 현재 감독자는 단일 `pendingSettlement`를 직렬로 호출하고 실제 PG는 행 잠금으로 보호한다. 개발용 fake에만 드문 중복 호출이며 직렬화·새 상태를 더하는 변경이 필요해 기각한다.
  - `[false]` `[reject]` blind-hunter 5: 새 attempt 시작 뒤 `work-last-error`가 사라짐 — carried: 이전 blind-hunter 6·intent-alignment 3과 같은 위치·주장이다. 열린 일감의 최신 attempt를 표시한다는 기존 결정과 일치하며 PG 시험도 재청구 뒤 제외를 단언한다.
  - `[low]` `[reject]` blind-hunter 6: doctor가 문제 행 전부를 받아 집계함 — carried: 이전 blind-hunter 9와 같은 위치·주장이다. 열린 문제 일감 수가 작고 DB 집계로 바꾸는 이득이 작다는 기존 판정을 유지한다.
  - `[low]` `[reject]` blind-hunter 7: 시스템 시각 보정이 정체 창을 움직임 — `lastProgress`와 판정 모두 `clock.now()`를 사용하므로 큰 시각 보정이면 가능하다. 정상 시계에서 창은 맞고 큰 보정은 일상적이지 않다. 단조 시계 port·timer 계약 추가가 필요한 변경이므로 기각한다.
  - `[low]` `[patch]` blind-hunter 8: README의 release·spool 설명에 감독 경로 구분이 없음 — core drain 설명 뒤 감독 worker의 retryable·10회 상한·pendingSettlement 및 heartbeat 제외·15분/25분 창을 명시했다.
  - `[false]` `[reject]` blind-hunter 9: 계획의 계약·구현 기록·이전 검증 문장이 충돌함 — `Implementation Notes`에 이후 조율자 결정과 적용 결과가 명시되어 이전 검증의 미결 기록을 대체한다. 최종 이벤트 보존도 이전 Review Triage Log의 패치 기록에 있다. 변경 요구가 계획 수정뿐인 항목은 검토 규칙상 기각한다.
  - `[low]` `[patch]` blind-hunter 10: 10번째 사망의 최종 기록 시험 없음 — attempts=10의 signal 사망에서 attempt `died`, 일감 `failed`·완료 시각, `PROCESS_DIED` 실패 및 재청구 차단을 확인하는 시험을 추가했다.
  - `[false]` `[reject]` edge-case-hunter 1: heartbeat 갱신 대기 중 progress가 정체를 막지 못함 — carried: 이전 edge-case-hunter 1·blind-hunter 2와 같은 위치·주장이므로 기존 판정·경로를 유지한다. 이번 마감 직전 예시도 재패치하지 않았다.
  - `[low]` `[reject]` edge-case-hunter 2: 잘못된 `stallWindowMs`의 NaN·Infinity가 감시를 무력화함 — 현재 production은 검증된 `workStallWindowMs` 상수를 쓰며 옵션은 시험용이다. 잘못된 사용자 설정 경로는 없고 개발자가 잘못 주입할 때만 발생하므로 새 검증 분기 추가는 기각한다.
  - `[false]` `[reject]` edge-case-hunter 3: 공용 classifier 대신 감독 분류를 사용함 — carried: 이전 edge-case-hunter 3·intent-alignment 6과 같은 주장이다. 감독 worker는 `release` 없이 ABI retryable을 따른다는 조율자 결정이 이미 적용되었다.
  - `[low]` `[patch]` verification-gap 1: 감독 실패 upsert 충돌 분기 검증 없음 — 서로 다른 감독 일감을 같은 실패 키로 종료하고 id·최초 시각 보존, 횟수·최근 시각·메시지 갱신 및 해결 표시 초기화를 확인하는 PG 시험을 추가했다. 렌즈의 사전 검증 근거를 수용했다.
  - `[low]` `[patch]` verification-gap 2: 늦게 온 최종 이벤트의 정체 기한 연장 검증 없음 — 14분의 result/error 뒤 15분 무신호와 16분 정상 종료의 원래 판정을 확인하는 manualTime 시험을 추가했다. 렌즈의 사전 검증 근거를 수용했다.
  - `[false]` `[reject]` intent-alignment 1: 모델 25분 시험이 실제 종류 선택을 거치지 않음 — carried: 이전 intent-alignment 1과 같다. 현재 모델 종류는 없으며 epic 18이 등록한다. 이번 표면은 등록부 정책과 주입한 25분 타이머다.
  - `[false]` `[reject]` intent-alignment 2: 모든 무결과 종료가 아니라 signal·ABI 조건만 `died`임 — carried: 이전 intent-alignment 2 및 blind-hunter 10의 해석이다. Design Notes의 조율자 결정과 ABI 판정을 유지한다.
  - `[medium]` `[defer]` intent-alignment 3: 재시작 회수의 `died`는 10회 상한이 없음 — carried: 이전 blind-hunter 3과 같은 위치·주장이다. 기존 plan `deferred`와 ledger `DW-20`의 소유권을 보존했고 항목을 수정·재개·중복 추가하지 않았다.
  - `[false]` `[reject]` intent-alignment 4: doctor는 열린 일감의 최신 attempt만 표시함 — carried: 이전 intent-alignment 3과 같다. 현재 문제를 표시하고 닫힌 실패는 `failures`에 남기는 기존 결정을 따른다.
  - `[false]` `[reject]` intent-alignment 5: 건강 점검 뒤 조회 실패는 `skip` 대신 `fail`임 — carried: 이전 intent-alignment 5와 같다. 선행 DB 실패의 skip과 개별 조회 실패의 fail을 나누는 기존 doctor 계약이며 시험이 확인한다.
  - `[false]` `[reject]` intent-alignment 6: 옛 닫힌 행 보존·새 `dependency_failed` 생성 없음 — carried: 이전 intent-alignment 7과 같다. 옛 결과는 추정하지 않고 의존 전파는 12.6 소유라는 기존 결정을 유지한다.
  - `[false]` `[reject]` intent-alignment 7: 감독 실행과 PG·CLI doctor 표시가 분리된 시험임 — carried: 이전 intent-alignment 4와 같다. 티켓이 단일 관통 시험을 요구하지 않으며 실행 저장·PG 읽기·CLI JSON 표시를 각각 관찰한다.

- 네 렌즈의 보고서를 모두 받은 뒤 판정했다. 기존 판정은 후속 검토의 carried 규칙으로 보존했다. 새 intent_gap·bad_plan은 없고, 새 패치는 문서 한 건과 시험 세 건이다. 기존 ledger 항목과 plan `status`는 변경하지 않았다.

## Design Notes

- Decision(2026-10-29, 추천으로 정함): "결과 없이 죽은 자식"은 최종 이벤트 없이 **signal로** 끝난 경우다. exit code로 끝난 자식은 스스로 실패를 알린 것이라 `failed` `ABI_EXIT_FAILED`로 둔다. ABI 판정 표(epic 13 Python과 공유)를 바꾸지 않고 감독자 해석으로 둔다.
- Decision(2026-10-29, 추천으로 정함): 정체·사망·일시 오류는 AD-21의 `retryable: true` 경로(종류의 `transientDelayMs`, 기본 15분)로 다시 시도하고, 10번째 attempt에서 `failures`에 남긴다. 기록 코드는 `PROCESS_STALLED`·`PROCESS_DIED`다. 이전 incarnation 회수(12.2)의 `died` 즉시 재시도는 그대로 둔다(데몬 재시작 복구는 일감 탓이 아니다).
- Decision(2026-10-29, 추천으로 정함): heartbeat는 임대를 갱신하되 진행이 아니다. 정체 창은 `last_progress_at`(없으면 시작)부터 잰다.
- Decision(2026-10-29, 추천으로 정함): doctor는 열린 일감만 본다. 닫힌 실패는 이미 `failures` 항목에 있다. 네 항목 모두 `warn`이고 코드를 붙이지 않는다.
- Decision(2026-10-29, 추천으로 정함): 0006 제약은 `not valid`로 새 쓰기만 강제한다. 옛 닫힌 행은 성공·실패를 알 수 없어(`completeWork`가 `last_error`를 지우지 않는다) 채우지 않는다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·전체 vitest(PG 포함) 통과.
- `pnpm exec vitest run --project core test/supervisor-stall.test.ts test/queue-drain.test.ts test/doctor.test.ts` -- expected: 새 행렬 시험 통과.
- `pnpm exec vitest run --project postgres test/work-store.test.ts` -- expected: 0006 제약·기록 후 닫기·읽기 verb 통과.
- `git diff --check` -- expected: 출력 없음.


**구현·검증 결과 (2026-10-29):**
- 종류 등록부·기본/모델 정체 창, heartbeat 분리, 감독자 stalled/died 해석과 AD-21 retry/record, 원자적인 실패 upsert·닫기, core 완료 outcome, 0006 NOT VALID 제약과 schema version 6, doctor 네 항목 및 CLI JSON 표시를 구현했다. 0001~0005·ABI 판정 fixture/schema·이전 incarnation 회수·공용 drain 분류는 변경하지 않았다.
- 최종 `pnpm test` 통과: build·typecheck와 118개 파일·3059개 테스트(52.11초). 마지막 코드 수정 전 지정 core 3파일·62개 및 postgres work-store 73개도 직접 실행·통과했다. 마지막 수정 뒤 supervisor 4파일·90개와 전체 시험을 다시 실행했다. `git diff --check` 통과.
- 행렬 감사: supervisor-stall 시험이 heartbeat만 15분 뒤 정체·재청구, 분당 진행 유지, 모델 25분 창, 외부 signal 사망, 비정상 exit, 영구 오류·10번째 오류/정체, result 경합, unknown 유지, heartbeat의 진행 시각 보존을 모두 확인한다. queue-drain 및 PG work-store가 성공/영구 실패 outcome을 확인하고, PG work-store가 SQLSTATE 23514·트랜잭션 rollback·취소 우선·읽기 구분을 확인한다. core doctor와 CLI doctor-run이 네 warn·DB/선행 실패 skip·읽기 fail을 확인한다. process-group은 실제 Node 자식 외부 SIGKILL을 확인한다. 모두 최종 전체 실행에서 통과했다.
- quick review의 경합/진행 저장 두 결함과 후속 취소 회귀는 수정했다. 미결은 위 Review Triage Log의 예약 DB worker 오류 코드 `release` 처리 정책 한 건이다. 계획을 유일한 기준으로 삼으라는 사용자 지시에 따라 새 정책을 임의로 추가하지 않았다. status는 in-review이며 완료 처리·커밋·배포·push는 하지 않았다.

## Auto Run Result

Status: built

- 이번 실행은 이미 `built`인 티켓 12.5의 후속 thorough 검토다. 기존 구현은 일감 결과·attempt 결과 분리, 기본 15분/모델 25분 정체 판정, heartbeat 진행 제외, 사망·오류 분류와 재시도/실패 기록, doctor 네 항목을 제공한다. 계획 frontmatter의 `status`는 시작 값 그대로이며 `tickets.py mark`는 실행하지 않았다. 티켓 완료 판정은 오케스트레이터가 한다.
- 네 렌즈의 지적 22건을 개별 판정했다: high 0, medium 1, low 10, false 11. 기존 판정과 동일한 주장은 carried 규칙으로 유지했다. 이번 패치 네 건은 모두 low다(README 설명 한 건, 10번째 사망 시험, 반복 감독 실패 upsert 시험, 늦은 최종 이벤트의 정체 기한 연장 시험). 기존 보류 한 건은 재등록·상태 변경 없이 유지했다. 기각 17건의 근거는 이번 Review Triage Log의 각 행에 기록했다. 새로운 intent_gap·bad_plan은 없다.
- 이번 변경 파일: `README.md`는 core drain과 감독 worker의 재시도·정산 정책 및 정체 창을 구분한다. `packages/core/test/supervisor-stall.test.ts`는 10번째 사망의 실패 기록·재청구 차단과 늦은 result/error의 기한 연장을 검증한다. `packages/postgres/test/work-store.test.ts`는 같은 실패 키 충돌 시 id·최초 시각 보존과 횟수·최신 진단·해결 표시 초기화를 검증한다. 이 계획에는 검토 판정과 실행 결과를 추가했다. 기능 소스는 이번 후속 검토에서 바꾸지 않았다.
- 구현 세션 `01a184d3-548f-7773-b415-61f2ff7b0d8c`를 재개해 최소 패치를 적용했다. 해당 세션의 관련 시험은 2파일·110개 통과했다. 이후 조율자 검증에서 `pnpm test`의 build·typecheck와 118파일·3,076개 시험이 모두 통과했다(52.01초). 계획의 지정 명령인 core 세 파일 83개 시험, PostgreSQL work-store 75개 시험도 각각 통과했다. `git diff --check`도 통과했다.
- 후속 리뷰 권고: `false`. 이번 후속 pass의 패치는 high 0, medium 0, low 4건이며 새 high 패치가 없다.
- 남은 위험: 이전 incarnation 회수의 10회 상한은 기존 보류 상태 그대로다. 실제 모델 종류가 아직 없어 25분은 정책·주입 타이머 시험으로 확인했다. 임대 갱신 await와 진행 소비의 정체 경계 지적은 이전 판정과 같은 주장으로 carried 처리했으며 새 경계 재현 시험은 추가하지 않았다. 개발용 fake의 동일 토큰 동시 정산과 큰 시스템 시각 보정은 이번 low 기각 항목에 남아 있다.
- 시작 시 작업 트리에는 오케스트레이터의 ledger `DW-20` 추가와 이 계획의 이전 실행 결과 삭제가 이미 있었다. ledger 파일은 시작 시 바이트와 동일함을 확인했다. 워크플로의 최종 커밋에는 검토된 대기 변경을 포함하되, 기존 ledger 항목의 내용·상태·해결 정보를 수정하지 않았다. 기존 plan `deferred`도 그대로 보존했다. 배포·push는 하지 않았다.
