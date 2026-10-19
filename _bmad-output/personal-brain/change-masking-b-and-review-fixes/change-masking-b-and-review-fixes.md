---
title: '마스킹 B와 결정 검토 수정'
type: sprint-change-proposal
created: '2026-10-19'
status: approved
approved: '2026-10-19'
scope: moderate
mode: batch
trigger: '2026-10-18 사용자 결정(마스킹 B: 저장은 원문, 나갈 때 가림)과 2.6·2.7·2.8·2.9 결정 검토의 수정 지시("우려대로 고친다")'
inputs:
  - ../inputs/masking-b-and-review-fixes.md
  - ../epic-capture/story-untitled-9-plan.md
  - ../epic-capture/story-transcript-parser-plan.md
  - ../epic-capture/story-untitled-8-plan.md
  - ../epic-capture/story-0004-plan.md
---

# Sprint Change Proposal — 마스킹 B와 결정 검토 수정

## 0. 체크리스트 상태

| 항목 | 상태 | 메모 |
| --- | --- | --- |
| 1.1 트리거 스토리 | [x] | 2.9(저장 전 마스킹)의 리뷰가 패턴 문제 셋을 남겼고, 2026-10-18 결정 검토가 2.6·2.7·2.8의 우려 넷을 찾았다 |
| 1.2 문제 정의 | [x] | 유형: 실패한 접근(저장 전 마스킹은 과잉 가림을 되돌릴 수 없다) + 구현 빈틈(parser·정체성·trigger·기록 자리) |
| 1.3 근거 | [x] | 2.9 plan의 Review Triage Log와 frontmatter `deferred`, 2.7 plan의 peer 제외 Decision(실측 보고 약 58% 누락), 2.8 plan의 대소문자·git 실패 Decision, 2.6 plan Decision 3 |
| 2.1 현재 에픽 | [x] | epic 2는 완료할 수 있다. 새 스토리 넷(17~20)을 13 앞에 넣고, 13·14·15의 `after`와 13의 범위가 바뀐다 |
| 2.2 에픽 변경 | [x] | §4.1 |
| 2.3 이후 에픽 | [x] | epic 3·4·5·6·7·8·9·10의 Notes(인셉션 입력). 범위·순서는 그대로 |
| 2.4 새 에픽 | [N/A] | 없다 |
| 2.5 순서 | [x] | 에픽 순서는 그대로. epic 2 안에서 10→11→12→19→17→18→20→13→14→15(D11) |
| 3.1 PRD | [x] | §4.3. FR-1·FR-26·NFR-1·NFR-6 문구. MVP는 그대로 |
| 3.2 Architecture | [x] | §4.2. AD-11·12·15·16·23·24, Table Contract, ER, Conventions, Capability map |
| 3.3 UX | [N/A] | UX 문서 없음 |
| 3.4 기타 산출물 | [x] | spec CAP-2, deferred-work Triage, epic 2 ticket 9 note |
| 4.1 직접 조정 | [x] Viable | 노력 중, 위험 중. 새 스토리 넷과 문서 문구 |
| 4.2 되돌리기 | [x] 부분 Viable | 2.9 중 수집 경로의 가리기만 뺀다. 패턴 목록과 `maskSecrets`는 출력 함수로 그대로 쓴다 |
| 4.3 MVP 축소 | [x] Not viable | 범위는 그대로다 |
| 4.4 선택 | [x] | Hybrid: 직접 조정 + 2.9 수집 경로의 부분 되돌리기(story 17) |
| 5.x 제안 구성 | [x] | §1~§5 |
| 6.3 승인 | [x] | §6. 2026-10-19 승인, D1~D11 권고대로 |
| 6.4 핸드오프 | [x] | §5 |

## 1. Issue Summary

**마스킹 B.** FR-26과 AD-11은 저장 전 마스킹을 정했다. 원문 불변의 유일한 예외였다. 2.9가 그대로 만들었다. `sessions.ingest` use case가 batch를 만들 때 `maskSecrets`를 부르고, 가린 구간을 `IngestMessage.redactions`로 `redactions`에 남긴다. 2.9 리뷰는 패턴 문제 셋을 재현했다.
- 과잉 가림: 영어 키워드 값에 모양 검사가 없다. `let token = parse(input);`, `secret: see the README`, `{"token": 123}`처럼 평범한 코드와 문장이 가려진다.
- 가리지 못함: 한국어 구분자가 `:`·`=`·`은`·`는`뿐이다. "비밀번호 Tiger2024", "비밀번호가 …"를 놓친다.
- 값 끊김: 값이 `!` 같은 구두점에서 멈춘다. 비밀의 뒷부분이 남는다.

저장 전 마스킹에서는 과잉 가림이 저장본을 영구히 망가뜨린다. 메시지는 저장한 뒤 바뀌지 않기 때문이다. 그래서 패턴을 넓히기 어렵고, 좁히면 비밀이 새는 쪽으로 기운다. 2026-10-18 사용자 결정은 이렇다.
- 비밀은 저장할 때 가리지 않고 원문 그대로 둔다.
- 밖으로 나갈 때 가린다. 나가는 길은 시작 맥락 주입, 검색·조회 결과, Markdown 미러, 내보내기, Drive·복제 대상이다.

**결정 검토 수정.** 같은 날의 결정 검토에서 나온 우려 넷이다. 사용자 지시는 "우려대로 고친다"이다.
- **2.7 parser.** peer handback(`origin.kind === 'peer'`, `origin.handback === true`, `origin.handbackReportText`)을 서브에이전트 보고로 받지 못한다. 2.7 Decision이 peer 항목을 통째로 뺐기 때문이다. 실측에서 보고의 약 58%가 빠진다.
- **2.8 정체성.** owner/repo의 대소문자를 그대로 두므로, GitHub·Bitbucket에서 같은 레포가 두 프로젝트로 갈라질 수 있다. 또 git 조회가 잠깐 실패하면 꼬리표 없이 수집하는데, 꼬리표는 바뀌지 않으므로 그 세션은 영구히 null이 된다.
- **2.6 `failed_stage`.** `failed`인 추출 세대에 `failed_stage`가 없어도 된다(2.6 Decision 3). 강제하는 것이 없다.
- **도구 메모 가리기 기록.** 2.9는 도구 메모 대상을 가린 기록을 남기지 않는다(0004에 칸이 없음). 2.13도 같은 문제를 만난다.

**왜 지금인가.** 실제 수집은 2.14에서 켜진다. 저장된 실제 데이터가 아직 없으므로 저장 방식을 바꾸는 비용이 가장 낮은 때다. 2.13·2.14의 `unknown`이 이 제안을 가리킨다.

## 2. Impact Analysis

### 2.1 에픽

