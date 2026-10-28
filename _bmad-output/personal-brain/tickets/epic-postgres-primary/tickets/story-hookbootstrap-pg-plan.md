---
title: '런타임 전환: 모든 명령·데몬·hook·bootstrap이 PG만 쓴다'
type: 'refactor'
ticket: '10'
created: '2026-10-29'
status: done
baseline_revision: '18d729fca6678be17880a943a840c1a319ac33e6'
route: 'full'
route_source: 'pinned'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/tickets/epic-postgres-primary/epic-postgres-primary.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 지금 런타임은 `config.toml`에 `[store] url_env`가 있을 때만 PG를 쓰고, 없으면 SQLite(`store.path`)를 고른다. 설치는 SQLite 단계(`chooseStorePath`·`--store-path`·`prepareStore`·SQLite doctor)를 아직 가지고 있고, `apps/cli`·`tooling/bootstrap`·`packages/postgres/test/cli.test.ts` 통합 시험은 SQLite DB를 fixture로 쓴다. 그래서 PG가 유일한 주 저장소라는 에픽 결과(E11-10, AD-10)가 아직 참이 아니다.

**Approach:** 선택자 기본값 `BRAIN_DATABASE_URL`을 한 곳에 두어 모든 홈을 PG 홈으로 만들고, factory·dispatch·daemon·assembly·install에서 SQLite 분기와 그 뒤의 죽은 SQLite 코드(`apps/cli/src` 안)를 지운다. `store.path`는 설정 키에서 없앤다. CLI·bootstrap 시험 프로젝트에 PG 시험 DB를 붙여 DB fixture를 PG로 옮기고, baseline 0001의 checksum을 시험으로 고정한다.

## Boundaries & Constraints

**Always:**
- 선택자: `[store] url_env`가 없거나 `[store]` 표가 없으면 `BRAIN_DATABASE_URL`이다. 상수는 config codec 한 곳(예: `DEFAULT_STORE_URL_ENV`)에 두고 읽기·setup·doctor·daemon이 그것을 쓴다. 이름 검증 규칙(`storeUrlEnvError`)은 그대로다. URL 해석(process env 우선, 빈 값이면 `.env`로 넘어가지 않음, 다음 `<home>/.env`)도 그대로다.
- `store.path`: 설정 결과(`storePath`)와 `KNOWN_KEYS`에서 없앤다. 옛 파일에 `[store] path`가 있어도 오류가 아니며 경로 검증도 하지 않는다. 그 값(문자열이면)은 옛 SQLite 파일 후보로만 쓰고, 없으면 `<home>/brain.db`가 후보다. setup이 `config.toml`을 다시 쓸 때 `store.path`를 쓰지 않고 보존 목록(unknown key extra)에서도 뺀다. setup은 `[store] url_env`를 기록된 값 또는 기본값으로 명시해 쓴다. `files.path`·`mirror.path`·`update.auto`·`timezone` 처리(PG 홈 규칙)는 그대로다.
- 옛 SQLite 파일 안내: 후보 경로에 파일이 있으면 지우지 않고 지금 문장("옛 SQLite 파일 <path>는 지우지 않았고 더 쓰지 않습니다")을 보이고 `postgres.legacy_sqlite_path`에 담는다(티켓 8의 동작을 모든 홈에).
- `setup run`은 `config.toml`이 없는 새 홈에서도 PG 흐름(티켓 8의 순서: OrbStack 확인 → compose → role·schema → 마이그레이션 → "나" → 시간대 → transcript 가져오기 → PG doctor → 완료 기록)으로 돈다. `--store-path`는 더 이상 등록된 플래그가 아니며(넘기면 기존 모르는 플래그 규칙대로 `USAGE`), 도움말·예시·재시도 argv·`output` 설명에서 뺀다. 결과 봉투의 `store` 필드(SQLite 보고)는 없애고 `postgres`는 항상 채운다.
- 일반 명령은 지금처럼 `config.toml`이 없으면 `CONFIG_MISSING`이다. 설정은 있는데 URL이 해석되지 않으면 기존 factory 동작(연결 불가 Store → `DB_UNAVAILABLE`, hook은 spool, 데몬은 compose를 부르지 않음)을 그대로 쓴다.
- `openBrainStore`는 PG만 연다: `createSqliteStore` 옵션과 `kind: 'sqlite'` 변형을 없앤다. 설정을 읽지 못하면 `failedConfigStore`(모든 verb `DB_UNAVAILABLE`)를 유지하되 반환 타입이 PG 변형과 같은 capability(`SettingsStore` 포함)를 갖게 한다. PG 모듈은 지금처럼 이 함수 안의 동적 import로만 로드한다(`help`·preflight 거절 경로는 PG를 로드하지 않는다).
- `dispatch`(일반 명령·hook·기회적 drain), `daemon/run.ts`, `assembly.ts`, `install.ts`는 `sqliteStore`·`SqliteStoreOptions`·`SQLITE_SCHEMA_VERSION`·`CreateStore` SQLite seam을 쓰지 않는다. 시험 seam이 필요하면 PG 연결 옵션(URL·lock timeout 등)을 받는 중립 seam으로 바꾼다. `config get/set`의 "SQLite 홈 거절" 분기를 지운다. doctor의 `config-timezone` 판정은 모든 홈에 PG 규칙을 쓴다. assembly의 OrbStack·container 선행 검사와 adapter probe는 항상 붙는다.
- 빌드 기록: `apps/cli/scripts/write-build-info.mjs`의 scalar `schema_version`은 PG core 버전(`CORE_SCHEMA_VERSION`, 지금 1)이고, `schema_versions`(소유자별)는 그대로다. 설치 완료 기록의 `schema_version`도 같은 값이 된다. `readBuildIdentity`·`installed-schema.test.ts`를 맞춘다.
- `apps/cli/src` 안에서 SQLite 선택을 없애 도달할 수 없게 된 SQLite 전용 코드(`install/store.ts`의 SQLite 준비·header·권한·WAL sidecar·마이그레이션·self·collision·`doctorAt`, `install/flow.ts`의 `chooseStorePath`·`storeCollisions`·합치기·SQLite 보고)는 지운다. `prepareFilesRoot`처럼 PG 흐름이 쓰는 기능은 남긴다(필요하면 다른 파일로 옮긴다).
- 시험 DB: `apps/cli`·`tooling/bootstrap` 프로젝트에 `test/global-setup.ts`(=`@second-brain/test-db`의 `setupTestDatabase`, devDependency 추가)를 둔다. 한 번의 vitest 실행에서 시험 컨테이너는 한 번만 올라가고, 그것을 올린 쪽의 teardown은 모든 프로젝트 시험이 끝난 뒤에만 돈다(vitest의 global setup 실행·teardown 순서를 확인하고, 아니면 소유권을 조정한다). `--project core`처럼 PG가 필요 없는 프로젝트만 고르면 Docker를 부르지 않는다.
- 시험 홈 fixture: `apps/cli/test`에 PG 홈 helper 하나(시험 DB 생성 → `prepareDatabase`·`runMigrations`·필요하면 `ensureSelfUser` → `config.toml`(`url_env`) 쓰기 → 하위 프로세스에 넘길 env `BRAIN_DATABASE_URL=<app URL>` → 정리 때 DB drop)를 두고 시험 파일이 함께 쓴다. 비밀번호는 `tooling/test-db`의 시험 값(`brain-test-app`·`brain-test-maintenance`)을 쓴다. `tooling/test-db`는 제품 PG adapter를 import하지 않는다(준비 함수는 호출자가 넘기거나 helper가 `second_brain/postgres`에서 가져온다).
- 실제 머신 상태 비의존: doctor·setup·uninstall처럼 OrbStack·container 검사를 거치는 시험은 in-process(`dispatch`의 `runner` seam, `runInstall`/`runInstallerWithFlags`의 runner·secrets·databaseName seam, `packages/postgres/test/install-orbstack.test.ts` 선례)로 가짜 runner를 주입한다. 하위 프로세스로 띄우는 시험은 그 결과가 이 Mac의 컨테이너 상태에 따라 달라지면 안 된다.
- SQLite 고유 단언의 이전: `schema_version` 표 → `brain.schema_migrations`(소유자별), `?` → PG 매개변수, `sqlite_schema` → PG catalog, FTS `MATCH` → 해당 열의 `lower(col) LIKE`, `BEGIN IMMEDIATE` 잠금 보유자 → PG 행·표 잠금 보유자(`lock_timeout` → `DB_LOCKED`), SQLite trigger 고장 주입 → 시험 DB의 PG trigger·함수, DB 파일 바이트 불변 → 행 값 불변. DB 파일 권한·WAL·SHM·파일 위치처럼 PG에 의미가 없는 case는 지운다. 시험이 지키던 계약(멱등, 원문 불변, 가리기, spool, 예산, 출력 마스킹)은 PG 시험으로 남아야 한다.
- 공통 계약: `packages/core/src/testing/contracts/`의 DB 저장소 계약(store·schema·session 세 부분·user·work·transcript-file·attachment·extraction·file-redaction·schedule·settings)이 모두 PG 시험에서 실행되는지 확인하고, PG 쪽에서 aggregate `sessionStoreContract` 하나로 묶어 부르는 연결을 더한다(지금은 세 부분을 따로 부름). 비DB 계약(parser·connector·spool·fileStore·clock·idGen·embedder·reranker)은 바꾸지 않는다.
- baseline 고정: `packages/postgres/test/`에 `0001_initial.sql`의 sha256(`migrate.ts`와 같은 계산: UTF-8 문자열 → `createHash('sha256')`)이 상수와 같음을 확인하는 시험을 두고, 상수 옆 주석과 `migrate.ts`의 문서 주석에 "적용된 baseline은 바꾸지 않는다. 바꿀 것은 `0002_*.sql`로"를 적는다. 상수는 이 티켓의 최종 파일 값이다.
- `tooling/bootstrap/test/hook.test.ts`: 실제 bootstrap → 설치기가 이 시험의 임시 홈에 실제 OrbStack compose(홈 접미사로 운영 자원과 분리)를 올리고, 단언은 그 홈 `.env`의 URL로 PG를 읽는다. `afterAll`이 `setup uninstall --delete-volume --yes`(또는 같은 효과의 compose down -v)로 컨테이너·볼륨을 지운다. 기본 홈의 compose project·볼륨·포트는 생기지 않는다.
- 사용자 출력 문장은 한국어다(`assertKoreanLine`). README의 `--store-path`·`store.path`·선택자 기본값 설명은 이 티켓의 동작에 맞춘다.

