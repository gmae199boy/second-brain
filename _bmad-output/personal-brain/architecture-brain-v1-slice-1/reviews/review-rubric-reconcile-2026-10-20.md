---
name: 'Rubric + Reconcile — 2026-10-20 delta (기록 규율·지표)'
type: architecture-review
lens: [reconcile, rubric]
target: ./architecture-brain-v1-slice-1.md
target_updated: '2026-10-20'
reviewed: '2026-10-20'
proposal: ../../change-discipline-and-metrics/change-discipline-and-metrics.md
method: 'A) 승인된 제안 §4.3의 14개 항목을 spine 행 번호와 대조. B) 델타가 더한 규칙만 — 집행 가능성, 명시한 분기(divergence)를 실제로 막는지, 기존 AD·spec과의 충돌'
scope: '2026-10-20 델타만. spine 전체 재검토는 아니다'
---

# Rubric + Reconcile — 2026-10-20 델타

## Verdict

**조건부 통과.** 반영은 사실상 끝났다(14개 중 13개 그대로, 1개는 내용은 들어갔으나 표를 깨뜨림). 델타가 더한 규칙은 방향이 맞고 기존 AD와 정면으로 모순되는 문장은 **없다** — AD-14의 "로그는 `log.append`만 만든다"도, AD-6의 "동기 경로는 읽기 전용"도, Non-goal "프롬프트마다 맥락을 밀어 넣는 것"도 지켜진다.

막아야 할 것은 세 묶음이다. 첫째, AD-17의 새 Stop 조건 두 개가 **집행 가능하지 않다**: "로그가 없음"이 spool을 보지 않아 AD-9 경로로 적은 로그를 못 본 것으로 치고, "사용자 발화 수"의 출처가 적혀 있지 않아 epic 2(수집)와 epic 3(점검)이 같은 AD를 지키면서 서로 다른 수를 센다. 이 둘은 **AD-17 한 문장 수정으로 닫히고, epic 3 인셉션 전에 닫아야 한다.** 둘째, 새 명령 둘이 spine의 배선표에서 빠졌다 — Capability map에 `stats` 행이 없고, 판단 근거로 못 박은 회귀 러너(`tooling/eval`)는 Structural Seed에 없어 AD-1의 의존 방향 규칙이 걸리지 않는다. 셋째, 새 문장 때문에 **낡아 버린 기존 문장**이 셋 있다(Conventions의 "Stop의 exit 2 금지" 이유, CAP-11의 "hook은 하나다", CAP-7의 8,000자). 전부 한 줄짜리 수정이다.

제안 §4.3 자체의 누락도 셋 있다: Conventions·AD-6 다이어그램·Capability map을 손대라고 하지 않았고, `tooling/eval`을 Structural Seed에 넣으라고 하지 않았다. 적용자의 잘못이 아니다.

## A. RECONCILE — 제안 §4.3 대조

대상: `_bmad-output/personal-brain/change-discipline-and-metrics/change-discipline-and-metrics.md` §4.3. 행 번호는 현재 spine(`architecture-brain-v1-slice-1.md`).

