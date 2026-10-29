---
title: '이 Mac에서 확인: 플러그인 배포로 PG 설치본이 동작한다'
type: 'chore'
ticket: '13'
created: '2026-10-29'
status: done
baseline_revision: '7c7a086ec858368b9bdc7d565acf09aeefed5891'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
operator_actions:
  - "`git push origin main`으로 배포 커밋 `dd49f71`(plugin `app-ref` = `7c7a086`, `version` 0.1.9)과 그 앞의 로컬 커밋들을 원격에 올려, 원격 marketplace가 0.1.9를 내주게 한다."
---

<intent-contract>

## Intent

**Problem:** epic 11의 PG 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작하는지(Done when 6) 아직 아무도 실제 설치본에서 보지 않았다. 게다가 2026-10-29 착수 때 이 Mac에는 Brain 설치본(`~/.second_brain`), second-brain 플러그인, 데몬 LaunchAgent, 옛 `brain.db`가 모두 없다(10-27 epic-daemon 확인 때와 다름). 그래서 이번 확인은 빈 Mac에 새로 설치하는 경로다.

**Approach:** 배포 커밋(`plugin/app-ref` = 기준 리비전, `version` 0.1.8 → 0.1.9)을 만들고, 원격 push 대신 `~/.second_brain/app` 클론에 로컬 저장소의 객체를 미리 넣은 뒤, 로컬 marketplace로 플러그인을 설치하고 플러그인의 SessionStart 명령을 그대로 실행해 bootstrap이 설치하게 한다. 그 설치본에서 확인 목록을 한 번 돌리고 증거를 이 plan에 남긴다. 원격 push는 사람 몫으로 남긴다.

## Boundaries & Constraints

**Always:**
- 배포는 bootstrap 경로(`plugin/bin/session-start.sh` → `bootstrap.mjs` hook mode → 설치기)로 한다. `~/.second_brain/app`의 `origin`은 GitHub 원래 주소(`https://github.com/gmae199boy/second-brain.git`) 그대로 두고, 로컬 commit은 `git fetch "<repo>" main`으로 객체만 넣는다.
- 배포 커밋은 `plugin/app-ref`(40자 소문자 hex, 기준 리비전 `7c7a086ec858368b9bdc7d565acf09aeefed5891`)와 `plugin/.claude-plugin/plugin.json`의 `version`(`0.1.9`) 두 줄만 바꾼다. 커밋 메시지 끝에 attribution 줄을 둔다. push하지 않는다.
- 플러그인은 `claude plugin marketplace add "<repo>"`(user scope)와 `claude plugin install second-brain@second-brain`으로 설치한다. 원격 marketplace는 아직 0.1.8(옛 SQLite 빌드)을 가리키므로 쓰지 않는다.
- DB를 끄는 단계 뒤에는 반드시 DB와 데몬이 다시 떠 있고 spool이 빈 상태로 돌려 둔다. 실패해도 마지막에 복구한다(`docker compose -f ~/.second_brain/postgres/compose.yaml up -d --wait`, `brain queue drain`).
- 증거로는 명령, 종료값, 걸린 시간, 건수, ID·시각, doctor 출력, `docker compose ps` 요약만 남긴다. transcript 본문, 메시지 내용, `.env` 값, 비밀번호, 접속 URL은 어디에도 쓰지 않는다. 문서·커밋·보고에 절대 홈 경로(`/Users/<이름>/…`)를 쓰지 않고 `~/…`, `<repo>/…`로 쓴다.