**Never:**
- `packages/sqlite`(패키지·소스·자체 시험), `packages/second_brain`의 SQLite 재export·의존성, `boundaries.test.ts`의 SQLite 항목, README의 SQLite 일반 설명, pgvector 의존을 지우지 않는다(티켓 11).
- baseline 0001의 내용을 바꾸지 않는다(고정만 한다). 마이그레이션 실행기·`CORE_SCHEMA_VERSION`·spool 형식·오류 코드 의미를 바꾸지 않는다. 새 오류 코드를 만들지 않는다.
- 하위 프로세스 시험을 위해 설치기에 compose를 건너뛰는 env·플래그 같은 새 제품 seam을 더하지 않는다.
- `plugin/app-ref`·plugin version을 바꾸지 않는다(티켓 13). DW-11(정리 handler·정리 role 조립)은 하지 않는다.
- 옛 `brain.db`를 지우거나 옮기지 않는다. 볼륨을 동의 없이 지우지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 새 홈 setup | `config.toml` 없음, OrbStack 정상(가짜 runner) | PG 흐름 완료, `config.toml`에 `url_env = "BRAIN_DATABASE_URL"`이 있고 `store.path` 없음, `brain.db` 생기지 않음, `postgres.legacy_sqlite_path: null` | 없음 |
| 옛 SQLite 홈 setup | `config.toml`에 `schema_version`·`[store] path=<p>`만, `<p>`에 파일 | PG 흐름 완료, 안내 한 줄, `legacy_sqlite_path: <p>`, 파일 그대로, 다시 쓴 `config.toml`에 `store.path` 없음 | 없음 |
| `--store-path` | `setup run --store-path /x` | `USAGE` | 기존 규칙 |
| 선택자 없는 홈의 명령 | `[store]` 없음, env에 `BRAIN_DATABASE_URL`=시험 DB | 명령이 PG를 읽고 씀, SQLite 파일을 열거나 만들지 않음 | 없음 |
| URL 없음 | 선택자 기본, env·`.env`에 값 없음 | 명령 `DB_UNAVAILABLE`, hook exit 0·spool, 데몬 compose 호출 0 | 기존 |
| 옛 `store.path` 값이 상대 경로 | `[store] path = "rel"` | 설정 읽기 성공(검증하지 않음) | 없음 |
| `config set` | 선택자 없는 홈 | 설정이 PG에 저장됨(SQLite 거절 없음) | 기존 검증 |
| doctor | 선택자 없는 홈, 가짜 runner | `orbstack`·`container`·`db`·probe·`schema-version` 행, SQLite 파일 행 없음 | 기존 |
| build 기록 | `pnpm build` | `build.json`의 `schema_version`이 PG core 버전과 같음 | 없음 |

</intent-contract>

## Code Map

