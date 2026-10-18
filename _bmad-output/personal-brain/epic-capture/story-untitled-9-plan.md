---
title: '저장 전 비밀 마스킹: 버전 있는 패턴 목록과 같은 트랜잭션의 redactions'
type: 'feature'
ticket: '9'
created: '2026-10-18'
status: 'built'
baseline_revision: '61b4596eece61f8c8a181fc0d78a0fe1ebc26eee'
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
deferred:
  - summary: >-
      영어 키워드 패턴(password/secret/token/api_key/access_key)의 값에 모양 검사가 없어 평범한 코드·문장(`let token = parse(input);`, `secret: see the README`, `{"token": 123}`)이 가려진다.
    evidence: |-
      리뷰어가 빌드된 maskSecrets로 재현. 메시지는 저장 뒤 바뀌지 않으므로 과잉 가림은 되돌릴 수 없다. 값 모양 규칙(최소 길이, 식별자·함수 호출·숫자만 제외 등)은 plan에 없어 사람이 정해야 한다. 실제 수집은 2.14에서 켜지므로 그 전에 정하면 저장된 데이터에 영향이 없다. 바꾸면 SECRET_PATTERN_VERSION을 올린다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: medium
  - summary: >-
      한국어 키워드 패턴이 `비밀번호 X`, `비밀번호가 X`, `비밀번호를 X로` 같은 흔한 표현을 놓친다(구분자가 `:`·`=`·`은`·`는`뿐).
    evidence: |-
      리뷰어가 빌드된 maskSecrets로 재현(spans 빈 배열). plan과 inputs A2의 정규식 그대로다. 구분자를 넓히면 과잉 가림이 늘어난다. 2.14 전에 사람이 정한다. 바꾸면 SECRET_PATTERN_VERSION을 올린다.
    location: >-
      packages/core/src/domain/secret-patterns.ts
    severity: medium
---

<intent-contract>

## Intent

**Problem:** 수집은 메시지 본문과 도구 메모 대상을 Harness가 준 그대로 저장한다. 대화에 붙여 넣은 API 키·비밀번호·개인 키가 DB에 그대로 남는다. AD-11의 "Core의 버전 있는 패턴 목록"도, 마스킹 함수도, 수집이 `redactions`를 쓰는 경로도 없다.

**Approach:** Core에 순수 함수로 된 패턴 목록(`SECRET_PATTERN_VERSION`)과 마스킹 함수, 의존성 없는 SHA-256을 둔다. `sessions.ingest` use case는 batch를 만들 때 본문과 대상을 가리고, 메시지마다 가리기 기록(id·위치·종류·해시·패턴 버전)을 batch에 실어 보낸다. Store는 실제로 들어간 메시지의 기록만 같은 `withWrite` 트랜잭션에서 `redactions`에 넣는다. 가리기를 batch를 만들 때 하므로, 나중에 spool(2.10)이 batch를 저장해도 비밀은 들어가지 않는다.

## Boundaries & Constraints

**Always:**
- **패턴 목록**(`packages/core/src/domain/secret-patterns.ts`, 순수 함수와 상수): 패턴마다 `kind`(영어 snake_case), 정규식(`gu`+`d` 플래그), 가릴 범위를 둔다. 가릴 범위는 매치 전체이거나, 이름을 남기는 패턴에서는 값 그룹이다. 패턴을 바꾸면 `SECRET_PATTERN_VERSION`(문자열, 처음은 `'1'`)을 올린다. 목록:
  - 제공자 토큰(매치 전체를 가림). 앞에 `[A-Za-z0-9_]`가 오지 않아야 한다(lookbehind).
    - `api_key`: `sk-[A-Za-z0-9_-]{16,}`
    - `stripe_key`: `sk_(live|test)_[A-Za-z0-9]{16,}`
    - `github_token`: `(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`와 `github_pat_[A-Za-z0-9_]{20,}`
    - `aws_access_key`: `(AKIA|ASIA)[0-9A-Z]{16}`
    - `slack_token`: `xox[baprs]-[A-Za-z0-9-]{10,}`
    - `google_api_key`: `AIza[0-9A-Za-z_-]{35}`
    - `jwt`: `eyJ…\.eyJ…\.…`(세 조각, 각 10자 이상)
    - `bearer_token`: `Bearer\s+` 뒤 20자 이상. 대소문자를 가리지 않고, 값만 가린다.
  - `private_key`: `-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----`부터 짝이 되는 `-----END …-----`까지 블록 전체를 가린다. END가 없으면 텍스트 끝까지 가린다.
  - `url_credentials`: `scheme://user:password@`에서 password만 가린다.
  - `password`(영어 키워드, 값만 가림): `(password|passwd|secret|token|api[_ -]?key|access[_ -]?key)`, 대소문자 무시.
    - 앞에 영숫자가 오지 않아야 한다. `_`는 와도 되므로 `DB_PASSWORD=`도 잡는다.
    - 그 뒤에 따옴표 하나(선택), `\s*[:=]\s*`, 따옴표 하나(선택)가 오고, 그다음이 값이다.
  - `password`(한국어 키워드, 값만 가림): `(비밀번호|암호|패스워드)\s*[:=은는]\s*` 뒤의 값. 한글 앞뒤에 `\b`를 쓰지 않는다. 값이 한글로 시작하면 매치하지 않는다("비밀번호는 바꿨어"는 그대로 둔다).
  - 값(키워드 둘과 셸)은 `[^\s,.;:!?，。、'"\`]+`이다. 공백·구두점·따옴표에서 멈춘다.
  - `resident_registration_number`: `\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-?[1-8]\d{6}`. 앞뒤에 숫자가 오지 않아야 한다.
  - `phone_number`: `01[016789]-?\d{3,4}-?\d{4}`. 앞뒤에 숫자가 오지 않아야 한다.
  - `card_number`: 15~16자리 숫자. 첫 자리는 3~6이고, 4자리 묶음 사이에 공백이나 `-`가 올 수 있다. 숫자만 모아 Luhn 검사를 통과할 때만 가린다. 앞뒤에 숫자가 오지 않아야 한다.
  - `shell_assignment`(도구 메모 대상에만 씀): inputs A5 정규식 그대로이고, 값만 가린다.
