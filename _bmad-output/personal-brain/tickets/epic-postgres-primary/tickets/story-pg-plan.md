---
title: '첨부·추출·파일 이름: 문서 조각과 위치가 PG에서 그대로 되읽힌다'
type: 'feature'
ticket: '4'
created: '2026-10-28'
status: done
baseline_revision: 'cb6e3136f98ab7da4aecea0cb373624b9d025fa9'
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
deferred: []
---

<intent-contract>

## Intent

**Problem:** PG Store는 AttachmentStore 11 verb 중 `listMessageAttachments`·`listRedactedContentHashes`만 있고 ExtractionStore는 하나도 없다. 그래서 attachment-store·extraction-store 계약이 PG에서 돌지 않고, 추출 세대(attempt `max+1`, 파일당 진행 중 세대 하나, 늦은 완료 방어)와 `chunk_locator` 정규형 바이트 왕복, `file_names` 쓰기가 PG에서 보장되지 않는다.

**Approach:** `packages/postgres`에 AttachmentStore의 나머지 8 verb(`redactFile` 제외)와 ExtractionStore 9 verb를 SQLite 구현과 같은 의미로 만들어 `postgresStore`에 합친다. 추출 쓰기는 파일 행 잠금으로 같은 파일의 begin·append·finish를 직렬화한다. 두 계약을 PG에서 돌리고, 계약 밖 시험으로 locator 바이트 왕복과 두 프로세스 동시 begin을 확인한다.

## Boundaries & Constraints

**Always:**
- 의미의 기준은 SQLite 구현(`packages/sqlite/src/attachments.ts`, `extractions.ts`)과 Core port 주석이다. 결과 값·`closedStale`·`current`·`marked`·순서·오류 코드가 같아야 한다. 문 순서(닫기 → 포인터 → 옛 조각 → 옛 세대 행)는 `document_chunks_delete_rule` 때문에 그대로 지킨다.
- 쓰기는 기존 `withWrite`(`databaseFailure`: `55P03`·`40P01` → `DB_LOCKED`, 나머지 → `DB_UNAVAILABLE`)로 한다. 연결 실패·`brain` schema 없음은 모든 새 verb에서 값으로 돌아온다(throw 없음). port 결과 타입이 `DB_UNAVAILABLE`만 허용하는 읽기는 모든 오류를 `DB_UNAVAILABLE`로 낸다(`listTranscriptFiles` 선례).
- 입력 시각은 쓰기 전에 Core `formatInstant`로 검사하고 범위 밖이면 아무것도 쓰지 않고 실패 값으로 돌려준다(티켓 3 규칙). 읽은 시각은 `Date`(ms 왕복).
- 텍스트 정렬은 `collate "C"`(SQLite 이진 비교와 같게). UUID 정렬은 `uuid` 순서 그대로.
- `chunk_locator`는 `checkExtractionChunkBatch`가 낸 `text`를 그대로 넣고, 읽을 때 `decodeChunkLocator`로만 푼다(못 풀면 throw — SQLite `toChunk`와 같다).
- U+0000 규칙(에픽 Decision 2026-10-28, 11.1 escalation): transcript에서 온 표시 이름이 `file_names.text`가 되므로 `pgText`/`originalText` 코덱을 쓴다. port가 보는 이름은 원래 문자열과 바이트 단위로 같다.
- 시험 DB는 `test/fixture.ts`의 `database()`/`subject()`. 자식 프로세스 자격 증명은 stdin으로 넘긴다.

