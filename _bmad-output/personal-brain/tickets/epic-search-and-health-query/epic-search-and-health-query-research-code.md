---
title: "epic 17 텍스트·원문·건강 수치 조회 — 정적 코드 조사"
date: 2026-10-28
status: research
---

# epic 17 정적 코드 조사

조사 범위는 `plan/epics-12-on`의 현재 파일이다. 파일 읽기와 텍스트 검색만 했으며 테스트·빌드·Docker·네트워크·설치·패키지 추가·실측·커밋은 하지 않았다. 아래의 구현 경로와 타입 이름은 **후보**이며 새 결정이 아니다. 다른 워커가 고치는 epic 14 초안은 읽은 시점의 계획이지 구현 증거가 아니다.

근거 약칭(뒤의 `:행`은 아래 파일의 실제 행):

- `P/` = `_bmad-output/personal-brain/`.
- `spine` = `P/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md`.
- `initiative` = `P/initiative-personal-brain.md`, `spec` = `P/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md`.
- `E17` = `P/tickets/epic-search-and-health-query/epic-search-and-health-query.md`.
- `E11` = `P/tickets/epic-postgres-primary/epic-postgres-primary.md`.
- `E13` = `P/tickets/epic-extensions/epic-extensions.md`.
- `E14` = `P/tickets/epic-garmin-import/epic-garmin-import.md`, `T14` = `P/tickets/epic-garmin-import/tickets/tickets.toml`.
- `E4` = `P/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md`, `E8` = `P/tickets/epic-drive/epic-drive.md`.
- `recommendations` = `P/decisions-by-recommendation.md`.

기준은 R14·R15·R16와 C2다. 대화 검색·넓히기는 17로 이전되었고, 문서 결과·`files show`·문서 probe도 리포트 파일로 17이 처음 만든다. 16·18 전체 완료를 기다리지 않으며, 필요한 앞 에픽 코드 계약만 entry의 교차 의존으로 받는다. 임베딩은 지금 구현하지 않는다(`initiative:40`, `initiative:41`, `initiative:42`, `initiative:49`, `initiative:184`, `initiative:187`, `initiative:194`; `E17:59`, `E17:60`, `E17:61`; `E8:81`, `E8:82`).

**어긋남을 해석하는 순서:** CAP-4 본문에는 여전히 V1 뒤라고 적혀 있지만 17의 Description과 Notes는 대화 drain을 이 에픽에 둔다. CAP-6·7에는 2026-10-28 이동이 덧붙어 있다. E4의 SQLite FTS·`EXPLAIN QUERY PLAN`은 PG 기준으로 다시 쓰라는 Notes가 있으므로 그대로 구현하지 않는다. C6 사용자 선택 전 금지 문구는 위임으로 채워졌으며 다시 결정할 질문이 아니다(`spec:31`, `spec:38`, `spec:41`; `E17:16`; `E4:76`, `E4:79`; `initiative:188`, `initiative:190`; `recommendations:26`).

## 1. 현재 검색·조각과 epic 11의 경계

| 관찰 | 근거·해석 |
|---|---|
| 대화 `Chunk` 타입과 DB 표는 있으나 대화 조각 writer/drain은 없다 | `packages/core/src/domain/chunk.ts:5`는 타입이다. `packages/core/src/brain.ts:264`의 core handler 등록부는 schedule probe·identity·ingest·문서 추출·blob 삭제이며 대화 chunk handler가 없다. `packages/sqlite/migrations/0006_drop_message_seq.sql:117`도 writer가 아직 없다고 명시한다. |
| SQLite FTS5 trigram은 존재한다 | `packages/sqlite/migrations/0001_initial.sql:384`의 chunks FTS, `:406`의 log FTS, `:429`의 tool note FTS와 갱신 trigger가 있다. `packages/sqlite/src/store.ts:279`는 임시 FTS 표를 실제로 찾는 health probe다. 표·probe 존재는 제품 검색 use case 존재를 뜻하지 않는다. |
| 검색 명령·SDK·결과 union은 아직 없다 | `apps/cli/src/commands/index.ts:36`의 전체 명령 등록부와 `packages/core/src/brain.ts:212`의 Brain 공개 표면에 recall·health query·sessions read·files show가 없다. Store에는 내부 `readSession`이 있다(`packages/core/src/ports/store.ts:355`). |
| 결과 봉투의 칸은 준비됨 | `packages/core/src/envelope.ts:69`의 count·has_more·omitted·next, `:95`의 okEnvelope가 있다. 출처 union·랭킹·8,000자 budget 함수는 이 봉투가 구현하지 않는다. `SEARCH_FAILED`는 코드 정의만 있다(`packages/core/src/codes.ts:308`). |
| 이 worktree의 PG는 옛 초기 어댑터 | `packages/postgres/src/store.ts:49`는 HealthStore & SchemaStore만 반환한다. `packages/postgres/migrations/0001_initial.sql:141`은 seq 키, `:216`은 원래 컬럼 GIN 3개다. `compose.test.yaml:11`도 pgvector 이미지다. **어긋남:** 채택된 PG baseline·공식 이미지·시각 키·expression GIN 계획보다 오래된 코드다. 메인에서 완료되었다고 추정하지 않는다. |

