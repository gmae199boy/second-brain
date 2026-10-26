---
title: '파일 가리기와 첨부 미가림 경고'
type: 'feature'
ticket: '12'
created: '2026-10-26'
status: done
baseline_revision: 'fb827aa8f9a7b0dc0e56c7e516d0f5812ea0f461'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'thorough'
review_source: 'pinned'
lenses_ran: [blind-hunter, edge-case-hunter, verification-gap, intent-alignment]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 첨부 원본·추출 텍스트·이름은 원문으로 저장되지만(마스킹 B), 비밀이 든 파일을 지울 길이 없다. Core `Redaction`은 파일 대상을 표현하지 못하고(I75), `files.redact` 동사·CLI가 없으며, `messages redact`는 그 메시지에 가리지 않은 첨부가 남아도 말하지 않는다. 같은 바이트를 다시 수집하면 지운 블롭이 되살아나는 길도 열려 있다(11의 남은 위험).

**Approach:** Core `files.redact`(SDK `brain.files.redact`)와 CLI `brain files redact <file>`가 잠금 없는 읽기로 그 내용을 공유하는 메시지 수를 확인 게이트 메시지에 보이고, `--yes`면 한 가리기 트랜잭션에서 `redacted_at`·추출 세대/조각/FTS·이름/이름 FTS·메타데이터 삭제·`redactions` 기록·Brain 위치 블롭 삭제 일감을 묶는다. 이름·추출·다시 추출 생성 가드가 가린 파일을 건너뛰는지 검증하고, 수집이 가린 내용의 블롭을 다시 쓰지 않게 하며, `messages redact`가 가리지 않은 첨부를 `ATTACHMENT_NOT_REDACTED`로 알린다.

## Boundaries & Constraints

**Always:**
- **Core `Redaction`(`packages/core/src/domain/redaction.ts`).** `fileId: string | null`을 더하고 `start`·`end`를 `number | null`로 넓힌다. 문서: `messageId`·`toolNoteId`·`fileId` 가운데 정확히 하나, 범위는 `fileId`일 때만 null이고 그 밖은 지금 규칙(0005 `redactions_target_check`·`redactions_range_check`와 같음). `planRedaction`이 만드는 기록은 `fileId: null`. 타입이 넓어져 깨지는 소비자(fake·SQLite insert·계약·출력 codec 등)는 typecheck로 찾아 고친다. 마이그레이션은 없다(0005 스키마가 이미 받음).
- **입력과 게이트(`packages/core/src/files/redact.ts`, 새 파일).** `FilesRedactInput { file: string; confirm?: boolean }`. `file`은 파일 UUIDv7 또는 `sha256:` + 소문자 hex 64자(내용 주소; 사용자가 `shasum -a 256`으로 얻을 수 있음). `checkFilesRedact(input)`은 **형식 검사만**(어긋나면 `USAGE`, 한국어 문장) — 확인 게이트는 여기 두지 않는다. `redactFile(deps, input)` 순서: 형식 검사 → `store.readFileSharing(ref)`(잠금 없음) → 없으면 `FILE_NOT_FOUND` → `confirm !== true`면 `requireConfirmation({ ns: 'files', verb: 'redact', args: { file: input.file } }, <메시지>)` — 메시지는 한국어로 공유 메시지 수와 되돌릴 수 없음과 `--yes`를 말한다(예: "이 파일 내용은 메시지 2개가 함께 씁니다. 가리면 그 모두에서 원본 사본·추출 텍스트·이름이 사라지고 되돌릴 수 없습니다. --yes로 동의하세요."). `retry.args`에 수를 넣지 않는다(`retry_argv`가 플래그로 바꿈). → `store.redactFile(...)`. DB 쓰기는 확인 뒤에만 일어난다.
- **새 오류 코드 `FILE_NOT_FOUND`**(`packages/core/src/codes.ts` `CODES`): exit 1, `retryable: false`, 한국어 meaning·hint(파일 id나 `sha256:` 내용 해시를 확인하라). `packages/core/test/codes.test.ts`의 exit 표와 README `### 오류 코드` 표에 한 줄(`apps/cli/test/readme-codes.test.ts` 통과).
- **`ATTACHMENT_NOT_REDACTED` 설명을 마스킹 B에 맞춘다**(`codes.ts`의 JSDoc과 `WARNING_CODE_MEANINGS`, README `### 경고 코드` 행): 메시지를 가렸지만 그 메시지에 가리지 않고 저장된 첨부 파일이 남아 있다는 뜻, 첨부는 `files redact`로 따로 가린다는 것.
- **Store 능력(`AttachmentStore`에 셋, `packages/core/src/ports/store.ts`).**
  - `readFileSharing(ref: { fileId: string } | { contentHash: string })` → `{ ok: true; file: { id; contentHash; redactedAt: Date | null }; messages: number }` | `FILE_NOT_FOUND` | `DB_UNAVAILABLE`. 잠금 없는 읽기. `messages` = 그 `file_id`를 가진 `message_attachments`의 서로 다른 `message_id` 수.
  - `listRedactedContentHashes(hashes: readonly string[])` → `{ ok: true; hashes: readonly string[] }` | `DB_UNAVAILABLE`. 잠금 없는 읽기, 주어진 것 가운데 `redacted_at`이 있는 파일의 해시. 빈 입력은 빈 답(DB를 열지 않아도 됨).
  - `redactFile({ fileId, plan(current) })` — `redactMessage`처럼 트랜잭션 안에서 부르는 동기 순수 콜백. `current = { file: { id; contentHash; redactedAt }; locations: readonly FileLocationRow[] }`, 콜백 답 `{ redaction: Redaction | null; work: readonly AddWorkInput[] }`. 결과 `{ ok: true; fileId; contentHash; messages; alreadyRedacted: boolean; extractionsRemoved; chunksRemoved; namesRemoved; metadataRemoved; blobDeletesQueued; failuresResolved }` | `FILE_NOT_FOUND` | `DB_UNAVAILABLE` | `DB_LOCKED`.
  - `RedactMessageResult`의 성공에 `unredactedAttachments: number`(그 메시지의 첨부 가운데 `status = 'stored'`이고 파일의 `redacted_at`이 null인 수, 같은 트랜잭션에서 셈).
