---
title: 'chunk_locator 코덱과 문서 조각 자료형'
type: 'feature'
ticket: '7'
created: '2026-10-26'
status: done
baseline_revision: '5567c9d3af3e779fb2cf40fde024688315087fbf'
route: 'full'
route_source: 'auto'
risk: 'low'
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

**Problem:** 문서 조각의 위치(`document_chunks.chunk_locator`)는 0004가 "정규형 JSON 한 철자만" 받도록 막아 두었지만, 그 정규형을 만드는 Core 코덱과 종류별 필수 키 검사, `page` 사본 규칙, 문서 조각 설정 자료형이 없다. 14(추출 세대 Store)와 8(txt·md 추출기)이 이것 없이는 조각을 쓸 수 없다.

**Approach:** Core 도메인에 `chunk_locator` 자료형(text·pdf·docx)과 정규형 코덱(인코드·디코드), `page` 사본·비교 규칙, 문서 조각 설정(`IndexConfigKind`의 `document_chunk`)·문서 추출·조각 행 자료형을 두고 공개 export한다. Core 단위 시험과, 코덱 출력이 실제 마이그레이션된 SQLite의 `document_chunks`를 통과하는 시험을 둔다.

## Boundaries & Constraints

**Always:**
- 정규형: `type`이 첫 키, 종류별 고정 키 순서(pdf `type,page,bbox` / docx `type,block` / text `type,start,end`), 값이 null·undefined인 키는 생략, 공백 없음(`JSON.stringify` 결과). 입력의 키 순서는 결과에 영향이 없다.
- 종류별 필수 키: pdf `page`, docx `block`, text `start`·`end`. pdf `bbox`만 선택. null이 아닌 값을 가진 모르는 키(다른 종류의 키 포함, 예: text에 `page: 4`)는 거부.
- `page` 사본: pdf면 `locator.page`, 아니면 `null`. 비교는 `===`로 해 `undefined`는 `null`과 다르다(불일치로 거부).
- 디코드는 정규형 철자만 받는다(다시 인코드한 문자열과 같아야 함). DB가 받는 철자(예: 키 순서가 다른 `{"type":"text","end":12,"start":0}`, 키가 빠진 `{"type":"text"}`)도 Core는 거부한다 — 추가 검증은 Core 몫.
- 실패는 던지지 않고 `{ ok: false, message }`(한국어, 기존 `spool-record.ts` 관례)로 돌려준다.

**Never:**
- `time`·`sheet` 자료형(소비자가 생길 때, 2026-10-26). 코덱은 이 두 종류를 거부한다.
- Store·fake Store·handler·CLI 조립, 마이그레이션 추가·수정(기존 SQL 파일은 손대지 않음), Postgres.
- `ChunkParams`(대화 조각 설정)의 이름·모양 변경 — `packages/postgres/src/setup.ts`가 쓴다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 키 순서 무관 | `{end:12,start:0,type:'text'}` | `{"type":"text","start":0,"end":12}`, page `null` | — |
| null 칸 생략 | `{type:'text',start:0,end:12,page:null}`, `{type:'pdf',page:4,bbox:null}` | 각각 null 칸 없는 형과 같은 문자열 | — |
| pdf + bbox | `{bbox:[0.1,0.2,0.5,0.75],page:4,type:'pdf'}` | `{"type":"pdf","page":4,"bbox":[0.1,0.2,0.5,0.75]}`, page 4 | — |
| docx | `{type:'docx',block:3}` | `{"type":"docx","block":3}`, page `null` | — |
| 키 빠짐 | text에 `end` 없음, pdf에 `page` 없음, docx에 `block` 없음 | 거부 | `ok:false` |
| 다른 종류 키 | text에 `page:4`, docx에 `start:0` | 거부 | `ok:false` |
| 모르는 종류 | `time`, `sheet`, `zip`, `type` 없음, 객체 아님 | 거부 | `ok:false` |
| 잘못된 수 | 소수·음수·NaN·Infinity·문자열; pdf `page` 0; docx `block` 0; text `start > end`; bbox 길이≠4, [0,1] 밖, x0>x1 또는 y0>y1 | 거부 | `ok:false` |
| 디코드 비정규 | 공백 있음, 키 순서 다름, JSON 아님 | 거부 | `ok:false` |
| page 비교 | text locator와 `undefined` / `null` / `4` | false / true / false | — |

</intent-contract>

## Code Map

