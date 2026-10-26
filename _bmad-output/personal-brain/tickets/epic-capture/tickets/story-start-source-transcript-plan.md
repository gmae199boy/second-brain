---
title: '수집 경로 보강: 커서 경고·start_source·큰 transcript'
type: 'bugfix'
ticket: '21'
created: '2026-10-21'
status: done
baseline_revision: 'ea4d7660fb389e36d0450466f2beb76de9a059b1'
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

**Problem:** 2.7 follow-up 리뷰 #16~#20(`story-transcript-parser-follow-up-review.md`)이다. 메시지 없는 reset 읽기는 `CURSOR_RESET`을 잃고 낡은 커서를 남겨 매번 처음부터 읽는다(#16). 겹친 reset 읽기 둘이 커서를 뒤로 돌린다(#17). `start_source`는 마지막 `SessionStart`가 덮어쓴다(#18). 세션 행·내역 기록의 예외가 코드 대신 예외로 샌다(#19). parser는 커서와 상관없이 파일 전체를 여러 번 훑는다(#20, 30.7 MB transcript가 있다). #10(읽기 순서)은 24가 닫았다.

**Approach:** 첫 시도(`story-start-source-transcript-plan-attempt-1.md`·`.patch`, 기준 `f69b9a5`)의 변경을 정렬 부분만 빼고 다시 쓴다. reset 읽기는 메시지가 없어도 Store `ingest`를 거쳐 경고를 내고 커서를 지운다. 배치는 읽기 시작 때의 커서(`cursorBase`)를 들고 가고, Store는 reset 이동을 "지금 커서 = 그 기준"일 때만 허용한다(그 밖에는 24의 `occurred_at` 전진 규칙). `start_source`는 첫 값을 지킨다. parser 앞부분 확인은 해시 한 번이다.

## Boundaries & Constraints

**Always:**
- 커서 규칙(SQLite와 가짜가 같다, 포트 주석도 같은 말):
  - reset이고 세션의 지금 커서가 `tracking.cursorBase`와 같으면(둘 다 null이거나 id·fingerprint가 같음) 배치 커서로 바꾼다. 배치 커서가 null이면 커서를 지운다(`last_harness_message_id`·`cursor_fingerprint` 둘 다 null).
  - 그 밖(reset 아님, 또는 기준과 다른 reset)은 24의 규칙 그대로다. 배치 커서 null이면 그대로 둔다. 저장 커서가 없거나 그 메시지가 세션에 없거나, 새 커서 메시지의 `occurred_at` ≥ 저장 커서 메시지의 것이면 바꾼다.
- `cursorBase`는 Core ingest가 `findSession`으로 읽은 저장 커서다(세션 없으면 null). `IngestTracking`의 필수 칸이다. 배치는 spool에 직렬화되지 않는다(`domain/spool-record.ts`).
- `CURSOR_RESET`은 지금처럼 Store가 `tracking.cursorReset`으로 낸다.
- `start_source`: parser는 transcript의 **첫** `SessionStart:<source>`를 내고 거기서 멈춘다. 다섯 값은 startup·resume·clear·compact·fork다. Store는 `start_source`가 null일 때만 쓴다. 증분 읽기의 `startSource`는 전체 읽기와 같다.
- 예외는 코드로: SQLite `ensureSession`의 `toSession`, `recordTranscriptFile`의 `instant`·`toTranscriptFile`이 `DB_UNAVAILABLE`로 답한다(한국어 message). `withWrite`의 외래 키 위반은 그대로 예외다(호출자 버그). Core ingest는 `recordTranscriptFile`이 던져도 삼키고 결과를 바꾸지 않는다.
- parser 증분 읽기는 앞부분(커서 줄까지)을 sha256으로 한 번만 지난다. 새 커서 fingerprint는 `Hash.copy()`로 이어 만든다. 커서 줄은 뒤에서부터 찾는다. 줄 번호는 오류 때만 센다. task-notification의 `agentId` 확인은 앞부분을 한 번만(늦게) 모은 집합에 꼬리 줄을 더해 보며, 답은 지금과 같다.
- 사람이 읽는 새 문구는 한국어, 주석은 영어로 *왜*를 적는다.

