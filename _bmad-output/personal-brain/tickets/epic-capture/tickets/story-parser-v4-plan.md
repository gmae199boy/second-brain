---
title: 'parser v4: 도구 메모 호출 키·줄 읽기·버린 줄 집계'
type: 'bugfix'
ticket: '23'
created: '2026-10-21'
status: done
baseline_revision: '8285bd15451e3bb3affff061e318832475ee14bd'
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

**Problem:** 2.7 follow-up 리뷰 #7~#9·#11~#15(`story-transcript-parser-follow-up-review.md`)와 2026-10-21 사용자 결정 둘. 도구 메모가 (세션, 앞 메시지, 순번)으로만 식별돼 버전 업으로 남는 줄이 바뀌면 같은 호출에 메모가 둘 생기고(#9), 첫 메시지 앞 호출은 메모가 없으며(#8), 대화가 아닌 줄의 `tool_result`가 ok를 정하고 끝나지 않은 Agent 호출이 실패로 굳는다(#7). 끝이 아닌 깨진 줄 하나가 파일 전체를 거부하고(#11), timestamp를 `new Date()`만으로 믿으며(#12), 도구 대상이 비는 호출이 많고(#13) `toString` 같은 도구 이름·surrogate pair 자르기가 틀리며(#14), 무엇을 왜 버렸는지 세지 않는다(#15). 그리고 서브에이전트 보고는 저장하지 않기로 했고, orca 고정 머리말 줄은 사람이 한 말이 아니다.

**Approach:** `CLAUDE_CODE_PARSER_VERSION`을 `'4'`로 올린다. parser는 보고 읽기를 걷어 내고, 도구 메모에 호출 id(`callId`)와 "이전 버전이 같은 호출을 저장했을 수 있는 자리"(`earlierPositions`)를 내며, 버린 줄을 이유별로 센다. Store는 `call_id`로 같은 호출을 알아보고, `call_id`가 없는 옛 행은 자기 자리나 그 이전 자리로 알아본다. Core는 깨진 줄을 `TRANSCRIPT_LINES_SKIPPED`로 알리고 버린 줄 수를 `sessions ingest`의 `data.droppedLines`로 낸다.

## Boundaries & Constraints

