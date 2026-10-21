---
title: '플러그인 수집 hook 개통'
type: 'feature'
ticket: '14'
created: '2026-10-21'
status: 'built'
baseline_revision: '2a3d950ff60a8a9ddc43fcf033e11e4ad963e9e3'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 플러그인은 SessionStart bootstrap만 걸고 있어서 실제 세션이 수집되지 않는다. connector 등록부가 비어 `setup connect claude-code`가 없고, 수집 등록부(`harnesses.ts`)와 connector 등록부가 둘로 갈라져 있으며, transcript 폴더는 `SECOND_BRAIN_CAPTURE=1`일 때만 읽힌다. doctor는 hook이 실제로 오는지, 플러그인이 두 벌인지 모른다. `setup connect`는 shim이 있는지만 본다(F8).

**Approach:** 플러그인 hooks에 Stop·SessionEnd 수집을 더하고, SessionStart 런처가 bootstrap 뒤에 drain을 돌게 한다. 모든 hook은 sh 런처를 거치고 `|| exit 0`로 감싼다. 수집 명령은 `<home>/run/last-hook-<harness>`를 남긴다. Claude Code connector를 만들어 등록부를 하나로 합친다. connector는 플러그인이 설치되었는지 확인하고(`PLUGIN_NOT_INSTALLED`는 경고), Brain 표식이 붙은 옛 hook을 지운다. `setup connect`는 `inspectShim`으로 shim을 검사한다. doctor에는 `last-hook` 점검과 `PLUGIN_DUPLICATE`를 더한다. 수집 스위치는 없애고 폴더 읽기를 기본으로 켠다.

## Boundaries & Constraints

**Always:**
- **hooks.json:** 이벤트마다 matcher 없는 항목 하나씩, 모두 `"async": true`이다.
  - SessionStart: 지금 줄 그대로(`sh "${CLAUDE_PLUGIN_ROOT}/bin/session-start.sh" || exit 0`).
  - Stop과 SessionEnd: `sh "${CLAUDE_PLUGIN_ROOT}/bin/brain.sh" sessions ingest claude-code || exit 0`. SessionEnd는 최선 노력이고, 놓친 것은 drain이 줍는다(AD-6).
- **새 런처 `plugin/bin/brain.sh`:** 인자를 그대로 shim에 넘긴다.
  - home은 `SECOND_BRAIN_HOME`, 없으면 `$HOME/.second_brain`이다. `ROOT` 규칙은 `session-start.sh`와 같다.
  - `<home>/bin/brain`이 실행 가능하지 않으면 아무것도 출력하지 않고 exit 0이다. 설치 전이나 설치 중이며, 놓친 턴은 drain이 줍는다.
  - 실행 가능하면 `SECOND_BRAIN_PLUGIN_ROOT="$ROOT"`를 export한다. PATH는 `/opt/homebrew/bin:/usr/local/bin:$PATH`로 둔다. 그다음 `exec "$shim" "$@"`이다. stdin은 그대로 넘어간다.
  - node를 찾는 일은 shim이 한다. shim의 찾기 함수가 5의 런처와 같은 정본이다.
  - 이 스크립트 자신은 stdout에 아무것도 쓰지 않는다.
- **`session-start.sh`:** bootstrap을 `exec`하지 않고 돌린 뒤 `sh "$ROOT/bin/brain.sh" queue drain`을 한 번 돈다.
  - drain의 stdin은 `/dev/null`이고, stdout과 stderr는 버린다. 비동기 hook의 stdout은 모델 맥락으로 간다.
  - 스크립트의 종료 코드는 bootstrap의 것이다. bootstrap의 stdout 한 줄은 지금처럼 그대로 나간다.
  - node를 못 찾거나 app-ref가 깨진 경로는 지금처럼 drain 없이 끝난다.
  - 이렇게 하면 첫 설치 세션은 설치가 끝난 바로 뒤의 drain 폴더 스캔이 줍는다.
- **마지막 hook 수신:** `sessions ingest`는 하네스와 payload를 읽는 데 성공하면 `<home>/run/last-hook-<harness>`를 쓴다. run과 spool 두 갈래 모두, DB 작업 전에 쓴다.
  - 내용은 `SECOND_BRAIN_PLUGIN_ROOT` 한 줄이고, 없으면 빈 파일이다. 수신 시각은 파일 mtime이다.
  - 쓰기는 temp 파일 → rename이다. `run/`은 mode 0700으로 만든다.
  - 쓰기에 실패해도 수집은 계속하고, 그 실패는 무시한다.
  - 명령은 파일과 환경을 직접 만지지 않는다(dispatch.ts의 `CommandContext` 규칙). 그래서 dispatcher가 컨텍스트에 기록 함수를 준다.
