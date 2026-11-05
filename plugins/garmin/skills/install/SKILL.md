---
name: install
description: 설치된 Personal Brain core에 Garmin 확장을 설치하거나 상태를 확인합니다.
---

# Garmin 설치

Personal Brain core가 먼저 설치되어 있어야 한다. core가 없으면 설치 안내만 하고 직접 설치하지 않는다. 이미 설치된 core의 `brain ext status garmin --json`을 확인하고 필요한 경우 `sh "${CLAUDE_PLUGIN_ROOT}/bin/install.sh" --json`으로 내장 패키지를 core 설치기에 위임한다. core의 호환성·잠금·재개 결과를 그대로 따르고, 로그인이나 연결이 미완료면 사용자에게 공식 `brain ext login garmin` 절차를 안내한다. 비밀번호, MFA 코드와 토큰을 대화에 요청하거나 저장하지 않는다.
