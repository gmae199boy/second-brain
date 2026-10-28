---
type: epic
title: "공통 채널과 Telegram 발신"
parent: personal-brain
covers: [R13]
after: ["epic-postgres-primary", "epic-jobs-and-scheduler"]
refined: false
risk: medium
---

# 공통 채널과 Telegram 발신

## Description

core가 소유하는 채널 계약과 Telegram 발신 adapter를 만든다.
- 채널 계약: channel·conversation·thread identity, 발신 이력, 결과 bundle, 사건 분류, provenance.
- 기존 Garmin `ports`·`telegram`의 의미(최초 시도 gate, 전송 이력)를 공통 경로로 옮긴다.
- 발신은 작업 계약 위의 일감으로 재시도한다.
- 이전된 옛 Garmin 알림·전송 이력을 출처(legacy source)와 함께 받는 자리를 둔다. 받은 이력은 다시 보내지 않는다(2026-10-28, 사용자: core 채널 이력으로).
- 이후 사용자 답변·스레드·에이전트 선제 메시지를 같은 대화에 이을 수 있게 식별자를 정한다(2026-10-28, 이니셔티브 R13, 사용자: 별도 에픽).

## Outcome

Brain의 어떤 기능이든 같은 채널 계약으로 메시지를 보내고, 보낸 것과 실패한 것이 기록된다.

## Done when

1. 테스트 생산자의 메시지가 공통 계약으로 Telegram에 한 번 나가고 이력이 남는다. 실계정 확인은 사람이 한다.
2. 전송 실패는 재시도되고, 생산자 쪽 결과를 지우거나 되돌리지 않는다.
3. 같은 결과를 두 번 보내지 않고, 이전된 옛 발신 이력을 넣어도 메시지가 나가지 않는다.
4. 기능 묶음이 플러그인 배포로 이 Mac의 설치본에 들어가 동작한다.

## Boundaries

다음은 이 에픽 밖이다.
- Slack·Telegram 양방향 에이전트 대화와 수신 처리.
- Garmin 결과 bundle을 만드는 일은 epic-garmin-runtime이다.
- Must not change: bot token은 `.env`에 두고(AD-18), 나가는 텍스트는 Core 출력 코덱으로 가린다(AD-11).

## References

- parent — _bmad-output/personal-brain/initiative-personal-brain.md, Requirements R13
- design — _bmad-output/personal-brain/prep-garmin-absorption/integration-boundaries.md, "가져갈 코드와 교체할 경계"(ports, telegram 행)
- source — _bmad-output/personal-brain/prep-garmin-absorption/accepted-intent.md, S7

## Notes

- Waits on epic-postgres-primary because: 채널·대화·발신 이력 테이블이 들어갈 공통 스키마와 비밀 저장 계약이 필요하다.
- Waits on epic-jobs-and-scheduler because: 발신 일감의 재시도와 중복 방지를 작업 계약 위에 만든다.
- Decision(2026-10-28, 사용자): 채널은 Garmin 런타임 안이 아니라 별도 에픽으로 그 앞에 둔다.
- Decision(2026-10-28, 사용자): 이전한 Garmin 알림·전송 이력은 Garmin 스키마가 아니라 core 채널 이력에 둔다. 그래서 이 에픽을 epic-garmin-import 앞으로 옮겼다.
