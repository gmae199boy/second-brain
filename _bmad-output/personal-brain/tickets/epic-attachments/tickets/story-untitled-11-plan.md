---
title: '블롭 삭제 일감'
type: 'feature'
ticket: '11'
created: '2026-10-26'
status: done
baseline_revision: '8961c59d76b5ee649da4e1ab74b84556a20a6471'
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

**Problem:** 파일 가리기(10.12)와 epic 8의 Drive 이전은 Brain이 가진 블롭을 지워야 하는데, 블롭 하나를 지우고 그 위치에 `deleted_at`을 남기는 drain 일감이 없다. `FileStore.delete`와 `file_locations.deleted_at`(한 번 채움 trigger, 0002)은 이미 있지만 둘을 잇는 handler와 위치를 읽고 표시하는 Store 능력이 없다.

**Approach:** Core에 `blob_delete` 일감(대상 종류 `file_location`, 대상 id = `file_locations.id`)과 handler를 두고 `createBrain`의 Core handler로 등록한다. handler는 위치 행을 읽어 `local`·`brain` 소유만 받아 `FileStore.delete`(루트·링크 검사는 port 몫)를 트랜잭션 밖에서 부르고, 그 뒤 `deleted_at`을 한 번 채운다. 위치 읽기·목록·표시는 `AttachmentStore`에 더해 SQLite·fake가 계약 테스트로 함께 지킨다. 넣는 쪽(10.12·epic 8)은 이 스토리에서 만들지 않는다.

## Boundaries & Constraints

**Always:**
- **상수·도우미(`packages/core/src/files/blob-delete-work.ts`, 새 파일).** `BLOB_DELETE_KIND = 'blob_delete'`, `FILE_LOCATION_TARGET_KIND = 'file_location'`, `blobDeleteWork({ id, locationId, at }): AddWorkInput`(kind·targetKind 채움, `createdAt`·`nextAttemptAt` = `at`) — 10.12·epic 8이 이것으로 넣는다. `blobDeleteHandler({ store, files, clock })`. Core 공개 export(`packages/core/src/index.ts`)와 `second_brain`에서 보이게 한다.
- **Store 능력(`AttachmentStore`에 셋 추가, `packages/core/src/ports/store.ts`).** `FileLocationRow = { id, fileId, storeKind, locator, ownership, deletedAt: Date | null }`.
  - `readFileLocation(id)` → `{ ok: true; location }` | `FILE_LOCATION_NOT_FOUND` | `DB_UNAVAILABLE`. 잠금 없는 읽기.
  - `listFileLocations(fileId)` → `{ ok: true; locations }`(ownership, locator 순; 없는 파일은 빈 목록) | `DB_UNAVAILABLE`. 10.12가 넣을 위치 id를 찾는 길.
  - `markFileLocationDeleted({ id, deletedAt })` → `{ ok: true; deletedAt: Date; marked: boolean }` — 비어 있을 때만 채우고(`marked: true`), 이미 있으면 그 값을 그대로 돌려준다(`marked: false`, 덮지 않음) | `FILE_LOCATION_NOT_FOUND` | `DB_UNAVAILABLE` | `DB_LOCKED`. 쓰기 트랜잭션(`withWrite`). ownership은 보지 않는다(거부는 handler 몫).
  - fake(`testing/fakes/store.ts`)는 `link()`가 받은 위치 id를 `(fileId, storeKind, locator)`의 첫 id로 보관하고(SQLite의 `on conflict do nothing`과 같게) `deletedAt`을 따로 둔다. 기존 `MessageAttachment.file.locations` 모양은 바꾸지 않는다.