- `packages/core/src/domain/index-config.ts` -- `IndexConfigKind`(:2), `ChunkParams`(:5, 그대로), `IndexConfig`(:18). 다른 코드가 `IndexConfig`·`IndexConfigKind`를 쓰지 않아 판별 유니언으로 바꿔도 깨지는 곳 없음.
- `packages/core/src/domain/chunk.ts` -- 대화 `Chunk` 자료형의 문서·주석 관례(본뜰 것).
- `packages/core/src/domain/spool-record.ts:195–201` -- `{ ok: true; ... } | { ok: false; message }` 결과 관례와 한국어 메시지.
- `packages/core/src/domain/index.ts:26` -- 도메인 export 자리. `packages/core/src/index.ts:1`이 `export *`로 공개.
- `packages/sqlite/migrations/0004_capture_columns.sql:111–170` -- `document_chunks_locator_check`(json_valid, object, `json(x)=x`, type 다섯 종류, `page is (case pdf then $.page end)`)와 null 거부 trigger. `:256–330` `document_extractions`(attempt, status 다섯, `failed_stage` 넷, `index_config_id`). 읽기만.
- `packages/sqlite/migrations/0002_files_and_work.sql:256–264` -- `document_chunks`(page integer), `:528–575` `index_configs`의 `document_chunk` 종류와 기본 행 `019a0000-0000-7000-8000-000000000002`(`{"targetChars":1200,"overlapChars":120}`). 읽기만.
- `packages/sqlite/migrations/0008_attachment_rules.sql:45` -- 조각 삭제 trigger(넣기에는 영향 없음).
- `packages/sqlite/test/schema-0004.test.ts:55–57,133–138,687–775` -- 기존 locator DB 시험, `migratedPath`·`insert` 도우미 모양(새 시험이 본뜸). 바꾸지 않는다.
- `packages/sqlite/test/redact.test.ts:5` -- sqlite 시험이 `@second-brain/core`에서 import하는 예(공개 export 확인 경로).
- 원천: weknora `internal/types/source_locator.go:34–80` -- page·block 1부터, bbox `[x0,y0,x1,y1]`은 쪽 너비·높이의 비율(왼쪽 위 원점), text는 코드 포인트 범위.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/chunk-locator.ts` -- `CHUNK_LOCATOR_TYPES`(`['pdf','docx','text']`), `ChunkLocatorType`, `PdfChunkLocator`·`DocxChunkLocator`·`TextChunkLocator`·`ChunkLocator`, `encodeChunkLocator(input: unknown)` → `{ ok: true; locator; text; page } | { ok: false; message }`, `decodeChunkLocator(text: string)` → 같은 모양, `chunkLocatorPage(locator): number | null`, `chunkPageMatches(locator, page: number | null | undefined): boolean` -- 정규형과 사본 규칙의 단 하나의 출처.
- [x] `packages/core/src/domain/index-config.ts` -- `IndexConfigKind`에 `'document_chunk'`, `DocumentChunkParams { targetChars; overlapChars }`, `IndexConfig`를 `kind`로 갈리는 유니언(문서 조각은 `model`·`dimensions` null, `chunkParams: DocumentChunkParams`)으로 -- 0002의 세 번째 종류를 타입이 따라감.
- [x] `packages/core/src/domain/document.ts` -- `DocumentExtractionStatus`·`DocumentExtractionFailedStage`, `DocumentExtraction`(`id`,`fileId`,`extractorVersion`,`attempt`,`mediaType`,`status`,`startedAt`,`finishedAt`,`error`,`failedStage`,`indexConfigId: string | null`), `DocumentChunk`(`id`,`extractionId`,`ordinal`,`page: number | null`,`body`,`chunkLocator: ChunkLocator | null` — null은 0004 이전 행) -- 14·8이 쓸 행 자료형.
- [x] `packages/core/src/domain/index.ts` -- 위 값·타입 export(`DocumentChunkParams` 포함).
- [x] `packages/core/test/chunk-locator.test.ts` -- I/O 표의 모든 줄, 인코드→디코드 왕복, 디코드가 비정규 철자 거부.
- [x] `packages/sqlite/test/chunk-locator.test.ts` -- 최신 스키마(`runSqliteMigrations`, to 8)에 파일·추출 행을 두고, `@second-brain/core`에서 import한 코덱으로 만든 text·docx·pdf(bbox 없음·소수 bbox 있음) locator와 그 `page` 사본을 `document_chunks`에 넣으면 받아들여지고 읽은 값이 코덱 문자열과 같음; DB는 받지만 Core가 거부하는 철자(키 순서 다름, 필수 키 없음)를 각각 DB에 넣어 통과함과 `decodeChunkLocator`가 거부함을 함께 보임.

**Acceptance Criteria:**
- Given 같은 locator를 다른 키 순서·null 칸으로 만든 입력들, when `encodeChunkLocator`, then 모두 같은 문자열이다.
- Given 최신 스키마의 SQLite DB, when 코덱이 낸 text·pdf·docx locator와 `page` 사본으로 `document_chunks`에 행을 넣으면, then CHECK·trigger에 걸리지 않고 저장된 `chunk_locator`·`page`가 코덱 출력과 같다.
- Given pdf가 아닌 locator에 `page`를 준 입력 또는 필수 키가 빠진 입력, when `encodeChunkLocator`, then `ok: false`다.
- Given `@second-brain/core` 패키지, when 다른 패키지가 코덱·자료형을 import, then 빌드·타입 검사가 통과한다.

## Implementation Notes

- 구현은 맥락 없는 서브에이전트가 했다(full 경로). 리뷰 패치도 같은 에이전트가 했다. 계획의 Never와 달리 `0002_files_and_work.sql`의 주석 다섯 줄을 고쳤다(리뷰 패치, SQL 문은 그대로).
- 정규형 문자열은 두 번째 키 목록 없이 만든다: 각 종류의 분기가 locator 객체 리터럴을 정규 순서로 짓고 `JSON.stringify`가 그 삽입 순서를 그대로 쓴다. 키 순서의 출처가 하나다.
- `IndexConfig` 유니언의 두 갈래에 이름을 주었다(`ConversationIndexConfig`, `DocumentChunkIndexConfig`)—플랜의 export 목록에 없던 두 이름이지만, 갈래를 가리킬 수 없는 유니언은 소비자(14·8)가 쓰기 어렵다. `ChunkParams`(대화 조각 설정)의 이름과 모양은 그대로이고 `IndexConfig`·`IndexConfigKind`도 같은 이름으로 남는다.
- `encodeChunkLocator`는 입력의 null·undefined 칸을 먼저 걸러 `present` 맵을 만들고, 그 뒤 모르는 키·필수 키·수 검사를 한다. "null 칸은 없는 칸"이 한 곳에서만 결정된다.
- Postgres 시험은 Docker가 없어 돌리지 못했다(플랜이 적어 둔 대체 명령으로 나머지 전부 통과). 이 변경은 `packages/postgres`를 건드리지 않고 `ChunkParams`도 그대로여서 영향이 없다.

## Plan Change Log

## Review Triage Log

### 2026-10-26 — Review pass
- verdicts: 6 findings — high 0, medium 0, low 6, false 0, maybe-false 0
- findings:
  - `[low]` `[patch]` `REQUIRED_KEYS` 주석이 "쓰는 순서"라고 말하지만 순서는 `encoded()`에 넘기는 리터럴에서만 나온다(`packages/core/src/domain/chunk-locator.ts`) — 구현 워커가 주석을 "멤버십만"으로 고침.
  - `[low]` `[reject]` pdf 분기가 fall-through라 넷째 종류를 더하면 pdf 오류 메시지가 난다 — 지금 종류는 셋뿐이라 일상에서 만날 일이 없고, 고치려면 분기·`never` 가드를 더해야 한다(단순 수정이 아님).
  - `[low]` `[patch]` `isCount`·`isOffset`이 `Number.isInteger`라 `1e21`을 받아 `{"type":"pdf","page":1e+21}`을 내고, STRICT integer `page` 칸이 거부한다 — `Number.isSafeInteger`로 바꾸고 2^53 이상 거부 시험 네 줄을 더함.
  - `[low]` `[patch]` `-0`이 검사를 지나 locator에는 `-0`, 텍스트에는 `0`으로 남아 디코드 결과와 같지 않다 — `zero()`로 text `start`·`end`와 bbox 값을 0으로 맞추고(비교 전에), `-0` 왕복 시험을 더함.
  - `[low]` `[reject]` sqlite 시험의 둘째 사례가 첫째 사례가 넣은 행에 기대 단독 실행이 안 된다 — 시험 파일 안의 선언 순서로는 늘 맞고, 고치려면 시험 구조를 바꿔야 한다. `schema-0004.test.ts`도 같은 공유 상태 관례를 쓴다.
  - `[low]` `[patch]` `0002_files_and_work.sql`의 주석이 `IndexConfigKind`가 아직 `'chunk' | 'embedding'`이라고 말해 이 변경 뒤 틀린다 — 주석만 고침(SQL 문은 그대로; `migrate.ts`는 파일 체크섬을 저장하지 않음). 코디네이터가 "reader가 생겼을 때"를 "reader(10.14·10.8)가 쓸 코덱과 함께"로 다시 고침.

## Design Notes

- Decision(2026-10-26, 무인 실행에서 에이전트가 고름) pdf `bbox`는 선택 키, `[x0,y0,x1,y1]` 네 유한수, 각 값은 0~1(쪽 너비·높이의 비율, 왼쪽 위 원점), `x0 ≤ x1`, `y0 ≤ y1`. `page`·`block`은 1부터, text `start`·`end`는 0 이상 정수의 코드 포인트 반열린 구간 `[start, end)`이고 `start ≤ end`. 근거: spine이 인용한 원천(weknora `source_locator.go`)과 Conventions의 코드 포인트 `[start, end)`. 아직 쓴 행이 없어 나중에 넓히는 것은 추가 변경이다.
- null 생략은 "값이 null·undefined인 키는 없는 키"로 읽는다. 그래서 text에 `page: null`은 통과하고 `page: 4`는 모르는 키로 거부된다 — 티켓의 "pdf가 아닌 locator에 page를 주면 거부"와 "null 칸이어도 같은 문자열"을 한 규칙으로 만족한다.
- 소수 bbox는 `JSON.stringify`의 숫자 철자가 SQLite `json(x) = x`를 통과해야 한다. sqlite 시험의 소수 bbox 사례가 이것을 지킨다.

## Verification

**Commands:**
- `pnpm exec vitest run --project core --project sqlite` -- expected: 새 시험 포함 모두 통과.
- `pnpm test` -- expected: build → typecheck → vitest 통과(Postgres는 Docker 필요; 없으면 `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 전부 통과).
- `git diff --check` -- expected: 통과, 더한 줄에 절대 홈 경로 없음.

