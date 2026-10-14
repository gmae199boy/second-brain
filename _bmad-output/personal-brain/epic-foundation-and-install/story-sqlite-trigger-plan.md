---
title: 'SQLite 첫 마이그레이션: 대화·로그 테이블과 불변 trigger'
type: 'feature'
ticket: '11'
created: '2026-10-14'
status: 'built'
baseline_revision: '7eeadafdb753c1ec7bcee5779e1aa80ccd58c88f'
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

**Problem:** `packages/sqlite`에는 쓰기 통로와 실행기만 있고 실제 스키마가 없다. 원문 불변(NFR-1)을 지키는 trigger, 멱등 키, 키워드 검색 색인이 원본 DB에 아직 없다.

**Approach:** `packages/sqlite/migrations/0001_initial.sql`로 Table Contract의 대화·로그 쪽 15개 테이블, UNIQUE 멱등 키, `messages`·`tool_notes`의 변경 거부 trigger(redact 표시 `brain_redact_allowed()`일 때 본문 칸만 통과), FTS5 trigram 색인 3개와 동기 trigger, 기본 `index_configs` chunk 행을 만든다. 실행기에 기본 폴더와 `SQLITE_SCHEMA_VERSION = 1`을 더한다.

## Boundaries & Constraints

**Always:**
- 테이블·컬럼 이름과 키는 `packages/postgres/migrations/0001_initial.sql`과 같다(복제 대상과 한 언어). 다른 점은 SQLite 표현뿐: id는 TEXT, 시각은 24글자 정규형 TEXT(GLOB CHECK), boolean은 `INTEGER CHECK (x in (0,1))`, `chunk_params`는 정규형 JSON TEXT. 모든 일반 테이블은 `STRICT`.
- 불변: `messages`·`tool_notes`의 DELETE는 언제나 거부. UPDATE는 표시가 있고 바뀐 칸이 `messages.body`/`tool_notes.target` 하나일 때만 통과. `INSERT OR REPLACE`·`on conflict do update`도 이 trigger에 막힌다(`recursive_triggers=ON`은 `openSqlite`가 이미 건다).
- FTS 행은 원본 행과 같은 트랜잭션에서 trigger가 쓴다. 가리기·`log.edit`·조각 삭제가 색인을 같이 바꾼다.
- 공개 이름은 `sqlite*`/`SQLITE_*` 접두사(second_brain에서 postgres의 `SCHEMA_VERSION`과 충돌 금지). `migrations/`를 package `files`에 넣는다.
- 기존 테스트(postgres·cli·sqlite)가 계속 통과한다.

**Never:**
- story 12의 테이블(files·work_items 등), redact 연쇄 함수 본체(epic 2), SessionStore(epic 2), 설치기·런타임 연결(story 13), doctor(story 8), `embeddings`, 다른 불변 테이블의 trigger(deferred에 있음).
- Postgres 마이그레이션 수정.
- Decision(2026-10-14): 플랜 크기(약 2,900 토큰)는 단일 목표이므로 분할하지 않고 전체를 유지한다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 실행 | 빈 경로, 기본 폴더 | `{from:0, to:1, applied:['0001_initial.sql']}`, 15개 테이블, WAL | — |
| 재실행 | 같은 파일 | `applied=[]`, 스키마·행 그대로 | — |
| 표시 없는 변경 | `messages` body UPDATE / DELETE / 충돌하는 `INSERT OR REPLACE` / `on conflict do update` (`tool_notes` 같음) | 거부, 행 그대로 | trigger `RAISE(ABORT)`, 메시지에 테이블 이름 + immutable |
| 표시 있는 가리기 | `withWrite(…, {redact:true})`로 body(target)만 UPDATE | 통과, FTS도 새 문장 | — |
| 표시 있어도 안 되는 것 | 표시 + 다른 칸 변경, 표시 + DELETE | 거부 | trigger |
| 롤백 뒤 | 표시 쓰기가 던져 롤백 | 이어진 일반 UPDATE 거부 | — |
| 멱등 키 | Table Contract의 UNIQUE 키마다 같은 키 두 번 | 둘째 거부, `on conflict do nothing`은 건수 그대로 | 제약 오류 |
| 시각·타입 | `2026-10-14T01:02:03Z`, REAL을 INTEGER 칸에 | 거부 | CHECK / STRICT |
| chunk_params | 기본 행과 같은 값·다른 키 순서, 기본 행 재삽입 | 키 순서 다름은 CHECK 거부, 같은 값은 무시 | CHECK / UNIQUE |
| 한국어 검색 | `chunks.body`·`log_entries.text`·`tool_notes.target`에 `어제 결정한 저장소 방향` | `"저장소"` MATCH가 찾음. 조각 삭제·로그 문장 수정 뒤 옛 문장은 안 찾음 | — |