| 에픽 | 상태 | 영향 |
| --- | --- | --- |
| 1 기반 | 완료 | 없음 |
| 2 수집 | 1~9·16 built, 10~15 남음 | 새 스토리 17(마스킹 B 전환)·18(0005)·19(parser v3)·20(정체성 보강). 13의 범위(저장본 가리기, `detected`, 도구 메모 기록)와 `after`, 14·15의 `after`, 9에 note. Description·Outcome·E2-4·6·8, 새 E2-10, Done when 4·5, Boundaries, Notes |
| 10 첨부 | envelope | Notes: 추출 텍스트도 원문 저장·나갈 때 가림(AD-23 문구 변경), 0005의 `failed_stage` trigger |
| 3 로그·맥락 | envelope | Notes: 시작 맥락은 hook 출력 코덱이 가린다. 규칙 인용 대조와 가린 표시 |
| 4 조회·미러 | envelope | Notes: 조회 결과는 엔벨로프 코덱이 가린다(D1). 색인은 원문 위(D2). 미러와 패턴 버전(D3) |
| 5 운영 | envelope | Notes: 내보내기는 가린 텍스트와 manifest 패턴 버전. 되살리면 비밀은 가린 채 돌아온다(D6) |
| 9 데몬 | envelope | Notes: 소켓·MCP는 같은 엔벨로프 코덱이라 따로 할 일이 없다 |
| 7 복제 | envelope | Notes: 복제 payload 가림과 패턴 버전, 버전이 오르면 다시 가림, `move-store`는 원본에서 복사. Postgres가 0005만큼 더 갈라짐 |
| 8 Drive | envelope | Notes: Drive로 올리는 DB 스냅샷은 가린 사본(D6) |
| 6 임베딩 | envelope | Notes: 임베딩·재순위로 보내는 텍스트는 가린 텍스트 |

### 2.2 문서

- **PRD:** FR-1(예외 문구), FR-26(전문), NFR-1(예외 문구), NFR-6(나가는 텍스트), frontmatter `updated`.
- **spec:** CAP-2 intent·success.
- **Architecture spine:** AD-11(첫 항목을 나갈 때 가리기로, 출력 코덱 계약, `redactions` 위치), AD-12(비교 키, 꼬리표 다시 채우기), AD-15(색인은 원문 위, 임베딩 요청은 가린 텍스트), AD-16(미러와 패턴 버전), AD-23(추출 텍스트), AD-24(`failed_stage` 강제), Table Contract(`projects`·`sessions`·`redactions`), ER(`redactions`의 대상 둘), Conventions(텍스트, 내보내기), Capability map, frontmatter.
- **deferred-work.md Triage:** 도구 메모 가리기 기록 두 행, Postgres 갈라짐 행, Core 타입 행, 2.9 deferred 두 항목, 2026-10-18 항목 넷.

### 2.3 기술·기타 산출물

- **코드(story 17이 바꿈).** 2.9가 수집 경로에 넣은 것을 뺀다.
  - `packages/core/src/sessions/ingest.ts`의 `maskSecrets` 호출 두 곳(203·223행)
  - `IngestMessage.redactions`, `IngestCounts.redactions`
  - SQLite `sessions.ts`의 수집 중 `redactions` 쓰기, 메모리 가짜, 계약 사례 둘, CLI 비밀 fixture 시험의 단정

  `secret-patterns.ts`·`sha256.ts`·`maskSecrets`는 그대로 쓴다. 출력 함수가 된다.
- **스키마(story 18).** 0005: `redactions.tool_note_id`, `document_extractions`의 `failed_stage` 강제 trigger, `projects.identity_key`. `SQLITE_SCHEMA_VERSION` 5.
- **데이터.** 옮길 데이터가 없다. 2.9가 남긴 `redactions` 행은 개발용 임시 home에만 있다.
- **보안 성질의 변화.** `brain.db`와 `-wal`·`-shm`에 비밀이 원문으로 남는다. 이것이 마스킹 B의 대가다. 지키는 것은 AD-10의 규칙(동기화 폴더 금지, 권한 0600)이다. 저장본에서도 지우고 싶으면 2.13의 `messages redact`를 쓴다(`detected`, D5).
- **진행 중 작업.** 2.10~2.12는 영향이 없어 이 제안의 승인 전에도 진행할 수 있다(입력 §3). 2.10의 spool은 수집 밀림 표시만 쓰고 batch를 쓰지 않는다. 2.11은 failures 오류 문자열을 저장 전에 가리는데, 그대로 둔다. 원문이 아닌 기록이라서 저장 전에 가려도 잃는 것이 없다. 출력 때 한 번 더 가려져도 멱등이다.

## 3. Recommended Approach

**Hybrid: 직접 조정 + 2.9 수집 경로의 부분 되돌리기.**
- 요구는 그대로다. 바뀌는 것은 비밀을 가리는 시점(저장 → 출력)이고, MVP 범위는 같다.
- 노력은 중이다. 새 스토리 넷 가운데 17이 중, 나머지 셋이 중~하다. 문서 편집은 한 세션이다.
- 위험은 중이다. 보안 성질이 "DB에 비밀 없음"에서 "밖으로 안 나감"으로 바뀐다. 출력 코덱 한 곳과 등록부 계약 테스트(D1)로, 나가는 길을 잊는 실수를 테스트가 잡게 한다.
- 일정은 2.14 앞에 스토리 넷이 늘어난다.

### 정할 것 (D1~D11). 권고는 굵게.

