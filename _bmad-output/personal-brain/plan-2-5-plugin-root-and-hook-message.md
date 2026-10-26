---
title: '2.5 사람 확인 후속: 지금 플러그인 위치와 hook 메시지의 독자'
type: 'bugfix'
ticket: ''
created: '2026-10-18'
status: 'built'
baseline_revision: 'a3c4841b79f85a303a0f263cdbb8a0738f512b74'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
warnings: [oversized]
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 2.5의 사람 확인(2026-10-18)에서 두 가지가 나왔다. (1) doctor의 `plugin` 점검은 `installed.json.plugin_root`의 `app-ref`만 본다. 그런데 Claude Code 플러그인 캐시는 버전마다 폴더가 다르다(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, 옛 폴더도 남는다). 그래서 `claude plugin update` 뒤 `[update] auto = false`면 bootstrap이 아무것도 하지 않고 기록도 옛 폴더에 머물러, `UPDATE_AVAILABLE`과 `PLUGIN_BEHIND`가 나오지 않는다. 재현: 2774cd7로 설치한 임시 home에 auto=false를 두고 app-ref가 HEAD인 플러그인 복사본을 `--plugin-dir`로 열면, doctor가 "플러그인과 설치가 같은 2774cd7입니다"(ok)를 낸다. (2) 비동기 SessionStart hook의 `systemMessage`는 다음 턴에 모델만 받고 사용자 화면에는 보이지 않았다. epic-capture Notes의 Assumption(2026-10-16)이 틀렸다.

**Approach:** hook 모드 bootstrap이 세션마다 자기를 부른 플러그인의 위치와 app-ref를 `<home>/run/` 아래 기록에 남긴다(값이 바뀔 때만 쓴다). doctor는 그 기록이 있으면 그것을 `installed.json.plugin_root`보다 앞세운다. (2) 같은 기록에 마지막 bootstrap 결과를 남겨 doctor가 사람에게 보이고, hook의 `systemMessage`는 모델이 사용자에게 전하도록 쓴 문장으로 바꾼다. Assumption은 Decision으로 바꾼다.

## Boundaries & Constraints

**Always:**
- 빠른 경로는 그대로 싸다: 기록할 위치·ref가 이미 같으면 아무것도 쓰지 않는다. git·pnpm을 부르지 않는다. 쓰기는 임시 파일→rename이다.
- 기록 파일은 설정 코덱을 거치지 않는 런타임 기록이다(Conventions '설치·런타임 기록'). spine Conventions의 `<home>/run/` 목록에 더한다.
- 기록을 읽을 수 없거나 없으면 doctor는 지금처럼 `installed.json.plugin_root`를 쓴다(옛 설치와 npx 설치는 그대로 동작).
- `plugin/bootstrap.mjs`는 `tooling/bootstrap` 빌드 산출물이다. 원본만 고치고 빌드로 맞춘다(`plugin.test.ts` 동기화 검사).
- 고친 커밋 뒤에 2.5 결정 8과 같은 방식으로 `plugin/app-ref`와 `plugin.json` version(0.1.1→0.1.2)을 올리는 커밋을 따로 둔다.
- 새 사람용 문장은 한국어이고 출력 언어 검사를 통과한다.
- Decision(2026-10-18, 사용자 — Open Questions 1의 A): 사람용 결과는 doctor로 옮긴다. `<home>/run/` 기록에 마지막 bootstrap 결과(시각, `installed` 또는 실패한 단계, 로그 위치)를 함께 남기고, doctor `plugin` 점검이 보인다(실패면 `warn`). hook의 `systemMessage` 세 경우(설치 완료, 설치 실패, node 못 찾음)는 남기되, 모델이 사용자에게 한 줄로 전하도록 쓴 문장으로 바꾼다. node 못 찾음은 bootstrap이 돌지 않으므로 기록 없이 hook 줄만 남는다.
- Decision(2026-10-18, 사용자): 플랜 크기(약 2,000 토큰)는 넘지만 나누지 않는다. 두 문제가 같은 기록 파일과 doctor 점검을 고친다.

