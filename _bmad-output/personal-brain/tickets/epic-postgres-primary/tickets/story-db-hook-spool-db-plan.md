---
title: 'DB가 꺼졌을 때: hook은 막지 않고 spool에 남기고, DB가 돌아오면 들어간다'
type: 'feature'
ticket: '7'
created: '2026-10-28'
status: done
baseline_revision: '1552951543dd6c21411fb09e4fc0e12af73533ad'
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
deferred:
  - summary: >-
      PG 런타임 경로에 저장본 정리 handler(`tableCleanupHandler`)와 정리 role 접속이 아직 조립되지 않아, PG 홈의 drain이 `table_cleanup` 일감을 청구하지 않고 doctor가 정리 `warn`을 계속 보인다.
    evidence: |-
      `git grep` 결과 `apps/cli/src`에 `tableCleanupHandler`·`postgresTableMaintenance`·maintenance 접속 사용처가 없다. 티켓 5 plan(story-doctor-plan.md)의 인계는 런타임 조립이 handler를 등록하고 `postgresTableMaintenance`에 정리 URL을 주며, 설치(티켓 8)가 `prepareDatabase`에 `maintenancePassword`를 넘기고 `.env`에 정리 role 접속을 쓰라고 했다. 정리 URL을 담을 설정 키·`.env` 항목이 아직 없으므로(설치는 티켓 8) 이 변경만으로는 연결할 값이 없다. 이 변경 전에도 PG 홈에는 PG drain이 없어 정리가 돌지 않았으므로 기존 공백이다. 티켓 8이 정리 role 접속을 쓸 때 store factory(`apps/cli/src/runtime/brain-store.ts`)의 PG 분기와 데몬(티켓 9)이 이 handler를 함께 등록해야 한다.
    location: >-
      apps/cli/src/runtime/brain-store.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** PG 홈(`[store] url_env`가 있는 홈)에서 PG를 쓰는 것은 `sessions ingest`와 `config get/set`뿐이고, `queue drain`·`doctor run` 같은 나머지 명령은 SQLite 파일을 연다. 그래서 DB가 꺼졌을 때 spool에 남은 수집을 PG로 되넣을 길이 없다. 기대 스키마 버전은 정수 하나(`SQLITE_SCHEMA_VERSION`)이고, hook의 연결 시간 한도는 잠금 한도(3초)를 빌려 쓴다. 모든 verb가 연결 실패를 값으로 돌려주는지, commit 응답을 잃은 쓰기를 다시 해도 결과가 같은지도 아직 시험하지 않았다(E11-5, E11-2, AD-7·9·10·20·31).

**Approach:** CLI에 store factory 하나를 두어, `url_env`가 있으면 PG Store와 PG 소유자별 기대 버전을, 없으면 지금의 SQLite Store를 돌려준다. dispatch의 모든 경로(hook·명령·기회적 drain)가 이 factory를 쓴다. Core의 스키마 확인은 소유자별 모델(`{ core: N, … }`)로 바꾸고, 연결 시간 한도는 경로별 Core 상수로 둔다. 모든 PG verb의 실패 분류와 commit 결과를 모르는 재시도는 시험으로 고정한다.

## Boundaries & Constraints

**Always:**
- 오류 분류: 연결 거부, 연결 시간 초과, 연결 중 끊김(`pg_terminate_backend`, 소켓 종료), database·role·`brain` schema·`brain` 표 없음, 인증 실패는 모든 Store verb에서 throw가 아닌 `{ ok: false, code: 'DB_UNAVAILABLE' }` 값이다. `55P03`·`40P01`은 `DB_LOCKED`이다. `brain.schema_migrations`에 core 행이 없거나 core 버전이 기대와 다르면 `SCHEMA_MISMATCH`이다. 새 오류 코드는 만들지 않는다.
- 기대 버전은 소유자별 맵이다. 기대 맵의 모든 소유자를 DB의 그 소유자 최고 버전과 비교한다. 첫 불일치(core 먼저, 그다음 이름순)의 `owner`·`found`·`expected`를 결과와 메시지에 담는다. DB에만 있는 소유자(기대 맵에 없는 확장)는 무시한다.
- 연결 시간 한도는 Core 상수 `CONNECT_TIMEOUT_MS`(`turn` 1000, `command` 5000, `drain` 5000)이고, PG 연결 함수(`createPool`) 한 곳에서만 적용한다. 잠금 한도 `BUSY_TIMEOUT_MS`는 그대로 둔다.
- hook 명령은 DB가 꺼져 있거나 응답하지 않아도 exit 0, `SPOOLED`, spool 파일 하나로 끝난다. hook과 명령은 컨테이너를 띄우지 않는다.
- PG 모듈(`second_brain/postgres`)은 factory 안에서만 동적으로 import한다. SQLite 홈 경로는 pg를 로드하지 않는다.
- `url_env`가 가리키는 URL이 없거나 비어 있으면 지금처럼 닿지 않는 URL로 열어 `DB_UNAVAILABLE`이 된다. pg가 `PGHOST` 등 기본값으로 넘어가지 않게 한다.

