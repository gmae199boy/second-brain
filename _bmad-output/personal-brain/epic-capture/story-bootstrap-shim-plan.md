---
title: '플러그인 설치 경로: bootstrap·완료 기록·shim'
type: 'feature'
ticket: '5'
created: '2026-10-17'
status: 'built'
baseline_revision: 'b9b011c2f05a932345e249f11b724c428781bf3b'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Claude Code 사용자가 플러그인만 켜면 Brain이 설치·갱신되는 경로가 없다. bootstrap은 npx 대화형 경로뿐이다. 잠금도, ref 고정도, 완료 기록(`installed.json`)도, 빌드 신원도 없다. node 하한은 major만 보고, shim은 `process.execPath`를 그대로 박아 node가 사라지면 깨진다. doctor는 플러그인과 설치의 관계를 모른다(AD-19, 회고 F7·F9).

**Approach:** `plugin/`(매니페스트, async SessionStart hook 하나, node를 찾는 sh 런처, bootstrap 복사본, `app-ref`)과 루트 marketplace를 만든다. bootstrap에 hook 모드(`--ref`)를 더한다. hook 모드는 잠금을 잡고, 플러그인이 앞설 때만 ref로 ff → install(`--ignore-scripts`) → build → 설치기를 돌린다. 설치기는 끝 검증 뒤 `installed.json`을 쓴다. 빌드는 `dist/build.json`을 쓴다. shim은 node 실제 경로를 고정하고, 그 경로가 없으면 다른 node를 찾아 다시 고정한다. doctor에는 `plugin` 점검과 `UPDATE_AVAILABLE`을 더한다. 설정에는 `[update] auto`를 더한다.

## Boundaries & Constraints

**Always:**
- **플러그인 파일:**
  - `plugin/.claude-plugin/plugin.json`(`name: "second-brain"`, semver `version`, 한국어 `description`). description에는 첫 세션이 `~/.second_brain/app`에 clone·의존성 설치·빌드·설치를 자동으로 한다는 것과 필요 도구(git, pnpm 12+, node 24.16+)를 적는다.
  - `plugin/hooks/hooks.json`. SessionStart 하나뿐이다: `{"type":"command","command":"sh \"${CLAUDE_PLUGIN_ROOT}/bin/session-start.sh\" || exit 0","async":true}`이고 matcher는 없다.
  - `plugin/bin/session-start.sh`, `plugin/bootstrap.mjs`, `plugin/app-ref`(40자 소문자 hex 한 줄).
  - `package.json`과 lockfile은 두지 않는다.
  - 루트 `.claude-plugin/marketplace.json`은 `name: "second-brain"`, `owner.name: "gmae199boy"`, `plugins: [{name: "second-brain", source: "./plugin", description}]`이다.
- **런처 `session-start.sh`:** PATH에 기대지 않고 node를 찾는다.
  - 찾는 순서:
    1. home(`SECOND_BRAIN_HOME`, 없으면 `$HOME/.second_brain`)의 shim에 박힌 `NODE`
    2. nvm(`${NVM_DIR:-$HOME/.nvm}/versions/node/v*/bin/node` 중 하한 이상의 가장 높은 버전)
    3. `/opt/homebrew/bin/node`
    4. `/usr/local/bin/node`
  - 3·4의 고정 폴더 목록은 `SECOND_BRAIN_NODE_DIRS`(콜론 구분)로 바꿀 수 있다(시험용 seam).
  - 후보마다 그 node로 버전을 확인해 24.16.0 이상만 받는다.
  - 찾으면 `PATH="<그 node 폴더>:/opt/homebrew/bin:/usr/local/bin:$PATH"`로 export한다(pnpm·git을 찾게 한다). 그다음 `exec node "$ROOT/bootstrap.mjs" --yes --ref "$(app-ref)" --plugin-root "$ROOT"`를 한다. `ROOT`는 `CLAUDE_PLUGIN_ROOT`이고, 없으면 스크립트 폴더의 부모다.
  - 못 찾으면 아무것도 하지 않는다. stdout에 `{"systemMessage":"…"}` 한 줄(찾아본 위치와 하한, 한국어)을 내고 exit 0이다.
- **node 찾기의 정본은 하나다.** sh 함수 텍스트는 `apps/cli/src/install/shim.ts`의 상수 하나다. 런처는 같은 텍스트를 담고, 테스트가 둘이 같은지 대조한다.
- **bootstrap 공통:**
  - node 하한은 24.16.0(major·minor·patch)이다. `missingTools`의 문구에 이 하한을 적는다.
  - `pnpm install --frozen-lockfile --ignore-scripts`로 설치한다.
  - 설치 잠금은 `<home>/install.lock/`이다. 원자적 `mkdir`로 잡고, 안에 `pid` 파일(10진수 한 줄)을 둔다.
  - stale 판정: `pid`의 프로세스가 없거나(`kill(pid, 0)`이 ESRCH), 폴더 mtime이 30분을 넘었다. `pid` 파일이 없거나 읽을 수 없으면 mtime만 본다. stale이면 지우고 한 번만 다시 잡는다.
  - 잠금은 성공·실패·예외 모두에서 놓는다.
  - npx 모드(`--ref` 없음)는 지금 동작(clone 또는 `pull --ff-only`, TTY pnpm 질문)에 잠금·하한·`--ignore-scripts`만 더한다. 잠금이 잡혀 있으면 "다른 설치가 진행 중입니다" 줄을 내고 exit 0이다.