**Never:**
- `CLAUDE_CODE_PARSER_VERSION`(`'3'`) 변경, parser가 내는 메시지·도구 메모의 변경(22·23).
- 읽기 정렬·도구 메모 정렬·`seq` 관련 코드나 사례를 되살리기(24가 정했다). attempt-1 patch의 "늦게 온 메시지" 계약 사례, "`seq` 순서로 읽는 store" 변이, README 정렬 문단은 가져오지 않는다.
- 스키마·마이그레이션 변경, 런타임 reader(`apps/cli/src/runtime/transcript.ts`) 변경, 30 MB fixture 커밋.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 메시지 없는 reset | 커서 있는 세션, transcript가 메시지 없는 내용으로 바뀜 | `ok`, `warnings: ['CURSOR_RESET']`, 세션 커서 null. 다음 수집은 `warnings: []` | — |
| 겹친 reset 둘 | 둘 다 기준 X에서 읽음, 긴 쪽(Y) 먼저 커밋, 짧은 쪽(Z, Y보다 이른 시각) 나중 | 커서 Y 유지 | — |
| 혼자인 reset | 지금 커서 = 기준, 새 커서가 더 이른 시각 | 새 커서로 이동 | — |
| startup→resume | `SessionStart:startup` 뒤 `resume` | parser·저장 모두 `startup`, 증분 읽기도 | — |
| 나중에 안 start | 첫 수집 null, 다음 배치 `resume`, 그다음 `startup` | 저장 `resume` 유지 | — |
| 잘못된 시각 세션 행 | `sessions.started_at`이 glob은 맞고 날짜가 아님 | `brain sessions ingest`가 스택 없이 코드로 끝남 | 예외 금지 |
| 내역 기록이 던짐 | `recordTranscriptFile` throw | 수집 `ok`, 결과 같음 | 삼킴 |
| 30 MB 증분 | 큰 `tool_result` 줄들 + task-notification 줄 다수, 한 턴 덧붙임 | 두 번째 수집 < 5000 ms | — |

</intent-contract>

## Code Map