**Always:**
- 보고 없음: 동기 Agent 결과·task-notification·peer handback을 보고로 읽는 코드(`readReport`·`readHandback`·`oldHandbackBody`·`HANDBACK_NOTICES`·`HANDBACK_FRAME_HEADING`·`Provenance`)를 지운다. 그 줄들은 남은 규칙(isMeta, 허용 목록, 빈 본문)대로 메시지가 아니다. `isSubagentReport`는 늘 false(칸은 스키마에 남음). Agent 호출의 도구 메모는 그대로 남는다.
- orca 머리말: user 줄 본문(trim)이 `You are working inside Orca`·`Please carry out this task from my Orca coordinator`로 시작하거나 `/^You have \d+ orchestration message/`에 맞으면 메시지가 아니다. 문장 중간에 든 같은 낱말은 그대로 메시지.
- 메모 식별: `ParsedToolNote`에 `callId: string | null`(Claude는 `tool_use.id`)과 `earlierPositions: readonly {harnessMessageId, ordinal}[]`를 더한다. Store(SQLite·가짜 모두)는 메모를 이미 있는 것으로 보고 건너뛴다 — 같은 세션에 그 `call_id` 행이 있거나, `call_id`가 null인 행이 자기 `(harness_message_id, ordinal)` 또는 `earlierPositions`의 한 자리에 있을 때. 아니면 `call_id`와 함께 넣고, 다른 제약에 걸리면 넣지 않는다(`on conflict do nothing`, 건수에 안 셈).
- `earlierPositions`: 메모의 앞 메시지(첫 메시지 앞 호출은 파일 처음)와 그 호출 사이에서, 이 버전이 버리지만 버전 3이 메시지로 저장했을 수 있는 줄 R(uuid가 있는 user·assistant, 사이드체인 아님: 버린 이유가 `timestamp`·`orca_header`이거나, `origin.kind`가 `peer`·`task-notification`이거나, `toolUseResult.agentId`가 있는 줄) 각각에 대해 `{R의 uuid, R의 줄부터(그 줄의 호출 포함) 이 호출 앞까지 센 호출 수}`. 뒤에 있는 R부터. 상위 집합이어도 안전하다(그 자리에 행이 없으면 맞지 않는다).
- 첫 메시지 앞 호출: 바로 다음 메시지에 붙이고 ordinal은 음수다(그 호출 p개가 파일 순서로 `-p … -1`). 음수 ordinal은 "그 메시지 줄 앞에서 한 호출"이라는 뜻이고 내용의 첫 메시지에만 있다. 메시지 줄 뒤의 호출은 지금처럼 0부터 — 버전 3의 자리가 그대로다.
- ok: `tool_result`는 `type: user`이고 사이드체인이 아닌 줄의 것만 센다(실측: `api-request-blob` 줄의 `tool_result` 453개). 결과 없는 호출은 뒤에 메시지가 있으면 `ok: false`로 쓰되, `Agent`·`Task` 호출은 결과가 올 때까지 쓰지 않는다(실패로 굳히지 않음). 뒤에 메시지가 없으면 지금처럼 쓰지 않는다.
- 도구 대상: 도구 이름 표는 자기 키로만 찾는다(`Object.hasOwn`/`Map`, `toString` 등 기본 객체 키). 명시 키 추가: `SendMessage`→`to`, `AskUserQuestion`→`questions[0].question`. `FALLBACK_KEYS`에 식별 키(`to`·`recipient`·`task_id`·`id`·`pageId`·`cql`·`filename`)를 더한다. 내용 키(`content`·`message`·`code`·`script`·`payload`·`new_string`·`old_string`)는 넣지 않는다. 자르기는 코드 포인트 경계: 상한 자리에서 high surrogate가 남으면 그것까지 뗀다. Core `maskToolNoteTarget`의 잘림 판정은 `target.length >= TOOL_NOTE_TARGET_LIMIT - 1`(한 칸 짧게 잘린 대상도 꼬리를 가림, 출력에서만).
- 깨진 줄: 끝이 아닌 줄이 JSON이 아니면 건너뛰고 `unreadable`로 센다. 읽은 범위에 그런 줄이 있고 JSON으로 읽힌 줄이 하나도 없을 때만 `TRANSCRIPT_UNREADABLE`. 쓰는 중인 마지막 반쪽 줄은 지금처럼 세지 않고 건너뛴다.
- 시각: `timestamp`가 `new Date(s).toISOString() === s`이고 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`일 때만 메시지(아니면 `timestamp`로 셈). 실측: 112,024개 중 어긋남 0.
- 버린 줄 집계: `ParseResult`(ok)에 `droppedLines: Readonly<Record<string, number>>`. 키는 parser의 이유 코드(snake_case)이고 `unreadable`은 Core가 읽는 예약 키다. Claude parser는 아래 이유를 모두(0 포함) 내고, 읽은 범위(커서 줄부터)의 비지 않은 줄 중 메시지가 아닌 것마다 처음 걸린 이유 하나를 센다: `unreadable`·`duplicate`·`not_conversation`(type이 user/assistant 아님)·`sidechain`·`meta`(isMeta·isCompactSummary)·`incomplete`(uuid·timestamp·message 없음)·`timestamp`·`api_error`·`not_human`·`empty`·`tool_output`·`orca_header`. 메시지 수 + 버린 줄 합 = 읽은 범위의 비지 않은 완전한 줄 수.
- Core ingest: `droppedLines.unreadable > 0`이면 모든 ok 반환에 `TRANSCRIPT_LINES_SKIPPED` 경고(Store 경고 뒤, 중복 없이). `IngestSessionData.droppedLines`(파싱한 경우 그 값, 파싱 전에 spool로 간 경우 `null`)를 CLI `sessions ingest`의 `data`로 낸다(`meta` 아님). `WARNING_CODES`·뜻(한국어)·README 표·명령 메타 `output` 문구.
- 전체 읽기와 증분 읽기가 같은 답(`callId`·`earlierPositions` 포함). 판정은 그 줄과 앞만 본다. Core parser 계약: 음수 ordinal 허용(내용의 첫 메시지에만), 증분 메모 = 전체 메모 중 증분이 실어 온 메시지의 것, 단 커서 메시지의 음수 ordinal 메모는 뺀다. `droppedLines` 모양(음 아닌 정수) 사례.
- fixture는 중립 내용. 실측 스크립트와 실제 transcript 내용은 저장소에 넣지 않는다(공개 저장소, `/tmp`). 주석은 영어로 *왜*를, 사람이 읽는 새 문구는 한국어로.

**Never:**
- 스키마·마이그레이션 변경(잘림 표시 칸 포함), `is_subagent_report` 칸 제거, 보고 요약 저장, `subagents/` 파일 읽기.
- 뒤 줄을 보는 판정, 내용 키를 도구 대상으로 쓰기, 비슷한 도구·대상으로 메모를 짐작해 맞추기.
- 꼬리표 다시 채우기(20), `messages redact`(13), 수집 hook 켜기(14), 세션 단위 orca 워커 표시(deferred).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 버전 3 상태 다시 읽기 | 버전 3 빌드가 `peer-handback.jsonl`·`report-provenance.jsonl`에서 낸 메시지·메모(보고 메시지, `call_id` null)가 저장된 세션, parser_version `3` | v4 수집 뒤 호출마다 메모 하나(행 수 = 메모될 호출 수), 보고 행은 그대로(불변) | — |
| 같은 호출 다른 자리 | `call_id` X가 저장됨, 배치에 X가 다른 `(메시지, ordinal)`로 | 넣지 않음 | — |
| 옛 행, 나열 안 된 자리 | null 행이 (A,0), 배치 메모 (B,0), earlier [] | 넣음 | — |
| 보고 없음 | 두 fixture 수집 | `is_subagent_report=1` 행 0, 보고·안내 본문 DB에 없음, Agent 메모 있음 | — |
| 첫 메시지 앞 호출 | 호출 둘 → 결과 → 첫 메시지 | 첫 메시지에 ordinal -2, -1 메모 | — |
| 대화 아닌 줄의 결과 | `api-request-blob`이 먼저 `is_error:true`, 뒤 user 결과 성공 | ok true | — |
| 끝나지 않은 Agent | Agent 호출, 결과 없음, 뒤에 메시지 | 메모 없음 / 같은 상황 Bash는 ok false | — |
| 깨진 중간 줄 | 3번째 줄이 JSON 아님 | ok, `droppedLines.unreadable=1`, 경고 `TRANSCRIPT_LINES_SKIPPED` | — |
| 모두 깨짐 | JSON 줄 없음, 끝 아닌 깨진 줄 있음 | — | `TRANSCRIPT_UNREADABLE` |
| 시각 | `2026-10-20T11:00:05Z`, `2026-10-20 11:00:05.000`, `+010000-…` | 그 줄 메시지 아님, `timestamp` | — |
| 도구 이름 `toString` | `{name:"toString", input:{path:"a"}}` | 대상 `a` | — |
| surrogate | 500번째 UTF-16 칸이 pair의 앞 | 대상 499칸, 짝 없는 surrogate 없음 | — |
| orca 머리말 | 세 머리말로 시작하는 user 줄 / 문장 중간에 든 같은 말 | 메시지 아님(`orca_header`) / 메시지 | — |
| 증분 = 전체 | 위 줄들 사이 어디에 커서가 서도 | 증분 결과 = 전체 결과의 커서 메시지부터(계약대로) | — |

</intent-contract>

## Code Map

- `packages/claude-code/src/parser.ts` -- 주 작업.
  - 16~43 버전 주석·값 `'4'`: 4가 바꾼 것(보고 없음, 호출 키, 첫 메시지 앞 호출, ok, 깨진 줄, 시각, 집계, orca)으로 다시 쓴다.
  - 55~102 `HANDBACK_*`, 116~162 `ParseStart.agents`·`Provenance`, 424~501 `AGENT_ID_PATTERN`·`SENDER_KEY`·`provenance`, 641~831 `readReport`·`readHandback`·`handbackSender`·`oldHandbackBody`, `between`·`occurrences`(다른 쓰임 없으면): 지운다.
  - 219~325 `parse` 루프: 깨진 줄 건너뛰기와 셈(278 `countLines`는 오류 문장이 없어지면 지움), 메시지 판정이 이유를 돌려주게(`readMessage`가 `{message} | {reason}`), 첫 메시지 앞 호출 보류 후 부착, `earlierPositions` 후보 추적, 결과에 `droppedLines`.
  - 347~396 `startFor`: `provenance` 없이 `readMessage(entry)`로 커서 줄 확인.
  - 548~639 `readMessage`: 보고 분기 삭제, timestamp 정규형, orca 머리말, 이유 코드.
  - 848~934 `readToolUses`·`readOutcomes`·`resolveNotes`: `callId`·`earlierPositions`, user 줄 결과만, Agent·Task 보류.
  - 164~218 클래스 docstring 필터 목록을 새 규칙대로.
- `packages/claude-code/src/tool-target.ts` -- `TARGET_KEY` hasOwn, 명시 키 둘, `FALLBACK_KEYS` 확장, 코드 포인트 자르기.
- `packages/core/src/domain/ingest-batch.ts` -- `ParsedToolNote.callId`·`earlierPositions`(타입 이름 예: `ToolNotePosition`), 음수 ordinal 뜻, `isSubagentReport` 주석(늘 false, 23).
- `packages/core/src/ports/parser.ts` -- `droppedLines`와 `unreadable` 예약 키 설명, 깨진 줄 규칙.
- `packages/core/src/codes.ts` -- `TRANSCRIPT_LINES_SKIPPED`와 뜻. `packages/core/test/codes.test.ts`의 목록, `README.md` 경고 표(587 근처)를 맞춘다(양방향 대조 테스트).
- `packages/core/src/sessions/ingest.ts` -- `IngestSessionData.droppedLines`, 경고, 모든 ok 반환(303 `nothingToStore` 포함). `packages/core/src/sessions/spool-ingest.ts`(93) -- `droppedLines: null`.
- `packages/core/src/output/mask.ts` 89 -- 잘림 판정 `>= LIMIT - 1`, 주석. `packages/core/src/domain/tool-note.ts` 주석("at most").
- `packages/core/src/testing/contracts/parser.ts` 140~158·290~310 -- 음수 ordinal, 증분 메모 비교, `droppedLines` 사례.
- `packages/core/src/testing/contracts/session-store.ts` -- 매트릭스의 Store 세 행(같은 호출 다른 자리, 옛 행 earlier 자리, 옛 행 나열 안 된 자리) 사례. `packages/core/src/testing/fakes/store.ts` 310~327 -- 같은 규칙. `packages/core/src/testing/fakes/parser.ts` -- 새 필드(`callId: null`, `earlierPositions: []`, `droppedLines`).
- `packages/sqlite/src/sessions.ts` 287~299 -- `call_id` 넣기와 건너뛰기 질의(`exists` 한 번 + `on conflict do nothing`).
- `packages/claude-code/test/parser.test.ts`, `packages/claude-code/test/tool-target.test.ts` -- 보고 사례를 "보고 없음"으로 뒤집고, 매트릭스 parser 행, 새 fixture의 grown·rewritten 계약.
- `packages/claude-code/test/fixtures/` -- 기존 다섯은 입력으로 둔다(`full-session.jsonl` 건수가 바뀌면 그 테스트 기대를 고침). 필요한 사례는 새 중립 fixture로. 버전 3 상태: 저장소 밖 스크립트가 `baseline_revision` 빌드의 parser로 `peer-handback.jsonl`·`report-provenance.jsonl`을 읽은 결과(메시지·메모·커서)를 `apps/cli/test/fixtures/parser-v3-state.json`으로 커밋한다(만든 방법은 Implementation Notes에) — 중립 fixture의 출력이라 공개해도 된다.
- `apps/cli/src/commands/sessions-ingest.ts` 56·72·119~130 -- `droppedLines`를 data에, `output` 문구.
- `apps/cli/test/sessions-ingest.test.ts` -- 1165 근처 보고 사례, 1268 `adds only the reports to a session an older parser version stored`(→ 버전 3 상태 사례로 바꿈: JSON을 SQLite store로 심고 parser_version `3`, v4 수집 뒤 호출당 메모 하나), story 22 describe(보고 0건으로), 깨진 줄·`droppedLines`·orca 사례, 521~540 30 MB 사례는 그대로 통과해야 한다.
- `packages/core/test/sessions-ingest.test.ts` -- 경고·`droppedLines` 통과, spool `null`.
- 문서: `architecture-brain-v1-slice-1.md` AD-4(parser 4가 내는 것, 버린 줄 수, 깨진 줄, 시각), AD-8/Table Contract `tool_notes`(같은 호출은 `call_id`, 옛 행은 자리, 음수 ordinal), 경고 코드 목록. `deferred-work.md`: 81행 2.7 follow-up 항목 닫기, 90행 잘림 표시 칸은 남기고 499 판정 보강을 적음, 남은 위험.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/parser.ts`, `packages/core/src/codes.ts`, `packages/core/test/codes.test.ts`, `README.md` -- 타입·경고 코드 -- parser와 Store가 같은 말을 쓰게.
- [x] `packages/core/src/testing/contracts/parser.ts`, `packages/core/src/testing/contracts/session-store.ts`, `packages/core/src/testing/fakes/*.ts` -- 계약과 가짜 -- 규칙을 어댑터 밖에서 먼저 못박는다.
- [x] `packages/sqlite/src/sessions.ts` -- 호출 키 쓰기·건너뛰기 -- #9.
- [x] `packages/claude-code/src/parser.ts`, `packages/claude-code/src/tool-target.ts` -- Always의 parser 규칙 전부, 버전 `'4'`, docstring -- #7·#8·#11~#15, 보고 없음, orca.
- [x] `packages/core/src/sessions/ingest.ts`, `packages/core/src/sessions/spool-ingest.ts`, `packages/core/src/output/mask.ts`, `packages/core/src/domain/tool-note.ts`, `apps/cli/src/commands/sessions-ingest.ts` -- 경고·`droppedLines`·잘림 판정.
- [x] `packages/claude-code/test/*`, `packages/core/test/*`, `packages/sqlite/test/*`(store 계약 실행부), `apps/cli/test/sessions-ingest.test.ts` -- 매트릭스 행마다 사례, 기존 보고 사례 갱신.
- [x] 저장소 밖 스크립트(`/tmp`) -- 버전 3 상태 JSON 만들기, 이 Mac `~/.claude/projects/*/*.jsonl` 메인 transcript의 빈 도구 대상 비율(baseline: 12,588 호출 중 424, 3.37%)과 이유별 버린 줄 수를 수정 후 빌드로 세어 Implementation Notes에 구조와 건수만 -- 티켓 verify.
- [x] `architecture-brain-v1-slice-1.md`, `deferred-work.md` -- Code Map 문구.

