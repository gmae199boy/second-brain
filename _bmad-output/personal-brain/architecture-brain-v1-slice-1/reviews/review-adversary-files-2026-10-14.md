---
name: 'Adversary review — 추가안 A(파일·문서·launchd) 공격'
type: architecture-review
lens: adversary (+ currency 1건)
target: ./architecture-brain-v1-slice-1.md
target_section: 'AD-23, AD-24, AD-25, AD-10 원본 이전 문장, AD-15 색인 대상 문장, Table Contract 신규 4행, Deferred 신규 3행'
target_updated: '2026-10-14'
reviewed: '2026-10-14'
method: 'AD를 전부 지키면서도 서로 못 붙는 하위 단위 쌍(pair) 구성'
background: ../change-local-sqlite-primary/change-local-sqlite-primary.md
scope_note: '임베딩은 범위 밖. 제안 규칙에 임베딩을 쓰지 않는다'
---

# Adversary — 추가안 A 공격 (파일 원본, 문서 추출, 주기 실행)

## 공격 방법

"spine이 틀렸다"를 찾지 않는다. **오늘 더해진 AD를 한 글자도 어기지 않는 하위 단위 두 개를 만들어 서로 못 붙게 만든다.** 쌍이 성립하면 그 자리가 구멍이다. 구멍마다 **그대로 붙여 쓸 규칙 문장**을 제시한다. 공격 대상은 오늘 추가·수정된 부분만이다(AD-1~AD-22의 기존 본문, 2026-10-14 이전 리뷰에서 이미 다룬 잠금·시각·파생물 문제는 재론하지 않는다 — 단 새 조항이 그 문제를 **키우는** 경우는 센다).

| 단위 | 소속 | 근거 AD |
| --- | --- | --- |
| U-att — 첨부 수집 (`sessions.ingest` + FileStore.put) | epic 2 | AD-23 5번째 bullet, AD-7 |
| U-ext — 문서 추출 일감 (drain) | epic 2 | AD-24, AD-21 |
| U-idx — 문서·경로 검색 (결과 계약) | epic 4 | AD-15 신규 문장, AD-24 |
| U-red — 가리기 (`messages.redact`) | epic 2 | AD-11 |
| U-exp — 내보내기·복구 (`admin.export`/`import`) | epic 5 | AD-20, Conventions, NFR-9 |
| U-fsl — 로컬 FileStore 구현 | story 1.10·1.11 | AD-23 4번째 bullet |
| U-lnd — 주기 실행 LaunchAgent | epic 5 | AD-25 |
| U-dr — Drive FileStore + 소스 동기화 | epic 8 | AD-23, Deferred Drive 행 |
| U-mv — 원본 이전 (`home` 전환 / `setup move-store`) | epic 7·8 | AD-23 3번째 bullet, AD-10 신규 문장 |

---

## Verdict

**조건부 통과 — Critical 6건은 story 1.10(스키마)에 손대기 전에 닫아야 한다. 스키마에 들어가면 되돌릴 수 없는 것이 4건이다(C-2, C-3, C-5, H-7).**

추가안 A는 "내용과 위치를 나눈다", "맡은 파일과 외부 파일을 나눈다", "추출은 파생물이다"라는 **세 개의 좋은 축**을 잡았다. 그런데 셋 다 한 단계 아래로 내려가면 소유자가 둘이 된다.

1. **`ownership`이 위치가 아니라 내용에 붙어 있다.** `files`의 멱등 키는 `content_hash` 하나이고 `ownership`은 그 행의 컬럼이다. 같은 내용이 "내가 붙인 첨부"이면서 "원래 내 Drive에 있던 문서"인 것은 드문 일이 아니라 **기본 사례**다(내 문서를 대화에 붙인다). 그러면 한 행의 `ownership`을 두 단위가 다투고, 먼저 쓴 쪽이 이긴다. 졌을 때의 결과가 "Brain이 사용자의 원본 파일을 지울 자격을 얻는 것"이다 — AD-23의 Prevents 첫 줄이 레이스로 깨진다.

2. **파생물의 원본이 DB 밖에 있다.** 기존 파생물(조각, FTS, 미러)은 원본이 같은 DB 안에 있어서 언제든 다시 만들 수 있었다. `document_chunks`는 원본이 **파일 저장소**에 있다. 그래서 "파생물은 복구 때 다시 만든다"(Conventions)와 "원본에 접근할 수 없으면 기존 텍스트를 그대로 둔다"(AD-24)가 **복구 시점에 정면으로 충돌한다.** 복구는 원본이 없는 것이 보장된 유일한 순간이다.

3. **트랜잭션 밖 쓰기에 회수 경로가 없다.** AD-23은 "파일을 먼저 저장소에 쓰고(트랜잭션 밖) 그 뒤 행을 쓴다"를 **명령**한다. 즉 crash window를 설계로 받아들였는데, 그 창에서 생긴 블롭을 누가 지우는지, 그 블롭이 비밀을 담고 있을 때 `messages.redact`가 어떻게 찾는지가 없다. 참조 없는 블롭은 AD-11의 가리기가 영원히 못 닿는 유일한 저장소다.

그리고 **FR-27·FR-28에는 명령이 없다.** AD-5의 CLI 표면은 "아래 표로 고정한다"고 적혀 있고 그 표에 `files` ns도 `recall.docs`도 `setup move-store`도 없다. AD-10은 오늘 `setup move-store`를 이름으로 불렀다 — AD-5가 고정한 표면과 AD-10 본문이 **같은 문서 안에서 서로 어긋난다.**

- Critical 6 (C-1~C-6): 쌍이 서로 못 붙고, 증상이 조용하거나 사용자 데이터를 건드린다
- High 10 (H-1~H-10): 쌍이 서로 다른 값을 쓰거나 데이터를 잃는다
- Medium 7 (M-1~M-7)
- Currency 1 (Y-1): 추출 라이브러리를 Stack에 박아야 하는가 — **그렇다**

---

## Critical

### C-1. 첨부에는 저장 전 마스킹도, 가리기 경로도 없다 — 비밀이 검색되는데 지울 함수가 없다

**쌍:** U-att × U-ext × U-red

**각자 AD를 지키는 방식**

- U-att: AD-23 "첨부 저장은 … 파일을 먼저 저장소에 쓰고 그 뒤 행을 쓴다." 바이트를 그대로 쓴다. AD-11의 저장 전 마스킹은 "수집은 알려진 비밀 패턴을 `[REDACTED:<kind>]`로 바꾼 뒤 저장한다"이고 그 대상은 본문 텍스트다. **파일 바이트에 마스킹을 걸라는 문장은 어디에도 없고**, 걸 수도 없다 — AD-23은 `files`의 내용을 불변으로 고정했고 NFR-1도 그렇다.
- U-ext: AD-24 "텍스트는 조각 규칙(AD-15)으로 `document_chunks`에 들어간다." AD-15 신규 문장 "문서 조각(`document_chunks.body`)도 같은 키워드 색인 대상이다." 추출기는 마스킹을 모른다(AD-24에 마스킹 문장이 없다).
- U-red: AD-11 "가리기는 한 트랜잭션 안의 연쇄다: 본문 치환 + `redactions` + 그 메시지가 걸린 `chunks`·FTS·`embeddings` 행 삭제 + 조각 재생성·미러 재생성 일감." **열거된 목록에 `document_chunks`도 `files`도 블롭도 없다.** 목록대로 다 하면 계약 통과다.

**왜 못 붙는가**

`.env`를 대화에 붙인다. 같은 내용을 **텍스트로 붙여 넣었으면** AD-11의 저장 전 마스킹이 `[REDACTED:api_key]`로 바꿨다. **파일로 붙이면** 원문 그대로 저장되고, U-ext가 그 텍스트를 `document_chunks`에 넣고 FTS trigram에 올린다. 이제 `brain recall chunks "sk-"`가 키를 돌려준다. 같은 비밀의 운명이 **도착 경로에 따라 갈린다** — AD-11의 Prevents("비밀이 영구히 남는 것")가 경로 하나에서만 지켜진다.

