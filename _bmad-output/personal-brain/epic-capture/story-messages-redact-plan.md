---
title: 'messages redact 연쇄'
type: 'feature'
ticket: '13'
created: '2026-10-21'
status: 'built'
baseline_revision: '1cea083562816a392b6129b37d087d597f79470d'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/AGENTS.md']
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 마스킹 B(2.17) 뒤로 비밀은 저장본에 원문으로 남고, 사람이 저장본에서 지울 길(`brain messages redact`)이 없다. 0005가 도구 메모 가리기 기록 칸(`redactions.tool_note_id`)을 놓았지만 쓰는 쪽이 없고, Core `Redaction`에 `toolNoteId`도 없다(AD-11, deferred-work 75·76·77·90행).

**Approach:** SDK `messages.redact`(확인 게이트)가 입력을 검사하고 게이트를 지난 뒤 Store의 새 동사 `redactMessage`를 부른다. Store는 redact 표시를 세운 한 쓰기 트랜잭션 안에서 메시지와 그 도구 메모를 읽어 Core의 순수 계획 함수에 넘기고, 돌아온 계획대로 본문·대상 치환, `redactions` 기록, 걸린 `chunks`(와 trigger로 FTS) 삭제를 한 번에 하거나 전부 롤백한다. CLI `brain messages redact`는 얇은 껍데기다.

## Boundaries & Constraints

**Always:**
- 입력: SDK `{ message, text?, kind?, detected?, confirm? }`, CLI `brain messages redact <message> (--text <text> [--kind <kind>] | --detected) [--yes] [--json]`. `message`는 메시지 id(UUIDv7). `text`와 `detected` 중 정확히 하나, `kind`는 `text`와만, 기본 `manual`, `^[a-z0-9_]+$`. 어기면 `USAGE`(exit 2).
- 순서: 입력 검사 → `requireConfirmation({ns:'messages', verb:'redact', args})`(DB를 열기 전) → Store. 비TTY든 TTY든 `--yes` 없으면 exit 3 `CONFIRMATION_REQUIRED`(묻는 화면 없음, Design Notes D2).
- 한 트랜잭션(`withWrite(..., { redact: true })`): 본문 갱신, 바뀐 도구 메모 `target` 갱신, `redactions` 행 삽입, 그 세션 `chunks` 중 `from_at <= 메시지 occurred_at <= to_at`인 행 삭제. 하나라도 실패하면 롤백하고 throw/실패로 답한다. spool 갈래 없음(`spool` 미선언).
- 같은 트랜잭션 안에서 `pragma secure_delete = on`, 끝나면(커밋·롤백 무관, `finally`) `off`. 커밋 뒤 `pragma wal_checkpoint(TRUNCATE)`를 최선 노력으로 부르고 그 실패·busy는 결과를 바꾸지 않는다(D6).
- 기록: 가린 구간 하나에 `redactions` 한 행. 본문 구간은 `message_id`, 도구 메모 구간은 `tool_note_id`(그때 `message_id`는 null). 위치는 이 호출 직전 그 대상(본문 또는 `target`) 위의 코드 포인트 `[start, end)`, `content_hash`는 Core `contentHash(지운 글자)`, `pattern_version`은 `detected`면 `SECRET_PATTERN_VERSION`, 아니면 null, `occurred_at`은 Core 시계, id는 `IdGen`.
- 결과 `data`·텍스트 줄·오류 message에 지운 글자를 넣지 않는다. 사람이 읽는 줄은 한국어(출력 언어 검사).
- 새 오류 코드 `MESSAGE_NOT_FOUND`(exit 1, retryable false), `REDACT_TEXT_NOT_FOUND`(exit 1, retryable false)를 Core 표와 README 표에 함께(양방향 대조 테스트).

