---
title: '런타임·설치기를 로컬 SQLite 원본으로 전환'
type: 'feature'
ticket: '13'
created: '2026-10-14'
status: 'built'
baseline_revision: 'a9a233a79f5433c5017533c70f05215cf8272891'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 원본은 로컬 SQLite로 정했고(change-local-sqlite-primary) `packages/sqlite`도 마이그레이션 0002까지 있지만, 설정 코덱·디스패처·설치기·`setup run`은 여전히 Postgres URL과 Docker를 요구한다. 그래서 Docker도 Postgres도 없는 Mac에서는 설치가 끝나지 않는다.

**Approach:** 설정 코덱에서 `[database] url_env`를 빼고 `[store] path`(기본 `<home>/brain.db`)와 `[files] path`(기본 `<home>/files`)를 넣는다. 디스패처·doctor·설치기가 `sqliteStore`·`runSqliteMigrations`를 쓰게 하고, 설치기의 DB 선택·Docker 단계를 "DB 파일 위치" 질문 하나로 바꾼다. 설치기는 DB 파일(0600)과 `files/` 루트(0700)를 만들고 마이그레이션을 돌린다. `install/docker.ts`와 `packages/postgres`는 지우지 않고 CLI에서 import만 끊는다.

## Boundaries & Constraints

**Always:**
- 경로 키(`store.path`, `files.path`, `mirror.path`)는 모두 절대 경로이고, 상대 경로는 `CONFIG_INVALID`다. 입력의 `~`는 설치기가 펼친다. 재실행은 기록된 값을 기본값으로 보이고, 묻지 않은 값을 기본값으로 되돌리지 않는다.
- `config.toml`의 `schema_version`은 1로 둔다(아직 실제 설치가 없다). 옛 `[database] url_env`가 남아 있는 파일은 `CONFIG_UNKNOWN_KEY` 경고로 읽힌다.
- `.env`는 계속 0600으로 쓰고, 이미 있는 변수는 보존한다. `readConfig`는 `.env`를 더는 읽지 않는다(읽을 키가 없다).
- DB 파일은 마이그레이션 전에 0600으로 먼저 만든다. 그래서 한순간도 다른 사람이 읽을 수 있는 상태가 없다. 마이그레이션 뒤에는 남아 있는 `-wal`·`-shm`도 0600으로 맞춘다. DB 파일의 부모 폴더가 없으면 0700으로 만든다. `files/` 루트는 0700으로 만들고, 이미 있으면 0700으로 고친다.
- index_configs 기본 행(`chunk`, `document_chunk`)은 SQLite 마이그레이션 0001·0002가 넣는다. 설치기는 따로 행을 쓰지 않는다.
- 런타임은 DB를 이미 있는 파일로만 연다(`openSqlite`의 `mode=rw`). 파일이 없으면 `DB_UNAVAILABLE`이다. 쓰기 명령의 스키마 검사는 `SQLITE_SCHEMA_VERSION`과 비교한다. busy timeout은 hook 명령이면 `BUSY_TIMEOUT_MS.turn`, 그 밖이면 `.command`다.
- 비TTY에서는 `--yes`가 유일한 동의다. `--yes`가 없으면 안내를 보이고 exit 2로 끝난다. TTY에서는 DB 위치를 묻는다(미러와 같은 방식: 플래그가 있으면 묻지 않고, 상대 경로면 다시 묻는다. 비TTY에서 상대 경로면 exit 2).
- 새 플래그는 `--store-path <path>`다(설치기와 `setup run` 둘 다). `--database-url`·`--docker`는 두 진입점 모두에서 없앤다. 없는 플래그로 들어오면 기존 규칙대로 `USAGE`로 처리된다.

