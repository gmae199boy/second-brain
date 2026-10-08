---
review: architecture-spine rubric review
target: ../architecture-brain-v1-slice-1.md
sources: [../.memlog.md, ../../prd-brain-v1-slice-1/prd-brain-v1-slice-1.md, ../../prd-brain-v1-slice-1/addendum.md]
reviewed: 2026-10-08
verdict: 조건부 통과 — 구조·불변식은 튼튼하지만 컬럼 계약과 운영 봉투가 비어 있어 독립 에이전트가 갈라진다
---

# Spine 리뷰 — Personal Brain V1 slice 1 (good-spine 체크리스트)

## 판정

AD-1~19는 "제품이 Core로 새는 것"과 "원문이 바뀌는 것"이라는 두 핵심 분기를 잘 막는다. 그러나 **아래 층(epic/story)이 실제로 손대야 하는 두 계약 — 테이블의 컬럼 집합과 설치된 도구의 운영(업그레이드·마이그레이션·백업·제거) — 이 거의 비어 있다.** 이 상태로 story를 독립 에이전트에 나눠 주면 스키마와 운영 절차가 단위마다 갈라진다. Critical 2건을 메우면 build substrate로 쓸 수 있다.

## 체크리스트 요약

| 항목 | 판정 | 비고 |
| --- | --- | --- |
| 아래 층의 실제 분기점을 빠짐없이 고정 | 미흡 | 컬럼 계약·명령 표면·조회 결과 계약·지연 예산이 빔 (C-1, H-3, H-7, H-6) |
| 모든 AD의 Rule이 집행 가능하고 분기를 실제로 막음 | 부분 | AD-12(정규화 규칙 없음), AD-1↔AD-8/13(모순), AD-7(일감 모델 없음) |
| Deferred에 분기 여지 없음 | 부분 | "하이브리드 결합·HNSW 파라미터"가 AD-15의 켜는 경로와 충돌 (M-6) |
| 기술 버전 최신 확인 | 부분 | memlog `version` 2026-10-08에 @clack/prompts·tsdown·재순위 모델명 없음 (M-5) |
| PRD 커버리지 (FR-1~25, NFR-1~9) | 부분 | FR-2 검색, FR-6, FR-13/14/16, FR-24 표면, FR-25 점검 항목, NFR-4 집행 누락 |
| 고도가 소유한 모든 차원이 결정/연기/열린 질문 | 미흡 | **운영 봉투 전체가 침묵** (업그레이드·마이그레이션 실행·백업·제거·관측) |
| 결정 중심, 간결, mermaid 유효 | 양호 | 4개 다이어그램 모두 문법 유효. 서술은 충분히 terse |

---

## Critical

### C-1. 스키마가 "테이블·관계"까지만 고정되어 컬럼 계약이 없다

ERD에 속성이 하나도 없고, PRD addendum §2 스케치는 스스로 "architecture에서 확정한다"고 명시하므로 상속되지 않는다. 결과로 다음이 전부 미결정이고, 각각 독립 story가 자기 식으로 만든다.

- **FR-6 전체가 침묵**: `ingest_source(live|import)`, `ingested_at` vs `messages.occurred_at` 분리, 시간 조회는 발화 시각 기준이라는 규칙. FR-6은 `binds`에 있고 AD는 하나도 없다.
- **AD-7의 일감 모델 없음**: `FOR UPDATE SKIP LOCKED`로 "일감을 나눠 가진다"고 했는데 잠글 행이 무엇인지(세션의 `ingest_status`/`index_status` 상태 전이인지, 별도 큐 테이블인지) 없다. drain의 6종 작업(실패 수집·미색인·인용 대조·로그 연결·spool 재주입·폴더 스캔)이 각각 어느 행으로 표현되는지 미정.
- **AD-4 parser 커서의 저장 위치**: "세션별 커서(마지막 Harness 메시지 ID)"가 `sessions`의 컬럼인지 별도 테이블인지 없다.
- **규칙 계약 컬럼**: FR-19/FR-22의 인용 위치(`quote_message_id`, `quote_start/end`), `rule_state(on|off)`, **적용 범위(`only_project_id`)**. 적용 범위는 spine 본문에 한 번도 등장하지 않는데 AD-12는 "꼬리표와 적용 범위는 별개"라는 PRD 구분을 받아 적지 않았다.
- **FR-9 표시용 컬럼**: `first_prompt`, 세션 목록의 "기타" 묶음.
- **FR-3 예약 자리**: `continued_from_session_id`, `continuation_kind`, `machine`, 사용자 식별자(AD-12가 "칸이 있다"고만 함 — 이름 없음).
- **이름 드리프트**: Conventions는 "실패 기록 테이블", ERD는 `failures`, addendum은 `ingest_failures`.

