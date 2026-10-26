---
title: 'Tracer: 붙여 넣은 이미지 한 장이 원본째 남는다'
type: 'feature'
ticket: '2'
created: '2026-10-23'
status: 'built'
baseline_revision: '80a44e32400583217f744c3aed6eb8d778786a27'
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

**Problem:** 사용자가 대화에 붙여 넣은 이미지는 지금 아무 데도 남지 않는다. Claude Code parser(`readBody`)는 text 블록만 읽어 image 블록의 바이트를 버리고, 이미지뿐인 사용자 메시지는 `empty`로 통째로 버린다. Core에는 원본을 둘 `FileStore` port도, 첨부 자료형도, 첨부 행(`files`·`file_locations`·`message_attachments`, 0002에 테이블만 있음)을 쓰는 Store 능력도 없다.

**Approach:** 모든 층을 가장 얇게 잇는다. Core에 `FileStore` port·첨부 자료형·Store 능력을 두고, parser가 사용자 메시지의 직접 image 블록을 첨부(자리·출처·바이트)로 내며 버전을 5로 올린다. 수집은 트랜잭션 밖에서 블롭을 로컬 FileStore에 넣은 뒤, 메시지와 같은 `store.ingest` 트랜잭션에서 세 테이블을 쓴다. DB에 못 쓰면 바이트 없는 새 spool record `attachment_link`를 남긴다. 마이그레이션은 없다.

## Boundaries & Constraints

