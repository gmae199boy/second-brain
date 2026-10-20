---
title: '기록 규율 점검(Stop hook), 지표 명령, 검색 회귀 러너와 집계 모드'
type: sprint-change-proposal
created: '2026-10-20'
status: approved
approved: '2026-10-20'
scope: moderate
mode: batch
trigger: '2026-10-20 설계 대화 — 벤더 채팅 메모리(ChatGPT·Claude·Gemini)·graphify와 비교한 뒤 보강 제안 7개를 검증. 4개 채택, 1개 Deferred(조건부), 2개 보류'
inputs:
  - ../prd-brain-v1-slice-1/addendum.md
  - ../epic-capture/epic-capture-research.md
  - ../architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md
---

# Sprint Change Proposal — 기록 규율 점검, 지표, 검색 회귀·집계

> 제안 문서다. §4.3은 2026-10-20에 spine에 반영됐다(리뷰 게이트 포함, `architecture-brain-v1-slice-1/.memlog.md`). 승인 뒤 소유 스킬이 spine·PRD·addendum·에픽 파일에 적용하고, 적용이 끝나면 이 문서 머리에 "반영 완료"를 적는다. **적용은 다른 세션의 story 2.18 작업이 커밋된 뒤에 한다**(그 세션이 `deferred-work.md`·README·코드를 쓰고 있다). 이 문서는 그 세션이 건드리지 않는 새 폴더 하나다.

## 0. 체크리스트 상태

| 항목 | 상태 | 메모 |
| --- | --- | --- |
| 1.1 트리거 스토리 | [x] | 특정 스토리가 아니라 설계 대화. story 2.18(0005) in-review 중, epic 3·4·5·9는 인셉션 전(폴더에 `tickets.toml` 없음) |
| 1.2 문제 정의 | [x] | 유형: 설계 보강(측정 수단 누락) + 새 요구(기록 규율의 두 번째 수단). 기술 한계나 실패한 접근은 아님 |
| 1.3 근거 | [x] | §1 |
| 2.1 현재 에픽 | [x] | epic 2는 그대로 완료 가능. 변경 없음 |
| 2.2 에픽 변경 | [x] | §2.1. epic 3·4·5에 인셉션 입력. 새 에픽 없음 |
| 2.3 이후 에픽 | [x] | §2.1. epic 6·7·8·9 영향 없음 |
| 2.4 무효화·신설 | [N/A] | 없음 |
| 2.5 순서 | [x] | 바꾸지 않는다. `mcp serve` 선행은 Deferred(조건부) |
| 3.1 PRD | [x] | §4.2 — §6.2 행 하나, §8-3·§8-8 괄호 주석. FR·MVP 변경 없음 |
| 3.2 Architecture | [x] | §4.3 — AD-5 표 두 행, AD-6·15·17·18 한 줄씩, Table Contract 한 칸, Deferred 네 행 |
| 3.3 UX | [N/A] | UX 문서 없음 |
| 3.4 기타 산출물 | [x] | addendum §4·§8, 플러그인 `hooks.json`(epic 3이 줄 추가), `tooling/eval`(새 패키지), 설정 키 하나 |
| 4.1 직접 조정 | [x] Viable | 노력 소~중, 위험 낮음 |
| 4.2 되돌리기 | [x] Not viable | 되돌릴 것 없음 |
| 4.3 MVP 축소 | [x] Not viable | FR·CAP은 그대로. 재는 수단과 규율 수단만 더한다 |
| 4.4 선택 | [x] | Option 1 직접 조정(인셉션 입력) |
| 5.x 제안 구성 | [x] | §1~§5 |
| 6.3 승인 | [x] | §6. 2026-10-20 사용자 승인, 조건: 적용은 story 2.18 세션의 커밋 뒤 |

## 1. Issue Summary

**트리거.** 2026-10-20, Brain을 ChatGPT·Claude·Gemini의 채팅 메모리와 graphify에 견주는 설계 대화를 했다. 결론은 두 가지였다. 벤더 메모리와의 차이는 "LLM이 다시 쓴 사실 문장" 대 "원문·출처·시간"이고 Brain은 이 거래를 의도적으로 한 것이라 바꿀 것이 없다. graphify는 대체재가 아니라 가끔 미러 위에 돌리는 분석 층이라 도입하지 않는다. 그 다음 "그러면 보강할 것이 있는가"를 물어 제안 7개를 냈고, 이 문서는 그것을 모듈 도움말·spine·PRD addendum·hook 실측·규모 시험과 대조해 검증한 결과다.

**문제 정의.** 두 갈래다.