**Never:**
- 데몬(`apps/cli/src/daemon/run.ts`)의 Store를 PG로 바꾸지 않는다(티켓 9). 데몬은 새 Core 서명에 맞춰 SQLite 기대 맵만 넘긴다.
- SQLite 선택·`store.path`·`packages/sqlite`를 지우지 않는다(티켓 10). setup·doctor의 PG 설치·점검 단계를 바꾸지 않는다(티켓 8). `setup run`의 SQLite 설치 경로도 그대로 둔다.
- 연결·잠금 밖의 SQL 오류(제약·trigger 위반 등) 분류를 바꾸지 않는다. 마이그레이션 실행기의 오류 코드를 바꾸지 않는다.
- baseline `0001_initial.sql`과 `CORE_SCHEMA_VERSION`을 바꾸지 않는다. 플러그인 `app-ref`·version을 바꾸지 않는다.
- spool 형식(`SPOOL_RECORD_VERSION`)과 `config.toml`의 `schema_version`(설정 파일 버전)은 이 작업의 "스키마 버전"이 아니다. 건드리지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| DB 꺼짐, hook | PG 홈, 연결 거부, `sessions ingest claude-code --json` + payload | exit 0, `data.spooled: true`, 경고 `SPOOLED`·`DB_UNAVAILABLE`, spool `*.jsonl` 1개 | 값으로 처리, throw 없음 |
| DB 무응답, hook | 연결은 받지만 아무것도 보내지 않는 TCP listener | `CONNECT_TIMEOUT_MS.turn` 뒤 위와 같이 spool, 프로세스 전체가 `turn + 3000`ms 안에 끝남 | `DB_UNAVAILABLE` |
| DB 복구, drain | 위 spool이 있고 DB가 다시 닿음, `queue drain --json` | 그 세션·메시지가 PG에 들어가고 spool 폴더에 `*.jsonl`·`*.claiming` 없음, SQLite `brain.db`에는 세션 없음 | 없음 |
| schema 없음, 명령 | PG 홈, `drop schema brain cascade`, `queue drain --json`(쓰기)·`failures list --json`(읽기) | 둘 다 `ok: false`, `DB_UNAVAILABLE`, exit 2 | spool 분기 없는 명령은 실패 |
| core 버전 다름, 명령 | `update brain.schema_migrations set version=2 where owner='core'`, `queue drain --json` | `ok: false`, `SCHEMA_MISMATCH`, exit 1, 메시지에 `core`·2·1 | 쓰지 않음 |
| 모르는 소유자 | `schema_migrations`에 `owner='garmin'` 행 추가 | 명령이 평소처럼 성공 | 무시 |
| 모든 verb, DB 없음 | 닫힌 포트 / 연결 뒤 backend 종료 / `brain` schema 삭제 | 모든 Store verb가 `ok: false`, `DB_UNAVAILABLE` 값(throw 없음). `close`는 예외 없이 끝남 | 값 |
| commit 응답 유실 | commit이 서버에서 끝난 직후 클라이언트 접속이 끊김 | 첫 호출은 `DB_UNAVAILABLE`, 같은 입력의 재시도는 `ok`, 모든 `brain` 표 행 수가 한 번만 쓴 DB와 같음 | 멱등 키 |
| SQLite 홈 | `url_env` 없음 | 지금과 같은 SQLite 동작·기대 버전 `{ core: SQLITE_SCHEMA_VERSION }` | 지금과 같음 |

</intent-contract>

## Code Map

