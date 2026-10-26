---
title: '추출 일감과 txt·md 추출기'
type: 'feature'
ticket: '8'
created: '2026-10-26'
status: done
baseline_revision: '6b7648dd1fb2a55e661dafcb276b3f2d7177a9e3'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 첨부 원본은 저장되고(2·4) 추출 세대 Store도 있지만(14), 파일 내용을 읽어 조각으로 만드는 일감이 없다. 저장된 텍스트 문서가 검색할 수 있는 조각이 되지 않고, 추출 실패를 다시 할 길(`failures retry`의 `file`)도 없다.

**Approach:** Core가 소유하는 drain 일감 `document_extract`(대상 `file`)를 둔다. drain이 추출 세대가 없는 파일을 일감으로 넣고, handler가 트랜잭션 밖에서 FileStore로 바이트를 읽어 내용으로 형식을 판정한 뒤 등록된 추출기(V1은 텍스트 하나)로 조각을 만들어 14의 Store로 쓴다.

## Boundaries & Constraints

**Always:**
- 일감: `DOCUMENT_EXTRACT_KIND = 'document_extract'`, `targetKind = 'file'`, `targetId = files.id`. `createBrain`의 `coreHandlers`에 넣는다(`files`는 이미 의존성). 정책은 기본값(`workKindPolicy`).
- 넣기: drain의 `fillFileNames` 다음(마감 전일 때만) `enqueueDocumentExtractions`가 새 Store 읽기 `listFilesAwaitingExtraction({ limit: 500 })`(잠금 없음; `home_location_id` 있음, `redacted_at`·`source_unreachable_at` null, 추출 세대 행이 하나도 없음, file id 순)에서 `listOpenWorkTargets({ kind })`로 열린 일감이 있는 파일을 빼고 `addWork`한다. 이것이 "첨부가 저장되면"이고, 5가 채운 옛 첨부도 같은 길로 들어간다.
- handler 순서: `readFileExtractionState` → 가드(파일 없음·`redactedAt`·`sourceUnreachableAt`이면 세대를 열지 않고 `{ ok: true }`, 실패 해소 안 함) → `beginExtraction`(id·`startedAt`은 idGen·clock, claim은 `{ workItemId: item.id, claimedBy: item.claimedBy }`) → 크기 > `DOCUMENT_EXTRACT_MAX_BYTES`(8 MiB, Core 상수)면 읽지 않고 `too_large` → `files.get(home)` → `contentHashOfBytes(bytes) === contentHash` 확인 → 추출기 판정(첫 `detect`가 null이 아닌 것) → 추출 → `writeExtractionChunks` → `finishExtraction`.
- 결과 분류(아래 I/O 표와 같음):
  - `ok`·`unsupported`·`too_large`로 닫힘 → `{ ok: true }`, 그 파일의 `document_extract` 실패를 `resolveFailures`. `ok`는 `mediaType`, `indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID`.
  - get이 `FILES_UNAVAILABLE`(읽기 위치에 잠시 닿지 못함) → `failed`(`read`), handler 결과 `retryable: true`(AD-21 일시 오류).
  - get이 `FILE_NOT_FOUND`·`LOCATION_REFUSED`, 또는 `home` null(원본에 닿을 수 없음) → `failed`(`read`) 닫기, `setFileSourceUnreachable(now)`, 결과 code `FILE_SOURCE_UNREACHABLE`·`retryable: false`. 기존 성공 세대·조각·포인터는 그대로.
  - 해시 불일치 → `failed`(`read`), code `FILE_CONTENT_MISMATCH`, `retryable: false`(손상). 추출기 실패 → `failed`(`extract`), code `EXTRACTION_FAILED`, `retryable: false`. 조각 쓰기 실패 → `failed`(`index`), Store의 code 그대로.
  - Store 호출의 `DB_UNAVAILABLE`·`DB_LOCKED`는 그 code를 그대로 돌려준다(drain이 release; 열린 세대는 다음 begin이 닫음). `CLAIM_LOST`·`EXTRACTION_CLOSED`·`EXTRACTION_NOT_FOUND`는 그 code의 실패로 돌려준다(drain의 마무리 verb가 `lost`로 셈). 조각 쓰기의 `FILE_REDACTED`면 `ok`로 닫아 Store가 `redacted`로 정리하게 하고 `{ ok: true }`.
  - 불변식: 가린·닿을 수 없는·없는 파일이 아니면, 일감을 닫는 모든 경로가 세대 행을 남긴다(아니면 다음 drain이 같은 파일을 또 넣는다).
