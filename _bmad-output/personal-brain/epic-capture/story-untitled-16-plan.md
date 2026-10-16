---
title: '사람이 읽는 출력을 한국어로'
type: 'chore'
ticket: '16'
created: '2026-10-16'
status: 'built'
baseline_revision: 'a4e2bb0d06eacdcfafa8a7a6a5831d7fa510fb2b'
route: 'full'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** spine Conventions '출력 언어'(2026-10-16 사용자 결정)는 사람이 읽는 문장을 한국어로 정했는데, 지금까지 만든 출력(설치기 줄, doctor 줄, 오류 message·hint, `--help`, README)은 모두 영어다. 이후 스토리가 영어 문장을 새로 넣어도 잡아 줄 검사가 없다.

**Approach:** 사람이 읽는 문장을 한국어로 바꾸고 코드·키·id·명령·옵션 이름은 그대로 둔다. hint 문체 검사를 한국어 기준으로 고치고, 영어 문장을 거부하는 출력 언어 검사 도우미를 Core testing에 두어 코드 표 hint, doctor 줄, 설치기 줄, 오류 message, `--help`에 건다.

## Boundaries & Constraints

**Always:**
- 영어로 둔다: 오류·경고 코드, JSON 키, 점검 id와 상태 낱말(`ok`·`warn`·`fail`·`skip`), 명령·옵션·인자 이름, 설정 키, 파일 경로, `SHIM_SIGNATURE`(이미 설치된 shim 판별용).
- 오류 message·hint는 텍스트 모드와 `--json`이 같은 문자열이다(한 곳에서 만든다).
- hint 문체: 마침표 없음, 명령은 백틱, 파괴적 hint 금지(영어 낱말 + 지우·삭제·제거·없애·비우). 그 밖의 줄은 합니다체(`tooling/dev/tracer-session.sh`의 말투).
- 흐름 출력의 `CODE: 문장` 앞머리와 들여쓰기 줄은 그대로다 — `commands/setup-run.ts`의 `reason`·`consentMessage`가 그것을 파싱한다.
- Node·SQLite·git이 낸 원문(`describe(error)`)은 번역하지 않고 한국어 문장 뒤에 붙인다.
- 버그·불변식 위반으로 던지는 `Error`(사용자 경로에서 엔벨로프가 되지 않는 것)는 영어로 둔다.
- Decision(2026-10-16, 사용자): 텍스트 모드 실패는 hint가 있으면 stderr의 `CODE: message` 다음 줄에 `  <hint>`(두 칸 들여쓰기)를 더한다. hook 경로는 지금처럼 한 줄이다.
- Decision(2026-10-16, 사용자): 플랜 크기(약 1,700 토큰)는 넘지만 나누지 않는다. verify가 번역과 출력 언어 검사를 함께 요구한다.

**Never:**
- 명령 메타 7칸, `guide`, README 종료 코드 표 대조 테스트(2.3). hook `systemMessage`(2.5·2.14).
- 출력 모양(줄 수, 키, 코드, 종료 코드) 변경 — 위 텍스트 모드 hint 줄만 예외.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 설정 없음 | `brain admin doctor` (설정 없는 home) | `config: fail [CONFIG_MISSING] <한국어 detail>`, 끝 줄 `요약: …` | exit 1 |
| 같은 문장 | 같은 실패를 텍스트와 `--json`으로 | `error.message`·`hint`가 텍스트 모드 문장과 같은 한국어, `code`·키 그대로 | — |
| commander 오류 | 모르는 옵션·인자 누락·인자 초과 | `USAGE`, 한국어 message(commander `error.code`로 고름) | 모르는 commander 코드는 한국어 문장 + 원문 |
| `--help` | `brain --help`, `brain setup run --help` | `사용법:`·`옵션:`·`명령:` 등 한국어 라벨과 설명 | exit 0 |
| 비대화형 동의 | `setup run --json < /dev/null` | exit 3, `error.message`는 흐름이 찍은 한국어 줄(끝 `:` 제거) | — |
| 검사기 음성 | 코드 표 hint나 doctor detail에 영어 문장 하나 | 출력 언어 검사 실패 | — |
| hint 문체 음성 | 마침표로 끝나는 한국어 hint | hint 문체 검사 실패 | — |

</frozen-after-approval>

