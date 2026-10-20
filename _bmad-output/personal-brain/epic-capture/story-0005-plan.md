---
title: '마이그레이션 0005: 도구 메모 가리기 기록·호출 키·실패 단계 강제·프로젝트 비교 키'
type: 'feature'
ticket: '18'
created: '2026-10-20'
status: 'built'
baseline_revision: 'a689b91eee79b042e7e15b7494d8ddc7b52e9b42'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: true
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 13(도구 메모 가리기 기록)·20(대소문자 비교 키)·23(도구 메모 호출 키)·epic-attachments(추출 실패 단계)와 실패 횟수가 쓸 칸과 규칙이 스키마에 없다. 그리고 비교 키를 UNIQUE로 들이면 이미 대소문자만 다르게 갈라진 프로젝트가 있는 DB는 마이그레이션이 실패한다.

**Approach:** SQLite 마이그레이션 `0005_identity_and_records.sql` 하나로 칸·trigger·인덱스를 놓고 `SQLITE_SCHEMA_VERSION`을 5로 올린다. 0005 전에 `setup run`이 비교 키가 겹치는 프로젝트 묶음을 찾아 보이고 묻는다. 동의하면 0005와 같은 트랜잭션에서 합친 뒤 적용한다. 실패 기록 함수(SQLite·가짜)는 처음 난 때와 횟수를 채운다. 새 NOT NULL 칸 때문에 깨지는 쓰기(`projects` 삽입)만 최소로 고친다.

## Boundaries & Constraints

**Always:**
- 0001~0004 파일은 바꾸지 않는다. 모든 기존 행을 보존한다(합치기에 동의한 프로젝트 묶음만 예외).
- 재생성은 0004와 같다: 파일 맨 위 `pragma defer_foreign_keys = ON`, temp stash → `drop`(rename 금지) → 같은 열 순서 + 새 칸을 끝에 두고 create → copy → stash drop. 지운 테이블의 인덱스·trigger를 다시 만든다. `STRICT`, 시각은 정규형 `glob` check, 주석은 *왜*를 영어로 적는다(0004 문체).
- 칸과 규칙(이름은 이대로):
  - `redactions` 재생성: 끝에 `tool_note_id text references tool_notes (id)`를 더한다. check는 셋 중 정확히 하나(`(message_id is not null) + (file_id is not null) + (tool_note_id is not null) = 1`)다. 파일 가리기는 `start`·`end`가 둘 다 null이다. 메시지·도구 메모 가리기는 둘 다 있고 `0 <= start < end`다(도구 메모는 그 대상 위의 구간). `redactions_immutable_update`·`_delete`를 다시 만든다. 옛 행은 `tool_note_id = null`이다.
  - `document_extractions` trigger 둘:
    - insert: `new.status = 'failed' and new.failed_stage is null`이면 거부한다.
    - update: `new.status = 'failed' and new.failed_stage is null and (old.status is not 'failed' or old.failed_stage is not null)`이면 거부한다. 단계를 지우는 것도 막고, 0004 이전에 이미 `failed`였던 단계 없는 행의 다른 칸 update는 허용한다.
    - 메시지는 `document_extractions.failed_stage is required when status becomes failed`를 담는다.
  - `projects` 재생성(참조됨 → 지연 FK): 끝에 `identity_key text not null unique`를 더한다. 채우는 식은 `case when lower(remote_identity) glob 'github.com/*' or lower(remote_identity) glob 'bitbucket.org/*' then lower(remote_identity) else remote_identity end`다. `remote_identity not null unique`는 그대로 둔다.
  - `failures` 재생성: 끝에 `first_occurred_at text not null`(정규형 glob check)와 `occurrences integer not null check (occurrences >= 1)`를 더한다(기본값 없음). 옛 행은 `first_occurred_at = occurred_at`, `occurrences = 1`이다.
  - `tool_notes`: 재생성하지 않는다(FTS의 `search_rowid` 위험, 0004 `chunk_locator`와 같은 이유).
    - `alter table tool_notes add column call_id text`를 한다.
    - `create unique index tool_notes_call_id_idx on tool_notes (session_id, call_id) where call_id is not null`을 만든다.
    - `tool_notes_immutable_update`를 drop하고, `new.call_id is old.call_id`를 더해 같은 메시지로 다시 만든다.
