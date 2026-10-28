---
title: '프로세스 ABI v1 완성: 같은 fixture에 TS 코덱이 기대 판정을 내고, 비정상 종료가 정한 결과로 남는다'
type: 'feature'
ticket: '4'
created: '2026-10-29'
status: blocked
baseline_revision: 541365e705cbe670d24386c084ba32b1d072fef1
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-attempt-token-db-plan.md'
warnings: [oversized]
deferred: []
blocked_at: "2026-10-29"
blocked_reason: "intent gap: 줄별 독립 maskSecrets 계약에서는 TOKEN= 또는 Bearer 뒤 줄바꿈에 이어지는 자격 증명이 평문으로 남는다. 비밀 비노출 요구와 충돌하므로 PEM 외 패턴도 줄 사이 문맥을 보존하도록 계약을 바꿀지 결정이 필요하다. 시도 변경은 tickets/story-abi-v1-fixture-ts-plan.patch에 보존했다."
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
- stderr(2026-10-29 두 번째 escalation 해소로 다시 고침, 전체를 한 번 가린 다음 자른다): ① 감독자는 stderr 원문을 UTF-8 바이트로 세며 최대 1 MiB(1048576바이트)까지 그대로 보관한다. 줄 단위로 나누거나 미리 버리지 않는다. ② 1 MiB를 한 바이트라도 넘으면 그 attempt는 넘침으로 표시하고 보관한 원문을 버린다. 그 뒤 stderr는 계속 읽어 소비하되 보관하지 않고, 결과는 고정 안내문 `[stderr 생략: 원문 1 MiB 초과]`만이다(원문 유래 문자 없음). ③ 넘치지 않았으면 EOF(또는 정산 시점)에 `maskSecrets(전체 원문, 'body')`를 한 번만 부른다. 줄마다 따로 부르지 않는다(키와 값이 빈 줄을 사이에 두고 다른 줄에 있는 비밀, END 없는 PEM이 전체 문맥에서만 가려진다). ④ 그 결과의 끝 최대 4096 UTF-8 바이트를 코드 포인트 경계에서 취하고, 시작이 줄 중간이면 그 부분 줄을 버린다. 빈 문자열이면 null. 중간 값은 attempt에 남기지 않고 이 최종 결과만 남긴다. 모든 결과의 attempt에 남긴다. 근거: `12-4-stderr-rule-check.md`(Codex 검증, 앞이 잘린 원문을 덜어내는 규칙들의 반례). 1 MiB를 넘는 stderr의 진단 내용은 잃는다(비밀 비노출 우선).
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
| stderr PEM 경계 | 합성 PEM 개인 키 85줄 뒤 `TOKEN=` + 14500자(전체 1 MiB 이내) | PEM 본문 줄·TOKEN 값이 없고 가림 표식만 있음, ≤4096바이트 | — |
| stderr 줄로 갈린 비밀 | `TOKEN=\n<값>`, `Bearer\n<값>`, `password:\n<값>`, `TOKEN=\n\n\n<값>`, `TOKEN\n\n=\n\n<값>`, `비밀번호\n:\n<값>`(합성 값) | 값이 모두 가려짐 | — |
| stderr PEM END 없음 | BEGIN 표식 뒤 본문만 이어지다 EOF | BEGIN부터 끝까지 가려짐 | — |
| stderr 1 MiB 초과 | 1048577바이트(비밀 포함 여부와 무관) | `[stderr 생략: 원문 1 MiB 초과]`만, 원문 문자 없음, 그동안 보관 메모리 1 MiB 이하 | — |
| stderr 1 MiB 정확히 | 1048576바이트 | 넘침 아님, 전체 가림 뒤 ≤4096바이트 | — |
| stderr 긴 한 줄 | `\n` 없는 70000바이트 줄 | 가린 뒤 끝 4096바이트, 시작이 줄 중간이므로 부분 줄을 버려 null | — |
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

