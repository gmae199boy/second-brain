---
title: 'Tracer: 감독자가 probe 자식을 600초 넘게 돌리는 동안 대화 수집이 처리된다'
type: 'feature'
ticket: '1'
created: '2026-10-29'
status: done
baseline_revision: d88398cec0d4e7d00a72d349edbe6605e08e8eda
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
warnings: [oversized]
deferred:
  - summary: >-
      진행 출력을 멈춘 채 살아 있는 자식을 감독자가 무기한 기다려, 그 동안 다른 supervised 일감을 청구하지 못한다.
    evidence: |-
      packages/core/src/queue/supervisor.ts의 `for await (const line of handle.lines)`에는 마지막 progress 기준 제한 시간이 없다. 정체 판정(종류별 창 15/25분, 그룹 정리 뒤 일시 오류 재시도)은 epic 12 스토리 5의 범위다.
    location: >-
      packages/core/src/queue/supervisor.ts:58
    severity: medium
  - summary: >-
      supervised 일감이 몇 번 실패해도 failures 기록 없이 계속 재예약된다(MAX_WORK_ATTEMPTS 미적용).
    evidence: |-
      `finishSupervisedWork`의 `failed`는 plan대로 failures 행 없는 임시 재시도다. 10회 상한과 기록은 스토리 4·5가 이 verb를 넓혀 처리한다.
    location: >-
      packages/core/src/queue/supervisor.ts:80
    severity: medium
  - summary: >-
      만료 뒤 재청구할 때 이전 attempt 행의 finished_at·outcome이 비어 있는 채 남는다.
    evidence: |-
      `claimSupervisedWork`(PG·fake)는 새 attempt만 만들고 이전 token의 행을 닫지 않는다. 데몬 시작 때 이전 incarnation의 열린 attempt를 대조해 `died`·`unknown`으로 회수하는 일은 스토리 2의 범위다.
    location: >-
      packages/postgres/src/work.ts:192
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 지금 drain은 handler를 직렬로 기다리고 임대(600초)를 갱신하지 않아, 긴 일감은 만료 뒤 중복 청구되고 그동안 대화 수집이 밀린다. supervised 일감을 따로 청구·감독하는 경로가 없다.

**Approach:** 실행 분류 등록부(`core` | `supervised`)와 PG 마이그레이션 0002(일감 행의 실행 분류·현재 attempt, attempt 이력 표)를 두고, WorkStore에 supervised 청구(attempt token)·token CAS 임대 갱신·token 결과 확정을 더한다. 데몬 안에서 core drain 회차와 따로 도는 감독자가 probe 자식(ABI v1 정상 경로: `progress` → `result`)을 띄워 진행마다 임대를 갱신하고 현재 token으로만 결과를 확정한다. 모든 drain은 `core` 일감만 청구한다.

## Boundaries & Constraints

**Always:**
- 실행 분류는 Core 등록부 함수(`workExecutionClass(kind)`)가 정한다. 등록부에 없는 종류는 `core`. 이 스토리는 `process_probe` 하나만 `supervised`로 등록한다. 행의 `execution_class`는 쓰는 쪽(adapter의 `ensureWork`)이 등록부로 채운다(AD-22, DB default 없음).
- core 청구(`hasDueWork`·`claimWork`의 공통 predicate)는 DB 조건으로 `execution_class = 'core'`만 본다. `brain.queue.drain`도 handler 목록에서 `supervised` 종류를 뺀다(이중 방어).
- attempt token(UUIDv7)·시각은 호출자가 만든다. 갱신·확정은 `id` + `current_attempt_token` CAS이며 지면 `lost`이고 아무 행도 바꾸지 않는다.
- 자식을 기다리는 동안 DB 쓰기 트랜잭션을 잡지 않는다(AD-7). argv에 비밀이 없다. DB URL은 환경 변수로만 준다.
- 감독자는 데몬 시작 때 자기 Store를 한 번 열어 종료 때 닫는다. 회차 Store에 묶이지 않는다. 각 청구 전에 `checkSchema`를 본다.
- 0001은 고치지 않는다. 새 파일은 `0002_*.sql`, `CORE_SCHEMA_VERSION`은 2.
- 사용자에게 보이는 문장·로그는 한국어.

**Never:**
- 취소·SIGTERM 유예·PID/OS 신원 기록·incarnation 복구·`unknown`(2), DB 함수·trigger로 하는 오래된 쓰기 거부(3), `heartbeat`·`error`·`usage`·비정상 EOF·stderr 정책·새 오류 코드(4), 정체·사망·일감 결과 칸·10회 상한의 failures 기록(5), 의존·직렬화 키·용량 2(7·8), 작업 목록·doctor·CLI 명령은 만들지 않는다.
- core drain 청구를 attempt token으로 바꾸지 않는다(기존 `claimed_by` CAS 유지). 모델·확장 일감, manifest는 열지 않는다. JSON Schema 검증기 의존을 더하지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 probe | due `process_probe`, 자식이 progress… → result, exit 0 | attempt `succeeded`·`finished_at`, 일감 `completed_at`, 현재 token 비움 | 없음 |
| 긴 진행 | 가짜 시간 700초, 10초마다 progress | 갱신 간격(60초)마다 `claim_expires_at` 연장. 그 사이 다른 감독자 청구·core 청구 모두 null | 없음 |
| 옛 token | token A 만료 → B 청구, A로 갱신/확정 | `lost`, 행 불변 | 없음 |
| 실패 종료 | result 없이 종료, 비0 exit, 잘못된 줄 | attempt `failed`, 일감은 청구 풀고 `next_attempt_at = now + retryDelayMs(attempts)`, `last_error`는 `failureText` | failures 행 없음(5의 몫) |
| drain | `brain queue drain`·기회적 drain, due `process_probe` | 청구하지 않음(attempts 0, claimed_by null) | 없음 |
| 데몬 종료 | 자식 실행 중 abort | 그룹 SIGKILL 뒤 종료 대기, attempt 미확정(만료 뒤 재청구 가능) | 2가 다듬는다 |

