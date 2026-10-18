---
title: '설치기 안정화: 흐름 결과와 실패 계약'
type: 'feature'
ticket: '4'
created: '2026-10-17'
status: 'built'
baseline_revision: '93dac507bc7f5ae0df84242489ea715b541467d6'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
warnings: [oversized]
followup_review_recommended: false
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 설치 흐름은 숫자 exit와 로그 줄로만 결과를 말한다. 그래서 `setup run`은 로그를 거꾸로 파싱해 코드를 되찾고, 실패(exit 1)인데도 `ok:true`를 낸다(회고 F6). config를 store 준비보다 먼저 써서 잘못된 `--store-path` 하나가 기록된 경로를 덮는다(F3). 기존 파일이 DB인지 보지 않고 0600으로 바꾼다(F4). `writeConfig`는 던진다(F5). 값 하나가 틀리면 나머지 값까지 기본값으로 되돌린다(F1). 모르는 키는 말없이 지운다(F2). TTY에서는 동의 단계가 없다(F11).

**Approach:** 흐름이 `InstallResult`(성공 보고 + 경고 코드, 또는 Core `Failure`)를 돌려준다. `setup run`과 npx 진입점은 그 값을 렌더링만 한다. 설정 코덱에 설치기용 부분 읽기와 값으로 실패하는 쓰기를 둔다. 순서는 store·주인·파일 루트 준비 뒤에 config 쓰기로 바꾼다. DB 판정은 chmod 앞에 둔다. TTY에서는 만들 것을 보여 주고 한 번 묻는다.

## Boundaries & Constraints