- **bootstrap hook 모드**(`--ref <sha>`, `--plugin-root <path>`). bootstrap은 `--ref`를 소비한다. 설치기에는 `--yes --plugin-root <path>`만 넘긴다. 진행 순서:
  1. `<home>/installed.json`을 읽는다. 있고 `commit`이 ref와 같으면 조용히 exit 0이다.
  2. 기록이 있고 `config.toml`의 `[update] auto`가 `false`이면 조용히 exit 0이다(가벼운 읽기: `[update]` 테이블 안의 `auto = false` 줄). 첫 설치(기록 없음)는 auto와 상관없이 한다.
  3. 잠금을 잡는다. 이미 잡혀 있으면 조용히 exit 0이다. 잡은 뒤 1을 다시 본다.
  4. 저장소를 준비한다.
     - 클론이 없으면: `git clone --no-checkout <repo> <app>` → `git -C <app> checkout --detach <ref>`.
     - 클론이 있으면: 지금의 toplevel·origin·clean 검사를 하고 `git -C <app> fetch origin`을 한다.
       - ref가 없으면 실패다.
       - 기록의 commit이 있고 ref가 그 조상이면(뒤처짐) 조용히 exit 0이다.
       - 기록의 commit이 있고 ref의 조상이 아니면(갈라짐) 조용히 exit 0이다.
       - 지금 HEAD가 ref의 조상이 아니면 실패다. 맞으면 `git -C <app> checkout --detach <ref>`를 한다.
  5. pnpm 확인(묻지 않음, 없거나 낡으면 실패) → install → build → `node <app>/apps/cli/dist/install.js --yes --plugin-root <path>`.
  6. 설치기 exit 0 뒤에 `installed.json.commit`이 ref와 같은지 확인한다.
- **hook 모드의 출력:** stdout에는 최대 한 줄, `{"systemMessage":"…"}`만 낸다.
  - 성공: "Brain을 <짧은 sha>로 설치했습니다".
  - 실패: 실패한 단계와 로그 경로를 적고, exit 1이다.
  - 조용한 경우에는 stdout이 비어 있다.
  - 진행 줄과 자식 프로세스의 stdout·stderr는 `<home>/log/bootstrap.log`(append, 시각 머리줄)로 간다.
- **빌드 신원:** `apps/cli`의 build가 tsc 뒤에 `dist/build.json` `{commit, schema_version}`을 쓴다.
  - `commit`은 `git rev-parse HEAD`(40자)이고, git이 없거나 실패하면 `null`이다.
  - `schema_version`은 sqlite 패키지의 `SQLITE_SCHEMA_VERSION`이다.
- **완료 기록:** 설치 흐름(`runInstall`)이 doctor 통과 뒤에 완료를 검증한다. `<home>/bin/brain guide schema --json`이 exit 0이고 그 stdout이 `ok:true` 엔벨로프여야 한다. 그다음 `<home>/installed.json` `{commit, schema_version, installed_at, node, plugin_root}`를 temp+rename으로 쓴다.
  - `commit`·`schema_version`은 `build.json`에서 온다. `node`는 shim에 고정한 node 경로다.
  - `plugin_root`는 `--plugin-root`, 없으면 이전 기록의 값, 그것도 없으면 `null`이다.
  - 검증이 실패하면 `SETUP_INCOMPLETE`(exit 1)이고 기록을 쓰지 않는다. `setup run`과 npx 모두 이 흐름을 지난다.
  - 결과 보고에 `installed{path, commit}`을 더한다.
- **shim:**
  - `realpath(process.execPath)`를 `NODE='…'` 줄로 고정한다.
  - 그 경로가 실행 가능하지 않으면 같은 sh 찾기 함수(nvm → Homebrew → `/usr/local/bin`)로 찾는다.
  - 찾으면 잠금을 잡을 수 있을 때만 `NODE` 줄을 바꾼 새 shim을 temp+rename으로 쓴다(다시 고정). 못 잡아도 찾은 node로 실행한다.
  - 못 찾으면 stderr에 한국어 한 줄을 내고 exit 127이다.
  - `parseShim`과 doctor는 새 모양을 읽는다.
- **doctor:**
  - shim에 박힌 home과 지금 home이 다르면 `fail`이 아니라 `warn`이다(코드 없음, 두 경로를 적음, F9). 이 경우 뒤 점검은 계속한다.
  - 새 `plugin` 점검은 `installed.json`, 기록의 `plugin_root/app-ref`, `build.json`을 읽고, 순서대로 판정한다:
    1. 기록 없음 → `ok`("완료 기록이 아직 없습니다").
    2. `plugin_root`가 null → `ok`.
    3. app-ref를 못 읽음 → `warn`(코드 없음).
    4. 빌드 commit이 기록 commit과 다름 → `warn`(코드 없음).
    5. 같음 → `ok`.
    6. app-ref가 기록 commit의 조상 → `warn` `PLUGIN_BEHIND`.
    7. 기록 commit이 app-ref의 조상이고 `[update] auto`가 true → `ok`("다음 세션에서 갱신합니다").
    8. 기록 commit이 app-ref의 조상이고 `[update] auto`가 false → `warn` `UPDATE_AVAILABLE`. detail은 `[update] auto = true`로 켜라는 안내다.
    9. 관계를 알 수 없음(ref가 클론에 없음 등) → `warn`(코드 없음).
  - 조상 판정은 앱 루트(`dist`의 부모의 부모)에서 `git merge-base --is-ancestor`로 한다. 테스트용 실행 seam을 둔다.