- `_bmad-output/personal-brain/tickets/epic-capture/tickets/story-start-source-transcript-plan-attempt-1.patch` -- 출발점. `git apply -3`이 11개 파일은 깨끗이, `packages/core/src/ports/store.ts`·`packages/core/src/testing/contracts/session-store.ts`·`packages/core/src/testing/fakes/store.ts`·`packages/sqlite/src/sessions.ts`·`README.md`(3-way)는 충돌로 붙는다. 충돌은 24가 바꾼 정렬·커서 비교 자리다. 충돌 해소 규칙: 24의 현재 코드(정렬, `occurred_at` 비교)를 남기고 patch의 cursorBase·start_source·예외 부분만 얹는다. attempt-1 plan의 Implementation Notes와 Design Notes(`cursorMove` → `{ move, to }`)가 patch의 의도다.
- `packages/sqlite/src/sessions.ts` -- `ensureSession`의 `toSession` try(191), `start_source` update(297)에 `and start_source is null`, 302 커서 쓰기와 `cursorMayMove`(508, 지금은 `occurred_at` 비교) → patch의 `cursorMove`/`storedCursor`/`sameCursor`, 단 전진 비교는 `occurred_at` 그대로. `readSession`의 `order by`(372·389)는 손대지 않는다.
- `packages/core/src/testing/fakes/store.ts` -- `nextCursor`(699, `occurredAt` 비교)에 reset·`cursorBase`·지우기 규칙. 352 `startSource`는 `session.startSource ?? batch.tracking.startSource`로. 정렬(334 부근)은 그대로.
- `packages/core/src/ports/store.ts` -- `ingest` 계약 문구에 reset 이동 조건·커서 지우기·첫 `startSource`. 24의 시각 순서 문구는 유지.
- `packages/core/src/testing/contracts/session-store.ts` -- patch에서 가져올 사례: start source 첫 값 유지, 겹친 reset 블록, reset 커서 사례의 `cursorBase`, 메시지 없는 reset 배치가 경고하고 커서를 지움. 가져오지 않을 것: 601행 hunk의 "late message keeps the next free seq" 사례(24에 같은 사례가 있다).
- `packages/core/test/contracts.test.ts` -- patch의 변이 셋 중 "overlapping reset winds back"·"later batch overwrites start source"만. "reads … in the order it stored the rows"는 빼고(`.seq` 참조, 24에 대체물 있음).
- 깨끗이 붙는 파일(내용 확인 후 `seq` 참조가 남으면 걷어 낸다): `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/parser.ts`, `packages/core/src/sessions/ingest.ts`, `packages/core/src/testing/fixtures.ts`, `packages/core/test/sessions-ingest.test.ts`, `packages/sqlite/src/transcript-files.ts`, `packages/claude-code/src/parser.ts`, `packages/claude-code/test/parser.test.ts`, `apps/cli/test/sessions-ingest.test.ts`, `_bmad-output/personal-brain/deferred-work.md`.
- `apps/cli/test/sessions-ingest.test.ts` -- patch의 30 MB 생성기(`tool_result` 1 MB 줄 30개)에 task-notification 줄을 많이(예: 수백 개, `agentId`가 앞부분 Agent 호출에 있는 것) 더해 #20의 제곱 비용 경로를 지나게 한다(attempt-1 리뷰 4번). 시간은 `performance.now()`, 실패 message에 ms.
- `README.md` -- 298~304 순서 문단(24)은 그대로 두고, 그 뒤에 patch의 `start_source` 문단만 넣는다. 581 `CURSOR_RESET` 표 줄은 바뀌면 맞춘다(`apps/cli/test/readme-codes.test.ts`).
- `_bmad-output/personal-brain/deferred-work.md` -- patch의 새 행에서 #10 문장을 빼고 "#10은 24"로, 겹친 reset의 대체 규칙을 "`occurred_at` 전진 규칙"으로 고쳐 쓴다. 날짜 2026-10-21.

## Tasks & Acceptance

**Execution:**
- [x] `_bmad-output/personal-brain/tickets/epic-capture/tickets/story-start-source-transcript-plan-attempt-1.patch` -- `git apply -3`으로 얹고 충돌 네 곳을 Code Map 규칙으로 푼다 -- 검증된 변경을 재사용한다.
- [x] `packages/sqlite/src/sessions.ts`, `packages/core/src/testing/fakes/store.ts`, `packages/core/src/ports/store.ts` -- 커서 규칙을 `occurred_at` 전진 비교 위에 얹는다 -- 두 Store가 같은 규칙.
- [x] `packages/core/src/testing/contracts/session-store.ts`, `packages/core/test/contracts.test.ts` -- 가져올 사례·변이만 남기고, 변이 둘이 각각 계약에 걸리는지 확인한다.
- [x] `apps/cli/test/sessions-ingest.test.ts` -- 30 MB 생성기에 task-notification 줄을 더하고, 이 스토리 전 parser(baseline)와 새 parser의 두 번째 수집 시간을 재서 Implementation Notes에 적는다.
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문구.
- [x] `packages/`·`apps/`·`README.md` -- `git grep -nE "\bseq\b|seqFrom|seqTo"`로 `seq`가 다시 들어오지 않았는지 확인한다(남아도 되는 곳은 24 plan AC의 허용 목록) -- 24의 결정을 지킨다.

