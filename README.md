# second-brain

Mac 한 대를 위한 개인 두뇌입니다. 원본은 로컬 SQLite 파일 하나에 들어 있고,
`brain` CLI는 `second_brain` SDK를 얇게 감싼 껍데기입니다. 이 저장소는 npm에
올리지 않습니다.

## 설치

두 가지 길이 있습니다. Claude Code를 쓴다면 플러그인이 더 쉽습니다. 둘 다 같은
설치기를 돌리고 같은 `~/.second_brain`을 만듭니다.

### Claude Code 플러그인으로

이 저장소를 로컬 marketplace로 등록하고 플러그인을 켜면 됩니다.

```sh
claude plugin marketplace add /path/to/second-brain
claude plugin install second-brain@second-brain
```

그다음 세션을 시작하면 `SessionStart` hook 하나가 비동기로 돌면서, 아직 설치되지
않았으면 저장소를 `~/.second_brain/app`에 clone하고 의존성을 설치하고 빌드한 뒤
설치기를 돌립니다. 아무것도 묻지 않습니다 — 플러그인을 켠 것이 동의입니다.
끝나면 `{"systemMessage": "…"}` 한 줄만 냅니다.
진행 줄과 git·pnpm의 출력은 `~/.second_brain/log/bootstrap.log`에 쌓입니다.

이 한 줄은 당신이 아니라 모델이 받습니다. 비동기 hook의 stdout은 다음 턴의
맥락으로 들어갈 뿐 화면에는 보이지 않습니다(2026-10-18 실측). 그래서 문장은
"Brain을 `<짧은 sha>`로 설치했습니다. 이것을 사용자에게 한 줄로 전해 주세요"처럼
모델이 당신에게 옮기도록 쓰여 있습니다. 확실하게 보고 싶으면 `brain doctor run`의
`plugin` 점검이 마지막 설치가 언제 끝났는지, 또는 어느 단계에서 멈췄고 까닭이 어느
로그에 있는지 말합니다.

이 hook은 PATH를 믿지 않습니다. hook은 Claude Code의 환경을 그대로 물려받고, GUI로
띄운 Claude Code의 PATH에는 `nvm`도, 때로는 Homebrew도 없습니다. 그래서 런처가
node를 직접 찾습니다. shim에 박힌 node → `nvm`의 24.16.0 이상 중 가장 높은 버전 →
`/opt/homebrew/bin` → `/usr/local/bin` 순서입니다. 하나도 못 찾으면 아무것도 하지
않고, 어디를 찾아봤는지 한 줄로 말하고 끝납니다. 세션은 그대로 시작됩니다.

두 번째 세션부터는 `~/.second_brain/installed.json`의 commit과 플러그인의
`app-ref`를 비교만 합니다. 같으면 git도 pnpm도 부르지 않고 조용히 끝납니다.
플러그인이 더 새 commit을 담고 있으면 그것으로 fast-forward하고 설치기를 다시
돌립니다 — 그것이 업그레이드입니다.

세션마다 hook은 자기를 부른 플러그인 폴더를 `~/.second_brain/run/plugin.json`에
적어 둡니다.

```json
{
  "plugin_root": "/Users/me/.claude/plugins/cache/second-brain/second-brain/0.1.2",
  "app_ref": "10a09d2ef60fcf3b607f8562192c2ea8a59d3981",
  "seen_at": "2026-10-18T02:12:27.381Z",
  "last_bootstrap": {
    "at": "2026-10-18T02:13:04.902Z",
    "result": "installed",
    "log": "/Users/me/.second_brain/log/bootstrap.log"
  }
}
```

플러그인 캐시는 버전마다 폴더가 다르고(`~/.claude/plugins/cache/<마켓플레이스>/<플러그인>/<버전>/`,
옛 폴더도 남습니다) 완료 기록의 `plugin_root`는 "마지막으로 설치한 폴더"일
뿐이므로, `claude plugin update` 뒤에 `[update] auto`가 꺼져 있으면 그 폴더는
아무도 부르지 않는 옛 버전입니다. 이 기록이 있어야 `brain doctor run`이 지금
부르고 있는 폴더를 보고 `UPDATE_AVAILABLE`을 말할 수 있습니다. 기록이 없거나
읽히지 않으면 doctor는 지금까지처럼 완료 기록의 폴더를 봅니다 — 옛 설치와 npx
설치는 그대로 동작합니다. 적을 폴더와 commit이 이미 적힌 것과 같으면 파일을 다시
쓰지 않으므로, 아무것도 하지 않는 세션은 디스크를 건드리지 않습니다.

플러그인이 바뀌었는데 갱신하지 않기로 한 세션은 — `[update] auto`가 꺼져 있을
때입니다 — 그 한 번만 `git -C ~/.second_brain/app fetch origin`을 합니다.
doctor는 두 commit 중 어느 쪽이 조상인지 이 클론에 묻는데, 플러그인이 가리키는
commit은 마지막 설치 뒤에 push된 것이라 가져오지 않으면 클론에 없고, 그러면
doctor는 "관계를 알 수 없습니다"밖에 말할 수 없습니다. 체크아웃은 건드리지 않고
HEAD도 움직이지 않습니다. 실패해도 로그 한 줄로 끝입니다.

아무것도 하지 않기로 한 경우에는 아무 말도 하지 않습니다. 다른 세션이 설치 중일
때, 플러그인이 설치된 것보다 오래되었을 때, 이력이 갈라졌을 때, `[update] auto`가
꺼져 있을 때입니다. 비동기 hook의 stdout은 다음 턴에 모델의 맥락으로 가므로, 매
세션 같은 줄을 넣는 대신 `brain doctor run`의 `plugin` 점검이 말합니다.

### npx로