- **등록부를 하나로:** `harnesses.ts`의 `Harness`에 `connector(env): Connector`를 더한다.
  - `connectors/index.ts`는 `connectors(env)` 함수가 되어 등록부에서 connector 목록을 만든다.
  - 모듈을 불러올 때 env를 읽지 않는다(AD-3). `setup connect`는 standalone 컨텍스트의 env로, 설치기는 `systemInstallDeps`의 `process.env`로 부른다.
- **Connector 포트(`packages/core/src/ports/connector.ts`):**
  - `Connector`에 `hookSource: 'plugin' | 'settings'`를 더한다.
  - `ConnectInput`에 `pluginRoot: string | null`을 더한다.
  - 성공 `ConnectResult`에 `warnings?: readonly WarningCode[]`를 더한다.
  - `settings` connector는 지금 계약 그대로다.
  - `plugin` connector의 connect는 표식 붙은 항목을 하나도 남기지 않는다. 지운 것이 있으면 `changed: true`, 없으면 `false`다. `pluginRoot`가 null이면 `warnings: ['PLUGIN_NOT_INSTALLED']`이고 `ok: true`다.
  - 계약(`testing/contracts/connector.ts`)은 공통 사례(이름, detect가 쓰지 않음, 두 번째 connect는 `changed: false`, 남의 항목은 그대로)와 출처별 사례로 나눈다. `ConnectorSubject`에 표식 항목을 넣는 `addMarkedEntry`를 더한다.
  - 가짜(`testing/fakes/connector.ts`)는 `hookSource` 옵션을 받는다.
- **Claude Code connector(`packages/claude-code/src/connector.ts`):**
  - `harness`는 parser의 것이고, `label`은 `Claude Code`, `hookSource`는 `plugin`이다.
  - 설정 폴더는 `configDir ?? ~/.claude`이다(`transcript-folder.ts`와 같은 규칙). `detect`는 그 폴더가 있는지만 본다.
  - `target`은 `<설정 폴더>/settings.json`이다.
  - connect는 그 파일의 `hooks.<이벤트>[].hooks[]` 중 `command`가 공백을 빼고 `# second-brain`(`BRAIN_MARKER`)로 끝나는 command hook을 지운다. 그 결과 비게 된 그룹과 이벤트 배열만 함께 지우고, 나머지 키·항목·순서는 그대로 둔다.
  - 지울 것이 없거나 파일이 없으면 아무것도 쓰지 않는다. 쓸 때는 temp → rename이고, 원래 파일 mode를 지킨다.
  - JSON이 아니거나 `hooks` 모양이 틀리면 쓰지 않는다. 이때는 `{ok:false, code:'HARNESS_UNREADABLE'}`이고 message는 한국어다.
- **`setup connect <harness>`:**
  - shim을 `inspectShim(home)`(checks.ts에서 export)으로 검사한다.
    - 읽을 수 없거나 해석할 수 없으면 `SHIM_MISSING`이다.
    - 그 밖의 문제(실행 권한, 서명, 진입점)는 새 오류 코드 `SHIM_INVALID`(exit 1, retryable false, hint는 `brain setup run`으로 shim을 다시 쓰라)이고 message는 inspectShim의 것이다.
    - home이 다르다는 경고는 실패가 아니다.
  - `pluginRoot`는 `run/plugin.json`의 `plugin_root`이고, 없으면 `installed.json`의 `plugin_root`, 그것도 없으면 null이다.
  - connector의 `warnings`는 엔벨로프 `warnings`로 올린다. `data`에 `plugin_root`(null 가능)를 더한다.
  - `plugin` 출처의 텍스트 줄(한국어):
    - 플러그인이 있으면 "<label>는 <root>의 플러그인으로 연결되어 있습니다".
    - 없으면 "<label> 플러그인이 설치되어 있지 않습니다. Claude Code에서 second-brain 플러그인을 설치하세요".
    - 지운 것이 있으면 그 앞에 "<target>에서 예전 brain hook을 지웠습니다" 한 줄을 둔다.