- **handler 순서(바꾸지 않는다):** (1) `readFileLocation`. 없으면 `FILE_LOCATION_NOT_FOUND`, `retryable: false`(위치 행은 지워지지 않으므로 없는 id는 넣는 쪽의 버그). 읽기 실패는 그 코드를 그대로(release 경로). (2) `deletedAt`이 이미 있으면 `FileStore`를 부르지 않고 `{ ok: true }`. (3) `storeKind !== 'local'` 또는 `ownership !== 'brain'`이면 `FileStore`를 부르지 않고 `LOCATION_REFUSED`, `retryable: false`. (4) `files.delete({ storeKind, locator, ownership })`: `LOCATION_REFUSED`(루트 밖·링크·문법 밖) → 같은 코드 `retryable: false`, `deleted_at` 그대로 null; `FILES_UNAVAILABLE` → `retryable: true`; `deleted: false`(이미 없음)도 성공으로 친다. (5) `markFileLocationDeleted({ id, deletedAt: clock.now() })`; 실패는 그 코드를 그대로 돌려 일감이 release되고 다음 drain이 (4)부터 다시 한다(블롭이 없으면 `deleted: false`라 멱등). (6) 성공하면 `resolveFailures({ targetKind: 'file_location', targetId, stage: BLOB_DELETE_KIND, now })`.
- 블롭 바이트는 트랜잭션 밖에서 지운다(AD-7). `FAILURE_RETRY_STAGES`(`capture/session-ingest-work.ts`)에 `blob_delete`를 더해 기록된 실패를 `brain failures retry`로 다시 넣을 수 있게 한다.
- handler·Store가 내는 `FILE_LOCATION_NOT_FOUND`·`LOCATION_REFUSED`는 코드 표(`codes.ts`) 밖의 분류 코드다(`extract-work.ts`의 `FILE_SOURCE_UNREACHABLE`과 같은 이유). 새 문구는 한국어.
- 시험용 바이트·경로는 중립 값, 절대 홈 경로 없음.

