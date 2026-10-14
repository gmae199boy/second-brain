---
title: '원본을 로컬 SQLite로: Store 하나에 원본 1 + 복제 대상 N'
type: sprint-change-proposal
created: '2026-10-14'
status: approved
approved: '2026-10-14'
scope: major
mode: batch
trigger: '사용자 결정(2026-10-14), story 1.7 완료 직후 대화'
---

# Sprint Change Proposal — 원본을 로컬 SQLite로

## 1. Issue Summary

**문제:** 지금 설계는 원본이 Postgres 하나다(AD-10). 그래서 Postgres나 Docker가 없는 사람은 Brain을 쓸 수 없다. 설치기가 Docker를 깔아 주기는 하지만, 쓰려면 Docker Desktop이 항상 떠 있어야 한다. 사용자는 저장 위치를 로컬·Drive(클라우드)·DB 중 하나 이상 고를 수 있기를 원한다.

**결정(사용자, 2026-10-14):**
- Store 인터페이스 하나에 저장소 여러 개를 붙인다.
- 원본은 항상 로컬 SQLite 파일 하나다. 가장 안전하고 따로 설정할 것이 없기 때문이다.
- DB(Postgres)와 Drive는 원본을 따라 복제하는 선택 대상이다.
- V1(epic 1~5)은 로컬 원본만 만든다. 복제는 epic 5 다음의 새 에픽에서 한다.
- 이미 만든 Postgres 코드는 나중에 복제 adapter로 쓰기 위해 남겨 둔다.
- Drive에는 DB 파일을 두지 않는다. 기계별 append-only 파일만 둔다.

**유형:** 전략적 방향 전환. 구현에서 기술 한계가 드러난 것이 아니라, 사용성 요구가 새로 나왔다.

**근거(실측, 2026-10-14, 이 Mac):**
- Node 24.16 내장 `node:sqlite`의 SQLite 버전은 3.53.0이다. 별도 패키지나 네이티브 빌드가 필요 없다.
- FTS5 `trigram` tokenizer로 한국어 부분 검색을 확인했다. `'저장소'`가 `'어제 결정한 저장소 방향'`에 맞았다.
- `journal_mode=wal`가 켜진다.
- `BEFORE UPDATE … RAISE(ABORT)` trigger가 UPDATE를 막는다.
- `loadExtension`가 있다. epic 6에서 sqlite-vec를 쓸 길이 열려 있다.
- 실험 경고는 나오지 않았다.
- PRD addendum §1에 따르면, 검색 기준선도 원래 SQLite로 쟀다.

## 2. Impact Analysis

### 에픽

| 에픽 | 상태 | 영향 |
| --- | --- | --- |
| 1 기반과 설치 | 1.1~1.7 built, 1.8·1.9 남음 | **크다.** SQLite adapter를 새로 만들고, Runtime과 설치기를 로컬 원본으로 바꾸는 스토리 2개를 추가한다. 1.8 doctor 항목과 Done when 1·2·3, E1-3·E1-5·E1-6 문구를 고친다 |
| 2 세션 수집 | envelope | 세션 잠금을 advisory lock에서 `BEGIN IMMEDIATE` 쓰기 잠금으로 바꾼다. Done when 3의 "DB를 내렸다 올리면"을 고친다 |
| 3 작업 로그·시작 맥락 | envelope | Done when 4의 "DB가 꺼진 동안"을 "DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)"으로 바꾼다 |
| 4 조회·미러 | envelope | 키워드 검색을 `pg_trgm`에서 FTS5 `trigram`으로 바꾼다. 미러는 그대로다 |
| 5 운영 | envelope | 내보내기 형식(JSON Lines + manifest)은 그대로 둔다. 스냅샷은 읽기 트랜잭션이나 `VACUUM INTO`로 뜬다. "새 DB에 복구"는 "새 DB 파일에 복구"로 바꾸고, 제거 대상에 `brain.db`를 넣는다 |
| 6 임베딩 | envelope | pgvector·HNSW를 sqlite-vec로 바꾼다. 착수할 때 확장 로딩을 검증한다 |
| **7 복제 대상 (신규)** | 없음 | Postgres 복제(남겨 둔 `packages/postgres`와 `install/docker.ts`를 다시 씀), Drive 기계별 append-only 파일 복제, 복제 커서·따라잡기, doctor의 지연 표시, `setup`에서 복제 대상 추가. 순서는 epic 5 다음이다 |

