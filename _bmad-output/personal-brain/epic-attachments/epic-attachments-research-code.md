# 에픽 10 첨부 원본과 문서 추출: 현행 코드 조사

조사일: 2026-10-22. 범위의 기준은 `epic-attachments.md`의 Description·Boundaries·Carry이다. `packages/`, `plugin/`을 조사했고 CLI 등록 확인에 필요한 `apps/cli/`도 읽었다. `.codegraph/` 디렉터리가 없어 CodeGraph는 사용하지 않았다. 코드·기존 문서는 수정하지 않았으며 테스트·빌드·실제 사용자 DB 조회는 하지 않았다. 아래 버전은 배포 코드가 기대하는 버전이며, 개별 설치 DB의 적용 상태를 뜻하지 않는다.

핵심 결론: **DB의 첨부·추출 저장 구조는 있음, 이를 사용하는 Core·어댑터·CLI 동작은 대부분 없음**이다. 수집 재실행·작업 큐·출력 마스킹·확인 게이트는 일부 재사용할 수 있다. SQL 주석의 향후 동작 설명은 구현 완료의 증거로 취급하지 않았다.

## 1. 스키마 — 있음 (실행 동작과 구분 필요)

현재 SQLite 코드의 기대 스키마 버전은 **7**이다(`packages/sqlite/src/migrate.ts:20`). 마이그레이션 폴더의 최종 번호도 이 상수와 비교한다(`packages/sqlite/src/migrate.ts:290`).

| 마이그레이션 | 이 에픽과의 관계 |
| --- | --- |
| `0001_initial.sql` | 대화·도구 메모·대화 조각의 기반과 FTS. 첨부 일곱 테이블은 여기서 생성하지 않는다. 대화 조각 FTS·secure-delete·동기화 trigger는 `packages/sqlite/migrations/0001_initial.sql:384`부터 있다. |
| `0002_files_and_work.sql` | 첨부 일곱 테이블, 작업 큐, 문서 조각·파일 이름 FTS, 파일·위치 변경 제한과 포인터 소속 검사를 생성한다(`:40`, `:102`, `:144`, `:189`, `:221`, `:256`, `:273`, `:293`, `:326`, `:449`). |
| `0003_users.sql` | 사용자 구조 마이그레이션이다. 첨부 일곱 테이블의 칸을 추가하지 않는다(`packages/sqlite/migrations/0003_users.sql:1`). |
| `0004_capture_columns.sql` | `files.source_unreachable_at`, `document_chunks.chunk_locator`, 추출 `attempt`·`failed_stage`·`index_config_id`와 파일 대상 redaction을 추가한다(`:106`, `:139`, `:198`, `:277`). |
| `0005_identity_and_records.sql` | 실패 추출 세대의 `failed_stage` 필수 trigger, redaction의 도구 메모 대상 등을 추가한다(`:96`, `:172`, `:180`). |
| `0006_drop_message_seq.sql` | 메시지 순번 제거와 대화 조각의 시간 범위 전환이다. 첨부 일곱 테이블의 칸은 바꾸지 않는다(`packages/sqlite/migrations/0006_drop_message_seq.sql:22`). |
| `0007_session_tag_source.sql` | 세션의 `tag_source`·`first_cwd`와 근거 보존 trigger를 추가한다. 첨부 테이블 변경은 없다(`packages/sqlite/migrations/0007_session_tag_source.sql:3`). |

현재 일곱 테이블의 칸은 다음과 같다. `?`는 nullable이며 `search_rowid`는 FTS가 참조하는 정수 기본키다. 나머지 `id`는 text 식별자이다.

