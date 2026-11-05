# 프로세스 ABI v1

stdout은 UTF-8 JSON Lines다. 한 줄은 JSON 객체 하나이며 줄바꿈 `\n`을 포함하지 않는 65536 UTF-8 바이트까지 허용한다. 상한을 넘으면 즉시 읽기를 중단하고 그룹을 정리한다. EOF에 비어 있지 않은 조각이 남으면 잘린 줄이다. 모르는 이벤트 필드는 거부한다. `usage` 토큰 셋은 모두 있어야 하고 0 이상 안전한 정수여야 한다.

실행 판정은 다음 순서다.

1. 첫 프로토콜 위반이 우선한다. JSON·객체·schema·abi 누락은 `ABI_LINE_INVALID`, abi가 1이 아니면 `ABI_VERSION_UNKNOWN`, 긴 줄은 `ABI_LINE_TOO_LONG`, 잘린 줄은 `ABI_LINE_TRUNCATED`, 두 번째 최종 이벤트는 `ABI_DUPLICATE_FINAL`이다.
2. `error`가 있으면 exit과 무관하게 그 code·retryable로 실패한다. 작업자 코드가 Brain 표에 없어도 보존한다.
3. `result`가 있고 exit 0·signal 없음이면 성공한다. 그 외 종료는 `ABI_EXIT_AFTER_RESULT`다.
4. 최종이 없고 exit 0이면 `ABI_NO_RESULT`, 그 외는 `ABI_EXIT_FAILED`다.

최종은 result·error다. 최종 뒤 progress·heartbeat는 무시한다. result에서 받은 usage는 실행 실패에도 남긴다. heartbeat는 진행이나 임대 갱신이 아니다. 시작 실패는 `PROCESS_START_FAILED`, 출력 읽기 예외는 `ABI_OUTPUT_UNREADABLE`, probe 환경 오류는 `ABI_ENV_INVALID`(exit 2)다. 위 코드 중 `ABI_LINE_TRUNCATED`·`ABI_EXIT_FAILED`·`ABI_OUTPUT_UNREADABLE`·`PROCESS_START_FAILED`만 retryable=true다. 현재 감독자 재시도 정책에는 이 분류를 적용하지 않는다.

환경 변수는 env.schema.json에 정한다. 나머지 환경 변수는 허용한다. BRAIN_RUN_GENERATION은 청구 뒤 attempts다. 선택 계정과 현지 날짜 범위는 값이 생기면 채운다. 날짜는 YYYY-MM-DD이며 양쪽을 함께 주고 포함 범위로 해석한다. schema는 날짜 순서를 비교하지 않는다.

stderr 원문은 UTF-8 바이트로 세며 최대 1 MiB(1048576바이트)까지 그대로 보관한다. 줄로 나누거나 미리 자르지 않는다. 한 바이트라도 넘으면 보관한 원문을 버리고 이후 출력도 계속 소비하되 보관하지 않는다. 이때 저장하는 값은 `[stderr 생략: 원문 1 MiB 초과]`뿐이다. 넘치지 않았으면 EOF(또는 정산 시점)에 `maskSecrets(전체 원문, 'body')`를 한 번 호출한다. 빈 줄을 사이에 둔 키·값과 END 없는 PEM도 전체 문맥에서 가린다. 전체 가림 뒤 NUL을 U+FFFD로 치환하며, 치환 후 최종 바이트 상한을 적용한다. 그 결과의 끝 최대 4096 UTF-8 바이트를 코드 포인트 경계에서 취하며, 시작이 줄 중간이면 그 부분 줄을 버린다. 비었으면 null이다. 중간 값은 저장하지 않는다. 모든 결과에 최종 stderr와 자식 시작부터 exit(또는 정산)까지의 elapsed_ms를 남긴다. 이전 incarnation 회수에서는 elapsed_ms가 null이다. 1 MiB를 넘는 stderr의 진단 내용은 비밀 비노출을 위해 생략된다.

fixture 파일은 core 패키지의 fixtures/process-abi/v1에 있다.

- events.json: `{name, line, expect: 'valid'|'invalid', code?}`. line은 줄바꿈 없는 이벤트다.
- env.json: `{name, env, expect: 'valid'|'invalid'}`. Python 작업자는 두 파일의 기대값과 JSON Schema 검증 결과를 비교한다.
- runs.json: `{name, stdout: (string|{repeat,count})[], exit:{code,signal}, expect:{outcome,code?,retryable?,usage}}`. stdout은 줄바꿈을 포함한 원문 조각이며 repeat은 문자열 반복이다. 조각 크기는 판정을 바꾸지 않는다. usage는 없으면 null이다. 이 파일은 감독자 실행 판정 계약이다. stderr 가림은 TS 감독자의 책임이다.

선택 환경 입력 `BRAIN_SETTINGS_SNAPSHOT`은 UTF-8 JSON 문자열이다. snapshot 실행은 값을 반드시 제공하며, 파싱된 객체는 `settings-snapshot.schema.json`을 따른다. 직렬화된 값은 최대 16384 UTF-8 바이트이고 확장 이름 및 키·타입은 신뢰된 manifest와도 대조한다. 보호된 확장 실행의 진단은 자유 문자열을 고정 안내로 대체하고 선언되지 않은 작업자 오류 코드를 고정 코드로 투영한다. 이는 위의 일반 ABI 실행에서 미등록 코드를 보존하는 동작과 다르다.

`fixtures/process-abi/v1/settings-snapshots.json`은 선언 키 `testext.limit`(number), `testext.token`(string)을 기준으로 판정한다.

설정 snapshot은 `{ "version": 1, "extension": "testext", "user_id": "01940000-0000-7000-8000-00000000000a", "values": {} }` 형태이며 `user_id`는 필수 UUID 문자열이다. self 사용자가 없으면 Runtime은 `USER_MISSING`으로 실행을 중단하고 자식 프로세스를 시작하지 않는다.