[Node](https://nodejs.org) 24.16 이상과 git만 있는 Mac에서:

```sh
npx github:gmae199boy/second-brain
```

커밋되어 있는 의존성 없는 파일 하나가 실행됩니다. node와 git을 확인하고, 이
저장소를 `~/.second_brain/app`에 클론하고(다음 실행에서는 fast-forward),
pnpm이 12보다 오래되었으면 최신 pnpm 설치를 제안하고, 클론을 빌드한 뒤
설치기를 시작합니다. `~/.second_brain/app` 안에서 당신이 바꾼 것은 되돌리거나
버리지 않습니다. 그 폴더가 이 저장소의 깨끗한 클론이 아니면, 그렇다고 말하고
멈춥니다.

기본값을 바꾸는 환경 변수는 둘입니다.

| 변수 | 기본값 | 하는 일 |
| --- | --- | --- |
| `SECOND_BRAIN_HOME` | `~/.second_brain` | 설정과 클론이 들어가는 곳 |
| `SECOND_BRAIN_REPO` | `https://github.com/gmae199boy/second-brain.git` | 클론할 저장소. 포크나 시험용 |
| `SECOND_BRAIN_NODE_DIRS` | `/opt/homebrew/bin:/usr/local/bin` | node를 찾아볼 고정 폴더들. 시험용 |

설치할 데이터베이스 서버도, 띄울 Docker도 없습니다. 원본은 SQLite 파일 하나에
삽니다. 설치기가 값을 묻는 것은 둘뿐입니다.

- **데이터베이스 파일을 어디에 둘지.** 절대 경로면 무엇이든 되고, 기본값은
  `~/.second_brain/brain.db`입니다. 마이그레이션 전에 파일을 mode 0600으로
  만들므로 파일도, 그 write-ahead log도 다른 사람이 읽을 수 없습니다. 만들어야
  했던 상위 폴더는 0700으로 만듭니다.
- **미러 폴더를 어디에 둘지.** 절대 경로면 무엇이든 되고, 기본값은
  `~/.second_brain/mirror`입니다. 아직 그 폴더를 만드는 것은 없습니다.

파일 저장소 루트는 묻지 않습니다. 기록된 값이 있으면 그것을, 없으면
`~/.second_brain/files`를 씁니다.

그다음 임베딩을 켤지 묻는데, 이것은 여전히 "아직 지원하지 않습니다"라서 켠다고
답해도 그렇게 말하기만 하고 아무것도 쓰지 않습니다.

그다음 자동 업데이트를 켤지 묻습니다. 이것은 실제로 쓰이는 값입니다 —
`config.toml`의 `[update] auto`이고, 플러그인의 `SessionStart`가 더 새 앱을 설치해도
되는지를 그 값으로 판단합니다. 기본값은 켜짐이고, 이미 기록된 값이 있으면 그것을
기본값으로 내놓습니다. 터미널이 없으면 묻지 않고 기록된 값(없으면 켜짐)을 씁니다.
꺼 두면 플러그인이 더 새 commit을 담고 있어도 아무것도 하지 않고, `brain doctor
run`이 `UPDATE_AVAILABLE` 경고로 알려 줍니다.

마지막으로, 아직 아무것도 쓰지 않은 자리에서 쓸 것을 다 보여 주고 한 번
묻습니다. 설정 두 파일, 데이터베이스 파일(새로 만드는지 있는 파일을
마이그레이션하는지), 파일 저장소 루트, shim의 경로입니다. 여기서 아니요라고
답하면 — 또는 그 앞의 어느 질문에서 Ctrl-C를 누르면 — 한 바이트도 쓰지 않고
`SETUP_CANCELLED`로 끝납니다. 뒤 질문에서 누른 Ctrl-C는 그 자리에서 멈추므로,
그때까지 밟은 단계는 그대로 남습니다. `--yes`는 이 질문을 건너뜁니다 — 경로
질문은 그대로 묻습니다. 하네스를 연결할지는 뒤에서 따로 묻습니다.

그 동의 바로 뒤에, 하나 더 묻는 경우가 있습니다. 마이그레이션 0005가 프로젝트
비교 키를 UNIQUE로 만드는데, remote의 **대소문자만 다른** 프로젝트로 갈라진
데이터베이스는 그 키가 하나로 겹칩니다(GitHub·Bitbucket은 소유자와 저장소
이름을 대소문자 없이 봅니다). 그래서 설치는 겹치는 묶음마다 그 묶음의
`remote_identity`를 하나씩 세션 수와 함께, 그리고 남을 쪽을 보여 주고 합칠지
묻습니다(한 묶음에 셋 이상일 수도 있습니다). 합치면 지는 쪽의
워크트리·세션·로그가 남는 쪽으로 옮겨지고(같은 경로의 워크트리는 하나로
합쳐집니다) 지는 프로젝트 행이 사라집니다 — 세션은 하나도 잃지 않습니다.
아니요라고 답하면 `SETUP_CANCELLED`(exit 1)이고 데이터베이스는 **한 바이트도**
바뀌지 않습니다: 0005를 적용하지 않았으므로 스키마 버전도 그대로입니다.
합치기와 0005는 한 트랜잭션이라 함께 되거나 함께 안 됩니다. `--yes`는 "미리 준
모든 동의"이므로 이 물음에도 동의가 되고(플러그인의 비대화형 bootstrap도
마찬가지입니다) 묶음은 그래도 다 찍힙니다. 겹침이 없으면 묻지 않습니다.

동의한 다음에는 데이터베이스 파일을 만들어 마이그레이션하고, 이 brain의 주인을
기록하고, 파일 저장소 루트를 mode 0700으로 만들고, **그다음에** 설정을 씁니다.
이 순서인 이유는 설정에 적히는 경로가 이 실행이 실제로 쓸 수 있다고 확인한
경로여야 하기 때문입니다. 셋 중 하나라도 실패하면 `config.toml`과 `.env`는 한
바이트도 바뀌지 않습니다. 그다음 shim을 쓰고(아래), 찾은 하네스를 연결할지 물은
뒤, `brain doctor run`과 같은 점검으로 마칩니다. exit 0이면 모든 점검이
통과했다는 뜻입니다. 점검에 `fail`이 하나라도 있으면 `SETUP_INCOMPLETE`이고,
그래도 doctor는 끝까지 돌고 그 줄을 다 찍습니다.

마지막 단계는 이 프로세스 밖에서 설치를 확인하는 것입니다. `<home>/bin/brain
guide schema --json`을 실제로 실행해서 exit 0과 `ok: true` 엔벨로프를 받아야
합니다. 하네스 hook이 brain에 닿는 길이 그것뿐이고, doctor는 이 프로세스 안에서
부품이 제자리에 있는지만 말할 수 있기 때문입니다. 이것이 통과하지 못하면
`SETUP_INCOMPLETE`(exit 1)이고 완료 기록을 쓰지 않습니다.

통과하면 `<home>/installed.json`을 temp+rename으로 씁니다(mode 0644).

```json
{
  "commit": "10a09d2ef60fcf3b607f8562192c2ea8a59d3981",
  "schema_version": 6,
  "node": "/opt/homebrew/bin/node",
  "plugin_root": "/Users/me/.claude/plugins/cache/second-brain/second-brain/0.1.0",
  "installed_at": "2026-10-17T15:11:42.113Z"
}
```

`commit`과 `schema_version`은 `apps/cli/dist/build.json`에서 옵니다. 그 파일은
`apps/cli`의 빌드가 `tsc` 뒤에 쓰는 `{commit, schema_version}`이고, `commit`은
`git rev-parse HEAD`(git이 없으면 `null`)입니다. `dist/`는 git에 들어가지 않으므로
"이 `dist/`가 어느 소스에서 왔는가"에 답할 수 있는 것은 이 파일뿐입니다.
`node`는 shim에 고정한 node 경로이고, `plugin_root`는 `--plugin-root`가 가리킨
폴더(없으면 이전 기록의 값, 그것도 없으면 `null`)입니다.

이 두 파일도, 위의 `run/plugin.json`도 설정이 아니므로 설정 코덱을 지나지
않습니다(AD-18). 설정은 사람이 고르고 고칠 수 있는 것이고, 이것들은 이 기계가 한
일입니다. 읽을 수 없으면 고치지 않고 "모른다"로 답합니다.

데이터베이스 파일로 가리킨 자리에 SQLite 데이터베이스가 아닌 파일이 있으면
`DB_UNAVAILABLE`로 거절합니다. 첫 16바이트를 보고 판정하며, 그 전에는 mode도
내용도 건드리지 않고 write-ahead log도 옆에 만들지 않습니다. 0바이트 파일은 새
데이터베이스로 봅니다.

다시 실행해도 바뀌는 것은 없습니다. 기록된 경로를 기본값으로 내놓고, 파일이 이미 가진 마이그레이션은 적용하지 않고, 마이그레이션이
쓴 index config 행을 그대로 두고, 주인을 그대로 두고, shim과 하네스 항목이 이미
맞게 적혀 있으면 건드리지 않습니다. 다른 데이터베이스 파일을 가리키면 새로
만듭니다. 옛 파일은 있던 자리에 그대로 있고, 설치는 그렇다고 한 줄로 말합니다.

물어볼 터미널이 없는 곳 — 스크립트나 CI — 에서는 `--yes`가 동의이고 나머지는
플래그로 말합니다. `--yes`가 없으면 설치는 아무것도 쓰기 전에 멈추고 exit 3,
"아무도 주지 않은 확인"으로 끝납니다. 명령이 틀린 것도 아니고 무엇이 망가진
것도 아닙니다. 실행하는 사람에게 던지는 질문입니다.

```sh
node apps/cli/dist/install.js --yes
node apps/cli/dist/install.js --store-path /Volumes/notes/brain.db --yes
```

터미널이 없으면 아무것도 묻지 않으므로 각 경로는 기록된 값(없으면 기본값)을
지키고, `--connect`가 이름을 대지 않은 하네스는 연결되지 않습니다.

