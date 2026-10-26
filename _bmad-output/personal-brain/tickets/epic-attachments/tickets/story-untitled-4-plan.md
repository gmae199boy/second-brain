---
title: '@파일 첨부와 사용자 원본 위치'
type: 'feature'
ticket: '4'
created: '2026-10-26'
status: 'built'
baseline_revision: '2626a9347629c9628fbbdf3da00099ab60f4f8dd'
route: 'full'
route_source: 'auto'
risk: 'high'
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

**Problem:** 사용자가 @로 지정한 파일은 지금 아무 데도 남지 않는다. Claude Code parser(v5)는 `type: attachment` 줄을 대화가 아닌 줄로 버리고, 첨부 행에는 사용자 원본 위치(`external`)·`missing_at_ingest`를 쓸 길이 없으며, `file_names`·이름 FTS를 채우는 코드가 없어 10.2의 이미지 첨부도 이름으로 찾을 수 없다.

**Approach:** parser v6이 사용자 메시지에 사슬로 붙은 `attachment.type: 'file'` 줄을 그 메시지의 첨부로 내고, 수집이 "붙인 시점의 내용"을 원본으로 삼아(transcript에 전부 있으면 그 내용, 아니면 디스크 파일이 붙인 시점과 같은 크기일 때만 그 바이트, 아니면 `missing_at_ingest`) Brain 사본과 홈 아래 파일의 `external` 위치를 쓴다. spool `attachment_link`가 두 경우를 싣고, drain의 새 단계가 모든 첨부의 표시 이름과 `external` 경로를 `file_names`(이름 FTS는 0002 trigger가 따라감)에 멱등으로 채운다.

## Boundaries & Constraints

