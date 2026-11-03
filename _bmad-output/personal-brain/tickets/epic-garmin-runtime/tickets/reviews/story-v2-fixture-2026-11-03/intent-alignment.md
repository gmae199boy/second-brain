# 16.4 의도 정합성 독립 검사

검사 대상은 `/tmp/brain-16-4-followup-review.diff`와 현재 관련 코드다. injected Task `task_089be3fc0fae`, Dispatch `ctx_14e17f946cdc`의 읽기 전용 검사이며 다른 리뷰어 보고서는 열지 않았다. 빌드·시험·oracle 생성은 실행하지 않았고 실제 계정·운영 데이터·비밀에도 접근하지 않았다. 이 보고서는 정적 관찰 결과이며 실행 검증의 성공·실패를 판정하지 않는다. 코드·계획·체크포인트 변경은 없으며 보고서 작성만 수행했다.

## 1. 방어 가능한 의도 해석

1. **순수 계산 결과의 동등성.** 옛 daily·activity 파서와 `digest.day_values`가 고정 합성 입력에서 만드는 표 행을 유지한다. 기대 관찰의 주된 표면은 DB 이전의 옛 표 모양 결과와 `expected.json`이다. 옛 coordinator까지 기준에 포함되므로, NULL raw가 처음부터 대상 행을 만들지 않는 동작도 이 해석에 들어간다.
2. **건강 관측 발행 계약의 완전성.** 성공한 endpoint가 소유한 모든 지표를 NULL까지 불변 관측으로 발행하며, 반입과 같은 논리 키·단위·날짜·시각을 사용한다. 기대 관찰의 표면은 `brain.health_observations`, `health_current_v1`, garmin 상태·권위 표다. “NULL 값도 행으로 낸다”를 raw 자체가 JSON null인 성공까지 포함하는 것으로 읽으면 1번의 옛 대상 행 생성 조건과 긴장이 생긴다. 파서가 반환한 열 값의 NULL만 뜻한다고 읽으면 두 문장은 함께 성립한다.
3. **재정규화 입력의 엄격한 격리.** “이전 dataset의 raw는 다시 정규화하지 않는다”는 항목 파서뿐 아니라 `day_values`의 입력에도 적용된다. 기대 표면은 출력 dataset 이름이 아니라 실제 계산에 들어가는 raw의 출처다. 반대로 이를 “이전 dataset의 항목을 재발행 작업으로 선택하거나 이전 dataset에 쓰지 않는다”로 좁히면, 날짜 계산의 보조 입력으로 계정 전체 raw를 읽는 해석이 가능하다. 다만 원문의 “대상은 수집 dataset뿐”은 엄격한 쪽을 더 직접적으로 지지한다.
4. **불변 이력과 실제 재개 동작.** 동일 입력 멱등성, A→B→A, 역순 발행, 새 버전, 파서 실패 격리뿐 아니라 500행 경계에서 중단된 뒤 다시 발행하고 마지막 chunk에서만 성공 상태를 쓰는 행동까지 포함한다. 기대 표면은 최종 행 수뿐 아니라 중간 commit·상태·attempt 회수 및 사용자에게 전달되는 result/error다. 옛 샘플 표를 물리적으로 교체하던 동작까지 current의 집합 동등성으로 읽을 여지도 있지만, 건강 행 DELETE·UPDATE 금지와 행별 논리 키 계약 때문에 이 부분은 순수 계산 동등성과 불변 저장 의미를 구분해서 읽을 수 있다.

## 2. 이 diff가 구현한 해석

diff는 **옛 순수 계산을 유지하고, 별도 publisher로 불변 관측을 발행하는 해석**을 구현한다. archive의 `garmin_pipeline/normalize/daily.py`와 현재 `normalize_daily.py`, archive의 `digest.py`와 현재 `digest.py`를 텍스트 대조했을 때 차이가 없었다. `normalize_activity.py`는 archive 대비 import 두 줄만 다르다. 이 관찰은 계산 본문의 이식 근거이며 모든 입력의 실행 동등성을 증명한 것은 아니다.

