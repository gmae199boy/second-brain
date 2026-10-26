---
title: 'SQLite 두 번째 마이그레이션: 파일·첨부·추출·일감 스키마'
type: 'feature'
ticket: '12'
created: '2026-10-14'
status: done
baseline_revision: '3c4c5425d97005d4b6f5156b22f317f332c04235'
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

**Problem:** 원본 DB(`packages/sqlite`)에는 대화·로그 테이블(0001)만 있고, 첨부 원본·파일 위치·문서 추출·drain 일감을 둘 자리가 없다. epic 2·4는 이 스키마 위에 동작을 얹는다.

**Approach:** `packages/sqlite/migrations/0002_files_and_work.sql`로 Table Contract의 나머지 8개 테이블(`work_items`, `files`, `file_locations`, `message_attachments`, `document_extractions`, `document_chunks`, `file_names`, `file_metadata`)과 멱등 키, `files`·`file_locations`의 변경 규칙 trigger(가리기 표시는 0001의 `brain_redact_allowed()` 그대로), FTS5 trigram 색인 2개(`document_chunks.body`, `file_names.text`), `index_configs`의 `kind` 확장과 기본 `document_chunk` 행을 만든다. `SQLITE_SCHEMA_VERSION = 2`.

## Boundaries & Constraints

**Always:**
- 0001의 표현 규칙 그대로: 모든 일반 테이블 `STRICT`, id는 TEXT UUIDv7, 시각은 24글자 정규형 GLOB CHECK, boolean은 `integer check in (0,1)`, FTS는 external content + `search_rowid integer primary key` + 동기 trigger + `secure-delete`. 컬럼은 Table Contract의 키·작성자·변경 가능성을 지키되 나머지는 이 플랜(Design Notes)이 정한다.
- 멱등 키: `work_items`는 **미완료 행만** `(kind, target_kind, target_id)` 유일(부분 UNIQUE 인덱스, `completed_at is null`). `document_extractions`는 파일당 같은 `extractor_version`의 **진행 중**(`finished_at is null`) 세대 하나. 나머지는 Table Contract의 UNIQUE 그대로.
- 변경 규칙(trigger): `files`는 `home_location_id`·`current_extraction_id`만 자유, `redacted_at`은 표시가 있을 때 null→값 한 번만, 그 밖의 칸 변경과 DELETE는 거부. `home_location_id`는 같은 파일의 `brain` 위치만, `current_extraction_id`는 같은 파일의 세대만 가리킨다. `file_locations`는 `verified_at`·`deleted_at`만 채울 수 있고(`ownership`·locator 등 나머지 불변) DELETE 거부. 다른 새 테이블에는 불변 trigger를 두지 않는다(AD-11의 범위, story 11과 같은 선).
- `index_configs`의 `kind` CHECK 확장은 SQLite가 CHECK를 바꿀 수 없으므로 **같은 트랜잭션 안에서 temp 테이블에 담고 drop·재생성**한다(`pragma defer_foreign_keys = ON`; `chunks`의 FK는 이름으로 다시 성립한다, 실측 확인). 기본 chunk 행(id 끝 `…0001`)과 그것을 가리키는 `chunks` 행은 그대로 남는다.
- 기본 `document_chunk` 행의 id는 고정 리터럴 `019a0000-0000-7000-8000-000000000002`.
- 공개 이름은 `SQLITE_*` 접두사. 기존 테스트(postgres·cli·sqlite·core)가 계속 통과한다. 0001 파일은 손대지 않는다(앞으로만).