그다음이 더 나쁘다. `messages.redact`를 불러도 블롭·`document_chunks`·그 FTS 행은 그대로다. 그런데 AD-11의 계약 테스트는 **"redact 뒤 조각·도구 메모·검색·미러·내보내기 어디에서도 지운 문자열이 나오지 않음"**이다. 첨부가 있는 세션에서 이 테스트는 **반드시 실패한다.** 즉 오늘 추가된 AD-23·AD-24는 기존 AD-11의 계약 테스트를 깨뜨렸고, 구현자는 둘 중 하나를 한다: (a) 테스트의 범위를 "메시지 본문에 한함"으로 좁힌다(FR-26이 조용히 반쪽이 된다), (b) `document_chunks`를 지우는 코드를 자기 판단으로 넣는다(그러면 블롭은 남고, 다시 추출하는 drain 일감이 **지운 텍스트를 되살린다** — AD-24 "추출기를 바꾸면 원본에서 다시 만든다"가 가리기를 되돌린다).

마지막으로, 블롭을 지우려 해도 막힌다. `files`의 멱등 키는 `content_hash`다. 같은 비밀 파일이 두 메시지에 붙어 있으면 블롭은 하나다. "이 메시지의 첨부만 지운다"는 **내용 주소 저장에서 성립하지 않는다.** 한 단위는 다른 메시지가 참조한다고 거부하고(비밀 존속), 다른 단위는 지워서 그 메시지의 첨부를 깨뜨린다. 두 쪽 다 AD 위반이 없다.

**제안 규칙 (AD-11에 bullet 3개 추가 + AD-24에 1개)**

> - **첨부의 저장 전 마스킹은 추출 시점에 한다.** 파일 바이트는 고치지 않는다(NFR-1, AD-23). 대신 추출 텍스트는 `document_chunks`에 들어가기 **전에** Core의 같은 비밀 패턴 목록을 통과하고, 맞은 자리는 `[REDACTED:<kind>]`로 바뀌며 그 사실을 `redactions`에 남긴다(지운 내용은 보존하지 않는다). 패턴에 걸린 파일은 `files.secret_suspect`로 표시하고 doctor가 보인다. 결과적으로 비밀이 텍스트로 왔는지 파일로 왔는지에 따라 검색 결과가 달라지지 않는다.
> - **원문 불변의 두 번째 예외는 `files.redact`다.** 이 함수는 (1) `files.redacted_at`을 세우고 추출 상태를 `redacted`로 바꾸고, (2) 그 파일의 `document_chunks`와 FTS 행을 전부 지우고, (3) `redactions`에 종류와 지운 내용의 해시만 남기고, (4) 그 파일의 모든 `file_locations`에 대해 `FileStore` 삭제 일감(`file_blob_delete`)을 만든다. (1)~(4)의 행 변경은 한 트랜잭션이고, 블롭 삭제는 저장소마다 성공할 때까지 재시도하는 일감이다. `message_attachments` 행은 남기고 "첨부 가려짐"으로 보인다. `content_hash`는 남겨 같은 내용의 재수집을 막는다: `redacted_at`이 있는 `content_hash`는 다시 저장하지 않고 경고 `FILE_REDACTED`를 낸다.
> - **가리기는 내용 단위다.** 같은 `content_hash`는 같은 비밀이므로, `files.redact`는 그 내용을 참조하는 모든 메시지에서 함께 가려진다. 다른 메시지가 참조한다는 이유로 거부하는 경로는 없다.
> - `messages.redact`는 그 메시지의 첨부 목록을 결과에 넣는다. 가리지 않은 첨부가 하나라도 남아 있으면 경고 `ATTACHMENT_NOT_REDACTED`를 내고, `--attachments all`을 받으면 같은 호출에서 `files.redact`를 함께 돈다.
> - (AD-24) `redacted_at`이 있는 파일은 추출 일감을 만들지 않는다. 추출기 버전이 올라도 다시 만들지 않는다.

---

### C-2. `ownership`이 내용에 붙어 있다 — 첨부와 외부 파일이 같은 행을 다투고, 지는 쪽이 사용자 파일 삭제 자격을 넘긴다

**쌍:** U-att × U-dr(소스 동기화)

**각자 AD를 지키는 방식**

- AD-23: "파일은 내용(`files`, 내용 해시가 멱등 키)과 위치(`file_locations`)로 나눈다. … **Brain이 맡은 파일**(대화 첨부)과 **외부 파일**(사용자의 기존 파일, epic 8)을 `ownership`으로 구분한다."
- Table Contract: `files` 멱등 키 `content_hash`, 작성자 "첨부 수집(epic 2), 소스 동기화(epic 8)", 변경 가능성 "내용 불변. `home`·경로 텍스트·추출 상태만 바뀜". → `ownership`은 변경 가능 목록에 없으니 **불변**이고, 작성자는 **둘**이다.
- AD-8: "멱등 삽입은 `ON CONFLICT DO NOTHING`뿐이다."

**왜 못 붙는가**

`~/Documents/계약서.pdf`를 대화에 붙인다. 같은 파일은 감시 폴더(또는 Drive)에도 있다.

- 순서 A — U-att가 먼저: `files(content_hash, ownership='brain')`. 나중에 U-dr이 같은 내용을 보고 `ON CONFLICT DO NOTHING`. 행은 `ownership='brain'`으로 남고, 거기에 **사용자의 원본을 가리키는 `file_locations` 행**이 붙는다. 이제 AD-23의 원본 이전 경로("Brain이 맡은 파일의 원본 위치는 `home` 하나다 … 옛 위치 삭제")는 그 위치를 **지울 자격이 있다고 판단한다.** AD-23의 Prevents 첫 줄("사용자의 기존 파일을 Brain이 옮기거나 지우는 것")이 규칙을 하나도 어기지 않은 두 단위의 **실행 순서**로 깨진다.
- 순서 B — U-dr이 먼저: `ownership='external'`. 그 뒤 붙인 첨부는 "Brain은 외부 파일을 옮기거나 지우지 않는다"에 걸려 **Drive로 원본 이전이 안 되고**, 로컬 사본도 영구히 못 지운다(512GB 문제 복귀).

같은 입력에 대해 결과가 **레이스로 결정**되고, 둘 다 조용하다. 게다가 `ownership`이 불변이므로 **고칠 경로가 없다.** 이것이 story 1.10 스키마에 들어가면 마이그레이션 없이는 못 되돌린다.

**제안 규칙 (AD-23 2번째 bullet 교체)**

> - **소유는 내용이 아니라 위치의 속성이다.** `files`에는 `ownership`을 두지 않는다. `file_locations.ownership`이 `brain | external`이고, 같은 내용이 Brain이 맡은 사본과 사용자의 원본으로 동시에 존재하는 것이 정상이다(`files` 행 하나, 위치 둘).
> - Brain이 넣기·지우기·이전을 할 수 있는 위치는 `ownership='brain'`이고 쓰기 가능으로 표시된 저장소 루트 안에 있는 것뿐이다. `external` 위치에 대해서는 `FileStore`의 가져오기·확인·위치→URL만 부른다. 넣기·지우기는 port 수준에서 거부하고, 이것을 계약 테스트로 고정한다.
> - `files.home`은 `ownership='brain'`인 위치만 가리킬 수 있다.

---

### C-3. 트랜잭션 밖에 쓴 블롭의 소유자가 없다 — orphan 블롭, spool 바이트, 비결정적 locator

**쌍:** U-att × U-att(재시도) × AD-9

**각자 AD를 지키는 방식**

- AD-23: "첨부 저장은 수집과 같은 쓰기 트랜잭션이 아니라, 파일을 먼저 저장소에 쓰고(트랜잭션 밖) 그 뒤 행을 쓴다(AD-7)." — crash window를 **설계로 승인**했다.
- AD-9: "DB에 쓰지 못한 작업 로그 원문, 실패 기록, 수집 밀림 표시, 주입 시도 기록은 spool에 쓴다." — 첨부는 목록에 없다.
- AD-7: 턴 수집의 `busy_timeout`은 3초, 초과는 spool.

**왜 못 붙는가**

