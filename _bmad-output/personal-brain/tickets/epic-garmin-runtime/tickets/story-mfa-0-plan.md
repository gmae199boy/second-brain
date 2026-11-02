---
title: '16.2 인증과 호출 보호 — 옛 Garmin 동작 이식과 터미널 로그인'
type: 'feature'
ticket: 2
created: '2026-11-02'
status: 'built'
baseline_revision: '1a7ca1addc63b9aed7048df3a369465b5f8c2e5a'
route: 'full'
route_source: 'pinned'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: ['{project-root}/_bmad-output/personal-brain/tickets/epic-garmin-runtime/epic-garmin-runtime.md']
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**문제:** Garmin collect의 운영 client는 아직 `UnavailableClient`로 닫혀 있다. 로그인, tokenstore, 호출 간격, 차단 동작도 없다. 2026-11-02 사용자 결정으로 16.2는 옛 Garmin(`7fb33dd`) 동작을 그대로 옮기는 것으로 줄었다.

**접근:** 옛 `GarminAdapter`를 Garmin 확장 안의 Python 모듈로 옮긴다. 옮길 것은 세션(tokenstore login, `.session.lock`, 당일 `block.json`), 호출 pacing, 연속 403, first-call 보호다. 옛 터미널 비밀번호 로그인은 `brain ext login garmin`으로 흡수하고, 밖에서도 쓸 수 있게 이 명령을 열어 주는 로그인 스킬을 둔다. 감독자 일감은 입력 없이 tokenstore만으로 로그인한다. MFA는 지원하지 않는다.

**사용자 결정(2026-11-02):**
- 같은 계정 직렬화는 옛 `.session.lock` 잠금을 그대로 쓴다. core의 `serializationKey` 연결은 하지 않는다.
- 비밀번호는 터미널에 직접 입력받고 어디에도 저장하지 않는다. 채팅·MCP로는 받지 않는다.
- 계획은 크기를 넘어도 하나로 두고 단계로 구현한다.
- 실제 원격 로그인 확인은 16.9에서 한다.

## Boundaries & Constraints

**항상:**
- 옛 원본의 의미를 그대로 둔다(경로:줄은 Code Map).
- stdout은 ABI JSONL뿐이다. 단, 터미널 로그인 명령의 화면 입출력은 예외다.
- 오류는 manifest `error_codes`에 선언한 코드와 고정 문구만 낸다. 라이브러리 예외 문자열·응답·이메일·비밀번호·토큰·경로는 출력하지 않는다.
- 비밀번호는 `getpass`로 받고 파일·설정·DB·argv·환경변수에 남기지 않는다.
- 외부 호출 중에는 DB 트랜잭션을 잡지 않는다(기존 collect 경계 유지).
- 시험은 fake client·가짜 입력·fake clock·fake sleep만 쓰고, 네트워크 호출은 0이다.

**금지:**
- `wip/16.2`에서 `extensions/garmin/pyproject.toml`·`uv.lock` 외의 코드를 가져오지 않는다.
- 다음은 만들지 않는다: MFA 입력·`resume_login`·3회 재시도, DB 계정 보호 상태, 해제 전 호출 0, 다음 날 탐색 호출, `release-block`, doctor 표시, 같은 UID 방어, 새 DB role, native 코드, `.env` 비밀번호 설정.
- core·postgres 코드는 바꾸지 않는다. CLI 변경은 로그인 명령에 필요한 범위로 제한한다.
- `plugin/app-ref`와 plugin version은 올리지 않는다(릴리스는 16.9).
- 다음은 16.3 몫이라 하지 않는다: 같은 날 mtime 재시도 규칙과 재시도 진입표, 수동 collect의 대상·날짜 연결.
- 실계정 호출은 하지 않는다.

## I/O & Edge-Case Matrix

