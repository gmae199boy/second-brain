# Architecture Spine — 적대적 검토 (Adversary)

- **대상:** `architecture-brain-v1-slice-1.md` (AD-1~AD-19, Consistency Conventions, Structural Seed)
- **입력:** `../.memlog.md`, `../../prd-brain-v1-slice-1/prd-brain-v1-slice-1.md`, `../../prd-brain-v1-slice-1/addendum.md`
- **렌즈:** 적대자. spine을 공격한다. **AD를 글자 그대로 전부 지키면서도 서로 맞지 않게 만들어지는 "한 단계 아래 단위의 쌍"**을 찾는다. 찾은 쌍은 전부 구멍이고, 각 구멍마다 그것을 닫는 최소 규칙을 제안한다.
- **방법:** 쌍의 양쪽은 모두 합법이어야 한다. 한쪽이 AD를 위반하면 그것은 구멍이 아니라 그냥 버그이므로 세지 않았다. 각 항목은 〈쌍 → 둘 다 합법인 근거 → 부딪히는 것 → 최소 규칙〉으로 적었다.
- **읽기 전 전제:** 이 검토는 "spine이 나쁘다"는 말이 아니다. 금지 방향(AD-1), 부작용 없음(AD-3), 원문 불변(AD-11), 재시도 단일 주체(AD-7), 절대 시각(AD-13) 같은 결정은 실제로 여러 쌍을 미리 죽여 놓았다. 아래는 **그 그물에 남아 있는 구멍만** 모은 것이다.

## Overall verdict

AD-1~AD-19는 **의존 방향과 "누가 무엇을 모르는가"는 거의 완벽하게 묶었지만, "누가 무엇을 쓰는가"는 거의 묶지 않았다.** spine은 패키지 경계(AD-1, AD-2), 부작용(AD-3), 제품 중립(AD-4), 원문 불변(AD-11) 같은 **정적 구조**에는 강제력이 있는 규칙을 두었다. 반면 slice 1의 실제 실행 모양 — 데몬 없이 짧게 뜨는 프로세스 다섯 종류(SessionStart 동기 / SessionStart async drain / 턴마다 Stop ingest / 에이전트의 log·recall / SessionEnd)가 **같은 행을 동시에 만지는 것** — 에 대해서는 AD-7의 `FOR UPDATE SKIP LOCKED` 한 줄과 AD-8의 멱등 키 두 개가 전부다. 그 둘이 커버하는 것은 drain 내부와 `sessions`·`messages`뿐이고, 나머지(세션 행의 생성자, 커서, `seq`, `message_seq`, `rule_state`, `tool_notes`, `chunks`, spool 파일, 미러 파일, hook 등록·출력)는 **주인이 없다.**

구멍 42개를 찾았다(critical 7, high 16, medium 12, low 7). 공통 원인은 하나다 — **spine은 공유 데이터의 *이름*은 정했지만 *모양과 단위와 단일 작성자*는 정하지 않았다.** `IngestBatch`는 "세션 추적 정보 + 메시지 + 도구 메모"로만 적혀 있고, "커서"는 "마지막 Harness 메시지 ID"로만 적혀 있고, "글자 단위로 대조"의 글자는 UTF-16 코드 유닛인지 코드 포인트인지 바이트인지 적혀 있지 않고, 꼬리표의 근거인 "정규화한 git remote URL"에는 정규화 규칙이 없다. 이 네 문장 각각에서, 두 구현자가 성실하게 AD를 읽고도 서로 못 읽는 데이터를 만든다.

더 무거운 것은 **원문 불변과 멱등이 구멍을 영구화한다**는 점이다. AD-11의 trigger는 `messages`·`tool_notes`의 UPDATE·DELETE를 거부하고, AD-8의 멱등 키는 재수집을 no-op으로 만든다. 그래서 위 구멍들이 만든 중복·오염·잘못된 join은 **고칠 경로가 없다.** 보통의 아키텍처 검토라면 "나중에 마이그레이션으로 고친다"가 답이지만, 이 spine에서는 그 답이 AD-11에 막혀 있다. 따라서 critical 7건은 *구현 전에* 닫아야 하는 것이고, 티켓으로 미룰 수 있는 것이 아니다.

가장 위험한 단일 구멍은 C6+C7이다. hook 경로의 양 끝(등록 형식과 출력 스키마)이 주인 없이 남아 있어서, **"설치는 성공했는데 아무것도 수집되지 않고 아무 기록도 남지 않는다"**가 가능하다. NFR-2(조용한 실패 금지)의 정의 그대로의 실패인데, 이 실패만은 Brain 안의 어떤 장치도 보지 못한다 — spool에도, 실패 기록에도, doctor에도 흔적이 없다. 반대 방향으로는 같은 구멍이 **hook이 두 번 등록되어 턴마다 ingest가 두 개 뜨는** 경로를 열어 두고, 그것이 C2·C3의 중복을 실제로 발생시키는 방아쇠가 된다.

고칠 양은 많지 않다. 신규 AD 다섯 개(AD-20~AD-24)와 기존 AD 아홉 개의 한두 줄 보강이면 critical·high 23건이 전부 닫힌다. 대부분은 "이 데이터의 작성자는 하나다"와 "단위는 이것이다"를 적는 일이다.

---

## Critical

### C-1. 세션 행의 생성자가 넷이고, 프로세스 경계를 넘는 세션 식별 토큰이 정의되지 않았다

**쌍:** (a) `log.append` — hook 없는 Harness, 또는 hook이 아직 안 돈 상태에서 에이전트가 `brain log`를 먼저 부른다. addendum §5의 권장대로 "처음 보는 세션이면 빈 세션을 먼저 만든다". vs (b) `sessions.ingest` — claude-code parser가 transcript에서 읽은 추적 정보로 세션 행을 만든다. 여기에 (c) SessionStart 동기 경로("세션 행 확보", AD-6)와 (d) drain의 "Harness·폴더·시각으로 연결"(AD-4 표)이 더해져 **같은 실제 세션 하나에 대해 행을 만들 수 있는 주체가 넷**이다.

**둘 다 합법인 근거:** AD-6은 SessionStart가 "세션 행 확보"를 한다고만 말하고 그것이 *유일한* 생성자라고 말하지 않는다. AD-8은 멱등 키 `(harness, harness_session_id)`만 정하고 **키를 모를 때 행을 만들어도 되는지는 말하지 않는다.** AD-4의 대체 경로 표는 세션 식별이 실패할 수 있음을 명시적으로 허용한다("없으면 drain이 Harness·폴더·시각으로 연결").

**부딪히는 것:** (a)가 `harness_session_id`를 모르는 상태(env 없음, `--session` 없음)에서 행을 만들면, 그 행의 멱등 키는 비어 있다. 나중에 (b)가 같은 세션을 제대로 된 키로 만든다 → **같은 세션이 두 행.** (a)에 붙은 작업 로그는 영원히 메시지가 없는 세션에 매달려 있고, AD-14의 join은 "대조할 메시지가 없음"으로 조용히 성공한다. FR-8("한 줄에서 그 줄이 나온 대화로 간다")이 깨지는데 어떤 경고도 발생하지 않는다 — NFR-2를 우회하는 실패다. 더 나쁜 것은 두 행을 합칠 경로가 없다는 점이다. `messages`는 불변이므로 session_id를 옮길 수 없고(AD-11), 로그를 옮기는 것은 AD-11의 "수정은 SDK 함수 하나"에 정의되어 있지 않다.

**두 번째 층:** AD-6은 env로 `BRAIN_SESSION`을 심는다고 적었지만 **그 값이 무엇인지 적지 않았다.** Brain의 UUIDv7인가, Harness의 세션 ID인가, 둘의 쌍인가. AD-4의 대체 경로는 "시작 맥락 문장의 세션 키"라는 세 번째 이름을 쓴다. CLI가 `--session`을 Harness ID로 해석하는 구현과 Brain UUID로 해석하는 구현은 둘 다 AD-5("인자 해석 외의 로직 없음")·AD-8을 지키면서 서로 다른 네임스페이스를 쓴다. 전자는 멱등 키를 타고 올바른 행에 붙고, 후자는 AD-8의 멱등 키를 **완전히 우회**한다.