**Never:**
- `redactFile`(티켓 5), 데몬·명령의 PG 전환(티켓 7), 전문 검색 질의(epic 17)를 하지 않는다. `apps/cli/**`, `packages/sqlite/**`, `plugin/app-ref`·plugin version을 바꾸지 않는다.
- 같은 파일의 동시 begin을 unique 위반(`23505`)으로 막고 `DB_UNAVAILABLE`로 내보내는 구현, advisory lock 하나로 모든 추출을 직렬화하는 구현, `chunk_locator`를 `jsonb`로 바꾸는 구현을 하지 않는다.
- 문서·커밋·시험 출력 인용에 절대 홈 경로를 쓰지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| locator 바이트 왕복 | pdf(bbox 소수, `-0`), docx, text locator, 키 순서를 섞은 입력, null 필드가 있는 입력으로 append | `select chunk_locator` 문자열 = `encodeChunkLocator(...).text`, `page` 열 = 코덱 page(pdf는 같은 값, 나머지 null), `listExtractionChunks`가 같은 locator로 되읽음. 새 pool로 다시 읽어도 같음 | 없음 |
| Core가 거부하는 철자 | DB CHECK는 통과하지만 정규형이 아닌 문자열(공백·다른 키 순서)을 소유자 연결로 직접 넣음 | `listExtractionChunks`가 거부(throw 또는 실패) — 추측한 위치를 돌려주지 않음 | 값 또는 throw, 조용한 성공 없음 |
| 두 프로세스 동시 begin | 같은 파일, 같은 유효 청구로 두 자식 프로세스가 `beginExtraction`(id 다름)을 동시에 호출. 소유자 연결이 파일 행을 `for update`로 잡고 두 backend가 Lock 대기가 된 뒤 풂 | 두 호출 모두 `ok`. 하나는 attempt 1, 다른 하나는 attempt 2이고 `closedStale.id` = 앞 세대. 열린 세대는 정확히 1개, attempt 1은 `failed`·`read` | `DB_UNAVAILABLE`·`23505` 없음 |
| 늦은 append와 begin 경합 | 열린 세대 A에 append하는 호출과 A를 닫는 새 begin이 같은 파일 행 잠금 뒤에서 동시에 풀림 | A는 닫혀 있고 A의 조각은 0개. append는 `ok` 또는 `EXTRACTION_CLOSED` | 값으로 반환 |
| 이름 NUL 왕복 | 표시 이름에 U+0000이 든 첨부 수집 → `listMissingFileNames` → `writeFileNames` → `listFileNames` | 나가는 이름은 원래 문자열과 같고, 같은 이름을 다시 쓰면 `inserted: 0`. U+0000 있는 이름과 같은 자리에 리터럴 U+FFFD인 이름은 다른 행 | 없음 |
| 잠금 초과 | 소유자 연결이 파일 행을 잡은 채 `lockTimeoutMs: 40`으로 `beginExtraction`·`finishExtraction` | `DB_LOCKED`, 세대·포인터 불변. 풀린 뒤 다시 부르면 한 번 효과 | 값으로 반환 |
| schema 없음 | `drop schema brain cascade` 뒤 새 verb 호출 | 새 17 verb 모두 `DB_UNAVAILABLE` 값 | throw 없음 |

</intent-contract>

## Code Map

- `packages/postgres/src/attachments.ts` -- 지금 `writeAttachments`(수집 공유)와 2 verb. 여기에 `listMissingFileNames`·`writeFileNames`·`listFileNames`·`linkAttachments`·`readFileLocation`·`listFileLocations`·`markFileLocationDeleted`·`readFileSharing`을 더한다. 반환 타입은 `Omit<AttachmentStore, 'redactFile'>`. `writeAttachments`·기존 2 verb의 동작은 바꾸지 않는다.
- `packages/postgres/src/extractions.ts`(새) -- `postgresExtractionStore(connect): ExtractionStore`. SQLite `extractions.ts`를 옮긴다(`EXTRACTION_COLUMNS`, `behindPredicate`, `STALE_EXTRACTION_ERROR` 문장 그대로, `readExtraction`/`toExtraction`/`toChunk`).
- `packages/postgres/src/store.ts` -- 조립. `PostgresStore`에 `Omit<AttachmentStore,'redactFile'> & ExtractionStore`를 더한다.
- `packages/postgres/src/text.ts` -- `pgText`·`originalText` 재사용(`*_raw` 열을 원문으로 되돌림).
- `packages/postgres/src/work.ts` -- 티켓 3의 청구. 추출 청구 검사는 `work_items`를 직접 읽는다(SQLite `beginExtraction` 조건 그대로).
- `packages/postgres/src/connect.ts`·`write.ts` -- `withWrite`, `databaseFailure`, `describe`, `PgConnect`. 바꾸지 않는다.
- `packages/postgres/migrations/0001_initial.sql` -- `file_names`(334행)에 `text_raw bytea`를 마지막 열로 더하고 UNIQUE를 `unique nulls not distinct (file_id, name_source, "text", text_raw)`로 바꾼다(messages 78행 선례). 그 밖은 바꾸지 않는다. baseline은 티켓 10 전까지 고칠 수 있다(에픽 Decision). `document_chunks.body`에는 짝 열을 두지 않는다: 지금 있는 추출기(`core/src/files/text-extractor.ts`)는 U+0000 문서를 거부한다.
- `packages/postgres/test/schema.test.ts:58,154,158` -- `file_names`에 열 목록 없이 4값 insert. 마지막 열 추가는 그대로 통과해야 한다(깨지면 열 목록을 적어 고친다).
- `packages/core/src/testing/contracts/attachment-store.ts:8`, `extraction-store.ts:42` -- subject 타입이 `SessionStore`·`AttachmentStore` 전체라 PG Store(`redactMessage`·`redactFile` 없음)가 들어가지 않는다. 두 계약은 그 verb를 부르지 않으므로 subject를 실제로 부르는 verb의 `Pick`/`Omit`로 좁힌다(`session-store.ts:39-42` 선례). memory·SQLite 실행(`core/test/contracts.test.ts:1407,1411`, `sqlite/test/session-store.test.ts:741`, `sqlite/test/extraction-store.test.ts:161`)은 그대로 통과해야 한다.
- `packages/core/src/ports/store.ts:860-1300` -- 결과 타입별 허용 오류 코드(예: `ListFilesAwaitingExtractionResult`는 `DB_UNAVAILABLE`만).
- 시험 선례: `packages/sqlite/test/chunk-locator.test.ts`(코덱 출력과 DB 문자열 비교), `packages/sqlite/test/extraction-store.test.ts:262`(저장 locator·page = 코덱 출력), `:372`(200조각 배치 2초), `packages/postgres/test/session-concurrency.test.ts`+`fixtures/ingest-worker.mjs`(stdin, `ready`/`go`, dist import), `packages/postgres/test/work-store.test.ts`(blocker 연결, `pg_stat_activity` Lock 대기 확인, `lockTimeoutMs: 40`, schema drop).