| 플래그 | 하는 일 |
| --- | --- |
| `--store-path <경로>` | 데이터베이스 파일의 절대 경로 |
| `--mirror-path <경로>` | 미러 폴더의 절대 경로 |
| `--plugin-root <경로>` | 이 설치를 시작한 플러그인 폴더의 절대 경로. 완료 기록에 적힙니다 |
| `--connect <하네스>` | 이 하네스를 연결합니다. 여럿이면 되풀이하세요 |
| `--yes` | 설치가 해야 할 일에 미리 동의합니다 |

### 이미 있는 설정은 지킵니다

설정은 값마다 따로 읽습니다. 값 하나를 쓸 수 없으면 그 키만 버리고 기본값을
쓰면서 `CONFIG_VALUE_RESET` 경고를 냅니다 — 어떤 키였고, 무엇이 적혀 있었고,
대신 무엇을 쓰는지 말합니다. 나머지 값은 그대로 남습니다. `store.path` 오타
하나로 당신이 고른 시간대와 파일 저장소 루트와 미러까지 기본값으로 돌아가지
않습니다. `schema_version`이 없거나 정수가 아니면 같은 경고를 내고 1로 씁니다.

이 버전이 모르는 키는 값 그대로 다시 씁니다. `CONFIG_UNKNOWN_KEY` 경고로 "쓰지는
않고 그대로 둔다"고 말하고 지우지는 않으므로, 뒤 에픽이 쓰는 키를 손으로 미리 적어 두어도 설치가 그것을
삼키지 않습니다. 알려진 테이블 안의 모르는 하위 키도 그렇습니다. 같은 이름이
겹치면 알려진 키가 이깁니다.

파일을 통째로 읽을 수 없으면 — 읽기 실패, TOML이 아님, TOML 테이블이 아님,
`schema_version`이 1이 아닌 정수 — 아무것도 쓰지 않고 `CONFIG_INVALID`(exit 2)로
멈춥니다. 더 새 버전일 수 있는 파일을 이 버전의 기본값으로 덮는 것보다, 고치라고
멈추는 쪽이 되돌릴 수 있습니다.

## 이 brain은 누구의 것인가

설치는 `users`에 주인 행 하나를 기록합니다. 이름은 설치기를 실행한 계정에서
가져오고, 이후 수집되는 모든 세션이 그 행을 가리킵니다. 마이그레이션이 아니라
설치 단계인 이유는 SQL이 그 두 가지를 다 하지 못하기 때문입니다. 운영체제의
사용자 이름을 읽을 수 없고, UUIDv7을 만들 수도 없습니다.

한 번 정해지면 끝입니다. 두 번째 설치는 `이미 <이름>의 것입니다`라고 말하고
아무것도 바꾸지 않습니다 — 같은 id, 같은 이름 — 그래서 다른 기계로 복사한
데이터베이스는 그 기계의 계정 이름이 무엇이든 처음 만들어진 사람을 그대로
지킵니다. 두 brain을 합치는 일과, 더 이상 맞지 않는 이름을 어떻게 할지는 import
에픽의 몫입니다.

테이블은 있는데 주인 행이 없는 데이터베이스는 세션을 누구에게도 붙일 수 없으므로
수집은 `USER_MISSING`이라고 말하고 `brain setup run`을 가리킵니다.

## 하네스 세션 읽기

```sh
brain sessions ingest <harness> < 하네스가 보낸 hook 페이로드
```

stdin의 hook 페이로드를 읽고, 그 페이로드가 가리키는 트랜스크립트를 읽어, 아직
저장되지 않은 것을 덧붙입니다. 이 빌드는 `claude-code`를 읽습니다.

페이로드에 `transcript_path`가 없어도 됩니다. 그러면 세션 토큰의 `session_id`로
그 하네스의 트랜스크립트 폴더에서 파일을 찾습니다 — 아래 `## 밀린 일 처리`의
폴더 스캔과 같은 폴더입니다. 폴더를 보지 않는 설정이면(기본) 찾을 곳이 없으므로
`TRANSCRIPT_UNREADABLE`입니다. 읽은 파일은 `transcript_files`에 한 행으로
남습니다. 읽은 바이트 수와 그 바이트의 해시, 그리고 이번 커서입니다. 그래서
다음 스캔은 그 파일이 커졌는지만 보고, 커지지 않았으면 열지 않습니다.

하네스 hook 경로에 있는 유일한 명령이므로 hook 규칙을 전부 따릅니다. 무슨 일이
있어도 exit 0, 잘되면 stdout에 아무것도 없고, 안 되면 stderr에 한 줄. 망가진
brain이 턴을 망치는 일은 없습니다. 같은 트랜스크립트에 두 번 실행하면 두 번째는
아무것도 넣지 않고, 두 복사본이 경쟁해도 대화는 둘 사이에서 정확히 한 번만
들어갑니다.

저장하는 것은 대화, 그리고 대화뿐입니다. 사람의 턴과 모델의 답입니다. 사고,
도구 호출, 도구 결과, 편집기 자신의 알림, 서브에이전트의 대화, compact 요약은
모두 트랜스크립트에 있지만 그중 어느 것도 대화의 턴이 아닙니다.

비밀은 **저장할 때가 아니라 나갈 때** 가립니다. 수집은 본문과 도구 메모 대상을
하네스가 쓴 그대로, 글자 단위로 같게 저장합니다. 저장된 메시지는 다시 쓰지
않으므로, 패턴이 한 단어라도 더 가리면 되돌릴 수 없기 때문입니다. 대신 Brain
밖으로 나가는 자리마다 Core의 출력 코덱이 알려진 비밀 패턴을 `[REDACTED:<종류>]`로
바꿉니다 — `--json` 엔벨로프(CLI·소켓·MCP가 함께 쓰는 자리), 사람이 읽는 줄,
hook이 내는 줄입니다. 도구 메모 대상은 셸 `NAME=value` 규칙도 함께 받고,
파서가 500자에서 자른 대상은 마지막 토큰까지 가립니다(잘린 자리에 걸친 키의
앞부분이 그대로 나가지 않게 하려는 것입니다). 가린 표시는 다시 잡히지 않아서
두 번 거쳐도 결과가 같습니다.

그래서 수집 결과의 `inserted`에는 `messages`와 `toolNotes`만 있습니다
(`redactions` 키는 없습니다 — 수집은 가리기 기록을 남기지 않습니다). 도구 메모
대상은 파서가 자른 그대로, 첫 줄의 500자까지 저장됩니다. commander가 내는
도움말과 설치기의 질문 화면은 등록부의 정적 문구와 경로뿐이어서 코덱 밖입니다.

그래서 데이터베이스 파일에는 비밀이 원문으로 남습니다. 그 파일을 지키는 것은
권한 0600과 "동기화 폴더에 두지 않기"입니다. 저장본에서도 지우려면
`brain messages redact`를 쓰세요(아직 없습니다 — 뒤 스토리입니다).

메시지에는 번호가 없습니다. 메시지를 가리키는 것은 하네스가 준
`(session_id, harness_message_id)` 하나뿐이어서, 앞부분이 다시 쓰인
트랜스크립트 — compact, fork — 에서도 저장된 메시지가 다른 메시지로 바뀌지
않습니다. 대화 순서는 발화 시각(`occurred_at`)입니다. 그래서 파서 버전이 올라
대화 중간의 줄을 새로 남기게 되면, 그 메시지는 나중 수집으로 들어와도 읽을 때는
제자리에 놓입니다. 같은 시각 두 메시지의 순서는 정하지 않습니다.

세션이 시작한 이유(`sessions.start_source`)는 트랜스크립트의 **첫**
`SessionStart` 첨부에서 오고, 한 번 저장되면 바뀌지 않습니다. 한 트랜스크립트는
시작마다 첨부가 하나씩 쌓이므로(`startup` 뒤의 `resume`, compact 뒤의
`compact`), 마지막 값은 "그 뒤에 무슨 일이 있었나"이고 이 칸이 답하는 것은 "왜
시작했나"입니다.

