---
title: 'seq 삭제: 마이그레이션 0006과 시각 순서'
type: 'refactor'
ticket: '24'
created: '2026-10-20'
status: 'built'
baseline_revision: '2e64c6af0b40dc0c3723a9f54bf47604c371e7cd'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/change-drop-message-seq/change-drop-message-seq.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** `messages.seq`가 주소와 읽는 순서를 함께 맡는다. 그래서 parser 버전 업으로 대화 중간의 메시지가 나중 배치로 들어오면 `max(seq)+1`을 받아 대화 끝에 읽힌다(2.7 follow-up 리뷰 #10). 사용자 결정(2026-10-20, change-drop-message-seq)은 `seq`를 지우는 것이다. 대화 순서는 `occurred_at` 하나로 하고, 대신할 칸·키는 만들지 않는다.

**Approach:** SQLite 마이그레이션 `0006_drop_message_seq.sql`이 다음을 한다. `SQLITE_SCHEMA_VERSION`은 6이다.
- `messages`를 `seq` 없이 재생성한다.
- `log_entries`의 두 칸을 `drop column`으로 지운다.
- `chunks`를 `from_at`·`to_at`으로 재생성한다.

SQLite Store와 Core 가짜 store는 번호를 붙이지 않는다. 읽기 정렬과 커서 전진 비교는 `occurred_at`으로 한다. Core 도메인 타입·계약 사례·테스트·README·주석에서 `seq`를 걷어 낸다.

## Boundaries & Constraints

**Always:**
- 0001~0005 파일은 바꾸지 않는다. 기존 메시지·도구 메모·가리기·첨부·로그 행은 id·본문·건수 그대로 보존한다.
- 0006의 문체와 재생성 방식은 0004·0005를 따른다.
  - 파일 맨 위에 `pragma defer_foreign_keys = ON`을 둔다. `redactions.message_id`와 `message_attachments.message_id`가 `messages`를 가리키기 때문이다.
  - 재생성 순서: temp stash → `drop`(rename 금지) → create → copy → stash drop. 지운 테이블의 trigger·인덱스를 다시 만든다.
  - `STRICT`를 쓰고, 시각 칸에는 정규형 `glob` check를 둔다. 주석은 *왜*를 영어로 적는다.
- `messages`(재생성)
  - 칸 순서: `id, session_id, harness_message_id, role, model, body, occurred_at, git_branch, is_subagent_report`.
  - 남기는 제약: `unique (session_id, harness_message_id)`, role·occurred_at·is_subagent_report check.
  - `unique (session_id, seq)`는 없앤다.
  - `messages_immutable_update`를 0004의 칸 목록에서 `seq`만 뺀 채, 같은 메시지로 다시 만든다. `messages_immutable_delete`도 다시 만든다.
  - 새 인덱스 `messages_session_occurred_idx on messages (session_id, occurred_at)`를 만든다(읽기 정렬과 커서 비교용).
- `log_entries`: `alter table … drop column anchor_seq`, `drop column joined_upto_seq`. 재생성하지 않는다(FTS `search_rowid` 보존).
- `chunks`(재생성)
  - 칸: `search_rowid integer primary key, id, session_id, index_config_id, from_at, to_at, body`.
  - 시각 둘은 정규형 glob check를 두고, `from_at <= to_at`이다.
  - 키는 `unique (session_id, index_config_id, from_at, to_at)`다.
  - 옛 행이 있으면 `search_rowid`를 그대로 두고 옮긴다. `from_at`·`to_at`은 같은 세션의 `seq_from`·`seq_to` 메시지의 `occurred_at`이다(join).
  - `chunks_fts_ai`·`_ad`·`_au` trigger를 0001 그대로 다시 만든다.
- Store 규칙(SQLite `sessions.ts`, 가짜 `fakes/store.ts`, 포트 주석이 같은 말을 한다)
  - **메시지 정체:** `(session_id, harness_message_id)`뿐이다. 번호를 붙이지 않는다.
  - **메시지 읽기:** `occurred_at` 오름차순이다. 같은 시각의 순서는 정하지 않는다(가짜는 안정 정렬).
  - **도구 메모 읽기:** 그 메시지의 `occurred_at`, 그다음 `ordinal` 순서다. 메시지가 저장되지 않은 메모는 맨 뒤에 둔다(지금과 같음).
  - **커서 전진:** 다음 중 하나면 커서를 바꾼다.
    - reset이다.
    - 저장된 커서가 없다.
    - 저장된 커서 메시지가 이 세션에 없다.
    - 새 커서 메시지의 `occurred_at`이 저장된 커서 메시지의 것 이상이다.
  - 새 커서 메시지가 저장돼 있지 않으면 커서를 바꾸지 않는다.
- Core `Message.seq`, `Chunk.seqFrom/seqTo`, `LogEntry.anchorSeq/joinedUptoSeq`를 지운다. `Chunk`에는 `fromAt: Date`·`toAt: Date`를 둔다(키 주석도 맞춘다).
- 측정(티켓 verify)은 Design Notes에 있다. 22·23이 parser가 남기는 줄을 바꾸면 다시 잰다.

**Never:**
- Postgres 마이그레이션·Postgres 테스트 수정(epic 7). deferred-work의 Postgres 뒤처짐 항목에 0006만 더한다.
- 같은 시각 메시지의 순서를 정하는 새 칸·키·tie-break 규칙.
- 커서 경고·`start_source`·큰 transcript(21), parser 동작 변경(22·23), `tool_notes` 재생성.
- `foreign_keys = OFF`, `alter table … rename`.
- 완료된 티켓·기록 문서(`_bmad-output`의 epic·spine·plan)의 `seq` 문구 수정.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 5→6 | v5 DB(0001~0005만 복사한 폴더로 만듦). 메시지 셋(`seq`는 시각 순서와 다름), 도구 메모, 메시지 가리기 한 행, 첨부 한 행, `anchor_seq`가 있는 로그 한 행, `seq_from 0`·`seq_to 2` 조각 한 행 | `{from: 5, to: 6, applied: ['0006_…']}`. 모든 테이블 건수·id·본문이 같다. `messages`에 `seq`가 없고, `log_entries`에 두 칸이 없다. 조각은 `from_at`·`to_at`이 seq 0·2 메시지의 시각이고 `search_rowid`가 같으며 `chunks_fts`로 찾힌다. `pragma foreign_key_check`는 비어 있다 | — |
| 재실행 | v6 | `applied: []` | — |
| 메시지 불변 | v6에서 update(가리기 표시 없음)·delete, 가리기 표시 아래 body만 update | 앞의 둘은 거부, 마지막은 허용 | trigger(메시지 문구 그대로) |
| 메시지 키 | 같은 세션·같은 harness id 둘 / 같은 세션·같은 `occurred_at`·다른 harness id 둘 | 거부 / 허용 | UNIQUE |
| 조각 키 | 같은 `(session, config, from_at, to_at)` 둘 / `from_at > to_at` / 정규형 아닌 시각 | 셋 다 거부 | UNIQUE·check |
| 다시 넣기 | 같은 batch 두 번 | 둘째 inserted `{0, 0}`, 건수·id·본문 같음 | 계약(두 Store) |
| 늦게 온 중간 메시지 | msg-1·2·4 저장 뒤 msg-1~4 batch | inserted 1, 읽기는 msg-1,2,3,4. msg-3의 도구 메모도 시각 자리에 있다 | 계약(두 Store) |
| 앞이 바뀐 batch | msg-2·3·4 저장 뒤 msg-1~4 batch | msg-1이 맨 앞에 읽힌다. 저장된 셋의 id·본문은 그대로다 | 계약(두 Store) |
| 겹친 수집 | msg-1·2·4(커서 msg-4) 저장 뒤 msg-1·2·3 batch(커서 msg-3, 나중에 들어온 행) | 커서는 msg-4 그대로다(삽입 순서로 비교하면 틀림) | 계약(두 Store) |
| reset | 위 뒤 reset batch | 커서가 batch의 것으로 바뀐다 | 계약 |
| 동시 수집 | 같은 transcript를 두 프로세스가 동시에 `sessions ingest` | 메시지가 한 번씩만 있다. 모든 테이블 건수는 한 번 넣은 것과 같다 | CLI |
| setup 업그레이드 | `<home>/brain.db`가 v5이고 세션·메시지·도구 메모가 있음 | `setup run --yes` exit 0, 스키마 6, 건수·본문 그대로, `messages`에 `seq` 칸 없음 | CLI |

</intent-contract>

## Code Map

- `packages/sqlite/migrations/0001_initial.sql` -- 읽기 전용. 볼 곳:
  - `messages` 107-121, `log_entries` 147-171, `chunks` 216-225.
  - `messages_immutable_delete` 346-350.
  - `chunks_fts`와 trigger 384-404.
- `packages/sqlite/migrations/0004_capture_columns.sql:79-94` -- 지금의 `messages_immutable_update`. 칸 목록·메시지 원문. 읽기 전용.
- `packages/sqlite/migrations/0005_identity_and_records.sql` -- 머리 주석·stash/drop/create/copy 문체의 본보기(1-150).
- `packages/sqlite/migrations/0002_files_and_work.sql:189-191` -- `message_attachments.message_id → messages`. 지연 FK가 필요한 이유다.
  - 0002·0004·0005의 trigger 본문이 `messages`의 `seq`를 이름으로 쓰지 않는지 grep으로 확인한다. 쓰면 0006에서 그 trigger를 다시 만든다.
- `packages/sqlite/src/migrate.ts` -- `SQLITE_SCHEMA_VERSION = 6`. 파일 목록은 폴더에서 읽으므로 새 파일만 둔다(0005 때와 같은지 확인).
- `packages/sqlite/src/sessions.ts` -- 고칠 곳:
  - `MessageRow.seq`(52), 머리 주석(105-117).
  - `ingest`의 `max(seq)`·`nextSeq`(232-262): 삽입은 `on conflict (session_id, harness_message_id) do nothing` 그대로 둔다.
  - `readSession`의 두 `order by`(361-378).
  - `cursorMayMove`(475-513): `occurred_at`을 읽어 비교한다. 텍스트 정규형이라 문자열 비교로 된다.
  - `toMessage`(589).
- `packages/core/src/domain/{message,chunk,log-entry,ingest-batch}.ts` -- 칸과 주석. `ingest-batch.ts`의 6-9·35·107행 주석은 "parser 순서 = 파일 순서, 저장 순서는 시각"으로 고친다.
- `packages/core/src/ports/store.ts:162,243` -- "`seq` order"를 시각 순서로 고친다.
- `packages/core/src/ports/parser.ts:44`, `testing/fakes/parser.ts:19`, `testing/contracts/parser.ts:54,84`, `packages/claude-code/src/parser.ts:120` -- 주석만 고친다. parser는 번호도 시각 정렬도 하지 않는다는 뜻으로.
- `packages/core/src/testing/fakes/store.ts` -- 고칠 곳:
  - 머리 주석(101-104).
  - `ingest`의 번호 붙이기(281-298)와 `sort`(334): `occurredAt` 기준 안정 정렬로 바꾼다.
  - `readSession`의 도구 메모 정렬(376-383).
  - `nextCursor`(670-694).
- `packages/core/src/testing/contracts/session-store.ts` -- 고칠 사례:
  - 35행 설명.
  - 308 사례: `seq` 비교 대신 id·본문 비교.
  - 379 사례: 제목을 "in conversation order"로 바꾸고 번호 단정을 뺀다.
  - 435 사례: 번호 단정을 뺀다.
  - 477 사례: msg-1이 맨 앞에 읽힘.
  - 새 사례 "늦게 온 중간 메시지"와 "겹친 수집, 삽입 순서 ≠ 시각 순서"를 둔다.
  - 픽스처 msg-1~4의 시각은 03:04:05, 03:04:07, 03:05:01, 03:05:20(`testing/fakes/parser.ts:197-231`)이다. `sampleIngestBatch({only, idStart})`(`testing/fixtures.ts:293`)를 쓴다.
- `packages/core/test/contracts.test.ts` -- 451-482의 "takes the seq of the batch" 변이 사례를 바꾼다. 새 변이 둘이 각각 계약에 잡히는지 본다.
  - 삽입 순서로 읽는 store.
  - 커서를 삽입 순서로 비교하는 store.
  - 786행 주석도 고친다.
- `packages/core/test/sessions-ingest.test.ts:179-193,508-532` -- 번호 단정을 시각 순서 단정으로 바꾼다.
- `packages/sqlite/test/session-store.test.ts` -- 고칠 곳:
  - 100-109·141의 `seq` 질의를 `occurred_at` 순서로 바꾼다.
  - 417-455 "raises on a seq collision" 사례는 지킬 규칙이 없어졌으므로 지운다.
  - 444·530의 원시 insert에서 `seq`를 뺀다.
  - 25행 주석을 고친다.
- `packages/sqlite/test/{schema,schema-files}.test.ts` -- 최신 스키마에 넣는 행 예시를 고친다.
  - `messages`에서 `seq`를, `log_entries`에서 두 칸을 뺀다.
  - `chunks`는 `from_at`·`to_at`(정규형 시각)으로 바꾼다.
  - 키 사례 `(session_id, seq)`는 지우고, 조각 키 사례는 새 칸으로 바꾼다.
  - 버전 고정 6. `schema.test.ts:918`의 `seq: 1.5` STRICT 사례는 다른 정수 칸으로 옮기거나 지운다.
- `packages/sqlite/test/{schema-0004,schema-0005}.test.ts` -- 옛 버전 DB에 넣는 `seq`는 그대로 둔다. 최신(6)으로 올린 뒤 넣는 행만 고친다. 버전 고정 값만 맞춘다.
- 새 `packages/sqlite/test/schema-0006.test.ts` -- `schema-0005.test.ts`의 `scratch`·`open`·`insert`·`versionFourPath`(87-140) 방식으로 `versionFivePath`를 만든다. 매트릭스의 스키마 행을 맡는다.
- `apps/cli/test/sessions-ingest.test.ts` -- 고칠 곳:
  - `storedMessages`(254-283)를 `order by occurred_at`으로 바꾸고 `seq`를 뺀다.
  - 526 사례를 "제자리에 읽힌다"로 바꾼다.
  - 791 사례: 옛 버전이 저장한 세션에 더해진 보고가 시각 자리에 읽히는지 단정한다.
  - 489·522·556·620·692-698·757-770·831의 `seq` 단정을 시각 순서·본문 단정으로 바꾼다.
- `apps/cli/test/output-codecs.test.ts:167` -- `order by occurred_at`.
- `apps/cli/test/setup.test.ts:755-892` -- `versionFourHome` 본보기로 v5 home을 만들고, 업그레이드 사례를 하나 더한다.
- 버전 고정을 맞출 곳: `grep -rn "schema_version\|SQLITE_SCHEMA_VERSION\|toBe(5)"`(story 18 목록 참고).
  - `packages/sqlite/test/{schema,schema-0004,schema-0005,schema-files,users}.test.ts`
  - `apps/cli/test/install-flow.test.ts`
  - `packages/core/test/brain-drain.test.ts`
  - `tooling/bootstrap/test/bootstrap.test.ts`
- `tooling/dev/tracer-session.sh:80-83` -- 질의와 기대 문장을 `occurred_at` 순서로 바꾼다.
- `README.md:298-301` -- 순서 문단을 시각 순서로 바꾼다. `schema_version` 예시(5)가 있으면 6으로 바꾼다.
- `_bmad-output/personal-brain/deferred-work.md:74` -- Postgres 뒤처짐 항목에 0006(`messages.seq`·`log_entries` 두 칸·`chunks` 범위)을 더한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/sqlite/migrations/0006_drop_message_seq.sql`, `packages/sqlite/src/migrate.ts` -- Always의 재생성·drop column·trigger·인덱스, 버전 6 -- 스키마에서 번호를 없앤다.
- [x] `packages/core/src/domain/*`, `packages/core/src/ports/{store,parser}.ts`, `packages/claude-code/src/parser.ts` -- 타입 칸과 주석 -- 도메인에서 번호를 없앤다.
- [x] `packages/sqlite/src/sessions.ts`, `packages/core/src/testing/fakes/store.ts` -- 번호 붙이기 제거, 시각 정렬, 시각 커서 비교 -- 두 Store를 같은 규칙으로 맞춘다.
- [x] `packages/core/src/testing/contracts/session-store.ts`, `packages/core/test/contracts.test.ts` -- 매트릭스의 계약 행과 변이 사례 -- 두 Store에 같은 단정을 건다.
- [x] `packages/sqlite/test/schema-0006.test.ts` -- 매트릭스의 스키마 행(5→6, 재실행, 불변, 키, 조각).
- [x] `apps/cli/test/{setup,sessions-ingest,output-codecs}.test.ts` -- setup 업그레이드, 동시 수집, 제자리 읽기.
- [x] Code Map의 나머지 테스트 -- `seq` 질의를 걷어 내고 버전 고정 값을 맞춘다. 남은 단정의 뜻은 바꾸지 않는다.
- [x] `README.md`, `tooling/dev/tracer-session.sh`, `_bmad-output/personal-brain/deferred-work.md` -- 문서.

**Acceptance Criteria:**
- Given 세션·메시지·도구 메모가 있는 v5 DB가 든 임시 home. When `brain setup run --yes`를 실행하면, then exit 0이다. `brain doctor run`의 `schema-version`은 `6`이고, 메시지·도구 메모 건수와 본문이 그대로이며, `messages`에 `seq` 칸이 없다.
- Given `sessionStoreContract()`. When 가짜 store와 SQLite store로 돌리면, then 두 쪽 모두 모든 사례가 통과한다. 변이 store 둘(삽입 순서 읽기·삽입 순서 커서)은 각각 실패한다.
- Given 옛 parser 버전이 저장한 세션에 대화 중간 시각의 보고가 나중 수집으로 더해짐. When `readSession`으로 읽으면, then 그 보고는 앞뒤 메시지의 시각 사이에 놓인다.
- Given 저장소 전체. When `git grep -nE "\bseq\b|seqFrom|seqTo|seq_from|seq_to|anchor_?[sS]eq|joined_?[uU]pto_?[sS]eq"`를 `_bmad-output`·`_bmad`·`.agents`를 빼고 돌리면, then 남는 것은 0001·0004 SQLite 마이그레이션, Postgres 0001과 그 테스트, 옛 버전 DB를 만드는 테스트, 그리고 지운 것을 설명하는 0006 주석뿐이다.
- Given `pnpm test`. When 실행하면, then build·typecheck·vitest가 모두 통과한다(출력 언어 검사 포함). `apps/cli/dist/build.json`의 `schema_version`은 6이다.

## Implementation Notes

**마이그레이션 안의 순서.** 파일은 `chunks` → `log_entries` → `messages` 순서다. 조각의 `from_at`·`to_at`은 `messages.seq`를 join해서 얻으므로, 그 칸이 아직 있는 동안 옮겨야 한다. 머리 주석에 이유를 적었다.

**조각 옮기기는 `left join`에 `min`·`max`다.** inner join이면 메시지 없는 `seq`를 가리키는 행이 말없이 사라진다. left join이면 null이 `not null`에 걸려 0006 전체가 거부된다 — Design Notes의 뜻 그대로다. 그리고 두 시각을 `seq_from`·`seq_to` 순서대로 넣으면 안 된다(리뷰 지적): 번호와 시각은 어긋날 수 있으므로 낮은 `seq`가 더 늦은 순간일 수 있고, 그러면 `chunks_range_check`가 잘못된 것 없는 행 때문에 업그레이드를 거부한다. `from_at`은 `min(...)`, `to_at`은 `max(...)`다. SQLite의 스칼라 `min`·`max`는 인자 하나가 null이면 null이므로 거부 규칙은 그대로 산다. schema-0006에 번호가 거꾸로인 v5 조각 한 행을 더해 두었다.

**FTS trigger는 복사 뒤에 만든다.** `chunks_fts_ai`가 먼저 있으면 옮겨 넣는 행이 색인에 두 번 들어간다. `drop table`은 delete trigger를 부르지 않으므로 색인은 옛 `search_rowid`를 그대로 들고 있고, 그 번호를 보존해 옮기면 색인이 맞는 행을 계속 가리킨다. schema-0006 테스트가 업그레이드 전후로 같은 검색을 한다.

**`is_subagent_report`는 `default 0`을 남겼다.** 재생성에는 default가 필요 없지만, 이 칸 없이 `messages`에 손으로 넣는 테스트가 여럿이다. 0004의 근거("보지 않은 메시지는 보고가 아니다")도 그대로다.

**STRICT 사례를 옮겼다.** `schema.test.ts`의 `seq: 1.5`는 정수 칸이 `is_subagent_report`뿐이라 거기로 옮겼다(`schema.test.ts:918` → `is_subagent_report: 1.5`).

**`(session_id, seq)` 키 사례는 대체물이 있다.** `schema.test.ts`의 중복 키 사례에서 그 줄을 지우고, 대신 `schema-0006.test.ts`가 "같은 세션·같은 시각·다른 harness id 둘은 들어간다"를 단정한다. SQLite 쪽 `session-store.test.ts`의 "raises on a seq collision" 사례도 같은 뜻의 사례로 바꿨다.

**옛 테스트 픽스처 둘을 손봤다(계획에 없던 것).**
- `schema-files.test.ts`의 v1 업그레이드 사례는 메시지 없이 `seq_from 0` 조각을 넣었다. 0006의 join이 거부하므로 그 조각이 가리키는 메시지 한 행을 v1 시드에 더했다(사례의 뜻 — 0002의 `index_configs` 재생성 — 은 그대로다).
- `apps/cli/test/sessions-ingest.test.ts`의 CURSOR_RESET 사례는 `whole[0]`이 첫 질문이라고 단정했다. `full-session.jsonl`은 한 답변의 둘째 줄에 질문보다 1분 이른 시각을 일부러 넣어 두었으므로(09:59:00 vs 10:00:03), 시각 순서로 읽으면 그 줄이 맨 앞이다. 단정을 그 사실대로 바꾸고 주석에 적었다. 실제 transcript에서는 역전이 0이지만(아래 측정), 손으로 만든 픽스처는 그렇지 않다.

**변이 store 둘.** `contracts.test.ts`의 "takes the seq of the batch" 사례를 지우고 둘로 바꿨다. 하나는 삽입 순서로 읽고(새 사례 "a message uttered in the middle…"에서 걸린다), 하나는 커서를 삽입 순서로 비교한다(새 사례 "the cursor is compared by when the messages were uttered…"에서 걸린다). 둘 다 계약에 잡히는 것을 테스트가 확인한다.

**계약 픽스처에 도구 메모 하나를 더했다.** 샘플 transcript는 msg-2에만 도구 호출이 있어서 "메모가 시각 자리에 있다"를 틀릴 수 있는 사례가 만들어지지 않는다. msg-3에 붙는 메모(`middleToolNote`)를 계약 안에 두고, 먼저 msg-1·3·4 + 그 메모를 저장한 뒤 msg-2(와 그 메모 둘)가 나중에 들어오게 했다. 삽입 순서로 정렬하면 msg-3의 메모가 앞에 오므로 사례가 갈린다.

**(메인 세션, 검증 중) 동시 수집 사례를 넓혔다.** 매트릭스의 '모든 테이블 건수는 한 번 넣은 것과 같다'를 보려고, `apps/cli/test/sessions-ingest.test.ts`의 "two processes" 사례가 한 번만 넣은 home과 `rowCounts` 전체를 비교한다. 계약 파일의 빈 줄 둘을 지웠다.

## Plan Change Log

## Review Triage Log

### 2026-10-20 — Review pass
- verdicts: 6 findings — high 0, medium 0, low 6, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` 0006의 `chunks` 복사가 `seq` 순서와 시각 순서가 엇갈린 조각에서 `from_at > to_at`을 만들어 `chunks_range_check`로 업그레이드 전체를 거부함 — 재현 확인(리뷰어). `chunks`를 쓰는 코드가 아직 없어 실제로 만나기 어렵지만 고침이 직접 수정이다. 복사를 `min`/`max(first, last)`로 바꾸고(메시지 없는 `seq`는 여전히 null로 거부), 엇갈린 조각을 넣은 schema-0006 사례를 더했다.
  - `[low]` `[patch]` 같은 시각의 두 메시지의 도구 메모가 섞여 읽힘(A0 B0 A1 B1) — v6 DB에서 재현 확인(리뷰어). 실측상 같은 밀리초 쌍은 0이다. SQLite·가짜·CLI 테스트 helper의 정렬에 메시지 시각과 `ordinal` 사이 `harness_message_id`를 넣었다. 메모를 메시지별로 묶을 뿐 메시지 순서는 정하지 않는다(Never의 tie-break 금지는 메시지 순서에 대한 것). 주석 셋을 맞추고 SQLite store 사례를 더했다.
  - `[low]` `[reject]` 파일 안에서 시각이 거꾸로 가는 transcript에서는 시각 커서 비교가 겹친 수집의 커서를 뒤로 보낼 수 있음 — 맞는 말이지만, 티켓이 "커서의 전진 비교는 커서 메시지의 `occurred_at`으로 한다"고 정했고 change 제안서가 이 위험을 받아들였다. 실측(parser가 남기는 메시지 7,049쌍)에서 역전은 0이다. 일어나도 결과는 같은 구간을 다시 읽는 것뿐이다(멱등). 거꾸로 가는 예는 손으로 만든 픽스처뿐이다.
  - `[low]` `[patch]` 0006 인덱스 주석이 커서 검사도 그 인덱스를 쓴다고 함 — `cursorMayMove`는 `harness_message_id`로 찾으므로 unique 인덱스를 쓴다(리뷰어 `explain query plan`). 주석을 읽기 정렬만 말하도록 고쳤다.
  - `[low]` `[patch]` `packages/claude-code/src/parser.ts:123`에 119자짜리, 옛 문장과 이어 붙은 주석 줄이 있고, `apps/cli/test/setup.test.ts`에 빈 줄이 두 줄 연속됨 — 확인했다. 주석을 다시 감싸고 빈 줄을 하나로 줄였다.
  - `[low]` `[reject]` 매트릭스 '메시지 불변'의 허용 경로(가리기 표시 아래 body update)를 schema-0006이 직접 보지 않음 — 같은 경로를 `schema-0004.test.ts:656-682`가 v6로 올린 DB에서 보고 있고, 그 테스트는 이번 실행에서 돌아 통과했다. 사례를 더하는 것은 직접 수정보다 큰 일이고 빠진 범위도 없다.

## Design Notes

**측정(티켓 verify, 2026-10-20, 플래닝 중).** 이 Mac의 메인 transcript를 현재 parser(`CLAUDE_CODE_PARSER_VERSION` 3, `packages/claude-code/dist`)로 읽었다. 남는 메시지만 셌다.

| 항목 | 값 |
|---|---|
| 파일 | 236 (parse 실패 0) |
| 메시지 | 7,159 |
| 메시지가 둘 이상인 세션 | 228 |
| 붙어 있는 쌍 | 6,927 |
| 뒤 메시지의 시각이 더 이른 쌍 | **0** |
| 같은 밀리초인 쌍 | **0** |

change 제안서의 수(221·6,818)보다 많은 것은 그 뒤에 쌓인 세션 때문이다. 결론은 같다.

**다시 잼(구현 뒤, 2026-10-20).** 이번에는 `~/.claude/projects/` 아래 모든 `.jsonl`을 셌다(메인 폴더만이 아니다). parser는 같은 v3, 빈 파일은 건너뛰었다.

| 항목 | 값 |
|---|---|
| 파일 | 815 (parse 실패 0) |
| 메시지 | 7,288 |
| 메시지가 둘 이상인 세션 | 236 |
| 붙어 있는 쌍 | 7,049 |
| 뒤 메시지의 시각이 더 이른 쌍 | **0** |
| 같은 밀리초인 쌍 | **0** |

parser를 바꾸지 않았으므로 결론도 그대로다. 손으로 만든 픽스처 `full-session.jsonl`에는 역전이 하나 있지만(Implementation Notes), 실제 transcript에는 없다.

**조각 행 옮기기.** 행은 없을 것으로 본다. 그래도 join으로 옮긴다. 개발 DB에 손으로 넣은 행이 있어도 잃지 않고, `search_rowid`를 지키면 `chunks_fts`가 그대로 맞는다. 메시지가 없는 `seq`를 가리키는 조각은 `not null`로 0006 전체가 거부된다. 쓰는 코드가 없으므로 그런 행은 버그다.

**커서 비교 예.** 삽입 순서와 시각 순서가 갈리는 경우다. 비교는 `>=`이므로 같은 시각이면 커서가 움직인다.

```text
저장: msg-1(03:04:05) msg-2(03:04:07) msg-4(03:05:20)  커서=msg-4
batch: msg-1 msg-2 msg-3(03:05:01)                       커서=msg-3
→ msg-3 삽입, 03:05:01 < 03:05:20 이므로 커서는 msg-4 그대로
```

## Verification

**Commands:**
- `pnpm test` -- expected: build·typecheck·모든 vitest 통과
- `pnpm build && pnpm exec vitest run packages/sqlite/test/schema-0006.test.ts` -- expected: 매트릭스 스키마 행 통과
- 위 AC의 `git grep` -- expected: 허용 목록 밖에서 남은 곳 없음


## Auto Run Result

**바뀐 것.** 메시지 번호 `seq`를 없앴다. SQLite 마이그레이션 0006(`SQLITE_SCHEMA_VERSION` 6)이 하는 일:
- `messages`를 `seq`와 `(session_id, seq)` 키 없이 재생성한다. 불변 trigger를 다시 만들고 `(session_id, occurred_at)` 인덱스를 둔다.
- `log_entries`에서 `anchor_seq`·`joined_upto_seq`를 지운다.
- `chunks`의 범위를 `from_at`·`to_at`으로 바꾼다. 행과 `search_rowid`를 보존하고 FTS trigger를 다시 만든다.

SQLite store와 Core 가짜 store가 하는 일:
- 번호를 붙이지 않는다.
- 메시지는 `occurred_at` 순서로 읽는다.
- 도구 메모는 메시지 시각, 메시지, `ordinal` 순서로 읽는다.
- 커서 전진은 `occurred_at`으로 비교한다.

Core 도메인 타입에서 `seq`·`seqFrom/seqTo`·`anchorSeq/joinedUptoSeq`를 지웠다(`Chunk`는 `fromAt`·`toAt`).

**파일.**
- `packages/sqlite/migrations/0006_drop_message_seq.sql`(새 파일), `packages/sqlite/src/{migrate,sessions}.ts` — 스키마와 SQLite store.
- `packages/core/src/domain/{message,chunk,log-entry,ingest-batch}.ts`, `packages/core/src/ports/{store,parser}.ts` — 타입과 규칙 주석.
- `packages/core/src/testing/{fakes/store,fakes/parser,contracts/session-store,contracts/parser}.ts` — 가짜 store, 새 계약 사례 둘(늦게 온 중간 메시지, 시각 커서).
- `packages/core/test/{contracts,sessions-ingest,brain-drain}.test.ts` — 변이 store 둘, 시각 순서 단정.
- `packages/sqlite/test/schema-0006.test.ts`(새 파일), `packages/sqlite/test/{schema,schema-0004,schema-0005,schema-files,session-store,users}.test.ts` — 0006 사례, `seq` 제거, 버전 6.
- `apps/cli/test/{setup,sessions-ingest,output-codecs,install-flow}.test.ts`, `tooling/bootstrap/test/bootstrap.test.ts` — v5→v6 setup 사례, 제자리 읽기, 동시 수집 전체 건수, 버전 6.
- `packages/claude-code/src/parser.ts`, `packages/claude-code/test/parser.test.ts` — 주석, "번호를 붙이지 않는다" 사례.
- `README.md`, `tooling/dev/tracer-session.sh`, `_bmad-output/personal-brain/deferred-work.md` — 시각 순서 문단, Postgres 뒤처짐에 0006을 더함.

**리뷰.**
- quick 렌즈 1회, 지적 6건(모두 low).
- patch 4건: 조각 복사 min/max, 같은 시각 메모 묶기, 인덱스 주석, 주석·빈 줄.
- defer 0건.
- reject 2건:
  - 시각 커서와 파일 안 시각 역전: 티켓이 정한 규칙이고 실측 역전은 0이며, 일어나도 다시 읽을 뿐이다.
  - 불변 허용 경로: `schema-0004` 테스트가 v6에서 보고 있다.
- 메인 세션이 리뷰 전에 동시 수집 사례를 전체 테이블 건수 비교로 넓혔다.

**후속 리뷰 권고:** `false`. patch 4건이 모두 low이고 high·medium patch가 없다.

**검증.**
- `pnpm test`: build, typecheck, vitest 64개 파일 2,049개 테스트가 모두 통과했다. 리뷰 패치 뒤 메인 세션에서 다시 돌린 결과다.
- `apps/cli/dist/build.json`의 `schema_version`은 6이다.
- AC의 `git grep`: 남은 곳은 허용 목록뿐이다(리뷰어 확인).
- 측정은 Design Notes에 있다. 역전 0, 같은 밀리초 0.

**남은 위험.**
- 시각 순서의 전제는 이 Mac과 parser v3 실측에 기댄다. 22·23이 parser가 남기는 줄을 바꾸면 다시 잰다.
- 손으로 만든 픽스처 `full-session.jsonl`에는 시각 역전이 하나 있다. 그 픽스처를 쓰는 CURSOR_RESET 사례의 단정은 시각 순서대로 바꿨다.
- Postgres 0001에는 아직 `seq` 칸이 있다(epic 7, deferred-work).
