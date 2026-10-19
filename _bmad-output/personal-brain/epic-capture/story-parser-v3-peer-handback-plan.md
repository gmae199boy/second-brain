---
title: 'parser v3: peer handback 보고'
type: 'feature'
ticket: '19'
created: '2026-10-19'
status: 'built'
baseline_revision: 'b901384206a1206d156f16a17fc9fd6605cdaa1a'
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
deferred:
  - summary: >-
      task-notification의 `<result>`가 두 번째 안내 문장("This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.")뿐이면 아직 서브에이전트 보고로 저장된다.
    evidence: |-
      quick 리뷰가 찾고 메인 세션이 확인했다(이 Mac의 transcript에 그 문장 22회, 리뷰어 셈으로 메인 transcript의 비동기 완료 결과 중 4건, 모두 handback 줄이 있는 한 파일). v2도 같은 줄을 보고로 저장하므로 이 변경이 만든 문제는 아니지만, v3가 진짜 보고를 더하면 가짜와 진짜가 함께 남는다. 고치려면 intent-contract의 "안내 문장 하나" 규칙을 넓혀야 해서 이 실행에서는 고치지 않았다. 고치는 자리: parser v4(deferred-work의 2.7 follow-up 리뷰 항목과 함께).
    location: >-
      packages/claude-code/src/parser.ts:56
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 서브에이전트가 `SubagentHandback`으로 끝나면 보고는 메인 transcript의 peer user 줄(`origin.kind === 'peer'`, `origin.handback === true`)로 온다. parser v2는 이 줄을 버리고(peer, 그리고 실제 줄은 `isMeta: true`), 같은 서브에이전트의 동기·비동기 결과 자리에 오는 안내 문장("This agent's report was delivered to you as a message from … (its SubagentHandback call). Read it there; it is not repeated here.")을 보고로 저장한다.

**Approach:** parser가 handback 줄을 보고(`isSubagentReport: true`, role `assistant`, model null, 본문 `origin.handbackReportText` trim)로 읽고, 그 밖의 peer 줄은 계속 뺀다. 안내 문장뿐인 동기·비동기 결과는 보고도 메시지도 아니다. `CLAUDE_CODE_PARSER_VERSION`을 `'3'`으로 올려, 버전이 다른 세션은 처음부터 다시 읽혀 빠진 보고만 더해진다(2.7 규칙, `ingest.ts` 506행).

## Boundaries & Constraints

**Always:**
- handback 판정은 `isMeta` 필터보다 **먼저** 한다(실측 handback 줄 367건 모두 `isMeta: true`). `isSidechain: true`인 줄은 handback이어도 뺀다.
- handback = `type === 'user'`, `origin.kind === 'peer'`, `origin.handback === true`(불리언만). 본문은 `origin.handbackReportText`가 문자열이고 trim 뒤 비지 않을 때 그 trim 값이다. 그 밖이면 메시지가 아니다. `message.content`·`origin.body`(앞머리 문장과 들여쓰기가 붙은 원문)는 읽지 않는다.
- 보고 메시지의 `gitBranch`·`cwd`·`occurredAt`은 다른 메시지처럼 그 줄의 값이다. 보고 뒤 `tool_use`는 지금 규칙대로 그 보고에 붙는다.
- 안내 문장 판정은 결과 본문(trim) **전체**가 위 영어 문장 하나와 맞을 때만이다(따옴표 안 id만 자유). 부분 일치는 보고로 남긴다. 도구 메모의 `ok` 판정은 바뀌지 않는다.
- 증분 결과 = 전체 결과의 커서 메시지부터(기존 계약). handback 메시지가 커서일 때도 같다.
- fixture는 실제 줄의 키·모양을 따르고 문장·경로·id는 직접 쓴 중립 값이다. 실제 transcript를 복사·변환하지 않는다(공개 저장소).
- Decision(2026-10-19, 에이전트가 고름): `handbackReportText`가 없는 handback(이 Mac에서는 Claude Code 2.1.273~2.1.296의 244건)은 뺀다. 티켓이 본문 출처를 그 키로 정했고, 2.7 Decision "애매한 user 항목은 빼는 쪽"(넣은 것은 못 고치고 빠진 것은 버전을 올려 더할 수 있다)을 따른다. 다른 안: `origin.body`의 앞머리를 떼고 들여쓰기를 걷어 본문으로 씀.
- Decision(2026-10-19, 에이전트가 고름): 안내 문장뿐인 동기·비동기 결과는 뺀다. 실측에서 동기·비동기 "보고" 191건 중 177건이 이 문장이고, v3가 handback을 더하면 같은 서브에이전트에 가짜 보고와 진짜 보고가 함께 남는다. 다른 안: 지금처럼 보고로 저장.