**최소 규칙 — 신규 AD-20 (세션 행의 단일 소유자와 식별 토큰):**
> - 세션 행을 **만드는** 주체는 `sessions.ensure((harness, harness_session_id), trace)` 하나다. SDK 안에 함수 하나로 두고, SessionStart·ingest·log.append·drain은 모두 이것을 부른다.
> - `harness_session_id`를 모르는 호출은 세션 행을 만들지 않는다. `log.append`가 세션을 식별할 수 없으면 세션 없는 로그로 **spool에 쌓고**(AD-9) 즉시 "세션 미확정으로 보관됨" 경고를 돌려준다. drain이 나중에 Harness·폴더·시각으로 **연결만** 한다 — 연결은 기존 행에 붙이는 것이고, 새 행을 만드는 일이 아니다.
> - 프로세스 경계를 넘는 세션 식별 토큰은 `(harness, harness_session_id)` 쌍 하나다. `BRAIN_SESSION`의 값은 `"<harness>:<harness_session_id>"`이고, `--session`도 같은 문법을 받는다. **Brain의 UUIDv7은 프로세스 경계를 넘지 않는다.**

---

### C-2. 멱등 키가 `sessions`·`messages`에만 있다 — `tool_notes`·`chunks`·`embeddings`의 중복은 불변 trigger 때문에 영구적이다

**쌍:** (a) 커서 배타(exclusive) parser — 커서 메시지 다음 줄부터 돌려준다. vs (b) 커서 포괄(inclusive) parser — 마지막 메시지가 그 사이 수정·보강되었을 수 있으니(Claude Code jsonl은 같은 uuid의 줄이 갱신되기도 한다) 커서 메시지를 포함해 한 건 겹쳐 돌려준다.

**둘 다 합법인 근거:** AD-4는 "세션별 커서(마지막 Harness 메시지 ID) **이후만** 돌려준다"와 "parser는 멱등이다"만 말한다. (b)는 "멱등"을 근거로 겹침을 택한다 — 겹쳐도 멱등 키가 받아 준다고 믿는 것이고, `messages`에 대해서는 그 믿음이 맞다.

**부딪히는 것:** AD-8의 멱등 키는 `messages` `(session_id, harness_message_id)`뿐이다. 같은 배치의 `tool_notes`에는 키가 없다(addendum의 스케치도 `id, session_id, message_id?, seq, tool, target, ok, occurred_at`). → (b) parser로 한 건 겹칠 때마다 **도구 메모가 복제된다.** 그리고 AD-11의 trigger가 `tool_notes`의 DELETE를 거부하므로 **그 중복은 영구적이고 삭제 불가**다. FR-2("도구 메모 한 건은 한 줄")와 UJ-3("어떤 파일을 다뤘나")이 n배로 부풀고, 복구 경로가 없다. 같은 논리가 `chunks`(멱등 키 없음 → 중복 조각 → 검색 결과 중복 + SM-C2 8,000자 상한 침식 + 임베딩 비용 중복)와 `embeddings`(같은 target에 같은 config로 두 벡터)에도 적용된다.

**최소 규칙 — AD-8 보강:**
> 멱등 키는 **모든 파생 레코드**에 둔다. 세션 `(harness, harness_session_id)`, 메시지 `(session_id, harness_message_id)`, 도구 메모 `(session_id, harness_message_id, tool_call_id)`(Harness가 도구 호출 ID를 주지 않으면 `(session_id, harness_message_id, ordinal)`), 조각 `(session_id, index_config_id, message_seq_from)`, 임베딩 `(target_kind, target_id, index_config_id)`, 실패 기록 `(harness, harness_session_id, stage, occurred_at)`. 키 없는 테이블에 쓰는 경로를 만들지 않는다 — DB UNIQUE 제약으로 지키고, 포트 계약 테스트에 "같은 배치 두 번 적용 후 모든 테이블의 건수가 같다"를 넣는다.

---

### C-3. 같은 세션에 대한 ingest가 직렬화되지 않는다 — AD-7의 SKIP LOCKED는 drain만 덮는다