**Always:**
- **실측 형식(2026-10-26, 이 기계, 임시 폴더의 hook 없는 `claude -p` 세션).** @파일은 사용자 메시지 줄(`message.content`는 `"@note.md …"` 문자열) 뒤에 별도 `attachment` 줄로 오고, 첫 줄의 `parentUuid`가 그 메시지 `uuid`, 다음 줄은 앞 첨부 줄의 `uuid`를 가리킨다(뒤로 `environment`·`skill_listing` 같은 다른 첨부 줄이 이어짐). 모양: `{ type:'file', filename:<절대 경로>, displayPath:<cwd 기준>, truncated?:true, content:{ type:'text', file:{ filePath, content, numLines, startLine, totalLines } } }`, 이미지는 `content:{ type:'image', file:{ base64, type:'image/png', originalSize, dimensions } }`, PDF는 `content:{ type:'pdf', file:{ filePath, base64:'', originalSize } }`(바이트 없음). 6,001줄 텍스트는 `truncated:true`, `numLines:2000`. 없는 파일·20MB 이미지는 첨부 줄이 아예 없다. 폴더는 `type:'directory'`. 이 기계 transcript의 기존 `type:'file'` 5건은 모두 compact 요약(`isCompactSummary`) 사슬 아래의 복원 파일이었다.
- **parser v6(`packages/claude-code/src/parser.ts`).** `CLAUDE_CODE_PARSER_VERSION = '6'`. 이 parse가 남긴 사용자 메시지 uuid와, 그 사슬에 이어진 첨부 줄 uuid를 같은 뿌리 메시지에 묶는 지도(첨부 줄은 `parentUuid`가 뿌리 메시지거나 이미 뿌리가 정해진 첨부 줄일 때만 뿌리를 물려받음, 종류와 상관없이). 뿌리가 있는 `attachment.type === 'file'` 줄만 첨부를 낸다. compact 요약·`isMeta`·sidechain·도구 결과 아래 사슬, 이 parse에서 읽지 않은 메시지(커서 앞) 아래 줄은 첨부가 아니다. `directory`·`edited_text_file`·`compact_file_reference`는 첨부가 아니다. `ordinal`은 그 메시지의 붙여 넣은 이미지 수 + 그 메시지의 @파일 순서(파일 순서, 0부터). `sourceKind: 'file'`, `sourceRef`는 첨부 줄의 `uuid`, `displayName`은 `filename`의 마지막 마디(비면 null). 첨부 줄은 지금처럼 `not_conversation`으로 센다(drop 키 그대로). 형식이 어긋난 첨부 줄은 첨부 없이 넘어가고 parse는 던지지 않는다.
- **바이트 규칙(parser가 정함).** transcript에 전부 있음 = 텍스트는 `truncated !== true && startLine === 1 && numLines === totalLines`이고 바이트는 `content`의 UTF-8; 그 밖(이미지·pdf·모르는 형식)은 `base64`가 비지 않고 올바르며 디코드 길이가 `originalSize`와 같을 때 그 바이트(base64 검사는 10.2의 선형 검사를 함께 쓴다). 아니면 `bytes: null`과 디스크 확인값 `sourceCheck`: 텍스트는 `{ lineCount: totalLines }`, 그 밖은 `originalSize`가 0 이상 정수일 때 `{ sizeBytes: originalSize }`, 확인값이 없으면 null.
- **자료형(`domain/ingest-batch.ts`).** `ParsedAttachment`에 `bytes: Uint8Array | null`, `sourcePath: string | null`(하네스가 읽은 절대 경로, `/`로 시작할 때만; 붙여 넣은 이미지는 null), `sourceCheck: { sizeBytes: number } | { lineCount: number } | null`. `IngestAttachment`는 `bytes`·`sourcePath`·`sourceCheck`를 빼고 `file: { id; contentHash; sizeBytes; location: FileLocation & { id }; external: (FileLocation & { id }) | null } | null`(null = `missing_at_ingest`). parser 계약(`testing/contracts/parser.ts`)에 "`bytes`가 null이면 `sourcePath`가 있다"를 더하고 `memoryParser`가 새 칸을 받게 한다.
- **원본 읽기 port(`ports/source-file.ts`, 새 파일).** `SourceFileReader.read(path, maxBytes) → { ok: true; bytes } | { ok: false; message }`, 던지지 않음. CLI 구현 `apps/cli/src/runtime/source-file.ts` `fileSourceReader()`: 읽기 전용으로 열고, 링크는 따라가되 일반 파일만, 크기가 `maxBytes`를 넘으면 읽지 않음. 쓰기·이름 바꾸기·지우기·권한/시각 변경 없음.
- **수집(`sessions/ingest.ts`).** 첨부마다: `bytes`가 있으면 그것; 없고 `sourcePath`·`sourceCheck`가 있으면 `sources.read(sourcePath, MAX_SOURCE_FILE_BYTES = 32 MiB)`가 성공하고 확인값이 맞을 때(바이트 수, 또는 `0x0A` 수 + 1 = 줄 수) 그 바이트; 그 밖은 `file: null`. 바이트가 있으면 지금처럼 같은 해시는 한 번 `files.put`(실패면 `FILES_UNAVAILABLE`), 그리고 `externalLocator(sourcePath, userHome)`이 null이 아니면 `external: { storeKind:'local', ownership:'external', locator }`. `BrainDependencies`·`IngestSessionDependencies`에 선택 칸 `sources?: SourceFileReader`(없으면 늘 실패하는 기본값)와 `userHome?: string | null`(기본 null). `apps/cli/src/dispatch.ts`는 `fileSourceReader()`와 `env.HOME`(`/`로 시작할 때만)을 넣는다.
- **쓰기(`packages/sqlite/src/attachments.ts`, fake store).** `(message_id, ordinal)`이 이미 있으면 지금처럼 건드리지 않는다. `file: null`이면 `file_id` null·`status 'missing_at_ingest'`로 넣는다. `external`이 있으면 같은 파일에 그 위치를 `(file_id, store_kind, locator)` 충돌이면 그대로 두고 넣는다(`home_location_id`는 brain 위치만). `MessageAttachment.file`에 `locations: readonly FileLocation[]`(ownership, locator 순)을 더한다.
- **spool `attachment_link`(`domain/spool-record.ts`, `sessions/spool-ingest.ts`, `brain.ts` handler).** payload에 `status: 'stored' | 'missing_at_ingest'`와 `externalLocator: string | null`(JSON `status`, `external_locator`; 없으면 `stored`·null로 읽음). `missing_at_ingest`면 해시·크기·store_kind·locator·ownership·external이 모두 null이어야 하고, `stored`면 지금 검사 그대로에 `externalLocator`는 null이거나 `isExternalLocator`. 절대 경로는 payload에 없다. handler는 이 둘로 `IngestAttachment`를 만든다.
- **이름 채우기(drain 단계, 새 Core 파일 `files/file-names.ts`).** `AttachmentStore`에 잠금 없는 읽기 `listMissingFileNames({ limit })` → `{ fileId; nameSource: 'attachment_name' | 'location_path'; text }[]`(가리지 않은 파일의, 첨부의 null 아닌 `display_name`과 `local`·`external` 위치의 locator 가운데 `file_names`에 아직 없는 것)와 쓰기 `writeFileNames({ names: { id; fileId; nameSource; text }[] })` → `{ ok: true; inserted } | { ok:false; code:'DB_UNAVAILABLE'|'DB_LOCKED'; message }`(한 트랜잭션, `(file_id, name_source, text)` 충돌 무시, `files.redacted_at`이 있는 파일은 건너뜀 — 0008 trigger에 닿지 않게; 가드는 12가 검증). 읽기 `listFileNames(fileId)`도 둔다(계약용). `brain.ts` `drain`은 identity 후보 다음·queue 앞에서 마감 안에 한 번 부르고(한도 500), 실패는 버린다(다음 drain이 다시). `BrainDrainReport` 모양은 그대로. 4와 5의 채우기는 모두 첨부 행을 거쳐 이 단계로 이름을 얻는다.
- **조립과 껍데기.** fake store·SQLite store·`apps/cli/src/doctor/store.ts`(`unavailable`)·`testing/contracts/attachment-store.ts`에 새 능력. Core export(`domain/index.ts`, `ports/index.ts`, `index.ts`)에 새 타입·port·상수.
- **문서.** README 수집 절에 @파일이 붙인 시점의 내용으로 한 번 남고 홈 아래 파일은 원래 자리가 `~/` 경로로 기록되며 사용자 파일은 옮기거나 바꾸지 않는다는 것, 원본을 얻지 못하면 `missing_at_ingest`라는 것을 한국어로 더한다. 아키텍처 AD-23 셋째 항목 근처에 원본 규칙 한 문장. 출력 언어 검사·README 코드 대조가 통과해야 한다.
- 시험의 경로·내용은 임시 폴더와 중립 값이다(가짜 `HOME`은 임시 폴더). 시험 fixture에 실제 transcript를 쓰지 않는다.

