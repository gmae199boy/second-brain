---
title: '프로세스 ABI v1 완성: 같은 fixture에 TS 코덱이 기대 판정을 내고, 비정상 종료가 정한 결과로 남는다'
type: 'feature'
ticket: '4'
created: '2026-10-29'
status: built
baseline_revision: bb9b7f06c8dfe43bba57d8b4c073b01f5cc60495
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-attempt-token-db-plan.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 12.1의 ABI v1은 `progress`·`result` 두 이벤트와 일곱 환경 변수뿐이다. `heartbeat`·`error`·`usage`, exit code 우선순위, 잘린 줄·긴 줄·EOF·중복 최종·stderr 규칙이 없고, 감독자는 실패를 오류 코드 없는 문장으로만 남기며 토큰·걸린 시간을 남기지 않는다(E12-5, AD-33).

**Approach:** `packages/core`에 v1 schema 두 개(이벤트·환경 변수)와 규칙 문서, 기대 판정이 붙은 fixture 세 파일(이벤트·환경 변수·실행)을 두고 패키지와 함께 배포한다. 손으로 쓴 TS 코덱(이벤트·환경 변수 decoder, 줄 나누기, 실행 판정기)이 fixture 판정을 그대로 낸다. 감독자는 그 판정기로 attempt를 `failed`+오류 코드로 확정하고, 새 마이그레이션 `0005`의 attempt 칸에 `usage`·걸린 시간·가린 stderr를 남긴다.

## Boundaries & Constraints