| 테이블 | 현재 칸과 중요한 제약 | 근거 |
| --- | --- | --- |
| `files` | `id`, `content_hash`(unique), `size_bytes`, `first_seen_at`, `home_location_id?`, `current_extraction_id?`, `redacted_at?`, `source_unreachable_at?`. 해시는 `sha256:`와 소문자 hex 64자리, 크기는 0 이상. | `packages/sqlite/migrations/0002_files_and_work.sql:102`, `packages/sqlite/migrations/0004_capture_columns.sql:106` |
| `file_locations` | `id`, `file_id`, `store_kind`, `locator`, `ownership`, `first_seen_at`, `source_modified_at?`, `uploaded_at?`, `remote_checksum?`, `verified_at?`, `deleted_at?`. unique `(file_id, store_kind, locator)`, store는 `local/drive`, 소유는 `brain/external`. | `packages/sqlite/migrations/0002_files_and_work.sql:144` |
| `message_attachments` | `id`, `message_id`, `ordinal`, `source_kind`, `source_ref?`, `display_name?`, `file_id?`, `status?`. unique `(message_id, ordinal)`, ordinal 0 이상. status는 null/`stored`/`missing_at_ingest`. `file_id` 존재와 `stored`가 동치. | `packages/sqlite/migrations/0002_files_and_work.sql:189` |
| `document_extractions` | `id`, `file_id`, `extractor_version`, `attempt`, `media_type?`, `status?`, `started_at`, `finished_at?`, `error?`, `failed_stage?`, `index_config_id?`. unique `(file_id, attempt)`, attempt 1 이상. status는 null/`ok`/`failed`/`unsupported`/`too_large`/`redacted`. 종료 시각과 status의 null 여부가 같아야 한다. failed_stage 값은 `read/extract/chunk/index`. | `packages/sqlite/migrations/0004_capture_columns.sql:277` |
| `document_chunks` | `search_rowid`, `id`(unique), `extraction_id`, `ordinal`, `page?`, `body`, `chunk_locator?`. unique `(extraction_id, ordinal)`. locator의 과거 행 null 허용과 신규 행 필수는 별개 규칙이다. | `packages/sqlite/migrations/0002_files_and_work.sql:256`, `packages/sqlite/migrations/0004_capture_columns.sql:139` |
| `file_names` | `search_rowid`, `id`(unique), `file_id`, `name_source`, `text`. unique `(file_id, name_source, text)`, source는 `location_path/attachment_name`. | `packages/sqlite/migrations/0002_files_and_work.sql:273` |
| `file_metadata` | `id`, `file_id`, `key`, `value`. unique `(file_id, key)`. `captured_at` 값에 정규 UTC 시각 형식 검사. `captured_at_local`, `captured_at_source`는 전용 칸이 아니라 key/value 행으로 담는 구조. | `packages/sqlite/migrations/0002_files_and_work.sql:284`, `:293` |

이미 있는 FTS·trigger와 아직 필요한 동작을 구분하면 다음과 같다.

- `document_chunks_fts(body)`와 `file_names_fts(text)`는 external-content FTS5이며 `trigram`, `secure-delete=1`, insert/delete/update 동기화 trigger가 있다(`packages/sqlite/migrations/0002_files_and_work.sql:449`, `:455`, `:459`, `:464`, `:470`, `:475`, `:479`, `:484`). 조각·이름 행을 삭제하는 쓰기와 FTS 삭제가 같은 트랜잭션에서 일어나는 기반이다.
- `files`는 내용 식별 칸 변경·행 삭제를 막는다. `redacted_at`는 가리기 표시가 켜진 쓰기에서 null→값 한 번만 가능하다. 포인터는 변경할 수 있다(`packages/sqlite/migrations/0002_files_and_work.sql:326`, `:341`). `file_locations`는 원래 위치·소유권 등의 변경과 행 삭제를 막고, `verified_at`·`deleted_at`만 한 번 채운다(`:413`, `:433`).
- `files.home_location_id`가 같은 파일의 `brain` 소유 위치인지 insert/update에서 확인한다(`packages/sqlite/migrations/0002_files_and_work.sql:351`, `:365`). `current_extraction_id`도 같은 파일의 추출인지 검사한다(`:379`, `:390`). **더 높은 attempt만 포인터로 채택하는 조건은 이 trigger에 없다.** 0004는 이를 Store가 구현할 규칙으로 설명하고 attempt 칸을 만들 뿐이다(`packages/sqlite/migrations/0004_capture_columns.sql:253`). 현재 추출 Store 자체가 없어 이 경합 방지는 새 동작이다.
- 실행 중 추출은 파일당 하나다. 0002의 `(file_id, extractor_version)` 미종료 unique index는 0004 테이블 재생성과 함께 없어지고, `(file_id) where finished_at is null` unique index로 바뀐다(`packages/sqlite/migrations/0004_capture_columns.sql:307`, `:316`).
- locator는 공백 없는 JSON object, type `pdf/docx/text/time/sheet` 중 하나를 요구하며 PDF면 `page`가 locator의 page와 같고 다른 type이면 null이어야 한다. SQL은 완전한 위치별 필드 검증·키 순서 코덱까지 제공하지 않는다(`packages/sqlite/migrations/0004_capture_columns.sql:130`, `:139`). 신규 null 삽입과 기존 비null을 null로 바꾸는 갱신은 거부한다(`:156`, `:164`).
- **0005 failed_stage trigger:** 새 `failed` 행에 stage가 없으면 삽입 거부(`packages/sqlite/migrations/0005_identity_and_records.sql:172`). 갱신은 새 status가 failed이고 stage가 null이면서, 이전 status가 failed가 아니었거나 이전 stage가 있었을 때 거부한다(`:180`). 따라서 0005 이전부터 failed·stage null인 행의 다른 칸 수정은 허용된다. 이 예외를 일반적인 stage 선택 사항으로 해석하면 안 된다.
- `message_attachments`, `document_extractions`에 포괄적인 변경·삭제 거부 trigger는 없다. `document_chunks`에는 locator guard와 FTS trigger, 이름에는 FTS trigger가 있다. 내용 사실의 변경 제한을 files·file_locations에 좁혀 두었다는 설명도 있다(`packages/sqlite/migrations/0002_files_and_work.sql:304`). 추가 제한 여부는 인셉션 결정 사항이다.

