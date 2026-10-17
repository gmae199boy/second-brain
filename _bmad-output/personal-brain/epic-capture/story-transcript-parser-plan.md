---
title: 'transcript parser 완성: 도구 메모·서브에이전트 보고·추적 정보·증분 읽기'
type: 'feature'
ticket: '7'
created: '2026-10-18'
status: 'built'
baseline_revision: '2dde6661abaffb89dfa21aabed47216f4c7f7243'
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

**Problem:** 2.2의 Claude Code parser는 본문만 낸다. 도구 메모, 서브에이전트 최종 보고, 메시지마다의 브랜치·cwd, `start_source`가 없다. 매 턴 파일 전체를 처음부터 parse하고, 저장된 커서를 읽지 않으므로 `CURSOR_RESET`도 나지 않는다. task-notification·로컬 명령 출력·API 오류 같은 대화 아닌 user/assistant 항목도 본문으로 들어간다.

**Approach:** parser port를 `parse(content, cursor)`로 넓힌다. 커서가 맞으면 커서 줄부터만 읽고, 맞지 않으면 처음부터 읽으며 `cursorReset`을 낸다. 메시지에 `gitBranch`·`cwd`·`isSubagentReport`를, 결과에 `startSource`를 더한다. Store는 0004의 `messages.git_branch`·`is_subagent_report`를 쓰고 읽으며, `start_source`를 갱신하고, 커서가 뒤로 가지 않게 한다. Core ingest는 저장된 커서를 먼저 읽어 parser에 넘긴다. 실제 구조를 따른 중립 fixture로 계약을 통과시킨다.

## Boundaries & Constraints

**Always:**
- 줄은 `\n`으로만 나눈다(U+2028·U+2029는 문자열 안 글자). 순서는 파일 위치이고 시각으로 정렬하지 않는다. 출력은 (content, cursor, `parser_version`)의 순수 함수다. `CLAUDE_CODE_PARSER_VERSION`을 `'2'`로 올린다.
- **메시지가 되는 것:** `type`이 user·assistant이고, `isSidechain`·`isMeta`·`isCompactSummary`가 아니며, `text` 블록(또는 문자열)의 본문이 비지 않은 항목이다. 다음은 추가로 뺀다.
  - assistant의 `isApiErrorMessage: true`
  - user의 `origin.kind`가 `task-notification`(아래 보고 예외) 또는 `peer`인 것
  - 문자열 본문이 `<local-command-stdout>`·`<local-command-caveat>`·`<bash-stdout>`·`<bash-stderr>`로 시작하는 user 항목(도구 출력)
- `image` 블록과 `tool_result`는 본문에 들어가지 않는다(base64 없음).
- **서브에이전트 최종 보고**(`isSubagentReport: true`, role `assistant`, model null)는 메인 transcript에서만 읽는다.
  - 동기: user 항목의 `toolUseResult`에 `agentId`가 있고 `status === 'completed'`이면, 본문은 `toolUseResult.content`의 text 블록이다.
  - 비동기: `origin.kind === 'task-notification'`인 user 항목이 `<status>completed</status>`과 `<result>…</result>`를 가지고, 그 `<task-id>` X가 그 줄보다 앞의 content에 `"agentId":"X"`로 나오면, 본문은 `<result>` 안쪽(trim)이다.
  - 서브에이전트 파일(`subagents/`)은 읽지 않는다. 그래서 2.12 스캔 범위에 더할 경로 규칙이 없다.
- **도구 메모:** assistant 항목의 `tool_use` 블록마다 하나다.
  - 메모는 파일에서 그 앞의 마지막 메시지에 붙는다(`harnessMessageId`). `ordinal`은 그 메시지 뒤 `tool_use`의 0부터 순번이다. 앞에 메시지가 없으면 내지 않는다.
  - `ok`는 같은 `tool_use_id`의 `tool_result`가 `is_error: true`가 아니면 true다. 결과가 아직 없으면, 그 뒤에 메시지가 있을 때 `ok:false`로 내고 없으면 내지 않는다(다음 읽기가 다시 본다).
  - `tool`은 `name`이다. `target`은 입력의 한 값의 첫 줄을 500자로 자른 것이다.
    - Bash `command`, Read·Write·Edit·MultiEdit `file_path`, NotebookEdit `notebook_path`, Grep·Glob `pattern`, WebFetch `url`, WebSearch·ToolSearch `query`, Agent·Task `description`, Skill `skill`
    - 그 밖의 도구는 `file_path, path, url, query, pattern, command, description, name` 중 처음 있는 문자열, 없으면 `''`
  - 도구 출력·`content`·`old_string`·`new_string`은 쓰지 않는다.
