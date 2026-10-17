---
title: '마이그레이션 0004: 가리기·추출·서브에이전트·브랜치 칸과 실패 키'
type: 'feature'
ticket: '6'
created: '2026-10-18'
status: 'built'
baseline_revision: 'e1596c843d066faacc5605896e3cf3d6145b6cc3'
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

**Problem:** 이 에픽의 마스킹·가리기·parser·drain과 epic-attachments가 쓸 칸과 키가 스키마에 없다. `redactions`는 메시지 전용이고 고칠 수 있으며, `failures` 키는 세션 키라 세션 없는 대상의 실패를 담지 못하고, `work_items_due_idx`는 drain 청구 순서(`attempts ASC, id ASC`)를 덮지 못한다.

**Approach:** SQLite 마이그레이션 `0004_capture_columns.sql` 하나로 칸을 더하고(`alter table … add column`), nullable·키·check를 바꿔야 하는 세 테이블(`redactions`, `document_extractions`, `failures`)은 0002·0003과 같은 stash→drop→create→copy 재생성으로 바꾸며, `messages` 불변 trigger를 새 칸까지 막도록 다시 만들고, `SQLITE_SCHEMA_VERSION`을 4로 올린다. 동작(쓰는 코드)은 만들지 않는다.

## Boundaries & Constraints

**Always:**
- 0001~0003 파일은 바꾸지 않는다. 0004는 기존 행을 모두 보존한다(빈 테이블만 되는 단계 금지 — 0003 주석의 원칙).
- 재생성은 0002·0003처럼 `pragma defer_foreign_keys = ON`, temp stash, `drop`(rename 금지), 같은 열 순서로 create, copy, stash drop. 지운 테이블의 인덱스·trigger는 다시 만든다.
- 규칙은 0001의 철자를 따른다: `STRICT`, 시각은 정규형 `glob` check, 불리언은 `integer check (x in (0, 1))`, 주석은 0002·0003처럼 *왜*를 적는다(영어).
- 칸 목록(이름은 이대로):
  - `redactions`: `message_id` nullable, `file_id text references files (id)`, `start`·`"end"` nullable, `pattern_version text`(nullable). check: 정확히 하나만 — `(message_id is null) <> (file_id is null)`; 메시지 가리기는 `start`·`end`가 있고 `0 <= start < end`; 파일 가리기는 `start`·`end`가 둘 다 null. `before update`·`before delete` trigger가 무조건 거부한다(표시가 있어도).
  - `document_chunks.chunk_locator text`(add column). check: null이거나 `json_valid`, `json_type = 'object'`, `json(chunk_locator) = chunk_locator`(공백 없음), `$.type ∈ {pdf, docx, text, time, sheet}`, 그리고 `page is (case when $.type = 'pdf' then json_extract($.page) end)`. `before insert`·`before update of chunk_locator` trigger가 새 null을 거부한다.
  - `document_extractions` 재생성: `attempt integer not null check (attempt >= 1)`, `failed_stage text`(`read|extract|chunk|index`, `status = 'failed'`일 때만 값), `index_config_id text references index_configs (id)`(nullable). `unique (file_id, attempt)`. 옛 `document_extractions_open_idx`를 `document_extractions_running_idx on (file_id) where finished_at is null`로 바꾼다. 복사할 때 `attempt`는 파일별 `started_at, id` 순 `row_number()`.
  - `files.source_unreachable_at text`(정규형 glob check). `files_immutable_update`는 열 목록 방식이라 이 칸을 자동으로 허용하므로 고치지 않는다.
  - `failures` 재생성: `id, target_kind, target_id, stage, fingerprint, harness(nullable), session_id(nullable FK), code, message, occurred_at, resolved_at`, `unique (target_kind, target_id, stage, fingerprint)`. `harness_session_id`는 없앤다. 옛 행은 `target_kind = 'session'`, `target_id = harness || ':' || harness_session_id`(세션 토큰 철자, Conventions)로 옮긴다.
  - `messages`: `git_branch text`(nullable), `is_subagent_report integer not null default 0 check in (0, 1)`. `messages_immutable_update`를 drop하고 두 칸을 `is` 비교 목록에 더해 다시 만든다(메시지 문구도 같게).
  - `work_items_due_idx`를 drop하고 `on work_items (attempts, id, next_attempt_at) where completed_at is null`로 다시 만든다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 서브에이전트 표시는 `messages.is_subagent_report` 불리언 하나 — 최종 보고를 어디서 읽을지는 2.7이 fixture로 정하므로 가장 작은 약속만 한다. 다른 안: 서브에이전트 id 텍스트 칸(`subagent_id`), `isSidechain` 그대로의 `sidechain` 칸.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): `chunk_locator`는 재생성 없이 nullable 칸 + 새 null을 막는 trigger — FTS가 걸린 `document_chunks`를 재생성하지 않고, 예전 행에 위치를 지어내지 않는다. 다른 안: 재생성해 `not null`로 두고 `page`에서 locator를 지어 채움.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): `document_extractions.index_config_id`는 nullable, `failed_stage`는 `failed`일 때 필수가 아님 — 예전 행에 지어낸 값을 넣지 않는다; 채우는 규칙은 epic-attachments의 Store가 지킨다. 다른 안: `not null`로 두고 0002의 문서 조각 설정 id로 채움, `failed`면 `failed_stage` 필수.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): `failures`의 옛 행은 버리지 않고 세션 토큰 대상 키로 옮긴다 — 티켓의 "(행 없음)"은 지금 행이 없다는 사실로 읽었고, 옮김이 Table Contract의 세션 수집 실패 키와 같다. 다른 안: 행을 버리는 재생성.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): Core 도메인 타입(`Message`, `Redaction`, `Failure`)은 바꾸지 않는다 — 그 칸을 쓰는 동작 스토리(2.7·2.9·2.11, epic-attachments)가 타입을 함께 바꾼다. 다른 안: 지금 타입을 스키마에 맞춤.