### 문서

- **PRD** §9 Constraints 첫 줄(L415)과 addendum §1·§3의 저장소 행.
- **spec** Constraints 첫 줄(L64).
- **architecture spine**
  - 다시 쓰는 것: AD-1, AD-2, AD-7, AD-9, AD-10, AD-11, AD-13, AD-15, AD-18, AD-19, AD-20, Table Contract의 타입 언급, Conventions(ID·시각·마이그레이션), Stack, Structural Seed, 배치도, Deferred.
  - 그대로인 것: AD-3~6, AD-8, AD-12, AD-14, AD-16, AD-17.
- **initiative** Touch point의 Docker 행.
- **UX** 문서는 없다(N/A).

### 기술

- 새 adapter 패키지 `packages/sqlite`를 만든다. Store·SessionStore·SchemaStore 계약 테스트를 모두 통과해야 한다.
- 이미 만든 것 중 버리는 것은 없다. 다만 설치기에서 빼는 것이 있다.
  - Postgres 마이그레이션 SQL과 adapter는 남는다. 계약 테스트도 계속 돈다.
  - 설치기의 DB 선택·Docker 흐름(story 1.6)과 `--database-url`·`--docker` 플래그는 설치기에서 빠진다. 코드는 epic 7을 위해 남긴다.
- 설정
  - `[database] url_env`가 필수에서 빠진다. 대신 `[store] path`(기본 `<home>/brain.db`)를 쓴다.
  - 아직 실제 설치가 없으므로(`~/.second_brain`은 2026-10-14에 지웠다) config `schema_version`은 1로 둔다.
  - 복제 대상은 epic 7에서 `[[replicas]]` 목록으로 추가한다. 형식이 바뀌지 않는다.
- doctor의 `db`·`pgvector` 항목은 `store`(파일이 열리는지, WAL, FTS5)로 바뀐다. pgvector는 epic 6·7로 간다.

## 3. Recommended Approach

**혼합안: 직접 조정 + 부분 되돌리기(설치기에서 빼기만 함).**
- Option 1 직접 조정: 가능하다. epic 1에 스토리 2개를 넣고 이후 에픽의 문구를 고친다.
- Option 2 되돌리기: 일부만 한다. 커밋은 되돌리지 않고, 설치기에서 Docker·DB 단계만 빼고 코드는 남긴다(사용자 결정).
- Option 3 MVP 축소: 필요 없다. PRD의 FR은 바뀌지 않고 Constraints 한 줄만 바뀐다. 복제는 V1 밖이지만 원래 V1에 없던 기능이다.

**이유**
- 설치가 "Node만 있으면 끝"이 된다. Docker도 서버도 필요 없다.
- 지금 Postgres 의존이 가장 적은 시점이다. epic 2~6은 아직 envelope다.
- 기준선을 SQLite로 쟀다. 한국어 trigram 검색도 실측으로 확인했다.
- 동시 쓰기는 단명 CLI 여러 개가 겹치는 정도라 WAL과 쓰기 잠금으로 충분하다.

**노력:** 중상. epic 1에 스토리가 2개 늘어난다(각각 1.6과 비슷한 크기). 이후 에픽은 문구만 바뀐다.
**위험:** 중간. Kysely의 SQLite dialect를 `node:sqlite`에 붙이는 방법, 그리고 redact 우회 trigger를 SQLite로 옮기는 방법(GUC가 없음)이 불확실하다. 둘 다 1.10의 첫 작업으로 검증한다.
**일정:** epic 1이 스토리 2개만큼 늘어난다. epic 2 이후 일정은 거의 같다. advisory lock·SKIP LOCKED·spool 조건은 오히려 단순해진다.

## 4. Detailed Change Proposals

### 4.1 Stories (epic-foundation-and-install/tickets.toml)

**새 story 10 — SQLite store adapter** (after = [3], risk high)
- description: `packages/sqlite`에 `node:sqlite` 기반 Store·SessionStore·SchemaStore 구현을 만든다.
  - 첫 마이그레이션은 Table Contract 전부를 담는다. embeddings는 넣지 않는다.
  - FTS5 trigram 가상 테이블 자리를 둔다.
  - `messages`·`tool_notes` 불변 trigger와 redact 전용 우회 경로를 만든다.
  - `schema_version`, `runMigrations`, WAL·`busy_timeout`, `ensureDefaultIndexConfig`를 만든다.
  - 첫 작업은 Kysely SQLite dialect를 `node:sqlite`에 붙이는 방법과 SQLite의 redact 우회 방식을 검증하는 것이다.