**Never:**
- 조각·미러 재생성 일감(epic 4), 내보내기·복제 가리기(epic 5·7), `embeddings`(테이블 없음), `ATTACHMENT_NOT_REDACTED`·`files redact`(epic-attachments), Postgres adapter(epic 7), MCP `session` 인자(AD-28, epic 9), TTY 대화형 확인, `--dry-run`.
- 마이그레이션·trigger 변경. `setRedactAllowed`를 패키지 밖으로 내보내기. 출력 전용 잘린 꼬리 규칙(`maskToolNoteTarget`의 `truncated`)을 저장본에 적용하기. 지운 글자를 로그·오류·`failures`에 남기기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 글자 가리기 | 본문·도구 메모 대상에 `hunter2-x` 두 번씩, `--text hunter2-x --yes` | 네 곳이 `[REDACTED:manual]`, `redactions` 4행(본문 2·`tool_note_id` 2), 걸린 조각 삭제, exit 0 | 없음 |
| `--kind` | `--text … --kind db_password` | 표시가 `[REDACTED:db_password]`, 행 `kind` 같음 | `Db-Pw`는 `USAGE` |
| detected | 본문에 API 키, 대상에 `TOKEN=…` | 패턴이 찾는 구간 전부 가림, 본문 결과가 `maskSecrets(body,'body').text`와 같음, `pattern_version` 기록 | 없음 |
| detected 없음 | 패턴에 안 걸리는 메시지 | ok, 모든 수 0, 아무 행도 안 바뀜 | 없음 |
| 글자 없음 | 메시지에 없는 `--text` | 아무것도 안 바뀜 | `REDACT_TEXT_NOT_FOUND` exit 1 |
| 메시지 없음 | 없는 id | 아무것도 안 바뀜 | `MESSAGE_NOT_FOUND` exit 1 |
| 확인 없음 | 비TTY, `--detected`, `--yes` 없음 | exit 3, `error.retry = {ns:'messages', verb:'redact', args:{message, detected:true, confirm:true}}`, `error.retry_argv`에 `--yes`, 텍스트 모드는 stderr에 `다시 하려면:` 줄 | DB 안 엶 |
| 입력 충돌 | `--text`와 `--detected` 둘 다, 둘 다 없음, `--kind`만 | 아무것도 안 바뀜 | `USAGE` exit 2 |
| 표시와 겹침 | `--text REDACTED`, 본문에 이미 `[REDACTED:manual]`뿐 | 표시를 건드리지 않음 | `REDACT_TEXT_NOT_FOUND` |
| 두 번째 가리기 | 같은 메시지에 다른 글자 | 새 행 위치가 첫 가리기가 남긴 본문 위 구간 | 없음 |
| 중간 실패 | 계획 적용 중 throw(테스트용 실패 store/trigger) | 본문·대상·`redactions`·`chunks` 모두 그대로, 표시 내려감 | 실패로 답함 |
| 다시 수집 | 가린 뒤 같은 transcript로 `sessions ingest` | 본문·대상은 가린 그대로, 행 수 같음 | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/domain/redaction.ts` -- `Redaction`. `messageId`를 `string | null`로, `toolNoteId: string | null` 추가(둘 중 정확히 하나; `fileId`는 epic-attachments). 위치 설명을 "대상 위"로.
- `packages/core/src/domain/secret-patterns.ts` -- `maskSecrets(text, field)`가 `spans{start,end,kind,removed}`(코드 포인트, 가리기 전 텍스트 기준, `removed`=`contentHash`)를 준다. `SECRET_PATTERN_VERSION`. 바꾸지 않는다. 표시 정규식 `/\[REDACTED:[a-z0-9_]+\]/gu`는 비공개 — 같은 모양을 새 파일에서 쓴다.
- `packages/core/src/domain/sha256.ts` -- `contentHash`.
- `packages/core/src/output/mask.ts` -- 출력 가리기. 저장본 계획에 쓰지 않는다.
- `packages/core/src/envelope.ts:165-188` -- `requireConfirmation`, `CONFIRM_ARG`. `errorEnvelope`는 가리기로 바뀌는 인자가 있으면 `retry`를 뺀다(그대로 둠: 비밀 글자를 `--text`로 준 호출은 `retry` 없음).
- `packages/core/src/codes.ts` -- 오류 코드 표(`USAGE` exit 2, `CONFIRMATION_REQUIRED` exit 3). 한국어 `meaning`·`hint`.
- `packages/core/src/ports/store.ts:198-286` -- `SessionStore`. `fillSessionTags`가 최근 추가된 동사의 본보기(입력·결과 union 모양).
- `packages/core/src/brain.ts` -- `Brain`·`createBrain`. `failures`가 SDK 이름공간 본보기(`packages/core/src/failures/retry.ts`).
- `packages/core/src/testing/fakes/store.ts:140-320,700-715` -- 메모리 store. `messages`·`toolNotes`·`redactions` Map과 `snapshot().redactions`. 조각은 없다.
- `packages/core/src/testing/contracts/session-store.ts:49` -- `sessionStoreContract()`; `packages/core/test/contracts.test.ts`와 `packages/sqlite/test/session-store.test.ts`가 돌린다.
- `packages/sqlite/src/sessions.ts` -- SQLite `SessionStore`. 쓰기는 `withWrite`(`packages/sqlite/src/write.ts`)의 `held` 핸들로만(같은 연결 `connection.db`를 쓰면 영원히 멈춘다).
- `packages/sqlite/src/write.ts:51-90` -- `redact` 옵션이 표시를 `try/finally`로 세우고 내린다. `secure_delete`도 여기서.
- `packages/sqlite/migrations/0005_identity_and_records.sql:96-150` -- `redactions` 표(대상 셋 중 하나, 위치 검사), 불변 trigger. `0006_drop_message_seq.sql:98-172` -- `chunks(session_id, from_at, to_at, body)`와 `chunks_fts` trigger. `0001_initial.sql:352-441` -- `tool_notes` 불변 trigger(표시 + `target`만 바뀜)와 `tool_notes_fts_au`. 둘 다 `secure-delete`.
- `apps/cli/src/commands/failures-retry.ts`, `apps/cli/src/commands/index.ts` -- 명령 spec 본보기와 등록부. 메타 7칸 누락은 `apps/cli/test/command-meta.test.ts`가 잡는다.
- `apps/cli/src/dispatch.ts:446-457` -- 텍스트 모드 실패 줄(코드·message·hint). `:771-789` `failed()`가 `retry_argv`를 붙인다. `apps/cli/src/envelope.ts:62` `retryArgv`.
- `apps/cli/src/doctor/store.ts:41` -- `SessionStore`를 흉내 내는 doctor용 store. 새 동사도 같은 식으로.
- `README.md:296`("아직 없습니다"), `README.md:558-583`(오류 코드 표).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/redaction.ts` -- `messageId: string | null`, `toolNoteId: string | null` -- 0005의 세 대상 중 둘을 표현.
- [x] `packages/core/src/domain/redact-plan.ts`(새), `packages/core/src/domain/index.ts` -- 순수 함수 `planRedaction(current, request, { now, newId })`: `current = { message, toolNotes }`, `request = { mode:'text', text, kind } | { mode:'detected' }`. 결과 `{ body, toolNotes:[{id, target}](바뀐 것만), redactions, bodySpans, toolNoteSpans }` 또는 `{ refused:'REDACT_TEXT_NOT_FOUND' }`(D4·D5) -- 계획은 Core가 소유.
- [x] `packages/core/src/ports/store.ts` -- `RedactMessageInput { messageId, plan(current) => 계획 | 거절 }`, `RedactMessageResult`(ok: `sessionId`·`bodySpans`·`toolNoteSpans`·`toolNotesChanged`·`chunksRemoved` | 거절 그대로 | `MESSAGE_NOT_FOUND`·`DB_UNAVAILABLE`·`DB_LOCKED`), `SessionStore.redactMessage` -- 읽기와 쓰기를 한 트랜잭션에.
- [x] `packages/core/src/messages/redact.ts`(새), `packages/core/src/brain.ts`, `packages/core/src/index.ts` -- SDK `brain.messages.redact`: 검사(`USAGE`, 한국어 message) → 게이트 → `store.redactMessage` → 결과·코드 매핑. 계획 함수에 `clock`·`idGen`을 묶어 넘김.
- [x] `packages/core/src/codes.ts` -- `MESSAGE_NOT_FOUND`, `REDACT_TEXT_NOT_FOUND`(한국어 뜻·hint).
- [x] `packages/core/src/testing/fakes/store.ts` -- `redactMessage` 구현(같은 의미, 조각 0) -- 가짜와 SQLite가 같은 계약을 통과.
- [x] `packages/core/src/testing/contracts/session-store.ts` -- 사례: 본문·메모 치환과 행 모양, 모든 `redactions` 행이 있는 메시지·메모를 가리킴(deferred 90행), 거절·없는 메시지는 아무것도 안 바꿈, 두 번째 가리기는 첫 결과 위에서 계획, 가린 뒤 같은 batch 재수집이 원문을 되살리지 않음.
- [x] `packages/sqlite/src/write.ts` -- `redact`일 때 트랜잭션 안에서 `secure_delete` on, `finally`에서 off.
- [x] `packages/sqlite/src/sessions.ts` -- `redactMessage`: `withWrite(redact:true)` 안에서 메시지·메모 읽기 → `plan` → 갱신·삽입·조각 삭제 → 커밋 뒤 최선 노력 `wal_checkpoint(TRUNCATE)`. 연결 실패는 `DB_UNAVAILABLE`, 잠금은 `DB_LOCKED` 값.
- [x] `packages/sqlite/test/redact.test.ts`(새) -- 아래 AC의 SQLite 쪽(같은 연결 UPDATE 거부, 롤백, 조각·FTS, 파일 바이트).
- [x] `packages/core/test/redact-plan.test.ts`(새) -- 매트릭스의 계획 사례: NFC, 표시 겹침, 코드 포인트 위치(이모지 앞), 겹친 일치, detected 동치.
- [x] `apps/cli/src/commands/messages-redact.ts`(새), `apps/cli/src/commands/index.ts` -- spec(`risk: 'destructive'`, `hook: false`, `dryRun: false`, `writes: true`, `required: ['message']`, 한국어 메타), `--yes`는 `confirm: true`. `data`: `message_id`, `body_spans`, `tool_note_spans`, `tool_notes_changed`, `chunks_removed`, `pattern_version`.
- [x] `apps/cli/src/dispatch.ts` -- 텍스트 모드 실패에 `error.retry_argv`가 있으면 hint 아래 `  다시 하려면: <argv를 셸 인용해 한 줄로>` -- story 2.1 리뷰 #4가 넘긴 일.
- [x] `apps/cli/src/doctor/store.ts` -- 새 동사 자리.
- [x] `apps/cli/test/messages-redact.test.ts`(새) -- 임시 home에서 CLI로 확인 게이트·글자·detected·코드.
- [x] `README.md` -- 296행을 사용법 절로(입력 둘, `--yes`, 되돌릴 수 없음, 조각은 다시 만들어지지 않음(epic 4), 비밀 글자를 `--text`로 주면 셸 기록·transcript에 남는다는 경고와 `--detected` 권장), 오류 코드 표 두 행.
- [x] `_bmad-output/personal-brain/deferred-work.md` -- 75(`toolNoteId`)·76·77·90행 처분 갱신, 새 항목: 다른 연결이 쥔 WAL 읽기 때문에 체크포인트가 못 비우는 경우, `--text` 글자가 transcript·셸 기록에 남는 것, TTY 대화형 확인.
- [x] `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` AD-11 -- 연쇄에 `secure_delete`·체크포인트 한 줄, 조각 재생성·미러·복제 일감은 각 에픽이 붙인다는 현재 상태.

