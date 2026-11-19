---
name: brain-garmin-install
description: 설치된 Personal Brain core에 Garmin 확장을 설치하거나 상태를 확인합니다.
---

# Garmin 설치

먼저 `brain guide schema ext --json`으로 `ext status`, `ext install`, `ext login` 지원을 확인한다. 설치·상태 명령이 없거나 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. Personal Brain core가 먼저 설치되어 있어야 한다. core가 없으면 설치 안내만 하고 직접 설치하지 않는다. guide의 로그인 명령 지원만으로 설치된 Garmin 패키지의 인증 지원을 단정하지 않는다.

`brain ext status garmin --json`으로 현재 상태를 읽는다. 조회에 실패하면 미확인으로 보고 중단한다. 이미 설치가 완료되고 connected인 경우 기존 상태를 그대로 보고 재인증하거나 중복 설치하지 않는다. 기존 connected와 login skipped는 그 상태대로 보고한다. 카탈로그의 `login_required`는 패키지 메타데이터이지 현재 로그인 상태가 아니다.

사용자가 Garmin 설치를 요청했고 완료되지 않았다면 `brain ext install garmin --json`으로 설치하거나 재개한다. `EXTENSION_LOGIN_REQUIRED` 또는 공개 로그인 대기 상태이면 guide가 `ext login`을 지원하는지 확인하고 사용자가 접근 가능한 공식 터미널에서 직접 `brain ext login garmin`을 실행하도록 안내한다. 현재 배포 Garmin 패키지는 인증을 선언하지만, 설치된 패키지의 `EXTENSION_INVALID` 또는 `EXTENSION_NOT_INSTALLED`는 고정 코드와 함께 지원 확인 실패로 보고한다. 로그인 명령이 미구현이거나 확인 불가이면 그대로 알리고 우회하지 않는다. 비밀번호, MFA 코드와 토큰을 대화에 요청하거나 저장하지 않으며 사용자를 대신해 입력하거나 터미널 화면을 읽지 않는다.

사용자가 로그인 성공을 확인하면 `brain ext install garmin --json`을 같은 이름으로 한 번 재개한다. 실패·취소 또는 응답이 없으면 재개하지 않고 실제 상태를 보고한다. `LOGIN_REQUIRED`, `AUTH_CANCELLED`, `AUTH_UNAVAILABLE`, `EXTENSION_AUTH_FAILED`, `EXTENSION_CHECK_FAILED`, `EXTENSION_SCHEDULER_UNAVAILABLE` 등 실제 고정 코드와 `brain ext status garmin --json`의 `login`, `connection`, `schedule`, `install.stages`를 구분해 보고한다. `skipped`는 건너뛴 상태이고 근거가 없는 인증 상태는 미확인이다. PostgreSQL 연결과 예약 등록은 각각의 결과만 뜻하며 Garmin 수집 계정 준비 또는 예약 발화의 증거가 아니다. 별도의 예약을 만들거나 임의의 우회 설치·인증을 시도하지 않는다.

모든 설치 명령의 성공·실패·취소·인증 대기 뒤에는 `brain ext status garmin --json`을 다시 읽고 실패하면 최종 상태를 미확인으로 보고한다. `TOKEN_VERIFY_PENDING`은 터미널 인증 후 저장 토큰의 무인 검증 대기이며 재로그인 요구가 아니다. `AUTH_UNAVAILABLE`은 다음 이름 설치에서 다시 확인할 수 있다. `GARMIN_BINDING_RECOVERY_REQUIRED` 또는 `GARMIN_BOUND_LOGIN_REFUSED`는 기존 결합 계정의 인증 복구가 필요하다는 뜻이다. 토큰과 결합 증거를 보존하고 지원을 요청하며 터미널 로그인을 반복하거나 계정 결합을 임의로 바꾸지 않는다.

`GARMIN_ACCESS_TOKEN_UNCONFIRMED`는 저장된 액세스 토큰을 확인하지 못한 결과다. refresh 토큰의 상태는 확인하지 않았으므로 기존 토큰·결합을 보존하고 지원을 요청한다.