- verify: `core/testing`의 Store·SessionStore·SchemaStore 계약 사례를 SQLite가 모두 통과한다. `messages`·`tool_notes`의 UPDATE·DELETE는 거부되고, redact 경로만 통과한다. 마이그레이션을 두 번 돌려도 `applied=[]`이다.

**새 story 11 — Runtime·설치기를 로컬 원본으로 전환** (after = [7, 10], risk medium)
- description:
  - 디스패처와 doctor가 `[store] path`(기본 `<home>/brain.db`)로 SQLite store를 만든다.
  - 설치기에서 DB 선택·Docker 단계와 `--database-url`·`--docker` 플래그를 뺀다. 그 대신 "DB 파일 위치"를 묻는다(기본값 있음).
  - 설치기가 마이그레이션과 index_configs 기본 행을 만든다.
  - `install/docker.ts`와 `packages/postgres`는 epic 7을 위해 남기고 연결만 끊는다.
  - README의 설치 설명을 고친다.
- verify:
  - Docker도 Postgres도 없는 상태에서 `npx github:…`과 같은 경로(`setup run --yes`)가 exit 0이고 `brain.db`가 생긴다.
  - 두 번 돌려도 config·shim·DB 행 수가 같다.
  - shim으로 doctor가 ok를 낸다.

**story 8 수정 — doctor 틀 완성**
- OLD description: "…스키마 버전·shim·node 경로·설정 유효성 항목을 더한다." OLD after = [4, 7]
- NEW description: "…`store`(DB 파일 열림·WAL·FTS5)·스키마 버전·shim·node 경로·설정 유효성 항목을 더한다. pgvector 항목은 빼서 epic 6·7로 넘긴다." NEW after = [4, 7, 11]
- NEW verify: "DB 파일을 지우거나 읽기 전용으로 만들거나, shim을 지우거나, node 경로를 틀리게 하거나, 스키마 버전을 바꾸면 해당 항목이 실패로 보인다."

**story 9 수정 — Refactor sweep:** after에 10, 11을 넣는다.

### 4.2 Epic 1 file

- E1-1: 패키지 목록에 `sqlite`를 넣는다. `postgres`는 "복제 adapter(epic 7), V1에서는 계약 테스트만"으로 적는다.
- E1-3: "첫 마이그레이션"을 "SQLite 첫 마이그레이션(원본)"으로 바꾼다. Postgres 마이그레이션은 복제 대상용으로 남는다고 적는다.
- E1-5: "DB 연결 또는 Docker 생성"을 "DB 파일 위치(기본 `<home>/brain.db`)"로 바꾼다.
- E1-6: "DB 연결, pgvector"를 "store(DB 파일·WAL·FTS5)"로 바꾼다.
- Done when 1:
  - OLD: "…의존성 확인(빠지면 설치를 묻고), 로컬 Docker DB 생성, 마이그레이션, shim 설치까지 끝난다."
  - NEW: "…Node와 git만 있는 Mac에서 DB 파일 생성, 마이그레이션, shim 설치까지 끝난다. Docker·Postgres는 필요 없다."
- Done when 2:
  - OLD: "…연결·pgvector 확장·스키마 버전·shim 실존을 보이고, DB를 멈추면 `DB_UNAVAILABLE`을 보인다."
  - NEW: "…store·스키마 버전·shim 실존을 보이고, DB 파일을 열 수 없으면 `DB_UNAVAILABLE`을 보인다."
- Done when 3: "DB가 거부한다"는 그대로 둔다(SQLite trigger).
- Notes에 Decision(2026-10-14)을 추가한다: 원본은 로컬 SQLite이고, 복제는 epic 7이다.

### 4.3 Later epics (envelope 문구)

- epic-capture
  - Description: "세션 잠금"을 "세션 쓰기 잠금(SQLite `BEGIN IMMEDIATE`)"으로 바꾼다.
  - Done when 3: "DB를 내렸다 올리면"을 "DB에 쓸 수 없는 동안(잠금 시간 초과·스키마 불일치)의 수집이 spool에 남고, 쓸 수 있게 되면"으로 바꾼다.
