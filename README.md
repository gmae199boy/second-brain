# second-brain

Mac 한 대를 위한 개인 두뇌입니다. 원본은 OrbStack Docker 컨테이너의 PostgreSQL에 들어 있고,
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
끝나면 `{"systemMessage": "…"}` 한 줄만 냅니다. 이어서 같은 런처가 `queue drain`을
돌려 첫 설치 세션을 포함한 기존 트랜스크립트를 수집하며, drain 출력은 버립니다.
`Stop`과 `SessionEnd`도 각각 비동기 hook 하나로 수집합니다. 수집 런처는
`<home>/bin/brain` shim에 인자와 stdin을 넘기며, shim이 아직 없으면 조용히 끝납니다.
`SessionEnd`는 최선 노력이고 놓친 대화는 다음 drain이 줍습니다.
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
돌립니다 — 그것이 업그레이드입니다. 등록 확장의 offline 확인이 필요한 갱신은
hook이 대신 승인할 수 없으며 아래 대화형 절차로 진행합니다.

세션마다 hook은 자기를 부른 플러그인 폴더를 `~/.second_brain/run/plugin.json`에
적어 둡니다.

```json
{
  "plugin_root": "~/.claude/plugins/cache/second-brain/second-brain/0.1.2",
  "app_ref": "10a09d2ef60fcf3b607f8562192c2ea8a59d3981",
  "seen_at": "2026-10-18T02:12:27.381Z",
  "last_bootstrap": {
    "at": "2026-10-18T02:13:04.902Z",
    "result": "installed",
    "log": "~/.second_brain/log/bootstrap.log"
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

### 고정된 플러그인 설치본을 대화형으로 갱신하기

등록된 확장이 있는 옛 설치본을 다른 core commit으로 갱신할 때는 운영자의 offline
확인이 필요합니다. 플러그인의 `SessionStart` hook은 질문할 수 없으므로 이 확인을
대신하지 않습니다. 다음 절차는 플러그인이 만든 detached app에도 사용할 수 있습니다.

1. 갱신할 Brain의 설정 폴더와 대상 플러그인 버전을 확인합니다. 사용할 플러그인
   폴더는 **대화형 ref 갱신을 지원하는 새 릴리스**여야 합니다. marketplace 캐시에
   옛 버전이 남으므로 선택한 폴더의 `app-ref`가 원하는 릴리스의 commit인지 확인하세요.
   아래 `<version>`과 marketplace 이름은 실제 선택한 폴더로 바꿉니다. 로컬
   marketplace라면 그 저장소의 `plugin` 폴더를 지정합니다.
2. 새 Claude Code 세션과 hook, 예약 실행 및 다른 직접 명령의 진입을 차단합니다.
   설치·확장 명령이 실행 중이면 끝날 때까지 기다립니다. 등록 확장은 비활성화하고
   관련 예약과 미완료 일감을 보류한 뒤 실행 중인 작업과 자식 프로세스의 종료를
   확인합니다. `ext disable` 응답만으로 자식 종료가 확정되지는 않습니다. launchd가
   관리하는 데몬은 아래처럼 멈추고 상태를 확인합니다. 직접 띄운 데몬도 해당
   터미널에서 멈추고 이전 데몬·명령과 **모든 자식의 공유 상태 쓰기가 끝났는지**
   직접 재확인하세요. 종료를 확인할 수 없으면 계속하지 마세요.

   ```sh
   BRAIN_HOME="${SECOND_BRAIN_HOME:-$HOME/.second_brain}"
   "$BRAIN_HOME/bin/brain" daemon stop
   "$BRAIN_HOME/bin/brain" daemon status
   ```

3. 실제 터미널에서 아래 명령을 실행합니다. `PLUGIN_DIR`은 1번에서 확인한 폴더로
   바꾸세요. `app-ref`의 40자리 전체 commit을 대상과 비교한 뒤 같은 폴더의 새
   bootstrap을 실행합니다. `SECOND_BRAIN_REPO`를 사용한다면 기존 app의 origin과
   같은 저장소를 가리켜야 합니다. Node 24.16 이상과 git이 필요합니다.

   ```sh
   PLUGIN_DIR="$HOME/.claude/plugins/cache/second-brain/second-brain/<version>"
   cat "$PLUGIN_DIR/app-ref"
   IFS= read -r TARGET_REF < "$PLUGIN_DIR/app-ref"
   node "$PLUGIN_DIR/bootstrap.mjs" --interactive-ref --ref "$TARGET_REF" --yes --plugin-root "$PLUGIN_DIR"
   ```

   설치기가 대상 ref를 별도로 준비하고 빌드한 후 현재 시도의 확인 문구를
   표시합니다. 2번의 진입 차단과 종료 사실을 다시 직접 확인한 경우에만 화면의
   `확인 …` 문구 전체를 그대로 입력하세요. 매 시도마다 문구가 다릅니다. `--yes`는
   이 확인을 대신하지 않으며 비TTY·JSON·잘못된 응답이나 취소는 자동 승인되지
   않습니다. 설치기는 확인 후에도 정지 상태와 신원을 다시 검사합니다. 갱신이
   끝날 때까지 다른 쓰기 진입을 차단하고, 설치기가 데몬을 다시 등록하거나 시작할
   수도 있으므로 끝난 뒤 상태를 확인하세요.

4. 성공 후 `"$BRAIN_HOME/bin/brain" ext status garmin` 등으로 교체 대기 상태를
   확인합니다. 옛 manifest의 확장은 현재 형식의 호환 패키지를 명시적으로
   `"$BRAIN_HOME/bin/brain" ext install --package <패키지-경로>`로 설치하기 전에는 실행되지 않습니다.
   기존 비활성 상태와 보류는 유지되며, 작업을 재개하려면 패키지 교체를 확인한
   뒤 사용자가 명시적으로 `"$BRAIN_HOME/bin/brain" ext enable <이름>`을 실행합니다.

**실패와 재시도.** 출력과 `log/bootstrap.log`의 hook 기록을 확인하고 원인을 해결한
뒤 같은 플러그인 폴더와 ref로 터미널 명령을 다시 실행하세요. ref가 없거나 이력이
갈라진 경우, 다른 저장소 또는 변경된 app, 확인되지 않은 정지 상태는 그대로 두고
거부합니다. 강제로 브랜치를 바꾸거나 변경을 버리지 마세요. 재시도에 필요한 경우
새 확인 문구가 다시 표시됩니다.

승격 직후 중단됐더라도 이전 app과 새 app, 설치 기록, 승격 기록과 확장 전환
journal의 ref·소유자가 서로 일치하고 이전 owner가 종료된 상태라면 아래 잠금
복구가 필요한지 확인한 뒤 같은 명령으로 신원을 검증하고 새 확인을 받아 이어갑니다.
승격 기록이 손상됐거나 owner·신원
연결이 없거나 서로 다르면 자동 복구하지 않습니다. 특히 옛 journal에 owner 연결이
없으면 해당 기록과 두 app을 보존하고 원인을 조사하세요. `.app-previous`,
`.app-next`, `.app-promotion.json`, 확장 정지 기록 또는 journal을 임의로 지워
거부를 우회하지 마세요.

설치 잠금 대기 메시지가 계속되면 다른 설치가 진행 중일 수 있습니다. 잠금의
`pid`·`owner`를 확인하고 새 설치를 차단한 상태에서 그 설치와 **모든 자식**이
종료됐고 공유 상태 쓰기가 끝났다는 사실을 확인한 경우에만 해당 `install.lock`
폴더를 제거한 뒤 재시도하세요. 소유자나 종료 여부가 불명확하면 잠금을 보존합니다.

```sh
cat "$BRAIN_HOME/install.lock/pid" "$BRAIN_HOME/install.lock/owner"
# 위 조건을 모두 확인한 경우에만 실행합니다.
rm -r "$BRAIN_HOME/install.lock"
```

설치기 강제 종료 뒤 `run/daemon.pid`가 남으면 설치기는 소유 PID가 죽었다는
사실만으로 그 잠금을 회수하지 않습니다. 새 설치·데몬·확장 명령과 자동 시작을
계속 차단하고, 중단된 시도의 프로세스 기록에서 bootstrap 및 설치기 PID와 그
프로세스 그룹·모든 자식을 확인하세요. 그 그룹과 자식이 모두 종료되어 공유 상태에
더 이상 쓰지 않는다는 사실을 확인해야 합니다. `kill -0` 한 번이나 PID 부재만으로
자식 종료를 추정하지 마세요.

아래 기록을 대조해 `daemon.pid`의 PID가 **바로 그 설치기**이고 대상 commit이
같은지, `.app-promotion.json`의 owner가 그 bootstrap 소유자이며 journal의
`promotionOwner` 및 대상 commit과 일치하는지 확인하세요. 설치 중 확보한 프로세스
기록 등으로 설치기 PID와 소유 관계를 입증할 수 없다면 잠금을 그대로 보존하고
조사하세요. 다른 소유자, 읽을 수 없는 기록, 불일치 또는 종료 여부가 불확실한
경우에도 제거하지 않습니다. 확장 정지 기록과 journal은 제거하지 않습니다.

```sh
cat "$BRAIN_HOME/run/daemon.pid" "$BRAIN_HOME/.app-promotion.json" "$BRAIN_HOME/run/bootstrap-extension-migrations.json"
ps -axo pid,ppid,pgid,command
```

위 소유권과 모든 자식의 종료를 확인하고 새 진입 차단을 유지한 경우에만, 확인한
잠금 내용을 저장한 뒤 바뀌지 않았는지 다시 대조하고 그 파일 하나를 제거합니다.
명령 실행 전과 제거 전 내용이 같은지 직접 확인하세요.

```sh
FENCE_RECORD=$(cat "$BRAIN_HOME/run/daemon.pid")
printf '%s\n' "$FENCE_RECORD"
test "$(cat "$BRAIN_HOME/run/daemon.pid")" = "$FENCE_RECORD" && rm "$BRAIN_HOME/run/daemon.pid"
```

이후 같은 대화형 bootstrap 명령을 다시 실행하고 새 확인 문구에 응답합니다.

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
| `SECOND_BRAIN_LAUNCHCTL` | `/bin/launchctl` | launchctl 실행 파일. 시험용 |
| `SECOND_BRAIN_LAUNCH_AGENTS` | `~/Library/LaunchAgents` | 데몬 plist를 쓸 폴더. 시험용 |
| `SECOND_BRAIN_NODE_DIRS` | `/opt/homebrew/bin:/usr/local/bin` | node를 찾아볼 고정 폴더들. 시험용 |

설치 전에 OrbStack이 실행 중이어야 합니다. 설치기는 홈별 PostgreSQL 컨테이너를
만들고, 미러 경로와 시간대 등의 설정을 묻습니다.

- **PostgreSQL을 어디에 둘지.** 홈에서 분리된 compose project와 영속 볼륨을 만들고, 접속 URL은 `.env`에 기록합니다. 선택자는 `store.url_env`이며 기본값은 `BRAIN_DATABASE_URL`입니다.
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
묻습니다. 설정 두 파일, PostgreSQL compose project·볼륨·포트, 파일 저장소 루트,
shim의 경로입니다. 여기서 아니요라고
답하면 — 또는 그 앞의 어느 질문에서 Ctrl-C를 누르면 — 한 바이트도 쓰지 않고
`SETUP_CANCELLED`로 끝납니다. 뒤 질문에서 누른 Ctrl-C는 그 자리에서 멈추므로,
그때까지 밟은 단계는 그대로 남습니다. `--yes`는 이 질문을 건너뜁니다 — 경로
질문은 그대로 묻습니다. 하네스를 연결할지는 뒤에서 따로 묻습니다.

동의한 다음에는 PostgreSQL role·schema와 마이그레이션을 준비하고, 이 brain의 주인을
기록하고, 시간대를 DB에 저장합니다. 파일 저장소 루트를 mode 0700으로 만든 뒤
설정을 쓰고, 디스크의 transcript를 가져옵니다. 그다음 shim과 하네스를 준비하고
`brain doctor run`과 같은 점검으로 마칩니다. `fail`이 있으면 `SETUP_INCOMPLETE`이고
완료 기록을 쓰지 않습니다. 옛 SQLite 파일은 지우거나 옮기지 않고 더 쓰지 않는다고 안내합니다.
새 PG에는 디스크의 transcript만 다시 가져오며, 옛 `brain.db`의 저장본 가리기·꼬리표 등은 옮겨지지 않습니다.
transcript에서 다시 들어온 내용 중 이전에 가렸던 내용은 새 PG에서도 다시 가려야 합니다.

마지막 단계는 이 프로세스 밖에서 설치를 확인하는 것입니다. `<home>/bin/brain
guide schema --json`을 실제로 실행해서 exit 0과 `ok: true` 엔벨로프를 받아야
합니다. 하네스 hook이 brain에 닿는 길이 그것뿐이고, doctor는 이 프로세스 안에서
부품이 제자리에 있는지만 말할 수 있기 때문입니다. 이것이 통과하지 못하면
`SETUP_INCOMPLETE`(exit 1)이고 완료 기록을 쓰지 않습니다.

통과하면 `<home>/installed.json`을 temp+rename으로 씁니다(mode 0644).

```json
{
  "commit": "10a09d2ef60fcf3b607f8562192c2ea8a59d3981",
  "schema_version": 1,
  "schema_versions": {"core": 1},
  "node": "/opt/homebrew/bin/node",
  "plugin_root": "~/.claude/plugins/cache/second-brain/second-brain/0.1.0",
  "installed_at": "2026-10-17T15:11:42.113Z"
}
```

`commit`은 `apps/cli/dist/build.json`에서 오고, `schema_version`은 설치가 확인한 PG core
버전입니다. 빌드 기록은 `tsc` 뒤에 쓰는 `{commit, schema_version, schema_versions}`이고, `commit`은
`git rev-parse HEAD`(git이 없으면 `null`)입니다. `dist/`는 git에 들어가지 않으므로
"이 `dist/`가 어느 소스에서 왔는가"에 답할 수 있는 것은 이 파일뿐입니다.
`node`는 shim에 고정한 node 경로이고, `plugin_root`는 `--plugin-root`가 가리킨
폴더(없으면 이전 기록의 값, 그것도 없으면 `null`)입니다.

이 두 파일도, 위의 `run/plugin.json`도 설정이 아니므로 설정 코덱을 지나지
않습니다(AD-18). 설정은 사람이 고르고 고칠 수 있는 것이고, 이것들은 이 기계가 한
일입니다. 읽을 수 없으면 고치지 않고 "모른다"로 답합니다.

다시 실행하면 같은 PostgreSQL 컨테이너·볼륨을 재사용하고, 적용된 마이그레이션과
주인·시간대 값을 보존합니다. shim과 하네스 항목도 이미 맞으면 건드리지 않습니다.
연결 선택자가 없는 기존 설정도 기본 `BRAIN_DATABASE_URL`을 사용합니다. 옛 `store.path`는
검증하지 않고 SQLite 파일 안내 후보로만 읽으며, 설정을 다시 쓸 때는 뺍니다.


물어볼 터미널이 없는 곳 — 스크립트나 CI — 에서는 `--yes`가 동의이고 나머지는
플래그로 말합니다. `--yes`가 없으면 설치는 아무것도 쓰기 전에 멈추고 exit 3,
"아무도 주지 않은 확인"으로 끝납니다. 명령이 틀린 것도 아니고 무엇이 망가진
것도 아닙니다. 실행하는 사람에게 던지는 질문입니다.

```sh
node apps/cli/dist/install.js --yes
```

터미널이 없으면 아무것도 묻지 않으므로 각 경로는 기록된 값(없으면 기본값)을
지키고, `--connect`가 이름을 대지 않은 하네스는 연결되지 않습니다.

| 플래그 | 하는 일 |
| --- | --- |
| `--mirror-path <경로>` | 미러 폴더의 절대 경로 |
| `--plugin-root <경로>` | 이 설치를 시작한 플러그인 폴더의 절대 경로. 완료 기록에 적힙니다 |
| `--connect <하네스>` | 이 하네스를 연결합니다. 여럿이면 되풀이하세요 |
| `--yes` | 설치가 해야 할 일에 미리 동의합니다 |

### 이미 있는 설정은 지킵니다

설정은 값마다 따로 읽습니다. 값 하나를 쓸 수 없으면 그 키만 버리고 기본값을
쓰면서 `CONFIG_VALUE_RESET` 경고를 냅니다 — 어떤 키였고, 무엇이 적혀 있었고,
대신 무엇을 쓰는지 말합니다. 나머지 값은 그대로 남습니다. `files.path` 오타
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
`brain messages redact`를 쓰세요. 메시지 id(UUIDv7)를 지정하고 글자 또는 패턴을 고릅니다.

```sh
brain messages redact <message> --text '<가릴 글자>' --kind manual --yes
brain messages redact <message> --detected --yes --json
```

`--text`는 정확히 일치하는 모든 글자를 가리고, `--detected`는 현재 비밀 패턴이
찾는 구간을 가립니다. 둘 중 하나만 주며, `--kind`는 `--text`에만 쓸 수 있습니다
(기본 `manual`, 소문자·숫자·밑줄). `--yes`가 없으면 질문하지 않고 exit 3과
다시 실행할 명령을 돌려줍니다. 입력 검사와 확인은 데이터베이스를 열기 전에 합니다.

이 작업은 **되돌릴 수 없습니다**. 본문과 같은 메시지의 도구 메모 대상을 함께
가리고, 걸린 검색 조각도 지웁니다. 조각은 지금 다시 만들어지지 않습니다(epic 4).
**비밀을 `--text`로 주면 셸 기록과 transcript에 그대로 남을 수 있으므로
`--detected`를 권장합니다.** 다른 연결이 오래된 WAL 읽기를 잡고 있으면
가리기는 커밋되지만 디스크의 WAL 정리는 그 읽기가 끝난 뒤에야 가능합니다.

메시지를 가려도 그 메시지에 붙은 첨부 파일은 그대로 남습니다. 그래서 가리지 않은
첨부가 있으면 `messages redact`는 exit 0으로 성공하면서 `warnings`에
`ATTACHMENT_NOT_REDACTED`를 담고 `data.unredacted_attachments`로 몇 건인지
말합니다. 첨부는 다음 명령으로 따로 가립니다.

```sh
brain files redact <file> --yes --json
brain files redact sha256:<hex> --yes --json
```

가리기는 **내용 단위**입니다. 같은 바이트는 한 번만 저장되고 여러 메시지의 첨부
자리가 그 하나를 가리키므로, 한 번 가리면 그 내용을 함께 쓰는 **모든 메시지**에서
원본 사본·추출 텍스트·조각·검색용 이름(`file_names`와 그 색인)·메타데이터가
사라집니다. 그래서 `--yes`가 없으면 exit 3과 함께 "메시지 몇 개가 함께 쓰는지"를
문장으로 보여 주고 아무것도 쓰지 않습니다 — 인자 검사만 데이터베이스 전에 하고,
공유 수를 세는 읽기는 잠금을 쓰지 않습니다. 파일은 UUIDv7 id나 `sha256:` 다음
소문자 16진수 64자의 내용 해시로 지정하며, 해시는 원본 파일에서
`shasum -a 256`으로 얻을 수 있습니다.

**사라지는 것은 내용이고, 출처는 남습니다.** 첨부 행(`message_attachments`)은
immutable이라 그 첨부가 어떤 이름으로 붙었는지(`display_name`)와 무엇을
가리켰는지(`source_ref`)는 그대로 남고, 사용자 원본의 자리(`external` 위치)도
"어디서 왔는지"의 기록으로 남습니다. 둘 다 Brain이 읽은 내용이 아니라 "이 대화가
무언가를 붙였다"는 사실이어서, 가리기가 다시 쓰지 않습니다. 그래서 가린 뒤에도
그 이름으로 첨부 행은 찾을 수 있지만 이름 색인·조각·원본 사본은 없습니다.

지우는 것은 Brain이 가진 사본뿐입니다. 사용자 원본은 읽지도, 지우지도, 바꾸지도
않습니다. Brain 사본의 바이트는 트랜잭션 안에서 지우지 않고 `blob_delete` 일감으로
넣어 두므로, 실제 삭제는 다음 `brain queue drain`이 합니다 — 그때까지 사본은 디스크에
그대로 있습니다. 진행 중인 추출이 있으면 그 조각만 지우고 세대 행은
남겨서, 그 일꾼이 `FILE_REDACTED`를 받고 스스로 `redacted`로 닫습니다. 가린 파일은
새 추출 세대를 열 수 없고 검색용 이름도 다시 생기지 않습니다. 같은 파일을 다시 가리면
오류가 아니라 `already_redacted: true`이고, 아직 남은 Brain 사본의 삭제 일감만
다시 넣습니다.

가린 내용은 다시 수집해도 되살아나지 않습니다. 파일 저장소는 내용 주소라 같은
바이트를 다시 쓰면 지운 자리에 블롭이 되살아나므로, 수집은 `files.put` 전에 가린
내용 해시를 한 번 읽고 그 해시는 저장하지 않습니다(첨부 행은 그대로 남아 가린
파일을 가리킵니다 — 붙인 사실은 사실입니다). 그 읽기가 실패하면 지금처럼 저장하며,
이것이 남은 위험입니다.

대화에 붙여 넣은 이미지는 원본 바이트로 `[files] path` 아래에 남습니다.
같은 이미지는 여러 번 붙여 넣거나 다시 수집해도 한 번만 저장되고, 각 메시지의
첨부 자리는 같은 원본을 가리킵니다. 이미지뿐인 메시지도 빈 본문과 첨부로 남습니다.

`@`로 지정한 파일은 붙인 시점의 내용으로 한 번 남습니다. transcript에 전체
내용이 없으면 원본 파일의 줄 수나 바이트 수가 붙인 시점과 같을 때만 읽고, 원본을
얻지 못하면 첨부는 `missing_at_ingest`로 남습니다. 홈 아래 파일의 원래 자리는
`~/` 경로로 기록하며, 사용자 파일을 옮기거나 바꾸지 않습니다.
`brain queue drain`은 첨부의 파일 이름과 원래 경로를 이름 색인에 채웁니다. 같은
실행이 붙인 텍스트 문서(txt·md)를 조각으로 잘라 본문으로도 찾을 수 있게 합니다.
형식은 이름이 아니라 내용으로 가릅니다 — 이름만 `.txt`인 그림은 조각이 생기지
않고 "읽지 않는 형식"으로 남으며 실패로 기록하지도 않습니다. 8 MiB를 넘는 파일은
읽지 않습니다. 원본 바이트가 사라졌거나 수집 때와 달라졌으면 실패로 남고, 마지막에
성공한 조각은 그대로 남아 계속 찾힙니다.

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

프로젝트·워크트리 꼬리표는 세션을 시작한 폴더로 정합니다.
메시지가 아닌 줄도 포함해 서브에이전트 줄을 제외한 첫 cwd를 쓰고,
없으면 cwd가 있는 첫 메시지의 폴더를 씁니다.
remote 정체성의 표시 철자는 처음 저장한 값을 지키고, GitHub·Bitbucket의
대소문자만 다른 경로는 같은 프로젝트로 비교합니다. 그 밖의 호스트와 remote 없는
저장소의 공통 디렉터리 경로는 철자를 그대로 비교합니다.

폴더가 사라졌으면 처음 남아 있는 위 폴더의 저장소로 추정합니다. 위 폴더가
저장소 밖이면 원래 폴더의 바로 위에 있는 형제 checkout들을 확인하고, 하나 이상이
모두 같은 프로젝트일 때만 그 프로젝트로 추정합니다. 서로 다른 저장소가 섞이면
꼬리표 없이 수집합니다. 살아 있는 레포 밖 폴더는 추정하지 않습니다.
출처는 `sessions.tag_source`의 `cwd`·`ancestor`·`sibling`으로 남고,
첫 근거 폴더는 꼬리표가 없어도 `first_cwd`에 보존됩니다. 추정한 워크트리의
경로는 원래 사라진 폴더입니다.

git 없음·시간 초과·권한·비정상 응답으로 확인하지 못하면 세션과 함께
`session_identity` 일감을 남깁니다. drain은 트랜스크립트의 첫 cwd를 다시 읽고,
원본이 사라졌으면 저장된 `first_cwd`로 판단합니다. 두 근거가 모두 없으면
첫 시도에서 실패합니다. 계속 답을 못 하면 열 번째에 실패 기록으로 남으며
`brain failures retry`로 다시 할 수 있습니다. 이미 붙은 꼬리표·출처·근거 폴더는
바꾸지 않습니다. 스키마 7 이전의 꼬리표 없는 세션은 drain이 한 번 다시 판단합니다.

데이터베이스에 쓸 수 없을 때 — 다른 프로세스가 쓰기 잠금을 예산보다 오래 쥐고
있을 때, 파일이 없을 때, 저장된 스키마 버전이 이 빌드의 것과 다를 때 — 턴은
실패하지 않습니다. "이 세션을 다시 수집할 것" 한 줄이 `~/.second_brain/spool/`에
남고, 명령은 `warnings`에 `SPOOLED`를, `data.spooled`에 `true`를 담아 성공으로
답합니다. 트랜스크립트는 그 줄에 복사하지 않습니다 — 다시 읽으면 그동안 늘어난
것까지 들어오므로, 복사본은 쓰는 순간부터 낡은 것입니다. 스키마 버전이 어긋나면
수집 본문은 아예 불리지 않습니다. 그래서 어긋난 데이터베이스에 쓰기가 닿을 길이
구조적으로 없습니다.

블롭을 저장한 뒤 데이터베이스가 쓰기를 거부하면, 첨부 연결은 바이트 없는
메타데이터 한 줄(`attachment_link`)로 다시 수집할 줄 뒤에 함께 남습니다.

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

`brain queue cancel <id>`로 대기 일감을 취소하거나 실행 중인 일감의 취소를 요청합니다. 실행 중이면 감독자가 그룹에 SIGTERM을 보내고 5초 유예 뒤 SIGKILL로 정리합니다. 종료를 확인할 수 없는 시도는 `unknown`으로 남고 다시 청구되지 않습니다. `unknown`에 대한 취소 요청은 자동 정리를 다시 시작하지 않습니다. 데몬은 시작 때 이전 시도를 OS 시작 신원으로 대조합니다.

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
   행이 없거나 크기가 다른 파일, 저장된 parser 버전이 현재와 다른 세션의
   파일마다 `session_ingest` 일감을 하나 넣습니다
   (오래된 것부터). 이미 열린 일감이 있는 세션과, `session_ingest`가 미해결
   실패로 남은 세션은 건너뜁니다 — 뒤쪽은 `brain failures retry`가 다시
   부탁하는 몫입니다. 바뀐 것이 없으면 쓰기를 아예 부르지 않습니다. 목록 →
   내역 → 다시 읽을 세션 → 열린 일감 → 미해결 실패는 모두 잠금 없는 읽기입니다.
   버전이 달라도 파일이 사라졌으면 일감 없이 `reread_missing`으로 셉니다.
   JSON에는 정수 `reread_missing`, 텍스트에는 `다시 못 읽음 N건`으로 나옵니다.
3. **대기열 처리.** 위 규칙대로 남은 예산 안에서 일감을 청구하고 처리합니다.

세 번째 단계 앞에서 붙인 문서도 넣습니다. 아직 아무도 읽지 않은 파일마다
`document_extract` 일감을 하나 넣고, 이어서 **추출기 버전이 뒤처진** 파일마다
하나 더 넣습니다. 뒤처진 파일은 지금 가리키는 세대가 성공(`ok`)이면서 그 세대의
추출기 버전이 이 빌드의 것과 다르고, 그 파일에 이 빌드 버전의 세대가 **하나도
없는** 파일입니다. 그래서 추출기를 고치고 버전만 올리면 다음 drain이 이미 성공한
파일도 한 번 다시 읽습니다. 다시 읽기가 실패하면 그 버전의 세대가 남으므로 매
drain 다시 넣지 않고, 그 뒤는 `brain failures retry`의 몫입니다. 뒤처졌는데
가려졌거나 원본에 닿을 수 없는 파일은 읽을 바이트가 없으니 넣지 않고 세기만
합니다 — JSON의 `reextract_redacted`·`reextract_unreachable`, 텍스트의
`다시 추출 건너뜀 가림 N건`·`다시 추출 건너뜀 원본 불가 N건`이고, 원본 불가가
있으면 `warnings`에 `FILE_SOURCE_UNREACHABLE`이 붙습니다.

이 빌드의 일감은 `session_ingest`(세션 다시 수집), `session_identity`(비어 있는
프로젝트·워크트리 꼬리표 확인), `document_extract`(붙인 문서를 조각으로 만들기)
입니다. 스캔이 찾은 세션은 같은 실행에서 수집되므로, 새로 설치한
brain에서 `brain queue drain` 한 번이 디스크에 남은 세션을 모두 거둡니다
(`ingest_source`는 `import`입니다). 대화 조각·색인 만들기와 미러 갱신은 뒤 에픽에서
종류를 하나씩 더합니다. 종류를 모르는 일감은 청구하지 않습니다 — 새 빌드가 넣은
일감을 옛 빌드가 지우지 않게 하려고요.

하네스 트랜스크립트 폴더는 기본으로 읽습니다. Claude Code는 `CLAUDE_CONFIG_DIR`,
없으면 `~/.claude`를 봅니다. 폴더 스캔, 세션 토큰만으로 트랜스크립트 찾기,
doctor의 `transcripts` 점검이 같은 등록부를 씁니다.

세 번째 단계는 이렇게 돕니다. 쓰기 잠금을 잡기 전에 잠금 없는 읽기로 할 일이
있는지 먼저 봅니다 — 할 일이 없으면 쓰기를 아예 부르지 않습니다. 있으면 짧은
쓰기 트랜잭션 하나로 한 행을 청구하고(시도 횟수는 이때 올라갑니다), 트랜잭션
밖에서 처리합니다. 끝내기는 청구가 아직 내 것일 때만 바뀝니다. 청구 기간이
지나 다른 실행이 그 행을 가져갔다면 늦게 온 답은 아무것도 바꾸지 않습니다.
그래서 두 프로세스가 같은 대기열을 비워도 일감은 정확히 한 번 처리됩니다.

core drain의 실패는 분류에 따라 다르게 다룹니다.

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
8192바이트 이하로 자릅니다. payload는 남기지 않습니다. core drain의 실패 기록 자체를
데이터베이스가 받지 못하면 그 내용이 spool로 가고 그 실행은 멈춥니다.

감독 경로는 worker의 `retryable`을 따르며 시도를 소비합니다. `DB_UNAVAILABLE`·`DB_LOCKED`도
true면 종류의 `transientDelayMs`(기본 15분) 뒤 재시도하고 10번째 시도에서 기록 후 닫으며,
false면 즉시 기록 후 닫습니다. 정산 DB 실패는 spool 대신 `pendingSettlement`로 재시도합니다.
heartbeat는 임대만 갱신하며 진행이 아닙니다. 마지막 진행부터 기본 15분, 모델 일감은 25분 동안
진행이 없으면 감독자가 정체로 보고 프로세스 그룹을 정리합니다.

hook이 아닌 명령은 **끝에서 한 번 더** 짧게(2초) 이것을 돕니다.
살아 있는 pid 잠금 주인과 90초 이내의 미래가 아닌 heartbeat가 있으면 데몬에
맡기고 이 기회적 drain을 건너뜁니다. 데몬도 hook도 없는 하네스에서는 사람이
부른 명령의 끝이 밀린 일을 처리할 유일한 순간이기 때문입니다.
명령이 성공했고 스키마 버전이 맞을 때만 돌고, 결과도 종료 코드도 바꾸지
않습니다. `queue drain` 자신은 이것을 끕니다.

## 데몬

종료할 때 감독자는 실행 중인 자식 그룹을 SIGTERM → 5초 유예 → SIGKILL로 정리하고 일감을 돌려줍니다. 이미 취소를 요청한 일감은 취소로 닫습니다.

```sh
brain daemon run
brain daemon status [--json]
```

상주해서 밀린 일을 되풀이해 처리하는 하나뿐인 명령입니다. 다른 명령은 답하고
끝나지만, 이것은 멈추라고 할 때까지 머무릅니다. 한 회차는 데이터베이스를 열고
스키마 버전을 확인한 뒤 10초 예산으로 `queue drain`과 같은 처리를 한 번 돌고
닫는 것입니다. 회차마다 다시 여는 까닭은 복구나 마이그레이션이 이 프로세스가
도는 동안 일어날 수 있기 때문입니다 — 스키마가 맞지 않으면 아무것도 쓰지 않고
다음 회차에 다시 봅니다.

예산이 끝나 멈춘 회차(`budget`)는 손에 일이 더 있다는 뜻이므로 쉬지 않고 바로
다음 회차로 갑니다. 할 일이 없거나(`empty`) 쓸 수 없거나 오류로 끝난 회차 뒤에는
파일 감시 묶음이 끝나면 바로 다음 회차를 돌고, 묶음이 없으면 10초 쉽니다.
이 10초는 주기 scan의 받침이며, 진행 중인 작업이 있으면
새로 쓰인 트랜스크립트의 처리 지연은 더 길어질 수 있습니다.

`schedules` 테이블의 예약을 회차마다 drain 앞에서 틱합니다. 시각이 된 예약은
일감 추가와 다음 시각 갱신을 한 트랜잭션으로 처리합니다. 놓친 회차는 하나로
합치고 다음 시각은 발화 시각 + 간격입니다. 한 번짜리는 발화 뒤 끝납니다.
DB 실패가 난 예약의 일감과 시각은 되돌리며, 앞서 발화한 예약은 유지합니다.
틱은 그 자리에서 멈추고 다음 회차에 다시 시도하며 drain은 계속합니다. 틱 해상도는
회차 간격(쉬는 시간 최대 10초)입니다. 등록 명령은 다음 조각에서 제공하며,
`schedule_probe`는 부수 효과 없이 틱에서 drain까지 확인하는 검증용 일감입니다.

등록된 하네스의 transcript 폴더를 감시합니다. Claude Code는
`CLAUDE_CONFIG_DIR` 또는 `~/.claude` 아래 `projects`입니다. 첫 변경부터 2초 동안
변경을 묶고 묶음마다 회차 한 번을 깨웁니다. 감시 이벤트로 직접 수집하지 않고
기존 drain 안의 scan이 수집합니다. 기동 직후 첫 회차는 꺼져 있던 동안의 변경도
메웁니다. 폴더가 없거나 감시가 실패하면 로그를 남기고 10초 주기 회차가 받치며,
회차마다 감시를 다시 시도합니다. `[files] path`는 감시하지 않습니다.

**출력 엔벨로프가 없습니다.** `--json`을 붙여도 stdout에는 아무것도 나오지
않습니다. 영원히 돌아오지 않을 프로세스의 엔벨로프를 기다리는 호출자는 영원히
기다리게 되기 때문입니다. 뜨지 못한 까닭만 stderr에 `CODE: message`와 hint 줄로
나오고, 종료 코드는 코드 표의 것입니다.

`brain daemon status`는 설정이나 DB 없이 데몬 파일만 읽어 생존 여부를 보입니다.
잠금 주인이 현재 부팅의 살아 있는 pid이고 heartbeat mtime이 지금부터 90초
이내(정확히 90초 포함)여야 살아 있습니다. 미래 시각이나 읽을 수 없는 파일은
죽은 것으로 봅니다. `doctor run`의 `daemon` 점검도 같은 판단을 씁니다.

텍스트는 생존 여부·pid·마지막 heartbeat 또는 죽은 까닭 한 줄입니다.
`--json`의 데이터는 `alive`, `pid`, `heartbeat_at`(시간대 오프셋 포함), `reason`이고,
살아 있으면 `reason`은 `null`입니다. 죽은 까닭은 `no-lock`, `pid-dead`,
`no-heartbeat`, `future-heartbeat`, `stale-heartbeat` 중 하나이며, 살든 죽든 exit 0입니다.

예약 발화는 `예약 N건 발화, 새 일감 M건` 한 줄로 기록합니다. 예약 틱 실패는
코드를 포함해 상태가 바뀔 때 한 번 기록하고 성공하면 실패 상태를 지웁니다.

기록은 세 파일입니다.

- `~/.second_brain/run/daemon.pid` — 주인 한 줄(JSON): pid, 부팅 시각, 시작 시각.
- `~/.second_brain/run/heartbeat` — 30초마다 다시 쓰는 ISO 시각 한 줄. 기록은
  mtime이고, drain과 독립된 타이머입니다. 핸들러 안에서 멈춘 drain과 사라진
  프로세스를 구별할 수 있어야 하기 때문입니다. 쓰기가 실패하면 로그 한 줄이고
  데몬은 계속 돕니다.
- `~/.second_brain/log/daemon.log` — `<ISO 시각> <한 문장>`. 시작, 정상 종료,
  잠금 거절, 일이 있었던 회차의 건수, 그리고 상태가 **바뀔 때만** 한 번씩 스키마
  불일치·데이터베이스에 못 씀·drain 예외·파일 감시 시작 및 실패입니다. 같은 문제가 10초마다 되풀이
  기록되지 않게요. 비밀을 가린 뒤 씁니다. 다음 줄을 더하면 1MiB를 넘기기 전에
  `.1`…`.5`로 밀고 가장 오래된 파일을 버립니다. 가장 새 줄은 `daemon.log`에
  있으며, 한 줄이 한도보다 길어도 자르지 않고 통째로 남깁니다.

**설정 폴더 하나에 데몬 하나입니다.** 둘째 `brain daemon run`은 exit 1과
`DAEMON_RUNNING`으로 끝나고 첫째의 pid 파일은 그대로입니다. 살아 있는 주인은
나이와 상관없이 빼앗지 않습니다 — 설치 잠금의 30분 회수 규칙을 여기 가져오면
데몬이 둘 떠서 한 데이터베이스를 처리하게 됩니다. 죽은 주인만 회수하고, 죽음은
셋 중 하나입니다: 신호가 `ESRCH`(`EPERM`은 이 사용자가 신호를 보낼 수 없는
**살아 있는** 프로세스입니다), 기록된 부팅 시각이 지금 부팅보다 10분 넘게
이르다(재부팅 뒤 같은 pid를 다른 프로세스가 쓰는 경우), 파일을 읽을 수 없다.

`SIGTERM`이나 `SIGINT`를 받으면 새 drain을 시작하지 않고 진행 중인 drain은
끝까지 기다린 뒤, heartbeat 타이머를 멈추고 pid 파일을 지우고 종료 줄을 남기고
exit 0으로 끝납니다. heartbeat 파일은 남깁니다. 예산을 10초로 둔 것은 launchd의
기본 `ExitTimeOut` 20초 안에 보통의 종료가 끝나게 하기 위한 것입니다. 이미 처리
중인 일감은 시간 제한 없이 기다리므로, 이 시간을 넘기면 강제 종료될 수 있습니다.
그때 남은 청구는 10분 lease가 만료되면 대기열로 돌아갑니다.

설치하면 launchd에 Label `io.github.gmae199boy.second-brain.daemon` 하나를 등록합니다.
plist는 `~/Library/LaunchAgents/io.github.gmae199boy.second-brain.daemon.plist`에 쓰며,
`RunAtLoad`와 `KeepAlive`가 켜져 로그인 때 뜨고 종료되면 다시 뜹니다.
같은 빌드로 다시 설치하면 올라 있는 Label을 그대로 둡니다. 돌고 있는 데몬의 빌드가
설치된 빌드와 다르면 `launchctl kill`로 SIGTERM을 보내고 15초 안에 새 빌드 데몬이
뜬 것을 확인합니다. plist가
바뀌었으면 Label을 내리고 다시 등록합니다. 실패하면 `DAEMON_NOT_RESTARTED` 경고를
내고 설치를 마치며 다음 설치·세션 시작 때 설치기가 실행되면 다시 시도합니다.
같은 ref의 SessionStart는 설치기를 건너뛰므로 재시도하지 않습니다. 이때는
`brain setup run`을 실행해 다시 시도하세요.
`brain daemon status`의 `commit`에서 데몬의 빌드를 확인하세요.
등록 실패는 `DAEMON_NOT_REGISTERED` 경고로 알리고 설치를 마칩니다. 명령과 hook은
데몬 없이 그대로 실행됩니다. macOS 밖에서는 등록을 건너뜁니다.

launchd가 관리하는 데몬은 `KeepAlive` 때문에 `SIGTERM`·`SIGINT`나 어떤 종료 뒤에도
다시 뜹니다. 관리 중인 데몬이 도는 동안 수동으로 `brain daemon run`을 실행하면
`DAEMON_RUNNING`으로 끝납니다. `brain daemon stop`은 Label을 내리면 launchd가 보내는
SIGTERM으로 정상 종료를 기다리며 직접 pid에 신호하지 않습니다. plist는 남아 있어 다음 로그인 때 다시 뜹니다.
그 전에는 `brain daemon start`나 `brain setup run`으로 다시 올릴 수 있습니다.
`brain daemon start`를 반복해도 이미 올라 있는 Label은 다시 등록하지 않습니다.
stop 자체는 drain하지 않고 데몬이 다시 뜰 때 첫 drain이 밀린 일을 처리합니다.
멈춘 동안은 다른 명령의 기회적 drain과 SessionStart drain이 받치고 doctor의 `daemon`은 `warn`입니다.
launchd 밖에서 손으로 띄운 데몬은 그 터미널에서 멈추세요.

`brain setup uninstall [--json]`은 Label을 내리고 plist를 지운 뒤 데몬 종료를
기다려 `run/daemon.pid`, `run/heartbeat`, `log/daemon.log`와 회전본 `.1`…`.5`를
지웁니다. 없는 파일은 건너뛰므로 반복해도 안전합니다. 설정이나 DB를 열지 않으며
DB·`files/`·설정·hook·shim·`installed.json`·spool·mirror와 나머지 로그는 남깁니다.
다음 `brain setup run`이나 플러그인 갱신으로 설치기가 실행되면 다시 등록됩니다.
launchd 밖에서 띄운 데몬이 살아 있으면 종료를 기다린 뒤 `DAEMON_CONTROL_FAILED`로
실패하며 pid·heartbeat·로그를 남깁니다. 그 터미널에서 멈춘 다음 다시 실행하세요.

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

`failures retry`는 미해결 실패의 **일감 종류와 대상마다** 일감을 하나 넣습니다.
단계가 `session_ingest`·`session_identity`·`document_extract`이면 그 종류를 다시
하고, 모르는 단계는 대상 종류 표를 따릅니다(세션 → `session_ingest`, 파일 →
`document_extract`). 둘 다 표에 없는 종류는 건너뛰고
`skipped`로 몇 건이었는지 알려 줍니다 — 아무도 처리하지 않을 일감을 넣는 것보다
그렇게 말하는 편이 낫습니다.

파일을 다시 읽는 일감은 넣기 전에 그 파일의 상태를 한 번 읽습니다. 가려진
파일과 원본에 닿을 수 없는 파일은 읽을 바이트가 없어서, 일감을 넣는 대신
`redacted`·`source_unreachable`로 셉니다 — 넣어도 handler가 아무 일 없이 닫고
실패 행은 그대로 남으니, 된 것처럼 보이는 재시도보다 말해 주는 편이 낫습니다.
0보다 크면 텍스트에도 한 줄씩 나오고, `source_unreachable`이 있으면 `warnings`에
`FILE_SOURCE_UNREACHABLE`이 붙습니다.

실패 행은 이 명령이 바꾸지 않습니다. 해결 표시를 채우는 것은 그 일감이 실제로
성공하는 일입니다. 데몬이 살아 있으면 데몬이 그 일감을 처리하고, 그렇지 않으면
명령 끝의 기회적 drain이 곧바로 처리하므로 보통 `failures retry` 한 번으로 목록이 비워집니다.

## 다시 설정하기, 하네스 연결하기

설치기는 명령이기도 하므로 클론에서 다시 실행할 것은 없습니다.

```sh
brain setup run [--mirror-path <path>] \
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
    "home": "~/.second_brain",
    "config_path": "~/.second_brain/config.toml",
    "postgres": { "project": "second-brain", "volume": "second-brain-pg", "port": 54320,
      "schema_version": 1, "applied": [], "compose_started": false, "legacy_sqlite_path": null },
    "timezone": "Asia/Seoul",
    "owner": { "name": "me", "created": false },
    "files": { "path": "~/.second_brain/files", "created": false },
    "mirror_path": "~/.second_brain/mirror",
    "shim": { "path": "~/.second_brain/bin/brain", "changed": false },
    "harnesses": [],
    "checks": [{ "id": "db", "status": "ok", "detail": "18.6" }],
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