세 갈래로 갈린다.

1. **orphan 블롭.** 블롭을 쓴 뒤 행을 쓰기 전에 프로세스가 죽는다(hook 타임아웃, launchd `ExitTimeOut`, 사용자 Ctrl-C). 블롭은 `files/`에 남고 아무 행도 가리키지 않는다. 회수하는 일감도, doctor 검사도, 상한도 없다. 그 블롭이 비밀을 담고 있으면 C-1의 가리기도 영원히 못 닿는다. 512GB 디스크에서 이것은 조용한 누출이다(NFR-2 위반).
2. **spool에 바이트를 넣는 해석.** 턴 수집이 3초 잠금 초과로 spool에 갈 때, "첨부도 수집의 일부"라고 읽은 단위는 **50MB PDF를 base64로 JSON Lines 한 줄**에 넣는다(AD-9의 spool 형식은 줄마다 `schema_version`인 JSONL이다). AD-9 어디에도 금지가 없다. 다른 단위는 "블롭은 이미 저장소에 있으니 행만 포기"한다 → 메시지는 나중에 첨부 없이 수집되고, 블롭은 1번의 orphan이 된다. 같은 상황에서 두 단위가 전혀 다른 일을 한다.
3. **비결정적 locator.** locator를 UUID로 짓는 단위가 있다(AD-23은 "로컬은 저장소 루트 기준 상대 경로"라고만 한다). 재시도하면 같은 내용이 **다른 locator**로 한 번 더 써지고, `files`는 `content_hash`로 DO NOTHING이라 두 번째 블롭은 아무도 모르는 orphan이 된다.

**제안 규칙 (AD-23 5번째 bullet 교체 + 1개 추가)**

> - **locator는 내용의 순수 함수다.** Brain이 맡은 파일의 로컬 locator는 `<hash[0:2]>/<hash[2:4]>/<content_hash 전체><확장자>`다(확장자는 내용으로 판정한 media type에서 정한다). `put`은 임시 파일 → rename이고 같은 내용에 두 번 불러도 같은 locator에 같은 바이트가 된다(멱등). 따라서 재시도가 블롭을 늘리지 않는다.
> - **블롭은 두 단계로 쓴다.** (1) `FileStore.put` (트랜잭션 밖), (2) `files`·`file_locations`·`message_attachments` 행 쓰기 (한 트랜잭션). (1)과 (2) 사이에서 죽어 생긴 블롭은 **고아**다: 저장소 루트 안에 있으면서 `file_locations`에 대응 행이 없고 mtime이 유예 시간(기본 24시간)보다 오래된 블롭은 drain의 `file_orphan_sweep` 일감이 지운다. locator가 내용 주소라서 이 비교는 목록 하나와 행 하나의 차집합이고 별도 장부가 필요 없다. doctor는 고아 수와 합계 바이트를 보인다.
> - **첨부 바이트는 spool에 넣지 않는다.** DB에 행을 쓸 수 없으면 블롭은 이미 저장소에 있으므로, spool에는 메타데이터 한 줄(`attachment_link`: 세션 키, `harness_message_id`, `ordinal`, `content_hash`, 선언된 이름, media type, 바이트 수)만 쓴다. drain이 메시지 행을 찾아 `message_attachments`를 채운다. spool 한 줄은 어떤 경우에도 64KB를 넘지 않는다.

---

### C-4. 내보내기·복구가 문서 검색을 조용히 날린다 — "파생물은 다시 만든다" × "원본 없으면 그대로 둔다"

**쌍:** U-exp × U-ext

**각자 AD를 지키는 방식**

- Conventions(내보내기, NFR-9): "복구는 의존 순서대로 insert하고, **파생 테이블은 다시 만든다.**"
- Table Contract: `document_chunks` 변경 가능성 = "파생, 다시 만들 수 있음".
- AD-24: "추출 텍스트와 조각은 파생물이다. … **원본에 접근할 수 없으면(연동 해제 등) 기존 텍스트를 그대로 둔다.**"
- 배경 §7.3: "내보내기 스냅샷 형식이 파일 메타데이터를 포함 (**파일 본체는 선택**)."
- Deferred: "지금은 `admin.export`→`import`(빈 DB에만)".

**왜 못 붙는가**

새 Mac으로 옮긴다. 스냅샷에는 `files`·`file_locations`·`message_attachments` 메타데이터가 있고 본체는 없다(선택이므로 안 넣었다). 빈 DB에 복구한다. U-exp는 규칙대로 **파생 테이블을 다시 만든다** → `document_chunks`를 넣지 않고 추출 일감을 만든다. U-ext가 그 일감을 집으면 블롭이 없다(로컬 `files/`는 비었고, Drive는 아직 연동 전이다). AD-24대로 "원본에 접근할 수 없으면 기존 텍스트를 그대로 둔다" — **그대로 둘 기존 텍스트가 없다.** 결과: 복구 직후 문서 검색이 전부 사라지고, 원인은 어디에도 기록되지 않는다. FR-28이 복구 한 번으로 조용히 0이 된다.

핵심은 이것이다: 기존 파생물(`chunks`, FTS, 미러)은 **원본이 같은 DB 안에** 있어서 "다시 만든다"가 항상 가능했다. `document_chunks`는 원본이 DB 밖에 있는 **유일한 파생물**이고, 복구는 그 원본이 없는 것이 보장된 순간이다. "파생물"이라는 한 단어에 두 종류를 묶은 것이 구멍이다.

**제안 규칙 (Conventions 내보내기 행 + AD-24에 bullet 1개)**

> - (Conventions) **"파생 테이블은 다시 만든다"는 원본이 같은 DB 안에 있는 파생물에만 적용한다**(`chunks`, FTS, `embeddings`, 미러). 원본이 DB 밖(파일 저장소)에 있는 `document_chunks`와 `document_extractions`는 **다른 테이블과 똑같이 내보내고 똑같이 복구한다.** `manifest.json`에는 파일 본체 포함 여부(`file_bodies: none | brain_owned | all`)를 적는다.
> - (AD-24) 복구 뒤 `home` 위치를 확인할 수 없는 파일은 `source_unreachable`로 표시한다. 그 파일의 기존 `document_chunks`는 **지우지 않고 계속 검색된다.** 검색 결과에는 경고 `FILE_SOURCE_UNREACHABLE`가 붙고(링크 대신 "원본 접근 불가"), doctor가 건수를 보인다. 저장소가 그 `content_hash`를 다시 확인해 주면 표시를 해제한다. 접근 불가는 재추출 일감을 만들지 않는다.

---

### C-5. `document_chunks`의 키가 AD-24의 "다시 만든다"와 `files`의 단일 추출 상태를 동시에 배반한다

**쌍:** U-ext(v2) × U-ext(v3) × U-idx

**각자 AD를 지키는 방식**

- Table Contract: `document_chunks` 멱등 키 `(file_id, extractor_version, index_config_id, ordinal)`.
- AD-24: "결과는 파일마다 상태(`ok | failed | unsupported | too_large`)와 `extractor_version`을 남긴다. … 추출기를 바꾸면 **버전을 올리고 원본에서 다시 만든다.**"
- Table Contract `files`: "내용 불변. `home`·경로 텍스트·**추출 상태**만 바뀜." → 상태는 파일당 **하나**.

**왜 못 붙는가**

세 군데가 동시에 어긋난다.