- **마스킹 함수** `maskSecrets(text, field: 'body' | 'tool_target'): { text, spans }`:
  - 원문에 모든 패턴을 돌려 가릴 구간을 모은다.
  - 구간을 시작 위치 순으로 정렬하고, 겹치는 구간은 합친다(합집합). 종류는 먼저 시작한 구간의 것이고, 시작이 같으면 더 긴 구간의 것이다.
  - 구간마다 `[REDACTED:<kind>]`로 바꾼다.
  - `spans`는 `{start, end, kind, removed}`다. 위치는 **마스킹 전 원문 위의 코드 포인트** `[start, end)`다(AD-11, Conventions). UTF-16 인덱스가 아니다.
  - 같은 입력에는 같은 출력이 나온다. 가린 결과를 다시 넣으면 바뀌는 것이 없다(표시 문자열은 어떤 패턴에도 걸리지 않는다).
- **해시**: `contentHash`는 `sha256:<소문자 hex>`다. 지운 텍스트의 UTF-8 바이트로 만든다. Core는 `node:crypto`·`TextEncoder`를 쓸 수 없다(`types: []`, lib es2024, AD-1). 그래서 `packages/core/src/domain/sha256.ts`에 의존성 없는 구현(UTF-8 인코딩 포함)을 둔다.
- **use case**(`ingest.ts`): `messages`·`toolNotes`를 만드는 자리에서 가린다.
  - 메시지는 `body`를 가린 본문으로 바꾸고 `redactions: IngestRedaction[]`을 단다. 기록마다 `id: idGen.next()`, `start`, `end`, `kind`, `contentHash`, `patternVersion`을 두고, `occurredAt`은 batch의 `ingestedAt`이다.
  - 도구 메모는 `target`만 가리고 기록은 없다(아래 Decision).
  - 꼬리표 계산(`messages[0].cwd`)은 바뀌지 않는다.