- Decision(에이전트, 사용자 위임 범위): `tool_notes`의 "0004와 같은 재생성"은 표 재생성이 아니라 0004의 `messages`처럼 칸 추가 + 불변 trigger 재생성으로 읽었다. 관찰되는 결과(nullable, 세션 안 UNIQUE, 불변)는 같다. 다른 안: 표 재생성(FTS rowid와 FTS trigger를 다시 맞춰야 함).
- Decision(에이전트): 합치기는 `runSqliteMigrations`의 새 옵션 `mergeProjectKeyCollisions?: boolean`으로 한다. 0005 파일을 적용하는 그 `withWrite` 안에서, 파일 실행 직전에 모든 겹친 묶음을 합친다. 그래서 합치기와 0005는 함께 되거나 함께 안 된다. 옵션이 없는데 겹침이 있으면 0005가 UNIQUE로 거부되어 `MIGRATION_FAILED`(파일 0005)가 되고 DB는 이전 버전으로 남는다. 다른 안: 별도 트랜잭션에서 먼저 합침(합친 뒤 0005가 실패하면 반쯤 바뀐 DB).
- 합치기 규칙(비교 키 식은 위와 같다):
  - 묶음마다 남는 쪽은 `id`가 가장 작은 프로젝트다(UUIDv7 = 먼저 만든 것).
  - 지는 쪽의 워크트리:
    - 남는 쪽에 같은 `path`가 있으면 `sessions.worktree_id`를 남는 쪽 워크트리로 옮기고 지는 워크트리를 지운다. 남는 워크트리의 `removed_at`은 둘 중 하나라도 null이면 null, 아니면 늦은 쪽이다.
    - 없으면 `worktrees.project_id`를 남는 쪽으로 바꾼다.
  - 지는 쪽을 가리키던 `sessions.project_id`와 `log_entries.apply_project_id`를 남는 쪽으로 옮긴 뒤 지는 프로젝트를 지운다.
  - `projects`를 가리키는 다른 FK는 없다(0001~0004 확인).
- 찾기: `findSqliteProjectKeyCollisions(path)`는 읽기 전용이다.
  - 파일을 만들지 않는다.
  - 저장 버전이 5 이상이거나 `projects`가 없으면 `[]`다.
  - 돌려주는 값: 묶음마다 `{identityKey, projects: [{id, remoteIdentity, sessions}]}`(id 순)이고, 묶음은 비교 키 순이다.
  - DB를 열 수 없으면 값으로 실패한다(`DB_UNAVAILABLE`).
- 설치 흐름(`runInstall`): `askToProceed` 뒤, `store.prepare` 앞에 둔다.
  1. `deps.store.collisions(path)`를 부른다(파일이 없거나 DB가 아니면 `[]`, 판정은 `prepare`가 그대로 한다).
  2. 묶음이 있으면 묶음마다 한국어 줄을 낸다: 비교 키, 각 `remote_identity`와 세션 수, 남을 쪽.
  3. `flags.yes`면 동의로 본다. 아니면(TTY) `prompts.confirm`으로 묻는다.
  4. 거절하면 `fail({code: 'SETUP_CANCELLED', message: '프로젝트를 합치지 않기로 했습니다. 데이터베이스는 바꾸지 않았습니다.', exit: 1})`다.
  5. 동의하면 `prepare(path, {mergeProjects: true})`다. 합쳤으면 합친 묶음 수를 한 줄로 알린다.
  6. 비TTY + `--yes` 없음은 기존 동의 게이트가 이미 exit 3 `CONFIRMATION_REQUIRED`로 막는다(바꾸지 않음).
- `recordFailure`(SQLite `work.ts`, 가짜 `fakes/store.ts`):
  - 새 행: `first_occurred_at = occurred_at`, `occurrences = 1`.
  - 같은 키: `first_occurred_at`은 그대로 두고 `occurrences = occurrences + 1`이다. `occurred_at`·`message`·`resolved_at = null`은 지금처럼 바꾼다.
  - Core `Failure`에 `firstOccurredAt: Date`·`occurrences: number`를 더한다. `listFailures`(SQLite·가짜)가 읽는다.
  - `failures list`: `--json` 행에 `first_occurred_at`(offset 형식)·`occurrences`를 더하고, 텍스트 줄에 `, 횟수 N`을 더한다.