**Always:**
- **Core 도메인(`domain/file.ts`, 새 파일).** `FileLocation { storeKind: 'local' | 'drive'; locator: string; ownership: 'brain' | 'external' }`. 순수 함수 `contentHashOfBytes(bytes): string`(`sha256:` + 소문자 hex, `domain/sha256.ts`의 `sha256(bytes)` 사용)와 `brainLocator(hex, bytes): string` = `<hex[0..2]>/<hex[2..4]>/<hex><ext>`(AD-23). `ext`는 바이트 머리로 정한다: png `.png`, jpeg `.jpg`, gif `.gif`, webp `.webp`, 그 밖은 없음. 그래서 locator는 내용의 순수 함수이고 넣기는 멱등이다. 이 locator 문법 검사기(`isBrainLocator`)도 여기 둔다.
- **`FileStore` port(`ports/file-store.ts`, 새 파일).** `put(bytes) → { ok: true; contentHash; sizeBytes; location /* brain·local */ } | { ok: false; code: 'FILES_UNAVAILABLE'; message }`, `get(location)`, `exists(location)`, `url(location)`, `delete(location)`. 모두 Promise와 결과 값이고 던지지 않는다. 실패 코드는 `FILES_UNAVAILABLE`(루트에 못 씀), `LOCATION_REFUSED`(port 안의 코드: `external` 소유, 다른 `storeKind`, `isBrainLocator`가 아닌 locator, 루트 밖으로 풀리는 경로), `get`만 `FILE_NOT_FOUND`. 이 스토리에서 `get`·`exists`·`url`·`delete`는 `brain` 소유·루트 안 위치만 받고 나머지는 `LOCATION_REFUSED`다(`external` 표현은 3이 완성). `delete`는 없는 블롭이면 `{ ok: true; deleted: false }`.
- **fake와 계약.** `testing/fakes/file-store.ts` `memoryFileStore()`(Core `sha256`로 해시, 같은 locator 규칙), `testing/contracts/file-store.ts` `fileStoreContract()`(`ContractCase<FileStore>[]`): 해시·크기·locator 모양, 두 번 넣어도 같은 위치와 같은 바이트, `get` 왕복, `exists` 참·거짓, `url`, `delete` 두 번, `external`·`../`·다른 storeKind·문법 밖 locator의 `get`·`delete` 거부. Core는 fake로, CLI는 로컬 구현으로 같은 사례를 돈다.
- **로컬 구현(`apps/cli/src/runtime/file-store.ts`).** `localFileStore({ root })`. 해시는 `node:crypto`(결과는 Core와 같아야 함, 시험으로 고정). 같은 locator의 파일이 이미 있고 크기가 같으면 쓰지 않는다. 아니면 같은 폴더의 임시 파일(0600)에 쓰고 rename한다. 없는 루트·하위 폴더는 0700으로 만든다. 경로는 `path.resolve(root, locator)`가 루트 안인지 다시 확인한다. 생성자는 I/O를 하지 않는다(spool과 같음). `url`은 `pathToFileURL`. `apps/cli/src/dispatch.ts`가 `config.config.filesPath`로 만들어 `createBrain`에 넣는다.
- **parser 자료형.** `ParseResult.attachments: readonly ParsedAttachment[]`, `ParsedAttachment { harnessMessageId; ordinal; sourceKind: string; sourceRef: string | null; displayName: string | null; bytes: Uint8Array }`. 모든 첨부의 `harnessMessageId`는 같은 결과의 `messages`에 있고 `(harnessMessageId, ordinal)`은 겹치지 않는다(parser 계약 사례로 고정).
- **Claude Code parser(v5).** `readMessage`가 남기는 사용자 메시지에서 `message.content` 배열의 **직접** `type: 'image'` 블록 중 `source.type === 'base64'`이고 `data`가 디코드되어 1바이트 이상인 것만 첨부로 낸다. `ordinal`은 그 메시지의 이런 블록 순서(0부터), `sourceKind`는 `'image'`, `sourceRef`는 항목의 `imagePasteIds` 길이가 첨부 수와 같을 때 같은 자리 값의 문자열(아니면 null), `displayName`은 null. 본문이 비어도 첨부가 하나 이상이면 메시지를 버리지 않는다(본문 `''`). 첨부가 없는 빈 메시지는 지금처럼 `empty`. `tool_result` 안의 이미지, assistant 메시지, `isMeta`·compact 요약·sidechain·비인간 출처 줄은 첨부를 내지 않는다(기존 필터 순서 그대로). `CLAUDE_CODE_PARSER_VERSION = '5'`. 10.1의 다시 읽기가 이 올림으로 닫힌 세션을 한 번 다시 읽는다.
- **수집 자료형과 쓰기.** `IngestBatch.attachments: readonly IngestAttachment[]`, `IngestAttachment { id; harnessMessageId; ordinal; sourceKind; sourceRef; displayName; file: { id; contentHash; sizeBytes; location: FileLocation & { id } } }`(id들은 Core가 `idGen`으로 만든 후보). SQLite `ingest`는 같은 트랜잭션에서 메시지 뒤에 첨부를 쓴다: 메시지는 `(session, harness_message_id)`로 찾고(이미 있던 메시지 포함 — 지금의 `Set` 미리 읽기를 id까지 담는 `Map`으로), `files`는 `content_hash`로 찾거나 `home_location_id` 없이 넣고, 위치는 `(file_id, store_kind, locator)`로 찾거나 넣고, `home_location_id`가 null이면 그 `brain` 위치로 채우고, `message_attachments`는 `(message_id, ordinal)` 충돌이면 그대로 두고 아니면 `stored`로 넣는다. `first_seen_at`은 batch의 `ingestedAt`. 이 쓰기 함수는 아래 `linkAttachments`와 공유한다.
- **Store 능력(`ports/store.ts`).** 새 `AttachmentStore`를 `Store`에 합친다: `linkAttachments({ key: SessionKey; attachments: readonly IngestAttachment[]; linkedAt: Date })` → `{ ok: true; linked: number } | { ok: false; code: 'SESSION_NOT_FOUND' | 'MESSAGE_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message }`(한 트랜잭션, 하나라도 메시지가 없으면 아무것도 쓰지 않고 `MESSAGE_NOT_FOUND`), 잠금 없는 읽기 `listMessageAttachments(messageId)` → 자리 순 `{ id, ordinal, sourceKind, sourceRef, displayName, status, file: { id, contentHash, sizeBytes, home: FileLocation | null } | null }[]`. 가짜 store, SQLite, `apps/cli/src/doctor/store.ts` 껍데기(`unavailable`), `testing/contracts/session-store.ts`(또는 새 `attachment-store.ts`) 계약 사례를 같이 둔다. Postgres는 손대지 않는다.
- **수집 흐름(`sessions/ingest.ts`).** `nothingToStore`는 첨부도 없을 때만 참. 그 지름길 뒤, `readSelfUser` 앞에서 첨부마다 `files.put`(같은 해시는 한 번)한다. 하나라도 실패하면 내역을 남기지 않고 `{ ok: false, code: 'FILES_UNAVAILABLE' }`로 끝낸다(다음 스캔·hook이 다시 한다). 그 뒤 `readSelfUser`·`ensureSession`·`ingest` 중 하나가 DB_UNAVAILABLE/DB_LOCKED이면 spool로 가되, `session_ingest` record와 첨부마다 `attachment_link` record를 **한 번의 append**에 그 순서로 담는다. 인코딩되지 않는 `attachment_link`(64KiB 초과 등)는 빼고 넣는다(`session_ingest` 다시 읽기가 같은 연결을 만든다). 블롭은 이미 저장소에 있다.
- **spool record `attachment_link`(`domain/spool-record.ts`).** payload `{ session, harnessMessageId, ordinal, sourceKind, sourceRef, displayName, contentHash, sizeBytes, storeKind, locator, ownership }`, 바이트 없음. 인코드·디코드 검증(해시 형식, 0 이상 정수, 허용 값, 빈 문자열 거부), `SPOOL_RECORD_KINDS`·union·`encodePayload`·디코드 분기·`spool/replay.ts` `failureTargetOf`(대상 `session`)를 고친다. `brain.ts` `spoolHandlers`에 handler: 후보 id를 만들어 `store.linkAttachments`를 부르고 결과를 그대로 돌려준다(`MESSAGE_NOT_FOUND`는 시도 하나를 쓰고 뒤에 다시).
- **조립.** `BrainDependencies.files: FileStore`(필수)와 `IngestSessionDependencies.files`를 더하고 `ingestDependencies`로 넘긴다. 기존 시험의 조립은 `memoryFileStore()`를 넣는다. Core 공개 export(`domain/index.ts`, `index.ts`, `testing`)에 새 타입·함수·fake·계약을 더한다.
- README: 수집 절에 붙여 넣은 이미지가 `[files] path` 아래 한 번만 남는다는 것, spool 절에 첨부 연결은 바이트 없는 메타데이터 한 줄이라는 것을 더한다. 새 문구는 한국어이고 출력 언어 검사·README 코드 대조가 통과해야 한다. CLI 시험은 빈 임시 `CLAUDE_CONFIG_DIR`을 쓴다. 시험 fixture의 이미지는 직접 만든 작은 PNG(중립 내용)다.

