---
title: 'Tracer: 감독자가 probe 자식을 600초 넘게 돌리는 동안 대화 수집이 처리된다'
type: 'feature'
ticket: '1'
created: '2026-10-29'
status: 'built'
baseline_revision: '726a651dc3d521bdda248ed6e6c065bd8f252507'
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

## Auto Run Result

Status: built

**요약:** 실행 분류 등록부(`workExecutionClass`, `process_probe`만 `supervised`)와 PG 마이그레이션 0002(`work_items.execution_class`·`current_attempt_token`, `brain.work_attempts`)를 두고, WorkStore에 `claimSupervisedWork`·`renewSupervisedLease`·`finishSupervisedWork`(attempt token CAS)를 더했다. 모든 core 청구는 DB 조건과 `brain.queue.drain` handler 필터 둘 다로 `supervised` 일감을 뺀다. 데몬은 회차 루프와 따로 도는 감독자(자기 Store 하나)를 띄워 출하 probe 자식을 ABI v1 정상 경로(`progress` → `result`)로 돌리고, 60초 간격으로 임대를 갱신하며, 현재 token으로만 결과를 확정한다.

**바꾼 파일:**
- `packages/postgres/migrations/0002_supervised_attempts.sql` — 실행 분류·현재 attempt 칸과 attempt 이력 표.
- `packages/postgres/src/migrate.ts` — `CORE_SCHEMA_VERSION = 2`.
- `packages/postgres/src/work.ts` — supervised 세 verb, core predicate에 `execution_class = 'core'`, `ensureWork`가 분류를 채움.
- `packages/core/src/domain/work-item.ts` — 등록부·감독자 상수·`WorkAttempt`, 재시도 대기 주석 정정.
- `packages/core/src/ports/store.ts`·`ports/clock.ts`·`ports/process.ts`·`ports/index.ts` — 새 verb, `Timer`, `ProcessLauncher` port.
- `packages/core/src/process-abi/codec.ts`, `packages/core/schemas/process-abi/v1/event.schema.json`, `packages/core/fixtures/process-abi/v1/cases.json`, `packages/core/package.json` — ABI v1 첫 판(schema·fixture·손으로 쓴 코덱, 배포 파일).
- `packages/core/src/queue/supervisor.ts` — `runSupervisor`.
- `packages/core/src/brain.ts` — drain에서 supervised handler 제외.
- `packages/core/src/testing/fakes/{store,clock,process}.ts`, `testing/contracts/work-store.ts`, `testing/index.ts` — fake verb, `manualTime`, `fakeProcessLauncher`, 계약 case.
- `apps/cli/src/runtime/process-group.ts`, `runtime/clock.ts` — Node 프로세스 그룹 launcher, 실제 `Timer`.
- `apps/cli/src/workers/process-probe.ts` — 출하 probe worker.
- `apps/cli/src/daemon/supervisor.ts`, `daemon/run.ts` — 데몬 감독자 조립과 seam.
- `apps/cli/src/doctor/store.ts`, `runtime/brain-store.ts` — 새 verb의 불가 Store, 기대 버전 2.
- 시험: `packages/core/test/{supervisor,process-abi,brain-drain}.test.ts`, `packages/postgres/test/{work-store,migrate}.test.ts`, `apps/cli/test/{process-group,daemon-supervisor}.test.ts`, `apps/cli/test/supervisor-fixture.ts`, `apps/cli/test/fixtures/process-worker.mjs`, 그리고 버전 1·표 목록을 고정하던 기존 시험 갱신.

**리뷰 결과(thorough, 렌즈 4개, 24건):** patch 5건(갱신 성공 시 문제 상태 해제, v1→v2 업그레이드 시험, launcher 시작 실패 시험, 갱신 간격 시험, 데몬에서 probe가 도는 동안 core 일감 완료 시험). deferred 3건(정체 무기한 대기 → 스토리 5, 시도 상한 없는 재예약 → 스토리 4·5, 재청구 때 이전 attempt 미종결 → 스토리 2). reject 16건(각 이유는 Review Triage Log): `lost` 갱신 뒤 계속 실행, 줄 순회 예외 시 자식 잔존(2건), 설정·URL 한 번만 읽음(2건), 중복 result, 긴 줄, abort 직후 시작, attempt 실패 이유 칸, 그리고 false 6건(두 번째 감독자 루프, 700초 시험 token 교체, 등록부 명시, validator 대조, plan 시험 이름, attempt 칸).

**후속 리뷰 권고:** `false`. 이번 pass에서 patch한 항목은 medium 2건(업그레이드 시험, 데몬 동시 처리 시험)·low 3건이고 high는 0건이다. medium 2건은 모두 시험 보강이며 보강한 시험이 통과해, 이름 붙일 만한 미검증 위험이 남지 않았다.

**검증:** 구현 뒤와 patch 뒤 두 번 plan Verification을 실행했다. patch 뒤 `pnpm test` — build·typecheck·시험 파일 111개, 시험 2,749개 통과. `pnpm exec vitest run --project cli test/daemon-supervisor.test.ts` 2개 통과. I/O 행렬 6행 모두 실행된 시험이 덮는다.

**남은 위험:**
- 진행이 멈춘 자식은 정체 판정이 없어 감독자를 붙잡고, 임대 만료 뒤에는 재청구될 수 있다(스토리 2·5).
- 감독자는 시작 때 연 Store와 DB URL을 계속 쓴다. 실행 중 `.env`가 바뀌면 데몬을 다시 띄워야 반영된다.
- stdout 스트림 오류처럼 드문 예외 경로에서는 자식 그룹을 정리하지 않고 감독자 루프가 다음 회차로 넘어간다(그룹 정리 강화는 스토리 2).
- 구현 세션이 plan frontmatter를 스스로 `built`로 바꿨던 일이 있어 오케스트레이터가 바로잡았다(Implementation Notes).