**11이 제공할 것:** PG core baseline과 기존 SQLite 기능의 어댑터, `chunks.body`·`log_entries.text`·`tool_notes.target`·`document_chunks.body`·`file_names.text` 다섯 `lower(col)` expression GIN, `chunk_locator` 정규형 text 저장, 설정 DB/시간대다. 이 색인을 17에서 중복 이식하지 않는다(`E11:36`, `E11:87`, `E11:92`, `E11:94`).

**17이 만들 것:** 대화 조각 생성·증분 drain과 가리기 뒤 재생성, 단일 텍스트 질의 함수·대화/도구 메모/분석 리포트 검색·출처와 넓히기·원문 읽기·공통 결과 budget·건강 수치 port·상태 응답·자기 회귀 fixture다. 로그 검색·전체 index rebuild·미러·범용 러너는 4, 첨부·Drive·파일 이름 검색은 8이다(`E17:16`, `E17:17`, `E17:18`, `E17:19`, `E17:20`, `E17:42`, `E17:43`; `E4:78`).

읽는 동안 추가된 인계도 반영한다. 건강 소비 계약은 14.2, 리포트 관계는 14.5로 교차 의존을 고정하라는 문장이 E17에 들어왔다(`E17:62`). U+0000은 PG text에서 U+FFFD 검색/표시값과 nullable bytea 원문을 나누고 읽기에서 원문을 복원한다는 보강도 있다. 검색 body와 원문 반환의 차이를 검색→원문 fixture에 넣고, 조각 body에도 원문 보존이 필요한지 기존 Store 쓰기 코덱 범위를 확인해야 한다. 이 보강을 입력 거부로 바꾸지 않는다(`spine:222`; `recommendations:25`).

## 2. 대화 조각·일감·넓히기

현재 키는 `(session_id, index_config_id, from_at, to_at)`이고 닫힌 시각 구간이다. `seq`를 복구해 외부 식별자로 삼지 않는다. 규칙은 목표 1,200자·겹침 1메시지·2,400자 초과 메시지 분할·머리말 없음이며 config 행이 진실이다(`packages/core/src/domain/chunk.ts:8`, `:12`; `packages/sqlite/migrations/0006_drop_message_seq.sql:106`; `packages/core/src/domain/index-config.ts:10`; `packages/sqlite/migrations/0001_initial.sql:457`; `spine:276`, `spine:562`).

구현 후보는 Core 순수 chunker + Store의 세션 snapshot/원자적 chunk 교체 + drain handler다. 수집은 해당 세션·설정의 열린 일감을 멱등하게 만들고, 재청구는 같은 원문에서 같은 경계를 만든다. 읽은 snapshot 뒤 새 메시지나 redact가 들어오면 stale body를 commit하지 않도록 세션 세대/입력 fingerprint를 비교하거나 교체 시 잠금 아래 재검증하는 선택지가 있다. chunk 설정 변경은 새 `index_config_id`로 분리하되, 전체 사용자 `index rebuild` 명령은 4에 남긴다. 일감 청구/lease 자체를 17에서 새로 만들지 않고 앞 에픽 런타임에 얹는다(후보 근거: `packages/core/src/brain.ts:264`; `spine:351`, `spine:357`; `E4:43`, `E17:42`).

같은 시각에 여러 메시지가 있거나 긴 단일 메시지를 나누면 서로 다른 조각이 같은 UNIQUE 범위를 가질 수 있다. 기존 carry가 이미 이 위험을 적었다. 후보는 같은 시각 묶음을 한 chunk로 합치는 것, 분할 조각의 저장 모델을 보완하는 것이다. 후자는 고정 키와 충돌하므로 임의 ordinal을 키에 추가하지 말고 정제에서 충족 방법을 명시해야 한다. 순서 tie-breaker와 2,400자 초과 분할·겹침의 조합을 fixture로 먼저 드러낼 수 있다(`E4:72`; `packages/core/src/domain/chunk.ts:12`; `spine:276`).

**가리기 연쇄:** 현재 SQLite redact는 같은 트랜잭션에서 본문·도구 메모·기록을 바꾸고 `from_at <= occurred_at <= to_at` 조각을 지운다. 이 부분에는 재생성 enqueue가 없다. AD-11의 완성 계약은 조각/embedding 삭제·재생성·미러·정리 일감까지 하나의 트랜잭션이며 하나라도 실패하면 rollback/spool 금지다. 11의 PG redact·정리 구현을 받은 다음, 17은 자신이 처음 만드는 chunk 재생성 인계를 같은 트랜잭션에 추가해야 한다. 아직 구현하지 않는 미러를 17의 선행으로 끌어오지 않되, 뒤 에픽이 같은 인계에 붙을 경계는 남길 후보가 있다(`packages/sqlite/src/sessions.ts:153`, `:162`, `:174`; `spine:225`, `spine:226`, `spine:228`; `E11:96`; `E17:42`).