- **추적 정보:** 메시지마다 `gitBranch`(줄의 값 그대로, 없으면 null), `cwd`(같음; 저장하지 않고 2.8이 첫 메시지 것을 쓴다), `model`, `occurredAt`을 낸다. `startSource`는 content 안의 마지막 `attachment.hookName`이 `SessionStart:<startup|resume|clear|compact|fork>`인 것의 값이고, 없으면 null이다.
- **커서와 증분 읽기:** 커서는 2.2와 같다(마지막 메시지 uuid + 그 줄 끝까지의 sha256, 줄바꿈 제외).
  - 커서가 주어지면 content에서 `"uuid":"<id>"`로 그 줄을 찾는다. 그 줄이 같은 uuid의 메시지이고 fingerprint가 맞으면, 그 줄(포함)부터만 JSON을 읽는다. 결과 메시지는 커서 메시지부터 시작한다.
  - 못 찾거나 다르면 처음부터 읽고 `cursorReset: true`다.
  - 증분 결과는 같은 content의 전체 결과 중 커서 메시지부터의 부분과 같다.
- **Store:**
  - `git_branch`·`is_subagent_report`를 넣고 읽는다(`Message`에 `gitBranch`·`isSubagentReport`).
  - `start_source`는 batch에 값이 있을 때만 갱신한다.
  - 커서는 새 커서 메시지의 seq가 저장된 커서 메시지의 seq 이상일 때만 바꾼다. 단, `cursorReset`이거나 저장된 커서 메시지가 없으면 바꾼다.
  - 메모리 가짜도 같게 한다.
- fixture는 실제 transcript의 키·모양을 따르되 문장·경로·이름은 중립으로 직접 쓴다(공개 저장소). 실제 transcript를 복사·변환하지 않는다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 서브에이전트 최종 보고는 메인 transcript의 동기 Agent 결과(`toolUseResult.content`)와 비동기 task-notification `<result>`에서 읽는다. 실측(이 Mac, 구조만): Agent 호출 378건 중 332건이 비동기다. 서브에이전트 파일 200개 중 135개는 마지막 항목이 assistant 답이 아니다. 답 하나가 블록별로 여러 줄에 나뉜다. 그래서 파일의 "마지막 답"은 믿기 어렵고, 다른 파일을 읽으면 커서와 증분이 한 파일로 닫히지 않는다. 다른 안: `subagents/agent-<id>.jsonl`의 마지막 assistant text.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): "바이트 위치부터의 증분 읽기"는 저장된 커서로 content 안의 위치를 찾고(문자열 검색, JSON 해석 없음), 그 위치부터만 해석하는 것으로 한다. 파일은 지금처럼 통째로 읽는다. 스키마는 바꾸지 않는다. 다른 안: 마이그레이션 0005로 `sessions`에 바이트 오프셋 칸을 두고 파일을 그 위치부터 읽음(0005와 버전 단정 연쇄가 생기고, fingerprint 확인에는 어차피 앞부분이 필요하다).
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): `start_source`는 transcript의 `SessionStart:<source>` hook 첨부에서 읽는다. Brain 플러그인이 SessionStart hook을 가지므로 수집되는 세션에는 늘 있다. 없으면 null이다. 다른 안: compact_boundary·fork-context-ref 항목에서 추정.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 애매한 user 항목은 빼는 쪽을 고른다(task-notification, peer, 로컬 명령·`!` 명령 출력, API 오류). 넣은 메시지는 고칠 수 없지만, 빠진 것은 parser 버전을 올려 재수집하면 더해지기 때문이다. `<command-name>`·`<command-message>`·`<bash-input>`(사람이 친 것)은 넣는다. 다른 안: 모두 넣음.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 도구 메모는 그 앞의 마지막 메시지에 붙인다. `tool_use`만 든 assistant 줄은 메시지가 아니고, parser 계약은 메모가 batch의 메시지를 가리키기를 요구한다. 다른 안: 메모용 빈 메시지를 만듦, 계약 완화.

