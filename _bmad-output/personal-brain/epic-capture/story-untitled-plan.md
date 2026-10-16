---
title: '엔벨로프·종료 코드·확인 게이트'
type: 'feature'
ticket: '1'
created: '2026-10-16'
status: 'built'
baseline_revision: '0c4482359b5397204a4fd99055b2546271560d2b'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** CLI 엔벨로프 오류는 `{code, message}`뿐이라 에이전트가 종료 코드·재시도 가능 여부·다음 행동을 추측해야 하고, "사람에게 물어야 함"(비대화형 `setup run`의 동의 없음)이 사용법 오류와 같은 exit 2다. doctor는 "검사 못 함"을 `ok`로 숨기고, 빈 위치 인자(실패한 `$(…)` 캡처)나 제어문자가 섞인 id가 그대로 명령에 들어간다.

**Approach:** Core에 경고·오류 코드 상수(코드별 기본 exit·retryable·hint)와 엔벨로프 코덱(`error{code, message, exit_code, retryable?, hint?, retry?}`, `meta`)과 확인 게이트를 두고 CLI가 그것을 쓴다. 종료 코드 3 `CONFIRMATION_REQUIRED`를 더해 CLI만 `retry_argv`를 덧붙이고, doctor에 `warn`·선행 실패 `skip`·`summary`를, 디스패처에 위치 인자 검사를 넣은 뒤, 첫 게이트로 비대화형 `setup run`의 동의를 exit 3으로 바꾼다.

## Boundaries & Constraints

**Always:**
- 엔벨로프 코덱·코드 상수·게이트는 Core 하나이고 CLI는 그것을 쓴다(AD-5). `retry_argv`만 CLI가 만든다.
- `error.retry`는 같은 verb의 입력에 `confirm: true`를 더한 것이고, 사용자가 실제로 준 인자만 담는다(기본값·`json` 제외). CLI 플래그는 키의 kebab-case, `confirm`은 `--yes`.
- hint 문체: 소문자 시작, 마침표 없음, 명령은 백틱, 파괴적 hint 금지(Conventions).
- hook 명령은 무엇이 나도 exit 0(확인 필요 포함). `warn`은 exit 0, `fail`만 exit 1.
- 기존 실패의 exit는 지금과 같다(명시 `exit`가 표 기본값보다 우선).
- Decision(2026-10-16): 플랜 크기(약 2,700 토큰)는 넘지만 나누지 않는다. 스토리 verify가 네 부분을 모두 요구한다(사용자).

**Never:**
- 명령 메타 7칸, `admin schema`·`exit-codes`·`guide`, README 종료 코드 표 대조 테스트(2.3).
- 설치 흐름의 결과 값 전환, TTY 동의 단계, 설정 보존 버그(2.4). `messages redact` 게이트(2.13). hook의 확인 필요를 `failures`에 기록(2.11).
- 쓰기 가드의 `DB_UNAVAILABLE` exit 1을 Conventions의 2로 바꾸기 — deferred에 적는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 동의 없는 비대화형 | `setup run --json`, 비TTY | `ok:false`, `error{code:CONFIRMATION_REQUIRED, exit_code:3, retryable:false, hint, retry:{ns:setup, verb:run, args:{confirm:true}}, retry_argv:[brain,setup,run,--yes,--json]}`, config 안 씀 | exit 3 |
| 준 인자 보존 | `setup run --store-path /abs/b.db --json` | `retry.args = {storePath, confirm:true}`, argv에 `--store-path /abs/b.db` | exit 3 |
| npx 설치기 | 비TTY, `--yes` 없음 | 안내 줄 출력 | exit 3 |
| hook 경로 | hook 명령이 `CONFIRMATION_REQUIRED` | stdout 없음, stderr 한 줄 | exit 0 |
| 잠금 보유 | 다른 연결이 `begin immediate` 유지 중 doctor | `writable: warn`, `summary` 건수 일치 | exit 0 |
| DB 없음 | `brain.db` 삭제 후 doctor | `db: fail`, `schema-version: skip`(`prereq failed: db`), 탐침 줄 없음 | exit 1 |
| shim 못 읽음 | `bin/brain` 삭제 | `node-path: skip`(`prereq failed: shim`) | exit 1 |
| 빈 위치 인자 | `setup connect ""` 또는 공백만 | `USAGE`, 빈 인자 이름을 말함 | exit 2 |
| 제어문자 id | 위치 인자에 C0·C1·ESC·zero-width·bidi 문자 | `USAGE` | exit 2 |

</frozen-after-approval>

## Code Map

