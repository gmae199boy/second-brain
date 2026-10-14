---
name: 'Adversary review — spine 개정판(2026-10-14) 공격'
type: architecture-review
lens: adversary
target: ./architecture-brain-v1-slice-1.md
target_updated: '2026-10-14'
reviewed: '2026-10-14'
method: 'AD를 전부 지키면서도 서로 못 붙는 단위 쌍(pair) 구성'
---

# Adversary — spine 개정판 공격

## 공격 방법

이 검토는 "spine이 틀렸다"를 찾지 않는다. **AD를 한 글자도 어기지 않는 하위 단위 두 개를 만들어 서로 못 붙게 만든다.** 쌍이 성립하면 그 자리가 구멍이다. 구멍마다 새 AD 또는 기존 AD를 조이는 **그대로 붙여 쓸 규칙 문장**을 제시한다.

단위는 한 단계 아래(에픽·스토리)에서 고른다.

| 단위 | 소속 | AD 근거 |
| --- | --- | --- |
| U-ctx — 동기 시작 맥락 (`context.show` + hook) | epic 3 | AD-6, AD-17 |
| U-ing — 턴 수집 (`sessions.ingest` + parser) | epic 2 | AD-4, AD-7, AD-8 |
| U-log — 로그 쌓기 (`log.append`/`edit`/`set-state`) | epic 3 | AD-9, AD-14 |
| U-drn — 밀린 일 (`admin.drain`) | epic 2·5 | AD-7, AD-9 |
| U-idx — 조각·색인 생성 | epic 4 | AD-15 |
| U-mir — Markdown 미러 | epic 4 | AD-16 |
| U-red — 가리기 (`messages.redact`) | epic 2 | AD-11 |
| U-exp — 내보내기·복구 | epic 5 | AD-20, Conventions |
| U-sq — SQLite store adapter | story 1.10 | AD-10 |
| U-pg — Postgres 복제 adapter | epic 7 | AD-10 |

## Verdict

**조건부 통과 — Critical 5건은 epic 2 착수 전에 닫아야 한다.**

개정은 AD-10을 깔끔하게 바꿨지만, **잠금 모델이 "세션 단위 advisory"에서 "DB 단위 BEGIN IMMEDIATE"로 넓어진 결과가 AD-6·AD-9·AD-16·AD-17로 전파되지 않았다.** 예전에는 세션 단위 잠금이라 서로 다른 세션의 프로세스가 부딪히지 않았다. 지금은 모든 `brain` 프로세스가 같은 하나의 쓰기 잠금을 다툰다. 그래서 "잠금 시간 초과 → spool"(AD-7·AD-9)이 예외 경로가 아니라 **평시 경로**가 되었고, AD-9가 그 경로에 붙여 둔 사용자 표시("DB에 쓸 수 없음")가 정상 동작 중에 튀어나온다.

또 SQLite로 내려오면서 **표현(representation)이 타입에서 텍스트로 바뀐 것**이 규칙으로 올라오지 않았다. `timestamptz`·`uuid`는 DB가 정규형을 강제했지만 TEXT는 강제하지 않는다. 지금 spine에는 "UTC ISO-8601 텍스트(밀리초, `Z`)"까지만 있고, **글자 수·소수 자릿수·오프셋 금지·collation·NFC가 없다.** 사전순 비교에 의존하는 모든 조회(AD-13 범위, AD-14 anchor)가 여기에 걸린다.

세 번째 축은 **파생물의 일관성**이다. AD-11(가리기)은 `messages` 행만 다루고 `chunks`·FTS5·`tool_notes`·내보내기를 다루지 않는다. 그래서 FR-26을 지켰다고 선언한 단위와 조각을 멱등하게 만든 단위가 **각자 계약 테스트를 통과하면서 비밀을 검색 결과로 흘린다.**

- Critical 5 (C-1~C-5): 쌍이 서로 못 붙고, 증상이 조용하다
- High 8 (H-1~H-8): 쌍이 서로 다른 답을 내거나 데이터를 잃는다
- Medium 4 (M-1~M-4)

---

## Critical

### C-1. 동기 시작 맥락이 DB 단위 쓰기 잠금을 잡는다 — drain이 돌면 평시에 시작 맥락이 사라진다

**쌍:** U-drn(밀린 일) × U-ctx(동기 시작 맥락)

**각자 AD를 지키는 방식**

- U-drn: AD-7 "데이터를 쓰는 모든 경로는 `BEGIN IMMEDIATE`를 잡는다. 잠금은 데이터베이스 단위다." drain은 조각 생성·미러 갱신·spool 재주입을 한 묶음으로 처리하는 백그라운드 작업이라 `busy_timeout`을 넉넉히(예: 30s) 잡고, 한 트랜잭션에서 수십 세션의 조각을 만든다. AD-7 위반 없음.
- U-ctx: AD-6 "`SessionStart`(동기, 짧은 timeout) → `sessions.ensure`, 켜진 규칙·최근 로그 읽기, **주입 시도 기록**". AD-17 "주입 시도는 성공·실패를 모두 `context_injections`에 기록한다". 즉 **사용자가 기다리는 동기 경로가 쓰기 두 번(`sessions.ensure`, `context_injections`)을 한다.** NFR-7 때문에 `busy_timeout`은 짧다(예: 200ms).

**왜 못 붙는가**

AD-6은 `SessionStart`(async)에서 drain을 띄운다. 그 drain은 같은 기계에서 **바로 다음 세션 시작과 겹친다.** drain이 DB 단위 쓰기 잠금을 30s 쥐고 있으면 U-ctx의 `sessions.ensure`는 200ms에 시간 초과한다. 그러면 AD-9가 명령한다:

> 시작 hook: 시작 맥락 대신 "DB에 쓸 수 없음, 로컬 보관 N건"을 에이전트와 사용자(`systemMessage`)에게 보인다.

**DB는 멀쩡하다. 다른 `brain` 프로세스가 바빴을 뿐이다.** 그런데 사용자는 "DB에 쓸 수 없음"을 보고, 에이전트는 켜진 규칙과 최근 로그를 못 받는다(FR-17·FR-19 실패). 더 나쁜 것은 이 실패가 **시작 맥락을 읽을 수 없었기 때문이 아니라는 점**이다. 읽기는 WAL에서 잠금 없이 성공한다. 실패한 것은 기록(쓰기)뿐인데, AD-9의 문장은 읽기 결과까지 버리게 만든다.

빈도도 낮지 않다. 턴마다 수집(AD-6)이 돌고, 세션 여러 개가 동시에 뜨고, drain이 시작마다 돈다. 개인 규모라도 잠금 경합은 **설계상 상시**다.

**조용한 이유:** 양쪽 단위의 "Done when"이 전부 통과한다. U-drn은 멱등하게 일을 처리했고, U-ctx는 AD-9가 지시한 대로 저하를 표시했다. 통합 테스트가 두 프로세스를 동시에 띄우지 않으면 보이지 않는다.

**규칙(AD-6·AD-9·AD-17 조이기 + AD-7에 역할별 timeout 추가)**

