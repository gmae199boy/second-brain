---
review: architecture-spine rubric review (change-local-sqlite-primary §4.6 반영분)
target: ../architecture-brain-v1-slice-1.md
sources:
  - ../.memlog.md
  - ../../change-local-sqlite-primary/change-local-sqlite-primary.md
  - ../../spec-brain-v1-slice-1/spec-brain-v1-slice-1.md
  - 'brownfield: packages/core, packages/postgres, apps/cli, package.json, pnpm-workspace.yaml'
reviewed: 2026-10-14
verdict: '조건부 통과 — 문구 치환은 빠짐없지만, Postgres가 "타입·서버·세션 잠금"으로 공짜로 지켜 주던 불변식 네 개가 SQLite에서는 집행자가 없다. C-1~C-3, H-4, H-5를 메우기 전에 /bmad-build 1.10을 시작하면 story 1.10이 스스로 정하게 된다'
---

# Spine 리뷰 — Personal Brain V1 slice 1, SQLite 원본 전환분 (good-spine 체크리스트)

## 판정

**조건부 통과.** §4.6의 치환 목록은 거의 그대로 반영됐고, 문자열 수준의 Postgres 잔재는 없다(`pg_trgm`·`timestamptz`·advisory·`SKIP LOCKED`·`ILIKE`·`DATABASE_URL`·GUC 전부 0건. 남은 Docker·pgvector·`서버` 언급은 모두 "복제 대상(epic 7)" 또는 "필요 없다"는 서술이라 정상이다). AD-10의 원본 1 + 복제 N 규칙, AD-7의 claim/`RETURNING` 일감 모델, AD-9의 넓어진 spool 조건, AD-15의 3글자 미만 `LIKE` 예외는 아래 층이 혼자 정하면 갈라질 지점을 정확히 집었다.

문제는 **문구가 아니라 집행자**다. 원본이 Postgres였을 때 다음 네 가지는 DB가 공짜로 지켜 줬다.

| 불변식 | Postgres에서의 집행자 | SQLite에서 지금 누가 집행하나 |
| --- | --- | --- |
| 원문 불변 (AD-11) | UPDATE trigger + `ON CONFLICT DO UPDATE`가 걸림 | **없음.** `INSERT OR REPLACE`가 trigger를 건너뛴다(실측) |
| 시각·ID 형식 (AD-13, Conventions) | `timestamptz`·`uuid` 타입 | **없음.** TEXT는 아무 문자열이나 받는다 |
| 쓰기 직렬화 (AD-7) | 서버의 advisory lock, 기본 재시도 | **없음.** Kysely sqlite 드라이버는 `begin`(deferred)을 쓰고(실측) `busy_timeout` 기본값은 0이다 |
| "원본은 하나" (AD-10) | 없는 DB에 접속하면 실패 | **없음.** `node:sqlite`는 없는 파일을 조용히 만든다(실측) |

여기에 spec CAP-2가 요구하는 "가린 값이 **내보내기·미러 어디에도** 없다"가 AD-11에서는 미러만 다루고 조각·FTS·임베딩·내보내기를 다루지 않는다(C-2). 그리고 §2에서 합의된 doctor의 `store` 항목(파일 열림·WAL·FTS5)이 §4.6 목록에 없어서 **어느 AD에도 안 들어갔다**(H-4). story 1.8의 verify는 그 항목을 요구하는데 spine은 침묵한다.

C-1~C-3·H-4·H-5는 전부 "story 1.10이 혼자 정하면 다른 story가 모르는 규칙이 생기는" 종류다. 다섯 건은 각각 한두 줄이면 메워진다.

## 체크리스트 요약