1. **측정 수단이 없다.** 이니셔티브 Done when 2·3은 2주 실사용에서 SM-1·2·3·4를 재라고 하는데, 재는 티켓이 없다. 기계가 셀 수 있는 지표(SM-4a·SM-5·SM-C1·SM-C3, PRD §8-8의 대리 지표)도 사람이 세야 한다. SM-3 채점표는 보고서 문서로만 있어 랭킹을 바꿀 때 회귀가 보이지 않고, 확장 채점표의 "집계" 유형은 결과 계약(top-5, 8,000자)으로는 답할 수 없다(addendum §8).
2. **기록 규율의 수단이 안내문 하나다.** Brain은 LLM을 부르지 않으므로 로그 품질은 에이전트가 그 순간 적느냐에 전부 달려 있다(SM-4가 가장 큰 리스크). addendum §4가 "Stop hook으로 아직 안 적은 결정이 있나 점검"을 후보로 적어 두었지만 채택되지 않았다.

**사용자 결정(2026-10-20).** (1) Codex 등 두 번째 하네스 수집은 slice 1에 넣지 않는다. 수집 주체는 상관없고 Core가 급하다. spine Deferred에 조건만 적는다. (2) 제안서는 이 세션에서 만들고, 적용은 story 2.18 세션의 커밋 뒤에 한다.

**근거.**
- Claude Code hooks 문서(2026-10-20 조회): Stop hook은 top-level `decision: "block"`과 `reason`으로 모델이 계속 일하게 하고, Stop·SubagentStop은 `hookSpecificOutput.additionalContext`도 받는다. UserPromptSubmit은 stdout 또는 `additionalContext`로 프롬프트 옆에 맥락을 넣고 상한은 10,000자다. `last_assistant_message`는 Stop stdin에 있다.
- `epic-capture-research.md` §1(2026-10-15 실측): Stop stdin에 `stop_hook_active`가 있다. 비동기 hook은 아무것도 막지 못한다 → 점검 hook은 동기여야 한다.
- addendum §4: 플러그인 행에 "`Stop`·`PreCompact` hook으로 '아직 안 적은 결정이 있나' 점검 가능"이 후보로 있다. §8: "집계: 조각 top-5로는 셀 수 없다".
- addendum §1 규모 시험(2026-10-08): 한영 교차 4문항을 grep + 에이전트 질의 바꾸기만으로 풀었다 → 용어 대응표는 근거가 "이미 된다"라 보류.
- 이 Mac에 `~/.codex/sessions`가 있고 레코드가 `session_meta`·`event_msg`로 단순하며, 규모 시험이 Codex 세션 125개를 읽었다 → 두 번째 parser는 기술적으로 작다. 다만 사용자 결정 (1)로 slice 1 밖.
- `context_injections`(0001)에 `chars`는 있으나 지연 칸이 없다 → SM-7 내부 시간은 기록 칸이 있어야 센다.

## 2. Impact Analysis

### 2.1 에픽

| 에픽 | 상태 | 영향 |
| --- | --- | --- |
| 2 세션 수집·비밀 가리기 | 진행(2.18 in-review, 남은 순서 21→22→23→20→13→14→15) | **없음.** 이 제안은 epic 2의 어떤 스토리도 바꾸지 않는다 |
| 3 작업 로그·시작 맥락 | 인셉션 전 | **중.** 새 스토리 하나: Stop hook 기록 점검(`log remind`, 설정 토글, 세션당 한 번, 읽기 전용 + spool 기록). `context_injections`에 `kind`·`elapsed_ms` 칸(epic 3의 마이그레이션). Done when 한 항목 추가 |
| 4 조회·미러 | 인셉션 전 | **소.** `recall chunks|logs|docs --count`(결과 계약 한 줄). Done when 2를 "검색 회귀 러너 + 저장소 밖 문항 파일"로 구체화. `tooling/eval` 패키지 |
| 5 운영 | 인셉션 전 | **소.** 새 스토리 하나: `stats show`(기계가 셀 수 있는 지표, 기간 필터). Done when 한 항목 추가 |
| 9 데몬·MCP | 인셉션 전 | 없음. `mcp serve`를 떼어 앞당기는 것은 Deferred 조건부 |
| 6·7·8 | 인셉션 전 | 없음 |
| 이니셔티브 | — | Notes에 Decision 한 줄. Done when 2의 2주 실측 방식 보강(첫 주 토글 꺼짐, 둘째 주 켜짐) |

### 2.2 문서

