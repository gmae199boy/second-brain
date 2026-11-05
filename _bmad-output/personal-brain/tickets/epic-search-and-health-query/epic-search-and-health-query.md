---
type: epic
title: "텍스트·원문·건강 수치 조회"
parent: personal-brain
covers: [R14, R15, R16, CAP-4, CAP-6, CAP-7]
sources: [_bmad-output/personal-brain/initiative-personal-brain.md, _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md]
companions: [_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, _bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query-research-code.md, _bmad-output/personal-brain/inputs/rag-oss-patterns.md, _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md]
after: []
refined: true
risk: medium
---

# 텍스트·원문·건강 수치 조회

## Description

에이전트가 부르는 공통 텍스트 검색과 원문 읽기를 PostgreSQL 위에 만든다.
- 대화 조각 생성(drain, CAP-4의 대화 부분)과 그 색인. epic-recall-and-mirror에서 옮겨 왔다. `index rebuild`와 작업 로그 색인은 그 에픽에 남는다.
- 검색 대상: 대화 조각·도구 메모(epic-recall-and-mirror에서 옮겨 온 CAP-6·7의 대화 부분)와 분석 리포트 파일의 문서 조각(확장이 `file_requests`로 등록한 core 파일, AD-23·30. 2026-11-05: `analyses` 관계 대신). 날짜·출처와 함께 찾고, 결과의 출처로 원문까지 내려간다. 이 에픽이 `document` 결과 종류(AD-15)를 처음 만든다.
- 결과 계약: 출처, 8,000자 상한과 잘림, `SEARCH_FAILED`와 0건의 구분. 출력은 출력 코덱으로 가린다.
- 문서 원문 출력: 리포트 파일의 문서 조각 결과와 원문 읽기(`files show`)를 이 에픽이 처음 만들고, 출력 코덱 계약 테스트의 probe에 문서 조각을 더한다. 옛 계획에서는 epic-drive E8-6이 먼저 만들 일이었다(2026-10-28 트리 검증 F3). epic-drive는 이 경로에 첨부·Drive 대상과 URL을 더해 쓴다.
- 건강 수치 질의(2026-11-05 바뀜): core는 건강 데이터를 갖지 않는다. 건강 수치는 설치된 건강 확장이 manifest로 선언한 읽기 명령(Garmin: `brain ext garmin …`, AD-37)이 계산해 돌려주고, 이 에픽은 recall 스킬과 회귀에서 그 명령을 부르고 미설치·비활성·0건·오류를 구분한다. core는 확장 schema를 읽지 않는다(AD-30).
- 꺼진 확장의 자료는 검색 응답에 상태로 드러난다(R16의 검색 부분). 상태는 epic-extensions의 registry 공개 view에서 읽는다.
- 질문 해석은 에이전트가, 실제 질의는 코드가 한다.
- 회귀 문항: 한국어 두 글자, 표현 바꾸기, 데이터 없음.
- 임베딩은 쓰지 않는다(C2).

Drive E8-6과 epic-recall-and-mirror는 이 검색 경로를 쓴다(2026-10-28, 이니셔티브 R14·R15, 사용자).

코드 조사(2026-10-28, `epic-search-and-health-query-research-code.md`)가 찾은 것은 다음과 같다.
- 대화 `Chunk` 타입과 표는 있으나 조각을 만드는 writer·drain이 없다. 검색 명령·SDK·결과 union, `files show`, `sessions read` 공개 경로도 없다. 봉투에는 count·has_more·omitted·next 칸이 있다.
- 같은 시각 범위를 가진 조각 둘이 UNIQUE `(session_id, index_config_id, from_at, to_at)`에 걸릴 수 있다(epic 4의 이월 메모). 2,400자 넘는 메시지를 나눈 조각은 모두 같은 시각 범위다.
- 지금 redact는 걸린 조각을 지우지만 다시 만드는 일감을 넣지 않는다.
- 출력 코덱의 probe는 본문과 도구 메모만 본다. 문서 조각이 없다.
- 이 worktree의 PG 어댑터는 옛 초기 설계다. 다섯 expression GIN과 공식 이미지는 epic 11이 만든다.

## Outcome

"지난달 수면이 어땠지", "그때 왜 그렇게 했지"에 에이전트가 근거 원문과 정확한 수치로 답한다(이니셔티브 Done when 8의 조회 부분).

## Requirements