**Never:**
- 원격 push, GitHub 원격 marketplace 등록, `--no-verify`.
- 제품 소스·시험 수정. 확인이 제품 결함으로 실패하면 고치지 않고, 상태를 복구한 뒤 실패 항목과 증거를 보고한다.
- 운영 볼륨 `second-brain-pg` 삭제, `docker compose down -v`, 시험 컨테이너 `second-brain-test-postgres-1` 건드리기.
- 옛 `brain.db` 안내를 보이려고 실제 홈(`~/.second_brain`)에 가짜 `brain.db`를 만드는 것. 그 줄은 임시 홈에서만 보인다.
- 임시 홈 실행이 `~/.claude/settings*.json`이나 실제 홈의 LaunchAgent·compose 자원을 바꾸는 것.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 설치 | Brain 없음, OrbStack 켜짐, 미리 넣은 클론 | bootstrap 종료 0, `installed.json` commit = 기준 리비전, compose project `second-brain`·볼륨 `second-brain-pg`·포트 54320, 데몬 등록, transcript 가져오기 | 실패면 `bootstrap.log` 끝부분을 증거로 보고 |
| 다음 세션 | 설치된 플러그인으로 `claude -p` 한 번 | 그 세션 ID의 세션·메시지가 PG에 들어감 | 들어오지 않으면 실패로 기록 |
| 컨테이너 재생성 | `compose down`(볼륨 유지) → `up -d --wait` | 세션·메시지 수, 표본 세션의 ID·시각, `config get timezone`이 같음 | 다르면 실패 |
| DB 꺼짐 | `compose stop` 직후 hook payload로 `sessions ingest` | 시간 한도 안에 exit 0, spool 파일 생김 | 막히거나 exit≠0이면 실패 |
| 데몬 재연결 | DB 꺼진 채 대기 | 데몬이 `compose up`을 불러 DB가 돌아오고 spool이 비며 세션이 PG에 있음 | 10분 안에 안 되면 손으로 복구하고 실패로 기록 |
| 옛 `brain.db` | 빈 `brain.db`가 있는 임시 홈의 `setup run` | "옛 SQLite 파일 …는 지우지 않았고 더 쓰지 않습니다" 한 줄, 접미사 자원 | 끝나면 그 홈의 컨테이너·볼륨·LaunchAgent·폴더를 지움 |

</intent-contract>

## Code Map

