---
name: 'Adversary review — 2026-10-20 델타(기록 규율 점검·지표·집계) 공격'
type: architecture-review
lens: adversary
target: ./architecture-brain-v1-slice-1.md
target_updated: '2026-10-20'
reviewed: '2026-10-20'
scope: 'change-discipline-and-metrics §4.3이 spine에 더한 것만 — AD-5 표 두 행, AD-6 한 문장, AD-15 한 줄, AD-17 두 문장, AD-18 설정 키, Table Contract `context_injections` 칸, Deferred 네 행'
method: 'AD를 한 글자도 어기지 않는 하위 단위 두 개를 만들어 서로 못 붙게 만든다'
---

# Adversary — 2026-10-20 델타 공격

## 공격 방법

"spine이 틀렸다"를 찾지 않는다. **델타를 글자 그대로 지키면서도 서로 못 붙는 하위 단위 쌍**을 만든다. 쌍이 성립하면 그 자리가 구멍이고, 구멍마다 **그대로 붙여 쓸 한 문장**을 제시한다. 단위는 한 단계 아래(에픽·스토리)에서 고르고, 이미 커밋된 코드가 있는 단위는 그 코드를 근거로 쓴다.

| 단위 | 소속 | 근거 AD |
| --- | --- | --- |
| U-rem — Stop 점검 (`log remind` + 동기 Stop hook) | epic 3 (신설) | AD-5, AD-6, AD-17 |
| U-ctx — 동기 시작 맥락 (`context show` + SessionStart hook) | epic 3 | AD-6, AD-17 |
| U-cap — 비동기 Stop 수집 (story 2.14) | epic 2 | AD-4, AD-6 |
| U-prs — parser·커서 (story 2.21·2.23) | epic 2 | AD-4, AD-8 |
| U-cdc — Core 출력 코덱(`OUTPUT_CODECS`, `encodeHookOutput`, 2.17 커밋됨) | epic 2 | AD-11 |
| U-mig3 — `context_injections.kind`·`elapsed_ms` 마이그레이션 | epic 3 | AD-20, Table Contract |
| U-drn — spool 재주입·폴더 스캔 | epic 2·5 | AD-7, AD-9, AD-21 |
| U-stat — `stats show` | epic 5 (신설) | AD-13, Conventions |
| U-cnt — `recall … --count` | epic 4 | AD-15 |
| U-eval — `tooling/eval` 회귀 러너 | epic 4 (신설) | AD-1, AD-11, Structural Seed |
| U-cfg — 설정 코덱 | epic 1·5 | AD-18 |
| U-inst — 설치기 `setup run` | epic 1 | AD-19 |
| U-lnch — 플러그인 런처·`hooks.json` | epic 2·3 | AD-19 |
| U-mcp — MCP 생성 | epic 9 | AD-28 |

## 판정

**델타의 방향은 성립한다**(Stop 점검은 주입이 아니라 세션당 한 번의 질문이므로 spec Non-goal과 충돌하지 않고, 표식 파일·spool은 AD-6의 "동기 경로에 쓰기 트랜잭션 없음"을 지킨다). **그러나 기존 AD와 정면으로 어긋나는 문장이 하나 남아 있고**(AD-6 셋째 항목의 `brain log` 선수집 규칙이 `log remind`를 덮는다), **델타의 핵심인 측정 계약 — `context_injections`의 `stop` 행이 언제 생기고 `ok`·`chars`가 무슨 뜻인가 — 가 비어 있어** epic 3이 쓰는 모집단과 epic 5가 읽는 모집단이 서로 달라질 수 있다. 이 둘을 메우지 않으면 D3(둘째 주에 켜서 SM-4a 비교)이 숫자를 내고도 답을 주지 못한다.

| 등급 | 수 | 성격 |
| --- | --- | --- |
| critical | 2 | 기존 AD와의 충돌 1, 측정 계약 공백 1 |
| high | 6 | 모집단·표식 수명·비용·표면 노출·시간 경계 |
| medium | 10 | 코덱 범위, 지표 판정 함수, 결과 계약 빈칸, 문서 소유 |
| low | 5 | 열거 누락·그림·상수 목록 |

---

## Critical

### C1 — `brain log` 네임스페이스 선수집 규칙이 동기 Stop 경로에 쓰기를 집어넣는다