| # | 제안 항목 | 결과 | spine 행 | 비고 |
| --- | --- | --- | --- | --- |
| 1 | AD-5 표 `log` 행에 verb `remind` + 하는 일 추가 | **Landed** | 109 | 제안 문구 그대로("Stop 점검(hook 경로, 읽기. 로그 없는 세션에 한 번 묻는다, AD-17)"). FR 칸은 `(7, 8, 19~22)` 그대로 — M-8 |
| 2 | AD-5 표 새 행 `stats` / `show` | **Landed** | 116 | "§8-8"을 "PRD §8-8"로 명시한 것만 다름. FR 없음 — M-8 |
| 3 | AD-6 Rule 첫 항목 끝에 한 문장 | **Landed** | 130 | 제안 문구 그대로 + 날짜. 다이어그램은 손대지 않음 — M-3 |
| 4 | AD-15 결과 계약 뒤 `--count` 한 줄 | **Landed** | 265 | 별도 bullet이 아니라 8,000자 bullet 끝에 붙었다(바로 그 자리라 내용 동일). 상한·`meta.count`는 없음 — M-6·M-7 |
| 5 | AD-17 Rule 첫 항목 뒤 Stop 점검 한 줄 | **Landed (확장)** | 283 | 제안보다 넓다: 조건 셋과 표식 파일 경로, "어떤 오류든 exit 0"까지 들어갔다. 대신 D1이 못 박은 두 가지(발화 수의 출처, "기록할 게 없는 것도 정상이다" 문장)가 빠졌다 — C-1·C-2·H-3 |
| 6 | AD-17 마지막 항목 끝에 `kind='stop'`·`elapsed_ms` | **Landed** | 287 | 제안 문구 그대로. doctor 비율의 뜻은 손대지 않음 — H-1 |
| 7 | AD-18 Rule 첫 항목에 `[discipline] stop_remind` | **Landed** | 294 | 기본 false, 설치기 안 물음, epic 3, AD-17 모두 적혔다 |
| 8 | Table Contract `context_injections` 행 작성자 | **Partial** | 425 | 작성자는 제안대로 `context.show`·`log.remind`. 그런데 (a) escape 안 된 `|` 때문에 표가 한 칸 더 생기고(같은 표 416행은 `\|`로 적는다), (b) 제안이 요청하지 않은 `kind` 열거값이 들어와 AD-17과 두 번째 출처가 됐다 — M-1·M-2 |
| 9 | Deferred Codex 행 끝에 2026-10-20 조건 | **Landed** | 577 | 제안 문구 그대로. "slice 1 밖"과 "다시 볼 때: epic 2 마감 뒤"가 한 칸에서 서로 밀어낸다 — M-4 |
| 10 | Deferred 새 행 — 웹 채팅 내보내기 parser | **Landed** | 578 | 제안 문구 그대로 |
| 11 | Deferred 새 행 — 용어 대응표 | **Landed** | 579 | 제안 문구 그대로. 임베딩 행과 같은 신호로 발동 — M-5 |
| 12 | Deferred 새 행 — `mcp serve` 앞당기기 | **Landed** | 580 | 제안 문구 그대로. 그 문구가 AD-5를 흔든다 — H-6 |
| 13 | Deferred '임베딩 기본 켜기' 행 끝에 회귀 러너 | **Landed** | 592 | 러너는 spine 어디에도 정의가 없다 — H-5 |
| 14 | frontmatter `updated` | **Landed** | 10 | `'2026-10-19'` → `'2026-10-20'` |

**합계: 13 landed / 1 partial / 0 missing.** 제안이 요청하지 않아 손대지 않은 곳(§4.3의 누락): Conventions "hook 응답" 행, AD-6 시퀀스 다이어그램, Capability map, Structural Seed. 각각 H-3·M-3·H-4·H-5.

델타 밖 변경은 없다. `git diff`는 frontmatter 1줄과 본문 11줄(+4 신규 행)만 건드렸고, 범위를 넘은 편집은 찾지 못했다.

## B. RUBRIC — 델타만

판정 기준: (1) 새 규칙이 **집행 가능한가**(테스트나 점검이 어긋남을 잡아낼 수 있는가), (2) 규칙이 이름 붙인 **분기를 실제로 막는가**, (3) 기존 AD·Conventions·spec과 충돌하는가.

### Critical

**C-1. Stop 조건의 "로그가 없음"이 spool을 보지 않는다 → AD-9 경로로 적은 로그를 못 본 것으로 친다.**
283행은 조건을 "`log_entries`에 그 세션의 줄이 없음"으로 적는다. 그런데 AD-9·AD-21과 CAP-3 success("DB가 꺼져 있을 때 적은 로그도 연결 후 빠짐없이 들어간다")대로, DB 쓰기 잠금이 길면 `log.append`는 **정상 경로로** spool에 간다 — 2026-10-14 adversary 리뷰가 "DB 단위 잠금 뒤 spool은 예외가 아니라 평시 경로"라고 적은 그 경로다. drain 전에 세션이 멈추면 에이전트는 제대로 적었는데 점검이 "안 적었다"로 막는다. 규칙이 막겠다는 분기(기록 안 함)가 아니라 **반대쪽을 때린다**. 더 나쁜 것은 이 오경보가 SM-4a 비교(H-3)의 분모·분자를 함께 흔든다는 점이다.
*Fix:* 조건을 "`log_entries`에도, 그 세션의 spool에도 로그가 없음"으로 바꾼다(spool 읽기는 AD-6의 읽기 전용 규칙 안이다).