> **AD-6 추가** — **동기 경로는 읽기 전용이다.** `SessionStart`(동기)는 쓰기 트랜잭션을 잡지 않는다. 시작 맥락은 WAL 읽기 스냅샷만으로 만든다. 세션 행 확보(`sessions.ensure`)와 주입 시도 기록(`context_injections`)은 동기 경로에서 하지 않고, 같은 hook의 async 경로(`admin.drain`)와 그 세션의 첫 수집이 멱등하게 처리한다. 동기 경로가 다음 단계로 넘기는 것은 세션 키(`harness:harness_session_id`)와 주입 시도 레코드 하나이며, 후자는 spool에 쓴다(쓰기 잠금 불필요).
>
> **AD-9 교체** — 시작 hook의 저하 표시는 **"시작 맥락을 만들 수 없을 때"만** 낸다. 즉 DB 파일을 **읽을** 수 없거나 스키마 버전이 다를 때다. 쓰기 잠금 시간 초과는 시작 맥락을 대체하지 않는다. 이 경우 시작 맥락을 정상으로 내고, `--json`에는 `warnings: ["SPOOLED"]`를, 사람용 출력에는 아무것도 추가하지 않는다. 사용자에게 보이는 `systemMessage`는 **읽기 불가일 때만** 쓴다.
>
> **AD-7 추가** — `busy_timeout`은 역할마다 Core가 정한 상수를 쓴다: 사용자 대기 경로 200ms, 턴 수집 3s, 사람이 띄운 명령 10s, drain·미러 재생성 10s. **어떤 쓰기 트랜잭션도 2초를 넘겨 잠금을 쥐지 않는다.** 2초를 넘길 작업은 세션 단위(또는 일감 단위)로 쪼개 트랜잭션 여러 개로 만든다. 계약 테스트: drain이 10,000건을 처리하는 동안 동기 경로 100회가 모두 200ms 안에 시작 맥락을 받는다.

---

### C-2. `seq`의 주인이 parser인데, 커서 리셋·compact 뒤에는 같은 `seq`가 다른 메시지에 배정된다 — 불변 trigger 때문에 수선 불가

**쌍:** U-ing(parser) × U-ing(ingest core / store)

**각자 AD를 지키는 방식**

- parser 쪽: AD-4 "메시지 `seq`와 도구 메모 순번도 parser가 정하고, **같은 입력이면 항상 같은 값**이다." 출력은 (transcript 내용, `parser_version`)의 순수 함수다. 가장 단순하고 결정적인 구현은 "이번에 읽은 transcript의 처음부터 0, 1, 2 …"다. 같은 입력이면 같은 값이므로 AD-4 완전 충족.
- store 쪽: Table Contract `messages` 멱등 키 `(session_id, harness_message_id)`, `(session_id, seq)`. AD-8 "테이블마다 자연 멱등 키를 UNIQUE 제약으로 둔다." 중복은 키로 걸러낸다. AD-11 "`messages`는 UPDATE·DELETE를 거부한다."

**왜 못 붙는가**

AD-4는 커서 리셋을 **정상 경로**로 규정한다.

> parser 커서는 (마지막 Harness 메시지 ID, 그 지점까지의 fingerprint)다. 커서 메시지가 사라졌거나(compact·fork) fingerprint가 다르면 **처음부터 다시 읽는다.** 멱등이므로 중복은 생기지 않고, 경고를 남긴다(`CURSOR_RESET`).

그런데 compact은 transcript의 앞부분을 **요약으로 치환**한다. 처음부터 다시 읽으면 입력이 달라졌으므로 parser가 내는 `seq`도 달라진다. 구체적으로:

| | 1차 수집 | compact 후 재수집 |
| --- | --- | --- |
| seq 0 | msg-a | summary-x (새 메시지) |
| seq 1 | msg-b | msg-h |
| seq 2 | msg-c | msg-i |

이제 삽입이 세 갈래로 갈린다.

1. `(session_id, harness_message_id)`로 보면 `msg-h`는 새 메시지다 → 삽입해야 한다.
2. `(session_id, seq)`로 보면 `seq 1`은 이미 `msg-b`가 쓰고 있다 → UNIQUE 충돌.
3. AD-11 때문에 `msg-b`의 `seq`를 바꿀 수도, 지울 수도 없다.

**AD-8의 멱등 계약 테스트("같은 배치를 두 번 넣으면 모든 테이블의 건수가 같다")는 이 경우를 전혀 건드리지 않고 통과한다.** 같은 배치가 아니라 다른 배치이기 때문이다.

결과는 둘 중 하나이고, 둘 다 조용하다.

- store가 충돌에 `INSERT OR IGNORE`를 쓰면 → **compact 이후의 모든 메시지가 영구히 사라진다.** 커서는 전진했으므로 다시 수집되지도 않는다. 턴 수집 실패는 화면에 띄우지 않는다(AD-9).
- store가 충돌에 실패를 쓰면 → 해당 세션은 compact 이후 영구히 수집 불가. `failures`에 같은 fingerprint로 쌓이고 drain이 영원히 재시도한다.

같은 폭발이 **`parser_version` 올림**에서도 난다. parser 버그를 고쳐 `seq` 배정이 한 칸 밀리면, 그 뒤 모든 세션의 재수집이 `(session_id, seq)`에 걸린다. Deferred의 "parser 버그로 저장된 메시지의 교정"은 *내용* 교정만 미뤘고, **seq 재배정이 불가능하다는 사실은 어디에도 없다.**

**규칙(AD-4·AD-8 조이기 — `seq`의 주인을 parser에서 원본 store로 옮긴다)**

> **AD-4 교체** — parser는 `seq`를 정하지 않는다. parser가 내는 것은 배치 **안에서의 순서**(`batch_ordinal`, 0부터)와 각 메시지의 `harness_message_id`·`occurred_at`뿐이다. 같은 입력이면 같은 `batch_ordinal`을 낸다.
>
> **AD-8 추가** — `messages.seq`는 **원본 store가 삽입 트랜잭션 안에서 배정한다.** 세션마다 0부터 1씩 증가하는 append-only 정수이며, 한 번 배정되면 바뀌지 않고 구멍이 없다. 이미 있는 `harness_message_id`는 `seq`를 재배정하지 않고 건너뛴다. 따라서 `(session_id, seq)`는 정의상 충돌하지 않고, 커서 리셋·`parser_version` 올림·compact은 **새로 본 메시지를 뒤에 붙이는 일**이 된다. `tool_notes.ordinal`도 같은 방식으로 `(session_id, harness_message_id)` 안에서 store가 배정한다.
>
> **따름 규칙** — `seq`는 원본에서만 배정된다. 복제 adapter는 원본이 배정한 값을 그대로 복사하고 자기가 만들지 않는다(AD-10). `seq` 순서는 삽입 순서이므로 `occurred_at` 순서와 다를 수 있다. 시간 순서가 필요한 조회는 `occurred_at`으로 정렬하고, AD-14의 anchor 규칙은 그대로 유지한다(`occurred_at` 이하 중 `seq` 최대). 계약 테스트: (1) 앞부분이 치환된 transcript를 재수집하면 새 메시지만 늘고 기존 행은 한 글자도 바뀌지 않는다. (2) 같은 배치 두 번 → 모든 테이블 건수 동일 + `seq` 최대값 동일.

---

### C-3. 가리기가 파생물을 덮지 않는다 — 가린 뒤에도 검색이 비밀을 돌려준다. `tool_notes`에는 가릴 길이 아예 없다

**쌍:** U-red(`messages.redact`) × U-idx(조각·FTS5 색인)

**각자 AD를 지키는 방식**

- U-red: AD-11을 글자 그대로 구현한다. 본문 일부를 `[REDACTED:<kind>]`로 치환하고, 같은 트랜잭션에서 `redactions`에 위치·종류·해시를 남기고, **"가린 세션의 미러는 다시 만든다."** AD-11에 적힌 전부를 했다.
- U-idx: AD-15 "조각은 항상 만든다", Table Contract `chunks` 멱등 키 `(session_id, index_config_id, seq_from, seq_to)`, "파생, 다시 만들 수 있음". 멱등이므로 같은 seq 범위의 조각이 이미 있으면 다시 만들지 않는다. AD-15 완전 충족.

**왜 못 붙는가**

AD-15는 FTS5 trigram 색인을 **`chunks.body`·`log_entries.text`·`tool_notes.target`**에 둔다. `messages.body`에는 두지 않는다. 즉 **검색이 실제로 읽는 본문은 `messages`가 아니라 `chunks`다.**

AD-11은 `messages` 행과 미러만 고친다. `chunks`는 건드리지 않는다. U-idx는 그 seq 범위의 조각이 이미 있으니 다시 만들지 않는다. 그래서:

