---
title: '명령 메타, guide 명령(schema·exit-codes·show)과 이름공간 정리'
type: 'feature'
ticket: '3'
created: '2026-10-16'
status: done
baseline_revision: 'f17e69d4469ee1a492a89c19e1b2aab4fca3b14c'
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

**Problem:** 명령이 무엇에 쓰이고 무엇을 받고 내며 얼마나 위험한지를 에이전트가 물어볼 곳이 없다. 종료 코드·오류 코드의 뜻과 대응도 README와 JSDoc에 흩어져 있어 코드와 어긋나도 잡히지 않는다. 대상이 없는 `admin` 이름공간이 아직 남아 있다(spine AD-5).

**Approach:** `CommandSpec`이 메타 7칸을 반드시 선언하게 하고, 그 메타에서 `brain guide schema`와 `--help`를 만든다. Core 코드 상수에 뜻을 더해 `brain guide exit-codes`와 README 표를 같은 원본에서 나오게 하고 양방향 대조 테스트로 묶는다. CLI 사용 규약은 Core 상수의 Markdown으로 `brain guide show`가 낸다. `admin doctor`는 `doctor run`으로 옮긴다.

## Boundaries & Constraints

**Always:**
- 메타 7칸: `usedFor`(한 줄, `--help` 설명), `required`(꼭 줘야 하는 입력 이름: 위치 인자·옵션 이름, stdin이면 `stdin`), `examples`(`brain <ns> <verb> …` 명령줄), `output`(`data` 모양 한 줄), `risk`(`read`·`write`·`destructive`), `hook`, `dryRun`(boolean). 기존 `description`은 `usedFor`로 바꾸고 둘을 두지 않는다. JSON 키는 엔벨로프처럼 snake_case(`used_for`, `dry_run`).
- `guide` 세 명령은 `standalone`이다(설정·DB 없이 돈다. 2.5의 설치 완료 검증이 `guide schema --json`을 부른다). `hook: false`, `risk: read`.
- `guide exit-codes`와 README는 Core 상수 하나에서 나온다: 종료 코드 행 `{code, meaning, agent_action}`(0~3과 "hook 경로는 늘 0" 행), 오류 코드 `{code, exit_code, retryable?, meaning, hint}`, 경고 코드 `{code, meaning}`. `meaning`·`agent_action`은 한국어(출력 언어 검사 대상).
- `guide show`는 Markdown이고 CLI 사용 규약 절만 담는다: 종료 코드와 에이전트 행동, 에이전트 금지 행동 6개(`--yes` 자동 부착, `retry`를 그대로 실행, 백오프 루프 재시도, 덜 파괴적 동사로 우회, 이전 승인 재사용, `--json`으로 게이트 우회), stderr는 실패 신호가 아니고 종료 코드를 본다. 종료 코드 부분은 같은 Core 상수에서 만든다.
- `admin doctor` → `doctor run`: 옛 이름은 남기지 않는다(`brain admin doctor`는 `USAGE` exit 2). SDK `Brain.admin.doctor()` → `Brain.doctor.run()`, Core hint·README·주석·테스트를 맞춘다. 보고 내용과 exit는 바뀌지 않는다.
- 새로 쓰는 사람용 문장(메타 `usedFor`·`output`, meaning, agent_action, guide 텍스트, README)은 한국어이고 2.16의 출력 언어 검사를 통과한다.
- Decision(2026-10-16, 사용자): 플랜 크기(약 3,500 토큰)는 넘지만 나누지 않는다. 티켓 verify가 메타·guide·README 대조·이름 바꾸기를 함께 요구한다.