**Never:**
- 사용자의 실제 `~/.claude`·`~/.second_brain`을 바꾸는 시험. 시험은 임시 home과 `--plugin-dir`로만 한다.
- `last-hook-<harness>`(마지막 hook 수신 시각, 2.14)와 `PLUGIN_DUPLICATE` 판정. 이 기록은 그 둘의 자리를 미리 차지하지 않는다.
- 자동 갱신 동작 자체(언제 ff하는지)를 바꾸는 것.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 새 폴더, auto 꺼짐 | 설치 2774cd7, auto=false, 새 플러그인 폴더의 app-ref가 앞섬 | 갱신 안 함, 기록이 새 폴더를 가리킴, doctor `UPDATE_AVAILABLE` | doctor exit 0 |
| 새 폴더, 뒤처짐 | 새 폴더의 app-ref가 설치본의 조상 | doctor `PLUGIN_BEHIND` | exit 0 |
| 같은 폴더·ref | 이미 기록된 값과 같음 | 파일을 다시 쓰지 않음(mtime 그대로) | — |
| 기록 없음 | 옛 설치 또는 npx 설치 | 지금처럼 `installed.json.plugin_root` 사용 | — |
| 기록 깨짐 | JSON이 아니거나 칸이 틀림 | 기록을 무시하고 위와 같이 | doctor는 깨진 기록을 한 줄 언급 |
| 앞섬, auto 켜짐 | 새 폴더의 app-ref가 앞섬 | 지금처럼 그 세션에서 갱신, `installed.json.plugin_root`도 새 폴더 | — |
| 설치 실패 | hook 설치가 한 단계에서 실패 | 기록에 실패 단계·로그 위치, doctor `plugin: warn`(그 단계와 로그), hook 줄은 모델용 문장 | hook exit 비0(지금과 같음) |
| 설치 성공 | hook 설치 완료 | 기록에 `installed`와 시각, doctor가 마지막 설치를 한 줄로 보임, hook 줄은 모델용 문장 | — |

</frozen-after-approval>

## Code Map

- `tooling/bootstrap/src/bootstrap.ts` -- `hookMode`(299-380): 빠른 경로 `before.commit === ref → return 0`(323), `before.present && !updateAuto → return 0`(326), 잠금 실패 `return 0`(336), 성공 `deps.message('Brain을 …로 설치했습니다')`(375), 실패 `failed(step)`(315-318). `--plugin-root`는 소비하지 않고 설치기에 넘긴다(192 주석, `parsed.rest`). 기록 쓰기는 `parsed`에서 plugin root를 읽어 `hookMode` 앞쪽(322 전)에 둔다. `deps`에 쓰기 seam이 필요하면 기존 `BootstrapDeps` 패턴을 따른다. `message`(130, 920-927): stdout 한 줄 JSON `systemMessage`.
- `plugin/bin/session-start.sh:154` -- `exec node bootstrap.mjs --yes --ref <sha> --plugin-root "$ROOT"`. node를 못 찾을 때의 `systemMessage`도 여기서 낸다(사람 확인 4).
- `apps/cli/src/doctor/checks.ts` -- `pluginCheck`(243-312): `readInstalled(home)` → `readAppRef(record.plugin_root)`. 기록 파일을 먼저 읽어 root를 고른다. `readAppRef`·`readInstalled`는 `apps/cli/src/install/installed.ts`(94, 232).
- 테스트: `tooling/bootstrap/test/bootstrap.test.ts`(hook 모드 951 "auto off이면 아무 말 없음", 967), `tooling/bootstrap/test/hook.test.ts`, `tooling/bootstrap/test/plugin.test.ts`(사본 동기화), `apps/cli/test/doctor-checks.test.ts`(plugin 점검).
- 문서: `README.md` `### Claude Code 플러그인으로`(12~), spine `architecture-brain-v1-slice-1.md:478`(Conventions '설치·런타임 기록'), `tickets/epic-capture/epic-capture.md:131`(Assumption).

## Tasks & Acceptance

**Execution:**
- [x] `tooling/bootstrap/src/bootstrap.ts` -- hook 모드에서 `<home>/run/` 기록(`plugin_root`, `app_ref`, `seen_at`)을 값이 바뀔 때만 원자적으로 쓴다. 마지막 bootstrap 결과(성공·실패 단계·로그 위치·시각)도 같은 기록에 남기고, `systemMessage` 문장을 모델용으로 바꾼다.
- [x] `apps/cli/src/doctor/checks.ts`, `apps/cli/src/install/installed.ts` -- 기록 읽기(검증 포함), root 선택, 마지막 bootstrap 결과 표시(실패면 `warn`).
- [x] `plugin/bin/session-start.sh` -- node 못 찾음 `systemMessage`를 모델용 문장으로.
- [x] `tooling/bootstrap` 빌드 -- `plugin/bootstrap.mjs`·`bin/second-brain.js` 갱신.
- [x] 테스트 -- 매트릭스 각 행(bootstrap 단위 + doctor 단위), 빠른 경로에서 쓰기가 없음, 깨진 기록.
- [x] `README.md`, spine Conventions, `epic-capture.md` Notes -- 기록 파일, doctor 동작, Assumption → Decision.
- [x] 별도 커밋 -- `plugin/app-ref`를 고친 커밋 sha로, `plugin.json` version 0.1.2.