**Acceptance Criteria:**
- Given 비밀 글자가 본문·도구 메모 대상·조각에 든 세션, when `brain messages redact <id> --text <글자> --yes`, then `messages.body`·`tool_notes.target`·`chunks`·`chunks_fts`·`tool_notes_fts`(MATCH)·`redactions` 어느 칸에도 그 글자가 없고, 연결을 닫은 뒤 `brain.db`·`-wal` 파일 바이트에도 없다.
- Given 방금 끝난 가리기, when 같은 연결로 `update messages set body = 'x'`, then trigger가 거부한다. Given 적용 중 실패한 가리기, then 행이 모두 그대로이고 `isRedactAllowed()`가 false다.
- Given 비TTY, when `--yes` 없이 `brain messages redact <id> --detected --json`, then exit 3, `error.code = CONFIRMATION_REQUIRED`, `error.retry.args.confirm = true`, `error.retry_argv`가 `--yes`·`--json`을 포함하고 DB는 바뀌지 않는다. 텍스트 모드는 stderr에 `다시 하려면:` 줄이 있다.
- Given API 키가 든 메시지, when `--detected --yes`, then 저장 본문에 그 키가 없고 `redactions.pattern_version = SECRET_PATTERN_VERSION`이다. Given 대상에 비밀이 든 도구 메모, then 그 가리기가 `tool_note_id` 행(`message_id` null)으로 남는다.
- Given 가린 메시지, when 같은 transcript를 다시 수집, then 본문·대상은 가린 그대로이고 모든 테이블 건수가 같다.
- Given 이 변경, when `pnpm test`, then 명령 메타·출력 언어·README 코드 대조·계약(가짜·SQLite) 테스트가 모두 통과한다.

