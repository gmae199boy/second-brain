---
title: '추출 세대 Store'
type: 'feature'
ticket: '14'
created: '2026-10-26'
status: done
baseline_revision: '214c253a7f159684d471d952414f21341ac01ce1'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 0004·0008이 추출 세대(`document_extractions`)와 조각(`document_chunks`)의 칸과 변경 규칙을 두었고 7이 `chunk_locator` 코덱을 두었지만, 세대를 열고·조각을 쓰고·닫고·포인터를 옮기는 Store 능력이 없다. 8(txt·md 추출 일감)과 10(다시 추출)이 이것 없이는 쓸 수 없다.

**Approach:** Core `ports/store.ts`에 `ExtractionStore` 능력을 더해 `Store` 합성에 넣고, SQLite(`packages/sqlite/src/extractions.ts`)와 fake(`memoryStore`)가 같은 계약 suite(`extractionStoreContract`)를 통과하게 한다. 조각은 상한이 있는 배치 한 번 = 쓰기 트랜잭션 한 번이고, Core 도우미가 큰 조각 목록을 그 배치로 나눈다.

## Boundaries & Constraints

**Always:**
- 능력(이름은 구현이 다듬어도 됨, 모양은 이대로):
  - `beginExtraction({ id, fileId, extractorVersion, startedAt, claim: { workItemId, claimedBy } })` — 한 쓰기 트랜잭션에서: 파일 없음 → `FILE_NOT_FOUND`; `redacted_at` 있음 → `FILE_REDACTED`; 청구 확인(그 work item이 열려 있고(`completed_at` null) `target_kind = 'file'`·`target_id = fileId`·`claimed_by = claimedBy`·`claim_expires_at > startedAt`) 실패 → `CLAIM_LOST`(아무것도 안 바뀜); 열린 세대가 있으면(살아 있는 청구는 지금 이 호출자뿐이므로 만료된 청구의 것) `failed`로 닫고(`finished_at = startedAt`, `error`는 청구 만료를 말하는 한국어, `failed_stage`는 Design Notes의 추정 규칙) 그 조각을 지운 뒤, `attempt = max(attempt)+1`(행 없으면 1)로 새 세대를 연다. 결과 `{ ok: true; extraction; closedStale: DocumentExtraction | null }`.
  - `appendExtractionChunks({ extractionId, chunks })` — `chunks`는 `{ id, ordinal, body, chunkLocator: ChunkLocator, page: number | null }[]`, 길이 1..`DOCUMENT_CHUNK_BATCH_MAX`(200, Core 상수). 한 트랜잭션. 세대 없음 → `EXTRACTION_NOT_FOUND`, 닫힘 → `EXTRACTION_CLOSED`, 파일 가림 → `FILE_REDACTED`, 0개·상한 초과 → `CHUNK_BATCH_TOO_LARGE`(0개도 이 코드), 조각 하나라도 무효(`encodeChunkLocator` 실패, `chunkPageMatches(locator, page)` false — `undefined`는 `null`과 다름, `ordinal`이 0 이상 safe integer가 아님, 배치 안·기존 조각과 `ordinal` 중복) → `CHUNK_INVALID`이고 그 배치는 한 줄도 쓰지 않는다. SQLite는 코덱의 정규형 텍스트와 `page` 사본을 쓴다(FTS는 0002 trigger가 함께 씀).
  - `finishExtraction({ extractionId, finishedAt, outcome })` — `outcome`은 `{ status: 'ok'; mediaType: string; indexConfigId: string | null }` | `{ status: 'failed'; failedStage; error: string; mediaType: string | null }` | `{ status: 'unsupported' | 'too_large'; error: string; mediaType: string | null }`. 세대 없음 → `EXTRACTION_NOT_FOUND`, 이미 닫힘 → `EXTRACTION_CLOSED`(늦게 끝난 옛 시도, 아무것도 안 바뀜). `ok`이고 파일이 가려지지 않았고 이 `attempt`가 현재 세대의 `attempt`보다 크면(현재 없으면 0): 세대를 닫고 → 포인터를 옮기고 → 같은 파일의 다른 닫힌 세대들의 조각을 지우고 → 그 세대 행들을 지운다(원자적, 이 순서여야 0008을 통과). 그 밖의 경우(실패·`unsupported`·`too_large`, 또는 `ok`인데 포인터 조건 불충족): 세대를 닫고(가린 파일의 `ok`는 상태 `redacted`로) 그 세대의 조각을 지우며 포인터는 그대로. 결과 `{ ok: true; extraction; current: boolean }`.
  - `setFileSourceUnreachable({ fileId, unreachableAt: Date | null })` — `files.source_unreachable_at`만 쓴다(세대·조각·포인터 불변). 파일 없음 → `FILE_NOT_FOUND`.
  - 읽기(잠금 없음, 실패는 `DB_UNAVAILABLE`): `readFileExtractionState(fileId)` → `{ fileId, redactedAt, sourceUnreachableAt, currentExtractionId, openExtraction, lastAttempt }`(`lastAttempt`는 행 없으면 0; 파일 없음 → `FILE_NOT_FOUND`), `listExtractions(fileId)`(attempt 순), `listExtractionChunks(extractionId)`(ordinal 순, `chunkLocator`는 디코드한 값, 0004 이전 null 행은 null).