- **AD:** AD-6(둘째 항목 vs 새 첫 항목), AD-7
- **두 단위:** U-rem(epic 3: "읽기, spool, 표식 파일만") vs U-cap/U-prs가 만드는 **선수집 래퍼**(AD-6 셋째 항목: "`brain log`와 `brain recall`은 connector가 transcript를 찾을 수 있으면 그 세션을 먼저 증분 수집한다")
- **왜 둘 다 AD를 지키는가:** 선수집 래퍼를 네임스페이스 단위(`log.*`, `recall.*`)로 구현하는 것은 AD-6 문장 그대로다. `log remind`는 AD-5 표에서 `log` 네임스페이스의 verb다. 그러면 Stop 점검은 호출되자마자 `sessions.ingest`(쓰기 트랜잭션, `BEGIN IMMEDIATE`)를 돌린다.
- **무너지는 지점:** AD-6이 같은 항목에서 금지한 "동기 경로의 쓰기 트랜잭션"이 매 턴 Stop에서 열린다. 더 나쁜 것은 조건 3("`log_entries`에 줄이 없음")이 그 수집 뒤에 평가되므로, 수집이 2초 잠금을 쥐는 동안 세션 종료가 그만큼 늦어지고(NFR-7), 수집 실패는 spool로 가는데 점검은 그것을 모른다.
- **닫는 규칙:** "AD-6의 선수집은 네임스페이스가 아니라 verb 목록이다 — `log.append`·`log.list`·`log.edit`·`log.set-state`·`log.set-scope`와 `recall.*`에만 적용하고, hook 경로 verb(`context.show`, `log.remind`)는 어떤 경우에도 선수집하지 않는다."

### C2 — `context_injections`의 `stop` 행이 언제 생기는지, `ok`·`chars`·`code`가 무슨 뜻인지 아무도 정하지 않았다

- **AD:** AD-17(마지막 항목), Table Contract `context_injections`, AD-9
- **두 단위:** U-rem(쓰는 쪽: spool 레코드를 만든다) vs U-stat(읽는 쪽: "Stop 점검 뒤 같은 세션에 로그가 생긴 비율"의 분모·분자)
- **왜 둘 다 AD를 지키는가:** 0001의 컬럼은 `ok`(not null), `code`, `chars`(not null), `attempted_at`이고 전부 "시작 맥락 주입"의 뜻으로 만들어졌다. 델타는 `kind`·`elapsed_ms`만 더하고 나머지 네 칸의 `stop` 의미를 말하지 않는다. U-rem은 "실제로 `decision: block`을 낸 호출만 기록"으로 읽고(가장 적게 쓰는 해석, `ok`는 항상 1), U-stat은 "점검이 돌 때마다 기록"으로 읽는다(그래야 분모가 생긴다). 둘 다 AD-17 문장("Stop 점검 시도도 같은 경로로 남는다")에 맞는다.
- **무너지는 지점:** 분모가 "차단한 횟수"냐 "점검이 돈 횟수"냐에 따라 같은 SQL이 전혀 다른 비율을 낸다. D3의 주 단위 비교는 이 비율 하나로 기본값을 정하므로, 해석이 갈리면 2주 실사용이 끝난 뒤에야 숫자가 뜻이 없다는 것을 안다. `chars`가 not null이므로 무동작 호출은 `chars = 0`을 써야 하는데, 그러면 SM-C1(시작 맥락 크기 중앙값)이 0 더미로 오염된다 — U-stat이 `kind`로 거르지 않으면 조용히 틀린다.
- **닫는 규칙:** "`kind='stop'` 행은 **토글이 켜진 상태에서 점검이 실제로 돈 호출마다** 하나씩 남는다 — `ok=1`은 `decision: block`을 낸 호출, `ok=0`은 내지 않은 호출이고 그 이유를 `code`(`STOP_ACTIVE`·`TOO_EARLY`·`HAS_LOG`·`ALREADY_REMINDED`)에, 출력 글자 수를 `chars`(내지 않았으면 0)에 적는다. 토글이 꺼진 호출은 행을 만들지 않으며, `chars`를 쓰는 모든 지표는 `kind`로 먼저 거른다."

---

## High

### H1 — "사용자 발화"의 정의와 출처가 둘이고, SM-4a의 적격 모집단이 없다

- **AD:** AD-17(조건: "그 세션의 사용자 발화가 Core 상수 이상"), AD-4, AD-13
- **두 단위:** U-rem(hook stdin의 `transcript_path`를 parser로 읽어 센다) vs U-stat(DB `messages`로 SM-4a를 센다)
- **왜 둘 다 AD를 지키는가:** D1이 출처를 transcript로 못 박은 것은 수집 지연을 피하려는 것이고 옳다. U-stat은 DB 말고 셀 곳이 없다. 그런데 "사용자 발화"가 무엇인지는 어느 쪽에도 없다 — parser v3는 서브에이전트 핸드백을 role assistant로 내고 `isMeta` 줄을 거르며, hook 메시지·슬래시 명령 확장도 user 줄로 나타난다. 한쪽이 그것을 세고 다른 쪽이 안 세면 같은 세션이 한쪽에서는 적격, 다른 쪽에서는 비적격이다.
- **무너지는 지점:** 더 큰 문제는 모집단이다. 점검은 사용자 발화 3개 이상인 세션에만 뜨는데 SM-4a는 모든 세션을 센다. 한 줄짜리 `claude -p` 세션이 모집단의 절반이면 켠 주와 끈 주의 SM-4a 차이는 희석되어 D3이 효과를 보지 못한다.
- **닫는 규칙:** "사용자 발화의 정의는 Core 술어 하나(`isUserTurn`)이고 parser 출력과 저장된 `messages`가 같은 답을 내야 하며, `stats show`는 SM-4a를 전체 세션과 **적격 세션(사용자 발화 ≥ `STOP_REMIND_MIN_USER_TURNS`)** 두 모집단으로 내고 토글 판단은 후자로 한다."