| # | 질문 | 선택지 | 권고와 이유 |
| --- | --- | --- | --- |
| D0 | 저장은 원문, 나갈 때 가림 | (확정, 사용자 2026-10-18) | 나가는 길: 시작 맥락, 검색·조회 결과, 미러, 내보내기, Drive·복제 대상. 이 제안은 임베딩·재순위 요청도 나가는 길로 넣는다(NFR-6이 그 전송을 이미 "외부 전송"으로 본다) |
| D1 | 출력 가리기를 어디에 거나 | (a) Core의 출력 코덱이 부른다: 엔벨로프 코덱(`data`·`error`·`warnings`·`meta`의 문자열; CLI·MCP·소켓이 공유), hook 출력 코덱, 미러 렌더러, 내보내기 writer, 복제 payload, 임베딩·재순위 요청. 등록부 계약 테스트를 둔다 (b) 읽기 use case마다 텍스트 칸을 골라 가린다 | **(a)**. 코덱은 몇 개뿐이고, 새 명령은 자동으로 덮인다. (b)는 이후 에픽의 모든 읽기 verb가 잊지 않아야 한다. 계약 테스트는 비밀 fixture를 수집한 뒤 두 가지를 본다: 등록된 모든 코덱의 출력에 값이 없고, 저장본에는 있다. 등록부에 없는 코덱을 만들면 실패한다(명령 메타 누락 검사와 같은 방식). 엔벨로프는 모든 문자열을 훑지만, 회귀 표(git SHA·UUIDv7·sha256·경로·세션 토큰)가 ID를 지킨다. 도구 메모 대상 칸은 `tool_target` 규칙으로 가린다(셸 `NAME=value`) |
| D2 | 색인은 무엇 위에 만드나 | (a) 원문 위(조각·FTS). 결과는 엔벨로프에서 가린다 (b) 가린 텍스트로 조각을 만든다 | **(a)**. (b)는 패턴이 바뀔 때마다 재색인이 필요하고, FR-10의 "조각 본문은 원문 그대로"와도 어긋난다. (a)의 대가: 비밀 값으로 검색하면 맞는 행이 나오고 값만 가려진다. 이 기계 안, 같은 사용자의 일이라 받아들인다 |
| D3 | 이미 써 둔 출력과 패턴 버전 | (a) 미러·복제 대상은 쓴 패턴 버전을 적는다. 버전이 오르면 미러 재생성 일감과 복제 재가리기 일감을 만든다. 내보내기는 manifest에 버전만 적는다 (b) 적지 않는다 | **(a)**. B에서는 패턴을 고치는 것이 곧 이미 나간 것을 고치는 일이다. 미러는 로컬이라 싸고, 복제 재가리기는 D5(change-users-and-review-gaps)의 가리기 전파 경로와 같다. 이미 쓴 내보내기 파일은 사용자의 파일이라 건드리지 않는다 |
| D4 | 2.9를 어떻게 하나 | (a) 새 스토리 17이 수집 경로의 가리기와 수집 중 `redactions` 쓰기를 빼고, `maskSecrets`를 출력 함수로 남긴다. 미룬 패턴 문제 셋을 같은 스토리에서 고치고 `SECRET_PATTERN_VERSION`을 `'2'`로 올린다 (b) 2.9 전체를 되돌리고 새로 만든다 (c) 패턴 수정은 따로 | **(a)**. 패턴 목록·해시·멱등·코드 포인트 위치는 B에서도 그대로 쓴다. 패턴 수정의 무게가 바뀐다: 가리지 못하면 밖으로 새고, 과잉 가림은 출력에서만 보인다. 그래서 놓침(한국어 구분자, 구두점 끊김)은 넓히는 쪽으로 고친다. 과잉 가림은 값 모양 규칙(식별자 뒤 `(`, 숫자만, 따옴표 없는 영어 단어 문장 등)으로 줄인다. 세부 규칙은 17의 plan이 정한다 |
| D5 | 2.13의 범위 | (a) 저장본에서 지우는 사람의 가리기로 남긴다. 입력은 지울 글자 그대로, 또는 `detected`다. `detected`는 그 메시지에서 지금 패턴이 찾는 구간 전부를 저장본에서 지우고 `pattern_version`을 남긴다. 도구 메모 대상 가리기는 0005의 `redactions.tool_note_id`로 기록한다 (b) `detected` 없이 글자만 받는다 (c) 도구 메모 대상은 가리지 않는다 | **(a)**. B에서 저장본에 비밀이 원문으로 남는다. "이 키는 DB에서도 지워라"를 한 번에 하는 길이 `detected`다. 출력 가리기는 기록을 남기지 않으므로, 도구 메모 가리기 기록이 필요한 곳은 2.13뿐이다(입력 §2 마지막 항목의 답) |
| D6 | 내보내기와 Drive의 DB 스냅샷 | (a) 둘 다 나가는 길로 보고 가린 텍스트를 쓴다. 되살린 Brain의 비밀은 가린 채 돌아온다 (b) 백업이므로 원문을 쓴다 | **(a)**. 입력(D0)이 내보내기와 Drive를 나가는 길로 정했다. 내보낸 파일은 Brain 없이 읽히는 파일이고(NFR-9), 스냅샷은 클라우드에 올라간다. NFR-9의 건수 비교는 그대로 맞는다. `setup move-store`(epic 7)는 복제본이 아니라 원본에서 복사하므로 원문을 잃지 않는다 |
| D7 | 2.8 대소문자 | (a) `projects.identity_key`(UNIQUE)를 둔다. 대소문자를 구분하지 않는 호스트(Core 상수 목록, 처음은 `github.com`·`bitbucket.org`)는 정체성을 소문자로 접은 값이고, 그 밖은 정체성 그대로다. `remote_identity`는 처음 본 모양 그대로의 표시용이다 (b) `remote_identity` 자체를 접는다 | **(a)**. 입력이 "비교용 case-fold 키"로 정했다. 미러 파일 이름과 목록은 원래 대소문자를 보인다. 목록에 없는 호스트는 대소문자를 구분할 수 있으므로 그대로 둔다(2.8 Decision의 이유는 유지) |
| D8 | 2.8 영구 null | (a) inspect의 결과를 셋으로 나눈다: checkout, 레포 아님, 모름(git 없음·시간 초과·권한·비정상 출력). 모름이면 꼬리표 없이 수집하고 `session_identity` 일감을 남긴다. drain이 transcript 첫 메시지 cwd로 다시 묻고, 성공하면 비어 있던 꼬리표를 한 번 채운다(null → 값만). 끝내 실패하면 `failures`로 가서 doctor가 보인다 (b) doctor 경고만 한다 (c) 다음 수집마다 다시 묻는다 | **(a)**. 2.11의 일감·재시도·실패 기록을 그대로 쓴다. 레포 밖 세션은 일감을 남기지 않아 매번 git을 부르지 않는다. (c)는 hook 경로에 git 지연을 매 턴 얹는다. 꼬리표 불변 규칙은 "null에서 한 번만 채울 수 있음"으로 좁아진다 |
| D9 | 0005의 구성 | (a) 한 마이그레이션 스토리(18): `redactions.tool_note_id`(대상은 셋 중 하나, 0004와 같은 재생성), `document_extractions`의 `failed_stage` 강제 trigger(`failed`가 되는 insert·update만, 0004 이전 행은 예외), `projects.identity_key`(기존 행은 D7 규칙의 SQL로 채움), 버전 5 (b) 각 동작 스토리가 제 마이그레이션을 만든다 | **(a)**. 2.6과 같은 방식이다. 버전 단정이 박힌 시험을 한 번만 고친다 |
| D10 | parser v3 | (a) 새 스토리 19: peer 항목 중 `origin.handback === true`인 것을 서브에이전트 최종 보고로 받는다(본문 `origin.handbackReportText`, `isSubagentReport`, role assistant, model null). 나머지 peer 항목은 지금처럼 뺀다. `CLAUDE_CODE_PARSER_VERSION` `'3'`. 리뷰는 2.7 전체를 다시 보는 follow-up으로 한다 (b) 2.7 plan을 다시 열어 고친다 | **(a)**. 2.7은 built다. 버전이 다르면 처음부터 다시 읽는 규칙(2.7)이 있으므로 빠진 보고만 더해진다. deferred의 "2.7 follow-up 리뷰" 권장을 이 스토리의 리뷰로 닫는다 |
| D11 | 순서 | (a) 10 → 11 → 12 → 19 → 17 → 18 → 20 → 13 → 14 → 15 (b) 새 스토리를 10 앞에 | **(a)**. 입력대로 2.10~2.12는 먼저 진행한다. 19는 parser만 고쳐 독립적이다. 17이 출력 코덱 규칙을 세운 뒤 18이 스키마를 놓는다. 20은 11의 일감, 12의 세션 토큰 수집, 18의 비교 키가 필요하다. 13은 17·18이 필요하다. 14는 19·20·13 뒤에 실제 수집을 켠다. 에픽의 선행 관계는 핫스팟 때문에 한 줄을 유지한다 |

## 4. Detailed Change Proposals

### 4.1 에픽·스토리 (적용: `bmad-ticket`)

#### epic-capture `tickets.toml` — 새 entry 넷

표 순서 = 만드는 순서이므로 12 뒤, 13 앞에 19 → 17 → 18 → 20 순서로 넣는다.