```
brain messages redact …            → messages.body에 [REDACTED:api_key], 미러 재생성 ✓
brain recall chunks "sk-live-…"    → 비밀 원문이 그대로 나온다 ✗
```

FTS5 색인 안의 trigram도 남는다. FR-26("들어간 비밀을 지운다")과 NFR-1이 **양쪽 단위가 각자 계약 테스트를 통과한 상태로** 깨진다.

두 번째 구멍: **`tool_notes`에는 가리기 경로가 없다.** AD-11은 "`messages`와 `tool_notes`는 UPDATE·DELETE를 거부한다. **유일한 예외는 `messages.redact`**"라고 쓴다. AD-5의 CLI 표면에도 `messages redact`만 있다. 그런데 도구 메모는 비밀이 가장 잘 섞이는 곳이다(`curl -H "Authorization: Bearer …"`, `.env` 읽기, 토큰이 든 URL). 저장 전 마스킹(AD-11)은 **알려진 패턴**만 잡는 최선 노력이다. 패턴을 벗어난 비밀이 도구 메모에 들어가면 **영구히 지울 수 없다.** 유일한 수단은 DB 파일을 버리는 것이다.

세 번째 구멍: **트랜잭션 범위 표시의 누출.** AD-11은 구현을 story 1.10으로 미루면서 "Store 구현마다 방식은 다르고, 계약 테스트가 동작을 고정한다"고만 쓴다. SQLite의 자연스러운 구현은 임시 테이블 행이나 `PRAGMA`인데, **둘 다 트랜잭션 범위가 아니라 연결 범위다.** `node:sqlite`는 프로세스당 연결 하나를 재사용한다. redact 함수가 조기 반환·예외·롤백으로 빠져나가면서 표시를 지우지 못하면, **그 프로세스의 남은 생애 동안 불변 trigger가 무장 해제된 상태로 남는다.** 그 뒤의 어떤 버그도 원문을 조용히 고칠 수 있다. 지금 적힌 계약 테스트("redact 경로만 통과한다")는 이걸 못 잡는다. 통과하는 경로만 보고, 통과 뒤에 남는 상태를 안 본다.

**규칙(AD-11 교체 — 가리기를 세션 범위 연쇄 작업으로 정의)**

> **AD-11 교체** — 가리기는 본문 치환 하나가 아니라 **정해진 연쇄(cascade)** 다. `messages.redact`와 `tool_notes.redact`는 하나의 쓰기 트랜잭션 안에서 다음을 모두 한다. 하나라도 못 하면 전체를 롤백하고 실패로 답한다(spool로 보내지 않는다 — 가리기는 지연시키면 안 되는 쓰기다).
> 1. 대상 본문을 `[REDACTED:<kind>]`로 치환한다.
> 2. `redactions`에 위치·종류·해시를 남긴다(지운 내용은 보존하지 않는다).
> 3. **그 메시지의 seq가 걸린 모든 `chunks` 행과 그에 딸린 FTS5 행·`embeddings` 행을 삭제한다.**
> 4. 그 seq 범위의 조각 재생성 일감을 대기열에 넣는다(AD-21).
> 5. 그 세션의 미러 재생성 일감을 대기열에 넣는다.
>
> 즉 가리기는 `messages`·`tool_notes`의 UPDATE 예외이면서 **`chunks`·`embeddings`·FTS5의 DELETE 경로**다. 파생물은 원본에서 다시 만들 수 있으므로(AD-10) 삭제가 손실이 아니다.
>
> **우회 표시 규칙** — 표시를 세우고 지우는 것은 Store adapter의 redact 함수 **한 곳**이며, `try/finally`로 어떤 경로로 빠져나가도 지운다. 표시는 한 번의 UPDATE에만 유효하다(한 문장 소비형). 계약 테스트에 다음 세 항목을 넣는다: (a) redact 직후 **같은 연결에서** 임의의 `messages` UPDATE가 거부된다. (b) redact 트랜잭션을 롤백하면 표시가 남지 않고 이어지는 UPDATE가 거부된다. (c) **redact 후 `recall.chunks`·`recall.tools`·`recall.logs`·미러·`admin.export` 어디에서도 지운 문자열이 나오지 않는다.**
>
> **AD-5 표면 추가** — `messages` ns의 verb에 `redact`와 함께 `tool-notes redact`를 둔다(또는 `messages redact --tool-note <id>`). CLI 표면 표를 고친다.

---

### C-4. drain 일감 대기열이 Table Contract에 없다 — `claimed_at`을 넣을 자리가 없고, lease 길이가 미정이다

**쌍:** U-ing(실패 기록) × U-drn(일감 claim)

**각자 AD를 지키는 방식**

- U-ing: Table Contract `failures`를 글자 그대로 구현한다. 멱등 키 `(harness, harness_session_id, stage, fingerprint)`, 작성자 "모든 경로(실패 기록 함수 하나)", **변경 가능성 "`resolved_at`만 drain이 채움"**. 그래서 SQLite 구현은 그 테이블에 `resolved_at` 말고는 UPDATE를 허용하지 않고, 계약 테스트도 그렇게 고정한다.
- U-drn: AD-7을 글자 그대로 구현한다. "일감은 IMMEDIATE 트랜잭션 안에서 `UPDATE … SET claimed_at … WHERE 미청구(또는 청구 만료) RETURNING`으로 나눠 가진다." 일감의 1순위 원천은 `failures`(실패한 수집)다. 그래서 `failures`에 `claimed_at`·`claim_expires_at`·`attempts`를 더한다.

**왜 못 붙는가**

AD-7은 **존재하지 않는 컬럼에 쓰라고** 지시한다. Table Contract에는 `claimed_at`을 가진 테이블이 하나도 없고, 대기열 테이블 자체가 없다. ER 다이어그램에도 없다. 그래서 U-drn은 두 선택지뿐이다.

1. `failures`에 claim 컬럼을 더한다 → U-ing의 계약 테스트("`failures`는 `resolved_at`만 변한다")를 깬다. 두 단위가 같은 테이블의 변경 가능성을 다르게 고정한 채 각자 통과하고, 나중에 합칠 때 한쪽을 다시 쓴다.
2. claim을 포기하고 "할 일을 매번 다시 계산한다"(예: 커서가 `transcript_files`보다 뒤처진 세션을 찾는다) → **AD-7의 "나눠 가진다"가 구현되지 않는다.** 동시에 뜬 drain 둘이 같은 세션의 조각을 같이 만들고, 같은 미러 파일을 같이 전체 교체한다(AD-16). 멱등이라 결과는 같지만 둘 다 DB 단위 쓰기 잠금을 다투고(C-1), 미러는 rename 경합을 한다.

더 작은 균열: AD-7은 "청구 만료"를 말하면서 **만료 기간을 정하지 않는다.** U-drn-A가 lease를 30s로, U-drn-B(미러 재생성 담당)가 5분으로 잡으면 — 각자 AD-7을 지켰는데 — 5분짜리 일감이 30s마다 중복 청구된다. 반대로 lease가 길면 죽은 프로세스가 잡은 일감이 그만큼 멈춘다.

또 `attempts`·backoff가 없어서 **영구 실패 일감이 drain을 매번 선점한다.** `failures`에 UNIQUE가 걸려 있으니 재시도 횟수를 셀 자리도 없고, C-2 같은 영구 충돌이 나면 drain이 그 일감만 붙잡는다.

**규칙(새 AD-21)**