## Implementation Notes

- Implemented Core's pure `planRedaction`, SDK `messages.redact`, the Store callback contract, memory and SQLite adapters, CLI command, error codes, and documentation. The SQLite callback reads current text under `BEGIN IMMEDIATE` and sends every statement through `held`; ingest's existing conflict handling preserves redacted text on replay.
- Added a small optional CLI `preflight` hook. The existing dispatcher checked the schema before calling the SDK, which would open the DB before confirmation. The command now calls the shared Core validator/gate in preflight and again through the SDK, preserving the required validation → confirmation → DB ordering without duplicating rules. Disabled opportunistic drain for this destructive command so unrelated work does not follow it.
- Literal matching works over code points, considers original and NFC forms, skips every overlap with existing markers, chooses the longer match at a shared start, and applies spans in reverse. Detected mode uses `maskSecrets` directly, without the output-only truncated-tail rule.
- SQLite applies body, tool target, redaction records, and overlapping chunk deletion together. `secure_delete` is enabled inside the transaction and disabled in `finally`, alongside the redaction flag; the post-commit truncate checkpoint is best effort. Injected failures at tool-note update, record insertion, and chunk deletion all roll back rows and FTS and clear the flag.
- Added planner/SDK tests, a shared memory/SQLite contract case, SQLite disk-byte/FTS/rollback/locking tests, and subprocess CLI tests in temporary homes. Updated the existing closed code-table fixture and dispatcher test double for the new capability.
- The first `pnpm test` could not reach Docker in the sandbox. Running it with sandbox escalation reaches Docker; a separate unprivileged broad run also hit the existing local-listener test's socket restriction. These are environment access limits, so the required final full run uses escalation.
- Remaining scope is exactly the deferred work: another connection's old WAL reader can delay disk cleanup; literal secrets remain in external shell/transcript history; interactive TTY consent, chunk/mirror regeneration, export/replica cleanup, attachments, and Postgres are owned by later work.