- 쓰기는 `withWrite`(BEGIN IMMEDIATE) 하나로, `DB_LOCKED`는 값; 연결 실패는 `DB_UNAVAILABLE`. 잠금 아닌 쓰기 예외는 기존 관례대로 던진다(`attachments.ts`의 `linkAttachments`와 같음). Store는 id·시각을 만들지 않는다(입력으로 받음, AD-8·13).
- `attempt`는 줄지 않는다: Store가 지우는 세대는 새 현재 세대보다 `attempt`가 작은 닫힌 세대뿐이고, 가린 파일은 새 세대를 열지 않는다.
- fake는 같은 규칙(FTS 없음)을 지킨다. 계약 suite가 SQLite와 fake에 같이 돈다.
- 0008의 trigger를 지키는 순서로 쓴다(포인터 이동 → 옛 조각 삭제; 세대 닫기 → 실패 조각 삭제). 가리기 표시(`redact: true`)는 쓰지 않는다.

**Never:**
- 마이그레이션 추가·수정, Postgres, 추출 일감 kind·handler·추출기·형식 판정(8), `failures retry`·버전 상승 drain(10), 파일 가리기 트랜잭션(12), 검색 질의 API(epic-drive), CLI 출력·README.
- `chunk-locator.ts` 코덱 규칙 변경, 0008·0004 trigger 우회(가리기 표시로 지우기 등).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| 첫 세대 | 파일 하나, 살아 있는 청구 | attempt 1, 열림 | — |
| 성공 교체 | 1 ok(현재) → 2 begin·조각·ok | 포인터 2, 세대 1 행·조각·FTS 없음 | — |
| 삭제 뒤 단조 | 위 다음 begin | attempt 3 | — |
| 실패 정리 | 3에 조각 쓰고 `failed`(`chunk`) | 3은 `failed`+단계, 조각·FTS 없음, 포인터 2 | — |
| 만료 회수 | A 청구로 열린 세대(조각 있음), 청구 만료 뒤 B 청구로 begin | 옛 세대 `failed`(`index`), 조각 없음, 새 attempt = 옛+1, 열린 세대는 하나 | — |
| 잃은 청구 | 만료된 A가 다시 begin | 아무것도 안 바뀜 | `CLAIM_LOST` |
| 늦은 작은 시도 | A가 닫힌 세대에 조각 쓰기·`ok` | 포인터·조각 그대로 | `EXTRACTION_CLOSED` |
| page 사본 | pdf page 4 + `page: 5`; text + `page: 4`; text + `undefined`; text + `null` | 앞 셋 거부(배치 전체 안 씀), 마지막 통과 | `CHUNK_INVALID` |
| 무효 locator·중복 ordinal | text `start > end`; 같은 ordinal 두 번 | 거부 | `CHUNK_INVALID` |
| 배치 크기 | 0개, 201개 | 거부 | `CHUNK_BATCH_TOO_LARGE` |
| 영구 실패 | `unsupported`/`too_large` 닫기 | 포인터 그대로, 조각 없음 | — |
| 원본 접근 불가 | ok 세대 뒤 표시·해제 | 시각 기록·null, 포인터·조각 그대로 | — |
| 없는 대상 | 모르는 file·extraction id | 거부 | `FILE_NOT_FOUND`/`EXTRACTION_NOT_FOUND` |
| 가린 파일(SQLite만) | `redacted_at` 있는 파일에 begin | 거부 | `FILE_REDACTED` |

</intent-contract>

## Code Map