## Tasks & Acceptance

**Execution:**
- [x] `packages/postgres/migrations/0001_initial.sql` -- `file_names.text_raw`와 raw 포함 UNIQUE -- U+0000 이름 보존
- [x] `packages/postgres/src/attachments.ts` -- 나머지 8 verb. 이름 쓰기·읽기는 `pgText`/`originalText`, `listMissingFileNames`의 후보는 `display_name_raw`까지 읽어 원문으로 비교·반환 -- E11-4
- [x] `packages/postgres/src/extractions.ts`(새) -- ExtractionStore 9 verb, Design Notes의 잠금 순서 -- E11-4
- [x] `packages/postgres/src/store.ts` -- 조립과 타입 확장 -- 계약 실행
- [x] `packages/core/src/testing/contracts/attachment-store.ts`, `extraction-store.ts` -- subject 타입만 좁힌다(단언 불변) -- 계약이 PG Store를 받게
- [x] `packages/postgres/test/attachment-extraction.test.ts`(새) -- `attachmentStoreContract()`·`extractionStoreContract()`를 `subject`로 돌리고, I/O 매트릭스의 계약 밖 행과 200조각 배치(2초)를 아래 이름으로 시험 -- 검증 기준
- [x] `packages/postgres/test/fixtures/extraction-worker.mjs`(새) -- stdin으로 URL·입력을 받아 `ready` 뒤 `go`에서 `beginExtraction` 한 번, 결과 JSON 한 줄 -- 동시 begin

**시험 이름(`attachment-extraction.test.ts`):**
- `describe('attachment-store contract')`, `describe('extraction-store contract')` -- 계약 case 이름 그대로
- `stores the codec's chunk_locator text byte for byte and reads it back`
- `refuses a stored chunk_locator spelling the codec did not write`
- `keeps one open generation when two processes begin on the same file`
- `leaves no pieces on a generation a racing begin closed`
- `round-trips a file name holding U+0000 apart from a literal U+FFFD`
- `returns DB_LOCKED when an extraction write outlasts lock_timeout, then applies once`
- `answers DB_UNAVAILABLE from attachment and extraction verbs when the brain schema is missing`
- `writes one batch of 200 pieces of 2,000 characters within 2 seconds`

**Acceptance Criteria:**
- Given OrbStack이 켜진 저장소, when `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/attachment-extraction.test.ts`, then attachment-store 계약 4 case·extraction-store 계약 9 case와 위 이름의 시험이 모두 통과한다.
- Given 같은 실행, when locator 왕복 시험이 끝나면, then 모든 표본에서 DB가 돌려준 `chunk_locator` 문자열이 코덱 출력과 `===`로 같고(`-0`은 `0`, null 필드는 없음, 키는 코덱 순서), pdf의 `page` 열은 locator의 page와 같다.
- Given 같은 실행, when 동시 begin 시험이 끝나면, then 그 파일의 `finished_at is null` 세대는 정확히 1개이고 두 begin 결과는 모두 `ok`다.
- Given 전체 저장소, when `npx --yes pnpm@12 test`, then build·typecheck와 memory·SQLite·PG 계약을 포함한 모든 시험이 통과한다.

## Implementation Notes

- PG Store에 첨부 8 verb와 추출 9 verb를 더했다. 추출 쓰기는 세대를 보기 전에 파일 행을 잡고, begin은 청구 행도 `for share`로 잡는다.
- locator는 코덱 문자열을 그대로 저장하고, 세대 정리 문 순서·쓰기 전 시각 검사·`withWrite` 경계의 오류 값을 SQLite와 같게 지켰다.
- `file_names.text_raw`와 raw 포함 UNIQUE를 더했다. 빠진 이름 찾기는 두 열을 모두 비교하고 원래 UTF-8 바이트로 정렬해 U+0000 이름의 정체성과 SQLite 순서를 지킨다.
- 공유 계약은 subject 타입만 좁혔다. 단언은 바꾸지 않았다. UUID가 아닌 id로 위치를 물으면 지금처럼 빈 목록·없음 답을 낸다(`id::text = …`).
- 두 공유 계약, 계획의 계약 밖 시험, stdin 전용 추출 worker, 범위 밖 시각 입력이 파일·세대 상태를 바꾸지 않는다는 회귀 시험을 더했다.
- 구현 세션이 자체 quick 검토에서 `linkAttachments` 두 건(raw 메시지 id 복원, 수집과 같은 세션 advisory key)을 고치고 회귀 시험 2개를 더했다(아래 Triage Log 첫 두 줄).
- 리뷰 patch: `finishExtraction`의 `error`를 `pgText(...).text`로 저장(work.ts 선례), 시험 3개 추가(U+0000 오류 종료, `readFileSharing` 메시지 수, 본인 소유 만료 청구의 `CLAIM_LOST`).
- baseline `0001_initial.sql`을 계획대로 바꿨으므로 기존 개발 DB는 다시 만들어야 한다.