- `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 배포 커밋이 바꾸는 두 파일(README "릴리스", AGENTS.md 정책).
- `.claude-plugin/marketplace.json` -- 로컬 marketplace 이름 `second-brain`, `source: ./plugin`. 로컬 marketplace는 복사하지 않고 그 자리에서 읽는다(README "릴리스").
- `plugin/hooks/hooks.json` -- SessionStart: `sh "${CLAUDE_PLUGIN_ROOT}/bin/session-start.sh"`, Stop·SessionEnd: `brain.sh sessions ingest claude-code`(모두 async).
- `plugin/bin/session-start.sh` -- node를 찾고 `bootstrap.mjs --yes --ref <app-ref> --plugin-root <root>`, 끝에 `queue drain`.
- `plugin/bootstrap.mjs:223-303` -- hook mode. 진행 줄은 `~/.second_brain/log/bootstrap.log`. `:408-447` `prepareAppAt`: 클론이 없으면 GitHub에서 clone 후 ref checkout(로컬 commit은 원격에 없어 실패), 있으면 `fetch origin` → ref 존재 확인 → `HEAD`가 ref의 조상이면 detach. 그래서 클론을 미리 만들고 로컬 객체를 넣는다(`origin/main` `608a5d5…`는 로컬 `main`의 조상, 로컬이 50 commit 앞).
- `apps/cli/src/install/flow.ts:406-470` -- 설치 단계 문구: 옛 SQLite 줄(`:411`, `<home>/brain.db`가 있을 때만), `PostgreSQL <project>: 스키마 …`(`:413`), 시간대(`:434`), transcript 가져오기(`:460-469`), 데몬 등록(`:522`).
- `apps/cli/src/config/resources.ts:6-13` -- 기본 홈은 project `second-brain`, 볼륨 `second-brain-pg`, 포트 54320, 기본 Label. 다른 홈은 해시 접미사.
- `apps/cli/src/config/paths.ts:65,130` -- spool 폴더 `<home>/spool`.
- `apps/cli/src/commands/` -- 쓸 명령: `setup-run`, `setup-uninstall`, `doctor-run`, `daemon-status`, `queue-drain`, `sessions-ingest`, `config-get`. 세션 목록 명령은 없으므로 건수·ID·시각은 컨테이너 안 `psql`로 읽는다(`docker compose -f ~/.second_brain/postgres/compose.yaml exec`, 출력에 비밀 없음).
- 이 Mac 상태(착수 때): OrbStack `Running`, 포트 54320 비어 있음, `second-brain-test-postgres-1`만 떠 있음.

## Tasks & Acceptance

**Execution:**
- [x] `plugin/app-ref`, `plugin/.claude-plugin/plugin.json` -- 배포 커밋(`chore(plugin): deploy 7c7a086 as 0.1.9` 류) -- 설치할 commit과 캐시 키를 함께 올린다.
- [x] (이 Mac) `~/.second_brain/app` -- GitHub에서 `git clone --no-checkout` 뒤 `git -C ~/.second_brain/app fetch "<repo>" main` -- push 없이 bootstrap이 ref를 찾게 한다.
- [x] (이 Mac) Claude Code 플러그인 -- 로컬 marketplace 추가·설치, `installPath` 기록 -- 다음 세션 hook의 출처.
- [x] (이 Mac) 첫 설치 -- 설치된 플러그인 루트로 `CLAUDE_PLUGIN_ROOT=<root> sh <root>/bin/session-start.sh` 실행, 종료값·걸린 시간·`bootstrap.log`의 설치 단계 줄·`installed.json` commit 기록 -- SessionStart가 하는 일 그대로.
- [x] (이 Mac) 상태 증거 -- `brain doctor run`, `docker compose ps` 요약, `brain daemon status`, `launchctl print gui/$(id -u)/<Label>`의 state, 디스크 transcript 파일 수와 PG 세션·메시지 수.
- [x] (이 Mac) 다음 세션 -- 임시 폴더에서 `claude -p`를 한 번(짧은 프롬프트, `--output-format json`으로 session_id) 돌리고 몇 분 안에 그 세션이 PG에 있는지, 무엇이 넣었는지(hook 로그·데몬 로그로 알 수 있는 만큼) 기록.
- [x] (이 Mac) 컨테이너 재생성 -- 앞뒤 건수·표본 세션 ID·시각·`brain config get timezone` 비교.
- [x] (이 Mac) DB 꺼짐·재연결 -- `compose stop` 직후 그 세션 transcript를 가리키는 hook payload로 `~/.second_brain/bin/brain sessions ingest claude-code`, 종료값·시간·spool 파일 수; 데몬이 DB를 되살리고 drain할 때까지 기다려 시각·데몬 로그 줄·spool 수·doctor 기록.
- [x] (이 Mac) 옛 `brain.db` 줄 -- `mktemp -d` 임시 홈에 빈 `brain.db`를 두고 그 홈으로 `setup run --yes`, 그 한 줄과 접미사 project 기록; 그 뒤 그 홈의 `setup uninstall`, 접미사 볼륨 삭제, 임시 폴더 삭제, `~/.claude/settings*.json` 전후 동일 확인.
- [x] 이 plan -- `## Implementation Notes`에 확인 표(확인 | 결과 | 근거)와 마지막 상태(DB·데몬 떠 있음, spool 0)를 쓴다.

**Acceptance Criteria:**
- Given 배포 커밋과 미리 넣은 클론, when 플러그인의 SessionStart 명령을 돌리면, then 종료 0이고 `installed.json`의 commit이 기준 리비전이며 `docker compose ps`에 `second-brain` project의 postgres가 healthy이고 데몬 Label이 running이다.
- Given 설치 직후, when `brain doctor run`을 돌리면, then OrbStack·컨테이너·DB 접속·쓰기·pg_trgm·schema 항목이 보이고 fail이 없다.
- Given 디스크의 transcript, when 설치가 가져오기를 마치면, then PG 세션 수가 0보다 크고 설치 줄에 가져오기 결과가 있다.
- Given 확인 목록을 모두 돈 뒤, when 마지막 상태를 보면, then 컨테이너 healthy, 데몬 running, `~/.second_brain/spool`에 파일 0개, 임시 홈의 자원 없음이다.

## Implementation Notes

확인은 2026-10-29 04:08–04:11 KST에 수행했다. `context: []`로, 추가로 읽어야 할 문맥 파일은 없었다. 제품 소스·시험은 바꾸지 않았다.