**Never:**
- 마이그레이션, 새 공개 오류·경고 코드, CLI 명령·`IngestCounts`·`queue drain` 출력 모양 변경을 하지 않는다.
- 사용자 파일을 쓰거나 옮기거나 지우거나 권한·시각을 바꾸지 않는다. `external` 위치를 FileStore로 읽거나 지우게 하지 않는다.
- 절대 경로를 DB·spool·로그·문서·시험 기대값에 남기지 않는다(`sourcePath`는 메모리에서만).
- 블롭 쓰기·디스크 읽기를 DB 트랜잭션 안에서 하지 않는다(AD-7). 이미 저장된 메시지·첨부 행을 고치지 않는다(AD-11, 0008).
- `directory`·`edited_text_file`·`compact_file_reference`·compact 복원 파일을 첨부로 만들지 않는다. 이미 수집한 세션 채우기 일감(5), 추출(7·8·14), 가리기(12)는 하지 않는다. Postgres는 손대지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 홈 아래 텍스트 @파일 | 사용자 메시지 + 전체가 든 `text` 첨부 줄, 파일은 가짜 HOME 아래 | 첨부 `stored`(`source_kind` `file`, `source_ref` 줄 uuid, 이름은 파일 이름), 블롭 = transcript 내용, 위치 `brain`(home) + `external` `~/…` | 없음 |
| 홈 밖 파일 | `filename`이 홈 밖(예: `/tmp/…`) | `stored`, `brain` 위치만 | 없음 |
| 붙인 뒤 디스크가 바뀜 | 전체가 든 텍스트, 디스크 내용은 다름 | 블롭 = transcript 내용(디스크를 읽지 않음) | 없음 |
| 잘린 텍스트, 디스크 같음 | `truncated`, 디스크 줄 수 = `totalLines` | 블롭 = 디스크 바이트 | 없음 |
| 잘린 텍스트, 파일 사라짐 | `truncated`, 디스크에 없음 | `missing_at_ingest`, `file_id` null | 없음 |
| PDF | `base64:''`, `originalSize` = 디스크 크기 / 다름 | 디스크 바이트로 `stored` / `missing_at_ingest` | 없음 |
| @이미지 | `image`, 디코드 길이 = `originalSize` | 그 바이트로 `stored`; 같은 바이트를 붙여 넣은 이미지와 `files` 1행 공유 | 없음 |
| 자리 | 붙여 넣은 이미지 1 + @파일 2 | ordinal 0(이미지), 1, 2(@파일 순) | 없음 |
| 첨부 아닌 줄 | compact 요약 사슬의 `file`, `directory`, sidechain, 커서 앞 메시지의 사슬 | 첨부 없음 | 없음 |
| 다시 수집 | 같은 transcript 두 번, v5로 저장된 세션 | 행·블롭 수 그대로; v5 세션은 다시 읽혀 기존 메시지에 @파일 첨부가 붙음 | 없음 |
| 32 MiB 넘는 원본 | 디스크 fallback 대상이 큼 | `missing_at_ingest` | 없음 |
| DB 잠김 | 블롭·디스크 읽기 뒤 `ingest`가 DB_LOCKED | `SPOOLED`; 한 spool 파일에 `session_ingest` 다음 `attachment_link`(stored·external, missing 포함) | drain 뒤 직접 수집과 같은 행 |
| 이름 채우기 | 첨부·external 위치가 있는 파일, 가린 파일 | drain 뒤 `file_names`에 `attachment_name`·`location_path`, FTS `MATCH`로 찾음; 두 번째 drain은 0행; 가린 파일은 쓰지 않음 | 쓰기 실패는 버리고 다음 drain |

