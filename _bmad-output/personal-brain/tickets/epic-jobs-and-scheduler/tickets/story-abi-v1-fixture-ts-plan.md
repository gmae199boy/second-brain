---
title: '프로세스 ABI v1 완성: 같은 fixture에 TS 코덱이 기대 판정을 내고, 비정상 종료가 정한 결과로 남는다'
type: 'feature'
ticket: '4'
created: '2026-10-29'
status: done
baseline_revision: ec91837a6e83385ab98b071a2d023ab439e1a019
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 2
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/epic-jobs-and-scheduler.md'
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-jobs-and-scheduler/tickets/story-attempt-token-db-plan.md'
warnings: [oversized]
deferred:
  - summary: >-
      기존 비밀 탐지기는 따옴표 직후 줄바꿈이 있는 영어 keyword 값을 탐지하지 못한다.
    evidence: |-
      TOKEN="\nSyntheticSecret123\n"을 기준 revision ec91837a6e83385ab98b071a2d023ab439e1a019의 maskSecrets와 현재 구현에 넣으면 둘 다 그대로 반환한다. 기존 VALUE·인용 정책의 한계이며 이번 성능 변경의 회귀가 아니다. 지원 형식과 문장 보존 정책을 정한 뒤 별도로 탐지기를 개선해야 한다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: high
  - summary: >-
      기존 영어 문장 예외는 명시적 keyword 뒤 다음 줄의 여러 단어 비밀번호도 그대로 남긴다.
    evidence: |-
      password:\ncorrect horse battery staple\n은 기준 revision과 현재 모두 그대로 반환한다. keywordValueLooksLikeSecret가 뒤 단어를 문장으로 판정하는 기존 정책이며 새 전체 문맥 전달이나 색인의 회귀가 아니다. 명시적 대입의 여러 단어 값을 어디까지 탐지할지 별도 정책 검토가 필요하다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: high
  - summary: >-
      기존 영어 인용 값 처리도 비밀에 포함된 끝 괄호를 가림 밖에 남긴다.
    evidence: |-
      password="abc)"는 기준 revision과 현재 모두 닫는 괄호를 가림 밖에 남기고, password=")))"는 그대로 반환한다. 기존 trimClosers가 인용 값에도 적용되는 동작이다. 닫힌 인용 값의 괄호 처리 규칙을 별도로 고쳐야 한다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: high
  - summary: >-
      기존 한국어 keyword 패턴은 따옴표로 둘러싼 값을 탐지하지 못한다.
    evidence: |-
      비밀번호: "SyntheticSecret123"은 기준 revision과 현재 모두 그대로 반환한다. 한국어 패턴에는 영어 open 인용 그룹이 없으며 이번 색인 변경 전부터 존재한 한계다. 한국어 인용 값 지원을 별도로 정의하고 구현해야 한다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: high
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

- 이번 thorough 복구 구현 세션은 `01a184b9-2e8b-7ea3-a908-90b0982e4900`, 메모리 복구와 최종 직접 패치 세션은 `01a184c2-1860-7972-82d9-90cb76db0b3a`다. 표식 조회·값 구간 재사용·희소 괄호/Unicode 색인으로 반복 처리 비용과 대형 본문 할당을 줄였다. private 색인은 후보 접미부에서만 만들며 더 앞선 후보에서는 다시 만든다. 패턴 버전은 최종 3이다.

- 구현 세션(codex)이 `e4f8950`으로 커밋했다. 구현 세부와 검증 결과는 아래 Verification의 "구현 검증 결과"에 있다. 아래 Review Triage Log의 첫 두 행(머리글 없음)은 구현 세션이 커밋 전에 스스로 돌린 검토의 기록이다.
- 리뷰 패치: `apps/cli/src/runtime/process-group.ts`의 `buffer()`가 대기열이 `PROCESS_ABI_MAX_LINE_BYTES`(64 KiB)에 이르면 `stream.pause()`, 그 절반 아래로 줄면 `stream.resume()`한다. `apps/cli/test/process-group.test.ts`에 소비가 늦는 동안 16 MiB를 쓰려는 실제 자식이 막히고, 소비 재개 뒤 `ABI_LINE_TOO_LONG`으로 끝나는 시험을 더했다.

## Plan Change Log

### 2026-10-29 — 동기 가림 비용 복구