넓히기 후보 A는 `recall expand`가 chunk id로 session·from/to를 읽고 앞뒤 N개 메시지를 `(occurred_at, 안정 id)` 순으로 읽는 방식이다. B는 출처에 든 session/from/to를 직접 받아 chunk 재생성 후에도 같은 원문 구간을 읽는 방식이다. `sessions read`는 기존 Store.readSession을 공개 use case로 감싸고 pagination/budget을 붙일 수 있다. 어느 방식이든 인접 chunk body를 단순 이어 붙이면 overlap이 중복되므로 메시지를 읽어 dedupe하는 쪽이 출처 복원에 유리하다. 도구 메모 결과는 원 메시지 연결로 같은 경로를 쓴다. 도구 target은 `sessionForOutput`의 전용 가리기를 먼저 거쳐야 한다(후보 근거: `spine:286`; `packages/core/src/ports/store.ts:346`; `E4:73`).

## 3. 한국어 두 글자·세 글자와 실측 계획

**고정된 결론:** 정확도는 `lower(col) LIKE lower(pattern)`와 literal escape로 지킨다. 3글자 단위 trigram이 추출되지 않는 짧은 부분 문자열은 색인 이득이 없어도 전체 검색 비용을 허용한다. 두 글자가 안 맞는 검색으로 바꿔도 된다는 뜻이 아니다. `pg_bigm`은 SM-7 지연 미달 때 검증하는 Deferred이며 지금의 기본 결정을 재개방하지 않는다(`spine:277`, `spine:278`, `spine:773`, `spine:784`).

`%수면%`처럼 양쪽 wildcard인 두 글자와 `%수면량%` 세 글자를 구별해야 한다. 단어 경계 padding으로 생기는 trigram과 임의 부분 일치 패턴에서 안전하게 추출할 수 있는 trigram은 같은 질문이 아니다. 공백·기호가 끼면 세 글자 입력도 유효한 연속 trigram이 없을 수 있다. 현재 코드에는 locale별 한국어 결과를 증명하는 시험이 없고, 기존 SQLite probe는 영문 `probe`/`rob`만 쓴다. 그러므로 실제 이미지의 결과·속도·index scan 여부를 확정하지 않는다(`packages/sqlite/src/store.ts:283`, `:291`; `spine:277`, `spine:278`, `spine:784`).

| 비교 후보 | 정확도·운영 경계 |
|---|---|
| 채택된 LIKE + trigram 보조 | 두 글자는 LIKE가 맞히고 비용을 허용한다. 세 글자도 planner가 index를 선택한다고 보장하지 않는다(`spine:277`). |
| bigram expression GIN | `lower(col)` + `gin_bigm_ops`로 바꾸는 미래 후보. 공식 이미지 외 확장 공급·이미지 유지가 필요하므로 지연 미달 증거를 먼저 모은다. 지금 설치하지 않는다(`spine:773`, `spine:277`). |
| `ILIKE` + trigram 보조 | PG 자체 비교 실험 후보일 뿐 제품 경로 채택 후보로 바로 올리지 않는다. 채택 SQL과 다르고 `pg_bigm` 전환 호환 조건을 잃는다(`spine:277`). |
| 단어 경계 제한/접두 검색 | 일부 짧은 질의의 후보 축소 비교용. `불면수면` 안의 `수면` 같은 임의 부분 일치 적중을 빠뜨리므로 기본 검색을 대체할 수 없다(`spine:277`). |

공식 `postgres:18`은 계획이지 현재 compose 관찰값이 아니다. 태그만 보고 LC_CTYPE/LC_COLLATE·provider·encoding을 단정하지 않는다. 후속 실측 때 이미지 digest·OS 변형·DB 초기화 locale/provider를 기록하고 한국어를 문자로 취급하는지 `show_trgm`과 실제 LIKE 결과를 함께 본다. `pg_trgm`과 `unaccent`의 available/installed 여부도 그 이미지에서 확인할 항목이다. 옛 migration의 `CREATE EXTENSION pg_trgm`만으로 공식 이미지의 모든 조건이 검증된 것은 아니다(`E11:34`; `compose.test.yaml:11`; `packages/postgres/migrations/0001_initial.sql:11`; `spine:784`).

`unaccent`는 한글 두 글자를 bigram으로 바꾸는 해결책이 아니다. 도입하면 악센트 처리 의미·정규화와 expression index 함수 volatility/불변성·사전 변경 시 재색인까지 검토해야 한다. 지금의 `lower(col)` 계약에는 없으므로 추가 의존으로 채택하지 않는다. 이는 후속 검증 항목이지 이 조사에서 확장 가용성·volatility를 확인했다는 주장이 아니다(`spine:277`, `spine:669`, `spine:784`). 네트워크 금지에 따라 PostgreSQL·Docker 외부 공식 문서를 이번에는 열지 않았다. 공식 문서의 `pg_trgm`, `CREATE COLLATION`, `unaccent`와 Docker 공식 이미지 설명의 locale 항목은 후속 실측 때 확인할 자료다.

