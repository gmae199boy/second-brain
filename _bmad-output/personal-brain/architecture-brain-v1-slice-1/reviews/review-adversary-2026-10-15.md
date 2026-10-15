---
name: 'Adversary review — spine 2026-10-15 개정판(플러그인·데몬·MCP) 공격'
type: architecture-review
lens: adversary
target: ./architecture-brain-v1-slice-1.md
target_updated: '2026-10-15'
reviewed: '2026-10-15'
method: 'AD를 전부 지키면서도 서로 못 붙는 하위 단위 쌍(pair) 구성 + 실제 코드와의 충돌'
inputs:
  - ../../change-surface-plugin-daemon/change-surface-plugin-daemon.md (§3, §4.2)
  - apps/cli/src/dispatch.ts
  - apps/cli/src/envelope.ts
  - apps/cli/src/install/flow.ts
  - apps/cli/src/install/shim.ts
  - apps/cli/src/commands/setup-connect.ts
  - apps/cli/src/doctor/checks.ts
  - packages/core/src/admin/doctor.ts
  - packages/core/src/ports/connector.ts
  - tooling/bootstrap/src/bootstrap.ts
  - packages/sqlite/migrations/0002_files_and_work.sql
---

# Adversary — 2026-10-15 개정판 공격

## 공격 방법

"spine이 틀렸다"를 찾지 않는다. **AD를 한 글자도 어기지 않는 하위 단위 두 개를 만들어 서로 못 붙게 한다.** 쌍이 성립하면 그 자리가 구멍이고, 구멍마다 그대로 붙여 쓸 규칙 문장을 제시한다. 이번 판은 2026-10-15 개정(AD-2·5·15·17·19·24·25 개정, AD-26~28 신설, Conventions 종료 코드·명령 메타)이 **epic 2와 epic 9 사이**, **epic 2와 epic 4 사이**에 새로 만든 접합부를 공격한다. epic 1이 이미 코드로 존재하므로 "단위 둘" 중 한쪽을 **실제 코드**로 두는 쌍도 함께 만든다.

| 단위 | 소속 | AD 근거 | 상태 |
| --- | --- | --- | --- |
| U-plg — 플러그인 뼈대(`plugin/`, hooks.json, app-ref) | epic 2 | AD-2, AD-19 | 새 스토리 |
| U-boot — bootstrap 개정(`--ref`, 설치 잠금, 24.16) | epic 2 | AD-19 | 기존 코드 수정 |
| U-conn — `setup connect claude-code` 개정 | epic 2 | AD-19 | 기존 코드 수정 |
| U-cli — CLI 규약 보강(메타, 봉투, 종료 코드 3, doctor 등급) | epic 2 | AD-5, Conventions | 새 스토리 |
| U-ext — 추출 일감(`attempt`, `failed_stage`, `locator`) | epic 2 | AD-21, AD-24 | 새 스토리 + 0003 |
| U-ctx — 시작 맥락(동기 `context show`) | epic 3 | AD-6, AD-17 | 예정 |
| U-gd — 안내문 원본·플러그인 스킬 | epic 3 | AD-17 | 예정 |
| U-doc — 문서 검색(`recall docs`, 결과 계약) | epic 4 | AD-15, AD-24 | 예정 |
| U-ops — launchd·업그레이드·제거 | epic 5 | AD-20, AD-25 | 예정 |
| U-dmn — 데몬(`daemon run`, 소켓) | epic 9 | AD-26, AD-27 | 예정 |
| U-mcp — MCP(`mcp serve`) | epic 9 | AD-28 | 예정 |
| U-drn — drain(`admin.drain`, `work_items`) | epic 2·5 | AD-7, AD-21 | 예정 |
| **코드** — `dispatch.ts`·`flow.ts`·`shim.ts`·`bootstrap.ts`·`doctor.ts`·0002 | epic 1 | — | 커밋됨 |

## Verdict

**조건부 통과 — Critical 6건은 epic 2 인셉션 전에 닫아야 한다. 그중 4건(C-1·C-2·C-3·C-6)은 플러그인 스토리의 첫 코드 한 줄을 쓰기 전에 정해야 하고, C-5는 0003 SQL을 쓰기 전에 정해야 한다.**

세 축에서 구멍이 열렸다.

**첫째, 플러그인이 "두 번째 설치기"가 되었는데 그 상태를 적는 자리가 없다.** AD-19는 플러그인 hook의 판정 조건을 "shim이 없거나 `app-ref`가 `~/.second_brain`에 기록된 ref와 다를 때"로 못 박았지만, **그 기록의 경로·형식·작성자가 spine 어디에도 없다.** Table Contract는 DB 테이블만 고정하고, AD-18은 "설정은 설정 코덱 하나만 읽고 쓴다"로 닫혀 있어 의존성 없는 `bootstrap.js` 복사본은 설정 파일을 쓸 수 없다. 그래서 U-plg와 U-ops가 각자 다른 파일·다른 형식을 만들고, 증상은 "매 세션 ff+build가 돈다" 또는 "영원히 안 돈다" 둘 중 하나인데 **둘 다 조용하다**(C-1). 같은 자리에서 "`setup connect claude-code`가 플러그인 설치를 어떻게 확인하는가"도 비어 있고, 현재 코드의 `Connector.connect` 계약(`target` = hook을 쓴 파일, 실패는 설치 exit 1)과 정면으로 부딪친다(C-2).

**둘째, "설치 완료 표식은 shim"이 현재 코드에서 성립하지 않는다.** `flow.ts`는 shim을 흐름 **중간**에 쓰고(그 뒤 connect·doctor), `shim.ts`가 박는 경로는 `<home>/app/apps/cli/dist/bin.js`로 **업그레이드해도 변하지 않는다**. 그래서 (a) 실패한 설치도 shim을 남기고, (b) 두 번째 세션 이후 shim은 아무 것도 증명하지 못하며, (c) `pnpm -r build`가 `dist`를 **제자리에서** 다시 쓰는 동안 동기 `context show` hook이 shim을 부르면 반쯤 쓰인 빌드를 import한다. hook의 exit 0 보호는 프로세스가 떠야 작동하므로 이때는 작동하지 않는다(C-3).

**셋째, 표면이 셋이 되었는데 봉투·인자·세션·종료 코드의 주인이 여전히 CLI다.** 봉투를 만드는 코드는 `apps/cli/src/envelope.ts`이고 `now`에 **로컬 오프셋**을 넣는다. AD-26·28은 "CLI와 같은 봉투"를 요구하지만 AD-5는 "어느 표면도 다른 표면의 표현을 만들지 않는다"고 한다. 두 문장을 동시에 지키는 방법이 없어서 U-dmn은 베끼거나 CLI를 import하고, 장수 프로세스에서 `now`의 오프셋이 묵는다(H-1). 세션 토큰은 AD-4(env), AD-26(`session?`), AD-28(`session` 인자)에서 **세 자리**에 있고 우선순위가 없다(H-3). `args`가 argv 배열인지 SDK 객체인지도 정해지지 않아 `retry_argv` 변환이 두 개가 된다(H-4).

- Critical 6 (C-1~C-6): 쌍이 못 붙고 증상이 조용하다. 또는 이미 닫은 결정(이전 리뷰 C-1)이 되살아난다
- High 9 (H-1~H-9): 쌍이 서로 다른 답을 내거나, 정상 동작이 실패로 분류된다
- Medium 8 (M-1~M-8), Low 3 (L-1~L-3)

---

## Critical

### C-1. `app-ref`를 적을 자리가 없다 — 플러그인은 매 세션 빌드하거나 영원히 안 한다

**쌍:** U-plg(플러그인 뼈대, epic 2) × U-ops(`setup upgrade`, epic 5). 코드: `tooling/bootstrap/src/bootstrap.ts`

**각자 AD를 지키는 방식**

- U-plg는 AD-19를 글자 그대로 쓴다: "플러그인의 SessionStart 비동기 hook이 shim이 없거나 플러그인의 `app-ref`가 `~/.second_brain`에 기록된 ref와 다를 때만 `bootstrap.js --yes --ref <commit>`를 돌린다. 매 세션은 그 검사만 한다(파일 둘 읽기)." `plugin/app-ref`는 커밋된 파일이므로 형식은 자유롭게 정한다 — 사람이 읽을 수 있게 `ref: 149974f\n`로 쓴다. `~/.second_brain` 쪽은 AD-18이 "설정의 읽기·쓰기는 Runtime의 설정 코덱 하나만 한다"로 닫아 두었고 플러그인의 `bootstrap.js`는 **의존성이 없어야 하므로**(AD-19) `smol-toml`을 쓸 수 없다. 그래서 `~/.second_brain/app-ref`에 같은 형식으로 쓴다.
- U-ops는 AD-20을 글자 그대로 쓴다: "`setup upgrade`는 … shim 재작성 … 순서다. 플러그인 hook의 `app-ref` 갱신은 같은 함수를 쓴다(AD-19)." `setup upgrade`는 빌드된 앱 안에서 도니 `git -C <home>/app rev-parse HEAD`가 진실이고, 기록은 기계가 읽을 것이므로 `{"ref":"149974f…","at":"2026-10-15T…Z"}` JSON 한 줄로 쓴다(Conventions의 시각 정규형까지 지킨다).

둘 다 AD 위반이 없다. **"기록된 ref"의 경로·형식·작성자가 spine에 없기 때문이다.**

**왜 못 붙는가**

- 경로가 다르면(`<home>/app-ref` vs `<home>/state.json` vs `config.toml`의 키) 플러그인 hook의 비교는 **대상이 없는 비교**가 된다. "파일이 없다 = 다르다"로 읽으면 매 세션 ff+build가 돌고, "없으면 검사 생략"으로 읽으면 `/plugin update` 뒤에 아무 일도 일어나지 않는다.
- 경로가 같아도 형식이 다르면 문자열 비교가 **항상 불일치**다(`ref: 149974f` ≠ `{"ref":"149974f"}`). 비교 방법(trim? 전체 일치? 접두 7자?)도 없다. 짧은 sha와 긴 sha를 섞으면 같은 커밋이 다르게 읽힌다.
- 누가 쓰는가도 비어 있다. 지금 코드에서 bootstrap은 `apps/cli/dist/install.js`에 **넘기고 그 종료 코드를 그대로 돌려준다**(`bootstrap.ts` 마지막 단계). 설치가 exit 1로 끝났는데 bootstrap이 먼저 ref를 적었으면 **깨진 설치가 다시는 재시도되지 않는다**.