- 원인: 전체 문맥 계약을 구현하면서 URL 정규식만 비용을 검증했고, 표식 조회·열린 호출·중첩 호출의 반복 접미부 탐색을 빠뜨렸다. 1 MiB 이내 입력에서도 감독자의 동기 정산이 막힌다.
- 복구 순서: 소스·시험·출하 ABI README의 이번 기준 커밋 이후 변경만 `ec91837a6e83385ab98b071a2d023ab439e1a019` 상태로 되돌린 뒤 최신 intent-contract 전체 문맥 계약을 다시 도출한다. 계획·티켓·원장·커밋 이력은 되돌리지 않는다. 기존 변경은 `1fe745bcd970e03292f67117b87c5b99a6c19a73`에 보존되어 있다. 원장 항목을 고치거나 상태를 바꾸지 않는다. 계획의 status와 ticket 상태도 바꾸지 않으며 커밋은 조율자가 한다.
- KEEP: 1 MiB 원문 보관과 초과 즉시 전부 폐기·계속 소비, 전체를 한 번 가리기, 최종 4096바이트와 부분 줄 버림, NUL 후처리, 비파괴 캐시, 줄 사이 비밀·PEM·모든 정산·Unicode·지연 중 소비 시험을 모두 보존한다. URL 정규식의 선형 처리와 기존 value 집합도 보존한다. 기존 deferred 항목과 triage는 수정하지 않는다.
- `packages/core/src/domain/secret-patterns.ts`: 표식 포함 여부는 정렬 구간 조회로 처리한다. 같은 줄 괄호 짝과 접미부 괄호/closer 정보를 필요에 따라 한 번 계산하여 `isWholeCall`·`trimClosers`가 반복해서 긴 접미부를 훑지 않게 한다. 기존 가림 결과·span·hash·코드 포인트 위치·인용·거부 후보 내부 재탐색 의미를 보존한다. 새 의존이나 공용 API를 더하지 않는다. URL 패턴 변경에 맞춰 `SECRET_PATTERN_VERSION`을 3으로 올리고 고정 시험을 맞춘다.
- `packages/core/test/process-abi.test.ts`, `packages/core/test/secret-patterns.test.ts`: 기존 성능 시험에 표식 밀집 입력, 닫히지 않은 반복 호출, 닫히는 중첩 호출을 추가한다. 모두 1 MiB 이내 입력에서 가림 결과와 적절한 처리 시간 상한을 확인한다. 작은 입력에서는 기존 의미와 정확한 결과가 같음을 확인한다. UTF-8 2·3바이트 문자로 정확한 1048576바이트와 1바이트 초과를 여러 조각 크기에서 확인한다.
- `packages/core/schemas/process-abi/v1/README.md`: 전체 가림 뒤 NUL을 U+FFFD로 치환하고 치환 후 최종 바이트 상한을 적용한다고 명시한다.
- 검증: 아래 Verification 명령 전체와 `git diff --check`. 보고서는 한국어로 작성하고, 소스 외 계획·티켓·원장과 그 상태는 수정하지 않는다. 남은 구현이 있으면 명시한다.


### 2026-10-29 — 공용 가림의 메모리 복구

