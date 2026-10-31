# Extension manifest v1

`manifest.schema.json`은 공통 구조를 정의한다. `fixtures/extensions/v1/manifests.json`은 공유 판정 사례다. JSON Schema로 표현할 수 없는 관계는 별도로 검증해야 한다: 키와 일감 종류가 해당 확장에 속하는지, 키와 일감 종류가 중복되지 않는지, 예약이 선언된 일감을 참조하는지, 기본 숫자 값이 유한한지 확인한다. TypeScript 코덱이 이 검증을 수행한다. 선택 Python fixture 검사 명령은 `uv run --no-project --with jsonschema python packages/core/fixtures/extensions/v1/check-manifests.py`다.

`work`와 `auth` 명령은 supervised ABI를 사용한다. `default_schedules`와 `raw_views`는 후속 설치 및 공개 view 단계를 위한 선언이다. 각 설정의 `required`는 필요한 단계를 나열하며, 비밀 설정 값은 환경 변수 이름이다. `machine: "tokenstore"`는 내용이 아닌 확장의 로컬 tokenstore 경로를 제공한다. Runtime은 전체 설정이나 환경을 자식에게 전달하지 않는다.

수동 실행을 허용할 work에는 `manual` 별칭을 선언한다. `public_report`는 `counts`와 `checks`의 고정 라벨 배열을 선언하며 값은 각각 음이 아닌 안전 정수와 boolean만 허용한다. `required_settings`는 해당 일감에서 필요한 선언된 설정 키 목록이다. 별칭과 보고 라벨의 관계 및 설정 참조는 코덱에서 검증한다.

## 원문 view 버전

`raw_views`에 `raw_records_v2`가 있으면 공통 Store는 이를 우선 읽는다. v2는 `source`, `dataset`, `account`, `scope`, `original_key`, `endpoint`, `fetched_at`, `checked_at`, `body`를 제공한다. 자유 문자열에는 nullable `*_raw` bytea와 `*_encoding` 짝이 있다. 지원 인코딩은 `utf-8`, `utf-16le`, `utf-16be`다. SQL 표시값은 NUL을 U+FFFD로 치환하며 원문 바이트가 권위다. 복원기는 표시값과 원문의 일관성을 확인하고, 디코딩할 수 없는 TEXT는 `{type: 'invalid-text', encoding, base64}`로 보존한다.

논리 DTO는 원문을 복원한 `dataset`, `account`, `scope`, `originalKey`, `endpoint`, `body`와 출처·시각만 반환하며 내부 원문 짝을 노출하지 않는다. dataset과 scope·원래 키를 각각 유지하므로 서로 다른 dataset과 slash 포함 키를 합치지 않는다. 표시값을 identity로 사용하지 않는다. v1 `raw_records`는 원형을 정확한 TEXT로 표현할 수 있는 행만 제공하며 전수 원문 조회에는 v2가 필요하다. 공개 import 보고는 별도의 집계·boolean 계약을 유지한다.