## 2. Core port·도메인 — 일부

- **FileStore 없음.** port 공개 목록은 Store, Parser, TranscriptReader/Folder, RepositoryInspector, Hook, Connector, 모델·시간·ID·Spool이며 FileStore가 없다(`packages/core/src/ports/index.ts:3`, `:57`, `:73`). Store도 `HealthStore & SessionStore & UserStore & WorkStore & TranscriptFileStore`만 합성한다(`packages/core/src/ports/store.ts:718`). SQLite 어댑터 합성도 세션·사용자·작업·transcript 내역뿐이다(`packages/sqlite/src/store.ts:80`). 관련 로컬 블롭 구현·계약·fake 역시 현행 소스에는 없다.
- **이름이 비슷한 TranscriptFileStore는 있음.** 이것은 원본 첨부 저장소가 아니라 transcript 경로·크기·fingerprint·cursor의 수집 내역 포트다(`packages/core/src/ports/store.ts:651`, `:693`). TranscriptReader는 전체 transcript를 문자열로 읽는 포트이고 바이너리 보관·삭제 기능은 없다(`packages/core/src/ports/transcript.ts:17`, `:33`).
- **Redaction 파일 대상 없음.** `messageId`, `toolNoteId` 두 대상만 있고 `fileId`가 없다. start/end도 필수 number라 전체 파일 가리기의 null 범위를 표현하지 못한다(`packages/core/src/domain/redaction.ts:6`). 반면 DB redactions는 이미 `file_id`를 가지며 세 대상 중 정확히 하나, 파일이면 범위 null을 검사한다(`packages/sqlite/migrations/0005_identity_and_records.sql:96`). 파일 가리기 전에 이 불일치를 해결해야 한다. 도메인 파일 머리말의 수집 때 마스킹 설명도 현행 마스킹 B 설명과 다르므로 동작 근거로 삼지 않았다.
- **chunk_locator Core 타입·코덱 없음.** 현행 도메인·port·SQLite TypeScript 전체에서 `chunkLocator`/`chunk_locator` 구현은 없고 SQL에만 있다. 기존 `IndexConfigKind`도 `chunk | embedding`뿐이며 문서 조각 설정 자료형은 없다(`packages/core/src/domain/index-config.ts:2`, `:5`, `:18`). DB의 `document_chunk` 설정 허용은 앞서 존재한다(`packages/sqlite/migrations/0002_files_and_work.sql:528`).
- 재사용 가능한 SHA-256 바이트 함수는 있다(`packages/core/src/domain/sha256.ts:52`). `contentHash(text)`는 UTF-8 문자열 전용이므로 임의 바이너리 파일에 그대로 적용하는 API는 아니다(`:42`).