**Always:**
- 이벤트(한 줄 = JSON 객체 하나, `abi: 1`·`type` 필수, 모르는 칸 거부): `progress`(선택 `message` 문자열), `heartbeat`(다른 칸 없음), `result`(선택 `summary` 문자열, 선택 `usage`), `error`(필수 `code` `^[A-Z][A-Z0-9_]{0,63}$`, 필수 `retryable` boolean, 선택 `message`). `usage` = `{input_tokens, cached_input_tokens, output_tokens}` 셋 모두 필수, 0 이상 `9007199254740991` 이하 정수(`1.0`은 정수로 받는다), 다른 칸 거부. `result`·`error`가 최종 이벤트다.
- 줄 판정 코드: JSON이 아님·객체 아님·schema 불일치·`abi` 칸 없음 → `ABI_LINE_INVALID`. `abi` 칸이 있고 1이 아님 → `ABI_VERSION_UNKNOWN`.
- 틀(framing): stdout은 UTF-8, `\n`으로 끝나는 줄. 한 줄 상한 65536 UTF-8 바이트(`\n` 제외). 넘으면 그 즉시 `ABI_LINE_TOO_LONG`이고 넘은 부분을 메모리에 쌓지 않는다. EOF에 `\n` 없는 비어 있지 않은 조각이 남으면 `ABI_LINE_TRUNCATED`.
- 실행 판정(위에서 먼저 맞는 것): ① 첫 프로토콜 위반(위 다섯 코드, 두 번째 최종 이벤트 `ABI_DUPLICATE_FINAL`) — 감독자는 위반을 보는 즉시 지금처럼 그룹을 정리한다. ② `error` 이벤트 → `failed`, 그 `code`·`retryable`(exit code와 무관). ③ `result` + exit 0·signal 없음 → `succeeded`. ④ `result` + 0이 아닌 exit 또는 signal → `failed` `ABI_EXIT_AFTER_RESULT`. ⑤ 최종 없음 + exit 0 → `ABI_NO_RESULT`. ⑥ 최종 없음 + 0이 아닌 exit 또는 signal → `ABI_EXIT_FAILED`. 최종 뒤의 `progress`·`heartbeat`는 무시한다. 받은 `result`의 `usage`는 결과가 `failed`여도 attempt에 남긴다.
- 감독자가 붙이는 그 밖의 코드: 실행 명세 없음·시작 실패 `PROCESS_START_FAILED`, 출력 읽기 예외 `ABI_OUTPUT_UNREADABLE`. probe worker는 환경 변수가 틀리면 `{"abi":1,"type":"error","code":"ABI_ENV_INVALID","retryable":false}`를 내고 exit 2.
- 새 코드 11개(`ABI_LINE_INVALID`·`ABI_VERSION_UNKNOWN`·`ABI_LINE_TOO_LONG`·`ABI_LINE_TRUNCATED`·`ABI_DUPLICATE_FINAL`·`ABI_EXIT_AFTER_RESULT`·`ABI_NO_RESULT`·`ABI_EXIT_FAILED`·`ABI_OUTPUT_UNREADABLE`·`PROCESS_START_FAILED`·`ABI_ENV_INVALID`)는 `codes.ts` `CODES`에 exit 1, 한국어 meaning·hint와 함께 넣는다. `retryable`: `ABI_LINE_TRUNCATED`·`ABI_EXIT_FAILED`·`ABI_OUTPUT_UNREADABLE`·`PROCESS_START_FAILED`는 true, 나머지 false. README 오류 코드 표도 맞춘다(교차 시험이 있다). worker 자신의 `error.code`는 표에 없어도 그대로 남긴다.
- 환경 변수(schema `env.schema.json`, 나머지 변수는 허용): 필수 `BRAIN_ABI_VERSION`(`"1"`), `BRAIN_DATABASE_URL`(`postgres://`·`postgresql://`로 시작), `BRAIN_WORK_ID`·`BRAIN_ATTEMPT_TOKEN`(소문자 UUID), `BRAIN_WORK_KIND`·`BRAIN_TARGET_KIND`·`BRAIN_TARGET_ID`(빈 문자열 아님), `BRAIN_RUN_GENERATION`(실행 세대 = 청구 뒤 `attempts`, `^[1-9][0-9]{0,8}$`). 선택 `BRAIN_ACCOUNT`(빈 문자열 아님), `BRAIN_RANGE_FROM`·`BRAIN_RANGE_TO`(현지 날짜 `YYYY-MM-DD`, 포함 범위, 둘 다 있거나 둘 다 없음 — `dependentRequired`). schema로 나타낼 수 있는 규칙만 둔다(순서 비교 없음). 감독자는 `BRAIN_RUN_GENERATION`을 더해 넘기고, 계정·범위는 값을 가진 일감이 생길 때 채운다.
- stderr: 감독자가 읽어 끝 16 KiB만 들고 있다가(잘린 첫 줄은 버림) `maskSecrets(…, 'body')`로 가린 뒤 끝 4096 UTF-8 바이트(코드 포인트 경계)만 attempt `stderr`에 남긴다. 비었으면 null. 모든 결과의 attempt에 남긴다.
- 걸린 시간 `elapsed_ms` = 감독자 clock으로 자식 시작~exit(또는 정산 시점). 확정·취소 정산 모두 남기고, 이전 incarnation 회수 정산은 null.
- `0005_attempt_outcome_detail.sql`: `work_attempts`에 `error_code text`, `error_retryable boolean`, `input_tokens`·`cached_input_tokens`·`output_tokens bigint`, `elapsed_ms bigint`, `stderr text`. check: 토큰 셋은 모두 null이거나 모두 0 이상, `elapsed_ms >= 0`, `error_code`는 `outcome = 'failed'`일 때만, `error_retryable`은 `error_code`가 있을 때만. `CORE_SCHEMA_VERSION = 5`. 0001~0004는 고치지 않는다. AD-22(기본값·`now()` 없음).
- schema·fixture는 `packages/core/schemas/process-abi/v1/`·`packages/core/fixtures/process-abi/v1/`에 있고 `files`로 배포된다. 이전 `cases.json`은 `events.json`으로 바꾼다(12.1의 `heartbeat` invalid 판정은 이제 valid).