**Always:**
- 흐름은 실패 줄(`CODE: …`)을 로그에 찍지 않는다. 실패는 값으로만 나가고, 렌더링은 부르는 쪽이 한다. `setup run`은 디스패처가, npx 진입점(`install.ts`)은 `CODE: message`와 hint 줄을 찍는다. 진행 줄은 지금처럼 `log`로 나간다(`--json`이면 찍지 않는다).
- 실패의 exit는 지금과 같다. 시작 전 실패는 2(`USAGE`, `CONFIG_INVALID`), 동의 없음은 3, 실행 중 실패는 1이다. 실행 중 실패의 exit 1은 실패 값에 명시한다(표 기본값 2를 덮음). 비대화형 동의 없음은 흐름이 `requireConfirmation({ns:'setup', verb:'run', args: 준 인자})`를 바로 돌려준다. 그 모양(`retry`, `retry_argv`)은 2.1과 같다.
- 성공 `--json`의 `data`는 구조화된 보고다(snake_case): `home`, `config_path`, `store{path, schema_version, applied}`, `owner{name, created}`, `files{path, created}`, `mirror_path`, `shim{path, changed}`, `harnesses[{harness, target, changed}]`, `checks`, `summary`. `lines`는 없앤다.
- 끝의 doctor에 `fail`이 하나라도 있거나 connector가 하나라도 거부하면 `ok:false`다. connector 거부가 먼저 났으면 그 connector의 코드를 쓰고, 아니면 `SETUP_INCOMPLETE`를 쓴다. 어느 경우든 doctor는 끝까지 돌고 그 줄을 찍는다.
- 순서: 동의 확인 → 경로 선택 → 임베딩 → TTY 동의 → store 준비 → 주인 행 → 파일 루트 → **config 쓰기** → shim → 하네스 → doctor. 그래서 store·주인·파일 루트 중 하나라도 실패하면 config는 바이트 하나 바뀌지 않는다.
- DB 판정: 경로에 파일이 있고 0바이트가 아니며 첫 16바이트가 `SQLite format 3\0`이 아니면 거부한다. 이때 chmod도, 쓰기도, 마이그레이션도 하지 않는다(`DB_UNAVAILABLE`, exit 1). 0바이트 파일은 새 DB로 본다. 폴더는 지금처럼 거부한다.
- 부분 읽기는 코덱(`config/codec.ts`)이 한다(AD-18). 값마다 `readConfig`와 같은 검사를 쓰고, 틀린 값은 그 키만 버리고 경고 한 줄을 남긴다(키·값·대신 쓸 값을 적음, 코드 `CONFIG_VALUE_RESET`). `schema_version`이 없거나 정수가 아니면 `CONFIG_VALUE_RESET`으로 경고하고 1로 쓴다. 파일을 읽을 수 없음, TOML이 아님, 테이블이 아님, `schema_version`이 1이 아닌 정수(더 새 버전일 수 있음)이면 아무것도 쓰지 않고 `CONFIG_INVALID`(exit 2)로 멈춘다.
- 모르는 키(알려진 테이블 안의 모르는 하위 키 포함)는 값 그대로 다시 쓰고 `CONFIG_UNKNOWN_KEY` 경고를 낸다. 진행 줄 `경고: …`, 결과의 `warnings`, 실패 엔벨로프의 `warnings`에 모두 나온다. 알려진 키가 이긴다.
- `writeConfig`는 던지지 않는다. 검사 실패, `.env`로 나타낼 수 없는 값, 파일 시스템 오류를 모두 `{ok:false, code:'CONFIG_INVALID', message}`로 돌려준다.
- TTY 동의: 경로·임베딩 질문 뒤, 무엇이든 쓰기 전에 보여 준다. 보여 줄 것은 config 두 파일, DB 파일(새로 만듦 / 있는 파일을 마이그레이션), 파일 루트, shim의 경로와 무엇을 할지이고, 그다음 한 번 묻는다(기본 예). 아니요나 Ctrl-C면 아무것도 쓰지 않고 `SETUP_CANCELLED`로 끝난다(exit 1). TTY에서 `--yes`를 주면 이 질문만 건너뛴다. 하네스 연결 질문은 그대로 따로 묻는다.
- `[files] path`는 묻지 않는다. 기록된 값, 없으면 기본값을 config에 기록한다(F10).
- 새 문장(진행 줄, 동의 화면, 경고·오류 message, README)은 한국어이고 출력 언어 검사를 통과한다.
- Decision(2026-10-17, 사용자 "auto 모드로 끝까지 진행해" — 권장안 수용): 새 코드 셋을 더한다. 경고 `CONFIG_VALUE_RESET`(틀린 설정 값을 버리고 기본값을 씀), 오류 `SETUP_INCOMPLETE`(exit 1, retryable false, hint는 `brain doctor run`; 설치는 끝났으나 끝 점검이 실패), 오류 `SETUP_CANCELLED`(exit 1, retryable false; 사람이 동의를 거절하거나 Ctrl-C). Core·README 표·spine Conventions 목록을 함께 고친다.
- Decision(2026-10-17, 같은 근거): 플랜 크기(약 3,300 토큰)는 넘지만 나누지 않는다. 티켓 verify가 흐름 결과·설정 보존·DB 판정·실패 엔벨로프를 함께 요구하고 모두 `flow.ts`를 고친다.