| 항목 | 판정 | 비고 |
| --- | --- | --- |
| 아래 층의 실제 분기점을 빠짐없이 고정 | **미흡** | 원문 불변의 SQLite 집행 방식(C-1), redact 전파 범위(C-2), 쓰기 트랜잭션 단일 통로(C-3), doctor의 store 항목(H-4), FTS 유지 주체(M-9)가 비어 있다 |
| 모든 AD의 Rule이 집행 가능하고 분기를 실제로 막음 | **부분** | AD-11(trigger 우회 가능), AD-10("파일 생성은 설치기만"이 집행 불가), AD-7("연결마다 WAL"은 read-only 연결에서 성립 안 함, `BEGIN IMMEDIATE`의 주인 없음) |
| 바뀐 AD ↔ 안 바뀐 AD 일관성 | **부분** | AD-16(미러 쓰기를 잠금 안에서)이 DB 단위 잠금이 된 AD-7과 충돌(H-6). AD-8의 자연 멱등 키가 AD-11의 trigger를 우회하는 구현을 유도(C-1) |
| Deferred에 분기 여지 없음 | **부분** | "두 번째 기계"·"팀 공유(원문 포함, 누구나 검색)"가 AD-10의 "읽기·검색은 원본에서만"·"복제 대상은 원본이 될 수 없다"와 정면으로 부딪친다. 기계 교체 복구 경로도 없다(M-8) |
| 명시 기술이 최신인지 | **양호** | 2026-10-14 재확인: Node LTS 24.21.0, kysely 0.29.6, commander 15.0.0, @clack/prompts 1.8.1, pg 8.23.1, typescript 7.0.2, pnpm 12.11.2 일치. 이 Mac에서 `node:sqlite` 3.53.0 / FTS5 trigram / `loadExtension` / 실험 경고 없음 독립 재현. 패치 드리프트 3건(L-10) |
| 브라운필드를 비준(모순 아님) | **부분** | Conventions의 "DB는 TEXT·ISO-8601"이 계속 돌아야 하는 `packages/postgres`(uuid·timestamptz)와 모순(M-7). Core의 `StoreHealth.serverVersion`·`StoreVectorHealth`가 아직 서버 DB 모양(H-4) |
| spec 커버리지 (CAP-1~13) | **부분** | CAP-1,3~13 커버. **CAP-2의 "내보내기 어디에도 원래 값이 없다"가 미커버**(C-2) |
| 고도가 소유한 모든 차원이 결정/연기/열린 질문 | **부분** | 새로 생긴 "단일 파일" 차원 중 미결: 파일 생성 금지 집행, 파일 권한, `-wal`/`-shm` 사이드카 수명, 무결성 점검, SQLite 최소 버전 검사 |
| 결정 중심·간결·mermaid 유효 | **양호** | 다이어그램 4개 문법 유효. 서술 간결. 잔재 1건(참가자 id `PG`) |

---

## Critical

### C-1. AD-11의 불변 trigger는 SQLite에서 `INSERT OR REPLACE`를 막지 못한다 (line 181)

AD-11은 "`messages`와 `tool_notes`는 UPDATE·DELETE를 거부하는 DB trigger를 가진다"로 끝난다. SQLite에서 이 문장은 **집행되지 않는다**. `PRAGMA recursive_triggers`의 기본값이 OFF이고, 그 상태에서 `INSERT OR REPLACE`가 UNIQUE 충돌로 유발하는 암묵적 DELETE는 DELETE trigger를 발화시키지 않는다.

이 Mac에서 실측(Node 24.16.0, SQLite 3.53.0):

```
recursive_triggers=off -> INSERT OR REPLACE SUCCEEDED, row now: [{"id":"b","session_id":"s","seq":1,"body":"TAMPERED"}]
recursive_triggers=on  -> blocked: immutable
ON CONFLICT DO UPDATE  -> blocked: immutable
```

즉 기본 설정에서 저장된 원문이 **조용히 다른 내용으로 바뀐다.** AD-11이 막겠다고 적어 둔 바로 그 "코드 실수로 원문이 바뀌는 것"이다.

더 나쁜 것은 AD-8이 이 구현을 **유도한다**는 점이다. AD-8은 "테이블마다 자연 멱등 키를 UNIQUE 제약으로 둔다"와 "같은 배치를 두 번 넣으면 건수가 같다"를 요구한다. SQLite에서 그 요구를 가장 짧게 만족시키는 코드가 `INSERT OR REPLACE`다. story 1.10의 에이전트가 계약 테스트("두 번 넣어도 건수가 같다")를 통과시키려고 `OR REPLACE`를 쓰면, 테스트는 초록이고 원문 불변은 무너진다 — 그리고 아무 경고도 나지 않는다.