- epic-log-and-context
  - Done when 4: "DB가 꺼진 동안"을 "DB에 쓸 수 없는 동안"으로 바꾼다.
- epic-recall-and-mirror
  - Description: "키워드 검색(`pg_trgm`)"을 "키워드 검색(FTS5 trigram, 3글자 미만은 LIKE 순차 검색)"으로 바꾼다.
- epic-operations
  - Done when 1: "새 DB에 복구하면"을 "새 DB 파일에 복구하면"으로 바꾼다.
  - Done when 4: 데이터 삭제 확인 대상에 `brain.db`를 명시한다.
- epic-embedding-index
  - Description: "차원 고정 테이블과 HNSW"를 "sqlite-vec 차원 고정 테이블(착수 시 확장 로딩 검증)"로 바꾼다.
- 새 epic 7 `epic-replicas` "복제 대상: Postgres·Drive" (envelope, after epic 5)
  - Outcome: 원본은 로컬에 둔 채, 고른 복제 대상이 원본을 따라온다.
  - Done when(초안)
    1. 복제 대상이 꺼져 있다가 켜지면 빠짐없이 따라잡는다.
    2. 복제 실패가 원본 쓰기를 막지 않는다.
    3. doctor가 대상별 지연을 보인다.
    4. Drive 복제는 두 기계가 동시에 써도 충돌 사본이 생기지 않는다.

### 4.4 PRD

- §9 Constraints L415
  - OLD: "원본 저장소는 PostgreSQL 하나다. 원문, 작업 로그, 색인이 같은 곳에 있다. …"
  - NEW: "원본 저장소는 이 기계의 로컬 SQLite 파일 하나다. 원문, 작업 로그, 색인이 같은 곳에 있고, 설치에 서버나 Docker가 필요 없다. 다른 DB(Postgres)나 클라우드 폴더(Drive)는 원본을 따라오는 선택 복제 대상이며 slice 1 이후에 붙는다. 세션별 Markdown 미러는 …(그대로)"
- addendum §1 저장소 행: "PostgreSQL + pgvector"를 "SQLite(로컬 파일, Node 내장) + FTS5 trigram. 선택 색인은 sqlite-vec"로 바꾼다. 기준선이 SQLite였다는 문장은 그대로 둔다.
- addendum §3 포트 표: 저장소는 "SQLite(원본), Postgres(복제, 이후)", 색인은 "FTS5 / sqlite-vec(선택)"으로 바꾼다.
- MVP 영향: 없다. FR 1~26과 NFR은 그대로다. NFR-9(영속성)는 기계 밖 사본이 내보내기(epic 5)와 이후 복제(epic 7)로 충족된다.

### 4.5 Spec

- Constraints L64
  - OLD: "원본 저장소는 PostgreSQL 하나다. …(AD-10)."
  - NEW: "원본 저장소는 로컬 SQLite 파일 하나다. 복제 대상(Postgres·Drive)은 원본을 따라올 뿐 원본이 아니다. 미러·조각·색인은 파생물이다(AD-10)."

### 4.6 Architecture spine

- **AD-10 다시 쓰기:** "원본은 로컬 SQLite 파일 하나다"
  - 원본(SOT)은 `[store] path`(기본 `~/.second_brain/brain.db`)의 SQLite 파일 하나다. 미러·조각·색인은 파생물이고, spool은 대기열이다.
  - **복제 대상**(Postgres, Drive 기계별 append-only 파일)은 원본을 커서로 따라온다(epic 7).
    - 쓰기는 원본에 들어간 순간 확정된다.
    - 복제 실패는 원본 쓰기를 막지 않는다.
    - 읽기·검색은 원본에서만 한다.
    - 복제 대상은 원본이 될 수 없다.
  - Drive 폴더에 SQLite 파일을 두는 것은 금지한다. 동기화 중에 파일이 깨질 수 있기 때문이다.
  - Store port의 모든 구현(sqlite, postgres)은 같은 계약 테스트를 통과한다.
  - Runtime은 서버를 띄우거나 설치하지 않는다.