### H2 — 조건 3이 spool을 보지 않아, 로그를 적은 세션을 다그친다

- **AD:** AD-9(`log.append`는 DB에 못 쓰면 `SPOOLED` 경고와 함께 성공), AD-17, AD-6
- **두 단위:** U-rem(조건: "`log_entries`에 그 세션의 줄이 없음" — DB 읽기 한 번) vs U-log/U-drn(spool에 쌓인 로그 원문은 drain 전까지 DB에 없다)
- **왜 둘 다 AD를 지키는가:** AD-17의 조건 문장은 `log_entries`만 말한다. AD-9는 spool에 둔 로그도 "적은 것"으로 사용자에게 답하라고 한다. 두 문장을 각각 지키면 "에이전트가 성실히 적었는데 DB가 잠겨 spool로 갔고, 같은 턴의 Stop 점검이 '아직 안 적었다'고 다그치는" 상태가 된다.
- **무너지는 지점:** 같은 함정이 더 흔한 경로로도 열린다 — 세션 행 자체가 없을 때(AD-6: 세션 행은 첫 수집이 만든다. 수집이 밀리거나 실패하면 없다) "그 세션의 로그 0줄"은 참이 되어 점검이 뜬다. 규율 수단이 오탐을 내면 SM-4가 아니라 사용자의 신뢰가 깎인다.
- **닫는 규칙:** "점검은 '모르면 묻지 않는다' — 세션 행이 없거나 spool에 그 세션 토큰의 `log.append` 레코드가 하나라도 남아 있으면 아무것도 내지 않고 exit 0이며, 이 판정은 파일 읽기만으로 한다."

### H3 — 표식 파일을 언제·어느 이벤트에서 만드는지가 비어 있어 "세션당 한 번"이 "세션당 영 번"이 된다

- **AD:** AD-17(세션당 한 번은 표식 파일이 보장한다), AD-6
- **두 단위:** U-rem의 "안전하게 먼저 세운다" 구현(진입 직후 표식 생성 → 어떤 경로로 죽어도 두 번 묻지 않음) vs U-rem의 "낸 뒤 세운다" 구현(`decision: block`을 낸 호출만 표식 생성). 더해서 U-lnch가 `Stop`과 `SubagentStop` 양쪽에 같은 줄을 거는 구현.
- **왜 둘 다 AD를 지키는가:** AD-17은 "표식 파일이 보장한다"만 말하고 생성 시점도, 어떤 hook 이벤트에서 도는지도 말하지 않는다. 비동기 수집(2.14)은 `SubagentStop`도 거는 것이 자연스러우므로 런처 줄이 복사될 여지가 크고, `SubagentStop`의 stdin `session_id`는 부모 세션이다.
- **무너지는 지점:** 진입 시 생성이면 사용자 발화 1개인 첫 Stop(조건 미달, 무동작)이 그 세션의 유일한 기회를 태워 점검은 영원히 뜨지 않는다 — 켠 주와 끈 주의 SM-4a가 같아지고 D3은 "효과 없음"이라는 틀린 결론을 낸다. `SubagentStop`까지 걸리면 서브에이전트 하나가 부모의 표식을 먼저 세운다.
- **닫는 규칙:** "표식 파일은 `decision: block`을 stdout에 쓴 **그 코드 경로에서, 출력 뒤에만** 만들고, 점검은 `hook_event_name === 'Stop'`인 stdin에만 응답하며 그 밖의 이벤트에서는 표식도 spool 레코드도 만들지 않는다."

### H4 — 토글이 꺼진 기본 설치에서도 동기 Stop 줄은 매 턴 프로세스를 띄운다

