---
title: 'baseline 0001 완성: 나머지 core 표와 규칙이 PG에 있다'
type: 'feature'
ticket: '2'
created: '2026-10-28'
status: done
baseline_revision: '41df88f72913db09bd64266abd753b979bb5ceca'
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
      `brain.redacting` GUC를 brain_app이 세우면 document_chunks 삭제 규칙(열린·현재 세대 보호)을 건너뛸 수 있다.
    evidence: |-
      0001의 document_chunks_delete_rule_fn은 current_setting('brain.redacting', true) = 'on'이면 검사를 건너뛴다. 사용자 정의 GUC는 어떤 세션이든 set으로 세울 수 있고, brain_app은 document_chunks DELETE 권한을 가진다(세대 교체에 필요). 가리기 권한 경계와 제한된 정리 경로는 E11-6(티켓 5) 범위다.
    location: >-
      packages/postgres/migrations/0001_initial.sql (brain.document_chunks_delete_rule_fn)
    severity: medium
---

<intent-contract>

## Intent

**Problem:** PG baseline `packages/postgres/migrations/0001_initial.sql`에는 11.1이 넣은 수집 경로 표 14개(+ setup이 만드는 `schema_migrations`)만 있다. 나머지 core 표 11개와 SQLite 0004~0009의 규칙·키·색인이 없어 뒤 스토리(3·4·5·6)가 PG에서 Store verb를 만들 수 없다.

**Approach:** 같은 0001에 표 11개(`log_entries`·`log_entry_edits`·`index_configs`·`chunks`·`context_injections`·`document_extractions`·`document_chunks`·`file_names`·`file_metadata`·`schedules`·`settings`)와 `files.current_extraction_id`, SQLite 최종 스키마와 같은 수준의 키·CHECK·plpgsql trigger·TRUNCATE 방어·색인·seed 행을 더한다. 규칙은 직접 SQL 시험으로 확인한다.

## Boundaries & Constraints

**Always:**
- 의미의 기준은 SQLite 0001~0009를 다 적용한 최종 스키마다(`packages/sqlite/migrations/`). 형식 변환: text id → `uuid`, ISO 시각 text → `timestamptz`(SQLite의 시각 glob CHECK는 옮기지 않음), `search_rowid`와 FTS virtual table·FTS 동기화 trigger는 옮기지 않는다.
- 기존 11.1 표·trigger·권한 문장은 고치지 않는다. 바꾸는 것은 `files`에 `current_extraction_id uuid` 열 추가(FK는 뒤의 `alter table`), `brain_app`의 `files` 열 UPDATE 권한에 `current_extraction_id` 추가뿐이다.
- 규칙 위반은 예외(trigger의 `raise exception` 또는 CHECK·NOT NULL·UNIQUE 위반)로 거부한다. trigger 오류 문장은 기존처럼 `<trigger 이름>: invariant refused` 꼴로 표 이름이 들어간다.
- 가리기 표시는 기존과 같은 트랜잭션 로컬 GUC `current_setting('brain.redacting', true) = 'on'`이다(SQLite `brain_redact_allowed()` 자리).
- AD-22: `DEFAULT now()`·serial·identity·sequence·대소문자 무시 collation을 두지 않는다(기존 상수 default `0` 두 개는 그대로).
- 0001의 checksum은 아직 고정하지 않는다(10에서 고정). `CORE_SCHEMA_VERSION`은 1 그대로다.