- 원인: 시간 복잡도를 줄인 문자별 dense 배열 일곱 개가 한 후보에도 본문 전체 길이의 28배 메모리를 추가로 쓰며, stderr 밖의 큰 메시지 출력·redaction에는 1 MiB 한도가 없다.
- 복구: 이전 복구 순서와 같은 기준 소스 상태에서 재도출한다. 기존 계획·티켓·원장과 status·커밋은 보존한다. KEEP은 이전 변경 로그 전부이며, 표식·열린 호출·중첩 호출 성능, version 3, 2·3바이트 경계와 NUL 규약도 유지한다. 첫 구현 세션의 합성 입력 4만 건 문자열·span·hash 동등성 검증도 보존한다.
- `packages/core/src/domain/secret-patterns.ts`: 단순 keyword 후보는 불필요한 전체 본문 색인을 만들지 않는다. 괄호·값 끝·접미부 색인은 문자별 dense 배열 대신 실제 필요한 구간이나 구문 위치의 희소 색인으로 구현한다. 긴 일반 본문과 한두 비밀 후보의 추가 색인 메모리가 본문 길이의 28배가 되지 않아야 한다. 가림 문자열·위치·hash·코드 포인트와 공용 API는 기존과 같고, 기존 문장 예외와 여러 줄 인용 탐지 정책을 확대하지 않는다. 신규 두 탐지 형식은 기존 코드에도 재현되므로 별도 보류다.
- `packages/core/test/secret-patterns.test.ts`: 괄호 네 종류의 정상 짝·혼합 접미부와 정상 짝에서 제거 중단의 고정 기대값, Unicode·기존 표식·거부 호출을 섞은 여러 후보의 처음·중간·마지막 span·hash 기대값을 더한다. 8 MiB 일반 본문과 끝의 비밀 한 개에서 가림이 정확하며 불필요한 dense 배열을 할당하지 않음을 적절한 실제 할당 측정으로 검증한다. 기존 적대 입력 성능 시험도 모두 유지한다.
- 검증은 Verification의 전체 명령과 `git diff --check`다. 구현 보고서는 한국어로 작성한다. 계획·티켓·기존 보류 원장·status를 수정하거나 커밋하지 않는다.

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

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 1, medium 0, low 0, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` (quick) `packages/core/src/domain/secret-patterns.ts:212`의 `url_credentials` 정규식이 긴 스킴 문자 연속 구간의 모든 위치에서 다시 끝까지 훑어 제곱 시간이 걸린다. 텍스트에 `://`가 한 번이라도 있으면 새 `includes('://')` 건너뛰기(`:367`)도 소용없고, 감독자는 정산 때 `stderr.value()`를 동기 호출하므로 데몬 이벤트 루프가 멈춘다 — 확인: 빌드된 코덱에 `'see http://' + 'a'.repeat(1048000)`을 넣자 `value()`가 150초 안에 끝나지 않았고, 이 패턴 하나가 64 KiB `'a'`+` ://`에서 약 2초였다(다른 body 패턴은 1 MiB 적대 입력에서 모두 200 ms 이하). 이전 계약은 줄당 64 KiB로 잘라 가렸으므로 1 MiB 전체 가림으로 바꾼 이번 변경이 노출시켰다. 조치: 구현 세션이 스킴 시작을 스킴 문자 연속 구간의 처음으로 고정했다(`(?<![A-Za-z0-9+.-])[0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/…`). `maskSecrets`는 `value` 그룹 위치만 쓰므로 가리는 값은 같고(`1http://u:pw@h`·`x+y.z-w://u:pw@h` 시험 추가), `includes('://')` 우회는 지웠다. 같은 입력이 11 ms가 되었고, 1 MiB 이하 긴 구간+URL 네 입력의 1초 이내·비밀번호 비노출 시험을 더했다. 이후 `pnpm test` 117파일·2,970개 통과.