**제안 수정**: Structural Seed 뒤에 "Table Contract" 절을 하나 넣고, ERD를 속성 포함 형태(`sessions { uuid id; text harness; ... }`)로 바꾸거나 테이블별 필수 컬럼 표를 붙인다. 최소한 (a) 멱등·커서 컬럼, (b) 상태 전이 컬럼과 허용 값, (c) 규칙 3종 컬럼(인용·상태·적용 범위), (d) FR-6의 세 칸을 명시한다. 선택 컬럼은 "story가 추가 가능"으로 표시해 열어 둔다.

### C-2. 설치된 도구의 운영 봉투가 비어 있다 — 특히 업그레이드와 스키마 마이그레이션 실행

Conventions에 마이그레이션 **형식**(SQL 파일, 순번, 앞으로만)은 있지만, **누가 언제 돌리는지**가 없다. AD-19는 설치 시점만 다룬다. 이 도구는 (1) 전역 설치되고, (2) hook이 절대 경로로 그 바이너리를 부르고, (3) 상주 프로세스가 없어 "시작할 때 한 번" 지점이 없다. 그래서 다음이 전부 미정이고 운영 중 조용히 깨진다.

- `npm i -g second_brain@latest` 후 마이그레이션은 누가 돌리나(업그레이드 후 첫 실행이 자동? `brain setup`만? hook 경로에서도?).
- **버전 스큐**: 새 바이너리가 옛 스키마를, 또는 옛 hook이 부르던 경로의 바이너리가 새 스키마를 만났을 때 — 거부하고 안내하나, 자동 이행하나, 그냥 도나. hook 경로는 "항상 exit 0"이라 거부도 보이지 않는다.
- **hook 절대 경로의 수명**: nvm/볼타 등으로 Node 버전을 바꾸면 전역 bin 경로가 바뀌어 hook이 조용히 죽는다. AD-19는 `npx` 지연만 막고 이 경우를 다루지 않는다. doctor가 hook 경로 유효성을 보는지도 미정.
- **백업·보존**: NFR-9 내보내기 형식은 있지만 백업 주체·주기·위치가 없다. Docker named volume의 백업/이전, `brain export` 주기, spool·미러의 보존 정책 모두 침묵. FR-25가 요구하는 "마지막 내보내기 시각"도 doctor 계약에 없다(H-6).
- **컨테이너 수명**: memlog는 `restart unless-stopped`를 결정했는데 spine에 없다. 재부팅 후 DB가 안 떠 있는 것이 최빈 실패 모드인데 spine의 답은 spool뿐이고, 컨테이너를 다시 띄우는 책임자(doctor? setup? 사용자?)가 없다.
- **제거**: 완전 침묵. hook 해제, 컨테이너·볼륨, `~/.second_brain`, 전역 패키지 중 무엇을 어떤 순서로 지우는지 — slice 1 사용자가 바로 필요한 절차다.

**제안 수정**: `AD-20 — 버전과 마이그레이션`과 `AD-21 — 설치 수명 주기(업그레이드·제거)` 두 개를 추가한다.
- AD-20 Rule 예: "DB에 `schema_version` 한 행을 둔다. 모든 진입점은 시작 시 코드의 기대 버전과 비교한다. 코드 > DB면 `brain setup`·`brain migrate`·`brain doctor`만 마이그레이션을 돌리고, 그 밖의 명령과 hook 경로는 쓰기를 멈추고 spool에 쌓으며 'brain setup 필요'를 doctor와 시작 맥락에 올린다. 코드 < DB면 모든 쓰기를 거부한다. 마이그레이션은 되돌리지 않는다(앞으로만)."
- AD-21 Rule 예: "업그레이드는 `npm i -g second_brain@latest && brain setup`. setup은 hook에 등록된 절대 경로를 현재 실행 파일 경로로 다시 쓰고, doctor는 등록된 경로의 존재·버전을 확인한다. 제거는 `brain uninstall`: hook 제거 → (동의 시) 컨테이너·볼륨 → `~/.second_brain` 보존 여부 질문 → 전역 패키지 안내. 데이터 삭제는 항상 명시 동의."
- Conventions에 "백업: `brain export`가 유일한 공식 백업 경로, 위치는 설정 한 줄, doctor가 마지막 시각을 보인다" 한 줄 추가.