- **설정:** `[update] auto`(boolean, 기본 true)를 코덱의 `readConfig`(틀리면 `CONFIG_INVALID`), `readConfigForSetup`(틀리면 `CONFIG_VALUE_RESET`), `writeConfig`에 더한다.
  - 설치기는 TTY에서 임베딩 질문 뒤에 "자동 업데이트를 켤까요?"를 묻는다(기본값은 기록된 값, 없으면 예). 비대화형은 기록된 값, 없으면 true다.
  - 보고에 `update{auto}`를 더한다.
- **Core 코드:** `UPDATE_AVAILABLE` 경고와 한국어 의미를 Core 코드와 README 경고 표에 더한다.
- **문장:** 모든 새 사람용 문장(systemMessage, 로그 줄, doctor detail, 질문, README)은 한국어이고 출력 언어 검사를 통과한다.
- **Decision(2026-10-17, 사용자 위임으로 에이전트가 고름):** 복사본 이름은 `bootstrap.mjs`다 — 플러그인 캐시에는 `"type":"module"`인 package.json이 없어서 `.js`이면 ESM 판정이 node의 구문 감지에 기댄다. 다른 안: `bootstrap.js` + 구문 감지.
- **Decision(같은 근거):** ref로 ff하는 방법은 "HEAD가 ref의 조상인지 확인한 뒤 `checkout --detach <ref>`"이고, 새 클론은 `--no-checkout`이다 — `merge --ff-only <ref>`는 HEAD가 ref보다 앞서 있을 때 아무 일도 하지 않고 성공한다. 다른 안: 브랜치를 유지하는 `merge --ff-only`.
- **Decision(같은 근거):** 잠금이 잡혀 있을 때, 뒤처졌을 때, 갈라졌을 때, auto가 false일 때 hook 모드는 아무것도 출력하지 않는다. 알림은 doctor가 맡는다 — 비동기 hook 출력은 매 세션 모델 맥락으로 간다. 다른 안: 각각 systemMessage를 낸다.
- **Decision(같은 근거):** 잠금 시작 시각은 `install.lock` 폴더의 mtime이고, 소유자는 `pid` 파일 하나다 — sh shim도 같은 잠금을 쓴다. 다른 안: JSON 소유자 파일.
- **Decision(같은 근거):** bootstrap은 의존성이 없어서 `[update] auto`를 줄 단위로 가볍게 읽는다. 코덱과 다르게 읽을 수 있는 TOML(인라인 테이블 등)은 "켜짐"(기본값)으로 본다. 다른 안: 설치된 CLI를 불러 읽기.
- **Decision(같은 근거):** `installed.json.node`는 고정한 node 경로(문자열)다. 다른 안: 버전 문자열이나 `{path, version}` 객체.
- **Decision(같은 근거):** `plugin.json` `version`은 `0.1.0`에서 시작한다. app-ref를 올릴 때 version도 올린다는 규칙은 README 릴리스 절에 적는다. 테스트는 형식만 본다. 다른 안: 버전에 sha를 넣거나 git 이력 테스트.
- **Decision(같은 근거):** `app-ref`는 이 스토리 커밋 바로 뒤의 별도 커밋이 이 스토리 커밋의 sha로 올린다. 구현 중에는 baseline sha를 둔다 — 커밋은 자기 sha를 담을 수 없다.

**Never:**
- Stop·SessionEnd 수집 hook, SessionStart 동기 `context show`, `plugin/skills/`(2.14, epic 3).
- `setup connect claude-code`의 변경, 옛 hook 제거, `PLUGIN_NOT_INSTALLED`·`PLUGIN_DUPLICATE` 판정(2.14).
- `setup upgrade`, 데몬, LaunchAgent, volta·fnm·asdf·mise 찾기, `setup run`의 잠금.
- 사용자의 실제 `~/.claude`·`~/.second_brain`을 건드리는 시험. hook 모드에서 TTY 질문. 플러그인 캐시나 `CLAUDE_PLUGIN_DATA` 안에서 빌드하기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 세션 | 기록·클론 없음, `--ref R` | clone(no-checkout) → R detach → install(--ignore-scripts) → build → 설치기 → `installed.json.commit=R`, stdout은 systemMessage 한 줄 | exit 0 |
| 같은 ref | 기록 commit = R | git·pnpm 호출이 없고 stdout이 비어 있음 | exit 0 |
| 동시 두 세션 | 한쪽이 잠금을 잡음 | 다른 쪽은 아무것도 하지 않고 stdout이 비어 있음, 설치는 한 번 | exit 0 |
| stale 잠금 | `pid`의 프로세스가 죽음 / mtime 31분 | 잠금을 회수하고 진행 | exit 0 |
| 플러그인 앞섬 | 기록 C, C가 R의 조상, auto true | fetch → R detach → install·build·설치기 한 번 | exit 0 |
| auto false | 기록 C가 R의 조상, `[update] auto=false` | 아무것도 하지 않음; doctor `warn UPDATE_AVAILABLE` | exit 0 |
| 뒤처짐 | R이 C의 조상 | 아무것도 하지 않음; doctor `warn PLUGIN_BEHIND` | exit 0 |
| 클론 HEAD가 앞섬·더러움 | HEAD가 R의 조상이 아님 / 변경 있음 | 건드리지 않음, 실패 systemMessage 한 줄 | exit 1(hook은 `\|\| exit 0`) |
| 단계 실패 | pnpm 없음·build 실패·설치기 실패 | 실패 systemMessage 한 줄(단계, 로그 경로), 잠금 해제 | exit 1 |
| node 없음 | 런처가 하한 이상의 node를 못 찾음 | stdout `{"systemMessage":…}` 한 줄(찾은 위치, 24.16.0), 아무것도 하지 않음 | exit 0 |
| 낮은 node | bootstrap을 24.15로 실행 | 하한 문구 | exit 1 |
| 완료 검증 실패 | `guide schema --json`이 exit ≠ 0 | `installed.json`을 쓰지 않음 | `SETUP_INCOMPLETE`, exit 1 |
| shim node 사라짐 | 고정 경로가 없음, nvm에 24.16 있음 | 그 node로 실행하고 shim을 다시 고정 | 성공 exit |
| shim home 다름 | `SECOND_BRAIN_HOME`이 shim의 home과 다름 | doctor `warn`(두 경로) | exit 0 |
| 설정 auto 틀림 | `[update] auto = "yes"` | `readConfig` → `CONFIG_INVALID`; setup → `CONFIG_VALUE_RESET`, true | 각 규칙 |