- `apps/cli/src/config/codec.ts` -- `readConfig`(`:194` 선택자, `:202` `store.path` 읽기, `:222` 결과), `KNOWN_KEYS`(`:29`), unknown-key 보존(`:384`), `writeConfig`(`:526`, `:567`, `:570`), `resolveStoreUrl`(`:765`), `defaultStorePath`. 기본 선택자 상수와 옛 경로 후보를 여기 둔다. `storeUrlEnv`는 결과에서 항상 채워진다(선택 필드가 아니게).
- `apps/cli/src/runtime/brain-store.ts` -- `openBrainStore`. SQLite 분기·`createSqliteStore`·`SQLITE_SCHEMA_VERSION` import 제거.
- `apps/cli/src/dispatch.ts` -- `:349` `CreateStore`/`DispatchRuntime`, `:441` 기본 `sqliteStore`, `:571` 명령 factory 호출, `:576` `config get/set` SQLite 거절, `:748` 기회적 drain(경로 `drain`·예산 `DRAIN_BUDGET_MS.opportunistic` 유지), `:532` help(PG 미로딩 유지), `:553` standalone 경계.
- `apps/cli/src/daemon/run.ts` -- `:96` `createStore ?? sqliteStore`, `:185`, `:312-339` 재연결 자격(URL 해석 성공 + PG `DB_UNAVAILABLE`; 기본 선택자에서도 그대로).
- `apps/cli/src/assembly.ts:41`, `:78` -- `kind` 판별 제거, 선행 검사·probe 기본.
- `apps/cli/src/install.ts:164`, `:194` -- `systemInstallDeps`의 SQLite `store` 의존 제거, PG `withBrain`만.
- `apps/cli/src/install/flow.ts` -- `:411` PG 판별(`recorded?.storeUrlEnv !== undefined`)을 항상 PG로, `:423`·`:841` `chooseStorePath`·legacy 경로, `:473`·`:507`·`:540` SQLite 준비, `:549` PG 설치, `:554` legacy 안내, `:560` 시간대, `:628` doctor, `:706` 완료 기록 `schema_version`, `:720` 보고, `:751`·`:1113`·`:1176` 플래그 parser·재시도·도움말.
- `apps/cli/src/install/store.ts` -- SQLite 부분(`:118`, `:151`, `:220`, `:292`, collision `:5`, `:101`) 삭제, `prepareFilesRoot` 보존.
- `apps/cli/src/commands/setup-run.ts:66`, `:85`, `:116` -- `--store-path` 등록·전달·설명 제거. `commands/setup-uninstall.ts`는 compose 파일 기준 그대로.
- `apps/cli/src/doctor/checks.ts:137` -- `config-timezone`. `apps/cli/src/doctor/store.ts:26` `failedConfigStore`(SettingsStore 포함).
- `apps/cli/scripts/write-build-info.mjs:45`, `apps/cli/src/install/installed.ts:87` -- 빌드·완료 기록 scalar.
- `packages/postgres/src/migrate.ts:24` -- checksum 계산(재사용, 바꾸지 않음). 지금 sha256(참고): `0cb16e9adb7fccf75eb08ed84533da7ce37e3ecb1c9a1ca8858d97f9af37c005`.
- `tooling/test-db/src/global-setup.ts`(`BRAIN_TEST_DATABASE_URL`, 이미 떠 있으면 재사용, 자신이 올렸을 때만 down), `tooling/test-db/src/index.ts:76`(`createTestDatabase`, `:89` 시험 비밀번호), `packages/postgres/test/fixture.ts:4`(준비 선례), `packages/postgres/test/global-setup.ts`, 루트 `vitest.config.ts:17`(프로젝트별 global setup 자동 탐지).
- `packages/core/src/testing/contracts/index.ts`, `session-store.ts:1347`(aggregate), PG 연결: `packages/postgres/test/store.test.ts:10`, `work-store.test.ts:17`, `attachment-extraction.test.ts:11`, `settings.test.ts:6`.
- 이전할 `apps/cli/test` 파일(DB fixture·직접 SQL): `dispatch.test.ts`(약 68), `sessions-ingest.test.ts`(65), `capture-scan.test.ts`(17), `daemon-run.test.ts`(44), `doctor-run.test.ts`(17), `install.test.ts`(13), `setup.test.ts`(34), `queue-drain.test.ts`(9), `files-redact.test.ts`(5), `messages-redact.test.ts`(3), `output-codecs.test.ts`(21), `daemon-status.test.ts`(2), `daemon-stop-start.test.ts`(1), `fixtures/lock-holder.mjs`. 맞출 파일: `brain-store.test.ts`, `config.test.ts`, `install-flow.test.ts`(약 100, fake store), `setup-run.test.ts`, `doctor-checks.test.ts`, `envelope.test.ts`(`--store-path` 재시도), `installed-schema.test.ts`, `setup-uninstall.test.ts`. `install-store.test.ts`는 SQLite case를 지우고 `prepareFilesRoot` case만 남긴다.
- `packages/postgres/test/cli.test.ts:23-162` -- SQLite setup 뒤 선택자 바꾸기·SQLite 세션 0 단언을 PG 홈 준비로. `install-orbstack.test.ts` -- "SQLite 홈은 OrbStack을 부르지 않음" case를 선택자 없는 홈 = PG 흐름 case로.
- `packages/second_brain/test/import-side-effects.test.ts` -- `root does not load pg`·`help does not load pg` 유지. `hook does not load pg`(지금 SQLite 홈 전제)는 "preflight에서 거절되는 hook은 PG를 로드하지 않음"과 "정상 hook은 PG에 쓰고, URL이 없어도 exit 0·spool"로 바꾼다. SQLite `lsof` case(`:84`)는 "CLI 모듈 import만으로 PG 연결을 열지 않음"(시험 안 TCP listener 연결 수 0) 같은 PG 의미로 바꾸거나, 의미가 없으면 지운다.
- `tooling/bootstrap/test/hook.test.ts:182`, `:301` -- SQLite 읽기를 PG 읽기로, 정리 추가. `tooling/bootstrap/package.json` devDependency(`@second-brain/test-db` 또는 `pg`). bootstrap 소스는 DB를 읽지 않으므로 바꿀 필요가 없다. 바꾸면 `bin/second-brain.js`·`plugin/bootstrap.mjs`를 build로 동기화한다.
- `tooling/dev/pg-tracer.sh:30` -- `url_env` 사전 기록 제거, setup 뒤 `config.toml`에 `url_env` 있음·`store.path` 없음·`brain.db` 없음 단언 추가.
- `README.md` -- setup 플래그·설정 키·선택자 기본값 설명. 오류 코드 표는 바뀌지 않는다(`apps/cli/test/readme-codes.test.ts`).

## Tasks & Acceptance

