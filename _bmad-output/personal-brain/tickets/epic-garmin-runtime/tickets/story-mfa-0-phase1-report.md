# 16.2 1단계 구현 보고

## 변경

- `extensions/garmin/migrations/0007_account_protection.sql`: 독립 보호 사실, tokenstore 대상 binding, 호출 intent, 날짜별 probe 예약을 추가했다.
- `extensions/garmin/src/protection.py`: 짧은 transaction의 선행 intent와 결과 기록, 403/429 전이, probe 예약, 수동 rate 해제, profile alias 병합을 구현했다. 미완료 intent는 경과 시간이나 날짜로 해제하지 않는다. 병합 시 auth/rate/manual/uncertain의 합집합과 intent, alias를 보존하고 identity 변경을 거부한다.
- `extensions/garmin/tests/check_protection.py`: 전용 이름의 로컬 격리 PostgreSQL과 가짜 시계로 전이를 시험한다.

## 실제 검증

별도로 생성한 PostgreSQL 18 컨테이너에서 `UV_CACHE_DIR=/tmp/brain-uv-cache uv run --project extensions/garmin --frozen python extensions/garmin/tests/check_protection.py <격리 포트>`가 성공했다. 403 세 번과 429, 다음 날짜 probe 성공 및 재차 차단 후 수동 해제, auth 보존, 미확인 대상 차단, auth와 rate의 alias 합집합을 확인했다. 실제 자식 PID를 intent commit 직후 SIGKILL하고 waitpid로 수거한 뒤 재진입 차단을 확인했다. INSERT와 결과 UPDATE에 각각 DB trigger로 쓰기 실패를 주입했고, 후자는 재연결 후 pending이 유지됨을 확인했다. 컨테이너는 시험 후 삭제했다. 실계정, 운영 tokenstore, Garmin 네트워크는 사용하지 않았다.

## 다음 단계에서 반드시 연결하거나 보완할 사항

- 이 모듈은 네트워크 경로에 연결되지 않았다. `validate`는 같은 transaction에서 현재 attempt, 취소·hold, binding 및 durable admission을 모두 확인해야 하는 필수 주입 경계이며 지금의 시험 validator는 합성이다. supervisor의 선행 durable admission, discovery 공유/배타 gate와 계정 gate가 아직 없으므로 최초 쓰기 실패 뒤 재시작 보장과 동시 discovery 안전성은 이 단계의 시험으로 증명되지 않았다.
- 인증 latch의 성공 해제는 안전한 인증·identity·dump 검증 경계가 아직 없어서 열지 않았다. 2단계에서 검증된 동일 client 인증 성공을 현재 attempt 및 binding 세대에 묶어 추가해야 한다. rate/manual/uncertain은 인증 성공으로 해제하면 안 된다.
- 실제 HTTP pacing, 재시도/refresh 제어, probe 실제 전송 횟수, OS 인증 채널, 실행별 first-call 제한은 아직 구현 또는 검증하지 않았다. DB 권한/role 경계와 실제 감독자, 동시 실행, crash 뒤 재시작 및 전체 보안 행렬은 후속 단계에서 검증해야 한다.
- 이 보고는 전체 스토리 완료나 운영 사용 승인을 의미하지 않는다. 기존 계획 파일의 선행 변경은 건드리지 않았다.
