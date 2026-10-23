---
title: '마이그레이션 0008: 첨부·추출 변경 규칙 trigger'
type: 'feature'
ticket: '6'
created: '2026-10-23'
status: 'built'
baseline_revision: 'a87386bb8f601b80adeeee2fa7cede0ef50cbfc0'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Table Contract는 `message_attachments`(자리·출처 불변, `file_id`·`status` 한 번 채움), `document_extractions`(열린 세대만 닫힘으로 진행), `document_chunks`(정해진 경우에만 지움), `file_names`·`file_metadata`(가린 파일은 재생성하지 않음)의 변경 규칙을 정했지만, 0002는 `files`·`file_locations`에만 trigger를 두어 코드 실수가 이 규칙을 조용히 깰 수 있다(deferred-work I67). Table Contract와 spine AD-15에는 원천 충돌 셋이 남아 있다.

**Approach:** SQLite 마이그레이션 `0008_attachment_rules.sql`(schema version 8)이 아래 규칙을 `before` trigger로 강제하고, `SQLITE_SCHEMA_VERSION`을 8로 올리며, 마이그레이션 테스트로 거부·통과 사례와 10.2가 쓰는 첨부 행의 회귀를 확인하고, architecture 문서의 충돌 셋을 고친다.

## Boundaries & Constraints

**Always:**
- `message_attachments` UPDATE: `id`·`message_id`·`ordinal`·`source_kind`·`source_ref`·`display_name`은 늘 불변. `file_id`·`status`는 `old.status is null`일 때만 바뀔 수 있다(null → 값 한 번; `missing_at_ingest`도 확정 기록이라 다시 바뀌지 않음). DELETE는 거부(메시지가 불변이고 자리를 잃는다).
- `document_extractions` UPDATE: `id`·`file_id`·`extractor_version`·`attempt`·`started_at`은 늘 불변. `old.finished_at is null`(열린 세대)이면 `media_type`·`status`·`finished_at`·`error`·`failed_stage`·`index_config_id`를 쓸 수 있고(0004 CHECK가 `status`·`finished_at` 동치, 0005 trigger가 `failed`의 `failed_stage`를 계속 강제), 닫힌 세대(`old.finished_at is not null`)는 어떤 칸도 바뀌지 않는다 — 가리기 표시가 있어도.
- `document_chunks` DELETE: `brain_redact_allowed() = 1`(파일 가리기)이거나, 조각의 세대가 닫혔고(`finished_at` not null) 그 파일의 `files.current_extraction_id`가 아닐 때(실패 세대 정리·세대 교체)만 통과. 열린 세대나 현재 세대의 조각 삭제는 거부. 그래서 세대 교체는 포인터를 먼저 옮기고 옛 조각을 지우며, 실패 정리는 세대를 `failed`로 닫은 뒤 지운다(10.14가 이 순서를 따른다).
- `file_names`·`file_metadata`: DELETE는 늘 허용(재생성·가리기). INSERT·UPDATE는 대상 `files.redacted_at`이 not null이면 거부(AD-23 가린 파일은 재생성하지 않음).
- 비교는 `is`/`is not`(null도 값), 오류 메시지는 테이블·규칙을 말한다. 기존 행과 데이터는 바꾸지 않는다(trigger만 더함). 0008 머리 주석이 0002의 "파생 테이블은 자유롭게 다시 쓴다" 문단을 이 규칙으로 대체한다고 적는다.

**Never:**
- Postgres 마이그레이션(epic 7), `document_extractions` DELETE 규칙과 `attempt` 최댓값 보존(10.14), 조각·세대 INSERT 규칙, 조각 UPDATE 규칙, Store·Core 코드 변경, `tickets.toml`·epic 파일 수정.
- 기존 trigger(0004 locator, 0005 failed_stage, 0002 files·file_locations)를 지우거나 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|----------|--------------|----------|----------------|
| 첨부 출처 변경 | `stored` 행의 `source_kind`·`source_ref`·`display_name`·`ordinal` UPDATE | 거부 | abort |
| 첨부 재채움 | `stored` 행 `file_id` 다른 파일로; `missing_at_ingest` → `stored` | 거부 | abort |
| 첨부 첫 채움 | `status` null 행 → `stored`+`file_id` 또는 `missing_at_ingest` | 통과 | — |
| 첨부 삭제 | 아무 행 DELETE | 거부 | abort |
| 세대 닫기 | 열린 세대 → `failed`+`failed_stage`+`finished_at`+`error` | 통과 | — |
| 닫힌 세대 변경 | `ok`/`failed` 세대의 `status`·`error`·`media_type` UPDATE (표시 있어도) | 거부 | abort |
| 세대 정체 변경 | 열린 세대의 `attempt`·`file_id` UPDATE | 거부 | abort |
| 실패 세대 조각 | `failed` 세대 조각 DELETE | 통과 | — |
| 교체된 세대 조각 | 포인터가 새 세대로 옮겨진 뒤 옛 `ok` 세대 조각 DELETE | 통과 | — |
| 현재·열린 세대 조각 | 표시 없이 DELETE | 거부 | abort |
| 가리기 조각 | 표시 올린 채 현재 세대 조각 DELETE | 통과 | — |
| 가린 파일 이름 | `redacted_at` 있는 파일에 `file_names`/`file_metadata` INSERT | 거부 | abort |
| 이름 재생성 | 가리지 않은 파일의 `file_names`·`file_metadata` DELETE 후 INSERT | 통과 | — |