| 상황 | 입력·상태 | 기대 관찰 | 오류 처리 |
|---|---|---|---|
| 정상 수집 | 유효 tokenstore, fake 정상 응답 | `login(tokenstore)` 한 번, 호출 전 1~2초 대기, raw 저장 | 없음 |
| 403 세 번 | 데이터 403 연속 3회 | 세 번째에 `BLOCKED_403`, `block.json`(오늘, `blocked_403`), 이후 호출 0 | retryable=false |
| 403 사이 정상 | 403, 정상, 403, 403 | 카운터가 초기화되어 차단 없음 | 항목 실패만 |
| 429 | 데이터 또는 로그인 429 | `RATE_LIMITED`, `block.json`(`rate_limited`), 남은 호출 0 | retryable=false |
| 당일 차단 | 오늘 날짜 `block.json` | 로그인·호출 0, `SESSION_BLOCKED` | retryable=false |
| 다음 날 | 어제 날짜 `block.json`(fake clock) | 정상 호출 | 없음 |
| block 쓰기 실패 | 쓰기 OSError | 그 실행의 남은 호출 0 | 같은 차단 코드 |
| 깨진 block | 잘못된 JSON·필드 | 네트워크 전에 `BLOCK_FILE_INVALID` | retryable=false |
| first-call | 보호 endpoint에 저장된 raw 없음 | 실행당 endpoint 3건까지만 호출, 나머지는 건너뜀 | 실패로 세지 않음 |
| 무인 로그인 실패 | 감독자 auth·collect, 토큰 무효 | `LOGIN_REQUIRED`, 입력 요구 없음 | retryable=false |
| 터미널 로그인 | `brain ext login garmin`, 가짜 입력 | 로그인 후 dump, tokenstore 0700·파일 0600, 비밀번호 흔적 없음 | 없음 |
| MFA 요구 | fake가 `needs_mfa` | `LOGIN_REQUIRED`, resume·dump·추가 호출 0 | retryable=false |
| 동시 사용 | 같은 tokenstore의 lock을 다른 세션이 보유 | 기다리다 `SESSION_LOCK_TIMEOUT`, 겹친 호출 0 | retryable=true |

</frozen-after-approval>

## Code Map

옛 원본은 `_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz`이다(`P/` = `garmin-source/src/garmin_pipeline/`). 저장소 밖 임시 폴더에 풀어 읽는다.

- `P/garmin/__init__.py`:
  - `:443` `open_session`, `:475` `_login`
  - `:744`·`:770` `.session.lock`
  - `:291`·`:301` pacing·`_blocked`, `:317` 403 카운터
  - `:343`·`:363`·`:371` 차단 기록(OSError는 삼킴)
  - `:622`·`:638` 응답 분류
  - `:668`·`:676` block 판정, `:721` `_write_block`
  - `:403`·`:408` `_new_client`(fake seam)
  - `:214`·`:226` user_summary connectapi 경로
  - `:480`·`:494`·`:500` 비밀번호 로그인. MFA 분기(`:500`)에서 멈춘다. `:542` dump
- `P/auth.py`: `:55`·`:68`·`:85`·`:101` 터미널 입력(TTY 확인, 이메일 input, `getpass`), `:314` `_prepare_tokenstore`(0700).
- `P/collect.py`: `:112`·`:546`·`:612` first-call(exercise_sets, daily_weigh_ins, lifestyle_logging_data, 실행당 3건), `:568` 날짜 사이 5초.
- `P/config.py`: `:48`–`:55` 기본값. `P/errors.py`: 오류 클래스와 비노출 처리.
- `extensions/garmin/src/collect_client.py`: `:5` `CollectClient`, `:9` `UnavailableClient`. 실제 adapter가 이 protocol을 구현한다.
- `extensions/garmin/src/collect.py`:
  - `:70` `run(client=None, …)` — fake 주입 경계는 그대로 둔다.
  - `:73` — 기본 client를 교체할 지점.
  - `:77`·`:83` — attempt 확인과 coverage 뒤에만 세션을 연다.
  - `:106` — 오류 투영.
- `extensions/garmin/src/collect_store.py`: `:59` `library_version`에 실제 버전을 넘긴다. 저장 경계는 바꾸지 않는다.
- `extensions/garmin/manifest.json`: `auth` 선언(무인 확인), `garmin.tokenstore` 경로 설정, 새 오류 코드(`LOGIN_REQUIRED` 대문자 포함).
- 읽기만 하는 core·CLI 경로:
  - `packages/core/src/extensions/install.ts:173`·`:195` — 설치 인증 단계와 `LOGIN_REQUIRED` 처리.
  - `snapshot.ts:26`, `apps/cli/src/daemon/supervisor.ts:43`–`:78` — snapshot 생성과 Python 실행 방식.