**Never:** `subagents/` 파일 읽기, 스키마·마이그레이션, 폴더 스캔·`transcript_files`(버전이 올라도 크기가 같은 파일을 다시 큐에 넣는 일은 deferred로 넘김), 다른 harness, 이미 저장된 메시지·도구 메모 수정, 실제 `~/.claude`·`~/.second_brain` 쓰기, 측정 스크립트나 실제 transcript 내용을 저장소에 넣기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| handback(텍스트 있음) | peer, `handback:true`, `isMeta:true`, `handbackReportText:"  보고  "` | 메시지 1건: assistant, model null, `isSubagentReport:true`, 본문 `보고`, 줄의 branch·cwd | — |
| 옛 handback | `handbackReportText` 없음, 또는 공백뿐·문자열 아님 | 메시지 아님 | — |
| 그 밖의 peer | `handback` 없음·false·`"true"` | 메시지 아님 | — |
| 사이드체인 handback | 위 첫 행 + `isSidechain:true` | 메시지 아님 | — |
| 안내 문장 결과 | 동기 `toolUseResult`(agentId, completed) 또는 비동기 `<result>`가 안내 문장뿐 | 보고·메시지 아님. Agent 호출의 도구 메모는 그대로 | — |
| 안내 문장 + 다른 글 | 결과에 안내 문장과 다른 문장이 함께 | 지금처럼 보고 | — |
| v2로 넣은 세션 | `sessions.parser_version='2'`, handback 없이 저장된 메시지 | 다시 넣으면 handback 보고만 inserted, 기존 seq·본문 그대로, `parser_version='3'` | — |
| 커서가 handback | 커서 메시지가 handback 줄, 뒤에 줄이 붙음 | `cursorReset:false`, 결과는 그 보고부터 | — |

</intent-contract>

## Code Map

