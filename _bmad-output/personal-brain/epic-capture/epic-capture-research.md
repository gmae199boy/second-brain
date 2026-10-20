# epic 2 인셉션 조사: Claude Code hook·플러그인과 transcript 구조

- 작성: 2026-10-15 (epic-capture 인셉션)
- 용도: epic-capture 스토리(tracer, 플러그인 설치 경로, parser, 수집 hook 개통)와 epic-attachments 인셉션의 입력
- 출처:
  - Claude Code 공식 문서. 2026-10-15에 `https://code.claude.com/docs/en/{hooks,plugins,plugins-reference,plugin-marketplaces}.md`를 조회했고, 설치된 CLI는 2.1.300이다.
  - 이 Mac의 transcript 실측. 구조와 건수만 적고 대화 내용은 적지 않는다.

## 1. hook

- **비동기:** command hook에 `"async": true`를 준다.
  - 비동기 hook은 아무것도 막거나 제어하지 못한다. `decision`·`continue` 같은 칸은 무시된다.
  - hook이 끝나면 JSON 출력의 `additionalContext`와 `systemMessage`가 **다음 턴에 Claude에게** 간다. 사용자에게는 보이지 않는다. stdout에는 그 JSON 한 줄만 둔다.
  - 이미 돌고 있는 비동기 hook에는 `timeout`을 강제하지 않는다.
  - `claude -p`는 세션이 끝날 때 아직 돌고 있는 비동기 hook을 취소한다.
- **`asyncRewake: true`:** 백그라운드로 돌다가 exit 2로 끝나면 Claude를 깨운다. 그때 stderr를 보이고, stderr가 비어 있으면 stdout을 보인다. 이 방식에는 `timeout`이 강제된다.
- **공통 stdin:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode` 등이다.
  - transcript는 비동기로 기록된다. 그래서 hook이 돌 때 이번 턴의 마지막 메시지가 아직 파일에 없을 수 있다.
- **SessionStart:**
  - `source`는 startup·resume·clear·compact·fork 중 하나다.
  - 동기 hook의 stdout 또는 `hookSpecificOutput.additionalContext`는 맥락에 들어간다.
  - 출력 상한은 10,000자이고 바꿀 수 없다. 넘으면 출력을 파일로 빼고, 경로와 2,000자 미리보기로 대신한다.
  - exit 2로도 세션 시작을 막지 못한다. stderr가 사용자에게만 보인다.
- **Stop:**
  - stdin에 `stop_hook_active`와 `last_assistant_message` 등이 있다.
  - exit 2는 멈춤을 막고 대화를 이어 가게 한다. 그래서 hook 경로에서 exit 2는 쓰지 않는다.
- **SessionEnd:**
  - `reason`은 clear·resume·logout·prompt_input_exit·other 중 하나다.
  - 기본 timeout은 1.5초이고, 플러그인 hook에 준 `timeout`으로는 늘릴 수 없다.
  - JSON 출력은 버려진다.
- **환경:**
  - hook 프로세스는 Claude Code의 환경을 그대로 물려받는다. PATH도 마찬가지이므로, Claude Code를 터미널에서 띄웠는지 GUI 앱에서 띄웠는지에 따라 PATH가 다르다.
  - `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`가 환경 변수로 들어온다. `CLAUDE_PLUGIN_DATA`는 `~/.claude/plugins/data/<id>/`다.
  - `CLAUDE_ENV_FILE`은 SessionStart, Setup, CwdChanged, FileChanged hook에만 있다. 이 파일에 적은 `export` 줄은 이후 Bash 명령을 실행하기 전마다 먼저 실행된다.
  - command hook의 기본 timeout은 600초다.

## 2. 플러그인

- **개발용 로딩:**
  - `claude --plugin-dir <path>`로 플러그인을 직접 싣는다. 여러 번 줄 수 있다.
  - marketplace 루트를 가리키면 아무것도 싣지 않고, 오류도 내지 않는다.
  - 로컬 marketplace(`claude plugin marketplace add ./dir`)에 등록한 상대 경로 플러그인은 복사하지 않고 그 자리에서 싣는다. 세션을 시작하거나 `/reload-plugins`를 할 때마다 원본을 다시 읽고, version은 영향을 주지 않는다.
- **원격 marketplace 설치:**
  - 플러그인을 캐시(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`)에 복사한다.
  - version은 매니페스트의 `version`, marketplace 항목의 `version`, 커밋 SHA 순서로 정한다.
  - 매니페스트에 version을 고정해 두면, 그 값을 바꿀 때까지 모든 사용자가 캐시된 사본을 쓴다.
  - `claude plugin update <plugin>`으로 받은 새 버전은 다음 세션부터 실린다.
- **의존성:**
  - 캐시에 복사할 때 Node 의존성을 자동 설치하지만, `pnpm-lock.yaml`과 `yarn.lock`은 건너뛴다.
  - 그래서 플러그인 폴더에는 `package.json`과 lockfile을 두지 않는다(spine AD-19와 같다).
- **hooks:**
  - `hooks/hooks.json`의 최상위 `"hooks"`에 둔다. 모양은 settings 파일의 hooks와 같다.
  - 설정 파일의 hook과 플러그인 hook은 합쳐져 모두 돈다. 같은 처리기라도 플러그인 쪽은 따로 한 번 더 돈다.
  - 그래서 hook의 출처는 하나만 둔다(AD-19).