**Never:**
- 완료 기록 `installed.json`, 빌드 신원, 진입점 node 하한(2.5). 플러그인 감지와 connector 변경(2.5·2.14).
- 기존 DB를 옮기거나 지우는 것. 틀린 값을 그대로 다시 쓰는 것.
- 흐름 단계를 나누는 프레임워크 같은 새 추상. `InstallDeps` 주입 구조는 그대로 쓴다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 잘못된 store 경로 | 기록된 config가 있음. `--store-path`가 폴더이거나 DB가 아닌 파일 | `ok:false`, config.toml·.env 바이트가 그대로 | `DB_UNAVAILABLE`, exit 1 |
| 남의 파일 | 경로에 0644 텍스트 파일 | 모드와 내용이 그대로, `-wal`이 생기지 않음 | `DB_UNAVAILABLE`, exit 1 |
| 빈 파일 | 0바이트 파일 | 새 DB로 0600, 마이그레이션 | exit 0 |
| 틀린 값 하나 | 상대 `store.path` + 사용자 지정 files·mirror·timezone, `setup run --yes --json` | files·mirror·timezone이 남고, store는 기본값, `CONFIG_VALUE_RESET` | `ok:true` |
| 모르는 키 | `[database] url_env = "X"`, `[store] extra = 1` | 다시 쓴 뒤에도 두 키가 남음, `CONFIG_UNKNOWN_KEY` | `ok:true` |
| 못 읽는 파일 | TOML이 아님 / `schema_version = 2` | 아무것도 쓰지 않음 | `CONFIG_INVALID`, exit 2 |
| .env 값 | 두 따옴표가 다 든 값 | 봉투가 있는 실패, 던지지 않음 | `CONFIG_INVALID`, exit 1 |
| doctor 실패 | 끝 점검에 `fail` | doctor 줄은 찍힘, message에 실패한 점검 id | `SETUP_INCOMPLETE`, exit 1 |
| connector 거부 | 이름 지은 하네스가 실패 | 나머지 하네스는 계속 연결, doctor도 돎 | connector 코드, exit 1 |
| 비대화형 동의 없음 | 비TTY, `--yes` 없음 | 2.1과 같은 `retry`·`retry_argv`, 로그 파싱 없음 | `CONFIRMATION_REQUIRED`, exit 3 |
| TTY 동의 | TTY, `--yes` 없음 | 만들 것 목록과 질문 한 번. 아니요면 아무것도 쓰지 않음 | `SETUP_CANCELLED`, exit 1 |
| TTY `--yes` | TTY, `--yes` | 동의 질문이 없음(경로 질문은 그대로) | exit 0 |
| 주인 행 실패 | `ensureSelfUser` 실패 | 그 코드와 message, config를 쓰지 않음 | exit 1 |
| 성공 | 새 home, `setup run --yes --json` | `data`가 구조화 보고, `lines` 없음 | exit 0 |

</frozen-after-approval>

## Code Map