**Execution:**
- [x] `apps/cli/src/config/codec.ts`, `apps/cli/test/config.test.ts` -- 기본 선택자, `store.path` 제거·옛 후보, 다시 쓸 때 뺌 -- 모든 홈을 PG 홈으로
- [x] `apps/cli/src/runtime/brain-store.ts`, `dispatch.ts`, `daemon/run.ts`, `assembly.ts`, `install.ts`, `commands/*`, `doctor/*`, `scripts/write-build-info.mjs`, `install/installed.ts` 및 각 단위 시험(`brain-store.test.ts`, `installed-schema.test.ts`, `doctor-checks.test.ts`) -- PG 전용 조립, `config get/set` 거절 제거, 빌드 기록 scalar -- SQLite 선택 제거
- [x] `apps/cli/src/install/flow.ts`, `install/store.ts`, `commands/setup-run.ts`, `apps/cli/test/install-flow.test.ts`, `setup-run.test.ts`, `envelope.test.ts`, `install-store.test.ts` -- 항상 PG 설치 흐름, SQLite 단계·`--store-path`·SQLite 보고 삭제, `prepareFilesRoot` 보존 -- 설치 전환
- [x] `apps/cli/package.json`, `apps/cli/test/global-setup.ts`(새), `apps/cli/test/pg-home.ts`(새, 이름은 구현이 정함), `tooling/bootstrap/package.json`, `tooling/bootstrap/test/global-setup.ts`(새), 필요하면 `tooling/test-db/src/*` -- 시험 DB·PG 홈 fixture, 컨테이너 소유권 -- 시험 기반
- [x] 위 Code Map의 이전 대상 `apps/cli/test/*` 14개 파일과 `fixtures/lock-holder.mjs` -- DB fixture와 직접 SQL을 PG로, SQLite 고유 case 정리(Always의 이전 규칙) -- CLI 통합 시험 이전
- [x] `packages/postgres/test/cli.test.ts`, `install-orbstack.test.ts`, `store.test.ts`(aggregate session 계약 연결) -- PG 홈 준비, 선택자 없는 홈 case, 계약 연결 확인 -- PG 쪽 시험 정리
- [x] `packages/postgres/test/baseline-checksum.test.ts`(새, 시험 이름 `'pins the checksum of the applied core baseline 0001'`), `packages/postgres/src/migrate.ts` 주석 -- baseline 고정
- [x] `packages/second_brain/test/import-side-effects.test.ts` -- lazy loading 기대를 PG 전용에 맞춤
- [x] `tooling/bootstrap/test/hook.test.ts` -- 실제 compose 위 PG 단언과 정리
- [x] `tooling/dev/pg-tracer.sh`, `README.md` -- 빈 홈에서 시작, 새 단언, 문서

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 test`, then build·typecheck·전체 시험이 exit 0이고, 실행 로그에서 `apps/cli`·`tooling/bootstrap`·`postgres` 프로젝트 시험이 PG 시험 DB로 돌았다(시험 컨테이너는 한 번 올라감).
- Given 저장소, when `git grep -nE "sqliteStore|SqliteStoreOptions|SQLITE_SCHEMA_VERSION|runSqliteMigrations|openSqlite|@second-brain/sqlite|from 'node:sqlite'" -- apps/cli tooling/bootstrap/src tooling/bootstrap/test tooling/dev plugin packages/postgres`, then 출력이 없다.
- Given 저장소, when `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/baseline-checksum.test.ts`, then 통과하고, `0001_initial.sql`에 한 바이트를 더하면 같은 시험이 실패한다(구현이 확인하고 되돌린다).
- Given OrbStack이 켜진 이 Mac, when `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume`, then exit 0이고, `url_env`를 미리 쓰지 않은 빈 개발 홈에서 setup → hook 수집 → doctor(`orbstack`·`container`·`db`·`writable`·`pg_trgm`·`schema-version` ok) → 데몬 drain이 PG로 돌며, 그 홈에 `brain.db`가 없고 `config.toml`에 `store.path`가 없다.

## Implementation Notes

- 모든 설정 홈을 PG로 조립하도록 전환했다. 선택자는 config codec의 `DEFAULT_STORE_URL_ENV`에서 기본값을 받고, 옛 `store.path`는 검증·실행·재기록하지 않고 안내 후보로만 읽는다. 설치의 SQLite 준비·충돌 합치기·파일 doctor와 `--store-path`를 제거했다.
- `openBrainStore`는 동적 PG import와 PG 연결 옵션 시험 seam만 가진다. 설정 실패 Store는 SettingsStore까지 `DB_UNAVAILABLE`을 돌려준다. 명령·기회적 drain·데몬·doctor·설치가 같은 PG 흐름을 쓴다.
- CLI의 공통 PG 홈 fixture와 비동기 PG 검사 client를 추가했다. 파일 DB·SQLite SQL fixture를 격리 PG DB로 옮겼고, 파일 권한·WAL 등 SQLite 고유 case는 없앴다. 설치의 일반 계약은 `install-contracts.test.ts`(60개)와 `setup-connect.test.ts`에 보존했다. 동의 전 무변경·원문/행 보존·가리기·spool·예산·출력 마스킹·커넥터/데몬 실패·완료 기록 계약을 PG에서도 검증한다.
- CLI·bootstrap에 프로젝트별 global setup을 추가했다. 설치된 Vitest 5의 `initializeGlobalSetup`은 선택 프로젝트를 순차 초기화하고, 종료는 전체 `runningPromise` 뒤에 역순 global teardown을 수행한다. 앞 setup이 설정한 `BRAIN_TEST_DATABASE_URL`을 뒤 setup이 재사용하므로 기존 `setupTestDatabase`의 소유권 처리를 바꾸지 않았다. PG 없는 프로젝트에는 global setup을 붙이지 않았다.
- baseline 0001을 바꾸지 않고 SHA-256을 고정했다. aggregate `sessionStoreContract`를 PG suite에 연결했고 다른 DB 계약도 유지했다. 실제 bootstrap과 tracer는 임시 홈 전용 compose 자원을 사용하고 teardown으로 컨테이너·볼륨·네트워크를 정리한다.

### 오케스트레이터 기록

- 구현 세션(codex thread `01a18379-4017-79b2-b10a-ee5f3ae37a16`)이 커밋 `c9708f3`으로 구현했다. 구현 세션이 frontmatter를 `status: built`·`review: quick`·`lenses_ran: [quick]`로 바꾸고 아래 Review Triage Log에 자체 점검 두 줄을 남겼다. 이 점검은 step-04 리뷰가 아니므로 오케스트레이터가 frontmatter를 되돌렸고, 두 줄은 append-only 규칙에 따라 남긴다.
- step-03 검증: `npx --yes pnpm@12 test` exit 0(127개 파일, 3,070개 시험), AC의 `git grep` 출력 없음, `git diff --check` 통과, baseline 0001에 한 바이트를 더하면 `baseline-checksum.test.ts`가 실패하고 되돌리면 통과, `sh tooling/dev/pg-tracer.sh --delete-volume` exit 0(빈 개발 홈, 기본 홈 자원 변화 없음), 시험 뒤 남은 compose 컨테이너·볼륨 없음.
- step-03 매트릭스 점검: "URL 없음"의 hook·데몬 부분, "doctor"(선택자 없는 홈), "build 기록" 행을 그 입력 상태로 확인하는 시험이 없었다. 구현 세션에 보내 `6a913bd`에서 시험 4개(`spools the hook with the default selector when neither process env nor .env supplies a URL`, `never starts compose with the default selector when neither process env nor .env supplies a URL`, `reports PG checks and no SQLite file checks when the store table is absent`, `records CORE_SCHEMA_VERSION in the actual built build.json`)를 더했고 관련 4개 파일 145개 시험이 통과했다. 나머지 행은 `install.test.ts`·`install-flow.test.ts`·`config.test.ts`·`dispatch.test.ts`·`packages/postgres/test/cli.test.ts`('reads and writes PG with the default selector when the store table is absent')가 덮는다.
- 시험 수 변화: 전체 3,220 → 3,070(+4). 크게 줄어든 파일은 `install-flow.test.ts`(97 → 14, 일반 계약은 새 `install-contracts.test.ts` 46·`setup-connect.test.ts` 10으로 옮김), `setup.test.ts`(32 → 1), `install.test.ts`(13 → 5), `config.test.ts`(39 → 13), `doctor-run.test.ts`(16 → 8), `install-store.test.ts`(21 → 4)다. SQLite 고유 case 삭제가 계획의 규칙이지만, 지키던 계약이 PG 시험으로 남았는지는 리뷰가 확인한다.

## Plan Change Log

## Review Triage Log

- `medium` → `patch`: CLI 수집·capture와 bootstrap 시험의 자식 환경이 `process.env.BRAIN_DATABASE_URL`을 상속한다. `resolveStoreUrl`은 process 값을 임시 홈 `.env`보다 먼저 읽으므로 외부 DB 접근 또는 빈 값에 의한 연결 실패가 실제로 가능하다. 시험 환경에서 상속값을 제거하고 의도한 개별 override만 유지한다.
- `medium` → `patch`: `capture-scan.test.ts`는 `preparePgHome`으로 DB를 만들지만 자체 `directories` 정리는 `rm`만 호출한다. `tempHomes().cleanup()`과 달리 `dropPgHome`이 없어 재사용 시험 서버에 DB가 남는다. 디렉터리 삭제 전에 해당 DB를 drop한다.

### 2026-10-29 — Review pass
- verdicts: 17 findings — high 0, medium 5, low 7, false 5, maybe-false 0
- findings:
  - `[low]` `[reject]` blind: setup이 홈 DB를 준비한 뒤 시간대·가져오기는 process env의 다른 `BRAIN_DATABASE_URL`을 따를 수 있다 — 실제다. 그러나 process env 우선은 티켓 1·8부터의 설계이고 plan Always가 그대로 두라고 정했으며 시험 fixture가 이 우선순위에 기댄다. 사용자의 셸에 같은 이름의 다른 URL이 있는 경우는 드물고, 막으려면 새 guard 분기가 필요하다.
  - `[medium]` `[reject]` blind: 옛 SQLite의 가리기 기록을 옮기지 않고 transcript를 다시 가져와 가린 내용이 PG에 다시 들어갈 수 있다 — 실제다. 그러나 에픽 결정(2026-10-28, 사용자)이 "기존 `brain.db`는 옮기지 않고 빈 DB에 transcript를 다시 가져온다"로 의도에서 배제했다. README 안내는 아래 patch로 더했고 잔여 위험에 적는다.
  - `[low]` `[patch]` blind: README의 전환 안내가 무엇이 옮겨지지 않는지 말하지 않는다 — `README.md` 옛 SQLite 안내 옆에 transcript만 다시 들어오고 가리기·꼬리표는 옮겨지지 않아 다시 가려야 한다는 문장을 더했다(`928e4cb`).
  - `[low]` `[reject]` blind: transcript 가져오기 예외가 `--json`의 `warnings`에 없다 — 티켓 8 코드를 그대로 옮긴 것이고(티켓 8 리뷰에서 같은 판정으로 기각) `postgres.import: null`로 기계 소비자가 구별할 수 있다. 구조화 경고는 새 공개 표면이다.
  - `[false]` `[reject]` blind: `installerDeps`가 DB를 미리 준비해 설치기가 초기화 단계를 빠뜨려도 통과한다 — `packages/postgres/test/install-orbstack.test.ts`의 'runs setup twice against one database with compose, roles and migrations once'가 마이그레이션 안 된 DB(`database(false)`)로 첫 setup의 `owner_created: true`와 doctor `schema-version` ok를 확인하므로 마이그레이션·"나" 생략은 잡힌다. role은 클러스터 전역이라 시험마다 새로 만들 수 없고 `packages/postgres/test/setup.test.ts`가 확인한다.
  - `[low]` `[reject]` blind: `tooling/bootstrap/test/global-setup.ts`가 bootstrap 시험이 쓰지 않는 공용 시험 PG를 올린다 — 실제로 `hook.test.ts`는 홈 `.env`의 compose DB만 읽는다. 그러나 hook E2E 자체가 Docker를 요구하고 전체 실행은 어차피 시험 컨테이너를 올리므로 추가로 생기는 실패는 54329 포트 충돌뿐이라 드물다. 지우면 plan Always의 명시 규칙과 어긋나 plan을 고쳐야 한다.
  - `[medium]` `[patch]` blind: 예약 선택자 `BRAIN_APP_PASSWORD`·`BRAIN_POSTGRES_PASSWORD` 거절과 `writeConfig`·`postgresSecrets`의 파일 보존 시험이 지워졌다 — 기준 커밋 시험을 지금 설정 모양으로 되살렸다(`928e4cb`, `apps/cli/test/config.test.ts`).
  - `[medium]` `[patch]` blind: 혼합 따옴표 `.env` 값 거절·두 파일 보존 시험이 지워졌다 — verification-gap의 같은 지적과 같은 원인. 실제 `writeConfig` 호출로 되살렸다(`928e4cb`).
  - `[medium]` `[patch]` blind: 설정이 없거나 깨진 홈의 `doctor run` 명령 수준 시험이 지워졌다 — 기준 커밋의 세 시험(exit 1과 `config`·`db` 실패 행, `CONFIG_INVALID`, 텍스트 출력)을 PG 가짜 runner로 되살렸다(`928e4cb`, `apps/cli/test/doctor-run.test.ts`).
  - `[low]` `[reject]` blind: `writable` 실패·잠금 경고의 명령 수준 시험이 사라졌다 — probe 결과의 상태 변환은 Core `runDoctor`(`packages/core/test/doctor.test.ts:166`, `:334`)가, PG probe의 25006·42501·잠금 결과는 `packages/postgres/test/store.test.ts`가 확인하고 CLI는 `writable` 전용 코드를 더하지 않는다. 명령 수준으로 되살리려면 PG 잠금 보유자·읽기 전용 role 배치가 필요하다.
  - `[low]` `[reject]` edge: 새 홈 setup에서 `BRAIN_DATABASE_URL`이 다른 DB를 가리키면 설정·가져오기가 그쪽에 쓴다 — blind 첫 지적과 같은 원인·같은 근거로 기각.
  - `[low]` `[patch]` verification-gap: 빈 `SECOND_BRAIN_HOME`을 무시하는 `configHome` 시험이 지워졌다 — 기준 커밋의 `describe('configHome', …)` 세 시험을 되살렸다(`928e4cb`).
  - `[medium]` `[patch]` verification-gap: 표현할 수 없는 `.env` 값 거절 시험이 지워졌다 — blind의 같은 지적과 묶어 되살렸다(`928e4cb`).
  - `[false]` `[reject]` intent: `second_brain`의 SQLite 재export·의존성이 남아 "SQLite를 쓰지 않는 조립"과 다르다 — 에픽 티켓 구성이 재export·`packages/sqlite` 삭제를 티켓 11에 두었고, 런타임 코드는 SQLite symbol을 참조하지 않는다(AC의 `git grep` 출력 없음). Design Notes에 경계를 적었다.
  - `[false]` `[reject]` intent: `packages/sqlite/test`와 memory 계약 시험이 남아 "Store 시험은 모두 PG"와 다르다 — SQLite adapter 자체 시험의 삭제는 티켓 11이고, memory fake는 Store adapter 시험이 아니다. DB 공통 계약은 모두 PG에서 돈다.
  - `[false]` `[reject]` intent: setup·doctor 시험이 가짜 runner와 미리 준비한 DB를 쓴다 — blind의 `installerDeps` 지적과 같은 근거이고, 실제 OrbStack 경로는 `tooling/bootstrap/test/hook.test.ts`와 `tooling/dev/pg-tracer.sh`가 맡는다(plan Design Notes).
  - `[false]` `[reject]` intent: 개발 홈의 실제 실행 성공이 확인되지 않았다 — 오케스트레이터가 step-03과 patch 뒤에 `sh tooling/dev/pg-tracer.sh --delete-volume`를 실제 OrbStack에서 두 번 돌려 exit 0을 확인했다(빈 개발 홈 setup → hook → doctor → 데몬 drain).

### 2026-10-29 — 후속 Review pass

- verdicts: 22 findings — high 0, medium 7, low 5, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` intent: 루트 dependency·재export에 SQLite가 남는다 — carried: 기존 판정과 동일하다. 런타임 factory는 PG만 열며 패키지·재export 삭제는 에픽의 다음 티켓 범위다.
  - `[false]` `[reject]` intent: SQLite Store 자체 시험이 남아 배타적 PG 시험과 다르다 — carried: 기존 판정과 동일하다. 공통 계약은 PG에서 실행되며 SQLite adapter 자체 삭제는 다음 티켓에 배정되어 있다.
  - `[false]` `[reject]` intent: `store.path`를 legacy 입력으로 여전히 읽는다 — 값은 파일 보존 안내 후보일 뿐 실행 설정·writer 결과·플래그에서 제거됐다. 기존 파일을 보존한다는 의도와 맞는다.
  - `[false]` `[reject]` intent: 명령 fixture가 설치 대신 `preparePgHome`을 쓴다 — 실제 PG 행을 읽고 쓰는 명령 계약을 검증한다. 각 명령 fixture가 설치 전체를 다시 수행해야 한다는 요구는 없으며 실제 설치는 bootstrap·tracer가 검증한다.
  - `[false]` `[reject]` intent: 새 홈 설치 시험의 사전 준비·가짜 runner만으로 초기 설치를 입증하지 못한다 — carried: 기존 `installerDeps` 판정과 동일하다. `install-orbstack.test.ts`는 마이그레이션 전 DB를 쓰며 실제 OrbStack 설치는 hook E2E·tracer가 맡는다.
  - `[false]` `[reject]` intent: 임시 개발 홈 검증 코드와 실행 성공 증거는 다르다 — carried: 이번에도 `pg-tracer.sh --delete-volume`을 직접 실행해 setup·수집·doctor·spool·데몬 drain 성공과 정리를 확인했다. 빈 임시 홈은 티켓이 요구한 개발 홈이다.
  - `[false]` `[reject]` intent: 불가능한 timestamp 시험이 손상 행 읽기에서 잘못된 SQL 쓰기 거절로 바뀌었다 — PG timestamp 열이 그 값을 저장하지 못하므로 옛 손상 상태를 만들 수 없다. 실제 SQL 거절과 기존 행 보존을 확인하는 현재 시험이 PG 경계에 맞는다.
  - `[false]` `[reject]` intent: 설치 시험이 가짜 의존성 기반으로 이동해 종전 통합 시험과 증명 범위가 다르다 — 차이 자체는 사실이나 모든 계약 소실을 뜻하지 않는다. 실제 PG·bootstrap·tracer가 통합 경계를 덮으며 구체적으로 확인한 누락은 아래 개별 patch로 복원했다.
  - `[low]` `[reject]` blind: process env URL과 설치가 준비한 홈 DB가 다를 수 있다 — carried: 동일 위치·동일 주장으로 기존 판정을 유지한다. URL 우선순위는 기존 설계이며 새 가드를 넣어야 하는 드문 환경 충돌이다.
  - `[false]` `[reject]` blind: SQLite 가리기·꼬리표 비이전 설명을 설치 화면에도 넣어야 한다 — 기존 파일 비이전은 명시된 에픽 결정이며 README가 재수집 시 원문 재등장까지 안내한다. 설치 화면 추가 안내가 없어서 현재 요구를 위반한다는 근거는 없다.
  - `[low]` `[reject]` blind: `dropPgHome`이 삭제 실패 전에 registry에서 항목을 빼 재시도 참조를 잃는다 — 실제다. `drop()`은 FORCE 삭제이며 실패를 숨기지 않는다. DB 정리 자체가 실패한 드문 상황의 재시도 상태 관리를 추가하는 복잡도에 비해 일상 영향이 작아 수정하지 않는다.
  - `[false]` `[reject]` blind: `pgRunner`가 모르는 명령도 성공으로 돌려 잘못된 외부 호출을 놓칠 수 있다 — 실제 제품의 잘못된 호출이나 그로 인한 통과 사례가 제시되지 않았다. 일반 fixture는 머신 상태를 고정하며 명령 조립은 별도 runner·설치 시험과 실제 hook·tracer가 검증한다. 미래 변경 가능성만으로 현재 결함이라고 판정하지 않는다.
  - `[medium]` `[patch]` blind: setup JSON 동의·재시도·단일 응답의 실제 명령 시험이 사라졌다 — `setup.test.ts`에서 실제 `dispatch`와 기존 설치 의존성 주입으로 exit 3·`CONFIRMATION_REQUIRED`·인자 보존·재실행 성공·한 줄 JSON을 복원했다.
  - `[low]` `[reject]` blind: doctor 쓰기 불가·잠금 경합의 CLI 수준 시험이 사라졌다 — carried: 기존 판정과 동일하다. Core doctor 상태 변환·PG probe 오류 시험이 남으며 CLI는 별도 변환을 하지 않는다. 추가 role·잠금 배치 복잡도에 비해 영향이 작다.
  - `[medium]` `[patch]` blind: transcript 재주입 `spoolFailed` 부분 실패 안내 시험이 사라졌다 — `install-flow.test.ts`에서 `spoolFailed: 1`, `failed: 0`, `stopped: empty`의 경고와 성공 안내 부재를 복원했다. 아래 verification-gap과 같은 원인이다.
  - `[medium]` `[patch]` blind: `update.auto`의 일반 명령 거절·기본값·양방향 왕복 시험이 사라졌다 — `config.test.ts`에 실제 codec을 쓰는 세 시험을 복원했다.
  - `[medium]` `[patch]` blind: doctor spool 시험이 행 존재만 확인한다 — `doctor-run.test.ts`에서 `warn`·`SPOOLED`·`1건`과 건강한 PG 검사 유지·exit 0을 직접 단언하도록 고쳤다.
  - `[low]` `[patch]` blind: DB unavailable 시험이 로컬 파일 미생성을 단언하지 않는다 — 같은 시험에서 `brain.db`·WAL·SHM 파일 부재를 직접 확인하도록 고쳤다.
  - `[medium]` `[patch]` verification-gap: 시간대 설정 실패 뒤 중단 시험이 사라졌다 — 사전 검증된 공백이다. `settings.get`의 `DB_LOCKED`·`settings.set`의 `DB_UNAVAILABLE` 전파와 config·완료 기록 미작성을 복원했다.
  - `[medium]` `[patch]` verification-gap: 잘못된 TTY 시간대 입력의 재질문·정규화 시험이 사라졌다 — 사전 검증된 공백이다. 잘못된 두 입력 뒤 `america/new_york` 정상화와 세 번 실패 시 중단·후속 미작성을 복원했다.
  - `[medium]` `[patch]` verification-gap: transcript 재주입 부분 실패 경고 시험이 사라졌다 — 사전 검증된 공백이다. blind의 동일 원인과 묶어 경고 출력·성공 안내 부재를 복원했다.
  - `[low]` `[patch]` verification-gap: 부분 설정 복구 시험이 폐기된 `store.path` 검증을 인위적으로 주입한다 — 사전 검증된 공백이다. 실제 codec에 상대 `files.path`를 주고 기본값 복구와 mirror·timezone 보존을 확인하도록 바꿨다.