- **PRD:** §6.2 표에 행 하나(웹 채팅 내보내기 가져오기), §8-3·§8-8에 괄호 주석, frontmatter `updated`. FR·NFR·SM 본문은 바뀌지 않는다.
- **PRD addendum:** §4 표의 플러그인 행에 채택 표시, §8 끝에 두 단락(회귀 러너는 SM-3과 별개의 기계 지표, 집계 유형은 `--count`).
- **spec:** 변경 없음. CAP-10 success가 "AD-5 표의 slice 1 명령이 모두 있다"이므로 표에 더하는 두 verb가 자동으로 포함된다. Non-goals("프롬프트마다 맥락을 밀어 넣는 것")은 Stop hook 점검과 충돌하지 않는다 — 주입이 아니라 세션당 한 번의 질문이다.
- **Architecture spine:** AD-5 표(`log remind`, `stats show`), AD-6(동기 Stop 점검 경로도 읽기 전용 + spool), AD-15(결과 계약에 `--count`), AD-17(규율의 수단에 Stop 점검 한 문장), AD-18(설정 키 `[discipline] stop_remind`), Table Contract(`context_injections` 작성자에 `log.remind`), Deferred 표(Codex 행 갱신, 웹 채팅·용어 대응표·`mcp serve` 선행 세 행 추가).
- **에픽 파일:** epic-log-and-context, epic-recall-and-mirror, epic-operations의 Description·Done when·Notes(인셉션 입력).
- **deferred-work.md:** 건드리지 않는다. 여기 적는 Deferred는 spine 표로 간다(설계 수준의 미룸이라 그쪽이 맞고, 그 파일은 2.18 세션이 쓰고 있다).

### 2.3 기술·기타 산출물

- **플러그인 `hooks.json`:** epic 3이 SessionStart 동기 `context show` 줄과 함께 **동기 Stop 줄**을 더한다. 2.14가 더하는 비동기 Stop 수집 줄과 공존한다(같은 이벤트에 hook 둘). 런처·`|| exit 0`·timeout은 기존 규칙 그대로.
- **설정:** `[discipline] stop_remind`(bool, 기본 false). 설치기는 묻지 않는다(질문을 늘리지 않는다). 설정 코덱에 키를 더한다(AD-18, 모르는 키 경고 규칙 때문).
- **런타임 상태:** `<home>/run/stop-remind/<harness>-<harness_session_id>` 표식 파일(세션당 한 번의 근거. 설정이 아니라 사실, AD-18·19).
- **스키마:** epic 3의 마이그레이션에 `context_injections.kind`(`start | stop`, 기본 `start`)와 `elapsed_ms`(nullable). 기존 행은 `start`.
- **코드:** 새 패키지 `tooling/eval`(SDK로 읽기 전용 검색, 문항 파일은 저장소 밖). Core 상수: 과거형 단서 목록, `STOP_REMIND_MIN_USER_TURNS`, 점검 문장(규율 원본 상수 옆, AD-17).
- **데이터:** 옮길 것 없음.
- **보안·공개 저장소:** 문항 파일과 결과는 실제 대화를 담으므로 `~/.second_brain/eval/`에만 둔다. 저장소에는 러너와 중립 fixture 하나만.

## 3. Recommended Approach

**Option 1 직접 조정.** 인셉션 전 에픽 셋에 입력을 더하고 spine·PRD·addendum을 문장 수준으로 맞춘다. epic 2의 진행과 순서는 그대로다.
- 노력: 소~중. 스토리 둘(3.x Stop 점검, 5.x `stats show`)과 epic 4 안의 작은 항목 둘. 문서 편집은 한 세션.
- 위험: 낮음. 모두 읽기 전용 경로이거나 측정이다. Stop 점검의 실패는 `|| exit 0`으로 삼켜져 세션 종료를 막지 않는다(NFR-3).
- 일정: epic 3·5에 스토리 하나씩. V1 경로(1·2·10·3·4·5)는 그대로.

### 정할 것 (D1~D8). 권고는 굵게.

