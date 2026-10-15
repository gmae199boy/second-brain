---
title: 'SQLite store 기반: 드라이버, 쓰기 통로, 시각 코덱'
type: 'feature'
ticket: '10'
created: '2026-10-14'
status: done
baseline_revision: '2afd31c907ace72685ee62937e7fa61f7e3ea6ea'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/personal-brain/architecture-brain-v1-slice-1/reviews/review-currency-2026-10-14.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 원본이 로컬 SQLite 파일로 바뀌었지만(AD-10) `packages/sqlite`가 없다. Kysely 0.29.6에는 `node:sqlite` dialect가 없고 내장 SQLite 드라이버의 `begin`은 DEFERRED라 AD-7의 `BEGIN IMMEDIATE`를 지킬 수 없다. Core의 `StoreHealth`는 아직 pgvector를 전제한 `vector` 칸을 갖고, 시각 정규형(AD-13)을 만드는 코덱이 없다.

**Approach:** `packages/sqlite`에 얇은 Kysely 드라이버, 이미 있는 파일만 여는 연결 함수 하나, 유일한 쓰기 통로 `withWrite`, HealthStore·SchemaStore 구현, 마이그레이션 실행기를 만든다. Core에 24글자 시각 코덱과 경로별 busy timeout 상수를 두고, `StoreHealth.vector`를 중립 `source`(위치 + 탐침 목록)로 바꿔 postgres·doctor를 맞춘다. 두 프로세스 동시 쓰기 대기를 실측해 기록한다.

## Boundaries & Constraints

**Always:**
- AD-1·3: `packages/sqlite`는 `@second-brain/core`와 `kysely` 0.29.6에만 의존. import 시 파일을 열지 않는다(첫 호출에서 연다). core는 `dependencies` 없음 유지.
- 런타임 연결은 `file:` URL + `?mode=rw`로만 연다(없는 파일 = `DB_UNAVAILABLE`, 파일 생성 없음). 파일 생성은 마이그레이션 실행기만 한다(AD-10·20).
- 연결 함수 한 곳에서만 `busy_timeout`(`timeout` 옵션), `foreign_keys=ON`, `recursive_triggers=ON`을 걸고 redact 표시 SQL 함수 `brain_redact_allowed()`를 등록한다. `allowExtension`은 켜지 않는다.
- `BEGIN IMMEDIATE`를 내는 곳은 `withWrite` 하나(Kysely `db.transaction()` 금지). redact 표시는 `withWrite` 안에서만 `try/finally`로 세우고 commit·rollback 뒤 반드시 내린다.
- 예상된 실패는 코드 있는 값(`DB_UNAVAILABLE`, 잠금 초과는 `DB_LOCKED`), 예외는 버그에만. 시각 저장은 코덱 정규형만, Store 경계에서 다른 형식은 거부.
- 기존 postgres·cli 테스트가 계속 통과하고 doctor 출력의 `pgvector: ok` 줄은 그대로다.
- 루트 `engines.node`는 `>=24.16.0`.
- Decision(2026-10-14): 플랜 크기(약 4,000 토큰)는 단일 목표이므로 분할하지 않고 전체를 유지한다.