- **설치기 `connectHarnesses`:** `pluginRoot`는 `flags.pluginRoot`, 없으면 위와 같은 순서다. connector의 경고는 설치 결과 `warnings`에 더하고, 줄은 위 문장을 쓴다.
- **수집 스위치 제거:** `CAPTURE_ENV`와 `transcriptFolders`의 조건을 지운다. 폴더는 늘 등록부 전부이고, doctor `transcripts`는 `skip`이 아니게 된다. 테스트는 `apps/cli/test/environment.ts`의 빈 `CLAUDE_CONFIG_DIR` 격리를 그대로 쓴다.
- **doctor `last-hook` 점검:** `runtimeChecks`에서 `plugin` 다음, `spool` 앞에 둔다. 등록부의 하네스마다 한 구절을 쓰고, 구절은 ". "로 잇는다.
  - 파일이 없으면 `ok`, "<harness>: 아직 받은 hook이 없습니다".
  - 있으면 `ok`, "<harness>: <mtime을 isoWithOffset으로>".
  - 내용(root)이 비어 있지 않고, 플러그인 폴더(`run/plugin.json`의 root, 없으면 `installed.json`의 root)가 알려져 있으며, 둘이 다르면 `warn` `PLUGIN_DUPLICATE`다. detail에 두 폴더를 적는다.
- 새 사람용 문장은 모두 한국어이고 출력 언어 검사를 통과한다. 새 오류 코드는 Core 표와 README 표 양쪽에 있다.
- **Decision(2026-10-21, 무인 실행에서 에이전트가 고름):** 수집 hook은 런처에서 node를 찾지 않고 shim을 부른다. spine 구성표대로 "플러그인은 shim 절대 경로만 부른다"이고, shim이 같은 찾기 함수와 재고정을 갖는다. 다른 안: 런처가 node를 찾아 `dist/bin.js`를 직접 실행.
- **Decision(같은 근거):** SessionStart drain은 따로 hook 항목을 두지 않고 `session-start.sh`가 bootstrap 뒤에 돈다. 그래야 첫 설치 세션이 설치 직후에 주워지고, 갱신 중인 `dist`로 drain이 돌지 않는다. 다른 안: SessionStart 비동기 항목 둘.
- **Decision(같은 근거):** Claude Code 설정의 Brain 표식은 command 끝의 셸 주석 `# second-brain`이다. 포트 주석의 "자기 줄의 주석"이고, 지금까지 이것을 쓴 설치기는 없다. 다른 안: hook 객체에 모르는 키 추가(Claude Code 설정 검증 위험).
- **Decision(같은 근거):** 플러그인 확인과 `PLUGIN_DUPLICATE`의 기준 폴더는 `run/plugin.json`이 먼저이고 `installed.json`이 다음이다. doctor `plugin` 점검과 같은 순서다. npx로 먼저 설치하고 나중에 플러그인을 켜면 `installed.json.plugin_root`는 null로 남기 때문이다.

**Never:**
- SessionStart 동기 `context show`, `plugin/skills/`, Stop 점검 `log remind`(epic 3).
- 설정 파일에 hook을 쓰는 `settings` 출처의 실제 connector(Claude Code 밖의 하네스).
- 버전이 오른 뒤 크기가 같은 transcript를 다시 큐에 넣는 일(deferred, 지금 저장된 세션이 없다).
- `setup upgrade`·`setup uninstall`, 데몬, LaunchAgent.
- 사용자의 실제 `~/.claude`·`~/.second_brain`을 건드리는 테스트. 테스트 안에서 실제 Claude Code를 띄우는 일.
- `plugin/app-ref`와 `plugin.json` `version` 변경. 스토리 커밋 뒤의 별도 커밋이 한다(AGENTS.md).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stop 수집 | 설치된 home, Stop payload | 메시지가 들어가고 `run/last-hook-claude-code` 내용이 플러그인 root다. stdout은 비어 있다 | exit 0 |
| 설치 전 hook | shim 없음 | 아무것도 하지 않음, stdout 비어 있음 | exit 0 |
| DB에 못 씀 | 스키마 불일치 | spool로 감, last-hook은 쓰임 | exit 0 |
| 첫 설치 세션 | 기록 없음, 폴더에 transcript | bootstrap 설치 → drain이 그 세션을 `import`로 넣음 | exit 0 |
| 시작 hook만 | 대화 줄 없는 transcript | 세션 행 없음 | exit 0 |
| connect, 플러그인 있음 | plugin.json root 있음, 표식 hook 하나와 남의 hook | 표식 hook만 지움, `changed:true`, 경고 없음 | exit 0 |
| connect, 플러그인 없음 | 두 기록 모두 root 없음 | `ok:true`, `warnings:[PLUGIN_NOT_INSTALLED]`, 파일 그대로 | exit 0 |
| connect 두 번 | 같은 상태 | 둘째는 `changed:false`, 쓰기 없음 | exit 0 |
| settings.json 깨짐 | JSON 아님 | 쓰지 않음 | `HARNESS_UNREADABLE`, exit 1 |
| shim 실행 권한 없음 | `setup connect claude-code` | connector를 부르지 않음 | `SHIM_INVALID`, exit 1 |
| 두 벌 | last-hook root ≠ plugin.json root | doctor `last-hook` warn `PLUGIN_DUPLICATE`, 두 폴더를 적음 | exit 0 |
| hook 기록 없음 | last-hook 파일 없음 | `ok` "아직 받은 hook이 없습니다" | exit 0 |