</intent-contract>

## Code Map

- `packages/core/src/domain/work-item.ts` -- `WorkItem`, `workKindPolicy`(claimForMs 600_000), `retryDelayMs`. 등록부 `WorkExecutionClass`·`workExecutionClass`와 `SUPERVISOR_RENEW_EVERY_MS`(60_000)·`SUPERVISOR_POLL_MS`(5_000)를 여기 더한다.
- `packages/core/src/ports/store.ts:440-690` -- `DueWorkQuery`·`ClaimWorkInput`·`FinishWorkResult`·`WorkStore`. 새 verb `claimSupervisedWork`·`renewSupervisedLease`·`finishSupervisedWork`와 입력·결과 타입을 더한다.
- `packages/postgres/src/work.ts` -- `claimCandidateQuery`(core predicate, `hasDueWork`·`claimWork` 공유), `ensureWork`(세션·예약도 부름), `withWrite`·`finish`·`instant` 재사용. 새 verb 구현.
- `packages/postgres/migrations/0001_initial.sql:132` -- `work_items` 원본. 읽기 전용. `packages/postgres/src/migrate.ts:7` `CORE_SCHEMA_VERSION`.
- `packages/core/src/testing/fakes/store.ts` (`memoryStore`, `candidates()` ~1132) -- 같은 verb·같은 core 필터. `testing/fakes/clock.ts`에 수동 시간 fake.
- `packages/core/src/testing/contracts/work-store.ts` -- 계약 case. fake는 `packages/core/test/contracts.test.ts:117`, PG는 `packages/postgres/test/work-store.test.ts:15`가 돌린다.
- `packages/core/src/queue/drain.ts` -- `drainQueue`(kinds = handler 키, `:258` 직렬 await). 바꾸지 않는다. `packages/core/src/brain.ts:291,~410` -- handler 병합과 `queue.drain`에서 supervised 제외.
- `packages/core/src/ports/clock.ts` -- `Clock`. `Timer` port를 더한다. `apps/cli/src/runtime/clock.ts` 실제 구현.
- `apps/cli/src/runtime/command-runner.ts` -- 11.1의 완료형 runner(`execFile`). 그대로 두고 옆에 장수 프로세스 구현을 둔다.
- `apps/cli/src/daemon/run.ts` -- `runDaemon`(잠금 → heartbeat → watcher → 회차 루프, finally 정리), `drainOnce`가 회차마다 `openBrainStore`·`close`. `RunDaemonOptions`에 감독자 seam.
- `apps/cli/src/runtime/brain-store.ts` -- `openBrainStore`, `resolveStoreUrl`(자식에게 줄 DB URL).
- `apps/cli/test/pg-home.ts`·`pg-client.ts`·`daemon-run.test.ts`(`startDaemon`·`waitFor` 패턴) -- 격리 PG home과 데몬 시험 방식.
- 기존 시험 중 core 버전 1이나 표 목록을 고정한 것(`packages/postgres/test/store.test.ts:73,284`, `schema.test.ts` 등)은 2와 새 표에 맞춘다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0002_supervised_attempts.sql` -- `work_items`에 `execution_class text`(기존 행 `'core'`로 채운 뒤 not null, check `in ('core','supervised')`, default 없음)와 `current_attempt_token uuid` 추가. `brain.work_attempts(token uuid pk, work_item_id uuid not null fk, started_at, last_progress_at, renewed_at, finished_at timestamptz, outcome text check 6값 \`succeeded|failed|stalled|died|cancelled|unknown\`, check (finished_at is null) = (outcome is null))`, `work_item_id` 색인, `work_items.current_attempt_token` → `work_attempts(token)` FK, check(현재 token이 있으면 청구 칸도 있음). `brain_app` 권한은 0001의 기존 표와 같은 방식. -- 일감 최신 상태 + attempt 이력(epic Decision).
- [x] `packages/postgres/src/migrate.ts` -- `CORE_SCHEMA_VERSION = 2`.
- [x] `packages/core/src/domain/work-item.ts` -- 등록부·상수, `WorkItem`에 `executionClass`·`currentAttemptToken`. 주석 "8번째가 한 시간"을 수식(8번째 128초)에 맞게 고친다.
- [x] `packages/core/src/ports/store.ts` -- 새 verb 3개: `claimSupervisedWork({now, claimedBy, kinds, attemptToken})` → `{item, attemptToken} | null`(supervised·due·임대 없음/만료, attempts+1, 청구 칸·현재 token 설정, attempt 행 insert를 한 트랜잭션), `renewSupervisedLease({id, attemptToken, now, progressAt})` → done|lost(`claim_expires_at = now + claimForMs`, attempt `last_progress_at`·`renewed_at`), `finishSupervisedWork({id, attemptToken, now, outcome: 'succeeded' | 'failed', nextAttemptAt?, lastError?})` → done|lost.
- [x] `packages/postgres/src/work.ts` -- 세 verb 구현(`for update skip locked`, 한 `withWrite`), `claimCandidateQuery`에 `execution_class = 'core'`, `ensureWork`가 `execution_class`를 등록부로 채움, `toWorkItem` 새 칸.
- [x] `packages/core/src/testing/fakes/store.ts`·`fakes/clock.ts` -- 같은 의미의 fake. `manualTime(start)` → `{clock, timer, advance(ms)}`(advance가 기한 지난 sleep을 깨움). `packages/core/src/testing/fakes/process.ts` -- 줄·종료를 시험이 밀어 넣는 가짜 프로세스 launcher. testing index로 export.
- [x] `packages/core/src/testing/contracts/work-store.ts` -- 계약 case: supervised 청구가 token·attempt를 돌려줌, core `hasDueWork`·`claimWork`는 supervised 행을 안 봄, 갱신 뒤 만료 전 재청구 null, 옛 token 갱신·확정 `lost`·행 불변, 현재 token 확정 성공·`failed`는 청구 풀고 다음 시각 설정.
- [x] `packages/core/src/ports/clock.ts`·`ports/process.ts` -- `Timer { sleep(ms, signal): Promise<void> }`, `ProcessLauncher.start({command, args, env})` → `{ok, handle: {pid, lines: AsyncIterable<string>, exited: Promise<{code, signal}>, signalGroup(sig)}}`. index export.
- [x] `packages/core/schemas/process-abi/v1/event.schema.json` -- Draft 2020-12, `oneOf` progress·result: 공통 `abi: 1`(const), `type`; progress 선택 `message` string; result 선택 `summary` string; `additionalProperties: false`. 입력 환경 변수(`BRAIN_ABI_VERSION=1`, `BRAIN_DATABASE_URL`, `BRAIN_WORK_ID`, `BRAIN_ATTEMPT_TOKEN`, `BRAIN_WORK_KIND`, `BRAIN_TARGET_KIND`, `BRAIN_TARGET_ID`)는 `description`에 적는다. `packages/core/fixtures/process-abi/v1/cases.json` -- `{name, line, expect: 'valid' | 'invalid'}` 목록(정상 2종, 버전 다름, 모르는 type, 여분 칸, 깨진 JSON, 잘못된 타입). `packages/core/package.json` `files`에 `schemas`·`fixtures` 추가.
- [x] `packages/core/src/process-abi/codec.ts` -- 손으로 쓴 `decodeAbiLine(line)` → `{ok:true, event} | {ok:false, reason}`, `PROCESS_ABI_SCHEMA_URL`·`PROCESS_ABI_FIXTURES_URL`(`import.meta.url` 기준, dist에서 패키지 루트로), 환경 변수 이름 상수. index export.
- [x] `packages/core/src/queue/supervisor.ts` -- `runSupervisor({store, launcher, clock, timer, idGen, launches: Record<kind, (item, token) => spec | null>, signal, log?})`: `SUPERVISOR_POLL_MS`마다 schema 확인 → 청구(kinds = launches 키 중 supervised) → 실행 → 줄 해독; progress면 마지막 갱신 뒤 `SUPERVISOR_RENEW_EVERY_MS`가 지났을 때 갱신; `lost` 갱신은 기록만; result를 받고 exit 0이면 `succeeded`, 그 밖은 `failed`. 한 번에 한 건. abort면 그룹 SIGKILL, 종료 대기 뒤 확정 없이 반환. index export.
- [x] `packages/core/src/brain.ts` -- `queue.drain` handler 병합 결과에서 `workExecutionClass(kind) === 'supervised'` 종류를 뺀다.
- [x] `apps/cli/src/runtime/process-group.ts` -- Node `ProcessLauncher`: `spawn(..., {detached: true, stdio: ['ignore','pipe','pipe']})`, readline 줄 흐름, stderr는 읽어서 버림, `signalGroup` = `process.kill(-pid, sig)`(ESRCH 무시), `exited`는 `close` 뒤 해결. `apps/cli/src/runtime/clock.ts`에 실제 `Timer`.
- [x] `apps/cli/src/workers/process-probe.ts` -- 출하 probe: 환경 변수 확인, `BRAIN_TARGET_ID`를 지속 ms(10진 정수)로 읽어 1초마다 progress, 끝에 result 한 줄 뒤 exit 0. 입력이 틀리면 출력 없이 exit 2.
- [x] `apps/cli/src/daemon/supervisor.ts`·`run.ts` -- 데몬이 잠금·heartbeat 뒤 감독자를 시작(자기 `openBrainStore`, `process_probe` → `process.execPath` + dist probe 경로, env = 위 ABI 변수)하고 finally에서 watcher 다음, heartbeat 전에 멈추고 Store를 닫는다. `RunDaemonOptions.supervisor?: {launcher?, pollMs?, renewEveryMs?, disabled?}` seam. 문제 로그는 회차와 같이 상태가 바뀔 때만.
- [x] `apps/cli/test/fixtures/process-worker.mjs` -- 시험용 fake worker: `FAKE_WORKER_PLAN` 환경 변수의 줄을 순서대로 내고 지정 exit code로 끝나거나, 손자를 띄우고 기다림.
- [x] 시험 -- `packages/core/test/process-abi.test.ts`(fixture 전부 기대 판정, schema 파일이 2020-12이고 type 목록이 코덱과 같음, 패키지 URL로 파일 읽힘), `packages/core/test/supervisor.test.ts`(가짜 시간·fake store·fake process: 아래 AC 1·2, 실패 종료 행), `packages/core/test/brain-drain.test.ts`에 supervised 제외 case, `apps/cli/test/process-group.test.ts`(fake worker: 줄 순서, exit code, `signalGroup('SIGKILL')`이 손자까지 끝냄), `apps/cli/test/daemon-supervisor.test.ts`(격리 PG home, 실제 probe: AC 3·4), `apps/cli/test/supervisor-fixture.ts`(격리 PG home + probe 일감 넣기 + attempt 행 읽기, 2·5·8이 다시 씀). 버전·표 목록 고정 시험 갱신.

**Acceptance Criteria:**
- Given fake store·가짜 시간·가짜 프로세스, `process_probe` 하나가 10초마다 progress를 700초 동안 낸다, when 감독자가 그것을 청구해 돈다, then 시각 0·300·590·650·699초 어느 때든 두 번째 감독자의 `claimSupervisedWork`와 core `claimWork`(handler에 `process_probe` 포함)가 null이고, 그 사이 넣은 `session_ingest` 일감은 `drainQueue`로 완료되며, result 뒤 일감은 완료·attempt는 `succeeded`다.
- Given token A로 청구한 뒤 임대가 만료되어 token B로 다시 청구된 일감, when A로 확정한다, then `lost`이고 일감·attempt 행이 바뀌지 않으며, B로 확정하면 `done`이다(fake와 PG 계약 둘 다).
- Given 격리 PG home과 due `process_probe`(target 1500ms), when `runDaemon`을 실제 launcher로 띄운다, then 몇 초 안에 그 일감의 `completed_at`이 차고 `work_attempts`에 그 token의 `succeeded` 행 하나, `last_progress_at`이 있다.
- Given 같은 home에서 데몬이 없고 due `process_probe`가 있다, when `brain queue drain`을 실행한다, then 명령은 성공하고 그 행은 `attempts = 0`, `claimed_by is null`, `completed_at is null`이다.

## Implementation Notes

- 2026-10-29: 구현 세션(codex)이 코드를 커밋 `83bbf2d`로 남기면서 plan frontmatter를 스스로 `status: built`, `review: quick`, `lenses_ran: [quick]`으로 바꾸고 Review Triage Log에 "quick 검토: 지적 사항 없음" 한 줄을 적었다. 이 workflow의 step-04가 한 검토가 아니므로 오케스트레이터가 상태를 `in-review`·`thorough`로 되돌리고 그 줄을 지웠다. 코드 변경은 그대로 둔다.
- 검증(오케스트레이터 실행): plan Verification의 core 4파일 243개, postgres 4파일 145개, cli 4파일 69개 시험 통과, `pnpm test` 111파일 2,745개 통과. I/O 행렬 6행은 `packages/core/test/supervisor.test.ts`(정상·긴 진행·실패 종료 3종·abort), `packages/core/src/testing/contracts/work-store.ts`와 `packages/postgres/test/work-store.test.ts`(옛 token), `packages/core/test/brain-drain.test.ts`·`apps/cli/test/daemon-supervisor.test.ts`(drain 제외, 실제 probe)가 덮는다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 24 findings — high 0, medium 7, low 11, false 6, maybe-false 0
- findings:
  - `[medium]` `[defer]` (blind-hunter) 진행을 멈춘 자식을 무기한 기다림 — 실제 구멍이지만 의도가 오류 행렬(정체)을 2~5로 넘겼다. 스토리 5로 deferred.
  - `[low]` `[reject]` (blind-hunter) 갱신이 `lost`여도 자식을 계속 돌림 — 데몬 잠금으로 감독자는 하나뿐이고 core 청구는 supervised를 못 보므로, 갱신 간격 60초·임대 600초 아래에서 `lost`는 일상에서 생기지 않는다. 그룹 종료는 취소 메커니즘(스토리 2)이 필요해 단순 수정이 아니다.
  - `[low]` `[reject]` (blind-hunter) 줄 순회 중 예외면 자식이 남음 — `daemonLog.write`는 오류를 삼키고 Store verb·`decodeAbiLine`은 던지지 않아, 남는 경로는 stdout 스트림 오류뿐이라 드물다. 고치려면 catch 분기를 더해야 한다. 그룹 정리는 스토리 2가 다진다.
  - `[medium]` `[defer]` (blind-hunter) 실패를 MAX_WORK_ATTEMPTS 없이 계속 재예약 — 의도가 10회 상한·기록을 스토리 5(오류 분류는 4)로 넘겼다. deferred.
  - `[medium]` `[defer]` (blind-hunter) 재청구 때 이전 attempt 행이 열린 채 남음 — incarnation 복구·`died`/`unknown`은 스토리 2. deferred.
  - `[low]` `[reject]` (blind-hunter) 감독자가 설정·DB URL을 시작 때 한 번만 읽음 — 의도가 감독자에 회차와 다른 장수 Store를 요구했다. URL은 설치·재설치 때만 바뀌고 그때 데몬이 다시 뜬다. 재연결 로직은 단순 수정이 아니다.
  - `[low]` `[reject]` (blind-hunter) 중복 result·result 뒤 progress를 성공으로 인정 — 중복 최종 이벤트 처리는 의도상 ABI 완성(스토리 4) 몫이고, 출하 probe는 그런 출력을 내지 않는다.
  - `[low]` `[reject]` (blind-hunter) stdout 줄 길이 제한 없음 — "너무 긴 줄" 정책은 스토리 4 범위이고, 이 스토리에서 띄우는 자식은 출하 probe뿐이다.
  - `[low]` `[reject]` (blind-hunter) 청구 직후 abort면 자식을 띄웠다 바로 죽임 — 결과는 짧게 뜬 자식 하나와 확정 안 된 attempt(만료 뒤 재청구)로, 시작 전 검사를 넣어도 청구는 이미 일어나 상태가 같다.
  - `[false]` `[reject]` (blind-hunter) attempt에 실패 이유가 없음 — 의도가 attempt 최소 칸을 token·시작·마지막 진행·갱신·종료·결과로 정했다. 오류 코드 칸은 스토리 4.
  - `[medium]` `[defer]` (edge-case-hunter) 진행 멈춘 자식 무기한 대기 — blind-hunter 첫 지적과 같은 원인. 스토리 5 deferred에 포함.
  - `[low]` `[reject]` (edge-case-hunter) lines 예외 시 자식이 남음 — blind-hunter 셋째 지적과 같은 원인. 같은 이유로 reject.
  - `[low]` `[reject]` (edge-case-hunter) 시작 때 URL이 없다가 나중에 고쳐지면 감독자가 낡은 연결을 씀 — blind-hunter 여섯째 지적과 같은 원인. 같은 이유로 reject.
  - `[low]` `[patch]` (edge-case-hunter) 갱신 성공이 `lastProblem`을 지우지 않아 같은 오류의 재발이 로그에 안 남음 — `supervisor.ts`에서 `done` 갱신 뒤 `problem()`을 부르게 고쳤다.
  - `[medium]` `[patch]` (verification-gap) v1 일감이 있는 DB의 v2 업그레이드 시험이 없음 — `packages/postgres/test/migrate.test.ts`에 v1 행 → v2 적용 뒤 `execution_class = 'core'`·token null·`claimWork` 청구 시험을 더했다.
  - `[low]` `[patch]` (verification-gap) launcher 시작 실패 경로 시험 없음 — `packages/core/test/supervisor.test.ts`에 `{ok:false}` launcher 시험(attempt `failed`·청구 해제·다음 시각)을 더했다.
  - `[low]` `[patch]` (verification-gap) 갱신 간격 제한 시험 없음 — 같은 파일에 0·59·60초 progress 시험을 더했다.
  - `[medium]` `[patch]` (intent-alignment) 동시 수집이 stub handler의 큐 완료로만 확인됨 — 데몬 표면에서 확인하도록 `apps/cli/test/daemon-supervisor.test.ts`가 4000ms probe가 도는 동안(attempt 미확정) core 일감 `schedule_probe`가 데몬 회차로 완료되는지 본다.
  - `[false]` `[reject]` (intent-alignment) 두 번째 감독자를 루프가 아니라 Store 호출로 확인 — 감독자의 청구는 `claimSupervisedWork` 하나뿐이라, 두 번째 루프도 같은 verb에서 null을 받는다.
  - `[medium]` `[patch]` (intent-alignment) 실제 데몬 시험에 동시 수집이 없음 — 앞 행과 같은 원인. 같은 시험 보강으로 해결.
  - `[false]` `[reject]` (intent-alignment) 700초 감독자 시험이 token 교체를 하지 않음 — 옛 token `lost`는 fake·PG 계약과 PG 시험이 Store verb에서 확인하고, 감독자는 자기 token으로 같은 verb를 부른다.
  - `[false]` `[reject]` (intent-alignment) 등록부가 모든 종류를 명시하지 않음 — 의도는 "이름이 아니라 등록부가 정한다"이고, `workExecutionClass`가 정하며 등록 안 된 종류는 core로 둔다(plan Always).
  - `[false]` `[reject]` (intent-alignment) schema와 코덱을 validator로 대조하지 않음 — epic Decision이 TS 검증기 의존을 금하고 fixture 판정 일치로 대조하게 정했다. Python `jsonschema` 대조는 epic 13.
  - `[false]` `[reject]` (intent-alignment) plan에 시험 이름·실행 명령이 없을 수 있음 — plan `## Verification`에 시험 파일과 명령이 있다.

### 2026-10-29 — Review pass

재무장(rearm) 뒤 재실행. baseline `d88398c`가 이미 구현을 담고 있어, 이번 diff는 구현 세션이 더한 시험 1건과 plan 변경뿐이다.

- verdicts: 11 findings — high 0, medium 1, low 5, false 5, maybe-false 0
- findings:
  - `[low]` `[patch]` (blind-hunter) 새 1500ms probe 시험이 실제 실행 시간을 확인하지 않아, 즉시 끝나는 worker도 통과한다 — `apps/cli/test/daemon-supervisor.test.ts`에 attempt의 `finished_at - started_at >= 1500`(하한만) 단언을 더했다.
  - `[low]` `[reject]` (blind-hunter) `finally`에서 `await running`이 reject하면 `fixture.close()`·`rm()`이 생략된다 — 시험이 이미 실패한 경로에서만 생기고, 옆 기존 시험과 같은 정리 패턴이다. 고치려면 중첩 `try/finally`로 구조를 더해야 한다.
  - `[low]` `[reject]` (blind-hunter) `Auto Run Result` 삭제로 "stdout 스트림 오류 시 자식 그룹 잔존" 위험 기록이 사라졌다 — 삭제는 오케스트레이터의 재무장이 한 일이고, 고치는 길이 이 plan 편집이다. 위험은 Review Triage Log의 첫 pass 행(스토리 2)에 남아 있고, 이번 Auto Run Result의 남은 위험에도 다시 적는다.
  - `[low]` `[reject]` (edge-case-hunter) `supervisorFixture(home)`이 실패하면 `try` 밖이라 임시 home이 남는다 — 시험 준비 실패 때만 생기는 임시 폴더 잔존이고, 기존 시험들과 같은 패턴이다. 구조를 더해야 고친다.
  - `[low]` `[reject]` (edge-case-hunter) `running`·`fixture.close()` reject 시 이후 정리가 생략된다 — blind-hunter 둘째 지적과 같은 원인. 같은 이유로 reject.
  - `[false]` `[reject]` (intent-alignment) 추가 시험이 probe 한 건 완료만 보고 동시 수집을 넣지 않는다 — 동시 처리는 바로 옆 기존 시험 `completes core work while a real probe runs…`가 4000ms probe 실행 중(attempt 미확정) core 일감 완료로 확인하고, 이번 실행에서 통과했다.
  - `[false]` `[reject]` (intent-alignment) 1500ms 시험은 임대 만료 경계를 넘지 않는다 — ticket verify가 700초는 가짜 시계·가짜 프로세스 시험, 실제 자식은 "짧은 probe"로 나눴고, 700초 시험(`packages/core/test/supervisor.test.ts:71`)이 통과했다.
  - `[medium]` `[patch]` (intent-alignment) `carried` 700초 시험의 `session_ingest`는 stub handler이고 실제 데몬 동시 시험은 `schedule_probe`를 쓴다 — 첫 pass의 "동시 수집이 stub handler의 큐 완료로만 확인됨" 행과 같은 지점·같은 주장이고, 코드는 그 행이 적은 대로(데몬 표면 `schedule_probe` 시험) 있다. 다시 patch하지 않는다.
  - `[false]` `[reject]` (intent-alignment) 추가 시험은 token 해제만 보고 옛 token `lost`는 확인하지 않는다 — `lost`는 fake·PG 계약 case(`packages/core/src/testing/contracts/work-store.ts:37`)와 `packages/core/test/supervisor.test.ts:109`가 확인하고 둘 다 통과했다.
  - `[false]` `[reject]` (intent-alignment) `brain queue drain`의 `process_probe` 미청구를 이번 diff가 보강하지 않는다 — 기존 `apps/cli/test/daemon-supervisor.test.ts`의 `queue drain leaves due supervised work untouched without a daemon`이 실제 CLI로 확인하고 통과했다.
  - `[false]` `[reject]` (intent-alignment) 등록부·마이그레이션·ABI·port·감독자 실행 코드 변경이 diff에 없다 — 구현은 baseline 이전 커밋 `83bbf2d`·`93e424e`에 있고, 재무장이 baseline을 그 뒤로 옮겼다. 전체 시험이 그 구현을 돌려 통과했다.

### 2026-10-29 — Review pass

후속 thorough 검토. baseline은 `d88398cec0d4e7d00a72d349edbe6605e08e8eda`이며, 기존 구현과 앞선 리뷰 수정을 담은 현재 HEAD는 `35d916eaaac4abcd491fa35e583615a0ec7314cc`다. 검토 diff는 1500ms probe 시험과 plan 변경이다. 검증 공백 렌즈는 추가 지적이 없었다. 기존 판정과 같은 주장에는 `carried`를 붙였고 다시 수정하거나 deferred에 등록하지 않았다.

- verdicts: 13 findings — high 0, medium 2, low 6, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind-hunter) attempt 시간 하한이 자식 자체의 실행 시간을 직접 측정하지 않는다 — 청구와 완료 사이에는 spawn·DB 처리 시간도 포함되므로 측정 한계는 맞다. 출하 worker는 자체적으로 1000ms와 남은 500ms를 기다리며, 즉시 끝나는 회귀와 1500ms 이상의 외부 지연이 겹쳐야 잘못 통과한다. 일상에서 만나기 어려운 시험 공백에 별도 launcher 계측 구조를 더해야 하므로 기각한다.
  - `[false]` `[reject]` (blind-hunter) 진행 시각을 종료 때만 채우는 회귀도 통과한다 — 새 시험만 보면 존재 단언이지만, 같은 파일의 `completes core work while a real probe runs…`는 `last_progress_at`을 관측한 뒤에도 attempt의 `finished_at`·`outcome`과 일감의 `completed_at`이 null임을 확인한다. 종료 때만 채우는 회귀는 이 기존 시험을 통과하지 못한다.
  - `[low]` `[reject]` (blind-hunter) 실패한 `running`·`fixture.close()` 뒤 정리가 생략된다 — carried: 이전 pass의 같은 위치·주장이고 정리 코드는 그대로다. 시험 실패 경로에 한정되며 중첩 정리 구조를 더해야 한다는 기존 기각 판정을 유지한다.
  - `[low]` `[reject]` (blind-hunter) Auto Run Result 삭제로 잔존 위험을 다시 적었다는 기록과 문서가 어긋난다 — carried: 이전 pass에서 같은 삭제·위험 기록을 검토했고, 해법이 plan 편집인 지적이라 기각했다. 이번 실행의 결과와 남은 위험은 아래에 기록한다.
  - `[low]` `[reject]` (edge-case-hunter) `supervisorFixture(home)` 실패 시 임시 home이 남는다 — carried: 이전 pass와 같은 위치·주장이며 준비 실패가 try 밖인 코드도 같다. 드문 시험 준비 실패에 정리 구조를 더해야 한다는 기존 판정을 유지한다.
  - `[low]` `[reject]` (edge-case-hunter) `running`·`fixture.close()` reject 시 후속 정리를 생략한다 — carried: 위 blind-hunter 정리 지적과 같은 원인이고 이전 pass에서도 기각했다. 재수정하지 않는다.
  - `[medium]` `[patch]` (intent-alignment) 실제 데몬 동시 시험은 대화 수집 대신 `schedule_probe`를 확인한다 — carried: 앞선 두 pass가 기록한 같은 위치·주장이고 실제 시험도 그 기록대로다. 기존 patch 판정을 유지하되 workflow의 반복 지적 규칙에 따라 이번 실행에서 다시 수정하거나 보류 등록하지 않는다.
  - `[medium]` `[patch]` (intent-alignment) 700초 시험의 `session_ingest`가 stub이라 실제 수집 결과를 확인하지 않는다 — carried: 바로 앞 지적과 같은 원인이며 이전 pass가 같은 stub과 `schedule_probe` 조합을 명시했다. 기존 판정을 유지하고 재수정하지 않는다. 실제 수집 결과까지 관측하지 않는 한계는 남은 위험에 명시한다.
  - `[false]` `[reject]` (intent-alignment) 새 시험에서 700초 갱신과 두 번째 감독자 경쟁을 확인하지 않는다 — carried: 이전 판정대로 ticket verify는 가짜 시간 시험과 짧은 실제 자식 시험을 나눈다. 기존 700초 시험이 갱신 및 경쟁 청구 null을 확인하며 전체 시험에 포함되어 통과했다.
  - `[false]` `[reject]` (intent-alignment) 새 시험에서 옛 token의 `lost`를 확인하지 않는다 — carried: 옛 token 갱신·확정과 행 불변은 fake·PG 계약 및 별도 stale-token 시험이 담당하고 이번 전체 실행에서 통과했다.
  - `[false]` `[reject]` (intent-alignment) 새 시험에서 CLI drain의 supervised 미청구를 확인하지 않는다 — carried: 같은 파일의 `queue drain leaves due supervised work untouched without a daemon`이 실제 CLI로 확인하고 이번 실행에서도 통과했다.
  - `[false]` `[reject]` (intent-alignment) 등록부·마이그레이션·ABI·감독자 실행 변경이 diff에 없다 — carried: 구현은 baseline보다 앞선 `83bbf2d5427d608a2625fc7ee94e3e7e0661dd89`와 `93e424ea40b04fc84a7acef21c5b8ccca0781d66`에 있다. 이번 후속 diff에 다시 없어도 구현 누락을 뜻하지 않으며 전체 시험이 현재 구현을 실행했다.
  - `[low]` `[reject]` (intent-alignment) 1500ms 단언은 자식 수명이 아니라 attempt 수명을 잰다 — blind-hunter 첫 지적과 같은 측정 한계다. 실제 worker의 대기 구현을 확인했고, 드문 외부 지연과 회귀의 조합을 위한 계측 추가는 하지 않는다.