- **Store 규칙**(포트 주석과 계약): 가리기 기록은 그 메시지가 이번 호출에서 실제로 들어갈 때만, 같은 트랜잭션에서 넣는다. 이미 있던 메시지(다시 수집)의 기록은 버린다. `IngestCounts`에 `redactions`를 더한다. SQLite와 메모리 가짜가 같게 한다.
- `Redaction` 도메인 타입에 `patternVersion: string | null`을 더한다(2.6 Decision이 이 스토리에 넘긴 것).
- 가려지면 안 되는 것(회귀 표): git SHA(40 hex), UUIDv7, `sha256:`+64 hex, 이메일, 사설 IP(`10.0.12.7`, `192.168.0.1:8080`), 파일 경로(`/Users/demo/repo/src/a.ts`, `packages/core/src/index.ts`), npm 패키지명(`@scope/name`, `lodash@4.17.21`), `max_tokens: 4096`이 아닌 `max_tokens` 같은 이름, `NODE_ENV=production`(본문에서), 한국어 문장("비밀번호는 바꿨어", "암호화는 AES로 한다"), 13자리 epoch 밀리초(`1760745600000`).
- 새로 쓰는 사람이 읽는 문장은 한국어다. 코드·kind·주석은 영어다.
- 시험의 비밀값은 모두 지어낸 것이다(실제 키 모양이지만 무효). 회사 이름·실제 계정은 쓰지 않는다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 도구 메모 대상을 가린 것은 `redactions` 행을 남기지 않는다. 대상의 값은 가린다. 0004의 메시지 가리기 행은 위치가 **본문** 위의 구간이어야 하고, 도구 메모를 가리킬 칸이 없다. 남기려면 마이그레이션을 새로 만들어야 하는데, 마이그레이션은 앞으로만 가므로 되돌리기 어렵다. 다른 안: 0005에 `redactions.tool_note_id` 추가; 그 메시지 행에 대상 위치를 적음(위치의 뜻이 어긋남). `deferred-work.md`에 남긴다.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): `shell_assignment`(대문자 `NAME=value`의 값)는 도구 메모 대상에만 쓰고 본문에는 쓰지 않는다. 메시지는 저장 뒤 바뀌지 않으므로, 본문의 `NODE_ENV=production` 같은 평범한 설정이 지워지면 되돌릴 수 없다. 본문의 비밀 이름 대입(`DB_PASSWORD=…`, `API_KEY=…`)은 키워드 패턴이 잡는다. inputs A5도 이 패턴을 넣을 곳을 "tool_notes 저장 전"으로 적었다. 다른 안: 본문에도 씀.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): WeKnora의 "40자 이상 불투명 토큰" 규칙은 넣지 않는다. 이 규칙은 git SHA·sha256을 지우므로 A3 회귀와 충돌한다. 카드 번호는 Luhn과 앞자리 조건을 붙여 넣고, 영어 키워드에서 `pwd`는 뺀다(셸 `PWD=` 경로를 지운다). 다른 안: WeKnora 목록 그대로.
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름): 해시는 의존성 없는 Core SHA-256 함수로 만든다. 다른 안: Runtime이 구현하는 `Hasher` 포트(배선이 늘고, 가리기가 순수 함수가 아니게 됨).
- Decision(2026-10-18, 사용자 위임으로 에이전트가 고름, 리뷰 뒤): 리뷰가 찾은 패턴 범위 문제 둘은 패턴 버전 `'1'`에서 고치지 않고 미룬다. 하나는 영어 키워드 값이 평범한 코드·문장까지 가리는 것이고, 다른 하나는 흔한 한국어 표현("비밀번호 X", "비밀번호가 X")을 놓치는 것이다. 두 가지 모두 과잉 가림과 가리지 못함 사이의 선택이라서 사람이 정할 몫이다. 실제 수집은 2.14에서 켜지므로 그 전에 정하면 저장된 데이터에 영향이 없다. frontmatter `deferred`에 남긴다. 다른 안: 값 최소 길이·식별자 제외 규칙을 지금 넣음, 한국어 구분자에 공백·`이`·`가`·`를`을 더함.

**Never:**
- 마이그레이션·스키마 변경, `messages redact` 명령(2.13), 첨부 마스킹(epic-attachments), spool(2.10), 실제 수집 켜기(2.14).
- parser(`packages/claude-code`)가 가리기를 하게 하기. 가리기는 Core 한 곳이다.
- 지운 텍스트를 어디에든 남기기: 로그, 오류 문장, 반환값, 경고, 시험 스냅샷 출력. 해시만 남긴다.
- Postgres store 변경(SessionStore 미구현).
- 실제 `~/.claude`·`~/.second_brain` 변경. 수동 확인은 임시 `SECOND_BRAIN_HOME`으로만 한다(`BRAIN_HOME`이 아니다 — 2.6 사고).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 토큰 하나 | 본문 `키는 sk-AAAAAAAAAAAAAAAAAAAA 이다` | 저장 본문 `키는 [REDACTED:api_key] 이다`, `redactions` 1행: start 3, end 26, kind `api_key`, `sha256:` 해시, `pattern_version` `'1'` | — |
| 키워드 값만 | `password: hunter2x, 다음`, `비밀번호는 Tiger2024`, `"api_key": "abc123def"` | 이름·구분자는 남고 값만 표시로 바뀜. 값은 `,`·공백·따옴표에서 멈춤 | — |
| PEM | BEGIN~END 여러 줄 블록, 그리고 END 없는 블록 | 블록 전체가 표시 하나. END가 없으면 끝까지 | — |
| 한글 위치 | `한글😀 sk-…` 앞에 이모지·한글 | start/end가 코드 포인트(이모지 1) | — |
| 겹침 | `token=sk-AAAA…`(키워드 값과 토큰이 같은 구간) | 표시 하나, 행 하나 | — |
| 도구 메모 | Bash 대상 `OPENAI_API_KEY=xyz123 node run.js`, `curl https://u:pw123@host/x` | 대상의 값이 가려짐, `redactions` 행 없음 | — |
| 다시 수집 | 같은 transcript를 두 번 | 두 번째 `inserted.redactions` 0, `redactions` 건수 그대로 | — |
| 과잉 가림 없음 | Always의 회귀 표 전부 | 본문·대상이 바뀌지 않고 `spans` 빈 배열 | — |
| 비밀 없음 | 평범한 batch | 본문 그대로, 기록 0 | — |