| 확인 | 결과 | 근거 |
|------|------|------|
| 배포 커밋 | 통과 | `dd49f71e1b950af7eecc8dde6af4a8373cd5ca09`, `chore(plugin): deploy 7c7a086 as 0.1.9`. `git show --stat HEAD` 종료 0, 두 파일의 두 줄만 변경. 마지막 줄 `Co-Authored-By: Codex <noreply@openai.com>`. push하지 않음. |
| 사전 클론 | 통과 | `git clone --no-checkout https://github.com/gmae199boy/second-brain.git ~/.second_brain/app` 종료 0, 1.19초. `git -C ~/.second_brain/app fetch "<repo>" main` 종료 0, 0.15초. 초기 작업 트리 준비는 아래 보완 기록 참조. 최종 origin은 원래 GitHub 주소 유지. |
| 로컬 marketplace·플러그인 | 통과 | `claude plugin marketplace add "<repo>"` 종료 0, 0.60초. `claude plugin install second-brain@second-brain` 종료 0, 0.76초, user scope. `installPath`는 `~/.claude/plugins/cache/second-brain/second-brain/0.1.9`. |
| SessionStart 설치 | 통과 | 설치된 루트로 `CLAUDE_PLUGIN_ROOT=<root> sh <root>/bin/session-start.sh` 실행. 준비 보완 후 종료 0, 15.11초. `installed.json`의 commit은 `7c7a086ec858368b9bdc7d565acf09aeefed5891`, 설치 완료 시각 `2026-10-28T19:09:06.525Z`. |
| 설치 단계 | 통과 | `bootstrap.log`: `PostgreSQL second-brain: 스키마 1, 적용 1건`, `시간대: Asia/Seoul (DB)`, `디스크의 transcript를 가져왔습니다. 남은 일감은 이후 drain이 이어서 처리합니다`, `데몬을 launchd에 등록했습니다`. 등록 전 점검의 데몬 경고는 등록 후 해소됨. |
| 초기 상태·가져오기 | 통과 | `brain doctor run` 종료 0, 0.26초, 통과 19·경고 0·실패 0. 디스크 Claude JSONL 710개, Codex JSONL 349개. PG 세션 219건·메시지 4,302건. 파일 수와 세션 수는 일대일 대응을 요구하지 않음. |
| 운영 자원 | 통과 | `compose ps` 종료 0: `second-brain-postgres-1`, `postgres:18`, `healthy`, `127.0.0.1:54320->5432/tcp`. 운영 볼륨 `second-brain-pg` 유지. `brain daemon status` 종료 0, pid 6631·빌드 `7c7a086`. `launchctl print gui/$(id -u)/io.github.gmae199boy.second-brain.daemon` 종료 0, `state = running`. |
| 다음 세션 | 통과 | 임시 작업 폴더에서 `claude -p`와 `--output-format json` 실행, 종료 0, 4.34초. 세션 `10d433dc-7867-43be-92aa-dd53f85e00aa`, 시작 `2026-10-28 19:09:24.966+00`, 수집 `2026-10-28 19:09:28.271+00`, 메시지 2건. PG의 `ingest_source=import`. |
| 다음 세션의 수집 경로 | 확인 범위 기록 | `run/last-hook-claude-code`에 `<repo>/plugin` 도착 기록이 있고, 데몬 로그 `2026-10-28T19:09:26.909Z`에 새 일감 1·완료 1건이 있음. hook과 데몬 모두 동작했으므로 최종 저장을 어느 쪽이 수행했는지는 단정하지 않음. |
| 컨테이너 재생성 | 통과 | `compose down` 종료 0, 0.46초, `compose up -d --wait` 종료 0, 1.72초. 전후 세션 220건·메시지 4,304건 동일. 표본 `bb25fd95-3f05-4fba-afd1-6d700c9953c6`와 시작 `2026-09-06 00:50:59.549+00` 동일. `brain config get timezone` 전후 종료 0, `timezone = Asia/Seoul (db)` 동일. |
| DB 중단 중 수집 | 통과 | `compose stop` 종료 0, 0.216초. 중단 시각 `2026-10-28T19:09:59.368584Z`. 다음 세션의 실제 transcript를 가리키는 payload로 `brain sessions ingest claude-code --json` 실행, 20초 한도에서 0.119초·종료 0. `spooled=true`, 경고 `SPOOLED`, `DB_UNAVAILABLE`, 직후 spool 파일 1개. |
| 데몬 자동 재연결 | 통과 | `2026-10-28T19:10:00.336Z` 로그 `데이터베이스에 닿지 않아 컨테이너를 다시 띄웁니다 — 간격을 두고 재시도합니다`. `2026-10-28T19:10:10.659Z` 로그 `데이터베이스에 다시 닿았습니다`. 이어 되넣음 1건·spool 0건. 12.70초 뒤 healthy·spool 0 확인. 같은 세션의 수집 시각 `2026-10-28 19:10:10.597+00`. 수동 복구 명령 전에 자동 복구를 확인함. |
| 중단 뒤 복구 보장 | 통과 | 두 중단 시험 모두 마지막에 `compose up -d --wait`와 `brain queue drain` 실행, 모두 종료 0. 재연결 뒤 doctor 통과 19·경고 0·실패 0. |
| 옛 SQLite 안내 | 통과 | 빈 `brain.db`가 있는 임시 홈을 `SECOND_BRAIN_HOME`으로, 그 아래 폴더를 `SECOND_BRAIN_LAUNCH_AGENTS`로 지정. `brain setup run --yes` 종료 0, 12.92초. `옛 SQLite 파일 <임시 홈>/brain.db는 지우지 않았고 더 쓰지 않습니다`. 빈 파일 유지 확인. 실제 접미사 project `second-brain-da87a245a6c0`, 스키마 1·적용 1건. 하네스 연결 옵션 없이 비대화식 실행. |
| 임시 자원 정리 | 통과 | 같은 환경의 `brain setup uninstall` 종료 0, 0.66초. 실제 볼륨 `second-brain-pg-da87a245a6c0` 삭제 종료 0. 실제 임시 Label 조회 종료 113으로 부재 확인. 임시 컨테이너·볼륨·실제 홈 plist 부재, 임시 폴더 삭제 확인. `~/.claude/settings*.json`은 임시 실행 전후 파일 목록·내용 해시 동일. |
| 마지막 상태 | 통과 | `brain doctor run` 종료 0, 통과 19·경고 0·실패 0. 컨테이너 healthy, 데몬 pid 6631 살아 있음, heartbeat `2026-10-29T04:10:36.616+09:00`, spool 파일 0개. 시험 컨테이너 `second-brain-test-postgres-1`은 계속 healthy이며 조작하지 않음. |