### 2026-10-29 — Review pass
- verdicts: 15 findings — high 4, medium 3, low 2, false 6, maybe-false 0
- findings:
  - `[high]` `[bad_plan]` blind-hunter 1: 표식 밀집 입력의 제곱 시간 — `skip.some`은 후보마다 표식 전체를 훑는다. 930000바이트 합성 표식 입력의 최종 가림에 1094 ms가 걸렸다. 표식 구간 조회를 선형 또는 로그 시간으로 만들도록 복구 계획에 추가했다.
  - `[high]` `[bad_plan]` blind-hunter 2: 중첩 호출 재탐색 — 450001바이트 합성 중첩 호출의 `value()`가 8초 안에 끝나지 않았다. `trimClosers`와 `isWholeCall`의 반복 접미부 탐색을 제거하도록 계획을 보완했다.
  - `[low]` `[reject]` blind-hunter 3: 최종 가림 뒤 원문 참조 유지 — 원문은 1 MiB로 제한되고 감독자 실행의 지역 클로저다. 계약은 비파괴 스냅샷을 허용한다. 일상 결함이 입증되지 않았으며 별도 최종화 API 추가의 복잡도 때문에 기각한다.
  - `[medium]` `[patch]` blind-hunter 4: 2·3바이트 원문의 상한 시험 공백 — 현재 정확한 1 MiB 시험은 ASCII와 surrogate 조합이며 다른 시험은 작은 입력에서 null만 확인한다. 정확한 상한과 1바이트 초과를 여러 조각 크기로 증명하는 직접 시험을 추가한다. bad_plan 복구에 포함한다.
  - `[low]` `[patch]` blind-hunter 5: 출하 규약의 NUL 정규화 누락 — 구현은 전체 가림 후 NUL을 U+FFFD로 바꾸어 최종 상한을 적용하지만 ABI README에는 이 순서가 없다. 해당 절에 직접 명시한다. bad_plan 복구에 포함한다.
  - `[medium]` `[patch]` blind-hunter 6: 패턴 버전 누락 — `SECRET_PATTERN_VERSION`의 문서 계약은 패턴 변경 때마다 버전 증가를 요구하지만 URL 정규식 변경 후에도 2다. 버전과 고정 시험을 함께 올린다. bad_plan 복구에 포함한다.
  - `[high]` `[bad_plan]` edge-case-hunter 1: 열린 호출 반복의 정산 정지 — `token=f( ` 100000회 입력은 1 MiB 이내이며 value가 8초 안에 끝나지 않는다. 같은 줄의 닫는 괄호 검색을 매 후보마다 반복하는 원인을 복구 계획에 포함했다.
  - `[high]` `[bad_plan]` edge-case-hunter 2: 표식과 자격 증명 반복의 정산 지연 — blind-hunter 1과 같은 `skip.some` 원인이다. 원문 한도 이내의 입력에서 동기 정산을 1초 이상 막는다. 같은 복구 작업으로 처리한다.
  - `[medium]` `[patch]` verification-gap 1: UTF-8 2바이트 상한 회귀 검증 — 사전 검증된 공백이며 blind-hunter 4와 같은 원인이다. 2바이트 문자를 1바이트로 잘못 세는 회귀를 검출하도록 직접 경계 시험을 추가한다. bad_plan 복구에 포함한다.
  - `[false]` `[reject]` intent-alignment 1: 이번 diff의 전체 ABI 증명 범위 — 기존 fixture 순회·배포 파일·감독자·PG 시험이 남아 있고 이번 `pnpm test`에서도 117파일 2970개가 통과했다. 이번 변경에 포함되지 않은 파일만으로 누락은 성립하지 않는다.
  - `[false]` `[reject]` intent-alignment 2: 긴 진단의 null 정책 — 에픽의 두 번째 escalation 결정은 1 MiB 초과 생략과 부분 줄 버림을 명시한다. 진단을 항상 남겨야 한다는 읽기는 이미 해소된 계약과 다르다.
  - `[false]` `[reject]` intent-alignment 3: stderr 초과의 성공 허용 — 같은 결정은 초과 진단을 고정 표식으로 바꾸는 정책이며 stdout 프로토콜 실패로 만들지 않는다. 현재 성공 기대값은 이 결정과 일치한다.
  - `[false]` `[reject]` intent-alignment 4: 공유 stderr fixture 부재 — carried: 기존 동일 판정대로 stderr는 TS 감독자 책임이며 Python 작업자 공유 fixture 대상이라는 요구가 없다. 기존 행과 README가 그 범위를 확인한다.
  - `[false]` `[reject]` intent-alignment 5: 정산별 1 MiB·실제 자식·PG 시험 범위 — 초과 판정은 동일한 코덱 결과를 모든 정산이 공용 detail로 저장한다. 성공·실패·취소·unknown의 별도 전체 문맥 시험과 기존 저장 시험이 있다. 모든 입력 조합을 모든 저장 경로에 중복 시험하라는 요구는 없다.
  - `[false]` `[reject]` intent-alignment 6: 공용 URL 패턴 의미 동등성 — 새 표현식은 스킴 문자 연속 구간 처음에서 숫자·기호 접두사를 소비하고 기존 표현식과 같은 첫 알파벳 이후 스킴 및 value 그룹을 찾는다. 값의 집합이 달라진 반례는 없다. 패턴 버전 계약 위반은 별도 blind-hunter 6에서 채택했다.

- 네 렌즈가 모두 반환한 뒤 각 지적을 판정했다. 기존 deferred-work 원장 항목과 기존 deferred 목록 및 과거 triage는 바꾸지 않았다. 사용자 지시에 따라 계획 status는 오케스트레이터 소유로 보존했다.


