# epic 4 조회와 미러 — PostgreSQL·앞 에픽 위의 정적 코드 조사

2026-10-28. 정적 조사만 했으며 테스트·빌드·Docker·설치·패키지 추가·커밋은 하지 않았다. 이 문서의 후보는 결정이 아니다. 이미 기록된 사용자 Decision과 추천 결정은 입력으로 유지한다. 같은 worktree에서 다른 작업자가 수정 중인 계획 파일은 읽기만 했다.

근거 약어(이하 `A:행`처럼 적는다):

| 약어 | 저장소 상대 경로 |
|---|---|
| E4 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/epic-recall-and-mirror.md` |
| T4 | `_bmad-output/personal-brain/tickets/epic-recall-and-mirror/tickets/tickets.toml` |
| I | `_bmad-output/personal-brain/initiative-personal-brain.md` |
| S | `_bmad-output/personal-brain/spec-brain-v1-slice-1/spec-brain-v1-slice-1.md` |
| P | `_bmad-output/personal-brain/prd-brain-v1-slice-1/prd-brain-v1-slice-1.md` |
| PA | `_bmad-output/personal-brain/prd-brain-v1-slice-1/addendum.md` |
| A | `_bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md` |
| T17 | `_bmad-output/personal-brain/tickets/epic-search-and-health-query/tickets/tickets.toml` |
| E3 | `_bmad-output/personal-brain/tickets/epic-log-and-context/epic-log-and-context.md` |
| E8 | `_bmad-output/personal-brain/tickets/epic-drive/epic-drive.md` |
| E10 | `_bmad-output/personal-brain/tickets/epic-attachments/epic-attachments.md` |
| T11 | `_bmad-output/personal-brain/tickets/epic-postgres-primary/tickets/tickets.toml` |

## 1. 실제 남는 일과 PostgreSQL 경계

이 에픽은 V1 뒤다. 남는 것은 시간 조회·작업 로그 대분류 검색·미러·EXIF·`--count`·범용 회귀 러너·전체 `index rebuild`다. Requirements는 E4-1(EXIF)만 있으므로 Done when과 Notes를 Requirements로 옮겨 채울 입력이 필요하다. V1 뒤 에픽의 전체 gate는 유지한다. 따라서 V1 무인 분할의 전체 gate 제거 결정을 이 에픽까지 확대하지 않는다(E4:30, E4:34, E4:75, E4:76, E4:78; I:141, I:187).

| 범위 | 앞 에픽에서 받는 것 | epic 4에 남는 것 |
|---|---|---|
| CAP-4 | 17.2 chunker·증분 writer·`part` 키·redact 뒤 조각 재생성 | 새 설정으로 전체 다시 만들기·미색인 표시·doctor·지연 측정(S:31; T17:20; E4:43) |
| CAP-5 | 11의 DB 시간대, 3의 로그 | `recall time`, `sessions list`, 로그 없는 세션 표시·기간 함수 소비(S:34; A:257, A:268) |
| CAP-6 | 17의 질의 함수·대화/도구 검색, 8의 문서·이름 검색, 3의 로그 쓰기/관리 | `recall logs`의 text 검색·꼬리표·근접 정렬. 로그 쓰기/수정은 가져오지 않음(S:38; E3:28, E3:30; E8:100) |
| CAP-7 | 17.3 `expand`·`sessions read`·공통 budget, 8의 source 이름 전용 결과 | log 출처 union(`log_entry_id`, session, 그 줄 시각)을 붙여 기존 원문 읽기로 연결. 로그 id를 expand가 받는 adapter가 필요하면 4에서 추가(A:287; T17:32) |
| CAP-13 | 공통 queue와 출력 코덱 | 미러의 전 경로(S:58; A:297) |
| CAP-14 | 10.8 추출 registry, 8의 문서 찾기·Carry | 이미지 metadata·촬영 일시 필터·과거 이미지 재큐잉(E4:34, E4:82; E8:105, E8:114) |

**계획과 현재 구현을 구분해야 한다.** T17은 커밋된 계획이지 이 worktree의 구현 완료 증거가 아니다. 현재 `Brain`에는 recall·mirror·index가 없고 files는 redact뿐이다. CLI registry에도 recall/time/logs·sessions list/read·mirror/index rebuild가 없다. PG adapter는 `HealthStore & SchemaStore`만 구현한다. 따라서 앞 에픽의 새 파일 이름을 현재 존재하는 코드처럼 인용하거나 SQLite 구현에 바로 새 기능을 얹는 계획은 피한다(`packages/core/src/brain.ts:197`, :212; `apps/cli/src/commands/index.ts:36`; `packages/postgres/src/store.ts:44`, :49).

Description의 SQLite 전제는 **어긋남**이다. E4:15의 FTS5 trigram/구절 감싸기는 Core 질의 함수 → `lower(col) LIKE lower(pattern)`으로, E4:22의 3자 미만 전용 fallback은 모든 길이에 같은 escaped LIKE를 적용하는 규칙으로 바꿀 곳이다. `%`·`_`·역슬래시는 문자 그대로다. 인덱스는 같은 정규화·collation의 `lower(col)` expression GIN이고, trigram이 없는 질의의 전수 검색 비용을 허용한다. `EXPLAIN QUERY PLAN` 강제 인덱스 회귀 대신 PG의 `EXPLAIN (ANALYZE, BUFFERS)`로 locale·선택도·지연을 기록하되 특정 plan을 강제하지 않는다. 이 관찰 기반은 17.5가 먼저 만든다(E4:79; A:278, A:279, A:788; T17:56).

현재 PG baseline의 chunks는 아직 seq 키이고 GIN도 원래 열 대상 세 개다. 최신 spine의 시각+part 키와 다섯 lower expression GIN에 **어긋남**이 있다. 이것은 11.2와 17.2의 선행 변경 범위이며 4에서 baseline을 독자 수정할 이유가 아니다(`packages/postgres/migrations/0001_initial.sql:137`, :144, :216; T11:32; T17:20; A:563).

## 2. 시간 조회(CAP-5)와 sessions list

`brain recall time`은 날짜 범위의 작업 로그와 세션을 기본적으로 프로젝트 무관 시간순으로 돌려주며 빈 기간은 `ok`의 빈 배열이다. 명시한 워크트리·프로젝트로 좁히는 옵션은 허용하고 LLM·임베딩 호출은 하지 않는다(P:202, P:205). “어제·지난주”를 해석하는 주체는 에이전트다. Brain에 자연어 날짜 parser를 넣지 않는다. 날짜 flag를 받는 경우 `(날짜, DB 설정 timezone)`에서 반열린 UTC `[from,to)`를 만드는 Core 함수 하나를 쓰고 `meta`에 구간을 되울린다. PG에는 timestamptz, Store 밖에는 밀리초 UTC 정규형이다(E4:38; S:35, S:36; A:256, A:257, A:259).

로그가 없는 세션은 `occurred_at`이 가장 이른 user 메시지의 첫 요청 문장을 읽을 때 꺼낸다. 새 summary/log 행으로 저장하지 않는다(D7). 동시각 user 메시지는 안정 id로 표시 순서를 고를 수 있지만 대화상 선후가 밝혀졌다고 주장해서는 안 된다. 현재 port는 `readSession`과 메시지 정렬 계약이 있으나 전체 세션 기간 목록 능력은 아직 추가할 자리다. `sessions list`는 세션 목록(기간·꼬리표·쪽 나눔)이고 `recall time`은 로그/첫 요청을 시간축으로 보여주는 용도로 구분하는 후보다(A:268; E4:66; `packages/core/src/ports/store.ts:183`, :350, :355; T17:32).

현재 `instant.ts`는 절대 시각 정규형만 검사하고 현지 날짜 범위·월 버킷 함수는 아니다. 17.4의 건강 조회는 DST 23/25시간 날짜 경계를 먼저 다루며, 3의 stats도 같은 AD-13을 소비한다. 그 완료 HEAD의 공용 함수를 먼저 확인하고 없는 능력만 보태야 한다. 고정 24시간 더하기로 날짜 경계를 만들면 안 된다(`packages/core/src/instant.ts:33`, :58; T17:44, T17:45; A:257). 시험 후보는 자정 직전/정각, 월·연도 경계, DST, 서로 다른 프로젝트, 로그 있음/없음, user 없음, 동일 시각 메시지, 0건과 DB 실패 구분이다(E4:38; A:268, A:290).

## 3. 작업 로그 대분류 검색(CAP-6)

3이 만드는 `log.append/list/edit/set-state`와 `recall logs`를 구별한다. 전자는 기록·관리, 후자는 내용·기간·꼬리표로 관련 작업을 찾는 길이다. 로그는 hook/수집이 자동으로 만들지 않으며 그 줄의 `occurred_at`으로 대화와 연결한다. 저장된 메시지 링크나 로그용 chunk를 새로 만들 필요가 없다(E3:28, E3:30; A:266, A:267).

종류(결정만·선호만 등) 필터와 날짜 범위도 제공한다(P:211, P:213). 검색 Store의 logs branch에 `log_entries.text`를 더하고 17.1의 질의 함수, 17.3의 근접 단계·관련도·가린 뒤 budget·0건/실패 계약을 재사용하는 후보다. `log` 결과는 `log_entry_id`와 session/harness/꼬리표·날짜·from_at=to_at=로그 시각을 내고, 17의 expand/session read가 그 시각 앞뒤 원문으로 내려가게 한다. GIN 생성은 11 소유이므로 logs API가 새 전문 검색 엔진을 만들지 않는다(T11:32; T17:8, T17:32; A:278, A:287, A:288).

대분류 먼저가 더 낫다는 결론은 아직 없다. PRD §8-5는 로그→조각과 조각 직접 검색을 같은 채점표로 비교하라고 한다. 에이전트가 적은 실제 로그가 없는 기준선으로 우열을 정하지 않는다. 범용 러너에는 같은 문항에 logs/chunks 두 verb의 고정 질의를 넣는 선택지가 있고, 질의 바꾸기까지 포함한 답변 품질은 사람 SM-3에 남긴다(P:193, P:195, P:437; PA:158; E4:69). 17 recall 스킬에 logs/time 안내를 덧붙이는 작업도 후보지만 “항상 logs 먼저”를 규율로 확정하는 것은 이번 조사 범위 밖이다(T17:56; E4:69).

## 4. 미러(CAP-13, AD-16)

기본 경로는 `~/.second_brain/mirror/`, 세션당 하나이며 파일명은 `YYYY-MM-DD_<harness>_<project>_<session 토큰 뒤 12자>.md`다. project의 제어문자와 `<>:"/\\|?*`는 `_`로 정제한다. 현 config는 `mirror.path`를 읽고 기본값을 계산하지만 폴더 생성·renderer·worker는 아직 없다. 설정 경로를 새로 발명하기 전에 11 이후 config 계약을 받는다(A:297, A:299; `apps/cli/src/config/codec.ts:34`, :74, :93, :210).