**증상.** 매 세션 몇 분짜리 `pnpm install && pnpm build`가 비동기로 돌아 팬이 돌고 디스크가 닳지만 아무 오류가 없다. 또는 플러그인을 업데이트했는데 몇 주 동안 옛 앱이 돈다. 둘 다 "조용한 실패 금지"(NFR-2)의 사각지대다 — 실패가 아니라 **아무 말 없는 성공**이다.

**막는 문장** — AD-19에 추가:

> 설치가 기록하는 ref는 `<home>/app-ref` 한 파일이고, 내용은 **40자 소문자 hex commit sha 한 줄과 끝 개행 하나**뿐이다(주석·JSON·시각 금지). `plugin/app-ref`도 같은 형식이고, 비교는 두 파일을 trim한 문자열의 완전 일치다(짧은 sha 금지). 이 파일은 설정이 아니므로 `config.toml`에 넣지 않는다 — 의존성 없는 `bootstrap.js`가 읽고 써야 하기 때문이다(AD-18의 설정 코덱 밖). **쓰는 곳은 bootstrap 하나**이고, 쓰는 시점은 `setup run`이 exit 0으로 끝난 뒤 완료 검증(C-3)을 통과한 **마지막 순간**이다. 실패한 설치는 `app-ref`를 남기지 않으므로 다음 세션이 다시 시도한다. `setup upgrade`도 같은 함수(`readAppRef`/`writeAppRef`)를 쓰며, 그 함수는 `apps/cli`와 `tooling/bootstrap` 양쪽이 복사본으로 갖고 테스트가 두 복사본을 묶는다(`bootstrap.js` 복사본 동기화 테스트와 같은 방식).

---

### C-2. `setup connect claude-code`의 "확인"이 설치를 실패로 만든다 — 두 경로 모두

**쌍:** U-conn(epic 2) × U-plg(epic 2). 코드: `apps/cli/src/commands/setup-connect.ts`, `apps/cli/src/install/flow.ts:243-252`, `packages/core/src/ports/connector.ts`

**각자 AD를 지키는 방식**

- U-conn은 AD-19를 글자 그대로 쓴다: "connector의 `setup.connect`(claude-code)는 **플러그인 설치 여부를 확인·안내하고**, 설치기가 예전에 쓴 Brain 표식 hook을 지운다." 확인 방법이 정의되지 않았으므로 가장 자연스러운 쪽을 고른다: `~/.claude/plugins/` 아래를 훑어 `second-brain` 플러그인을 찾고, 없으면 `ok:false, code:'PLUGIN_NOT_INSTALLED'`로 답한다(Conventions: "stderr만으로 끝내지 않는다", 오류는 코드가 있는 값).
- U-plg는 AD-19의 (a) 경로를 만든다: 플러그인 hook → `bootstrap.js --yes --ref` → `setup run --yes`. `setup run`은 **설치 본문 하나**이므로(AD-2·19) 그 안의 Harness 연결 단계를 그대로 거친다.

**왜 못 붙는가**

1. **현재 코드에서 connect 실패는 설치 실패다.** `flow.ts`의 마지막 줄은 `return report.checks.some(fail) || !connected ? 1 : 0`이고, `connectHarnesses`는 `!result.ok`면 `allConnected = false`로 둔다. 그래서 플러그인이 없는 사람 — **AD-19 (b)가 명시한 공식 경로의 사용자(CI·사람·개발·플러그인 체계 없는 Harness)** — 는 `npx github:…`를 돌릴 때마다 exit 1을 받는다. 설치가 다 됐는데 "실패"다.
2. **플러그인 경로에서는 확인이 순환이다.** 플러그인 설치 정보를 아는 것은 hook 프로세스뿐이다(`${CLAUDE_PLUGIN_ROOT}`). bootstrap과 CLI는 Claude Code가 플러그인을 어디에 어떤 모양으로 풀어 두는지 **알 권리가 없다**(AD-19: "플러그인은 코드 의존 없음. shim 절대 경로만 부른다" — 역방향 지식도 같은 이유로 금지다). U-conn이 `~/.claude/plugins/`의 내부 구조를 읽으면 그 구조는 Claude Code의 사정이고, 다음 버전에서 바뀌면 **설치가 실패로 뒤집힌다**.
3. **포트 계약에 담을 칸이 없다.** `ConnectResult`의 `ok:true` 쪽은 `target`(= "The file the entry lives in")과 `changed`를 요구한다. 파일을 쓰지 않는 connect는 `target`에 넣을 것이 없고, `changed`가 "표식 hook을 지웠다"인지 "플러그인을 확인했다"인지 둘로 갈린다. `flow.ts`는 `changed`로 "connected X in <target>"을 출력하므로 **아무 것도 하지 않은 확인이 "연결했다"로 출력된다**.

**증상.** 빈 Mac에서 플러그인을 켠 첫 세션이 비동기로 설치를 돌리고 exit 1로 끝난다 — 그런데 hook 경로는 항상 exit 0이므로(Conventions) **사용자에게 아무 것도 보이지 않는다.** doctor를 돌리기 전까지 설치가 됐는지 모른다. 반대로 `npx` 경로 사용자는 매번 exit 1을 보고 "설치가 반쪽인가?"를 의심한다. CAP-11 success("빈 Mac에서 설치기 한 번, 또는 플러그인 설치 뒤 첫 세션으로 수집이 시작된다")가 두 경로 모두에서 증명 불가능해진다.

**막는 문장** — AD-19에 추가:

> 플러그인 설치의 진실 출처는 **hook이 넘겨 준 사실 하나**다. 플러그인 `hooks/hooks.json`은 bootstrap을 부를 때 `${CLAUDE_PLUGIN_ROOT}`를 `--plugin-root <경로>`로 넘기고, bootstrap은 설치가 성공한 뒤 그 값을 `<home>/plugin-root` 한 줄로 기록한다. Brain은 Harness의 플러그인 폴더 구조를 알지 않는다(플러그인이 코드를 모르는 것과 같은 이유로, 코드도 플러그인 체계를 모른다). `setup connect claude-code`는 그 파일과 그 경로의 `app-ref` 실존으로만 판정하며, **판정 결과는 어느 쪽이든 `ok: true`**다: 플러그인이 없으면 안내 한 줄과 경고 `PLUGIN_NOT_INSTALLED`를 내고, 그것은 설치 실패가 아니다(AD-19 (b)는 공식 경로다). hook 파일을 쓰지 않는 connect는 `target`에 **지운 표식 hook의 설정 파일 경로**(지운 것이 없으면 확인한 경로)를 담고, `changed`는 "표식 hook을 지웠는가"만 뜻한다. 설치 흐름의 종료 코드는 connect의 경고로 바뀌지 않는다.

---

### C-3. "완료 표식은 shim"이 성립하지 않는다 — 깨진 빌드 위의 shim, 그리고 빌드 중의 동기 hook

**쌍:** U-boot(epic 2) × U-ctx(동기 `context show`, epic 3). 코드: `apps/cli/src/install/shim.ts:42-44,157-186`, `apps/cli/src/install/flow.ts:243-252`, 루트 `package.json`(`build: pnpm -r build`), `apps/cli/package.json`(`build: tsc -p tsconfig.json`, `outDir: dist`)

**각자 AD를 지키는 방식**

- U-boot는 AD-19를 지킨다: "설치 완료 표식은 shim 파일이고 마지막에 원자적으로 쓴다." 지금 코드에서 shim을 쓰는 것은 `setup run`의 `deps.shim.write(home)`이고, `writeShim`은 임시 파일 없이 `writeFile`로 쓰지만 **내용이 같으면 쓰지 않는다**(`changed:false`). bootstrap은 아무 것도 더 하지 않는다 — AD-19는 bootstrap이 shim을 쓴다고 말하지 않았다.
- U-ctx는 AD-6·AD-19를 지킨다: 플러그인 `hooks/hooks.json`의 SessionStart에 **동기** `context show`(짧은 timeout, 읽기 전용)와 **비동기** bootstrap을 함께 등록한다(change §4.1의 바로 그 구성). 동기 hook의 명령은 shim 절대 경로다(AD-19: 플러그인은 shim만 부른다).

**왜 못 붙는가**

1. **shim은 업그레이드에서 변하지 않는다.** `cliEntryPath()`는 `new URL('../bin.js', import.meta.url)`이고, 설치기는 `<home>/app/apps/cli/dist/install.js`에서 돌므로 shim의 `bin`은 항상 `<home>/app/apps/cli/dist/bin.js`다. node 경로도 보통 같다. 그래서 두 번째 설치 이후 shim은 **한 바이트도 바뀌지 않고** `changed:false`를 돌려준다. "마지막에 원자적으로 쓴다"는 첫 설치에만 뜻이 있다.
2. **실패한 설치가 shim을 남긴다.** `flow.ts`의 순서는 설정 → 마이그레이션 → files 루트 → **shim** → connect → doctor → exit다. 마이그레이션이 성공하고 doctor가 fail이면 exit 1인데 shim은 이미 있다. 플러그인 hook은 다음 세션에 "shim이 있다"를 보고 bootstrap을 건너뛴다(`app-ref`가 없다면 C-1의 반대쪽 분기로 매번 돈다 — 어느 쪽이든 틀린다).
3. **빌드는 제자리를 덮는다.** `pnpm -r build`는 `tsc -p`로 각 패키지의 `dist`를 **그 자리에** 다시 쓴다. 위상 순서상 `packages/core` → … → `packages/second_brain` → `apps/cli`이므로, 빌드가 중반일 때 `<home>/app/apps/cli/dist/bin.js`는 **존재하지만** 자기가 import하는 `second_brain`의 dist는 반쯤 쓰인 상태다. `pnpm install --frozen-lockfile`이 `node_modules`의 링크를 다시 거는 구간은 더 나쁘다.
4. **그때 동기 hook이 shim을 부른다.** 결과는 `ERR_MODULE_NOT_FOUND` 또는 구문 오류로 **node가 뜨기 전에 죽는다.** `dispatch.ts`의 hook 보호(`hook` → exit 0, `catch` → stderr 한 줄)는 **프로세스가 떠서 dispatch에 들어와야** 작동한다. 그러므로 Claude Code는 SessionStart hook의 non-zero를 보고, 사용자에게 오류를 띄운다 — NFR-3(Harness 비차단)과 AD-19가 막으려던 "Node 경로가 바뀌어 수집이 조용히 멈추는 것"의 쌍둥이다.