| # | 질문 | 선택지 | 권고와 이유 |
| --- | --- | --- | --- |
| D1 | Stop 점검의 조건과 출력 | (a) 동기 Stop hook이 `brain log remind`(hook 경로, 읽기)를 부른다. 조건 셋이 모두 맞을 때만 `{"decision":"block","reason":<규율 문장>}`: `stop_hook_active`가 false, 이 세션의 사용자 발화가 `STOP_REMIND_MIN_USER_TURNS`(처음 3) 이상, `log_entries`에 이 세션의 줄이 0. 그 밖에는 출력 없이 exit 0. 사용자 발화 수는 hook stdin의 `transcript_path`를 parser로 읽어 센다(수집 지연과 무관) (b) UserPromptSubmit마다 "로그를 적어라"를 넣는다 (c) SessionEnd에서 점검 | **(a)**. (b)는 spec Non-goal(프롬프트마다 주입)이고 (c)는 JSON 출력이 버려진다(연구 §1). reason 문장은 AD-17의 규율 원본 상수 옆에 두고 "기록할 게 없는 것도 정상이다. 없으면 없다고 말하고 끝내라"를 포함한다 — 모델이 억지 로그를 쓰지 않게 하고, SM-C3가 그 반대쪽을 지킨다 |
| D2 | 세션당 한 번을 어떻게 보장하나 | (a) `<home>/run/stop-remind/<세션>` 표식 파일. 있으면 점검하지 않는다. 시도는 spool에 써서 drain이 `context_injections(kind='stop')`로 넣는다 (b) `context_injections`를 읽어 판단 (c) `stop_hook_active`만 본다 | **(a)**. (b)는 spool이 아직 drain되지 않은 사이 두 번 묻는다(hook 경로는 기회적 drain 예외, AD-7). (c)는 턴마다 다시 false가 되어 턴당 한 번이 된다. 표식은 사실 파일이라 AD-6(동기 경로 쓰기 트랜잭션 없음)을 지킨다 |
| D3 | 토글과 측정 | (a) `[discipline] stop_remind` 기본 false. 2주 실사용의 첫 주는 꺼짐, 둘째 주는 켜짐. `stats show --from --to`로 SM-4a를 주 단위로 비교해 기본값을 정한다 (b) 기본 true | **(a)**. 효과를 재지 않고 켜면 §8-3의 질문("안내만으로 충분한가")에 답이 안 남는다 |
| D4 | `stats show`의 범위 | (a) 기계가 셀 수 있는 것만: SM-4a(로그 ≥1 세션 비율), SM-5(transcript 폴더 파일 수 − 세션 수, doctor와 같은 함수), SM-C1(시작 맥락 `chars` 중앙값), SM-C3(세션당 로그 중앙값), SM-7 내부 시간(`elapsed_ms` 중앙값, 기록이 있을 때), §8-8 대리 지표(과거형 단서가 든 사용자 발화 뒤 같은 세션의 도구 메모에 `brain recall`·`brain sessions read`가 나온 비율. 단서 목록은 Core 상수, 한·영), Stop 점검 뒤 같은 세션에 로그가 생긴 비율. `--from`·`--to`(절대 날짜, AD-13), 기본으로 `ingest_source = import` 세션 제외. `--json`과 텍스트 (b) SM-1·3·4b·6도 "사람이 적는 칸"으로 받는다 | **(a)**. SM-1·2·3·4b는 사람이 채점하고 SM-6은 LLM 없이 "같은 뜻"을 못 센다. 사람 채점은 `~/.second_brain/eval/`의 파일에 적고 러너(D5)가 함께 보인다. 이름공간 `stats`의 대상은 "지표"다(doctor의 대상은 "점검"). epic 5에 둔다 — 도구 메모(2), 로그(3), `recall`(4)이 다 있어야 하고, 운영 에픽의 성격이다 |
| D5 | 검색 회귀 러너 | (a) `tooling/eval` 패키지, `pnpm eval -- --questions ~/.second_brain/eval/questions.toml`. 문항마다 `verb(chunks|logs|docs|time)`, `query`, `expect`(세션 토큰 또는 `chunk_id`·`log_entry_id`), `k`. SDK로 읽기 전용 실행, 문항별 hit@k와 합계, `~/.second_brain/eval/results/<날짜>.json`. 저장소에는 러너와 중립 fixture 하나 (b) `brain eval run` 제품 verb | **(a)**. 측정 도구이지 제품 표면이 아니다(AD-5 표에 넣지 않는다). 재는 것은 **고정 질의의 검색 적중률**이고 에이전트의 질의 바꾸기는 포함하지 않으므로 SM-3이 아니다. 그래서 epic 4 Done when 2는 "SM-3을 잴 수 있고"를 "SM-3은 사람이 채점하고, 회귀 러너가 고정 질의의 적중률을 기록한다"로 바꾼다. 임베딩 켜기 판단(spine Deferred '임베딩 기본 켜기')의 숫자 근거가 된다 |
| D6 | 집계 모드 | (a) `recall chunks|logs|docs --count`: 같은 필터(질의·꼬리표·기간)로 `data: {sessions, rows, by_month: [{month, sessions, rows}]}`. 8,000자 상한 밖. `meta.count`의 뜻(돌려준 행 수)은 그대로 (b) `meta.total`을 모든 결과에 | **(a)**. (b)는 모든 검색에 count 쿼리를 하나 더 얹는다. 확장 채점표 "집계" 유형이 요구하는 것은 명시적 세기다 |
| D7 | Deferred로만 적을 것 | Codex parser(수집 전용), 웹 채팅 내보내기 parser, 용어 대응표, `mcp serve` 선행 | 네 행 모두 **다시 볼 조건을 함께 적는다**(§4.3). 용어 대응표는 규모 시험 근거로 보류, `mcp serve` 선행은 두 번째 하네스가 생길 때만 뜻이 있다 |
| D8 | spec | (a) 바꾸지 않는다 (b) CAP-3 success에 Stop 점검을 적는다 | **(a)**. CAP은 능력이고 Stop 점검은 수단이다. spec 변경이 없으면 적용 비용이 한 스킬 줄어든다 |