> ### AD-21 — 밀린 일은 하나의 대기열 테이블로 나눠 가진다
>
> - **Binds:** FR-5, FR-8, FR-11, NFR-2
> - **Prevents:** 같은 일감을 두 drain이 같이 하는 것, 실패 기록 테이블이 대기열로 겸업하다 변경 가능성이 어긋나는 것, 영구 실패 일감이 대기열을 선점하는 것
> - **Rule:**
>   - 일감은 `work_items` 테이블 하나에 있다. 컬럼은 `id`(UUIDv7), `kind`, `target_kind`, `target_id`, `payload`(정규 JSON), `enqueued_at`, `claimed_at`, `claim_expires_at`, `claimed_by`(`machine:pid`), `attempts`, `next_attempt_at`, `last_error`, `done_at`이다.
>   - 멱등 키는 `(kind, target_kind, target_id)`이고 미완료 행에만 적용한다(부분 UNIQUE). 같은 일감을 두 번 넣으면 한 행이다.
>   - claim은 IMMEDIATE 트랜잭션 안에서 `UPDATE work_items SET claimed_at=?, claim_expires_at=?, claimed_by=?, attempts=attempts+1 WHERE done_at IS NULL AND next_attempt_at<=? AND (claimed_at IS NULL OR claim_expires_at<?) ORDER BY next_attempt_at LIMIT ? RETURNING *`로 한다.
>   - **lease는 일감 종류마다 Core가 정한 상수**다(조각 생성 60s, 미러 재생성 60s, spool 재주입 30s, transcript 스캔 120s). 일감 처리가 lease를 넘길 것 같으면 처리 중에 lease를 연장한다.
>   - 실패하면 `attempts`와 `last_error`를 갱신하고 `next_attempt_at`을 지수 backoff(기본 1s, 2배, 상한 1h)로 미룬다. `attempts`가 10을 넘으면 `failures`에 올리고 `next_attempt_at`을 하루 뒤로 미룬다. doctor는 `attempts>=10`인 일감 수를 보인다.
>   - **`failures`는 기록이고 대기열이 아니다.** `failures`에는 claim 컬럼을 두지 않으며 Table Contract의 변경 가능성("`resolved_at`만 drain이 채움")을 그대로 유지한다.
>   - 모든 일감 처리는 멱등이다. 일감이 사라져도(수동 삭제, 내보내기·복구) 재계산으로 다시 만들 수 있어야 한다: drain은 claim 전에 "커서가 뒤처진 세션", "조각 없는 seq 범위", "`*.jsonl` spool 파일"을 훑어 빠진 일감을 `work_items`에 넣는다(enqueue는 멱등 키로 중복되지 않는다).
>
> **Table Contract 행 추가**
>
> | `work_items` | `(kind, target_kind, target_id)` (미완료 행만) | enqueue: 모든 경로. claim·완료: drain | `claimed_at`·`claim_expires_at`·`claimed_by`·`attempts`·`next_attempt_at`·`last_error`·`done_at`만 변함 |

---

### C-5. 저장 시각 텍스트의 정규형이 글자 단위로 고정되지 않았다 — spool 왕복이 오프셋 표현을 DB에 들여놓고 사전순 비교가 깨진다

**쌍:** U-log(spool로 간 `log.append`) × U-drn(spool 재주입) / U-ing(DB 직행 수집)

**각자 AD를 지키는 방식**

- U-log: AD-9 "DB에 쓰지 못한 작업 로그 원문 … 은 spool에 쓴다. spool은 JSON Lines다." + Conventions "**JSON은 오프셋을 포함한 ISO-8601**". 그래서 spool 줄에 `"occurred_at": "2026-10-14T22:10:00.000+09:00"`을 쓴다. Conventions를 그대로 지켰다.
- U-drn: AD-9 "레코드의 `occurred_at`과 ID는 처음 만든 프로세스가 정하고, **재주입 때 바꾸지 않는다.**" 그래서 그 문자열을 그대로 `log_entries.occurred_at`에 넣는다. AD-9를 그대로 지켰다.
- U-ing: AD-13 "저장은 UTC ISO-8601 텍스트(밀리초, `Z`)다." 그래서 `"2026-10-14T13:10:00.000Z"`를 넣는다. AD-13을 그대로 지켰다.

**왜 못 붙는가**

같은 컬럼에 `…T22:10:00.000+09:00`과 `…T13:10:00.000Z`가 섞인다. **두 값은 같은 순간인데 사전순으로는 `22…`가 한참 뒤다.** SQLite TEXT 비교는 사전순이고, spine의 모든 시간 조회가 그 비교에 의존한다.

- AD-14 anchor: "`occurred_at` 이하인 메시지 중 `seq`가 가장 큰" → 13:10Z에 적은 로그가 14:00Z~22:10Z 메시지들 **뒤에** 붙는다. 로그가 엉뚱한 대화에 연결된다(AD-14가 막겠다고 선언한 바로 그것).
- AD-13·FR-12 범위 조회: `occurred_at BETWEEN ? AND ?`가 오프셋 표현 행을 조용히 빠뜨린다. 결과는 "없음"으로 성공한다.
- 정렬·커서 전진·내보내기 순서가 전부 어긋난다.

이건 Conventions·AD-9·AD-13 **세 규칙을 모두 지킨 결과**다. 어느 단위도 위반하지 않았다.

두 번째 균열이 더 조용하다. "**밀리초**"가 "소수 자릿수 정확히 3"을 뜻하는지 적혀 있지 않다. `Date.prototype.toISOString()`은 항상 3자리를 내지만, 사람이 손으로 쓴 설정값, 다른 언어로 쓴 도구, `datetime('now')`류 SQL 기본값, Postgres 복제 adapter의 `to_char`는 **3자리를 보장하지 않는다.** `…T13:10:00Z`(0자리)와 `…T13:10:00.000Z`(3자리)가 섞이면 또 사전순이 깨진다(`:00Z` < `:00.`). 자리 하나 차이로 조회 결과가 조용히 틀리고, 어떤 계약 테스트도 자릿수를 보지 않는다.

**규칙(AD-13 조이기 + Conventions 조이기)**

> **AD-13 교체** — 저장 시각의 정규형은 **정확히 `YYYY-MM-DDTHH:MM:SS.sssZ` 24글자**다. 소수 자릿수는 항상 3이고, 오프셋 표기(`+09:00` 등)와 `Z` 생략은 허용하지 않는다. 변환은 Core의 `Instant` 코덱 한 곳에서만 한다(`parseInstant`/`formatInstant`). **Store port는 경계에서 이 형태가 아닌 값을 거부한다**(저장하지 않고 코드가 있는 실패를 돌려준다). 따라서 사전순 비교 = 시간순 비교가 전 테이블에서 성립하고, 범위 조회·정렬·anchor는 텍스트 비교만으로 정확하다.
>
> **AD-9 조이기** — spool 줄의 시각도 이 정규형(`…Z`)을 쓴다. "재주입 때 바꾸지 않는다"는 **순간(instant)을 바꾸지 않는다**는 뜻이며, 표현을 정규형으로 맞추는 것은 변경이 아니다. spool 줄을 읽을 때 정규형이 아니면 `Instant` 코덱으로 정규화하고 경고를 남긴다.
>
> **Conventions 조이기** — "JSON은 오프셋을 포함한 ISO-8601"은 **CLI `--json` 응답 봉투에만** 적용한다(사람·에이전트가 읽는 표시용). spool·내보내기·복제 payload처럼 **저장된 값을 실어 나르는 JSON은 저장 정규형(`…Z`)을 그대로 쓴다.** 계약 테스트: 24글자가 아닌 시각 문자열 10종(0·1·2·6자리 소수, 오프셋, 소문자 `z`, 공백 구분자, 윤초, 연도 5자리, 빈 문자열)을 Store가 전부 거부한다.

---

## High

### H-1. 미러 쓰기가 쓰기 트랜잭션 안에 있다 — `mirror-rebuild`가 모든 쓰기를 spool로 밀어낸다

**쌍:** U-mir(`admin.mirror-rebuild`) × U-ing·U-log

AD-16: "쓰기는 항상 전체 교체(임시 파일 → rename)이고, **세션 잠금(AD-7) 안에서** 한다. 증분 갱신과 `admin.mirror-rebuild`는 같은 함수를 쓴다." AD-7: 그 잠금은 이제 **DB 단위**다.