**제안 수정 (AD-11 Rule에 두 줄):**
- "멱등 삽입은 `INSERT … ON CONFLICT DO NOTHING`만 쓴다. `INSERT OR REPLACE`·`REPLACE INTO`·`ON CONFLICT DO UPDATE`는 `messages`·`tool_notes`에 금지다."
- "첫 마이그레이션과 모든 연결에서 `PRAGMA recursive_triggers=ON`을 켠다(C-3의 단일 연결 함수가 건다)."
- 계약 테스트에 한 줄 추가: "`INSERT OR REPLACE`로 같은 멱등 키를 다시 넣으면 거부된다."

(Postgres adapter는 `ON CONFLICT DO UPDATE`가 UPDATE trigger에 걸리므로 이미 안전하다. 즉 이것은 SQLite 전용 보강이고, 계약 테스트는 양쪽에서 같은 동작을 고정한다.)

### C-2. 가리기가 조각·FTS·임베딩·내보내기로 전파되지 않는다 — spec CAP-2 미충족 (line 181)

AD-11은 redact 후 "가린 세션의 **미러는** 다시 만든다"로 끝난다. 그런데 본문 사본은 미러에만 있는 게 아니다.

- `chunks.body`에 메시지 원문이 그대로 들어간다(AD-15 "조각은 항상 만든다", Table Contract `chunks` = 파생).
- AD-15가 `chunks.body`에 FTS5 trigram 색인을 두므로 **FTS 내부 인덱스에도 사본이 남는다**(trigram은 원문에서 뽑은 3글자 조각을 저장한다).
- 임베딩을 켠 경우 `embeddings`가 그 조각으로 만들어져 있다.
- Conventions의 내보내기는 "테이블당 JSON Lines 하나"다 → `chunks`가 포함되므로 **내보내기 파일에 가린 값이 그대로 들어간다.**

spec CAP-2의 success는 "저장된 메시지의 일부를 가리면 **DB·미러·내보내기 어디에도** 원래 값이 남지 않고, 위치·종류·시각만 남는다"다. 지금 spine을 그대로 구현하면 이 문장이 거짓이 된다. AD-11의 Prevents("비밀이 영구히 남는 것")도 마찬가지다.

**제안 수정 (AD-11 Rule):**
- "redact는 같은 트랜잭션에서 그 세션의 조각·FTS 행을 지우고, drain 일감으로 다시 만든다(임베딩도 같은 경로). 미러는 지금처럼 다시 만든다. 재생성 전까지 그 세션의 검색 결과에는 `UNINDEXED`를 붙인다."
- Conventions 내보내기 행에 "파생 테이블(`chunks`·`embeddings`·FTS)은 내보내지 않는다. 복구는 원문·로그에서 다시 만든다"를 명시(지금은 "복구는 … 파생 테이블은 다시 만든다"로 복구 쪽만 말하고, 내보내는 쪽은 "테이블당 하나"라 읽힌다).

### C-3. AD-7의 `BEGIN IMMEDIATE`·`busy_timeout`에 집행 주인이 없고, 기본값이 반대로 동작한다 (line 134~135)

AD-7은 "데이터를 쓰는 모든 경로는 SQLite 쓰기 트랜잭션(`BEGIN IMMEDIATE`)을 잡는다", "연결마다 `journal_mode=WAL`과 `busy_timeout`을 건다"고만 쓴다. 세 가지가 집행 불가다.

1. **`BEGIN IMMEDIATE`는 Kysely의 기본 경로가 아니다.** kysely 0.29.6의 sqlite 드라이버는 `dist/dialect/sqlite/sqlite-driver.js:27`에서 `CompiledQuery.raw('begin')`을 보낸다 — deferred다. 즉 story 1.10이 Stack에 적힌 Kysely로 `db.transaction().execute(...)`를 쓰면 **규칙을 어긴다는 신호 없이** deferred 트랜잭션이 열린다. deferred에서 읽은 뒤 쓰기로 승격할 때 다른 프로세스가 먼저 쓰면 `SQLITE_BUSY_SNAPSHOT`이고, 이건 `busy_timeout`으로 해결되지 않는 즉시 실패다. 그 실패가 AD-9에 따라 spool로 가면 "DB에 쓸 수 없음"으로 보고되고, 원인(규칙 위반)은 어디에도 안 남는다.
2. **`busy_timeout` 기본값은 0이다**(실측). 값이 spine에 없으므로 story마다 다르게 걸거나 빼먹는다. 빼먹은 경로는 겹친 수집 때 즉시 실패 → spool → NFR-2의 "조용한 실패 금지"는 지키지만 NFR-7 지연과 "정확성은 drain이 보장"이라는 전제가 흔들린다.
3. **"연결마다 `journal_mode=WAL`"은 Postgres식 사고의 잔재다.** WAL은 파일 헤더에 영구 기록되는 속성이고, 연결 단위가 아니다. 읽기 전용으로 연 연결은 `journal_mode`를 바꿀 수 없다(쓰기 권한 필요). 반대로 진짜 연결 단위인 것은 `busy_timeout`·`foreign_keys`·`recursive_triggers`·`synchronous`다.