**Never:**
- Store verb·adapter 코드(`packages/postgres/src/`)를 고치지 않는다. 표를 쓰는 verb는 3·4·5·6이 만든다.
- `log_entries`·`log_entry_edits`·`context_injections`·`index_configs`의 불변 trigger와 `context_injections.kind`·`elapsed_ms`는 넣지 않는다(SQLite에도 없음. 로그 표는 epic-log-and-context E3-8이 자기 마이그레이션으로 가져간다).
- SQLite FTS 내부 블록 검사, 0002 이하 SQLite 업그레이드용 stash·재작성 절차를 옮기지 않는다.
- 새 transcript 원문 짝 열(`*_raw`)을 만들지 않는다(아래 Design Notes).
- SQLite 코드·시험, `apps/cli`, `plugin/app-ref`·plugin version을 바꾸지 않는다. 문서·커밋에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 빈 DB 적용 | `prepareDatabase` 뒤 `runMigrations` | `brain` 일반 표 26개, 명명 UNIQUE 5개, `lower(col)` trgm GIN 5개, `index_configs` seed 2행 | 없음 |
| locator 필수 | `document_chunks.chunk_locator` null | 거부 | NOT NULL 위반 |
| locator 형태 | JSON 아님 / 배열 / `type` 목록 밖 / pdf인데 `page` 열 ≠ locator `page` / pdf 아닌데 `page` 열 값 | 거부(오류는 CHECK 위반이지 형 변환 오류가 아님) | CHECK 위반 |
| locator 정상 | `{"type":"pdf","page":3,...}`+`page=3`, `{"type":"text","start":0,"end":5}`+`page=null` | 저장, 되읽은 text가 넣은 문자열과 바이트 단위로 같음 | 없음 |
| failed_stage 강제 | `status='failed'`로 넣거나 바꾸면서 `failed_stage` null | 거부 | 예외 |
| 0008 matrix | SQLite `schema-0008.test.ts` 네 case와 같은 데이터·동작 | 같은 허용/거부(가리기 표시 안팎 포함) | 예외 |
| 반복 예약 | `interval_seconds` 값 + `next_run_at` null / `interval_seconds <= 0` | 거부. 한 번짜리(`interval_seconds` null)는 `next_run_at` null 허용 | CHECK 위반 |
| TRUNCATE | 불변 규칙 표 8개 | 거부(`truncate refused`) | 예외 |
| 불변 표 UPDATE·DELETE | 기존 11.1 규칙과 Design Notes의 새 규칙이 금지한 변경 | 거부, 허용 변경(열린 세대 진행 등)은 통과 | 예외 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0001_initial.sql` -- 고칠 유일한 제품 파일. 기존 표(`:6`~`:219`), 명명 색인(`:221`~`:226`), trigger 함수 꼴(`:228`~`:401`), `brain.refuse_truncate()`와 TRUNCATE trigger(`:402`~`:408`), 권한(`:409`~`:416`). 새 trigger 함수도 같은 꼴(`create function brain.<name>_fn() ... language plpgsql`)로 쓴다.
- 의미 기준(읽기만): SQLite 최종 정의. `packages/sqlite/migrations/0001_initial.sql:456`(chunk seed), `0002_files_and_work.sql:553`(`index_configs_key_idx`), `:572`(document_chunk seed), `0004_capture_columns.sql:139`(locator CHECK), `:156`(locator 필수), `:277`·`:316`(`document_extractions_running_idx`), `0005_identity_and_records.sql:326`(failed_stage 강제), `0006_drop_message_seq.sql:185`·`:210`(log_entries·chunks 최종), `0008_attachment_rules.sql`(8개 규칙), `0009_schedules.sql`(schedules·`schedules_due_idx`). 전체를 한 번에 보려면 node로 0001~0009를 메모리 DB에 적용해 `sqlite_master`를 덤프한다.
- `packages/core/src/domain/index-config.ts:9,25,80` -- `ChunkParams`·`DocumentChunkParams` 키, `DOCUMENT_CHUNK_INDEX_CONFIG_ID`.
- `packages/core/src/domain/chunk-locator.ts` -- Core 정규형(type 첫 키, 공백 없음, null 생략). DB는 정규형 바이트를 검사하지 않고 Core가 맡는다.
- `packages/sqlite/test/schema-0008.test.ts:13-138` -- PG로 옮길 0008 matrix(데이터·기대 그대로, `withWrite(..., { redact: true })` 자리는 PG 트랜잭션의 `set local brain.redacting = 'on'`).
- `packages/postgres/src/setup.ts:36-47` -- `schema_migrations` 생성과 `brain_app` 기본 권한(select·insert·update·delete). 고치지 않는다.
- `packages/postgres/test/fixture.ts` -- `database()`(소유자 URL `db.url`, 앱 URL `db.appUrl`, `db.query`·`db.rows`). `packages/postgres/test/store.test.ts:29` -- 기존 불변·TRUNCATE·GUC 위장 시험의 꼴.
- `packages/postgres/test/migrate.test.ts:20` -- 0001 적용·checksum 시험. 그대로 통과해야 한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0001_initial.sql` -- Design Notes의 표 11개·`files.current_extraction_id`·키·CHECK·trigger·TRUNCATE 방어·색인·seed·권한을 더한다 -- E11-3
- [x] `packages/postgres/test/schema.test.ts`(새) -- 카탈로그 검사(표 26개 이름 목록, 명명 UNIQUE 5개, `lower(col)`+`gin_trgm_ops` GIN 다섯, seed 2행, default·identity·generated·sequence 없음)와 I/O 매트릭스 전 행의 직접 SQL 시험(0008 matrix 네 case 포함). 소유자 연결로 규칙을 시험하고, 가리기 표시는 한 트랜잭션 안의 `set local` -- 검증 기준