- `apps/cli/src/install/flow.ts` -- `InstallExitCode`(33), `InstallConfigIo`(76-80: `write`→void, `read`→`RecordedConfig|undefined`), `runInstallFlow`(150, 파싱 실패 2·help 0), `runInstall`(175). exit 지점: 190 USAGE→2, 204-207 동의→3(`nonInteractiveGuidance` 575), 214·223 경로→2(`choosePath` 374, `CONFIG_INVALID` 줄 378·390), 232 config 쓰기(결과 무시) → 235 store 준비, 244 마이그레이션→1, 255-259 주인→1, 266-269 파일→1, 282·288 connector·doctor→1. `connectHarnesses`(422)는 거부를 줄로만 남긴다. `settings()`(298)는 그대로 쓰되 extra를 더한다.
- `apps/cli/src/install.ts` -- `runInstaller`(61)·`runInstallerWithFlags`(75)·`guarded`(84, `Cancelled`→1), `systemInstallDeps().config`(119-130: 읽기 실패를 `undefined`로 바꾸고 경고를 버림, F1·F2의 뿌리), 진입점 `process.exitCode = await runInstaller()`(209). bootstrap(`tooling/bootstrap/src/bootstrap.ts:140-147`)은 `dist/install.js`의 exit를 그대로 넘긴다. exit 숫자 의미는 바꾸지 않는다.
- `apps/cli/src/commands/setup-run.ts` -- `reason()`·`CODED_LINE`·`consentMessage()`(104-136)를 지운다. `givenArgs`(144)는 흐름 쪽(`InstallFlags`에서 만드는 곳)으로 옮기거나 함께 쓴다. `SetupRunData{lines}`를 보고 모양으로 바꾼다. `toFlags`(159)는 그대로 둔다.
- `apps/cli/src/install/store.ts` -- `prepareStore`(40-73): `open(path,'a',0o600)` + `handle.chmod`(46-48)가 판정 없이 돈다. 마이그레이션은 DB가 아닌 파일을 `MIGRATION_FAILED`/`file:''`로 돌려준다(`packages/sqlite/src/migrate.ts:170-177`). 헤더 판정 헬퍼는 저장소 어디에도 없다. `prepareSelfUser`(104)·`SelfUserResult`(80)는 이미 값이다.
- `apps/cli/src/config/codec.ts` -- `readConfig`(119, 다른 호출: `dispatch.ts:425`, `doctor/checks.ts:96`. 동작은 바꾸지 않는다). `readPath`(221)·`isTimeZone`(406)·`flatten`(358)·`unknownKeyWarnings`(376)는 부분 읽기에서 함께 쓴다. `writeConfig`(269)는 277·285·`quote` 335에서 던지고, 모르는 키는 렌더링하지 않는다.
- `apps/cli/src/dispatch.ts` -- `CommandFailure`(133)에는 `warnings`가 없고, `finish`(499-507)는 실패에 `warningCodes`만 넘긴다. `warnings?`를 더해 합친다. 명령 경고의 텍스트 줄은 `경고: CODE`(519)다.
- `packages/core/src/codes.ts` -- `ERROR_CODES`(139-268)·`WARNING_CODES`(17-53)·`WARNING_CODE_MEANINGS`. 새 코드는 README 표(`## 종료 코드` 171, `### 오류 코드` 197, `### 경고 코드` 221)와 `readme-codes.test.ts`가 양방향으로 대조한다. spine Conventions 목록은 `architecture-brain-v1-slice-1.md:473`에 있다.
- `packages/core/src/envelope.ts` -- `Failure`, `requireConfirmation(call, message?)`를 재사용한다.
- 테스트:
  - `apps/cli/test/install-flow.test.ts`: `harness()` 276, fake config 301-314, `fakeStore` 159. `runInstallFlow` 호출이 약 50개이고 `expect(exit)`가 약 43개다. 결과에서 exit를 꺼내는 헬퍼 하나로 바꾼다.
  - `setup.test.ts`: 376-380은 `data.lines`, 406-430은 exit 2, 438-510은 exit 3.
  - `install-store.test.ts`: 109는 기존 파일 chmod, 155는 DB가 아닌 파일 → 이제 `DB_UNAVAILABLE`.
  - `install.test.ts`는 `dist/install.js`를 14번 spawn한다. `config.test.ts` 342·352는 `rejects.toThrow` → 값.
  - `envelope.test.ts`: 48·52.
- `README.md` -- 30-55(질문 목록 "둘뿐", 순서, 비대화형), 128-131(`data.lines`), 133-155(`CONFIRMATION_REQUIRED` 예), 330-335(config 키).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/codes.ts` -- `CONFIG_VALUE_RESET`(경고)·`SETUP_INCOMPLETE`·`SETUP_CANCELLED`(오류)를 더한다(meaning·hint 한국어).
- [x] `apps/cli/src/config/codec.ts` -- `readConfigForSetup(home)`(값별 부분 읽기 + `extra` 원본 테이블 + 경고, 또는 `CONFIG_INVALID`)를 더하고 `readConfig`와 검사를 함께 쓴다. `writeConfig(home, input & {extra?})`는 값을 돌려주고 extra를 합쳐 렌더링한다.
- [x] `apps/cli/src/install/store.ts` -- 헤더 판정을 open·chmod 앞에 둔다.
- [x] `apps/cli/src/install/flow.ts` -- `InstallResult`·`InstallReport`, 새 순서, TTY 동의 화면과 질문, 경고 수집, 실패 줄 제거, connector·doctor 실패를 값으로, `requireConfirmation` 직접 반환. `InstallConfigIo`의 모양을 코덱에 맞춘다.
- [x] `apps/cli/src/install.ts` -- 결과를 exit로 바꾸고, 실패 줄·hint·동의 안내 줄을 찍는다. `Cancelled` → 취소 실패 값. config 의존성을 새 코덱 함수로 연결한다.
- [x] `apps/cli/src/commands/setup-run.ts`, `apps/cli/src/dispatch.ts` -- 결과를 그대로 엔벨로프로 낸다. 로그 파싱 함수는 지운다. `CommandFailure.warnings?`를 더한다.
- [x] 테스트 -- 매트릭스의 각 행(흐름 단위 + `dist/bin.js setup run --json` 통합 3행 이상: 잘못된 store 경로, 틀린 값 하나, 모르는 키), 위 기존 테스트 갱신, 새 문장에 출력 언어 검사를 건다.
- [x] `README.md` -- 질문·동의·순서, 보존 규칙(부분 읽기, 모르는 키), `files.path`는 묻지 않음, `setup run --json` 보고 모양과 `ok:false`, 새 코드 표 행.
- [x] `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- Conventions 코드 목록(473)에 새 코드 셋을 더한다.