데이터베이스에 쓸 수 없을 때 — 다른 프로세스가 쓰기 잠금을 예산보다 오래 쥐고
있을 때, 파일이 없을 때, 저장된 스키마 버전이 이 빌드의 것과 다를 때 — 턴은
실패하지 않습니다. "이 세션을 다시 수집할 것" 한 줄이 `~/.second_brain/spool/`에
남고, 명령은 `warnings`에 `SPOOLED`를, `data.spooled`에 `true`를 담아 성공으로
답합니다. 트랜스크립트는 그 줄에 복사하지 않습니다 — 다시 읽으면 그동안 늘어난
것까지 들어오므로, 복사본은 쓰는 순간부터 낡은 것입니다. 스키마 버전이 어긋나면
수집 본문은 아예 불리지 않습니다. 그래서 어긋난 데이터베이스에 쓰기가 닿을 길이
구조적으로 없습니다.

spool은 프로세스마다 새 파일(JSON Lines)이고, 다 쓴 뒤 이름을 바꿔야 비로소
다른 프로세스가 집습니다. 두 프로세스가 한 파일에 함께 쓰는 일은 없습니다.
기다리는 건수와 가장 오래된 시각은 `brain doctor run`의 `spool` 줄이 보여 줍니다.
그 줄을 다시 넣는 것은 `brain queue drain`의 첫 단계입니다(아래
`## 밀린 일 처리`).

아직 hook을 등록하는 것은 없습니다. Claude Code 플러그인은 뒤 스토리입니다.
실제 대화 하나가 들어가는 것을 보고 싶으면 `tooling/dev/tracer-session.sh`가
임시 폴더에 버려도 되는 brain을 설치하고 Stop hook이 그것을 가리키는 설정
파일을 쓴 뒤, 실행할 `claude --settings …`를 알려 줍니다. 당신의
`~/.claude/settings.json`이나 `~/.second_brain`은 건드리지 않습니다.

## 밀린 일 처리

```sh
brain queue drain [--budget <seconds>]
```

밀린 일은 테이블 하나에 쌓입니다. 종류, 대상, 시도 횟수, 다음 시도 시각이 한
행이고, 미완료 행은 (종류, 대상) 하나당 하나뿐입니다. 같은 일을 두 번 넣어도
행은 하나이고, 끝난 행은 그 키에서 빠지므로 같은 일을 다시 부탁하면 새 행입니다.

이 명령은 그 대기열을 시간 예산 안에서 처리합니다. 예산은 기본 30초이고
`--budget`으로 1~3600초 사이를 줄 수 있습니다. 범위 밖이거나 정수가 아니면
`USAGE`입니다. 예산은 **새로 청구할지**를 정할 뿐이어서, 처리 중인 일감을
중간에 끊지는 않습니다.

한 번의 실행은 세 단계입니다. 셋은 예산 하나를 나눠 씁니다.

1. **spool 재주입.** 기다리는 파일을 하나씩 집어 줄마다 다시 넣습니다. 들어간
   줄은 빠지고, 들어가지 않은 줄은 시도 횟수를 하나 올리고 다음 시도 시각을
   정해(대기열과 같은 간격: 1초, 2초, 4초… 최대 1시간) 새 파일로 다시 씁니다.
   그 파일은 기다리는 파일들 **뒤로** 가고, 그 시각 전에는 집히지 않습니다.
   그래서 계속 실패하는 줄 하나가 그 뒤에 쓰인 줄들을 막지 않고, 명령 열 번
   만에 열 번의 시도를 다 써 버리지도 않습니다. 데이터베이스에 쓸 수 없으면 그 파일을 그대로 되돌리고 거기서
   멈춥니다 — 시도 횟수도 그대로입니다. 열 번째 실패에서는 `failures`에 한 행을
   남기고 그 줄을 `~/.second_brain/spool/failed/`로 옮깁니다. 읽을 수 없는
   줄(깨진 JSON, 모르는 버전·종류)도 곧바로 거기로 갑니다 — 한 줄이 그 뒤의
   모든 줄을 영원히 막지 않게요. `failed/`의 줄은 지우지 않습니다. 작업 로그나
   주입 기록은 다시 읽을 원본이 없기 때문입니다. 건수는 doctor가 보입니다.
2. **transcript 폴더 스캔.** 폴더의 목록을 `transcript_files` 내역과 비교해,
   행이 없거나 크기가 다른 파일마다 `session_ingest` 일감을 하나 넣습니다
   (오래된 것부터). 이미 열린 일감이 있는 세션과, `session_ingest`가 미해결
   실패로 남은 세션은 건너뜁니다 — 뒤쪽은 `brain failures retry`가 다시
   부탁하는 몫입니다. 바뀐 것이 없으면 쓰기를 아예 부르지 않습니다. 목록 →
   내역 → 열린 일감 → 미해결 실패, 이 넷은 모두 잠금 없는 읽기입니다.
3. **대기열 처리.** 위 규칙대로 남은 예산 안에서 일감을 청구하고 처리합니다.

그래서 이 빌드의 일감 종류는 하나입니다. `session_ingest`, 세션 하나를 다시
수집하는 일입니다. 스캔이 찾은 세션은 같은 실행에서 수집되므로, 새로 설치한
brain에서 `brain queue drain` 한 번이 디스크에 남은 세션을 모두 거둡니다
(`ingest_source`는 `import`입니다). 조각·색인 만들기와 미러 갱신은 뒤 에픽에서
종류를 하나씩 더합니다. 종류를 모르는 일감은 청구하지 않습니다 — 새 빌드가 넣은
일감을 옛 빌드가 지우지 않게 하려고요.

**실제 폴더는 기본으로 보지 않습니다.** 환경 변수 `SECOND_BRAIN_CAPTURE=1`일
때만 하네스 폴더를 봅니다(Claude Code는 `CLAUDE_CONFIG_DIR`, 없으면
`~/.claude`). 끄면 스캔, 토큰만으로 트랜스크립트 찾기, doctor의 `transcripts`
점검이 모두 꺼집니다. hook이 경로를 알려 준 수집은 이 스위치와 무관합니다.
플러그인 hook을 등록하는 스토리가 이 스위치를 없애고 기본으로 켭니다.

세 번째 단계는 이렇게 돕니다. 쓰기 잠금을 잡기 전에 잠금 없는 읽기로 할 일이
있는지 먼저 봅니다 — 할 일이 없으면 쓰기를 아예 부르지 않습니다. 있으면 짧은
쓰기 트랜잭션 하나로 한 행을 청구하고(시도 횟수는 이때 올라갑니다), 트랜잭션
밖에서 처리합니다. 끝내기는 청구가 아직 내 것일 때만 바뀝니다. 청구 기간이
지나 다른 실행이 그 행을 가져갔다면 늦게 온 답은 아무것도 바꾸지 않습니다.
그래서 두 프로세스가 같은 대기열을 비워도 일감은 정확히 한 번 처리됩니다.

실패는 분류에 따라 다르게 다룹니다.

- **데이터베이스에 쓸 수 없음**(`DB_UNAVAILABLE`·`DB_LOCKED`·`SCHEMA_MISMATCH`)은
  실패가 아닙니다. 일감을 그대로 돌려주고(시도 횟수도 되돌립니다) 그 실행을
  멈춥니다.
- **영구 오류**(다시 해도 안 되는 것)는 첫 실패에서 바로 기록하고 행을 닫습니다.
- **외부 일시 오류**는 상대가 알려 준 시각까지, 알려 주지 않았으면 15분 뒤에
  다시 합니다.
- **분류를 모르는 오류**는 1초, 2초, 4초… 1시간까지 늘려 가며 다시 합니다.
  일감이 던진 예외도 여기입니다 — 한 일감의 버그가 처리 전체를 죽이지 않습니다.
- 일시 오류와 모르는 오류는 **열 번**째 시도에서 기록하고 행을 닫습니다.