**Never:**
- 실제 스키마 마이그레이션 파일(story 11·12), SessionStore 구현(epic 2), spool 전환(epic 2), 설정·디스패처·설치기를 sqlite로 바꾸는 것(story 13), doctor 항목 재설계(story 8), `uuid` 교체.
- 외부 dialect 패키지(`kysely-node-sqlite` 등)나 `better-sqlite3`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 없는 경로 | `sqliteStore({ path })`, 파일 없음 | `checkHealth`·`readSchemaVersion` → `DB_UNAVAILABLE`, 파일·`-wal`·`-shm` 생기지 않음 | 값 |
| 열리는 빈 DB | 마이그레이션 전 빈 파일 | health ok, `readSchemaVersion` → `version: null` | — |
| 탐침 | WAL로 만든 DB | `source.probes`의 `wal`·`fts5-trigram`·`foreign-keys`가 모두 `ok: true` | 탐침 실패는 `ok: false` + detail |
| 쓰기 통로 | `withWrite`로 insert | 실행된 첫 SQL이 `begin immediate`, 성공 시 commit | 작업이 던지면 rollback 후 다시 던짐 |
| 잠금 초과 | 다른 프로세스가 `BEGIN IMMEDIATE` 보유, timeout 짧음 | `{ ok:false, code:'DB_LOCKED' }`, 대기 시간 ≈ timeout | 값 |
| 잠금 대기 | 보유가 timeout보다 짧음 | 대기 후 성공 | — |
| redact 표시 | 표시 확인 trigger가 있는 테스트 테이블 | 일반 `withWrite` UPDATE 거부, `withWrite(..., { redact: true })` 통과, 그 뒤(성공·롤백 모두) 일반 UPDATE 다시 거부 | trigger의 `RAISE(ABORT)` |
| 마이그레이션 | 테스트용 SQL 폴더, 두 번 실행 | 첫 실행 파일 생성 + WAL + `applied` 전부, 둘째 `applied=[]` | 실패한 파일은 롤백, `MIGRATION_FAILED` + 파일명 |
| 시각 코덱 | `2026-10-14T01:02:03.004Z` / `+09:00` 오프셋 / 밀리초 없음 / 날짜만 / 27글자 연도 / Invalid Date | 첫째만 왕복 성공, 나머지 `INVALID_INSTANT` 값 | 던지지 않음 |

</frozen-after-approval>

## Code Map

