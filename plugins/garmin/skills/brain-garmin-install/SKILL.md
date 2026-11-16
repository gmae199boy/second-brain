---
name: brain-garmin-install
description: 설치된 Personal Brain core에 Garmin 확장을 설치하거나 상태를 확인합니다.
---

# Garmin 설치

먼저 `brain guide schema ext --json`으로 `ext status`, `ext install` 지원을 확인한다. 없거나 확인이 실패하면 미구현 또는 확인 불가로 보고 중단한다. Personal Brain core가 먼저 설치되어 있어야 한다. core가 없으면 설치 안내만 하고 직접 설치하지 않는다.

`brain ext status garmin --json`으로 현재 상태를 읽고, 사용자가 Garmin 설치를 요청했고 이미 완료되지 않았다면 `brain ext install garmin --json`으로 설치하거나 재개한다. core의 호환성·잠금·재개 결과를 따르고 마지막으로 상태를 다시 읽어 설치·연결·예약의 실제 결과와 미완료를 구분해 보고한다. 카탈로그의 로그인 필요 표시는 인증 완료 상태가 아니다.

현재 Garmin 패키지에는 터미널 인증 실행 항목이 없어 `brain ext login garmin`은 인증을 실행할 수 없다. 지원되는 로그인 경로가 현재 확인되지 않음을 알린다. 로그인 필요를 명시한 상태가 있을 때만 인증 미완료로 보고한다. 연결 실패는 연결 상태와 오류 코드 및 예약 미완료를 보고하고, 인증 상태는 별도 근거가 없으면 미확인으로 둔다. 기존 connected와 login skipped는 그 상태대로 보고한다. 임의의 우회 설치나 인증을 시도하지 않는다. 비밀번호, MFA 코드와 토큰을 대화에 요청하거나 저장하지 않는다.