**증상.** `/plugin update` 다음 세션 하나에서 시작 맥락이 사라지고 빨간 hook 오류가 뜬다. 재현이 어렵다(빌드 시간과 세션 시작이 겹쳐야 한다). 두 세션을 동시에 열면 확률이 올라간다 — 그런데 "두 세션 동시 시작"은 epic 2 Done when 6이 **테스트하라고 명시한** 경우다. 테스트는 "bootstrap은 한 번만 돈다"만 보고 이 창은 보지 않는다.

**막는 문장** — AD-19에 추가(둘 다 필요하다):

> **빌드는 쓰이고 있는 트리를 덮지 않는다.** bootstrap은 `<home>/app`에서 ff·install·build를 하되, 완료 검증을 통과한 뒤에만 shim과 `app-ref`를 쓴다. 완료 검증은 "shim 파일이 있다"가 아니라 **"shim이 가리키는 `bin.js`를 실제로 실행해 `brain admin schema --json`이 exit 0으로 답한다"**다. 검증 전에는 shim을 건드리지 않으므로 그동안 옛 빌드가 계속 돈다. 빌드가 끝나기 전에 쓰이는 shim은 언제나 직전에 검증된 빌드를 가리킨다.
>
> **동기 hook은 shim의 실패를 삼킨다.** 플러그인 `hooks/hooks.json`의 모든 명령은 `sh -c '<shim> … || exit 0'` 형태로 감싼다. 프로세스가 뜨지 못하는 실패(빌드 중, 파일 없음, 권한)는 CLI 안의 exit 0 규칙이 닿지 않는 곳에서 일어나므로, hook 경로의 exit 0은 **플러그인 쪽에서도 한 번 더** 보장한다. 이 래핑은 플러그인 hook의 고정부이고 parity 테스트가 모든 hook 항목에 있는지 확인한다.

---

### C-4. 주기 LaunchAgent와 데몬 LaunchAgent가 함께 산다 — 그리고 겹침이 "실패"로 기록된다

**쌍:** U-dmn(epic 9) × U-ops(epic 5). 코드: `packages/sqlite/migrations/0002_files_and_work.sql`(`work_items`, `document_extractions_open_idx`)

**각자 AD를 지키는 방식**

- U-ops는 AD-25를 지킨다: "설치기가 고정 Label(`…second-brain.drain`)의 LaunchAgent 하나를 등록한다. **같은 Label이면 다시 등록하지 않는다.**" epic 5는 데몬을 모르므로(epic 9는 그 뒤다) `setup run`·`setup upgrade`가 이 Label을 멱등하게 보장한다.
- U-dmn은 AD-25·AD-27을 지킨다: "데몬을 켜면 데몬의 drain 루프가 같은 일을 하고 주기 LaunchAgent는 등록하지 않는다(있으면 지운다)." 그래서 `setup run --daemon`이 KeepAlive Label을 등록하고 주기 Label을 지운다.

**왜 못 붙는가**

- **"등록하지 않는다(있으면 지운다)"는 한 번만 참이다.** 데몬을 켠 뒤의 `setup upgrade`는 AD-20의 순서를 따르는데 그 순서에 "주기 LaunchAgent를 다시 보지 않는다"가 없다. 그리고 AD-19·AD-2는 "설치 본문은 하나(`setup run`)"이므로 upgrade가 `setup run`의 흐름을 재사용하는 것이 **정답**이다. 재사용하면 U-ops의 멱등 등록이 주기 Label을 **되살린다.**
- 플러그인 경로는 더 확실하다. 플러그인 hook은 `bootstrap.js --yes --ref`를 부르고 bootstrap은 `setup run --yes`를 부른다. `--daemon`을 전달할 자리가 없다(플러그인은 사용자의 데몬 선택을 모른다). **데몬 사용자의 모든 플러그인 업데이트가 주기 LaunchAgent를 되살린다.**
- "데몬을 켰다"를 적는 곳도 없다. AD-18의 설정 키 목록은 `[store] path`·`[mirror] path`·`[files] path`·(epic 7)`[[replicas]]`뿐이다. `setup upgrade`의 "데몬이 있으면 재시작"은 무엇을 보고 "있다"고 판정하는가 — launchctl 조회? 소켓? pid 파일? 셋이 서로 다른 답을 줄 수 있다(소켓 파일이 남은 죽은 데몬).
- **"AD-21로 막히는가?" — 절반만 막힌다.** 같은 `work_items` 행을 둘이 처리하는 것은 짧은 쓰기 트랜잭션의 청구가 막는다. 그러나 **추출 일감**은 다르다: 0002의 `document_extractions_open_idx`가 `(file_id, extractor_version) where finished_at is null`에 UNIQUE이므로, 늦게 들어온 워커의 INSERT가 거부된다. AD-21은 그것을 "처리 실패"로 보고 `attempts`를 올린다 → 지수 백오프 → **10번이면 `failures`에 기록하고 멈춘다.** 즉 겹침은 중복을 만들지 않는 대신 **정상 일감을 영구 실패로 분류한다.** 증상은 "문서 검색에 안 나오는 파일"이고 doctor는 failures 건수만 보인다.

**막는 문장** — AD-25에 추가:

> 주기 실행의 주인은 설정 한 줄(`[daemon] enabled`, 기본 false)이고, LaunchAgent 등록은 그 값을 읽는 함수 하나가 한다. 그 함수는 "없으면 더하기"가 아니라 **"두 Label의 적재 상태를 설정과 일치시키기"**다: 켜짐이면 KeepAlive Label만 적재하고 주기 Label을 `bootout`하며, 꺼짐이면 그 반대다. `setup run`·`setup upgrade`·`daemon run`·플러그인 bootstrap 경로 중 어느 쪽으로 들어와도 같은 함수를 부르므로, 플래그를 전달하지 못하는 경로가 상태를 되살릴 수 없다. "데몬이 있는가"의 판정도 이 설정값 하나이고, 소켓·pid·launchctl 조회는 판정이 아니라 진단이다. doctor는 두 Label이 동시에 적재된 것을 `fail`로 본다.

**막는 문장** — AD-21에 추가:

> 한 일감은 한 번에 한 워커만 처리한다. **청구를 놓친 것은 실패가 아니다**: `attempts`는 처리에 들어간 워커만 올리고, 다른 워커가 이미 들고 있어 시작조차 못 한 경우는 `next_attempt_at`만 미룬다(`attempts` 불변, `last_error` 불변). 추출처럼 DB 제약(열린 세대 UNIQUE)으로 거부될 수 있는 일감은 그 거부를 "이미 진행 중"으로 읽고 같은 규칙을 적용한다. `failures`에 가는 것은 **처리한 뒤 실패한 10번**뿐이다.

---

### C-5. `locator`의 정규형과 `page`의 진실 출처가 없다 — 그리고 `locator`가 두 가지 뜻이다

**쌍:** U-ext(추출 일감, epic 2 + 0003) × U-doc(문서 검색, epic 4). 코드: `packages/sqlite/migrations/0002_files_and_work.sql`(`document_chunks.page`, `file_locations` UNIQUE `(file_id, store_kind, locator)`)

**각자 AD를 지키는 방식**

- U-ext는 AD-24를 지킨다: "조각마다 `locator`(JSON; 종류별 필드: pdf 쪽·영역 `page`·`bbox` / docx 블록 `block` / text 글자 범위 `start`·`end` / …)를 둔다." D4가 "`page`는 유지"로 확정했으므로 pdf 조각에 `page = 7`과 `locator = {"bbox":[...],"page":7,"type":"pdf"}`를 **둘 다** 쓴다. JSON은 `JSON.stringify(obj)`를 그대로 쓴다(키 순서는 객체 리터럴 순서이고 구현마다 다르다). docx 조각은 `page`를 null로 둔다.
- U-doc은 AD-15의 결과 계약을 지킨다: "문서는 `file_id`, 표시 이름, 조각 위치(`locator`: `{type, page, bbox, block, start, end, …}` 중 종류에 맞는 필드), 그때 만든 URL …". 그래서 결과의 `locator`를 DB의 `locator` 컬럼에서 읽어 **그대로** 싣고, 사람용 출력의 "7쪽"은 `page` 컬럼에서 읽는다(인덱스가 있는 쪽이 싸다).

**왜 못 붙는가**