**id 19 — parser v3: peer handback 보고** (D10)
- description: "Claude Code parser가 user 항목 중 `origin.kind === 'peer'`이고 `origin.handback === true`인 것을 서브에이전트 최종 보고로 받게 한다(본문은 `origin.handbackReportText`(trim), `isSubagentReport: true`, role `assistant`, model null; 그 밖의 peer 항목은 지금처럼 뺀다). `CLAUDE_CODE_PARSER_VERSION`을 '3'으로 올려, 버전이 다르면 처음부터 다시 읽는 규칙(2.7)으로 빠졌던 보고가 더해지게 한다. 실제 transcript의 키·모양을 따르고 문장은 직접 쓴 중립 fixture를 더한다. 이 스토리의 리뷰는 2.7 전체를 다시 보는 follow-up 리뷰로 한다(deferred-work 2026-10-18 항목, 2026-10-19 change-masking-b-and-review-fixes D10)."
- verify: "peer handback이 든 fixture에서 보고가 표시와 함께 메시지로 들어가고 다른 peer 항목은 들어가지 않으며, 버전 2로 수집한 세션을 다시 넣으면 빠진 보고만 더해지고 기존 메시지의 seq·본문이 그대로이며, 이 Mac transcript의 구조만 센 보고 누락 비율(수정 전 약 58%)을 plan에 남긴다."
- covers = ["E2-4"], after = [7, 12], hitl = false, risk = "medium"
- references: 2.7 plan(`story-transcript-parser-plan.md`) Decision "애매한 user 항목은 빼는 쪽", 이 change D10

**id 17 — 마스킹 B: 나갈 때 가리기로 바꾸기** (D1, D4)
- description: "2.9가 수집 경로에 넣은 가리기를 뺀다(`sessions.ingest` use case의 `maskSecrets` 호출, `IngestMessage.redactions`, Store가 수집 중 쓰는 `redactions` 행, `IngestCounts.redactions`). 메시지 본문과 도구 메모 대상은 원문 그대로 저장한다. `maskSecrets`는 Core의 출력 가리기 함수로 남기고, Core의 출력 코덱(엔벨로프 코덱의 `data`·`error`·`warnings`·`meta` 문자열, hook 출력 코덱)이 그것을 부르게 한다. 도구 메모 대상 칸은 `tool_target` 규칙으로 가린다. 출력 코덱 등록부와 계약 테스트를 둔다: 비밀 fixture를 수집한 뒤 등록된 모든 코덱의 출력에 값이 없고 저장본에는 있어야 하며, 등록하지 않은 코덱이 있으면 테스트가 실패한다(미러·내보내기·복제·임베딩 코덱은 그것을 만드는 에픽이 등록한다). 2.9가 미룬 패턴 문제 셋을 고친다: 영어 키워드 값이 평범한 코드·문장까지 가리는 것, 한국어 '비밀번호 X'·'비밀번호가 X'를 놓치는 것, 값이 `!` 같은 구두점에서 끊겨 뒤가 남는 것. 그리고 `SECRET_PATTERN_VERSION`을 '2'로 올린다(놓침은 넓히는 쪽, 과잉 가림은 값 모양 규칙으로; 세부는 plan, 2026-10-19 change-masking-b-and-review-fixes D1·D4)."
- verify: "비밀 fixture를 수집하면 `messages.body`·`tool_notes.target`이 transcript와 글자 단위로 같고 수집이 `redactions`에 행을 쓰지 않으며, 그 세션을 내보내는 `--json` 응답·텍스트 출력·hook 출력에 비밀값이 없고, 등록하지 않은 출력 코덱이 있으면 테스트가 실패하며, `let token = parse(input);`·`secret: see the README`·`{\"token\": 123}`은 그대로 나오고 `비밀번호 Tiger2024`·`비밀번호가 Tiger2024`·`password: Pa!ss2024`는 값 전체가 가려진다."
- covers = ["E2-8"], after = [9, 12, 19], hitl = false, risk = "high"
- references: 2.9 plan(`story-untitled-9-plan.md`) Review Triage Log와 frontmatter `deferred`, 이 change D1·D4

**id 18 — 마이그레이션 0005: 도구 메모 가리기 기록·실패 단계 강제·프로젝트 비교 키** (D5, D7, D9)
- description: "SQLite 다섯 번째 마이그레이션으로 다음을 더한다.
  - `redactions`에 `tool_note_id`(→ `tool_notes.id`)를 더하고 대상을 `message_id`·`file_id`·`tool_note_id` 중 하나만으로 한다. 도구 메모 가리기의 위치는 그 대상 위의 구간이다. 0004와 같은 재생성이고 불변 trigger를 유지한다.
  - `document_extractions`에 trigger를 둔다. `failed`가 되는 insert·update에는 `failed_stage`가 있어야 한다. 이미 `failed`인 0004 이전 행은 건드리지 않는다.
  - `projects`에 비교 키 `identity_key`(not null, UNIQUE)를 더한다. 기존 행은 `github.com/`·`bitbucket.org/`로 시작하면 소문자로, 그 밖은 그대로 채운다. `remote_identity`는 표시용으로 남는다.

  그리고 `SQLITE_SCHEMA_VERSION`을 5로 올린다. 동작은 13(도구 메모 가리기), 20(비교 키), epic-attachments(추출 실패)가 만든다."
- verify: "버전 4 DB가 데이터를 보존한 채 5가 되고, 대상이 둘이거나 없는 `redactions` 행과 `failed_stage` 없이 `failed`가 되는 추출 세대와 비교 키가 같은 두 프로젝트가 거부되며, 0004 이전의 `failed` 행은 그대로 읽히고, 마이그레이션 재실행이 `applied=[]`이다."
- covers = ["E2-10"], after = [6, 17], hitl = false, risk = "medium"
- references: 2.6 plan(`story-0004-plan.md`) Decision 3, deferred-work 도구 메모 가리기 기록 행

**id 20 — 정체성 보강: 대소문자 비교 키와 비어 있는 꼬리표 다시 채우기** (D7, D8)
- description: "Core 정규화에 비교 키 함수를 더한다(대소문자를 구분하지 않는 호스트 목록은 Core 상수, 처음은 `github.com`·`bitbucket.org`; 그 호스트면 정체성을 소문자로 접고, 그 밖의 호스트와 로컬 공통 디렉터리 정체성은 그대로). Store는 프로젝트를 18의 `identity_key`로 찾거나 만든다(표시는 처음 본 `remote_identity`). `RepositoryInspector.inspect`의 결과를 checkout·레포 아님·모름(git 없음, 시간 초과, 권한, 비정상 출력) 셋으로 나눈다. 모름이면 꼬리표 없이 수집하고 그 세션의 `session_identity` 일감을 남긴다. drain은 그 일감에서 12의 세션 토큰 수집 경로로 transcript 첫 메시지 cwd를 다시 읽어 묻는다. 성공하면 비어 있던 꼬리표를 한 번 채운다(null → 값만, 이미 있으면 그대로; 레포 아님이면 일감을 닫는다). 끝내 실패하면 11의 실패 기록 함수로 `failures`에 남겨 doctor가 보인다."
- verify: "`github.com/Owner/Repo`와 `github.com/owner/repo` remote의 두 세션이 한 프로젝트이고 목록에 없는 호스트의 대소문자만 다른 두 remote는 두 프로젝트이며, git을 찾을 수 없게 한 채 연 세션은 꼬리표 없이 수집되고 git을 되돌린 뒤 drain이 꼬리표를 채우며, 레포 밖 세션에는 일감이 남지 않고, 꼬리표가 있는 세션은 drain이 바꾸지 않는다."
- covers = ["E2-6"], after = [8, 11, 12, 18], hitl = false, risk = "medium"
- references: 2.8 plan(`story-untitled-8-plan.md`) Decision "git 조회가 실패하면", "host 이름은 소문자", 이 change D7·D8

#### epic-capture `tickets.toml` — 기존 entry