실측 계획(실행하지 않음):

1. epic 11 완료 HEAD의 공식 이미지·개발 전용 홈/DB에서 버전·digest·locale/provider/encoding·`pg_trgm` 확장 버전·다섯 expression index 정의를 기록한다(`E11:34`, `E11:36`; `spine:784`).
2. 동일한 합성 대화/도구 메모/리포트에 2자·3자·공백·`a-b`·`AND`·따옴표·`%`·`_`·역슬래시·NFC/NFD·혼합 언어를 넣는다. 전수 LIKE를 정확도 oracle로 삼고 literal escape 및 에이전트 재질의 fixture와 비교한다(`spine:277`, `spine:278`, `spine:630`).
3. 적은/많은 자료·높은/낮은 선택도·기간/꼬리표/분석 파일 필터 조합에서 통계 갱신 후 `EXPLAIN (ANALYZE, BUFFERS)`를 수집한다. plan node·recheck·후보/실제 행·buffer·지연 분포를 기록하고 순차/bitmap scan 어느 것도 고정 강제하지 않는다. `enable_seqscan=off` 결과를 제품 성능 증거로 삼지 않는다(`spine:277`, `spine:784`).
4. SM-7 기준과 R14 적중·원문 복원 성공을 함께 판정한다. 실패가 성능 문제이면 그때 Deferred bigram 비용을 비교하고, 실패가 0건/escape 문제이면 SQL 정확도를 고친다(`spine:278`, `spine:773`; `initiative:40`).

## 4. 문서 조각·원문 읽기·분석 파일 범위

현재 document drain은 추출 pieces에서 body·locator·page를 만들어 배치로 쓴다. Store에는 파일 추출 상태·세대 목록·ordinal 순 조각 읽기가 있다. 이는 문서 원문 출력 API가 아니다. `files show`는 등록부에도 Brain에도 아직 없다(`packages/core/src/files/extract-work.ts:422`; `packages/core/src/ports/store.ts:1315`, `:1338`, `:1344`; `packages/sqlite/src/extractions.ts:599`; `apps/cli/src/commands/index.ts:36`; `packages/core/src/brain.ts:212`).

검색 join 후보는 `analyses` → epic 14의 확정 파일 관계/요청 결과 공개 view → `files.current_extraction_id` → `document_chunks`다. `file_requests`가 pending/failed인 상태와 파일이 있으나 추출 포인터가 없는 상태를 구분한다. 모든 core 파일을 검색하거나 파일 확장자만 보고 분석이라고 추정하지 않는다. immutable analyses에 file_id를 나중에 UPDATE하는 것도 피한다. 정확한 관계 표·view 이름은 14 구현 HEAD에서 받는다(`E14:52`, `E14:53`, `E14:58`; `T14:8`; `spine:399`, `spine:581`).

이 에픽에서 처음 만들 `document` 결과 후보는 `kind`, `file_id`, 표시 이름, `extraction_id/ordinal` 또는 chunk id, `chunk_locator`, 출처/분석 id·날짜, 원문 접근 상태다. AD-15의 URL 칸은 현재 가능한 로컬 위치로 구성하고, Drive URL과 첨부 session/message 근접도는 8에서 넓힌다. extraction id를 넣으면 세대 교체 후 stale 결과를 어떻게 안내할지 명시해야 한다. locator는 text 코드 포인트 `[start,end)`, PDF page/bbox, DOCX block이며 `page`는 진실이 아니다(`spine:286`, `spine:399`; `E8:33`, `E8:82`; `packages/core/src/domain/chunk-locator.ts:7`).

`files show` 후보 A는 file id + locator로 현재 추출 텍스트의 해당 부분과 앞뒤를 읽고 원본 위치를 함께 준다. B는 file id에 chunk id/세대를 더해 당시 인용을 확인하고 세대가 사라졌으면 명시적으로 현재 세대로 이동하도록 안내한다. 원본이 닿지 않아도 마지막 성공 추출 조각은 읽을 수 있다. 가린 파일은 조각/이름/세대 삭제 이후 돌아오지 않아야 하고, unsupported·failed·too_large·source unreachable을 조용한 0건으로 합치지 않는다. 파일 바이트 자체를 텍스트 마스킹으로 처리하는 명령은 아니다(`spine:391`, `spine:399`; `packages/core/src/ports/store.ts:1307`; `E4:74`).

**probe를 더할 자리:** `OutputProbe`는 지금 texts/toolNotes만 받고 `allTexts`도 두 종류만 합친다. 실제 저장본에서 probe를 읽는 CLI 시험도 messages/tool_notes만 읽는다. 문서 조각·표시 이름·locator/URL에 비밀을 넣는 합성 추출 fixture를 추가하고, probe가 저장 원문을 읽게 하며 실제 문서 결과/`files show` renderer를 통과시켜야 한다. 일반 엔벨로프 재귀 가리기만 시험하고 문서 전용 mapping을 생략하면 안 된다(`packages/core/src/output/codecs.ts:41`, `:72`, `:131`; `apps/cli/test/output-codecs.test.ts:160`; `packages/core/src/envelope.ts:104`).