**C-2. "사용자 발화가 Core 상수 이상"의 출처가 빠져 epic 2와 epic 3이 다른 수를 센다.**
283행은 셀 대상만 말하고 **어디서 세는지**를 말하지 않는다. 제안 D1과 epic 3 Description은 "hook stdin의 `transcript_path`를 parser로 읽어 센다(수집 지연과 무관)"를 명시한다 — 그 문장이 spine으로 올라오지 않았다. `messages`로 세면 AD-6의 Stop 수집이 비동기라 거의 항상 뒤처지고(그림의 `H--)B: Stop (async)`), 3턴짜리 세션에서 점검이 아예 뜨지 않는다. spine을 한 글자도 어기지 않는 두 구현이 서로 다른 답을 내는 **정확히 그 구멍**이고, 두 단위(U-ing/epic 2, 점검/epic 3)는 slice 1 안에 함께 있다.
*Fix:* "그 수는 hook stdin의 `transcript_path`를 parser로 읽어 센다(`messages`가 아니다 — 수집 지연과 무관해야 한다)"를 283행에 넣는다.

### High

**H-1. doctor의 "세션 수 대비 주입 시도 수"가 `kind='stop'`까지 세어 뜻이 바뀐다.**
287행은 Stop 시도를 같은 `context_injections`에 넣으면서 바로 앞 문장의 doctor 비율은 손대지 않았다. `kind` 필터가 없으면 비율이 세션당 1을 넘을 수 있고, "주입이 조용히 실패하는 것"(AD-17 Prevents)을 보던 숫자가 두 가지를 섞은 수가 된다. doctor(epic 2·5)와 `log.remind`(epic 3)가 각자 맞으면서 숫자 하나를 망친다.
*Fix:* 287행에 "doctor의 그 비율은 `kind='start'`만 센다"를 붙인다.

**H-2. 동기 Stop 경로에 시간 예산이 없다.**
AD-7은 경로별 `busy_timeout`을 Core 상수로 못 박았는데(턴 수집 3초, 사람이 부른 명령 10초, drain 10초) hook 점검 항목이 없다. 게다가 C-2의 올바른 구현은 **세션 종료 경로에서 transcript 파일을 읽는다** — 표식 파일이 생기기 전까지 턴마다. AD-6은 동기 경로에 "네트워크 없음, 쓰기 트랜잭션 없음"만 요구하고 파일 I/O 예산은 말하지 않는다. NFR-3·NFR-7과 "어떤 오류든 exit 0"은 실패만 덮고 **느림**은 덮지 못한다.
*Fix:* `log.remind`에 Core 상수 예산(예: 1초)을 주고 초과하면 아무것도 내지 않고 exit 0이라고 AD-17 또는 AD-7의 상수 목록에 적는다.

**H-3. 측정 루프가 자기 확인이고, 그걸 막을 문장이 spine에 없다.**
283행은 "켜고 끈 주의 SM-4a를 `stats.show`로 비교해 기본값을 정한다"로 끝난다. 그런데 점검은 SM-4a(로그 ≥1 세션 비율)를 **직접 밀어 올리도록 설계된** 수단이다. 모델이 턴을 끝내려고 아무 로그나 한 줄 적으면 SM-4a는 오르고 로그 품질은 떨어진다. 제안 D1이 이 반대쪽을 두 장치로 막았다 — reason에 "기록할 게 없는 것도 정상이다. 없으면 없다고 말하고 끝내라"를 포함, 그리고 SM-C3(세션당 로그 중앙값)로 억지 로그를 본다 — **둘 다 spine에 없다.** 그러면 비교 결과로 기본값을 true로 올리는 판단이 근거 없이 선다.
*Fix:* 283행 끝을 "SM-4a와 SM-C3를 함께 보고(억지 로그를 가려내려고) 정한다. reason은 '기록할 게 없으면 없다고 말하고 끝내라'를 포함한다"로 늘린다.