**Acceptance Criteria:**
- Given 커서가 있는 세션의 transcript가 메시지 없는 내용으로 바뀜, when `brain sessions ingest claude-code`를 두 번 돌리면, then 첫 `warnings`는 `["CURSOR_RESET"]`, 둘째는 `[]`다.
- Given 같은 기준에서 읽은 reset 배치 둘, when 짧은 쪽이 나중에 커밋되면, then `readSession`의 커서는 긴 쪽 것이다(두 Store 계약).
- Given startup으로 시작해 resume된 transcript, when 수집하면, then 저장된 `start_source`는 `startup`이고, 다섯 값 각각의 transcript는 그 값을 낸다.
- Given 잘못된 시각이 든 세션 행, when 그 세션을 수집하면, then 프로세스는 스택 없이 코드 있는 결과로 끝난다.
- Given task-notification 줄이 많은 30 MB 생성 transcript를 한 번 수집한 뒤 한 턴을 덧붙임, when 다시 수집하면, then 5000 ms 미만이고 그 값과 baseline parser의 값이 plan에 기록된다.

## Implementation Notes

**patch 충돌 네 곳(다섯이 아니었다).** `git apply -3`은 `README.md`도 깨끗이 붙였다
— 24가 손댄 자리와 patch의 `start_source` 문단이 겹치지 않았기 때문이다. 충돌은
`packages/core/src/ports/store.ts`, `packages/core/src/testing/fakes/store.ts`,
`packages/core/src/testing/contracts/session-store.ts`,
`packages/sqlite/src/sessions.ts` 넷이고, 모두 Code Map 규칙대로 24의 코드(정렬,
`occurred_at` 비교)를 남기고 patch의 의도만 얹었다. 구체적으로:

- `sqlite/src/sessions.ts`의 `cursorMove`는 patch의 `{ move, to }` 모양과
  reset 단축로를 가져오고, 전진 비교는 24의 `occurred_at` 그대로 두었다
  (patch의 `storedSeq`/`seqOf` 자리를 `storedAt`/`instantOf`로 읽었다).
  `readSession`의 `order by` 셋(372·398·425 부근)은 24의 것 그대로다.
- `fakes/store.ts`의 `nextCursor`도 같다. 정렬 두 곳(메시지, 도구 메모)은 24의 것.
- 세 주석(`ports/store.ts`의 `ingest` 계약, 두 `nextCursor`/`cursorMove` 머리글)은
  24의 `occurred_at` 문단과 patch의 reset·`cursorBase` 문단을 한 문서로 합쳤다.

**가져오지 않은 것.** patch의 계약 사례 `a message that arrived late is read where
it was said, not where it was stored`와 그 `lateNoteId`, 그리고 변이 `catches a
store that reads a session in the order it stored the rows`는 `seq`를 참조하고 24에
대체물(`a message uttered in the middle of a stored conversation is read in its
place`, `catches a store that reads the messages in the order they were
inserted`)이 있어 걷어 냈다. 가져온 변이 둘(`catches a store that lets an
overlapping reset wind the cursor back`, `catches a store that lets a later batch
overwrite the start source`)은 각자의 계약 사례 이름을 `failedCases`에서 찾으므로,
그 둘이 통과한다는 것이 "변이가 계약에 걸린다"는 확인이다.

**24의 reset 사례에 `cursorBase`를 더했다.** 24가 쓴 사례 `the cursor does not go
backwards unless the parse was reset`와 `the cursor is compared by when the
messages were uttered, not by when they arrived` 둘 다 마지막에 reset 배치로 커서를
뒤로 옮기는데, 새 규칙에서는 `cursorBase`가 없으면(null) 그 이동이 막힌다. 두
사례의 reset 배치에 그때의 세션 커서를 `cursorBase`로 넘겼다 — 사례가 말하려는
것("reset은 뒤로 갈 수 있다")은 그대로고, 거기에 "단, 그 읽기가 아직 최신일 때"가
붙은 것이다. patch의 새 사례 `two reset batches from one base leave the cursor
where the longer read put it`가 그 조건을 따로 받친다.

**30 MB 증감 측정(Acceptance 마지막 줄).** `apps/cli/test/sessions-ingest.test.ts`의
"reads a 30 MB transcript again inside the Stop hook budget". 생성 fixture는
attempt-1의 1 MB `tool_result` 줄 30개에 세 가지를 더했다:

