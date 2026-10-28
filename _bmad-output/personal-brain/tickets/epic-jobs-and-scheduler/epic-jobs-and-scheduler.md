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
- Decision(2026-10-28, 사용자): 놓친 예약. Mac이 잠들었거나 꺼져 있어 예약 시각을 놓쳤으면, 깨어난 뒤 놓친 날짜(하루든 여러 날이든)에 성공한 실행이 없을 때만 돌린다. 여러 날을 놓쳐도 한 번 돌고, 그 한 번이 빠진 날짜를 처리한다(Garmin 수집은 coverage로 빠진 날짜를 채운다). 그날 이미 성공한 실행이 있으면 돌지 않는다. 이전의 Open question(놓친 예약 기준)을 대신한다.
- Decision(2026-10-28): 정체 판정. heartbeat만으로는 진행이 아니다(AD-21·33). 진행 이벤트가 일감 종류별 창(manifest가 선언, 기본 15분. 모델 일감은 호출 timeout 20분 + 5분) 동안 없으면 `stalled`로 기록한다. 감독자가 프로세스 그룹을 정리한 뒤 일시 오류로 다시 시도하고, doctor에 보인다. 이전의 Open question(정체 기준)을 대신한다.
- Decision(2026-10-28, 사용자): 모델 호출 표시. 모델을 부른 일감의 토큰 사용량과 걸린 시간을 doctor와 작업 목록에 보인다. 호출 횟수는 보이지 않고 상한은 두지 않는다. 프로세스 ABI v1의 결과 이벤트에 선택 칸 `usage`(입력·캐시·출력 토큰)를 두고, 일감 행이 그것을 남긴다. 값을 채우는 모델 adapter는 epic-health-analysis다. 이전의 Open question(호출 횟수·비용)과 spine Deferred "모델 호출 횟수·비용 제한/표시"를 대신한다.
- Decision(2026-10-28, 사용자): 확장을 끄면 진행 중인 그 확장의 일감은 감독자 취소(그룹 SIGTERM → 유예 → SIGKILL → reap)로 끊는다. 대기 일감은 `extension_disabled`로 보류하고, 다시 켜면 이어서 돈다. 그 확장의 데이터를 읽는 core 분석 예약도 멈춘다(epic-health-analysis). 데이터와 기존 분석은 남고 검색된다. 이전의 Open question과 spine Deferred "비활성화의 진행 작업 종료 방식"(owner 12·13)을 대신한다.
- Decision(2026-10-28): 새 예약 CLI는 AD-5의 `<ns> <verb>` 모양이다. 안은 `brain schedules add|list|remove`이고, 정제 때 CommandSpec과 SDK를 1:1로 확정한다(spine Deferred "신규 공통 CLI namespace/verb").
- Decision(2026-10-28): 프로세스 ABI v1은 감독자를 처음 만드는 이 에픽이 만든다. 13은 이 에픽 뒤라 13 소유면 감독자가 쓸 규약이 없다. manifest JSON Schema와 설정 snapshot은 13에 남는다. spine AD-33도 이렇게 고쳤다(2026-10-28).