**Never:**
- 마이그레이션·trigger 변경(0002의 한 번 채움 trigger로 충분), 새 CLI 명령, 일감을 넣는 경로(10.12의 가리기 트랜잭션, epic 8 이전), 고아 블롭 순회·doctor 건수·바이트 점검(V1 뒤), "이 블롭을 지워도 되는가"(가린 파일인가, 다른 사본이 검증됐는가) 판단 — 넣는 쪽 몫이다.
- `external` 위치나 `drive` 위치의 대상 파일을 읽거나 지우거나 옮기지 않는다. `files.home_location_id`를 바꾸지 않는다.
- `FileStore` port·로컬 구현의 모양·규칙을 바꾸지 않는다. Postgres는 손대지 않는다(이 Store 능력을 구현하지 않는다).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 정상 삭제 | `brain`·`local` 위치, 블롭 있음 | 블롭 사라짐, `deleted_at` 채움, 일감 완료 | 없음 |
| 두 번째 일감 | 같은 위치에 새 일감(앞 일감 완료 뒤) | `{ ok: true }`, `FileStore` 안 부름, `deleted_at` 첫 값 그대로 | 없음 |
| 블롭이 이미 없음 | `deleted_at` null, 디스크에 블롭 없음 | `deleted: false`도 성공, `deleted_at` 채움 | 없음 |
| 표시 쓰기 실패 | 블롭 지운 뒤 `markFileLocationDeleted`가 `DB_UNAVAILABLE`/`DB_LOCKED` | 그 코드로 돌려 release, 다음 drain에서 `deleted: false` → 표시 | 시도 소모 없음(drain 규칙) |
| external 위치 | `ownership: 'external'` | `LOCATION_REFUSED` 즉시 기록, `FileStore` 안 부름 | 사용자 파일 그대로, `deleted_at` null |
| drive 위치 | `storeKind: 'drive'` | `LOCATION_REFUSED` 즉시 기록 | `deleted_at` null |
| 루트 밖 | `brain` 위치지만 locator 문법 밖이거나 블롭 경로가 루트 밖 링크 | port의 `LOCATION_REFUSED` 즉시 기록 | 바깥 파일 바이트·존재 그대로, `deleted_at` null |
| 저장소 일시 장애 | `delete`가 `FILES_UNAVAILABLE` | `retryable: true`(15분 대기) | `deleted_at` null |
| 없는 위치 id | 행 없음 | `FILE_LOCATION_NOT_FOUND` 즉시 기록 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/files/extract-work.ts` -- handler 본보기(의존성 `Pick`, 순서 주석 문체, 자체 분류 코드 상수, `retryable` 사용). 바꾸지 않는다.
- `packages/core/src/queue/drain.ts:33-80` -- `WorkHandler`·`WorkHandlerResult`·`WorkHandlerFailure`; `classifyWorkFailure`(DB 코드 → release, `retryable:false` → 즉시 record).
- `packages/core/src/brain.ts:243-255` -- `coreHandlers`에 `[BLOB_DELETE_KIND]: blobDeleteHandler({ store, files, clock })` 추가(`files`는 이미 `ingestDependencies`/의존성에 있음, `:65`).
- `packages/core/src/capture/session-ingest-work.ts:32` -- `FAILURE_RETRY_STAGES`에 한 줄.
- `packages/core/src/ports/store.ts:793-810` -- `AttachmentStore`(새 세 메서드와 결과 타입, 문서 주석), `:383` `AddWorkInput`, `:580` `ResolveFailuresInput`. `ports/file-store.ts`(읽기만).
- `packages/sqlite/src/attachments.ts` -- `sqliteAttachmentStore`에 세 메서드. 읽기는 `listFileNames` 본보기(connect·try/catch·`describe`), 쓰기는 `writeFileNames`의 `withWrite` 본보기. `update file_locations set deleted_at = ? where id = ? and deleted_at is null` 뒤 다시 읽기. 날짜는 ISO 문자열 ↔ `Date`.
- `packages/sqlite/migrations/0002_files_and_work.sql:144-173, :405-436` -- `file_locations` 칸과 한 번 채움·삭제 거부 trigger(읽기만).
- `packages/core/src/testing/fakes/store.ts:186-213` -- `fileRows`·`link()`(위치 id 보관 자리), `:232` `fileById`.
- `packages/core/src/testing/contracts/attachment-store.ts` -- 새 계약 사례 자리(첨부 ingest로 `brain`·`external` 위치를 만드는 본보기가 첫 사례에 있음). 실행: `packages/core/test/contracts.test.ts:1406`(fake), `packages/sqlite/test/session-store.test.ts:741`(SQLite).
- `packages/core/src/testing/fakes/file-store.ts` -- `memoryFileStore`(`delete`, 거부 규칙). handler 단위 시험에 쓴다.
- `apps/cli/src/doctor/store.ts:56`, `apps/cli/test/dispatch.test.ts:1321` -- 손 `Store`에 새 메서드(`unavailable`).
- `apps/cli/test/sessions-ingest.test.ts:2570` 근처 -- 붙여 넣은 이미지 transcript 만들기, `runBrain(['queue','drain','--json'], home, …)`(:2036) 본보기. `apps/cli/src/runtime/file-store.ts` `localFileStore`(읽기만).
- `packages/core/test/document-extract.test.ts` -- `createBrain` + fake로 drain을 도는 Core 시험 본보기.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/ports/store.ts` -- `FileLocationRow`와 세 메서드·결과 타입 -- 위치를 id로 읽고 한 번 표시.
- [x] `packages/sqlite/src/attachments.ts`, `packages/core/src/testing/fakes/store.ts` -- 세 메서드 구현.
- [x] `packages/core/src/testing/contracts/attachment-store.ts` -- 계약 사례: 첨부 ingest가 만든 `brain`·`external` 위치가 `listFileLocations`에 id와 함께 나오고 `readFileLocation`이 같은 행을 주며, `markFileLocationDeleted` 두 번에 첫 값만 남고(`marked` true → false), 없는 id는 두 메서드 모두 `FILE_LOCATION_NOT_FOUND`.
- [x] `packages/core/src/files/blob-delete-work.ts`(새), `packages/core/src/brain.ts`, `packages/core/src/capture/session-ingest-work.ts`, `packages/core/src/index.ts` -- 상수·도우미·handler·등록·retry 단계·export.
- [x] `packages/core/test/blob-delete.test.ts`(새) -- I/O 표 아홉 줄을 fake Store·`memoryFileStore`(장애·거부는 감싼 FileStore)로, 그중 정상·두 번째·external은 `createBrain(...).queue.drain`을 거쳐; 기록된 실패의 code·stage(`blob_delete`)·target 확인.
- [x] `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` -- 손 Store 메서드.
- [x] `apps/cli/test/sessions-ingest.test.ts`(또는 같은 도우미를 쓰는 새 시험 파일) -- 아래 CLI AC.

**Acceptance Criteria:**
- Given 붙여 넣은 이미지 세션을 수집한 임시 home, when 그 `brain` 위치에 `blobDeleteWork`로 일감을 넣고 `brain queue drain`을 돌린 뒤 같은 위치에 일감을 또 넣고 다시 돌리면, then 두 drain 모두 exit 0이고 `<home>/files` 아래 블롭이 없으며 `deleted_at`은 첫 drain의 값 그대로이고 `brain failures list`에 그 위치의 실패가 없다.
- Given 같은 home에 `external` 위치(홈 아래 실제 파일)와, 블롭 경로가 루트 밖 파일을 가리키는 링크인 `brain` 위치, when 각 위치에 일감을 넣고 `brain queue drain`을 돌리면, then 두 대상 파일의 바이트와 존재가 그대로이고 두 위치의 `deleted_at`이 null이며 `brain failures list`에 `LOCATION_REFUSED`가 두 건 보인다.
- Given fake와 SQLite Store, when `attachmentStoreContract()`를 돌리면, then 둘 다 새 사례를 포함해 통과한다.

