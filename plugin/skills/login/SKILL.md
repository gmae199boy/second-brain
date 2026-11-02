---
name: login
description: 사용자가 터미널에서 확장에 직접 로그인하도록 안내하고 공개 결과를 확인합니다.
---

# 확장 로그인

사용자가 요청한 확장 이름을 확인한다. 이름이 없으면 물어보고 임의로 정하지 않는다. 아래 `<name>`은 확인한 확장 이름으로 바꾼다.

1. `brain guide schema ext --json`을 실행한다. 응답에 `ext login`이 없거나 명령을 지원하지 않으면 로그인 기능이 미구현이라고 알리고 중단한다.
2. 사용자가 밖에서도 접속할 수 있는 터미널에서 `brain ext login <name>`을 연다. Orca CLI를 사용할 수 있으면 `orca terminal create --command "brain ext login <name>" --focus --json`으로 터미널을 만들고 사용자가 그 터미널에 붙어 직접 입력하도록 안내한다. 확장 이름이 명령 인자로 유효한지 확인하고 셸 명령에 안전하게 전달한다. Orca를 사용할 수 없으면 사용자가 SSH 등으로 접속한 터미널에서 직접 `brain ext login <name>`을 실행하도록 안내한다.
3. 비밀번호, MFA 코드, 토큰을 요청하거나 대화에 받거나 저장하지 않는다. 사용자가 대화에 비밀번호를 쓰면 사용하지 않고 터미널에 직접 입력하도록 안내한다. 에이전트는 로그인 터미널에 입력을 대신 보내거나 화면을 읽지 않는다.
4. 사용자가 끝났다고 하면 `brain ext status <name> --json`으로 공개 상태를 확인한다. 설치 인증을 다시 확인해야 하면 기존 설치 재개 명령인 `brain ext install <name> --json`을 실행하고 상태를 다시 확인한다. 성공 여부와 `LOGIN_REQUIRED`, `SESSION_BLOCKED` 등 공개 코드만 보고하고, 확인되지 않은 결과를 완료라고 말하지 않는다.