**Never:**
- `packages/postgres`·`install/docker.ts`·`tooling/test-db`·`compose.test.yaml`을 지우거나 고치는 것(epic 7이 다시 쓴다). Postgres 계약 테스트는 그대로 돈다.
- doctor 항목 재설계(`store` 이름, shim·node 항목은 story 8), `FileStore` port·블롭 쓰기(epic 2), `files.path`를 묻는 질문이나 플래그, 복제 대상(`[[replicas]]`, epic 7), DB 이전(`move-store`).
- 이전 DB 파일을 옮기거나 지우는 것. 재실행에서 다른 경로를 고르면 새 파일만 만들고, 옛 파일은 그 자리에 남는다고 한 줄로 알린다.
- Decision(2026-10-14): 플랜 크기(약 4,500 토큰)는 단일 목표(원본 전환)이고 코덱·런타임·설치기가 따로 내보낼 수 없게 묶여 있으므로 분할하지 않고 전체를 유지한다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 설치 | 빈 home, `setup run --yes`(비TTY) | `brain.db` 0600, `files/` 0700, config에 세 경로, 스키마 버전 2, shim, doctor ok, exit 0 | — |
| 재실행 | 같은 home에서 한 번 더 | config·shim 바이트 동일, `applied=[]`, 테이블별 행 수 동일, exit 0 | — |
| 동의 없음 | 비TTY, `--yes` 없음 | 아무것도 쓰지 않음, 안내 + exit 2 | `USAGE` |
| 위치 지정 | `--store-path ~/x/brain.db` | 펼친 절대 경로를 기록, 부모 폴더 0700으로 생성 | 상대 경로면 TTY는 다시 묻고, 비TTY는 exit 2 `CONFIG_INVALID` |
| TTY 질문 | Enter | 기록된 값, 없으면 `<home>/brain.db` | — |
| 위치 변경 | 재실행에서 다른 경로 | 새 파일을 만들고 마이그레이션. 옛 파일이 남아 있다는 한 줄 | — |
| 옛 플래그 | `setup run --database-url x --yes` | 실행 안 함 | `USAGE` exit 2 |
| DB 파일 없음 | config는 있는데 `brain.db`를 지움 | `admin doctor` → `db` fail `DB_UNAVAILABLE`, 파일을 만들지 않음 | exit 1 |
| 상대 경로 config | `store.path = "brain.db"` | 명령 실행 안 함 | `CONFIG_INVALID` exit 2 |
| 마이그레이션 실패 | DB 경로가 폴더 | `DB_UNAVAILABLE`/`MIGRATION_FAILED` 한 줄, shim·connect 생략 | exit 1 |

</frozen-after-approval>

## Code Map