- Decision(에이전트): `projects.identity_key`가 NOT NULL이므로 SQLite `ensureCheckout`이 위의 같은 식으로 그 칸을 채우고, 찾기도 그 식의 값으로 `identity_key`에서 한다(`remote_identity`로 찾으면 대소문자만 다른 remote에서 `UnsettledEnsure`가 난다). Core 비교 키 함수·호스트 상수·포트 입력·가짜 store 키는 20이 만든다. 다른 안: 찾기는 `remote_identity` 그대로(20 전까지 대소문자 다른 remote가 수집 실패).
- `--yes`는 플러그인 bootstrap(비대화형 `--yes`)에서도 합치기 동의가 된다. "미리 준 모든 동의"라는 `--yes`의 정의대로이고, README에 적는다.

**Never:**
- `call_id`·`tool_note_id`를 쓰는 parser·redact 코드, 추출 Store, Core 비교 키 함수(20·13·23·epic-attachments의 몫). 도구 메모 잘림 표시 칸(deferred, 23).
- Postgres 마이그레이션(epic 7). `foreign_keys = OFF`, `alter table … rename`. 기존 마이그레이션 파일 수정.
- 단정의 뜻을 바꾸는 기존 테스트 수정(버전·파일 목록·새 필수 칸을 맞추는 것만).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 4→5 | v4 DB(0001~0004만 복사한 폴더로 만듦). 모든 대상 테이블에 행이 있고, `github.com/Owner/Repo`·`gitlab.com/A/B`·로컬 경로 프로젝트, 실패 행 하나, 도구 메모, 단계 없는 `failed` 추출 | `{from: 4, to: 5, applied: ['0005_…']}`. id·건수가 그대로다. `identity_key`는 `github.com/owner/repo`·`gitlab.com/A/B`·경로 그대로다. 실패는 `first = occurred`, `occurrences = 1`. `call_id`는 null. 옛 `failed` 행이 읽힌다 | — |
| 재실행 | v5 | `applied: []` | — |
| 가리기 대상 | 둘/셋/없음, `tool_note_id`인데 위치 없음, 도구 메모 위치 정상 | 앞의 넷은 거부, 마지막은 허용 | check |
| 가리기 불변 | update·delete(표시 있음·없음) | 거부 | trigger |
| 추출 실패 | 단계 없이 `failed`로 insert·update, 단계를 null로 바꿈, 옛 단계 없는 `failed` 행의 `error` update | 앞의 셋은 거부, 마지막은 허용 | trigger |
| 비교 키 | v5에 `github.com/a/b` 있음 → `github.com/A/B` 직접 insert | 거부 | UNIQUE |
| 호출 키 | 같은 세션 같은 `call_id` 둘 / 다른 세션 / null 둘 / 표시 아래 `call_id` update | 거부 / 허용 / 허용 / 거부 | index·trigger |
| 겹친 v4, 옵션 없음 | `github.com/Owner/Repo`·`github.com/owner/repo` | `MIGRATION_FAILED`, 파일 0005, 버전 4 그대로 | 값 |
| 겹친 v4, 합치기 | 위 + 각 프로젝트에 세션·워크트리(같은 path 하나·다른 path 하나)·`apply_project_id` 로그 | v5, 프로젝트 1개(작은 id), 세션 수 보존, 같은 path 워크트리 1개로 합침, 모든 참조가 남는 쪽 | — |
| 찾기 | 겹친 v4 / v5 / 파일 없음 | 묶음 1개(세션 수 포함) / `[]` / `[]`(파일 생기지 않음) | — |
| 같은 원인 셋 | `recordFailure` 3번(t1·t2·t3, 다른 message) | 한 행, `occurrences 3`, first = t1, `occurred_at`·message = 셋째 | 계약(SQLite·가짜) |
| 설치 TTY 동의/거절 | 가짜 store의 묶음 하나 | 묶음 줄 → 물음; 예: `prepare(…, {mergeProjects: true})`; 아니오: `SETUP_CANCELLED` exit 1, `prepare` 안 불림 | — |
| 설치 `--yes` | 같음 | 묻지 않고 합침 | — |
| 수집 | v5에 `github.com/owner/repo` 프로젝트, 새 세션의 remote `github.com/Owner/Repo` | 같은 프로젝트로 들어감(예외 없음) | — |

