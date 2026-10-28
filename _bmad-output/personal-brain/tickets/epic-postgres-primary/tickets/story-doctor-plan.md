---
title: '저장본 가리기와 정리: 가린 문자열이 어디에도 없고 정리가 끝날 때까지 doctor가 경고한다'
type: 'feature'
ticket: '5'
created: '2026-10-28'
status: done
baseline_revision: '08cff3e09e8f3b83a22ce51cb29cbd52c6a7cafd'
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
      10분보다 오래 걸리는 정리는 공통 청구 만료 때문에 다른 drain이 재청구하여 잠금 대기와 시도를 누적할 수 있다.
    evidence: |-
      기존 DEFAULT_WORK_POLICY.claimForMs는 600000이고 정리 adapter는 statement_timeout이 없다. 청구 갱신은 에픽 Boundaries가 epic-jobs-and-scheduler로 정한 기존 공통 큐 과제다. 이번 변경에서는 만료한 작업의 실패 해소를 CAS 완료로 옮겨 안전성을 보강하며, 장시간 청구 갱신 자체는 추가하지 않는다.
    location: >-
      packages/core/src/domain/work-item.ts; packages/postgres/src/maintenance.ts
    severity: medium
  - summary: >-
      brain_app의 기존 공통 큐 DML 권한으로 정리 일감을 직접 삭제·완료하면 doctor 추적을 무력화할 수 있다.
    evidence: |-
      공통 큐는 기존부터 brain_app에 직접 쓰기를 허용하고 completeWork도 호출자에게 열려 있다. 정리 함수는 정상 가리기의 열린 일감과 청구 무효화를 보장하지만 큐 자격 증명을 가진 임의 SQL 사용자를 별도 적대 주체로 격리하지 않는다. 이를 막으려면 공통 큐 권한과 완료 경계를 함께 재설계해야 한다. 이번 실행은 기존 ledger 항목을 변경하지 않는다.
    location: >-
      packages/postgres/src/setup.ts; packages/postgres/src/work.ts; packages/postgres/migrations/0001_initial.sql
    severity: medium
  - summary: >-
      지원 환경과 다른 lc_messages에서 VACUUM VERBOSE 완료 detail의 숫자 형식이 달라지면 정리를 완료하지 못할 가능성이 있다.
    evidence: |-
      maintenance.ts는 copy_table_data routine과 detail 첫 숫자를 읽고, 해석 불가 시 TABLE_CLEANUP_FAILED로 닫지 않는다. 공식 PG18 시험 환경의 전체 검증은 통과했다. 다른 로캘에서 숫자의 위치가 실제 바뀌는지와 정리 role이 사용할 수 있는 메시지 환경 고정 방법을 확인해야 한다. 잘못된 성공 판정은 하지 않는다.
    location: >-
      packages/postgres/src/maintenance.ts:17
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** PG Store에는 `redactMessage`·`redactFile`이 없다(`store.ts`가 `Omit`으로 뺀다). 그래서 session-store의 가리기 case와 file-redaction 계약이 PG에서 돌지 않고, 가린 뒤 표에 남는 옛 행 바이트를 지우는 정리(SQLite의 `wal_checkpoint` 자리)도, 정리가 끝났는지 알리는 doctor 항목도 없다. 또 `brain.redacting`은 아무 연결이나 세울 수 있는 GUC라 `brain_app`이 그것만 세우고 `document_chunks_delete_rule`을 우회할 수 있다.

**Approach:** 가리기 쓰기는 `brain_owner` 소유의 SECURITY DEFINER SQL 함수 두 개가 하고, 그 함수 한 곳이 트랜잭션 로컬 표시를 세우고 지운다. trigger의 가리기 예외는 표시와 함께 실행 role이 그 표 소유자일 때만 열린다. 같은 트랜잭션에 표별 정리 일감(`table_cleanup`)을 넣고, drain handler가 트랜잭션 밖에서 정리 전용 role로 `VACUUM FULL` 뒤 `CHECKPOINT`를 한다. PG `checkHealth`의 probe가 정리가 남아 있는 동안 `warn`을 낸다.

## Boundaries & Constraints

**Always:**
- 의미의 기준은 SQLite 구현(`packages/sqlite/src/sessions.ts:141` `redactMessage`, `packages/sqlite/src/attachments.ts:218` `redactFile`)과 Core port 주석(`packages/core/src/ports/store.ts:229-255`, `:921-1015`)이다. 결과 값·문 순서(포인터 null → 조각 → 닫힌 세대 → 이름 → 메타데이터 → `redactions` → 실패 해소, 열린 세대는 행 유지)·오류 코드가 같다. plan 콜백은 쓰기 트랜잭션 안에서 현재 값으로 부른다.
- 가리기는 한 트랜잭션이다. 하나라도 실패하면 전부 롤백하고 실패 값(`DB_UNAVAILABLE`/`DB_LOCKED`)으로 답한다. Store는 spool하지 않는다. 연결 실패·`brain` schema 없음은 throw 없이 값이다.
- 표시: `brain.redacting`은 가리기 SQL 함수 안에서만 `on`이고 함수가 끝나면(정상·예외 모두) 함수 진입 전 값으로 돌아간다. 이 표시를 읽는 모든 trigger(`messages`·`tool_notes`·`files` update, `document_chunks_delete_rule`)는 표시와 함께 `current_user`가 그 표 소유자 role의 구성원일 때만 예외를 연다(superuser는 구성원이므로 기존 schema 시험의 소유자 연결 경로는 그대로 통과).
- 가리기 SQL 함수는 넘겨받은 새 본문·도구 메모 대상이 저장된 값(`text` 칸)에 같은 호출의 `redactions` 구간 `[start,end)`(코드 포인트)를 뒤에서부터 `[REDACTED:<kind>]`로 바꾼 결과와 같을 때만 쓰고, 아니면 예외로 거부한다. `*_raw`는 null이거나, 옛 raw가 있었고 U+0000을 U+FFFD로 바꾸면 새 `text`와 같아야 한다. 파일 함수는 `redacted_at`을 null에서 한 번만 세우고 그 파일의 파생물만 지운다. `search_path`를 고정하고, `execute`는 `public`에서 거두고 `brain_app`에만 준다.
- U+0000 규칙(에픽 Decision): 새 본문·대상은 `pgText`로 `text`·`*_raw`에 나눠 쓰고, 가린 문자열은 `*_raw` 바이트에도 남지 않는다. 읽기는 기존 `originalText` 경로 그대로다.
- 동시성: `redactMessage`는 메시지의 세션을 먼저 읽고, 수집과 같은 세션 advisory key(`withWrite`의 `key`, `${harness}:${harnessSessionId}`) 아래에서 본문을 다시 읽고 쓴다. `redactFile`은 추출과 같은 잠금 순서로 파일 행을 먼저 `for no key update`로 잡는다.
- 정리 일감: Core가 id를 만든다(AD-8, adapter는 id를 만들지 않는다). `RedactionPlan`·`RedactFilePlan`에 필수 필드 `cleanup: AddWorkInput[]`(kind `table_cleanup`, targetKind `table`, targetId는 논리 표 이름)을 더한다. 메시지 가리기는 `bodySpans>0`이면 `messages`, 바뀐 도구 메모가 있으면 `tool_notes`, 구간이 하나라도 있으면 `chunks`. 파일 가리기는 기록을 쓸 때(`redaction !== null`) `document_chunks`·`document_extractions`·`file_names`·`file_metadata`. 구간이 없거나 이미 가린 파일이면 빈 목록. PG만 이것을 `ensureWork`(열린 행 키로 find-or-create)로 넣고, SQLite·memory는 무시한다.
- 정리 handler(Core)는 port `TableMaintenance`를 부른다. PG 구현은 정리 전용 role `brain_maintenance`로 연결해 allowlist에 있는 표만 `vacuum (full) brain.<table>` 뒤 `checkpoint`를 한다(표 이름은 문자열 보간 전에 allowlist로 확인). 트랜잭션 밖이고, `lock_timeout`이 있어 잠금 대기는 `DB_LOCKED`(다시 시도)로 끝나며 `statement_timeout`은 두지 않는다. 권한이 없으면 PG는 VACUUM을 경고만 내고 건너뛰므로, 표의 `relfilenode`가 바뀌지 않았으면 성공으로 치지 않는다.
- 권한: `prepareDatabase`가 `brain_maintenance` role을 만들고(비밀번호가 주어지면 login), `pg_checkpoint` 구성원과 `brain` schema `usage`를 준다. baseline이 cleanup allowlist 표에만 `grant maintain … to brain_maintenance`를 한다. `brain_app`·`public`·default privileges에는 `maintain`을 주지 않는다.
- doctor: PG `checkHealth`의 probe `redaction_cleanup`은 열린 `table_cleanup` 일감이나, 그 일감 종류에서 나온 해결되지 않은 `failures` 행이 있으면 `warn: true`와 남은 표 이름(한국어 detail), 없으면 `ok`다. 정리 중에 같은 표에 새 가리기가 커밋되면 그 정리는 완료로 닫히지 않는다(예: 가리기가 청구된 열린 일감의 청구를 지워 실행 중인 일꾼의 `completeWork`가 `CLAIM_LOST`가 되게 한다).
- 시험 DB는 `test/fixture.ts`의 `database()`/`subject()`. 정리 role URL은 `@second-brain/test-db`의 `TestDatabase`에 `maintenanceUrl`로 더한다.