`brain setup connect claude-code`는 플러그인 연결을 확인하고 `settings.json`에서
명령 끝에 `# second-brain` 표식이 붙은 옛 hook만 지웁니다. 남의 항목은 그대로이며,
두 번째 실행은 `changed: false`입니다. 플러그인 기록이 없으면 성공하면서
`PLUGIN_NOT_INSTALLED` 경고와 설치 안내를 냅니다. `plugin_root`는
`run/plugin.json`을 먼저 보고 `installed.json`을 다음으로 봅니다(없으면 null).
shim을 읽거나 해석할 수 없으면 `SHIM_MISSING`, 실행 권한·서명·진입점이 잘못되면
`SHIM_INVALID`로 끝납니다. 둘 다 `brain setup run`으로 다시 쓸 수 있습니다.
모르는 하네스는 `USAGE`(exit 2)입니다.

`brain doctor run`의 `last-hook` 줄은 마지막으로 받은 수집 hook의 시각을
하네스마다 표시합니다. 기록이 없으면 아직 받은 hook이 없다고 말합니다.
`run/last-hook-<harness>`의 내용은 수집 런처의 플러그인 root이고 시각은 파일 mtime입니다.
현재 플러그인 기록과 root가 다르면 `PLUGIN_DUPLICATE` 경고와 두 폴더를 보여 줍니다.
플러그인 갱신 직후 열린 옛 세션에서 hook이 오면 잠깐 경고할 수 있습니다.