- `normalize_tables.py:110`의 항목 계산은 endpoint별 소유 열과 샘플을 만든다. `normalize_store.py:56`은 표 PK를 `SQLiteText`를 포함한 `encoded`와 `canonical`로 변환하고, `health.convert` 및 `source_endpoint`를 사용한다. `:63`~`:82`에서 UTC 샘플 시각·현지 날짜·문자열 activity id·uuid5 보관 키를 구성한다. 이는 기존 `batch_import.py:219`, `:280`, `health.py:110`~`:173`과 연결된다.
- `collect.py:170`~`:190`은 트랜잭션 밖에서 계산한 뒤 작은 항목은 raw 저장과 함께 발행하고 큰 항목은 chunk로 발행한다. `_write`는 `collect_store.py:20`~`:35`에서 1.9초 제한과 attempt 검사를 적용한다. 건강 관측 쓰기는 `normalize_store.py:104`의 INSERT다.
- `normalize_store.py:38`~`:45`는 재등장한 본문에 fetched 시각 suffix를 사용한다. 항목 상태·날짜 상태·v2 기록은 migration 0008의 garmin 표에 있다. `:86`~`:97`의 첫 v2 배열은 수집 dataset 뒤에 기존 v1 provenance 배열을 연결하며 v1을 수정하지 않는다.
- 항목 재처리 선택은 `normalize_store.py:147`~`:156`에서 수집 dataset으로 제한한다. 날짜 계산은 `normalize_runtime.py:78`~`:110`에서 계정 전체 snapshot을 사용한다. 따라서 입력 격리는 3번의 좁은 해석을 구현한다.
- NULL raw는 무조건 관측을 만들지 않는다. `normalize_tables.py:123`~`:130`은 대상 표 행을 생략하고, `normalize_runtime.py:32`~`:54`가 현재 버전에 성공한 비NULL 열 보유 항목의 이력이 있을 때만 NULL 열 행을 보충한다. 이는 2번의 보편적 NULL 발행보다 1번의 옛 행 존재 조건을 우선한 구현이다.

## 3. 기대 표면과 실제 변경·시험 표면의 차이

### A. 계산 동등성 시험과 실제 publisher 경로는 별개다

`check_normalize_equivalence.py:13`은 `normalize_all`만 호출한다. 표별 행을 정렬한 뒤 expected와 비교하므로 열 값·PK·시각·세트 인덱스 같은 내용은 비교하지만 반환 리스트의 순서 자체는 비교하지 않는다. 이 경로는 `normalize_runtime.prepare`, `existing_row`, `publish_days`, 실제 catalog와 INSERT를 거치지 않는다. 단위 변환·권위·current 선택의 근거는 이 fixture 비교가 아니라 별도 publisher·DB 시험에 있다.

`check_normalize_store.py:10`~`:22`는 축약 catalog의 세 지표로 NULL, 날짜/시각, 세트 무게 변환과 세 PK 모양을 검사한다. PG 시험 `apps/cli/python-test/garmin-normalize.test.ts:59`~`:68`은 실제 반입·수집 키 및 current·v1 불변·v2 배열을 검사하지만 직접 동등 비교하는 지표는 `daily_metric.steps`다. 활동·모든 샘플·세트·day_values 전 지표가 반입 행과 같은 논리 키로 저장되는지까지 하나의 시험이 관찰하는 구조는 아니다. 이는 계산 fixture의 폭과 실제 DB 키 비교의 폭이 다르다는 관찰이지, 비교되지 않은 지표가 틀렸다는 판정은 아니다.

### B. NULL 열 값 발행과 NULL raw 발행의 조건이 다르다

`observations`는 이미 만들어진 표 행의 NULL 열을 발행한다. 반면 raw가 `'null'`이면 앞서 설명한 존재 조건이 적용되며 항목은 성공 상태이면서 건강 행이 없을 수 있다. archive의 `normalize/__init__.py:400`~`:408`, `:441`~`:459`도 NULL raw에 기존 대상 행의 열만 UPDATE하고 행을 만들지 않는다. 따라서 옛 행 생성 의미에는 근거가 있지만 “성공한 항목은 소유 열을 모두 발행”의 무조건적 해석과는 다르다.

고정 입력의 마지막 NULL 항목은 소유 일반 열이 없는 `heart_rates`이고, 다른 NULL 두 항목도 measurement-only다(`input.json:124`~`:129` 및 `normalize_tables.py` 등록표). 이 fixture는 소유 일반 열이 있는 endpoint의 첫 NULL raw 및 기존 행 뒤 NULL raw라는 두 조건을 직접 구별하지 않는다. 더구나 fixture의 `normalize_all`에는 runtime의 `existing_row` 보충 분기가 없다. NULL을 포함한 표 내용 비교와 실제 상태 이력에 따른 NULL 관측 발행은 서로 다른 표면이다.

### C. 출력 날짜 제한과 입력 raw 제한은 일치하지 않는다

`normalize_runtime.rebuild:131`은 수집 dataset의 raw에서 날짜 범위를 얻는다. 하지만 `:116`의 snapshot은 `collect_store.coverage_snapshot:70`~`:79`가 **같은 계정의 모든 dataset**에서 endpoint별 최신 raw를 뽑아 만든다. `publish_days:91`은 그 snapshot을 scope·날짜로만 선택하고 `:102`~`:105`에서 다시 `digest.day_values`에 넣는다. snapshot 항목에는 dataset 출처도 남기지 않는다. 따라서 수집 raw가 있는 날짜에 다른 endpoint가 반입 dataset에만 있으면 그 반입 raw도 날짜 집계 입력이 될 수 있다. collect의 종료 집계도 같은 함수와 snapshot을 사용한다(`collect.py:208`).