- `packages/core/src/ports/store.ts` -- `StoreVectorHealth`·`StoreHealth.vector`를 `StoreSourceHealth { location: string; probes: readonly StoreProbe[] }`(`StoreProbe { id; ok; detail }`)로 교체. `HealthStore`·`SchemaStore`는 그대로.
- `packages/core/src/ports/index.ts`, `src/index.ts` -- export 갱신, 새 `instant.ts`·`busy-timeout` 상수 export.
- `packages/core/src/admin/doctor.ts` -- `db` 다음 probe마다 check 하나(`status` = ok/fail, `detail`). 불가 시 `db` fail만. `test/doctor.test.ts` 맞춤.
- `packages/core/src/testing/contracts/store.ts` `assertStoreHealth` -- 새 모양 검사(location 비어 있지 않음, probe id 유일·비어 있지 않음).
- `packages/postgres/src/store.ts` -- 같은 쿼리로 `source: { location: host/db(비밀번호 제외), probes: [{ id:'vector', ok: installed!==null, detail }] }`. detail 문구는 기존 doctor 문구 유지 → cli의 `CHECK_IDS`(`vector→pgvector`)와 출력 그대로. `test/store.test.ts`의 `health.vector` 단언 교체.
- `apps/cli/test/{admin-doctor,install-flow,setup}.test.ts` -- 가짜 health/report가 `vector` 모양을 쓰면 맞춤(동작 변경 아님).
- `packages/postgres/src/migrate.ts` -- 실행기 모양 참고(파일 순번·중복 검사·`MIGRATION_FAILED`). sqlite는 advisory lock 대신 `BEGIN IMMEDIATE`.
- `packages/second_brain/src/index.ts`, `package.json` -- `@second-brain/sqlite` 재export. postgres와 이름 충돌 금지(TS2308): sqlite 공개 이름은 `sqliteStore`, `openSqlite`, `withWrite`, `runSqliteMigrations`, `SqliteMigrationResult` 등 접두사.
- `packages/second_brain/test/boundaries.test.ts` -- adapter 의존 경계 검사, 새 패키지도 통과해야 함.
- `vitest.config.ts` -- `test/` 있는 패키지 자동 포함. 변경 없음.
- `package.json`(루트) -- `engines.node`.
- 실측(2026-10-14, node 24.16.0): `new DatabaseSync(new URL('file:…?mode=rw'))`는 없는 파일에 errcode 14로 실패하고 파일을 만들지 않는다. `timeout` 옵션 = `busy_timeout`. 기본 `foreign_keys=1`, `recursive_triggers=0`. 다른 프로세스가 1.5s 보유 시 timeout 3000 → 약 1.3s 대기 후 성공, timeout 500 → 약 0.54s 뒤 errcode 5 `database is locked`. `StatementSync.columns().length > 0`이 reader 판정.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/instant.ts`, `packages/core/src/busy-timeout.ts`, `packages/core/test/instant.test.ts` -- `formatInstant(Date)`(정규형이 아니면 실패 값), `parseInstant(string)` → `{ok,value}|{ok:false,code:'INVALID_INSTANT',message}`(정규식 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` + 왕복 일치), `BUSY_TIMEOUT_MS = { turn: 3000, command: 10000, drain: 10000 }` -- AD-13·AD-7
- [x] `packages/core/src/ports/store.ts`, `admin/doctor.ts`, `testing/contracts/store.ts`, `ports/index.ts`, `index.ts`, `test/doctor.test.ts` -- 포트 변경과 doctor·계약 맞춤
- [x] `packages/postgres/src/store.ts`, `packages/postgres/test/store.test.ts`, 영향받는 `apps/cli/test/*` -- 새 모양으로 맞춤, 출력 불변
- [x] `packages/sqlite/{package.json,tsconfig.json}` -- `@second-brain/sqlite`, deps `@second-brain/core: workspace:*`, `kysely: 0.29.6`, devDeps `@types/node`·`typescript`(postgres와 같은 버전), `types: ["node"]`
- [x] `packages/sqlite/src/driver.ts` -- `DatabaseSync`를 Kysely `SqliteDatabase` 모양으로 감싸는 어댑터(`reader`, 배열→스프레드) + `SqliteDialect`로 Kysely 생성. 쿼리 관찰용 선택 `onQuery(sql)` 훅(테스트가 첫 문장 확인)
- [x] `packages/sqlite/src/connect.ts` -- `openSqlite({ path, busyTimeoutMs, create? })`: `create`가 아니면 `mode=rw` URL, pragma 두 개, `brain_redact_allowed()` 등록(클로저 변수), 실패는 `DB_UNAVAILABLE` 값. 연결 객체는 Kysely와 표시 setter를 함께 들고 있음
- [x] `packages/sqlite/src/write.ts` -- `withWrite(conn, work, { redact? })`: 단일 연결에서 `begin immediate` → work → commit, 던지면 rollback 후 다시 던짐, `SQLITE_BUSY`(errcode 5)는 `DB_LOCKED` 값, redact 표시는 try/finally
- [x] `packages/sqlite/src/store.ts` -- `sqliteStore({ path, busyTimeoutMs? })`: 지연 연결, `checkHealth`(serverVersion = `sqlite_version()`, location = path, 탐침: `pragma journal_mode`=wal, temp FTS5 trigram 가상 테이블 생성·MATCH·삭제, `pragma foreign_keys`=1), `readSchemaVersion`(테이블 없음 → null, `applied_at`은 `parseInstant`로, 깨진 값은 `DB_UNAVAILABLE`과 이유), `close`
- [x] `packages/sqlite/src/migrate.ts` -- `runSqliteMigrations({ path, directory })`: `create: true`로 열고 `journal_mode=WAL`, 파일마다 `withWrite` 안에서 버전 확인 → 실행 → `schema_version` upsert(`applied_at`은 `formatInstant`, Clock 인자). 결과 모양은 postgres `MigrationResult`와 같음. 기본 폴더·`SCHEMA_VERSION`은 story 11
- [x] `packages/sqlite/src/index.ts`, `packages/second_brain/{src/index.ts,package.json}` -- 공개 표면
- [x] `packages/sqlite/test/{store,write,migrate}.test.ts` + `test/fixtures/migrations/` + `test/fixtures/lock-holder.mjs` -- I/O 표 전 행, `storeContract`·`schemaStoreContract`를 실제 임시 파일(정상·없는 경로 둘 다)로, 두 프로세스 잠금 대기 실측(대기 ms를 출력하고 범위 단언)
- [x] 루트 `package.json` -- `engines.node: ">=24.16.0"`
- [x] 전체 -- `pnpm install && pnpm test` 통과, 실측값을 Implementation Notes에 기록