**Acceptance Criteria:**
- Given 버전 3 빌드가 낸 상태를 심은 세션, when `brain sessions ingest claude-code --json`(v4)으로 다시 넣으면, then `tool_notes`의 행 수가 메모될 호출 수와 같고 같은 `tool_use` id가 두 행에 걸리지 않는다.
- Given 임시 home과 `peer-handback.jsonl`·`report-provenance.jsonl`, when 수집하면, then `is_subagent_report=1` 행이 없고 보고·안내 본문이 DB 어디에도 없으며 Agent 호출 메모는 있다.
- Given 끝이 아닌 깨진 줄이 있는 transcript, when 수집하면, then exit 0, `warnings`에 `TRANSCRIPT_LINES_SKIPPED`, `data.droppedLines.unreadable`이 그 줄 수다.
- Given 21의 30 MB 사례, when 실행하면, then Stop hook 예산 안이다.
- Given 수정 전후 빌드, when 이 Mac transcript를 세면, then 빈 도구 대상 비율 전후와 이유별 버린 줄 수가 Implementation Notes에 있다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

**구조.** parser는 `readMessage`가 `ParsedMessage | DropReason`을 돌려주게 바뀌었고(이유 코드가 `droppedLines`의 키이고 `keptByVersion3`의 입력이다), 보고 읽기 일체(`readReport`·`readHandback`·`handbackSender`·`oldHandbackBody`·`HANDBACK_NOTICES`·`HANDBACK_FRAME_HEADING`·`Provenance`·`provenance`·`AGENT_ID_PATTERN`·`SENDER_KEY`·`between`·`occurrences`·`countLines`)가 없어졌다. `ParseStart`는 `agents`를 잃었다. 도구 메모는 `NoteContext`를 들고 도는 `readToolUses`가 만들고, 첫 메시지 앞 호출은 `beforeFirst`에 모여 첫 메시지가 오면 `-p … -1`로 붙는다. `earlierPositions`는 `EarlierAnchor`(마지막 메시지 뒤로 버전 3이 메시지로 남겼을 줄 + 그때까지의 호출 수) 목록에서 뺄셈으로 나온다 — 메시지를 만나면 목록을 비우므로 창은 항상 "앞 메시지 ~ 이 호출" 사이다. 줄 읽기는 `readEntry`가 "JSON이 아님"과 "JSON이지만 객체가 아님"을 구분한다 — 뒤쪽(`null`·`[]`·`42`)은 읽히기는 했으므로 `unreadable`이 아니라 `not_conversation`이고, 그래서 경고도 나지 않고 그런 줄만 있는 파일도 거부되지 않는다. spool로 가는 길은 파싱 뒤에 잠금을 만난 경우 그 읽기의 `droppedLines`와 경고를 함께 낸다(`SpoolSessionIngestRead`); `null`은 파싱 앞의 `findSession` 실패 하나뿐이다. Store(SQLite·가짜)는 세션의 메모를 루프 앞에서 한 번 읽어 `call_id` 집합과 "`call_id`가 null인 자리" 집합을 만들고, 그 둘로 건너뛴 뒤 `on conflict do nothing`(대상 없는 형태 — 자리 키와 `tool_notes_call_id_idx` 둘 다 받는다)으로 넣는다.

