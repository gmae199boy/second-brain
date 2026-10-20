---
title: '마스킹 B: 저장은 원문, Core 출력 코덱에서 가리기'
type: 'feature'
ticket: '17'
created: '2026-10-20'
status: 'built'
baseline_revision: 'eedf8f26aed5c62b2d43e914248891d2398456c6'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/personal-brain/epic-capture/story-untitled-9-plan.md'
  - '{project-root}/_bmad-output/personal-brain/change-masking-b-and-review-fixes/change-masking-b-and-review-fixes.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** 2.9가 수집 경로에서 비밀을 가려 저장한다. 그래서 패턴의 과잉 가림이 저장된 원문을 되돌릴 수 없게 망가뜨린다. 한편 Brain 밖으로 나가는 출력(엔벨로프·텍스트 줄·hook 줄)은 아무것도 가리지 않는다. 2.9가 미룬 패턴 문제 셋(영어 키워드 과잉 가림, 한국어 "비밀번호 X"·"비밀번호가 X" 놓침, `!` 같은 구두점에서 값이 끊김)과, 500자로 잘린 도구 메모 대상 끝에 걸친 키 조각(2.7 follow-up 리뷰 #21)도 남아 있다.

**Approach:** 수집 경로의 가리기와 수집 중 `redactions` 쓰기를 빼서 본문·대상을 원문 그대로 저장한다. `maskSecrets`는 Core의 출력 가리기 함수로 남긴다. Core에 출력 코덱 모듈과 등록부(`envelope`, `hook`, `text`)를 둔다. 엔벨로프 코덱은 만들 때 `data`·`error`·`warnings`·`meta`의 모든 문자열 값을 가린다. CLI의 모든 출력 자리는 등록된 코덱을 거친다. 계약 테스트가 "저장본에는 비밀이 있고, 모든 코덱의 출력에는 없음"과 "등록부에 없는 출력 자리가 있으면 실패"를 본다. 패턴은 버전 `'2'`로 고친다.

## Boundaries & Constraints

**Always:**
- **수집은 원문:**
  - `sessions.ingest` use case는 `maskSecrets`를 부르지 않는다.
  - `IngestMessage.redactions`·`IngestRedaction`·`IngestCounts.redactions`를 없앤다. SQLite store, 메모리 가짜, 계약, fixtures, CLI 명령 메타 `output`, 주석에서도 뺀다.
  - 수집은 `redactions`에 행을 쓰지 않는다.
  - `failureText`(`domain/failure.ts`, 저장 전 가림)는 그대로 둔다. 이것은 오류 기록의 의도된 예외다.
- **출력 가리기 함수**(`packages/core/src/output/`, Core 순수 함수, `types: []` 안에서):
  - `maskOutputText(text)`: 본문 규칙이다. `maskSecrets(text, 'body').text`와 같다.
  - `maskOutputValue(value)`: 배열과 평범한 객체를 깊이 따라가서, 모든 문자열 **값**을 `maskOutputText`로 가린 사본을 만든다. 키, 숫자, 불리언, null은 그대로다. 입력은 바꾸지 않는다.
  - `maskToolNoteTarget(target)`: `tool_target` 규칙이다. `maskSecrets(target, 'tool_target')`에 아래 "잘린 꼬리" 규칙을 더한 것이다.
  - `toolNoteForOutput(note)`: `target`만 `maskToolNoteTarget`으로 바꾼 사본이다. 도구 메모를 돌려주는 읽기 결과는 이것을 먼저 걸고, 그다음 코덱이 모든 문자열에 본문 규칙을 건다(2026-10-19 사용자).
  - 가린 표시는 다시 잡히지 않는다. 그래서 어느 함수든 두 번 걸어도 결과가 같다.