- **13** (D5)
  - description OLD: "`brain messages redact`(SDK 확인 게이트, 메타 `risk: destructive`)가 한 쓰기 트랜잭션에서 본문 일부나 전체와 그 메시지의 도구 메모 대상을 `[REDACTED:<kind>]`로 바꾸고, `redactions`에 위치·종류·지운 내용의 해시를 남기고, …"
  - description NEW: "`brain messages redact`(SDK 확인 게이트, 메타 `risk: destructive`)는 저장본에서 지우는 사람의 가리기다(나갈 때의 가리기는 17). 입력은 메시지와 지울 글자 그대로(종류는 사람이 주거나 `manual`), 또는 `detected`(그 메시지에서 지금 패턴이 찾는 구간 전부, `pattern_version` 기록)다. 한 쓰기 트랜잭션에서 본문 일부나 전체와 그 메시지의 도구 메모 대상을 `[REDACTED:<kind>]`로 바꾸고, `redactions`에 위치·종류·지운 내용의 해시를 남기고(도구 메모 대상은 18의 `tool_note_id`, 위치는 그 대상 위), …(뒤는 그대로)"
  - verify에 더한다: "`detected`로 가린 메시지의 저장 본문에 패턴이 찾던 값이 없고, 도구 메모 대상 가리기가 `tool_note_id` 행으로 남는다"
  - after OLD `[1, 9, 12]` → NEW `[1, 12, 17, 18, 20]`
  - `unknown`을 지운다.
- **14**
  - after OLD `[5, 8, 9, 12, 13, "1.7"]` → NEW `[5, 8, 12, 13, 19, 20, "1.7"]`
  - `unknown`을 지운다.
- **15**: after에 17, 18, 19, 20을 더한다.
- **9**: notes에 더한다: "2026-10-19 마스킹 B(change-masking-b-and-review-fixes): 수집 경로의 가리기와 수집 중 `redactions` 쓰기는 17이 뺀다. 패턴 목록과 `maskSecrets`는 출력 함수로 남는다."

#### epic-capture.md

- **Description 15행**
  - OLD: "저장 전 비밀 마스킹과 `messages redact`를 만든다."
  - NEW: "비밀 가리기(저장은 원문, 나갈 때 가림 — 마스킹 B, 2026-10-18)와 저장본에서 지우는 `messages redact`를 만든다."
- **Outcome**
  - OLD: "Claude Code 세션이 손대지 않아도 비밀이 가려진 채 빠짐없이 쌓인다."
  - NEW: "Claude Code 세션이 손대지 않아도 원문 그대로 빠짐없이 쌓이고, Brain 밖으로 나가는 것에서는 비밀이 가려진다."
- **E2-4**: "…메인 대화의 본문과 서브에이전트 최종 보고" 뒤에 "(peer handback 포함, 19)"를 더한다.
- **E2-6**: 끝 괄호 앞에 "대소문자를 구분하지 않는 호스트의 비교 키, git 조회가 잠깐 실패한 세션의 꼬리표 다시 채우기(20, 2026-10-19)."를 더한다.
- **E2-8**
  - OLD: "E2-8 (CAP-2): 비밀 가리기 — 버전 있는 Core 패턴 목록과 저장 전 마스킹, `messages redact` 연쇄와 확인 게이트. (FR-26, AD-11)"
  - NEW: "E2-8 (CAP-2): 비밀 가리기 — 버전 있는 Core 패턴 목록과 출력 가리기 함수(저장은 원문, Core 출력 코덱이 가림, 출력 코덱 등록부와 계약 테스트), 저장본에서 지우는 `messages redact` 연쇄(`detected` 포함)와 확인 게이트. (FR-26, AD-11)"
- **E2-10 추가**: "E2-10 (CAP-2, CAP-1, CAP-14 스키마 자리): 마이그레이션 0005 — `redactions.tool_note_id`, `document_extractions`의 `failed_stage` 강제 trigger, `projects.identity_key`. 동작은 13·20과 epic-attachments. (AD-11·12·24, Table Contract)"
- **Done when 4**
  - OLD: "알려진 비밀 패턴이 든 세션의 저장 본문에 그 값이 없고, `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다."
  - NEW: "알려진 비밀 패턴이 든 세션을 수집하면 저장 본문은 원문 그대로이고, Core 출력 코덱(엔벨로프·hook 출력)을 지난 결과 어디에도 그 값이 없다. `brain messages redact`로 가린 부분은 DB 어디에도 남지 않는다(2026-10-19)."
- **Done when 5**: 끝에 더한다: "대소문자만 다른 GitHub·Bitbucket remote의 세션이 한 프로젝트로 묶이고, git 조회가 잠깐 실패한 세션의 꼬리표는 뒤따르는 일감이 채운다(2026-10-19)."
- **Boundaries**
  - "0004의 스키마(2.6, …)" 뒤에 "·0005(18)"를 더한다.
  - "AD-11 중 가린 메시지의 조각·미러 재생성 일감은 …" 앞에 더한다: "출력 가리기 함수와 엔벨로프·hook 출력 코덱의 적용은 이 에픽(17)이 한다. 미러·내보내기·복제·임베딩 요청은 그것을 만드는 에픽이 같은 함수를 부르고 등록부에 넣는다."
- **Notes에 더한다**
  - "Decision(2026-10-19, `../change-masking-b-and-review-fixes/`): 마스킹 B. 비밀은 저장할 때가 아니라 Core 출력 코덱에서 가린다. 2.9의 수집 경로 가리기는 17이 빼고, 미룬 패턴 문제 셋도 17이 고친다(패턴 버전 2). 결정 검토 수정으로 19(parser peer handback), 18(0005), 20(비교 키·꼬리표 다시 채우기)을 더했다. 13은 저장본 가리기로 남고 `detected`와 도구 메모 기록을 갖는다. 순서는 10→11→12→19→17→18→20→13→14→15다(사용자 승인으로 받아들임)."

#### 이후 에픽 Notes (인셉션 입력)

모두 "Note(2026-10-19, `../change-masking-b-and-review-fixes/`, 인셉션 입력):"로 시작한다.

| 에픽 파일 | 더할 Note |
| --- | --- |
| `epic-log-and-context.md` | 시작 맥락은 hook 출력 코덱이 가린다(AD-11). 작업 로그·규칙 문장은 원문으로 저장한다. 규칙 인용 대조는 저장된 원문과 하므로, 에이전트가 가린 출력에서 인용해 `[REDACTED:…]`가 든 인용은 대조가 실패한다. 양쪽을 가린 뒤 비교할지 인셉션에서 정한다 |
| `epic-recall-and-mirror.md` | 조회 결과·넓히기·세션 읽기는 엔벨로프 코덱이 가린다(D1). 조각·FTS는 원문 위이고, 비밀 값으로 찾으면 행은 나오되 값은 가려진다(D2). 미러 렌더러는 출력 코덱으로 등록한다. 미러는 (DB 상태, 패턴 버전)의 순수 함수이고 frontmatter에 버전을 적는다. 버전이 오르면 모든 세션의 미러 재생성 일감을 만든다(D3, AD-16) |
| `epic-operations.md` | 내보내기 writer는 출력 코덱으로 등록하고, manifest에 비밀 패턴 버전을 적는다. 내보내기에서 되살린 Brain의 비밀은 가린 채 돌아오고, 복구 확인의 건수 비교는 그대로 맞는다(D6) |
| `epic-embedding-index.md` | 임베딩·재순위 요청은 출력 코덱이고, 보내는 텍스트는 가린 텍스트다. 색인 행은 원문 조각을 가리킨다(AD-11·15) |
| `epic-daemon.md` | 소켓·MCP 응답은 같은 엔벨로프 코덱을 쓰므로 따로 가리지 않는다(AD-11) |
| `epic-replicas.md` | 복제 payload는 출력 코덱이다. 가린 텍스트를 보내고 패턴 버전을 적는다. 버전이 오르면 D5(change-users-and-review-gaps)의 복제 가리기 일감과 같은 경로로 다시 가린다. `setup move-store`는 복제본이 아니라 원본에서 복사해 원문을 잃지 않는다. Postgres는 0005만큼 더 갈라진다(deferred Triage) |
| `epic-drive.md` | Drive로 올리는 DB 스냅샷도 나가는 길이다. 가린 사본을 만들어 올리고, 그것으로 되살린 Brain의 비밀은 가린 채 돌아온다(D6). 첨부 원본 바이트는 가리지 않는다(`files.redact`가 그 길) |
| `epic-attachments.md` | 추출한 문서 텍스트는 원문으로 저장하고 나갈 때 가린다(AD-23 문구 변경, Description의 "추출 텍스트의 저장 전 마스킹"을 "추출 텍스트는 원문 저장, 출력에서 가림"으로 고친다). `failed`가 되는 추출 세대는 `failed_stage`가 있어야 하고 0005(2.18)의 trigger가 강제한다 |