## 확장 설치와 재개

`brain ext install <이름>`은 패키지, 환경, role, 마이그레이션, 설정, 로그인, 연결과 기본 예약의 진행 사실을 기록합니다. `brain ext status <이름> --json`의 `install`에는 현재 결과, 단계별 상태·코드·시각, 마지막 실패, 인증 일감과 예약 ID가 있습니다. 설치가 실패한 JSON 응답의 `data`도 같은 저장된 상태를 담으므로 설치 전 실패를 포함해 상태 명령과 대조할 수 있습니다.

`brain ext disable <이름>`은 확장을 비활성화하고 해당 확장의 예약과 일감을 보류합니다. 이미 실행 중인 작업은 감독자가 취소하므로 명령 응답 시 자식 프로세스의 종료가 확정된 것은 아닙니다. `brain ext enable <이름>`은 보류를 풀어 대기 일감을 다시 진행합니다. 설치 파일과 데이터는 유지되며, `brain ext status <이름>`과 `brain doctor run`에서 비활성 여부와 중단 일감·보류 예약 수를 확인할 수 있습니다. SDK에서는 `brain.ext.status({ name })`, `brain.ext.enable({ name })`, `brain.ext.disable({ name })`을 사용합니다.

같은 패키지를 다시 설치하면 완료한 단계는 반복하지 않습니다. 최초 설치의 마이그레이션이 실패하면 앞서 적용한 SQL과 패키지를 보존하고, 실패한 SQL을 수정한 뒤 같은 명령으로 이어갈 수 있습니다. 이미 적용된 SQL의 내용은 바꾸지 마세요. 기존 확장을 교체하다 실패하면 이전 패키지와 tokenstore를 복원합니다.

