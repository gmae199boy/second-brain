---
name: 'review-currency-2026-10-14 — Personal Brain V1 slice 1 (SQLite 전환분)'
lens: 'currency / reality-check — 2026-10-14 개정분(로컬 SQLite 원본, FTS5 trigram, sqlite-vec, Kysely 0.29.6, Postgres 복제 강등)이 웹·실측으로 확인된 것인지, 학습 데이터에서 단정한 것인지'
target: ../architecture-brain-v1-slice-1.md
reviewed: '2026-10-14'
scope: '2026-10-14 개정분 + 그에 딸린 Stack 표 전체. 2026-10-08 review-currency.md의 후속'
method: |
  로컬 실측(node v24.16.0, /private/tmp 스크래치패드): node:sqlite 직접 probe 6회
  (compile_options, FTS5 trigram 질의 13종, allowExtension·loadExtension, trigger+database.function,
  BEGIN IMMEDIATE·RETURNING, pragma 기본값, dbstat 색인 크기), sqlite-vec 0.1.9 tarball을
  npm pack으로 받아 vec0.dylib 실제 로드 + vec0 KNN 질의, Kysely 0.29.6을 node:sqlite에
  shim으로 붙여 select/insert/transaction/RETURNING/sql-tag FTS5 전 경로 실행,
  kysely 0.29.6 dist 소스(sqlite-driver.js·sqlite-dialect-config.d.ts) 직접 열람.
  웹: nodejs.org/docs/latest-v24.x·latest-v26.x/api/sqlite.html, api/crypto.html,
  nodejs.org/dist/index.json, nodejs/Release schedule.json, sqlite.org/fts5.html,
  npm registry(npm view 11종), Docker Hub API, GitHub API, postgresql.org/versions.json.
  리포 실측: <repo>의 package.json·packages·apps 구조와 커밋된 마이그레이션.
verdict: |
  Stack 표 숫자는 거의 다 맞다(3건 소수점 drift). 그러나 2026-10-14 개정의 **핵심 전제 3개가
  미검증 상태로 단정되어 있다**: (1) node:sqlite는 Node 24·26 모두 Stability 1.2 "Release
  candidate"이고 Stack 표에 그 사실이 없다 + `>=24`는 필요한 기능이 아직 없는 버전을 허용한다,
  (2) Kysely 0.29.6에는 node:sqlite dialect가 없고 내장 SQLite 드라이버의 `begin`은 DEFERRED여서
  AD-7의 `BEGIN IMMEDIATE`를 만족할 수 없다, (3) AD-15의 FTS5 trigram 규칙이 공백 든 질의를
  조용히 0건으로 만들고 구두점 든 질의로는 예외를 던진다(NFR-2 위반). 치명 0건, 중대 3건, 경고 5건,
  정보 2건. 개정분이 "실존하지 않는 기술"을 쓴 경우는 없다 — sqlite-vec까지 실제로 로드해서 확인했다.
---

# Currency Review (2026-10-14 개정분) — Personal Brain V1 slice 1

## 요약

2026-10-14 개정에서 새로 들어온 기술 **전부가 실존하고 이 Mac에서 실제로 동작한다**. 상상한 라이브러리나 없는 API를 부른 흔적은 없다. memlog 78번째 줄의 실측 기록(Node 24.16.0 / sqlite 3.53.0 / FTS5 trigram 한국어 / WAL / RAISE(ABORT) / loadExtension / 경고 없음)은 내가 독립적으로 재현했고 전부 사실이다. sqlite-vec은 memlog에 "epic 6에서 확정"으로만 남아 있었는데, 이 리뷰에서 tarball을 받아 `vec0.dylib`를 node:sqlite에 실제로 로드하고 KNN 질의까지 돌려 확인했다.

문제는 **숫자가 아니라 "확인했다고 적은 것의 범위"**다. 세 가지가 미검증인 채로 규칙이 되었다.

| # | 항목 | 판정 | 심각도 |
| --- | --- | --- | --- |
| D-1 | node:sqlite의 안정성 등급과 `engines: >=24`의 하한 | **wrong (RC이고, 하한이 너무 낮다)** | 중대 — SOT 전체가 Stability 1.2에 올라가 있고 표에 그 말이 없다 |
| D-2 | "Kysely를 node:sqlite에 붙이는 방식"(Stack 각주) | **partially wrong (공식 dialect 없음 + `begin`이 DEFERRED)** | 중대 — AD-7의 `BEGIN IMMEDIATE`가 `db.transaction()`으로 성립하지 않음 |
| D-3 | AD-15의 FTS5 trigram 질의 규칙 | **wrong (공백=0건, 구두점=예외)** | 중대 — AD-15가 막겠다고 선언한 "빈 결과를 성공으로 돌려주는 것"이 그대로 발생 |
| D-4 | memlog의 "loadExtension 존재" → 확장 로딩 가능 | **false positive (allowExtension 필요)** | 경고 — 메서드는 항상 존재한다. 옵션 없이는 `ERR_INVALID_STATE` |
| D-5 | sqlite-vec의 유지보수 상태 | **confirmed but stale (pre-1.0, 2026-05-18 이후 조용)** | 경고 — 선택 색인의 유일한 벡터 저장소 |
| D-6 | Stack의 `uuid` 14.x | **now redundant (Node 24.16.0에 `crypto.randomUUIDv7`)** | 경고 — 의존성 1개를 지울 수 있고, `randomUUID({version:7})`는 v4를 돌려주는 함정 |
| D-7 | "SQLite 3.53 이상" | **not a requirement we can hold (실제 하한은 훨씬 낮다)** | 경고 — 번들 버전은 Node가 정한다. 업스트림은 이미 3.54.0 |
| D-8 | 개정된 spine ↔ 이미 커밋된 story 1.3·1.4·1.6·1.7 | **unreconciled** | 경고 — `packages/sqlite`가 없고, 커밋된 마이그레이션은 Postgres 전용 332줄 |
| D-9 | Stack 버전 drift 3건 + Node 24 Maintenance 날짜 | **minor drift** | 정보 |
| D-10 | AD-11 redact 우회 표시의 node:sqlite 구현 | **confirmed feasible (미기록)** | 정보 — story 1.10이 다시 논의하지 않게 모양을 적어 둘 가치 |