**버전 3 상태 fixture.** `apps/cli/test/fixtures/parser-v3-state.json`은 `baseline_revision`(8285bd1) 빌드의 parser가 연결기 fixture 셋(`full-session.jsonl`·`peer-handback.jsonl`·`report-provenance.jsonl`)을 읽은 결과(메시지·메모·커서)다. 만든 방법: `git show 8285bd1:packages/claude-code/src/{parser,tool-target}.ts`를 저장소 밖(`/tmp`)에 꺼내 Core의 타입 import를 떼고 `TOOL_NOTE_TARGET_LIMIT`을 500으로 박고 `node --experimental-strip-types`로 돌렸다. 중립 fixture의 출력이라 공개해도 된다. 테스트는 그것을 SQLite에 심고(`seedParserV3State`, `parser_version` `3`, `call_id` 전부 null) v4로 다시 수집한다. `full-session.jsonl`이 핵심 사례다 — 버전 3은 첫 run의 동기 결과 줄을 보고로 읽었으므로 둘째 `Agent` 호출의 메모가 그 줄에 걸려 있었고, v4는 그것을 사람이 쓴 메시지로 되돌린다.

**실측(2026-10-21, 이 Mac `~/.claude/projects/*/*.jsonl` 메인 transcript 256개, `/tmp` 스크립트 한 번의 통과, 구조와 건수만).** 숫자는 **한 번의 통과**에서 나온 것이다 — transcript는 지금도 자라고 있어(이 세션 자신의 파일 포함) 여러 번 돌린 결과를 섞으면 서로 몇 건씩 어긋난다.
- 줄 163,500개, timestamp 113,026개 중 정규형 어긋남 **0**, JSON으로 읽히지 않은 줄 **0**, 거부된 파일 **0**.
- 빈 도구 대상: 12,679 호출 중 **426 → 177**(3.36% → 1.40%). 남은 쪽의 머리: Claude Docs `update`·`read`, playwright `run_code_unsafe`, `Artifact`, `ListAgents`(입력 없음).
- 버린 줄(이유별 합계): `not_conversation` 120,213 · `empty` 35,049 · `meta` 658 · `not_human` 172 · `tool_output` 32 · `orca_header` 30 · `api_error` 4 · `unreadable`·`duplicate`·`sidechain`·`incomplete`·`timestamp` 각 0.
- 메시지: 버전 3이 7,772개(보고 400개) → 버전 4가 7,342개(보고 0개). 7,772 − 400 − 30(orca) = 7,342로 정확히 맞는다.
- 도구 메모: 양쪽 **12,677개**. 자리가 달라진 메모 **508**개(전부 `earlierPositions`로 옛 자리를 찾는다), 자리가 그대로인 메모 12,169개, `earlierPositions`를 싣는 메모 907개(최대 8자리).
- 첫 메시지 앞 호출로 남는 메모 **89**개. 이것은 "새로 생기는 행 89개"가 아니다 — 버전 3은 메시지가 **하나도** 앞에 없는 호출만 버렸고, 이 기계의 89개는 전부 버전 3에게는 앞 메시지가 있었다(버전 4가 이제 버리는 줄 — 보고, orca 머리말). 그래서 버전 3은 그 89개를 이미 그 줄에 저장해 두었고, `earlierPositions`가 바로 그 자리를 가리킨다(89/89가 `earlierPositions`로 맞고, 자기 자리로 맞는 것은 0개). 두 버전 모두에게 앞 메시지가 없는 호출(진짜로 도구 호출로 시작하는 transcript)은 이 기계에 없다 — 그런 호출이라면 버전 4가 버전 3에 없던 행을 쓴다.
- **버전 3 상태 위에 버전 4를 다시 넣는 시늉**: 새로 쓰일 메모 **0행**(음수 ordinal 메모 포함 0행), 짝을 못 찾는 옛 행 **0행**. 즉 `call_id`+`earlierPositions`가 이 기계의 모든 호출을 알아본다.
- `tool_result`가 user가 아닌 줄에 **457**개, 전부 `type: api-request-blob`.
- `Agent`·`Task` 호출 **517**개: 호출과 결과 사이에 대화 메시지가 낀 것 **0**건 → 보류가 커서를 붙잡지 않는다. 결과가 아직 없는 것은 읽는 순간 돌고 있던 run뿐이다(한 번 쟀을 때 1건, 한 시간 뒤 0건).