</intent-contract>

## Code Map

- `plugin/hooks/hooks.json`, `plugin/bin/session-start.sh`(마지막 `exec` 줄), 새 `plugin/bin/brain.sh` -- 위 규칙. `tooling/bootstrap/test/plugin.test.ts`가 hooks.json 모양("SessionStart 하나뿐")을 단정하므로 고친다. 런처를 node 없이 시험하는 본보기가 그 파일에 있다.
- `tooling/bootstrap/test/hook.test.ts` -- 작업 트리 스냅샷 bare 저장소 + 임시 home + 플러그인 사본으로 `session-start.sh`를 실제로 돌리는 느린 테스트다(SLOW). 여기에 수락 기준 1·2를 더한다. 임시 `CLAUDE_CONFIG_DIR/projects/<폴더>/<id>.jsonl`에는 `packages/claude-code/test/fixtures/two-turns.jsonl`을 쓴다. DB 확인은 `node:sqlite`나 sqlite 패키지로 읽기만 한다.
- `packages/core/src/ports/connector.ts`, `testing/contracts/connector.ts`, `testing/fakes/connector.ts`, `packages/core/test/contracts.test.ts`(220-271에 가짜·즉석 connector 사례가 있다) -- 포트·계약·가짜.
- 새 `packages/claude-code/src/connector.ts` + `src/index.ts` export + 새 `test/connector.test.ts` -- 임시 폴더로 계약을 돌린다. `transcript-folder.ts`의 설정 폴더 규칙을 재사용한다. 이 패키지는 `node:fs`를 이미 쓴다.
- `apps/cli/src/harnesses.ts` -- `Harness.connector`를 더하고 `CAPTURE_ENV`·`CAPTURE_ON`과 스위치 주석을 지운다. `connectors/index.ts`는 `connectors(env)`가 된다. `commands/index.ts`의 `setupConnectCommand(connectors)`는 함수를 받게 한다.
- `apps/cli/src/commands/setup-connect.ts` -- 53-63의 `exists` 검사를 `inspectShim`으로 바꾸고, pluginRoot·warnings·data·줄을 더한다. `apps/cli/src/doctor/checks.ts`의 `inspectShim`(224)은 export한다. `ShimState`가 그 결과다.
- `apps/cli/src/install/flow.ts` -- `connectHarnesses`(874-924)에 pluginRoot와 경고를 더한다. `warnings` 배열은 338에 있다. `InstallDeps.connectors`(274)는 그대로 배열이다. `apps/cli/src/install.ts`(8, 177-179)는 `connectors(process.env)`를 쓰고 스위치 주석을 지운다.
- `apps/cli/src/commands/sessions-ingest.ts` -- `readPayload` 성공 뒤 run·spool 두 갈래에서 기록 함수를 부른다. `apps/cli/src/dispatch.ts`의 `CommandContextBase`(77)에 그 함수를 더하고, dispatcher가 home(`configHome(env)`)과 env의 `SECOND_BRAIN_PLUGIN_ROOT`로 구현한다. 575의 `transcriptFolders(env)` 주석도 고친다. 쓰는 함수는 새 `apps/cli/src/runtime/hook-arrival.ts`에 둔다. 경로는 `config/paths.ts`에 `lastHookPath(home, harness)`(`run/last-hook-<harness>`)로 둔다.
- `apps/cli/src/doctor/checks.ts` -- `runtimeChecks`(115-135)에 `last-hook`을 더한다. `readPluginRun`·`readInstalled`(installed.ts)와 `isoWithOffset`을 재사용한다. 테스트용으로 하네스 이름 목록을 옵션으로 받는다.
- `packages/core/src/codes.ts` -- `SHIM_MISSING`(242) 옆에 `SHIM_INVALID`를 둔다. README 오류 표와 `apps/cli/test/readme-codes.test.ts`가 양방향으로 대조한다.
- 스위치를 쓰던 테스트: `apps/cli/test/capture-scan.test.ts:21,133`, `sessions-ingest.test.ts:1875`, `environment.ts:23-39`, `doctor-run.test.ts:83`, `setup.test.ts:693`(`transcripts`가 이제 skip이 아님). 가짜 connector를 쓰는 테스트: `setup.test.ts:210-340`, `install-flow.test.ts:1284,1521-1537`.
- 문서:
  - `README.md`: 플러그인 hook 셋, `setup connect claude-code`, doctor `last-hook`, `SHIM_INVALID`, 스위치 제거.
  - spine `architecture-brain-v1-slice-1.md` AD-19: 수집 런처가 shim을 부른다는 것과 last-hook 내용.
  - `deferred-work.md`: 스위치 항목을 해결로 바꾼다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/connector.ts`, `testing/contracts/connector.ts`, `testing/fakes/connector.ts`, `packages/core/test/contracts.test.ts` -- 포트 칸 셋, 출처별 계약, 가짜의 `hookSource`.
- [x] `packages/core/src/codes.ts`, `README.md` 오류 표 -- `SHIM_INVALID`.
- [x] `packages/claude-code/src/connector.ts`, `src/index.ts`, `test/connector.test.ts` -- Claude Code connector. 계약과 매트릭스의 connect 행을 시험한다(표식 hook만 지움, 빈 그룹 정리, 깨진 JSON, 파일 없음).
- [x] `apps/cli/src/harnesses.ts`, `connectors/index.ts`, `commands/index.ts`, `install.ts`, `dispatch.ts` -- 등록부 합치기, 스위치 제거, 기록 함수.
- [x] `apps/cli/src/runtime/hook-arrival.ts`, `config/paths.ts`, `commands/sessions-ingest.ts` -- last-hook 쓰기. `sessions-ingest.test.ts`에서 두 갈래, 환경 변수 있음과 없음, 쓰기 실패에도 수집이 되는지를 본다.
- [x] `apps/cli/src/commands/setup-connect.ts`, `doctor/checks.ts`(`inspectShim` export) -- `setup.test.ts`에 shim 사례, 경고, `plugin_root`, 텍스트 줄을 더한다.
- [x] `apps/cli/src/install/flow.ts` -- pluginRoot와 경고. `install-flow.test.ts`.
- [x] `apps/cli/src/doctor/checks.ts` -- `last-hook` 점검. `doctor-checks.test.ts`에서 없음, 시각, 두 벌, 기준 폴더 순서를 보고, `PLUGIN_DUPLICATE`가 엔벨로프 `warnings`에 오는지 본다.
- [x] 스위치를 쓰던 CLI 테스트 -- 스위치 없이 같은 것을 단정하게 고친다.
- [x] `plugin/hooks/hooks.json`, `plugin/bin/session-start.sh`, `plugin/bin/brain.sh`, `tooling/bootstrap/test/plugin.test.ts` -- hooks 셋. 런처 시험: shim이 없으면 stdout이 비고 exit 0이다. 가짜 shim(인자·stdin·`SECOND_BRAIN_PLUGIN_ROOT`를 파일에 적는 sh)이면 그대로 넘긴다. session-start가 drain 출력을 내지 않는다.
- [x] `tooling/bootstrap/test/hook.test.ts` -- 수락 기준 1·2.
- [x] `README.md`, spine AD-19, `deferred-work.md` -- 위 문서.
- [x] (사람) 이 기계에서 로컬 marketplace로 플러그인을 켜고 실제 수집을 시작한다. 아래 Verification의 사람 확인이다.

**Acceptance Criteria:**
- Given 2.5의 느린 hook 테스트 환경(스냅샷 bare 저장소, 임시 home, app-ref를 스냅샷 sha로 둔 플러그인 사본)과, 대화 transcript 하나가 있는 임시 `CLAUDE_CONFIG_DIR`가 있을 때, when hooks.json의 SessionStart 명령을 처음 돌리면, then 설치가 끝나고 그 transcript의 세션이 `ingest_source = import`로 DB에 들어 있으며 stdout은 JSON 한 줄이다.
- Given 같은 설치에서, when hooks.json의 Stop 명령 문자열을 `sh -c`로 Stop payload(새 세션 id, 대화가 있는 transcript)와 함께 돌리면, then exit 0이고 stdout이 비며 그 세션의 메시지가 들어가 있다. 이어서 `brain doctor run --json`에는 `last-hook`이 그 시각으로 있고, `plugin`이 기록·app-ref·빌드 신원이 같다고 말한다. 대화 줄이 없는 transcript로 돌린 세션 id에는 세션 행이 없다.
- Given 플러그인 기록이 없는 home에서, when `brain setup connect claude-code --json`을 실행하면, then `ok:true`이고 `warnings`에 `PLUGIN_NOT_INSTALLED`가 있으며 표식 없는 `settings.json` 항목은 바이트까지 그대로다.
- Given `pnpm test`를 실행하면, then 모두 통과하고 출력 언어 검사와 README 코드 대조가 통과한다.

## Implementation Notes

구현은 codex가 Orca 워커로 했다(첫 시도는 bmad-build 스킬 렌더러가 샌드박스에서 죽어 코드 변경 없이 멈췄고, 스킬을 부르지 말라는 지시를 더해 다시 띄웠다). 플랜과 달라진 것과 메운 자리만 적는다.

- **설치기와 `setup connect`가 같은 도우미를 쓴다.** 새 `apps/cli/src/connectors/plugin.ts`에 플러그인 폴더 찾기(`run/plugin.json` → `installed.json` → null)와 출처별 텍스트 줄을 두었다. 두 곳이 같은 문장과 같은 순서를 쓰게 하려는 것이다.
- **`setup connect`의 `SHIM_MISSING`/`SHIM_INVALID` 판정.** `inspectShim`이 shim을 해석하지 못했으면(`shim`이 없음) `SHIM_MISSING`, 해석했는데 문제가 있으면 `SHIM_INVALID`다.
- **기록 함수는 standalone·preflight 컨텍스트에도 들어간다.** `CommandContextBase`에 두었기 때문이다. 쓰는 것은 `sessions ingest`뿐이다.
- **"시작 hook만" 행은 대화 줄 없는 transcript로 Stop을 돌려 확인한다.** SessionStart의 drain도 같은 수집 함수를 지나므로 세션 행을 만들지 않는 규칙은 같다(`hook.test.ts`).
- **`plugin/bin/brain.sh`는 실행 비트 없이(0644) 커밋된다.** hooks.json이 `sh`로 부르므로 동작에는 상관없다.
- 등록부가 비지 않게 되어, 비대화형 설치에서 `--connect`가 없을 때의 줄은 "연결한 하네스가 없습니다"가 된다(전에는 "아직 연결할 하네스가 없습니다 (epic 2)").

## Plan Change Log

## Review Triage Log

### 2026-10-21 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `sessions-ingest.ts:180` — hook 수신 기록이 dispatcher의 스키마 버전 읽기(`checkSchema`) 뒤에 남아 "DB 작업 전에"와 어긋난다. 사실이다: `readPayload`는 `run`/`spool` 안에서만 불리고, 둘 다 store를 열고 스키마를 읽은 뒤다. 하지만 DB에 닿지 못하면 spool 갈래가 기록을 남기므로 플랜이 지키려던 것은 지켜진다. 기록을 잃는 경우는 그 몇 밀리초의 읽기 사이에 프로세스가 죽을 때뿐이다. 고치려면 preflight를 비동기로 바꾸고 stdin을 한 번만 읽도록 기억해 두는 장치를 dispatcher에 더해야 한다(가드·분기 추가). 일상에서 만나기 어렵고 고치는 일이 단순한 수정이 아니라서 기각했다.

## Design Notes

- `last-hook` 내용으로 root를 남기는 까닭: 같은 hook이 플러그인 두 벌에서 오면 두 root가 번갈아 기록된다. root가 없으면 "두 벌"을 알아볼 길이 없다.
- 받아들인 오탐: `claude plugin update` 뒤에 아직 열려 있는 옛 세션의 Stop은 옛 캐시 폴더를 적는다. 그래서 새 세션의 SessionStart가 `plugin.json`을 바꾼 뒤 잠깐 `PLUGIN_DUPLICATE`가 보일 수 있다. 다음 hook이 고친다.
- `run/` 기록 실패를 무시하는 까닭: 진단용 사실이라 그것 때문에 턴의 수집을 잃으면 안 된다. 기록이 오래 멈추면 `transcripts` 점검의 미수집 건수가 드러낸다.

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·vitest가 모두 통과한다(느린 bootstrap·hook 테스트 포함).
- `node -e "JSON.parse(require('fs').readFileSync('plugin/hooks/hooks.json','utf8'))"` -- expected: 오류 없음.
- `cmp tooling/bootstrap/bin/second-brain.js plugin/bootstrap.mjs` -- expected: 같음.

**Manual checks (if no CLI):**
- (사람 확인)
  - 이 기계에서 `claude plugin marketplace add <repo>`로 플러그인을 설치하고 새 세션을 연다. 두 턴 대화한 뒤 `brain doctor run`에서 `last-hook` 시각과 `transcripts`를 본다. 실제 `~/.claude/settings.json`에 Brain 표식 hook이 없는지도 본다.
  - GUI로 띄운 Claude Code에서도 Stop 수집이 되고 프로젝트 꼬리표가 붙는지(hook PATH의 git) 본다.

## Auto Run Result

- **요약:** Claude Code 플러그인이 실제 세션을 수집한다.
  - hooks.json에 비동기 Stop·SessionEnd 수집을 더했다. 새 런처 `plugin/bin/brain.sh`는 `<home>/bin/brain` shim에 인자와 stdin을 넘기고, shim이 없으면 조용히 exit 0이다.
  - `session-start.sh`는 bootstrap 뒤에 출력 없는 `queue drain`을 한 번 돈다. 첫 설치 세션도 설치 직후에 주워진다. 종료 코드는 bootstrap의 것이다.
  - `sessions ingest`는 payload를 읽으면 `<home>/run/last-hook-<harness>`(내용은 플러그인 root, mtime은 시각)를 남긴다.
  - Claude Code connector를 만들어 수집 등록부와 connector 등록부를 하나로 합쳤다.
    - Connector 포트에 `hookSource`, `pluginRoot`, `warnings`를 더했고, 계약은 출처별로 나뉜다.
    - `setup connect claude-code`는 `inspectShim`으로 shim을 검사한다(`SHIM_MISSING`/새 `SHIM_INVALID`).
    - 플러그인 폴더는 `run/plugin.json` → `installed.json` 순서로 찾고, 없으면 `PLUGIN_NOT_INSTALLED` 경고(`ok: true`)다.
    - `settings.json`에서는 command 끝이 `# second-brain`인 옛 hook만 지운다.
  - `SECOND_BRAIN_CAPTURE` 스위치를 없애 transcript 폴더 읽기가 기본이다.
  - doctor에 `last-hook` 점검(하네스별 마지막 수신 시각, root가 현재 플러그인 폴더와 다르면 `PLUGIN_DUPLICATE`)을 더했다.