**Never:**
- 동작: 일감 청구·drain, `FileStore` port·로컬 구현, 첨부 수집, 추출, `files.redact` 연쇄(모두 epic 2·4). 설치기·런타임 연결(story 13), doctor(story 8), `embeddings`, Postgres 마이그레이션 수정(복제 대상은 epic 7에서 따라온다).
- Core 도메인 타입 추가(`IndexConfigKind`·파일 타입은 그 행을 읽는 epic 4·2가 만든다).
- `redactions`에 파일 가리기 자리(`file_id`)를 두지 않는다. Decision(2026-10-14): `files.redact`를 만드는 epic 2가 그때 0003으로 정한다(`deferred-work.md`에 기록).
- Decision(2026-10-14): 기본 `document_chunk` 행의 `chunk_params`는 문서 전용 모양 `{"targetChars":1200,"overlapChars":120}`이다. CHECK가 kind별로 모양을 고정하고, Core 타입은 epic 4가 이 행을 읽을 때 만든다.
- Decision(2026-10-14): 플랜 크기(약 6,500 토큰)는 단일 목표(마이그레이션 한 파일)이므로 분할하지 않고 전체를 유지한다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 첫 실행 | 빈 경로, 기본 폴더 | `{from:0, to:2, applied:['0001_initial.sql','0002_files_and_work.sql']}`, 일반 테이블 23개 모두 STRICT | — |
| 재실행 | 같은 파일 | `applied=[]`, 스키마·행 그대로 | — |
| 1→2 업그레이드 | 0001만 적용된 DB에 기본 chunk 행을 가리키는 `chunks` 행이 있음 | `{from:1,to:2,applied:['0002…']}`, `index_configs` 2행(기존 id 유지), `chunks` 행 유지, `pragma foreign_key_check` 빈 결과, `index_configs_key_idx` 존재 | — |
| 멱등 키 | 8개 테이블 각각 같은 키 두 번 | 둘째 거부, `on conflict do nothing`은 건수 그대로 | UNIQUE 오류 |
| 일감 재등록 | 같은 `(kind,target_kind,target_id)` 미완료 행이 있을 때 / 완료(`completed_at`) 뒤 | 있으면 거부 / 완료 뒤 새 행 허용 | 부분 UNIQUE |
| 추출 세대 | 같은 파일·같은 버전의 진행 중 세대가 있을 때 / 끝난 뒤 | 거부 / 허용. `status`와 `finished_at`은 함께 null이거나 함께 값 | 부분 UNIQUE / CHECK |
| files 변경 | 표시 없이 `content_hash`·`size_bytes` 변경, DELETE; `redacted_at` 세우기 | 거부 | trigger `RAISE(ABORT)`, 메시지에 테이블 이름 + immutable |
| files 허용 변경 | `home_location_id`→같은 파일의 brain 위치, `current_extraction_id`→같은 파일의 세대; 표시 + `redacted_at` null→값 | 통과 | — |
| files 가리키기 오류 | `home_location_id`→external 위치 또는 다른 파일의 위치; `current_extraction_id`→다른 파일의 세대; 표시 + `redacted_at` 값→null 또는 값→다른 값; 표시 + 다른 칸 함께 변경 | 거부 | trigger |
| file_locations | `ownership`·`locator` 변경, DELETE / `verified_at`·`deleted_at` 채우기 | 거부 / 통과 | trigger |
| 첨부 상태 | `status='stored'`인데 `file_id` null, `status='missing_at_ingest'`인데 `file_id` 있음 | 거부. 둘 다 null(아직 안 채움)은 허용 | CHECK |
| 타입 | `content_hash`가 `sha256:` + 소문자 hex 64자가 아님, `file_metadata.key='captured_at'`의 값이 정규형이 아님, 시각 `…03Z`, 청구 3칸이 일부만 채워짐 | 거부 | CHECK / STRICT |
| document_chunk 행 | 마이그레이션 뒤 조회 / 같은 값 다른 키 순서 / `kind='chunk'`에 문서 모양 / 기본 행 재삽입 | 정확한 텍스트 1행 / 거부 / 거부 / 무시 | CHECK / UNIQUE |
| 한국어 검색 | `document_chunks.body`·`file_names.text`에 `어제 받은 회의록 초안` | `"회의록"` MATCH가 찾음. 행 삭제·수정 뒤 옛 문장은 안 찾히고 `*_fts_data` 블록에도 없다 | — |

</frozen-after-approval>

## Code Map