## Auto Run Result

Status: built

- **요약:** Core 도메인에 `chunk_locator` 정규형 코덱(text·pdf·docx; `type` 첫 키, 고정 키 순서, null·undefined 칸 생략, 공백 없음, 정규형만 디코드), `page` 사본·비교 규칙(`===`로 undefined≠null), 문서 조각 설정(`IndexConfigKind`에 `document_chunk`, `DocumentChunkParams`, 판별 유니언 `IndexConfig`)과 `DocumentExtraction`·`DocumentChunk` 행 자료형을 두고 공개 export했다. 코덱 출력이 최신 SQLite 스키마의 `document_chunks`를 통과함을 시험한다.
- **바뀐 파일:**
  - `packages/core/src/domain/chunk-locator.ts` — 새 코덱과 locator 자료형, `page` 사본·비교.
  - `packages/core/src/domain/document.ts` — 새 `DocumentExtraction`·`DocumentChunk` 자료형.
  - `packages/core/src/domain/index-config.ts` — `document_chunk` 종류, `DocumentChunkParams`, 판별 유니언.
  - `packages/core/src/domain/index.ts` — 공개 export.
  - `packages/core/test/chunk-locator.test.ts` — I/O 표 전부, 왕복, 2^53 이상·`-0` 사례.
  - `packages/sqlite/test/chunk-locator.test.ts` — 코덱 출력이 `document_chunks`에 들어가고 DB만 받는 철자는 Core가 거부.
  - `packages/sqlite/migrations/0002_files_and_work.sql` — 낡은 주석 한 단락만 고침.