---

## 0. 실측 환경

```
$ node -v
v24.16.0
$ node -e '...' --trace-warnings      # node:sqlite import + DatabaseSync 생성
(경고 없음)
sqlite_version 3.53.0
```

memlog 78번 줄과 일치. `--trace-warnings`를 켜도 `ExperimentalWarning`이 나오지 않는 것까지 확인했다(이유는 D-1).

`pragma compile_options()` 전량에서 확인한 것: `ENABLE_FTS5`, `ENABLE_FTS3`, `ENABLE_RTREE`, `ENABLE_GEOPOLY`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_SESSION`, `ENABLE_PREUPDATE_HOOK`, `ENABLE_DBSTAT_VTAB`, `THREADSAFE=1`, `DEFAULT_RECURSIVE_TRIGGERS`, `MAX_VARIABLE_NUMBER=32766`. FTS5가 컴파일 옵션 수준에서 확실히 들어 있다 — 이건 "들어 있다고 들었다"가 아니라 그 빌드의 자기 신고다.

---

## 1. D-1 (중대) — node:sqlite는 Node 24·26 모두 "Release candidate"이고, `>=24`는 하한이 아니다

### 실측·확인

공식 문서 두 곳을 각각 열어 stability 줄을 그대로 받았다.

| 문서 | Stability 줄 | 모듈 version history |
| --- | --- | --- |
| nodejs.org/docs/latest-v24.x/api/sqlite.html | `Stability: 1.2 - Release candidate.` | v24.15.0 "SQLite is now a release candidate" / v23.4.0·v22.13.0 "no longer behind `--experimental-sqlite` but still experimental" / v22.5.0 Added in |
| nodejs.org/docs/latest-v26.x/api/sqlite.html | `Stability: 1.2 - Release candidate.` | v25.7.0 "SQLite is now a release candidate" (26.x 모듈 레벨 변경 행 없음) |

즉 **Node 26에 가도 여전히 1.2 RC다.** "Node 24 LTS니까 안정"은 성립하지 않는다. Node의 stability index에서 1.2는 "바뀔 가능성은 낮지만 semver 보호를 받지 않는다"는 뜻이고, 이 프로젝트는 그 위에 **원본(SOT) 전체**를 올렸다.

"실험 경고가 없다"는 실측은 사실이지만, 그 이유는 안정화가 아니라 v23.4.0에서 플래그가 빠졌기 때문이다. **경고의 부재를 안정성의 증거로 읽은 것이 이 항목의 실질적 오류다.**

### `>=24`가 허용하는 구멍

Stack 표와 리포 `package.json`의 `engines.node`가 둘 다 `>=24`다. 그런데 개정된 spine이 실제로 요구하는 기능들의 등장 시점은 이렇다(모두 공식 version history).

| spine이 쓰는 것 | 추가된 버전 | `>=24`에서 깨지는 구간 |
| --- | --- | --- |
| node:sqlite = RC (경고 없음·안정 지향) | v24.15.0 | 24.0.0 ~ 24.14.x는 "still experimental" |
| `defensive` 기본 켜짐 | v24.14.0 | 24.0.0 ~ 24.13.x는 기본 꺼짐 |
| `defensive` 옵션 자체 | v24.12.0 | — |
| `timeout` 옵션 = busy_timeout (AD-7) | v24.0.0 | 24 전체 OK |
| `allowExtension`·`loadExtension` (AD-15) | v23.5.0·v22.13.0 | 24 전체 OK |
| `crypto.randomUUIDv7` (AD-8, D-6 참고) | **v24.16.0** | 24.0.0 ~ 24.15.x에 없음 |

이 Mac이 24.16.0인 건 우연이 아니라 **필요 하한의 바로 위**다. 실측을 24.16.0에서 하고 표에는 `>=24`를 적은 것은, 검증한 환경과 선언한 환경이 다르다는 뜻이다.

### 고칠 것

1. Stack의 Node 행: `>=24.16.0` (리포 `package.json`의 `engines.node`도 같이).
2. Stack의 SQLite 행에 한 줄 각주: **"node:sqlite는 Node 24·26 공통으로 Stability 1.2 Release candidate다. 원본이 이 RC 위에 있다."** 숨길 게 아니라 명시할 전제다.
3. Deferred에 한 행 추가: **"node:sqlite가 breaking change를 낼 때"** — AD-10이 이미 Store port 뒤의 adapter 교체로 만들어 두었으므로 비용은 `packages/sqlite` 하나다. 대안은 오늘 기준 `better-sqlite3` 13.0.3(2026-08-05)과 `node-sqlite3-wasm` 0.8.60(2026-07-28)이고, 둘 다 생존 중임을 npm에서 확인했다.
4. AD-19의 doctor: shim과 node 경로의 **실존**만 보는 대신 **실행 중인 node의 minor 버전**도 본다. shim은 설치 시점 node 절대 경로를 담으므로(AD-19), 그 node가 24.14.x로 내려앉은 상태를 doctor가 잡아야 한다.

---

## 2. D-2 (중대) — Kysely에 node:sqlite dialect는 없고, 내장 드라이버의 `begin`은 DEFERRED다

Stack 각주는 "Kysely 0.29.6 (`node:sqlite`에 붙이는 방식은 story 1.10에서 확정)"이고 memlog 78번 줄도 "미검증 → story 1.10 첫 작업"이다. **미검증이라고 적은 것 자체는 정직하다.** 이 리뷰에서 그걸 검증했고, 결과가 두 갈래다: 붙는다(좋은 쪽), 그런데 AD-7이 그대로는 성립하지 않는다(나쁜 쪽).

### 2-1. 공식 dialect는 없다 — 설치된 패키지를 직접 열어 확인

```
$ ls node_modules/.pnpm/kysely@0.29.6/node_modules/kysely/dist/dialect/
postgres  mysql  mssql  sqlite        # node:sqlite 없음
$ grep -rl "node:sqlite" .../kysely/dist/
(없음)
```

`dist/dialect/sqlite/sqlite-dialect-config.d.ts`가 요구하는 모양은 **better-sqlite3의 부분집합**이다.

```ts
export interface SqliteDatabase { close(): void; prepare(sql: string): SqliteStatement }
export interface SqliteStatement {
  readonly reader: boolean
  all(parameters: ReadonlyArray<unknown>): unknown[]
  run(parameters: ReadonlyArray<unknown>): { changes: number|bigint; lastInsertRowid: number|bigint }
  iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown>
}
```

node:sqlite의 `StatementSync`는 `all(...params)`를 **스프레드**로 받고 `reader`가 없다. 차이는 그 둘뿐이다.

제3자 패키지는 둘 다 의존하기에 부적절하다(npm 실측):

| 패키지 | 최신 | 마지막 수정 | 판정 |
| --- | --- | --- | --- |
| `@fileshed/kysely-node-sqlite` | 0.1.0 | 2026-08-02 | pre-0.1, 단일 릴리스 |
| `kysely-node-sqlite` | 1.1.0 | 2025-07-20 | `kysely: ^0.28.3`에 고정 — 0.29와 어긋남 |

### 2-2. 저장소 안의 얇은 shim으로는 **전 경로가 통과한다** (실행 확인)

약 15줄 shim(`reader`는 `st.columns().length > 0`, `all/run/iterate`는 배열→스프레드)으로 Kysely 0.29.6 + node:sqlite를 붙여 실제 쿼리를 돌렸다. 결과:

| 경로 | 결과 |
| --- | --- |
| `insertInto().values([...])` 다건 | OK |
| `selectFrom().where().orderBy()` — 한국어 본문 포함 | OK |
| `db.transaction().execute()` | OK (count 3 확인) |
| `updateTable().returning('id')` | OK — `[{ id: 'a' }]` |
| `sql\`create virtual table ... using fts5(..., tokenize='trigram')\`` | OK |
| `sql\`... match ${param}\`` (바인딩 파라미터로 MATCH) | OK (구문상. 결과는 D-3) |
| `db.fn.countAll()` | OK |