1. **정규형이 없으면 같은 조각을 두 번 만들어도 바이트가 다르다.** AD-8은 모든 테이블에 자연 멱등 키를 요구하고 AD-24는 재추출을 "새 세대 → 포인터 교체"로 두지만, `locator`가 비교·중복 판정에 쓰이는 순간(미러 재생성, 내보내기 diff, 조각 동일성 테스트) 키 순서와 null 생략 여부가 결과를 바꾼다. "같은 배치를 두 번 넣으면 건수가 같다"(AD-8 계약 테스트)의 문서 판본이 성립하지 않는다.
2. **`page`와 `locator.page`의 진실 출처가 없다.** 0002는 `page`를 먼저 만들었고 0003이 `locator`를 더한다. 0002 이전에 들어간 행(테스트 fixture, 복구한 내보내기)은 `page`만 있고 `locator`는 null이다. U-doc은 `locator`가 null인 행에서 **위치 없는 결과**를 내고, U-ext는 자기 테스트(갓 추출한 행)에서는 언제나 둘 다 채우므로 통과한다. 반대 방향도 있다: `files.redact`가 조각을 지우고 재추출이 `locator`만 갱신하는 구현이면 `page`가 묵는다.
3. **`locator`라는 이름이 두 가지다.** `file_locations.locator`는 0002의 주석대로 "저장소 루트 아래의 **상대 경로 문자열**"이고 UNIQUE 키의 일부다. `document_chunks.locator`는 **문서 안 위치 JSON**이다. AD-23과 AD-24가 같은 단어를 쓰고, AD-15의 결과 계약은 그 중 하나만 가리킨다. 두 단위가 "`locator` 코덱"을 각자 만들면 한쪽을 다른 쪽에 넘기는 버그가 타입으로 걸리지 않는다(둘 다 TEXT).
4. **text 문서의 `start`/`end` 단위가 정해지지 않았다.** Conventions의 "위치는 코드 포인트 `[start, end)`"는 텍스트 행(비교·대조, AD-14의 인용 대조)에 있다. U-ext는 `pdfjs`·`mammoth`가 돌려준 JS 문자열을 `slice`로 자르므로 **UTF-16 code unit**을 자연스럽게 쓴다. U-doc의 `recall.expand`가 코드 포인트로 다시 계산하면 BMP 밖 글자(이모지, 일부 한자)가 든 문서에서 경계가 밀리고, 두 단위의 테스트는 각각 통과한다.

**막는 문장** — AD-24에 추가:

> `locator`의 정규형은 Core의 코덱 하나가 만든다: `type`을 첫 키로 두고 그 종류에 쓰이는 필드만 **정해진 순서로**, null·undefined는 생략하며, 공백 없는 JSON이다(`{"type":"pdf","page":7,"bbox":[…]}`). 같은 조각을 두 번 만들면 바이트가 같아야 한다(계약 테스트). **진실은 `locator`다**: `document_chunks.page`는 그 코덱이 함께 쓰는 읽기 전용 사본이고 인덱스·정렬에만 쓰며, 출력·`recall.expand`·미러는 `locator`만 읽는다. `locator`가 null인 행은 검색 대상이 아니다(0003이 기존 행을 채우거나 그 세대를 다시 만든다). 문서 조각의 `start`·`end`도 저장된 추출 텍스트 위의 **코드 포인트** 반열린 구간이다(AD-14와 같은 단위). code unit ↔ 코드 포인트 변환은 그 코덱 한 곳에서만 하고, 계약 테스트에 BMP 밖 글자가 든 문서를 넣는다.

**막는 문장** — AD-23·AD-24·Table Contract에 추가(이름 분리):

> 위치를 가리키는 두 값은 이름을 달리한다: 저장소 안의 위치 문자열은 `file_locations.locator`(그대로), 문서 안 조각의 위치 JSON은 `document_chunks.chunk_locator`다. 코덱도 둘이고, 한쪽 코덱을 다른 쪽 값에 쓰는 것은 금지다. AD-15의 결과 계약과 `recall docs` 출력 필드 이름도 `chunk_locator`를 쓴다.

---

### C-6. 데몬이 켜지면 "기회적 drain"이 동기 시작 맥락을 다시 쓰기 경로로 만든다 — 닫은 결정의 재발

**쌍:** U-cli(dispatcher의 기회적 drain, epic 2) × U-ctx(동기 `context show`, epic 3), 그리고 U-dmn(데몬 drain 루프, epic 9). 코드: `apps/cli/src/dispatch.ts`(주석: "The one path every command takes … Adding a command means adding a spec to the registry — never repeating any of the above, because a rule repeated thirty times is a rule that will be forgotten once")

**각자 AD를 지키는 방식**

- U-cli는 AD-7의 마지막 문장을 글자 그대로 쓴다: "hook이 없는 Harness를 위해 **모든 명령**은 끝에 짧은 시간 예산으로 drain을 한 번 기회적으로 돈다." 그리고 dispatcher의 설계 철학("규칙은 한 곳에, 잊을 수 없는 곳에")대로 `execute()`의 `finally` 근처에 넣는다. 기회적 drain은 `work_items` 청구를 하므로 **`BEGIN IMMEDIATE` 쓰기 트랜잭션**이다(AD-7·AD-21).
- U-ctx는 AD-6을 글자 그대로 쓴다: "동기 경로(시작 hook)에는 네트워크 호출이 없고, **쓰기 트랜잭션도 없다**(읽기 전용). … DB 단위 쓰기 잠금(AD-7)이 시작 맥락을 막지 않게 하기 위해서다." 그래서 `context.show`를 읽기 전용으로 만들고, 주입 시도 기록은 spool에 쓴다.

**왜 못 붙는가**

- `context show`는 명령이다. AD-7의 "모든 명령"과 AD-6의 "동기 경로는 쓰기 트랜잭션 없음"이 **같은 호출에 대해 반대를 말한다.** dispatcher에 넣으면(U-cli의 선택이 옳다 — 거기 말고 어디에 넣겠는가) 동기 시작 hook이 매 세션 쓰기 잠금을 다툰다. 2026-10-14 리뷰 C-1이 바로 이 문제였고, AD-6의 "읽기 전용"은 그 결론이다. 새 문장(AD-7의 기회적 drain)이 그것을 **조용히 되돌린다.**
- 데몬이 켜지면 더 나쁘다. U-dmn의 drain 루프는 쉬지 않고 돌며(AD-27: "데몬은 drain 루프와 transcript watcher를 돈다" — 듀티 사이클·유휴 백오프 규정 없음) 잠금을 자주 잡는다. 그 위에 모든 CLI 명령·모든 hook이 끝에서 청구 트랜잭션을 한 번 더 시도한다. 할 일이 없을 때도 **빈 청구 쓰기**를 한다. AD-25가 "주기 실행 둘이 겹치는 것"을 막았는데 **기회적 drain은 세 번째 주기 실행**이고 아무도 그것을 끄지 않는다.
- AD-7은 기회적 drain의 이유를 "hook이 없는 Harness를 위해"라고 적었다. 그런데 2026-10-15 결정으로 당분간 대상 Harness는 Claude Code 하나이고 **hook이 있다**(플러그인). 즉 이유가 사라진 경로가 모든 명령의 꼬리에 달려 있다.

**증상.** 세션 시작이 느려지고(잠금 대기 ~ `busy_timeout.turn` 3초) 간헐적으로 시작 맥락 대신 "DB를 읽을 수 없음"이 뜬다 — AD-9가 그것을 사용자에게 보이게 해 두었으므로 **평시 동작이 경고로 보인다.** 원인은 재현 조건(데몬 + 긴 추출 배치 + 세션 시작)이 겹쳐야 드러난다.

**막는 문장** — AD-7에 추가:

> 기회적 drain에는 세 가지 제한이 있다. (1) **동기 hook 경로와 턴 수집 hook은 기회적 drain을 하지 않는다**(AD-6의 읽기 전용·지연 예산). 명령 메타의 `hookSafe`와 무관하게, 실제 호출이 hook 경로인지로 판정한다. (2) **데몬이 켜져 있으면(설정 `[daemon] enabled`) 어떤 명령도 기회적 drain을 하지 않는다** — 주기 실행의 주인은 하나라는 AD-25의 규칙은 기회적 drain에도 적용된다. (3) 남은 경로에서도 청구할 일감이 있는지를 **읽기로 먼저 확인**하고, 있을 때만 쓰기 트랜잭션에 들어간다(빈 청구 쓰기 금지). 데몬의 drain 루프도 유휴에서는 쓰기를 하지 않고 다음 주기까지 쉰다(유휴 간격은 일감 종류별 Core 상수와 같은 자리에 둔다).

---

## High

### H-1. 응답 봉투의 주인이 CLI다 — 데몬·MCP는 베끼거나 CLI를 import한다

**쌍:** U-dmn·U-mcp(epic 9) × U-cli(epic 2). 코드: `apps/cli/src/envelope.ts`

- AD-26: "응답은 CLI `--json`과 같은 엔벨로프다(Conventions)." AD-28: "MCP 도구 결과는 CLI와 같은 엔벨로프를 `content`에 담는다." Conventions의 행 이름도 "CLI `--json` 응답"이다.
- 동시에 AD-5: "**어느 표면도 다른 표면의 표현을 만들지 않는다.**" 그리고 층 표에서 `apps/cli`는 Runtime이고 데몬·MCP도 그 안이지만(Structural Seed: "epic 9: daemon·mcp 하위 명령"), 봉투를 만드는 함수는 `okEnvelope`/`errorEnvelope`라는 **CLI 모듈의 내부**다.
- U-dmn이 그 함수를 부르면 `now`가 `isoWithOffset(clock.now())` — **프로세스 로컬 오프셋**이다. 데몬은 몇 주를 산다. 시간대 변경·DST 경계를 넘으면 오프셋이 묵고, Conventions("오프셋을 포함한 ISO-8601은 CLI `--json` 응답에만 쓴다")가 뜻하는 바가 소켓 응답에서 무엇인지 아무도 정하지 않았다.
- 베끼면 `error.exit_code`가 소켓·MCP 응답에 들어가 **프로세스 종료 코드가 없는 표면에 종료 코드**가 실린다. U-mcp는 그것을 보고 `isError`를 정할 수도 있다(M-2 참조).

**막는 문장** — Conventions의 봉투 행과 AD-5에:

> 응답 봉투는 표면의 것이 아니라 **Runtime의 봉투 코덱 하나**가 만든다(`apps/cli/src/envelope.ts`를 표면 중립 모듈로 옮기고 이름을 "CLI `--json` 응답"에서 "응답 봉투"로 바꾼다). CLI `--json`·소켓·MCP가 같은 함수를 부르고, `now`는 응답마다 `Clock`에서 새로 만든다(프로세스 시작 시각이나 캐시한 오프셋 금지). `error.exit_code`는 봉투의 고정 필드이며 뜻은 "이 결과를 CLI가 냈다면 그 종료 코드"다 — 소켓·MCP는 그 값을 프로세스 종료 코드로 쓰지 않고, 그 값으로 성공·실패를 다시 판정하지 않는다(판정은 `ok`다).