- 로그인 명령의 본보기: `apps/cli/src/commands/ext-run.ts`, `index.ts`(등록), `guide-schema.ts`(schema 노출).
- `plugin/skills/install/SKILL.md`: 4번 항목의 "별도의 로그인 명령을 지어내지 않는다"를 새 명령에 맞게 고친다. 새 로그인 스킬은 같은 형식으로 `plugin/skills/` 아래에 둔다.
- 시험 전용 wrapper 주입 방식: `extensions/garmin/tests/collect_fixture.py`, `apps/cli/python-test/garmin-collect.test.ts`.
- `wip/16.2`(`962db020d8f2a0d5925bc909c51a3011c5f5ad77`)의 `extensions/garmin/pyproject.toml`·`uv.lock`: main과 기준이 같아 그대로 교체할 수 있다(garminconnect 0.3.20, curl-cffi 0.17.0).

## Tasks & Acceptance

**실행(단계마다 phase-ready 보고):**

- [x] 1단계: `extensions/garmin/pyproject.toml`, `uv.lock` — `wip/16.2`에서 두 파일만 가져오고 frozen 설치와 import를 확인한다.
- [x] 2단계: `extensions/garmin/src/garmin_session.py`(새 파일), `tests/check_session.py` — 세션·`.session.lock`·block·pacing·403·429·first-call·날짜 사이 대기·오류 분류를 옮긴다. fake client·clock·sleep으로 Matrix의 수집·잠금 행을 검사한다.
- [x] 3단계: `extensions/garmin/src/auth.py`(새 파일), `manifest.json` — 무인 모드(tokenstore 확인만)와 터미널 모드(이메일·`getpass`, 비밀번호 로그인, MFA 감지 시 멈춤, dump, 권한 확인)를 둔다. 설정과 오류 코드를 선언한다.
- [x] 4단계: `extensions/garmin/src/collect.py`, `collect_client.py` — 기본 client를 실제 세션 adapter로 바꾸고 새 오류를 투영한다.
- [x] 5단계: `apps/cli/src/commands/ext-login.ts`(새 파일)와 등록 — 설치된 확장의 `auth` entry를 터미널 모드로, 화면 입출력을 붙여 감독자 없이 실행한다. 결과 코드만 돌려준다.
- [x] 6단계: `plugin/skills/`의 새 로그인 스킬과 `install/SKILL.md` 고침 — 스킬은 원격으로 붙을 수 있는 터미널에서 `brain ext login <name>`을 열고 결과만 확인한다. 비밀번호를 묻거나 받지 않는다.
- [x] 7단계: `apps/cli/python-test/garmin-auth.test.ts`(새 파일), `garmin-collect.test.ts` — 실제 감독자로 auth·collect를, 로그인 명령은 가짜 입력으로 실행한다. 비밀 비노출과 기존 회귀를 확인한다.

**수락 기준:**

- Given 시험 비밀번호·토큰 문자열이 있을 때, When 로그인 명령·auth·collect가 성공하거나 실패하면, Then 그 문자열이 stdout·stderr·로그·failures·자식 argv·환경변수·tokenstore 밖 파일 어디에도 없고, 오류는 선언된 코드뿐이다.
- Given 감독자가 auth나 collect를 실행할 때, Then 입력을 요구하지 않고 stdout은 JSONL뿐이다.
- Given `brain guide schema ext --json`을 실행하면, Then `ext login`이 나타난다.
- Given macOS arm64에서 `uv sync --frozen --no-dev --python 3.14.10`을 실행하면, Then `garminconnect`·`curl_cffi`·`psycopg` import가 성공한다.

## Implementation Notes