**Never:**
- CLI 조립·데몬·설치(`apps/cli/src/**`)에 정리 handler·`brain_maintenance` 비밀번호·URL을 연결하지 않는다(티켓 7·8). `packages/sqlite/src/**`의 동작을 바꾸지 않는다. 시험 파일의 plan 리터럴에 `cleanup: []`을 더하는 것만 허용한다. `plugin/app-ref`·plugin version을 바꾸지 않는다.
- `brain_app`에 `messages`·`tool_notes` UPDATE, `files.redacted_at` UPDATE, `maintain`, `pg_checkpoint`를 주는 구현, 정리를 쓰기 트랜잭션 안이나 SQL 함수 안에서 하는 구현, 가리기 실패를 spool로 보내는 구현을 하지 않는다.
- 공유 계약의 단언을 바꾸지 않는다. 문서·커밋·시험 출력 인용에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 메시지 가리기 | 본문·도구 메모에 비밀 `hunter2-x`, 그 메시지 시각을 덮는 `chunks` 행 2개 | `ok`, 구간 수·`chunksRemoved: 2`. 소유자 SQL로 `messages.body`·`body_raw`·`tool_notes.target`·`target_raw`·`chunks.body` 어디에도 비밀 없음. `table_cleanup` 열린 일감 `messages`·`tool_notes`·`chunks` | 없음 |
| NUL 본문 | 본문 `a\u0000 hunter2-x b`를 가림 | 읽은 본문 = `a\u0000 [REDACTED:manual] b`(바이트 단위), `body_raw`에 비밀 바이트 없음 | 없음 |
| 파일 가리기 | 이름 `secret-name.pdf`, 메타데이터, 닫힌·열린 세대와 조각이 있는 파일 | 계약 결과와 같음. `file_names`·`document_chunks`에 비밀 이름·조각 글자 없음, 열린 세대 행은 남음. 정리 일감 네 표 | 없음 |
| 표시 범위 | 소유자(superuser) 연결에서 가리기 함수 호출 뒤 같은 연결·같은 트랜잭션에서 일반 `update brain.messages` | 거부(`invariant refused`), `current_setting('brain.redacting', true)`는 `on`이 아님 | 예외 |
| 롤백 | 가리기 함수가 중간에 실패(구간과 맞지 않는 본문)한 뒤 롤백 | 본문·`redactions`·`chunks`·일감 불변, 같은 연결의 표시는 `on`이 아님. adapter 경로라면 `DB_UNAVAILABLE` 값 | 값으로 반환 |
| brain_app 우회 | `brain_app`이 `set brain.redacting='on'` 뒤 messages UPDATE, files.redacted_at UPDATE, 현재 세대 `document_chunks` DELETE, 구간과 다른 본문으로 가리기 함수 호출, `vacuum full brain.messages`, `cluster`, `reindex table`, `checkpoint`, `set session_replication_role = replica` | 모두 거부되거나 효과 없음: 행 불변, `pg_class.relfilenode` 불변. `has_table_privilege('brain_app'·'public', …, 'MAINTAIN')` false | 예외 또는 경고 |
| 정리 전후 doctor | 가리기 직후 `runDoctor`, 그 뒤 `drainQueue`(handler `table_cleanup`) 후 `runDoctor` | 앞은 `redaction_cleanup` `warn`, 뒤는 `ok`이고 각 표의 `relfilenode`가 바뀜. superuser가 `pg_relation_filepath`로 읽은 heap·TOAST 파일에 비밀 바이트 없음, 가리지 않은 대조 문자열은 있음 | 없음 |
| 잠금 대기 | 다른 연결이 `brain.messages`를 잡은 채 drain | handler `DB_LOCKED`, 일감 열린 채 다시 시도, doctor `warn`. 풀린 뒤 drain → `ok` | 값으로 반환 |
| 권한 부족 | `brain_maintenance`에서 한 표의 `maintain`을 거둔 뒤, 시도 한도까지 drain | 성공으로 닫히지 않음. 실패가 기록되어 닫힌 뒤에도 doctor `warn` | 값으로 반환 |
| 정리 중 새 가리기 | `table_cleanup`(`messages`)을 청구한 뒤 다른 메시지를 가리고, 그 청구로 `completeWork` | 완료되지 않음(`CLAIM_LOST` 또는 일감 열림), doctor `warn` | 값으로 반환 |
| 같은 메시지 동시 가리기 | 두 pool이 같은 메시지의 다른 글자를 동시에 가림 | 둘 다 `ok`, 최종 본문에 두 표시가 모두 있고 `redactions` 위치가 각 호출 직전 본문 기준 | 없음 |
| 잠금 초과·schema 없음 | 세션 advisory key·파일 행을 잡은 채 `lockTimeoutMs: 40`, 또는 `drop schema brain cascade` | `DB_LOCKED` / `DB_UNAVAILABLE` 값, 아무것도 바뀌지 않음 | throw 없음 |