## 3. transcript parser의 첨부 처리 — 일부 (버리고 줄 수만 셈)

- parser 버전 상수는 **`'4'`**다(`packages/claude-code/src/parser.ts:66`). ParseResult는 messages·toolNotes·cursor·시작 근거·droppedLines를 반환하며 첨부 목록을 반환하지 않는다(`packages/core/src/ports/parser.ts:9`). ParsedMessage에도 첨부 칸이 없고 IngestBatch도 messages/toolNotes만 받는다(`packages/core/src/domain/ingest-batch.ts:14`, `:179`).
- 붙여 넣은 이미지: `readBody`는 text 블록만 합치며 image 블록의 바이트·출처를 버린다(`packages/claude-code/src/parser.ts:964`). 이미지뿐인 정상 메시지는 body가 빈 문자열이 되어 `empty`로 버리고, 텍스트와 이미지가 섞이면 텍스트만 메시지로 남긴다(`:649`, `:652`). **이미지 개수는 세지 않는다.** droppedLines는 줄 단위이므로 혼합 메시지의 사라진 이미지는 별도 count가 없다.
- `@파일`의 `type: attachment` 줄은 role이 user/assistant가 아니므로 `not_conversation`으로 버린다(`packages/claude-code/src/parser.ts:627`). parser 자체 설명도 attachment를 이 이유에 포함한다(`:129`). parse loop는 이 결과를 `dropped[read] += 1`로 센다(`:405`). 경로·display name·첨부 ordinal·메시지 연결·파일 바이트가 어떤 첨부 자료형에 담기는 경로는 없다.
- 별도로 attachment 중 SessionStart hook의 시작 출처만 전체 transcript에서 읽는다(`packages/claude-code/src/parser.ts:936`). 이는 파일 첨부 지원의 증거가 아니다. 도구 결과 이미지도 `tool_result`에서 본문으로 꺼내지 않는다(`:958`).
- count는 `ParseResult.droppedLines`에 있고(`packages/claude-code/src/parser.ts:468`), CLI 수집 결과 data에도 전달한다(`apps/cli/src/commands/sessions-ingest.ts:139`). 첨부 전용 집계나 DB attachment 행으로 보존하는 기능은 아니다.

## 4. 수집·다시 읽기·실패 해소 — 일부

- 스캔은 `(harness, path)`별 **기존 크기와 현재 크기의 차이만** 본다. mtime·fingerprint·parser 버전은 변경 판단에 넣지 않는다(`packages/core/src/capture/scan.ts:41`). 크기가 그대로면 바로 돌아간다(`:139`, `:145`). 이미 열린 session_ingest나 미해결 수집 실패가 있는 대상은 건너뛴다(`:147`, `:151`, `:159`).
- 실제 ingest가 호출되면 transcript 전체를 읽고, 저장 parserVersion이 현재와 다르면 cursor를 null로 줘서 처음부터 parse한다(`packages/core/src/sessions/ingest.ts:275`, `:280`, `:288`, `:577`). 세션이 끝났다는 이유로 이 경로를 거부하는 조건은 없다. 따라서 **종료 세션 재수집 자체는 가능하지만, 크기가 그대로인 종료 세션을 버전 차이 때문에 자동으로 다시 읽게 하는 스케줄링은 없음**이다.
- 재호출 경로는 크기가 달라진 transcript의 스캔, 명시적 sessions.ingest, 실패 retry의 session_ingest, spool 재생이다(`packages/core/src/capture/session-ingest-work.ts:20`, `:82`, `packages/core/src/brain.ts:225`, `:285`). hook도 Stop·SessionEnd에서 sessions ingest를 부른다(`plugin/hooks/hooks.json:14`, `:25`). 과거 첨부 backfill용 전수 재읽기·완료 표시는 없다.
- spool 수집 성공은 기존 `session_ingest` 실패를 해소한다(`packages/core/src/brain.ts:242`, `:246`). 큐의 수집 handler도 성공 후 resolveFailures한다(`packages/core/src/capture/session-ingest-work.ts:87`). 반면 일반 공개 `brain.sessions.ingest`는 ingestSession을 바로 반환하여 같은 해소를 하지 않는다(`packages/core/src/brain.ts:285`). hook 정상 수집으로 이전 실패가 남는 문제는 실제로 남아 있다.
- 줄어든 transcript 위험도 남아 있다. 크기 불일치면 다시 큐에 넣는데, 이력은 `reset`이 아니면 작은 크기를 받아들이지 않는다(`packages/core/src/ports/store.ts:701`, `packages/sqlite/src/transcript-files.ts:100`). 수집이 넘기는 reset 값은 parsed.cursorReset이다(`packages/core/src/sessions/ingest.ts:301`). **추정:** cursor가 유지되는 축소 또는 버전 변경으로 null cursor에서 시작한 축소에서는 작은 크기를 계속 기록하지 못해 반복 재수집할 수 있다. 이를 여기서 런타임 재현하지는 않았다.