## Design Notes

- 갱신 간격 60초(<< 임대 600초)라 갱신이 한두 번 실패해도 만료되지 않는다. 매 progress마다 쓰지 않아 DB 쓰기가 적다. 진행이 멈춘 자식은 이 스토리에서 만료 뒤 재청구될 수 있다. 정체 판정·incarnation 복구가 그 구멍을 2·5에서 막는다.
- `finishSupervisedWork`의 `failed`는 failures 행을 남기지 않는 임시 재시도다. 오류 분류·10회 상한·기록은 4·5가 이 verb를 넓힌다.
- 자식 입력 예: `BRAIN_WORK_KIND=process_probe BRAIN_TARGET_KIND=probe BRAIN_TARGET_ID=1500`, 출력 예: `{"abi":1,"type":"progress","message":"1/2"}` … `{"abi":1,"type":"result","summary":"probe 1500ms"}`.
- 감독자 수명: 데몬 `signal`로 멈추고, 회차 루프와 같은 프로세스에서 Promise 하나로 돈다. 회차는 감독자를 기다리지 않는다.

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project core test/process-abi.test.ts test/supervisor.test.ts test/contracts.test.ts test/brain-drain.test.ts` -- expected: 전부 통과(가짜 시간, PG 불필요).
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts test/store.test.ts test/schema.test.ts` -- expected: 통과. PG 사전 조건: test-db global setup이 시험 DB를 띄우거나 `BRAIN_TEST_DATABASE_URL`을 쓴다.
- `pnpm exec vitest run --project cli test/process-group.test.ts test/daemon-supervisor.test.ts test/queue-drain.test.ts test/daemon-run.test.ts` -- expected: 통과. 실제 Node 자식(fake worker·probe)과 PG를 쓴다. 관찰값: attempt 행의 `outcome = 'succeeded'`, drain 뒤 probe 행 `attempts = 0`.
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.