## Plan Change Log

## Review Triage Log

- 참고: 아래 두 줄은 구현 세션이 스스로 돌린 quick 검토(이 워크플로의 렌즈 밖) 기록이다.
- medium / patch — `linkAttachments`가 `harness_message_id`의 raw 짝을 풀지 않고 비교해 U+0000 id가 빠지거나 겹칠 수 있었다. raw 열을 읽고 `originalText`를 쓰도록 고쳤다. 회귀 시험 `links distinct NUL and literal U+FFFD message identities to their own messages`.
- medium / patch — `linkAttachments`가 수집의 세션 advisory key를 쓰지 않아 빈 자리에 동시에 연결하면 진 쪽 file·location 행이 남을 수 있었다. 같은 세션 key를 쓰도록 고쳤다. 회귀 시험 `serializes concurrent links into an empty slot without keeping the losing file or locations`.

### 2026-10-28 — Review pass
- verdicts: 19 findings — high 0, medium 1, low 11, false 7, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `readFileExtractionState`가 파일·열린 세대·최대 attempt를 세 문장으로 읽어 사이에 커밋된 begin·finish와 섞일 수 있다 — 실제로 가능하지만 한 파일의 살아 있는 청구자는 하나이고, 상태를 바꾸는 쓰기는 모두 파일 행 잠금 뒤에서 다시 읽는다. SQLite 기준 구현도 같은 세 문장이다. 고치려면 읽기 트랜잭션·문장 재구성이 필요해 직접 수정이 아니다.
  - `[low]` `[reject]` (blind) `listFilesWithStaleExtraction`의 id 목록과 집계가 두 문장이라 같은 파일이 양쪽에 셀 수 있다 — SQLite 구현이 주석으로 밝힌 의도된 두 문장 설계이고, 드문 경합에서 보고 숫자 하나가 어긋나는 정도다. 수정은 문장 재구성이다.
  - `[false]` `[reject]` (blind) 다른 세대의 조각 id를 다시 쓰면 PK 충돌이 `DB_UNAVAILABLE`로 나온다 — 조각 id는 호출자가 새로 만드는 UUIDv7이고, Core `checkExtractionChunkBatch` 주석도 세대를 넘는 재사용을 호출자 버그로 본다. 닿지 않는 상황에서 값으로 크게 실패하는 것은 올바른 동작이다.
  - `[false]` `[reject]` (blind) `ordinal`·`page`가 2^31 이상이면 PG `integer`가 거부한다 — 실제 추출기가 그런 값을 만들 경로가 없고(배치 상한·문서 크기 상한), 거부도 throw가 아닌 `DB_UNAVAILABLE` 값이다. 열 타입은 티켓 2 baseline이다.
  - `[low]` `[patch]` (blind) `finishExtraction`이 `outcome.error`의 U+0000을 그대로 넣어 22021로 실패하고 세대가 `failed`로 닫히지 못한다 — `failure.message`가 그대로 들어오는 경로(`core/src/files/extract-work.ts:331`)를 확인했다. `pgText(outcome.error).text`로 저장하도록 고치고 시험을 더했다.
  - `[low]` `[reject]` (blind) append마다 그 세대의 조각 id·ordinal을 모두 읽어 큰 문서에서 작업량이 늘어난다 — 문서 크기 상한 안에서 조각 수가 제한되고 SQLite 구현과 같은 방식이다. 200조각 배치는 2초 시험을 통과한다. 수정은 질의 재설계다.
  - `[low]` `[reject]` (blind) U+0000 이름은 `text`와 `text_raw`가 함께 B-tree 키에 들어가 키 크기 한도에 빨리 닿는다 — 표시 이름은 파일 이름 길이라 한도(약 2.7KB)에 닿을 일이 거의 없고, 긴 이름은 raw 없이도 같은 한도를 받는다. 수정은 UNIQUE 재설계다.
  - `[low]` `[reject]` (blind) finish와 새 begin의 실제 동시 경합 시험이 없다 — 결함 주장은 아니다. finish는 append와 같은 "파일 행 잠금 → 세대 다시 읽기" 경로이고 append·begin 경합 시험과 늦은 finish 계약 case가 그 경로를 지난다. 시험 추가는 직접 수정이 아니다.
  - `[false]` `[reject]` (blind) schema 삭제 시험은 연결 거부를 검증하지 않는다 — PG `connect()`는 늘 pool을 돌려주고 연결 오류는 질의에서 나므로, schema 없음과 같은 `try`/`withWrite` 경로로 `DB_UNAVAILABLE` 값이 된다. throw로 새는 경로가 없다.
  - `[low]` `[reject]` (blind) `appendExtractionChunks`·`setFileSourceUnreachable`의 `DB_LOCKED` 시험이 없다 — 두 verb도 같은 파일 행 잠금과 `withWrite`·`databaseFailure` 분류를 쓰고, 그 경로는 begin·finish 시험이 증명한다. 같은 증명을 반복하는 시험이다.
  - `[low]` `[reject]` (edge) `readFileExtractionState` 비원자 읽기 — 위 blind 첫 줄과 같은 지적·같은 근거.
  - `[false]` `[reject]` (edge) `ordinal`·`page` 2^31 — 위 blind 넷째 줄과 같은 지적·같은 근거.
  - `[low]` `[reject]` (edge) `listFilesWithStaleExtraction` 두 문장 — 위 blind 둘째 줄과 같은 지적·같은 근거.
  - `[low]` `[patch]` (verification-gap) PG `readFileSharing`의 `count(distinct message_id)` 정상 응답을 단언하는 시험이 없다(file-redaction 계약은 PG에서 아직 안 돈다) — 같은 파일의 첨부 3개·메시지 2개를 수집해 `fileId`·`contentHash` 둘 다 `messages: 2`를 단언하는 시험을 더했다.
  - `[medium]` `[patch]` (verification-gap) 재청구되지 않은 본인 소유 만료 청구의 `beginExtraction` 거부가 검증되지 않는다 — `startedAt`을 만료 시각 이후로 둔 본인 청구가 `CLAIM_LOST`이고 세대가 생기지 않음을 단언하는 PG 시험을 더했다.
  - `[false]` `[reject]` (intent) 동시 begin 시험은 두 worker가 각자 청구하는 전체 경로가 아니라 같은 유효 청구를 쓴다 — 실제 청구는 `FOR UPDATE SKIP LOCKED`로 한 프로세스만 얻으므로(티켓 3), 같은 청구로 두 begin을 겹치는 것이 Store의 "진행 중 세대 하나"를 가장 세게 시험한다. 결함 없음.
  - `[low]` `[reject]` (intent) finish와 begin의 동시 경합 시험이 없다 — 위 blind 여덟째 줄과 같은 지적·같은 근거.
  - `[false]` `[reject]` (intent) 되읽기가 PG 재시작 뒤가 아니라 새 pool이다 — `text` 열은 서버가 값을 다시 만들지 않으므로 재시작이 바이트를 바꿀 경로가 없고, 새 pool은 새 연결·새 세션에서 같은 문자열을 확인한다.
  - `[false]` `[reject]` (intent) 실제 첨부 → 추출기 → PG → 조회의 제품 경로 전환이 없다 — 의도는 Store verb와 계약이며, 명령·데몬의 PG 전환은 에픽의 티켓 7·10 범위다.