- **AD:** AD-18(토글은 `~/.second_brain/config.toml`), AD-19(Claude Code의 hook 출처는 커밋된 플러그인 `hooks.json` 하나. 설치기가 hook을 쓰지 않는다), NFR-3·NFR-7
- **두 단위:** U-lnch(정적 `hooks.json`에 동기 Stop 줄을 더한다 — 설정을 읽을 수단이 없는 sh 런처) vs U-cfg/U-rem(토글을 읽는 것은 node 프로세스 안)
- **왜 둘 다 AD를 지키는가:** 플러그인 `hooks.json`은 저장소에 커밋되는 고정 파일이고 AD-19는 설치기가 Claude Code의 hook을 쓰는 것을 금지한다. 그러므로 줄은 토글과 무관하게 항상 등록된다. 에픽 3의 Done when("토글이 꺼져 있으면 Stop hook이 DB를 열지 않는다")은 DB만 말하고 프로세스 기동은 말하지 않는다.
- **무너지는 지점:** 기본값이 false인 기능 때문에 **모든 사용자의 모든 턴마다** node 기동(수백 ms)이 동기로 붙는다. 체감 지연은 세션 종료 지점이라 가장 잘 보이고, 비용은 기능을 안 쓰는 사람이 전부 낸다.
- **닫는 규칙:** "동기 Stop 줄은 항상 등록하되, `log.remind`는 설정 파일 한 번과 표식 파일 한 번만 읽고 끝나는 조기 반환 경로를 가지며(DB·parser·SDK 조립 없음), 그 무동작 경로의 전체 시간 상한을 Core 상수로 두고 테스트가 지킨다."

### H5 — `log.remind`가 AD-5 표에 있으므로 AD-28이 모델에게 그 도구를 쥐여 준다

- **AD:** AD-5(표면 중립: SDK verb = CLI = MCP 도구), AD-28(도구 스키마는 명령 메타에서 생성), AD-26(소켓 verb는 AD-5 표의 것만)
- **두 단위:** U-mcp(AD-5 표의 모든 verb를 `<ns>_<verb>`로 생성한다 — 제외 규칙이 없다) vs U-rem(hook stdin이 있어야 뜻이 서는 verb)
- **왜 둘 다 AD를 지키는가:** AD-5 표에 행이 올라간 순간 AD-28은 그것을 도구로 만든다. 명령 메타에 `hook` 칸은 있지만 "hook 전용"의 뜻도, MCP 생성에서 제외한다는 문장도 없다.
- **무너지는 지점:** 모델이 `log_remind`를 직접 부르면 표식 파일이 서고 `context_injections(kind='stop')` 행이 생긴다 — 규율 수단이 모델이 스스로 끌 수 있는 스위치가 되고, epic 5의 지표 모집단이 모델의 호출로 오염된다. `stats show`의 "점검 뒤 로그가 생긴 비율"은 그 호출을 구별하지 못한다.
- **닫는 규칙:** "명령 메타의 `hook`은 `no | yes | only` 셋이고, `only`인 verb(`log.remind`)는 MCP·소켓 표면에 생성되지 않으며 hook stdin 없이 불리면 아무 상태도 만들지 않고 `USAGE`로 끝낸다."

### H6 — `--from/--to`와 `by_month`의 시간대·경계가 없어 두 명령이 같은 사건을 다른 주·다른 달에 넣는다

- **AD:** AD-13(절대 시각만, 저장 정규형 24자, Store는 경계에서 다른 형태를 거부), AD-15(새 `--count` 줄), Conventions(사람용 출력만 설정 시간대)
- **두 단위:** U-stat(`stats show --from <날짜> --to <날짜>`) vs U-cnt(`--count`의 `by_month`)
- **왜 둘 다 AD를 지키는가:** 델타와 에픽 입력은 둘 다 "절대 날짜"라고만 적었다. `2026-10-13`은 AD-13의 정규형이 아니므로 어딘가에서 순간으로 바뀌어야 하는데, 그 변환의 시간대(UTC냐 설정 `Asia/Seoul`이냐)와 끝 경계(닫힌 구간이냐 반열린 구간이냐)를 아무도 소유하지 않는다. U-cnt는 `substr(occurred_at,1,7)`(UTC)로 월을 가르는 것이 가장 싸고, U-stat은 사람이 주는 날짜라 로컬로 읽는 것이 자연스럽다.
- **무너지는 지점:** KST 오전 9시 이전의 사건은 UTC로 전날이다. D3의 주 단위 비교에서 경계 하루가 양쪽에 들어가거나 빠지고, 같은 필터를 준 `stats show`와 `recall --count`가 서로 다른 수를 낸다 — "같은 수를 SQL로 직접 세면 같다"는 epic 5의 Done when이 어느 해석을 뜻하는지도 정해지지 않는다.
- **닫는 규칙:** "날짜 인자와 월 버킷은 Core 함수 하나가 (날짜, 설정 시간대) → **반열린 UTC 구간** `[from, to)`로 바꾸고, `stats show`와 `recall --count`가 그 함수만 쓰며, 응답은 해석된 절대 구간을 `meta`에 되울린다(AD-13의 '받은 범위를 되울린다')."

---

## Medium

### M1 — `elapsed_ms`가 내부 시간인지 전체 시간인지 정해지지 않았다