기록은 실패 테이블 한 행입니다. 키는 (대상 종류, 대상, 단계, fingerprint)이고
fingerprint는 (단계, 대상, 분류 코드)의 해시입니다 — 오류 문장·시각·경로는
들어가지 않습니다. 그래서 같은 원인이 백 번 나도 행은 하나입니다. 같은 원인이
다시 나면 그 행이 다시 열리고(해결 표시가 지워지고) 시각과 문장이 방금 것으로
바뀝니다. 그래서 그 행의 시각은 마지막으로 난 때입니다. 저장되는 오류 문장은 비밀을 가린 뒤
8192바이트 이하로 자릅니다. payload는 남기지 않습니다. 실패 기록 자체를
데이터베이스가 받지 못하면 그 내용이 spool로 가고 그 실행은 멈춥니다.

hook이 아닌 명령은 **끝에서 한 번 더** 짧게(2초) 이것을 돕니다. hook 없는
하네스에서는 사람이 부른 명령의 끝이 밀린 일을 처리할 유일한 순간이기 때문입니다.
명령이 성공했고 스키마 버전이 맞을 때만 돌고, 결과도 종료 코드도 바꾸지
않습니다. `queue drain` 자신은 이것을 끕니다.

## 실패 보기와 다시 하기

```sh
brain failures list [--target-kind <kind>] [--all] [--limit <n>]
brain failures retry [--target-kind <kind>]
```

실패 테이블은 **기록이고 대기열이 아닙니다**. `failures list`는 읽기만 하고,
기본은 아직 해결되지 않은 것만, 최신 순입니다. `--all`이면 해결된 것도 냅니다.
`--limit`은 1~1000이고 기본 100이며, 범위 밖이면 `USAGE`입니다. `--json`에서는
`data.failures[]`와 `meta.count`·`meta.has_more`이고, 텍스트 모드는 실패마다 한
줄과 끝에 건수 줄입니다.

행마다 **처음 난 때**(`first_occurred_at`)와 **횟수**(`occurrences`)가 함께
옵니다. 같은 원인은 한 행이고 `occurred_at`·`message`는 마지막 occurrence의
것이므로, 이 둘이 없으면 열 분마다 일주일째 나는 실패와 방금 한 번 난 실패가
똑같이 보입니다. 텍스트 줄에는 `횟수 N`으로 들어갑니다.

`failures retry`는 미해결 실패의 **대상마다** 일감을 하나 넣습니다. 한 대상이 세
단계에서 실패했어도 일감은 하나입니다. 대상 종류에 맞는 일감 종류는 Core의 표가
정합니다(지금은 세션 → `session_ingest` 하나뿐). 표에 없는 종류는 건너뛰고
`skipped`로 몇 건이었는지 알려 줍니다 — 아무도 처리하지 않을 일감을 넣는 것보다
그렇게 말하는 편이 낫습니다.

실패 행은 이 명령이 바꾸지 않습니다. 해결 표시를 채우는 것은 그 일감이 실제로
성공하는 일입니다. 명령 끝의 기회적 drain이 곧바로 그 일감을 처리하므로, 보통
`failures retry` 한 번으로 목록이 비워집니다.

## 다시 설정하기, 하네스 연결하기

설치기는 명령이기도 하므로 클론에서 다시 실행할 것은 없습니다.

```sh
brain setup run [--store-path <path>] [--mirror-path <path>] \
                [--connect <harness>]… [--yes]
brain setup connect <harness>
```

`brain setup run`은 같은 흐름을 같은 순서로 밟고, 몇 번 실행해도 결과가 같고,
기록된 값을 기본값으로 보여 줍니다. 설정도 데이터베이스도 없어도 되는 두 명령
가운데 하나이고 — 설정을 쓰는 쪽이 이 명령이니까요 — `--json`을 붙이면 흐름이
한 일을 구조화된 보고로 돌려줍니다. 찍힌 줄이 아니라 사실입니다. 줄을 거꾸로
파싱해 무슨 일이 있었는지 알아낼 필요가 없습니다.

```json
{
  "ok": true,
  "warnings": [],
  "data": {
    "home": "/Users/me/.second_brain",
    "config_path": "/Users/me/.second_brain/config.toml",
    "store": { "path": "/Users/me/.second_brain/brain.db", "schema_version": 6, "applied": [] },
    "owner": { "name": "me", "created": false },
    "files": { "path": "/Users/me/.second_brain/files", "created": false },
    "mirror_path": "/Users/me/.second_brain/mirror",
    "shim": { "path": "/Users/me/.second_brain/bin/brain", "changed": false },
    "harnesses": [],
    "checks": [{ "id": "db", "status": "ok", "detail": "3.50.4" }],
    "summary": { "passed": 10, "warned": 0, "failed": 0, "skipped": 0 }
  }
}
```

실패는 `ok: false`입니다. 끝 점검에 `fail`이 있거나 커넥터가 하나라도 거절하면
`error`가 붙고, `error.exit_code`는 프로세스의 종료 코드와 같은 숫자입니다.
설치가 끝까지 돌았는데 점검이 실패한 경우는 `SETUP_INCOMPLETE`, 커넥터가 거절한
경우는 그 커넥터 자신의 코드입니다. 읽는 쪽이 `ok`를 보고 성공을 판단하면
됩니다 — 예전처럼 exit 1인데 `ok: true`인 응답은 없습니다.

`--json`은 터미널이 없는 실행과 똑같이 비대화형으로 돕니다. 아무것도 묻지
않으므로 `--yes`가 필요합니다. 없으면 아무것도 쓰지 않고, 엔벨로프가 무엇을
실행하면 되는지 말합니다.

```json
{
  "ok": false,
  "warnings": [],
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "터미널이 아니어서 아무것도 물을 수 없습니다. --yes로 미리 동의하세요",
    "exit_code": 3,
    "retryable": false,
    "hint": "사람에게 진행해도 되는지 묻고, 그렇다고 할 때만 같은 명령에 `--yes`를 붙여 다시 실행하세요",
    "retry": { "ns": "setup", "verb": "run", "args": { "confirm": true } },
    "retry_argv": ["brain", "setup", "run", "--yes", "--json"]
  }
}
```

`retry`는 같은 호출에 동의를 더한 것이고, 그 이상은 아닙니다. 당신이 준
플래그는 그 안에 담기고, 주지 않은 기본값은 담기지 않습니다. `retry_argv`는 그
호출을 명령줄로 적은 것입니다. 둘이 있는 이유는 동의를 한 번, 사람에게 물을 수
있게 하려는 것입니다 — 이것을 읽는 무엇이 알아서 붙이게 하려는 것이 아닙니다.

`brain setup connect <harness>`는 이 brain을 하네스 하나에 등록합니다. 설치
뒤에 설치한 하네스를 위한 것입니다. 쓰는 항목에는 Brain 표시가 붙고, "이미
연결됨"은 오직 그 표시로만 판단하므로 두 번 실행해도 등록은 한 번이고(두 번째는
`changed: false`) 당신이 그 파일에 직접 넣은 것은 건드리지 않습니다. shim이
없으면 `SHIM_MISSING`이라고 말하고, 이름이 이 빌드가 아는 하네스가 아니면 아는
하네스를 대면서 exit 2로 끝납니다. 동사 뒤에 치는 모든 인자는 id입니다 —
본문은 stdin으로 읽고 인자로 치지 않습니다 — 그래서 비어 있거나 제어 문자·보이지
않는 문자를 품은 인자는 무엇을 읽기 전에 `USAGE`로 거절합니다. 빈 인자는 거의
언제나 아무것도 내놓지 못한 `$(…)`이고, 그것을 찾아보면 망가진 명령줄에
"없습니다"라고 답하게 됩니다. 이 빌드는 아직 아는 하네스가 없습니다. Claude
Code 커넥터는 뒤 에픽이라서 `brain setup run`은 연결할 하네스가 없다고 말하고
넘어갑니다.

## 종료 코드