### H-2. `VERSION_MISMATCH`가 오류인가 전환 신호인가 — 그리고 handshake의 모양이 없다

**쌍:** U-dmn(epic 9) × U-cli(hook 클라이언트, epic 2). 코드: `apps/cli/src/dispatch.ts:237-241`

- Conventions는 `VERSION_MISMATCH`를 **오류 코드** 목록에 넣었다. AD-26·AD-27은 "클라이언트는 프로세스 안 경로로 처리한다"고 한다 — 클라이언트에게 그것은 실패가 아니라 **경로 변경**이다.
- U-dmn은 `ok:false` 봉투를 보낸다(오류 코드니까). U-cli의 hook 경로는 `dispatch.ts`의 규칙대로 "오류가 있으면 stderr 한 줄 + exit 0"을 한다. 결과: 업그레이드 뒤 첫 턴마다 `VERSION_MISMATCH: …`가 stderr로 흐르는데 **처리는 성공한다.** NFR-2의 뒤집힌 형태(조용한 실패가 아니라 시끄러운 성공)이고, "stderr ≠ 실패"를 README에 적기로 한 것과 정확히 반대 방향의 혼선을 만든다.
- handshake의 모양도 없다. AD-26은 요청을 `{ns, verb, args, session?}`로 고정했는데 "연결의 첫 메시지는 빌드 버전 handshake"는 그 모양이 아니다. U-dmn은 `{hello:{build}}`를, U-cli는 첫 요청에 `build`를 끼워 보낸다 → 첫 연결이 서로를 이해하지 못하고, 잘못된 쪽이 "데몬 없음"으로 폴백한다(동작은 한다 — 그래서 소켓이 영원히 쓰이지 않는 것을 아무도 모른다).

**막는 문장** — AD-26에:

> handshake는 요청과 **같은 모양의 한 번의 호출**이다: `{ns:'admin', verb:'handshake', args:{build}}`. 빌드가 다르면 데몬은 `ok:false`, `error.code = VERSION_MISMATCH`로 답하고 그 연결을 닫은 뒤 재시작 신호를 남긴다. 클라이언트에게 `VERSION_MISMATCH`는 **사용자·에이전트에게 보이지 않는 전환 신호**다: 같은 요청을 프로세스 안 경로로 처리하고, 그 결과 봉투의 `warnings[]`에 `DAEMON_BYPASSED`를 넣는다. `VERSION_MISMATCH`를 stdout·stderr·`systemMessage`에 그대로 싣지 않는다. doctor가 `DAEMON_BYPASSED`의 최근 발생을 보인다.

### H-3. 세션 토큰의 출처가 세 표면에 세 개다 — 우선순위가 없다

**쌍:** U-mcp × U-dmn × U-cli

- AD-28: MCP 쓰기 verb는 `session` **인자** 필수(`SESSION_REQUIRED`). AD-26: 소켓 요청의 `session?`은 `args` **밖의 선택 필드**. AD-4: CLI는 환경 변수 `BRAIN_SESSION`, 또는 시작 맥락 문장의 키를 `--session`으로.
- AD-5는 "SDK 메서드는 CLI·MCP와 **같은 입출력 형태를 1:1로** 갖는다"고 한다. 그러면 `session`은 SDK 인자인가 전송 봉투의 필드인가? U-mcp는 명령 메타에서 스키마를 만들어야 하므로 `args.session`으로 둔다(그래야 `required`에 들어간다). U-dmn은 AD-26의 글자대로 봉투 필드로 받고, "요청의 `session`이 있으면 `args`의 것을 채운다"로 구현한다 — 또는 그 반대로.
- 우선순위가 없으므로 한 표면에서 **env의 묵은 세션이 명시 인자를 덮는** 방향이 생긴다. `log.append`가 엉뚱한 세션에 붙으면 AD-12(꼬리표)·AD-14(anchor)가 조용히 깨지고, 그 로그는 영원히 잘못된 세션에 남는다(`session_id` 불변, Table Contract).

**막는 문장** — AD-5(또는 AD-28)에:

> 세션 토큰은 **SDK 인자 하나**다(`args.session`, `harness:harness_session_id`). 표면은 그 인자를 채우는 방법만 다르다: CLI는 `--session`, 없으면 `BRAIN_SESSION`; MCP는 도구 인자; 소켓은 요청의 `session`. 우선순위는 어느 표면에서나 "명시 인자 > 표면이 들고 있는 값"이고, **둘이 다르면 조용히 덮지 않고 오류 `SESSION_CONFLICT`**다. 쓰기 verb는 채운 뒤에도 비어 있으면 `SESSION_REQUIRED`이며 이 규칙은 CLI에도 같다(CLI만 관대할 이유가 없다). AD-26의 `session?`은 `args.session`의 전송 자리일 뿐 두 번째 출처가 아니다.

### H-4. `args`가 argv 배열인가 SDK 객체인가 — `retry_argv` 변환이 둘로 갈린다

**쌍:** U-dmn(epic 9) × U-cli(epic 2). 코드: `apps/cli/src/dispatch.ts:47-54`(`options`와 `args`가 **두 칸**)

- AD-26의 요청은 `{ns, verb, args, session?}`이고, AD-5의 표면 중립은 "다음 단계·재시도·확인 요청은 SDK가 `{ns, verb, args}`와 코드로 돌려주고, **CLI가 `retry_argv`**·종료 코드로 … 바꾼다"고 한다. 즉 `args`는 argv가 아니라는 암시가 있다 — 그런데 명시되지 않았다.
- U-dmn에게 가장 싼 구현은 argv 배열이다: shim의 hook 클라이언트가 받은 `process.argv.slice(2)`를 그대로 소켓에 넣으면 끝이고, 데몬은 그것을 `dispatch(registry, argv, …)`에 그대로 먹인다(현재 코드가 정확히 그 모양이다). U-mcp는 객체여야 한다(스키마 생성). 둘 다 AD-26·AD-28을 지킨다.
- 그러면 `error.retry{ns,verb,args}`의 `args`가 표면마다 다른 타입이 되고, `retry_argv` 변환이 두 개 생긴다. 현재 dispatcher는 위치 인자(`args`)와 flag(`options`)를 **따로** 들고 있으므로 "SDK 인자 객체"로의 변환 자체가 아직 없다.

**막는 문장** — AD-5와 AD-26에:

> `args`는 어느 표면에서나 **SDK 인자 객체 하나**다(argv 배열이 아니다). 키는 명령 메타의 `required`·옵션 이름을 `camelCase`로 쓴 것이고, 위치 인자도 이름을 갖는다. CLI는 argv ↔ 인자 객체 변환을 **명령 메타에서 생성**하고(`retry_argv`는 그 역변환), 소켓·MCP는 객체를 그대로 보낸다. 변환이 왕복하는지(`argv → args → argv`)를 메타마다 테스트가 확인한다.

### H-5. 종료 코드 3이 `setup run`에 적용되는가 — 지금 코드는 2이고, `hookSafe`와 `hook`은 다른 뜻이다

**쌍:** U-cli(epic 2) × U-ops(epic 5). 코드: `apps/cli/src/dispatch.ts:37`(`ExitCode = 0|1|2`), `apps/cli/src/install/flow.ts:182-185`(비TTY + `--yes` 없음 → **2**), `apps/cli/src/commands/setup-run.ts`(exit 2를 오류 봉투로)

- Conventions 신설: "3 확인 필요(비TTY·`--json`에서 `--yes` 없는 **파괴적 명령**)". `setup run`은 마이그레이션을 돌리므로 메타의 `risk`가 `write`인가 `destructive`인가? 정해지지 않았다.
- U-cli는 "`risk: destructive` + `--yes` 없음 → 3"을 dispatcher에 넣는다. `setup run`은 standalone이라 dispatcher의 그 분기를 안 지나고 자기 코드로 2를 돌려준다. **README의 종료 코드 표와 코드의 양방향 대조 테스트**(change §4.1 Done when 9)는 둘이 어긋난 것만 알려 주고 **어느 쪽이 맞는지는 알려 주지 않는다.** U-ops의 업그레이드 테스트는 둘 중 하나를 고정한다.
- 별개로 이름 충돌이 있다. 메타의 `hookSafe`(선언: "이 명령을 hook에서 불러도 되는가")와 dispatcher의 `hook`(사실: "이 호출은 hook 경로다 → exit 0")은 다른 것인데 단어가 비슷하다. 그리고 **hook 경로에서 `CONFIRMATION_REQUIRED`가 나면** exit는 0이 되므로 에이전트가 "성공"으로 읽는다. 지금은 플러그인 hook이 `context show`·`sessions ingest`만 부르니 안 걸리지만, epic 3의 스킬이 `/brain:*`에서 파괴적 명령을 부르면 걸린다.

**막는 문장** — Conventions의 종료 코드 행에:

> `risk: destructive`이고 `--yes`가 없는 비대화형 호출은 종료 코드 **3**이며 `setup run`도 예외가 아니다(지금 코드의 2를 3으로 바꾼다). 2는 "실행 불가"에만 쓴다: 사용법 오류, 설정 없음, DB 없음. 메타의 `hookSafe`는 **선언**("이 명령을 hook 경로에서 불러도 되는가")이고, 종료 코드를 0으로 접는 것은 **사실**(이 호출이 hook 경로인가)이 정한다. 두 개념은 이름이 다르고, `hookSafe: false`인 명령을 hook 경로에서 부르는 것은 테스트가 잡는 버그다. hook 경로에서 `CONFIRMATION_REQUIRED`가 나오면 exit는 0이지만 **봉투는 `ok:false`를 유지**하고 확인 요청을 `systemMessage`에 싣는다 — 0을 성공으로 읽히게 두지 않는다.