**바꾸지 않은 것.** 스키마·마이그레이션(잘림 표시 칸 포함), `is_subagent_report` 칸, Postgres(세션 저장소가 아직 없다).

## Plan Change Log

## Review Triage Log

### 2026-10-21 — Review pass
- 리뷰어: quick 렌즈, Orca orchestration의 codex 워커(`gpt-6.1-terra`, 사용자 지시), run `run_9526a878f583`.
- verdicts: 2 findings — high 0, medium 1, low 1, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 파싱 뒤 DB 쓰기가 막혀 spool로 가면 `droppedLines`가 `null`이 되고 `TRANSCRIPT_LINES_SKIPPED`가 사라진다(Always: `null`은 파싱 전 spool뿐, 경고는 모든 ok 반환) — 확인함(`ingest.ts`의 `spooled`가 파싱 결과를 받지 않음, 리뷰어가 메모리 포트로 재현). 그 동작을 굳히던 Core 테스트도 파싱 뒤 실패를 쓰고 있었다. 고침: `spoolSessionIngest`가 선택 인자로 읽기 결과를 받아 파싱 뒤 세 자리(`readSelfUser`·`ensureSession`·`ingest`)에서 `droppedLines`와 읽기 경고(spool 경고 뒤, 중복 없이)를 낸다. `findSession` 실패만 `null`. 테스트를 파싱 전·후 둘로 나눔.
  - `[low]` `[patch]` 객체가 아닌 JSON 줄(`null`·`[]`·`42`)을 `unreadable`로 세어 거짓 경고를 내고, 그런 줄뿐인 파일을 거부한다 — 확인함(`readJson`이 파싱 실패와 비객체를 둘 다 `undefined`로). 실제 transcript에는 없지만 고침이 직접 수정이다. 고침: 파싱 루프만 `readEntry`로 둘을 구분해 비객체는 `not_conversation`, `anyJson` 참. parser 사례 둘.