- **AD:** AD-17(마지막 항목, "두 종류 모두 `elapsed_ms`를 기록한다(SM-7)"), PRD SM-7
- **두 단위:** U-rem/U-ctx(프로세스 안에서 재므로 내부 시간만 잴 수 있다) vs U-stat(SM-7을 보고하는 쪽. SM-7은 내부 0.5초와 전체 1초 두 목표를 함께 가진다)
- **무너지는 지점:** 런처·node 기동이 빠진 수를 전체 목표(1초)에 대면 항상 통과하고, 반대로 내부 목표(0.5초)에 대면 맞지만 아무도 그것을 적어 두지 않았다.
- **닫는 규칙:** "`elapsed_ms`는 **내부 시간**(use case 진입부터 출력 문자열 완성까지)이고 Runtime의 계측 헬퍼 하나가 찍으며, `stats show`는 그것을 내부 시간으로만 보고한다 — 프로세스 기동을 포함한 전체 시간은 이 칸으로 재지 않는다."

### M2 — hook 출력 코덱의 범위가 "시작 맥락"으로 적혀 있고, Conventions의 exit 2 금지 사유가 델타와 어긋난다

- **AD:** AD-11(나가는 길 열거: "hook 출력 코덱(시작 맥락)"), Conventions `hook 응답`("Stop의 exit 2는 턴을 이어 가게 하므로 금지")
- **두 단위:** U-cdc(`packages/core/src/output/codecs.ts`의 `encodeHookOutput`은 이미 있고 주석이 "시작 맥락 주입이 쓸 것"이라고 적혀 있다) vs U-rem(두 번째 hook 출력 작성자)
- **왜 둘 다 AD를 지키는가:** AD-11의 괄호가 시작 맥락만 명시하므로, 상수 문장만 내는 Stop 출력은 "가릴 것이 없다"며 `JSON.stringify`로 직접 쓰는 것이 문장 위반이 아니다. 2.17의 싱크 스캔 테스트는 코덱 이름만 요구하므로 직렬화된 JSON에 `encodeHookLine`(텍스트 코덱)을 거는 구현도 통과한다 — 그러면 패턴이 escape 문자열 위를 지난다.
- **또 하나:** Conventions가 exit 2를 금지한 **이유**로 "턴을 이어 가게 하므로"를 적었는데, 델타는 바로 그 턴 잇기를 원한다. 그 문장을 그대로 읽으면 "exit 2로 구현해도 목적은 같다"는 구현이 나온다(코덱·토글·표식을 모두 우회하고 stderr가 사용자에게 샌다).
- **닫는 규칙:** "hook stdout의 JSON은 언제나 `encodeHookOutput`(값만 가리고 키는 그대로, 그 뒤 직렬화)을 거치고 — 시작 맥락과 Stop 결정이 둘 다 그 작성자다 — hook 경로는 여전히 항상 exit 0이며, 턴을 잇는 것은 `{decision:'block', reason}`으로만 표현한다(exit 2와 stderr는 금지)."

### M3 — 표식 파일의 수명과 소유자가 어느 문서에도 없다

- **AD:** AD-17(`<home>/run/stop-remind/<harness>-<id>`), Conventions `설치·런타임 기록`(`<home>/run/`의 내용물을 열거하는데 거기에 없다), AD-20(`setup uninstall`이 `<home>/run/`을 지운다)
- **두 단위:** U-rem(세션마다 파일 하나를 만든다) vs U-drn/doctor(정리하는 주체가 지정되지 않았다)
- **무너지는 지점:** 제거 명령 말고는 지우는 경로가 없어 세션 수만큼 파일이 영구히 쌓인다(개인 사용이라 치명적이지는 않지만, `<home>/run/`은 "현재 사실"을 두는 곳이라는 규약이 깨진다). Conventions 열거에 없으므로 doctor도, 백업·제거의 대상 판정도 이 폴더를 모른다.
- **닫는 규칙:** "Conventions의 `<home>/run/` 열거에 `stop-remind/<harness>-<id>`(세션당 한 번의 사실)를 더하고, drain의 정리 일감이 Core 상수(기본 7일)보다 오래된 표식을 지운다."

### M4 — "`brain recall`이 불렸다"의 판정 함수가 없다

- **AD:** AD-5 표(`stats` 행: "§8-8 대리 지표"), AD-11(도구 메모 대상 규칙), AD-28
- **두 단위:** U-stat(도구 메모 `target`에서 `brain recall`을 찾는다) vs U-prs(2.23의 도구 메모 규칙: `target`은 `TOOL_NOTE_TARGET_LIMIT` 500자에서 잘리고 잘린 꼬리는 `[REDACTED:truncated]`가 된다) / U-mcp(epic 9의 호출은 `brain recall`이라는 문자열이 아니라 도구 이름 `recall_chunks`다)
- **무너지는 지점:** 긴 Bash 한 줄 뒤에 붙은 `brain recall`은 절단되어 안 세어지고, MCP가 켜지는 순간 대리 지표가 조용히 0으로 간다 — NFR-2가 금지한 "조용히 틀린 성공"이다.
- **닫는 규칙:** "'Brain으로 찾아봤는가'의 판정은 (도구 이름, `target`)을 받는 Core 술어 하나이고 CLI 형태와 MCP 도구 이름을 모두 포함하며, 판정은 저장된 원문 위에서 한다(출력 가리기는 수를 바꾸지 않는다)."