- **Core 계획 콜백(`files/redact.ts`).** 가리지 않은 파일이면 `redaction = { id: idGen, messageId: null, toolNoteId: null, fileId, start: null, end: null, kind: 'manual', contentHash: file.contentHash, occurredAt: clock, patternVersion: null }`; 이미 가렸으면 `null`. `work` = `ownership === 'brain' && storeKind === 'local' && deletedAt === null`인 위치마다 `blobDeleteWork({ id: idGen, locationId, at: now })`(이미 가린 파일도 — 남은 Brain 사본을 다시 넣는 수리 길; open key로 중복 없음). drive Brain 사본은 epic 8 몫이라 넣지 않는다.
- **SQLite `redactFile`(`packages/sqlite/src/attachments.ts` 또는 새 `files.ts`, `withWrite(..., { redact: true })` 하나).** 순서(FK·0008 trigger 때문에 바꾸지 않는다): 파일·위치 읽기 → 콜백 → (가리지 않았던 파일만) `update files set redacted_at = <occurredAt>, current_extraction_id = null` → 닫힌 세대의 조각 삭제 → 열린 세대(`finished_at is null`)의 조각 삭제(행은 남김 — 그 worker가 `FILE_REDACTED`를 받고 `finishExtraction`이 `redacted`로 닫는다) → 닫힌 세대 행 삭제 → `file_names`·`file_metadata` 삭제(FTS는 0002 trigger) → `redactions` 삽입 → `failures`에서 `target_kind = 'file'`, `target_id = fileId`, `stage = 'document_extract'`, 미해결인 것 `resolved_at` 채움 → `ensureWork(held, w)`로 블롭 일감 → 공유 메시지 수. 이미 가린 파일은 삭제·기록 없이 일감만. 성공하면 `redactMessage`처럼 `pragma wal_checkpoint(TRUNCATE)`(실패 무시).
- **SQLite `redactMessage`**는 같은 트랜잭션에서 `unredactedAttachments`를 센다(`message_attachments` join `files`).
- **fake store(`packages/core/src/testing/fakes/store.ts`)가 파일 가리기를 갖는다.** `redactedAt` 지도와 파일 `redactions` 목록, `metadata` 없음(빈 수 0). 그리고 지금 "fake에는 파일 가리기가 없다"는 자리를 SQLite와 같게 고친다: `beginExtraction`(`FILE_REDACTED`), `appendExtractionChunks`(`FILE_REDACTED`), `finishExtraction`(가린 파일의 `ok` → `redacted`, 조각 삭제, 포인터 그대로), `readFileExtractionState.redactedAt`, `listFilesAwaitingExtraction`(제외), `listFilesWithStaleExtraction`(제외·`redacted` 셈), `listMissingFileNames`·`writeFileNames`(건너뜀). 같은 문장을 쓴 port 문서 주석(`ports/store.ts`)과 계약 머리 주석(`contracts/extraction-store.ts`)도 사실대로 고친다.
- **계약(`packages/core/src/testing/contracts/attachment-store.ts` 또는 새 `file-redaction.ts`를 `contracts/index.ts`에 등록).** fake·SQLite가 함께 지킨다: `readFileSharing`(id·해시 양쪽, 메시지 둘이 공유하면 2, 없는 것 `FILE_NOT_FOUND`), `redactFile` 뒤 조각·세대·이름 목록 빔·`redactedAt`·위치 그대로·일감이 `listOpenWorkTargets({ kind: 'blob_delete' })`에 Brain 위치 id로, 두 번째 호출 `alreadyRedacted: true`·기록 추가 없음, 열린 세대가 있을 때 append `FILE_REDACTED`·finish `redacted`, 가린 뒤 `writeFileNames`가 0행·`listFilesAwaitingExtraction`·`listFilesWithStaleExtraction`의 `fileIds`에 없음, `listRedactedContentHashes`, `redactMessage`의 `unredactedAttachments`(stored 1 → 파일 가린 뒤 0, `missing_at_ingest`는 세지 않음).
- **수집 가드(`packages/core/src/sessions/ingest.ts`).** 바이트가 있는 첨부의 해시를 모아 `files.put` 전에 `listRedactedContentHashes`를 한 번 부르고, 가린 해시는 `files.put`을 부르지 않는다(첨부 행·`IngestAttachment.file`은 지금처럼 만든다 — 행은 가린 파일을 가리킨다). 읽기가 실패하면 지금처럼 넣는다(남은 위험). `IngestSessionDependencies.store`의 `Pick`에 추가. spool 재주입은 블롭을 쓰지 않으므로 그대로.
- **SDK·CLI.** `Brain.files: BrainFiles { redact }`(`brain.ts`), Core export(`index.ts`; `second_brain`은 `export *`). CLI `apps/cli/src/commands/files-redact.ts`: `ns: 'files'`, `verb: 'redact'`, `nsDescription`(한국어), `arguments: ['<file>']`, `required: ['file']`, `--yes`, `risk: 'destructive'`, `writes: true`, `drain: false`(messages redact와 같은 이유), `preflight`는 `checkFilesRedact`(형식만, DB 전). data: `file_id`, `content_hash`, `messages`, `already_redacted`, `extractions_removed`, `chunks_removed`, `names_removed`, `metadata_removed`, `blob_deletes_queued`, `failures_resolved`; 한국어 한 줄(절마다 `건`·`개`). `commands/index.ts`에 `messagesRedactCommand` 옆.
- **`messages redact`.** `MessagesRedactData.unredactedAttachments`; CLI data `unredacted_attachments`, 0보다 크면 `warnings: ['ATTACHMENT_NOT_REDACTED']`과 한국어 한 줄, `output` 설명 갱신.
- **문서.** README `messages redact` 절(약 298–318행) 뒤에 `files redact` 절: 내용 단위라 공유 메시지 모두에서 사라짐, 확인 전 공유 수를 보임, `--yes` 없으면 exit 3, 블롭은 다음 drain이 지움, 사용자 원본(`external`)은 그대로, 다시 수집해도 블롭을 다시 쓰지 않음, `messages redact`의 경고. 새 문구는 한국어(출력 언어 시험).
- 시험 경로·내용은 임시 폴더와 중립 값. 절대 홈 경로 금지.