**AD-15의 "FTS5·벡터 연산은 Kysely의 `sql` 템플릿으로 직접 쓴다"는 성립한다.** 바인딩 파라미터가 `MATCH` 우변에 들어가는 것까지 확인했다(raw literal과 동일하게 동작).

### 2-3. 그런데 AD-7이 깨진다 — `begin`은 DEFERRED

`kysely/dist/dialect/sqlite/sqlite-driver.js`를 직접 열었다.

```js
async beginTransaction(connection) {
    await connection.executeQuery(CompiledQuery.raw('begin'));   // ← IMMEDIATE가 아니다
}
```

SQLite의 `BEGIN`은 기본 DEFERRED다. DEFERRED 트랜잭션은 첫 쓰기에서 SHARED→RESERVED로 **승격**하는데, WAL에서 이 승격이 실패하면 `SQLITE_BUSY`가 **즉시** 돌아오고 `busy_timeout`이 재시도하지 않는다. 이건 SQLite의 잘 알려진 동작이고, AD-7이 `BEGIN IMMEDIATE`를 못 박은 이유 그 자체다.

즉 **AD-7의 "데이터를 쓰는 모든 경로는 `BEGIN IMMEDIATE`를 잡는다"를 Kysely의 `db.transaction()`으로는 지킬 수 없다.** 그리고 AD-9의 "잠금 시간 초과는 spool로 간다"도, 시간 초과가 아니라 즉시 BUSY가 나므로 의도와 다르게 발동한다 — busy_timeout을 얼마로 잡아도 무의미하다.

`sql\`begin immediate\``를 직접 내보내는 것은 동작함을 확인했다(`manual BEGIN IMMEDIATE via sql tag: ok`).

### 고칠 것

1. Stack의 Kysely 행: **"Kysely 0.29.6 + 저장소 안의 얇은 node:sqlite 드라이버(약 15줄, better-sqlite3 모양 어댑터). 외부 dialect 패키지는 쓰지 않는다."** — "story 1.10에서 확정"을 이 문장으로 교체한다. 이제 확정할 근거가 있다.
2. AD-7에 한 줄 추가: **"쓰기 트랜잭션은 Kysely의 `db.transaction()`이 아니라 `BEGIN IMMEDIATE`를 내는 자체 드라이버(또는 `sql` 템플릿)로 연다. Kysely 내장 SQLite 드라이버의 `begin`은 DEFERRED이고, WAL에서 잠금 승격 실패는 즉시 BUSY로 끝나 busy_timeout이 재시도하지 않는다."**
3. story 1.10의 수용 기준에 넣을 것: 드라이버가 내는 첫 문장이 `begin immediate`임을 확인하는 테스트.
4. AD-9의 spool 조건 문구("잠금 시간 초과")에 즉시 BUSY도 포함되게 조정 — 현재 문구는 승격 실패를 놓친다.

