# 건강 현재값·판정 뷰 조사

결론: 두 뷰는 단순한 최신 행 목록이 아니라 **여러 원본을 보존하면서 명시적 권위와 신뢰 조건을 통과한 측정만 현재값으로 노출하는 계약**이다. `health_resolution_v1`은 선택·탈락·모호성의 provenance를 남기고, `health_current_v1`은 판정에 성공한 대표 ID를 원본 관측 표와 조인한다. 권위 없는 복수 dataset, 같은 수집 시각의 다른 revision, 지원하지 않는 버전, 같은 순위의 다른 값은 임의로 하나를 고르지 않는다. 이 목적은 14.2 설계 기록과 실제 SQL·시험에서 함께 확인된다. [R2:28–46,100–106; M23:43–85; M26:112–145]

제품에서 확인된 소비 경로는 예상보다 좁다. 현재값은 `readHealth()`의 복원 DTO와 SQL 집계 함수로 나가지만, 이 둘의 실행 호출자는 고정 커밋에서 시험뿐이다. 실제 제품 경로는 **resolution을 포함한 반입 검증 snapshot → 독립 기대 판정과 비교 → 검증 보고서 → CLI**다. 그래프·일반 건강 보고서 생성·LLM 입력으로 두 뷰가 연결된 생산 호출은 찾지 못했다. 검증 보고서는 실제로 존재하므로 “보고서에서 미사용”이라고 묶어서 말할 수 없다. [I:18–61; V:145–181,319–356; IV:53–56; ER:9–14]

## 조사 기준과 근거 표기

- 대상: 요청된 `main@03c7b2b50829343b80a22dc6c7923cf070937481`(이하 **S**). 현재 작업 트리나 현재 main 이름의 위치를 구현 근거로 사용하지 않았다.
- `경로:행 @S`와 아래 별칭은 모두 위 **전체 SHA**의 파일이다. 범위 표기는 읽은 근거 범위를 뜻한다. 이 보고서의 합성 예는 실제 개인 자료가 아니다.
- 원본 읽기는 `git show S:<path>`, 전체 검색은 `git grep -n -E ... S -- . ':(exclude)_bmad/**' ':(exclude)_bmad-output/**'`, 변경 추적은 경로별 `git log`, `git show --no-patch/--stat`, `git blame S -L 112,145 -- ...0026...`로 수행했다. 웹·DB·Docker·실계정·시험 실행·소스 수정·Git 상태 변경은 하지 않았다. 쓰기는 이 산출물만 수행했다. 중앙 자동화 state는 읽지 않았다.
- 필수 런북은 시작 때만 읽었고 자동화를 재개하지 않았다. 계획 폴더는 초기 기능 검색에서 제외했다. 이후 **커밋 메시지의 Bmad-Plan이 직접 가리킨 두 파일만 설계 의도 자료**로 따로 열어 구현과 대조했다. 그 문서의 과거 시험 성공 기록을 이번 조사에서 실행한 결과로 취급하지 않았다.
- 한 연구자가 탐색·분석·역사 추적·재대조를 모두 수행했다. 독립 검증자와 연구 firewall은 적용되지 않았다. 사용자 승인 범위에 따라 하위 에이전트·별도 제안서·최적화 구현을 만들지 않았다.

