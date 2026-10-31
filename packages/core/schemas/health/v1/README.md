# 건강 계약 v1

정본은 core migration의 catalog이며 `catalog.json`은 배포용 투영이다. 각 원본 표·열은 별도 metric으로 보존한다. `factor`는 저장된 원본 값에서 계약 단위로 바꾸는 배율이다. 분은 초로 60배, kg은 g으로 1000배이며 이미 초·g인 열은 1배다. 원본 SQL에서 단위 근거를 확인할 수 없는 값은 `legacy_unspecified`이며 집계하지 않는다. 원본 NULL은 원문 결측, 센티넬, 정규화 실패 등을 구별하지 못하며 복구할 수 없다. `activity_recovery`는 구 schema의 파생 결과로 schema 12에서 삭제되었으므로 없는 행을 재생성하지 않는다.

논리 키는 source, account, metric, activity, subIdentity, date 또는 instant, timezone이다. 보관 키에는 dataset, 원본 표·키, 정규화 버전, 원문 revision이 더해진다. 날짜와 순간은 정확히 하나만 있어야 한다. 미확인 account 또는 날짜의 timezone은 현재 값이 아니다. NULL은 0이 아니며 음수와 0은 유효 값이다.

권위 규칙은 호출자가 dataset 순서를 명시한다. v1의 권장 순서 의미는 D2 → D1 → D4 → D5 → D3이며, 규칙에 없는 dataset을 자동 보완하지 않는다. 규칙이 없으면 단일 dataset만 허용한다. 선택된 dataset에서 최신 fetchedAt의 서로 다른 원문 revision은 값이 같아도 모호하다. 그 후 지원 목록의 가장 큰 정수 버전을 선택한다. 같은 최종 순위의 typed 값이 다르면 모호하며 같은 값이면 ID순 첫 행을 대표로 삼는다. 대표 ID 순서는 최신성의 뜻이 아니다. 선택 및 미선택 provenance와 규칙 버전을 함께 제공한다.

허용된 sum과 mean은 모호하지 않은 현재 숫자만 사용하고 빈 집합은 NULL이다. 금지된 집계는 `HEALTH_AGGREGATION_NOT_ALLOWED`다. 문자열·JSON과 단위 근거 없는 수치는 숫자 집계 대상이 아니다. 합성 fixture의 기대표는 구현과 별도로 기록하며 TS·Python·PG가 공유한다.

각 catalog 항목의 `nullMeaning`은 해당 열의 결측 해석이며 `meaning`은 원래 값의 의미다. 심박은 bpm, 점수는 score, 반복·세트는 count로 구별한다. `is_rest`의 1은 휴식이고 0은 활동이다. `exercise_log.volume_kg`는 반복 부하의 합을 g 단위로 나타내며 체중과 다른 `g_repetitions`다. fetchedAt은 UTC 오프셋을 반영한 실제 순간으로 비교하고 소수초를 보존한다.

지원 정규화 버전의 초기 목록은 기존 보존 결과 1·2와 알려진 계산 버전 8이다. `accountConfirmed`가 거짓이면 account 문자열이 있어도 미확인 보관 행으로 취급해 현재 값에서 제외한다. JSON 값은 객체 또는 배열이며 스칼라는 허용하지 않는다.

설치된 확장은 읽기 전용 `brain.health_catalog_v1`에서 정본 정의를 읽는다. Garmin tracer는 설치된 `health.py`로 원본 열을 catalog 배율에 따라 변환하고 기존 `steps` 호환 지표를 기록한다.

원문 문자열의 SQL 표현에는 nullable `*_raw` bytea와 `*_encoding` 짝을 사용한다. 계정·운동·보조 identity와 현재/권위 선택은 표시용 치환 문자열 대신 원형 바이트·인코딩을 구별한다. 건강 JSON은 원래 JSON 문자열을 별도로 보존하며 중첩 키를 치환하지 않는다. NUL을 포함하는 파생 JSON의 SQL 표시값은 빈 객체 또는 배열이므로 원문 값으로 해석하지 않는다. 공통 Store가 원문을 복원하고 내부 원문 짝을 제거한 DTO를 제공한다. 디코딩 불능 TEXT는 `invalid-text`, 객체·배열로 해석할 수 없는 JSON은 `invalid-json` 유형으로 원형을 보존한다. SQL 짝 제약만으로 엄격 디코딩과 표시값 일치가 모두 강제되는 것은 아니며 작성·복원 경계에서 검증한다.