### M5 — `--count`의 결과 모양이 `docs`에 맞지 않고, 어떤 verb가 받는지가 없다

- **AD:** AD-15(새 줄: "같은 필터로 세션 수·행 수·월별 건수만 `data`로"), AD-23·AD-24
- **두 단위:** U-cnt(`data: {sessions, rows, by_month}` 하나로 세 verb를 덮는다) vs AD-15 결과 계약의 문서 쪽(문서는 `file_id`·표시 이름·조각 위치로 나오고, 첨부가 아니면 세션이 없으며 `occurred_at`에 해당하는 칸이 무엇인지 — 첨부 시각·추출 시각·파일 시각 — 정해지지 않았다)
- **무너지는 지점:** `recall docs --count`의 `sessions`는 항상 0이거나, 첨부된 세션만 세거나, 아예 빠진다. 또 `recall tools`·`recall time`이 `--count`를 받는지도 적혀 있지 않아 표면이 갈린다(CAP-10의 표면 테스트는 verb만 보므로 잡지 못한다).
- **닫는 규칙:** "`--count`는 `chunks`·`logs`·`docs` 셋만 받고(나머지는 exit 2의 사용법 오류), `sessions`는 맞은 행이 붙어 있는 서로 다른 세션 수(붙지 않은 문서는 0), `by_month`는 verb마다 선언된 기준 시각 칸 하나로 가르며 그 칸 이름을 `meta`에 적는다."

### M6 — `--count` 모드의 `meta.count`·`has_more`·`RESULT_TRUNCATED`가 정해지지 않았다

- **AD:** AD-15(8,000자 규칙 밖), Conventions(`meta`는 `{hint?, count?, has_more?, omitted?, next?}`)
- **두 단위:** U-cnt vs 엔벨로프 코덱(모든 읽기 결과가 같은 `meta` 모양을 쓴다)
- **무너지는 지점:** `meta.count`의 뜻을 "돌려준 행 수"로 유지한다고 했는데 `--count` 응답의 행은 집계 객체 하나다 — 1이 들어가면 "1건 찾았다"로 읽히고, 생략하면 일관성이 깨진다. 에이전트가 `has_more`를 보고 다음 페이지를 부를 수도 있다.
- **닫는 규칙:** "`--count` 응답에는 `meta.count`·`has_more`·`omitted`·`RESULT_TRUNCATED`를 붙이지 않는다 — 세는 것은 `data` 안에만 있다."

### M7 — "0"과 "잴 수 없음"이 구분되지 않는다

- **AD:** NFR-2(조용한 실패 금지), Conventions `--json` 응답, AD-20(마이그레이션은 앞으로만)
- **두 단위:** U-mig3(기존 행은 `kind='start'`, `elapsed_ms`는 null) vs U-stat(epic 5 Done when: "로그가 하나도 없는 기간은 0이며")
- **무너지는 지점:** 세션이 0인 기간의 SM-4a는 0이 아니라 정의되지 않는다. 마이그레이션 이전 주의 SM-7은 "0ms"가 아니라 "기록 없음"이다. 0으로 내면 A/B 비교가 없는 데이터를 "나쁜 주"로 읽는다.
- **닫는 규칙:** "셀 대상이 0건인 지표는 `null`과 그 사유를 내고, 비율의 분모가 0이면 `null`이다 — 0은 '쟀는데 0'일 때만 쓴다."

### M8 — `ingest_source='import'`를 누가 붙이는지가 없어 기본 제외가 모집단을 통째로 지울 수 있다

- **AD:** Table Contract `sessions`(`ingest_source(live|import)` 불변), AD-7(drain의 transcript 폴더 스캔), epic 5 입력("기본으로 `import` 세션 제외")
- **두 단위:** U-drn(폴더 스캔으로 뒤늦게 줍는 세션) vs U-stat(기본 필터)
- **무너지는 지점:** 폴더 스캔이 주운 세션을 `import`로 적으면, hook이 실패했거나 설치 직후의 세션이 지표에서 통째로 빠진다 — SM-5(수집 누락)는 올라가는데 SM-4a는 그 사실을 모르고, Stop 점검이 돌지 못한 세션만 골라 빼는 셈이라 A/B가 점검에 유리하게 편향된다.
- **닫는 규칙:** "`import`는 설치 때 한 번 하는 백필(`setup run`)만 붙이고, 이후 폴더 스캔이 줍는 세션은 `live`다 — Table Contract의 `sessions` 행에 그 한 줄을 적는다."

### M9 — 공용 런처의 "node 못 찾음" 한 줄이 Stop 이벤트에서는 매 턴 뜬다