## Plan Change Log

## Review Triage Log

### 2026-10-21 — Review pass
- verdicts: 0 findings — high 0, medium 0, low 0, false 0, maybe-false 0
- findings: 없음. quick 렌즈(Orca를 거친 codex, 맥락 없음)가 계획·AGENTS.md·diff를 대조하고 집중 스위트 16개를 돌려 지적 0건을 냈다.

## Design Notes

- **D1 메시지 식별은 id.** 사람이 id를 얻는 읽기(`sessions read`·`recall`)는 epic 4가 낸다. 지금은 SDK 계약과 테스트가 id로 부른다. MCP의 `session` 필수 인자(AD-28)는 귀속용이라 epic 9.
- **D2 TTY도 exit 3.** 데이터베이스 명령의 문맥에는 TTY·질문 도구가 없고, 되돌릴 수 없는 가리기는 명시적 `--yes`가 맞다. Conventions의 "비TTY·`--json`에서 exit 3"과 어긋나지 않는다(그때 exit 3인 것은 같다). 대신 텍스트 모드가 `retry_argv`를 보여 준다.
- **D3 계획 콜백.** Core가 밖에서 읽고 계획하면 다른 가리기와 경주할 때 위치가 틀린다. Store가 트랜잭션 안에서 읽은 현재 상태를 Core의 순수 함수에 넘기면 경주가 없고, 규칙은 Core 한 곳이다. 콜백은 동기 순수 함수이고 DB를 만지지 않는다.
- **D4 구간 규칙.** 글자: `text`와(다르면) `text.normalize('NFC')`의 모든 일치를 왼쪽부터, 같은 자리면 긴 것, 겹치면 앞의 것. 이미 있는 표시와 한 글자라도 겹치는 일치는 버린다. detected: 본문 `maskSecrets(body,'body')`, 대상 `maskSecrets(target,'tool_target')`의 spans 그대로. 한 호출의 모든 구간은 호출 직전 텍스트 위이고 뒤에서부터 바꾼다.
  ```ts
  // 본문 'a🙂 hunter2-x b', text 'hunter2-x' → start 3, end 12 (코드 포인트)
  // 결과 본문 'a🙂 [REDACTED:manual] b'
  ```
