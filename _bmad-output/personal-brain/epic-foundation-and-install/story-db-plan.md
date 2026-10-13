---
title: '설치기 흐름: 의존성, DB, 설정, 마이그레이션'
type: 'feature'
ticket: '6'
created: '2026-10-13'
status: 'built'
baseline_revision: '8a05aeca87cca410af2af749df0790557cc893b9'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 설치 진입점(story 5)이 빌드까지 끝내고 넘겨도 설치기는 시작 화면만 낸다. DB도, 설정도, 스키마도 생기지 않아 `brain`이 쓸 수 없는 상태로 끝난다.

**Approach:** `apps/cli/src/install.ts`의 `runInstaller`를 대화형 흐름으로 채운다: 환경 확인 → Docker 확인·설치 동의 → DB 선택(기존 URL 연결, 또는 동의 후 로컬 Docker 컨테이너 생성과 준비 대기) → config·.env 기록(기존 코덱) → 마이그레이션 → `vector` 확장 설치 → `index_configs` 기본 행(멱등) → doctor. 미러 경로·임베딩·Harness 연결은 story 7, 임베딩 질문은 이번에 하지 않는다.

## Boundaries & Constraints

**Always:**
- 질문은 `@clack/prompts` 1.8.1(Stack 고정). 외부 명령(`docker`, `brew`)은 인자 배열로만, 주입 가능한 runner로(bootstrap의 `deps.run` 방식) — 흐름 전체를 가짜 runner로 테스트한다.
- 설정은 기존 `writeConfig`/`readConfig`만 쓴다(AD-18). DB URL은 `.env`에만, config.toml에는 변수 이름만.
- 마이그레이션은 이 흐름에서만 부른다(AD-20). 연결 불가와 SQL 실패를 다른 코드로 보인다(`DB_UNAVAILABLE` vs `MIGRATION_FAILED`) — deferred-work 1번 항목 해소.
- 컨테이너 기본값: 이미지 `pgvector/pgvector:pg18`, 이름 `second-brain-db`, named volume `second-brain-pgdata`, `--restart unless-stopped`, 포트 `127.0.0.1:54320:5432`(테스트용 54329와 겹치지 않음), 사용자 `postgres`, 데이터베이스 `brain`, 비밀번호는 설치 때 무작위 생성해 `.env`의 URL에만 기록. 준비 대기는 `pg_isready`를 정해진 시간(60초)까지 반복.
- `index_configs` 기본 행: `kind='chunk'`, `model=null`, `dimensions=null`, `chunk_params={targetChars:1200, overlapMessages:1, splitMessagesOverChars:2400}`, id는 UUIDv7, `on conflict do nothing`. 임베딩 행은 만들지 않는다.
- 재실행 멱등: 같은 이름 컨테이너가 있으면 새로 만들지 않고 (멈춰 있으면) 시작해 쓴다. 기존 `.env`의 URL이 있으면 그것을 기본값으로 보인다.
- 끝에 doctor를 같은 함수(`runDoctor`)로 돌려 항목별 결과를 보이고, 모두 ok면 exit 0, 아니면 exit 1.
- Decision(2026-10-13, 사용자): Docker가 없으면 동의 후 `brew install --cask docker`(Docker Desktop)로 설치하고, 앱을 열어 권한·동의를 마치라는 안내와 함께 `open -a Docker`를 실행한 뒤 "준비되면 Enter"로 기다려 `docker info`를 재확인한다. Homebrew가 없으면 설치 안내만 한다.
- Decision(2026-10-13, 사용자): 플랜 크기(약 3,500 토큰)는 단일 목표이므로 분할하지 않는다.
- 비TTY에서는 묻지 않는다: 플래그(`--database-url <url>` 또는 `--docker`, `--yes`)가 없으면 필요한 플래그를 안내하고 exit 2.

