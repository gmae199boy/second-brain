---
type: epic
title: "공통 작업 runtime과 스케줄러"
parent: personal-brain
covers: [R8, R9, R10]
after: ["epic-postgres-primary"]
refined: false
risk: high
---

# 공통 작업 runtime과 스케줄러

## Description

Brain의 작업 runtime을 긴 작업과 예약에 맞게 넓힌다. 범위는 다음과 같다.
- 작업 의존성: 앞 작업의 성공을 기다린다.
- 독립 작업의 병렬 실행 용량과 같은 키(계정)의 직렬화.
- 진행 중 작업의 소유권 갱신과 진행 상태.
- 작업자 사망·오류·정체·사용자 취소의 구분과 단계별 시간 한도.
- 공통 스케줄러: 기존 interval `schedules`(0009) 위에 현지 일자·시간대 기준 예약을 더한다. 수동 실행도 같은 작업 계약을 쓰고, 같은 대상의 중복을 막는다.
- 모델을 부르는 분석 작업도 같은 계약으로 예약된다(2026-10-28, 이니셔티브 R10).

근거: 지금 drain은 handler를 직렬로 await한다. 기본 임대는 600초인데 갱신이 없고, 진행 중 drain에는 취소 신호가 없다(integration-boundaries "작업 그래프와 병렬성").

## Outcome

몇 시간짜리 작업이 도는 동안에도 대화 수집이 밀리지 않고, 예약한 시각에 작업이 한 번만 돈다(이니셔티브 Done when 8의 작업 부분).

## Done when

1. fake worker의 긴 작업이 600초를 넘겨도 소유권을 갱신하며 중복 실행되지 않고, 그동안 대화 수집 일감이 처리된다.
2. 작업자를 죽이면 그 작업이 회수되어 다시 돈다. 사용자가 취소하면 끝난다. 오류와 정체는 다른 상태로 구분되어 doctor에 보인다.
3. 의존 작업은 앞 작업이 성공한 뒤에만 시작하고, 같은 계정 키의 작업은 한 번에 하나만 돈다.
4. 현지 시각 예약이 설정 시간대를 따라 한 번 돌고, 놓친 실행과 수동 실행이 정한 정책대로 처리된다.
5. 기능 묶음이 플러그인 배포(app-ref·version)로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Garmin 작업 정의(수집·평가 단계)는 epic-garmin-runtime이다.
- install 스킬이 예약을 등록하는 단계는 epic-extensions다.
- 채널 발신 일감은 epic-channels가 이 계약 위에 만든다.
- Must not change: 데몬이 멈춰도 hook·명령이 동작하고 밀린 일은 기회적 drain이 처리한다(spec Constraints).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R8, R9, R10
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "작업 그래프와 병렬성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7, AD-21, AD-27

## Notes

- Waits on epic-postgres-primary because: PostgreSQL의 `work_items`·`schedules`와 잠금·트랜잭션 규칙, 시간대 설정이 있어야 한다.
- Open question: 놓친 현지 시각 예약과 진행 정체를 판단하는 단계별 기준은? 정제 때 정한다.
- Open question: 모델 호출의 횟수·비용을 설정이나 doctor로 제한·표시할지? 정제 때 정한다.