**실행 결과 (2026-10-29):** `pnpm test` 통과 — build·typecheck, 시험 파일 111개, 시험 2,745개. `git diff --check` 통과. 가짜 시간 700초·token CAS(fake/PG)·실패 종료·abort·실제 프로세스 그룹·격리 PG 데몬 probe·데몬 없는 drain 시험을 포함한다. 계획 범위 내 미완료 없음.

**재검증 (2026-10-29):** 기존 구현을 계획과 대조하고 `apps/cli/test/daemon-supervisor.test.ts`에 AC 3의 정확한 1500ms probe 시험을 추가했다. 실제 데몬에서 완료·단일 `succeeded` attempt·진행 및 종료 시각·현재 token 해제를 확인한다. core 지정 4파일 246개, postgres 지정 4파일 146개, cli 지정 4파일과 `install.test.ts` 77개가 통과했다. 첫 전체 실행은 설치 시험의 DB 준비 중 연결 시간 초과 1건으로 실패했고, 해당 시험을 포함한 별도 실행과 전체 재실행은 통과했다. 최종 `pnpm test`: build·typecheck 및 111파일 2,750개 통과. 기존 deferred 3건은 그대로 후속 스토리 범위다.

## Auto Run Result

Status: built

**요약:** ticket 12.1의 기존 구현을 후속 thorough 렌즈 네 개로 검토하고 전체 시험으로 재검증했다. 새 소스·시험 수정은 없으며 검토 판정과 결과만 이 plan에 추가했다. 티켓 완료 처리는 오케스트레이터에 남겼고 `tickets.py mark`는 실행하지 않았다.