</frozen-after-approval>

## Code Map

- `packages/postgres/migrations/0001_initial.sql` -- 컬럼·키·CHECK의 원천. 그대로 옮기되 Postgres 전용(`unique nulls not distinct`, plpgsql, `brain_redact_message`, truncate trigger, gin 색인)은 SQLite 형태로 바꾼다. `redactions."end"`는 SQLite에서도 키워드라 인용한다.
- `packages/sqlite/src/connect.ts` -- `brain_redact_allowed()` 등록, `recursive_triggers=ON`. 변경 없음. trigger를 **만드는** 연결에도 함수가 등록돼 있어야 하는데 실행기가 `openSqlite`로 여니 충족된다.
- `packages/sqlite/src/write.ts` -- `withWrite(conn, work, {redact:true})`가 표시를 세운다. 테스트는 이것만으로 표시를 세운다.
- `packages/sqlite/src/migrate.ts` -- `directory`를 선택으로 바꾸고 기본값은 `new URL('../migrations/', import.meta.url)`(src·dist 모두 한 단계 위). `SQLITE_SCHEMA_VERSION = 1` export. 기본 폴더일 때 가장 큰 파일 번호가 상수와 다르면 버그로 던진다. "story 11에서 온다" 주석 정리.
- `packages/sqlite/src/index.ts` -- `SQLITE_SCHEMA_VERSION`, 기본 폴더 상수(`SQLITE_MIGRATIONS_DIRECTORY`) export. `second_brain`은 `export *`라 따라온다.
- `packages/sqlite/package.json` -- `files`에 `migrations`.
- `packages/sqlite/test/migrate.test.ts` -- 145행 근처 주석("SCHEMA_VERSION은 story 11") 갱신. 픽스처 폴더 테스트는 그대로.
- `packages/postgres/test/migrate.test.ts` -- 테스트 구성 참고(표 구동 UNIQUE 사례 821행~, CHECK 863행~, trigger 420행~). 값은 `ChunkParams` 기본 `{targetChars:1200, overlapMessages:1, splitMessagesOverChars:2400}`(`packages/postgres/src/setup.ts` `DEFAULT_CHUNK_PARAMS`).
- 실측(2026-10-14, node 24.16.0, SQLite 3.53.0, 스크래치): 아래 Design Notes의 trigger·FTS·CHECK 형태가 모두 기대대로 동작함을 확인했다 — STRICT가 REAL→INTEGER 거부, GLOB CHECK가 `…03Z` 거부, 충돌 REPLACE가 DELETE trigger에 막힘, upsert가 UPDATE trigger에 막힘, 표시 + 대상 칸만 통과, external-content FTS5 trigram이 `"저장소"`를 찾고 가리기 뒤 옛 문장은 안 찾음, `json_object` 재구성 CHECK가 키 순서 다른 값을 거부.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0001_initial.sql` -- 15개 STRICT 테이블(FK, Postgres와 같은 CHECK, 시각 GLOB CHECK), `index_configs`의 `coalesce` 표현식 UNIQUE + `chunk_params` 정규형 CHECK, 불변 trigger 4개, FTS5 테이블 3개와 동기 trigger, 기본 chunk 행(고정 UUIDv7 리터럴) -- 원본 스키마
- [x] `packages/sqlite/src/migrate.ts`, `src/index.ts`, `package.json` -- 기본 폴더, `SQLITE_SCHEMA_VERSION`, 번호 일치 검사, export, `files` -- 실행기를 실제 스키마에 연결
- [x] `packages/sqlite/test/schema.test.ts` -- I/O 표 전 행. UNIQUE 키는 Table Contract의 15개 테이블 키 전부를 표 구동으로. 테이블 목록은 `sqlite_schema`에서 FTS 그림자 테이블을 뺀 일반 테이블이 정확히 15개. `SQLITE_SCHEMA_VERSION`이 폴더의 가장 큰 번호. -- 검증
- [x] `packages/sqlite/test/migrate.test.ts` -- 낡은 주석 갱신 -- 정리
- [x] 전체 -- `pnpm build && pnpm test` 통과

**Acceptance Criteria:**
- Given 기본 폴더로 마이그레이션한 새 DB, when `sqliteStore`가 `readSchemaVersion`과 `checkHealth`를 하면, then 버전 1과 `wal`·`fts5-trigram`·`foreign-keys` 탐침 모두 ok.
- Given 가린 메시지(표시 + body UPDATE)와 그 FTS, when `messages`·`chunks_fts`·`tool_notes_fts`를 덤프하면, then 지운 문자열이 tool_notes·FTS 어디에도 없다.
- Given `second_brain`, when 빌드하면, then 이름 충돌(TS2308) 없이 `SQLITE_SCHEMA_VERSION`이 노출된다.

## Implementation Notes

### 플랜에서 조정한 것 (의도는 그대로)

- **일반 테이블 15개 세기는 `pragma_table_list`로 한다.** 플랜은 "`sqlite_schema`에서 FTS
  그림자 테이블을 뺀" 이라고 했는데, 그림자 테이블은 이름 규칙(`*_fts_data` 등)으로만 걸러낼
  수 있어 FTS 테이블 이름이 바뀌면 조용히 틀린다. `pragma_table_list`는 같은 것을 `type`으로
  말해 준다(`table` / `virtual` / `shadow`). 같은 질의로 `strict = 0`인 일반 테이블이 하나도
  없다는 것까지 단언한다 — STRICT는 빠뜨려도 아무 말이 없는 종류의 실수라서.
- **불변 trigger 메시지는 테이블 이름 + `immutable` + 빠져나갈 길 한 줄.** 테스트는 Postgres
  쪽과 같은 `/<table>[\s\S]*immutable/`로 본다.
- **truncate trigger는 없다.** SQLite에 `truncate` 문이 없고, 그 자리를 대신하는
  `delete from t` 최적화는 delete trigger가 있는 테이블에서 아예 꺼진다(행마다 trigger가
  돈다). Postgres의 truncate trigger 두 개에 대응하는 것이 이것이라 마이그레이션 주석에
  적어 두었다.

### 실측 (2026-10-14, node 24.16.0, SQLite 3.53.0)

플랜 Code Map의 스크래치 실측을 실제 마이그레이션 파일로 다시 돌려 모두 재현했다. 테스트가
단언하는 것 외에 확인한 것:

- `insert or replace`는 **delete trigger**에 막히고(`recursive_triggers = ON`이 없으면 REPLACE가
  trigger를 건너뛰므로 `openSqlite`의 pragma가 여기서 값을 한다), `on conflict do update`는
  **update trigger**에 막힌다. 둘의 오류 메시지가 다르다는 것이 어느 쪽으로 들어왔는지를 말해 준다.
- trigram 토크나이저는 **세 글자부터** 찾는다. `"저장소"`(3자)는 찾고 `"방향"`(2자)은 못 찾는다
  — 한국어 검색 테스트의 needle이 낱말인 이유다.
- **FTS5의 기본 `delete`는 묘비만 남긴다.** MATCH는 0을 돌려주지만 지운 문장의 trigram은
  나중에 segment가 병합될 때까지 `*_fts_data` 블록에 그대로 있다(실측: 가리기 뒤 `345`를 품은
  블록이 1 → 2로 **늘었다**). 세 가상 테이블 모두 만든 직후
  `insert into <f>(<f>, rank) values ('secure-delete', 1)`을 걸어 덮어쓰게 했고, 같은 실측에서
  0이 된다. 테스트는 MATCH만이 아니라 블록 개수도 단언한다(AD-11).
- `json_extract`가 들어간 CHECK는 정규형이 아닌 JSON을 **키 순서·공백 양쪽 모두** 거부한다.
  잘못된 JSON은 CHECK 실패가 아니라 `malformed JSON` 오류로 끝나는데, 어느 쪽이든 행은 안 들어간다.
- `search_rowid`는 `chunks`·`log_entries`·`tool_notes`의 **primary key**가 되고 `id`는 `unique`가
  된다. `log_entry_edits.log_entry_id`와 `log_entries.supersedes_id`의 FK가 `id`를 가리키는데,
  SQLite는 UNIQUE 인덱스가 있는 칸이면 FK 대상으로 받으므로 그대로 성립한다.

### 남겨 둔 것

- 기본 `index_configs` 행을 마이그레이션이 넣으므로, **story 13이 SQLite 설치 경로에서
  `ensureDefaultIndexConfig` 단계를 빼야 한다**(Design Notes에 적힌 그대로, 이 스토리 범위 밖).
- `redactions`·`log_entry_edits` 등 Table Contract상 불변인 다른 테이블의 trigger는
  `deferred-work.md`에 그대로 남아 있다.

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 1 / medium 1 / low 2 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | FTS5 기본 delete 모드라 가리기·조각 삭제 뒤에도 `*_fts_data` 블록에 지운 문자열의 trigram이 남는다(AC 2, AD-11 위반). 테스트는 MATCH만 본다 | high | patch | 직접 재현: secure-delete 없이 블록 2개에 `qzx`, 켜면 0개. FTS 테이블마다 `secure-delete` 켜고 `_fts_data` 단언 추가 |
| 2 | 기본 폴더 버전 검사가 문자열 비교라 끝 `/` 없는 같은 폴더면 건너뛴다 | low | patch | 코드 확인: `fileURLToPath(new URL('../migrations/'))`는 `/`로 끝남. `resolve` 비교로 한 줄 수정 |
| 3a | SQL 머리말의 "Postgres와 같은 스키마"가 tool_notes trigger에서는 사실이 아니다 | low | patch | 코드 확인. 머리말에 차이 한 문장 |
| 3b | Postgres 복제본은 tool_notes UPDATE를 모두 거부해 가린 target을 복제할 수 없다 | medium | defer | 이번 변경 전부터 있던 Postgres trigger(story 1.3). deferred-work.md에 기록, epic 7 |

경로 요약: intent_gap 0, bad_plan 0, patch 3(1·2·3a), defer 1(3b).

패치 3건 적용 후 재검증(2026-10-14): build 정상, `pnpm test` 24개 파일 532개 통과(실제 PG 포함), `compose down` 뒤 `dist/`·`node_modules/`·`*.db` 없음. 3a 머리말은 구현자가 쓴 이유(Postgres가 tool_notes를 `brain_redact_message`로 쓴다)가 사실과 달라 직접 고쳤다 — Postgres 함수는 messages 본문만 가린다.

## Design Notes

- **FTS는 external content + 정수 rowid 별칭.** `chunks`·`log_entries`·`tool_notes`는 `search_rowid integer primary key`와 `id text not null unique`를 가진다. 암묵 rowid는 `VACUUM`(과 백업용 `VACUUM INTO`)이 다시 매길 수 있어 FTS 연결이 깨지므로 명시 별칭이 필요하다. `search_rowid`는 adapter 내부 칸이라 도메인 타입·Table Contract 키에 들어가지 않고, 내보내기는 싣지 않는다(복구 뒤 FTS `rebuild`). 본문을 FTS에 한 번 더 복사하지 않는다.
  ```sql
  create virtual table tool_notes_fts using fts5(target, content='tool_notes',
    content_rowid='search_rowid', tokenize='trigram');
  create trigger tool_notes_fts_au after update of target on tool_notes begin
    insert into tool_notes_fts(tool_notes_fts, rowid, target) values ('delete', old.search_rowid, old.target);
    insert into tool_notes_fts(rowid, target) values (new.search_rowid, new.target);
  end;
  ```
  `chunks`·`log_entries`는 insert·update·delete 셋, `tool_notes`는 insert·update(가리기)만.
- **불변 trigger**는 `before update … when not (brain_redact_allowed() and <body/target 외 모든 칸 is old>)`와 `before delete` 둘. 표시는 Postgres처럼 행 id가 아니라 프로세스의 boolean이다(한 가리기 트랜잭션이 여러 행을 바꿀 수 있다). trigger는 코드 실수를 막는 장치이지 악의적 SQL 방어가 아니다(AD-11).
- **기본 chunk 행은 마이그레이션이 넣는다**(티켓). Postgres는 설치기가 넣었으므로 story 13이 SQLite 경로에서 그 단계를 빼야 한다. 정규형 CHECK `chunk_params = json_object('targetChars', …, 'overlapMessages', …, 'splitMessagesOverChars', …)`가 Postgres jsonb의 "값으로 같으면 충돌"을 대신한다(다른 순서는 아예 거부).
- `schema_version`은 `id integer primary key check (id = 1)`, `version`, `applied_at` — 실행기의 `on conflict (id)` 모양 그대로.

## Verification

**Commands:**
- `pnpm build` -- expected: TS 오류 없음, `packages/sqlite/dist/index.js` 존재
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- `git status --short` -- expected: `dist/`·`node_modules/`·`*.db` 없음