### 2026-10-28 — Review pass
- 후속 검토: 기존 `built` 구현을 baseline부터 네 렌즈로 다시 확인했다. 기존 판정은 같은 위치·같은 주장에 한해 승계했다. 티켓 상태와 기존 원장은 수정하지 않았다.
- verdicts: 21 findings — high 0, medium 4, low 11, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) `readFileExtractionState`의 세 문장 사이 상태 혼합 — carried: 기존 첫 판정과 같은 코드·주장이다. 쓰기는 파일 잠금 뒤 재조회하며, 드문 읽기 경합을 고치려면 질의 재구성이 필요하다는 기존 근거를 유지한다.
  - `[low]` `[reject]` (blind) 이름·위치 조회의 `id::text`가 UUID 인덱스를 직접 쓰지 못한다 — 실제 cast 비교이며 blob 삭제 작업자의 위치 조회 비용이 커질 수 있다. 현재 규모에서 병목은 확인되지 않았고, 공유 계약의 비UUID 미존재 응답을 지키려면 입력 분기와 여러 질의를 바꿔야 하므로 드문 규모 문제에 대한 직접 수정이 아니다.
  - `[low]` `[reject]` (blind) NUL 이름의 raw 포함 UNIQUE가 긴 이름에서 B-tree 한도에 닿는다 — carried: 같은 마이그레이션·같은 주장이다. 일반 파일 이름에서는 드물고 UNIQUE 재설계가 필요하다는 기존 판정을 유지한다.
  - `[false]` `[reject]` (blind) 비UUID 추출 식별자가 SQLite의 미존재 응답과 다르다 — PostgreSQL 식별자는 UUID이고 실제 추출 작업자는 저장된 파일 id와 `idGen.next()`로 만든 세대 id를 전달한다. 추출 공유 계약의 미존재 id도 UUID다. 실제 호출 경로에서 비UUID가 발생한다는 결함 주장은 성립하지 않는다. 첨부 계약이 명시한 비UUID 위치 응답은 별도로 그대로 통과한다.
  - `[medium]` `[patch]` (blind) 청구 변경과 begin 사이 `for share` 보호의 경합 검증 부족 — 청구 재할당·완료 각각을 미커밋 상태로 잡고 begin의 Lock 대기를 확인한 뒤 커밋한다. 두 경우 `CLAIM_LOST`와 기존 파일·세대·조각 전체 보존을 단언하는 시험 2개를 추가했다.
  - `[low]` `[reject]` (blind) finish와 begin의 실제 동시 경합 시험 부재 — carried: 기존 blind·intent 판정과 같은 위치·주장이다. append 경합과 늦은 finish 계약이 있는 상태에서 추가 시험은 직접 결함 수정이 아니라는 기존 판정을 유지한다.
  - `[medium]` `[patch]` (blind) 서로 다른 파일의 독립적인 추출 진행 검증 부족 — 파일 A begin의 파일 행 Lock 대기를 확인한 채 파일 B의 begin·append·finish 성공과 A의 계속된 대기를 단언한다. 전체 추출을 직렬화하는 잠금 회귀를 잡는 시험을 추가했다.
  - `[medium]` `[patch]` (blind) 가린 파일의 추출 분기 검증 부족 — 소유자 연결의 `set local brain.redacting`으로 열린 세대 실행 중 파일을 가린 뒤 begin·append의 `FILE_REDACTED`, 상태 보존, finish의 `redacted`·`current: false`·조각 삭제·포인터 null을 단언하는 시험을 추가했다.
  - `[low]` `[patch]` (blind) 수집과 첨부 연결 사이 세션 advisory key 공유 검증 부족 — 같은 빈 첨부 자리에 ingest·link를 모두 Lock 대기시킨 뒤 풀어 성공 결과와 승자 첨부·파일·위치만 남음을 단언하는 시험을 추가했다.
  - `[medium]` `[patch]` (blind) begin의 마지막 SQL 실패 후 전체 롤백 검증 부족 — 현재 성공 세대와 열린 세대·조각을 만든 뒤 기존 세대 id를 재사용해 마지막 INSERT에서 PK 위반을 일으킨다. `DB_UNAVAILABLE`과 파일·세대·조각 스냅샷 완전 일치를 단언하는 시험을 추가했다.
  - `[low]` `[reject]` (edge) `readFileExtractionState`의 비원자 읽기 — carried: 기존 edge 판정과 같은 위치·주장이고 코드도 같다. 드문 경합과 질의 재구성 비용에 대한 기존 판정을 유지한다.
  - `[low]` `[reject]` (edge) stale 목록과 제외 집계 사이 쓰기가 끼어드는 현상 — carried: 기존 edge 판정과 같은 두 문장이다. SQLite 기준도 같은 설계이며 보고 숫자의 드문 어긋남이라는 기존 판정을 유지한다.
  - `[false]` `[reject]` (edge) ordinal·page가 2^31을 넘으면 저장 실패 — carried: 기존 동일 판정과 같은 `integer` 열·입력 검사다. 현재 문서·추출 상한의 실제 경로에서는 이 값에 닿지 않는다는 기존 반증을 유지한다.
  - `[low]` `[reject]` (edge) NUL 포함 추출 오류 문장의 원문 손실 — `pgText(outcome.error).text`가 U+FFFD로 치환하며 원문 열은 없어 SQLite와 진단 문장이 달라지는 것은 사실이다. 세대는 정상적으로 닫히고 상태·포인터는 보존된다. 드문 진단 문자열의 차이이며 원문 열·코덱 경로 추가는 직접 수정이 아니므로 거절했다. transcript 원문이나 locator·파일 이름의 손실은 아니다.
  - `[low]` `[reject]` (verification-gap) finish의 잠금 후 재조회 순서 시험 부재 — carried: 기존 blind·intent의 finish/begin 경합 시험 부재와 같은 코드·주장이다. 구체적인 회귀 설명이 추가됐지만 같은 주장에 대한 기존 판정 유지 규칙을 적용해 다시 patch하지 않았다.
  - `[false]` `[reject]` (intent) 두 worker가 독립 청구하지 않고 같은 청구로 begin한다 — carried: 기존 intent 판정과 같은 시험이다. 청구 자체는 티켓 3에서 한 프로세스만 얻으며, 같은 유효 청구의 동시 begin이 Store 불변식을 직접 검증한다는 기존 반증을 유지한다.
  - `[low]` `[reject]` (intent) 늦은 finish는 순차 계약만 있고 실제 begin 경합 시험이 없다 — carried: 기존 intent의 동일 판정을 유지한다. 파일 잠금 뒤 재조회 경로와 순차 계약은 그대로다.
  - `[false]` `[reject]` (intent) locator 바이트 배열 대신 드라이버 문자열을 비교한다 — 티켓의 검증 표면은 DB에서 읽은 문자열과 코덱 문자열의 동일성이다. 정규형 JSON 문자열의 완전 일치를 SQL 반환값으로 단언하므로 요구와 어긋나지 않는다.
  - `[false]` `[reject]` (intent) page 왕복 시험이 직접 SQL의 잘못된 page 삽입을 다루지 않는다 — 티켓은 코덱 page와 저장 사본의 일치를 요구한다. 정상 왕복의 DB page 비교·공유 계약의 잘못된 page 거부·기존 CHECK가 그 요구를 지킨다. 임의 SQL의 모든 변형 거부는 이 왕복 요구가 아니다.
  - `[false]` `[reject]` (intent) 재조회가 서버 재시작 대신 새 pool이다 — carried: 기존 intent의 동일 시험·동일 주장이다. text 저장값의 재구성 경로가 없고 새 연결에서 같은 값을 읽는다는 기존 반증을 유지한다.
  - `[low]` `[reject]` (intent) 모든 추출 문자열의 무손실 보존이라는 넓은 해석과 오류 NUL 치환이 다르다 — 오류 진단에서 치환은 실제다. 티켓이 명시한 locator·파일 이름 보존과는 충돌하지 않고, 드문 오류 원문 보존을 위해 열·읽기 경로를 더하는 것은 직접 수정이 아니다. edge의 같은 진단 손실과 같은 근거로 거절했다.