## Implementation Notes

- 세 메서드의 결과 타입은 `ports/store.ts`에, `FileLocationRow`와 함께. `ports/index.ts`에도 한 줄 더해야 `second_brain`에서 보인다(`export *`가 아니라 이름 목록이다).
- SQLite `markFileLocationDeleted`는 `update … where deleted_at is null returning id` 뒤 같은 트랜잭션에서 다시 읽는다: `returning`의 행 수가 `marked`, 다시 읽은 값이 `deletedAt`. 행이 없으면 `FILE_LOCATION_NOT_FOUND`.
- fake는 `fileLocationRows` 목록을 새로 둔다. `link()`가 `(storeKind, locator)`로 이미 걸러 주므로 그 자리에서 밀어 넣으면 첫 id가 남고, `MessageAttachment.file.locations` 모양은 그대로다.
- Core 시험은 ingest로 한 파일에 네 위치(`brain`·`external`·`drive`·문법 밖 locator)를 만들고, kit 끝에서 drain 한 번을 돌려 추출을 먼저 끝낸다. 그러지 않으면 블롭을 지운 뒤 추출이 `FILE_SOURCE_UNREACHABLE`을 기록해 시험이 보는 것이 흐려진다.
- CLI 시험도 같은 이유로 수집 뒤 drain 한 번을 먼저 돌린다. 일감은 `blobDeleteWork()`가 만든 값을 그대로 `work_items`에 넣는다(넣는 경로는 10.12·epic 8 몫이라 아직 없다).

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 7 findings — high 0, medium 1, low 6, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` 이미 표시된 위치의 일감이 `resolveFailures`를 건너뛰어, 앞 시도의 정리가 삼켜지면 `failures retry`로도 실패 행이 닫히지 않는다 — `resolve()` 주석과 어긋남을 확인. 이미 표시된 갈래에서도 `resolve`를 부르게 고치고 주석을 맞췄다.
  - `[medium]` `[patch]` SQLite `markFileLocationDeleted`가 `withWrite` 안의 오류를 던져 drain이 `HANDLER_THREW`로 시도를 쓰고 release하지 않는다 — `write.ts`가 `begin immediate` 뒤 오류를 다시 던짐을 확인. `addWork`(`work.ts:150`)처럼 try/catch로 `DB_UNAVAILABLE`을 돌려주게 고쳤다.
  - `[low]` `[patch]` CLI AC 1의 끝 상태(두 번째 drain 뒤 블롭 없음)를 시험이 확인하지 않는다(두 번째 drain 전에 블롭을 되심음) — 두 번째 일감을 되심기 없이 돌려 AC 끝 상태를 확인하고, 되심기 확인은 셋째 일감으로 옮겼다.
  - `[low]` `[patch]` I/O 표 "표시 쓰기 실패" 줄의 `DB_LOCKED`가 시험되지 않는다 — `it.each`로 `DB_UNAVAILABLE`·`DB_LOCKED` 둘 다 돌린다.
  - `[low]` `[patch]` fake의 `listFileLocations`가 `localeCompare`로, SQLite는 BINARY로 정렬해 대소문자가 섞인 locator 순서가 다르다 — 새 메서드만 코드 단위 비교로 바꾸고 계약 사례에 `~/Project/b`·`~/project/a` 쌍을 더해 순서를 고정했다(fake·SQLite 모두 통과).
  - `[low]` `[patch]` CLI `ingested()`의 정착 drain 확인이 `blob_delete` 실패만 걸러 추출 실패를 놓친다 — `brain failures list` 전체가 비었는지 확인하게 고쳤다.
  - `[low]` `[patch]` `FAILURE_RETRY_STAGES.blob_delete` 줄에 시험이 없다 — external 거부로 실패를 기록한 뒤 `brain.failures.retry()`가 같은 `file_location` 대상의 `blob_delete` 일감을 다시 넣는 Core 시험을 더했다.

## Design Notes

- 대상은 파일이 아니라 위치다. 같은 내용이 Brain 사본·사용자 원본·Drive 사본으로 여러 위치를 가지며, verify가 "external 위치를 가리키는 일감"을 말하므로 일감은 위치 하나를 가리켜야 한다. 위치 행은 지워지지 않으므로(0002) 없는 id는 넣는 쪽의 버그로 기록한다.
- 삭제 → 표시 순서. 표시를 먼저 하면 지우지 못한 블롭이 "지워짐"으로 남아 고아 순회도 못 찾는다. 반대 순서의 중간 상태(블롭 없음, `deleted_at` null)는 다음 drain이 `deleted: false`로 마저 끝낸다.
- 두 번째 일감에서 `FileStore`를 다시 부르지 않는다. 내용 주소라 같은 바이트가 다시 수집되면 같은 locator에 블롭이 되살아날 수 있는데, 이미 지운 위치의 일감이 그 새 블롭을 지우면 안 된다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project cli --project sqlite` -- expected: 모두 통과.
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- 요약: Brain 위치의 블롭 하나를 지우는 drain 일감 `blob_delete`(대상 종류 `file_location`, 대상 id = `file_locations.id`)를 Core handler로 두고 `createBrain`에 등록했다. handler는 위치 행을 읽어 이미 표시된 위치는 `FileStore`를 부르지 않고 끝내며, `local`·`brain` 소유가 아니면 `LOCATION_REFUSED`로 즉시 기록하고, 블롭을 트랜잭션 밖에서 지운 뒤(`deleted: false`도 성공) `deleted_at`을 한 번 채우고 그 위치의 실패를 닫는다. port가 거부한 루트 밖·링크 위치는 같은 코드로 즉시 기록, 저장소 일시 장애는 재시도, 표시 쓰기 실패는 release된다. `AttachmentStore`에 `readFileLocation`·`listFileLocations`·`markFileLocationDeleted`를 더해 SQLite·fake가 계약 사례로 함께 지키고, 10.12·epic 8이 쓸 `blobDeleteWork()` 도우미와 `failures retry` 단계를 두었다. 마이그레이션 없음.
- 바뀐 파일:
  - `packages/core/src/files/blob-delete-work.ts`(새) — 상수·`blobDeleteWork`·`blobDeleteHandler`.
  - `packages/core/src/ports/store.ts`, `packages/core/src/ports/index.ts` — `FileLocationRow`와 세 메서드·결과 타입, 공개 export.
  - `packages/sqlite/src/attachments.ts` — 세 메서드의 SQLite 구현.
  - `packages/core/src/testing/fakes/store.ts` — fake 위치 행과 세 메서드.
  - `packages/core/src/testing/contracts/attachment-store.ts` — 위치 읽기·정렬·한 번 표시 계약 사례.
  - `packages/core/src/brain.ts`, `packages/core/src/capture/session-ingest-work.ts`, `packages/core/src/index.ts` — handler 등록, `FAILURE_RETRY_STAGES.blob_delete`, export.
  - `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` — 손 Store 메서드.
  - `packages/core/test/blob-delete.test.ts`(새) — I/O 표 아홉 줄(`DB_LOCKED` 포함)과 `failures retry` 재주입.
  - `apps/cli/test/sessions-ingest.test.ts` — CLI AC 두 개(`brain queue drain`·`brain failures list`, 실제 로컬 FileStore).