T9의 ` (2)` 충돌 접미사는 생성 순서에 따라 달라지면 재생성 동등성을 깨뜨린다. 후보 A는 전체 DB의 정제된 경로를 대소문자 접기 기준으로 묶고 세션의 안정 정체성 순으로 순번을 정해 첫 파일/` (2)` 등을 배정하는 것, 후보 B는 충돌 배정표를 파생 상태로 유지하되 전체 rebuild가 같은 순서로 복원하는 것이다. DB에 없는 임의 파일이나 디렉터리 열거 순서를 순번의 진실 출처로 삼지 않는다. 토큰 뒤 12자까지 충돌할 수 있는 fixture와 Mac의 대소문자 비구분 폴더에서 검증이 필요하다. 이름 날짜의 timezone, 긴 project명 길이, 프로젝트 정체성 갱신 때 옛 경로 삭제는 아직 명세할 선택지다(E4:22, E4:67; A:297; S:60).

내용은 DB 상태+비밀 패턴 버전의 순수 함수다. frontmatter에 패턴 버전을 넣고 메시지·도구 메모를 안정 순서로 렌더링한다. `sessionForOutput`으로 tool target 전용 가리기를 먼저 하고 최종 본문 가리기를 적용한다. renderer를 `OUTPUT_CODECS`에 등록하고 probe가 실제 renderer를 지나게 한다. 현재 코덱 등록부는 미래 미러 등록 책임을 명시하며 `OutputProbe`는 text/toolNotes다. 17이 문서 probe를 넓혀도 별도 가리기 함수를 만들 이유는 없다(E4:68, E4:73; A:221, A:224; `packages/core/src/output/codecs.ts:15`, :41, :72; `packages/core/src/output/mask.ts:157`).