#### initiative-personal-brain.md

- **Notes에 더한다**: "Decision(2026-10-19, `change-masking-b-and-review-fixes/`): 비밀은 저장할 때가 아니라 나갈 때 가린다(마스킹 B, 2026-10-18 사용자). Core 출력 코덱이 가리고, 색인은 원문 위다. 내보내기와 Drive 스냅샷도 가린다. 결정 검토 수정 넷(parser peer handback, 프로젝트 비교 키와 꼬리표 다시 채우기, `failed_stage` 강제, 도구 메모 가리기 기록)과 함께 epic 2에 스토리 17~20을 더했다(사용자)."

#### deferred-work.md Triage

| 항목 | 처분 OLD → NEW |
| --- | --- |
| 도구 메모 대상을 가린 기록 자리가 없음 | NEW: "마스킹 B로 수집은 도구 메모 대상을 가리지 않는다(원문 저장). 기록이 필요한 것은 2.13의 저장본 가리기뿐이고, 0005(story 18)의 `redactions.tool_note_id`가 맡는다(2026-10-19)" |
| `messages redact`(2.13)가 같은 문제를 만난다 | NEW: "story 18(자리)과 story 13(쓰기)(2026-10-19)" |
| Postgres가 0004만큼 더 갈라짐 | 끝에 더한다: "0005(`redactions.tool_note_id`, `failed_stage` trigger, `projects.identity_key`)도 epic 7" |
| Core 타입 행 | `Redaction` 문장 끝에 더한다: "`toolNoteId`는 story 13(18의 칸을 처음 쓸 때)" |
| (새 행) 2.9 deferred: 영어 키워드 과잉 가림, 한국어 표현 놓침 | "story 17(마스킹 B에서 패턴 버전 2로, 값 끊김 포함)" |
| (새 행) auto-build 커밋을 이력에서 빼기(2026-10-18) | "push 전, 사용자(티켓 밖). 끝나면 `app-ref`·`version`·`baseline_revision`·커밋 번호를 다시 맞춘다" |
| (새 행) 무인 루프 v2가 커밋을 기다리지 않음 | "저장소 밖 도구. 2.10~ 무인 실행 전에 고친다" |
| (새 행) 2.7 follow-up 리뷰 | "story 19의 리뷰로 한다(D10)" |
| (새 행) 백업 브랜치 `backup/pre-path-rewrite-2026-10-18` | "push 전에 지운다(사용자)" |

### 4.2 Architecture spine (적용: 승인 뒤 이 세션에서 직접. 문구가 정해져 있다)

**frontmatter**
- `updated: '2026-10-19'`
- `sources`에 `../change-masking-b-and-review-fixes/change-masking-b-and-review-fixes.md`, `../inputs/masking-b-and-review-fixes.md`를 더한다.

**AD-11** (D0, D1, D3, D5)
- 제목 OLD: "AD-11 — 원문 불변, 그리고 유일한 예외인 가리기"
- 제목 NEW: "AD-11 — 원문 불변, 나갈 때 가리기, 그리고 유일한 예외인 저장본 가리기"
- Prevents OLD: "코드 실수로 원문이 바뀌는 것, 비밀이 영구히 남는 것, 작업 로그의 현재 문장 위치가 단위마다 달라지는 것"
- Prevents NEW: "코드 실수로 원문이 바뀌는 것, 비밀이 Brain 밖으로 나가는 것, 패턴의 과잉 가림이 저장된 원문을 되돌릴 수 없게 망가뜨리는 것, 나가는 길 하나가 가리기를 잊는 것, 작업 로그의 현재 문장 위치가 단위마다 달라지는 것"
- 첫 항목 OLD: "**저장 전 마스킹**: 수집은 알려진 비밀 패턴(API 키, 토큰, 개인 키, `password=` 류)을 `[REDACTED:<kind>]`로 바꾼 뒤 저장한다. 패턴 목록은 Core에 하나만 두고 버전을 가지며, 가린 기록은 그 버전을 적는다(`redactions.pattern_version`)."
- 첫 항목 NEW(세 항목으로):

  > - **나갈 때 가리기**(마스킹 B, 2026-10-18 사용자): 수집은 본문과 도구 메모 대상을 Harness가 준 그대로 저장한다(추출한 문서 텍스트도 같다, AD-23). 알려진 비밀 패턴(API 키, 토큰, 개인 키, `password=` 류)은 Brain 밖으로 나갈 때 `[REDACTED:<kind>]`로 바뀐다. 패턴 목록과 가리기 함수는 Core에 하나만 두고 버전(`SECRET_PATTERN_VERSION`)을 가진다. 나가는 길은 Core의 **출력 코덱**이고 모두 그 함수를 부른다: 엔벨로프 코덱(CLI·MCP·소켓이 공유, `data`·`error`·`warnings`·`meta`의 문자열), hook 출력 코덱(시작 맥락), 미러 렌더러(AD-16), 내보내기 writer, 복제 payload(AD-22), 임베딩·재순위 요청(AD-15). Store와 adapter는 원문을 돌려주고, 출력 코덱을 거치지 않고 Brain 밖으로 텍스트를 내는 경로는 없다. 출력 가리기는 `redactions`를 남기지 않는다.
  > - 남아 있는 출력(미러 파일, 복제 대상)은 쓴 패턴 버전을 적는다. 버전이 오르면 미러 재생성 일감과 복제 가리기 일감을 만든다. 내보내기는 manifest에 버전을 적고, 이미 쓴 내보내기 파일은 건드리지 않는다.
  > - 저장소 파일(`brain.db`와 `-wal`·`-shm`)에는 비밀이 원문으로 있다. AD-10의 규칙(동기화 폴더 금지, 권한 0600)이 그것을 지킨다. 저장본에서도 지우려면 `messages.redact`를 쓴다.

