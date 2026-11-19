---
name: brain-login
description: 사용자가 터미널에서 확장에 직접 로그인하도록 안내하고 공개 결과를 확인합니다.
---

# 확장 로그인

사용자가 요청한 확장 이름을 확인한다. 이름이 없으면 물어보고 임의로 정하지 않는다. 아래 `<name>`은 확인한 확장 이름으로 바꾼다.

1. 먼저 `brain guide schema ext --json`에서 `ext login`, `ext status`, `ext install` 지원을 확인한다. 명령이 없거나 확인에 실패하면 미구현 또는 확인 불가로 보고 중단한다. guide의 명령 지원만으로 설치된 확장 패키지가 인증을 지원한다고 단정하지 않는다.
2. `brain ext status <name> --json`으로 현재 상태를 읽는다. 조회가 실패하면 미확인으로 보고 중단한다. 이미 connected이고 login이 succeeded 또는 skipped인 상태를 그대로 보고하며, 사용자의 명시적인 로그인 요청이 없다면 재인증하지 않는다. 카탈로그의 `login_required`는 패키지 메타데이터이지 현재 로그인 상태가 아니다. 상태에 근거가 없으면 인증 상태는 미확인으로 보고한다.
3. Garmin의 현재 배포 패키지는 터미널 인증을 선언한다. 실제 설치된 패키지가 이를 지원하는지는 명령 결과로 확인하며, `EXTENSION_INVALID` 또는 `EXTENSION_NOT_INSTALLED`이면 고정 코드와 지원 확인 실패를 보고하고 우회하지 않는다. 인증이 필요하고 지원되는 경우 사용자가 접근 가능한 터미널에서 직접 `brain ext login <name>`을 실행하도록 안내한다. Orca CLI를 사용할 수 있으면 `orca terminal create --command "brain ext login <name>" --focus --json`으로 터미널을 만들고 사용자가 직접 입력하도록 안내한다. 확장 이름이 명령 인자로 유효한지 확인하고 셸 명령에 안전하게 전달한다. Orca를 사용할 수 없으면 사용자가 접속한 터미널에서 직접 실행하도록 안내한다.
4. 비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다. 사용자가 대화에 비밀번호를 쓰면 사용하지 않고 터미널에 직접 입력하도록 안내한다. 에이전트는 로그인 터미널에 입력을 대신 보내거나 화면을 읽지 않는다.
5. 사용자가 로그인 성공을 확인한 경우에만 기존 설치 입력을 그대로 사용해 한 번 재개한다. 원래 이름으로 설치했다면 `brain ext install <name> --json`을, 원래 외부 경로로 설치했다면 `brain ext install --package <path> --json`을 사용한다. 브라우저나 다른 외부 원본에서 시작한 경우에도 원래 설치 입력을 보존한다. 원본을 모르면 확인 전까지 재개하지 않는다. 재개한 뒤 `brain ext status <name> --json`을 다시 확인한다. 실패·취소이거나 사용자의 응답이 없으면 설치를 재개하지 않는다. `LOGIN_REQUIRED`, `AUTH_CANCELLED`, `AUTH_UNAVAILABLE`, `EXTENSION_AUTH_FAILED` 등 실제 공개 코드와 `login`, `connection`, `schedule`, `install.stages`의 상태를 구분해 보고한다. 상태 조회가 실패하면 미확인으로 보고한다. PostgreSQL 연결이나 예약 등록은 Garmin 수집 계정 준비 또는 예약 발화의 증거가 아니다.

Garmin의 `TOKEN_VERIFY_PENDING`은 저장 토큰 확인 대기이고 `AUTH_UNAVAILABLE`은 다음 설치에서 재확인할 수 있다. `GARMIN_BINDING_RECOVERY_REQUIRED` 또는 `GARMIN_BOUND_LOGIN_REFUSED`는 기존 결합 계정의 복구가 필요하다는 뜻이므로 기존 자격 증명과 결합 증거를 보존한다. 복구 지원을 요청한다.

`GARMIN_ACCESS_TOKEN_UNCONFIRMED`는 저장된 액세스 토큰을 확인하지 못한 결과다. refresh 토큰의 상태는 확인하지 않았으므로 기존 자격 증명과 결합을 보존한다. 복구 지원을 요청한다.