- **바뀐 파일:**
  - `plugin/hooks/hooks.json`, `plugin/bin/session-start.sh`, `plugin/bin/brain.sh`(새): hook 셋과 런처
  - `packages/core/src/ports/connector.ts`, `testing/contracts/connector.ts`, `testing/fakes/connector.ts`: 포트 칸과 출처별 계약
  - `packages/core/src/codes.ts`: `SHIM_INVALID`
  - `packages/claude-code/src/connector.ts`(새), `src/index.ts`: Claude Code connector
  - `apps/cli/src/harnesses.ts`, `connectors/index.ts`, `connectors/plugin.ts`(새), `install.ts`, `install/flow.ts`, `install/store.ts`: 등록부 합치기, 스위치 제거, 설치기 경고
  - `apps/cli/src/dispatch.ts`, `runtime/hook-arrival.ts`(새), `config/paths.ts`, `commands/sessions-ingest.ts`: 마지막 hook 기록
  - `apps/cli/src/commands/setup-connect.ts`, `doctor/checks.ts`: shim 검사, 플러그인 확인, `last-hook` 점검
  - 테스트: connector 계약(core·claude-code), setup·설치기·doctor·수집·스위치 제거 갱신, `plugin.test.ts`(런처), `hook.test.ts`(실제 설치 뒤 SessionStart drain·Stop 수집·doctor)
  - `README.md`, spine AD-19, `deferred-work.md`