- `packages/claude-code/src/parser.ts` -- 고칠 곳. `readMessage`(isMeta 필터가 `readReport`보다 앞, 이 순서를 handback에 대해 바꾼다), `readReport`(동기·비동기 보고; 안내 문장 거르기를 여기서), `isForeignOrigin`(peer 제외는 유지), 클래스 docstring의 필터 목록, `CLAUDE_CODE_PARSER_VERSION` 주석에 `3`을 적는다. `startFor`는 `readMessage`를 부르므로 따로 고칠 것 없음.
- `packages/claude-code/test/parser.test.ts` -- 버전 단정(`'3'`), `parserContract` 실행부(246행~, `ParserSubject`의 `grown`·`rewritten` 쌍). 새 fixture용 `describe`를 더한다.
- `packages/claude-code/test/fixtures/full-session.jsonl` -- 17행에 handback 없는 peer 줄(`isMeta` 아님)이 있다. 이 파일은 건드리지 않는다(여러 테스트의 건수가 묶여 있음).
- `apps/cli/test/sessions-ingest.test.ts` -- `dist/bin.js` 수준 테스트. `installedHome`, `stopPayload`, `runBrain`, `storedMessages`, `rowDump`, `databaseIn` 헬퍼를 재사용한다. 611행 "marks the two reports…" 테스트가 모양 참고.
- 읽기만: `packages/core/src/sessions/ingest.ts`(506~508행 버전이 다르면 커서 null), `packages/sqlite/src/sessions.ts`(305행 `parser_version` 갱신), `packages/sqlite/test/session-store.test.ts`(parser 버전을 문자열로 쓰는지 확인만).
- `_bmad-output/personal-brain/deferred-work.md` -- "brain 2.7(parser) follow-up 리뷰" 항목을 이 스토리로 닫고, 새 항목 둘(옛 handback 본문, 버전이 올라도 크기가 같은 파일은 스캔이 다시 넣지 않음)을 더한다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/claude-code/src/parser.ts` -- Always의 규칙, 버전 `'3'`, docstring 갱신 -- 보고를 잃지 않고 가짜 보고를 남기지 않기 위해
- [x] `packages/claude-code/test/fixtures/peer-handback.jsonl`(신규) -- 실측 키(`parentUuid`, `isSidechain`, `promptId`, `isMeta`, `permissionMode`, `origin{kind,from,senderTaskId,name,body,handback,handbackReportText}`, `promptSource:"system"`, `turnOrigin:"peer"`, `queueSkipAttachments`, `userType`, `entrypoint`, `cwd`, `sessionId`, `version`, `gitBranch`)로 매트릭스 parser 행을 모두 담는다: 사람 질문, Agent 호출(동기 하나는 결과가 안내 문장, 비동기 하나는 task-notification `<result>`가 안내 문장), 텍스트 있는 handback 2건, 옛 handback, 공백 handback, handback 없는 peer, 사이드체인 handback, 그 뒤 대화. 버려질 본문과 handback의 `message.content` 앞머리에는 표지 문자열(예: `FRAME-MUST-NOT-BE-STORED`)을 넣는다 -- 중립 fixture
- [x] `packages/claude-code/test/parser.test.ts` -- 새 fixture로 매트릭스 행별 사례, 커서가 handback일 때의 증분 사례, 새 fixture로 `parserContract` 실행 -- 규칙 고정
- [x] `apps/cli/test/sessions-ingest.test.ts` -- (1) 새 fixture 수집 뒤 `is_subagent_report=1`이 handback 2건뿐이고 DB 본문에 `SubagentHandback`·표지 문자열이 없음. (2) v2 재수집: handback 줄을 뺀 fixture를 넣고 `sessions.parser_version`을 `'2'`로 바꾼 뒤 전체 fixture를 넣으면 `inserted.messages`가 2이고, 앞서 저장된 행의 seq·본문이 같으며, 새 두 행의 seq가 그 뒤이고 `parser_version='3'` -- 티켓 verify
- [x] `_bmad-output/personal-brain/deferred-work.md` -- Code Map의 갱신 -- 남은 일 기록

**Acceptance Criteria:**
- Given 임시 home과 `peer-handback.jsonl`, when `brain sessions ingest claude-code --json`으로 넣으면, then 보고 표시가 붙은 메시지는 텍스트 있는 handback 2건이고 본문이 각 `handbackReportText`의 trim이며, 다른 peer·옛 handback·안내 문장은 DB 어디에도 없다.
- Given 버전 2로 저장된 세션, when 같은 transcript를 다시 넣으면, then 빠진 보고만 더해지고 기존 메시지의 seq·본문은 바뀌지 않는다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

실측(2026-10-19, 이 Mac `~/.claude/projects`의 메인 transcript 208개, 구조와 건수만, 저장소 밖 스크립트):
- handback 줄 367건(87개 파일), 모두 `isMeta: true`. `handbackReportText`가 있는 것은 123건(Claude Code 2.1.299 이후), 없는 것 244건(2.1.273~2.1.296). handback 아닌 peer 1건.
- 티켓 셈법(보고 모양 줄 전체 중 handback: 동기 85 + 비동기 106 + handback 367 = 558): **수정 전 누락 65.8%**(2026-10-18의 약 58%는 데이터가 적을 때의 같은 셈).
- 안내 문장을 뺀 셈: 실제 보고 381건(handback 367 + 안내 문장 아닌 동기·비동기 14). v2는 367건(96.3%)을 놓치고 안내 문장 177건을 보고로 저장한다. v3는 244건(64.0%, 모두 옛 handback)을 놓치고 안내 문장은 저장하지 않는다.

## Plan Change Log

## Review Triage Log

### 2026-10-19 — Review pass
- verdicts: 4 findings — high 0, medium 2, low 2, false 0, maybe-false 0
- findings:
  - `[medium]` `[defer]` 두 번째 안내 문장("has not reported yet … through SubagentHandback")뿐인 task-notification이 아직 보고로 저장됨 — 확인함(문장 실재, v2도 저장하던 기존 결함). 고치려면 intent-contract의 안내 문장 규칙을 바꿔야 하므로 frontmatter `deferred`로 넘김.
  - `[medium]` `[patch]` deferred-work가 2.7 follow-up 리뷰를 "해결됨, 빈틈은 하나"로 닫았지만 리뷰는 diff 하나를 quick 렌즈로 본 것이고 두 번째 빈틈이 나옴 — 고침: 항목을 "열려 있음"으로 되돌리고 남은 일(두 번째 안내 문장, 2.7 나머지 규칙 재검토)을 적음.
  - `[low]` `[patch]` CLI 테스트의 "v2가 남긴 상태" 흉내에 v2가 함께 저장했을 안내 문장 보고 2건이 없음 — 고침: `handbackTranscriptIn` 주석이 흉내의 한계(v3로는 그 두 행을 만들 수 없고, 테스트는 다시 읽으면 보고만 더해지고 저장된 행은 그대로임만 고정)를 말하게 정정. 동작 변경 없음.
  - `[low]` `[patch]` `isForeignOrigin` docstring이 "남은 peer는 다른 에이전트의 대화뿐"이라 했지만 쓸 본문 없는 옛 handback도 남음 — 고침: docstring 정정.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 통합은 `BRAIN_TEST_DATABASE_URL`이 있을 때)

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에서 `setup run --yes` 뒤 새 fixture로 `sessions ingest claude-code --json`, `sqlite3 <home>/brain.db "select seq, role, model, is_subagent_report, substr(body,1,30) from messages order by seq"`로 보고 2건 확인.

## Auto Run Result

**요약:** Claude Code parser v3. `SubagentHandback`으로 끝난 서브에이전트의 보고(peer user 줄, `origin.handback === true`, 실제로는 `isMeta: true`)를 `isMeta` 필터보다 먼저 판정해 보고 메시지로 읽는다(본문 `origin.handbackReportText` trim, role assistant, model null, `is_subagent_report`). 그 밖의 peer 줄, 쓸 본문 없는 옛 handback, 사이드체인 handback은 계속 뺀다. 동기 Agent 결과·비동기 task-notification `<result>`가 안내 문장("…(its SubagentHandback call). Read it there; it is not repeated here.") 하나뿐이면 보고로 저장하지 않는다. `CLAUDE_CODE_PARSER_VERSION`은 `'3'`이고, 버전 2로 저장된 세션은 다음 수집 때 처음부터 다시 읽혀 빠진 보고만 더해진다. 스키마 변경 없음.

**바뀐 파일:**
- `packages/claude-code/src/parser.ts` — `readHandback`, `HANDBACK_NOTICE`, `readMessage` 판정 순서, 버전 3, docstring
- `packages/claude-code/test/fixtures/peer-handback.jsonl`(신규) — 실측 키 모양의 중립 fixture 17줄
- `packages/claude-code/test/parser.test.ts` — 버전 단정, 새 fixture로 계약(handback 커서의 grown·rewritten 쌍 포함)과 매트릭스 사례 9개
- `apps/cli/test/sessions-ingest.test.ts` — CLI 수준 verify 2개(보고 2건만 표시, v2 세션 재수집 시 보고만 inserted·기존 seq·본문 그대로·`parser_version='3'`)
- `_bmad-output/personal-brain/deferred-work.md` — 2.7 follow-up 리뷰 항목은 열린 채 갱신, 새 항목 둘(옛 handback 본문 출처, 버전이 올라도 스캔이 다시 넣지 않음)

**리뷰:** quick 1회, 4건 — 패치 3(medium 1, low 2), 보류 1(medium, frontmatter `deferred`), 거부 0. 후속 리뷰 권고: false(패치한 medium 1건, high 0건).

**검증:** `pnpm test`(build → typecheck → vitest) 59파일 1892건 통과, 리뷰 패치 뒤 다시 통과(Postgres 통합은 `BRAIN_TEST_DATABASE_URL` 없이 돌림). 매트릭스 8행 모두 실행된 테스트가 덮음. 구현 서브에이전트가 임시 `SECOND_BRAIN_HOME`에서 수동 확인: `inserted {messages: 4, toolNotes: 2}`, 보고 seq 1·2(`model` null), `parser_version=3`, 안내 문장·표지 문자열 0건. 리뷰어가 실측 수치(367·123·244·177·381)를 따로 다시 세어 같은 값을 얻었다.

**보고 누락 비율(티켓 verify):** 수정 전 65.8%(티켓 셈법, 2026-10-18의 약 58%와 같은 셈), 안내 문장을 뺀 셈으로는 v2 96.3% → v3 64.0%. 남은 64.0%는 모두 `handbackReportText`가 없는 옛 handback(Claude Code 2.1.296 이하)이다.

**에이전트가 대신 내린 결정(intent-contract에 기록):**
1. `handbackReportText`가 없는 옛 handback은 뺀다(다른 안: `origin.body`의 앞머리·들여쓰기를 걷어 본문으로 씀).
2. 안내 문장 하나뿐인 동기·비동기 결과는 보고로 저장하지 않는다(다른 안: 지금처럼 저장). 티켓에 없던 범위다.

**사람 확인 필요:**
- 위 결정 1·2가 맞는지. 1은 이 Mac의 실제 보고 대부분(244건)을 계속 빼므로, 실제 수집을 켜는 2.14 전에 정하는 것이 좋다.
- 티켓은 이 스토리의 리뷰를 "2.7 전체를 다시 보는 follow-up"으로 하라고 했지만, 이 실행의 리뷰는 변경 diff를 본 quick 렌즈 1회였다. 2.7의 나머지 규칙 재검토는 deferred-work에 열린 항목으로 남겼다.

**남은 위험:** 두 번째 안내 문장("has not reported yet")은 아직 보고로 저장된다(deferred). 안내 문장 판정은 영어 문장 전체 일치라서 편집기가 문구를 바꾸면 다시 보고로 저장된다. 폴더 스캔은 크기가 같은 파일을 다시 큐에 넣지 않으므로, 버전 2로 저장된 끝난 세션은 다시 수집되기 전까지 보고가 더해지지 않는다(실제 수집은 2.14 전까지 꺼져 있어 지금 그런 세션은 없다).