- 추출기 등록 자리(`files/extractors.ts`): `DocumentExtractor { name; detect(bytes): string | null /* media type */; extract(bytes, mediaType, params: DocumentChunkParams): Promise<{ ok: true; pieces: readonly { body; chunkLocator; page }[] } | { ok: false; message }> }`, `DOCUMENT_EXTRACTORS = [textExtractor]`(EXIF·PDF·docx가 텍스트 앞에 얹힘), `DOCUMENT_EXTRACTOR_VERSION = 'doc/1'`(추출기·라이브러리가 바뀌면 올림, AD-24). handler 팩토리는 `extractors`·`extractorVersion`을 선택 인자로 받고(시험용) 기본값을 쓴다.
- 텍스트 추출기(Core 순수 함수, `TextDecoder` 금지 — Core는 `lib: es2024`, `types: []`): 엄격한 UTF-8 디코드(잘못된 순서·overlong·surrogate·U+10FFFF 초과면 텍스트 아님), 앞 BOM 하나 제거, TAB·LF·CR·FF·ESC 밖의 C0 제어 문자(NUL 포함)가 있으면 텍스트 아님. media type `text/plain`(md도). 조각: 코드 포인트 기준 `targetChars` 1200·`overlapChars` 120(`DOCUMENT_CHUNK_PARAMS` Core 상수 = 0002 시드 값), 창 뒤쪽 절반 안의 마지막 LF에서, 없으면 마지막 공백에서, 없으면 그대로 자르고, 다음 시작은 `end - overlap`. 공백뿐인 조각은 내지 않고 `ordinal`은 낸 순서(0부터). locator `{ type: 'text', start, end }`(BOM 뺀 텍스트 기준), `page: null`. 빈 텍스트는 조각 0개로 `ok`.
- `failures retry`: `FAILURE_RETRY_STAGES`에 `document_extract`, `FAILURE_RETRY_KINDS`에 `file` → `DOCUMENT_EXTRACT_KIND`.
- Store 확장(SQLite·fake·`apps/cli/src/doctor/store.ts`·`apps/cli/test/dispatch.test.ts` 손 fake 모두): `FileExtractionState`에 `contentHash`·`sizeBytes`·`home: FileLocation | null`, `ExtractionStore.listFilesAwaitingExtraction`(`{ ok: true; fileIds } | DB_UNAVAILABLE`). `extractionStoreContract`에 두 사례를 더한다.
- 추출 텍스트는 원문 그대로 저장한다(마스킹 B). 새 문구는 한국어.

**Never:**
- 마이그레이션, Postgres, 새 CLI 명령·출력 칸(`BrainDrainReport`·`failures retry` 모양 그대로), 검색·출력 경로, 추출기 버전 상승 다시 넣기·건너뛴 수 보고(10), 파일 가리기(12), PDF·docx·EXIF 추출기, `codes.ts` 표에 새 code 추가(handler 자체 code는 상수로만).
- 확장자·표시 이름으로 형식 판정, DB 트랜잭션 안에서 블롭 읽기, 첨부·추출 텍스트를 spool·로그·실패 문장에 넣기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|---|---|---|---|
| txt·md | @파일 텍스트, drain | 세대 `ok`(`text/plain`, `doc/1`, 설정 id), 조각마다 text locator, 포인터 | — |
| 큰 텍스트 | 200조각 넘음 | 배치 여럿, 모두 한 세대 | — |
| 두 번째 drain | 위 다음 | 새 일감·attempt 없음 | — |
| 이름만 txt인 바이너리 | png 바이트 | `unsupported`, 일감 1회로 닫힘, 실패 행 없음 | — |
| 너무 큼 | size > 8 MiB | `too_large`, get 안 부름 | — |
| 일시 읽기 실패 | get `FILES_UNAVAILABLE` | `failed`(`read`), 일감 재시도(실패 행 없음); 10회 뒤 실패 기록(`file`) | 되살린 뒤 `failures retry` → 새 attempt `ok`, 실패 해소, 옛 세대 정리 |
| 원본 없음 | ok 세대 뒤 블롭 사라짐, 일감 | `source_unreachable_at`, 옛 포인터·조각 그대로, `FILE_SOURCE_UNREACHABLE` 기록 | 다음 drain이 넣지 않음; 일감이 와도 세대 안 엶 |
| 손상 | 바이트 해시 ≠ `content_hash` | `failed`(`read`) | `FILE_CONTENT_MISMATCH` 기록 |
| 추출기 실패 | 시험 추출기 `ok: false` | `failed`(`extract`) | `EXTRACTION_FAILED` 기록 |
| 가린 파일(SQLite) | `redacted_at` 있음 | 넣지 않음; 일감이 와도 세대 안 엶 | — |
| DB 잠김 | begin `DB_LOCKED` | release | 다음 drain |