**Acceptance Criteria:**
- Given 빈 시험 DB, when `prepareDatabase`와 `runMigrations`를 돌리면, then `brain` schema 일반 표가 정확히 26개(기존 15 + 새 11)이고, 명명 UNIQUE가 `users_self_idx`·`tool_notes_call_id_idx`·`work_items_open_key_idx`·`document_extractions_running_idx`·`index_configs_key_idx`이며, `chunks.body`·`log_entries.text`·`tool_notes.target`·`document_chunks.body`·`file_names.text`에 `lower(col)` `gin_trgm_ops` GIN이 있다.
- Given 같은 DB, when 시험이 카탈로그를 읽으면, then `brain` 표의 어떤 열 default도 함수(`now`·`nextval`·`current_timestamp` 등)를 부르지 않고, identity·generated 열과 sequence가 없다.
- Given 같은 DB, when 규칙 시험(불변 표의 UPDATE·DELETE·TRUNCATE 거부, 0008 matrix, failed_stage 강제, 반복 예약 null 금지, chunk_locator CHECK)을 돌리면, then 모두 통과한다.
- Given 전체 저장소, when `pnpm test`, then build·typecheck와 기존 PG(11.1·11.14)·Core·SQLite 시험을 포함한 모든 시험이 통과한다.

## Implementation Notes

- 리뷰 수정: `file_names`·`file_metadata`의 INSERT·UPDATE trigger 네 경로가 대상 `files` 행의 `redacted_at`을 읽을 때 `FOR SHARE`로 잠근다. 아직 가리지 않은 행도 잠가 동시 가리기 UPDATE와 파생물 쓰기가 직렬화되도록 했다. 두 연결 회귀 시험은 각 경로에서 가리기가 먼저 잠그면 쓰기가 대기 후 거부되고, 파생 쓰기가 먼저 잠그면 가리기가 커밋까지 대기하는 것을 `pg_blocking_pids`로 확인한다.
- 리뷰 수정 검증은 요청된 범위만 실행했다: `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/schema.test.ts` 통과(1 file, 12 tests). `git diff --check`도 통과했다.

- `0001_initial.sql`에 나머지 core 표 11개, `files.current_extraction_id`와 같은 파일 포인터 FK·trigger, JSONB config 키 및 숫자 CHECK, locator text CHECK·NOT NULL, 추출 세대·파생물 변경 규칙, 새 TRUNCATE 방어 2개, UNIQUE·due·검색 GIN 색인과 seed 2행을 추가했다. 기존 11.1 정의는 `files` 열 및 해당 UPDATE 열 권한 추가만 변경했다.
- `schema.test.ts`에서 소유자 연결의 직접 SQL로 표 26개 이름, 명명 UNIQUE 5개, `lower(col)` trgm GIN 5개, seed, 상수 default 2개와 identity·generated·sequence 부재를 확인한다. locator 오류 SQLSTATE와 바이트 보존, failed_stage, 0008 네 case, 같은 파일 포인터, 진행 중 추출 유일성, 반복 예약, config 동등성, 기존 원문 변경 및 8개 표 TRUNCATE 거부를 시험한다. 예상 실패는 savepoint로 격리하고 가리기 표시는 같은 트랜잭션의 `set local`을 사용한다.
- `pnpm`이 PATH에 없어 계획에 명시한 `npx --yes pnpm@12` 대체 명령을 사용했다. `npx --yes pnpm@12 build` 및 `npx --yes pnpm@12 exec vitest run --project postgres` 통과: 9 files, 111 tests. `npx --yes pnpm@12 test`도 build·typecheck 포함 전체 통과: 109 files, 2938 tests (68.02s). `git diff --check`도 통과했다.
- 알려진 한계는 계획과 같다. `brain.redacting` GUC를 호출자가 세울 수 있어 `brain_app`의 document chunk 삭제 권한 경계는 티켓 5에서 마감한다. baseline checksum 고정과 기존 개발 DB 재생성은 티켓 10 및 기존 계획의 정책을 따른다.

- 검토 수정 뒤 `npx --yes pnpm@12 test`를 다시 실행해 build·typecheck 및 109 files, 2942 tests 전체 통과(68.25s)를 확인했다. quick review 지적 1건은 수정 완료했고, 새로 유예한 항목은 없다.