</intent-contract>

## Code Map

- `packages/sqlite/migrations/0004_capture_columns.sql` -- 재생성·trigger 재생성 본보기와 주석 문체(읽기 전용). `redactions`(198-248), `failures`(353-391), `messages` trigger 교체(77-94).
- `packages/sqlite/migrations/0001_initial.sql` -- `projects`(48-52), `worktrees`(55-64), `tool_notes`(132-143), `log_entries.apply_project_id`(157), `tool_notes_immutable_update`(352-365), tool_notes FTS trigger(434-441). 읽기 전용.
- `packages/sqlite/src/migrate.ts` -- 고칠 곳:
  - 19행: `SQLITE_SCHEMA_VERSION = 5`.
  - `RunSqliteMigrationsOptions`(30-45)에 `mergeProjectKeyCollisions`를 더한다.
  - 루프(128-166)에서 `file.version === 5`이고 옵션이 켜져 있으면, `connection.database.exec(statements)` 직전에 `held`로 합치기를 한다.
  - `withWrite` 안에서는 `held`만 쓰고 중첩하지 않는다(`write.ts:44-50`). 어기면 멈춘다.
- 새 `packages/sqlite/src/project-keys.ts` -- 비교 키 SQL 식(한 곳), `findSqliteProjectKeyCollisions(path)`(`openSqlite({create: false})`, `connect.ts:106-118`), 합치기 함수(held를 받음). `packages/sqlite/src/index.ts:27-33`에서 접두어 이름으로 export한다.
- `packages/sqlite/src/sessions.ts:412-426` `ensureCheckout` -- `identity_key`를 넣고 `identity_key`로 찾는다. 식은 `project-keys.ts`의 것을 쓴다.
- `packages/sqlite/src/work.ts`:
  - `recordFailure` 336-346: insert와 on conflict에 새 칸을 넣는다. 335행 주석을 고친다.
  - `listFailures` 422-423, `FailureRow` 474-486, `toFailure` 488-502: 새 칸을 읽는다.
- `packages/core/src/domain/failure.ts` -- `Failure`에 두 칸을 더한다. `packages/core/src/ports/store.ts:442-447` 주석의 0005 언급을 고친다.
- `packages/core/src/testing/fakes/store.ts:462-514` -- 새 행(480-492)과 같은 키(498-500)에 두 칸을 넣는다.
- `packages/core/src/testing/contracts/work-store.ts` -- 새 계약 사례: "같은 원인 세 번은 한 행, occurrences 3, first는 첫째". 344행 사례 옆에 둔다. `listFailures`로 읽는다.
- `apps/cli/src/commands/failures-list.ts:95-121` -- `lines()`·`row()`에 새 칸을 넣는다. `FailuresListRow` 타입이 있는 곳도 고친다. 메타 `output` 설명에 칸 목록이 있으면 맞춘다.
- `apps/cli/src/install/flow.ts`:
  - `InstallStore`(194-217)에 `collisions(path)`를 더하고, `prepare(path, options?)`로 바꾼다.
  - 흐름에서는 `askToProceed` 처리(409-420)와 `store.prepare`(425) 사이에 넣는다.
  - `prompts.confirm` 모양은 `InstallPrompts`(153-163)를 따른다.