</intent-contract>

## Code Map

- `/tmp/brain-probe/at-samples.jsonl` -- 실측 줄 9개(사용자 메시지·`file`·`directory`, 중립 내용, 이 기계에만 있음). 시험 fixture는 이 모양을 본떠 새로 만든다.
- `packages/claude-code/src/parser.ts` -- 버전(:66), parse 루프(:309–470; `seen`(:327), `readMessage` 뒤 이미지 첨부(:417)), `readMessage`(:631; 빈 본문 관문 :656), `readAttachments`(:1085, base64 검사·`imagePasteIds`). 첨부 줄은 지금 `readMessage`가 `not_conversation`으로 돌린다. 뿌리 지도와 @파일 첨부를 이 루프에 더한다.
- `packages/claude-code/test/parser.test.ts` -- 첨부 시험·`parserContract` 등록. fixture는 `test/fixtures/*.jsonl` 또는 시험 안에서 만든 줄.
- `packages/core/src/domain/ingest-batch.ts:186–204` -- `IngestBatch.attachments`, `ParsedAttachment`, `IngestAttachment`.
- `packages/core/src/domain/file.ts` -- `contentHashOfBytes`, `brainLocator`, `externalLocator`·`isExternalLocator`(10.3).
- `packages/core/src/ports/file-store.ts` -- 그대로. 새 `ports/source-file.ts`는 `ports/transcript.ts`의 "값으로 답하고 던지지 않음" 모양을 따른다.
- `packages/core/src/sessions/ingest.ts` -- 의존성(:121), 흐름(:207), `nothingToStore`(:335), 첨부 넣기 루프(:384–398), `afterParse.attachments`.
- `packages/core/src/sessions/spool-ingest.ts:83–95` -- `attachment_link` 만들기.
- `packages/core/src/domain/spool-record.ts` -- `encodePayload`(:289), 디코드(:423), `AttachmentLinkSpoolPayload`·`decodeAttachmentPayload`(:565–591).
- `packages/core/src/brain.ts` -- `BrainDependencies`(:44), `ingestDependencies`(:199), `attachment_link` handler(:262), `drain`(:362; identity 후보 :392–402 다음에 이름 단계).
- `packages/core/src/ports/store.ts:766–781` -- `MessageAttachment`, `AttachmentStore`.
- `packages/core/src/testing/fakes/store.ts:161–182, :402–410, :458` -- 첨부 fake. `packages/core/src/testing/contracts/attachment-store.ts` -- 계약 두 사례. `packages/core/src/testing/fakes/parser.ts:108`, `testing/contracts/parser.ts`.
- `packages/sqlite/src/attachments.ts` -- `writeAttachments`(ingest·`linkAttachments` 공유), `listMessageAttachments`. 새 이름 읽기·쓰기도 여기.
- `packages/sqlite/migrations/0002_files_and_work.sql` -- `file_locations`(:144), `message_attachments`(:189, `stored` ↔ `file_id`), `file_names`(:273), `file_names_fts`와 trigger(:470–488). `0008_attachment_rules.sql:58–69` 가린 파일 이름 쓰기 거부. 읽기만.
- `packages/sqlite/src/write.ts` `withWrite`, `connect.ts` `describe`.
- `apps/cli/src/dispatch.ts:563–590` -- 의존성 조립(`env` 있음). `apps/cli/src/runtime/file-store.ts`·`spool.ts` -- 런타임 구현 본보기. `apps/cli/src/doctor/store.ts:56` -- 껍데기.
- `apps/cli/test/sessions-ingest.test.ts` -- `runBrain`·`installedHome`·`transcriptIn`·`stopPayload`·`rowCounts`, 10.2의 이미지·잠금·drain 사례. `apps/cli/test/file-store.test.ts` -- 임시 폴더 도우미.
- `README.md` -- 수집 절(10.2가 이미지 문장을 더한 곳), spool 절.
- `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md:365–370` -- AD-23 항목.

## Tasks & Acceptance