## 소비 및 기록 인터페이스

- `brain.health_catalog_v1(metric, definition)`은 지표 정의의 정본이다. `definition`은 이 디렉터리의 `catalog.json` 항목과 같다. 확장 역할은 읽기만 할 수 있다.
- `brain.health_observations`는 확장이 현재 유효한 자기 source 시도에 한해 INSERT하는 불변 보관 표다. 기존 `value`는 숫자이며 `value_type`은 `number`, `text`, `json` 중 하나다. 문자열과 JSON은 각각 `value_text`, `value_json`에 기록하고 나머지 typed 값 칸은 NULL이어야 한다. `catalog_version`, `activity_id`, `sub_identity`는 추가 provenance와 논리 identity다. 기존 숫자 `steps`는 `daily_metric.steps`의 호환 별칭이다. 같은 보관 키의 동일 payload는 삽입하지 않고, 다른 payload는 충돌 오류다. 날짜와 순간을 함께 넣거나 모두 생략하는 행, catalog 타입·단위 위반, JSON 스칼라는 거부한다.
- `brain.health_authority_rules(id, source, account, metric, activity_id, date_from, date_to, revision, datasets)`는 core가 INSERT하는 불변 규칙이다. metric·activity·날짜 경계가 NULL이면 해당 차원에 제한이 없다. 일치 규칙 중 지정한 scope 열이 많은 규칙을 먼저 쓰고, 수가 같으면 높은 revision, 그다음 ID 오름차순으로 정한다. 날짜 범위 양끝은 포함한다. 날짜 경계가 지정된 규칙은 순간 관측에 적용되지 않는다. `datasets`의 순서가 우선순위이고 규칙 밖 dataset을 채우지 않는다.
- `brain.health_supported_versions(version)`은 소비할 정수 버전 목록이며 초기 값은 1·2·8이다. `brain.health_resolution_v1`은 논리 키별 `authority_id`, `authority_version`, 선택 `dataset`, `reason`, 대표 `current_id`, `selected_ids`, 전체 `all_ids`, `unselected_ids`를 제공한다. `reason`은 `account_unconfirmed`, `timezone_unconfirmed`, `dataset_ambiguous`, `dataset_unselected`, `revision_ambiguous`, `version_unsupported`, `value_ambiguous` 또는 NULL이다. `brain.health_current_v1`은 모호하지 않은 대표 관측의 기존 열과 추가 typed·identity 열을 노출한다.
- `brain.health_aggregate_v1(metric_name, operation, source_name, activity_name)`은 `sum` 또는 `mean`의 숫자 결과나 빈 집합의 NULL을 반환한다. 마지막 두 인자는 선택적 필터로 생략하거나 NULL로 둘 수 있다. 허용하지 않는 지표·연산은 `HEALTH_AGGREGATION_NOT_ALLOWED` 오류다. 숫자 타입과 catalog 단위가 일치하는 현재 값만 포함한다.
- TypeScript의 `validateHealthObservation(row, metric)`은 관측을 검증하고 `HEALTH_INVALID_OBSERVATION`을 던진다. `resolveHealth(rows, supportedVersions, authority)`는 **같은 논리 키의 행**을 받아 `current`, `reason`, `selected`, `unselected`, `authorityVersion`을 반환한다. `aggregateHealth(metric, operation, resolutions)`는 해당 지표의 현재 숫자를 집계한다. Python `health.validate`, `resolve`, `aggregate`는 같은 의미를 사용하며 Python `resolve`의 `current`는 대표 ID다. Python `convert(metric, table, column, value)`는 catalog의 원본 열 배율을 적용하고 NULL을 보존하며 잘못된 매핑은 `HEALTH_INVALID_MAPPING`, 타입 위반은 `HEALTH_INVALID_OBSERVATION`이다.