## Design Notes

**티켓 11과의 경계(추천으로 정함, 2026-10-29):** 이 티켓의 "SQLite를 쓰지 않는 조립"은 런타임 코드(`apps/cli`·`tooling/bootstrap`)가 SQLite를 고르거나 열거나 그 symbol을 참조하지 않는 것이다. 루트 `second_brain`이 아직 `@second-brain/sqlite`를 재export하므로 모듈 자체는 import 그래프에 남지만, 그 재export·`packages/sqlite`·자체 시험의 삭제는 티켓 11의 범위다. "Store 시험은 모두 PG"는 공통 계약과 CLI·bootstrap·PG 통합 시험을 뜻하고, 티켓 11이 지울 `packages/sqlite/test`는 그때까지 남는다. 선택을 없애면 도달할 수 없게 되는 `apps/cli/src`의 SQLite 설치·doctor 코드는 죽은 코드로 남기지 않고 여기서 지운다(티켓 11의 "SQLite 전용 doctor·설치 단계" 삭제를 앞당김. 11의 verify는 그대로 성립한다).

**선택자 기본값:** E11-2가 `[store] url_env`(기본 `BRAIN_DATABASE_URL`)라고 정했다. 기본값을 두면 옛 SQLite 홈도 설정을 고치지 않고 PG 홈이 되고, 플러그인 갱신(bootstrap → 같은 설치기)이 PG 설치를 돌린다. setup은 값을 명시해 써서 파일만 봐도 어디를 쓰는지 알 수 있게 한다.