**H-4. Capability map에 `stats` 행이 없다.**
550~569행의 표는 능력을 "어디 살고 무엇이 지배하는가"로 라우팅하는 spine의 배선표다. 이번 델타는 **새 이름공간 하나**(`stats`), 새 Core 상수(과거형 단서 목록, 한·영), 새 계산 단위를 더했는데 그 표에 행이 없다. `log remind`는 **gap이 아니다** — "작업 로그 (FR-7~9) | core `log` | AD-6, AD-9, AD-14, AD-17"과 "시작 맥락 (FR-17~18) | … AD-6, AD-9, AD-13, AD-17" 두 행의 governed-by가 이미 덮는다. `stats`는 어느 행에도 들어가지 않는다("조용한 실패 금지" 행의 doctor와 다른 대상이다). 덧붙여 "지연 (NFR-7) | … | AD-6. 목표 수치는 PRD 갱신 대상" 행은 이제 `context_injections.elapsed_ms`로 실측된다는 것을 적을 자리다.
*Fix:* "| 지표 (SM-4a·5·C1·C3·7, PRD §8-8 대리 지표) | core `stats` + sqlite | AD-5, AD-13, AD-17, AD-18 |" 한 행을 더하고, 지연 행에 `elapsed_ms`를 적는다.

**H-5. 판단 근거로 못 박은 회귀 러너가 spine에 존재하지 않는다.**
592행은 "판단의 숫자는 epic 4의 회귀 러너 결과"로 '임베딩 기본 켜기'의 게이트를 러너에 넘겼다. 그런데 spine 전체에서 "러너"는 그 한 번뿐이고 `tooling/eval`은 Structural Seed(515~531행)에도, Stack에도, Capability map에도 없다. 제안 D5는 이것을 의도적으로 제품 표면 밖에 뒀지만(AD-5 표에 넣지 않음) **패키지는 패키지다**: AD-1이 의존 방향을 패키지 경계로 강제하는데 목록에 없는 패키지에는 그 규칙이 걸리지 않고, 러너가 Core를 직접 import하거나 Store adapter를 열어도 아무것도 막지 않는다. 배포본 포함 여부도 미정이다.
*Fix:* Structural Seed에 `tooling/eval/  # 검색 회귀 러너(측정 도구, 제품 표면 아님). second_brain 공개 SDK만 읽기로 쓰고 배포본에 포함하지 않는다` 한 줄을 더한다.

**H-6. Deferred `mcp serve` 행이 AD-5의 "slice 1은 CLI만"을 흔든다.**
580행은 "기술적으로는 epic 4 직후도 된다"를 조건보다 **먼저** 말한다. epic 4는 slice 1 안이다(V1 경로 1·2·10·3·4·5). AD-5 Rule은 "slice 1은 CLI만 내고(MCP·데몬은 epic 9)"이고 CAP-10 success는 `mcp`·`daemon` 행을 "epic 9 예약 행"으로 제외한다. 행 끝의 "두 번째 하네스가 생길 때만 뜻이 있다"가 진짜 조건인데, 읽는 순서 때문에 "epic 4 뒤에 해도 된다"가 먼저 걸린다. 그대로 움직이면 AD-5 불변식과 CAP-10 제외 목록이 동시에 틀린다.
*Fix:* 조건을 문장 앞으로 옮기고 "그때까지는 AD-5대로 epic 9에 둔다"를 붙인다.

**H-7. Conventions "hook 응답" 행의 금지 이유가 이제 틀렸다.**
그 행은 "hook 경로는 항상 exit 0으로 끝낸다(Stop의 exit 2는 턴을 이어 가게 하므로 금지)"라고 적는다. 금지의 **이유**가 "턴을 이어 가게 하므로"인데, 이번 델타는 턴을 이어 가는 것을 의도된 동작으로 만들었다. 실제 규칙(exit 코드로는 하지 않는다)은 여전히 맞지만 이유가 틀려서, 읽는 사람이 Stop 블록 자체가 금지라고 읽는다. 함께, AD-4의 hook 출력 열거("stdin 해석, `hookSpecificOutput`·`systemMessage` 형식, 세션 환경 변수 쓰기")에 top-level `decision`·`reason`이 없어 283행이 요구하는 출력 모양을 connector adapter가 소유한다는 말이 성립하지 않는다.
*Fix:* 그 행을 "의도한 이어가기는 exit 코드가 아니라 `decision: block`(AD-17)으로만 한다"로 고치고, AD-4 열거에 `decision`·`reason`을 더한다.