- 추가 검토 수정: `document_chunks_delete_rule_fn`은 추출 세대의 `file_id`로 파일 PK를 조회하고 `FOR SHARE`로 잠근 뒤 기존 삭제 조건을 판단한다. 두 연결에서 current 포인터 게시와 조각 삭제의 경합을 `pg_blocking_pids`로 확인하고 게시 커밋 뒤 정확한 거부 메시지를 검증했다. TRUNCATE trigger 8개를 카탈로그에서 개별 확인하고, 닫힌 세대의 기존 config 변경 거부 메시지·`brain_app` 포인터 권한·`chunk`/`embedding` CHECK 시험을 보강했다. `npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/schema.test.ts`만 실행해 1 file, 14 tests 통과했다. 전체 검증과 커밋은 사용자에게 남겼으며 frontmatter는 변경하지 않았다.

## Plan Change Log

## Review Triage Log

- `high` → `patch`: `file_names`·`file_metadata`의 네 가리기 trigger는 파일 행을 잠그지 않아, 별도 트랜잭션의 가리기가 미커밋인 동안 예전 `redacted_at = NULL`을 읽고 새 파생물을 남길 수 있다. FK의 KEY SHARE는 비키 열 갱신과 충돌하지 않으므로 파일 행을 SHARE로 잠근 상태에서 가리기 여부를 검사하고 두 연결 회귀 시험으로 확인한다.

### 2026-10-28 — Review pass
- 참고: 위 항목은 구현 세션이 스스로 돌린 검토(이 워크플로의 렌즈 밖) 기록이다. 이 pass는 thorough 렌즈 4개(blind-hunter, edge-case-hunter, verification-gap, intent-alignment)의 결과다.
- verdicts: 15 findings — high 0, medium 4, low 6, false 5, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind-hunter) `document_chunks_delete_rule`이 `files` 행을 잠그지 않고 current 포인터를 읽어, READ COMMITTED에서 다른 트랜잭션이 커밋 전에 그 세대를 current로 게시하는 동안 조각을 지울 수 있다 — 같은 파일 행을 `FOR SHARE`로 잠근 뒤 판단하도록 고쳤고, 두 연결 시험(`refuses chunk deletion after a concurrent transaction publishes its generation`)이 대기 뒤 거부를 확인한다.
  - `[low]` `[patch]` (blind-hunter) 같은 trigger가 `files.current_extraction_id = e.id`로 색인 없는 전체 조회를 조각마다 한다 — 같은 파일 포인터 규칙에 기대 `f.id = e.file_id` PK 조회로 바꿨다(위 수정과 같은 함수).
  - `[low]` `[patch]` (blind-hunter) `truncate … cascade` 시험은 다른 보호 표의 trigger로도 통과해 표별 방어를 증명하지 못한다 — `pg_trigger`에서 8개 표 각각의 BEFORE TRUNCATE `brain.refuse_truncate` trigger를 확인하는 단언을 더했다.
  - `[low]` `[patch]` (blind-hunter) 닫힌 세대의 `index_config_id` 변경 시험이 없는 config id를 써서 FK 오류로도 통과한다 — seed config `019a…0001`과 정확한 `document_extractions_immutable_update: invariant refused` 메시지로 바꿨다.
  - `[medium]` `[patch]` (blind-hunter) `brain_app`의 `files.current_extraction_id` UPDATE 권한이 시험되지 않는다 — verification-gap 1번과 같은 원인. 앱 연결로 같은 파일 포인터 성공·되읽기, 다른 파일 포인터 거부, `redacted_at` 동시 변경의 권한 거부를 시험한다.
  - `[low]` `[reject]` (blind-hunter) locator 거부를 INSERT로만 시험한다 — PG의 NOT NULL·CHECK는 INSERT와 UPDATE에 같은 제약으로 적용되어 따로 갈라지는 쓰기 경로가 없다. 회귀 가능성이 낮고 시험 행렬 추가는 직접 수정이 아니다.
  - `[medium]` `[patch]` (blind-hunter) `chunk`/`embedding` 쪽 `chunk_params` CHECK 분기의 부정 시험이 없다 — verification-gap 2번과 같은 원인. 두 kind 각각 키 누락·여분 키·문자열 값의 23514 거부와 유효한 `embedding` 행 허용을 더했다.
  - `[low]` `[reject]` (blind-hunter) `log_entries`·`context_injections`·`chunks`·`file_metadata`의 새 CHECK가 이름으로만 확인된다 — diff를 SQLite 최종 정의와 대조해 같은 식임을 확인했다. 티켓 verify 목록 밖이고, 그 표를 쓰는 verb 스토리(3·4, 로그 epic)의 계약 시험이 다시 덮는다. 추가 시험 행렬은 직접 수정이 아니다.
  - `[medium]` `[patch]` (edge-case-hunter) current 포인터 게시와 조각 삭제의 경합 — blind-hunter 1번과 같은 원인, 같은 수정.
  - `[medium]` `[patch]` (verification-gap, pre-verified) `brain_app` 포인터 UPDATE 권한 검증 없음 — blind-hunter 5번과 같은 수정.
  - `[medium]` `[patch]` (verification-gap, pre-verified) 대화 config 검증의 부정 시험 없음 — blind-hunter 7번과 같은 수정.
  - `[false]` `[reject]` (intent-alignment) SQLite의 압축 표기 검사(`json(x) = x`)가 빠져 공백 있는 locator를 받는다 — 티켓은 `chunk_locator text`와 JSON object CHECK만 요구한다. 정규형 바이트는 Core 코덱이 만들고 decode가 검사한다(AD-24). 결함이 아니라 의도된 범위다.
  - `[medium]` `[defer]` (intent-alignment) `brain.redacting`은 호출자가 세울 수 있어 `brain_app`이 위장하면 `document_chunks` 삭제 규칙을 건너뛴다 — 가리기 권한 경계는 E11-6(티켓 5)이 정한다. frontmatter `deferred`에 기록했다.
  - `[false]` `[reject]` (intent-alignment) 불변을 표 전체 거부가 아니라 표별 규칙으로 구현했다 — SQLite 0008·Table Contract의 변경 가능성 규칙과 같다. 결함이 아니다.
  - `[false]` `[reject]` (intent-alignment) tag evidence trigger와 `tool_notes` GIN은 새 시험이 직접 찌르지 않고, 26개에 setup의 `schema_migrations`가 들어간다 — 둘 다 11.1이 만들고 시험했고(`packages/postgres/test/text.test.ts:88`), 26개는 epic 조사 §3의 정의(`schema_migrations` 포함)와 같다.
  - `[false]` `[reject]` (intent-alignment) 개발 DB 재생성을 보이지 않는다 — 티켓 verify는 빈 DB 적용만 요구하고, 재생성은 checksum 고정(티켓 10) 전 개발 홈을 다시 쓸 때의 운영 정책이다. Auto Run Result의 남은 위험에 적었다.