**Never:**
- 서브에이전트 파일 읽기, 스키마·마이그레이션 변경, 프로젝트·워크트리 꼬리표(2.8), 마스킹(2.9), spool(2.10), 폴더 스캔과 `transcript_files`(2.12), 플러그인 hook(2.14).
- 실제 `~/.claude`·`~/.second_brain` 변경. 시험은 `SECOND_BRAIN_HOME=<임시>`로만 한다.
- 이미 저장된 메시지·도구 메모 수정.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 전체 fixture | 커서 없음, `full-session.jsonl` | 기대 메시지 목록(보고 2건 포함), 도구 메모(ok true/false), 메시지별 브랜치(중간에 바뀜), `startSource` 마지막 값 | — |
| 이어 쓴 transcript | 앞 절반의 커서 + 전체 content | `cursorReset:false`, 메시지는 커서 메시지부터. 수집하면 새 메시지만 들어감 | — |
| 앞부분 바뀜 | 커서 + 앞 줄 하나를 고친 content | `cursorReset:true`, 전체 결과. 수집 결과 기존 seq·본문 그대로, `warnings`에 `CURSOR_RESET` | 경고만 |
| 커서 메시지 없음 | 커서 uuid가 content에 없음(compact·fork) | 위와 같음 | 경고만 |
| 도구 결과 대기 | 마지막 `tool_use`의 결과가 아직 없음 | 그 메모는 나오지 않음. 결과가 붙은 다음 읽기에서 나옴 | — |
| 이미지 붙여 넣기 | user `image`+`text` 블록, `imagePasteIds` | 본문은 text만. 저장된 본문에 base64 없음 | — |
| 서브에이전트 | 동기 1건, 비동기 1건, `isSidechain` 줄, 백그라운드 bash 알림 | 보고 2건만 `is_subagent_report=1`. 사이드체인 대화와 bash 알림은 없음 | — |
| 대화 아닌 항목 | API 오류, `<local-command-stdout>`, peer, meta, compact 요약, `system`, `attachment` | 메시지 아님 | — |
| U+2028 | 문자열 안의 원문 U+2028·U+2029 | 한 줄로 읽힘 | — |
| 겹친 오래된 수집 | 새 커서가 저장된 것보다 앞 메시지 | 커서 그대로 | — |

</intent-contract>

## Code Map

- `packages/claude-code/src/parser.ts` -- 지금 parser(본문만, 커서 계산 `cursorFor`, `fingerprintEnd`). 이 파일을 넓힌다. 새 도구 대상 규칙이 길면 `src/tool-target.ts`로 나눠도 된다.
- `packages/claude-code/test/parser.test.ts`, `test/fixtures/two-turns.jsonl` -- 기존 테스트. 기대값 모양(`EXPECTED`)에 새 칸이 붙는다. two-turns의 hook 첨부에는 `hookName`만 있고 `hookEvent`가 없다(실측 데이터에는 둘 다 있음). 그래서 `hookName`으로 판정한다.
- `packages/core/src/ports/parser.ts` -- `Parser.parse(content)`·`ParseResult`. `parse(content, cursor?: ParserCursor | null)`로 바꾸고, ok 결과에 `cursorReset`·`startSource`를 더한다.
- `packages/core/src/domain/ingest-batch.ts` -- `ParsedMessage`에 `gitBranch`·`cwd`·`isSubagentReport`, `IngestTracking`에 `startSource`를 더한다.
- `packages/core/src/domain/message.ts` -- `Message`에 `gitBranch`·`isSubagentReport`를 더한다(cwd는 없음).
- `packages/core/src/ports/store.ts` -- `SessionStore`에 가벼운 `findSession(key)`를 더한다. 결과는 `{ok, session: Session | null}` 또는 `DB_UNAVAILABLE`이다. `readSession`은 메시지 전부를 읽으므로 커서 읽기에 쓰지 않는다.
- `packages/core/src/sessions/ingest.ts` -- 순서를 `token → parser → findSession(커서) → read → parse(content, cursor) → …`로 바꾼다.
  - `cursorReset`·`startSource`를 tracking에, `startSource`를 ensure 입력에 넘긴다.
  - 메시지가 0이어도 세션이 있고 도구 메모가 있으면 ingest한다.