**Never:**
- JSON Schema 검증기 등 새 의존을 더하지 않는다.
- 일감 행의 재시도·종료 정책(지금은 모든 `failed`가 `retryDelayMs`로 다시 시도)과 `failures` 기록, 정체 판정, heartbeat의 임대 갱신은 바꾸지 않는다. `error_retryable`은 기록만 한다(AD-21 분류 적용은 다른 스토리).
- 취소·회수·`unknown` 경로의 판정 순서, 0004 판정 함수, core drain은 바꾸지 않는다.
- 작업 목록·doctor 표시는 만들지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상+usage | progress → result(usage 10/2/5), exit 0 | `succeeded`, 토큰 10·2·5, `elapsed_ms` 값 | — |
| usage 없음 | result(usage 없음), exit 0 | `succeeded`, 토큰 셋 null(0 아님) | — |
| usage 0 | usage 0/0/0 | 토큰 0·0·0 | — |
| 결과 없는 exit 0 | progress만, exit 0 | `failed` `ABI_NO_RESULT` | 재시도 예약 |
| 결과 뒤 exit≠0 | result(usage), exit 3 | `failed` `ABI_EXIT_AFTER_RESULT`, 토큰 남음 | 재시도 예약 |
| 최종 없이 죽음 | exit 2 또는 SIGKILL | `failed` `ABI_EXIT_FAILED` | 재시도 예약 |
| worker error | error(`GARMIN_AUTH`, false), exit 0 또는 1 | `failed` `GARMIN_AUTH`, `error_retryable` false | 재시도 예약(정책 불변) |
| 모르는 버전 | `{"abi":2,…}` | `failed` `ABI_VERSION_UNKNOWN`, 그룹 정리 | — |
| 깨진 줄 | `{`, `null`, `[]`, 모르는 칸, 음수·문자열·소수 usage | `failed` `ABI_LINE_INVALID` | — |
| 긴 줄 | 65537바이트 줄 | `ABI_LINE_TOO_LONG`(EOF 기다리지 않음) | — |
| 잘린 줄 | 마지막 `{"abi":1,"type":"res`, `\n` 없이 EOF | `ABI_LINE_TRUNCATED` | — |
| 중복 최종 | result 두 번 / result 뒤 error | `ABI_DUPLICATE_FINAL` | — |
| 최종 뒤 progress | result → progress, exit 0 | `succeeded` | — |
| stderr | 비밀 패턴 포함 20 KiB stderr | attempt `stderr` 가려짐, ≤4096바이트 | — |
| 시작 실패 | 명세 없음·spawn 실패 | `failed` `PROCESS_START_FAILED` | — |
| env | 필수 하나 없음, UUID 대문자, 범위 한쪽만 | probe가 `ABI_ENV_INVALID` error, exit 2 | — |

</intent-contract>

## Code Map

