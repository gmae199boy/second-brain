---
type: epic
title: "Garmin 수집·분석"
parent: personal-brain
covers: [R2, R11, R12]
after: ["epic-jobs-and-scheduler", "epic-extensions", "epic-garmin-import", "epic-channels"]
refined: false
risk: high
---

# Garmin 수집·분석

## Description

Garmin의 Python 코드(소스 기준 `7fb33dd`, `prep-garmin-absorption/inputs/garmin-source.tar.gz`)를 epic-garmin-import가 만든 확장 뼈대에 편입하고, 새 저장·작업·채널 포트에 연결한다. 범위는 다음과 같다.
- 인증: MFA·token·session, 계정 차단, 호출 간격·first-call 보호.
- 수집·coverage·정규화.
- body, digest.
- 평가: day→7d→30d→all, 성공 결과의 즉시 보존, Codex subprocess 정리.
- 그래프와 결과 발신(epic-channels).

SQLite 연결과 SQL은 PostgreSQL 저장 포트로 바꾼다. 기존 deploy와 Garmin 전용 LaunchAgent는 core 설치·공통 예약으로 대체한다. 같은 fixture의 수치와 입력 snapshot을 기존 구현과 비교한다(2026-10-28, 이니셔티브 R2·R11·R12, C4).

## Outcome

Garmin 사용자가 별도 Garmin 설치 없이 Brain에서 수집과 분석을 받고, 이전된 기록 위에 새 기록이 이어진다(이니셔티브 Done when 8의 Garmin 부분).

## Done when

1. 같은 합성 fixture에서 raw·정규화·digest·report-input 결과가 기존 구현과 같다.
2. 계정 차단·MFA 필요·호출 간격 보호가 실패 경계 테스트로 지켜지고, 같은 계정 수집이 직렬로 돈다.
3. day→7d→30d→all이 순서대로 돌고 각 성공이 바로 보존된다. 발신 실패는 평가를 지우지 않는다.
4. 공통 스케줄러 예약으로 수집·평가가 돈다. 실계정 수집과 평가 한 번은 사람이 확인한다.
5. 별도 Garmin LaunchAgent 없이, 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- 기존 데이터 이전은 epic-garmin-import, 검색·수치 조회는 epic-search-and-health-query다.
- 채널 계약과 adapter는 epic-channels다.
- 실제 모델 품질 검증은 이 에픽의 사람 확인 범위 안에서만 한다(fake Codex E2E만으로 품질을 주장하지 않는다, E6).
- Must not change: 외부 호출 동안 DB 쓰기 트랜잭션을 잡지 않는다. 이전된 기존 분석을 덮지 않는다(R7).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R2, R11, R12, Constraints C4
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계", "테스트 근거와 이전 완료 기준"
- inputs — _bmad-output/personal-brain/prep-garmin-absorption/inputs/research/garmin-runtime.md
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S11·S12·E1·E6

## Notes

- Waits on epic-jobs-and-scheduler because: 평가 의존 순서, 계정 키 직렬화, 긴 평가의 소유권 갱신, 현지 시각 예약을 쓴다.
- Waits on epic-extensions because: 확장 설치·활성화와 TS↔Python 실행·저장·설정 포트를 쓴다.
- Waits on epic-garmin-import because: 그 에픽이 만든 Garmin 확장 뼈대·스키마에 runtime을 더하고, 이전된 기존 기록 위에서 새 수집이 이어진다.
- Waits on epic-channels because: 결과 발신이 공통 채널 계약과 Telegram adapter를 쓴다.