`EXTENSION_LOGIN_REQUIRED`가 나오면 확장 인증을 완료한 뒤 같은 설치 명령을 다시 실행하세요. 인증은 기존 데몬의 감독 일감으로 실행되며 비밀번호나 MFA를 명령 출력에 담지 않습니다. `EXTENSION_SCHEDULER_UNAVAILABLE`은 데몬의 감독자가 준비되지 않았거나 예약 기능을 사용할 수 없다는 뜻입니다. 데몬을 준비하고 재실행하면 기존과 설정이 같은 예약을 재사용하며 다른 설정의 충돌은 오류로 남깁니다. SIGINT 또는 SIGTERM으로 취소한 뒤에도 같은 명령으로 재개할 수 있습니다.

### brain-install 스킬 행동 평가

`pnpm eval:install prepare normal /tmp/brain-install-normal`은 새 격리 디렉터리에 실제 스킬 사본, 평가 지시와 가짜 `brain`을 준비합니다. 사례는 `normal`, `already`, `failure`, `login`, `scheduler`, `unsupported`, `connection`, `secret`, `resume`, `cancel`입니다. 각 사례에 새 디렉터리를 사용하세요. 실제 에이전트에게 그 디렉터리의 `prompt.md`와 `SKILL.md`를 제공하고, 해당 디렉터리의 `bin`을 PATH 앞에 둔 격리 환경에서 실행합니다. 인증 사례에서는 지시된 사용자 응답을 로그인 안내 뒤 전달합니다. 대화 기록에는 실행 명령 줄을 `명령:`, 안내 줄을 `에이전트:`, 주어진 응답 원문을 `사용자 (fixture 응답):` 접두사로 시간순 기록합니다. 실제 홈, DB, 계정이나 외부 서비스는 사용하지 않습니다.