읽기 snapshot으로 내용을 만들고 DB 쓰기 잠금 밖에서 임시 파일→rename 전체 교체한다. 증분과 `mirror rebuild`는 같은 함수, 같은 세션 미러 일감으로 직렬화한다. 기존 work_items 미완료 키와 claim/CAS를 재사용하되 12의 키별 직렬화·임대 갱신 계약을 받는다. 단순히 한 열린 행만 보장하는 것으로 만료된 옛 worker의 뒤늦은 rename까지 막았다고 볼 수 없다. snapshot 뒤 ingest/redact가 들어온 경우 새 요청을 잃지 않게 generation/fingerprint 검사 및 재실행 표시가 필요하다(A:298, A:358, A:580; `packages/core/src/domain/work-item.ts:62`; T17:20).

redact의 본문 치환·기록·조각 삭제와 **미러 재생성 일감 생성**은 한 transaction이어야 하며 실패하면 전체 rollback한다. 17은 조각 쪽을, 4는 미러 쪽을 붙인다. 현재 SQLite redact는 조각 삭제까지만 하고 재생성 일감을 만들지 않는다. PG 이관 11.5·17.2 뒤의 transaction을 확장하는 자리다. 또 “가린 즉시” 미러에서 사라진다는 AD-11과 비동기 재생성 사이의 완료 시점은 시험으로 명시해야 한다. 일감만 넣고 옛 미러가 남은 채 성공을 완료 처리하면 **어긋남**이다(A:228, A:229; E4:19; T17:20; `packages/sqlite/src/sessions.ts:141`, :164, :175).