- **리뷰(quick, 1회):** 6건 모두 low. 패치 4(주석, safe integer, `-0`, 마이그레이션 주석), 미룸 0, 기각 2(미래 종류의 fall-through 가드 — 지금 만날 일 없고 가드 추가가 필요; sqlite 시험의 사례 간 순서 의존 — 선언 순서로는 늘 맞고 구조 변경이 필요).
- **후속 리뷰 권고:** false — 패치한 항목이 모두 low(high 0, medium 0, low 4).
- **검증:** `pnpm build`·`pnpm typecheck` 통과; `pnpm exec vitest run --project core --project sqlite --project second_brain --project cli --project bootstrap --project claude-code` 76개 파일·2,422개 통과; 마지막 주석 수정 뒤 `--project sqlite` 16개 파일·338개 통과; `git diff --check` 통과, 절대 홈 경로 없음.
- **남은 위험:** Postgres 시험은 Docker가 없어 돌리지 않았다(`packages/postgres`는 손대지 않았고 그곳이 쓰는 `ChunkParams`는 그대로). bbox 모양(선택, 0~1 비율 네 수)과 1부터 세는 `page`·`block`은 계획의 Design Notes 결정이라, 8·epic-drive의 추출기가 다른 모양을 원하면 코덱을 넓혀야 한다. 코덱의 실제 쓰는 쪽(14의 Store, 8의 추출기)은 아직 없다.