---

## 3. D-3 (중대) — AD-15의 trigram 규칙이 AD-15가 막겠다는 실패를 그대로 만든다

AD-15는 "기본 검색은 키워드다 … FTS5 `trigram` 색인을 둔다(부분 일치, 대소문자 무시). 3글자 미만 질의는 `LIKE` 순차 검색이다"라고만 적는다. 그리고 **Prevents**에 "기본 구성에서 소분류 검색이 빈 결과를 성공으로 돌려주는 것"을 명시한다.

SQLite 3.53.0 / `tokenize='trigram'`으로 질의 13종을 실측했다. 본문: `'안녕 세계 입니다'`, `'hello world'`, `'a-b: c*d "q"'`.

| 질의 | 결과 | 비고 |
| --- | --- | --- |
| `녕 세` | **0건** | 공백이 토큰 구분자 → `녕`/`세` 각 1자 → 매치 없음 |
| `"녕 세"` | 1건 매치 | 구절로 감싸면 된다 |
| `세계 입니` | **0건** | 사람이 가장 자연스럽게 칠 형태 |
| `"안녕 세계"` | 1건 매치 | |
| `안녕` (2자) | 0건 | spine의 "3글자 미만" 규칙과 일치 — 맞다 |
| `a-b` | **예외: `no such column: b`** | `-`가 컬럼 필터 구문으로 파싱 |
| `AND` | **예외: `fts5: syntax error near "AND"`** | 불리언 연산자 |
| `"` | **예외: `unterminated string`** | |
| `q" OR body:x` | **예외: `unterminated string`** | |
| `c*d` | 0건 | `*`는 prefix 연산자 |
| `HELLO` | 1건 (`hello world`) | 대소문자 무시 confirmed |
| `HEL` | 1건 | 3자면 영어는 잘 된다 |
| `bm25(ft)` 정렬 | 동작 | AD-15의 "관련도 순" 재료 OK |
| `highlight(ft,0,...)` | 동작 | |

### 왜 중대한가

AD-17과 AD-15는 "못 찾으면 **에이전트가 질의를 바꿔 다시 찾는다**"를 FR-14의 충족 수단으로 삼는다. 즉 **질의 문자열이 에이전트에서 거의 그대로 `MATCH` 우변으로 들어간다.** 그러면:

- 공백 든 질의(한국어·영어 모두 가장 흔한 형태)는 **조용히 0건**. 에이전트는 "없구나"로 읽고 질의를 또 바꾼다. AD-15가 막겠다던 바로 그 실패다. NFR-2 위반.
- `-`, `"`, `:`, `*`, `AND/OR/NOT/NEAR`가 든 질의는 **예외**. 코드 식별자(`foo-bar`), 경로, 에러 메시지를 찾을 때 즉시 터진다. 이건 조용하지도 않고 그냥 깨진다.
- "3글자 미만 질의는 LIKE"라는 판정 단위가 **질의 전체**로 읽히는데, 실제 단위는 **구절 안의 연속 문자**다. `세계 입니`는 5자지만 토큰 단위로는 2자+2자라 0건이다.

### 고칠 것

AD-15의 키워드 규칙을 이렇게 구체화한다.

> 질의는 Core의 함수 하나가 FTS5 구문으로 감싼다: 내부 `"`를 이스케이프하고 전체를 `"…"` 구절로 만든다. 그러면 공백은 구절 안에 남고, 구두점·연산자는 리터럴이 된다. 길이 판정의 단위는 질의 전체가 아니라 **구절 안 연속 문자 3자**이고, 3자 미만인 것만 `LIKE`로 간다.

그리고 계약 테스트에 위 표의 `녕 세` / `세계 입니` / `a-b` / `AND` / `"` 다섯 문자열을 그대로 넣는다. 이 다섯 개가 통과하면 이 함정은 닫힌다.

### 덧붙임 — 색인 크기 (정보)

같은 본문(약 1MB 텍스트, 50 문서)으로 `dbstat`을 재서 비교했다.

| 토크나이저 | 페이지 수 | 바이트 |
| --- | --- | --- |
| `trigram` | 593 | 2,428,928 |
| 기본 `unicode61` | 407 | 1,667,072 |

trigram이 약 **1.46배**다. 본문 자체까지 합치면 `chunks.body` 색인은 DB를 대략 두 배로 만든다. 개인 규모(226세션·540만 자, memlog 43번 줄)에서는 문제가 아니지만, AD-15나 Deferred에 한 줄 남길 가치가 있다 — "trigram 색인은 unicode61의 약 1.5배"라는 숫자를 모르면 나중에 DB 크기를 보고 놀란다.

---

## 4. D-4 (경고) — "loadExtension 존재"는 확장 로딩의 증거가 아니다

memlog 78번 줄: `loadExtension 존재`. AD-15: "확장 로딩은 착수할 때 검증한다."

`loadExtension`은 **항상** 함수다. 존재 여부로는 아무것도 알 수 없다. 실제로 호출해 보면:

```
no allowExtension  : ERR_INVALID_STATE   | extension loading is not allowed
allowExtension:true : ERR_LOAD_SQLITE_EXTENSION | dlopen(...) — 경로까지 도달
```