**Never:**
- 새 칸을 쓰거나 읽는 코드(parser, 마스킹, 실패 기록, 청구, 추출 Store), Core 타입·코덱 변경, Postgres 마이그레이션(epic 7).
- `foreign_keys = OFF`, `alter table … rename`, 기존 마이그레이션 파일 수정.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 3→4 업그레이드 | 버전 3 DB(0001~0003 파일만)에 세션·메시지·가리기·실패·추출 2세대·조각·파일·일감 행 | `{ok, from: 3, to: 4, applied: ['0004_capture_columns.sql']}`, 모든 행·id 그대로, `attempt` 1·2, 실패의 대상 키는 세션 토큰, 메시지 새 칸은 null·0 | — |
| 재실행 | 버전 4 DB | `applied: []` | — |
| attempt 중복 | 같은 `file_id`, 같은 `attempt` 두 행 | 두 번째 거부 | UNIQUE |
| 진행 중 둘 | 같은 파일, `finished_at` null 두 행(다른 `extractor_version`) | 두 번째 거부, 첫 행이 끝나면 허용 | UNIQUE |
| 실패 중복 | 같은 `(target_kind, target_id, stage, fingerprint)` 두 행 | 두 번째 거부, 하나라도 다르면 허용 | UNIQUE |
| 가리기 변경 | `redactions` 행 update·delete, redact 표시 있음·없음 | 모두 거부 | trigger |
| 가리기 모양 | 메시지·파일 둘 다/둘 다 없음, 파일인데 위치 있음 | 거부; 파일 가리기(위치 없음)는 허용 | check |
| 메시지 새 칸 | `git_branch`·`is_subagent_report` update, 표시 있음·없음 | 거부(본문만 표시 아래 허용 — 기존 그대로) | trigger |
| 조각 위치 | null 삽입, 공백 있는 JSON, 모르는 `type`, pdf인데 `page` 다름, pdf 아닌데 `page` 있음 | 거부; 정규 pdf·text 위치는 허용 | trigger/check |
| 청구 질의 | `select id from work_items where completed_at is null and next_attempt_at <= ? order by attempts asc, id asc limit ?` | `EXPLAIN QUERY PLAN`에 `work_items_due_idx`가 있고 `TEMP B-TREE`가 없음 | — |

</intent-contract>

## Code Map