- **D5 없음의 답.** 글자 모드에서 없는 글자는 오타일 가능성이 커서 실패(`REDACT_TEXT_NOT_FOUND`), detected에서 없음은 "패턴이 찾는 것이 없다"는 답이라 ok와 0.
- **D6 디스크.** FTS `secure-delete`와 같은 이유(AD-11): 실험(node:sqlite, WAL)에서 `secure_delete` 없이는 체크포인트 뒤에도 `brain.db`에 옛 바이트가 남았고, 켜고 `wal_checkpoint(TRUNCATE)`하면 `brain.db`·`-wal` 모두에서 사라졌다. 트랜잭션 안에서 켜도 효과가 같다.

## Verification

**Implementation run (2026-10-21):** `pnpm test` passed with sandbox escalation: build, typecheck, 68 test files, and 2,206 tests. The new SQLite suite passed all 7 cases, including disk-byte absence after close, FTS cleanup, three injected rollback stages, locked/unavailable stores, and an external WAL reader. CLI subprocess tests passed validation/confirmation before any config or DB access, literal/custom-kind and detected modes, Korean output, safe retry handling, missing codes, and no-match behavior. `git diff --check` passed; the requested home-path grep found only pre-existing neutral example paths in packages, apps, and README, with none introduced by this change.

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과
- `git grep -nE "/Users/" -- packages apps README.md` -- expected: 새로 넣은 절대 홈 경로 없음

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에 비밀이 든 fixture transcript를 `sessions ingest`한 뒤 `sqlite3 <home>/brain.db "select id from messages"`로 id를 얻고 `node apps/cli/dist/bin.js messages redact <id> --detected`(exit 3과 `다시 하려면:` 줄) → `--yes`(exit 0) → `grep -c <비밀> <home>/brain.db*`가 0.

## Auto Run Result

Status: built

**요약:** `brain messages redact <message> (--text <글자> [--kind <kind>] | --detected) [--yes]`를 만들었다. Core 순수 함수 `planRedaction`이 구간·기록을 정하고, SDK `messages.redact`가 입력 검사와 확인 게이트를 DB 앞에서 하며, Store 새 동사 `redactMessage`가 redact 표시·`secure_delete`를 세운 한 트랜잭션 안에서 현재 본문과 그 도구 메모를 읽어 계획을 받고 본문·대상 치환, `redactions`(본문은 `message_id`, 도구 메모는 `tool_note_id`), 걸린 `chunks`(trigger로 FTS) 삭제를 한 번에 한다. 커밋 뒤 `wal_checkpoint(TRUNCATE)`는 최선 노력이다.