</intent-contract>

## Code Map

- `packages/sqlite/migrations/0002_files_and_work.sql:189-305` -- 다섯 테이블 원 정의; `:306-345` files trigger와 `brain_redact_allowed()` 쓰는 모양(따라 쓸 본보기).
- `packages/sqlite/migrations/0004_capture_columns.sql:139-170,273-332` -- `chunk_locator` trigger와 `document_extractions` 재정의(`attempt`, `failed_stage`, `index_config_id`, `document_extractions_running_idx`).
- `packages/sqlite/migrations/0005_identity_and_records.sql:150-187` -- `failed_stage` trigger(그대로 둔다).
- `packages/sqlite/migrations/0007_session_tag_source.sql` -- 가장 최근 짧은 마이그레이션 모양.
- `packages/sqlite/src/migrate.ts:20` -- `SQLITE_SCHEMA_VERSION = 7` → 8. `schema.test.ts:405`가 폴더 최댓값과 대조.
- `packages/sqlite/src/connect.ts:69-136` -- `brain_redact_allowed()`는 `openSqlite`가 등록한다. 0008 trigger가 이 함수를 부르므로 테스트는 `openSqlite`로 열거나 `DatabaseSync`에 같은 이름 함수를 등록해야 한다(미등록이면 "no such function").
- `packages/sqlite/src/write.ts:52-90` -- `withWrite({redact:true})`가 표시를 올린다.
- `packages/sqlite/src/attachments.ts:22` -- 10.2의 첨부 쓰기(`insert ... 'stored' ... on conflict do nothing`); 회귀 대상.
- `packages/sqlite/test/schema-0007.test.ts`, `schema-0005.test.ts:87-115` -- 마이그레이션 테스트 본보기(0001~0007만 복사해 7까지, 행 넣고, 0008 적용).
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md:265` (AD-15 "`files`의 경로 텍스트"), `:443-447` (Table Contract 다섯 행).

## Tasks & Acceptance

**Execution:**
- [ ] `packages/sqlite/migrations/0008_attachment_rules.sql` -- Always의 규칙을 trigger로 만든다(머리 주석에 왜·무엇을, 0002 문단 대체). -- I67.
- [ ] `packages/sqlite/src/migrate.ts` -- `SQLITE_SCHEMA_VERSION = 8`.
- [ ] `packages/sqlite/test/schema-0008.test.ts` -- 0001~0007 DB에 `stored`·`missing_at_ingest`·null 첨부, 열린·`ok`(현재)·`failed`·교체된 `ok` 세대와 조각, 가린·안 가린 파일을 넣고 0008을 적용해 행이 보존됨과 I/O Matrix 각 줄을 확인. 가리기 사례는 `withWrite({redact:true})` 또는 등록한 함수로 표시를 올린다. 10.2 회귀: 0008 DB에서 `SqliteStore`(또는 `attachments.ts` 경로)로 첨부를 한 번 쓰고 같은 입력으로 다시 써도 통과.
- [ ] 버전 숫자 고정 테스트 -- `apps/cli/test`·`packages/*/test`에서 7을 고정한 곳이 있으면 8로(상수를 쓰는 곳은 그대로). `apps/cli/test/install-flow.test.ts:251`의 `'6'`은 가짜 값이라 건드리지 않는다.
- [ ] `architecture-brain-v1-slice-1.md` -- Table Contract `message_attachments`(삭제 거부, `missing_at_ingest` 확정), `document_extractions`("열린 세대만 `finished_at`·`status`·`error`·`failed_stage`·`media_type`·`index_config_id`를 닫으며 채움, 닫힌 뒤 불변; 0008"), `document_chunks`("실패 세대 정리·세대 교체(포인터 이동 뒤)·가리기로만 지움; 0008"), `file_names`·`file_metadata`("가린 파일에는 쓰지 않음; 0008"); AD-15의 파일 경로 텍스트를 `file_names`와 이름 FTS로.

**Acceptance Criteria:**
- Given 0007 DB가 0008로 오른 뒤, when `brain doctor run`(또는 doctor 테스트)을 돌리면, then `schema-version`이 ok이고 detail이 8이다.
- Given 새 설치, when 마이그레이션을 끝까지 돌리면, then 저장된 버전이 8이고 기존 테스트 전체가 통과한다.

## Implementation Notes

- 구현: codex 워커(Orca run `run_305890d45813`). 첫 워커는 지시를 받기 전에 bmad-build 렌더러를 돌리다 실패로 끝나 정리했고, BMad 스킬을 쓰지 말라는 한 줄을 붙인 둘째 워커가 구현했다.
- `0008_attachment_rules.sql`: trigger 여덟 개(`message_attachments` update·delete, `document_extractions` update, `document_chunks` delete, `file_names`·`file_metadata` insert·update). 기존 행·trigger는 그대로.
- 0008이 닫힌 세대를 얼려 기존 0005 테스트 두 개의 기대가 바뀌었다: 단계 없는 옛 `failed` 행과 `unsupported` 행의 `error` 다시 쓰기는 이제 거부된다(계획 Always의 "닫힌 세대는 어떤 칸도 바뀌지 않는다"). `failed_stage`를 지우는 update는 0005보다 0008 trigger가 먼저 거부해 메시지가 바뀌었다.
- 버전 숫자를 고정한 테스트(`schema*.test.ts`, `users.test.ts`, `apps/cli/test/setup.test.ts`)를 8로 맞췄다. README의 `installed.json` 예시(`schema_version: 7`)는 옛 설치의 예시라 두었다.
- 검증(코디네이터 재실행): `pnpm test` — build·typecheck·76 files / 2,374 tests 통과(Postgres 포함).

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: (없음 — quick 리뷰어(codex 워커, Orca)가 계획·규칙·diff·주변 스키마 코드를 읽고 SQLite와 CLI setup·doctor 테스트 17 files / 389 tests를 돌려 지적 없음으로 보고)

## Design Notes

조각 삭제 규칙 모양(표시 없이 열린·현재 세대면 거부):

```sql
create trigger document_chunks_delete_rule before delete on document_chunks
when coalesce(brain_redact_allowed(), 0) <> 1
 and exists (select 1 from document_extractions e
             where e.id = old.extraction_id
               and (e.finished_at is null
                    or exists (select 1 from files f where f.current_extraction_id = e.id)))
begin select raise(abort, '...'); end;
```

`file_names`·`file_metadata` 규칙은 INSERT와 UPDATE 각각(`new.file_id`의 `redacted_at`). 내보내기 복구는 INSERT만 하므로 UPDATE 규칙에 걸리지 않고, 가린 파일의 이름·메타데이터는 가리기가 이미 지워 복구 대상이 없다.

## Verification

**Commands:**
- `pnpm vitest run packages/sqlite` -- expected: 통과, 새 `schema-0008.test.ts` 포함.
- `pnpm test` -- expected: build·typecheck·전체 테스트 통과(Postgres 포함, 10.2 때 75 files / 2,369 tests 기준으로 새 파일만큼 늘어남).

## Auto Run Result

- **요약:** SQLite 마이그레이션 0008(schema version 8)이 첨부·추출 테이블의 Table Contract 변경 규칙을 trigger로 강제한다 — `message_attachments`는 자리·출처 불변·삭제 거부·`file_id`·`status` 한 번 채움(`missing_at_ingest`도 확정), `document_extractions`는 정체 칸 불변·열린 세대만 닫으며 채움·닫힌 뒤 불변(가리기 표시가 있어도), `document_chunks`는 닫힌 비현재 세대나 가리기 표시에서만 삭제, `file_names`·`file_metadata`는 가린 파일에 쓰기 거부. architecture의 Table Contract 다섯 행과 AD-15(`file_names`·이름 FTS)를 고쳤다.
- **바뀐 파일:**
  - `packages/sqlite/migrations/0008_attachment_rules.sql` — trigger 여덟 개.
  - `packages/sqlite/src/migrate.ts` — `SQLITE_SCHEMA_VERSION = 8`.
  - `packages/sqlite/test/schema-0008.test.ts` — 0007 DB 행 보존, I/O 표 전부, 가리기 표시 사례, 10.2 첨부 쓰기 재시도 회귀.
  - `packages/sqlite/test/schema-0004·0005·0006·0007·files·schema.test.ts`, `users.test.ts`, `apps/cli/test/setup.test.ts` — 버전 8과 0008 적용 목록; 0005의 닫힌 세대 다시 쓰기 기대를 거부로.
  - `architecture-brain-v1-slice-1.md` — Table Contract 다섯 행, AD-15.
- **리뷰:** quick 1회, 지적 0건. 패치 0, 미룸 0, 기각 0.
- **후속 리뷰 권고:** false(패치 0건).
- **검증:** 코디네이터가 `pnpm test` 재실행 — build·typecheck·76 files / 2,374 tests 통과(Postgres 포함). 리뷰어도 SQLite·CLI setup·doctor 17 files / 389 tests 통과. I/O 표 열세 줄 모두 `schema-0008.test.ts`가 덮는다.
- **남은 위험:** 0008은 Store 코드가 아직 쓰지 않는 규칙을 먼저 건다. 10.14(추출 세대 Store)는 세대 교체 때 포인터를 먼저 옮기고 옛 조각을 지우며, 실패 정리는 세대를 `failed`로 닫은 뒤 조각을 지워야 한다. `document_extractions` 삭제 규칙과 `attempt` 최댓값 보존은 10.14 몫이다. Postgres 복제본의 같은 trigger는 epic 7.