### Medium

**M-1. Table Contract 425행의 escape 안 된 `|`가 표를 깬다.** 그 행만 칸이 7개(나머지 6개)이고, 같은 표 416행은 `ingest_source(live\|import)`처럼 escape한다 — Conventions의 `risk(read \| write \| destructive)`도 같다. *Fix:* `` `start \| stop` ``으로 바꾼다.

**M-2. `kind` 열거값이 Table Contract의 선언 범위를 넘고 두 번째 출처를 만든다.** 그 표의 머리말은 "컬럼 전체가 아니라 단위 사이에 걸리는 키, 작성자, 변경 가능성만 고정한다. 나머지 컬럼은 코드가 정한다"이고, 제안이 요청한 것은 작성자 칸뿐이다. 이제 `start | stop`이 AD-17(287행)과 Table Contract 두 곳에 있다. *Fix:* 작성자 칸만 남기고 열거값은 AD-17에만 둔다.

**M-3. AD-6 시퀀스 다이어그램에 동기 Stop 점검이 없고, "hook은 하나다"가 낡았다.** 그림(138~150행 영역)은 `loop 턴마다 / H--)B: Stop (async)` 하나만 보여 준다. 이제 Stop 이벤트에 hook이 둘이다(비동기 수집, 동기 점검). AD-19 Prevents는 "hook 이중 등록(설치기 hook + 플러그인 hook)"이고 CAP-11 success는 "재설정·플러그인 갱신을 반복해도 hook은 하나다"라고 적는다 — 뜻은 "출처가 하나"지만 글자는 지금 epic 3이 만들 `hooks.json`과 어긋나 보인다. *Fix:* 다이어그램에 동기 Stop 줄을 더하고, AD-19에 "한 이벤트에 플러그인 항목이 둘일 수 있다. '하나'는 출처가 하나라는 뜻이다" 한 구절을 넣는다.

**M-4. Codex Deferred 행 안에서 "slice 1 밖"과 "epic 2 마감 뒤"가 서로 밀어낸다.** epic 2 마감은 slice 1 **안**이다(뒤에 10·3·4·5가 남는다). 같은 칸이 착수를 금지하면서 그 금지가 풀리는 시점을 slice 1 안으로 적었다. *Fix:* 다시 볼 조건을 "slice 1 마감 뒤(기술 메모는 epic 2 마감 시점 기준)"로 적는다.

**M-5. 새 Deferred 두 행이 같은 신호로 발동하는데 선후가 없다.** 579행(용어 대응표)의 조건은 "SM-3 실사용 채점에서 한영 교차 문항이 떨어질 때", 592행(임베딩 기본 켜기)의 조건도 "…한영 교차 질문을 놓칠 때"다. 그 신호가 뜨면 둘 중 무엇을 먼저 하는지 spine이 말하지 않는다. 둘 다 slice 1 밖이라 지금 분기하지는 않지만, 결정 시점에 갈라진다. *Fix:* 579행에 "임베딩보다 먼저 본다(비용 0, AD-15의 질의 함수 한 곳)"를 붙인다.

**M-6. `--count`가 8,000자 규칙 밖인데 대신하는 상한이 없고, CAP-7과 글자 그대로 부딪힌다.** CAP-7 success는 "한 번의 결과는 8,000자를 넘지 않는다(SM-C2)"로 단서가 없다. spec은 "spine과 다르면 spine이 우선한다"라 해소는 되지만, AD-15 Prevents의 "결과 형태가 단위마다 달라지는 것"을 생각하면 `by_month`에 아무 상한도 없는 것이 더 문제다. *Fix:* 265행에 "`by_month`는 필터 기간 안의 달 수만큼이고 `RESULT_TRUNCATED`가 붙지 않는다"를 적는다.