### 2026-10-29 — Review pass
- verdicts: 28 findings — high 1, medium 15, low 2, false 7, maybe-false 3
- findings:
  - `[medium]` `[bad_plan]` blind-hunter 1: 잘못된 UTF-8 수용 — 실제 자식의 JSON 문자열 안 0xff가 adapter setEncoding에서 U+FFFD로 치환되어 exit 0을 반환했다. codec은 그 result를 정상으로 읽는다. UTF-8 계약을 강제하지 않는다.
  - `[medium]` `[bad_plan]` blind-hunter 2: 지연 중 framing 판정 — supervisor.ts의 stdout 읽기는 신원 조회·프로세스 기록 뒤 시작하고 임대 갱신도 await한다. 역압력은 메모리만 제한하며 이미 도착한 긴 줄·깨진 줄의 판정 지연을 없애지 않는다. 기존 quick의 무한 대기열 주장과 다르다.
  - `[medium]` `[defer]` blind-hunter 3: 기본 schema 버전 3 — checkSchema의 정확한 버전 비교 때문에 기본값은 버전 5를 거부한다. baseline에도 있던 문제이고 실제 CLI는 opened.expected를 전달하여 영향이 없다. intent_gap 우선으로 신규 deferred 항목 처리는 하지 않았다.
  - `[high]` `[intent_gap]` blind-hunter 4: 잘린 PEM 본문 유출 — createAbiStderr는 16384바이트로 자른 후 시작 표식 없는 본문을 maskSecrets에 넘긴다. 합성 PEM 85줄 뒤 TOKEN=와 14500자 값을 붙이면 최종 1902바이트에 PEM 본문이 남고 TOKEN만 가려진다. intent-contract의 고정 순서가 비밀 비노출 요구와 충돌한다. 시도 diff는 story-abi-v1-fixture-ts-plan.patch에 보존했다.
  - `[maybe-false]` `[defer]` blind-hunter 5: 취소·unknown에서 usage 손실 — finish에만 usage가 있고 settle에는 없음을 확인했다. result usage 보존 요구가 취소·불명에도 적용되는지는 기존 취소 판정 유지 제약과 함께 계약을 확인해야 한다. 사실일 경우 medium이다. intent_gap 우선으로 보류 목록을 바꾸지 않았다.
  - `[low]` `[reject]` blind-hunter 6: fake와 PG CHECK 불일치 — memoryStore는 잘못된 숫자를 허용하지만 감독자는 decoder가 검증한 비음수 토큰과 Math.max(0, elapsed)를 전달한다. 일상 호출의 불일치 경로는 확인되지 않았고 fake에 검증 분기를 추가하는 복잡도에 비해 효과가 작아 기각한다.
  - `[medium]` `[bad_plan]` blind-hunter 7: schema 의미 동등성 검증 — process-abi.test.ts는 종류와 env.required만 비교한다. usage.maximum·additionalProperties·dependentRequired가 달라져도 fixture 판정 시험은 배포 schema를 읽지 않아 통과한다. epic 13 소비 계약의 회귀를 놓친다.
  - `[medium]` `[bad_plan]` blind-hunter 8: 다중 바이트 상한 fixture — runs.json의 상한은 ASCII이고 Unicode 사례는 짧다. 다중 바이트·조각 경계에서 65536바이트 허용과 65537바이트 거부를 검증하지 않는다.
  - `[medium]` `[bad_plan]` blind-hunter 9: 출력 예외 그룹 정리 시험 — supervisor-abi.test.ts의 stdout 예외는 base launcher 자식을 다른 kit inspector로 관찰하고 수동 exit시킨다. 살아 있는 자식의 stdout·stderr 예외에서 자동 그룹 정리는 검증하지 않는다.
  - `[medium]` `[bad_plan]` blind-hunter 10: worker retryable와 signal — worker error 실행 fixture는 false이고 signal이 없다. worker true 보존과 error가 signal보다 우선하는 분기의 회귀를 놓친다.
  - `[maybe-false]` `[defer]` edge-case-hunter 1: Readable 내부 result 유실 — closeOutput은 queue만 보존하고 stream.read 없이 destroy한다. 실제 65536바이트 뒤 지연된 result·exit 0 재현은 result를 보존했고 Node 내부 flushStdio의 exit 뒤 resume도 확인했다. 더 많은 청크와 갱신 지연이 겹친 감독자 재현이 필요하다. 사실일 경우 medium이며 intent_gap 우선으로 보류 목록은 바꾸지 않았다.
  - `[medium]` `[bad_plan]` edge-case-hunter 2: 잘못된 UTF-8 치환 — blind-hunter 1과 같은 원인이다. 실제 0xff가 U+FFFD로 바뀌었고 fatal decoding이 없다.
  - `[medium]` `[bad_plan]` verification-gap 1: UTF-8 바이트 경계 시험 — 사전 검증된 공백이다. ASCII 상한과 짧은 Unicode 사례만으로 summary 한글 22000자를 문자 수로 잘못 계산하는 회귀를 잡지 못한다.
  - `[medium]` `[bad_plan]` verification-gap 2: stderr 읽기 예외 시험 — 사전 검증된 공백이다. stdout 예외만 발생시켜 정상 result·exit 0과 stderr iterator 예외가 겹칠 때 ABI_OUTPUT_UNREADABLE·retryable=true 저장을 검증하지 않는다.
  - `[medium]` `[bad_plan]` verification-gap 3: worker true 보존 시험 — 사전 검증된 공백이다. worker fixture는 false뿐이라 그 분기가 항상 false를 반환하는 회귀를 놓친다. 프로토콜 자체 오류 true는 별도 경로다.
  - `[false]` `[reject]` intent-alignment 1: 공유 fixture 판정 — 모든 events·env·runs case를 TS 시험이 순회하고 run은 여러 조각 크기로 검사한다. 보고서도 이 인수 조건의 직접 충족을 확인했으므로 결함이 아니다.
  - `[medium]` `[bad_plan]` intent-alignment 2: schema와 TS 의미 동등성 — blind-hunter 7과 같은 검증 공백이다. Python 구현은 후속 에픽이지만 현재 배포 schema 제약의 회귀는 이 티켓의 소비 계약에 영향을 준다.
  - `[false]` `[reject]` intent-alignment 3: 전 행렬의 실제 자식→PG 관통 시험 — verify는 감독자 시험과 저장 결과를 요구하며 모든 사례에 실제 자식과 PG를 동시에 쓰라고 요구하지 않는다. fake 감독자 행렬·실제 프로세스 시험·PG 저장 계약 시험으로 명시 조건을 확인한다.
  - `[maybe-false]` `[defer]` intent-alignment 4: 취소·불명 usage 범위 — blind-hunter 5와 같은 계약 확인 사항이다. 사실일 경우 medium이며 해당 정산의 usage 요구 확인이 필요하다. intent_gap 우선으로 보류 목록을 바꾸지 않았다.
  - `[false]` `[reject]` intent-alignment 5: 공통 stderr fixture 부재 — 원문은 stderr 사례를 모두 언어 공통 fixture에 넣으라고 요구하지 않는다. TS 순수 코드·감독자·실제 자식 시험에서 확인하며 Python은 작업자다. 실제 PEM 결함은 별도 high 행으로 채택했다.
  - `[false]` `[reject]` intent-alignment 6: tarball 설치·Python 소비 부재 — npm pack --dry-run --json 파일 목록으로 이 티켓의 배포 파일 포함 여부를 직접 확인한다. Python 소비는 epic 13이며 설치 관통 시험까지 요구하지 않는다.
  - `[low]` `[patch]` intent-alignment 7: elapsed 시작점 — startedAt은 명세 생성·launcher.start 이전이라 자식 시작 전 대기도 포함된다. 계획의 자식 시작부터 측정한다는 문장보다 넓다. intent_gap 우선으로 패치는 적용하지 않았다.
  - `[false]` `[reject]` intent-alignment 8: 안전한 정수 상한 — schema와 decoder가 같은 상한을 쓰며 최대·초과 fixture도 있다. JS의 정확한 정수 범위를 정한 것으로 결함을 입증하지 않는다.
  - `[false]` `[reject]` intent-alignment 9: 날짜 순서 검사 부재 — 계획은 schema로 나타낼 수 있는 형식·동시 존재만 검사한다고 명시한다. 원문도 날짜 비교 동작을 요구하지 않으며 역순 허용 fixture는 기록된 계약과 같다.
  - `[false]` `[reject]` intent-alignment 10: account·range 전달 부재 — 현재 process_probe에 account·range 값이 없고 schema·decoder에는 선택 계약이 있다. 값 없는 probe에 값을 만들어 전달하라는 요구는 없다.
  - `[medium]` `[bad_plan]` intent-alignment 11: worker true fixture 부재 — verification-gap 3과 같은 검증 공백이다. 프로토콜 오류 true와 worker 분류 true는 별도 경로다.
  - `[medium]` `[bad_plan]` intent-alignment 12: UTF-8 거부 부재 — blind-hunter 1 및 edge-case-hunter 2와 같은 원인이다. 실제 0xff를 치환하며 정상 JSON result로 읽는다.
  - `[medium]` `[bad_plan]` intent-alignment 13: 지연 중 즉시 판정 부재 — blind-hunter 2와 같은 원인이다. 실제 adapter 시험은 지연 중 역압력과 소비 재개 후 실패만 확인하며 신원·DB 지연 중 즉시 판정하지 않는다.

