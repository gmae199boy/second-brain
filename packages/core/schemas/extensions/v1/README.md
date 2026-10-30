# Extension manifest v1

`manifest.schema.json`은 공통 구조를 정의한다. `fixtures/extensions/v1/manifests.json`은 공유 판정 사례다. JSON Schema로 표현할 수 없는 관계는 별도로 검증해야 한다: 키와 일감 종류가 해당 확장에 속하는지, 키와 일감 종류가 중복되지 않는지, 예약이 선언된 일감을 참조하는지, 기본 숫자 값이 유한한지 확인한다. TypeScript 코덱이 이 검증을 수행한다. 선택 Python fixture 검사 명령은 `uv run --no-project --with jsonschema python packages/core/fixtures/extensions/v1/check-manifests.py`다.

`work`와 `auth` 명령은 supervised ABI를 사용한다. `default_schedules`와 `raw_views`는 후속 설치 및 공개 view 단계를 위한 선언이다. 각 설정의 `required`는 필요한 단계를 나열하며, 비밀 설정 값은 환경 변수 이름이다. `machine: "tokenstore"`는 내용이 아닌 확장의 로컬 tokenstore 경로를 제공한다. Runtime은 전체 설정이나 환경을 자식에게 전달하지 않는다.