**M-7. `--count`와 `meta.count`의 이름이 겹치는데 spine이 뜻을 고정하지 않았다.** D6은 "`meta.count`의 뜻(돌려준 행 수)은 그대로"를 결정했지만 §4.3이 그 문장을 spine에 넣으라고 하지 않았다. Conventions의 `meta` 정의와 새 플래그가 같은 단어를 쓴다. *Fix:* 265행에 "`--count`는 `meta.count`의 뜻을 바꾸지 않는다" 한 구절.

**M-8. AD-5 표의 FR 칸이 새 verb를 덮지 않는다.** 표 머리는 "하는 일 (FR)"인데 `stats` 행의 근거는 `(SM, epic 5)`로 FR이 아니고, `log` 행의 `remind`는 `(7, 8, 19~22)` 어디에도 해당하지 않는다(FR-7~9는 로그 적기·조회·연결, FR-19~22는 규칙·결정·선호). PRD는 FR을 바꾸지 않기로 했으므로(제안 §2.2) 이 두 verb를 요구하는 FR은 없고, 빠뜨려도 CAP-10만 잡는다. *Fix:* 표 머리를 "하는 일 (FR / 근거)"로 넓히고 두 칸에 AD·SM 근거를 명시한다.

**M-9. UserPromptSubmit을 쓰지 않는다는 문장이 어디에도 없다.** PRD §8-8에 들어가는 주석이 다음 수단으로 "과거를 언급한 프롬프트에만 한 줄 힌트(UserPromptSubmit `additionalContext`)"를 열어 둔다. 그것은 spec Non-goal "프롬프트마다 맥락을 밀어 넣는 것"의 경계에 바로 붙는다. 지금 그 경계를 지키는 것은 AD-6 매핑에 UserPromptSubmit이 **없다**는 사실뿐이고, 없음은 금지가 아니다. *Fix:* AD-6 매핑에 "slice 1은 UserPromptSubmit을 쓰지 않는다(FR-18, Non-goal)" 한 구절.

### Low

**L-1. `STOP_REMIND_MIN_USER_TURNS`가 이름 없이 "Core 상수"로만 적혔다.** spine은 `SECRET_PATTERN_VERSION`·`TOOL_NOTE_TARGET_LIMIT`·`CLAUDE_CODE_PARSER_VERSION`처럼 상수 이름을 적는 습관이다. *Fix:* 이름과 초깃값(3)을 283행에 적는다.

**L-2. `elapsed_ms`는 spine 최초의 "기간" 칸인데 AD-13·Conventions 시각 행은 기간을 다루지 않는다.** "저장·입력·출력은 모두 절대 시각이다"를 그대로 읽으면 ISO 문자열을 넣는 구현이 나올 수 있다. *Fix:* 287행에 "밀리초 정수 기간이며 시각 정규형 규칙의 대상이 아니다"를 붙인다.

**L-3. AD-11의 출력 코덱 목록이 "hook 출력 코덱(시작 맥락)"으로 좁다.** Stop reason도 같은 코덱으로 나간다(상수라 비밀은 없지만, 2.17이 만든 코덱 등록부 계약 테스트는 "등록된 모든 출력 코덱"을 센다). *Fix:* 괄호를 "(시작 맥락·Stop 점검)"으로 넓힌다.

**L-4. AD-7의 기회적 drain 예외 괄호가 "`context show`"만 예로 든다.** 뒤의 "hook 경로의 명령은 돌지 않고"가 `log.remind`를 이미 덮으므로 동작은 맞다. *Fix:* 괄호를 "`context show`·`log.remind`"로.

**L-5. Stop reason에 기록 내용을 넣지 않는다는 말이 없다.** 같은 항목의 "켜진 규칙은 시작 맥락으로만 나간다"가 **규칙**은 막지만 최근 로그는 막지 않는다. reason에 로그 발췌가 들어가면 CAP-8 intent("이후 프롬프트에는 아무것도 덧붙이지 않는다")와 Non-goal에 닿는다. *Fix:* "reason은 상수 문장만이고 로그·규칙 내용을 담지 않는다"를 283행에 넣는다.