### 2026-10-29 — Review pass
- verdicts: 14 findings — high 2, medium 3, low 4, false 5, maybe-false 0
- findings:
  - `[high]` `[defer]` blind-hunter 1: 따옴표 다음 줄의 비밀 탐지 누락 — 기준 revision의 maskSecrets와 현재 구현 모두 `TOKEN="\nSyntheticSecret123\n"`을 그대로 반환한다. 이번 변경이 만든 회귀는 아니며 새 형식 지원은 기존 탐지 의미 보존 조건과 별개다. 신규 보류 후보로 기록하되 bad_plan 우선으로 deferred 필드 등록은 아직 하지 않았다.
  - `[high]` `[defer]` blind-hunter 2: 줄을 건넌 여러 단어 값의 문장 예외 — 기준 revision과 현재 모두 `password:\ncorrect horse battery staple\n`을 그대로 반환한다. 기존 영어 문장 보존 정책에서 비롯하며 전체 문맥 전달의 회귀가 아니다. 신규 보류 후보로 기록하되 bad_plan 우선으로 필드 등록은 아직 하지 않았다.
  - `[medium]` `[bad_plan]` blind-hunter 3: 공용 가림 색인의 메모리 증폭 — `planRedaction`과 output 경로는 stderr 1 MiB 한도를 적용하지 않는다. 8 MiB 일반 본문과 마지막 password 한 개에 새 배열 234970158바이트가 잡히고 RSS가 약 47 MiB에서 307 MiB로 늘었다. 단순 후보의 불필요한 색인 생성을 피하고 문자마다 할당하는 배열을 희소 구간 색인으로 바꾸도록 계획을 보완했다.
  - `[low]` `[reject]` blind-hunter 4: 성능 시험 중 동기 호출을 timeout으로 중단 불가 — 현재 구현의 호출은 제한 시간 안에 반환하며 기존 성능 시험도 같은 동기 패턴을 쓴다. 향후 무한 루프를 상정한 프로세스 harness 추가는 일상 위험에 비해 복잡도가 커 기각한다.
  - `[medium]` `[patch]` blind-hunter 5: 새 괄호 순위 알고리즘의 혼합 짝 시험 공백 — 기존 고정 시험은 괄호 호출·JSON 끝 괄호와 unmatched closer 중심이다. 네 종류 정상 짝과 혼합 접미부 중 정상 짝에서 멈춤을 고정 기대값으로 더한다. bad_plan 복구에 포함한다.
  - `[medium]` `[patch]` blind-hunter 6: 대량 후보 위치·해시 회귀 공백 — 대량 후보 시험은 문자열·span 수를 확인하고 단일 Unicode 후보만 위치·hash를 고정한다. Unicode·표식·거부 호출을 섞은 여러 후보의 처음·중간·마지막 위치·hash를 고정한다. bad_plan 복구에 포함한다.
  - `[low]` `[reject]` blind-hunter 7: 과거 버전 설명 — 과거 기록의 그대로라는 문장은 당시 quick 패치 기록이고 최신 복구 계획과 코드·시험은 3을 명시한다. 계획 수정만을 요구하므로 기각한다. 최종 결과에 현재 버전을 기록한다.
  - `[low]` `[reject]` blind-hunter 8: 최종 복구 검증 기록 누락 — 진행 중 리뷰 시점의 계획 기록에 대한 지적이다. 조율자 검증은 이미 build·core 282·CLI 65·PG 167·전체 2989개를 통과했고 Finalize에서 기록한다. 계획 수정만 요구하므로 기각한다.
  - `[false]` `[reject]` intent-alignment 1: 전체 ABI와 이번 diff 범위 — carried: 기존 fixture·tarball·감독자 시험은 그대로 있고 이번 전체 검증에도 포함된다. 변경 파일 목록으로 누락은 성립하지 않는다.
  - `[false]` `[reject]` intent-alignment 2: 진단 생략 해석 — carried: 에픽의 두 번째 escalation 결정이 1 MiB 초과 생략·부분 줄 버림을 확정했다.
  - `[false]` `[reject]` intent-alignment 3: stderr 초과의 성공 허용 — carried: 같은 결정은 진단 정책이며 stdout 실패로 규정하지 않는다.
  - `[false]` `[reject]` intent-alignment 4: stderr 언어 공통 fixture — carried: 기존 동일 판정과 README대로 TS 감독자 책임이다.
  - `[false]` `[reject]` intent-alignment 5: 공용 함수·fake 중심 추가 검증 — 실제 자식과 PG의 기존 경계 시험도 실행했고 새 함수 시험이 직접 동작을 검증한다. 모든 조합을 실제 자식→PG 한 시험으로 만들라는 요구는 없다.
  - `[low]` `[reject]` intent-alignment 6: 최종 코드와 과거 버전 설명 — blind-hunter 7과 같은 기록 관찰이다. 과거 기록은 보존하고 현재 버전은 최종 결과에 남긴다. 계획 수정만의 지적은 기각한다.

- edge-case-hunter는 빈 목록, verification-gap은 추가 공백 없음으로 반환했다. 네 렌즈가 모두 반환한 뒤 판정했다. 기존 원장·보류 항목과 ticket·plan status는 보존했다.