---

## High

### H-1. AD-1(Core 런타임 의존성 0) ↔ AD-8(UUIDv7)·AD-13(절대 시각) 모순

Core가 레코드를 만들면 UUIDv7 생성기와 현재 시각이 필요하다. Node 24의 `crypto.randomUUID`는 v4이고, Stack의 `uuid 14.0.2`는 외부 패키지다. 즉 AD-1을 지키면 AD-8을 Core에서 지킬 수 없고, AD-8을 Core에 두면 AD-1이 깨진다. 시각도 같다(테스트 결정성 문제까지 겹친다). 어느 쪽으로 풀든 story마다 다르게 주입한다.

**제안 수정**: AD-8 Rule에 "Core는 `IdGen`·`Clock` 두 포트를 받는다(둘 다 port, Runtime이 조립). Runtime의 기본 구현은 `uuid` v7과 `Date`. adapter·CLI가 자기 멋대로 ID나 now를 만들지 않는다"를 추가하고, AD-1의 "런타임 의존성 없음"을 그대로 유지한다. Stack의 `uuid` 행에 "(Runtime 구현용, Core는 포트로만 앎)"을 단다.

### H-2. AD-12의 "정규화한 git remote URL"에 정규화 규칙이 없어, 막으려던 분기를 막지 못한다

`git@github.com:a/b.git`, `https://github.com/a/b`, `https://github.com/A/B/`, host alias(`git@gh-work:a/b`)가 모두 같은 프로젝트로 모이는지는 정규화 정의에 달렸다. 정의가 없으면 "사람·기계마다 같은 레포가 갈라지는 것"이 그대로 일어난다. 또 **워크트리 정체성**(경로? 브랜치? 둘?)과 폴더 삭제 후 동작(FR-4의 "지워진 뒤에도 조회")도 없다.

**제안 수정**: AD-12에 정규화 절차를 순서대로 박는다 — "scheme·credential·포트 제거 → host 소문자 → `.git` 접미사와 끝 슬래시 제거 → `host/owner/repo` 소문자 한 줄로. remote 여럿이면 `origin` 우선. remote 없으면 `git rev-parse --git-common-dir`의 realpath." 워크트리는 "`git-common-dir`가 같고 작업 폴더 경로가 다른 것, 정체성은 realpath, 폴더가 사라져도 행은 남는다(삭제 표시 칸)"로 한 줄 추가.

### H-3. SDK·CLI 표면(명령·메서드 이름 집합)이 고정되지 않았다

AD-5는 "1:1 같은 이름"이라는 **규칙**만 주고 **목록**을 주지 않는다. spine에 등장하는 명령은 `context, ingest, log, recall, drain, doctor, mirror --rebuild, reindex, setup`뿐이고, FR-24가 요구하는 13개 중 다음이 어디에도 없다: 내보내기, 넓히기(expand), 도구 메모 검색(FR-2), 워크스페이스에 넣기, 수집 실패 조회·다시 수집, 작업 로그 조회·수정·끄기, 적용 범위 변경. memlog가 결정한 `brain connect <harness>`도 spine에서 사라졌다(설치기 안으로 흡수된 듯하나 명시 없음). 명령 이름은 story 사이의 1차 인터페이스라 목록이 없으면 반드시 갈라진다.

**제안 수정**: AD-5 아래에 `SDK ↔ CLI 표면` 표를 넣는다(행: SDK 메서드 / CLI 명령 / 읽기·쓰기 / FR). FR-24의 13개 항목을 모두 한 행씩 채우고, 쓰기 API는 PRD 제약대로 `sessions.ingest`·`log.append` 둘뿐임을 재확인한다.

### H-4. 단명 프로세스의 지연·timeout 예산이 침묵 — SM-7과 정면 충돌 가능