- **AD:** AD-19(런처가 하한 이상의 node를 못 찾으면 stdout에 `systemMessage` 한 줄), AD-6
- **두 단위:** U-lnch(SessionStart용으로 설계된 런처를 Stop 줄이 그대로 쓴다 — 델타가 "기존 런처·`|| exit 0`·timeout 그대로"라고 적었다) vs U-rem(동기 Stop의 stdout은 결정 JSON을 읽는 자리다)
- **무너지는 지점:** node 경로가 깨진 기계에서 턴마다 같은 문구가 뜨고, 그 한 줄이 결정 JSON 자리에 들어간다.
- **닫는 규칙:** "런처의 미발견 안내는 SessionStart에서만 내고, Stop을 비롯한 그 밖의 이벤트에서는 아무것도 쓰지 않고 exit 0이다."

### M10 — 규율 문장이 두 번째 원본이 되고, 회귀 러너의 결과 파일은 코덱 없는 출구다

- **AD:** AD-17(규율의 원본은 Core 상수 하나, 플러그인 스킬은 빌드가 생성하고 parity 테스트가 지킨다), AD-11(나가는 길 열거), AD-1·Structural Seed
- **두 단위:** U-rem(제안서 표현: 점검 문장을 "규율 원본 상수 **옆**"에 둔다 → 별도 상수) vs `guide.show`·플러그인 스킬 생성(같은 규율의 다른 표현) / U-eval(`~/.second_brain/eval/results/`에 JSON을 쓴다) vs U-cdc(2.17의 싱크 스캔은 stdout·stderr만 본다)
- **무너지는 지점:** 규율 문구가 두 곳에서 따로 늙고 parity 테스트가 그 둘의 어긋남을 보지 못한다. 러너 결과 파일은 질의문과 맞은 행을 담는데 AD-11의 출구 목록에 없어, 스니펫을 함께 적는 순간 가리기를 거치지 않은 텍스트가 파일로 나간다. spine은 러너를 Deferred 칸에서 한 번 참조하면서 어느 층에 사는지(`tooling/`)는 적지 않았다.
- **닫는 규칙:** "점검 reason은 규율 원본 상수의 한 절을 같은 렌더러로 낸 것이고 parity 테스트가 그 포함 관계를 검사하며, 회귀 러너는 SDK 엔벨로프(이미 가려진 출력)만 읽어 식별자와 점수만 기록한다 — 원문 스니펫은 쓰지 않는다."

---

## Low

### L1 — AD-6의 그림에 동기 Stop 화살표가 없다

- **AD:** AD-6 시퀀스 다이어그램(턴마다 `H--)B: Stop (async)` 하나뿐)
- **두 단위:** U-cap vs U-rem — 같은 이벤트에 hook 둘이라는 사실이 글에는 있고 그림에는 없다. 그림만 보고 구현하면 Stop 줄은 하나다.
- **닫는 규칙:** "다이어그램의 턴 루프에 동기 Stop 화살표(`H->>B: Stop (동기, 짧은 timeout) → log remind`)를 비동기 수집 화살표와 나란히 그린다."

### L2 — AD-7의 `busy_timeout` 상수 목록에 동기 hook 경로가 없다

- **AD:** AD-7("턴 수집 3초, 사람이 부른 명령 10초, drain 10초")
- **두 단위:** U-ctx·U-rem(동기 hook) vs U-ing — 목록에 없으므로 구현자는 3초나 10초 중 하나를 고르고, 10초면 세션 종료가 10초 멈춘다.
- **닫는 규칙:** "동기 hook 경로의 `busy_timeout`은 별도 Core 상수(짧게)이고, 그 시간을 넘으면 점검은 아무것도 내지 않고 exit 0이다."

### L3 — AD-7의 기회적 drain 예외 괄호가 `context show`만 든다

- **AD:** AD-7("예외: 동기 시작 hook(`context show`)과 hook 경로의 명령은 돌지 않고")
- **두 단위:** U-rem vs U-drn — 뒷절이 이미 덮지만, 괄호 예시가 하나뿐이라 "hook 경로의 명령"을 좁게 읽을 여지가 남는다.
- **닫는 규칙:** "괄호를 `(context show, log remind)`로 고친다."

### L4 — Deferred의 Codex 행 "폴더 등록만"을 소유하는 AD가 없다

- **AD:** Deferred(Codex 행), AD-18(설정 키 목록), AD-4
- **두 단위:** 그때의 Codex connector vs U-cfg — transcript 폴더 경로가 설정 키인지 connector 상수인지 정해지지 않아, `setup connect` 없이 "폴더 등록"을 하려면 둘 중 하나를 즉석에서 고른다.
- **닫는 규칙:** "transcript 폴더의 발견은 connector가 상수로 소유한다(설정 키를 늘리지 않는다) — 그래서 수집 전용 Harness는 `setup connect` 없이 붙는다."