1. **두 세대 공존.** `extractor_version`이 키에 있으므로 v3로 다시 추출하면 v2 행은 **지워지지 않는다**(키가 다르니 충돌도 없다). 이제 같은 PDF의 같은 문장이 두 벌 색인되어 검색 결과에 두 번 나온다. AD-15는 어느 세대를 쓰라는 말이 없다. 반대로 옛 행을 지우는 단위는 "다시 만든다"에 충실하지만, 그러면 키의 `extractor_version`은 **절대 두 값을 갖지 않는 죽은 컬럼**이다. 두 단위의 결과 건수가 다르고 둘 다 AD 위반이 없다.
2. **상태 뒤집힘.** 상태가 `files`에 하나뿐인데 조각은 `(extractor_version, index_config_id)`마다 있다. v2로 `ok`였던 파일을 v3로 재추출했다가 실패하면 `files`의 상태가 `failed`로 덮인다. 그런데 **v2 조각은 여전히 검색된다.** AD-24 "`ok`가 아닌 파일은 검색 결과와 doctor에 표시된다"에 따라 Brain은 "이 문서는 못 읽었다"고 표시하면서 그 문서의 본문을 결과로 돌려준다. Table Contract와 키가 서로를 부정한다.
3. **`index_config_id`의 정체.** `index_configs`의 멱등 키는 `(kind, model, dimensions, chunk_params)`다. 임베딩이 없는 문서 조각에는 `model`·`dimensions`가 없다. 한 단위는 `model=''`, 다른 단위는 `model='none'`, 또 다른 단위는 추출기 이름을 넣는다 → **설정 행이 둘 생기고 조각도 두 벌이 되어** 1번의 중복을 다시 만든다.

**제안 규칙 (Table Contract 2행 교체 + AD-24에 bullet 1개)**

> - 추출 시도는 `document_extractions`에 쌓는다. 멱등 키는 `(file_id, extractor_version, index_config_id)`이고, 작성자는 drain, 컬럼은 상태(`ok | failed | unsupported | too_large | redacted`), 시도 시각, 조각 수, 오류다. 이 테이블이 추출 상태의 유일한 권위 출처이고, `files`에는 추출 상태 컬럼을 두지 않는다(검색·doctor는 현재 세대 행을 본다).
> - `document_chunks`의 멱등 키는 `(extraction_id, ordinal)`이고, 조각마다 위치(쪽 등)를 가진다. 파일마다 **검색에 쓰이는 세대는 하나**다: `files.current_extraction_id`가 그것을 가리킨다. 재추출은 새 세대의 조각과 FTS 행을 만든 뒤 **같은 트랜잭션에서** `current_extraction_id`를 바꾸고 옛 세대의 조각·FTS 행을 지운다. 교체 전까지 검색은 옛 세대를 쓴다(AD-15의 `admin.reindex` 규칙과 같은 모양이다). 재추출이 실패하면 `current_extraction_id`는 바뀌지 않고, 실패 세대의 상태만 남는다.
> - (AD-24) 문서 조각의 색인 설정은 Core가 정한 **단일 상수 행**이다: `kind='document_chunk'`, `model='none'`, `dimensions=0`, `chunk_params`는 AD-15의 조각 규칙. 추출기 신원은 `extractor_version` 하나에만 있고, 그 값은 라이브러리 버전을 포함한 Core 상수다(Y-1).

---

### C-6. FR-27·FR-28·`setup move-store`에 명령이 없다 — AD-5가 고정한 표면과 AD-10·AD-23이 어긋난다

**쌍:** U-idx × AD-5 × U-mv

**각자 AD를 지키는 방식**

- AD-5: "slice 1은 CLI만 내고, **표면은 아래 표로 고정한다.**" 그 표에 `files` ns는 없고, `recall`은 `time | logs | chunks | tools | expand`, `setup`은 `run | connect | upgrade | uninstall`이다.
- AD-10(오늘): "… 명시적 명령 하나(**`brain setup move-store`** …)로만 한다."
- FR-27: "원본 위치(로컬 경로 또는 연동된 저장소의 링크)를 **받을 수 있다**." FR-28: "결과에는 문서, 위치(쪽 등), **원본을 가리키는 링크**가 붙는다."
- AD-15 결과 계약: 출처는 `session` 토큰, `harness`, 날짜, 꼬리표, `seq_from`·`seq_to`, `chunk_id` 또는 `log_entry_id`이고 "**이 출처가 곧 `recall.expand`·`sessions.read`의 입력이다**."

**왜 못 붙는가**

문서 조각에는 `session`도 `seq`도 없다. 외부 파일(epic 8)에는 `harness`도 없다. 그래서 U-idx는 AD-15의 출처 칸을 전부 `null`로 채운 결과를 내놓거나(에이전트가 `recall.expand`에 넣으면 실패한다), 출처 칸을 제 맘대로 늘린다(결과 형태가 단위마다 달라지는 것 — AD-15의 Prevents 세 번째 줄 그대로다). 그리고 어느 쪽이든 **"원본을 가리키는 링크"를 얻을 명령이 없다.** `files` ns가 없으니 FR-27의 테스트 가능한 결과("원본 위치를 받을 수 있다")를 만족시키는 CLI 호출이 존재하지 않는다. C-1이 요구하는 `files.redact`도 표면에 들어갈 자리가 없다.

`setup move-store`는 더 단순한 모순이다. AD-10이 이름으로 부른 명령이 AD-5가 "고정한다"고 선언한 표에 없다. 같은 문서 안의 두 문장이 어긋난다.

**제안 규칙 (AD-5 표 2행 추가·2행 수정 + AD-15 결과 계약 교체)**

> | ns | verb | 하는 일 (FR) |
> | --- | --- | --- |
> | `files` | `show`, `url`, `redact`, `reindex` | 파일 메타·위치·추출 상태 보기, 원본 URL 받기, 첨부 가리기, 재추출 (27, 28, AD-11) |
> | `recall` | `time`, `logs`, `chunks`, `docs`, `tools`, `expand` | … `docs`는 문서 조각·경로·파일 이름 검색 (28) |
> | `setup` | `run`, `connect`, `upgrade`, `uninstall`, `move-store` | … `move-store`는 원본 이전(epic 7, AD-10) |
>
> - (AD-15 결과 계약) 결과마다 출처를 붙이고, 출처는 **종류로 갈라지는 합집합**이다. `kind='conversation'`: `session` 토큰, `harness`, 날짜, 꼬리표, `seq_from`·`seq_to`, `chunk_id`. `kind='log'`: `log_entry_id`. `kind='document'`: `file_id`, 표시 이름, 위치 종류, 위치 안의 자리(쪽 등), 그때 만든 URL, 그리고 첨부라면 붙은 메시지의 `session` 토큰과 `seq`. 어떤 종류든 **그 출처가 곧 다음 호출의 입력**이다: conversation은 `recall.expand`·`sessions.read`, document는 `files.show`·`files.url`.
> - 근접 정렬(같은 워크트리 → 프로젝트 → 워크스페이스 → 전체)에서 문서는 **붙은 메시지의 세션에서 근접을 물려받는다.** 붙은 메시지가 없는 외부 파일은 모든 꼬리표 단계 뒤의 전체 단계에 놓는다.
> - 한 번의 결과 예산(기본 5건, 8,000자)은 종류별 몫을 가진다. 문서 조각이 대화 조각을 밀어내지 않는다.

---

## High

### H-1. 내용 해시의 알고리즘·표기가 없다 — 검증이 연극이 되고 중복 제거가 깨진다

**쌍:** U-fsl × U-dr

AD-23은 "내용 해시가 멱등 키"와 "**저장소가 준 해시로** 검증"을 같은 조항에 넣었다. 그런데 알고리즘도 표기도 정하지 않았다. U-fsl은 sha256 소문자 hex를 쓴다. U-dr은 "저장소가 준 해시"를 쓰는데 Drive가 주는 것은 Core가 쓰는 알고리즘과 같지 않을 수 있다(md5 계열, 그리고 버전에 따라 sha1/sha256 필드 — epic 8에서 **실측 확인 필요**). 그러면 두 갈래다: (a) 알고리즘이 달라 비교 자체가 불가능한데 "검증"을 통과시킨다(=검증 없이 삭제, AD-23의 Prevents 세 번째 줄), (b) Drive가 준 해시를 `files.content_hash`에 넣는다 → 같은 내용에 두 행, FR-27 "같은 내용의 파일은 한 번만 보관된다" 위반, 그리고 `content_hash` UNIQUE 하나에 두 알고리즘이 섞여 **나중에 구분할 수 없다.**