- `packages/core/src/testing/fakes/{parser,store}.ts` -- `memoryParser`(JSON 형식, `smallHash`)가 커서 인자를 받는다. `memoryStore.ingest`(133행~)에 같은 store 규칙을 넣는다.
- `packages/core/src/testing/contracts/{parser,session-store}.ts`, `fixtures.ts` -- parser 계약(8 사례, "메모는 batch의 메시지를 가리킨다" 포함)과 session-store 계약이다. `ParserSubject`에 `grown`·`rewritten` 쌍(`{before, after}`)을 더한다.
- `packages/core/test/contracts.test.ts`, `sessions-ingest.test.ts` -- 음성 사례와 use case 테스트.
- `packages/sqlite/src/sessions.ts` -- insert(168행 부근 열 목록), `readSessionRow`, `toMessage`, tracking update. `messages_immutable_update` trigger는 insert에 상관없다.
- `packages/sqlite/test/session-store.test.ts` -- 계약 실행.
- `apps/cli/test/sessions-ingest.test.ts` -- `dist/bin.js`를 stdin pipe로 띄우는 CLI 수준 테스트. `FIXTURE`, `homeFor`, `migratedDatabase` 헬퍼를 재사용한다.
- 읽기만: `packages/sqlite/migrations/0004_capture_columns.sql`(57~90행, 두 칸과 불변 trigger), `packages/postgres/src/store.ts`(SessionStore 미구현, 건드리지 않음).

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/{ports/parser,ports/store,domain/ingest-batch,domain/message}.ts` -- Code Map의 타입 변경. 주석은 이 플랜의 규칙을 적는다.
- [x] `packages/core/src/sessions/ingest.ts` -- 커서를 먼저 읽고 parser에 넘긴다. `startSource`·`cursorReset`을 전달한다.
- [x] `packages/core/src/testing/{fakes/parser,fakes/store,fixtures,contracts/parser,contracts/session-store}.ts` -- 가짜와 계약을 맞춘다.
  - parser 계약 새 사례: 커서가 맞으면 증분 결과가 전체 결과의 커서 메시지부터와 같고 `cursorReset` false다. `rewritten`과 남의 커서는 reset·전체 결과다. 같은 (content, cursor)는 같은 결과다.
  - store 계약 새 사례: 두 칸 왕복, `start_source` 갱신·유지, 커서가 뒤로 가지 않음, reset이면 바뀜, `findSession`.
- [x] `packages/core/test/{contracts,sessions-ingest}.test.ts` -- 음성 사례(증분에서 커서 메시지를 빠뜨리는 parser, 커서를 뒤로 돌리는 store)와 use case 행.
- [x] `packages/sqlite/src/sessions.ts`, `packages/sqlite/test/session-store.test.ts` -- 새 칸, `findSession`, `start_source`, 커서 단조.
- [x] `packages/claude-code/src/parser.ts` -- Always의 규칙 전부. 버전 `'2'`.
- [x] `packages/claude-code/test/fixtures/full-session.jsonl`(신규), `test/parser.test.ts` -- 매트릭스의 parser 행을 담는다.
  - fixture에 들어갈 것: 실측 키(`parentUuid`, `userType`, `entrypoint`, `promptId`, `requestId`, `message.id`, `toolUseResult`, `sourceToolAssistantUUID`, `origin`), queue-operation·last-prompt·ai-title·file-history-snapshot 같은 비대화 항목, 같은 `message.id`가 블록별 여러 줄로 나뉜 assistant 답, 원문 U+2028, 시각이 거꾸로 간 줄, 중간에 바뀌는 `gitBranch`, compact 경계, `SessionStart:startup`·`SessionStart:compact` 첨부
  - 계약은 두 fixture 모두와 `grown`·`rewritten` 쌍으로 돌린다.
  - 저장 본문·도구 대상에 fixture의 도구 출력 표지 문자열과 base64 표지 문자열이 없음을 단정한다.
- [x] `apps/cli/test/sessions-ingest.test.ts` -- CLI 수준 verify 4가지(fixture는 `full-session.jsonl`):
  - 앞 절반을 넣은 뒤 전체를 넣으면 새 메시지만 들어간다(`inserted`).
  - 앞 줄을 고친 파일을 넣으면 `--json`의 `warnings`에 `CURSOR_RESET`이 있고 기존 seq·본문이 그대로다.
  - DB 전체 본문·도구 대상에 출력·base64 표지가 없다.
  - `is_subagent_report=1`이 2건이고 사이드체인 본문은 없다.

**Acceptance Criteria:**
- Given 마이그레이션한 SQLite와 메모리 가짜, when parser·session-store 계약을 돌리면, then 모든 사례가 둘 다에서 통과한다.
- Given 임시 home과 `full-session.jsonl`, when `brain sessions ingest claude-code --json`에 앞 절반 → 전체 → 앞 줄을 고친 파일 순서로 hook payload를 넣으면, then 두 번째는 새 메시지만 넣는다. 세 번째는 `warnings`에 `CURSOR_RESET`을 내고 아무 seq·본문도 바꾸지 않는다. DB에 도구 출력·base64가 없고, 서브에이전트 보고 2건만 표시가 붙는다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

구현 결과(2026-10-18):

- **도구 대상 규칙은 `packages/claude-code/src/tool-target.ts`로 나눴다.** 도구별 키 표와 fallback 키 순서가 순수 데이터여서 틀리기 쉬우므로 `toolTarget`을 직접 시험하는 블록을 `test/parser.test.ts`에 뒀다.
- **커서 줄 찾기는 공백을 허용한다.** 플랜의 `"uuid":"<id>"` 문자열 검색 대신 `/"uuid"\s*:\s*"<id>"/`로 찾는다. 기존 fixture `two-turns.jsonl`이 `"uuid": "..."`(콜론 뒤 공백)로 쓰여 있어서, 공백을 허용하지 않으면 그 fixture로는 증분 읽기가 영원히 reset이 된다. 찾은 줄은 그대로 믿지 않고 JSON으로 읽어 uuid를 다시 확인하고, **그 줄이 지금 규칙으로도 메시지인지**까지 확인한다(증분 결과는 커서 메시지부터 시작해야 하므로).
- **`startSource`는 content 전체에서 읽는다.** 커서로 뒤만 읽어도 값이 같아야 증분과 전체가 같은 결과가 되므로, `"hookName":"SessionStart:<source>"`를 content 전체에서 찾고 **맞은 줄만** JSON으로 읽어 `attachment.hookName`을 구조적으로 확인한다(줄 전체를 parse하지 않아 한 번의 스캔으로 끝난다).
- **메모리 가짜 파서의 fingerprint 계산을 바꿨다.** 전에는 `smallHash(content)`(파일 전체)여서 한 줄만 늘어도 커서가 안 맞았다. 이제 커서 메시지까지의 `{id, role, body}` 목록을 해시한다 — 실제 파서와 같은 성질(뒤에 붙으면 그대로, 앞이 바뀌면 달라짐)을 갖는다.
- **`memoryTranscript`에 네 번째 메시지(서브에이전트 보고)를 더했다.** 0004의 두 칸(`git_branch`·`is_subagent_report`)을 모든 store 계약이 왕복시키려면 fixture에 보고가 하나는 있어야 한다. 그래서 3건을 세던 기존 단정(core contracts·sessions-ingest·sqlite session-store)과 "앞이 바뀐 batch" 계약 사례의 `only`를 함께 고쳤다.
- **파서 버전이 다르면 커서를 넘기지 않는다.** `sessions.ingest`가 `sessions.parser_version`을 지금 파서의 버전과 견주어, 다르면 `null`을 넘겨 처음부터 다시 읽는다(옛 버전이 버렸던 줄이 새 규칙에서는 메시지일 수 있고, 옛 커서에서 시작하면 그것들을 영구히 잃는다). 다시 읽어도 멱등해서 넣는 것은 없다. 커서 줄이 "지금도 메시지인지" 확인하는 파서 쪽 검사는 이것을 대신하지 못한다(옛 커서가 여전히 맞을 수 있다).
- **한 줄이 두 번 쓰였으면 줄 전체를 건너뛴다.** uuid가 겹치면 같은 줄을 두 번 쓴 것이므로 메시지도, 도구 호출도 두 번 세지 않는다(`tool_use`가 든 줄이 겹치면 한 호출에 메모가 둘 생기고, 메모는 되돌릴 수 없다). uuid가 없는 줄(에디터 상태)은 대상이 아니다.
- **`<task-id>`는 첫 닫는 태그까지, `<result>`는 마지막까지 읽는다.** 보고 본문이 `</task-id>`를 담고 있으면 마지막까지 읽던 옛 방식은 id를 삼켜 보고를 통째로 잃는다.
- **메시지 0건 + 도구 메모만 있는 batch**는 세션이 이미 있을 때만 들어간다. 그때는 `ensureSession`을 아예 부르지 않는다(만들 것이 없고, 참인 `started_at`도 없다).
- `apps/cli/src/doctor/store.ts`와 `apps/cli/test/dispatch.test.ts`의 `Store` 대역에 `findSession`을 더했다(`SessionStore`가 넓어졌기 때문, 둘 다 `DB_UNAVAILABLE`을 그대로 답한다).
- fixture `full-session.jsonl`은 38줄이고 메시지 10건(보고 2건, 사람이 친 `<command-name>`·`<bash-input>` 2건 포함)·도구 메모 4건(대기 1건은 나오지 않음)을 담는다. 버려지는 줄에는 `<local-command-stdout>`·`<local-command-caveat>`·`<bash-stdout>`·`<bash-stderr>`와 보고가 없는 백그라운드 bash task-notification이 있고, 한 본문에 원문 U+2028·U+2029가 함께 들어 있다. 생성 스크립트로 만들었지만 결과 파일만 저장소에 둔다.

시험: `pnpm test`(build → typecheck → vitest) 통과. Postgres 통합 시험은 `BRAIN_TEST_DATABASE_URL`이 필요하다(`docker compose -f compose.test.yaml up -d` + `export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres`). 변수 없이 돌리면 그 16건이 환경 때문에 실패한다 — 이 스토리와는 무관하다.

수동 확인: 임시 `SECOND_BRAIN_HOME`에 `setup run --yes` 뒤 fixture로 `sessions ingest claude-code --json` → `inserted {messages: 10, toolNotes: 4}`, `messages`의 `git_branch`가 중간에 `main` → `feature/notes`로 바뀌고 `is_subagent_report=1`이 seq 4·8, `sessions.start_source='compact'`, `parser_version='2'`, 본문·대상에 출력·base64 표지 0건.

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass
- verdicts: 7 findings — high 0, medium 2, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 파서 버전이 올라도 옛 커서로 증분 읽기를 해 옛 세션의 앞부분이 새 규칙으로 다시 읽히지 않음 — `ingest.ts`가 `stored.parserVersion`을 보지 않았고, v1 커서 줄은 v2에서도 메시지라 맞았다. 고침: 버전이 같을 때만 커서를 넘김, docstring·Implementation Notes 정정, use case 테스트 추가.
  - `[medium]` `[patch]` 같은 줄이 두 번 쓰이면 `tool_use`가 다음 ordinal로 한 번 더 메모가 됨 — `readToolUses`가 `seen` 검사 전에 돌았다. 고침: uuid가 겹친 줄은 통째로 건너뜀, 테스트 추가.
  - `[low]` `[patch]` 보고 본문에 `</task-id>`가 있으면 task id가 늘어나 보고가 사라짐 — `between`이 마지막 닫는 태그까지 읽었다. 고침: `<task-id>`는 첫 닫는 태그까지, 테스트 추가.
  - `[low]` `[patch]` 매트릭스 "서브에이전트" 행의 백그라운드 bash 알림과 Decision의 남기는 사례(`<command-name>`·`<bash-input>`)가 fixture에 없음 — 고침: fixture에 해당 줄과 `<local-command-caveat>`·`<bash-stderr>`를 더하고 기대값·사례 갱신.
  - `[low]` `[patch]` U+2029가 fixture에 없음 — 고침: 한 본문에 원문 U+2029 추가(집계 U+2028 1, U+2029 1).
  - `[low]` `[patch]` CLI AC의 순서(앞 절반 → 전체 → 앞 줄 고침)가 한 home에서 돌지 않음 — 고침: 두 테스트를 한 home·한 세션의 순서 테스트 하나로 합침.
  - `[low]` `[patch]` 메모리 store `snapshot()`의 두 줄이 실수로 합쳐짐 — 고침: 원래 형식으로 복원.

## Design Notes

증분 판정 예:
```
find i = content.indexOf(`"uuid":"${cursor.lastHarnessMessageId}"`) → 줄 [s, e)
줄이 JSON이고 entry.uuid === id 이고 sha256(content.slice(0, e)) === fingerprint
  → parse lines from s (포함), cursorReset=false