### H-6. 설치 잠금과 데몬 단일 인스턴스 잠금이 같은 문제를 두 번 푼다 — pid 재사용에 둘 다 틀린다

**쌍:** U-boot(epic 2) × U-dmn(epic 9)

- AD-19: "설치 잠금(`~/.second_brain/install.lock`, 원자적 mkdir, 안에 pid·시각; **pid가 죽었거나 오래되면 회수**; 잠금이 있으면 '설치 진행 중'으로 exit 0)". AD-27: "**단일 인스턴스 잠금**"(방식 미정).
- 두 단위가 같은 문제(죽은 소유자의 잠금 회수)를 각자 푼다. pid 생존 판정은 **pid 재사용**에 틀린다: 첫 bootstrap이 OOM으로 죽고 그 pid가 Claude Code의 다른 프로세스에 재사용되면, 두 번째 세션은 "pid가 살아 있다"를 보고 영원히 exit 0으로 끝난다 → **설치가 조용히 안 된다.** epic 2 Done when 6이 테스트하라고 한 "세션 둘 동시 시작"의 실패 모드가 바로 이것이다.
- "오래되면"의 값도 없다. ff+build는 몇 분이 걸릴 수 있어 짧으면 겹친 clone·install이 되고(`pnpm install`을 둘이 돌리면 `node_modules`가 깨진다), 길면 영구 교착이다.

**막는 문장** — AD-19와 AD-27에 공통으로:

> 잠금은 하나의 규칙을 쓴다: `mkdir`로 만든 디렉터리 안의 `owner.json`(pid, 시작 시각 정규형, **기계 부팅 시각**, 쓰려는 ref)과, 소유자가 ≤30초마다 갱신하는 `heartbeat` 한 줄. 회수 판정은 pid 생존이 아니라 **heartbeat가 상한(기본 90초)보다 묵은 것**이고, 부팅 시각이 다르면 즉시 회수한다(pid 재사용을 믿지 않는다). 설치 잠금과 데몬 단일 인스턴스 잠금은 **같은 함수·같은 판정**을 쓰고 경로만 다르다(`<home>/install.lock`, `<home>/run/daemon.lock`). 잠금을 만나 물러난 bootstrap은 exit 0으로 끝내되 그 사실을 spool에 한 줄 남기고, doctor가 "설치가 N분째 진행 중"과 "회수한 잠금"을 보인다.

### H-7. 데몬 heartbeat와 "마지막 주기 실행 시각"을 적을 자리가 Table Contract에 없다

**쌍:** U-ops(epic 5) × U-dmn(epic 9)

- AD-25: "drain은 **마지막 주기 실행 시각을 남기고**, doctor는 그것이 간격의 3배보다 오래되면 경고한다." AD-27: "doctor는 데몬 생존·소켓 응답·버전 일치·**마지막 heartbeat**를 보이고". Table Contract에 둘 다 없고, 단일 행 상태 테이블은 `schema_version`뿐이다.
- U-ops는 DB에 못 쓸 때의 규칙(AD-9)이 애매하므로 `<home>/run/last-drain` 파일에 쓴다. U-dmn은 새 테이블 `daemon_state`를 만든다(0004). 이제 doctor가 두 곳을 읽고, **데몬이 DB에 못 쓰는 상황**(AD-27이 명시적으로 다루는 상황: "DB에 쓸 수 없으면 같은 spool 형식을 쓴다")에서 heartbeat가 멈춰 "데몬이 죽었다"고 **오진**한다. heartbeat를 DB에 쓰면 몇 초마다 쓰기 잠금을 다퉈 C-6과 같은 문제를 만든다.

**막는 문장** — AD-25·AD-27과 Table Contract에:

> 주기 실행 시각과 데몬 생존 표시는 **DB가 아니라 `<home>/run/`의 상태 파일**에 쓴다(한 줄 JSON, 임시 파일 → rename, `{at, pid, build, ref}`). 생존 표시는 파생물이므로 내보내기·복구에 넣지 않고, 몇 초마다 쓰기 잠금을 다투는 것이 금지이기 때문이다(AD-7). 파일은 `last-drain`과 `daemon-heartbeat` 둘이고 각각 쓰는 함수가 하나다. doctor는 이 두 파일만 읽는다. Table Contract에는 들어가지 않는다(DB 테이블이 아니다).

### H-8. `source_unreachable`을 적을 컬럼이 없다 — 복구 직후 `failures`가 가득 찬다

**쌍:** U-ext(epic 2) × U-drn(epic 2·5) × U-doc(epic 4). 코드: 0002의 `document_extractions_status_check`(`'ok','failed','unsupported','too_large','redacted'`)

- AD-24: "원본에 접근할 수 없는 파일(복구 직후, 연동 해제)은 `source_unreachable`로 **표시**하고 기존 조각은 계속 검색된다. 결과에 경고 `FILE_SOURCE_UNREACHABLE`를 붙이고 **재추출 일감은 만들지 않는다**." 그런데 그런 상태값이 CHECK에 없고, 어느 테이블·어느 컬럼인지도 없다.
- U-ext는 가장 자연스러운 쪽을 고른다: `status='failed', failed_stage='read'`. 그러면 U-drn은 AD-21대로 재시도한다(지수 백오프, 10번, 그 뒤 `failures`). **복구 직후에는 모든 파일이 접근 불가**이므로 파일 수 × 10번의 실패가 쌓이고 `failures`가 가득 찬다. AD-24가 "재추출 일감은 만들지 않는다"고 한 이유가 정확히 그것인데, 표시할 자리가 없어서 막을 수 없다.
- U-doc도 읽을 것이 없다. 그 파일의 `current_extraction_id`는 **성공한 옛 세대**를 가리키고 실패한 새 세대는 포인터 밖이다. 그래서 `FILE_SOURCE_UNREACHABLE`을 붙이려면 매 검색마다 파일시스템을 찔러야 한다(검색 경로에 I/O — NFR-7과 AD-7의 정신에 반한다).
- 겸해서 `failed_stage`와 `unsupported`·`too_large`·`redacted`의 관계도 비어 있다. U-ext가 `status='too_large', failed_stage='read'`를 쓰면 doctor·`sessions failures`의 집계가 두 번 센다.

**막는 문장** — AD-24와 Table Contract에:

> 원본 접근 불가는 추출의 실패가 아니라 **파일의 상태**다: `files.source_unreachable_at`(정규형 시각, 접근에 성공하면 null로 돌아간다)에 쓴다. 그 값이 있는 파일에는 재추출 일감을 만들지 않고 기존 일감은 취소한다(AD-21의 재시도 대상이 아니다). 검색은 조각을 돌려주면서 이 컬럼 하나만 읽어 `FILE_SOURCE_UNREACHABLE`을 붙이며, **검색 경로는 파일시스템을 찌르지 않는다**. `failed_stage`는 `status = 'failed'`일 때만 채운다(CHECK로 고정, 다른 상태에서는 null). `unsupported`·`too_large`·`redacted`는 실패가 아니라 종착 상태이고 재시도 일감을 만들지 않는다.

### H-9. `attempt`의 배정 주체가 없다 — 두 extractor_version이 같은 번호를 받는다

**쌍:** U-ext(epic 2) × U-drn(epic 2·5). 코드: 0002의 `document_extractions_open_idx`(`(file_id, extractor_version) where finished_at is null`)

- AD-24: "파일당 단조 증가하는 `attempt`" + "포인터 전환은 현재 세대보다 `attempt`가 큰 세대만 할 수 있다(늦게 끝난 옛 시도가 덮어쓰지 못한다)." 배정 주체가 없다 — AD-8은 `seq`에 대해서만 "원본 Store가 삽입 트랜잭션 안에서 배정한다"고 못 박았다.
- 열린 세대 UNIQUE가 `extractor_version`을 포함하므로 **버전이 다르면 두 세대가 동시에 열린다**(라이브러리를 올린 직후가 정확히 그 순간이다). 둘이 각자 `max(attempt)+1`을 읽으면 같은 번호가 되고, `(file_id, attempt)`에 UNIQUE가 없어서 그대로 들어간다. 그러면 "더 큰 attempt만 전환"이 **동점을 가르지 못하고** 늦게 끝난 쪽이 이긴다 — AD-24가 막으려던 바로 그 일이다.

**막는 문장** — AD-8·AD-24와 Table Contract에:

> `attempt`는 `seq`와 **같은 규칙**으로 배정한다: 원본 Store가 세대 행을 삽입하는 트랜잭션 안에서 파일당 1부터 구멍 없이 매긴다. `(file_id, attempt)`는 UNIQUE다. 열린 세대는 `extractor_version`과 무관하게 **파일당 하나**이므로 열린 세대 UNIQUE 키를 `(file_id)`로 좁힌다(0002의 `document_extractions_open_idx`를 0003이 바꾼다).

---

## Medium

### M-1. `error.retry`와 `meta.next`가 같은 모양에 두 이름이다

Conventions: `error.retry{ns,verb,args}`와 `meta.next{ns,verb,args}`. U-cli는 확인 필요에 `retry`를, U-doc은 잘림에 `next`를 쓴다. 에이전트는 둘 다 "다음에 부를 것"으로 읽는데, 금지 행동 목록은 "`retry`를 그대로 실행"만 금지한다 → **`next`는 그대로 실행해도 된다**는 뜻이 된다. 그 해석이 맞다면 그렇게 적어야 하고, 틀리다면 `next`에도 금지가 필요하다.

**막는 문장(Conventions):** "`retry`와 `next`는 모양이 같고 뜻이 다르다. `error.retry`는 **사람의 동의가 필요한 같은 요청의 재시도**이고 에이전트가 그대로 실행하면 안 된다. `meta.next`는 **같은 결과를 더 보는 읽기 호출**이고 에이전트가 그대로 실행해도 된다 — 그래서 `meta.next`에는 `risk: read`인 verb만 들어갈 수 있다. 한 응답에 둘이 함께 오지 않는다."