그래서 `mirror-rebuild`는 세션 N개의 파일 쓰기를 DB 단위 쓰기 잠금 안에서 한다. 파일 I/O 수백 번이 잠금 안에 들어간다. 그동안 모든 턴 수집과 모든 `log.append`가 시간 초과해 spool로 간다(AD-7·AD-9). 사용자가 띄운 유지 보수 명령 하나가 **몇 분 동안 기계 전체의 쓰기를 저하시키고**, 턴 수집 실패는 화면에 안 뜬다(AD-9).

게다가 이 규칙은 **얻는 것이 없다.** 미러는 "그 세션의 DB 상태만으로 정해지는 순수 함수"(AD-16)이므로 필요한 것은 **일관된 읽기**이고, WAL 읽기 스냅샷이 잠금 없이 그걸 준다. 그리고 rename은 트랜잭션에 참여하지 않으므로, rename 후 commit 전에 죽으면 미러가 DB보다 앞서는 상태가 어차피 생긴다. 잠금 안에 넣어서 막은 것이 아무것도 없다.

**규칙(AD-16 교체 + AD-7 추가)**

> **AD-7 추가** — **쓰기 트랜잭션 안에서 파일 시스템 쓰기와 네트워크 호출을 하지 않는다.** 트랜잭션 안에서 하는 일은 DB 읽기·쓰기뿐이다.
>
> **AD-16 교체** — 미러 쓰기는 **커밋 뒤에** 일어난다. 커밋하는 트랜잭션은 `sessions.mirror_version`(단조 증가 정수)만 올린다. 미러 쓰기 담당은 WAL 읽기 스냅샷에서 그 세션의 상태와 `mirror_version`을 읽어 파일을 만들고, 파일 frontmatter에 `mirror_version`을 적는다. **기존 파일의 `mirror_version`이 지금 쓰려는 값보다 크면 쓰지 않는다**(늦게 도착한 쓰기가 새 내용을 덮지 않는다). `admin.mirror-rebuild`는 세션을 하나씩 처리하고 쓰기 잠금을 쥐지 않으며, 일감은 `work_items`에서 세션 단위로 claim한다(AD-21). 실패는 `failures`에 남고 일감은 backoff로 재시도한다.
>
> **Table Contract `sessions` 조이기** — 단조 목록에 `mirror_version`을 넣는다.

---

### H-2. 꼬리표 계산의 출처가 셋이다 — 먼저 세션을 만든 쪽이 이기고, 꼬리표는 불변이라 고칠 수 없다

**쌍:** U-log(`log.append` → `sessions.ensure`) × U-ing(`sessions.ingest` → `sessions.ensure`)

AD-12: "꼬리표는 세션을 만드는 쪽이 cwd로부터 **한 번** 계산한다(시작 hook이면 hook 입력, **수집이면 transcript의 cwd**). 이후 사람이 하는 워크스페이스 지정 외에는 바뀌지 않는다." Table Contract `sessions`: 꼬리표는 **불변**.

AD-4의 hook 없는 Harness 대체 경로에서는 `brain log append --session <토큰>`이 세션 행을 처음 만든다. 그 프로세스가 아는 cwd는 **에이전트가 명령을 실행한 프로세스의 cwd**다 — 하위 폴더일 수도, 다른 worktree일 수도, 홈 디렉터리일 수도 있다. AD-12에는 "프로세스 cwd" 칸이 없다. 그래서 U-log는 세 가지 중 아무것이나 고를 수 있고 전부 AD-12를 어기지 않는다(hook도 수집도 아니므로 규정 밖이다).

이후 U-ing이 transcript의 cwd로 같은 세션을 수집한다. 권위 있는 출처(transcript)를 가졌는데 **꼬리표가 불변이므로 고칠 수 없다.** 조용히 틀린 꼬리표를 유지하거나, 불변 선언을 깨거나 둘 중 하나다.

증상은 조용하다. AD-15의 정렬이 근접 단계(워크트리 → 프로젝트 → 워크스페이스)로 되어 있으니 **엉뚱한 프로젝트로 분류된 세션은 검색 상위에서 사라진다.** 결과는 "없음"으로 성공한다. 어느 단위도 실패하지 않는다. 그리고 레이스다 — 같은 세션에서 `log.append`가 먼저 돌았는지 `ingest`가 먼저 돌았는지에 따라 같은 세션의 프로젝트가 달라진다.

**규칙(AD-12 조이기)**

> **AD-12 추가** — 꼬리표의 **권위 있는 출처는 그 세션 첫 메시지의 transcript cwd 하나**다. 출처 우선순위는 (1) transcript cwd, (2) 시작 hook 입력의 cwd, (3) 없음이다. **프로세스의 cwd는 꼬리표 출처가 아니다.** 권위 있는 출처가 없는 `sessions.ensure`는 꼬리표를 비워 둔(NULL) 세션 행을 만들고 `work_items`에 꼬리표 채우기 일감을 넣는다. 꼬리표의 유일한 변경은 **NULL → 값 한 번**(drain 또는 첫 수집이 권위 있는 출처로)과 사람의 워크스페이스 지정이다. 값이 들어간 뒤에는 바뀌지 않는다. 꼬리표가 비어 있는 세션은 AD-15 근접 정렬에서 "전체" 단계로 취급하고, 결과 출처에 꼬리표 미정을 표시한다. doctor는 꼬리표가 비어 있는 세션 수를 보인다.
>
> **Table Contract `sessions` 조이기** — 꼬리표를 "불변"에서 "**단조: NULL → 값 한 번**"으로 옮긴다.

---

### H-3. 아직 쓰고 있는 spool 파일을 다른 drain이 claim·삭제한다 — "프로세스별 파일"로 막히지 않는다

**쌍:** U-log(spool 쓰는 프로세스) × U-drn(spool 재주입)

AD-9: "spool은 **프로세스별 새 파일**(JSON Lines)이다. 파일을 공유해 append하지 않는다. drain은 파일을 `*.claiming`으로 rename한 뒤 재주입하고, 성공하면 지운다."

프로세스별 파일은 **동시 append 섞임**은 막지만 **생애 겹침**은 막지 못한다. 한 `brain` 프로세스는 생애 동안 spool에 여러 줄을 쓸 수 있다(로그 1건 + 실패 기록 + 주입 시도). 그 사이에 다른 프로세스의 drain이 그 파일을 claim할 수 있다. POSIX에서 rename은 열린 fd를 무효화하지 않으므로:

1. P1이 `spool/p1-abc.jsonl`을 열고 줄 1을 쓴다.
2. P2의 drain이 그 파일을 `*.claiming`으로 rename하고 전부 읽어 재주입한다.
3. P1이 같은 fd로 줄 2를 쓴다 — 이제 `*.claiming` inode에 들어간다.
4. P2가 성공했으므로 파일을 **지운다.** 줄 2가 사라진다.

지워진 것이 작업 로그 원문이면 **transcript로 복구할 수 없는 유일한 쓰기**(AD-9가 막겠다고 선언한 바로 그것)가 사라진다. `log.append`는 이미 `SPOOLED`와 함께 **성공**으로 답했다.

반대 방향 구멍도 있다: 프로세스가 중간에 죽으면 그 파일은 claim 가능하지만, 마지막 줄이 잘려 있을 수 있다. 잘린 줄의 처리가 정해져 있지 않다.

**규칙(AD-9 조이기)**