**L-6. 웹 채팅 parser 행의 "cwd 없음(꼬리표 없음)"이 AD-12와 만날 때의 결정이 비어 있다.** AD-12는 꼬리표가 비면 `session_identity` 일감을 만들고, 끝내 실패하면 `failures` → doctor다. cwd가 원천적으로 없는 하네스는 그 일감이 영영 실패한다. slice 1 밖이라 지금 영향은 없다. *Fix:* 578행에 "꼬리표가 없는 하네스는 `session_identity` 일감을 만들지 않는다는 AD-12 결정이 먼저"를 더한다.

## 지시받은 질문에 대한 직접 답

**Q1. 새 Deferred 네 행이 slice 1 안에서 두 단위를 자유롭게 갈라지게 두는가?**
**아니다 — 다만 두 군데가 slice 1 안으로 샌다.** 네 행 모두 slice 1 밖을 명시하고 다시 볼 조건을 함께 적어(제안 D7이 요구한 형태) slice-1 구현을 구속하지 않는다. 새는 곳은 (a) `mcp serve` 행의 "epic 4 직후도 된다"(H-6 — epic 4는 slice 1 안이고 AD-5의 "slice 1은 CLI만"과 CAP-10 제외 목록을 흔든다), (b) Codex 행의 "다시 볼 때: epic 2 마감 뒤"(M-4 — 같은 칸의 "slice 1 밖"과 충돌). 둘 다 조건 문장 하나로 닫힌다. 웹 채팅·용어 대응표 두 행은 slice-1 동작을 전혀 건드리지 않는다(L-6·M-5는 결정 시점의 숙제이지 지금의 분기가 아니다).

**Q2. 새 문장이 기존 AD와 모순되는가?** (AD-4·6·7·11·13·17·18·19·21·Conventions 대조)
**정면 모순은 없다.** 확인한 것: AD-14 "작업 로그는 `log.append`로만 만든다. hook, 수집, drain은 로그 행을 만들지 않는다" — `log.remind`는 읽기이고 로그 행을 만들지 않으므로 지켜진다(AD-14 Prevents의 "자동 경로가 로그를 써서 SM-4가 오염되는 것"도 **행 생성** 기준으로는 지켜진다. 통계적 오염은 H-3이 별건이다). AD-6 동기 경로 읽기 전용 — 130행이 명시적으로 상속한다. AD-7 기회적 drain 예외 — "hook 경로의 명령은 돌지 않고"가 덮는다(L-4). AD-18 모르는 키 경고 — 설정 코덱에 키가 들어갔으므로 지켜진다. AD-21·AD-9 — 표식 파일은 `<home>/run/`의 "사실"이라 AD-18·19의 설정/사실 구분과 맞는다.
겉보기 충돌은 셋이고 모두 **낡은 기존 문장** 때문이다: Conventions "hook 응답" 행의 "Stop의 exit 2는 턴을 이어 가게 하므로 금지"(H-7), CAP-11의 "hook은 하나다"(M-3), CAP-7의 8,000자(M-6). 셋 다 새 규칙이 틀려서가 아니라 옛 문장이 새 동작을 모르기 때문이고, 각각 한 줄로 닫힌다.

**Q3. spec CAP-3·8·9·10과 Non-goals에 대해 여전히 정합한가?**
**그렇다.**
- **CAP-3**(로그 ≥80%, SM-4a): 점검은 수단이고 CAP은 능력이라는 D8의 구분이 맞다. 다만 C-1이 CAP-3 success의 "DB가 꺼져 있을 때 적은 로그도 연결 후 빠짐없이 들어간다"와 직접 부딪힌다 — spool에 든 로그를 못 본 것으로 치는 점검은 그 success를 통과한 구현을 벌준다. 닫아야 한다.
- **CAP-8**(시작 맥락, "이후 프롬프트에는 아무것도 덧붙이지 않는다"): Stop 점검은 프롬프트가 아니라 턴 종료 지점의 hook 응답이므로 intent는 지켜진다. 경계는 L-5(reason에 내용이 들어가면)와 M-9(UserPromptSubmit이 뒤따라오면)다.
- **CAP-9**(규칙): AD-17의 "켜진 규칙은 시작 맥락으로만 나간다"가 Stop reason에 규칙이 들어가는 것을 이미 막는다. 영향 없음.
- **CAP-10**: 아래 Q4.
- **Non-goals "프롬프트마다 맥락을 밀어 넣는 것"**: 세션당 한 번, 토글 기본 꺼짐, 주입이 아니라 질문 — 충돌하지 않는다. 제안 §2.2의 판단과 같다. 경계는 M-9.
- **Non-goals "Claude Code 외 Harness 수집"**: Deferred 네 행이 모두 그 밖에 있다고 적어 오히려 Non-goal을 강화한다(H-6의 문구 문제 제외).