**제안 수정 (AD-7 Rule):**
- "원본에 대한 연결은 `packages/sqlite`의 함수 하나(`openStore`)만 만든다. 그 함수가 `busy_timeout=<값, 예: 5000>`·`foreign_keys=ON`·`recursive_triggers=ON`을 건다. WAL은 파일 속성이므로 설치기·마이그레이션이 한 번 건다."
- "쓰기는 `withWrite()` 하나로만 한다. 이 함수가 `BEGIN IMMEDIATE`를 내고 커밋·롤백을 맡는다. Kysely의 기본 `transaction()`은 deferred `begin`을 내므로 쓰기 경로에서 쓰지 않는다(story 1.10의 dialect 연결 작업에 포함)."
- 계약 테스트: "쓰기 경로를 두 프로세스에서 겹쳐 돌리면 하나는 기다렸다 성공하고, `busy_timeout` 초과만 spool로 간다."

---

## High

### H-4. §2에서 합의된 doctor의 `store` 항목이 어느 AD에도 없다 (AD-19 line 276, AD-20 line 283~286)

change proposal §2 기술 항목은 "doctor의 `db`·`pgvector` 항목은 `store`(파일이 열리는지, WAL, FTS5)로 바뀐다"고 적었고, §4.1의 story 8 NEW description·verify도 그것을 요구한다. 그런데 §4.6의 치환 목록에 이 줄이 없었고, 결과로 **spine의 doctor 항목 집합에 store가 없다.** 현재 spine이 말하는 doctor는 shim·node 경로·마지막 hook 수신(AD-19), 스키마 버전·내보내기 경과(AD-20), spool 건수(AD-9), 주입 시도 비율(AD-17), `INDEX_CONFIG_MISMATCH`(AD-15)뿐이다. story 1.8을 받는 에이전트는 spine과 ticket이 다른 것을 말하는 상태에서 항목을 스스로 정한다.

같은 자리에 비어 있는 것이 더 있다. 원본이 로컬 파일 하나가 되면서 생긴 차원인데 아무 AD도 소유하지 않는다.

- **SQLite 최소 버전 검사.** Stack은 "SQLite 3.53 이상, FTS5 `trigram`"을 요구하지만, `engines.node >= 24`로는 그것을 보장할 수 없다 — `node:sqlite`가 품은 SQLite 버전은 Node 패치 버전마다 다르고, 사용자는 24.0을 쓸 수도 있다. 런타임 검사가 없으면 FTS5 가상 테이블 생성 실패나 trigram 미지원이 story 1.10의 마이그레이션 중에 터진다.
- **무결성 점검.** 기계 밖 사본이 내보내기뿐인 단일 파일 원본인데, `PRAGMA quick_check`/`integrity_check`를 아무도 돌리지 않는다. Postgres 시절에는 서버가 할 일이었다.
- **Core의 health 포트가 아직 서버 DB 모양이다.** `packages/core/src/ports/store.ts`의 `StoreHealth`는 `ok: true`일 때 `serverVersion: string`과 `vector: StoreVectorHealth`("Version the server offers")를 **필수로** 요구하고, `packages/core/src/admin/doctor.ts`의 `runDoctor`는 그 두 값으로 `db`·`vector` 항목을 만든다. AD-10은 "Store port의 모든 구현(sqlite, postgres)은 하나의 공통 계약 테스트를 통과한다"고 하는데, 이 모양 그대로면 SQLite 구현은 없는 서버 버전과 없는 벡터 확장을 꾸며 내야 한다.