**Acceptance Criteria:**
- Given 임시 home과 `--plugin-dir`로 위 재현을 다시 돌림, when `brain doctor run`, then `plugin: warn [UPDATE_AVAILABLE]`이 나온다.
- Given 같은 플러그인으로 세션을 두 번, when 두 번째 세션, then 기록 파일의 mtime이 바뀌지 않는다.

## Design Notes

- 기록을 `installed.json`에 넣지 않는 이유: `installed.json`은 "완료 검증 뒤 마지막에 쓰는 완료 기록"이고 bootstrap·`setup run`만 쓴다(AD-19). 갱신하지 않은 세션이 그 파일을 고치면 "완료 기록"의 뜻이 흐려진다.
- 기록 예(이름은 구현에서 Conventions에 맞춰 정한다):
  ```json
  {"plugin_root":"/Users/me/.claude/plugins/cache/second-brain/second-brain/0.1.2",
   "app_ref":"<40자 sha>","seen_at":"2026-10-18T02:12:27.381Z"}
  ```

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest 모두 통과(Postgres 포함)
- 실행 결과(2026-10-18): `BRAIN_TEST_DATABASE_URL`을 로컬 시험 컨테이너로 두고 `pnpm test` → 45파일 1533건 통과.
- 재현 스크립트(임시 root, 임시 home, bare 저장소, 버전별 플러그인 폴더 두 개)로 매트릭스 1·2·3행을 직접 확인했다: 새 폴더+auto 꺼짐 → `plugin: warn [UPDATE_AVAILABLE]`(경고 배열에도 올라옴), 옛 폴더가 다시 부름 → `PLUGIN_BEHIND`, 같은 플러그인으로 한 번 더 → 기록 mtime 그대로.

**Manual checks (if no CLI):**
- 임시 home + `claude --plugin-dir`로 2.5 확인 3·5를 다시 돈다: 앞섬·뒤처짐·auto 꺼짐에서 doctor가 각각 갱신 예정 ok·`PLUGIN_BEHIND`·`UPDATE_AVAILABLE`.

## Implementation Notes