</intent-contract>

## Code Map

- `tooling/bootstrap/src/bootstrap.ts` -- `main`(104), `missingTools`(147, major만 봄 → 24.16.0 비교), `prepareApp`(167), `ensurePnpm`(220), install 호출(122-126, `--ignore-scripts` 없음), 설치기 호출(134-140, argv 그대로 넘김 → `--ref` 소비). `BootstrapDeps`(69)에 잠금·파일 읽기/쓰기·로그 파일·시각·pid 생존 seam을 더한다. `systemDeps`(332), `runCommand`(353)는 hook 모드에서 자식 출력을 로그 파일로 보내야 한다(capture 아닌 실행도). 상수 `HOME_ENV`·`DEFAULT_HOME_FOLDER`는 `paths.ts`와 테스트로 묶여 있다. `INSTALLED_FILE`·`LOCK_FOLDER` 상수도 같은 방식으로 apps/cli와 묶는다. 의존성 없음 규칙(`node:`만 import)은 그대로다.
- `tooling/bootstrap/package.json` -- build 끝에 `cp bin/second-brain.js ../../plugin/bootstrap.mjs`를 붙인다. `bin/second-brain.js`는 커밋된 산출물이고 테스트가 소스 빌드와 같은지 본다.
- `tooling/bootstrap/test/bootstrap.test.ts` -- `harness`(70-102), `respondWith`(110), `INSTALLER`(124). "the committed entry point"(499-543), "the configuration folder rule"(608-617)이 대조 테스트의 본보기다. `npx.test.ts`는 작업 트리를 임시 bare 저장소로 찍어 실제로 도는 느린 테스트(SLOW 900s)의 본보기다.
- `apps/cli/src/install/shim.ts` -- `renderShim`(64-72), `parseShim`(95, 정확한 역함수), `writeShim`(157-186, `input.node ?? process.execPath` → realpath, temp+rename), `quote`(189). 새 상수: sh node 찾기 함수 텍스트(하한 24.16.0, `SECOND_BRAIN_NODE_DIRS` seam). 런처와 같은 텍스트를 쓴다. `apps/cli/test/shim.test.ts`.
- `apps/cli/src/doctor/checks.ts` -- `NODE_FLOOR`(15), `runtimeChecks`(71-84, 여기에 `{id:'plugin'}` 추가), `inspectShim`(127-168, home이 다를 때 157의 fail → warn), `RunNode` seam(31) 본보기. 경고 코드는 `check.code`가 `WARNING_CODES`에 있으면 `doctor-run.ts:56-58`이 엔벨로프 `warnings`로 올린다. 호출부는 `dispatch.ts:471`, `install/store.ts:249-254`다.
- `packages/core/src/doctor/doctor.ts` -- `DoctorCheck{id,status,detail?,code?}`(16-27). 바꾸지 않는다.
- `apps/cli/src/config/codec.ts` -- `KNOWN_KEYS`(29-35)에 `update.auto`를 더한다. `BrainConfig`(73-84), `readConfig`(119-212), `SetupConfig`(261-274), `readConfigForSetup`(305-388, `reset` 399), `WriteConfigInput`(452-466), `writeConfig`의 문서 조립(526-537). boolean 판별은 `kindOf`(720)에 이미 있다.
- `apps/cli/src/config/paths.ts` -- `configHome`(25). 새 경로 함수(`installedPath`, `lockPath`, `logPath`)는 여기나 새 모듈에 둔다.
- `apps/cli/src/install/flow.ts` -- `InstallReport`(57-77), `InstallDeps`(224-235, `verify`·`installed` 의존성 추가), `runInstall` 순서(284-484). `askAboutEmbeddings`(357, 정의 680-691) 뒤에 자동 업데이트 질문을, doctor 통과(459-466) 뒤 return 전에 검증과 `installed.json`을 넣는다. `settings()`(558-572)에 `updateAuto`를 넣고, `parseFlags`(818)·`usage`(870)·`givenArgs`(499)에 `--plugin-root <절대경로>`를 넣는다.
- `apps/cli/src/install.ts` -- `systemInstallDeps`(140-169)에 실제 검증(shim 경로로 `guide schema --json` 실행)과 `installed.json` 쓰기를 연결한다.
- 새 `apps/cli/src/install/installed.ts` -- `readInstalled(home)`, `writeInstalled(home, record)`(temp+rename, 0644), `readBuildIdentity()`(`dist/build.json`, 없거나 틀리면 `undefined`). doctor와 흐름이 함께 쓴다. 이 기록들은 설정 코덱을 지나지 않는다(AD-18).
- 새 `apps/cli/scripts/write-build-info.mjs` + `apps/cli/package.json` build -- `tsc -p tsconfig.json && node scripts/write-build-info.mjs`. schema 버전은 이미 빌드된 sqlite 패키지에서 import한다(`pnpm -r`는 위상 순서로 빌드).
- `packages/core/src/codes.ts` -- `WARNING_CODES`(22-65)의 `PLUGIN_DUPLICATE`(63) 뒤에 `UPDATE_AVAILABLE`을, `WARNING_CODE_MEANINGS`(78-96)에 그 의미를 더한다. README `### 경고 코드`(~287, PLUGIN 행 308-310)와 `apps/cli/test/readme-codes.test.ts`가 양방향으로 대조한다.
- 출력 언어: `apps/cli/test/language.ts`(`assertKoreanLine`), `packages/core/src/testing/language.js`(`assertKoreanProse`, bootstrap 테스트 `log` 가짜가 씀), `apps/cli/test/output-language.test.ts`.
- vitest는 `packages/`·`apps/`·`tooling/` 아래의 `test/`만 줍는다. 플러그인 파일 테스트(매니페스트, hooks, app-ref, 복사본 동등, 런처)는 `tooling/bootstrap/test/plugin.test.ts`에 둔다.
- 아키텍처 근거: spine AD-18(282-288), AD-19(290-302), AD-20(304-313), Conventions 설치·런타임 기록(478)이다. 플러그인 규칙 실측은 `epic-capture-research.md` §1-3에 있다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/codes.ts`, `README.md` 경고 표 -- `UPDATE_AVAILABLE`을 더한다.
- [x] `apps/cli/src/config/codec.ts` -- `[update] auto`의 읽기 두 가지와 쓰기를 더한다. 테스트는 `config.test.ts`에 둔다.
- [x] `apps/cli/scripts/write-build-info.mjs`, `apps/cli/package.json` -- `dist/build.json`을 쓴다.
- [x] `apps/cli/src/install/installed.ts` -- 완료 기록과 빌드 신원 읽기·쓰기를 만든다.
- [x] `apps/cli/src/install/shim.ts` -- realpath 고정, 새 템플릿(`NODE=` 줄 + 찾기 함수 + 잠금 안 재고정), `parseShim`, 공유 찾기 함수 상수를 만든다. 테스트에서 실제 sh로 "고정 경로가 사라짐 → 다시 고정"을 확인한다(임시 home, `SECOND_BRAIN_NODE_DIRS`·`NVM_DIR` seam).
- [x] `apps/cli/src/install/flow.ts`, `apps/cli/src/install.ts` -- 자동 업데이트 질문, `--plugin-root`, 완료 검증, `installed.json`, 보고의 `update`·`installed`를 넣는다. 테스트는 `install-flow.test.ts`·`setup.test.ts`에 둔다.
- [x] `apps/cli/src/doctor/checks.ts` -- home이 다를 때 `warn`으로 바꾸고 `plugin` 점검을 더한다. 테스트는 `doctor-checks.test.ts`에 두고, 판정 표의 각 경로와 `UPDATE_AVAILABLE`·`PLUGIN_BEHIND`가 엔벨로프 `warnings`에 오는지 본다.
- [x] `tooling/bootstrap/src/bootstrap.ts` + 다시 빌드한 `bin/second-brain.js` + `package.json` -- 하한, `--ignore-scripts`, 잠금, hook 모드, 로그 파일, systemMessage를 넣는다. `bootstrap.test.ts`에 매트릭스의 bootstrap 행을 넣는다(가짜 deps). 잠금 행은 실제 파일 시스템으로 확인한다. 실제 git과 임시 bare 저장소로 도는 느린 hook 모드 테스트도 하나 둔다: 첫 실행 → `installed.json`과 stdout 한 줄, 둘째 실행 → 조용함.
- [x] `plugin/` 전부, `.claude-plugin/marketplace.json` -- 위 규칙대로 만든다. `tooling/bootstrap/test/plugin.test.ts`가 볼 것:
  - 매니페스트·marketplace 모양과 `source: "./plugin"`
  - hooks.json이 async SessionStart 하나뿐임
  - app-ref 형식, 플러그인 폴더에 package.json·lockfile 없음
  - `bootstrap.mjs`와 `bin/second-brain.js`의 바이트 동등
  - 런처의 찾기 함수가 shim 상수와 같음
  - 런처가 node를 못 찾을 때 stdout이 JSON 한 줄이고 exit 0임(`SECOND_BRAIN_NODE_DIRS`를 빈 폴더로, `NVM_DIR`·`HOME`을 임시로)
- [x] `README.md` -- 플러그인 설치(로컬 marketplace, 첫 세션 자동 설치, 로그 위치), `[update] auto`, `installed.json`·`build.json`, 릴리스 규칙(app-ref와 version을 함께 올림)을 적는다.
- [ ] `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 스토리 커밋 뒤의 별도 커밋에서 스토리 커밋 sha로 올린다(오케스트레이터가 커밋 단계에서 한다).