| 코드 | 뜻 | 에이전트 행동 |
| --- | --- | --- |
| `0` | 잘되었습니다 | `data`를 그대로 쓰세요 |
| `1` | 실행했고 실패했거나 degraded로 끝났습니다 | `warnings[]`와 `error`를 읽고, `error.retryable`이 참일 때만 같은 명령을 다시 실행하세요 |
| `2` | 아예 실행할 수 없었습니다: 명령줄, 설정, 또는 데이터베이스가 없음 | 같은 명령을 다시 실행하지 말고, `error.hint`가 가리키는 것을 먼저 고치세요 |
| `3` | 아무도 주지 않은 확인이 필요합니다 | 사람에게 진행해도 되는지 묻고, 그렇다고 할 때만 `error.retry`가 말하는 대로 다시 부르세요. 스스로 동의하지 마세요 |
| `hook` | 하네스 hook 경로의 명령은 무슨 일이 있어도 0으로 끝납니다 | 종료 코드로는 실패를 알 수 없으니 stderr 한 줄을 읽으세요 |

이 표는 코드에 있는 목록 하나에서 나오고, `brain guide exit-codes`가 같은 것을
냅니다. 아래 두 표도 그렇습니다 — 표와 코드가 어긋나면 대조 테스트가 실패합니다.

`--json`에서는 같은 숫자가 `error.exit_code`에 있으므로, 엔벨로프를 읽는 쪽은
어느 것이었는지 알려고 셸을 볼 필요가 없습니다. `error.hint`는 무엇을 하면
되는지 말하고, `error.retryable`은 같은 명령을 다시 실행해서 될 일인지 말합니다
— 사용법 실수에는 `false`, 남이 들고 있는 잠금에는 `true`, 경우에 따라 다르면
아예 없습니다.

stderr에 줄이 있다는 것은 실패 신호가 아닙니다. 경고 줄과 `hint`도 그리로
가므로, 잘되었는지는 종료 코드로 판단하세요.

하네스 hook 경로의 명령은 무슨 일이 있어도 exit 0입니다. 망가진 brain이 턴을
망치지 않도록(실패는 stderr에 한 줄로 갑니다). exit 3에 부딪힌 hook은 그 일을
하지도, 묻지도 않고 멈춥니다.

### 오류 코드

실패한 명령의 `error.code`입니다. 각 코드가 어느 종료 코드를 쓰는지는 코드 표가
정하고, 실패 하나가 따로 정하지 않으면 그대로 쓰입니다. `error.hint`까지 함께
보려면 `brain guide exit-codes`를 실행하세요. 커넥터는 자기 코드를 쓰므로 이
표에 없는 `error.code`도 올 수 있고, 그때는 exit 1이고 hint가 붙지 않습니다.

| 코드 | exit | 뜻 |
| --- | --- | --- |
| `USAGE` | 2 | 명령을 잘못 불렀습니다 — 모르는 동사, 잘못된 플래그, 쓸 수 없는 인자 |
| `CONFIG_MISSING` | 2 | 이 폴더에 설정 파일이 없습니다 — 설치가 여기서 돈 적이 없습니다 |
| `CONFIG_INVALID` | 2 | 설정은 있고, 그 값 하나를 읽거나 쓸 수 없습니다 |
| `DB_UNAVAILABLE` | 2 | 데이터베이스에 닿지 못했습니다 |
| `DB_LOCKED` | 1 | 다른 연결이 쓰기 잠금을 예산보다 오래 쥐고 있었습니다 |
| `SCHEMA_MISMATCH` | 1 | 저장된 스키마 버전이 이 빌드가 만들어진 버전과 다릅니다 |
| `MIGRATION_FAILED` | 1 | 마이그레이션을 적용하다 데이터베이스가 거절했습니다 |
| `FILES_UNAVAILABLE` | 1 | 파일 저장소 루트를 만들거나 거기에 쓸 수 없었습니다 |
| `SHIM_MISSING` | 1 | 하네스 hook이 부르는 shim 파일이 없습니다 |
| `SETUP_INCOMPLETE` | 1 | 설치는 끝까지 돌았고 마지막 점검이 통과하지 못했습니다 |
| `SETUP_CANCELLED` | 1 | 사람이 설치를 진행하지 않겠다고 답했습니다 |
| `SEARCH_FAILED` | 1 | 검색 자체가 실패해서 보고할 결과가 없습니다 |
| `VERSION_MISMATCH` | 1 | daemon이 이 명령을 낸 빌드와 다른 빌드로 돌고 있습니다 |
| `SESSION_REQUIRED` | 2 | 이 동사는 세션이 필요한데 아무것도 주어지지 않았습니다 |
| `USER_MISSING` | 2 | 이 데이터베이스에 주인 행이 없어서 세션을 누구에게도 붙일 수 없습니다 |
| `CONFIRMATION_REQUIRED` | 3 | 사람의 동의가 필요한 동사인데 아무도 동의하지 않았습니다 |

### 경고 코드

실행은 되었고 결과가 저하된 경우 엔벨로프의 `warnings[]`에 담기는 코드입니다.
조용한 실패는 없습니다.

| 코드 | 뜻 |
| --- | --- |
| `SPOOLED` | 쓰기가 데이터베이스가 아니라 spool로 갔습니다 |
| `DB_UNAVAILABLE` | 데이터베이스에 닿지 못했습니다 |
| `SCHEMA_MISMATCH` | 저장된 스키마 버전이 이 코드가 기대하는 버전과 다릅니다 |
| `RERANK_FAILED` | 다시 순위를 매기려 했고 실패해서, 매기기 전 순서를 그대로 씁니다 |
| `INDEX_CONFIG_MISMATCH` | 행들이 지금 쓰는 것과 다른 색인 설정으로 만들어졌습니다 |
| `UNINDEXED` | 찾아본 자료의 일부에 아직 임베딩이 없습니다 |
| `RESULT_TRUNCATED` | 결과가 크기 한도에 맞춰 잘렸습니다 |
| `RULE_UNVERIFIED` | 규칙이 확인되지 않은 채 포함되었습니다 |
| `CURSOR_RESET` | 커서를 잃어서 파서가 트랜스크립트를 처음부터 읽었습니다 |
| `TRANSCRIPT_LINES_SKIPPED` | 트랜스크립트의 일부 줄을 읽을 수 없어서 건너뛰고 나머지를 수집했습니다 |
| `CONFIG_UNKNOWN_KEY` | 설정 파일에 이 버전이 모르는 키가 있고, 어떤 키를 무시했는지 말합니다 |
| `CONFIG_VALUE_RESET` | 설정 값 하나를 쓸 수 없어서 그 키만 기본값으로 다시 썼습니다 |
| `ATTACHMENT_NOT_REDACTED` | 첨부가 받아야 할 마스킹 없이 저장되었습니다 |
| `FILE_SOURCE_UNREACHABLE` | 이 brain이 가리키기만 하는 파일을 그 자리에서 읽을 수 없었습니다 |
| `DAEMON_UNAVAILABLE` | daemon이 설정되어 있고 닿지 못해서, 이 명령은 직접 돌았습니다 |
| `PLUGIN_NOT_INSTALLED` | 이 brain이 기대하는 하네스 플러그인이 설치되어 있지 않습니다 |
| `PLUGIN_BEHIND` | 설치된 플러그인이 이 명령에 답하는 빌드보다 오래되었습니다 |
| `PLUGIN_DUPLICATE` | 플러그인이 두 벌 이상 설치되어 hook이 두 번 돌 수 있습니다 |
| `UPDATE_AVAILABLE` | 플러그인이 더 새 앱을 담고 있는데 자동 업데이트가 꺼져 있습니다 |

## 규약과 명령 메타

```sh
brain guide schema [<ns> [<verb>]]   # 명령마다 메타 일곱 칸과 인자·옵션
brain guide exit-codes               # 위의 세 표
brain guide show                     # CLI 사용 규약 절(Markdown)
```