spine에는 숫자가 하나도 없다: 동기 SessionStart hook의 timeout, PG 연결 timeout, 임베딩·재순위 호출 timeout, Stop hook의 허용 처리 시간. 더 중요한 것은 **memlog가 "실제 지연 원인은 PG 연결·첫 쿼리 → 실행 형태에서 다룸"이라고 미뤘는데 spine에 그 결정이 없다**는 점이다. 데몬 없는 CLI에서 Node 부팅 + PG 연결 + 첫 쿼리로 SM-7의 "시간 조회 0.1초"는 달성 불가에 가깝다. 아래 층은 이 충돌을 풀 권한이 없다.

**제안 수정**: `AD-22 — 지연 예산` 추가. (a) 경계별 timeout 값을 표로 박는다(동기 hook 2s, DB 연결 1s, 임베딩 10s, 재순위 3s 등). (b) 측정 대상을 "프로세스 내부 처리 시간"으로 다시 정의하고 프로세스 기동·연결 비용을 별도 항목으로 분리하거나, SM-7의 0.1초를 "1초 이내"로 바꾸는 PRD 수정을 열린 질문으로 올린다. (c) "모든 명령은 연결을 한 번만 열고 닫는다(풀 없음)"를 명시.

### H-5. 조각(chunk) 생성 규칙과 키워드 검색 대상이 미정 — NFR-4 집행 장치도 없음

- 조각 크기·경계·겹침(addendum §1의 1,200자·메시지 경계·1메시지 겹침)이 spine에 없다. FR-10은 "값은 addendum §1"이라고 PRD에서 넘겼는데 spine이 받지 않았다. 조각 경계가 갈라지면 색인과 검색이 서로 못 맞춘다.
- 조각을 **언제** 만드는지 미정(AD-6은 SessionEnd에 "색인"만 말한다). 임베딩이 기본 꺼짐인데 조각은 그래도 만드는가?
- **AD-15의 "기본 검색은 키워드(`pg_trgm`)"가 어느 컬럼을 대상으로 하는지 없다.** `messages.body`, `chunks.body`, `log_entries.text`, `tool_notes.target` 중 어디에 GIN trigram을 거는지, 유사도 임계값과 정렬 기준은 무엇인지 미정. FR-2의 도구 메모 검색 경로도 이 공백에 걸려 있다.
- NFR-4는 "영어 전용 구성이면 점검이 실패로 표시"를 요구하는데, 임베딩을 끄고 `pg_trgm`을 기본으로 둔 구성에서 한국어 동작을 무엇으로 보장·점검하는지 규칙이 없다(trigram은 형태소를 모른다).

**제안 수정**: AD-15에 (1) 조각 규칙 3줄(목표 1,200자, 메시지 경계 유지, 겹침 1메시지, 상한), (2) "조각은 임베딩 여부와 무관하게 수집 시 만든다", (3) 키워드 검색의 대상 컬럼·인덱스 종류·정렬 기준 표, (4) "doctor는 한국어 질의 고정 표본으로 키워드·(켜져 있으면) 임베딩 경로가 결과를 돌려주는지 확인한다"를 추가한다.

### H-6. `brain doctor` 출력 계약이 네 AD에 흩어져 있고 FR-25 항목이 빠졌다

현재 doctor 언급은 AD-10(연결·pgvector·버전), AD-9(spool 건수·최古), AD-15(색인 설정 불일치), AD-14(끝내 실패한 규칙)로 분산되어 있고, FR-25가 명시한 다음이 없다: **미수집 세션(+Claude Code 30일 삭제 기한 경고, FR-5)**, **규칙 부분 크기 경고(FR-17/SM-C1)**, **마지막 내보내기 시각(NFR-9)**, **주입 실패**. doctor는 NFR-2의 유일한 창구라 항목이 빠지면 조용한 실패가 된다. 또 doctor를 구현하는 story가 어느 목록을 믿을지 모른다.

**제안 수정**: `AD-23 — 점검 출력 계약`을 하나 만들고 FR-25의 항목을 전부 행으로 나열한다(각 행: 항목 / 판정 기준 / 경고 코드). 다른 AD들은 그 행을 가리키게만 한다.

### H-7. 조회 결과 계약(순위·상한·출처 필드)이 미고정

- **FR-13의 근접 정렬**(같은 워크트리 → 프로젝트 → 워크스페이스 → 나 전체)을 관련도와 어떻게 결합하는지 없다. 단순 그룹 정렬인지 가중치인지에 따라 결과가 완전히 달라진다.
- **FR-14/SM-C2 상한**(결과 조각 수, 8,000자)이 없고, 절단을 Core가 하는지 CLI가 하는지도 없다. AD-5가 "CLI에 로직 금지"라 했으니 Core여야 하는데 명시가 없다.
- **FR-16 출처 필드**가 결과 아이템에 어떤 모양으로 실리는지 없다(세션 id + 메시지 seq 범위 + 시각 + 꼬리표?). 넓히기(FR-15)를 부를 열쇠가 바로 이것이라 단위마다 다르면 에이전트가 쓰지 못한다.