> **제안 규칙 (AD-23 1번째 bullet에 추가)**
> - 내용 해시는 Core가 바이트 전체에서 계산한 `sha256:<소문자 hex 64자>` 문자열이고, 알고리즘 접두사를 포함해 저장한다. 저장소가 돌려준 체크섬은 **절대 `files.content_hash`에 넣지 않는다.** `file_locations`의 `remote_checksum`·`remote_checksum_algo`에 넣는다.
> - `FileStore` port는 자기가 보고할 수 있는 체크섬 알고리즘 목록을 선언한다. 검증은 "저장소가 보고한 체크섬 == Core가 올린 바이트로 같은 알고리즘으로 계산한 값"이고, 저장소가 Core가 계산할 수 있는 알고리즘을 하나도 보고하지 못하면 **되읽어 `sha256`을 다시 계산한다.** 바이트 수도 함께 비교한다. 어느 쪽도 못 하면 검증 실패이고, 옛 위치는 지우지 않는다. 계약 테스트: 바이트를 한 글자 바꾼 사본은 검증에서 떨어지고 옛 위치가 남아 있다.

### H-2. `home`의 모양과 전환 순서가 없다 — 가리키는 곳이 지워진 창이 생긴다

**쌍:** U-mv × U-idx

AD-23은 "원본 위치는 `home` 하나다"와 "업로드 → 검증 → 검증 시각 기록 → 옛 위치 삭제"를 말하지만, **`home`이 언제 바뀌는지**를 말하지 않는다. 그래서 두 구현이 다 합법이다: 옛 위치 삭제 **전에** 바꾸거나, **후에** 바꾸거나. 후자에서 U-idx가 그 창에 `home`으로 URL을 만들면(AD-23: URL은 위치로부터 그때 만든다) 막 지워진 파일의 URL을 사용자에게 준다. crash가 그 창에 끼면 `home`은 **영구히 지워진 위치**를 가리키고, 고칠 일감도 doctor 검사도 없다. 더해서 `home`의 모양이 안 정해졌다: 저장소 종류(`'local'`)인지 `file_locations`의 행 id인지. 종류라면 같은 종류에 위치가 둘일 때 어느 것인지 말할 수 없다.

> **제안 규칙 (AD-23 3번째 bullet 교체)**
> - `files.home`은 그 파일의 `file_locations` 행 하나를 가리키는 참조다(저장소 종류가 아니다). 불변식: `home`이 가리키는 행은 같은 파일의 것이고 `ownership='brain'`이며 `verified_at IS NOT NULL AND deleted_at IS NULL`이다. trigger로 걸고 doctor가 검사한다.
> - 원본 이전 순서는 업로드 → 검증 → **같은 쓰기 트랜잭션에서 `verified_at` 기록과 `home` 전환** → 옛 위치 삭제다. 삭제는 별도 일감(`file_blob_delete`, 대상은 옛 위치)이라 실패해도 `home`은 이미 새 위치이고 재시도된다. `home`을 가리키는 위치는 삭제 일감의 대상이 될 수 없다.
> - 원본 이전은 양방향이다(`files move-home --to local|drive`). 어느 방향이든 같은 순서와 같은 검증을 쓴다.

### H-3. `FileStore` 삭제에 루트 봉쇄가 없다 — `..` locator 하나로 사용자 파일이 지워진다. 그리고 외부 로컬 파일에는 합법적인 모양이 없다

**쌍:** U-fsl × U-dr

AD-23은 "로컬은 저장소 루트 기준 상대 경로"라고만 한다. `../../Documents/계약서.pdf`는 완벽히 합법인 상대 경로다. 그리고 **외부 로컬 파일은 `[files] path` 밑에 없다** — 그걸 이 모양으로 표현하려면 루트를 탈출하는 상대 경로를 쓰는 수밖에 없다. 즉 AD-23의 모양이 epic 8의 요구를 받으려면 루트 탈출을 허용해야 하고, 그 순간 port의 `지우기`는 사용자 홈 전체에 닿는다. "Brain은 외부 파일을 지우지 않는다"는 **정책 문장**이고, port 계약이 아니다. 정책은 호출자가 깨고, 깨진 걸 막는 장치가 없다.

> **제안 규칙 (AD-23 4번째 bullet 교체)**
> - `store_kind`는 **설정된 루트 하나**를 가리킨다: `local`은 `[files] path`(쓰기 가능), `local_source:<id>`는 `[[sources]]`의 감시 루트(읽기 전용), `drive`는 Brain 전용 Drive 폴더(쓰기 가능), `drive_source:<id>`는 외부 Drive 범위(읽기 전용). 외부 파일은 자기 루트의 `store_kind`를 쓰고, 루트를 탈출하는 locator는 쓰지 않는다.
> - locator는 정규화된 상대 경로이고 `..`·절대 경로·루트 밖으로 나가는 symlink를 담을 수 없다. 모든 `FileStore` 구현은 읽기·쓰기·삭제 모두에서 이것을 거부한다(로컬은 `realpath` 포함 검사). 넣기·지우기·이전은 **쓰기 가능으로 표시된 루트에만** 구현한다. 읽기 전용 루트에서 그 메서드는 `STORE_READ_ONLY`로 거부한다.
> - 지우기는 호출자가 기대하는 `content_hash`를 함께 받고, 저장소가 바이트를 확인한 뒤에만 지운다. 확인할 수 없으면 지우지 않는다. 계약 테스트: `..`·절대 경로·탈출 symlink·해시 불일치는 모두 거부되고 파일이 남아 있다.

### H-4. 경로·이름 색인 대상이 AD-23과 모순이다 — 경로는 `files`에 없고, 표시 이름은 집이 없다

**쌍:** U-idx × U-dr

AD-15 신규 문장은 "파일 경로·이름(**`files`의 경로 텍스트**)"을 색인 대상으로 지목한다. 그런데 AD-23은 경로를 `file_locations.locator`에 두고 "절대 경로는 저장하지 않는다"고 한다. 게다가 C-3의 제안대로(그리고 지금 구현해도) Brain이 맡은 파일의 로컬 locator는 **해시**라서 검색할 가치가 없다. 외부 파일은 위치가 여러 개일 수 있는데 `files`의 단일 "경로 텍스트"는 **마지막에 쓴 쪽이 이긴다**(Table Contract는 이 컬럼을 변경 가능으로 두고 작성자를 둘로 적었다 — C-2와 같은 레이스).

그리고 사용자가 **대화에서 부른 파일 이름**은 locator도 경로도 아니다. 같은 내용을 두 번, 다른 이름으로 붙일 수 있으니 이름은 `message_attachments`의 속성이다. 그 자리가 없어서 U-att은 `files.filename`에 쓰고 U-idx는 `message_attachments`에서 찾다가 이름 없는 결과를 돌려준다.

> **제안 규칙 (AD-15 신규 문장 교체 + Table Contract 1행 추가)**
> - `files`는 내용의 사실만 담는다(`content_hash`, 바이트 수, media type, `home`, `current_extraction_id`, `redacted_at`, `secret_suspect`). 경로 텍스트 컬럼을 두지 않는다. 표시 이름은 `message_attachments.filename`(Brain이 맡은 첨부)과 `file_locations.display_path`(외부 위치)에 있다.
> - 키워드 색인 대상은 파생 테이블 `file_names(file_id, text, source)`다: drain이 그 파일의 모든 첨부 이름과 삭제되지 않은 모든 위치의 경로 텍스트에서 다시 만든다. 작성자는 drain 하나이고 파생물이다. 문서 조각(`document_chunks.body`)과 이 테이블이 AD-15의 키워드 색인에 함께 들어간다.

### H-5. 추출이 2초 쓰기 예산을 넘긴다. 그리고 `too_large`에 숫자가 없다

**쌍:** U-ext × U-ing

AD-15는 "FTS 행은 원본 행을 쓰는 같은 트랜잭션에서 adapter가 함께 쓴다"고 하고, AD-7은 "어떤 쓰기 트랜잭션도 2초를 넘겨 잠금을 쥐지 않는다"고 한다. 300쪽 PDF의 조각 수백 개 + trigram FTS 행을 한 트랜잭션에 넣으면 **DB 단위 쓰기 잠금**을 수 초 쥔다. 그 동안 모든 턴 수집(3초)과 `brain log append`가 밀려 spool로 가고, AD-9에 따라 사용자에게 보인다. 두 단위 다 AD 위반이 없다. AD-25의 주기 drain은 이것을 **시간표에 올려** 하루 수십 번 재현한다.