모든 명령은 자기 자신에 대해 일곱 칸을 선언합니다. `used_for`(한 줄 설명),
`required`(반드시 줘야 하는 입력 이름), `examples`(명령줄), `output`(`data`의
모양), `risk`(`read`·`write`·`destructive`), `hook`, `dry_run`입니다. `--help`와
`brain guide schema`는 둘 다 그 하나에서 나오므로 어긋날 수 없고, 칸이 빠진
명령은 테스트가 잡습니다.

`brain guide show`는 에이전트가 무엇을 하지 않아야 하는지를 담은 CLI 사용 규약
절을 냅니다. 세 명령 모두 설정도 데이터베이스도 없이 돌므로, 아직 아무것도
설치되지 않은 기계에서도 답합니다.

## shim

설치기는 `~/.second_brain/bin/brain`을 mode 0755로 쓰고, 하네스 hook이 부르는
`brain`은 그것입니다. hook은 당신의 셸 환경을 하나도 물려받지 않으므로 shim은
필요한 모든 것을 리터럴로 품고 있습니다. 설치기를 실행한 `node`(symlink를 다 푼
실제 경로), 그 옆의 빌드된 진입점, 그리고 그 설치의 설정 폴더입니다. `npx`는
부르지 않습니다.

```sh
#!/bin/sh
# Written by second-brain. `brain setup run` rewrites it.
SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-'/Users/me/.second_brain'}; export SECOND_BRAIN_HOME
NODE='/opt/homebrew/bin/node'
BIN='/Users/me/.second_brain/app/apps/cli/dist/bin.js'
# …node를 찾는 sh 함수들…
if [ ! -x "$NODE" ]; then
  if brain_find_node; then
    NODE=$brain_node
    brain_repin
  else
    echo "brain: node …" >&2
    exit 127
  fi
fi
exec "$NODE" "$BIN" "$@"
```

환경에 이미 있는 `SECOND_BRAIN_HOME`이 이깁니다. 그래서 두 번째 설치의 shim이
첫 번째와 다투지 않습니다.

박아 둔 node가 사라졌을 때 — `nvm` 버전을 지웠을 때, Homebrew가 올라갔을 때 —
shim은 조용히 실패하지 않습니다. 플러그인 런처와 같은 찾기 함수로 다른 node를
찾아 그것으로 실행하고, 설치 잠금을 잡을 수 있으면 자기 `NODE=` 줄을
temp+rename으로 바꿔 둡니다. 그래서 다음 hook은 다시 찾지 않습니다. 잠금을
못 잡아도 찾은 node로는 실행합니다 — 다시 찾는 쪽이 느릴 뿐이고, 틀리지는
않습니다. 하한 이상의 node를 하나도 못 찾으면 어디를 찾아봤는지 stderr에 한 줄로
말하고 exit 127입니다.

node 찾기 규칙의 정본은 `apps/cli/src/install/shim.ts`의 상수 하나입니다.
shim과 `plugin/bin/session-start.sh`가 같은 바이트를 담고, 테스트가 둘을
대조합니다.

## 구조

```text
packages/core/          domain types, use cases, ports -- no runtime dependencies
packages/sqlite/        the Store port on the local SQLite source -- the originals
packages/postgres/      the Store port on Postgres + pgvector -- a replica, epic 7
packages/claude-code/   Claude Code connector: the transcript parser and hook I/O
packages/modelstudio/   embeddings and reranking (placeholder)
packages/second_brain/  the one writing surface: re-exports only
apps/cli/               the brain command
tooling/bootstrap/      the install entry point: src/ plus its committed build
plugin/                 the Claude Code plugin: manifest, SessionStart hook, launcher
.claude-plugin/         the local marketplace that offers plugin/
tooling/test-db/        dev-only throwaway test databases
tooling/dev/            dev-only scripts, for checks no test can make
```

## 빌드

```sh
pnpm install && pnpm build
```

복제한 뒤 한 번 커밋 훅을 켜세요. 추가한 줄이나 커밋 메시지에 이 기계의 홈 폴더
절대 경로가 있으면 커밋을 거부합니다. 원격이 공개 저장소이기 때문입니다.

```sh
git config core.hooksPath .githooks
```

`pnpm`은 고정하지 않습니다. 루트 매니페스트는 `>=12`만 요구하므로, 당신이 가진
최신 pnpm이 그대로 돕니다. `packageManager`로 고정하는 것은 실패를 앞으로
당기기만 했습니다. 더 새 pnpm은 스스로 낮추기를 거부하고 어떤 일도 시작하기 전에
죽습니다.

`tooling/bootstrap/bin/second-brain.js`는 커밋된 빌드 산출물입니다. npm이 이
저장소를 git에서 빌드 없이 설치하기 때문입니다. `plugin/bootstrap.mjs`는 그것의
복사본입니다. marketplace가 플러그인 루트 밖을 가리키는 `source`를 거부하므로
참조로 공유할 수 없습니다. `tooling/bootstrap/src/bootstrap.ts`를 바꾸면
`pnpm build`를 실행하고 셋을 함께 커밋하세요. 어긋나면 테스트가 실패합니다.

`apps/cli/dist/build.json`도 빌드가 씁니다(`scripts/write-build-info.mjs`).
`dist/`는 git에 들어가지 않으므로 커밋할 것은 없습니다.

## 릴리스

플러그인을 쓰는 사람에게 새 앱이 가려면 두 파일이 함께 올라가야 합니다.

- `plugin/app-ref` — 설치할 commit. 40자 소문자 hex 한 줄입니다. 자기 자신을
  담은 커밋은 만들 수 없으므로, 내용을 바꾼 커밋 **다음** 커밋에서 앞 커밋의 sha로
  올립니다.
- `plugin/.claude-plugin/plugin.json`의 `version` — 플러그인 캐시의 키입니다.
  원격 marketplace는 플러그인을
  `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`에 복사하고, 이 값이
  바뀔 때까지 그 사본을 계속 씁니다. 그러므로 `app-ref`를 올릴 때 `version`도 함께
  올립니다. 올리지 않으면 아무도 새 `app-ref`를 보지 못합니다.

로컬 marketplace(상대 경로 `source`)는 복사하지 않고 그 자리에서 읽으므로 개발
중에는 `version`이 영향을 주지 않습니다. 그래서 잊기 쉽습니다.

## 테스트 데이터베이스

`packages/postgres`는 에픽 7의 복제 대상이고, 그 테스트는 목이 아니라 실제
데이터베이스를 씁니다. 다른 것은 필요 없습니다. CLI와 `packages/sqlite`는 임시
폴더의 파일을 상대로 돕니다.

Docker만 켜 두면 준비할 것은 없습니다.

```sh
pnpm test
```

Postgres 테스트가 돌기 직전에 `pnpm test`가 한 번 확인합니다. 테스트 DB가 없으면
`compose.test.yaml`로 띄우고 `BRAIN_TEST_DATABASE_URL`을 채우고, 끝나면 자기가
띄운 컨테이너만 내립니다. 손으로 띄워 둔 컨테이너는 쓰기만 하고 그대로 둡니다.
컨테이너는 볼륨을 두지 않으므로, 멈추면 데이터는 사라집니다.

이미 있는 Postgres로 돌리려면 `BRAIN_TEST_DATABASE_URL`을 그것으로 가리키세요.
변수가 있으면 Docker는 부르지 않습니다. pgvector가 있어야 합니다.

```sh
export BRAIN_TEST_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>
pnpm test
```

Docker도 없고 변수도 없으면, 테스트를 하나도 돌리지 않고 이 둘 중 하나를 하라는
안내 한 번으로 멈춥니다. Postgres 테스트를 건너뛰거나 목으로 바꾸는 길은
없습니다. Postgres를 고르지 않은 실행(`vitest run --project sqlite` 등)은 Docker를
부르지 않습니다.

## 설치 상태 확인