**Acceptance Criteria:**
- Given 모든 실패 경로, when `setup run --json`, then `ok:false`이고 `error.exit_code`가 프로세스 exit와 같으며, `setup-run.ts`에 로그 줄 파싱이 남지 않는다.
- Given 같은 home에서 `setup run --yes`를 두 번, when 두 번째가 끝남, then config.toml이 `cmp`로 같다(모르는 키 포함).
- Given npx 진입점(`dist/install.js`), when 각 실패, then exit 숫자가 이 변경 전과 같다(DB가 아닌 파일만 `MIGRATION_FAILED`→`DB_UNAVAILABLE`, exit 1 그대로).

## Design Notes

- 결과 타입:
  ```ts
  type InstallResult =
    | { ok: true; report: InstallReport; warnings: readonly WarningCode[] }
    | { ok: false; failure: Failure; warnings: readonly WarningCode[] };
  ```
  `failure.exit`가 비면 표 기본값을 쓴다. npx 진입점의 exit도 같은 규칙으로 정한다(`errorCodeSpec`).
- config 쓰기를 파일 루트 뒤로 미루는 이유: config는 이 실행이 실제로 쓸 수 있다고 확인한 경로만 기록해야 한다. 미러는 아직 아무도 만들지 않으므로 확인할 것이 없다.
- 통째로 못 읽는 파일을 기본값으로 덮지 않는 이유: 오타 하나로 `files.path`(질문도 플래그도 없음)를 잃는 것이 F1의 핵심이다. 고치라고 멈추는 쪽이 되돌릴 수 있다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 통과(Postgres 컨테이너 포함)
- `grep -n "CODED_LINE\|reason(\|consentMessage" apps/cli/src/commands/setup-run.ts` -- expected: 결과 없음

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에서 회고 동작 확인 2·3·4번을 다시 돈다(틀린 값 하나, 모르는 키, 실패한 `--json`). 기대: 값이 남고, 경고가 나오고, `ok:false`.
- TTY에서 `node apps/cli/dist/bin.js setup run`을 돌려 동의 화면을 읽는다. 아니요라고 답한 뒤 home에 새 파일이 없어야 한다.

## Implementation Notes