- **잘린 꼬리 규칙**(#21):
  - 도구 메모 대상의 상한 500을 Core 상수 `TOOL_NOTE_TARGET_LIMIT`로 옮긴다. `packages/claude-code/src/tool-target.ts`의 `TOOL_TARGET_LIMIT`는 그 값을 쓴다(값과 자르기 방식은 바꾸지 않는다).
  - 대상의 UTF-16 길이가 상한 이상이면, 끝에 닿은 마지막 토큰을 `[REDACTED:truncated]`로 가린다. 토큰의 시작은 마지막 공백 문자 뒤와 마지막 가린 표시의 끝 중 더 뒤쪽이다. 길이가 0이면 가리지 않는다.
  - 상한보다 짧은 대상에는 이 규칙이 걸리지 않는다.
- **코덱과 등록부**(`OUTPUT_CODECS`, Core에서 export):
  - `envelope`: `okEnvelope`·`errorEnvelope`가 만드는 순간 `data`·`warnings`·`meta`·`error`(`message`·`hint`·`retry.args` 포함)를 `maskOutputValue`로 가린다. 그래서 CLI·소켓·MCP가 따로 할 일이 없다. CLI의 `retry_argv`는 가려진 `error.retry`에서 만든다(지금 그렇다).
  - `hook`:
    - `encodeHookOutput(output)`: hook stdout 한 줄 JSON이다. 모든 문자열 값을 가린다. 지금 부르는 곳은 없고, 시작 맥락(epic 3)이 쓴다.
    - `encodeHookLine(text)`: hook 경로의 stderr 한 줄을 가린다.
  - `text`: `encodeTextLine(line)`. 사람이 읽는 stdout·stderr 줄을 가린다.
  - 등록부 항목마다 `name`과 `render(probe)`를 둔다. `render(probe)`는 시험용 견본(본문 문자열들과 도구 메모들)을 실제 코덱 함수에 통과시킨 출력 문자열이다. 미러·내보내기·복제·임베딩 코덱은 그것을 만드는 에픽이 등록한다.
- **CLI 출력 자리는 전부 코덱을 거친다:**
  - `apps/cli/src/dispatch.ts`:
    - `--json` 엔벨로프는 이미 가려져 있다.
    - text 모드 줄, `warningLines`, 실패 줄(`code: message`, hint), 기회적 drain 오류 줄은 `encodeTextLine`을 거친다.
    - hook 경로의 실패 줄과 예외 줄은 `encodeHookLine`을 거친다.
  - `apps/cli/src/commands/setup-run.ts`의 직접 `process.stdout.write`와 `apps/cli/src/install.ts`의 `log`는 `encodeTextLine`을 거친다.
  - commander 도움말은 등록부의 정적 문구만 내므로 예외다. 이 이유를 sink 표에 적는다.
- **계약 테스트**(CLI 수준):
  - 비밀 fixture를 `brain sessions ingest`로 수집한다.
  - 저장본(SQLite `messages.body`·`tool_notes.target`)이 transcript와 글자 단위로 같고, `redactions`는 0행인지 본다.
  - 저장한 세션을 읽어 견본을 만든다. 등록된 **모든** 코덱의 `render` 출력에 비밀값이 하나도 없어야 한다. 도구 메모는 `toolNoteForOutput`을 거친다.
  - **sink 검사:** `apps/*/src`·`packages/*/src`에서 `process.stdout.write`·`process.stderr.write`·`console.`을 찾는다. 찾은 파일마다 "파일 → 쓰는 코덱 이름" 표에 있어야 하고, 표의 코덱 이름은 `OUTPUT_CODECS`에 있어야 한다. 둘 중 하나라도 어긋나면 실패한다.
  - `tooling/`·`plugin/`은 Core를 import할 수 없다(node 내장만 쓴다). 저장본을 읽지 않으므로 검사 밖이고, 그 이유를 테스트 주석에 적는다.
- **패턴 버전 `'2'`**(`SECRET_PATTERN_VERSION = '2'`). 놓침은 넓히는 쪽으로, 과잉 가림은 값 모양 규칙으로 고친다.
  - 키워드 값의 문자 집합:
    - 값은 공백, 따옴표(`'"`` ` ``), `,`, `;`, 전각 `，。、`, 한글(`HANGUL`)에서 멈춘다.
    - `!`·`?`·`.`·`:`·괄호는 값 안에 들어간다.
    - 값 끝에서 짝 없는 닫는 괄호(`)]}>`)는 뗀다.
  - 영어 키워드에만 쓰는 값 모양 규칙. **따옴표 없는** 값만 거르고, 따옴표로 감싼 값은 모양과 상관없이 가린다:
    - (a) 식별자 뒤 `(`로 시작하는 호출 모양(`parse(input)`)이면 가리지 않는다.
    - (b) 숫자만이면 가리지 않는다.
    - (c) 영문자로만 된 값 뒤에 공백과 영문자 단어가 이어지는 문장이면 가리지 않는다(`see the README`).
  - 2.9의 `(?!=)`(비교식 제외)는 그대로다.
  - 한국어 키워드(`비밀번호|암호|패스워드`) 뒤 구분자는 셋 중 하나다. 그 뒤의 값은 한글로 시작하지 않아야 하고(2.9 그대로), 값 모양 규칙은 걸지 않는다:
    - `\s*[:=]\s*`
    - 조사(`은|는|이|가|을|를|도`) 뒤 `\s*`(선택적 `[:=]\s*`)
    - 공백 하나 이상
  - 2.9의 과잉 가림 회귀 표는 그대로 통과해야 한다. 엔벨로프가 지나는 ID(세션 토큰 `claude-code:<uuid>`, ISO 시각과 오프셋)를 회귀 표에 더한다.
- 새로 쓰는 사람이 읽는 문장은 한국어다. 코드·kind·주석은 영어다. 시험의 비밀값은 모두 지어낸 것이다.
- `deferred-work.md`와 README를 마스킹 B에 맞춘다. README에는 "저장은 원문, 출력에서 가림, 저장본에서 지우기는 `messages redact`(2.13)"를 짧게 적는다.

**Never:**
- 마이그레이션·스키마 변경(18), `messages redact`·`detected`(13), 실제 수집 켜기(14), parser 버전 변경과 parser 동작 변경. 자르기 상수의 위치만 옮긴다.
- 출력 가리기가 `redactions`에 쓰기, Store·adapter가 가린 텍스트를 돌려주기.
- 지운 텍스트를 로그·오류·반환값·시험 스냅샷 출력에 남기기.
- 실제 `~/.claude`·`~/.second_brain` 변경. 수동 확인은 임시 `SECOND_BRAIN_HOME`으로만 한다.
- `tooling/bootstrap`·`plugin/`이 Core를 import하게 하기.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 원문 저장 | 비밀 fixture 수집 | `messages.body`·`tool_notes.target`이 transcript와 같음. `redactions` 0행. `inserted`에 `redactions` 키 없음 | — |
| 코덱 출력 | 그 저장본을 `envelope`·`hook`·`text`의 `render`에 | 어느 출력에도 fixture 비밀값이 없음 | — |
| 과잉 가림 없음 | 본문 `let token = parse(input);`, `secret: see the README`, `{"token": 123}`, `NODE_ENV=production` | 코덱 출력에 그대로 | — |
| 셸 규칙 | 도구 메모 대상 `API_KEY=xyz123 node run.js` | `toolNoteForOutput` 뒤 `xyz123`이 없음. 이름은 남음 | — |
| 한국어·끊김 | `비밀번호 Tiger2024`, `비밀번호가 Tiger2024`, `password: Pa!ss2024` | 값 전체가 표시 하나. `Tiger2024`·`Pa`·`ss2024` 조각 없음 | — |
| 잘린 꼬리 | 첫 줄이 500자를 넘는 Bash 명령. `sk-` 키가 500번째 글자에 걸침 | 저장 대상은 키 앞부분으로 끝남. 출력에는 그 앞부분이 없고 `[REDACTED:truncated]`가 있음 | — |
| 멱등 | 어느 함수든 출력을 다시 넣음 | 바뀌지 않음 | — |
| 엔벨로프 ID | 세션 토큰, ISO 시각, 경로, sha, git SHA가 든 `data` | 그대로 | — |
| 미등록 출력 | `apps/cli/src`에 표에 없는 파일이 `process.stdout.write`를 씀 | sink 검사가 실패 | 테스트 실패 메시지가 파일 이름을 댐 |

</intent-contract>

## Code Map

- `packages/core/src/sessions/ingest.ts`:
  - L4·L8: import를 뺀다.
  - L306: 이른 반환의 `redactions: 0`을 뺀다.
  - L323-352: 메시지는 `{ ...message, id: idGen.next() }`로 만든다. 도구 메모 `target`은 원문 그대로 둔다. 가리기 주석은 마스킹 B로 고친다.
- `packages/core/src/sessions/spool-ingest.ts` L93 -- `redactions: 0`을 뺀다. spool 레코드에는 batch가 없다(본문 없음).
- `packages/core/src/domain/ingest-batch.ts`:
  - L46-74: `IngestRedaction`을 지운다.
  - L76-98: `IngestMessage.redactions`와 "masked" 문서를 고친다.
  - `domain/index.ts` L83: export를 뺀다.
- `packages/core/src/ports/store.ts`:
  - L141-149: `IngestCounts.redactions`를 지운다.
  - L243-251: ingest 주석의 가리기 기록 규칙을 지운다.
- `packages/sqlite/src/sessions.ts` -- 다음 셋을 지운다:
  - L219-228: `pending`의 `redactions`
  - L246-285: `insertedRedactions`와 `insert into redactions` 루프
  - L343: 반환값의 `redactions`
- `packages/core/src/testing/fakes/store.ts`:
  - 지운다: L272·275·307-325·349·374의 수집 중 기록 저장.
  - snapshot의 `redactions` 칸은 항상 빈 값으로 남겨도 된다(13이 쓸 자리).
- `packages/core/src/testing/fixtures.ts`:
  - 지운다: L4·L9 import, L288-293 `redactions` override, L326-342 기록 만들기.
  - 결과는 `{ ...message, id }`다.
- `packages/core/src/testing/contracts/session-store.ts`:
  - L317-332: `redactions`를 뺀다.
  - L355-410: 두 사례를 지운다. 대신 "수집은 `redactions`를 쓰지 않는다"는 사례를 하나 둘 수 있다. 다만 포트에 읽기가 없으니, 건수 키가 없는 것으로 충분하다.
- `packages/core/test/contracts.test.ts`:
  - L571: `redactions`를 뺀다.
  - L583-604: 음성 가짜(기록 재삽입)를 지운다.
- `packages/core/test/sessions-ingest.test.ts`:
  - L405-539 describe를 "본문과 대상을 원문 그대로 저장"으로 뒤집는다.
  - "records the kind…"와 "masks nothing…"은 지운다.
  - L890·931의 `redactions`를 뺀다. L3 import를 정리한다.
- `packages/core/test/capture-scan.test.ts` L345·388 -- `redactions`를 뺀다.
- `packages/sqlite/test/session-store.test.ts`:
  - L117-164: 사례를 "수집 뒤 `redactions` 0행"으로 바꾼다.
  - L166-200: FK 사례는 남기고 주석만 고친다. L4 import를 정리한다.
- `apps/cli/src/commands/sessions-ingest.ts` -- L37-43 머리 주석과 L72 메타 `output`에서 `redactions`를 뺀다(한국어).
- `apps/cli/test/sessions-ingest.test.ts`:
  - 정리한다: L20 import, L99 타입, L404·759·830·1447의 `redactions: 0`.
  - L847-1022 describe를 원문 저장으로 뒤집는다. 비밀은 저장본에 그대로 있고 `redactions`는 0행이다. 다시 수집하면 `{0,0}`이고 건수가 같다.
  - 헬퍼: `installedHome`, `runBrain`, `stopPayload`, `rowCounts`, `rowDump`, `storedMessages`, `storedToolNotes`, `databaseIn`, 지역 `secretsTranscriptIn`.
- `packages/claude-code/test/fixtures/secrets-session.jsonl` -- fixture를 넓힌다. 지어낸 값만 쓴다:
  - 사용자 본문에 `비밀번호 …`·`비밀번호가 …`·`password: Pa!ss2024`를 더한다.
  - 어시스턴트 본문(L6)에 `let token = parse(input);`·`secret: see the README`·`{"token": 123}`·`NODE_ENV=production`을 더한다.
  - 500자를 넘는 Bash `tool_use`를 하나 더한다. `sk-` 키가 500번째 글자에 걸치게 하고, 그 `tool_result`도 둔다.
  - 그러면 도구 메모는 2개가 된다. 이 fixture를 쓰는 단정(건수)을 맞춘다. 이 fixture는 `apps/cli/test/sessions-ingest.test.ts`만 쓴다.
- `packages/core/src/domain/secret-patterns.ts`:
  - `VALUE`(L65)와 영어 키워드(L165-178), 한국어 키워드(L181-190)를 Always대로 고친다.
  - `accept`는 지금 `(matched)`만 받는다. 값 모양 규칙에는 매치 뒤 문자(`(`, ` 단어`)와 따옴표 여부가 필요하므로 인자를 넓힌다.
  - `SECRET_PATTERN_VERSION = '2'`.
  - 머리 주석의 "batch를 만들 때 가린다"를 출력 함수로 고친다.
  - 마커 건너뛰기("마커 안에 완전히 들어가면 버림")와 코드 포인트 변환은 그대로 둔다(2.9 Implementation Notes).
- `packages/core/test/secret-patterns.test.ts` -- 다음을 더한다:
  - 버전 2 사례: 위 매트릭스의 패턴 행
  - 회귀 표에 세션 토큰·ISO 시각
  - `password: hunter2x, 다음`이 여전히 `,`에서 멈추는 것
- `packages/core/src/output/`(신규: `mask.ts`, `codecs.ts`, `index.ts`) -- Always의 함수들, `OUTPUT_CODECS`, `TOOL_NOTE_TARGET_LIMIT`(또는 `domain/tool-note.ts`에 상수). `src/index.ts`에서 명시적으로 export한다. 이 파일은 모듈마다 이름을 적어 export한다.
- `packages/core/src/envelope.ts` -- `okEnvelope`·`errorEnvelope`가 `maskOutputValue`를 건다.
- `packages/core/test/output-codecs.test.ts`(신규) -- 다음을 단위 시험한다:
  - 깊은 가리기(입력 불변)
  - 잘린 꼬리(상한 미만은 그대로, 상한 이상의 끝 토큰, 마커 뒤는 비어 있음)
  - 멱등
  - 엔벨로프 `error.retry.args` 가리기
- `packages/claude-code/src/tool-target.ts` L54 -- `TOOL_TARGET_LIMIT = TOOL_NOTE_TARGET_LIMIT`. `@second-brain/core`에서 import한다(이미 의존한다).
- `apps/cli/src/dispatch.ts` -- 출력 자리마다 Always대로 코덱을 건다:
  - L393-402: sink
  - L419-424: hook 예외 줄
  - L429-433: hook 실패 줄
  - L435-453: text 줄·실패 줄·warningLines
  - L716: drain 오류 줄
  - CLI는 `second_brain`에서만 import한다(`packages/second_brain/test/boundaries.test.ts`). `second_brain`은 Core를 `export *` 한다.
- `apps/cli/src/commands/setup-run.ts` L58-60, `apps/cli/src/install.ts` L154-156 -- `encodeTextLine`을 거친다.
- `apps/cli/test/output-codecs.test.ts`(신규) -- 계약 테스트와 sink 검사다:
  - sink 검사는 `readdirSync(..., {recursive: true})`로 원천 파일을 읽는다. 선례는 `tooling/bootstrap/test/bootstrap.test.ts` L668이다.
  - 모델은 레지스트리 순회식 `apps/cli/test/command-meta.test.ts`다.
- 영향 확인:
  - `apps/cli/test/envelope.test.ts`, `dispatch.test.ts`, `guide-schema` 시험: 엔벨로프 데이터 단정이 가려진 값과 어긋나면, 예시 문자열이 비밀 모양인지 본다.
  - `apps/cli/test/output-language.test.ts`: 새 한국어 문구.
- `_bmad-output/personal-brain/deferred-work.md`:
  - 2.9 deferred 두 항목을 해결로 고친다.
  - "도구 대상 잘림 조각"을 해결로 고친다.
  - 출력 가리기의 남은 위험(아래)을 적는다.
- `README.md` -- 짧은 마스킹 B 절. L363의 오류 문장 가림은 그대로 둔다.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/{sessions/ingest,sessions/spool-ingest,domain/ingest-batch,domain/index,ports/store}.ts`, `packages/sqlite/src/sessions.ts`, `packages/core/src/testing/{fakes/store,fixtures,contracts/session-store}.ts` -- 수집 경로에서 가리기와 `redactions` 쓰기를 뺀다 -- 저장은 원문.
- [x] 위를 단정하던 시험(`packages/core/test/{contracts,sessions-ingest,capture-scan}.test.ts`, `packages/sqlite/test/session-store.test.ts`) -- 원문 저장·기록 없음으로 뒤집는다.
- [x] `packages/core/src/domain/secret-patterns.ts`, `packages/core/test/secret-patterns.test.ts` -- 패턴 버전 2와 그 사례.
- [x] `packages/core/src/output/*`, `packages/core/src/envelope.ts`, `packages/core/src/index.ts`, `packages/claude-code/src/tool-target.ts`, `packages/core/test/output-codecs.test.ts` -- 출력 함수, 코덱, 등록부, 잘린 꼬리, 상수 이동.
- [x] `apps/cli/src/{dispatch,install}.ts`, `apps/cli/src/commands/{setup-run,sessions-ingest}.ts` -- 모든 출력 자리가 코덱을 거친다.
- [x] `packages/claude-code/test/fixtures/secrets-session.jsonl`, `apps/cli/test/sessions-ingest.test.ts`, `apps/cli/test/output-codecs.test.ts` -- 티켓 verify(CLI 수준), 계약과 sink 검사.
- [x] `README.md`, `_bmad-output/personal-brain/deferred-work.md` -- 문서.

**Acceptance Criteria:**
- Given 임시 home에서 `setup run --yes`를 했다. When 비밀 fixture로 `brain sessions ingest claude-code --json`을 부르면, then 다음이 모두 맞다:
  - `messages.body`·`tool_notes.target`이 fixture의 그 칸과 글자 단위로 같다(대상은 첫 줄 500자).
  - `redactions`는 0행이다.
  - `data.inserted`는 `{messages, toolNotes}`뿐이다.
- Given 같은 저장본. When 등록된 모든 출력 코덱으로 내보내면, then 출력에 fixture의 비밀값과 잘린 키 앞부분이 없다. 평범한 코드·문장·`NODE_ENV=production`은 그대로다.
- Given sink 표에 없는 파일이 stdout에 쓴다. When sink 검사를 돌리면, then 실패하고 그 파일 이름을 댄다(음성 사례는 원천을 바꾸지 않고 검사 함수에 가짜 파일 목록을 넣어 확인한다).
- Given 비밀 모양 문자열이 든 실패. When CLI가 `--json`이나 text 모드나 hook 모드로 그것을 내면, then stdout·stderr 어디에도 그 값이 없다.
- Given `pnpm test`. When 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

- `TOOL_NOTE_TARGET_LIMIT`은 `packages/core/src/domain/tool-note.ts`에 두었다(플랜이 준 두 자리 중 둘째). 그 칸의 도메인 사실이고, `output/mask.ts`는 그것을 읽기만 한다. `src/index.ts`는 `domain/index.js`를 `export *` 하므로 output 블록에서 다시 export하지 않는다(중복 이름).
- `accept`의 둘째 인자는 `SecretMatch { value, quoted, after }`다. `quoted`는 영어 키워드 패턴에 이름을 붙인 그룹 `(?<open>["'])`가 매치에 참여했는지이고, `after`는 span 뒤 24자다. `luhnPasses`는 인자를 하나만 받아 그대로 쓴다.
- 닫는 괄호 떼기는 패턴의 `trimClosers` 플래그다(두 키워드 패턴만). `accept`보다 먼저 돌아서, 모양 규칙이 보는 값은 이미 다듬은 값이다 — `{"token": 123}`이 "숫자만"으로 보이는 이유다.
- 값 문자 집합에서 `:`를 뺀 덕에 멱등이 더 단단해졌다. 가린 표시 `[REDACTED:api_key]`가 이제 값 하나로 잡히고, 그 구간은 마커 안에 **완전히** 들어가므로 2.9의 마커 건너뛰기가 그대로 버린다(버전 1에서는 `[REDACTED`까지만 잡혔다).
- 한국어 조사 셋은 문자 클래스 `[은는이가을를도]`다. 값이 한글로 시작하면 매치하지 않는 2.9 규칙이 그대로 있어서, 공백 하나만으로도 "비밀번호는 바꿨어"는 걸리지 않는다.
- `maskOutputValue`는 평범한 객체와 배열만 복사하고 그 밖(`Date`, 클래스 인스턴스)은 그대로 돌려준다. 다시 만들 방법이 없고, 흉내 내면 instant가 `{}`가 된다.
- 엔벨로프는 `okEnvelope`·`errorEnvelope` 안에서 가린다. `now`는 가리지 않는다(시계의 값이고 호출자의 글이 아니다). `errorEnvelope`는 `error` 전체를 한 번에 걸어서 `retry.args`까지 덮는다 — CLI의 `retry_argv`는 그 뒤에 만들어지므로 자동으로 가려진 호출을 찍는다.
- 잘린 꼬리의 멱등: 첫 번째 결과는 마커로 끝나므로, 다시 걸면 "마지막 마커의 끝"이 문자열 끝이 되어 토큰 길이가 0이고 아무것도 하지 않는다.
- sink 검사는 순수 함수 `sinkProblems(writers, table, codecNames)`로 떼어 두었다. 음성 사례 셋(표에 없는 파일, 없는 코덱 이름, 더는 쓰지 않는 행)은 저장소에 파일을 만들지 않고 가짜 목록으로 돌린다. 실제 스캔은 `apps/*/src`·`packages/*/src`를 `readdirSync(..., {recursive: true})`로 읽고, 찾은 파일이 0개면 실패한다(조용히 통과하는 유일한 길이다).
- 비밀 fixture의 긴 Bash 명령은 `echo ` + `x`×482 + 공백 + `sk-BBBBBBBBBBBBBBBBBBBB && echo done`이다. parser의 500자 자르기가 키를 `sk-BBBBBBB`에서 끊으므로 저장 대상은 그것으로 끝나고, 출력에서는 `[REDACTED:truncated]`가 된다. fixture 상수(비밀 목록, 잘린 조각, 회귀 목록)는 `apps/cli/test/secrets-fixture.ts`에 모아 두 시험이 어긋나지 않게 했다.
- 계약 시험이 fixture 문자열을 코덱 출력에서 찾을 때는 JSON 이스케이프한 모양도 함께 본다(`{"token": 123}`은 엔벨로프 안에서 `{\"token\": 123}`이다).
- `packages/core/src/testing/fakes/store.ts`의 snapshot `redactions`는 칸만 남겼고 늘 비어 있다(2.13이 쓸 자리). 계약 사례 둘은 "`inserted`에 키가 둘뿐"이라는 사례 하나로 바뀌었고, 음성 가짜도 그에 맞게 `redactions` 키를 되살리는 store가 되었다.

## Plan Change Log

## Review Triage Log

### 2026-10-20 — Review pass
- verdicts: 7 findings — high 0, medium 3, low 4, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 값 모양 규칙 (c)가 `\s+`로 다음 줄의 단어까지 "문장"으로 봄. `secret: hunterpass` 다음 줄이 단어로 시작하면 가려지지 않고, hook 코덱(`\n`으로 이음)과 text 코덱의 결과가 갈림 — 재현됨. 같은 줄의 공백·탭만 보도록 고쳤다. `secret: hunterpass\nok done`이 가려지는 사례를 더했고, 따옴표 없는 영문자 값의 놓침을 deferred-work의 남은 위험에 적었다.
  - `[medium]` `[patch]` 호출 모양 규칙 (a)가 값의 앞부분만 봄. 그래서 `token=foo(bar)baz`가 통째로 나감 — 재현됨. 호출이 값 전체(`)`로 끝남)여야 하도록 고쳤다. `let token = parse(input);`는 그대로 두는 사례를 더했다.
  - `[low]` `[reject]` hook이 아닌 명령에서 예외가 나면 Node가 메시지와 스택을 stderr에 그대로 찍음 — 실제다. 그러나 이 길은 버그(예외)일 때만 열리고, 그 동작은 이번 변경 전부터 있었다. 고치려면 `bin.ts`에 잡기 분기를 더해야 하고 스택을 잃는다. 일상 사용에서 만날 일이 드물다.
  - `[medium]` `[patch]` dispatcher가 줄을 코덱에 통과시키는지 단정하는 시험이 없음. 그래서 AC "비밀 모양 실패가 stdout·stderr에 없음"을 자동으로 지키는 것이 없었음 — 확인됨. `apps/cli/test/output-codecs.test.ts`에 사례 다섯을 더했다. 주입한 stdout·stderr로 `--json`, text(message·hint), hook, hook 예외, 명령 text 줄을 본다. 구현 에이전트가 wrapper를 빼 보는 변이 확인을 했고, 두 사례가 빨갛게 된다(나머지 셋은 엔벨로프가 이미 가려서 초록이다).
  - `[low]` `[reject]` `maskSecrets`가 이제 쓰지 않는 `spans`(코드 포인트 표, 구간마다 SHA-256)를 출력마다 만듦 — 실제 비용이다. 다만 매치가 있을 때만 들고 2.9 측정으로 240KB에 약 1ms다. 고치려면 텍스트 전용 경로를 새로 두는 리팩터가 된다.
  - `[low]` `[patch]` `packages/core/test/sessions-ingest.test.ts`에 쓰지 않는 `SECRET_PATTERN_VERSION` import가 남음 — 지웠다.
  - `[low]` `[patch]` deferred-work의 `SECOND_BRAIN_CAPTURE` 행이 아직 "마스킹 규칙으로 굳는다"고 하고, 17을 관문으로 적음 — parser 쪽 이유만 남기고 관문을 19·20으로 고쳤다.

### 2026-10-20 — Follow-up review pass (bmad-review: adversarial·edge-case-hunter·verification-gap)
- verdicts: 30 findings — 패치 24, 미룸 4(deferred-work), 거부 1, 다른 패치에 흡수 1
- 패치(패턴, 버전 2 안에서):
  - 호출로 판정해 거부한 매치 안쪽을 다시 훑는다. `decrypt(password=…)`의 값을 가린다.
  - 호출 판정을 원문 위에서 한다. 같은 줄에서 괄호가 닫히고 토큰이 끝나야 호출이다. `compute(a, b)`는 그대로 둔다.
  - 따옴표 값은 같은 줄의 닫는 따옴표까지다.
  - 한국어 공백 구분자는 같은 줄(`[ \t]+`)이고 `비밀번호·패스워드`만 쓴다. 공백 구분자 뒤 영문 단어 다음에 단어가 이어지면 가리지 않는다.
  - `trimClosers`를 선형으로 바꿨다(괄호 5만 개: 2.3초 → 3ms).
  - 영어 키워드 값이 자리표시자(`null`·`ok`·`(none)`·`***`·`<…>`·`$NAME`)면 가리지 않는다.
- 패치(출력):
  - `maskOutputValue`가 평범하지 않은 객체를 JSON이 내는 모양으로 가린다(`toJSON`, 자기 속성).
  - 가리기로 `retry.args`가 바뀌면 `retry`를 뺀다.
  - 코덱이 도구 메모 규칙을 스스로 건다(`OutputProbe.toolNotes`, `sessionForOutput`). 계약 시험은 원문 행으로 견본을 만들고, 키워드가 아닌 셸 이름(`MY_CREDENTIAL=`) 사례를 더했다.
- 패치(CLI):
  - `bin.ts`가 예외를 잡아 스택을 줄마다 `encodeTextLine`으로 내고 1로 끝난다.
  - 출력 자리 검색을 넓혔다(별칭·`writeSync`·`pipe`). commander 도움말과 @clack 질문은 면제 이유를 적었다.
  - 설치기 log, `setup run` log, drain 오류 줄에 변이로 확인한 시험을 더했다.
- 패치(시험·문서):
  - 저장 대상 기대값을 리터럴로 고정했다.
  - 상한 500을 고정하는 시험을 더했다.
  - README에 `inserted` 모양·대상 자르기·면제 출력을 적었다.
- 미룸(`deferred-work.md`에 기록):
  - 출력에 패턴 버전 표기 → 미러·복제·내보내기 에픽
  - `redactions`가 있는 메시지를 가리켜야 한다는 포트 계약 → 2.13
  - 잘림을 길이로 추론하고 첫 줄 자르기를 덮지 못함 → 18·23의 `tool_notes` 잘림 칸
  - 앞으로의 읽기는 `sessionForOutput`을 부를 것
- 거부:
  - 공백도 마커도 없는 500자 대상을 통째로 가리는 것(edge 6). 잘린 단일 토큰은 JWT 같은 비밀 자체일 수 있다. 가림은 출력에서만 일어나므로 그대로 둔다.
- 다른 패치에 흡수:
  - "호출 전체는 그대로 둔다" claim(edge 12). 호출 판정 패치로 참이 됐다.
- 검증: `pnpm test` 62파일 1981건 통과. 구현 에이전트가 고친 항목마다 변이 확인을 했다.

## Design Notes

엔벨로프를 만들 때 가리는 이유는 이렇다. 엔벨로프는 CLI·소켓·MCP가 공유하는 하나의 생성 지점이다. 그래서 새 명령과 새 표면이 자동으로 덮인다. 쓰는 쪽(stdout)에서 JSON 문자열을 통째로 가리면 이스케이프된 문자열과 키 이름이 패턴에 섞인다. 그래서 값 단위로 가린다.

text 모드는 명령마다 손으로 만든 줄이라 엔벨로프를 지나지 않는다. 그래서 dispatcher의 출력 자리에서 줄마다 `encodeTextLine`을 건다. 출력 자리가 몇 개 안 되므로 sink 검사가 새 자리를 잡는다.

```ts
// core/output/codecs.ts — shape only
export const OUTPUT_CODECS: readonly OutputCodec[] = [
  { name: 'envelope', render: (p) => JSON.stringify(okEnvelope(probeClock, probeData(p))) },
  { name: 'hook', render: (p) => [encodeHookOutput({ systemMessage: p.texts.join('\n') }), ...p.texts.map(encodeHookLine)].join('\n') },
  { name: 'text', render: (p) => p.texts.map(encodeTextLine).join('\n') },
];
// probe.texts는 본문들과 toolNoteForOutput을 거친 대상들이다.
```

남은 위험(문서에 적는다):
- 출력 가리기는 패턴이 아는 것만 가린다. 저장소 파일에는 비밀이 원문으로 있다. 이것을 지키는 것은 AD-10(권한 0600, 동기화 폴더 금지)이다.
- 잘린 꼬리 규칙은 상한에 닿은 대상의 마지막 토큰을 가린다. 그 토큰이 평범한 단어여도 가린다(출력에서만).
- 따옴표 없는 숫자만의 값(`password: 1234`)은 영어 키워드에서는 가리지 않는다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과. Postgres 통합은 `BRAIN_TEST_DATABASE_URL`이 필요하다. 없으면 `packages/postgres`만 기준선과 같은 이유로 실패해도 된다.
- `grep -rn "maskSecrets" packages/core/src/sessions` -- expected: 결과 없음.

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME`에서 `node apps/cli/dist/install.js --yes`를 하고, 비밀 fixture를 Stop 페이로드로 `sessions ingest claude-code --json`에 넣는다.
- 그다음 `sqlite3 <tmp>/brain.db "select body from messages; select target from tool_notes; select count(*) from redactions"`로 확인한다. 원문이 있고 0행이어야 한다.

**Results (2026-10-20):**
- `pnpm test`(build → typecheck → vitest): 61파일 1933건 통과. Postgres 통합도 포함해 돌았다. 리뷰 패치 뒤 메인 세션이 다시 돌려 61파일 1940건 통과.
- `grep -rn "maskSecrets" packages/core/src/sessions`: 결과 없음.
- 수동 확인(임시 `SECOND_BRAIN_HOME`, 실제 `~/.claude`·`~/.second_brain`은 건드리지 않음):
  - `install.js --yes` → 비밀 fixture 수집 → `inserted {messages: 2, toolNotes: 2}`(셋째 키 없음).
  - `messages.body`·`tool_notes.target`이 transcript 그대로였고 `[REDACTED:` 가 어디에도 없었다. `select count(*) from redactions` = 0.
  - 비밀 모양 인자를 준 실패를 hook 모드(stderr), `--json`, text 모드로 각각 냈고 셋 다 `[REDACTED:api_key]`였다.
- 임시 폴더는 확인 뒤 지웠다.

## Auto Run Result

**요약:** 마스킹 B로 바꿨다. 수집은 메시지 본문과 도구 메모 대상을 원문 그대로 저장하고, `redactions`에 쓰지 않는다. 비밀은 Brain 밖으로 나갈 때 Core 출력 코덱이 가린다.
- 엔벨로프는 `okEnvelope`·`errorEnvelope`가 만들 때 모든 문자열 값을 가린다. `retry.args`도 포함이다.
- CLI의 text 줄·경고 줄·실패 줄·설치 로그는 `encodeTextLine`을, hook 경로의 stderr 줄은 `encodeHookLine`을 거친다.
- 시작 맥락(epic 3)이 쓸 `encodeHookOutput`도 등록부(`OUTPUT_CODECS`: envelope·hook·text)에 있다.
- 도구 메모를 돌려주는 읽기는 `toolNoteForOutput`을 먼저 건다. 셸 `NAME=value` 규칙에, 500자 상한에 닿은 대상의 끝 토큰을 `[REDACTED:truncated]`로 가리는 규칙을 더했다(#21).
- 패턴 버전은 `'2'`다. 값은 `!`·`?`·`.`·`:`·괄호를 품고, 짝 없는 닫는 괄호는 뗀다. 한국어는 "비밀번호 X"·"비밀번호가 X"도 잡는다. 영어 키워드는 따옴표 없는 값일 때만 모양 규칙(호출 전체, 숫자만, 같은 줄의 영어 문장)으로 과잉 가림을 줄인다.

**바뀐 파일:**
- `packages/core/src/sessions/{ingest,spool-ingest}.ts`, `domain/{ingest-batch,index}.ts`, `ports/store.ts`, `packages/sqlite/src/sessions.ts`, `testing/{fakes/store,fixtures,contracts/session-store}.ts` — 수집 경로의 가리기와 `redactions` 쓰기를 뺌
- `packages/core/src/domain/secret-patterns.ts` — 패턴 버전 2
- `packages/core/src/domain/tool-note.ts` — `TOOL_NOTE_TARGET_LIMIT`(500). `packages/claude-code/src/tool-target.ts`가 이 값을 읽음(동작은 그대로)
- `packages/core/src/output/{mask,codecs,index}.ts`(신규), `envelope.ts`, `index.ts` — 출력 가리기 함수, 코덱, 등록부
- `apps/cli/src/{dispatch,install}.ts`, `commands/{setup-run,sessions-ingest}.ts` — 모든 출력 자리가 코덱을 거침. 명령 메타 문구
- 시험:
  - `packages/core/test/{output-codecs(신규),secret-patterns,sessions-ingest,contracts,capture-scan}.test.ts`
  - `packages/sqlite/test/session-store.test.ts`
  - `apps/cli/test/{output-codecs(신규),sessions-ingest}.test.ts`, `secrets-fixture.ts`(신규)
  - `packages/claude-code/test/fixtures/secrets-session.jsonl`(넓힘, 지어낸 값)
- `README.md`(마스킹 B 절), `_bmad-output/personal-brain/deferred-work.md`(2.9 deferred 둘과 #21을 해결로 표시, 남은 위험, 낡은 관문 문구)

**리뷰:** quick 1회, 7건(medium 3, low 4)이다.
- 패치 5건(medium 3, low 2): 규칙 (c)가 다음 줄로 넘어감, 호출 모양 규칙이 앞부분만 봄, dispatcher 출력 가리기의 자동 시험 없음, 남은 import, deferred-work 낡은 문구.
- 미룸 0건.
- 거부 2건(low):
  - hook이 아닌 명령의 예외 스택이 가리지 않고 찍힘. 버그일 때만 열리는 길이고 전부터 있던 동작이며, 고치면 스택을 잃는다.
  - 쓰지 않는 `spans` 계산 비용. 매치가 있을 때만 들고 약 1ms다. 고치려면 리팩터가 필요하다.

**후속 리뷰 권고:** true(medium 패치 3건). 확인되지 않은 위험이 하나 남았다. 패턴 버전 2의 값 집합을 넓히고(`!?.:`·괄호, 한국어 공백 구분자) 영어 모양 규칙을 넣은 것은 quick 렌즈 하나만 봤다. 엣지 케이스 렌즈로 두 가지를 다시 볼 것을 권한다. 하나는 실제 대화에서 새로 생기는 과잉 가림이고(엔벨로프가 모든 문자열을 지나므로 경로·명령 예시도 해당), 다른 하나는 모양 규칙이 놓치는 비밀 모양이다.

**검증:**
- 리뷰 패치 뒤 메인 세션에서 `pnpm test`를 돌려 61파일 1940건이 통과했다(Postgres 통합 포함).
- `grep -rn "maskSecrets" packages/core/src/sessions`는 결과가 없었다.
- 매트릭스 9행은 모두 실행된 시험이 덮는다. 원문 저장·코덱 출력·과잉 가림·셸 규칙·한국어와 끊김·잘린 꼬리·멱등·엔벨로프 ID·미등록 출력이다.
- 수동 확인(임시 `SECOND_BRAIN_HOME`)은 Verification의 Results에 있다. 실제 `~/.claude`·`~/.second_brain`은 건드리지 않았다.

**남은 위험:**
- `brain.db`와 `-wal`·`-shm`에 비밀이 원문으로 있다. 이것을 지키는 것은 AD-10(권한 0600, 동기화 폴더 금지)이고, 저장본에서 지우는 길은 2.13 `messages redact`다.
- 영어 키워드의 따옴표 없는 숫자만의 값(`password: 1234`)과, 같은 줄에 영어 단어가 이어지는 영문자만의 값(`secret: hunterpass and done`)은 가리지 않는다.
- 상한에 닿은 도구 메모 대상은 끝 토큰을, 평범한 단어여도 가린다(출력에서만).
- hook이 아닌 명령에서 예외가 나면 Node가 메시지를 가리지 않고 stderr에 찍는다(거부한 지적).
- `tooling/bootstrap`·`plugin/`의 출력은 Core를 쓸 수 없어 sink 검사 밖이다. 정적 문구와 경로만 낸다.