else → parse from 0, cursorReset=true
```
JSON 문자열 안의 `"`는 `\"`로 쓰이므로 본문 속 같은 글자열과 헷갈리지 않는다. 그래도 줄을 해석해 uuid를 다시 확인한다. `parentUuid`·`leafUuid`는 대문자 U라서 걸리지 않는다.

증분과 전체의 동치: 비동기 보고의 `agentId` 확인을 두 경우 모두 "그 줄 앞 content의 문자열 검색"으로 하면 같은 결과가 나온다. 중복 uuid 제거(`seen`)는 증분 범위 안에서만 된다. 커서 앞 메시지와 겹치는 중복은 store가 harness id로 거른다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과

**Manual checks (if no CLI):**
- 임시 home(`SECOND_BRAIN_HOME`)에 `setup run --yes` 뒤 fixture로 `sessions ingest claude-code --json`을 실행한다. 그다음 `sqlite3 <home>/brain.db "select seq, role, git_branch, is_subagent_report, substr(body,1,30) from messages order by seq"`와 `select tool, target, ok from tool_notes`로 확인한다.

## Auto Run Result

**요약:** Claude Code parser(버전 2)가 도구 메모 한 줄(도구·대상, 출력 제외), 서브에이전트 최종 보고(`is_subagent_report`, 메인 transcript에서 읽음), 메시지별 `git_branch`·cwd, `start_source`를 내고, 대화 아닌 user/assistant 항목(task-notification, peer, 로컬 명령·`!` 명령 출력, API 오류)을 빼며, 저장된 커서로 content 안 위치를 찾아 그 줄부터만 읽는다(앞이 바뀌면 처음부터 + `CURSOR_RESET`). Store는 0004의 두 칸을 쓰고 읽으며 `start_source`를 갱신하고 커서가 뒤로 가지 않게 한다. Core ingest는 같은 parser 버전일 때만 저장된 커서를 넘긴다. 스키마 변경은 없다.