- `packages/core/src/warnings.ts` -- `WARNING_CODES`(10개). `codes.ts`로 옮기고 Conventions의 6개(`ATTACHMENT_NOT_REDACTED`, `FILE_SOURCE_UNREACHABLE`, `DAEMON_UNAVAILABLE`, `PLUGIN_NOT_INSTALLED`, `PLUGIN_BEHIND`, `PLUGIN_DUPLICATE`)를 더한다.
- `apps/cli/src/envelope.ts` -- 지금의 코덱(`okEnvelope`·`errorEnvelope(clock, code, message, warnings)`·`isoWithOffset`). Core로 옮긴다. 테스트는 `apps/cli/test/envelope.test.ts`.
- `apps/cli/src/dispatch.ts` -- `ExitCode`(0|1|2), `CommandFailure{code: string, message, exit?: 1|2}`, `failed()`·`finish()`, `buildProgram`의 위치 인자 수집(446-451), hook 경로(237-241). `code`는 string으로 둔다(connector가 자기 코드를 정한다, `ports/connector.ts:37`).
- `apps/cli/src/install/flow.ts:182-185` -- 비TTY·`--yes` 없음 → 지금 2. `InstallExitCode`(26).
- `apps/cli/src/commands/setup-run.ts` -- 흐름 exit를 엔벨로프로 바꾸는 곳. `isTTY: json ? false : …`(57).
- `packages/core/src/admin/doctor.ts` -- `DoctorCheckStatus`, `runDoctor`(db 실패 시 탐침·스키마 생략), `probeCheck`.
- `packages/core/src/ports/store.ts:19` -- `StoreProbe{id, ok, detail?}`. 계약은 `testing/contracts/store.ts:62-69`.
- `packages/sqlite/src/store.ts:198-206` -- `writable` 탐침의 busy 분기(지금 `ok:true`).
- `apps/cli/src/doctor/checks.ts:188` -- `node-path` skip detail.
- `apps/cli/src/commands/admin-doctor.ts` -- `data{checks}`, 텍스트 줄, `failed`.
- 이미 존재하는 코드 출처: `config/codec.ts`(`CONFIG_MISSING`·`CONFIG_INVALID`), `core/src/schema.ts`(`SCHEMA_MISMATCH`·`DB_UNAVAILABLE`), `sqlite/src/write.ts`(`DB_LOCKED`), `setup-connect.ts`(`USAGE`·`SHIM_MISSING`), `install/*`(`MIGRATION_FAILED`·`FILES_UNAVAILABLE`).
- 바꾸는 기존 테스트: `apps/cli/test/setup.test.ts:376`, `install.test.ts:217`, `install-flow.test.ts:669·682`(exit 2→3), doctor 생략 단정(`packages/core/test/doctor.test.ts`, `admin-doctor.test.ts`), sqlite busy 단정(`packages/sqlite/test/store.test.ts`).
- README 79-100·195-220 -- `setup run` exit 2 문장, doctor 상태 설명.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/codes.ts` -- `WARNING_CODES`(16개)·`isWarningCode`, `ERROR_CODES`(`USAGE`·`CONFIG_MISSING`·`CONFIG_INVALID`·`DB_UNAVAILABLE` 2 / `DB_LOCKED`(retryable)·`SCHEMA_MISMATCH`·`MIGRATION_FAILED`·`FILES_UNAVAILABLE`·`SHIM_MISSING`·`SEARCH_FAILED`·`VERSION_MISMATCH` 1 / `SESSION_REQUIRED` 2 / `CONFIRMATION_REQUIRED` 3, 각자 `hint`)·`isErrorCode`. `warnings.ts`를 지우고 `index.ts` export 갱신 -- Conventions 목록 하나.
- [x] `packages/core/src/envelope.ts` -- `VerbCall`, `Failure`, `Envelope`·`EnvelopeError`·`EnvelopeMeta`, `okEnvelope(clock, data, warnings, meta?)`, `errorEnvelope(clock, failure, warnings)`(exit·retryable·hint가 없으면 표에서, 모르는 코드는 exit 1·hint 없음), `isoWithOffset`, `requireConfirmation(call)`(`args.confirm !== true`면 `retry` 실린 실패) -- 표면 중립 코덱.
- [x] `apps/cli/src/envelope.ts` -- Core 재사용 + `retryArgv(retry, positional, json)` -- CLI만의 표현.
- [x] `apps/cli/src/dispatch.ts` -- `ExitCode` 0~3, `CommandFailure`에 `exit?: 1|2|3`·`retryable?`·`hint?`·`retry?`, `CommandSuccess.meta?`, `retry`가 있으면 등록부에서 그 명령의 `arguments`를 찾아 `retry_argv`를 붙임, 선택 직후 위치 인자 검사(빈 값·제어문자 → `USAGE`).
- [x] `apps/cli/src/install/flow.ts`, `install.ts` -- 동의 분기가 3, 타입 갱신.
- [x] `apps/cli/src/commands/setup-run.ts` -- 흐름 3 → `requireConfirmation({ns:'setup', verb:'run', args: 준 인자})`.
- [x] `packages/core/src/ports/store.ts`, `testing/contracts/store.ts`, `admin/doctor.ts` -- `StoreProbe.warn?`(ok일 때만), 상태 `warn`, db 실패 시 `schema-version` skip, `DoctorReport.summary`.
- [x] `packages/sqlite/src/store.ts` -- busy면 `{ok:true, warn:true}`.
- [x] `apps/cli/src/doctor/checks.ts`, `commands/admin-doctor.ts` -- skip detail `prereq failed: shim`, `data.summary`, 텍스트 마지막 줄 `summary: …`.
- [x] 테스트 -- 매트릭스 각 행, Core 코덱·게이트·hint 문체 검사(모든 `ERROR_CODES` hint), `retry_argv`를 다시 dispatch하면 같은 명령이 `--yes`로 선택됨, 위 기존 테스트 갱신.
- [x] `README.md` -- exit 3, doctor `warn`·`skip`·`summary`.
- [x] `_bmad-output/personal-brain/deferred-work.md` -- 쓰기 가드 `DB_UNAVAILABLE` exit 항목 추가.

**Acceptance Criteria:**
- Given 어떤 명령 실패, when `--json`, then `error.exit_code`가 프로세스 종료 코드와 같고 hint가 비면 코드표 문구다.
- Given hook 명령 실패, when 어떤 코드든, then exit 0이고 stdout은 비어 있다.
- Given `retry_argv`, when 그 argv로 다시 dispatch, then 같은 ns·verb가 같은 인자와 `--yes`로 선택된다.

## Design Notes

- 위치 인자는 모두 id로 본다. 본문(작업 로그 등)은 stdin으로 받기로 했으므로 위치 인자로 오지 않는다. 자유 텍스트 위치 인자가 생기면 그 스토리가 제외 표시를 더한다.
- 게이트 판단은 흐름 한 곳(npx 경로도 같은 분기)이고, Core는 실패 값의 모양(`retry`)만 정한다. 2.4가 흐름을 결과 값으로 바꾸면 그 값이 `requireConfirmation`을 직접 돌려준다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 통과
- `node apps/cli/dist/bin.js setup run --json < /dev/null; echo $?` (임시 `SECOND_BRAIN_HOME`) -- expected: exit 3, `retry_argv` 포함

## Implementation Notes

- 코덱·코드 상수는 `packages/core/src/{codes,envelope}.ts`. `warnings.ts`는 지웠고 `index.ts`가 둘을 내보낸다. CLI `envelope.ts`는 재export + `retryArgv`·`argumentName`·`CliEnvelope`(=`EnvelopeError` + `retry_argv`)만 갖는다.
- 플랜 서명과 다른 점 세 가지(모두 추가, 축소 없음):
  - `requireConfirmation(call, message?)` — 두 번째 인자는 선택. Core는 중립 기본 문구를 쓰고, `setup run`은 흐름이 실제로 출력한 안내 줄을 넘겨 메시지가 두 군데서 갈라지지 않게 한다.
  - `prereqFailed(id)`를 Core에서 내보낸다 — `prereq failed: db`(Core)와 `prereq failed: shim`(CLI `doctor/checks.ts`)이 한 문구에서 나와야 한다.
  - `errorCodeSpec(code)`·`CONFIRM_ARG`·`formatSummary`·`JSON_FLAG`/`YES_FLAG`(envelope.ts로 이동) — 모르는 코드 조회와 플래그 철자를 한 곳에 두기 위한 보조.
- `exit_code`와 프로세스 종료 코드가 같은 것은 구성상 보장된다: `dispatch.failed()`가 엔벨로프를 만든 뒤 `envelope.error.exit_code`를 그대로 `Outcome.exit`로 쓴다(두 번 계산하지 않는다).
- 기존 실패의 exit 유지: 쓰기 가드는 `exit: 1`을 명시해 표의 `DB_UNAVAILABLE` 2를 덮는다(deferred에 기록). 설정 실패와 `USAGE`는 2를 명시한다.
- 위치 인자 검사는 `select()` 직후, 설정 읽기·DB 열기 전. 거부 문자: C0·C1(ESC·DEL 포함)·U+200B~200F·U+202A~202E·U+2060·U+2066~2069·U+FEFF. 빈 값은 `trim() === ''`.
- Core 코덱 테스트는 `packages/core/test/{envelope,codes}.test.ts`로 갔다(코드가 Core로 옮겨졌으므로). `apps/cli/test/envelope.test.ts`에는 `retryArgv`·`argumentName`과 재export 확인만 남았다. `schema.test.ts`의 경고 코드 블록은 `codes.test.ts`로 이동.
- 설치기 텍스트 출력에는 `summary:` 줄을 넣지 않았다(플랜은 `admin doctor`만 지정). `install/flow.ts`는 지금처럼 검사 줄만 찍는다.
- `pnpm test` 788개 통과(Postgres 통합 테스트는 `BRAIN_TEST_DATABASE_URL`로 컨테이너를 띄워 함께 돌렸다).

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-16, quick) — high 0 · medium 1 · low 10 · false 0 · maybe-false 0

| # | Location | Finding | Verdict | Route | Evidence / action |
|---|----------|---------|---------|-------|-------------------|
| 1 | `packages/core/src/codes.ts` CONFIG_INVALID | hint가 `brain setup run`을 권하는데, 읽지 못한 값이 있는 config에서는 그것이 timezone·files·mirror를 기본값으로 되돌린다 | medium | patch | `install.ts:116-118`이 읽기 실패를 `undefined`로 바꿔 흐름이 기본값을 쓴다(deferred story 13 항목, 2.4가 고침). hint를 값 고치기로만 바꾼다 |
| 2 | `README.md:113` | `## Exit codes` 제목이 `setup connect` 문단 앞에 끼어 그 문단이 다른 절로 넘어갔다 | low | patch | README 73·113·132행 확인. Exit codes 절을 connect 문단 뒤로 옮긴다 |
| 3 | `README.md` 종료 코드 표 | "DB 없음 → 2"인데 쓰기 가드는 1 | low | reject | `writes: true` 명령이 아직 없어 관찰 불가. README는 Conventions 계약을 적었고, 어긋남은 이번 deferred 항목에 있으며 2.3의 README↔Core 대조가 다시 잡는다 |
| 4 | `apps/cli/src/dispatch.ts` 텍스트 모드 | exit 3의 hint·`retry_argv`가 텍스트 모드에 안 나온다 | low | reject | 지금 게이트는 `setup run` 하나이고 흐름이 안내 줄을 먼저 찍는다. 다음 게이트 verb(2.13 `messages redact`)가 텍스트 표현을 정할 때 다룬다 |
| 5 | `dispatch.ts` 위치 인자 수집 | 가변 위치 인자(배열)는 걸러져 검사를 못 본다 | low | reject | 가변 위치 인자를 선언한 명령이 없다(잠재). 고치려면 args 모양을 바꿔야 해 직접 수정을 넘는다 |
| 6 | `dispatch.ts` `CONTROL_CHARACTERS` | U+2028·U+2029(줄 구분자)가 통과한다 | low | patch | 정규식에 없음을 확인. 범위 두 글자 추가와 테스트 한 행 |
| 7 | `setup-run.ts` `consentMessage` | 텍스트 모드에서 같은 문장이 두 번 보인다 | low | reject | 예전 exit 2 `USAGE` 경로도 같았다(기존 형태). docstring은 소스 중복을 말한다. 줄을 숨기려면 출력 분기가 필요하다 |
| 8 | `README.md` 143·233행 | 줄바꿈이 깨졌고 doctor 머리말이 summary 줄을 말하지 않는다 | low | patch | 문단 재정렬, 머리말 한 구절 |
| 9 | 계획 `context: []`, deferred Triage 표 | context가 비었고 새 deferred 항목의 Triage 행이 없다 | low | reject | 계획 수정은 기각 대상. Triage 표는 인셉션·회고가 채우고 빌드는 항목만 덧붙인다 |
| 10 | `admin-doctor.ts` `formatSummary` | 쓰이지 않는 export | low | patch | 모듈 밖 사용처 없음(grep). `export`를 뗀다 |
| 11 | `packages/core/src/codes.ts` CONFIRMATION_REQUIRED (오케스트레이터) | Core hint가 CLI 전용 칸 `error.retry_argv`를 가리킨다 | low | patch | AD-5 표면 중립 위반. epic 9 MCP·데몬 클라이언트에는 그 칸이 없다. 표면 중립 문구로 바꾸고 README 예시를 맞춘다 |