공식 문서도 "`allowExtension`은 기본 `false`", "`allowExtension`이 `false`로 생성된 연결은 **보안상 나중에 켤 수 없다**"고 못 박는다. 즉 **확장 로딩 가능 여부는 연결 생성 시점의 결정**이다. spine의 어디에도 `allowExtension`이 없다.

### 그래서 끝까지 해 봤다 — sqlite-vec은 실제로 로드된다

```
$ npm pack sqlite-vec && npm pack sqlite-vec-darwin-arm64
sqlite-vec-0.1.9.tgz  sqlite-vec-darwin-arm64-0.1.9.tgz
→ package/vec0.dylib

$ node   # DatabaseSync(':memory:', { allowExtension: true }) + loadExtension(vec0)
vec_version: { v: 'v0.1.9' }
create virtual table v using vec0(embedding float[4])          → OK
select rowid, distance from v where embedding match '[1,2,3,3]' order by distance limit 2
  → [{ rowid: 1, distance: 1 }, { rowid: 2, distance: 4.2426... }]
```

AD-15의 "sqlite-vec 차원 고정 테이블, 예: 1024"가 실제로 되는 모양임을 확인했다(`float[N]`). npm 패키지는 `getLoadablePath()`/`load(db)`를 내보내고 플랫폼별 바이너리를 `optionalDependencies`(`sqlite-vec-darwin-arm64` 등 5종)로 가져온다 — 네이티브 빌드 없음, pnpm workspace에서 문제될 구조가 아니다.

### 보안상의 짝 효과

`allowExtension: true`로 연 연결은 임의 공유 라이브러리를 `dlopen`할 수 있다. AD-15가 "임베딩은 기본 꺼짐"이라고 했으니, **확장을 허용하는 연결도 임베딩이 켜진 경로에만** 있어야 한다.

### 고칠 것

AD-15의 임베딩 블록에: **"확장 로딩은 임베딩이 켜진 경로의 연결에서만 `allowExtension: true`로 연다. 기본 연결은 확장을 허용하지 않는다(생성 후에는 켤 수 없다)."**

---

## 5. D-5 (경고) — sqlite-vec는 pre-1.0이고 5개월 조용하다

Stack: "벡터 저장은 sqlite-vec(버전은 epic 6에서 확정)".

| 확인 | 값 |
| --- | --- |
| npm `latest` | **0.1.9** |
| npm 마지막 수정 | 2026-05-18 |
| 상위 pre-release | 0.1.10-alpha.4 (2026-05-18) |
| 저장소 마지막 push (집계 사이트) | 2026-05-18 |
| 플랫폼 패키지 | darwin-arm64/x64, linux-arm64/x64, windows-x64 — 모두 0.1.9 존재 |

실존하고 동작한다(§4에서 확인). 그러나 **1.0 이전이고 약 5개월 움직임이 없다.** 선택 색인의 유일한 벡터 저장소를 거기에 두는 것은 기록해 둘 위험이다. 2026-10-14 기준 유지보수 중단을 선언한 문서는 찾지 못했다 — 즉 "죽었다"가 아니라 "조용하다"다.

### 고칠 것

1. Stack: "버전은 epic 6에서 확정" → **"sqlite-vec 0.1.9(플랫폼 바이너리 optionalDependencies, 2026-05-18 이후 릴리스 없음, pre-1.0)"**. 지금 알 수 있는 것을 epic 6으로 미룰 이유가 없다.
2. Deferred에 한 행: **"sqlite-vec 유지보수 정지"** — 대안은 개인 규모에서 `float` BLOB + SQL 안의 완전 탐색 코사인(5,016 조각 규모면 충분하다. memlog 43번 줄의 "검색 1회 중앙 1.7s"가 기준점)이거나 1.0을 기다리는 것. AD-15가 이미 임베딩을 port 뒤의 선택 색인으로 두었으므로 비용은 adapter 하나다.

---

## 6. D-6 (경고) — `uuid`가 더 이상 필요 없다. 그리고 `randomUUID({version:7})`은 함정이다

Stack: `uuid (v7) | 14.0.2`. 커밋된 `apps/cli/src/runtime/id-gen.ts`가 `import { v7 as uuidV7 } from 'uuid'`를 쓴다.

**Node 24.16.0에 `crypto.randomUUIDv7()`이 들어왔다** (공식 문서: "Added in: v24.16.0", RFC 9562 version 7, 상위 48비트 밀리초 타임스탬프).

```
$ node -e 'const c=require("node:crypto"); ...'
randomUUIDv7: function
[ '01a138bd-b2c0-70db-...', '01a138bd-b2c0-750d-...', '01a138bd-b2c0-7e68-...' ]
sorted==same: true        # 생성 순 = 사전순
version nibble: 7
```

즉 **AD-8의 `IdGen` port 구현에서 의존성 하나를 지울 수 있다.** AD-1이 "Core에 런타임 의존성 없음"을 규칙으로 둔 프로젝트에서, Runtime의 의존성도 하나 줄어든다. 2026-10-08 버전 조사(memlog 61번 줄)가 `uuid 14.0.2`를 적었을 때 `randomUUIDv7`은 아직 없었다 — **그 조사가 틀린 게 아니라 낡았다.** 정확히 이 리뷰가 찾아야 하는 종류의 항목이다.

### 함정

```
$ node -e 'console.log(require("node:crypto").randomUUID({version:7}))'
868d17dc-5fcf-4b94-93a7-f23c5c472775     # ← version nibble이 4다
```