- `packages/core/src/ports/store.ts:736-740` -- `Store` 합성(여기에 `ExtractionStore`); `:766-792` `AttachmentStore`의 짧은 결과 타입 모양을 본뜬다. `:376-475` work 입력(청구 모양).
- `packages/core/src/ports/index.ts:85`, `packages/core/src/domain/index.ts`, `packages/core/src/index.ts` -- 공개 export.
- `packages/core/src/domain/document.ts` -- `DocumentExtraction`·`DocumentChunk`·`DocumentExtractionStatus`·`DocumentExtractionFailedStage`(7). `DOCUMENT_CHUNK_BATCH_MAX`를 여기에.
- `packages/core/src/domain/chunk-locator.ts` -- `encodeChunkLocator`·`decodeChunkLocator`·`chunkLocatorPage`·`chunkPageMatches`. 읽기만.
- `packages/core/src/domain/index-config.ts` -- 문서 조각 설정. 기본 행 id `019a0000-0000-7000-8000-000000000002`(0002 `index_configs`)의 Core 상수가 없으니 `DOCUMENT_CHUNK_INDEX_CONFIG_ID`로 더한다(계약·8이 씀).
- `packages/core/src/domain/work-item.ts:129` `workKindPolicy(kind).claimForMs` -- 계약에서 청구 만료 시각 계산.
- `packages/core/src/testing/fakes/store.ts` -- `memoryStore`(:138), 파일은 `fileRows`(content hash → `{id,…}`, :162), 큐는 `workItems`(:156). 추출 상태(세대·조각·파일별 포인터·`sourceUnreachableAt`)를 새 맵으로; fake에는 파일 가리기가 없어 `redactedAt`은 늘 null.
- `packages/core/src/testing/contracts/attachment-store.ts` -- 계약 모양과 파일 행 만들기(첨부 ingest) 본보기. `contracts/index.ts`, `testing/index.ts:143-144` export 자리.
- `packages/core/test/contracts.test.ts:1402-1405` -- fake 계약 등록 자리; `failedCases` 도우미(같은 파일)로 잘못된 fake를 계약이 잡는지 보일 수 있다.
- `packages/sqlite/src/attachments.ts` -- 능력 모듈 모양(`connect`, `withWrite`, `describe`). `packages/sqlite/src/write.ts` `withWrite`(held 핸들만 쓸 것). `packages/sqlite/src/store.ts:82-86` 합성.
- `packages/sqlite/migrations/0002_files_and_work.sql:102-130,250-264,448-468` (`files`, `document_chunks`, FTS trigger), `0004_capture_columns.sql:106,154-170,277-317`(`source_unreachable_at`, locator check, 세대 테이블·`document_extractions_running_idx`), `0005`의 `failed_stage` trigger, `0008_attachment_rules.sql:27-56`(세대 불변·조각 삭제 규칙). FK가 켜져 있다(`connect.ts:132`): 세대 행 삭제 전에 조각·포인터를 치운다. 읽기만.
- `packages/sqlite/test/session-store.test.ts:42-58,741` -- `scratch`·`migratedPath`와 계약 등록 본보기.
- `apps/cli/src/doctor/store.ts` -- `failedConfigStore`에 새 메서드(`unavailable`). `apps/cli/test/dispatch.test.ts:1320` -- 전체 `Store` 손 fake에도 같은 줄.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/document.ts`, `packages/core/src/domain/index-config.ts`, `packages/core/src/ports/store.ts`, export 파일들 -- `DOCUMENT_CHUNK_BATCH_MAX`, `DOCUMENT_CHUNK_INDEX_CONFIG_ID`, `ExtractionStore`와 입력·결과 타입, `Store` 합성 -- 8·10이 쓸 약속.
- [x] `packages/core/src/files/extraction-chunks.ts`(새) -- `writeExtractionChunks({ store, extractionId, chunks })`: 상한 크기 배치로 나눠 차례로 쓰고 첫 실패에서 그 결과를 돌려준다(성공이면 쓴 수) -- 2초 규칙의 Core 쪽.
- [x] `packages/core/src/testing/fakes/store.ts` -- 같은 규칙의 fake.
- [x] `packages/core/src/testing/contracts/extraction-store.ts`(새), `contracts/index.ts`, `testing/index.ts` -- I/O 표의 SQLite만 줄을 뺀 전부를 사례로(청구는 `addWork`·`claimWork`로 실제로 만들고 만료는 `claimForMs` 뒤 시각으로).
- [x] `packages/sqlite/src/extractions.ts`(새), `packages/sqlite/src/store.ts` -- SQLite 구현과 합성.
- [x] `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` -- 새 메서드 줄.
- [x] `packages/core/test/contracts.test.ts`, `packages/core/test/extraction-chunks.test.ts`(새) -- fake 계약 등록; 도우미가 450개를 200·200·50으로 나누고 둘째 배치 실패에서 멈춤.
- [x] `packages/sqlite/test/extraction-store.test.ts`(새) -- 계약 등록, 그리고 SQLite만: 실패·만료 회수·교체된 세대의 조각 본문이 `document_chunks_fts MATCH`로 안 찾히고 현재 세대 본문은 찾힘, 저장된 `chunk_locator`·`page`가 코덱 출력과 같음, `withWrite({redact:true})`로 `redacted_at`을 채운 파일에 begin이 `FILE_REDACTED`, 2,000자 본문 200조각 배치 한 번이 2초 안.

**Acceptance Criteria:**
- Given SQLite와 fake, when `extractionStoreContract`를 돌리면, then 둘 다 모든 사례를 통과한다.
- Given 계약의 청구 만료 사례, when 만료된 청구의 늦은 `ok`가 들어오면, then 포인터·현재 조각이 그대로이고 만료된 열린 세대는 다음 청구의 begin에서 `failed`(단계 있음)로 닫혀 있다.
- Given 최신 스키마 SQLite, when 실패한 시도의 조각 본문으로 FTS를 찾으면, then 결과가 없다.
- Given 저장소 전체, when `pnpm build`·`pnpm typecheck`, then 새 `Store` 메서드를 모든 구현이 갖춰 통과한다.

## Implementation Notes

- 구현은 맥락 없는 서브에이전트가 했다(full 경로). 마이그레이션은 한 줄도 건드리지 않았고 Postgres·CLI 출력·README도 그대로다.
- 조각 검사 규칙은 플랜에 없던 한 함수로 모았다: `checkExtractionChunkBatch(chunks, held)`(`packages/core/src/files/extraction-chunks.ts`, `held`는 그 세대가 이미 쥔 `ordinals`·`ids`). 배치 크기·`ordinal`·`id`·locator·`page` 사본 규칙이 fake와 SQLite에 따로 적혀 있으면 두 구현이 갈라질 수 있어서다. 둘 다 이 함수를 부르고 `@second-brain/core`에서 export한다.
- `id` 겹침도 `CHUNK_INVALID`로 거부한다(플랜의 무효 목록에 없던 줄). `document_chunks.id`는 세대를 넘어 unique라, 검사가 없으면 SQLite는 unique로 던지고 fake는 그냥 저장해 두 구현이 갈라진다. fake는 다른 세대가 이미 쥔 id를 만나면 SQLite처럼 던진다(계약은 그 경우를 만들지 않는다).
- `writeExtractionChunks`의 `store`는 `Pick<ExtractionStore, 'appendExtractionChunks'>`다(`sessions/ingest.ts`의 관례). 빈 목록은 조용히 성공하지 않고 store에 빈 배치로 넘겨 `CHUNK_BATCH_TOO_LARGE`를 그대로 전한다 — "0개도 이 코드"가 한 곳에서만 결정된다.
- `appendExtractionChunks`의 거부 순서는 플랜이 적은 순서 그대로다(세대 없음 → 닫힘 → 가림 → 배치 크기 → 무효). 크기·무효 검사는 순수하지만 트랜잭션 안에서 돌아, 빈 배치도 쓰기 잠금을 한 번 잡는다. fake와 SQLite가 같은 코드를 내는 것이 더 중요하다고 보았다.
- SQLite는 배치를 다중 행 `insert` 한 문장으로 쓴다(200행 × 6 파라미터). 상한이 "짧은 트랜잭션 하나"의 상한이어야 해서다. 0002의 FTS trigger는 여전히 행마다 돈다. 측정: 2,000자 본문 200조각 한 배치가 시험 전체로 37ms.
- `finishExtraction`은 `ok`를 가린 파일에 받으면 상태를 `redacted`로 적고 포인터는 움직이지 않는다. `index_config_id`는 포인터를 가져간 `ok`에만 적는다(`ok && replaces`): 조각이 지워질 세대는 어떤 조각 설정이 잘랐는지 남길 것이 없다. fake와 SQLite가 같은 규칙이다.
- 세대·조각·포인터 쓰기 순서는 0008을 지난다: 닫기 → (성공 교체면) 포인터 이동 → 옛 조각 삭제 → 옛 세대 행 삭제, 그 밖에는 닫기 → 자기 조각 삭제.
- fake는 파일 가리기가 없어 `FILE_REDACTED`와 `redacted` 상태를 보일 수 없다. 그 셋은 SQLite 시험에서만 본다(`withWrite({redact:true})`로 `redacted_at`을 채운 뒤 begin·append·finish).
- 계약 음성 가짜 셋을 `packages/core/test/contracts.test.ts`에 더했다: 포인터를 아무 결과에나 옮기는 fake, 만료된 열린 세대를 두는 fake, 배치 상한을 세지 않는 fake — 각각 해당 사례에서 떨어진다.
- 계약의 work kind는 `'document_extract'`를 계약 파일 안에 적었다(8이 그 이름의 handler를 가져온다). `workKindPolicy`에 항목이 없는 kind라 기본 10분 청구창을 쓰고, 계약은 그 값으로 만료 시각을 만든다.
- Postgres 시험은 Docker가 없어 돌리지 못했다. `packages/postgres`는 `HealthStore & SchemaStore`만 구현해 `Store` 합성 변화의 영향이 없다.

- begin이 닫는 세대의 `error`는 '새 begin이 열려 있던 이 세대를 닫았습니다'다. 한 일꾼이 살아 있는 자기 청구로 begin을 두 번 하면 그 세대도 여기서 닫히는데, "청구가 만료되었다"는 그때 거짓이다. fake와 SQLite가 같은 문장을 쓴다.

- 리뷰 패치(2026-10-26): Design Notes의 `failed_stage` 추정 규칙을 세 갈래에서 두 갈래로 줄였다: 조각이 있으면 `index`, 없으면 `read`. 가운데 갈래(`media_type`이 있으면 `extract`)는 닿을 수 없다 — 열린 세대에 `media_type`을 쓰는 verb가 없고(`beginExtraction`은 null로 열고 `finishExtraction`은 닫으면서 쓴다), 그래서 begin이 닫는 세대의 `media_type`은 늘 null이다. 계약에 "조각 없이 닫힌 세대는 `read`" 사례를 더했다. (구현 에이전트가 Plan Change Log에 적었던 것을 코디네이터가 이 절로 옮겼다 — 플랜을 다시 짠 loopback이 아니다.)
- 리뷰 패치(2026-10-26): 만료 사례에서 drain-b의 세대가 `ok`로 닫힌 뒤 drain-a의 늦은 호출은 `EXTRACTION_NOT_FOUND`를 받는다(성공 교체가 drain-a의 닫힌 행을 지웠기 때문). 그 앞의 `EXTRACTION_CLOSED` 단언은 그대로 두어 두 코드를 모두 덮는다.
- 코디네이터 확인(2026-10-26): diff 전체를 읽고 `pnpm build`·`pnpm typecheck`·non-Postgres vitest(78개 파일·2,445개)·`git diff --check`·절대 홈 경로 검사를 패치 전과 후에 각각 다시 돌려 통과했다.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 42 findings — high 0, medium 0, low 36, false 6, maybe-false 0
- findings:
  - `[low]` `[reject]` (blind) 청구 확인이 `work_items.kind`를 보지 않는다 — 오늘은 `target_kind = 'file'`인 다른 kind가 없어(검색 확인) 닿을 수 없고, 고치려면 `ExtractionClaim`에 kind를 더하거나 kind 상수를 정해야 한다(새 표면). 8이 kind를 정할 때 다시 본다(남은 위험에 적음).
  - `[false]` `[reject]` (blind) `document_extract`가 상수 없는 문자열이라 이름이 바뀌어도 시험이 못 잡는다 — 청구 확인이 kind에 기대지 않으므로 이름이 달라도 동작이 같다. 깨지는 결과가 없다.
  - `[low]` `[patch]` (blind) `checkExtractionChunkBatch`가 `chunk.id`를 보지 않아 겹친 id에 SQLite는 던지고 fake는 저장한다 — 배치 안 겹침과 그 세대가 쥔 id를 `CHUNK_INVALID`로 거부, fake는 다른 세대의 id면 던짐, 계약 단언 둘 추가.
  - `[low]` `[reject]` (blind) 빈 배치가 `CHUNK_BATCH_TOO_LARGE`라는 이름 — 플랜 intent가 "0개도 이 코드"로 정했다. 이름을 바꾸려면 플랜을 고쳐야 한다.
  - `[low]` `[patch]` (blind) `index_config_id`를 SQLite는 `ok && replaces`일 때만, fake는 `ok`면 늘 쓴다 — fake를 SQLite 규칙으로 맞춤.
  - `[low]` `[patch]` (blind) 가린 파일의 `ok`가 `redacted`로 닫히는 것을 port 문서가 말하지 않는다 — `finishExtraction`·`FinishExtractionResult` 문서에 `redacted`·`current: false`와 `extraction.status`로 구별함을 적음. (호출자가 구별할 수 없다는 주장은 `extraction.status`가 있어 틀렸고, 문서 누락만 맞다.)
  - `[low]` `[patch]` (blind) 오래된 세대 단계 추정의 `extract` 갈래에 닿을 수 없다 — `index`/`read` 두 갈래로 줄이고 주석을 고침.
  - `[low]` `[reject]` (blind) `readFileExtractionState`가 select 셋이라 한 스냅숏이 아니다 — 드물게 동시에 쓰일 때만 생기고, 고치려면 읽기 트랜잭션이나 질의 재구성이 필요하다.
  - `[low]` `[reject]` (blind) 거부될 배치도 쓰기 잠금을 잡는다 — 플랜이 정한 거부 순서(어댑터 간 같은 코드) 때문이고 잠금은 순수 검사 동안 짧게만 잡힌다.
  - `[low]` `[patch]` (blind) 같은 청구로 begin을 두 번 하면 "청구가 만료되어"라는 거짓 기록이 남는다 — 두 경우 모두 참인 문장 '새 begin이 열려 있던 이 세대를 닫았습니다'로 바꿈(두 어댑터).
  - `[low]` `[reject]` (blind) 배치 상한이 바이트가 아니라 조각 수다 — 조각 크기는 8의 추출기 설정(1,200자)이 정하고, 바이트 상한은 새 규칙·복잡도를 더한다.
  - `[low]` `[reject]` (blind) `MemoryStoreSnapshot`에 추출 상태가 없다 — 지금 그것을 원하는 시험이 없고, port의 읽기 verb로 볼 수 있다.
  - `[low]` `[patch]` (blind) `failedConfigStore` 문서가 추출 능력을 말하지 않는다 — 목록에 추출을 더함.
  - `[low]` `[reject]` (blind) 설정 id 철자가 시험에 남고 없는 `indexConfigId`는 FK로 던진다 — 기존 시험의 리터럴은 이 변경 탓이 아니고, 호출자 버그에 던지는 것은 이 adapter의 관례다.
  - `[low]` `[patch]` (blind) 계약 빈틈(docx, 완료된 work item의 `CLAIM_LOST`, `read` 단계, 거부 우선순위, 목록 비대칭) — `read` 단계 사례와 완료된 work item의 `CLAIM_LOST` 단언을 더함. docx(`page` 규칙은 같은 공유 함수), 우선순위·비대칭 문서화는 쓸모가 낮아 하지 않음.
  - `[low]` `[reject]` (blind) `listExtractionChunks`에 한도가 없다 — 소비자가 아직 없고 페이지를 더하면 표면이 는다.
  - `[low]` `[reject]` (blind) `finishedAt`을 `startedAt`과 비교하지 않는다 — 시각은 같은 Clock에서 오고, 가드를 더하는 일이다.
  - `[low]` `[patch]` (blind) SQLite 시험의 첫 `id()`가 `FILE_ID`와 같고 동기 함수에 `await` — 카운터를 100부터, `await` 제거.
  - `[low]` `[patch]` (edge) 겹친 chunk id — 위 id 패치와 같은 원인, 같은 수정.
  - `[low]` `[reject]` (edge) 다른 kind의 청구로 begin — 위 kind 항목과 같은 원인, 같은 이유로 기각.
  - `[false]` `[reject]` (edge) 청구를 잃은 일꾼이 다음 begin 전에 `ok`로 닫으면 포인터가 옮겨진다 — 그 세대는 아직 열린 유일한 세대이고 결과도 맞는 텍스트다. 다음 청구가 begin하면 attempt가 더 커서 그대로 교체하며, 이미 begin했다면 옛 세대는 닫혀 `EXTRACTION_CLOSED`다. 해가 되는 결과가 없다.
  - `[low]` `[reject]` (edge) 가린 파일의 늦은 `ok` 닫기가 `secure_delete` 없이 조각을 지운다 — 12의 가리기 트랜잭션이 표시를 올리고 secure delete로 그 파일의 조각을 먼저 지우고, 가린 뒤의 조각 쓰기는 `FILE_REDACTED`로 막혀 지울 것이 남지 않는다. 가리기 표시를 여기서 쓰는 것은 플랜이 금한다.
  - `[low]` `[reject]` (edge) 상태 읽기 스냅숏 — 위 스냅숏 항목과 같은 원인.
  - `[low]` `[reject]` (edge) 없는 `indexConfigId`의 FK 오류 — 위 FK 항목과 같은 원인.
  - `[low]` `[patch]` (edge) `extract` 갈래에 닿을 수 없음 — 위 두 갈래 패치.
  - `[low]` `[patch]` (edge) `index_config_id` 어긋남 — 위 fake 맞춤 패치.
  - `[low]` `[reject]` (edge) 2초 벽시계 단언이 붐비는 기계에서 깨질 수 있다 — 실측 24~37ms로 50배 넘게 여유가 있다.
  - `[low]` `[patch]` (edge) fake가 SQLite와 같은 규칙이 아니다(id unique, FK) — id는 위 패치로 맞춤, FK는 위 FK 항목과 같은 이유로 그대로.
  - `[low]` `[patch]` (verification-gap) 오래된 세대의 `failedStage: 'read'`를 단언하는 시험이 없다 — 조각을 쓰기 전에 청구가 만료된 세대가 `read`로 닫히는 계약 사례를 더함.
  - `[low]` `[patch]` (verification-gap) 현재가 되지 못한 `ok`의 `index_config_id`를 아무것도 고정하지 않는다 — SQLite 가리기 시험이 `DOCUMENT_CHUNK_INDEX_CONFIG_ID`를 넘기고 닫힌 세대의 `indexConfigId`가 null임을 단언.
  - `[low]` `[patch]` (verification-gap 기타) `extract` 갈래 — 위 두 갈래 패치.
  - `[low]` `[patch]` (verification-gap 기타) 겹친 chunk id — 위 id 패치.
  - `[low]` `[reject]` (verification-gap 기타) kind 미확인 — 위 kind 항목과 같은 이유.
  - `[low]` `[patch]` (intent) 늦은 작은 attempt의 성공이 포인터가 있는 상태에서 재현되지 않는다 — 만료 사례에서 drain-b가 먼저 `ok`로 포인터를 가진 뒤 drain-a의 늦은 쓰기가 거부되고 포인터가 drain-b의 세대 그대로임을 단언.
  - `[false]` `[reject]` (intent) FTS 확인이 SQLite에만 있다 — fake에는 FTS가 없고, verify의 FTS 문장은 SQLite 시험(`document_chunks_fts MATCH`)이 지킨다.
  - `[low]` `[reject]` (intent) 2초 규칙을 조각 수로 강제 — 위 바이트 상한 항목과 같은 원인.
  - `[false]` `[reject]` (intent) `page` 규칙을 공유 함수 하나가 지킨다 — intent는 두 구현이 모두 거부하기를 요구하고 계약이 두 구현에서 그것을 보인다. 결함이 아니라 같은 규칙을 한 곳에 둔 것이다.
  - `[low]` `[patch]` (intent) 가리기 표면이 한 adapter에만 있다 — 위 port 문서 패치(fake에 가리기가 없음을 문서에 적음).
  - `[low]` `[patch]` (intent) `indexConfigId` 어긋남 — 위 fake 맞춤 패치.
  - `[false]` `[reject]` (intent) 닫히기 전 창에서 청구를 잃은 일꾼의 쓰기 — 위 edge 항목과 같은 반박.
  - `[false]` `[reject]` (intent) 티켓 밖 추가(설정 id 상수, 음성 가짜, 손 fake) — 이름 붙은 해가 없다. 손 fake 줄은 `Store` 합성 때문에 컴파일에 필요하다.
  - `[low]` `[patch]` (intent) 실패 행이 다음 성공에 지워지는 것을 시험하지 않는다 — 실패한 attempt 3 뒤 attempt 4 성공에서 `listExtractions`가 `[4]`, 다음 begin이 5임을 단언.

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) 청구 확인은 `beginExtraction`에서만 한다. work의 열린 행 키가 `(kind, target)`이라 한 파일의 추출 청구는 한 번에 하나이고, 그 청구를 쥔 호출자가 begin하면 남아 있는 열린 세대는 만료된 청구의 것이다(AD-24 "다음 청구가 닫는다"). 늦은 쓰기는 "세대가 닫혔다"로 막혀(`EXTRACTION_CLOSED`) 따로 청구를 확인하지 않는다. 같은 파일의 추출은 한 work kind(8의 `document_extract`)로만 돈다는 것이 전제다.
- Decision(같은 날) 만료로 닫는 세대의 `failed_stage`는 저장된 것으로 추정한다: 조각이 있으면 `index`, 없고 `media_type`이 있으면 `extract`, 아니면 `read`. 진행 단계를 적는 칸이 없다.
- Decision(같은 날) 조각 배치는 Store 호출 한 번 = 트랜잭션 한 번이고 상한 200(AD-24의 예). 상한을 Store가 강제해야 어떤 호출자도 쓰기 잠금을 2초 넘게 쥐지 못한다.
- Decision(같은 날) 성공 교체가 지우는 "옛 세대"는 같은 파일의 다른 닫힌 세대 전부(실패 행 포함)다. 새 현재 세대가 최댓값이라 `max+1`이 줄지 않는다. 실패 세대 행은 다음 성공까지 남아 `failed_stage`를 보인다.

```ts
// 성공 교체 순서 (SQLite, 한 withWrite 안)
update document_extractions set status='ok', finished_at=?, media_type=?, index_config_id=? where id=? and finished_at is null;
update files set current_extraction_id=? where id=?;              // attempt 가드 통과 시
delete from document_chunks where extraction_id in (옛 닫힌 세대);  // 0008: 닫힘·비현재라 통과
delete from document_extractions where id in (옛 닫힌 세대);
```

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 새 시험 포함 모두 통과(Docker가 있으면 `pnpm test`로 Postgres까지).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- **요약:** Core `Store`에 추출 세대 능력 `ExtractionStore`(`beginExtraction`·`appendExtractionChunks`·`finishExtraction`·`setFileSourceUnreachable`와 읽기 셋)를 더하고, SQLite와 fake가 같은 계약 suite(`extractionStoreContract`)를 통과하게 했다. `attempt`는 삽입 트랜잭션의 `max+1`이고 지운 뒤에도 줄지 않으며, 파일당 열린 세대는 하나, 더 큰 `attempt`의 성공만 포인터를 옮기고 옛 세대·조각·FTS를 한 트랜잭션에서 지운다. 실패·영구 실패는 그 세대의 조각을 지우고 포인터를 두며, 청구가 만료된 열린 세대는 다음 청구의 begin이 `failed`(단계 추정)로 닫는다. 조각은 200개 상한 배치 하나 = 트랜잭션 하나이고 Core `writeExtractionChunks`가 큰 목록을 나눈다. `page` 사본은 `===`로 비교해 undefined·불일치를 거부한다.
- **바뀐 파일:**
  - `packages/core/src/ports/store.ts` — `ExtractionStore`와 입력·결과 타입, `Store` 합성.
  - `packages/core/src/domain/document.ts` — `DOCUMENT_CHUNK_BATCH_MAX`.
  - `packages/core/src/domain/index-config.ts` — `DOCUMENT_CHUNK_INDEX_CONFIG_ID`.
  - `packages/core/src/files/extraction-chunks.ts` — 공유 배치 검사 `checkExtractionChunkBatch`와 배치 나누기 `writeExtractionChunks`.
  - `packages/core/src/testing/fakes/store.ts` — 같은 규칙의 fake.
  - `packages/core/src/testing/contracts/extraction-store.ts` — 계약 suite 여섯 사례.
  - `packages/sqlite/src/extractions.ts`, `packages/sqlite/src/store.ts` — SQLite 구현과 합성.
  - `packages/core/src/{index,domain/index,ports/index,testing/index,testing/contracts/index}.ts` — export.
  - `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` — 손 `Store`에 새 메서드 줄.
  - `packages/core/test/contracts.test.ts`, `packages/core/test/extraction-chunks.test.ts`, `packages/sqlite/test/extraction-store.test.ts` — fake·SQLite 계약 등록, 음성 가짜 셋, 배치 나누기, FTS·코덱 철자·가린 파일·2초 배치 시험.
- **리뷰(thorough, 1회, 렌즈 넷):** 42건 — high 0, medium 0, low 36, false 6. 패치 low 항목 묶음 9개(겹친 chunk id 거부, fake `index_config_id` 맞춤, port 문서의 `redacted` 닫기, 단계 추정 두 갈래, 거짓 없는 만료 문장, doctor 문서, 계약 단언 셋(`read` 단계·완료된 work item·포인터가 있는 상태의 늦은 시도·실패 행 정리), SQLite 시험 정리). 미룸 0. 기각: low 15(kind 미확인 ×3, 빈 배치 코드 이름, 상태 읽기 스냅숏 ×2, 거부 배치의 잠금, 바이트 상한 ×2, snapshot 확장, FK 던짐 ×2, 목록 한도, 시각 비교, 가린 늦은 닫기의 secure delete, 2초 벽시계) — 이유는 Review Triage Log의 각 줄; false 6(상수 없는 kind 문자열, 닫히기 전 창 ×2, fake의 FTS, 공유 `page` 함수, 티켓 밖 추가).
- **후속 리뷰 권고:** false — 패치한 묶음이 모두 low(high 0, medium 0, low 9).
- **검증:** 패치 전후 각각 `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 78개 파일·2,445개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 열네 줄이 모두 실행된 시험(계약 여섯 사례 ×2 구현, SQLite 전용 넷)에 덮인다.
- **남은 위험:** Postgres 시험은 Docker가 없어 돌리지 않았다(`packages/postgres`는 `HealthStore & SchemaStore`만 구현). 청구 확인은 `work_items.kind`를 보지 않아, 같은 파일을 대상으로 하는 둘째 work kind가 생기면 두 일꾼이 서로의 열린 세대를 닫을 수 있다 — 8이 `document_extract` kind를 정할 때 claim에 kind를 넣을지 정해야 한다. 늦은 `ok`가 가린 파일에서 조각을 지울 때 secure delete를 쓰지 않으므로, 12의 가리기 트랜잭션이 그 파일의 조각을 먼저 지우는 것에 기댄다. 2초 규칙은 조각 수로만 막고 본문 크기는 8의 추출기 설정에 맡긴다.