## 5. 일감 대기열·drain·failures retry — 일부

- DB kind/target_kind는 자유 text이며 enum CHECK가 없다(`packages/sqlite/migrations/0002_files_and_work.sql:32`, `:40`). Core WorkItem도 string이다(`packages/core/src/domain/work-item.ts:29`). **현재 실제 Core handler 종류는 `session_ingest`, `session_identity` 두 개**다(`packages/core/src/brain.ts:207`). 도메인 주석의 “한 종류” 설명(`packages/core/src/domain/work-item.ts:120`)보다 실제 조립을 우선해야 한다. 문서 추출·고아 블롭 정리 handler는 없다.
- 작업 추가는 `WorkStore.addWork({id, kind, targetKind, targetId, createdAt, nextAttemptAt})`다. 열린 `(kind,target_kind,target_id)`를 find-or-create하고 이미 있으면 created=false다(`packages/core/src/ports/store.ts:378`, `:589`, `packages/sqlite/src/work.ts:96`). 완료 행은 중복 키에 포함되지 않아 다시 요청할 수 있다(`packages/sqlite/migrations/0002_files_and_work.sql:78`, `packages/sqlite/src/work.ts:113`).
- handler를 kind별 Record로 등록하며 등록되지 않은 kind는 claim하지 않는다(`packages/core/src/queue/drain.ts:75`). createBrain은 Core handler에 주입된 workHandlers를 합친다(`packages/core/src/brain.ts:215`). 만료 claim 재회수, least-attempted 순서, claimed_by 비교 후 마무리하는 기반도 있다(`packages/sqlite/src/work.ts:76`, `:124`). 추출 세대의 열린 attempt 정리까지 해주는 것은 아니다.
- 오류 분류는 공통 구현이 있다. DB 불가·잠김·schema mismatch면 claim을 반환하고 시도 수를 되돌린다. handler의 retryable이 코드 표보다 우선한다. false면 첫 실패에 영구 기록, true면 retryAfter 또는 기본 15분, 미분류면 지수 backoff(1초~1시간)다. 임시·미분류 모두 최대 10회다(`packages/core/src/queue/drain.ts:134`, `packages/core/src/domain/work-item.ts:59`, `:95`, `:111`, `packages/core/src/domain/spool-record.ts:61`). 기본 claim은 10분이다.
- `failures retry`는 stage별로 `session_ingest`, `session_identity`를 알고 target fallback은 `session → session_ingest`뿐이다. **file 대상 매핑 없음**(`packages/core/src/capture/session-ingest-work.ts:31`). 미해결 실패를 읽어 stage 우선으로 매핑하고 중복을 합쳐 addWork한다. 알 수 없는 대상은 skipped로 보고한다(`packages/core/src/failures/retry.ts:73`, `:84`, `:94`, `:100`). input targetKind가 string인 것과 file 재시도가 구현된 것은 다르다.
- 첨부 메타데이터 spool record도 아직 없다. 현행 record kind는 session_ingest/failure뿐이며 첨부 metadata는 후속 확장 대상으로 명시한다(`packages/core/src/domain/spool-record.ts:70`). 바이너리를 spool로 보내는 구조로 확장해서는 안 된다(`:38`).

## 6. 가리기·확인 게이트·마스킹 B — 일부