**제안 수정**: Conventions의 `--json` 항목 아래에 `data` 아이템 공통 형태를 박는다 — `{ kind, id, text, occurred_at, source: { session_id, from_seq, to_seq }, tags: {...}, score }` + "결과 집합은 Core에서 `maxItems`·`maxChars`(기본 8,000)로 자르고, 자른 사실을 `warnings`에 넣는다" + AD-15에 근접 정렬 결합 규칙 한 줄.

### H-8. 시작 맥락의 크기 상한·절단 규칙과 토큰 계산 방법이 없다

FR-17은 "SM-C1 상한은 최근 작업 로그 부분에 적용, 넘치면 오래된 줄부터 뺀다", "규칙 부분이 500토큰 넘으면 그대로 넣되 경고"를 요구한다. spine에는 둘 다 없다. 게다가 Brain은 LLM도 토크나이저도 부르지 않는 제약이 있어 **토큰을 무엇으로 세는지**(문자 근사? 외부 토크나이저 패키지?)가 결정 사항인데 비어 있다. 시작 맥락은 SM-1의 직접 입력이라 story가 임의로 정하면 측정이 흔들린다.

**제안 수정**: AD-17(또는 AD-6)에 "최근 로그 부분은 1,200자(≈300토큰) 상한, 초과 시 오래된 줄부터 제외. 규칙 부분은 전부 넣고 2,000자(≈500토큰) 초과 시 doctor 경고. 크기는 문자 수로 센다(토크나이저 의존 없음, 환산비는 설정 아님)"를 추가.

---

## Medium (9건)

1. **경고·오류 코드 어휘가 없다.** Conventions가 `warnings[]`에 "코드와 함께"를 요구하지만 코드 문자열 집합이 없다. 에이전트가 읽는 계약이라 단위마다 다르면 못 쓴다. → 코드 표를 Conventions에 붙인다(`DB_UNAVAILABLE_SPOOLED`, `RERANK_FAILED`, `INDEX_CONFIG_MISMATCH`, `SESSION_NOT_INDEXED`, `RESULT_TRUNCATED`, `RULE_QUOTE_UNMATCHED`, `SCHEMA_BEHIND` 등).
2. **Markdown 미러의 파일명·본문 형식이 미정.** AD-16은 "세션당 파일 하나"만 정한다. 용도가 "아무 에이전트의 grep"이므로 파일명 규칙(날짜·프로젝트·세션 id 조합)과 머리말·구분선 형식이 계약이다. → AD-16에 파일명 템플릿과 최소 머리말 필드를 명시.
3. **spool 레코드 스키마·파일 분할·상한이 미정.** AD-9은 경로와 append-only만 정한다. 재주입이 멱등이어야 하므로 레코드에 UUIDv7·종류·원래 API 이름·payload가 필요하다. 파일 크기 상한·분할·손상 라인 처리도 없다. → AD-9에 레코드 필드와 "손상 라인은 건너뛰고 실패 기록에 남긴다" 추가.
4. **설정 파일 스키마가 없다.** AD-18이 위치만 정한다. `config.toml`의 키 이름·기본값·필수 여부 표가 없으면 설치기 story와 로더 story가 다른 키를 쓴다. → AD-18에 키 표(미러 경로, 시간대, 임베딩 on/off·모델·차원, DATABASE_URL 환경 변수 이름, 내보내기 경로) 추가.
5. **버전 확인이 안 된 기술이 있다.** memlog `version`(2026-10-08)에 `@clack/prompts 1.8.1`, `tsdown 0.23.0`이 없고, 재순위 모델명 `qwen3-rerank`는 2026-10-02 항목에서 "`qwen3.7-text-rerank`는 국제 리전에 없음"만 확인됐다(현재 사용 가능한 정확한 모델 id 확인 흔적 없음). Docker 태그 `pgvector/pgvector:pg18`도 결정 항목에만 있다. → 세 건을 확인해 `version` 항목을 추가하거나 Stack에서 "seed, 구현 시 확인"으로 낮춘다.
6. **Deferred의 "하이브리드 결합 방식·HNSW 파라미터"가 AD-15의 slice 1 경로와 충돌.** AD-15는 임베딩을 켜는 경로를 slice 1에 포함하고 "HNSW를 처음부터 건다"고 하는데, 파라미터와 결합 방식은 Deferred다. 즉 켠 사용자의 결과와 마이그레이션 내용이 단위마다 갈린다. → AD-15에 기본값을 박고(`m=16, ef_construction=64`, 결합은 "임베딩 켜짐이면 벡터 top-30 → 재순위 → top-5, 키워드와 섞지 않는다"), Deferred는 "기본값 재조정"으로 문구를 바꾼다.
7. **관측(로그)이 실패 기록 외엔 없다.** hook 경로는 항상 exit 0이고 stderr은 사라진다. 어디에 어떤 수준으로 운영 로그를 쓰는지(`~/.second_brain/logs/`? 회전? `--verbose`/`BRAIN_DEBUG`?)가 없어 디버깅 경로가 없다. → Conventions에 로그 위치·수준·회전 한 줄.
8. **테스트·개발 환경 분리가 없다.** Conventions는 "실제 Postgres(Docker)로 통합 테스트"를 요구하는데, 테스트가 실사용 `DATABASE_URL`을 집지 않게 하는 장치가 없다(별도 env 이름, 또는 DB 이름 접두사 강제). → Conventions에 "테스트는 `BRAIN_TEST_DATABASE_URL`만 쓰고, 그 값이 설정 파일의 DB와 같으면 테스트가 실패한다" 추가.
9. **Stack 표가 seed와 계약을 구분하지 않는다.** memlog는 "Kysely는 seed(교체 시 adapter 하나만 재작성), 규칙 아님"을 명시했는데 Stack에서는 PostgreSQL 18·pgvector(계약)와 Kysely·commander·clack(한 패키지 내부 선택)이 같은 표에 섞여 있다. story 에이전트가 전부 고정 계약으로 읽는다. → Stack에 "계약 / seed" 열을 추가.