**Acceptance Criteria:**
- Given 빌드된 workspace, when `pnpm test`(테스트 DB 포함), then sqlite·postgres·core·cli 전 프로젝트가 통과하고 `boundaries` 검사도 통과한다.
- Given `second_brain`, when 타입 검사, then `sqliteStore`·`runSqliteMigrations`와 postgres 표면이 이름 충돌 없이 함께 재export된다.
- Given 두 프로세스 동시 쓰기 실측, when 끝나면, then 보유 시간·timeout별 실제 대기 ms와 NFR-7에 대한 함의가 Implementation Notes에 적혀 있다.

## Implementation Notes

### 두 프로세스 동시 쓰기 실측 (2026-10-14, node 24.16.0, macOS, APFS)

보유자는 별도 프로세스에서 `BEGIN IMMEDIATE` + `INSERT`를 잡고 지정 시간 뒤 `COMMIT`한다.
대기자는 `withWrite`(또는 같은 `begin immediate`)를 내고 실제 경과를 재었다.

| 보유 시간 | busy timeout | 결과 | 실제 대기 |
| --- | --- | --- | --- |
| 0ms (경쟁 없음) | 3000 | 성공 | 1ms |
| 300ms | 3000 | 성공 | 363ms |
| 400ms | 5000 | 성공(`withWrite`, 테스트가 출력) | 469ms |
| 1500ms | 3000 | 성공 | 1604ms |
| 2500ms | 10000 | 성공 | 2529ms |
| 2000ms | 500 | `DB_LOCKED`(errcode 5, `withWrite`, 테스트가 출력) | 548ms |
| 3500ms | 3000 | errcode 5 `database is locked` | 3148ms |

읽어낸 것:

- `busy_timeout`은 **실제로 대기한다.** 대기 시간은 보유 시간 + 30~100ms(스핀·재시도 간격)이고,
  초과하면 timeout + 30~150ms 뒤에 errcode 5로 끝난다. 즉 `DB_LOCKED`까지 걸리는 시간의
  상한은 사실상 timeout 값 그대로다.
- `BEGIN IMMEDIATE`가 BUSY로 끝나는 경우는 **timeout 초과 하나뿐**이다(리뷰 D-2가 걱정한
  "즉시 BUSY"는 DEFERRED의 승격 실패에서 나오고, IMMEDIATE에는 없다). 그래서 AD-9의
  "잠금 시간 초과 → spool" 문구는 `withWrite`에 대해 그대로 성립한다.
- **NFR-7에 대한 함의:** `node:sqlite`는 동기 API뿐이라 대기 중 프로세스 전체가 멈춘다.
  `BUSY_TIMEOUT_MS.turn = 3000`은 **최악의 경우 턴 경로를 3.1s 블록시킨다** — 시작 맥락
  목표에 그대로 더해진다. 실측상 개인 규모의 보유 시간(한 트랜잭션 = 한 배치 insert)은
  수 ms~수십 ms이므로 평균 대기는 1ms 수준이고, 3000은 "동시에 두 턴이 겹쳤을 때 spool로
  떨어지지 않게 하는" 여유로만 쓰인다. 다만 상한이 목표를 넘기면 turn 예산을 내리고
  spool로 더 빨리 보내는 쪽이 맞다 — 값이 Core 상수인 이유이고, epic 2가 spool을 붙일 때
  이 표가 그 조정의 근거다.
- 두 번째 writer가 **여러 파일을 순차로** 적용하는 마이그레이션이면 파일마다 다시 잠금을
  잡으므로, 보유 시간이 아니라 "파일 하나의 시간"이 대기 단위다. `runSqliteMigrations`가
  파일마다 `withWrite`를 여는 것이 여기에 유리하다.

