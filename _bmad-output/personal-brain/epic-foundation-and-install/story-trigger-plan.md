---
title: '첫 마이그레이션과 원문 불변 trigger'
type: 'feature'
ticket: '3'
created: '2026-10-13'
status: done
baseline_revision: '594cbb9f670f982f8d20f6b9c6fd7b805cb9cc73'
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

**Problem:** DB에 테이블이 없다. Table Contract의 멱등 키와 원문 불변(AD-11)이 DB 차원에서 강제되지 않으면, epic 2 이후의 수집·로그 코드가 중복을 넣거나 원문을 바꿔도 막을 수 없고 지울 수도 없다.

**Approach:** `packages/postgres`에 순번 SQL 마이그레이션 `0001`과 이를 적용하는 `runMigrations()`를 둔다. `0001`은 embeddings를 뺀 Table Contract 전 테이블·UNIQUE 키·`schema_version`, `messages`·`tool_notes`의 변경 거부 trigger, 유일한 우회 경로인 SQL 함수 `brain_redact_message`와 `redactions`를 만든다.

## Boundaries & Constraints

**Always:**
- 컬럼 이름은 `packages/core/src/domain/*.ts` 필드의 `snake_case`. 모든 PK는 `uuid`(기본값 없음, AD-8), 시각은 `timestamptz`.
- 멱등 키는 Table Contract 표 그대로 UNIQUE. null이 섞이는 키(`index_configs`)는 `unique nulls not distinct`.
- `messages`·`tool_notes`: BEFORE UPDATE/DELETE row trigger와 BEFORE TRUNCATE statement trigger가 거부한다. 예외는 `brain_redact_message` 안의 `messages.body` UPDATE 하나뿐이고, 다른 컬럼이 바뀌면 그 경로도 거부한다.
- `brain_redact_message`는 한 트랜잭션에서 body의 코드 포인트 `[start, end)`를 `[REDACTED:<kind>]`로 바꾸고 `redactions`에 위치·종류·지운 텍스트의 sha256 hex만 남긴다. 지운 텍스트는 어디에도 저장하지 않는다.
- `runMigrations`는 advisory lock 아래에서 현재 `schema_version`보다 큰 파일만 파일마다 한 트랜잭션으로 적용하고, 같은 트랜잭션에서 버전을 올린다. 연결·쿼리 실패는 던지지 않고 `DB_UNAVAILABLE` 값으로 돌려준다. 파일 읽기·연결은 호출 안에서만(AD-3).
- 테스트는 실제 DB(`createTestDatabase`), mock 없음.
- Decision(2026-10-13): 플랜 크기(약 2,500 토큰)는 단일 목표이므로 분할하지 않고 전체를 유지한다.

**Never:**
- `embeddings` 테이블과 `vector` 확장 생성(AD-15, 임베딩을 켤 때 만든다).
- CLI·SDK에서 `runMigrations`를 부르는 것. 호출자는 story 5의 `setup run`이다(AD-20).
- `SessionStore` 구현, `messages.redact` SDK 함수, 런타임 버전 확인(story 4), doctor 스키마 항목(story 6).
- 되돌리기(down) 마이그레이션, ORM 마이그레이션 도구.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 적용 | 빈 DB | `{ ok:true, from:0, to:1, applied:['0001_initial.sql'] }`, 15개 테이블, `embeddings` 없음 | — |
| 재실행 | 이미 1 | `{ ok:true, from:1, to:1, applied:[] }`, 스키마 변화 없음 | — |
| 동시 실행 | 빈 DB에 두 번 병렬 | 둘 다 ok, 적용은 한 번, `schema_version` 한 행 | lock 대기 |
| 수정·삭제 | `messages`/`tool_notes`에 UPDATE·DELETE·TRUNCATE | 실패, 메시지에 테이블 이름과 `immutable` | 행 그대로 |
| 가리기 | `brain_redact_message(id, msg, 6, 12, 'api_key', t)` | body가 `[REDACTED:api_key]` 포함, `redactions` 1행(hash = 지운 부분 sha256) | — |
| 잘못된 가리기 | 범위 밖·`start>=end`·없는 메시지 | 예외, body·`redactions` 변화 없음 | 트랜잭션 롤백 |
| 중복 키 | 키가 같은 두 번째 INSERT | unique violation(`23505`) | — |
| DB 다운 | 닫힌 포트 | `{ ok:false, code:'DB_UNAVAILABLE', message }`, 5초 안 | 던지지 않음 |

</frozen-after-approval>

## Code Map