**Never:**
- 마이그레이션·trigger 변경, Postgres 구현, `files show`·`files url`·검색 출력(epic-drive), 고아 블롭 순회(V1 뒤), drive 위치 삭제(epic 8).
- 사용자 파일(`external`)을 읽거나 지우거나 바꾸기, `file_locations` 행 삭제, `files.home_location_id` 변경, 블롭을 DB 트랜잭션 안에서 지우기(일감만 넣음, AD-7).
- `redact` 표시 없는 연결로 `redacted_at`·조각을 고치기, 가리기를 spool로 미루기(`DB_LOCKED`는 그대로 실패).
- `BrainDrainReport`·`queue drain` 출력 모양 변경(`reextract_redacted`는 그대로 둔다 — Design Notes).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 가리기 | 추출된 txt @파일(메시지 둘이 공유, 홈 아래 원본), `files redact <id> --yes` | `redacted_at`, 포인터 null, 세대·조각 0, `document_chunks_fts`·`file_names_fts` MATCH 0, `file_names` 0, `redactions` 1행(file_id, 범위 null, 해시 = 파일 해시), Brain 위치마다 `blob_delete` 일감; data `messages` 2 | — |
| drain 뒤 | 위 다음 `queue drain` | 블롭 없음, Brain 위치 `deleted_at`, `external` 원본 바이트·mtime 그대로, 이름·추출이 되살아나지 않음 | — |
| 확인 없음 | `--yes` 없음 | exit 3 `CONFIRMATION_REQUIRED`, 메시지에 공유 메시지 수, `retry_argv`에 `--yes`; DB 행 그대로 | — |
| 내용 해시로 | `files redact sha256:<hex> --yes` | id로 한 것과 같음 | — |
| 없는 파일 | 형식은 맞고 행 없음 | exit 1 `FILE_NOT_FOUND`, 쓰기 없음 | — |
| 잘못된 인수 | UUIDv7·해시 아님 | `USAGE`(exit 2), DB를 열지 않음 | — |
| 다시 가리기 | 이미 가린 파일 | ok, `already_redacted: true`, 새 `redactions` 없음, 지우지 않은 Brain 위치만 일감 | — |
| 진행 중 추출 | 열린 세대 + 조각 | 조각 삭제·행 남음; worker append `FILE_REDACTED`, finish `ok` → `redacted`, 포인터 null | — |
| 다시 추출 경로 | 가린 뒤 미해결이던 `document_extract` 실패, 버전 상승 drain, `failures retry` | 실패는 가리기가 해소; 새 attempt·일감 없음 | — |
| 재수집 | 블롭 삭제 뒤 같은 transcript 다시(또는 새 메시지에 같은 바이트) | 블롭 다시 안 생김, 첨부 행은 가린 파일을 가리킴 | 가린 해시 읽기 실패면 지금처럼 put(남은 위험) |
| DB 잠김 | 다른 연결이 쓰기 잠금 | `DB_LOCKED`, 아무것도 안 바뀜, 표시·`secure_delete` 내려감 | — |
| 중간 실패 | 트랜잭션 중 주입한 trigger 오류 | 전부 롤백 | 던짐(기존 `withWrite` 관례) |
| 첨부 경고 | stored 첨부가 있는 메시지 `messages redact --yes` | 성공 + `warnings: ['ATTACHMENT_NOT_REDACTED']`, `unredacted_attachments` 1; 파일을 가린 뒤엔 경고 없음; `missing_at_ingest`만 있으면 경고 없음 | — |

</intent-contract>

## Code Map