- **AD-7:** "Postgres advisory 잠금"을 "SQLite `BEGIN IMMEDIATE`"로 바꾼다. 데이터베이스 단위 쓰기 잠금이라 세션 단위보다 넓지만, 개인 규모라 허용한다. WAL·`busy_timeout`을 쓰고, 시간이 초과되면 spool로 보낸다. drain의 일감 나누기는 `FOR UPDATE SKIP LOCKED` 대신 "IMMEDIATE 트랜잭션 안에서 `UPDATE … SET claimed_at … WHERE 미청구 RETURNING`"으로 한다.
- **AD-9:** spool로 가는 조건을 "DB 연결 불가"에서 "DB에 쓸 수 없음(파일 열기 실패·잠금 시간 초과·스키마 불일치)"으로 넓힌다. 나머지는 그대로다.
- **AD-11:** trigger 구현을 중립 표현으로 바꾼다. "redact 전용 우회 표시(같은 트랜잭션 안에서만 유효)를 trigger가 확인한다"고 쓰고, 방식은 story 10에서 정한다.
- **AD-13:** `timestamptz`를 "UTC ISO-8601 텍스트(밀리초)"로 바꾼다. 오프셋 포함 JSON 출력 규칙은 그대로다.
- **AD-15:** `ILIKE`+`pg_trgm` GIN을 FTS5 `trigram`으로 바꾼다. 3글자 미만은 `LIKE` 순차 검색이고, 인덱스 대상 세 컬럼은 같다. 임베딩 쪽은 `vector(1024)`/`halfvec`/HNSW를 "sqlite-vec 차원 고정 테이블"로 바꾼다.
- **AD-18:** `[store] path`를 추가한다. `[database] url_env`는 epic 7의 복제 대상 설정(`[[replicas]]`)으로 옮긴다.
- **AD-19:** 3단계를 "DB 파일 위치(기본 `<home>/brain.db`). 서버·Docker 없음"으로 바꾼다. 2단계 "빠진 의존성(Docker 등)"은 "빠진 의존성(pnpm 등)"으로 바꾼다. 복제 대상 추가는 `setup run`의 선택 단계로 epic 7에서 붙인다.
- **AD-20:** "DB는 `schema_version`을 가진다"는 그대로 둔다. `setup uninstall`의 데이터 확인 대상에 `brain.db`를 넣는다.
- **AD-1·AD-2·Structural Seed·배치도:** `packages/sqlite`를 추가한다. import 예시를 `sqliteStore`로 바꾼다. 배치도의 DB 노드를 "brain.db (SQLite, WAL)"로 바꾸고 복제 대상을 점선으로 표시한다.
- **Table Contract:** 키·작성자·변경 가능성은 그대로 둔다. Conventions의 "Postgres `uuid`"는 "TEXT(UUIDv7 문자열)"로 바꾼다.
- **Stack:**
  - 원본: SQLite 3.53(Node 내장 `node:sqlite`, FTS5).
  - 쿼리 빌더: Kysely 0.29.6. dialect 연결 방식은 story 10에서 정한다.
  - 복제(epic 7): PostgreSQL 18, pgvector 0.8.7, `pgvector/pgvector:pg18`, `pg` 8.23.1을 이 범주로 옮긴다.
  - 선택 색인: sqlite-vec(버전은 epic 6에서 정한다).
- **Deferred:** "복제 대상(Postgres·Drive)과 승격"을 추가하고 epic 7을 가리킨다. "팀 공유" 행에 "공유 DB는 복제 대상 경로로"를 덧붙인다.
- **frontmatter:** `updated: 2026-10-14`.

### 4.7 Initiative

- Touch point
  - OLD: "Docker — 설치기가 컨테이너를 만들고 확인만; owner: epic-foundation-and-install"
  - NEW: "SQLite(Node 내장) — 원본 DB 파일; owner: epic-foundation-and-install. Docker·Postgres — 복제 대상; owner: epic-replicas"
- 에픽 순서표(tickets.toml)에 epic 7을 epic 5 다음에 추가한다. 순서는 1→2→3→4→5→7이고, 6은 SM-3 결과에 따른다.

## 5. Implementation Handoff

**범위: Major.** 아키텍처 원칙인 AD-10을 바꾼다. 다만 FR은 바뀌지 않고, 이후 에픽은 아직 envelope라 다시 계획할 양은 작다.

| 순서 | 할 일 | 담당(스킬) |
| --- | --- | --- |
| 1 | architecture spine 4.6 반영, `lint_spine` 통과 | Architect (`bmad-architecture` update) |
| 2 | PRD §9·addendum 4.4, spec 4.5 반영 | PM (`bmad-prd` update, `bmad-spec` update) |
| 3 | epic 1 tickets.toml(story 10·11 추가, 8·9 수정), epic 1 파일 4.2, 이후 에픽 문구 4.3, epic 7 envelope와 initiative 4.7 | `bmad-ticket` |
| 4 | 구현: `/bmad-build 1.10` → `1.11` → `1.8` → `1.9` | Dev (`bmad-build`) |