- `packages/sqlite/migrations/0001_initial.sql` -- 표현 규칙의 원천(머리말, GLOB CHECK, `index_configs` 정의 195~213행, 불변 trigger 332~372행, FTS + secure-delete 385~443행, 기본 chunk 행 457~459행). 0002는 이 문체·주석 밀도를 따른다. **수정하지 않는다.**
- `packages/sqlite/src/migrate.ts` -- `SQLITE_SCHEMA_VERSION = 1`(19행)을 2로. 실행기는 파일마다 `withWrite`(BEGIN IMMEDIATE) 안에서 `database.exec(statements)`를 돌리므로 0002 안의 `pragma defer_foreign_keys = ON`은 그 트랜잭션에만 걸린다. 그 외 변경 없음.
- `packages/sqlite/src/connect.ts` -- `brain_redact_allowed()` 등록, `foreign_keys=ON`, `recursive_triggers=ON`. 변경 없음.
- `packages/sqlite/src/write.ts` -- `withWrite(conn, work, {redact:true})`가 표시를 세운다. 테스트는 이것만으로 표시를 세운다.
- `packages/sqlite/test/schema.test.ts` -- `EXPECTED_TABLES`(22~37행)에 8개 추가, `migratedPath()`(99~104행)의 기대를 `to:2`와 두 파일로. 나머지는 그대로. 헬퍼(`scratch`/`open`/`insert`/`count`/`matches`/`blocksHolding`/`tableNames`, 92~160·283~292행)는 새 테스트 파일이 같은 모양으로 가진다(공유 모듈로 빼지 않는다).
- `packages/sqlite/test/schema-files.test.ts` -- 새 파일. I/O 표 전 행. 1→2 사례는 스크래치 폴더에 0001만 복사해 돌린 뒤 기본 폴더로 다시 돌린다.
- `packages/sqlite/test/store.test.ts`·`migrate.test.ts` -- 자체 픽스처 폴더를 쓰므로 영향 없음.
- `packages/core/src/domain/index-config.ts` -- `IndexConfigKind = 'chunk' | 'embedding'`. 이 스토리에서는 손대지 않는다(Never). 0002 주석이 DB가 더 넓다는 사실과 이유를 적는다.
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` -- AD-21(work_items 칸 목록), AD-23(파일·위치·소유·home·검증), AD-24(추출 세대·상태·조각 위치·file_names·EXIF 3칸), Table Contract(키·변경 규칙).
- 실측(2026-10-14, node 24.16.0, 스크래치): `chunks` 행이 기본 config를 가리키는 상태에서 `defer_foreign_keys` + temp stash + drop + 재생성 + 재삽입이 한 트랜잭션에서 commit되고 `foreign_key_check`가 비며 `chunks`의 FK 문구가 그대로다. 부분 UNIQUE 인덱스가 완료 뒤 재등록을 허용한다. `files`↔`file_locations` 순환 FK는 선언·삽입·갱신이 된다. kind별 `case` CHECK가 키 순서·다른 모양을 거부한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0002_files_and_work.sql` -- 8개 STRICT 테이블(Design Notes의 칸), 부분 UNIQUE 2개 + `work_items` due 인덱스, `files`·`file_locations` trigger 6개, FTS5 2개 + secure-delete + 동기 trigger, `index_configs` 재생성(kind 3종, kind별 chunk_params 정규형 CHECK, `index_configs_key_idx` 재생성), 기본 `document_chunk` 행 -- 원본 스키마
- [x] `packages/sqlite/src/migrate.ts` -- `SQLITE_SCHEMA_VERSION = 2` -- 실행기를 새 버전에 맞춘다
- [x] `packages/sqlite/test/schema.test.ts` -- `EXPECTED_TABLES` 23개, `migratedPath` 기대 갱신 -- 기존 검증 유지
- [x] `packages/sqlite/test/schema-files.test.ts` -- I/O 표 전 행. UNIQUE 키는 8개 테이블 표 구동. 1→2 업그레이드 사례. FTS는 MATCH와 `*_fts_data` 블록 개수 모두 -- 검증
- [x] 전체 -- `pnpm build && pnpm test` 통과

**Acceptance Criteria:**
- Given 기본 폴더로 마이그레이션한 새 DB, when `sqliteStore`가 `readSchemaVersion`과 `checkHealth`를 하면, then 버전 2와 모든 탐침 ok.
- Given `pragma_table_list`, when 일반 테이블을 세면, then 정확히 23개이고 `strict = 0`인 것이 없다.
- Given 표시 아래 `redacted_at`을 세우고 그 파일의 세대·조각을 지운 트랜잭션, when `document_chunks_fts`·`file_names_fts`를 덤프하면, then 지운 조각의 문자열이 어디에도 없다.

## Implementation Notes