## Code Map

- `packages/core/src/codes.ts:95-206` -- 오류 코드 14개 `{exit, retryable?, hint}`. message 기본값은 없다. `envelope.ts:156` 확인 게이트 기본 문구.
- 엔벨로프 message 출처: `apps/cli/src/config/codec.ts:127-236·383`(`kindOf` 415-419가 문장 속 낱말을 만든다), `core/src/schema.ts:57-63`, `core/src/sessions/ingest.ts:100-139`, `core/src/domain/session-token.ts:57·66`, `core/src/instant.ts:38-72`, `claude-code/src/{hook.ts:25-60,parser.ts:89}`, `sqlite/src/{sessions.ts:123·235·260,users.ts:83,migrate.ts:152-156,store.ts:97·154}`, `apps/cli/src/commands/{sessions-ingest.ts:47·98-99,setup-connect.ts:48-90}`, `dispatch.ts:398·527·530·630`(`usageMessage`).
- `apps/cli/src/dispatch.ts:303-322` -- 텍스트 출력(`CODE: message`, `warning: …` 380·467). `buildProgram`·`quiet`(570-620): 설명 574·581·587, commander 15.0.0. 라벨은 `configureHelp`·`helpOption`·`helpOption` 설명, 오류는 `usageMessage`에서 `error.code`로 매핑.
- doctor: `commands/admin-doctor.ts:69-82`(`formatCheck`는 설치기 `flow.ts:287`도 씀, `formatSummary`), `doctor/checks.ts:129-228`, `core/src/admin/doctor.ts:54`(`prereqFailed`), `sqlite/src/store.ts:207-296` 탐침 detail.
- 설치기: `install/flow.ts:189-581`(진행 줄·질문 329·348·409·481·플래그 오류·`usage()`·`nonInteractiveGuidance()`), `install.ts:47-52·94·183`, `commands/setup-run.ts:29-32·109`.
- `tooling/bootstrap/src/bootstrap.ts:127-379` -- npx 설치 경로 줄 약 30개. `bin/second-brain.js`는 커밋된 빌드이고 테스트가 둘을 대조하므로 다시 빌드한다.
- 테스트(영어 문장 단정): `apps/cli/test/{install-flow,install,setup,admin-doctor,doctor-checks,config,dispatch}.test.ts`, `packages/core/test/{codes,schema,envelope}.test.ts`, `packages/sqlite/test/store.test.ts:294`, `tooling/bootstrap/test/{bootstrap,npx}.test.ts`. hint 문체 검사는 `codes.test.ts:102-134`(`/^[a-z]/`가 한국어를 막는다). `id: status` 단정은 바뀌지 않는다. README를 읽는 테스트는 없다.
- `README.md` -- 전부 영어. 코드 블록·명령·JSON 키는 그대로 두고 산문과 엔벨로프 예시의 hint를 바꾼다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/testing/language.ts`(+ `testing/index.ts`) -- `englishSentences(text)`·`assertKoreanProse(text)`: 백틱 구간, 대문자 코드, 경로·URL·플래그, 따옴표 값, 허용 고유명사(`Claude Code`, `SQLite`, `Node`, `WAL` 등 목록)를 빼고, 한글이 없거나 라틴 낱말 2개 이상 연속이 남으면 실패 -- 이후 스토리가 같은 검사를 쓴다.
- [x] `packages/core/src/{codes,envelope,schema,instant,admin/doctor}.ts`, `sessions/ingest.ts`, `domain/session-token.ts` -- hint·message 한국어.
- [x] `packages/sqlite/src/*`, `packages/claude-code/src/*` -- 엔벨로프로 가는 message와 탐침 detail 한국어.
- [x] `apps/cli/src/config/codec.ts`, `doctor/checks.ts`, `commands/*`, `install/flow.ts`, `install.ts` -- 문장·질문·진행 줄·`usage()`·`요약:` 줄 한국어. `CODE: ` 앞머리 유지.
- [x] `apps/cli/src/dispatch.ts` -- 설명·`usageMessage`·commander 라벨과 오류 매핑·`경고:` 앞머리 한국어. 텍스트 모드 hint 줄.
- [x] `tooling/bootstrap/src/bootstrap.ts` -- 줄 한국어, `bin/second-brain.js` 재빌드.
- [x] 테스트 -- 위 테스트의 영어 단정을 한국어로. `codes.test.ts` hint 문체를 한국어 기준(마침표·백틱·파괴 낱말 영어+한국어)으로. 출력 언어 검사를 모든 코드 hint, doctor 줄(모든 분기 테스트), 설치기 흐름 출력, codec 오류, commander 오류, 각 명령 `--help`에 건다. 검사기 자체의 음성 사례(영어 hint, 영어 doctor detail, 마침표 hint).
- [x] `README.md` -- 산문 한국어.

**Acceptance Criteria:**
- Given TTY와 `--yes` 두 방식의 `setup run`, doctor, `sessions ingest` 실패, `brain --help`, when 실행, then 출력 문장이 한국어이고 코드·키·점검 id는 그대로다.
- Given 코드 표 hint나 doctor 줄에 영어 문장 하나를 넣음, when `pnpm test`, then 출력 언어 검사가 실패한다.

## Design Notes

- 검사기는 "영어 문장이 없다"를 본다. 한국어 문장 안의 고유명사·코드는 허용 목록과 제거 규칙으로 통과시키고, 원문을 붙인 줄(`describe(error)`)은 그 부분을 검사 입력에서 뺀 채 단정한다.
- 예: `CONFIG_MISSING` hint `` `brain setup run`으로 이 brain을 설치하세요 `` / 요약 `요약: 통과 3, 경고 0, 실패 1, 건너뜀 2`.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 통과
- `node apps/cli/dist/bin.js --help`, `admin doctor`, `setup run --json < /dev/null`(임시 `SECOND_BRAIN_HOME`) -- expected: 한국어 문장, exit 0/1/3

## Implementation Notes

- 검사기는 `packages/core/src/testing/language.ts`(`englishSentences`·`assertKoreanProse`·`ALLOWED_PROPER_NOUNS`)이고 `testing/index.ts`가 내보낸다. 백틱 구간·URL·따옴표 값·경로·플래그·대문자 코드·코드 식별자·줄 앞머리 `id:`/`CODE:` 라벨·허용 고유명사를 지운 뒤, 라틴 낱말이 둘 이상 잇달아 있거나 한 낱말인데 문장에 한글이 없으면 실패한다. 지운 뒤 아무 낱말도 남지 않은 문장(경로 하나, 버전 하나뿐인 detail)은 사람이 읽는 문장이 아니므로 통과한다.
- CLI 테스트용 껍데기는 `apps/cli/test/language.ts`다. Node·SQLite가 낸 원문을 모양으로 알아보고(한글로 끝나는 절 + `: ` + 한글 없는 한 문장) 검사 입력에서 뺀다. 그 덕에 `요약:`처럼 한글이 뒤따르는 줄은 그대로 검사된다.
- 원문을 한국어 문장 뒤에 붙이는 Boundaries를 지키려고, 원문만 들고 있던 message·detail에 한국어 앞머리를 더했다: `openSqlite`, `checkHealth`, `readSchemaVersion`, `readSession`, users 두 곳, `withWrite`의 `DB_LOCKED`, `MIGRATION_FAILED`, writable·generic 탐침, Core의 registered 점검, `fileTranscriptReader`, 설치기의 store·files 준비, codec의 읽기·TOML 파싱 실패.
- commander: `quiet()`에 `helpOption('-h, --help', …)`과 `configureHelp({ styleTitle })`를 더해 `사용법:`·`인자:`·`옵션:`·`전체 옵션:`·`명령:`을 한국어로 바꿨다. 오류는 `COMMANDER_REASONS`가 `error.code`로 한국어 문장을 고르고 commander가 따옴표로 감싼 값(옵션·인자·명령 이름)만 뒤에 붙인다. 모르는 코드는 한국어 문장 + 원문이다. `[options]`·`[command]`는 commander의 자리표시자라 그대로 둔다.
- 텍스트 모드 실패는 `CODE: message` 다음 줄에 `  <hint>`를 더한다(Decision 2026-10-16). hook 경로는 앞서 돌아가므로 여전히 한 줄이다.
- 검사를 건 곳: 코드 표 hint 전부(`packages/core/test/codes.test.ts`), doctor 모든 분기(`admin-doctor.test.ts`의 `runBrain`, `doctor-checks.test.ts`의 `report`), 설치기 흐름 출력 전부(`install-flow.test.ts`의 `log`), codec 오류 전 분기(`config.test.ts`), commander 오류와 모든 명령의 `--help`와 레지스트리 설명(`apps/cli/test/output-language.test.ts`, 레지스트리에서 목록을 만들므로 명령을 더하면 자동으로 포함된다).
- hint 문체 검사는 `hintStyleProblems`로 뽑아내 음성 사례(마침표, 백틱 밖 명령, 열린 백틱, 영어·한국어 파괴 낱말)로 검사기 자체를 시험한다. `/^[a-z]/` 규칙은 없앴다 — 한국어에는 대소문자가 없다.
- 범위 밖으로 둔 것: `packages/postgres/src`(플랜의 Execution 목록에 없고, 에픽 7의 복제 어댑터라 사용자 경로가 아직 없다. `'unknown error'` 하나가 남아 있다), `apps/cli/src/install/docker.ts`(아무도 참조하지 않는 죽은 모듈).

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-16, quick) — high 0 · medium 3 · low 6 · false 1 · maybe-false 0

| # | Verdict | Route | Finding / evidence |
|---|---------|-------|--------------------|
| 1 | medium | patch | `apps/cli/test/language.ts` `APPENDED_ORIGINAL`이 `<한글>: ` 뒤의 한글 없는 꼬리를 누가 썼든 원문으로 보고 지운다. `경고: …: ignoring unknown key`, `점검이 실패했습니다: the probe threw`가 통과한다. 원문 모양(errno·엔진 코드)이나 테스트가 넘긴 문자열만 지우게 고친다. |
| 2 | medium | patch | `core/src/testing/language.ts` `hasHangul`을 줄 전체로 계산한다. `…없습니다. Run \`brain setup run\`.`과 `요약: passed 3, …`가 통과해서 AC2(doctor 줄의 영어 문장)가 깨진다. 한글 판정을 절 단위로 바꾼다. |
| 3 | low | patch | `sqlite/src/users.ts:129`·`sessions.ts:333`의 `${column} is unreadable`은 우리가 쓴 영어 문장인데 `DB_UNAVAILABLE` 엔벨로프 message로 나간다. 한국어로 바꾼다. |
| 4 | medium | patch | 텍스트 모드 hint 줄이 생기면서 엔벨로프용 hint가 터미널에 그대로 보인다. `CONFIRMATION_REQUIRED`는 텍스트 모드에 없는 `error.retry`를 가리키고, `CONFIG_INVALID`는 플래그 값 오류에도 `config.toml` 키를 고치라고 한다(실행해서 확인). 두 모드 모두에 맞게 문구를 바꾼다. |
| 5 | low | patch | `dispatch.ts` `usageReason`: 인자 초과 때 `'connect'`가 남는 인자처럼 읽힌다. 모르는 옵션 때 commander의 `Did you mean` 제안이 빠진다. 문구 틀을 바꾸고 제안을 붙인다. |
| 6 | low | patch | 고정 토큰 뒤 조사가 틀렸다: `bin/brain를`, `config.toml와`, `app를`·`app는`(실제 출력에서 확인). 바로 고친다. |
| 7 | low | patch | `codes.test.ts` `hintStyleProblems`의 `/\bbrain\b/`가 명사 `brain을`에도 걸린다. 플랜 Design Notes의 예시 hint도 거부된다. 명령 모양만 잡게 고친다. |
| 8 | low | patch | bootstrap 설치기 줄을 번역했지만 출력 언어 검사를 걸지 않았다(Approach는 "설치기 줄"에 건다고 했다). bootstrap 테스트 로그에 검사를 건다. |
| 9 | false | reject | 설명·옵션 설명의 명사형(`관리 명령`, `미러 폴더의 절대 경로`)은 문장이 아니라 이름표다. Boundaries의 합니다체 규칙은 "줄"(진행·안내 문장)에 대한 것이고, `--help` 옵션 설명을 명사구로 쓰는 것은 그 규칙을 어기지 않는다. |
| 10 | low | patch | `codec.ts` `kindOf`의 대체 문구가 `typeof` 영어를 그대로 넣는다(`number 값 3`). 한국어 낱말로 바꾼다. |