- `apps/cli/src/config/codec.ts` -- `KNOWN_KEYS`(L31): `database.url_env`를 빼고 `store.path`·`files.path`를 넣는다. `DEFAULT_DATABASE_URL_ENV`·`ENV_NAME`·`own`, 그리고 `.env` 읽기(L194-220)를 지운다. `BrainConfig`/`WriteConfigInput`은 `storePath`·`filesPath`·`mirrorPath`·`timezone`을 가진다. 기본값 함수 `defaultStorePath(home)`·`defaultFilesPath(home)`는 `defaultMirrorPath`(L46)와 같은 모양이다. 절대 경로 검사는 mirror(L175-192)의 문장 그대로 세 키에 적용한다. `writeConfig`는 `.env`를 계속 0600으로 쓰고 기존 변수를 보존한다(L263-297). `readConfig(home)` 시그니처에서 `env`를 뺀다(호출부: dispatch L268, install.ts L146).
- `apps/cli/src/dispatch.ts` -- `postgresStore`(L275)를 `sqliteStore({ path, busyTimeoutMs })`로, `SCHEMA_VERSION`을 `SQLITE_SCHEMA_VERSION`으로 바꾼다. `CONNECT_TIMEOUT_MS`·`DEFAULT_QUERY_TIMEOUT_MS`·`queryTimeoutMs`(L142)는 지운다(쓰는 테스트가 없다). `BUSY_TIMEOUT_MS`는 `second_brain`이 재export한다.
- `apps/cli/src/commands/admin-doctor.ts` -- `CHECK_IDS`(pgvector 매핑)와 그 주석을 지운다. flow.ts L10·L309-312에서 쓰는 곳도 함께 지운다.
- `apps/cli/src/install/flow.ts` -- 가장 큰 변경. 지우는 것: `chooseDatabase`, `askForUrl`, `dockerDatabase`, `awaitContainer`, `ensureDocker`, `reachable`, `maskUrl`, `TWO_DATABASES`, `URL_ATTEMPTS`, `DAEMON_ATTEMPTS`, docker import(L13-33). `InstallDeps`에서는 `run`·`sleep`·`now`·`password`·`nextId`·`readyTimeoutMs`·`database`를 지운다. `InstallPrompts`에서는 `select`·`pause`를 지운다(다른 데서 쓰지 않음). 더하는 것: `store: { prepare(path): Promise<SqliteMigrationResult>; doctor(path): Promise<DoctorReport> }`, `files: { prepare(path): Promise<{ path; created }> }`, `chooseStorePath`(구조는 `chooseMirrorPath` L338 그대로). `RecordedConfig` = `{ timezone, storePath, filesPath, mirrorPath }`, `settings()`는 네 값을 모두 넘긴다(story 6·7의 함정이 이것이다). 순서: 모르는 `--connect` → 비TTY 동의 → recorded 읽기 → 저장소 위치 → 미러 → 임베딩 → config 쓰기 → store.prepare → files.prepare → shim → connect → doctor. `parseFlags`·`usage`·`nonInteractiveGuidance`·머리 주석의 순서 설명도 고친다.
- `apps/cli/src/install/store.ts` (새) -- `prepareStore(path, clock?)`: 부모 `mkdir`(recursive, 0700) → `open(path,'a',0o600)` 뒤 `chmod 0600` → `runSqliteMigrations({ path })` → 남아 있는 `-wal`·`-shm`을 `chmod 0600`. `prepareFilesRoot(path)`: `mkdir`(recursive, 0700) + `chmod 0700`, `created`를 돌려준다. `doctorAt(path)`: `sqliteStore({ path })` + `runDoctor` + close(지금 install.ts L174에 있는 것을 옮긴다).
- `apps/cli/src/install.ts` -- `systemInstallDeps`(L124)를 새 deps로 바꾼다. postgres·docker import와 `runCommand`를 지운다. config.read는 `readConfig(home)`의 네 값을 쓴다. `clackPrompts`에서 `select`·`pause`를 뺀다.
- `apps/cli/src/commands/setup-run.ts` -- options(L26)에서 DB 두 개를 빼고 `--store-path <path>`를 넣는다. `toFlags`도 같이 고친다.
- `apps/cli/package.json` -- `@second-brain/test-db` devDependency는 CLI 테스트가 더 쓰지 않게 되면 빼고 `pnpm install`로 lockfile을 갱신한다.
- 테스트(모두 Postgres 대신 임시 폴더 안의 SQLite 파일): `test/config.test.ts`(url_env 사례를 경로 키 사례로 바꾼다), `test/dispatch.test.ts` L170 `homeFor`·`closedPort`(마이그레이션한 파일 / 없는 파일), `test/admin-doctor.test.ts` L36-51, `test/install-flow.test.ts`(1346줄, docker·URL 사례를 지우고 fake `store`·`files`로 I/O 표를 덮는다. 기존 `harness()`·`TAIL` 본보기를 따르되 TAIL 앞에 저장소 위치 질문을 더한다), `test/install.test.ts`, `test/setup.test.ts` L222-380. SQLite 마이그레이션은 `runSqliteMigrations`로, 행 수는 `node:sqlite` `DatabaseSync`(읽기 전용)로 확인한다.
- `README.md` -- 머리말 "Postgres holds the originals", Install(L28-70), Re-configure(L75-92), Layout(`packages/sqlite`를 원본으로, postgres는 복제용 epic 7로), Check the install(L167-190, docker 없이).
- 손대지 않는 것: `packages/sqlite`(필요한 API는 이미 export됨: `sqliteStore`, `runSqliteMigrations`, `SQLITE_SCHEMA_VERSION`), `packages/core`, `install/shim.ts`, `connectors/`, `setup-connect.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/config/codec.ts` (+`test/config.test.ts`) -- 경로 키 세 개, url_env와 `.env` 읽기 제거 -- AD-18
- [x] `apps/cli/src/dispatch.ts`, `commands/admin-doctor.ts` (+`test/dispatch.test.ts`, `test/admin-doctor.test.ts`) -- sqlite store, SQLite 스키마 버전, busy 예산, pgvector 매핑 제거 -- 런타임 전환
- [x] `apps/cli/src/install/store.ts` (새, +`test/install-store.test.ts`) -- 파일·폴더 권한과 마이그레이션. 테스트: 새 파일 0600, 부모 폴더 0700, 두 번째 `applied=[]`, 쓰기 중 `-wal` 0600, 폴더 경로면 실패 값을 돌려줌
- [x] `apps/cli/src/install/flow.ts`, `install.ts`, `commands/setup-run.ts` -- DB·Docker 단계를 저장소 위치 질문으로 바꾸고, `--store-path`를 넣고 옛 플래그를 뺀다
- [x] `apps/cli/test/install-flow.test.ts` -- I/O 표의 흐름 행(동의 없음, 위치 지정·상대 경로·Enter, 위치 변경 알림, 마이그레이션 실패 시 shim 생략, 재실행이 기본값을 보존)
- [x] `apps/cli/test/install.test.ts`, `test/setup.test.ts` -- 빌드된 진입점으로 실제 SQLite 실행. `PATH`를 node 폴더와 `/usr/bin:/bin`으로 좁히고 DB 환경 변수를 빼서 돌린다
- [x] `apps/cli/package.json` -- 쓰지 않게 된 test-db devDependency 제거
- [x] `README.md` -- 설치·재설정·레이아웃·확인 절을 로컬 원본 기준으로 고친다