### M-2. `CONFIRMATION_REQUIRED`일 때 `ok`는 무엇인가 — MCP에서 오류로 보이면 에이전트가 우회한다

`error`가 있으면 `ok:false`다(`envelope.ts`). "확인 필요"는 실패가 아니라 대기인데, U-mcp가 그것을 MCP 도구 오류(`isError`)로 표시하면 Claude Code는 도구 실패로 보고 다른 수단을 찾는다 — 금지 행동 "덜 파괴적 동사로 우회"를 **규약이 유도한다.**

**막는 문장(Conventions·AD-28):** "`CONFIRMATION_REQUIRED`는 `ok:false`, `error.exit_code = 3`이다(실행되지 않았으므로 성공이 아니다). 단 MCP에서는 **도구 오류로 표시하지 않고** 정상 결과 안의 봉투로 돌려준다: 도구가 실패한 것이 아니라 사람의 확인을 기다리는 것이고, 오류로 보이면 에이전트가 우회를 시도한다."

### M-3. `risk`와 `dryRun`의 관계가 없다

`risk: destructive` + `dryRun: true`인 명령에서 `--dry-run`은 확인 게이트를 받는가? U-cli는 "쓰지 않으니 3을 내지 않는다", U-ops는 "`setup upgrade --dry-run`도 코드를 당기니 확인 필요"로 간다.

**막는 문장(Conventions 명령 메타 행):** "`--dry-run`은 아무 것도 바꾸지 않는 실행이고 확인 게이트를 받지 않는다(3을 내지 않는다). 그러므로 `dryRun: true`를 선언한 명령은 `--dry-run`에서 **파일·DB·네트워크에 어떤 쓰기도 하지 않음**을 계약 테스트로 증명해야 한다. 증명할 수 없는 명령은 `dryRun: false`다."

### M-4. `admin.guide`의 출력 형식과 스킬 생성 시점이 없다 — 생성이 빌드에 있으면 AD-19와 충돌한다

**쌍:** U-gd(epic 3) × U-cli(epic 2) × U-boot(epic 2)

AD-17: "`admin.guide`가 전문을 내고 … 플러그인 스킬 본문은 `admin.guide`·`admin.schema` 출력에서 만들고, parity 테스트가 어긋남을 막는다." 그런데 **만드는 시점**이 없다. 스킬은 Claude Code가 읽으므로 `plugin/skills/`에 **커밋된 Markdown**이어야 하고(플러그인만으로 동작해야 한다), 그러면 상수와 파일이 둘 다 원본처럼 보인다. U-gd가 "생성은 `pnpm build`가 한다"로 구현하면 bootstrap의 `pnpm build`가 **플러그인 캐시 안의 파일을 바꾸려 한다** — AD-19의 "플러그인 캐시 안에서는 빌드하지 않는다"와 정면 충돌이고, 앱은 `<home>/app`이므로 생성물은 어차피 반영되지 않는다. 출력 형식도 없어서(`--json`의 `data` 모양) 생성기와 명령이 갈라진다. "요약"의 주인도 없다(전문에서 기계적으로 뽑는가, 따로 쓰는가).

**막는 문장(AD-17):** "`admin.guide`의 출력은 고정 구조다: `--json`은 `{guide_version, sections:[{id, title, summary, body}]}`이고 텍스트는 그 순서의 Markdown이다. **시작 맥락 요약은 전문에서 뽑지 않는다**: 각 섹션의 `summary` 한 줄이 같은 Core 상수에 함께 있고 시작 맥락은 그 줄만 모은다(길이 상한은 설정값). 주입 머리말 고정부도 같은 상수의 `preamble`이며 connector는 그 문자열을 바꾸지 않고 담기만 한다. 플러그인 스킬 본문은 **저장소에 커밋된 생성물**이고, 생성은 빌드가 아니라 명시적 명령(`pnpm guide:emit`)이 한다 — 빌드·bootstrap·`setup upgrade`는 어떤 경우에도 `plugin/`에 쓰지 않는다(AD-19). parity 테스트가 커밋된 스킬과 상수의 어긋남을 실패로 잡고, 사람이 명령을 다시 돌려 고친다."

### M-5. `work_items`의 `claimed_by` 형식이 없다 — epic 5의 "`started_at` 기준 회수"는 컬럼이 없다

0002의 `work_items`에는 `claimed_at`·`claim_expires_at`·`claimed_by`만 있고 `started_at`·`status`가 없다. 그런데 change §4.1의 epic 5 단락은 "일감 `started_at` 기준 시간 초과 회수, drain 시작 시 남은 `running` 정리"를 적었다 — **스키마에 없는 두 칸**이다. U-ops는 0005 마이그레이션으로 컬럼을 더하고, U-drn은 `claim_expires_at`으로 구현한다. 그리고 `claimed_by`의 값 형식이 없어 데몬·launchd·CLI가 서로를 식별하지 못한다(C-4의 진단이 불가능해진다).

**막는 문장(AD-21):** "`claimed_by`는 `<runtime>:<pid>:<boot_at>` 형식의 한 문자열이고 `runtime`은 `cli | launchd | daemon`이다. 시간 초과 회수는 `claim_expires_at` **하나만** 본다(`started_at`·`running` 컬럼을 두지 않는다 — 청구 세 칸이 그 사실을 이미 담고 있다). drain 시작 시의 정리는 '만료된 청구를 비우는 것'이고 상태 전이가 아니다."

### M-6. shim이 자기 자신을 고쳐 쓴다 — 실행 중인 `sh` 스크립트를 제자리에서 덮는다

AD-19: "shim은 … 그 경로가 없으면 nvm 버전 폴더 → Homebrew → … 순으로 찾아 쓰고 **다시 고정한다**." 지금 `shim.ts`가 내는 것은 `exec '<node>' '<bin>' "$@"` 네 줄이고 폴백이 없다. U-plg가 폴백을 넣고 "다시 고정"까지 shim 안에서 하면 **실행 중인 스크립트를 제자리에서 고치는 것**이다 — `sh`는 스크립트를 조금씩 읽으므로 중간부터 쓰레기를 읽을 수 있다. `writeShim`도 임시 파일을 쓰지 않는다(`writeFile`로 직접).

**막는 문장(AD-19):** "shim은 **자기 자신을 덮지 않는다.** 탐색 폴백은 shim 안의 분기이고(`[ -x "$NODE" ] || NODE=$(…)`), 재고정은 다음 `setup run`·`setup upgrade`가 **임시 파일 → rename**으로 한다. shim을 쓰는 모든 경로가 임시 파일 → rename을 쓴다. 폴백이 쓰인 사실은 spool에 한 줄 남고 doctor가 '고정된 node가 사라졌다'를 `warn`으로 보인다."

### M-7. 플러그인 `.mcp.json`은 설치 전에 커밋되므로 shim 경로를 모른다

AD-28: "플러그인 `.mcp.json`에 선택으로 등록한다." AD-19: "플러그인은 … shim 절대 경로만 부른다." 그런데 `.mcp.json`은 커밋된 파일이고 shim 경로는 `SECOND_BRAIN_HOME`에 따라 달라진다(`paths.ts`의 `configHome`). U-mcp는 기본 경로 `~/.second_brain/bin/brain`을 박고, 테스트 설치나 두 번째 설치(둘 다 `SECOND_BRAIN_HOME`으로 하는 일이다)에서는 **엉뚱한 brain이 MCP 서버로 뜬다** — 그 서버는 다른 DB에 쓴다.

**막는 문장(AD-19·AD-28):** "플러그인이 부르는 shim 경로는 `${SECOND_BRAIN_HOME:-$HOME/.second_brain}/bin/brain`으로 쓴다(hooks.json과 `.mcp.json` 모두). 플러그인은 기본 경로를 박지 않으며, 두 파일의 명령 문자열은 같은 한 줄을 쓰고 parity 테스트가 둘을 묶는다."

### M-8. 커서 "단조"의 예외가 Table Contract에 없다 — watcher 수집이 커서를 되돌린다

Table Contract의 `sessions` 행: "단조: `ended_at`, 커서(`last_harness_message_id`, fingerprint), `parser_version`, `ingested_at`". AD-4는 "커서 메시지가 사라졌거나 fingerprint가 다르면 **처음부터 다시 읽는다** … 경고를 남긴다"고 한다 — 커서가 **뒤로 간다.** U-dmn의 transcript watcher는 그 경로를 자주 밟는다(compact·fork가 잦다). U-ing(수집)은 "단조"를 제약으로 구현하고, watcher는 재설정을 구현한다 → 재설정이 거부되어 그 세션이 영구히 수집되지 않는다.

**막는 문장(Table Contract `sessions` 행):** "커서는 단조. **유일한 예외는 AD-4의 커서 재설정**이고, 그때 경고 `CURSOR_RESET`을 남긴다. `parser_version`은 단조가 아니라 마지막 값이다(옛 parser로 돌린 재수집이 뒤로 가도 된다)."

---

## Low

### L-1. AD-15의 `locator` 필드 목록에 `bbox`가 있고 change §4.2의 교체 문장에는 없다

spine 본문(결과 계약)은 `{type, page, bbox, block, start, end, start_ms, end_ms, sheet, row_start, row_end}`, change §4.2의 NEW 문장은 `bbox` 없이 적혀 있다. 한 문서 안의 두 목록이므로 조용히 갈라진다. **고침:** AD-15·AD-24·0003·결과 계약의 필드 목록을 한 곳(Core의 `locator` 타입)에서만 세고, 문서는 "종류별 필드는 Core의 `ChunkLocator` 타입이 정한다"로 적는다.

### L-2. 플러그인 manifest의 경로가 AD-19와 change §2.3에서 다르다 — `marketplace.json`은 spine에 없다