상태·건수 조회 명령은 다음과 같다. `.env`는 Compose에 파일로 전달했으며 값은 출력하거나 문서에 기록하지 않았다.

```sh
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml ps
docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml exec -T postgres psql -U postgres -d brain -At -c 'select (select count(*) from brain.sessions),(select count(*) from brain.messages); select harness_session_id,started_at from brain.sessions order by started_at limit 1;'
~/.second_brain/bin/brain doctor run
~/.second_brain/bin/brain daemon status
~/.second_brain/bin/brain config get timezone
```

남은 일은 사람의 원격 push다. 로컬 배포·설치·확인은 완료했으나 원격 marketplace가 0.1.9를 배포하는지는 이번 범위에서 검증하지 않았다. 제품 결함으로 남긴 실패는 없다. 이 계획의 증거 변경은 배포 커밋에 섞지 않고 작업 트리에 남겼다.


### 준비 단계 보완(구현 세션 기록)

- 2026-10-29: 첫 SessionStart가 종료 1·0.07초로 저장소 준비에서 중단됐다. `--no-checkout` 사전 클론은 추적 파일이 모두 삭제된 작업 트리로 보여 보호 검사에 걸렸다. 제품을 수정하지 않고 사전 클론에 `git -C ~/.second_brain/app checkout --detach HEAD`로 기존 원격 HEAD의 작업 트리를 초기화했다. 그 뒤 bootstrap이 기준 리비전을 직접 checkout했다.
- 2026-10-29: 두 번째 SessionStart가 종료 1·0.64초로 pnpm 확인에서 중단됐다. 로그의 `pnpm이 설치되어 있지 않습니다.` 안내에 따라 `npm install -g pnpm@latest`를 실행했다(종료 0, 설치 후 `pnpm --version`은 `12.16.1`). 세 번째 실행에서 설치가 완료됐다.
- 2026-10-29: 계획의 `docker compose -f …`만으로는 필수 환경 변수 보간에 실패했다(종료 1). 제품과 같은 `-p second-brain --env-file ~/.second_brain/.env`를 추가해 조회·중단·복구했다. 비밀 값은 읽어 출력하지 않았다.
- 2026-10-29: 임시 홈 정리에서 경로의 실제 경로 변환으로 접미사를 잘못 예측해 존재하지 않는 볼륨 삭제가 종료 1이었다. 설치 출력의 실제 접미사 `da87a245a6c0`로 다시 삭제해 종료 0을 확인하고, 실제 접미사의 모든 자원 부재를 재확인했다.