**Q4. AD-5 표의 "slice 1 commands" 주장이 `stats show`(epic 5)·`log remind`(epic 3)를 넣고도 유지되는가?**
**유지된다.** CAP-10 success의 제외 목록은 **열거**다 — "epic 9 예약 행 `mcp`·`daemon`과 예약된 `sessions assign-workspace` 제외". epic 3과 epic 5는 slice 1 안이다(V1 경로 1·2·10·3·4·5). 그러므로 두 새 verb는 자동으로 CAP-10의 검사 대상이 되고, 그것이 제안 §2.2가 "spec 변경 없음"을 정당화한 이유다 — 맞다. epic 5에 의존한다는 점도 새롭지 않다: `backup export|import`, `setup upgrade`, `doctor run`의 일부가 이미 epic 5다. 따라서 CAP-10은 **slice 1 마감 게이트**이지 에픽별 게이트가 아니며, 그 성질은 변하지 않았다.
남는 것은 추적성뿐이다(M-8): 두 verb를 요구하는 FR이 없어 PRD 쪽 게이트가 비고 CAP-10 하나만 붙잡는다. 치명적이지 않지만 표 머리가 "(FR)"이라 표 자체가 거짓말을 한다.

**Q5. Capability map에 `log remind`·`stats show`가 들어가야 하는가? 빠진 것이 gap인가?**
**`stats`는 gap이다(H-4). `log remind`는 아니다.** 지도의 단위는 명령이 아니라 능력/영역이므로 `log remind`는 "작업 로그 (FR-7~9) → core `log` → AD-6, AD-9, AD-14, AD-17"과 "시작 맥락 (FR-17~18) → … AD-6, AD-9, AD-13, AD-17"이 이미 덮는다(governed-by에 AD-17·AD-6이 둘 다 있다). 반면 `stats`는 **새 이름공간**이고 어느 행에도 속하지 않는다 — "조용한 실패 금지(NFR-2)" 행의 doctor는 대상이 "점검"이고 `stats`의 대상은 "지표"라고 제안 D4가 명시적으로 갈라 놓았다. 지도에 행이 없으면 Core 상수(과거형 단서 목록)가 어느 패키지에 사는지, 어떤 AD가 지배하는지를 spine이 말하지 않는 채로 epic 5 인셉션이 시작된다. 같은 자리에서 "지연 (NFR-7)" 행의 "목표 수치는 PRD 갱신 대상"도 이제 `elapsed_ms` 실측으로 갱신 경로가 생겼다고 적을 수 있다.

## 닫는 순서 권고

1. **epic 3 인셉션 전(필수):** C-1, C-2 — AD-17 283행 한 문장. 이어서 H-1·H-2·H-3도 같은 두 줄(283·287행) 안에서 끝난다.
2. **같은 편집 세션에서(싸다):** H-7(Conventions·AD-4 한 줄씩), M-1(표 깨짐), M-2, L-1~L-5.
3. **epic 4·5 인셉션 전:** H-4(Capability map 행), H-5(Structural Seed `tooling/eval`), M-6·M-7(`--count` 상한과 `meta.count`), M-8.
4. **Deferred 문구 정리(언제든):** H-6, M-4, M-5, L-6.
5. spine을 고친 뒤 제안 문서 머리에 "반영 완료(2026-10-20)"를 적고, 이 리뷰에서 §4.3이 요청하지 않았던 네 자리(Conventions, AD-6 다이어그램, Capability map, Structural Seed)를 그 기록에 남긴다.
