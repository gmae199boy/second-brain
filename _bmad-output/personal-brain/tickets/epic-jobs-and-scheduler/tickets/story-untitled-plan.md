---
title: '취소와 종료 확인: 취소한 그룹은 손자까지 정리되고, 확인할 수 없는 일감은 다시 돌지 않는다'
type: 'feature'
ticket: '2'
created: '2026-10-29'
status: done
baseline_revision: 24e43de6fbac4c37f8d75e35ba5ee06b0db64240
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
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-tracer-probe-600-plan.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 12.1의 감독자는 취소 수단이 없고, 데몬 종료 때 그룹을 바로 SIGKILL한 뒤 attempt를 열어 둔다. 자식의 PID·OS 시작 신원을 남기지 않아, 데몬이 죽은 뒤 남은 그룹을 안전하게 정리할 수 없고 임대가 만료되면 살아 있는 자식이 있는 일감이 다시 청구된다(12.1 deferred 3).

**Approach:** `brain queue cancel <id>`가 DB에 취소 요청을 남기고(돌고 있지 않은 일감은 바로 `cancelled`로 닫는다), 감독자가 요청을 보면 그룹 SIGTERM → 유예 → SIGKILL → reap 뒤 결과를 확정한다. attempt에 incarnation·PID·PGID·OS 시작 신원을 기록하고, 감독자는 첫 청구 전에 이전 incarnation의 열린 attempt를 OS 조회로 대조해 정리·회수하거나 `unknown`으로 남긴다. supervised 청구는 현재 attempt가 없는 일감만 본다.

## Boundaries & Constraints

**Always:**
- OS 신원 = (부팅 시각 `sysctl -n kern.boottime`의 `sec`, PID, `LC_ALL=C ps -o lstart= -p <pid>`의 1초 단위 시작 시각). 그룹 구성원은 `LC_ALL=C ps -o pid=,pgid=,lstart= -g <pgid>`. 판정: 종료 코드 1 **그리고** stdout·stderr가 비어 있음 → `none`; 그 밖의 비0 종료·실행 실패(ENOENT 등)·읽을 수 없는 출력 → `unknown`. 신원 비교는 초 단위 같음.
- 그룹 대조 규칙(재시작 대조와 실행 중 정리 확인이 같이 쓴다): 기록한 부팅과 지금 부팅이 다르면 OS 조회 없이 `died`. 같은 부팅이면 `-g <pgid>` 조회: `none` → 끝남; `unknown` → `unknown`; 구성원 중 `pid == pgid`인 리더가 있으면 그 시작 시각이 기록과 같을 때만 우리 그룹(다르면 PID 재사용 — 어떤 신호도 보내지 않고 `died`); 리더 없이 구성원만 있으면 우리 그룹(살아 있는 그룹의 ID는 재사용되지 않는다, POSIX); 기록에 신원이 없는데 리더가 있으면 `unknown`.
- 정리 순서: 그룹 SIGTERM → 그룹이 빌 때까지 유예(`SUPERVISOR_CANCEL_GRACE_MS` = 5_000) → 남았으면 그룹 SIGKILL → 리더 reap(`exited` 대기, 실행 중인 자식일 때) → `SUPERVISOR_GROUP_CONFIRM_MS`(2_000) 안에 `-g` 조회가 `none`이 되면 확인, 아니면 `unknown`. 리더가 이미 reap되었는데 그룹 조회가 `unknown`이면 그 PGID에 신호를 보내지 않는다(번호 재사용 위험). EPERM 등 ESRCH가 아닌 신호 실패도 `unknown`.
- 취소 요청 확인은 실행 중 `SUPERVISOR_CANCEL_POLL_MS`(1_000)마다 DB 읽기로 한다(진행·갱신과 무관하게, 출력 없는 자식에도). 상수는 `packages/core/src/domain/work-item.ts`의 Core 상수이고, 데몬 seam으로만 시험에서 줄인다.
- attempt token CAS: 모든 새 쓰기 verb는 `id` + `current_attempt_token`이 맞을 때만 바꾸고 아니면 `lost`. 시각·token·incarnation은 호출자가 준다(AD-22). 자식을 기다리거나 신호 유예를 기다리는 동안 DB 트랜잭션을 잡지 않는다(AD-7).
- incarnation = 감독자 시작 때 만든 `claimedBy`(UUIDv7). 감독자는 대조가 한 번 끝나기 전에는 청구하지 않는다(실패하면 다음 poll에 다시).
- CLI는 PID를 직접 죽이지 않는다. `queue cancel`은 CommandSpec·명령 메타·SDK(`brain.queue.cancel`)가 1:1이고, 사용자 문장·로그는 한국어다.
- 0001·0002는 고치지 않는다. 새 파일 `0003_*.sql`, `CORE_SCHEMA_VERSION = 3`.