## Design Notes

**잠금 순서(같은 파일의 추출 쓰기 직렬화):** 모든 추출 쓰기 트랜잭션은 먼저 `select … from brain.files where id = $fileId for no key update`로 파일 행을 잡고, 그 뒤에 세대·조각을 읽고 쓴다. `appendExtractionChunks`·`finishExtraction`은 잠그지 않은 `select file_id from brain.document_extractions where id = $1`로 파일을 알아낸 뒤(`file_id`는 불변) 파일 행을 잡고, 그다음 세대를 다시 읽어 `finished_at`을 판단한다. 그래서 늦은 append·finish는 앞선 begin이 커밋한 닫힘을 보고 `EXTRACTION_CLOSED`가 된다. `for no key update`는 FK 검사의 `key share`와 충돌하지 않아 수집과 막히지 않고, 파일 이름 trigger의 `for share`·다른 추출 쓰기와는 직렬화된다. `beginExtraction`의 청구 검사는 `work_items` 행을 `for share`로 읽어 검사 중 재청구가 끼지 않게 한다(잠금 순서: files → work_items → document_extractions).

**attempt:** 파일 행을 잡은 뒤 `max(attempt)+1`. 같은 파일의 begin이 직렬화되므로 `(file_id, attempt)`·`document_extractions_running_idx` 위반은 정상 경로에서 나오지 않는다. 두 번째 begin은 첫 세대를 `STALE_EXTRACTION_ERROR`·`failed`(조각 있으면 `index`, 없으면 `read`)로 닫고 그 조각을 지운 뒤 새 세대를 연다.