- 0002는 플랜대로 한 파일: 8개 STRICT 테이블, 부분 UNIQUE 2개(`work_items_open_key_idx`, `document_extractions_open_idx`) + `work_items_due_idx`, trigger 6개(`files` 불변·home·extraction + DELETE, `file_locations` 불변 + DELETE), FTS5 2개(`document_chunks_fts`, `file_names_fts`, 각각 `secure-delete` + ai/ad/au trigger), `index_configs` 재생성(`pragma defer_foreign_keys = ON` → temp stash → drop → 재생성 → `index_configs_key_idx` 재생성 → 재삽입), 기본 `document_chunk` 행. `0001_initial.sql`은 손대지 않았다.
- `files.content_hash` CHECK은 `'sha256:'`에 `[0-9a-f]` 64개를 `||`로 8줄에 걸쳐 이어 붙였다(0001이 시각 glob을 전부 적는 문체와 같게). GLOB은 대소문자를 구분하므로 대문자 hex는 거부된다.
- 플랜에 없던 조정 하나: `test/schema.test.ts`의 "default chunk config" 단정은 `index_configs` 전체를 조회해 1행을 기대했으므로 0002의 둘째 행 때문에 깨진다. `where kind = 'chunk'`로 좁혀 0001의 행만 그 파일이 지키고, `document_chunk` 행은 새 파일이 지킨다(주석으로 적었다). 그 밖에는 `EXPECTED_TABLES` 23개와 `migratedPath()` 기대(`to:2`, 두 파일)만 바꿨다.
- `test/schema-files.test.ts`는 헬퍼를 공유하지 않고 같은 모양으로 다시 가진다(플랜대로). I/O 표 14행 전부 + Acceptance 3개를 덮는다: 1→2 업그레이드(0001만 복사한 폴더 → 기본 폴더, `chunks` 행 유지·`foreign_key_check` 빈 결과·`index_configs_key_idx` 존재), 8개 테이블 멱등 키 표 구동, 일감 재등록, 추출 세대, `files`·`file_locations` 변경 규칙, 첨부 상태, 타입, `document_chunk` 행, 한국어 MATCH + `*_fts_data` 블록.
- 리뷰 반영(2026-10-14): trigger는 6개가 아니라 8개다 — `before update of`는 포인터를 이미 들고 들어오는 INSERT를 보지 못하므로 `files_home_check_insert`·`files_extraction_check_insert`를 같은 `when`·같은 메시지로 추가했다. `file_locations`의 `verified_at`·`deleted_at`은 `files.redacted_at`과 같은 한 방향 채우기(null→값 한 번)로 좁혔고, `message_attachments_file_check`는 `(file_id is not null) = (status is 'stored')`로 바꿨다(상태 없는 내용도 거부). `index_configs` 복원 insert는 컬럼을 양쪽에 적는다. 주석 세 곳(가리기가 포인터는 건드려도 된다는 사실, Postgres 목록이 짧은 이유)과 `captured_at` 테스트의 대상 파일도 고쳤다.
- 실측 확인: `drop`/재생성이 마이그레이션 실행기의 한 트랜잭션(`BEGIN IMMEDIATE`) 안에서 commit되고, `chunks`의 FK 문구는 `index_configs`를 그대로 가리킨다. `pnpm build` 통과, `BRAIN_TEST_DATABASE_URL`을 준 `pnpm test`가 25파일 584테스트 통과(sqlite 131).

## Plan Change Log

## Review Triage Log

### Pass 1 (2026-10-14, lens: quick) — high 0 / medium 2 / low 6 / false 0 / maybe-false 0