패턴 버전 상승은 모든 세션의 미러 재생성 일감을 멱등 생성한다. 새 버전을 파일에 쓰는 것만으로 끝내지 않고 예전 파일 전수 발견·실패/재개·중복 rebuild·삭제 후 동등성을 시험한다. Brain은 미러를 역수집하지 않고 그 폴더가 동기화 폴더인지 모른다. 동기화 서비스가 이미 복사한 옛 내용이나 외부 편집의 역반영까지 약속하지 않는다. 경로 선택의 의미를 설정 안내에 드러내는 후보이며 sync 공급자 연동은 추가하지 않는다(E4:42, E4:68; A:224, A:298, A:299).

## 5. index rebuild·UNINDEXED·doctor·SM-7

`index rebuild`는 PG `REINDEX`나 문서 바이트 재추출 명령과 다르다. 17의 chunker/writer를 새 `index_config_id`로 전 세션에 다시 적용하는 SDK·CLI 경로다. `index_configs`는 불변이고 설정의 복합키가 유일하므로 동일 규칙 재실행 시 설정 find-or-create와 조각 일감 멱등성을 함께 설계한다. 새 규칙 버전은 chunk_params에 기록하며 메시지·로그·출처를 수정하지 않는다. 문서 추출 세대·document_chunks는 내보내기에 포함되는 보존 대상이므로 대화 색인 초기화에 섞어 지우면 안 된다(A:563, A:565, A:577; `packages/core/src/domain/index-config.ts:9`, :32; E4:43).

같은 시각 범위의 긴 메시지 조각은 17의 `part` 키를 그대로 쓴다. 별도 전체 chunker를 만들면 증분/redact/rebuild에서 출처 경계가 달라진다. 선택지는 새 설정 세대 완성 뒤 활성 포인터 전환 또는 명시적인 일괄 비우기/재생성이다. 전자는 두 설정 혼합 방지·진행 상태와 실패 재개를, 후자는 중간 `UNINDEXED` 표시·중단 복구를 반드시 갖춘다. 임베딩 테이블 교체 규칙을 대화 조각의 현재 구현처럼 단정하지 않는다. 임베딩은 이번 파이프라인에서 제외돼 있다(T17:20; A:275, A:285, A:563; I:194).

doctor에는 활성/요청 설정·불일치·미색인 세션·실패 색인 단계와 재시도 행동이 필요하다. 현재 PG doctor source는 vector 탐침만 제공하여 최신 pg_trgm/설정 점검과 **어긋남**이고 11에서 먼저 교체된다. 일반 0건과 아직 조각이 없는 세션의 `UNINDEXED`는 구별해야 한다(E4:43; A:284, A:290; `packages/postgres/src/store.ts:62`, :88; T11:104). 선택지로 rebuild 작업 id·설정 id·완료/실패 수를 결과에 내면 중단 재개 관찰이 쉬우나 결과 모양은 아직 결정하지 않는다.

SM-7은 내부와 프로세스 시작 포함 시간을 따로, 중앙값으로 잰다. 시간 조회 내부 0.1초/전체 0.5초, 내용 조회 전체 3초는 첫 구현 실측으로 확정할 여유 목표다. 데이터 수·설정 id·질의/필터·PG 이미지/locale·warm/cold 조건·샘플 수를 기록하는 후보이며 이 조사에서는 수치를 만들지 않았다. locale/plan 근거는 17.5와 Deferred의 같은 기록을 재사용한다(P:423; S:95; T17:56; A:788).

## 6. --count(chunks·logs·docs)

같은 질의·꼬리표·기간 필터를 목록 쿼리와 공유하고 limit 이전의 모집단을 센다. chunks/logs는 `{sessions, rows, by_month}`, docs는 `{files, rows, by_month}`다. `meta.count=1`, `has_more=false`, 잘림 경고 없음이며 집계는 8,000자 결과 budget 밖이다. 17의 일반 결과 계약 함수로 집계를 잘라서는 안 된다. 다만 공통 envelope 가리기·오류 계약은 계속 쓴다(E4:24, E4:45, E4:70; A:289; `packages/core/src/envelope.ts:15`, :69).

기간과 월 경계는 2절의 AD-13 함수 하나로 만들고 실제 쓴 UTC 구간·설정 timezone을 meta에 되울린다. `by_month`는 기간 안의 달만이다. 빈 달 0 버킷을 명시할지 희소 버킷으로 낼지와 부분 월 경계의 표기를 leaf에서 고정할 선택지가 있다. 무기간 조회의 기본 범위도 제한 없이 모든 달을 채우는 구현 전에 정의해야 한다(A:257, A:289; E4:70).