### node:sqlite 실측 확인 (모두 이 구현이 의존하는 사실)

- `new DatabaseSync(new URL('file:…?mode=rw'))`는 없는 파일에 errcode 14(`SQLITE_CANTOPEN`)로
  실패하고 `brain.db`·`-wal`·`-shm` 중 **아무것도 만들지 않는다**(테스트가 폴더가 빈 것을 단언).
- `timeout` 옵션 = `busy_timeout`. `foreign_keys` 기본 1, `recursive_triggers` 기본 0 →
  둘 다 `openSqlite`에서 명시적으로 켠다.
- `StatementSync.columns().length > 0`이 Kysely의 `reader` 판정으로 정확하다
  (`select 1` → 1, DDL·`insert`·`begin immediate` → 0).
- `database.function('brain_redact_allowed', …)`은 trigger 본문에서 호출된다(`directOnly`
  기본값으로 충분). trigger를 **만들 때**도 함수가 등록된 연결이어야 한다.
- 번들 SQLite 3.53.0, FTS5 `trigram` 가상 테이블·바인딩 파라미터 `MATCH` 모두 동작.
- Kysely 0.29.6 + 약 25줄 어댑터로 `sql` 템플릿·`connection().execute`·`begin immediate`가
  전부 통과한다. `@types/node`의 입력값 타입 이름은 `SQLInputValue`(`SupportedValueType`가 아님).

### 설계상 적어 둘 것

- `sqliteStore`의 지연 연결은 **실패를 캐시하지 않는다.** 두 호출 사이에 설치가 끝났다면
  두 번째 호출이 찾아야 하기 때문이다.
- `runSqliteMigrations`는 마이그레이션 본문을 `connection.database.exec(statements)`로 낸다
  — 파일 하나에 문장이 여러 개이고 prepared statement는 하나뿐이다. 같은 `DatabaseSync`이므로
  열려 있는 `BEGIN IMMEDIATE` 안에서 실행되고, 실패하면 통째로 롤백된다(테스트가 확인).
- `runSqliteMigrations`가 잠금을 못 잡은 경우는 `DB_UNAVAILABLE`로 돌려준다(아무것도 적용되지
  않았으므로 `MIGRATION_FAILED`가 아니다).
- doctor는 이제 **불가 시 `db` 한 줄만** 낸다(`vector: skip` 줄이 사라졌다). Core는 어떤
  capability가 있는지 모르므로 탐침하지 않은 것에 대해 줄을 만들지 않는다. story 8이 재설계한다.

## Plan Change Log

- 2026-10-14 — 루트 `engines.node`를 `>=24.16.0`으로 올리자 `tooling/bootstrap/test/bootstrap.test.ts`의
  "asks for the same node major the entry point checks for"가 깨졌다(`>=24` 하드코딩).
  Code Map에 없던 파일이지만 같은 값의 두 번째 철자이므로 함께 고쳤다: 테스트를 "매니페스트의
  하한 major가 `MIN_NODE_MAJOR`와 같고, 그보다 더 엄격해도 된다"로 바꾸고 이유(진입점은 clone
  전에 돌아 minor를 알 수 없고, minor는 pnpm이 `engines`로 강제한다)를 주석으로 남겼다.
  진입점의 `MIN_NODE_MAJOR = 24`는 그대로다 — 그 재설계는 이 플랜의 범위가 아니다.