또 AD-24는 `too_large`를 상태로 정의하면서 **기준값을 정하지 않았다.** 한 단위는 10MB, 다른 단위는 200MB로 잡는다. 같은 파일이 기계·버전에 따라 `ok`와 `too_large`를 왕복하고, C-5의 상태 뒤집힘과 겹친다. 덧붙여 Drive 파일의 바이트 읽기는 **네트워크**이므로 쓰기 트랜잭션 밖이어야 하는데, AD-24에는 그 문장이 없어서 스트리밍 핸들로 트랜잭션 안에서 읽는 구현이 AD-24만 보면 합법이다.

> **제안 규칙 (AD-24에 bullet 1개 추가)**
> - 추출 일감은 한 파일을 **여러 쓰기 트랜잭션**으로 처리한다. 한 트랜잭션은 조각 200개 또는 본문 256KB 중 먼저 닿는 쪽까지만 쓰고, 다음 트랜잭션은 `ordinal` 커서에서 이어 간다(AD-7의 2초 예산을 지키기 위해서다). 중간 상태는 미완성 세대이고 `current_extraction_id`가 바뀌기 전까지 검색에 보이지 않는다(C-5).
> - 바이트 읽기, 형식 판정, 텍스트 추출, EXIF 읽기는 모두 쓰기 트랜잭션 **밖**에서 한다. 저장소에서 바이트를 받는 것은 네트워크 I/O일 수 있다.
> - 추출 상한은 설정이다: `[files] max_extract_bytes`(기본 64MB), `[files] max_extract_chars`(기본 2,000,000자). 넘으면 `too_large`이고 그 이유와 실제 값을 남긴다. 상한을 올리면 `extractor_version`과 무관하게 재추출 일감을 만든다.

### H-6. EXIF 촬영 일시에 시간대가 없다 — AD-13이 거부하거나, 9시간 틀린 값이 들어간다. 그리고 EXIF에는 테이블이 없다

**쌍:** U-ext × U-idx(시간 조회)

AD-24: "이미지는 EXIF(촬영 일시, 기기, 좌표)를 메타데이터로 남기고, **촬영 일시는 시간 조회에 쓴다.**" EXIF의 `DateTimeOriginal`은 **시간대 없는 지역 시각**이다(`OffsetTimeOriginal`이나 GPS가 있으면 복원 가능, 없으면 불가). AD-13은 저장 정규형을 정확히 `…Z` 24글자로 고정하고 "Store는 경계에서 다른 형태를 거부한다"고 한다. 그래서 U-ext는 **시간대를 발명해야 한다**: UTC로 읽거나, 설정 시간대(`Asia/Seoul`)로 읽거나, GPS 시각을 쓰거나. 어느 가정을 했는지 적는 칸이 없으니 나중에 고칠 수도 없다. `recall.time`은 메시지의 진짜 순간과 추정 순간을 한 범위에 섞어, 날짜 경계의 사진을 조용히 빼거나 더한다(NFR-2 위반).

그리고 EXIF를 **어디에 쓸지**가 없다. Table Contract의 `files` 변경 가능성은 "`home`·경로 텍스트·추출 상태만 바뀜"이라서, `files`에 EXIF를 쓰는 것은 **Table Contract 위반**이다. AD-24와 Table Contract가 직접 모순이다.

> **제안 규칙 (AD-24 3번째 bullet 교체 + Table Contract 1행 추가)**
> - 이미지·문서의 파일 메타데이터는 `file_metadata(file_id, key, value)`에 둔다. 작성자는 drain(추출)이고, 추출 세대와 함께 다시 만들 수 있는 파생물이다.
> - 촬영 일시는 두 칸으로 둔다: `captured_at_local`(EXIF에 적힌 글자 그대로, `YYYY-MM-DDTHH:MM:SS`, 시간대 없음)과 `captured_at`(AD-13 정규형의 순간). 그리고 `captured_at_source`가 `exif_offset | gps | config_tz | unknown` 중 무엇으로 순간을 만들었는지 적는다. `config_tz`·`unknown`으로 만든 값이 결과에 들어가면 경고 `TIME_ZONE_ASSUMED`를 낸다. 설정 시간대를 바꾸면 `config_tz`로 만든 값만 다시 만든다.
> - EXIF는 파일에서 온 **신뢰할 수 없는 입력**이다. `occurred_at`·`recorded_at`·`seq`를 정하는 데 쓰지 않는다. 그럴듯한 범위(1990년~현재+1일)를 벗어난 값은 `captured_at`을 만들지 않고 `captured_at_local`만 남기며 경고한다.
> - 좌표는 비밀 패턴이 아니지만 개인정보다. `files.redact`는 그 파일의 `file_metadata`를 함께 지운다.

### H-7. `message_attachments`의 키가 한 자리에 두 내용을 허용한다 — 그리고 parser 순수성이 깨진다

**쌍:** U-att × U-att(재수집) × AD-4

Table Contract: `message_attachments` 멱등 키 `(message_id, file_id, ordinal)`, 작성자 `sessions.ingest`, 불변. AD-4: parser 출력은 transcript 내용의 **순수 함수**이고 메시지마다 `harness_message_id`·시각·순서만 낸다.

transcript는 첨부를 **경로**로 가리킨다(또는 인라인). 바이트를 읽는 것은 파일시스템을 보는 일이라 **순수하지 않다.** 그래서 "첨부 해석"은 parser 밖의 어느 단위가 하는데, 그 시점은 발화 시각보다 나중이다. 사용자가 그 사이 파일을 고치면 재수집은 같은 `(message_id, ordinal)`에 **다른 `content_hash`**를 얻는다. 키에 `file_id`가 들어 있으므로 두 행이 **둘 다 합법**이다: 한 자리에 내용 둘. AD-8의 계약 테스트("같은 배치를 두 번 넣으면 모든 테이블의 건수가 같다")는 파일이 안 변한 fixture에서만 통과한다. 그리고 첨부 원본이 이미 없으면(사용자가 지웠다) 한 단위는 조용히 행을 안 만들고(첨부가 있었다는 사실 자체가 사라진다 — FR-27 불가), 다른 단위는 실패로 수집을 막는다(NFR-3 위반).

> **제안 규칙 (Table Contract 1행 교체 + AD-23에 bullet 1개)**
> - `message_attachments`의 멱등 키는 `(message_id, ordinal)`이다. 생성은 `sessions.ingest`, 해석(`file_id`·`state`)은 drain의 `attachment_fetch` 일감이 **한 번만** 채운다(단조). `kind`·`filename`·선언된 media type은 불변이다.
> - `state`는 `pending | stored | missing_at_ingest | changed | too_large | refused`다. 원본이 없으면 `missing_at_ingest`로 남아 "첨부가 있었다"는 사실이 보존되고, 수집은 막히지 않는다. 이미 `stored`인 자리에 다른 `content_hash`가 나오면 덮지 않고 `changed`를 기록하며 두 해시를 `failures`에 남기고 경고 `ATTACHMENT_CHANGED`를 낸다.
> - parser는 첨부를 **참조로만** 낸다(`ordinal`, 선언된 이름, 선언된 media type, 원본 참조). 바이트를 읽지 않으므로 parser는 순수한 채로 남는다(AD-4).

### H-8. AD-25에 신원·간격·겹침·관측이 없다 — 이중 등록, spool 홍수, 아무도 모르게 멈춤

**쌍:** U-lnd × U-lnd(두 번째 `setup run`) × U-ctx

AD-25는 "Brain 표식이 붙은 LaunchAgent"라고만 한다. 그런데 launchd의 신원은 **Label**이고, plist 안의 주석 표식으로는 `launchctl`이 중복을 판정하지 않는다. 한 단위는 `Label=com.second-brain.drain`, 다른 단위는 `~/Library/LaunchAgents/second-brain-drain.plist`에 표식 주석을 쓴다 → `setup run`을 두 번 돌리면 **에이전트가 둘**이 되고 drain이 겹쳐 돌고, `uninstall`은 자기가 아는 하나만 지운다. AD-19의 "표식으로만 '이미 있음'을 판정한다"가 hook에는 맞지만 LaunchAgent에는 맞지 않는다.