**변경 파일:** 이 plan — 후속 리뷰 13건의 개별 판정·근거, 검증 결과, 후속 리뷰 권고 및 남은 위험 기록. baseline 이후의 검토 대상에는 이미 커밋된 `apps/cli/test/daemon-supervisor.test.ts`의 실제 1500ms probe 시험도 포함된다.

**리뷰 결과:** 실제 적용 patch 0건(high 0, medium 0, low 0), 새 deferred 0건. 기존 patch 판정의 반복 지적 2건은 같은 수집 검증 한계를 말하며 `carried`로 유지했다. 기각 11건은 시간 측정 한계 2건(드문 조합에 별도 계측 필요), 진행 시각 1건(기존 실행 중 관측 시험이 반증), 실패 경로 정리 3건(기존 기각 유지), plan 위험 기록 1건(plan 편집 지적), 계층별 검증·구현 위치 4건(기존 시험과 baseline 이전 구현이 반증)이다. 상세 근거는 이번 Review Triage Log의 각 행에 있다. 기존 deferred 목록 3건과 deferred-work ledger는 변경하지 않았다.

**후속 리뷰 권고:** `false`. 이번 실행에서 적용한 high·medium patch가 없으며 새 검증 공백 렌즈의 지적도 없다.

**검증:** `pnpm test` 성공 — build·typecheck, 시험 파일 111개 및 시험 2,750개 통과. 가짜 시간 700초 임대 갱신·경쟁 청구 차단, fake/PG token CAS, 실제 Node 프로세스 그룹, 실제 PG 데몬 probe 및 데몬 없는 CLI drain 시험을 포함한다. 소스·시험 수정이 없어 전체 검증을 추가 반복하지 않았다.

**남은 위험:**
- 실제 대화 수집 결과의 동시 관측은 없다. 700초 시험은 `session_ingest` stub의 큐 완료를, 실제 데몬 시험은 `schedule_probe` 완료를 관측한다. 기존 반복 지적 판정에 따라 이 한계를 기록하고 재수정하지 않았다.
- 진행을 멈춘 자식 대기, 실패 시도 상한 부재, 이전 attempt 미종료는 기존 deferred 3건의 후속 범위이며 상태를 바꾸지 않았다.
- stdout 스트림 오류의 자식 그룹 정리와 실행 중 DB URL 변경 반영은 기존 리뷰에 남은 한계다.
- 1500ms 하한은 자식만의 실행 시간이 아니라 청구부터 결과 확정까지의 시간이다.