**성공 기준**
- Node와 git만 있는 Mac에서 설치가 끝나고 doctor가 ok를 낸다.
- SQLite store가 Store·SessionStore·SchemaStore 계약 사례를 모두 통과한다.
- Postgres 계약 테스트도 계속 통과한다(보존 확인).
- spine·PRD·spec 사이에 "원본은 Postgres"라는 문장이 남지 않는다.

## 6. Approval & Handoff Log

- 2026-10-14: 사용자가 승인했다("진행해"). 범위는 Major이고 조건은 없다.
- 넘길 순서: Architect(spine) → PM(PRD·spec) → `bmad-ticket`(epic 1 스토리 10·11 추가, 8·9 수정, 이후 에픽 문구, epic 7 envelope) → Dev(`/bmad-build 1.10`).

## 7. 추가안 A (2026-10-14, 사용자 승인 "이대로 진행하자") — 파일 원본, 문서 텍스트, Drive 연동, 주기 실행

### 7.1 Issue

- 대화를 저장하는데 대화에 붙인 파일을 저장하지 않으면 "그때 준 그 문서 찾아줘"에 답할 수 없다.
- Drive는 5TB이고 로컬은 512GB라서 Drive를 Mac에 동기화할 수 없다. Brain이 Drive API로 직접 다뤄야 한다.
- 임베딩은 이번 범위에 없다(사용자 재확인). 문서 검색도 키워드와 질의 바꾸기로만 한다.

### 7.2 사용자 결정 (2026-10-14)

1. 대화에 붙인 파일은 원본을 저장한다. 텍스트형 문서는 내용 텍스트를 DB에 넣어 본문으로 검색되게 한다.
2. 파일은 두 종류다.
   - **Brain이 맡은 파일**(대화 첨부)은 Brain이 저장하고, 옮기고, 지운다.
   - **외부 파일**(원래 Drive나 로컬에 있던 내 문서)은 색인만 하고 절대 옮기거나 지우지 않는다.
3. 원본(SoT)은 두 가지다.
   - **기록의 원본**은 로컬 SQLite이고, 연동해도 바뀌지 않는다.
   - **Brain이 맡은 파일의 원본**은 연동 전에는 로컬 `files/`이고, Drive를 연동하면 Drive로 옮겨 간다. 옮기는 순서는 업로드 → 해시 검증 → 로컬 삭제다.
4. DB는 로컬과 Drive를 같은 것으로 다룬다.
   - 파일 저장소 인터페이스 하나에 로컬 구현과 Drive 구현을 둔다.
   - 파일마다 내용 해시, `home`, 위치 목록을 둔다. 위치는 로컬이면 루트 기준 상대 경로, Drive면 파일 ID다.
   - URL은 위치로부터 그때그때 만든다. 에이전트는 원본이 필요하면 그 URL을 사용자에게 준다.
   - 일시(처음 본 시각, 원본 수정, 업로드, 검증, 로컬 삭제)를 둔다.
5. 경로·폴더 이름과 파일 이름을 검색 색인에 넣는다. 사진은 임베딩 없이 경로와 EXIF(촬영 일시, 기기, 좌표)로 찾는다.
6. 외부 소스 동기화는 감시 폴더 목록, 파일별 마지막 버전, Drive changes 토큰으로 관리한다. 외부 원본이 삭제되면 추출 텍스트는 남기고 "원본 삭제됨"으로 표시한다.
7. **연동 해제**(사용자 선택 b): Drive에 둔 채 연결만 끊는다. 검색은 DB의 텍스트로 계속 되고, 원본은 다시 연동할 때까지 "접근 불가"로 표시한다. Drive 사본은 지우지 않는다.
8. **새 PC로 옮기기**:
   - DB는 실행 중인 파일이 아니라 내보낸 스냅샷을 Drive에 올리고, 새 PC에서 복구한다.
   - 실제 동작은 CLI 명령이 하고, 나중에 `/brain:db-migration` 스킬이 감싼다.
   - Postgres 이전도 같은 방식이다. CLI `brain setup move-store`가 동작하고, 나중에 `/brain:migration` 스킬이 감싼다.