문서 본문/이름이 동시에 맞거나 Drive source 여러 개가 같은 content를 가리키면 `files`와 `rows`의 단위가 달라진다. 이름 전용은 file_id가 없으므로 files distinct에 source_file_id를 어떻게 포함할지, rows는 조각 수인지 합쳐진 결과 행 수인지 아직 고정할 필요가 있다. 없는 file_id를 만들지 않는 기존 Decision은 유지한다. 같은 조건의 전수 결과와 집계 일치, 여러 로그가 붙은 한 세션, 두 part, 월 경계, 0건, 이름+본문 중복, source-only 사진, 가린 파일 제외를 시험할 후보가 된다(A:287, A:289; E8:100; T17:20).

## 7. tooling/eval 범용 검색 회귀 러너

범용 러너는 epic 4다. 17은 자기 질의·표현 바꾸기·출처 원문 fixture를 테스트로 검증한다. spine Structural Seed도 현재 그 경계로 고쳐져 있다. 저장소에는 SDK 읽기 전용 runner와 중립 fixture만 두고 실제 문항은 `~/.second_brain/eval/questions.toml`, 날짜별 결과는 `~/.second_brain/eval/results/`에 둔다(E4:24; I:183; A:693; T17:56). 현재 tooling에는 bootstrap/test-db/dev만 있고 eval 패키지는 아직 없으며 새 workspace consumer 후보이다(`tooling/test-db/package.json:1`; `tooling/bootstrap/package.json:1`; A:693).

문항 형식은 미결이며 후보는 TOML `[[question]]`의 안정 id·verb(`chunks|logs|docs`)·query·expect(기대 session/file/log 식별자 목록)·k다. fixture schema 검증, k 양의 정수, 잘못된 verb/expect 중복·빈 문항 거부, 같은 query를 다른 verb로 비교하는 case를 갖출 수 있다. 기간/꼬리표 입력을 어디 둘지, expect가 여러 개인 경우 any-hit인지 recall@k인지도 명시해야 한다. 일반 hit@k 후보는 기대 집합 중 하나라도 상위 k 안에 있으면 1, 아니면 0이며 전체 평균이다. 이것을 모든 기대 문서 회수율과 혼동하지 않는다(E4:69; E4:24).

결과 파일은 식별자·질의·점수만이고 본문/발췌/원시 envelope/오류 상세는 쓰지 않는다. 검색 실패는 적중 0과 구별해 실행 실패로 처리하는 후보이며 그 실패를 본문과 함께 자동 저장하는 debug log도 막아야 한다. 랭킹/조각/rebuild 변경 전후 같은 문항으로 점수 차이를 확인한다(E4:39, E4:70; A:289, A:290). 17의 중립 fixture를 가져와 최소 적중·출처 회귀를 runner 자체 시험으로 재사용할 수 있지만 실제 private 질문을 저장소로 복사하지 않는다(T17:56, T17:79).

SM-3은 질의 바꾸기와 답변을 포함해 **사람이 채점**한다. 기존 10문항과 집계·변화·모순·시점 각 2문항은 실사용 자료로 만들며, hit@k 결과로 그 점수를 대체하지 않는다. 대분류 먼저/조각 직접 고정 질의 비교는 runner가, 그 전략의 답변 품질 판단은 같은 SM-3 채점표가 맡는 경계다(PA:149, PA:153, PA:158; P:417, P:437).

## 8. EXIF·촬영 일시·entry 1

entry 1은 10.9에서 옮겨 온 영구 id다. 요구는 촬영 일시 세 칸, 불신 입력의 크기 상한·파싱 오류 영구 분류, 가린 파일 제외, 라이브러리 버전의 extractor_version 반영이다. registry는 내용 bytes로 detect하며 text fallback 앞에 새 형식을 등록한다. 현재 등록은 text 하나/doc/1이고 추출 결과는 pieces만 반환하므로 메타데이터만 있는 이미지 성공을 표현하고 저장할 능력도 추가해야 한다(T4:1, T4:4, T4:7; `packages/core/src/files/extractors.ts:12`, :18, :31, :85, :99).

현재 성공 result를 억지로 이미지 본문 조각으로 만들 필요는 없다. 후보 A는 DocumentExtractResult에 metadata를 추가해 빈 pieces의 이미지 성공을 저장하는 것, 후보 B는 같은 registry/일감에서 이미지 metadata port로 분기하는 것이다. metadata 저장·세대 완료·redacted 재검사를 같은 publish transaction에 넣어, bytes 읽기 뒤 가리기가 들어와도 메타데이터가 부활하지 않게 한다. worker의 초기 가드만으로 충분하지 않다(`packages/core/src/files/extract-work.ts:280`, :422, :432; A:392, A:579; `packages/sqlite/migrations/0008_attachment_rules.sql:72`).