### 2026-10-29 — Review pass
- verdicts: 15 findings — high 5, medium 1, low 2, false 7, maybe-false 0
- findings:
  - `[high]` `[defer]` blind-hunter 1: 여러 줄 인용 값 — carried: 직전 동일 관찰대로 기준 구현과 현재 결과가 같다. 새 필드 등록을 보류했던 후보를 이번에 deferred 목록에 신규 등록했다. 기존 원장 항목은 고치지 않았다.
  - `[high]` `[defer]` blind-hunter 2: 여러 단어 값의 문장 예외 — carried: 기준 구현과 현재의 동일 동작이다. 앞 pass의 미등록 신규 후보를 이번에 등록했다. 기존 항목 상태를 변경하지 않았다.
  - `[high]` `[defer]` blind-hunter 3: 인용 값의 끝 괄호 누락 — 기준 revision에서도 password="abc)"의 괄호가 남고 password=")))"는 전부 남는다. 새 희소 trim도 같은 결과다. 기존 인용 정책 결함으로 신규 보류했다.
  - `[high]` `[defer]` blind-hunter 4: 한국어 인용 값 누락 — 기준 revision에서도 비밀번호: "SyntheticSecret123"를 탐지하지 못한다. 현재 결과가 같으므로 기존 패턴 한계로 신규 보류했다.
  - `[medium]` `[patch]` blind-hunter 5: 관련 없는 앞부분 괄호의 메모리 증폭 — 8 MiB 괄호 본문 뒤 후보 하나에 495192336바이트가 추가 할당됐다. 같은 구현 세션을 재개하여 private 색인을 후보의 원래 시작부터 만들고 더 앞선 후보가 필요할 때만 다시 만들도록 직접 수정했다. 같은 입력의 추가 할당은 8681656바이트, 처리 시간은 49ms였다. 기존 고정 결과·성능 시험과 32 MiB 회귀 상한을 유지했다.
  - `[low]` `[reject]` blind-hunter 6: 메모리 시험의 최고점 미측정 — 전후 할당 차이가 최고 RSS를 보장하지 않는다는 한계는 맞다. 시험은 알려진 dense 배열 회귀와 실제 8 MiB 입력 세 개의 할당량을 확인한다. 최고점 계측 harness 추가는 일상 결함이 입증되지 않은 상태에서 복잡도를 늘리므로 기각하며 측정 한계를 최종 결과에 명시한다.
  - `[low]` `[reject]` blind-hunter 7: emoji 밀집 본문의 메모리 시험 부재 — 기존 변환도 입력 길이의 Int32Array를 만들었고 새 구조는 surrogate pair 위치만 보관한다. 큰 emoji 본문의 메모리 상한은 계약에 없으며 회귀가 입증되지 않았다. 별도 메모리 분기·harness를 늘릴 일상 필요가 낮아 기각한다. Unicode 위치·hash는 대량 후보의 고정 기대값으로 검사한다.
  - `[false]` `[reject]` blind-hunter 8: NUL 순서 직접 시험 공백 — `normalizes NUL stderr before applying the byte cap for PostgreSQL text`는 NUL 치환 문자열과 2000개 NUL의 최종 null을 검사한다. 1 MiB NUL 시험도 있다. 최종 상한을 NUL 치환 이전에 적용하면 2000개 시험의 null 기대값을 충족하지 못한다. NUL을 포함한 VALUE는 NUL·U+FFFD 모두 같은 후보 문자이므로 제시된 비밀 예시는 가림 순서를 구별하는 반례도 아니다.
  - `[false]` `[reject]` blind-hunter 9: 합성 동등성 생성기 부재 — 4만 건은 구현 시 수행한 비교 검증 기록이다. 재현 가능한 회귀 검증은 이미 고정된 혼합 괄호·대량 후보·Unicode span·hash 및 적대 입력 시험에 있다. 추가 생성기 부재 자체로 이를 우회하는 구체적인 회귀가 입증되지 않았다.
  - `[false]` `[reject]` intent-alignment 1: 이번 diff의 전체 ABI 범위 — carried: 기존 fixture·tarball·감독자·PG 시험이 남아 있고 최종 전체 실행에도 포함된다.
  - `[false]` `[reject]` intent-alignment 2: stderr 생략·성공 처리 — carried: 에픽의 두 번째 escalation 결정대로 진단 정책을 구현했다.
  - `[high]` `[defer]` intent-alignment 3: 모든 표현의 비밀 탐지와 기존 정책 범위 — carried: 여러 줄 인용·여러 단어 값은 위의 기존 탐지 결함 두 항목과 같다. 신규 목록에 같은 원인을 중복 등록하지 않았다.
  - `[false]` `[reject]` intent-alignment 4: stderr 공유 fixture 부재 — carried: 출하 README와 기존 판정대로 TS 감독자 책임이며 Python 공유 대상은 이벤트·환경·실행 판정이다.
  - `[false]` `[reject]` intent-alignment 5: 공용 함수까지 넓어진 변경 — 가림 정책·공용 API를 유지하면서 전체 문맥 처리로 드러난 비용을 낮췄다. 새 정책을 추가한다는 변경이 아니며 고정 결과·위치·hash·성능·메모리 시험으로 소비 영향을 확인한다.
  - `[false]` `[reject]` intent-alignment 6: fake와 실제 자식·PG의 분리 검증 — carried: 함수·전달·OS·저장 경계를 각각 검증하는 방식은 원문 verify를 충족하며 모든 조합의 한 경로 시험을 요구하지 않는다.