## 4. Detailed Change Proposals

### 4.1 에픽 파일 (적용: `bmad-ticket`. 모두 인셉션 입력)

#### epic-log-and-context.md

- **Description 끝에 더한다:**
  "2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: **Stop hook 기록 점검** — `brain log remind`(hook 경로, 읽기 전용)를 플러그인 `hooks.json`의 동기 Stop 줄이 부른다(2.14의 비동기 Stop 수집 줄과 공존, 같은 런처·`|| exit 0`·짧은 timeout). `stop_hook_active`가 false이고 이 세션의 사용자 발화(hook stdin의 `transcript_path`를 parser로 읽어 센다)가 `STOP_REMIND_MIN_USER_TURNS` 이상이고 `log_entries`에 이 세션의 줄이 없을 때만 hook 출력 코덱으로 `{decision: 'block', reason}`을 내고, 그 밖에는 아무것도 내지 않는다. reason은 규율 원본 상수의 문장이고 '기록할 게 없는 것도 정상이다. 없으면 없다고 말하고 끝내라'를 포함한다. 세션당 한 번은 `<home>/run/stop-remind/<harness>-<id>` 표식 파일로 보장하고, 시도는 spool에 써서 drain이 `context_injections`(`kind='stop'`)로 넣는다. 설정 `[discipline] stop_remind`(기본 false, 설치기는 묻지 않음)가 켜져 있을 때만 동작한다. `context_injections`에 `kind`(`start | stop`)와 `elapsed_ms`를 더하는 마이그레이션은 이 에픽이 만든다. DB를 읽을 수 없거나 어떤 오류든 나면 출력 없이 exit 0이다(NFR-3)."
- **Done when에 더한다 (9):**
  "`[discipline] stop_remind`를 켜고 사용자 발화 3개 이상인 세션에서 로그 없이 멈추면 모델이 한 번 더 일하며 그 이유 문장이 hook 출력에 있고, 로그가 한 줄이라도 있거나 `stop_hook_active`가 true이거나 표식 파일이 있으면 아무것도 내지 않으며, DB 파일을 막아 둔 채 멈춰도 세션 종료가 막히지 않고, drain 뒤 `context_injections`에 `kind='stop'` 행이 남는다. 토글이 꺼져 있으면 Stop hook이 DB를 열지 않는다."
- **Boundaries에 더한다:** "AD-6의 동기 경로 규칙은 Stop 점검에도 적용된다(읽기 + spool + 표식 파일). 설정 키 `[discipline] stop_remind`와 `context_injections.kind`·`elapsed_ms`는 이 에픽."
- **Notes에 더한다:** "Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): Stop hook 기록 점검(D1·D2·D3). 2주 실사용의 첫 주는 토글을 끄고 둘째 주에 켜서 `stats show`로 SM-4a를 비교한 뒤 기본값을 정한다. PRD §8-3의 수단 후보 중 하나를 채택한 것이고 안내문(원본 하나, AD-17)을 대체하지 않는다."

#### epic-recall-and-mirror.md

- **Description 끝에 더한다:**
  "2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: `recall chunks|logs|docs --count`(같은 필터로 세션 수·행 수·월별 건수를 `data`로, 8,000자 상한 밖, AD-15)와 **검색 회귀 러너** `tooling/eval`(SDK 읽기 전용, 문항 파일은 `~/.second_brain/eval/questions.toml`, 결과는 `~/.second_brain/eval/results/`, 저장소에는 러너와 중립 fixture만). 러너가 재는 것은 고정 질의의 적중률(hit@k)이고 SM-3이 아니다."
- **Done when 2**
  - OLD: "SM-3 채점표(addendum §8)를 기본 구성으로 잴 수 있고, 결과가 기록된다."
  - NEW: "SM-3 채점표(addendum §8)는 사람이 채점해 `~/.second_brain/eval/`에 기록하고, 회귀 러너가 같은 폴더의 문항 파일로 고정 질의의 적중률(hit@k)을 재어 날짜별 결과를 남기며, 랭킹·조각 규칙·`index rebuild`를 바꾼 뒤 같은 문항으로 다시 재면 떨어진 문항이 보인다(2026-10-20)."