- `messages redact`는 있음. 인수 검증 뒤 Core의 requireConfirmation을 호출하며 confirm=true가 아니면 쓰기 전에 멈춘다(`packages/core/src/messages/redact.ts:25`, `:35`, `:43`). 공통 게이트는 `CONFIRMATION_REQUIRED`와 동일 호출에 confirm=true를 더한 retry를 반환한다(`packages/core/src/envelope.ts:179`). CLI는 --yes를 confirm으로 옮기고 destructive/writes=true, drain=false, preflight를 등록한다(`apps/cli/src/commands/messages-redact.ts:4`, `:19`, `:26`).
- SQLite 연쇄는 메시지 본문·해당 도구 메모 target 갱신 → redactions 기록 → 메시지 시각을 포함하는 대화 chunks 삭제를 한 가리기 트랜잭션에서 한다(`packages/sqlite/src/sessions.ts:140`, `:152`, `:157`, `:163`, `:169`). 이후 WAL checkpoint(TRUNCATE)를 시도한다(`:171`). chunks FTS 삭제 trigger는 `packages/sqlite/migrations/0006_drop_message_seq.sql:166`에 있다.
- **첨부에 대한 경고·연쇄는 아직 없음.** 이 쓰기는 message_attachments/files/document_extractions/document_chunks/file_names/file_metadata를 조회·변경하지 않는다. Core 결과도 본문·메모·대화 조각 수만 반환한다(`packages/core/src/messages/redact.ts:15`, `:51`). files.redact 공개 기능도 없다(`packages/core/src/brain.ts:272`). 파일 바이트, 추출 세대·문서 조각, 이름·메타데이터를 제거하고 재생성을 막는 규칙이 새로 필요하다.
- **경고 코드 자체는 이미 있음.** `ATTACHMENT_NOT_REDACTED`가 코드 배열과 한국어 설명에 모두 등록돼 있다(`packages/core/src/codes.ts:59`, `:105`). 현재 설명은 “첨부가 받아야 할 마스킹 없이 저장”이다. 마스킹 B 이후 messages.redact 경고의 의미와 맞출지는 인셉션에서 확인할 사항이며, 새 경고 코드를 중복 추가할 필요는 없다.
- **마스킹 B 출력 자리 있음, 문서 전용 읽기 코덱 없음.** `maskOutputText`와 재귀 `maskOutputValue`가 있다(`packages/core/src/output/mask.ts:19`, `:40`). `OUTPUT_CODECS`는 envelope/hook/text를 등록하고 probe로 계약 검증하는 구조다(`packages/core/src/output/codecs.ts:20`, `:41`, `:72`). 현재 probe는 texts/toolNotes뿐이다. 문서 원문을 저장한 뒤 출력·검색 발췌 등으로 나갈 때 이 규칙을 적용하고 새 출력 경로를 등록해야 한다. 문서 원문을 수집 때 비가역 마스킹하는 구현은 없다.

## 7. CLI 이름공간·명령 메타·doctor — 일부

- **files 명령 없음.** 실제 commands registry에는 doctor, messages redact, failures, guide, queue drain, sessions ingest, setup만 있다(`apps/cli/src/commands/index.ts:30`). Core의 공개 조립에도 files가 없다(`packages/core/src/brain.ts:272`). 에픽 범위의 files reindex/redact를 새로 추가해야 한다. files show/url은 조사 대상 에픽의 경계 밖이다.
- 명령은 `CommandSpec` 객체 하나를 registry에 추가한다. 공통 dispatcher가 help·schema·write guard·envelope 등을 공급한다(`apps/cli/src/commands/index.ts:16`). 메타 필수 칸은 usedFor/required/examples/output/risk/hook/dryRun이며, ns/verb/options/arguments와 쓰기 여부·preflight도 선언한다(`apps/cli/src/dispatch.ts:224`, `:255`, `:271`). 검증 함수는 `apps/cli/src/dispatch.ts:979`에 있다.
- doctor 확장 구조는 있음. 외부 검사는 `{id, run(): Promise<DoctorCheck>}`로 주입한다(`packages/core/src/doctor/doctor.ts:82`). Core는 DB·어댑터 probes·schema·failures·untagged·transcripts를 모으고 options.checks를 순서대로 실행한다(`:146`, `:173`). CLI runtimeChecks는 config/shim/node-path/node-version/plugin/last-hook/spool 배열이며 dispatcher가 createBrain에 넣는다(`apps/cli/src/doctor/checks.ts:118`, `:130`, `apps/cli/src/dispatch.ts:584`).
- **고아 블롭 건수·바이트 검사 없음.** 현재 doctor의 Core/런타임 목록에 그런 검사나 첨부 저장소 의존성이 없다. FileStore 목록·stat과 위치 행 대조 기능을 만든 뒤 검사로 연결할 수 있다(연결 위치 선택은 추정).