**Acceptance Criteria:**
- Given `PATH`에 docker가 없고 `BRAIN_TEST_DATABASE_URL`·`SECOND_BRAIN_DATABASE_URL`이 없는 환경과 빈 임시 home, when `brain setup run --yes`를 두 번 돌리면, then 둘 다 exit 0이고 `brain.db`가 0600, `files/`가 0700이며, config.toml·shim이 바이트 단위로 같고, 사용자 테이블별 행 수가 같다.
- Given 그 home, when 셸 환경에 `SECOND_BRAIN_HOME` 없이 `<home>/bin/brain admin doctor --json`을 돌리면, then exit 0과 ok 봉투이고 `db`·`wal`·`fts5-trigram`·`foreign-keys`가 모두 ok다.
- Given `apps/cli/src`, when `postgres`·`docker`를 grep하면, then import가 하나도 없다(`install/docker.ts` 자기 자신은 제외).
- Given compose PG, when `pnpm build && pnpm test`를 돌리면, then 모든 패키지의 기존·새 테스트가 통과하고 CLI 테스트는 PG 없이도 통과한다.

## Implementation Notes

- `chooseStorePath`와 `chooseMirrorPath`는 둘 다 공유 `choosePath(question, deps)`에 위임한다. 플랜이 요구한 두 이름과 미러의 기존 동작(플래그 → 비TTY 기본값 → 3회 질문 → exit 2)을 그대로 두면서 같은 로직을 두 번 쓰지 않는다. `MIRROR_ATTEMPTS`는 `PATH_ATTEMPTS`로 바뀌었다.
- `prepareStore`가 돌려주는 `MIGRATION_FAILED`의 `file`은 "DB 파일이 SQLite가 아닐 때" 빈 문자열이다. `openSqlite`는 헤더를 읽지 않으므로 거절은 첫 마이그레이션 파일 전의 `pragma journal_mode = WAL`에서 나온다. 그래서 flow는 `file`이 빈 문자열이 아닐 때만 "The migration the database refused is …" 줄을 찍는다.
- `prepareFilesRoot`도 `prepareStore`처럼 코드값을 돌려준다(`FILES_UNAVAILABLE`). 플랜이 적은 `Promise<{ path; created }>`에서 벗어나는 유일한 지점인데, 이게 없으면 `setup run --store-path <home>/files --yes` 같은 실제 입력이 `guarded()`와 디스패처를 지나 생 스택 트레이스로 나온다. flow는 `CODE: message` 한 줄을 찍고 shim 전에 exit 1한다.
- `prepareStore`의 `clock` 매개변수는 부르는 쪽이 없어서 지웠다. 필요해지는 스토리가 다시 넣는다.
- 플랜 Code Map에 없던 `tooling/bootstrap/test/npx.test.ts`도 한 줄 고쳤다. 비TTY 안내문의 `--docker --yes`를 단언하고 있어서, 안내문이 `--yes`로 바뀌면 깨진다.
- `apps/cli/src/commands/setup-connect.ts`·`setup-run.ts`의 Postgres·Docker 언급은 주석뿐이었고, acceptance의 grep을 깨끗하게 하려고 문장만 고쳤다.
- `install/docker.ts`·`packages/postgres`·`tooling/test-db`·`compose.test.yaml`은 손대지 않았다. `apps/cli/src`에서 import만 끊었다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 0 / medium 2 / low 6 / false 1 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `prepareFilesRoot`가 실패를 값으로 돌려주지 않아, `files/` 자리에 파일이 있으면 설치기가 스택 트레이스로 죽는다 | medium | patch | `--store-path <home>/files --yes`로 리뷰어가 EEXIST 스택을 재현했다. 형제 함수 `prepareStore`는 값으로 돌려준다. 같은 꼴로 고치고 flow는 코드 한 줄 + exit 1 |
| 2 | 옛 설정(`store.path` 없음)에서 재실행 경로를 바꾸면 없는 파일을 "그 자리에 남는다"고 알린다 | low | 거절 | 기본값으로 채워진 경로를 비교한다. 실제 설치가 없어 옛 형식 설정을 만날 일이 드물고, 고치려면 파일 존재 확인 주입이 필요하다 |
| 3 | `MIGRATION_FAILED`의 `file`이 빈 문자열이면 "…refused is ."를 찍는다 | low | patch | DB가 아닌 파일로 재현했다. `file`이 비어 있지 않을 때만 찍는 직접 수정 |
| 4 | 읽을 수 없는 값 하나가 있는 설정이면 재실행이 묻지 않는 값(`files.path` 등)까지 기본값으로 되돌린다 | medium | defer | 리뷰어가 재현했다. `readConfig` 실패 → `undefined` 매핑은 story 6·7부터 있던 동작이다. 고치려면 부분 읽기 결과라는 새 표면이 필요하다. `files.path`는 묻는 곳이 없어 영향이 커졌다 |
| 5 | hook·command busy 예산 분기를 검사하는 테스트가 없다 | low | defer | 사실이다. 지금 디스패처에서는 예산이 관찰되지 않아, 검사하려면 store 주입 seam이 필요하다 |
| 6 | `dispatch.test.ts:304` 제목이 단정 내용과 반대다 | low | patch | 제목만 바꾸는 직접 수정 |
| 7 | 리뷰 diff에 `pnpm-lock.yaml`이 빠져 있다 | false | 거절 | diff를 만들 때 일부러 뺐다. 작업 트리의 lockfile은 갱신돼 있고 함께 커밋한다 |
| 8 | `prepareStore`의 `clock` 매개변수를 아무도 넘기지 않는다 | low | patch | 매개변수와 분기를 지우는 직접 수정 |
| 9 | sidecar `chmod` 반복은 평소 도달하지 않고 테스트도 없다 | low | 거절 | 깨끗이 닫으면 sidecar가 사라진다. 실제 보장(VFS가 DB 파일 권한을 물려줌)은 테스트로 확인된다. 사용자가 만날 결함이 없다 |
| 10 | 설치기가 `CONFIG_UNKNOWN_KEY` 경고를 버리고, 다시 쓰면서 그 키를 조용히 지운다 | low | defer | 재현했다. 경고를 버리는 것은 story 6·7부터 있던 동작이다. 옛 `url_env`는 지우는 게 맞지만, 사용자의 오타 키가 조용히 사라지는 것은 AD-18의 "조용히"에 걸린다 |