**바뀐 파일:**
- `packages/claude-code/src/parser.ts` — 규칙 전부, 증분 읽기, 버전 2
- `packages/claude-code/src/tool-target.ts`(신규) — 도구별 대상 키 표와 500자 첫 줄 자르기
- `packages/claude-code/test/fixtures/full-session.jsonl`(신규), `test/parser.test.ts` — 실측 구조를 따른 중립 fixture(38줄)와 사례
- `packages/core/src/ports/{parser,store,index}.ts`, `domain/{ingest-batch,message}.ts` — `parse(content, cursor)`, `cursorReset`·`startSource`, 메시지 새 칸, `findSession`
- `packages/core/src/sessions/ingest.ts` — 커서 먼저 읽기, 버전 비교, 도구 메모만 있는 batch
- `packages/core/src/testing/**`, `packages/core/test/{contracts,sessions-ingest}.test.ts` — 가짜·계약(parser +4, session-store +4)·음성 사례
- `packages/sqlite/src/sessions.ts`, `test/session-store.test.ts` — 새 칸, `findSession`, `start_source`, 커서 단조
- `apps/cli/src/doctor/store.ts`, `apps/cli/test/{dispatch,sessions-ingest}.test.ts` — `Store` 대역 갱신, CLI 수준 verify

**리뷰:** quick 1회, 7건. 패치 7(medium 2, low 5), 보류 0, 거부 0. 후속 리뷰 권고: true(patched medium 2) — 이름 붙인 위험: 리뷰 뒤 바뀐 두 규칙(버전이 다르면 커서 무시, 겹친 줄 통째로 건너뛰기)은 패치한 서브에이전트의 좁은 테스트와 메인 세션의 전체 테스트로만 확인했고 독립 리뷰를 다시 거치지 않았다.

