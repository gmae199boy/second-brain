---
id: 11
type: story
title: "Extension catalog: 설치 가능한 확장을 보고 이름으로 CLI와 에이전트에서 설치한다"
parent: epic-extensions
covers: [E13-1, E13-2, E13-6, E13-7, E13-9]
after: [1, 2, 5, 6, 7, 8]
hitl: false
risk: high
---

# Extension catalog: 설치 가능한 확장을 보고 이름으로 CLI와 에이전트에서 설치한다

## Description

core 앱에 포함된 패키지 manifest와 digest로 설치 가능한 확장 카탈로그를 제공한다. 이름·버전·설명·로그인 필요 여부·설치 여부를 표시하고 testext는 격리 시험 harness에서만 보인다. brain ext install <name>은 같은 검증·잠금·재개·교체 경로로 설치한다. core brain-install은 이름이 없으면 목록을 제시하고 선택을 받아 설치하며 Garmin 스킬도 이름 설치를 쓴다. npx core 설치 뒤 같은 명령을 쓰는 경로와 JSON 계약·guide schema·스킬 커버리지를 정리한다. 실제 에이전트 세션 증거는 후행 13.10의 별도 수락조건이다.

## Requirements

Verify: Given 빈 격리 홈과 core 앱의 유효 패키지, When 카탈로그를 조회하면 Then 이름·버전·설명·로그인 필요·설치 여부가 manifest에서 나오고 testext는 숨겨진다. Given 선택한 이름, When 이름으로 설치·재개하면 Then --package와 동일한 digest 검증·설치·교체 계약을 따른다. Given 이름 없는 스킬 요청, When 스킬을 따르면 Then 목록→사용자 선택→동일 CLI→실제 상태 보고 절차가 있으며 공개 schema와 커버리지 시험이 이를 검증한다.

## References

- parent — _bmad-output/personal-brain/tickets/epic-extensions/epic-extensions.md