- edge-case-hunter는 빈 목록, verification-gap은 추가 공백 없음으로 반환했다. 네 렌즈가 모두 반환한 뒤 분류했고 마지막 직접 패치 뒤 Verification 명령 전체를 다시 실행했다. 신규 deferred 네 건만 계획 목록에 추가했으며 기존 원장과 상태는 그대로다.

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



## 2026-10-29 — stderr 전체 문맥 계약 구현

- 최신 Always의 두 번째 escalation 해소 규칙을 구현했다. `createAbiStderr`는 원문 UTF-8 바이트를 최대 1048576바이트까지 보관하며, 초과 즉시 원문을 버리고 이후 조각도 보관하지 않는다. 최종 값은 `[stderr 생략: 원문 1 MiB 초과]`로 고정된다. stdout framing 상한은 바꾸지 않았다.
- 넘치지 않은 원문은 `value()`에서 `maskSecrets(전체, 'body')`로 한 번 가리고 결과를 캐시한다. 이후 조각이 오면 캐시를 무효화한다. 코드 포인트 경계에서 끝 4096바이트를 취하고 시작이 줄 중간이면 그 부분 줄을 버리며, 빈 결과는 null이다. PostgreSQL text를 위한 NUL 정규화는 전체 가림 뒤에 적용하며 최종 바이트 상한에 포함한다.
- ABI README를 최신 규칙으로 맞췄다. 기존 stderr 시험의 줄별 가림·65536바이트 생략 기대값을 대체하고, 여섯 가지 줄 사이 비밀·빈 줄·미종결 PEM·정확한 1 MiB·1바이트 초과·계속 소비·Unicode 조각 경계·부분 줄 버림을 검증했다. 감독자의 성공·실패·취소·unknown 정산과 OS 신원/DB 기록 지연 중 초과 출력 소비를 확인했다.
- 전체 원문 가림 시험에서 URL scheme이 없는 긴 단어의 기존 URL 정규식 재탐색이 지연되는 것을 확인했다. `maskSecrets`는 `://`가 없으면 매치 불가능한 `url_credentials` 패턴만 건너뛰게 했다. 패턴 정의와 판정 의미는 바꾸지 않았다.
- 검증: build와 core 집중 6파일·402개 시험 통과. 최종 `pnpm test`의 build·typecheck와 전체 117파일·2966개 시험 통과(51.64초). 실제 Node 자식·probe와 PostgreSQL 상세 저장 및 CHECK 제약 시험도 포함한다. `git diff --check` 통과.
- 최신 stderr 계약의 미완료는 없다. 1 MiB 초과 시 진단을 잃는 것은 정한 정책이다. 기존 triage에 기록된 잘못된 UTF-8 치환 수용, 신원/DB 조회·임대 갱신 중 stdout 판정 지연, launcher 시작 이전부터 재는 elapsed 시작점은 변경하지 않았다. 재시도·취소·회수·unknown 판정 순서, DB migration 및 기존 deferred-work 원장은 유지했다. 운영 설치·배포·커밋은 수행하지 않았다.

- 리뷰 패치(조율자 기록): 위 "전체 원문 가림" 절의 `://` 건너뛰기 문장은 리뷰 뒤 바뀌었다. `url_credentials` 패턴 정의를 선형 시간 형태로 고쳤고 건너뛰기는 지웠다. 가리는 값 집합은 같아서 `SECRET_PATTERN_VERSION`은 그대로다.

## Auto Run Result

상태: `built`. 시작 시 계획의 status를 보존했으며 티켓을 done으로 표시하지 않았다. `tickets.py mark`는 실행하지 않았다. 오케스트레이터의 최종 검증과 상태 처리를 기다린다.