1. 앞부분에 `"agentId"`를 품은 `Agent` 호출 줄 하나(앞부분 훑기가 실제로 찾을 것),
2. 커서 앞에 그 agent의 보고 notification 하나(같은 질문의 "예" 답 — 이게 빠지면
   행 수가 달라져 fixture가 조용히 썩지 않는다),
3. 커서 **뒤**에 이 세션이 시작하지 않은 run을 가리키는 notification
   `HUGE_NOTIFICATIONS = 6000`개.

커서가 마지막 **메시지**(`That is all of them.`)에 서므로 증분 읽기의 꼬리가 바로
그 6000줄이고, 줄마다 "이건 내 agent인가"를 묻는다 — #20의 제곱 비용 경로다.

| parser | 두 번째 수집 |
|---|---|
| 이 스토리의 parser | **152 ms** (152·151·154, 예산 5000 ms) |
| baseline `ea4d766`의 parser(이 파일만 되돌려 측정) | **7 350 ms** (7351·7344) |

즉 이번 fixture는 attempt-1과 달리 실제로 회귀를 막는다(attempt-1은 142 ms 대
129 ms로 가르지 못했고, 리뷰 4번이 그 점을 지적했다). 알림 수를 고른 근거도
측정이다 — 300개에서는 baseline이 480 ms로 예산 안이고, 4 000개에서 4 805 ms로
예산에 닿을 뿐이어서 6 000개로 올렸다. 첫 수집(예산 없음)은 새 parser에서 테스트
전체 846 ms 안에 들어간다.

**Postgres는 손댈 것이 없다.** `packages/postgres/src/store.ts`는 아직
`SessionStore`를 구현하지 않으므로(세션 계약은 Core 가짜와 SQLite 둘만 돈다) 새
커서·`start_source` 규칙을 옮길 adapter가 없다.

**`README.md`의 `CURSOR_RESET` 줄(587행)은 그대로다.** "커서를 잃어서 파서가
트랜스크립트를 처음부터 읽었습니다"는 메시지 없는 reset에도 맞는 말이라
`apps/cli/test/readme-codes.test.ts`가 대조하는 문구를 건드리지 않았다. patch가
넣은 `seq` 정렬 문단은 버리고 `start_source` 문단만 24의 순서 문단 뒤에 남겼다.

**Verification 결과(2026-10-21).** `pnpm test`(build·typecheck·vitest) 통과 — 64
파일 2 065 사례, 실패 0. 이 기계에는 Docker가 있어서 postgres 프로젝트도 건너뛰지
않고 돌았다(3 파일 83 사례, 건너뛴 사례 0). I/O 매트릭스 8행이 모두 통과한 테스트로
덮였다. `seq` grep은 24 plan AC의 허용 목록(0001·0004·0006 마이그레이션, Postgres
0001과 그 테스트, 옛 버전 DB를 만드는 테스트, 지운 것을 설명하는 주석)만 남긴다.

## Plan Change Log

- 2026-10-21: patch 충돌은 다섯이 아니라 넷이었다(`README.md`가 깨끗이 붙었다).
- 2026-10-21: 24가 쓴 계약 사례 둘의 reset 배치에 `cursorBase`를 더했다. Code
  Map은 "reset 커서 사례의 `cursorBase`"라고만 했는데, 24가 그 사이에 사례를 하나
  더 썼고 그것도 같은 손질이 필요했다.
- 2026-10-21: 30 MB fixture의 task-notification 수를 plan의 "예: 수백 개"가 아니라
  6 000개로 정했다. 수백 개로는 baseline이 480 ms여서 5 000 ms 예산을 넘지 않고,
  그러면 테스트가 #20 회귀를 막지 못해 리뷰 4번이 그대로 남는다.

## Review Triage Log

