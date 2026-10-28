---
type: epic
title: "확장 설치와 install 스킬"
parent: personal-brain
covers: [R1, R16, R17]
after: ["epic-postgres-primary", "epic-jobs-and-scheduler"]
refined: false
risk: high
---

# 확장 설치와 install 스킬

## Description

선택 확장을 설치·활성화·비활성화하고 그 상태를 Brain이 관리한다. 범위는 다음과 같다.
- 확장 실행 환경(uv·Python ≥3.12와 잠금 파일)과 데이터는 Brain의 공통 설치 위치와 DB에 둔다. 플러그인의 버전별 캐시에는 두지 않는다.
- TS core와 Python 확장 사이의 실행·저장·설정 포트. 형식은 아키텍처가 정한다.
- 확장 DDL을 core의 마이그레이션 실행기에 등록한다.
- 설치 CLI: 제안 형태는 `brain install <확장>`이다.
- Brain 플러그인에 기본 포함하는 공통 install 스킬. 순서는 CLI 지원·설치 상태 확인 → 설치 → 사용자 로그인 안내 → 연결 확인 → 공통 스케줄러에 예약 등록 → 단계별 실제 결과 보고다.
- Garmin을 설치하지 않은 Brain은 Python 의존을 요구하지 않는다.

상세 규칙은 integration-boundaries "확장 설치 안내 스킬"에 있다(2026-10-28, 이니셔티브 R1·R16·R17).

## Outcome

Garmin을 쓰지 않는 사용자는 아무것도 더 설치하지 않는다. 쓰는 사용자는 "Garmin 연결해 줘"라고 말하면 에이전트가 설치부터 예약까지 실제 상태를 확인하며 안내한다(이니셔티브 Done when 8의 설치 부분).

## Done when

1. Garmin 미설치 Brain이 Python 없이 설치·수집·doctor를 통과한다.
2. install 스킬로 미설치 → 설치 → 로그인 → 연결 확인 → 예약 등록의 정상 경로가 테스트 확장에서 돈다.
3. 이미 설치되었거나 부분 설정된 상태에서 다시 돌리면 중복 설치 없이 이어 간다. 설치 실패·취소·로그인 미완료·스케줄러 미준비는 단계별로 구분해 보고하고, 끝나지 않은 단계를 완료로 보고하지 않는다.
4. 확장을 비활성화해도 그 데이터가 남고, 확장 상태와 멈춘 작업이 드러난다. 검색 응답에 꺼진 상태를 보이는 일은 epic-search-and-health-query다.
5. 플러그인을 업데이트해도 확장 환경이 남고, 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Garmin 수집·분석 자체는 epic-garmin-runtime, Garmin 스키마와 기존 데이터는 epic-garmin-import다.
- 공개 plugin marketplace와 임의 서드파티 확장 코드 실행은 범위 밖이다.
- Must not change: 비밀번호·MFA를 대화나 스킬 본문에 저장하지 않는다. 설치 명령이 없으면 임의 패키지 설치로 우회하지 않는다.

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R1, R16, R17, Constraints C4
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "확장 설치 안내 스킬", "실행·의존성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-1, AD-19

## Notes

- Waits on epic-postgres-primary because: 확장 DDL을 받을 마이그레이션 실행기, 사용자·확장 설정 DB, PostgreSQL 위 설치 흐름이 필요하다.
- Waits on epic-jobs-and-scheduler because: install 스킬의 예약 단계가 공통 스케줄러의 등록 API를 부른다.
- Open question: TS↔Python 실행·저장 포트 형식과 확장 패키지 위치는? 아키텍처가 정한다.