**Never:**
- 미러 경로·임베딩·Harness 연결·shim·`brain setup run` 명령 등록(story 7), doctor 등록 구조와 스키마 버전 항목(story 8).
- 기존 컨테이너·볼륨·DB를 지우거나 덮어쓰는 것. 사용자가 고른 기존 URL에 컨테이너를 만드는 것.
- 비밀번호나 URL을 화면·config.toml·로그에 출력하는 것(표시할 땐 비밀번호를 가린다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Docker로 새 DB | Docker 실행 중, 컨테이너 없음, "Docker로 만들기" | 컨테이너·볼륨 생성 → 준비 대기 → config·.env → 마이그레이션 → vector → index_configs → doctor ok, exit 0 | — |
| 기존 URL | "기존 URL" + 연결 가능한 URL | 컨테이너 명령 0건, 나머지 동일, exit 0 | — |
| 기존 URL 연결 불가 | 닫힌 포트 URL | `DB_UNAVAILABLE`과 이유, 다시 묻는다(비TTY는 exit 1). 설정은 쓰지 않음 | — |
| Docker 없음 | `docker` 없음 | 설치 동의를 묻는다 → 동의 시 Docker Desktop 설치·열기·대기 후 계속, 거절 시 "기존 URL"만 제안 | brew 없음 → 설치 안내 |
| Docker 데몬 멈춤 | `docker info` 실패 | 데몬을 켜라는 안내 후 재확인을 묻는다 | — |
| 재실행 | 컨테이너·config 있음 | 새로 만들지 않음, 기존 URL을 기본값으로, 마이그레이션 `applied=[]`, index_configs 행 1개 유지, exit 0 | — |
| 컨테이너 준비 안 됨 | 60초 안에 `pg_isready` 실패 | 로그 보는 명령 안내, exit 1 | 컨테이너는 남김 |
| 마이그레이션 SQL 실패 | 충돌 테이블 있는 DB | `MIGRATION_FAILED`와 PG 메시지, exit 1 | `DB_UNAVAILABLE`로 보이지 않음 |
| vector 없음 | 기존 URL에 pgvector 미제공 | 설치는 끝내고 doctor의 pgvector fail을 보인 뒤 exit 1 | — |
| 비TTY | 플래그 없음 | 필요한 플래그 안내, exit 2 | — |

</frozen-after-approval>

## Code Map

- `apps/cli/src/install.ts` -- `installerIntro`(L27), `runInstaller`(L39, 동기·항상 0) → async로 바꾸고 흐름을 담는다. `invokedDirectly`(L60) 유지. story 7이 `runInstaller`를 `setup run`에 연결하므로 함수 경계 유지.
- `apps/cli/src/config/codec.ts` -- `writeConfig(home, {timezone?, databaseUrlEnv?, databaseUrl?})`(L191, .env 0600·기존 키 보존), `readConfig`(L76), `DEFAULT_TIMEZONE`·`DEFAULT_DATABASE_URL_ENV`. 재사용, 수정 없음.
- `packages/postgres/src/migrate.ts` -- `runMigrations`(L70), catch(L116-118)가 모든 오류를 `DB_UNAVAILABLE`로 만든다 → 연결 단계 오류만 `DB_UNAVAILABLE`, 그 뒤 SQL 오류는 `MIGRATION_FAILED`. `packages/core`의 경고·오류 코드 목록(Conventions)에 코드 추가 필요 여부 확인.
- `packages/postgres/src/` -- vector 확장 설치와 `index_configs` 기본 행 쓰기를 adapter 함수로 추가(설치기만 부름). `packages/core/src/domain/index-config.ts`의 `ChunkParams`를 쓴다. jsonb 키 순서가 아니라 값으로 같아야 conflict가 걸린다(jsonb는 정규화되므로 같은 값이면 같음 — 테스트로 확인).
- `packages/core/src/admin/doctor.ts` `runDoctor`, `postgresStore`(`postgres/src/store.ts:49`) -- 설치기 끝의 doctor. `apps/cli/src/commands/admin-doctor.ts`의 `CHECK_IDS`(vector→pgvector)와 `formatCheck`(L48)를 export해 재사용.
- `apps/cli/src/runtime/id-gen.ts` `uuidV7IdGen` -- index_configs id.
- `tooling/bootstrap/src/bootstrap.ts:79-146` -- 주입 runner 패턴의 본보기(복사하지 않고 같은 모양으로).
- `tooling/test-db` `createTestDatabase({installVector})`, `apps/cli/test/admin-doctor.test.ts`(L36-51, 임시 `SECOND_BRAIN_HOME`·자식 프로세스 실행) -- 테스트 본보기.
- `_bmad-output/personal-brain/deferred-work.md` 1번 항목 -- 이 story에서 해소, 항목은 그대로 두고 Implementation Notes에 기록.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/package.json` -- `@clack/prompts` 1.8.1 추가 -- Stack
- [x] `packages/postgres/src/migrate.ts` (+test) -- 연결 오류와 SQL 오류 구분, `MIGRATION_FAILED` -- I/O "마이그레이션 SQL 실패"
- [x] `packages/postgres/src/setup.ts` (+index export, +test) -- `ensureVectorExtension(url)`(available일 때만 설치, 결과를 값으로), `ensureDefaultIndexConfig(url, id)`(멱등) -- 설치기 전용 쓰기
- [x] `apps/cli/src/install/docker.ts` -- 주입 runner로 `docker` 존재·데몬 확인, Docker Desktop 설치(`brew install --cask docker`, `open -a Docker`, 대기), 컨테이너 조회·생성·시작, `pg_isready` 대기, 무작위 비밀번호 -- DB 생성
- [x] `apps/cli/src/install/flow.ts` -- 단계 순서, 질문(clack, 주입 가능), 비TTY 플래그 처리, 단계별 한 줄 출력, 비밀번호 가림 -- 설치기 본문
- [x] `apps/cli/src/install.ts` -- `runInstaller`를 async로, flow에 위임, argv 전달 -- 진입점
- [x] `apps/cli/test/install-flow.test.ts` -- 가짜 runner·가짜 prompt로 I/O 표 각 행(명령 순서, 묻는 조건, exit 코드, 컨테이너 0건, 재실행 무변경) -- 회귀 고정
- [x] `apps/cli/test/install.test.ts` -- 실제 test DB로 `--database-url <test db> --yes` 비TTY 실행: config·.env(0600) 생성, 스키마·vector·index_configs 1행, 두 번 실행해도 1행, doctor ok -- 통합
- [x] `README.md` -- "Check the install"의 손으로 쓰는 설정 문단을 설치기 사용으로 교체 -- 안내

**Acceptance Criteria:**
- Given Docker만 있는 상태(임시 `SECOND_BRAIN_HOME`), when 설치기를 실행해 "Docker로 만들기"를 고르면, then `second-brain-db` 컨테이너가 named volume과 함께 생기고 doctor가 ok를 내며 exit 0.
- Given 같은 상태에서 다시 실행, then 컨테이너·볼륨 수가 같고 index_configs가 1행이다.
- Given `pnpm test`(compose PG), then 기존·새 테스트 모두 통과.

## Implementation Notes

- deferred-work 1번 항목(`runMigrations`가 SQL 실패를 `DB_UNAVAILABLE`로 보고) **해소**. `runMigrations`는 `pool.connect()`만 별도 try로 감싸 `DB_UNAVAILABLE`을 내고, 그 뒤 모든 실패는 `MIGRATION_FAILED` + `file`(거부된 마이그레이션 파일 이름)로 돌려준다. 항목 자체는 plan 지시대로 `deferred-work.md`에 그대로 남겼다. 회귀: `packages/postgres/test/migrate.test.ts`의 "runMigrations against a database that refuses a statement".
- `MIGRATION_FAILED`는 `packages/core`의 `WARNING_CODES`에 **넣지 않았다**. 그 목록은 "명령은 성공했지만 저하된" 결과가 `warnings[]`에 싣는 코드이고(NFR-2), 마이그레이션 실패는 설치기가 즉시 멈추는 하드 실패여서 envelope의 `warnings[]`에 오를 길이 없다. 코드 문자열은 `MigrationResult`에만 있다.
- adapter 함수 서명은 plan의 `(url)`·`(url, id)` 대신 같은 패키지의 `runMigrations`/`postgresStore`와 같은 옵션 객체(`ConnectionOptions` 확장)로 했다: 연결 예산(`connectTimeoutMs`)을 같은 방식으로 받아야 하고, 한 패키지 안에서 서명이 둘로 갈리는 걸 피했다.
- **실측에서 찾은 구멍 하나를 막았다.** 컨테이너를 지워도 named volume은 남고, pg18 이미지는 클러스터를 새로 만들 때만 `POSTGRES_PASSWORD`를 읽는다. 그래서 "컨테이너 없음 + 볼륨 있음"에서 새 비밀번호를 만들어 `.env`에 적으면 그 DB가 바로 그 비밀번호를 거부한다(실측: `password authentication failed for user "postgres"`). `volumeExists`를 추가해, 이 run이 직접 초기화한 클러스터일 때만 생성한 비밀번호를 URL로 쓰고, 그렇지 않으면 기존 `.env` URL을 쓰거나(없으면) 묻는다/exit 1 한다. 볼륨·컨테이너는 어느 경로에서도 지우지 않는다.
- 설정을 쓰기 직전에 모든 경로가 통과하는 단일 도달 확인(`reachable` → doctor의 `db` 검사)을 두었다. 덕분에 "닫힌 포트 URL"·"볼륨 비밀번호 불일치" 모두 `DB_UNAVAILABLE`과 함께 **아무것도 쓰지 않고** 끝난다.
- 볼륨 마운트 지점은 `/var/lib/postgresql`이다(`/var/lib/postgresql/data` 아님). pg18 이미지가 선언한 VOLUME이 그쪽이고 클러스터는 그 아래 `18/docker`에 들어간다(`compose.test.yaml`의 주석과 같은 이유). 실측으로 확인: `show data_directory` = `/var/lib/postgresql/18/docker`, `df`가 그 경로를 볼륨 장치로 보고하며, 컨테이너를 지우고 다시 만들어도 스키마와 index_configs 행이 남아 있었다.
- 탐지용 명령(`docker --version`, `docker info`, `docker container inspect`, `docker volume inspect`, `brew --version`, `pg_isready`)은 `quiet`로 stderr를 버린다. 그렇지 않으면 정상 경로에서 `Error response from daemon: No such container: second-brain-db`가 화면에 떠 설치가 깨진 것처럼 보였다(실측).
- 비TTY 게이트는 `--yes` **와** (`--database-url <url>` 또는 `--docker`) 둘 다를 요구한다(plan의 괄호 묶음을 그렇게 읽었다). URL을 묻는 루프는 3회까지만 다시 묻고 exit 1 한다 — 같은 틀린 URL이 계속 들어올 때 영원히 묻지 않기 위해서다. Docker 데몬 대기도 3회.
- `tooling/test-db`에 `rows<T>(text)`를 더했다. `apps/cli` 통합 테스트가 테이블을 되읽어야 하는데, 그 때문에 CLI가 `pg`에 의존하게 만들고 싶지 않았다(AD-1 경계).
- `tooling/bootstrap/test/npx.test.ts`의 기대 exit 코드를 0 → 2로 고쳤다. `spawnSync`는 자식에게 파이프를 주므로 설치기는 비TTY이고, 플래그가 없으면 2로 끝나는 것이 이 story의 정상 동작이다. 그 코드가 npx 끝까지 전달되는 것이 그 테스트의 요지라 기대값만 바꿨다.
- `installerIntro`의 "still being built" 줄을 node 버전 줄로 바꿨다. 함수 이름과 경계는 그대로라 story 7이 쓸 수 있다. `runInstaller(argv, env, deps)`는 argv를 받고 async다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-13, lens: quick) — high 1 / medium 3 / low 3 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `pg_isready`가 unix socket으로 이미지의 init용 임시 서버에 답해, 실제 서버가 뜨기 전 ~350ms 구간에서 "준비됨"이 되고 단발 도달 확인이 실패한다 | high | patch | 리뷰어가 pg18 컨테이너 로그로 측정. `docker.ts` waitForReady에 `-h` 없음 확인. 첫 설치 정상 경로가 exit 1이 될 수 있다. TCP로 탐침 |
| 2 | 재실행이 `writeConfig(home,{databaseUrl})`만 불러 기존 `timezone`·`url_env`가 기본값으로 돌아가고 URL이 .env에 두 이름으로 남는다 | medium | patch | `flow.ts:179`, `codec.ts:203-215` 확인. 리뷰어 재현. 현재 값을 읽어 다시 넘긴다 |
| 3 | 만든 비밀번호가 도달 확인 뒤에야 기록돼, 대기 시간 초과·도달 실패 시 잃고 이후 실행이 모두 막힌다 | medium | patch | `flow.ts:340-363` 확인: `password`는 지역 변수, write는 L179. `docker run` 성공 직후 기록 |
| 4 | 표 "Docker 없음 … 거절 시 '기존 URL'만 제안"이 같은 실행에서 제안되지 않고 exit 1로 끝난다 | medium | patch | `ensureDocker` 거절 분기와 컨테이너 생성 거절 분기가 바로 `exit 1`. TTY에서 `askForUrl`로 이어 간다 |
| 5 | Docker 경로가 기록된 `.env` URL이 컨테이너를 가리키는지 확인하지 않는다 | low | 거절 | 외부 URL로 설치한 뒤 남은 컨테이너·볼륨이 있고 Docker를 고르는 드문 경우만. 수정은 비교 분기 추가 |
| 6 | `MIGRATION_FAILED`를 원인이 아니라 단계로 정해, 마이그레이션 중 연결이 끊기면 스키마 실패로 보인다 | low | 거절 | 실행 중 DB 재시작 같은 드문 경우. 수정은 PG 오류 코드 분류로 직접 수정이 아니다 |
| 7 | setup.ts의 버그 throw가 `DB_UNAVAILABLE`로, migrate의 readFile 실패가 `MIGRATION_FAILED`로 보이고, index id 충돌이 처리 안 된 예외로 끝난다 | low | 거절 | 모두 서버 버그·패키징 오류·UUIDv7 충돌처럼 일상에서 만나지 않는 경로. 수정은 분기 추가 |

경로 요약: intent_gap 0, bad_plan 0, patch 4(1~4), defer 0, 거절 3(5·6·7).

패치 4건 적용 후 재검증(2026-10-13): compose PG로 `pnpm test` 17개 파일·356개 통과. 실제 Docker 설치 실측 exit 0, 실측 컨테이너·볼륨 정리 확인. 참고: pg18 이미지는 첫 기동 때 socket만 여는 init 서버를 ~375ms 띄우므로 준비 확인은 `pg_isready --host 127.0.0.1`로 TCP를 본다. 새 클러스터의 URL은 `docker run` 직후 바로 기록한다.

## Design Notes

- vector 확장을 설치기가 만드는 이유: `pgvector/pgvector:pg18`은 확장을 어느 DB에도 설치하지 않고, 마이그레이션은 AD-15 때문에 vector를 만들지 않는다. doctor의 pgvector 항목이 ok가 되려면 설치기가 `create extension if not exists vector`를 해야 한다. 임베딩을 켜는 것과는 별개다.
- 설치기는 디스패처 밖이라 config를 다시 읽지 않고, 자신이 고른 URL로 `postgresStore`를 직접 만든다.

## Verification

**Commands:**
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test` -- expected: 전 프로젝트 통과
- 임시 `SECOND_BRAIN_HOME`으로 `node apps/cli/dist/install.js` 대화형 실행, "Docker로 만들기" -- expected: 컨테이너 생성·doctor ok·exit 0. 두 번째 실행도 exit 0, `docker ps -a`·`docker volume ls`에 하나씩
- 확인 뒤 `docker rm -f second-brain-db && docker volume rm second-brain-pgdata` -- 실측 정리(사용자의 실제 설치가 아닌 경우에만)