### L5 — Structural Seed가 `tooling/`을 모른다

- **AD:** AD-1 층 표, Structural Seed
- **두 단위:** U-eval vs AD-1 — 저장소에는 이미 `tooling/`이 있고 `pnpm-workspace.yaml`도 그것을 글롭에 두는데, spine의 구조도에는 없다. 새 패키지가 어느 층(의존 방향)에 속하는지 문서가 답하지 않는다.
- **닫는 규칙:** "Structural Seed에 `tooling/`(개발·측정 도구. `second_brain`에만 의존하고 어떤 adapter도 직접 부르지 않는다)을 더하고 `eval`을 그 밑에 적는다."

---

## 기존 AD와의 충돌 점검 (델타가 통과한 것)

공격했으나 성립하지 않은 쌍도 남긴다 — 다음 검토가 같은 자리를 다시 파지 않도록.

| 점검 | 결과 |
| --- | --- |
| AD-6 "동기 경로에 쓰기 트랜잭션 없음" vs 표식 파일 | **통과.** 표식은 `<home>/run/`의 사실 파일이고 DB 쓰기가 아니다. 다만 C1의 선수집 규칙이 뒷문으로 쓰기를 들인다 |
| AD-7 기회적 drain 예외 vs Stop 점검 | **통과.** "hook 경로의 명령은 돌지 않는다"가 이미 덮는다(L3는 표현만) |
| AD-17 "규율 원본은 Core 상수 하나" vs 점검 문장 | **조건부 통과.** 같은 상수의 한 절이면 통과, 별도 상수면 M10 |
| spec Non-goal "프롬프트마다 맥락을 밀어 넣는 것" vs Stop 점검 | **통과.** 주입이 아니라 세션당 한 번의 질문이고 내용(규칙·로그)을 싣지 않는다. 단 reason에 DB에서 읽은 문장을 넣는 순간 이 통과는 깨지므로 "reason은 상수뿐"을 지킨다 |
| `stop_hook_active` 루프 가드 | **통과.** 조건에 들어 있고 표식 파일이 이중으로 막는다. 차단 뒤 모델이 로그를 적으면 조건 3이, 안 적어도 `stop_hook_active`가 두 번째 차단을 막는다 |
| AD-11 "저장본은 원문, 출력에서 가리기" vs 점검·지표 | **통과.** 점검은 읽기만 하고, 지표는 수만 낸다(M4의 판정은 원문 위에서 하라는 단서 필요) |
| AD-20 "마이그레이션은 `setup run`·`setup upgrade`만" vs epic 3의 마이그레이션 | **통과.** 소유 에픽만 다르고 실행 주체는 그대로다 |
| `context_injections.session_id`의 not null·FK vs `stop` 행 | **통과(단서).** Stop 시점에는 세션 행이 있을 가능성이 높지만, 없으면 drain이 10번 실패하고 `failures`로 간다 — spool 레코드가 세션 **토큰**을 들고 drain이 그것으로 해석한다는 AD-9의 기존 규칙을 그대로 따르면 된다 |

## 붙여 쓸 문장 모음 (상위 8)

| # | 어디에 | 문장 |
| --- | --- | --- |
| C1 | AD-6 셋째 항목 | 선수집은 `log.append`·`list`·`edit`·`set-state`·`set-scope`와 `recall.*`에만 적용하고, hook 경로 verb(`context.show`, `log.remind`)는 선수집하지 않는다. |
| C2 | AD-17 마지막 항목 / Table Contract | `kind='stop'` 행은 토글이 켜진 상태에서 점검이 돈 호출마다 하나씩 남고, `ok=1`은 차단을 낸 호출, `code`는 내지 않은 이유, `chars`는 출력 글자 수(없으면 0)다. |
| H1 | AD-17 | 사용자 발화의 정의는 Core 술어 하나이고, `stats.show`는 SM-4a를 전체와 적격(발화 ≥ 상수) 두 모집단으로 낸다. |
| H2 | AD-17 | 세션 행이 없거나 spool에 그 세션의 `log.append`가 남아 있으면 점검은 아무것도 내지 않는다. |
| H3 | AD-17 | 표식 파일은 차단을 낸 경로에서 출력 뒤에만 만들고, 점검은 `Stop` 이벤트에만 응답한다. |
| H4 | AD-6 | `log.remind`는 설정과 표식만 읽고 끝나는 조기 반환 경로를 가지며 그 시간 상한은 Core 상수다. |
| H5 | AD-5 / AD-28 | 명령 메타의 `hook`은 `no | yes | only`이고 `only`인 verb는 MCP·소켓에 생성되지 않는다. |
| H6 | AD-13 / AD-15 | 날짜 인자와 월 버킷은 (날짜, 설정 시간대) → 반열린 UTC 구간 함수 하나로 바꾸고 응답에 되울린다. |