- `packages/core/src/process-abi/codec.ts` -- 지금 `decodeAbiLine`·`PROCESS_ABI_ENV`·두 URL. 이벤트 decoder, env decoder, 줄 나누기(문자열 조각을 받아 바이트로 상한), 실행 판정기(관찰 → 최종 판정)로 넓힌다. 줄 판정은 `{ok:false, code, reason}`. `utf8Bytes`·`truncateUtf8`(`domain/failure.ts`·`domain/sha256.ts`), `maskSecrets`(`domain/secret-patterns.ts`) 재사용. export는 `packages/core/src/index.ts`(→ `second_brain` facade로 이어짐).
- `packages/core/schemas/process-abi/v1/event.schema.json` -- 2020-12, `oneOf` 네 갈래로 넓힌다. `env.schema.json`(새), `README.md`(새, 한국어: 실행 판정 순서·상한·stderr·코드 목록·fixture 형식 — epic 13 Python 작성자가 읽는다).
- `packages/core/fixtures/process-abi/v1/cases.json` -- `events.json`으로 바꾼다: `{name, line, expect:'valid'|'invalid', code?}`. `env.json`(새): `{name, env, expect:'valid'|'invalid'}`. `runs.json`(새): `{name, stdout: (string | {repeat, count})[] (원문 조각, 줄바꿈 포함), exit: {code, signal}, expect: {outcome, code?, retryable?, usage: {...}|null}}`. 위 행렬의 줄·env·실행 행을 모두 담는다.
- `packages/core/src/ports/process.ts` -- `ProcessHandle.lines`를 원문 조각 `stdout: AsyncIterable<string>`와 `stderr: AsyncIterable<string>`로 바꾼다(`closeOutput` 의미 유지). 줄 나누기는 core가 한다.
- `apps/cli/src/runtime/process-group.ts` -- readline을 걷고 `setEncoding('utf8')`한 stdout·stderr 조각을 spawn 전에 버퍼링하는 지금 방식 그대로 내보낸다(`child.stderr.resume()`로 버리던 것을 대신).
- `packages/core/src/testing/fakes/process.ts` -- `push(line)`은 `line + '\n'`을 쓰도록 유지하고, `write(raw)`·`writeStderr(text)`를 더한다.
- `packages/core/src/queue/supervisor.ts:58-151` `execute` -- 판정기를 쓰고 `failed` 문자열 대신 판정의 코드·retryable·usage를 확정 입력에 싣는다. `lastError`는 `failureText`(코드와 메시지가 든 한국어 문장). 취소 분기 `stopped && failed !== undefined`의 뜻은 유지. `checkSchema(... { core: 3 })` 기본값은 건드리지 않는다.
- `packages/core/src/ports/store.ts:514-532` -- `FinishSupervisedWorkInput`에 선택 `elapsedMs`·`usage`(`{inputTokens, cachedInputTokens, outputTokens}`)·`errorCode`·`errorRetryable`·`stderr`, `SettleSupervisedAttemptInput`에 선택 `elapsedMs`·`stderr`.
- `packages/core/src/testing/fakes/store.ts:~100,1160-1230` -- `WorkAttempt` 스냅샷 타입과 finish·settle이 새 칸을 남긴다. `packages/postgres/src/work.ts:280-296` finish, settle -- 같은 칸을 `work_attempts`에 쓴다.
- `packages/postgres/migrations/0005_attempt_outcome_detail.sql`(새), `packages/postgres/src/migrate.ts` -- 버전 5. 버전 고정 시험(12.3이 3→4로 바꾼 곳 전부: postgres `store`·`cli`·`migrate` 시험, cli `install`·`setup`·`sessions-ingest`·`dispatch`·`doctor-run`·`queue-drain`·`daemon-run` 시험 등)을 `grep -rn`으로 찾아 4→5, 불일치 값 5→6, `migrate.test.ts` 목록에 `0005`.
- `apps/cli/src/daemon/supervisor.ts:31-35` -- env에 `BRAIN_RUN_GENERATION: String(item.attempts)`.
- `apps/cli/src/workers/process-probe.ts` -- `decodeAbiEnv`로 검사, 틀리면 `ABI_ENV_INVALID` error 이벤트 후 exit 2.
- `apps/cli/test/fixtures/process-worker.mjs` -- `lines`·`code`에 더해 `raw`(줄바꿈 없이 쓰기)·`stderr`·`signal`(자기에게 보낼 signal) 계획 칸.
- `packages/core/src/codes.ts:180-398` `CODES`, `README.md:~790` 오류 코드 표 -- 새 코드 11개.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/schemas/process-abi/v1/*`, `packages/core/fixtures/process-abi/v1/*` -- 위 schema·README·fixture 세 파일, `cases.json` 제거.
- [x] `packages/core/src/process-abi/codec.ts`, `packages/core/src/index.ts` -- 코덱·줄 나누기·판정기·상한 상수·URL(이벤트 schema, env schema, 세 fixture) export.
- [x] `packages/core/src/codes.ts`, `README.md` -- 코드 11개.
- [x] `packages/core/src/ports/{process,store}.ts`, fakes(`process.ts`·`store.ts`), `apps/cli/src/runtime/process-group.ts` -- 위 port 변경.
- [x] `packages/core/src/queue/supervisor.ts`, `apps/cli/src/daemon/supervisor.ts`, `apps/cli/src/workers/process-probe.ts` -- 판정·기록·env.
- [x] `packages/postgres/migrations/0005_attempt_outcome_detail.sql`, `migrate.ts`, `work.ts`, 버전 고정 시험들 -- 칸과 쓰기, 버전 5.
- [x] `packages/core/test/process-abi.test.ts` -- `every event fixture gets its expected verdict`, `every env fixture gets its expected verdict`, `every run fixture gets its expected verdict`(조각을 여러 크기로 쪼개 넣어도 같은 판정), `the core package tarball ships the ABI schemas and fixtures`(`packages/core`에서 `npm pack --dry-run --json`의 파일 목록에 두 schema·README·세 fixture·`dist/process-abi/codec.js`), schema의 네 갈래와 env 필수 목록이 코덱 상수와 같음.
- [x] `packages/core/test/supervisor-abi.test.ts`(새, fake launcher·fake store) -- 행렬의 감독자 행 전부: `snapshot().workAttempts`의 `outcome`·`errorCode`·`errorRetryable`·토큰·`elapsedMs`·`stderr`, 일감의 `lastError`·재시도 예약. 기존 `supervisor*.test.ts`는 새 port로 맞춘다.
- [x] `apps/cli/test/process-group.test.ts` -- 실제 Node 자식: 줄바꿈 없는 마지막 조각과 stderr가 원문 그대로 오고, 실제 자식으로 감독자를 한 번 돌려 `ABI_LINE_TRUNCATED`와 가린 stderr가 남음.
- [x] `packages/postgres/test/work-store.test.ts` -- PG에서 finish·settle이 새 칸을 남기고(직접 `select`), usage 없는 확정은 토큰 null, check 위반(토큰 일부만, `succeeded`에 `error_code`)은 DB가 거부.

**Acceptance Criteria:**
- Given 출하된 `@second-brain/core`의 schema·fixture 파일, when TS 코덱이 세 fixture 파일의 모든 case를 판정한다, then 모든 case의 판정·코드가 기대 판정과 같고 tarball 목록에 그 파일들이 있다.
- Given 데몬 감독자가 실제 자식을 띄운다, when 자식이 비밀이 든 stderr를 쓰고 `\n` 없이 끝난다, then attempt는 `failed`·`ABI_LINE_TRUNCATED`이고 `stderr`는 가려져 4096바이트 이하이며 일감은 재시도 예약된다.

## Implementation Notes

- 구현 세션(codex)이 `e4f8950`으로 커밋했다. 구현 세부와 검증 결과는 아래 Verification의 "구현 검증 결과"에 있다. 아래 Review Triage Log의 첫 두 행(머리글 없음)은 구현 세션이 커밋 전에 스스로 돌린 검토의 기록이다.
- 리뷰 패치: `apps/cli/src/runtime/process-group.ts`의 `buffer()`가 대기열이 `PROCESS_ABI_MAX_LINE_BYTES`(64 KiB)에 이르면 `stream.pause()`, 그 절반 아래로 줄면 `stream.resume()`한다. `apps/cli/test/process-group.test.ts`에 소비가 늦는 동안 16 MiB를 쓰려는 실제 자식이 막히고, 소비 재개 뒤 `ABI_LINE_TOO_LONG`으로 끝나는 시험을 더했다.

## Plan Change Log

## Review Triage Log

- `[medium]` `[patch]` (quick) `process-group.ts`의 stderr 대기열은 감독자가 OS·DB 조회를 기다리는 동안 소비되지 않아 무한히 늘 수 있다. `supervisor.ts`에서 시작 직후 stderr 읽기를 시작하여 조회 지연과 관계없이 16 KiB tail로 소비한다.
- `[medium]` `[patch]` (quick) `unknown` 정산은 `readingStopped`를 먼저 켜고 stderr 읽기를 기다리지 않아 대기열의 진단 꼬리를 잃을 수 있다. 판정 순서는 유지하고 출력 닫기 뒤 이미 받은 stderr를 모두 소비한 후 snapshot을 남긴다.

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` (quick) `apps/cli/src/runtime/process-group.ts:14`의 stdout 대기열에 상한·역압력이 없어, 감독자가 신원 조회·`recordSupervisedProcess`·`renewSupervisedLease`를 기다리는 동안 줄바꿈 없이 계속 쓰는 자식의 출력이 데몬 메모리에 쌓이고 `ABI_LINE_TOO_LONG` 판정이 늦어진다 — 확인: `packages/core/src/queue/supervisor.ts`에서 stdout 읽기(`read`)는 신원 조회와 기록 뒤에 시작되고 갱신 await 동안 멈춘다. 조치: adapter `buffer()`가 64 KiB에서 `pause()`, 32 KiB 미만에서 `resume()`하고, 실제 자식 16 MiB 시험을 더했다. 이후 `pnpm test` 117파일·2,935개 통과.

## Design Notes

- 판정을 core 순수 코드(줄 나누기 + 판정기)에 둔 이유: 같은 fixture(`runs.json`)를 감독자와 같은 코드로 돌려 갈라짐을 막는다. adapter는 원문 조각만 낸다.
- Python(epic 13)은 worker 쪽이다. `events.json`·`env.json`의 `expect`를 `jsonschema` 판정과 맞추고, 자기 encoder 출력을 schema로 검증한다. `runs.json`은 감독자 판정의 계약이다. stderr 가림은 TS 감독자의 일이라 fixture에 넣지 않는다.
- 오류 코드 표의 `retryable`은 분류 자료다. 감독자의 재시도 정책을 그것에 맞추는 일은 AD-21 분류 스토리로 남긴다(Never).

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project core test/process-abi.test.ts test/supervisor-abi.test.ts test/supervisor.test.ts test/supervisor-cancel.test.ts test/codes.test.ts` -- expected: 통과. fake launcher·fake store만 쓴다.
- `pnpm exec vitest run --project cli test/process-group.test.ts test/daemon-run.test.ts` -- expected: 통과. 실제 Node 자식(`process-worker.mjs`). PG 사전 조건: test-db global setup 또는 `BRAIN_TEST_DATABASE_URL`.
- `pnpm exec vitest run --project postgres test/work-store.test.ts test/migrate.test.ts test/store.test.ts test/cli.test.ts` -- expected: 통과. 관찰값: `work_attempts`의 새 칸, check 위반 SQLSTATE `23514`.
- `pnpm test` -- expected: build·typecheck·전체 vitest 통과.


**구현 검증 결과 (2026-10-29):**
- 이벤트 4종·환경 변수 decoder, 65536 UTF-8 바이트 framing, 첫 위반 우선 실행 판정과 stderr 가림·상한을 구현했다. schema 2개·한국어 규약·fixture 3개를 core tarball로 배포하며 기존 `cases.json`을 제거했다.
- 감독자·실제/fake 프로세스·probe와 attempt 상세 저장을 연결했다. 새 `0005_attempt_outcome_detail.sql`, `CORE_SCHEMA_VERSION = 5`, 오류 코드 11개와 README·버전 시험을 갱신했다. 0001~0004와 core drain, 취소·회수·unknown 판정 순서, 재시도 정책은 유지했다.
- `pnpm test` 최종 통과: build·typecheck와 117파일·2,934개 시험 전부 통과했다. `git diff --check` 통과.
- `process-abi.test.ts`가 events·env·runs의 모든 기대 판정과 여러 조각 크기, schema 상수 일치, `npm pack --dry-run --json` 파일 목록을 검증했다. `supervisor-abi.test.ts`가 실행 행렬의 outcome·오류 코드·retryable·usage·elapsed·stderr와 재시도를 검증했다.
- `process-group.test.ts`가 실제 Node 자식의 원문 출력, `ABI_LINE_TRUNCATED`와 가린 stderr·재시도 예약, probe의 환경 오류 계약을 검증했다. `work-store.test.ts`가 PostgreSQL 상세 저장·usage null과 CHECK 위반 SQLSTATE `23514`를 검증했다.
- quick 검토 2건을 모두 수정했다. stderr 소비를 OS/DB 조회 이전에 시작하며 unknown 정산 전에 이미 받은 stderr를 모두 읽는다. 지연·unknown 회귀 시험도 최종 전체 시험에 포함했다. 보류 항목과 계획 범위의 미완료는 없다.
- `error_retryable`은 기록만 하며 모든 failed의 기존 재시도 정책은 유지한다. 운영 설치·배포는 수행하지 않았다.

## Auto Run Result

상태: `built`. ticket 12.4를 구현하고 quick 검토를 마쳤다. 사람만 할 수 있는 작업은 없다. `tickets.py mark`는 실행하지 않았고 최종 완료 판정은 오케스트레이터가 한다.

**구현 요약:** 프로세스 ABI v1을 완성했다. 이벤트 네 종(`progress`·`heartbeat`·`result`(선택 `usage`)·`error`(`code`·`retryable`)), 환경 변수 계약(`BRAIN_RUN_GENERATION`, 선택 계정·현지 날짜 범위), 65536바이트 줄 상한·잘린 줄·중복 최종·모르는 버전 규칙, exit code와 최종 이벤트의 판정 순서를 schema 두 개·한국어 규약·기대 판정이 붙은 fixture 세 개로 두고 core 패키지에 실었다. 손으로 쓴 TS 코덱(이벤트·환경 변수 decoder, 줄 나누기, 실행 판정기)이 모든 fixture 판정과 같다. 감독자는 그 판정기로 attempt를 `failed`+오류 코드로 확정하고, 새 마이그레이션 `0005`의 칸에 `usage`·`elapsed_ms`·가린 stderr(끝 4096바이트)를 남긴다. 새 오류 코드 11개를 `codes.ts`와 README 표에 더했다. core 스키마 버전은 5다.

**변경 파일:**
- `packages/core/schemas/process-abi/v1/{event.schema.json,env.schema.json,README.md}` — 이벤트·환경 변수 schema와 판정 규약.
- `packages/core/fixtures/process-abi/v1/{events,env,runs}.json` — 기대 판정 fixture(31·21·42 case). `cases.json` 제거.
- `packages/core/src/process-abi/codec.ts` — decoder, framing, 실행 판정기, stderr 꼬리·가림.
- `packages/core/src/queue/supervisor.ts` — 판정기 사용, 오류 코드·usage·걸린 시간·stderr 기록, stderr 조기 소비.
- `packages/core/src/ports/{process,store}.ts`, `domain/work-item.ts`, `testing/fakes/{process,store}.ts` — 원문 stdout·stderr port, attempt 상세 입력·스냅샷.
- `packages/core/src/codes.ts`, `README.md` — 오류 코드 11개.
- `packages/postgres/migrations/0005_attempt_outcome_detail.sql`, `src/migrate.ts`, `src/work.ts` — attempt 칸·check, 버전 5, finish·settle 쓰기.
- `apps/cli/src/runtime/process-group.ts` — readline 대신 원문 조각, 64 KiB 역압력.
- `apps/cli/src/daemon/supervisor.ts`, `apps/cli/src/workers/process-probe.ts` — `BRAIN_RUN_GENERATION`, probe의 env 검사와 `ABI_ENV_INVALID` error 이벤트.
- 시험: `packages/core/test/{process-abi,supervisor-abi,codes}.test.ts`, `apps/cli/test/process-group.test.ts`, `apps/cli/test/fixtures/process-worker.mjs`, `packages/postgres/test/work-store.test.ts`, 버전 고정 시험들(4→5).

**시험 이름과 실행 명령(fixture 판정):** `packages/core/test/process-abi.test.ts`의 `every event fixture gets its expected verdict`, `every env fixture gets its expected verdict`, `every run fixture gets its expected verdict`, `the core package tarball ships the ABI schemas and fixtures`. 명령은 `pnpm build && pnpm exec vitest run --project core test/process-abi.test.ts`.

**리뷰 결과:** quick 렌즈 1건 — medium 1(patch). adapter stdout 대기열의 역압력 부재를 고쳤다(위 triage). deferred 0, 기각 0. 구현 세션이 커밋 전에 스스로 고친 medium 2건(stderr 조기 소비, unknown 정산 전 stderr 소비)도 Review Triage Log에 있다.

**후속 리뷰 권고:** `false`. 이번 검토 패치는 medium 1건(high 0)이고, 이름 붙일 미검증 위험이 없다.

**검증:** `pnpm test` 두 번(패치 전 117파일·2,934개, 패치 뒤 117파일·2,935개) 모두 build·typecheck·전체 vitest 통과. verbose 실행으로 `process-abi`(10)·`supervisor-abi`(12)·`process-group`(12→13)·PG `work-store`의 attempt 상세 시험 두 개가 돌고 통과했음을 확인했다. I/O 행렬 16행 모두 fixture·감독자·실제 자식·PG 시험이 덮는다.

**남은 위험:** 감독자 재시도 정책은 아직 `error_retryable`·오류 코드 표의 `retryable`을 쓰지 않는다(모든 `failed`가 다시 시도, AD-21 분류는 다른 스토리). 범위 환경 변수는 날짜 순서를 검사하지 않는다(schema로 나타낼 수 있는 규칙만). fixture case 이름 일부에 Python 표기(`None`, dict repr)가 남아 있으나 판정에는 영향이 없다.