**Execution:**
- [ ] `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/source-file.ts`(새), `packages/core/src/ports/store.ts`, export 파일 -- 새 칸·port·`MessageAttachment.file.locations`·이름 능력 -- parser·수집·Store의 약속.
- [ ] `packages/claude-code/src/parser.ts`와 `packages/claude-code/test/parser.test.ts` -- v6 뿌리 지도·@파일 첨부·바이트 규칙 -- I/O 표의 parser 줄(자리, 첨부 아닌 줄, 전체·잘림·pdf·이미지 판정, 형식 어긋남).
- [ ] `packages/core/src/testing/{contracts/parser,fakes/parser}.ts` -- 계약 한 줄과 fake 칸.
- [ ] `packages/core/src/sessions/ingest.ts`, `packages/core/src/sessions/spool-ingest.ts`, `packages/core/src/domain/spool-record.ts`, `packages/core/src/brain.ts` -- 디스크 fallback·확인값·external·missing, spool 두 칸, handler, 조립 기본값.
- [ ] `packages/core/src/files/file-names.ts`(새), `packages/core/src/brain.ts` drain -- 이름 단계.
- [ ] `packages/sqlite/src/attachments.ts`, `packages/sqlite/src/store.ts`(필요하면), `packages/core/src/testing/fakes/store.ts`, `apps/cli/src/doctor/store.ts`, `packages/core/src/testing/contracts/attachment-store.ts` -- missing·external 쓰기, 위치 목록, 이름 읽기·쓰기 -- fake·SQLite가 같은 계약.
- [ ] `apps/cli/src/runtime/source-file.ts`(새), `apps/cli/src/dispatch.ts` -- 읽기 전용 원본 읽기와 `HOME` 주입.
- [ ] 시험 -- Core(`sessions-ingest`, `brain-drain`, `spool-record` 왕복·옛 줄 읽기·missing 검증), SQLite(가린 파일 이름 건너뜀, FTS `MATCH`), CLI(아래 AC, 원본 읽기 구현의 링크·폴더·크기 상한).
- [ ] `README.md`, 아키텍처 AD-23 -- 문장.

**Acceptance Criteria:**
- Given 설치한 임시 home, 가짜 `HOME` 아래 프로젝트 폴더의 `note.md`·`pic.png`(붙여 넣은 png와 같은 바이트)·`doc.pdf`·`long.txt`와 가짜 `HOME` 밖 임시 폴더의 텍스트 파일, 그리고 한 사용자 메시지에 붙여 넣은 png 하나와 @파일 다섯(전체 텍스트 `note.md`, 크기가 맞는 @이미지 `pic.png`, `base64:''`인 `doc.pdf`, 수집 전에 디스크에서 지운 잘린 `long.txt`, 홈 밖 전체 텍스트)이 사슬로 붙은 transcript, when Stop hook 입력으로 `brain sessions ingest claude-code --json`, then 그 메시지의 첨부는 자리 0–5이고 `stored` 다섯·`missing_at_ingest` 하나이며, `files`는 넷(png는 붙여 넣은 것과 @이미지가 한 행), `file_locations`에 홈 아래 세 파일의 `external` 위치(`~/` locator, 절대 경로 없음)가 있고, 남은 사용자 파일의 경로·바이트·mtime이 수집 전과 같다.
- Given 같은 설치, when 같은 명령을 다시, then 블롭·`files`·위치·첨부 수가 그대로다.
- Given 다른 프로세스가 DB 쓰기 잠금을 쥔 상태, when 같은 transcript를 수집하면 `SPOOLED`이고, 잠금을 푼 뒤 `brain queue drain --json`, then 첨부·위치 행이 잠그지 않고 수집한 설치와 같고 spool은 비었다.
- Given 수집을 마친 설치, when `brain queue drain --json`, then `file_names`에 @파일 이름들과 `~/…` 경로가 있고 `file_names_fts`의 `MATCH`로 `note.md`의 이름·경로와 @이미지 `pic.png`의 이름·경로를 찾으며, 다시 drain해도 `file_names` 행 수가 그대로다.

## Implementation Notes