- **Done when에 더한다 (8):** "`recall chunks --count`·`logs --count`·`docs --count`가 질의·꼬리표·기간 필터 그대로 세션 수·행 수·월별 건수를 내고, 0건도 0으로 내며, `RESULT_TRUNCATED`가 붙지 않는다."
- **Notes에 더한다:** "Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): D5·D6. 러너의 문항 파일 형식(verb·query·expect·k)은 인셉션에서 정한다. 대분류 먼저(PRD §8-5)와 조각 직접 검색의 비교도 같은 러너로 잰다."

#### epic-operations.md

- **Description 끝에 더한다:**
  "2026-10-20 변경(`../change-discipline-and-metrics/`)으로 더한 것: `brain stats show`(이름공간의 대상은 지표. doctor는 점검) — 기계가 셀 수 있는 지표만: SM-4a, SM-5(doctor와 같은 함수), SM-C1, SM-C3, SM-7 내부 시간(`context_injections.elapsed_ms`가 있을 때), PRD §8-8 대리 지표(과거형 단서가 든 사용자 발화 뒤 같은 세션의 도구 메모에 `brain recall`·`brain sessions read`가 나온 비율. 단서 목록은 Core 상수, 한·영), Stop 점검 뒤 같은 세션에 로그가 생긴 비율. `--from`·`--to`(절대 날짜, AD-13), 기본으로 `import` 세션 제외, `--json`과 텍스트. 사람이 채점하는 SM-1·2·3·4b·6은 넣지 않는다."
- **Done when에 더한다 (6):** "`stats show --from <날짜> --to <날짜>`가 그 기간의 SM-4a·SM-5·SM-C1·SM-C3·§8-8 대리 지표를 `--json`과 텍스트로 내고, 로그가 하나도 없는 기간은 0이며, `import` 세션은 기본에서 빠지고 `--include-import`로 들어오며, 같은 수를 SQL로 직접 세면 같다."
- **Notes에 더한다:** "Note(2026-10-20, `../change-discipline-and-metrics/`, 인셉션 입력): D4. 이니셔티브 Done when 2의 2주 실측이 이 명령으로 주 단위 비교가 된다(첫 주 `stop_remind` 꺼짐, 둘째 주 켜짐)."

#### initiative-personal-brain.md

- **Notes에 더한다:** "Decision(2026-10-20, `change-discipline-and-metrics/`): 벤더 메모리·graphify 비교 뒤 보강 넷을 인셉션 입력으로 더했다 — Stop hook 기록 점검(epic 3, 토글, 둘째 주에 켜서 SM-4a 비교), `stats show`(epic 5), 검색 회귀 러너와 `recall --count`(epic 4). graphify는 도입하지 않는다(가끔 미러 위에 돌리는 분석 층). 두 번째 하네스 수집은 slice 1 밖이고 조건은 spine Deferred에 있다(사용자)."

### 4.2 PRD (적용: `bmad-prd`)

- **§6.2 표에 행 추가:** "| 웹 채팅(ChatGPT·Claude.ai) 내보내기 가져오기 | slice 2. 내보내기 JSON도 transcript이므로 parser 하나로 붙는다(AD-4). cwd가 없어 꼬리표 없이, 도구 메모 없이 들어온다(2026-10-20) |"
- **§8-3 끝에 더한다:** "[2026-10-20: 후보 중 Stop hook 점검을 설정 토글로 더한다(`change-discipline-and-metrics/` D1~D3). 2주 실사용의 둘째 주에 켜고 `stats show`로 SM-4a를 비교한 뒤 기본값을 정한다.]"
- **§8-8 끝에 더한다:** "[2026-10-20: 대리 지표(과거형 단서가 든 발화 뒤 에이전트가 `brain recall`을 불렀는가)를 `stats show`가 센다. 모자라면 '과거를 언급한 프롬프트에만 한 줄 힌트'(UserPromptSubmit `additionalContext`)를 검토한다. 내용 주입은 여전히 하지 않는다(FR-18).]"
- frontmatter `updated: 2026-10-20`.

### 4.3 Architecture spine (적용: `bmad-architecture`)

- **AD-5 표**
  - `log` 행 verb에 `remind` 추가. 하는 일: "…, Stop 점검(hook 경로, 읽기. 로그 없는 세션에 한 번 묻는다, AD-17)".
  - 새 행: "| `stats` | `show` | 기계가 셀 수 있는 지표(SM-4a·5·C1·C3·7, §8-8 대리 지표). 기간 필터 (SM, epic 5) |"