| # | 발견 | 판정 | 경로 | 증거 |
| --- | --- | --- | --- | --- |
| 1 | `files_home_check`·`files_extraction_check`가 `before update of`뿐이라 INSERT로는 다른 파일·external 위치를 가리키는 포인터가 들어간다 | medium | patch | diff 352~374행 확인: insert trigger 없음. frozen Always는 규칙을 무조건으로 적는다. 같은 `when`의 `before insert` trigger 2개 + 테스트 |
| 2 | `file_locations.verified_at`·`deleted_at`을 null로 되돌릴 수 있어 trigger 메시지("filled in")·Table Contract("채움")와 어긋난다 | medium | patch | diff 386~396행: 두 칸은 `when`에 없음. epic 8의 이전 경로는 `verified_at`을 "검증했다"는 증거로 쓴다(AD-23 "검증 없이 지우는 경로는 없다"). `redacted_at`과 같은 null→값 한 방향 조건 추가 |
| 3 | 0002 주석(316~326행)·테스트 주석(645행)이 "가리기는 다른 칸과 함께 못 바뀐다"고 하지만 두 포인터는 자유롭다(테스트 자신이 `current_extraction_id = null`을 함께 바꾼다) | low | patch | 코드·테스트 확인. 주석만 사실대로 고친다(포인터는 자유, 내용 4칸만 고정) |
| 4a | `schema.test.ts` 16~21행 주석이 "Postgres 테스트와 같은 목록"이라 하지만 23 vs 15 | low | patch | `packages/postgres/test/migrate.test.ts` 15개. 주석 한 문장 수정 |
| 4b | `index_configs`의 kind·CHECK가 원본·복제본 사이에서 갈라졌는데 어디에도 기록이 없다 | low | defer | 설계상 복제본은 epic 7이 따라온다(0002 머리말). deferred-work에 기록 |
| 5a | `message_attachments_file_check`가 `file_id` 있고 `status` null인 행을 허용해 주석("content under any other status 금지")과 다르다 | low | patch | 실측(리뷰어)·CHECK 식 확인. CHECK를 `(file_id is not null) = (status is 'stored')`로 직접 교정 + 테스트 행 |
| 5b | 새 테이블 5개(message_attachments·document_extractions·document_chunks·file_names·file_metadata)의 Table Contract 변경 규칙이 trigger로 강제되지 않는 결정이 기록되지 않았다 | low | defer | 플랜 Never의 의도적 결정(AD-11 범위). story 11의 deferred 항목을 넓혀 기록 |
| 6 | `insert into index_configs select * from index_configs_stash`가 위치 기반이라 칸 순서가 바뀌면 값이 섞인다 | low | patch | 지금은 맞다(5칸 같은 순서). 칸 이름을 적는 직접 교정 |
| 7 | `captured_at` 타입 사례가 `(file_id, key)` 중복과 겹쳐 CHECK가 먼저 평가돼 통과한다 | low | patch | 시드 219~224행과 같은 `(fileA, captured_at)`. `fileB`로 바꾼다 |
| 8 | `document_chunks`·`document_extractions`에 `index_config_id`가 없어 기본 `document_chunk` 행을 가리키는 것이 없고 조각 params 세대를 구별할 수 없다 | low | defer | 사실(Design Notes의 칸 그대로). 연결은 읽는 쪽(epic 4)이 세대(`document_extractions`)에 `alter table add column`으로 붙이는 것이 맞고 지금은 읽는 코드가 없다. deferred-work에 기록 |

경로 요약: intent_gap 0, bad_plan 0, patch 7(1·2·3·4a·5a·6·7), defer 3(4b·5b·8).

패치 7건 적용 후 재검증(2026-10-14): `pnpm build` 정상, Postgres 컨테이너 포함 `vitest run` 25개 파일 589개 통과(sqlite 136개, 새 사례 4개), `compose down` 뒤 `git status`에 `dist/`·`node_modules/`·`*.db` 없음. defer 3건은 `deferred-work.md`에 기록했다.

## Design Notes