- 흐름: `InstallResult`·`InstallReport`(snake_case, 엔벨로프 `data` 그대로), `installExit`(실패의 `exit` → 코드표 → 1), `failureLines`(코드 줄 + 들여쓴 hint, npx 진입점과 테스트가 함께 씀), `wasHelped`. `runInstallFlow`는 `--help`에 `{ok:true, helped:true}`를 돌려준다. `runInstallerWithFlags`는 렌더링하지 않고 결과만 돌려준다(디스패처가 렌더링).
- `RecordedConfig`는 코덱의 `SetupConfig` 별칭이다. `install.ts`의 어댑터를 없애고 `readConfigForSetup`·`writeConfig`를 직접 연결했다. 그 어댑터가 F1·F2의 뿌리였다.
- `InstallStore.exists`를 더했다(`storeFileExists`). 동의 화면이 "새로 만듦"과 "있는 것을 마이그레이션"을 구별하는 데만 쓴다.
- TTY 경로 재질문 줄은 `CONFIG_INVALID: …` 대신 평문(`… 다시 묻습니다.`)이다. 흐름은 실패 줄을 찍지 않는다. 비TTY에서는 같은 문장이 `CONFIG_INVALID` 실패 값으로 나간다.
- `nonInteractiveGuidance()`를 지웠다. npx 진입점은 `CONFIRMATION_REQUIRED: <메시지>`와 hint 줄을 찍는다.
- connector가 둘 이상 거부하면 첫 거부의 코드가 실패로 나가고, 나머지는 그 message에 이름만 실린다.
- Ctrl-C(`Cancelled`)는 `guarded`가 `SETUP_CANCELLED` 값으로 바꾼다. 하네스 질문에서 누른 Ctrl-C는 그때까지 밟은 단계를 남긴다. 텍스트 모드라 그 전에 모은 경고는 이미 줄로 찍혀 있다.
- DB 판정(`notADatabase`): 읽기용 `open`이 `ENOENT`일 때만 새 DB로 본다. 그 밖의 열기·읽기 실패는 거절한다(review 패치).
- 검증: `pnpm test` 1088개 통과(Postgres 컨테이너 포함). 매트릭스 감사에서 "connector 거부 뒤 나머지 하네스 계속 연결" 테스트가 없어 오케스트레이터가 `install-flow.test.ts`에 한 개 더했다.

## Plan Change Log

## Review Triage Log

### 2026-10-17 — Review pass
- verdicts: 8 findings — high 0, medium 0, low 8, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `codec.ts` `unknownKeyNames`·`merged` — 알려진 테이블 이름과 겹치는 모르는 값(`files = "/x"`, `[timezone] x = 1`)이 경고 없이 또는 경고 뒤에 버려진다 — 재현은 맞다. 하지만 TOML 하나에 `files = "x"`와 `[files] path`를 함께 쓸 수 없고, plan의 "알려진 키가 이긴다"가 정한 결과다. 손으로 테이블 자리에 스칼라를 쓴 경우에만 나고, 경고를 따로 붙이려면 모양 검사 분기가 필요하다.
  - `[low]` `[patch]` `codec.ts` `reset` — `CONFIG_VALUE_RESET`이 플래그·답이 이기는 경우에도 기본값을 "대신 씁니다"라고 말한다 — 문장을 "버립니다. 기본값은 X입니다"로 고쳤다.
  - `[low]` `[patch]` `codec.ts` `reset`(schema_version 없음) — "알 수 없는 종류의 값 undefined"가 사람용 줄에 나온다 — 없는 경우를 "schema_version 키가 없습니다"로 가르고 테스트를 조였다.
  - `[low]` `[patch]` `store.ts` `notADatabase` — 읽을 수 없는 DB 아닌 파일(mode 0200)이 chmod·마이그레이션된다 — `ENOENT`만 통과시키고 그 밖은 `DB_UNAVAILABLE`로 거절했다. mode 0200 테스트를 더했다.
  - `[low]` `[patch]` `flow.ts` `askToProceed`, 쓰기 뒤 진행 줄 — config.toml도 0600이라고 말하지만 실제로는 0644다 — 두 줄 모두 `(.env는 mode 0600)`으로 고쳤다.
  - `[low]` `[reject]` `flow.ts` `askToProceed` — DB가 아닌 파일에도 "이미 있는 데이터베이스를 마이그레이션합니다"라고 보인다 — TTY에서 잘못된 경로를 줄 때만 나고, 바로 다음 단계가 파일을 건드리지 않고 거절한다. 세 번째 상태를 더해야 해서 직접 수정을 넘는다.
  - `[low]` `[patch]` `install.ts` `guarded`, `codes.ts` `SETUP_CANCELLED`, README — 뒤쪽 질문에서 누른 Ctrl-C도 "아무것도 쓰지 않았다"고 적혀 있고 경고 코드가 빠진다 — 경고 누락은 TTY 텍스트 모드에서만 생기고, 그 경고는 이미 줄로 찍혀 있어 영향이 없다. 주석과 README를 "동의 화면 전에는 쓰지 않고, 뒤 질문의 Ctrl-C는 그 자리에서 멈춘다"로 고쳤다.
  - `[low]` `[patch]` `codec.ts` `unknownKeyWarnings` — "모르는 키를 무시합니다"가 지워진다는 뜻으로 읽힌다 — "이 버전이 모르는 키 X가 있습니다. 쓰지는 않고 그대로 둡니다"로 바꾸고 테스트와 README 인용을 맞췄다.