간격도, 한 번 실행의 상한도 없다. AD-7의 DB 단위 쓰기 잠금 위에서 60초 간격 drain은 동기 시작 맥락(U-ctx)과 **시간표에 따라** 충돌한다(이전 리뷰 C-1을 주기화한다). 반대로 아무 상한이 없어서 한 번의 drain이 다음 간격을 넘겨 겹친다.

관측이 없다. 에이전트가 unload되거나 plist가 깨져 주기 drain이 **완전히 멈춰도** 아무 기록이 없다. "일감이 다음 세션 시작까지 밀리는 것"을 막겠다는 AD-25의 Prevents가 지켜지는지 확인할 방법이 없다(NFR-2 위반). 그리고 DB가 없는 상태(AD-10: 없으면 `DB_UNAVAILABLE`)에서 주기 실행은 **매 간격마다 실패 기록과 spool 파일 하나**를 만든다(AD-9: 프로세스별 새 파일). 15분 간격이면 하루 96개, 영구히.

> **제안 규칙 (AD-25 1번째 bullet 교체 + 2개 추가)**
> - LaunchAgent의 신원은 Label이다: `com.second-brain.<job>`, 파일은 `~/Library/LaunchAgents/com.second-brain.<job>.plist`. 이 Label 자체가 Brain 표식이고, `setup run`은 그 Label만 `bootout` 후 `bootstrap`해서 멱등하게 등록한다. `setup uninstall`은 `com.second-brain.` 접두사를 가진 Label만 지운다. plist는 설치 시점의 shim 절대 경로를 부른다(AD-19).
> - 간격은 설정이다(`[schedule] drain_interval_sec`, 기본 900). 한 번의 실행에는 벽시계 예산이 있고(`--budget`, 기본 간격의 1/3) 그 예산 안에서 일감을 처리하다 멈춘다. `ThrottleInterval`은 간격 이상, `ExitTimeOut`은 예산 이상으로 둔다. 겹쳐 떠도 안전하지만(AD-7) 겹치지 않게 맞춘다.
> - 주기 실행은 **관측 가능**하다: 매 실행이 끝에 `schedule_runs`(Label, 시작·끝 시각, 처리한 일감 수, 결과)를 한 줄 남긴다. doctor는 각 Label의 등록 여부(`launchctl print`)와 마지막 성공 시각을 보이고, 간격의 3배보다 오래되면 경고한다.
> - 주기 실행은 **조용히 실패한다**: 원본을 열 수 없으면 exit 0으로 끝내고 실패를 fingerprint로 묶어 하루에 한 번만 기록한다. spool 파일을 만들지 않는다(쓸 내용이 없다). 사람에게 보이는 자리는 doctor 하나다.

### H-9. AD-10의 "쓰기 정지"에 장치가 없고, "해시 검증"에 정의가 없다

**쌍:** U-mv × U-ing

AD-10 신규 문장: "쓰기 정지 → 복사 → 건수·해시 검증 → 전환 → 옛 파일은 읽기 전용 백업." 모든 쓰기는 단명 프로세스이고 설정이 준 경로로 원본을 직접 연다(AD-10) — **정지시킬 대상이 없다.** 이전 중에 뜬 hook은 옛 파일에 정상적으로 쓰고, 검증 뒤에 쓴 것은 **조용히 사라진다.** 그리고 "해시"가 무엇의 해시인지 없다: 파일 바이트의 해시는 SQLite→Postgres 이전에서 의미가 없고, 행 단위 해시는 정규 직렬화가 필요하다(AD-22의 코덱 문제 그대로).

> **제안 규칙 (AD-10 신규 문장 교체)**
> - 원본 이전은 `brain setup move-store` 하나다. 순서는 **동결 → 복사 → 검증 → 전환 → 백업**이다.
>   - **동결**: 원본 DB에 `store_state(frozen_at, moving_to)` 한 행을 쓴다. `withWrite`는 모든 쓰기 트랜잭션의 **첫 문장으로** 이 행을 확인하고, 동결 중이면 쓰지 않고 `STORE_FROZEN`으로 spool에 보낸다(AD-9). 트랜잭션 중간에 동결을 모르는 쓰기는 생기지 않는다.
>   - **검증**: 내보내기와 같은 정규 직렬화를 쓴다 — 테이블마다 멱등 키 순으로 JSON Lines를 만들고 그 sha256과 건수를 비교한다. 값은 Core의 ID·시각 코덱을 통과하므로 저장소 타입 차이에 영향받지 않는다(AD-22). 하나라도 어긋나면 전환하지 않는다.
>   - **전환**: 설정의 `[store]`를 새 위치로 쓴다. 그 뒤 옛 파일(과 `-wal`·`-shm`)을 0400으로 바꾼다. 동결은 전환이 끝난 뒤 해제하고, drain은 **해제 뒤에** spool을 새 원본으로 재주입한다(재주입 전 `schema_version` 확인).
>   - 중간에 죽으면 동결 행과 설정이 어긋난 상태가 남는다. doctor는 이것을 `STORE_MOVE_INCOMPLETE`로 보이고, 재실행이 같은 지점에서 이어 간다.

### H-10. 연동 해제가 Brain이 맡은 파일의 원본을 영구히 가둔다

**쌍:** U-dr(연동 해제) × U-mv

Deferred Drive 행: "연동 해제(Drive에 둔 채 연결만 끊음)". AD-23: Brain이 맡은 파일의 원본은 `home` 하나이고, Drive로 이전하면 **로컬 사본은 지워진다.** 그 뒤 연동을 해제하면 `home`은 Brain이 읽지도, 지우지도, 되돌리지도 못하는 위치다. "Brain이 맡은 파일"의 바이트가 Brain이 말을 걸 수 없는 저장소에 남고, AD-23에는 **되돌리는 방향이 없다**(이전은 로컬→Drive 한 방향으로만 적혀 있다).

> **제안 규칙 (AD-23 3번째 bullet에 추가 — H-2의 양방향 문장과 함께)**
> - 저장소 연결을 끊기 전에, 그 저장소에 `home`이 있는 Brain이 맡은 파일을 먼저 다른 저장소로 되돌린다(`files move-home --to local`). 사용자가 거절하면 그 파일들을 `home_unreachable`로 표시하고, 연동 해제 결과와 doctor가 건수와 합계 바이트를 보인다. 표시된 파일의 `document_chunks`는 그대로 검색된다(C-4).

---

## Medium