- 기록 이름은 `<home>/run/plugin.json`이다(`RUN_FOLDER`·`PLUGIN_RUN_FILE`은 bootstrap과 `apps/cli/src/config/paths.ts`에 한 번씩, 기존 상수 대조 테스트가 둘을 묶는다). 칸은 `{plugin_root, app_ref, seen_at, last_bootstrap?{at, result, step?, log}}`이고 `result`는 `installed | failed`다.
- `--plugin-root`는 **여전히 소비하지 않는다**. `parseArgs`가 지나가면서 값만 읽어 `pluginRoot`로 내놓고 `rest`에는 그대로 둔다. 설치기에 가는 인자는 한 글자도 바뀌지 않는다.
- 쓰기 seam은 `BootstrapDeps.moveFile(from, to): boolean` 하나다. 임시 파일은 `writeText`로 쓰고 rename으로 갈아 끼운다. rename이 실패하면 `moveFile`이 임시 파일을 직접 지우고 false를 돌려주므로 기록 옆에 찌꺼기가 남지 않는다. 실패는 로그 한 줄로 말하고 설치는 계속한다.
- `seen_at`은 "이 폴더·ref를 처음 본 시각"이다. 값이 같으면 다시 쓰지 않으므로 세션마다 갱신되지 않는다(Acceptance의 mtime 조건이 이것이다).
- 폴더가 바뀌어 기록을 갈아 쓸 때 이전 `last_bootstrap`은 그대로 옮긴다. 갱신하지 않기로 한 세션이 바로 그 경우여서, 지우면 "마지막 설치"를 말할 수 없게 된다.
- doctor는 `pluginCheck`(기록 읽기·문장 덧붙이기·실패면 `warn`으로 올리기)와 `pluginVerdict`(원래의 판정표, 플러그인 폴더를 인자로 받음)로 나뉘었다. 문장은 `sentences()`가 마침표 하나로 잇는다.
- 완료 기록이 없고 세션 기록만 있는 상태(설치 중이거나 설치가 끝나지 못한 경우)에 `plugin: ok "<폴더>의 플러그인이 왔지만 완료 기록이 아직 없습니다"`가 새로 생겼다. 설치기 끝의 doctor가 이 줄을 낸다.
- doctor의 조상 질문은 `<home>/app` 클론에서 돈다. 플러그인이 가리키는 새 commit은 마지막 설치 뒤에 push된 것이라 클론에 없고, 그러면 `UPDATE_AVAILABLE`이 아니라 "관계를 알 수 없습니다"가 나온다(첫 수동 재현이 이것을 놓친 이유는 bare 저장소에 두 commit이 다 있었기 때문이다). 그래서 **기록이 실제로 바뀐 세션이 갱신하지 않고 돌아갈 때만** `git -C <app> fetch origin`을 한 번 한다 — 체크아웃도 HEAD도 건드리지 않고, 실패는 로그 한 줄이다. 기록이 그대로인 보통 세션은 git을 전혀 부르지 않는다(두 경우 모두 테스트가 있다). doctor 자체는 여전히 fetch하지 않는다(Never: 자동 갱신 동작 변경).
- 마지막 결과가 `failed`인데 `installed.json.installed_at`이 그보다 **나중**이면 doctor는 `warn`으로 올리지 않는다. npx나 `setup run`으로 밖에서 회복하면 다음 세션은 빠른 경로라 기록을 다시 쓰지 않으므로, 올리면 경고가 영원히 남는다. 문장은 그대로 보인다.
- doctor 쪽 `readPluginRun`은 `last_bootstrap`만 깨진 기록을 통째로 버리지 않고 그 칸만 떨어뜨린다(bootstrap의 reader와 같은 규칙). 통째로 버리면 bootstrap은 폴더·ref가 같다고 보고 다시 쓰지 않아 빠져나올 수 없는 상태가 된다.

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass (quick)
- verdicts: 8 findings — high 1, medium 1, low 6, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` `checks.ts` `isAncestor`가 `<home>/app`에서 돈다 — 실제 사용에서 플러그인의 새 ref는 설치 뒤 push된 commit이라 클론에 없고, doctor는 `UPDATE_AVAILABLE` 대신 코드 없는 "관계를 알 수 없습니다"를 낸다(사람 확인 재현은 새 commit이 이미 있는 로컬 저장소에서 clone해 통과했다) — hook 모드가 기록을 새로 쓴 세션(폴더나 ref가 바뀜)에서 설치하지 않고 돌아갈 때 `git -C <app> fetch origin`을 한 번 한다. checkout·HEAD는 그대로, 실패는 로그만. 설치 뒤 push된 commit으로 다시 재현해 `warnings:["UPDATE_AVAILABLE"]`을 확인했다(`e527807`).
  - `[medium]` `[patch]` `checks.ts` `pluginCheck` — hook 설치가 실패한 뒤 npx·`setup run`으로 회복해도 기록이 다시 써지지 않아 doctor가 영원히 warn — `installed.json.installed_at`이 `last_bootstrap.at`보다 나중이면 올리지 않는다.
  - `[low]` `[patch]` `checks.ts` `sentences` — 붙일 문장이 없어도 기존 `UPDATE_AVAILABLE` 줄의 마침표를 깎는다 — 두 개 이상일 때만 정규화.
  - `[low]` `[patch]` `checks.ts` 깨진 기록 문장 — 완료 기록이 없을 때 "완료 기록이 가리키는 폴더를 봅니다"가 판정과 모순 — "…을 읽을 수 없어서 무시했습니다"로 바꾸고 그 경우 테스트를 더했다.
  - `[low]` `[patch]` `installed.ts` `readPluginRun` — `last_bootstrap`만 깨진 기록을 doctor는 통째로 무효, bootstrap은 칸만 버리고 다시 쓰지 않아 빠져나올 수 없다 — doctor도 그 칸만 버린다.
  - `[low]` `[patch]` `bootstrap.ts` `parseArgs` — 상대 경로 `--plugin-root`도 기록한다(설치기는 거부함) — `isAbsolute`일 때만 받는다. `rest`는 그대로.
  - `[low]` `[patch]` `bootstrap.ts` `noteSeenPlugin`/`noteBootstrap` — 첫 쓰기가 실패하면 결과가 옛 폴더·ref에 붙는다 — 쓰려던 기록을 돌려준다.
  - `[low]` `[patch]` `bootstrap.test.ts` — 실패 `systemMessage`만 모델용 문구 단정이 없다 — 단정을 더했다.
- 메모: 서브에이전트가 두 라운드 커밋을 합치려던 `git reset --soft`는 권한 분류기에 막혔고, 이력을 덮지 않고 커밋 둘(`e527807`, `cceb816`)을 더 쌓았다. 그래서 플러그인 version은 0.1.3이다(0.1.2는 `0be9fbb`가 이미 썼다).