### 2026-10-28 — 후속 thorough 검토
- verdicts: 19 findings — high 0, medium 2, low 11, false 6, maybe-false 0
- findings:
  - `[false]` `[reject]` (blind-hunter 1) 조각 DELETE와 포인터 교체·정리의 반대 잠금 순서 — 이번 변경에는 PG 포인터 교체·정리를 수행하는 Store 호출자가 없고 직접 SQL로 반대 순서를 만드는 것만으로 제품 경로의 결함을 증명할 수 없다. 향후 Store 구현은 파일부터 잠그는 순서를 지켜야 하며, 기존 연결 코드는 SQLSTATE `40P01`·`55P03`을 `DB_LOCKED`로 분류한다.
  - `[low]` `[reject]` (blind-hunter 2) 아주 긴 `file_names.text`의 B-tree 항목 크기 한계 — 긴 비압축 문자열에서 실패할 수 있다는 주장은 사실이다([PostgreSQL 공식 문서](https://www.postgresql.org/docs/18/btree.html)). 현재 이름은 parser가 filename의 마지막 경로 요소에서, 위치는 로컬 파일 경로에서 얻는다. 일반적인 로컬 파일 이름·경로보다 훨씬 긴 합성 입력의 파생 이름 생성에 한정된 문제이며, 해결에는 해시 충돌 처리·별도 중복 검사·잠금 규칙 같은 새 장치가 필요해 낮은 영향에 비해 복잡하다. 이름을 자르거나 원문을 바꾸지 않는다.
  - `[low]` `[reject]` (blind-hunter 3) `page integer`가 Core의 안전 정수 범위보다 좁음 — 코덱은 `2147483648`을 허용하지만 PG integer는 거부한다. 현재 `DOCUMENT_EXTRACTORS`에는 page가 항상 null인 text 추출기만 있고 일상적인 PDF에도 21억 쪽은 없다. bigint 전환은 후속 adapter의 문자열 숫자 변환 경계까지 늘리므로 이 극단값을 위해 추가하지 않는다.
  - `[low]` `[reject]` (blind-hunter 4) 정상 반복 예약의 성공 시험 없음 — 실제 두 CHECK는 양수 interval과 non-null next_run_at을 허용하고 잘못된 입력을 거부한다. 지적은 현재 결함이 아닌 추가 시험 행렬이며, 정상 예약 Store 계약은 해당 verb 스토리에서 실행한다.
  - `[low]` `[reject]` (blind-hunter 5) GUC 수명 단언 전에 helper가 off로 되돌림 — 이 단언만으로 SET LOCAL의 자동 해제를 독립적으로 증명하지 못하는 것은 맞다. 실제 가리기 설정은 SQL의 SET LOCAL이고 제품 코드를 바꿀 결함은 없다. PostgreSQL 자체 트랜잭션 의미를 재시험하는 COMMIT·ROLLBACK 분기를 추가하지 않는다.
  - `[low]` `[reject]` (blind-hunter 6) config 복합 UNIQUE의 NULL 조합 시험 부족 — 실제 색인은 네 열 모두를 포함한 NULLS NOT DISTINCT이고, 기존 시험은 두 nullable 열이 NULL인 중복과 jsonb 키 순서 동등성을 확인한다. 제약 누락은 카탈로그 단언도 감지한다. 추가 조합 행렬은 직접 수정이 아니다.
  - `[low]` `[reject]` (blind-hunter 7) failed_stage의 역방향·목록 밖 값 시험 없음 — CHECK는 실패 상태와 stage 존재의 동치 및 허용 목록을 모두 강제한다. 실패 상태의 stage 누락은 INSERT와 열린 세대 UPDATE에서 직접 시험한다. 나머지 분기의 현재 오류는 없고 추가 행렬만 요구하므로 거절한다.
  - `[low]` `[reject]` (blind-hunter 8) 계획의 JSON.parse 설명과 pg 객체 반환의 차이 — pg는 jsonb 객체를 반환하고 계획의 설명은 SQLite 읽기 관례를 섞었다. 이 스토리에는 config를 읽는 PG adapter가 없으며, 수정 대상이 이 빌드의 계획뿐인 지적은 워크플로 규칙에 따라 거절한다. 후속 adapter는 드라이버 반환 객체를 기준으로 구현해야 한다.
  - `[medium]` `[defer]` (edge-case-hunter 1) brain_app의 brain.redacting 위장 — carried: 기존 검토의 같은 함수·같은 주장이다. 기존 verdict·route를 유지하고 다시 검증·수정·유예하지 않았다. 기존 frontmatter deferred와 DW-7을 그대로 보존한다.
  - `[low]` `[reject]` (verification-gap 1) log_entries 종류·rule_state CHECK의 부정 시험 없음 — carried: 기존 검토의 새 표 CHECK 개별 시험 지적에 포함된 같은 위치·같은 주장이다. 같은 SQLite 최종 식을 적용했고 로그 verb 스토리가 계약을 검증한다는 기존 판정을 유지한다.
  - `[low]` `[reject]` (verification-gap 2) chunks 시간 범위 CHECK의 경계 시험 없음 — carried: 기존 검토의 같은 CHECK 시험 누락 주장이다. `from_at <= to_at` 식은 그대로이고, 추가 행렬을 이 스토리의 직접 수정으로 보지 않은 기존 판정을 유지한다.
  - `[low]` `[reject]` (verification-gap 3) file_metadata captured_at CHECK의 부정 시험 없음 — carried: 기존 검토의 같은 CHECK 시험 누락 주장이다. SQLite와 같은 시각 형식 식이며, 가리기·재생성 경로를 검사한 기존 범위 판정을 유지한다.
  - `[false]` `[reject]` (intent-alignment 1) 26개 표에 setup의 schema_migrations가 포함됨 — carried: 기존 검토와 같은 주장이다. 티켓 참조 조사 §3의 집계가 setup 표를 포함하므로 요구와 일치한다.
  - `[false]` `[reject]` (intent-alignment 2) locator 압축 표기 검사 없음 — carried: 기존 검토와 같은 주장이다. 티켓의 text·JSON object·필수·page 사본 요구를 만족하며, 정규형은 Core 코덱이 맡는다.
  - `[false]` `[reject]` (intent-alignment 3) 모든 UPDATE·DELETE의 전면 거부가 아님 — carried: 기존 검토와 같은 주장이다. 0008의 열린 세대 진행과 세대 교체 예외까지 보존하는 표별 규칙이 요구사항이다.
  - `[medium]` `[defer]` (intent-alignment 4) 앱 역할에서 가리기 표시로 조각 보호 우회 — carried: 기존 검토·edge-case-hunter와 같은 원인이다. 기존 유예 판정만 기록하며 기존 deferred·DW-7을 재작성하거나 다시 추가하지 않는다.
  - `[false]` `[reject]` (intent-alignment 5) tag evidence와 일부 기존 규칙이 이번 새 시험 밖에 있음 — carried: 기존 검토와 같은 주장이다. 11.1 구현·시험이 이미 덮고 이번 전체 실행에서도 통과했다. 모든 규칙을 새 파일에 다시 넣을 필요는 없다.
  - `[low]` `[reject]` (intent-alignment 6) 모든 업무 UNIQUE·FK·CHECK를 개별 위반시키지 않음 — 티켓 verify가 열거한 규칙과 명명 UNIQUE·GIN·기본값 금지는 직접 SQL과 카탈로그 검사로 확인한다. 모든 선언형 제약에 별도 부정 사례를 추가하라는 넓은 해석은 현재 결함을 지목하지 않는 추가 행렬이다.
  - `[false]` `[reject]` (intent-alignment 7) 개발 DB 재생성 실행 증거 없음 — carried: 기존 검토와 같은 주장이다. 빈 DB 적용은 실행했고, 이전 개발 홈을 다시 쓸 때 재생성한다는 정책은 운영 조건이다. 이번 검토는 기존 개발 볼륨을 사용하지 않는다.

## Design Notes

**표(이름·열, 생략한 제약은 SQLite와 같음):**
- `log_entries(id uuid pk, kind, session_id uuid→sessions, occurred_at, recorded_at, author_model, "text", rule_state, apply_project_id uuid→projects, supersedes_id uuid→log_entries)` + kind·rule_state CHECK 세 개.
- `log_entry_edits(id uuid pk, log_entry_id uuid→log_entries, previous_text, edited_at)`.
- `index_configs(id uuid pk, kind, model, dimensions integer, chunk_params jsonb)` + kind CHECK, chunk_params CHECK(object이고 키 집합이 kind별로 정확히 `targetChars`·`overlapChars` 또는 `targetChars`·`overlapMessages`·`splitMessagesOverChars`, 값은 모두 number). `index_configs_key_idx`는 `(kind, model, dimensions, chunk_params) nulls not distinct`인 명명 UNIQUE index. seed는 SQLite와 같은 id·값 두 행(`019a…0001` chunk `{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}`, `019a…0002` document_chunk `{"targetChars":1200,"overlapChars":120}`). jsonb를 고른 이유: SQLite는 정규형 text 비교로 키 순서 무관 유일성을 얻었고, PG에서는 jsonb 동등이 같은 뜻이다. Core는 JSON.parse로 읽는다.
- `chunks(id uuid pk, session_id→sessions, index_config_id→index_configs, from_at, to_at, body)` + `unique(session_id, index_config_id, from_at, to_at)`, `from_at <= to_at`.
- `context_injections(id uuid pk, session_id→sessions, attempted_at, ok integer 0/1, code, chars integer)`.
- `document_extractions(...)` SQLite와 같은 열(`index_config_id uuid→index_configs`), `unique(file_id, attempt)`, attempt·status·finished·failed_stage CHECK. failed_stage 강제는 CHECK `(status is not distinct from 'failed') = (failed_stage is not null)`로 한다: 빈 DB라 0005 이전 행 예외가 필요 없다. `document_extractions_running_idx`(file_id, finished_at null)인 명명 UNIQUE.
- `document_chunks(id uuid pk, extraction_id→document_extractions, ordinal, page integer, body, chunk_locator text not null)` + `unique(extraction_id, ordinal)`. locator 필수도 같은 이유로 NOT NULL. CHECK는 형 변환 오류가 나지 않게 `case when pg_input_is_valid(chunk_locator, 'jsonb') then … else false end` 안에서 object·`type ∈ {pdf, docx, text, time, sheet}`·`to_jsonb(page) is not distinct from (case when type='pdf' then locator->'page' end)`를 본다. 압축 표기·키 순서는 Core 코덱이 맡는다.
- `file_names(id uuid pk, file_id→files, name_source, "text")` + `unique(file_id, name_source, "text")`, name_source CHECK. `file_metadata(id uuid pk, file_id→files, key, value)` + `unique(file_id, key)`, `key <> 'captured_at' or value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'`.
- `schedules(id uuid pk, kind, target_kind, target_id text, interval_seconds integer, next_run_at, last_run_at, created_at)` + `interval_seconds is null or > 0`, `interval_seconds is null or next_run_at is not null`. `schedules_due_idx on (next_run_at) where next_run_at is not null`.
- `settings(key text pk, value text not null, updated_at timestamptz not null)`. 값의 뜻은 설정 코덱(6)이 정한다.

**규칙(trigger, plpgsql):** `files_extraction_check`·`files_extraction_check_insert`(포인터는 같은 파일의 세대), `document_extractions_immutable_update`(정체 열 불변, 닫힌 세대의 나머지 열 불변, 가리기 중에도), `document_chunks_delete_rule`(가리기 표시가 없으면 열린 세대나 현재 세대의 조각 삭제 거부), `file_names_redacted_insert/_update`·`file_metadata_redacted_insert/_update`(가린 파일 거부). 0008의 첨부 규칙 두 개는 이미 있다. TRUNCATE 방어는 기존 6개 표에 `document_extractions`·`document_chunks`를 더해 8개다(행 trigger를 건너뛰는 길을 막는다).

**원문 짝 열을 만들지 않는 이유:** epic의 U+0000 규칙은 수집 경로가 transcript 문자열을 넣는 칸에 적용된다. 새 표의 text 칸은 drain·log·추출이 쓰는 파생 또는 비 transcript 값이다. 그 verb를 만드는 스토리(3·4, 검색 epic)가 쓸 때 NUL을 `pgText`로 바꾸고, 원문이 필요하면 그때 짝 열을 더한다.

**알려진 한계:** `brain.redacting`은 호출자가 세울 수 있는 GUC라 `brain_app`이 위장하면 `document_chunks` 삭제 규칙을 건너뛸 수 있다. 가리기 권한 경계는 티켓 5(E11-6) 몫이다.

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project postgres` -- expected: 새 `schema.test.ts`와 기존 PG 시험 전부 통과
- `pnpm test` -- expected: build·typecheck·전체 시험 통과(PG는 global-setup이 Docker로 띄움, OrbStack 켜짐)

**Manual checks (if no CLI):**
- 셸에 pnpm이 없으면 `npx --yes pnpm@12 …`로 같은 명령을 돌린다.

## Auto Run Result

- 상태: `built`를 그대로 유지했다. 티켓 완료 여부는 오케스트레이터가 판정하며 `done`으로 바꾸거나 `tickets.py mark`를 실행하지 않았다.
- 이번 실행은 이미 구현된 티켓 11.2의 후속 thorough 검토다. baseline revision은 `41df88f72913db09bd64266abd753b979bb5ceca`이고 검토 시작 HEAD는 `c7b1fb3814e54b742a894b1bf847be7d7ac86d42`다.
- 구현 요약: baseline 0001의 나머지 core 표 11개, 추출 포인터·변경 규칙·TRUNCATE 방어·명명 UNIQUE·due 색인·검색 GIN·seed와 직접 SQL 시험이 이미 반영되어 있다. 이번 pass에는 제품 코드·시험 수정이 없다.
- 파일: 이 계획에 후속 검토 판정과 검증 결과를 추가하고 `followup_review_recommended`를 false로 바꿨다. 시작 시 존재했던 deferred-work 변경은 바이트 그대로 보존한다. 기존 ledger 항목의 내용·상태·해결 여부는 수정하지 않았다.
- 검토: 렌즈 네 개에서 지적 19건, high 0·medium 2·low 11·false 6. 적용한 patch는 high 0·medium 0·low 0이고, 새 유예 항목은 없다. medium 2건은 이미 기록된 같은 권한 경계 주장으로 기존 판정을 carried 처리했다. 나머지 17건은 위 개별 행에 반증 또는 낮은 영향과 복잡도 근거를 기록했다.
- 후속 검토 권고: `false`. 후속 pass에서 high patch가 없고 새로운 미검증 위험 때문에 같은 검토를 반복할 근거가 없다.
- 검증: `npx --yes pnpm@12 test` 통과. build·typecheck 및 109개 파일·2,944개 테스트 모두 통과했고, 테스트 실행 시간은 68.09초다. PG 카탈로그·직접 SQL 규칙·동시성 시험도 이 실행에 포함된다.
- 남은 한계: 기존 `brain.redacting` 권한 경계 유예는 티켓 5에서 다룬다. 0001 checksum은 티켓 10에서 고정하며, 변경 전 baseline을 적용한 개발 DB는 다시 만들고 사용해야 한다. 극단적으로 긴 이름의 B-tree 한계와 32비트 page 범위는 위 low 판정 근거와 같다. Store 구현 시 파일·파생물의 잠금 순서와 jsonb 반환 객체 변환을 해당 경로에서 검증해야 한다.