## Plan Change Log

## Review Triage Log

### 2026-10-29 — Review pass
- verdicts: 1 findings — high 0, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `## Verification`의 `docker compose -f ~/.second_brain/postgres/compose.yaml ps`에 `--env-file`이 없어 `.env` 변수 없이 부르면 보간 오류가 난다(리뷰어 세션 `01a183ee-1f91-7921-9926-953776a23569`) — 사실이다(`apps/cli/src/install/postgres.ts:19`가 `BRAIN_POSTGRES_PASSWORD`를 필수로 요구하고, 구현 기록에도 같은 실패가 있다). 다만 고칠 곳이 이 plan 자체라 규칙대로 reject했다. 제품 코드와 배포 커밋에는 영향이 없다. 기록 정확성을 위해 Verification 줄만 Implementation Notes의 동작한 명령(`-p second-brain --env-file …`)으로 맞췄고, 오케스트레이터가 그 명령으로 healthy를 다시 확인했다.

## Design Notes

- 클론을 미리 만드는 이유: bootstrap의 새 클론 경로는 GitHub에서 clone한 뒤 ref를 checkout하는데, 배포할 commit은 아직 원격에 없다. 클론을 원래 `origin`으로 만들고 로컬 객체만 넣으면 bootstrap은 "이미 있는 클론" 경로를 그대로 타고(`fetch origin` → ref 확인 → detach → build → 설치기), push 뒤의 상태와 같아진다. 사람이 push하면 따로 고칠 것이 없다.
- 로컬 marketplace를 쓰는 이유: 원격 marketplace는 0.1.8(`65b3292`, SQLite 빌드)을 내준다. 로컬 marketplace는 저장소의 `plugin/`을 그 자리에서 읽으므로 0.1.9의 app-ref를 본다.
- 옛 `brain.db` 줄을 임시 홈에서 보이는 이유: 이 Mac에는 옛 파일이 없어 실제 설치에서는 그 줄이 나오지 않는 것이 맞다. 실제 홈에 가짜 파일을 만들지 않고, 접미사 자원을 쓰는 임시 홈에서 그 경로를 확인한 뒤 치운다.
- SessionStart를 손으로 부르는 이유: 지금 세션은 플러그인 설치 전에 시작해 hook이 없다. 같은 명령을 같은 `CLAUDE_PLUGIN_ROOT`로 부르면 hook이 하는 일과 같다. 이후 `claude -p` 세션은 설치된 플러그인의 hook을 실제로 탄다.

## Verification

**Commands:**
- `git show --stat HEAD` -- expected: 배포 커밋이 `plugin/app-ref`·`plugin/.claude-plugin/plugin.json`만 바꿈
- `cat ~/.second_brain/installed.json` -- expected: commit `7c7a086ec858368b9bdc7d565acf09aeefed5891`
- `~/.second_brain/bin/brain doctor run` -- expected: fail 없음
- `docker compose -p second-brain --env-file ~/.second_brain/.env -f ~/.second_brain/postgres/compose.yaml ps` -- expected: postgres healthy
- `~/.second_brain/bin/brain daemon status` -- expected: 살아 있음
- `ls ~/.second_brain/spool | wc -l` -- expected: 0
- `docker ps -a --format '{{.Names}}'`, `docker volume ls`, `ls ~/Library/LaunchAgents` -- expected: 임시 홈 접미사 자원 없음