## 5. 건강 수치 조회 port

건강 표·metric catalog·"현재" view는 14가 정의하고 17은 소비한다. 현재 view는 dataset 권위 → revision → 지원 normalize 버전을 적용하며 다른 값 동률·계정 미확인은 ambiguity다. 문자열/JSON 숫자 집계 제외와 지표별 허용 집계도 14의 계약이다. 17이 최신 recorded_at으로 다시 권위를 선택하거나 확장 내부 표/raw에서 계산하지 않는다(`spine:492`, `spine:493`, `spine:494`; `E14:51`; `T14:19`, `T14:20`, `T14:21`).

| port 후보 | 칸·의미와 근거 |
|---|---|
| 입력 | `period`(절대 `[from,to)` 또는 date 범위+IANA timezone의 명시 union), `metrics[]`, 선택 `activityId`/운동 조건, `aggregate: sum/mean`와 명시적 groupBy. 계정/출처 필터가 필요하면 중립 identity를 쓴다. 자연어 해석은 에이전트 몫이다(`initiative:41`; `spine:256`, `spine:494`). |
| 출력 | metric id·정규 unit·aggregate·value(nullable), 전체 관측 수·비NULL 계산 수·NULL 수·ambiguity 수/이유, 실제 적용 기간·timezone·출처/dataset/revision 근거. ambiguity와 NULL은 서로 다른 칸이고 데이터 없음도 구분한다(`spine:493`, `spine:494`; `T14:20`). |
| 경계 | Store는 core current view와 catalog에서 선택된 행/근거를 읽고 Core 집계 함수가 합계·평균을 계산하는 후보. 제품 집계는 Core 코드에서 하고 독립 SQL은 시험 대조용으로만 둘 수 있다. 코드 계산 port 소유는 17이다(`spine:368`, `spine:494`). |

합계·평균 후보 규칙은 NULL을 0으로 바꾸지 않고, 평균 분모를 비NULL/비ambiguity 유효 숫자 수로 둔다. 빈 집합/전부 NULL의 `value=null`과 개수 0을 명시하면 실제 0과 분리할 수 있다. 운동 평균의 분모(운동별/샘플별/시간 가중)를 임의로 고르지 않고 catalog 허용 집계의 의미를 받는다. 단위가 다른 행은 혼합 합산하지 않으며, 지표별 precision·반올림 시점·큰 합계 수치 안전성도 fixture에 드러낼 선택지다(`spine:494`; `T14:20`, `T14:21`).

독립 fixture 후보: 손으로 기대 합계 40·평균 20을 정한 `[10, NULL, 30]`, 같은 논리 키의 다른 dataset/버전 중복, ambiguity 두 행, 전부 NULL, 0건, 금지 집계 분류형, 다른 단위, 자정 경계, DST 전환일, 운동 필터다. 기대값 생성에서 제품의 reducer/현재 선택 함수를 재사용하지 않는다. TS fixture와 별도 정수/유리수 계산 또는 SQL 대조의 원시 행 목록을 두어 분모·NULL·권위 오류를 잡는다. 14의 TS/Python 의미 fixture는 입력 선택 oracle이고 17의 집계 독립 검증을 대신하지 않는다(`spine:494`; `T14:20`, `T14:21`; `E17:35`).

현지 일별 값은 date+timezone 그대로 비교하고 UTC 자정으로 바꾸지 않는다. 순간형만 설정 시간대의 날짜 경계를 반열린 UTC로 바꾼다. 23/25시간 날도 24시간 밀리초 덧셈으로 만들지 않는 fixture가 필요하다. 응답에는 사용한 구간/시간대를 되울릴 후보가 있고, 현재 EnvelopeMeta에 범위 칸이 없으므로 data의 query 칸 또는 meta의 호환 확장을 명시해야 한다(`spine:255`, `spine:256`, `spine:258`; `packages/core/src/envelope.ts:69`; `E11:92`).

## 6. 확장 상태와 응답의 자리

확장 registry 공개 상태 view는 13이 설치·활성 상태를 쓰는 유일한 곳이고 검색은 읽기 소비자다. 이름/필드는 이 worktree에서 확정 구현이 보이지 않으므로 13 HEAD를 받아 정한다. core에 Garmin 설치 경로/Python 탐지나 schema 존재 여부 검사로 상태를 추정하는 코드를 넣지 않는다(`E13:20`, `E13:26`, `E13:57`; `spine:460`, `spine:461`).

