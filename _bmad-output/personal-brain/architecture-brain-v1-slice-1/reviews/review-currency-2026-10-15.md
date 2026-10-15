---
review: currency
target: ../architecture-brain-v1-slice-1.md
target_updated: '2026-10-15'
reviewed: '2026-10-15'
reviewer: currency reviewer (web + 로컬 실측)
method: '공식 문서(code.claude.com / nodejs.org / learn.chatgpt.com) + npm registry + 로컬 Node 실측'
---

# 최신성 검토 — Personal Brain V1 slice 1 (2026-10-15 update)

## 판정

2026-10-15 update가 새로 단정한 것 대부분은 **실제로 공식 문서·레지스트리로 확인된다**(플러그인 `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}`, 마켓플레이스 `./plugin` 하위 폴더, 설치 lifecycle 없음, Node 일정 3개, sqlite-vec 정지, Stack 12개 중 11개). 다만 **훈련 데이터로 추정한 흔적이 남은 항목이 6개** 있고, 그중 **3개는 설계 판단을 바꿀 수 있는 사실 오류**다: ① 비동기 hook의 출력은 버려지지 않고 다음 턴에 주입된다, ② `node:sqlite`의 `timeout` 하한은 22.13이 아니라 **22.16.0**이며 그 아래에서는 **조용히 무시**된다, ③ `/plugin uninstall`은 플러그인 데이터 디렉터리를 **지운다**.

## 요약

| # | 항목 | 판정 |
| --- | --- | --- |
| 1a | 플러그인 `hooks/hooks.json` 등록 | 확인됨 |
| 1b | `${CLAUDE_PLUGIN_ROOT}` | 확인됨 (단, `${CLAUDE_PLUGIN_DATA}` 누락 — 보강) |
| 1c | hook `async: true` 가 세션 시작을 막지 않음 | 확인됨 |
| 1d | **비동기 hook의 출력 처리** | **수정 필요** |
| 1e | 플러그인에 설치 lifecycle(postinstall) 없음 | 확인됨 (단, 자동 의존성 설치 존재 — 보강) |
| 1f | **`/plugin uninstall`이 지우는 것** | **수정 필요** |
| 1g | 마켓플레이스 `./plugin` 하위 폴더 | 확인됨 |
| 1h | **플러그인 버전 갱신(`/plugin update`·autoUpdate)** | **수정 필요** |
| 2a | Codex 플러그인 출시 2026-03 | 확인됨 (비공식 출처) |
| 2b | **Codex hook 플래그 `codex_hooks`** | **수정 필요** |
| 2c | Codex hook 항목 해시로 변경 시 건너뜀 | 확인됨 (비공식) — 공식 문서엔 없음 |
| 3a | **Node 24.21.0 LTS** | **수정 필요** (24.22.0) |
| 3b | 2026-10-20 Maintenance / 2026-10-28 Node 26 Active LTS | 확인됨 |
| 3c | Node 20 EOL 2026-04-30 | 확인됨 |
| 3d | Node 22.13+ `node:sqlite` 플래그 없이 동작 | 확인됨 |
| 3e | **`DatabaseSync` `timeout` 옵션의 22.x 백포트 버전** | **수정 필요** (22.16.0) |
| 4 | sqlite-vec 0.1.9 이후 릴리스 없음 | 확인됨 (날짜 표현만 보강) |
| 5 | Stack 표 버전 12개 | 11개 확인됨 / **`file-type` 수정 필요** |
| 6a | nvm 경로 관례 | 확인됨 (로컬 실측) |
| 6b | Homebrew `/opt/homebrew/bin/node` | 확인됨 (관례) — 이 기계엔 미설치 |
| 6c | **volta·fnm 경로** | **미확인** — 실측 필요 |

---

## 1. Claude Code 플러그인 메커니즘 (AD-19 · AD-2 · Structural Seed)

> **먼저: 문서 URL이 이사했다.** `docs.claude.com/en/docs/claude-code/*` 는 전부 301로 `code.claude.com/docs/en/*` 로 옮겨졌고, `plugins-reference` 는 `plugins/manifest-reference` 로 쪼개졌다. spine의 sources·주석에 옛 URL이 남아 있으면 갱신 대상이다.

### 1a. `hooks/hooks.json` 으로 hook 등록 — 확인됨

공식 Standard layout 표에 `Hooks | hooks/hooks.json | Hook configuration` 이 그대로 있다. 추가로 `plugin.json` 의 `hooks` 키는 이 파일을 **대체하지 않고 병합**한다("Claude Code merges whatever you declare with `hooks/hooks.json` when that file exists"). 파일은 최상단에 `"hooks"` 래퍼가 있어야 하고, 래퍼 없이 이벤트 맵만 있으면 로드되지 않는다.

또한 **매니페스트 위치는 `.claude-plugin/plugin.json`** 이다("Save the manifest at `.claude-plugin/plugin.json` under the plugin root. Put every other plugin file at the plugin root, not inside `.claude-plugin/`"). spine은 `plugin/` 바로 아래 `plugin.json` 이라고 두 곳에 적어 두었다 — 그대로 만들면 매니페스트가 로드되지 않는다.