- 구현(2026-10-26): parser v6이 보존한 사용자 메시지에서 시작하는 첨부 사슬과 전체 텍스트·base64 바이트 판정을 구현했다. Core는 읽기 전용 `SourceFileReader`로 32 MiB 이하 fallback의 줄 수·크기를 확인하고, Brain 사본·홈 상대 external 위치 또는 `missing_at_ingest`를 기록한다.
- SQLite와 memory store의 첨부·위치·이름 능력, drain의 500건 이름 채우기, 이름 FTS 멱등성, CLI의 원본 읽기와 HOME 조립을 연결했다. README와 AD-23에 원본 규칙을 기록했다.
- spool의 stored/missing 상태와 external locator를 왕복하며 옛 줄도 읽는다. 재주입이 디스크를 다시 읽어 처음 확정한 상태를 바꾸지 않도록 replay handler에 같은 spool 파일의 레코드 문맥을 넘기고, 이 parse가 읽은 메시지의 첨부는 저장된 연결 결과를 우선한다. 사슬 밖 연결은 기존 attachment_link 재시도를 유지한다.
- 검증: `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 통과(74개 파일, 2,335개 시험). 샌드박스의 loopback listener·bootstrap 설치 제약 때문에 전체 시험은 허용된 샌드박스 밖 실행으로 확인했다. 출력 언어·README 코드 대조도 이 묶음에 포함된다.
- CLI 인수 시험은 0–5 자리, stored 다섯·missing 하나, PNG 중복 제거로 files 넷, external 위치 셋, 재수집·잠금 재주입·이름/경로 FTS·사용자 파일 바이트와 mtime 보존을 확인한다. 원본 읽기의 링크·폴더·상한, 가린 파일 이름 쓰기 건너뛰기, 대기 중 원본 변경도 시험했다.
- 남은 작업 없음. 실제 사용자 세션을 이용하는 수동 확인과 Postgres 시험은 실행하지 않았다(계획의 자동 검증 범위 밖). fallback의 줄 수·바이트 수가 같아도 내용이 달라질 수 있는 한계는 계획의 원본 판정 규칙 그대로다. 커밋하지 않았다.
- 코디네이터(2026-10-26): diff 전체를 읽고 `pnpm build`·`pnpm typecheck`·non-Postgres vitest(74개 파일·2,335개)·`git diff --check`·절대 홈 경로 검사를 다시 돌려 통과했다. 구현은 codex 워커(Orca run `run_bf9e9eb213b6`)가 했고, 첫 턴이 공급자 오류(모델 용량 초과)로 멈춰 같은 워커에게 이어서 하라고 보내 마쳤다. I/O 표의 "다시 수집" 줄 가운데 옛 parser 버전 세션의 기존 메시지에 @파일이 붙는 경우는 이미지로만 시험되어 있어, Core `sessions-ingest.test.ts`에 @파일 사례 하나를 더했다.
- 코디네이터(2026-10-26, 리뷰 패치): `packages/core/src/sessions/ingest.ts`에 `existingAttachmentPositions`를 더해 이미 채운 첨부 자리는 원본을 다시 읽거나 넣지 않게 했고, `packages/core/test/sessions-ingest.test.ts`에 회귀 시험 두 개를 더했다. 다시 돌린 검증: build·typecheck 통과, non-Postgres vitest 74개 파일·2,338개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 1 findings — high 0, medium 1, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 이미 `stored`이거나 `missing_at_ingest`인 @파일 자리를 다시 수집하면, 디스크 fallback이 이번에는 확인값을 통과할 때(사라졌던 원본이 같은 크기로 다시 생김, 또는 같은 크기·줄 수의 다른 내용으로 바뀜) 원본을 다시 읽고 `files.put`을 해, SQLite·fake 쓰기가 기존 `(message, ordinal)`을 건너뛰므로 행 없는 블롭이 남는다(`packages/core/src/sessions/ingest.ts` 첨부 루프) — 코디네이터가 코드로 확인(루프는 spool 우선값만 보고, `writeAttachments`는 :13–14에서 채운 자리를 건너뜀). 앞으로 parser 버전이 오를 때마다 다시 읽기에서 최대 32 MiB씩 쌓일 수 있다. 구현 워커는 완료된 채팅 세션이라 다시 쓸 수 없어 코디네이터가 직접 고쳤다: 세션이 이미 있고 디스크 읽기가 필요한 첨부가 있을 때만 기존 `readSession`·`listMessageAttachments`로 이미 채운 자리를 찾아 읽기·넣기·batch·spool에서 빼고, 그 읽기가 실패하면 지금 동작을 유지한다(`IngestSessionDependencies.store`에 `Pick<AttachmentStore, 'listMessageAttachments'>`). Core 회귀 시험 두 사례를 더했고, 고친 줄을 끄면 두 시험이 실패하는 것을 확인했다.

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) **@파일의 원본은 붙인 시점의 내용이다.** transcript가 파일 전체를 담으면(전체 텍스트, 크기가 맞는 이미지) 그 내용을 쓰고 디스크는 읽지 않는다. 그래야 다시 읽어도 같은 해시이고(10.1·10.5의 다시 읽기, 커서 메시지 다시 읽기), 에이전트가 같은 턴에 고친 파일이 붙인 내용을 덮지 않는다. transcript에 없을 때만(잘린 텍스트, 바이트 없는 pdf) 디스크를 읽고, 붙인 시점에 기록된 크기(줄 수·바이트 수)와 같을 때만 원본으로 받는다. 다르거나 없으면 붙인 내용은 잃은 것이므로 `missing_at_ingest`(확정 기록, 2026-10-22 결정). 티켓 verify의 "파일이 사라진 @파일"은 이 디스크 fallback 경우다 — 없는 파일을 @로 지정하면 Claude Code는 첨부 줄을 남기지 않는다(실측).
- Decision(같은 날) `source_kind`는 하네스의 첨부 종류 `file`, `source_ref`는 그 첨부 줄의 `uuid`(하네스가 준 안정한 정체), `display_name`은 파일 이름 마디만이다. `displayPath`는 cwd 밖이면 절대 경로가 될 수 있어 쓰지 않고, 경로는 `external` locator가 이름 색인에 들어간다.
- Decision(같은 날) 이름 색인의 `location_path`는 `local`·`external` 위치의 `~/` locator만이다. brain locator는 해시 경로라 이름이 아니고, drive 경로는 epic 8 몫이다. 붙여 넣은 이미지는 이름도 원래 위치도 없어 이름 행이 없다.
- Decision(같은 날) 이름 채우기는 일감 행이 아니라 drain의 한 단계(잠금 없는 후보 읽기 → 한 쓰기 트랜잭션)다. 파생물이고 집합으로 한 번에 채울 수 있어, 첨부를 쓴 모든 경로(수집, spool 재주입, 5의 채우기)가 따로 일감을 넣지 않아도 된다. 실패는 다음 drain이 다시 한다.
- 크기 상한 32 MiB는 Claude의 PDF 한도에 맞춘 값이다. 넘으면 `missing_at_ingest`(상태 집합이 둘뿐이고 마이그레이션이 없음).
- 사슬 지도 예시: `user(u1)` → `file(a1, parent u1)` → `file(a2, parent a1)` → `environment(a3, parent a2)` → `file(a4, parent a3)`이면 a1·a2·a4가 u1의 @파일(ordinal = u1의 이미지 수 + 0, 1, 2). `user(isCompactSummary, c1)` → `file(b1, parent c1)`은 c1이 지도에 없어 첨부가 아니다.

## Verification

**Commands:**
- `pnpm build && pnpm typecheck` -- expected: 통과.
- `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` -- expected: 모두 통과(이 기계에 Docker가 없어 Postgres 제외; Postgres는 첨부를 구현하지 않으며 타입은 typecheck가 본다).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

**Manual checks (if no CLI):**
- 실제 Claude Code 세션에서 홈 아래 파일을 @로 지정한 뒤 개발용 Stop hook으로 수집해 첨부·`external` 위치·이름 행을 본다(사람 확인, 이 스토리의 hitl 아님).

## Auto Run Result

Status: built

- 요약: 사용자가 @로 지정한 파일이 첨부로 남는다. Claude Code parser v6이 이 parse가 남긴 사용자 메시지에서 시작하는 `attachment` 줄 사슬(`parentUuid`)을 따라 `type: 'file'` 줄을 그 메시지의 첨부로 낸다(자리는 붙여 넣은 이미지 다음, `source_kind` `file`, `source_ref`는 첨부 줄 uuid, 이름은 파일 이름 마디; compact 복원 파일·`directory`·sidechain·커서 앞 메시지는 제외). 원본은 붙인 시점의 내용이다 — transcript에 전부 있으면(전체 텍스트, 크기가 맞는 base64) 그 바이트, 아니면(잘린 텍스트, 바이트 없는 pdf) 새 읽기 전용 `SourceFileReader`로 32 MiB 이하 디스크 파일을 읽어 줄 수·바이트 수가 기록과 같을 때만, 그 밖은 `missing_at_ingest`. 저장한 첨부는 Brain 사본과 함께 홈 아래 파일이면 `external` 위치(`~/` locator)를 남기고, 사용자 파일은 읽기만 한다. spool `attachment_link`는 `status`·`external_locator`를 싣고(옛 줄은 `stored`로 읽음), 재주입은 같은 spool 파일의 연결 결과를 디스크 다시 읽기보다 우선한다. drain의 새 단계가 첨부 이름과 `external` 경로를 `file_names`(이름 FTS는 0002 trigger)에 멱등으로 채우고 가린 파일은 건너뛴다. 마이그레이션 없음.
- 바뀐 파일:
  - `packages/claude-code/src/parser.ts` — v6, 첨부 사슬 지도, @파일 첨부와 바이트·확인값 규칙, base64 검사 공유.
  - `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/source-file.ts`(새), `packages/core/src/ports/store.ts`, `packages/core/src/ports/index.ts`, `packages/core/src/index.ts` — `bytes | null`·`sourcePath`·`sourceCheck`, 원본 읽기 port, `file: null`·`external`, `MessageAttachment.file.locations`, 이름 읽기·쓰기 능력, `MAX_SOURCE_FILE_BYTES`.
  - `packages/core/src/sessions/ingest.ts` — 디스크 fallback·확인값·external·missing, spool 우선값, 이미 채운 자리 건너뛰기.
  - `packages/core/src/sessions/spool-ingest.ts`, `packages/core/src/domain/spool-record.ts`, `packages/core/src/spool/replay.ts`, `packages/core/src/brain.ts` — spool 두 상태, replay handler 문맥, 조립(`sources`·`userHome`), drain 이름 단계.
  - `packages/core/src/files/file-names.ts`(새) — 이름 채우기.
  - `packages/sqlite/src/attachments.ts` — missing·external 쓰기, 위치 목록, 이름 후보·쓰기(가린 파일 건너뜀)·읽기.
  - `packages/core/src/testing/{fakes/store,fakes/parser,contracts/attachment-store,contracts/parser}.ts` — fake·계약.
  - `apps/cli/src/runtime/source-file.ts`(새), `apps/cli/src/dispatch.ts`, `apps/cli/src/doctor/store.ts` — 읽기 전용 원본 읽기, `HOME` 주입, 진단 store 껍데기.
  - `README.md`, 아키텍처 AD-23 — @파일 원본 규칙.
  - 시험: `packages/claude-code/test/parser.test.ts`, `packages/core/test/{sessions-ingest,brain-drain,spool-record}.test.ts`, `packages/sqlite/test/{session-store,schema-0008}.test.ts`, `apps/cli/test/{sessions-ingest,source-file,dispatch}.test.ts`.
- 리뷰: Quick 렌즈(codex 워커) 지적 1건 — medium 1건 패치(이미 채운 자리의 원본 다시 읽기가 행 없는 블롭을 남김). 미룸 0, 반려 0.
- 후속 리뷰 권장: false(첫 리뷰에서 patch는 medium 1건, high 0건).
- 검증(코디네이터가 패치 뒤 다시 돌림): `pnpm build`·`pnpm typecheck` 통과, `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 74개 파일·2,338개 통과, `git diff --check` 통과, 더한 줄에 절대 홈 경로 없음. 이 기계에 Docker가 없어 Postgres 시험은 돌리지 않았다(Postgres는 첨부를 구현하지 않고 타입은 typecheck가 봄). I/O 표 열세 줄 모두 시험이 있다(parser 사슬·판정, Core 원본 선택·옛 버전 다시 읽기·spool, SQLite 이름·가림, CLI 인수 시험).
- 구현: codex 워커(Orca run `run_bf9e9eb213b6`). 첫 턴이 공급자 오류(모델 용량 초과)로 멈춰 같은 워커에게 이어서 하라고 보냈다. 계획 밖으로 더한 것은 spool 재주입이 같은 파일의 연결 결과를 우선하는 경로(replay handler에 같은 파일의 레코드 문맥)로, "붙인 시점의 내용" 결정을 재주입에도 지키기 위한 것이다.
- 실측: 2026-10-26 임시 폴더에서 hook을 끈 `claude -p`(haiku) 세 번으로 @파일 줄 모양을 확인하고 그 transcript는 지웠다. 이 기계 transcript의 기존 `type: file` 5건은 모두 compact 복원 파일이라 @파일이 아니었다(epic-capture 조사 §4의 "@파일 5건"은 이것으로 보인다).
- 남은 위험:
  - parser 버전이 6이 되어, 설치된 플러그인이 이 커밋을 받은 뒤 첫 drain이 v5로 저장된 닫힌 세션을 transcript가 남은 만큼 모두 다시 읽는다(10.1의 경로). 이 기계 transcript에는 @파일이 없어 채워질 첨부는 거의 없다.
  - 디스크 fallback은 줄 수·바이트 수만 비교하므로, 붙인 뒤 같은 크기의 다른 내용으로 바뀐 파일을 처음 수집할 때 그 바뀐 내용이 원본으로 남을 수 있다(계획의 판정 규칙 그대로). 한 번 채운 자리는 다시 바뀌지 않는다.
  - 이름 채우기의 쓰기가 잠금 아닌 DB 오류로 던지면 drain 전체가 그 예외로 끝난다(SQLite `withWrite`의 관례). 실제로는 DB가 망가진 경우뿐이다.
  - 전체 텍스트 첨부는 transcript의 문자열을 UTF-8로 저장하므로, CRLF·BOM이 있는 파일은 Claude Code가 준 텍스트 그대로이고 디스크 바이트와 해시가 다를 수 있다.
  - Postgres는 새 Store 능력을 구현하지 않는다(epic 7).