**시험 fixture를 setup 대신 helper로 만드는 이유:** 설치기는 홈에서 compose project·포트를 파생해 실제 컨테이너를 올린다. 일반 명령 시험이 그 경로를 타면 시험마다 컨테이너가 생긴다. setup 자체가 주제인 시험만 in-process로 가짜 runner와 시험 DB seam을 쓰고, 나머지는 helper가 시험 DB에 준비한 홈을 쓴다. 전 경로 E2E는 bootstrap hook 시험과 `pg-tracer.sh`가 실제 OrbStack에서 맡는다.

## Verification

**Commands:**
- `npx --yes pnpm@12 build && npx --yes pnpm@12 typecheck` -- expected: 통과
- `npx --yes pnpm@12 exec vitest run --project cli` -- expected: 통과(PG 시험 DB 사용)
- `npx --yes pnpm@12 exec vitest run --project postgres` -- expected: 통과
- `npx --yes pnpm@12 exec vitest run --project bootstrap` -- expected: 통과(hook E2E의 컨테이너·볼륨이 남지 않음)
- `npx --yes pnpm@12 test` -- expected: 전체 통과
- `sh tooling/dev/pg-tracer.sh --delete-volume` -- expected: exit 0
- 위 AC의 `git grep` -- expected: 출력 없음
- `git diff --check` -- expected: 출력 없음
- 끝난 뒤 `docker ps -a --format '{{.Names}}'`·`docker volume ls` -- expected: 시험이 만든 compose project의 컨테이너·볼륨이 없음