- 근거: <https://code.claude.com/docs/en/plugins/manifest-reference> (Manifest file, `hooks`, Standard layout)

**고칠 문장 (AD-19 "플러그인은 작다" 항목):**
> **플러그인은 작다**: `plugin/`에 `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/`, 의존성 없는 `bootstrap.js` 복사본(테스트로 원본과 동기화), `app-ref`. 매니페스트만 `.claude-plugin/` 안이고 나머지는 플러그인 루트에 둔다.

**고칠 문장 (Structural Seed):**
> `plugin/          # Claude Code 플러그인: .claude-plugin/plugin.json, hooks/hooks.json, skills/, bootstrap.js 복사본, app-ref (AD-19)`

### 1b. `${CLAUDE_PLUGIN_ROOT}` — 확인됨, 그리고 `${CLAUDE_PLUGIN_DATA}` 누락

`${CLAUDE_PLUGIN_ROOT}` 는 존재하고, hook 프로세스의 환경에도 export된다(`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_<KEY>`). 값은 **설치된 버전 디렉터리**이고(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`), 문서가 직접 못을 박는다: "`${CLAUDE_PLUGIN_ROOT}` changes when the plugin updates, so don't write state there." 옛 버전 디렉터리는 `.orphaned_at` 표식을 받고 **14일 뒤** 백그라운드 정리로 지워진다.

→ AD-19의 Prevents에 적힌 "플러그인 캐시 안에서 빌드해 갱신 때 날아가는 것"은 **맞다**(근거까지 확인됨).

다만 spine이 모르는 공식 대안이 있다. `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<id>/`, "created on first reference and **kept across plugin updates**", 용도는 명시적으로 "**Installed dependencies such as `node_modules`, generated code, and caches**". 즉 "갱신 때 날아간다"만으로는 `~/.second_brain/app` 을 고른 이유가 더 이상 설명되지 않는다. 실제 이유는 둘이다 — (ⅰ) `brain` CLI는 Claude Code 밖(CI·사람·launchd)에서도 돌아야 하고, (ⅱ) `${CLAUDE_PLUGIN_DATA}` 는 마지막 scope에서 제거할 때 **기본적으로 삭제된다**(1f).

**고칠 문장 (AD-19 Prevents · bootstrap 항목):**
> 앱은 `~/.second_brain/app`이고 플러그인 캐시(`${CLAUDE_PLUGIN_ROOT}`, 버전마다 경로가 바뀌고 옛 버전은 14일 뒤 지워진다) 안에서는 빌드하지 않는다. 갱신을 견디는 `${CLAUDE_PLUGIN_DATA}`(`~/.claude/plugins/data/<id>/`)도 쓰지 않는다 — CLI는 Claude Code 밖에서도 돌아야 하고, 그 폴더는 플러그인 제거 때 함께 지워진다(AD-20).

- 근거: <https://code.claude.com/docs/en/plugins/manifest-reference> (Environment variables), <https://code.claude.com/docs/en/plugins/loading> (Find plugins on disk, Cleanup of previous versions)

### 1c. `async: true` 가 막지 않음 — 확인됨

> "By default, hooks block Claude's execution until they complete. … set `"async": true` to run the hook in the background while Claude continues working."

`type: "command"` hook 전용 필드다. 비동기로 뜬 뒤에는 `timeout`을 **강제하지 않는다**("Claude Code doesn't enforce `timeout` on it"). 실행마다 별도 백그라운드 프로세스("Each execution creates a separate background process") — AD-7이 전제한 동시 실행과 일치한다.

### 1d. 비동기 hook의 출력 처리 — **수정 필요**

spine은 비동기 hook을 "출력이 없는 실행"처럼 다루지만, 문서는 반대다:

> "After the background process exits, Claude Code delivers the `additionalContext` and `systemMessage` fields from the hook's JSON response to Claude **on the next conversation turn**. Unlike a synchronous hook's `systemMessage`, neither field is shown to you."

파싱 규칙도 있다: JSON 응답은 stdout에 단독으로(여러 줄 가능, v2.1.295+) 또는 **한 줄에 단독으로** 찍어야 하며, 그래야 다른 텍스트를 함께 찍을 수 있다. 스키마 검증을 통과하지 못한 필드는 조용히 버려진다(`--debug`로만 경고가 보인다).

영향 둘:
- AD-19의 bootstrap hook과 AD-6의 `SessionStart (async) → brain admin drain` 은 **stdout에 JSON으로 보일 만한 것을 찍으면 안 된다**. 찍으면 다음 턴에 모델 컨텍스트로 들어가고, 사용자에게는 보이지 않아 디버깅이 어렵다. AD-4가 hook 출력을 connector adapter의 소유로 묶은 것은 맞지만, "비동기 경로는 조용하다"는 전제가 틀렸다.
- 더 중요한 것: **`claude -p` 에서는 비동기 hook이 teardown에 죽는다.** "In non-interactive mode with the `-p` flag, Claude Code kills any async hook still running at teardown and finalizes it with outcome `cancelled`" / "If your hook's work must outlive a `claude -p` session, start a fully detached process from it." 첫 세션의 clone·install·build(수십 초~분)는 `-p` 세션에서 **중간에 잘린다**. AD-19의 설치 잠금(`install.lock`) 회수 규칙이 이걸 받아내긴 하지만, 설계가 이 경로를 알고 있어야 한다.

**고칠 문장 (AD-19 설치 본문 (a) 항목 뒤에 추가):**
> 비동기 hook의 stdout은 버려지지 않는다. 종료 뒤 JSON 응답의 `additionalContext`·`systemMessage`가 다음 턴에 모델로 들어가고 사용자에게는 보이지 않으므로, bootstrap과 drain hook은 stdout에 아무것도 찍지 않는다(진단은 로그 파일로). `claude -p` 세션은 teardown에서 비동기 hook을 죽이므로(`cancelled`), 첫 세션 설치가 중간에 잘릴 수 있다 — 설치 잠금 회수와 멱등 재시도가 그 경로를 받는다.

**고칠 문장 (Conventions의 "hook 응답" 행에 추가):**
> 비동기 hook은 `decision`·`permissionDecision`·`continue`가 효력이 없고, 출력은 다음 턴에 주입된다. Brain의 비동기 hook은 stdout을 비운다.

- 근거: <https://code.claude.com/docs/en/hooks> (Run hooks in the background / How async hooks execute)

### 1e. 설치 lifecycle(postinstall) 없음 — 확인됨, 단 보강

플러그인 **자신의** 설치 스크립트는 없다. 그런데 Claude Code가 대신 하는 일이 있다: 플러그인 루트에 `package.json` **과** 지원하는 lockfile이 함께 있으면, 캐시 복사본에 Node 의존성을 자동 설치한다(설치·갱신·캐시 없는 세션 시작 시점). 제약이 촘촘하다 — registry 패키지만, lockfile에 고정된 정확한 버전만, `https` 다운로드만, 별도 폴더에서, **`--ignore-scripts`로 `preinstall`·`install`·`postinstall`을 막고**, 60초 타임아웃. "You can't turn the automatic install off."

Brain에 직접 걸리는 것: **`pnpm-lock.yaml`은 건너뛴다**("`yarn.lock` or `pnpm-lock.yaml`: replace it with an npm lockfile"). 그리고 공식 권장 우회 경로가 정확히 AD-19가 하려는 일이다 — "When the automatic install can't provide a dependency, install it from a hook into the persistent data directory."

→ AD-19의 "의존성 없는 `bootstrap.js` 복사본"과 "플러그인은 작다"는 **이 제약과 잘 맞는다**. 다만 `plugin/` 에 `package.json`+lockfile을 넣지 않겠다는 것을 못 박아 두면 사고를 막는다.

**고칠 문장 (AD-19 "플러그인은 작다" 항목에 추가):**
> `plugin/`에 `package.json`·lockfile을 두지 않는다. 두면 Claude Code가 캐시 복사본에 의존성을 자동 설치하려 하고(끌 수 없음, `--ignore-scripts`, 60초), pnpm lockfile은 건너뛰므로 어차피 빈손이다. 플러그인의 설치 lifecycle은 없고, 설치는 hook이 부르는 bootstrap 하나뿐이다.

- 근거: <https://code.claude.com/docs/en/plugins/loading> (Node.js package dependencies)

### 1f. `/plugin uninstall` 이 지우는 것 — **수정 필요**

spine: "`/plugin uninstall`은 데이터·LaunchAgent를 지우지 않으므로 `setup uninstall`은 남는다."

**결론은 맞지만 전제가 틀렸다.** 마지막 scope에서 제거하면 Claude Code는 플러그인의 저장된 옵션·비밀과 **데이터 디렉터리 `~/.claude/plugins/data/<id>/` 를 지운다**. 예외는 `--keep-data`, 같은 폴더를 쓰는 다른 플러그인이 있을 때, 설치 목록을 되읽지 못할 때 셋뿐이다. 즉 "데이터를 지우지 않는다"는 거짓이고, 맞는 말은 "**플러그인 디렉터리 밖은 건드리지 않는다**" — `~/.second_brain`(원본 DB·spool·shim)과 LaunchAgent는 그래서 남는다.

**고칠 문장 (AD-19 "플러그인은 작다" 마지막 문장):**
> `/plugin uninstall`은 플러그인 캐시와 그 플러그인의 데이터 디렉터리(`~/.claude/plugins/data/<id>/`, `--keep-data`로 보존)·옵션·비밀만 지우고 **플러그인 디렉터리 밖은 건드리지 않는다**. `~/.second_brain`의 원본 DB·spool·shim과 LaunchAgent는 남으므로 `setup uninstall`이 따로 있어야 한다(AD-20).

- 근거: <https://code.claude.com/docs/en/plugins/cli-reference> (plugin uninstall / What an uninstall deletes and keeps)

### 1g. 마켓플레이스가 같은 저장소의 `./plugin` 을 가리킬 수 있는가 — 확인됨

- 파일 위치: `.claude-plugin/marketplace.json` ✓
- 상대 경로 plugin source: 문자열 그대로, **`./` 로 시작해야 하고**, 마켓플레이스 **루트**에서 해석된다(`.claude-plugin/` 이 아니라). 문서가 명시한다: "Use a relative path for a plugin in a subdirectory of the marketplace repository itself." 예: `{ "name": "formatter", "source": "./plugins/formatter" }`
- 그래서 `second-brain` 저장소 루트에 `.claude-plugin/marketplace.json`, 엔트리 `"source": "./plugin"` 은 **유효하다**.

기록해 둘 제약 둘:
- 상대 경로는 마켓플레이스 소스가 `github`·`git`·`file`·`directory` 일 때만 해석된다. **`url`(marketplace.json 직링크)이면 해석 불가**, `settings` 면 거부.
- `version` 필드가 없으면 상대 경로 플러그인의 버전은 "설치된 디렉터리의 commit SHA"다. → 1h와 묶인다.

- 근거: <https://code.claude.com/docs/en/plugins/marketplace-reference> (Marketplace file, Plugin sources, Relative path plugin source)

### 1h. 플러그인 버전 갱신(`/plugin update` · autoUpdate) — **수정 필요**

AD-19: "플러그인 버전이 앱 커밋을 고정한다." / AD-20: "`setup upgrade`는 … 플러그인 hook의 `app-ref` 갱신은 같은 함수를 쓴다."

확인된 규칙이 이 설계에 두 군데 구멍을 낸다.

1. **매니페스트의 `version` 이 최우선이고, 고정하면 커밋을 아무리 밀어도 갱신이 안 된다.** "Because the manifest comes first, a manifest that pins `"version": "1.0.0"` keeps every user on the cached copy until its author changes the string, however many commits they push." 즉 `app-ref` 만 바꿔 커밋해도 사용자는 영원히 옛 플러그인을 쓴다. `plugin.json` 의 `version` 을 **함께 올려야** 한다.
2. **autoUpdate 기본값은 꺼짐이다.** 기본은 "on for Anthropic's official marketplaces …, **off for every other marketplace**". 개인 마켓플레이스는 자동 갱신되지 않는다. 갱신 경로는 사람이 `claude plugin update <plugin>` 을 돌리거나, `/plugin` 패널 **Marketplaces** 탭에서 **Enable auto-update** 를 켜거나, 설정 파일의 `extraKnownMarketplaces` 엔트리에 `autoUpdate` 를 쓰는 것이다. 켜져 있어도 반영은 즉시가 아니다 — 첫 메시지 뒤 최대 10분의 무작위 지연, 그 뒤 `/reload-plugins` 또는 다음 실행.
3. 쉘 명령 이름은 **`claude plugin update`** 다(`/plugin` 은 세션 안의 패널). spine이 `/plugin update` 로 적고 있다면 이름이 틀렸다.

**고칠 문장 (AD-19 "플러그인은 작다" 항목):**
> 플러그인 버전이 앱 커밋을 고정한다. `.claude-plugin/plugin.json`의 `version`은 마켓플레이스 엔트리보다 우선하고, **고정된 동안에는 커밋을 밀어도 사용자에게 가지 않으므로** `app-ref`를 올릴 때 `version`도 같이 올린다.

**고칠 문장 (AD-20 `setup upgrade` 항목에 추가):**
> 개인 마켓플레이스는 autoUpdate 기본값이 꺼짐이다. 플러그인 갱신은 사람이 `claude plugin update`를 돌리거나 `/plugin`의 Marketplaces 탭에서 auto-update를 켜야 일어나고, 반영은 `/reload-plugins` 또는 다음 실행이다. doctor의 "플러그인 버전과 앱 빌드 버전 일치" 검사가 이 지연을 드러내는 자리다.

- 근거: <https://code.claude.com/docs/en/plugins/loading> (Versions and updates / How Claude Code computes the version / When auto-update runs), <https://code.claude.com/docs/en/plugins/cli-reference> (plugin update)

---

## 2. Codex (Deferred 행)

spine: "Codex 플러그인은 있으나 hook이 실험 기능(`codex_hooks`)이고 hook 항목 해시가 shim 갱신에 걸리는지 확인 필요"

### 2a. 플러그인 출시 2026-03 — 확인됨 (비공식 출처)

여러 보도가 **2026-03-27** Codex 플러그인 마켓플레이스 출시로 일치한다(파트너 20여 개, 데스크톱·CLI·VS Code 확장에서 동작, 큐레이션 디렉터리 + 저장소 범위 + 개인 마켓플레이스). 다만 **이것들은 보도·블로그이고 OpenAI 공식 변경 로그로는 확인하지 못했다.** spine의 "2026-03" 자체는 틀리지 않았다.

- 근거: <https://winbuzzer.com/2026/03/31/openai-launches-plugin-marketplace-codex-enterprise-controls-xcxwbn/>, <https://thenewstack.io/openais-codex-gets-plugins/>, <https://www.unite.ai/openai-adds-plugin-marketplace-to-codex/>

### 2b. `codex_hooks` 플래그 — **수정 필요** (공식 문서로 확인)

공식 설정 참조가 이제 **`features.hooks`** 를 문서화한다: "Enable lifecycle hooks loaded from `hooks.json` or inline `[hooks]` config." 그리고 바로 덧붙인다 — "**`features.codex_hooks` is a deprecated alias.**" 즉 spine이 쓴 플래그 이름은 **구식 별칭**이다.

기본값(on/off)은 공식 문서가 말하지 않는다(다른 feature 항목들은 "on by default"/"off by default"를 명시하는데 `hooks` 만 비어 있다). 비공식 출처들은 0.145.0에서 이름이 바뀌며 기본 켜짐이 되었다고 말한다 — **미확인**으로 둔다.

함께 확인된 것: hook 등록처는 `hooks.json` **또는** `config.toml` 의 인라인 `[hooks]` 테이블이고, 핸들러 필드에 `async`·`additionalContextLimit`·`commandWindows` 가 있다. command·MCP tool hook만 지원되고 prompt·agent 핸들러는 파싱되지만 건너뛴다. 신뢰하지 않은 프로젝트는 `.codex/` 계층(프로젝트 config·hooks·rules)을 건너뛴다.

**고칠 문장 (Deferred "Codex 등 다른 Harness" 행):**
> Codex 등 다른 Harness | 다음 조각. AD-4의 계약(parser 필수, hook 선택)만으로 추가한다. 2026-10-15 사용자: 당분간 Claude Code만. Codex 플러그인 마켓플레이스는 2026-03에 열렸고, hook은 `[features] hooks`로 켠다(옛 `codex_hooks`는 폐기된 별칭, 기본값은 공식 문서에 없음). 등록처는 `hooks.json` 또는 `config.toml`의 인라인 `[hooks]`다. hook 정의가 바뀌면 신뢰 해시가 어긋나 **조용히 건너뛴다**(아래)

- 근거: <https://learn.chatgpt.com/docs/config-file/config-reference> (features.hooks, `[hooks]`) — `developers.openai.com/codex/config-reference` 는 308로 이 URL로 이사했다

### 2c. hook 항목 해시(`[hooks.state]`)로 변경 시 건너뛰는가 — 확인됨 (비공식), 공식 문서엔 없음

**공식 설정 참조에는 `[hooks.state]` 도, 해시·지문·재승인 메커니즘도 없다.** 반면 메커니즘 자체는 실사용 보고로 일관되게 확인된다:

- `~/.codex/config.toml` 에 `[hooks.state.'<key>'] trusted_hash = …` 형태의 신뢰 항목이 있고, **지금의 hook 정의와 해시가 일치할 때만** 실행된다. 어긋나면 **아무 말 없이 건너뛴다**.
- `hooks/list` 의 `trustStatus` 가 `modified` 로 보인다. 해시가 없으면 untrusted, 승인 뒤 바뀌었으면 modified.
- 복구 경로는 대화형 `/hooks` 리뷰 화면("Hooks need review").
- **헤드리스 공백**: `codex exec` 에서는 user·project `config.toml` 의 SessionStart command hook이 돌지 않고 아무것도 출력하지 않으며, `--dangerously-bypass-hook-trust` 를 줘야 돈다(openai/codex#46210, 0.153.4).
- 키 포맷과 해시 산출 방식은 문서화되어 있지 않고, 비대화형으로 설정하는 명령이 없다.

→ spine의 "확인 필요"는 **"확인됨(비공식)"으로 올려도 된다**: 해시는 실재하고, Brain이 hook 정의를 바꿀 때마다(= shim/`app-ref` 갱신으로 hook command 문자열이 바뀔 때) 사용자가 `/hooks` 에서 다시 승인해야 하며, 승인 전까지 수집이 **조용히 멈춘다**. 이것은 NFR-2(조용한 실패 금지)와 정면으로 부딪히므로, Codex 지원을 켤 때 doctor 검사가 반드시 필요하다.

**고칠 문장 (Deferred 같은 행에 이어서):**
> 해시는 비대화형으로 설정할 수 없고 `codex exec`에서는 신뢰 bypass 없이는 hook이 돌지 않으므로, Codex를 붙일 때 "hook 정의를 바꾸면 사용자가 `/hooks`로 재승인할 때까지 수집이 조용히 멈춘다"를 doctor 검사로 드러내야 한다(NFR-2). 공식 문서에는 `[hooks.state]`가 없어 비공식 확인이다

- 근거: <https://github.com/openai/codex/issues/46210>, <https://doc.jarvisuni.com/openai/codex/hooks>, <https://aident.ai/blog/fix-codex-desktop-project-hooks-not-running-trust>

---

## 3. Node (Stack)

### 3a. "24.21.0 LTS" — **수정 필요**

`nodejs.org/dist/index.json` 기준 v24 라인의 최신은 **24.22.0 (2026-10-14, lts: "Krypton")** 이다. 24.21.0은 2026-09-07로 한 패치 뒤처졌다(어제 나온 릴리스라 update 시점엔 최신이었을 수 있다).

### 3b. 2026-10-20 Maintenance / 2026-10-28 Node 26 Active LTS — 확인됨

공식 `nodejs/Release/schedule.json`:
- `v24: {"lts": "2025-10-28", "maintenance": "2026-10-20", "end": "2028-04-30"}` → **2026-10-20부터 Maintenance ✓**
- `v26: {"start": "2026-05-05", "lts": "2026-10-28", "maintenance": "2027-10-20", "end": "2029-04-30"}` → **2026-10-28부터 Active LTS ✓**
- 교차 확인: 현재 최신 v26.12.0(2026-10-14)의 `lts` 가 아직 `false` → 아직 LTS 아님, spine과 일치.

### 3c. Node 20 EOL 2026-04-30 — 확인됨

`v20: {"maintenance": "2024-10-22", "end": "2026-04-30"}` ✓ (이미 지난 날짜다 — "20은 `node:sqlite`가 없고"보다 "20은 EOL이 지났다"가 더 센 근거다)

### 3d. Node 22.13+ 에서 `node:sqlite` 가 플래그 없이 되는가 — 확인됨

공식 API 문서 버전 이력: "**v23.4.0, v22.13.0**: SQLite is no longer behind `--experimental-sqlite` but still experimental." ✓
Stability도 확인: v24·v26 문서 모두 **`Stability: 1.2 - Release candidate`**, "v24.15.0: SQLite is now a release candidate." → spine의 "Node 24·26 모두 Stability 1.2 Release candidate" ✓

### 3e. `DatabaseSync` 생성자 `timeout` 옵션이 어느 버전부터인가 — **수정 필요**

spine: "22.13+는 `DatabaseSync`의 `timeout` 옵션을 확인한 뒤에만"

공식 `DatabaseSync` 클래스 버전 이력: "**v24.0.0, v22.16.0** Add `timeout` option." → 백포트는 **22.16.0**이고, **22.13 ~ 22.15에는 없다.**

그리고 로컬 실측으로 더 나쁜 사실을 확인했다 — **`node:sqlite`는 모르는 생성자 옵션을 조용히 받아들인다.** 그래서 22.13~22.15에서 `timeout`을 주면 예외가 나지 않고 `busy_timeout`이 0으로 남는다. AD-7의 `busy_timeout`(턴 3초/명령 10초/drain 10초)이 **전부 무력화되면서 아무도 모른다** — NFR-2가 금지한 바로 그 실패 모양이다.

실측(`new DatabaseSync(p, { timeout: 4321 })` 뒤 `pragma busy_timeout`):

| Node | `{timeout}` | `pragma busy_timeout` | 번들 SQLite | `crypto.randomUUIDv7` |
| --- | --- | --- | --- | --- |
| 22.14.0 | 예외 없음 | **0 (무시됨)** | 3.47.2 | undefined |
| 22.19.0 | OK | 4321 | 3.50.4 | undefined |
| 22.20.0 | OK | 4321 | 3.50.4 | undefined |
| 24.11.1 | OK | 4321 | 3.50.4 | undefined |
| 24.16.0 | OK | 4321 | **3.53.0** | **function** |

부수적으로 확인된 것 둘:
- **번들 SQLite 3.53.0** 은 24.16.0에서 실측으로 재확인됨 ✓ (spine의 "2026-10-14 실측"과 일치)
- **`>=24.16.0` 하한의 근거가 실측으로 확인됨** ✓ `crypto.randomUUIDv7` 은 24.11.1에도 없고 24.16.0에 있다. "하한은 `node:sqlite`의 `defensive` 기본값과 `crypto.randomUUIDv7` 때문"은 정확하다(`defensive` 기본값 켜짐은 v24.14.0).

**고칠 문장 (Stack 표 Node.js 행):**
> `>=24.16.0` (24.22.0 LTS, 2026-10-20부터 Maintenance. 2026-10-28부터 26이 Active LTS). 하한은 `node:sqlite`의 `defensive` 기본값(v24.14.0)과 `crypto.randomUUIDv7`(24.16.0에 있고 24.11.1에 없음, 실측) 때문. 2026-10-15 사용자 확인: 24 이상 유지. 20은 EOL(2026-04-30)이고 `node:sqlite`가 없다. 22는 `DatabaseSync`의 `timeout` 옵션이 **22.16.0**부터이고, 그 아래에서는 모르는 옵션이 조용히 무시되어 `busy_timeout`이 0으로 남는다(AD-7 무력화) — 내리지 않는다

- 근거: <https://raw.githubusercontent.com/nodejs/Release/main/schedule.json>, <https://nodejs.org/dist/index.json>, <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>, <https://nodejs.org/docs/latest-v26.x/api/sqlite.html>

---

## 4. sqlite-vec (Stack) — 확인됨, 날짜 표현만 보강

spine: "sqlite-vec 0.1.9(pre-1.0, 2026-05-18 이후 릴리스 없음. node:sqlite 로드·KNN 실측)"

- npm `latest` = **0.1.9** ✓ / `alpha` = `0.1.10-alpha.4`
- GitHub 릴리스: `v0.1.9` 는 **2026-03-31**, 그 뒤 `v0.1.10-alpha.1~4` (prerelease), 마지막이 **2026-05-18**
- 마지막 커밋도 **2026-05-18** ("v0.1.10-alpha.4")

즉 "2026-05-18 이후 릴리스 없음"은 **활동 기준으로 맞다**. 다만 2026-05-18은 0.1.9의 날짜가 아니라 알파의 날짜여서 읽는 사람이 오해할 수 있고, **약 5개월 무활동**이라는 사실이 Deferred의 "sqlite-vec 유지보수 정지" 근거를 더 강하게 만든다.

**고칠 문장 (Stack 표 임베딩 행):**
> … 벡터 저장은 sqlite-vec 0.1.9(pre-1.0, 2026-03-31 릴리스. 이후 `0.1.10-alpha.4`까지 알파만 나오고 **2026-05-18 뒤 커밋·릴리스 없음 — 약 5개월 정지**. node:sqlite 로드·KNN 실측)

- 근거: `npm view sqlite-vec dist-tags`, <https://api.github.com/repos/asg017/sqlite-vec/releases>

---

## 5. Stack 표의 나머지 버전 — 11개 확인됨, 1개 수정 필요

`npm view <pkg> version` 실행 결과(2026-10-15):

| 패키지 | spine | 레지스트리 최신 | 판정 |
| --- | --- | --- | --- |
| typescript | 7.0.x (7.0.2) | 7.0.2 (2026-10-14) | 확인됨 |
| pnpm | >=12, 12.11.2 | 12.11.2 (2026-10-13) | 확인됨 |
| kysely | 0.29.6 | 0.29.6 (2026-09-16) | 확인됨 |
| commander | 15.0.0 | 15.0.0 (2026-09-02) | 확인됨 |
| pdfjs-dist | 6.4.299 | 6.4.299 (2026-10-03) | 확인됨 |
| mammoth | 1.13.0 | 1.13.0 (2026-09-26) | 확인됨 |
| **file-type** | **22.1.1** | **22.2.0 (2026-10-14)** | **수정 필요** |
| exif-reader | 2.0.3 | 2.0.3 (2025-12-12) | 확인됨 |
| uuid | 14.0.3 | 14.0.3 (2026-10-10) | 확인됨 |
| vitest | 5.0.4 | 5.0.4 (2026-10-12) | 확인됨 |
| smol-toml | 1.9.1 | 1.9.1 (2026-10-09) | 확인됨 |
| @clack/prompts | 1.8.1 | 1.8.1 (2026-09-13) | 확인됨 |
| pg (epic 7) | 8.23.1 | 8.23.1 (2026-09-30) | 확인됨 |

`file-type` 은 update 전날(2026-10-14) 22.2.0이 나왔다. minor 한 칸이라 급하지 않지만, AD-24가 "형식은 확장자가 아니라 **내용으로** 판정한다"고 못 박았으니 그 판정을 하는 라이브러리다.

**고칠 문장 (Stack 표 문서 추출 행):**
> `pdfjs-dist` 6.4.299, `mammoth` 1.13.0, `file-type` 22.2.0, `exif-reader` 2.0.3 (2026-10-15 npm 확인. 버전은 `extractor_version`에 들어간다, AD-24)

**함께 볼 것 (AD-24):** `extractor_version` 예시가 `doc/1+pdfjs-6.4.299+mammoth-1.13.0` 인데, 형식 판정을 하는 `file-type` 은 빠져 있다. 내용 기반 판정 결과가 추출 결과를 바꾸므로 상수에 넣는 쪽이 일관된다 — epic 2 인셉션 거리.

---

## 6. node 경로 관례와 AD-19 shim 폴백 순서

spine: "그 경로가 없으면 nvm 버전 폴더(24.16 이상 최신) → Homebrew → `/usr/local/bin` → volta → fnm 순으로 찾아 쓰고 다시 고정한다."

### 6a. nvm — 확인됨 (이 기계 실측)

`~/.nvm/versions/node/vX.Y.Z/bin/node` 가 정확하다. 이 기계에 8개가 그 모양으로 있고(`v14.21.3`, `v16.20.2`, `v20.18.3`, `v22.14.0`, `v22.19.0`, `v22.20.0`, `v24.11.1`, `v24.16.0`), PATH의 `node` 도 `~/.nvm/versions/node/v24.16.0/bin/node` 다. "24.16 이상 최신" 규칙을 적용하면 이 기계에서는 `v24.16.0` 하나만 후보가 된다 — 의도대로 동작한다.

### 6b. Homebrew / `/usr/local/bin` — 관례는 확인됨, 이 기계엔 미설치

Apple Silicon의 Homebrew prefix가 `/opt/homebrew` 이므로 `/opt/homebrew/bin/node` 가 맞고, Intel macOS는 `/usr/local/bin/node` 다. spine이 둘을 **연속한 두 단계**로 둔 것은 사실상 "Apple Silicon → Intel" 순서이고 타당하다. 다만 이 기계에는 둘 다 없어서(`ls` 실패) **실측으로는 확인하지 못했다.**

### 6c. volta · fnm — **미확인, 실측 필요**

여기가 가장 약하다. spine은 두 이름만 적고 경로를 적지 않았는데, 둘 다 경로가 단순하지 않다.

- **volta**: `$VOLTA_HOME` 기본값이 `~/.volta` 이고 shim이 `$VOLTA_HOME/bin` 에 있는 것까지는 확인된다. 그런데 **`~/.volta/bin/node` 는 실제 바이너리가 아니라 shim** 이다 — 프로젝트의 `package.json` 의 `volta` 핀과 volta 상태를 읽어 그때그때 다른 버전으로 넘긴다. AD-19의 shim은 "**설치 시점의 node 절대 경로를 담고**" 고정하는 것이 목적인데, volta shim 경로를 고정하면 **버전이 조용히 바뀔 수 있어 목적을 깨뜨린다.** 실제 이미지 경로(`~/.volta/tools/image/node/<version>/bin/node` 로 알려져 있음)는 공식 문서로 확인하지 못했다.
- **fnm**: 기본 디렉터리가 버전·플랫폼에 따라 갈린다 — `$XDG_DATA_HOME/fnm`, 없으면 Linux는 `~/.local/share/fnm`, macOS는 `~/Library/Application Support/fnm`. 옛 버전 문서는 `~/.fnm` 이라고 쓴다. 버전별 레이아웃은 `node-versions/<version>/installation/bin/node` 로 보고되지만 **공식 저장소로 확정하지 못했다.** macOS에서 `--arch` 없이 `darwin-x64` 를 깔아 Rosetta로 도는 경우도 있다.
- 이 기계에는 volta·fnm·asdf·mise 어느 것도 없다(전부 `ls` 실패) → **로컬 실측 불가**.
- 폴백 목록에서 **빠진 관리자**: asdf(`~/.asdf/installs/nodejs/<v>/bin/node`), mise(`~/.local/share/mise/installs/node/<v>/bin/node`). 역시 미설치로 미확인.

**고칠 문장 (AD-19 shim 항목):**
> **shim**(`~/.second_brain/bin/brain`)은 설치 시점의 node **실제 바이너리** 절대 경로를 담고 `npx`를 부르지 않는다. 그 경로가 없으면 nvm 버전 폴더(`~/.nvm/versions/node/vX.Y.Z/bin/node`, 24.16 이상 최신) → Homebrew(`/opt/homebrew/bin/node`) → `/usr/local/bin/node` 순으로 찾아 쓰고 다시 고정한다. **버전 관리자의 shim(volta `~/.volta/bin/node`, fnm·asdf·mise의 shim)은 고정 대상이 아니다** — 프로젝트 설정에 따라 다른 버전으로 넘겨 고정의 의미를 없앤다. 그런 관리자만 있는 기계에서는 실제 버전 디렉터리를 찾아 고정하고, 찾지 못하면 미설치가 아니라 `NODE_NOT_PINNABLE`로 doctor에 올린다.

**Deferred에 추가할 행:**
> volta·fnm·asdf·mise의 실제 node 바이너리 경로 | 이 기계에 없어 실측 못 했고 공식 문서도 버전마다 갈린다(fnm 기본 디렉터리, volta `tools/image`). 기존 "hook 환경의 PATH 실측"과 함께 epic 2 인셉션에서 측정한다

- 근거: <https://docs.volta.sh/guide/understanding>, <https://ports.macports.org/port/volta-node/>, <https://github.com/Schniz/fnm>, <https://github.com/Schniz/fnm/issues/824>, 로컬 실측

---

## 부록 — 실측 방법

```bash
# Stack 버전
for p in typescript pnpm kysely commander pdfjs-dist mammoth file-type \
         exif-reader uuid vitest smol-toml @clack/prompts sqlite-vec pg; do
  echo "$p => $(npm view "$p" version)  ($(npm view "$p" time.modified))"
done

# Node 일정·릴리스
curl -sL https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
curl -sL https://nodejs.org/dist/index.json

# sqlite-vec
npm view sqlite-vec dist-tags
curl -sL "https://api.github.com/repos/asg017/sqlite-vec/releases?per_page=8"

# node:sqlite timeout 실측 (3e의 표)
#   new DatabaseSync(p, { timeout: 4321 }) 뒤 `pragma busy_timeout` 을 읽는다.
#   22.14.0 은 예외 없이 0을 돌려준다 = 조용히 무시.

# 경로 관례
ls -d ~/.nvm/versions/node/*/bin/node
ls -l /opt/homebrew/bin/node /usr/local/bin/node
ls -d ~/.volta/tools/image/node ~/Library/Application\ Support/fnm \
      ~/.local/share/fnm ~/.asdf/installs/nodejs ~/.local/share/mise/installs/node
```

## 출처

- <https://code.claude.com/docs/en/plugins/manifest-reference>
- <https://code.claude.com/docs/en/plugins/marketplace-reference>
- <https://code.claude.com/docs/en/plugins/loading>
- <https://code.claude.com/docs/en/plugins/cli-reference>
- <https://code.claude.com/docs/en/hooks>
- <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>
- <https://nodejs.org/docs/latest-v26.x/api/sqlite.html>
- <https://raw.githubusercontent.com/nodejs/Release/main/schedule.json>
- <https://nodejs.org/dist/index.json>
- <https://api.github.com/repos/asg017/sqlite-vec/releases>
- <https://learn.chatgpt.com/docs/config-file/config-reference>
- <https://github.com/openai/codex/issues/46210>
- <https://doc.jarvisuni.com/openai/codex/hooks>
- <https://aident.ai/blog/fix-codex-desktop-project-hooks-not-running-trust>
- <https://winbuzzer.com/2026/03/31/openai-launches-plugin-marketplace-codex-enterprise-controls-xcxwbn/>
- <https://thenewstack.io/openais-codex-gets-plugins/>
- <https://docs.volta.sh/guide/understanding>
- <https://github.com/Schniz/fnm>