AD-19·Structural Seed는 `plugin/`에 `plugin.json`, change §2.3은 `.claude-plugin/plugin.json` + 루트 `.claude-plugin/marketplace.json`이다. Claude Code가 요구하는 것은 후자이므로 AD-19대로 만들면 **플러그인이 로드되지 않는다**(큰 소리로 실패하므로 Low). **고침:** AD-19와 Structural Seed를 `plugin/.claude-plugin/plugin.json`으로 고치고, 루트 `.claude-plugin/marketplace.json`(→ `./plugin`)을 Structural Seed에 더한다. 두 설치 경로(마켓플레이스 `/plugin marketplace add` + 로컬 `--plugin-dir`)가 같은 `plugin/`을 가리키므로 **같은 `app-ref`를 읽는다**는 한 줄도 AD-19에 더한다(C-1의 비교가 두 경로에서 같아야 한다).

### L-3. doctor의 `skip{reason}`에 `reason` 칸이 없고 `summary`를 누가 만드는지 없다

`packages/core/src/admin/doctor.ts`의 `DoctorCheck`는 `{id, status, detail?, code?}`이고 `status`는 `'ok'|'fail'|'skip'`이다. Conventions는 `skip{reason}`과 `summary{passed, warned, failed, skipped}`를 요구한다. U-cli는 `reason`을 `detail`에 넣고, U-ops의 업그레이드 테스트는 `reason` 필드를 읽는다. **고침(Conventions doctor 행):** "`skip`은 `reason`을 **별도 필드**로 갖고, 값은 기계가 읽는 짧은 코드다(`no_config`, `not_installed`, `unsupported_platform`, `prerequisite_failed`). `summary`는 Core의 `runDoctor`가 만든다(표면이 다시 세지 않는다). `warn`은 exit 0이고 `fail`만 exit 1이다 — 설치 흐름의 종료 코드도 같은 판정을 쓴다(`flow.ts`의 `some(fail)`은 그대로 유효하다)."

---

## 브라운필드 충돌 요약 (코드 ↔ 개정판 AD)

| 코드 | 지금 | 개정판 AD가 요구 | 쌍 |
| --- | --- | --- | --- |
| `tooling/bootstrap/src/bootstrap.ts` | `git pull --ff-only`(= 최신 main), `MIN_NODE_MAJOR = 24`(major만), 설치 잠금 없음, `app-ref` 없음, 완료 검증 없음 | `--ref`로만 ff, 24.16 하한, 설치 잠금, `app-ref` 기록, 완료 표식 | C-1, C-3, H-6 |
| `apps/cli/src/install/shim.ts` | `exec '<node>' '<bin>' "$@"`, 폴백 없음, 임시 파일 없음, `bin`은 업그레이드에도 불변 | node 탐색 폴백 + 재고정, "완료 표식" | C-3, M-6 |
| `apps/cli/src/install/flow.ts` | shim을 흐름 중간에 씀, connect 실패 → exit 1, 비TTY+`--yes` 없음 → exit 2 | 마지막에 표식, 플러그인 확인은 실패가 아님, 확인 필요는 3 | C-2, C-3, H-5 |
| `apps/cli/src/commands/setup-connect.ts` + `ports/connector.ts` | `connect`는 hook 파일을 쓰고 `target`을 돌려줌, shim 없으면 `SHIM_MISSING` | 플러그인 확인·안내 + 표식 hook 제거 | C-2 |
| `apps/cli/src/dispatch.ts` | `ExitCode = 0|1|2`, 메타 7개 없음, 기회적 drain 없음, `options`·`args` 두 칸 | 3, 메타, 기회적 drain, SDK 인자 객체 | C-6, H-4, H-5 |
| `apps/cli/src/envelope.ts` | CLI 모듈, `error{code,message}`만, `meta` 없음, `now`는 로컬 오프셋 | 표면 중립 봉투, `exit_code`·`retryable`·`hint`·`retry`·`meta` | H-1 |
| `packages/core/src/admin/doctor.ts` | `'ok'|'fail'|'skip'`, `summary` 없음, `reason` 없음 | `warn` 추가, `skip{reason}`, `summary` | L-3 |
| `apps/cli/src/doctor/checks.ts` | config·shim·node-path·node-version 넷 | + 플러그인 버전·앱 빌드 일치, 데몬 생존·소켓·heartbeat, 두 Label | C-1, C-4, H-7 |
| 0002 `work_items` | `claimed_*` 세 칸, `started_at`·`status` 없음 | epic 5 문구는 `started_at`·`running` | M-5 |
| 0002 `document_extractions` | `attempt`·`failed_stage` 없음, 열린 세대 키 = `(file_id, extractor_version)`, status에 `source_unreachable` 없음 | `attempt` 단조·동점 금지, `failed_stage`, 접근 불가 표시 | H-8, H-9 |
| 0002 `document_chunks` | `page integer` | + `locator` JSON(진실 출처 불명) | C-5 |
| 0002 `file_locations` | `locator` = 상대 경로 문자열(UNIQUE 키) | AD-24의 `locator`와 이름 충돌 | C-5 |

## 반영 제안 — 어느 AD에 무엇을 넣는가

| 넣을 곳 | 문장 | 막는 쌍 | 시점 |
| --- | --- | --- | --- |
| AD-19 | `app-ref` 파일 하나·40자 sha 한 줄·bootstrap만 씀·성공 뒤 마지막에 | C-1 | epic 2 인셉션 **전** |
| AD-19 | 플러그인 확인은 `--plugin-root` → `<home>/plugin-root`, 결과는 항상 `ok:true` + `PLUGIN_NOT_INSTALLED` | C-2 | epic 2 인셉션 **전** |
| AD-19 | 완료 검증은 `admin schema --json` exit 0, 그 뒤에만 shim·app-ref / hook 명령은 `|| exit 0` 래핑 | C-3 | epic 2 인셉션 **전** |
| AD-19·AD-27 | 잠금 한 규칙: owner.json + heartbeat, 부팅 시각, 90초, 두 경로 같은 함수 | H-6 | epic 2 |
| AD-19 | shim은 자기를 덮지 않음, 임시 파일 → rename | M-6 | epic 2 |
| AD-19·Structural Seed | `plugin/.claude-plugin/plugin.json` + 루트 `marketplace.json`, 두 설치 경로가 같은 app-ref | L-2 | epic 2 |
| AD-19·AD-28 | 플러그인의 명령 문자열은 `${SECOND_BRAIN_HOME:-…}/bin/brain` 한 줄 | M-7 | epic 2 |
| AD-7 | 기회적 drain 제한 셋(동기·턴 hook 제외, 데몬 켜짐이면 금지, 빈 청구 쓰기 금지) | C-6 | epic 2 인셉션 **전** |
| AD-21 | 청구 실패는 처리 실패가 아니다 / `claimed_by` 형식 / `started_at` 없음 | C-4, M-5 | epic 2 |
| AD-24 | `locator` 정규형 코덱, 진실은 `locator`·`page`는 사본, `start/end`는 코드 포인트 | C-5 | **0003 쓰기 전** |
| AD-23·AD-24·TC | `chunk_locator`로 이름 분리 | C-5 | **0003 쓰기 전** |
| AD-24·TC | `files.source_unreachable_at`, `failed_stage`는 `failed`일 때만 | H-8 | **0003 쓰기 전** |
| AD-8·AD-24·TC | `attempt`는 Store가 트랜잭션에서, `(file_id, attempt)` UNIQUE, 열린 세대 키는 `(file_id)` | H-9 | **0003 쓰기 전** |
| AD-5·Conventions | 봉투는 Runtime 코덱 하나, `now`는 응답마다, `exit_code`의 뜻 | H-1 | epic 2 |
| AD-5·AD-26 | `args`는 SDK 인자 객체, argv 변환은 메타에서 생성 | H-4 | epic 2 |
| AD-5·AD-28 | 세션은 `args.session` 하나, 우선순위, `SESSION_CONFLICT` | H-3 | epic 2(스키마), epic 9(구현) |
| Conventions | 3은 `setup run`에도, 2는 실행 불가만, `hookSafe` vs `hook`, hook의 확인 요청 | H-5 | epic 2 |
| Conventions | `retry` vs `next` 뜻 / `CONFIRMATION_REQUIRED`의 `ok`·MCP 표시 / `dryRun` 증명 | M-1~M-3 | epic 2 |
| Conventions | `skip{reason}` 별도 필드, `summary`는 Core | L-3 | epic 2 |
| AD-17 | `guide` 출력 구조, 요약은 섹션의 `summary`, 스킬은 커밋된 생성물·`pnpm guide:emit`, 빌드는 `plugin/`에 쓰지 않음 | M-4 | epic 3 **전**(스킬 자리를 epic 2가 만든다) |
| AD-25 | `[daemon] enabled` 하나가 두 Label의 상태를 정한다, 등록은 "일치시키기" | C-4 | epic 5 **전** |
| AD-25·AD-27·TC | heartbeat·last-drain은 `<home>/run/` 상태 파일, DB 아님 | H-7 | epic 5 **전** |
| AD-26 | handshake는 `admin.handshake` 호출, `VERSION_MISMATCH`는 보이지 않는 전환 신호 + `DAEMON_BYPASSED` | H-2 | epic 9 |
| AD-18 | `[daemon] enabled` 키를 설정 목록에 더한다 | C-4 | epic 5 |
| TC `sessions` | 커서 단조의 유일한 예외 = AD-4 재설정(`CURSOR_RESET`), `parser_version`은 마지막 값 | M-8 | epic 2 |

**가장 싼 순서.** (1) C-1·C-2·C-3·C-6을 AD-19·AD-7에 문장으로 넣는다 — 플러그인 스토리의 첫 코드 한 줄 전에. (2) C-5·H-8·H-9를 AD-24·AD-8·Table Contract에 넣는다 — 0003 SQL 전에(이것이 change §3가 "지금이 그 시점"이라고 한 이유다). (3) H-1·H-3·H-4·H-5와 Medium 대부분을 CLI 규약 보강 스토리의 완료 조건으로 흡수한다(epic 9가 아니라 epic 2다 — 데몬·MCP가 지킬 규약을 데몬·MCP가 정하면 늦다). (4) C-4·H-7은 epic 5 인셉션 입력으로 넘긴다.