### 2026-10-21 — Review pass
- verdicts: 6 findings — high 0, medium 0, low 6, false 0, maybe-false 0
- findings:
  - `[low]` `[reject]` `start_source` 규칙이 "마지막 값"에서 "첫 값"으로 바뀌었는데 `CLAUDE_CODE_PARSER_VERSION`은 `'3'` 그대로이고 칸은 한 번만 쓰므로, 옛 규칙으로 이미 저장된 값은 영영 고쳐지지 않는다 — 사실이다. 그러나 intent(Never)가 parser 버전 업을 금지하고 23이 버전을 올리게 정했으며, 실제 수집은 14에서야 켜지므로(epic Notes 2026-10-16) 그런 값을 가진 DB는 개발용 tracer뿐이다. 고치려면 backfill 경로가 새로 필요해 직접 수정이 아니다(attempt-1에서도 같은 판정). 14 전에 정할 일로 Auto Run Result의 남은 위험에 적었다.
  - `[low]` `[patch]` spine의 Table Contract `sessions` 행이 `start_source`를 "변경 가능", 커서를 "단조"로만 적고 AD-4 커서 줄에 `cursorBase` 조건이 없다 — 확인함. 뒤 스토리(14, epic 7 Postgres)가 이 표를 계약으로 읽는다. 행을 "한 번만 씀(처음 값)"과 커서의 reset 예외로 고치고 AD-4에 한 문장을 더했다(`continued_from_session_id`는 예약 자리로 옮김).
  - `[low]` `[patch]` `packages/sqlite/src/sessions.ts` 머리 주석이 커서가 "reset이면 움직인다"고 한다 — 확인함, `cursorMove`와 어긋난다. `cursorBase` 조건과 지움을 적도록 고쳤다.
  - `[low]` `[patch]` `ensureSession`의 `toSession` 보강은 `sessions ingest` 경로에서 닿지 않고(먼저 `findSession`의 catch가 답한다) 테스트도 없다 — 확인함. `packages/sqlite/test/session-store.test.ts`에 잘못된 시각 행으로 `ensureSession`을 불러 `DB_UNAVAILABLE`을 받는 사례를 더했고(보강을 빼면 실패함을 구현자가 확인), deferred-work #19 문장을 실제 경로대로 고쳤다.
  - `[low]` `[patch]` CLI 30 MB 테스트 주석이 "hundreds"라고 하는데 fixture는 6 000줄이다 — 확인함. `HUGE_NOTIFICATIONS`를 가리키게 고쳤다.
  - `[low]` `[patch]` `packages/core/src/domain/session.ts`의 `cursor`가 "Monotonic"뿐이고 `startSource`에 설명이 없다 — 확인함. 커서의 reset 예외와 `startSource`의 "처음 값 한 번만 씀"을 적었다.

## Design Notes

