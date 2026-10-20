---
type: change-proposal
title: "메시지 번호(seq) 삭제 — 대화 순서는 발화 시각 하나"
date: 2026-10-20
status: approved
approved: 2026-10-20 (사용자 "진행")
mode: batch
scope: moderate
trigger: "epic-capture story 21 (수집 경로 보강) 리뷰"
---

# 메시지 번호(`seq`) 삭제 — 대화 순서는 발화 시각 하나

## 1. Issue Summary

**문제.** `messages.seq`가 두 가지 일을 맡고 있다. 하나는 메시지의 주소이고(조각 범위·로그 연결·복제), 다른 하나는 읽는 순서다. 둘은 서로 다른 것을 요구한다. 주소는 바뀌면 안 되고, 순서는 늦게 들어온 메시지가 제자리로 가야 한다. parser 버전이 올라 대화 중간의 메시지가 나중 배치로 들어오면, 그 메시지는 `max(seq)+1`을 받아 대화 끝에 놓인다(2.7 follow-up 리뷰 #10).

**발견 경위.** 2026-10-20에 story 21의 무인 빌드가 #10을 "대화 순서 읽기 = `occurred_at`, 같으면 `seq`"(같은 날 사용자 결정)로 구현했다. 리뷰는 이것이 연구 실측과 충돌한다고 지적했다. `epic-capture/epic-capture-research.md` '시각'에는 "앞 줄보다 시각이 이른 줄이 흔하다. 파일 524개 중 521개"라고 적혀 있다. 빌드는 이를 intent gap으로 보고 멈췄다(story 21 `blocked`, 시도한 변경은 patch로 보존).

**증거.** 같은 날 다시 쟀다. 대상은 이 Mac의 transcript 228개이고, 현재 parser(v3)로 읽어 **parser가 남기는 메시지만** 셌다.

| 항목 | 값 |
|---|---|
| 메시지가 둘 이상인 세션 | 221 |
| 붙어 있는 메시지 쌍 | 6,818 |
| 뒤 메시지의 시각이 더 이른 쌍 | **0** |
| 같은 밀리초인 쌍 | **0** |

연구 문서의 "521/524"는 파일의 **모든 줄**을 센 숫자다. 시각이 거꾸로 간 줄은 파일 스냅샷·메타 줄처럼 parser가 버리는 줄이었다. 따라서 대화 순서는 `occurred_at` 하나로 충분하고, `seq`는 순서로도 주소로도 필요하지 않다.

**사용자 결정(2026-10-20).** `seq`를 지운다. 대신할 새 칸이나 키는 만들지 않는다. 순서가 필요한 곳은 이미 있는 `occurred_at`을 쓰고, 같은 시각의 순서까지 정할 필요는 없다. 결정 사항은 다음과 같다.
- D1: 조각 범위는 첫·끝 메시지의 시각(`from_at`·`to_at`)으로 둔다.
- D2: 로그–메시지 연결을 저장하지 않는다(칸과 drain 일감 삭제).
- D3: 새 스토리 24를 21 앞에 둔다.
- D4: Postgres는 epic 7의 뒤처짐 항목으로 넘긴다.

## 2. Impact Analysis

**Epic.**
- **epic-capture(진행 중):** 계획대로 끝낼 수 있다. 스토리 24를 더하고 21의 범위를 줄인다. Done when 2·7의 `seq` 문구를 바꾼다.
- **epic-log-and-context(3):** 인셉션 전이다. 로그 연결 칸과 일감이 사라져 범위가 줄어든다. Done when 3의 문구를 바꾼다.
- **epic-recall-and-mirror(4):** 인셉션 전이다. 조각 범위와 결과 계약이 시각으로 바뀐다. Notes D7의 문구를 바꾼다.
- **epic-replicas(7):** 복제할 값에서 `seq`가 빠진다. Postgres 스키마의 뒤처짐 항목에 0006을 더한다.
- **그 밖의 에픽:** 영향이 없다.

**Story.**
- 새 스토리 24를 만든다.
- 21의 description·verify·after를 바꾼다.
- 15의 after에 24를 더한다.
- 완료된 2·7·19의 verify에 있는 `seq` 문구는 그때의 기록이므로 고치지 않는다.

**문서 충돌.**
- **PRD 본문·spec:** `seq`를 쓰지 않는다. "순서대로 읽는다"(FR-1·FR-15)와 "앞뒤 메시지"(FR-8·CAP-3)는 시각으로 그대로 충족된다. MVP에는 영향이 없다.
- **PRD addendum §스키마 스케치:** `seq`·`message_seq*`를 쓰고 있어 바꾼다.
- **spine:** AD-4·7·8·11·14·15·22와 Table Contract를 바꾼다.
- **UX 문서:** 없다.

**기술 영향.**
- **SQLite 마이그레이션 0006**
  - `messages`를 재생성한다. `seq`와 `unique (session_id, seq)`를 빼고, 불변 trigger를 교체한다. `redactions`·`message_attachments`의 FK는 유지한다.
  - `chunks`를 재생성한다(`seq_from`·`seq_to` → `from_at`·`to_at`, 키 교체). 행이 없다.
  - `log_entries`에서 두 칸을 지운다. 행이 없다.
  - `SQLITE_SCHEMA_VERSION`을 6으로 올린다.
- **Store**
  - 번호 붙이기(`max(seq)+1`)를 없앤다.
  - `readSession`은 `occurred_at` 순서로 읽고, 도구 메모는 그 메시지의 `occurred_at`, 그다음 `ordinal` 순서로 읽는다.
  - 커서의 전진 비교는 커서 메시지의 `occurred_at`으로 한다.
- **Core 도메인 타입:** `Message.seq`, `Chunk.seqFrom/seqTo`, `LogEntry.anchorSeq/joinedUptoSeq`를 지운다.
- **그 밖:** 테스트 약 15개 파일, `tooling/dev/tracer-session.sh`, README를 고친다.
- **Postgres 0001의 같은 칸:** 지금은 두고 epic 7이 맞춘다.
- **사용자 DB:** 실제 수집은 story 14에서 켜지므로 v5 DB는 개발용뿐이다. 0006은 기존 메시지 행을 보존하며 올린다.

## 3. Recommended Approach

**Direct Adjustment(Option 1)** — 기존 에픽 안에서 스토리 하나를 더하고 문서를 고친다.

- **이유:**
  - `seq`를 실제로 쓰는 코드는 수집 경로뿐이다.
  - `log_entries`·`chunks`는 아직 쓰는 코드가 없다.
  - epic 3·4·7은 인셉션 전이다. 지금이 가장 싸게 바꿀 수 있는 때다.
  - 지우면 로그 연결 일감과 "늦게 온 메시지를 다시 잇는" 규칙이 함께 사라져 앞으로의 작업도 줄어든다.
- **Rollback(Option 2):** 필요 없다. 되돌릴 완료 작업이 없다(21은 이미 기준으로 되돌려져 있다).
- **MVP Review(Option 3):** 필요 없다. 요구가 바뀌지 않는다.
- **노력:** 중간(스토리 하나, 마이그레이션 재생성 둘).
- **위험:** 중간.
  - 시각 순서가 깨지는 transcript가 앞으로 생길 수 있다. 실측은 이 Mac 한 대, parser v3 기준이다.
  - 22·23에서 parser가 남기는 줄의 종류가 늘면 다시 잰다(24의 verify에 측정을 넣는다).
- **일정 영향:** epic 2에 스토리 하나가 더해진다. 21은 그만큼 작아진다.

## 4. Detailed Change Proposals

### 4.1 Stories (`epic-capture/tickets.toml`, `bmad-ticket`으로 적용)

**새 스토리 24** — 파일에서 21 앞에 둔다.

```toml
[[entry]]
id = 24
type = "story"
title = "seq 삭제: 마이그레이션 0006과 시각 순서"
description = "메시지 번호를 없앤다(2026-10-20 사용자, change-drop-message-seq). SQLite 마이그레이션 0006이 `messages.seq`와 `unique (session_id, seq)`를 지우고(재생성, 불변 trigger 교체, FK 유지), `log_entries.anchor_seq`·`joined_upto_seq`를 지우고, `chunks`의 범위를 `seq_from`·`seq_to`에서 첫·끝 메시지 시각 `from_at`·`to_at`으로 바꾼다(키 `(session_id, index_config_id, from_at, to_at)`). `SQLITE_SCHEMA_VERSION`은 6이다. Store는 번호를 붙이지 않고, 메시지 정체는 `(session_id, harness_message_id)`뿐이다. 대화 순서로 돌려주는 읽기는 `occurred_at` 순서이고 같은 시각의 순서는 정하지 않는다. 도구 메모는 그 메시지의 `occurred_at`, 그다음 `ordinal` 순서다. 커서의 전진 비교는 커서 메시지의 `occurred_at`으로 한다. Core 도메인 타입의 `seq`·`seqFrom`·`seqTo`·`anchorSeq`·`joinedUptoSeq`를 지운다. Postgres 스키마는 바꾸지 않고 deferred-work의 Postgres 뒤처짐 항목에 0006을 더한다(epic 7). README의 순서 문단과 parser·port 주석을 시각 순서로 고친다."
verify = "v5 DB를 `setup run`으로 올리면 버전 6이고 메시지·도구 메모 건수와 본문이 그대로이며 `messages`에 `seq` 칸이 없고, 같은 transcript를 두 번 또는 동시에 넣어도 모든 테이블의 건수가 같으며, 저장된 세션에 대화 중간 시각의 메시지가 나중 배치로 들어와도 `sessions` 읽기에서 제자리에 놓이고, 겹친 수집의 짧은 쪽이 나중에 커밋돼도 커서가 뒤로 가지 않으며, 이 Mac transcript를 현재 parser로 읽어 남는 메시지의 시각 역전·같은 밀리초 쌍 수를 plan에 남긴다."
covers = ["E2-5", "E2-11"]
after = [18]
hitl = false
risk = "high"
references = ["_bmad-output/personal-brain/change-drop-message-seq/change-drop-message-seq.md, §1·§4", "_bmad-output/personal-brain/epic-capture/story-0005-plan.md, 재생성 방식"]
```

**Story 21** — description

OLD:
> 겹친 reset 읽기가 커서를 뒤로 돌리지 않는다. 메시지를 대화 순서로 돌려주는 읽기는 `occurred_at` 순서로, 같으면 `seq` 순서로 정렬한다. 그래서 버전 업으로 대화 중간에 더해진 메시지는 `seq`가 맨 뒤여도 제자리에 읽힌다(`seq`는 지금처럼 Store가 붙인 순서로 남는다, 2026-10-20 사용자). `start_source`는

NEW:
> 겹친 reset 읽기가 커서를 뒤로 돌리지 않는다(커서 비교는 24의 시각 비교를 쓴다). `start_source`는

verify

OLD:
> reset 읽기 둘이 겹쳐도 커서가 뒤로 가지 않고, 저장된 상태를 심어 대화 중간에 더해진 보고가 `seq`는 맨 뒤인 채로 읽기에서는 제자리에 놓이며, startup으로

NEW:
> reset 읽기 둘이 겹쳐도 커서가 뒤로 가지 않고, startup으로

after: `[18]` → `[24]`. references에 더한다: `"_bmad-output/personal-brain/epic-capture/story-start-source-transcript-plan-attempt-1.patch, 시도한 변경(정렬 부분 제외하고 재사용)"`.

title: "수집 경로 보강: 커서 경고·대화 순서·start_source·큰 transcript" → "수집 경로 보강: 커서 경고·start_source·큰 transcript"

**Story 15** — after에 `24`를 더한다.

**Story 21의 이전 plan과 patch.** 지금 plan(`story-start-source-transcript-plan.md`, `blocked`)을 그대로 두면 다음 빌드가 "blocked plan supplied"로 멈추고, 옛 intent(시각+`seq` 정렬)를 이어받는다. 그래서 두 파일을 `story-start-source-transcript-plan-attempt-1.md`·`.patch`로 이름을 바꿔 기록으로 커밋한다. 다음 빌드가 새 plan을 만든다.

### 4.2 Epic 문서

**`epic-capture/epic-capture.md`**

- Description(17행)
  - OLD: "`seq`는 원본 Store가 배정(AD-4·8),"
  - NEW: "메시지에는 번호가 없고 대화 순서는 `occurred_at`(AD-8, 24, 2026-10-20),"
- Description(23행)
  - OLD: "메시지 ID는 처음 만든 프로세스가 정한 UUIDv7(같은 seq·다른 harness id는 seq를 Store가 배정하므로 생기지 않는다 — 2026-10-15 인셉션)"
  - NEW: "메시지 ID는 처음 만든 프로세스가 정한 UUIDv7(2026-10-15 인셉션)"
- E2-5(44행)
  - OLD: "세션 행은 수집만 만들고 `seq`는 Store가 배정, 멱등 삽입, 같은 세션의 겹친 수집, `ingest_source`(live·import), 대화 순서 읽기는 `occurred_at`, 같으면 `seq` 순서(21, 2026-10-20)."
  - NEW: "세션 행은 수집만 만들고, 멱등 삽입, 같은 세션의 겹친 수집, `ingest_source`(live·import), 대화 순서 읽기는 `occurred_at`(메시지 번호 없음, 24, 2026-10-20)."
- Requirements에 새 줄을 더한다:
  - "E2-11 (CAP-1, CAP-3·CAP-4 스키마 자리): 마이그레이션 0006 — `messages.seq` 삭제, `log_entries.anchor_seq`·`joined_upto_seq` 삭제, `chunks` 범위를 `from_at`·`to_at`으로(24, 2026-10-20). Postgres는 epic 7. (AD-8·14·15, Table Contract)"
- Done when 2
  - OLD: "같은 세션의 Stop hook이 겹쳐도 seq 충돌이 없다."
  - NEW: "같은 세션의 Stop hook이 겹쳐도 메시지가 겹치거나 빠지지 않는다."
- Done when 7
  - OLD: "compact 뒤 다시 수집해도 기존 메시지의 `seq`와 본문이 그대로다."
  - NEW: "compact 뒤 다시 수집해도 기존 메시지의 본문과 건수가 그대로다."
- Boundaries
  - OLD: "0005(18)"
  - NEW: "0005(18)·0006(24)"
- Notes에 더한다:
  - "Decision(2026-10-20, 사용자, `../change-drop-message-seq/`): 메시지 번호 `seq`를 지운다. 대화 순서는 `occurred_at` 하나이고 같은 시각의 순서는 정하지 않는다. 대신할 칸·키는 만들지 않는다. 같은 날의 '읽기는 `occurred_at`, 같으면 `seq`' 결정을 대체한다. 근거: parser가 남기는 메시지 6,818쌍에서 시각 역전 0, 같은 밀리초 0(연구 문서의 524개 중 521개는 버리는 줄까지 센 수). 24가 0006과 Store를 맡고 21 앞에 선다. 21은 #10(읽기 정렬)을 24에 넘긴다."

**`epic-log-and-context/epic-log-and-context.md`** — Done when 3

- OLD: "둘 다 근거 메시지 위치(`anchor_seq`)를 가진다."
- NEW: "둘 다 자기 시각(`occurred_at`)으로 대화 속 자리를 가진다(메시지 연결은 저장하지 않는다, 2026-10-20)."

**`epic-recall-and-mirror/epic-recall-and-mirror.md`** — Notes D7

- OLD: "seq가 가장 낮은 user 메시지에서 꺼낸다."
- NEW: "`occurred_at`이 가장 이른 user 메시지에서 꺼낸다."

**`epic-replicas/epic-replicas.md`** — Done when 1

- OLD: "원본과 같은 값(ID·`seq`·시각)으로 되읽힌다."
- NEW: "원본과 같은 값(ID·시각)으로 되읽힌다."

### 4.3 PRD addendum (`prd-brain-v1-slice-1/addendum.md`)

- 스키마 스케치(40·41·43·50행)
  - OLD:
    ```
    messages       id, session_id, seq, role, model?, occurred_at, body (원문 그대로)
    tool_notes     id, session_id, message_id?, seq, tool, target, ok, occurred_at
                   session_id, occurred_at, message_seq? (수집 후 채우는 파생값), author_model,
    chunks         id, session_id, message_seq_from, message_seq_to, body
    ```
  - NEW:
    ```
    messages       id, session_id, role, model?, occurred_at, body (원문 그대로)
    tool_notes     id, session_id, message_id?, ordinal, tool, target, ok
                   session_id, occurred_at, author_model,
    chunks         id, session_id, from_at, to_at, body
    ```
- join(61행)
  - OLD: "**join**: 작업 로그는 시각을 기록하고 "그 시각 직전의 메시지"로 대화에 이어진다. `message_seq`는 수집 후 채우는 파생값이다(§5)."
  - NEW: "**join**: 작업 로그는 시각을 기록하고, 그 시각으로 대화 속 자리가 정해진다. 메시지와의 연결은 저장하지 않는다(§5, 2026-10-20)."
- 111행
  - OLD: "(스케치의 `message_seq`는 수집 후 채우는 파생값)"
  - NEW: "(연결은 저장하지 않는다, 2026-10-20)"

PRD 본문은 바꾸지 않는다.

### 4.4 Architecture spine (`architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`)

- **AD-4(82행)**
  - OLD: "parser는 메시지마다 `harness_message_id`, 발화 시각, transcript 안의 순서만 낸다. **`seq`는 parser가 정하지 않는다**(AD-8) — compact·fork로 transcript 앞부분이 바뀌어도 이미 저장된 메시지의 번호가 다른 메시지에 가지 않게 하기 위해서다."
  - NEW: "parser는 메시지마다 `harness_message_id`와 발화 시각을 transcript 안의 순서대로 낸다. 메시지 번호는 없다(AD-8) — 메시지의 정체는 harness가 준 id이므로 compact·fork로 transcript 앞부분이 바뀌어도 저장된 메시지가 다른 메시지로 바뀌지 않는다."
- **AD-7 Prevents(154행)**
  - OLD: "같은 세션의 겹친 수집이 seq를 충돌시키거나 조용히 사라지는 것"
  - NEW: "같은 세션의 겹친 수집이 메시지를 겹치게 넣거나 조용히 사라지는 것"
- **AD-7(159행)**
  - OLD: "규칙 인용 대조, 로그-메시지 연결, spool 재주입"
  - NEW: "규칙 인용 대조, spool 재주입"
- **AD-8(170행)**
  - OLD: "**`messages.seq`는 원본 Store가 삽입 트랜잭션 안에서 배정한다.** 세션마다 0부터, 구멍 없이 늘어나며, 이미 있는 `harness_message_id`는 건너뛴다. `tool_notes`의 순번도 같다. 복제 대상은 원본의 값을 복사만 한다(AD-22)."
  - NEW: "**메시지에는 번호가 없다.** 메시지의 정체는 `(session_id, harness_message_id)`이고 이미 있는 것은 건너뛴다. 대화 순서는 `occurred_at`이고 같은 시각의 순서는 정하지 않는다(2026-10-20 실측: parser가 남기는 메시지 6,818쌍에서 시각 역전 0, 같은 밀리초 0). 도구 메모는 그 메시지의 `occurred_at`, 그다음 `ordinal` 순서다. 커서가 뒤로 가지 않는다는 판정도 커서 메시지의 `occurred_at`으로 한다. 복제 대상은 원본의 값을 복사만 한다(AD-22)."
- **AD-8(172행)**
  - OLD: "기존 메시지의 `seq`·본문이 그대로다"
  - NEW: "기존 메시지의 본문·건수가 그대로다"
- **AD-11(211행)**
  - OLD: "그 메시지가 걸린 `chunks`·FTS·`embeddings` 행 삭제"
  - NEW: "그 메시지가 걸린 `chunks`(그 메시지의 `occurred_at`이 `from_at..to_at` 안에 드는 조각)·FTS·`embeddings` 행 삭제"
- **AD-14(245행)**
  - OLD: "로그는 `occurred_at` 직전의 메시지(`seq`가 가장 큰, `occurred_at` 이하인 메시지)에 이어진다. 연결 결과(`anchor_seq`)와 연결할 때까지 본 메시지 범위(`joined_upto_seq`)를 함께 기록한다. 더 이른 메시지가 나중에 들어오면 drain이 같은 식으로 다시 잇는다."
  - NEW: "로그는 자기 `occurred_at`으로 대화 속 자리가 정해진다. 메시지와의 연결은 저장하지 않으며(칸도 drain 일감도 없다), 앞뒤 메시지는 그 시각 앞뒤로 읽는다. 메시지가 로그보다 늦게 수집돼도 고칠 것이 없다(2026-10-20)."
- **AD-14(246행)**
  - OLD: "seq가 가장 낮은 user 메시지에서 꺼낸다."
  - NEW: "`occurred_at`이 가장 이른 user 메시지에서 꺼낸다."
- **AD-15 결과 계약(264행)**
  - OLD: "`seq_from`·`seq_to`, `chunk_id` 또는 `log_entry_id`"
  - NEW: "`from_at`·`to_at`(대화는 조각의 첫·끝 메시지 시각, 로그는 그 줄의 시각), `chunk_id` 또는 `log_entry_id`"
  - OLD: "첨부라면 그 세션·`seq`이고"
  - NEW: "첨부라면 그 세션·메시지 id이고"
- **AD-22(342행)**
  - OLD: "모든 값(ID, `seq`, 시각, `recorded_at` 포함)"
  - NEW: "모든 값(ID, 시각, `recorded_at` 포함)"
- **Table Contract `messages`(418행)**
  - OLD: "`(session_id, harness_message_id)`, `(session_id, seq)`. `seq`는 원본 Store가 배정"
  - NEW: "`(session_id, harness_message_id)`. 순서는 `occurred_at`(번호 없음)"
- **Table Contract `log_entries`(420행)**
  - OLD: "연결·`pending→on`: drain·`log.append`"
  - NEW: "`pending→on`: drain·`log.append`"
- **Table Contract `chunks`(422행)**
  - OLD: "`(session_id, index_config_id, seq_from, seq_to)`"
  - NEW: "`(session_id, index_config_id, from_at, to_at)`"

### 4.5 사실 문서

**`epic-capture/epic-capture-research.md` '시각'(97행 뒤)에 더한다:**
> - 2026-10-20 다시 잼: 위 수는 파일의 모든 줄을 센 것이다. 현재 parser(v3)가 남기는 메시지만 보면 transcript 228개, 붙어 있는 쌍 6,818개에서 시각 역전 0, 같은 밀리초 0이다. 시각이 거꾸로 간 줄은 parser가 버리는 줄이다. 그래서 대화 순서는 `occurred_at`이다(`../change-drop-message-seq/`).

README·parser 주석·deferred-work의 Postgres 항목은 코드 동작을 설명하므로 스토리 24가 고친다.

## 5. Implementation Handoff

**범위: Moderate.** 백로그 재정리와 spine 수정이 필요하다. 설계를 다시 짤 필요는 없다.

| 할 일 | 맡는 쪽 |
|---|---|
| §4.2~4.5 문서 수정 적용, 이 제안서 `status: approved` | Developer(이 세션, 승인 뒤) |
| §4.1 티켓 변경 — 24 추가(21 앞), 21의 title·description·verify·after·references, 15의 after | `bmad-ticket`으로 적용 |
| 21의 이전 plan·patch를 `-attempt-1`로 이름 바꿔 커밋 | Developer(이 세션, 승인 뒤) |
| 스토리 24 구현 | `bmad-build-auto 2.24` |
| 스토리 21 다시 빌드(patch 재사용, 정렬 부분 제외) | `bmad-build-auto 2.21`(24 뒤) |
| Postgres 0006 맞추기 | epic 7(deferred-work 항목) |

**새 순서(epic-capture):** 24 → 21 → 22 → 23 → 20 → 13 → 14 → 15.

**성공 기준.**
1. spine·epic·addendum 어디에도 살아 있는 규칙으로서의 `seq`·`seq_from`·`anchor_seq`가 남지 않는다. 기록 문서와 완료된 티켓은 예외다.
2. 24가 끝나면 v5 DB가 6으로 올라가도 메시지가 보존되고, 대화 중간에 늦게 들어온 메시지가 읽기에서 제자리에 온다.
3. 21이 같은 patch를 재사용해 정렬 없이 통과한다.
4. 24의 plan에 시각 역전·같은 밀리초 측정이 남는다.