**Acceptance Criteria:**
- Given 임시 home과 작업 트리 스냅샷 bare 저장소, when `SECOND_BRAIN_REPO`를 주고 `sh plugin/bin/session-start.sh`를 두 번 돌림(`CLAUDE_PLUGIN_ROOT`는 app-ref를 스냅샷 commit으로 둔 플러그인 사본), then 첫 실행 뒤 `installed.json.commit`이 그 sha이고 stdout이 JSON 한 줄이며, 둘째 실행은 stdout이 비고 git·pnpm 흔적(로그 줄)이 없다.
- Given 설치된 home, when `brain doctor run --json`, then `plugin` 점검이 있고 기록·app-ref·빌드 신원의 관계를 detail로 보인다.
- Given `pnpm test`, when 실행, then 모두 통과하고 출력 언어 검사가 새 문장을 잡지 않는다.

## Implementation Notes

구현 중에 플랜과 달라진 것, 또는 플랜이 비워 둔 자리를 메운 것만 적는다.

- **node 하한 상수의 자리.** `NODE_FLOOR`는 `apps/cli/src/doctor/checks.ts`에
  있었는데, `install/shim.ts`가 sh 텍스트를 만들 때 그 값을 쓰면서 순환
  import이 된다(checks가 shim을 import한다). 새 모듈
  `apps/cli/src/runtime/node-floor.ts`로 옮기고 `checks.ts`가 다시 export한다
  (`NODE_FLOOR`·`atLeast`·`meetsNodeFloor`). 기존 import 경로는 그대로 돈다.