후보 A는 검색 data를 `{results, extension_states}`로 감싸는 것이다. 그러나 AD-15의 0건 `data: []` 계약과 어긋난다. 후보 B는 `data` 배열을 유지하고 `meta.extensions` 같은 typed 칸에 `{source, installed, enabled, searchable, work_state}`를 둔다. 후보 C는 per-result provenance에 상태를 붙이고 0건일 때도 별도 meta 상태를 둔다. 현재 meta에는 이 칸이 없으므로 B/C는 공통 타입·코덱·schema 예제 확장이 필요하다. 미설치·비활성은 DB 연결 실패/SEARCH_FAILED/정상 0건과 다른 축이고, 비활성의 보존된 결과를 자동 제외하면 안 된다(`spine:289`, `spine:461`; `packages/core/src/envelope.ts:69`; `E17:36`).

## 7. 명령·메타·SDK·플러그인·회귀

| CLI 후보 | SDK 1:1 후보 | 범위 |
|---|---|---|
| `brain recall chunks` | `brain.recall.chunks(input)` | 대화 조각. 도구 메모 검색과 내부 질의 함수를 공유할 후보. |
| `brain recall tools` | `brain.recall.tools(input)` | AD-5 표에 있는 도구 메모 동사. `chunks`와 별도 공개 verb를 유지하는 후보(`spine:120`). |
| `brain recall docs` | `brain.recall.docs(input)` | analyses의 리포트 파일만. 이후 8이 대상을 넓힌다. |
| `brain recall expand` | `brain.recall.expand(input)` | 대화 출처 기반 앞뒤 메시지. |
| `brain sessions read` | `brain.sessions.read(input)` | 세션 원문·도구 메모. |
| `brain files show` | `brain.files.show(input)` | 문서 출처 기반 추출 원문·위치. |
| `brain health query` 또는 `brain metrics query` | `brain.health.query(input)` 또는 `brain.metrics.query(input)` | core 건강 current view 집계. 이름 선택은 정제 사항이다. |

대화 명령·출처 이름은 AD-5 표·AD-15와 옮겨 온 계약에 근거한다(`spine:118`, `spine:120`, `spine:121`). 건강 명령 이름은 미정이며 Garmin 전용 namespace보다 출처 중립 명령이 AD-29·30에 맞는다. 공통 `brain recall search`를 별도로 만들면 기존 `chunks/docs`와 겹치는 공개 API 수가 늘어나는 비용도 있다(`spine:286`, `spine:288`, `spine:459`; `E4:76`; `E17:20`).

명령은 `apps/cli/src/commands/`의 CommandSpec으로 등록하고 `run`에서 SDK만 부른다. usedFor·required·examples·output·risk·hook·dryRun 및 명령 입력/출력 schema를 함께 채운다. 읽기 risk와 writes 여부를 맞추며 help/guide schema가 같은 등록부에서 나오게 한다. CLI 내부에서 SQL을 만들지 않는다(`apps/cli/src/dispatch.ts:92`, `:219`, `:250`; `apps/cli/src/commands/index.ts:22`; `apps/cli/test/command-meta.test.ts:45`; `spine:107`).

플러그인 검색 안내 스킬은 표현 바꾸기→검색→출처로 원문→수치 명령→데이터 없음/미설치 상태 안내를 반복 가능하게 하는 후보다. 새 계산/자연어 날짜 parser를 스킬에 숨기지 않는다. 필수 새 스킬 수는 기록된 결정에 없으므로 기존 공통 안내에 넣을지 얇은 `recall` 스킬로 둘지 정제에서 고를 수 있다. 현재 plugin에는 bootstrap/hooks/bin 중심 파일만 있고 검색 명령도 없다. 후속 13이 install 스킬 기반을 만들면 이를 재사용한다(`spine:280`; `E13:23`, `E13:26`; `plugin/bootstrap.mjs:16`; `apps/cli/src/commands/index.ts:36`).

17 회귀는 합성 fixture로 2글자·표현 바꾸기·데이터 없음·출처 복원을 시험한다. 표현 바꾸기는 모델을 테스트 중 부르지 않고 동일 의미의 고정 재질의 묶음과 기대 적중 id로 검증할 수 있다. 범용 문항 TOML·hit@k 러너·개인 결과 저장은 4에 남기고 동일 fixture를 미래 러너가 읽을 수 있게 할 선택지는 있다. 실제 질문 10개 중 7개 기준은 구조적 fixture 통과와 별도로 계획에 남긴다(`E17:42`; `E4:24`, `E4:39`; `spine:278`, `spine:689`).

## 8. 공유 파일 레인·18 병행·세션 크기

다음 표는 현재 파일과 새 파일 후보를 구분한다. 앞 에픽이 파일을 분리했다면 그 HEAD의 실제 위치로 바꿔야 한다(`E11:97`; `E17:61`).