**검증:** `pnpm test`(build → typecheck → vitest, Postgres 통합 포함 `BRAIN_TEST_DATABASE_URL` 설정) 42파일 1305건 통과. 매트릭스 10행 모두 실행된 테스트가 덮음(U+2028·U+2029 집계 1·1). 임시 `SECOND_BRAIN_HOME`에서 fixture 수집: 메시지 10·도구 메모 4, 브랜치 `main`→`feature/notes`, 보고 seq 4·8, `start_source='compact'`, 출력·base64 표지 0건. 실제 `~/.second_brain`은 여전히 없고 `~/.claude`는 읽기만 했다(구조 집계, 내용 미기록).

**에이전트가 대신 내린 결정** (모두 intent-contract의 Decision에 기록):
1. 서브에이전트 최종 보고는 메인 transcript(동기 `toolUseResult.content`, 비동기 task-notification `<result>`)에서 읽고 `subagents/` 파일은 읽지 않음 — 그래서 2.12 스캔 범위에 더할 경로 규칙이 없다(다른 안: 서브에이전트 파일의 마지막 답).
2. "바이트 위치부터의 증분 읽기"는 커서로 content 안 위치를 찾아 그 줄부터 해석하는 것으로 함, 파일은 통째로 읽고 스키마는 그대로(다른 안: 0005로 오프셋 칸 + 부분 읽기).
3. `start_source`는 transcript의 `SessionStart:<source>` hook 첨부에서 읽음, 없으면 null(다른 안: compact_boundary 등에서 추정).
4. 애매한 user 항목(task-notification, peer, 명령 출력, API 오류)은 뺌; 사람이 친 `<command-name>`·`<bash-input>`은 넣음(다른 안: 모두 넣음).
5. 도구 메모는 파일에서 그 앞의 마지막 메시지에 붙임(다른 안: 빈 메시지 생성, 계약 완화).
6. 서브에이전트 보고의 role은 `assistant`, model은 null(플랜 Always에 적음).
7. fixture는 실제 transcript를 변환하지 않고 실측 구조를 보고 직접 썼다(공개 저장소).