- **shim의 `BIN`도 변수로 뺐다.** 플랜은 `NODE=` 줄만 말하지만, `exec`에 한
  경로만 리터럴로 남으면 `parseShim`이 두 가지 모양을 읽어야 한다. 그래서
  `NODE='…'`·`BIN='…'` 두 줄 + `exec "$NODE" "$BIN" "$@"` 한 줄이고, 마지막
  줄은 글자까지 고정이다.
- **shim 재고정에 `awk`를 쓴다.** `sed`는 치환 문자열에 경로가 들어가 구분자
  문제가 생긴다. `awk`는 교체할 줄을 환경 변수로 받으므로 경로의 어떤 글자도
  패턴으로 읽히지 않는다. 작은따옴표가 든 node 경로는 재고정하지 않고 그 node로
  실행만 한다(다음 hook이 다시 찾는다).
- **조상 판정의 작업 폴더.** 플랜은 "`dist`의 부모의 부모"라고 썼는데 그러면
  `apps/`다. `installed.ts`의 `appRootPath()`는 네 단계 위, 즉 클론 루트를
  가리킨다. git은 위로 올라가며 저장소를 찾으므로 둘 다 동작하지만, 클론 루트가
  의도에 맞다.
- **런처의 app-ref 거부에 한 줄을 낸다.** 플랜은 런처의 출력으로 "node를 못
  찾음"만 규정했다. `app-ref`가 40자 hex가 아니면 플러그인 자체가 깨진 것이고
  매 세션 조용히 아무것도 하지 않는 것은 NFR-2(조용한 실패 없음)에 어긋나므로,
  같은 모양의 `{"systemMessage":…}` 한 줄을 내고 exit 0한다.
- **로그 파일을 열 수 없을 때는 stderr로 간다.** stdout으로 떨어뜨리면 hook
  모드의 "stdout 최대 한 줄" 계약이 깨진다. hook이 exit 0이면 하네스가 stderr를
  버리므로 모델 맥락에도 가지 않는다.
- **`build.json`이 없으면 기록의 `schema_version`은 이 실행이 측정한 값이다.**
  플랜은 둘 다 `build.json`에서 온다고만 했다. `commit`은 `null`이 된다.
- **npx 경로가 잠금을 잡기 전에 `<home>`을 mode 0700으로 만든다.** 코덱·shim과
  같은 mode다. 기본 mode로 만들면 `.env`가 사는 폴더가 0755로 남는다.

## Verification Results

- `pnpm test` -- 통과(41개 파일, 1194개 테스트). Postgres 컨테이너와 느린
  bootstrap·hook 테스트 포함.
- 느린 hook 테스트(`tooling/bootstrap/test/hook.test.ts`)가 수락 기준 1을 그대로
  확인한다: 작업 트리 스냅샷 bare 저장소 + 임시 home + app-ref를 스냅샷 sha로
  둔 플러그인 사본으로 `sh plugin/bin/session-start.sh`를 두 번 돌려서, 첫
  실행은 `installed.json.commit`이 그 sha이고 stdout이 JSON 한 줄, 둘째 실행은
  stdout이 비고 로그가 한 줄도 늘지 않는다.
- 손으로도 같은 경로를 돌려 `plugin` 점검의 판정 표를 실측했다: 같음 → `ok`,
  `[update] auto=false` + 앞선 app-ref → `warn UPDATE_AVAILABLE`(엔벨로프
  `warnings`에 올라옴), 뒤처진 app-ref → `warn PLUGIN_BEHIND`, auto를 다시 켜면
  다음 실행에서 새 commit으로 설치.
- shim의 "고정 경로가 사라짐 → 다른 node로 실행하고 다시 고정"을 실제 `sh`로
  확인했다(`apps/cli/test/shim.test.ts`).

## Deferred to the commit step