- 리뷰: Quick 렌즈 7건(medium 1, low 6) 모두 patch로 고침. 미룸 0, 반려 0.
- 후속 리뷰 권장: false(patch는 high 0, medium 1, low 6 — high가 없고 medium 둘 이상이 아님).
- 검증(코디네이터가 패치 뒤 다시 돌림): `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project cli --project sqlite` 71개 파일·2,220개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표 아홉 줄 모두 `packages/core/test/blob-delete.test.ts`에서 실행·통과함을 verbose 실행으로 확인했다.
- 구현: 서브에이전트가 계획대로 구현하고 리뷰 패치를 적용했으며, 코디네이터가 diff 전체를 읽었다.
- 남은 위험:
  - handler는 "지워도 되는가"를 판단하지 않는다. 가리지 않은 파일의 유일한 Brain 사본에 일감을 넣으면 그대로 지운다 — 넣는 쪽(10.12의 가리기 트랜잭션, epic 8의 검증된 이전)이 지켜야 한다.
  - 지운 뒤 같은 바이트가 다시 수집되면 같은 locator에 블롭이 생기지만 위치 행은 `deleted_at`이 채워진 채 남는다(수집이 `on conflict do nothing`). 그 블롭은 기록상 지워진 위치에 놓인 고아가 된다 — 10.12(가린 파일의 재수집)와 V1 뒤 고아 순회에서 다룬다.
  - 일감을 넣는 경로는 아직 없다. 시험은 `blobDeleteWork()` 값을 `work_items`에 직접 넣는다.