**사람 확인 필요:**
- fixture `packages/claude-code/test/fixtures/full-session.jsonl`을 읽어 보고 커밋해도 되는지(티켓: "사람이 확인한 뒤 커밋"). 자동 검사로는 경로가 `/demo/workspace`·`notes/…`뿐이고 개인·회사 식별자가 없음을 확인했다. 이 실행에서는 커밋했으므로, 문제가 있으면 되돌리거나 고쳐야 한다.
- 실제 Claude Code 세션 하나를 임시 home으로 수집해 보고(2.2의 `tooling/dev/tracer-session.sh` 방식) 다음을 눈으로 확인: 사람이 한 말이 빠지지 않았는지, 서브에이전트 보고가 하나씩 표시와 함께 들어오는지, 도구 대상이 쓸 만한지. 비대화 판정과 비동기 보고 모양은 중립 fixture로만 맞췄다.
- 위 결정 1~6이 맞는지. 특히 2(오프셋 칸 없이 파일 통째 읽기)는 큰 transcript(최대 약 19MB)에서 hook 지연이 괜찮은지 2.15 sweep의 시작 지연 측정과 함께 볼 것.

**남은 위험:** 실제 transcript 모양이 fixture와 다르면 메시지가 빠질 수 있다(빠지는 쪽이 안전한 실패이고, parser 버전을 올리면 재수집된다). 비동기 보고가 나중에 SendMessage로 이어진 같은 서브에이전트에서 여러 번 오면 보고가 여러 건이 된다.