## 8. 추출 라이브러리 의존성 — 없음

현행 package.json 직접 의존성에 PDF·docx·EXIF 추출/형식 sniffing 라이브러리는 없다. 패키지를 설치하거나 외부 후보를 비교한 조사는 하지 않았다.

- Core는 runtime dependencies 없이 TypeScript 개발 의존성만 있다(`packages/core/package.json:19`).
- parser 패키지와 모델 어댑터는 Core workspace 의존성뿐이다(`packages/claude-code/package.json:18`, `packages/modelstudio/package.json:18`).
- SQLite는 Core+kysely, Postgres는 Core+kysely+pg다(`packages/sqlite/package.json:19`, `packages/postgres/package.json:19`). 공개 조립 패키지도 내부 패키지만 참조한다(`packages/second_brain/package.json:26`).
- CLI 외부 의존성은 prompts/commander/TOML/UUID이고 추출기는 없다(`apps/cli/package.json:15`). 루트는 개발용 타입·TypeScript·테스트 도구뿐이다(`package.json:25`).

따라서 txt/md 외 PDF·docx·EXIF 실제 추출, 바이트 기반 형식 판정, extractor_version, 지원 불가·손상·암호화의 분류는 새 구현이다. 어디에 의존성을 둘지와 PDF/docx를 이번 에픽에 포함할지는 인셉션 결정 사항이다. 이 보고서는 형식별 성공률이나 실제 문서 내용은 검증하지 않았다.

## 9. 스토리 간 lane 중첩 — 일부 (아래는 추정)

아직 스토리를 확정하지 않았으므로 다음은 **현재 확장 지점에 근거한 추정**이다. 파일 소유권을 미리 나누거나 공통 계약을 선행 확정하면 충돌을 줄일 수 있다.

| 겹칠 파일·근거 | 겹칠 작업(추정) |
| --- | --- |
| `packages/core/src/ports/store.ts:718`, `packages/core/src/ports/index.ts:3`, `packages/sqlite/src/store.ts:80` | 파일·위치·첨부 저장, 추출 세대·조각 저장, 파일 가리기 모두 Store 능력·어댑터 조립을 확장한다. 공통 port와 결과형을 먼저 확정할 곳. |
| `packages/core/src/domain/ingest-batch.ts:14`, `packages/core/src/ports/parser.ts:9`, `packages/claude-code/src/parser.ts:627` | 첨부 parser, image-only 메시지의 연결 기준, 수집 batch, backfill이 같은 자료형·필터·버전 상수를 건드린다. |
| `packages/core/src/sessions/ingest.ts:288`, `packages/core/src/capture/scan.ts:41`, `packages/sqlite/src/sessions.ts:138` | 첨부 수집과 기존 세션 재읽기, 축소 transcript 정책, DB 메시지 연결의 멱등성이 겹친다. 파일 수집은 기존 메시지가 이미 있는 경우도 채워야 한다. |
| `packages/core/src/brain.ts:207`, `:225`, `:272` | 추출·고아 정리 handler, FileStore 의존성, files 공개 API, 일반 수집 실패 해소를 한 조립 파일에 추가한다. |
| `packages/core/src/capture/session-ingest-work.ts:31`, `packages/core/src/failures/retry.ts:84` | file 추출 실패 retry 등록과 재읽기/수집 실패 해소가 실패 stage·kind 매핑을 공유한다. 일반 큐 엔진을 복제할 필요는 없다. |
| `packages/core/src/domain/redaction.ts:6`, `packages/core/src/messages/redact.ts:51`, `packages/sqlite/src/sessions.ts:157`, `packages/core/src/codes.ts:105` | 파일 대상 표현 추가, files.redact와 messages.redact 경고가 redaction 결과·기록·경고를 함께 바꾼다. |
| `packages/core/src/output/mask.ts:19`, `packages/core/src/output/codecs.ts:72`, `packages/core/src/domain/index-config.ts:2` | 추출 조각과 후속 출력이 원문/가린 출력 구분·문서 조각 설정·locator 규칙을 공유한다. |
| `apps/cli/src/commands/index.ts:30`, `apps/cli/src/dispatch.ts:566`, `apps/cli/src/doctor/checks.ts:130`, `packages/core/src/doctor/doctor.ts:146` | files reindex/redact 등록, 로컬 FileStore 조립, 고아 검사 연결이 CLI 공통 조립부에서 겹친다. |
| `packages/core/src/testing/contracts/index.ts:1`, `packages/core/src/testing/fakes/store.ts:1` | 파일 저장·추출·가리기 계약과 fake 확장이 겹칠 가능성이 있다. 기존 기능을 깨지 않도록 공통 계약을 먼저 합의할 곳. |