- `packages/core/src/domain/redaction.ts` -- `Redaction`(`fileId` 없음, 범위 non-null). `domain/redact-plan.ts`가 기록을 만든다.
- `packages/core/src/messages/redact.ts` -- 검사·게이트·Store 콜백 본보기(`checkMessagesRedact`, `redactMessage`). 새 `files/redact.ts`는 이 모양이되 게이트를 Store 읽기 뒤에 둔다.
- `packages/core/src/envelope.ts:163-189` -- `requireConfirmation`, `CONFIRM_ARG`(주석이 이미 `files redact`를 게이트 동사로 든다). 실패 엔벨로프에는 `data`가 없어 수는 `message`로만 간다(`errorEnvelope` :121-153).
- `packages/core/src/codes.ts` -- `WARNING_CODES` :60·meaning :105(`ATTACHMENT_NOT_REDACTED`), `CODES` :159-336(`MESSAGE_NOT_FOUND` :206 본보기). `packages/core/test/codes.test.ts:70-95` exit 표. `apps/cli/test/readme-codes.test.ts`가 README `### 오류 코드`·`### 경고 코드` 표를 양방향 대조.
- `packages/core/src/ports/store.ts` -- `RedactMessageInput/Result` :228-235, `MessageAttachment` :772, `FileLocationRow`·`AttachmentStore` :790-876, `AddWorkInput` :383. fake에 가리기가 없다는 문장 :999-1002, :1163-1165, :1196-1197.
- `packages/core/src/files/blob-delete-work.ts:66-77` -- `blobDeleteWork({ id, locationId, at })`; handler는 `local`·`brain`만 받고 `deletedAt`이면 즉시 ok.
- `packages/core/src/files/extract-work.ts` -- handler 가드 :280(`redactedAt`이면 세대 안 엶), begin `FILE_REDACTED` :300, append `FILE_REDACTED` → `ok`로 닫아 Store가 `redacted` :432-442, `EXTRACTION_NOT_FOUND`는 실패로 :450. 바꾸지 않는다.
- `packages/core/src/files/file-names.ts` -- 가드는 Store 몫(SQLite `listMissingFileNames` :59,63, `writeFileNames` :77). 바꾸지 않는다.
- `packages/core/src/failures/retry.ts:127-145` -- 가린 파일 실패를 `redacted`로 셈. 바꾸지 않는다.
- `packages/core/src/sessions/ingest.ts` -- 의존성 `store` Pick :130-133, 첨부 루프 :399-437(해시 :423, `files.put` :426), `existingAttachmentPositions` :755-784.
- `packages/core/src/brain.ts` -- `BrainMessages`/`Brain` :190-201, 반환 조립 :336(`messages`), `files`·`idGen`·`clock`은 의존성에 있음. `packages/core/src/index.ts:85-96`(Brain 타입), :168(messages redact export).
- `packages/sqlite/src/sessions.ts:141-178` -- SQLite `redactMessage`(콜백·`withWrite({redact:true})`·checkpoint 본보기).
- `packages/sqlite/src/attachments.ts` -- `writeAttachments` :8-33(가린 파일을 보지 않음; 같은 해시면 기존 행·위치 재사용), `listMessageAttachments` :150-168, `listFileLocations` :103-110, `markFileLocationDeleted`의 try/catch(`withWrite` 안 오류 → `DB_UNAVAILABLE`, 11 리뷰).
- `packages/sqlite/src/extractions.ts` -- begin :140-234(`FILE_REDACTED` :154), append :236-303, finish :305-403(가린 파일 `ok` → `redacted`, 그 세대 조각만 삭제, 행이 있어야 함), `behindPredicate` :111-125, 목록 :514-564.
- `packages/sqlite/src/work.ts:96-122` -- `ensureWork(held, input)`(트랜잭션 안에서 씀, open key 멱등). `resolveFailures` :452-480(열 이름).
- `packages/sqlite/src/write.ts` -- `withWrite`; `packages/sqlite/src/connect.ts:74-81,136` 표시와 `brain_redact_allowed`.
- 스키마(읽기만): `0002_files_and_work.sql`(files trigger :318-338, FTS :449-482, `document_extractions`에 삭제 trigger 없음), `0005_identity_and_records.sql:96-149`(`redactions`), `0008_attachment_rules.sql`(조각 삭제 규칙 :45-56, 가린 파일 이름·메타 쓰기 거부 :58-84).
- `packages/core/src/testing/fakes/store.ts` -- `fileRows` :187, `fileLocationRows` :198, `link()` :199-226, `fileNames` :227, `extractions` :237, `documentChunks` :238, `currentExtractions` :239, `sourceUnreachableAt` :240, `addWork` :352-375, `redactMessage` :448-467, 추출 메서드 :733-966, 이름 :503-525.
- 계약: `packages/core/src/testing/contracts/{attachment-store,extraction-store,session-store,index}.ts`(첨부 ingest로 파일 만들기 :9-27, `storedFiles` :86-145, `takeClaim` :148-172). 실행: `packages/core/test/contracts.test.ts:1406,1410`, `packages/sqlite/test/session-store.test.ts:741`, `packages/sqlite/test/extraction-store.test.ts:160-166`.
- 손 Store: `apps/cli/src/doctor/store.ts:41-72`, `apps/cli/test/dispatch.test.ts:1320-1350`.
- CLI: `apps/cli/src/dispatch.ts`(preflight :531은 config·DB 전, 실패 → 엔벨로프 :757-811, `retry_argv`는 인수 이름으로 `<file>` ↔ `args.file`), `apps/cli/src/commands/messages-redact.ts`, `failures-retry.ts:71`(경고 본보기), `commands/index.ts:30-43`.
- 시험 본보기: `packages/sqlite/test/redact.test.ts`(디스크 바이트 :76-84, 롤백 주입 :86-97, 잠금 :108-121, 표시·`secure_delete` 내려감 :70-72), `packages/sqlite/test/extraction-store.test.ts`(`ftsMatches` :151-158, 가린 파일 사례 :306-370), `apps/cli/test/messages-redact.test.ts`(`run`·`seed`·exit 3·`retry_argv`·`assertKoreanLines`, DB 바이트 비교 :84-86), `apps/cli/test/sessions-ingest.test.ts`(`runBrain` :147, `installedHome` :171, `stopPayload` :224, `databaseIn` :321, `chunkMatches` :363, txt @파일 수집 → drain :2637-2706, 블롭 경로 :2590, 쓰기 연결엔 `brain_redact_allowed` 등록 :393).
- `README.md` -- `messages redact` 절 :298-318, 첨부 절 :320-332, 오류 표 :630-657, 경고 표 :659-684.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/redaction.ts`, `packages/core/src/domain/redact-plan.ts` -- `fileId`·범위 null -- I75.
- [x] `packages/core/src/ports/store.ts`, export 파일 -- 세 Store 메서드·결과 타입, `RedactMessageResult.unredactedAttachments`, fake 관련 문서 주석 정정.
- [x] `packages/core/src/codes.ts`, `packages/core/test/codes.test.ts`, `README.md` 표 -- `FILE_NOT_FOUND`, `ATTACHMENT_NOT_REDACTED` 설명.
- [x] `packages/core/src/files/redact.ts`(새), `packages/core/src/brain.ts`, `packages/core/src/index.ts` -- 검사·공유 읽기·게이트·계획·`Brain.files`.
- [x] `packages/core/src/messages/redact.ts` -- `unredactedAttachments` 전달.
- [x] `packages/core/src/sessions/ingest.ts` -- 가린 해시 put 건너뛰기.
- [x] `packages/sqlite/src/attachments.ts`(또는 새 `files.ts`와 `store.ts` 조립), `packages/sqlite/src/sessions.ts` -- `readFileSharing`·`listRedactedContentHashes`·`redactFile`, `redactMessage`의 수.
- [x] `packages/core/src/testing/fakes/store.ts` -- 파일 가리기와 추출·이름 가드.
- [x] `packages/core/src/testing/contracts/*` -- 위 계약 사례(fake·SQLite 둘 다 실행).
- [x] `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` -- 손 Store 메서드.
- [x] `apps/cli/src/commands/files-redact.ts`(새), `apps/cli/src/commands/index.ts`, `apps/cli/src/commands/messages-redact.ts` -- 명령·경고.
- [x] 시험: Core(`files-redact` 단위 — 검사·게이트 메시지·계획의 위치 선택·이미 가린 파일, `sessions-ingest` 가린 해시 put 없음과 읽기 실패 시 put), SQLite(I/O 표의 트랜잭션 줄: 디스크 바이트에 조각 본문·이름 없음, FTS 0, 롤백 주입, `DB_LOCKED`, 진행 중 추출, 재수집 뒤 일감·블롭), CLI(아래 AC).
- [x] `README.md` -- `files redact` 절.

**Acceptance Criteria:**
- Given 설치한 임시 home에서 가짜 `HOME` 아래 txt @파일(본문에 중립 낱말)을 두 메시지에 붙인 transcript를 수집하고 drain해 `ok` 세대·조각·이름이 생긴 상태, when `brain files redact <file id> --json`(확인 없이), then exit 3·`CONFIRMATION_REQUIRED`·메시지에 공유 메시지 수 2가 있고 `brain.db`의 `redacted_at`·조각·이름·일감이 그대로다.
- Given 같은 상태, when `brain files redact <file id> --yes --json` 뒤 `brain queue drain --json`, then `document_chunks_fts`·`file_names_fts`의 MATCH가 그 낱말·이름으로 0건, `file_names`·`document_extractions`·`file_metadata`에 그 파일 행이 없고, `redactions`에 파일 기록 1행, Brain 위치 블롭이 없고 `deleted_at`이 채워졌으며, 홈 아래 원본 파일의 바이트·mtime이 그대로다.
- Given 가린 뒤, when 같은 transcript를 다시 수집하고 `brain queue drain`을 두 번, `brain failures retry --json`, then 블롭이 다시 생기지 않고 이름·세대·조각 행이 0이며 새 `document_extract` 일감이 없다.
- Given 가리지 않은 첨부가 있는 메시지, when `brain messages redact <message> --detected --yes --json`(또는 `--text`), then exit 0이고 `warnings`에 `ATTACHMENT_NOT_REDACTED`, `data.unredacted_attachments`가 1이며, 그 파일을 가린 뒤 같은 명령(다른 글자)은 경고가 없다.
- Given 저장소 전체, when `pnpm build`·`pnpm typecheck`, then 넓어진 `Redaction`과 새 Store 메서드를 모든 구현이 갖춰 통과한다.

## Implementation Notes

- `Redaction`은 `fileId`를 더하고 범위를 `number | null`로 넓혔다. 타입이 넓어져 고칠 곳은 `domain/redact-plan.ts`(`fileId: null`)뿐이었고, SQLite insert는 파일 가리기용 문장을 따로 쓰므로 기존 문장은 그대로다.
- 새 Store 메서드 세 개는 `AttachmentStore`에 올리고 구현은 `packages/sqlite/src/attachments.ts`에 뒀다(새 파일 없이 `store.ts` 조립도 그대로). 결과 타입은 `ports/store.ts`에 있고 `ports/index.ts`에 이름을 한 줄 더해야 `second_brain`에서 보인다(`export *`가 아니다).
- 확인 게이트는 `redactFile`(Core) 안, `readFileSharing` 뒤다. `checkFilesRedact`는 형식만 보므로 CLI preflight에 그대로 쓸 수 있고, 게이트 메시지의 공유 수는 문장으로만 간다(실패 엔벨로프에 `data`가 없고 `retry.args`는 argv가 된다).
- `blobDeletesQueued`는 `plan.work.length`다 — `ensureWork`가 open key에 멱등이므로 "큐에 올라가 있는 수"가 맞고, 이미 열린 행이 있으면 0으로 보고하는 쪽이 오히려 거짓이 된다.
- 이미 가린 파일은 `redacted_at`을 다시 쓰지 않고 삭제·기록·실패 해소도 하지 않는다. 그래서 `resolved_at`에 쓸 시각은 기록(`redaction.occurredAt`)에서만 나오고, 그 갈래에서만 필요하다.
- 열린 세대는 행을 남기고 조각만 지운다. 순서를 정하는 것은 0008의 `document_chunks_delete_rule`이 **아니다** — 가리기 트랜잭션 내내 표시가 올라가 있어 그 규칙은 아예 걸리지 않는다. 정하는 것은 FK뿐이다: `files.current_extraction_id`를 비운 뒤에야 세대 행을 지울 수 있고, 조각은 그 세대 행보다 먼저 가야 한다. 그래서 조각 삭제는 열린·닫힌 세대를 가리지 않는 한 문장이다(리뷰 지적).
- 수집 가드는 첨부 루프를 두 단계로 나눈다: 먼저 바이트와 해시를 모으고(`pending`), 한 번 `listRedactedContentHashes`를 부르고, 그다음에 id를 발행하며 `files.put`을 부른다. 1단계가 id를 하나도 발행하지 않으므로 id 순서는 그대로다. 가린 해시는 `brainLocator(hash.slice(7), bytes)`로 위치를 직접 만든다 — `files.put`이 돌려줄 locator와 같은 값이어서 어댑터의 `on conflict do nothing`이 이미 있는 행을 만난다.
- 바이트 있는 첨부가 없으면 읽기를 아예 부르지 않는다(빈 입력은 Store도 DB를 열지 않는다): hook이 매 턴 도는 경로다.
- `--help`의 예시는 하나만 뒀다. `brain files redact sha256:<hex> …`는 출력 언어 시험에 걸린다 — 자리표시자 `<hex>`가 먼저 빈칸이 되어 `sha256`만 라틴 낱말로 남는다. 두 가지 표기는 `USAGE` 문장과 README가 말한다.
- 재수집 시험의 핵심은 **새 메시지**다. 같은 transcript를 다시 수집하면 `existingAttachmentPositions`가 이미 걸러 주므로 가드를 지워도 통과한다. 그래서 CLI 시험은 세 번째 턴을 transcript에 덧붙여 아직 비어 있는 첨부 자리를 만든다(가드를 끄면 이 시험이 실패하는 것을 확인했다).
- fake의 "파일 가리기가 없다"는 자리를 모두 SQLite와 같게 고쳤고, 같은 문장을 쓴 `ports/store.ts`·`contracts/extraction-store.ts`·`packages/sqlite/test/document-extract.test.ts`의 주석도 사실대로 고쳤다.
- `FILE_NOT_FOUND`를 `CODES`에 더하면 그 코드로 실패하는 모든 자리의 hint·retryable이 생긴다(이전에는 표 밖이라 exit 1·hint 없음). 지금 그 코드를 엔벨로프로 내는 것은 `files redact`뿐이고, 일감 실패의 `failures.code`는 표를 보지 않는다.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 34 findings — high 0, medium 2, low 29, false 3, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) README·게이트 문장·`BrainFiles.redact` JSDoc·`usedFor`가 "이름이 사라진다"고 하지만 지우는 것은 이름 색인(`file_names`+FTS)뿐이고 `message_attachments.display_name`·`source_ref`(0008로 불변)와 `external` 위치 기록은 남는다 — 코드로 확인. 문구를 "검색용 이름"이 사라지고 첨부에 적힌 이름과 사용자 원본 자리는 출처로 남는다로 고쳤다(README에 별도 문단).
  - `[low]` `[patch]` (blind) `messages redact`의 경고 문장이 `<file>`을 얻을 길을 주지 않는다 — 문장만 고쳐 원본의 `shasum -a 256` 값을 `sha256:<값>`으로(또는 파일 id로) 주라고 안내한다(새 data 칸 없음).
  - `[low]` `[patch]` (blind) 성공 문장이 Brain 사본이 다음 drain까지 디스크에 남는다는 것을 말하지 않는다 — 일감이 있으면 "다음 `brain queue drain`이 지운다"는 둘째 줄을 더했다.
  - `[low]` `[patch]` (blind) `UUID_V7`가 대소문자를 가리지 않아 대문자 id가 형식 검사를 통과한 뒤 `FILE_NOT_FOUND` — `fileRef`가 id를 소문자로 바꾸고 Core·CLI 시험 줄을 더했다.
  - `[low]` `[patch]` (blind) port 문서는 `readFileSharing`이 한 읽기라 수가 낡지 않는다고 하지만 SQLite는 두 문장 — 스칼라 하위 질의 한 문장으로 바꿨다.
  - `[low]` `[patch]` (blind) `redactFile`의 순서 근거가 0008 `document_chunks_delete_rule`이라 하지만 표시가 트랜잭션 내내 올라가 있어 그 규칙은 걸리지 않는다 — 확인. SQLite·port 주석을 "FK만 순서를 정한다"로 고치고 조각 삭제를 한 문장으로 합쳤다(열린 세대 행은 그대로 남김).
  - `[low]` `[reject]` (blind) 수집이 한 턴의 첨부 바이트를 두 단계 사이에 모두 붙든다 — 맞다. 다만 transcript가 실은 바이트는 이미 파싱 결과에 있고 늘어나는 것은 디스크 fallback(턴마다 드묾, 각 32 MiB 이하)뿐이며, 고치려면 다시 읽기·스트리밍 분기가 든다.
  - `[low]` `[patch]` (blind) 가린 해시에 Core가 `brainLocator`로 위치를 지어내 어댑터의 주소 규칙에 묶인다 — 지금 두 FileStore 구현(`memoryFileStore`, CLI `localFileStore`)이 같은 식을 써서 해는 없으나 갈라지면 살아 있는 Brain 위치 행이 하나 더 생긴다. port 메서드 대신 시험으로 묶었다(아래 verification-gap 첫 항목과 같은 패치).
  - `[low]` `[reject]` (blind) `listRedactedContentHashes` 실패가 조용히 put으로 넘어간다 — 계획에 적은 남은 위험이다. 그 읽기가 실패하는 때는 대개 DB에 닿지 못할 때라 뒤이은 수집 쓰기가 spool로 가며 `SPOOLED` 경고가 붙는다. 새 경고 코드는 공개 표면을 늘린다.
  - `[low]` `[reject]` (blind) 가리지 않은 파일에 계획이 `redaction: null`을 주면 조용한 성공 — Core의 `planFileRedaction`은 그런 답을 내지 않고, 막으려면 분기가 는다.
  - `[low]` `[reject]` (blind) 계약이 `metadataRemoved > 0`·`failuresResolved > 0`·기록 모양을 확인하지 않는다 — 세 가지 모두 `packages/sqlite/test/file-redact.test.ts`가 실제 스키마로 확인하고, fake에는 `file_metadata`가 없어 계약으로 올리려면 fake 인프라를 키워야 한다.
  - `[low]` `[patch]` (blind) CLI 시험의 내용 해시 주석이 반대 사례를 설명하고, 해시로 가리는 성공 경로가 CLI에서 안 돌며, 빈 단언이 있다 — 주석을 고치고 빈 단언을 지우고, 둘째 home에서 `before.contentHash`로 가려 id로 한 것과 같은 `data`를 확인한다.
  - `[low]` `[patch]` (edge) 대문자 UUIDv7 — 위 대문자 항목과 같은 패치.
  - `[low]` `[reject]` (edge) 이미 가린 파일에도 `--yes` 없는 호출이 동의를 묻는다 — 맞지만 해가 없고(동의 전에는 아무것도 쓰지 않는다는 성질이 그대로), 수리 호출도 일감을 쓰므로 동의 뒤가 맞다.
  - `[low]` `[reject]` (edge) 가리는 순간 진행 중이던 추출이 `FILE_REDACTED`가 아닌 이유(추출기 실패 등)로 즉시 기록되면 그 실패는 해소되지 않는다 — 가리기와 추출기 영구 실패가 같은 순간에 겹쳐야 하는 드문 경합이고, 이미 가린 갈래에서 해소하려면 계획에 시각을 따로 실어야 한다. 남은 위험에 적었다.
  - `[low]` `[reject]` (edge) 바이트를 붙드는 메모리 — blind 항목과 같은 이유.
  - `[low]` `[reject]` (edge) 가린 해시 읽기 실패에 경고 없음 — blind 항목과 같은 이유.
  - `[medium]` `[patch]` (edge) "이름이 사라진다" 주장 — blind 첫 항목과 같은 패치.
  - `[low]` `[patch]` (edge) 삭제 순서 근거 주장 — blind 순서 항목과 같은 패치.
  - `[low]` `[patch]` (verification-gap) 지어낸 locator가 FileStore의 답과 같은지 아무 시험도 비교하지 않는다 — Core 가린 해시 사례를 PNG·평문 두 줄 `it.each`로 바꿔 `memoryFileStore().put(bytes)`의 위치와 같음을 확인하고(PNG 줄은 확장자 분기를 탐; 식을 깨면 실패함을 확인), CLI `read()`에 위치 행 수를 더해 재수집 뒤 그대로임을 확인한다.
  - `[low]` `[patch]` (verification-gap) 공유 수의 `distinct`를 아무 픽스처도 시험하지 않는다 — 계약 픽스처의 첫 메시지에 같은 파일을 ordinal 3으로 한 번 더 붙이고 `messages`가 2로 남음을 확인(행 단위 `unredactedAttachments` 기대값 조정).
  - `[low]` `[patch]` (verification-gap) `files redact`의 성공 텍스트 출력을 그리는 시험이 없다 — 텍스트 모드 성공·이미 가린 실행에 `assertKoreanLines`와 `메시지 2개`·`brain queue drain` 포함 확인을 더했다.
  - `[low]` `[patch]` (verification-gap) 내용 해시 주석이 실제 단언과 다르다 — blind CLI 시험 항목과 같은 패치.
  - `[low]` `[reject]` (verification-gap, other) 바이트를 붙드는 메모리 — blind 항목과 같은 이유.
  - `[low]` `[reject]` (verification-gap, other) `content_hash in (...)`의 바인드 변수 한도 — 한 턴의 첨부 수가 SQLite 한도(32,766)에 닿을 일이 없다.
  - `[low]` `[patch]` (verification-gap, other) CLI 시험의 빈 단언 — 지웠다(CLI 시험 항목과 같은 패치).
  - `[low]` `[patch]` (verification-gap, other) `read()`가 순서 없는 `.get()`으로 한 행만 읽어 중복 위치 행을 못 본다 — 위치 행 수를 세게 했다(locator 항목과 같은 패치).
  - `[false]` `[reject]` (intent-alignment) `file_metadata` 삭제가 손으로 넣은 행으로만 증명되고 메타데이터 FTS가 없다 — 메타데이터를 쓰는 동사는 아직 없고(epic 4.1), 0002에 메타데이터 FTS는 없어 행 삭제가 증명할 수 있는 전부이며 SQLite 시험이 그것을 확인한다.
  - `[low]` `[patch]` (intent-alignment) 계획 I/O 표의 내용 해시 줄이 CLI에서 증명되지 않았다 — blind CLI 시험 항목과 같은 패치.
  - `[false]` `[reject]` (intent-alignment) 공유 시험 인프라인 fake의 의미가 바뀌었다 — 계획이 요구한 SQLite와의 동등이고, fake를 쓰는 85개 시험 파일이 모두 통과해 이름 붙일 해가 없다.
  - `[low]` `[patch]` (intent-alignment) 수집 가드의 locator 결합이 간접으로만 확인된다 — verification-gap locator 항목과 같은 패치.
  - `[false]` `[reject]` (intent-alignment) 티켓이 묻지 않은 실패 해소·이미 가린 갈래·`unredacted_attachments`가 가장 잘 덮였다 — 결함이 아니다(Design Notes의 결정).
  - `[low]` `[reject]` (intent-alignment) 게이트가 DB 읽기 뒤라 `--yes` 없는 호출도 DB를 열고, 이미 가린 파일에도 동의를 묻는다 — Design Notes의 결정이고 해가 없다.
  - `[low]` `[reject]` (intent-alignment) 진행 중 세대 사례가 CLI 수준에는 없다 — 계약(fake·SQLite)과 SQLite 시험이 덮고, CLI로 재현하려면 drain 도중 가리기를 끼워 넣는 경합 장치가 필요하다.

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) **확인 게이트는 Core 동사 안, 공유 읽기 뒤에 둔다.** 티켓이 "같은 파일을 공유하는 메시지 수를 확인 전에 보임"을 요구하므로 `--yes` 없는 호출도 config·DB를 연다(읽기만). messages redact처럼 preflight에 게이트를 두면 수를 알 수 없다. 실패 엔벨로프에 `data`가 없어 수는 문장으로 간다.
- Decision(같은 날) **인수는 파일 id 또는 `sha256:` 내용 해시.** 파일 id를 보여 주는 명령(`files show`)은 epic-drive 몫이라 아직 없고, 내용 해시는 사용자가 원본 파일에서 직접 계산할 수 있다. 가리기가 내용 단위이므로 해시가 가장 정직한 이름이다.
- Decision(같은 날) **열린 추출 세대는 행을 남기고 조각만 지운다.** 행을 지우면 worker가 `EXTRACTION_NOT_FOUND`로 실패 시도를 쓰지만, 남기면 기존 Store 규칙(append `FILE_REDACTED`, finish → `redacted`)이 그대로 닫는다. 닫힌 세대는 지운다(티켓: 추출 세대 삭제; 가린 파일은 새 세대를 못 열어 `attempt` 최댓값 보존이 필요 없다).
- Decision(같은 날) **가리기가 그 파일의 미해결 `document_extract` 실패를 해소한다.** 남기면 doctor `failures`가 영영 `warn`이고 `failures retry`가 매번 `redacted`로만 센다. 다른 대상(위치의 `blob_delete`)은 건드리지 않는다.
- Decision(같은 날) **수집은 가린 내용의 블롭을 다시 쓰지 않는다.** 내용 주소라 같은 바이트(붙여 넣은 이미지, 전체 텍스트 @파일)를 다시 읽으면 지운 locator에 블롭이 되살아나고 위치 행은 `deleted_at`이 채워진 채 고아가 된다(11의 남은 위험). 첨부 행은 가린 파일을 가리키게 둔다 — 붙인 사실은 사실이다.
- Decision(같은 날) **`reextract_redacted`는 그대로 둔다.** 가리기가 포인터를 비워 이 칸은 실제 가리기 뒤 늘 0이지만, 없애면 공개 출력이 바뀐다. 포인터가 남은 가린 파일(가리기 트랜잭션은 만들지 않음)에 대한 방어 수로 남는다.
- Decision(같은 날) 블롭 일감은 `local`·`brain`·`deleted_at` null 위치만 넣는다. handler가 drive를 거부하므로 drive Brain 사본은 epic 8이 자기 삭제 길과 함께 넣는다. 파일 가리기 기록의 `kind`는 손으로 요청한 가리기의 기존 값 `manual`.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 새 시험 포함 모두 통과(Docker가 있으면 `pnpm test`).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- **요약:** 파일 가리기를 만들었다. Core `Redaction`이 `fileId`와 null 범위를 받고(I75), 새 동사 `files.redact`(SDK `brain.files.redact`)와 CLI `brain files redact <file>`(파일 UUIDv7 또는 `sha256:` 내용 해시)가 잠금 없는 공유 읽기 뒤 확인 게이트를 열어, `--yes`가 없으면 그 내용을 함께 쓰는 메시지 수를 말하고 exit 3으로 멈춘다. `--yes`면 SQLite 한 가리기 트랜잭션에서 `redacted_at`·포인터 비우기, 추출 세대(진행 중인 세대는 행을 남기고 조각만)·조각·FTS, 이름 색인·이름 FTS·`file_metadata` 삭제, `redactions` 파일 기록, 그 파일의 미해결 `document_extract` 실패 해소, Brain 로컬 사본마다 `blob_delete` 일감(11)을 묶는다. 이미 가린 파일은 남은 Brain 사본만 다시 넣는다. 수집은 가린 내용의 블롭을 다시 쓰지 않는다. fake store가 파일 가리기와 SQLite와 같은 추출·이름 가드를 갖게 되어 새 계약이 fake·SQLite 둘 다에서 돈다. `messages redact`는 같은 트랜잭션에서 가리지 않은 첨부를 세어 `ATTACHMENT_NOT_REDACTED`와 `unredacted_attachments`를 내고, 그 코드 설명을 마스킹 B에 맞췄다. 새 오류 코드 `FILE_NOT_FOUND`. 마이그레이션 없음.
- **바뀐 파일:**
  - `packages/core/src/domain/redaction.ts`, `domain/redact-plan.ts` — `fileId`, null 범위.
  - `packages/core/src/files/redact.ts`(새) — 형식 검사, 공유 읽기, 게이트, 계획(`planFileRedaction`).
  - `packages/core/src/ports/store.ts`, `ports/index.ts`, `index.ts`, `brain.ts` — 세 Store 메서드·결과 타입, `RedactMessageResult.unredactedAttachments`, `Brain.files`, 문서 주석 정정.
  - `packages/core/src/messages/redact.ts` — 가리지 않은 첨부 수 전달.
  - `packages/core/src/sessions/ingest.ts` — 가린 해시의 put 건너뛰기(첨부 루프 두 단계).
  - `packages/core/src/codes.ts` — `FILE_NOT_FOUND`, `ATTACHMENT_NOT_REDACTED` 설명.
  - `packages/sqlite/src/attachments.ts`, `packages/sqlite/src/sessions.ts` — `readFileSharing`·`listRedactedContentHashes`·`redactFile`, `redactMessage`의 수.
  - `packages/core/src/testing/fakes/store.ts` — 파일 가리기와 가드.
  - `packages/core/src/testing/contracts/file-redaction.ts`(새), `contracts/index.ts`, `testing/index.ts`, `contracts/extraction-store.ts` — 계약과 주석.
  - `apps/cli/src/commands/files-redact.ts`(새), `commands/index.ts`, `commands/messages-redact.ts`, `apps/cli/src/doctor/store.ts` — 명령·경고·손 Store.
  - `README.md` — `files redact` 절, 오류·경고 표.
  - 시험: `packages/core/test/{files-redact,sessions-ingest,codes,contracts}.test.ts`, `packages/sqlite/test/{file-redact,session-store,document-extract}.test.ts`, `apps/cli/test/{files-redact,messages-redact,dispatch}.test.ts`.
- **리뷰(thorough, 1회, 렌즈 넷):** 34건 — medium 2·low 29·false 3. 패치 10묶음(medium 1묶음: "이름이 사라진다"는 문구; low 9묶음: 경고 문장 안내, drain 안내 줄, 대문자 UUID, 한 문장 공유 읽기, 순서 근거 주석, locator 시험, CLI 해시 경로·주석·빈 단언, `distinct` 픽스처, 성공 텍스트 시험). 미룸 0. 반려: 바이트 붙듦 메모리(드문 경우, 고침이 분기를 늘림), 가린 해시 읽기 실패 무경고(계획의 남은 위험, DB 불가면 spool 경고가 붙음), 계획 `null` 조용한 성공(Core 계획이 내지 않음), 계약의 메타데이터·실패·기록 확인(SQLite 시험이 덮음), 이미 가린 파일의 게이트(해 없음), 진행 중 추출과 영구 실패의 경합(드묾), 바인드 변수 한도(닿지 않음), CLI의 진행 중 세대(계약·SQLite가 덮음), 그리고 false 셋(메타데이터 FTS는 없음, fake 동등은 계획 요구, 추가 동작은 결함 아님).
- **후속 리뷰 권고:** false — 이 회차 패치는 medium 1묶음·low 9묶음(high 0).
- **검증:** 패치 전후 각각 `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 85개 파일 통과(패치 뒤 2,570개), `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 열세 줄이 모두 실행된 시험에 덮인다(CLI 네 AC 사례와 텍스트 출력 사례, SQLite 트랜잭션·롤백·잠금·진행 중 세대, 계약, Core 게이트·계획·수집 가드).
- **남은 위험:**
  - Postgres 시험은 Docker가 없어 돌리지 않았다(Postgres는 첨부·가리기 Store를 구현하지 않음).
  - 수집의 가린 해시 읽기가 실패하면 지금처럼 블롭을 넣는다 — 가린 내용의 블롭이 위치 행 `deleted_at`이 채워진 채 되살아날 수 있다(V1 뒤 고아 순회가 찾음). 가리기와 put 사이의 짧은 경합도 같다.
  - 가리는 순간 진행 중이던 추출이 추출기 영구 실패로 기록되면 그 실패는 해소되지 않는다(드문 경합; `failures retry`는 `redacted`로 센다).
  - 첨부에 적힌 표시 이름·출처 경로와 사용자 원본 위치 기록은 남는다(0008로 불변) — 문서와 게이트 문장이 이를 말한다.
  - `queue drain`의 `reextract_redacted`는 실제 가리기 뒤 늘 0이다(포인터를 비우므로; 공개 출력이라 그대로 둠).
  - drive Brain 사본은 블롭 일감에 넣지 않는다(epic 8).