</intent-contract>

## Code Map

- `packages/core/src/sessions/ingest.ts` -- 202~210행에서 `messages`·`toolNotes`에 id를 매긴다. 가리기는 여기서 한다. `ingestedAt`은 바로 위에서 한 번 읽는다. 꼬리표 계산은 `messages[0]?.cwd`를 쓴다. 가려도 cwd는 그대로다.
- `packages/core/src/domain/ingest-batch.ts` -- `IngestMessage`에 `redactions: readonly IngestRedaction[]`를 더하고 `IngestRedaction`을 export한다. `ParsedMessage`는 바꾸지 않는다(parser는 모름).
- `packages/core/src/domain/redaction.ts` -- `patternVersion`을 더한다. `domain/index.ts`와 `src/index.ts`(`export *`)에서 새 모듈 셋(`secret-patterns`, `mask`(또는 같은 파일), `sha256`)을 export한다.
- `packages/core/src/ports/store.ts` -- `IngestCounts`(137행)에 `redactions`를 더한다. `ingest` 주석(220행~)의 규칙 목록에 "가리기 기록은 들어간 메시지 것만"을 넣는다.
- `packages/sqlite/src/sessions.ts` -- `ingest`(205행~)의 메시지 루프. `insert … returning id`가 행을 돌려줄 때만 그 메시지의 `redactions`를 넣는다(`id, message_id, file_id null, start, "end", kind, content_hash, occurred_at, pattern_version`). 칸 순서와 check는 `packages/sqlite/migrations/0004_capture_columns.sql` 198행~에서 확인한다. `occurred_at`은 `instant()`로 트랜잭션 밖에서 미리 만든다.
- `packages/core/src/testing/fakes/store.ts` -- `ingest`(182행~)가 같은 규칙으로 기록을 세고 보관한다.
- `packages/core/src/testing/contracts/session-store.ts` -- 308행 "adds nothing the second time" 근처에 사례를 둘 더한다. (1) 가리기가 달린 메시지를 넣으면 `inserted.redactions`가 그 수다. (2) 같은 batch를 다시 넣으면(다른 메시지 id·기록 id) 0이다. `fixtures.ts`의 batch 헬퍼는 `redactions: []`를 기본으로 둔다.
- `packages/core/test/sessions-ingest.test.ts` -- use case 사례: 가린 본문과 기록이 `store.ingest`에 가는지, 도구 메모 대상이 가려지는지, 기록 id·시각이 `idGen`·`clock`에서 오는지.
- `packages/core/test/secret-patterns.test.ts`(신규) -- 패턴별 양성 사례, 회귀 표(음성), 위치(코드 포인트), 겹침, PEM, 멱등. `sha256.test.ts`(신규)는 NIST 벡터(`''`, `abc`, 448비트 문장, 백만 `a`는 빼도 됨)와 `node:crypto` 대조(한글·이모지 포함)다.
- `packages/sqlite/test/session-store.test.ts` -- 계약은 자동으로 돈다. 그 밖에 SQLite 전용 사례를 둔다: `redactions` 행의 칸 값(`pattern_version`, `file_id` null), 메시지 FK.
- `apps/cli/src/commands/sessions-ingest.ts` -- 40행 `output` 설명에 가린 건수를 더한다(한국어). `inserted`는 그대로 넘긴다. 사람이 읽는 출력이 있으면 한국어로 맞춘다.
- `apps/cli/test/sessions-ingest.test.ts` -- 티켓 verify(CLI 수준). 헬퍼 `homeFor`·`migratedDatabase`·`childEnvironment`를 재사용한다.
  - 새 fixture `packages/claude-code/test/fixtures/secrets-session.jsonl`을 만든다. `two-turns.jsonl` 구조에 중립 내용과 지어낸 비밀을 넣는다. 사용자 본문, 어시스턴트 본문, Bash `tool_use`의 command를 쓴다.
  - 수집한 뒤 `sqlite3`/`DatabaseSync`로 다음을 단정한다. `messages.body`·`tool_notes.target` 전체에 비밀 문자열이 없다. `redactions.pattern_version`이 Core 상수와 같다. 회귀 표의 문자열은 본문에 그대로 있다.