**쌍:** (a) 턴마다 뜨는 Stop hook의 live ingest(AD-6). vs (b) drain의 transcript 폴더 스캔(AD-7). 또는 (a) vs (a') — 긴 턴이 겹치면 같은 세션의 Stop hook 두 개가 동시에 산다(Claude Code의 async hook은 완료를 기다리지 않는다). 또는 (a) vs (c) — 에이전트가 `brain log`를 부를 때 일어나는 "그 세션 먼저 증분 수집"(AD-6).

**둘 다 합법인 근거:** AD-7의 잠금 규칙은 문장 그대로 **"모든 백그라운드 작업"**과 **"일감은 Postgres 행 잠금으로 나눠 가진다"**인데, AD-7이 정의하는 범위는 "밀린 일 … SDK의 `drain()` 하나가 처리한다"다. live ingest는 밀린 일이 아니고 drain도 아니므로 일감 행을 claim하지 않는다. 즉 **live ingest는 설계상 어떤 잠금도 들지 않는다.** AD-6은 Stop을 "턴마다, async"로 두고 겹침을 금지하지 않는다.

**부딪히는 것:** 두 프로세스가 같은 커서를 읽고 같은 꼬리를 파싱해 둘 다 INSERT 한다. `messages`는 멱등 키가 받아 주지만 — (1) `messages`에 `(session_id, seq)` UNIQUE가 있으면 둘 중 하나가 제약 위반으로 트랜잭션 전체를 롤백한다. hook 경로는 exit 0으로 끝내라고 되어 있으므로(Conventions) **그 턴의 수집이 조용히 사라지고**, 다음 턴의 커서는 이미 앞서 있어 복구되지 않는다(SM-5 ≠ 0). (2) `seq` UNIQUE가 없으면 같은 `seq`를 가진 메시지 두 개가 생기고 `chunks`의 `message_seq_from/to` 범위가 두 가지로 해석된다. (3) C-2와 합치면 `tool_notes`·`chunks` 중복이 실제로 발생한다. 그리고 C-7(hook 이중 등록)이 이 동시성을 *정상 상태*로 만든다.

**최소 규칙 — AD-7 보강:**
> 세션 하나의 수집은 동시에 하나만 돈다. 모든 ingest 경로(live Stop, SessionEnd, `log`·`recall` 직전 증분, drain의 폴더 스캔)는 그 세션의 `sessions` 행 `FOR UPDATE`(또는 `pg_advisory_xact_lock(harness, harness_session_id)`)를 먼저 잡고, **커서 전진과 배치 삽입을 한 트랜잭션에 넣는다.** 잠금을 못 잡으면 실패가 아니라 no-op이고(다른 프로세스가 같은 일을 하고 있음), hook 경로는 그대로 exit 0으로 끝낸다. 커서는 위치 기준으로 **전진만** 한다.

---

### C-4. `rule_state`에 "아직 대조 안 됨" 상태가 없고 작성자가 셋이다 — drain이 내가 끈 규칙을 되살린다

**쌍:** (a) 낙관적 `log.append` — 규칙을 `rule_state='on'`으로 적고, 대조 실패 시 drain이 끈다. vs (b) 보수적 `log.append` — 대조되기 전에는 `'off'`로 적고, drain이 대조 성공 시 켠다.

**둘 다 합법인 근거:** AD-14는 "대조되면 켠다. 대조에 실패하면 `brain log`가 즉시 알리고, 끝내 실패한 규칙은 켜지 않은 채 점검에 올린다"고만 말한다. (b)는 "켜지 않은 채"를 글자대로 지킨다. (a)는 "대조에 실패하면"을 사후 판정으로 읽는다 — 수집 전에 적힌 규칙은 아직 실패하지 않았으므로 켜 둔다. addendum의 `rule_state (on | off)`는 상태가 둘뿐이어서 (b)의 "미대조"와 사용자가 FR-22로 끈 것이 **구분되지 않는다.**

**부딪히는 것:** (a)에서는 미대조 규칙이 최소 한 세션 동안 시작 맥락에 들어간다 → FR-19("인용이 대조되지 않으면 그 규칙은 켜지지 않는다") 위반. (b)에서는 사용자가 규칙 목록(FR-22)에서 off를 보고도 그것이 "내가 끈 것"인지 "아직 대조 안 된 것"인지 알 수 없다. 그리고 두 구현 공통으로 더 나쁜 레이스가 있다: 사용자가 T1에 규칙을 끈다 → T0에 일감을 claim해 둔 drain이 T2에 대조 성공으로 `'on'`을 쓴다 → **내가 끈 규칙이 조용히 되살아나 매 세션 주입된다.** AD-7의 "멱등"은 재실행 가능성만 보장하고 **덧쓰기 안전성을 보장하지 않는다.** AD-11은 로그의 "현재 문장"의 변경 경로만 정하고 `rule_state`는 정하지 않았으므로, drain이 `rule_state`를 직접 UPDATE 하는 것은 완전히 합법이다.

**최소 규칙 — AD-14 보강:**
> `rule_state`는 `pending | on | off` 세 상태다. `log.append`는 항상 `pending`으로 적고, **`pending`인 규칙은 시작 맥락에 들어가지 않는다.** 상태 전이는 두 개뿐이다: 대조 성공 시 `pending → on`(작성자: 대조를 수행한 쪽 — `log.append` 또는 drain), 사용자 조작 시 `on|pending → off`(작성자: SDK의 사용자 조작 함수 하나). **대조는 `pending` 행만 claim하고 `off`를 절대 덧쓰지 않는다**(`UPDATE … WHERE rule_state='pending'`). 끝내 대조 실패한 행은 `pending`으로 남아 doctor에 집계된다.

---

### C-5. "글자 단위로 대조"의 단위가 없다 — UTF-16 / 코드 포인트 / 바이트 + NFC/NFD

**쌍:** (a) claude-code parser(TypeScript) — 에이전트가 고른 문장을 `body.indexOf(quote)`로 찾아 `quote_start/quote_end`를 적는다. JS 문자열은 **UTF-16 코드 유닛**이다. vs (b) postgres adapter의 대조 — `substring(body from quote_start+1 for len)`으로 검증한다. Postgres `substring`은 **코드 포인트(문자)** 단위다. 세 번째 구현자가 `Buffer.indexOf`를 쓰면 **바이트**다.

**둘 다 합법인 근거:** AD-14는 "글자 단위로 대조한다"고만 쓴다. AD-11은 "작업 로그의 '현재 문장' 위치가 단위마다 달라지는 것"을 막겠다고 **선언**하지만, 규칙 본문은 `log_entry_edits`만 정하고 **단위를 정하지 않는다.** Conventions에도 텍스트 좌표에 관한 줄이 없다.

**부딪히는 것:** BMP 안의 한글·영문에서는 (a)와 (b)가 일치하므로 **테스트는 통과한다.** 이모지·보조 평면 문자가 인용 앞에 하나라도 있으면 오프셋이 어긋나 대조가 실패한다 → 그 규칙만 영구히 켜지지 않고, 원인은 doctor에 "대조 실패"로만 보인다. 바이트 구현이 섞이면 한글 한 글자당 3씩 어긋나 **거의 모든 한국어 규칙이 실패한다.**

**두 번째 층 — 정규화:** macOS는 경로·클립보드 경유 한글을 **NFD**로 주는 일이 흔하고, Harness의 transcript는 사용자가 입력한 그대로(NFC일 수도 NFD일 수도)를 담는다. 에이전트가 문장을 다시 타이핑/복사해 `brain log`에 넘기면 정규화 형태가 원문과 다를 수 있다. AD-14의 "글자 단위로 같다"는 이 경우 실패하고, FR-19의 전제("에이전트는 구간만 고른다")가 무너진다 — 그런데 AD-4의 대체 경로(수집 전 기록)에서는 **에이전트가 문장을 넘기는 것이 정상 경로**다.

**최소 규칙 — 신규 AD-21 (텍스트 좌표와 정규화):**
> Brain 안의 모든 텍스트 오프셋(규칙 인용 `quote_start/quote_end`, 조각 경계, 미래의 하이라이트)은 **NFC로 정규화한 본문 위의 Unicode 코드 포인트 반열린 구간 `[start, end)`** 이다. 저장 직전 모든 본문을 NFC로 정규화한다(NFC 정규화는 원문 보존의 예외로 AD-11에 명시하고, 원본 바이트 해시를 함께 기록한다). 대조는 양쪽을 NFC로 정규화한 뒤 수행하고, 오프셋이 주어지지 않은 인용은 NFC 본문에서 **유일한** 부분 문자열일 때만 성공으로 본다(0건 또는 2건 이상이면 `pending` 유지). 포트 계약 테스트에 이모지·NFD 한글 fixture를 넣는다.

---

### C-6. hook 경로의 출력 스키마가 주인 없다 — 시작 맥락이 조용히 주입되지 않을 수 있고, 아무도 그것을 모른다

**쌍:** (a) Conventions를 따르는 `brain context` — "`--json` 응답은 `{ ok, data, warnings[], error? }`"를 글자대로 지켜 그 봉투를 stdout에 쓴다. vs (b) Claude Code hook 계약을 따르는 `brain context` — `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`를 쓴다.

**둘 다 합법인 근거:** AD-5는 "출력은 `--json`(에이전트용)과 텍스트(사람용) 두 가지"라고 **단정**한다 — 세 번째 출력 모양을 허용하지 않는다. AD-6은 `brain context`가 "additionalContext (+ env)"를 돌려준다고 그림으로만 말한다. AD-4는 hook을 connector의 선택 요소로 두면서 hook의 출력 형식이 누구 소유인지 말하지 않는다. (a)는 Conventions를 지키고, (b)는 AD-6의 시퀀스 그림을 지킨다.

**부딪히는 것:** (a)면 Claude Code는 모르는 스키마를 받고 **아무것도 주입하지 않는다.** `brain context`는 exit 0, `ok:true`로 끝나므로 Brain 쪽에는 실패가 없다 — spool에도, 실패 기록에도, doctor에도 흔적이 없다. 사용자는 "설치는 됐는데 Brain이 내 규칙을 모른다"를 디버깅할 단서를 하나도 받지 못한다. FR-17의 "Brain이 응답하지 않으면 … 그 사실이 기록된다"는 **응답한 경우**를 다루지 않는다. 이것은 NFR-2의 정의 그대로의 조용한 실패이며, spine의 어떤 장치도 보지 못하는 유일한 종류다.

**부수적으로:** `CLAUDE_ENV_FILE`에 env를 심는 것도 Claude Code 고유 동작인데, AD-19/AD-5는 hook 진입점을 `apps/cli`에 두고 "Harness 중립 명령만 호출"하게 한다(memlog). 그러면 CLI가 harness 이름으로 분기하게 되고(합법이지만 AD-4의 정신에 반함), 두 번째 Harness에서 포트 시그니처가 바뀐다 — AD-4가 막으려던 바로 그 일이다.

**최소 규칙 — 신규 AD-22 (Harness 경계 계약):**
> hook 경로의 입출력 형식은 **connector adapter가 소유한다**. Core는 중립 결과를 돌려주고, adapter가 `renderHookOutput(event, result)`과 `exportSessionEnv(sideChannel, token)`으로 Harness 형식으로 바꾼다. CLI는 `--harness <name>`으로 adapter를 고르고 그 출력을 그대로 내보낸다(AD-5의 "두 가지 출력"에 "hook 출력(connector 소유)"을 세 번째로 명시한다). `brain context`는 **주입 시도 한 건을 DB(없으면 spool)에 기록한다** — 세션, 시각, 바이트 수, 규칙 수. doctor는 "세션 수 vs 주입 시도 수"와 "마지막 주입 시각"을 보여 준다. 주입 성공은 관측할 수 없으므로 **시도 기록이 없는 세션의 존재**로 대신 드러낸다.

---

### C-7. Harness 설정 파일의 작성자가 셋이고, 등록된 절대 경로의 생존을 아무도 확인하지 않는다

**쌍:** (a) 설치기(AD-19) — 감지된 Harness에 hook을 등록한다. vs (b) `brain setup`(AD-19, "같은 흐름을 멱등으로") vs (c) Structural Seed의 `packages/claude-code`의 "hook 설정 쓰기(connect)" / memlog의 `brain connect <harness>`. spine 본문에 `connect`는 없고 Structural Seed에만 있다.

**둘 다 합법인 근거:** AD-19는 "재설정은 `brain setup`이다. 같은 흐름을 **멱등으로** 돌린다"고 말하지만, **멱등의 기준(무엇이 같으면 같은 hook인가)을 정하지 않았다.** 설정 JSON의 hook 항목을 "command 문자열 완전 일치"로 비교하는 구현과 "`$id` 같은 표식"으로 비교하는 구현이 둘 다 합법이다.

**부딪히는 것:** 경로가 한 글자라도 달라지면(전역 설치 위치가 Node 버전 전환으로 바뀜, 따옴표/공백 차이, `~` vs 절대 경로) 두 번째 등록이 **추가**된다 → 턴마다 Stop hook이 둘 → C-2·C-3의 중복·롤백이 정상 상태가 된다. 반대 방향이 더 치명적이다: AD-19는 "전역 설치된 `brain` 실행 파일의 **절대 경로**"를 못 박았는데, nvm/volta/pnpm 전역 경로는 **Node 버전을 올리면 죽는다.** 그 순간 hook은 존재하지 않는 파일을 부르고 — Brain 프로세스가 아예 뜨지 않으므로 — spool도 실패 기록도 doctor도 전부 비어 있다. 수집이 완전히 멈춘 상태가 "모두 정상"으로 보인다.

**최소 규칙 — AD-19 보강:**
> - Harness 설정 파일을 쓰는 주체는 하나다(connector adapter의 `connect`). 설치기와 `brain setup`은 그것을 부른다.
> - 등록 항목에는 Brain 소유 표식(`"_brain": {"version": …, "id": "brain-<event>"}`)을 넣고, 멱등 판정은 **표식으로만** 한다 — command 문자열 비교를 하지 않는다. 같은 표식의 항목이 둘 이상이면 하나로 줄인다.
> - `brain doctor`는 Harness별로 (1) 등록된 hook 항목과 표식, (2) **등록된 절대 경로의 실존과 실행 가능 여부**, (3) 그 Harness의 마지막 hook 수신 시각(C-6의 시도 기록 + 마지막 ingest 시각)을 보여 주고, 경로가 죽었거나 N일 이상 수신이 없으면 실패로 표시한다.
> - 설치기는 설치·갱신 때마다 경로를 다시 써서 교정한다(upgrade 시 재등록).

---

## High

### H-1. 메시지 `seq`의 소유자와 안정성이 정의되지 않았다

**쌍:** (a) parser가 `seq`를 매긴다(transcript 줄 순서 기준). vs (b) postgres adapter가 삽입 시 `coalesce(max(seq),0)+1`로 매긴다.

**둘 다 합법:** AD-8은 ID(UUIDv7)만 정하고 `seq`를 말하지 않는다. AD-4는 parser가 "커서 이후"를 돌려준다고만 한다. addendum 스케치에 `messages.seq`가 있을 뿐이다.

**부딪히는 것:** (b)는 두 프로세스가 겹칠 때(C-3) 충돌·중복하고, 재수집 순서에 따라 `seq`가 transcript 순서와 달라진다. (a)는 **parser가 무엇을 메시지로 세는가에 `seq`가 종속된다** — Claude Code jsonl의 sidechain(Task 서브에이전트) 줄, thinking 블록, meta 줄을 세는지 여부에 따라 같은 transcript가 다른 `seq`를 낳는다. `chunks.message_seq_from/to`와 `log_entries.message_seq`가 `seq`를 참조하므로, parser 기준이 바뀌면 **FR-16의 출처가 조용히 다른 곳을 가리킨다.** FR-11("색인을 다시 만들어도 출처는 변하지 않는다")이 깨진다.

**최소 규칙 — AD-4 보강:** `seq`는 parser가 매기고, **(transcript 바이트 내용, parser 버전)의 순수 함수**다. `messages`에 `(session_id, seq)` UNIQUE를 걸고, DB는 `seq`를 생성하지 않는다. parser는 세는 대상(무엇이 메시지이고 무엇이 도구 메모이고 무엇이 버리는 줄인가)을 포트 계약 테스트의 골든 fixture로 고정한다.

### H-2. 커서의 의미와 "커서를 못 찾았을 때"가 정의되지 않았다

**쌍:** (a) 커서를 **ID**로 보고 transcript에서 그 uuid를 찾아 다음 줄부터 읽는 parser. vs (b) 커서를 **위치**로 보고 파일 오프셋/줄 번호를 저장하는 parser.

**둘 다 합법:** AD-4는 커서를 "마지막 Harness 메시지 ID"로 정하면서 **저장 주체(core / sessions 행 / parser 쪽 파일)와 부재 시 동작을 말하지 않는다.** Claude Code의 메시지 uuid는 랜덤이라 순서 비교가 불가능하므로 (a)는 반드시 파일 스캔이 필요하다.

**부딪히는 것:** compact·fork·`/clear`·로그 회전으로 transcript가 재작성되면 커서 uuid가 파일에 없다. (a)는 두 선택밖에 없다 — 전부 돌려주거나(중복 폭주, C-2와 결합) 아무것도 안 돌려주거나(영구 누락, SM-5 ≠ 0). 어느 쪽도 AD를 위반하지 않는다. (b)는 파일이 짧아졌을 때 오프셋이 파일 끝을 넘어가며 같은 문제를 다르게 겪는다. 커서 전진이 배치 삽입과 **다른 트랜잭션**이면 크래시 시 영구 공백이 생긴다.

**최소 규칙 — AD-4 보강:** 커서는 `(harness_message_id, position, transcript_bytes_len, transcript_fingerprint)`를 함께 저장하고 `sessions` 행에 둔다(저장 주체는 postgres adapter 하나). **커서 전진은 배치 삽입과 같은 트랜잭션에서만 한다**(C-3). fingerprint가 다르거나 커서 ID를 찾지 못하면 parser는 **처음부터 다시 읽고 멱등 키에 의존한다**(중복은 C-2의 키가 흡수) + "transcript 재작성 감지" 경고를 실패 기록에 남긴다. 조용한 누락은 금지한다.

### H-3. 작업 로그의 시각을 누가 찍는지, spool 재주입이 다시 찍는지가 정의되지 않았다

**쌍:** (a) `log.append` 호출 시점에 CLI가 시각을 찍어 spool에 함께 쓴다. vs (b) spool 항목에는 문장만 담고, drain이 DB에 넣을 때 `now()`로 찍는다.

**둘 다 합법:** AD-13은 "저장·입력·출력은 모두 `timestamptz` 절대 시각"만 말하고 **시각의 출처(클럭 소유자)를 말하지 않는다.** AD-9는 spool에 "작업 로그 원문"을 쌓는다고만 한다.

**부딪히는 것:** (b)면 DB가 꺼져 있던 동안 적힌 로그가 **DB가 살아난 시각으로 기록된다** → FR-12의 시간 조회가 틀린 날짜를 답하고(SM-2), AD-14의 "그 시각 직전의 메시지" join이 전혀 다른 세션의 메시지를 고른다. AD-9가 지키려 한 것(transcript로 복구할 수 없는 유일한 쓰기)이 내용은 살아도 **좌표를 잃는다.**

**최소 규칙 — AD-13 보강:** 레코드의 `occurred_at`은 **그 사건이 일어난 프로세스가 한 번만** 찍는다. `log.append`는 호출 시점에 찍어 spool/DB 어디로 가든 그 값을 유지한다. DB `now()`나 drain의 시각으로 `occurred_at`을 채우는 경로를 만들지 않는다. 처리 시각이 필요하면 `recorded_at`을 따로 둔다. spool 항목은 `{schema_version, occurred_at, …}`을 반드시 포함한다.

### H-4. `message_seq`(로그↔대화 join)의 작성자가 둘이고, 재계산 규칙이 없다

**쌍:** (a) `log.append`가 쓰기 시점에 즉시 join 한다(AD-14, AD-6). vs (b) drain이 나중에 join 한다(AD-14, AD-7).

**둘 다 합법:** AD-14가 두 경로를 **명시적으로 둘 다 허용한다.** AD-11은 로그의 "현재 문장" 변경만 단일 함수로 묶고 `message_seq` 같은 파생 컬럼은 다루지 않는다.

**부딪히는 것:** (a)가 수집된 범위 끝(seq 20)으로 join 한 직후, 겹친 ingest가 그 로그 시각보다 **이른** `occurred_at`의 메시지를 seq 21로 넣는다(transcript는 이미 갖고 있었다). join은 이제 틀렸는데 `message_seq`가 NULL이 아니므로 drain은 그 행을 claim하지 않는다 — **영구히 잘못된 출처.** 반대로 drain이 "항상 재계산"으로 구현되면 (a)의 결과를 계속 덧쓰며 두 작성자가 경쟁한다. 그리고 AD-14의 "그 시각 직전의 메시지"는 `occurred_at <= log_time`의 마지막 메시지인지 `seq` 기준인지도 정해지지 않았다 — 에이전트가 턴 *중간*에 `brain log`를 부르므로(그 턴의 assistant 메시지는 아직 transcript에 없다) 두 해석이 다른 메시지를 고른다.

**최소 규칙 — AD-14 보강:** join은 `message_seq`와 함께 `joined_at`·`joined_upto_seq`(join 당시 수집 완료 지점)를 기록한다. join 규칙은 **"`occurred_at <= log.occurred_at`인 메시지 중 `seq` 최대"** 하나로 고정한다. 작성자는 "`message_seq IS NULL`인 행"과 **"`joined_upto_seq`보다 큰 `seq`에 더 이른 `occurred_at`의 메시지가 들어온 행"**을 claim하는 단일 drain 작업 하나다. `log.append`는 join을 하지 않고 시각만 적는다(즉시성이 필요하면 읽을 때 계산해 보여 주되 저장하지 않는다).

### H-5. "정규화한 git remote URL"에 정규화 규칙이 없고, 꼬리표 계산자가 둘이다

**쌍:** (a) SessionStart 경로 — cwd에서 `git remote get-url origin`을 읽어 프로젝트 정체성을 만든다. vs (b) drain의 transcript 폴더 스캔 — cwd가 없고 jsonl의 `cwd` 값은 이미 지워졌을 수 있으므로 remote를 못 읽고 경로 기반으로 떨어진다.

**둘 다 합법:** AD-12는 "정규화한 git remote URL이 우선이고, remote가 없을 때만 로컬 git 공통 디렉터리"라고만 쓴다. **정규화 알고리즘이 없다** — `git@github.com:acme/api.git` / `https://github.com/acme/api` / `ssh://git@github.com:22/acme/API.git`는 같은 저장소다. 대소문자, `.git` 접미사, 포트, 사용자, 복수 remote 중 무엇을 고를지가 모두 열려 있다.

**부딪히는 것:** AD-12가 막겠다고 선언한 것("사람·기계마다 같은 레포가 다른 프로젝트로 갈라지는 것")이 **AD-12를 지키면서 그대로 일어난다.** 두 구현자가 각각 정규화하면 같은 레포가 두 프로젝트로 갈라지고, (a)/(b)의 비대칭 때문에 같은 세션이 ingest 경로에 따라 다른 꼬리표를 받는다. FR-13의 근접성 순위(워크트리 → 프로젝트 → 워크스페이스)와 FR-17의 "현재 프로젝트 규칙"이 경로에 따라 달라진다.

**최소 규칙 — AD-12 보강:** 정규화는 core의 함수 하나다: 스킴·사용자·포트 제거 → 호스트 소문자 → 경로 소문자 → 선행 `/`·후행 `.git`·후행 `/` 제거 → `host/path` 문자열. remote 선택은 `origin` → 알파벳 첫 remote 순이다. 꼬리표를 계산하는 주체도 하나다 — **세션 행을 처음 만드는 쪽만** 꼬리표를 쓰고(AD-20), 나중 경로는 꼬리표가 비어 있을 때만 채운다. 정체성 계산은 포트 계약 테스트의 fixture 표로 고정한다.

### H-6. `sessions`의 컬럼별 쓰기 정책이 없다 — 유일하게 불변 보호가 없는 테이블에 작성자가 넷이다

**쌍:** (a) 배치마다 추적 정보를 UPSERT 하는 ingest(브랜치가 턴 중 바뀌면 최신으로). vs (b) `ON CONFLICT DO NOTHING`인 ingest(첫 쓰기가 이김).

**둘 다 합법:** AD-11의 trigger는 `messages`·`tool_notes`만 보호한다. AD-8은 멱등 키만 정하고 **충돌 시 무엇을 하는지 말하지 않는다.**

**부딪히는 것:** `git_branch`·`first_prompt`·`ended_at`·`ingest_status`·꼬리표가 경로마다 다른 값으로 수렴한다. SessionStart가 만든 행에는 `first_prompt`가 없는데 누가 채우는지 정해지지 않았고(FR-9가 그것으로 세션을 보여 준다), SessionEnd async가 돌지 못하면 `ended_at`이 영구 NULL이다. drain이 "연결"할 때 꼬리표를 덧쓰면 H-5의 비대칭이 기존 값을 망친다.

**최소 규칙 — AD-11 보강:** `sessions`의 컬럼을 셋으로 나눠 명시한다 — **불변**(`id`, `harness`, `harness_session_id`, `started_at`, `ingest_source`, 꼬리표·`machine`·`user`: 생성 시 한 번, 이후 trigger가 UPDATE 거부, 사용자의 명시적 재태깅 함수만 예외), **단조**(`cursor`, `last_ingested_at`, `ended_at`: 전진만), **갱신 가능**(`ingest_status`, `metadata`). `first_prompt`의 작성자는 ingest 하나로 못 박고 "이미 있으면 쓰지 않는다".

### H-7. 미러: 증분 작성자와 `--rebuild`가 같은 파일을 쓴다 — AD-16의 단일 작성자 선언이 자기 모순이다

**쌍:** (a) 턴마다 그 세션의 미러 파일을 갱신하는 ingest(AD-16: "그 세션의 수집만 그 파일을 쓴다"). vs (b) `brain mirror --rebuild`(AD-16: "원본에서 언제든 다시 만든다").

**둘 다 합법:** AD-16이 두 문장을 나란히 적었다. rebuild는 "그 세션의 수집"이 아니므로 첫 문장의 단일 작성자 규칙과 **문자 그대로 충돌한다.**

**부딪히는 것:** rebuild 중 Stop hook이 같은 파일을 쓰면 섞이거나 잘린다(동기화 폴더면 더 나쁘다 — 충돌 사본이 생기고 에이전트가 그것을 grep 한다). 파일 **이름 규칙도 내용 규칙도 없다** → 두 구현이 다른 이름을 쓰면 rebuild가 두 번째 집합을 만들고 옛 파일은 영구히 남는다(삭제 규칙 없음). 미러에 작업 로그가 들어가는지, 수정된 로그가 반영되는지도 미정이라 증분 결과와 rebuild 결과가 다르다 — "원본에서 언제든 다시 만들 수 있다"가 거짓이 된다. 미러 쓰기 실패(동기화 폴더 잠김, 권한)는 AD-9의 spool 대상이 아니므로 **드러나는 경로가 없다**(NFR-2).

**최소 규칙 — AD-16 보강:** 미러 파일은 `<mirror>/<yyyy>/<harness>-<harness_session_id>.md` 하나이고, 내용은 `(sessions 행, messages, tool_notes, log_entries, mirror_schema_version)`의 **순수 함수**다. 쓰기는 항상 **전체 파일을 tmp에 쓰고 rename**(부분 append 금지)이며, 증분 경로와 rebuild 경로는 같은 함수와 같은 세션 잠금(C-3)을 쓴다. rebuild는 현재 세션 집합에 없는 Brain 소유 미러 파일을 보고하고(지우지는 않는다), 미러 쓰기 실패는 실패 기록에 남겨 doctor에 보인다.

### H-8. spool 파일 규율이 없다 — 동시 append 섞임과 "삭제 vs 그 순간의 append"로 로그가 사라진다

**쌍:** (a) `~/.second_brain/spool/log.jsonl` 하나에 모두 append 하는 writer. vs (b) drain — "재주입하고 **파일을 지운다**"(AD-9).

**둘 다 합법:** AD-9는 경로를 `spool/*.jsonl`(append-only)로 두고 drain이 재주입 후 지운다고만 쓴다. 파일 분할 규칙, 작성 중 파일 보호, 스키마 버전이 전부 없다.

**부딪히는 것:** (1) 두 단명 프로세스가 같은 파일에 append 할 때, 한 줄이 PIPE_BUF(4KB)를 넘으면(로그 `text` + `reason`은 넘을 수 있다) **줄이 섞여 깨진다** — 깨진 줄은 재주입 불가이고 그 로그는 사라진다. (2) drain이 재주입 후 `unlink` 하는 바로 그 순간 다른 프로세스가 열어 둔 핸들로 append 하면, 그 쓰기는 **지워진 inode로 들어가 조용히 사라진다.** AD-9가 막으려 한 유일한 비복구 쓰기가 AD-9의 삭제 규칙 때문에 사라진다. (3) 버전이 다른 brain이 쓴 spool을 읽는 규칙이 없다.

**최소 규칙 — AD-9 보강:** spool 파일은 **쓰는 프로세스마다 새 파일**이다(`spool/<kind>-<utc-ts>-<pid>-<uuid7>.jsonl`), 한 프로세스가 끝나면 그 파일에 더 쓰지 않는다. drain은 파일을 먼저 `*.claiming`으로 **rename** 한 뒤 읽고, 재주입 성공 후에만 지운다(rename 실패 = 다른 drain이 가져감 = no-op). 모든 줄은 `{schema_version, kind, occurred_at, payload}`이고, 파싱 불가한 줄은 버리지 않고 `spool/quarantine/`으로 옮겨 doctor에 건수를 보인다.

### H-9. 설정 파일 스키마의 주인과 버전이 없다 (설치기 vs 런타임 로더)

**쌍:** (a) 설치기가 쓰는 `config.toml`. vs (b) 런타임의 설정 로더(AD-18: "둘 다 Runtime의 설정 로더 하나만 읽는다").

**둘 다 합법:** AD-18은 **위치**만 정하고 스키마·버전·미지의 키 처리·기본값 출처를 정하지 않는다. 두 단위가 같은 패키지에 있더라도 시간 축으로 갈라진다 — 옛 설치기가 쓴 파일을 새 로더가 읽는 경우.

**부딪히는 것:** 키 이름/중첩이 어긋나면 로더는 기본값으로 조용히 떨어진다 → 미러 경로가 기본값으로 바뀌어 **두 번째 미러 집합**이 생기거나, 임베딩이 꺼진 줄 알았는데 켜져서 외부 전송이 일어난다(NFR-6). 설정 불일치는 AD-15가 "색인 설정"에 대해서만 경고하게 되어 있고, 설정 파일 전체에 대한 검증은 없다.

**최소 규칙 — AD-18 보강:** 설정 스키마는 한 곳(core의 타입 + 파서)에서 정의하고 `schema_version`을 파일 첫 키로 둔다. 설치기와 로더는 **같은 코덱**을 쓴다. 로더는 미지의 키·형식 오류를 **조용히 무시하지 않고** 실패 기록 + doctor 경고로 드러내며, 모르는 상위 버전은 로드를 거부하고 안내한다. `brain doctor`는 적용된 유효 설정값과 그 출처(파일/기본값/환경 변수)를 표로 보여 준다.

### H-10. 조각(chunk) 규칙이 spine에 없다 — 기본 구성(임베딩 꺼짐)에서 소분류 검색의 대상이 미정이다

**쌍:** (a) 임베딩이 켜져 있을 때만 조각을 만드는 indexer. vs (b) 항상 조각을 만들고 `pg_trgm`을 조각에 거는 indexer.

**둘 다 합법:** AD-15는 "기본 검색은 키워드(`pg_trgm`)"라고만 쓰고 **무엇에 거는지(messages.body / chunks.body / tool_notes.target)를 말하지 않는다.** 조각 크기·겹침(addendum §1의 1,200자·1메시지 겹침)은 **spine에 한 줄도 없다.**

**부딪히는 것:** (a)면 slice 1 기본 구성에서 FR-14(소분류 검색)가 **빈 결과를 `ok`로 돌려준다** — NFR-2가 금지한 바로 그것. 두 구현의 조각 경계가 다르면 FR-11의 재생성이 출처를 옮긴다(FR-16·H-1). 조각 파라미터가 `index_configs`에 묶이지 않으면 "어떤 설정으로 만들었는지 기록한다"(FR-11)가 임베딩 설정만 덮는다.

**최소 규칙 — AD-15 보강:** 조각은 **임베딩 여부와 무관하게 항상** 만든다. 조각 파라미터(목표 글자 수, 겹침, 메시지 경계 준수)는 `index_configs`에 들어가고, 임베딩이 꺼져 있어도 `index_configs` 행이 하나 존재한다. 조각 identity는 `(session_id, index_config_id, message_seq_from)`(C-2)이고, 키워드 검색 대상은 `chunks.body`(소분류)·`log_entries.text`(대분류)·`tool_notes.target`(도구 메모)로 명시한다. 어느 경로든 "대상이 비어 있음"과 "결과가 없음"을 구분해 경고한다.

### H-11. 실패 기록이 세션의 자식으로 모델링되어 있다 — 세션 행이 없을 때의 실패를 적을 곳이 없다

**쌍:** (a) ERD를 따르는 postgres adapter — `sessions ||--o{ failures`, 즉 `failures.session_id NOT NULL`. vs (b) addendum을 따르는 core의 실패 기록기 — `(harness, harness_session_id, stage, error)`로 적는다(세션 행 없음, transcript 파싱 실패·세션 식별 실패).

**둘 다 합법:** spine의 ERD는 `failures`를 세션의 자식으로 그렸고, Conventions는 "DB의 실패 기록 테이블"이라고만 쓴다.

**부딪히는 것:** 가장 알아야 할 실패(파싱 불가, 세션 식별 실패, 커서 분실 — H-2)가 **적힐 자리가 없다.** DB는 살아 있으므로 AD-9의 spool 대상도 아니다 → stderr로 끝난다. Conventions가 금지한 "stderr만으로 끝내지 않는다"가 구조적으로 불가능해진다. FR-5("수집이 실패한 세션은 목록으로 확인할 수 있다")와 FR-25의 점검 항목이 비어 돈다.

**최소 규칙 — ERD/Conventions 보강:** 실패 기록의 키는 `(harness, harness_session_id)`이고 `session_id`는 nullable이다(ERD에서 `failures`를 `sessions`의 자식이 아니라 "선택적으로 세션을 가리키는" 독립 테이블로 다시 그린다). 모든 실패 기록 경로는 세션 행의 존재를 전제하지 않는다.

### H-12. fork·compact·`/clear` 이후의 세션 동일성 정책이 없다

**쌍:** (a) fork된 transcript를 처음부터 읽는 parser. vs (b) fork 지점부터 읽는 parser.

**둘 다 합법:** AD-4는 커서 이후만 돌려주라고 하고, fork된 새 세션의 커서는 비어 있다 — 그러면 "처음부터"가 맞다. memlog는 Claude Code의 matcher로 `startup/resume/clear/compact/fork`를 확인했지만 **spine의 AD-6은 SessionStart 하나로만 다룬다.**

**부딪히는 것:** (a)면 같은 `harness_message_id`가 두 세션 아래에 복제된다(멱등 키는 `(session_id, harness_message_id)`이므로 막지 않는다) → 원문·조각·임베딩이 두 배, SM-5가 음수 방향으로 깨지고 집계형 질문(SM-3의 "몇 번 말했지")이 틀린다. (b)면 fork 세션의 앞부분 맥락이 어디에도 없고, `continued_from_session_id`는 FR-3대로 "자리만" 비어 있어 이어 읽을 수 없다. FR-5("이어서 연 세션은 새 메시지만 추가된다")가 어느 쪽으로도 만족되지 않는다.

**최소 규칙 — AD-6 보강:** SessionStart의 `source`(startup/resume/clear/compact/fork)를 세션 행에 적는다. 같은 `(harness, harness_message_id)`가 다른 세션에서 다시 보이면 **메시지를 복제하지 않고** 새 세션의 시작을 그 지점으로 잡고 `continued_from_session_id`·`continuation_kind`를 채운다(FR-3의 "자리만"을 fork/resume에 한해 자동 채움으로 승격). compact는 transcript 재작성으로 보고 H-2의 fingerprint 경로로 처리한다.

### H-13. 불변 trigger + 마스킹 연기 = 원문의 비밀이 영구히 삭제 불가하고, 미러로 동기화 폴더까지 나간다

**쌍:** (a) AD-11의 trigger를 그대로 구현한 postgres adapter(`messages` DELETE 거부). vs (b) Deferred 표에 따라 마스킹을 넣지 않는 ingest(spine은 "키·토큰 저장 전 마스킹"을 팀 공유 항목으로 미뤘다 — memlog에서는 결정되었다가 연기됨).

**둘 다 합법:** Deferred가 마스킹을 미뤘고 AD-11은 예외를 두지 않았다.

**부딪히는 것:** 대화에 평문으로 흘러든 키·토큰(PRD §9가 "이미 한 번 일어났다"고 기록한 사고)이 SOT에 들어가면 **삭제 경로가 없다.** AD-16의 미러가 그것을 파일로 내보내고, 그 폴더는 설정상 동기화 폴더일 수 있다(Brain은 모른다 — AD-16). 지금은 개인용이라 수용 가능해 보이지만, trigger를 먼저 출하하면 나중에 바꿀 때 이미 쌓인 원문은 못 고친다.

**최소 규칙 — AD-11 보강:** 불변의 예외를 **지금** 하나 정의한다 — `messages`·`tool_notes`의 본문은 `redactions` 테이블(대상, 구간, 이유, 시각)과 그 구간을 가리는 **읽기 경로**로만 가릴 수 있고, trigger는 그 경로의 UPDATE(또는 `body`를 가린 사본으로 대체)만 허용한다. 미러·내보내기·임베딩은 가려진 본문을 쓴다. 마스킹 자동화는 미뤄도 되지만 **가릴 수 있는 구조는 slice 1에 둔다.**

### H-14. drain의 transcript 폴더 스캔 범위와 커서가 정의되지 않았다

**쌍:** (a) 매 실행마다 폴더 전체를 스캔하는 drain. vs (b) `last_scan_at`보다 mtime이 새 파일만 보는 drain.

**둘 다 합법:** AD-7은 "transcript 폴더 스캔"을 일감으로 적었을 뿐 범위·커서를 말하지 않는다.

**부딪히는 것:** (b)의 mtime 커서는 **시계 기반 커서**다 — 스캔 도중에 써진 파일, 시계 역행, 같은 초 경계의 파일이 영구히 누락된다(조용한 누락, SM-5). (a)는 세션 수가 수백~수천이 되면 매 SessionStart마다 전체 파일을 다시 읽는다(async여서 Harness를 막지는 않지만 턴마다 CPU/IO를 먹고, C-3의 동시성 창을 넓힌다).

**최소 규칙 — AD-7 보강:** 스캔 상태는 파일별로 둔다 — `(path, size, mtime, last_offset, fingerprint)`. 변경 판정은 `size`·`fingerprint` 우선이고 mtime은 보조다. 시간 기준 커서는 쓰지 않는다. Harness가 transcript를 지우는 기한(Claude Code 기본 30일)을 설정으로 두고, 기한이 가까운 미수집 세션을 doctor에서 경고한다(FR-5).

### H-15. 시작 맥락의 "오늘 날짜"가 세션 시작 시각에 고정된다 — 자정을 넘기면 에이전트의 "어제"가 틀린다

**쌍:** (a) AD-13대로 시작 맥락에 "오늘 날짜 + 시간대" 한 줄을 넣는 `context`. vs (b) 절대 범위만 받는 `recall`(AD-13: "변환은 에이전트 몫").

**둘 다 합법:** AD-13이 둘을 그대로 규정한다.

**부딪히는 것:** 자정을 넘긴 세션(이 사용자에게 흔한 패턴)에서 에이전트는 **세션 시작 시점의 날짜**로 "어제"를 계산해 하루 밀린 범위를 Brain에 넘긴다. Brain은 요청대로 정확히 답하므로 어디에도 경고가 없다 — SM-2가 조용히 깎인다. AD-13은 "에이전트가 오늘을 잘못 아는 것"을 막겠다고 선언하지만, 한 번 주입한 날짜가 늙는 것은 막지 않는다.

**최소 규칙 — AD-13/Conventions 보강:** 모든 `--json` 응답 봉투에 `now`(오프셋 포함 ISO-8601)와 설정 시간대를 넣는다. 시간 조회 결과에는 해석된 절대 범위를 사람이 읽을 수 있게 되울려 주고, 요청 범위가 `now` 기준의 날짜 경계와 어긋날 때(예: "어제"로 보이는 범위가 실제 어제가 아닐 때) 경고하지 않고 **그대로 답하되 범위를 명시**한다. 시작 맥락 문장에는 "이 값은 세션 시작 시각 기준"임을 덧붙인다.

### H-16. parser 버전이 기록되지 않는다 — 멱등 키와 불변 trigger가 parser 버그를 영구화한다

**쌍:** (a) parser v1 — thinking 블록을 버린다. vs (b) parser v2 — 버그를 고쳐 포함한다(또는 sidechain 포함으로 바뀐다).

**둘 다 합법:** AD-4는 parser에게 "멱등"과 "커서 이후"만 요구하고 **무엇을 메시지로 세는지 고정하지 않는다**(변환 규칙은 addendum §5의 후보일 뿐 spine에 없다).

**부딪히는 것:** v1이 수집한 세션을 v2로 다시 수집하면 멱등 키 때문에 **no-op**이고, `messages`는 UPDATE·DELETE가 거부되므로(AD-11) 고칠 수 없다. 코퍼스가 parser 버전으로 영구히 갈라지는데, **어느 행이 어느 버전으로 만들어졌는지 기록이 없어** 갈라졌다는 사실조차 알 수 없다. FR-1("Harness가 보여 준 텍스트와 글자 단위로 같다")이 과거 데이터에 대해 검증 불가가 된다.

**최소 규칙 — AD-4 보강:** 세션 행에 `parser_version`(과 `transcript_fingerprint`)을 기록한다. parser 버전이 올라가면 **같은 (harness, harness_session_id)를 새 수집 세대로 다시 읽는 경로**를 하나 둔다 — 새 세션 행 + `supersedes_session_id`(기존 행과 메시지는 그대로 남는다), 조회 기본값은 최신 세대. doctor는 옛 parser 버전으로만 수집된 세션 수를 보인다. 이 경로가 없다면 "parser 변경은 breaking change이며 재수집 불가"를 AD에 명시해 선택을 드러낸다.

---

## Medium

- **M-1. AD-5의 1:1 규칙과 Conventions의 kebab 예시가 모순이다.** Conventions는 "CLI 명령은 SDK 메서드 이름의 kebab-case(`log.append` ↔ `brain log`)"라고 쓰는데, `log.append`의 kebab은 `log-append`이거나 `log append`다. 두 구현자가 `brain log`와 `brain log-append`를 만든다. 또 FR-24의 도구 13개와 SDK 메서드의 대응 표가 없어 `recall`/`expand`/`context`/`search-log`/`search-chunk`의 이름이 열려 있다. → **규칙:** SDK 메서드 ↔ CLI 명령 대응 표를 spine에 한 번 적는다(`log.append` → `brain log`처럼 예외가 있으면 표에 명시).
- **M-2. 메시지 순서의 근거가 둘이다(UUIDv7 vs `seq`).** AD-8이 UUIDv7(시간 정렬)을 못 박아서, 어떤 구현은 `ORDER BY id`로 메시지를 읽는다. 병렬 생성·재수집에서 `id` 순서와 transcript 순서가 갈라진다. → **규칙:** 메시지·조각의 유일한 순서 근거는 `seq`다. `id`로 정렬하는 경로를 만들지 않는다(H-1과 함께).
- **M-3. 내보내기의 스냅샷 일관성이 없다.** Conventions는 테이블별 JSONL + `manifest.json`(건수)만 정한다. live ingest가 도는 중 테이블을 순차로 읽으면 manifest 건수와 실제 파일, 그리고 FK 정합성이 어긋난다 → NFR-9의 "복구 뒤 건수가 같다"가 깨진다. → **규칙:** 내보내기는 하나의 `REPEATABLE READ` 스냅샷에서 수행하고 manifest에 스냅샷 시각(및 `pg_current_wal_lsn`)을 적는다.
- **M-4. 비규칙 로그의 "끄기"가 정의되지 않았다.** FR-22는 "고치고 끄기"인데 AD-11·AD-14는 `rule_state`만 다룬다. 진행·결정·선호를 끄는 경로가 없어 두 구현이 "삭제"와 "숨김"으로 갈라진다. → **규칙:** 모든 로그 종류에 `disabled_at`을 두고, 끄기는 삭제가 아니라 그 컬럼의 설정이며 조회 기본값에서 제외된다(AD-11의 단일 수정 함수가 담당).
- **M-5. 부분 색인 상태가 "미색인 세션"으로만 집계된다.** 임베딩이 세션 중간에 실패하면 조각은 있고 벡터는 없다 — AD-15의 경고 목록은 세션 단위라 "절반 색인"을 구분하지 못해 검색이 조용히 저하된다. → **규칙:** 색인 상태는 조각 단위 집계(`chunks` 중 해당 `index_config`의 임베딩이 있는 비율)로 판정하고, 비율이 1 미만인 세션을 경고에 넣는다.
- **M-6. 사람용 출력의 시간대 변환 위치가 불명.** AD-13은 "사람용 출력만 설정 시간대로 표시", AD-18은 "설정은 Runtime의 로더만 읽고 Core에는 값으로 넘긴다". Core가 시간대 값을 받아 포맷하는 구현과 CLI가 포맷하는 구현이 둘 다 합법이고, 전자는 Core에 로케일 포맷이 들어온다. → **규칙:** Core는 항상 오프셋 포함 절대 시각만 돌려주고, 시간대 표시는 CLI의 출력 변환층에서만 한다(AD-5의 "출력 형식 변환"에 포함).
- **M-7. `brain connect`가 spine 본문에 없다.** Structural Seed와 memlog에만 있고 AD-19는 설치기와 `brain setup`만 말한다. C-7의 단일 작성자 규칙과 함께 명령 이름을 본문에 적는다.
- **M-8. AD-2의 묶음 빌드가 AD-1의 강제력을 출하 시점에 지운다.** 내부 패키지를 tsdown으로 묶으면 소비자 쪽에서는 의존 방향을 검증할 수 없다(개발 중에만 유효). 저장소에 방향 검사 테스트(의존성 그래프 단위 테스트)를 하나 둔다고 적는다.
- **M-9. 시작 맥락의 규칙 크기 경고선과 SM-C1의 충돌이 spine에 반영되지 않았다.** PRD 검토가 이미 지적한 모순(FR-17 "규칙은 전부 들어간다" vs SM-C1 500토큰)을 spine은 그대로 통과시킨다 — 두 구현이 "자르기"와 "넘기고 경고"로 갈라진다. AD에 "규칙은 자르지 않고 경고만 한다, 최근 로그만 자른다"를 한 줄로 적는다.
- **M-10. drain의 일감 테이블이 없다.** AD-7은 "일감을 행 잠금으로 나눠 가진다"고 하지만 일감이 어디에 있는지(전용 큐 테이블 vs 각 테이블의 상태 컬럼 스캔) 정하지 않았다. 두 구현이 섞이면 같은 일을 두 방식으로 claim 한다. → **규칙:** 일감은 상태 컬럼 스캔 하나로 정하고(또는 `work_items` 하나로 정하고), 모든 drain 작업이 같은 방식을 쓴다.
- **M-11. 세션 추적 정보의 `machine`·`user` 계산자가 없다.** AD-12는 칸만 두었다. 호스트명 vs 하드웨어 UUID vs 설정값 중 무엇인지 미정이라 두 번째 기계 수용(Deferred)에서 멱등 키 해석이 갈라진다. → **규칙:** `machine`은 설치 시 생성해 `config.toml`에 적은 안정 ID이고, `user`도 설정값이다(호스트명 파생 금지).
- **M-12. `--json` 봉투의 `warnings` 코드 집합이 열려 있다.** Conventions는 "코드와 함께"만 요구한다. 에이전트가 분기할 코드가 구현마다 달라지면 FR-25의 점검과 에이전트 동작이 갈라진다. → **규칙:** 경고 코드를 core의 열거형 하나로 정의한다(`rerank_failed`, `spooled_locally`, `index_config_mismatch`, `session_unresolved`, `partially_indexed`, `transcript_rewritten` …).

## Low

- **L-1.** `log_entry_edits`에 "누가/무엇으로" 칸이 없다 — 사용자 수정과 에이전트 수정이 구분되지 않는다.
- **L-2.** `index_configs`의 동일성 판정(같은 모델·차원·조각 파라미터면 같은 행인가)이 미정 — 재실행마다 행이 늘어날 수 있다.
- **L-3.** `brain reindex`의 "새 테이블을 만든 뒤 교체"에서 교체 중 조회가 어느 테이블을 보는지 미정(memlog는 "재색인 중엔 옛 테이블"이라고 적었으나 spine에 없다).
- **L-4.** spool 디렉터리의 크기 상한·오래된 항목 정책이 없다(DB가 장기간 꺼져 있을 때).
- **L-5.** `tool_notes.target`의 정규화(상대/절대 경로, 홈 축약)가 미정 — FR-2의 "경로나 이름으로 찾기"가 구현마다 달라진다.
- **L-6.** 마이그레이션의 "앞으로만 진행"에 롤백 불가 선언이 있지만, 실패한 마이그레이션의 중간 상태 처리(트랜잭션 단위)가 미정.
- **L-7.** `brain doctor`의 종료 코드 규약이 없다(hook 경로는 exit 0이지만 doctor는 사람·CI가 본다).

---

## 구조적 원인과 적용 순서

구멍 42개는 세 뿌리에서 나온다.

1. **공유 데이터의 모양·단위에 주인이 없다** (C-2, C-5, H-1, H-2, H-10, M-2, M-12). spine은 `IngestBatch`·커서·오프셋·조각을 **이름으로만** 정했다. 이름은 패키지 경계를 넘지만 모양은 넘지 않는다.
2. **한 엔티티에 작성자가 여럿이다** (C-1, C-4, C-7, H-4, H-5, H-6, H-7). 원인은 AD-6·AD-7·AD-14가 "두 경로 모두 가능"을 *기능*으로 허용하면서 *작성자*를 고르지 않은 것이다. 단일 작성자 + "비어 있을 때만 채운다"는 두 줄이면 대부분 닫힌다.
3. **동시성이 AD-7 한 줄에만 있다** (C-3, H-8, H-14). 데몬이 없다는 결정은 상주 프로세스를 없앴지만 **동시성을 없애지 않았다** — 오히려 수명이 짧고 서로를 모르는 프로세스 다섯 종류로 바꿨다. AD-7의 SKIP LOCKED는 drain 내부만 덮는다.

적용 순서(구현 전):

1. **C-1 → C-3 → C-2**: 세션 identity와 직렬화, 멱등 키. 이 셋이 데이터 모양의 바닥이고, 불변 trigger가 켜지기 전에 닫아야 한다.
2. **C-6 → C-7**: hook 경계. 닫히지 않으면 나머지 전부가 "돌고 있는 줄 알았는데 안 돌았다"로 무효가 된다.
3. **C-5, C-4**: 규칙 인용의 단위와 상태. FR-19·FR-22의 정확성 전체가 여기 달려 있다.
4. **H-13**: 가림 구조. AD-11의 trigger와 **같은 마이그레이션에** 들어가야 한다. 나중에는 못 넣는다.
5. 나머지 High는 각 epic의 첫 티켓에서 닫는다(H-1·H-2·H-16은 parser epic, H-7은 미러 epic, H-8·H-3은 spool·log epic, H-9는 설치기 epic).

신규 AD는 세 개면 충분하다 — **AD-20**(세션 행의 단일 소유자와 식별 토큰), **AD-21**(텍스트 좌표와 정규화), **AD-22**(Harness 경계 계약: hook 출력·세션 env·주입 기록). 나머지는 AD-4·AD-7·AD-8·AD-9·AD-11·AD-12·AD-13·AD-14·AD-15·AD-16·AD-18·AD-19와 Conventions의 한두 줄 보강이다.