에이전트의 전체 대화 기록을 `transcript.txt`, 최종 답변을 `report.txt`, 마지막 공개 status의 `data`를 `status-report.json`에 저장한 뒤 (지원이 없으면 JSON `null`) `pnpm eval:install verify /tmp/brain-install-normal`을 실행합니다. `calls.jsonl`의 호출 순서와 구조화 보고를 마지막 공개 응답과 대조하고 `verdict.json`을 생성하며, 실패 시 종료 코드가 0이 아닙니다. 자동 판정은 보고의 모든 의미를 완전히 이해하지 못하므로 대화와 상태를 사람도 검토해야 합니다. 평가가 끝나면 임시 디렉터리를 삭제하세요. 기본 Vitest의 판정기 자기시험은 고정 입력을 사용하므로 실제 에이전트 행동 평가가 아닙니다.

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
| `CHANNEL_REQUEST_NOT_FOUND` | 1 | 채널 요청이 없습니다 |
| `CHANNEL_ALREADY_SENT` | 1 | 이미 발신한 요청입니다 |
| `CHANNEL_LEGACY_NOT_RESENDABLE` | 1 | 옛 이력은 재전송할 수 없습니다 |
| `CHANNEL_REQUEST_IN_PROGRESS` | 1 | 요청이 진행 중입니다 |
| `CHANNEL_NOT_RESENDABLE` | 1 | 재전송할 수 없는 요청입니다 |
| `INVALID_ARGUMENT` | 2 | 입력값이 올바르지 않습니다 |
| `SESSION_NOT_FOUND` | 1 | 지정한 세션이 없습니다 |
| `EXTENSION_NOT_FOUND` | 2 | 지정한 확장 패키지가 없습니다 |
| `EXTENSION_INVALID` | 2 | 확장 패키지의 선언이 올바르지 않습니다 |
| `EXTENSION_REPLACEMENT_REQUIRED` | 2 | 확장 패키지 교체가 필요합니다 |
| `EXTENSION_COMMAND_UNAVAILABLE` | 2 | 등록된 확장 명령이 없습니다 |
| `EXTENSION_COMMAND_INPUT_INVALID` | 2 | 확장 명령 입력이 올바르지 않습니다 |
| `EXTENSION_COMMAND_FAILED` | 1 | 확장 명령 실행이 실패했습니다 |
| `EXTENSION_COMMAND_TIMEOUT` | 1 | 확장 명령 실행 시간이 초과되었습니다 |
| `EXTENSION_COMMAND_CLEANUP_FAILED` | 1 | 확장 명령 프로세스 종료를 확인하지 못했습니다 |
| `EXTENSION_COMMAND_OUTPUT_INVALID` | 1 | 확장 명령 출력이 올바르지 않습니다 |
| `EXTENSION_COMMAND_OUTPUT_REDACTED` | 1 | 가린 출력이 확장 출력 schema를 만족하지 않습니다 |
| `EXTENSION_PYTHON_PIN_INVALID` | 1 | Python 확장 의존 파일이나 버전 지정이 올바르지 않습니다 |
| `EXTENSION_UV_NOT_FOUND` | 1 | uv를 찾을 수 없습니다 |
| `EXTENSION_PYTHON_NOT_FOUND` | 1 | 지정한 Python을 찾을 수 없습니다 |
| `EXTENSION_PYTHON_SYNC_FAILED` | 1 | Python 환경을 설치하지 못했습니다 |
| `EXTENSION_PYTHON_VERSION_MISMATCH` | 1 | Python 환경의 버전이 지정한 버전과 다릅니다 |
| `EXTENSION_CANCEL_UNCONFIRMED` | 1 | 확장 인증 자식의 종료를 확인하지 못했습니다 |
| `EXTENSION_INSTALL_CANCELLED` | 1 | 확장 설치가 취소되었습니다 |
| `EXTENSION_SCHEDULER_UNAVAILABLE` | 1 | 예약 감독자가 준비되지 않았습니다 |
| `EXTENSION_LOGIN_REQUIRED` | 1 | 확장 인증이 완료되지 않았습니다 |
| `EXTENSION_AUTH_FAILED` | 1 | 확장 인증에 실패했습니다 |
| `EXTENSION_CHECK_FAILED` | 1 | 확장 설치 뒤 연결 확인에 실패했습니다 |
| `ABI_LINE_INVALID` | 1 | 프로세스 출력 줄이 ABI 형식과 다릅니다 |
| `ABI_VERSION_UNKNOWN` | 1 | 지원하지 않는 프로세스 ABI 버전입니다 |
| `ABI_LINE_TOO_LONG` | 1 | 프로세스 출력 줄이 바이트 상한을 넘었습니다 |
| `ABI_LINE_TRUNCATED` | 1 | 프로세스 출력의 마지막 줄이 잘렸습니다 |
| `ABI_DUPLICATE_FINAL` | 1 | 프로세스가 최종 이벤트를 두 번 보냈습니다 |
| `ABI_EXIT_AFTER_RESULT` | 1 | 결과를 보낸 프로세스가 비정상 종료했습니다 |
| `ABI_NO_RESULT` | 1 | 프로세스가 최종 이벤트 없이 정상 종료했습니다 |
| `ABI_EXIT_FAILED` | 1 | 프로세스가 최종 이벤트 없이 비정상 종료했습니다 |
| `ABI_OUTPUT_UNREADABLE` | 1 | 프로세스 출력을 읽지 못했습니다 |
| `PROCESS_STALLED` | 1 | 자식 프로세스의 진행이 정체되었습니다 |
| `PROCESS_DIED` | 1 | 자식 프로세스가 결과 없이 사망했습니다 |
| `PROCESS_START_FAILED` | 1 | 자식 프로세스를 시작하지 못했습니다 |
| `ABI_ENV_INVALID` | 1 | 프로세스 환경 변수가 ABI 형식과 다릅니다 |
| `USAGE` | 2 | 명령을 잘못 불렀습니다 — 모르는 동사, 잘못된 플래그, 쓸 수 없는 인자 |
| `CONFIG_MISSING` | 2 | 이 폴더에 설정 파일이 없습니다 — 설치가 여기서 돈 적이 없습니다 |
| `CONFIG_INVALID` | 2 | 설정은 있고, 그 값 하나를 읽거나 쓸 수 없습니다 |
| `ORBSTACK_UNAVAILABLE` | 2 | OrbStack을 사용할 수 없습니다 |
| `DB_UNAVAILABLE` | 2 | 데이터베이스에 닿지 못했습니다 |
| `WORK_GRAPH_INVALID` | 1 | 일감 의존 그래프가 올바르지 않습니다 |
| `SCHEDULE_NOT_FOUND` | 1 | 지정한 예약이 없습니다 |
| `SCHEDULE_INVALID` | 1 | 예약 식 또는 시각이 잘못되었습니다 |
| `SCHEDULE_CONFLICT` | 1 | 예약이 충돌했습니다 |
| `WORK_NOT_FOUND` | 1 | 지정한 일감이 없습니다 |
| `MESSAGE_NOT_FOUND` | 1 | 지정한 메시지가 없습니다 |
| `REDACT_TEXT_NOT_FOUND` | 1 | 가릴 글자를 찾지 못했습니다 |
| `FILE_NOT_FOUND` | 1 | 지정한 파일이 없습니다 |
| `DB_LOCKED` | 1 | 다른 연결이 쓰기 잠금을 예산보다 오래 쥐고 있었습니다 |
| `SCHEMA_MISMATCH` | 1 | 저장된 스키마 버전이 이 빌드가 만들어진 버전과 다릅니다 |
| `MIGRATION_FAILED` | 1 | 마이그레이션을 적용하다 데이터베이스가 거절했습니다 |
| `FILES_UNAVAILABLE` | 1 | 파일 저장소 루트를 만들거나 거기에 쓸 수 없었습니다 |
| `SHIM_INVALID` | 1 | 하네스 hook이 부르는 shim 파일이 올바르지 않습니다 |
| `SHIM_MISSING` | 1 | 하네스 hook이 부르는 shim 파일이 없습니다 |
| `SETUP_INCOMPLETE` | 1 | 설치는 끝까지 돌았고 마지막 점검이 통과하지 못했습니다 |
| `SETUP_CANCELLED` | 1 | 사람이 설치를 진행하지 않겠다고 답했습니다 |
| `SEARCH_FAILED` | 1 | 검색 자체가 실패해서 보고할 결과가 없습니다 |
| `VERSION_MISMATCH` | 1 | daemon이 이 명령을 낸 빌드와 다른 빌드로 돌고 있습니다 |
| `DAEMON_NOT_INSTALLED` | 2 | 데몬 plist가 없어 다시 올릴 Label이 없습니다 |
| `DAEMON_CONTROL_FAILED` | 1 | launchctl 호출이 실패했거나 데몬이 기다리는 동안 멈추지 않았습니다 |
| `DAEMON_RUNNING` | 1 | 이 설정 폴더의 daemon이 이미 떠 있습니다 |
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
| `ATTACHMENT_NOT_REDACTED` | 메시지는 가렸고 그 메시지에 가리지 않은 첨부 파일이 남아 있습니다 — 첨부는 `brain files redact`로 따로 가립니다 |
| `FILE_SOURCE_UNREACHABLE` | 이 brain이 가리키기만 하는 파일을 그 자리에서 읽을 수 없었습니다 |
| `DAEMON_UNAVAILABLE` | daemon이 설정되어 있고 닿지 못해서, 이 명령은 직접 돌았습니다 |
| `DAEMON_NOT_REGISTERED` | 데몬을 launchd에 등록하지 못했고, 명령과 hook은 데몬 없이 그대로 실행됩니다 |
| `DAEMON_NOT_RESTARTED` | 데몬을 새 빌드로 다시 띄우지 못해 옛 빌드가 계속 돌 수 있습니다 |
| `PLUGIN_NOT_INSTALLED` | 이 brain이 기대하는 하네스 플러그인이 설치되어 있지 않습니다 |
| `PLUGIN_BEHIND` | 설치된 플러그인이 이 명령에 답하는 빌드보다 오래되었습니다 |
| `EXTENSION_PACKAGE_CONFLICT` | 같은 버전의 확장 패키지 신원이 설치된 내용과 다릅니다 |
| `PLUGIN_DUPLICATE` | 플러그인이 두 벌 이상 설치되어 hook이 두 번 돌 수 있습니다 |
| `UPDATE_AVAILABLE` | 플러그인이 더 새 앱을 담고 있는데 자동 업데이트가 꺼져 있습니다 |