## Design Notes

실측(2026-10-21, 이 Mac 메인 transcript 252개, `/tmp` 스크립트, 구조와 건수만):
- 줄 162,103개, timestamp 112,024개, 정규형 어긋남 0, 깨진 줄 0(끝 포함). 시각·깨진 줄 규칙은 지금 저장될 메시지를 잃지 않는다.
- 메인 Agent·Task 호출 514개: 결과 없음 0, 결과 전에 대화 메시지가 낀 것 0(결과 `async_launched` 383·`completed` 129). 그래서 Agent 보류는 커서를 붙잡지 않는다 — 계약("커서는 마지막 메시지")을 지키고, 드물게 보류된 메모는 다음 버전 업의 전체 다시 읽기에서 온다(버린 것은 돌아온다는 parser의 원칙).
- `tool_result`가 user가 아닌 줄에 453개, 모두 `type: api-request-blob`.
- 빈 대상 424개: SendMessage 102(`to` 있음), AskUserQuestion 101(`questions` 배열), Claude Docs 도구 98(객체 입력만), playwright 61(`code`·`filename`), Artifact 11, ListAgents 11(입력 없음), atlassian 15(`cql`·`pageId`), TaskStop 7(`task_id`) 등.
- orca 머리말로 시작하는 user 줄 30(티켓의 31과 한 줄 차이 — 측정 시점).

왜 `earlierPositions`인가: 버전 3의 메시지 집합은 버전 4의 것을 품는다(4는 보고·orca·어긋난 시각 줄을 더 버릴 뿐 새로 메시지로 만드는 줄이 없다 — 3은 깨진 줄이 있으면 파일을 통째로 거부해 상태가 없다). 그래서 같은 호출의 3 자리는 4 자리와 같거나, 둘 사이에서 4만 버린 줄 R이 3의 앞 메시지였던 경우뿐이고, 그 자리는 R부터 센 호출 수로 정확히 정해진다. 저장된 행에 R이 없으면(3도 버렸으면) 그 후보는 맞지 않으므로 상위 집합이 안전하다. 비슷한 도구·대상으로 맞추는 짐작은 다른 호출을 지울 수 있어 고르지 않았다. 실제 수집은 14부터라 버전 3 상태는 테스트와 개발 home에만 있다.