**제안 수정:** AD-20 Rule(또는 AD-19 doctor 줄)에 "doctor는 `store` 항목으로 원본 파일 열림·`journal_mode=wal`·FTS5 trigram 사용 가능·`sqlite_version` 최소값·`quick_check`를 검사한다. 벡터 항목은 epic 6·7로 간다"를 넣고, AD-10에 "health 보고는 중립 이름(`engineVersion`, 선택 벡터 능력)이고, 서버 개념을 요구하지 않는다"를 한 줄 덧붙인다(= story 1.10이 Core 포트를 고쳐도 된다는 허가).

### H-5. AD-10의 "파일 생성은 설치기만"은 집행 불가하고, 그 결과가 바로 "원본이 둘" 이다 (line 173)

AD-10은 "DB 파일 생성과 마이그레이션은 설치기·`setup`에만 있다"로 끝난다. `node:sqlite`의 기본 동작은 그 반대다 — 없는 경로를 열면 **빈 파일을 만들고 성공한다**(실측: `new DatabaseSync('t1.db')` → FILE CREATED).

따라서 `[store] path`가 오타거나, 설치기가 쓴 경로와 다른 `SECOND_BRAIN_HOME`으로 hook이 돌면, 런타임 명령이 **새 빈 원본을 만든다.** 그 다음 일어나는 일은 `checkSchema`의 `found: null` → `SCHEMA_MISMATCH` → AD-9에 따라 전부 spool이다. 사용자에게는 "DB에 쓸 수 없음"으로 보이고, 실제 원인("원본이 둘이 됐다")은 어디에도 안 나온다. AD-10이 첫 줄에 적은 Prevents("원본이 둘이 되어 갈라지는 것")가 바로 이 경로로 뚫린다.

집행 수단은 있다. URI 파일명을 쓰면 없는 파일에서 깨끗하게 실패한다(실측):

```
new DatabaseSync('file:t2.db?mode=rw')  -> throws: unable to open database file
```

**제안 수정 (AD-10 Rule):** "런타임은 원본 파일을 만들지 않는다. 열 때 `file:<path>?mode=rw`로 열어 없으면 실패하고, `DB_UNAVAILABLE`에 '원본 파일이 없음, `brain setup run`을 돌려라'를 담는다. 파일을 만드는 것은 설치기·`setup`뿐이다." (Conventions의 경고 코드 목록은 그대로 `DB_UNAVAILABLE`로 충분하지만, 메시지가 경로를 반드시 포함해야 한다.)

### H-6. AD-16(안 바뀐 AD)이 DB 단위 잠금이 된 AD-7과 충돌한다 (line 239, line 134)

AD-16은 "쓰기는 항상 전체 교체(임시 파일 → rename)이고, **세션 잠금(AD-7) 안에서** 한다"고 쓴다. AD-7의 잠금이 세션 단위 advisory lock이던 시절에는 합리적이었다. 지금 AD-7의 잠금은 **데이터베이스 단위**다. 그래서:

- 미러 파일 쓰기(파일시스템 I/O)를 기계 전체의 **유일한 쓰기 잠금을 들고** 수행한다.
- `admin.mirror-rebuild`는 세션 N개를 돌며 N번 파일을 쓴다. 그 동안 모든 수집·로그 쓰기가 `busy_timeout`을 태우고, 초과하면 spool로 간다.
- 최악은 동기 경로다. AD-6은 시작 hook을 "동기, 짧은 timeout"으로 두고 NFR-3·NFR-7을 거기에 걸었다. 그 hook의 `sessions.ensure`가 미러 재생성이 들고 있는 DB 잠금을 기다린다.

change proposal은 AD-16을 "그대로인 것"으로 분류했는데, AD-7이 바뀌면서 전제가 사라졌다.

**제안 수정 (AD-16 Rule):** "미러는 읽기 스냅샷으로 내용을 정한 뒤, 쓰기 잠금 **밖에서** 임시 파일 → rename 한다. 같은 세션의 미러를 두 프로세스가 같이 쓰는 것은 세션의 미러 세대(또는 `ingested_at`) 비교로 막는다 — 더 낮은 세대의 쓰기는 버린다." 또는 AD-7에 "쓰기 트랜잭션 안에서 파일시스템 I/O·네트워크를 하지 않는다"를 불변식으로 추가(이쪽이 더 짧고, 다른 story에도 똑같이 걸린다).

---

## Medium

### M-7. Conventions의 시각·ID 행이 보존하기로 한 Postgres adapter와 모순되고, 형식 불변식의 집행자를 잃었다 (line 339~340)