- `apps/cli/src/install/store.ts` -- `prepareStore(path, options?)`(110-147)가 옵션을 `runSqliteMigrations`에 넘긴다. 새 `storeCollisions(path)`는 파일이 없거나 `notADatabase`면 `[]`다. 이 둘을 `InstallStore` 구현에 묶는 곳도 고친다(`install.ts`의 deps 조립).
- `packages/core/src/codes.ts:253-258` -- `SETUP_CANCELLED`가 이미 있다(새 코드 없음, README 코드 표 그대로).
- 테스트:
  - 새 `packages/sqlite/test/schema-0005.test.ts` -- `schema-0004.test.ts`의 `scratch`·`open`·`insert`·`versionThreePath`(116-131) 방식으로 `versionFourPath`(0001~0004 복사)를 만든다. 거부는 `toThrow(/CHECK constraint failed/)`·`/UNIQUE constraint failed/`·trigger 메시지로, 표시 아래 update는 `withWrite(..., {redact: true})`로 본다(570-590).
  - `packages/sqlite/test/work-store.test.ts` -- 206-220의 `select *` `toEqual`에 두 칸을 넣는다. 269-303의 100번 사례에 `occurrences: 100`과 첫 시각을 단정한다.
  - `packages/sqlite/test/session-store.test.ts` -- 대소문자만 다른 GitHub remote 두 세션이 한 프로젝트인 사례(SQLite만).
  - `apps/cli/test/install-flow.test.ts`:
    - `fakeStore`(180)에 `collisions`를 더하고 `prepare` 옵션을 기록한다.
    - TTY 동의·거절, `--yes` 사례를 둔다. `TAIL` 물음 큐(86)는 묶음이 있을 때만 하나 늘어난다.
    - 모든 줄은 `assertKoreanLine`(385)을 지나야 한다.
  - `apps/cli/test/setup.test.ts` -- 실제 DB 사례를 둔다(`runBrain`(113), `emptyHome`(70)). `<home>/brain.db`를 `versionFour` 방식으로 만들고 대소문자만 다른 두 프로젝트·세션·워크트리를 넣는다.
    - `setup run --yes`: exit 0, 묶음 줄이 보임, 버전 5, 프로젝트 1, 세션·워크트리 건수 보존.
    - `--yes` 없음: exit 3이고 DB가 바이트 그대로다(버전 4).
    - 테스트용 v4 DB를 만드는 helper가 apps/cli에 없으면, `@second-brain/sqlite`의 `runSqliteMigrations({directory})`로 0001~0004만 복사한 폴더를 쓴다.
- 버전 고정을 고칠 곳:
  - `packages/sqlite/test/schema.test.ts:117,122,390`
  - `schema-0004.test.ts:136,242-247,346`, 그리고 `select * from redactions` `toEqual`(272)
  - `schema-files.test.ts:97,102,353-354`
  - `users.test.ts:158-159`
  - `failures`·`projects`에 원시 insert를 하는 곳: `schema.test.ts:187-191,280,567,646`, `schema-0004.test.ts:446,450,465`, `apps/cli/test/capture-scan.test.ts:613,648`. 새 필수 칸을 넣는다. v3 DB에 넣는 `schema-0004.test.ts:178`은 그대로 둔다.
  - 표면만 맞추는 곳: `install-flow.test.ts`의 버전 값들, `packages/core/test/brain-drain.test.ts:66,70`, `tooling/bootstrap/test/bootstrap.test.ts:814`.
- `README.md` -- 고칠 곳:
  - `schema_version` 예시(156, 437)를 5로 바꾼다.
  - 설치 취소 문단(128-134)에 프로젝트 합치기 물음, `--yes`의 뜻, 거절하면 버전이 그대로라는 것을 적는다.
  - `failures list` 설명에 횟수가 있으면 맞춘다.