왜 음수 ordinal인가: 첫 메시지 뒤 호출을 0부터 그대로 두어야 버전 3 자리와 증분 읽기(커서가 첫 메시지일 때 그 앞 줄은 다시 읽지 않는다)가 맞는다. 앞 호출을 0부터 세고 뒤를 밀면 증분 읽기가 다른 ordinal을 내고 옛 키에 부딪혀 메모를 잃는다.

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project claude-code --project core --project sqlite --project cli` -- expected: 모두 통과 — **통과**
- `pnpm test` -- expected: build·typecheck·vitest 전체 통과(postgres는 Docker가 없으면 건너뜀을 기록) -- **통과(64 파일, 2,127 사례). Postgres 저장소 테스트는 이 저장소에 아직 없다(`packages/postgres/src`에 세션 저장소가 없음)**
- `git grep -nE "/Users/" -- packages apps _bmad-output/personal-brain/epic-capture/story-parser-v4-plan.md` -- expected: 새로 넣은 절대 경로 없음 -- **없음(README의 `/Users/me` 예시만 그대로)**
- 30 MB 사례(`apps/cli/test/sessions-ingest.test.ts`, Stop hook 예산 5초) -- **통과**

**매트릭스 행별 사례(모두 `pnpm test`에서 통과).**

| Scenario | 파일 | `describe` > `it` |
|---|---|---|
| 버전 3 상태 다시 읽기 | `apps/cli/test/sessions-ingest.test.ts` | `brain sessions ingest claude-code and a report handed back` > `leaves one note per call when it re-reads full-session.jsonl over what version 3 stored`(+ `peer-handback.jsonl`·`report-provenance.jsonl` 두 행), `stores no report when it re-reads over what version 3 stored` |
| 같은 호출 다른 자리 | `packages/core/test/contracts.test.ts`, `packages/sqlite/test/session-store.test.ts` | `the session contract against the memory store` / `… the SQLite store` > `a call the session already holds is not stored at a second position`. mutant: `the contracts catch a wrong store` > `catches a store that stores the same call again at a second position` |
| 옛 행, 나열된 자리 | 같음 | `a note at a position an older version used is recognised by that position`. mutant: `catches a store that ignores the positions an older version used` |
| 옛 행, 나열 안 된 자리 | 같음 | `a note whose earlier positions name no stored row is a new call` |
| 보고 없음 | `packages/claude-code/test/parser.test.ts`, `apps/cli/test/sessions-ingest.test.ts` | `the Claude Code parser on the two report fixtures` > `stores nothing of a report or of the framing around one, in the hand-back fixture` / `… in the provenance fixture`; `the Claude Code parser on a whole session` > `stores no subagent report, in either shape the editor writes one`; CLI `… and a report handed back` > `stores neither report, and neither the notice nor the framing`, `… and where a report came from` > `stores the three turns and nothing the rules threw away`, `… on a whole session` > `stores no report of a delegated run and none of its conversation` |
| 첫 메시지 앞 호출 | `packages/claude-code/test/parser.test.ts` | `the Claude Code parser on a call made before the first message` > `hangs it on the next message at a negative ordinal, in file order`(+ `drops it when the read never reaches a message at all`) |
| 대화 아닌 줄의 결과 | 같음 | `the Claude Code parser on what decides a call worked` > `reads an outcome only from a line of the conversation` |
| 끝나지 않은 Agent | 같음 | `… on what decides a call worked` > `leaves a delegated call without a result for the next read`(+ `writes a delegated call once its result lands`) |
| 깨진 중간 줄 | 같음, `apps/cli/test/sessions-ingest.test.ts` | `the Claude Code parser` > `skips a broken line in the middle and counts it, keeping the rest`; CLI `… on the lines it did not keep` > `collects the rest of a transcript with a broken line and warns about it` |
| 모두 깨짐 | 같음 | `the Claude Code parser` > `refuses content with no readable line in it at all`; CLI `brain sessions ingest on the hook path` > `says TRANSCRIPT_UNREADABLE for a file with no readable line in it` |
| 시각 | `packages/claude-code/test/parser.test.ts` | `the Claude Code parser` > `reads no instant from %s, so that line is not a message` 다섯 행(`a sentence`·`no milliseconds`·`a space for the T and no zone`·`an expanded year`·`a day the calendar has not got`), 그리고 `keeps an instant written exactly the way the harness writes it` |
| 도구 이름 `toString` | 같음 | `what a tool note says the call acted on` > `looks the tool up by its own key alone` |
| surrogate | 같음 | `what a tool note says the call acted on` > `cuts on a character boundary, never through a surrogate pair` |
| orca 머리말 | 같음, `apps/cli/test/sessions-ingest.test.ts` | `the Claude Code parser` > `drops a user line that opens with the orca heading %s` 세 행, `keeps a line that only mentions the same words mid-sentence` 두 행; CLI `… on the lines it did not keep` > `drops a user line that opens with one of orca orchestration headings` |
| 증분 = 전체 | `packages/core/test/contracts.test.ts`(가짜), `packages/claude-code/test/parser.test.ts` | 계약 `a cursor the content still fits is read from, and nothing before it`·`the same content and cursor parse to the same result twice`·`tool notes are unique per message and ordinal, and point at a parsed message`·`the dropped-line counts are non-negative integers under their own reasons`; 그리고 `the Claude Code parser on a whole session` > `answers for the whole content even when it read only the tail`, `… on a call made before the first message` > `does not report it again once the cursor stands on that message` |

버린 줄 합계 불변식은 `the Claude Code parser on a whole session` > `counts every line it walked past, under the reason that caught it`, 자리 이동은 같은 describe의 `names the position version 3 may have stored the same call under`가 본다.

## Auto Run Result

Status: built

**바뀐 것.** Claude Code parser를 버전 `'4'`로 올려 2.7 follow-up 리뷰 #7~#9·#11~#15와 2026-10-21 결정 둘을 반영했다.
- 서브에이전트 보고를 읽는 코드(동기 결과·task-notification·peer handback, 안내 문장, 옛 handback 틀, `Provenance`)를 걷어 냈다. `isSubagentReport`는 늘 false, Agent 호출 메모는 남는다.
- orca 고정 머리말 셋으로 시작하는 user 줄은 메시지가 아니다.
- 도구 메모가 `callId`와 `earlierPositions`를 내고, Store(SQLite·가짜)는 `call_id`로, `call_id`가 없는 옛 행은 자기 자리나 이전 버전 자리로 같은 호출을 알아본다(#9). 첫 메시지 앞 호출은 그 메시지에 음수 ordinal로 붙는다(#8).
- ok는 대화 줄(user, 사이드체인 아님)의 `tool_result`로만 정하고, 결과 없는 Agent·Task 호출은 실패로 쓰지 않는다(#7).
- 끝이 아닌 깨진 줄은 건너뛰고 `TRANSCRIPT_LINES_SKIPPED`로 알린다(#11). timestamp는 정규형만 믿는다(#12). 도구 대상은 자기 키로만 찾고 키를 넓히고 코드 포인트에서 자른다(#13·#14), 출력 잘림 판정은 `LIMIT - 1`부터.
- 버린 줄을 이유 12개로 세어 parser 결과와 `sessions ingest`의 `data.droppedLines`로 낸다(#15).

**파일.**
- `packages/claude-code/src/parser.ts` — 버전 4, 보고 읽기 삭제, 이유 코드, 호출 키·이전 자리, 첫 메시지 앞 호출, ok 규칙, 깨진 줄·시각·orca.
- `packages/claude-code/src/tool-target.ts` — hasOwn 조회, `SendMessage`·`AskUserQuestion`, 식별 키, 코드 포인트 자르기.
- `packages/core/src/domain/ingest-batch.ts`·`ports/parser.ts`·`ports/store.ts`·`domain/tool-note.ts`·`domain/index.ts`·`index.ts` — `callId`·`earlierPositions`·`ToolNotePosition`·`droppedLines` 타입과 설명.
- `packages/core/src/codes.ts`, `README.md`, `packages/core/test/codes.test.ts` — `TRANSCRIPT_LINES_SKIPPED`.
- `packages/core/src/sessions/ingest.ts`·`spool-ingest.ts` — 경고와 `droppedLines`(파싱 뒤 spool 포함).
- `packages/core/src/output/mask.ts` — 잘림 판정 `>= LIMIT - 1`.
- `packages/core/src/testing/contracts/*`·`fakes/*`, `packages/core/test/*` — 계약(음수 ordinal, 증분 메모, `droppedLines`, Store 세 행), 가짜, 돌연변이 넷.
- `packages/sqlite/src/sessions.ts` — `call_id` 쓰기와 같은 호출 건너뛰기.
- `apps/cli/src/commands/sessions-ingest.ts` — `data.droppedLines`와 `output` 문구.
- `apps/cli/test/sessions-ingest.test.ts`, `apps/cli/test/fixtures/parser-v3-state.json`, `packages/claude-code/test/parser.test.ts` — 버전 3 상태 다시 읽기, 보고 없음, 매트릭스 행.
- `architecture-brain-v1-slice-1.md`(AD-4·AD-8·Table Contract·경고 목록), `deferred-work.md` — 결정, 닫은 항목, 남은 위험.

**리뷰.** quick 렌즈 1회(codex `gpt-6.1-terra`, Orca). 지적 2건: patch 2(medium 1 — 파싱 뒤 spool의 집계·경고, low 1 — 비객체 JSON 줄), defer 0, reject 0.

**후속 리뷰 권고:** `false`. 첫 패스에서 patch는 medium 1·low 1이고 high는 없다.

**검증.** `pnpm test`(build·typecheck·vitest) 통과 — 리뷰 patch 뒤 64파일 2,130건, 실패 0. I/O 매트릭스 14행이 모두 실행·통과한 테스트로 덮였다(Verification의 표). 30 MB Stop hook 예산 사례 통과. 새 diff에 절대 홈 경로 없음.

**남은 위험.**
- `earlierPositions`는 일부러 넓게 잡은 후보이고 상한이 없다(실측 최대 8).
- 결과 없는 Agent·Task 호출의 메모는 다음 전체 다시 읽기(버전 업)에서야 온다(실측: 진행 중인 run 1건뿐).
- 잘림 표시 칸이 없어 정확히 499·500자인 대상은 출력에서 끝 토큰을 가린다(deferred).
- `parser-v3-state.json`은 자동으로 다시 만들어지지 않는다. 연결기 fixture를 바꾸면 Implementation Notes의 방법으로 다시 만든다.
- Store는 수집마다 그 세션의 도구 메모 키를 한 번 읽는다. 30 MB 사례는 예산 안이지만 메모가 아주 많은 세션에서는 비용이 커진다.
