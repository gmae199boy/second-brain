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
- 데몬 감독자(AD-33): 확장 일감과 모델을 부르는 일감은 감독자만 청구하고 자식 프로세스 그룹으로 띄운다. 자식이 진행을 내는 동안 임대를 갱신하고, 취소는 그룹 SIGTERM → 유예 → SIGKILL → reap이다. 청구마다 attempt/lease token을 발급하고 오래된 attempt의 쓰기를 DB가 거부한다. 시작 때 이전 incarnation의 그룹을 정리한 뒤 회수하고, 종료를 확인할 수 없으면 불명 상태로 남긴다.
- 프로세스 ABI v1: 이 에픽이 처음 쓰므로 만든다(2026-10-28). stdout JSON Lines 이벤트(진행·heartbeat, 결과 요약, 다시 할 수 있는지 분류가 붙은 오류)와 종료 코드, 환경 변수 입력(DB URL, 일감 id, attempt token), 비정상 EOF·알 수 없는 버전·stderr 처리를 버전 있는 JSON Schema로 두고, fake worker와 TS fixture로 검증한다. manifest와 설정 snapshot은 epic-extensions가 더한다.

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
- Garmin 수집 일감은 epic-garmin-runtime, 분석 일감(평가 단계)은 epic-health-analysis다.
- manifest JSON Schema와 설정 snapshot, 확장 registry는 epic-extensions다.
- install 스킬이 예약을 등록하는 단계는 epic-extensions다.
- 채널 발신 일감은 epic-channels가 이 계약 위에 만든다.
- Must not change: 데몬이 멈춰도 hook·명령이 동작하고 밀린 일은 기회적 drain이 처리한다(spec Constraints).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R8, R9, R10
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "작업 그래프와 병렬성"
- architecture — _bmad-output/personal-brain/architecture-brain-v1-slice-1/architecture-brain-v1-slice-1.md, AD-7, AD-21, AD-27, AD-33, AD-35

## Notes

- Waits on epic-postgres-primary because: PostgreSQL의 `work_items`·`schedules`와 잠금·트랜잭션 규칙, 시간대 설정이 있어야 한다.
- Open question: 놓친 현지 시각 예약과 진행 정체를 판단하는 단계별 기준은? 정제 때 정한다.
- Open question: 모델 호출의 횟수·비용을 설정이나 doctor로 제한·표시할지? 정제 때 정한다.
- Open question: 확장을 비활성화할 때 진행 중인 작업을 어떻게 끝내나? epic-extensions와 함께 취소 ABI를 만들기 전에 정한다(spine Deferred).
- Decision(2026-10-28): 프로세스 ABI v1은 감독자를 처음 만드는 이 에픽이 만든다. spine AD-33은 epic 13 소유라고 적었지만, 13은 이 에픽 뒤라 감독자가 쓸 규약이 없게 된다. manifest JSON Schema와 설정 snapshot은 13에 남는다. spine 고침은 이니셔티브 Notes의 Source conflict에 있다.