## Auto Run Result

Status: awaiting-operator

- 요약: epic 11의 PG 기능 묶음을 플러그인 배포 커밋 `dd49f71e1b950af7eecc8dde6af4a8373cd5ca09`(`plugin/app-ref` → `7c7a086ec858368b9bdc7d565acf09aeefed5891`, `version` 0.1.8 → 0.1.9)로 이 Mac에 넣고 확인 목록을 한 번 돌렸다. 착수 때 이 Mac에는 Brain 설치본·플러그인·데몬·옛 `brain.db`가 없어 새 설치 경로로 확인했다. push 대신 `~/.second_brain/app` 클론(origin은 GitHub 그대로)에 로컬 객체를 넣고, 로컬 marketplace로 플러그인을 설치한 뒤 플러그인의 SessionStart 명령으로 bootstrap이 설치하게 했다.
- 확인 결과: 설치(종료 0, `installed.json` commit = 기준 리비전, `second-brain-postgres-1` healthy `127.0.0.1:54320`, 데몬 running), transcript 가져오기(세션 219건·메시지 4,302건), 다음 세션(`claude -p` 세션이 수 초 안에 PG에 들어옴, hook 도착 기록 있음, 최종 저장 주체는 hook·데몬 중 단정 안 함), 컨테이너 재생성 뒤 건수·표본 ID·시각·`timezone` 동일, DB 중단 중 hook 경로 `sessions ingest`가 0.119초·종료 0으로 spool에 남김, 데몬이 약 10초 뒤 `compose up`으로 재연결해 drain(spool 0), doctor 통과 19·경고 0·실패 0, 옛 `brain.db` 안내 줄은 빈 `brain.db`가 있는 임시 홈에서 확인 후 그 자원을 모두 지움. 모두 통과.
- 변경 파일: `plugin/app-ref` — 설치할 commit; `plugin/.claude-plugin/plugin.json` — `version` 0.1.9; 이 plan — 확인 증거. 제품 소스·시험 변경 없음.
- 이 Mac에 생긴 변경: `~/.second_brain`(설치본, PG 볼륨 `second-brain-pg`), 데몬 LaunchAgent `io.github.gmae199boy.second-brain.daemon`, Claude Code 로컬 marketplace `second-brain`와 플러그인 `second-brain@second-brain`(user scope), 전역 `pnpm` 12.16.1(설치기 안내대로 `npm install -g pnpm@latest`).
- 리뷰: Quick 1건(low) — reject 1(고칠 곳이 이 plan; Verification 줄만 정정). patch 0, defer 0. 후속 리뷰 권고 `false`(patch 없음).
- 검증(오케스트레이터 재확인): `installed.json` commit `7c7a086…`, `brain doctor run` 통과 19·실패 0, `docker compose -p second-brain --env-file … ps` healthy, `brain daemon status` 살아 있음(pid 6631), spool 0개, PG 세션 220·메시지 4,305, 임시 홈 접미사 컨테이너·볼륨·LaunchAgent 없음, 배포 커밋이 두 파일만 바꿈.
- 남은 위험: 원격 push 전에는 원격 marketplace가 0.1.8(SQLite 빌드)을 내준다. 이 Mac의 플러그인은 로컬 marketplace(이 저장소)를 출처로 쓴다. 배포 커밋의 attribution 줄은 구현 세션이 쓴 `Co-Authored-By: Codex`다.
- 사람 몫(`operator_actions`): 원격 push. 티켓 완료 표시는 오케스트레이터가 한다. push하지 않았다.

## Operator Confirmation

Confirmed 2026-10-29: the external actions this story owed were carried out.

- `git push origin main`으로 배포 커밋 `dd49f71`(plugin `app-ref` = `7c7a086`, `version` 0.1.9)과 그 앞의 로컬 커밋들을 원격에 올려, 원격 marketplace가 0.1.9를 내주게 한다.

_Appended by the bmad-loop orchestrator (`bmad-loop confirm`, #335): a human confirmed these external actions out of band, and the story was advanced from `awaiting-operator` to `done`._