> **AD-9 교체(spool 파일 규율)** — spool 파일은 두 단계 이름을 갖는다. 쓰는 중에는 `<machine>-<pid>-<uuid>.jsonl.open`이고, 소유 프로세스가 **끝낼 때 `.jsonl`로 rename한다.** drain은 `*.jsonl`만 claim한다(`*.jsonl.open`은 건드리지 않는다). 프로세스는 자기 파일에만 쓰고, 한 줄을 쓸 때마다 `fsync`한다.
> - **버려진 `.open` 파일**: 수정 시각이 10분 넘게 지났고 그 pid가 살아 있지 않으면 drain이 `.jsonl`로 rename해 입양한다. 경고 `SPOOL_ADOPTED`를 남긴다.
> - **잘린 마지막 줄**: 파싱 실패한 줄은 버리지 않고 `<파일명>.bad`로 옮기고 `failures`에 올린다. 나머지 줄의 재주입은 계속한다.
> - 재주입은 줄 단위로 멱등하다(레코드의 UUIDv7이 멱등 키다). 전부 성공한 뒤에만 파일을 지운다.

---

### H-4. `index_configs.chunk_params`의 직렬화가 identity다 — 설정 행이 둘로 갈라지면 조각이 두 벌 생긴다. 게다가 "활성 색인"을 가리키는 곳이 없다

**쌍:** U-sq/`setup run`(epic 1) × `admin.reindex`(epic 5·6)

Table Contract `index_configs` 멱등 키는 `(kind, model, dimensions, chunk_params)`다. `chunk_params`는 구조값인데 UNIQUE는 **저장된 텍스트**로 판정한다. 두 단위가 각자 정당하게 직렬화한다.

- `setup run`: `{"target":1200,"overlap":1,"max":2400}`
- `admin.reindex`: `{"max":2400,"overlap":1,"target":1200}`

같은 파라미터, 다른 텍스트 → **행 둘.** 그러면 `chunks`의 멱등 키 `(session_id, index_config_id, seq_from, seq_to)`가 두 벌을 허용하므로 **모든 세션의 조각이 두 배로 생긴다.** 그리고 AD-15가 명시적으로 막겠다고 한 "**색인 설정이 섞인 검색**"이 그대로 일어난다. 숫자 표기(`1200` vs `1200.0`), 공백, 키 추가 순서 전부 같은 결과를 낸다.

두 번째 구멍: **지금 어느 `index_config_id`가 활성인지 적는 자리가 없다.** `index_configs`에 `active` 칸이 없고, 가리키는 단일 행 테이블도 없다. AD-15는 "사용 중인 색인 설정은 DB에 기록하고, 설정 파일과 다르면 `INDEX_CONFIG_MISMATCH`"라고만 쓴다 — *기록한다*고 했지 *어디에*라고 하지 않았다. 그래서 U-idx는 "가장 최근 행"을, 검색 단위는 "설정 파일과 맞는 행"을 쓸 수 있고, `admin.reindex` 도중(AD-15: "교체 전까지는 옛 테이블로 검색한다")에는 둘이 서로 다른 행을 가리킨다.

**규칙(AD-15 조이기 + Conventions 추가)**

> **Conventions 추가(정규 JSON)** — DB에 저장되고 **멱등 키에 들어가는 JSON**(`index_configs.chunk_params`, `work_items.payload`)은 Core의 `canonicalJson` 함수 하나가 만든다: 키 사전순 정렬, 공백 없음, 정수는 소수점 없이, 실수는 최단 왕복 표기, `null` 필드 생략. 비교·해시는 이 형태로만 한다.
>
> **AD-15 추가** — `kind`마다 **활성 색인 설정이 정확히 하나**다. 활성 여부는 `index_configs.active_from`·`active_to`(UTC ISO-8601 텍스트, `active_to IS NULL`이 활성)로 적고, 쓰는 것은 `setup run`과 `admin.reindex`뿐이다. **모든 검색 경로는 활성 설정 id로 필터한다.** `admin.reindex`는 새 설정 행을 만들고 조각·색인을 모두 만든 뒤 **한 트랜잭션에서** 옛 행의 `active_to`와 새 행의 `active_from`을 설정한다. 계약 테스트: 같은 파라미터로 `setup run`을 두 번 돌리면 `index_configs` 행이 하나이고, `kind`마다 활성 행이 항상 정확히 하나다.

---

### H-5. 키워드 질의의 해석자가 단위마다 다르다 — 같은 질의가 경로마다 다른 결과를 내고, FTS5 구문이 든 질의는 오류가 된다

**쌍:** U-idx 검색 경로 셋(`recall.chunks` / `recall.logs` / `recall.tools`)

AD-15는 색인 **대상 컬럼**과 3글자 경계만 정하고 **질의 해석**을 정하지 않는다. 그래서 세 경로가 각자 정당하게 다르게 만든다.

| 질의 | `recall.chunks` (구(phrase) 해석) | `recall.logs` (토큰 AND 해석) |
| --- | --- | --- |
| `저장소 방향` | "저장소 방향"이 연속으로 나오는 것 | 둘 다 포함하는 것 |
| `a 결정` (1글자 토큰 섞임) | 전체가 3글자 이상 → MATCH | 토큰 하나가 3글자 미만 → 전체 LIKE? 토큰만 LIKE? |
| `sk-live:*` | **FTS5 구문 오류**(`:`·`*`는 연산자) | 이스케이프했으면 통과 |

AD-15의 **결과 계약**(출처·`seq_from`·`seq_to`·`chunk_id`)은 세 경로의 결과를 똑같이 생긴 것으로 포장한다. 그래서 다르다는 사실이 호출자에게 드러나지 않는다. 에이전트가 AD-17의 안내("못 찾으면 질의를 바꿔 다시 찾는다")를 따라 질의를 바꿀 때, 경로마다 다른 규칙과 싸운다.

그리고 사용자 질의에 `"`·`*`·`-`·`:`·`NEAR`가 들어가는 일은 흔하다(에러 메시지, 파일 경로, 토큰 접두사 검색). 이스케이프 규칙이 없으면 `recall`이 **오류로 끝난다.**

**규칙(AD-15 추가)**

> **AD-15 추가(질의 해석)** — 키워드 질의 해석은 Core의 `buildKeywordQuery` 한 곳이 한다. 모든 검색 경로(`recall.chunks`·`recall.logs`·`recall.tools`)가 같은 함수를 쓴다.
> - 입력을 NFC 정규화하고 공백으로 토큰을 나눈다. **사용자 입력의 FTS5 연산자는 전부 문자 그대로 취급한다**(각 토큰을 FTS5 문자열 리터럴로 따옴표 처리하고 내부 `"`는 두 번 쓴다).
> - 3코드포인트 이상 토큰은 FTS5 trigram MATCH로, 3코드포인트 미만 토큰은 그 토큰만 `LIKE '%…%'`로 보낸다. 질의 전체가 아니라 **토큰 단위**로 갈린다.
> - 토큰 사이는 **AND**다(부분 문자열 일치, 순서 무관). 구(phrase) 검색이 필요하면 호출자가 따옴표로 감싼 입력을 주고, 그때만 연속 일치로 바꾼다.
> - 계약 테스트: `"`·`*`·`-`·`:`·`NEAR`·빈 질의·한영 혼합·1글자 토큰·2글자 토큰·3글자 토큰 조합이 세 경로에서 같은 집합을 내고 오류가 없다.

---

### H-6. 복제 adapter가 값을 생성할 수 있다 — `recorded_at`의 뜻이 둘이 되고 uuid·collation이 갈라진다

**쌍:** U-sq(원본) × U-pg(epic 7 복제)

AD-10: "복제 대상은 원본을 커서로 따라온다. 복제 대상은 원본이 될 수 없다. Store port의 모든 구현(sqlite, postgres)은 하나의 공통 계약 테스트를 통과한다." AD-1: "현재 시각과 ID 생성도 Core의 port(`Clock`, `IdGen`)이고 Runtime이 구현을 넣는다."

