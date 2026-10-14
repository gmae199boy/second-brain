---
title: 'shim, connector 등록부, setup run·connect'
type: 'feature'
ticket: '7'
created: '2026-10-14'
status: 'built'
baseline_revision: '2f6c25f778e1a8fe7f373959f9f9d1b2bccb9bfd'
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

**Problem:** 설치기(story 6)는 DB·설정까지 만들지만, hook이 부를 고정 `brain`(shim)이 없고, Harness를 연결할 등록부와 `brain setup connect`가 없으며, 재설정 명령 `brain setup run`이 없다. 미러 경로·임베딩 질문도 아직 하지 않는다.

**Approach:** AD-19 순서를 마저 채운다: DB → 미러 경로 → 임베딩(“아직 지원 안 함”) → config 기록 → 마이그레이션 등 → shim → Harness 연결 → doctor. Core에 `Connector` port(parser 필수, `connect` 하나가 Harness 설정을 Brain 표식으로 멱등 기록)를 두고, CLI에 등록부(지금은 비어 있음, claude-code는 epic 2)와 `setup connect <harness>`·`setup run`(같은 설치 흐름)을 등록한다.

## Boundaries & Constraints

**Always:**
- shim은 `<home>/bin/brain`, 0755, POSIX sh. 설치 시점의 `process.execPath`(node 절대 경로)와 빌드된 `apps/cli/dist/bin.js` 절대 경로를 담고 `exec`한다. `npx`를 부르지 않는다. 설정 폴더를 `SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-'<home>'}`(대입 문맥, 큰따옴표 없이 — 큰따옴표 안의 작은따옴표는 sh에서 글자 그대로 남는다)로 넘긴다. 내용이 같으면 다시 쓰지 않는다(changed=false). 경로는 sh 작은따옴표로 안전하게 인용.
- 미러 경로는 config.toml의 `mirror.path`(절대 경로, 기본 `<home>/mirror`). 코덱(`KNOWN_KEYS`, `BrainConfig.mirrorPath`, `WriteConfigInput.mirrorPath`)만 읽고 쓴다. 상대 경로는 `CONFIG_INVALID`. 입력의 `~`는 설치기가 펼친다. 폴더는 만들지 않는다(epic 4). 재실행은 기록된 값을 기본값으로 보인다.
- 임베딩: TTY면 “임베딩을 켤까요?”(기본 아니오)를 묻고, 예여도 “아직 지원 안 함, 꺼 둠”을 보이고 설정에 아무것도 쓰지 않는다. 비TTY는 묻지 않고 꺼짐 한 줄.
- `Connector`(core port, 타입만): `harness`(= `parser.harness`), `label`, `parser`, `detect()`, `connect({ shimPath })` → `{ok:true, target, changed}` 또는 `{ok:false, code, message}`. 등록 판정은 Brain 표식(core의 `BRAIN_MARKER` 상수)으로만. 계약 사례(두 번 connect → 두 번째 changed=false, harness 일치)를 `core/testing`에 기존 계약 형식으로.
- `brain setup connect <harness>`: config·DB 없이 돈다. 모르는 harness → `USAGE` exit 2(등록된 이름 나열, 없으면 “아직 없음”). shim이 없으면 `SHIM_MISSING` exit 1(`brain setup run` 안내). `--json` 봉투 data `{harness, target, changed}`.
- `brain setup run`: config·DB 없이 돌고 설치기와 같은 흐름(`runInstaller` 경로)을 같은 플래그로 부른다. `--json`이면 비대화형으로 돌고 흐름의 줄을 `data.lines`, exit 코드는 흐름 그대로.
- 설치기 Harness 단계: TTY면 `detect()`가 참인 connector를 다중 선택(기본 모두 체크)으로 묻는다. 비TTY는 `--connect <harness>`(반복 가능)로 준 것만. 등록부가 비면 “연결할 Harness 없음(epic 2)” 한 줄.
- 새 플래그 `--mirror-path <path>`, `--connect <harness>`. 외부 명령·파일 쓰기는 기존처럼 주입(deps)으로 테스트.