- `packages/core/src/busy-timeout.ts` -- `BUSY_TIMEOUT_MS` 옆에 `CONNECT_TIMEOUT_MS`(위 값)와 문서 주석을 둔다. `packages/core/src/index.ts`에서 export.
- `packages/core/src/ports/store.ts:769-791` -- `ReadSchemaVersionResult`·`SchemaStore.readSchemaVersion()`을 소유자별로 바꾼다: `readSchemaVersions()` → `{ ok: true; versions: Readonly<Record<string, SchemaVersion>> }`(소유자별 최고 버전, 행 없으면 빈 객체) 또는 기존 실패 값. 주석의 "single `schema_version` row" 설명도 고친다.
- `packages/core/src/schema.ts` -- `SchemaVersions = Readonly<Record<string, number>>`, `CORE_SCHEMA_OWNER = 'core'`. `checkSchema(store, expected: SchemaVersions)`. ok는 `{ versions }`, 불일치는 `owner`·`found`·`expected`. `mismatchMessage`는 소유자 이름을 넣는다(지금의 세 문장 구분은 유지).
- `packages/core/src/brain.ts:84,236,364`, `doctor/doctor.ts:104,164,219`, `settings/index.ts:38,46,60` -- `schemaVersion: number` → `schemaVersions: SchemaVersions`. doctor의 schema check `detail`은 소유자별 버전을 보인다.
- `packages/core/src/testing/fakes/schema-store.ts`, `testing/contracts/schema-store.ts`, `testing/fixtures.ts` -- 새 메서드·맵에 맞춘다. 계약에 "버전 맵의 값이 소유자별 최고 버전" 확인을 더한다.
- `packages/sqlite/src/store.ts:133` -- `readSchemaVersions()`가 singleton 버전을 `{ core: … }`로 돌려준다. 그 밖의 SQLite 동작은 바꾸지 않는다.
- `packages/postgres/src/store.ts:38` -- `readSchemaVersions()`: `select owner, max(version), max(applied_at) … group by owner`. `packages/postgres/src/migrate.ts`에 `EXPECTED_SCHEMA_VERSIONS = { core: CORE_SCHEMA_VERSION }`를 두고 `index.ts`에서 export.
- `packages/postgres/src/connect.ts:40-69` -- `connectionTimeoutMillis`는 `connectTimeoutMs ?? CONNECT_TIMEOUT_MS[path] ?? DEFAULT_CONNECT_TIMEOUT_MS`. 잠금·statement·client 한도 계산은 그대로. `databaseFailure`는 위 분류를 지키는지 확인하고, 연결 실패가 `code` 없이 오는 경우(`Connection terminated`, `timeout exceeded when trying to connect`, `AggregateError`)도 `DB_UNAVAILABLE`임을 유지한다.
- `packages/postgres/src/*.ts`(sessions·users·work·schedules·attachments·extractions·transcript-files·settings·maintenance) -- verb마다 연결·질의 실패가 `databaseFailure` 값으로 나오는지 확인하고, throw가 새는 verb만 고친다(`withWrite` 밖의 읽기 질의 포함).
- `apps/cli/src/runtime/brain-store.ts`(새) -- factory `openBrainStore({ home, env, config, path, lockTimeoutMs?, createSqliteStore })` → `{ kind: 'postgres' | 'sqlite', store, expected: SchemaVersions }`. PG: `resolveStoreUrl`(`config/codec.ts`) → `postgresStore({ databaseUrl, path, lockTimeoutMs })`, 기대 맵은 `EXPECTED_SCHEMA_VERSIONS`. SQLite: `createSqliteStore({ path: storePath, busyTimeoutMs: lockTimeoutMs ?? BUSY_TIMEOUT_MS[path] })`, 기대 맵 `{ core: SQLITE_SCHEMA_VERSION }`. 설정을 못 읽은 diagnostic 명령은 지금처럼 `failedConfigStore`. 반환 Store 타입은 `Store & SchemaStore`(PG일 때 `SettingsStore`도 쓸 수 있게 판별 가능하게). 데몬이 티켓 9에서 회차마다 `path: 'drain'`으로 부를 수 있는 모양이어야 한다.
- `apps/cli/src/dispatch.ts:345-355,571-660,760-795` -- `runSettings`·`runIngest`·일반 경로·`drainOpportunistically`가 모두 factory에서 Store와 기대 맵을 받는다(hook은 `turn`, 명령 `command`, 기회적 drain은 `drain` + `lockTimeoutMs: DRAIN_BUDGET_MS.opportunistic`). dispatch 안의 `postgresStore`·`pg.CORE_SCHEMA_VERSION`·`SQLITE_SCHEMA_VERSION` 직접 사용은 없앤다. `runIngest` 분기를 일반 경로로 합칠 수 있으면 합친다(`sessions ingest`의 출력·spool·warning은 지금과 같아야 한다). `DispatchRuntime.createStore` 시험 seam은 SQLite 생성 함수로 유지한다.
- `apps/cli/src/assembly.ts:53,81` -- `schemaVersion?: number` → `schemaVersions: SchemaVersions`(필수, factory가 준다). SQLite 기본값 대체 없음.
- `apps/cli/src/daemon/run.ts:264-268` -- `checkSchema(store, { core: SQLITE_SCHEMA_VERSION })`와 assembly 맵만 바꾼다(Store는 그대로).
- `apps/cli/src/install.ts:289`, `apps/cli/src/install/store.ts:300` -- 새 서명(`schemaVersions`)에 맞춘다. 동작은 그대로.
- `apps/cli/src/doctor/store.ts:35` -- `failedConfigStore`의 `readSchemaVersions`.
- `apps/cli/scripts/write-build-info.mjs`, `apps/cli/src/install/installed.ts:23-121`, `apps/cli/src/install/flow.ts:679` -- `build.json`에 `schema_versions`(PG 기대 맵, `second_brain/postgres`의 `EXPECTED_SCHEMA_VERSIONS`)를 더한다. `schema_version`(SQLite 정수)은 티켓 10까지 남긴다. `readBuildIdentity`는 둘 다 읽고 `schema_versions`가 문자열→정수 맵이 아니면 `undefined`. `installed.json`은 빌드의 `schema_versions`를 함께 기록하고, `readInstalled`는 그 키가 없는 옛 기록도 받는다.
- 시험 선례: `packages/postgres/test/cli.test.ts`의 `world()`·`run()`·`it.each([...])('spools the built hook on %s …')`, `test/closed-port.ts`, `test/fixture.ts`의 `database()`·`subject()`, `test/connect.test.ts`, `packages/core/src/testing/fixtures.ts`의 sample 입력, `apps/cli/test/dispatch.test.ts`의 `createStore` seam.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/busy-timeout.ts`, `ports/store.ts`, `schema.ts`, `brain.ts`, `doctor/doctor.ts`, `settings/index.ts`, `index.ts`, `testing/**` -- `CONNECT_TIMEOUT_MS`, 소유자별 `readSchemaVersions`·`checkSchema`·`schemaVersions` -- 기대 버전 모델과 경로별 연결 한도의 Core 소유
- [x] `packages/core/test/schema.test.ts` 외 영향받는 Core 시험 -- 소유자 맵 비교: 일치, core 불일치(위·아래·null), 확장 소유자 불일치, DB에만 있는 소유자 무시, 실패 값 전달 -- 매트릭스의 버전 행
- [x] `packages/sqlite/src/store.ts`와 그 시험 -- `readSchemaVersions` 대응 -- SQLite 홈 동작 유지
- [x] `packages/postgres/src/connect.ts`, `store.ts`, `migrate.ts`, `index.ts`, 필요한 verb 파일 -- 연결 한도, 버전 맵 읽기, `EXPECTED_SCHEMA_VERSIONS`, throw가 새는 verb 수정 -- 오류 분류
- [x] `packages/postgres/test/connect.test.ts` -- 경로별 `connectionTimeoutMillis`가 `CONNECT_TIMEOUT_MS`를 따르고 잠금 한도는 그대로임을 고친 기대값으로 확인
- [x] `packages/postgres/test/unavailable.test.ts`(새) -- `it.each(['refused','terminated','missing-schema'])('every store verb answers DB_UNAVAILABLE when %s', …)`: `postgresStore`의 모든 verb(`close` 제외)를 표로 부르고, 표가 Store의 키 전부를 덮는지 단언 -- "모든 verb" 증거
- [x] `packages/postgres/test/commit-unknown.test.ts`(새) -- 시험 안의 TCP proxy가 commit 문장을 서버에 넘긴 뒤 응답을 버리고 클라이언트 소켓을 끊는다. `it.each(['ingest','addWork','linkAttachments'])('replays %s after the commit reply is lost and ends with the rows of one write', …)`: 첫 결과 `DB_UNAVAILABLE`, 새 Store로 같은 입력 재시도 `ok`, 모든 `brain` 표의 행 수가 한 번만 쓴 대조 DB와 같음 -- 멱등 재시도
- [x] `packages/postgres/test/cli.test.ts` -- 새 case 셋: `'spools the built hook within the turn connect budget when the database never answers'`(무응답 listener, 경과 < `CONNECT_TIMEOUT_MS.turn + 3000`), `'drains the spooled hook into PG once the database is back'`(닿지 않는 URL로 hook → URL 복구 → `queue drain --json` → 세션 있음·spool 빔·SQLite 세션 0), `'answers commands with DB_UNAVAILABLE without the brain schema and SCHEMA_MISMATCH on another core version'`(매트릭스의 명령·모르는 소유자 행). 기존 hook spool case는 그대로 통과
- [x] `apps/cli/src/runtime/brain-store.ts`, `dispatch.ts`, `assembly.ts`, `daemon/run.ts`, `install.ts`, `install/store.ts`, `doctor/store.ts` -- factory와 모든 dispatch 경로 연결
- [x] `apps/cli/test/brain-store.test.ts`(새)와 영향받는 `apps/cli/test/**` -- factory가 `url_env` 유무로 Store 종류·기대 맵·경로 한도를 고르고, SQLite 홈에서 pg를 import하지 않음(`second_brain/postgres` 동적 import가 일어나지 않음)을 확인
- [x] `apps/cli/scripts/write-build-info.mjs`, `apps/cli/src/install/installed.ts`, `install/flow.ts`, 관련 시험(`doctor-checks.test.ts` 등) -- `build.json`·`installed.json`의 `schema_versions`
- [x] `tooling/dev/pg-tracer.sh` -- `compose stop` 뒤 새 세션 id(`pg-tracer-offline`) payload로 hook: 경과 시간이 `CONNECT_TIMEOUT_MS.turn + 3000`ms 미만, `SPOOLED`, spool 파일 있음 → `compose up -d --wait` → `queue drain --json` → `brain.sessions`에 그 세션이 있고 spool 폴더에 `*.jsonl`·`*.claiming` 없음

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume`, then 스크립트가 exit 0이고, 컨테이너를 멈춘 동안의 hook이 시간 한도 안에 exit 0·`SPOOLED`·spool 파일로 끝나며, 컨테이너를 켠 뒤 `brain queue drain`이 그 세션을 PG에 넣고 spool 폴더가 빈다.
- Given 같은 빌드, when `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/unavailable.test.ts packages/postgres/test/commit-unknown.test.ts packages/postgres/test/cli.test.ts packages/postgres/test/connect.test.ts`, then 모든 verb의 `DB_UNAVAILABLE` 값, commit 응답 유실 뒤 재시도의 같은 행 수, 명령의 `DB_UNAVAILABLE`(schema 없음)·`SCHEMA_MISMATCH`(core 버전 다름)가 모두 통과한다.
- Given 빌드한 CLI, when `apps/cli/dist/build.json`을 읽으면, then `schema_versions`가 `{ "core": 1 }`이다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 memory·SQLite·PG의 모든 시험이 통과한다.

## Implementation Notes

- 구현 세션(codex thread `01a182ec-355d-71d3-88e1-7fb4a9a1e346`)이 커밋 `37bc246`으로 계획 전체를 구현했다. 구현 세션이 frontmatter를 `status: built`·`review: quick`로 바꾸고 아래 Review Triage Log에 자체 `quick` 점검 한 줄을 남겼다. 이 점검은 step-04 리뷰가 아니므로 오케스트레이터가 `status`·`review`·`lenses_ran`을 되돌렸고, 그 한 줄은 append-only 규칙에 따라 남겨 둔다.
- 오케스트레이터 검증(2026-10-28): `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume` 통과(중단 중 hook spool → 복구 뒤 `queue drain`으로 세션·메시지 저장, spool 비움), 계획의 PG 시험 4개 파일 37 tests 통과, `build.json`의 `schema_versions`가 `{"core":1}`, `git diff --check` 통과.
- 전체 `npx --yes pnpm@12 test` 첫 실행에서 `packages/postgres/test/migrate.test.ts`의 `afterEach`(시험 DB 삭제)가 60초 시간 초과로 1건 실패했다. 이 파일과 실행기 로직은 이번 변경 밖이고, 단독 재실행 2회와 전체 재실행 1회(119 files / 3144 tests)는 모두 통과했다. 병렬 부하에서의 시험 DB 삭제 지연으로 본다.
- `sessions ingest`는 이제 일반 dispatch 경로(`spec.run`)로 돈다. dispatch에는 더 이상 `runIngest` 분기가 없다.

## Plan Change Log

## Review Triage Log

- `quick`: 독립 검토 결과 발견 사항 없음. 추가 수정·보류 항목 없음.

### 2026-10-29 — Review pass
- verdicts: 23 findings — high 0, medium 3, low 8, false 12, maybe-false 0
- findings:
  - `[medium]` `[reject]` blind: 데몬이 여전히 SQLite Store를 열고 `SQLITE_SCHEMA_VERSION`만 검사해 PG 홈에서 명령과 데몬이 다른 저장소를 쓴다 — 실제다. tracer 재실행에서 SQLite 데몬이 오프라인 hook의 spool을 먼저 SQLite로 되넣어 PG 세션 검사가 0건으로 실패했다. 그러나 의도가 "9가 데몬에 쓰고"로 데몬 전환을 티켓 9에 두므로 범위 밖이다. tracer는 오프라인 단계 전에 `daemon stop`으로 데몬을 멈추도록 고쳤고(아래 검증), 데몬 전환은 티켓 9가 한다.
  - `[medium]` `[defer]` blind: PG 경로의 `createBrain`에 `table_cleanup` handler가 없어 저장본 정리가 돌지 않는다 — `apps/cli/src`에 handler·정리 URL 사용처가 없음을 확인했다. 정리 role 접속을 담을 설정·`.env` 항목이 아직 없고(설치는 티켓 8), 변경 전에도 PG drain이 없어 정리가 돌지 않았으므로 기존 공백이다. frontmatter `deferred`에 기록했다.
  - `[low]` `[patch]` blind: `readSchemaVersions`가 `max(version)`과 `max(applied_at)`을 따로 집계해 `appliedAt`이 다른 행의 값이 될 수 있다 — `select distinct on (owner) … order by owner, version desc`로 최고 버전 행을 그대로 읽게 고쳤다.
  - `[low]` `[patch]` blind: `failures retry`가 `readFileExtractionState`의 새 `DB_LOCKED`를 처리하지 않아 상태를 못 읽은 파일도 다시 일감에 넣는다 — `packages/core/src/failures/retry.ts:134`에서 `DB_LOCKED`도 같은 실패로 돌려주게 고치고 Core 시험에 사례를 더했다.
  - `[false]` `[reject]` blind: `expected`가 `{}`이면 빈 DB도 `ok: true`가 된다 — 모든 호출자(factory의 `EXPECTED_SCHEMA_VERSIONS`·`{ core: SQLITE_SCHEMA_VERSION }`, 데몬, 설치, 설정)가 core가 든 맵을 넘기며 빈 맵을 넘기는 경로가 없다.
  - `[false]` `[reject]` blind: `isSchemaVersions`가 0·음수 버전을 받는다 — 이 값은 이 빌드가 쓴 `build.json`을 `installed.json`으로 옮겨 적기만 하고 값을 비교·사용하는 소비자가 없어 나쁜 결과가 생기지 않는다.
  - `[low]` `[patch]` blind: schema 계약의 두 번 읽기 비교가 `JSON.stringify`라 키 순서가 다르면 정상 구현도 실패한다 — 정렬한 항목으로 비교하게 고쳤다(edge-case의 같은 지적과 한 원인).
  - `[false]` `[reject]` blind: 계약이 `versions: []`를 맵으로 통과시킨다 — 타입이 배열을 막고, 그런 adapter는 모든 쓰기에서 `SCHEMA_MISMATCH`(found null)로 시끄럽게 실패하므로 조용한 나쁜 결과가 없다.
  - `[low]` `[reject]` blind: commit 응답 유실 시험이 행 수만 비교한다 — 의도의 verify가 관찰값을 "행 수가 한 번 쓴 결과와 같다"로 정했고, 메시지 본문은 불변 trigger가 갱신을 막는다. 내용 비교 추가는 시험 복잡도만 늘리고 일상 사용에서 만날 결함이 아니다.
  - `[low]` `[patch]` blind: dispatch가 `runIngest`를 더 부르지 않는데 `DatabaseCommandSpec.runIngest`·`IngestCommandSpec`·`runIngest: run`이 남았다 — 필드·타입·할당과 쓰지 않는 import를 지우고, `writes` 주석의 `SQLITE_SCHEMA_VERSION` 설명을 factory의 소유자별 기대 버전으로 고쳤다.
  - `[low]` `[patch]` edge-case: 최고 버전의 `appliedAt`에 다른 행의 시각이 반환된다 — 위 `distinct on` 수정과 같은 원인·같은 수정.
  - `[low]` `[patch]` edge-case: 두 조회의 키 순서가 다르면 계약 시험이 실패한다 — 위 정렬 비교 수정과 같은 원인·같은 수정.
  - `[medium]` `[patch]` verification-gap: PG 홈에서 일반 명령 뒤의 기회적 drain이 PG에 넣는지 시험이 없다 — `packages/postgres/test/cli.test.ts`에 닿지 않는 URL로 hook을 spool한 뒤 `failures list --json`만 실행해 PG에 세션·메시지가 있고 spool이 비며 SQLite에 세션이 없음을 확인하는 사례를 더했다.
  - `[low]` `[patch]` verification-gap: `listFailures`의 `DB_LOCKED` 분류를 시험하지 않는다 — `packages/postgres/test/store.test.ts`의 잠금 시험에 `brain.failures` 잠금과 `listFailures`의 `{ ok: false, code: 'DB_LOCKED' }`를 더했다.
  - `[false]` `[reject]` intent: 공통 factory가 데몬 실제 조립에 쓰이지 않는다 — 의도가 데몬 사용을 티켓 9에 둔다("9가 데몬에 쓰고"). factory는 `path: 'drain'`을 받는 모양으로 준비돼 있다.
  - `[false]` `[reject]` intent: 소유자별 버전 판정이 각 verb가 아니라 `checkSchema`에 있다 — AD-20은 런타임 명령이 시작할 때 소유자별 기대 버전을 확인하라고 하고, 모든 쓰기 경로가 그 검사를 지난다. verify의 관찰면(명령이 `SCHEMA_MISMATCH`로 답함)은 CLI 시험이 확인한다.
  - `[false]` `[reject]` intent: 장애 분류 시험이 adapter 수준이고 모든 CLI 경로가 아니다 — 의도는 "PG adapter가 모든 verb에서"이고 `unavailable.test.ts`가 `close` 외 모든 verb를 덮으며, hook·명령의 CLI 표면은 `cli.test.ts`가 따로 본다.
  - `[false]` `[reject]` intent: schema 없음의 매핑 변경 지점이 diff에 없다 — 이 동작은 티켓 1 이후 이미 `databaseFailure`로 `DB_UNAVAILABLE`였고(계획 조사에서 확인), 이번 변경은 모든 verb와 명령에서 시험으로 고정했다. 고칠 결함이 없다.
  - `[false]` `[reject]` intent: hook 시간 한도가 연결 한도에 3초 여유를 더한 값이다 — 의도는 "연결 시도에 경로별 시간 한도 Core 상수"이고 `CONNECT_TIMEOUT_MS.turn`이 그것이다. 여유는 node 프로세스 기동 시간이며 무응답 listener 시험이 연결 한도가 지켜짐을 보인다.
  - `[false]` `[reject]` intent: CLI 자동 시험은 실패 URL로 중단을 흉내 낸다 — 실제 컨테이너 중단·재기동은 `tooling/dev/pg-tracer.sh`가 확인하고 이번 검증에서 통과했다.
  - `[false]` `[reject]` intent: commit 유실 재시도가 시험 코드의 직접 재호출이다 — verify가 요구한 것은 "commit 직후 접속을 끊는 시험에서 재시도 뒤 행 수가 같다"이고, 실제 경로의 재시도(spool → drain)는 같은 멱등 verb를 다시 부른다.
  - `[false]` `[reject]` intent: 연결 장애보다 넓게 `DB_LOCKED`를 보존한다 — E11-5가 "잠금 초과는 `DB_LOCKED`"를 요구하며, 읽기 catch가 그것을 `DB_UNAVAILABLE`로 덮던 것을 바로잡은 것이다.
  - `[false]` `[reject]` intent: 시험 이름·실행 명령의 plan 기록을 diff에서 확인할 수 없다 — plan은 리뷰 diff에서 뺐을 뿐이며 Tasks & Acceptance와 Verification에 시험 이름과 명령이 적혀 있다.
- 패치 검증 중 발견: 첫 tracer 재실행이 위 데몬 지적과 같은 원인으로 실패했다. 구현 세션이 `tooling/dev/pg-tracer.sh`에서 `compose stop` 전에 `daemon stop --json`을 부르고 이유 주석을 달았다. 그 뒤 tracer는 연속 3회 통과했다.

### 2026-10-29 — 후속 thorough 리뷰

- 판정: 19건 — high 0, medium 2, low 5, false 12, maybe-false 0. edge-case-hunter는 `[]`를 보고했다. blind-hunter의 산식 줄은 발견 사항 수에 넣지 않았다. intent-alignment는 비교표 6행과 후속 관찰 2건을 각각 판정했다.
- 발견 사항:
  - `[medium]` `[reject]` blind: SQLite 데몬이 PG 홈의 spool을 먼저 소비한다 — carried: 이전 리뷰와 같은 위치·주장이다. 의도의 "9가 데몬에 쓰고"에 따라 데몬 전환은 티켓 9에 있다. 기존 판정을 유지한다.
  - `[medium]` `[defer]` blind: PG 정리 handler가 조립되지 않았다 — carried: 기존 triage와 frontmatter `deferred`, 원장의 DW-11에 있는 같은 공백이다. 기존 판정을 유지하며 기존 항목을 다시 추가하거나 수정하지 않는다.
  - `[low]` `[reject]` blind: 기회적 drain이 2초보다 오래 연결·질의를 기다릴 수 있다 — `dispatch.ts`는 잠금만 2초로 제한하며 `queue/drain.ts`의 예산은 다음 청구를 멈추는 기준이다. 연결 5초와 statement/client 유예는 실제로 남는다. 이미 성공한 명령과 다음 연결 사이의 장애·응답 유실에서 부가 지연이 가능하지만, 이를 전체 실행 제한으로 바꾸려면 별도 취소·예산 전파 분기가 필요하다. 드문 장애에서의 지연을 위해 그 복잡도를 추가하지 않는다. hook의 연결 한도와는 별개다.
  - `[false]` `[reject]` blind: 인증 뒤 무응답에서 4초를 넘으므로 hook 연결 한도 시험이 불충분하다 — `CONNECT_TIMEOUT_MS.turn`은 의도가 지정한 연결 시도의 한도다. 기존 무응답 listener와 tracer는 그 조건을 검사한다. 인증이 끝난 뒤의 질의에는 별도 잠금·질의 한도가 적용되며, 연결 이후 모든 처리를 4초로 제한한다는 요구는 없다.
  - `[low]` `[reject]` blind: commit 유실 시험이 행 내용 대신 행 수만 비교한다 — carried: 이전 리뷰와 같은 주장이다. 티켓 verify가 관찰값을 행 수로 정했고, 기존 계약은 재생 뒤 본문과 순서도 확인한다. 기존 판정을 유지한다.
  - `[false]` `[reject]` blind: 동일 ID의 직접 재호출은 실제 spool 재생을 증명하지 않는다 — carried: 이전 intent 렌즈의 같은 주장이다. 티켓의 commit 유실 검증은 재시도 후 행 수이며, 별도 CLI 시험과 tracer가 spool → drain 경로를 검증한다. 기존 판정을 유지한다.
  - `[false]` `[reject]` blind: backend 종료 시험만 있어 원시 소켓 단절을 확인하지 않는다 — `commit-unknown.test.ts`의 proxy가 COMMIT 응답을 버리고 `client.destroy()`·`upstream.destroy()`로 양쪽 소켓을 끊는다. 진행 중인 Store 호출이 `DB_UNAVAILABLE` 값으로 돌아오고 시험 프로세스가 살아서 재시도까지 수행하므로, 원시 소켓 단절 경로도 실행된다.
  - `[false]` `[reject]` blind: 같은 Store의 복구가 없어 현재 런타임이 손상된 pool을 재사용할 수 있다 — hook·명령·기회적 drain은 호출마다 Store를 열고 finally에서 닫는다. 이 티켓의 실제 장애 재시도는 새 Store를 여는 CLI drain이다. 동일 pool을 장기간 사용하는 PG 데몬은 이번 변경에 없으므로 지적한 소비자가 없다.
  - `[low]` `[reject]` blind: 실제 deadlock과 rollback 후 연결 재사용을 시험하지 않는다 — baseline의 `databaseFailure`에도 이미 `40P01` → `DB_LOCKED` 분류가 있다. 이 변경은 읽기 catch가 그 공통 함수를 쓰게 한다. 실교착의 시간 순서를 조율하는 새 시험은 단순 읽기의 일상 경로에서 보기 어려운 조건을 위해 상당한 동기화 코드를 더하므로 추가하지 않는다. 이번 보완은 실제 테이블 잠금으로 읽기 catch의 분류와 연결 재사용을 확인한다.
  - `[low]` `[reject]` blind: CLI 시험의 child에 watchdog이 없다 — `run()`은 baseline부터 같은 helper이고, 제품 연결·질의 타이머가 종료를 제한한다. 새 watchdog은 별도 timer·kill·정리 분기를 추가하는 시험 기반시설 변경이다. 현재 전체 시험과 tracer가 모두 끝났으며, 가정한 무한 대기의 회귀를 위해 이 복잡도를 더하지 않는다.
  - `[low]` `[patch]` verification-gap: 파일 공유·추출 상태 읽기의 실제 PG 잠금 분류 시험이 없다 — `attachment-extraction.test.ts`에 두 읽기를 매개변수화했다. 별도 연결의 `brain.files ACCESS EXCLUSIVE` 잠금 중 `DB_LOCKED`, 잠금 해제 뒤 같은 Store에서 기존 읽기 결과와 일치함을 단언한다. 기존 구현 세션 `01a182ec-355d-71d3-88e1-7fb4a9a1e346`이 시험만 추가했다.
  - `[false]` `[reject]` intent: 소유자별 불일치가 모든 adapter verb에 직접 적용되지 않는다 — carried: 이전 리뷰와 같은 주장이다. 기대 버전은 Core `checkSchema`와 런타임 쓰기 guard가 판정하며, CLI 불일치 시험과 Core 확장 소유자 시험이 해당 표면을 검증한다.
  - `[false]` `[reject]` intent: 데몬이 공통 factory를 아직 쓰지 않는다 — carried: 의도가 실제 데몬 사용을 티켓 9에 두었다. 현재 factory는 drain 경로를 받는다.
  - `[false]` `[reject]` intent: 복구 증거가 자동 데몬이 아닌 명시적 CLI drain이다 — 티켓 verify는 컨테이너를 켜고 drain하는 동작을 요구한다. tracer가 바로 그 표면을 실행한다. 자동 데몬 전환은 티켓 9다.
  - `[false]` `[reject]` intent: hook 프로세스 한도와 연결 한도가 다르다 — carried: 이전 리뷰와 같은 주장이다. 의도는 연결 시도에 Core 상수를 두는 것이며 프로세스 기동 여유는 별도다.
  - `[false]` `[reject]` intent: commit 유실 재생이 adapter 직접 호출·행 수 비교에 머문다 — carried: 이전 리뷰와 같은 주장이다. ticket verify가 요구한 commit 직후 단절·재시도·행 수 비교와 일치하고, 실제 spool 재생은 CLI 시험과 tracer가 확인한다.
  - `[false]` `[reject]` intent: schema 부재의 오류 매핑을 뒤집는 변경이 없다 — carried: baseline부터 이미 해당 catch가 `databaseFailure`를 썼다. 이번에는 모든 verb와 CLI 시험으로 고정하므로 새 수정이 필요하지 않다.
  - `[false]` `[reject]` intent: 모든 verb 검사는 모든 CLI 명령 검사가 아니다 — carried: 의도는 "PG adapter가 모든 verb에서"이다. adapter 키 집합 전수 검사와 별도 hook·명령 시험이 요구 표면에 맞는다.
  - `[false]` `[reject]` intent: 읽기의 `DB_LOCKED` 보존이 연결 장애 설명보다 넓다 — carried: E11-5가 잠금 초과의 `DB_LOCKED`를 요구한다. 공통 분류를 유지하는 변경이며 계획에도 명시되어 있다.

## Design Notes

**factory가 SQLite도 고르는 이유:** 티켓 10 전까지 SQLite가 기본이다. 선택을 한 함수에 모으면 10은 그 함수의 SQLite 분기만 지우면 되고, 9는 데몬 회차마다 같은 함수를 부른다. 지금처럼 dispatch가 분기마다 `postgresStore`를 따로 만들면 세 번째 사본(데몬)이 생긴다.

**`build.json`에 정수를 남기는 이유:** SQLite 설치 경로와 이 Mac의 기존 `installed.json`이 정수 `schema_version`을 읽는다. 지금 지우면 플러그인 점검이 빌드를 알 수 없다고 답한다. 소유자 맵 `schema_versions`를 더하고, 정수는 SQLite와 함께 티켓 10에서 지운다.

**commit 응답 유실 시험의 모양:** PG 쪽에서 commit이 끝난 것을 보장하려면 끊는 시점이 서버 응답 직후여야 한다. 시험 안의 proxy가 클라이언트→서버 스트림에서 commit 문장(simple 또는 extended protocol)을 본 뒤 서버의 다음 응답을 클라이언트에 넘기지 않고 양쪽 소켓을 닫는다. 대조값은 같은 입력을 끊김 없이 한 번 쓴 별도 DB의 표별 행 수다.

```ts
// 소유자별 기대 버전 (예)
const expected: SchemaVersions = { core: CORE_SCHEMA_VERSION };
const check = await checkSchema(store, expected);
// 불일치: { ok: false, code: 'SCHEMA_MISMATCH', owner: 'core', found: 2, expected: 1, message }
```

## Verification

**Commands:**
- `npx --yes pnpm@12 build && sh tooling/dev/pg-tracer.sh --delete-volume` -- expected: exit 0, 중단 중 hook spool과 복구 뒤 drain 확인 출력
- `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/unavailable.test.ts packages/postgres/test/commit-unknown.test.ts packages/postgres/test/cli.test.ts packages/postgres/test/connect.test.ts` -- expected: 통과
- `node -e "console.log(require('./apps/cli/dist/build.json').schema_versions)"` -- expected: `{ core: 1 }`
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과(OrbStack 켜짐)
- `git diff --check` -- expected: 출력 없음

### Verification Results (2026-10-28)

- `npx --yes pnpm@12 test`: build·typecheck 포함, 119 files / 3144 tests 통과.
- 최신 build 후 Core 계약 및 계획의 PG acceptance 4개 파일: 5 files / 246 tests 통과.
- `sh tooling/dev/pg-tracer.sh --delete-volume`: exit 0. offline hook 시간 한도·spool, 복구 후 PG 세션·메시지 저장과 spool 비움 확인. 기본 홈 자원 변화 없음, 임시 자원 정리 완료.
- `apps/cli/dist/build.json`: `schema_versions` = `{ core: 1 }`.
- `git diff --check`: 통과.
- I/O matrix: 기존 hook spool, 무응답 hook, 복구 drain, schema 없음, core 불일치, 모르는 소유자, 모든 verb 장애, commit 응답 유실, SQLite factory 시험으로 검증.
- 구현 중 확인한 checked-out PG client의 socket error 이벤트는 pool connect 시 listener로 처리해 hook 프로세스 종료를 방지했다.
- 계획의 `DB_LOCKED` 분류를 유지하도록 관련 Core 읽기 결과 타입과 PG 읽기 catch도 맞췄다. setup·daemon Store 선택·baseline·플러그인 ref/version은 변경하지 않았다.

## Auto Run Result

### 2026-10-29 — 후속 thorough 검토 결과

- 실행 결과: `built`. 진입 시 계획의 `status: 'built'`를 그대로 유지했다. `in-review`·`done`으로 바꾸지 않았고 `tickets.py mark`를 실행하지 않았다. 티켓 완료 판정은 오케스트레이터가 한다.
- 기존 구현은 PG 홈의 hook·명령·기회적 drain을 공통 `openBrainStore`로 연결하고, 소유자별 기대 버전과 경로별 연결 한도를 사용한다. DB 중단 중 hook spool과 복구 후 PG drain, 모든 Store verb의 장애 분류, commit 응답 유실 뒤 멱등 재시도를 유지했다.
- 이번 보완은 `packages/postgres/test/attachment-extraction.test.ts`의 매개변수 시험 2건이다. `readFileSharing`·`readFileExtractionState`가 실제 테이블 잠금에서 `DB_LOCKED`를 반환하고, 잠금 해제 뒤 같은 Store에서 정상 읽기를 재개함을 확인한다. 제품 소스 변경은 없다.
- 기존 구현의 변경 파일군은 `packages/core/src/{schema,busy-timeout,brain,ports,doctor,settings,testing}`와 관련 시험(소유자별 버전·연결 한도), `packages/sqlite/src/store.ts`와 관련 시험(새 버전 포트), `packages/postgres/src/{connect,store,migrate,index,attachments,extractions,sessions,transcript-files,work}.ts`와 관련 시험(PG 분류·연결·재시도), `apps/cli/src/{runtime/brain-store,dispatch,assembly,commands/sessions-ingest,daemon/run,doctor/store,install}`와 빌드 스크립트·관련 시험(factory·소유자별 빌드 기록), `tooling/dev/pg-tracer.sh`(실제 컨테이너 중단·복구 검증)이다. baseline은 `1552951543dd6c21411fb09e4fc0e12af73533ad`이다.
- 후속 리뷰는 blind-hunter·edge-case-hunter·verification-gap·intent-alignment를 모두 실행했다. 19건: high 0, medium 2, low 5, false 12, maybe-false 0. 패치 1개 원인(low 1), 기존 defer 판정 유지 1건(medium), 기각 17건이다. 기각 근거와 carried 판정은 바로 위 후속 triage에 각각 기록했다. 새 deferred 항목은 추가하지 않았다.
- 후속 리뷰 권고: `false`. 이번 pass의 패치 집계는 high 0, medium 0, low 1이며, 후속 pass에서 high 패치가 없으므로 추가 후속 리뷰를 권고하지 않는다. `followup_review_recommended: false`를 유지했다.
- 검증: 수정 후 `npx --yes pnpm@12 test` 통과 — build·typecheck 포함, 119 files / 3150 tests. 구현 세션의 수정 파일 단독 검증도 35 tests 통과했다.
- 검증: 계획의 PG acceptance 명령(`npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/unavailable.test.ts packages/postgres/test/commit-unknown.test.ts packages/postgres/test/cli.test.ts packages/postgres/test/connect.test.ts`) 재실행 통과 — 4 files / 38 tests.
- 검증: 전체 시험에서 다시 빌드한 뒤 `sh tooling/dev/pg-tracer.sh --delete-volume` 통과 — 중단 중 hook이 시간 한도 안에 exit 0·SPOOLED·spool 파일로 끝나고, 복구 뒤 drain이 세션·메시지를 PG에 넣고 spool을 비웠다. 기본 홈 자원 변화 없이 임시 홈·컨테이너·볼륨을 정리했다.
- 검증: `apps/cli/dist/build.json`의 `schema_versions`는 `{"core":1}`이고 `git diff --check`가 통과했다. 기존 deferred-work 원장은 진입 시 저장한 SHA-256과 비교하여 바이트 단위 보존을 확인했다. 시작부터 있던 원장의 DW-11 추가분은 그대로 보존하며, 어떤 기존 원장 항목의 본문·상태·해결 기록도 편집하지 않았다. frontmatter의 기존 `deferred`도 그대로다.
- 남은 위험: 데몬 Store 전환은 티켓 9다. 그 전까지 PG 홈의 SQLite 데몬은 spool을 소비할 수 있으므로 tracer는 장애 단계 전에 데몬을 멈춘다. 정리 handler·정리 접속 조립의 기존 보류 건은 오케스트레이터 소유다. 기회적 drain 예산은 청구 반복·잠금 대기를 제한하며, 연결·질의 전체의 강제 종료 시간은 아니다.