- **칸 목록** (키·시각 CHECK·FK는 0001 문체로):
  - `work_items`: `id`, `kind`, `target_kind`, `target_id`, `created_at`, `attempts integer not null default 0 check (>= 0)`, `next_attempt_at not null`, `claimed_at`, `claim_expires_at`, `claimed_by`, `last_error`, `completed_at`. CHECK: 청구 3칸은 모두 null이거나 모두 값. 인덱스: `work_items_open_key_idx (kind, target_kind, target_id) where completed_at is null` (UNIQUE), `work_items_due_idx (next_attempt_at) where completed_at is null`.
  - `files`: `id`, `content_hash unique` + `glob 'sha256:' || 64×[0-9a-f]`, `size_bytes integer not null check (>= 0)`, `first_seen_at not null`, `home_location_id references file_locations (id)`, `current_extraction_id references document_extractions (id)`, `redacted_at`. 미디어 종류는 내용으로 판정한 **세대**의 속성이라 `document_extractions.media_type`에 둔다(AD-24).
  - `file_locations`: `id`, `file_id not null`, `store_kind check in ('local','drive')`, `locator not null`, `ownership check in ('brain','external')`, `first_seen_at not null`, `source_modified_at`, `uploaded_at`, `remote_checksum`, `verified_at`, `deleted_at`. locator는 local이면 루트 기준 상대 경로, drive면 파일 ID(AD-23) — 주석으로만.
  - `message_attachments`: `id`, `message_id not null`, `ordinal integer not null check (>= 0)`, `source_kind not null`(parser가 정하는 값이라 CHECK 없음), `source_ref`, `display_name`, `file_id references files`, `status check (null or in ('stored','missing_at_ingest'))`, CHECK `status is null or ((status = 'stored') = (file_id is not null))`.
  - `document_extractions`: `id`, `file_id not null`, `extractor_version not null`, `media_type`, `status check (null or in ('ok','failed','unsupported','too_large','redacted'))`, `started_at not null`, `finished_at`, `error`. CHECK `(finished_at is null) = (status is null)`. UNIQUE `(file_id, extractor_version) where finished_at is null`.
  - `document_chunks`: `search_rowid integer primary key`, `id unique`, `extraction_id not null`, `ordinal integer not null`, `page integer`, `body not null`. UNIQUE `(extraction_id, ordinal)`.
  - `file_names`: `search_rowid`, `id unique`, `file_id not null`, `name_source check in ('location_path','attachment_name')`, `"text" not null`. UNIQUE `(file_id, name_source, "text")`.
  - `file_metadata`: `id`, `file_id not null`, `key not null`, `value not null`. UNIQUE `(file_id, key)`. CHECK `key <> 'captured_at' or value glob <정규형>`(EXIF의 `captured_at_local`·`captured_at_source`는 원문 그대로, AD-24).
- **files trigger** 골격(0001의 `is` 비교 그대로):
  ```sql
  create trigger files_immutable_update before update on files
    when not (new.id is old.id and new.content_hash is old.content_hash
              and new.size_bytes is old.size_bytes and new.first_seen_at is old.first_seen_at
              and (new.redacted_at is old.redacted_at
                   or (brain_redact_allowed() = 1 and old.redacted_at is null and new.redacted_at is not null)))
  begin select raise(abort, 'files is immutable: ...'); end;
  create trigger files_home_check before update of home_location_id on files
    when new.home_location_id is not null and not exists (
      select 1 from file_locations where id = new.home_location_id and file_id = new.id and ownership = 'brain')
  begin select raise(abort, 'files.home_location_id must be a brain-owned location of the same file'); end;
  ```
  `files_extraction_check`는 같은 꼴로 `document_extractions.file_id = new.id`. `file_locations_immutable_update`는 `verified_at`·`deleted_at` 외 모든 칸 `is old`. DELETE trigger 둘.
- **index_configs 재생성**: `pragma defer_foreign_keys = ON; create temp table index_configs_stash as select * from index_configs; drop table index_configs; create table index_configs (… kind in ('chunk','embedding','document_chunk'), chunk_params CHECK는 `case when kind = 'document_chunk' then <문서 모양> else <0001의 세 키> end`) strict; create unique index index_configs_key_idx …; insert into index_configs select * from index_configs_stash; drop table index_configs_stash;` 그 뒤 `document_chunk` 행 삽입. 주석에 왜 rename이 아니라 drop인지(`legacy_alter_table=OFF`의 rename은 `chunks`의 FK 문구를 따라 바꾼다) 적는다.
- **`document_chunk` 행**: `insert into index_configs values ('019a0000-0000-7000-8000-000000000002', 'document_chunk', null, null, '{"targetChars":1200,"overlapChars":120}')`. 문서 모양 CHECK는 `chunk_params = json_object('targetChars', json_extract(chunk_params, '$.targetChars'), 'overlapChars', json_extract(chunk_params, '$.overlapChars'))`.

## Verification

**Commands:**
- `pnpm build` -- expected: TS 오류 없음
- `docker compose -f compose.test.yaml up -d --wait && BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test; docker compose -f compose.test.yaml down` -- expected: 전 프로젝트 통과
- `git status --short` -- expected: `dist/`·`node_modules/`·`*.db` 없음