**Never:**
- 기록 규율 본문(epic 3), MCP 스키마 생성·`Brain.guide`의 SDK 노출(epic 9), 플러그인 스킬 parity(E10).
- `--dry-run` 옵션 구현(지금 명령은 모두 `dryRun: false`).
- 오류·경고 코드의 추가·삭제나 exit·retryable·hint 값 변경(뜻 칸만 더한다; hint의 `admin doctor` 문구만 고친다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 전체 schema | `guide schema --json`(설정 없는 home) | `data.commands`가 등록부 순서의 모든 명령과 메타·인자·옵션 | exit 0 |
| 좁힌 schema | `guide schema doctor` / `guide schema doctor run` | 그 ns의 명령들 / 한 명령 | exit 0 |
| 없는 대상 | `guide schema nope`, `guide schema doctor nope` | `USAGE`, message에 아는 ns 또는 verb | exit 2 |
| 종료 코드 | `guide exit-codes --json` | `data`가 Core 상수와 같다 | exit 0 |
| 안내 | `guide show` | 규약 절 Markdown(금지 행동 6개 포함) | exit 0 |
| 옛 이름 | `brain admin doctor` | `USAGE` | exit 2 |
| 새 이름 | `brain doctor run [--json]` | 예전 `admin doctor`와 같은 보고·exit | 설정이 깨져도 돈다(`diagnostic`) |
| 메타 누락 | 7칸 중 하나 없는 spec(테스트용 캐스트) | 메타 검사 실패 | — |
| 문서 어긋남 | README 표에서 코드 하나를 빼거나 더함, 또는 표가 0행 | 대조 테스트 실패 | — |

</frozen-after-approval>

## Code Map

- `apps/cli/src/dispatch.ts` -- `CommandSpecBase`(158-178: `ns`·`verb`·`description`·`nsDescription?`·`options?`·`arguments?`·`hook?`), `DatabaseCommandSpec`(181-199, `diagnostic` 주석 193이 `admin doctor`를 부름), `StandaloneCommandSpec`(208-211). `buildProgram`(580-614): ns 설명은 `nsDescription ?? \`${ns} 명령\``, 명령은 `.description(spec.description)`·JSON_FLAG·options·arguments. `quiet()`·`HELP_TITLES`(621-646), `usageMessage`(666-669), `findSpec`(720). 위치 인자 검사(빈 값·제어문자)는 2.1의 것을 그대로 쓴다.
- `apps/cli/src/commands/index.ts:18-23` -- 등록부(순서 = `--help` 순서). `admin-doctor.ts`(`adminDoctor`, `formatCheck`·`formatSummary` export, `context.brain.admin.doctor()`), `sessions-ingest.ts`(hook·writes·`<harness>`, stdin), `setup-run.ts`(standalone, 옵션 4개), `setup-connect.ts`(standalone, `<harness>`).
- `apps/cli/src/install/flow.ts:4` -- `formatCheck`를 `../commands/admin-doctor.js`에서 import(94 주석). 사람에게 doctor 명령 이름을 보이는 줄은 없다.
- `packages/core/src/codes.ts` -- `WARNING_CODES`(17-53, 16개 문자열 배열, 뜻은 JSDoc뿐), `ErrorCodeSpec{exit, retryable?, hint}`(77-94), 표 14개(96-213), `errorCodeSpec`(238). hint 135·153·169가 `brain admin doctor`를 안내한다.
- `packages/core/src/brain.ts` -- `BrainAdmin`(50), `Brain{admin, sessions, close}`(59-63), `createBrain`(69-82). `index.ts:38-49`가 `admin/doctor.ts`(`runDoctor` 등)와 `BrainAdmin`을 export.
- `packages/core/src/testing/language.ts:200` -- `assertKoreanProse`. CLI 쪽 래퍼 `apps/cli/test/language.ts`(`assertKoreanLine` 59, `assertKoreanLines` 64).
- 이름을 바꿀 테스트: `apps/cli/test/admin-doctor.test.ts`(argv `['admin','doctor']` 16곳), `shim.test.ts:309-351`, `setup.test.ts:519·550`, `install-store.test.ts:325-327`, `output-language.test.ts:121-177`(`admin nope`·`admin docter`), `dispatch.test.ts:215`(가짜 spec), `packages/core/test/doctor.test.ts:358·377`, `codes.test.ts:156`. 주석: `ports/store.ts:66·224`, `postgres/src/store.ts:135`, `sqlite/test/store.test.ts:277`, `doctor/{checks,store}.ts`, `install/store.ts:173`, `tooling/bootstrap/test/bootstrap.test.ts:599`, `compose.test.yaml:5`.
- `apps/cli/test/output-language.test.ts:59-111` -- 등록부에서 `COMMAND_WORDS`·`HELP_TARGETS`를 만들고 설명과 `--help`를 검사한다. 메타 문장도 여기에 건다.
- `apps/cli/test/dispatch.test.ts:56+` -- 가짜 등록부. 가짜 spec도 메타를 채워야 한다(헬퍼 하나).
- `README.md` -- `## 종료 코드`(171-188, `| 코드 | 뜻 |` 0~3), `admin doctor` 45·268·271·274·318, `## 설치 상태 확인`(255-321). 오류·경고 코드 표는 없다.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/codes.ts` -- `ErrorCodeSpec.meaning`, 경고 코드마다 `meaning`(배열은 유지하고 뜻 표를 곁에, 둘의 키가 같음을 테스트), `EXIT_CODES`(0~3 + hook 행 `{code, meaning, agent_action}`), `exitCodeGuide()`(세 목록을 묶은 값). hint의 `brain admin doctor` → `brain doctor run`.
- [ ] `packages/core/src/guide.ts`(신규), `index.ts` -- `guideShow()`: 규약 절 Markdown(종료 코드 부분은 `EXIT_CODES`에서). export.
- [ ] `packages/core/src/admin/` → `packages/core/src/doctor/`, `brain.ts`, `index.ts` -- `BrainDoctor{run()}`, `Brain.doctor`. 주석 갱신.
- [ ] `apps/cli/src/dispatch.ts` -- `CommandMeta`(7칸 필수)를 `CommandSpecBase`에 합치고 `description` 제거. `buildProgram`이 `usedFor`를 설명으로, `addHelpText('after', …)`로 예시·출력·위험도(한국어 라벨)를 붙인다. `validateCommandMeta(spec)` export: 7칸 존재·타입, `risk` 값, `writes`면 `risk ≠ read`, `dryRun`이면 `--dry-run` 옵션, `<arg>`마다 `required`에 이름, 예시가 `brain <ns> <verb>`로 시작.
- [ ] `apps/cli/src/commands/doctor-run.ts`(`admin-doctor.ts`에서 이동), `guide-schema.ts`·`guide-exit-codes.ts`·`guide-show.ts`(신규), `index.ts`, 기존 3개 명령 -- 메타 채우기, `guide schema [ns] [verb]`는 등록부를 받는 팩토리. 텍스트 모드: schema는 명령마다 몇 줄, exit-codes는 표, show는 Markdown 그대로. `install/flow.ts` import 경로.
- [ ] 테스트 -- 등록부 전체가 `validateCommandMeta`를 통과하고 칸 하나씩 뺀 spec은 실패, 예시를 실제로 `select`하면 그 명령이 고른다, 매트릭스 각 행(`dist/bin.js`), `guide exit-codes` = Core 상수, 메타·meaning·agent_action·guide 출력에 출력 언어 검사, 위 이름 바꿀 테스트 갱신(`admin-doctor.test.ts` → `doctor-run.test.ts`).
- [ ] `apps/cli/test/readme-codes.test.ts`(신규) -- README의 종료 코드·오류 코드·경고 코드 표를 파싱해 Core 목록과 양쪽으로 비교(오류는 exit도). 어느 표든 0행이면 실패.
- [ ] `README.md` -- `## 종료 코드`를 `코드 | 뜻 | 에이전트 행동` 표로, 오류 코드 표(`코드 | exit | 뜻`)와 경고 코드 표(`코드 | 뜻`), "stderr가 비어 있지 않아도 실패가 아니다, 종료 코드를 보라" 문장, `guide` 절, `admin doctor` → `doctor run`.

**Acceptance Criteria:**
- Given 설정 없는 home, when `brain guide schema --json`·`guide exit-codes --json`·`guide show`, then 모두 exit 0이고 schema의 명령 목록이 등록부와 같다.
- Given `brain doctor run --help`, when 실행, then 설명·예시·출력·위험도가 메타 그대로 한국어로 나온다.
- Given `pnpm test`, when Core에 오류 코드를 더하고 README를 고치지 않으면, then 대조 테스트가 실패한다.

## Implementation Notes

- 메타는 `CommandMeta`(`apps/cli/src/dispatch.ts`)이고 `CommandSpecBase extends CommandMeta`라서 7칸이 타입으로 필수다. `description`은 없앴고 `hook`은 선택이 아니게 되었다(`spec.hook === true` 쓰는 자리는 그대로 돈다). `--help`는 `description(spec.usedFor)` + `addHelpText('after', helpAfter(spec))`이고, `helpAfter`는 `반드시 줄 것`(backtick으로 싸서 출력 언어 검사를 통과)·`예시`·`출력`·`위험도`(`RISK_LABELS`의 한국어)를 낸다. `hook`·`dryRun`은 `--help`에 넣지 않았다 — 명령줄을 어떻게 치는지가 아니라 호출하는 쪽이 어떻게 엮여 있는지라서 `guide schema`의 몫이다.
- `validateCommandMeta(spec)`은 문제 목록을 돌려준다(던지지 않는다). 7칸 존재·타입, `risk` 값, `writes`면 `risk ≠ read`, `dryRun`이면 `--dry-run` 옵션, `<arg>`마다 `required`에 이름(`[arg]`는 묻지 않는다), 예시가 `brain <ns> <verb>`로 시작. 예시가 실제로 그 명령을 고르는지는 새로 export한 `selectedCommand(registry, argv)`로 본다 — `select()`를 그대로 쓰므로 commander의 인자·옵션 검사까지 지나간다. 그래서 `sessions ingest`의 예시에서 `< payload.json`을 뺐다(리다이렉션은 argv가 아니다).
- Core: `ErrorCodeSpec.meaning`(14개), `WARNING_CODE_MEANINGS`(배열은 순서 때문에 그대로 두고 record를 곁에, 키가 같은지 테스트), `EXIT_CODES`(`0`~`3` + `hook` 행, `code`가 string인 이유는 hook 행이 숫자가 아니기 때문), `exitCodeGuide()`(세 목록을 복사해 돌려주므로 받은 쪽이 바꿔도 다음 호출이 오염되지 않는다 — 테스트로 고정). `packages/core/src/guide.ts`의 `guideShow()`가 규약 절 Markdown을 내고 종료 코드 표는 `EXIT_CODES`에서 만든다.
- `guide` 세 명령은 모두 `standalone`·`risk: read`·`hook: false`다. `guide schema`는 등록부를 **함수로** 받는다(`guideSchemaCommand(() => commands)`) — 자기 자신이 그 등록부 안에 있으므로 값으로 넘기면 자기 정의 앞에 자기를 읽어야 한다. JSON 키는 엔벨로프대로 `used_for`·`dry_run`이고, 인자는 `{name, required}`(`<x>`면 required), 옵션은 `{flags, description}`이다.
- 텍스트 모드의 출력 언어: `hook:`·`exit N`처럼 한글 없는 절에 영어 낱말만 남는 모양을 검사기가 잡으므로, `guide schema`는 `위험도: \`read\` · hook 경로: 아니요 · \`--dry-run\`: 없습니다`로, `guide exit-codes`는 `(종료 2)`로 적었다. 명령 이름·입력 이름은 `output-language.test.ts`와 `guide.test.ts`의 `COMMAND_WORDS`에 메타(`required`, `examples`의 낱말)를 더해 허용한다.
- `admin` 이름공간은 사라졌다. `packages/core/src/admin/` → `doctor/`(파일 이름은 그대로라 `doctor/doctor.ts`), `BrainAdmin` → `BrainDoctor{run()}`, `Brain.admin` → `Brain.doctor`, `commands/admin-doctor.ts` → `doctor-run.ts`(`adminDoctor` → `doctorRun`, `AdminDoctorData` → `DoctorRunData`), 테스트 파일도 `doctor-run.test.ts`로 옮겼다. 등록부 순서는 `doctor`, `guide`, `sessions`, `setup`이다.
- `apps/cli/test/guide.test.ts`에 `brain admin doctor`가 `USAGE`로 거절되는 것을 단정하는 테스트가 하나 있다. 플랜의 verify grep("결과 없음")에 걸리는 유일한 자리이고, 매트릭스의 '옛 이름' 행이 그것을 요구하므로 남겼다.
- `readme-codes.test.ts`는 제목(`## 종료 코드`, `### 오류 코드`, `### 경고 코드`) 아래 첫 표를 파싱해 양방향으로 비교한다. 표가 0행이면 실패한다 — 그게 없으면 빈 문서가 모든 비교를 통과한다. 실제로 세 가지 어긋남(README에서 한 행 빼기, Core에 코드 더하기, 표 비우기)으로 실패를 확인했다.
- 범위 밖으로 둔 것: `--dry-run` 옵션 구현(모든 명령 `dryRun: false`), 오류·경고 코드의 추가·삭제(Conventions의 `UPDATE_AVAILABLE`은 2.5의 몫이라 더하지 않았다), MCP 스키마와 `Brain.guide` SDK 노출(epic 9), 기록 규율 본문(epic 3).

## Plan Change Log

## Review Triage Log

- 2026-10-16, quick 1차 — high 0 / medium 1 / low 8 / false 2 / maybe-false 0. 패치 9, 기각 2.
  - medium · patch — `packages/core/src/codes.ts` `EXIT_CODES` 3행이 CLI 전용 `error.retry_argv`를 Core에 넣는다(AD-5 표면 중립 위반, epic 9 표면에서 따를 수 없음). 같은 문서의 금지 행동 "`error.retry`를 그대로 실행하지 않습니다"와도 엇갈려 읽힌다. → 3행을 표면 중립(`error.retry`, 사람이 동의한 뒤)으로 고치고 금지 행동 문장과 맞춘다(README 표 동반).
  - low · patch — `compose.test.yaml:5` 주석이 아직 `brain admin doctor`. Code Map이 고치라고 적은 자리이고 grep이 `.yaml`을 안 봐서 놓쳤다.
  - low · patch — `packages/core/src/domain/index-config.ts:16` 주석이 없어진 `admin.reindex`를 가리킨다. AD-5 표의 `index rebuild`로.
  - low · patch — `README.md:391-394` "`doctor run`은 설정 없이도 도는 유일한 명령 … 다른 모든 명령은 exit 2"가 같은 README의 `guide` 절(설정 없이 돈다)과 모순, 실측도 guide 3개 exit 0.
  - low · patch — `apps/cli/src/dispatch.ts` `validateCommandMeta`의 `spec.risk in RISK_LABELS`가 `toString` 등 프로토타입 키를 통과시키고 `--help`에 함수 원문을 찍는다. own-key 검사로.
  - low · patch — `apps/cli/test/readme-codes.test.ts:93-100` "would notice…" 테스트는 비교 로직을 전혀 거치지 않는다(뒤 단정은 모든 비지 않은 배열에 참). 실제 양방향 보호는 다른 테스트가 한다(구현자·리뷰어 실측). 지운다.
  - low · patch — `apps/cli/src/commands/guide-exit-codes.ts` 텍스트 모드의 ` — ` 구분자가 meaning·hint 안의 줄표와 겹쳐 경계를 알 수 없다(`USAGE`, `CONFIG_INVALID` 실제 출력). hint·agent_action을 다음 줄로.
  - low · patch — `EXIT_CODES` 행의 칸이 readonly가 아니어서 export된 상수를 바꾸면 이후 `exitCodeGuide()`·`guideShow()`가 오염된다. 칸을 readonly로.
  - low · patch — `guide schema` 텍스트 모드가 인자·옵션을 빼먹는데 README는 "메타 일곱 칸과 인자·옵션"이라고 한다. 텍스트 줄에 인자·옵션을 더한다.
  - false — `dispatch.ts` 위치 인자 거절 문구("위치 인자는 id")가 `guide schema`에 틀린다: ns·verb도 명령의 식별자이고 빈 값=실패한 `$(…)`, 제어문자 없음이 그대로 맞는다.
  - false — standalone 명령은 `writes ⇒ risk≠read` 검사를 건너뛴다: `StandaloneCommandSpec`에는 `writes` 칸이 없어 risk와 어긋날 선언 자체가 없다. 검사할 대상이 없다.

## Design Notes

- 메타는 CLI 등록부에 있으므로 `guide schema`는 CLI가 등록부를 읽어 만든다. 종료 코드와 안내문은 Core 상수(AD-17의 "규율 원본은 Core")라 CLI는 렌더링만 한다. MCP가 같은 메타를 쓰게 되면(epic 9) 메타를 표면 중립 자리로 옮긴다.
- 타입이 7칸을 필수로 잡아도 런타임 검사를 따로 둔다: 테스트가 "빠지면 실패"를 직접 보이고, `risk`·`writes`·`required`·`examples` 사이의 일관성은 타입이 못 본다.
- `guide schema --json` 한 명령 예:
  ```json
  {"ns":"doctor","verb":"run","used_for":"이 brain의 설치 상태를 점검합니다","required":[],
   "examples":["brain doctor run","brain doctor run --json"],"output":"checks[]와 summary",
   "risk":"read","hook":false,"dry_run":false,"arguments":[],"options":[]}
  ```

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 통과(Postgres 컨테이너 포함).
- `grep -rn "admin doctor\|brain\.admin\|BrainAdmin" --include=*.ts --include=*.md apps packages tooling README.md` -- expected: 결과 없음.

**Manual checks (if no CLI):**
- `node apps/cli/dist/bin.js guide schema`, `guide exit-codes`, `guide show`, `doctor run --help`를 사람 눈으로 읽어 한국어와 줄 모양을 본다.