추정 순서: 파일/첨부/추출 port·locator·redaction 계약 → FileStore와 DB 능력 → parser·수집/재읽기 → 추출·정리 일감 → files CLI·파일 가리기·doctor 통합. parser 버전 상승보다 재읽기 정책을 먼저 정해야 기존 종료 세션 backfill이 빠지지 않는다.

## 이 에픽이 새로 만들어야 하는 것

- FileStore port·계약·fake·로컬 구현: 내용 주소 locator, 임시 파일→rename, 디렉터리 0700/파일 0600, 루트 안·brain 소유만 쓰기/삭제, external 원본 보존.
- 파일·위치·첨부·이름·메타데이터 Core 자료형과 DB 능력, 첨부 출처·순서·메시지 연결 parser, 중복 콘텐츠 한 번 저장, missing_at_ingest 처리.
- 기존 메시지에도 첨부를 채우는 backfill, 크기가 그대로인 종료 세션의 parser 버전 재읽기, 일반 hook 수집 성공의 이전 실패 해소, 축소 transcript 재수집 정책.
- 문서 locator 타입·정규 코덱·page 사본 검증, document_chunk 설정 자료형과 배치 쓰기.
- 추출 handler·형식 판정·형식별 추출기·extractor_version: attempt 원자 증가, 만료 claim의 미종료 세대 닫기, 더 높은 attempt만 포인터 채택, 실패 세대 조각 정리, 영구/일시 오류 분류, file 재시도 매핑.
- 고아 블롭 유예·정리 일감과 doctor 건수/바이트 검사.
- Redaction의 fileId/null 범위, files.redact 확인 게이트·삭제 연쇄·재생성 방지, messages.redact의 첨부 경고 실제 발생 경로.
- files reindex/redact의 Core API·CLI 메타 등록, 문서 텍스트 출력의 마스킹 B 연결과 출력 계약 검증 확장.

## 이미 있어 재사용할 것

- SQLite 일곱 테이블, 고유키·FK·기본 변경 제한, 문서/이름 FTS5와 secure-delete 동기화 trigger(§1).
- 추출 attempt·failed_stage·index_config_id와 파일당 실행 중 세대 unique index, locator/page DB guard, 0005 failed_stage trigger(§1). 높은 attempt의 포인터 채택 동작까지 구현된 것은 아니다.
- TranscriptReader/Folder·transcript 내역, 멱등 수집과 버전 불일치 시 null cursor 전체 parse(§2~4).
- 단일 WorkStore·claim 만료/CAS·중복 방지·오류 분류/backoff·실패 기록/해소·failures retry의 확장 틀(§5).
- 공통 확인 게이트, messages.redact의 가리기 쓰기 트랜잭션과 계획 방식(§6).
- maskOutputText/maskOutputValue·OUTPUT_CODECS, 이미 등록된 ATTACHMENT_NOT_REDACTED/FILE_SOURCE_UNREACHABLE 경고(§6).
- CommandSpec 메타·registry·write guard, doctor의 주입 검사 목록(§7).
- Core의 SHA-256 바이트 함수와 기존 계약 테스트 구성 방식(§2, §9).