- **리뷰:** quick 1회(codex, Orca), 지적 1건. patch 0, defer 0, reject 1.
  - 기각(low): hook 수신 기록이 스키마 버전 읽기 뒤에 남는다. 그 사이에 프로세스가 죽을 때만 기록을 잃고, 고치려면 dispatcher에 비동기 preflight와 stdin 기억 장치가 필요하다.
- **follow-up review 권장:** false. 패치한 항목이 없다(high 0, medium 0, low 0).
- **검증:**
  - `pnpm test`: 69개 파일, 2256개 테스트 통과(건너뛴 것 없음). 실제 git·빌드로 설치한 뒤 SessionStart drain과 Stop 수집을 도는 `hook.test.ts`를 포함한다.
  - hooks.json JSON 파싱 통과. `cmp tooling/bootstrap/bin/second-brain.js plugin/bootstrap.mjs` 같음. `git diff --check` 통과.
  - 매트릭스 12행이 모두 테스트에 걸려 있고, 그 테스트가 돌아 통과했다.
- **에이전트가 대신 내린 결정**(플랜 frozen 블록의 Decision):
  1. 수집 hook은 런처에서 node를 찾지 않고 shim을 부른다.
  2. SessionStart drain은 따로 hook 항목을 두지 않고 bootstrap 뒤에 돈다.
  3. Claude Code 설정의 Brain 표식은 command 끝의 `# second-brain` 주석이다.
  4. 플러그인 확인의 기준 폴더는 `run/plugin.json`이 먼저다.