- `packages/sqlite/migrations/0002_files_and_work.sql` -- 재생성 패턴(`index_configs`, 489~558행), `document_extractions`·`document_chunks`·`work_items`·`files` 원래 정의, `files_immutable_update`(326행). 읽기 전용.
- `packages/sqlite/migrations/0003_users.sql` -- 같은 패턴의 `sessions` 재생성과 주석 문체. 읽기 전용.
- `packages/sqlite/migrations/0001_initial.sql` -- `messages`(107), `redactions`(233), `failures`(261), `messages_immutable_update`(331). 읽기 전용.
- `packages/sqlite/src/migrate.ts:19` -- `SQLITE_SCHEMA_VERSION = 3`; 폴더 최고 번호와 상수가 같아야 한다(260행). 마이그레이션은 `BEGIN IMMEDIATE` 안에서 `exec`된다.
- `packages/sqlite/test/schema-files.test.ts` -- 0002 테스트. `document_extractions`를 `attempt` 없이 넣는 사례(553~)는 고쳐야 하고, `migratedPath`(91행)·0001→0003 업그레이드(291~, 335행)의 `to`/`applied`도 4로.
- `packages/sqlite/test/schema.test.ts` -- 117·384행 `to: 3`; 테이블 목록은 그대로.
- `packages/sqlite/test/users.test.ts:158` -- 2→최신 업그레이드의 `applied`에 0004가 더해진다.
- `apps/cli/test/install-flow.test.ts` -- 200·204·569·790·799·1145행에 버전 3과 파일 목록이 박혀 있다. `apps/cli/test/sessions-ingest.test.ts:463` 주변 "version 3" 사례도 확인한다.
- `packages/sqlite/src/sessions.ts:168` -- 메시지 삽입은 열 목록이 명시적이라 새 칸(기본값)과 충돌하지 않는다. 바꾸지 않는다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0004_capture_columns.sql` -- Always의 칸 목록 전부, 재생성 세 개, trigger·인덱스 교체 -- 스키마 자리 한 번에.
- [x] `packages/sqlite/src/migrate.ts` -- `SQLITE_SCHEMA_VERSION = 4`와 주석 -- 폴더와 상수 일치.
- [x] `packages/sqlite/test/schema-0004.test.ts` -- I/O 매트릭스 전 행(버전 3 DB는 `users.test.ts`의 `versionTwoPath`처럼 0001~0003만 복사한 폴더로 만든다; 청구 질의 문자열은 테스트에 상수로 고정하고 "2.11이 이 모양을 쓴다"고 주석) -- 티켓 verify.
- [x] `packages/sqlite/test/schema-files.test.ts`, `schema.test.ts`, `users.test.ts`, `apps/cli/test/install-flow.test.ts`, 그 밖에 실패하는 테스트 -- 버전·파일 목록·`attempt` 필수에 맞춤. 단정의 뜻은 바꾸지 않는다.

**Acceptance Criteria:**
- Given 버전 3 설치, when `brain setup run --yes`(임시 home), then 스키마 버전 4가 되고 doctor `schema-version`이 `4`다.
- Given 새 home, when 마이그레이션, then 테이블 목록은 그대로이고 모든 테스트와 타입 검사가 통과한다.

## Implementation Notes

- 사고(2026-10-18): 구현 서브에이전트가 수동 확인 중 home 변수 이름을 `BRAIN_HOME`으로 잘못 써서 `node apps/cli/dist/install.js --yes`가 실제 `~/.second_brain`에 새 설치를 만들었다. 그 전에는 폴더가 없었고, 서브에이전트가 통째로 스크래치패드(`second_brain-accidental-install`)로 옮겨 지금은 다시 없다. `~/.claude/settings.json`·셸 rc는 바뀌지 않았다(mtime 확인). 안에는 빈 DB·설정·shim·installed.json뿐이다.

- 0004은 Always의 순서대로 쓰였다: `messages` 두 칸과 trigger 교체 → `files.source_unreachable_at` → `document_chunks.chunk_locator`와 null 거부 trigger 둘 → `redactions` 재생성과 불변 trigger 둘 → `document_extractions` 재생성·`document_extractions_running_idx` → `failures` 재생성 → `work_items_due_idx` 교체. `pragma defer_foreign_keys = ON`은 파일 맨 위에 한 번(트랜잭션 전체에 걸린다).
- `chunk_locator`의 check는 `chunk_locator is null or (...)`다. `alter table add column`은 기존 행을 다시 검사하지 않지만, `page`가 있고 locator가 없는 0002 행을 나중에 건드리면 거부될 것이므로 `page` 사본 규칙까지 `null or` 안에 넣었다. 새 null은 trigger 둘이 막는다.
- `document_extractions`의 옛 `document_extractions_open_idx`는 표를 drop할 때 함께 사라지므로 따로 `drop index`하지 않는다(파일 주석에 적었다).
- 청구 인덱스는 `EXPLAIN QUERY PLAN`이 `SCAN work_items USING INDEX work_items_due_idx` 한 줄만 내고 `TEMP B-TREE`가 없다(옛 인덱스는 `SEARCH ... (next_attempt_at<?)` + `USE TEMP B-TREE FOR ORDER BY`였다).
- 기존 테스트에서 뜻이 바뀐 단정 둘: `document_extractions` 멱등 키가 `(file_id, extractor_version)` 진행 중 → `(file_id, attempt)`, 그리고 "버전당 진행 중 하나" → "파일당 진행 중 하나"(`extractor_version`이 달라도 거부). 나머지는 버전·파일 목록·`attempt`·`chunk_locator` 필수에 맞춘 것뿐이다.

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass
- verdicts: 8 findings — high 0, medium 1, low 6, false 1, maybe-false 0
- findings:
  - `[low]` `[reject]` 버전 3 DB에 한 파일의 진행 중 세대가 extractor 버전별로 둘 있으면 0004가 UNIQUE로 실패 — 0002가 허용한 상태지만 `document_extractions`를 쓰는 코드가 아직 없어(epic-attachments) 어떤 설치에서도 생길 수 없다; 고치려면 옛 세대를 `failed`로 닫는 지어낸 상태 쓰기가 필요해 이득보다 위험이 크다.
  - `[low]` `[patch]` `document_chunks_locator_update`가 이미 null인 옛 행에 null을 다시 쓰는 update도 거부, 옛 null 행은 복구 삽입도 거부 — update 쪽은 `old.chunk_locator is not null` 조건을 더해 고침(테스트 추가). 복구 삽입 쪽은 0004 이전 조각 행이 어떤 설치에도 없고 복구는 epic-operations가 설계하므로 고치지 않음.
  - `[low]` `[patch]` README의 `installed.json`·`setup run --json` 예시가 `schema_version: 3` — 4로 고침, `tooling/bootstrap/test/bootstrap.test.ts`의 무관한 fixture 값도 4로 맞춤.
  - `[medium]` `[patch]` `schema-files.test.ts`의 `(file_id, attempt)` 키 사례가 실은 진행 중 인덱스를 시험 — 첫 행을 끝난 세대(`status: 'ok'`, `finished_at`)로 바꿔 키 자체를 다시 고정함.
  - `[low]` `[patch]` `deferred-work.md`가 0004로 해결된 세 항목(`redactions` trigger, 파일 가리기 자리, `index_config_id`)을 미해결로 둠 — "해결됨(2.6 …)"으로 고침.
  - `[low]` `[patch]` Postgres가 0004만큼 더 갈라진 것이 등록부에 없음 — `deferred-work.md` Triage 표에 epic 7 항목을 더함.
  - `[low]` `[reject]` Core `Failure` 타입이 없어진 `harness_session_id`를 적음 — plan Decision(타입은 쓰는 스토리가 바꿈)대로이고 쓰는 코드가 없다; 2.11이 놓치지 않게 `deferred-work.md`에 항목으로 남김.
  - `[false]` `[reject]` `{"type":"pdf"}`(page 없음)를 받아들임 — AD-24 정규형은 null을 생략하므로 page 없는 pdf 위치는 규칙상 가능하고, page 사본 규칙(`page is $.page`)은 지켜진다.

## Design Notes

청구 인덱스: 열 순서 `(attempts, id)`가 `ORDER BY`를 그대로 주고, 부분 조건이 질의의 `completed_at is null`과 같아 플래너가 쓸 수 있으며, `next_attempt_at`을 셋째 열로 두어 필터를 표 조회 없이 한다. 옛 `(next_attempt_at)` 인덱스를 남기면 플래너가 그것과 임시 정렬을 고를 수 있으므로 지운다.

`redactions` 재생성은 참조하는 테이블이 없지만 `files`를 새로 참조하므로 같은 패턴으로 한다. `document_extractions`는 `files.current_extraction_id`와 `document_chunks.extraction_id`가 가리키므로 `defer_foreign_keys`가 필요하다. `files`의 trigger 본문이 이 테이블 이름을 쓰지만 drop은 막지 않는다(실행 때 이름으로 풂).

## Verification

**Commands:**
- `pnpm test` (build → `tsc -p tsconfig.test.json` → `vitest run`) -- expected: 모두 통과, `apps/cli/dist/build.json`의 `schema_version`이 4
  - 결과: `Test Files 42 passed (42) / Tests 1238 passed (1238)`(Postgres 통합 테스트는 `BRAIN_TEST_DATABASE_URL`을 띄운 상태). `apps/cli/dist/build.json`의 `schema_version`은 4.
- Acceptance 1: 0001~0003만 적용한 임시 home(버전 3)에 `SECOND_BRAIN_HOME=<tmp> node apps/cli/dist/install.js --yes` -- 결과: `0004_capture_columns.sql을 적용했고, 스키마 버전은 4입니다`, `schema-version: ok 4`, `brain doctor run`도 `schema-version: ok 4`, `schema_version` 행은 version 4.
- Acceptance 2: 새 home 마이그레이션 -- 결과: `schema.test.ts`의 테이블 목록 단정이 손대지 않고 통과(테이블 목록 그대로), 타입 검사 통과.
  - 리뷰 패치 뒤 재실행: `Test Files 42 passed (42) / Tests 1239 passed (1239)`.

## Auto Run Result

**요약:** SQLite 마이그레이션 0004(`packages/sqlite/migrations/0004_capture_columns.sql`)로 가리기·추출·서브에이전트·브랜치 칸과 실패 대상 키, drain 청구 인덱스를 더하고 `SQLITE_SCHEMA_VERSION`을 4로 올렸다. 동작 코드는 없다. 티켓 verify(3→4 데이터 보존, 각 중복 거부, `redactions` 변경 거부, 메시지 새 칸 불변, 청구 질의에 임시 정렬 없음, 재실행 `applied=[]`)는 `packages/sqlite/test/schema-0004.test.ts`가 고정한다.

**바뀐 파일:**
- `packages/sqlite/migrations/0004_capture_columns.sql` — 새 마이그레이션(칸 추가, `redactions`·`document_extractions`·`failures` 재생성, trigger·인덱스 교체)
- `packages/sqlite/src/migrate.ts` — 스키마 버전 4
- `packages/sqlite/test/schema-0004.test.ts` — I/O 매트릭스 전 행
- `packages/sqlite/test/{schema,schema-files,users}.test.ts`, `apps/cli/test/{install-flow,sessions-ingest}.test.ts`, `tooling/bootstrap/test/bootstrap.test.ts` — 버전·파일 목록·새 필수 칸에 맞춤
- `README.md` — 예시의 `schema_version` 4
- `_bmad-output/personal-brain/deferred-work.md` — 해결된 세 항목 표시, Postgres 갈라짐·Core 타입 항목 추가

**리뷰:** quick 1회, 8건. 패치 5(medium 1, low 4), 보류 0, 거부 3(위 Triage Log에 이유). 후속 리뷰 권고: false(patched high 0, medium 1).

**검증:** `pnpm test`(build → typecheck → vitest, Postgres 통합 포함) 42 파일 1239 테스트 통과. `apps/cli/dist/build.json`의 `schema_version` 4. 임시 home의 버전 3 설치에서 `install.js --yes`가 0004를 적용하고 doctor `schema-version: ok 4`.

**에이전트가 대신 내린 결정** (모두 위 intent-contract에 Decision으로 기록):
1. 서브에이전트 표시는 `messages.is_subagent_report` 불리언 하나(다른 안: `subagent_id` 텍스트).
2. `chunk_locator`는 재생성 없이 nullable 칸 + 새 null 거부 trigger(다른 안: 재생성해 `not null`, 옛 행에 위치를 지어 채움).
3. `document_extractions.index_config_id` nullable, `failed_stage`는 `failed`일 때도 필수 아님(다른 안: `not null` + 기본 설정 id로 채움, `failed`면 필수).
4. `failures` 옛 행은 세션 토큰 대상 키로 옮김(다른 안: 버림).
5. Core 도메인 타입(`Message`·`Redaction`·`Failure`)은 바꾸지 않음 — 2.7·2.9·2.11이 바꿈(다른 안: 지금 맞춤).
6. 리뷰 패치는 구현 서브에이전트에 다시 보내지 않고 메인 세션이 직접 적용(작고 기계적이라서).

**사람 확인 필요:**
- 구현 중 사고로 생긴 설치 사본 `<임시 scratchpad>/second_brain-accidental-install`을 지워도 되는지(빈 DB·설정·shim뿐, 사용자 데이터 없음, 실제 `~/.second_brain`은 원래처럼 없음).
- 위 결정 1~5가 맞는지. 특히 1(서브에이전트 표시 모양)은 2.7 parser가 그대로 쓸 수 있는지.

**남은 위험:** Postgres 복제본이 0004만큼 더 뒤처졌다(epic 7에 등록). 0002가 허용하던 "한 파일의 버전별 진행 중 세대 둘"이 있는 DB는 0004에서 실패하지만, 그런 행을 쓰는 코드가 아직 없어 실제로는 생기지 않는다.
