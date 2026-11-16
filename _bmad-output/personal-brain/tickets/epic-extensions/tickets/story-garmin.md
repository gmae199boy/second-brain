---
id: 12
type: story
title: "Garmin 새 설치의 공식 로그인 경로"
parent: epic-extensions
covers: [E13-2, E13-7, E13-9]
after: [11]
hitl: false
risk: high
---

# Garmin 새 설치의 공식 로그인 경로

## Description

기존 Garmin 패키지는 auth 선언이 없어 ext login garmin이 인증을 실행하지 못한다. 기존 토큰이 있는 설치는 connected·login skipped일 수 있지만 새 사용자는 공식 인증 진입점이 없다. 사용자 터미널에서만 비밀을 입력하는 공식 adapter와 manifest 선언·연결 확인·설치 재개를 구현한다. 운영 계정이나 토큰은 시험에 사용하지 않는다. 13.11에서 발견한 기존 결함의 별도 후속 planned 작업이며 이번 변경에서는 구현하지 않는다.

## Requirements

Verify: Given 토큰 없는 새 격리 Garmin 설치, When 공식 터미널 로그인 명령을 실행하면 Then 비밀번호·MFA·토큰이 대화·argv·로그·공개 상태에 노출되지 않고 합성 인증 adapter로 로그인 결과를 확인할 수 있다. Given 인증 완료 또는 실패·취소, When 같은 이름 install을 재개하면 Then 실제 인증·연결·예약 상태를 보고하고 실패·취소를 완료로 쓰지 않는다. Given 기존 유효 토큰과 connected 상태, When 설치·상태를 확인하면 Then 불필요한 재인증 없이 상태를 보존하며 카탈로그의 인증 필요 메타데이터와 현재 인증 상태를 구별한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md