`captured_at_local`은 원문, `captured_at`은 시간대가 확인됐을 때만 UTC 정규형, `captured_at_source`는 출처다. GPS/기계 현재 시간대/DB timezone으로 offset 없는 촬영 시각을 추정하지 않는다. 어떤 EXIF 태그를 우선할지(DateTimeOriginal·OffsetTimeOriginal·SubSecTimeOriginal 등)와 source의 값 집합은 후보로 고정할 자리이며 설정 timezone을 metadata 원문에 덮어쓰지 않는다. 저장은 `(file_id,key)`의 file_metadata 계약을 받는다(A:403, A:579; T4:7; `packages/sqlite/migrations/0002_files_and_work.sql:289`, :293).

이미지는 이미 `unsupported`로 닫혀 있고 실패 행도 없어서 failures retry나 extractor_version bump만으로 살아나지 않는다. 현재 stale predicate는 다른 버전의 **현재 ok** 세대가 있는 파일만 고른다. EXIF는 epic 8의 이미 정해진 Carry 방식(내용 bytes로 새 지원 형식을 판정하고 새 extractor_version마다 한 번 재큐잉, 저장 MIME만 신뢰하지 않음)을 이미지로 확장해야 한다. 전체 unsupported/too_large를 매 drain마다 다시 넣는 구현은 어긋남이다(E4:82; E10:110; E8:114; `packages/sqlite/src/extractions.ts:104`, :111). 8이 먼저 추가하는 PG Store/fake/계약의 선택 재처리 능력을 소비하고 중복·이미 가림·접근 불가 제외를 확인하는 후보가 된다(A:392, A:402).

촬영 일시 필터는 8의 recall docs 검색 predicate/SDK 입력·CLI metadata에 더한다. 이름 전용 Drive 사진은 원본을 내려받지 않아 EXIF가 없을 수 있으므로 기존 이름 검색을 유지하며 촬영 일시를 지어내지 않는다. UTC 촬영 필터와 offset 없는 local 촬영 필터를 한 절대 범위로 섞을 수 없으므로, local 비교 옵션 또는 시간대 확정 자료만 절대 필터 대상이라는 선택지를 명시해야 한다. 수집일/추출일 필터와 촬영일 필터도 구분한다(E8:43; A:287, A:403; S:62).