## Auto Run Result

- **요약:** 설치 흐름이 `InstallResult`(구조화 보고 + 경고 코드, 또는 Core `Failure`)를 돌려준다. `setup run`은 그 값을 그대로 엔벨로프로 내고, 실패는 늘 `ok:false`다. npx 진입점은 같은 값을 줄과 exit로 렌더링한다. config는 store·주인·파일 루트 뒤에 쓴다. DB 판정은 chmod 앞에 있다. 설정은 값별로 부분 읽기하고 모르는 키를 보존한다. `writeConfig`는 값을 돌려준다. TTY 동의 화면을 더했다. 새 코드는 `CONFIG_VALUE_RESET`·`SETUP_INCOMPLETE`·`SETUP_CANCELLED`다.
- **바뀐 파일:**
  - `packages/core/src/codes.ts`: 새 코드 셋.
  - `apps/cli/src/config/codec.ts`: `readConfigForSetup`, `writeConfig`의 값 반환과 `extra` 합치기, 경고 문장.
  - `apps/cli/src/install/store.ts`: SQLite 헤더 판정, `storeFileExists`.
  - `apps/cli/src/install/flow.ts`: 결과 타입, 새 순서, 동의 화면, connector·doctor 실패를 값으로.
  - `apps/cli/src/install.ts`: 결과 렌더링, Ctrl-C를 `SETUP_CANCELLED`로, 코덱 직접 연결.
  - `apps/cli/src/commands/setup-run.ts`: 로그 파싱 제거, 보고를 `data`로.
  - `apps/cli/src/dispatch.ts`: `CommandFailure.warnings`.
  - 테스트: `config`, `dispatch`, `install-flow`, `install-store`, `install`, `setup`, `core/codes`.
  - `README.md`: 설치 질문·동의·순서·보존 규칙, `setup run --json` 보고, 코드 표.
  - spine Conventions 코드 목록.
- **review:** quick 1회, 8건. 패치 6건(모두 low), 연기 0건, 기각 2건. 기각한 것은 알려진 테이블 이름과 겹치는 모르는 값(plan 규칙 "알려진 키가 이긴다", 손으로 쓴 비정상 모양에서만 남)과 DB가 아닌 파일에 대한 동의 화면 문구(바로 다음 단계가 건드리지 않고 거절함, 세 번째 상태가 필요)다.
- **follow-up review 권장:** false. 패치는 high 0건, medium 0건, low 6건이다.
- **검증:**
  - `pnpm test`: 39개 파일, 1088개 테스트 통과(build·typecheck 포함, Postgres 컨테이너 사용).
  - verify grep(`CODED_LINE|reason(|consentMessage`): 결과 없음.
  - 구현 서브에이전트가 임시 home에서 회고 동작 확인 2·3·4번과 DB가 아닌 파일 거절을 실제 CLI로 확인했다.
  - TTY 동의 화면은 가짜 prompts와 실제 파일 시스템으로 확인했다. 실제 터미널에서 사람이 읽어 보는 확인은 하지 않았다.
- **남은 위험:**
  - `setup run --json`의 `data.lines`가 사라졌다(의도한 계약 변경). 이를 읽는 외부 소비자는 없다.
  - 동의 화면의 실제 터미널 렌더링(@clack/prompts)은 사람이 보지 않았다.