**이름 후보와 NUL:** `listMissingFileNames`의 후보 `text`는 `display_name`(+`display_name_raw`)과 `external` 로컬 locator다. 후보와 `file_names`의 비교는 `(text, text_raw)` 둘 다 `is not distinct from`으로 하고, 반환 전에 `originalText`로 원문을 만든다. `writeFileNames`는 `pgText(n.text)`로 `text`·`text_raw`를 넣는다.

**계약 밖 동시성 시험의 겹침:** 티켓 3처럼 소유자 `pg.Client`가 `begin; select … from brain.files where id=$1 for update`로 잡고, 자식 둘에 `go`를 보낸 뒤 `pg_stat_activity`에서 두 backend가 `wait_event_type = 'Lock'`이 될 때까지 기다렸다가 rollback한다. 두 자식은 같은 `workItemId`·`claimedBy`(유효 청구)와 서로 다른 세대 id·`startedAt`을 받는다.

## Verification

**Commands:**
- `npx --yes pnpm@12 build && npx --yes pnpm@12 exec vitest run --project postgres packages/postgres/test/attachment-extraction.test.ts packages/postgres/test/schema.test.ts` -- expected: 새 계약·계약 밖 시험과 기존 schema 시험 통과
- `npx --yes pnpm@12 exec vitest run --project core --project sqlite` -- expected: 좁힌 계약이 memory·SQLite에서 통과
- `npx --yes pnpm@12 test` -- expected: build·typecheck·전체 시험 통과(OrbStack 켜짐)

**실제 결과(2026-10-28):**
- 구현 세션 보고: `npx --yes pnpm@12 test` 111 files / 3,006 tests 통과, quick 검토 수정 뒤 3,009 tests 통과. 대상 PG·schema 시험 38개 통과, `git diff --check` 통과.
- 조정자 확인(리뷰 전): build 성공, 대상 PG 명령 2 files / 38 tests 통과. `npx --yes pnpm@12 test`는 첫 두 번 각각 1건 실패했다. 확인한 실패는 이번 변경과 무관한 `packages/postgres/test/store.test.ts > ingest > ingest counts messages and tool notes, and nothing else`이고, 원인은 `test/fixture.ts`의 마이그레이션 연결 시간 초과(`Connection terminated due to connection timeout`)다. 이어서 `vitest run` 전체와 `npx --yes pnpm@12 test`가 각각 111 files / 3,009 tests 모두 통과했다. `--project core --project sqlite`는 50 files / 1,465 tests 통과.
- 조정자 확인(리뷰 patch 뒤): 대상 PG 명령 2 files / 41 tests, `--project core --project sqlite` 50 files / 1,465 tests, `npx --yes pnpm@12 test` build·typecheck 성공·111 files / 3,012 tests 모두 통과.
- I/O 매트릭스 7행은 모두 이름 붙은 시험이 있고 위 실행에서 돌아 통과했다(`--reporter=verbose`로 확인).
- 후속 검토 보강 뒤 조정자 확인: build 성공, 대상 PG·schema 2 files / 47 tests, core·sqlite 50 files / 1,465 tests 통과. `npx --yes pnpm@12 test` 첫 실행은 기존 `work-store contract > a kind nobody handles is left alone`의 `test/fixture.ts:7` DB 준비 연결 시간 초과(`Connection terminated due to connection timeout`) 1건으로 실패했다(110 files·3,017 tests 통과). 재실행은 build·typecheck와 111 files / 3,018 tests 모두 통과했다. 이번 변경의 6개 새 시험은 두 전체 실행 모두 통과했다.