이 두 문장이 **복제 adapter가 값을 만들어도 된다**는 해석을 허용한다. AD-13은 `recorded_at`을 "**DB에 들어간 시각**"으로 정의한다. Postgres 복제 adapter에서 "DB에 들어간 시각"은 **복제된 시각**이다. 그래서 `recorded_at DEFAULT now()`가 AD-13을 글자 그대로 지킨 구현이다. 결과: 같은 행의 `recorded_at`이 원본과 복제에서 다르고, 복제 커서나 "최근" 조회가 그 컬럼을 쓰면 두 저장소가 다른 답을 낸다. 어느 것이 맞는지 spine이 말하지 않는다.

같은 계열의 갈라짐 셋:

- **타입**: `id`를 Postgres `uuid` 열로 두는 것이 자연스럽고 AD를 어기지 않는다. 그러면 TEXT 비교·`LIKE`·내보내기 JSON Lines의 표현이 두 저장소에서 달라진다(대문자 수용, 하이픈 없는 형태 수용).
- **Collation**: SQLite TEXT는 기본 BINARY(대소문자 구분)이고, Postgres는 데이터베이스 collation을 따른다. ICU 대소문자 무시 collation을 쓰면 `projects.remote_identity`의 UNIQUE가 **원본보다 좁아진다.** AD-12는 host만 소문자로 만들므로 `github.com/Acme/repo`와 `github.com/acme/repo`는 원본에서 두 행, 복제에서 한 행이 된다. 행 대 행으로 따라가는 복제가 깨진다.
- **Bool·JSON**: `node:sqlite`는 bool을 0/1 정수로 돌려주고 Postgres는 `boolean`을, JSON은 파싱된 객체로 돌려준다. 공통 계약 테스트가 드라이버 값으로 단정하면 한쪽에서만 통과한다.

**규칙(새 AD-22)**

> ### AD-22 — 원본이 값을 정하고, 복제 대상은 표현만 맞춘다
>
> - **Binds:** FR-1, NFR-9, AD-10
> - **Prevents:** 같은 컬럼이 원본과 복제에서 다른 뜻을 갖는 것, 타입·collation 차이로 복제가 행 대 행 대응을 잃는 것, 공통 계약 테스트가 드라이버 차이를 못 잡는 것
> - **Rule:**
>   - **파생이 아닌 모든 컬럼 값은 원본이 정한다.** 복제 adapter는 값을 생성하지 않는다 — ID, `seq`, `ordinal`, `recorded_at`, 어떤 DB 기본값도 포함한다. 복제 adapter의 스키마에는 `DEFAULT`와 트리거 기반 값 채움을 두지 않는다.
>   - `recorded_at`은 **원본에 들어간 시각**이며 복제에 그대로 복사한다. 복제 도착 시각이 필요하면 복제 대상만 갖는 별도 컬럼(`replicated_at`)에 둔다. 복제 커서는 `replicated_at`을 쓰지 않는다.
>   - Store port는 Core가 선언한 스칼라 타입(`Instant`, `Uuid`, `Bool`, `Json`, `Text`)으로만 주고받고, 각 adapter가 자기 코덱으로 변환한다. 공통 계약 테스트는 **코덱을 통과한 값**으로 단정하고 드라이버 원시값으로 단정하지 않는다.
>   - 식별·멱등 키에 들어가는 텍스트 컬럼은 **NFC 정규화된 UTF-8이고 바이트 단위로 비교한다.** 모든 adapter는 그 컬럼에 이진 collation을 선언한다(SQLite `COLLATE BINARY`, Postgres `COLLATE "C"`). 계약 테스트: 대소문자만 다른 키 2개와 NFC/NFD만 다른 키 2개가 **각각 서로 다른 행**이 된다.
>   - `[[replicas]]` 설정이 붙는 epic 7에서 이 조항을 복제 계약 테스트로 고정한다.

---

### H-7. hook 없는 Harness에서는 drain을 부르는 사람이 doctor뿐이다 — spool이 무한히 대기한다

**쌍:** U-log(`log.append` → spool) × AD-7의 drain 호출자 목록

AD-7: "호출자는 시작 hook(async)과 `brain admin doctor`다." AD-4의 대체 경로 표에는 hook 없는 Harness가 정식 지원 대상으로 들어 있다. 그 조합에서는 **시작 hook이 없으므로 drain을 부르는 것은 doctor뿐이다.**

그래서 hook 없는 Harness로 작업하는 동안 `log.append`가 잠금 시간 초과로 spool에 간 로그는(AD-9에 따라 `SPOOLED`와 함께 **성공**으로 답했다) 사용자가 doctor를 띄울 때까지 DB에 들어가지 않는다. 그 사이의 `recall.logs`에는 안 나오고, 시작 맥락의 "최근 작업 로그"에도 안 나온다. **데이터는 안 잃었지만 조회에서 사라져 있다.** 사용자가 doctor를 띄울 이유는 아무것도 없다 — 모든 명령이 성공으로 답했으므로.

**규칙(AD-7 조이기)**

> **AD-7 교체(drain 호출자)** — drain 호출자는 셋이다: 시작 hook(async), `brain admin doctor`, 그리고 **모든 `brain` 명령의 기회적(opportunistic) drain**이다. 기회적 drain은 명령이 할 일을 끝낸 뒤 (a) DB에 쓸 수 있고 (b) spool에 `*.jsonl` 파일이 있거나 `work_items`에 만기된 일감이 있을 때만 돌고, 동기 경로(시작 hook)에서는 돌지 않으며, **시간 예산 안에서 멈춘다**(기본 2s, 설정값). 남은 일은 다음 호출이 이어받는다. `log.append`와 `recall`의 증분 수집 단계는 그 세션 몫의 spool 재주입을 먼저 한다. doctor는 "가장 오래된 미처리 spool 레코드의 나이"를 보이고, 설정한 기간(기본 1시간)을 넘으면 경고한다.

---

### H-8. `failures.fingerprint`의 정의가 누구 것도 아니다 — 중복 폭발 또는 재시도 영구 묵살

**쌍:** U-ing(수집 실패 기록) × U-drn(미러·조각 실패 기록)

Table Contract `failures` 멱등 키는 `(harness, harness_session_id, stage, fingerprint)`이고 작성자는 "모든 경로(실패 기록 함수 하나)"다. **`fingerprint`가 무엇인지는 적혀 있지 않다.** 함수가 하나라도 인자는 호출자가 만든다.

- U-ing이 `fingerprint = hash(error.message)`로 잡으면 → 메시지에 시각·경로·행 번호가 들어가므로 같은 원인이 **매번 새 행**이 된다. 턴마다 수집하는 환경에서 `failures`가 수천 행으로 불고, doctor가 쓸 수 없게 되고, drain은 같은 일을 계속 재시도한다.
- U-drn이 `fingerprint = hash(stage)`로 잡으면 → 같은 stage의 **서로 다른 원인이 한 행으로 합쳐진다.** 그 행의 `resolved_at`을 한 번 채우면 아직 안 고쳐진 다른 원인이 "해결됨"이 된다. `sessions.failures`·`sessions.retry`(FR-15)가 거짓을 보인다.

그리고 재시도 횟수를 셀 칸이 없다(그건 AD-21의 `work_items`로 간다).

**규칙(Table Contract + AD-21 연결)**

> **Table Contract `failures` 조이기** — `fingerprint`는 Core의 함수 하나가 만든다: `hash(stage, 안정된 입력 식별자, 오류 분류 코드)`. **오류 메시지 문자열·시각·경로·스택은 들어가지 않는다**(그것들은 `last_error` 칸에 사람이 읽을 용도로 따로 남긴다). "안정된 입력 식별자"는 stage마다 Core가 정한다(수집: `harness_message_id` 또는 커서 지점, 미러: `session_id`, 조각: `(session_id, seq_from, seq_to)`). 재시도 횟수와 backoff는 `failures`가 아니라 `work_items`가 갖는다(AD-21). 계약 테스트: 같은 원인 100회가 `failures` 1행이고, 다른 분류 코드의 실패는 별도 행이다.

---

## Medium