9. **주기 실행**: 데몬 없이 launchd가 단명 CLI(`brain admin drain`, 이후 `brain sources sync`)를 주기적으로 실행한다.
   - 데몬은 Telegram 양방향, 원격 기계 수집, 승인 대기 흐름을 시작할 때 별도 아키텍처 결정으로 다룬다.

### 7.3 V1 범위에 넣는 것

| 항목 | 에픽 |
| --- | --- |
| 파일 저장소 인터페이스(로컬 구현만), 파일·위치·추출 테이블, 상대 참조, `[files] path` 설정 | epic 1 (story 10 스키마, story 11 설정) |
| 대화 첨부 원본 저장, 메시지와의 연결 | epic 2 |
| 텍스트 추출(txt, md, 텍스트가 있는 PDF, docx), 조각 나누기, FTS 색인, 추출 상태와 `extractor_version`, 미색인 경고 | epic 2(추출 일감) + epic 4(검색 결과에 문서 조각 포함) |
| 경로·파일 이름 색인, 사진 EXIF | epic 4 |
| launchd 주기 drain(LaunchAgent, Brain 표식, uninstall에서 제거) | epic 5 |
| 내보내기 스냅샷 형식이 파일 메타데이터를 포함 (파일 본체는 선택) | epic 5 |

### 7.4 V1 다음으로 미루는 것 (새 envelope 에픽)

- **epic 8 Drive 연동**: OAuth, Drive 파일 저장소 구현, 첨부 원본 업로드·검증·로컬 삭제, 기존 Drive 문서 색인(목록 → export·임시 다운로드 → 추출 → 삭제), changes 동기화(`brain sources sync`, launchd), 연동 해제(b), DB 스냅샷 Drive 업로드와 새 PC 복구, 로컬 캐시 상한.
- **epic 7 복제 대상**(기존)에 `brain setup move-store --to postgres`를 넣는다(원본 이전: 쓰기 정지 → 복사 → 건수·해시 검증 → 전환 → 옛 파일은 읽기 전용 백업). 이를 위해 AD-10의 "복제 대상은 원본이 될 수 없다"를 "원본 이전은 검증을 거치는 명시적 명령 하나로만 한다"로 고친다.
- **plugin·skill**: `/brain:migration`, `/brain:db-migration`. 기존 Deferred 행에 붙인다.
- OCR, HWP, Google Docs 외 형식, 좌표의 장소 이름 변환.

### 7.5 문서 영향

- **PRD**
  - FR 신설: 첨부 원본 저장, 문서 텍스트 추출·검색, 경로·EXIF 검색.
  - §6.2 "harness 원본 파일은 보관하지 않는다"를 고친다. transcript 파일은 여전히 보관하지 않지만 사용자가 붙인 첨부는 보관한다.
  - Constraints에 "기록의 원본은 로컬 SQLite, 파일 원본은 로컬 또는 연동된 Drive"를 넣는다.
- **architecture**
  - 새 AD: 파일 저장소 port와 두 종류의 파일, `home`·위치·검증 순서; 문서 추출(파생물, `extractor_version`, 추출 일감); 주기 실행은 launchd(데몬 조건은 Deferred).
  - AD-10 원본 이전 문구, AD-15 색인 대상에 문서 조각·경로를 추가, Table Contract에 파일·위치·추출 조각·소스 상태 테이블, Deferred 갱신.
- **에픽**: epic 1 story 10·11 범위, epic 2·4·5 Description과 Done when, epic 8 envelope 신설, initiative 순서표.

### 7.6 Handoff

순서는 §5와 같다. architecture → PRD·spec → `bmad-ticket` → `/bmad-build 1.10`. 이 추가안을 승인하면 §5의 1~3단계에 함께 반영한다.
- 2026-10-14: 티켓 반영(bmad-ticket). 검증을 거쳐 §4.1의 story 10·11은 10(SQLite 기반)·11(대화·로그 마이그레이션)·12(파일·첨부·추출·일감 스키마)·13(런타임·설치기 전환)으로 나눴다. 8은 13 뒤, 9는 마지막이다. epic 7 `epic-replicas`와 epic 8 `epic-drive`를 만들었고, 에픽 순서는 1→2→3→4→5→7→8→6이다. launchd는 epic 5(사용자).