**바뀐 파일:**
- `packages/core/src/domain/redact-plan.ts`(새) — 글자(원형·NFC, 표시와 겹침 제외, 코드 포인트 위치)·detected(`maskSecrets`) 계획
- `packages/core/src/domain/redaction.ts` — `messageId` nullable, `toolNoteId`
- `packages/core/src/messages/redact.ts`(새), `brain.ts`, `index.ts`, `domain/index.ts`, `ports/index.ts` — SDK 동사와 공유 검사 `checkMessagesRedact`
- `packages/core/src/ports/store.ts` — `RedactMessageInput`(계획 콜백)·`RedactMessageResult`·`SessionStore.redactMessage`
- `packages/core/src/codes.ts`, `packages/core/test/codes.test.ts` — `MESSAGE_NOT_FOUND`·`REDACT_TEXT_NOT_FOUND`(exit 1)
- `packages/core/src/testing/fakes/store.ts`, `testing/contracts/session-store.ts` — 가짜 구현과 공유 계약 사례(기록이 있는 대상을 가리킴, 재수집이 되살리지 않음)
- `packages/sqlite/src/sessions.ts`, `packages/sqlite/src/write.ts` — SQLite 구현, redact 트랜잭션의 `secure_delete`
- `apps/cli/src/commands/messages-redact.ts`(새), `commands/index.ts` — 명령 spec(`destructive`, `drain: false`)
- `apps/cli/src/dispatch.ts` — `preflight`(설정·DB 앞의 검사·게이트), 텍스트 모드 `다시 하려면:` 줄
- `apps/cli/src/doctor/store.ts`, `apps/cli/test/dispatch.test.ts` — 새 동사 자리
- 테스트: `packages/core/test/redact-plan.test.ts`, `packages/sqlite/test/redact.test.ts`, `apps/cli/test/messages-redact.test.ts`(새)
- 문서: `README.md`(사용법·경고·코드 표), spine AD-11, `deferred-work.md`

**리뷰:** quick 1회, 지적 0건. 패치 0, 미룸 0, 기각 0.

**후속 리뷰 권고:** false(패치한 항목 없음; high 0, medium 0, low 0).

**검증:** 구현 워커 뒤 직접 `pnpm test` — build·typecheck·vitest 68개 파일 2206개 테스트 통과(exit 0). I/O 매트릭스 12행이 모두 실행된 테스트로 덮인다(계획·SQLite·CLI·계약 스위트). 계획 단계 실험(node:sqlite WAL)으로 `secure_delete` + `TRUNCATE` 체크포인트가 `brain.db`·`-wal`에서 옛 바이트를 지움을 확인했고, `packages/sqlite/test/redact.test.ts`가 같은 성질을 단정한다.

**남은 위험:**
- 다른 연결이 오래된 WAL 읽기를 쥐고 있으면 체크포인트가 비우지 못해 `-wal`에 옛 바이트가 남을 수 있다(deferred-work).
- `--text`로 준 비밀은 셸 기록·transcript(도구 메모 대상)에 남는다. README가 `--detected`를 권한다. 비밀 패턴에 안 걸리는 글자는 `error.retry`·`retry_argv`에 그대로 실린다.
- 계획에 없던 `preflight` 훅이 생겼다(디스패처가 설정·스키마를 `run` 전에 보므로 게이트를 DB 앞에 두려면 필요했다). 검사는 Core 함수 하나를 CLI와 SDK가 두 번 부른다.
- 새 코드는 주변 코드보다 주석이 적고 한 줄에 여러 속성을 몰아 쓴다. 등록부에서 `messages`가 `doctor`와 `failures` 사이에 들어가 `--help`·`guide schema` 순서가 이름순에서 벗어난다. 둘 다 동작 문제는 아니다.
- 조각·미러 재생성, 내보내기·복제 가리기, 첨부, Postgres, TTY 대화형 확인은 뒤 에픽.