경로 요약: intent_gap 0, bad_plan 0, patch 4(1·3·6·8), defer 3(4·5·10), 거절 3(2·7·9).

## Design Notes

- `.env` 읽기를 빼는 이유: 지금은 읽을 키가 하나도 없다. 남겨 두면 깨진 `.env`가 모든 명령을 `CONFIG_INVALID`로 막는다. 키를 쓰는 에픽(6·7)이 그때 읽기를 다시 넣는다. 쓰기 쪽은 기존 변수 보존과 0600 규칙이 남아 있어야 하므로 그대로 둔다.
- 0600을 먼저 만드는 이유: SQLite unix VFS는 `-wal`·`-shm`을 DB 파일과 같은 권한으로 만든다. 그래서 DB 파일을 먼저 0600으로 만들면 세 파일 모두 0600이 된다. 마이그레이션 뒤의 sidecar `chmod`는 예전 실행이 남긴 파일을 고치는 안전망이다.
- config 예:
  ```toml
  schema_version = 1
  timezone = "Asia/Seoul"
  [store]
  path = "/Users/me/.second_brain/brain.db"
  [files]
  path = "/Users/me/.second_brain/files"
  [mirror]
  path = "/Users/me/.second_brain/mirror"
  ```

## Verification

**증거(2026-10-14 실행):**
- `pnpm build` -- TS 오류 없음
- `pnpm vitest run --project cli` (PG 없이) -- 10 files, 216 tests 통과
- compose PG + `BRAIN_TEST_DATABASE_URL=… pnpm test` -- 26 files, 600 tests 통과
- 임시 home에서 `setup run --yes` 두 번(`PATH`=node 폴더+`/usr/bin:/bin`, DB 환경 변수 제거) -- 둘 다 exit 0, `cmp`로 config·shim 동일, `brain.db` 600 / `files` 700 / `.env` 600 / `bin/brain` 755, 사용자 테이블 48개 행 수 동일
- `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor --json` -- exit 0, `db`·`wal`·`fts5-trigram`·`foreign-keys` 모두 ok
- `brain.db` 삭제 후 doctor -- exit 1, `db` fail `DB_UNAVAILABLE`, 파일 재생성 없음
- `store.path = "brain.db"` -- exit 2 `CONFIG_INVALID`, 키 이름을 메시지에 담음
- `setup run --database-url x --yes` -- exit 2 `USAGE`
- `grep -rn -i "postgres\|docker" apps/cli/src` -- `install/docker.ts` 외 import 없음(주석도 없음)
- `git status --short` -- `dist/`·`*.db` 없음

**Commands:**
- `pnpm build` -- expected: TS 오류 없음
- `pnpm vitest run apps/cli` (PG 없이) -- expected: 전부 통과
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- 임시 `SECOND_BRAIN_HOME`에서 `env PATH=$(dirname $(which node)):/usr/bin:/bin node apps/cli/dist/bin.js setup run --yes`를 두 번 돌린 뒤 `cmp`로 config·shim을 비교하고, `stat -f %Lp`로 brain.db·files 권한을 보고, `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor` -- expected: 동일, 600/700, exit 0
- `git status --short` -- expected: `dist/`·`*.db` 없음

패치 4건 적용 후 재검증(2026-10-14): `pnpm build` 정상, compose PG 포함 `pnpm test` 26개 파일 603개 통과. PATH를 좁힌 임시 home에서 `setup run --yes` 두 번 모두 exit 0, config·shim `cmp` 동일, `brain.db` 600·`files` 700, `env -u SECOND_BRAIN_HOME <home>/bin/brain admin doctor` exit 0.