- `packages/postgres/src/store.ts` -- `pg.Pool`+timeout 설정, `describe(error)`(빈 message 대비)를 재사용한다. `HealthStore` 반환 타입은 바꾸지 않는다.
- `packages/postgres/package.json` -- `files`에 `migrations` 추가. 새 의존성 없음.
- `packages/core/src/domain/*.ts` -- 컬럼의 원천. `Session.cursor` → `last_harness_message_id`·`cursor_fingerprint`, `TranscriptFile.cursor`도 같은 두 컬럼, `IndexConfig.chunkParams` → `chunk_params jsonb`. 타입에 없는 컬럼이 필요하면 타입에도 더한다(story 2 Design Notes).
- `tooling/test-db/src/index.ts` -- `createTestDatabase({ installVector:false })`로 vector 없는 DB에서도 마이그레이션이 되는지 본다.
- `packages/postgres/test/store.test.ts` -- `closedPort()` 패턴을 복사해 쓴다.
- AD-15: 키워드 검색용 `pg_trgm` 확장과 `chunks.body`·`log_entries.text`·`tool_notes.target` GIN trgm 인덱스는 `0001`에 넣는다(Conventions: 확장·인덱스도 SQL).

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0001_initial.sql` -- `pg_trgm`, 15개 테이블(FK 포함, CHECK: `role`, `kind`, `rule_state`는 `kind='rule'`일 때만, `ingest_source`, `start_source`, `redactions` `0<=start<end`), UNIQUE 키, trgm 인덱스, 불변 trigger 함수·trigger, `brain_redact_message`, `schema_version` 단일 행(`id boolean primary key check (id)`) -- 스키마 원천
- [x] `packages/postgres/src/migrate.ts` -- `runMigrations({ databaseUrl, connectTimeoutMs? })` → `MigrationResult`. `migrations/` 폴더를 `import.meta.url` 기준으로 호출 시 읽고 `^\d{4}_.+\.sql$`를 순번 정렬, `pg_advisory_xact_lock`, `schema_version` 없으면 0. `SCHEMA_VERSION = 1` export -- 실행 함수
- [x] `packages/postgres/src/index.ts` -- `runMigrations`, `SCHEMA_VERSION`, 결과 타입 export -- 공개 표면
- [x] `packages/postgres/test/migrate.test.ts` -- I/O 표 전 행. 중복 키는 Table Contract의 UNIQUE 키 전부를 표 구동 테스트로. `SCHEMA_VERSION`이 가장 큰 파일 번호와 같음. trigger 우회: GUC 없이 body UPDATE 거부, 함수 경유 시 다른 컬럼 변경 불가 -- 검증
- [x] `packages/core/src/domain/*.ts` -- SQL에 생긴 컬럼과 어긋나는 필드만 맞춘다 -- 공통 언어 유지
- [x] 전체 -- `pnpm test` 통과 -- 마무리

**Acceptance Criteria:**
- Given 테스트 PG, when `pnpm test`, then 기존 테스트와 새 마이그레이션 테스트가 모두 통과한다.
- Given 마이그레이션된 DB, when `information_schema.tables`를 조회하면, then Table Contract에서 `embeddings`를 뺀 15개 테이블이 정확히 있다.
- Given 가린 메시지, when `redactions`와 `messages`를 전부 덤프하면, then 지운 원문 문자열이 어디에도 없다.

## Implementation Notes

- `migrations/0001_initial.sql`: `pg_trgm` + 15개 테이블 + trgm 인덱스 3개 + 불변 trigger 함수 둘(`brain_reject_mutation`, `brain_reject_truncate`) + `brain_redact_message`. `vector` 확장을 쓰지 않으므로 `createTestDatabase({ installVector:false })` DB에도 적용된다.
- `redactions.end`는 Postgres 예약어라 컬럼을 `"end"`로 인용했다(`start`는 비예약어라 그대로). 컬럼 이름 자체는 도메인 필드의 snake_case를 유지한다.
- TRUNCATE: Postgres가 FK 선검사를 trigger보다 먼저 하므로 `truncate messages` 단독은 `redactions` FK 오류로 막히고 trigger 메시지가 나오지 않는다. `truncate messages cascade`·`truncate messages, redactions`는 trigger가 막는다. 테스트는 trigger에 닿는 형태로 "테이블 이름 + immutable"을 확인하고, 단독 형태는 "실패한다"만 확인한다.
- `src/connect.ts`를 새로 뽑아 `createPool`과 `describe(error)`를 `store.ts`·`migrate.ts`가 공유한다. `PostgresStoreOptions`는 `ConnectionOptions` 별칭이 되었고 모양·`HealthStore` 반환 타입은 그대로다.
- `runMigrations`는 `queryTimeoutMs: 0`으로 pool을 만든다. lock 대기와 긴 DDL은 정당하게 오래 걸릴 수 있으므로 예산은 연결에만 둔다. 닫힌 포트는 연결 거부가 즉시 나므로 "5초 안에 `DB_UNAVAILABLE`"은 그대로 성립한다(테스트로 확인).
- 파일마다 `begin` → `pg_advisory_xact_lock` → 저장된 버전 재확인 → 적용 + 버전 갱신 → `commit`. 같은 트랜잭션에서 재확인하므로 병렬 두 실행이 한 번만 적용한다.
- Decision(2026-10-13): `packages/core/src/domain/*.ts`는 바꿀 것이 없었다. 모든 필드가 컬럼에 대응하고(커서는 Code Map대로 2컬럼, `chunkParams` → `chunk_params jsonb`), 반대로 타입에 없는 컬럼은 `schema_version.id boolean` 하나뿐인데 이는 단일 행을 강제하는 저장 장치여서 도메인 필드로 올리지 않았다.
- `second_brain`은 `export *`이므로 `runMigrations`·`SCHEMA_VERSION`이 묶음 표면에 자동으로 따라온다. 부르는 쪽은 story 5의 `setup run`뿐이고(AD-20) 이번 범위에서 호출자는 없다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-13, lens: quick) — high 0 / medium 3 / low 5 / false 0 / maybe-false 0 / 1건 거절

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `migrate.ts`가 도달 가능한 DB의 쿼리 실패(깨진 마이그레이션 등)도 `DB_UNAVAILABLE`로 돌려준다 | medium | defer | 리뷰어 재현: 충돌 테이블이 있는 DB에서 `relation "workspaces" already exists`가 `DB_UNAVAILABLE`로 나옴. frozen Boundaries가 "연결·쿼리 실패는 `DB_UNAVAILABLE`"로 정했으므로 이 빌드에서 바꾸지 않는다. 결과를 사람에게 보이는 story 5(`setup run`)에서 `MIGRATION_FAILED` 같은 별도 코드로 다룬다 |
| 2 | 마이그레이션 파일이 비면 `{ ok:true, from:0, to:0 }`을 돌려준다 | medium | patch | 리뷰어 재현(빈 폴더). `files` 배포가 `dist`와 분리돼 생길 수 있는 포장 버그. `readMigrationFiles`에서 마지막 번호가 `SCHEMA_VERSION`이 아니면 throw |
| 3 | `redactions.start/end`가 주석·도메인 타입의 "저장된 본문 위"가 아니라 가리기 직전 본문 위의 위치다 | medium | patch | 테스트 기대값 `[11,24)`가 가린 뒤 본문의 마커와 맞지 않음. 이후 가리기가 위치를 밀므로 불변 행에서 안정적인 정의는 "가리기 직전 본문"뿐. 주석(SQL·`redaction.ts`)만 고친다 |
| 4 | 동시 실행 테스트가 적용 순서에 의존한다 | low | patch | 파일이 둘이 되면 `['0002','0001']`도 정상. 정렬 후 비교 |
| 5 | `redactions` 등 다른 불변 테이블은 trigger가 없다 | low | defer | AD-11과 Intent가 trigger 대상을 `messages`·`tool_notes`로 한정. 가리기 증거 행의 보호 여부는 별도 결정 사항 |
| 6 | cursor 짝 CHECK 두 개에 테스트가 없다 | low | patch | CHECK 표 구동 테스트에 두 케이스 추가 |
| 7 | `transcript_files.size_bytes bigint`가 node-pg에서 문자열로 읽혀 `sizeBytes: number`와 어긋난다 | low | defer | 읽는 코드가 아직 없고, 이 행을 읽는 adapter(epic 2)가 형 변환 또는 `integer` 축소를 정한다 |
| 8 | `connect.ts`의 `connectTimeoutMs` 주석이 마이그레이션의 쿼리 무제한과 어긋난다 | low | patch | `migrate.ts`가 `queryTimeoutMs: 0`을 넘김. 주석만 고친다 |
| 9 | 세션 FK 컬럼에 인덱스가 없다 | — | 거절 | 결함이 아닌 미래 제안. 이 플랜은 인덱스를 AD-15 trgm으로 한정했고, 조회 패턴이 생기는 스토리가 다음 마이그레이션으로 더한다 |

경로 요약: intent_gap 0, bad_plan 0, patch 5(2·3·4·6·8), defer 3(1·5·7), 거절 1(9).

패치 5건 적용 후 재검증(2026-10-13): `pnpm test` 8개 파일 153개 통과, `compose down` 뒤 볼륨 없음.

## Design Notes

- 우회 경로: 함수가 `set_config('brain.redacting', <message id>, true)`로 트랜잭션 지역 표시를 켜고 UPDATE한 뒤 끈다. trigger는 표시가 그 행 id와 같고 `body` 외 컬럼이 그대로일 때만 통과시킨다. trigger는 코드 실수를 막는 장치이지 악의적 SQL 방어가 아니다(AD-11 Prevents).
  ```sql
  if tg_op = 'UPDATE' and tg_table_name = 'messages'
     and current_setting('brain.redacting', true) = old.id::text
     and (new.*) is not distinct from (old.*) -- body만 제외하고 비교
  ```
- 위치는 Postgres `text` 문자 단위(UTF-8 DB에서 코드 포인트)라 Conventions의 `[start, end)`와 같다. `substr`은 1부터 센다.
- `vector` 확장을 마이그레이션이 요구하지 않으므로 pgvector 없는 DB에도 적용된다. doctor가 pgvector를 따로 보고한다.

## Verification

**Commands:**
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres npx pnpm@12.10.1 test` -- expected: 전 프로젝트 통과
- `docker compose -f compose.test.yaml down` -- expected: 볼륨 없음
- `git status --short` -- expected: `dist/`·`node_modules/` 없음