**Never:**
- 마이그레이션, 새 공개 오류·경고 코드(`FILES_UNAVAILABLE`·`MESSAGE_NOT_FOUND`·`SPOOLED`는 이미 있음), `files` CLI 명령, `IngestCounts`·`sessions ingest` 출력 모양 변경을 하지 않는다.
- @파일 `attachment` 줄, `missing_at_ingest`, `external` 위치, `file_names`·`file_metadata`, 추출 일감, 고아 정리, 기존 세션 첨부 채우기 일감은 하지 않는다(4·5·7~11).
- 첨부 바이트나 base64를 spool·DB·메시지 본문·로그에 넣지 않는다. 블롭 쓰기를 DB 트랜잭션 안에서 하지 않는다(AD-7).
- 이미 저장된 메시지 행을 고치지 않는다(AD-11). 첨부 연결은 `(message_id, ordinal)`이 이미 있으면 건드리지 않는다.
- Core에 `node:` import를 두지 않는다. Postgres는 손대지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 이미지 한 장 | 사용자 메시지에 텍스트 + base64 png 1개 | 블롭 1, `files` 1, `file_locations` 1(`local`·`brain`, `home`), `message_attachments` 1(`stored`, `source_kind` `image`) | 없음 |
| 이미지뿐인 메시지 | 사용자 메시지에 image 블록만 | 메시지가 본문 `''`로 저장되고 첨부 1 | 없음 |
| 같은 이미지 두 번 | 두 메시지에 같은 바이트 | 블롭 1, `files` 1, 위치 1, 첨부 2 | 없음 |
| 다시 수집 | 같은 transcript로 두 번 | 행·블롭 수 그대로 | 없음 |
| 옛 parser로 수집된 세션 | v4로 저장된 세션, transcript 그대로 | drain이 다시 읽어 이미지뿐인 메시지가 새로 들어오고, 이미 있던 메시지에도 첨부가 이어짐 | 없음 |
| 도구 결과 안 이미지 | `tool_result.content`의 image | 첨부 없음 | 없음 |
| 읽을 수 없는 image 블록 | `source.type`이 base64가 아님, 또는 빈 데이터 | 첨부 없음; 그것뿐인 메시지는 `empty` | 없음 |
| `imagePasteIds` 수가 다름 | 이미지 2, ids 1 | 두 첨부 모두 `source_ref` null | 없음 |
| 파일 저장소에 못 씀 | 루트가 쓰기 불가 | 수집 `FILES_UNAVAILABLE`, DB에 메시지 안 들어감, 내역 안 남김 | 다음 scan·hook이 다시 |
| DB 잠김 | 블롭은 들어간 뒤 `ingest`가 DB_LOCKED | `SPOOLED`; 한 spool 파일에 `session_ingest` 다음 `attachment_link` | drain 재주입 뒤 직접 수집과 같은 행 |
| 연결 record 먼저, 메시지 없음 | `attachment_link` 재주입 시 메시지가 없음 | `MESSAGE_NOT_FOUND`, 아무것도 안 씀 | 시도 하나 쓰고 뒤에 다시 |
| 루트 밖 위치 | `external`, `../x`, 다른 storeKind의 `get`·`delete` | `LOCATION_REFUSED`, 파일 그대로 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/domain/sha256.ts` -- `sha256(bytes): Uint8Array`(:52), `CONTENT_HASH_PREFIX`(:34). `contentHash(text)`는 문자열용이라 바이트에 쓰지 않는다.
- `packages/core/src/ports/parser.ts` -- `ParseResult`(:9)에 `attachments`, `Parser`(:88).
- `packages/core/src/domain/ingest-batch.ts` -- `ParsedMessage`(:14), `IngestBatch`(:179), `IngestMessage`(:111)를 본뜬 `IngestAttachment`. 메시지 정체는 `(sessionId, harnessMessageId)`.
- `packages/claude-code/src/parser.ts` -- `CLAUDE_CODE_PARSER_VERSION`(:66), `readMessage`(:627; 원 `content` 배열은 :637·:649에서 보임, 빈 본문 관문 :649–652), `readBody`(:964), parse 루프(:360, 첫 uuid가 이김 :392–399), 결과 조립(:457 근처). `imagePasteIds`는 지금 읽지 않음(항목 최상위, 실제 값은 숫자 배열).
- `packages/claude-code/test/parser.test.ts` -- fixture는 `test/fixtures/*.jsonl`(:39·:75), `full-session.jsonl:20`에 가짜 base64 이미지와 `imagePasteIds`, 스크린샷 메시지가 텍스트만 남는 기대(:161), base64가 본문에 안 들어가는 회귀(:963), `parserContract` 등록(:472).
- `packages/core/src/testing/contracts/parser.ts` -- 첨부 계약 사례 자리. `packages/core/src/testing/fakes/parser.ts` `memoryParser`(:37) -- 중립 JSON 메시지에 첨부를 줄 수 있게.
- `packages/core/src/sessions/ingest.ts` -- 흐름(:200), 의존성(:118), `cursorFor`(:582), `nothingToStore`(:327), id 만들기(:396), `ensureSession`(:409–451), batch·`store.ingest`(:454–475), `unwritable`(:558).
- `packages/core/src/sessions/spool-ingest.ts` -- `spoolSessionIngest`(:79–118): 한 append에 `attachment_link`를 더할 곳.
- `packages/core/src/domain/spool-record.ts` -- 종류(:77–80), union(:140–186), `encodePayload`(:285), 디코드 분기(:415–457), 64KiB(:41). `packages/core/src/spool/replay.ts` -- 순서대로 한 줄씩, `failureTargetOf`(:422–443).
- `packages/core/src/brain.ts` -- `BrainDependencies`(:43–105), `ingestDependencies`(:197), `spoolHandlers`(:230–260).
- `packages/core/src/ports/store.ts` -- `IngestResult`(:151–169), `SessionStore.ingest`(:316), `Store` 합성(~:718).
- `packages/sqlite/src/sessions.ts` -- `ingest`(:352; 미리 읽기 :379–382, 메시지 넣기 :391–401, 내역 갱신 :466–507), `withWrite`(`write.ts:61`). `packages/sqlite/src/store.ts:80` 합성.
- `packages/sqlite/migrations/0002_files_and_work.sql` -- `files`(:102), 위치(:144), 첨부(:189; `file_id`↔`stored`), `files_home_check`(:351–373: `home`은 이미 있는 같은 파일의 `brain` 위치여야 함 → 파일(home null) → 위치 → home 갱신 순서). 읽기만.
- `packages/core/src/testing/fakes/store.ts` -- `ingest`(:375–410) 같은 규칙. `packages/core/src/testing/contracts/index.ts`, `testing/contract.ts`(`contractCase`, `withSubject`), `packages/core/test/contracts.test.ts:96–101`, `packages/sqlite/test/session-store.test.ts:40–63`.
- `apps/cli/src/runtime/spool.ts` -- 임시 파일 → rename, 생성자 I/O 없음: 로컬 FileStore가 본뜰 것. `apps/cli/src/install/store.ts:266` `prepareFilesRoot`(0700).
- `apps/cli/src/dispatch.ts` -- `home`(:531), store(:550), spool(:563), 의존성(:566–588); `config.config.filesPath`(`config/codec.ts:91,208,228`).
- `apps/cli/src/doctor/store.ts` -- 진단용 store 껍데기.
- `apps/cli/test/sessions-ingest.test.ts` -- `runBrain`(:145), `installedHome`(:169), `transcriptIn`(:193), `stopPayload`(:222), `rowCounts`·`rowDump`(:233·:259), DB 경로(:319), spool·잠금 사례가 이미 있음.
- `packages/second_brain/test/boundaries.test.ts` -- 패키지 의존 경계(바꾸지 않음).
- `README.md` -- 수집 절(~:320), spool 절(~:353–365).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/file.ts`, `packages/core/src/ports/file-store.ts`, `packages/core/src/testing/fakes/file-store.ts`, `packages/core/src/testing/contracts/file-store.ts` -- 위치 자료형·해시·locator, port, fake, 계약 -- 3·4가 넓힐 경계.
- [x] `packages/core/src/ports/parser.ts`, `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/testing/contracts/parser.ts`, `packages/core/src/testing/fakes/parser.ts` -- 첨부 자리 -- parser와 수집의 약속.
- [x] `packages/claude-code/src/parser.ts`, fixture와 `packages/claude-code/test/parser.test.ts` -- v5 첨부, 이미지뿐인 메시지 -- 원본의 출처.
- [x] `packages/core/src/ports/store.ts`, `packages/sqlite/src/sessions.ts`(필요하면 새 `attachments.ts`), `packages/sqlite/src/store.ts`, 가짜 store, doctor 껍데기, 계약 -- `ingest`의 첨부 쓰기, `linkAttachments`, `listMessageAttachments`.
- [x] `packages/core/src/domain/spool-record.ts`, `packages/core/src/spool/replay.ts`, `packages/core/src/sessions/spool-ingest.ts`, `packages/core/src/sessions/ingest.ts`, `packages/core/src/brain.ts`, export 파일 -- 넣기·spool·재주입·조립.
- [x] `apps/cli/src/runtime/file-store.ts`, `apps/cli/src/dispatch.ts` -- 로컬 구현과 주입.
- [x] `README.md` -- 두 절.
- [x] 시험 -- I/O 표의 모든 줄(Core: fake store·fake FileStore·memoryParser; spool record 왕복·64KiB; 계약은 fake·SQLite·로컬 FileStore 모두), 로컬 FileStore 권한(폴더 0700·파일 0600)과 Core·`node:crypto` 해시 일치, 아래 AC를 CLI로.

**Acceptance Criteria:**
- Given 설치한 임시 home과 사용자 메시지 둘에 같은 png를 붙이고 도구 결과에도 이미지가 있는 transcript, when Stop hook 입력으로 `brain sessions ingest claude-code --json`, then `[files] path` 아래 블롭이 하나(파일 0600, 폴더 0700)이고 DB에 `files` 1·`file_locations` 1(`local`, `brain`)·`message_attachments` 2(`stored`)이며, 메시지 → 첨부 → 파일 → `home` 위치로 이은 locator의 파일 바이트가 원본 png와 같다.
- Given 같은 설치, when 같은 명령을 다시, then 블롭·`files`·위치·첨부 수가 그대로다.
- Given 다른 프로세스가 DB 쓰기 잠금을 쥔 상태, when 같은 transcript를 수집하면 `SPOOLED`이고, 잠금을 푼 뒤 `brain queue drain --json`, then 행이 잠그지 않고 수집한 설치와 같고 spool은 비었다.
- Given 이미지뿐인 사용자 메시지가 있는 transcript, when 수집, then 그 메시지가 본문 `''`로 저장되고 첨부가 하나 붙는다.

## Implementation Notes

- 구현은 codex 워커(Orca run `run_4497545b95a3`)가 했다. 첫 워커는 `bmad-build` 스킬의 renderer(uv)가 죽어 손대지 않고 멈췄고, 코디네이터가 "스킬 없이 계획을 바로 구현"으로 새 워커를 띄웠다(10.1과 같은 일).
- 바뀐 곳: Core 도메인 `file.ts`(바이트 해시, 바이트 머리로 확장자를 정하는 locator, locator 문법 검사), port `file-store.ts`, `AttachmentStore`(`linkAttachments`·`listMessageAttachments`), `ParseResult.attachments`·`IngestBatch.attachments`, 수집(같은 해시는 한 번 넣기, 실패면 `FILES_UNAVAILABLE`로 메시지·내역·spool 없이 끝남, DB 거부면 `session_ingest` 뒤 `attachment_link`를 한 append에), spool record `attachment_link`와 재주입 handler, `BrainDependencies.files`. Claude Code parser v5. SQLite는 새 `attachments.ts`의 `writeAttachments`를 `ingest` 트랜잭션과 `linkAttachments`가 같이 쓴다(미리 읽기를 `Map`으로). CLI 로컬 FileStore(심볼릭 링크로 루트 밖을 가리키는 경로도 거부)와 `dispatch.ts` 주입. 계약 두 개(FileStore: fake·로컬, 첨부: fake·SQLite)와 parser 첨부 계약. README 두 절.
- 워커 보고: `pnpm test` 75개 파일·2,367개 통과(Postgres 포함), Postgres 빼고 71개 파일·2,276개 통과, `git diff --check`·절대 홈 경로 검사 통과. 실제 Claude Code에서 붙여 넣는 수동 확인은 하지 않았다(hitl).
- 코디네이터 확인: diff 전체를 읽고 `pnpm test`를 다시 돌려 같은 결과(75개 파일·2,367개)를 얻었다. 워커가 따로 만든 보고 파일은 이 절로 옮기고 지웠다.

## Plan Change Log

## Review Triage Log

### 2026-10-23 — Review pass
- verdicts: 2 findings — high 1, medium 0, low 1, false 0, maybe-false 0
- findings:
  - `[high]` `[patch]` `readAttachments`의 base64 검사 정규식(반복 그룹)이 큰 이미지에서 V8 정규식 스택을 넘겨, `Buffer.alloc(3_750_000)`의 base64(약 5MB, API의 이미지 한도 근처)에서 `RangeError`가 `parse` 밖으로 나가고 그 transcript는 다시는 수집·spool되지 못한다(`packages/claude-code/src/parser.ts`) — 코디네이터가 Node 24.16.0에서 재현(658KB는 통과, 5MB는 던짐). 구현 워커가 반복 그룹 없는 문자 집합 검사와 길이·패딩 검사로 바꾸고, 3,750,000바이트 이미지가 바이트 그대로 첨부되는 parser 시험을 더했다.
  - `[low]` `[patch]` 새 첨부 메서드가 DB 예외를 선언된 실패 값 대신 던진다(`packages/sqlite/src/attachments.ts`) — 읽기 `listMessageAttachments`는 이 adapter의 다른 잠금 없는 읽기(`listStaleSessions`, `listTranscriptFiles`)와 달리 잡지 않아 포트의 `DB_UNAVAILABLE`을 어긴다: 구현 워커가 `describe(error)`로 `DB_UNAVAILABLE`을 돌려주게 하고 표가 없는 DB 시험을 더했다(코디네이터가 그 시험의 `openSqlite` 옵션 누락으로 난 typecheck 오류를 고침). 쓰기 `linkAttachments`는 고치지 않았다: 잠금 아닌 쓰기 오류를 던지는 것은 `ingest`(`withWrite`)와 같은 관례이고, `DB_UNAVAILABLE`로 바꾸면 재주입이 그 줄을 "DB가 안 받음"으로 보고 파일을 그대로 돌려놓아 spool이 영영 막힌다.

## Design Notes

- Decision(2026-10-23, 무인 실행에서 에이전트가 고름) 첨부는 별도 쓰기가 아니라 메시지와 같은 `store.ingest` 트랜잭션에 넣는다. 따로 쓰면 그 사이에 커서가 앞서 가 첨부가 다음 parser 올림까지 빠진다. 티켓의 "한 쓰기"를 세 테이블과 메시지를 함께 담는 한 트랜잭션으로 읽었다.
- Decision(같은 날) 붙여 넣은 이미지의 `source_kind`는 블록 종류 `image`(0002 주석: 하네스가 부른 이름), `source_ref`는 `imagePasteIds`의 같은 자리 값(수가 맞을 때만), `display_name`은 null이다. 하네스가 이름을 주지 않고, `[Image #N]`은 화면 표기라 지어내지 않는다.
- Decision(같은 날) 블롭 locator의 확장자는 바이트 머리로 정한다. 미디어 형식 칸이 없고(추출이 그 사실을 가짐), 같은 바이트가 늘 같은 locator가 되어야 넣기가 멱등이기 때문이다.
- Decision(같은 날) 파일 저장소에 못 쓰면 수집 전체를 실패시킨다. 메시지만 넣으면 커서가 지나가 그 이미지는 다음 parser 올림 전에는 돌아오지 않는다.
- Decision(같은 날) `attachment_link`는 `session_ingest`와 한 append에 뒤에 둔다. 재주입은 줄 순서대로라 보통 다시 읽기가 먼저 연결하고 이 줄은 멱등으로 끝난다. 이 줄이 쓸모를 갖는 것은 transcript가 바뀌거나 사라진 경우와 4(@파일)다. 옛 빌드의 drain은 모르는 종류의 줄을 읽을 수 없는 줄로 옆에 둔다(replay 규칙) — 다시 읽기가 같은 연결을 만들므로 잃는 것은 없다.
- 실측(이 기계, 2026-10-23): 붙여 넣은 이미지는 `user` 항목의 `message.content`에 `{type:'image', source:{type:'base64', media_type:'image/png'|'image/jpeg', data}}`로, 텍스트 블록 앞이나 뒤에 온다. 항목의 `imagePasteIds`는 숫자 배열이고 수가 이미지 수와 같았다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 포함, Docker 필요; 없으면 `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code`로 나머지 전부 통과).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

**Manual checks (if no CLI):**
- 사람 확인(hitl): 임시 home에서 이미지를 붙여 넣은 실제 Claude Code 세션을 개발용 Stop hook으로 수집해, 블롭 하나와 세 테이블 행, 같은 이미지 두 번·다시 수집에도 하나, DB를 막고 수집한 뒤 drain하면 같은 행, 도구 결과 이미지는 첨부 아님을 본다.

## Auto Run Result

Status: built

- 요약: 붙여 넣은 이미지가 원본째 남는다. Core에 `FileStore` port·바이트 해시·내용 주소 locator(`<h0-2>/<h2-4>/<hex><확장자>`, 확장자는 바이트 머리)·`AttachmentStore`(`linkAttachments`·`listMessageAttachments`)를 두고, Claude Code parser v5가 사용자 메시지의 직접 base64 image 블록을 첨부(자리·출처·바이트)로 내며 이미지뿐인 메시지도 본문 `''`로 남긴다. 수집은 같은 해시를 한 번만 로컬 FileStore(`[files] path`, 폴더 0700·파일 0600, 임시 파일 → rename, `brain` 소유·루트 안만)에 넣고, 메시지와 같은 `store.ingest` 트랜잭션에서 `files`·`file_locations`·`message_attachments`를 쓴다. 이미 있는 메시지에도 같은 자리의 첨부를 멱등으로 잇는다. 파일 저장소에 못 쓰면 `FILES_UNAVAILABLE`로 아무것도 쓰지 않고 끝나고, DB가 거부하면 `session_ingest` 뒤에 바이트 없는 `attachment_link` 줄을 한 spool 파일에 남겨 drain이 같은 행으로 재주입한다. 마이그레이션 없음.
- 바뀐 파일:
  - `packages/core/src/domain/file.ts`(새) — 위치 자료형, 바이트 해시, locator와 그 문법 검사.
  - `packages/core/src/ports/file-store.ts`(새), `packages/core/src/ports/store.ts` — FileStore port, `AttachmentStore`와 `Store` 합성.
  - `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/parser.ts` — `ParsedAttachment`·`IngestAttachment`, 결과와 batch의 첨부 칸.
  - `packages/core/src/sessions/ingest.ts`, `packages/core/src/sessions/spool-ingest.ts` — 넣기, `FILES_UNAVAILABLE`, spool에 연결 줄.
  - `packages/core/src/domain/spool-record.ts`, `packages/core/src/spool/replay.ts`, `packages/core/src/brain.ts` — `attachment_link` 종류·검증·재주입 handler, `BrainDependencies.files`.
  - `packages/core/src/testing/{fakes/file-store,contracts/file-store,contracts/attachment-store}.ts`(새), `fakes/{store,parser}.ts`, `contracts/{parser,index}.ts`, `fixtures.ts`, `testing/index.ts`, `domain/index.ts`, `ports/index.ts` — fake·계약·export.
  - `packages/claude-code/src/parser.ts` — v5 첨부, 이미지뿐인 메시지.
  - `packages/sqlite/src/attachments.ts`(새), `packages/sqlite/src/sessions.ts`, `packages/sqlite/src/store.ts` — 첨부 쓰기를 `ingest`와 `linkAttachments`가 공유, 읽기.
  - `apps/cli/src/runtime/file-store.ts`(새), `apps/cli/src/dispatch.ts`, `apps/cli/src/doctor/store.ts` — 로컬 FileStore와 주입, 진단 store 껍데기.
  - `README.md` — 수집 절과 spool 절.
  - 시험: `packages/core/test/{sessions-ingest,brain-drain,spool-record,contracts,doctor,session-identity-work}.test.ts`, `packages/claude-code/test/parser.test.ts`, `packages/sqlite/test/session-store.test.ts`, `apps/cli/test/{file-store,sessions-ingest,dispatch}.test.ts`.
- 리뷰: Quick 렌즈(codex 워커) 지적 2건 — high 1건 패치(큰 이미지에서 정규식 스택 넘침), low 1건 패치(첨부 읽기의 `DB_UNAVAILABLE`, 쓰기 쪽은 이유를 적고 그대로 둠). 미룸 0건, 반려 0건.
- 후속 리뷰 권장: true. 첫 리뷰에서 high를 패치했다(high 1, low 1 패치). 다시 볼 위험: 바꾼 base64 검사가 Claude Code가 실제로 쓰는 모든 base64(패딩 없는 끝, 줄바꿈 없음)를 받는지 — 시험은 패딩 있는 큰 png와 작은 png만 본다.
- 검증: `pnpm test` — build → typecheck → vitest 75개 파일·2,369개 통과(Postgres 포함, 패치 뒤 다시 돌림). `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. I/O 표의 열두 줄 모두 시험이 있다(parser·Core 수집·brain drain·spool record·계약, CLI `sessions-ingest`).
- 사람 확인 필요(hitl, 스토리의 마지막 단계):
  1. 임시 home(`SECOND_BRAIN_HOME`)에 이 빌드를 설치하고, 이미지를 붙여 넣은 실제 Claude Code 세션의 transcript를 개발용 Stop hook 입력으로 `brain sessions ingest claude-code --json`에 넣는다. `<home>/files` 아래 블롭 하나와 `files`·`file_locations`·`message_attachments` 행을 본다.
  2. 같은 이미지를 두 메시지에 붙인 세션과 다시 수집에서 `files` 행과 블롭이 하나인지 본다.
  3. DB를 잠근 채 수집해 `SPOOLED`를 받고, 잠금을 푼 뒤 `brain queue drain`으로 같은 행이 되는지 본다.
  4. 도구가 찍은 스크린샷(도구 결과 안 이미지)이 첨부로 남지 않는지 본다.
- 남은 위험:
  - parser 버전이 5가 되어, 설치된 플러그인이 이 커밋을 받은 뒤 첫 drain이 v4로 저장된 닫힌 세션을 transcript가 남은 만큼 모두 다시 읽는다(10.1의 경로). 이미지를 원본으로 넣으므로 그 drain은 평소보다 오래 걸릴 수 있다.
  - Stop hook마다 커서 메시지를 다시 읽으므로, 그 메시지에 붙은 이미지는 턴마다 다시 해시된다(넣기는 같은 크기 파일이 있으면 쓰지 않음). 큰 이미지가 있는 세션의 hook 시간이 늘 수 있다.
  - 옛 빌드의 drain은 `attachment_link` 줄을 읽을 수 없는 줄로 `spool/failed/`에 옮긴다. 같은 연결은 `session_ingest` 다시 읽기가 만들므로 잃는 것은 없지만 doctor `spool` 줄이 `warn`이 된다.
  - 새 코드는 저장소의 다른 파일보다 주석이 적고 줄이 길다(10.1과 같음). 동작에는 영향이 없다.
  - Postgres는 `AttachmentStore`를 구현하지 않는다(epic 7).