- 같은 Orca 구현 Dispatch(Codex `gpt-6.1-terra`/medium)가 1~7단계를 phase-ready로 하나씩 했다. 지휘자는 각 단계의 diff와 보고를 확인하고, 2·3단계 검사와 최종 Verification을 직접 다시 돌렸다.
- 터미널 모드는 auth entry의 `--terminal` 인자로 구분한다. `brain ext login`은 stdin·stdout을 상속하고, stderr는 pipe로 받는다. stderr 원문은 다시 쓰지 않고, 마지막 줄이 선언된 코드일 때만 그 코드를 돌려준다. `getpass`는 `/dev/tty`를 쓰며, CLI가 실행 전에 그 접근을 확인한다.
- 실제 manifest에 `auth`가 생겨서 설치는 로그인 전에 `EXTENSION_LOGIN_REQUIRED`에서 멈춘다(의도한 동작). 그래서 시험 전용 설치 복사본은 fake auth entry를 감독자로 실제 실행해 성공시킨 뒤 설치를 재개한다(`apps/cli/test/ext-fixture.ts`). 실제 auth entry로 멈추는 시험도 남겼다.
- 지휘자 승인으로 바꾼 기존 시험이 둘 있다.
  - `tooling/bootstrap/test/install-skill.test.ts`: 13.7 때 없던 `brain ext login`을 막던 가드를, 실제 등록된 명령 확인으로 바꿨다. 비밀 요청 금지 검사는 유지한다.
  - `apps/cli/test/output-codecs.test.ts`: `ext-login.ts` sink 행과 이유를 더했다.
- `garmin-preflight.test.ts`: 재설치 전에 기존 감독자를 종료해 경합을 없앴다.
- NoData(빈 응답)는 raw `null`로 저장한다. `fetched_at_ms NOT NULL` 때문에 fetched 시각도 checked 시각과 같게 들어간다. 옛 fetched 의미는 E16-3(16.3)에서 다룬다.
- `[ASSUMPTION]`: auth snapshot에 `garmin.timezone`이 없으면 시스템 현지 날짜로 당일 차단을 판정한다(`extensions/garmin/src/auth.py`).
- 검증(지휘자 재실행, 리뷰 패치 뒤):
  - frozen import `arm64 3.14.10`
  - `check_session.py`·`check_auth.py` 통과
  - `pnpm build` 성공
  - `pnpm test:python` 9파일 44건 통과
  - `pnpm test` 170파일 3,921건 통과(기존 skip 1)

## Plan Change Log

## Review Triage Log

### 2026-11-02 — Review pass (quick, Codex `gpt-6.1-sol`)

- verdicts: 4 findings — high 0, medium 3, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` `garmin_session.py`·`collect.py`·`auth.py`: 당일 차단 날짜가 시스템 시간대 기준이었다. 옛 원본은 설정 시간대 기준이다. → collect는 이미 읽은 zone을, auth는 snapshot의 `garmin.timezone`을 넘기도록 고쳤다.
  - `[low]` `[defer]` `auth.py:64`: garminconnect 0.3.20의 SSO가 429 뒤에도 안쪽 로그인 전략을 이어 간다. 라이브러리 내부 동작이고, 옛 이식의 보장은 wrapper 수준까지다(에픽 F4 "내부 retry 보장 범위 따로 검토"). 수락 기준 밖이라 deferred-work에 남겼다.
  - `[medium]` `[patch]` `auth.py`·`collect.py`: 라이브러리 WARNING 로그가 예외 문장과 응답 title을 stderr로 냈다. → 두 진입점에서 `garminconnect` logger 전파를 막고, 시험을 더했다.
  - `[medium]` `[patch]` `garmin_session.py` `classify`: 감싼 연결 오류가 `LOGIN_REQUIRED`로 분류됐다. → 예외 체인에 `OSError`가 있으면 `GARMIN_TRANSIENT`(retryable=true)로 분류하고, 시험을 더했다.

## Design Notes

세션 adapter는 만드는 시점에는 네트워크를 쓰지 않고, attempt 확인과 coverage가 끝난 뒤에만 연다. 이미 받은 날짜면 로그인도 하지 않는다. 터미널 로그인도 같은 `.session.lock`과 `block.json`을 쓰므로, 당일 차단이면 비밀번호를 묻기 전에 끝낸다.

## Verification

**Commands:**
- `cd extensions/garmin && uv sync --frozen --no-dev --python 3.14.10 && .venv/bin/python -c 'import platform,garminconnect,curl_cffi,psycopg; print(platform.machine())'` -- expected: `arm64`
- `extensions/garmin/.venv/bin/python extensions/garmin/tests/check_session.py` -- expected: 모든 검사 통과
- `pnpm build && pnpm exec vitest run --config apps/cli/python-test/vitest.config.ts apps/cli/python-test/garmin-auth.test.ts apps/cli/python-test/garmin-collect.test.ts apps/cli/python-test/garmin-tracer.test.ts apps/cli/python-test/install.test.ts` -- expected: 전부 통과, skip 0
- `pnpm test` -- expected: 기존 시험 회귀 없음
