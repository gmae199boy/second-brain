---
name: brain-install
description: 확장의 설치, 로그인, 연결 및 예약 상태를 확인하고 설치를 이어 갑니다.
---

# 확장 설치

설치는 사용자 요청 범위에서만 수행한다. 설치·연결·예약 변경 영향을 설명하고 사용자가 구체적으로 요청한 확장 설치를 동의로 쓴다. 인증 비밀은 사용자가 직접 입력한다.

사용자가 요청한 확장 이름을 확인한다. 이름이 없으면 물어보고 임의로 정하지 않는다. 아래 명령의 `<name>`은 확인한 이름으로 바꾼다. JSON 응답의 성공 여부와 `data` 또는 `error`를 확인한다.

1. `brain guide schema ext --json`을 실행한다. 응답에 `ext install`과 `ext status`가 둘 중 하나라도 없거나 명령을 지원하지 않으면 확장 설치 기능이 미구현이라고 알리고 중단한다. 다른 설치 방법으로 우회하지 않는다. 임의 패키지를 설치하거나 별도 LaunchAgent를 생성하지 않는다.
2. `brain ext status <name> --json`으로 현재 상태를 조회한다. 조회가 실패하면 확인할 수 없다고 보고하고 설치하지 않는다.
3. `installed`와 `enabled`가 참이고 `install.result`가 `installed`이며 여덟 단계 `package`, `environment`, `migration`, `role`, `configuration`, `login`, `connection`, `schedule`이 각각 `succeeded` 또는 `skipped`이고 연결 상태가 `connected`이면 이미 완료된 것이다. 중복 설치하지 않는다. 그 외의 부분 상태는 `brain ext install <name> --json`으로 설치하거나 재개한다.
4. 설치 명령은 로그인, 연결 확인과 공통 예약 등록을 처리한다. 별도의 예약을 만들지 않는다. `login_required`이면 brain-login 스킬 또는 `brain ext login <name>`으로 사용자가 인증을 직접 완료하도록 안내한다. 비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다. 사용자가 완료했다고 응답하면 같은 설치 명령으로 재개한다. 응답이 없거나 인증이 미완료이면 재개하지 않고 미완료를 보고한다.
5. 성공, 실패, 취소, 인증 미완료, 이미 완료된 경우 모두 마지막으로 `brain ext status <name> --json`을 재조회한다. 재조회에 실패하면 최종 상태를 미확인으로 보고하며 완료를 주장하지 않는다.

마지막 상태의 `installed`, `enabled`, `install.result`, `install.stages`, `login`, `connection`, `schedule`을 근거로 완료된 단계와 미완료 단계를 구분하고 다음 행동을 안내한다. `skipped`는 해당 단계가 필요 없어 건너뛴 것이므로 성공과 구분해 보고한다. 기록이 없거나 `pending`, `failed`, 누락된 단계는 완료로 간주하지 않는다. `install.failed_stage`, `install.last_failure`와 명령 오류의 고정 코드가 있으면 보고한다. `connection_failed`는 연결과 예약 미완료를, `scheduler_unavailable`은 설치·연결과 예약 미완료를 구분한다. 최종 상태가 완료 조건을 뒷받침할 때만 완료라고 말한다. 공개 상태에 없는 사실을 추정하지 않는다.