`randomUUID`는 모르는 옵션을 **조용히 무시**하고 v4를 돌려준다. `randomUUID({version:7})`로 쓰면 UUIDv7이라고 믿는 v4가 DB에 들어간다. AD-8의 시간 정렬 전제가 소리 없이 깨진다. 이름이 다른 함수(`randomUUIDv7`)를 써야 한다.

### 한 가지 판단이 필요하다

| | 단조성 |
| --- | --- |
| `crypto.randomUUIDv7()` | 공식 문서: "비단조 시계에 의존하며 **엄격히 증가함을 보장하지 않는다**" |
| `uuid` 14.x `v7()` | 밀리초 안에서 카운터를 유지 (커밋된 `id-gen.ts` 주석이 이 점에 기대고 있다) |

AD-8이 ID에 요구하는 것은 유일성과 대략적 시간 순서이고(멱등 키는 별도 UNIQUE 제약), 엄격한 단조성이 걸린 규칙은 없다. 그러면 둘 다 된다. **문제는 어느 쪽이든 "왜"가 적혀 있지 않다는 것이다.**

### 고칠 것

하한을 `>=24.16.0`으로 올린 뒤(D-1), **Stack에서 `uuid`를 빼고** `crypto.randomUUIDv7`로 간다. 또는 `uuid`를 유지하되 Stack에 이유를 적는다: "밀리초 내 엄격 단조가 필요해 `uuid`를 쓴다(내장 `randomUUIDv7`은 보장하지 않음)." 어느 쪽이든 `randomUUID({version:7})`을 쓰지 말라는 한 줄을 Conventions의 ID 행에 남긴다.

---

## 7. D-7 (경고) — "SQLite 3.53 이상"은 우리가 지킬 수 있는 요구사항이 아니다

Stack: "Node 내장 `node:sqlite`, SQLite 3.53 이상, FTS5 `trigram` (2026-10-14 이 Mac에서 실측)".

| 확인 | 값 |
| --- | --- |
| 이 Mac(24.16.0) 번들 | 3.53.0 |
| 업스트림 SQLite 최신 | **3.54.0** (sqlite.org) |
| 공식 node:sqlite 문서의 번들 버전 언급 | **없음** ("일부 기능은 SQLite 빌드 방식에 따른다"만) |

두 가지 문제가 있다.

1. **선택할 수 없는 것을 요구사항으로 적었다.** 번들 SQLite 버전은 Node가 정한다. Node 패치 하나로 올라가거나(보안 백포트) 그대로 머문다. "3.53 이상"은 `>=24.16.0`을 다르게 쓴 말일 뿐인데, 독자에게는 우리가 고를 수 있는 값처럼 보인다.
2. **실제 하한은 훨씬 낮다.** spine이 의존하는 기능들은 3.53보다 한참 오래됐다 — FTS5 trigram 토크나이저는 3.34, `RETURNING`(AD-7의 drain claim)은 3.35, WAL은 3.7. 3.53은 "내가 실측한 숫자"이지 "필요한 숫자"가 아니다.

### 고칠 것

1. Stack: **"Node 내장 `node:sqlite` (24.16.0 번들 SQLite 3.53.0 실측. 버전은 Node가 정하고 우리가 고르지 않는다)"**.
2. AD-19/AD-20의 doctor: 버전 문자열 비교 대신 **기능을 직접 찔러 본다** — FTS5 trigram 가상 테이블 생성, `RETURNING` 한 번, `journal_mode=wal` 확인. 셋 중 하나라도 실패하면 크게 실패한다. 버전 숫자를 믿는 것보다 이게 싸고 정확하다(§0에서 내가 한 게 정확히 이것이다).

---

## 8. D-8 (경고) — 개정된 spine과 이미 커밋된 story 1.3·1.4·1.6·1.7이 어긋난다

웹이 아니라 **이 리포의 현실**과 대조한 항목이다. 리뷰 렌즈의 "the existing project" 쪽.

Structural Seed와 AD-10은 `packages/sqlite`(원본 adapter)를 중심에 둔다. 리포 실측:

```
$ ls packages
claude-code  core  modelstudio  postgres  second_brain      # sqlite 없음
```

그리고 **존재하는 것**은 Postgres 전용으로 완성되어 있다(커밋 971ffef·5ce6b34·f92c51c·78317c2).

| 커밋된 산출물 | 개정된 spine이 요구하는 것 |
| --- | --- |
| `packages/postgres/migrations/0001_initial.sql` — 332줄, `create extension pg_trgm`, 컬럼 타입 `uuid`·`timestamptz`, 네이티브 `references` | AD-13: 시각은 **UTC ISO-8601 텍스트**. Conventions: ID는 **TEXT**. AD-15: **FTS5 trigram** |
| `packages/postgres/src/{store,connect,migrate,setup}.ts` | Structural Seed: "`postgres/`는 slice 1에서는 **계약 테스트만**" |
| `apps/cli/src/install/docker.ts`, `compose.test.yaml` | AD-19 3단계: "원본 DB 파일 위치. **서버·Docker는 필요 없다**" |
| `apps/cli/src/config/codec.ts`의 `DATABASE_URL` | AD-18: `[store] path`. `url_env`는 **epic 7의 `[[replicas]]`로 이동** |

spine의 Deferred 표는 "복제 대상 … 남겨 둔 `packages/postgres`와 설치기의 Docker 흐름을 다시 쓴다"고 epic 7 쪽만 언급한다. **지금 당장 네 스토리의 산출물을 다시 써야 한다는 사실은 어디에도 없다.** memlog 70~78번 줄도 결정만 기록하고 기존 코드와의 충돌은 적지 않았다.

### 고칠 것