### 실제 검증 결과 (2026-10-29)

- `npx --yes pnpm@12 test`: build·typecheck·126개 시험 파일, 3066개 시험 통과. CLI·bootstrap·postgres 프로젝트를 포함했다.
- 별도 CLI 실행: 44개 파일, 964개 시험 통과. 별도 postgres 실행: 18개 파일, 291개 시험 통과. 별도 bootstrap 실행: 4개 파일, 131개 시험 통과. 마지막 config·설치 계약·retry 변경 파일 검증: 4개 파일, 119개 시험 통과.
- `sh tooling/dev/pg-tracer.sh --delete-volume`: 빈 홈 setup, hook 수집, 컨테이너 재생성 후 ID·시각·본문/시간대 보존, DB 중단 spool, 복구 drain, 데몬 compose 재연결까지 exit 0. 기본 홈 자원 변화 없음.
- baseline checksum 시험은 통과했고, 0001에 한 바이트를 더했을 때 exit 1을 확인한 뒤 원본 바이트로 복원했다. 이후 전체 시험도 통과했다.
- AC의 SQLite symbol 검색과 `git diff --check`: 출력 없음. `plugin/app-ref`·plugin version·SQLite 패키지·루트 재export·baseline 내용은 바꾸지 않았다.
- 시험 시작 전부터 있던 test PostgreSQL 컨테이너와 기존 볼륨은 보존했다. 실제 compose 시험 뒤 생성 자원은 남지 않았고, 최종 Docker 목록은 시작 전 자원과 같았다. 기존 시험 서버를 재사용했으므로 이번 실행은 해당 서버를 다시 띄우거나 내리지 않았다.

### 리뷰 수정 후 최종 검증