- E17-1 (CAP-4; R14): 대화 조각 — 조각은 `index_configs`의 규칙(목표 1,200자, 메시지 경계, 겹침 1메시지, 2,400자 넘는 메시지 분할, 머리말 없음)대로 drain 일감이 만든다. 같은 `occurred_at`을 가진 메시지 묶음은 일반 경계 분할에서 한 단위다(2,400자 넘는 메시지의 내부 분할만 예외). 긴 메시지를 나눈 조각은 같은 시각 범위를 가지므로 키에 분할 번호 `part`를 더한다: `(session_id, index_config_id, from_at, to_at, part)`. `part`는 그 시각 범위 안에서 유일하고, 단일 조각은 0, 분할 조각은 1부터 연속이며(메시지마다 초기화하지 않음), 규칙은 Core chunker 하나가 정해 증분 생성과 redact 재생성이 공유하고 `index_configs.chunk_params`에 기록한다(spine Table Contract). 같은 원문은 같은 경계를 만들고, 새 메시지가 오면 증분으로 이어 만든다. 읽은 뒤 새 메시지나 redact가 끼면 낡은 조각을 확정하지 않는다. `messages.redact`는 같은 트랜잭션에서 걸린 조각을 지우고 그 세션의 재생성 일감을 넣는다. U+0000은 AD-11의 쓰기 코덱을 따른다. (AD-11·15)
- E17-2 (R14; CAP-6·7): 텍스트 검색 — 대화 조각, 도구 메모, 분석 리포트 파일의 문서 조각을 Core의 질의 함수 하나로 찾는다(`lower(col) LIKE lower(pattern)`, `%`·`_`·`\` 이스케이프, 한국어 두 글자 포함). 문서 대상은 확장이 리포트로 등록한 core 파일(파일 요청 metadata의 종류)의 현재 추출 세대다(이전된 분석과 새 평가 모두, 2026-11-05). 정렬은 근접 단계 다음 관련도다. 결과 계약은 AD-15 그대로다(종류별 출처, 기본 5건·총 8,000자, 낮은 순위부터 통째로 빼고 1위는 남김, `RESULT_TRUNCATED`·`meta.omitted`·`meta.next`, limit+1의 `has_more`, 0건은 `data: []`와 `meta.hint`, `SEARCH_FAILED`는 따로). 8,000자는 출력 코덱으로 가린 뒤의 길이다. (AD-15)
- E17-3 (R14): 원문 읽기 — 대화 출처(session 토큰·`from_at`·`to_at`, `chunk_id`는 선택)로 `recall expand`가 앞뒤 메시지를 `(occurred_at, 안정 id)` 순으로 읽고 겹침을 지운다. 조각이 다시 만들어져도 같은 원문 구간을 읽는다. `sessions read`가 세션 원문과 도구 메모를 쪽 단위로 읽는다. 문서 출처(`file_id`·`chunk_locator`, 추출 세대 id는 선택)로 `files show`가 현재 추출 텍스트의 그 위치와 앞뒤를 읽는다. 세대가 바뀌었으면 바뀌었다고 알리고 현재 세대에서 같은 위치를 읽는다. 가린 파일은 나오지 않고, unsupported·failed·too_large·원본 닿지 않음을 0건으로 합치지 않는다. 출력 코덱 계약의 probe가 문서 조각·표시 이름·locator를 읽는다. (AD-11·15·23·24)
- E17-4 (R15): 건강 수치 조회(2026-11-05 바뀜) — 건강 수치는 설치된 확장의 읽기 명령이 계산한다(Garmin: 21.5의 일·기간 수치 명령, AD-37). 이 에픽은 recall 스킬이 그 명령(21.5의 `period-summary`·`daily-values`, 계약의 producer는 epic 21)을 기간·지표·운동·집계 조건으로 부르고, 응답의 값·단위·관측 수·NULL·적용 기간을 근거로 답하게 하며, 독립 계산 fixture로 명령 결과(합계·평균, NULL은 0이 아님, 자정·DST 경계)를 확인한다. core 건강 조회 port·`brain health query`는 만들지 않는다.
- E17-5 (R16): 확장 상태 — 검색·수치 응답은 `data` 배열 모양을 유지하고 `meta.extensions`에 `{source, installed, enabled, searchable, work_state}`를 싣는다. 상태는 epic 13 registry의 공개 view에서만 읽는다. 미설치·비활성은 0건·`SEARCH_FAILED`·DB 연결 실패와 다른 축이고, 비활성 확장의 보존된 자료는 결과에서 빼지 않는다. (AD-29)
- E17-6 (R14): 명령과 스킬 — `brain recall chunks|tools|docs|expand`, `brain sessions read`, `brain files show`가 CommandSpec·명령 메타·SDK 1:1이고 출력 코덱을 거친다. 플러그인 스킬 `plugin/skills/recall/SKILL.md`가 질의 바꾸기 → 검색 → 출처로 원문 → 수치 조회(확장 명령) → 데이터 없음·미설치 안내를 감싸고, epic 13.7의 정적·행동 시험 방식으로 검증한다. 질문 해석은 에이전트, 실제 질의·계산은 코드다.
- E17-7 (R14; SM-7): 회귀와 실측 — 합성 fixture로 한국어 두 글자·세 글자, 공백·`a-b`·`AND`·따옴표·`%`·`_`·역슬래시, 표현 바꾸기(고정 재질의 묶음과 기대 적중 id), 데이터 없음, 출처 → 원문 복원을 검증한다. 개발 전용 PG에서 공식 이미지의 locale·provider·encoding·`pg_trgm` 버전을 기록하고 `EXPLAIN (ANALYZE, BUFFERS)`를 남긴다(spine Deferred "검색 locale·실행계획 실측"). 실제 질문 10건 중 7건 성공은 이 Mac 설치본에서 확인한다.

## Constraints

- 색인은 원문 위에 만들고 나가는 텍스트는 Core 출력 코덱을 거친다(AD-11·15). 임베딩은 쓰지 않는다(C2).
- epic 11의 다섯 expression GIN과 PG 검색 바탕을 다시 만들지 않고, epic 14의 건강 표·"현재" view를 다시 만들지 않는다. 권위를 다시 고르지 않는다.
- 범용 회귀 러너(`tooling/eval`)·작업 로그 검색·`index rebuild`는 epic 4, 첨부·Drive·파일 이름 검색은 epic 8이다.
- 공개 plan과 회귀 결과에는 본문·건강값을 쓰지 않고 식별자·질의·판정만 쓴다.

## Done when

1. 한국어 두 글자 질의와 표현 바꾸기 회귀 문항이 대화와 기존 분석을 찾고, 결과의 출처만으로 원문을 읽는다.
2. 건강 수치 질의의 합계·평균이 독립 계산과 같고, 단위·NULL·현지 날짜 규칙을 지킨다.
3. 검색 실패·0건·확장 미설치·확장 비활성이 응답에서 구분된다. 결과가 8,000자를 넘으면 규칙대로 잘리고, 비밀은 가려진다.
4. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 시간 조회·작업 로그 검색·미러·EXIF·`--count`·범용 회귀 러너(`tooling/eval`)는 epic-recall-and-mirror다. 이 에픽은 자기 회귀 문항(한국어 두 글자, 표현 바꾸기, 데이터 없음)을 테스트 fixture로 검증한다.
- 첨부·Drive 문서와 파일·폴더 이름을 검색 대상에 더하는 일은 epic-drive E8-6이다. 이 에픽은 리포트 파일의 문서 조각까지만 찾는다.
- 임베딩은 epic-embedding-index다.
- Must not change: 색인은 원문 위에 만들고, 나가는 텍스트는 Core 출력 코덱을 거친다(AD-11·15).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R14, R15, R16(검색 응답 부분)
- spec — _bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md, CAP-4, CAP-6, CAP-7(대화 부분)
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-11, AD-15, AD-23, AD-29, AD-30, AD-32
- epic — _bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md, Description(결과 계약 보강, 2026-10-15)
- research — _bmad-output/personal-brain/tickets/epic-search-and-health-query/epic-search-and-health-query-research-code.md (2026-10-28 정적 코드 조사)
- inputs — _bmad-output/personal-brain/inputs/rag-oss-patterns.md, §1.1 R1~R4·R13, §3·§4 (2026-11-02 채택 companion)
- inputs — _bmad-output/personal-brain/inputs/rag-oss-core-architecture.md, §1 검색 절, §2 결론 5·6 (2026-11-02 채택 companion)

## Notes

- Waits on epic-postgres-primary because: 한국어 텍스트 색인과 메시지·도구 메모 스키마가 PostgreSQL에 있어야 한다.
- Waits on epic-extensions because: 검색 응답의 미설치·비활성 상태를 확장 registry의 공개 상태 view에서 읽는다.
- Waits on epic-garmin-extension because: Garmin 조회 명령과 core 파일로 등록된 리포트(21.5)가 수치 조회와 검색의 대상이다(2026-11-05, epic-garmin-import 대기를 대신한다).
- Decision(2026-10-28, 트리 검증): epic-garmin-runtime을 기다리지 않는다. 수치 질의는 이전된 정규화 테이블을 읽고, 새 평가 결과는 같은 스키마에 쌓인다. 어떤 스토리가 그 에픽이 편입한 Python 계산(digest)을 쓰게 되면, 쪼갤 때 그 에픽을 `after`에 다시 선언한다.
- Decision(2026-10-28, 사용자): 대화 검색(CAP-6·7의 대화 조각·도구 메모·넓히기)을 epic-recall-and-mirror에서 가져온다. 검색을 두 번 만들지 않는다.
- Decision(2026-10-28): epic-health-analysis(18)도 기다리지 않는다. 새 평가는 epic 14가 만든 `analyses`와 리포트 파일로 쌓이므로 검색 경로가 같다. 18과는 `after` 경로가 없으니, 나란히 만들면 core 마이그레이션 번호(AD-31 실행기가 중복을 거부한다)와 출력 코덱 등록부·명령 메타에서 뒤에 합치는 쪽이 맞춘다.
- Handoff(2026-10-28, epic 14 세트 검증 F2): epic 14에서 받는 것. 수치 조회는 14.2의 계약 문서·공유 fixture(지표 catalog, 정규 단위, NULL 의미, 허용 집계, "현재" view)를 읽고, ambiguity(같은 순위의 다른 값, 계정 미확인)는 기본 집계에서 빼고 응답에 상태로 돌려준다. 리포트 파일 검색은 14.5가 만든 `analyses`의 파일 관계와 core 파일의 추출 세대를 쓴다. 쪼갤 때 이 entry들로 교차 `after`를 고정한다.
- Decision(2026-10-28, 정제, 추천으로 정함): 조각 키에 결정적인 분할 번호 `part`를 더한다(`(session_id, index_config_id, from_at, to_at, part)`, 나누지 않은 조각은 0). 2,400자 넘는 메시지를 나눈 조각은 모두 같은 시각 범위라 지금 키로는 부딪힌다. 같은 시각 메시지 묶음은 경계에서 쪼개지 않는다. 시각을 지어내지 않는다. epic 4 이월 메모("chunk writer를 만들 때 같은 시각 범위의 규칙을 정한다")를 이 결정이 닫는다. spine Table Contract의 `chunks` 키는 다음 spine 갱신 때 고친다. → 2026-10-28 반영했다(세트 검증 F1).
- Decision(2026-10-28, 정제, 추천으로 정함): 명령은 `brain recall chunks|tools|docs|expand`, `brain sessions read`, `brain files show`, `brain health query`다. 건강은 출처 중립 이름(`health`)이고 Garmin 이름공간을 만들지 않는다(AD-29). 공통 `brain recall search`는 만들지 않는다(공개 verb가 겹친다).
- Decision(2026-10-28, 정제, 추천으로 정함): 확장 상태는 `meta.extensions`에 싣는다(코드 조사 6절 후보 B). `data`를 감싸면 0건 `data: []` 계약(AD-15)과 어긋난다.
- Decision(2026-10-28, 정제, 추천으로 정함): `recall expand`는 출처의 session·시각 구간으로 메시지를 읽는다(후보 B). 조각이 다시 만들어지거나 redact 뒤 재생성돼도 같은 원문 구간을 읽고, 인접 조각 본문을 이어 붙이지 않아 겹침이 중복되지 않는다. `files show`는 `file_id`+`chunk_locator`로 현재 세대를 읽고, 출처의 세대가 바뀌었으면 그 사실을 응답에 적는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 평균의 분모는 비NULL·비ambiguity 유효 숫자 수이고, 값이 하나도 없으면 `value = null`과 개수 0이다(실제 0과 구분). 운동 평균의 분모는 catalog 허용 집계의 의미를 따르고 이 에픽이 새로 고르지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 얇은 플러그인 스킬 `recall`을 둔다. R14는 에이전트가 검색과 원문 조회를 부르는 것이고, 질의 바꾸기와 데이터 없음 안내는 스킬이 반복 가능하게 한다. 계산·날짜 해석을 스킬에 숨기지 않는다.
- Decision(2026-10-28, 정제, 추천으로 정함): 실제 질문 10건 중 7건(spine AD-15)은 이 Mac 설치본에서 에이전트가 이 Mac의 실제 기억으로 질문 10개를 만들어 확인한다. 판정 기준(기대한 세션·분석이 결과 5건 안에 있고 출처만으로 원문이 읽힘)을 먼저 고정하고, 결과는 공개용 식별자와 성공 여부만 남긴다(실제 질문 원문은 private, 세트 검증 F3). 다시 판정하고 싶으면 사람 몫 목록에 있다.
- Decision(2026-10-28, 스토리 계획): tracer는 1이다. epic 14의 합성 `analyses` 리포트 파일 하나를 한국어 두 글자로 `brain recall docs`가 찾고, 그 `document` 출처만으로 `brain files show`가 원문을 읽으며, 비밀이 가려진다. 문서 probe도 1이 더한다. 다음은 가장 덜 확실한 2(대화 조각: 같은 시각·긴 메시지·redact 재생성)다. 그다음 3(대화·도구 메모 검색과 넓히기·결과 계약), 4(건강 수치 조회), 5(확장 상태·스킬·회귀·실측), 6(Refactor sweep), 7(이 Mac 확인)이다. 코드 조사의 순서안 A를 따르되 T6을 sweep과 이 Mac 확인으로 나눴다.
- Decision(2026-10-28, 스토리 계획): Store port·PG adapter·`brain.ts`·출력 코덱·명령 등록부를 모든 스토리가 함께 고친다(코드 조사 8절). 그래서 1~7은 한 줄이다. epic 18과는 데이터 의존이 없어 `after`로 잇지 않는다(이 에픽 Notes의 기존 Decision). 만드는 순서상 18이 먼저 끝나므로 1은 18 뒤의 다음 core 마이그레이션 번호와 조립을 HEAD에서 확인한다. epic 11·13·14 쪽 entry에는 인계 문장을 더하지 않고 받는 쪽이 적는다(앞 에픽들과 같은 명시적 예외).
- Decision(2026-10-28, 추천으로 정함): 모든 entry가 `hitl = false`다. 7의 이 Mac 확인과 실제 질문 10건은 에이전트가 하고 증거를 plan에 남긴다. 원격 push가 있어야만 하는 단계는 `operator_actions`다.
- Decision(2026-10-28, 추천으로 정함): risk와 그 이유.
  - 1 medium: 문서 출처·원문 경로가 처음 생긴다. 추출 바탕은 이미 있다.
  - 2 high: 조각이 틀리면 대화 검색 전체가 틀리거나 가린 문자열이 남는다.
  - 3 medium: 결과 계약이 틀리면 에이전트가 원문으로 못 내려간다.
  - 4 high: 합계·평균이 틀리면 "지난달 수면" 같은 답이 틀린다.
  - 5 medium: 상태가 섞이면 "기록 없음"으로 잘못 읽힌다.
  - 6 low: 정리다.
  - 7 medium: 설치본에서만 드러나는 locale·경로 문제를 놓친다.
- Decision(2026-10-28, 세트 검증 F2): high entry의 추가 확인(verify와 별도, leaf를 만들 때 이어받는다).
  - 2: 재생성 일감 넣기를 실패시키면 redact의 본문 치환·조각 삭제까지 모두 롤백되고 spool하지 않는다.
  - 4: 독립 정수·유리수 계산으로 여러 달 묶음과 비NULL 분모를 따로 대조한다.
- Decision(2026-10-28, 세트 검증 F3): 실제 질문 원문, 독립 계산의 원시 행, 실제 명령 출력, 오류 상세는 Brain 홈의 private 검증 기록에만 둔다. 공개 plan에는 문항 id, 중립 질문 유형, 공개용 불투명 id, 성공 여부, 값 없는 실패 분류만 둔다. 식별자가 개인 경로·제목이면 공개용 id로 바꾼다. 합성 회귀의 질의와 EXPLAIN만 공개한다.
- Decision(2026-10-28, 세트 검증 F4): 6(Refactor sweep)은 코드 스토리 1~5의 정리를 닫는다. 7의 배포·설치본 확인은 그 뒤 따로 둔다(앞 에픽들과 같은 예외). 7에서 찾은 모든 기능 문제는 버그 스토리로 고치고 다시 확인하며, 6으로 밀어 넣지 않는다. 7의 verify 전에는 설치본 완료로 세지 않는다.
- Decision(2026-10-28, 세트 검증 S1·S2·S3 채택): 각 plan은 PG 연결 두 개의 역할, 막는 잠금(격리 시험의 ACCESS EXCLUSIVE 등), timeout 값, 잠금 해제·정리 명령을 적는다. 2는 snapshot 읽기 barrier 뒤 새 메시지와 redact를 따로 끼우고, 3은 1위 단독 초과·`meta.omitted`·`sessions read` 쪽 이동·가린 뒤 코드 포인트 길이를, 1은 세대 교체·가린 파일·실패 상태의 원문 읽기를 시험 행렬에 넣는다. 5는 기본 suite와 별도 행동 시험 명령을 적는다. 1은 격리 PG·홈·리포트 한 건·정리·문서 probe만 완성하고, 대화 fixture는 2, 도구 메모는 3, 건강 fixture는 4가 같은 기반에 더한다. 7은 실행 전에 문항·기대 결과·허용 재질의·문항별 성공 조건을 함께 고정하고, 최초 판정과 수정 뒤 재실행을 구별한다.
- Decision(2026-10-30, 사용자): 에픽마다 두던 Refactor sweep(17.6)을 뺐다(`dropped`). 리뷰가 미룬 기존 결함은 `deferred-work.md` 장부에 남고, 사용자가 원할 때 `bmad-loop sweep`으로 직접 처리한다. 이 Mac 확인(17.7)은 sweep 대신 sweep이 기다리던 스토리들을 기다린다.
- Decision(2026-10-30, 추천으로 정함): 기존 문서 우선 tracer 순서를 대체한다. 17.2가 공통 질의 함수·최소 검색 port·PG adapter·대화 시험 기반과 조각 생성을 맡아 11.5 뒤 시작하고, 17.3이 대화 검색·원문·공통 budget을 완성한다. 17.1은 17.3·14.5·11.4 뒤 문서 결과·files show·문서 probe·리포트 fixture를 더한다. 17.4는 17.3·14.2 뒤 독립 진행하고 17.5가 17.1·17.4·13.6·13.7을 모은다. 범위·기존 verify는 유지하고 17.2에 질의 port 판정 검증을 더한다. 모든 번호·시그니처는 18 완료 가정 없이 착수 시점 main HEAD에서 확인한다.
- Note(2026-11-02, refine 입력): `../../inputs/rag-oss-patterns.md` §1.1 R1~R4·R13 — `queries[]` 다중 질의와 조각 해시 중복 제거(17.3), 구→AND→OR 단계 완화와 `meta.hint`(17.3), 일치 주변 `snippet` 칸(17.3 결과 계약), 인접 조각 합치기(17.3), 스킬 안내문의 질의 바꾸기 지침(17.6). 저장·검색 구조 비교는 `../../inputs/rag-oss-core-architecture.md`. 17.3·17.6 착수 전 채택 여부를 정한다. 토크나이저·재순위·질의 재작성은 가져오지 않는다(§3). 검증(2026-11-02, Sofia): R1(`queries[]`)·R3(`snippet` 칸)·R13(인접 조각 합치기)은 AD-15 결과 계약(E17-2)을 바꾸므로 채택 시 `bmad-architecture`로 spine을 함께 갱신한다. R2는 질의 함수 하나(E17-2) 안의 단계라 계약 변경이 아니고 `meta.hint` 값만 는다. R4는 스킬 안내문이라 계약과 무관하다. 추가(2026-11-03): R15(원문 읽기 응답에 전체 조각 수와 `neighbors` 창)는 E17-3 응답 모양이라 17.3에서 함께 정한다. R4 안내문에 Onyx 키워드 재작성 규칙 세 줄을 더했다.
- Decision(2026-11-05, 사용자, Garmin 확장 재설계): core 건강 계약·`analyses`가 없어진다(spine AD-30·32·35·37, epic 21). E17-4는 core 조회 port 대신 확장 읽기 명령을 쓰고, E17-2·E17-6의 리포트 대상과 `brain health query`를 바꾼다. 17.1·17.4·17.7의 after를 21.5·21.7로 옮긴다. 이미 끝난 17.2·17.3은 그대로다.