spine은 편집하지 않는 게 이 리뷰의 범위이므로, 선택지만 적는다.

1. Deferred(또는 새 "Rework" 절)에 한 행: **"story 1.3·1.4·1.6·1.7의 산출물은 SQLite 원본으로 다시 쓴다"** — 각각 무엇이 되는지(1.3 = SQLite 마이그레이션 + trigger, 1.4 = `[store] path` 코덱, 1.6 = Docker 없는 설치 흐름, 1.7 = 그에 맞춘 shim·connect) 한 줄씩.
2. 또는 다음 빌드 전에 `bmad-correct-course`를 돌려 영향 범위를 정식으로 받는다. 네 커밋이 걸린 변경은 spine 한 줄 수정보다 크다.

### 운 좋은 발견 하나 (기록해 둘 가치)

커밋된 마이그레이션은 FK(`references`)에 꽤 의존한다. 보통 SQLite 이식에서 가장 먼저 깨지는 지점이다 — SQLite는 `foreign_keys`가 **연결마다 기본 꺼짐**이기 때문이다. 실측:

```
pragma foreign_keys              → 1          # node:sqlite 기본 켜짐
insert into b values ('b','missing')  → FOREIGN KEY constraint failed
new DatabaseSync(path, { enableForeignKeyConstraints: false }) → 0
```

**node:sqlite는 raw SQLite·better-sqlite3와 달리 FK를 기본으로 켠다.** 마이그레이션의 `references`가 포팅 후에도 살아 있다는 뜻이고, 좋은 소식이다. 단 **이 드라이버를 통할 때만** 그렇다 — `sqlite3` CLI나 다른 도구로 `brain.db`를 열면 FK는 꺼진 상태다. AD-10이나 Conventions의 마이그레이션 행에 한 줄 남길 것: FK 강제는 `node:sqlite` 기본값에 의존하며, 다른 도구로 같은 파일을 쓰면 강제되지 않는다.

---

## 9. D-9 (정보) — Stack 버전 drift와 Node 날짜

2026-10-14 `npm view <pkg> version time.modified` 실측.

| Stack 기재 | 실측 latest | 판정 |
| --- | --- | --- |
| Node.js `>=24` LTS (24.21.0) | v24.21.0 (2026-09-07), `lts: Krypton` | **confirmed** (하한은 D-1) |
| TypeScript 7.0.x (7.0.2) | 7.0.2 (2026-10-13) | confirmed |
| pnpm `>=12` (12.11.2) | — | 고정하지 않는 정책이므로 drift 아님 |
| Kysely 0.29.6 | 0.29.6 (2026-09-16) | confirmed (붙이는 방식은 D-2) |
| commander 15.0.0 | 15.0.0 (2026-09-02) | confirmed |
| @clack/prompts 1.8.1 | 1.8.1 (2026-09-13) | confirmed |
| smol-toml 1.9.0 | **1.9.1** (2026-10-09) | **drift** |
| uuid 14.0.2 | **14.0.3** (2026-10-10) | **drift** (애초에 D-6) |
| vitest 5.0.3 | **5.0.4** (2026-10-12) | **drift** |
| `pg` 8.23.1 | 8.23.1 (2026-09-30) | confirmed |
| PostgreSQL 18 | 18.6, 18이 여전히 `current` 메이저 | confirmed |
| pgvector 0.8.7 | 최신 태그 `v0.8.7` | confirmed |
| `pgvector/pgvector:pg18` | 존재, 2026-10-01 갱신 (`0.8.7-pg18`도 동일) | confirmed |

Postgres 19는 **아직 GA가 아니다**(beta 4, 2026-09-24에 기능 6건 제외). epic 7의 `18 / 0.8.7`은 오늘 기준 올바른 선택이다. 복제 대상이 epic 7로 미뤄졌어도 숫자는 낡지 않았다.

리포 쪽 한 건: `@types/node`가 `24.19.1`인데 LTS 라인은 24.21.0이다. Stack 표에는 없는 항목이지만, D-1에서 하한을 24.16.0으로 올릴 때 같이 보면 된다.

### Node 날짜 한 줄

Stack: "`>=24` LTS (24.21.0. 2026-10-28부터 26이 Active LTS)". `nodejs/Release`의 `schedule.json` 원본:

```
v24: { lts: 2025-10-28, maintenance: 2026-10-20, end: 2028-04-30, codename: Krypton }
v26: { start: 2026-05-05, lts: 2026-10-28, maintenance: 2027-10-20, end: 2029-04-30 }
```

10-28은 맞다. 빠진 것은 **v24가 2026-10-20에 Maintenance로 내려간다**는 것 — 오늘로부터 6일이다. 2026-10-08 리뷰의 C-5가 이미 지적한 항목인데(그때는 12일 뒤) 이번 개정에서 표에 반영되지 않았다. 지금은 "원본이 node:sqlite"라서 Node 버전의 의미가 그때보다 커졌다. 한 줄 보강 권한다: "24는 2026-10-20부터 Maintenance, 26이 10-28부터 Active LTS".

---

## 10. D-10 (정보) — AD-11의 redact 우회 표시, node:sqlite에서 되는 모양

AD-11은 "trigger는 같은 트랜잭션 안에서만 유효한 유효한 redact 표시가 있을 때만 통과시킨다(Store 구현마다 방식은 다르고, 계약 테스트가 동작을 고정한다)"로 두고, memlog 74번 줄은 "구체 구현은 story 1.10에서 확정, Postgres GUC 대응"으로 미뤘다. 미룬 판단은 타당하다. 다만 **되는 모양을 이미 확인했으니 적어 두면 1.10이 다시 탐색하지 않는다.**