- **사람 확인 필요**(hitl, 스토리의 마지막 단계):
  1. 이 기계에서 로컬 marketplace로 플러그인을 설치하고 새 세션을 연다. 두 턴 대화한 뒤 `brain doctor run`에서 `last-hook` 시각과 `transcripts`를 본다. 실제 `~/.claude/settings.json`에 Brain 표식 hook이 없는지도 본다.
  2. GUI로 띄운 Claude Code에서도 Stop 수집이 되고 프로젝트 꼬리표가 붙는지(hook PATH의 git) 본다.
  3. 플러그인이 새 build를 설치하는지 본다. 스토리 커밋 뒤의 별도 커밋이 `plugin/app-ref`를 스토리 커밋으로, `version`을 0.1.5로 올렸다. 그 전 app-ref(e527807)는 parser v2 시절 build라서 그것으로 수집하면 옛 규칙으로 굳는다.
- **남은 위험:**
  - 이제 실제 home에서 어떤 `brain` 명령이든 돌면 기회적 drain이 디스크의 transcript를 가져오기 시작한다. 이것이 "실제 수집을 켠다"이고, 되돌릴 수 없다(AD-11).
  - 플러그인 갱신 직후 열린 옛 세션의 hook은 잠깐 `PLUGIN_DUPLICATE`를 보일 수 있다(Design Notes).
  - 버전이 오른 뒤 크기가 같은 transcript를 스캔이 다시 큐에 넣지 않는 문제는 deferred-work에 그대로 남아 있다. 지금은 저장된 옛 버전 세션이 없다.
  - 새 코드는 저장소의 다른 파일보다 주석이 적고 줄이 길다. 동작에는 영향이 없다.