## Auto Run Result

- 반환 상태: `built`. 티켓과 계획의 상태 값은 바꾸지 않았고 `tickets.py mark`를 실행하지 않았다. 최종 완료 표시는 오케스트레이터가 자체 검증 후 결정한다. 사람이 결정해야 할 미해결 질문은 없다.
- 구현 요약: 기존 PG 첨부 8 verb·추출 9 verb, 파일 행 잠금에 의한 추출 직렬화, 코덱 locator 문자열 왕복, raw 짝 열을 통한 NUL 파일 이름 보존 구현을 유지했다. 후속 thorough 검토에서는 제품 소스를 바꾸지 않고 검증 공백 5건을 시험 6개로 보강했다.
- baseline 이후 파일별 변경:
  - `packages/postgres/migrations/0001_initial.sql` — `file_names.text_raw`와 raw 포함 UNIQUE.
  - `packages/postgres/src/attachments.ts` — 나머지 첨부 verb, raw 메시지 id 복원, 수집과 같은 세션 advisory key.
  - `packages/postgres/src/extractions.ts` — 추출 9 verb, 파일 행 잠금과 늦은 완료 방어, 오류 NUL 치환.
  - `packages/postgres/src/store.ts` — 첨부·추출 capability 조립.
  - `packages/core/src/testing/contracts/attachment-store.ts`, `extraction-store.ts` — 실제 사용하는 subject capability로 타입 축소, 기존 단언 유지.
  - `packages/postgres/test/attachment-extraction.test.ts` — 공유 계약·locator·동시성·오류 시험과 이번 후속 검토의 청구 재할당·완료, 다른 파일 독립성, 가림 분기, ingest/link 경합, begin 롤백 시험 6개.
  - `packages/postgres/test/fixtures/extraction-worker.mjs` — stdin으로 입력받는 두 프로세스 begin worker.
  - 이 계획 — 이전 기록을 유지하고 후속 검토의 행별 판정·검증 결과를 추가했다.
- 이번 리뷰: blind-hunter·edge-case-hunter·verification-gap·intent-alignment, 총 21건(high 0·medium 4·low 11·false 6·maybe-false 0).
  - patch 5건(medium 4·low 1): 청구 경합, 파일별 독립 실행, 가림 분기, ingest/link 세션 잠금 공유, SQL 실패 원자성 검증. 제품 소스 수정 없이 시험 6개를 추가했다.
  - defer 0건. 기존 deferred-work 원장은 열거나 고치지 않았고 계획의 `deferred: []`도 유지했다.
  - 거절 16건(low 10·false 6): 이전 동일 판정 10건은 carried로 유지했다. 새 low 3건은 인덱스 cast의 규모 의존 비용과 오류 NUL 원문 손실 2건으로, 드문 영향에 비해 질의 분기·원문 열 확장이 필요해 거절했다. 새 false 3건은 실제 호출자의 UUID 식별자, 코덱 문자열 완전 비교, 저장 page 사본 비교가 각각 반증한다. 모든 항목의 개별 근거는 이번 Review Triage Log에 있다.
- 후속 검토 권고: `false`. 후속 패스에서 patch한 high가 없고 구체적으로 남은 미검증 high 위험도 없다. 패치 수는 medium 4·low 1이다.
- 검증: 구현 세션의 해당 파일 33 tests 통과. 조정자의 대상 PG·schema 47 tests, core·sqlite 1,465 tests, 재실행 전체 build·typecheck·111 files / 3,018 tests 통과. `git diff --check`도 통과했다.
- 남은 위험: 전체 PG 시험 중 fixture 연결 시간 초과가 한 번 재현됐다. 변경 밖 DB 준비 경로의 간헐 실패로 기록했으며 기존 원장 상태는 바꾸지 않았다. baseline 0001 변경으로 기존 개발 DB 재생성이 필요하고, 기존 판정의 다중 문장 읽기·긴 이름 인덱스 크기·드문 오류 NUL 치환 제한도 남는다.
- 보강은 기존 구현 세션 `01a18252-5438-77b2-af42-1c21e2dee38d`가 수행했다. 조정자는 소스·시험을 직접 수정하지 않았다. push하지 않는다.
