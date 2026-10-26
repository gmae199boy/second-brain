---
title: '수집 경로 보강: 커서 경고·대화 순서·start_source·큰 transcript'
type: 'bugfix'
superseded_ticket: '21' # record of attempt 1; not joined to the ticket (change-drop-message-seq)
created: '2026-10-20'
status: blocked
baseline_revision: 'f69b9a5ad5af59cedd625416384fd8c534c07bea'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: [multiple-goals, oversized]
deferred: []
blocked_at: "2026-10-20"
blocked_reason: "intent gap: 대화 순서 읽기를 occurred_at으로 정렬하라는 결정(2026-10-20)이 연구 실측(transcript 524개 중 521개에 시각이 거꾸로 가는 줄, 최대 약 10.5시간)과 충돌한다. 정렬 방식을 사용자가 다시 정해야 한다. 시도한 변경은 epic-capture/story-start-source-transcript-plan-attempt-1.patch"
---

<intent-contract>

## Intent

**Problem:** 2.7 follow-up 리뷰(#10·#16~#20)의 커서·저장 지적이다. 메시지 없는 reset 읽기는 `CURSOR_RESET`을 잃고 낡은 커서를 남겨 매번 처음부터 읽는다. 겹친 reset 읽기 둘이 커서를 뒤로 돌린다. 버전 업으로 대화 중간에 더해진 메시지는 `seq`가 맨 뒤라 읽기에서도 맨 뒤에 놓인다. `start_source`는 마지막 `SessionStart`가 덮어쓴다. 세션 행·내역 기록의 예외가 코드 대신 예외로 샌다. parser는 커서와 상관없이 파일 전체를 여러 번 훑는다(30.7 MB transcript가 있다).

**Approach:** reset 읽기는 메시지가 없어도 Store `ingest`를 거쳐 경고를 내고 커서를 지운다. 배치가 읽기 시작 때의 커서(`cursorBase`)를 들고 가고, Store는 reset 이동을 "지금 커서가 그 기준과 같을 때"만 허용한다(그 밖에는 앞으로만). 대화 순서 읽기는 `occurred_at`, 같으면 `seq`로 정렬한다. `start_source`는 parser가 첫 값을 내고 Store는 이미 값이 있으면 두고, parser의 앞부분 확인은 해시 한 번이다. parser 버전은 올리지 않는다(23이 올린다).

## Boundaries & Constraints

**Always:**
- `seq`는 지금처럼 Store가 `max(seq)+1`로 붙인다. 커서 비교(`cursorMayMove`·`nextCursor`)는 계속 `seq`로 한다. 칸·마이그레이션을 더하지 않는다.
- 새 커서 규칙(SQLite와 가짜가 같다):
  - reset 아님: 지금 규칙 그대로(배치 커서 null이면 그대로, 저장 커서 없음·저장 커서 메시지 없음·새 `seq` ≥ 저장 `seq`면 이동).
  - reset: 세션의 지금 커서가 `tracking.cursorBase`와 같으면(둘 다 null이거나 id·fingerprint가 같음) 배치 커서로 바꾼다. 배치 커서가 null이면 커서를 지운다(`last_harness_message_id`·`cursor_fingerprint` 둘 다 null). 같지 않으면 reset 아님 규칙을 따른다.
- `cursorBase`는 Core ingest가 `findSession`으로 읽은 저장 커서다(parser 버전과 상관없이 날것, 세션 없으면 null). `IngestTracking`의 필수 칸이다. 배치는 spool에 직렬화되지 않는다(`domain/spool-record.ts`), 그래서 형식 호환 문제는 없다.
- `CURSOR_RESET`은 지금처럼 Store가 `tracking.cursorReset`으로 낸다.
- `start_source`: parser는 transcript의 **첫** `SessionStart:<source>` attachment를 내고(다섯 값 startup·resume·clear·compact·fork), 찾으면 거기서 멈춘다. Store는 `start_source`가 null일 때만 쓴다(insert는 그대로). 증분 읽기의 `startSource`는 전체 읽기와 같다(port 계약 유지).
- 예외는 코드로: SQLite `ensureSession`의 `toSession`, `recordTranscriptFile`의 `instant`·`toTranscriptFile`도 try 안에서 `DB_UNAVAILABLE`로 답한다(`users.ts:70-76`의 `describe` 패턴, 한국어 message). Core ingest는 `recordTranscriptFile`이 던져도 삼키고 수집 결과를 바꾸지 않는다.
- parser 증분 읽기에서 앞부분(커서 줄까지)은 sha256 한 번만 지난다. 새 커서 fingerprint는 그 해시 상태를 이어서(`Hash.copy()`) 만든다. 커서 줄 찾기는 뒤에서부터(`lastIndexOf`) 한다. 줄 번호(`countLines`)는 오류 message가 필요할 때만 센다. task-notification의 `agentId` 확인은 앞부분을 한 번만 모아(필요할 때 늦게) 집합으로 보고, 읽는 꼬리 줄의 `agentId`를 더해 간다 — 지금의 "이 줄 앞 내용에 `"agentId":"<id>"`가 있다"와 같은 답이어야 한다.
- 사람이 읽는 새 문구는 한국어(Conventions '출력 언어'), 주석은 영어로 *왜*를 적는다.

**Never:**
- `CLAUDE_CODE_PARSER_VERSION`(`'3'`)을 바꾸지 않는다. 메시지·도구 메모로 무엇을 내는지(본문·handback·도구 대상 규칙)는 바꾸지 않는다 — 그건 22·23이다.
- 런타임 reader(`apps/cli/src/runtime/transcript.ts`)의 통째 읽기·`transcript_files` fingerprint는 바꾸지 않는다(측정에는 포함).
- 30 MB fixture를 커밋하지 않는다(테스트가 임시 폴더에 만든다). 커서·세션 스키마를 바꾸지 않는다.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 메시지 없는 reset | 커서 있는 세션, transcript가 메시지 없는 내용으로 바뀜 | `ok`, `warnings: ['CURSOR_RESET']`, 세션 커서 null. 다음 수집은 `warnings: []` | 없음 |
| 겹친 reset 둘 | 둘 다 기준 X에서 읽음, 긴 쪽(Y) 먼저 커밋, 짧은 쪽(Z<Y) 나중 | 커서 Y 유지 | 없음 |
| 혼자인 reset | 지금 커서 = 기준, 새 커서가 더 앞(`seq` 작음) | 새 커서로 이동(뒤로 가도 됨) | 없음 |
| 중간에 더해진 보고 | 저장된 t1·t3 메시지, 다음 배치에 t2 | `seq` t1=1·t3=2·t2=3, `readSession` 순서 t1·t2·t3, 도구 메모도 그 순서 | 없음 |
| startup→resume | `SessionStart:startup` 뒤 `SessionStart:resume` | parser·저장 모두 `startup`, 증분 읽기도 `startup` | 없음 |
| 나중에 안 start | 첫 수집은 SessionStart 없음(null), 다음 배치가 `resume` | 저장 `resume`, 그 뒤 `startup` 배치는 바꾸지 않음 | 없음 |
| 잘못된 시각 세션 행 | `sessions.started_at`이 glob은 맞고 날짜가 아님(예: `2026-13-45T…`) | `brain sessions ingest`가 예외 없이 코드(`DB_UNAVAILABLE` 경고와 spool)로 끝남 | 예외 금지 |
| 내역 기록이 던짐 | `recordTranscriptFile`이 throw | 수집은 `ok`, 결과 같음 | 삼킴 |
| 30 MB 증분 | 큰 도구 결과로 30 MB, 한 턴 덧붙임 | 두 번째 수집 < 5000 ms(Stop hook timeout 5초, spine AD-6) | 없음 |

</intent-contract>

## Code Map

- `packages/core/src/sessions/ingest.ts` -- 253 `findSession`, 265 `parse`, 278-289 `recordHistory`(try/catch로 감싼다), 297-307 이른 반환(`parsed.cursorReset && stored !== null`이면 반환하지 않고 빈 배치로 `store.ingest`까지 간다; 메시지 없으니 `ensureSession`은 건너뜀), 373-382 `tracking`에 `cursorBase: stored?.cursor ?? null`. 487-493 `cursorFor`는 그대로.
- `packages/core/src/domain/ingest-batch.ts:73-88` -- `IngestTracking.cursorBase` 추가, `cursorReset`·`startSource` 주석 고침.
- `packages/core/src/ports/store.ts` -- 162 `SessionContents` 주석(대화 순서 = `occurred_at`, 같으면 `seq`), 236-255 `ingest` 계약 문구(첫 `startSource` 유지, reset 이동 조건, 커서 지우기).
- `packages/core/src/ports/parser.ts:26-29` -- `startSource`는 첫 `SessionStart`.
- `packages/sqlite/src/sessions.ts` -- 169-183 `ensureSession`(`toSession`을 try 안으로), 292-298 `start_source` update에 `and start_source is null`, 299-307 커서 쓰기와 489-514 `cursorMayMove`(새 규칙, null로 지우기 포함, 주석 고침), 365 `order by occurred_at, seq`, 377 `order by m.seq is null, m.occurred_at, m.seq, n.ordinal`.
- `packages/sqlite/src/transcript-files.ts:65-160` -- 74 `instant`·155-160 `toTranscriptFile`을 try 안으로.
- `packages/core/src/testing/fakes/store.ts` -- 334 정렬(`occurredAt`, 같으면 `seq`), 376-384 도구 메모 정렬, 349 `session.startSource ?? batch.tracking.startSource`, 678-693 `nextCursor` 새 규칙(지우기 포함), 342 호출부.
- `packages/core/src/testing/fixtures.ts:275-345` -- `sampleIngestBatch`의 `tracking.cursorBase` 기본 null, override 허용.
- `packages/core/src/testing/contracts/session-store.ts` -- 604-643 start source 사례(첫 값 유지), 647-694 커서 사례(셋째 블록에 `cursorBase` = 지금 커서, 겹친 reset 블록 추가), 737-754 경고 사례 옆에 "메시지 없는 reset 배치는 경고를 내고 커서를 지운다", 새 "대화 중간에 더해진 메시지는 `seq` 맨 뒤, 읽기는 `occurred_at` 순서".
- `packages/core/test/contracts.test.ts:624-668` -- 망가뜨린 가짜가 새 사례에 걸리는 음성 사례(첫 값 덮어씀, 겹친 reset이 되돌림, `seq` 순서로 읽음).
- `packages/claude-code/src/parser.ts` -- 159(꼬리 split, 그대로), 216-223(`readStartSource` 첫 값), 249-278 `startFor`(뒤에서 찾기, 해시 한 번, 해시 상태를 넘김), 298-309 `cursorFor`(넘겨받은 상태로 이어 해시; 커서 없이 읽으면 처음부터 해시), 448·694-696 `carriesAgentId`(집합), 606-631 주석과 루프(첫 값에서 멈춤, 정규식 대신 `indexOf('SessionStart:')`도 가능), 719-727 `countLines`(오류 때만).
- `packages/claude-code/test/parser.test.ts` -- 766-778 "last SessionStart" 사례를 첫 값으로 바꾸고 다섯 값 사례, 780-798 증분 사례에 resume 뒤 증분. 새 fixture는 기존 fixture 구조에 중립 내용(`test/fixtures/`, 예: `start-sources.jsonl` 또는 테스트 안에서 줄 생성).
- `packages/core/test/sessions-ingest.test.ts:594-619` -- 메시지 없는 reset, 내역 기록 throw.
- `apps/cli/test/sessions-ingest.test.ts:583,649` -- CLI 표면 사례(실제 SQLite): 메시지 없는 reset→다음 수집 무경고, 잘못된 시각 세션 행, startup→resume, 30 MB 증분 시간. 실행 helper는 그 파일의 기존 것을 쓴다. 잘못된 시각을 심을 때 check가 막으면 glob에 맞는 불가능한 날짜를 쓴다.
- `README.md:579` -- `CURSOR_RESET` 설명이 바뀌면 맞춘다(`apps/cli/test/readme-codes.test.ts`가 대조).
- `_bmad-output/personal-brain/deferred-work.md` -- 2.7 follow-up 리뷰 항목에 #10·#16~#20 해결(21) 표시.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/ingest-batch.ts`, `packages/core/src/ports/store.ts`, `packages/core/src/ports/parser.ts` -- `cursorBase`, 주석·계약 문구 -- 규칙의 한 곳.
- [x] `packages/core/src/testing/contracts/session-store.ts`, `packages/core/src/testing/fixtures.ts`, `packages/core/test/contracts.test.ts` -- 계약 사례 먼저(실패 확인) -- 두 Store가 같은 규칙.
- [x] `packages/core/src/testing/fakes/store.ts` -- 정렬·첫 start source·커서 규칙.
- [x] `packages/sqlite/src/sessions.ts`, `packages/sqlite/src/transcript-files.ts` -- 정렬 SQL, `start_source is null`, 커서 규칙, 예외→`DB_UNAVAILABLE`.
- [x] `packages/core/src/sessions/ingest.ts`, `packages/core/test/sessions-ingest.test.ts` -- 이른 반환·`cursorBase`·내역 기록 삼킴.
- [x] `packages/claude-code/src/parser.ts`, `packages/claude-code/test/parser.test.ts` -- 첫 start source, 다섯 값, 단일 해시 증분, `agentId` 집합; 기존 cursor·handback 사례가 그대로 통과.
- [x] `apps/cli/test/sessions-ingest.test.ts` -- CLI 표면 사례와 30 MB 생성 fixture 시간 측정(`performance.now()`, `packages/core/test/secret-patterns.test.ts:221-234` 모양, 실패 message에 ms, vitest timeout 넉넉히).
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문구 맞춤. 측정한 ms를 이 plan의 Implementation Notes에 적는다.

**Acceptance Criteria:**
- Given 커서가 있는 세션의 transcript가 메시지 없는 내용으로 바뀌었을 때, when `brain sessions ingest claude-code`를 두 번 돌리면, then 첫 결과의 `warnings`는 `["CURSOR_RESET"]`이고 둘째는 `[]`다.
- Given 같은 세션에 reset 배치 둘이 같은 기준에서 겹쳐 커밋될 때, when 짧은 쪽이 나중에 커밋되면, then `readSession`의 커서는 긴 쪽 커서다(두 Store 계약).
- Given 저장된 세션에 대화 중간 시각의 메시지가 나중 배치로 들어왔을 때, when 세션을 읽으면, then 그 메시지의 `seq`는 가장 크고 읽기 순서는 `occurred_at` 순이다.
- Given startup으로 시작해 resume된 transcript를 수집하면, then 저장된 `start_source`는 `startup`이고, 다섯 값 각각의 transcript는 그 값을 낸다.
- Given 잘못된 시각이 든 세션 행이 있을 때, when 그 세션을 수집하면, then 프로세스는 예외(스택) 없이 코드 있는 결과로 끝난다.
- Given 30 MB 생성 transcript를 한 번 수집한 뒤 한 턴을 덧붙였을 때, when 다시 수집하면, then 걸린 시간이 5000 ms 미만이고 그 값이 plan에 기록된다.

## Implementation Notes

**30 MB 증분 측정(Acceptance 마지막 줄).** `apps/cli/test/sessions-ingest.test.ts`의
"reads a 30 MB transcript again inside the Stop hook budget": 테스트가 임시 폴더에
만든 약 30 MB transcript(1 MB `tool_result` 줄 30개 + 앞뒤 메시지, 마지막 줄이
메시지라서 커서가 파일 끝 근처에 선다)를 한 번 수집한 뒤 한 턴을 덧붙이고 다시
수집했다. **두 번째 수집 129 ms**(명령 전체 — 프로세스 시작·파일 읽기·파싱·쓰기,
예산은 Stop hook 5 000 ms). 첫 수집은 약 750 ms다(예산 없음, 세션마다 한 번).

같은 fixture를 story 21 **이전** parser(`f69b9a5`)로 재어 보면 142 ms다. 즉 이
fixture는 #20의 비용을 가르지 않는다 — 줄이 33개뿐이라 `countLines`가 싸고
task-notification이 없어서 `carriesAgentId`의 `content.slice(0, lineStart)`(알림마다
30 MB 복사)가 아예 불리지 않는다. 줄어든 것은 전체 해시 하나와 `start_source`
전체 훑기뿐이고, 이 기계에서 그 둘이 13 ms다. #20의 제곱 비용은 알림이 많은
transcript에서 나타나며, 그 경로는 시간이 아니라 동작으로 고정했다 — 파서 테스트
"finds the agent of a notification in the content in front of the read"가 앞부분
집합과 꼬리 줄 집합 둘 다 깨지면 실패한다(둘을 각각 망가뜨려 확인).

**계약 사례의 음성 확인.** 새 계약 사례 넷은 `packages/core/test/contracts.test.ts`의
망가뜨린 가짜 셋으로 되짚었다(마지막 값이 이기는 start source, `cursorBase`를 보지
않는 reset, `seq` 순서로 읽는 readSession). `a reset batch with no message warns and
clears the cursor`는 가짜가 아니라 Core ingest 테스트와 CLI 표면 테스트가 받친다.

**plan에서 한 걸음 좁힌 것: `ensureSession`의 예외.** Code Map은 `toSession`을 try
안으로 넣으라고 했고, 그대로 `toSession`만 넣었다. `withWrite` 자체는 예외를 그대로
올린다 — `packages/sqlite/test/session-store.test.ts`의 "refuses a session whose user
has no row"가 외래 키 위반을 **예외로** 요구하고, 그건 Core가 읽지도 않은 주인을
넘긴 호출자 버그라서 Conventions대로 예외가 맞다. 그래서 바뀐 것은 "읽어 온 행을
도메인 값으로 넓히다가 나는 실패"뿐이다(잘못된 시각 행이 그 경우다).

**잘못된 시각 행은 `findSession`에서 이미 코드가 된다.** 매트릭스 행의 경로를 CLI
테스트로 재 보니 `brain sessions ingest`는 `findSession`(이미 try 안이다)에서
`DB_UNAVAILABLE`을 받아 spool로 끝난다 — 예외도 스택도 없다. `ensureSession`·
`recordTranscriptFile`의 보강은 그 경로가 아니라 같은 행을 다른 입구로 만나는
호출자(drain·앞으로의 읽기 동사)를 위한 것이다.

**이른 반환을 지나가는 빈 reset 배치는 주인 읽기도 지난다.** `readSelfUser`는
`ensureSession`만 쓰지만 호출 자리는 그대로 두었다(plan이 바꾸라고 한 것은 이른
반환뿐이다). 커서가 있는 세션에는 주인 행이 있으므로(SQLite 외래 키) 실제로 답이
달라지는 경우는 없고, 메시지 없는 reset마다 읽기 한 번이 더 든다. 도구 메모만 있는
배치가 주인 없는 DB에서 `USER_MISSING`으로 끝나는 지금 동작도 그대로다.

**Verification 결과(2026-10-20).** `pnpm build`·`pnpm typecheck`·`pnpm test` 전부
통과 — 63 파일 2 047 사례, 실패 0. 이 기계에는 Docker가 있어서 postgres 프로젝트도
건너뛰지 않고 실제로 돌았다(28 사례).

**Postgres는 손댈 것이 없다.** `packages/postgres/src/store.ts`는 아직
`SessionStore`를 구현하지 않으므로(세션 계약은 Core 가짜와 SQLite 둘만 돈다) 새
커서·정렬·`start_source` 규칙을 옮길 adapter가 없다.

## Plan Change Log

- 2026-10-20: SQLite의 `cursorMayMove`는 `cursorMove`로 이름이 바뀌었다. 이제 답이
  boolean이 아니라 Design Notes의 `{ move, to }`이기 때문이다(`to`가 null이면 지움).
  `nextCursor`(Core 가짜)는 이름 그대로이고, 반환값이 `Session['cursor']`라서 지움을
  이미 표현할 수 있었다.

## Review Triage Log

### 2026-10-20 — Review pass
- verdicts: 5 findings — high 1, medium 0, low 4, false 0, maybe-false 0
- findings:
  - `[high]` `[intent_gap]` `readSession`의 `order by occurred_at, seq`(`packages/sqlite/src/sessions.ts`, 가짜 store 같음)가 거의 모든 세션의 대화 순서를 뒤집는다 — 확인함: `epic-capture/epic-capture-research.md` '시각'이 "앞 줄보다 시각이 이른 줄이 흔하다. 파일 524개 중 521개, 최대 약 10.5시간. 그래서 시각으로 정렬하지 않는다"고 적고, `parser.ts` 주석도 같다. 커밋된 `full-session.jsonl`의 assistant 줄(09:59:00Z)이 앞 줄(10:00:09Z)보다 이르다. README 298행 "순서는 시계가 아니라 파일에서 옵니다"와 새 문단이 맞서는 것도 같은 뿌리다. 고치려면 intent의 "대화 순서 = `occurred_at`, 같으면 `seq`"(2026-10-20 사용자 결정)를 바꿔야 하므로 intent_gap. 시도한 변경은 `story-start-source-transcript-plan-attempt-1.patch`에 저장하고 코드를 되돌렸다.
  - `[low]` `[intent_gap]` 같은 시각이 겹치면 `seq` 동점 처리가 "파일 순서"가 아니다(늦게 온 메시지가 같은 밀리초의 다음 메시지 뒤에 놓임) — 확인함: 배치를 넘으면 `seq`는 들어온 순서다. 위와 같은 뿌리(시각 정렬 설계)라 같은 경로.
  - `[low]` `[reject]` 옛 마지막 값 규칙으로 이미 쓴 `start_source`는 새 규칙(`start_source is null`일 때만 씀)과 고정된 parser 버전 때문에 고쳐지지 않는다 — 사실이지만 실제 수집은 14에서야 켜지므로(epic Notes 2026-10-16) 이 값을 가진 DB는 개발용 tracer뿐이다. 고치려면 backfill 경로가 새로 필요해 단순 수정이 아니다. 같은 질문이 남아 있다면 14 전에 정하면 된다.
  - `[low]` `[patch]` 30 MB 시간 테스트가 #20 회귀를 막지 못한다(옛 parser 142 ms, 새 parser 129 ms, task-notification 줄이 없어 제곱 비용 경로를 지나지 않음) — 확인함: Implementation Notes의 측정. 생성 fixture에 task-notification 줄을 많이 넣으면 되는 직접 수정이지만, intent_gap 때문에 이번 패스에서는 적용하지 않았다(moot). 다음 실행에서 patch와 함께 반영할 것.
  - `[low]` `[reject]` `recordTranscriptFile`이 던진 예외를 아무 표시 없이 삼킨다 — intent가 "transcript 내역 기록의 예외는 수집을 실패로 만들지 않는다"를 요구했고, 코드 있는 실패도 이 변경 전부터 같은 이유로 말없이 버려졌다. SQLite adapter는 이제 모든 경로를 코드로 답하므로 예외는 adapter 버그일 때뿐이다. 경고·failures 경로를 더하는 건 복잡도가 늘어 일상에서 만날 일이 드문 문제에 비해 크다.

## Design Notes

reset 이동을 "기준과 같을 때만"으로 묶는 이유: reset 자체는 앞부분이 바뀌었다는 뜻이라 뒤로 가는 이동도 정당하다(파일이 짧아진 경우). 그걸 금지하면 커서가 영영 맞지 않아 매번 reset이 된다(#16과 같은 증상). 겹친 경우만 막으려면 "내가 읽은 뒤 누가 커서를 바꿨나"를 알아야 하고, 그게 `cursorBase` 비교다.

```ts
// store, inside the write transaction
if (batch.tracking.cursorReset && sameCursor(current, batch.tracking.cursorBase)) {
  return { move: true, to: batch.tracking.cursor };   // may be null → clear
}
// otherwise: the forward-only rule as today
```

## Verification

**Commands:**
- `pnpm build && pnpm vitest run --project core --project sqlite --project claude-code --project cli` -- expected: 모두 통과
- `pnpm typecheck` -- expected: 오류 없음
- `pnpm test` -- expected: 전체 통과(postgres 프로젝트는 Docker가 없으면 README '테스트 데이터베이스' 안내대로 건너뜀을 기록)

## Auto Run Result

Status: blocked
Blocking condition: intent gap — 대화 순서 읽기의 정렬 방식

**무엇을 했나.** plan대로 전부 구현했고(16개 파일), `pnpm test`(build·typecheck·vitest 63개 파일 2047개 테스트, postgres 포함)가 통과했다. I/O 매트릭스 9행이 모두 통과한 테스트로 덮였다. 30 MB 생성 transcript의 두 번째 수집은 129 ms였다(예산 5000 ms).

**왜 멈췄나.** quick 리뷰가 `readSession`의 `order by occurred_at, seq`가 거의 모든 세션의 순서를 뒤집는다고 지적했고, 확인 결과 사실이다. `epic-capture-research.md` '시각'에 따르면 transcript 524개 중 521개에 앞 줄보다 시각이 이른 줄이 있고(최대 약 10.5시간), 그래서 "시각으로 정렬하지 않는다"고 정해 두었다. 커밋된 `full-session.jsonl`도 새 정렬로 읽으면 답이 질문보다 앞에 온다. 그런데 `occurred_at` 정렬은 티켓 description과 epic Notes의 2026-10-20 사용자 결정이라 실행 중에 바꿀 수 없다.

**사용자가 정할 것.** 버전 업으로 대화 중간에 늦게 들어온 메시지를 어떻게 제자리에 읽을 것인가:
1. 파일 위치 순서 칸(예: 앞뒤 메시지 사이 값을 갖는 정렬 키) — 2026-10-20에 고르지 않았던 "앞뒤 사이 값 칸" 안. 마이그레이션이 필요하다.
2. `seq` 순서를 유지하고 늦게 온 메시지만 parser가 준 앞 메시지(`parentUuid` 또는 바로 앞 줄) 뒤에 끼워 읽기 — 칸 없이 가능하지만 읽기가 복잡해진다.
3. 그대로 `occurred_at` 정렬 — 시각이 거꾸로 간 줄의 순서가 바뀌는 것을 받아들인다.
4. #10을 이 스토리에서 빼고 나머지(커서 경고·겹친 reset·`start_source`·예외·parser 비용)만 낸다.

**보존한 것.** 시도한 변경 전체는 `story-start-source-transcript-plan-attempt-1.patch`(기준 `f69b9a5`, `git apply --check` 통과)에 있고, 코드는 기준으로 되돌렸다. 커서 규칙(`cursorBase`), 첫 `start_source`, 예외→코드, parser 단일 해시는 리뷰에서 문제가 없었으니 다음 실행에서 그대로 쓸 수 있다(정렬 부분과 README 정렬 문단만 다시 정하면 된다). 다음 실행은 30 MB 생성 fixture에 task-notification 줄도 넣어야 한다(리뷰 4번, patch).

**리뷰 분류.** 5건: high 1(intent_gap), low 4 — intent_gap 1(같은 뿌리), patch 1(적용 안 함, moot), reject 2(옛 `start_source` 행 backfill, 내역 기록 예외의 표시). 사유는 Review Triage Log에 있다.

**남은 위험.** 코드가 되돌려졌으므로 #10·#16~#20은 아직 열려 있다. 23(parser 버전 업)은 이 스토리 뒤여야 한다.

## Superseded

2026-10-20: `../change-drop-message-seq/`로 메시지 번호를 지우기로 해서 이 plan은 기록으로 남긴다. 스토리 21은 새 plan으로 다시 빌드하고, 위 patch는 정렬 부분을 빼고 재사용한다. 리뷰 1번 지적(시각 정렬이 순서를 뒤집음)은 parser가 남기는 메시지만 다시 잰 결과(시각 역전 0, 같은 밀리초 0)로 실제 데이터에서는 일어나지 않는다고 판단했다.