| 라이브러리 후보 | 공식 근거와 적용 경계 |
|---|---|
| exif-reader | spine의 기존 후보(2.0.3 관찰값, A:662). Node Buffer로 raw EXIF를 읽는 JS 모듈이고 MIT. 이미지 컨테이너에서 EXIF segment를 꺼내는 detector/범위 검사까지 자동으로 해결한다고 볼 수 없다. Date 객체를 반환하는 예시가 있으므로 원문 문자열을 보존할 수 있는지 실제 소스를 확인해야 한다. 공식 `README.md:8`, :43, :61, :112와 `package.json:2`, :4, :26([README](https://raw.githubusercontent.com/devongovett/exif-reader/master/README.md), [package](https://raw.githubusercontent.com/devongovett/exif-reader/master/package.json)). |
| exifr | Node/browser, Uint8Array 입력, 태그 선택·여러 이미지 컨테이너를 지원하는 JS 대안, MIT. 날짜 자동 변환을 끄고 원문과 offset을 별도로 보존할 수 있는지 확인할 후보다. 공식 `README.md` Features·Usage·Installation 및 저장소 LICENSE([공식 저장소](https://github.com/MikeKovarik/exifr)). |

둘 다 이번 조사에서 설치하지 않았다. 버전·Node 24 import·라이선스 배포물·잘못된 offset/IFD·큰 입력·손상 입력의 동작은 구현 때 고정할 검증 항목이다. 라이브러리는 runtime adapter에서 import해 Core에 주입하는 8의 기존 결정과 맞추며, metadata 저장을 위해 Core의 플랫폼 없는 경계를 풀지 않는다(E8:114; `packages/core/src/files/extractors.ts:52`; T4:7).

## 9. 레인·한 세션 위험·Done when 시험 기반·이 Mac

공유 파일 레인은 아래와 같다. 앞 에픽 코드가 생긴 뒤 실제 파일명/다음 migration 번호를 확인한다. 여기의 새 경로는 후보이며 이 조사에서 만들지 않았다(T17:2; E3:115; A:645).

| 레인 | 함께 고칠 파일·경계 |
|---|---|
| 공용 조회·시간 | core ports/store·brain·instant/새 날짜 구간 함수·testing contracts/fakes, PG 검색 adapter, CLI commands/index·dispatch·envelope. 3 stats/17 건강 날짜 변환과 통합(A:257; T17:44) |
| 미러·rebuild | core queue handler·session ingest/redact transaction·출력 codec registry, PG work/config Store, CLI assembly/config/doctor. 12의 임대·직렬화 위에서 순차 편집(A:298, A:358; T17:20) |
| EXIF | extractors/extract-work/result type·metadata Store, runtime library adapter, PG Carry query·검색 predicate, manifest/lock. 8의 PDF/docx Carry와 같은 파일 충돌(E8:114; `packages/core/src/files/extractors.ts:31`) |
| 평가·배포 | tooling/eval·중립 fixtures·workspace manifest, recall skill 안내, 최종 plugin app-ref/version. 공통 명령 metadata/출력 probe 변경 이후 통합(T17:56, T17:79; I:183) |

한 세션 위험은 (1) 시간 조회+logs+count+러너를 한번에 넣어 모집단/월 경계가 어긋나는 것, (2) 미러 renderer+rename+redact 경쟁+버전 전량 enqueue를 한번에 끝내려는 것, (3) EXIF parser 교체와 과거 unsupported 재처리를 결합해 영구 오류 무한 재시도를 만드는 것이다. 계약/합성 tracer를 먼저 관통하고 각 실패 행렬을 분리하는 선택지가 있다. renderer 순수 함수와 FS adapter는 분리 가능하지만 미러 transaction/worker 통합은 한 소유자가 합쳐야 한다(A:257, A:298, A:580; E4:82; `packages/sqlite/src/extractions.ts:104`).

아래는 기존 시험 **소스의 기반**이지 통과 판정이 아니다.

| Done when | 기존 기반 | 빠진 확인 후보 |
|---|---|---|
| 1 시간 조회 | 절대 시각 codec, 17.4의 DST 계획(`packages/core/src/instant.ts:33`; T17:45) | 어제/지난주 변환 안내·프로젝트 무관·시간순·빈 기간·D7·sessions list·DST/월 경계(E4:38) |
| 2 SM-3·회귀 runner | 17.5 고정 fixture, 17.7 실제 질문 확인 계획(T17:56, T17:79) | TOML schema·hit@k 독립 기대값·동일 문항 전후 비교·파일에 본문 없음·사람 SM-3 별도 기록(E4:39; PA:158) |
| 3 출처 원문 | 17.3 expand/session read 계획(T17:32) | log 출처→원문·rebuild 뒤 출처 안정성. 공통 원문 읽기를 새로 구현하지 않음(E4:40; A:287) |
| 4 결과 계약 | 현재 출력 codec suite와 17.3 budget 계획(`packages/core/test/output-codecs.test.ts:269`, :322; T17:33) | logs/time도 가린 뒤 8,000자·0건/실패·limit+1·next·누락 수. count는 제외(E4:41) |
| 5 미러 | codec registry·queue claim 상실/영구 실패 기반(`packages/core/test/queue-drain.test.ts:175`, :272; `packages/core/src/output/codecs.ts:15`) | 삭제/rebuild bytes 동등·파일명 충돌·외부 편집 무역수집·rename 실패·동시 ingest/redact·패턴 버전 전량·DB 잠금 밖 쓰기(E4:42) |
| 6 rebuild·doctor·SM-7 | 17.2 writer 재청구/redact 계획·불변 config type(T17:20; `packages/core/src/domain/index-config.ts:32`) | 두 설정 혼합 방지·중단 재개·원문/로그 불변·UNINDEXED·실패 색인·내부/전체 지연 중앙값(E4:43; P:423) |
| 7 EXIF | txt 추출·실패·버전 재추출 suite와 file metadata 가림 trigger(`packages/core/test/document-extract.test.ts:241`, :348, :588; `packages/sqlite/migrations/0008_attachment_rules.sql:72`) | offset 있음/없음·EXIF 없음·깨짐·원문 보존·크기 상한·과거 unsupported 선택 재개·가리기 경쟁·docs 촬영 필터(E4:44; T4:8) |
| 8 count | 공통 envelope count/has_more와 날짜 계약(`packages/core/src/envelope.ts:69`; A:257) | 전수 결과와 동일 모집단·0건·distinct 세션/파일·source-only·부분월·meta 구간·잘림 없음(E4:45; A:289) |

이 Mac에서 에이전트가 할 수 있는 후속 작업은 합성 PG/격리 홈 fixture·설치본 신원/명령·미러 재생성·doctor·count·실제 질문에 대한 고정 검색·SM-7 측정의 기계 검증과 private 기록이다. 이번에는 제약에 따라 실행하지 않았다. 사용자의 일반 위임은 설치본 확인을 사람 전용으로 남겨 루프를 멈추지 말라는 것이지만, 명시적으로 사람 채점인 SM-3을 에이전트 hit@k로 대체할 근거는 아니다. 실제 문항·본문·개인 경로는 공개 보고서에 넣지 않고 공개 증거는 중립 id·성공 여부·값 없는 실패 분류로 제한하는 17 선례를 따른다(I:187, I:188; E4:39; PA:158; T17:79). 사람이 해야 할 것은 SM-3 답변 평가와 체감 품질 판단이고, 필요한 원격 push 등 operator action은 별도로 기록할 수 있다(T17:79; P:417).

`decisions-by-recommendation.md`의 기존 결정 목록도 읽었다. 이번 보고서는 선택지만 제시하므로 새 추천 Decision이나 ledger 줄을 추가하지 않는다. 특히 3의 hook PG/규율·8의 metadata Carry 결정은 재논의하지 않는다(E3:111, E3:112; E8:114; `_bmad-output/personal-brain/decisions-by-recommendation.md:83`).

## 스토리 후보

아래는 순서·분할 후보이며 tickets.toml을 바꾸지 않는다. entry 1의 id는 영구이므로 EXIF 의미를 유지하고 표의 위치만 옮기는 선택지가 기존 계약과 맞는다. metadata/필터/Carry를 한 세션에 담기 어렵다면 id 1에 EXIF metadata를 남기고 필터·재처리를 새 id로 분리하는 후보가 있다. id 1을 시간 조회 tracer로 재사용하는 안은 영구 id 원칙과 어긋난다(T4:1, T4:4, T4:7).

| 후보 | 관찰할 결과와 순서 근거 | 고칠 파일 후보 |
|---|---|---|
| C1 시간 조회 tracer | 서로 다른 프로젝트의 로그 한 줄+로그 없는 세션을 같은 날짜로 조회→출처로 17 원문 읽기. AD-13와 D7의 얇은 수직 경로(2절) | core 날짜 함수/ports/store/brain·PG 기간 읽기·CLI recall-time/sessions-list·명령 registry·envelope·합성 fixture |
| C2 logs 검색 | 3의 log_entries를 17 질의/결과 계약으로 검색하고 log 출처에서 넓히기(3절) | core recall logs use case·검색 port/result union·PG logs branch·CLI·recall 스킬 안내·출력/metadata tests |
| C3 count | chunks/logs/docs 동일 predicate 집계와 현지 월 경계·meta. source-only 단위 고정(6절) | core recall inputs·집계 result·공용 날짜 함수·PG aggregates·CLI flags/meta·계약/fakes |
| C4 회귀 runner | TOML 중립 문항→읽기 SDK→hit@k→본문 없는 결과, C2/C3/rebuild 전후 비교 기반(7절) | 새 tooling/eval·workspace/package manifest·중립 fixtures·private 경로 resolver·러너 tests |
| C5 미러 tracer | 한 세션 DB→가린 Markdown→파일 삭제 후 rebuild 동등. 충돌 순번·frontmatter 계약(4절) | core mirror renderer·output/codecs·FS port·CLI runtime writer·brain/assembly·mirror-rebuild command·tests |
| C6 미러 수명/경쟁 | ingest/redact 원자 enqueue·claim 만료·rename 실패·패턴 버전 전량 재생성(4절) | PG session/redact/work transaction·core mirror worker/queue policy·실패/doctor·codec/FS 경쟁 fixture |
| C7 index rebuild | 17 writer를 새 설정으로 전 세션 재생성·part 보존·불변 원문/로그·UNINDEXED(5절) | core index use case/brain·PG index config/활성 설정/work Store·doctor·CLI index-rebuild·계약/tests |
| 기존 1 EXIF(+분리 가능) | 10.8 registry에 metadata 전용 성공·세 칸·바이트 형식 Carry→8 docs 촬영일 필터(8절) | extractors/extract-work/result type·metadata Store/PG/fakes·runtime parser·manifest/lock·docs inputs/predicate·이미지 fixture |
| C8 통합·이 Mac·측정 | 범용 문항 전후 비교·SM-7 내부/전체·미러/검색 가리기·설치본 확인, 사람 SM-3 기록은 별도(9절) | 설치본 확인 기록·tooling/eval fixture/운영 안내·필요 시 plugin/app-ref와 plugin.json version 함께 |

순서안 A는 C1→C2→C3→C4→C5→C6→C7→기존 1→C8이다. 시간/로그의 실사용 경로를 먼저 관통하고 러너를 rebuild 전에 확보한다. 순서안 B는 C5→C6→C1→C2→C4→C7→기존 1→C3→C8이다. 비동기 미러와 redact의 불확실성을 먼저 줄인다. 둘 다 17의 writer/결과 계약·3의 로그·8의 docs/Carry·12의 일감 계약을 코드 entry 수준으로 먼저 받고, V1 뒤 전체 gate는 유지한다(E4:6, E4:76, E4:81; I:187; T17:20; E8:114; A:358). C6·C7은 공유 PG transaction과 queue를 편집하므로 병렬 구현보다 순차 통합이 안전한 선택지이며, 형식별 이미지 adapter와 runner 순수 채점은 공통 계약 확정 뒤 분리할 수 있다(A:580; T17:2).

자체 확인은 문서의 1~9절·스토리 후보·근거 대조와 절대 홈 경로 패턴 검색이다. 테스트 통과나 Done when 달성을 주장하지 않는다. 이 조사에서 작성한 파일은 이 보고서 하나이며 기존 수정·다른 작업자의 파일은 건드리지 않았다.