reset 이동을 "기준과 같을 때만"으로 묶는 이유: reset은 앞부분이 바뀌었다는 뜻이라 뒤로 가는 이동도 정당하다(파일이 짧아진 경우). 그걸 막으면 커서가 영영 맞지 않아 매번 reset이 된다(#16과 같은 증상). 겹친 경우만 막으려면 "내가 읽은 뒤 누가 커서를 바꿨나"를 알아야 하고, 그게 `cursorBase` 비교다.

```ts
// store, inside the write transaction
if (batch.tracking.cursorReset && sameCursor(current, batch.tracking.cursorBase)) {
  return { move: true, to: batch.tracking.cursor };   // null clears
}
// otherwise: 24's forward-only rule by occurred_at
```

## Verification

**Commands:**
- `pnpm build && pnpm exec vitest run --project core --project sqlite --project claude-code --project cli` -- expected: 모두 통과
- `pnpm typecheck` -- expected: 오류 없음
- `pnpm test` -- expected: 전체 통과(postgres 프로젝트는 Docker가 없으면 건너뜀을 기록)

## Auto Run Result

Status: built

**바뀐 것.** 2.7 follow-up 리뷰 #16~#20을 고쳤다. 첫 시도 patch를 `git apply -3`으로 얹고, 24가 바꾼 정렬·커서 비교 자리의 충돌 넷은 24의 코드를 남기고 풀었다.
- #16: 메시지 없는 reset 읽기도 Store `ingest`까지 가서 `CURSOR_RESET`을 내고 커서를 지운다. 다음 수집은 경고가 없다.
- #17: 배치가 읽기 시작 때의 커서 `IngestTracking.cursorBase`를 들고 가고, reset 이동(뒤로·지움)은 지금 커서가 그 기준과 같을 때만 한다. 그 밖에는 24의 `occurred_at` 전진 규칙이다. SQLite와 가짜가 같다.
- #18: parser는 첫 `SessionStart` 값을 내고, Store는 `start_source`가 null일 때만 쓴다.
- #19: SQLite `ensureSession`의 행 변환과 `recordTranscriptFile` 전체가 `DB_UNAVAILABLE`로 답하고, Core ingest는 내역 기록의 예외를 삼킨다.
- #20: parser 증분 읽기가 앞부분을 sha256 한 번만 지나고(`Hash.copy()`), 커서 줄을 뒤에서 찾고, 줄 번호는 오류 때만 세고, task-notification의 `agentId`는 늦게 한 번 모은 집합으로 본다.

**파일.**
- `packages/claude-code/src/parser.ts`, `packages/claude-code/test/parser.test.ts` — 첫 start source·다섯 값, 단일 해시 증분, `AgentIds` 집합.
- `packages/core/src/domain/{ingest-batch,session}.ts`, `packages/core/src/ports/{parser,store}.ts` — `cursorBase`, 규칙 주석.
- `packages/core/src/sessions/ingest.ts`, `packages/core/test/sessions-ingest.test.ts` — 메시지 없는 reset, 내역 기록 예외 삼킴.
- `packages/core/src/testing/{fakes/store,contracts/session-store,fixtures}.ts`, `packages/core/test/contracts.test.ts` — 가짜 store 규칙, 계약 사례 셋(첫 start source 유지, 겹친 reset, 메시지 없는 reset), 변이 둘.
- `packages/sqlite/src/{sessions,transcript-files}.ts`, `packages/sqlite/test/session-store.test.ts` — `cursorMove`, `start_source is null`, 예외→코드와 그 사례.
- `apps/cli/test/sessions-ingest.test.ts` — CLI 표면 사례 넷(메시지 없는 reset, start source, 잘못된 시각 행, 30 MB 증분).
- `README.md`, `_bmad-output/personal-brain/deferred-work.md`, `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` — `start_source` 문단, 해결 기록, Table Contract·AD-4.

**30 MB 측정.** task-notification 6 000줄이 든 생성 transcript의 두 번째 수집: 이 스토리의 parser 152 ms, baseline(`ea4d766`) parser 7 350 ms. 예산은 Stop hook 5 000 ms라서 테스트가 #20 회귀를 실제로 막는다.

**리뷰.** quick 렌즈 1회, 지적 6건(모두 low). patch 5건(spine 행·AD-4, SQLite 머리 주석, `ensureSession` 보강 사례와 deferred 문장, CLI 주석, 도메인 타입 주석). defer 0건. reject 1건: 옛 규칙으로 저장된 `start_source`의 backfill(intent가 parser 버전 업을 금지하고, 실제 수집은 14부터라 그런 값은 개발 DB뿐이며, backfill 경로가 새로 필요하다).

**후속 리뷰 권고:** `false`. patch는 low 5건뿐이고 high·medium patch가 없다.

**검증.** `pnpm test`(build·typecheck·vitest) 통과 — 리뷰 patch 뒤 64 파일 2 066 사례, 실패 0, Docker가 있어 postgres도 돌았다. I/O 매트릭스 8행 모두 실행·통과한 테스트로 덮였다. `seq` grep은 24의 허용 목록만 남긴다.

**남은 위험.**
- 이미 마지막 값 규칙으로 저장된 `start_source`는 고쳐지지 않는다. 14(실제 수집) 전에 개발 DB를 버릴지 backfill할지 정하면 된다.
- parser 주석의 "211개 중 37개" 수치는 attempt-1 때의 측정을 그대로 옮긴 것이다.
- 23이 parser 버전을 올리기 전에 이 스토리가 끝났다(티켓 조건 충족).