</intent-contract>

## Code Map

- `packages/core/src/brain.ts` -- `coreHandlers`(handler 등록), `drain()`의 `fillFileNames` 호출 자리(넣기 단계를 그 뒤에), `ingestDependencies.files`.
- `packages/core/src/capture/session-ingest-work.ts` -- `FAILURE_RETRY_STAGES`·`FAILURE_RETRY_KINDS`; `sessionIngestHandler`가 handler 모양·`resolveFailures` 본보기. `failures/retry.ts`는 바꾸지 않는다.
- `packages/core/src/queue/drain.ts` -- `WorkHandlerResult`(`retryable`), `classifyWorkFailure`(`retryable: true` → `transientDelayMs` 15분, 10회 뒤 record; record의 stage = kind, target 그대로).
- `packages/core/src/files/file-names.ts` -- drain 앞 단계 본보기. `files/extraction-chunks.ts` `writeExtractionChunks`(배치 나누기, 그대로 씀).
- `packages/core/src/ports/store.ts:793-1050` -- `AttachmentStore`, `ExtractionStore`·`FileExtractionState`(확장), `listOpenWorkTargets`(:651).
- `packages/core/src/ports/file-store.ts` -- `get` 결과 code 셋. `domain/file.ts` `contentHashOfBytes`·`FileLocation`.
- `packages/core/src/domain/document.ts`(상수 자리), `domain/index-config.ts` `DocumentChunkParams`·`DOCUMENT_CHUNK_INDEX_CONFIG_ID`, `domain/chunk-locator.ts`(읽기만), `domain/sha256.ts`(Core에 TextEncoder가 없는 이유; 손 UTF-8 본보기).
- `packages/core/src/testing/fakes/store.ts` -- `fileRows`(:184, `home`·`sizeBytes`·`contentHash` 있음), 추출 상태(:225, :848 `readFileExtractionState`). `testing/fakes/file-store.ts` `memoryFileStore`.
- `packages/core/src/testing/contracts/extraction-store.ts` -- 계약(파일 행은 첨부 ingest로 만듦; 리터럴 `'document_extract'`는 새 상수로).
- `packages/sqlite/src/extractions.ts:394` `readFileExtractionState`(join `file_locations`로 home), 새 목록 읽기; `attachments.ts` `listMissingFileNames`가 잠금 없는 읽기 본보기.
- `packages/core/src/index.ts`, `domain/index.ts`, `ports/index.ts` -- 공개 export.
- `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts:1320` 근처 -- 손 `Store`에 새 메서드.
- `apps/cli/test/sessions-ingest.test.ts:2395-2425` -- @파일 첨부 transcript를 만드는 본보기(`type: 'attachment'`, `attachment.type: 'file'`). `apps/cli/test/queue-drain.test.ts` -- `brain queue drain` 실행 본보기.
- `packages/sqlite/test/extraction-store.test.ts` -- SQLite에서 `withWrite({redact:true})`로 `redacted_at` 채우기, `document_chunks_fts MATCH` 본보기.
- `README.md` -- drain·`failures retry` 설명 절.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts`, `packages/core/src/testing/fakes/store.ts`, `packages/sqlite/src/extractions.ts`, `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts`, `packages/core/src/testing/contracts/extraction-store.ts` -- 상태 칸 셋과 `listFilesAwaitingExtraction`, 계약 사례(세대 없는 파일만 나오고 begin 뒤·`source_unreachable_at` 뒤 빠짐; 상태의 `contentHash`·`sizeBytes`·`home`) -- handler와 넣기 단계의 입력.
- [x] `packages/core/src/domain/document.ts`(또는 `index-config.ts`) -- `DOCUMENT_EXTRACT_MAX_BYTES`, `DOCUMENT_CHUNK_PARAMS`.
- [x] `packages/core/src/files/text-extractor.ts`(새), `packages/core/src/files/extractors.ts`(새) -- 엄격 UTF-8, 판정, 조각 내기, 등록부·버전 상수.
- [x] `packages/core/src/files/extract-work.ts`(새) -- kind 상수, handler, `enqueueDocumentExtractions`, handler 자체 code 상수.
- [x] `packages/core/src/brain.ts`, `packages/core/src/capture/session-ingest-work.ts`, export 파일 -- 등록, 넣기 단계, retry 표.
- [x] `packages/core/test/text-extractor.test.ts`, `packages/core/test/document-extract.test.ts`(새) -- 조각 규칙(서로게이트 쌍·BOM·overlap·LF 자르기·공백 조각·빈 텍스트·잘못된 UTF-8 각 종류), I/O 표의 SQLite·CLI 밖 줄 전부를 `createBrain`(fake store·fake FileStore, 읽기 실패는 감싼 FileStore)로.
- [x] `packages/sqlite/test/document-extract.test.ts`(새) -- SQLite store + `memoryFileStore` + Core handler로: 조각 본문이 FTS로 찾힘, 가린 파일은 넣지도 열지도 않음.
- [x] `apps/cli/test/sessions-ingest.test.ts`(또는 `queue-drain.test.ts`) -- 아래 첫 AC.
- [x] `README.md` -- drain이 붙인 텍스트 문서를 조각으로 만들고 `failures retry`가 파일 추출도 다시 한다는 한두 문장(출력 언어·README 대조 시험 통과).

**Acceptance Criteria:**
- Given 설치한 임시 home에 txt·md @파일과 이름만 `.txt`인 png @파일을 붙인 transcript, when `brain sessions ingest claude-code --json` 뒤 `brain queue drain --json`, then DB에 두 텍스트 파일의 `ok` 세대와 `chunk_locator`가 `{"type":"text",...}`인 조각이 있고 `document_chunks_fts MATCH`로 본문 낱말이 찾히며, png는 `unsupported`이고 `failures`는 비어 있다.
- Given 같은 설치, when `brain queue drain`을 다시, then 세대·조각 수와 `attempt`가 그대로다.
- Given 저장소 전체, when `pnpm build`·`pnpm typecheck`, then 새 Store 메서드를 모든 구현이 갖춰 통과한다.

## Implementation Notes

- 조각 자르기의 경계는 구분자 **뒤**에서 자른다(`end = lf + 1`). 그래야 이웃 조각의 범위가 겹침만큼만 겹치고 사이에 빈 구간이 없다. "마지막 공백"은 코드 포인트 하나에 `/\s/u`를 걸어 탭·전각 공백까지 센다.
- `writeExtractionChunks`는 빈 목록을 `CHUNK_BATCH_TOO_LARGE`로 돌려주므로 handler는 조각이 0개면 아예 부르지 않고 바로 `ok`로 닫는다(빈 텍스트).
- 추출기 주입은 `createBrain`을 건드리지 않고 `brain.queue.drain({ handlers })` 한 번만의 handler로 넣는다 — 시험용 추출기가 들어가는 자리가 거기다.
- 조각 쓰기가 `CHUNK_INVALID`·`CHUNK_BATCH_TOO_LARGE`로 거부되면 `failed`(`index`)로 닫고 Store의 code를 그대로 돌려준다. `retryable`은 붙이지 않았다(플랜에 정하지 않은 값이라 미분류 백오프에 맡김).
- 넣기 단계가 drain 루프 **앞**이므로, 같은 실행의 `session_ingest`가 만든 파일은 다음 drain에서 읽힌다(Design Notes와 같음). 이 때문에 `apps/cli/test/capture-scan.test.ts`의 두 사례가 두 번째 drain에서 `claimed`를 하나 더 세게 되어 기대값을 고쳤다.
- `file`이 `FAILURE_RETRY_KINDS`에 들어가면서 "다시 할 수 없는 대상 종류" 사례의 대상을 `file` → `message`로 바꿨다(core·cli 양쪽).

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 4 findings — high 0, medium 1, low 3, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` (quick) 넣기 단계가 마감을 한 번만 보고 `addWork`(SQLite에서 각각 쓰기 트랜잭션)를 최대 500번 돌려, 밀린 첨부가 많으면 기회적 drain의 2초 예산을 넘긴다(`files/extract-work.ts`, `brain.ts`) — 형제 루프(identity 후보, `scanTranscripts`)는 매번 마감을 본다. 구현 에이전트가 `enqueueDocumentExtractions`에 `{ deadline }`을 넘기고 `addWork` 앞에서 마감이면 멈추게 했으며, `ENQUEUE_LIMIT` 주석을 "읽기의 상한"으로 고치고 마감이 지나면 넣지 않는 Core 시험을 더했다.
  - `[low]` `[patch]` (quick) `brain.ts`의 넣기 단계 주석이 "앞 단계가 저장한 파일을 이번 실행에서 읽는다"고 하지만 루프 앞의 어떤 단계도 파일을 저장하지 않는다(파일은 루프 안 `session_ingest`가 저장하고 다음 drain이 읽음) — 주석을 사실대로 고쳤다.
  - `[low]` `[reject]` (quick) 텍스트 추출기가 `detect`와 `extract`에서 문서를 두 번 디코드한다(`files/extractors.ts`) — 맞지만 붙이는 텍스트 문서는 작아서 일상에서 느낄 일이 드물고, 고치려면 디코드 결과를 넘기는 캐시나 인터페이스 변경이 필요하다. 8 MiB 상한 안에서는 메모리도 감당된다.
  - `[low]` `[reject]` (quick) AC 1의 "`failures`는 비어 있다"를 CLI 시험이 `target_kind = 'file'`로 좁혀 확인한다(`apps/cli/test/sessions-ingest.test.ts`) — 그 픽스처는 transcript가 하네스 폴더 밖이라 이 스토리와 무관한 `session_identity` 실패를 하나 남긴다(기존 @파일 사례와 같음). 이 스토리의 주장(png·텍스트가 파일 실패 행을 남기지 않음)은 시험이 덮고, 고치려면 플랜 문구나 무관한 픽스처를 바꿔야 한다.

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) 일감은 수집 트랜잭션이 아니라 drain 앞 단계가 넣는다. 이름 채우기(4)와 같은 자리이고, 에픽 전에 수집되어 5가 채운 파일도 같은 질의로 들어간다. hook 경로는 drain을 돌지 않으므로(AD-6) 어느 쪽이든 추출은 다음 drain에서 일어난다.
- Decision(같은 날) `unsupported`·`too_large`는 세대 상태로만 남기고 실패 행을 쓰지 않는다(일감은 첫 시도에서 닫힘). AD-21은 지원하지 않는 형식을 영구 오류로 기록한다고 하지만, V1에서 붙인 파일 대부분은 이미지라 실패 행을 쓰면 doctor `failures`가 늘 `warn`이 된다. 손상·원본 없음·추출기 실패는 실패 행을 쓴다.
- Decision(같은 날) 일시 읽기 실패는 AD-21대로 일감 재시도(15분, 10회)이고, 실패 행은 10회 뒤에 생긴다. 그 뒤 `failures retry`가 새 일감을 넣는다. 매 시도가 `failed`(`read`) 세대를 남기고 다음 성공이 그 행들을 지운다(14).
- Decision(같은 날) md도 `text/plain`이다. 내용으로 md와 txt를 가르는 것은 추측이고 그 구별을 읽는 곳이 없다. 조각 설정은 0002 시드 행과 같은 Core 상수로 쓰고 그 id를 세대에 남긴다(색인 설정을 읽는 Store verb가 없다).
- Decision(같은 날) 크기 상한 8 MiB(텍스트를 코드 포인트 배열로 펴는 비용의 상한). 형식마다 다른 상한은 PDF가 올 때 정한다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 새 시험 포함 모두 통과(Docker가 있으면 `pnpm test`).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- **요약:** Core가 소유하는 drain 일감 `document_extract`(대상 `file`)를 더했다. drain이 이름 채우기 다음에 추출 세대가 하나도 없는 파일(가린·원본에 닿을 수 없는 파일 제외)을 일감으로 넣고(마감 안에서만), handler가 트랜잭션 밖에서 FileStore로 바이트를 읽어 해시를 확인한 뒤 내용으로 형식을 판정하고, 텍스트 추출기(손으로 쓴 엄격 UTF-8, BOM 제거, 코드 포인트 기준 1200자·겹침 120자 조각)로 `text` locator 조각을 만들어 14의 Store로 배치 쓰기한다. 바이너리는 `unsupported`, 8 MiB 초과는 읽지 않고 `too_large`(둘 다 실패 행 없음), 일시 읽기 실패는 `failed`(`read`)와 AD-21 재시도, 원본 없음은 `source_unreachable_at` 표시(옛 조각·포인터 유지)와 `FILE_SOURCE_UNREACHABLE` 기록, 해시 불일치·추출기 실패는 즉시 기록한다. `failures retry`가 대상 종류 `file`을 `document_extract`로 다시 넣고, 성공하면 그 파일의 실패가 해소된다. 추출기 등록부 `DOCUMENT_EXTRACTORS`와 `DOCUMENT_EXTRACTOR_VERSION = 'doc/1'`이 PDF·docx·EXIF가 얹힐 자리다.
- **바뀐 파일:**
  - `packages/core/src/files/extract-work.ts`(새) — kind 상수, handler, 넣기 단계, handler 자체 code 셋.
  - `packages/core/src/files/extractors.ts`(새) — `DocumentExtractor`, 텍스트 추출기 등록, 버전 상수.
  - `packages/core/src/files/text-extractor.ts`(새) — 엄격 UTF-8 디코드와 조각 자르기.
  - `packages/core/src/domain/document.ts` — `DOCUMENT_EXTRACT_MAX_BYTES`, `DOCUMENT_CHUNK_PARAMS`.
  - `packages/core/src/ports/store.ts` — `FileExtractionState`의 `contentHash`·`sizeBytes`·`home`, `listFilesAwaitingExtraction`.
  - `packages/core/src/brain.ts` — handler 등록, 마감이 있는 넣기 단계.
  - `packages/core/src/capture/session-ingest-work.ts` — retry 표의 `document_extract`·`file`.
  - `packages/core/src/testing/fakes/store.ts`, `packages/sqlite/src/extractions.ts`, `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` — 새 Store 칸·메서드.
  - `packages/core/src/testing/contracts/extraction-store.ts` — 상수 사용, 사례 둘.
  - `packages/core/src/{index,domain/index,ports/index}.ts` — export.
  - `README.md` — 첨부 추출, 일감 종류, `failures retry`의 파일.
  - 시험: `packages/core/test/{text-extractor,document-extract}.test.ts`(새), `packages/sqlite/test/document-extract.test.ts`(새), `apps/cli/test/sessions-ingest.test.ts`(AC 1·2), 기대값을 고친 `apps/cli/test/capture-scan.test.ts`·`packages/core/test/{failures,capture-scan}.test.ts`.