**Never:**
- 정체 판정·결과 없는 사망의 재시도 정책·10회 상한·doctor 항목(5), DB 함수·trigger 쓰기 거부(3), ABI 오류 이벤트·stderr 정책(4), `queue list`·예약 명령(9), 의존·직렬화 키·용량(6·7), `unknown`을 푸는 수단은 만들지 않는다.
- core drain 청구 방식(`claimed_by` CAS)과 core 일감 결과 칸 채우기(5의 몫)는 바꾸지 않는다. 출하 probe에 시험용 동작(TERM 무시 등)을 넣지 않는다. 시험 seam을 환경 변수로 읽지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 대기 일감 취소 | 열린 일감, 현재 attempt 없음(core든 supervised든, core는 drain이 청구 중이어도) | 한 트랜잭션에 `completed_at = now`, `outcome = 'cancelled'`, `cancel_requested_at = now`, 청구 칸 비움. 상태 `cancelled` | 청구 중이던 core drain의 확정은 `lost` |
| 실행 중 취소 | supervised, 현재 attempt 있음 | `cancel_requested_at` 기록(이미 있으면 유지), 상태 `requested`. 감독자가 정리 뒤 attempt `cancelled`, 일감 `outcome = 'cancelled'`·`completed_at`, token 비움 | 정리 확인 불가면 attempt `unknown`, 일감은 token·청구 유지 |
| 닫힌·없는 일감 | `completed_at` 있음 / 없는 id / UUID 아님 | 상태 `already_closed`(무변경) / `WORK_NOT_FOUND` exit 1 / `USAGE` exit 2 | — |
| 요청과 결과 경합 | 요청 뒤 자식이 result·exit 0 | `succeeded`로 확정(일감 `outcome = 'succeeded'`) | 요청 뒤 `failed`면 재시도하지 않고 일감 `cancelled`로 닫음 |
| 데몬 종료 | 자식 실행 중 abort | 같은 정리 뒤 attempt `cancelled`, 일감은 돌려줌(`attempts - 1`, 청구·token 비움, `next_attempt_at` 유지) | 요청이 있었으면 일감 `cancelled`로 닫음. DB 실패면 다음 시작 대조가 처리 |
| 재시작 대조 | 열린 현재 attempt(`outcome is null`) | 우리 그룹이 살아 있음 → 정리 후 `died`·다시 대기(`next_attempt_at = now`); 사라짐·다른 부팅·PID 없음 → `died`; PID 재사용 → 신호 없이 `died`; 조회 실패·정리 확인 불가 → `unknown` | 취소 요청이 있던 일감은 `died` 대신 attempt `cancelled`·일감 `cancelled` |
| `unknown` | attempt `unknown`(finished), 일감 token·청구 유지 | supervised 청구 대상 아님(만료 뒤에도), 다시 대조하지 않음 | 취소 요청은 기록만(`requested`) |
| 신원 기록 실패 | spawn 직후 `ps -p` 실패·none | pid·pgid만 기록, 신원 null. 자식은 계속 감독 | 로그(상태 바뀔 때만) |

</intent-contract>

## Code Map