두 문제가 겹쳐 있다.

**(a) 모순.** Conventions는 이제 "ID: UUIDv7, **DB에서는 TEXT**(정규 소문자 문자열)", "시각: **DB는** UTC ISO-8601 텍스트(밀리초, `Z`)"라고 단정한다. 그런데 `packages/postgres/migrations/0001_initial.sql`은 `uuid`와 `timestamptz`를 쓰고, change proposal §5의 성공 기준은 "Postgres 계약 테스트도 계속 통과한다"다. 즉 spine이 지금 브라운필드를 부정한다. 규칙이 걸려야 하는 자리는 "DB"가 아니라 **port 경계**다.
- 제안: "port 경계에서의 표현은 UUIDv7 문자열과 UTC ISO-8601(밀리초, `Z`)이다. 저장 타입은 adapter가 정한다(SQLite는 TEXT, Postgres는 `uuid`·`timestamptz`). 계약 테스트가 경계 표현을 고정한다."

**(b) 집행자 상실.** TEXT 저장에서 "정규 소문자 UUID"와 "밀리초·`Z` 고정"은 **관례일 뿐 제약이 아니다.** 이게 실제로 깨뜨리는 것:
- 시각이 TEXT라 범위 조회(FR-12, AD-13)는 **문자열 비교**로 돈다. 한 경로가 오프셋 포함(`+09:00`)이나 밀리초 생략 값을 하나 쓰면 정렬·범위가 조용히 틀린다. `timestamptz`가 막아 주던 일이다.
- ID가 TEXT라 대문자/중괄호 UUID 한 건이 들어가면 조인이 조용히 비어 온다. `uuid` 타입이 정규화해 주던 일이다.
- 제안: AD-13 또는 Conventions 마이그레이션 행에 "첫 마이그레이션은 CHECK 제약으로 형식을 고정한다 — 시각은 길이 24의 `YYYY-MM-DDTHH:MM:SS.sssZ`, ID는 소문자 정규 UUID 36자"를 넣는다. 한 줄이면 집행자가 DB로 돌아온다.

### M-8. Deferred의 "두 번째 기계"·"팀 공유"가 AD-10의 읽기 규칙과 정면 충돌한다 (line 426, 433 ↔ line 170)

AD-10은 "**읽기·검색은 원본에서만 한다**"와 "복제 대상은 원본이 될 수 없다"를 못 박았다. Deferred는 같은 문서에서 두 가지를 약속한다.

- "두 번째 기계 — `machine` 칸과 멱등 키로 수용": 기계 둘은 로컬 원본 둘이다. 기계 A에서 기계 B의 세션을 찾으려면 복제 대상을 읽어야 하고, 그건 AD-10 위반이다. 반대로 규칙을 지키면 **교차 기계 검색은 영구히 불가능**해지는데, 그 말은 어디에도 없다.
- "팀 공유(원문 포함)": memlog의 확정 방향은 "모두의 세션이 팀 저장소에 쌓이고 **누구나 검색**"이다. 이것도 복제 대상 읽기다.
- **기계 교체 복구 경로가 없다.** NFR-9는 Capability Map에서 "내보내기·복구, 이후 복제 대상"으로 커버된다. Mac이 죽었을 때 Drive 복제본에서 되살리는 것은 사실상 "복제 → 원본 승격"인데 AD-10이 금지한다. §4.6은 Deferred에 "복제 대상과 **승격**"을 넣으라고 했지만, 반영된 Deferred 행(line 425)에는 승격이 없다.

epic 7 에이전트는 "읽기는 원본만"과 "누구나 검색"을 동시에 만족시킬 수 없으므로 하나를 자기 판단으로 고르게 된다 — Deferred가 분기를 허용하는 상태다.

**제안 수정:** AD-10에 한 줄 — "복제 대상 읽기는 '원본 검색'이 아니다. 필요해지면 별개의 보조 store로 명시적으로 열고, 결과에 출처 기계를 붙인다. 복제 대상에서 새 원본을 만드는 것(승격·기계 교체 복구)은 epic 7의 별도 결정이며, 그때까지 기계 밖 복구 원천은 `admin.export`뿐이다." Deferred의 "두 번째 기계" 행과 "팀 공유" 행에 이 줄을 가리키게 한다.

### M-9. AD-15가 FTS5 색인을 **누가 언제** 유지하는지 정하지 않는다 (line 222)