- `_bmad-output/personal-brain/deferred-work.md` -- 고칠 곳:
  - 76행(도구 메모 가리기 기록 자리)을 "자리는 0005, 쓰기는 13"으로 바꾼다.
  - 122행 항목의 처음·횟수 칸을 해결로 표시한다.
  - 74행에 `tool_notes.call_id`와 projects 재생성을 더한다.
  - 새 항목: SQLite 쪽 비교 키 식은 20이 Core 함수·상수로 옮긴다(가짜 store는 아직 `remoteIdentity` 키).

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0005_identity_and_records.sql`, `packages/sqlite/src/migrate.ts` -- Always의 칸·trigger·인덱스, 버전 5, 합치기 옵션 -- 스키마 자리 한 번에.
- [x] `packages/sqlite/src/{project-keys,index,sessions}.ts` -- 찾기·합치기, `ensureCheckout`의 `identity_key` -- 새 NOT NULL 칸에서 수집이 깨지지 않게.
- [x] `packages/core/src/domain/failure.ts`, `packages/core/src/ports/store.ts`, `packages/core/src/testing/{fakes/store,contracts/work-store}.ts`, `packages/sqlite/src/work.ts`, `apps/cli/src/commands/failures-list.ts` -- 처음 난 때·횟수 쓰기와 읽기 -- 같은 원인 한 행.
- [x] `apps/cli/src/install/{flow,store}.ts`, `apps/cli/src/install.ts` -- 묶음 보이기·묻기·합치기 -- 0005 전 갈라진 프로젝트.
- [x] `packages/sqlite/test/schema-0005.test.ts` -- I/O 매트릭스의 스키마·합치기·찾기 행 -- 티켓 verify.
- [x] `packages/sqlite/test/{work-store,session-store}.test.ts`, `apps/cli/test/{install-flow,setup}.test.ts` -- 계약·수집·설치 행.
- [x] 위 "버전 고정" 목록의 테스트 -- 버전·파일 목록·새 필수 칸만 맞춤.
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문서.

**Acceptance Criteria:**
- Given 대소문자만 다른 GitHub 프로젝트 둘이 있는 v4 DB의 임시 home. When `brain setup run --yes`, then 출력에 그 묶음(두 `remote_identity`와 세션 수)이 보이고, exit 0이며, `brain doctor run`의 `schema-version`이 `5`이고, 프로젝트는 하나이며, 세션·워크트리 건수가 그대로다(같은 path 워크트리는 하나로 합쳐진다).
- Given 같은 DB. When 비TTY에서 `--yes` 없이 `setup run`, then exit 3 `CONFIRMATION_REQUIRED`이고 DB 파일이 바뀌지 않는다.
- Given TTY 설치(가짜 prompts)에서 합치기를 거절. When 흐름이 끝나면, then `SETUP_CANCELLED` exit 1이고 `prepare`가 불리지 않는다(DB는 버전 4).
- Given 같은 실패 원인을 세 번 기록. When `brain failures list --json`, then 한 행이고 `occurrences`가 3이며 `first_occurred_at`은 첫째, `occurred_at`·`message`는 셋째의 것이다.
- Given `pnpm test`. When 실행하면, then build·typecheck·vitest가 모두 통과하고(출력 언어 검사·README 코드 대조 포함) `apps/cli/dist/build.json`의 `schema_version`이 5다.

## Implementation Notes

- (구현 서브에이전트) 찾기는 파일이 없으면 열기 전에 `stat`으로 `{ok: true, groups: []}`를 답하고, `DB_UNAVAILABLE`은 파일이 있는데 열리지 않을 때만 낸다(Boundaries의 "열 수 없으면 `DB_UNAVAILABLE`"과 매트릭스의 "파일 없음 → `[]`"을 둘 다 지키려고 나눔).
- `SqliteMigrationResult`는 Postgres runner와 같은 모양이라 합친 수를 싣지 않았다. 흐름의 "합쳤습니다" 줄은 보여 주고 동의받은 묶음 수다(리뷰 4번 지적, 거부 이유는 Triage Log).
- `ensureCheckout`은 키를 DB 식으로 한 번 계산해 bind한다 — `insert … select … on conflict`의 파싱 모호성을 피하고 upsert를 `values` 모양으로 두려고.
- `mergeSqliteProjectKeyCollisions`는 Code Map대로 공개이고 `withWrite` 안의 `held`로만 불러야 한다(doc 주석에 적음).
- `schema-0004.test.ts`의 describe 제목("3→4")은 단정 뜻을 바꾸지 않는다는 규칙대로 두었다(이제 배포 폴더는 5까지 간다).
- (메인 세션) 리뷰 패치 5건은 같은 구현 서브에이전트가 적용했다.

## Plan Change Log

## Review Triage Log

### 2026-10-20 — Review pass
- verdicts: 6 findings — high 0, medium 2, low 4, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` `packages/core/src/ports/store.ts` ensureSession 주석이 아직 "프로젝트는 `remoteIdentity`로 찾고 모든 adapter가 지킨다"고 함 — SQLite는 0005부터 `identity_key`로 찾고 가짜는 `remoteIdentity` 그대로다(확인). 주석을 지금 사실로 고침(가짜·Core 함수는 20).
  - `[medium]` `[patch]` AC 4의 `failures list --json` 쪽(`first_occurred_at`·`occurrences`)을 단정하는 테스트가 없음 — `apps/cli/test`에 두 키를 보는 단정이 없음을 확인. `capture-scan.test.ts`의 `FailuresData`와 `--json` 단정에 두 키를 더함.
  - `[medium]` `[patch]` `schema-0005.test.ts`의 "찾기 = 0005가 거부하는 묶음" 사례가 한 방향만 잡음 — 마이그레이션 CASE에서만 bitbucket 갈래를 빼면 찾기가 여전히 묶고 합쳐 행 수·고유 키 수가 7/7로 통과한다(산술 확인). 합친 뒤 남은 행의 저장된 `identity_key`를 id별 리터럴 목록으로 단정하게 함.
  - `[low]` `[reject]` 다른 설치기가 `collisions`와 `prepare` 사이에 0005를 먼저 적용하면 "합쳤습니다" 줄이 이 실행이 하지 않은 합치기를 알림 — 실제로 생길 수 있으나 같은 home에 설치기 둘이 겹쳐야 하고(일상 사용에서 드묾), 고치려면 결과에 합친 수를 싣거나 `applied`로 거르는 분기가 더해진다. DB 상태는 맞고 줄 하나만 틀린다.
  - `[low]` `[patch]` `apps/cli/src/install/store.ts`에서 `PrepareStoreOptions`가 `prepareStore`의 doc 주석과 함수 사이에 끼어 0600/0700 이유가 interface 쪽에 붙음 — interface를 주석 위로 옮김.
  - `[low]` `[patch]` README 합치기 문단이 "두 `remote_identity`"라고 함 — 묶음은 셋 이상일 수 있다(흐름이 프로젝트마다 한 줄, 테스트에 셋인 묶음). "묶음의 각 `remote_identity`"로 고침.