| 공유 경계 | 함께 고칠 스토리 후보 | 병합/크기 위험 |
|---|---|---|
| `packages/core/src/ports/store.ts`, `packages/core/src/testing/fakes/store.ts` | chunk drain, 검색, 문서 읽기, 건강, 상태 | 거대한 Store 확장과 fake 동시 충돌. capability별 port 분리 후보. |
| `packages/postgres/src/store.ts` 및 신규 검색/건강 adapter 후보 | 같은 후보 전반 | 현재는 health/schema뿐. 11에서 분리된 파일 구조를 먼저 받는다(`packages/postgres/src/store.ts:49`). |
| `packages/postgres/migrations/` | chunk 인계/추가 인덱스가 필요할 때, 건강 조회용 보완 | 14 표를 다시 만들지 않음. 18과 core 번호 중복은 뒤에 합치는 쪽이 재번호·checksum 정합성을 확인한다(`spine:481`, `spine:482`; `E17:61`). |
| `packages/core/src/brain.ts`, `packages/core/src/index.ts`, `packages/second_brain/src/index.ts` | 모든 SDK 노출/handler | 18의 분석 SDK/handler와 겹친다. 공개 타입 호환 확인 필요. |
| `packages/core/src/output/codecs.ts`, `packages/core/src/envelope.ts`, `apps/cli/test/output-codecs.test.ts` | 문서 probe, 결과 budget, 확장 상태 | 18의 모델 입력/도구 응답 코덱과 충돌. 합집합 registry와 실제 renderer probe를 보존(`spine:221`). |
| `apps/cli/src/commands/index.ts`, `apps/cli/src/dispatch.ts` | 모든 명령과 메타 | 18 명령 추가와 충돌. 등록부 누락·schema 예제 불일치를 확인(`apps/cli/test/command-meta.test.ts:45`). |
| `apps/cli/src/assembly.ts`, plugin 안내·app-ref/version | adapter 조립, 설치본 검증 | 18의 모델 runner와 공유. 릴리스 ref는 이전 commit이고 version과 같이 바뀜(`README.md:955`). |

17과 18의 데이터 의존은 없다. 다만 공유 경계 때문에 같은 파일을 만지는 스토리의 병렬 레인 효과는 낮다. 후보는 17 내부 tracer→공통 결과/문서→chunk→건강→회귀/배포의 한 레인, 또는 공통 API를 먼저 고정하고 건강 순수 집계와 검색 adapter를 잠시 분리하는 방식이다. 18 전체 완료 gate를 새로 만들지는 않는다(`initiative:184`; `E17:61`).

한 세션 위험이 큰 부분은 (a) chunk 동시성+동시각+긴 메시지+redact 재생성을 한꺼번에 완성하기, (b) 문서 세대·관계·원문 출력·코덱을 처음 연결하기, (c) 건강 현재 선택과 합계를 모두 다시 만들기다. tracer는 합성 한 세션·리포트 한 파일·2글자 한 질의·원문 한 경로로 제한하고 edge matrix는 뒤 후보로 분리할 수 있다. 건강 현재 선택을 재구현하지 않으면 (c)를 줄인다(위험 근거: `E4:72`; `spine:228`, `spine:399`, `spine:493`; `T14:8`, `T14:20`).

## 9. Done when 1~4의 시험 기반·빠진 것

| Done when | 기존 기반 | 빠진 검증 |
|---|---|---|
| 1: 2글자/표현 바꾸기/대화·분석 원문 | `packages/core/test/contracts.test.ts:1`의 adapter 계약 기반, `packages/core/test/document-extract.test.ts:1`의 추출 기반, `packages/core/test/chunk-locator.test.ts:1` | 대화 chunk writer/검색 Store 계약, 두 글자 PG query fixture, 분석 관계 필터, 결과 출처→expand/sessions read/files show 통합 경로, 표현 바꾸기와 10개 중 7개 증거. |
| 2: 정확한 합계·평균 | 14가 만드는 공유 의미 fixture 계획(`T14:20`, `T14:21`), 시각 정규형 계약(`spine:255`) | 독립 계산 oracle, NULL·ambiguity 분모, 단위·허용 집계·운동 identity·현지 날짜/DST, 실제 core current view 조회. |
| 3: 실패·0건·미설치·비활성·8,000자·비밀 | `packages/core/src/codes.ts:308`, `packages/core/src/envelope.ts:69`; `apps/cli/test/output-codecs.test.ts:183`, `:337`은 코덱과 미등록 sink를 검사 | SEARCH_FAILED 실제 매핑/정상 빈 배열과 hint, registry 상태(meta와 빈 결과), limit+1·하위 행 통째 생략·1위 최후 절단·next, 코드 포인트와 가리기 후 최종 길이, 문서 probe·redact 직후 재검색. |
| 4: 이 Mac 설치본 | `apps/cli/test/install.test.ts:1`, `apps/cli/test/install-flow.test.ts:1`; `README.md:955`의 릴리스 절차 | 새 빌드로 app-ref/version 경로·로컬 플러그인 발견·실제 설치본 CLI/doctor·검색/원문/집계 smoke의 증거. unit 통과가 설치본 확인을 대신하지 않음. |

8,000자는 출력 가리기로 길이가 늘 수 있으므로 raw body 길이만 재면 상한 증거가 아니다. 결과의 표시 텍스트를 어떤 범위까지 세는지 명시하고 code point 기준으로 budget을 잡되 마지막 codec 결과까지 시험할 후보가 있다. 1위 행 최후 절단에서도 출처/다음 호출을 잃지 않고, 비밀 잘린 접두가 새로 노출되지 않게 가리기·절단 순서를 시험한다(`spine:288`, `spine:630`; `packages/core/src/output/mask.ts:18`, `:73`; `packages/core/src/envelope.ts:104`).