## Low (6건)

1. `[ADOPTED]` 표기가 AD-1 헤더와 AD-12 첫 불릿에만 붙어 일관성이 없다. 전부 붙이거나 전부 떼고 memlog에만 남긴다.
2. `binds: all`(AD-1, AD-3)은 역추적을 흐린다. 대표 FR 몇 개 + "all"로 적거나 "전 FR의 전제"로 문구를 통일.
3. Deferred의 "데몬·파일 watcher" 행이 미래 구현 방식("CLI는 소켓이 있으면 위임")까지 서술한다 — 연기 사유만 남기고 방식은 떼는 편이 spine 성격에 맞다.
4. 사람용 텍스트 출력 형식이 전혀 없다(`--json`만 계약). 사람용은 "자유"임을 한 줄로 명시해 story가 고민하지 않게 한다.
5. 데이터 증가 관리가 미언급(수백 세션·수백만 자 규모 확인됨). 정리·VACUUM·보존은 "하지 않음"이라도 명시.
6. `engines`(Node 24)와 전역 설치 경로 전제가 Stack에만 있고 AD-19의 환경 확인 항목에 연결되지 않았다.

## 양호한 점 (유지할 것)

- AD-11의 "원문 불변을 DB trigger가 강제" — 규율이 아니라 기계가 막는 드문 사례. AD-1의 "경계는 lint가 아니라 패키지 의존성" 도 같은 성격.
- AD-4의 connector 계약(필수=parser 하나, hook·env는 선택 + 대체 경로 표) — Harness 중립을 말이 아니라 표로 고정했다.
- AD-7의 "재시도 주체는 drain 하나" + SKIP LOCKED 전제 — 데몬 없는 구조에서 가장 갈라지기 쉬운 지점을 한 곳으로 모았다.
- AD-9/AD-10의 "원본은 하나, 나머지는 파생물·대기열" 위계가 AD-16·NFR-9까지 일관.
- mermaid 4개 모두 문법 유효(flowchart 2, sequenceDiagram 1, erDiagram 1). `--)` 비동기 화살표, `[( )]` DB 노드, 자기 참조 관계 모두 정상.
- 문서가 짧고 Rule이 명령형이다. 이유는 Prevents 한 줄로 묶어 rationale 창궐이 없다.