## 실제 수집 켜기 결과 (2026-10-21)

사용자 승인 뒤 에이전트가 이 기계에서 돌렸다.
- `claude plugin marketplace add ./` → `claude plugin install second-brain@second-brain`(user 범위, 0.1.5, `<repo>/plugin`에서 그 자리로 읽힘).
- Orca 터미널에서 대화형 `claude`를 띄웠다. 커밋을 push하지 않아서 `SECOND_BRAIN_REPO=file://<repo>`를 주었다. 그래서 `~/.second_brain/app`의 origin은 이 로컬 저장소다.
- 첫 세션의 SessionStart가 15초 안에 설치를 끝냈다: `installed.json.commit` = `01d3341`, `plugin_root` = `<repo>/plugin`. 이어진 drain이 디스크의 세션 277개, 메시지 7,506개를 `import`로 가져왔다.
- 설치 완료 안내 한 줄은 모델이 첫 답에 붙여 사용자에게 전했다("Brain이 01d3341 버전으로 설치되었습니다").
- 두 턴 대화 뒤 그 세션은 `live`, `start_source = startup`이고 프로젝트 꼬리표가 `github.com/gmae199boy/second-brain`, 워크트리가 `<repo>`이며, 메시지는 4개로 중복이 없다.
- `brain doctor run`: 통과 15, 경고 0. `plugin`은 "플러그인과 설치가 같은 01d3341", `last-hook`은 그 시각, `transcripts`는 미수집 1건(돌고 있던 세션)이다.
- 실제 `~/.claude/settings.json`에 `# second-brain` 표식 hook은 없다(플러그인 등록 항목 둘만 있다). `brain setup connect claude-code --json`은 `ok`, 경고 없음, `changed: false`, `plugin_root` = `<repo>/plugin`이다.
- GUI 실행 PATH: 최소 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`)에서 `/usr/bin/git`(Apple Git 2.54)이 잡히므로 꼬리표에 문제가 없다.