- 둘째 항목: "**유일한 예외는 `messages.redact`**다." 뒤에 더한다: "사람이 요청해 저장본에서 지우는 가리기다. 입력은 지울 글자 그대로이거나 `detected`(지금 패턴이 그 메시지에서 찾는 구간 전부, `redactions.pattern_version`에 그 버전)다."
- 연쇄 항목 OLD 끝: "같은 경로로 `tool_notes.target`도 가린다(`messages.redact`가 메시지와 그 도구 메모를 함께 받는다)."
- 연쇄 항목 NEW 끝: "같은 경로로 `tool_notes.target`도 가린다(`messages.redact`가 메시지와 그 도구 메모를 함께 받고, 기록은 `redactions.tool_note_id`, 0005)."
- 계약 테스트 항목 끝에 더한다: "출력 코덱 계약: 비밀 fixture를 수집하면 저장본에는 원문이 있고, 등록된 모든 출력 코덱의 결과에는 없다. 코덱을 새로 만들고 등록부에 넣지 않으면 테스트가 실패한다(2026-10-19)."
- 위치 항목
  - OLD: "`redactions`의 위치 `[start, end)`는 그 가리기 직전 본문 위의 구간이다(저장 전 마스킹이면 마스킹 전 원문, story 1.3)."
  - NEW: "`redactions`의 위치 `[start, end)`는 그 가리기 직전 대상(본문 또는 도구 메모 대상) 위의 구간이다. 수집이 남기던 저장 전 마스킹 기록은 마스킹 B로 없어졌다(2026-10-19)."

**AD-12** (D7, D8)
- 꼬리표 항목 끝("…2026-10-15 epic 2 인셉션, 리뷰 H-2 해소).") 뒤에 더한다:

  > git 조회가 "레포가 아님"이 아닌 이유(git 없음, 시간 초과, 권한, 비정상 출력)로 답을 못 하면 꼬리표 없이 수집하고 그 세션의 `session_identity` 일감(AD-21)을 남긴다. 그 일감이 성공하면 비어 있던 꼬리표를 한 번 채운다(null → 값만). 끝내 실패하면 `failures`로 가고 doctor가 보인다(2026-10-19).

- 정체성 항목 끝("…폴더가 지워져도 행은 남는다.") 뒤에 더한다:

  > 프로젝트는 비교 키 `identity_key`로 찾는다. 대소문자를 구분하지 않는 호스트(Core 상수 목록, 처음은 `github.com`·`bitbucket.org`)는 정체성을 소문자로 접은 값이고, 그 밖은 정체성 그대로다. `remote_identity`는 처음 본 모양 그대로의 표시용이다(2026-10-19).

**AD-15** (D2): "질의는 Core의 함수 하나가 만든다: …" 항목 뒤에 새 항목을 더한다.

> - 색인(조각·FTS·임베딩 대상)은 원문 위에 만든다. 결과는 엔벨로프 코덱에서 가려지므로(AD-11), 비밀 값으로 검색하면 맞는 행이 나오되 값은 가려진다(이 기계 안의 일이라 허용, 2026-10-19). 임베딩·재순위로 보내는 텍스트는 가린 텍스트다.

**AD-16** (D3)
- OLD: "내용은 그 세션의 DB 상태만으로 정해지는 순수 함수다(frontmatter + 메시지 + 도구 메모)."
- NEW: "내용은 그 세션의 DB 상태와 비밀 패턴 버전으로 정해지는 순수 함수다(frontmatter + 메시지 + 도구 메모. 본문은 AD-11대로 가리고, frontmatter에 패턴 버전을 적는다)."

**AD-23**
- OLD: "첨부 텍스트의 저장 전 마스킹은 추출 시점에 Core의 같은 패턴 목록으로 한다(바이트는 그대로)."
- NEW: "추출한 문서 텍스트는 원문으로 저장하고 나갈 때 같은 함수로 가린다(AD-11). 파일 바이트는 가리지 않는다(`files.redact`가 그 길이다)."

**AD-24**: "…실패하면 `failed_stage(read | extract | chunk | index)`)이고, 조각(`document_chunks`)은 그 행에 속한다." 뒤에 더한다: "`failed`가 되는 쓰기는 `failed_stage`를 가져야 하고 trigger가 강제한다(0005, 그 이전 행은 예외, 2026-10-19)."

**Table Contract**
- `projects`
  - OLD: `| \`projects\` | \`remote_identity\` | \`sessions.ensure\` (find-or-create) | 불변. \`workspace_id\`는 예약(slice 1은 쓰지 않음) |`
  - NEW: `| \`projects\` | \`identity_key\`(대소문자 비교 키, AD-12) | \`sessions.ensure\` (find-or-create) | 불변. \`remote_identity\`는 표시용. \`workspace_id\`는 예약(slice 1은 쓰지 않음) |`
- `sessions`
  - "불변: 키, `user_id`(→ `users.id`), `machine`, `started_at`, 꼬리표, …"의 "꼬리표"를 바꾼다: "꼬리표(비어 있으면 `session_identity` 일감이 한 번 채울 수 있음, AD-12)"
- `redactions`
  - OLD: `| \`redactions\` | \`id\` | \`messages.redact\`, \`files.redact\`, 수집·추출의 저장 전 마스킹(\`pattern_version\` 기록) | 불변 |`
  - NEW: `| \`redactions\` | \`id\`. 대상은 \`message_id\`·\`file_id\`·\`tool_note_id\` 중 하나 | \`messages.redact\`(본문과 도구 메모 대상. \`detected\`면 \`pattern_version\` 기록), \`files.redact\`. 수집·추출은 쓰지 않는다(마스킹 B, AD-11) | 불변 |`

**ER 다이어그램**: `messages ||--o{ redactions : "redacted by"` 아래에 더한다.

```
  tool_notes ||--o{ redactions : "redacted by"
  files ||--o{ redactions : "redacted by"
```

**Conventions**
- 텍스트
  - OLD: "저장 본문은 Harness가 준 그대로(마스킹 제외)."
  - NEW: "저장 본문은 Harness가 준 그대로(사람이 요청한 저장본 가리기 제외). Brain 밖으로 나가는 텍스트는 Core 출력 코덱의 가리기를 거친다(AD-11)."
- 내보내기
  - "`manifest.json`(스키마 버전, 테이블별 건수, 시각)"을 "`manifest.json`(스키마 버전, 테이블별 건수, 시각, 비밀 패턴 버전)"으로 바꾼다.
  - 끝에 더한다: "본문은 AD-11대로 가린 텍스트다. 그래서 되살린 Brain의 비밀은 가린 채 돌아온다(2026-10-19)."

**Capability → Architecture Map**
- OLD: `| 원문 불변·가리기 (NFR-1, FR-26) | sqlite trigger, \`messages.redact\` | AD-11 |`
- NEW: `| 원문 불변·가리기 (NFR-1, FR-26) | sqlite trigger, \`messages.redact\`, Core 출력 코덱(엔벨로프·hook·미러·내보내기·복제·임베딩 요청) | AD-11 |`

### 4.3 PRD

- **frontmatter**: `updated: 2026-10-19`
- **FR-1 Consequences**
  - OLD: "저장된 본문은 Harness가 보여 준 텍스트와 글자 단위로 같다. 요약·번역·절단이 없다. 예외는 비밀 가리기(FR-26) 하나다."
  - NEW: "저장된 본문은 Harness가 보여 준 텍스트와 글자 단위로 같다. 요약·번역·절단이 없다. 예외는 내가 요청한 저장본 가리기(FR-26) 하나다. 알려진 비밀은 저장할 때가 아니라 나갈 때 가린다(2026-10-18)."