- **AD-6 Rule 첫 항목 끝에 더한다:** "동기 Stop 점검(`log.remind`)도 같은 규칙이다: 읽기, spool, `<home>/run/` 표식 파일만."
- **AD-15 결과 계약 뒤에 한 줄:** "`--count`는 같은 필터로 세션 수·행 수·월별 건수만 돌려주고(`data`), 8,000자 규칙 밖이다(2026-10-20)."
- **AD-17 Rule 첫 항목 뒤에 한 줄:** "규율의 두 번째 수단은 Stop 점검이다(`log.remind`, 설정 `[discipline] stop_remind`, 기본 false): 로그 없는 세션이 멈출 때 한 번만 `decision: block`과 규율 문장(원본 상수)을 돌려준다. 안내문을 대체하지 않고, 켜고 끈 주의 SM-4a를 `stats.show`로 비교해 기본값을 정한다(2026-10-20)."
- **AD-17 마지막 항목 끝에:** "Stop 점검 시도도 같은 경로로 `context_injections`(`kind='stop'`)에 남고, 두 종류 모두 `elapsed_ms`를 기록한다(SM-7)."
- **AD-18 Rule 첫 항목:** 설정 키 목록에 "`[discipline] stop_remind`(기본 false, 설치기는 묻지 않는다. epic 3)" 추가.
- **Table Contract `context_injections` 행:** 작성자 "`context.show`·`log.remind`가 spool에 쓰고 drain이 넣음".
- **Deferred 표**
  - Codex 행 끝에: "2026-10-20 사용자: 수집 주체는 상관없고 Core가 급하다 → slice 1 밖. 다시 볼 때: epic 2 마감 뒤(parser v4 2.23·2.14 뒤), 수집 전용으로 작게 — parser + 폴더 등록만, hook·`setup connect`·시작 맥락 없음. 이 Mac의 `~/.codex/sessions` 레코드는 `session_meta`·`event_msg`·`response_item`이고 규모 시험이 125개를 읽었다."
  - 새 행: "| 웹 채팅(ChatGPT·Claude.ai) 내보내기 parser | slice 2. AD-4대로 parser 하나. `harness_session_id`는 대화 uuid, cwd 없음(꼬리표 없음), 도구 메모 없음. 핵심 고통(코딩 작업 기억)과 거리가 있어 뒤로(2026-10-20) |"
  - 새 행: "| 용어 대응표(한↔영·약칭을 질의 함수가 OR 구절로 넓힘) | SM-3 실사용 채점에서 한영 교차 문항이 떨어질 때. 규모 시험(2026-10-08)은 한영 교차 4문항을 grep + 질의 바꾸기로 다 풀었다(2026-10-20) |"
  - 새 행: "| `mcp serve`를 epic 9에서 떼어 앞당기기 | 데몬이 필요 없고 명령 메타에서 생성되므로 기술적으로는 epic 4 직후도 된다. 두 번째 하네스가 생길 때만 뜻이 있다. Claude Code만 쓰는 동안은 Bash로 CLI를 부르는 것과 같다(2026-10-20) |"
  - '임베딩 기본 켜기' 행 끝에: "판단의 숫자는 epic 4의 회귀 러너 결과(2026-10-20)."
- frontmatter `updated`.

### 4.4 PRD addendum (적용: `bmad-prd` 또는 spine과 같은 세션에서 직접)

- **§4 표 플러그인 행 끝에:** "[2026-10-20 채택: Stop 점검 `log remind`, 토글, `change-discipline-and-metrics/`]"
- **§8 끝에 두 단락:**
  - "**기계 지표와의 구분(2026-10-20).** epic 4의 회귀 러너는 같은 문항 파일로 고정 질의의 적중률(hit@k)을 잰다. 에이전트의 질의 바꾸기가 빠지므로 SM-3이 아니라 검색 랭킹의 회귀 지표다. SM-3은 사람이 채점한다. 둘 다 `~/.second_brain/eval/`에 남는다."
  - "**집계 유형(2026-10-20).** '몇 번이나 했지'는 `recall chunks --count`·`logs --count`가 세션 수·행 수·월별 건수로 답한다. 조각 top-5로 세지 않는다."

### 4.5 spec

변경 없음(D8).

### 4.6 spine 리뷰 게이트(2026-10-20)가 더한 인셉션 입력 (적용: `bmad-ticket`, §4.1과 함께)

§4.3 적용 뒤 spine 리뷰(currency·adversary·rubric-reconcile, `architecture-brain-v1-slice-1/reviews/*-2026-10-20.md`)에서 나온 것 중 spine에는 들어갔고 에픽 Notes에도 적어야 할 것이다. spine 문장이 기준이고 여기는 가리키는 메모다.