"`chunks.body`, `log_entries.text`, `tool_notes.target`에 FTS5 `trigram` 색인을 둔다"는 Postgres 어휘다(GIN은 컬럼에 붙는 인덱스다). FTS5는 **별도 가상 테이블**이고, 원본 테이블과의 동기화는 공짜가 아니다 — external-content 테이블 + 트리거, 또는 쓰는 코드가 직접 넣기 중 하나를 골라야 한다.

지금 세 테이블의 작성자가 전부 다르다: `tool_notes`는 `sessions.ingest`, `log_entries`는 `log.append`(+`log.edit`로 본문이 **바뀐다**), `chunks`는 drain. 선택을 spine이 안 하면 story마다 다른 방식이 되고, 한 경로가 FTS 삽입을 빼먹으면 **검색이 빈 결과를 성공으로 돌려준다** — AD-15의 Prevents 첫 줄 그대로다. `log.edit`은 특히 위험하다: 본문이 바뀌는 유일한 색인 대상인데 FTS 갱신 책임자가 없다.

**제안 수정 (AD-15 Rule):** "FTS5는 content-less/external-content 가상 테이블 하나로 두고, 원본 테이블의 INSERT·UPDATE trigger가 같은 트랜잭션에서 유지한다(코드가 직접 넣지 않는다). `log.edit`은 그 trigger로 색인이 따라간다. 계약 테스트: 세 테이블에 쓴 직후 같은 트랜잭션 밖에서 그 내용이 검색된다."

---

## Low / nits

### L-10. 자잘한 잔재와 빈칸

1. **시퀀스 다이어그램 참가자 id가 아직 `PG`다** (line 117: `participant PG as brain.db (SQLite)`). 라벨만 바꿨다. `participant DB as brain.db (SQLite, WAL)`로.
2. **WAL 사이드카 파일이 어느 규칙에도 없다.** WAL을 켜면 `brain.db-wal`·`brain.db-shm`이 생긴다. AD-20의 `setup uninstall`은 "원본 DB 파일(`brain.db`)과 데이터 폴더"만 말하고, 내보내기·백업도 `brain.db`만 말한다. `brain.db`만 지우고 `-wal`을 남기면 다음 열기에서 깨지거나 지웠다고 생각한 데이터가 되살아난다. "원본은 `brain.db`와 그 사이드카(`-wal`·`-shm`)를 묶어 하나로 다룬다"를 AD-10 또는 AD-20에.
3. **원본 파일 권한 규칙이 없다.** AD-18은 `.env`를 0600으로 다루게 만들었고(코덱은 home을 0700으로 만든다), 이제 **모든 대화 원문이 디스크의 한 파일**에 있다. AD-11이 마스킹까지 하는 데이터다. "원본 파일은 0600으로 만든다"를 AD-10이나 AD-19 3단계에.
4. **Structural Seed가 브라운필드의 `tooling/`을 빠뜨렸다.** `pnpm-workspace.yaml`은 `tooling/*`를 포함하고, 루트 `package.json`의 `bin`은 `tooling/bootstrap/bin/second-brain.js`(story 1.5의 `npx` 진입점)다. AD-2가 그 진입점을 규칙으로 갖고 있으니 Seed에도 `tooling/bootstrap/`을 한 줄 넣는 게 맞다.
5. **§4.6의 한 줄이 떨어졌다**: AD-10에 넣기로 한 "Runtime은 서버를 띄우거나 설치하지 않는다". slice 1에서는 무해하지만, epic 7에서 설치기의 Docker 흐름이 돌아올 때 "누가 서버를 띄우나"를 다시 논쟁하게 된다. 지금 넣어 두는 쪽이 싸다.
6. **Stack 패치 드리프트 3건**(2026-10-14 `npm view` 재확인): `smol-toml` 1.9.0 → **1.9.1**, `uuid` 14.0.2 → **14.0.3**, `vitest` 5.0.3 → **5.0.4**. 나머지는 전부 일치(Node LTS 24.21.0, TS 7.0.2, pnpm 12.11.2, kysely 0.29.6, commander 15.0.0, @clack/prompts 1.8.1, pg 8.23.1, pgvector 0.8.7). 또 `sqlite-vec`는 현재 **0.1.9**로 1.0 전이다 — AD-15가 "확장 로딩은 착수할 때 검증한다"로 이미 덮지만, Stack 행에 "0.1.x(1.0 전)"를 적어 두면 epic 6의 기대치가 맞춰진다.
7. **AD-11의 "Store 구현마다 방식은 다르고, 계약 테스트가 동작을 고정한다"는 좋은 처리**지만, 그 trigger 우회 표시가 **같은 연결·같은 트랜잭션 안에서만 유효**해야 한다는 조건이 SQLite에서 무엇으로 성립하는지(temp 테이블 행? 트랜잭션 안에서 쓰고 지우는 보통 테이블 행?) 한 단어도 없다. story 1.10이 정하는 것은 합의됐으니 Critical은 아니지만, "표시는 프로세스 밖에서 보이지 않아야 한다(temp 테이블 등)"는 제약 한 줄은 spine에 있는 게 안전하다 — 보통 테이블에 쓰면 WAL에 남고, 크래시 후 표시가 살아 있으면 불변 trigger가 영구히 열린다.