- **리뷰(quick, 1회):** 4건 — medium 1·low 1 패치(넣기 단계의 마감 확인, 틀린 주석), low 2 기각(이중 디코드: 작은 문서에서만 쓰이고 고치려면 인터페이스·캐시가 필요; AC 1의 실패 행 범위: 무관한 `session_identity` 실패를 빼고 이 스토리의 주장은 덮임). 미룸 0.
- **후속 리뷰 권고:** false — 패치한 항목은 medium 1, low 1(high 0).
- **검증:** 패치 전후 각각 `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 81개 파일 통과(패치 뒤 2,498개), `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 열한 줄이 모두 실행된 시험에 덮인다.
- **남은 위험:** Postgres 시험은 Docker가 없어 돌리지 않았다(`packages/postgres`는 `ExtractionStore`를 구현하지 않음). 이미지는 `unsupported` 세대로 닫히므로, EXIF 추출기(epic 4의 1)가 오면 그 이미지들을 다시 넣는 길(10의 버전 상승 또는 그 스토리)이 필요하다. 조각 쓰기의 `CHUNK_INVALID`는 `retryable` 없이 미분류 백오프(10회)를 탄다. md와 txt는 둘 다 `text/plain`이다. 텍스트 문서를 두 번 디코드한다(기각한 low).