**이 Mac 확인은 에이전트가 할 수 있다.** 설치·명령·doctor와 로컬 app-ref/version은 위임된 `hitl=false` 작업이며 plan에 증거를 남긴다. 원격 push는 operator_actions다. 이번 조사는 설치 금지이므로 확인하지 않았고, 후속 설치본 스토리는 격리 홈 합성 fixture로 부작용 없이 동작을 확인하고 운영 설치본의 버전/플러그인 경로를 읽는 식으로 범위를 정할 수 있다(`initiative:188`, `initiative:189`, `initiative:192`; `recommendations:18`, `recommendations:44`; `E17:37`).

## 스토리 후보

다음은 tracer 제안과 순서 선택지다. entry 번호·의존·hitl·새 Decision을 확정하지 않는다. 앞 에픽 코드가 도착하면 실제 API와 다음 migration 번호를 다시 읽는다(`E17:56`, `E17:57`, `E17:58`; `E11:97`; `T14:20`).

| 후보 | 한 세션의 관찰 가능한 끝 | 고칠 파일 후보 |
|---|---|---|
| T1 tracer: 분석 리포트 검색→원문 | 14의 합성 `analyses` Markdown 한 파일을 두 글자로 찾아 `document` 출처만으로 `files show` 원문을 읽고 비밀이 가려짐. 건강·전체 대화 chunk 완성은 포함하지 않음(`E17:19`; `T14:8`) | 신규 `packages/core/src/recall/` 검색 함수·docs, `files/show.ts`, 검색 Store port/PG adapter, `brain.ts`/공개 exports, CLI recall-docs/files-show와 등록부, `output/codecs.ts`, `apps/cli/test/output-codecs.test.ts`. |
| T2 대화 조각과 가리기 재생성 | 1,200/겹침/긴 메시지·같은 시각 fixture로 chunk 생성, 증분·retry 멱등, redact 후 옛 텍스트 미노출(`spine:228`, `spine:276`; `E4:72`) | 신규 Core chunker/일감, `domain/chunk.ts`·index-config 소비, Store/fake·PG chunk adapter, ingest/redact enqueue·handler 조립, 필요한 다음 migration, chunk/redact 계약 시험. |
| T3 대화·도구 메모 검색과 넓히기 | source→expand/read, 꼬리표 정렬, 전용 target 마스킹, 공통 8,000자·실패·빈 결과 계약(`spine:286`, `spine:288`, `spine:289`) | Core recall chunks/expand·sessions read·공통 결과/budget, `brain.ts`, PG 검색 adapter, CLI commands/등록부·메타·회귀 fixture. |
| T4 건강 수치 port | 14.2 current view/catalog를 읽어 합계·평균·단위·NULL·ambiguity·현지 날짜가 독립 계산과 일치(`T14:20`; `spine:494`) | 신규 Core health query/aggregation·기간 함수(11/12의 공통 함수가 있으면 재사용), port/fake, PG health 조회, SDK/export, CLI health 또는 metrics query, 독립 fixture. |
| T5 상태·실패/적중 회귀와 locale 실측 | 미설치/비활성/0건/실패가 구별되고 2/3자·literal·표현 바꾸기와 EXPLAIN 증거가 남음(`E17:36`; `spine:784`) | registry 공개 view 소비 adapter, 결과/EnvelopeMeta 칸, Core/PG/CLI 통합 fixture, 측정 plan(후속 실행 때), 명령 메타 예제. |
| T6 정리·안내·Mac 설치본 | 앞 후보 계약을 통합하고 플러그인 로컬 배포/설치본 검색·원문·수치·doctor 증거(`initiative:189`; `README.md:955`) | 필요한 Core/CLI 리팩터, plugin 안내/스킬 후보, `plugin/app-ref`·`plugin/.claude-plugin/plugin.json`, 설치 smoke/해당 plan. |

순서안 A는 **T1→T2→T3→T4→T5→T6**다. 이미 있는 문서 추출 기반과 14 tracer를 이용해 가장 얇은 원문 경로를 먼저 연결한다. 순서안 B는 **T2→T3(문서 결과 포함 T1 흡수)→T4→T5→T6**다. chunk의 동일 시각/재생성 위험을 먼저 푸는 대신 첫 tracer가 커진다. 순서안 C는 T1 뒤 T4의 순수 집계 부분을 먼저 만들고 T2/T3를 잇는 방식이며, 포트·SDK·명령 등록부의 통합 편집은 한 레인으로 유지할 수 있다. 새 건강 분석 18과 새 Garmin 수집 16을 기다릴 필요는 없고, digest를 실제로 호출하는 후보가 생길 때만 16의 해당 코드 의존을 더한다(`E17:59`, `E17:61`; `packages/core/src/files/extract-work.ts:422`; `E4:72`).