**Never:**
- 실제 claude-code connector·hook 내용(epic 2), doctor의 shim·node 항목(story 8), `setup upgrade`·`uninstall`(epic 5), 임베딩 설정 키나 embeddings 테이블.
- 비TTY에서 묻지 않은 Harness 설정 쓰기. Brain 표식이 없는 사용자 항목 수정·삭제.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 설치 | 빈 home, `--database-url … --yes` | config에 `mirror.path=<home>/mirror`, shim 생성(0755), doctor ok, exit 0 | — |
| 재실행 | 같은 home에서 다시 | config.toml·shim 바이트 동일, shim changed=false, exit 0 | — |
| 미러 경로 지정 | `--mirror-path ~/notes/brain` | 펼친 절대 경로 기록 | 상대 경로 → 다시 묻기(비TTY exit 2) |
| 임베딩 예 | TTY에서 예 | “아직 지원 안 함” 표시, 설정 변화 없음 | — |
| connect 두 번 | 가짜 connector, `setup connect fake` ×2 | 대상 파일에 Brain 표식 항목 1개, 두 번째 changed=false, exit 0 | — |
| 모르는 harness | `setup connect nope` | `USAGE` exit 2 | — |
| shim 없음 | shim 지운 뒤 connect | `SHIM_MISSING` exit 1, 쓰기 없음 | — |
| config 없이 setup | 빈 home에서 `setup run --database-url … --yes` | `CONFIG_MISSING` 아님, 설치 완료 | — |
| 등록부 빔 | 실제 빌드 | “연결할 Harness 없음” 한 줄, 나머지 정상 | — |

</frozen-after-approval>

## Code Map