### M-1. 미러 grep이 AD-10의 "읽기·검색은 원본에서만"과 정면으로 부딪친다

AD-10은 "읽기·검색은 원본에서만 한다"고 못 박는데, **spine의 배치도 자체**에 `agent -. "grep" .-> mirror`가 있고 memlog의 미러 용도 첫 줄이 "아무 에이전트 grep"이다. 그래서 두 단위가 같은 질문에 다른 답을 낸다: `recall`은 활성 색인·근접 정렬·결과 계약·`RESULT_TRUNCATED`를 지키고, grep은 아무것도 지키지 않으며 출처(`chunk_id`·`seq_from`)도 없어서 `recall.expand`로 넘길 수 없다. C-3을 생각하면 더 나쁘다 — 미러 파일은 **가리기 연쇄의 마지막 단계**라서 가린 직후 짧게 비밀을 들고 있다.

**규칙:** AD-16에 한 줄 — "미러는 사람이 읽고 Brain 밖 도구가 보조로 훑는 파생물이다. **Brain의 어떤 명령도 미러를 읽지 않으며, 시작 맥락 안내(AD-17)는 미러 grep을 조회 수단으로 권하지 않는다.** 미러에서 찾은 것은 출처 계약(AD-15)을 갖지 않으므로 `recall.expand`의 입력이 될 수 없다."

### M-2. `admin.import`의 병합 의미가 없다

Conventions는 "복구는 의존 순서대로 insert하고, 파생 테이블은 다시 만든다"까지만 쓴다. 비어 있지 않은 DB로 import하면 멱등 키 충돌이 난다. `INSERT OR IGNORE`면 더 새로운 `log.edit` 결과가 조용히 묻히고, 실패면 부분 복구가 남는다. `messages`·`tool_notes`에는 UPDATE 거부 trigger가 있어 손으로 수선할 수도 없다.

**규칙:** AD-20에 한 줄 — "`admin.import`는 **비어 있고 같은 `schema_version`인 DB 파일**만 받는다. 그 외에는 아무것도 쓰지 않고 코드가 있는 실패를 돌려준다. 기존 DB로 합치는 것(merge)은 slice 1 범위 밖이다(Deferred)."

### M-3. 긴 읽기 스냅샷이 WAL을 키운다

`admin.export`는 "한 스냅샷 트랜잭션"(Conventions) 안에서 테이블 전부를 훑는다. WAL에서 긴 읽기 트랜잭션은 체크포인트가 WAL을 줄이지 못하게 막는다. 큰 DB에서는 export 동안 WAL이 DB 파일 크기만큼 자랄 수 있고, doctor에 그걸 보는 항목이 없다.

**규칙:** AD-20에 한 줄 — "doctor는 WAL 파일 크기를 보이고 DB 파일의 설정 배수(기본 2배)를 넘으면 경고한다. `admin.export`는 읽기 스냅샷을 쓰고(쓰기를 막지 않는다) 끝난 뒤 `wal_checkpoint(TRUNCATE)`를 시도한다."

### M-4. `brain.db` 옆 파일들이 "원본 파일 하나"에 포함되는지 적혀 있지 않다

AD-10은 원본을 "SQLite 파일 하나"로 쓰지만 WAL 모드는 `brain.db-wal`·`brain.db-shm`을 만든다. AD-20의 `setup uninstall`과 백업·복사 경로가 세 파일을 한 묶음으로 다루지 않으면 복사한 DB가 최근 쓰기를 잃는다. "동기화 폴더에 두지 않는다"(AD-10)의 이유도 사실은 이 세 파일이다.

**규칙:** AD-10에 한 줄 — "원본은 `brain.db`와 그 sidecar(`-wal`, `-shm`)로 이루어진다. 복사·이동·삭제는 세 파일을 한 묶음으로 다루고, 복사 전에는 `wal_checkpoint(TRUNCATE)`를 하거나 `VACUUM INTO`로 단일 파일 사본을 만든다. `setup uninstall`의 데이터 확인 대상은 세 파일 전부다."

---

## 이미 닫혀 있어 공격이 실패한 곳

적대적 쌍을 만들려다 규칙이 이미 막은 자리 — 개정이 잘된 부분이다.

- **원본 둘**: AD-10의 "복제 대상은 원본이 될 수 없다 / 읽기·검색은 원본에서만"이 승격 경로를 아예 없앴다. 복제 adapter가 원본 역할을 하는 쌍을 만들 수 없다.
- **세션 행 두 개**: AD-12의 `sessions.ensure` 단일 생성자 + 멱등 키 + "세션 키를 모르는 쓰기는 행을 만들지 않고 spool로 간다"가 막는다.
- **규칙이 되살아나기**: AD-14의 `pending|on|off`와 "`off`는 사람만"이 drain의 되살림을 막는다.
- **로그 작성자**: AD-14의 "로그는 `log.append`만 만든다. hook·수집·drain은 로그 행을 만들지 않는다"가 쓰기 API를 둘로 유지한다.
- **설정 읽는 곳 둘**: AD-18의 코덱 단일화에 설치기까지 포함돼 있다.
- **마이그레이션 실행자 둘**: AD-20의 "`setup run`과 `setup upgrade`만" + 런타임의 `SCHEMA_MISMATCH` → spool이 막는다.
- **Harness 설정 이중 등록**: AD-19의 `setup.connect` 단일 작성자 + Brain 표식 판정이 막는다.
- **인용 대조 단위**: AD-14의 NFC + 코드 포인트 `[start, end)`가 이미 글자 단위를 고정했다(예전 C-5의 수정이 유지됐다).

---

## 적용 순서

구멍들이 서로 물려 있다. 아래 순서로 닫는 것이 재작업이 가장 적다.

1. **C-5(시각 정규형) → C-2(`seq` 주인)**: 둘 다 Store port 경계의 타입 계약이다. 함께 고치면 `Instant`·`Uuid`·`seq` 코덱이 한 번에 선다. story 1.10(SQLite adapter) **착수 전**이어야 한다 — 첫 마이그레이션이 여기에 걸린다.
2. **C-4(AD-21 `work_items`)**: 첫 마이그레이션에 테이블이 들어가야 한다. C-3·H-1·H-2가 전부 이 대기열에 일감을 넣는다.
3. **C-3(가리기 연쇄)**: 첫 마이그레이션의 trigger·FTS5 설계가 여기에 걸린다. AD-5 표면에 `tool-notes redact`가 늘어난다.
4. **C-1(동기 경로 읽기 전용) + H-1(미러는 커밋 뒤) + H-7(기회적 drain)**: 잠금 모델 전파. epic 2 착수 전.
5. **H-2(꼬리표 출처) + H-8(fingerprint)**: epic 2 안에서. Table Contract 두 행 수정.
6. **H-4(정규 JSON·활성 색인) + H-5(질의 해석기)**: epic 4 착수 전.
7. **H-6(AD-22 원본·복제 표현)**: 지금 적어 두되 계약 테스트는 epic 7에서 돈다. 다만 **"복제 adapter는 값을 생성하지 않는다"는 지금 적어야 한다** — `packages/postgres`가 이미 있고 계약 테스트가 계속 돌기 때문이다.
8. Medium 4건: epic 5 착수 전.

**새로 생기는 AD:** AD-21(일감 대기열), AD-22(원본·복제 표현 계약).
**다시 쓰는 AD:** AD-4, AD-6, AD-7, AD-9, AD-11, AD-12, AD-13, AD-15, AD-16, AD-20.
**Table Contract:** `work_items` 행 추가, `sessions`(꼬리표 단조·`mirror_version`)·`failures`(fingerprint 정의)·`index_configs`(`active_from`/`active_to`) 수정.
**Conventions:** 시각 정규형 24글자, 정규 JSON, 저장 JSON vs 응답 JSON 구분, 이진 collation.
**AD-5 표면:** `messages` ns에 도구 메모 가리기 추가.