- `packages/core/src/queue/supervisor.ts` -- `runSupervisor`: 한 번에 한 건, abort면 SIGKILL 후 확정 없이 `return`(:52-75). 여기에 시작 대조, spawn 뒤 신원 기록, 취소 poll, 정리 순서, 종료 처리를 넣는다. `problem()` 상태 변화 로그 패턴 유지. 대조·정리 로직은 같은 폴더 새 파일로 나눠도 된다.
- `packages/core/src/ports/process.ts` -- `ProcessHandle.signalGroup`(ESRCH 무시). 새 `ProcessInspector` port: `bootTime()`, `startedAt(pid)`, `groupMembers(pgid)` → `found | none | unknown`, `signalGroup(pgid, sig)` → `sent | none | failed`. index export.
- `packages/core/src/testing/fakes/process.ts` -- 가짜 launcher(`signalGroup`이 바로 exit). 신호를 무시하는 프로세스·남는 그룹을 흉내낼 수 있게 넓히고, 같은 폴더에 가짜 inspector(부팅·신원·구성원·실패를 시험이 정함).
- `packages/core/src/ports/store.ts:507-520,643-648` -- supervised 입력·결과 타입과 verb. `packages/postgres/src/work.ts:179-232` -- PG 구현(`withWrite`·`finish`·`instant`·`changesOf` 재사용), `claimCandidateQuery`는 core만이라 건드리지 않는다. `toWorkItem`(~:520).
- `packages/core/src/testing/fakes/store.ts`·`testing/contracts/work-store.ts:37-66` -- fake와 계약. 12.1의 "만료 뒤 token B 청구" case는 새 규칙(현재 token이 있으면 청구 안 됨)으로 다시 짠다: A를 `died`로 정리한 뒤 B 청구, A의 갱신·확정은 `lost`.
- `packages/postgres/migrations/0002_supervised_attempts.sql` -- 읽기 전용 원본(`work_attempts`, check `(finished_at is null) = (outcome is null)`, `work_attempt_claim`). `packages/postgres/src/migrate.ts` `CORE_SCHEMA_VERSION`. 버전·표·칸을 고정한 시험(`packages/core/test/schema.test.ts`, `packages/postgres/test/store.test.ts`·`schema.test.ts`·`migrate-files.test.ts`, cli의 버전 상수 사용처)은 3과 새 칸에 맞춘다.
- `packages/core/src/brain.ts:197-230,406-415` -- `BrainQueue`에 `cancel`. `packages/core/src/codes.ts:222`(`MESSAGE_NOT_FOUND` 모양)에 `WORK_NOT_FOUND`. `README.md` 오류 코드 표(:768, `apps/cli/test/readme-codes.test.ts`가 대조)와 명령 절(`## 밀린 일 처리`·`## 데몬`).
- `apps/cli/src/commands/queue-drain.ts`·`messages-redact.ts`(`arguments: ['<message>']`, `context.args[0]`) -- 명령 모양. 등록은 `apps/cli/src/commands/index.ts`. `apps/cli/test/command-meta.test.ts`가 메타를 검사한다.
- `apps/cli/src/runtime/process-group.ts` -- Node launcher(`detached: true`, pgid = pid). 옆에 Node `ProcessInspector`(`execFile`, `LC_ALL=C`, 명령 경로를 바꿀 수 있는 생성 함수). `lstart`는 `Thu Oct 29 05:05:23 2026`(한 자리 날은 공백 채움) 현지 시각, `kern.boottime`은 `{ sec = 1792884640, usec = … } …`.
- `apps/cli/src/daemon/supervisor.ts`·`run.ts:155,247` -- `DaemonSupervisorOptions`에 seam `inspector?`, `cancelGraceMs?`, `cancelPollMs?`, `groupConfirmMs?`, `probeWorker?: {command, args, env?}`(`process_probe`의 실행 파일만 바꾸고 ABI 환경 변수는 유지). 종료는 이미 finally에서 `supervisor.stop()`을 기다린다.
- `apps/cli/test/supervisor-fixture.ts`·`daemon-supervisor.test.ts`·`fixtures/process-worker.mjs`·`pg-home.ts`(`runPgCommand`) -- 격리 PG home·probe 넣기·attempt 읽기·실제 CLI 실행. 기존 `grandchild` 모드와 출력은 `process-group.test.ts`가 쓰므로 유지한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0003_supervised_cancel.sql`, `packages/postgres/src/migrate.ts` -- `work_items`에 `outcome text`(check 4값 `succeeded|failed|cancelled|dependency_failed`, check `outcome is null or completed_at is not null`)와 `cancel_requested_at timestamptz`. `work_attempts`에 `incarnation text`, `pid integer`, `pgid integer`, `os_boot_at timestamptz`, `os_started_at timestamptz`(모두 nullable, pid·pgid는 양수 check). 기존 데이터 정리: 일감의 현재 token이 아닌 열린 attempt는 `outcome = 'died'`, `finished_at = greatest(started_at, coalesce(renewed_at, started_at), coalesce(last_progress_at, started_at))`(`now()` 없이). 권한은 0002와 같은 방식. 버전 3 -- 12.1 deferred 3의 남은 행 정리.
- [x] `packages/core/src/domain/work-item.ts` -- 상수 셋, `WorkItem`에 `outcome`·`cancelRequestedAt`.
- [x] `packages/core/src/ports/store.ts` -- verb: `requestWorkCancel({id, now})` → `{ok, state: 'cancelled' | 'requested' | 'already_closed' | 'not_found'}`; `recordSupervisedProcess({id, attemptToken, pid, pgid, osBootAt|null, osStartedAt|null})` → done|lost; `listOpenSupervisedAttempts()` → 현재 token이고 `outcome is null`인 attempt(token, 일감 id·kind·attempts, incarnation, pid, pgid, 신원, `cancelRequested`); `settleSupervisedAttempt({id, attemptToken, now, outcome: 'cancelled' | 'died' | 'unknown'})` → done|lost(처분은 행렬대로: 요청 있음·비unknown → 일감 `cancelled`로 닫음, `died` → 다시 대기 `next_attempt_at = now`, `cancelled` 요청 없음 → 돌려줌 `attempts - 1`, `unknown` → attempt만 닫고 일감 token·청구 유지). 바뀌는 기존 것: `claimSupervisedWork`는 `current_attempt_token is null and cancel_requested_at is null` 조건과 attempt `incarnation = claimedBy`; `finishSupervisedWork`는 `succeeded`면 `outcome = 'succeeded'`, `failed`인데 요청이 있으면 일감 `cancelled`로 닫음.
- [x] `packages/postgres/src/work.ts`, `packages/core/src/testing/fakes/store.ts` -- 위 verb와 바뀐 조건을 같은 의미로. 한 verb = 한 `withWrite`, `for update`.
- [x] `packages/core/src/testing/contracts/work-store.ts` -- 계약 case: 취소 4상태와 core 청구 중 취소 뒤 `completeWork` `lost`; 현재 token 있는 일감은 만료 뒤에도 청구 안 됨; settle 처분 4가지와 옛 token `lost`; `recordSupervisedProcess` CAS; 열린 attempt 목록이 unknown·닫힌 것을 빼고 요청 여부를 실음; `finishSupervisedWork`의 outcome·요청 뒤 `failed`. 12.1 case 재작성.
- [x] `packages/core/src/ports/process.ts`, `packages/core/src/testing/fakes/process.ts`(+가짜 inspector), `packages/core/src/queue/supervisor.ts`(+대조 모듈) -- 위 Always의 대조·정리·신원 기록·취소 poll·종료 처리. `runSupervisor` 옵션에 `inspector`, `cancelGraceMs?`, `cancelPollMs?`, `groupConfirmMs?`. index·testing index export.
- [x] `packages/core/src/brain.ts`, `packages/core/src/codes.ts`, `README.md` -- `queue.cancel({id})` use case(UUID 형태 확인은 명령 preflight, 없으면 `WORK_NOT_FOUND`), 코드 표·README 표·명령 절.
- [x] `apps/cli/src/commands/queue-cancel.ts`, `commands/index.ts` -- `brain queue cancel <id>`: `writes: true`, `risk: 'write'`, data `{id, state}`(`cancelled|requested|already_closed`), 한국어 한 줄(요청이면 "감독자가 끝냅니다"류). UUID 아님 → `USAGE` exit 2.
- [x] `apps/cli/src/runtime/process-group.ts`(또는 옆 `process-inspector.ts`) -- Node inspector와 출력 해석기(시험 가능한 순수 함수로).
- [x] `apps/cli/src/daemon/supervisor.ts` -- seam 연결, 기본은 Node inspector·Core 상수.
- [x] `apps/cli/test/fixtures/process-worker.mjs`, `apps/cli/test/fixtures/daemon-host.mjs`, `apps/cli/test/supervisor-fixture.ts` -- fake worker에 `ignoreTerm`(리더·손자 둘 다 TERM 무시), `pidFile`(리더·손자 pid와 TERM 받음 표시를 파일로; stdout에는 ABI 줄만), `progressEveryMs` 모드를 더한다. `daemon-host.mjs`는 `dist`의 `runDaemon`을 seam과 함께 띄우는 별도 프로세스(감독자 SIGKILL 시험용). fixture에 attempt 행 직접 만들기(claim + 신원 기록, 가짜 신원 가능)와 pid 생존 확인·정리 도우미.
- [x] 시험 -- 아래 Verification의 파일. 단위(가짜 시간·fake store·가짜 프로세스·가짜 inspector): 취소 poll → TERM → 유예 → KILL 순서와 그룹이 TERM에 비면 KILL 없음, 결과 경합, 종료 처리, 대조 행렬 전 행(다른 부팅·none·unknown·리더 신원 같음/다름·리더 없는 구성원·신원 null·요청 있음), 대조 전 청구 없음. 출력 해석기 시험(빈 출력 exit 1 = none, stderr 있는 exit 1 = unknown, lstart 공백 채운 날). CLI 명령 시험(4상태·없는 id·UUID 아님).

**Acceptance Criteria:**
- Given 데몬이 TERM을 무시하는 fake worker와 그 손자를 `process_probe`로 돌린다(유예 seam 300ms), when `brain queue cancel <id>`를 실제 CLI로 실행한다, then 명령은 `requested`를 답하고, 몇 초 안에 일감 `outcome = 'cancelled'`·`completed_at`, attempt `cancelled`이며, 리더와 손자 PID가 모두 없고(둘 다 TERM을 받았다고 pid 파일에 적었다), 취소 요청부터 attempt `finished_at`까지가 유예 이상이다.
- Given 별도 프로세스(`daemon-host.mjs`)의 데몬이 손자를 둔 fake worker를 돌리다 그 프로세스가 SIGKILL되어 자식 그룹이 살아 있다, when 같은 home에서 데몬을 다시 띄운다, then 옛 리더·손자가 정리되어 없고, 옛 attempt는 `died`, 일감은 다시 청구되어 새 attempt가 생기며, 그 데몬을 멈추면 새 그룹도 정리되고 새 attempt는 `cancelled`, 일감은 `attempts`가 줄어든 채 열린 상태로 돌아온다.
- Given 열린 attempt의 pid·pgid가 지금 살아 있는 무관한 프로세스(detached 리더)이고 기록된 시작 시각이 그와 다르다, when 데몬을 띄운다, then 그 프로세스는 살아 있고 attempt는 `died`, 일감은 다시 대기다.
- Given 열린 attempt가 살아 있는 프로세스를 가리키고 데몬의 inspector가 없는 `ps` 경로를 쓴다, when 데몬을 띄워 poll이 여러 번 돈다, then attempt는 `unknown`, 일감은 현재 token을 유지하고 `attempts`가 그대로이며 새 attempt 행이 없고, 프로세스는 살아 있다.

## Implementation Notes

- `0003_supervised_cancel.sql`과 Core 스키마 버전 3을 추가했다. 취소 요청, OS 신원, incarnation, token CAS 정산을 fake와 PostgreSQL 양쪽에 구현했다.
- 감독자는 시작 대조 뒤에만 청구하며, 출력과 독립적으로 취소를 조회한다. 모든 종료 경로에서 그룹 정리를 확인한 뒤 결과를 확정한다.
- Node launcher는 리더의 `exit`와 파이프 EOF를 구분하고 `leaderExited`·`closeOutput()`을 제공한다. 즉시 출력된 ABI 줄을 버퍼에 보존하며, 상속된 파이프 대기를 제한한다.
- `brain queue cancel <id>`·SDK·명령 메타·한국어 메시지·README를 연결했다. 기존 0001·0002와 core drain의 청구 계약은 유지했다.

- 2026-10-29(오케스트레이터): 구현 세션이 커밋 `d36578607dea6acefa7e119e3b1a618d9663462a`를 남기면서 frontmatter를 `status: built`, `review: quick`, `lenses_ran: [quick]`으로 바꾸고 Review Triage Log에 자체 quick 검토를 적었다. 이 workflow step-04의 검토가 아니므로 frontmatter를 되돌리고 그 기록을 아래로 옮겼다. 코드는 그대로 둔다.
  - 구현 세션 자체 검토 기록(옮김):
    구현 세션 quick 검토

    - `[high]` `[patch]` `packages/core/src/queue/supervisor.ts`: 취소 poll 전에 리더가 종료하면 정리를 건너뛰고 `finishSupervisedWork`가 요청된 일감을 닫아 손자가 남는다. 종료가 먼저 관측되어도 결과 확정 전에 그룹 정리를 확인하도록 수정한다.
    - `[high]` `[patch]` `apps/cli/src/runtime/process-group.ts`, `packages/core/src/queue/process-cleanup.ts`: `child.close`는 파이프를 상속한 손자가 있으면 리더 reap보다 늦다. 실제 리더 종료와 출력 EOF를 구분해 reap 후 `unknown` 그룹 신호 금지와 종료 확인 시간 한도를 지키도록 수정한다.

    수정 검증:

    두 지적을 모두 수정했다. 취소 poll 전 리더 종료와 결과 확정 직전 취소 요청 회귀 시험, 실제 Node의 상속 파이프·그룹을 벗어난 손자·짧은 worker의 결과 버퍼 시험을 추가했다. 수정 diff의 독립 재검토는 추가 지적이 없었다. 새 보류 항목 없음.

- 2026-10-29(오케스트레이터): 행렬 감사에서 "신원 기록 실패" 행을 덮는 시험이 없어 구현 세션이 `packages/core/test/supervisor-cancel.test.ts`에 `startedAt` `unknown`·`none` 두 시험을 더했다(`3a54ae6`).
- 2026-10-29(오케스트레이터): 검토 patch(`53e8e4f`)로 감독자는 실패한 결과 확정·정산을 보관해 다음 회차에 다시 부르고, 그동안 청구하지 않는다. Design Notes의 "같은 incarnation에서 확정이 DB 실패로 남으면 다음 시작 대조가 회수한다"는 이제 데몬이 확정 재시도 전에 멈춘 경우에만 해당한다. `WORK_NOT_FOUND`가 `MESSAGE_NOT_FOUND`의 주석을 가로챈 위치도 같은 커밋에서 바로잡았다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 24 findings — high 0, medium 5, low 12, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind-hunter) `recordSupervisedProcess`가 DB 오류로 실패하거나 spawn 직후 기록 전에 데몬이 죽으면 PGID가 없어 재시작 대조가 `died`로 보고 살아 있는 자식과 중복 실행할 수 있다 — 실제 경로지만 기록 순간의 DB 실패와 자식이 끝나기 전 데몬 사망이 겹쳐야 하고, spawn과 기록 사이 창은 기록 위치를 바꾸지 않는 한 남는다. 고치려면 정리·정산 분기를 더해야 한다.
  - `[low]` `[patch]` (blind-hunter) `unknown` attempt는 현재 token을 유지하는데 token CAS verb가 attempt가 이미 닫혔는지 보지 않아, 같은 token의 뒤늦은 호출이 `unknown`을 덮고 일감을 풀 수 있다 — 지금 호출자는 없지만 한 줄 조건으로 고쳐진다. PG·fake의 `renewSupervisedLease`·`finishSupervisedWork`·`settleSupervisedAttempt`·`recordSupervisedProcess`가 닫힌 attempt의 token을 `lost`로 다루게 하고, 계약의 `unknown` 분기에 세 verb의 `lost` 단언을 더했다(`53e8e4f`).
  - `[low]` `[reject]` (blind-hunter) 다른 home의 데몬이 같은 DB를 쓰면 두 번째 감독자가 첫 번째의 실행 중 그룹을 정리한다 — home마다 자기 DB 컨테이너를 두는 구조라 일상에서 만나지 않고, 막으려면 DB 단위 감독자 잠금을 새로 만들어야 한다.
  - `[medium]` `[patch]` (blind-hunter) 결과 확정이 일시적 DB 오류로 실패하면 현재 token이 남고 대조가 다시 돌지 않아 데몬 재시작까지 일감이 멈춘다 — `packages/core/src/queue/supervisor.ts`가 실패한 확정·정산 호출을 그대로 보관해 다음 회차의 schema 확인 뒤, 청구 전에 다시 부르고, 남아 있는 동안 청구하지 않게 했다. 첫 확정이 실패하는 store로 다음 poll에 `succeeded`가 되고 그 사이 청구가 없음을 시험한다(`53e8e4f`).
  - `[low]` `[patch]` (blind-hunter) `ps`·`sysctl`의 `execFile`에 시간 제한이 없어 멈추면 대조·취소·종료가 무기한 기다린다 — 기본 5초·`SIGKILL` timeout(생성 옵션으로 바꿈)을 두어 시간 초과는 `unknown`이 되게 하고 `apps/cli/test/process-inspector.test.ts`에서 확인했다(`53e8e4f`).
  - `[low]` `[reject]` (blind-hunter) SIGKILL 뒤 `handle.exited`를 제한 없이 기다린 다음에 확인 시간이 시작된다 — SIGKILL된 리더의 exit 이벤트는 곧바로 오고, 늦어지는 경우는 커널의 끊을 수 없는 대기뿐이라 드물다. 고치려면 경합 타이머 분기를 더해야 한다.
  - `[false]` `[reject]` (blind-hunter) 시작 대조가 abort를 보지 않아 여러 그룹의 유예가 쌓인다 — 감독자는 한 번에 한 건만 청구하고 대조가 끝나야 청구하므로, 시작 때 열린 현재 attempt는 이전 incarnation의 많아야 한 건이다. 쌓일 여러 그룹이 없다.
  - `[low]` `[reject]` (blind-hunter) launcher가 stdout 줄을 상한 없이 버퍼에 쌓는다 — 소비자가 기다리는 구간은 신원 조회와 60초 간격 갱신뿐이고 출하 probe는 1초에 한 줄이다. 줄을 폭주시키는 worker에서만 생기며, backpressure를 넣으려면 pause·resume 구조가 필요하다. 너무 긴 줄·출력 정책은 스토리 4 범위다.
  - `[low]` `[reject]` (blind-hunter) 유예·확인 시간을 벽시계 `clock.now()`로 잰다 — 5초 유예 중의 시각 보정은 드물고 결과는 KILL이 조금 이르거나 늦는 정도다. 단조 시계 port를 새로 만들어야 고쳐진다(12.1의 갱신 간격도 같은 Clock을 쓴다).
  - `[medium]` `[patch]` (blind-hunter) 취소·결과 경합 계약 시험이 닫힘만 보아 잘못된 일감 결과를 저장해도 통과한다 — 계약 case가 일감을 다시 읽어 `outcome`(성공 경합 `succeeded`, 실패 경합 `cancelled`), `completedAt`, `currentAttemptToken = null`을 단언하게 했다. fake와 PG에서 돈다(`53e8e4f`).
  - `[low]` `[reject]` (edge-case-hunter) 신원 기록 실패 뒤 데몬이 죽으면 `died`로 보고 중복 실행한다 — blind-hunter 첫 지적과 같은 원인. 같은 이유로 reject.
  - `[medium]` `[patch]` (edge-case-hunter) 결과 확정의 일시적 실패로 데몬 재시작까지 일감이 멈춘다 — blind-hunter 넷째 지적과 같은 원인. 같은 수정으로 해결.
  - `[low]` `[patch]` (edge-case-hunter) `ps`·`sysctl`이 끝나지 않으면 무한 대기한다 — blind-hunter 다섯째 지적과 같은 원인. 같은 수정으로 해결.
  - `[low]` `[reject]` (edge-case-hunter) 상한 없는 stdout 버퍼 — blind-hunter 여덟째 지적과 같은 원인. 같은 이유로 reject.
  - `[low]` `[patch]` (edge-case-hunter) 취소 요청 뒤 `failed` 확정에서 PG는 `next_attempt_at`·`last_error`를 쓰는데 fake는 건너뛰어 fake 시험이 차이를 숨긴다 — fake가 PG와 같이 두 칸을 쓰게 했다(`53e8e4f`).
  - `[medium]` `[patch]` (verification-gap) PG에서 취소 요청 뒤 성공 확정의 일감 `outcome`을 확인하는 단언이 없다 — blind-hunter 열째 지적과 같은 원인. 같은 계약 보강이 PG에서도 돈다(`packages/postgres/test/work-store.test.ts`).
  - `[medium]` `[patch]` (verification-gap) 그룹은 보이는데 부팅 신원을 대조할 수 없을 때(현재 부팅 `unknown`, 기록된 `osBootAt` null) `unknown`을 유지하는 규칙에 시험이 없다 — `packages/core/test/supervisor-cancel.test.ts`에 리더 있음·리더 없음 두 모양으로 `unknown` 단언을 더했다(`53e8e4f`).
  - `[low]` `[reject]` (intent-alignment) 감독자가 취소를 보고 TERM을 보낸 뒤 자식이 `result`와 exit 0으로 끝나면 일감이 `cancelled`가 아니라 `succeeded`다 — TERM을 받아 결과를 내는 worker에서는 실제로 그렇다. 하지만 intent-contract 행렬 "요청과 결과 경합: 요청 뒤 자식이 result·exit 0 → `succeeded`"가 정한 동작이고, 바꾸려면 이 plan의 행렬을 고쳐야 한다.
  - `[false]` `[reject]` (intent-alignment) 데몬 종료 때 일감을 취소로 닫지 않고 돌려준다 — 의도는 "데몬 종료도 같은 정리를 한다"로 프로세스 정리 절차를 말하고, 사용자가 취소하지 않은 일감을 닫으라는 말이 없다. 코드는 같은 `cleanProcessGroup`을 쓰고 통합 시험이 새 그룹 정리를 확인한다.
  - `[false]` `[reject]` (intent-alignment) 손자의 reap을 직접 관찰하지 않는다 — 손자는 감독자의 자식이 아니어서 감독자가 wait할 수 없다(고아는 launchd가 거둔다). 감독자가 reap하는 것은 리더(`exited`)이고, 손자의 소멸은 `-g` 조회 `none`과 통합 시험의 ESRCH로 확인한다.
  - `[false]` `[reject]` (intent-alignment) 그룹을 벗어난 자손은 정리하지 않는다 — 의도가 그룹 구성원을 `ps -g <pgid>`로 본다고 범위를 PGID로 정했다.
  - `[false]` `[reject]` (intent-alignment) `unknown` 통합 시험의 관찰이 350ms이고 임대 만료 뒤 차단은 계약 시험에 있다 — 데몬 시험은 poll 100ms로 여러 회차 동안 새 attempt가 없음을 보고, 만료 뒤에도 청구되지 않음은 fake·PG 계약 case(`unknown blocks claim`, 만료 뒤 시각)가 확인한다.
  - `[false]` `[reject]` (intent-alignment) SIGKILL 순서는 fake 시험에서만 직접 확인한다 — 통합 시험의 리더·손자는 TERM을 무시하고(받았다고 pid 파일에 적음) 유예 뒤 둘 다 사라지므로 SIGKILL이 그들을 끝냈다.
  - `[false]` `[reject]` (intent-alignment) 기록된 `pid`를 따로 대조하지 않는다 — launcher가 `detached: true`로 띄워 리더 pid가 곧 pgid이고, 대조는 그 PGID의 리더(`pid == pgid`) 시작 시각을 본다. 의도의 신원 (부팅, PID, 시작 시각)을 그대로 쓴다.

### 2026-10-29 — 후속 Review pass
- verdicts: 24 findings — high 0, medium 4, low 13, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind-hunter) 신원 기록 실패 뒤 데몬 사망으로 중복 실행 가능 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 기록 실패와 데몬 사망이 겹치는 드문 경로이며 분기 추가가 필요하다.
  - `[low]` `[reject]` (blind-hunter) 성공 확인 뒤 abort가 오면 일감을 반환한다 — 데몬 종료는 요청 없는 일감을 반환하도록 행렬과 settleSupervisedAttempt가 정한다. 성공과 shutdown 우선순위를 바꾸라는 제안은 intent-contract 수정이므로 기각한다.
  - `[low]` `[reject]` (blind-hunter) SIGKILL 뒤 리더 reap의 무기한 대기 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 커널 대기에서만 발생하며 별도 타이머 분기가 필요하다.
  - `[low]` `[reject]` (blind-hunter) 개별 OS 조회 timeout이 누적되어 정리가 20초를 넘을 수 있다 — createProcessInspector의 5초 timeout은 조회별이다. 여러 조회가 연속 지연되는 경우 실제 가능하지만 일상적 ps/sysctl은 짧고 전체 예산 전달은 새 매개변수·분기가 필요하여 low로 기각한다. 계획의 최대 7초 주장은 엄밀한 상한이 아니다.
  - `[low]` `[reject]` (blind-hunter) 벽시계 보정으로 유예가 달라진다 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 짧은 유예 중 시각 보정은 드물고 단조 시계 port 추가가 필요하다.
  - `[low]` `[reject]` (blind-hunter) 다른 home이 같은 DB를 공유하면 정상 그룹을 정리한다 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. home별 DB 구조의 일상 밖 구성이며 DB 단위 잠금 추가가 필요하다.
  - `[low]` `[reject]` (blind-hunter) stdout 버퍼가 무제한이다 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 폭주 worker에서만 문제이고 backpressure 구조 추가가 필요하다.
  - `[low]` `[patch]` (blind-hunter) unknown에도 감독자가 끝낸다고 안내한다 — requestWorkCancel은 unknown token에도 requested를 반환하지만 listOpenSupervisedAttempts는 닫힌 attempt를 제외한다. 종료 보장을 제거한 요청 접수 문구·README 설명·CLI 텍스트 검증으로 직접 수정했다.
  - `[medium]` `[patch]` (blind-hunter) 취소·확정 계약 시험은 실제 PG 동시 실행을 덮지 않는다 — 순차 계약은 양쪽 행 잠금 순서의 회귀를 검증하지 못한다. 별도 PG 연결과 명시적 잠금 장벽으로 cancel/finish/settle 경합 결과를 단언하는 회귀 시험을 추가했다.
  - `[medium]` `[patch]` (blind-hunter) 취소 요청 뒤 shutdown의 닫힘을 검증하지 않는다 — 기존 shutdown 시험은 요청 없는 반환만 확인한다. 취소 poll 전 abort와 유예 중 abort에서 cancelled·token 해제·재청구 불가를 확인하는 시험을 추가했다.
  - `[low]` `[reject]` (edge-case-hunter) 신원 기록 실패 뒤 재시작 중복 실행 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. blind-hunter 첫 항목과 같다.
  - `[low]` `[reject]` (edge-case-hunter) SIGKILL 뒤 reap 시간 제한 누락 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 커널 대기 경합의 복잡도에 비해 일상 발생 가능성이 낮다.
  - `[low]` `[reject]` (edge-case-hunter) stdout 큐의 메모리 상한 누락 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 폭주 출력과 backpressure 구조 문제다.
  - `[medium]` `[patch]` (verification-gap) 잘못된 ABI 출력 뒤 살아 있는 자식의 정리 검증 누락 — 검증 렌즈가 확인한 공백이다. 기존 bad line 시험은 child.exit()를 직접 호출한다. 직접 종료 없이 감독자의 정리·failed·token 해제·재시도 시각을 단언하도록 보강했다.
  - `[medium]` `[patch]` (verification-gap) 시작 신원 누락과 실행 중 취소의 결합 검증 누락 — 검증 렌즈가 확인한 공백이다. 기존 unknown/none 시험은 정상 종료만 본다. 시작 신원이 없는 살아 있는 자식을 취소해 신호·종료·cancelled·token 해제를 검증했다.
  - `[low]` `[reject]` (intent-alignment) TERM 뒤 정상 결과가 취소보다 우선할 수 있다 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. 요청과 결과 경합 행렬이 succeeded를 정하며 바꾸려면 계획 수정이 필요하다.
  - `[false]` `[reject]` (intent-alignment) 실제 취소 명령의 검증 표면 차이 — daemon-supervisor-cancel.test.ts는 실제 dist/bin.js queue cancel과 PG 결과·프로세스 소멸을 관찰한다. 기대한 외부 표면에 대응하여 결함이 아니다.
  - `[false]` `[reject]` (intent-alignment) 통합 시험은 기본 5초 대신 300ms 유예를 주입한다 — carried: 기존 SIGKILL 증거 판정을 유지한다. TERM 무시 리더·손자의 수신 기록·유예 이상 경과·소멸과 fake 신호 순서가 같은 계약을 검증한다.
  - `[false]` `[reject]` (intent-alignment) 손자 직접 reap과 그룹 밖 자손 정리가 없다 — carried: 기존 손자 reap·PGID 범위 판정을 유지한다. 직접 자식은 exit로 reap하고 손자는 ESRCH로 소멸을 확인한다. 원문이 ps -g로 정한 그룹 범위와 일치한다.
  - `[false]` `[reject]` (intent-alignment) 재시작 시험이 운영 CLI를 두 번 띄우지는 않는다 — 실제 daemon-host를 SIGKILL하여 자식 생존을 확인하고 runDaemon을 다시 호출해 옛 그룹 소멸·died·새 attempt를 본다. 원문은 재시작 진입을 CLI 두 번으로 제한하지 않는다.
  - `[false]` `[reject]` (intent-alignment) 정상 종료는 내부 abort를 사용하고 일감을 반환한다 — carried: 기존 데몬 종료 처분 판정을 유지한다. 같은 cleanProcessGroup으로 정리하며 요청 없는 반환은 intent-contract가 정한다.
  - `[false]` `[reject]` (intent-alignment) PID 재사용은 가짜 신원으로 검증한다 — carried: 기존 pid 대조 판정을 유지한다. 원문이 가짜 신원을 허용하며 실제 detached 리더의 생존과 died를 확인한다.
  - `[false]` `[reject]` (intent-alignment) unknown의 임대 만료 후 차단이 별도 계약 시험에 있다 — carried: 기존 같은 주장의 false/reject를 유지한다. 실제 데몬의 여러 poll과 fake·PG의 미래 시각 청구 차단이 함께 재실행 금지를 입증한다.
  - `[low]` `[reject]` (intent-alignment) 신원 DB 기록 실패와 데몬 사망 결합의 보장 간극 — carried: 기존 같은 위치·주장의 low/reject를 유지한다. blind-hunter 첫 항목과 같은 드문 결합 경로다.

## Design Notes

- 일감 결과 칸 `outcome`을 이 스토리가 만든다: verify가 "일감 결과 `cancelled`"를 요구하기 때문이다. 이 스토리는 supervised 성공·취소만 채우고, core drain의 성공·영구 실패 채우기와 doctor는 스토리 5가 같은 칸을 넓힌다.
- 만료로 다시 청구하지 않는 이유(E12-1 "살아 있는 attempt의 일감은 경과 시간만으로 다시 청구되지 않는다"): 데몬 잠금으로 감독자는 하나이고, 이전 incarnation의 attempt는 시작 대조가 닫는다. 같은 incarnation에서 확정이 DB 실패로 남으면 다음 시작 대조가 회수한다.
- 리더가 없는 구성원을 우리 그룹으로 보는 근거: 구성원이 있는 그룹 ID는 새 PID로 주어지지 않는다. 재사용은 리더가 있을 때만 가능하므로 리더 신원만 대조하면 된다.
- 종료 시간: 정리(최대 5초 + 확인 2초)는 abort 즉시 drain 회차 마무리와 함께 진행되어 launchd 기본 `ExitTimeOut` 20초 안에 든다.
- 재실행 정리 절차: 각 통합 시험은 finally에서 pid 파일·attempt 행에 남은 PID를 그룹째 SIGKILL(ESRCH 무시)하고, 무관 프로세스·host 프로세스를 끝내고, 격리 DB와 임시 home을 지운다. 손으로 다시 돌릴 때 남은 것은 `pgrep -f process-worker.mjs`로 찾아 끝낸다.

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project core test/supervisor.test.ts test/supervisor-cancel.test.ts test/contracts.test.ts test/brain-drain.test.ts test/codes.test.ts test/schema.test.ts` -- expected: 통과(가짜 시간, PG 불필요).
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts test/migrate-files.test.ts test/store.test.ts test/schema.test.ts` -- expected: 통과. PG 사전 조건: test-db global setup 또는 `BRAIN_TEST_DATABASE_URL`. `migrate.test.ts`에 v2 행(현재 아닌 열린 attempt 포함) → v3 적용 case.
- `pnpm exec vitest run --project cli test/daemon-supervisor-cancel.test.ts test/daemon-supervisor.test.ts test/process-inspector.test.ts test/process-group.test.ts test/queue-cancel.test.ts test/command-meta.test.ts test/readme-codes.test.ts test/queue-drain.test.ts test/daemon-run.test.ts` -- expected: 통과. `daemon-supervisor-cancel.test.ts`가 실제 Node 자식과 PG로 AC 4개와 데몬 종료 정리를 각각 `queue cancel stops a TERM-ignoring probe and its grandchild with SIGKILL after the grace`, `a restarted daemon cleans the group a SIGKILLed supervisor left, then requeues it`, `a restarted daemon does not kill a process that reuses the recorded pid`, `an identity check that fails leaves the attempt unknown and the work unclaimed`로 확인한다. 관찰값: 일감 `outcome`, attempt `outcome`, `kill(pid, 0)`의 ESRCH.
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.


**최종 실행 결과 (2026-10-29):**
- 계획에 지정된 Core 6파일 409개, PostgreSQL 5파일 157개, CLI 9파일 149개 시험 통과.
- 최종 `pnpm test`: build·typecheck 및 115파일 2,809개 시험 통과.
- 실제 CLI 취소·TERM 무시 리더와 손자 정리, SIGKILL된 데몬의 그룹 복구와 재청구, PID 재사용 보호, 조회 실패의 `unknown` 유지 등 AC 4개 통과.
- `git diff --check` 통과. quick 검토의 지적 2건을 수정했고 수정 후 재검토에서 추가 지적 없음.
- 계획 범위 내 미완료 없음. 종료를 확인할 수 없는 프로세스는 살아 있을 수 있으며, `unknown`은 token·청구를 유지해 재실행을 막는다. `unknown` 해제 수단은 계획대로 구현하지 않았다.

## Auto Run Result

상태: `built`. ticket 12.2의 후속 thorough 검토를 마쳤다. 티켓을 `done`으로 표시하지 않았고 `tickets.py mark`도 실행하지 않았다. 완료 판정은 오케스트레이터가 한다. 기존 deferred-work ledger 항목과 상태는 변경하지 않았다.

**구현 요약:** 기존 `brain queue cancel`·감독자의 TERM → 유예 → KILL → reap·재시작 신원 대조·`unknown` 재청구 차단 구현을 네 렌즈로 다시 검토했다. 이번에는 취소 접수 문구를 바로잡고, 기존 동작의 경계 시험을 보강했다. 감독자와 Store의 실행 로직은 이번 후속 pass에서 바꾸지 않았다.

**이번 변경 파일:**
- `apps/cli/src/commands/queue-cancel.ts` — `requested`를 “취소 요청을 접수했습니다.”로 안내한다.
- `README.md` — `unknown` 취소 요청이 자동 정리를 다시 시작하지 않음을 설명한다.
- `apps/cli/test/queue-cancel.test.ts` — 실행 중·`unknown`의 실제 CLI 텍스트와 token 유지·attempt 결과를 확인한다.
- `packages/core/test/supervisor.test.ts` — 잘못된 ABI 줄 뒤 살아 있는 자식을 직접 종료하지 않고 감독자 정리·실패·재시도를 확인한다.
- `packages/core/test/supervisor-cancel.test.ts` — 시작 신원 `unknown`·`none`과 TERM 무시 여부의 4경우, 취소 poll 전·유예 중 shutdown 2경우를 검증한다.
- `packages/postgres/test/work-store.test.ts` — 별도 PG 연결과 실제 행 잠금 관찰 장벽으로 cancel과 finish·settle 5종류의 양쪽 실행 순서 10경우를 확인한다.
- 이 계획 — 기존 검토 기록을 보존하고 후속 판정·검증 결과를 추가했다.

**검토 결과:** 24건(high 0, medium 4, low 13, false 7). patch 5묶음(high 0, medium 4, low 1)을 적용했다. 새 deferred 없음. 각 렌즈의 모든 지적을 위 후속 Review Triage Log에 개별 기록했다.

**기각 근거:** 신원 기록 실패와 데몬 사망의 결합 3건, SIGKILL 뒤 reap 대기 2건, 공유 DB의 다른 home 1건, stdout 폭주 버퍼 2건, 벽시계 보정 1건은 기존 low/reject 판정을 carried로 유지했다. 개별 OS 조회 지연의 누적 1건은 드문 지연과 전체 시간 예산 전달의 복잡도 때문에 low로 기각했다. 성공 뒤 shutdown 반환 1건과 취소 후 정상 성공 1건은 계획 행렬의 선택이며 수정에 계획 변경이 필요하여 기각했다. false 7건은 실제 CLI·PG 관찰, 시험 유예 주입, 직접 자식 reap과 손자 소멸, 실제 SIGKILL 후 복구, 데몬 abort 경로, 가짜 신원을 쓴 PID 재사용, 만료 후 차단 계약이 원문의 표면에 대응함을 확인했다. 구체적 반증은 위 각 행에 적었다.

**후속 리뷰 권고:** `false`. 후속 pass의 patch는 high 0·medium 4·low 1묶음이며, high patch가 없어 수렴으로 판정한다. 새로운 공개 계약이나 감독자·PG 실행 로직 변경은 없다.

**검증:**
- `pnpm build` 성공.
- 계획 Verification의 Core 지정 명령: 6파일·425개 통과.
- 계획 Verification의 PostgreSQL 지정 명령: 5파일·167개 통과.
- 계획 Verification의 CLI 지정 명령: 9파일·150개 통과. 실제 Node 리더·손자의 취소와 재시작 정리, PID 재사용 보호, 조회 실패 `unknown`의 AC 4개를 포함한다.
- 최종 `pnpm test`: build·typecheck 및 115파일·2,836개 통과.
- `git diff --check` 통과. 행렬 8행은 기존 검증과 보강한 경계 시험이 덮는다.

**남은 위험:** 신원 기록 전 또는 DB 기록 실패 뒤 데몬이 죽는 창, 커널 대기로 SIGKILL 후 리더 reap이 지연되는 경우, 폭주 stdout, 벽시계 보정의 유예 영향은 기존 판정을 유지한다. OS 조회별 5초 timeout이 누적되면 계획의 7초 정리·20초 종료 설명은 전체 시간 상한이 되지 않는다. 확정 재시도 중 데몬이 멈추면 다음 시작 대조가 `died`로 회수해 다시 실행할 수 있다. `unknown` 해제 수단과 그룹을 벗어난 자손 정리는 제공하지 않는다.