- **marketplace `source`:**
  - 경로는 `./`로 시작해야 한다.
  - 플러그인 루트 밖을 가리키는 경로(`../`, 밖으로 나가는 symlink)는 거부된다.
  - 그래서 `bootstrap.js`는 플러그인 폴더 안에 복사본으로 둔다.

## 3. pnpm

- 이 저장소에서 `pnpm install --frozen-lockfile --ignore-scripts` 뒤 `pnpm build`가 성공한다. 설치되는 패키지 집합은 일반 설치와 같다.
- 의존성 중에 설치 스크립트(preinstall·install·postinstall)를 가진 것이 하나도 없다. pnpm 12.11.2, Node 24.16.0에서 확인했다.

## 4. transcript 구조

이 Mac에서 2026-09-14부터 2026-10-15까지 쌓인 transcript를 실측했다.

- **위치:**
  - 세션은 `~/.claude/projects/<인코딩된 cwd>/<session-id>.jsonl` 파일 하나다.
  - 같은 이름의 폴더 아래에 서브에이전트 파일 `subagents/agent-<hex>.jsonl`(옆에 `.meta.json`)과 큰 도구 출력을 담은 `tool-results/`가 있다.
- **규모:** 세션 파일 133개, 서브에이전트 파일 391개, 전체 22.6만 줄이다. 파일 크기는 중앙값 1.26MB, 최대 19.3MB다.
- **세션과 파일:**
  - 파일 하나가 세션 하나이고, 파일 이름이 곧 `sessionId`다.
  - resume은 같은 sessionId로 같은 파일에 이어 쓴다. 그래서 한 파일이 여러 날에 걸칠 수 있다.
  - fork와 continue는 새 sessionId로 새 파일을 만든다. 옛 파일의 `continued-in` 항목과 새 파일의 `fork-context-ref` 항목이 서로를 가리킨다.
- **서브에이전트:**
  - 서브에이전트 파일은 부모 세션의 `sessionId`를 쓰고, 모든 항목이 `isSidechain: true`다.
  - 세션 파일의 항목은 모두 `isSidechain: false`다.
- **최상위 `type`:**
  - 대화는 `user`와 `assistant`이고, 여기에 `system`이 더해진다.
  - 그 밖의 20여 종은 대화가 아니다. 가장 많은 `attachment`를 비롯해 `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`, `queue-operation` 등이 있다.
  - `summary` 항목은 한 건도 없었다.
- **대화 항목의 칸:**
  - 공통: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `version`, `isSidechain`, `message`
  - `assistant`: `message.model`
  - `user`: `isMeta`, `isCompactSummary`, `imagePasteIds`
- **`message.content`:**
  - 문자열일 수도 있고 블록 배열일 수도 있다.
  - 블록 종류는 `text`, `thinking`, `tool_use`, `tool_result`, `image`다.
  - `tool_result.content`도 문자열이거나 `text`·`image` 블록 배열이다.
- **compact:**
  - 파일을 다시 쓰지 않고 뒤에 이어 쓴다.
  - 먼저 `system` 항목이 온다. 이 항목은 `subtype: compact_boundary`, `parentUuid: null`이고, `logicalParentUuid`와 `compactMetadata`를 가진다.
  - 이어서 `isCompactSummary: true`인 `user` 항목이 온다. 사용자가 아니라 Claude Code가 만든 요약이다.
- **시각:**
  - 앞 줄보다 시각이 이른 줄이 흔하다. 파일 524개 중 521개에 있었고, 가장 크게 거꾸로 간 것은 약 10.5시간이었다.
  - 그래서 순서는 파일 안의 위치와 `uuid` 사슬로 정하고, 시각으로 정렬하지 않는다.
  - 2026-10-20 다시 잼: 위 수는 파일의 모든 줄을 센 것이다. 현재 parser(v3)가 남기는 메시지만 보면 transcript 228개, 붙어 있는 쌍 6,818개에서 시각 역전 0, 같은 밀리초 0이다. 시각이 거꾸로 간 줄은 parser가 버리는 줄이다. 그래서 대화 순서는 `occurred_at`이다(`../change-drop-message-seq/`).
- **줄 나누기:**
  - Node `readline`으로 줄을 나누면 JSON 문자열 안의 U+2028, U+2029, CR에서 줄이 잘못 끊긴다.
  - 그래서 `\n`으로만 나눈다.
- **이미지:**
  - 항상 base64로 줄 안에 들어 있다(`source.type: base64`). 형식은 png와 jpeg이고, 블록 하나가 최대 약 658KB다.
  - 사용자가 붙여 넣은 이미지는 `user` 메시지 안에 있다(11건). 이때 그 항목에 `imagePasteIds`가 붙는다.
  - 도구가 만든 스크린샷은 `tool_result` 안에 있다(30건).
- **파일 첨부:**
  - @로 지정한 파일과 편집한 파일은 블록이 아니라 별도의 `attachment` 항목이다.
  - 종류는 `file`(파일 이름·표시 경로·내용, 5건), `edited_text_file`(스니펫), `compact_file_reference` 등이다.
  - PDF나 문서 블록(`document`)은 한 건도 없었다.