| # | 구멍 | 제안 규칙 (요지) |
| --- | --- | --- |
| M-1 | `[files] path`가 동기화 폴더일 수 있다. AD-10은 DB만 막았다. 그 안의 블롭은 Drive가 고치는 **두 번째 원본**이 되고, 이전의 "옛 위치 삭제"가 Drive 쪽 사본까지 지운다 | AD-23에: "`[files] path`는 동기화 폴더 안에 두지 않는다. `setup`이 확인하고 doctor가 `FILES_IN_SYNC_FOLDER`로 경고한다. Drive는 API로만 다루고 동기화 폴더를 통해 접근하지 않는다." |
| M-2 | 권한이 DB에만 있다(0600). 첨부는 비밀을 담는다(C-1) | AD-23에: "`[files] path`는 0700으로 만들고 블롭은 0600이다. doctor가 검사한다." |
| M-3 | AD-15의 trigram 하한(3자) 미만은 `LIKE` 순차 검색이다. "개인 규모에서 허용"은 대화 조각 기준이었다. epic 8의 5TB 파일 목록(수십만 행)에 2자 한글 폴더 이름을 넣으면 전체 스캔이다 | AD-15에: "`file_names`에 대한 2자 이하 질의는 `LIKE` 스캔 대신 거부하고 경고 `QUERY_TOO_SHORT`를 낸다. 파일 이름·경로 검색은 접두사·세그먼트 단위 보조 색인을 둔다." |
| M-4 | 형식 판정 기준이 없다. 확장자로 판정하면 `.pdf`로 이름만 바꾼 바이너리가 PDF 추출기로 가고, `unsupported`가 틀린다 | AD-24에: "형식은 **내용**으로 판정한다(magic bytes). 선언된 media type과 다르면 내용을 따르고 그 사실을 남긴다. 판정 불가는 `unsupported`다." |
| M-5 | `file_locations`의 작성자가 "파일 저장·이전"이라는 **함수 아닌 이름**이다. Table Contract의 다른 모든 행은 API 이름을 적는다 | Table Contract: 작성자를 `core files.put` / `drain:attachment_fetch` / `drain:file_move_home` / `drain:file_blob_delete`로 적는다. 변경 가능성은 "`verified_at`·`deleted_at`은 단조". |
| M-6 | Drive 업로드의 ack를 잃으면 재시도가 **두 번째 원격 블롭**을 만든다(Drive는 같은 이름의 사본을 허용하고 파일 ID가 달라진다). 지우는 쪽은 자기가 아는 위치만 지운다 | epic 8 규칙으로: "업로드는 먼저 `file_locations`에 의도 행(`state='uploading'`, locator는 resumable 세션 토큰)을 만들고, 재시도는 재업로드가 아니라 이어받기다. Brain 전용 폴더의 원격 이름은 `content_hash`이므로 목록 비교로 고아를 찾는다(`file_orphan_sweep`의 원격 판)." |
| M-7 | `files.redact` 이후 같은 내용이 다시 첨부되면 어떻게 되는가, `missing_at_ingest`가 나중에 복구될 수 있는가가 없다 | C-1·H-7의 규칙에 포함(`FILE_REDACTED` 경고, `missing_at_ingest`는 재시도 대상 아님 — 사람이 `files` 경로로 다시 넣는다). |

---

## Currency (Y-1) — 추출 라이브러리를 Stack에 박아야 하는가

**결론: 박아야 한다. 지금.** 두 가지 이유가 구조적이다.

1. `extractor_version`은 **스키마 값**이다. `document_chunks`의 멱등 키(그리고 C-5 제안의 세대 교체)가 그 값에 걸려 있다. 라이브러리를 스토리 단계에서 고르면 **스키마에 들어가는 값이 스토리 재량으로 정해진다.**
2. 추출기를 바꾸면 "버전을 올리고 원본에서 다시 만든다"(AD-24)가 발동한다. 즉 `pnpm up`으로 올라간 patch 하나가 **전체 재추출 또는 조용한 세대 혼합**을 만든다. 버전이 Stack에 박혀 있고 `extractor_version` 상수가 그 버전을 포함해야 그 사건이 의도적으로만 일어난다.

### 후보 (2026-10-14 npm registry 실측, `npm view`)

| 쓸 곳 | 추천 | 버전 / 최근 발행 | 근거 |
| --- | --- | --- | --- |
| PDF 텍스트 | **`pdfjs-dist`** (legacy build, `getTextContent()`) | 6.4.299 / 2026-10-03, Apache-2.0, `engines.node >=22.13.0 \|\| >=24` | Mozilla 본가, 활발. 네이티브 의존 없음. **쪽 번호가 공짜로 나와** AD-24의 "조각마다 위치(쪽)"를 그대로 만족한다 |
| PDF 텍스트 (얇은 래퍼 선호 시) | `unpdf` | 1.8.1 / 2026-08-13, MIT, `node >=22` | pdfjs serverless 빌드를 감싸고 `extractText({ mergePages: false })`로 쪽별 배열을 준다. adapter 코드가 몇 줄로 줄지만 의존이 한 겹 늘어난다 |
| docx | **`mammoth`** (`extractRawText`) | 1.13.0 / 2026-09-26, BSD-2-Clause, 순수 JS | 필요한 것이 정확히 raw text다. 의존은 jszip·@xmldom/xmldom 등 순수 JS |
| 형식 판정 (M-4) | **`file-type`** | 22.1.1 / 2026-09-17, MIT, `node >=22` | 확장자 대신 내용으로 판정해야 `unsupported`가 참이 된다 |
| EXIF | **`exif-reader`** | 2.0.3 / 2025-12-12, MIT, 의존 없음 | 작고 유지보수 중(`sharp`가 쓰는 것). 네이티브 없음 |
| EXIF (HEIC까지 필요하면) | `exifr` | 7.1.3 / **2022-05-01 (정체)**, 의존 없음 | HEIC·GPS 파싱이 강하다(아이폰 사진). **4년 넘게 발행 없음** → 박지 말고 Deferred의 "다시 볼 때"에 적는다 |

**피할 것**

- `pdf-parse` 2.4.5 (2025-10-29): `pdfjs-dist@5.4.296`을 **고정**하고 `@napi-rs/canvas@0.1.80`(네이티브 바이너리)를 끌고 온다. `npx github:` 설치 흐름(AD-2, AD-19)에 네이티브 빌드를 들이는 것은 설치 실패 표면을 넓힌다.
- `office-text-extractor` 4.0.0 (2025-12-26): 의존에 **CDN tarball URL**(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`)이 있고 `pdf-parse`·`text-encoding`을 끌고 온다. 공개 저장소의 설치 흐름에 재현성·공급망 위험을 더한다.
- `@opendocsg/pdf2md` 0.3.4: Markdown 변환이라 한 겹 더 가공한다. 우리는 raw text와 쪽 번호만 필요하다.
- `sharp` 0.35.5: EXIF만 쓰기에는 네이티브 바이너리가 과하다.

### 제안 (Stack 표에 4행 추가 + AD-24에 1문장)

> | Name | Version |
> | --- | --- |
> | PDF 텍스트 추출 | `pdfjs-dist` 6.4.299 (legacy build, `getTextContent()`. 2026-10-03 발행, Apache-2.0, node >=22.13 \|\| >=24. 네이티브 의존 없음) |
> | docx 텍스트 추출 | `mammoth` 1.13.0 (`extractRawText`. 2026-09-26, BSD-2-Clause, 순수 JS) |
> | 형식 판정 | `file-type` 22.1.1 (2026-09-17, MIT) |
> | EXIF | `exif-reader` 2.0.3 (2025-12-12, MIT, 의존 없음. HEIC가 필요해지면 `exifr`를 다시 본다 — 2022-05-01 이후 발행 없음) |
>
> (AD-24) `extractor_version`은 Core의 상수 하나이고 **추출 라이브러리 버전을 포함한 문자열**이다(예: `doc/1+pdfjs-6.4.299+mammoth-1.13.0`). 라이브러리를 올리면 이 상수를 바꾸고, 그것이 재추출을 일으킨다. 상수를 바꾸지 않고 라이브러리만 올리는 변경은 금지다(doctor가 실행 중 버전과 상수를 대조한다).

> Deferred에 추가: "`pdfjs-dist` major 올림, HEIC EXIF(`exifr` 정체), xlsx·pptx 텍스트 | 재추출 비용이 커지거나 놓치는 문서가 쌓일 때. 추출기 교체는 `extractor_version`과 세대 교체(AD-24)로 흡수한다"

---

## 닫는 순서 제안

| 언제 | 무엇 |
| --- | --- |
| story 1.10 스키마 전 (되돌릴 수 없음) | C-2(`ownership`을 위치로), C-3(내용 주소 locator), C-5(`document_extractions` + 세대), H-7(`(message_id, ordinal)`), H-1(해시 표기), H-2(`home` 참조), H-6(`file_metadata`·촬영 일시 3칸), H-4(`file_names`) |
| epic 2 착수 전 | C-1(추출 시점 마스킹 + `files.redact`), C-3의 고아 회수, H-5(쓰기 배치·상한), M-2·M-4 |
| epic 4 착수 전 | C-6(표면·결과 계약), M-3 |
| epic 5 착수 전 | C-4(내보내기·복구), H-8(launchd 신원·관측), M-1 |
| epic 7·8 envelope에 기록 | H-3(루트 봉쇄), H-9(동결·검증), H-10(되돌리기), M-6 |
| Stack | Y-1 (지금) |