- `plugin/app-ref`와 `plugin/.claude-plugin/plugin.json`의 `version`은 지금
  baseline sha(`b9b011c…`)와 `0.1.0`이다. 플랜대로 스토리 커밋 **뒤**의 별도
  커밋에서 스토리 커밋 sha로 올려야 한다(오케스트레이터).

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass
- verdicts: 6 findings — high 1, medium 2, low 3, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` `bootstrap.ts` `runCommand` — 자식의 stdin이 모두 `'ignore'`라 npx 모드 설치기가 TTY를 못 본다. 그래서 `--yes` 없는 대화형 npx가 질문 대신 exit 3을 낸다 — 확인함(`stdio: ['ignore', …]`, `install.ts`의 `isTTY`는 stdin을 본다). 고침: npx 모드(로그 파일 없음)에서는 stdin을 inherit한다.
  - `[medium]` `[patch]` `bootstrap.ts` `prepareApp` — 플러그인 설치 뒤 클론이 detached HEAD라 npx의 `pull --ff-only`가 실패하고, 로그가 갈라진 이력 탓을 한다 — 확인함(hook 모드의 `checkout --detach`). 고침: HEAD가 detached면 플러그인이 관리하는 클론이라는 정확한 문구로 거절한다(exit 1).
  - `[low]` `[reject]` `bootstrap.ts` `takeLock` — 잠금 폴더를 만들지 못한 모든 실패(home이 파일, 권한 없음)가 "다른 설치가 진행 중"으로 보고된다 — 실제 동작이다. 하지만 home이 파일이거나 쓸 수 없는 경우는 일상에서 드물고, 고치려면 `makeFolder`의 결과를 세 갈래로 나누는 분기가 필요하다.
  - `[medium]` `[patch]` `bootstrap.ts` `staleLock` — pid 파일이 있으면 30분 규칙이 적용되지 않는다. 플랜은 "pid 죽음 또는 mtime 30분"이다. 재활용된 살아 있는 pid면 잠금이 영구가 되어 hook이 매 세션 조용히 멈춘다 — 확인함. 고침: pid가 죽었으면 stale로 보고, 아니면 mtime 검사로 넘어간다. 테스트를 더했다.
  - `[low]` `[patch]` `checks.ts:15` — `InstalledRecord` import을 쓰지 않는다 — 확인함. 고침: import을 지웠다.
  - `[low]` `[patch]` `installed.ts` `verifyCompletion` 주석 — `PATH`만 넘긴다고 적었지만 `HOME`도 넘긴다 — 확인함. 고침: 주석을 바로잡았다.

## Design Notes

- hook 모드의 빠른 경로(1·2단계)는 git·pnpm을 부르지 않는다. 매 세션 비용은 JSON 하나와 TOML 줄 몇 개 읽기다.
- 갈라짐·뒤처짐을 잠금 안에서 fetch 뒤에 판정하는 이유가 있다. 기록이 앞서 있어도 플러그인 ref가 클론에 없을 수 있다.
- 설치기를 다시 도는 것이 곧 업그레이드다(AD-20: 마이그레이션 → shim → doctor → 완료 기록). 2.4가 설정 보존을 보장한다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest가 모두 통과한다(Postgres 컨테이너, 느린 bootstrap 테스트 포함).
- `git diff --exit-code tooling/bootstrap/bin plugin/bootstrap.mjs` (빌드 뒤) -- expected: 차이 없음.
- `node -e "JSON.parse(require('fs').readFileSync('plugin/hooks/hooks.json','utf8'))"` -- expected: 오류 없음.

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에서 `node apps/cli/dist/bin.js doctor run`을 돌린다. `plugin` 줄이 있고, auto false + 앞선 app-ref면 `UPDATE_AVAILABLE`이 나와야 한다.

## Auto Run Result

- **요약:** Claude Code 플러그인(`plugin/`)과 루트 marketplace를 만들었다. async SessionStart hook 하나가 PATH에 기대지 않는 sh 런처를 거쳐 bootstrap 복사본을 hook 모드(`--ref`)로 부른다. bootstrap hook 모드의 동작:
  - 설치 잠금(`install.lock/`, pid 죽음 또는 30분 경과면 회수)을 잡는다.
  - 플러그인이 앞설 때만 움직인다. `[update] auto`가 꺼져 있으면 첫 설치만 한다.
  - ref로만 이동한다(`checkout --detach`, HEAD가 ref의 조상일 때만).
  - `pnpm install --frozen-lockfile --ignore-scripts` → build → 설치기를 돌린다.
  - stdout에는 `systemMessage` 한 줄만 내고, 진행 줄은 `<home>/log/bootstrap.log`로 보낸다.

  설치 흐름은 doctor 뒤에 shim으로 `guide schema --json`을 검증하고 `installed.json`을 temp+rename으로 쓴다. 빌드는 `dist/build.json`을 쓴다. shim은 node 실제 경로를 고정하고, 그 경로가 없으면 nvm → Homebrew → `/usr/local/bin`에서 찾아 잠금 안에서 다시 고정한다. doctor에는 `plugin` 점검(`PLUGIN_BEHIND`·`UPDATE_AVAILABLE`)을 더했고, shim home이 다를 때는 `warn`이다. 설정에 `[update] auto`(기본 true, TTY에서 질문)를 더했고, node 하한은 24.16.0 전체 비교다.
- **바뀐 파일:**
  - `plugin/`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `bin/session-start.sh`, `bootstrap.mjs`, `app-ref`
  - `.claude-plugin/marketplace.json`: 루트 marketplace
  - `tooling/bootstrap/src/bootstrap.ts` + `bin/second-brain.js` + `package.json`: hook 모드, 잠금, 하한, `--ignore-scripts`, 복사본 cp
  - `apps/cli/src/install/shim.ts`: realpath 고정, 공유 찾기 함수, 재고정
  - `apps/cli/src/install/installed.ts`(새): 완료 기록, 빌드 신원, 완료 검증
  - `apps/cli/scripts/write-build-info.mjs`(새), `apps/cli/package.json`: `dist/build.json`
  - `apps/cli/src/runtime/node-floor.ts`(새): node 하한(순환 import을 피해 옮김)
  - `apps/cli/src/install/flow.ts`, `install.ts`, `commands/setup-run.ts`: 자동 업데이트 질문, `--plugin-root`, 완료 기록, 보고의 `update`·`installed`
  - `apps/cli/src/doctor/checks.ts`: `plugin` 점검, home 불일치를 warn으로
  - `apps/cli/src/config/codec.ts`, `paths.ts`: `[update] auto`, 기록·잠금·로그 경로
  - `packages/core/src/codes.ts`: `UPDATE_AVAILABLE`
  - `README.md`: 플러그인 설치, 자동 업데이트, 기록 파일, 릴리스 규칙, 새 코드
  - 테스트: `tooling/bootstrap/test/{plugin,hook}.test.ts`(새), bootstrap·shim·doctor·config·install·setup·codes 테스트 갱신
- **review:** quick 1회, 6건(high 1, medium 2, low 3).
  - 패치 5건:
    - npx 모드 설치기의 stdin 끊김(high)
    - detached 클론에서 npx 갱신 오진(medium)
    - 잠금 stale 판정의 OR(medium)
    - 안 쓰는 import(low)
    - 틀린 주석(low)
  - 연기 0건.
  - 기각 1건: 잠금 폴더 생성 실패가 "진행 중"으로 보고되는 것(low). home이 파일이거나 쓸 수 없는 드문 경우에만 나고, 고치려면 결과를 세 갈래로 나누는 분기가 필요하다.
- **follow-up review 권장:** true. high 1건을 패치했다(패치 수: high 1, medium 2, low 2). 남은 확인 안 된 위험은 실제 터미널에서 대화형 `npx`가 다시 질문을 묻는지다. `childStdio` 단위 테스트만 있고, `npx.test.ts`는 TTY가 없는 환경에서 돈다.
- **검증:**
  - `pnpm test`: 41개 파일, 1200개 테스트 통과(build·typecheck, Postgres 컨테이너, 실제 git·빌드로 hook 모드를 두 번 도는 `hook.test.ts`, `npx.test.ts` 포함).
  - `cmp bin/second-brain.js plugin/bootstrap.mjs`: 같음.
  - `hooks.json` JSON 파싱: 통과.
  - 구현 서브에이전트가 임시 home에서 첫 설치·같은 ref·auto false·뒤처진 ref·shim 재고정을 실제로 돌려 봤다.
- **에이전트가 대신 내린 결정**(모두 플랜 frozen 블록에 Decision으로 기록):
  1. 복사본 이름은 `bootstrap.mjs`다(플러그인 캐시에 `type: module`이 없어서).
  2. ref 이동은 "HEAD가 ref의 조상인지 확인 → `checkout --detach`"이고, 새 클론은 `--no-checkout`이다.
  3. 잠금이 잡혀 있을 때, 뒤처졌을 때, 갈라졌을 때, auto가 꺼져 있을 때 hook은 아무것도 출력하지 않고 doctor가 알린다.
  4. 잠금 소유자는 `pid` 파일이고 시작 시각은 폴더 mtime이다(sh shim과 같이 쓰려고).
  5. bootstrap은 `[update] auto`를 줄 단위로 읽고, 모호하면 켜짐으로 본다.
  6. `installed.json.node`는 고정한 node 경로 문자열이다.
  7. `plugin.json` version은 0.1.0에서 시작한다. app-ref와 함께 올린다는 규칙은 README에 두고, 테스트는 형식만 본다.
  8. `app-ref`는 스토리 커밋 바로 뒤의 별도 커밋이 스토리 커밋 sha로 올린다.
  9. (구현 중) 런처가 `app-ref`를 못 읽으면 systemMessage 한 줄을 낸다(깨진 패키징이 매 세션 조용히 실패하지 않게).
  10. (리뷰) 플러그인이 detached로 둔 클론을 npx가 만나면 거절하고 플러그인으로 갱신하라고 안내한다.
- **사람 확인 필요:**
  1. 로컬 marketplace(`claude plugin marketplace add <repo>` → 플러그인 설치)로 실제 Claude Code에서 새 세션을 열고, 설치가 한 번 돌아 `installed.json`이 생기는지 본다. hook은 기본으로 GitHub 원격을 clone하므로, push 전에는 `SECOND_BRAIN_REPO`를 로컬 경로로 주고 Claude Code를 띄운다.
  2. 두 세션을 동시에 열어 bootstrap이 한 번만 도는지 본다.
  3. `app-ref`를 올린 뒤 다음 세션에서 ff+build가 한 번 도는지 본다. 뒤처진 app-ref에서는 doctor `PLUGIN_BEHIND`가 나오는지 본다.
  4. 하한 이상의 node가 없는 환경(GUI 실행 등)에서 `systemMessage` 한 줄이 남는지 본다.
  5. `[update] auto = false`에서 app-ref를 올리면 갱신하지 않고 doctor가 `UPDATE_AVAILABLE`을 내는지 본다.
  6. 비동기 hook의 `systemMessage`가 실제로 어디에 보이는지(모델 맥락인지 사용자 화면인지) 본다. 사용자 화면에도 보인다는 epic의 Assumption을 확인하는 것이다.
  7. 실제 터미널에서 `npx`(또는 `node tooling/bootstrap/bin/second-brain.js`)를 대화형으로 돌려 설치기 질문이 나오는지 본다.
- **남은 위험:**
  - 원격 marketplace는 version을 키로 캐시하므로, app-ref만 올리고 version을 안 올리면 아무도 새 ref를 받지 못한다(README 릴리스 절에 적음).
  - auto가 꺼져 있고 새 ref가 아직 클론에 없으면 doctor가 `UPDATE_AVAILABLE` 대신 "관계를 알 수 없음" warn을 낸다(doctor는 fetch하지 않음).
  - 플러그인 캐시 경로는 버전마다 바뀌어서, auto가 꺼진 동안 `installed.json.plugin_root`가 옛 경로를 가리킬 수 있다.
  - 잠금 폴더를 만들 수 없는 환경에서는 hook이 조용히 아무것도 하지 않는다(기각한 리뷰 항목).