- Quick 리뷰의 두 지적을 수정했다. CLI·bootstrap 시험 환경은 상속된 `BRAIN_DATABASE_URL`을 제거하고, 의도한 개별 override만 나중에 적용한다. capture 시험은 디렉터리를 지우기 전에 등록된 PG DB를 drop한다. 빈 값·비어 있지 않은 상속값 회귀 시험을 추가했다.
- 수정 후 `npx --yes pnpm@12 test`: build·typecheck 및 127개 파일, 3070개 시험 통과(exit 0). `sh tooling/dev/pg-tracer.sh --delete-volume`도 다시 exit 0이며 기본 홈 자원 변화 없음·임시 자원 삭제를 확인했다.
- `--project core` 단독 실행은 32개 파일, 1112개 시험 통과했다. core에는 PG global setup이 등록되지 않는다.
- I/O matrix 대조: 새 홈·legacy 파일 보존·제거된 플래그는 `install.test.ts`/`install-flow.test.ts`, 기본 선택자의 명령·설정 쓰기는 PG `cli.test.ts`, URL 부재의 명령·hook·데몬은 `dispatch.test.ts`/`import-side-effects.test.ts`/`daemon-run.test.ts`, 상대 legacy 경로는 `config.test.ts`, PG doctor 행은 `doctor-run.test.ts`, 빌드 scalar는 `installed-schema.test.ts`와 실제 설치 시험으로 확인했다. 모두 최종 전체 실행에 포함되어 통과했다.
- 리뷰 수정의 집중 실행 중 수집 시험 하나의 본문은 통과했지만 `afterEach` DB 정리가 한 차례 60초 timeout이었다. 단독 재실행과 최종 전체 실행은 통과했고, 남은 client 연결은 없었다. 원인은 확정하지 못했다.
- 앞선 capture 실행에서 남긴 것으로 transcript 경로가 입증한 DB 74개와 timeout 시험의 DB 1개를 정리했다. 출처를 확인하지 못한 공유 시험 서버 DB 41개는 보존했다. 최종 전체 실행 뒤 DB 이름 집합이 이 보존 기준과 정확히 같아 추가 잔여 DB가 없었다. 컨테이너·볼륨 목록도 시작 전과 같다.
- 마지막 `git diff --check`와 금지된 SQLite symbol 검색은 출력이 없다. baseline SQL·plugin ref/version·SQLite 패키지와 재export는 변경하지 않았다. 미완료 구현이나 추가로 미룬 리뷰 항목은 없다.

## Auto Run Result

**상태:** `built`로 hand-back한다. 시작 시 계획의 `status: built`를 그대로 보존했고 티켓 완료 처리·`tickets.py mark`는 실행하지 않았다. 기존 deferred-work ledger와 계획의 기존 `deferred: []`를 수정하지 않았다. 사람이 결정해야 할 차단 조건은 없다.

**구현 요약:** 기존 PG 전용 런타임·설치·hook·데몬 조립, 기본 선택자, `store.path` 제거, PG 통합 fixture·계약 연결과 baseline checksum 고정을 후속 thorough 리뷰했다. 이번 수정은 누락된 회귀 시험 복원과 기존 시험 단언 보강이며 제품 소스·baseline·plugin ref/version은 바꾸지 않았다.

**이번에 바뀐 파일:**
- `apps/cli/test/setup.test.ts` — 실제 dispatcher 경유 동의 거절, 재시도 argv 보존·재실행과 단일 JSON 성공 응답.
- `apps/cli/test/install-flow.test.ts` — settings 읽기·쓰기 오류 전파와 후속 쓰기 중단, TTY 시간대 재입력·정규화·반복 실패, transcript 부분 실패 경고.
- `apps/cli/test/config.test.ts` — `update.auto` 기본값·비불리언 거절·true/false 왕복.
- `apps/cli/test/doctor-run.test.ts` — spool 상태·건수·건강한 DB 검사 유지, SQLite 파일·sidecar 미생성.
- `apps/cli/test/install-contracts.test.ts` — 실제 codec을 사용하는 `files.path` 복구와 나머지 값 보존.
- 이 계획 — 후속 리뷰의 항목별 판정·근거와 실행 결과. 기존 판정은 보존했다.

**후속 리뷰:** 렌즈 4개 모두 실행했다. edge-case는 지적 0건, 나머지는 총 22건으로 판정했다(medium 7, low 5, false 10). patch 9행은 중복 원인 하나를 묶어 8개 항목으로 수정했다(medium 6, low 2). 새 defer는 0건이다. reject 13행은 기존 범위·설계 판정 유지, 실제 PG에서 도달할 수 없는 손상 상태, 실제 E2E·tracer의 통합 증거, 요구 위반이 입증되지 않은 개선 제안, 드문 정리 실패 재시도 관리의 복잡도에 따른 기각이다. 각 항목의 구체적인 근거는 후속 Review Triage Log에 남겼다.

**후속 리뷰 권고:** `false`. `built` 계획의 follow-up pass이며 이번 patch의 high는 0개다. medium patch 개수만으로 재검토를 권고하지 않는다. 이전에 남긴 설치 시험 축소 위험을 이번 렌즈들이 다시 확인했고 구체적으로 확인한 공백은 복원했다.

**검증:**
- 수정 전 `npx --yes pnpm@12 test`: build·typecheck 포함 127개 파일, 3,088개 시험 통과.
- 수정 파일 집중 시험: 5개 파일, 139개 시험 통과.
- 수정 뒤 `npx --yes pnpm@12 test`: build·typecheck 포함 127개 파일, 3,097개 시험 통과(exit 0).
- 수정 뒤 개별 프로젝트: CLI 45개 파일·995개 시험, PostgreSQL 18개 파일·291개 시험, bootstrap 4개 파일·131개 시험 모두 통과(exit 0).
- `sh tooling/dev/pg-tracer.sh --delete-volume`: 이번 실행에서 수정 전후 두 번 모두 exit 0. 빈 홈 setup → hook 수집 → PG doctor → 컨테이너 재생성 후 ID·시각·본문·시간대 보존 → DB 중단 spool·복구 drain → 데몬 compose 재연결을 확인했다. 기본 홈 자원 변화 없음·임시 홈과 컨테이너·명시한 볼륨 삭제를 확인했다.
- baseline 고정 시험은 전체·PostgreSQL 개별 실행에 포함되어 통과했다. baseline 파일 자체는 변경하지 않았다.
- 금지된 SQLite symbol 검색 결과 없음, `git diff --check` 통과. Docker 컨테이너·볼륨 목록은 실행 전과 같으며 이미 떠 있던 공용 시험 서버를 보존했다.

**잔여 위험:** 에픽 결정에 따라 옛 SQLite의 가리기·꼬리표는 옮겨지지 않으며 transcript 재수집으로 가린 원문이 다시 들어올 수 있다(README 안내). process env URL 우선순위는 기존 설계대로다. 시험 DB 삭제 자체가 실패하면 fixture가 재시도 참조를 잃는 드문 정리 실패 위험은 low로 기각했다. SQLite 패키지·재export 삭제와 배포는 이후 티켓 범위로 유지한다.