- 네 렌즈가 모두 반환한 뒤 판정했다. 같은 원인은 묶되 모든 관찰을 개별 행으로 보존했다. intent_gap이 우선하므로 bad_plan·patch·defer 후속 처리는 수행하지 않았다. 기존 deferred-work 원장과 기존 triage 행을 수정하지 않았다.

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 1, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` (quick) `packages/core/src/process-abi/codec.ts`의 `createAbiStderr` `append()`가 줄바꿈마다 보관 중인 16 KiB 꼬리 전체를 `tailUtf8()`로 다시 훑고 코드 포인트마다 `utf8Bytes()` 배열을 할당하여, 감독자가 `feed`를 동기 호출하는 동안 데몬 이벤트 루프(stdout 판정·임대 갱신·취소)가 막힌다 — 확인: 빌드된 `dist/process-abi/codec.js`로 꼬리가 찬 상태에서 `'\n'.repeat(65536)` 조각 하나가 50077ms, 80바이트 줄 64 KiB가 628ms 걸렸다(이전 구현은 조각마다 한 번만 계산). 조치: 구현 세션이 `a385a76`에서 가린 줄을 바이트 길이와 함께 연결 리스트로 보관하고 합계가 `PROCESS_ABI_STDERR_BUFFER_BYTES`를 넘으면 앞쪽 줄만 통째로 버리게 바꿨다(잘린 첫 줄 버림·끝 4096바이트 코드 포인트 경계 유지). 1초 미만 회귀 시험을 더했고, 같은 측정이 7ms·10ms로 줄었다.

### 2026-10-29 — Review pass
- verdicts: 17 findings — high 3, medium 4, low 2, false 8, maybe-false 0
- findings:
  - `[high]` `[intent_gap]` blind-hunter 1: 줄바꿈 뒤 자격 증명 유출 — 빌드된 코덱에 TOKEN=\nSyntheticSecret123\n, Bearer\nabcdefghijklmnopqrst\n, password:\nhunter2x\n을 공급하면 값이 그대로 남는다. 같은 원문을 maskSecrets 전체 호출에 넣으면 가려진다. 계약의 줄별 독립 maskSecrets 처리와 비밀 비노출 요구가 충돌한다. 시도 변경은 story-abi-v1-fixture-ts-plan.patch에 보존했다.
  - `[false]` `[reject]` blind-hunter 2: 긴 PEM 줄 우선순위 — 계약은 PEM 블록 안의 줄을 내보내지 않도록 명시한다. PEM 가림 우선과 기존 시험 기대값이 그 규칙을 따른다. 계획이나 문구만 고치라는 지적도 기각한다.
  - `[medium]` `[bad_plan]` blind-hunter 3: 초과 줄 뒤쪽 BEGIN 시험 공백 — 직접 시험은 이미 열린 PEM의 긴 줄 END만 검사한다. 초과 후 BEGIN 탐지를 없애는 회귀는 본문을 노출하면서 기존 시험을 통과한다. intent_gap 우선으로 계획 수정과 재구현은 수행하지 않았다.
  - `[low]` `[bad_plan]` blind-hunter 4: EOF 상위 서로게이트 분기 시험 공백 — 새 Unicode 시험은 완전한 문자로 끝나 value의 pendingHigh 별도 분기와 비파괴 스냅샷 뒤 후속 low surrogate를 확인하지 않는다. 직접 코덱 소비자의 경계 진단 차이에 해당한다. intent_gap 우선으로 후속 처리는 하지 않았다.
  - `[medium]` `[bad_plan]` blind-hunter 5: 취소·unknown의 미종결 PEM 저장 시험 공백 — 기존 취소·unknown은 TOKEN 가림과 stderr 배출을 검사하지만 새 PEM 상태 처리 시험 세 건은 성공 정산만 검사한다. 미종결 PEM의 정산 경계 회귀를 놓친다. intent_gap 우선으로 후속 처리는 하지 않았다.
  - `[high]` `[intent_gap]` edge-case-hunter 1: 줄 사이 비밀 문맥 손실 — blind-hunter 1과 같은 재현으로 TOKEN 및 Bearer 값이 저장용 value에 남는 것을 확인했다. 줄별 독립 가림을 유지할지, 줄 사이 문맥을 보존할지 계약 결정이 필요하다.
  - `[high]` `[intent_gap]` edge-case-hunter 2: 실패 attempt의 비밀 저장 — supervisor의 readStderr는 같은 코덱에 원문을 공급하고 실패 확정 detail에도 stderr.value()를 전달한다. stdout의 ABI_LINE_TRUNCATED 판정은 이 값을 다시 가리지 않는다. edge-case-hunter 1과 같은 원인이다.
  - `[medium]` `[bad_plan]` verification-gap 1: 초과 줄 내부 새 PEM BEGIN 검증 누락 — 사전 검증된 공백이다. 70000자 뒤 BEGIN, 다음 줄 본문을 공급하는 시험이 없고 기존 END 시험만으로 BEGIN 경로의 회귀를 검출하지 못한다. blind-hunter 3과 같은 원인이며 intent_gap 우선으로 후속 처리는 하지 않았다.
  - `[low]` `[bad_plan]` verification-gap 2: 허용 범위 이모지 줄의 surrogate 분할 시험 누락 — 사전 검증된 공백이다. TOKEN= 뒤 이모지 16382개는 65534바이트인데 코드 단위별 입력에서 보류 처리가 없어지면 생략 표식이 된다. 기존 초과 입력은 두 구현 모두 생략되어 회귀를 놓친다. intent_gap 우선으로 후속 처리는 하지 않았다.
  - `[false]` `[reject]` intent-alignment 1: 16 KiB 밖 BEGIN의 PEM 유출 — 렌즈도 새 합성 PEM 85줄·TOKEN 시험이 정확한 기대 문자열을 비교한다고 확인했다. 이 항목에는 현재 결함 주장이 없다.
  - `[false]` `[reject]` intent-alignment 2: END 없는 PEM EOF — 순수 코덱과 감독자 시험이 본문 없이 가림 표식만 기대한다. 성공 이외 경로 공백은 별도 6행으로 기록하며 이 정상 EOF 주장은 결함이 아니다.
  - `[false]` `[reject]` intent-alignment 3: 초과 줄 즉시 폐기·메모리 계측 — consume은 상한 초과 즉시 line을 비우고 oversized 동안 새 문자를 쌓지 않는다. marker 상태도 고정 길이다. 메모리 계측 부재만으로 폐기 결함은 성립하지 않는다.
  - `[false]` `[reject]` intent-alignment 4: 최종 4096바이트 다중 바이트 경계 검증 부재 — 기존 process-abi.test.ts의 한😀 반복 시험과 supervisor-abi.test.ts의 다중 바이트 꼬리 시험이 4096바이트 이하와 U+FFFD 비포함을 검사한다. 새 diff에 추가되지 않았다는 사실은 저장소 검증 부재를 뜻하지 않는다.
  - `[false]` `[reject]` intent-alignment 5: PEM label 인식 범위 — 기존 maskSecrets의 private_key 정규식은 [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?와 END의 [A-Z0-9 ]*를 쓴다. 새 상태 기계도 같은 문자 집합과 접미사를 인식한다. 구체적인 불일치 입력은 제시되지 않았다.
  - `[medium]` `[bad_plan]` intent-alignment 6: 모든 정산의 새 PEM 가림 검증 — blind-hunter 5와 같은 공백이다. 성공 정산 외 취소·unknown의 PEM 상태가 마지막 조각까지 안전하게 남는지는 기존 TOKEN 시험만으로 보장되지 않는다. intent_gap 우선으로 후속 처리는 하지 않았다.
  - `[false]` `[reject]` intent-alignment 7: 감독자 처리 자원 관통 시험 — 코덱은 동기 호출이고 새 시험은 실제 64 KiB 줄바꿈 처리 시간을 직접 제한한다. 감독자의 별도 응답 시간 계측 부재만으로 현재 자원 제한 결함이 입증되지는 않는다.
  - `[false]` `[reject]` intent-alignment 8: 전체 ABI를 이번 diff만으로 입증 불가 — 후속 검토 기준 이후 diff가 stderr에 집중된 것은 사실이다. 기존 fixture·schema·실행 판정·PG 저장 시험이 저장소에 남고 pnpm test 전체가 통과하므로 이번 diff의 파일 목록만으로 전체 ABI 결함은 성립하지 않는다.

- 네 렌즈의 결과가 모두 반환된 뒤 판정했다. intent-alignment 표의 여덟 관찰도 빠짐없이 각각 기록했다. intent_gap이 우선하므로 bad_plan·patch·defer 후속 처리를 수행하지 않았다. 기존 원장 항목과 과거 triage는 수정하지 않았다.

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



## 2026-10-29 — stderr 계약 후속 구현

- `createAbiStderr`가 줄마다 먼저 가린 뒤 16 KiB 꼬리를 보관한다. PEM BEGIN/END 상태는 조각과 줄 사이에 유지하며, END 없는 블록도 EOF까지 본문을 남기지 않는다. 65536 UTF-8 바이트를 넘는 줄은 즉시 버리고 생략 표식으로 바꾼다. 최종 저장은 코드 포인트 경계에서 끝 4096바이트다.
- ABI README의 stderr 절을 같은 계약으로 갱신했다. 순수 코덱과 감독자에 PEM 85줄 + 긴 TOKEN, 미종결 PEM, 70000바이트 줄, 여러 조각 크기와 Unicode 경계의 회귀 시험 14개를 추가했다. 기존 schema·fixture·마이그레이션·재시도와 취소 판정은 유지한다.
- 독립 quick inspection에서 새 지적은 없었다. END 빈 label 허용과 시험 tuple 정리 후에도 추가 inspection에서 새 지적은 없었다. 기존 thorough triage는 보존했다.
- 구현 검증: `pnpm test`의 build·typecheck와 117파일·2949개 시험 통과. 마지막 정리 뒤 build·typecheck와 core 집중 5파일·254개 시험도 통과했다. `git diff --check` 통과.
- 이번 stderr 변경의 미완료는 없다. 기존 triage의 잘못된 UTF-8 치환 수용, 신원/DB 조회·임대 갱신 중 stdout 판정 지연, launcher 시작 이전부터 재는 elapsed 시작점은 남아 있다. 기존 deferred-work 원장은 수정하지 않았다. 운영 설치·배포는 수행하지 않았다.

- 최종 상태 재검증: `pnpm test` 재실행도 build·typecheck와 117파일·2949개 시험 전부 통과했다(51.65초).

## Auto Run Result

상태: `blocked`. `bmad-build-auto`의 HALT에서만 `tickets.py mark 12.4 blocked`를 실행했다. 티켓을 `done`으로 표시하지 않았다.

- 중단 이유: `intent gap`. `TOKEN=\nSyntheticSecret123\n`, `Bearer\nabcdefghijklmnopqrst\n`, `password:\nhunter2x\n`에서 줄마다 독립적으로 호출하는 `maskSecrets`는 다음 줄 값을 평문으로 반환한다. 전체 원문에 대한 기존 `maskSecrets` 호출은 같은 값을 가린다. 계약이 PEM 이외의 줄에 독립 호출을 명시하므로 구현만 바꿔 해결할 수 없다.
- 필요한 결정: PEM 이외 비밀 패턴에도 줄 사이 문맥을 보존하도록 계약을 확장할지, 지원하는 비밀 형식의 경계를 별도로 정할지 결정해야 한다. 비밀 비노출 요구를 유지하려면 전자를 권장한다. 연속 빈 줄·EOF·상한 초과에서도 문맥과 비밀 값을 어떻게 폐기할지 함께 확정해야 한다.
- 검토: `thorough` 네 렌즈 완료. 총 17개 관찰을 개별 판정했다(high 3, medium 4, low 2, false 8, maybe-false 0). high 세 관찰은 줄 사이 자격 증명 노출이라는 한 원인이다. 시험 공백 다섯 관찰은 bad_plan으로 기록했다. 기각 여덟 관찰의 이유는 이번 Review Triage Log에 각각 남겼다. intent_gap 우선으로 패치·보류 등록·계획 재작성은 수행하지 않았다. 기존 deferred-work 원장과 항목은 수정하지 않았다.
- 보존 및 원복: 기준 revision `541365e705cbe670d24386c084ba32b1d072fef1` 이후의 stderr 구현·규약·시험 변경을 `_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-abi-v1-fixture-ts-plan.patch`에 보존했다. 구현 세션이 workflow의 intent_gap 절차에 따라 다음 네 파일을 그 revision 내용으로 원복했다. 기존 커밋 기록은 유지했다.
  - `packages/core/src/process-abi/codec.ts` — stderr 선가림과 연결 리스트 보관 구현을 원복.
  - `packages/core/schemas/process-abi/v1/README.md` — stderr 규약 변경을 원복.
  - `packages/core/test/process-abi.test.ts` — 후속 stderr 회귀 시험을 원복.
  - `packages/core/test/supervisor-abi.test.ts` — 후속 PEM·긴 줄 저장 시험을 원복.
- 검증: 원복 전 `pnpm test`에서 build·typecheck 및 117파일·2950개 시험이 통과했다(51.46초). 별도 Node 재현으로 위 세 자격 증명 유출을 확인했다. 원복 후 네 파일이 기준 revision과 같음을 확인했다. 전체 시험 결과는 원복 전 검토 대상에 대한 결과이며 원복 후에는 재실행하지 않았다. 계획 EOF 빈 줄은 결과 기록 시 정리했다.
- 남은 위험: 현재 작업 트리는 의도적으로 stderr 후속 변경 이전 상태다. 원복된 코덱에는 앞선 triage에서 확인한 잘린 PEM 본문 노출 문제가 다시 존재한다. 저장한 patch는 그 수정과 성능 패치를 함께 보존한다. 계약 해소 후 patch를 다시 적용하고 이번 마스킹 결함과 시험 공백을 고쳐 재검토해야 한다. 운영 설치·배포·push·새 커밋은 하지 않았다.