## Design Notes

합치기를 0005와 한 트랜잭션에 두는 이유: 합친 뒤 0005가 다른 이유로 실패하면, 사용자가 동의한 결과의 절반(행은 지워졌는데 비교 키는 없음)만 남는다. 마이그레이션 runner는 파일마다 이미 `withWrite` 하나를 쓰므로, 그 안에서 파일 실행 직전에 합치면 둘이 함께 commit된다. 찾기는 그 트랜잭션 밖에서 미리 하고(보여 주고 묻기 위해), 합치기는 트랜잭션 안에서 다시 찾아 그때의 묶음 전부를 합친다.

```ts
// migrate.ts loop, shape only
const outcome = await withWrite(connection, async (held) => {
  const stored = await readStoredVersion(held);
  if (file.version <= stored) return { stored, took: false };
  if (file.version === 5 && mergeProjectKeyCollisions) await mergeProjectKeyCollisionsIn(held);
  connection.database.exec(statements);
  ...
```

비교 키 식이 SQL에 두 번(0005 파일, `project-keys.ts`) 있다. 마이그레이션 파일은 상수를 import할 수 없기 때문이다. 둘이 같은지는 `schema-0005.test.ts`의 "찾기가 보인 묶음 = 0005가 거부하는 묶음" 사례가 지킨다. SQLite `lower()`는 ASCII만 접는다. GitHub·Bitbucket 이름은 ASCII라 충분하다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과. `apps/cli/dist/build.json`의 `schema_version`이 5다.

**Manual checks (if no CLI):**
- 0001~0004만 적용한 임시 home(`SECOND_BRAIN_HOME=<tmp>`)에 대소문자만 다른 두 프로젝트를 넣는다. 그다음 `node apps/cli/dist/bin.js setup run --yes`를 돌리면 묶음 줄과 `0005_identity_and_records.sql을 적용했고, 스키마 버전은 5입니다`가 보인다. home 변수 이름은 `SECOND_BRAIN_HOME`이다(2.6 사고 참고). 실제 `~/.second_brain`은 절대 건드리지 않는다.

## Auto Run Result

**요약:** SQLite 마이그레이션 0005(`packages/sqlite/migrations/0005_identity_and_records.sql`)로 `redactions.tool_note_id`(대상 셋 중 하나), `document_extractions`의 `failed_stage` 강제 trigger, `projects.identity_key`(NOT NULL·UNIQUE, GitHub·Bitbucket은 소문자), `failures.first_occurred_at`·`occurrences`, `tool_notes.call_id`(세션 안 UNIQUE)를 놓고 `SQLITE_SCHEMA_VERSION`을 5로 올렸다. `setup run`은 0005 전에 비교 키가 겹치는 프로젝트 묶음을 보이고 묻는다(`--yes`는 동의, TTY는 물음, 거절은 `SETUP_CANCELLED`·DB 그대로). 동의하면 0005와 같은 트랜잭션에서 먼저 만든 프로젝트로 합친다. `recordFailure`(SQLite·가짜)는 처음 난 때를 지키고 횟수를 올리며, `failures list`가 둘을 보인다.