- **FR-26 전문**
  - OLD 첫 문장: "대화에 들어간 API 키, 토큰, 비밀번호가 Brain에 남지 않게 한다."
  - NEW:

    > 대화에 들어간 API 키, 토큰, 비밀번호가 Brain 밖으로 나가지 않게 한다(2026-10-18 변경: 저장은 원문, 나갈 때 가림).
    >
    > **Consequences (testable):**
    > - 수집은 대화를 원문 그대로 저장한다. Brain 밖으로 나가는 모든 것(시작 맥락, 조회 결과, 미러, 내보내기, 복제 대상, 임베딩·재순위 전송)에서는 알려진 비밀 패턴이 가려지고, 그 자리에는 종류만 남는다.
    > - 패턴을 고치면 다음 출력부터 새 패턴이 쓰이고, 이미 써 둔 미러와 복제 대상은 다시 만들어진다. 저장된 원문은 패턴 때문에 바뀌지 않는다.
    > - 이미 저장된 메시지에 비밀이 있으면 나나 에이전트가 그 부분을 저장본에서도 지울 수 있다. 지운 내용은 어디에도 보존되지 않고, 지운 위치·종류·시각만 남는다.
    > - 저장본에서 지우기는 원문을 바꾸는 유일한 경로다. 지운 세션의 미러와 이후 내보내기에도 지운 본문이 쓰인다.
    > - Brain의 저장소 파일에는 원문이 그대로 있다. 그 파일은 동기화 폴더에 두지 않고 나만 읽을 수 있다.
    >
    > **Out of Scope:** Harness가 따로 보관하는 원본 transcript 파일.

- **NFR-1**
  - OLD: "유일한 예외는 비밀 가리기(FR-26)다."
  - NEW: "유일한 예외는 저장본에서 지우는 비밀 가리기(FR-26)다."
- **NFR-6**: "어떤 서비스로 무엇이 나가는지 설정과 점검에 드러난다." 앞에 더한다: "Brain 밖으로 나가는 텍스트(미러, 내보내기, 임베딩·재순위 전송, 복제 대상)에서는 알려진 비밀이 가려진다(FR-26)."

### 4.4 Spec

- **CAP-2**
  - intent OLD: "대화에 들어간 키·토큰·비밀번호가 Brain에 남지 않는다."
  - intent NEW: "대화에 들어간 키·토큰·비밀번호가 Brain 밖으로 나가지 않는다(저장은 원문, 2026-10-18)."
  - success OLD: "알려진 패턴의 비밀이 든 세션을 수집하면 저장 본문에 그 값이 없다. 저장된 메시지의 일부를 가리면 DB·미러·내보내기 어디에도 원래 값이 남지 않고, 위치·종류·시각만 남는다."
  - success NEW: "알려진 패턴의 비밀이 든 세션을 수집하면 저장 본문은 원문 그대로이고, 시작 맥락·조회 결과·미러·내보내기 어디에도 그 값이 없다. 저장된 메시지의 일부를 저장본에서 가리면 DB·미러·내보내기 어디에도 원래 값이 남지 않고, 위치·종류·시각만 남는다."

## 5. Implementation Handoff

**범위 분류: Moderate.** 백로그 재정리(새 스토리 넷, 기존 셋의 선행 관계)와 spine 문단 보강이다. 요구 범위·에픽 구조·MVP는 그대로다.

| 순서 | 할 일 | 누가 |
| --- | --- | --- |
| 1 | 이 제안과 D1~D11 승인 | 사용자 |
| 2 | §4.2~4.4 문서 편집. 문구가 정해져 있으므로 이 세션에서 직접 한다 | Dev(이 세션) |
| 3 | §4.1 티켓: epic 2 새 entry 넷과 13·14·15·9, epic-capture.md, 이후 에픽 Notes 8개, initiative Notes, deferred Triage. `bmad-ticket` | PO(`bmad-ticket`) |
| 4 | 2.10 → 2.11 → 2.12는 그대로 진행한다(승인 전에도 됨) | Dev(`bmad-build`) |
| 5 | 2.19 → 2.17 → 2.18 → 2.20 → 2.13 → 2.14 → 2.15 | Dev(`bmad-build`) |

**성공 기준.**
1. spine·PRD·spec·epic 2의 규칙 문장에 "저장 전 마스킹"이 남지 않는다(기록 문서·옛 change·inputs·built plan은 그대로). AD-11 첫 항목이 나갈 때 가리기이고, 출력 코덱 목록과 계약 테스트 문장이 있다.
2. `bmad-ticket` status에서 13·14에 `unknown`이 없고, 13은 17·18·20 뒤, 14는 13·19·20 뒤에 막혀 있으며, 순서 충돌(`order_conflict`)이 0이다.
3. epic 2에 E2-10이 있고 Done when 4·5가 바뀌었으며, 새 스토리 넷이 E2-4·6·8·10에 걸려 있다.
4. 이후 에픽 Notes 8개에 이 change가 걸려 있다.
5. deferred Triage에 2.9 deferred 둘과 2026-10-18 항목 넷의 처분이 있다.
6. 17이 끝나면 수집이 `redactions`를 쓰지 않고, 비밀 fixture의 저장 본문은 원문이며, 등록된 출력 코덱 어디에도 비밀이 없다.

## 6. Approval & Handoff Log

- 2026-10-19 초안 작성(batch). 입력은 `inputs/masking-b-and-review-fixes.md`(2026-10-18 사용자 결정). D0는 확정이고, 사용자 결정 대기는 D1~D11(§3)이다.
- 2026-10-19 **승인**(사용자, "계속"). D1~D11 권고대로 확정. 범위 Moderate. §4.2~4.4 문서 편집을 이 세션에서 적용하고, §4.1은 `bmad-ticket`으로 넘긴다.
- 2026-10-19 문서 편집 적용: spine 22곳(+ frontmatter), PRD 5곳, spec 2곳. `bmad-ticket` 반영(§4.1): epic 2 entry 19·17·18·20 추가, 13·14·15·9 수정, `unknown` 둘 제거, epic-capture.md, 이후 에픽 Notes 8개(epic-attachments Description 한 구절 포함), initiative Notes, deferred Triage. `tickets.py status`: 순서 충돌 0, 체인 10→11→12→19→17→18→20→13→14→15.
- 2026-10-19 Set·Ticket·Dependencies 검증(서브에이전트). 반영: 17 verify를 코덱 계약 테스트로(이 에픽에는 저장 본문을 내는 명령이 없다), 18 verify에 위치 없는 `tool_note_id` 행 거부, epic Notes에 17 크기와 순서의 이유. 사용자 결정 대기: 18의 `identity_key` 역채우기 충돌, 17의 `tool_target` 규칙을 엔벨로프 코덱에서 구분하는 방법.
- 2026-10-19 사용자 결정(검증의 ask 둘): (1) 대소문자만 다른 이름은 같은 프로젝트다. 다만 이미 갈라진 행이 있으면 setup이 그 사실을 알리고, 합칠지 물은 뒤 진행한다. 동의하면 먼저 만든 프로젝트로 합치고, 거절하면 DB를 바꾸지 않는다(D7 보강; 18, spine AD-12). (2) 셸 규칙은 (a)다. 도구 메모를 돌려주는 읽기 결과가 그 칸에만 먼저 걸고, 코덱은 모든 문자열에 본문 규칙을 건다(D1 보강; 17, spine AD-11). 반영 완료.