---

## 잘 반영된 것 (되돌리지 말 것)

- **문자열 스윕이 깨끗하다.** `pg_trgm`·`timestamptz`·advisory·`SKIP LOCKED`·`ILIKE`·`DATABASE_URL`·GUC·`uuid` 타입 언급 0건. 남은 Docker·pgvector·`서버` 6건은 전부 "복제 대상(epic 7)" 또는 "필요 없다"는 맥락으로 정당하다.
- **AD-7의 일감 모델**을 `SKIP LOCKED` 없이 "IMMEDIATE 트랜잭션 안의 `UPDATE … claimed_at … WHERE 미청구(또는 청구 만료) RETURNING`"으로 바꾼 것은 SQLite에서 실제로 되는 방식이고, 청구 만료까지 넣어 멈춘 프로세스의 일감이 영구히 묶이는 것을 막았다.
- **AD-9의 조건 확장**("파일 열기 실패, 잠금 시간 초과, 스키마 불일치")이 §4.6보다 정확하다. "DB 연결 불가"라는 서버 어휘를 파일 DB의 세 가지 실패로 정확히 치환했다.
- **AD-10의 "동기화 폴더에 SQLite 파일을 두지 않는다"**는 이 전환에서 가장 중요한 한 줄이다. Drive 복제를 "기계별 append-only 파일"로 못 박은 것과 짝이 맞는다.
- **AD-15의 "3글자 미만 질의는 `LIKE` 순차 검색"**은 trigram의 실제 한계를 정확히 반영했고, 개인 규모라는 근거까지 붙였다. AD-15의 결과 계약·근접 정렬·8,000자 상한은 그대로 유효하다.
- **Deferred의 epic 7 행**이 "AD-10의 원본·복제 규칙 안에서" 정하라고 범위를 묶은 것, 그리고 `packages/postgres`·Docker 흐름을 "남겨 둔 것"으로 명시한 것은 브라운필드 비준으로 정확하다.
- **독립 재현된 실측**(이 Mac, Node 24.16.0): `sqlite_version` 3.53.0, FTS5 `trigram` 가상 테이블 생성 OK, `loadExtension` 존재, 실험 경고 없음. Stack의 근거는 사실이다.

## 착수 전 권고

`/bmad-build 1.10` 전에 spine에 들어가야 하는 것(전부 한두 줄):

1. **C-1** AD-11: `OR REPLACE` 금지 + `recursive_triggers=ON` + 계약 테스트 한 줄.
2. **C-2** AD-11 + Conventions: redact의 조각·FTS·임베딩 재생성, 내보내기에서 파생 테이블 제외.
3. **C-3** AD-7: `openStore`/`withWrite` 단일 통로, `busy_timeout` 값, WAL은 파일 속성.
4. **H-4** AD-20(+AD-10): doctor의 `store` 항목(파일·WAL·FTS5·`sqlite_version`·`quick_check`)과 health 포트의 중립 이름 허가.
5. **H-5** AD-10: `file:…?mode=rw`로 열고 런타임은 파일을 만들지 않는다.

1.10 착수와 병행해도 되는 것: H-6(AD-16, epic 4 전까지), M-7(a는 지금, b는 첫 마이그레이션이므로 1.10에 포함), M-8(epic 7 전까지), M-9(epic 4 전까지), L-10.
