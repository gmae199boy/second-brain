---
name: brain-install
description: 설치 가능한 확장을 고르고 설치, 로그인, 연결 및 예약 상태를 확인합니다.
---

# 확장 설치

설치는 사용자 요청 범위에서만 수행한다. 설치·연결·예약 변경 영향을 설명하고 사용자가 구체적으로 요청하거나 목록에서 고른 확장 설치를 동의로 쓴다. 인증 비밀은 사용자가 직접 입력한다.

먼저 `brain guide schema ext --json`을 실행한다. 응답에 `ext install`과 `ext status`가 없거나 확인하지 못하면 확장 설치 기능이 미구현 또는 확인 불가라고 알리고 중단한다. 다른 설치 방법으로 우회하지 않는다. 임의 패키지를 설치하거나 별도 LaunchAgent를 생성하지 않는다.

사용자가 요청한 확장 이름이 없으면 guide에 `ext catalog`가 있는지 확인하고, 없으면 목록 기능이 미구현이라고 알리고 중단한다. 지원하면 `brain ext catalog --json`의 성공 여부를 확인하고 이름·버전·설명·로그인 필요 여부·설치 여부를 사용자에게 보여 준다. 조회가 실패하거나 목록이 비어 있으면 그대로 보고하고 중단한다. 사용자가 이름을 선택할 때까지 기다리며 임의로 정하거나 설치하지 않는다. 아래 `<name>`은 사용자가 요청하거나 선택한 이름으로 바꾼다. 이름을 이미 지정한 요청은 목록 조회 없이 이어갈 수 있다.

1. `brain ext status <name> --json`으로 현재 상태를 조회한다. 조회가 실패하면 확인할 수 없다고 보고하고 설치하지 않는다.
2. `installed`와 `enabled`가 참이고 `install.result`가 `installed`이며 여덟 단계 `package`, `environment`, `migration`, `role`, `configuration`, `login`, `connection`, `schedule`이 각각 `succeeded` 또는 `skipped`이고 연결 상태가 `connected`이면 이미 완료된 것이다. 중복 설치하지 않는다. 그 외의 부분 상태는 `brain ext install <name> --json`으로 설치하거나 재개한다.
3. 설치 명령은 선언된 로그인, 연결 확인과 공통 예약 등록을 처리한다. 별도의 예약을 만들지 않는다. `login_required`이면 해당 확장의 지원되는 인증 절차를 확인해 사용자가 직접 완료하도록 안내한다. 일반 확장의 인증 명령이 지원되는 경우 brain-login 스킬 또는 `brain ext login <name>`을 안내한다. Garmin은 현재 패키지에 인증 실행 항목이 없어 이 명령으로 인증할 수 없으므로 미지원으로 보고하고 인증 성공이나 우회 방법을 추정하지 않는다. 비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다. 사용자가 지원되는 인증을 완료했다고 응답하면 같은 설치 명령으로 재개한다. 응답이 없거나 인증이 미완료이면 재개하지 않고 미완료를 보고한다.
4. 성공, 실패, 취소, 인증 미완료, 이미 완료된 경우 모두 마지막으로 `brain ext status <name> --json`을 재조회한다. 재조회에 실패하면 최종 상태를 미확인으로 보고하며 완료를 주장하지 않는다.

마지막 상태의 `installed`, `enabled`, `install.result`, `install.stages`, `login`, `connection`, `schedule`을 근거로 완료된 단계와 미완료 단계를 구분하고 다음 행동을 안내한다. `skipped`는 해당 단계가 필요 없어 건너뛴 것이므로 성공과 구분해 보고한다. 기록이 없거나 `pending`, `failed`, 누락된 단계는 완료로 간주하지 않는다. `install.failed_stage`, `install.last_failure`와 명령 오류의 고정 코드가 있으면 보고한다. `connection_failed`는 연결과 예약 미완료를, `scheduler_unavailable`은 설치·연결과 예약 미완료를 구분한다. 카탈로그의 `login_required`는 인증 필요 여부이지 현재 로그인 상태가 아니다. 최종 상태가 완료 조건을 뒷받침할 때만 완료라고 말한다. 공개 상태에 없는 사실을 추정하지 않는다.

core 갱신은 brain-setup 스킬을 따른다. 기존 설치의 갱신에는 설정 질문과 offline 확인 문구가 없으며, 설치기의 자동 정지 검증 실패를 확장 재설치로 우회하지 않는다.