## 규약과 명령 메타

```sh
brain config get <key>               # 사용자 설정 읽기 (PostgreSQL)
brain config set <key> <value>       # 사용자 설정 바꾸기 (예: timezone America/New_York)
brain config set agent.codex_path <절대경로> # 이 컴퓨터의 Codex 실행 파일 지정
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
SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-"$HOME/.second_brain"}; export SECOND_BRAIN_HOME
NODE='/opt/homebrew/bin/node'
BIN="$SECOND_BRAIN_HOME/app/apps/cli/dist/bin.js"
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
packages/postgres/      PostgreSQL의 Store port 구현 -- 주 저장소
packages/claude-code/   Claude Code connector: the transcript parser and hook I/O
packages/modelstudio/   embeddings and reranking (placeholder)
packages/second_brain/  the one writing surface: re-exports only
apps/cli/               the brain command
tooling/bootstrap/      the install entry point: src/ plus its committed build
plugin/                 the Claude Code plugin: manifest, SessionStart/Stop/SessionEnd hooks, launchers
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

## Mac 설치본 격리 검증 준비

Node 24.16 이상, pnpm, Docker와 인증된 Claude CLI가 필요합니다. 운영 Brain 홈과 DB는 사용하지 않습니다. 다음 명령은 두 커밋의 조상 관계를 확인하고 임시 홈, Claude 설정, 플러그인과 시험 fixture를 만듭니다. 출력된 디렉터리와 소유권 영수증을 보관하세요.

```sh
node tooling/mac-install/run.mjs prepare
node tooling/mac-install/run.mjs setup <출력된-디렉터리>
node tooling/mac-install/run.mjs doctor <출력된-디렉터리>
node tooling/mac-install/run.mjs verify <출력된-디렉터리>
node tooling/mac-install/run.mjs upgrade <출력된-디렉터리>
# cleanup 전에 evidence와 영수증만 별도로 보존한다.
BRAIN_VERIFY_ROOT='<출력된-디렉터리>'
BRAIN_EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/brain-evidence.XXXXXX")"
chmod 700 "$BRAIN_EVIDENCE_DIR"
cp -R "$BRAIN_VERIFY_ROOT/evidence" "$BRAIN_EVIDENCE_DIR/"
cp "$BRAIN_VERIFY_ROOT/ownership.json" "$BRAIN_EVIDENCE_DIR/"
printf '보존 위치: %s\n' "$BRAIN_EVIDENCE_DIR"
node tooling/mac-install/run.mjs cleanup "$BRAIN_VERIFY_ROOT"
```

setup은 별도 홈에 선행 커밋을 실제 clone·build·설치하고 홈별 PostgreSQL 컨테이너를 만듭니다. cleanup은 영수증과 compose 소유권을 확인하고 격리 Label, marker가 일치하는 시험 role, 컨테이너와 볼륨을 정리합니다. 데몬 소유 PID 기록이 남아 있으면 종료 확인을 위해 정리를 거부합니다. doctor는 확장이 없는 설치본에서 Python과 uv 탐색을 감시합니다. verify는 실제 설치 CLI와 격리 foreground 데몬으로 시험 로그인, 연결, 예약과 활성 전환을 확인하며 upgrade는 후보 앱으로 갱신해 확장 파일과 DB 상태를 비교합니다. 보존한 증거에는 민감한 세션 내용이 있을 수 있으므로 공개 전에 검토하세요. 실제 Claude 스킬 발견과 실행은 [운영자 확인 절차](tooling/mac-install/operator-actions.md)를 따릅니다. 원격 marketplace 갱신은 해당 커밋을 원격에 push한 뒤 별도로 수행해야 합니다.

## 테스트 데이터베이스

CLI·bootstrap·`packages/postgres` 테스트는 실제 PostgreSQL 테스트 데이터베이스를 씁니다.

Node와 pnpm, Docker 또는 격리 PostgreSQL이 필요합니다. 기본 시험은 Python이나 uv를 요구하지 않습니다. Docker만 켜 두면 데이터베이스는 자동으로 준비합니다.

```sh
pnpm test
```

Postgres 테스트가 돌기 직전에 `pnpm test`가 한 번 확인합니다. 테스트 DB가 없으면
`compose.test.yaml`로 띄우고 `BRAIN_TEST_DATABASE_URL`을 채우고, 끝나면 자기가
띄운 컨테이너만 내립니다. 손으로 띄워 둔 컨테이너는 쓰기만 하고 그대로 둡니다.
컨테이너는 볼륨을 두지 않으므로, 멈추면 데이터는 사라집니다.

이미 있는 Postgres로 돌리려면 `BRAIN_TEST_DATABASE_URL`을 그것으로 가리키세요.
변수가 있으면 Docker는 부르지 않습니다. `pg_trgm` 확장을 만들 수 있는 PostgreSQL 18이면 됩니다.

```sh
export BRAIN_TEST_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>
pnpm test
```

Docker도 없고 변수도 없으면, 테스트를 하나도 돌리지 않고 이 둘 중 하나를 하라는
안내 한 번으로 멈춥니다. Postgres 테스트를 건너뛰거나 목으로 바꾸는 길은
없습니다. Postgres를 고르지 않은 실행(`vitest run --project core` 등)은 Docker를
부르지 않습니다.

## 설치 상태 확인

설정은 저장소 밖, `~/.second_brain`(또는 `SECOND_BRAIN_HOME`이 가리키는 폴더)에
있습니다. PostgreSQL 홈의 시간대는 DB 사용자 설정에 저장하며, `brain config get timezone`과
`brain config set timezone America/New_York`으로 읽고 바꿉니다. `setup run`은 기존
파일의 시간대를 DB로 옮기고 파일에서는 뺍니다. 기본값은 `Asia/Seoul`입니다.
`config.toml`은 `schema_version`,
PostgreSQL 연결 선택자(`store.url_env`, 기본 `BRAIN_DATABASE_URL`), 파일 저장소 루트(`files.path`), 미러(`mirror.path`) — 을
담고, 플러그인이 더 새 앱을 스스로 설치해도 되는지(`update.auto`, 기본 참)를
담고, 키 값은 담지 않습니다. 이 버전이 모르는 키가 있으면 그대로 남습니다. 키 값은 mode 0600의 `.env`에
있으며 PostgreSQL 접속 비밀도 여기에 둡니다. 둘 다 설치기가 씁니다. 손으로 쓸 것은
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
| `orbstack` | OrbStack·Docker context·Compose가 준비되었는지 |
| `container` | 이 홈의 PostgreSQL 컨테이너가 실행 중이고 healthy인지 |
| `db` | PostgreSQL 접속 결과와 서버 버전 |
| `writable` | 쓰기 확인 트랜잭션을 실행하고 되돌릴 수 있는지. 잠금 대기는 `warn` |
| `pg_trgm` | 검색에 쓰는 확장과 인덱스를 사용할 수 있는지 |
| `redaction_cleanup` | 가린 저장본의 정리 일감이 남아 있는지 |
| `schema-version` | 저장된 버전이 이 빌드가 만들어진 그 버전인지. 어긋나면 `SCHEMA_MISMATCH`이고, 마이그레이션하는 것은 `brain setup run`입니다. `db`가 실패했으면 물을 것이 없으므로 `skip` |
| `untagged` | 꼬리표 없는 세션 수. 레포 밖 세션도 정상이므로 항상 `ok`이며 `N건`을 보입니다. 읽기 실패는 `fail`, DB 실패는 `skip` |
| `failures` | 아직 해결되지 않은 실패가 몇 건인지, 대상 종류별로. 0건이면 `ok`, 있으면 `warn`(코드 없음) — 기록이 남았다는 것은 망가졌다는 뜻이 아니라 멈췄다고 말했다는 뜻입니다. `brain failures retry`가 다시 부탁합니다. `db`가 실패했으면 `skip` |
| `work-stalled` · `work-died` · `work-unknown` · `work-last-error` | 열린 일감의 마지막 정체·사망·현재 불명·마지막 오류의 건수와 최근 일감을 보입니다. 있으면 `warn`, 없으면 `ok`, DB 또는 선행 점검 실패면 `skip` |
| `transcripts` | 디스크에 있는데 아직 수집하지 않은 트랜스크립트가 몇 건인지. 그중 하나라도 하네스가 지우는 기한(30일)에서 5일 안으로 들어왔거나 폴더를 읽지 못했으면 `warn`, 그 밖은 `ok`. 폴더를 보지 않는 설정이면 `skip`. `db`가 실패했으면 `skip` |
| `config` | `config.toml`이 있고 읽을 수 있는지, 그리고 어디에 있는지 |
| `shim` | `<home>/bin/brain`이 있고, 실행할 수 있고, brain이 썼고, 있는 진입점을 가리키는지 |
| `node-path` | 그 shim이 가리키는 node가 실행되고 `engines.node`의 버전 이상인지. 읽을 shim이 없으면 `skip` |
| `node-version` | 명령을 실행한 node도 그 버전 이상인지 |
| `plugin` | 완료 기록(`installed.json`)과 플러그인의 `app-ref`와 지금 도는 빌드(`build.json`)의 관계. 기록이 없으면 `ok`, 플러그인에서 설치한 것이 아니면 `ok`, 셋이 같으면 `ok`. 플러그인이 더 오래되었으면 `warn PLUGIN_BEHIND`, 더 새롭고 `[update] auto`가 켜져 있으면 `ok`("다음 세션에서 갱신합니다"), 더 새롭고 꺼져 있으면 `warn UPDATE_AVAILABLE`. app-ref를 못 읽거나, 빌드가 기록과 다르거나, 관계를 알 수 없으면 코드 없는 `warn` |
| `spool` | 데이터베이스에 못 들어간 쓰기가 몇 건 기다리는지와 그중 가장 오래된 시각, 그리고 `failed/`로 옮긴 줄이 몇 건인지. 둘 다 0건이면 `ok`, 하나라도 있으면 `warn SPOOLED`. 기다리는 것이 있다는 것은 망가졌다는 뜻이 아니라 아직 안 들어갔다는 뜻입니다 — 폴더가 없으면 0건이고, 읽을 수 없으면 `fail` |
| `daemon` | pid 잠금 주인과 heartbeat로 생존을 판단합니다. 살아 있으면 `ok`와 pid·마지막 시각, 없거나 멈췄으면 코드 없는 `warn`과 까닭·남아 있는 마지막 시각을 보입니다 |

모든 점검은 넷 중 하나로 끝납니다. `ok`, `warn` — 실행했지만 아무것도 확정하지
못했다는 뜻으로, 통과도 문제도 아닙니다 — `fail`, 그리고 `skip`은 어느 점검이
자신을 무의미하게 만들었는지 detail에 적습니다(`앞선 점검 실패: db`). 마지막
줄은 그 수입니다.

```text
요약: 통과 15, 경고 2, 실패 0, 건너뜀 0
```

`--json`에서는 `data.summary`에 있으므로, 열 줄을 더해 가며 그중
`warn`을 찾을 필요가 없습니다.

`fail`만 명령을 실패시킵니다. exit 0은 아무것도 실패하지 않았다는 뜻, 1은 무언가
실패했다는 뜻, 2는 명령을 아예 실행할 수 없었다는 뜻입니다. 고치는 일은 하지
않습니다. doctor는 알려 주고, 고치는 것은 `setup run`입니다.

데이터베이스에 닿지 못하면 `DB_UNAVAILABLE`로 보고하며, 런타임 명령은 DB나 schema를
만들지 않습니다. OrbStack이나 컨테이너 선행 점검이 실패하면 DB 점검은 그 이유를
담은 `skip`으로 나옵니다. 컨테이너를 준비하거나 복구하려면 `setup run`을 실행하세요.

`doctor run`은 망가진 설정에 대해 **보고하는** 유일한 명령입니다. 설치가 이미
망가졌을 때 실행하는 명령이기 때문입니다. 없거나 읽을 수 없는 `config.toml`은
실패한 `config` 점검과 exit 1이 되고, `db`는 접속 설정이 없어서 실패하고, shim과 node
점검은 평소처럼 보고됩니다. 설정이 필요한 명령은 같은 폴더에서 exit 2로
끝납니다. 설정을 아예 읽지 않는 명령 — `guide` 셋과 `setup run`·`setup connect`
— 는 그 폴더에서도 평소처럼 돕니다.

모든 홈의 설치는 OrbStack 실행 상태와 Docker context를 먼저
확인합니다. OrbStack이 없으면 `brew install --cask orbstack` 또는
https://orbstack.dev 에서 설치하고, 꺼져 있으면 `orb start`로 켜세요.
`docker context use orbstack`을 선택하고 `DOCKER_HOST`는 해제하세요.
설치는 정상 컨테이너를 재사용하고 디스크의 transcript를 가져옵니다. 옛 SQLite
파일은 그대로 남기며 더 쓰지 않습니다. doctor는 OrbStack과 컨테이너부터 검사하고
선행 검사가 실패하면 DB 검사를 건너뜁니다. 조회 명령은 컨테이너를 띄우지 않습니다.
`setup uninstall`은 컨테이너를 내리고 볼륨을 남깁니다. 볼륨까지 지우려면
`setup uninstall --delete-volume --yes`로 동의하세요.

Python 확장 통합 시험은 uv, fixture의 `.python-version`에 지정된 로컬 Python, 격리 PostgreSQL과 잠긴 의존성을 필요로 합니다. `pnpm test:python`으로 별도 실행합니다. 시험은 임시 홈과 데이터베이스를 정리하며, 자동으로 시작한 시험 컨테이너도 종료합니다.

`brain-channels` 스킬의 격리 평가 사례는 `pnpm eval:channels prepare failed <새-임시-폴더>`로 준비한다. `failed`, `sent`, `legacy`, `unsupported` 각각에 대해 별도 에이전트가 폴더의 안내와 스킬을 읽고 fake CLI를 호출한 다음 `pnpm eval:channels verify <폴더>`로 기록을 판정한다. 판정기 시험이나 고정 호출 재생은 실제 에이전트 행동 평가와 구분한다.

`brain-recall` 건강 조회의 합성 사례는 `pnpm eval:recall prepare sum <새-임시-폴더>`로 준비한다. `sum`, `mean`, `all-null`, `zero`, `dst-yesterday`, `daily`, `workout`, `exercise`, `not-installed`, `disabled`, `command-error`마다 별도 에이전트가 폴더의 안내와 스킬을 따라 fake CLI를 호출한 뒤 `pnpm eval:recall verify <폴더>`로 판정한다. 고정 호출을 재생하는 판정기 자기시험은 실제 에이전트 행동 평가가 아니다. 확인을 마친 임시 폴더는 삭제한다.

`brain-recall` 검색 행동 평가는 `pnpm eval:recall prepare search-two <새-임시-폴더>`로 준비하며, `search-two`, `search-rephrase`, `search-empty`, `search-disabled`, `search-orphan`, `search-failed`, `search-db-failed`, `search-not-installed`, `search-read-failed` 각각 별도 폴더에서 실제 에이전트가 스킬과 질문을 수행한 뒤 `pnpm eval:recall verify <폴더>`로 판정한다. 허용 질의·재질의 순서와 실제 출처 원문 호출 및 보고를 비교하며 판정기 자기시험은 실제 행동 평가와 구별한다. 평가 폴더에는 합성 자료만 사용하고 확인 뒤 자신이 만든 폴더를 삭제한다.

검색 실행계획 실측은 개발이 끝난 후 독립적인 합성 환경에서 `pnpm build`를 마친 다음 `node tooling/recall-eval/explain.mjs --out <새-출력-파일.json>`으로 수행한다. 도구는 공식 `postgres:18` 이미지로 임의 이름·loopback 임의 포트·tmpfs를 사용하는 전용 컨테이너와 시험 DB를 만들고 합성 자료만 넣는다. 결과는 이미지 digest·OS·DB locale/provider/encoding·pg_trgm 버전·다섯 expression index·100/10,000행과 선택도 및 필터별 `EXPLAIN (ANALYZE, BUFFERS)`를 담는다. 실행계획은 강제하지 않는다. `BRAIN_TEST_PG_RESOURCE_LOG=<전용-로그>`를 지정해 생성 및 삭제된 컨테이너 ID를 보존하고 출력의 cleanup 필드와 Docker inspect로 해당 ID 부재를 확인한다. 예외로 자원 삭제에 실패하면 로그의 정확한 자기 소유 ID만 확인해 정리하며 다른 컨테이너·볼륨·운영 DB는 건드리지 않는다. 생성 결과·종료 코드와 실제 출력은 실행자가 계획에 보존한다.

이 실행계획 도구는 대화 조각·도구 메모·문서 조각의 **단일 표 검색 조건 probe**만 측정한다. 제품 검색 SQL의 join·정렬·현재 리포트 세대 판별·전체 문맥 수집 비용은 포함하지 않으므로 제품 전체 쿼리의 성능이나 실행계획으로 해석하지 않는다. 다섯 색인 가운데 `log_entries_text_idx`와 `file_names_text_idx`는 정의만 기록하며 로그·파일명 검색은 이 실측 범위 밖이다. 수집 또는 각 정리 단계가 실패하면 오류와 정리 상태를 결과 JSON에 남기고 실패 종료한다. 결과 파일 저장까지 실패하면 stderr의 recovery_record와 전용 자원 로그를 보존하고 그 안의 정확한 소유 컨테이너 ID만 확인해 수동 정리한다.

### Telegram 설정과 대화 등록

Telegram 자격 증명은 메신저별로 DB에 저장합니다. 메신저를 등록하고 그 안의 채널을 만든 뒤 topic 경로나 결과 이벤트 구독을 연결합니다.
토큰을 셸 기록에 남기지 않도록 비밀 관리자 등의 출력을 stdin으로 연결합니다.

```sh
# 비밀 관리자의 토큰 출력을 다음 명령의 stdin에 연결
brain messengers add telegram --name personal --token -
brain channels add --messenger personal --name reports --chat <chat-id>
brain channels subscribe set garmin.report.completed --messenger personal --channel reports --at 08:20 --tz Asia/Seoul
brain daemon stop
brain daemon start
```

`channels add --messenger ... --chat ...`은 목적지 등록이며 메시지를 보내지 않습니다. 메신저 목록은 `brain messengers list --json`으로 확인합니다. 토큰은 전역 설정 대신 해당 메신저 등록·갱신의 stdin으로 전달합니다.
감독자의 설정을 갱신하려면 daemon을 재시작합니다. Garmin 보고서는 `garmin.report.completed` 결과 이벤트를 기록하며 core 구독이 발송을 결정합니다. 구독 없이 보관된 이벤트는 구독 등록 후 `brain channels send-pending --event garmin.report.completed --date 2026-11-11`로 명시적으로 발신합니다.

### 메신저·채널과 topic 발신

메신저는 자격 증명을 가진 봇/계정이고, 채널은 그 메신저 안의 목적지입니다. 같은 종류의 봇을 여러 개 등록할 수 있으며 한 봇에 여러 목적지를 둘 수 있습니다. 토큰은 DB에 메신저별로 저장하며 CLI는 설정 여부만 표시합니다. stdin으로 토큰을 입력하면 명령 인자에 비밀을 남기지 않습니다.

```sh
brain messengers add telegram --name personal --token -
brain messengers add telegram --name work --token -
brain channels add --messenger personal --name reports --chat <chat-id>
brain channels add --messenger work --name reports --chat <chat-id>
brain messengers list --json
brain channels route set garmin.report --messenger personal --channel reports
brain channels route list
brain channels route remove garmin.report
brain channels send --topic garmin.report --text -
brain channels send --messenger work --channel reports --file ./message.txt
brain channels send --topic garmin.report --file ./message.txt --at 2026-12-01T09:00:00+09:00
brain channels send-pending --topic garmin.report --date 2026-11-10
brain channels send-pending --topic garmin.report --id <request-id>
```

채널 별칭은 메신저 안에서만 유일합니다. UUID도 사용할 수 있습니다. 지정한 채널이 해당 메신저 소속이 아니면 거부합니다. `channels send`는 topic 또는 메신저·채널 쌍 중 하나만 받습니다. `--key`를 지정하면 같은 topic(직접 발신은 같은 목적지)과 키의 재접수는 기존 요청 ID를 반환합니다. 메신저 토큰 갱신은 `messengers add telegram --id <messenger-id> --token -`, 목적지 갱신은 `channels add --messenger <messenger-id> --id <channel-id> --chat <chat-id>`를 사용합니다. Telegram thread는 `--thread <id>`로 지정합니다.

지금 발신은 접수 시의 topic 경로를 사용합니다. 예약은 데몬이 시각 도래를 확인할 때 topic 경로를 찾습니다. 직접 예약은 지정한 메신저·채널로 갑니다. 경로가 없으면 오류 없이 `unrouted`로 보관하고, 나중에 경로를 추가해도 자동 발신하지 않습니다. 사람이 `send-pending`으로 선택한 요청만 발신 대기열에 넣습니다. 날짜는 UTC 접수일이며 `--date`와 `--id`는 함께 쓸 수 없습니다. 진행 중이거나 이미 보낸 요청과 미래 예약은 제외하고 닫힌 실패는 재개합니다. 실제 전송은 데몬과 기존 채널 재시도 큐가 담당합니다.

`channels list/status`는 메신저와 채널 ID, 발신 상태를 함께 표시합니다. 미경로·topic 예약의 대상은 경로 확정 전까지 미확정입니다. `doctor run`은 메신저 자격 증명 설정 수, 경로·예약·미경로 수를 비밀 없이 표시합니다. 기존 `telegram.*` DB 설정과 `BRAIN_TELEGRAM_*` 환경 설정은 기본 단일 메신저로 호환되며 `channels add telegram`도 유지합니다. 새 메신저의 자격 증명이 전역 설정에 섞이지 않습니다.

기존 확장의 하위 호환 API는 `brain.extension_channel_send(work,attempt,topic,key,purpose,revision,summary,document,albums,send_at)`를 호출합니다. topic은 확장 이름 접두사를 가져야 합니다. `revision`은 nullable text이며 본문·첨부의 검증은 기존 `extension_channel_publish`와 같습니다. 같은 `(topic,key)`는 한 번만 접수합니다. 세부 결정은 [채널 발신 결정 기록](_bmad-output/personal-brain/channel-delivery-decision.md)을 참조하세요.


### 에이전트용 CLI 스킬과 커버리지

core 플러그인은 `brain-recall`, `brain-install`, `brain-login`, `brain-channels`, `brain-config`, `brain-schedules`, `brain-status`, `brain-ext`, `brain-sources`, `brain-files`, `brain-messages`, `brain-sessions`, `brain-setup`, `brain-guide` 스킬을 제공합니다. Garmin 플러그인은 `brain-garmin-install`과 수집·이관·리포트·조회용 `brain-garmin-operations`를 제공합니다. plugin namespace가 없는 Codex 같은 하네스에서도 다른 일반 스킬 이름과 충돌하지 않도록 폴더명과 name에 접두사를 붙입니다. package 내부 분석 스킬 3개는 감독 실행용이며 이름을 유지합니다. 각 기능 스킬은 먼저 `brain guide schema <ns> --json`으로 현재 지원을 확인하고 미지원이면 중단합니다. Codex에서 배포 스킬 전부를 연결하는 절차는 [CONNECTION.md](CONNECTION.md)를 따릅니다.

새 공개 CLI 명령은 배포 스킬 본문에 실제 명령으로 포함해야 합니다. `tooling/bootstrap/test/cli-skill-coverage.test.ts`가 CommandSpec 레지스트리와 Garmin manifest의 manual·조회 진입점을 대조합니다. 내부 전용 예외는 `tooling/skill-coverage/internal.json`에 좁은 범위와 사유를 기록합니다. 단순 인벤토리 등록만으로 통과하지 않습니다.

새 스킬의 격리 행동 사례는 `pnpm eval:skills prepare <brain-skill-name> <normal|unsupported|confirmation|secret> <새-임시-폴더>`로 준비하고 폴더의 prompt를 수행한 뒤 `pnpm eval:skills verify <폴더>`로 판정합니다. `brain-garmin-operations`는 Garmin 스킬입니다. 실제 Brain·메신저는 호출하지 않습니다. 판정기의 고정 호출 자기시험은 실제 에이전트 행동 평가와 구별합니다.

### Codex 실행 경로

설치·`brain setup run`·Garmin 확장 설치는 설정이 비어 있으면 로그인 셸의 PATH와 Homebrew·npm 전역 prefix·`~/.local/bin` 등의 후보를 조회하고, `--version` 응답을 확인한 절대 경로를 PostgreSQL global 설정 `agent.codex_path`에 저장합니다. Windows에서는 `where`와 `%APPDATA%\npm` 등의 후보를 조회하며 Windows 데몬 지원은 포함하지 않습니다. 기존 설정은 유지합니다.

`brain config get agent.codex_path --json`으로 확인하고 `brain config set agent.codex_path <절대경로> --json`으로 바꿀 수 있습니다. 실행 가능한 파일이어야 하며 `--version`이 성공해야 합니다. `brain doctor run`은 미설정·실행 불가·버전 확인 실패를 경고합니다. 데몬은 이 설정을 읽어 비밀이 아닌 `BRAIN_CODEX_PATH`로 확장에 전달하므로 launchd PATH를 수동으로 고칠 필요가 없습니다. Garmin 분석에서 경로가 없거나 사용할 수 없으면 `ANALYSIS_AGENT_NOT_FOUND`와 설정 방법을 반환합니다. 설정 변경은 다음 일감 실행부터 적용됩니다.

### 결과 이벤트와 발송 구독

확장은 `brain.extension_event_emit(work,attempt,event,key,subject_date,revision,summary,document,albums)`만 호출하여 결과를 기록합니다. 이벤트 이름은 확장 이름 접두사를 가지며 같은 `(event,key)`는 기존 이벤트 ID를 반환합니다. 문서·앨범은 기존 core 파일 소유 검증을 따릅니다. 확장은 메신저·채널·발송 시각을 알지 않습니다.

```sh
brain channels subscribe set garmin.report.completed --messenger personal --channel reports --at 08:20 --tz Asia/Seoul
brain channels subscribe set garmin.period_report.completed --messenger personal --channel reports --at immediate
brain channels subscribe list --json
brain channels subscribe remove garmin.period_report.completed
brain channels send-pending --event garmin.report.completed --date 2026-11-10
```

분석 시각은 `schedules` 예약(예: 08:10), 발송 시각은 core 구독(예: 08:20)으로 분리합니다. `--at` 생략 또는 `immediate`는 즉시이며 HH:MM은 매일 현지 시각입니다. `--tz` 생략은 사용자 timezone(기본 Asia/Seoul)을 따릅니다. 이벤트가 당일 시각 전에 기록되면 그 시각에 예약하고 이후면 즉시 접수하여 분석 지연 때문에 다음 날로 넘기지 않습니다. 자동 발송은 subject_date가 기록 당시 구독 시간대의 오늘인 경우만 합니다. 수동 ext run으로 요청한 재생성·report-send·기간 분석은 날짜와 무관하게 구독 정책을 적용합니다.

구독이 없거나 날짜 필터에서 제외된 이벤트는 오류 없이 보관하며 구독을 추가해도 과거 이벤트를 자동 발신하지 않습니다. `send-pending --event`의 날짜는 대상 날짜, `--id`는 이벤트 ID이고 두 필터는 택일입니다. 현재 구독의 목적지에 즉시 접수하며 같은 이벤트+구독의 기존 요청은 중복 생성하지 않습니다. 구독 시각·목적지 변경은 이후 이벤트부터 적용되고 기존 예약은 그대로입니다. 기존 `garmin.report`·`garmin.period_report` 경로는 migration에서 각각 `.completed`의 immediate 구독으로 이동합니다. 다른 topic 경로와 기존 send/send-pending/retry는 유지합니다. `doctor run`은 구독 수와 보관 이벤트 수도 표시합니다.