**바뀐 파일:**
- `packages/sqlite/migrations/0005_identity_and_records.sql` — 새 마이그레이션(`redactions`·`projects`·`failures` 재생성, trigger·인덱스)
- `packages/sqlite/src/project-keys.ts` — 비교 키 SQL 식, 겹친 묶음 찾기(읽기 전용), 합치기
- `packages/sqlite/src/{migrate,sessions,work,index}.ts` — 버전 5와 합치기 옵션, `identity_key`로 찾고 채우기, 처음 난 때·횟수, export
- `packages/core/src/{domain/failure,ports/store}.ts`, `packages/core/src/testing/{fakes/store,contracts/work-store}.ts` — `Failure` 두 칸, 가짜, 계약 사례, 포트 주석
- `apps/cli/src/install/{flow,store}.ts`, `apps/cli/src/install.ts` — 묶음 보이기·묻기·합치기
- `apps/cli/src/commands/failures-list.ts` — `--json` 두 키와 텍스트 `횟수 N`
- `packages/sqlite/test/schema-0005.test.ts`(새), `packages/sqlite/test/{work-store,session-store,schema,schema-0004,schema-files,users}.test.ts`, `apps/cli/test/{install-flow,setup,capture-scan}.test.ts`, `packages/core/test/brain-drain.test.ts`, `tooling/bootstrap/test/bootstrap.test.ts` — 새 사례와 버전·필수 칸 맞춤
- `README.md`, `_bmad-output/personal-brain/deferred-work.md` — 문서와 항목

**리뷰:** quick 1회, 6건. 패치 5(medium 2, low 3), 보류 0, 거부 1(동시에 다른 설치기가 0005를 먼저 적용하면 "합쳤습니다" 줄이 틀림 — 드물고 고치려면 분기가 더해짐, DB 상태는 맞음).

**후속 리뷰 권고: true** — 첫 패스에 medium 2건을 패치했다(patched high 0, medium 2, low 3). 남은 검증 안 된 위험: 비교 키 식이 SQL 두 곳에 있고, 둘이 같은지는 리뷰 뒤에 고친 `schema-0005.test.ts`의 리터럴 단정 하나가 지킨다. 합치기는 행을 지우므로 그 식과 합치기 규칙(같은 path 워크트리, `removed_at`)을 한 번 더 보는 값이 있다.

**검증:** `pnpm test`(build → typecheck → vitest) 63 파일 2028 테스트 통과, 리뷰 패치 뒤 다시 통과. `apps/cli/dist/build.json`의 `schema_version` 5. 매트릭스 모든 행에 통과한 테스트가 있다(`schema-0005.test.ts`, 계약, `session-store`, `install-flow`, `setup`). 구현 서브에이전트가 임시 `SECOND_BRAIN_HOME`에서 수동 확인(묶음 줄, `0005_identity_and_records.sql을 적용했고, 스키마 버전은 5입니다`, 합침 줄, `schema-version: ok 5`)을 했다. 실제 `~/.second_brain`은 건드리지 않았다.

**에이전트가 대신 내린 결정**(intent-contract에 Decision으로 기록):
1. `tool_notes`는 표 재생성 대신 칸 추가 + 부분 UNIQUE 인덱스 + 불변 trigger 재생성.
2. 합치기는 0005와 같은 트랜잭션(`mergeProjectKeyCollisions` 옵션).
3. SQLite `ensureCheckout`이 `identity_key`를 채우고 그것으로 찾는다(Core 함수·가짜는 20).
4. "다음"을 준비된 유일한 티켓 2.18로 읽었다.

**사람 확인 필요:**
- 플러그인 bootstrap은 `--yes`로 돌므로, 갈라진 프로젝트가 있는 DB는 묻지 않고 합쳐진다(`--yes`의 정의대로, README에 적음). 이것이 괜찮은지.
- 위 결정 1~3.

**남은 위험:** 가짜 store는 아직 `remoteIdentity`로 프로젝트를 찾아 SQLite와 대소문자 접기에서 다르다(20이 맞춤, deferred에 기록). Postgres는 0005만큼 더 갈라졌다(epic 7). `call_id`·`tool_note_id`를 쓰는 코드는 아직 없다(23·13).