- `apps/cli/test/install-flow.test.ts`·기타 -- `inserted` 모양을 단정하는 곳이 있으면 `redactions`를 더한다.
- `_bmad-output/personal-brain/deferred-work.md` -- 74행 `Redaction` 항목을 해결로 고친다. 도구 메모 가리기 기록 자리(Decision)와 2.13이 같은 문제를 만난다는 항목을 더한다.
- 읽기만: `packages/claude-code/src/tool-target.ts`(대상은 첫 줄 500자로 잘린 뒤 Core에 온다), `_bmad-output/personal-brain/inputs/weknora-patterns.md` §1.1 A2~A6, `~/Github/weknora/internal/types/memory.go:614-650`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/core/src/domain/sha256.ts`, `packages/core/test/sha256.test.ts` -- 의존성 없는 SHA-256(UTF-8 포함), `sha256:<hex>` -- AD-1 안에서 해시.
- [x] `packages/core/src/domain/secret-patterns.ts`(+ export), `packages/core/test/secret-patterns.test.ts` -- 목록·버전·`maskSecrets`, 매트릭스의 패턴 행과 회귀 표 -- 티켓의 과잉 가림 회귀.
- [x] `packages/core/src/domain/{ingest-batch,redaction}.ts`, `ports/store.ts` -- 타입과 포트 규칙.
- [x] `packages/core/src/sessions/ingest.ts`, `packages/core/test/sessions-ingest.test.ts` -- 저장 전 가리기.
- [x] `packages/core/src/testing/{fakes/store,fixtures,contracts/session-store}.ts`, `packages/core/test/contracts.test.ts` -- 가짜와 계약 두 사례. 음성 가짜도 하나 둔다: 다시 수집 때 기록을 또 넣는 store.
- [x] `packages/sqlite/src/sessions.ts`, `packages/sqlite/test/session-store.test.ts` -- 같은 트랜잭션 기록.
- [x] `apps/cli/src/commands/sessions-ingest.ts`, `packages/claude-code/test/fixtures/secrets-session.jsonl`, `apps/cli/test/sessions-ingest.test.ts` -- CLI 수준 verify.
- [x] `_bmad-output/personal-brain/deferred-work.md` -- 항목 갱신.

**Acceptance Criteria:**
- Given 임시 home에 `setup run --yes`, when 비밀 fixture로 `brain sessions ingest claude-code --json`을 부르면, then `messages`·`tool_notes`를 덤프한 결과에 fixture의 비밀값이 하나도 없다. 또 `redactions`의 모든 행이 `pattern_version = '1'`이고, `message_id`가 있는 메시지를 가리킨다.
- Given 같은 home, when 같은 transcript를 다시 수집하면, then `inserted`가 모두 0이고 모든 테이블 건수가 같다.
- Given `pnpm test`, when 실행하면, then build·typecheck·vitest가 모두 통과한다.

## Implementation Notes

- 멱등을 패턴이 아니라 **마커 건너뛰기**로 지켰다. 값 문자셋(`[^\s,.;:!?，。、'"\`]+`)에는 `[`가 들어 있어서, 한 번 가린 `token=[REDACTED:api_key]`를 다시 넣으면 키워드 패턴이 `[REDACTED`를 값으로 잡는다. 그래서 `maskSecrets`가 먼저 `\[REDACTED:[a-z0-9_]+\]`의 위치를 모으고, 그 구간과 겹치는 구간은 버린다. 플랜이 정한 값 문자셋은 그대로 두었다.
- `spans`의 `removed`는 **해시**다(`sha256:<hex>`). 플랜 Never가 지운 텍스트를 반환값에도 남기지 못하게 하므로, 마스킹 함수가 직접 해시해서 돌려주고 use case는 그 값을 `contentHash`에 넣는다.
- `shell_assignment`의 값 그룹에 이름(`quoted`·`single`·`bare`)을 붙였다. inputs A5가 받아들이는 문자열 집합은 그대로이고, 세 대안 중 어느 것이 값인지 `match.indices.groups`로 고르기 위한 것뿐이다.
- 길이 0 구간은 버린다(`FOO=""`). 0004의 `redactions_range_check`가 `start < "end"`를 요구하고, 비어 있는 값은 비밀이 아니다.
- 코드 포인트 변환에서 서로게이트 탐지는 정규식을 쓰지 않는다. `u` 플래그가 붙은 `[\uD800-\uDFFF]`는 **짝이 아닌** 서로게이트만 잡으므로, 이모지가 있는 본문에서 조용히 꺼져 위치가 UTF-16으로 새어 나갔다(구현 중 실제로 났고, `secret-patterns.test.ts`의 "counts code points" 사례가 이를 고정한다).
- `IngestCounts.redactions`를 더하면서 `inserted` 모양을 정확히 비교하던 자리 셋을 고쳤다(계약 두 곳, `apps/cli/test/sessions-ingest.test.ts`의 `toEqual`). 나머지는 `toMatchObject`라 그대로 통과한다.
- (메인 세션, 검증 단계) 마커 건너뛰기 조건을 "겹치면 버림"에서 "마커 안에 **완전히 들어가면** 버림"으로 좁혔다. 겹치기만 해도 버리면, END 없는 개인 키 블록 뒤에 `[REDACTED:…]` 문자열이 있을 때 키 블록 전체가 가려지지 않고 저장됐다. 멱등 사례는 모두 그대로 통과한다(다시 잡히는 값 `[REDACTED`는 마커 안에 있다). `secret-patterns.test.ts`에 사례를 하나 더했다.
- 검증: `BRAIN_TEST_DATABASE_URL`(로컬 시험 컨테이너)을 설정하고 `pnpm test` → 45파일 1503건 통과.

## Plan Change Log

## Review Triage Log

### 2026-10-18 — Review pass
- verdicts: 8 findings — high 0, medium 3, low 5, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` 영어 키워드 패턴이 `password === input`·`token == expected`·`secret == null`의 남은 `=`/`==`를 값으로 가리고 쓸모없는 기록을 남김 — 재현 확인. `\s*[:=]\s*` 뒤에 `(?!=)`를 넣고 세 문자열을 회귀 표에 더함.
  - `[medium]` `[defer]` 영어 키워드 값에 모양 검사·길이 하한이 없어 `let token = parse(input);`, `secret: see the README`, `{"token": 123}`(닫는 `}`까지) 같은 평범한 코드·문장이 가려짐 — 실제다. 그러나 고치려면 값 모양 규칙(길이 하한, 식별자·호출 제외 등)을 새로 정해야 하고 plan은 값을 문자셋으로만 정했다. 실제 수집은 2.14에서 켜지므로 그 전에 사람이 정한다(Decision 아래). frontmatter `deferred`에 기록.
  - `[medium]` `[defer]` 한국어 키워드가 `:`/`=`/`은`/`는`만 구분자로 보아 `비밀번호 Tiger2024`, `비밀번호가 …`, `비밀번호를 … 로 바꿨어`를 놓침 — 실제다(가리지 못함). plan과 inputs A2의 정규식 그대로이고, 구분자를 넓히면 과잉 가림과 맞바뀐다. 위와 같은 이유로 2.14 전에 사람이 정한다. frontmatter `deferred`에 기록.
  - `[low]` `[patch]` `private_key`가 END 꼬리표가 다른 블록(`-----END CERTIFICATE-----`)에서 멈추지 않아 뒤 산문까지 지움 — 첫 대안을 아무 `-----END …-----`에서 멈추게 하고 사례를 더함. END 줄이 아예 없는 블록(산문 속 BEGIN 한 줄 포함)이 끝까지 가는 것은 plan 규칙 그대로 둠.
  - `[low]` `[patch]` `sessions-ingest.ts` 머리 주석이 건수를 "출력한다", "유일한 신호"라 함 — text 모드는 아무것도 찍지 않고 도구 메모 가리기는 기록이 없음. 주석을 JSON `inserted.redactions`, 본문 가리기만 센다로 고침.
  - `[low]` `[patch]` `deferred-work.md`가 `Redaction` 항목을 통째로 해결로 표시 — `patternVersion`만 해결, 파일 가리기 모양(`fileId`, nullable 위치)은 epic-attachments로 남긴다고 고침.
  - `[low]` `[reject]` 계약이 `readSession`에 기록이 없어 건수만 단정함 — 지금 두 store는 모두 행을 실제로 쓴다(SQLite는 칸 값 시험과 FK가 지킴). 고치려면 포트에 읽기를 더해야 해 이득보다 표면이 커짐.
  - `[low]` `[reject]` `maskSecrets`가 호출마다 정규식 17개를 다시 만듦 — 리뷰어 측정으로 240KB 본문 약 1ms라 hook 예산(AD-6)에 닿지 않음. 공유 정규식의 `lastIndex` 상태를 피하려는 의도된 선택.

## Design Notes

기록을 메시지에 매다는 이유: 다시 수집하면 use case가 메시지 id를 새로 발급한다. Store가 그 메시지를 건너뛰면 기록도 함께 버려야 한다. 그렇지 않으면 없는 id를 가리키는 FK 오류가 나거나, 같은 가리기가 두 번 남는다. 기록이 메시지에 붙어 있으면 "넣은 메시지의 기록만"이 루프 하나로 끝난다.

```ts
// sqlite ingest, per message
const inserted = await insertMessage(...);          // returning id
if (inserted.rows.length === 1) {
  for (const r of message.redactions) await insertRedaction(r, message.id);
  insertedRedactions += message.redactions.length;
}
```

코드 포인트 위치: 정규식 인덱스(UTF-16)를 `Array.from(text.slice(0, i)).length` 꼴로 바꾼다. 긴 본문이라면 한 번 훑어 UTF-16→코드 포인트 표를 만든다.

## Verification

**Commands:**
- `pnpm test` -- expected: build → typecheck → vitest 모두 통과(Postgres 통합은 `BRAIN_TEST_DATABASE_URL` 필요; 기준선과 같은 상태면 통과로 본다)

**Results (2026-10-18):**
- `pnpm -r build`, `pnpm typecheck`: 통과.
- `npx vitest run`: 45개 파일 중 42개 통과, 1431개 통과. 실패 16개는 모두 `packages/postgres`(`migrate`·`setup`·`store`)이고 `BRAIN_TEST_DATABASE_URL`이 없어서 나는 것으로 기준선과 같다. Core·sqlite·claude-code·cli는 전부 통과.
- 수동 확인: 임시 `SECOND_BRAIN_HOME`에 `install.js --yes` → 비밀 fixture를 Stop 페이로드로 `sessions ingest claude-code --json` → `inserted {messages:2, toolNotes:1, redactions:4}`. `messages.body`·`tool_notes.target`에 fixture의 비밀값이 없고, `redactions` 4행 모두 `pattern_version = '1'`·`file_id is null`·`start < end`·`sha256:` 해시. 같은 transcript를 다시 넣으면 `inserted` 전부 0이고 모든 테이블 건수가 같다.

**Manual checks (if no CLI):**
- 임시 `SECOND_BRAIN_HOME=<tmp>`로 `node apps/cli/dist/install.js --yes`를 한다. 그다음 비밀 fixture를 hook payload로 `node apps/cli/dist/bin.js sessions ingest claude-code --json`에 넣는다. 끝으로 `sqlite3 <tmp>/brain.db "select body from messages; select target from tool_notes; select kind, pattern_version, start, \"end\" from redactions"`로 확인한다. 비밀값이 없고, 행마다 버전 `1`이어야 한다.

## Auto Run Result

**요약:** 수집이 메시지 본문과 도구 메모 대상을 저장 전에 가린다. 가린 자리는 `[REDACTED:<kind>]`가 된다. 패턴 목록은 Core 한 곳(`packages/core/src/domain/secret-patterns.ts`, `SECRET_PATTERN_VERSION = '1'`)에 있고, 다음을 잡는다:
- 제공자 토큰
- JWT·Bearer
- PEM 개인 키 블록 전체
- URL 속 비밀번호
- 영어·한국어 비밀번호 키워드(값만 가림)
- 주민번호·휴대폰
- Luhn을 통과한 카드 번호
- 도구 메모의 셸 `NAME=value`(값만 가림)

가리기는 batch를 만드는 자리(`sessions.ingest` use case)에서 하므로, 나중에 spool이 batch를 써도 비밀은 들어가지 않는다. 본문 가리기마다 `redactions` 한 행이 메시지와 같은 트랜잭션에 들어간다. 행에는 원문 위의 코드 포인트 위치, 종류, `sha256:` 해시, `pattern_version`이 남는다. 다시 수집하면 기록이 늘지 않는다. Core는 `node:crypto`를 쓸 수 없어서 의존성 없는 SHA-256을 뒀다.

**바뀐 파일:**
- `packages/core/src/domain/secret-patterns.ts`(신규) — 패턴 목록·버전·`maskSecrets`
- `packages/core/src/domain/sha256.ts`(신규) — 의존성 없는 SHA-256과 UTF-8 인코딩
- `packages/core/src/domain/{ingest-batch,redaction,index}.ts`, `ports/store.ts` — `IngestRedaction`, `IngestMessage.redactions`, `Redaction.patternVersion`, `IngestCounts.redactions`, 포트 규칙
- `packages/core/src/sessions/ingest.ts` — 저장 전 가리기
- `packages/core/src/testing/{fakes/store,fixtures,contracts/session-store}.ts` — 가짜와 계약 사례 2개
- `packages/sqlite/src/sessions.ts` — 실제로 들어간 메시지의 기록만 같은 트랜잭션에서 넣음
- `apps/cli/src/commands/sessions-ingest.ts` — 명령 메타 `output` 설명과 주석
- 시험:
  - `packages/core/test/{secret-patterns,sha256}.test.ts`(신규)
  - `packages/core/test/{sessions-ingest,contracts}.test.ts`
  - `packages/sqlite/test/session-store.test.ts`
  - `apps/cli/test/sessions-ingest.test.ts`
  - `packages/claude-code/test/fixtures/secrets-session.jsonl`(신규, 지어낸 비밀)
- `_bmad-output/personal-brain/deferred-work.md` — `Redaction` 항목 갱신, 도구 메모 가리기 기록 자리 항목

**리뷰:** quick 1회, 8건(medium 3, low 5)이다.
- 패치 4건(medium 1, low 3): 비교식 `==`를 값으로 가림, END 꼬리표가 다른 PEM, CLI 주석, deferred-work 표시.
- 미룸 2건(medium): 영어 키워드 과잉 가림, 한국어 표현 놓침. frontmatter `deferred`에 있다.
- 거부 2건(low):
  - 계약이 건수만 단정함: 두 store가 모두 실제로 쓰고, 고치려면 포트에 읽기 표면을 더해야 한다.
  - 정규식을 호출마다 다시 만듦: 측정해 보니 약 1ms이고, 의도된 선택이다.
- 리뷰 전에 메인 세션이 직접 고친 것도 1건 있다. 이미 있는 `[REDACTED:…]`와 겹치기만 해도 구간을 버려서, END 없는 키 블록이 통째로 새는 문제였다.

**후속 리뷰 권고:** false. 패치한 high는 0이고 medium은 1이다.

**검증:**
- 리뷰 패치 뒤 `pnpm test`(build → typecheck → vitest)가 45파일 1510건 통과했다. Postgres 통합은 로컬 시험 컨테이너로 `BRAIN_TEST_DATABASE_URL`을 설정해 포함했다.
- 매트릭스 9행은 모두 실행된 시험이 덮는다.
- 구현 서브에이전트가 임시 `SECOND_BRAIN_HOME`으로 수동 확인을 했다. 순서는 `install.js --yes` → 비밀 fixture 수집이다. 결과: `inserted {messages 2, toolNotes 1, redactions 4}`, 본문·대상에 비밀값 없음, 4행 모두 `pattern_version '1'`, 다시 수집하면 모두 0.
- 실제 `~/.claude`·`~/.second_brain`은 건드리지 않았다.

**에이전트가 대신 내린 결정** (모두 intent-contract에 Decision으로 기록):
1. 도구 메모 대상을 가린 것은 `redactions` 행을 남기지 않는다. 0004에 도구 메모를 가리킬 칸이 없기 때문이다. 다른 안: 0005로 `tool_note_id` 추가.
2. `shell_assignment`는 도구 메모 대상에만 쓰고 본문에는 쓰지 않는다. 다른 안: 본문에도 씀.
3. WeKnora의 "40자 이상 토큰" 규칙과 `pwd` 키워드는 뺐다. 카드 번호는 Luhn과 앞자리 조건을 붙여 넣었다. 다른 안: WeKnora 목록 그대로.
4. 해시는 의존성 없는 Core SHA-256으로 만든다. 다른 안: Runtime `Hasher` 포트.
5. (리뷰 뒤) 패턴 범위 문제 둘(영어 키워드 과잉 가림, 한국어 표현 놓침)은 버전 `'1'`에서 고치지 않고 2.14 전에 사람이 정하도록 미뤘다.

**사람 확인 필요:**
- 결정 5의 두 항목(frontmatter `deferred`)을 2.14(실제 수집 켜기) 전에 정할 것. 정해서 패턴을 바꾸면 `SECRET_PATTERN_VERSION`을 올린다.
  - `let token = parse(input);`, `secret: see the README` 같은 줄이 가려지는 것을 받아들일지
  - "비밀번호 X", "비밀번호가 X"도 잡을지
- 결정 1~3이 맞는지 볼 것. 특히 1이다. 도구 메모에서 가린 것은 어디에도 기록이 없어서 패턴 버전이 바뀐 뒤 다시 찾을 수 없다. 2.13 `messages redact`도 같은 문제를 만난다(deferred-work).
- 실제 Claude Code 세션 하나를 임시 home으로 수집해서, 가린 결과가 눈으로 보기에 괜찮은지 볼 것. 자동 시험은 지어낸 fixture로만 했다.

**남은 위험:**
- 도구 메모 대상은 parser가 첫 줄 500자로 자른 뒤에 가린다. 그래서 잘린 경계에 걸친 토큰은 앞부분이 남을 수 있다. 16자보다 짧게 남으면 토큰 패턴에 걸리지 않는다.
- END 줄이 없는 BEGIN 한 줄(산문에서 PEM 형식을 설명하는 경우 등)은 그 뒤 본문을 끝까지 지운다(plan 규칙).
- 카드 번호는 4자리 묶음만 보므로 Amex의 4-6-5 표기는 잡지 않는다.