Postgres의 GUC(`current_setting`)에 대응하는 node:sqlite 수단은 `database.function()`이다. 실측:

```js
let marker = 0;
db.function('brain_redact_allowed', () => marker);
db.exec(`create trigger m_noupd before update on messages begin
           select case when brain_redact_allowed()=1 then null
                  else raise(abort,'immutable') end; end`);

db.exec("update messages set body='y'")   → immutable   (차단)
marker = 1;
db.exec("update messages set body='y'")   → OK          (통과)
```

`RAISE(ABORT)` 단독도 물론 동작한다(memlog 78번 줄과 동일). 추가로 확인한 것: `UPDATE … RETURNING`이 동작하므로 AD-7의 drain claim(`UPDATE … SET claimed_at … RETURNING`)이 SQLite에서 그대로 쓸 수 있다.

**한 가지 문구 보강이 필요하다.** 이 표시는 **트랜잭션이 아니라 JS 프로세스 변수**에 산다. AD-11의 "같은 트랜잭션 안에서만 유효한"을 문자 그대로 보장하지 않는다 — 구현이 `BEGIN IMMEDIATE` 하나를 감싸는 `try/finally`에서 세우고 반드시 지워야 한다. AD-11에 그 조건을 명시하지 않으면, 표시가 켜진 채로 남은 프로세스에서 모든 UPDATE가 통과한다. 원문 불변(NFR-1)의 유일한 방어선이므로 문구로 못 박을 값이다.

---

## 11. 한 가지, 이번에도 확인하지 못한 것

정직하게 남긴다. **동시 쓰기를 실제로 재어 보지 않았다.**

AD-7 전체(DB 단위 쓰기 잠금 + WAL + busy_timeout, 초과 시 spool)와 AD-9의 spool 발동 조건은 **두 `brain` 프로세스가 같은 `brain.db`에 동시에 쓸 때의 실제 거동**에 달려 있다. spine은 "같은 세션에 여러 프로세스가 동시에 뜨는 것을 전제한다"(Design Paradigm)고 선언하고, 턴마다 Stop hook이 뜨고 SessionStart(async)가 drain을 돌리므로 이 동시성은 가정이 아니라 설계의 일부다.

내가 확인한 것은 단일 프로세스에서 `BEGIN IMMEDIATE`·WAL·`busy_timeout`·`RETURNING`이 각각 동작한다는 것뿐이다. 확인하지 못한 것:

- 두 프로세스가 동시에 `BEGIN IMMEDIATE`를 잡을 때 `busy_timeout`이 실제로 대기해 주는지, 어느 값이면 충분한지
- node:sqlite가 **동기 API뿐**(`DatabaseSync`만 있고 async `Database`는 없다 — exports 실측: `DatabaseSync, StatementSync, Session, constants, backup`)이므로, `busy_timeout` 대기가 **프로세스 전체를 블록**한다는 점. AD-6의 동기 시작 hook 경로("짧은 timeout")에서 이 블록이 NFR-7의 시작 맥락 목표와 직접 충돌할 수 있다. AD-7은 busy_timeout 값을 정하지 않았다 — 동기 경로와 async 경로에 **다른 값**이 필요할 가능성이 높다.
- D-2의 DEFERRED 문제가 실제로 어떤 에러 코드로 나타나는지

**story 1.10의 첫 작업을 "Kysely 붙이기"가 아니라 "Kysely 붙이기 + 두 프로세스 동시 쓰기 실측"으로 두기를 권한다.** §2의 shim은 이 리뷰에서 이미 돌려서 동작을 확인했으니, 1.10의 진짜 미지는 동시성 쪽이다.

---

## 부록 — 출처

- Node.js `node:sqlite` 문서 (Stability 1.2, version history, `allowExtension`·`defensive`·`timeout`): https://nodejs.org/docs/latest-v24.x/api/sqlite.html , https://nodejs.org/docs/latest-v26.x/api/sqlite.html
- Node.js `crypto.randomUUIDv7` (Added in v24.16.0, 비단조 시계 주의): https://nodejs.org/docs/latest-v24.x/api/crypto.html
- Node 릴리스·일정: https://nodejs.org/dist/index.json , https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- SQLite FTS5 trigram 토크나이저: https://sqlite.org/fts5.html / 업스트림 최신 버전: https://sqlite.org/chronology.html
- Kysely 0.29.6 설치본 직접 열람: `node_modules/.pnpm/kysely@0.29.6/.../dist/dialect/sqlite/{sqlite-driver.js,sqlite-dialect-config.d.ts}`
- 제3자 dialect: https://www.npmjs.com/package/@fileshed/kysely-node-sqlite , https://www.npmjs.com/package/kysely-node-sqlite
- sqlite-vec: `npm pack sqlite-vec@0.1.9`, `npm pack sqlite-vec-darwin-arm64@0.1.9` / https://github.com/asg017/sqlite-vec
- npm 버전 실측: `npm view {kysely,commander,@clack/prompts,smol-toml,uuid,vitest,typescript,pg,sqlite-vec,better-sqlite3,node-sqlite3-wasm} version time.modified`
- PostgreSQL 지원 버전: https://www.postgresql.org/versions.json / PG19 beta: https://postgresql.org/about/news/postgresql-19-beta-1-released-3313/
- pgvector: https://api.github.com/repos/pgvector/pgvector/tags , https://hub.docker.com/v2/repositories/pgvector/pgvector/tags
- 리포 실측: `<repo>` — `package.json`, `packages/`, `apps/cli/src/`, `packages/postgres/migrations/0001_initial.sql`