이는 이전 dataset 행을 UPDATE하지 않는 성질과 양립하지만, 이전 raw를 계산 입력으로도 다시 쓰지 않는 3번의 엄격한 해석과는 다르다. PG 시험의 반입 전용 날짜 걸음 수 유지 assertion(`garmin-normalize.test.ts:64`)은 `daily_metric.steps` current를 확인한다. 같은 날짜의 수집·반입 혼합 입력으로 만든 `day_summary`·`workout`·`exercise_log`의 출처를 관찰하는 assertion은 아니다.

### D. 500행 초과 최종 결과와 중간 중단·재개 관찰은 다르다

`normalize_store.py:125`~`:143`은 pending 예약 후 500개씩 INSERT하고 마지막 부분에서만 ok를 바꾼다. `unpublished`는 ok가 아닌 항목을 다시 찾는다. 재시도는 남은 offset부터 출발하는 방식이 아니라 같은 결정적 행을 다시 발행하고 core 중복 판정에 맡기는 방식이다.

단위 시험은 `chunks(1001)`의 길이 `[500,500,1]`을, PG 시험 `:92`~`:100`은 샘플 501개의 최종 행 수를 검사한다. 이 시험에는 첫 chunk commit 뒤 강제 중단, 중간 pending 확인, 새 attempt로 재실행하는 과정이 없다. 그러므로 matrix의 중단 후 재개 기대는 구현 분기와 상태 조회에서 추적되지만 해당 시험이 직접 관찰하는 표면은 완주한 결과다. 정적 추적으로 재개가 실패한다고 단정하지 않는다.

### E. attempt 회수의 거부와 오류 코드의 문자 그대로 일치는 다르다

matrix는 회수된 attempt 뒤 쓰기를 `COLLECT_STOPPED`로 기술한다. 실제 `_write`는 DB attempt가 무효이면 `COLLECT_INVALID_ATTEMPT`를 내고, `collect.boundary:28`~`:30`은 로컬 signal 중단 플래그에 `COLLECT_STOPPED`를 낸다. 두 경로를 구분한다.

새 PG 시험 `:116`~`:121`은 완료된 work의 token을 publisher에 재사용해서 `COLLECT_INVALID_ATTEMPT`와 관측 행 수 불변을 검사한다. 기존 `garmin-collect-resume.test.ts:62`~`:80`에는 SIGTERM과 token 회수 뒤 raw 재쓰기 거부 검사가 있다. 전자는 새 정상화 publisher의 DB 거부 표면, 후자는 기존 수집 취소 표면이며, 새 publisher를 실제 chunk 사이에서 취소하여 `COLLECT_STOPPED`를 확인하는 시험과는 다르다. 거부·무변경 의도는 구현되어 있으나 matrix의 단일 오류 코드 표현과 구현의 원인별 코드 구분은 일치하지 않는다.

### F. 불변 보관과 옛 표 교체 의미는 구별된다

archive coordinator의 `:479`~`:485`는 샘플을 삭제 후 대체한다. 새 publisher는 이번 계산이 반환한 키만 INSERT한다. core resolution은 `packages/postgres/migrations/0026_health_json_comparison.sql:114`~`:138`에서 논리 키마다 dataset·fetched_at·버전을 고르므로 새 계산에서 사라진 샘플 키를 일괄 제외하는 의미는 없다. 순수 계산 결과 동등성 및 이전 행 보존이라는 해석과는 맞지만, 옛 표의 현재 샘플 집합까지 완전히 같아진다는 확장 해석과는 다르다. matrix에 샘플 삭제 사례는 없고 새 PG 시험도 그 집합 변화를 관찰하지 않는다.

### G. 전달된 diff의 범위는 16.4 제품 변경보다 넓다

diff에는 AGENTS·자동화 런북·BMAD 도구·에픽 built gate 시험·다른 에픽/RAG 계획 변경도 있다. 이것들은 주어진 16.4 의도에서 직접 유도되는 제품 표면은 아니다. 반면 `packages/`, `apps/cli/src`, `plugin/`의 diff는 없으며 apps/cli 쪽 변경은 Python 통합 시험이다. 따라서 “core·postgres·CLI 코드를 바꾸지 않는다”를 제품 실행 코드 금지로 읽으면 이 경계는 유지된다. digest 전체 파일의 이식으로 body·digest JSON 계산 함수도 소스에는 존재하지만, 새 실행 경로는 `day_values`만 호출하므로 그 파일의 존재만으로 제외된 기능의 실행을 주장할 근거는 없다.

## 검사 상태

요청된 의도 해석·구현 해석·관찰 표면 차이의 기술을 완료했다. 관련 파일·archive 코드 추적에 의한 정적 검사이며 실행 검증은 사용자 지시에 따라 미수행이다. 검사 결과를 제품 시험 통과 또는 티켓 수락 판정으로 취급하지 않는다. 추가 작업의 처방은 포함하지 않았다.