설정은 저장소 밖, `~/.second_brain`(또는 `SECOND_BRAIN_HOME`이 가리키는 폴더)에
있습니다. `config.toml`은 `schema_version`, 시간대, 절대 경로 셋 — 데이터베이스
파일(`store.path`), 파일 저장소 루트(`files.path`), 미러(`mirror.path`) — 을
담고, 플러그인이 더 새 앱을 스스로 설치해도 되는지(`update.auto`, 기본 참)를
담고, 키 값은 담지 않습니다. 이 버전이 모르는 키가 있으면 그대로 남습니다. 키 값은 mode 0600의 `.env`에
있겠지만 이 버전에는 키가 없습니다. 둘 다 설치기가 씁니다. 손으로 쓸 것은
없습니다.

같은 폴더에 설정이 아닌 파일도 셋 있습니다. 완료 기록 `installed.json`(위),
설치 잠금 `install.lock/`(폴더 하나와 그 안의 `pid` 파일 — bootstrap과 shim이
번갈아 잡습니다), 그리고 플러그인 hook의 로그 `log/bootstrap.log`입니다. 설정
코덱은 이 셋을 읽지도 쓰지도 않습니다.

실제 폴더를 건드리지 않고 작업 트리를 확인하려면 설치기를 다른 곳으로
가리키세요.

```sh
export SECOND_BRAIN_HOME=$(mktemp -d)
node apps/cli/dist/install.js --yes

pnpm brain doctor run --json

# 그 설치의 shim. 자신이 속한 폴더를 품고 있습니다
env -u SECOND_BRAIN_HOME "$SECOND_BRAIN_HOME/bin/brain" doctor run
```

`doctor run`은 점검마다 한 줄, 그리고 그것을 센 요약 줄을 냅니다. 점검은
다음과 같습니다.

| 점검 | 말하는 것 |
|-------|--------------|
| `db` | 원본이 응답했는지, 그리고 어느 SQLite 버전인지 |
| `writable` | 이 프로세스가 정말 쓸 수 있었는지. 트랜잭션을 열고 테이블을 만들고 전부 롤백하므로 남는 것은 없습니다. 데이터베이스 파일은 mode 0444에서도 열리기 때문에 따로 묻습니다. 아무도 기다리지 않습니다 — 다른 프로세스가 쓰고 있는 brain은 `warn`으로 답하고 확인하지 못했다고 말합니다 |
| `wal` | 파일이 write-ahead 모드인지. 읽는 쪽과 쓰는 쪽이 파일을 함께 쓰게 해 주는 것이 그것입니다 |
| `fts5-trigram` | 이 Node의 SQLite가 FTS5와 `trigram` 토크나이저로 빌드되었는지. 행을 색인하고 찾아보아 증명합니다 |
| `foreign-keys` | 이 연결에서 적용되는지 |
| `schema-version` | 저장된 버전이 이 빌드가 만들어진 그 버전인지. 어긋나면 `SCHEMA_MISMATCH`이고, 마이그레이션하는 것은 `brain setup run`입니다. `db`가 실패했으면 물을 것이 없으므로 `skip` |
| `failures` | 아직 해결되지 않은 실패가 몇 건인지, 대상 종류별로. 0건이면 `ok`, 있으면 `warn`(코드 없음) — 기록이 남았다는 것은 망가졌다는 뜻이 아니라 멈췄다고 말했다는 뜻입니다. `brain failures retry`가 다시 부탁합니다. `db`가 실패했으면 `skip` |
| `transcripts` | 디스크에 있는데 아직 수집하지 않은 트랜스크립트가 몇 건인지. 그중 하나라도 하네스가 지우는 기한(30일)에서 5일 안으로 들어왔거나 폴더를 읽지 못했으면 `warn`, 그 밖은 `ok`. 폴더를 보지 않는 설정이면 `skip`. `db`가 실패했으면 `skip` |
| `config` | `config.toml`이 있고 읽을 수 있는지, 그리고 어디에 있는지 |
| `shim` | `<home>/bin/brain`이 있고, 실행할 수 있고, brain이 썼고, 있는 진입점을 가리키는지 |
| `node-path` | 그 shim이 가리키는 node가 실행되고 `engines.node`의 버전 이상인지. 읽을 shim이 없으면 `skip` |
| `node-version` | 명령을 실행한 node도 그 버전 이상인지 |
| `plugin` | 완료 기록(`installed.json`)과 플러그인의 `app-ref`와 지금 도는 빌드(`build.json`)의 관계. 기록이 없으면 `ok`, 플러그인에서 설치한 것이 아니면 `ok`, 셋이 같으면 `ok`. 플러그인이 더 오래되었으면 `warn PLUGIN_BEHIND`, 더 새롭고 `[update] auto`가 켜져 있으면 `ok`("다음 세션에서 갱신합니다"), 더 새롭고 꺼져 있으면 `warn UPDATE_AVAILABLE`. app-ref를 못 읽거나, 빌드가 기록과 다르거나, 관계를 알 수 없으면 코드 없는 `warn` |
| `spool` | 데이터베이스에 못 들어간 쓰기가 몇 건 기다리는지와 그중 가장 오래된 시각, 그리고 `failed/`로 옮긴 줄이 몇 건인지. 둘 다 0건이면 `ok`, 하나라도 있으면 `warn SPOOLED`. 기다리는 것이 있다는 것은 망가졌다는 뜻이 아니라 아직 안 들어갔다는 뜻입니다 — 폴더가 없으면 0건이고, 읽을 수 없으면 `fail` |

모든 점검은 넷 중 하나로 끝납니다. `ok`, `warn` — 실행했지만 아무것도 확정하지
못했다는 뜻으로, 통과도 문제도 아닙니다 — `fail`, 그리고 `skip`은 어느 점검이
자신을 무의미하게 만들었는지 detail에 적습니다(`앞선 점검 실패: db`). 마지막
줄은 그 수입니다.

```text
요약: 통과 12, 경고 1, 실패 0, 건너뜀 1
```

`--json`에서는 `data.summary`에 있으므로, 열 줄을 더해 가며 그중 하나뿐인
`warn`을 찾을 필요가 없습니다.

`fail`만 명령을 실패시킵니다. exit 0은 아무것도 실패하지 않았다는 뜻, 1은 무언가
실패했다는 뜻, 2는 명령을 아예 실행할 수 없었다는 뜻입니다. 고치는 일은 하지
않습니다. doctor는 알려 주고, 고치는 것은 `setup run`입니다.

`writable`이 실패하면 `brain.db`와 함께 `brain.db-wal`과 `brain.db-shm`도
고치세요. SQLite는 사이드카에 데이터베이스 파일의 권한을 그대로 주므로, 한때
읽기 전용이었던 데이터베이스는 자기 mode를 바로잡아도 사이드카가 그대로인 동안
이 점검에서 계속 실패합니다.

런타임 명령은 데이터베이스 파일을 열기만 하고 만들지 않습니다. 그래서 없는
`brain.db`는 빈 파일로 슬쩍 대체되지 않고 `DB_UNAVAILABLE`로 보고됩니다 — 그리고
데이터베이스에 닿을 수 없으면 그 탐침에 대해 할 말이 없으므로, 그 줄들은
짐작되는 대신 아예 없습니다. 스키마 버전은 그래도 자기 줄을 받습니다. `db`를
이유로 든 `skip`으로요. "확인하지 않았다"와 "확인했고 괜찮다"는 다른 답이고,
줄을 빼 버리면 없는 것으로부터 어느 쪽인지 알아내야 합니다.

`doctor run`은 망가진 설정에 대해 **보고하는** 유일한 명령입니다. 설치가 이미
망가졌을 때 실행하는 명령이기 때문입니다. 없거나 읽을 수 없는 `config.toml`은
실패한 `config` 점검과 exit 1이 되고, `db`는 경로가 없어서 실패하고, shim과 node
점검은 평소처럼 보고됩니다. 설정이 필요한 명령은 같은 폴더에서 exit 2로
끝납니다. 설정을 아예 읽지 않는 명령 — `guide` 셋과 `setup run`·`setup connect`
— 는 그 폴더에서도 평소처럼 돕니다.