</intent-contract>

## Code Map

- `packages/postgres/migrations/0001_initial.sql` -- 표시를 읽는 trigger 네 곳(381·464·481·590행 부근)에 소유자 role 검사 추가. 가리기 SQL 함수 두 개(예: `brain.redact_message(...)`, `brain.redact_file(...)`, 입력은 jsonb 묶음 가능)와 `execute` 권한, cleanup allowlist 표의 `grant maintain … to brain_maintenance`. 555-562행의 revoke·열 grant는 그대로 둔다. baseline은 티켓 10 전까지 고칠 수 있다(에픽 Decision). 기존 개발 DB는 다시 만들어야 한다.
- `packages/postgres/src/setup.ts` -- `PrepareDatabaseOptions`에 선택 `maintenancePassword`. `brain_maintenance` 생성(있으면 비밀번호만 갱신), `grant pg_checkpoint`, `grant usage on schema brain`. 기존 advisory lock 아래에서 한다. 비밀번호 인용은 기존 `appPassword` 방식 그대로.
- `packages/postgres/src/sessions.ts` -- `redactMessage` 추가, 반환 타입에서 `Omit<…,'redactMessage'>` 제거. 수집 key 함수·`pgText`·`originalText`·`ensureWork`(`work.ts:65`) 재사용.
- `packages/postgres/src/attachments.ts` -- `redactFile` 추가(`FILE_REDACTION_RESOLVES`로 실패 해소, `plan.work`·`plan.cleanup` 모두 `ensureWork`). `Omit<AttachmentStore,'redactFile'>` 제거.
- `packages/postgres/src/maintenance.ts`(새) -- `postgresTableMaintenance(options: CreatePoolOptions): TableMaintenance & { close() }`. `createPool`을 `queryTimeoutMs: 0`으로 쓰고, `databaseFailure` 분류(`55P03`→`DB_LOCKED`) 재사용.
- `packages/postgres/src/store.ts`·`index.ts` -- 타입에서 두 `Omit` 제거, `checkHealth` probes에 `redaction_cleanup` 추가(같은 `try` 안), 새 모듈 export. `second_brain/src/postgres.ts`는 `export *`라 따라온다.
- `packages/core/src/domain/redact-plan.ts`, `packages/core/src/files/redact.ts:192`, `packages/core/src/ports/store.ts`(`RedactFilePlan`) -- `cleanup` 필드. 기존 `work`(`blob_delete`)와 `blobDeletesQueued`는 바꾸지 않는다.
- `packages/core/src/maintenance/table-cleanup-work.ts`(새, 이름은 자유) -- `TABLE_CLEANUP_KIND`, target kind, 논리 표 이름 union·allowlist, `tableCleanupWork(...)`, `tableCleanupHandler({ maintenance })`(`WorkHandler`, `queue/drain.ts`의 실패 형태). port `TableMaintenance`는 `packages/core/src/ports/`에 두고 `core/src/index.ts`에서 export. 선례: `files/blob-delete-work.ts`.
- `packages/core/src/testing/contracts/file-redaction.ts:196`(`NO_SPANS`), `packages/core/test/redact-plan.test.ts`, `files-redact.test.ts`, `packages/sqlite/test/redact.test.ts`, `file-redact.test.ts`, `packages/core/src/testing/fakes/store.ts` -- 리터럴·기대값에 `cleanup`만 반영. 단언 의미 불변.
- `tooling/test-db/src/index.ts:88` -- `maintenanceUrl`(사용자 `brain_maintenance`, 고정 시험 비밀번호). `packages/postgres/test/fixture.ts`는 같은 비밀번호를 `prepareDatabase`에 넘긴다.
- 시험 선례: `packages/postgres/test/store.test.ts:29`(spoofed GUC 거부), `:85`(files 열 grant), `test/schema.test.ts:22`(소유자 `redacting` 헬퍼, 그대로 통과해야 함), `test/attachment-extraction.test.ts:313`, `test/work-store.test.ts`(blocker 연결, `lockTimeoutMs: 40`, schema drop).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/**`(plan 필드, 정리 kind·handler·port, export) -- Core가 정리 일감 id를 만들고 drain이 처리한다
- [x] `tooling/test-db/src/index.ts`, `packages/postgres/test/fixture.ts`, `packages/postgres/src/setup.ts` -- 정리 role과 시험 URL
- [x] `packages/postgres/migrations/0001_initial.sql` -- trigger 소유자 검사, 가리기 SQL 함수, MAINTAIN grant
- [x] `packages/postgres/src/sessions.ts`, `attachments.ts`, `maintenance.ts`, `store.ts`, `index.ts` -- 두 verb, 정리 adapter, probe
- [x] 리터럴 반영 시험 파일들(Code Map) -- 새 필수 필드
- [x] `packages/postgres/test/store.test.ts`(또는 새 파일) -- `sessionRedactionContract()`·`fileRedactionContract()`를 `subject`로 실행
- [x] `packages/postgres/test/redaction.test.ts`(새) -- I/O 매트릭스 각 행을 아래 이름으로 시험

**시험 이름(`redaction.test.ts`):**
- `removes the redacted string from messages, tool notes, chunks and raw bytes`
- `keeps U+0000 outside the span and no secret bytes in body_raw`
- `removes a redacted file's names and pieces and queues cleanup for its tables`
- `clears the marker when the redact function returns, so a plain UPDATE on the same connection is refused`
- `leaves no marker and no change after a refused redaction rolls back`
- `refuses brain_app every way around the triggers and every table rewrite`
- `warns in doctor until the cleanup drain rewrites the tables, then reports ok`
- `keeps warning while cleanup waits on a lock, then finishes`
- `keeps warning when cleanup lacks MAINTAIN, even after the failure is recorded`
- `does not close a cleanup that was running when a new redaction committed`
- `serializes two redactions of one message`
- `answers DB_LOCKED and DB_UNAVAILABLE from both redact verbs without changing anything`

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/redaction.test.ts packages/postgres/test/store.test.ts packages/postgres/test/schema.test.ts packages/postgres/test/attachment-extraction.test.ts`, then session-store 가리기 case·file-redaction 계약 4 case와 위 이름의 시험, 기존 schema·첨부 시험이 모두 통과한다.
- Given 같은 실행, when 정리 전후 doctor 시험이 끝나면, then `runDoctor`의 `redaction_cleanup`이 정리 전 `warn`, drain 뒤 `ok`이고, superuser가 읽은 정리 대상 표의 heap·TOAST 파일에 가린 문자열 바이트가 없다.
- Given 같은 실행, when `brain_app` 우회 시험이 끝나면, then 모든 시도가 거부되거나 효과가 없고 정리 대상 표의 `relfilenode`와 행이 그대로다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 memory·SQLite·PG 계약을 포함한 모든 시험이 통과한다.

## Implementation Notes

- PG 18의 `VACUUM FULL`은 오래된 MVCC snapshot이 있으면 재작성한 표에도 아직 지울 수 없는 옛 행을 남긴다. 전체 병렬 시험에서 `relfilenode`가 바뀌어도 heap·TOAST에 비밀 바이트가 남는 경우를 확인했다. 따라서 정리 adapter는 `VACUUM (FULL, VERBOSE)`의 `copy_table_data` 완료 detail에 보고된 잔존 dead-row 수까지 확인한다. 0보다 크면 `DB_LOCKED`로 일감을 열어 두고, 완료 detail을 해석하지 못하면 성공으로 닫지 않는다. 같은 DB의 오래된 snapshot으로 이를 재현하는 회귀 시험을 추가했다. marker·권한·트랜잭션 경계와 intent는 그대로다.
- 리뷰 patch(같은 구현 세션): adapter가 `plan.cleanup`·`plan.work`를 SQL 함수보다 먼저 `ensureWork`하고, 두 SQL 함수는 자기가 바꾸는 표마다 열린 `table_cleanup` 일감이 없으면 `invariant refused`로 거부한다. 정리 handler는 정리 연결의 실패를 drain의 spool 원인 코드로 넘기지 않고 `TABLE_CLEANUP_WAITING`(잠금 대기·옛 snapshot)·`TABLE_CLEANUP_FAILED`(그 밖, 권한 거부 포함)로 바꿔 `retryable: true`로 낸다. 성공하면 그 표의 `table_cleanup` 실패를 `resolveFailures`로 해소하고, `FAILURE_RETRY_STAGES`에 `table_cleanup`을 더해 `failures retry`가 다시 넣을 수 있다. `brain.redaction_raw_valid`는 한 번의 선형 바이트 비교로 바꿨다.
- `VACUUM FULL`은 `PROC_IN_VACUUM`으로 돌지 않으므로 자기 snapshot의 xmin이 클러스터 안 다른 DB에서 실행 중인 트랜잭션에도 묶인다. 그래서 병렬 시험에서는 정리가 옛 행 잔존으로 대기하다 시도 한도를 다 쓸 수 있다. 제품 판정(잔존이면 완료 아님)은 그대로 두고, `ok`를 기다리는 시험은 기록된 `table_cleanup` 실패를 Core `retryFailures`로 다시 넣는 제품 복구 경로를 따르게 했다. 정리 연결의 시험 기본 `lockTimeoutMs`는 5000ms이고, 잠금을 일부러 잡는 시험만 40ms다.
- 다음 티켓 인계: 런타임 조립(티켓 7)이 `tableCleanupHandler({ maintenance, store, clock })`를 drain handler에 등록하고 `postgresTableMaintenance`에 정리 URL을 줘야 하며, 설치(티켓 8)가 `prepareDatabase`에 `maintenancePassword`를 넘기고 `.env`에 정리 role 접속을 써야 한다. 그 전에는 제품 경로에서 정리가 돌지 않고, PG가 런타임이 되면 doctor는 정리 일감이 남는 동안 `warn`이다.

- 후속 thorough 수정: 청구 무효화는 `ensureWork`에서 두 privileged 가리기 SQL 함수로 옮겼다. 따라서 일반 `addWork`·`retryFailures`는 진행 중 정리 청구를 보존하고, 직접 SQL 가리기도 이전 정리 청구를 무효화한다. 메시지 함수는 중복 tool-note id를 쓰기 전에 거부한다.
- 후속 thorough 수정: 실패 해소는 handler 밖으로 옮겼다. PG `completeWork`가 청구 CAS에 성공한 경우 같은 트랜잭션에서 해당 표의 미해결 `table_cleanup` 실패를 해소한다. 실패 해소가 거부되면 완료도 롤백되며, 청구 상실이면 실패를 건드리지 않는다. 런타임 인계의 최종 호출은 `tableCleanupHandler({ maintenance })`다(앞선 구현 기록의 `store`·`clock` 인자를 대체).

## Plan Change Log

## Review Triage Log

- `quick`: 전체 diff·계획·context를 독립 검토했으며 추가 findings 없음. 보류 항목 없음.
- 참고: 위 줄은 구현 세션이 스스로 돌린 quick 검토(이 워크플로의 렌즈 밖) 기록이다.

### 2026-10-28 — Review pass
- verdicts: 19 findings — high 0, medium 13, low 1, false 5, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) `brain_app`이 `brain.redact_message`·`brain.redact_file`을 유효한 payload로 직접 부르면 정리 일감 없이 가리기가 커밋되어 `redaction_cleanup`이 `ok`가 된다 — 두 함수가 `brain_app`에 `execute`로 열려 있고 일감은 TS에서만 넣던 것을 확인했다. adapter가 일감을 먼저 넣고, 함수가 바꾸는 표마다 열린 `table_cleanup`이 없으면 거부하도록 고쳤다. 시험 `refuses a valid direct brain_app %s redaction without cleanup items`.
  - `[medium]` `[patch]` (blind) 정리 성공이 옛 `table_cleanup` 실패를 해소하지 않아 권한을 고친 뒤에도 doctor가 계속 `warn`이다 — probe가 미해결 실패를 읽고 handler에 `resolveFailures`가 없음을 확인했다. 성공 시 그 표·단계의 실패를 해소하도록 고쳤다(`blob-delete-work.ts` 선례). Core 시험 `resolves the successful table cleanup stage at the injected clock instant`.
  - `[medium]` `[patch]` (blind) `FAILURE_RETRY_STAGES`에 `table_cleanup`이 없어 `failures retry`가 건너뛴다 — `failures/retry.ts:111-122`에서 kind 없음 → `skipped`를 확인했다. 매핑을 더하고, MAINTAIN 회수 → 실패 기록 → 권한 복구 → `retryFailures` → `ok` 시험을 더했다.
  - `[medium]` `[patch]` (blind) `CHECKPOINT` 권한 거부(42501)가 `DB_UNAVAILABLE`로 나와 시도 없이 무한 반복된다 — `classifyWorkFailure`가 spool 원인 코드를 `release`로 돌려 일감을 돌려주고 drain 실행 전체를 `unwritable`로 멈추는 것을 확인했다(같은 원인으로 `DB_LOCKED`도). handler가 정리 실패를 `TABLE_CLEANUP_WAITING`·`TABLE_CLEANUP_FAILED`(`retryable: true`)로 바꾸게 고쳤다. 시험 `records checkpoint permission failures without stopping the drain as unwritable`.
  - `[low]` `[reject]` (blind) 구간 없는 도구 메모를 `targetRaw: null`로 보내면 원래 U+0000이 U+FFFD로 바뀐다 — 실제로 SQL 함수를 직접 부르면 가능하다. 그러나 adapter는 구간이 있는 메모만 보내고 raw를 `pgText`로 만들어 이 경로에 닿지 않는다. 직접 SQL 호출자만 만날 수 있고, 막으려면 raw 기대값을 바이트 오프셋으로 계산하는 검증을 더해야 해 직접 수정이 아니다.
  - `[medium]` `[patch]` (blind) `brain.redaction_raw_valid`가 바이트마다 누적 bytea 전체를 이어 붙여 큰 U+0000 본문에서 제곱 시간이 든다 — 코드에서 확인했다. 큰 NUL 본문이면 시간 한도로 가리기 자체가 실패할 수 있다. 같은 수락·거부 규칙의 선형 비교로 바꾸고 시험 `redacts a large U+0000 body with linear raw-byte validation`을 더했다.
  - `[medium]` `[patch]` (blind) 롤백 시험이 첫 UPDATE 전 실패만 본다 — 시험 본문(`body: 'invented'`)이 쓰기 전에 거부됨을 확인했다. 쓰기 뒤 실패(시험용 `brain.redactions` insert 거부 trigger)로 두 verb 모두 `DB_UNAVAILABLE`과 모든 행·일감 불변을 단언하는 시험 `rolls back all %s writes and queued work after a late SQL failure`를 더했다.
  - `[false]` `[reject]` (blind) `heaps()`가 `.1`·`.2` 세그먼트를 읽지 않는다 — 세그먼트는 1GB마다 생기고 시험 표는 몇 페이지라 두 번째 세그먼트가 없다. 이 시험에서 비밀 바이트가 빠질 자리가 없다.
  - `[false]` `[reject]` (blind) 실행 중 새 가리기 시험이 실제 `VACUUM FULL`을 돌리지 않는다 — 완료 여부를 정하는 것은 새 가리기가 청구를 지워 `completeWork`가 `lost`가 되는 것이고, 시험이 그 경로를 그대로 단언한다. `VACUUM FULL`은 `AccessExclusive`라 실행 중에는 가리기 UPDATE가 기다렸다가 끝난 뒤 커밋되므로 순서가 이 시험과 같다.
  - `[medium]` `[patch]` (blind) SQL 함수의 거부 규칙 시험이 빈 구간 위조 본문 하나뿐이다 — 범위 초과·겹침·다른 메시지 메모·빠진 메모·옛 raw를 `brain_app`으로 직접 넣는 매개변수 시험을 더했고 모두 `invariant refused`·행 불변이다.
  - `[medium]` `[patch]` (edge) 유효한 직접 SQL 호출이 정리 일감 없이 커밋된다 — blind 첫 줄과 같은 원인·같은 수정.
  - `[medium]` `[patch]` (edge) `pg_checkpoint` 없음(42501)이 `DB_UNAVAILABLE`로 반복된다 — blind 넷째 줄과 같은 원인·같은 수정.
  - `[medium]` `[patch]` (verification-gap) 올바른 text에 옛 raw를 붙인 호출의 거부가 검증되지 않는다 — 렌즈 근거 그대로 받아들였다. 위 매개변수 시험의 raw 경우로 해결했다.
  - `[medium]` `[patch]` (verification-gap) 가리기 SQL 성공 뒤 정리 일감 등록 실패의 원자성이 검증되지 않는다 — 렌즈 근거 그대로 받아들였다. patch로 일감 등록이 SQL 함수보다 앞으로 왔으므로, 함수의 쓰기 뒤 실패를 일으키는 late-failure 시험이 같은 원자성을 증명한다.
  - `[medium]` `[patch]` (intent) SQL 함수 자체는 정리 일감을 보장하지 않아 직접 호출이 doctor를 속인다 — blind 첫 줄과 같은 원인·같은 수정.
  - `[false]` `[reject]` (intent) 제품 명령 경로에 정리 handler가 연결되지 않았다 — 에픽 Decision이 hook·명령·데몬의 PG 조립을 티켓 7, 설치·doctor를 티켓 8에 두고 이 시점의 런타임은 SQLite다. 의도가 이 티켓에 요구한 표면은 PG Store·정리 경로·doctor probe이고 그것은 구현·시험되었다. 인계는 Implementation Notes에 적었다.
  - `[false]` `[reject]` (intent) "어디에도 없음"이 현재 관계 파일까지로 좁혀졌다 — spine AD-11이 정리 완료를 표 재작성·체크포인트로 정의하고 옛 WAL·백업을 명시적으로 범위 밖에 둔다. 의도와 다르지 않다.
  - `[medium]` `[patch]` (intent) 롤백 시험이 쓰기 전 거부만 관찰한다 — blind 일곱째 줄과 같은 원인·같은 수정.
  - `[false]` `[reject]` (intent) doctor 경고가 저장 상태가 아니라 추적된 일감·실패를 근거로 한다 — AD-11이 "정리 일감 … 끝날 때까지 doctor warn"으로 추적 일감을 근거로 정했고, patch 뒤에는 모든 가리기 경로가 일감을 남겨야만 커밋된다.
- 검증 중 처리: patch 뒤 첫 전체 실행에서 `warns in doctor until the cleanup drain rewrites the tables, then reports ok`가 실패했다. 원인은 병렬 시험의 다른 DB 트랜잭션이 `VACUUM FULL`의 xmin을 붙잡아 정리가 대기하고, 시험 시계가 반복마다 1시간씩 가서 시도 한도가 몇 초 만에 소진된 것이다. 제품 코드는 바꾸지 않고 시험 대기 루프가 `retryFailures` 복구 경로를 따르게 했다(단언 불변).

## Design Notes

**왜 SQL 함수인가:** `brain_app`은 `messages`·`tool_notes`를 UPDATE할 권한이 없고(555행) GUC는 누구나 세울 수 있다. 그래서 쓰기는 소유자 권한의 함수가 하고, 그 함수가 "구간을 표시로 바꾼 값"만 받아들여 일반 재작성 통로가 되지 않게 한다. 함수 SET 절(`set brain.redacting = 'on'`)이나 `set_config(…, true)`+예외 경로 복구 어느 쪽도 좋지만, 함수가 끝난 뒤 표시가 진입 전 값으로 돌아가야 한다. trigger 예외 예시:

```sql
if current_setting('brain.redacting', true) = 'on'
   and pg_has_role(current_user, (select relowner from pg_class where oid = tg_relid), 'MEMBER') then …
```

**정리와 그 경계:** `VACUUM`은 트랜잭션·함수 안에서 돌 수 없으므로 정리는 drain handler가 따로 연결해서 한다. `brain_maintenance`는 데이터 DML이 없고 allowlist 표의 MAINTAIN과 `pg_checkpoint`만 가진다. 이 완료는 표 재작성·체크포인트까지이고 옛 WAL·백업은 범위 밖이다(AD-11). 런타임 연결(티켓 7·8)이 이 handler와 정리 URL을 조립할 때까지 제품 경로의 정리는 돌지 않는다.

## Verification

**Observed (2026-10-28):**
- `npx --yes pnpm@12 test` — build·typecheck와 112개 파일, 3,036개 시험 통과.
- 지정된 PG 네 파일 — 132개 시험 통과(요구한 12개 이름과 오래된 snapshot 회귀 시험 포함).
- Core·SQLite 별도 실행 — 50개 파일, 1,465개 시험 통과.
- `git diff --check` — 출력 없음.
- 조정자 확인(리뷰 patch 뒤): build 성공, 대상 PG 네 파일 144개, core·sqlite 51 files / 1,469개, `npx --yes pnpm@12 test` 두 번 연속 113 files / 3,052개 모두 통과, `git diff --check` 출력 없음. I/O 매트릭스 12행은 모두 이름 붙은 시험이 있고 `--reporter=verbose`로 실행·통과를 확인했다.

**Commands:**
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/redaction.test.ts packages/postgres/test/store.test.ts packages/postgres/test/schema.test.ts packages/postgres/test/attachment-extraction.test.ts` -- expected: 새 시험·계약과 기존 PG 시험 통과
- `npx --yes pnpm@12 exec vitest run --project core --project sqlite` -- expected: plan 필드 추가 뒤 memory·SQLite 통과
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과(OrbStack 켜짐)
- `git diff --check` -- expected: 출력 없음

### 2026-10-28 — Review pass (후속 thorough)
- verdicts: 21 findings — high 3, medium 8, low 0, false 10, maybe-false 0
- findings:
  - `[false]` `[reject]` intent: 제품 경로 미연결 — carried: 기존 같은 판정 유지. 에픽 Decision이 런타임 조립을 티켓 7, 설치를 티켓 8에 두며 현재 기본 런타임은 SQLite다.
  - `[false]` `[reject]` intent: 모든 저장 위치 부재를 입증하지 않음 — carried: 기존 같은 판정 유지. AD-11의 완료 경계는 표 재작성·체크포인트이며 옛 WAL·백업은 범위 밖이다. 이번 시험은 지정된 현재 행·heap·TOAST를 본다.
  - `[medium]` `[patch]` intent: marker 진입값 복원과 파일 함수 시험 표면 — 진입 전 on을 복원하는 것은 intent-contract의 명시 계약이다. 파일 함수의 같은 트랜잭션 표시 복원 시험 공백은 실제이므로 검증 공백 렌즈와 같은 시험으로 보강했다.
  - `[false]` `[reject]` intent: 확장 실행 주체 권한을 직접 시험하지 않음 — 에픽 Boundaries는 확장 role 설치를 epic-extensions로 넘긴다. 현재 setup은 정리 role에만 권한을 주고 public·brain_app에 주지 않으며, 아직 존재하지 않는 확장 role 시험은 이 변경의 결함이 아니다.
  - `[false]` `[reject]` intent: 실패·잠금 대기 경고와 청구 무효화 표면 — 이 항목은 차이를 주장하지 않고 구현된 시험을 기술한다. 열린 일감·미해결 실패를 읽는 probe는 계약과 같다. 직접 SQL 청구 경합은 별도 edge/blind 항목에서 수정했다.
  - `[false]` `[reject]` intent: 실제 명령 실패의 spool 부재 시험이 없음 — carried: 제품 조립은 티켓 7·8이다. Store 가리기는 withWrite 실패 값을 반환하며 spool 의존성이 없고, 늦은 SQL 실패의 원자성 시험과 두 공유 계약이 이 티켓의 표면을 관찰한다.
  - `[false]` `[reject]` intent: 원문보다 구체화된 Core port·raw·snapshot 구현 선택 — 보고가 구현 선택을 나열했을 뿐 나쁜 결과를 제시하지 않는다. 정리 일감·별도 연결·원문 보존을 구현하는 구체화이며 의도 위반이 아니다.
  - `[medium]` `[patch]` verification-gap: 파일 SQL 함수의 정상 반환 뒤 marker 복원 시험 없음 — 렌즈의 검색·시험 근거를 받아들였다. 파일 함수의 정상 반환, 기존 off 복원, 예외 롤백과 같은 연결의 일반 UPDATE 거부 시험을 추가했다.
  - `[medium]` `[patch]` verification-gap: PG 파일 가리기의 추출 실패 해소 시험 없음 — 렌즈 근거를 받아들였다. 대상 미해결 document_extract 실패만 해소하고 실제 건수·시각을 반환하는지, 다른 파일·단계·이미 해소한 행은 유지되는지 시험을 추가했다.
  - `[high]` `[patch]` edge: 직접 SQL 가리기가 재작성 끝난 정리 청구를 재사용함 — SQL 함수의 perform 존재 검사는 청구를 그대로 두고 TS ensureWork만 청구를 지웠다. 두 SQL 함수에서 필요한 열린 정리 행을 UPDATE하며 청구를 무효화하도록 고쳤고, 실제 VACUUM 뒤 직접 호출·이전 completeWork 거부를 시험했다.
  - `[medium]` `[patch]` edge: 중복 toolNotes id가 같은 redactions 구간을 반복 적용함 — 함수 loop가 두 번째 항목에서 이미 바뀐 target을 다시 읽어 동일 구간을 적용할 수 있었다. UUID 기준 중복 id를 쓰기 전에 거부하고 상태 불변을 시험했다.
  - `[high]` `[patch]` blind: 직접 SQL 호출이 열린 청구를 무효화하지 않음 — edge 첫 항목과 같은 원인·같은 SQL 수정 및 회귀 시험이다. 정리 완료 후 새 가리기가 있으면 이전 청구로 닫을 수 없다.
  - `[medium]` `[patch]` blind: resolveFailures 실패를 무시하여 doctor가 계속 warn — handler가 실패 반환값과 예외를 무시했다. handler의 실패 해소를 제거하고 PG completeWork의 CAS 트랜잭션 안으로 옮겼다. 실패 해소 SQL 실패이면 완료가 롤백되는 시험으로 검증했다.
  - `[high]` `[patch]` blind: 오래된 handler가 새 청구의 실패까지 해소함 — 완료 CAS 전에 handler가 표 전체 실패를 해소하여 청구 상실 뒤 새 실패가 지워질 수 있었다. CAS가 성공한 완료 트랜잭션만 실패를 해소하며 lost이면 실패가 그대로인 시험을 추가했다.
  - `[medium]` `[defer]` blind: 제한 없는 정리가 공통 10분 청구를 넘으면 재청구됨 — 기존 DEFAULT_WORK_POLICY의 600000ms 청구와 갱신 없는 drain을 확인했다. 에픽 Boundaries가 청구 갱신을 epic-jobs-and-scheduler에 둔다. 기존 ledger는 손대지 않고 이 계획 deferred에 새 항목 하나만 기록했다.
  - `[medium]` `[patch]` blind: 일반 addWork·retryFailures도 정리 청구를 취소함 — ensureWork는 일반 addWork에서도 호출된다. 무효화를 SQL 가리기 함수로 옮겨 일반 일감 재요청은 청구를 보존하며 직접 addWork와 retryFailures를 시험했다.
  - `[false]` `[reject]` blind: 새 가리기가 attempts를 초기화하지 않음 — MAX_WORK_ATTEMPTS는 실패 수가 아닌 실제 청구 횟수이고 이 행은 동일 열린 일감이다(work-item.ts의 명시 계약). 시도 소진 시 실패로 기록되고 doctor는 warn을 유지하며 failures retry로 새 일감을 만든다. 새 가리기마다 초기화해야 한다는 계약은 없다.
  - `[false]` `[reject]` blind: 실행 중 새 가리기 시험에서 실제 VACUUM을 하지 않음 — carried: 기존 같은 주장·판정 유지. VACUUM의 AccessExclusive와 가리기 UPDATE가 직렬화되고 claim 무효화가 completeWork 거부를 결정한다. 이번 직접 SQL 회귀 시험은 실제 VACUUM 뒤 호출도 추가로 관찰한다.
  - `[false]` `[reject]` blind: 파일 가리기와 추출 완료의 동시 시험이 없음 — redactFile과 begin/append/finishExtraction은 모두 먼저 같은 files 행을 for no key update로 잠근다(extractions.ts:121·222·298). 가리기가 먼저면 redacted_at을 다시 읽어 current=false·조각 비공개가 되고, 추출이 먼저면 가리기가 그 결과를 지운다. 기존 redacted-file 시험도 뒤 순서의 거부를 관찰한다. 제시한 재게시 결과는 이 잠금 아래 일어나지 않는다.
  - `[medium]` `[patch]` blind: marker 복원 시험이 message 함수뿐임 — verification-gap 첫 항목과 같은 시험 공백이며 파일 함수 정상·예외·기존 off 복원 시험으로 해결했다.
  - `[false]` `[reject]` blind: heaps가 여러 세그먼트 파일을 검사하지 않음 — carried: 기존 같은 주장·판정 유지. 해당 시험 표는 몇 페이지여서 1GB 뒤 세그먼트가 없고, 이 fixture에서 비밀 바이트를 빠뜨릴 파일이 없다.

### 2026-10-28 — Review pass (추가 후속 thorough)
- verdicts: 18 findings — high 0, medium 9, low 2, false 6, maybe-false 1
- findings:
  - `[false]` `[reject]` intent: 핵심 원자성·별도 정리·미완료 경고의 차이 — 렌즈는 이 항목에서 차이를 주장하지 않고 구현·시험의 대응을 기술했다. 이번 전체 build·typecheck·113개 파일 3063개 시험도 통과했다.
  - `[false]` `[reject]` intent: 모든 저장 위치의 부재·인덱스·추가 세그먼트 — carried: AD-11의 표 재작성·체크포인트 경계와 작은 fixture에는 추가 세그먼트가 없다는 기존 판정 유지. WAL·백업은 명시적 범위 밖이고 원문 전체는 인덱스의 trgm 표현이 아니다.
  - `[false]` `[reject]` intent: marker가 기존 on으로 복원됨 — carried: intent-contract가 진입 전 값 복원을 명시한다. brain_app은 소유자 검사로 우회하지 못하며 off·미설정·예외·같은 연결 UPDATE 거부 시험을 이미 보강했다. on의 복원은 다른 읽기를 구현한 결함이 아니다.
  - `[false]` `[reject]` intent: 제한된 경로가 전용 role이며 확장 role 직접 시험이 없음 — carried: 정리 전용 role과 allowlist MAINTAIN이 명시 경계이고 확장 role 설치는 별도 에픽이다. 자격 증명을 가진 전용 role을 단일 TS 함수로 격리하라는 요구는 없다.
  - `[false]` `[reject]` intent: doctor가 저장 바이트 대신 일감·실패를 신뢰하고 blob_delete를 세지 않음 — carried: 계약은 table_cleanup 완료를 추적한다. blob_delete는 기존 별도 파일 삭제 경로이고 이번 표 정리 probe의 추가 대상이라는 요구가 아니다.
  - `[false]` `[reject]` intent: 제품 명령·spool 검증 표면 — carried: 에픽 Decision이 런타임 조립을 티켓 7, 설치를 티켓 8에 둔다. Store는 spool 의존성이 없고 늦은 SQL 실패의 롤백 시험이 있다.
  - `[medium]` `[patch]` verification-gap: 메모만 가리는 정리 목록 시험 없음 — 렌즈의 시험·검색 근거를 받아들였다. 본문 보존과 정확한 tool_notes·chunks 일감·파생 조각 삭제를 관찰하는 시험을 추가했다.
  - `[medium]` `[patch]` verification-gap: 다른 파일 메타데이터 보존 시험 없음 — 렌즈의 근거를 받아들였다. 두 번째 파일의 전체 메타데이터 보존과 대상 삭제 건수를 검증했다.
  - `[medium]` `[patch]` blind: Store와 직접 SQL의 메시지·정리 일감 잠금 순서 반대 — sessions.ts는 ensureWork의 FOR UPDATE 뒤 SQL 함수의 메시지 잠금을 잡고 함수는 그 역순이다. DB_LOCKED와 롤백으로 안전하지만 정상 가리기가 실패할 수 있었다. 기존 SQL 함수가 메시지 잠금 전에 Store와 같은 세션 advisory key를 잡도록 고쳤다. pg_locks로 두 경로의 동일 키 대기를 확인하고 서로 다른 가리기 결과가 모두 남는지 시험했다. 새 함수·grant·공개 표면은 추가하지 않았다.
  - `[medium]` `[defer]` blind: brain_app이 직접 정리 큐를 삭제·완료 가능 — 기존 공통 큐 DML 및 공개 completeWork 권한의 한계다. 이 변경은 그 권한을 새로 주지 않았다. 임의 SQL을 별도 적대 주체로 격리하려면 공통 큐 전체의 권한·완료 경계 재설계가 필요하여 계획 deferred에 새 항목으로만 기록했다. 기존 ledger는 수정하지 않았다.
  - `[low]` `[reject]` blind: raw가 구간 밖 NUL·대체문자의 차이를 허용 — carried: redaction_raw_valid와 adapter pgText 경로가 그대로이며 기존 raw 검증의 직접 SQL 한계에 대한 low·reject 판정을 유지한다. 일반 adapter는 원문에서 올바른 raw를 만들고 더 강한 검증은 직접 수정 이상이다.
  - `[medium]` `[patch]` blind: 직접 파일 SQL의 contentHash가 실제 파일과 다를 수 있음 — 함수는 fileId만 비교하고 record.contentHash를 그대로 기록한다. planFileRedaction은 맞는 해시를 만들지만 직접 함수의 감사 기록 위조를 막을 단순 비교를 추가하고 전체 행·청구 상태 불변을 시험했다.
  - `[maybe-false]` `[defer]` blind: VACUUM notice의 로캘·내부 detail 형식 — 다른 lc_messages에서 숫자 선두 형식이 실제 달라지는지는 코드만으로 확정하지 못했다. PG18 기본 환경 전체 시험은 통과했고 해석 불가 시 성공하지 않는다. 다른 로캘의 실제 notice와 설정 가능성을 확인할 항목으로 계획에만 추가했다.
  - `[low]` `[patch]` blind: 같은 필드의 pgText 중복 호출 — sessions.ts payload에서 같은 큰 문자열을 두 번 변환함을 확인했다. 동일 결과를 지역 변수로 재사용하도록 직접 수정했다.
  - `[medium]` `[patch]` blind: 물리 검사 전 some()이 TOAST 누락을 잡지 못함 — 동일 secret이 작은 메모·다른 표에도 있어 큰 본문 TOAST를 읽지 못해도 전제 단언이 통과한다. 본문·메모·조각·메타데이터마다 고유 비밀을 두고, 큰 본문의 TOAST 전후 단언과 위치별 정리 전 존재·정리 후 부재 단언을 추가했다.
  - `[medium]` `[patch]` blind: ingest와 가리기의 세션 잠금 공유 시험 없음 — 기존 시험은 두 가리기만 경합시킨다. 실제 ingest와 redactMessage의 양쪽 시작 순서, 동일 advisory 대기, 재수집 뒤 원문이 재등장하지 않음을 시험했다.
  - `[medium]` `[patch]` blind: 새 함수 EXECUTE 권한 회귀 단언 없음 — SQL의 revoke·grant는 맞지만 PUBLIC·brain_app·내부 함수 권한을 직접 확인하는 단언이 없다. 권한 경계 회귀 시험을 추가했다.
  - `[medium]` `[patch]` blind: handler의 잘못된 두 대상 거부 분기 시험 없음 — 구현의 거부 분기는 있지만 시험은 실패 분류와 성공만 본다. 두 대상별 거부·retryable=false·maintenance 호출 없음 시험을 추가했다.

## Auto Run Result

- 반환 상태: `built`. 기존 계획의 `status: 'built'`를 유지했다. 티켓을 done으로 표시하지 않았고 `tickets.py mark`를 실행하지 않았다. 완료 판정은 오케스트레이터의 자체 검증에 맡긴다. 사람 결정이 필요한 차단 사항은 없다.
- 구현 요약: 기존 PostgreSQL 가리기·정리 구현의 추가 후속 thorough 검토를 수행했다. 직접 SQL과 Store의 메시지 가리기가 같은 세션 advisory key를 먼저 잡도록 통일하고, 파일 가리기의 감사 해시 불일치를 쓰기 전에 거부한다. 메시지·도구 메모의 pgText 변환은 필드마다 한 번만 한다.
- 이번 실행의 파일별 변경:
  - `packages/postgres/migrations/0001_initial.sql` — 기존 메시지 가리기 함수에 세션 advisory lock 추가, 파일 감사 해시 비교 추가. 새 공개 SQL 함수나 권한은 추가하지 않았다.
  - `packages/postgres/src/sessions.ts` — pgText 결과 재사용.
  - `packages/postgres/test/redaction.test.ts` — 실제 직접 SQL·Store·ingest 경합, 메모만 가리기, 다른 파일 메타데이터 보존, 위치별 고유 비밀과 TOAST의 물리 제거, 해시 불일치의 전체 롤백, EXECUTE 경계 검증.
  - `packages/core/test/table-cleanup-work.test.ts` — 잘못된 targetKind·targetId의 거부와 maintenance 미호출 검증.
  - 이 계획 — 렌즈별 판정·새 deferred 항목·검증 결과·인계 기록.
- 리뷰 결과: blind-hunter 10건, edge-case-hunter 0건, verification-gap 2건, intent-alignment의 비교 항목 6건을 각각 기록했다. 전체 18건은 high 0, medium 9, low 2, false 6, maybe-false 1이다. patch 9개 원인(medium 8, low 1)을 수정했고 새 defer 2개를 계획에만 추가했다. 기존 deferred 목록의 항목과 ledger의 내용·상태·해결 기록은 그대로 보존했다.
- 기각 7건: 의도 렌즈의 핵심 계약 대응 설명은 결함 주장이 아니며, 물리 제거 경계·기존 marker 값 복원·정리 전용 role·doctor 추적·제품 조립의 범위에 대한 나머지 5개 비교는 기존 같은 판정을 carried로 유지했다. 직접 SQL의 raw 정규화 한계는 기존 low·reject 판정을 carried로 유지했다. 각 행에 반증·범위 근거를 남겼다.
- 후속 검토 권고: `false`. 이번 후속 패스에서 수정한 원인 중 high는 0, medium은 8, low는 1이다. 워크플로 규칙상 후속 패스의 medium 수정 수만으로 추가 검토를 권고하지 않는다.
- 검증: 수정 전 전체 build·typecheck·113개 파일 3063개 시험 통과. 최종 수정 뒤 조정자의 계획상 build 및 지정 PG 네 파일 명령은 158개 시험, Core·SQLite 명령은 51개 파일 1472개 시험 통과. 첫 최종 전체 실행은 CLI 데몬 설정 오류 로그 대기 시간 초과 1건으로 3070개 통과·1개 실패였고, 해당 CLI 파일 분리 재실행은 35개 모두 통과했다. 이후 전체 재실행은 build·typecheck 및 113개 파일 3071개 시험 모두 통과했다. 구현 세션에서도 최종 PG 158개와 Core 7개 및 관련 build·타입 검사가 통과했다. `git diff --check` 출력 없음.
- 남은 한계: 기존 공통 큐 자격 증명을 가진 임의 SQL 사용자는 정리 추적 행을 직접 조작할 수 있다. 다른 lc_messages에서 PG18 VERBOSE detail의 숫자 형식이 달라지는지는 미검증이며, 해석 불가 시 성공 처리하지 않는다. 기존 장시간 청구 갱신 과제는 그대로다. 제품 런타임 조립은 티켓 7, 설치는 티켓 8이며 최종 handler 인자는 `{ maintenance }`다. baseline 0001 변경 후 기존 개발 DB는 재생성이 필요하다.
- 소스·시험은 기존 codex 구현 세션 `01a1827e-f524-7f93-89f7-9c77f5c64604`를 재개하여 수정했다. 조정자는 계획·검증 기록만 작성했다. push하지 않았다.