- 구현 요약: 승인된 전체 문맥 stderr 계약을 유지하며 표식 밀집·열린 호출·중첩 호출의 반복 탐색을 줄였다. 공용 가림의 dense 배열을 희소 구간·구문·surrogate 위치 색인으로 바꾸고, 관련 없는 앞부분은 색인에서 제외했다. `SECRET_PATTERN_VERSION`은 3이다. UTF-8 2·3바이트의 정확한 1 MiB 경계, 혼합 괄호, 대량 후보의 위치·hash, 8 MiB 일반·구조화 본문의 메모리 시험을 추가했고 출하 규약에 NUL 후처리 순서를 명시했다.
- 기준 revision 이후 바뀐 파일:
  - `packages/core/src/process-abi/codec.ts` — 1 MiB 원문 보관·전체 한 번 가림·초과 폐기·최종 4096바이트 정책(기존 구현 커밋 포함).
  - `packages/core/src/domain/secret-patterns.ts` — URL 성능 수정, 표식 조회·희소 구문/위치 색인, 후보 접미부 한정, 패턴 버전 3.
  - `packages/core/schemas/process-abi/v1/README.md` — 전체 문맥 stderr와 NUL 정규화 규약.
  - `packages/core/test/process-abi.test.ts` — 전체 문맥·바이트 경계·적대 입력 검증.
  - `packages/core/test/secret-patterns.test.ts` — 가림 의미·위치·hash·시간·메모리 회귀 검증.
  - `packages/core/test/supervisor-abi.test.ts` — 정산·초과 출력·조회 지연의 stderr 검증(기존 구현 커밋 포함).
  - 계획 파일 — 복구 계획, 개별 리뷰 판정, 신규 deferred 및 이번 결과.
- 검토: thorough 네 렌즈를 세 차례 실행했다. 총 44개 관찰을 개별 판정했고 두 차례 계획 복구 후 마지막 직접 패치 1건(medium)을 적용했다. 최종 pass는 15건(high 5, medium 1, low 2, false 7)이다. 기존 비밀 탐지기의 네 한계를 계획 deferred에 신규 기록했으며 기존 deferred-work 원장 항목·상태는 변경하지 않았다. 전체 기각 25건의 개별 근거는 이번 세 Review pass에 기록했다. 최종 기각은 기존 경계 검증·확정된 정책·입증되지 않은 회귀와 낮은 효과 대비 계측 복잡도에 근거한다.
- 후속 리뷰 권고: `false`. 후속 pass의 최종 직접 패치 entry는 high 0, medium 1, low 0이다. 사용자 지시대로 ticket과 plan status의 완료 판단은 오케스트레이터 소유다.
- 최종 패치 후 검증: `pnpm build` 통과. 지정 core 5파일·282개, CLI 2파일·65개, PostgreSQL 4파일·167개 통과. `pnpm test`의 build·typecheck 및 117파일·2999개 시험 통과(51.37초). 전체 실행에는 secret-patterns와 실제 Node 자식·PG 저장 시험도 포함된다. `git diff --check` 통과.
- 행렬 감사: 정상·usage 없음·0·결과 없음·비정상 exit·worker error·버전·깨진 줄·긴 줄·잘린 줄·중복 최종·최종 뒤 진행은 `every run fixture gets its expected verdict`와 `persists every run fixture verdict and usage and keeps the existing retry policy`가 42개 run case 전부를 확인한다. 긴 줄 즉시 정리와 시작 실패는 감독자 개별 시험, env는 21개 fixture와 실제 probe 시험이 확인한다. stderr 일반·PEM·줄 사이 비밀·미종결 PEM·정확/초과 1 MiB·긴 한 줄은 process-abi 및 supervisor-abi의 개별 시험이 확인한다. 모든 해당 파일이 최종 검증에서 실행·통과했으며 행렬의 누락 행은 없다. 이벤트 fixture 31개도 전부 순회한다.
- 별도 관찰: 최초 표식 입력 1094ms, 열린/중첩 호출 각각 8초 초과가 복구 후 167ms·358ms·54ms로 줄었다. 8 MiB 구조화 본문의 추가 할당은 495192336바이트에서 8681656바이트로 줄었고 같은 재현이 49ms에 처리됐다. 할당 측정은 호출 전후 heapUsed+arrayBuffers 차이로 최고 RSS나 모든 입력의 최대치를 보장하지 않는다. 합성 4만 건을 두 field에서 기준 구현과 비교한 결과 문자열·span·hash가 같다는 구현 세션 보고도 받았다.
- 잔여 위험: 새 deferred 네 건은 기준 구현에서도 재현된 기존 탐지 한계다. 원문 1 MiB 초과 때 진단을 잃는 정책, 앞선 triage의 잘못된 UTF-8 치환 수용·신원/DB/갱신 대기 중 stdout 판정 지연·launcher 시작 이전부터 측정하는 elapsed 시작점은 유지했다. 운영 설치·배포·push는 하지 않았다.