| 별칭 | 파일:기준 행 @S |
|---|---|
| M22 | `packages/postgres/migrations/0022_import_contracts.sql:2` @S |
| M23 | `packages/postgres/migrations/0023_health_contract.sql:8` @S |
| M25 | `packages/postgres/migrations/0025_original_text.sql:33` @S |
| M26 | `packages/postgres/migrations/0026_health_json_comparison.sql:1` @S |
| I | `packages/postgres/src/imports.ts:16` @S |
| OT | `packages/postgres/src/original-text.ts:13` @S |
| NS | `extensions/garmin/src/normalize_store.py:14` @S |
| P | `apps/cli/src/runtime/import-verification.ts:8` @S |
| DS | `apps/cli/src/daemon/supervisor.ts:64` @S |
| V | `extensions/garmin/src/verify_compare.py:145` @S |
| IV | `extensions/garmin/src/import_verify.py:21` @S |
| RP | `extensions/garmin/src/reports.py:24` @S |
| RUN | `packages/core/src/extensions/run.ts:4` @S |
| XR | `apps/cli/src/runtime/extensions.ts:104` @S |
| ER | `apps/cli/src/commands/ext-run.ts:7` @S |
| HC | `packages/postgres/test/health-contract.test.ts:23` @S |
| IC | `packages/postgres/test/import-contracts.test.ts:118` @S |
| GN | `apps/cli/python-test/garmin-normalize.test.ts:176` @S |
| GV | `apps/cli/python-test/garmin-import-verify.test.ts:63` @S |
| R2 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-view-fixture-ts-python-ambiguity-plan.md:24` @S — 설계 의도 자료 |
| R4 | `_bmad-output/personal-brain/tickets/epic-garmin-import/tickets/story-batch-checkpoint-plan.md:217` @S — 설계 의도 자료 |

## 1. 왜 도입·변경됐는가

### 확인되는 변경 이력

| 시점(KST)·커밋 | 확인된 변경과 의미 |
|---|---|
| 2026-10-31 20:42:57 `e0a12ab43340e9b94e9dc178b1fd0ac9a940ab8e`, `wip: preserve 14.1 for resume` | 0022와 최초 `health_current_v1` 도입. 처음부터 미확인 계정/날짜 시간대를 제외하고 다른 dataset 충돌, 최신 fetched_at·버전, 같은 순위의 revision·값 충돌을 검사했다. “최신 행만 선택”인 시기는 이 뷰의 도입 코드에서도 확인되지 않는다. 커밋 자체는 미검증 보존점이라고 명시한다. [M22:11–15; 해당 커밋 stat·본문] |
| 2026-10-31 21:12:42 `77753a82c8f656d94b98057ee1ce7a83c30f1c11`, `story 14.1: implemented via bmad-loop` | 14.1 완료 기록과 계획 참조가 있다. 0022 경로 이력에 추가 변경은 없으므로 최초 SQL을 이 커밋에서 새로 만든 것으로 날짜를 바꾸지 않는다. [경로별 log; 커밋 본문] |
| 2026-10-31 22:09:00 `15ceb529147d61690ce5668f6d907d3c2dca6608`, `story 14.2: implemented via bmad-loop` | 0023에서 typed 값·운동/하위 identity·catalog·지원 버전 목록·불변 authority 규칙·resolution을 추가하고 current를 대표 ID 조인으로 교체했다. revision 충돌을 버전 선택 이전에 판정하고, 허용된 숫자 집계 함수를 추가했다. [M23:8–27,43–85] |
| 2026-11-01 02:29:17 `143ebf5fc002a08ba4aba72fe58ef71ae32960c0`, `story 14.4: implemented via bmad-loop` | 0025에서 표시값과 원형 바이트를 분리하고 원형 identity 인덱스·판정을 추가했다. 같은 커밋의 후속 0026은 값 비교를 원문 바이트 포함 tuple에서 논리 문자열/JSON 비교 함수로 변경했다. 저장 원문과 identity는 유지했다. [M25:10–14,33–59,85,93; M26:1–145; 0026 blame 전체가 이 커밋] |
| 2026-11-02 17:39:31 `149c3e0ed59817834501e6486ac0edb38c26e833`, `story 16.4: 전수 정규화와 권위 v2`; 2026-11-03 12:09:24 `d161259db8980ed30420d8913a996e55a675029c`, 후속 수정 | 뷰 SQL 변경 이력은 아니다. 정규화 생산자가 같은 관측 계약에 새 revision/버전을 INSERT하고, 신규 dataset을 앞에 둔 authority revision 2를 발행하는 경로와 재정규화·재개 시험이 추가·보완됐다. 따라서 뷰의 정책이 정규화 업그레이드에도 계속 쓰인다. [커밋 본문·GN 경로 log; NS:14,31–46,78–108; GN:196–209,244–266] |

### 기록으로 확인되는 요구·트레이드오프

14.2 계획은 “14.1의 수치 최소형은 지표 의미·운동 구분·dataset 권위 선택이 없어 … 건강 조회 계약으로 부족”하다고 명시한다. 명시 순서 없는 복수 dataset은 ambiguity로, 단일 dataset은 tracer 호환을 위해 승인 기록 없이 허용한다. 규칙 밖 dataset을 임의로 보완하지 않고, 같은 시각의 원문 revision 충돌을 더 높은 정규화 버전으로 가리지 않는다. 같은 관측의 같은 typed 값만 축약하며 대표 ID 정렬에는 최신성 의미를 주지 않는다. 이는 M23/M26의 실제 순서 및 HC의 기대와 일치한다. **호환성을 유지하면서 명시적 권위가 없는 충돌은 보수적으로 숨기는 선택**은 문서와 코드 모두에서 확인된다. [R2:28–46,102–106; M23:56–77; M26:124–145; HC:25–46,70–74]

14.4 후속 설계 기록은 원문·identity·재조정 payload 대조와 typed 값의 논리 동등성을 분리하라고 명시한다. 공백·객체 키 순서·UTF-8/UTF-16 표현만 다른 JSON은 하나로 수렴하고, 다른 중첩 키·값 및 NUL과 U+FFFD는 구별해야 한다. 기존 불변 행을 UPDATE/backfill하지 않고 읽기 함수로 기존 raw 쌍과 표시값을 비교한다는 선택, PostgreSQL이 직접 표현하기 어려운 NUL·surrogate를 ASCII UTF-16 코드 단위로 바꿔 JSONB 구조 비교를 쓰는 선택은 **기록에 실제로 있다**. IC는 UTF-8/LE/BE 문자열 수렴, 치환 표시문자와 원문 구별, 동등/상이 JSON을 확인한다. [R4:219–231,245; M26:1–65,67–110,138; IC:125–161]

### 연구자의 추론과 확인되지 않은 의도

- 추론: authority·수집 시각·revision·정규화 버전·typed 값은 서로 다른 축이므로 `ORDER BY fetched_at DESC LIMIT 1`만으로 위 계약을 구현할 수 없다. 예컨대 더 최신 D1보다 승인 순위가 높은 D2를 선택하거나, 같은 시각의 두 revision을 둘 다 숨겨야 한다. 이는 SQL 동작에서 도출한 설명이지 SQL 작성자가 남긴 성능 비교 평가가 아니다. [M26:124–145]
- 기록에 없는 것: **전체 resolution을 이 정확한 CTE·상관 서브쿼리·배열 재조회 형태로 작성한 이유**, window 함수·다른 조인 형태와의 성능 비교, 예상 데이터 크기·실행계획·인덱스 선택 비용. 읽은 설계 문서에는 판정 계약과 비교 함수 표현 이유는 있지만 이 전체 SQL 형태 자체의 선택 이유는 없다. [R2:100–107; R4:226–231]
- 최초 0022를 요구한 원래 티켓 본문은 별도로 열지 않았다. 초기 동작은 도입 커밋·코드로 확인되지만 당시 요구의 더 넓은 배경은 여기서 단정하지 않는다.

## 2. 원시 관측에서 현재값까지 어떻게 판정하는가

### 쓰기와 두 종류의 키

원시 응답/정규화 결과와 뷰가 읽는 관측은 다르다. Garmin 정규화 생산자의 `raw_revision(body)`는 UTF-8 원문 SHA-256, `revision_for`는 같은 해시·같은 수집 시각을 재사용하고 다른 시각 재등장에는 시각 suffix를 붙인다. 날짜 revision은 입력 scope/key/endpoint/revision/fetched_at과 labels hash를 묶는다. `observations()`는 catalog mapping과 `convert`를 적용하고 원래 표의 키를 canonical 인코딩하여 `sub_identity`에도 사용한다. 저장 키로 결정적 UUID를 만든 뒤 `_insert`가 typed 관측을 INSERT한다. 날짜 발행은 예약 watermark가 있으면 그것을 관측 fetched_at으로 사용하므로 모든 fetched_at을 벽시계상 원시 응답 시각이라고 일반화하면 안 된다. [NS:17–36,39–46,57–83,101–108,248–264]

보관 키는 `source, dataset, account identity, original_table, original_key, metric, activity identity, sub identity, local_date, observed_at, time_zone, normalization_version, revision`이다. import_batch·fetched_at은 그 unique 키의 일부가 아니다. 반면 **판정 논리 키**는 `source, account identity, metric, activity identity, sub identity, local_date, observed_at, time_zone`이며 dataset·원래 표/키·버전·revision은 그 논리 키의 후보들이다. 0026의 keys SELECT에는 표시용 account/activity/sub 열도 함께 DISTINCT에 들어가지만 후보 일치 비교는 원형 identity를 사용한다. 표시값이 다른 비정상 수동 입력의 모든 조합까지 시험한 것은 아니다. [M25:44,50–54; M26:113–119]

identity는 `(encoding 기본 utf-8) + ':' + hex(raw 있으면 raw, 없으면 UTF8(display))`다. 값이 NULL이면 식도 NULL이며 tuple `IS NOT DISTINCT FROM`으로 NULL끼리 같은 키를 이룬다. **identity에서는 같은 문자라도 인코딩/바이트가 다르면 다른 키**가 될 수 있다. 표시문자 `a�b`만으로 실제 `a\0b`를 합치지 않는 시험이 account·activity·sub 각각에 있다. 같은 보관 키 재입력은 trigger가 payload 전체를 대조하여 같으면 INSERT를 생략하고 다르면 충돌을 발생시킨다. 관측은 UPDATE/DELETE 불변이다. [M25:33–55; M22:58–68; IC:138–148; HC:48–52]

### 실제 SQL 단계 — 최종 정의는 0026

| 단계 | 하는 일·경계 | 근거 @S |
|---|---|---|
| keys | health_observations 전체에서 논리 키를 만든다. current 전용 선필터나 dataset WHERE는 없다. | M26:113–114 |
| decisions | 키의 모든 dataset 수, 모든 행의 `bool_and(account_confirmed)`, 모든 ID를 계산한다. 계정 확인은 선택할 dataset/버전만의 검사가 아니다. 하나라도 false면 다른 dataset의 행이라도 그 키는 미확인이다. | M26:116–119 |
| authority lateral | source·바이트 account 일치, nullable metric/activity는 wildcard, date_from/to는 날짜 범위다. 지정된 조건 수가 많은 규칙 우선, 같은 구체성이면 revision 내림차순, 마지막은 ID 오름차순으로 1개를 고른다. 좁은 날짜 범위의 폭 자체로 우선순위를 정하지 않으며 sub_identity/time_zone 조건은 없다. 날짜 없는 instant 키는 날짜 제한 규칙과 보통 매치하지 않는다. | M26:120–123 |
| selected_dataset | 규칙 없고 dataset 1개면 그것을 선택한다. 규칙 있으면 datasets 배열 순서 중 실제 후보가 있는 첫 dataset이다. 규칙의 배열에서 전혀 찾지 못하면 NULL이며 다른 dataset으로 자동 fallback하지 않는다. 규칙 없이 복수면 NULL/ambiguity다. | M26:124–128 |
| latest | 선택 dataset 안의 `max(fetched_at)`을 구한다. 다른 dataset이 더 최근이어도 역전시키지 않는다. | M26:129–130 |
| revisions | 그 dataset·최신 시각의 모든 행에서 distinct revision 수와 observed_ids를 구한다. 그 집합과 supported_versions를 조인해 최대 정수 normalization_version을 고른다. revision 수는 지원 버전 후보로 좁히기 **전**의 수다. | M26:131–135 |
| candidates | observed_ids 중 고른 버전의 ID를 정렬하고 typed 값 tuple의 distinct 수를 구한다. tuple은 type, number, 논리 text, 논리 JSON이다. unit은 이 비교 tuple에 없고 입력 catalog 검증 대상이다. | M26:136–138; M25:48–49 |
| reasons/output | 아래 순서의 첫 오류만 reason으로 내보낸다. 오류 없으면 정렬 candidate_ids[1]이 current_id이고, ID 순서는 최신성 판정이 아니다. | M26:139–145 |

reason 우선순위는 `account_unconfirmed → timezone_unconfirmed → dataset_ambiguous → dataset_unselected → revision_ambiguous → version_unsupported → value_ambiguous → NULL`이다. `timezone_unconfirmed`는 local_date가 있는데 time_zone이 NULL일 때이며 instant의 NULL zone 자체를 이 조건으로 거부하지 않는다. 원본 표는 date/instant 중 정확히 하나, confirmed이면 account 존재, timezone null과 missing flag 일치를 강제한다. [M22:6–9; M26:140]

지원 버전은 migration 초기값 **1·2·8**인 별도 표다. 최신 시각에 지원 버전이 없으면 더 오래된 지원 관측으로 돌아가지 않는다. 최신 시각 안에서 지원되는 최대 버전을 선택한다. 미지원 버전의 다른 revision도 revision_count에는 포함되므로 높은 버전으로 원문 충돌을 가릴 수 없다. GN은 시험에서 9를 명시 등록한 뒤 8을 보존하면서 9가 현재가 되는 것을 확인한다. 이 시험의 등록을 제품 기본 지원 목록 9라고 읽으면 안 된다. [M23:18–19; M26:130–140; GN:196–209]

### NULL과 원문 비교

- 값 NULL은 결측 그대로 유지된다. 값을 NULL이라는 이유만으로 현재에서 제외하는 조건은 없다. `jsonb_build_array`로 감싼 비교에는 NULL도 값 tuple의 요소로 들어간다. 값 0·음수와 NULL은 다르다. SQL sum/avg는 NULL을 제외하며 빈/전부 NULL 숫자 집합의 결과는 NULL이다. [M23:12–14,80–86; M26:138–143; R2:46,106]
- 정상 text는 raw가 있으면 그것을 엄격히 해석해 UTF-16 코드 단위 표현으로 비교한다. UTF-8/UTF-16 LE/BE의 같은 내용은 동등하고, NUL과 U+FFFD는 다르다. 디코딩 실패는 `['invalid', encoding, hex(bytes)]`로 비교하여 불능 원형을 정상 문자열과 섞지 않는다. [M26:68–110; IC:125–133]
- 정상 object/array JSON은 모든 문자열 토큰(키 포함)을 ASCII 코드 단위 표현으로 바꾼 뒤 JSONB로 파싱한다. 공백·객체 키 순서·동등 숫자 표기는 수렴하지만 배열 순서·타입·상이 값은 보존한다. JSON scalar·문법/인코딩 실패는 invalid 태그와 원문 바이트로 구별한다. 단독 surrogate escape를 SQL 문자열로 직접 저장할 필요가 없도록 토큰을 변환한다. [M26:1–65; IC:150–161; R4:228–230]
- 이 논리 값 비교와 별개로 identity·불변 payload 재대조는 원형을 유지한다. 0025의 raw 포함 값 tuple 비교가 최종 동작인 것으로 설명하면 틀린다. 후속 0026:138이 이를 대체한다. [M25:54,85; M26:138]

성공 또는 value_ambiguous면 selected_ids는 최고 지원 버전 candidate들이다. revision_ambiguous·version_unsupported면 최신 시각의 observed_ids 전체다. 계정·시간대·dataset 오류면 빈 배열이다. `all_ids`는 논리 키의 모든 관측이고 `unselected_ids`는 그중 selected가 아닌 ID다. 따라서 이름과 달리 “selected에 포함”되었다고 current에 노출되는 것은 아니며, revision ambiguity의 모든 최신 관측이 selected인 경우 그 오류의 unselected 건수는 0일 수 있다. [M26:143–145]

### 합성 데이터 예

다음 예는 source/account/metric/date/zone/activity/sub 키가 같고, 명시하지 않은 계정·시간대 조건은 확인됐다고 가정한다. SQL에서 도출한 예이며 실행 결과라고 주장하지 않는다. [M26:124–145]

| 후보·규칙 | 결과 |
|---|---|
| D1: 12시 값 100, D2: 11시 값 90; 규칙 `[D2,D1]` | D2의 90. dataset 우선순위가 최신 시각보다 먼저다. |
| 같은 후보, 규칙 없음 | dataset_ambiguous, current 없음. D1 WHERE를 붙여도 D1을 자동 채택하지 않는다. |
| D2 최신 12시 revision a/v1/값 90와 b/v8/값 90 | revision_ambiguous. 같은 값·높은 버전도 원문 충돌을 지우지 않는다. |
| D2 최신 12시 revision a/v1/값 90, a/v8/값 91; 지원 `[1,2,8]` | v8의 91. v1도 보존된다. |
| D2 최신 12시 revision a/v10만, 11시에 v8 존재; 지원 `[1,2,8]` | version_unsupported. 11시 v8로 돌아가지 않는다. |
| 동일 최종 순위의 값 90와 91 | value_ambiguous, current 없음. 동일 값 90 두 행이면 UUID 정렬 첫 대표만 current. |
| 동일 최종 순위의 number NULL 두 행 | 오류 없는 NULL 현재값 하나. 숫자 집계에는 수치 기여 없음. |
| 선택 D2는 confirmed지만 같은 키의 D1 행 하나가 unconfirmed | account_unconfirmed. 확인은 all_ids 전체에 걸친다. |

### 조인·외부 WHERE의 위치와 인덱스 한계

current는 최종적으로 `select h.* from brain.health_observations h join brain.health_resolution_v1 r on r.current_id=h.id`다. reason 검사를 join 뒤에 별도로 하는 것이 아니라 resolution이 오류 시 current_id=NULL을 반환하므로 inner join에서 탈락한다. [M25:93; M26:143]

`select value from current where dataset='D1' and metric=...`는 **선택된 대표 h의 dataset/metric을 필터링**한다. resolution 내부의 dataset_count·권위 결정을 D1 후보만으로 다시 하는 뜻이 아니다. 마찬가지로 `where normalization_version=1`은 최고 지원 버전이 8일 때 v1로 재선택하지 않는다. `resolution where dataset='D1'`도 이미 고른 dataset 열을 필터링하므로 NULL dataset인 ambiguity 행을 숨길 수 있다. 실제 I:32의 `where r.source=input.source`는 resolution 결과의 source 범위, M23:85의 WHERE는 current 숫자를 집계할 범위다. SQL의 논리 의미를 설명한 것이며 PostgreSQL의 물리 실행 순서나 모든 CTE의 강제 materialize를 주장하지 않는다. [M25:93; M26:117–145; I:32,53; M23:85]

인덱스는 관측 PK(id), supported_versions PK(version), authority PK(id), catalog PK(metric), 원형 보관 unique `health_storage_identity`, 규칙 unique `health_authority_identity`를 확인했다. 보관 unique는 dataset·원래 표/키·버전/revision까지 포함하는 멱등성 제약이고 fetched_at 정렬 인덱스가 아니다. authority unique는 같은 원형 규칙 범위/revision 중복을 막지만 구체성 점수 내림차순 선택을 그대로 저장한 인덱스는 아니다. PK는 `id=any(...)`, current_id 조인과 버전 membership 등 접근을 지원할 수 있고 unique 선두 source 등은 접근 경로가 될 수 있다. **실제로 어느 인덱스를 타는지는 실행계획 없이 확정하지 않는다.** [M22:3,9; M23:3,18,20–25; M25:41,44; M26:122,130–138]

판정은 해당 논리 키의 모든 dataset 존재·확인 여부·all_ids, 선택 dataset 최신 시각의 모든 revision, 그중 최고 지원 버전의 모든 값 비교를 요구한다. 한 최신 행만 인덱스로 꺼내서 dataset/revision/value 충돌을 생략할 수 없다. 필터 없는 I:53과 resolution snapshot은 여러 키의 이 계산을 요구하며, 좁은 source/key 필터를 실행기가 어느 정도 아래로 전달할 수 있는지는 별도 문제다. 전체 후보를 고려해야 한다는 의미적 요구를 “매번 무조건 표 전체 순차 스캔”으로 바꿔 말할 근거는 없다. [M26:113–145; I:32,53]

## 3. 무엇이 실제로 조회하고 어디로 이어지는가

### 생산 SQL 진입점 전수 검색 결과

정확한 두 뷰 이름으로 계획 폴더를 제외한 전체 저장소를 검색했다. migration 정의·문서·시험을 제외한 직접 SQL 조회 위치는 **`packages/postgres/src/imports.ts:32,53` 두 곳**, 그리고 DB 함수 **M23:85**다. 다른 생산 파일에 직접 뷰 조회는 없다. `packages/postgres/src/store.ts:29` @S가 `postgresImportStore(connect)`를 imports로 붙이며, 포트의 `packages/core/src/ports/import-store.ts:22–23` @S가 readVerification/readHealth 반환형을 공개한다. 이 두 파일의 연결은 symbol 검색으로 대조했다.

| 진입점 | 실행 내용·끝나는 곳 | 사용 범위 |
|---|---|---|
| `postgresImportStore.readHealth`, I:51–63 | 필터 없는 current 전 열 조회 → 허용 필드 DTO → dataset_label 및 account/activity/sub/text 원문 복원 → JSON 복원 → `{ok:true,rows}`. raw/encoding 내부 열은 DTO에 직접 노출하지 않는다. 실패는 databaseFailure. [OT:13–46] | 실제 생산 구현이지만 `readHealth` 전체 검색의 호출은 시험뿐이다. 반환 DTO 이후 제품 그래프·LLM 연결은 없다. |
| `brain.health_aggregate_v1`, M23:80–92 | catalog의 허용 operation 검사 → 현재 number·catalog 단위 일치·선택 source/activity만 sum/avg → double precision 또는 NULL. 금지 연산은 오류. | 함수는 brain_app에 공개됐지만 저장소 실행 호출은 HC:74,81,104의 계약 시험뿐이다. TS `aggregateHealth`도 별도 순수 함수이며 뷰 조회자가 아니다. |
| `postgresImportStore.readVerification`, I:18–49 | 현재 출처의 유효 attempt 확인 → repeatable-read/read-only, 2초 제한 트랜잭션 → 원 관측·권위·resolution·지원 버전 등을 snapshot tables에 담아 반환. resolution은 source 필터만 있다. | 아래 실제 import-verify 제품 경로가 호출한다. |

### 실제 검증·보고서·CLI 호출 경로

1. `apps/cli/src/commands/ext-run.ts:9` @S가 `context.brain.ext.run(...)`을 부른다. `packages/core/src/brain.ts:434` @S의 연결은 `runExtension(dependencies,input)`이다. RUN:17–23은 설치 manifest의 manual job을 찾아 일감을 enqueue한다. Garmin 선언 `extensions/garmin/manifest.json:139–148` @S는 `garmin.import_verify`, `src/import_verify.py`, manual `import-verify`, `verification_snapshot:true`, public_report를 명시한다.
2. DS:65–78은 해당 작업의 실행 spec을 만들 때 `prepareImportVerification`을 호출하고 반환 경로를 `BRAIN_IMPORT_VERIFICATION_SNAPSHOT` 환경 변수로 넘긴다. **뷰를 Python 확장이 직접 SELECT하는 경로가 아니다.** P:9가 imports.readVerification을 호출하고, 파일 검증 동안 attempt가 바뀌지 않았는지 P:24에서 한 번 더 호출한다. P:29–35가 tables 및 파일 관찰 결과를 private JSON snapshot에 직렬화한다.
3. IV:25는 snapshot을 읽고 IV:35–42는 catalog·Garmin 보관 표와 capture를 읽어 `compare`에 전달한다. V:145–181의 `compare_resolution`은 원본 후보 그룹·승인 provenance·지원 버전으로 Python `resolve` 기대를 계산한다. snapshot `tables['health_resolution']`에서 all_ids가 겹치는 행이 정확히 하나인지 확인하고 current/selected/unselected/reason/dataset/authority ID·버전/all_ids를 대조한다. V:319가 이를 호출한다.
4. V:179,356은 각 identity의 expected/observed 판정과 차이를 private details에 넣는다. V:350–354의 unselected 및 reason별 숫자는 **DB 반환 행을 직접 더하는 대신 독립 expected 판정에서 계산**된다. DB 판정 차이는 authority check 실패·mismatches로 드러난다. 따라서 공개 숫자를 DB resolution raw 집계라고 부르면 부정확하다.
5. V:27–31의 `public_projection`은 고정 counts/checks만 내보낸다. IV:53–55는 `write_reports` 후 check 실패 시 `EXTENSION_REPORT_NOT_READY`를 발생시킨다. RP:24–46은 확장 home의 `reports/<work-id>/private.json`, `public.json`을 제한 권한으로 쓴다. private는 상세 판정/차이, public은 고정 수치와 bool이다.
6. XR:106이 고정 public.json을 읽는다. RUN:35–47은 작업 완료·보고서 정확한 키·안전 정수/boolean을 검증한 뒤 성공 결과 또는 보고서 포함 실패 결과를 반환한다. ER:11,14는 이를 JSON data.report 및 text count/check 줄로 반환한다. GV:63–85는 지원 버전 제거를 정상 검증하고, authority rule 변조로 current가 같더라도 authority_id/version이 달라지면 검증 실패하고 기존 선택은 수정하지 않는 것을 확인한다.

이 경로는 **검증 프로그램 실행과 검증 보고서** 사용이다. 건강 추세 그래프·일일 건강 해석 보고서·LLM 프롬프트에 current/resolution의 측정값을 공급하는 기능은 별개이며, 정확한 뷰명과 readHealth/aggregateHealth/resolveHealth/health_aggregate_v1 전체 검색에서 그러한 제품 호출은 발견되지 않았다. 독립 Python resolve는 검증 기대값 계산에 쓰이므로 뷰 조회와 혼동하지 않았다. 동적 SQL/저장소 밖 외부 사용자가 이 공개 DB 계약을 호출할 가능성까지 부정하는 결론은 아니다.

### 시험의 조회 경로 — 제품 기능과 분리

아래는 두 뷰를 직접 조회하는 **모든 시험 파일**과 주요 assertion 위치다. 각 `경로:행`은 @S이다. 단순 assertion 조회와 실제 제품 검증 경로 실행을 구별했다. 일부 파일은 본문 예산상 검색된 SQL/assertion 행만 확인했다.

| 시험 파일:행 @S | 무엇을 확인하는가 |
|---|---|
| `packages/postgres/test/health-contract.test.ts:27,42,62,72–74` | current 지원 버전 선택, 공유 fixture의 resolution reason/ID/provenance, 운동·sub·날짜·zone 분리, authority 범위, revision/value ambiguity가 current와 sum/mean에서 빠짐. DB 계약 통합 assertion이다. |
| `packages/postgres/test/import-contracts.test.ts:118–162` | 계정·timezone·typed current, UTF 인코딩 논리 수렴, NUL/치환문자 identity 분리, readHealth 원문 JSON DTO·내부 열 제거, JSON 동등/상이 값. readVerification 자체는 :67,77–78,264에서도 검증한다(검색 행 확인). |
| `packages/postgres/test/migrate.test.ts:317,344,346` | 기존 current 수치/typed 열 보존 및 0025의 value_ambiguous가 0026 논리 비교 후 reason NULL·selected 2로 바뀌는 upgrade assertion. 검색 행 확인. |
| `apps/cli/python-test/garmin-tracer.test.ts:63–66,116,129,134` | 설치된 tracer 결과의 source/dataset/value/unit/date/zone, readHealth 반환, 미확인/mixed/no-zone 제외 assertion. 검색 행 확인. |
| `apps/cli/python-test/garmin-batch-import.test.ts:69,82–83,109,383` | batch 반입 activity/exercise 값과 body battery 샘플 current, 재실행·readHealth 결과. 검색 행 확인. |
| `apps/cli/python-test/garmin-body-digest.test.ts:109,111` | day_summary current 존재와 steps/active_kcal 조회 helper. 검색 행 확인. |
| `apps/cli/python-test/garmin-import-verify.test.ts:65,71–83,88–90` | resolution 직접 assertion과 함께 실제 `ext run garmin import-verify --json`의 authority check·public/private 투영을 대조한다. 여기의 CLI 검증은 위 생산 경로를 실행한다. |
| `apps/cli/python-test/garmin-normalize.test.ts:76–77,102,121,144,148,155,175,202–205,255,266` | 정규화 후 current 값, 파싱 실패 시 기존값 보존, v8→9 공존·현재 선택, 날짜 발행 재개·원시 최대 시각 동률/labels 변경/오래된 예약 거부 뒤 ambiguity 없음. :176–195는 target 생성 전 NULL과 이후 NULL 발행을 원 관측으로 확인하므로 이를 current 직접 assertion으로 분류하지 않았다. |
| `apps/cli/python-test/garmin-pass2.test.ts:50,54,57,62,102,106` | 날짜·exercise current의 revision/value 및 version/fetched_at, 111→222 갱신 assertion. 검색 행 확인. |
| `apps/cli/python-test/garmin-upgrade.test.ts:48–71` | 기존 동률 revision ambiguity 유지, 다른 날짜 값 보존, 새 정규화 버전의 current/fetched_at assertion. 검색 행 확인. |

`packages/core/test/health.test.ts:3,27–28` @S는 TS 순수 resolve/aggregate를 시험하는 위치로 검색됐다. 두 DB 뷰를 조회하지 않으므로 위 직접 조회 파일 목록에 넣지 않았다. `apps/cli/test/import-verification.test.ts:10–12,56–57` @S도 mocked readVerification snapshot을 쓰므로 실제 resolution SQL 조회 증거가 아니다.

## 핵심 주장 재대조와 남은 의문

최종 본문 작성 전 다음 연결을 다시 대조했다: M26의 실제 최종 정의와 M25의 current 조인; I:32→P:9/24→DS:71/78의 snapshot 전달; IV:25/42→V:150/169–180/319/356→RP:38의 private/public 보고; XR:106→RUN:40–47→ER:11/14의 CLI 반환. `readHealth`와 `health_aggregate_v1`은 전체 symbol 검색으로 제품 caller 부재와 시험 caller를 다시 구별했다. 이것은 정적 코드 재대조이며 테스트·DB 실행 검증은 아니다.

예산 기준은 질문별 본문 15파일, 역사 추적 10커밋이었다. 본문을 열지 않은 grep 위치는 본문 판독으로 계산하지 않았다. Q1 본문은 migration 4·설계 자료 2·핵심 시험 3·정규화 생산자 1로 10파일, Q2는 migration 4·정규화 생산자·핵심 시험 3으로 8파일이다. Q3의 호출·소비 경로 판독은 I/OT/P/DS/V/IV/RP/RUN/XR/ER/manifest 및 HC/IC/GN/GV의 15파일에서 멈췄다. 다만 Q3에서도 이미 읽은 migration 3개의 정의를 재사용했으므로, 공통 근거를 질문마다 중복 계상하는 보수적 기준으로는 18파일로 기본 예산을 3개 초과했다. 이를 숨겨 15개 이내의 완전 조사로 표시하지 않는다. 생산 store/brain/port 연결과 나머지 시험은 정확한 symbol/SQL 검색 행을 근거로 삼았고 추가 본문 확장은 중단했다.

역사 후보는 다음 10개에서 멈췄다: `e0a12ab`, `77753a8`, `15ceb52`, `143ebf5`, `2e69c3b`, `1a8df1a`, `2f5829f`, `e6bec6e`, `149c3e0`, `d161259`. 앞의 네 개와 뒤의 두 개를 도입/정책·생산자 변화에 사용했고, 중간 네 개는 imports/verify 경로의 보존·후속 수정 이력 확인에만 사용했다. 커밋 목록을 보았다는 이유로 각각의 전체 diff를 읽었다고 주장하지 않는다.

남은 범위는 다음과 같다.

- 전체 CTE/상관 서브쿼리 형태 선택 이유와 대안별 성능 근거는 확인되지 않았다. 실행계획·실데이터 규모·실행 비용은 승인 범위 밖이며 조사하지 않았다.
- 최초 14.1 요구 문서, 모든 과거 review 산출물, 14.6 verifier 변경의 전체 diff, 모든 시험 fixture 생성/실행 본문은 예산에 따라 확장하지 않았다. 따라서 최초 요구의 세부 배경이나 각 과거 회귀의 실제 성공을 추가로 입증하지 않는다.
- 정규화 raw 수집·파서의 전체 진입 경로는 이 두 뷰의 판정/소비 범위를 넘어 추적하지 않았다. 관측 생산자의 키·revision·version·authority 발행과 직접 INSERT 경계까지 확인했다. JSON 토큰 비교 함수의 모든 비정상 입력 조합이나 불일치 표시값 수동 INSERT도 실행 검증하지 않았다.
- 그래프·일반 보고서·LLM에 대한 결론은 저장소 정적 검색으로 확인한 두 뷰와 관련 store/aggregate/resolve symbol의 연결 범위다. 저장소 밖 소비자·동적으로 구성된 임의 SQL·배포된 다른 버전의 실행을 확인한 결론은 아니다.
- 새 최적화 구현·별도 제안·ADR은 작성하지 않았다. 이 보고서 자체 외의 상태·소스 변경과 시험 실행은 남겨 둔 작업이 아니라 이번 읽기 전용 Dispatch의 제외 범위다.