- **epic 3 Notes에 더한다:** "Note(2026-10-20, spine 리뷰): Stop 점검의 조건은 넷(spine AD-17 — `stop_hook_active` false, transcript로 센 사용자 발화 ≥ 상수, `log_entries`와 spool 어디에도 로그 없음, 표식 파일 없음), `Stop` 이벤트만, 표식은 차단 뒤에만, 모르면 묻지 않는다. `hooks.json`의 Stop 줄은 둘(2.14 비동기 수집 + 이 에픽의 동기 점검, `timeout` 5초)이고 Done when은 **플러그인으로 설치한 상태**에서 검증한다(플러그인 hook의 `decision: block`이 settings hook과 같다는 명시 서술이 문서에 없다). 인셉션에서 실측할 것: `hookSpecificOutput.additionalContext`만으로도 모델이 이어 가는지(되면 오류 대신 피드백으로 보이므로 그쪽), 발화 수 상수 3 vs 4(transcript 비동기 기록으로 하나 적게 셀 수 있다). 메타 `hook: only`라 MCP 도구로 나오지 않는다(AD-28). 표식 파일은 drain이 30일 지난 것을 지운다."
- **epic 4 Notes에 더한다:** "Note(2026-10-20, spine 리뷰): `--count`는 `chunks`·`logs`가 `{sessions, rows, by_month}`, `docs`가 `{files, rows, by_month}`, `by_month`는 기간 안의 달만이고 AD-13의 구간 함수(날짜+설정 시간대 → 반열린 UTC)를 쓰며 `meta`에 구간을 되울린다. 회귀 러너 결과 파일은 식별자·질의·점수만(본문 없음)."
- **epic 5 Notes에 더한다:** "Note(2026-10-20, spine 리뷰): `stats show`의 SM-4a는 전체 세션과 적격 세션(발화 ≥ 상수) 두 모집단으로 낸다. `import` 세션 제외는 기본이 아니라 옵션(`--exclude-import`) — 폴더 스캔이 처음 만든 세션도 `import`라 기본 제외하면 hook을 놓친 실사용 세션이 빠진다. 잴 수 없는 지표는 0이 아니라 null + 경고(예: transcript 폴더 없음 → SM-5). 'Stop 점검 뒤 로그가 생긴 비율'의 분모는 `context_injections(kind='stop', ok=1)`이고 API 오류로 끝난 턴(`StopFailure`, 점검 없음)은 들어오지 않는다. `brain recall`이 불렸다는 판정은 Core 함수 하나(도구 메모 대상 앞머리, MCP 이름 포함). `context_injections.elapsed_ms`는 Brain 내부 처리 시간이다(SM-7 내부값)."

## 5. Implementation Handoff

**범위: Moderate** — 인셉션 전 에픽 셋의 입력과 문서 문장 편집. 코드는 그 에픽의 스토리가 만든다.

**적용 순서(모두 story 2.18 세션의 커밋 뒤):**
1. `bmad-architecture` — §4.3(AD-5·6·15·17·18, Table Contract, Deferred).
2. `bmad-prd` — §4.2와 §4.4(addendum).
3. `bmad-ticket` — §4.1과 §4.6(epic 3·4·5 파일, 이니셔티브 Notes). 스토리 쪼개기는 각 에픽 인셉션에서.
4. 이 문서 머리에 "반영 완료(날짜)"와 "이후의 기준은 spine·PRD·에픽 파일".

**성공 기준:**
- epic 3 인셉션이 `log remind` 스토리를 만들고, 플러그인 `hooks.json`의 Stop 줄이 둘(비동기 수집, 동기 점검)이며, 토글이 꺼진 기본 설치에서 Stop hook이 DB를 열지 않는다.
- epic 4 인셉션이 `--count`와 `tooling/eval`을 포함하고, 러너가 저장소 밖 문항 파일로 돈다.
- epic 5 인셉션이 `stats show` 스토리를 만들고, 2주 실사용의 주 단위 SM-4a 비교가 그 출력으로 된다.
- spine Deferred에 네 행의 조건이 적혀 있어, 두 번째 하네스·웹 채팅·용어 대응표·`mcp serve` 선행을 다시 꺼낼 때 그 조건부터 본다.

## 6. 승인

- [x] 사용자 승인 2026-10-20("진행해"). 조건: 적용 편집은 story 2.18 세션의 커밋 뒤에 소유 스킬로 한다(§5 순서). 적용이 끝나면 이 문서 머리에 "반영 완료"를 적는다.