- 2026-10-14 — I/O 표의 "27글자 연도"는 `parseInstant`뿐 아니라 `formatInstant`에서도
  (`new Date(8.64e15)`) 거부되는 것으로 테스트를 썼다. 표의 의도("첫째만 왕복 성공")는 그대로다.

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 0 / medium 1 / low 5 / false 0 / maybe-false 0 / AC 3개 모두 충족(리뷰어가 전체 487개 재실행)

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `migrate.ts`: 두 번째 이후 파일에서 잠금 초과 시 앞 파일은 이미 커밋됐는데 "아무것도 안 됨" `DB_UNAVAILABLE`로 답한다 | low | patch | 코드 확인: 파일마다 `withWrite`를 따로 연다. 재실행은 멱등이라 피해는 오해뿐. 주석·메시지 수정 |
| 2 | `sqliteErrcode === 5`가 확장 결과 코드(BUSY_RECOVERY 261 등)를 놓친다 | low | patch | 리뷰어 실측: PK 위반이 1555로 온다(확장 코드 보고). `& 0xff` 한 줄 |
| 3 | `withWrite` 콜백 안에서 `connection.db`로 질의하면 Kysely 단일 연결 mutex에서 영원히 멈춘다 | low | patch | 리뷰어가 빌드본으로 재현. 현재 호출자 없음. 문서화로 막는다 |
| 4a | bootstrap 테스트 주석 "pnpm이 engines로 minor를 강제한다"가 거짓 | low | patch | 직접 실측: pnpm 12.11.2가 루트 `engines.node: >=24.99.0`인 프로젝트를 exit 0으로 설치. 주석과 README 7행 수정 |
| 4b | `>=24.16.0` 하한을 실제로 강제하는 곳이 없다(진입점은 major만) | medium | defer | 진입점 gate는 이 변경 전부터 major만 본다. node minor 점검은 story 8 doctor 몫(리뷰 D-1 4항) |
| 5 | WAL pragma 실패가 파일명 없는 `MIGRATION_FAILED`로 나온다 | low | 거절 | 사실이나 설치기에서만, 다른 프로세스가 비-WAL 파일을 쥐고 있을 때뿐. 수정은 분기 추가 |
| 6 | pragma 실패 경로의 `database.close()`가 던지면 `openSqlite`가 던진다 | low | 거절 | 방금 연 핸들의 close는 사실상 던지지 않는다. 일상에서 만나지 않음 |
| 7 | `setRedactAllowed`가 공개 인터페이스에 있어 "withWrite만 세운다"가 강제되지 않는다 | medium | patch | 코드 확인: `second_brain`까지 재export. 플랜 Always 규칙(NFR-1 유일 방어선). 공개 표면을 줄이는 수정 |

경로 요약: intent_gap 0, bad_plan 0, patch 5(1·2·3·4a·7), defer 1(4b), 거절 2(5·6).

패치 5건 적용 후 재검증(2026-10-14): build 정상, `pnpm test` 23개 파일 487개 통과(실제 DB), `compose down` 뒤 `dist/`·`node_modules/`·`*.db` 없음. 남은 공백: `migrate.ts`의 DB_LOCKED 분기(파일 사이 잠금 상실)는 테스트가 없다(주석·메시지만 바뀜).

## Design Notes

- 쓰기 통로는 Kysely의 단일 연결을 잡고 직접 트랜잭션 문장을 낸다:
  ```ts
  return db.connection().execute(async (c) => {
    await sql`begin immediate`.execute(c);
    try { const v = await work(c); await sql`commit`.execute(c); return { ok: true, value: v }; }
    catch (e) { await sql`rollback`.execute(c).catch(() => {}); throw e; }
  });
  ```
  `begin immediate` 자체가 BUSY로 실패하면 rollback 없이 `DB_LOCKED`. node:sqlite는 동기라 대기 중 프로세스 전체가 멈춘다 — 그래서 경로별 timeout이 Core 상수다.
- 탐침을 목록으로 둔 이유: SQLite(WAL·FTS5·FK)와 Postgres(pgvector)가 같은 칸을 쓰고, doctor는 이름을 모른 채 check로 옮긴다. story 8이 항목을 다시 짠다.
- 실행기가 폴더를 인자로 받는 이유: 실제 첫 마이그레이션은 story 11이다. 그때 기본 폴더와 `SCHEMA_VERSION`을 더한다.

## Verification

**Commands:**
- `pnpm install && pnpm build` -- expected: TS 오류 없음, `packages/sqlite/dist/index.js` 존재
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- `git status --short` -- expected: `dist/`·`node_modules/`·`*.db` 없음