- `apps/cli/src/install/flow.ts` -- `runInstallFlow`(L134): 순서에 미러·임베딩·shim·connect 단계 추가. `parseFlags`(L503)·`usage`에 두 플래그. `RecordedConfig`·`settings()`(L238)에 `mirrorPath` — 빠뜨리면 재실행이 기본값으로 되돌린다(story 6 리뷰 #2와 같은 함정). `InstallPrompts`에 `multiselect`, `InstallDeps`에 `shim`·`connectors`. 흐름과 플래그 해석을 나눠 `setup run`이 commander 옵션으로 `InstallFlags`를 만들어 넘길 수 있게.
- `apps/cli/src/install.ts` -- `systemInstallDeps`(L95)에 shim 쓰기·등록부·clack `multiselect` 연결. `invokedDirectly` 유지.
- `apps/cli/src/install/shim.ts` (새) -- `shimPath(home)`, `renderShim({node, bin, home})`, `writeShim(home, …) → {path, changed}`. bin.js 경로는 `new URL('../bin.js', import.meta.url)`(dist 기준).
- `apps/cli/src/config/codec.ts` -- `KNOWN_KEYS`(L28)에 `mirror.path`, 읽기 검증·기본값(`join(home,'mirror')`), `writeConfig`(L191) 렌더에 `[mirror] path`.
- `apps/cli/src/dispatch.ts` -- `execute`(L196)는 config·store를 먼저 만든다. `CommandSpec`에 `standalone: true` 변형(context: `{env, clock, options, args}`, brain·config 없음)과 위치 인자(`arguments: ['<harness>']`)를 더한다. hook·envelope·exit 규칙은 그대로.
- `apps/cli/src/commands/setup-run.ts`, `setup-connect.ts` (새), `commands/index.ts` -- 등록. connect는 `setupConnectCommand(connectors)` 팩토리로 테스트에서 가짜를 주입.
- `apps/cli/src/connectors/index.ts` (새) -- `export const connectors: readonly Connector[] = []`.
- `packages/core/src/ports/connector.ts` (새), `ports/index.ts`, `core/src/index.ts` -- 타입·`BRAIN_MARKER`. `second_brain`은 `export *`라 자동 노출.
- `packages/core/src/testing/contracts/connector.ts`, `fakes/connector.ts` (새) -- `parser.ts` 계약·가짜를 본보기로. 가짜는 메모리 대상(표식 붙은 항목 배열).
- `apps/cli/test/install-flow.test.ts` -- 가짜 deps 본보기(`fakeRunner`, `kept()` L48). `kept`에 mirrorPath 추가.
- `apps/cli/test/install.test.ts`, `admin-doctor.test.ts` L36-51 -- 임시 home·자식 프로세스 본보기.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/connector.ts` (+index, +testing contract·fake) -- Connector port, `BRAIN_MARKER`, 계약 사례
- [x] `apps/cli/src/config/codec.ts` (+`test/config.test.ts`) -- `mirror.path` 읽기·쓰기·검증
- [x] `apps/cli/src/install/shim.ts` (+test) -- 렌더·멱등 쓰기·0755
- [x] `apps/cli/src/install/flow.ts`, `install.ts` -- 미러·임베딩·shim·connect 단계, 플래그, 흐름/해석 분리
- [x] `apps/cli/src/dispatch.ts` (+`test/dispatch.test.ts`) -- standalone 명령과 위치 인자
- [x] `apps/cli/src/connectors/index.ts`, `commands/setup-run.ts`, `commands/setup-connect.ts`, `commands/index.ts` -- 등록부와 두 명령
- [x] `apps/cli/test/install-flow.test.ts` -- I/O 표의 흐름 행(미러·임베딩·connect 선택·비TTY `--connect`·등록부 빔)
- [x] `apps/cli/test/setup.test.ts` (새) -- 가짜 connector로 connect 두 번·모르는 이름·shim 없음; 실제 test DB로 `brain setup run --database-url … --yes` 두 번 → config·shim 바이트 동일; `<home>/bin/brain admin doctor --json` exit 0
- [x] `README.md` -- shim, 미러 경로, `setup run`·`setup connect`, 새 플래그

**Acceptance Criteria:**
- Given 빈 임시 home, when `brain setup run --database-url <test db> --yes`를 두 번 돌리면, then 두 번 다 exit 0이고 config.toml과 shim이 바이트 단위로 같다.
- Given 그 home, when `<home>/bin/brain admin doctor --json`을 셸 환경에 `SECOND_BRAIN_HOME` 없이 실행하면, then exit 0과 ok 봉투.
- Given compose PG, when `pnpm test`, then 기존·새 테스트 모두 통과.

## Implementation Notes

- `BRAIN_MARKER = 'second-brain'`. connector는 자기가 소유한 칸(이름·라벨·자기 줄의 주석)에 넣고, 자유 텍스트 검색으로 판정하지 않는다는 주석을 port에 달았다.
- `ConnectResult`의 `code`는 `string`으로 뒀다. 실제 harness 실패 코드는 epic 2가 정하므로 지금 union으로 닫으면 곧 넓혀야 한다.
- 모르는 `--connect <harness>`는 **설치기 흐름 맨 앞**(DB·config 전)에서 `USAGE` exit 2로 막는다. 등록 단계까지 가서 실패하면 DB는 이미 세팅된 뒤라 "설치가 된 건가"가 모호해진다.
- connector가 거절하면(`ok:false`) 다른 단계는 끝까지 돌고 exit 1. doctor 결과와 or로 묶는다.
- `dispatch.ts`의 `CommandSpec`은 `DatabaseCommandSpec | StandaloneCommandSpec` 판별 union이 됐다(`standalone?: false` vs `standalone: true`). outcome→envelope 변환은 `finish()`로 공유한다.
- `setup run`의 exit 2는 `ok:false`+`USAGE` 봉투다(`data`는 못 실린다). 메시지는 들여쓰기 없는 마지막 줄(= 이유를 말한 줄)을 고르는 `reason()`으로 뽑는다 — 마지막 줄은 보통 플래그 목록의 들여쓴 연속 줄이라 쓸모가 없었다.
- 텍스트 모드 `setup run`은 흐름 줄을 즉시 stdout으로 쓰고 `text: []`를 돌려준다. 디스패처가 끝에 모아 찍으면 질문보다 늦게 나온다.
- `writeShim`은 내용이 같으면 쓰지 않지만 `chmod 0755`는 항상 한다(바이트는 그대로, 실행 권한이 날아간 shim을 고친다).
- `cliEntryPath()`는 `new URL('../bin.js', import.meta.url)`이라 `src/`에서 import하면 `src/bin.js`를 가리킨다. 그래서 shim 실행 테스트는 `bin: dist/bin.js`를 명시로 넘기고, 빌드된 모듈의 `cliEntryPath()`가 실제로 존재하는지는 별도 사례로 확인한다.
- `install-flow.test.ts`의 `harness()`는 모든 경로가 끝에 묻는 두 질문(미러 Enter, 임베딩 아니오)의 답을 자동으로 덧붙인다(`TAIL`). 기존 사례 중 `asked.at(-1)`로 질문을 집던 것들은 `find`/`some`으로 바꿨다.
- `config.toml` 머리 주석을 "Variable names only"에서 "No keys here — key values live in .env."로 고쳤다. `mirror.path`·`timezone`은 변수 이름이 아닌 값이다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 0 / medium 3 / low 7 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `setup run`이 exit 1(doctor 실패·connector 거절)일 때 `warnings[]`에 코드가 없다 | low | 거절 | exit 1과 `failed`가 실패를 알리므로 조용한 실패는 아니다. connector 거절 코드는 경고 코드 목록에 들지도 않는다. 고치려면 흐름이 코드를 돌려주는 새 표면이 필요하고, `--json` 실패 재설정은 드물다 |
| 2 | `setup run`이 `--docker`와 `--database-url`의 모순 검사를 건너뛰어 URL을 조용히 고른다 | medium | patch | `setup-run.ts` `toFlags`가 `InstallFlags`를 직접 만들고, `runInstall`은 다시 검사하지 않는다. 리뷰어가 빌드된 CLI로 재현. 검사를 `runInstall`로 옮긴다 |
| 3 | 상대 `--mirror-path`의 exit 2가 `code: USAGE`, 메시지는 `CONFIG_INVALID: …`로 나간다 | low | patch | `reason()`이 마지막 줄을 메시지로 올리는 것을 확인. 코드 접두사를 읽기만 하면 되는 직접 수정 |
| 4 | `setup run`의 줄이 디스패처의 주입 writer를 거치지 않아, 텍스트 모드 exit 2에서 이유가 두 번 보인다 | low | 거절 | 겉모습만의 문제다. 고치려면 context에 writer를 더하는 새 표면이 필요하다 |
| 5 | connector 계약이 표식 없는 항목 보존을 검사하지 않고, detect 사례가 빈 대상을 요구한다 | medium | patch | 계약 파일에 그런 사례가 없음을 확인. epic 2의 실제 connector가 사용자 hook을 지우고도 계약을 통과할 수 있다. 시험용 표면(`addForeignEntry`)만 더한다 |
| 6 | `writeShim`이 없는 `<home>`을 0755로 만든다(codec은 0700) | low | patch | `mkdir(..., {recursive, mode:0o755})`를 확인. 지금 흐름은 config를 먼저 써서 괜찮지만, upgrade 순서에서는 shim이 먼저 온다. 직접 수정 |
| 7 | `SHIM_SIGNATURE`가 `BRAIN_MARKER`를 다른 리터럴로 한 번 더 적는다 | low | patch | 두 리터럴이 따로 바뀔 수 있다. 보간으로 바꾸는 직접 수정 |
| 8 | 명령 등록부가 설치기(clack, 최상단 `invokedDirectly`+await)를 hook 경로까지 매번 불러온다 | medium | patch | `setup-run.ts`가 `../install.js`를 정적으로 import하는 것을 확인(AD-3). 리뷰어 측정 약 +19ms. 동적 import로 바꾼다 |
| 9 | `--connect`를 두 진입점이 다르게 해석한다(commander 가변 인자, 중복 허용) | low | 거절 | 하류가 connector 기준으로 거르므로 중복은 무해하다. 문서의 반복 형식은 양쪽에서 동작한다. 고치려면 CommandOption에 파서를 더해야 한다 |
| 10 | README가 `--json`이면 `--yes`와 DB 플래그가 필수라는 점을 빠뜨렸다 | low | patch | 문서 한 줄을 고치는 직접 수정 |

경로 요약: intent_gap 0, bad_plan 0, patch 7(2·3·5·6·7·8·10), defer 0, 거절 3(1·4·9).

패치 7건 적용 후 재검증(2026-10-14): compose PG로 `pnpm test` 19개 파일·437개 통과. 임시 home에서 `brain setup run --database-url … --yes`를 두 번 실행해 둘 다 exit 0, `cmp`로 config.toml·shim이 같음을 확인. `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor` exit 0.

## Design Notes

- 설치기가 디스패처 밖에 있는 이유(config 전에 돌아야 함)가 `setup run`에도 그대로라 standalone 변형을 둔다. `setup connect`도 DB가 필요 없어 같은 변형.
- shim이 home을 담는 이유: hook은 사용자의 셸 환경 없이 불리므로, 임시·두 번째 설치의 home을 shim이 기억해야 한다. 환경에 값이 있으면 그것이 이긴다.
- shim 예:
  ```sh
  #!/bin/sh
  # Written by second-brain. `brain setup run` rewrites it.
  SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-'/Users/me/.second_brain'}; export SECOND_BRAIN_HOME
  exec '/opt/homebrew/bin/node' '/Users/me/.second_brain/app/apps/cli/dist/bin.js' "$@"
  ```

## Verification

**Commands:**
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm build && pnpm test` -- expected: 전부 통과
- 임시 `SECOND_BRAIN_HOME`으로 `node apps/cli/dist/bin.js setup run --database-url <test db> --yes` 두 번 후 `cmp`로 config.toml·shim 비교, `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor` -- expected: 동일, exit 0
